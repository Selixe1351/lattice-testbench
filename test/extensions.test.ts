import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Settings } from "@shared/types";
import { ExtensionHost, type HostEnv } from "../src/main/extensions/host";
import { Hooks, Tools } from "../src/main/extensions/hooks";
import type { Extension, ServerApi } from "../src/main/extensions/types";
import { loadSettings, saveSettings } from "../src/main/settings";

const manifest = { version: "1.0.0", api: 1, description: "test" };

function setup(userDir = "") {
    const settings: Settings = { javaPath: "", memoryMb: 1024, basePort: 25600, operators: [], extensions: {} };
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const hooks = new Hooks();
    const env: HostEnv = {
        settings: () => settings,
        saveSettings: async () => {},
        servers: { on: () => {}, off: () => {} } as unknown as ServerApi,
        hooks,
        tools: new Tools(),
        userDir,
        dataDir: "",
        cacheDir: "",
        handle: (channel, fn) => void handlers.set(channel, fn),
        unhandle: (channel) => void handlers.delete(channel),
        send: () => {},
    };
    return { host: new ExtensionHost(env), settings, handlers, hooks };
}

describe("extension host", () => {
    const hello: Extension = {
        manifest: {
            ...manifest, id: "hello", name: "Hello", actions: [{ id: "wave", label: "Wave" }],
            settings: [{ key: "token", label: "Token", type: "secret" }, { key: "name", label: "Name", type: "text", default: "world" }],
        },
        activate(ctx) {
            ctx.handle("greet", () => `hello ${ctx.settings.get("name")}`);
            ctx.hook("destroy", () => {});
            ctx.action("wave", () => {});
        },
    };

    it("registers calls and hooks on enable and removes every one on disable", async () => {
        const { host, handlers, hooks } = setup();
        host.register(hello, true);
        await host.setEnabled("hello", true);
        expect(handlers.get("ext:hello:greet")?.()).toBe("hello world");
        expect(hooks.of("destroy")).toHaveLength(1);
        expect(host.list()[0].enabled).toBe(true);

        await host.setEnabled("hello", false);
        expect(handlers.size).toBe(0);
        expect(hooks.of("destroy")).toHaveLength(0);
        expect(host.list()[0].enabled).toBe(false);
    });

    it("leaves nothing behind when activate throws part way", async () => {
        const { host, handlers, hooks } = setup();
        host.register({
            manifest: { ...manifest, id: "broken", name: "Broken" },
            activate(ctx) {
                ctx.handle("one", () => 1);
                ctx.hook("destroy", () => {});
                throw new Error("no backend");
            },
        }, true);
        await expect(host.setEnabled("broken", true)).rejects.toThrow("no backend");
        expect(handlers.size).toBe(0);
        expect(hooks.of("destroy")).toHaveLength(0);
        const view = host.list()[0];
        expect(view.enabled).toBe(false);
        expect(view.error).toContain("no backend");
    });

    it("refuses an action the manifest does not declare, an api it does not know and a duplicate id", async () => {
        const { host } = setup();
        host.register({ manifest: { ...manifest, id: "sneaky", name: "Sneaky" }, activate: (ctx) => ctx.action("undeclared", () => {}) }, true);
        await expect(host.setEnabled("sneaky", true)).rejects.toThrow(/does not declare/);
        expect(() => host.register({ manifest: { ...manifest, id: "future", name: "F", api: 99 }, activate() {} }, true)).toThrow(/extension api 99/);
        expect(() => host.register({ manifest: { ...manifest, id: "sneaky", name: "S" }, activate() {} }, true)).toThrow(/Two extensions/);
    });

    it("never sends a secret to the window and keeps it when the window sends it back unchanged", async () => {
        const { host, settings } = setup();
        host.register(hello, true);
        await host.saveValues("hello", { token: "s3cret", name: "Ada" });
        expect(host.list()[0].values).toEqual({ token: true, name: "Ada" });
        await host.saveValues("hello", { token: true, name: "Grace" });
        expect(settings.extensions.hello.values).toEqual({ token: "s3cret", name: "Grace" });
    });

    it("loads a user extension from a folder, and only runs its code when enabled", async () => {
        const dir = await mkdtemp(join(tmpdir(), "testbench-ext-"));
        await mkdir(join(dir, "mine"));
        await writeFile(join(dir, "mine", "extension.json"), JSON.stringify({ ...manifest, id: "mine", name: "Mine", main: "index.js" }));
        await writeFile(join(dir, "mine", "index.js"), 'exports.activate = (ctx) => ctx.handle("ping", () => "pong");');
        await mkdir(join(dir, "bad"));
        await writeFile(join(dir, "bad", "extension.json"), JSON.stringify({ ...manifest, id: "bad", name: "Bad" }));

        const { host, handlers } = setup(dir);
        await host.discover();
        const views = host.list();
        expect(views.map((v) => v.manifest.id).sort()).toEqual(["broken-bad", "mine"]);
        expect(views.find((v) => v.manifest.id === "broken-bad")?.error).toContain("main");
        expect(handlers.size).toBe(0);
        await host.setEnabled("mine", true);
        expect(handlers.get("ext:mine:ping")?.()).toBe("pong");
    });

    it("answers a require of the typed API package without node_modules", async () => {
        const dir = await mkdtemp(join(tmpdir(), "testbench-ext-"));
        await mkdir(join(dir, "typed"));
        await writeFile(join(dir, "typed", "extension.json"), JSON.stringify({ ...manifest, id: "typed", name: "Typed", main: "index.js" }));
        await writeFile(join(dir, "typed", "index.js"), 'const { defineExtension } = require("@lattice-testbench/extension-api"); exports.activate = defineExtension({ manifest: {}, activate: (ctx) => ctx.handle("ok", () => 1) }).activate;');
        const { host, handlers } = setup(dir);
        await host.discover();
        await host.setEnabled("typed", true);
        expect(handlers.get("ext:typed:ok")?.()).toBe(1);
    });

    it("seals secret settings on disk and restores them on load", async () => {
        const dir = await mkdtemp(join(tmpdir(), "testbench-settings-"));
        const file = join(dir, "settings.json");
        const vault = { encrypt: (t: string) => Buffer.from(t).toString("base64"), decrypt: (s: string) => Buffer.from(s, "base64").toString() };
        const settings: Settings = { javaPath: "j", memoryMb: 1, basePort: 1, operators: [], extensions: { hello: { enabled: true, values: { token: "s3cret", name: "Ada" } } } };
        await saveSettings(file, settings, vault, () => ["token"]);
        expect(await readFile(file, "utf8")).not.toContain("s3cret");
        expect(await loadSettings(file, vault)).toMatchObject({ extensions: { hello: { enabled: true, values: { token: "s3cret", name: "Ada" } } } });
    });
});
