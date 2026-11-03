import { useEffect, useState } from "react";
import type { LatticeInfo } from "@shared/lattice";
import type { FileEntry, ServerView } from "@shared/types";
import { latticeApi } from "./ext";
import { ConfigForm } from "./ConfigForm";
import { Refresh } from "./icons";
import { usePersisted } from "./persist";

const api = window.testbench;
const CORE = "lattice";
const POLL_MS = 5_000;

/** A process's folder inside the server: none for a single server. */
const prefix = (server: ServerView, process: string) => (server.processes.length > 1 ? `${process}/` : "");
const isProxy = (process: string) => process === "proxy" || process === "bots";

/** Where Lattice keeps configs: Velocity lower-cases the plugin folder. */
const configDir = (server: ServerView, process: string) => `${prefix(server, process)}plugins/${isProxy(process) ? "lattice" : "Lattice"}/config`;

/** Every YAML file under [dir], a few folders deep: Lattice nests module configs as global/<module>/config.yml. */
async function yamlFiles(serverId: string, dir: string, depth = 4): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    for (const entry of await api.listFiles(serverId, dir)) {
        if (entry.directory && depth > 0) out.push(...(await yamlFiles(serverId, entry.path, depth - 1)));
        else if (!entry.directory && /\.ya?ml$/.test(entry.name)) out.push(entry);
    }
    return out;
}

/** "Storage: sqlite (reachable)" becomes a label and a value; lines without a label are kept whole. */
function facts(lines: string[]): { label: string; value: string; bad: boolean }[] {
    return lines.map((l) => l.trim()).filter(Boolean).slice(1).map((line) => {
        const at = line.indexOf(":");
        const bad = /NOT REACHABLE|refused|failed|expired|invalid/i.test(line);
        return at > 0 && at < 24 ? { label: line.slice(0, at), value: line.slice(at + 1).trim(), bad } : { label: "", value: line, bad };
    });
}

type Status = "enabled" | "failed" | "waiting";

/**
 * Lattice on one process, laid out for reading: a health strip on top, the modules down the left, and the
 * picked module's state, dependencies, actions and config on the right. "Lattice" at the top of the list is
 * Lattice's own settings and the full doctor and licence output.
 */
