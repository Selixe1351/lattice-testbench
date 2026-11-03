import type { ExtensionValue } from "@shared/extensions";

/** The Publishing extension's settings, with the names the manifest gives them. */
export interface PublishSettings {
    /** Domain whose DNS test servers are published under, e.g. example.net. */
    publicDomain: string;
    /** Cloudflare API token with Zone > DNS > Edit on [publicDomain]. */
    cloudflareToken: string;
    /** The tunnel server that runs frps, as this PC dials it. Can be a tailnet address, so the control port need not be public. */
    tunnelHost: string;
    /** The tunnel server as players reach it, which DNS points at. Empty means the same as [tunnelHost]. */
    tunnelPublicHost: string;
    /** frps control port on the tunnel server. */
    tunnelPort: number;
    /** Shared secret frps checks before it lets a tunnel open. */
    tunnelToken: string;
    /** The range of ports on the tunnel server that published servers are given; frps must allow the same range. */
    tunnelFirstPort: number;
    tunnelLastPort: number;
    /** Discord webhook told when a server is published and when it goes. Empty turns it off. */
    discordWebhook: string;
}

export function publishSettings(values: Partial<Record<string, ExtensionValue | undefined>>): PublishSettings {
    const text = (key: string) => String(values[key] ?? "");
    const number = (key: string) => Number(values[key] ?? 0);
    return {
        publicDomain: text("publicDomain"),
        cloudflareToken: text("cloudflareToken"),
        tunnelHost: text("tunnelHost"),
        tunnelPublicHost: text("tunnelPublicHost"),
        tunnelPort: number("tunnelPort"),
        tunnelToken: text("tunnelToken"),
        tunnelFirstPort: number("tunnelFirstPort"),
        tunnelLastPort: number("tunnelLastPort"),
        discordWebhook: text("discordWebhook"),
    };
}
