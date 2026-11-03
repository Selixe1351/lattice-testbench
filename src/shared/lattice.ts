import { logText } from "./console";

/** What the Lattice extension shows. Plain data, structured-cloned over IPC. */

/** What `lattice modules`, `peers`, `doctor` and `license` printed on one process. */
export interface LatticeInfo {
    process: string;
    modules: { id: string; version: string; state: string; depends: string[] }[];
    /** Empty on a single server: it has no mesh. */
    peers: { nodeId: string; state: string; where: string; seen: string }[];
    doctor: string[];
    license: string[];
}

export interface DataCollection {
    name: string;
    count: number;
}

/** One place a server keeps data: a process's own sqlite file or folder. */
export interface DataSource {
    /** The process it belongs to. */
    process: string;
    kind: Exclude<StorageKind, "default">;
    collections: DataCollection[];
    /** Why it is empty, e.g. a file not created yet. */
    note?: string;
}

/** One document that differs from when the data was marked. */
export interface DataChange {
    process: string;
    collection: string;
    id: string;
    /** Absent when the document is new. */
    before?: string;
    /** Absent when the document was deleted. */
    after?: string;
}

export interface DataDocument {
    id: string;
    /** The document as stored, pretty-printed JSON. */
    json: string;
}

/** Where Lattice keeps data on a test server. "default" is Lattice's own, which is sqlite. */
export type StorageKind = "default" | "sqlite" | "flatfile";

/**
 * What a line says about a Lattice module, from the kernel's own messages (ModuleKernel.kt):
 *   Enabled economy v1.2.0
 *   economy failed to enable and was rolled back: ...
 *   Will not load economy: ...
 *   Could not construct economy: ...
 */
export function moduleEvent(text: string): { id: string; ok: boolean } | null {
    const enabled = /\bEnabled ([\w.-]+) v\S+/.exec(text);
    if (enabled) return { id: enabled[1], ok: true };
    const failed = /\b([\w.-]+) failed to enable and was rolled back\b/.exec(text) ?? /\b(?:Will not load|Could not construct) ([\w.-]+):/.exec(text);
    if (failed) return { id: failed[1], ok: false };
    return null;
}

/** A line of `lattice modules`: "  economy v1.2.0 [ENABLED] <- profiles, data". */
export function moduleLine(text: string): { id: string; version: string; state: string; depends: string[] } | null {
    const match = /^\s+([\w.-]+) v(\S+) \[([A-Z_]+)\](?: <- (.+))?$/.exec(logText(text));
    if (!match) return null;
    return { id: match[1], version: match[2], state: match[3], depends: match[4] ? match[4].split(",").map((d) => d.trim()) : [] };
}

/** A line of `lattice peers`: "  backend-1 [ALIVE] default/eu 127.0.0.1:25603 - 12ms ago". */
export function peerLine(text: string): { nodeId: string; state: string; where: string; seen: string } | null {
    const match = /^\s+([\w.-]+) \[([A-Z_]+)\] (\S+ \S+) - (.+)$/.exec(logText(text));
    if (!match) return null;
    return { nodeId: match[1], state: match[2], where: match[3], seen: match[4] };
}
