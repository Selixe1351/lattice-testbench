import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cancel, listJar, openEntry } from "../src/main/jar";

const JAR = process.env.TESTBENCH_TEST_JAR;
const JAVA = process.env.TESTBENCH_TEST_JAVA ?? "";

// Needs a real jar and Java, and downloads the decompiler once, so it only runs when pointed at them.
describe.skipIf(!JAR || !JAVA)("jar browsing", () => {
    it("lists, reads and decompiles", async () => {
        const root = await listJar(JAR!, "");
        expect(root.length).toBeGreaterThan(0);
        const cache = await mkdtemp(join(tmpdir(), "tb-cache-"));
        const find = async (dir: string): Promise<string | null> => {
            for (const e of await listJar(JAR!, dir)) {
                if (!e.directory && e.name.endsWith(".class") && !e.name.includes("$")) return e.path;
            }
            for (const e of await listJar(JAR!, dir)) {
                if (e.directory) {
                    const hit = await find(e.path);
                    if (hit) return hit;
                }
            }
            return null;
        };
        const cls = (await find(""))!;
        const text = await openEntry(JAVA, cache, JAR!, cls, "t1");
        expect(text).toContain("class");
    }, 120_000);

    it("cancels", async () => {
        const cache = await mkdtemp(join(tmpdir(), "tb-cache-"));
        const p = openEntry(JAVA, cache, JAR!, "x.class", "t2");
        cancel("t2");
        await expect(p).rejects.toThrow();
    });
});
