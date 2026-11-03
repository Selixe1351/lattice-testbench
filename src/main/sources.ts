import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import type { Software, Versions } from "@shared/types";

/**
 * Server jars and the standard plugins, fetched from where their authors publish them and cached by
 * content, so a second deploy of the same version starts without touching the network.
 */

const FILL = "https://fill.papermc.io/v3/projects";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const HANGAR = "https://hangar.papermc.io/api/v1/projects";
const MODRINTH = "https://api.modrinth.com/v2/project";
const USER_AGENT = "LatticeTestbench/0.2 (+https://github.com/Selixe1351/lattice-testbench)";

export interface Download {
    url: string;
    fileName: string;
    sha256?: string;
    /** The URL always serves the newest build, so it is fetched every time, and the cached copy is only a fallback. */
    moving?: boolean;
}

/** A plugin every test server gets, and where to find a build of it. */
interface PluginSource {
    name: string;
    from: "hangar" | "modrinth";
    project: string;
    /** Snapshots are allowed where the authors only support new Minecraft versions in them. */
    snapshots: boolean;
}

const GAME_PLUGINS: PluginSource[] = [
    { name: "ViaVersion", from: "hangar", project: "ViaVersion", snapshots: true },
    { name: "ViaBackwards", from: "hangar", project: "ViaBackwards", snapshots: true },
    { name: "PlaceholderAPI", from: "hangar", project: "PlaceholderAPI", snapshots: false },
    { name: "FastAsyncWorldEdit", from: "modrinth", project: "fastasyncworldedit", snapshots: false },
];

/** Whether a jar in a server's plugins folder is one a deploy puts there itself: a game plugin above, or an extension's (Lattice). */
export function ownPlugin(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.startsWith("lattice") || GAME_PLUGINS.some((p) => lower.startsWith(p.name.toLowerCase()));
}

/** Jolokia's JVM agent: JMX over HTTP, for the tick rate in the stats. */
export const JOLOKIA: Download = {
    url: "https://repo1.maven.org/maven2/org/jolokia/jolokia-agent-jvm/2.6.3/jolokia-agent-jvm-2.6.3-javaagent.jar",
    fileName: "jolokia-agent-jvm-2.6.3-javaagent.jar",
    sha256: "b51f95db08cc44c112a3724e9c782ea7f9cf60de5fb70cced119832bda17dadf",
};

async function json<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as T;
}

const UNSTABLE = /(pre|rc|snapshot|beta|alpha)/i;

async function fillVersions(project: string): Promise<string[]> {
    const body = await json<{ versions: Record<string, string[]> }>(`${FILL}/${project}`);
    // Groups and the versions in them are both newest first.
    return Object.values(body.versions).flat().filter((v) => !UNSTABLE.test(v));
}

export async function versions(): Promise<Versions> {
    const [paper, folia, velocity, purpur] = await Promise.all([
        fillVersions("paper"),
        fillVersions("folia"),
        fillVersions("velocity"),
        json<{ versions: string[] }>(PURPUR).then((b) => [...b.versions].reverse()),
    ]);
    return { paper, folia, velocity, purpur };
}

export async function serverJar(software: Software, version: string): Promise<Download> {
    if (software === "purpur") {
        return { url: `${PURPUR}/${version}/latest/download`, fileName: `purpur-${version}.jar` };
    }
    const build = await json<{ downloads: Record<string, { name: string; url: string; checksums: { sha256: string } }> }>(
        `${FILL}/${software}/versions/${version}/builds/latest`,
    );
    const file = build.downloads["server:default"];
    if (!file) throw new Error(`No ${software} ${version} build has a server download`);
    return { url: file.url, fileName: file.name, sha256: file.checksums.sha256 };
}

interface HangarVersion {
    name: string;
    channel: { name: string };
    platformDependencies: Record<string, string[]>;
    downloads: Record<string, { downloadUrl: string | null; externalUrl: string | null; fileInfo: { name: string; sha256Hash: string } | null }>;
}

interface ModrinthVersion {
    version_type: string;
    game_versions: string[];
    files: { url: string; filename: string; primary: boolean; hashes: { sha512?: string } }[];
}

async function hangar(source: PluginSource, platform: "PAPER", mc: string): Promise<Download> {
    const page = await json<{ result: HangarVersion[] }>(`${HANGAR}/${source.project}/versions?limit=25&platform=${platform}`);
    const usable = page.result.filter((v) => {
        const file = v.downloads[platform];
        return file?.downloadUrl && (source.snapshots || v.channel.name.toLowerCase() === "release");
    });
    // Newest build that says it supports this version; failing that, the newest at all.
    const pick = usable.find((v) => v.platformDependencies[platform]?.includes(mc)) ?? usable[0];
    if (!pick) throw new Error(`Hangar has no ${platform} build of ${source.name}`);
    const file = pick.downloads[platform];
    return { url: file.downloadUrl!, fileName: file.fileInfo?.name ?? `${source.name}.jar`, sha256: file.fileInfo?.sha256Hash };
}

async function modrinth(source: PluginSource, mc: string): Promise<Download> {
    const list = await json<ModrinthVersion[]>(`${MODRINTH}/${source.project}/version?loaders=${encodeURIComponent('["paper"]')}`);
    const usable = list.filter((v) => source.snapshots || v.version_type === "release");
    const pick = usable.find((v) => v.game_versions.includes(mc)) ?? usable[0];
    if (!pick) throw new Error(`Modrinth has no paper build of ${source.name}`);
    const file = pick.files.find((f) => f.primary) ?? pick.files[0];
    return { url: file.url, fileName: file.filename };
}

/** The standard plugins for a game server on [mc]. */
export async function gamePlugins(mc: string): Promise<Download[]> {
    return Promise.all(GAME_PLUGINS.map((s) => (s.from === "hangar" ? hangar(s, "PAPER", mc) : modrinth(s, mc))));
}

/** Returns the cached file for [download], fetching it first if needed. */
export async function fetchCached(cacheDir: string, download: Download, signal?: AbortSignal): Promise<string> {
    const key = createHash("sha1").update(download.url).digest("hex").slice(0, 16);
    const dir = join(cacheDir, key);
    const target = join(dir, download.fileName);
    // Purpur's "latest" URL moves too, so it is never served from cache while the network answers.
    const moving = download.moving || download.url.endsWith("/latest/download");
    if (existsSync(target) && !moving) return target;

    await mkdir(dir, { recursive: true });
    let response: Response;
    try {
        response = await fetch(download.url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal });
        if (!response.ok || !response.body) throw new Error(`Download of ${download.fileName} failed: ${response.status}`);
    } catch (error) {
        // Offline, a moving download falls back to the last one fetched rather than stopping the deploy.
        if (moving && existsSync(target) && !signal?.aborted) {
            console.warn(`${download.url} unreachable, using the cached ${download.fileName}`, error);
            return target;
        }
        throw error;
    }
    // Streamed to disk and hashed on the way, so a large archive (MongoDB is 600 MB) never sits in memory.
    // Written beside and renamed, so an interrupted download never leaves a truncated file in the cache.
    const partial = `${target}.part`;
    const hash = createHash("sha256");
    const hashing = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), hashing, createWriteStream(partial));
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
    if (download.sha256 && hash.digest("hex") !== download.sha256) {
        await rm(partial, { force: true });
        throw new Error(`${download.fileName} did not match its published checksum`);
    }
    await rm(target, { force: true });
    await rename(partial, target);
    return target;
}
