import type { ExtensionManifest, ExtensionValue } from "@shared/extensions";
import type { ConsoleLine, DeployRequest, PlayerInfo, ServerView } from "@shared/types";
import type { HookKind, HookMap, ProcessPlan, ToolDef } from "./hooks";

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

export interface ExtensionContext {
    readonly id: string;
    /** A folder of its own that outlives the app, for state. */
    readonly dataDir: string;
    /** The app's download cache. */
    readonly cacheDir: string;
    readonly servers: ServerApi;
    readonly settings: {
        get<T extends ExtensionValue = string>(key: string): T | undefined;
        all(): Record<string, ExtensionValue>;
        /** Saves a value, e.g. a token generated on first use. */
        set(key: string, value: ExtensionValue): Promise<void>;
        /** Runs after the person saves this extension's settings. */
        onChange(fn: () => void | Promise<void>): void;
    };
    hook<K extends HookKind>(kind: K, fn: HookMap[K]): void;
    /** A call the window can make: `window.testbench.extension(id, channel, ...args)`. */
    handle(channel: string, fn: (...args: any[]) => unknown): void;
    /** What a button from the manifest's `actions` does. */
    action(id: string, fn: (serverId: string) => unknown): void;
    /** Offers an AI agent a tool. Served by the MCP extension when it is enabled. */
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

export interface Extension {
    manifest: ExtensionManifest;
    activate(ctx: ExtensionContext): void | Promise<void>;
}
