import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { list, read, readImage, write } from "../src/main/files";

describe("files", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "testbench-"));
        await mkdir(join(root, "plugins"));
        await writeFile(join(root, "server.properties"), "server-port=25565\n");
        await writeFile(join(root, "world.dat"), Buffer.from([1, 0, 2, 3]));
    });

    afterEach(() => rm(root, { recursive: true, force: true }));

    it("lists folders first, with forward-slash paths", async () => {
        const entries = await list(root, "");
        expect(entries.map((e) => e.name)).toEqual(["plugins", "server.properties", "world.dat"]);
        expect(entries[0].directory).toBe(true);
        await writeFile(join(root, "plugins", "a.yml"), "a: 1");
        expect((await list(root, "plugins"))[0].path).toBe("plugins/a.yml");
    });

    it("refuses paths that climb out of the server folder", async () => {
        await expect(read(root, "../outside.txt")).rejects.toThrow(/outside/);
        await expect(write(root, "plugins/../../evil.txt", "x")).rejects.toThrow(/outside/);
        await expect(list(root, "..")).rejects.toThrow(/outside/);
    });

    it("reads and writes text but not binary files", async () => {
        await write(root, "server.properties", "server-port=1\n");
        expect(await read(root, "server.properties")).toBe("server-port=1\n");
        await expect(read(root, "world.dat")).rejects.toThrow(/binary/);
    });

    it("hands images over as data URLs and refuses other binaries", async () => {
        await writeFile(join(root, "plugins", "art.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
        expect(await readImage(root, "plugins/art.png")).toBe("data:image/png;base64,iVBORwA=");
        await expect(readImage(root, "world.dat")).rejects.toThrow(/not an image/);
        await expect(readImage(root, "../x.png")).rejects.toThrow(/outside/);
    });
});
