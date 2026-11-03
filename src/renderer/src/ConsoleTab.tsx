import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isErrorLine, stackFrame } from "@shared/console";
import type { ConsoleLine, ServerView } from "@shared/types";
import { usePersisted } from "./persist";

const api = window.testbench;
const MAX_LINES = 4000;

type Level = "all" | "warn" | "error";

function tone(line: ConsoleLine): string {
    if (line.stream === "app") return "cmd";
    if (isErrorLine(line.text, line.stream)) return "err";
    if (/\bWARN(ING)?\b/.test(line.text)) return "warn";
    return "";
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text of [line] with each match of [pattern] wrapped in a mark. */
function highlighted(text: string, pattern: RegExp | null) {
    if (!pattern) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match[0] === "") continue;
        const at = match.index ?? 0;
        if (at > last) out.push(text.slice(last, at));
        out.push(<mark key={at}>{match[0]}</mark>);
        last = at + match[0].length;
    }
    if (last === 0) return text;
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/;

/**
 * A line with its stack frame or first link made clickable. Frames open the source in the Lattice checkout;
 * links open in the browser, because the main process sends every new window there.
 */
function linked(text: string) {
    const frame = stackFrame(text);
    if (frame) {
        return [
            text.slice(0, frame.start),
            <span key="f" className="link" title={`${frame.className} (${frame.file}:${frame.line})`}>{text.slice(frame.start, frame.end)}</span>,
            text.slice(frame.end),
        ];
    }
    const url = URL_PATTERN.exec(text);
    if (url) {
        const end = url.index + url[0].length;
        return [text.slice(0, url.index), <a key="u" className="link" href={url[0]} target="_blank" rel="noreferrer">{url[0]}</a>, text.slice(end)];
    }
    return text;
}

