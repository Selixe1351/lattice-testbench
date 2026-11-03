import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { APP_NAME } from "@shared/brand";
import type { ExtensionValue } from "@shared/extensions";
import type { DeployRequest, ExportResult, MatrixTarget, PlayerAction, SearchOptions, Settings } from "@shared/types";
import { builtins } from "./extensions/builtin";
import { ExtensionHost } from "./extensions/host";
import { Hooks, Tools } from "./extensions/hooks";
import { writeZip } from "./export";
import { MANIFEST } from "./import";
import * as files from "./files";
import * as jars from "./jar";
import { Instances } from "./instances";
import { installJava } from "./java";
import { loadSettings, paths, saveSettings, type Vault } from "./settings";
import { Snapshots } from "./snapshots";
import { versions } from "./sources";
import { TrayIcon } from "./tray";
import { Updater } from "./updates";

// A separate data folder lets a development copy run beside the installed one without sharing servers.
const dataDir = process.env.TESTBENCH_DATA;
if (dataDir) {
    // Created first: the single-instance lock below lives in this folder and fails if it is missing.
    mkdirSync(dataDir, { recursive: true });
    app.setPath("userData", dataDir);
}
const dirs = paths(join(app.getPath("userData")));

// One app per data folder. A second copy would purge the first one's servers as crash leftovers on start,
// deleting a running server out from under it, so it hands focus to the first and exits instead.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => {
    // Also brings it back from the tray.
    if (window) show();
});
let settings: Settings;
const DEV_ICON = join(__dirname, "../../assets/icon.png");
let window: BrowserWindow | null = null;
const snapshots = new Snapshots(join(dirs.root, "snapshots"));
const hooks = new Hooks();
const tools = new Tools();
const instances = new Instances(dirs.servers, dirs.cache, () => settings, snapshots, hooks);
// Only after ready: the OS store cannot be asked before.
let vault: Vault | null = null;
let tray: TrayIcon | null = null;
const updater = new Updater();

const PRELOAD = join(__dirname, "../preload/index.js");

/** To every window: the main one and the tray panel show the same servers. */
function send(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)));
}

const extensions = new ExtensionHost({
    settings: () => settings,
    saveSettings: (next) => save(next),
    servers: instances.serverApi(),
    hooks,
    tools,
    userDir: dirs.extensions,
    dataDir: dirs.root,
    cacheDir: dirs.cache,
    handle: (channel, fn) => handle(channel, fn),
    unhandle: (channel) => ipcMain.removeHandler(channel),
    send,
});

function save(next: Settings): Promise<void> {
    settings = next;
    return saveSettings(dirs.settings, next, vault, (id) => extensions.secretKeys(id));
}

instances.on("console", (line) => send("console", line));
instances.on("servers", (list) => send("servers", list));
instances.on("stats", (sample) => send("stats", sample));
instances.on("destroying", (id: string) => files.forget(instances.dir(id)));
updater.on("status", (status) => send("update", status));

// Shown as what it is, rather than left to Electron's generic crash dialog.
process.on("uncaughtException", (error) => {
    console.error("Uncaught error in the main process", error);
    dialog.showErrorBox(`${APP_NAME} hit an error`, error.stack ?? String(error));
});

function createWindow(): void {
    window = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 980,
        minHeight: 620,
        backgroundColor: "#0e0f11",
        // Only when running from source: an installed copy takes its window icon from the exe.
        ...(existsSync(DEV_ICON) ? { icon: DEV_ICON } : {}),
        title: APP_NAME,
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#0e0f11", symbolColor: "#a3a6ad", height: 40 },
        webPreferences: {
            preload: PRELOAD,
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    // Closing the window with servers up leaves them running in the tray; quitting is what deletes them.
    window.on("close", (event) => {
        if (quitting || instances.list().length === 0 || !tray) return;
        event.preventDefault();
        window?.hide();
        tray.hintHidden();
    });
    // Links in console output or docs open in the browser, never inside the app window.
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });
    load(window, "");
}

