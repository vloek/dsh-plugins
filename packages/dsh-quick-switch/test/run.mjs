// Offline checks: ranking/fuzzy logic, and the shortcut definition against the real
// DSH catalog validator (extracted protocol.js of the installed build, when present).
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let mod = null;
globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, "dsh-quick-switch"); mod = factory(() => ({})); } } };
new Function(source)();
assert.ok(mod, "module registered");
const { swapLayout, scoreToken, rankSessions, collectEntries, relTime, pushMru } = mod.__internals;
assert.deepEqual(mod.inject, ["slots", "sessions", "workspaces", "uiWorkspace", "shortcuts"]);

// --- layout swap
assert.equal(swapLayout("ыутыуш"), "sensei");
assert.equal(swapLayout("ghbdtn"), "привет");
assert.equal(swapLayout("123"), null);

// --- token scoring
assert.ok(scoreToken("side", "Sidebar compact") !== null);
assert.equal(scoreToken("xyz", "Sidebar compact"), null);
assert.deepEqual(scoreToken("bar", "Sidebar").positions, [4, 5, 6]);
assert.ok(scoreToken("sc", "Sidebar compact").score > scoreToken("sc", "Ask cursor").score, "word starts beat inner letters");
assert.ok(scoreToken("comp", "Compact rail").score > scoreToken("comp", "Rail compact").score, "prefix beats later word");
const fuzzy = scoreToken("snsei", "Go review sensei SGF");
assert.ok(fuzzy !== null && fuzzy.positions.length === 5, "subsequence matches");

// --- data collection
const list = {
	ids: ["a", "b", "c", "d", "e", "f"],
	byId: {
		a: { id: "a", title: "Сайдбар: компактная рейка", cwd: "C:/w/default-workspace", updatedAt: 500, retainedBy: { mainView: 1 } },
		b: { id: "b", title: "Go review sensei", cwd: "C:/w/go", updatedAt: 400, retainedBy: {}, running: true },
		c: { id: "c", title: "Task board plugin", cwd: "C:/w/default-workspace", updatedAt: 300, retainedBy: {} },
		d: { id: "d", title: "", cwd: "C:/w/x", updatedAt: 900, blank: true, retainedBy: {} },
		e: { id: "e", title: "child", origin: "subagent", updatedAt: 800, retainedBy: {} },
		f: { id: "f", title: "Archived thing", updatedAt: 700, retainedBy: {} },
	},
};
const workspaces = { items: [{ workspaceId: "w1", title: "default-workspace", path: "C:/w/default-workspace", sessionIds: ["a", "c"] }], archivedSessionIds: ["f"] };
const entries = collectEntries(list, workspaces);
assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"], "blank, subagent and archived are hidden");
assert.equal(entries[0].current, true);
assert.equal(entries[1].workspace, "go", "basename fallback for sessions outside a workspace");
assert.equal(entries[1].running, true);

// --- ranking
const recent = rankSessions(entries, "", ["a", "c"]);
assert.deepEqual(recent.map((r) => r.entry.id), ["a", "c", "b"], "empty query: MRU first, then recency");
assert.equal(rankSessions(entries, "task", [])[0].entry.id, "c");
assert.equal(rankSessions(entries, "ефыл", [])[0].entry.id, "c", "wrong keyboard layout still finds it");
assert.equal(rankSessions(entries, "рейк", [])[0].entry.id, "a");
assert.equal(rankSessions(entries, "go sens", [])[0].entry.id, "b", "multi-token");
assert.deepEqual(rankSessions(entries, "default", []).map((r) => r.entry.id).sort(), ["a", "c"], "workspace name matches");
assert.equal(rankSessions(entries, "zzzz", []).length, 0);

assert.deepEqual(pushMru(["x", "y", "z"], "y"), ["y", "x", "z"]);
assert.equal(relTime(Date.now() - 5 * 60000), "5 мин");
assert.equal(relTime(Math.floor((Date.now() - 3 * 3600000) / 1000)), "3 ч", "seconds timestamps work too");

// --- the shortcut definition must pass DSH's own catalog validator
const protocolPath = join(here, "..", "..", "_tmp", "shortcuts-protocol.js");
let registered = null;
const allRegistered = [];
const ctx = {
	get: (name) => ({ sessions: { list: { getSnapshot: () => list, subscribe: () => () => {} } }, workspaces: { list: { getSnapshot: () => workspaces, subscribe: () => () => {} } }, uiWorkspace: { openSession() {} } })[name],
	effect: (fn) => fn(),
	shortcuts: { register: (def) => { allRegistered.push(def); if (def.id === "session.quickSwitch") registered = def; return () => {}; } },
	slots: { inject: (_n, fn) => fn(), register: () => () => {} },
};
// Fake sidebar: style tag with the real prefix and a panel list of three rows.
const clicked = [];
const rows = ["Артефакты", "Задачи", "Заметки"].map((name) => ({ textContent: name, getAttribute: () => null, click: () => clicked.push(name) }));
const sidebarCss = existsSync(join(here, "..", "..", ".scratch", "sidebar.css")) ? readFileSync(join(here, "..", "..", ".scratch", "sidebar.css"), "utf8") : ".wtg9ga_root{}";
globalThis.document = {
	createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} }, activeElement: null, body: {},
	querySelector: (sel) => sel.startsWith("style[") ? { textContent: sidebarCss } : sel === ".wtg9ga_panelList" ? { querySelectorAll: (s) => (s === ".wtg9ga_panelRow" ? rows : []) } : null,
};
globalThis.window.localStorage = { getItem: () => null, setItem() {} };
mod.apply(ctx);
assert.equal(registered.id, "session.quickSwitch");

