import { useRef, useState } from "react";
import { Close } from "./icons";
import { type Layout, move, remove, resize, type Zone, zoneAt } from "./split";

/**
 * The split view: panes in a tree of rows and columns. Drag a pane by its title onto another pane: drop on an
 * edge to dock it on that side, in the middle to swap the two. Every divider resizes the panes either side.
 */

const MIN_PX = 120;
/** The drag's payload type, so only pane drags light up the drop zones (not files dropped on the Files tab). */
const DRAG_TYPE = "application/x-testbench-pane";

interface Props<P extends string> {
    layout: Layout<P>;
    onChange: (layout: Layout<P>) => void;
    label: (id: P) => string;
    render: (id: P) => React.ReactNode;
}

export function SplitView<P extends string>({ layout, onChange, label, render }: Props<P>) {
    const [dragging, setDragging] = useState<P | null>(null);
    const [hover, setHover] = useState<{ id: P; zone: Zone } | null>(null);
    const single = layout.kind === "pane";

    const node = (l: Layout<P>, path: number[]): React.ReactNode => {
        if (l.kind === "pane") return pane(l.id);
        return <SplitNode key={path.join(".")} layout={l} path={path} onResize={(sizes) => onChange(resize(layout, path, sizes))} child={(c, i) => node(c, [...path, i])} />;
    };

    const pane = (id: P) => (
        <div
            key={id}
            className="split-pane"
            onDragOver={(e) => {
                if (!dragging || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const zone = id === dragging ? "center" : zoneAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
                if (hover?.id !== id || hover.zone !== zone) setHover({ id, zone });
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover((h) => (h?.id === id ? null : h));
            }}
            onDrop={(e) => {
                e.preventDefault();
                if (dragging && hover?.id === id) onChange(move(layout, dragging, id, hover.zone));
                setDragging(null);
                setHover(null);
            }}
        >
            <div
                className="split-pane-head"
                draggable={!single}
                title={single ? undefined : "Drag onto another pane: an edge docks it there, the middle swaps them"}
                onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(id);
                }}
                onDragEnd={() => {
                    setDragging(null);
                    setHover(null);
                }}
            >
                <span className="grip">⠿</span>
                <span>{label(id)}</span>
                <span className="grow" />
                {!single && (
                    <button className="icon-btn" title="Close this pane" onClick={() => { const next = remove(layout, id); if (next) onChange(next); }}>
                        <Close />
                    </button>
                )}
            </div>
            <div className="split-pane-body">{render(id)}</div>
            {dragging && hover?.id === id && dragging !== id && <div className={`drop-zone ${hover.zone}`} />}
        </div>
    );

    return <div className={`split-root ${dragging ? "dragging" : ""}`}>{node(layout, [])}</div>;
}

/** One row or column: its children with a divider between each pair. */
function SplitNode<P extends string>({ layout, path, onResize, child }: {
    layout: Extract<Layout<P>, { kind: "split" }>;
    path: number[];
    onResize: (sizes: number[]) => void;
    child: (l: Layout<P>, i: number) => React.ReactNode;
}) {
    const refs = useRef<(HTMLDivElement | null)[]>([]);
    const horizontal = layout.dir === "row";

    /** Trades size between child [i] and the next while dragging; the result is stored when the pointer lifts. */
    const drag = (event: React.PointerEvent, i: number) => {
        event.preventDefault();
        const px = (el: HTMLDivElement | null) => (el ? (horizontal ? el.offsetWidth : el.offsetHeight) : 0);
        // Measured in pixels, so the stored weights share one unit and later resizes stay proportional.
        const start = refs.current.map(px);
        const origin = horizontal ? event.clientX : event.clientY;
        const pair = start[i] + start[i + 1];
        let latest = start;
        const moveTo = (e: PointerEvent) => {
            const delta = (horizontal ? e.clientX : e.clientY) - origin;
            const first = Math.min(Math.max(start[i] + delta, MIN_PX), Math.max(pair - MIN_PX, MIN_PX));
            latest = start.map((s, j) => (j === i ? first : j === i + 1 ? pair - first : s));
            refs.current.forEach((el, j) => { if (el) el.style.flex = `${latest[j]} 1 0`; });
        };
        const up = () => {
            window.removeEventListener("pointermove", moveTo);
            window.removeEventListener("pointerup", up);
            onResize(latest);
        };
        window.addEventListener("pointermove", moveTo);
        window.addEventListener("pointerup", up);
    };

    return (
        <div className={`split-node ${layout.dir}`} data-path={path.join(".")}>
            {layout.children.map((c, i) => (
                <div key={i} className="split-slot-wrap" style={{ display: "contents" }}>
                    {i > 0 && <div className={`splitter ${layout.dir}`} onPointerDown={(e) => drag(e, i - 1)} />}
                    <div className="split-slot" ref={(el) => { refs.current[i] = el; }} style={{ flex: `${layout.sizes[i] ?? 1} 1 0` }}>
                        {child(c, i)}
                    </div>
                </div>
            ))}
        </div>
    );
}
