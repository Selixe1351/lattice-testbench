import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readEntryBytes, zipEntries } from "./jar";
import { fetchCached } from "./sources";

/**
 * Java for people who have none: the newest Eclipse Temurin 25 JDK, from Adoptium's API, checked against the
 * checksum it publishes. Unpacked into the app's cache, so it never touches the system or PATH.
 */

const API = "https://api.adoptium.net/v3/assets/latest/25/hotspot?os=windows&architecture=x64&image_type=jdk&vendor=eclipse";

interface Asset {
    release_name: string;
    binary: { package: { link: string; name: string; checksum: string } };
}

/** java.exe of the newest Temurin 25, downloading and unpacking it the first time. */
export async function installJava(cacheDir: string): Promise<string> {
    if (process.platform !== "win32") throw new Error("Java is only downloaded for you on Windows. Install JDK 25 and pick its java.");
    const response = await fetch(API, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Adoptium answered ${response.status}.`);
    const [asset] = (await response.json()) as Asset[];
    if (!asset) throw new Error("Adoptium lists no Java 25 build for Windows.");

    const home = join(cacheDir, "tools", asset.release_name);
    const java = join(home, "bin", "java.exe");
    if (existsSync(java)) return java;

    const { link, name, checksum } = asset.binary.package;
    const archive = await fetchCached(join(cacheDir, "tools"), { url: link, fileName: name, sha256: checksum });
    // Unpacked beside and renamed, so a half-unpacked JDK is never taken for a whole one.
    const partial = `${home}.part`;
    await rm(partial, { recursive: true, force: true });
    const top = `${asset.release_name}/`;
    for (const entry of await zipEntries(archive)) {
        if (entry.endsWith("/") || !entry.startsWith(top)) continue;
        const target = join(partial, entry.slice(top.length));
        // Entry names come from a checked download, but a path that climbs out is refused all the same.
        if (!target.startsWith(partial)) throw new Error(`${name} has an entry outside its folder: ${entry}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readEntryBytes(archive, entry));
    }
    await rename(partial, home);
    if (!existsSync(java)) throw new Error(`${name} has no bin/java.exe.`);
    return java;
}
