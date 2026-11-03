import { useEffect, useState } from "react";
import type { ServerView, StatSample } from "@shared/types";
import { PlayerPanel } from "./PlayerPanel";

const api = window.testbench;
const KEPT = 200;

/** A value with one decimal when it is small enough for that to matter. */
const show = (v: number) => (v < 100 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toString());

function Graph({ values, max, unit, color, reference, decimals = false }: { values: number[]; max: number; unit: string; color: string; reference?: { at: number; label: string }; decimals?: boolean }) {
    const fmt = decimals ? show : (v: number) => Math.round(v).toString();
    const W = 600;
    const H = 90;
    const step = values.length > 1 ? W / (KEPT - 1) : W;
    // Newest sample on the right edge; a short history grows in from there.
    const x = (i: number) => W - (values.length - 1 - i) * step;
    const y = (v: number) => H - (Math.min(v, max) / max) * (H - 4) - 2;
    const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const last = values[values.length - 1];
    const peak = Math.max(0, ...values);
    return (
        <div className="graph">
            <div className="graph-head">
                <strong>{last === undefined ? "-" : `${fmt(last)} ${unit}`}</strong>
                <span className="faint sm">peak {fmt(peak)} {unit}{reference && reference.at <= max ? `, green line ${reference.label}` : ""}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${unit} over the last ${Math.round((KEPT * 3) / 60)} minutes`}>
                <line x1="0" x2={W} y1={H - 1} y2={H - 1} stroke="var(--border)" />
                <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--border)" strokeDasharray="3 4" />
                {reference && reference.at <= max && (
                    <line x1="0" x2={W} y1={y(reference.at)} y2={y(reference.at)} stroke="var(--success)" strokeOpacity=".6" strokeDasharray="5 4" />
                )}
                {values.length > 1 && (
                    <>
                        <path d={`${line} L${W} ${H} L${x(0).toFixed(1)} ${H} Z`} fill={color} opacity=".12" />
                        <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
                    </>
                )}
            </svg>
        </div>
    );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stayed(from: number, to: number): string {
    const minutes = Math.round((to - from) / 60_000);
    return minutes < 1 ? "under a minute" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Who came in through the server's entrance and for how long. Bots on a network's offline entrance are not counted. */
function Players({ server }: { server: ServerView }) {
    const now = Date.now();
    const online = server.players.filter((p) => p.leftAt === undefined);
    const names = new Set(server.players.map((p) => p.name));
    const [inspecting, setInspecting] = useState<string | null>(null);
    const onlineNames = [...new Set(online.map((p) => p.name))];
    // A player who left takes their panel with them.
    const shown = inspecting && onlineNames.includes(inspecting) ? inspecting : null;
    return (
        <>
        <div className="card" style={{ margin: "10px 0 14px" }}>
            <div className="card-head">
                <h2>Players</h2>
                <span className="faint sm">{online.length} online · {names.size} different player{names.size === 1 ? "" : "s"} since the deploy</span>
            </div>
            <div className="card-body">
                {server.players.length === 0 ? (
                    <p className="faint sm">Nobody has joined yet.</p>
                ) : (
                    <table className="matrix-table">
                        <thead><tr><th>Player</th><th>Joined</th><th>Stayed</th><th /></tr></thead>
                        <tbody>
                            {[...server.players].reverse().slice(0, 50).map((p) => (
                                <tr key={`${p.name}-${p.joinedAt}`}>
                                    <td>{p.leftAt === undefined && <span className="dot running" />} {p.name}</td>
                                    <td className="faint">{clock(p.joinedAt)}</td>
                                    <td className={p.leftAt === undefined ? "ok-text" : "faint"}>{p.leftAt === undefined ? `online, ${stayed(p.joinedAt, now)}` : stayed(p.joinedAt, p.leftAt)}</td>
                                    <td style={{ textAlign: "right" }}>
                                        {p.leftAt === undefined && <button className={`btn sm ${shown === p.name ? "" : "ghost"}`} onClick={() => setInspecting(shown === p.name ? null : p.name)}>Inspect</button>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
        {shown && <PlayerPanel key={shown} server={server} player={shown} others={onlineNames.filter((n) => n !== shown)} onClose={() => setInspecting(null)} />}
        </>
    );
}

export function StatsTab({ server }: { server: ServerView }) {
    const [samples, setSamples] = useState<StatSample[]>([]);

    useEffect(() => {
        let live = true;
        void api.stats(server.id).then((s) => live && setSamples(s.slice(-KEPT * 5)));
        const off = api.onStats((sample) => {
            if (sample.serverId !== server.id) return;
            setSamples((prev) => [...prev.slice(-(KEPT * 5 - 1)), sample]);
        });
        return () => {
            live = false;
            off();
        };
    }, [server.id]);

    if (server.processes.length === 0) {
        return <div className="empty"><p>Nothing is running yet.</p></div>;
    }

    return (
        <div className="stats">
            <p className="faint sm">The last {Math.round((KEPT * 3) / 60)} minutes, one reading every 3 seconds. CPU is a percentage of one core, so a busy server can pass 100.</p>
            <Players server={server} />
            {server.processes.map((proc) => {
                const own = samples.filter((s) => s.process === proc.name).slice(-KEPT);
                const memory = own.map((s) => s.memoryMb);
                const cpu = own.map((s) => s.cpu);
                // Only game servers report a tick rate, and only once running; the proxy and a fresh server have none.
                const tps = own.flatMap((s) => (s.tps === undefined ? [] : [s.tps]));
                const mspt = own.flatMap((s) => (s.mspt === undefined ? [] : [s.mspt]));
                return (
                    <div key={proc.name} className="card" style={{ marginBottom: 14 }}>
                        <div className="card-head">
                            <h2><span className={`dot ${proc.state}`} /> {proc.name}</h2>
                            <span className="faint sm">port {proc.port}</span>
                        </div>
                        <div className="card-body graphs">
                            {own.length === 0 ? (
                                <p className="faint sm">{proc.state === "running" || proc.state === "starting" ? "Waiting for the first reading..." : "Not running."}</p>
                            ) : (
                                <>
                                    <div>
                                        <div className="faint sm">Memory</div>
                                        <Graph values={memory} max={Math.max(256, ...memory) * 1.15} unit="MB" color="var(--accent)" />
                                    </div>
                                    <div>
                                        <div className="faint sm">CPU</div>
                                        <Graph values={cpu} max={Math.max(100, ...cpu) * 1.1} unit="%" color="var(--warn)" />
                                    </div>
                                    {tps.length > 0 && (
                                        <div>
                                            <div className="faint sm">TPS</div>
                                            <Graph values={tps} max={20} unit="tps" color="var(--success)" decimals reference={{ at: 20, label: "20 (full speed)" }} />
                                        </div>
                                    )}
                                    {mspt.length > 0 && (
                                        <div>
                                            <div className="faint sm">MSPT</div>
                                            <Graph values={mspt} max={Math.max(60, ...mspt) * 1.1} unit="ms" color="var(--danger)" decimals reference={{ at: 50, label: "50 ms (budget per tick)" }} />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
