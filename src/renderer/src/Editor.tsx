import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, indentOnInput, StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { java } from "@codemirror/legacy-modes/mode/clike";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";

function language(path: string): Extension {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "yml" || ext === "yaml") return yaml();
    if (ext === "json" || ext === "json5") return json();
    if (ext === "properties") return StreamLanguage.define(properties);
    if (ext === "java") return StreamLanguage.define(java);
    if (ext === "toml") return StreamLanguage.define(toml);
    return [];
}

/** A CodeMirror editor for one file. Ctrl+S calls [onSave]; [onChange] reports the text and whether it differs from what was last saved. */
export function Editor({ path, text, base = text, revision = 0, line, readOnly = false, onSave, onChange }: {
    path: string;
    /** What to show when the editor is created. Later changes to it are ignored; bump [revision] to reload. */
    text: string;
    /** What counts as saved, when it differs from [text]: a tab restored with unsaved edits. */
    base?: string;
    /** Recreates the editor from [text] when it changes. */
    revision?: number;
    /** Scrolls to and selects this 1-based line. */
    line?: number;
    readOnly?: boolean;
    onSave: (text: string) => void;
    onChange: (text: string, dirty: boolean) => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const baseRef = useRef(base);
    baseRef.current = base;
    const textRef = useRef(text);
    textRef.current = text;
    // Held in refs so the editor, created once per file, always calls the latest handlers.
    const save = useRef(onSave);
    const change = useRef(onChange);
    save.current = onSave;
    change.current = onChange;

    useEffect(() => {
        let saved = baseRef.current;
        const editor = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: textRef.current,
                extensions: [
                    lineNumbers(),
                    highlightActiveLineGutter(),
                    highlightActiveLine(),
                    drawSelection(),
                    history(),
                    indentOnInput(),
                    bracketMatching(),
                    search({ top: true }),
                    EditorState.readOnly.of(readOnly),
                    keymap.of([
                        // Find and replace share one panel; Ctrl+H is the habit from other editors for opening it.
                        { key: "Mod-h", preventDefault: true, run: openSearchPanel },
                        ...searchKeymap,
                        {
                            key: "Mod-s",
                            preventDefault: true,
                            run: (v) => {
                                saved = v.state.doc.toString();
                                save.current(saved);
                                change.current(saved, false);
                                return true;
                            },
                        },
                        indentWithTab,
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    oneDark,
                    language(path),
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return;
                        const doc = u.state.doc.toString();
                        change.current(doc, doc !== saved);
                    }),
                ],
            }),
        });
        view.current = editor;
        editor.focus();
        return () => {
            editor.destroy();
            view.current = null;
        };
    }, [path, revision, readOnly]);

    // Jumps to a search result. Separate from creation so the same file can be revealed at another line.
    useEffect(() => {
        const editor = view.current;
        if (!editor || !line) return;
        const target = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
        editor.dispatch({ selection: { anchor: target.from, head: target.to }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    }, [line, path, revision]);

    return <div className="editor" ref={host} />;
}
