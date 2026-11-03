import { EventEmitter } from "node:events";
import mineflayer, { type Bot } from "mineflayer";
import pathfinderPlugin from "mineflayer-pathfinder";
import type { BotAction, BotEvent, BotView } from "@shared/bots";

const { pathfinder, Movements, goals } = pathfinderPlugin;

/** Bots join one at a time this far apart, so a server sees a queue of logins rather than a burst. */
const JOIN_SPACING_MS = 600;
const WANDER_RADIUS = 12;

interface Entry {
    view: BotView;
    bot: Bot;
    wander?: NodeJS.Timeout;
    /** True while the bot keeps casting; stop and disconnect clear it. */
    fishing?: boolean;
}

/**
 * Test players driven from the Bots tab. They are mineflayer clients in offline mode, which is why test
 * servers run with online-mode off. A bot speaks [version]; ViaBackwards on the server lets it join a
 * newer one, since mineflayer trails the newest Minecraft release.
 */
export class Bots extends EventEmitter {
    private readonly bots = new Map<string, Entry>();
    private publishQueued = false;

    list(serverId?: string): BotView[] {
        return [...this.bots.values()].map((e) => e.view).filter((v) => !serverId || v.serverId === serverId);
    }

    async summon(serverId: string, host: string, port: number, version: string, count: number, prefix: string): Promise<void> {
        const base = (prefix.trim() || "Bot").replace(/[^A-Za-z0-9_]/g, "").slice(0, 12) || "Bot";
        let n = 1;
        for (let made = 0; made < Math.min(count, 50); made++) {
            while (this.bots.has(key(serverId, `${base}${n}`))) n++;
            this.spawn(serverId, host, port, version, `${base}${n}`);
            n++;
            await new Promise((r) => setTimeout(r, JOIN_SPACING_MS));
        }
    }

    act(serverId: string, names: string[], action: BotAction): void {
        for (const name of names) {
            const entry = this.bots.get(key(serverId, name));
            if (!entry) continue;
            try {
                this.apply(entry, action);
            } catch (error) {
                this.event(entry, `Could not ${action.kind}: ${(error as Error).message}`);
            }
        }
        this.publish();
    }

    /** Called when a server is deleted: its bots have nowhere left to be. */
    removeAll(serverId: string): void {
        for (const entry of [...this.bots.values()]) {
            if (entry.view.serverId === serverId) this.remove(entry);
        }
        this.publish();
    }

    private spawn(serverId: string, host: string, port: number, version: string, name: string): void {
        const bot = mineflayer.createBot({ host, port, username: name, auth: "offline", version, hideErrors: true });
        bot.loadPlugin(pathfinder);
        const entry: Entry = { bot, view: { name, serverId, state: "connecting", activity: "joining" } };
        this.guardPackets(entry);
        this.bots.set(key(serverId, name), entry);
        this.publish();

        bot.once("spawn", () => {
            entry.view.state = "online";
            entry.view.activity = "idle";
            const movements = new Movements(bot);
            movements.canDig = false;
            bot.pathfinder.setMovements(movements);
            this.event(entry, "joined");
            this.publish();
        });
        bot.on("health", () => this.publish());
        bot.on("move", () => this.publish());
        bot.on("messagestr", (message, position) => {
            // Every bot hears the same chat; only the first one online on this server reports it, or ten
            // bots would show each line ten times.
            if (position !== "game_info" && this.listener(serverId) === entry) this.event(entry, message);
        });
        bot.on("goal_reached", () => {
            if (!entry.wander) {
                entry.view.activity = "idle";
                this.publish();
            }
        });
        bot.on("kicked", (reason) => {
            entry.view.reason = typeof reason === "string" ? reason : JSON.stringify(reason);
            this.event(entry, `kicked: ${entry.view.reason}`);
        });
        bot.on("error", (error) => {
            entry.view.reason = error.message;
            this.event(entry, `error: ${error.message}`);
        });
        bot.on("end", () => {
            if (entry.wander) clearInterval(entry.wander);
            entry.wander = undefined;
            entry.view.state = "disconnected";
            entry.view.activity = "offline";
            this.publish();
        });
    }

