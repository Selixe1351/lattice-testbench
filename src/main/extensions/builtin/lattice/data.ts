import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataCollection, DataDocument } from "@shared/lattice";

/**
 * Reads what Lattice stored, in the two layouts it writes on a test server:
 *   sqlite    storage.db, one table lattice_<collection> per collection with (id, document)
 *   flatfile  data/<collection>/<base64url id>.json
 * Reads are safe while the server runs; the writes at the end are only for a stopped server.
 */

const pretty = (text: string) => {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        // Not JSON after all: show it as stored rather than hide it.
        return text;
    }
};

// ---------------------------------------------------------------- flatfile --

export async function flatCollections(dir: string): Promise<DataCollection[]> {
    if (!existsSync(dir)) return [];
    const out: DataCollection[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const files = (await readdir(join(dir, entry.name))).filter((f) => f.endsWith(".json"));
        out.push({ name: entry.name, count: files.length });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function flatDocuments(dir: string, collection: string, limit: number): Promise<DataDocument[]> {
    if (!/^[a-z0-9_-]+$/.test(collection)) throw new Error("No such collection");
    const folder = join(dir, collection);
    if (!existsSync(folder)) return [];
    const files = (await readdir(folder)).filter((f) => f.endsWith(".json"));
    // Newest first: what a test just wrote is what the person is looking for.
    const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(folder, f))).mtimeMs })));
    dated.sort((a, b) => b.at - a.at);
    return Promise.all(dated.slice(0, limit).map(async ({ f }) => ({
        id: Buffer.from(f.slice(0, -".json".length), "base64url").toString("utf8"),
        json: pretty(await readFile(join(folder, f), "utf8")),
    })));
}

// ------------------------------------------------------------------ sqlite --

type Row = Record<string, unknown>;

async function openSqlite(file: string) {
    // Electron's Node has node:sqlite; imported here so code that never reads sqlite does not need it.
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
}

export async function sqliteCollections(file: string): Promise<DataCollection[]> {
    if (!existsSync(file)) return [];
    const db = await openSqlite(file);
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lattice\\_%' ESCAPE '\\'").all() as Row[];
        return tables.map((t) => {
            const table = String(t.name);
            const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as Row).n);
            return { name: table.slice("lattice_".length), count };
        }).sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        db.close();
    }
}

export async function sqliteDocuments(file: string, collection: string, limit: number): Promise<DataDocument[]> {
    if (!/^[a-z0-9_]+$/.test(collection)) throw new Error("No such collection");
    if (!existsSync(file)) return [];
    const db = await openSqlite(file);
    try {
        // rowid order, newest first: the closest sqlite has to "most recently written".
        const rows = db.prepare(`SELECT id, document FROM "lattice_${collection}" ORDER BY rowid DESC LIMIT ?`).all(limit) as Row[];
        return rows.map((r) => ({ id: String(r.id), json: pretty(String(r.document)) }));
    } finally {
        db.close();
    }
}


// ------------------------------------------------------------------ writes --
// Only while the server is stopped (Instances checks): Lattice keeps documents cached, so an edit under a
// running server would be overwritten by its next save, or served stale until then.

/** [json] as Lattice stores it: compact, and an object, which is all a module ever reads back. */
export function documentJson(json: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        throw new Error(`Not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A document is a JSON object: { ... }.");
    return JSON.stringify(parsed);
}

function checkId(id: string): void {
    if (!id || id.length > 191) throw new Error("A document id is 1 to 191 characters.");
}

export async function flatWrite(dir: string, collection: string, id: string, json: string): Promise<void> {
    if (!/^[a-z0-9_-]+$/.test(collection)) throw new Error("A collection name is lower-case letters, digits, _ and -.");
    checkId(id);
    const folder = join(dir, collection);
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${Buffer.from(id).toString("base64url")}.json`);
    // Replaced whole, the way Lattice writes, so a crash never leaves half a document.
    await writeFile(`${file}.tmp`, documentJson(json));
    await rename(`${file}.tmp`, file);
}

export async function flatDelete(dir: string, collection: string, id: string): Promise<void> {
    if (!/^[a-z0-9_-]+$/.test(collection)) throw new Error("No such collection");
    await rm(join(dir, collection, `${Buffer.from(id).toString("base64url")}.json`), { force: true });
}

async function openWritable(file: string) {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file);
}

export async function sqliteWrite(file: string, collection: string, id: string, json: string): Promise<void> {
    if (!/^[a-z0-9_]+$/.test(collection)) throw new Error("A collection name is lower-case letters, digits and _.");
    checkId(id);
    const document = documentJson(json);
    const db = await openWritable(file);
    try {
        // The table Lattice's SqlBackend makes, in case the module has not written to it yet.
        db.exec(`CREATE TABLE IF NOT EXISTS "lattice_${collection}" (id VARCHAR(191) PRIMARY KEY, document TEXT NOT NULL)`);
        db.prepare(`INSERT INTO "lattice_${collection}"(id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document`).run(id, document);
    } finally {
        db.close();
    }
}

export async function sqliteDelete(file: string, collection: string, id: string): Promise<void> {
    if (!/^[a-z0-9_]+$/.test(collection)) throw new Error("No such collection");
    const db = await openWritable(file);
    try {
        db.prepare(`DELETE FROM "lattice_${collection}" WHERE id = ?`).run(id);
    } finally {
        db.close();
    }
}

