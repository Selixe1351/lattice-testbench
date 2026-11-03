import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelSearch, create, duplicate, forget, importPaths, list, original, read, remove, rename, search, write } from "../src/main/files";

describe("file operations", () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "testbench-ops-"));
        outside = await mkdtemp(join(tmpdir(), "testbench-outside-"));
        await mkdir(join(root, "plugins"));
        await writeFile(join(root, "plugins", "a.yml"), "name: alpha\nvalue: 1\n");
        await writeFile(join(root, "server.properties"), "motd=Hello\n");
    });

    afterEach(async () => {
        forget(root);
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    it("creates files and folders and refuses to overwrite", async () => {
        await create(root, "plugins/new.yml", false);
        await create(root, "plugins/sub/deep", true);
        expect((await list(root, "plugins")).map((e) => e.name)).toEqual(["sub", "a.yml", "new.yml"]);
        await expect(create(root, "plugins/a.yml", false)).rejects.toThrow(/already exists/);
        await expect(create(root, "../evil", false)).rejects.toThrow(/outside/);
    });

    it("renames, duplicates and deletes, never touching the server folder itself", async () => {
        await rename(root, "plugins/a.yml", "plugins/b.yml");
        expect(await read(root, "plugins/b.yml")).toContain("alpha");
        await expect(rename(root, "plugins/b.yml", "server.properties")).rejects.toThrow(/already exists/);

        expect(await duplicate(root, "plugins/b.yml")).toBe("plugins/b copy.yml");
        expect(await duplicate(root, "plugins/b.yml")).toBe("plugins/b copy 2.yml");

        await remove(root, "plugins");
        await expect(stat(join(root, "plugins"))).rejects.toThrow();
        await expect(remove(root, "")).rejects.toThrow(/server folder itself/);
        await expect(remove(root, "..")).rejects.toThrow(/outside/);
    });

    it("imports files from outside without overwriting", async () => {
        await writeFile(join(outside, "extra.txt"), "x");
        await importPaths(root, "plugins", [join(outside, "extra.txt")]);
        expect(await readFile(join(root, "plugins", "extra.txt"), "utf8")).toBe("x");
        await expect(importPaths(root, "plugins", [join(outside, "extra.txt")])).rejects.toThrow(/already in that folder/);
    });

    it("remembers what a file held when it was first opened or saved", async () => {
        expect(original(root, "plugins/a.yml")).toBeNull();
        await read(root, "plugins/a.yml");
        await write(root, "plugins/a.yml", "name: beta\n");
        await write(root, "plugins/a.yml", "name: gamma\n");
        expect(original(root, "plugins/a.yml")).toBe("name: alpha\nvalue: 1\n");

        // Saved without ever being opened: the first save records the file as it was.
        await write(root, "server.properties", "motd=Changed\n");
        expect(original(root, "server.properties")).toBe("motd=Hello\n");

        await rename(root, "plugins/a.yml", "plugins/c.yml");
        expect(original(root, "plugins/c.yml")).toBe("name: alpha\nvalue: 1\n");
        forget(root);
        expect(original(root, "plugins/c.yml")).toBeNull();
    });

    it("searches text files, skipping binaries and game data", async () => {
        await writeFile(join(root, "plugins", "bin.dat"), Buffer.from([0, 1, 2]));
        await mkdir(join(root, "world"));
        await writeFile(join(root, "world", "level.txt"), "alpha in the world\n");

        const found = await search(root, { query: "ALPHA", regex: false, caseSensitive: false }, "t1");
        expect(found.hits).toEqual([{ path: "plugins/a.yml", line: 1, text: "name: alpha" }]);
        expect(found.truncated).toBe(false);

        const exact = await search(root, { query: "ALPHA", regex: false, caseSensitive: true }, "t2");
        expect(exact.hits).toEqual([]);

        const pattern = await search(root, { query: "^value: \\d$", regex: true, caseSensitive: false }, "t3");
        expect(pattern.hits.map((h) => h.line)).toEqual([2]);

        await expect(search(root, { query: "(", regex: true, caseSensitive: false }, "t4")).rejects.toThrow();
    });

    it("stops a search that was cancelled", async () => {
        for (let i = 0; i < 20; i++) await writeFile(join(root, `f${i}.txt`), "needle\n");
        const running = search(root, { query: "needle", regex: false, caseSensitive: false }, "cancel-me");
        cancelSearch("cancel-me");
        await expect(running).rejects.toThrow(/Cancelled/);
    });
});
