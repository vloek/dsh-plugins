#!/usr/bin/env node
// Install (or remove) the plugins of this repository into a DeepSeek Harness profile.
//
//   node scripts/install.mjs                      all plugins -> default profile
//   node scripts/install.mjs dsh-task-board       only the named ones
//   node scripts/install.mjs --profile <dir>      another profile folder
//   node scripts/install.mjs --uninstall [names]  remove them again
//   node scripts/install.mjs --list               show what is available
//
// What it does, per plugin: copies dist/<name>-<version>.tgz into <profile>/local-plugins,
// points the profile's package.json at it (dependency + bundle), and unpacks the plugin
// into <profile>/node_modules/<name>. The profile's package.json is backed up first.
// Restart DeepSeek Harness afterwards.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repo, "packages");
const distDir = join(repo, "dist");

function fail(message) {
	console.error("Ошибка: " + message);
	process.exit(1);
}

function available() {
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
		.map((entry) => {
			const manifest = JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"));
			return { dir: join(packagesDir, entry.name), name: manifest.name, version: manifest.version, description: manifest.description ?? "", files: manifest.files ?? ["lib"] };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function parseArgs(argv) {
	const options = { profile: null, uninstall: false, list: false, names: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--profile") options.profile = argv[++i] ?? fail("после --profile нужен путь к папке профиля");
		else if (arg === "--uninstall" || arg === "--remove") options.uninstall = true;
		else if (arg === "--list") options.list = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg.startsWith("-")) fail(`неизвестный ключ ${arg}`);
		else options.names.push(arg);
	}
	return options;
}

function defaultProfile() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "profiles", "desktop");
}

function readProfile(profile) {
	const file = join(profile, "package.json");
	if (!existsSync(file)) fail(`в ${profile} нет package.json. Это точно папка профиля DSH? Укажи её через --profile <папка>.`);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(`не удалось прочитать ${file}: ${error.message}`);
	}
	manifest.dependencies ??= {};
	manifest.dsh ??= {};
	manifest.dsh.profile ??= {};
	if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
	return { file, manifest };
}

function backup(file) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const target = `${file}.bak-${stamp}`;
	copyFileSync(file, target);
	return target;
}

function install(plugin, profile, manifest) {
	const tarball = `${plugin.name}-${plugin.version}.tgz`;
	const source = join(distDir, tarball);
	if (!existsSync(source)) fail(`нет ${source}. Собери архивы: node scripts/build-dist.mjs`);
	mkdirSync(join(profile, "local-plugins"), { recursive: true });
	copyFileSync(source, join(profile, "local-plugins", tarball));

	manifest.dependencies[plugin.name] = `file:local-plugins/${tarball}`;
	if (!manifest.dsh.profile.bundles.includes(plugin.name)) manifest.dsh.profile.bundles.push(plugin.name);

	// Same content the tarball carries: package.json plus everything in its "files".
	const target = join(profile, "node_modules", plugin.name);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	copyFileSync(join(plugin.dir, "package.json"), join(target, "package.json"));
	for (const entry of plugin.files) {
		const from = join(plugin.dir, entry);
		if (existsSync(from)) cpSync(from, join(target, entry), { recursive: true });
	}
	console.log(`  + ${plugin.name} ${plugin.version}`);
}

function uninstall(plugin, profile, manifest) {
	delete manifest.dependencies[plugin.name];
	manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== plugin.name);
	rmSync(join(profile, "node_modules", plugin.name), { recursive: true, force: true });
	console.log(`  - ${plugin.name}`);
}

const options = parseArgs(process.argv.slice(2));
const plugins = available();

if (options.help) {
	console.log("node scripts/install.mjs [--profile <папка профиля>] [--uninstall] [--list] [имена плагинов…]");
	process.exit(0);
}
if (options.list) {
	for (const plugin of plugins) console.log(`${plugin.name} ${plugin.version}\n    ${plugin.description}`);
	process.exit(0);
}

const unknown = options.names.filter((name) => !plugins.some((plugin) => plugin.name === name));
if (unknown.length > 0) fail(`нет таких плагинов: ${unknown.join(", ")}. Доступны: ${plugins.map((plugin) => plugin.name).join(", ")}`);
const chosen = options.names.length > 0 ? plugins.filter((plugin) => options.names.includes(plugin.name)) : plugins;

const profile = resolve(options.profile ?? defaultProfile());
const { file, manifest } = readProfile(profile);
console.log(`Профиль: ${profile}`);
console.log(`Копия package.json: ${backup(file)}`);
for (const plugin of chosen) (options.uninstall ? uninstall : install)(plugin, profile, manifest);
writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(options.uninstall ? "Готово. Перезапусти DeepSeek Harness." : "Готово. Полностью перезапусти DeepSeek Harness, плагины появятся после запуска.");
