import type { HookKind, HookMap, ToolDef } from "@shared/extension-api";

export type { DeployContext, HookKind, HookMap, PrepareContext, ProcessPlan, ToolDef, ToolField } from "@shared/extension-api";

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
