import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readEntryBytes } from "../../../jar";
import { fetchCached } from "../../../sources";
import type { PublishSettings } from "./settings";

/**
 * An outbound frp tunnel from this PC to a VPS. Players connect to the VPS; this PC only ever dials out, so
 * its address appears in no DNS record and no port needs forwarding. frpc is fetched from the frp releases
 * and checked against the checksum published with them.
 */

const FRP = "0.71.1";
const ARCHIVE = {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP}/frp_${FRP}_windows_amd64.zip`,
    fileName: `frp_${FRP}_windows_amd64.zip`,
    sha256: "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821",
};
const CONNECT_TIMEOUT_MS = 20_000;

export interface Tunnel {
    /** The port on the VPS that players reach. */
    remotePort: number;
    /** Closes the tunnel. A tunnel closed this way does not call the exit handler. */
    stop(): Promise<void>;
}

/**
 * Where a tunnel goes: the frps on your VPS, which checks a shared token.
 */
export interface TunnelTarget {
    host: string;
    port: number;
    token?: string;
    /** The VPS port range, for the message when a port is refused. */
    range?: [number, number];
}

/** The VPS, as the extension settings describe it. */
export function targetOf(settings: PublishSettings): TunnelTarget {
    return { host: settings.tunnelHost, port: settings.tunnelPort, token: settings.tunnelToken, range: [settings.tunnelFirstPort, settings.tunnelLastPort] };
}

export function configured(settings: PublishSettings): boolean {
    return Boolean(settings.tunnelHost && settings.tunnelToken && settings.tunnelFirstPort && settings.tunnelLastPort >= settings.tunnelFirstPort);
}

/** The first port in the configured range that no published server holds. */
export function pickPort(settings: PublishSettings, used: Set<number>): number {
    for (let port = settings.tunnelFirstPort; port <= settings.tunnelLastPort; port++) {
        if (!used.has(port)) return port;
    }
    throw new Error(`All ${settings.tunnelLastPort - settings.tunnelFirstPort + 1} tunnel ports (${settings.tunnelFirstPort}-${settings.tunnelLastPort}) are in use.`);
}

const quote = (value: string) => JSON.stringify(value);

export function renderConfig(target: TunnelTarget, name: string, localPort: number, remotePort: number): string {
    return [
        `serverAddr = ${quote(target.host)}`,
        `serverPort = ${target.port}`,
        // Without this a refused login leaves frpc retrying forever instead of failing the publish.
        `loginFailExit = true`,
        ...(target.token ? [`auth.method = "token"`, `auth.token = ${quote(target.token)}`] : []),
        ``,
        `[[proxies]]`,
        `name = ${quote(name)}`,
        `type = "tcp"`,
        `localIP = "127.0.0.1"`,
        `localPort = ${localPort}`,
        `remotePort = ${remotePort}`,
        ``,
    ].join("\n");
}

/** What a line of frpc output means for the tunnel coming up. */
export function classify(line: string): "ready" | "failed" | null {
    if (/start proxy success/i.test(line)) return "ready";
    if (/login to (the )?server failed|start error|port not allowed|port already used|proxy name \[.*\] is already in use/i.test(line)) return "failed";
    return null;
}

const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** What a failed frpc line means, in words a person can act on; frpc's own text is kept only as a fallback. */
export function explain(line: string, target: TunnelTarget): string {
    const vps = `${target.host}:${target.port}`;
    if (/i\/o timeout|connectex: A connection attempt failed|no route to host|network is unreachable|no such host/i.test(line)) {
        // A tailnet address answers only from inside its tailnet, so this is nearly always the wrong account.
        const hint = TAILSCALE.test(target.host)
            ? " That is a Tailscale address: check Tailscale is running on this PC and signed in to the tailnet the VPS is on."
            : " Check the VPS address in Settings and that the VPS is up.";
        return `Could not reach the VPS at ${vps}.${hint}`;
    }
    if (/connection refused|actively refused/i.test(line)) return `The VPS at ${vps} answered, but frps is not listening there. Check that frps is running on it.`;
    if (/token/i.test(line)) return "The VPS rejected the tunnel token. Copy it again from /etc/frp/frps.toml into Settings.";
    if (/port not allowed/i.test(line)) return `The VPS does not allow that port. Make the tunnel ports in Settings (${target.range?.join("-") ?? "?"}) match allowPorts on the VPS.`;
    if (/port already used/i.test(line)) return "That port on the VPS is already taken, perhaps by another PC's tunnel. Try publishing again.";
    if (/is already in use/i.test(line)) return "The VPS still has a tunnel with this server's name, perhaps left by a crash. Wait a minute and try again.";
    return `The VPS refused the tunnel: ${line}`;
}

async function frpc(cacheDir: string): Promise<string> {
    if (process.platform !== "win32") throw new Error("Tunnels are only set up for Windows here.");
    const target = join(cacheDir, "tools", `frpc-${FRP}.exe`);
    if (existsSync(target)) return target;
    const archive = await fetchCached(join(cacheDir, "tools"), ARCHIVE);
    const bytes = await readEntryBytes(archive, `frp_${FRP}_windows_amd64/frpc.exe`);
    await mkdir(join(cacheDir, "tools"), { recursive: true });
    // Renamed into place so a half-written exe is never mistaken for a good one.
    await writeFile(`${target}.part`, bytes);
    await rename(`${target}.part`, target);
    return target;
}

/**
 * Opens a tunnel from [localPort] on this PC to [remotePort] on the VPS and resolves once frps has accepted
 * it. [onExit] is called if it later dies on its own.
 */
export async function open(
    target: TunnelTarget,
    cacheDir: string,
    name: string,
    localPort: number,
    remotePort: number,
    log: (line: string) => void,
    onExit: (reason: string) => void,
): Promise<Tunnel> {
    const exe = await frpc(cacheDir);
    // The config holds the token, so it lives in a private temp folder that goes when the tunnel does.
    const work = await mkdtemp(join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "testbench-frpc-"));
    const config = join(work, "frpc.toml");
    await writeFile(config, renderConfig(target, name, localPort, remotePort));

    const child: ChildProcess = spawn(exe, ["-c", config], { windowsHide: true });
    let stopping = false;
    let settled = false;
    const tail: string[] = [];

    const cleanup = () => rm(work, { recursive: true, force: true }).catch((e) => console.warn(`Could not remove ${work}`, e));
    const stop = async () => {
        stopping = true;
        if (child.exitCode === null) {
            await new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                child.kill();
                setTimeout(() => child.kill("SIGKILL"), 3000).unref();
            });
        }
        await cleanup();
    };

    return new Promise<Tunnel>((resolve, reject) => {
        const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) void stop().then(() => reject(error));
            else resolve({ remotePort, stop });
        };
        // The full frpc output is in the console under "tunnel"; the error only says what to do about it.
        const failure = (fallback: string) => {
            const line = [...tail].reverse().find((l) => classify(l) === "failed" || /error|failed/i.test(l));
            return new Error(line ? explain(line, target) : fallback);
        };
        const timer = setTimeout(() => settle(failure(`The tunnel did not come up in ${CONNECT_TIMEOUT_MS / 1000}s.`)), CONNECT_TIMEOUT_MS);

        const read = (chunk: Buffer) => {
            for (const raw of chunk.toString().split(/\r?\n/)) {
                const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
                if (!line) continue;
                tail.push(line);
                if (tail.length > 6) tail.shift();
                log(line);
                const verdict = classify(line);
                if (!settled && verdict === "ready") settle();
                else if (!settled && verdict === "failed") settle(new Error(explain(line, target)));
                else if (settled && verdict === "failed" && !stopping) {
                    // Refused after it was up: the relay dropped it (frps restarted, or the token changed) and
                    // frpc would retry the refused login forever. That is the end of the tunnel, so say so.
                    void stop().then(() => onExit(explain(line, target)));
                }
            }
        };
        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
        child.on("error", (e) => settle(new Error(`Could not start frpc: ${e.message}`)));
        child.on("exit", (code) => {
            if (!settled) settle(failure(`frpc exited with code ${code} before connecting.`));
            else if (!stopping) {
                void cleanup();
                onExit(`frpc exited with code ${code}`);
            }
        });
    });
}
