import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { usageWords } from "../src/main/instances";
import { McpEndpoint } from "../src/main/extensions/builtin/mcp/server";
import { Tools } from "../src/main/extensions/hooks";
import type { ServerApi } from "../src/main/extensions/types";

describe("server help", () => {
    it("reads the literal words of a usage", () => {
        expect(usageWords("[12:00:00 INFO]: /advancement (grant|revoke) <targets>")).toEqual([["advancement"], ["grant", "revoke"]]);
        expect(usageWords("/lattice modules")).toEqual([["lattice"], ["modules"]]);
        expect(usageWords("/tp <targets> <location>")).toEqual([["tp"], []]);
    });
});

describe("MCP endpoint", () => {
    const port = 27831;
    const token = "test-token-123";
    const tools = new Tools();
    // Only what the tools under test touch.
    const servers = { list: () => [], get: () => undefined } as unknown as ServerApi;
    let endpoint: McpEndpoint;

    beforeAll(async () => {
        tools.add("test", { name: "echo", description: "Repeats a word.", input: { word: { type: "string", description: "What to repeat" } }, run: ({ word }) => `you said ${word}` });
        endpoint = new McpEndpoint({ servers, tools: () => tools.list() }, () => token);
        await endpoint.start(port);
    });
    afterAll(() => endpoint.stop());

    const connect = async (given: string) => {
        const client = new Client({ name: "test", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${given}` } } }));
        return client;
    };

    it("lists the core tools and the ones extensions added, and answers a call", async () => {
        const client = await connect(token);
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["deploy", "console", "wait_for_console", "run_command", "player_info", "echo"]));
        expect(names).not.toContain("publish");
        expect((await client.callTool({ name: "list_servers", arguments: {} })).content).toEqual([{ type: "text", text: "[]" }]);
        expect((await client.callTool({ name: "echo", arguments: { word: "hi" } })).content).toEqual([{ type: "text", text: "you said hi" }]);
        await client.close();
    });

    it("refuses a wrong token and browser requests", async () => {
        await expect(connect("wrong")).rejects.toThrow();
        const fromBrowser = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" }, body: "{}" });
        expect(fromBrowser.status).toBe(403);
    });
});
