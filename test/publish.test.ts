import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishSettings } from "../src/main/extensions/builtin/publishing/settings";
import { clock, cpuPercent } from "../src/main/stats";
import { COMMENT, labelFor, publish, purge, remove } from "../src/main/extensions/builtin/publishing/cloudflare";

const settings: PublishSettings = {
    publicDomain: "example.net",
    cloudflareToken: "token",
    tunnelHost: "203.0.113.7",
    tunnelPublicHost: "",
    tunnelPort: 7000,
    tunnelToken: "secret",
    tunnelFirstPort: 25700,
    tunnelLastPort: 25799,
    discordWebhook: "",
};

interface Call {
    method: string;
    url: string;
    body: unknown;
}

describe("publishing", () => {
    let calls: Call[];
    let respond: (call: Call) => { ok: boolean; result: unknown };

    beforeEach(() => {
        calls = [];
        respond = (call) => {
            if (call.url.includes("/zones?name=")) return { ok: true, result: [{ id: "zone1" }] };
            if (call.method === "POST") return { ok: true, result: { id: `rec${calls.filter((c) => c.method === "POST").length}` } };
            if (call.method === "GET") return { ok: true, result: [] };
            return { ok: true, result: {} };
        };
        vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
            const call: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(init.body) : undefined };
            calls.push(call);
            const answer = respond(call);
            return {
                ok: answer.ok,
                status: answer.ok ? 200 : 400,
                json: async () => ({ success: answer.ok, errors: answer.ok ? [] : [{ message: "nope" }], result: answer.result }),
            };
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it("names a server after the tail of its id", () => {
        expect(labelFor("velocity-lx3k2a")).toBe("testbench-lx3k2a");
    });

    it("creates an unproxied A record and an SRV record for the port", async () => {
        const published = await publish(settings, "paper-ab12", 25601);
        expect(published).toEqual({ address: "testbench-ab12.example.net", records: ["rec1", "rec2"] });

        const posts = calls.filter((c) => c.method === "POST");
        expect(posts[0].body).toMatchObject({ type: "A", name: "testbench-ab12.example.net", content: "203.0.113.7", proxied: false });
        expect(posts[1].body).toMatchObject({
            type: "SRV",
            name: "_minecraft._tcp.testbench-ab12.example.net",
            data: { port: 25601, target: "testbench-ab12.example.net" },
        });
    });

    it("uses a CNAME when the public address is a hostname", async () => {
        await publish({ ...settings, tunnelHost: "vps.example.org" }, "paper-ab12", 25601);
        expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ type: "CNAME", content: "vps.example.org" });
    });

    it("points DNS at the public address, not the tailnet one frpc dials", async () => {
        await publish({ ...settings, tunnelHost: "100.64.0.1", tunnelPublicHost: "198.51.100.9" }, "paper-ab12", 25601);
        expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ type: "A", content: "198.51.100.9" });
    });

    it("takes back the A record when the SRV record fails", async () => {
        respond = (call) => {
            if (call.url.includes("/zones?name=")) return { ok: true, result: [{ id: "zone1" }] };
            if (call.method === "POST" && JSON.stringify(call.body).includes("SRV")) return { ok: false, result: null };
            if (call.method === "POST") return { ok: true, result: { id: "rec-a" } };
            return { ok: true, result: {} };
        };
        await expect(publish(settings, "paper-ab12", 25601)).rejects.toThrow(/nope/);
        expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/dns_records/rec-a"))).toBe(true);
    });

    it("refuses when the domain or token is missing", async () => {
        await expect(publish({ ...settings, cloudflareToken: "" }, "paper-ab12", 25601)).rejects.toThrow(/Settings/);
        expect(calls).toHaveLength(0);
    });

    it("removes records by id", async () => {
        await remove(settings, ["a", "b"]);
        expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop())).toEqual(["a", "b"]);
    });

    it("purges only this PC's records under the testbench- prefix in the domain", async () => {
        respond = (call) => {
            if (call.url.includes("/zones?name=")) return { ok: true, result: [{ id: "zone1" }] };
            if (call.method === "GET" && call.url.includes("name.startswith=testbench-")) {
                return { ok: true, result: [
                    { id: "x1", name: "testbench-a.example.net", comment: COMMENT },
                    { id: "x2", name: "testbench-b.other.org", comment: COMMENT },
                    // Another PC's live server: the reaper judges it, not this PC's start-up.
                    { id: "x3", name: "testbench-c.example.net", comment: "Lattice Testbench on OTHER-PC" },
                ] };
            }
            if (call.method === "GET") return { ok: true, result: [] };
            return { ok: true, result: {} };
        };
        expect(await purge(settings)).toBe(1);
        expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").pop())).toEqual(["x1"]);
    });
});

describe("process stats", () => {
    it("reads cputime from ps", () => {
        expect(clock("00:00:05")).toBe(5);
        expect(clock("01:02:03")).toBe(3723);
        expect(clock("2-00:00:01")).toBe(172801);
        expect(clock("12:30")).toBe(750);
    });

    it("turns two readings into percent of a core", () => {
        const a = { pid: 1, cpuSeconds: 10, memoryBytes: 0 };
        expect(cpuPercent(a, { ...a, cpuSeconds: 13 }, 3)).toBe(100);
        expect(cpuPercent(a, { ...a, cpuSeconds: 16 }, 3)).toBe(200);
        expect(cpuPercent(a, { ...a, cpuSeconds: 9 }, 3)).toBe(0);
        expect(cpuPercent(a, a, 0)).toBe(0);
    });
});
