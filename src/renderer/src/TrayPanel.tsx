import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ServerView } from "@shared/types";
import { Clock, External, Globe, Logo, Pin, Play, Stop, Trash } from "./icons";
import { remaining, useNow } from "./time";
import { confirm } from "./confirm";

const api = window.testbench;

const STATE_TEXT: Record<ServerView["state"], string> = {
    preparing: "Preparing",
    starting: "Starting",
    running: "Running",
    stopping: "Stopping",
    stopped: "Stopped",
    failed: "Failed",
};

/** One server in the panel: state, time left, and the actions people reach for without the main window. */
function Row({ server, now }: { server: ServerView; now: number }) {
    const up = server.processes.some((p) => p.state === "running" || p.state === "starting");
    const settled = server.state !== "preparing" && server.state !== "stopping" && !server.error;
    const low = !server.kept && server.expiresAt - now < 5 * 60_000;
    const [copied, setCopied] = useState(false);
    const address = server.publicAddress ?? server.address;

    return (
        <div className="tray-row">
            <div className="tray-row-top" onClick={() => void api.showMain(server.id)} title="Open in Testbench">
                <span className={`dot ${server.state}`} />
                <div className="tray-name">
                    <b>{server.label}</b>
                    <span className="faint sm">
                        {STATE_TEXT[server.state]}
                        {server.modules.length > 0 && ` · ${server.modules.length} module${server.modules.length === 1 ? "" : "s"}`}
                    </span>
                </div>
                <span className={`timer small ${low ? "low" : ""}`}>
                    {server.kept ? <><Pin /> kept</> : <><Clock /> {remaining(server.expiresAt, now)}</>}
                </span>
            </div>
            {address && (
                <div className="tray-row-info">
                    <span
                        className={`copy ${server.publicAddress ? "public" : ""}`}
                        title="Copy address"
                        onClick={() => {
                            void navigator.clipboard.writeText(address);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1000);
                        }}
                    >
                        {server.publicAddress && <Globe />} {copied ? "copied" : address}
                    </span>
                </div>
            )}
            <div className="tray-actions">
                <button className="btn sm ghost" disabled={server.kept || server.state === "stopping"} onClick={() => void api.extend(server.id)} title="Add 30 minutes">+30m</button>
                <button className={`btn sm ${server.kept ? "" : "ghost"}`} disabled={server.state === "stopping"} onClick={() => void api.keep(server.id, !server.kept)} title={server.kept ? "Let it expire" : "Keep: no expiry"}><Pin /></button>
                {up
                    ? <button className="btn sm ghost" disabled={!settled} onClick={() => void api.stop(server.id)} title="Save and stop"><Stop /></button>
                    : <button className="btn sm ghost" disabled={!settled || server.processes.length === 0} onClick={() => void api.start(server.id)} title="Start"><Play /></button>}
                <span className="grow" />
                <button className="btn sm ghost danger-text" disabled={server.state === "stopping"} onClick={() => void api.destroy(server.id)} title="Delete server"><Trash /></button>
            </div>
        </div>
    );
}

/** The tray icon's panel. Its window sizes itself to this content, up to a limit, then the list scrolls. */
export function TrayPanel() {
    const [servers, setServers] = useState<ServerView[]>([]);
    const now = useNow();
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        document.body.classList.add("tray");
        void api.servers().then(setServers);
        return api.onServers(setServers);
    }, []);

    useLayoutEffect(() => {
        const el = root.current;
        const list = el?.querySelector<HTMLElement>(".tray-list");
        if (!el || !list) return;
        // The panel fills its window, so its own height says nothing; the list's content is what to fit.
        const measure = () => void api.traySize(el.offsetHeight - list.clientHeight + list.scrollHeight);
        const observer = new ResizeObserver(measure);
        observer.observe(list);
        for (const child of list.children) observer.observe(child);
        measure();
        return () => observer.disconnect();
    }, [servers.length]);

    const quit = async () => {
        if (servers.length > 0 && !(await confirm(`Quitting deletes ${servers.length} test server${servers.length === 1 ? "" : "s"}. Quit?`, { action: "Quit" }))) return;
        void api.quitApp();
    };

    return (
        <div className="tray-panel" ref={root}>
            <div className="tray-head">
                <Logo size={18} />
                <b>Lattice Testbench</b>
                <span className="faint sm">{servers.length === 0 ? "nothing running" : `${servers.length} server${servers.length === 1 ? "" : "s"}`}</span>
            </div>
            <div className="tray-list">
                {servers.length === 0 && <p className="faint sm tray-empty">No test servers. Open Testbench to deploy one.</p>}
                {servers.map((s) => <Row key={s.id} server={s} now={now} />)}
            </div>
            <div className="tray-foot">
                <button className="btn sm primary" onClick={() => void api.showMain()}><External /> Open Testbench</button>
                <span className="grow" />
                <button className="btn sm ghost danger-text" onClick={quit}>{servers.length > 0 ? `Quit and delete ${servers.length}` : "Quit"}</button>
            </div>
        </div>
    );
}
