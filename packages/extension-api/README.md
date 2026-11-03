# @lattice-testbench/extension-api

Types for writing [Lattice Testbench](https://github.com/Selixe1351/lattice-testbench) extensions. The manifest you
pass to `defineExtension` types everything after it: settings, deploy options and action ids.

```ts
import { defineExtension } from "@lattice-testbench/extension-api";

export const { activate } = defineExtension({
    manifest: {
        id: "hello", name: "Hello", description: "Says hello.", version: "1.0.0", api: 1,
        settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hello" }],
        actions: [{ id: "say", label: "Say hello", when: ["running"] }],
    },
    activate(ctx) {
        // ctx.settings.get("greeting") is a string. ctx.action("sya", ...) is a compile error.
        ctx.action("say", (serverId) => {
            for (const p of ctx.servers.processes(serverId)) ctx.servers.command(serverId, p.name, `say ${ctx.settings.get("greeting")}`);
        });
    },
});
```

Compile to CommonJS, name the output file in `main` in `extension.json`, and put the folder in the app's extensions
folder. See the [extension guide](https://github.com/Selixe1351/lattice-testbench/blob/main/docs/extensions.md)
and the [TypeScript example](https://github.com/Selixe1351/lattice-testbench/tree/main/examples/typed-extension).

In `extension.json`, add `"$schema": "./node_modules/@lattice-testbench/extension-api/extension.schema.json"` for
editor completion on the manifest.
