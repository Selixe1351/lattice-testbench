import { useEffect, useState } from "react";
import { APP_NAME } from "@shared/brand";
import type { Settings, UpdateStatus } from "@shared/types";

const api = window.testbench;

/** What the app is built on, and what it downloads for you; each keeps its own licence. */
const CREDITS: [string, string][] = [
    ["Electron, React, CodeMirror, mineflayer", "MIT"],
    ["frp (tunnels, Publishing extension)", "Apache 2.0, downloaded from its authors"],
    ["Jolokia (tick rate)", "Apache 2.0, downloaded from Maven Central"],
    ["Vineflower (decompiler)", "Apache 2.0, downloaded from Maven Central"],
    ["Paper, Folia, Velocity, Purpur", "GPL 3.0 / MIT, downloaded from their authors"],
    ["ViaVersion, ViaBackwards, PlaceholderAPI, FastAsyncWorldEdit", "GPL 3.0, downloaded from Hangar and Modrinth"],
    ["Eclipse Temurin (Java)", "GPL 2.0 with Classpath Exception, downloaded from Adoptium"],
];

export function SettingsPage({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
    const [draft, setDraft] = useState<Settings>(settings);
    const [saved, setSaved] = useState(false);
    const [update, setUpdate] = useState<UpdateStatus | null>(null);
    const [java, setJava] = useState<"idle" | "busy" | string>("idle");
    // Kept as typed, so a trailing comma survives until the next name is written.
    const [operators, setOperators] = useState(settings.operators.join(", "));

    const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setSaved(false);
    };

    const downloadJava = async () => {
        setJava("busy");
        try {
            set("javaPath", await api.installJava());
            setJava("idle");
        } catch (e) {
            setJava((e as Error).message);
        }
    };

    useEffect(() => {
        void api.updateStatus().then(setUpdate);
        return api.onUpdate(setUpdate);
    }, []);

    const save = async () => {
        const stored = await api.saveSettings(draft);
        setDraft(stored);
        onSaved(stored);
        setSaved(true);
    };

    return (
        <div className="page">
            <div className="page-narrow">
                <h1 style={{ marginBottom: 4 }}>Settings</h1>
                <p className="subtle" style={{ marginBottom: 24 }}>Used for every server you deploy. Stored on this PC only. Publishing, AI agents, bots and Lattice have their own settings under Extensions.</p>

                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head"><h2>Servers</h2></div>
                    <div className="card-body">
                        <label className="field">
                            <span>Java</span>
                            <div className="input-row">
                                <input className="input mono" value={draft.javaPath} onChange={(e) => set("javaPath", e.target.value)} placeholder="C:\\Program Files\\Java\\jdk-25\\bin\\java.exe" />
                                <button className="btn" onClick={async () => { const p = await api.pickFile("java.exe", ["exe"]); if (p) set("javaPath", p); }}>Browse</button>
                                <button className="btn" disabled={java === "busy"} onClick={() => void downloadJava()} title="Eclipse Temurin 25 from Adoptium, kept in the app's own folder">
                                    {java === "busy" ? "Downloading..." : "Download Java 25"}
                                </button>
                            </div>
                            {java !== "idle" && java !== "busy" && <span className="hint danger-text">{java}</span>}
                            <span className="hint">Minecraft 26 and newer needs Java 25. Older versions run on it too.</span>
                        </label>
                        <label className="field">
                            <span>Operators</span>
                            <input
                                className="input"
                                value={operators}
                                onChange={(e) => {
                                    setOperators(e.target.value);
                                    set("operators", e.target.value.split(/[\s,]+/).filter(Boolean));
                                }}
                                placeholder="YourMinecraftName"
                            />
                            <span className="hint">Made operator on every game server once it starts. Separate names with commas.</span>
                        </label>
                        <div className="input-row">
                            <label className="field" style={{ flex: 1 }}>
                                <span>Memory per server (MB)</span>
                                <input className="input" type="number" min={512} step={256} value={draft.memoryMb} onChange={(e) => set("memoryMb", Number(e.target.value))} />
                            </label>
                            <label className="field" style={{ flex: 1 }}>
                                <span>First port</span>
                                <input className="input" type="number" min={1024} max={65000} value={draft.basePort} onChange={(e) => set("basePort", Number(e.target.value))} />
                            </label>
                        </div>
                    </div>
                </div>

                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head">
                        <h2>Updates</h2>
                        <span className="faint sm">{update ? `Installed: v${update.current}` : ""}</span>
                    </div>
                    <div className="card-body">
                        <button
                            className="btn"
                            style={{ marginBottom: 12 }}
                            disabled={update?.state === "checking" || update?.state === "downloading"}
                            onClick={() => void api.checkForUpdates()}
                        >
                            Check now
                        </button>
                        <p className="subtle sm">
                            {!update ? "" :
                                update.state === "off" ? (update.note ?? "Updates are off.") :
                                update.state === "checking" ? "Checking..." :
                                update.state === "downloading" ? `Downloading ${update.version} (${update.percent ?? 0}%)...` :
                                update.state === "ready" ? `${update.version} is downloaded. Use the Update button in the sidebar, or it installs when you quit.` :
                                update.state === "error" ? `Could not check: ${update.note ?? "unknown error"}` :
                                "Up to date."}
                        </p>
                        <p className="faint sm">The installed app checks this project's GitHub Releases on start and every 30 minutes. It sends nothing else anywhere.</p>
                    </div>
                </div>

                <div className="card" style={{ marginBottom: 20 }}>
                    <div className="card-head">
                        <h2>About</h2>
                        <span className="faint sm">{update ? `${APP_NAME} v${update.current}` : APP_NAME}</span>
                    </div>
                    <div className="card-body">
                        <p className="subtle sm" style={{ marginBottom: 10 }}>
                            Open source under the MIT licence. Settings, tokens and keys stay on this PC, sealed with Windows' own encryption.
                            The app downloads the software below from its authors when needed and never ships it.
                        </p>
                        <dl className="facts">
                            {CREDITS.map(([what, licence]) => <div key={what}><dt>{what}</dt><dd>{licence}</dd></div>)}
                        </dl>
                    </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button className="btn primary" onClick={save}>Save settings</button>
                    {saved && <span className="subtle sm">Saved.</span>}
                </div>
            </div>
        </div>
    );
}
