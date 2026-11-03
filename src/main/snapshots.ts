import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DeployRequest, SnapshotInfo } from "@shared/types";
import { writeZip } from "./export";
import { MANIFEST, type ImportedServer } from "./import";
import { readEntryBytes, zipEntries } from "./jar";

/**
 * Snapshots keep what a test built up - worlds, module configs, Lattice data - and leave out what a deploy
 * writes anyway. A restore is a normal deploy of the same request with these files laid over it, so ports,
 * secrets and jars are always the new deploy's, and a module rebuilt since is the one that runs.
 */

/** A process folder inside a server: none for a single server. */
const PROC = /^(?:(?:proxy|bots|backend-\d+)\/)?/;

/** Written fresh by every deploy, so a snapshot's copy would only fight it (ports, secrets, jars). */
export function generated(path: string): boolean {
    if (path === MANIFEST) return true;
    const rest = path.replace(PROC, "");
    return /^(server\.jar|server\.properties|velocity\.toml|forwarding\.secret|eula\.txt|server-icon\.png)$/.test(rest)
        || /^plugins\/[^/]+\.jar$/.test(rest)
        || /^plugins\/lattice\/(lattice\.yml|modules\/.*)$/i.test(rest)
        || rest === "config/paper-global.yml";
}

/** Downloaded or rebuilt by the server itself, or meaningless outside the run that wrote it. */
function disposable(path: string): boolean {
    // A throwaway mongod's files are locked while it runs, and a restore starts a fresh one anyway.
    if (path.startsWith("mongo/")) return true;
    const rest = path.replace(PROC, "");
    return /^(libraries|versions|cache|logs|crash-reports)\//.test(rest)
        || /^plugins\/\.paper-remapped\//.test(rest)
        || /(^|\/)session\.lock$/.test(rest);
}

export const kept = (path: string) => !generated(path) && !disposable(path);

export class Snapshots {
    constructor(private readonly dir: string) {}

    async list(): Promise<SnapshotInfo[]> {
        if (!existsSync(this.dir)) return [];
        const out: SnapshotInfo[] = [];
        for (const id of await readdir(this.dir)) {
            try {
                out.push(JSON.parse(await readFile(join(this.dir, id, "snapshot.json"), "utf8")) as SnapshotInfo);
            } catch (error) {
                console.warn(`Skipping unreadable snapshot ${id}`, error);
            }
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
    }

    async get(id: string): Promise<SnapshotInfo> {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error("No such snapshot");
        return JSON.parse(await readFile(join(this.dir, id, "snapshot.json"), "utf8")) as SnapshotInfo;
    }

    /** Zips [serverDir] as a snapshot of a server deployed with [request]. */
    async save(serverDir: string, name: string, request: DeployRequest): Promise<SnapshotInfo> {
        const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
        const folder = join(this.dir, id);
        await mkdir(folder, { recursive: true });
        try {
            const written = await writeZip(serverDir, join(folder, "snapshot.zip"), kept);
            const info: SnapshotInfo = {
                id,
                name: name.trim().slice(0, 60) || "Snapshot",
                createdAt: Date.now(),
                request: { ...request, snapshot: undefined },
                files: written.files,
                skipped: written.skipped,
            };
            await writeFile(join(folder, "snapshot.json"), JSON.stringify(info, null, 2));
            return info;
        } catch (error) {
            await rm(folder, { recursive: true, force: true });
            throw error;
        }
    }

    /**
     * Copies a server zip in as a snapshot of [server]'s request. Its own plugin jars are copied out beside it and the
     * request pointed at them, since the paths it was deployed from belong to whichever PC exported it.
     */
    async adopt(zip: string, server: ImportedServer): Promise<SnapshotInfo> {
        const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
        const folder = join(this.dir, id);
        await mkdir(join(folder, "plugins"), { recursive: true });
        try {
            await copyFile(zip, join(folder, "snapshot.zip"));
            const plugins: string[] = [];
            for (const name of server.plugins) {
                const file = join(folder, "plugins", basename(name));
                await writeFile(file, await readEntryBytes(zip, name));
                plugins.push(file);
            }
            const info: SnapshotInfo = {
                id,
                name: server.name.trim().slice(0, 60) || "Imported server",
                createdAt: Date.now(),
                request: { ...server.request, plugins, snapshot: undefined },
                files: (await zipEntries(zip)).filter((name) => !name.endsWith("/")).length,
                skipped: 0,
            };
            await writeFile(join(folder, "snapshot.json"), JSON.stringify(info, null, 2));
            return info;
        } catch (error) {
            await rm(folder, { recursive: true, force: true });
            throw error;
        }
    }

    /** Lays snapshot [id]'s files over [target], a server folder a deploy has just written. */
    async restoreInto(id: string, target: string): Promise<number> {
        const zip = join(this.dir, id, "snapshot.zip");
        let count = 0;
        for (const name of await zipEntries(zip)) {
            // Names come from a file on disk: never let one climb out of the server folder.
            if (name.endsWith("/") || name.split("/").includes("..") || /^[a-z]:|^\//i.test(name) || !kept(name)) continue;
            const file = join(target, ...name.split("/"));
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, await readEntryBytes(zip, name));
            count++;
        }
        return count;
    }

    async remove(id: string): Promise<void> {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error("No such snapshot");
        await rm(join(this.dir, id), { recursive: true, force: true });
    }
}
