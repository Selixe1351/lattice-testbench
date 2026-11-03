import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { isErrorLine, logText, playerEvent } from "@shared/console";
import type { ConsoleLine, DeployRequest, PlayerAction, PlayerInfo, MatrixTarget, ProcessView, ServerView, Settings, SnapshotInfo, Software, StatSample } from "@shared/types";
import type { Hooks, ProcessPlan } from "./extensions/hooks";
import type { ProcessInfo, ServerApi, ViewPatch } from "./extensions/types";
import { readServerZip, type Manifest } from "./import";
import * as players from "./players";
import type { Snapshots } from "./snapshots";
import * as textures from "./textures";
import { SERVER_ICON } from "./server-icon";
import { fetchCached, gamePlugins, JOLOKIA, serverJar, versions } from "./sources";
import { cpuPercent, jolokiaUrl, read as readStats, type Reading, tickRate } from "./stats";

export const LIFETIME_MS = 30 * 60_000;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const HISTORY_LINES = 5000;
const STOP_GRACE_MS = 30_000;
const PROXY_MEMORY_MB = 512;
const STATS_INTERVAL_MS = 3_000;
const STATS_KEPT = 200;
/** A tick rate older than this means the server stopped answering, which should show as a gap. */
const PROBE_FRESH_MS = 15_000;
/** The JMX-over-HTTP agent each game server runs, so the tick rate is read without sending it commands. */
const JOLOKIA_JAR = "jolokia.jar";
/** How long a save-all may take before a snapshot goes ahead without its confirmation. */
const SAVE_TIMEOUT_MS = 60_000;
const MATRIX_MAX = 8;
/** Console commands answer within a tick or two; a reply is over once the process is quiet this long. */
const REPLY_QUIET_MS = 700;
const REPLY_MAX_MS = 5_000;
const PLAYERS_KEPT = 200;
/** The boss bar that counts down to expiry; custom boss bars need a namespaced id. */
const EXPIRY_BAR = "testbench:expiry";
/**
 * A reply to a console command, as the server logs it: INFO with no plugin tag. Plugins that answer the console
 * sender show up this way, while their own logger lines carry a "[Plugin]" tag and are left alone.
 */
const COMMAND_REPLY = /^\[\d\d:\d\d:\d\d INFO\]: /;
/** A void world is one layer of air; players stand on this, around the world spawn. */
const PLATFORM_FILL = "fill -3 63 -3 3 63 3 minecraft:smooth_stone";
/** Each "not loaded" answer triggers the next try, so this bounds the wait in server ticks, not wall time. */
const PLATFORM_TRIES = 100;

/** One Java process: the single server, the proxy, or a backend. */
interface Proc {
    name: string;
    dir: string;
    port: number;
    software: Software;
    memoryMb: number;
    state: ProcessView["state"];
    child?: ChildProcessWithoutNullStreams;
    /** Where this run's Jolokia agent answers, once it has said so. */
    jolokia?: string;
    probed?: { tps?: number; mspt?: number; at: number };
    /** Set once a void world has had its spawn platform built, so a restart does not build it again. */
    platformBuilt?: boolean;
    /**
     * A query the app sent itself (completion help, player reads, extension queries): lines matching [pattern] are handed
     * to [take] instead of the console, so what the person was reading is not buried under it.
     */
    swallow?: { pattern: RegExp; take: (text: string) => void };
    /** The last query queued on this process: each waits for the one before, so replies are never mixed up. */
    queries?: Promise<unknown>;
    /** The expiry boss bar as last sent, so it is sent again only when it changes or the process restarts. */
    bar?: string;
    /** What the server's help listed, for console completion: root commands, and each one's next words. */
    commands?: { roots: string[]; children: Map<string, string[]> };
}

interface Instance {
    view: ServerView;
    /** What it was deployed from, so a snapshot can deploy it again. */
    request: DeployRequest;
    dir: string;
    procs: Proc[];
    history: ConsoleLine[];
    warned: boolean;
    destroying: boolean;
    stats: StatSample[];
    /** Which game server each online player is on, from its own join and leave lines. */
    where: Map<string, string>;
}

/**
 * Every test server the app owns. A server lives for [LIFETIME_MS] unless extended, and whatever ends it -
 * expiry, the delete button, quitting the app - stops its processes and deletes its folder. Nothing here
 * is meant to outlive the app: on start, any folder left by a crash is deleted too.
 */
export class Instances extends EventEmitter {
    private readonly instances = new Map<string, Instance>();
    private readonly ticker: NodeJS.Timeout;
    private readonly sampler: NodeJS.Timeout;
    private sampling = false;
    private lastReadings = new Map<number, { reading: Reading; at: number }>();

    constructor(
        private readonly serversDir: string,
        private readonly cacheDir: string,
        private readonly settings: () => Settings,
        private readonly snapshots: Snapshots,
        private readonly hooks: Hooks,
    ) {
        super();
        this.ticker = setInterval(() => this.tick(), 5_000);
        this.sampler = setInterval(() => void this.sample(), STATS_INTERVAL_MS);
    }

