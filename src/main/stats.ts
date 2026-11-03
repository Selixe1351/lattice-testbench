import { execFile } from "node:child_process";
import { cpus } from "node:os";

/** Total CPU seconds and resident memory of each of [pids], for the ones that are still alive. */
export interface Reading {
    pid: number;
    cpuSeconds: number;
    memoryBytes: number;
}

const CORES = cpus().length || 1;

function run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, timeout: 8000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

/** One reading per live pid. A pid that has exited is simply absent. */
export async function read(pids: number[]): Promise<Reading[]> {
    if (pids.length === 0) return [];
    if (process.platform === "win32") {
        // CPU is the process's total processor time in seconds, which is why callers sample twice and divide.
        const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.CPU) $($_.WorkingSet64)" }`;
        return parse(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
    }
    // cputime is [[dd-]hh:]mm:ss; rss is in KB.
    const text = await run("ps", ["-o", "pid=,cputime=,rss=", "-p", pids.join(",")]);
    return text.split(/\r?\n/).flatMap((line) => {
        const [pid, time, rss] = line.trim().split(/\s+/);
        if (!pid || !time || !rss) return [];
        return [{ pid: Number(pid), cpuSeconds: clock(time), memoryBytes: Number(rss) * 1024 }];
    });
}

function parse(text: string): Reading[] {
    return text.split(/\r?\n/).flatMap((line) => {
        const [pid, cpu, memory] = line.trim().split(/\s+/);
        if (!pid || !memory) return [];
        // PowerShell prints the decimal comma on some locales.
        return [{ pid: Number(pid), cpuSeconds: Number(cpu.replace(",", ".")) || 0, memoryBytes: Number(memory) }];
    });
}

export function clock(value: string): number {
    const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
    const parts = rest.split(":").map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** CPU percent of one core between two readings of the same process. */
export function cpuPercent(before: Reading, after: Reading, seconds: number): number {
    if (seconds <= 0) return 0;
    return Math.max(0, ((after.cpuSeconds - before.cpuSeconds) / seconds) * 100);
}

export { CORES };

/**
 * Where the Jolokia agent in a game server listens, from the line it prints on start. It is given port 0 and
 * picks a free one itself, so this line is the only place the address appears.
 */
export function jolokiaUrl(line: string): string | null {
    return /Jolokia: Agent \S+ started with URL (http:\/\/127\.0\.0\.1:\d+\/jolokia)/.exec(line)?.[1] ?? null;
}

/**
 * Tick rate from the server's own JMX bean (enable-jmx-monitoring), averaged over the last 100 ticks. Read over
 * HTTP rather than by sending /tps and /mspt, which put a command into the server's log every few seconds.
 */
export async function tickRate(jolokia: string): Promise<{ tps: number; mspt: number } | null> {
    const response = await fetch(`${jolokia}/read/net.minecraft.server:type=Server/averageTickTime`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { status: number; value?: unknown };
    // Zero means the bean exists but nothing ticks through it, which is not a reading of 20 TPS.
    if (body.status !== 200 || typeof body.value !== "number" || body.value <= 0) return null;
    // The bean has no tick count, so TPS follows from MSPT: a tick under 50 ms waits out the rest, capping it at 20.
    return { mspt: Math.round(body.value * 10) / 10, tps: Math.round(Math.min(20, 1000 / body.value) * 10) / 10 };
}
