import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ConsoleLine, Settings } from "@shared/types";
import { Hooks } from "../src/main/extensions/hooks";
import { Instances } from "../src/main/instances";
import { Snapshots } from "../src/main/snapshots";

/**
 * A real deploy: downloads Paper and the standard plugins, starts the server, runs a command, lets an extension
 * hook see the process, and deletes it all again. Run with TESTBENCH_E2E=1 and TESTBENCH_JAVA pointing at java.exe.
 */
it("deploys a Paper server, runs a command, calls the extension hooks and cleans up", async () => {
    const settings: Settings = {
        javaPath: process.env.TESTBENCH_JAVA ?? "C:/Program Files/Java/jdk-25.0.1/bin/java.exe",
        memoryMb: 1536,
        basePort: 25700,
        operators: [],
        extensions: {},
    };
    const root = await mkdtemp(join(tmpdir(), "testbench-e2e-"));
    const hooks = new Hooks();
    const prepared: string[] = [];
    hooks.add("prepare", "test", (context) => void prepared.push(`${context.proc.role}:${context.proc.name}`));
    const instances = new Instances(join(root, "servers"), join(root, "cache"), () => settings, new Snapshots(join(root, "snapshots")), hooks);
    const lines: ConsoleLine[] = [];
    instances.on("console", (l: ConsoleLine) => lines.push(l));

    const waitFor = async (what: string, test: () => boolean, ms: number) => {
        const end = Date.now() + ms;
        while (!test()) {
            if (Date.now() > end) throw new Error(`Timed out waiting for ${what}\n${lines.slice(-40).map((l) => l.text).join("\n")}`);
            await new Promise((r) => setTimeout(r, 500));
        }
    };

    await instances.purgeOrphans();
    const id = instances.deploy({ software: "paper", version: "1.21.4", onlineMode: false, world: "void" });
    await waitFor("the server to run", () => instances.list()[0]?.state === "running", 240_000);
    expect(prepared).toEqual(["game:server"]);

    instances.command(id, "server", "list");
    await waitFor("the answer to list", () => lines.some((l) => /There are 0 of a max/.test(l.text)), 30_000);

    await instances.destroyAll();
    expect(instances.list()).toEqual([]);
}, 600_000);
