import { describe, expect, it } from "vitest";
import { ACTION_REFUSED, ACTION_REPLY, actionCommands, entityData, gameMode, inventory, snbtNumber, snbtNumbers, snbtString } from "../src/main/players";

describe("reading a player", () => {
    it("takes the value out of a data get answer", () => {
        expect(entityData("[12:00:01 INFO]: Steve has the following entity data: [0.5d, 64.0d, -3.25d]")).toBe("[0.5d, 64.0d, -3.25d]");
        expect(entityData("[12:00:01 INFO]: No entity was found")).toBeNull();
    });

    it("reads numbers, strings and positions", () => {
        expect(snbtNumber("20.0f")).toBe(20);
        expect(snbtNumber("3")).toBe(3);
        expect(snbtNumber("-1.5E-4d")).toBe(-0.00015);
        expect(snbtString('"minecraft:the_nether"')).toBe("minecraft:the_nether");
        expect(snbtNumbers("[0.5d, 64.0d, -3.25d]")).toEqual([0.5, 64, -3.25]);
        expect(gameMode("1")).toBe("creative");
    });

    it("lists inventory items by slot, ignoring ids nested inside an item", () => {
        const snbt = '[{count: 64, Slot: 1b, id: "minecraft:stone"}, '
            + '{components: {"minecraft:container": [{item: {count: 1, id: "minecraft:dirt"}, slot: 0}]}, count: 1, Slot: 0b, id: "minecraft:shulker_box"}, '
            + '{count: 1, Slot: 9b, id: "minecraft:diamond_sword", components: {"minecraft:custom_name": "{\\"text\\":\\"Slot: 3b\\"}"}}]';
        expect(inventory(snbt)).toEqual([
            { slot: 0, id: "minecraft:shulker_box", count: 1 },
            { slot: 1, id: "minecraft:stone", count: 64 },
            { slot: 9, id: "minecraft:diamond_sword", count: 1, name: "Slot: 3b" },
        ]);
        expect(inventory("[]")).toEqual([]);
    });

    it("reads enchantments in both layouts and names in each form", () => {
        const snbt = '[{Slot: 0b, id: "minecraft:diamond_sword", count: 1, components: {"minecraft:enchantments": {"minecraft:sharpness": 5, "minecraft:unbreaking": 3}, "minecraft:custom_name": "Blade, \\"sharp\\""}}, '
            + '{Slot: 1b, id: "minecraft:bow", count: 1, components: {"minecraft:enchantments": {levels: {"minecraft:power": 2}}, "minecraft:custom_name": {text: "Bow", italic: 0b}}}, '
            + '{Slot: 2b, id: "minecraft:enchanted_book", count: 1, components: {"minecraft:stored_enchantments": {"minecraft:mending": 1}}}]';
        expect(inventory(snbt)).toEqual([
            { slot: 0, id: "minecraft:diamond_sword", count: 1, enchantments: { "minecraft:sharpness": 5, "minecraft:unbreaking": 3 }, name: 'Blade, "sharp"' },
            { slot: 1, id: "minecraft:bow", count: 1, enchantments: { "minecraft:power": 2 }, name: "Bow" },
            { slot: 2, id: "minecraft:enchanted_book", count: 1, enchantments: { "minecraft:mending": 1 } },
        ]);
    });
});

describe("player actions", () => {
    it("builds the console command", () => {
        expect(actionCommands("Steve", { kind: "teleport", x: 1, y: 64, z: -2.5 }, "26.3")).toEqual(["tp Steve 1 64 -2.5"]);
        expect(actionCommands("Steve", { kind: "give", item: "minecraft:diamond", count: 3 }, "26.3")).toEqual(["give Steve minecraft:diamond 3"]);
        expect(actionCommands("Steve", { kind: "gamemode", mode: "creative" }, "26.3")).toEqual(["gamemode creative Steve"]);
    });

    it("refuses input that could become a second command or a bad one", () => {
        expect(() => actionCommands("Steve\nop Mallory", { kind: "op" }, "26.3")).toThrow(/player name/);
        expect(() => actionCommands("Steve", { kind: "give", item: "diamond\nstop", count: 1 }, "26.3")).toThrow(/item id/);
        expect(() => actionCommands("Steve", { kind: "teleport", x: Number.NaN, y: 0, z: 0 }, "26.3")).toThrow(/Coordinates/);
        expect(() => actionCommands("Steve", { kind: "give", item: "minecraft:dirt", count: 0 }, "26.3")).toThrow(/between/);
        expect(() => actionCommands("Steve", { kind: "move", from: 0, to: 36 }, "26.3")).toThrow(/slots/);
    });

    it("moves a stack, and swaps two through an empty slot", () => {
        expect(actionCommands("Steve", { kind: "move", from: 0, to: 9 }, "26.3")).toEqual([
            "item replace entity Steve container.9 from entity Steve container.0",
            "item replace entity Steve container.0 with minecraft:air",
        ]);
        expect(actionCommands("Steve", { kind: "move", from: 0, to: 9, via: 20 }, "26.3")).toHaveLength(4);
        expect(() => actionCommands("Steve", { kind: "move", from: 0, to: 9, via: 9 }, "26.3")).toThrow(/third/);
    });

    it("edits a stack in place, escaping the name", () => {
        expect(actionCommands("Steve", { kind: "count", slot: 3, count: 16 }, "26.3")).toEqual(['item modify entity Steve container.3 {type:"minecraft:set_count",count:16}']);
        expect(actionCommands("Steve", { kind: "enchant", slot: 0, enchantment: "sharpness", level: 0 }, "26.3")).toEqual(['item modify entity Steve container.0 {type:"minecraft:set_enchantments",enchantments:{"minecraft:sharpness":0}}']);
        expect(actionCommands("Steve", { kind: "name", slot: 0, name: 'say "hi" \\' }, "26.3")[0]).toContain('name:"say \\"hi\\" \\\\"');
        expect(() => actionCommands("Steve", { kind: "name", slot: 0, name: "a\nop Mallory" }, "26.3")).toThrow(/one line/);
        expect(() => actionCommands("Steve", { kind: "enchant", slot: 0, enchantment: 'x"}', level: 1 }, "26.3")).toThrow(/enchantment id/);
        expect(() => actionCommands("Steve", { kind: "count", slot: 0, count: 100 }, "26.3")).toThrow(/1 to 99/);
        // Before 26.1 an inline modifier names its function under "function".
        expect(actionCommands("Steve", { kind: "count", slot: 3, count: 16 }, "1.21.11")[0]).toContain('{function:"minecraft:set_count"');
    });

    it("knows the game's answers and which of them are refusals", () => {
        expect(ACTION_REPLY.test("[12:00:01 INFO]: Gave 1 [Diamond] to Steve")).toBe(true);
        expect(ACTION_REPLY.test("[12:00:01 INFO]: Steve lost connection: Kicked")).toBe(false);
        expect(ACTION_REFUSED.test("No targets accepted item into slot container.9")).toBe(true);
        // As 26.3 logs them.
        expect(ACTION_REPLY.test("[09:56:15 INFO]: System chat: No entity was found")).toBe(true);
        expect(ACTION_REFUSED.test("System chat: Failed to parse structure: No key type")).toBe(true);
    });
});