/** Loads the renderer into [target]; [route] picks the screen ("" for the app, "tray" for the tray panel). */
function load(target: BrowserWindow, route: string): void {
    if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`);
    else void target.loadFile(join(__dirname, "../renderer/index.html"), { hash: route });
}

/** Brings the window back from the tray, on [serverId] when given. */
function show(serverId?: string): void {
    if (!window || window.isDestroyed()) createWindow();
    if (window!.isMinimized()) window!.restore();
    window!.show();
    window!.focus();
    if (serverId) send("select", serverId);
}

function server(id: string) {
    const view = instances.list().find((s) => s.id === id);
    if (!view) throw new Error("No such server");
    return view;
}

handle("settings", () => settings);
handle("save-settings", async (next: Settings) => {
    // Extension settings and switches go through the extension calls below, never through here.
    await save({ ...next, extensions: settings.extensions });
    return settings;
});
handle("extensions", () => extensions.list());
handle("set-extension-enabled", (id: string, enabled: boolean) => extensions.setEnabled(id, enabled));
handle("save-extension-values", (id: string, values: Record<string, ExtensionValue | true>) => extensions.saveValues(id, values));
handle("run-extension-action", (id: string, action: string, serverId: string) => extensions.runAction(id, action, serverId));
handle("open-extensions-folder", async () => {
    mkdirSync(dirs.extensions, { recursive: true });
    await shell.openPath(dirs.extensions);
});
handle("install-java", () => installJava(dirs.cache));
handle("update-status", () => updater.current);
handle("check-updates", () => updater.check());
handle("install-update", () => updater.install());
handle("pick-file", async (title: string, extensions?: string[]) => {
    const result = await dialog.showOpenDialog(window!, { title, properties: ["openFile"], filters: [{ name: "File", extensions: extensions?.length ? extensions : ["*"] }] });
    return result.canceled ? null : result.filePaths[0];
});
handle("pick-folder", async (title: string) => {
    const result = await dialog.showOpenDialog(window!, { title, properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
});
handle("pick-jars", async (title: string) => {
    const result = await dialog.showOpenDialog(window!, { title, properties: ["openFile", "multiSelections"], filters: [{ name: "Jars", extensions: ["jar"] }] });
    return result.canceled ? [] : result.filePaths;
});
handle("versions", () => versions());
handle("servers", () => instances.list());
handle("deploy", (request: DeployRequest) => instances.deploy(request));
handle("extend", (id: string) => instances.extend(id));
handle("start", (id: string) => instances.start(id));
handle("stop", (id: string) => instances.stopAll(id));
handle("restart", (id: string) => instances.restart(id));
handle("kill", (id: string) => instances.kill(id));
handle("destroy", (id: string) => instances.destroy(id));
handle("command", (id: string, process: string, line: string) => instances.command(id, process, line));
handle("history", (id: string) => instances.history(id));
handle("list-files", (id: string, path: string) => files.list(instances.dir(id), path));
handle("read-file", (id: string, path: string) => files.read(instances.dir(id), path));
handle("read-image", (id: string, path: string) => files.readImage(instances.dir(id), path));
handle("write-file", (id: string, path: string, content: string) => files.write(instances.dir(id), path, content));
handle("rename", (id: string, label: string) => instances.rename(id, label));
handle("reload-plugins", (id: string) => instances.reloadPlugins(id));
handle("keep", (id: string, kept: boolean) => instances.keep(id, kept));
handle("profile", (id: string, process: string) => instances.profile(id, process));
handle("snapshots", () => snapshots.list());
handle("snapshot", (id: string, name: string) => instances.snapshot(id, name));
handle("delete-snapshot", (id: string) => snapshots.remove(id));
handle("restore-snapshot", (id: string) => instances.restore(id));
handle("deploy-matrix", (request: DeployRequest, targets: MatrixTarget[]) => instances.deployMatrix(request, targets));
handle("placeholder", (id: string, process: string, player: string | null, text: string) => instances.placeholder(id, process, player, text));
handle("completions", (id: string, process: string, line: string) => instances.completions(id, process, line));
handle("player-info", (id: string, player: string) => instances.playerInfo(id, player));
handle("player-action", (id: string, player: string, action: PlayerAction) => instances.playerAction(id, player, action));
handle("item-icons", (id: string, ids: string[]) => instances.itemIcons(id, ids));
handle("show-main", (id?: string) => {
    tray?.hidePanel();
    show(id);
});
handle("quit-app", () => app.quit());
handle("tray-size", (height: number) => tray?.resize(height));
handle("stats", (id: string) => instances.stats(id));
handle("export-server", async (id: string): Promise<ExportResult | null> => {
    const view = server(id);
    const result = await dialog.showSaveDialog(window!, {
        title: "Export server",
        defaultPath: join(app.getPath("downloads"), `${view.id}.zip`),
        filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const manifest = Buffer.from(JSON.stringify(instances.manifest(id), null, 2));
    const written = await writeZip(instances.dir(id), result.filePath, undefined, [{ path: MANIFEST, bytes: manifest }]);
    return { path: result.filePath, ...written };
});
handle("import-server", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(window!, {
        title: "Import server",
        defaultPath: app.getPath("downloads"),
        filters: [{ name: "Zip", extensions: ["zip"] }],
        properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return instances.importZip(result.filePaths[0]);
});
handle("create-entry", (id: string, path: string, directory: boolean) => files.create(instances.dir(id), path, directory));
handle("rename-entry", (id: string, from: string, to: string) => files.rename(instances.dir(id), from, to));
handle("delete-entry", (id: string, path: string) => files.remove(instances.dir(id), path));
handle("duplicate-entry", (id: string, path: string) => files.duplicate(instances.dir(id), path));
handle("import-files", (id: string, dir: string, sources: string[]) => files.importPaths(instances.dir(id), dir, sources));
handle("search-files", (id: string, options: SearchOptions, token: string) => files.search(instances.dir(id), options, token));
handle("cancel-search", (token: string) => files.cancelSearch(token));
handle("original-file", (id: string, path: string) => files.original(instances.dir(id), path));
handle("list-jar", (id: string, jar: string, dir: string) => jars.listJar(files.resolveInside(instances.dir(id), jar), dir));
handle("open-jar-entry", (id: string, jar: string, entry: string, token: string) =>
    jars.openEntry(settings.javaPath, dirs.cache, files.resolveInside(instances.dir(id), jar), entry, token));
handle("cancel-jar", (token: string) => jars.cancel(token));
handle("open-folder", async (id: string) => {
    await shell.openPath(instances.dir(id));
});

app.whenReady().then(async () => {
    if (!primary) return;
    if (safeStorage.isEncryptionAvailable()) {
        vault = {
            encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
            decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
        };
    }
    for (const extension of builtins) extensions.register(extension, true);
    await extensions.discover();
    settings = await loadSettings(dirs.settings, vault);
    // Secrets written before the vault existed are sealed the first time this version runs.
    if (vault) await save(settings);
    await instances.purgeOrphans();
    createWindow();
    await extensions.start();
    for (const { extension, fn } of hooks.of("appStart")) {
        await Promise.resolve(fn()).catch((error: Error) => console.warn(`${extension} did not finish starting`, error));
    }
    tray = new TrayIcon(instances, load, PRELOAD, show);
    updater.start();
});

// Test servers are throwaway: closing the app stops and deletes every one of them.
let quitting = false;
app.on("before-quit", (event) => {
    if (quitting || !primary) return;
    event.preventDefault();
    quitting = true;
    instances.destroyAll()
        .then(async () => {
            for (const { extension, fn } of hooks.of("appQuit")) {
                await Promise.resolve(fn()).catch((error: Error) => console.warn(`${extension} did not finish quitting`, error));
            }
            await extensions.stop();
        })
        .finally(() => {
            tray?.destroy();
            app.quit();
        });
});

app.on("window-all-closed", () => app.quit());
