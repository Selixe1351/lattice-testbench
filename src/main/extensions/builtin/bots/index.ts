import type { BotAction } from "@shared/bots";
import type { Extension, ExtensionContext } from "../../types";
import { Bots } from "./bots";

/** Bots: test players (mineflayer) you can drive from the Bots tab or from an AI agent. They join offline-mode servers. */

export const bots: Extension = {
    manifest: {
        id: "bots",
        name: "Bots",
        description: "Summon test players that walk, chat, fish and use items, to try a plugin without a second Minecraft account.",
        version: "1.0.0",
        api: 1,
        permissions: ["Connects to your local test servers as fake players"],
        settings: [
            { key: "version", label: "Minecraft version bots speak", type: "text", default: "1.21.4", hint: "ViaBackwards on the server lets bots on an older version join a newer server." },
        ],
        setup: [
            { text: "Enable this extension. A Bots tab appears on every server page." },
            { text: "Deploy a server with online mode off. Bots cannot log in to Mojang, so they only join offline servers." },
            { text: "Open the server, pick the Bots tab and press Summon." },
        ],
    },

    activate(ctx: ExtensionContext) {
        const bots = new Bots();
        bots.on("bots", (list) => ctx.send("bots", list));
        bots.on("event", (event) => ctx.send("event", event));
        ctx.dispose(() => {
            for (const view of ctx.servers.list()) bots.removeAll(view.id);
        });
        // A deleted server takes its bots with it.
        ctx.hook("destroy", (id) => bots.removeAll(id));

        const summon = async (id: string, count: number, prefix: string): Promise<void> => {
            const view = ctx.servers.get(id);
            if (!view) throw new Error("No such server");
            if (view.state !== "running") throw new Error("Wait until the server is running.");
            if (view.onlineMode) throw new Error("Bots cannot log in to an online-mode server. Deploy it with online mode off.");
            const port = Number(view.address.split(":")[1]);
            await bots.summon(id, "127.0.0.1", port, String(ctx.settings.get("version") ?? "1.21.4"), count, prefix);
        };

        ctx.handle("list", (id: string) => bots.list(id));
        ctx.handle("summon", summon);
        ctx.handle("act", (id: string, names: string[], action: BotAction) => bots.act(id, names, action));

        ctx.tool({
            name: "summon_bots",
            description: "Join bots (fake players) to a running offline-mode server. Their state is in list_bots.",
            input: {
                id: { type: "string", description: "Server id" },
                count: { type: "number", description: "How many, 1 to 20" },
                prefix: { type: "string", description: "Name prefix, e.g. Bot", optional: true },
            },
            run: async ({ id, count, prefix }) => {
                await summon(id, Math.min(20, Math.max(1, Number(count))), String(prefix ?? "Bot"));
                return `Summoning ${count}.`;
            },
        });
        ctx.tool({
            name: "list_bots",
            description: "The server's bots: state, position, health, activity.",
            input: { id: { type: "string", description: "Server id" } },
            run: ({ id }) => bots.list(id),
        });
        ctx.tool({
            name: "bot_action",
            description: 'Make bots act. action is JSON: {"kind":"chat","text":"hi"}, {"kind":"goto","x":0,"y":64,"z":0}, {"kind":"follow","player":"Alex"}, {"kind":"wander"}, {"kind":"stop"}, {"kind":"jump"}, {"kind":"attack"}, {"kind":"use"}, {"kind":"fish"}, {"kind":"disconnect"}.',
            input: {
                id: { type: "string", description: "Server id" },
                names: { type: "string[]", description: "Bot names, from list_bots" },
                action: { type: "string", description: "The action as a JSON string" },
            },
            run: ({ id, names, action }) => {
                bots.act(id, names, JSON.parse(action) as BotAction);
                return "Done.";
            },
        });
    },
};