export function ConsoleTab({ server }: { server: ServerView }) {
    const [lines, setLines] = useState<ConsoleLine[]>([]);
    const [process, setProcess] = usePersisted<string>(`${server.id}:process`, "all");
    const [input, setInput] = useState("");
    const [sent, setSent] = useState<string[]>([]);
    const [cursor, setCursor] = useState(-1);
    const [find, setFind] = useState("");
    const [regex, setRegex] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [level, setLevel] = usePersisted<Level>("consoleLevel", "all");
    const [copied, setCopied] = useState(false);
    const [hint, setHint] = useState<string | null>(null);
    /** Completions for the word being typed, from the server's own help, and which one Tab is on. */
    const [suggest, setSuggest] = useState<{ words: string[]; at: number } | null>(null);
    const box = useRef<HTMLDivElement>(null);
    const findBox = useRef<HTMLInputElement>(null);
    const pinned = useRef(true);

    useEffect(() => {
        let live = true;
        void api.history(server.id).then((h) => live && setLines(h));
        const off = api.onConsole((line) => {
            if (line.serverId !== server.id) return;
            setLines((prev) => {
                const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
                next.push(line);
                return next;
            });
        });
        return () => {
            live = false;
            off();
        };
    }, [server.id]);

    // An invalid regular expression is the person still typing it: show it as such rather than matching nothing.
    const pattern = useMemo(() => {
        if (!find) return { regex: null, invalid: false };
        try {
            return { regex: new RegExp(regex ? find : escape(find), caseSensitive ? "g" : "gi"), invalid: false };
        } catch {
            return { regex: null, invalid: true };
        }
    }, [find, regex, caseSensitive]);

    const procs = server.processes.map((p) => p.name);
    const target = process === "all" ? (procs.includes("proxy") ? "proxy" : procs[0]) : process;

    const shown = useMemo(() => lines.filter((line) => {
        if (process !== "all" && line.process !== process && line.process !== "app") return false;
        if (level !== "all") {
            const t = tone(line);
            if (level === "error" ? t !== "err" : t !== "err" && t !== "warn") return false;
        }
        if (pattern.regex) {
            pattern.regex.lastIndex = 0;
            if (!pattern.regex.test(line.text)) return false;
        }
        return true;
    }), [lines, process, level, pattern]);

    // Follows new output only while the view is at the bottom, so scrolling up to read is not undone.
    useLayoutEffect(() => {
        if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [shown]);

    const submit = () => {
        const line = input.trim();
        if (!line || !target) return;
        void api.command(server.id, target, line.replace(/^\//, ""));
        setSent((prev) => [line, ...prev.filter((l) => l !== line)].slice(0, 50));
        setInput("");
        setCursor(-1);
        pinned.current = true;
    };

    /** The input with its last word replaced by [word]; a single match also gets the space after it. */
    const withWord = (word: string, done: boolean) => {
        const cut = input.lastIndexOf(" ");
        return `${input.slice(0, cut + 1)}${word}${done ? " " : ""}`;
    };

    const complete = async () => {
        if (suggest && suggest.words.length > 1) {
            const at = (suggest.at + 1) % suggest.words.length;
            setSuggest({ ...suggest, at });
            setInput(withWord(suggest.words[at], false));
            return;
        }
        if (!target) return;
        const words = await api.completions(server.id, target, input).catch(() => []);
        if (words.length === 0) {
            setHint("No completions: they come from the game server's help, so a proxy has none.");
            return;
        }
        if (words.length === 1) {
            setInput(withWord(words[0], true));
            setSuggest(null);
        } else {
            setSuggest({ words, at: 0 });
            setInput(withWord(words[0], false));
        }
    };

    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Tab") {
            e.preventDefault();
            void complete();
            return;
        }
        if (e.key !== "Shift") setSuggest(null);
        if (e.key === "Enter") submit();
        else if (e.key === "ArrowUp" && sent.length > 0) {
            e.preventDefault();
            const next = Math.min(cursor + 1, sent.length - 1);
            setCursor(next);
            setInput(sent[next]);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const next = cursor - 1;
            setCursor(Math.max(next, -1));
            setInput(next >= 0 ? sent[next] : "");
        }
    };

    const asText = () => shown.map((l) => (procs.length > 1 && process === "all" ? `[${l.process}] ${l.text}` : l.text)).join("\n");

    const copy = () => {
        void navigator.clipboard.writeText(asText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };

    const save = () => {
        const url = URL.createObjectURL(new Blob([asText()], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${server.id}-console.log`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const filtering = find !== "" || level !== "all";


    /** Scrolls to the next error line below the view, wrapping round to the first. */
    const nextError = () => {
        const el = box.current;
        if (!el) return;
        const errors = [...el.querySelectorAll<HTMLElement>(":scope > .err")];
        if (errors.length === 0) {
            setHint("No errors in the lines shown.");
            return;
        }
        const target = errors.find((e) => e.offsetTop > el.scrollTop + 8) ?? errors[0];
        pinned.current = false;
        el.scrollTop = target.offsetTop - 8;
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 900);
    };

    return (
        <div
            style={{ display: "contents" }}
            onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
                    e.preventDefault();
                    findBox.current?.focus();
                    findBox.current?.select();
                }
            }}
        >
            <div className="console-tools">
                {procs.length > 1 && (
                    <div className="proc-tabs" style={{ marginBottom: 0 }}>
                        {["all", ...procs].map((p) => {
                            const state = server.processes.find((x) => x.name === p)?.state;
                            return (
                                <button key={p} className={`btn sm ${process === p ? "" : "ghost"}`} onClick={() => setProcess(p)}>
                                    {state && <span className={`dot ${state}`} />} {p === "all" ? "All" : p}
                                </button>
                            );
                        })}
                    </div>
                )}
                <span className="grow" />
                <input
                    ref={findBox}
                    className={`input sm find ${pattern.invalid ? "bad" : ""}`}
                    placeholder="Filter (Ctrl+F)"
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setFind("")}
                    spellCheck={false}
                />
                <button className={`btn sm ${caseSensitive ? "" : "ghost"}`} title="Match case" onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
                <button className={`btn sm ${regex ? "" : "ghost"}`} title="Regular expression" onClick={() => setRegex(!regex)}>.*</button>
                <select className="input sm" value={level} onChange={(e) => setLevel(e.target.value as Level)} title="Show only lines at or above this level">
                    <option value="all">All levels</option>
                    <option value="warn">Warnings and errors</option>
                    <option value="error">Errors only</option>
                </select>
                <button className="btn sm ghost" onClick={nextError} title="Scroll to the next error">Next error</button>
                <button className="btn sm ghost" onClick={copy} title="Copy the lines shown">{copied ? "Copied" : "Copy"}</button>
                <button className="btn sm ghost" onClick={save} title="Save the lines shown to a file">Save</button>
                <button className="btn sm ghost" onClick={() => setLines([])} title="Clear this view (the server is not affected)">Clear</button>
            </div>
            {hint && <div className="console-hint" onClick={() => setHint(null)}>{hint}</div>}
            <div
                className="console"
                ref={box}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
            >
                {shown.map((line, i) => (
                    <div key={i} className={tone(line)}>
                        {procs.length > 1 && process === "all" && <span className="tag">[{line.process}] </span>}
                        {pattern.regex ? highlighted(line.text, pattern.regex) : linked(line.text)}
                    </div>
                ))}
                {filtering && shown.length === 0 && <div className="tag">No lines match.</div>}
            </div>
            {suggest && suggest.words.length > 1 && (
                <div className="completions">
                    {suggest.words.map((w, i) => (
                        <button key={w} className={i === suggest.at ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); setInput(withWord(w, true)); setSuggest(null); }}>{w}</button>
                    ))}
                </div>
            )}
            <div className="console-input">
                <span>{target ?? ""} &gt;</span>
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={server.state === "running" || server.state === "starting" ? "Type a command (Tab completes)" : "Not running"}
                    disabled={!target}
                    spellCheck={false}
                />
            </div>
        </div>
    );
}
