import type { Extension, ExtensionContext } from "../../types";
import * as dns from "./cloudflare";
import * as discord from "./discord";
import { publishSettings } from "./settings";
import * as tunnels from "./tunnel";

/**
 * Publishing: gives a test server a public name. A Cloudflare DNS record and an SRV record name it, an outbound
 * frp tunnel to your VPS carries the traffic, so this PC's address is in no record and no port is forwarded.
 * Optionally tells a Discord channel when a server goes up and when the first tester joins.
 */

interface Published {
    tunnel?: tunnels.Tunnel;
    /** Cloudflare record ids made by publish, removed again by unpublish and destroy. */
    records: string[];
    /** When it was last published, so the first player after that is announced. */
    at: number;
}

export const publishing: Extension = {
    manifest: {
        id: "publishing",
        name: "Publishing",
        description: "Give a test server a public name so testers can join it from anywhere, through your own VPS and domain.",
        version: "1.0.0",
        api: 1,
        permissions: ["Opens outbound network connections", "Edits DNS records in your Cloudflare zone", "Runs frpc"],
        settings: [
            { key: "publicDomain", label: "Domain", type: "text", placeholder: "example.net", hint: "A domain in your Cloudflare account. Servers get names like testbench-ab12.example.net." },
            { key: "cloudflareToken", label: "Cloudflare token", type: "secret", hint: "An API token with Zone > DNS > Edit on that domain only." },
            { key: "tunnelHost", label: "VPS address", type: "text", placeholder: "203.0.113.7", hint: "The VPS that runs frps, as this PC dials it. A Tailscale address works." },
            { key: "tunnelPublicHost", label: "VPS public address", type: "text", hint: "Where players reach the VPS, if that differs. Empty means the same." },
            { key: "tunnelPort", label: "frps control port", type: "number", default: 7000 },
            { key: "tunnelToken", label: "Tunnel token", type: "secret", hint: "auth.token from /etc/frp/frps.toml on the VPS." },
            { key: "tunnelFirstPort", label: "First tunnel port", type: "number", default: 25700 },
            { key: "tunnelLastPort", label: "Last tunnel port", type: "number", default: 25799, hint: "frps must allow the same range (allowPorts)." },
            { key: "discordWebhook", label: "Discord webhook", type: "secret", hint: "Optional. Posts when a server goes public and when the first tester joins." },
        ],
        actions: [
            { id: "publish", label: "Publish", when: ["running", "not-public"] },
            { id: "unpublish", label: "Unpublish", when: ["public"] },
        ],
        setup: [
            { text: "Get a domain on Cloudflare and a small VPS with a public IP.", link: "https://dash.cloudflare.com" },
            { text: "On the VPS run vps/setup.sh from this repository. It installs frps and prints the control port and token.", copy: "sudo bash vps/setup.sh" },
            { text: "Create a Cloudflare API token with Zone > DNS > Edit on your domain.", link: "https://dash.cloudflare.com/profile/api-tokens" },
            { text: "Fill in the domain, token, VPS address and tunnel token above.", needs: ["publicDomain", "cloudflareToken", "tunnelHost", "tunnelToken"] },
            { text: "Deploy a server with online mode on, then press Publish on its page. Offline servers cannot be published." },
        ],
    },

    async activate(ctx: ExtensionContext) {
        const states = new Map<string, Published>();
        const settings = () => publishSettings(ctx.settings.all());
        const log = (id: string, text: string, stream: "out" | "err" = "out") => ctx.servers.log(id, "app", text, stream);

        const announce = (id: string, up: boolean) => {
            const view = ctx.servers.get(id);
            if (!view) return;
            discord.announce(settings().discordWebhook, { ...view }, up).catch((e: Error) => log(id, `Could not post to Discord: ${e.message}`, "err"));
        };

        async function publish(id: string): Promise<void> {
            const view = ctx.servers.get(id);
            if (!view) throw new Error("No such server");
            if (view.publicAddress) return;
            if (!view.onlineMode) {
                throw new Error("This server is in offline mode, so anyone could join as an operator. Deploy it with online mode on to publish it.");
            }
            const port = ctx.servers.processes(id).find((p) => p.name === "proxy" || p.name === "server")?.port;
            if (!port) throw new Error("The server has no port yet.");
            const current = settings();
            if (!dns.configured(current) || !tunnels.configured(current)) {
                throw new Error("Fill in the domain, Cloudflare token, VPS address and tunnel token in Extensions > Publishing first.");
            }

            const held = new Set([...states.values()].flatMap((s) => (s.tunnel ? [s.tunnel.remotePort] : [])));
            const remote = tunnels.pickPort(current, held);
            log(id, `Opening a tunnel to ${current.tunnelPublicHost || current.tunnelHost}:${remote}...`);
            const state: Published = { records: [], at: 0 };
            state.tunnel = await tunnels.open(
                tunnels.targetOf(current), ctx.cacheDir, dns.labelFor(id), port, remote,
                (line) => log(id, line),
                (reason) => {
                    // The tunnel dying leaves a name that resolves to a port nothing answers on.
                    log(id, `The tunnel closed on its own (${reason}); unpublishing.`, "err");
                    state.tunnel = undefined;
                    void unpublish(id).catch((e: Error) => log(id, `Could not unpublish: ${e.message}`, "err"));
                },
            );
            states.set(id, state);
            try {
                const published = await dns.publish(current, id, remote);
                state.records = published.records;
                state.at = Date.now();
                ctx.servers.update(id, { publicAddress: published.address });
            } catch (error) {
                states.delete(id);
                await state.tunnel.stop();
                throw error;
            }
            log(id, `Published as ${ctx.servers.get(id)?.publicAddress}.`);
            announce(id, true);
        }

        async function unpublish(id: string): Promise<void> {
            const state = states.get(id);
            if (!state || (state.records.length === 0 && !state.tunnel)) return;
            // The tunnel first: that is what actually stops traffic reaching this PC.
            if (ctx.servers.get(id)?.publicAddress) announce(id, false);
            const tunnel = state.tunnel;
            state.tunnel = undefined;
            ctx.servers.update(id, { publicAddress: undefined });
            await tunnel?.stop();
            try {
                await dns.remove(settings(), state.records);
                state.records = [];
            } catch (error) {
                throw new Error(`The tunnel is closed, but the DNS records could not be removed (${(error as Error).message}). They are removed the next time the app starts.`);
            }
            states.delete(id);
            log(id, "No longer public.");
        }

        ctx.action("publish", publish);
        ctx.action("unpublish", unpublish);
        ctx.handle("invite", (id: string) => {
            const view = ctx.servers.get(id);
            if (!view) throw new Error("No such server");
            return discord.invite(view);
        });

        ctx.hook("destroy", async (id) => {
            // Left to the next start's purge if the network is down; deleting the server must not hang on it.
            await unpublish(id);
        });
        ctx.hook("appStart", async () => {
            // Names a crashed run left in DNS point at servers that no longer exist.
            try {
                const removed = await dns.purge(settings());
                if (removed > 0) ctx.log(`Removed ${removed} leftover DNS records`);
            } catch (error) {
                console.warn("Could not clear leftover DNS records", error);
            }
        });

        // The first player after a publish is announced, so whoever published knows a tester made it in.
        ctx.servers.on("player", ({ view, name, joined }) => {
            const state = states.get(view.id);
            if (!joined || !state || !view.publicAddress) return;
            // The event comes after the join is recorded, so the first tester is the only one since the publish.
            if (view.players.filter((p) => p.joinedAt >= state.at).length !== 1) return;
            discord.announceJoin(settings().discordWebhook, { ...view }, name)
                .catch((e: Error) => log(view.id, `Could not post to Discord: ${e.message}`, "err"));
        });

        ctx.dispose(async () => {
            // Disabling the extension takes every published server offline, rather than leaving tunnels nobody owns.
            for (const id of [...states.keys()]) await unpublish(id).catch((e: Error) => console.warn(`Could not unpublish ${id}`, e));
        });
    },
};
