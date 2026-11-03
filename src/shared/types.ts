/** Everything that crosses the main/renderer boundary. Plain data only: it is structured-cloned over IPC. */
import type { ExtensionValue, ExtensionView } from "./extensions";

export type Software = "paper" | "folia" | "purpur" | "velocity";

export interface Settings {
    /** java.exe used for every server. Plugins and Minecraft 26 need Java 25 or newer. */
    javaPath: string;
    /** Megabytes per game server. The proxy always gets 512. */
    memoryMb: number;
    /** First port tried for a new server; each server takes the next free one. */
    basePort: number;
    /** Players made operator on every game server once it is up. */
    operators: string[];
    /** Extensions: which are on, and what each one's settings are. Secrets are sealed on disk. */
    extensions: Record<string, { enabled: boolean; values: Record<string, ExtensionValue> }>;
}

export type WorldKind = "normal" | "flat" | "void";

export interface DeployRequest {
    software: Software;
    /** Minecraft version for game servers. For velocity, the version of the backends. */
    version: string;
    /** Only for velocity: which game server software sits behind the proxy. */
    backendSoftware?: Exclude<Software, "velocity">;
    /** Only for velocity: how many backends. */
    backends?: number;
    /** Online mode checks Mojang accounts, so bots and offline clients cannot join. */
    onlineMode: boolean;
    /** A snapshot whose files are laid over the fresh deploy before it starts. */
    snapshot?: string;
    /** Absent means "normal". */
    world?: WorldKind;
    /** Plugin jars on this PC, copied into every game server's plugins folder. */
    plugins?: string[];
    /** A server jar on this PC (a Paper fork, say) used for every game server instead of the download for [software]. */
    serverJar?: string;
    /** Deploy options of enabled extensions, by extension id then field key. */
    extensions?: Record<string, Record<string, unknown>>;
}

/** A player session seen in the console of the server's entrance (the proxy on a network). */
export interface PlayerVisit {
    name: string;
    /** Epoch millis. */
    joinedAt: number;
    leftAt?: number;
}

export interface InventoryItem {
    /** 0-8 hotbar, 9-35 the rest. */
    slot: number;
    id: string;
    count: number;
    /** Level by enchantment id, stored ones on a book included. */
    enchantments?: Record<string, number>;
    /** The custom name, as plain text. */
    name?: string;
}

/** A player as the game server holding them reports it, read with `data get entity`. */
export interface PlayerInfo {
    name: string;
    /** The game server they are on. */
    process: string;
    position?: { x: number; y: number; z: number };
    dimension?: string;
    health?: number;
    food?: number;
    xpLevel?: number;
    gameMode?: "survival" | "creative" | "adventure" | "spectator";
    op: boolean;
    inventory: InventoryItem[];
}

export type PlayerAction =
    | { kind: "teleport"; x: number; y: number; z: number }
    | { kind: "teleportTo"; target: string }
    | { kind: "give"; item: string; count: number }
    | { kind: "op" }
    | { kind: "deop" }
    | { kind: "gamemode"; mode: NonNullable<PlayerInfo["gameMode"]> }
    | { kind: "heal" }
    | { kind: "feed" }
    | { kind: "clear" }
    | { kind: "kick" }
    /** Moves the stack in inventory slot [from] to [to]; when [to] is full, the two swap through the empty slot [via]. */
    | { kind: "move"; from: number; to: number; via?: number }
    | { kind: "count"; slot: number; count: number }
    | { kind: "remove"; slot: number }
    /** Sets [enchantment] on the stack to [level]; 0 removes it. */
    | { kind: "enchant"; slot: number; enchantment: string; level: number }
    /** An empty name removes the custom name. */
    | { kind: "name"; slot: number; name: string };

/** One cell of a version matrix: the same modules on another single server. */
export interface MatrixTarget {
    software: Exclude<Software, "velocity">;
    version: string;
}

export interface SnapshotInfo {
    id: string;
    name: string;
    createdAt: number;
    /** How to deploy the server again; restoring lays the snapshot over this. */
    request: DeployRequest;
    files: number;
    /** Files the running server had locked when the snapshot was taken. */
    skipped: number;
}

export type ServerState = "preparing" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface ProcessView {
    /** "proxy", or "backend-1", "backend-2"..., or "server" for a single server. */
    name: string;
    port: number;
    state: ServerState;
}

