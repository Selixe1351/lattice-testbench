/**
 * What an extension declares in its `extension.json`, and what the app tells the window about it. Plain data:
 * the window draws settings, deploy options, setup steps and server buttons from this alone, so an extension
 * written by anyone gets the same screens as a built-in one without shipping any UI.
 */

export type FieldType = "text" | "secret" | "number" | "boolean" | "select" | "path" | "files";

export interface Field {
    key: string;
    label: string;
    type: FieldType;
    /** One line under the field: what it is for, where to get it. */
    hint?: string;
    placeholder?: string;
    /** For "select". */
    options?: { value: string; label: string }[];
    /** For "path" and "files": what the picker offers, e.g. ["jar"]. Empty means any file. */
    extensions?: string[];
    default?: string | number | boolean | string[];
}

/** One line of "how to get this working". Done when [done] is satisfied, which the window checks live. */
export interface SetupStep {
    text: string;
    link?: string;
    /** A command or snippet to copy, as written. */
    copy?: string;
    /** Like [copy], but asked of the extension (its `handle` channel of this name), for text that holds a secret. */
    copyFrom?: string;
    /** Settings that must be filled in for the step to count as done. Absent means the person ticks it off. */
    needs?: string[];
}

/** A button on a server's page. */
export interface ServerAction {
    id: string;
    label: string;
    /** All must hold for the button to show. */
    when?: ("running" | "public" | "not-public")[];
}

export interface ExtensionManifest {
    id: string;
    name: string;
    description: string;
    version: string;
    /** The extension API this was written for. The app refuses an extension whose number it does not know. */
    api: number;
    /** Plain words shown before enabling, e.g. "Opens network connections". Not enforced: extensions run with the app's own rights. */
    permissions?: string[];
    /** Settings, drawn on the Extensions page. */
    settings?: Field[];
    /** Options added to the Deploy dialog while the extension is enabled. */
    deploy?: Field[];
    actions?: ServerAction[];
    setup?: SetupStep[];
    /** Entry file of a user extension, relative to its folder. Built-in extensions have none. */
    main?: string;
}

export const EXTENSION_API = 1;

export type ExtensionValue = string | number | boolean | string[];

/** What the window is told about each extension. */
export interface ExtensionView {
    manifest: ExtensionManifest;
    builtin: boolean;
    enabled: boolean;
    /** Current setting values; secrets are replaced by `true` when set, so they never cross to the window. */
    values: Record<string, ExtensionValue | true>;
    /** Why it is not running although enabled, e.g. "activate failed: ...". */
    error?: string;
    /** Extra status text the extension reports about itself, e.g. the MCP address. */
    status?: string;
}
