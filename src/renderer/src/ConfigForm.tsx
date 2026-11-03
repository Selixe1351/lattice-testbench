import { useEffect, useState } from "react";
import { latticeApi } from "./ext";
import { isMap, isScalar, isSeq, type Document, type Node, type Pair, parseDocument, Scalar, type YAMLMap, type YAMLSeq } from "yaml";

const api = window.testbench;

/**
 * A module's config file as a form. Lattice writes each file from the module's settings class with every
 * @Comment above its key, so the file itself carries the schema: types come from the values, help text from
 * the comments. Edits change the parsed document in place, so saving keeps comments and order as written.
 */

/**
 * The help for a key: the comment block right above it. A block separated from the key by a blank line is
 * something else (Lattice's "Generated from..." header lands on the first key that way), so only the last
 * paragraph counts.
 */
const text = (comment: string | null | undefined) => {
    const lines = (comment ?? "").split("\n").map((l) => l.trim());
    const lastBlank = lines.lastIndexOf("");
    return lines.slice(lastBlank + 1).filter(Boolean).join(" ");
};

/** #RGB or #RRGGBB: what Lattice themes and MiniMessage colours are written as. */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The picker only takes #rrggbb, so #abc becomes #aabbcc. */
const longHex = (hex: string) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex).toLowerCase();

/** The picker answers in lower case; keep the file's own style when it was upper case. */
const matchCase = (picked: string, was: string) => (was === was.toUpperCase() ? picked.toUpperCase() : picked);

function Field({ pair, help, onChange }: { pair: Pair; help: string; onChange: () => void }) {
    const key = String((pair.key as Scalar).value);
    const value = pair.value as Node | null;

    if (isMap(value)) {
        return (
            <fieldset className="config-group">
                <legend>{key}</legend>
                {help && <p className="hint">{help}</p>}
                <Fields map={value} onChange={onChange} />
            </fieldset>
        );
    }

    let input: React.ReactNode;
    if (isScalar(value) && typeof value.value === "boolean") {
        input = (
            <label className="check">
                <input type="checkbox" checked={value.value} onChange={(e) => { value.value = e.target.checked; onChange(); }} />
                {value.value ? "on" : "off"}
            </label>
        );
    } else if (isScalar(value) && typeof value.value === "number") {
        input = <input className="input mono" type="number" value={String(value.value)} onChange={(e) => { value.value = Number(e.target.value); onChange(); }} />;
    } else if (isScalar(value) && typeof value.value === "string" && HEX.test(value.value.trim())) {
        // A colour: its swatch opens the system picker (with the wheel), and the hex stays typeable beside it.
        const scalar = value;
        const hex = String(scalar.value).trim();
        input = (
            <div className="color-field">
                <label className="swatch" style={{ background: hex }} title="Pick a colour">
                    <input type="color" value={longHex(hex)} onChange={(e) => { scalar.value = matchCase(e.target.value, hex); onChange(); }} />
                </label>
                <input className="input mono" value={String(scalar.value)} onChange={(e) => { scalar.value = e.target.value; onChange(); }} />
            </div>
        );
    } else if (isScalar(value) || value === null) {
        const scalar = value as Scalar | null;
        input = (
            <input
                className="input mono"
                value={scalar?.value === null || scalar?.value === undefined ? "" : String(scalar.value)}
                onChange={(e) => {
                    if (scalar) scalar.value = e.target.value;
                    else pair.value = e.target.value;
                    onChange();
                }}
            />
        );
    } else if (isSeq(value) && value.items.every((i) => isScalar(i))) {
        const items = value.items as Scalar[];
        const numeric = items.length > 0 && items.every((i) => typeof i.value === "number");
        input = (
            <textarea
                className="input mono"
                rows={Math.min(8, Math.max(2, items.length + 1))}
                value={items.map((i) => String(i.value)).join("\n")}
                placeholder="One per line"
                onChange={(e) => {
                    const lines = e.target.value.split("\n").filter((l) => l.trim() !== "");
                    (value as YAMLSeq).items = lines.map((l) => new Scalar(numeric ? Number(l) : l));
                    onChange();
                }}
            />
        );
    } else {
        input = <p className="faint sm">A list of entries: edit it in the Files tab.</p>;
    }

    return (
        <label className="field config-field">
            <span className="mono">{key}</span>
            {input}
            {help && <span className="hint">{help}</span>}
        </label>
    );
}

function Fields({ map, onChange }: { map: YAMLMap; onChange: () => void }) {
    return (
        <>
            {map.items.map((pair, i) => {
                const keyNode = pair.key as Scalar;
                // In a nested map the first key's comment is held by the map. The document's own comment is
                // Lattice's "Generated from..." header, not help for any key, so it is not used.
                const help = text(keyNode.commentBefore) || (i === 0 ? text(map.commentBefore) : "");
                return <Field key={String(keyNode.value)} pair={pair} help={help} onChange={onChange} />;
            })}
        </>
    );
}

export function ConfigForm({ serverId, path, onSaved }: { serverId: string; path: string; onSaved: (note: string) => void }) {
    const [doc, setDoc] = useState<Document | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, setVersion] = useState(0);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const load = () => {
        setError(null);
        setDirty(false);
        api.readFile(serverId, path).then((source) => {
            const parsed = parseDocument(source);
            if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
            setDoc(parsed);
        }).catch((e: Error) => setError(e.message));
    };
    useEffect(load, [serverId, path]);

    const save = async () => {
        if (!doc) return;
        setSaving(true);
        try {
            await api.writeFile(serverId, path, String(doc));
            const process = await latticeApi.reloadConfig(serverId, path).catch(() => null);
            setDirty(false);
            onSaved(process ? `Saved and reloaded on ${process}.` : "Saved. It loads on the next start.");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    };

    if (error) return <div className="error-box">{error}</div>;
    if (!doc) return <p className="faint sm">Loading...</p>;
    if (!isMap(doc.contents)) return <p className="faint sm">This file is not a set of settings; edit it in the Files tab.</p>;

    return (
        <div className="config-form">
            <Fields map={doc.contents} onChange={() => { setDirty(true); setVersion((v) => v + 1); }} />
            <div className="config-actions">
                <button className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving..." : "Save and reload"}</button>
                <button className="btn ghost sm" disabled={!dirty || saving} onClick={load}>Discard</button>
            </div>
        </div>
    );
}
