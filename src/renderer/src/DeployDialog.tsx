import { useEffect, useState } from "react";
import type { ExtensionValue } from "@shared/extensions";
import type { MatrixTarget, SnapshotInfo, Software, Versions, WorldKind } from "@shared/types";
import { confirm } from "./confirm";
import { FieldInput, FileList } from "./FieldInput";
import { useExtensions } from "./ext";
import { usePersisted } from "./persist";

const api = window.testbench;

type GameSoftware = Exclude<Software, "velocity">;

const SOFTWARE: { id: Software; name: string; note: string }[] = [
    { id: "paper", name: "Paper", note: "One server" },
    { id: "folia", name: "Folia", note: "Regionised threads" },
    { id: "purpur", name: "Purpur", note: "Paper fork" },
    { id: "velocity", name: "Network", note: "Velocity + backends" },
];

type Mode = "server" | "matrix" | "snapshots";
const GAME: GameSoftware[] = ["paper", "folia", "purpur"];
/** How many of the newest versions per software the matrix offers. */
const MATRIX_VERSIONS = 6;
const MATRIX_MAX = 8;

export function DeployDialog({ onClose, onDeployed, onMatrix }: { onClose: () => void; onDeployed: (id: string) => void; onMatrix: (id: string) => void }) {
    const extensions = useExtensions().filter((e) => e.enabled && (e.manifest.deploy ?? []).length > 0);
    const [mode, setMode] = useState<Mode>("server");
    const [cells, setCells] = useState<Set<string>>(new Set());
    const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
    const [versions, setVersions] = useState<Versions | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [software, setSoftware] = useState<Software>("paper");
    const [plugins, setPlugins] = usePersisted<string[]>("deploy:plugins", []);
    const [serverJar, setServerJar] = usePersisted<string | null>("deploy:server-jar", null);
    const [backend, setBackend] = useState<GameSoftware>("paper");
    const [backends, setBackends] = useState(2);
    const [version, setVersion] = useState("");
    const [onlineMode, setOnlineMode] = useState(true);
    const [world, setWorld] = useState<WorldKind>("normal");
    // Options of enabled extensions, by extension id then field key, remembered between deploys.
    const [extra, setExtra] = usePersisted<Record<string, Record<string, ExtensionValue>>>("deploy:extensions", {});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api.versions().then(setVersions, (e: Error) => setError(`Could not load versions: ${e.message}`));
        api.snapshots().then(setSnapshots, (e: Error) => setError(`Could not read snapshots: ${e.message}`));
    }, []);

    const targets: MatrixTarget[] = [...cells].map((key) => {
        const [software, version] = key.split("@") as [GameSoftware, string];
        return { software, version };
    });

    const toggleCell = (key: string) => {
        const next = new Set(cells);
        if (next.has(key)) next.delete(key);
        else if (next.size < MATRIX_MAX) next.add(key);
        setCells(next);
    };

    /** Only enabled extensions' options are sent; a turned-off one must not see leftovers from before. */
    const request = () => ({
        software,
        version,
        backendSoftware: software === "velocity" ? backend : undefined,
        backends: software === "velocity" ? backends : undefined,
        onlineMode,
        world,
        plugins,
        ...(serverJar && software !== "velocity" ? { serverJar } : {}),
        extensions: Object.fromEntries(extensions.map((e) => [e.manifest.id, extra[e.manifest.id] ?? {}])),
    });

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError((e as Error).message);
            setBusy(false);
        }
    };

    const deploy = () => run(async () => onDeployed(await api.deploy(request())));
    const runMatrix = () => run(async () => onMatrix(await api.deployMatrix({ ...request(), software: "paper", version: "", backendSoftware: undefined, backends: undefined }, targets)));
    const restore = (snapshot: SnapshotInfo) => run(async () => onDeployed(await api.restoreSnapshot(snapshot.id)));
    const importZip = () => run(async () => {
        const id = await api.importServer();
        if (id) onDeployed(id);
        else setBusy(false);
    });

    const removeSnapshot = async (snapshot: SnapshotInfo) => {
        if (!(await confirm(`Delete the snapshot "${snapshot.name}"?`))) return;
        try {
            await api.deleteSnapshot(snapshot.id);
            setSnapshots((list) => list?.filter((x) => x.id !== snapshot.id) ?? null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const host: GameSoftware = software === "velocity" ? backend : software;
    const list = versions?.[host] ?? [];

    // Keep the chosen version when it exists for the new software, else take the newest.
    useEffect(() => {
        if (list.length > 0 && !list.includes(version)) setVersion(list[0]);
    }, [list, version]);

    return (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="dialog">
                <div className="dialog-head">
                    <div className="mode-switch">
                        <h1>Deploy</h1>
                        <div className="proc-tabs" style={{ marginBottom: 0 }}>
                            <button className={`btn sm ${mode === "server" ? "" : "ghost"}`} onClick={() => setMode("server")}>Server</button>
                            <button className={`btn sm ${mode === "matrix" ? "" : "ghost"}`} onClick={() => setMode("matrix")} title="The same plugins on several versions at once">Version matrix</button>
                            <button className={`btn sm ${mode === "snapshots" ? "" : "ghost"}`} onClick={() => setMode("snapshots")}>
                                Snapshots{snapshots && snapshots.length > 0 ? ` (${snapshots.length})` : ""}
                            </button>
                        </div>
                    </div>
                    <p className="subtle sm" style={{ marginTop: 4 }}>
                        One server or a Velocity network, with your own plugins. Gets ViaVersion, ViaBackwards, PlaceholderAPI and FastAsyncWorldEdit. Deleted after 30 minutes unless extended.
                    </p>
                </div>
                <div className="dialog-body">
                    {mode === "snapshots" && (
                        <div className="snapshot-list">
                            <div className="snapshot">
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <b>Import from zip</b>
                                    <p className="faint sm">A server exported from here, or a server folder zipped by hand. It deploys again and stays here as a snapshot.</p>
                                </div>
                                <button className="btn sm primary" disabled={busy} onClick={() => void importZip()}>Import...</button>
                            </div>
                            {snapshots === null && <p className="faint sm">Loading...</p>}
                            {snapshots?.length === 0 && <p className="faint sm">No snapshots yet. Save one from a server's menu: it keeps worlds and configs, and restoring deploys the same server again with them.</p>}
                            {snapshots?.map((snap) => (
                                <div key={snap.id} className="snapshot">
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <b>{snap.name}</b>
                                        <p className="faint sm">
                                            {snap.request.software === "velocity" ? `Network ${snap.request.version}, ${snap.request.backends ?? 1} backends` : `${snap.request.software} ${snap.request.version}`}
                                            {" · "}{(snap.request.plugins ?? []).map((p) => p.split(/[\\/]/).pop()).join(", ") || "no extra plugins"}
                                            {" · "}{snap.files} files · {new Date(snap.createdAt).toLocaleString()}
                                        </p>
                                    </div>
                                    <button className="btn sm primary" disabled={busy} onClick={() => void restore(snap)}>Restore</button>
                                    <button className="btn sm ghost" disabled={busy} onClick={() => void removeSnapshot(snap)}>Delete</button>
                                </div>
                            ))}
                        </div>
                    )}

                    {mode === "matrix" && (
                        <div className="field">
                            <span>Servers <span className="faint">({cells.size} of at most {MATRIX_MAX}, one single server each)</span></span>
                            <div className="matrix-pick">
                                {GAME.map((g) => (
                                    <div key={g} className="matrix-row">
                                        <b>{g}</b>
                                        {(versions?.[g] ?? []).slice(0, MATRIX_VERSIONS).map((v) => {
                                            const key = `${g}@${v}`;
                                            return <button key={key} className={`chip ${cells.has(key) ? "on" : ""}`} onClick={() => toggleCell(key)}>{v}</button>;
                                        })}
                                        {!versions && <span className="faint sm">Loading...</span>}
                                    </div>
                                ))}
                            </div>
                            <span className="hint">Each gets the plugins below. Memory: {cells.size} x your per-server setting.</span>
                        </div>
                    )}

                    {mode === "server" && <>
                    <div className="field">
                        <span>Software</span>
                        <div className="segmented">
                            {SOFTWARE.map((s) => (
                                <button key={s.id} className={`segment ${software === s.id ? "on" : ""}`} onClick={() => setSoftware(s.id)}>
                                    <b>{s.name}</b>
                                    <small>{s.note}</small>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="input-row">
                        {software === "velocity" && (
                            <label className="field" style={{ flex: 1 }}>
                                <span>Backends</span>
                                <select className="input" value={backend} onChange={(e) => setBackend(e.target.value as GameSoftware)}>
                                    <option value="paper">Paper</option>
                                    <option value="folia">Folia</option>
                                    <option value="purpur">Purpur</option>
                                </select>
                            </label>
                        )}
                        <label className="field" style={{ flex: 1 }}>
                            <span>Minecraft version</span>
                            <select className="input" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions}>
                                {!versions && <option>Loading...</option>}
                                {list.map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                        </label>
                        {software === "velocity" && (
                            <label className="field" style={{ width: 120 }}>
                                <span>How many</span>
                                <select className="input" value={backends} onChange={(e) => setBackends(Number(e.target.value))}>
                                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                                </select>
                            </label>
                        )}
                    </div>
                    </>}

                    {mode !== "snapshots" && <>
                    <div className="extras">
                        {mode === "server" && software !== "velocity" && (
                            <FileList
                                label="Server jar"
                                hint="Use this jar instead of downloading the software above, for a Paper fork."
                                files={serverJar ? [serverJar] : []}
                                onChange={(jars) => setServerJar(jars.at(-1) ?? null)}
                                extensions={["jar"]}
                            />
                        )}
                        <FileList
                            label="Plugins"
                            hint={software === "velocity" && mode === "server" ? "Copied into every backend. Rebuilt one? Reload plugins from the server's menu." : "Rebuilt one? Reload plugins from the server's menu."}
                            files={plugins}
                            onChange={setPlugins}
                            extensions={["jar"]}
                        />
                    </div>

                    <div className="input-row" style={{ marginTop: 10 }}>
                        <label className="field" style={{ flex: 1 }}>
                            <span>World</span>
                            <select className="input" value={world} onChange={(e) => setWorld(e.target.value as WorldKind)}>
                                <option value="normal">Normal</option>
                                <option value="flat">Flat</option>
                                <option value="void">Void</option>
                            </select>
                        </label>
                    </div>
                    <label className="check" style={{ marginTop: 4 }}>
                        <input type="checkbox" checked={onlineMode} onChange={(e) => setOnlineMode(e.target.checked)} />
                        Online mode
                        <span className="faint sm">Real accounts only. Turn it off to let bots or offline clients join. Only online servers can be published.</span>
                    </label>

                    {extensions.map((e) => (
                        <div key={e.manifest.id} className="ext-deploy">
                            <h3>{e.manifest.name}</h3>
                            {(e.manifest.deploy ?? []).map((field) => (
                                <FieldInput
                                    key={field.key}
                                    field={field}
                                    value={extra[e.manifest.id]?.[field.key] ?? field.default}
                                    onChange={(value) => setExtra({ ...extra, [e.manifest.id]: { ...extra[e.manifest.id], [field.key]: value } })}
                                />
                            ))}
                        </div>
                    ))}
                    </>}
                    {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
                </div>
                <div className="dialog-foot">
                    <span className="note faint sm">{mode === "snapshots" ? "Restoring uses the jars already saved with the snapshot." : ""}</span>
                    <button className="btn ghost" onClick={onClose}>Cancel</button>
                    {mode === "server" && (
                        <button className="btn primary" onClick={() => void deploy()} disabled={busy || !version}>
                            {busy ? "Deploying..." : "Deploy"}
                        </button>
                    )}
                    {mode === "matrix" && (
                        <button className="btn primary" onClick={() => void runMatrix()} disabled={busy || cells.size === 0}>
                            {busy ? "Deploying..." : `Deploy ${cells.size} server${cells.size === 1 ? "" : "s"}`}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
