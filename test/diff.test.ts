import { describe, expect, it } from "vitest";
import { changed, collapse, diffLines } from "../src/renderer/src/diff";

describe("diffLines", () => {
    it("reports no change for equal text", () => {
        expect(changed(diffLines("a\nb\n", "a\nb\n"))).toBe(false);
        expect(changed(diffLines("", ""))).toBe(false);
    });

    it("marks added, removed and changed lines with their numbers", () => {
        const lines = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
        const shape = lines.map((l) => `${l.kind}:${l.text}`);
        expect(shape).toEqual(["same:a", "del:b", "add:B", "same:c", "add:d", "same:"]);
        expect(lines[1]).toMatchObject({ oldNo: 2 });
        expect(lines[2]).toMatchObject({ newNo: 2 });
    });

    it("handles a whole file added or removed", () => {
        expect(diffLines("", "x\ny").map((l) => l.kind)).toEqual(["add", "add"]);
        expect(diffLines("x\ny", "").map((l) => l.kind)).toEqual(["del", "del"]);
    });

    it("treats CRLF and LF the same", () => {
        expect(changed(diffLines("a\r\nb", "a\nb"))).toBe(false);
    });

    it("falls back to a replaced block for inputs too large to table", () => {
        const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
        const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
        const kinds = new Set(diffLines(a, b).map((l) => l.kind));
        expect(kinds).toEqual(new Set(["del", "add"]));
    });
});

describe("collapse", () => {
    it("keeps context around changes and folds the rest", () => {
        const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
        const after = before.replace("line 15", "changed");
        const shown = collapse(diffLines(before, after), 2);
        const folds = shown.filter((s) => "skipped" in s);
        expect(folds).toEqual([{ skipped: 13 }, { skipped: 12 }]);
        expect(shown.filter((s) => !("skipped" in s))).toHaveLength(2 + 1 + 1 + 2);
    });
});
