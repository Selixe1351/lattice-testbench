import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeZip } from "../src/main/export";
import { listJar, openEntry } from "../src/main/jar";

describe("server export", () => {
    let root: string;
    let out: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "testbench-export-"));
        out = await mkdtemp(join(tmpdir(), "testbench-export-out-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
    });

    it("writes a zip the jar reader can read back", async () => {
        await mkdir(join(root, "plugins", "Lattice"), { recursive: true });
        await writeFile(join(root, "server.properties"), "motd=Hello é\n".repeat(50));
        await writeFile(join(root, "plugins", "Lattice", "lattice.yml"), "license:\n  key: abc\n");
        // Random bytes do not compress, which takes the stored (no compression) path.
        await writeFile(join(root, "random.bin"), randomBytes(2048));

        const target = join(out, "server.zip");
        const result = await writeZip(root, target);
        expect(result).toEqual({ files: 3, skipped: 0 });

        expect((await listJar(target, "")).map((e) => e.name)).toEqual(["plugins", "random.bin", "server.properties"]);
        expect((await listJar(target, "plugins/Lattice")).map((e) => e.name)).toEqual(["lattice.yml"]);
        expect(await openEntry("", out, target, "plugins/Lattice/lattice.yml", "e1")).toBe("license:\n  key: abc\n");
        expect(await openEntry("", out, target, "server.properties", "e2")).toContain("Hello é");
    });

    it("writes an empty zip for an empty folder", async () => {
        const target = join(out, "empty.zip");
        expect(await writeZip(root, target)).toEqual({ files: 0, skipped: 0 });
        expect(await listJar(target, "")).toEqual([]);
    });
});