export function LatticeTab({ server }: { server: ServerView }) {
    const names = server.processes.map((p) => p.name);
    const [process, setProcess] = usePersisted<string>(`${server.id}:lattice-process`, names.find((n) => !isProxy(n)) ?? names[0] ?? "");
    const [picked, setPicked] = usePersisted<string>(`${server.id}:lattice-module`, CORE);
    const [info, setInfo] = useState<LatticeInfo | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [configs, setConfigs] = useState<FileEntry[]>([]);
    const [config, setConfig] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const running = server.processes.find((p) => p.name === process)?.state === "running";
    const dir = configDir(server, process);
    const command = isProxy(process) ? "vlattice" : "lattice";

    const refresh = () => {
        if (!running) return;
        setLoading(true);
        setError(null);
        latticeApi.info(server.id, process).then(setInfo, (e: Error) => setError(e.message)).finally(() => setLoading(false));
    };

    // Modules and peers keep themselves current. Doctor and licence are read on open and on Refresh only: their
    // free-text replies can only be taken out of the console by holding back every plain line for a moment.
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => {
            latticeApi.modules(server.id, process).then(
                (next: Pick<LatticeInfo, "modules" | "peers">) => setInfo((current) => (current ? { ...current, ...next } : current)),
                (e: Error) => console.warn("Lattice poll failed:", e.message),
            );
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [server.id, process, running]);

    useEffect(() => {
        setInfo(null);
        refresh();
        yamlFiles(server.id, dir).then(setConfigs, () => setConfigs([]));
    }, [server.id, process, running]);

    // The modules this process should run, and any others Lattice reports, in one list.
    const ids = [...new Set([...server.modules, ...(info?.modules.map((m) => m.id) ?? [])])].sort();
    const status = (id: string): Status => {
        const reported = info?.modules.find((m) => m.id === id)?.state;
        if (reported) return reported === "ENABLED" ? "enabled" : "failed";
        return server.moduleStatus[id] === "failed" ? "failed" : server.moduleStatus[id] === "enabled" ? "enabled" : "waiting";
    };
    const filesFor = (id: string) => (id === CORE
        ? configs.filter((f) => !ids.some((m) => f.path.includes(`/${m}/`)))
        : configs.filter((f) => f.path.includes(`/${id}/`)));
    const shownConfigs = filesFor(picked);
    const module = info?.modules.find((m) => m.id === picked);
    const doctor = facts(info?.doctor ?? []);

    useEffect(() => {
        setConfig(shownConfigs[0]?.path ?? null);
        setNote(null);
    }, [picked, configs.length]);

    const act = (run: () => Promise<unknown>, done: string) => {
        setNote(null);
        run().then(() => { setNote(done); refresh(); }, (e: Error) => setError(e.message));
    };

    return (
        <div className="lattice-tab">
            <div className="lattice-strip">
                {names.length > 1 && (
                    <select className="input sm" value={process} onChange={(e) => setProcess(e.target.value)} title="Which process to look at">
                        {names.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                )}
                {!running && <span className="faint sm">{process} is not running. Configs can still be edited.</span>}
                {running && !info && !error && <span className="faint sm">Asking Lattice...</span>}
                {doctor.slice(0, 3).map((f) => (
                    <span key={f.label + f.value} className={`fact ${f.bad ? "bad" : ""}`} title={f.value}>
                        {f.label && <b>{f.label}</b>} {f.value.split("|")[0].trim()}
                    </span>
                ))}
                {info && server.software === "velocity" && (
                    <span className="fact" title={info.peers.map((p) => `${p.nodeId} ${p.state}`).join(", ")}>
                        <b>Peers</b> {info.peers.filter((p) => p.state === "ALIVE").length}/{info.peers.length} alive
                    </span>
                )}
                <span className="grow" />
                <button className="btn sm ghost" onClick={refresh} disabled={!running || loading}><Refresh /> {loading ? "Asking..." : "Refresh"}</button>
            </div>
            {error && <div className="error-box" onClick={() => setError(null)}>{error}</div>}

            <div className="lattice-body">
                <div className="lattice-list">
                    <button className={`lattice-item ${picked === CORE ? "on" : ""}`} onClick={() => setPicked(CORE)}>
                        <span className="dot running" /> <b>Lattice</b> <span className="faint sm">settings and health</span>
                    </button>
                    <div className="menu-label">Modules</div>
                    {ids.length === 0 && <p className="faint sm" style={{ padding: "0 8px" }}>None on this server.</p>}
                    {ids.map((id) => {
                        const s = status(id);
                        return (
                            <button key={id} className={`lattice-item ${picked === id ? "on" : ""}`} onClick={() => setPicked(id)}>
                                <span className={`dot ${s === "enabled" ? "running" : s === "failed" ? "failed" : "stopped"}`} />
                                <span className="mono">{id}</span>
                                <span className="faint sm" style={{ marginLeft: "auto" }}>{info?.modules.find((m) => m.id === id)?.version ?? ""}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="lattice-detail">
                    {picked === CORE ? (
                        <>
                            <h2>Lattice</h2>
                            {info ? (
                                <dl className="facts">
                                    {doctor.map((f, i) => <div key={i} className={f.bad ? "bad-text" : ""}><dt>{f.label || "Note"}</dt><dd>{f.value}</dd></div>)}
                                    {facts(["", ...info.license]).map((f, i) => <div key={`l${i}`}><dt>{f.label || "Licence"}</dt><dd>{f.value}</dd></div>)}
                                </dl>
                            ) : <p className="faint sm">{running ? "Waiting for Lattice to answer." : "Start the process to see its health and licence."}</p>}
                                            {info && server.software === "velocity" && info.peers.length > 0 && (
                                <>
                                    <h3>Peers</h3>
                                    <dl className="facts">
                                        {info.peers.map((p) => <div key={p.nodeId} className={p.state === "ALIVE" ? "" : "bad-text"}><dt>{p.nodeId}</dt><dd>{p.state.toLowerCase()}, {p.where}, seen {p.seen}</dd></div>)}
                                    </dl>
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="lattice-detail-head">
                                <h2 className="mono">{picked}</h2>
                                <span className={`badge ${status(picked) === "enabled" ? "ok" : status(picked) === "failed" ? "bad" : ""}`}>
                                    {status(picked) === "enabled" ? "enabled" : status(picked) === "failed" ? "failed: see the console" : "not loaded"}
                                </span>
                                {module && <span className="faint sm">v{module.version}</span>}
                                <span className="grow" />
                                <button className="btn sm ghost" disabled={!running} title={`${command} reload ${picked}`}
                                    onClick={() => act(() => api.command(server.id, process, `${command} reload ${picked}`), `Asked Lattice to reload ${picked}; the console has its answer.`)}>
                                    Reload
                                </button>
                            </div>
                            {module && module.depends.length > 0 && <p className="faint sm">Depends on {module.depends.join(", ")}</p>}
                        </>
                    )}

                    {note && <div className="notice-box" style={{ margin: "10px 0" }} onClick={() => setNote(null)}>{note}</div>}

                    <h3>Config</h3>
                    {shownConfigs.length === 0 ? (
                        <p className="faint sm">{picked === CORE ? "No Lattice config files yet." : "No config files. Lattice writes them when the module first enables."}</p>
                    ) : (
                        <>
                            {shownConfigs.length > 1 && (
                                <div className="proc-tabs">
                                    {shownConfigs.map((f) => (
                                        <button key={f.path} className={`btn sm ${config === f.path ? "" : "ghost"}`} onClick={() => setConfig(f.path)}>{f.name}</button>
                                    ))}
                                </div>
                            )}
                            {config && <ConfigForm key={config} serverId={server.id} path={config} onSaved={setNote} />}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
