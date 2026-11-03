import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodType } from "zod";
import type { ConsoleLine, DeployRequest, Software } from "@shared/types";
import * as files from "../../../files";
import { versions } from "../../../sources";
import type { ToolDef, ToolField } from "../../hooks";
import type { ServerApi } from "../../types";

/**
 * An MCP server inside the app, so an AI agent can deploy test servers, read their consoles, run commands and
 * look at players the way a person does in the window. It also serves every tool other extensions registered
 * (Lattice, bots, your own). It listens on 127.0.0.1 only, wants the bearer token from the extension's
 * settings, and refuses browser requests (an Origin header), so a web page cannot reach it through the
 * person's browser. Publishing is left out on purpose: putting a server on the internet stays a person's decision.
 */

export interface McpDeps {
    servers: ServerApi;
    /** Read on every request, so enabling an extension adds its tools without a restart. */
    tools: () => readonly ToolDef[];
}

const MAX_BODY = 4 * 1024 * 1024;
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value ?? "Done.", null, 2) }] });

const schemaOf = (field: ToolField): ZodType => {
    const base = field.type === "string" ? z.string() : field.type === "number" ? z.number() : field.type === "boolean" ? z.boolean() : z.array(z.string());
    const described = base.describe(field.description);
    return field.optional ? described.optional() : described;
};

