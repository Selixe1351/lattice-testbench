import { latticeApi } from "./ext";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, SearchHit, SearchResult, ServerView } from "@shared/types";
import { DiffView } from "./DiffView";
import { Editor } from "./Editor";
import { confirm } from "./confirm";
import { Close, Diff, FileIcon, FilePlus, Folder, FolderPlus, Search, Upload } from "./icons";
import { usePersisted } from "./persist";
import { bytes } from "./time";

const api = window.testbench;

interface Tab {
    /** Identifies the file: a server path, or "jar!/entry" for something inside a jar. */
    path: string;
    /** What the editor takes its language from; a decompiled class is shown as .java. */
    name: string;
    readOnly: boolean;
    /** The text as edited so far. */
    current: string;
    /** The text as last saved or loaded; [current] differing from it is what makes a tab dirty. */
    base: string;
    /** Bumped to recreate the editor from [current]. */
    revision: number;
    /** Set for a picture: its data URL, shown instead of the editor. */
    image?: string;
}

interface Menu {
    x: number;
    y: number;
    entry: FileEntry;
}

const isJar = (name: string) => name.toLowerCase().endsWith(".jar");
const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name);
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const dirty = (tab: Tab) => !tab.readOnly && tab.current !== tab.base;
const clean = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

let tokens = 0;

/** Reads a server file into a tab: as text for the editor, or as a picture. */
const fetchTab = (serverId: string, path: string): Promise<Tab> =>
    isImage(path)
        ? api.readImage(serverId, path).then((image) => ({ path, name: path, readOnly: false, current: "", base: "", revision: 0, image }))
        : api.readFile(serverId, path).then((text) => ({ path, name: path, readOnly: false, current: text, base: text, revision: 0 }));

