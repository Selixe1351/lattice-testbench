import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionView } from "@shared/extensions";
import type { ServerView, SnapshotInfo } from "@shared/types";
import { isOn, latticeApi, publishingApi, serverButtons, useExtensions } from "./ext";
import { type PaneId, TAB_EVENT } from "./ServerPage";
import { confirm } from "./confirm";

const api = window.testbench;

interface Action {
    label: string;
    /** Shown on the right, e.g. which server it acts on. */
    hint?: string;
    run: () => unknown;
}

const TABS: [PaneId | "split", string][] = [
    ["console", "Console"], ["files", "Files"], ["split", "Split"], ["stats", "Stats"], ["bots", "Bots"], ["lattice", "Lattice"], ["data", "Data"],
];

/** Every action for the current server, plus the global ones. Built fresh each time the palette opens. */
function actions(servers: ServerView[], current: ServerView | null, snapshots: SnapshotInfo[], exts: ExtensionView[], nav: Nav): Action[] {
    const out: Action[] = [
        { label: "Deploy test server", run: nav.deploy },
        { label: "Open settings", run: nav.settings },
        ...servers.filter((s) => s.id !== current?.id).map((s) => ({ label: `Go to ${s.label}`, hint: s.state, run: () => nav.select(s.id) })),
        ...snapshots.map((s) => ({ label: `Restore snapshot: ${s.name}`, run: async () => nav.select(await api.restoreSnapshot(s.id)) })),
    ];
    if (!current) return out;

    const id = current.id;
    const actions = serverButtons(exts);
    const publishing = isOn(exts, "publishing");
    const lattice = isOn(exts, "lattice");
    const on = current.label;
    const up = current.processes.some((p) => p.state === "running" || p.state === "starting");
    const copy = (text: string) => navigator.clipboard.writeText(text);
    const mine: Action[] = [
        ...(up
            ? [{ label: "Restart", run: () => api.restart(id) }, { label: "Stop", run: () => api.stop(id) }, { label: "Kill", run: () => api.kill(id) }]
            : [{ label: "Start", run: () => api.start(id) }]),
        ...actions.filter((a) => a.show(current)).map((a) => ({ label: a.label, run: () => api.runExtensionAction(a.extension, a.id, id) })),
        ...(current.address ? [{ label: `Copy address ${current.address}`, run: () => copy(current.address) }] : []),
        ...(current.publicAddress && publishing ? [{ label: "Copy invite", run: async () => copy(await publishingApi.invite(id)) }] : []),
        { label: "Add 30 minutes", run: () => api.extend(id) },
        { label: current.kept ? "Let it expire" : "Keep (no expiry)", run: () => api.keep(id, !current.kept) },
        { label: "Save snapshot", run: () => api.snapshot(id, `${current.label} ${new Date().toLocaleString()}`) },
        ...current.processes.filter((p) => p.state === "running" && (p.name === "server" || p.name.startsWith("backend-")))
            .map((p) => ({ label: `Profile ${p.name} for 30 seconds`, run: () => api.profile(id, p.name) })),
        ...(current.plugins.length > 0 ? [{ label: "Reload plugins", run: () => api.reloadPlugins(id) }] : []),
        ...TABS.filter(([tab]) => tab !== "bots" ? (tab === "lattice" || tab === "data" ? lattice : true) : isOn(exts, "bots")).map(([tab, name]) => ({ label: `Show ${name}`, run: () => window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: tab })) })),
        ...(lattice ? [{ label: "Reset stored data", run: async () => (await confirm("Stop the server, delete everything Lattice stored, and start again?", { action: "Reset" })) && latticeApi.reset(id) }] : []),
        { label: "Open folder", run: () => api.openFolder(id) },
        { label: "Delete server", run: async () => (await confirm(`Delete ${current.label}?`)) && api.destroy(id) },
    ];
    return [...mine.map((a) => ({ ...a, hint: on })), ...out];
}

interface Nav {
    deploy: () => void;
    settings: () => void;
    select: (id: string) => void;
}

/** Ctrl+K: every action by name. Each typed word must appear in the action, in any order. */
export function CommandPalette({ servers, current, nav, onClose }: { servers: ServerView[]; current: ServerView | null; nav: Nav; onClose: () => void }) {
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        api.snapshots().then(setSnapshots, () => setSnapshots([]));
    }, []);

    const exts = useExtensions();
    const all = useMemo(() => actions(servers, current, snapshots, exts, nav), [servers, current, snapshots, exts]);
    const shown = useMemo(() => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        return all.filter((a) => words.every((w) => `${a.label} ${a.hint ?? ""}`.toLowerCase().includes(w)));
    }, [all, query]);

    useEffect(() => setCursor(0), [query]);
    useEffect(() => {
        list.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    const run = async (action: Action | undefined) => {
        if (!action) return;
        try {
            await action.run();
            onClose();
        } catch (e) {
            setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        }
    };

    return (
        <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="palette">
                <input
                    className="input palette-input"
                    autoFocus
                    placeholder={current ? `Action for ${current.label}, or anything...` : "Action..."}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") onClose();
                        else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, shown.length - 1)); }
                        else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
                        else if (e.key === "Enter") void run(shown[cursor]);
                    }}
                />
                <div className="palette-list" ref={list}>
                    {shown.map((a, i) => (
                        <div key={`${a.label}-${i}`} className={`palette-item ${i === cursor ? "on" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => void run(a)}>
                            <span>{a.label}</span>
                            {a.hint && <span className="faint sm">{a.hint}</span>}
                        </div>
                    ))}
                    {shown.length === 0 && <p className="faint sm" style={{ padding: 12 }}>Nothing matches.</p>}
                </div>
                {error && <div className="error-box" style={{ margin: 8 }}>{error}</div>}
            </div>
        </div>
    );
}