export interface ServerView {
    id: string;
    label: string;
    software: Software;
    version: string;
    /** Set by extensions that track modules (Lattice). */
    modules: string[];
    /** Ids of the extensions that took part in this deploy (their tabs show on the server page). */
    uses: string[];
    onlineMode: boolean;
    /** Where players and bots connect: the proxy for a network, else the server. */
    address: string;
    state: ServerState;
    processes: ProcessView[];
    /** Epoch millis. */
    createdAt: number;
    expiresAt: number;
    /** Set when preparing fails, so the sidebar can say why. */
    error?: string;
    /** Set by the Publishing extension while the server is reachable by name from the internet. */
    publicAddress?: string;
    /** Error lines printed by any process since the deploy. */
    errors: number;
    /** Set by extensions that track modules (Lattice): enabled, or refused or failed to. */
    moduleStatus: Record<string, "enabled" | "failed">;
    /** Kept servers do not expire; they still go when deleted or when the app quits. */
    kept: boolean;
    /** Set on the servers of one version matrix run, to group them. */
    matrix?: string;
    world: WorldKind;
    /** File names of the plugin jars picked from disk, which "Reload plugins" copies again. */
    plugins: string[];
    /** Sessions at the entrance, newest last. Players still on have no leftAt. */
    players: PlayerVisit[];
}

export interface UpdateStatus {
    state: "off" | "idle" | "checking" | "downloading" | "ready" | "error";
    /** The version being downloaded or waiting to be installed. */
    version?: string;
    percent?: number;
    /** The running version. */
    current: string;
    /** Why updates are off, or what went wrong. */
    note?: string;
}

/** One reading of a server process. */
export interface StatSample {
    serverId: string;
    process: string;
    /** Epoch millis. */
    t: number;
    /** Percent of one core, so a process using two cores reads 200. */
    cpu: number;
    memoryMb: number;
    /** Ticks per second, derived from [mspt] and capped at 20, for a game server whose tick bean answers. */
    tps?: number;
    /** Average milliseconds per tick over the last 100 ticks, from the server's JMX tick-time bean. */
    mspt?: number;
}

export interface SearchOptions {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
}

export interface SearchHit {
    path: string;
    line: number;
    text: string;
}

export interface SearchResult {
    hits: SearchHit[];
    /** More matches existed than are listed. */
    truncated: boolean;
    filesScanned: number;
}

export interface ExportResult {
    path: string;
    files: number;
    /** Files left out because the running server had them locked. */
    skipped: number;
}

export interface ConsoleLine {
    serverId: string;
    process: string;
    text: string;
    stream: "out" | "err" | "app";
}

export interface FileEntry {
    name: string;
    /** Relative to the server folder, always with forward slashes. */
    path: string;
    directory: boolean;
    size: number;
}

export interface Versions {
    paper: string[];
    folia: string[];
    purpur: string[];
    velocity: string[];
}

