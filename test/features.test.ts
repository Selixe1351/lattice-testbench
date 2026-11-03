import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isErrorLine, SPARK_LINK, stackFrame } from "@shared/console";
import { moduleEvent } from "@shared/lattice";
import type { DeployRequest, ServerView } from "@shared/types";
import { invite } from "../src/main/extensions/builtin/publishing/discord";
import { generated, kept, Snapshots } from "../src/main/snapshots";

describe("reading console output", () => {
    it("counts error lines but not the stack frames under them", () => {
        expect(isErrorLine("[12:00:01 ERROR]: Could not pass event", "out")).toBe(true);
        expect(isErrorLine("\tat net.example.Foo.run(Foo.kt:42)", "out")).toBe(false);
        expect(isErrorLine("anything", "err")).toBe(true);
        expect(isErrorLine("ERROR from the app itself", "app")).toBe(false);
    });

    it("reads the kernel's module messages", () => {
        expect(moduleEvent("[12:00:01 INFO]: [Lattice] Enabled economy v1.2.0")).toEqual({ id: "economy", ok: true });
        expect(moduleEvent("[Lattice] economy failed to enable and was rolled back: no database")).toEqual({ id: "economy", ok: false });
        expect(moduleEvent("[Lattice] Will not load shops: needs economy")).toEqual({ id: "shops", ok: false });
        expect(moduleEvent("[Lattice] Could not construct kits: boom")).toEqual({ id: "kits", ok: false });
        expect(moduleEvent("Done (3.2s)! For help, type \"help\"")).toBeNull();
    });

    it("finds the clickable part of a stack frame, module prefix and nested class included", () => {
        const text = "\tat app//net.lattice.economy.EconomyImpl$Cache.load(EconomyImpl.kt:88) ~[economy.jar:?]";
        const frame = stackFrame(text)!;
        expect(frame).toMatchObject({ className: "net.lattice.economy.EconomyImpl$Cache", file: "EconomyImpl.kt", line: 88 });
        expect(text.slice(frame.start, frame.end)).toBe("app//net.lattice.economy.EconomyImpl$Cache.load(EconomyImpl.kt:88)");
        expect(stackFrame("\tat java.base/java.lang.Thread.run(Native Method)")).toBeNull();
    });

    it("spots spark's viewer link", () => {
        expect(SPARK_LINK.exec("[spark] https://spark.lucko.me/AbC123 ")?.[0]).toBe("https://spark.lucko.me/AbC123");
    });
});

describe("snapshots", () => {
    it("leaves out what a deploy writes and what the server downloads", () => {
        for (const path of ["server.jar", "server.properties", "plugins/ViaVersion-5.0.jar", "plugins/Lattice/lattice.yml",
            "backend-1/plugins/Lattice/modules/economy-1.0.jar", "proxy/velocity.toml", "bots/forwarding.secret", "backend-2/config/paper-global.yml"]) {
            expect(generated(path), path).toBe(true);
        }
        for (const path of ["libraries/x.jar", "backend-1/logs/latest.log", "world/session.lock"]) expect(kept(path), path).toBe(false);
        for (const path of ["world/level.dat", "plugins/Lattice/config/economy.yml", "backend-1/world/region/r.0.0.mca", "bukkit.yml", "ops.json"]) {
            expect(kept(path), path).toBe(true);
        }
    });

    it("saves a server and lays it over a fresh deploy without touching generated files", async () => {
        const root = await mkdtemp(join(tmpdir(), "testbench-snap-"));
        const server = join(root, "server");
        await mkdir(join(server, "world"), { recursive: true });
        await mkdir(join(server, "plugins", "Lattice", "config"), { recursive: true });
        await writeFile(join(server, "world", "level.dat"), "old world");
        await writeFile(join(server, "plugins", "Lattice", "config", "economy.yml"), "start: 100");
        await writeFile(join(server, "server.properties"), "server-port=1");

        const store = new Snapshots(join(root, "snapshots"));
        const request: DeployRequest = { software: "paper", version: "1.21.4", onlineMode: true };
        const info = await store.save(server, "Before shops", request);
        expect(info).toMatchObject({ name: "Before shops", files: 2, request: { software: "paper" } });
        expect((await store.list()).map((s) => s.id)).toEqual([info.id]);

        const fresh = join(root, "fresh");
        await mkdir(fresh, { recursive: true });
        await writeFile(join(fresh, "server.properties"), "server-port=2");
        expect(await store.restoreInto(info.id, fresh)).toBe(2);
        expect(readFileSync(join(fresh, "world", "level.dat"), "utf8")).toBe("old world");
        expect(readFileSync(join(fresh, "plugins", "Lattice", "config", "economy.yml"), "utf8")).toBe("start: 100");
        expect(readFileSync(join(fresh, "server.properties"), "utf8")).toBe("server-port=2");

        await store.remove(info.id);
        expect(existsSync(join(root, "snapshots", info.id))).toBe(false);
    });
});

describe("invites", () => {
    const view: ServerView = {
        id: "paper-x", label: "Paper 1.21.4", software: "paper", version: "1.21.4", modules: [], uses: [], onlineMode: true,
        address: "localhost:25600", state: "running", processes: [], createdAt: 0, expiresAt: 20 * 60_000, errors: 0, moduleStatus: {}, kept: false,
        world: "normal", plugins: ["MyPlugin.jar"], players: [],
        publicAddress: "testbench-x.example.net",
    };

    it("leads with the address and says how long it stays up", () => {
        expect(invite(view, 0)).toBe("Join testbench-x.example.net\nTest server (Paper 1.21.4). Plugins: MyPlugin.jar.\nUp for about 20 more minutes.");
        expect(invite({ ...view, kept: true }, 0)).toContain("Up until it is stopped.");
    });

    it("refuses a server that is not published", () => {
        expect(() => invite({ ...view, publicAddress: undefined })).toThrow(/Publish/);
    });
});
