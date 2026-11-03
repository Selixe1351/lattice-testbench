import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Settings } from "@shared/types";

/** Where the app keeps its settings, download cache and live servers. */
export interface Paths {
    root: string;
    settings: string;
    cache: string;
    servers: string;
    /** One folder per extension the person added. */
    extensions: string;
}

export function paths(root: string): Paths {
    return { root, settings: join(root, "settings.json"), cache: join(root, "cache"), servers: join(root, "servers"), extensions: join(root, "extensions") };
}

/** Encrypts with the OS's own store (DPAPI on Windows), so the file alone does not give the secrets away. */
export interface Vault {
    encrypt(text: string): string;
    decrypt(sealed: string): string;
}

/**
 * Loads settings. Secret extension settings are sealed on disk under `sealed["<extension>.<key>"]` and put back
 * into `extensions[<extension>].values` here, so the rest of the app never sees the difference.
 */
export async function loadSettings(file: string, vault: Vault | null = null): Promise<Settings> {
    const defaults = defaultSettings();
    if (!existsSync(file)) return defaults;
    try {
        const stored = JSON.parse(await readFile(file, "utf8")) as Partial<Settings> & { sealed?: Record<string, string> };
        const { sealed = {}, ...plain } = stored;
        const settings: Settings = { ...defaults, ...plain, extensions: { ...(plain.extensions ?? {}) } };
        for (const [path, value] of Object.entries(sealed)) {
            const dot = path.indexOf(".");
            // Secrets sealed by the old app (licenseKey, cloudflareToken...) have no extension in front; they are not ours.
            if (dot < 0) continue;
            const id = path.slice(0, dot);
            const key = path.slice(dot + 1);
            const entry = settings.extensions[id] ?? { enabled: false, values: {} };
            try {
                settings.extensions[id] = { ...entry, values: { ...entry.values, [key]: vault ? vault.decrypt(value) : "" } };
            } catch (error) {
                // Sealed by another Windows account or machine: this one cannot read it, so it is asked for again.
                console.warn(`Could not unseal ${path}; it has to be entered again`, error);
            }
        }
        return settings;
    } catch (error) {
        // A hand-edited file that no longer parses: start from defaults rather than refuse to open.
        console.warn(`Could not read ${file}, using defaults`, error);
        return defaults;
    }
}

/**
 * Writes settings. [secretKeys] says which settings of an extension are secrets, so they are sealed with the OS
 * store (DPAPI on Windows) and the file alone does not give them away. Without a vault they are written as they are.
 */
export async function saveSettings(file: string, settings: Settings, vault: Vault | null, secretKeys: (extension: string) => string[]): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const sealed: Record<string, string> = {};
    const extensions: Settings["extensions"] = {};
    for (const [id, entry] of Object.entries(settings.extensions)) {
        const values = { ...entry.values };
        for (const key of secretKeys(id)) {
            const value = values[key];
            if (typeof value !== "string" || !value || !vault) continue;
            sealed[`${id}.${key}`] = vault.encrypt(value);
            delete values[key];
        }
        extensions[id] = { ...entry, values };
    }
    await writeFile(file, JSON.stringify({ ...settings, extensions, sealed }, null, 2));
}

function defaultSettings(): Settings {
    return { javaPath: findJava() ?? "", memoryMb: 2048, basePort: 25600, operators: [], extensions: {} };
}

/**
 * The newest JDK among JAVA_HOME and the usual install folders. Newest, not JAVA_HOME first: Lattice and
 * Minecraft 26 need Java 25, and JAVA_HOME often still points at an older one kept for other projects.
 */
function findJava(): string | null {
    const candidates: string[] = [];
    const home = process.env.JAVA_HOME;
    if (home && existsSync(join(home, "bin", "java.exe"))) candidates.push(join(home, "bin", "java.exe"));
    for (const base of ["C:/Program Files/Java", "C:/Program Files/Eclipse Adoptium", "C:/Program Files/Zulu"]) {
        if (!existsSync(base)) continue;
        for (const name of readdirSync(base)) {
            if (existsSync(join(base, name, "bin", "java.exe"))) candidates.push(join(base, name, "bin", "java.exe"));
        }
    }
    const version = (path: string) => Number(/(?:jdk|jre)[-_]?(\d+)/i.exec(path)?.[1] ?? 0);
    return candidates.sort((a, b) => version(b) - version(a) || b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
}
