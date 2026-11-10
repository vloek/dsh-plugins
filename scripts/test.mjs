#!/usr/bin/env node
// Run every plugin's own test file (packages/*/test/run.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages");
let failed = 0;
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	const test = join(packagesDir, entry.name, "test", "run.mjs");
	if (!entry.isDirectory() || !existsSync(test)) continue;
	const result = spawnSync(process.execPath, [test], { cwd: join(packagesDir, entry.name), encoding: "utf8" });
	const ok = result.status === 0;
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${entry.name}`);
	if (!ok) console.log((result.stdout ?? "") + (result.stderr ?? ""));
}
process.exit(failed === 0 ? 0 : 1);
