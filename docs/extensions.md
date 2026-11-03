# Writing an extension

An extension adds one capability to Lattice Testbench without making everyone carry it. The app itself deploys
throwaway servers and gives you a console, files, stats and players. Everything else is an extension: publishing,
AI agents, bots and Lattice ship with the app and start switched off, and yours work the same way.

## Turn on a built-in extension

Open **Extensions** in the sidebar, press **Set up** on a card, follow the numbered steps, fill in the settings,
press **Turn on**. Steps with a tick finish themselves when their settings are filled in.

| Extension | What it does | Needs |
|---|---|---|
| Publishing | Gives a server a public name through your own VPS and Cloudflare domain | A VPS, a domain on Cloudflare, `vps/setup.sh` |
| AI agents (MCP) | Lets Claude Code or any MCP client deploy servers, read consoles, run commands | Nothing. It makes a token for you |
| Bots | Fake players you drive from a tab | A server in offline mode |
| Lattice | Runs the Lattice platform and your module jars on a server, with a status and data tab | A Lattice jar |

## Your first extension in ten lines

An extension is a folder with two files. Put it in the extensions folder (**Extensions > Open extensions
folder**) and restart the app. [`examples/hello-extension`](../examples/hello-extension) is a complete one.

`extension.json` says what it is and what screens it needs. The app draws them for you:

```json
{
  "id": "hello", "name": "Hello", "description": "Says hello.", "version": "1.0.0", "api": 1,
  "main": "index.js",
  "actions": [{ "id": "say", "label": "Say hello", "when": ["running"] }]
}
```

`index.js` is the code:

```js
exports.activate = (ctx) => {
    ctx.action("say", (serverId) => {
        for (const p of ctx.servers.processes(serverId)) ctx.servers.command(serverId, p.name, "say hello");
    });
};
```

Turn it on under Extensions. A **Say hello** button now shows in the menu of every running server.

## What the manifest can declare

| Field | Becomes |
|---|---|
| `settings` | A form on the Extensions page. Types: `text`, `secret`, `number`, `boolean`, `select`, `path`, `files`. A `secret` is sealed with the OS store and never sent to the window |
| `deploy` | Extra options in the Deploy dialog while the extension is on, same field types. Your code reads them as `options` |
| `actions` | Buttons in a server's menu. `when` can hold `running`, `public`, `not-public` |
| `setup` | The numbered steps on the card. `needs: ["key"]` ticks a step when those settings are filled in. `copy` adds a Copy button |
| `permissions` | Plain words shown before someone enables it |
| `api` | Must be `1`. The app refuses an extension written for an api it does not know |

## What `ctx` gives your code

Everything you register through `ctx` is released when the extension is turned off. If `activate` throws, whatever
it registered before is released too and the extension stays off with the error on its card: an extension is
fully on or not running.

| Call | Use |
|---|---|
| `ctx.hook("deploy", fn)` | Once per deploy, before anything downloads. Throw to refuse the deploy with a message |
| `ctx.hook("prepare", fn)` | Per process, after the app wrote its files and before it starts. `fn({ proc, procs, options, request, log, cacheDir })`. `proc` has `name`, `dir`, `port`, `role` (`game` or `proxy`), `software`, `version` |
| `ctx.hook("env", fn)` | Extra environment variables for a process |
| `ctx.hook("destroy", fn)` | Before a server is stopped and deleted |
| `ctx.hook("appStart" / "appQuit", fn)` | App lifecycle |
| `ctx.action(id, fn)` | What a manifest `actions` button does. `fn(serverId)` |
| `ctx.servers` | `list`, `get`, `processes`, `command`, `query`, `update`, `deploy`, `start`, `stop`, `restart`, `destroy`, `history`, `waitFor`, `on("console" \| "player" \| "servers" \| "expiring", fn)` |
| `ctx.settings` | `get(key)`, `all()`, `set(key, value)`, `onChange(fn)` |
| `ctx.tool({ name, description, input, run })` | A tool for AI agents. Served by the AI agents extension when it is on |
| `ctx.handle(channel, fn)` | A call the window can make with `window.testbench.extension(id, channel, ...args)` |
| `ctx.status(text)` | One line under the card, e.g. an address |
| `ctx.dispose(fn)` | Cleanup for things `ctx` cannot own, such as a server you started |

`ctx.servers.query(id, process, commands, pattern)` sends console commands without echoing them and returns the
reply lines that match `pattern`. Use it instead of waiting a fixed time for an answer.

## Trust

An extension is JavaScript running with the app's own rights, like an editor extension. The `permissions` line is
a promise shown to the person, not a sandbox. Only turn on extensions you trust, and read one before you share it.

## Ideas

A world-reset button; a `deploy` hook that refuses a plugin jar built for the wrong Minecraft version; a
`prepare` hook that drops a ready-made config into every server; a Discord log forwarder using `servers.on("console")`;
a tool for agents that runs your plugin's own test command.
