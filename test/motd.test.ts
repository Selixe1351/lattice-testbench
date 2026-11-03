import { describe, expect, it } from "vitest";
import { motd, properties, velocityMotd } from "../src/main/instances";
import { SERVER_ICON } from "../src/main/server-icon";

describe("server listing", () => {
    it("escapes the MOTD so java.util.Properties reads back two lines and the section signs", () => {
        const text = properties({ motd: motd("Paper 1.21.4", null), "server-port": 25600 });
        expect(text).toBe(
            "motd=\\u00a7b\\u00a7lTestbench \\u00a78\\u00bb \\u00a7fTest server\\n\\u00a77Paper 1.21.4\n"
            + "server-port=25600\n",
        );
    });

    it("names the backend only behind a proxy", () => {
        expect(motd("Paper 1.21.4", "lobby")).toContain("lobby §8· §7Paper 1.21.4");
        expect(motd("Paper 1.21.4", null)).toMatch(/Paper 1\.21\.4$/);
        expect(velocityMotd(2)).toContain("2 servers");
    });

    it("ships a 64x64 PNG, the only size Minecraft accepts", () => {
        expect(SERVER_ICON.subarray(1, 4).toString()).toBe("PNG");
        expect([SERVER_ICON.readUInt32BE(16), SERVER_ICON.readUInt32BE(20)]).toEqual([64, 64]);
    });
});
