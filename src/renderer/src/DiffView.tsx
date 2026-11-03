import { useMemo } from "react";
import { changed, collapse, diffLines } from "./diff";

/** A unified diff of [before] against [after], with long unchanged stretches folded away. */
export function DiffView({ before, after }: { before: string; after: string }) {
    const lines = useMemo(() => diffLines(before, after), [before, after]);
    const shown = useMemo(() => collapse(lines), [lines]);
    const added = lines.filter((l) => l.kind === "add").length;
    const removed = lines.filter((l) => l.kind === "del").length;

    if (!changed(lines)) {
        return (
            <div className="empty">
                <p>No differences.</p>
            </div>
        );
    }

    return (
        <div className="diff">
            <div className="diff-summary">
                <span className="add">+{added}</span> <span className="del">-{removed}</span>
            </div>
            {shown.map((item, i) =>
                "skipped" in item ? (
                    <div key={i} className="diff-fold">{item.skipped} unchanged line{item.skipped === 1 ? "" : "s"}</div>
                ) : (
                    <div key={i} className={`diff-line ${item.kind}`}>
                        <span className="no">{item.oldNo ?? ""}</span>
                        <span className="no">{item.newNo ?? ""}</span>
                        <span className="sign">{item.kind === "add" ? "+" : item.kind === "del" ? "-" : " "}</span>
                        <span className="text">{item.text}</span>
                    </div>
                ),
            )}
        </div>
    );
}
