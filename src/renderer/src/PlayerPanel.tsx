import { useEffect, useRef, useState } from "react";
import type { InventoryItem, PlayerAction, PlayerInfo, ServerView } from "@shared/types";
import { confirm } from "./confirm";
import { Refresh } from "./icons";

const api = window.testbench;
const describe = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const short = (id: string) => id.replace(/^minecraft:/, "").replace(/_/g, " ");
const round = (n: number) => Math.round(n * 10) / 10;
/** How often an open player is read again. The reads are hidden from the console, so polling adds nothing there. */
const POLL_MS = 3_000;

/** Offered when adding an enchantment; any other id can still be typed. */
const ENCHANTMENTS = [
    "aqua_affinity", "bane_of_arthropods", "binding_curse", "blast_protection", "breach", "channeling", "density",
    "depth_strider", "efficiency", "feather_falling", "fire_aspect", "fire_protection", "flame", "fortune",
    "frost_walker", "impaling", "infinity", "knockback", "looting", "loyalty", "luck_of_the_sea", "lunge", "lure",
    "mending", "multishot", "piercing", "power", "projectile_protection", "protection", "punch", "quick_charge",
    "respiration", "riptide", "sharpness", "silk_touch", "smite", "soul_speed", "sweeping_edge", "swift_sneak",
    "thorns", "unbreaking", "vanishing_curse", "wind_burst",
];

/** Edits one stack where it lies: amount, name, enchantments, or gone. Each change is sent as it is made. */
function SlotEditor({ item, at, onAction, onClose }: { item: InventoryItem; at: { x: number; y: number }; onAction: (action: PlayerAction) => void; onClose: () => void }) {
    const [count, setCount] = useState(String(item.count));
    const [name, setName] = useState(item.name ?? "");
    const [adding, setAdding] = useState({ id: "", level: "1" });
    const slot = item.slot;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const enter = (run: () => void) => (e: React.KeyboardEvent) => e.key === "Enter" && run();
    const setAmount = () => onAction({ kind: "count", slot, count: Number(count) });
    const rename = () => onAction({ kind: "name", slot, name });
    const enchant = () => {
        if (!adding.id.trim()) return;
        onAction({ kind: "enchant", slot, enchantment: adding.id, level: Number(adding.level) });
        setAdding({ id: "", level: "1" });
    };

    return (
        <>
            <div className="menu-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
            <div className="context-menu slot-editor" style={{ left: Math.max(8, Math.min(at.x, window.innerWidth - 310)), top: Math.max(8, Math.min(at.y, window.innerHeight - 360)) }}>
                <div className="menu-label">{short(item.id)} <span className="faint">slot {slot}</span></div>
                <div className="editor-row">
                    <span>Amount</span>
                    <input className="input mono sm-input" type="number" min={1} max={99} value={count} onChange={(e) => setCount(e.target.value)} onKeyDown={enter(setAmount)} />
                    <button className="btn sm" onClick={setAmount}>Set</button>
                </div>
                <div className="editor-row">
                    <span>Name</span>
                    <input className="input sm" value={name} maxLength={50} placeholder="none" onChange={(e) => setName(e.target.value)} onKeyDown={enter(rename)} />
                    <button className="btn sm" onClick={rename}>{name.trim() ? "Set" : "Clear"}</button>
                </div>
                <div className="menu-sep" />
                <div className="menu-label">Enchantments</div>
                {Object.entries(item.enchantments ?? {}).map(([id, level]) => {
                    const change = (value: string) => Number(value) !== level && onAction({ kind: "enchant", slot, enchantment: id, level: Number(value) });
                    return (
                        <div key={id} className="editor-row">
                            <span className="grow">{short(id)}</span>
                            <input
                                key={level}
                                className="input mono sm-input"
                                type="number"
                                min={1}
                                max={255}
                                defaultValue={level}
                                onKeyDown={(e) => e.key === "Enter" && change(e.currentTarget.value)}
                                onBlur={(e) => change(e.target.value)}
                            />
                            <button className="btn sm ghost danger-text" title="Remove" onClick={() => onAction({ kind: "enchant", slot, enchantment: id, level: 0 })}>x</button>
                        </div>
                    );
                })}
                <div className="editor-row">
                    <input className="input sm" list="enchantment-ids" placeholder="add enchantment" value={adding.id} onChange={(e) => setAdding({ ...adding, id: e.target.value })} onKeyDown={enter(enchant)} />
                    <input className="input mono sm-input" type="number" min={1} max={255} value={adding.level} onChange={(e) => setAdding({ ...adding, level: e.target.value })} onKeyDown={enter(enchant)} />
                    <button className="btn sm" onClick={enchant} disabled={!adding.id.trim()}>Add</button>
                </div>
                <datalist id="enchantment-ids">{ENCHANTMENTS.map((e) => <option key={e} value={e} />)}</datalist>
                <div className="menu-sep" />
                <button className="danger" onClick={() => { onAction({ kind: "remove", slot }); onClose(); }}>Remove item</button>
            </div>
        </>
    );
}

