import type { ServerView } from "@shared/types";
import { Grid, Trash } from "./icons";

const api = window.testbench;

/** One verdict per server: did it start, and did every module enable. */
function verdict(server: ServerView): { text: string; tone: "ok" | "bad" | "" } {
    if (server.error || server.state === "failed") return { text: "Failed", tone: "bad" };
    const statuses = server.modules.map((m) => server.moduleStatus[m]);
    if (statuses.includes("failed")) return { text: "Module failed", tone: "bad" };
    if (server.state !== "running") return { text: server.state === "preparing" ? "Preparing" : "Starting", tone: "" };
    if (statuses.some((s) => s === undefined)) return { text: "Running, modules not all loaded", tone: "" };
    return { text: server.errors > 0 ? "Running, with errors" : "Passed", tone: server.errors > 0 ? "" : "ok" };
}

/** The result of one version matrix run: every cell, and what Lattice said about each module in it. */
export function MatrixPage({ servers, onOpen }: { servers: ServerView[]; onOpen: (id: string) => void }) {
    const modules = [...new Set(servers.flatMap((s) => s.modules))].sort();
    const passed = servers.filter((s) => verdict(s).tone === "ok").length;

    return (
        <div className="matrix-page">
            <div className="server-head">
                <div className="title">
                    <h1><Grid /> Version matrix</h1>
                    <div className="meta">
                        <span>{passed} of {servers.length} passed</span>
                        <span className="faint">A pass is a server that started with every module enabled and no error lines.</span>
                    </div>
                </div>
                <button className="btn danger" onClick={() => { for (const s of servers) void api.destroy(s.id); }}>
                    <Trash /> Delete all
                </button>
            </div>
            <div className="card" style={{ margin: "0 32px" }}>
                <table className="matrix-table">
                    <thead>
                        <tr>
                            <th>Server</th>
                            <th>Result</th>
                            <th>Errors</th>
                            {modules.map((m) => <th key={m}>{m}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {servers.map((s) => {
                            const v = verdict(s);
                            return (
                                <tr key={s.id} className="clickable" onClick={() => onOpen(s.id)} title="Open this server">
                                    <td><span className={`dot ${s.state}`} /> {s.label}</td>
                                    <td><span className={`badge ${v.tone}`}>{v.text}</span></td>
                                    <td className={s.errors > 0 ? "bad-text" : "faint"}>{s.errors}</td>
                                    {modules.map((m) => {
                                        const status = s.moduleStatus[m];
                                        const text = !s.modules.includes(m) ? "n/a" : status === "enabled" ? "enabled" : status === "failed" ? "failed" : "...";
                                        return <td key={m} className={status === "failed" ? "bad-text" : status === "enabled" ? "ok-text" : "faint"}>{text}</td>;
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