    /** Removes folders from a previous run that ended without cleaning up. */
    async purgeOrphans(): Promise<void> {
        try {
            await rm(this.serversDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
        } catch (error) {
            console.warn(`Could not clear ${this.serversDir}; leftover servers stay until something releases them`, error);
        }
        await mkdir(this.serversDir, { recursive: true });
    }

    list(): ServerView[] {
        return [...this.instances.values()].map((i) => i.view);
    }

    history(id: string): ConsoleLine[] {
        return this.instances.get(id)?.history ?? [];
    }

    /** The folder a server's files live in. */
    dir(id: string): string {
        const instance = this.instances.get(id);
        if (!instance) throw new Error("No such server");
        return instance.dir;
    }

    /** What an export writes beside [id]'s files, so importing the zip deploys the same server again. */
    manifest(id: string): Manifest {
        const instance = this.instances.get(id);
        if (!instance) throw new Error("No such server");
        return { name: instance.view.label, request: { ...instance.request, snapshot: undefined } };
    }

    deploy(request: DeployRequest): string {
        const instance = this.create(request);
        this.startPreparing(instance, request);
        return instance.view.id;
    }

    /**
     * Deploys the same request on one single server per target, so a plugin can be checked against every
     * software and version it claims at once.
     */
    deployMatrix(request: DeployRequest, targets: MatrixTarget[]): string {
        if (targets.length === 0) throw new Error("Pick at least one software and version.");
        if (targets.length > MATRIX_MAX) throw new Error(`A matrix runs at most ${MATRIX_MAX} servers at once.`);
        const matrix = `matrix-${Date.now().toString(36)}`;
        for (const t of targets) {
            const cell: DeployRequest = { ...request, software: t.software, version: t.version, backendSoftware: undefined, backends: undefined };
            this.startPreparing(this.create(cell, matrix), cell);
        }
        return matrix;
    }

    private create(request: DeployRequest, matrix?: string): Instance {
        // The random tail keeps ids apart when a matrix creates several in the same millisecond.
        const id = `${request.software}-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
        const now = Date.now();
        const view: ServerView = {
            id,
            label: request.software === "velocity" ? `Network ${request.version}` : `${capitalize(request.software)} ${request.version}`,
            software: request.software,
            version: request.version,
            modules: [],
            uses: [],
            onlineMode: request.onlineMode,
            address: "",
            state: "preparing",
            processes: [],
            createdAt: now,
            expiresAt: now + LIFETIME_MS,
            errors: 0,
            moduleStatus: {},
            kept: false,
            ...(matrix ? { matrix } : {}),
            world: request.world ?? "normal",
            plugins: (request.plugins ?? []).map((file) => basename(file)),
            players: [],
        };
        const instance: Instance = { view, request, dir: join(this.serversDir, id), procs: [], history: [], warned: false, destroying: false, stats: [], where: new Map() };
        this.instances.set(id, instance);
        this.changed();
        return instance;
    }

    private startPreparing(instance: Instance, request: DeployRequest): void {
        instance.request = request;
        this.prepare(instance, request).catch((error: Error) => this.failPreparing(instance, error));
    }

    private failPreparing(instance: Instance, error: Error): void {
        instance.view.state = "failed";
        instance.view.error = error.message;
        this.log(instance, "app", `Deploy failed: ${error.message}`, "err");
        this.changed();
    }

    keep(id: string, kept: boolean): void {
        const instance = this.instances.get(id);
        if (!instance) return;
        instance.view.kept = kept;
        if (!kept) {
            // Back to a normal lifetime from now, not from a deadline that may have passed while kept.
            instance.view.expiresAt = Math.max(instance.view.expiresAt, Date.now() + LIFETIME_MS);
            instance.warned = false;
        }
        this.log(instance, "app", kept ? "Kept: it no longer expires. It still goes when deleted or when the app quits." : "Expires again in 30 minutes.", "out");
        this.changed();
    }

    /** Runs a 30 second spark profile. Paper, Purpur and Folia ship spark since 1.21; it prints the viewer link. */
    profile(id: string, process: string): void {
        const instance = this.instances.get(id);
        const proc = instance?.procs.find((p) => p.name === process);
        if (!instance || !proc?.child) throw new Error("That process is not running.");
        if (proc.software === "velocity") throw new Error("Velocity does not ship spark; profile a game server.");
        this.command(id, process, "spark profiler start --timeout 30");
    }

    /**
     * Saves [id] as a snapshot. Worlds are flushed and autosave paused first, so the zip never catches a
     * region file half written; autosave is turned back on whatever happens.
     */
    async snapshot(id: string, name: string): Promise<SnapshotInfo> {
        const instance = this.instances.get(id);
        if (!instance || instance.destroying) throw new Error("No such server");
        if (instance.view.state === "preparing") throw new Error("Wait until the server has finished preparing.");
        const live = instance.procs.filter((p) => p.child && p.software !== "velocity");
        try {
            for (const proc of live) this.command(id, proc.name, "save-off");
            await Promise.all(live.map(async (proc) => {
                const saved = this.waitFor(instance, proc.name, /Saved the game/, SAVE_TIMEOUT_MS);
                this.command(id, proc.name, "save-all flush");
                if (!(await saved)) this.log(instance, "app", `${proc.name} did not confirm its save in ${SAVE_TIMEOUT_MS / 1000}s; the snapshot may miss recent changes.`, "err");
            }));
            const info = await this.snapshots.save(instance.dir, name || instance.view.label, instance.request);
            this.log(instance, "app", `Snapshot "${info.name}" saved: ${info.files} files${info.skipped ? `, ${info.skipped} locked files skipped` : ""}.`, "out");
            return info;
        } finally {
            for (const proc of live) if (proc.child) this.command(id, proc.name, "save-on");
        }
    }

    /** Deploys a snapshot's server again, with its files laid over the fresh deploy. */
    async restore(snapshotId: string): Promise<string> {
        const info = await this.snapshots.get(snapshotId);
        const id = this.deploy({ ...info.request, snapshot: info.id });
        this.rename(id, info.name);
        return id;
    }

    /** Deploys a server zip, exported or zipped by hand, keeping it as a snapshot so it can be restored again. */
    async importZip(zip: string): Promise<string> {
        const server = await readServerZip(zip);
        return this.restore((await this.snapshots.adopt(zip, server)).id);
    }

    /** Resolves true when [process] of [instance] prints a line matching [pattern], false after [ms]. */
    private waitFor(instance: Instance, process: string, pattern: RegExp, ms: number): Promise<boolean> {
        return new Promise((resolve) => {
            const listener = (line: ConsoleLine) => {
                if (line.serverId === instance.view.id && line.process === process && pattern.test(line.text)) done(true);
            };
            const timer = setTimeout(() => done(false), ms);
            const done = (result: boolean) => {
                clearTimeout(timer);
                this.off("console", listener);
                resolve(result);
            };
            this.on("console", listener);
        });
    }

    /** The game server [player] is on, running, or an error saying why there is none. */
    private playerProc(instance: Instance, player: string): Proc {
        const name = instance.where.get(player) ?? (instance.procs.length === 1 ? "server" : null);
        const proc = name ? instance.procs.find((p) => p.name === name) : undefined;
        if (!proc) throw new Error(`${player} is not on any game server right now.`);
        if (!proc.child || proc.state !== "running") throw new Error(`${proc.name} is not running.`);
        return proc;
    }

    /**
     * Reads [player] with one `data get entity` per field, one after another so each answer is matched to its
     * question. The commands are visible in the console like any other.
     */
    async playerInfo(id: string, player: string): Promise<PlayerInfo> {
        const instance = this.instances.get(id);
        if (!instance) throw new Error("No such server");
        if (!/^\w{1,16}$/.test(player)) throw new Error("Not a player name.");
        const proc = this.playerProc(instance, player);
        const fields = ["Pos", "Dimension", "Health", "foodLevel", "XpLevel", "playerGameType", "Inventory"];
        // Sent together: each prints exactly one line, in order, so the nth reply answers the nth field.
        const replies = await this.quiet(proc, fields.map((f) => `data get entity ${player} ${f}`), players.ENTITY_REPLY, { count: fields.length });
        if (replies.length < fields.length) throw new Error(`${proc.name} did not answer in time.`);
        const [pos, dimension, health, food, xp, mode, items] = replies.map(players.entityData);
        const [x, y, z] = pos ? players.snbtNumbers(pos) : [];
        return {
            name: player,
            process: proc.name,
            ...(x !== undefined && y !== undefined && z !== undefined ? { position: { x, y, z } } : {}),
            ...(dimension ? { dimension: players.snbtString(dimension) } : {}),
            ...(health ? { health: players.snbtNumber(health) ?? undefined } : {}),
            ...(food ? { food: players.snbtNumber(food) ?? undefined } : {}),
            ...(xp ? { xpLevel: players.snbtNumber(xp) ?? undefined } : {}),
            ...(mode ? { gameMode: players.gameMode(mode) } : {}),
            op: await this.isOp(proc, player),
            inventory: items ? players.inventory(items) : [],
        };
    }

    /** From ops.json, which the server writes as soon as an op or deop happens. */
    private async isOp(proc: Proc, player: string): Promise<boolean> {
        try {
            const ops = JSON.parse(await readFile(join(proc.dir, "ops.json"), "utf8")) as { name?: string }[];
            return ops.some((o) => o.name?.toLowerCase() === player.toLowerCase());
        } catch {
            // No ops.json yet: nobody has been opped on this server.
            return false;
        }
    }

    /** Runs [action] out of the console, and throws the game's answer when that answer is a refusal. */
    async playerAction(id: string, player: string, action: PlayerAction): Promise<void> {
        const instance = this.instances.get(id);
        if (!instance) throw new Error("No such server");
        const proc = this.playerProc(instance, player);
        const commands = players.actionCommands(player, action, instance.request.version);
        const replies = await this.quiet(proc, commands, players.ACTION_REPLY, { count: commands.length });
        const refused = replies.find((r) => players.ACTION_REFUSED.test(r));
        if (refused) throw new Error(refused);
    }

    async itemIcons(id: string, ids: string[]): Promise<Record<string, string | null>> {
        const instance = this.instances.get(id);
        if (!instance) throw new Error("No such server");
        return textures.itemIcons(this.cacheDir, instance.request.version, ids);
    }

    /**
     * Sends [commands] straight to [proc] without echoing them, and returns the reply lines that match
     * [pattern], taken out of the console. Done after [count] replies, when [pattern] has been quiet for a
     * moment, or after [maxMs]. Queries on one process wait their turn, so no reply lands in the wrong one.
     */
    private quiet(proc: Proc, commands: string[], pattern: RegExp, { count = Infinity, maxMs = REPLY_MAX_MS } = {}): Promise<string[]> {
        const ask = () => new Promise<string[]>((resolve) => {
            if (!proc.child) return resolve([]);
            const lines: string[] = [];
            let quietTimer: NodeJS.Timeout | null = null;
            const finish = () => {
                clearTimeout(cap);
                if (quietTimer) clearTimeout(quietTimer);
                proc.swallow = undefined;
                resolve(lines);
            };
            proc.swallow = {
                pattern,
                take: (text) => {
                    // 26.1 and later log what the server says to the console with this label; it is not part of the reply.
                    lines.push(logText(text).replace(/^System chat: /, ""));
                    if (quietTimer) clearTimeout(quietTimer);
                    if (lines.length >= count) finish();
                    else quietTimer = setTimeout(finish, REPLY_QUIET_MS);
                },
            };
            const cap = setTimeout(finish, maxMs);
            proc.child.stdin.write(commands.map((c) => `${c}\n`).join(""));
        });
        const run = (proc.queries ?? Promise.resolve()).then(ask);
        proc.queries = run;
        return run;
    }

    private gameProc(id: string, process: string): { instance: Instance; proc: Proc } {
        const instance = this.instances.get(id);
        const proc = instance?.procs.find((p) => p.name === process);
        if (!instance || !proc) throw new Error("No such process");
        if (proc.software === "velocity") throw new Error("That is a proxy; pick a game server.");
        if (!proc.child || proc.state !== "running") throw new Error(`${process} is not running.`);
        return { instance, proc };
    }

    /** PlaceholderAPI's own parse, for a player or (with --null) for none. */
    async placeholder(id: string, process: string, player: string | null, text: string): Promise<string> {
        const { proc } = this.gameProc(id, process);
        if (player !== null && !/^\w{1,16}$/.test(player)) throw new Error("Not a player name.");
        if (/[\r\n]/.test(text) || text.length > 256) throw new Error("One line of up to 256 characters.");
        const lines = (await this.quiet(proc, [`papi parse ${player ?? "--null"} ${text}`], COMMAND_REPLY)).filter((l) => l.trim() !== "");
        if (lines.length === 0) throw new Error("PlaceholderAPI did not answer. Is it loaded on this server?");
        return lines.join("\n");
    }

    /**
     * Completes the last word of [line] from the server's own help: root commands for the first word, and
     * the literal words each command's usages list for the second. Learned once per process, quietly.
     */
    async completions(id: string, process: string, line: string): Promise<string[]> {
        const instance = this.instances.get(id);
        const proc = instance?.procs.find((p) => p.name === process);
        if (!proc?.child || proc.state !== "running" || proc.software === "velocity") return [];
        const words = line.replace(/^\//, "").split(" ");
        if (words.length > 2) return [];
        if (!proc.commands) {
            const usages = await this.quiet(proc, ["minecraft:help"], /^(\[[^\]]+\]:? ?)?\/\S+/);
            proc.commands = { roots: [...new Set(usages.flatMap((l) => usageWords(l)[0] ?? []))].sort(), children: new Map() };
        }
        const [first, second] = words;
        if (second === undefined) return proc.commands.roots.filter((r) => r.startsWith(first)).slice(0, 50);
        if (!proc.commands.roots.includes(first)) return [];
        let children = proc.commands.children.get(first);
        if (!children) {
            const usages = await this.quiet(proc, [`minecraft:help ${first}`], /^(\[[^\]]+\]:? ?)?\/\S+/);
            children = [...new Set(usages.flatMap((l) => usageWords(l)[1] ?? []))].sort();
            // Plugin commands reach the game's help as one greedy argument, so it lists no subcommands. Lattice's
            // own dispatcher answers "<command> help" with one line per subcommand; that is asked only for
            // commands registered under the lattice: namespace, because "help" passed to anything else could be
            // taken as an argument ("ban help" bans a player called help).
            if (children.length === 0 && proc.commands.roots.includes(`lattice:${first}`)) {
                const lines = await this.quiet(proc, [`${first} help`], new RegExp(`^(\\[[^\\]]+\\]:? ?)?\\s+/${escapeRegExp(first)} \\S`));
                children = [...new Set(lines.flatMap((l) => /^\s*\/\S+ (\S+)/.exec(logText(l))?.[1] ?? []))].sort();
            }
            proc.commands.children.set(first, children);
        }
        return children.filter((c) => c.startsWith(second)).slice(0, 50);
    }

    extend(id: string): void {
        const instance = this.instances.get(id);
        if (!instance) return;
        instance.view.expiresAt = Math.max(instance.view.expiresAt, Date.now()) + LIFETIME_MS;
        instance.warned = false;
        this.log(instance, "app", "Extended by 30 minutes.", "out");
        this.changed();
    }

    rename(id: string, label: string): void {
        const instance = this.instances.get(id);
        const trimmed = label.trim();
        if (!instance || !trimmed) return;
        instance.view.label = trimmed.slice(0, 40);
        this.changed();
    }

    stats(id: string): StatSample[] {
        return this.instances.get(id)?.stats ?? [];
    }

    command(id: string, process: string, line: string): void {
        const instance = this.instances.get(id);
        const proc = instance?.procs.find((p) => p.name === process);
        if (!instance || !proc?.child) return;
        this.log(instance, process, `> ${line}`, "app");
        proc.child.stdin.write(`${line}\n`);
    }

    /** Stops every process of [id] the way the console's stop does: worlds saved, plugins disabled. */
    async stopAll(id: string): Promise<void> {
        const instance = this.instances.get(id);
        if (!instance || instance.destroying) return;
        // The proxy first, so players are not sent to a backend that is already going down.
        await Promise.all(instance.procs.filter((p) => p.software === "velocity").map((p) => this.stop(instance, p)));
        await Promise.all(instance.procs.filter((p) => p.software !== "velocity").map((p) => this.stop(instance, p)));
    }

    async restart(id: string): Promise<void> {
        await this.stopAll(id);
        this.start(id);
    }

    /** Ends every process of [id] at once, for a server that hangs on stop. Unsaved world changes are lost. */
    kill(id: string): void {
        const instance = this.instances.get(id);
        if (!instance) return;
        for (const proc of instance.procs) {
            if (!proc.child) continue;
            proc.state = "stopping";
            this.log(instance, proc.name, "Killed.", "err");
            proc.child.kill("SIGKILL");
        }
        this.publishProcs(instance);
    }

    /** Starts every process of [id] that is not running, after a stop or a crash. */
    start(id: string): void {
        const instance = this.instances.get(id);
        if (!instance || instance.destroying || instance.view.state === "preparing" || instance.view.error) return;
        // Backends before the proxy, as on first start.
        for (const proc of [...instance.procs].reverse()) {
            if (!proc.child) this.launch(instance, proc, this.settings().javaPath);
        }
    }

    async destroy(id: string): Promise<void> {
        const instance = this.instances.get(id);
        if (!instance || instance.destroying) return;
        instance.destroying = true;
        instance.view.state = "stopping";
        this.changed();
        this.emit("destroying", id);
        for (const { extension, fn } of this.hooks.of("destroy")) {
            try {
                await fn(id);
            } catch (error) {
                // Deleting the server must not hang on one extension's network error.
                console.warn(`${extension} could not clean up after ${id}`, error);
            }
        }
        await Promise.all(instance.procs.map((p) => this.stop(instance, p)));
        try {
            await rm(instance.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch (error) {
            // Something outside the app still holds a file (Explorer, an editor). The next start purges it.
            console.warn(`Could not delete ${instance.dir}; it is removed on the next start`, error);
        }
        this.instances.delete(id);
        this.changed();
    }

    async destroyAll(): Promise<void> {
        clearInterval(this.ticker);
        clearInterval(this.sampler);
        await Promise.all([...this.instances.keys()].map((id) => this.destroy(id)));
    }

    /** Copies the plugin jars picked at deploy from disk again, after one was rebuilt, and restarts so they load. */
    async reloadPlugins(id: string): Promise<void> {
        const instance = this.instances.get(id);
        if (!instance || instance.destroying) throw new Error("No such server");
        if (instance.view.state === "preparing") throw new Error("Wait until the server has finished preparing.");
        const { plugins = [] } = instance.request;
        if (plugins.length === 0) throw new Error("This server has no jars picked from disk.");
        for (const proc of instance.procs.filter((p) => p.software !== "velocity")) {
            await this.copyPicked(plugins, join(proc.dir, "plugins"));
        }
        this.log(instance, "app", `Copied ${plugins.length} jar${plugins.length === 1 ? "" : "s"} again. Restarting.`, "out");
        await this.restart(id);
    }

    // ------------------------------------------------------------ extensions --

    /** What extensions get to work with. Narrower than this class on purpose: see ServerApi. */
    serverApi(): ServerApi & { off: Instances["off"] } {
        const find = (id: string): Instance => this.instances.get(id) ?? fail("No such server");
        return {
            list: () => this.list(),
            get: (id) => this.instances.get(id)?.view,
            dir: (id) => this.dir(id),
            processes: (id): ProcessInfo[] => find(id).procs.map((p) => ({ ...planOf(p, find(id).request.version), state: p.state })),
            command: (id, process, line) => this.command(id, process, line),
            query: (id, process, commands, pattern, options) => {
                const proc = find(id).procs.find((p) => p.name === process);
                if (!proc?.child || proc.state !== "running") return Promise.reject(new Error(`${process} is not running.`));
                return this.quiet(proc, commands, pattern, options);
            },
            update: (id, patch: ViewPatch) => {
                Object.assign(find(id).view, patch);
                this.changed();
            },
            deploy: (request) => this.deploy(request),
            history: (id) => this.history(id),
            start: (id) => this.start(id),
            stop: (id) => this.stopAll(id),
            restart: (id) => this.restart(id),
            destroy: (id) => this.destroy(id),
            keep: (id, kept) => this.keep(id, kept),
            placeholder: (id, process, player, text) => this.placeholder(id, process, player, text),
            playerInfo: (id, player) => this.playerInfo(id, player),
            waitFor: (id, match, ms) => new Promise((resolve) => {
                const listener = (line: ConsoleLine) => {
                    if (line.serverId === id && match(line)) done(line);
                };
                const timer = setTimeout(() => done(null), ms);
                const done = (line: ConsoleLine | null) => {
                    clearTimeout(timer);
                    this.off("console", listener);
                    resolve(line);
                };
                this.on("console", listener);
            }),
            log: (id, process, text, stream = "out") => this.log(find(id), process, text, stream),
            on: (event, fn) => void this.on(event, fn as (...args: unknown[]) => void),
            off: this.off.bind(this),
        };
    }

    private async plans(instance: Instance): Promise<ProcessPlan[]> {
        return instance.procs.map((p) => planOf(p, instance.request.version));
    }

    // ------------------------------------------------------------- preparing --

    private async prepare(instance: Instance, request: DeployRequest): Promise<void> {
        const settings = this.settings();
        if (!settings.javaPath || !existsSync(settings.javaPath)) throw new Error("Set the Java path in Settings first.");

        const log = (text: string) => this.log(instance, "app", text, "out");
        const base = { serverId: instance.view.id, request, options: {}, log, cacheDir: this.cacheDir };
        for (const { extension, fn } of this.hooks.of("deploy")) {
            await Promise.resolve(fn(base)).catch((error: Error) => fail(`${extension}: ${error.message}`));
        }

        const network = request.software === "velocity";
        const used = new Set<number>(this.list().flatMap((s) => s.processes.map((p) => p.port)));
        const port = () => freePort(settings.basePort, used);

        if (!network) {
            const proc: Proc = { name: "server", dir: instance.dir, port: await port(), software: request.software, memoryMb: settings.memoryMb, state: "preparing" };
            instance.procs.push(proc);
            this.publishProcs(instance);
            await this.gameServer(instance, proc, request.version, request.onlineMode, null);
            instance.view.address = `localhost:${proc.port}`;
        } else {
            const backendSoftware = request.backendSoftware ?? "paper";
            const secret = randomBytes(24).toString("hex");
            const proxy: Proc = { name: "proxy", dir: join(instance.dir, "proxy"), port: await port(), software: "velocity", memoryMb: PROXY_MEMORY_MB, state: "preparing" };
            const backends: Proc[] = [];
            for (let n = 1; n <= Math.max(1, Math.min(request.backends ?? 1, 4)); n++) {
                backends.push({ name: `backend-${n}`, dir: join(instance.dir, `backend-${n}`), port: await port(), software: backendSoftware, memoryMb: settings.memoryMb, state: "preparing" });
            }
            instance.procs.push(proxy, ...backends);
            this.publishProcs(instance);
            await this.proxy(instance, proxy, backends, secret, request.onlineMode);
            for (const backend of backends) await this.gameServer(instance, backend, request.version, request.onlineMode, { secret });
            instance.view.address = `localhost:${proxy.port}`;
        }

        const plans = await this.plans(instance);
        for (const plan of plans) {
            for (const { extension, fn } of this.hooks.of("prepare")) {
                await Promise.resolve(fn({ ...base, proc: plan, procs: plans })).catch((error: Error) => fail(`${extension}: ${error.message}`));
            }
        }

        if (request.snapshot) {
            const restored = await this.snapshots.restoreInto(request.snapshot, instance.dir);
            this.log(instance, "app", `Restored ${restored} files from the snapshot.`, "out");
        }

        instance.view.state = "starting";
        this.changed();
        // Backends first, so the proxy has somewhere to send the first player.
        for (const proc of [...instance.procs].reverse()) this.launch(instance, proc, settings.javaPath);
    }

    /** Copies the jars picked from disk, saying which one is gone rather than failing on a bare path. */
    private async copyPicked(files: string[], into: string): Promise<void> {
        await mkdir(into, { recursive: true });
        for (const file of files) {
            if (!existsSync(file)) throw new Error(`${basename(file)} is no longer at ${file}.`);
            await copyFile(file, join(into, basename(file)));
        }
    }

    private async gameServer(instance: Instance, proc: Proc, mc: string, onlineMode: boolean, proxy: { secret: string } | null): Promise<void> {
        this.log(instance, proc.name, `Fetching ${proc.software} ${mc} and plugins...`, "out");
        const plugins = join(proc.dir, "plugins");
        await mkdir(plugins, { recursive: true });

        const own = instance.request.serverJar;
        if (own && !existsSync(own)) throw new Error(`${basename(own)} is no longer at ${own}.`);
        const jar = own ?? await fetchCached(this.cacheDir, await serverJar(proc.software, mc));
        await copyFile(jar, join(proc.dir, "server.jar"));
        await copyFile(await fetchCached(this.cacheDir, JOLOKIA), join(proc.dir, JOLOKIA_JAR));
        for (const plugin of await gamePlugins(mc)) {
            const file = await fetchCached(this.cacheDir, plugin);
            await copyFile(file, join(plugins, basename(file)));
        }
        await this.copyPicked(instance.request.plugins ?? [], plugins);

        await writeFile(join(proc.dir, "eula.txt"), "eula=true\n");
        await writeFile(join(proc.dir, "server-icon.png"), SERVER_ICON);
        await writeFile(join(proc.dir, "server.properties"), properties({
            "server-port": proc.port,
            // Behind a proxy the proxy checks accounts and vouches for players through the forwarding secret,
            // so the backend itself never does.
            "online-mode": proxy ? false : onlineMode,
            // Players with no profile key (offline servers, a proxy) otherwise lose chat and log "Failed to
            // update secure chat state" on every join. A test server has no use for signed chat.
            "enforce-secure-profile": false,
            "white-list": false,
            "enforce-whitelist": false,
            "motd": motd(`${capitalize(proc.software)} ${mc}`, proxy ? proc.name : null),
            "spawn-protection": 0,
            // Registers the tick-time bean that the stats read through Jolokia.
            "enable-jmx-monitoring": true,
            "view-distance": 6,
            "simulation-distance": 6,
            "max-players": 50,
            ...worldProperties(instance.view.world),
        }));

        // Paper refuses a second login from one address within four seconds, and every bot shares one.
        await writeFile(join(proc.dir, "bukkit.yml"), stringify({ settings: { "connection-throttle": -1 } }));

        if (proxy) {
            await mkdir(join(proc.dir, "config"), { recursive: true });
            // Paper fills in the rest of this file on first start and keeps what is already here.
            await writeFile(join(proc.dir, "config", "paper-global.yml"), stringify({
                proxies: { velocity: { enabled: true, "online-mode": onlineMode, secret: proxy.secret } },
            }));
        }
    }

    private async proxy(instance: Instance, proc: Proc, backends: Proc[], secret: string, onlineMode: boolean): Promise<void> {
        this.log(instance, proc.name, "Fetching Velocity...", "out");
        await mkdir(join(proc.dir, "plugins"), { recursive: true });

        const latest = (await versions()).velocity[0];
        const jar = await fetchCached(this.cacheDir, await serverJar("velocity", latest));
        await copyFile(jar, join(proc.dir, "server.jar"));
        await copyFile(await fetchCached(this.cacheDir, JOLOKIA), join(proc.dir, JOLOKIA_JAR));
        // No ViaVersion here: Velocity already accepts every client version, and Via on both the proxy and
        // the backends translates twice - the backend then drops players for keepalives it cannot match.

        await writeFile(join(proc.dir, "forwarding.secret"), secret);
        await writeFile(join(proc.dir, "server-icon.png"), SERVER_ICON);
        const servers = backends.map((b) => `${b.name} = "127.0.0.1:${b.port}"`).join("\n");
        await writeFile(join(proc.dir, "velocity.toml"), [
            `config-version = "2.7"`,
            `bind = "0.0.0.0:${proc.port}"`,
            `motd = ${JSON.stringify(velocityMotd(backends.length))}`,
            `show-max-players = 50`,
            `online-mode = ${onlineMode}`,
            `force-key-authentication = false`,
            `player-info-forwarding-mode = "modern"`,
            `forwarding-secret-file = "forwarding.secret"`,
            `ping-passthrough = "DISABLED"`,
            ``,
            `[servers]`,
            servers,
            `try = [${backends.map((b) => `"${b.name}"`).join(", ")}]`,
            ``,
            `[forced-hosts]`,
            ``,
            // Velocity's own per-address login limit, for the same reason as Paper's connection throttle.
            `[advanced]`,
            `login-ratelimit = 0`,
            ``,
        ].join("\n"));
    }

    // ------------------------------------------------------------- processes --

    private launch(instance: Instance, proc: Proc, java: string): void {
        const args = [`-Xms${Math.min(512, proc.memoryMb)}M`, `-Xmx${proc.memoryMb}M`];
        // Port 0: the agent picks a free port and prints it, so two servers never fight over one.
        if (existsSync(join(proc.dir, JOLOKIA_JAR))) args.push(`-javaagent:${JOLOKIA_JAR}=host=127.0.0.1,port=0`);
        args.push("-jar", "server.jar");
        if (proc.software !== "velocity") args.push("--nogui");
        // Extensions add to the environment rather than the command line: no file holds it and no process list shows it.
        const extra: Record<string, string> = {};
        for (const { fn } of this.hooks.of("env")) Object.assign(extra, fn(instance.view.id, planOf(proc, instance.request.version)));
        const child = spawn(java, args, { cwd: proc.dir, env: Object.keys(extra).length > 0 ? { ...process.env, ...extra } : undefined });
        proc.child = child;
        proc.jolokia = undefined;
        proc.state = "starting";
        this.publishProcs(instance);

        const lines = (stream: "out" | "err") => {
            let partial = "";
            return (chunk: Buffer) => {
                const parts = (partial + chunk.toString()).split(/\r?\n/);
                partial = parts.pop() ?? "";
                for (const raw of parts) {
                    // Plugins colour their console lines with ANSI codes; the console tab colours by level instead.
                    const text = raw.replace(ANSI, "");
                    const jolokia = jolokiaUrl(text);
                    if (jolokia) {
                        proc.jolokia = jolokia;
                        continue;
                    }
                    // A join or leave inside a query's window still reaches the log, which is where players are tracked.
                    if (proc.swallow?.pattern.test(text) && !playerEvent(text)) {
                        proc.swallow.take(text);
                        continue;
                    }
                    this.log(instance, proc.name, text, stream);
                    // Paper and Velocity both print "Done (1.234s)!" once they accept players.
                    if (proc.state === "starting" && /Done \(\d/.test(text)) {
                        proc.state = "running";
                        this.publishProcs(instance);
                        this.opOperators(instance, proc);
                        if (instance.view.world === "void" && proc.software !== "velocity" && !proc.platformBuilt) {
                            proc.platformBuilt = true;
                            this.buildPlatform(instance, proc);
                        }
                    }
                }
            };
        };
        child.stdout.on("data", lines("out"));
        child.stderr.on("data", lines("err"));
        child.on("error", (error) => {
            this.log(instance, proc.name, `Could not start Java: ${error.message}`, "err");
            proc.state = "failed";
            this.publishProcs(instance);
        });
        child.on("exit", (code) => {
            proc.child = undefined;
            // A clean exit is a stop, whoever asked for it - "stop" typed in the console included.
            const expected = proc.state === "stopping" || instance.destroying || code === 0;
            proc.state = expected ? "stopped" : "failed";
            this.log(instance, proc.name, `Process exited with code ${code}.`, expected ? "out" : "err");
            this.publishProcs(instance);
        });
    }

    /**
     * Gives a void world somewhere to stand. Recent versions keep no spawn chunks loaded, so the chunk is
     * force-loaded first and the fill is sent again each time the server answers that it is not loaded yet:
     * the server's own replies pace the retries, rather than a guess at how long loading takes.
     */
    private buildPlatform(instance: Instance, proc: Proc): void {
        const id = instance.view.id;
        let tries = 0;
        const listener = (line: ConsoleLine) => {
            if (line.serverId !== id || line.process !== proc.name) return;
            if (/That position is not loaded/.test(line.text) && ++tries < PLATFORM_TRIES && proc.child) {
                this.command(id, proc.name, PLATFORM_FILL);
            } else if (/filled \d+ block|That position is not loaded/i.test(line.text) || !proc.child) {
                this.off("console", listener);
                this.command(id, proc.name, "forceload remove 0 0");
                if (tries >= PLATFORM_TRIES) this.log(instance, "app", "Could not build the void spawn platform: the spawn chunk never loaded.", "err");
            }
        };
        this.on("console", listener);
        this.command(id, proc.name, "setworldspawn 0 64 0");
        this.command(id, proc.name, "forceload add 0 0");
        this.command(id, proc.name, PLATFORM_FILL);
    }

    /**
     * Ops the configured players by name once a game server accepts commands. Done by command rather than
     * by writing ops.json, because the server resolves the right UUID itself: Mojang's in online mode,
     * the offline one otherwise, and the proxy's view behind a proxy.
     */
    private opOperators(instance: Instance, proc: Proc): void {
        if (proc.software === "velocity" || !proc.child) return;
        for (const name of this.settings().operators) {
            if (/^[A-Za-z0-9_]{1,16}$/.test(name)) this.command(instance.view.id, proc.name, `op ${name}`);
        }
    }

    private stop(instance: Instance, proc: Proc): Promise<void> {
        const child = proc.child;
        if (!child) return Promise.resolve();
        proc.state = "stopping";
        this.publishProcs(instance);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.log(instance, proc.name, "Did not stop in time, killing it.", "err");
                child.kill("SIGKILL");
            }, STOP_GRACE_MS);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            child.stdin.write(proc.software === "velocity" ? "end\n" : "stop\n");
        });
    }

    // ---------------------------------------------------------------- expiry --

    private tick(): void {
        const now = Date.now();
        for (const instance of this.instances.values()) {
            if (instance.destroying) continue;
            this.showExpiry(instance, now);
            if (instance.view.kept) continue;
            const left = instance.view.expiresAt - now;
            if (left <= 0) {
                this.log(instance, "app", "Expired. Stopping and deleting.", "out");
                void this.destroy(instance.view.id);
            } else if (left <= 5 * 60_000 && !instance.warned) {
                instance.warned = true;
                this.log(instance, "app", "Five minutes left. Extend it to keep it.", "out");
                this.emit("expiring", instance.view);
                for (const proc of instance.procs) {
                    if (proc.child && proc.software !== "velocity") proc.child.stdin.write("say This test server is deleted in five minutes.\n");
                }
            }
        }
    }

    /**
     * Keeps a boss bar on every game server counting down to the server's deletion, so players see it coming and
     * not only whoever has the app open. Vanilla commands, so it needs no plugin.
     */
    private showExpiry(instance: Instance, now: number): void {
        const ends = [
            ...(instance.view.kept ? [] : [{ at: instance.view.expiresAt, what: "This test server is deleted" }]),
        ].sort((a, b) => a.at - b.at);
        const next = ends[0];
        const minutes = next ? Math.max(1, Math.ceil((next.at - now) / 60_000)) : 0;
        const commands = next
            ? [
                `bossbar add ${EXPIRY_BAR} ""`,
                `bossbar set ${EXPIRY_BAR} name ${JSON.stringify(`${next.what} in ${duration(minutes)}`)}`,
                `bossbar set ${EXPIRY_BAR} color ${minutes <= 5 ? "red" : minutes <= 10 ? "yellow" : "green"}`,
                // The last half hour drains the bar; anything longer shows it full.
                `bossbar set ${EXPIRY_BAR} max 30`,
                `bossbar set ${EXPIRY_BAR} value ${Math.min(minutes, 30)}`,
                `bossbar set ${EXPIRY_BAR} players @a`,
            ]
            : [`bossbar remove ${EXPIRY_BAR}`];
        const key = commands.join("\n");
        for (const proc of instance.procs) {
            if (proc.software === "velocity") continue;
            if (proc.state !== "running" || !proc.child) {
                proc.bar = undefined;
                continue;
            }
            if (proc.bar === key) continue;
            proc.bar = key;
            void this.quiet(proc, commands, COMMAND_REPLY);
        }
    }

    // ----------------------------------------------------------------- stats --

    private async sample(): Promise<void> {
        if (this.sampling) return;
        const running = [...this.instances.values()].flatMap((i) => i.procs.filter((p) => p.child?.pid).map((p) => ({ instance: i, proc: p, pid: p.child!.pid! })));
        if (running.length === 0) {
            this.lastReadings.clear();
            return;
        }
        this.sampling = true;
        try {
            const at = Date.now();
            for (const { proc } of running) this.probe(proc);
            const readings = new Map((await readStats(running.map((r) => r.pid))).map((r) => [r.pid, r]));
            for (const { instance, proc, pid } of running) {
                const now = readings.get(pid);
                if (!now) continue;
                const before = this.lastReadings.get(pid);
                if (before) {
                    const sample: StatSample = {
                        serverId: instance.view.id,
                        process: proc.name,
                        t: at,
                        cpu: Math.round(cpuPercent(before.reading, now, (at - before.at) / 1000) * 10) / 10,
                        memoryMb: Math.round(now.memoryBytes / 1048576),
                        ...(proc.probed && at - proc.probed.at < PROBE_FRESH_MS ? { tps: proc.probed.tps, mspt: proc.probed.mspt } : {}),
                    };
                    instance.stats.push(sample);
                    if (instance.stats.length > STATS_KEPT * 5) instance.stats.splice(0, instance.stats.length - STATS_KEPT * 5);
                    this.emit("stats", sample);
                }
                this.lastReadings.set(pid, { reading: now, at });
            }
            // Forget processes that are gone, so a reused pid does not diff against a stranger.
            const live = new Set(running.map((r) => r.pid));
            for (const pid of this.lastReadings.keys()) if (!live.has(pid)) this.lastReadings.delete(pid);
        } catch (error) {
            console.warn("Could not read process stats", error);
        } finally {
            this.sampling = false;
        }
    }

    /** Reads a game server's tick rate for the next sample. A failed read leaves the old one to go stale. */
    private probe(proc: Proc): void {
        if (proc.state !== "running" || !proc.jolokia) return;
        tickRate(proc.jolokia)
            .then((rate) => {
                if (rate) proc.probed = { ...rate, at: Date.now() };
            })
            .catch((e: Error) => console.warn(`Could not read the tick rate of ${proc.name}: ${e.message}`));
    }

    // --------------------------------------------------------------- helpers --

    private publishProcs(instance: Instance): void {
        instance.view.processes = instance.procs.map((p) => ({ name: p.name, port: p.port, state: p.state }));
        // A deploy that failed while preparing keeps that state; a process that crashed can be started again.
        if (instance.view.state !== "preparing" && !instance.view.error && !instance.destroying) {
            const states = instance.procs.map((p) => p.state);
            instance.view.state = states.every((s) => s === "running")
                ? "running"
                : states.some((s) => s === "failed") ? "failed" : states.some((s) => s === "starting") ? "starting" : "stopped";
        }
        this.changed();
    }

    private log(instance: Instance, process: string, text: string, stream: ConsoleLine["stream"]): void {
        const line: ConsoleLine = { serverId: instance.view.id, process, text, stream };
        if (process !== "app" && process !== "tunnel") this.read(instance, line);
        instance.history.push(line);
        if (instance.history.length > HISTORY_LINES) instance.history.splice(0, instance.history.length - HISTORY_LINES);
        this.emit("console", line);
    }

    /** Counts errors and tracks players, for the header and the tray. Extensions read the same console lines themselves. */
    private read(instance: Instance, line: ConsoleLine): void {
        let touched = false;
        if (isErrorLine(line.text, line.stream)) {
            instance.view.errors++;
            touched = true;
        }
        // Players are counted where they enter: the proxy on a network (not the bots' one), else the server.
        const entrance = instance.view.software === "velocity" ? "proxy" : "server";
        const player = line.process === entrance ? playerEvent(line.text) : null;
        if (player) {
            this.recordPlayer(instance, player.name, player.joined);
            touched = true;
        }
        // Where each player is: the game server that printed their join, so the player view asks the right one.
        if (line.process === "server" || line.process.startsWith("backend-")) {
            const moved = playerEvent(line.text);
            if (moved?.joined) {
                instance.where.set(moved.name, line.process);
                // "players @a" only takes who is online when it runs, so a join sends the bar again.
                const proc = instance.procs.find((p) => p.name === line.process);
                if (proc) proc.bar = undefined;
            }
            else if (moved && instance.where.get(moved.name) === line.process) instance.where.delete(moved.name);
        }
        if (touched) this.changedSoon();
    }

    private recordPlayer(instance: Instance, name: string, joined: boolean): void {
        const players = instance.view.players;
        if (joined) {
            players.push({ name, joinedAt: Date.now() });
            if (players.length > PLAYERS_KEPT) players.splice(0, players.length - PLAYERS_KEPT);
        } else {
            const open = [...players].reverse().find((p) => p.name === name && p.leftAt === undefined);
            if (open) open.leftAt = Date.now();
        }
        this.emit("player", { view: instance.view, name, joined });
    }

    private pendingChange: NodeJS.Timeout | null = null;

    /** A burst of errors (a stack trace every tick) becomes one update, not hundreds. */
    private changedSoon(): void {
        if (this.pendingChange) return;
        this.pendingChange = setTimeout(() => {
            this.pendingChange = null;
            this.changed();
        }, 300);
    }

    private changed(): void {
        this.emit("servers", this.list());
    }
}

function planOf(proc: Proc, version: string): ProcessPlan {
    return {
        name: proc.name, dir: proc.dir, port: proc.port, software: proc.software,
        role: proc.software === "velocity" ? "proxy" : "game",
        version: proc.software === "velocity" ? "" : version,
    };
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "25 min", or "1 h 12 min" from an hour up. */
function duration(minutes: number): string {
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** server.properties text, escaped the way java.util.Properties reads it, so a § or line break survives any charset. */
export function properties(values: Record<string, string | number | boolean>): string {
    const escape = (value: string) => value
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return Object.entries(values).map(([k, v]) => `${k}=${escape(String(v))}`).join("\n") + "\n";
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Two-line legacy MOTD for a game server: what it is, then what it runs. [node] is set behind a proxy. */
export function motd(software: string, node: string | null): string {
    const details = [node, software].filter(Boolean).join(" §8· §7");
    return `§b§lTestbench §8» §fTest server\n§7${details}`;
}

/** The proxy's MOTD, in MiniMessage, which is what velocity.toml takes. */
export function velocityMotd(servers: number): string {
    const details = ["Velocity", plural(servers, "server")].join(" <dark_gray>·</dark_gray> ");
    return `<aqua><bold>Testbench</bold></aqua> <dark_gray>»</dark_gray> <white>Test network</white>\n<gray>${details}</gray>`;
}

/**
 * The literal words of one help usage, by position: "/advancement (grant|revoke) <targets>" gives
 * [["advancement"], ["grant", "revoke"]]. Arguments in <> or [] are not words anyone types as is.
 */
export function usageWords(line: string): string[][] {
    const usage = /\/(\S.*)$/.exec(logText(line))?.[1] ?? "";
    return usage.split(" ").slice(0, 2).map((token) => {
        if (/^[<[]/.test(token)) return [];
        return token.replace(/^\(|\)$/g, "").split("|").filter((w) => /^[\w:.-]+$/.test(w));
    });
}

/** server.properties for the chosen world. A void world is a flat world of one air layer in the void biome. */
export function worldProperties(world: ServerView["world"]): Record<string, string | boolean> {
    if (world === "flat") return { "level-type": "minecraft:flat", "generate-structures": false };
    if (world === "void") {
        return {
            "level-type": "minecraft:flat",
            "generator-settings": JSON.stringify({ layers: [{ block: "minecraft:air", height: 1 }], biome: "minecraft:the_void" }),
            "generate-structures": false,
        };
    }
    return {};
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function fail(message: string): never {
    throw new Error(message);
}

/** The first port from [start] that nothing listens on and no other test server has claimed. */
async function freePort(start: number, used: Set<number>): Promise<number> {
    for (let port = start; port < start + 1000; port++) {
        if (used.has(port)) continue;
        if (await available(port)) {
            used.add(port);
            return port;
        }
    }
    throw new Error(`No free port between ${start} and ${start + 999}`);
}

function available(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
    });
}
