/**
 * The split view's arrangement as a tree: rows and columns nested freely, each child with a size weight.
 * Pure functions only, so moving and docking panes is tested without a DOM.
 */

export type Dir = "row" | "column";
export type Zone = "left" | "right" | "top" | "bottom" | "center";

export type Layout<P extends string = string> =
    | { kind: "pane"; id: P }
    | { kind: "split"; dir: Dir; children: Layout<P>[]; sizes: number[] };

export function panesIn<P extends string>(layout: Layout<P>): P[] {
    return layout.kind === "pane" ? [layout.id] : layout.children.flatMap(panesIn);
}

/** Splits with one child become that child; a split inside a split of the same direction is merged into it. */
export function normalize<P extends string>(layout: Layout<P>): Layout<P> {
    if (layout.kind === "pane") return layout;
    const children: Layout<P>[] = [];
    const sizes: number[] = [];
    layout.children.forEach((raw, i) => {
        const child = normalize(raw);
        const weight = layout.sizes[i] ?? 1;
        if (child.kind === "split" && child.dir === layout.dir) {
            // Keep the merged children's share of this slot, split as it was split inside.
            const total = child.sizes.reduce((a, b) => a + b, 0) || 1;
            child.children.forEach((c, j) => {
                children.push(c);
                sizes.push((weight * child.sizes[j]) / total);
            });
        } else {
            children.push(child);
            sizes.push(weight);
        }
    });
    if (children.length === 1) return children[0];
    return { kind: "split", dir: layout.dir, children, sizes };
}

/** [layout] without pane [id], or null if that was the only pane. */
export function remove<P extends string>(layout: Layout<P>, id: P): Layout<P> | null {
    if (layout.kind === "pane") return layout.id === id ? null : layout;
    const kept = layout.children.map((c, i) => ({ c: remove(c, id), size: layout.sizes[i] ?? 1 })).filter((x) => x.c !== null);
    if (kept.length === 0) return null;
    return normalize({ kind: "split", dir: layout.dir, children: kept.map((x) => x.c!), sizes: kept.map((x) => x.size) });
}

function replace<P extends string>(layout: Layout<P>, target: P, make: (pane: Layout<P>) => Layout<P>): Layout<P> {
    if (layout.kind === "pane") return layout.id === target ? make(layout) : layout;
    return { ...layout, children: layout.children.map((c) => replace(c, target, make)) };
}

/**
 * Moves pane [id] next to pane [target]: on the [zone] side of it, or in its place (the two swap) for
 * "center". A pane not yet in the layout is added the same way.
 */
export function move<P extends string>(layout: Layout<P>, id: P, target: P, zone: Zone): Layout<P> {
    if (id === target) return layout;
    if (zone === "center") {
        const has = panesIn(layout).includes(id);
        // Swap: the target takes the dragged pane's place (when it had one) and the other way round.
        const swap = (l: Layout<P>): Layout<P> => {
            if (l.kind === "pane") return l.id === target ? { kind: "pane", id } : l.id === id ? { kind: "pane", id: target } : l;
            return { ...l, children: l.children.map(swap) };
        };
        return has ? swap(layout) : replace(layout, target, () => ({ kind: "pane", id }));
    }
    const without = remove(layout, id);
    if (!without) return layout;
    const dir: Dir = zone === "left" || zone === "right" ? "row" : "column";
    const before = zone === "left" || zone === "top";
    const moved: Layout<P> = { kind: "pane", id };
    return normalize(replace(without, target, (pane) => ({
        kind: "split",
        dir,
        children: before ? [moved, pane] : [pane, moved],
        sizes: [1, 1],
    })));
}

/** Adds [id] beside everything else, on the right. */
export function add<P extends string>(layout: Layout<P> | null, id: P): Layout<P> {
    if (!layout) return { kind: "pane", id };
    if (panesIn(layout).includes(id)) return layout;
    const total = layout.kind === "split" && layout.dir === "row" ? layout.sizes.reduce((a, b) => a + b, 0) : 1;
    const weight = layout.kind === "split" && layout.dir === "row" ? total / layout.children.length : 1;
    return normalize({ kind: "split", dir: "row", children: [layout, { kind: "pane", id }], sizes: [total, weight] });
}

/** The split at [path] (child indexes from the root) with new sizes. */
export function resize<P extends string>(layout: Layout<P>, path: number[], sizes: number[]): Layout<P> {
    if (layout.kind === "pane") return layout;
    if (path.length === 0) return { ...layout, sizes };
    const [head, ...rest] = path;
    return { ...layout, children: layout.children.map((c, i) => (i === head ? resize(c, rest, sizes) : c)) };
}

/** Which part of a pane the pointer is over: the outer quarter on each side docks there, the middle swaps. */
export function zoneAt(x: number, y: number, width: number, height: number): Zone {
    const fx = x / width;
    const fy = y / height;
    const edges: [Zone, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
    const [zone, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
    return distance < 0.25 ? zone : "center";
}

/** A stored layout is only trusted if every pane in it is still a known pane, once. */
export function valid<P extends string>(layout: unknown, known: readonly P[]): layout is Layout<P> {
    const seen = new Set<string>();
    const check = (l: unknown): boolean => {
        if (!l || typeof l !== "object") return false;
        const node = l as Record<string, unknown>;
        if (node.kind === "pane") {
            if (typeof node.id !== "string" || !known.includes(node.id as P) || seen.has(node.id)) return false;
            seen.add(node.id);
            return true;
        }
        return node.kind === "split" && (node.dir === "row" || node.dir === "column") && Array.isArray(node.children)
            && Array.isArray(node.sizes) && node.children.length === node.sizes.length && node.children.every(check);
    };
    return check(layout);
}
