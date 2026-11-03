// An extension is a CommonJS file that exports activate(ctx). Everything it registers through ctx is removed
// again when it is turned off, so there is no cleanup to write.
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

exports.activate = (ctx) => {
    // Runs for every process of a deploy, after the app wrote its files and before the process starts.
    ctx.hook("prepare", async ({ proc, options }) => {
        if (proc.role !== "game" || !options.motd) return;
        const file = join(proc.dir, "server.properties");
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace(/^motd=.*$/m, `motd=${String(options.motd).replace(/[^\x20-\x7e]/g, "")}`));
    });

    // The button declared under "actions" in extension.json.
    ctx.action("say", (serverId) => {
        for (const proc of ctx.servers.processes(serverId)) {
            if (proc.role === "game" && proc.state === "running") ctx.servers.command(serverId, proc.name, `say ${ctx.settings.get("greeting")}`);
        }
    });

    ctx.status("Ready.");
};
