import { defineExtension } from "../src/shared/extension-api";

// Compile-time checks only (npm run lint). Each @ts-expect-error line must stay an error, or typing has regressed.
defineExtension({
    manifest: {
        id: "typed", name: "Typed", description: "t", version: "1.0.0", api: 1,
        settings: [
            { key: "port", label: "Port", type: "number", default: 7000 },
            { key: "name", label: "Name", type: "text" },
            { key: "mode", label: "Mode", type: "select", default: "fast", options: [{ value: "fast", label: "Fast" }, { value: "slow", label: "Slow" }] },
        ],
        deploy: [{ key: "jars", label: "Jars", type: "files" }, { key: "on", label: "On", type: "boolean", default: false }],
        actions: [{ id: "go", label: "Go" }],
    },
    activate(ctx) {
        const port: number = ctx.settings.get("port");
        const name: string | undefined = ctx.settings.get("name");
        const mode: "fast" | "slow" = ctx.settings.get("mode");
        void [port, name, mode];
        // @ts-expect-error a number is not a string
        const wrong: string = ctx.settings.get("port");
        void wrong;
        // @ts-expect-error no such setting
        ctx.settings.get("nope");
        // @ts-expect-error no such action
        ctx.action("stop", () => {});
        ctx.action("go", () => {});
        ctx.hook("prepare", ({ options }) => {
            const jars: string[] | undefined = options.jars;
            const on: boolean = options.on;
            void [jars, on];
            // @ts-expect-error no such deploy option
            void options.missing;
        });
    },
});
