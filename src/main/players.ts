import type { InventoryItem, PlayerAction } from "@shared/types";

/**
 * Reading a player through `data get entity <name> <path>`, whose answer is one console line:
 *   Steve has the following entity data: [0.5d, 64.0d, -3.2d]
 * The value is SNBT, Minecraft's text form of NBT. Only what the player view shows is parsed.
 */

/** What one `data get entity` prints: the value, or why there is none. */
export const ENTITY_REPLY = /has the following entity data: |No entity was found|Found no elements|Unknown or incomplete/;

/** The SNBT after "has the following entity data: ", or null if [line] is not such an answer. */
export function entityData(line: string): string | null {
    const at = line.indexOf("has the following entity data: ");
    return at < 0 ? null : line.slice(at + "has the following entity data: ".length).trim();
}

/** 20.0f, 64.5d, 3b, 12 -> a number. */
export function snbtNumber(value: string): number | null {
    const match = /^(-?\d+(?:\.\d+)?(?:E-?\d+)?)[bsLfd]?$/i.exec(value.trim());
    return match ? Number(match[1]) : null;
}

/** "minecraft:overworld" with or without its quotes. */
export function snbtString(value: string): string {
    return value.trim().replace(/^"(.*)"$/, "$1");
}

/** [0.5d, 64.0d, -3.2d] -> [0.5, 64, -3.2]. */
export function snbtNumbers(value: string): number[] {
    return value.trim().replace(/^\[|\]$/g, "").split(",").map((v) => snbtNumber(v) ?? NaN).filter((n) => !Number.isNaN(n));
}

/**
 * Walks SNBT outside of strings, calling [visit] with each structural character's index and the depth
 * before it. Strings may be in double or single quotes, the latter when the text holds a double quote.
 */
function walk(text: string, from: number, visit: (i: number, depth: number) => boolean | void): void {
    let depth = 0;
    let quote: string | null = null;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) {
                quote = null;
                if (visit(i, depth)) return;
            }
            continue;
        }
        if (visit(i, depth)) return;
        if (c === '"' || c === "'") quote = c;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
    }
}

/** The inside of each top-level compound of an SNBT list, nested values included. */
function compounds(list: string): string[] {
    const out: string[] = [];
    let start = 0;
    walk(list, 0, (i, depth) => {
        if (depth === 1 && list[i] === "{") start = i + 1;
        if (depth === 2 && list[i] === "}") out.push(list.slice(start, i));
    });
    return out;
}

/**
 * The value of [key] in the inside of a compound, at that compound's own level: the same key on an item
 * inside a shulker box, or inside a name's text, is never taken for it.
 */
export function field(inner: string, key: string): string | null {
    let found: string | null = null;
    walk(inner, 0, (i, depth) => {
        if (depth !== 0 || (i > 0 && !/[\s,]/.test(inner[i - 1])) || !inner.startsWith(`${key}:`, i)) return false;
        found = value(inner, i + key.length + 1);
        return true;
    });
    return found;
}

/** The one value starting at [from], after any spaces: a compound, a list, a string or a bare word. */
function value(text: string, from: number): string {
    let start = from;
    while (text[start] === " ") start++;
    let end = text.length;
    walk(text, start, (i, depth) => {
        const c = text[i];
        if ((c === '"' || c === "'") && depth === 0 && i > start) end = i + 1;
        else if ((c === "}" || c === "]") && depth === 1) end = i + 1;
        else if ((c === "," || c === "}" || c === "]") && depth === 0) end = i;
        else return false;
        return true;
    });
    return text.slice(start, end).trim();
}

const unquote = (s: string) => s.replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\\(.)/g, "$1");

/** Enchantment levels by id. Before 1.21.5 the component wraps them in "levels"; from it, it is the map itself. */
function enchantments(component: string | null): Record<string, number> | undefined {
    if (!component?.startsWith("{")) return undefined;
    const inner = component.slice(1, -1);
    const levels = field(inner, "levels");
    const map = levels ? levels.slice(1, -1) : inner;
    const out: Record<string, number> = {};
    for (const [, id, level] of map.matchAll(/"?([a-z0-9_.-]+:[a-z0-9_./-]+)"?:\s*(\d+)/g)) out[id] = Number(level);
    return Object.keys(out).length > 0 ? out : undefined;
}

/** A custom name as plain text, stored as a string, a text compound, or the JSON text of older versions. */
function plainName(component: string | null): string | undefined {
    if (!component) return undefined;
    if (component.startsWith("{")) {
        const text = field(component.slice(1, -1), "text");
        return text ? unquote(text) : undefined;
    }
    const raw = unquote(component);
    const json = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    return json ? json[1] : raw;
}

/** [{count: 1, Slot: 0b, id: "minecraft:stone"}, ...] -> the items, by slot, with their enchantments and name. */
export function inventory(snbt: string): InventoryItem[] {
    return compounds(snbt).flatMap((item) => {
        const slot = field(item, "Slot");
        const id = field(item, "id");
        const count = field(item, "count");
        if (!slot || !id) return [];
        const components = field(item, "components")?.slice(1, -1) ?? "";
        const enchants = enchantments(field(components, '"minecraft:enchantments"') ?? field(components, '"minecraft:stored_enchantments"'));
        const name = plainName(field(components, '"minecraft:custom_name"'));
        return [{
            slot: snbtNumber(slot) ?? 0,
            id: unquote(id),
            count: count ? snbtNumber(count) ?? 1 : 1,
            ...(enchants ? { enchantments: enchants } : {}),
            ...(name !== undefined ? { name } : {}),
        }];
    }).sort((a, b) => a.slot - b.slot);
}

const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;

export function gameMode(value: string): (typeof GAME_MODES)[number] | undefined {
    const n = snbtNumber(value);
    return n === null ? undefined : GAME_MODES[n];
}

