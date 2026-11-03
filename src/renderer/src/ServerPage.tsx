import { useEffect, useState } from "react";
import { SPARK_LINK } from "@shared/console";
import type { ServerView } from "@shared/types";
import { BotsTab } from "./BotsTab";
import { isOn, publishingApi, serverButtons, useExtensions } from "./ext";
import { ConsoleTab } from "./ConsoleTab";
import { DataTab } from "./DataTab";
import { LatticeTab } from "./LatticeTab";
import { FilesTab } from "./FilesTab";
import { StatsTab } from "./StatsTab";
import { Activity, Database, Layers, Bot, Camera, Clock, Download, External, Folder, Gauge, Globe, Kill, More, Pencil, Pin, Play, Refresh, Restart, Share, Shield, ShieldOff, Split, Stop, Terminal, Trash } from "./icons";
import { usePersisted } from "./persist";
import { add, type Layout, panesIn, valid } from "./split";
import { SplitView } from "./SplitView";
import { remaining } from "./time";

const api = window.testbench;

export type PaneId = "console" | "files" | "stats" | "bots" | "lattice" | "data";
type Tab = PaneId | "split";

const PANE_IDS: PaneId[] = ["console", "files", "stats", "bots", "lattice", "data"];
const PANE_LABEL: Record<PaneId, string> = { console: "Console", files: "Files", stats: "Stats", bots: "Bots", lattice: "Lattice", data: "Data" };

/** The command palette switches tabs through this event, since the tab is this page's own state. */
export const TAB_EVENT = "testbench:tab";

const STATE_TEXT: Record<ServerView["state"], string> = {
    preparing: "Preparing",
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    failed: "Failed",
};

/** Start when nothing runs; Restart, Stop and Kill while something does. */
function Power({ server }: { server: ServerView }) {
    const up = server.processes.some((p) => p.state === "running" || p.state === "starting");
    const busy = server.state === "preparing" || server.processes.some((p) => p.state === "stopping");
    if (server.error || server.processes.length === 0) return null;
    if (!up) {
        return <button className="btn primary" onClick={() => api.start(server.id)} disabled={busy}><Play /> Start</button>;
    }
    return (
        <div className="power">
            <button className="btn" onClick={() => api.restart(server.id)} disabled={busy} title="Stop, then start again"><Restart /> Restart</button>
            <button className="btn" onClick={() => api.stop(server.id)} disabled={busy} title="Save and stop"><Stop /> Stop</button>
            <button className="btn danger" onClick={() => api.kill(server.id)} title="End the process now, without saving"><Kill /> Kill</button>
        </div>
    );
}

/** What a rejected call said, without the wrapper Electron puts around errors from the main process. */
const describe = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const DEFAULT_LAYOUT: Layout<PaneId> = { kind: "split", dir: "row", children: [{ kind: "pane", id: "console" }, { kind: "pane", id: "files" }], sizes: [1, 1] };

