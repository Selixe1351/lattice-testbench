import { basename } from "node:path";
import type { DeployRequest, Software, WorldKind } from "@shared/types";
import { readEntryBytes, zipEntries } from "./jar";
import { ownPlugin } from "./sources";

/**
 * Reads a server zip back into a deploy request. An export carries its request in [MANIFEST]; a zip without one
 * (exported before it did, or zipped by hand from a server folder) has the request worked out from the files a
 * deploy wrote, which is why every guess below names the file it reads.
 */

/** Written into every export beside the server's files: the request the server was deployed from. */
export const MANIFEST = "testbench.json";

export interface Manifest {
    name: string;
    request: DeployRequest;
}

export interface ImportedServer extends Manifest {
    /** Entry names of the person's own plugin jars, which the request must point at once they are copied out. */
    plugins: string[];
}


const PLUGIN_JAR = /^(?:(?:proxy|backend-\d+)\/)?plugins\/([^/]+\.jar)$/;

export async function readServerZip(zip: string): Promise<ImportedServer> {
    const names = await zipEntries(zip);
    const text = async (name: string) => (names.includes(name) ? (await readEntryBytes(zip, name)).toString("utf8") : null);

    // The jars Testbench adds itself come back on every deploy; only the person's own are carried over.
    const seen = new Set<string>();
    const plugins = names.filter((name) => {
        const file = PLUGIN_JAR.exec(name)?.[1];
        if (!file || ownPlugin(file) || seen.has(file)) return false;
        seen.add(file);
        return true;
    });

    const manifest = await text(MANIFEST);
    if (manifest) {
        const parsed = JSON.parse(manifest) as Manifest;
        if (!parsed.request?.software || !parsed.request.version) throw new Error(`${MANIFEST} in ${basename(zip)} has no deploy request.`);
        return { name: parsed.name || basename(zip, ".zip"), request: parsed.request, plugins };
    }
    return { name: basename(zip, ".zip"), request: await infer(zip, names, text), plugins };
}

async function infer(zip: string, names: string[], text: (name: string) => Promise<string | null>): Promise<DeployRequest> {
    const network = names.some((n) => n.startsWith("proxy/"));
    const backends = new Set(names.map((n) => /^backend-(\d+)\//.exec(n)?.[1]).filter(Boolean)).size;
    const game = network ? "backend-1/" : "";
    if (network && backends === 0) throw new Error(`${basename(zip)} has a proxy but no backend-1 folder.`);

    // Paperclip unpacks the real server as versions/<mc>/<software>-<mc>.jar on first start.
    let software: Exclude<Software, "velocity"> | null = null;
    let version: string | null = null;
    for (const name of names) {
        const match = new RegExp(`^${game}versions/([^/]+)/(paper|folia|purpur)-[^/]+\\.jar$`).exec(name);
        if (match) [version, software] = [match[1], match[2] as Exclude<Software, "velocity">];
    }
    if (!version) {
        const history = await text(`${game}version_history.json`);
        version = history ? /MC: ([\d.]+)/.exec(history)?.[1] ?? null : null;
        software = history && /folia/i.test(history) ? "folia" : history && /purpur/i.test(history) ? "purpur" : "paper";
    }
    if (!version) throw new Error(`Cannot tell which Minecraft version ${basename(zip)} ran: it has no ${game}versions folder or version_history.json. Start the server once before exporting it.`);

    const properties = (await text(`${game}server.properties`)) ?? "";
    const onlineMode = network
        ? /^\s*online-mode\s*=\s*true/m.test((await text("proxy/velocity.toml")) ?? "")
        : /^online-mode=true$/m.test(properties);
    const world: WorldKind = !/^level-type=minecraft\\?:flat$/m.test(properties) ? "normal" : /the_void/.test(properties) ? "void" : "flat";

    return {
        software: network ? "velocity" : software!,
        version,
        ...(network ? { backendSoftware: software!, backends } : {}),
        onlineMode,
        world,
    };
}
