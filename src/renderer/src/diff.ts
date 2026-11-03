export interface DiffLine {
    kind: "same" | "add" | "del";
    text: string;
    /** 1-based line number in the old text; absent for added lines. */
    oldNo?: number;
    /** 1-based line number in the new text; absent for deleted lines. */
    newNo?: number;
}

/** Past this many cells the table is not built and the middle is shown as one replaced block. */
const MAX_CELLS = 4_000_000;

function split(text: string): string[] {
    if (text === "") return [];
    return text.replace(/\r\n/g, "\n").split("\n");
}

/** A line diff of [before] against [after]: common lines at both ends are peeled off, then LCS on what is left. */
export function diffLines(before: string, after: string): DiffLine[] {
    const a = split(before);
    const b = split(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const out: DiffLine[] = [];
    for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });

    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const n = midA.length;
    const m = midB.length;

    if ((n + 1) * (m + 1) > MAX_CELLS) {
        midA.forEach((text, i) => out.push({ kind: "del", text, oldNo: start + i + 1 }));
        midB.forEach((text, i) => out.push({ kind: "add", text, newNo: start + i + 1 }));
    } else {
        // lcs[i][j] is the length of the longest common run of midA[i..] and midB[j..].
        const width = m + 1;
        const lcs = new Uint32Array((n + 1) * width);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) {
                out.push({ kind: "same", text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
                i++;
                j++;
            } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
                out.push({ kind: "del", text: midA[i], oldNo: start + i + 1 });
                i++;
            } else {
                out.push({ kind: "add", text: midB[j], newNo: start + j + 1 });
                j++;
            }
        }
        for (; i < n; i++) out.push({ kind: "del", text: midA[i], oldNo: start + i + 1 });
        for (; j < m; j++) out.push({ kind: "add", text: midB[j], newNo: start + j + 1 });
    }

    for (let k = 0; k < a.length - endA; k++) {
        out.push({ kind: "same", text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
    }
    return out;
}

export type Shown = DiffLine | { skipped: number };

/** Keeps [context] unchanged lines around every change and replaces the rest with a count. */
export function collapse(lines: DiffLine[], context = 3): Shown[] {
    const keep = new Array<boolean>(lines.length).fill(false);
    lines.forEach((line, i) => {
        if (line.kind === "same") return;
        for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    });
    const out: Shown[] = [];
    let skipped = 0;
    lines.forEach((line, i) => {
        if (keep[i]) {
            if (skipped > 0) out.push({ skipped });
            skipped = 0;
            out.push(line);
        } else {
            skipped++;
        }
    });
    if (skipped > 0) out.push({ skipped });
    return out;
}

export const changed = (lines: DiffLine[]) => lines.some((l) => l.kind !== "same");
