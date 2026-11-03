import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEntryBytes } from "../src/main/jar";
import { fetchCached } from "../src/main/sources";
import { open, targetOf } from "../src/main/extensions/builtin/publishing/tunnel";
import type { PublishSettings } from "../src/main/extensions/builtin/publishing/settings";

// Runs a real frps on this machine and opens a real tunnel through it, so it downloads frp on first run.
describe.skipIf(!process.env.TESTBENCH_TUNNEL || process.platform !== "win32")("tunnel against a local frps", () => {
    it("carries bytes to the remote port and closes it on stop", async () => {
        const cache = await mkdtemp(join(tmpdir(), "tb-tunnel-cache-"));
        const archive = await fetchCached(join(cache, "tools"), {
            url: "https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip",
            fileName: "frp_0.71.1_windows_amd64.zip",
            sha256: "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821",
        });
        const work = await mkdtemp(join(tmpdir(), "tb-frps-"));
        const frps = join(work, "frps.exe");
        await writeFile(frps, await readEntryBytes(archive, "frp_0.71.1_windows_amd64/frps.exe"));
        await writeFile(join(work, "frps.toml"), 'bindAddr = "127.0.0.1"\nbindPort = 17000\nauth.method = "token"\nauth.token = "live-token"\nallowPorts = [{ start = 17100, end = 17110 }]\n');
        const server = spawn(frps, ["-c", join(work, "frps.toml")], { windowsHide: true });

        // A stand-in for the Minecraft server: answers every connection with a greeting.
        const local = createServer((socket) => socket.end("hello from local"));
        await new Promise<void>((resolve) => local.listen(17200, "127.0.0.1", resolve));

        const settings = { tunnelHost: "127.0.0.1", tunnelPort: 17000, tunnelToken: "live-token", tunnelFirstPort: 17100, tunnelLastPort: 17100 } as PublishSettings;
        try {
            await new Promise((r) => setTimeout(r, 1000));
            const tunnel = await open(targetOf(settings), cache, "lattice-test-live", 17200, 17100, () => {}, () => {});
            const received = await new Promise<string>((resolve, reject) => {
                const socket = connect(17100, "127.0.0.1");
                let text = "";
                socket.on("data", (d) => (text += d.toString()));
                socket.on("close", () => resolve(text));
                socket.on("error", reject);
            });
            expect(received).toBe("hello from local");

            await tunnel.stop();
            await new Promise((r) => setTimeout(r, 500));
            const after = await new Promise<string>((resolve) => {
                const socket = connect(17100, "127.0.0.1");
                let text = "";
                socket.on("data", (d) => (text += d.toString()));
                socket.on("close", () => resolve(text));
                socket.on("error", () => resolve("refused"));
            });
            expect(after).not.toBe("hello from local");

            await expect(open(targetOf({ ...settings, tunnelToken: "wrong" }), cache, "x", 17200, 17101, () => {}, () => {})).rejects.toThrow();
            await expect(open(targetOf(settings), cache, "x", 17200, 17999, () => {}, () => {})).rejects.toThrow(/port not allowed|refused/i);
        } finally {
            server.kill();
            local.close();
        }
    }, 120_000);
});
