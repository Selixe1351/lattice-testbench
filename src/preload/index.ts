import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { TestbenchApi } from "@shared/types";

function listen<T>(channel: string) {
    return (listener: (payload: T) => void) => {
        const wrapped = (_event: unknown, payload: T) => listener(payload);
        ipcRenderer.on(channel, wrapped);
        return () => {
            ipcRenderer.removeListener(channel, wrapped);
        };
    };
}

// The renderer gets these calls and nothing else: no ipcRenderer, no Node.
const api: TestbenchApi = {
    settings: () => ipcRenderer.invoke("settings"),
    saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
    extensions: () => ipcRenderer.invoke("extensions"),
    setExtensionEnabled: (id, enabled) => ipcRenderer.invoke("set-extension-enabled", id, enabled),
    saveExtensionValues: (id, values) => ipcRenderer.invoke("save-extension-values", id, values),
    runExtensionAction: (id, action, serverId) => ipcRenderer.invoke("run-extension-action", id, action, serverId),
    extension: (id, channel, ...args) => ipcRenderer.invoke(`ext:${id}:${channel}`, ...args),
    onExtensions: listen("extensions"),
    onExtensionEvent: (id, channel, listener) => listen<any>(`ext:${id}:${channel}`)(listener),
    openExtensionsFolder: () => ipcRenderer.invoke("open-extensions-folder"),
    pickFile: (title, extensions) => ipcRenderer.invoke("pick-file", title, extensions),
    pickFolder: (title) => ipcRenderer.invoke("pick-folder", title),
    pickJars: (title) => ipcRenderer.invoke("pick-jars", title),
    versions: () => ipcRenderer.invoke("versions"),
    servers: () => ipcRenderer.invoke("servers"),
    deploy: (request) => ipcRenderer.invoke("deploy", request),
    extend: (id) => ipcRenderer.invoke("extend", id),
    start: (id) => ipcRenderer.invoke("start", id),
    stop: (id) => ipcRenderer.invoke("stop", id),
    restart: (id) => ipcRenderer.invoke("restart", id),
    kill: (id) => ipcRenderer.invoke("kill", id),
    destroy: (id) => ipcRenderer.invoke("destroy", id),
    command: (id, process, line) => ipcRenderer.invoke("command", id, process, line),
    history: (id) => ipcRenderer.invoke("history", id),
    listFiles: (id, path) => ipcRenderer.invoke("list-files", id, path),
    readFile: (id, path) => ipcRenderer.invoke("read-file", id, path),
    readImage: (id, path) => ipcRenderer.invoke("read-image", id, path),
    writeFile: (id, path, content) => ipcRenderer.invoke("write-file", id, path, content),
    rename: (id, label) => ipcRenderer.invoke("rename", id, label),
    reloadPlugins: (id) => ipcRenderer.invoke("reload-plugins", id),
    installJava: () => ipcRenderer.invoke("install-java"),
    keep: (id, kept) => ipcRenderer.invoke("keep", id, kept),
    profile: (id, process) => ipcRenderer.invoke("profile", id, process),
    snapshots: () => ipcRenderer.invoke("snapshots"),
    snapshot: (id, name) => ipcRenderer.invoke("snapshot", id, name),
    deleteSnapshot: (id) => ipcRenderer.invoke("delete-snapshot", id),
    restoreSnapshot: (id) => ipcRenderer.invoke("restore-snapshot", id),
    importServer: () => ipcRenderer.invoke("import-server"),
    deployMatrix: (request, targets) => ipcRenderer.invoke("deploy-matrix", request, targets),
    placeholder: (id, process, player, text) => ipcRenderer.invoke("placeholder", id, process, player, text),
    completions: (id, process, line) => ipcRenderer.invoke("completions", id, process, line),
    playerInfo: (id, player) => ipcRenderer.invoke("player-info", id, player),
    playerAction: (id, player, action) => ipcRenderer.invoke("player-action", id, player, action),
    itemIcons: (id, ids) => ipcRenderer.invoke("item-icons", id, ids),
    onSelect: listen("select"),
    showMain: (id) => ipcRenderer.invoke("show-main", id),
    quitApp: () => ipcRenderer.invoke("quit-app"),
    traySize: (height) => ipcRenderer.invoke("tray-size", height),
    exportServer: (id) => ipcRenderer.invoke("export-server", id),
    stats: (id) => ipcRenderer.invoke("stats", id),
    createEntry: (id, path, directory) => ipcRenderer.invoke("create-entry", id, path, directory),
    renameEntry: (id, from, to) => ipcRenderer.invoke("rename-entry", id, from, to),
    deleteEntry: (id, path) => ipcRenderer.invoke("delete-entry", id, path),
    duplicateEntry: (id, path) => ipcRenderer.invoke("duplicate-entry", id, path),
    importFiles: (id, dir, sources) => ipcRenderer.invoke("import-files", id, dir, sources),
    pathForFile: (file) => webUtils.getPathForFile(file),
    searchFiles: (id, options, token) => ipcRenderer.invoke("search-files", id, options, token),
    cancelSearch: (token) => ipcRenderer.invoke("cancel-search", token),
    originalFile: (id, path) => ipcRenderer.invoke("original-file", id, path),
    listJar: (id, jar, dir) => ipcRenderer.invoke("list-jar", id, jar, dir),
    openJarEntry: (id, jar, entry, token) => ipcRenderer.invoke("open-jar-entry", id, jar, entry, token),
    cancelJar: (token) => ipcRenderer.invoke("cancel-jar", token),
    openFolder: (id) => ipcRenderer.invoke("open-folder", id),
    onConsole: listen("console"),
    onServers: listen("servers"),
    updateStatus: () => ipcRenderer.invoke("update-status"),
    checkForUpdates: () => ipcRenderer.invoke("check-updates"),
    installUpdate: () => ipcRenderer.invoke("install-update"),
    onUpdate: listen("update"),
    onStats: listen("stats"),
};

contextBridge.exposeInMainWorld("testbench", api);
