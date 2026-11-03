import { cp, mkdir, readdir, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { FileEntry, SearchHit, SearchOptions, SearchResult } from "@shared/types";

/** Larger files are logs, worlds or jars: not something to edit in a text box. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** A screenshot or map art is a few MB at most; past this it is not something to look at in a pane. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** What the files pane shows as a picture instead of text. Anything else binary is still refused. */
const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
};
/** Search skips anything bigger, for the same reason. */
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_HITS = 500;
/** Folders that hold game data or downloaded libraries rather than anything a person wrote. */
const SEARCH_SKIP = new Set(["libraries", "versions", "cache", ".paper-remapped", "world", "world_nether", "world_the_end"]);

/**
 * Resolves [path] inside [root], refusing anything that climbs out of it. The renderer only ever sends
 * paths it was given, but a file editor that can be talked into writing outside the server folder would
 * be a way to overwrite anything this user can.
 */
function inside(root: string, path: string): string {
    const base = resolve(root);
    const target = resolve(base, path);
    if (target !== base && !target.startsWith(base + sep)) throw new Error("That path is outside the server folder.");
    return target;
}

/** The absolute path of [path] inside [root], for callers that read the file themselves. */
export const resolveInside = inside;

/** Like [inside], but never the server folder itself: deleting or renaming that would take the server with it. */
function insideNotRoot(root: string, path: string): string {
    const target = inside(root, path);
    if (target === resolve(root)) throw new Error("That is the server folder itself.");
    return target;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * What each file held when the editor first touched it, so a diff can show everything changed since, not
 * just what is unsaved. Keyed by server folder, because paths repeat across servers.
 */
const originals = new Map<string, Map<string, string>>();

function remember(root: string, path: string, text: string): void {
    let forRoot = originals.get(resolve(root));
    if (!forRoot) originals.set(resolve(root), (forRoot = new Map()));
    if (!forRoot.has(path)) forRoot.set(path, text);
}

export function original(root: string, path: string): string | null {
    return originals.get(resolve(root))?.get(path) ?? null;
}

/** Drops what is remembered for a server that no longer exists. */
export function forget(root: string): void {
    originals.delete(resolve(root));
}

export async function list(root: string, path: string): Promise<FileEntry[]> {
    const dir = inside(root, path);
    const entries = await readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (entry) => {
        const full = join(dir, entry.name);
        const info = await stat(full).catch(() => null);
        return {
            name: entry.name,
            path: relative(resolve(root), full).split(sep).join("/"),
            directory: entry.isDirectory(),
            size: info?.size ?? 0,
        };
    }));
    return out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function read(root: string, path: string): Promise<string> {
    const file = inside(root, path);
    const info = await stat(file);
    if (info.size > MAX_EDIT_BYTES) throw new Error(`${path} is ${Math.round(info.size / 1024)} KB, too large to open here.`);
    const bytes = await readFile(file);
    // A NUL in the first few KB means a binary file; showing it as text would only corrupt it on save.
    if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${path} is a binary file.`);
    const text = bytes.toString("utf8");
    remember(root, path, text);
    return text;
}

/** An image as a data URL, which is what the renderer's content policy lets an <img> load. */
export async function readImage(root: string, path: string): Promise<string> {
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!type) throw new Error(`${path} is not an image.`);
    const file = inside(root, path);
    const info = await stat(file);
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`${path} is ${Math.round(info.size / 1024 / 1024)} MB, too large to show here.`);
    return `data:${type};base64,${(await readFile(file)).toString("base64")}`;
}

export async function write(root: string, path: string, content: string): Promise<void> {
    const file = inside(root, path);
    // A file saved without ever being opened here (after a restart, say) still gets a baseline.
    const before = await readFile(file, "utf8").catch(() => null);
    if (before !== null) remember(root, path, before);
    await writeFile(file, content, "utf8");
}

export async function create(root: string, path: string, directory: boolean): Promise<void> {
    const target = insideNotRoot(root, path);
    if (await exists(target)) throw new Error(`${basename(path)} already exists.`);
    if (directory) {
        await mkdir(target, { recursive: true });
    } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "", { flag: "wx" });
    }
}

export async function rename(root: string, from: string, to: string): Promise<void> {
    const source = insideNotRoot(root, from);
    const target = insideNotRoot(root, to);
    if (await exists(target)) throw new Error(`${basename(to)} already exists.`);
    await fsRename(source, target);
    const forRoot = originals.get(resolve(root));
    const text = forRoot?.get(from);
    if (forRoot && text !== undefined) {
        forRoot.delete(from);
        forRoot.set(to, text);
    }
}

export async function remove(root: string, path: string): Promise<void> {
    await rm(insideNotRoot(root, path), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    originals.get(resolve(root))?.delete(path);
}

/** Copies [path] beside itself as "name copy.ext", "name copy 2.ext"..., and returns the new path. */
export async function duplicate(root: string, path: string): Promise<string> {
    const source = insideNotRoot(root, path);
    const ext = extname(source);
    const stem = basename(source, ext);
    for (let n = 1; n < 100; n++) {
        const target = join(dirname(source), `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`);
        if (await exists(target)) continue;
        await cp(source, target, { recursive: true, errorOnExist: true, force: false });
        return relative(resolve(root), target).split(sep).join("/");
    }
    throw new Error("Too many copies of that file already.");
}

/** Copies files or folders from outside into [dir] of the server. A name already there is an error, never overwritten. */
export async function importPaths(root: string, dir: string, sources: string[]): Promise<void> {
    const target = inside(root, dir);
    for (const source of sources) {
        const destination = join(target, basename(source));
        if (await exists(destination)) throw new Error(`${basename(source)} is already in that folder.`);
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    }
}

// ------------------------------------------------------------------ search --

const searches = new Map<string, { cancelled: boolean }>();

export function cancelSearch(token: string): void {
    const state = searches.get(token);
    if (state) state.cancelled = true;
}

function matcher(options: SearchOptions): (line: string) => boolean {
    if (options.regex) {
        const pattern = new RegExp(options.query, options.caseSensitive ? "" : "i");
        return (line) => pattern.test(line);
    }
    if (options.caseSensitive) return (line) => line.includes(options.query);
    const needle = options.query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
}

/** Looks for the query in the text files of the server. Stops early, rejecting with "Cancelled", when [cancelSearch] is called for [token]. */
export async function search(root: string, options: SearchOptions, token: string): Promise<SearchResult> {
    const state = { cancelled: false };
    searches.set(token, state);
    try {
        if (!options.query) return { hits: [], truncated: false, filesScanned: 0 };
        // A bad regex is a typo in the box; it throws out of here so it is reported rather than shown as no matches.
        const test = matcher(options);
        const base = resolve(root);
        const hits: SearchHit[] = [];
        let scanned = 0;
        let truncated = false;

        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (state.cancelled || truncated) return;
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SEARCH_SKIP.has(entry.name)) await walk(full);
                    continue;
                }
                if (!entry.isFile()) continue;
                const info = await stat(full).catch(() => null);
                if (!info || info.size > MAX_SEARCH_BYTES) continue;
                const bytes = await readFile(full).catch(() => null);
                if (!bytes || bytes.subarray(0, 8192).includes(0)) continue;
                scanned++;
                const path = relative(base, full).split(sep).join("/");
                const lines = bytes.toString("utf8").split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (!test(lines[i])) continue;
                    if (hits.length >= MAX_HITS) {
                        truncated = true;
                        return;
                    }
                    hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 240) });
                }
            }
        };
        await walk(base);
        if (state.cancelled) throw new Error("Cancelled");
        return { hits, truncated, filesScanned: scanned };
    } finally {
        searches.delete(token);
    }
}
