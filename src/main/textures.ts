import { readEntryBytes, zipEntries } from "./jar";
import { fetchCached } from "./sources";

/**
 * Item icons for the player view, from the game's own textures. Only the client jar ships them; the server
 * jar has none. It is fetched once per version from Mojang, as the launcher does, and cached like any jar.
 */

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

interface Manifest {
    latest: { release: string };
    versions: { id: string; url: string }[];
}

async function json<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as T;
}

const jars = new Map<string, Promise<string>>();

/** The client jar for [version], or for the latest release when Mojang does not list that version. */
function clientJar(cacheDir: string, version: string): Promise<string> {
    let jar = jars.get(version);
    if (!jar) {
        jar = (async () => {
            const manifest = await json<Manifest>(MANIFEST);
            const entry = manifest.versions.find((v) => v.id === version) ?? manifest.versions.find((v) => v.id === manifest.latest.release);
            if (!entry) throw new Error("Mojang's version manifest lists no release.");
            const meta = await json<{ downloads: { client: { url: string } } }>(entry.url);
            return fetchCached(cacheDir, { url: meta.downloads.client.url, fileName: `client-${entry.id}.jar` });
        })();
        // A failed fetch is tried again next time rather than remembered.
        jar.catch(() => jars.delete(version));
        jars.set(version, jar);
    }
    return jar;
}

const icons = new Map<string, string | null>();

/**
 * A data URL per item id, or null for an item with no flat texture. Blocks have no item texture, only the
 * faces their 3D model is built from, so a block shows its front, side or top face instead.
 */
export async function itemIcons(cacheDir: string, version: string, ids: string[]): Promise<Record<string, string | null>> {
    const jar = await clientJar(cacheDir, version);
    const entries = new Set(await zipEntries(jar));
    const out: Record<string, string | null> = {};
    for (const id of new Set(ids)) {
        const key = `${version} ${id}`;
        if (!icons.has(key)) {
            const name = id.slice(id.indexOf(":") + 1);
            const path = [`item/${name}`, `block/${name}`, `block/${name}_front`, `block/${name}_side`, `block/${name}_top`]
                .map((p) => `assets/minecraft/textures/${p}.png`)
                .find((p) => entries.has(p));
            icons.set(key, path ? `data:image/png;base64,${(await readEntryBytes(jar, path)).toString("base64")}` : null);
        }
        out[id] = icons.get(key) ?? null;
    }
    return out;
}
