import { rm } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension } from "@lattice-testbench/extension-api";

// The manifest is written here, in the call, so the compiler can read it: the action id below is checked against
// it. extension.json holds the same manifest for the app, which reads it before any code runs.
export const { activate } = defineExtension({
    manifest: {
        id: "reset-world",
        name: "Reset world",
        description: "Deletes a server's world folders and starts it again.",
        version: "1.0.0",
        api: 1,
        main: "index.js",
        actions: [{ id: "reset", label: "Reset world", when: ["running"] }],
    },
    activate(ctx) {
        ctx.action("reset", async (serverId) => {
            await ctx.servers.stop(serverId);
            for (const proc of ctx.servers.processes(serverId).filter((p) => p.role === "game")) {
                for (const world of ["world", "world_nether", "world_the_end"]) await rm(join(proc.dir, world), { recursive: true, force: true });
            }
            ctx.servers.log(serverId, "app", "World deleted. Starting again.");
            ctx.servers.start(serverId);
        });
    },
});
