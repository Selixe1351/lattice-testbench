import { describe, expect, it } from "vitest";
import { add, type Layout, move, normalize, panesIn, remove, valid, zoneAt } from "../src/renderer/src/split";

type P = "a" | "b" | "c" | "d";
const pane = (id: P): Layout<P> => ({ kind: "pane", id });
const row = (...children: Layout<P>[]): Layout<P> => ({ kind: "split", dir: "row", children, sizes: children.map(() => 1) });
const col = (...children: Layout<P>[]): Layout<P> => ({ kind: "split", dir: "column", children, sizes: children.map(() => 1) });

describe("split layout", () => {
    it("docks a pane below another, making a column inside the row", () => {
        const next = move(row(pane("a"), pane("b"), pane("c")), "c", "a", "bottom");
        expect(next).toEqual({ kind: "split", dir: "row", sizes: [1, 1], children: [col(pane("a"), pane("c")), pane("b")] });
    });

    it("docks beside within the same row without nesting", () => {
        expect(panesIn(move(row(pane("a"), pane("b"), pane("c")), "c", "a", "left"))).toEqual(["c", "a", "b"]);
        expect(move(row(pane("a"), pane("b")), "b", "a", "left")).toEqual(row(pane("b"), pane("a")));
    });

    it("swaps two panes on a centre drop, wherever they are", () => {
        expect(panesIn(move(row(col(pane("a"), pane("b")), pane("c")), "a", "c", "center"))).toEqual(["c", "b", "a"]);
    });

    it("collapses what is left when a pane goes", () => {
        expect(remove(row(col(pane("a"), pane("b")), pane("c")), "b")).toEqual(row(pane("a"), pane("c")));
        expect(remove(pane("a"), "a")).toBeNull();
    });

    it("merges a nested split of the same direction, keeping its share", () => {
        const nested: Layout<P> = { kind: "split", dir: "row", children: [pane("a"), { kind: "split", dir: "row", children: [pane("b"), pane("c")], sizes: [1, 3] }], sizes: [2, 2] };
        expect(normalize(nested)).toEqual({ kind: "split", dir: "row", children: [pane("a"), pane("b"), pane("c")], sizes: [2, 0.5, 1.5] });
    });

    it("adds a new pane on the right", () => {
        expect(panesIn(add(col(pane("a"), pane("b")), "c"))).toEqual(["a", "b", "c"]);
        expect(add(null, "a")).toEqual(pane("a"));
    });

    it("picks the zone by the nearest edge, with the middle swapping", () => {
        expect(zoneAt(5, 50, 100, 100)).toBe("left");
        expect(zoneAt(50, 95, 100, 100)).toBe("bottom");
        expect(zoneAt(50, 50, 100, 100)).toBe("center");
    });

    it("refuses a stored layout with unknown or repeated panes", () => {
        expect(valid(row(pane("a"), pane("b")), ["a", "b"])).toBe(true);
        expect(valid(row(pane("a"), pane("a")), ["a", "b"])).toBe(false);
        expect(valid({ kind: "pane", id: "zzz" }, ["a"])).toBe(false);
    });
});
