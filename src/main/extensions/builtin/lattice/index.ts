import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { moduleEvent, moduleLine, peerLine, type DataChange, type DataDocument, type DataSource, type LatticeInfo, type StorageKind } from "@shared/lattice";
import { readEntryBytes, zipEntries } from "../../../jar";
import { fetchCached } from "../../../sources";
import type { PrepareContext, ProcessPlan } from "../../hooks";
import { defineExtension } from "@shared/extension-api";
import * as data from "./data";

/**
 * Lattice: adds the Lattice platform (lattice.net's modular server plugin) and your module jars to a test server,
 * writes its config, follows which modules enabled or failed, and shows its status and stored data in a tab.
 * Nothing here is needed for ordinary plugin testing; it only exists for people who build on Lattice.
 */

/** A reply to a console command, as the server logs it: INFO with no plugin tag. */
const COMMAND_REPLY = /^\[\d\d:\d\d:\d\d INFO\]: /;
/** The lines of `lattice modules` and `lattice peers`: a header, then one indented "id ... [STATE]" line each. */
const LIST = /^\[\d\d:\d\d:\d\d INFO\]: (?:(?:Modules|Peers) \(\d+\)|\s+[\w.-]+ (?:v\S+ )?\[[A-Z_]+\]|.*(?:No modules are loaded|The mesh is disabled))/;
/** Per collection, when marking data for a diff. More than this and the mark says so rather than guess. */
const MARK_LIMIT = 10_000;

const latticeDir = (proc: ProcessPlan): string => join(proc.dir, "plugins", proc.software === "velocity" ? "lattice" : "Lattice");
const root = (proc: ProcessPlan): string => (proc.software === "velocity" ? "vlattice" : "lattice");

