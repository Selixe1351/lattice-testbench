# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

```
npm install
npm run lint
npm test
npm run dev
```

All three checks must pass. CI runs the same ones.

## Rules the code keeps

- **An extension is fully on or not running.** If `activate` throws, the host releases everything it registered.
  Do not add a state that means "on but broken".
- **Extensions register only through `ctx`.** Anything an extension creates that can be released must be recorded
  on its context, so turning it off removes it. A subsystem that hands out something releasable without the
  context owning it is wrong.
- **The core stays small.** If a feature is only wanted by some people, it is an extension. The core knows nothing
  about Lattice, publishing, bots or agents.
- **Secrets never reach the window.** Settings of type `secret` are sealed on disk and sent to the window as
  "set" only.
- **Never sleep to win a race.** Wait for the console line or reply you need (`servers.waitFor`, `servers.query`).
- **No empty `catch`.** Log with context or rethrow.
- **Downloads are checked.** A pinned download carries its SHA-256.
- Comments say why, not what.

## Adding a built-in extension

Create `src/main/extensions/builtin/<id>/index.ts` exporting an `Extension`, add it to
`src/main/extensions/builtin/index.ts`, and write setup steps in its manifest. Add a test to
`test/extensions.test.ts` if it touches the host. [docs/extensions.md](docs/extensions.md) lists the API.

## Making it cross-platform

Java, frp and the installer are Windows-only today (`src/main/java.ts`, the Publishing extension's
`tunnel.ts`, `electron-builder.yml`). Each is a self-contained change; open an issue first so we agree on the shape.
