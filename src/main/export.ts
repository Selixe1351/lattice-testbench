import { createWriteStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { ExportResult } from "@shared/types";

/**
 * Writes a server folder as a zip. Done here rather than with Compress-Archive because a running server
 * holds some files open (session.lock, the log), and that command aborts on the first one; this skips
 * what it cannot read and says how many.
 */

interface Central {
    name: Buffer;
    crc: number;
    compressed: number;
    size: number;
    offset: number;
    time: number;
    date: number;
    method: number;
}

const U32 = 0xffffffff;

function dos(date: Date): { time: number; date: number } {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.isFile()) yield full;
    }
}

/**
 * Zips [root] into [target]; [include] gets each file's path relative to [root], with forward slashes. [extra] are
 * written after the folder's files, for what belongs in the zip but not in the server folder.
 */
export async function writeZip(
    root: string,
    target: string,
    include: (path: string) => boolean = () => true,
    extra: { path: string; bytes: Buffer }[] = [],
): Promise<Omit<ExportResult, "path">> {
    const out = createWriteStream(target);
    const failed = new Promise<never>((_, reject) => out.once("error", reject));
    let position = 0;
    const write = (chunk: Buffer) => new Promise<void>((resolve) => {
        position += chunk.length;
        if (position > U32) throw new Error("This server is over 4 GB, which the zip writer here does not support.");
        out.write(chunk, () => resolve());
    });

    const central: Central[] = [];
    let skipped = 0;
    const add = async (path: string, bytes: Buffer, modified: Date) => {
        const name = Buffer.from(path, "utf8");
        const packed = deflateRawSync(bytes);
        const stored = packed.length >= bytes.length;
        const body = stored ? bytes : packed;
        const when = dos(modified);
        const entry: Central = { name, crc: crc32(bytes), compressed: body.length, size: bytes.length, offset: position, ...when, method: stored ? 0 : 8 };

        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6); // names are UTF-8
        header.writeUInt16LE(entry.method, 8);
        header.writeUInt16LE(entry.time, 10);
        header.writeUInt16LE(entry.date, 12);
        header.writeUInt32LE(entry.crc, 14);
        header.writeUInt32LE(entry.compressed, 18);
        header.writeUInt32LE(entry.size, 22);
        header.writeUInt16LE(name.length, 26);
        await write(header);
        await write(name);
        await write(body);
        central.push(entry);
    };

    try {
        await Promise.race([failed, (async () => {
            for await (const file of walk(root)) {
                const path = relative(root, file).split(sep).join("/");
                if (!include(path)) continue;
                let bytes: Buffer;
                let modified: Date;
                try {
                    bytes = await readFile(file);
                    modified = (await stat(file)).mtime;
                } catch (error) {
                    // Locked by the running server. Counted and reported, not hidden.
                    console.warn(`Export skipped ${file}`, error);
                    skipped++;
                    continue;
                }
                await add(path, bytes, modified);
            }
            for (const file of extra) await add(file.path, file.bytes, new Date());
            if (central.length > 0xfffe) throw new Error("This server has more files than the zip writer here supports.");

            const start = position;
            for (const entry of central) {
                const record = Buffer.alloc(46);
                record.writeUInt32LE(0x02014b50, 0);
                record.writeUInt16LE(20, 4);
                record.writeUInt16LE(20, 6);
                record.writeUInt16LE(0x0800, 8);
                record.writeUInt16LE(entry.method, 10);
                record.writeUInt16LE(entry.time, 12);
                record.writeUInt16LE(entry.date, 14);
                record.writeUInt32LE(entry.crc, 16);
                record.writeUInt32LE(entry.compressed, 20);
                record.writeUInt32LE(entry.size, 24);
                record.writeUInt16LE(entry.name.length, 28);
                record.writeUInt32LE(entry.offset, 42);
                await write(record);
                await write(entry.name);
            }
            const end = Buffer.alloc(22);
            end.writeUInt32LE(0x06054b50, 0);
            end.writeUInt16LE(central.length, 8);
            end.writeUInt16LE(central.length, 10);
            end.writeUInt32LE(position - start, 12);
            end.writeUInt32LE(start, 16);
            await write(end);
        })()]);
    } finally {
        await new Promise<void>((resolve) => out.end(resolve));
    }
    return { files: central.length, skipped };
}
