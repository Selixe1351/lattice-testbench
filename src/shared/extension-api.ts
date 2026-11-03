/**
 * The extension API: everything an extension's code sees. This file and the files it imports from this folder are
 * the whole public surface, and they import nothing from Electron or Node, so the same declarations are published
 * to extension authors (see packages/extension-api).
 *
 * Types follow the manifest. Declare an extension with {@link defineExtension} and its manifest, and
 * `ctx.settings.get("port")` is a `number`, a deploy hook's `options.modules` is a `string[]`, and
 * `ctx.action("sya", ...)` is an error when the manifest has no action called "sya".
 */
import type {
    ExtensionManifest, ExtensionValue, Field, FieldType, ServerAction,
} from "./extensions";
import type { ConsoleLine, DeployRequest, PlayerInfo, ServerView, Software } from "./types";

export type { ExtensionManifest, ExtensionValue, Field, FieldType, ServerAction };
export type { ConsoleLine, DeployRequest, PlayerInfo, ServerView, Software };

// ------------------------------------------------------------ typed manifests --

/** What a field's value is in code: its type, narrowed by `options` for a select. */
export type FieldValue<F> =
    F extends { type: "number" } ? number
    : F extends { type: "boolean" } ? boolean
    : F extends { type: "files" } ? string[]
    : F extends { type: "select"; options: readonly { value: infer V }[] } ? V
    : string;

type KeyOf<F> = F extends { key: infer K extends string } ? K : never;

/** The values of a list of fields by key. A field with a `default` is always there; one without may be unset. */
export type ValuesOf<F extends Field> = {
    [X in F as KeyOf<X>]: X extends { default: ExtensionValue } ? FieldValue<X> : FieldValue<X> | undefined;
};

/** True for the wide manifest type, which a JavaScript extension or the app's own registry uses: nothing to narrow by. */
type Loose<M extends ExtensionManifest> = ExtensionManifest extends M ? true : false;
type SettingFields<M> = M extends { settings: readonly (infer F)[] } ? F : never;
type DeployFields<M> = M extends { deploy: readonly (infer F)[] } ? F : never;
type ValuesOfFields<F> = [F] extends [never] ? Record<never, never> : ValuesOf<Extract<F, Field>>;

/** The manifest's `settings`, as `ctx.settings.get` returns them. */
export type SettingsOf<M extends ExtensionManifest> = Loose<M> extends true
    ? Record<string, ExtensionValue | undefined>
    : ValuesOfFields<SettingFields<M>>;
/** The manifest's `deploy` fields, as a hook's `options` holds them. */
export type DeployOptionsOf<M extends ExtensionManifest> = Loose<M> extends true
    ? Record<string, unknown>
    : ValuesOfFields<DeployFields<M>>;
/** The ids of the manifest's `actions`. */
export type ActionIdOf<M extends ExtensionManifest> = Loose<M> extends true
    ? string
    : M extends { actions: readonly (infer A extends { id: string })[] } ? A["id"] : never;

// ------------------------------------------------------------------- servers --

/** One process a deploy is about to create: the single server, the proxy, or a backend. */
export interface ProcessPlan {
    name: string;
    dir: string;
    port: number;
    role: "game" | "proxy";
    software: Software;
    /** Minecraft version of a game server; empty for a proxy. */
    version: string;
}

/** A process of a running server, as an extension may see it. */
export interface ProcessInfo extends ProcessPlan {
    state: "preparing" | "starting" | "running" | "stopping" | "stopped" | "failed";
}

/** The parts of a view an extension may change; everything else is the core's. */
export type ViewPatch = Partial<Pick<ServerView, "publicAddress" | "modules" | "moduleStatus" | "plugins" | "uses">>;

export interface ServerEvents {
    console: (line: ConsoleLine) => void;
    servers: (list: ServerView[]) => void;
    /** A player joined or left the server's entrance. */
    player: (event: { view: ServerView; name: string; joined: boolean }) => void;
    /** Expiry is five minutes away. */
    expiring: (view: ServerView) => void;
}

