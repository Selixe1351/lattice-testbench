import { BrowserWindow, nativeImage, Notification, screen, Tray } from "electron";
import type { ServerView } from "@shared/types";
import type { Instances } from "./instances";
import { SERVER_ICON } from "./server-icon";

/**
 * The tray icon and its panel: a small frameless window, drawn by the same React app as the main window
 * (the `#tray` route), that opens beside the icon on either click and hides when it loses focus. It lists
 * the servers with their time left and the everyday actions, so the main window can stay closed while
 * servers run. Quitting from the panel is the only way to end the app with servers up, and it says so.
 */

const WIDTH = 360;
// Tall enough for three servers with room to spare; the list scrolls past the maximum.
const MIN_HEIGHT = 440;
const MAX_HEIGHT = 820;
const MARGIN = 8;

export class TrayIcon {
    private readonly tray: Tray;
    private panel: BrowserWindow | null = null;
    private height = 320;
    /** When the panel last hid on blur. A click on the icon blurs it first, so that click must not reopen it. */
    private hiddenAt = 0;
    hinted = false;

    constructor(
        instances: Instances,
        private readonly load: (window: BrowserWindow, route: string) => void,
        private readonly preload: string,
        private readonly show: (serverId?: string) => void,
    ) {
        // 64 px drawn at 4x, so it is a sharp 16 px icon on any display scale.
        this.tray = new Tray(nativeImage.createFromBuffer(SERVER_ICON, { scaleFactor: 4 }));
        this.tray.setToolTip("Lattice Testbench");
        this.tray.on("click", () => this.toggle());
        this.tray.on("right-click", () => this.toggle());
        instances.on("servers", (list: ServerView[]) => {
            this.tray.setToolTip(list.length === 0 ? "Lattice Testbench" : `Lattice Testbench: ${list.length} server${list.length === 1 ? "" : "s"}`);
        });
        instances.on("expiring", (view: ServerView) => this.notify(`${view.label} is deleted in five minutes`, "Click to open it, then add 30 minutes or keep it.", view.id));
    }

    /** Says once that closing the window left the servers running. */
    hintHidden(): void {
        if (this.hinted) return;
        this.hinted = true;
        this.notify("Still running", "Your test servers keep running. Click the tray icon to manage them or quit.");
    }

    /** The panel's content changed size; fit the window to it, within limits, and keep it by the icon. */
    resize(height: number): void {
        this.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
        if (this.panel?.isVisible()) this.place();
    }

    hidePanel(): void {
        this.panel?.hide();
    }

    destroy(): void {
        this.panel?.destroy();
        this.tray.destroy();
    }

    private toggle(): void {
        if (this.panel?.isVisible()) {
            this.panel.hide();
            return;
        }
        if (Date.now() - this.hiddenAt < 300) return;
        const panel = this.ensurePanel();
        this.place();
        panel.show();
        panel.focus();
    }

    private ensurePanel(): BrowserWindow {
        if (this.panel && !this.panel.isDestroyed()) return this.panel;
        const panel = new BrowserWindow({
            width: WIDTH,
            height: this.height,
            show: false,
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            backgroundColor: "#00000000",
            webPreferences: { preload: this.preload, sandbox: false, contextIsolation: true, nodeIntegration: false },
        });
        panel.on("blur", () => {
            this.hiddenAt = Date.now();
            panel.hide();
        });
        this.load(panel, "tray");
        this.panel = panel;
        return panel;
    }

    /** Above the icon when the taskbar is at the bottom, below it when at the top; always inside the work area. */
    private place(): void {
        if (!this.panel) return;
        const icon = this.tray.getBounds();
        const area = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea;
        const x = Math.min(Math.max(icon.x + icon.width / 2 - WIDTH / 2, area.x + MARGIN), area.x + area.width - WIDTH - MARGIN);
        // Never taller than the screen it opens on, whatever the content asks for.
        const height = Math.min(this.height, area.height - MARGIN * 2);
        const below = icon.y < area.y + area.height / 2;
        const y = below ? area.y + MARGIN : area.y + area.height - height - MARGIN;
        this.panel.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height });
    }

    private notify(title: string, body: string, serverId?: string): void {
        if (!Notification.isSupported()) return;
        const notification = new Notification({ title, body, icon: nativeImage.createFromBuffer(SERVER_ICON) });
        notification.on("click", () => this.show(serverId));
        notification.show();
    }
}
