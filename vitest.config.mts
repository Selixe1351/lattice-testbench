import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { alias: { "@shared": resolve(import.meta.dirname, "src/shared") } },
    test: {
        include: ["test/**/*.test.ts"],
        // The end-to-end run downloads Paper and starts a real server; it only runs when asked for.
        exclude: process.env.TESTBENCH_E2E ? [] : ["test/**/*.e2e.test.ts"],
    },
});
