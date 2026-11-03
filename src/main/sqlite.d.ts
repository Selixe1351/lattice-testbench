// node:sqlite ships with the Node inside Electron (24), but @types/node here is pinned to 20, which predates
// it. Only what data.ts uses is declared.
declare module "node:sqlite" {
    interface StatementSync {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): unknown;
    }
    export class DatabaseSync {
        constructor(path: string, options?: { readOnly?: boolean });
        prepare(sql: string): StatementSync;
        exec(sql: string): void;
        close(): void;
    }
}
