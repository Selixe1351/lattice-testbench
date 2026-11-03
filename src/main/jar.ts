import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { FileEntry } from "@shared/types";
import { fetchCached } from "./sources";

/**
 * Browsing and decompiling jars. The zip directory is read here rather than through a library because
 * all that is needed is "list entries" and "extract one", and the decompiler only ever sees the classes
 * of the entry being opened, never the whole jar.
 */

const VINEFLOWER = {
    url: "https://repo1.maven.org/maven2/org/vineflower/vineflower/1.12.0/vineflower-1.12.0.jar",
    fileName: "vineflower-1.12.0.jar",
    sha256: "1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d",
};

const DECOMPILE_TIMEOUT_MS = 90_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

interface ZipEntry {
    name: string;
    method: number;
    compressed: number;
    size: number;
    offset: number;
}

interface Directory {
    mtime: number;
    entries: Map<string, ZipEntry>;
}

const directories = new Map<string, Directory>();

async function readDirectory(jar: string): Promise<Directory> {
    const info = await stat(jar);
    const cached = directories.get(jar);
    if (cached && cached.mtime === info.mtimeMs) return cached;

    const handle = await open(jar, "r");
    try {
        // The end-of-central-directory record is within the last 64 KB + 22 bytes (the comment is at most 64 KB).
        const tailSize = Math.min(info.size, 65_557);
        const tail = Buffer.alloc(tailSize);
        await handle.read(tail, 0, tailSize, info.size - tailSize);
        let eocd = -1;
        for (let i = tailSize - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error(`${basename(jar)} is not a valid jar.`);
        const count = tail.readUInt16LE(eocd + 10);
        const size = tail.readUInt32LE(eocd + 12);
        const offset = tail.readUInt32LE(eocd + 16);
        if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error(`${basename(jar)} uses zip64, which is not supported here.`);

        const central = Buffer.alloc(size);
        await handle.read(central, 0, size, offset);
        const entries = new Map<string, ZipEntry>();
        let at = 0;
        while (at + 46 <= size && central.readUInt32LE(at) === 0x02014b50) {
            const nameLength = central.readUInt16LE(at + 28);
            const extraLength = central.readUInt16LE(at + 30);
            const commentLength = central.readUInt16LE(at + 32);
            const name = central.toString("utf8", at + 46, at + 46 + nameLength);
            entries.set(name, {
                name,
                method: central.readUInt16LE(at + 10),
                compressed: central.readUInt32LE(at + 20),
                size: central.readUInt32LE(at + 24),
                offset: central.readUInt32LE(at + 42),
            });
            at += 46 + nameLength + extraLength + commentLength;
        }
        const directory = { mtime: info.mtimeMs, entries };
        directories.set(jar, directory);
        return directory;
    } finally {
        await handle.close();
    }
}

async function extract(jar: string, entry: ZipEntry): Promise<Buffer> {
    const handle = await open(jar, "r");
    try {
        const header = Buffer.alloc(30);
        await handle.read(header, 0, 30, entry.offset);
        if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name} is damaged.`);
        const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const data = Buffer.alloc(entry.compressed);
        await handle.read(data, 0, entry.compressed, start);
        if (entry.method === 0) return data;
        if (entry.method === 8) return inflateRawSync(data);
        throw new Error(`${entry.name} uses compression method ${entry.method}.`);
    } finally {
        await handle.close();
    }
}

/** The raw bytes of [name] in the zip at [zip], for callers that want a file out of an archive rather than text. */
export async function readEntryBytes(zip: string, name: string): Promise<Buffer> {
    const entry = (await readDirectory(zip)).entries.get(name);
    if (!entry) throw new Error(`${name} is not in ${basename(zip)}.`);
    return extract(zip, entry);
}

/** Every entry name in the zip at [zip], folders included (they end in a slash). */
export async function zipEntries(zip: string): Promise<string[]> {
    return [...(await readDirectory(zip)).entries.keys()];
}

/** The immediate children of [dir] inside the jar, folders first. Folders are inferred from entry names. */
export async function listJar(jar: string, dir: string): Promise<FileEntry[]> {
    const { entries } = await readDirectory(jar);
    const prefix = dir ? `${dir}/` : "";
    const folders = new Set<string>();
    const files: FileEntry[] = [];
    for (const entry of entries.values()) {
        if (!entry.name.startsWith(prefix) || entry.name === prefix) continue;
        const rest = entry.name.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) folders.add(rest.slice(0, slash));
        else files.push({ name: rest, path: entry.name, directory: false, size: entry.size });
    }
    const out: FileEntry[] = [...folders].map((name) => ({ name, path: `${prefix}${name}`, directory: true, size: 0 }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return [...out, ...files.sort((a, b) => a.name.localeCompare(b.name))];
}

/** Running decompiles by token, so the renderer can abandon one when the person leaves the jar. */
const running = new Map<string, { abort: AbortController; child?: ChildProcess }>();

export function cancel(token: string): void {
    const job = running.get(token);
    if (!job) return;
    job.abort.abort();
    job.child?.kill();
}

const results = new Map<string, string>();

function runDecompiler(java: string, vineflower: string, library: string, sources: string[], out: string, token: string): Promise<void> {
    const job = running.get(token)!;
    return new Promise((resolve, reject) => {
        const child = spawn(java, ["-jar", vineflower, `-e=${library}`, ...sources, out], { windowsHide: true });
        job.child = child;
        let output = "";
        child.stdout.on("data", (d: Buffer) => (output += d.toString()));
        child.stderr.on("data", (d: Buffer) => (output += d.toString()));
        const timer = setTimeout(() => child.kill(), DECOMPILE_TIMEOUT_MS);
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (job.abort.signal.aborted) reject(new Error("Cancelled"));
            else if (code === 0) resolve();
            else reject(new Error(`The decompiler exited with ${code}.\n${output.trim().slice(-600)}`));
        });
    });
}

/**
 * Text of [entry] in [jar]. A class is decompiled to Java along with its nested classes; anything else is
 * shown as text if it is. Rejects with "Cancelled" if [cancel] was called for [token].
 */
export async function openEntry(java: string, cacheDir: string, jar: string, entryName: string, token: string): Promise<string> {
    const abort = new AbortController();
    running.set(token, { abort });
    try {
        const { entries, mtime } = await readDirectory(jar);
        const entry = entries.get(entryName);
        if (!entry) throw new Error(`${entryName} is not in ${basename(jar)}.`);

        if (!entryName.endsWith(".class")) {
            if (entry.size > MAX_TEXT_BYTES) throw new Error(`${entryName} is too large to open here.`);
            const bytes = await extract(jar, entry);
            if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${entryName} is a binary file.`);
            return bytes.toString("utf8");
        }

        const key = `${jar}|${mtime}|${entryName}`;
        const cached = results.get(key);
        if (cached !== undefined) return cached;

        if (!java) throw new Error("Set the Java path in Settings first.");
        const vineflower = await fetchCached(join(cacheDir, "tools"), VINEFLOWER, abort.signal);
        if (abort.signal.aborted) throw new Error("Cancelled");

        const work = await mkdtemp(join(tmpdir(), "testbench-decompile-"));
        try {
            // The class plus every class nested in it, so the output has the inner classes inline.
            const stem = entryName.slice(0, -".class".length);
            const wanted = [entry, ...[...entries.values()].filter((e) => e.name.startsWith(`${stem}$`) && e.name.endsWith(".class"))];
            const sources: string[] = [];
            const out = join(work, "out");
            await mkdir(out);
            for (const e of wanted) {
                const file = join(work, basename(e.name));
                await writeFile(file, await extract(jar, e));
                sources.push(file);
            }
            await runDecompiler(java, vineflower, jar, sources, out, token);
            // Vineflower writes Kotlin-looking classes as .kt, so the extension is not assumed.
            const produced = (await readdir(out)).find((f) => f.startsWith(`${basename(stem)}.`));
            if (!produced) throw new Error(`The decompiler produced no output for ${entryName}.`);
            const text = await readFile(join(out, produced), "utf8");
            results.set(key, text);
            // A bounded cache: decompiling is slow enough to be worth remembering, but jars are large.
            if (results.size > 60) results.delete(results.keys().next().value!);
            return text;
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    } finally {
        running.delete(token);
    }
}
