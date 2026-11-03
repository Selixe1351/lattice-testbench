import { useEffect, useState } from "react";
import type { DataChange, DataDocument, DataSource } from "@shared/lattice";
import type { ServerView } from "@shared/types";
import { latticeApi } from "./ext";
import { DiffView } from "./DiffView";
import { confirm } from "./confirm";
import { Plus, Refresh, Trash } from "./icons";

const LIVE_EVERY_MS = 3_000;
const LIMIT = 50;

const KIND: Record<DataSource["kind"], string> = { sqlite: "SQLite", flatfile: "Flat files" };

const describe = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** One document: read-only while the server runs, an editor once it is stopped. */
function Doc({ doc, editable, onSave, onDelete }: { doc: DataDocument; editable: boolean; onSave: (json: string) => Promise<void>; onDelete: () => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(doc.json);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const changed = draft !== doc.json;

    // A fresh read replaces the text unless the person is part way through an edit.
    useEffect(() => { if (!changed) setDraft(doc.json); }, [doc.json]);

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(describe(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`data-doc ${changed ? "changed" : ""}`}>
            <div className="data-doc-head" onClick={() => setOpen(!open)}>
                <span className="mono">{doc.id}</span>
                <span className="faint sm">{changed ? "edited" : open ? "hide" : "show"}</span>
            </div>
            {open && (editable ? (
                <div className="data-doc-edit">
                    <textarea className="input mono" spellCheck={false} rows={Math.min(24, draft.split("\n").length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    {error && <div className="error-box">{error}</div>}
                    <div className="config-actions">
                        <button className="btn sm primary" disabled={!changed || busy} onClick={() => void run(() => onSave(draft))}>Save</button>
                        <button className="btn sm ghost" disabled={!changed || busy} onClick={() => setDraft(doc.json)}>Discard</button>
                        <span className="grow" />
                        <button className="btn sm ghost danger-text" disabled={busy} onClick={async () => (await confirm(`Delete ${doc.id}?`)) && void run(onDelete)}><Trash /> Delete</button>
                    </div>
                </div>
            ) : <pre className="lattice-lines">{doc.json}</pre>)}
        </div>
    );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Every document added, removed or changed since the mark, with a diff of the one picked. */
function Changes({ at, changes, onClose }: { at: number; changes: DataChange[]; onClose: () => void }) {
    const [open, setOpen] = useState<string | null>(null);
    const key = (c: DataChange) => `${c.process}/${c.collection}/${c.id}`;
    const picked = changes.find((c) => key(c) === open) ?? changes[0];
    const kind = (c: DataChange) => (c.before === undefined ? "added" : c.after === undefined ? "deleted" : "changed");
    return (
        <div className="data-changes">
            <div className="data-docs-head">
                <span className="faint sm">{changes.length === 0 ? "No changes" : `${changes.length} document${changes.length === 1 ? "" : "s"} changed`} since {clock(at)}</span>
                <span className="grow" />
                <button className="btn sm ghost" onClick={onClose}>Back to documents</button>
            </div>
            {changes.length > 0 && (
                <div className="data-changes-split">
                    <div className="data-changes-list">
                        {changes.map((c) => (
                            <button key={key(c)} className={`file ${picked && key(picked) === key(c) ? "active" : ""}`} onClick={() => setOpen(key(c))}>
                                <span className={`change-kind ${kind(c)}`}>{kind(c)}</span>
                                <span className="mono" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{c.collection}/{c.id}</span>
                            </button>
                        ))}
                    </div>
                    {picked && <div className="data-changes-diff"><DiffView before={picked.before ?? ""} after={picked.after ?? ""} /></div>}
                </div>
            )}
        </div>
    );
}

/** What Lattice stored on this server, newest first. Editable once every process is stopped. */
export function DataTab({ server }: { server: ServerView }) {
    const [sources, setSources] = useState<DataSource[]>([]);
    const [picked, setPicked] = useState<{ process: string; collection: string } | null>(null);
    const [docs, setDocs] = useState<DataDocument[]>([]);
    const [live, setLive] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [resetting, setResetting] = useState(false);
    const [adding, setAdding] = useState<{ id: string; json: string } | null>(null);
    const [mark, setMark] = useState<number | null>(null);
    const [diff, setDiff] = useState<{ at: number; changes: DataChange[] } | null>(null);
    const stopped = server.processes.length > 0 && server.processes.every((p) => p.state === "stopped" || p.state === "failed");
    const kind = sources[0]?.kind ?? "sqlite";
    const editable = stopped;

    const load = () => {
        latticeApi.sources(server.id).then((s: DataSource[]) => { setSources(s); setError(null); }, (e: unknown) => setError(describe(e)));
        if (picked) latticeApi.documents(server.id, picked.process, picked.collection, LIMIT).then(setDocs, (e: unknown) => setError(describe(e)));
    };

    useEffect(load, [server.id, picked?.process, picked?.collection, stopped]);
    useEffect(() => {
        // Nothing changes under a stopped server except through this tab, which reloads after each write.
        if (!live || stopped) return;
        const timer = setInterval(load, LIVE_EVERY_MS);
        return () => clearInterval(timer);
    }, [live, stopped, server.id, picked?.process, picked?.collection]);

    const write = async (id: string, json: string | null) => {
        if (!picked) return;
        await latticeApi.write(server.id, picked.process, picked.collection, id, json);
        load();
    };

    /** Remembers every document now; Changes then shows what was written since, e.g. by one command in game. */
    const markNow = () => {
        setDiff(null);
        latticeApi.mark(server.id).then((m) => setMark(m.at), (e: unknown) => setError(describe(e)));
    };
    const showChanges = () => {
        latticeApi.changes(server.id).then(setDiff, (e: unknown) => setError(describe(e)));
    };

    const reset = async () => {
        if (!(await confirm("Stop the server, delete everything Lattice stored on it, and start it again?", { action: "Reset" }))) return;
        setResetting(true);
        try {
            await latticeApi.reset(server.id);
            setDocs([]);
        } catch (e) {
            setError(describe(e));
        } finally {
            setResetting(false);
        }
    };

    return (
        <div className="data-tab">
            <div className="console-tools">
                <span className="faint sm">Storage: <b>{KIND[kind]}</b></span>
                <span className={`badge ${editable ? "ok" : ""}`} title={editable ? "" : "Lattice caches documents, so edits wait until every process is stopped"}>
                    {editable ? "editing on" : "read-only while running"}
                </span>
                <span className="grow" />
                {!stopped && <label className="check sm"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live</label>}
                <button className="btn sm ghost" onClick={markNow} title="Remember every document now, to see what changes after">
                    {mark ? `Marked ${clock(mark)}` : "Mark"}
                </button>
                {mark && <button className={`btn sm ${diff ? "" : "ghost"}`} onClick={showChanges} title="What was added, removed or changed since the mark">Changes</button>}
                <button className="btn sm ghost" onClick={load}><Refresh /> Refresh</button>
                <button className="btn sm ghost danger-text" onClick={() => void reset()} disabled={resetting || server.state === "preparing"}>
                    <Trash /> {resetting ? "Resetting..." : "Reset data"}
                </button>
            </div>
            {error && <div className="error-box" onClick={() => setError(null)}>{error}</div>}
            <div className="data-split">
                <div className="data-sources">
                    {sources.map((source) => (
                        <div key={source.process} className="data-source">
                            {sources.length > 1 && <div className="menu-label">{source.process}</div>}
                            {source.note && <p className="faint sm">{source.note}</p>}
                            {source.collections.map((c) => {
                                const on = picked?.process === source.process && picked.collection === c.name;
                                return (
                                    <button key={c.name} className={`file ${on ? "active" : ""}`} onClick={() => { setPicked({ process: source.process, collection: c.name }); setAdding(null); }}>
                                        <span className="mono">{c.name}</span>
                                        <span className="faint sm" style={{ marginLeft: "auto" }}>{c.count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
                {diff ? <Changes at={diff.at} changes={diff.changes} onClose={() => setDiff(null)} /> : <div className="data-docs">
                    {!picked && <p className="faint sm">Pick a collection.{editable ? "" : " Stop the server to edit documents."}</p>}
                    {picked && (
                        <div className="data-docs-head">
                            <span className="faint sm">{docs.length === 0 ? "Empty." : `Newest ${docs.length} of ${picked.collection}`}</span>
                            <span className="grow" />
                            {editable && !adding && <button className="btn sm ghost" onClick={() => setAdding({ id: "", json: "{\n  \n}" })}><Plus /> New document</button>}
                        </div>
                    )}
                    {adding && picked && (
                        <div className="data-doc changed">
                            <div className="data-doc-edit">
                                <input className="input mono" placeholder="Document id" value={adding.id} onChange={(e) => setAdding({ ...adding, id: e.target.value })} />
                                <textarea className="input mono" spellCheck={false} rows={6} value={adding.json} onChange={(e) => setAdding({ ...adding, json: e.target.value })} />
                                <div className="config-actions">
                                    <button className="btn sm primary" disabled={!adding.id.trim()} onClick={() => write(adding.id.trim(), adding.json).then(() => setAdding(null), (e: unknown) => setError(describe(e)))}>Add</button>
                                    <button className="btn sm ghost" onClick={() => setAdding(null)}>Cancel</button>
                                </div>
                            </div>
                        </div>
                    )}
                    {docs.map((d) => (
                        <Doc key={`${picked?.process}/${picked?.collection}/${d.id}`} doc={d} editable={editable} onSave={(json) => write(d.id, json)} onDelete={() => write(d.id, null)} />
                    ))}
                </div>}
            </div>
        </div>
    );
}
