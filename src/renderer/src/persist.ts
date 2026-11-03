import { useCallback, useState } from "react";

const PREFIX = "testbench:";

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch (e) {
        console.warn(`Could not restore ${key}`, e);
        return fallback;
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
        console.warn(`Could not remember ${key}`, e);
    }
}

/** useState that survives a restart. The key is read once, so a changed key needs a remount (ServerPage is keyed by server). */
export function usePersisted<T>(key: string, fallback: T): [T, (value: T) => void] {
    const [value, setValue] = useState<T>(() => read(key, fallback));
    const set = useCallback((next: T) => {
        setValue(next);
        write(key, next);
    }, [key]);
    return [value, set];
}
