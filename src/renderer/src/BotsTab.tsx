import { useEffect, useState } from "react";
import type { BotAction, BotEvent, BotView } from "@shared/bots";
import type { ServerView } from "@shared/types";
import { botsApi } from "./ext";

const FEED_LINES = 200;

export function BotsTab({ server }: { server: ServerView }) {
    const [bots, setBots] = useState<BotView[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [feed, setFeed] = useState<BotEvent[]>([]);
    const [count, setCount] = useState(1);
    const [prefix, setPrefix] = useState("Bot");
    const [message, setMessage] = useState("");
    const [target, setTarget] = useState({ x: "0", y: "64", z: "0" });
    const [follow, setFollow] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void botsApi.list(server.id).then(setBots);
        const offBots = botsApi.onBots((all) => setBots(all.filter((b) => b.serverId === server.id)));
        const offEvents = botsApi.onEvent((event) => {
            if (event.serverId === server.id) setFeed((prev) => [...prev.slice(-(FEED_LINES - 1)), event]);
        });
        return () => {
            offBots();
            offEvents();
        };
    }, [server.id]);

    // Actions go to the ticked bots, or to every bot when none is ticked.
    const targets = selected.size > 0 ? [...selected].filter((n) => bots.some((b) => b.name === n)) : bots.map((b) => b.name);

    const act = (action: BotAction) => {
        setError(null);
        botsApi.act(server.id, targets, action).catch((e: Error) => setError(e.message));
    };

    const summon = () => {
        setError(null);
        botsApi.summon(server.id, count, prefix).catch((e: Error) => setError(e.message));
    };

    const toggle = (name: string) => {
        const next = new Set(selected);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setSelected(next);
    };

    const running = server.state === "running";
    // Bots have no Mojang account, so they only join offline-mode servers.
    const blocked = server.onlineMode;
    const canSummon = running && !blocked;

    return (
        <div className="bots">
            <div className="bots-left">
                <div className="summon">
                    <input className="input" style={{ width: 140 }} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Name prefix" />
                    <input className="input" style={{ width: 80 }} type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
                    <button className="btn primary" onClick={summon} disabled={!canSummon}>Summon</button>
                    <span className="faint sm" style={{ marginLeft: "auto" }}>
                        {blocked
                            ? "Bots need offline mode. Deploy with Online mode off, or as a network, to use them."
                            : running ? `${bots.filter((b) => b.state === "online").length} online` : "Start the server to summon bots"}
                    </span>
                </div>
                {error && <div className="error-box">{error}</div>}
                <div className="card bot-table">
                    <table>
                        <thead>
                            <tr>
                                <th style={{ width: 36 }}>
                                    <input
                                        type="checkbox"
                                        checked={bots.length > 0 && selected.size === bots.length}
                                        onChange={(e) => setSelected(e.target.checked ? new Set(bots.map((b) => b.name)) : new Set())}
                                    />
                                </th>
                                <th>Bot</th>
                                <th>Health</th>
                                <th>Position</th>
                                <th>Doing</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bots.map((b) => (
                                <tr key={b.name} className={`pick ${selected.has(b.name) ? "selected" : ""}`} onClick={() => toggle(b.name)}>
                                    <td><input type="checkbox" checked={selected.has(b.name)} readOnly /></td>
                                    <td>
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                            <span className={`dot ${b.state === "online" ? "running" : b.state}`} /> {b.name}
                                        </span>
                                    </td>
                                    <td className="mono">{b.health !== undefined ? `${Math.round(b.health)} / ${Math.round(b.food ?? 0)}` : "-"}</td>
                                    <td className="mono">{b.position ? `${b.position.x} ${b.position.y} ${b.position.z}` : "-"}</td>
                                    <td className="subtle" title={b.reason}>{b.state === "disconnected" ? (b.reason ?? "disconnected") : b.activity}</td>
                                </tr>
                            ))}
                            {bots.length === 0 && (
                                <tr><td colSpan={5} className="faint" style={{ textAlign: "center", padding: 28 }}>No bots yet.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="actions">
                <div className="card">
                    <div className="card-head">
                        <h2>Actions</h2>
                        <span className="badge accent">{selected.size > 0 ? `${targets.length} selected` : "all bots"}</span>
                    </div>
                    <div className="card-body">
                        <div className="input-row">
                            <input
                                className="input"
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && message.trim()) {
                                        act({ kind: "chat", text: message.trim() });
                                        setMessage("");
                                    }
                                }}
                                placeholder="Chat, or /command"
                            />
                            <button className="btn" disabled={!message.trim()} onClick={() => { act({ kind: "chat", text: message.trim() }); setMessage(""); }}>Send</button>
                        </div>
                        <div className="grid-3">
                            <button className="btn sm" onClick={() => act({ kind: "wander" })}>Wander</button>
                            <button className="btn sm" onClick={() => act({ kind: "jump" })}>Jump</button>
                            <button className="btn sm" onClick={() => act({ kind: "stop" })}>Stop</button>
                            <button className="btn sm" onClick={() => act({ kind: "sneak", on: true })}>Sneak</button>
                            <button className="btn sm" onClick={() => act({ kind: "sneak", on: false })}>Stand</button>
                            <button className="btn sm" onClick={() => act({ kind: "attack" })}>Attack</button>
                            <button className="btn sm" onClick={() => act({ kind: "use" })}>Use item</button>
                            <button className="btn sm" onClick={() => act({ kind: "useBlock" })}>Use block</button>
                            <button className="btn sm" onClick={() => act({ kind: "fish" })}>Fish</button>
                            <button className="btn sm" onClick={() => act({ kind: "look", yaw: Math.random() * 360, pitch: 0 })}>Turn</button>
                        </div>
                        <div className="input-row">
                            {(["x", "y", "z"] as const).map((axis) => (
                                <input key={axis} className="input" value={target[axis]} placeholder={axis} onChange={(e) => setTarget({ ...target, [axis]: e.target.value })} />
                            ))}
                            <button className="btn" onClick={() => act({ kind: "goto", x: Number(target.x), y: Number(target.y), z: Number(target.z) })}>Walk to</button>
                        </div>
                        <div className="input-row">
                            <input className="input" value={follow} onChange={(e) => setFollow(e.target.value)} placeholder="Player name" />
                            <button className="btn" disabled={!follow.trim()} onClick={() => act({ kind: "follow", player: follow.trim() })}>Follow</button>
                        </div>
                        <div className="grid-2">
                            <select className="input" defaultValue="" onChange={(e) => { if (e.target.value) act({ kind: "hotbar", slot: Number(e.target.value) }); e.target.value = ""; }}>
                                <option value="">Hotbar slot...</option>
                                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => <option key={s} value={s}>Slot {s + 1}</option>)}
                            </select>
                            <button className="btn danger" onClick={() => { act({ kind: "disconnect" }); setSelected(new Set()); }}>Disconnect</button>
                        </div>
                        <p className="faint sm">Bots join offline, not as op. To op one: <span className="mono">op {bots[0]?.name ?? "Bot1"}</span> in the console.</p>
                    </div>
                </div>
                <div className="card">
                    <div className="card-head"><h2>What bots see</h2><button className="btn sm ghost" onClick={() => setFeed([])}>Clear</button></div>
                    <div className="card-body">
                        <div className="feed">
                            {feed.length === 0 && <span className="faint">Chat and kicks show up here.</span>}
                            {feed.map((e, i) => <div key={i}><b>{e.bot}</b> {e.text}</div>)}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
