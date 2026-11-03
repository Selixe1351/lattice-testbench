# Writing an extension

An extension is a folder with an `extension.json` and a JavaScript file. Put the folder in the extensions folder
(**Extensions > Open extensions folder**), restart the app, and turn it on under **Extensions**.

## Quick start (TypeScript)

```
npm install @lattice-testbench/extension-api typescript
```

`src/index.ts`:

```ts
import { defineExtension } from "@lattice-testbench/extension-api";

export const { activate } = defineExtension({
    manifest: {
        id: "hello",
        name: "Hello",
        description: "Says hello.",
        version: "1.0.0",
        api: 1,
        main: "dist/index.js",
        settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hello" }],
        actions: [{ id: "say", label: "Say hello", when: ["running"] }],
    },
    activate(ctx) {
        ctx.action("say", (serverId) => {
            for (const p of ctx.servers.processes(serverId)) {
                ctx.servers.command(serverId, p.name, `say ${ctx.settings.get("greeting")}`);
            }
        });
    },
});
```

`extension.json` holds the same manifest. Compile with `tsc` to CommonJS, and the folder is ready. A full project is
in [examples/typed-extension](../examples/typed-extension).

The manifest types the rest: `ctx.settings.get("greeting")` is a `string`, and `ctx.action("sya", ...)` does not
compile because the manifest has no action called `sya`. You can also write plain JavaScript with
`exports.activate = (ctx) => { ... }`.

## Manifest

| Field | What it does |
|---|---|
| `settings` | A form on the Extensions page. Types: `text`, `secret`, `number`, `boolean`, `select`, `path`, `files` |
| `deploy` | Extra options in the Deploy dialog, same types. Your code gets them as `options` |
| `actions` | Buttons in a server's menu. `when` can be `running`, `public`, `not-public` |
| `setup` | Numbered steps on the extension's card. `needs: ["key"]` ticks a step once that setting is filled in. `copy` adds a copy button |

## What you can do in `activate(ctx)`

| Call | Use |
|---|---|
| `ctx.hook("deploy", fn)` | Before a deploy starts. Throw to refuse it |
| `ctx.hook("prepare", fn)` | For each server process, after its files are written and before it starts. `fn({ proc, options, log })` |
| `ctx.hook("env", fn)` | Extra environment variables for a process |
| `ctx.hook("destroy", fn)` | Before a server is deleted |
| `ctx.hook("appStart" / "appQuit", fn)` | When the app starts and quits |
| `ctx.action(id, fn)` | What an `actions` button does. `fn(serverId)` |
| `ctx.servers` | `list`, `get`, `processes`, `command`, `query`, `deploy`, `start`, `stop`, `restart`, `destroy`, `history`, `waitFor`, `on("console" \| "player" \| "servers" \| "expiring", fn)` |
| `ctx.settings` | `get(key)`, `set(key, value)`, `onChange(fn)` |
| `ctx.tool({ name, description, input, run })` | A tool for AI agents (needs the AI agents extension on) |
| `ctx.status(text)` | One line shown on the extension's card |
| `ctx.dispose(fn)` | Cleanup when the extension is turned off |

Everything you register through `ctx` is removed when the extension is turned off. If `activate` throws, the
extension stays off and the error shows on its card.

`ctx.servers.query(id, process, commands, pattern)` sends console commands and returns the reply lines that match
`pattern`. `ctx.servers.waitFor(id, match, ms)` waits for a console line.

Extensions run with the same access as the app, so only turn on ones you trust.