export function FilesTab({ server }: { server: ServerView }) {
    const [dir, setDir] = useState("");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Set while inside a jar: its path in the server folder, and the folder shown within it.
    const [jar, setJar] = useState<{ path: string; dir: string } | null>(null);
    // The jar entry being decompiled, if any.
    const [pending, setPending] = useState<{ name: string } | null>(null);
    const pendingToken = useRef<string | null>(null);

    const [savedDir, rememberDir] = usePersisted(`${server.id}:dir`, "");
    const [savedFile, rememberFile] = usePersisted<string | null>(`${server.id}:file`, null);
    const [savedTabs, rememberTabs] = usePersisted<string[]>(`${server.id}:tabs`, []);
    const [reloadOnSave, setReloadOnSave] = usePersisted("reloadOnSave", true);

    // Diff of the active tab: against what is saved, or against what the file held when first opened here.
    const [diffing, setDiffing] = useState(false);
    const [diffAgainst, setDiffAgainst] = useState<"saved" | "original">("saved");
    const [original, setOriginal] = useState<string | null>(null);

    const [panel, setPanel] = useState<"files" | "search">("files");
    const [query, setQuery] = useState("");
    const [regex, setRegex] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [result, setResult] = useState<SearchResult | null>(null);
    const [searching, setSearching] = useState(false);
    const searchToken = useRef<string | null>(null);
    const searchBox = useRef<HTMLInputElement>(null);
    const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null);

    const [menu, setMenu] = useState<Menu | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [creating, setCreating] = useState<"file" | "folder" | null>(null);
    const [draft, setDraft] = useState("");
    const [dropping, setDropping] = useState(false);

    const tab = tabs.find((t) => t.path === active) ?? null;

    const patch = (path: string, change: Partial<Tab>) => setTabs((all) => all.map((t) => (t.path === path ? { ...t, ...change } : t)));

    // ------------------------------------------------------------ navigation --

    const load = useCallback((path: string): Promise<boolean> => {
        return api.listFiles(server.id, path).then(
            (list) => {
                setEntries(list);
                setDir(path);
                rememberDir(path);
                setError(null);
                return true;
            },
            (e: Error) => {
                setError(clean(e.message));
                return false;
            },
        );
    }, [server.id, rememberDir]);

    const loadJar = useCallback((path: string, inner: string) => {
        api.listJar(server.id, path, inner).then(
            (list) => {
                setEntries(list);
                setJar({ path, dir: inner });
                setError(null);
            },
            (e: Error) => setError(clean(e.message)),
        );
    }, [server.id]);

    const refresh = () => (jar ? loadJar(jar.path, jar.dir) : void load(dir));

    const cancelPending = useCallback(() => {
        if (pendingToken.current) void api.cancelJar(pendingToken.current);
        pendingToken.current = null;
        setPending(null);
    }, []);

    const cancelSearch = useCallback(() => {
        if (searchToken.current) void api.cancelSearch(searchToken.current);
        searchToken.current = null;
        setSearching(false);
    }, []);

    // Leaving the tab (or switching server) abandons whatever is still running instead of letting it carry on unseen.
    useEffect(() => () => {
        if (pendingToken.current) void api.cancelJar(pendingToken.current);
        if (searchToken.current) void api.cancelSearch(searchToken.current);
    }, [server.id]);

    // ----------------------------------------------------------------- tabs --

    const openTab = useCallback((next: Tab, at?: number) => {
        setTabs((all) => (all.some((t) => t.path === next.path) ? all.map((t) => (t.path === next.path ? { ...t, ...next, current: t.current, base: t.base } : t)) : [...all, next]));
        setActive(next.path);
        setDiffing(false);
        setStatus(null);
        setError(null);
        if (at) setReveal({ path: next.path, line: at });
    }, []);

    const read = useCallback((path: string, at?: number) => {
        // Already open: switch to it and keep the edits in it.
        if (tabs.some((t) => t.path === path)) {
            setActive(path);
            setDiffing(false);
            if (at) setReveal({ path, line: at });
            return;
        }
        fetchTab(server.id, path).then(
            (next) => openTab(next, at),
            (e: Error) => setError(clean(e.message)),
        );
        // Tabs are read at call time through the closure; openTab merges, so a racing duplicate is harmless.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server.id, tabs, openTab]);

    // Restores the folder and the open files from last time. A folder that no longer exists falls back to the root.
    useEffect(() => {
        void load(savedDir).then((ok) => {
            if (!ok && savedDir) void load("");
        });
        const wanted = savedTabs.length > 0 ? savedTabs : savedFile ? [savedFile] : [];
        void Promise.all(wanted.map((path) => fetchTab(server.id, path).catch(() => null))).then((loaded) => {
            const found = loaded.flatMap((l) => (l ? [l] : []));
            if (found.length === 0) return;
            setTabs(found);
            setActive(found.find((f) => f.path === savedFile)?.path ?? found[0].path);
        });
        // Runs once per server: the saved values are only the starting point.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server.id]);

    // What to restore next time: the real files that are open, not entries of a jar.
    useEffect(() => {
        rememberTabs(tabs.filter((t) => !t.readOnly).map((t) => t.path));
        rememberFile(tab && !tab.readOnly ? tab.path : null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabs, active]);

    const closeTab = async (path: string) => {
        const closing = tabs.find((t) => t.path === path);
        if (closing && dirty(closing) && !(await confirm(`Discard unsaved changes to ${leaf(path)}?`, { action: "Discard" }))) return;
        const index = tabs.findIndex((t) => t.path === path);
        const rest = tabs.filter((t) => t.path !== path);
        setTabs(rest);
        if (active === path) setActive(rest[Math.min(index, rest.length - 1)]?.path ?? null);
        setDiffing(false);
    };

    // ------------------------------------------------------------- jar mode --

    /** Back out to a folder of the server, dropping whatever was open from the jar. */
    const leaveJar = (to: string) => {
        cancelPending();
        setTabs((all) => all.filter((t) => !t.readOnly));
        if (tab?.readOnly) setActive(tabs.find((t) => !t.readOnly)?.path ?? null);
        setJar(null);
        void load(to);
    };

    const openJarEntry = (entry: FileEntry) => {
        if (!jar) return;
        const id = `${jar.path}!/${entry.path}`;
        if (tabs.some((t) => t.path === id)) {
            setActive(id);
            return;
        }
        cancelPending();
        const token = `jar-${++tokens}`;
        pendingToken.current = token;
        setPending({ name: entry.name });
        setError(null);
        api.openJarEntry(server.id, jar.path, entry.path, token).then(
            (text) => {
                if (pendingToken.current !== token) return;
                pendingToken.current = null;
                setPending(null);
                openTab({ path: id, name: entry.name.replace(/\.class$/, ".java"), readOnly: true, current: text, base: text, revision: 0 });
            },
            (e: Error) => {
                // A superseded or cancelled request has nothing to report.
                if (pendingToken.current !== token) return;
                pendingToken.current = null;
                setPending(null);
                setError(clean(e.message));
            },
        );
    };

    const openEntry = (entry: FileEntry) => {
        setMenu(null);
        if (jar) {
            if (entry.directory) loadJar(jar.path, entry.path);
            else openJarEntry(entry);
            return;
        }
        if (entry.directory) {
            void load(entry.path);
            return;
        }
        if (isJar(entry.name)) {
            loadJar(entry.path, "");
            return;
        }
        read(entry.path);
    };

    // ---------------------------------------------------------------- saving --

    const save = async (path: string, text: string, fromButton = false) => {
        const target = tabs.find((t) => t.path === path);
        if (!target || target.readOnly || target.image) return;
        try {
            await api.writeFile(server.id, path, text);
            // The Save button sits outside the editor, so the editor is recreated to learn it is clean.
            patch(path, { current: text, base: text, ...(fromButton ? { revision: target.revision + 1 } : {}) });
            setError(null);
            let note = `Saved ${new Date().toLocaleTimeString()}`;
            if (reloadOnSave) {
                const reloaded = await latticeApi.reloadConfig(server.id, path).catch(() => null);
                if (reloaded) note += ` - reloaded on ${reloaded}`;
            }
            setStatus(note);
        } catch (e) {
            setError(clean((e as Error).message));
        }
    };

    // ------------------------------------------------------- file operations --

    const run = async (action: () => Promise<unknown>) => {
        try {
            await action();
            setError(null);
            refresh();
        } catch (e) {
            setError(clean((e as Error).message));
        }
    };

    const startCreate = (kind: "file" | "folder") => {
        setPanel("files");
        setCreating(kind);
        setRenaming(null);
        setDraft("");
    };

    const commitCreate = async () => {
        const name = draft.trim();
        const kind = creating;
        setCreating(null);
        if (!name || !kind) return;
        const path = dir ? `${dir}/${name}` : name;
        await run(() => api.createEntry(server.id, path, kind === "folder"));
        if (kind === "file") read(path);
    };

    const commitRename = async (entry: FileEntry) => {
        const name = draft.trim();
        setRenaming(null);
        if (!name || name === entry.name) return;
        const to = parent(entry.path) ? `${parent(entry.path)}/${name}` : name;
        if (tabs.some((t) => dirty(t) && (t.path === entry.path || t.path.startsWith(`${entry.path}/`)))) {
            setError("Save or close the open files in it before renaming.");
            return;
        }
        await run(async () => {
            await api.renameEntry(server.id, entry.path, to);
            // Open tabs follow the file to its new name.
            setTabs((all) => all.map((t) => (t.path === entry.path || t.path.startsWith(`${entry.path}/`) ? { ...t, path: to + t.path.slice(entry.path.length), name: to + t.path.slice(entry.path.length) } : t)));
            if (active && (active === entry.path || active.startsWith(`${entry.path}/`))) setActive(to + active.slice(entry.path.length));
        });
    };

    const remove = async (entry: FileEntry) => {
        setMenu(null);
        if (!(await confirm(`Delete ${entry.name}${entry.directory ? " and everything in it" : ""}? This cannot be undone.`))) return;
        await run(async () => {
            await api.deleteEntry(server.id, entry.path);
            const gone = (t: Tab) => t.path === entry.path || t.path.startsWith(`${entry.path}/`);
            setTabs((all) => all.filter((t) => !gone(t)));
            if (active && (active === entry.path || active.startsWith(`${entry.path}/`))) setActive(tabs.find((t) => !gone(t))?.path ?? null);
        });
    };

    const duplicate = async (entry: FileEntry) => {
        setMenu(null);
        await run(() => api.duplicateEntry(server.id, entry.path));
    };

    const drop = async (event: React.DragEvent) => {
        event.preventDefault();
        setDropping(false);
        if (jar) return;
        const sources = [...event.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
        if (sources.length > 0) await run(() => api.importFiles(server.id, dir, sources));
    };

    // ---------------------------------------------------------------- search --

    const runSearch = () => {
        cancelSearch();
        if (!query) {
            setResult(null);
            return;
        }
        const token = `search-${++tokens}`;
        searchToken.current = token;
        setSearching(true);
        setError(null);
        api.searchFiles(server.id, { query, regex, caseSensitive }, token).then(
            (found) => {
                if (searchToken.current !== token) return;
                searchToken.current = null;
                setSearching(false);
                setResult(found);
            },
            (e: Error) => {
                if (searchToken.current !== token) return;
                searchToken.current = null;
                setSearching(false);
                setResult(null);
                setError(clean(e.message));
            },
        );
    };

    const grouped = (hits: SearchHit[]): [string, SearchHit[]][] => {
        const map = new Map<string, SearchHit[]>();
        for (const hit of hits) map.set(hit.path, [...(map.get(hit.path) ?? []), hit]);
        return [...map.entries()];
    };

    const openSearch = () => {
        setPanel("search");
        setTimeout(() => searchBox.current?.focus(), 0);
    };

    // ------------------------------------------------------------------ diff --

    const toggleDiff = () => {
        if (diffing) {
            setDiffing(false);
            return;
        }
        if (!tab) return;
        setDiffing(true);
        void api.originalFile(server.id, tab.path).then(setOriginal);
    };

    const diffBefore = diffAgainst === "saved" ? tab?.base ?? "" : original ?? tab?.base ?? "";

    // ---------------------------------------------------------------- render --

    const parts = dir ? dir.split("/") : [];
    const jarParts = jar?.dir ? jar.dir.split("/") : [];
    const jarName = jar ? leaf(jar.path) : "";
    const up = () => {
        if (!jar) void load(parts.slice(0, -1).join("/"));
        else if (jarParts.length === 0) leaveJar(dir);
        else loadJar(jar.path, jarParts.slice(0, -1).join("/"));
    };
    const goDir = (to: string) => (jar ? leaveJar(to) : void load(to));
    const entryId = (entry: FileEntry) => (jar ? `${jar.path}!/${entry.path}` : entry.path);

    const nameCell = (entry: FileEntry) =>
        renaming === entry.path ? (
            <input
                className="input inline"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(entry);
                    else if (e.key === "Escape") setRenaming(null);
                }}
            />
        ) : (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
        );

    return (
        <div
            className="files"
            onClick={() => setMenu(null)}
            onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
                    e.preventDefault();
                    openSearch();
                }
            }}
        >
            <div
                className={`tree ${dropping ? "dropping" : ""}`}
                onDragOver={(e) => {
                    if (jar || panel !== "files") return;
                    e.preventDefault();
                    setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={(e) => void drop(e)}
            >
                <div className="tree-tools">
                    <button className={`btn sm ghost icon ${panel === "files" ? "on" : ""}`} title="Files" onClick={() => setPanel("files")}><Folder /></button>
                    <button className={`btn sm ghost icon ${panel === "search" ? "on" : ""}`} title="Search in files (Ctrl+Shift+F)" onClick={openSearch}><Search /></button>
                    <span className="grow" />
                    {panel === "files" && !jar && (
                        <>
                            <button className="btn sm ghost icon" title="New file" onClick={() => startCreate("file")}><FilePlus /></button>
                            <button className="btn sm ghost icon" title="New folder" onClick={() => startCreate("folder")}><FolderPlus /></button>
                            <span className="faint" title="Drop files here to add them"><Upload /></span>
                        </>
                    )}
                </div>

                {panel === "search" ? (
                    <div className="search-panel">
                        <div className="search-row">
                            <input
                                ref={searchBox}
                                className="input"
                                placeholder="Search all files"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                            />
                            <button className={`btn sm ${caseSensitive ? "" : "ghost"}`} title="Match case" onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
                            <button className={`btn sm ${regex ? "" : "ghost"}`} title="Regular expression" onClick={() => setRegex(!regex)}>.*</button>
                        </div>
                        <p className="faint sm" style={{ padding: "4px 8px" }}>
                            {searching ? (
                                <>Searching... <button className="link" onClick={cancelSearch}>Cancel</button></>
                            ) : result ? (
                                `${result.hits.length}${result.truncated ? "+" : ""} match${result.hits.length === 1 ? "" : "es"} in ${result.filesScanned} files`
                            ) : (
                                "Press Enter to search. World data and libraries are skipped."
                            )}
                        </p>
                        {result && grouped(result.hits).map(([path, hits]) => (
                            <div key={path} className="hit-group">
                                <div className="hit-file" title={path}>{path}</div>
                                {hits.map((hit, i) => (
                                    <div key={i} className="hit" onClick={() => read(hit.path, hit.line)}>
                                        <span className="no">{hit.line}</span>
                                        <span className="text">{hit.text}</span>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                ) : (
                    <>
                        <div className="crumbs">
                            <button onClick={() => goDir("")}>{server.id}</button>
                            {parts.map((part, i) => (
                                <span key={i}>
                                    / <button onClick={() => goDir(parts.slice(0, i + 1).join("/"))}>{part}</button>
                                </span>
                            ))}
                            {jar && (
                                <>
                                    <span>/ <button onClick={() => loadJar(jar.path, "")}>{jarName}</button></span>
                                    {jarParts.map((part, i) => (
                                        <span key={i}>
                                            / <button onClick={() => loadJar(jar.path, jarParts.slice(0, i + 1).join("/"))}>{part}</button>
                                        </span>
                                    ))}
                                </>
                            )}
                        </div>
                        {(jar || dir) && (
                            <div className="file dir" onClick={up}>
                                <Folder /> ..
                            </div>
                        )}
                        {creating && (
                            <div className="file">
                                {creating === "folder" ? <Folder /> : <FileIcon />}
                                <input
                                    className="input inline"
                                    autoFocus
                                    placeholder={creating === "folder" ? "folder name" : "file name"}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onBlur={() => setCreating(null)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") void commitCreate();
                                        else if (e.key === "Escape") setCreating(null);
                                    }}
                                />
                            </div>
                        )}
                        {entries.map((entry) => (
                            <div
                                key={entry.path}
                                className={`file ${entry.directory ? "dir" : ""} ${active === entryId(entry) ? "on" : ""}`}
                                onClick={() => renaming !== entry.path && openEntry(entry)}
                                onContextMenu={(e) => {
                                    if (jar) return;
                                    e.preventDefault();
                                    setMenu({ x: e.clientX, y: e.clientY, entry });
                                }}
                            >
                                {entry.directory ? <Folder /> : <FileIcon />}
                                {nameCell(entry)}
                                {!entry.directory && <span className="size">{bytes(entry.size)}</span>}
                            </div>
                        ))}
                        {entries.length === 0 && !creating && <p className="faint sm" style={{ padding: 8 }}>Empty folder.</p>}
                    </>
                )}
            </div>

            <div className="editor-pane">
                {tabs.length > 0 && (
                    <div className="file-tabs">
                        {tabs.map((t) => (
                            <div
                                key={t.path}
                                className={`ftab ${t.path === active ? "on" : ""}`}
                                title={t.path}
                                onClick={() => {
                                    setActive(t.path);
                                    setDiffing(false);
                                }}
                                onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
                            >
                                <span className="label">{leaf(t.name)}</span>
                                {dirty(t) ? <span className="dot-dirty" /> : null}
                                <button className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} title="Close"><Close /></button>
                            </div>
                        ))}
                    </div>
                )}
                {pending && (
                    <div className="editor-bar">
                        <span className="path">Decompiling {pending.name}...</span>
                        <button className="btn sm" onClick={cancelPending}>Cancel</button>
                    </div>
                )}
                {tab ? (
                    <>
                        <div className="editor-bar">
                            <span className="path">{tab.path}{dirty(tab) ? " *" : ""}</span>
                            {tab.readOnly && <span className="badge">read only</span>}
                            {status && !dirty(tab) && <span className="faint sm">{status}</span>}
                            {tab.image && (
                                <button
                                    className="btn sm ghost"
                                    onClick={() => fetchTab(server.id, tab.path).then(
                                        (next) => patch(tab.path, { image: next.image }),
                                        (e: Error) => setError(clean(e.message)),
                                    )}
                                >
                                    Reload
                                </button>
                            )}
                            {!tab.readOnly && !tab.image && (
                                <>
                                    <label className="faint sm check" title="After saving a Lattice config file, send /lattice reload config to the server">
                                        <input type="checkbox" checked={reloadOnSave} onChange={(e) => setReloadOnSave(e.target.checked)} /> reload on save
                                    </label>
                                    <button className={`btn sm ${diffing ? "" : "ghost"}`} onClick={toggleDiff} title="Show what changed"><Diff /> Diff</button>
                                    <button
                                        className="btn sm ghost"
                                        onClick={async () => {
                                            if (dirty(tab) && !(await confirm("Discard unsaved changes and reload from disk?", { action: "Reload" }))) return;
                                            api.readFile(server.id, tab.path).then(
                                                (text) => patch(tab.path, { current: text, base: text, revision: tab.revision + 1 }),
                                                (e: Error) => setError(clean(e.message)),
                                            );
                                        }}
                                    >
                                        Reload
                                    </button>
                                    <button className="btn sm primary" disabled={!dirty(tab)} onClick={() => void save(tab.path, tab.current, true)}>Save</button>
                                </>
                            )}
                        </div>
                        {diffing && (
                            <div className="editor-bar sub">
                                <span className="faint sm">Comparing the current text with</span>
                                <select className="input sm" value={diffAgainst} onChange={(e) => setDiffAgainst(e.target.value as "saved" | "original")}>
                                    <option value="saved">what is saved</option>
                                    <option value="original" disabled={original === null}>what it was when first opened</option>
                                </select>
                            </div>
                        )}
                        {error && <div className="error-box" style={{ margin: 10 }}>{error}</div>}
                        {tab.image && <ImageView key={tab.path} src={tab.image} />}
                        {diffing && <DiffView before={diffBefore} after={tab.current} />}
                        {/* Kept mounted while the diff shows, so the cursor, undo history and unsaved text are still there on return. */}
                        {!tab.image && (
                            <div style={{ display: diffing ? "none" : "contents" }}>
                                <Editor
                                    key={tab.path}
                                    path={tab.name}
                                    text={tab.current}
                                    base={tab.base}
                                    revision={tab.revision}
                                    line={reveal?.path === tab.path ? reveal.line : undefined}
                                    readOnly={tab.readOnly}
                                    onSave={(text) => void save(tab.path, text)}
                                    onChange={(text) => patch(tab.path, { current: text })}
                                />
                            </div>
                        )}
                    </>
                ) : (
                    <div className="empty">
                        <FileIcon />
                        <p>Pick a file to edit. Ctrl+S saves, Ctrl+F finds, Ctrl+H replaces, Ctrl+Shift+F searches every file.</p>
                        <p className="faint sm">Open a jar to browse it; classes are decompiled when you open them.</p>
                        <p className="faint sm">Lattice reloads its config files by itself; most other plugins need a restart.</p>
                        {error && <div className="error-box">{error}</div>}
                    </div>
                )}
            </div>

            {menu && (
                <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { setRenaming(menu.entry.path); setDraft(menu.entry.name); setMenu(null); }}>Rename</button>
                    <button onClick={() => void duplicate(menu.entry)}>Duplicate</button>
                    <button onClick={() => { void navigator.clipboard.writeText(menu.entry.path); setMenu(null); }}>Copy path</button>
                    <button className="danger" onClick={() => void remove(menu.entry)}>Delete</button>
                </div>
            )}
        </div>
    );
}

/** A picture on a checkerboard, so transparency shows. Small ones (item textures) are blown up without smoothing. */
function ImageView({ src }: { src: string }) {
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const scale = size ? Math.max(1, Math.floor(256 / Math.max(size.width, size.height))) : 1;
    return (
        <div className="image-view">
            <img
                src={src}
                alt=""
                className={scale > 1 ? "pixelated" : undefined}
                style={size ? { width: size.width * scale } : undefined}
                onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            />
            {size && <span className="faint sm">{size.width} x {size.height}{scale > 1 ? `, shown at ${scale}x` : ""}</span>}
        </div>
    );
}
