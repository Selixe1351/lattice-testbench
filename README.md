# Lattice Testbench

Throwaway Minecraft test servers in one click. Pick Paper, Folia, Purpur or a Velocity network, drop in your
plugin jars, and get a console, a file editor with diff and search, stats, player tools and snapshots. A server
deletes itself after 30 minutes (extend it, or keep it), and quitting the app deletes them all.

Everything beyond that is an **extension** that you turn on only if you want it: publishing a server on the
internet, driving servers from an AI agent, bots, Lattice integration, or one you write yourself.

> Status: early. Windows only for now (Java, frp and the installer are Windows builds). PRs that make it
> cross-platform are welcome, see [Contributing](CONTRIBUTING.md).

## Install

Download the installer from the [latest release](../../releases/latest) and run it. You need Java 25 for
Minecraft 26; the Settings page has a **Download Java 25** button if you have none.

## Use it

1. Open the app. Settings opens first if Java is not set.
2. **Deploy test server**, pick the software and version, add plugin jars, **Deploy**.
3. Use the tabs: Console, Files, Split view, Stats, and more as extensions add them.

The app downloads server software, ViaVersion, ViaBackwards, PlaceholderAPI and FastAsyncWorldEdit from their
authors on first use and caches them. Nothing is bundled.

## Extensions

Open **Extensions** in the sidebar. Each card has numbered setup steps and a settings form.

| Built in | What it does |
|---|---|
| Publishing | A public name for a server through your own tunnel server (frp) and Cloudflare domain, with Discord posts |
| AI agents (MCP) | Claude Code or any MCP client deploys servers, reads consoles, runs commands, edits files |
| Bots | Fake players you drive from a tab |
| Lattice | The Lattice platform and your module jars, with status and data tabs |

Writing your own takes a folder with `extension.json` and `index.js`, or TypeScript with full types from your manifest.
See [docs/extensions.md](docs/extensions.md), [examples/hello-extension](examples/hello-extension) and
[examples/typed-extension](examples/typed-extension).

## Build from source

Needs Node 20 or newer.

```
npm install
npm run dev        # run from source
npm run lint       # type-check
npm test           # unit tests
npm run dist       # build the Windows installer into dist/
```

`TESTBENCH_E2E=1 TESTBENCH_JAVA=<path to java.exe> npm test` also runs the end-to-end test, which downloads
Paper and starts a real server. `TESTBENCH_DATA=<folder>` runs a development copy beside an installed one.

### Layout

```
src/main/             Electron main process: servers, files, settings
src/main/extensions/  Extension host, hooks, and the built-in extensions
src/renderer/         The window (React)
src/shared/           Types shared by both, including the extension manifest
docs/, examples/      How to write an extension
relay/                Setup for the tunnel server the Publishing extension uses (any host, or Docker)
```

## Privacy

Settings, tokens and keys stay on your PC, sealed with Windows' own encryption. The app contacts the software
authors' download hosts and, when installed, GitHub Releases to check for updates. It sends no usage data.

## Licence

[MIT](LICENSE). Downloaded software keeps its own licence; see Settings > About.