export const lattice = defineExtension({
    manifest: {
        id: "lattice",
        name: "Lattice",
        description: "Run the Lattice platform on a test server with your own module jars, and watch its modules, health and stored data.",
        version: "1.0.0",
        api: 1,
        permissions: ["Downloads the Lattice jar from the address you give", "Writes plugins/Lattice on test servers"],
        settings: [
            { key: "jarPath", label: "Lattice jar on this PC", type: "path", extensions: ["jar"], hint: "A lattice-public-*.jar. Wins over the address below." },
            { key: "jarUrl", label: "or download it from", type: "text", placeholder: "https://example.com/lattice-public.jar", hint: "Fetched on every deploy so you always get the newest build." },
            { key: "licenseKey", label: "Lattice license key", type: "secret", hint: "Written into lattice.yml. Optional: modules that need a license ask for it." },
        ],
        deploy: [
            { key: "enabled", label: "Run Lattice on this server", type: "boolean", default: false },
            { key: "modules", label: "Module jars", type: "files", extensions: ["jar"], hint: "Copied into plugins/Lattice/modules. Lattice hot-swaps a changed jar." },
            {
                key: "storage", label: "Storage", type: "select", default: "default",
                options: [{ value: "default", label: "Lattice default (SQLite)" }, { value: "sqlite", label: "SQLite" }, { value: "flatfile", label: "Flat files" }],
                hint: "SQLite and flat files can be browsed in the Data tab.",
            },
        ],
        setup: [
            { text: "Get the Lattice jar for your edition and save it somewhere, or note the address it downloads from." },
            { text: "Set \"Lattice jar on this PC\" or \"download it from\" above.", needs: ["jarPath"] },
            { text: "Build your module as a jar (for example with the lat CLI or gradle shadowJar)." },
            { text: "Open Deploy, switch on \"Run Lattice on this server\" and pick your module jars." },
            { text: "Open the server: a Lattice tab shows module status, health and stored data. Rebuild a jar and press \"Copy modules again\" to hot-swap." },
        ],
        actions: [{ id: "recopy", label: "Copy modules again", when: ["running"] }],
    },

    activate(ctx) {
        const marks = new Map<string, { at: number; docs: Map<string, string> }>();
        const storageOf = (id: string): Exclude<StorageKind, "default"> => lastStorage.get(id) ?? "sqlite";
        const lastStorage = new Map<string, Exclude<StorageKind, "default">>();
        const moduleJars = new Map<string, string[]>();

        ctx.hook("deploy", async ({ request, options, log }) => {
            if (!options.enabled) return;
            if (request.software === "velocity") throw new Error("Lattice runs on one server here. Deploy Paper, Folia or Purpur.");
            const path = String(ctx.settings.get("jarPath") ?? "");
            const url = String(ctx.settings.get("jarUrl") ?? "");
            if (!path && !url) throw new Error("Set the Lattice jar in Extensions > Lattice first.");
            if (path && !existsSync(path)) throw new Error(`${basename(path)} is no longer at ${path}.`);
            log(path ? "Using the Lattice jar on this PC." : "Fetching Lattice...");
        });

        ctx.hook("prepare", async (c: PrepareContext) => {
            if (!c.options.enabled || c.proc.role !== "game") return;
            const path = String(ctx.settings.get("jarPath") ?? "");
            const url = String(ctx.settings.get("jarUrl") ?? "");
            const jar = path || await fetchCached(c.cacheDir, { url, fileName: "lattice.jar", moving: true });
            const plugins = join(c.proc.dir, "plugins");
            const modules = join(latticeDir(c.proc), "modules");
            await mkdir(modules, { recursive: true });
            await copyFile(jar, join(plugins, basename(jar)));
            const picked = (c.options.modules as string[] | undefined) ?? [];
            await copyAll(picked, modules);

            const storage = String(c.options.storage ?? "default");
            const config: Record<string, unknown> = { license: { key: String(ctx.settings.get("licenseKey") ?? "") } };
            if (storage !== "default") config.storage = { backend: storage };
            await mkdirWrite(join(latticeDir(c.proc), "lattice.yml"), stringify(config));

            lastStorage.set(c.serverId, storage === "flatfile" ? "flatfile" : "sqlite");
            moduleJars.set(c.serverId, picked);
            const view = ctx.servers.get(c.serverId);
            ctx.servers.update(c.serverId, { modules: await Promise.all(picked.map(moduleId)), moduleStatus: {}, uses: [...new Set([...(view?.uses ?? []), "lattice"])] });
        });

        ctx.hook("destroy", (id) => {
            marks.delete(id);
            lastStorage.delete(id);
            moduleJars.delete(id);
        });

        // What the kernel says about each module, for the header badges.
        ctx.servers.on("console", (line) => {
            const event = moduleEvent(line.text);
            const view = ctx.servers.get(line.serverId);
            if (!event || !view || !view.modules.includes(event.id)) return;
            // One process failing marks the module failed for the server, whatever the others said.
            if (!event.ok || view.moduleStatus[event.id] !== "failed") {
                ctx.servers.update(view.id, { moduleStatus: { ...view.moduleStatus, [event.id]: event.ok ? "enabled" : "failed" } });
            }
        });

        const running = (id: string, process: string) => {
            const proc = ctx.servers.processes(id).find((p) => p.name === process);
            if (!proc || proc.state !== "running") throw new Error("That process is not running.");
            return proc;
        };

        async function modules(id: string, process: string): Promise<Pick<LatticeInfo, "modules" | "peers">> {
            const proc = running(id, process);
            const run = (sub: string) => ctx.servers.query(id, process, [`${root(proc)} ${sub}`], LIST);
            const list = (await run("modules")).flatMap((l) => moduleLine(l) ?? []);
            return { modules: list, peers: proc.software === "velocity" ? (await run("peers")).flatMap((l) => peerLine(l) ?? []) : [] };
        }

        async function info(id: string, process: string): Promise<LatticeInfo> {
            const proc = running(id, process);
            const run = (sub: string) => ctx.servers.query(id, process, [`${root(proc)} ${sub}`], COMMAND_REPLY);
            const { modules: list, peers } = await modules(id, process);
            return { process, modules: list, peers, doctor: await run("doctor"), license: await run("license") };
        }

        async function sources(id: string): Promise<DataSource[]> {
            const kind = storageOf(id);
            return Promise.all(ctx.servers.processes(id).map(async (proc): Promise<DataSource> => {
                const collections = kind === "sqlite" ? await data.sqliteCollections(join(latticeDir(proc), "storage.db")) : await data.flatCollections(join(latticeDir(proc), "data"));
                return { process: proc.name, kind, collections, ...(collections.length === 0 ? { note: "Nothing stored yet." } : {}) };
            }));
        }

        async function documents(id: string, process: string, collection: string, limit: number): Promise<DataDocument[]> {
            const kind = storageOf(id);
            const max = Math.max(1, Math.min(limit, 500));
            const proc = ctx.servers.processes(id).find((p) => p.name === process);
            if (!proc) throw new Error("No such process");
            return kind === "sqlite" ? data.sqliteDocuments(join(latticeDir(proc), "storage.db"), collection, max) : data.flatDocuments(join(latticeDir(proc), "data"), collection, max);
        }

        async function everything(id: string): Promise<Map<string, string>> {
            const docs = new Map<string, string>();
            for (const source of await sources(id)) {
                for (const collection of source.collections) {
                    if (collection.count > MARK_LIMIT) throw new Error(`${collection.name} has ${collection.count} documents, more than the ${MARK_LIMIT} a mark can hold.`);
                    for (const doc of await documents(id, source.process, collection.name, MARK_LIMIT)) docs.set(`${source.process}\u0000${collection.name}\u0000${doc.id}`, doc.json);
                }
            }
            return docs;
        }

        ctx.handle("info", info);
        ctx.handle("modules", modules);
        ctx.handle("sources", sources);
        ctx.handle("documents", documents);
        ctx.handle("mark", async (id: string) => {
            const mark = { at: Date.now(), docs: await everything(id) };
            marks.set(id, mark);
            return { at: mark.at, documents: mark.docs.size };
        });
        ctx.handle("changes", async (id: string): Promise<{ at: number; changes: DataChange[] } | null> => {
            const mark = marks.get(id);
            if (!mark) return null;
            const now = await everything(id);
            const changes: DataChange[] = [];
            for (const key of new Set([...mark.docs.keys(), ...now.keys()])) {
                const was = mark.docs.get(key);
                const is = now.get(key);
                if (was === is) continue;
                const [process, collection, docId] = key.split("\u0000");
                changes.push({ process, collection, id: docId, ...(was !== undefined ? { before: was } : {}), ...(is !== undefined ? { after: is } : {}) });
            }
            changes.sort((a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id));
            return { at: mark.at, changes };
        });
        ctx.handle("write", async (id: string, process: string, collection: string, docId: string, json: string | null) => {
            // Lattice caches documents, so a running server would overwrite the edit with its next save.
            if (ctx.servers.processes(id).some((p) => p.state === "running" || p.state === "starting")) throw new Error("Stop the server first: Lattice keeps documents in memory and would overwrite the edit.");
            const proc = ctx.servers.processes(id).find((p) => p.name === process);
            if (!proc) throw new Error("No such process");
            if (storageOf(id) === "sqlite") {
                const file = join(latticeDir(proc), "storage.db");
                await (json === null ? data.sqliteDelete(file, collection, docId) : data.sqliteWrite(file, collection, docId, json));
            } else {
                const dir = join(latticeDir(proc), "data");
                await (json === null ? data.flatDelete(dir, collection, docId) : data.flatWrite(dir, collection, docId, json));
            }
            ctx.servers.log(id, "app", `${json === null ? "Deleted" : "Saved"} ${collection}/${docId} on ${process}.`);
        });
        ctx.handle("reset", async (id: string) => {
            await ctx.servers.stop(id);
            const kind = storageOf(id);
            const { rm } = await import("node:fs/promises");
            for (const proc of ctx.servers.processes(id)) {
                const dir = latticeDir(proc);
                if (kind === "sqlite") for (const f of ["storage.db", "storage.db-wal", "storage.db-shm"]) await rm(join(dir, f), { force: true });
                else await rm(join(dir, "data"), { recursive: true, force: true });
            }
            ctx.servers.log(id, "app", "Stored data deleted. Starting again.");
            ctx.servers.start(id);
        });
        // A saved config under plugins/Lattice/config is applied with Lattice's own reload command.
        ctx.handle("reloadConfig", (id: string, path: string): string | null => {
            if (!/(^|\/)plugins\/lattice\/config\/.+\.ya?ml$/i.test(path)) return null;
            const proc = ctx.servers.processes(id).find((p) => {
                const rel = relative(ctx.servers.dir(id), p.dir).split(sep).join("/");
                return rel === "" || path.startsWith(`${rel}/`);
            });
            if (!proc || proc.state !== "running") return null;
            ctx.servers.command(id, proc.name, `${root(proc)} reload config`);
            return proc.name;
        });

        ctx.action("recopy", async (id: string) => {
            const picked = moduleJars.get(id) ?? [];
            if (picked.length === 0) throw new Error("This server has no module jars picked from disk.");
            for (const proc of ctx.servers.processes(id).filter((p) => p.role === "game")) await copyAll(picked, join(latticeDir(proc), "modules"));
            ctx.servers.log(id, "app", `Copied ${picked.length} module jar${picked.length === 1 ? "" : "s"} again; Lattice swaps changed ones in.`);
        });

        ctx.tool({
            name: "lattice_info",
            description: "What Lattice reports on a process: modules with state and dependencies, mesh peers, doctor and license output.",
            input: { id: { type: "string", description: "Server id" }, process: { type: "string", description: "Process name; defaults to the game server", optional: true } },
            run: ({ id, process }) => info(id, process ?? ctx.servers.processes(id).find((p) => p.role === "game")?.name ?? "server"),
        });
        ctx.tool({
            name: "data_collections",
            description: "Where Lattice stores data on the server and each collection's size.",
            input: { id: { type: "string", description: "Server id" } },
            run: ({ id }) => sources(id),
        });
        ctx.tool({
            name: "data_documents",
            description: "Documents of one collection, as stored.",
            input: {
                id: { type: "string", description: "Server id" },
                collection: { type: "string", description: "Collection name" },
                process: { type: "string", description: "Process name", optional: true },
                limit: { type: "number", description: "At most this many, default 50", optional: true },
            },
            run: ({ id, collection, process, limit }) => documents(id, process ?? "server", collection, Number(limit ?? 50)),
        });
    },
});

/** A module's id: the `id` in its jar's module.yml, which is what Lattice reports it by. Its file name is the fallback. */
async function moduleId(file: string): Promise<string> {
    try {
        if ((await zipEntries(file)).includes("module.yml")) {
            const id = (parse((await readEntryBytes(file, "module.yml")).toString("utf8")) as { id?: unknown } | null)?.id;
            if (typeof id === "string" && id) return id;
        }
    } catch (error) {
        console.warn(`Could not read module.yml from ${file}`, error);
    }
    return basename(file).replace(/\.jar$/i, "").replace(/-\d.*$/, "");
}

async function copyAll(files: string[], into: string): Promise<void> {
    await mkdir(into, { recursive: true });
    for (const file of files) {
        if (!existsSync(file)) throw new Error(`${basename(file)} is no longer at ${file}.`);
        await copyFile(file, join(into, basename(file)));
    }
}

async function mkdirWrite(file: string, content: string): Promise<void> {
    const { dirname } = await import("node:path");
    const { writeFile } = await import("node:fs/promises");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
}
