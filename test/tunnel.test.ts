import { describe, expect, it } from "vitest";
import { classify, configured, explain, pickPort, renderConfig, targetOf } from "../src/main/extensions/builtin/publishing/tunnel";
import type { PublishSettings } from "../src/main/extensions/builtin/publishing/settings";

const settings: PublishSettings = {
    publicDomain: "example.net",
    cloudflareToken: "token",
    tunnelHost: "203.0.113.7",
    tunnelPublicHost: "",
    tunnelPort: 7000,
    tunnelToken: 'se"cret',
    tunnelFirstPort: 25700,
    tunnelLastPort: 25702,
    discordWebhook: "",
};

describe("tunnel", () => {
    it("renders a frpc config that exits on a bad login and quotes the secret", () => {
        const config = renderConfig(targetOf(settings), "lattice-test-ab12", 25601, 25700);
        expect(config).toContain('serverAddr = "203.0.113.7"');
        expect(config).toContain("loginFailExit = true");
        expect(config).toContain('auth.token = "se\\"cret"');
        expect(config).toContain("localPort = 25601");
        expect(config).toContain("remotePort = 25700");
    });

    it("hands out the lowest free port in the range and says when none is left", () => {
        expect(pickPort(settings, new Set())).toBe(25700);
        expect(pickPort(settings, new Set([25700, 25702]))).toBe(25701);
        expect(() => pickPort(settings, new Set([25700, 25701, 25702]))).toThrow(/3 tunnel ports/);
    });

    it("needs a host, a token and a sensible range", () => {
        expect(configured(settings)).toBe(true);
        expect(configured({ ...settings, tunnelToken: "" })).toBe(false);
        expect(configured({ ...settings, tunnelHost: "" })).toBe(false);
        expect(configured({ ...settings, tunnelLastPort: 25000 })).toBe(false);
    });

    it("reads frpc output", () => {
        expect(classify("2026-10-16 [I] [proxy/proxy_manager.go:173] [lattice-test-ab12] start proxy success")).toBe("ready");
        expect(classify("[W] [proxy/proxy_manager.go:169] [x] start error: port not allowed")).toBe("failed");
        expect(classify("[E] [client/service.go:1] login to the server failed: token mismatch")).toBe("failed");
        expect(classify("[I] [client/service.go:1] login to server success, get run id [abc]")).toBeNull();
    });

    it("explains a failed login in words a person can act on", () => {
        // Captured from frpc 0.71.1 dialling a tailnet address from a PC on another tailnet.
        const timeout = "login to the server failed: dial tcp 100.64.0.1:7000: i/o timeout. With loginFailExit enabled, no additional retries will be attempted";
        expect(explain(timeout, targetOf({ ...settings, tunnelHost: "100.64.0.1" }))).toMatch(/Could not reach the tunnel server at 100\.64\.0\.1:7000\. That is a Tailscale address/);
        expect(explain(timeout, targetOf(settings))).toMatch(/Check the Tunnel server address in Settings/);
        expect(explain("login to the server failed: token in login doesn't match token from configuration", targetOf(settings))).toMatch(/rejected the tunnel token/);
        expect(explain("[x] start error: port not allowed", targetOf(settings))).toMatch(/25700-25702/);
        expect(explain("something new", targetOf(settings))).toBe("The tunnel server refused the tunnel: something new");
    });
});
