import type { DeployRequest, Software } from "@shared/types";

/** One process a deploy is about to create: the single server, the proxy, or a backend. */
export interface ProcessPlan {
    name: string;
    dir: string;
    port: number;
    role: "game" | "proxy";
    software: Software;
    /** Minecraft version of a game server; the newest Velocity for a proxy. */
    version: string;
}

export interface DeployContext {
    serverId: string;
    request: DeployRequest;
    /** This extension's deploy options, with the manifest defaults filled in. */
    options: Record<string, unknown>;
    log(text: string): void;
    cacheDir: string;
}

export interface PrepareContext extends DeployContext {
    proc: ProcessPlan;
    /** Every process of this server, this one included. */
    procs: ProcessPlan[];
}

/** The points where an extension can take part. Each runs for enabled extensions only. */
export interface HookMap {
    /** Once per deploy, before anything is downloaded. Throw to refuse the deploy, e.g. a missing setting. */
    deploy: (ctx: DeployContext) => Promise<void> | void;
    /** For each process, after the core wrote its files and before it starts. */
    prepare: (ctx: PrepareContext) => Promise<void> | void;
    /** Extra environment for a process, on every start. */
    env: (serverId: string, proc: ProcessPlan) => Record<string, string> | undefined;
    /** Before a server is stopped and deleted. Failures are logged and the delete goes on. */
    destroy: (serverId: string) => Promise<void> | void;
    /** Once the app is ready, and when it quits. */
    appStart: () => Promise<void> | void;
    appQuit: () => Promise<void> | void;
}

export type HookKind = keyof HookMap;

interface Entry<K extends HookKind> {
    extension: string;
    fn: HookMap[K];
}

/** The registry the core runs hooks from. An extension adds through its context, which removes them on disable. */
export class Hooks {
    private readonly entries: { [K in HookKind]: Entry<K>[] } = { deploy: [], prepare: [], env: [], destroy: [], appStart: [], appQuit: [] };

    add<K extends HookKind>(kind: K, extension: string, fn: HookMap[K]): () => void {
        const list = this.entries[kind] as Entry<K>[];
        const entry: Entry<K> = { extension, fn };
        list.push(entry);
        return () => {
            const at = list.indexOf(entry);
            if (at >= 0) list.splice(at, 1);
        };
    }

    of<K extends HookKind>(kind: K): readonly Entry<K>[] {
        return [...(this.entries[kind] as Entry<K>[])];
    }
}

/** An input of an agent tool, in the few shapes an agent can be asked for. */
export interface ToolField {
    type: "string" | "number" | "boolean" | "string[]";
    description: string;
    optional?: boolean;
}

/** Something an AI agent can call. Any extension may add one; the MCP extension is what serves them. */
export interface ToolDef {
    name: string;
    description: string;
    input: Record<string, ToolField>;
    run(args: Record<string, any>): Promise<unknown> | unknown;
}

export class Tools {
    private readonly tools: { extension: string; def: ToolDef }[] = [];

    add(extension: string, def: ToolDef): () => void {
        if (this.tools.some((t) => t.def.name === def.name)) throw new Error(`Two extensions offer a tool called ${def.name}.`);
        const entry = { extension, def };
        this.tools.push(entry);
        return () => {
            const at = this.tools.indexOf(entry);
            if (at >= 0) this.tools.splice(at, 1);
        };
    }

    list(): readonly ToolDef[] {
        return this.tools.map((t) => t.def);
    }
}