/** What the servers look like from inside an extension. Listeners added through it go when the extension is disabled. */
export interface ServerApi {
    list(): ServerView[];
    get(id: string): ServerView | undefined;
    /** The folder a server's files live in. */
    dir(id: string): string;
    processes(id: string): ProcessInfo[];
    command(id: string, process: string, line: string): void;
    /**
     * Sends [commands] without echoing them and returns the console lines that match [pattern], taken out of the
     * console. Queries on one process queue, so replies never mix.
     */
    query(id: string, process: string, commands: string[], pattern: RegExp, options?: { count?: number; maxMs?: number }): Promise<string[]>;
    update(id: string, patch: ViewPatch): void;
    /** What a person can do from the server page, for extensions that drive servers (agents, scripts). */
    deploy(request: DeployRequest): string;
    history(id: string): ConsoleLine[];
    start(id: string): void;
    stop(id: string): Promise<void>;
    restart(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
    keep(id: string, kept: boolean): void;
    placeholder(id: string, process: string, player: string | null, text: string): Promise<string>;
    playerInfo(id: string, player: string): Promise<PlayerInfo>;
    /** Resolves with the next console line of [id] that [match] accepts, or null after [ms]. */
    waitFor(id: string, match: (line: ConsoleLine) => boolean, ms: number): Promise<ConsoleLine | null>;
    log(id: string, process: string, text: string, stream?: ConsoleLine["stream"]): void;
    on<K extends keyof ServerEvents>(event: K, fn: ServerEvents[K]): void;
}

// --------------------------------------------------------------------- hooks --

export interface DeployContext<O = Record<string, unknown>> {
    serverId: string;
    request: DeployRequest;
    /** This extension's deploy options, with the manifest defaults filled in. */
    options: O;
    log(text: string): void;
    cacheDir: string;
}

export interface PrepareContext<O = Record<string, unknown>> extends DeployContext<O> {
    proc: ProcessPlan;
    /** Every process of this server, this one included. */
    procs: ProcessPlan[];
}

/** The points where an extension can take part, with its deploy options typed as [O]. Each runs while the extension is on. */
export interface HookMapOf<O = Record<string, unknown>> {
    /** Once per deploy, before anything is downloaded. Throw to refuse the deploy, e.g. a missing setting. */
    deploy: (ctx: DeployContext<O>) => Promise<void> | void;
    /** For each process, after the core wrote its files and before it starts. */
    prepare: (ctx: PrepareContext<O>) => Promise<void> | void;
    /** Extra environment for a process, on every start. */
    env: (serverId: string, proc: ProcessPlan) => Record<string, string> | undefined;
    /** Before a server is stopped and deleted. Failures are logged and the delete goes on. */
    destroy: (serverId: string) => Promise<void> | void;
    /** Once the app is ready, and when it quits. */
    appStart: () => Promise<void> | void;
    appQuit: () => Promise<void> | void;
}

export type HookMap = HookMapOf;
export type HookKind = keyof HookMap;

/** An input of an agent tool, in the few shapes an agent can be asked for. */
export interface ToolField {
    type: "string" | "number" | "boolean" | "string[]";
    description: string;
    optional?: boolean;
}

/** Something an AI agent can call. Any extension may add one; the AI agents extension is what serves them. */
export interface ToolDef {
    name: string;
    description: string;
    input: Record<string, ToolField>;
    run(args: Record<string, any>): Promise<unknown> | unknown;
}

// ----------------------------------------------------------------- the context --

export interface ExtensionContext<M extends ExtensionManifest = ExtensionManifest> {
    readonly id: string;
    /** A folder of its own that outlives the app, for state. */
    readonly dataDir: string;
    /** The app's download cache. */
    readonly cacheDir: string;
    readonly servers: ServerApi;
    readonly settings: {
        get<K extends keyof SettingsOf<M> & string>(key: K): SettingsOf<M>[K];
        all(): Partial<SettingsOf<M>>;
        /** Saves a value, e.g. a token generated on first use. */
        set<K extends keyof SettingsOf<M> & string>(key: K, value: NonNullable<SettingsOf<M>[K]>): Promise<void>;
        /** Runs after the person saves this extension's settings. */
        onChange(fn: () => void | Promise<void>): void;
    };
    hook<K extends HookKind>(kind: K, fn: HookMapOf<DeployOptionsOf<M>>[K]): void;
    /** A call the window can make: `window.testbench.extension(id, channel, ...args)`. */
    handle(channel: string, fn: (...args: any[]) => unknown): void;
    /** What a button from the manifest's `actions` does. */
    action(id: ActionIdOf<M>, fn: (serverId: string) => unknown): void;
    /** Offers an AI agent a tool. Served by the AI agents extension when it is enabled. */
    tool(def: ToolDef): void;
    /** Every tool extensions offer agents right now. For the extension that serves them. */
    agentTools(): readonly ToolDef[];
    /** Pushes data to the window. */
    send(channel: string, payload: unknown): void;
    /** A short line shown on the Extensions page, e.g. an address. */
    status(text: string | undefined): void;
    /** Runs when the extension is disabled, after everything else it registered is gone. Latest first. */
    dispose(fn: () => void | Promise<void>): void;
    log(text: string): void;
}

/** An extension as the app holds it. Write one with {@link defineExtension}. */
export interface Extension {
    manifest: ExtensionManifest;
    activate(ctx: ExtensionContext): void | Promise<void>;
}

/**
 * Declares an extension. The manifest is read as a literal, so everything after it is typed from it: settings,
 * deploy options and action ids. In a TypeScript file write the manifest inline here; JavaScript gets the same
 * through `// @ts-check` and JSDoc.
 */
export function defineExtension<const M extends ExtensionManifest>(extension: {
    manifest: M;
    activate(ctx: ExtensionContext<M>): void | Promise<void>;
}): Extension {
    // The typed context is the loose one at run time; the types only narrow what the manifest already promises.
    return extension as unknown as Extension;
}
