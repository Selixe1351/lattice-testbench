import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logText, playerEvent } from "@shared/console";
import { moduleLine, peerLine } from "@shared/lattice";
import { documentJson, flatCollections, flatDelete, flatDocuments, flatWrite, sqliteCollections, sqliteDelete, sqliteDocuments, sqliteWrite } from "../src/main/extensions/builtin/lattice/data";
import { properties, worldProperties } from "../src/main/instances";

describe("Lattice's own output", () => {
    it("strips Paper's and Velocity's log prefixes", () => {
        expect(logText("[12:00:01 INFO]: Storage: sqlite")).toBe("Storage: sqlite");
        expect(logText("[12:00:01 INFO] [lattice]: Storage: sqlite")).toBe("Storage: sqlite");
    });

    it("reads a `lattice modules` line", () => {
        expect(moduleLine("[12:00:01 INFO]:   shops v1.0.2 [ENABLED] <- economy, profiles")).toEqual({ id: "shops", version: "1.0.2", state: "ENABLED", depends: ["economy", "profiles"] });
        expect(moduleLine("[12:00:01 INFO]:   kits v2.0.0 [FAILED]")).toEqual({ id: "kits", version: "2.0.0", state: "FAILED", depends: [] });
        expect(moduleLine("[12:00:01 INFO]: Modules (2)")).toBeNull();
    });

    it("reads a `lattice peers` line", () => {
        expect(peerLine("[12:00:01 INFO]:   backend-1 [ALIVE] default/eu 127.0.0.1:25603 - 12ms ago"))
            .toEqual({ nodeId: "backend-1", state: "ALIVE", where: "default/eu 127.0.0.1:25603", seen: "12ms ago" });
    });

    it("sees players arrive and leave on Paper and Velocity", () => {
        expect(playerEvent("[12:00:01 INFO]: Steve joined the game")).toEqual({ name: "Steve", joined: true });
        expect(playerEvent("[12:00:01 INFO]: Steve left the game")).toEqual({ name: "Steve", joined: false });
        expect(playerEvent("[12:00:01 INFO]: [connected player] Alex (/1.2.3.4:5678) has connected")).toEqual({ name: "Alex", joined: true });
        expect(playerEvent("[12:00:01 INFO]: [connected player] Alex (/1.2.3.4:5678) has disconnected: quit")).toEqual({ name: "Alex", joined: false });
        expect(playerEvent("[12:00:01 INFO]: <Steve> I joined the game")).toBeNull();
    });
});

describe("worlds", () => {
    it("writes a void world as one layer of air in the void biome", () => {
        const text = properties(worldProperties("void"));
        expect(text).toContain("level-type=minecraft:flat\n");
        expect(text).toContain('generator-settings={"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}');
        expect(properties(worldProperties("flat"))).toContain("level-type=minecraft:flat");
        expect(worldProperties("normal")).toEqual({});
    });
});

describe("flat-file data", () => {
    it("lists collections and decodes ids from their file names", async () => {
        const dir = await mkdtemp(join(tmpdir(), "testbench-flat-"));
        await mkdir(join(dir, "economy_accounts"), { recursive: true });
        const id = "8f14e45f-ceea-4672-a6d6-2a2b2c2d2e2f";
        await writeFile(join(dir, "economy_accounts", `${Buffer.from(id).toString("base64url")}.json`), '{"balance":100}');
        expect(await flatCollections(dir)).toEqual([{ name: "economy_accounts", count: 1 }]);
        expect(await flatDocuments(dir, "economy_accounts", 10)).toEqual([{ id, json: '{\n  "balance": 100\n}' }]);
        await expect(flatDocuments(dir, "../secrets", 10)).rejects.toThrow(/No such collection/);
    });
});

describe("editing stored data", () => {
    it("normalises a document to compact JSON and refuses what Lattice could not read", () => {
        expect(documentJson('{\n  "balance": 5\n}')).toBe('{"balance":5}');
        expect(() => documentJson("{ nope")).toThrow(/Not valid JSON/);
        expect(() => documentJson("[1, 2]")).toThrow(/JSON object/);
    });

    it("writes and deletes flat-file documents where Lattice reads them", async () => {
        const dir = await mkdtemp(join(tmpdir(), "testbench-flatw-"));
        await flatWrite(dir, "economy_accounts", "steve", '{ "balance": 7 }');
        expect(await flatDocuments(dir, "economy_accounts", 10)).toEqual([{ id: "steve", json: '{\n  "balance": 7\n}' }]);
        await flatDelete(dir, "economy_accounts", "steve");
        expect(await flatDocuments(dir, "economy_accounts", 10)).toEqual([]);
        await expect(flatWrite(dir, "../up", "x", "{}")).rejects.toThrow(/collection name/);
    });

    // node:sqlite is in Electron's Node, not the Node 20 vitest usually runs on:
    //   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/vitest/vitest.mjs run test/lattice-data.test.ts
    const hasSqlite = Number(process.versions.node.split(".")[0]) >= 22;
    it.runIf(hasSqlite)("writes, reads and deletes SQLite documents in Lattice's table layout", async () => {
        const file = join(await mkdtemp(join(tmpdir(), "testbench-sqlite-")), "storage.db");
        await sqliteWrite(file, "economy_accounts", "steve", '{"balance":3}');
        await sqliteWrite(file, "economy_accounts", "steve", '{"balance":4}');
        expect(await sqliteCollections(file)).toEqual([{ name: "economy_accounts", count: 1 }]);
        expect(await sqliteDocuments(file, "economy_accounts", 10)).toEqual([{ id: "steve", json: '{\n  "balance": 4\n}' }]);
        await sqliteDelete(file, "economy_accounts", "steve");
        expect(await sqliteDocuments(file, "economy_accounts", 10)).toEqual([]);
    });
});
