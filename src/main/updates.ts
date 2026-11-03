import { EventEmitter } from "node:events";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "@shared/types";

const CHECK_EVERY_MS = 30 * 60_000;

/**
 * Keeps the installed app current from this project's GitHub Releases. electron-builder writes the feed into the
 * installer (the `publish` block in electron-builder.yml), so there is nothing to configure and no token in the app.
 *
 * A new version downloads in the background and installs when the app is next quit, or on request. Either
 * way the app quits, and quitting deletes every test server, so installing is never done behind the
 * person's back while servers are running unless they quit themselves.
 */
export class Updater extends EventEmitter {
    private status: UpdateStatus = { state: "off", current: app.getVersion(), note: "Not started." };
    private timer: NodeJS.Timeout | undefined;

    constructor() {
        super();
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = console;
        autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
        autoUpdater.on("update-available", (info) => this.set({ state: "downloading", version: info.version, percent: 0 }));
        autoUpdater.on("update-not-available", () => this.set({ state: "idle", version: undefined }));
        autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.round(p.percent) }));
        autoUpdater.on("update-downloaded", (info) => this.set({ state: "ready", version: info.version, percent: 100 }));
        autoUpdater.on("error", (error) => {
            console.warn("Update check failed", error);
            this.set({ state: "error", note: error.message.split("\n")[0].slice(0, 200) });
        });
    }

    get current(): UpdateStatus {
        return this.status;
    }

    /** Checks now and every half hour. A copy run from source never updates itself. */
    start(): void {
        if (this.timer) return;
        if (!app.isPackaged) {
            this.set({ state: "off", version: undefined, note: "Only the installed app updates, not a copy run from source." });
            return;
        }
        this.set({ state: "idle", note: undefined });
        void this.check();
        this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }

    async check(): Promise<void> {
        if (!app.isPackaged) return;
        // Once a version is downloaded there is nothing more to look for until it is installed.
        if (this.status.state === "ready" || this.status.state === "downloading" || this.status.state === "checking") return;
        try {
            await autoUpdater.checkForUpdates();
        } catch (error) {
            // The "error" event above already reported it; this only stops the rejection going unhandled.
            console.warn("checkForUpdates rejected", error);
        }
    }

    /** Quits and installs the downloaded version, then starts the app again. */
    install(): void {
        if (this.status.state !== "ready") throw new Error("There is no downloaded update to install.");
        autoUpdater.quitAndInstall(true, true);
    }

    private set(change: Partial<UpdateStatus>): void {
        this.status = { ...this.status, ...change, current: app.getVersion() };
        this.emit("status", this.status);
    }
}