    private apply(entry: Entry, action: BotAction): void {
        const { bot } = entry;
        if (action.kind === "disconnect") {
            this.remove(entry);
            return;
        }
        if (entry.view.state !== "online") throw new Error("not online");
        switch (action.kind) {
            case "chat":
                // mineflayer sends a leading slash as a command packet, so commands and chat share one box.
                bot.chat(action.text);
                return;
            case "goto":
                this.stopMoving(entry);
                bot.pathfinder.setGoal(new goals.GoalNear(action.x, action.y, action.z, 1));
                entry.view.activity = `walking to ${action.x} ${action.y} ${action.z}`;
                return;
            case "follow": {
                const target = bot.players[action.player]?.entity;
                if (!target) throw new Error(`${action.player} is not in view`);
                this.stopMoving(entry);
                bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                entry.view.activity = `following ${action.player}`;
                return;
            }
            case "wander":
                this.stopMoving(entry);
                entry.wander = setInterval(() => this.wanderStep(entry), 4_000);
                this.wanderStep(entry);
                entry.view.activity = "wandering";
                return;
            case "stop":
                this.stopMoving(entry);
                entry.view.activity = "idle";
                return;
            case "jump":
                bot.setControlState("jump", true);
                setTimeout(() => bot.setControlState("jump", false), 350);
                return;
            case "sneak":
                bot.setControlState("sneak", action.on);
                return;
            case "look":
                void bot.look((action.yaw * Math.PI) / 180, (action.pitch * Math.PI) / 180, true);
                return;
            case "attack": {
                const target = bot.nearestEntity((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 4);
                if (!target) throw new Error("nothing within reach");
                bot.attack(target);
                return;
            }
            case "use":
                bot.activateItem();
                setTimeout(() => bot.deactivateItem(), 250);
                return;
            case "useBlock": {
                const block = bot.blockAtCursor(5);
                if (!block) throw new Error("no block in reach");
                void bot.activateBlock(block).catch((error: Error) => this.event(entry, `Could not use block: ${error.message}`));
                return;
            }
            case "hotbar":
                bot.setQuickBarSlot(Math.max(0, Math.min(8, action.slot)));
                return;
            case "fish":
                // bot.fish() casts, waits for the bite and reels in, which a timed "use" cannot.
                if (entry.fishing) return;
                entry.fishing = true;
                entry.view.activity = "fishing";
                void this.fishLoop(entry);
                return;
        }
    }

    /**
     * The bot libraries throw from inside their own packet listeners on input they do not understand - most
     * often a chat format they have no entry for, when ViaBackwards translates a newer server's chat. Such a
     * throw escapes to the top of the process. Catching it at the packet emitter turns it into a line in the
     * feed: the bot loses that one packet and keeps playing.
     */
    private guardPackets(entry: Entry): void {
        const client = entry.bot._client as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
        const emit = client.emit.bind(client);
        client.emit = (event, ...args) => {
            try {
                return emit(event, ...args);
            } catch (error) {
                this.event(entry, `could not read a ${String(event)} packet: ${(error as Error).message}`);
                return true;
            }
        };
    }

    private listener(serverId: string): Entry | undefined {
        return [...this.bots.values()].find((e) => e.view.serverId === serverId && e.view.state === "online");
    }

    private wanderStep(entry: Entry): void {
        const { bot } = entry;
        if (!bot.entity || bot.pathfinder.isMoving()) return;
        const p = bot.entity.position;
        const x = Math.round(p.x + (Math.random() * 2 - 1) * WANDER_RADIUS);
        const z = Math.round(p.z + (Math.random() * 2 - 1) * WANDER_RADIUS);
        bot.pathfinder.setGoal(new goals.GoalNearXZ(x, z, 1));
    }

    private async fishLoop(entry: Entry): Promise<void> {
        while (entry.fishing && entry.view.state === "online") {
            try {
                await entry.bot.fish();
                this.event(entry, "caught something");
            } catch (error) {
                // No rod in hand or no water ahead: stop rather than spin on the same failure.
                entry.fishing = false;
                entry.view.activity = "idle";
                this.event(entry, `stopped fishing: ${(error as Error).message}`);
            }
        }
        this.publish();
    }

    private stopMoving(entry: Entry): void {
        if (entry.fishing) {
            entry.fishing = false;
            entry.bot.activateItem();
        }
        if (entry.wander) clearInterval(entry.wander);
        entry.wander = undefined;
        entry.bot.pathfinder.setGoal(null);
        entry.bot.clearControlStates();
    }

    private remove(entry: Entry): void {
        if (entry.wander) clearInterval(entry.wander);
        entry.bot.removeAllListeners();
        // A listener-less client still emits "error" on a socket failure while closing; swallowing it here
        // is the point of quitting, so it is logged rather than left to crash the main process.
        entry.bot.on("error", (error) => console.warn(`Bot ${entry.view.name} errored while leaving`, error));
        entry.bot.quit();
        this.bots.delete(key(entry.view.serverId, entry.view.name));
        this.event(entry, "removed");
        this.publish();
    }

    private event(entry: Entry, text: string): void {
        const event: BotEvent = { bot: entry.view.name, serverId: entry.view.serverId, text };
        this.emit("event", event);
    }

    /** Movement fires many times a second; the UI gets at most four snapshots a second. */
    private publish(): void {
        if (this.publishQueued) return;
        this.publishQueued = true;
        setTimeout(() => {
            this.publishQueued = false;
            for (const entry of this.bots.values()) {
                const { bot, view } = entry;
                if (view.state !== "online" || !bot.entity) continue;
                view.health = bot.health;
                view.food = bot.food;
                const p = bot.entity.position;
                view.position = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
            }
            this.emit("bots", this.list());
        }, 250);
    }
}

function key(serverId: string, name: string): string {
    return `${serverId}/${name}`;
}
