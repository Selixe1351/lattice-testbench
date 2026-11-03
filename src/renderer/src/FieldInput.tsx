import { useState } from "react";
import type { ExtensionValue, Field } from "@shared/extensions";

const api = window.testbench;

const name = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A list of files picked from this PC: an Add button, and the picked ones as chips under it. */
export function FileList({ label, hint, files, onChange, extensions }: { label: string; hint?: string; files: string[]; onChange: (files: string[]) => void; extensions?: string[] }) {
    const add = async () => {
        const jars = !extensions || extensions.includes("jar");
        const picked = jars ? await api.pickJars(`Pick ${label.toLowerCase()}`) : [await api.pickFile(`Pick ${label.toLowerCase()}`, extensions)].filter((p): p is string => Boolean(p));
        onChange([...new Set([...files, ...picked])]);
    };
    return (
        <div className="extras-item">
            <div className="extras-row" title={hint}>
                <span className="extras-label">{label}</span>
                <span className="faint sm">{files.length === 0 ? "None" : `${files.length} file${files.length === 1 ? "" : "s"}`}</span>
                <button className="btn sm ghost extras-add" onClick={() => void add()}>Add</button>
            </div>
            {files.length > 0 && (
                <div className="jar-chips">
                    {files.map((file) => (
                        <span key={file} className="jar-chip" title={file}>
                            <span className="mono">{name(file)}</span>
                            <button aria-label={`Remove ${name(file)}`} onClick={() => onChange(files.filter((f) => f !== file))}>×</button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * One setting or deploy option, drawn from its declaration. This is how an extension gets a form without shipping
 * any UI. A secret is never sent to the window: [secretSet] says one is stored, and leaving the box empty keeps it.
 */
export function FieldInput({ field, value, secretSet, onChange }: { field: Field; value: ExtensionValue | undefined; secretSet?: boolean; onChange: (value: ExtensionValue) => void }) {
    const [reveal, setReveal] = useState(false);
    const label = <span>{field.label}</span>;
    const hint = field.hint ? <span className="hint">{field.hint}</span> : null;

    if (field.type === "boolean") {
        return (
            <label className="check" style={{ marginBottom: 12 }}>
                <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
                {field.label}
                {field.hint && <span className="faint sm">{field.hint}</span>}
            </label>
        );
    }
    if (field.type === "files") {
        return <FileList label={field.label} hint={field.hint} files={Array.isArray(value) ? value : []} onChange={onChange} extensions={field.extensions} />;
    }
    if (field.type === "select") {
        return (
            <label className="field">
                {label}
                <select className="input" value={String(value ?? field.default ?? "")} onChange={(e) => onChange(e.target.value)}>
                    {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {hint}
            </label>
        );
    }
    if (field.type === "number") {
        return (
            <label className="field">
                {label}
                <input className="input" type="number" value={value === undefined ? "" : Number(value)} onChange={(e) => onChange(Number(e.target.value))} placeholder={field.placeholder} />
                {hint}
            </label>
        );
    }
    if (field.type === "secret") {
        return (
            <label className="field">
                {label}
                <div className="input-row">
                    <input
                        className="input mono"
                        type={reveal ? "text" : "password"}
                        value={typeof value === "string" ? value : ""}
                        onChange={(e) => onChange(e.target.value.trim())}
                        placeholder={secretSet ? "Saved. Type to replace." : field.placeholder}
                    />
                    <button className="btn" type="button" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
                </div>
                {hint}
            </label>
        );
    }
    return (
        <label className="field">
            {label}
            <div className="input-row">
                <input className="input mono" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />
                {field.type === "path" && (
                    <button className="btn" type="button" onClick={async () => { const p = await api.pickFile(field.label, field.extensions); if (p) onChange(p); }}>Browse</button>
                )}
            </div>
            {hint}
        </label>
    );
}
