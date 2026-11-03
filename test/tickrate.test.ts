import { describe, expect, it } from "vitest";
import { jolokiaUrl } from "../src/main/stats";

describe("tick rate", () => {
    it("finds where the Jolokia agent listens", () => {
        // Printed by jolokia-agent-jvm 2.6.3 on Paper 26.3, before the server's own log starts.
        expect(jolokiaUrl("Jolokia: Agent 2.6.3 started with URL http://127.0.0.1:15725/jolokia and PID 34660")).toBe("http://127.0.0.1:15725/jolokia");
        expect(jolokiaUrl("[00:58:37 INFO]: Done (5.588s)! For help, type \"help\"")).toBeNull();
    });
});
