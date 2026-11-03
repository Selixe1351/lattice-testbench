import { useEffect, useState } from "react";
import type { BotAction, BotEvent, BotView } from "@shared/bots";
import type { ExtensionView } from "@shared/extensions";
import type { DataChange, DataDocument, DataSource, LatticeInfo } from "@shared/lattice";
import type { ServerView } from "@shared/types";

const api = window.testbench;

/** Every extension and whether it runs, kept current: the window reacts when one is turned on or off. */
export function useExtensions(): ExtensionView[] {
    const [list, setList] = useState<ExtensionView[]>([]);
    useEffect(() => {
        void api.extensions().then(setList);
        return api.onExtensions(setList);
    }, []);
    return list;
}

export const isOn = (list: ExtensionView[], id: string): boolean => list.some((e) => e.manifest.id === id && e.enabled);

/** The built-in Bots extension's calls. */
export const botsApi = {
    list: (serverId: string) => api.extension<BotView[]>("bots", "list", serverId),
    summon: (serverId: string, count: number, prefix: string) => api.extension<void>("bots", "summon", serverId, count, prefix),
    act: (serverId: string, names: string[], action: BotAction) => api.extension<void>("bots", "act", serverId, names, action),
    onBots: (listener: (bots: BotView[]) => void) => api.onExtensionEvent<BotView[]>("bots", "bots", listener),
    onEvent: (listener: (event: BotEvent) => void) => api.onExtensionEvent<BotEvent>("bots", "event", listener),
};

/** The built-in Lattice extension's calls. */
export const latticeApi = {
    info: (serverId: string, process: string) => api.extension<LatticeInfo>("lattice", "info", serverId, process),
    modules: (serverId: string, process: string) => api.extension<Pick<LatticeInfo, "modules" | "peers">>("lattice", "modules", serverId, process),
    sources: (serverId: string) => api.extension<DataSource[]>("lattice", "sources", serverId),
    documents: (serverId: string, process: string, collection: string, limit: number) =>
        api.extension<DataDocument[]>("lattice", "documents", serverId, process, collection, limit),
    mark: (serverId: string) => api.extension<{ at: number; documents: number }>("lattice", "mark", serverId),
    changes: (serverId: string) => api.extension<{ at: number; changes: DataChange[] } | null>("lattice", "changes", serverId),
    write: (serverId: string, process: string, collection: string, id: string, json: string | null) =>
        api.extension<void>("lattice", "write", serverId, process, collection, id, json),
    reset: (serverId: string) => api.extension<void>("lattice", "reset", serverId),
    /** The process that reloaded the config, or null when the file is not a Lattice config. */
    reloadConfig: (serverId: string, path: string) => api.extension<string | null>("lattice", "reloadConfig", serverId, path),
};

/** The built-in Publishing extension's calls. */
export const publishingApi = {
    invite: (serverId: string) => api.extension<string>("publishing", "invite", serverId),
};

/** A button an enabled extension puts on a server's page, with whether it shows for [view]. */
export interface ServerButton {
    extension: string;
    id: string;
    label: string;
    show(view: ServerView): boolean;
}

export function serverButtons(list: ExtensionView[]): ServerButton[] {
    return list.filter((e) => e.enabled).flatMap((e) => (e.manifest.actions ?? []).map((a): ServerButton => ({
        extension: e.manifest.id,
        id: a.id,
        label: a.label,
        show: (view) => (a.when ?? []).every((w) => (w === "running" ? view.state === "running" : w === "public" ? Boolean(view.publicAddress) : !view.publicAddress)),
    })));
}
