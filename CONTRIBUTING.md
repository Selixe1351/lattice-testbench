# Contributing

```
npm install
npm run dev
npm run lint
npm test
```

Make sure lint and tests pass, then open a pull request. Small ones are easiest to review.

A feature that only some people want should be an extension, not part of the app. To add a built-in one, copy a folder
in `src/main/extensions/builtin/` and add it to `index.ts`.

Java, frp and the installer are Windows-only right now. Making them work on Mac and Linux is welcome.
