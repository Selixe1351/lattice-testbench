import type { ServerView } from "@shared/types";

/**
 * Tells a Discord channel when a test server goes public and when it stops being reachable, so testers
 * get the address without anyone pasting it. Fire and forget: a webhook that fails never fails a publish.
 */

const COLOR_UP = 0x38bdf8;
const COLOR_DOWN = 0x6b7280;

/** The text people paste to invite someone: address first, then what they are joining. */
export function invite(view: ServerView, now = Date.now()): string {
    if (!view.publicAddress) throw new Error("Publish the server first; it has no public address yet.");
    const what = view.software === "velocity" ? `Test network (${view.version})` : `Test server (${capitalize(view.software)} ${view.version})`;
    const modules = view.plugins.length > 0 ? `Plugins: ${view.plugins.join(", ")}` : "No extra plugins";
    const until = view.kept ? "Up until it is stopped." : `Up for about ${Math.max(1, Math.round((view.expiresAt - now) / 60_000))} more minutes.`;
    return [`Join ${view.publicAddress}`, `${what}. ${modules}.`, until].join("\n");
}

export async function announce(webhook: string, view: ServerView, up: boolean): Promise<void> {
    if (!webhook) return;
    const embed = up
        ? {
            title: `${view.label} is up`,
            description: `\`${view.publicAddress}\``,
            color: COLOR_UP,
            fields: [
                { name: "Software", value: view.software === "velocity" ? `Network, ${view.version}` : `${capitalize(view.software)} ${view.version}`, inline: true },
                { name: "Plugins", value: view.plugins.length > 0 ? view.plugins.join(", ") : "none", inline: true },
                ...(view.kept ? [] : [{ name: "Expires", value: `<t:${Math.floor(view.expiresAt / 1000)}:R>`, inline: true }]),
            ],
        }
        : { title: `${view.label} is gone`, description: "No longer reachable.", color: COLOR_DOWN };
    const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No mentions, whatever a label or module name contains.
        body: JSON.stringify({ username: "Testbench", embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
}

/** The first player to arrive after a publish, so whoever published knows a tester made it in. */
export async function announceJoin(webhook: string, view: ServerView, player: string): Promise<void> {
    if (!webhook) return;
    const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: "Testbench",
            embeds: [{ title: `${player} joined ${view.label}`, description: `\`${view.publicAddress}\``, color: COLOR_UP }],
            allowed_mentions: { parse: [] },
        }),
    });
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