/** Item textures by id, kept for the session: the same few items come back on every refresh. */
const icons = new Map<string, string | null>();

function useIcons(serverId: string, ids: string[]): Map<string, string | null> {
    const [, redraw] = useState(0);
    const missing = [...new Set(ids)].filter((id) => !icons.has(id));
    useEffect(() => {
        if (missing.length === 0) return;
        // Failing that (offline, say), the slots keep their names.
        api.itemIcons(serverId, missing).then((found) => {
            for (const [id, url] of Object.entries(found)) icons.set(id, url);
            redraw((n) => n + 1);
        }, (e) => console.warn("Item icons unavailable:", describe(e)));
    }, [serverId, missing.join()]);
    return icons;
}

/** The hover text: id, amount, slot, then name and enchantments when it has them. */
function describeItem(item: InventoryItem): string {
    const lines = [`${item.name ? `"${item.name}" ` : ""}${item.id} x${item.count} (slot ${item.slot})`];
    for (const [id, level] of Object.entries(item.enchantments ?? {})) lines.push(`  ${short(id)} ${level}`);
    return lines.join("\n");
}

/**
 * The 36 inventory slots as the game draws them: the three rows of storage, then the hotbar. A stack dragged
 * onto an empty slot moves there; onto a full one, the two swap. Right-click edits a stack.
 */
function Inventory({ serverId, items, onMove, onEdit, onDragging }: {
    serverId: string;
    items: InventoryItem[];
    onMove: (from: number, to: number) => void;
    onEdit: (slot: number, at: { x: number; y: number }) => void;
    onDragging: (dragging: boolean) => void;
}) {
    const at = new Map(items.map((i) => [i.slot, i]));
    const textures = useIcons(serverId, items.map((i) => i.id));
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const cell = (slot: number) => {
        const item = at.get(slot);
        const icon = item && textures.get(item.id);
        return (
            <div
                key={slot}
                className={`slot ${item ? "full" : ""} ${slot < 9 ? "hotbar" : ""} ${dragging === slot ? "dragging" : ""} ${over === slot && dragging !== slot ? "target" : ""}`}
                title={item ? describeItem(item) : `slot ${slot}`}
                draggable={Boolean(item)}
                onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(slot);
                    onDragging(true);
                }}
                onDragEnd={() => {
                    setDragging(null);
                    onDragging(false);
                    setOver(null);
                }}
                onDragOver={(e) => {
                    if (dragging === null) return;
                    e.preventDefault();
                    setOver(slot);
                }}
                onDragLeave={() => setOver((o) => (o === slot ? null : o))}
                onContextMenu={(e) => {
                    if (!item) return;
                    e.preventDefault();
                    onEdit(slot, { x: e.clientX, y: e.clientY });
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    if (dragging !== null && dragging !== slot) onMove(dragging, slot);
                    setDragging(null);
                    onDragging(false);
                    setOver(null);
                }}
            >
                {item && (
                    <>
                        {icon ? <img className="slot-icon" src={icon} alt={short(item.id)} /> : <span className="slot-name">{short(item.id)}</span>}
                        {item.count > 1 && <span className="slot-count">{item.count}</span>}
                        {item.enchantments && <span className="slot-glint" />}
                    </>
                )}
            </div>
        );
    };
    const extra = items.filter((i) => i.slot < 0 || i.slot > 35);
    return (
        <>
            <div className="inventory">
                {Array.from({ length: 27 }, (_, i) => cell(i + 9))}
                {Array.from({ length: 9 }, (_, i) => cell(i))}
            </div>
            {extra.length > 0 && <p className="faint sm">Also: {extra.map((i) => `${short(i.id)} x${i.count}`).join(", ")}</p>}
        </>
    );
}

