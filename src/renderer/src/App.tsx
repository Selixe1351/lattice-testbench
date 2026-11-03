import { useEffect, useState } from "react";
import { APP_NAME } from "@shared/brand";
import type { ServerView, Settings, UpdateStatus } from "@shared/types";
import { CommandPalette } from "./CommandPalette";
import { DeployDialog } from "./DeployDialog";
import { confirm } from "./confirm";
import { ExtensionsPage } from "./ExtensionsPage";
import { Gear, Grid, Logo, Plus, Puzzle, Server } from "./icons";
import { MatrixPage } from "./MatrixPage";
import { usePersisted } from "./persist";
import { ServerPage } from "./ServerPage";
import { SettingsPage } from "./SettingsPage";
import { useNow, remaining } from "./time";

const api = window.testbench;

export function App() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [servers, setServers] = useState<ServerView[]>([]);
    const [selected, setSelected] = usePersisted<string | null>("selected", null);
    const [page, setPage] = usePersisted<"server" | "settings" | "matrix" | "extensions">("page", "server");
    const [matrix, setMatrix] = usePersisted<string | null>("matrix", null);
    const [deploying, setDeploying] = useState(false);
    const [palette, setPalette] = useState(false);
    const [update, setUpdate] = useState<UpdateStatus | null>(null);
    const now = useNow();

    useEffect(() => {
        void api.settings().then((s) => {
            setSettings(s);
            // Nothing can deploy without these, so a first run opens straight on Settings.
            if (!s.javaPath) setPage("settings");
        });
        void api.servers().then(setServers);
        void api.updateStatus().then(setUpdate);
        const offUpdate = api.onUpdate(setUpdate);
        const offServers = api.onServers(setServers);
        // The tray's "Open" lands here.
        const offSelect = api.onSelect((id) => {
            setSelected(id);
            setPage("server");
        });
        return () => {
            offUpdate();
            offServers();
            offSelect();
        };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setPalette((open) => !open);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // A deleted or expired server takes the selection with it, and with nothing selected the first server is.
    useEffect(() => {
        // Before the first list arrives there is nothing to check the remembered selection against.
        if (servers.length === 0) return;
        if (!selected ||!servers.some((s) => s.id === selected)) setSelected(servers[0]?.id ?? null);
    }, [servers, selected]);

    const current = servers.find((s) => s.id === selected) ?? null;
    const matrixServers = servers.filter((s) => s.matrix && s.matrix === matrix);
    // Matrix cells sit under their run's heading; everything else is listed as before.
    const groups = [...new Set(servers.map((s) => s.matrix ?? ""))];

    const item = (s: ServerView, nested: boolean) => (
        <div
            key={s.id}
            className={`server-item ${nested ? "nested" : ""} ${s.id === selected && page === "server" ? "active" : ""}`}
            onClick={() => {
                setSelected(s.id);
                setPage("server");
            }}
        >
            <div className="row">
                <span className={`dot ${s.state}`} />
                <span className="name">{s.label}</span>
                <span className="faint sm mono">{s.kept ? "kept" : remaining(s.expiresAt, now)}</span>
            </div>
            <span className="faint sm" style={{ paddingLeft: 16 }}>
                {s.plugins.length === 0 ? "no extra plugins" : `${s.plugins.length} plugin${s.plugins.length === 1 ? "" : "s"}`}
                {s.address && !nested ? ` · ${s.address}` : ""}
            </span>
        </div>
    );

    return (
        <div className="app">
            <div className="titlebar" />
            <aside className="sidebar">
                <div className="brand">
                    <Logo />
                    {APP_NAME}
                </div>
                <button className="btn primary block" onClick={() => setDeploying(true)} disabled={!settings?.javaPath}>
                    <Plus /> Deploy test server
                </button>
                <div className="side-label">Servers</div>
                <div className="server-list">
                    {servers.length === 0 && <p className="faint sm" style={{ padding: "0 10px" }}>Nothing running.</p>}
                    {groups.map((group) => {
                        const members = servers.filter((s) => (s.matrix ?? "") === group);
                        if (!group) return members.map((s) => item(s, false));
                        return (
                            <div key={group}>
                                <div
                                    className={`server-item matrix-head ${page === "matrix" && matrix === group ? "active" : ""}`}
                                    onClick={() => {
                                        setMatrix(group);
                                        setPage("matrix");
                                    }}
                                >
                                    <div className="row"><Grid /> <span className="name">Version matrix</span> <span className="faint sm">{members.length}</span></div>
                                </div>
                                {members.map((s) => item(s, true))}
                            </div>
                        );
                    })}
                </div>
                <div className="side-foot">
                    {update?.state === "ready" && (
                        <button
                            className="btn primary block"
                            style={{ marginBottom: 8 }}
                            onClick={async () => {
                                const running = servers.length;
                                if (running > 0 && !(await confirm(`Updating restarts the app and deletes ${running} running test server${running === 1 ? "" : "s"}. Continue?`, { action: "Update" }))) return;
                                void api.installUpdate();
                            }}
                        >
                            Update to {update.version}
                        </button>
                    )}
                    {update?.state === "downloading" && (
                        <p className="faint sm" style={{ padding: "0 10px 8px" }}>Downloading {update.version} ({update.percent ?? 0}%)</p>
                    )}
                    {update?.state === "error" && (
                        <p className="faint sm" style={{ padding: "0 10px 8px" }} title={update.note}>Update check failed</p>
                    )}
                    <button className={`nav-btn ${page === "extensions" ? "active" : ""}`} onClick={() => setPage("extensions")}>
                        <Puzzle /> Extensions
                    </button>
                    <button className={`nav-btn ${page === "settings" ? "active" : ""}`} onClick={() => setPage("settings")}>
                        <Gear /> Settings
                    </button>
                    {update && <p className="faint sm" style={{ padding: "6px 10px 0" }}>v{update.current}</p>}
                </div>
            </aside>

            <main className="main">
                {page === "settings" && settings ? (
                    <SettingsPage settings={settings} onSaved={setSettings} />
                ) : page === "extensions" ? (
                    <ExtensionsPage />
                ) : page === "matrix" && matrixServers.length > 0 ? (
                    <MatrixPage servers={matrixServers} onOpen={(id) => { setSelected(id); setPage("server"); }} />
                ) : current ? (
                    <ServerPage key={current.id} server={current} now={now} />
                ) : (
                    <div className="empty">
                        <Server />
                        <h2>No test server selected</h2>
                        <p>Deploy one with the plugins you want to try. It deletes itself after 30 minutes.</p>
                        <p className="faint sm">Publishing, AI agents, bots and Lattice are extensions: open Extensions to turn them on.</p>
                        <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setDeploying(true)} disabled={!settings?.javaPath}>
                            <Plus /> Deploy test server
                        </button>
                    </div>
                )}
            </main>

            {palette && (
                <CommandPalette
                    servers={servers}
                    current={page === "server" ? current : null}
                    onClose={() => setPalette(false)}
                    nav={{
                        deploy: () => setDeploying(true),
                        settings: () => setPage("settings"),
                        select: (id) => { setSelected(id); setPage("server"); },
                    }}
                />
            )}

            {deploying && (
                <DeployDialog
                    onClose={() => setDeploying(false)}
                    onDeployed={(id) => {
                        setDeploying(false);
                        setSelected(id);
                        setPage("server");
                    }}
                    onMatrix={(id) => {
                        setDeploying(false);
                        setMatrix(id);
                        setPage("matrix");
                    }}
                />
            )}
        </div>
    );
}
