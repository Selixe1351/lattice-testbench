import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
    },
    renderer: {
        resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
        plugins: [react()],
    },
});
