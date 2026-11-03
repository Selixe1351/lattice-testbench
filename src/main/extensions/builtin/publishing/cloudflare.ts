import { hostname } from "node:os";
import type { PublishSettings } from "./settings";

/**
 * Gives a test server a name under the person's own domain, using two Cloudflare DNS records that are
 * deliberately not proxied (Cloudflare's proxy does not carry Minecraft traffic without Spectrum):
 *
 *   testbench-ab12.example.net                   A    <the tunnel server>
 *   _minecraft._tcp.testbench-ab12.example.net   SRV  0 5 <port on the tunnel server> testbench-ab12.example.net
 *
 * The records point at the tunnel server that tunnels to this PC, never at this PC, so the home address is not
 * published anywhere. The SRV record is what lets players type the name with no port.
 */

const API = "https://api.cloudflare.com/client/v4";
export const PREFIX = "testbench-";
/**
 * Every record says which PC made it, so a start-up purge on one PC leaves alone the live records of
 * another PC publishing under the same zone. The optional reaper script (relay/reaper.py) covers the rest.
 */
export const COMMENT = `Testbench on ${hostname()}`;

export interface Published {
    address: string;
    /** Cloudflare record ids, so unpublishing removes exactly what was created. */
    records: string[];
}

interface Envelope<T> {
    success: boolean;
    errors?: { message: string }[];
    result: T;
}

async function call<T>(settings: PublishSettings, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${settings.cloudflareToken}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !envelope?.success) {
        const why = envelope?.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
        throw new Error(`Cloudflare: ${why}`);
    }
    return envelope.result;
}

async function zoneId(settings: PublishSettings): Promise<string> {
    const zones = await call<{ id: string }[]>(settings, "GET", `/zones?name=${encodeURIComponent(settings.publicDomain)}`);
    if (zones.length === 0) throw new Error(`Cloudflare has no zone named ${settings.publicDomain} for this token.`);
    return zones[0].id;
}

export function configured(settings: PublishSettings): boolean {
    return Boolean(settings.publicDomain && settings.cloudflareToken && settings.tunnelHost);
}

/** The label a server gets: testbench- plus the random tail of its id. */
export function labelFor(serverId: string): string {
    return `${PREFIX}${serverId.slice(serverId.lastIndexOf("-") + 1)}`;
}

/** Names [serverId] after the tunnel server, with the SRV record pointing at [port] on it. */
export async function publish(settings: PublishSettings, serverId: string, port: number): Promise<Published> {
    if (!configured(settings)) throw new Error("Set the domain, Cloudflare token and Tunnel server address in Settings first.");
    const zone = await zoneId(settings);
    const host = `${labelFor(serverId)}.${settings.publicDomain}`;
    const target = settings.tunnelPublicHost || settings.tunnelHost;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target);

    const records: string[] = [];
    try {
        const a = await call<{ id: string }>(settings, "POST", `/zones/${zone}/dns_records`, isIp
            ? { type: "A", name: host, content: target, ttl: 60, proxied: false, comment: COMMENT }
            : { type: "CNAME", name: host, content: target, ttl: 60, proxied: false, comment: COMMENT });
        records.push(a.id);
        const srv = await call<{ id: string }>(settings, "POST", `/zones/${zone}/dns_records`, {
            type: "SRV",
            name: `_minecraft._tcp.${host}`,
            data: { priority: 0, weight: 5, port, target: host },
            ttl: 60,
            comment: COMMENT,
        });
        records.push(srv.id);
    } catch (error) {
        // Half a publish would leave a name that resolves to nothing; take back what was made.
        await remove(settings, records).catch((e) => console.warn("Could not clean up after a failed publish", e));
        throw error;
    }
    return { address: host, records };
}

export async function remove(settings: PublishSettings, records: string[]): Promise<void> {
    if (records.length === 0) return;
    const zone = await zoneId(settings);
    const failures: string[] = [];
    for (const id of records) {
        try {
            await call(settings, "DELETE", `/zones/${zone}/dns_records/${id}`);
        } catch (error) {
            failures.push((error as Error).message);
        }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
}

/**
 * Deletes the records this PC made and did not get to remove, such as after a crash: the testbench-
 * prefix and this PC's comment. Records from another PC are the reaper's to judge, by whether their
 * tunnel is still live.
 */
export async function purge(settings: PublishSettings): Promise<number> {
    if (!configured(settings)) return 0;
    const zone = await zoneId(settings);
    let removed = 0;
    for (const name of [`${PREFIX}`, `_minecraft._tcp.${PREFIX}`]) {
        const found = await call<{ id: string; name: string; comment?: string | null }[]>(
            settings, "GET", `/zones/${zone}/dns_records?name.startswith=${encodeURIComponent(name)}&per_page=100`,
        );
        for (const record of found) {
            if (!record.name.endsWith(`.${settings.publicDomain}`) || record.comment !== COMMENT) continue;
            await call(settings, "DELETE", `/zones/${zone}/dns_records/${record.id}`);
            removed++;
        }
    }
    return removed;
}