// --- Alt+1…9 sidebar panels
const panels = allRegistered.filter((d) => d.id.startsWith("sidebar.openPanel"));
assert.equal(panels[0].id, "sidebar.openPanel1");
assert.equal(panels.length, 9);
assert.deepEqual(panels[1].defaults["desktop:windows"], { code: "Digit2", modifiers: ["alt"] });
assert.equal(panels[1].label(), "Панель сайдбара 2 — Задачи");
const r2 = panels[1].resolve({});
assert.equal(r2.status, "handled");
r2.run();
assert.deepEqual(clicked, ["Задачи"]);
assert.deepEqual(panels[5].resolve({}), { status: "pass" }, "no 6th panel: key passes through");
if (existsSync(join(here, "..", "..", ".scratch", "sidebar.css"))) {
	assert.ok(sidebarCss.includes(".wtg9ga_panelList{") && sidebarCss.includes(".wtg9ga_panelRow{"), "panel classes exist in the installed build");
}
if (existsSync(protocolPath)) {
	const stubbed = readFileSync(protocolPath, "utf8")
		.replace(/^import \{ assertNever \} from .*$/m, "const assertNever = (v) => { throw new Error('never ' + v); };")
		.replace(/^import \{ randomUUID \} from .*$/m, "const randomUUID = () => 'x';");
	const dir = mkdtempSync(join(dirname(protocolPath), "qs-proto-"));
	const file = join(dir, "protocol.mjs");
	writeFileSync(file, stubbed);
	const protocol = await import(pathToFileURL(file).href);
	const K = (code, modifiers) => ({ code, modifiers });
	const all = (desktop, web) => ({ "desktop:macos": desktop, "desktop:windows": desktop, "desktop:linux": desktop, "web:macos": web, "web:windows": web });
	// Real defaults from the installed build (scan of every client bundle).
	const catalog = [
		{ id: "sidebar.left.toggle", defaults: all(K("KeyB", ["primary"]), K("KeyB", ["primary", "alt"])) },
		{ id: "sidebar.right.toggle", defaults: all(K("KeyB", ["primary", "alt"]), K("KeyB", ["primary", "shift"])) },
		{ id: "workspace.files", defaults: all(K("KeyP", ["primary"]), K("KeyP", ["primary", "alt"])) },
		{ id: "session.new", defaults: all(K("KeyN", ["primary"]), K("KeyN", ["primary", "alt"])) },
		{ id: "session.search", defaults: all(K("KeyK", ["primary"]), K("KeyK", ["primary", "alt"])) },
		{ id: "session.archive", defaults: all(K("KeyA", ["primary", "shift"]), K("KeyA", ["primary", "alt"])) },
		{ id: "terminal.new", defaults: all(K("Backquote", ["control"]), K("Backquote", ["control"])) },
		...allRegistered.map((d) => ({ id: d.id, defaults: d.defaults })),
	];
	assert.doesNotThrow(() => protocol.parseShortcutDefinitions(catalog), "catalog with our command is accepted");
	// And the naive "Ctrl+Space everywhere" would have broken the whole catalog:
	const naive = catalog.filter((row) => row.id !== registered.id).concat([{ id: registered.id, defaults: all(K("Space", ["primary"]), K("Space", ["primary"])) }]);
	assert.throws(() => protocol.parseShortcutDefinitions(naive), /Conflicting or reserved/);
	const effective = protocol.effectiveShortcuts(catalog, { schemaVersion: 1, profiles: {} }, "desktop", "windows").find((row) => row.id === registered.id);
	assert.deepEqual(effective.binding, { code: "Space", modifiers: ["control"] });
	assert.equal(effective.issue, null);
	assert.deepEqual(effective.conflicts, []);
	const alt1 = protocol.effectiveShortcuts(catalog, { schemaVersion: 1, profiles: {} }, "desktop", "windows").find((row) => row.id === "sidebar.openPanel1");
	assert.deepEqual(alt1.binding, { code: "Digit1", modifiers: ["alt"] });
	assert.equal(alt1.issue, null);
	assert.deepEqual(alt1.conflicts, []);
	console.log("shortcuts accepted by the DSH validator: Ctrl+Space and Alt+1…9 on desktop:windows, no conflicts");
}

console.log("ok");
