import { randomBytes } from "node:crypto";
import type { Extension, ExtensionContext } from "../../types";
import { McpEndpoint } from "./server";

/** AI / MCP: lets an AI agent (Claude Code, any MCP client) deploy and drive test servers over a local, token-protected endpoint. */

export const mcp: Extension = {
    manifest: {
        id: "ai-mcp",
        name: "AI agents (MCP)",
        description: "Let an AI agent deploy test servers, read consoles, run commands and edit files through a local MCP endpoint.",
        version: "1.0.0",
        api: 1,
        permissions: ["Listens on 127.0.0.1", "Lets an agent run commands on your test servers"],
        settings: [
            { key: "port", label: "Port", type: "number", default: 7820, hint: "The endpoint is http://127.0.0.1:<port>/mcp, reachable from this PC only." },
            { key: "token", label: "Token", type: "secret", hint: "Made for you the first time this is enabled. Agents send it as a bearer token." },
        ],
        setup: [
            { text: "Enable this extension. A token is created for you." },
            { text: "Add the server to Claude Code. Run this once in a terminal:", copyFrom: "command" },
            { text: "Any other MCP client: point it at the same URL (streamable HTTP) with the Authorization header." },
            { text: "Ask your agent to \"deploy a Paper test server and tell me what is in the console\"." },
        ],
    },

    async activate(ctx: ExtensionContext) {
        let token = ctx.settings.get("token") ?? "";
        if (!token) {
            token = randomBytes(24).toString("hex");
            await ctx.settings.set("token", token);
        }
        const port = Number(ctx.settings.get<number>("port") ?? 7820);

        const endpoint = new McpEndpoint({ servers: ctx.servers, tools: () => ctx.agentTools() }, () => String(ctx.settings.get("token") ?? ""));
        await endpoint.start(port);
        ctx.dispose(() => endpoint.stop());
        ctx.status(`Listening on http://127.0.0.1:${port}/mcp`);
        ctx.handle("command", () => `claude mcp add --transport http testbench http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${ctx.settings.get("token")}"`);
        // A new port or token only takes effect on a fresh endpoint; say so rather than quietly keep the old one.
        ctx.settings.onChange(() => ctx.status(`Settings changed. Turn the extension off and on to use them (still listening on ${port}).`));
    },
};
