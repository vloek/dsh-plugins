#!/usr/bin/env node
// Rebuild dist/*.tgz from packages/* (one `npm pack` per plugin). Run after changing a plugin
// and bumping its version, then commit the new archive.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repo, "packages");
const distDir = join(repo, "dist");
mkdirSync(distDir, { recursive: true });

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	const dir = join(packagesDir, entry.name);
	if (!entry.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	// Drop older archives of the same plugin so dist/ holds exactly one version each.
	for (const file of readdirSync(distDir)) {
		if (file.startsWith(manifest.name + "-") && file.endsWith(".tgz")) rmSync(join(distDir, file));
	}
	execSync(`npm pack --silent --pack-destination ${JSON.stringify(distDir)}`, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
	console.log(`${manifest.name}-${manifest.version}.tgz`);
}