function build(deps: McpDeps): McpServer {
    const { servers } = deps;
    const server = new McpServer({ name: "lattice-testbench", version: "1" });
    const id = z.string().describe("Server id, from list_servers");
    const process = z.string().optional().describe("Process name (server, proxy, backend-1...). Defaults to the game server, or backend-1 on a network.");
    const view = (serverId: string) => servers.get(serverId) ?? fail("No such server");

    server.registerTool("list_servers", { description: "Every test server: id, label, state, address, errors, players online." }, async () => text(
        servers.list().map((s) => ({
            id: s.id, label: s.label, software: s.software, version: s.version, state: s.state, address: s.address,
            publicAddress: s.publicAddress, processes: s.processes, plugins: s.plugins, modules: s.moduleStatus, errors: s.errors,
            online: s.players.filter((p) => p.leftAt === undefined).map((p) => p.name), expiresAt: s.kept ? null : new Date(s.expiresAt).toISOString(), error: s.error,
        })),
    ));

    server.registerTool("deploy", {
        description: "Deploy a test server and return its id. Poll list_servers until state is running, or use wait_for_console with 'Done \\('.",
        inputSchema: {
            software: z.enum(["paper", "folia", "purpur", "velocity"]).default("paper").describe("velocity means a network of backends behind a proxy"),
            version: z.string().optional().describe("Minecraft version; newest when left out"),
            backends: z.number().int().min(1).max(4).optional(),
            online_mode: z.boolean().default(false).describe("Bots only join offline servers"),
            world: z.enum(["normal", "flat", "void"]).default("normal"),
            server_jar: z.string().optional().describe("Absolute path of a server jar to use instead of downloading one (a Paper fork); game servers only"),
            plugins: z.array(z.string()).default([]).describe("Absolute paths of plugin jars copied into every game server"),
        },
    }, async (a) => {
        const backend: Exclude<Software, "velocity"> = "paper";
        const host = a.software === "velocity" ? backend : a.software;
        const version = a.version ?? (await versions())[host][0];
        const request: DeployRequest = {
            software: a.software, version, onlineMode: a.online_mode, world: a.world, plugins: a.plugins,
            ...(a.server_jar ? { serverJar: a.server_jar } : {}),
            ...(a.software === "velocity" ? { backendSoftware: backend, backends: a.backends ?? 1 } : {}),
        };
        return text({ id: servers.deploy(request), version });
    });

    server.registerTool("console", {
        description: "Recent console lines of a server (newest last), optionally of one process and matching a regular expression.",
        inputSchema: { id, process: z.string().optional(), lines: z.number().int().min(1).max(2000).default(100), filter: z.string().optional() },
    }, async ({ id: sid, process: p, lines, filter }) => {
        const pattern = filter ? new RegExp(filter, "i") : null;
        const shown = servers.history(sid).filter((l) => (!p || l.process === p) && (!pattern || pattern.test(l.text)));
        return text(shown.slice(-lines).map((l) => `[${l.process}] ${l.text}`).join("\n") || "(no lines)");
    });

    server.registerTool("wait_for_console", {
        description: "Wait until a NEW console line matches a regular expression, and return it. Use after deploy, a command or a restart instead of sleeping.",
        inputSchema: { id, pattern: z.string(), process: z.string().optional(), timeout_seconds: z.number().min(1).max(600).default(60) },
    }, async ({ id: sid, pattern, process: p, timeout_seconds }) => {
        const regex = new RegExp(pattern, "i");
        const line = await servers.waitFor(sid, (l: ConsoleLine) => (!p || l.process === p) && regex.test(l.text), timeout_seconds * 1000);
        return text(line ? `[${line.process}] ${line.text}` : `No line matched within ${timeout_seconds}s.`);
    });

    server.registerTool("run_command", {
        description: "Type a command into a process's console (no leading slash). Read the answer with console or wait_for_console.",
        inputSchema: { id, command: z.string().max(1000), process },
    }, async ({ id: sid, command, process: p }) => {
        if (/[\r\n]/.test(command)) throw new Error("One command per call.");
        const target = p ?? view(sid).processes[0]?.name ?? fail("That server has no process.");
        servers.command(sid, target, command.replace(/^\//, ""));
        return text(`Sent to ${target}.`);
    });

    const lifecycle = { start: "Start every stopped process", stop: "Save and stop every process", restart: "Stop, then start", delete_server: "Stop and delete the server and its folder" } as const;
    for (const [name, description] of Object.entries(lifecycle)) {
        server.registerTool(name, { description, inputSchema: { id } }, async ({ id: sid }) => {
            if (name === "start") servers.start(sid);
            else if (name === "stop") await servers.stop(sid);
            else if (name === "restart") await servers.restart(sid);
            else await servers.destroy(sid);
            return text("Done.");
        });
    }

    server.registerTool("keep", { description: "Keep a server (no expiry) or let it expire again.", inputSchema: { id, kept: z.boolean() } }, async ({ id: sid, kept }) => {
        servers.keep(sid, kept);
        return text(kept ? "Kept." : "Expires in 30 minutes.");
    });

    server.registerTool("list_files", { description: "List a folder of the server (relative path, '' for the root).", inputSchema: { id, path: z.string().default("") } },
        async ({ id: sid, path }) => text(await files.list(servers.dir(sid), path)));
    server.registerTool("read_file", { description: "Read a text file of the server.", inputSchema: { id, path: z.string() } },
        async ({ id: sid, path }) => text(await files.read(servers.dir(sid), path)));
    server.registerTool("write_file", {
        description: "Write a text file of the server. Plugins read their config again on their own reload command; send it with run_command.",
        inputSchema: { id, path: z.string(), content: z.string() },
    }, async ({ id: sid, path, content }) => {
        await files.write(servers.dir(sid), path, content);
        return text("Written.");
    });

    server.registerTool("player_info", { description: "Position, health, game mode, op and inventory of an online player.", inputSchema: { id, player: z.string() } },
        async ({ id: sid, player }) => text(await servers.playerInfo(sid, player)));
    server.registerTool("placeholder", {
        description: "PlaceholderAPI's value of a text such as %player_name%, for a player or none.",
        inputSchema: { id, text: z.string(), player: z.string().optional(), process },
    }, async ({ id: sid, text: t, player, process: p }) => {
        const target = p ?? view(sid).processes.find((x) => x.name === "server" || x.name === "backend-1")?.name ?? fail("That server has no game server process.");
        return text(await servers.placeholder(sid, target, player ?? null, t));
    });

    for (const tool of deps.tools()) {
        const shape = Object.fromEntries(Object.entries(tool.input).map(([key, field]) => [key, schemaOf(field)]));
        server.registerTool(tool.name, { description: tool.description, inputSchema: shape }, async (args: Record<string, unknown>) => text(await tool.run(args)));
    }
    return server;
}

function fail(message: string): never {
    throw new Error(message);
}

function equalToken(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error("Request too large"));
                req.destroy();
            } else chunks.push(c);
        });
        req.on("end", () => {
            try {
                resolve(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

/** The HTTP endpoint. Starts on a port and answers only requests that carry the token. */
export class McpEndpoint {
    private server: Server | null = null;

    constructor(private readonly deps: McpDeps, private readonly token: () => string) {}

    start(port: number): Promise<void> {
        const server = createServer((req, res) => void this.handle(req, res, port));
        return new Promise((resolve, reject) => {
            server.once("error", (error) => reject(new Error(`Could not listen on 127.0.0.1:${port}: ${error.message}`)));
            server.listen(port, "127.0.0.1", () => {
                this.server = server;
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
        const refuse = (status: number, message: string) => {
            res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
        };
        // A browser always sends Origin; agents do not. This keeps web pages (and DNS rebinding) out.
        if (req.headers.origin) return refuse(403, "Browser requests are not accepted.");
        if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return refuse(403, "Wrong host.");
        if (!equalToken((req.headers.authorization ?? "").replace(/^Bearer /, ""), this.token())) return refuse(401, "Missing or wrong token.");
        if (req.url !== "/mcp") return refuse(404, "The endpoint is /mcp.");
        if (req.method !== "POST") return refuse(405, "This endpoint is stateless: POST only.");

        let body: unknown;
        try {
            body = await readBody(req);
        } catch (error) {
            return refuse(400, (error as Error).message);
        }
        // Stateless: a fresh server and transport per request, as the SDK recommends without sessions.
        const mcp = build(this.deps);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            void transport.close();
            void mcp.close();
        });
        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch (error) {
            console.warn("MCP request failed", error);
            if (!res.headersSent) refuse(500, (error as Error).message);
        }
    }
}