/** The API the preload script exposes on window.testbench. */
export interface TestbenchApi {
    settings(): Promise<Settings>;
    saveSettings(settings: Settings): Promise<Settings>;
    /** Downloads Java 25 (Eclipse Temurin) into the app's cache and returns its java.exe. */
    installJava(): Promise<string>;
    pickFile(title: string, extensions?: readonly string[]): Promise<string | null>;
    pickFolder(title: string): Promise<string | null>;
    /** Any number of .jar files; empty when cancelled. */
    pickJars(title: string): Promise<string[]>;
    versions(): Promise<Versions>;
    servers(): Promise<ServerView[]>;
    deploy(request: DeployRequest): Promise<string>;
    extend(serverId: string): Promise<void>;
    start(serverId: string): Promise<void>;
    stop(serverId: string): Promise<void>;
    restart(serverId: string): Promise<void>;
    kill(serverId: string): Promise<void>;
    destroy(serverId: string): Promise<void>;
    command(serverId: string, process: string, line: string): Promise<void>;
    history(serverId: string): Promise<ConsoleLine[]>;
    listFiles(serverId: string, path: string): Promise<FileEntry[]>;
    readFile(serverId: string, path: string): Promise<string>;
    /** An image file as a data URL. */
    readImage(serverId: string, path: string): Promise<string>;
    writeFile(serverId: string, path: string, content: string): Promise<void>;
    openFolder(serverId: string): Promise<void>;
    rename(serverId: string, label: string): Promise<void>;
    /** Copies the deploy's plugin and module jars from disk again and restarts, after rebuilding one of them. */
    reloadPlugins(serverId: string): Promise<void>;
    /** Turns expiry off or back on. */
    keep(serverId: string, kept: boolean): Promise<void>;
    /** Starts a 30 second spark profile on [process]; the viewer link is printed to the console. */
    profile(serverId: string, process: string): Promise<void>;
    snapshots(): Promise<SnapshotInfo[]>;
    snapshot(serverId: string, name: string): Promise<SnapshotInfo>;
    deleteSnapshot(snapshotId: string): Promise<void>;
    /** Deploys the snapshot's server again with its files. Returns the new server id. */
    restoreSnapshot(snapshotId: string): Promise<string>;
    /** Internal edition: picks a server zip and deploys it, keeping it as a snapshot. Null when the picker was closed. */
    importServer(): Promise<string | null>;
    /** Deploys [request]'s modules on every target, building once. Returns the matrix id. */
    deployMatrix(request: DeployRequest, targets: MatrixTarget[]): Promise<string>;
    /** PlaceholderAPI's parse of [text] for [player], or with no player when [player] is null. */
    placeholder(serverId: string, process: string, player: string | null, text: string): Promise<string>;
    /** Words that complete the last word of [line], from what the server's own help lists. */
    completions(serverId: string, process: string, line: string): Promise<string[]>;
    /** Reads [player] from the game server they are on. */
    playerInfo(serverId: string, player: string): Promise<PlayerInfo>;
    playerAction(serverId: string, player: string, action: PlayerAction): Promise<void>;
    /** The game's own texture for each item id, as a data URL, or null for one with no flat texture. */
    itemIcons(serverId: string, ids: string[]): Promise<Record<string, string | null>>;
    exportServer(serverId: string): Promise<ExportResult | null>;
    stats(serverId: string): Promise<StatSample[]>;
    createEntry(serverId: string, path: string, directory: boolean): Promise<void>;
    renameEntry(serverId: string, from: string, to: string): Promise<void>;
    deleteEntry(serverId: string, path: string): Promise<void>;
    duplicateEntry(serverId: string, path: string): Promise<string>;
    /** Copies files or folders from anywhere on this PC into [dir] of the server. */
    importFiles(serverId: string, dir: string, sources: string[]): Promise<void>;
    /** The OS path of a dropped file. Synchronous: it reads the File object, not the disk. */
    pathForFile(file: File): string;
    searchFiles(serverId: string, options: SearchOptions, token: string): Promise<SearchResult>;
    cancelSearch(token: string): Promise<void>;
    /** What [path] held when it was first opened or saved here, or null if neither has happened. */
    originalFile(serverId: string, path: string): Promise<string | null>;
    /** Children of [dir] inside a jar in the server folder. */
    listJar(serverId: string, jar: string, dir: string): Promise<FileEntry[]>;
    /** Text of an entry in a jar; classes are decompiled. Rejects with "Cancelled" after [cancelJar] for the same [token]. */
    openJarEntry(serverId: string, jar: string, entry: string, token: string): Promise<string>;
    cancelJar(token: string): Promise<void>;
    onConsole(listener: (line: ConsoleLine) => void): () => void;
    onServers(listener: (servers: ServerView[]) => void): () => void;
    /** The tray asked to show a server. */
    onSelect(listener: (serverId: string) => void): () => void;
    /** From the tray panel: brings the main window up, on [serverId] when given. */
    showMain(serverId?: string): Promise<void>;
    /** Quits the app, which deletes every server. */
    quitApp(): Promise<void>;
    /** The tray panel's content height, so its window fits it. */
    traySize(height: number): Promise<void>;
    /** Every extension, built-in and the person's own, with whether it runs. */
    extensions(): Promise<ExtensionView[]>;
    setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionView[]>;
    saveExtensionValues(id: string, values: Record<string, ExtensionValue | true>): Promise<ExtensionView[]>;
    runExtensionAction(id: string, action: string, serverId: string): Promise<void>;
    /** Calls what an extension registered with ctx.handle. */
    extension<T = unknown>(id: string, channel: string, ...args: unknown[]): Promise<T>;
    onExtensions(listener: (list: ExtensionView[]) => void): () => void;
    /** Data an extension pushed with ctx.send. */
    onExtensionEvent<T = unknown>(id: string, channel: string, listener: (payload: T) => void): () => void;
    /** Opens the folder user extensions are loaded from. */
    openExtensionsFolder(): Promise<void>;
    updateStatus(): Promise<UpdateStatus>;
    checkForUpdates(): Promise<void>;
    installUpdate(): Promise<void>;
    onUpdate(listener: (status: UpdateStatus) => void): () => void;
    onStats(listener: (sample: StatSample) => void): () => void;
}