export function ServerPage({ server, now }: { server: ServerView; now: number }) {
    const extensions = useExtensions();
    const buttons = serverButtons(extensions).filter((b) => b.show(server));
    const bots = isOn(extensions, "bots");
    const lattice = isOn(extensions, "lattice") && server.uses.includes("lattice");
    const [storedTab, setTab] = usePersisted<Tab>(`${server.id}:tab`, "console");
    // Each extension's panes exist only while it is on, and Lattice's only on a server deployed with it.
    const panes = PANE_IDS.filter((id) => (id === "bots" ? bots : id === "lattice" || id === "data" ? lattice : true));
    const tab: Tab = storedTab === "split" || panes.includes(storedTab) ? storedTab : "console";
    const [copied, setCopied] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [moreOpen, setMoreOpen] = useState(false);
    const [notice, setNotice] = useState<{ text: string; error: boolean; link?: string } | null>(null);
    const [profiling, setProfiling] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    /** Runs a button action, showing what went wrong instead of letting the rejection vanish. */
    const act = async (name: string, action: () => Promise<string | void>) => {
        setBusy(name);
        setNotice(null);
        try {
            const done = await action();
            if (done) setNotice({ text: done, error: false });
        } catch (e) {
            setNotice({ text: describe(e), error: true });
        } finally {
            setBusy(null);
        }
    };
    const low = !server.kept && server.expiresAt - now < 5 * 60_000;
    const online = server.players.filter((p) => p.leftAt === undefined).length;

    useEffect(() => {
        const listener = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
        window.addEventListener(TAB_EVENT, listener);
        return () => window.removeEventListener(TAB_EVENT, listener);
    }, []);
    const games = server.processes.filter((p) => p.name === "server" || p.name.startsWith("backend-"));

    // spark prints its viewer link when the profile finishes; lift it out of the console into the notice.
    useEffect(() => {
        if (!profiling) return;
        return api.onConsole((line) => {
            const link = line.serverId === server.id ? SPARK_LINK.exec(line.text) : null;
            if (!link) return;
            setProfiling(false);
            setNotice({ text: `Profile from ${line.process} is ready:`, error: false, link: link[0] });
        });
    }, [profiling, server.id]);

    // The split layout is a preference, not a property of one server, so a new server opens the way the last was left.
    const [stored, setLayout] = usePersisted<unknown>("split:layout", null);
    const layout: Layout<PaneId> = valid(stored, PANE_IDS) ? stored : DEFAULT_LAYOUT;
    const inSplit = panesIn(layout);

    const paneBody = (id: PaneId) => (
        <>
            {id === "console" && <ConsoleTab server={server} />}
            {id === "files" && <FilesTab server={server} />}
            {id === "stats" && <StatsTab server={server} />}
            {id === "bots" && bots && <BotsTab server={server} />}
            {id === "lattice" && lattice && <LatticeTab server={server} />}
            {id === "data" && lattice && <DataTab server={server} />}
        </>
    );

    const copy = () => {
        void navigator.clipboard.writeText(server.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };

    return (
        <>
            <div className="server-head">
                <div className="title">
                    {renaming === null ? (
                        <div className="name-row">
                            <h1 className="renamable" title="Rename" onClick={() => setRenaming(server.label)}>
                                {server.label} <span className="faint"><Pencil /></span>
                            </h1>
                            {server.onlineMode
                                ? <span className="mark" title="Online mode: players sign in with Mojang"><Shield /></span>
                                : <span className="mark warn-text" title="Offline mode: anyone can join under any name"><ShieldOff /></span>}
                        </div>
                    ) : (
                        <input
                            className="input rename"
                            autoFocus
                            maxLength={40}
                            value={renaming}
                            onChange={(e) => setRenaming(e.target.value)}
                            onBlur={() => setRenaming(null)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    void api.rename(server.id, renaming);
                                    setRenaming(null);
                                } else if (e.key === "Escape") setRenaming(null);
                            }}
                        />
                    )}
                    {/* Plain facts in one line; colour only where something wants attention. */}
                    <div className="meta-line">
                        <span className="meta-item"><span className={`dot ${server.state}`} /> {STATE_TEXT[server.state]}</span>
                        {server.address && <span className="meta-item meta-copy mono" onClick={copy} title="Copy address">{copied ? "copied" : server.address}</span>}
                        {server.publicAddress && (
                            <span className="meta-item meta-copy mono public" onClick={() => void navigator.clipboard.writeText(server.publicAddress!)} title="Public address. Click to copy.">
                                <Globe /> {server.publicAddress}
                            </span>
                        )}
                        {server.software === "velocity" && <span className="meta-item">{games.length} backend{games.length === 1 ? "" : "s"}</span>}
                        {server.world !== "normal" && <span className="meta-item">{server.world === "flat" ? "Flat" : "Void"} world</span>}
                        {online > 0 && (
                            <span className="meta-item ok-text clickable" onClick={() => setTab("stats")} title="Players on now; the Stats tab lists every visit">
                                <span className="dot running" /> {online} online
                            </span>
                        )}
                    </div>
                    {server.modules.length > 0 && (
                        <div className="module-line">
                            {server.modules.map((m) => {
                                const status = server.moduleStatus[m];
                                return (
                                    <span key={m} className={`module-name ${status === "failed" ? "bad-text" : ""}`} title={status === "enabled" ? "Enabled" : status === "failed" ? "Failed to enable: see the console" : "Not loaded yet"}>
                                        <span className={`dot ${status === "enabled" ? "running" : status === "failed" ? "failed" : "stopped"}`} /> {m}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>
                <span className={`timer ${low ? "low" : ""}`} title={server.kept ? "Kept: does not expire" : "Deleted when this reaches zero"}>
                    {server.kept ? <><Pin /> kept</> : <><Clock /> {remaining(server.expiresAt, now)}</>}
                </span>
                <Power server={server} />
                <div className="menu-wrap">
                    <button className="btn icon-only" onClick={() => setMoreOpen(!moreOpen)} title="More actions" aria-label="More actions"><More /></button>
                    {moreOpen && (
                        <>
                            <div className="menu-backdrop" onClick={() => setMoreOpen(false)} />
                            <div className="context-menu drop" onClick={() => setMoreOpen(false)}>
                                <button onClick={() => api.extend(server.id)} disabled={server.state === "stopping" || server.kept}><Clock /> Add 30 minutes</button>
                                <button onClick={() => api.keep(server.id, !server.kept)} disabled={server.state === "stopping"} title="A kept server does not expire; it still goes when deleted or when the app quits">
                                    <Pin /> {server.kept ? "Let it expire" : "Keep (no expiry)"}
                                </button>
                                {buttons.map((b) => (
                                    <button
                                        key={`${b.extension}:${b.id}`}
                                        disabled={busy === b.id || server.state === "preparing" || server.state === "stopping"}
                                        onClick={() => void act(b.id, async () => { await api.runExtensionAction(b.extension, b.id, server.id); })}
                                    >
                                        <Globe /> {busy === b.id ? `${b.label}...` : b.label}
                                    </button>
                                ))}
                                {server.publicAddress && isOn(extensions, "publishing") && (
                                    <button onClick={() => void act("invite", async () => {
                                        await navigator.clipboard.writeText(await publishingApi.invite(server.id));
                                        return "Invite copied. Paste it wherever your testers are.";
                                    })}>
                                        <Share /> Copy invite
                                    </button>
                                )}
                                <button
                                    disabled={busy === "snapshot" || server.state === "preparing" || server.state === "stopping"}
                                    title="Save worlds and configs, to deploy this server again later"
                                    onClick={() => void act("snapshot", async () => {
                                        const info = await api.snapshot(server.id, `${server.label} ${new Date().toLocaleString()}`);
                                        return `Snapshot "${info.name}" saved (${info.files} files). Restore it from Deploy.`;
                                    })}
                                >
                                    <Camera /> {busy === "snapshot" ? "Saving snapshot..." : "Save snapshot"}
                                </button>
                                <button
                                    disabled={busy === "export"}
                                    onClick={() => void act("export", async () => {
                                        const result = await api.exportServer(server.id);
                                        if (result) return `Saved ${result.files} files to ${result.path}${result.skipped ? ` (${result.skipped} locked files skipped)` : ""}.`;
                                    })}
                                >
                                    <Download /> Export as zip
                                </button>
                                <button onClick={() => api.openFolder(server.id)}><External /> Open folder</button>
                                {games.some((p) => p.state === "running") && (
                                    <>
                                        <div className="menu-label">{profiling ? "Profiling..." : "Profile for 30 seconds (spark)"}</div>
                                        {games.filter((p) => p.state === "running").map((p) => (
                                            <button
                                                key={p.name}
                                                disabled={profiling}
                                                onClick={() => void act("profile", async () => {
                                                    await api.profile(server.id, p.name);
                                                    setProfiling(true);
                                                    return `Profiling ${p.name} for 30 seconds. The link appears here when it is done.`;
                                                })}
                                            >
                                                <Gauge /> {p.name}
                                            </button>
                                        ))}
                                    </>
                                )}
                                {server.plugins.length > 0 && (
                                    <>
                                        <div className="menu-label">Jars from this PC</div>
                                        <button
                                            disabled={busy === "plugins" || server.state === "preparing" || server.state === "stopping"}
                                            title={server.plugins.join("\n")}
                                            onClick={() => void act("plugins", async () => { await api.reloadPlugins(server.id); return "Jars copied again; the server is restarting."; })}
                                        >
                                            <Refresh /> {busy === "plugins" ? "Reloading..." : `Reload plugins (${server.plugins.length})`}
                                        </button>
                                    </>
                                )}
                                <div className="menu-sep" />
                                <button className="danger" onClick={() => api.destroy(server.id)} disabled={server.state === "stopping"}>
                                    <Trash /> {server.state === "stopping" ? "Deleting..." : "Delete server"}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
            {server.error && <div className="error-box" style={{ margin: "0 32px 12px" }}>{server.error}</div>}
            {notice && (
                <div className={notice.error ? "error-box" : "notice-box"} style={{ margin: "0 32px 12px" }} onClick={() => setNotice(null)}>
                    {notice.text}
                    {notice.link && <> <a className="link" href={notice.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{notice.link}</a></>}
                </div>
            )}
            <div className="tabs">
                <button className={`tab ${tab === "console" ? "on" : ""}`} onClick={() => setTab("console")}><Terminal /> Console</button>
                <button className={`tab ${tab === "files" ? "on" : ""}`} onClick={() => setTab("files")}><Folder /> Files</button>
                <button className={`tab ${tab === "split" ? "on" : ""}`} onClick={() => setTab("split")}><Split /> Split</button>
                <button className={`tab ${tab === "stats" ? "on" : ""}`} onClick={() => setTab("stats")}><Activity /> Stats</button>
                {bots && <button className={`tab ${tab === "bots" ? "on" : ""}`} onClick={() => setTab("bots")}><Bot /> Bots</button>}
                {lattice && <button className={`tab ${tab === "lattice" ? "on" : ""}`} onClick={() => setTab("lattice")}><Layers /> Lattice</button>}
                {lattice && <button className={`tab ${tab === "data" ? "on" : ""}`} onClick={() => setTab("data")}><Database /> Data</button>}
            </div>
            {tab === "split" && panes.some((id) => !inSplit.includes(id)) && (
                <div className="split-bar">
                    <span className="faint sm">Add a pane</span>
                    {panes.filter((id) => !inSplit.includes(id)).map((id) => (
                        <button key={id} className="btn sm ghost" onClick={() => setLayout(add(layout, id))}>+ {PANE_LABEL[id]}</button>
                    ))}
                    <span className="grow" />
                    <span className="faint sm">Drag a pane by its title onto another: an edge docks it there, the middle swaps.</span>
                </div>
            )}
            <div className="tab-body">
                {tab === "split" ? (
                    <SplitView layout={layout} onChange={setLayout} label={(id) => PANE_LABEL[id]} render={paneBody} />
                ) : (
                    PANE_IDS.flatMap((id) => {
                        const shown = id === tab;
                        // Console stays mounted so it keeps collecting lines while another tab is open.
                        if (!shown && id !== "console") return [];
                        return [<div key={id} className="pane" style={{ display: shown ? "flex" : "none", flex: "1 1 0" }}>{paneBody(id)}</div>];
                    })
                )}
            </div>
        </>
    );
}
