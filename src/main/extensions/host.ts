import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EXTENSION_API, type ExtensionManifest, type ExtensionValue, type ExtensionView } from "@shared/extensions";
import type { Settings } from "@shared/types";
import type { Hooks, HookKind, HookMap, Tools } from "./hooks";
import type { Extension, ExtensionContext, ServerApi } from "./types";

/** The app, as the host needs it. Injected so the host can be tested without Electron. */
export interface HostEnv {
    settings(): Settings;
    saveSettings(settings: Settings): Promise<void>;
    servers: ServerApi;
    hooks: Hooks;
    tools: Tools;
    /** Where user extensions live: one folder each, with an extension.json. */
    userDir: string;
    dataDir: string;
    cacheDir: string;
    handle(channel: string, fn: (...args: any[]) => unknown): void;
    unhandle(channel: string): void;
    send(channel: string, payload: unknown): void;
}

interface Running {
    disposers: (() => void | Promise<void>)[];
    actions: Map<string, (serverId: string) => unknown>;
    changed: (() => void | Promise<void>)[];
    status?: string;
}

interface Known {
    extension: Extension;
    builtin: boolean;
    running?: Running;
    /** Why it is not running although it should be: a bad folder, or an activate that threw. */
    error?: string;
}

const ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Owns every extension. The rule is the one Lattice's kernel keeps for modules: an extension is fully enabled or
 * not running. If `activate` throws, everything it registered so far is released and it is left off with the
 * error shown; there is no half-enabled state that keeps serving hooks.
 */
export class ExtensionHost {
    private readonly known = new Map<string, Known>();

    constructor(private readonly env: HostEnv) {}

    register(extension: Extension, builtin: boolean): void {
        const { id } = extension.manifest;
        if (!ID.test(id)) throw new Error(`Extension id "${id}" must be lowercase letters, digits and dashes.`);
        if (this.known.has(id)) throw new Error(`Two extensions are called "${id}".`);
        if (extension.manifest.api !== EXTENSION_API) {
            throw new Error(`${id} was written for extension api ${extension.manifest.api}; this app speaks ${EXTENSION_API}.`);
        }
        this.known.set(id, { extension, builtin });
    }

