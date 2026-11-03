# Lattice Testbench

Throwaway Minecraft test servers in one click. Pick Paper, Folia, Purpur or a Velocity network, add your plugin
jars, and get a console, file editor, stats, player tools and snapshots. Servers delete themselves after 30
minutes, and closing the app deletes them all.

Extras are extensions you turn on only if you want them: publishing a server on the internet, AI agents, bots and
Lattice. You can write your own.

## Download

**[Download for Windows](https://github.com/Selixe1351/lattice-testbench/releases/latest/download/Lattice-Testbench-Setup.exe)**
(or see all [releases](https://github.com/Selixe1351/lattice-testbench/releases)).

Needs Java 25 for Minecraft 26. Settings has a **Download Java 25** button if you have none.

## Use it

1. Open the app. Settings opens first if Java is not set.
2. **Deploy test server**, pick the software and version, add plugin jars, **Deploy**.
3. Use the tabs: Console, Files, Split, Stats.

Server software and the standard plugins are downloaded from their authors the first time and cached.

## Extensions

Open **Extensions** in the sidebar. Each card has setup steps and settings.

| Extension | What it does |
|---|---|
| Publishing | A public name for a server, through your own tunnel server and Cloudflare domain |
| AI agents (MCP) | Lets Claude Code or any MCP client deploy servers, read consoles and run commands |
| Bots | Fake players you control from a tab |
| Lattice | Runs the Lattice platform and your module jars |

Write your own in TypeScript or JavaScript: [docs/extensions.md](docs/extensions.md),
[example](examples/typed-extension).

## Build

Needs Node 20 or newer.

```
npm install
npm run dev        # run from source
npm test
npm run dist       # Windows installer into dist/
```

## Licence

[MIT](LICENSE)