/** One online player: where they are, how they are, what they carry, and the usual admin actions. */
export function PlayerPanel({ server, player, others, onClose }: { server: ServerView; player: string; others: string[]; onClose: () => void }) {
    const [info, setInfo] = useState<PlayerInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [to, setTo] = useState({ x: "0", y: "64", z: "0" });
    const [give, setGive] = useState({ item: "minecraft:diamond", count: "1" });
    const [editing, setEditing] = useState<{ slot: number; at: { x: number; y: number } } | null>(null);
    // A poll waits while a stack is dragged or edited, so nothing moves under the cursor.
    const hold = useRef({ dragging: false, editing: false });
    hold.current.editing = editing !== null;

    const load = () => {
        setLoading(true);
        api.playerInfo(server.id, player).then((i) => { setInfo(i); setError(null); }, (e) => setError(describe(e))).finally(() => setLoading(false));
    };
    useEffect(load, [server.id, player]);

    useEffect(() => {
        let reading = false;
        const timer = setInterval(() => {
            if (reading || hold.current.dragging || hold.current.editing) return;
            reading = true;
            api.playerInfo(server.id, player).then((i) => { setInfo(i); setError(null); }, (e) => setError(describe(e))).finally(() => { reading = false; });
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [server.id, player]);

    /** Sends the action, then reads the player again: the reads queue behind it on the server, so they see its result. */
    const act = (action: PlayerAction) => {
        api.playerAction(server.id, player, action).then(load, (e) => {
            setError(describe(e));
            load();
        });
    };

    /** Shown moved at once, then read back; a swap goes through a free slot, since the game has no swap. */
    const move = (from: number, to: number) => {
        if (!info) return;
        const taken = new Set(info.inventory.map((i) => i.slot));
        let via: number | undefined;
        if (taken.has(to)) {
            via = Array.from({ length: 36 }, (_, i) => i).find((i) => !taken.has(i));
            if (via === undefined) {
                setError("The inventory is full, so two stacks cannot swap. Free a slot first.");
                return;
            }
        }
        setInfo({ ...info, inventory: info.inventory.map((i) => (i.slot === from ? { ...i, slot: to } : i.slot === to ? { ...i, slot: from } : i)) });
        act({ kind: "move", from, to, via });
    };

    return (
        <div className="card player-panel">
            <div className="card-head">
                <h2>{player}</h2>
                {info && <span className="faint sm">on {info.process}</span>}
                {info?.op && <span className="badge accent">op</span>}
                {info?.gameMode && <span className="badge">{info.gameMode}</span>}
                <span className="grow" />
                <button className="btn sm ghost" onClick={load} disabled={loading}><Refresh /> {loading ? "Reading..." : "Refresh"}</button>
                <button className="btn sm ghost" onClick={onClose}>Close</button>
            </div>
            <div className="card-body">
                {error && <div className="error-box" style={{ marginBottom: 10 }}>{error}</div>}
                {info && (
                    <>
                        <dl className="facts" style={{ marginBottom: 12 }}>
                            <div><dt>Position</dt><dd className="mono">{info.position ? `${round(info.position.x)}, ${round(info.position.y)}, ${round(info.position.z)}` : "unknown"} {info.dimension && <span className="faint">in {short(info.dimension)}</span>}</dd></div>
                            <div><dt>Health</dt><dd>{info.health !== undefined ? `${round(info.health)} / 20` : "unknown"}</dd></div>
                            <div><dt>Food</dt><dd>{info.food ?? "unknown"} / 20</dd></div>
                            <div><dt>Level</dt><dd>{info.xpLevel ?? "unknown"}</dd></div>
                        </dl>
                        <Inventory
                            serverId={server.id}
                            items={info.inventory}
                            onMove={move}
                            onEdit={(slot, at) => setEditing({ slot, at })}
                            onDragging={(d) => { hold.current.dragging = d; }}
                        />
                    </>
                )}

                {editing && info && (() => {
                    const item = info.inventory.find((i) => i.slot === editing.slot);
                    return item && <SlotEditor key={`${item.slot} ${item.id}`} item={item} at={editing.at} onAction={act} onClose={() => setEditing(null)} />;
                })()}

                <div className="player-actions">
                    <div className="input-row">
                        {(["x", "y", "z"] as const).map((k) => (
                            <input key={k} className="input mono sm-input" value={to[k]} onChange={(e) => setTo({ ...to, [k]: e.target.value })} placeholder={k} aria-label={k} />
                        ))}
                        <button className="btn sm" onClick={() => act({ kind: "teleport", x: Number(to.x), y: Number(to.y), z: Number(to.z) })}>Teleport</button>
                        {others.length > 0 && (
                            <select className="input sm" value="" onChange={(e) => e.target.value && act({ kind: "teleportTo", target: e.target.value })}>
                                <option value="">to player...</option>
                                {others.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                        )}
                    </div>
                    <div className="input-row">
                        <input className="input mono" value={give.item} onChange={(e) => setGive({ ...give, item: e.target.value })} placeholder="minecraft:diamond" />
                        <input className="input mono sm-input" value={give.count} onChange={(e) => setGive({ ...give, count: e.target.value })} aria-label="count" />
                        <button className="btn sm" onClick={() => act({ kind: "give", item: give.item, count: Number(give.count) })}>Give</button>
                    </div>
                    <div className="input-row wrap">
                        <button className="btn sm ghost" onClick={() => act({ kind: info?.op ? "deop" : "op" })}>{info?.op ? "Deop" : "Op"}</button>
                        {(["survival", "creative", "adventure", "spectator"] as const).map((mode) => (
                            <button key={mode} className={`btn sm ${info?.gameMode === mode ? "" : "ghost"}`} onClick={() => act({ kind: "gamemode", mode })}>{mode}</button>
                        ))}
                        <button className="btn sm ghost" onClick={() => act({ kind: "heal" })}>Heal</button>
                        <button className="btn sm ghost" onClick={() => act({ kind: "feed" })}>Feed</button>
                        <button className="btn sm ghost danger-text" onClick={async () => (await confirm(`Clear ${player}'s inventory?`, { action: "Clear" })) && act({ kind: "clear" })}>Clear inventory</button>
                        <button className="btn sm ghost danger-text" onClick={async () => (await confirm(`Kick ${player}?`, { action: "Kick" })) && act({ kind: "kick" })}>Kick</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