const NAME = /^\w{1,16}$/;
const ITEM = /^[a-z0-9_.-]+(:[a-z0-9_./-]+)?$/;

/** Refusals: the command did nothing, and the answer is shown to the person instead. */
const REFUSALS = "Unable to apply|Failed to parse|Target doesn't have|Expected|Invalid|Unknown enchantment|No targets accepted|No player was found|No entity was found|Unknown item|Unknown or incomplete|Incorrect argument";

/**
 * The game's one-line answer to each command [actionCommands] sends, taken out of the console. From 26.1 the
 * server logs what it says to the console as "System chat: ...".
 */
export const ACTION_REPLY = new RegExp(`^\\[\\d\\d:\\d\\d:\\d\\d INFO\\]: (System chat: )?(Modified |Applied item modifier|Teleported|Gave |Made \\w+ (a|no longer a) server operator|Nothing changed|Set \\w+'s game mode|Applied effect|Removed \\d+ item|No items were found|Kicked |Replaced a slot|${REFUSALS})`);

export const ACTION_REFUSED = new RegExp(`^(System chat: )?(${REFUSALS})`);

/** Inline item modifiers name their function under "type" from 26.1, and under "function" before it. */
const modifierKey = (mc: string) => (Number(mc.split(".")[0]) >= 26 ? "type" : "function");

const SLOT = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 35) throw new Error("Inventory slots are 0 to 35.");
    return `container.${n}`;
};

/**
 * The console commands for [action] on [player], checked so nothing typed can add a second command. A move
 * copies whole stacks with `item replace ... from`, so enchantments and names travel with them; a swap goes
 * through the empty slot [via], since the game has no swap.
 */
export function actionCommands(player: string, action: PlayerAction, mc: string): string[] {
    if (!NAME.test(player)) throw new Error("Not a player name.");
    if (action.kind === "move") {
        const from = SLOT(action.from);
        const to = SLOT(action.to);
        if (from === to) throw new Error("That is the same slot.");
        const copy = (target: string, source: string) => `item replace entity ${player} ${target} from entity ${player} ${source}`;
        const empty = (target: string) => `item replace entity ${player} ${target} with minecraft:air`;
        if (action.via === undefined) return [copy(to, from), empty(from)];
        const via = SLOT(action.via);
        if (via === from || via === to) throw new Error("A swap needs a third, empty slot.");
        return [copy(via, to), copy(to, from), copy(from, via), empty(via)];
    }
    // Item modifiers change the stack in place, so whatever else it carries is kept.
    const key = modifierKey(mc);
    const modify = (slot: number, modifier: string) => [`item modify entity ${player} ${SLOT(slot)} ${modifier}`];
    switch (action.kind) {
        case "count":
            if (!Number.isInteger(action.count) || action.count < 1 || action.count > 99) throw new Error("A stack holds 1 to 99.");
            return modify(action.slot, `{${key}:"minecraft:set_count",count:${action.count}}`);
        case "remove":
            return [`item replace entity ${player} ${SLOT(action.slot)} with minecraft:air`];
        case "enchant": {
            const id = action.enchantment.trim().toLowerCase();
            if (!ITEM.test(id)) throw new Error("An enchantment id looks like minecraft:sharpness.");
            if (!Number.isInteger(action.level) || action.level < 0 || action.level > 255) throw new Error("Levels run from 0 to 255; 0 removes it.");
            // Set rather than added to; the game drops an enchantment set to level 0.
            return modify(action.slot, `{${key}:"minecraft:set_enchantments",enchantments:{"${id.includes(":") ? id : `minecraft:${id}`}":${action.level}}}`);
        }
        case "name": {
            const name = action.name.trim();
            if (name.length > 50 || /[\u0000-\u001f]/.test(name)) throw new Error("A name is one line of up to 50 characters.");
            if (name === "") return modify(action.slot, `{${key}:"minecraft:set_components",components:{"!minecraft:custom_name":{}}}`);
            return modify(action.slot, `{${key}:"minecraft:set_name",target:"custom_name",name:"${name.replace(/["\\]/g, "\\$&")}"}`);
        }
        default:
            return [actionCommand(player, action)];
    }
}

function actionCommand(player: string, action: Exclude<PlayerAction, { kind: "move" | "count" | "remove" | "enchant" | "name" }>): string {
    const coordinate = (n: number) => {
        if (!Number.isFinite(n) || Math.abs(n) > 30_000_000) throw new Error("Coordinates must be numbers inside the world.");
        return String(n);
    };
    switch (action.kind) {
        case "teleport": return `tp ${player} ${coordinate(action.x)} ${coordinate(action.y)} ${coordinate(action.z)}`;
        case "teleportTo":
            if (!NAME.test(action.target)) throw new Error("Not a player name.");
            return `tp ${player} ${action.target}`;
        case "give": {
            const item = action.item.trim().toLowerCase();
            if (!ITEM.test(item)) throw new Error("An item id looks like minecraft:diamond.");
            const count = Math.round(action.count);
            if (!(count >= 1 && count <= 6400)) throw new Error("Give between 1 and 6400.");
            return `give ${player} ${item} ${count}`;
        }
        case "op": return `op ${player}`;
        case "deop": return `deop ${player}`;
        case "gamemode":
            if (!GAME_MODES.includes(action.mode)) throw new Error("Unknown game mode.");
            return `gamemode ${action.mode} ${player}`;
        case "heal": return `effect give ${player} minecraft:instant_health 1 20 true`;
        case "feed": return `effect give ${player} minecraft:saturation 1 20 true`;
        case "clear": return `clear ${player}`;
        case "kick": return `kick ${player} Kicked from the Testbench`;
    }
}
