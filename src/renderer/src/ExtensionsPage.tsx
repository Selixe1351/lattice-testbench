import { useState } from "react";
import type { ExtensionValue, ExtensionView, SetupStep } from "@shared/extensions";
import { Check, Copy } from "./icons";
import { FieldInput } from "./FieldInput";
import { useExtensions } from "./ext";

const api = window.testbench;

const describe = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** One line of "how to get this working". A step with `needs` ticks itself once those settings are filled in. */
function Step({ step, number, extension }: { step: SetupStep; number: number; extension: ExtensionView }) {
    const [copied, setCopied] = useState(false);
    const [ticked, setTicked] = useState(false);
    const done = step.needs ? step.needs.every((key) => extension.values[key] !== undefined) : ticked;

    const copy = async () => {
        const text = step.copyFrom ? await api.extension<string>(extension.manifest.id, step.copyFrom).catch(() => "Enable the extension first.") : step.copy ?? "";
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };

    return (
        <li className={`step ${done ? "done" : ""}`}>
            <button className="step-mark" aria-label={done ? "Done" : "Mark as done"} disabled={Boolean(step.needs)} onClick={() => setTicked(!ticked)}>
                {done ? <Check /> : number}
            </button>
            <div className="step-body">
                <span>{step.text}</span>
                {step.link && <> <a className="link" href={step.link} target="_blank" rel="noreferrer">Open</a></>}
                {(step.copy || step.copyFrom) && (
                    <div className="step-copy">
                        {step.copy && <code className="mono">{step.copy}</code>}
                        <button className="btn sm ghost" onClick={() => void copy()}><Copy /> {copied ? "Copied" : "Copy"}</button>
                    </div>
                )}
            </div>
        </li>
    );
}

function Card({ extension }: { extension: ExtensionView }) {
    const { manifest } = extension;
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Record<string, ExtensionValue>>({});
    const [saved, setSaved] = useState(false);
    const fields = manifest.settings ?? [];

    const toggle = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.setExtensionEnabled(manifest.id, !extension.enabled);
            if (!extension.enabled) setOpen(true);
        } catch (e) {
            setError(describe(e));
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        setError(null);
        try {
            // Fields left alone keep their stored value: a secret goes back as `true`, which means unchanged.
            const values: Record<string, ExtensionValue | true> = { ...extension.values };
            Object.assign(values, draft);
            await api.saveExtensionValues(manifest.id, values);
            setDraft({});
            setSaved(true);
        } catch (e) {
            setError(describe(e));
        }
    };

    const current = (key: string): ExtensionValue | undefined => {
        if (key in draft) return draft[key];
        const stored = extension.values[key];
        return stored === true ? undefined : stored ?? fields.find((f) => f.key === key)?.default;
    };

    return (
        <div className="card ext-card" style={{ marginBottom: 12 }}>
            <div className="card-head">
                <div style={{ minWidth: 0 }}>
                    <h2>{manifest.name} {extension.builtin ? <span className="badge">built in</span> : <span className="badge">yours</span>} <span className="faint sm">v{manifest.version}</span></h2>
                    <p className="subtle sm">{manifest.description}</p>
                </div>
                <span className="grow" />
                <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Set up"}</button>
                <button className={`btn sm ${extension.enabled ? "" : "primary"}`} disabled={busy || Boolean(extension.error && !extension.builtin && manifest.version === "-")} onClick={() => void toggle()}>
                    {extension.enabled ? "Turn off" : "Turn on"}
                </button>
            </div>
            {(extension.error || error || extension.status) && (
                <div className="card-body" style={{ paddingBottom: 0 }}>
                    {(error ?? extension.error) && <div className="error-box">{error ?? extension.error}</div>}
                    {extension.enabled && extension.status && <p className="ok-text sm">{extension.status}</p>}
                </div>
            )}
            {open && (
                <div className="card-body">
                    {manifest.permissions && manifest.permissions.length > 0 && (
                        <p className="faint sm" style={{ marginBottom: 12 }}>
                            It can: {manifest.permissions.join("; ")}.{!extension.builtin && " Extensions you add run with this app's own rights, so only turn on ones you trust."}
                        </p>
                    )}
                    {manifest.setup && manifest.setup.length > 0 && (
                        <>
                            <h3>Setup</h3>
                            <ol className="steps">
                                {manifest.setup.map((step, i) => <Step key={i} step={step} number={i + 1} extension={extension} />)}
                            </ol>
                        </>
                    )}
                    {fields.length > 0 && (
                        <>
                            <h3 style={{ marginTop: 16 }}>Settings</h3>
                            {fields.map((field) => (
                                <FieldInput
                                    key={field.key}
                                    field={field}
                                    value={current(field.key)}
                                    secretSet={extension.values[field.key] === true}
                                    onChange={(value) => { setDraft({ ...draft, [field.key]: value }); setSaved(false); }}
                                />
                            ))}
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <button className="btn primary" onClick={() => void save()}>Save</button>
                                {saved && <span className="subtle sm">Saved.</span>}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

export function ExtensionsPage() {
    const extensions = useExtensions();
    const builtin = extensions.filter((e) => e.builtin);
    const yours = extensions.filter((e) => !e.builtin);

    return (
        <div className="page">
            <div className="page-narrow">
                <h1 style={{ marginBottom: 4 }}>Extensions</h1>
                <p className="subtle" style={{ marginBottom: 24 }}>
                    The app does the basics: deploy a throwaway server, a console, files, stats. Turn on only what you need.
                </p>

                <h2 style={{ marginBottom: 8 }}>Built in</h2>
                {builtin.map((e) => <Card key={e.manifest.id} extension={e} />)}

                <h2 style={{ margin: "24px 0 8px" }}>Yours</h2>
                {yours.length === 0 && (
                    <p className="subtle sm" style={{ marginBottom: 12 }}>
                        Nothing here yet. An extension is a folder with an <span className="mono">extension.json</span> and a JavaScript file.
                        Drop it into the extensions folder and restart. The README has a ten-line example.
                    </p>
                )}
                {yours.map((e) => <Card key={e.manifest.id} extension={e} />)}
                <button className="btn" onClick={() => void api.openExtensionsFolder()}>Open extensions folder</button>
            </div>
        </div>
    );
}
