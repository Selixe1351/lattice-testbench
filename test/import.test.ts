import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeployRequest } from "@shared/types";
import { writeZip } from "../src/main/export";
import { MANIFEST, readServerZip } from "../src/main/import";
import { Snapshots } from "../src/main/snapshots";

describe("server import", () => {
    let root: string;
    let out: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "testbench-import-"));
        out = await mkdtemp(join(tmpdir(), "testbench-import-out-"));
        const put = async (path: string, text = "") => {
            await mkdir(join(root, path, ".."), { recursive: true });
            await writeFile(join(root, path), text);
        };
        await put("versions/1.21.8/paper-1.21.8.jar");
        await put("server.properties", "online-mode=false\nlevel-type=minecraft\\:flat\n");
        await put("plugins/ViaVersion-5.4.jar");
        await put("plugins/MyPlugin.jar", "mine");
        await put("plugins/MyPlugin/config.yml", "kept: true\n");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
    });

    it("works out the request of a zip with no manifest from its files", async () => {
        const zip = join(out, "old-export.zip");
        await writeZip(root, zip);
        const server = await readServerZip(zip);
        expect(server.name).toBe("old-export");
        expect(server.plugins).toEqual(["plugins/MyPlugin.jar"]);
        expect(server.request).toEqual({ software: "paper", version: "1.21.8", onlineMode: false, world: "flat" });
    });

    it("takes the manifest's request and adopts the zip as a snapshot", async () => {
        const request: DeployRequest = { software: "purpur", version: "1.21.5", onlineMode: true, plugins: ["C:\\elsewhere\\MyPlugin.jar"] };
        const zip = join(out, "server.zip");
        await writeZip(root, zip, undefined, [{ path: MANIFEST, bytes: Buffer.from(JSON.stringify({ name: "Purpur test", request })) }]);
        const server = await readServerZip(zip);
        expect(server.request).toEqual(request);

        const snapshots = new Snapshots(join(out, "snapshots"));
        const info = await snapshots.adopt(zip, server);
        expect(info.name).toBe("Purpur test");
        expect(info.request.plugins).toHaveLength(1);
        expect(await readFile(info.request.plugins![0], "utf8")).toBe("mine");

        const target = join(out, "deployed");
        await snapshots.restoreInto(info.id, target);
        // Plugin jars come from the request, and the manifest stays out of the server folder.
        await expect(readFile(join(target, "plugins", "MyPlugin.jar"))).rejects.toThrow();
        await expect(readFile(join(target, MANIFEST))).rejects.toThrow();
        expect(await readFile(join(target, "plugins", "MyPlugin", "config.yml"), "utf8")).toBe("kept: true\n");
    });
});
