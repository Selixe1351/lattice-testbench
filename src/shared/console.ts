/** Reading console output: shared by the main process (counting errors, players) and the console tab (colour, links). */

/** An error line, as the console colours it. Stack frames under an error are not errors themselves. */
export function isErrorLine(text: string, stream: "out" | "err" | "app"): boolean {
    if (stream === "app") return false;
    return stream === "err" || /\b(ERROR|SEVERE)\b/.test(text);
}

/** One frame of a JVM stack trace: `at net.example.Foo$Bar.run(Foo.kt:42)`. */
export interface StackFrame {
    className: string;
    file: string;
    line: number;
    /** Where the clickable part starts and ends in the line. */
    start: number;
    end: number;
}

export function stackFrame(text: string): StackFrame | null {
    const match = /\bat (?:[\w.-]+\/\/)?([\w$.]+)\.[\w$<>-]+\(([\w$-]+\.(?:kt|java)):(\d+)\)/.exec(text);
    if (!match) return null;
    const start = match.index + 3;
    return { className: match[1], file: match[2], line: Number(match[3]), start, end: match.index + match[0].length };
}

/** spark's viewer links, e.g. https://spark.lucko.me/abc123. */
export const SPARK_LINK = /https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/;

/**
 * A player arriving or leaving, as the entrance prints it:
 *   Paper     Steve joined the game / Steve left the game
 *   Velocity  [connected player] Steve (/1.2.3.4:5678) has connected / has disconnected
 */
export function playerEvent(text: string): { name: string; joined: boolean } | null {
    const velocity = /\[connected player\] (\w{1,16}) \([^)]*\) has (connected|disconnected)/.exec(text);
    if (velocity) return { name: velocity[1], joined: velocity[2] === "connected" };
    const paper = /:\s(\w{1,16}) (joined|left) the game\s*$/.exec(text);
    if (paper) return { name: paper[1], joined: paper[2] === "joined" };
    return null;
}

/** The text of a log line without its "[12:00:00 INFO]: " (and Velocity's " [plugin]") prefix. */
export function logText(text: string): string {
    return text.replace(/^\[\d\d:\d\d:\d\d [A-Z]+\](?: \[[^\]]+\])?:\s?/, "");
}