    /** Reads every folder under the user directory. A bad one is shown with its reason and never stops the rest. */
    async discover(): Promise<void> {
        if (!existsSync(this.env.userDir)) return;
        for (const entry of await readdir(this.env.userDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                this.register(await loadUserExtension(join(this.env.userDir, entry.name)), false);
            } catch (error) {
                console.warn(`Skipped extension ${entry.name}: ${(error as Error).message}`);
                const id = `broken-${entry.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 32);
                this.known.set(id, {
                    builtin: false,
                    error: (error as Error).message,
                    extension: { manifest: { id, name: entry.name, description: "Could not be loaded.", version: "-", api: EXTENSION_API }, activate() {} },
                });
            }
        }
    }

    /** Enables every extension the settings say is on. One failing does not stop the others. */
    async start(): Promise<void> {
        for (const [id, known] of this.known) {
            if (known.error || !this.stored(id).enabled) continue;
            await this.activate(id).catch((error: Error) => console.warn(`Extension ${id} did not start: ${error.message}`));
        }
        this.push();
    }

    async stop(): Promise<void> {
        for (const id of [...this.known.keys()]) await this.deactivate(id);
    }

    list(): ExtensionView[] {
        return [...this.known.entries()].map(([id, known]) => this.view(id, known));
    }

    private view(id: string, known: Known): ExtensionView {
        const manifest = known.extension.manifest;
        const values: ExtensionView["values"] = {};
        const all = this.values(id);
        for (const field of manifest.settings ?? []) {
            const value = all[field.key];
            if (value === undefined || value === "") continue;
            values[field.key] = field.type === "secret" ? true : value;
        }
        return {
            manifest,
            builtin: known.builtin,
            enabled: known.running !== undefined,
            values,
            ...(known.error ? { error: known.error } : {}),
            ...(known.running?.status ? { status: known.running.status } : {}),
        };
    }

    private stored(id: string): { enabled: boolean; values: Record<string, ExtensionValue> } {
        const entry = this.env.settings().extensions[id];
        return { enabled: entry?.enabled ?? false, values: entry?.values ?? {} };
    }

    /** An extension's setting values with defaults filled in, secrets included. For its own use only. */
    values(id: string): Record<string, ExtensionValue> {
        const manifest = this.known.get(id)?.extension.manifest;
        const stored = this.stored(id).values;
        const out: Record<string, ExtensionValue> = {};
        for (const field of manifest?.settings ?? []) {
            const value = stored[field.key] ?? field.default;
            if (value !== undefined) out[field.key] = value;
        }
        return out;
    }

    /** Deploy options for [id] from a request, with the manifest defaults filled in. */
    deployOptions(id: string, request: { extensions?: Record<string, Record<string, unknown>> }): Record<string, unknown> {
        const given = request.extensions?.[id] ?? {};
        const out: Record<string, unknown> = {};
        for (const field of this.known.get(id)?.extension.manifest.deploy ?? []) {
            const value = given[field.key] ?? field.default;
            if (value !== undefined) out[field.key] = value;
        }
        return out;
    }

    isEnabled(id: string): boolean {
        return this.known.get(id)?.running !== undefined;
    }

    /** The secret setting keys of [id], so the settings file can seal them. */
    secretKeys(id: string): string[] {
        return (this.known.get(id)?.extension.manifest.settings ?? []).filter((f) => f.type === "secret").map((f) => f.key);
    }

    async setEnabled(id: string, enabled: boolean): Promise<ExtensionView[]> {
        const known = this.require(id);
        const settings = this.env.settings();
        const previous = settings.extensions[id] ?? { enabled: false, values: {} };
        if (enabled) {
            try {
                await this.activate(id);
            } catch (error) {
                // Left off, with the reason on its card. Not saved as enabled, so it does not retry on every start.
                this.push();
                throw error;
            }
        } else {
            await this.deactivate(id);
            known.error = undefined;
        }
        settings.extensions[id] = { ...previous, enabled };
        await this.env.saveSettings(settings);
        this.push();
        return this.list();
    }

    /** Saves [values] for [id]; a secret the window sends back as `true` is unchanged. */
    async saveValues(id: string, values: Record<string, ExtensionValue | true>): Promise<ExtensionView[]> {
        const known = this.require(id);
        const settings = this.env.settings();
        const previous = settings.extensions[id] ?? { enabled: false, values: {} };
        const next: Record<string, ExtensionValue> = {};
        for (const field of known.extension.manifest.settings ?? []) {
            const given = values[field.key];
            if (given === undefined) continue;
            if (given === true) {
                if (field.type === "secret" && previous.values[field.key] !== undefined) next[field.key] = previous.values[field.key];
            } else {
                next[field.key] = given;
            }
        }
        settings.extensions[id] = { ...previous, values: next };
        await this.env.saveSettings(settings);
        for (const fn of known.running?.changed ?? []) {
            try {
                await fn();
            } catch (error) {
                console.warn(`${id} could not apply its new settings`, error);
                if (known.running) known.running.status = `Could not apply settings: ${(error as Error).message}`;
            }
        }
        this.push();
        return this.list();
    }

    async runAction(id: string, action: string, serverId: string): Promise<void> {
        const run = this.known.get(id)?.running?.actions.get(action);
        if (!run) throw new Error(`${id} is not enabled.`);
        await run(serverId);
    }

    private require(id: string): Known {
        const known = this.known.get(id);
        if (!known) throw new Error(`No extension called ${id}.`);
        if (known.error && !known.running && id.startsWith("broken-")) throw new Error(known.error);
        return known;
    }

    private push(): void {
        this.env.send("extensions", this.list());
    }

    private async activate(id: string): Promise<void> {
        const known = this.require(id);
        if (known.running) return;
        const running: Running = { disposers: [], actions: new Map(), changed: [] };
        try {
            await known.extension.activate(this.contextFor(id, known.extension.manifest, running));
        } catch (error) {
            // Fully enabled or not running: whatever it registered before failing is released again.
            await release(id, running);
            known.error = `Could not start: ${(error as Error).message}`;
            throw error;
        }
        known.running = running;
        known.error = undefined;
    }

    private async deactivate(id: string): Promise<void> {
        const known = this.known.get(id);
        if (!known?.running) return;
        const running = known.running;
        known.running = undefined;
        await release(id, running);
    }

    private contextFor(id: string, manifest: ExtensionManifest, running: Running): ExtensionContext {
        const { env } = this;
        const prefix = `ext:${id}:`;
        return {
            id,
            dataDir: join(env.dataDir, "extensions", id),
            cacheDir: env.cacheDir,
            servers: this.serversFor(running),
            settings: {
                get: <T extends ExtensionValue = string>(key: string) => this.values(id)[key] as T | undefined,
                all: () => this.values(id),
                set: async (key, value) => {
                    const settings = env.settings();
                    const previous = settings.extensions[id] ?? { enabled: true, values: {} };
                    settings.extensions[id] = { ...previous, values: { ...previous.values, [key]: value } };
                    await env.saveSettings(settings);
                },
                onChange: (fn) => void running.changed.push(fn),
            },
            hook: <K extends HookKind>(kind: K, fn: HookMap[K]) => {
                // Deploy and prepare hooks get this extension's options for the request being deployed.
                const wrapped = (kind === "deploy" || kind === "prepare"
                    ? (context: Parameters<HookMap["deploy"]>[0]) => (fn as HookMap["deploy"])({ ...context, options: this.deployOptions(id, context.request) })
                    : fn) as HookMap[K];
                running.disposers.push(env.hooks.add(kind, id, wrapped));
            },
            agentTools: () => env.tools.list(),
            tool: (def) => void running.disposers.push(env.tools.add(id, def)),
            handle: (channel, fn) => {
                env.handle(prefix + channel, fn);
                running.disposers.push(() => env.unhandle(prefix + channel));
            },
            action: (action, fn) => {
                if (!(manifest.actions ?? []).some((a) => a.id === action)) {
                    throw new Error(`${id} uses an action called "${action}" that its manifest does not declare.`);
                }
                running.actions.set(action, fn);
            },
            send: (channel, payload) => env.send(prefix + channel, payload),
            status: (text) => {
                running.status = text;
                this.push();
            },
            dispose: (fn) => void running.disposers.push(fn),
            log: (text) => console.info(`[${id}] ${text}`),
        };
    }

    private serversFor(running: Running): ServerApi {
        const base = this.env.servers as ServerApi & { off(event: string, fn: unknown): void };
        const listeners: [string, (...args: any[]) => void][] = [];
        // Listeners go with the extension: a disabled one must not keep seeing console lines.
        running.disposers.push(() => {
            for (const [event, fn] of listeners) base.off(event, fn);
        });
        return new Proxy(base, {
            get(target, property) {
                if (property === "on") {
                    return (event: string, fn: (...args: any[]) => void) => {
                        listeners.push([event, fn]);
                        (target as unknown as { on(e: string, f: unknown): void }).on(event, fn);
                    };
                }
                const value = Reflect.get(target, property) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }
}

async function release(id: string, running: Running): Promise<void> {
    for (const dispose of [...running.disposers].reverse()) {
        try {
            await dispose();
        } catch (error) {
            console.warn(`${id} failed while being disabled`, error);
        }
    }
    running.disposers.length = 0;
}

/** Reads and checks one user extension folder: extension.json first; its code is loaded only when enabled. */
async function loadUserExtension(dir: string): Promise<Extension> {
    const file = join(dir, "extension.json");
    if (!existsSync(file)) throw new Error("no extension.json");
    const manifest = JSON.parse(await readFile(file, "utf8")) as ExtensionManifest;
    for (const key of ["id", "name", "description", "version"] as const) {
        if (typeof manifest[key] !== "string" || !manifest[key]) throw new Error(`extension.json needs a "${key}"`);
    }
    if (!manifest.main) throw new Error('extension.json needs a "main" file');
    const main = join(dir, manifest.main);
    if (!existsSync(main)) throw new Error(`main file ${manifest.main} is missing`);
    return {
        manifest,
        activate(ctx) {
            const loaded = createRequire(main)(main) as { activate?: Extension["activate"]; default?: { activate?: Extension["activate"] } };
            const activate = loaded.activate ?? loaded.default?.activate;
            if (typeof activate !== "function") throw new Error(`${manifest.main} does not export activate(ctx)`);
            return activate(ctx);
        },
    };
}
