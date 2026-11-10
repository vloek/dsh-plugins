// Offline checks for the browser half: loads lib/client.js through a fake module
// loader, checks the generated CSS against the real CSS of the installed DSH build
// (extracted copies in ../../.scratch when present) and the clearance arithmetic.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let exportsOut = null;
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { exportsOut = factory(() => ({})); } } };
globalThis.document = { documentElement: { hasAttribute: () => true }, querySelector: () => null };
new Function(source)();
assert.ok(exportsOut, "module registered");
const { buildCss, readConfig, clearances, isF11, MODULES } = exportsOut.__internals;

// --- config defaults: everything on unless switched off
assert.deepEqual(readConfig(undefined), { hideMenu: true, mergeHeader: true, transparentControls: true, f11Fullscreen: true, escKeepsFullscreen: true });
assert.deepEqual(readConfig({ hideMenu: false, transparentControls: false, f11Fullscreen: false, escKeepsFullscreen: false }), { hideMenu: false, mergeHeader: true, transparentControls: false, f11Fullscreen: false, escKeepsFullscreen: false });
assert.ok(source.includes('keyboard.lock(["Escape"])'), "Esc is locked to the page in fullscreen");

// --- F11 filter: bare F11 only
const key = (k, mods = {}) => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
assert.equal(isF11(key("F11")), true);
assert.equal(isF11(key("F11", { ctrlKey: true })), false);
assert.equal(isF11(key("F11", { shiftKey: true })), false);
assert.equal(isF11(key("F12")), false);

// --- generated CSS parses as balanced rules and targets real class names
const prefixes = { layout: "mP3x-q", conv: "an3WzG", sidebar: "wtg9ga" };
const css = buildCss(prefixes);
assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, "balanced braces");
assert.ok(css.includes("[data-windows-menu]{display:none!important}"));
// Menu hiding must survive F11 removing data-windows-titlebar.
const menuRule = css.split("\n").find((r) => r.includes("[data-windows-menu]"));
assert.ok(!menuRule.includes("data-windows-titlebar"), "menu rule independent of the caption marker");
assert.ok(menuRule.includes("data-dsh-sc-fullscreen"), "menu hidden during F11 fullscreen");
assert.ok(css.includes("--dsw-specific-sidebar-fill"));
assert.ok(css.includes(":not([data-fullscreen])"));

const scratch = join(here, "..", "..", ".scratch");
const realFiles = { layout: "frame.css", conv: "conv-root.css", sidebar: "sidebar.css" };
let checked = 0;
for (const [key, file] of Object.entries(realFiles)) {
	const path = join(scratch, file);
	if (!existsSync(path)) continue;
	const real = readFileSync(path, "utf8");
	const prefix = prefixes[key];
	assert.equal(MODULES[key].probe.exec(real)?.[1], prefix, "prefix probe finds " + key);
	const used = new Set([...css.matchAll(new RegExp("\\." + prefix.replace("-", "\\-") + "_([A-Za-z]+)", "g"))].map((m) => m[1]));
	for (const name of used) { assert.ok(real.includes("." + prefix + "_" + name), key + " class exists: " + name); checked++; }
}
// The client queries these sidebar classes from JS too.
if (existsSync(join(scratch, "sidebar.css"))) {
	const real = readFileSync(join(scratch, "sidebar.css"), "utf8");
	for (const name of ["toggle", "collapsed", "newSession"]) assert.ok(real.includes(".wtg9ga_" + name), "sidebar class " + name);
	assert.ok(real.includes("position:fixed;left:12px"), "toggle is still pinned into the caption");
}
if (checked) console.log("checked", checked, "class names against the installed build");

// --- clearance arithmetic
const caption = 40;
// Column reaches the window edge under the native buttons (right panel closed), rail on the left.
assert.deepEqual(
	clearances({ left: 56, right: 1536 }, 1536 - 140, [{ left: 12, right: 40, top: 6, bottom: 34 }], caption),
	{ left: 0, right: 152 },
);
// Right panel open: the column ends left of the buttons, nothing to clear.
assert.deepEqual(clearances({ left: 56, right: 1000 }, 1396, [], caption), { left: 0, right: 0 });
// Sidebar hidden (0px column): toggle + New Session sit in the caption over the column.
assert.deepEqual(
	clearances({ left: 0, right: 1536 }, 1396, [{ left: 12, right: 40, top: 6, bottom: 34 }, { left: 48, right: 76, top: 6, bottom: 34 }], caption),
	{ left: 84, right: 152 },
);
// Hidden controls (zero width) and controls below the caption are ignored.
assert.deepEqual(clearances({ left: 0, right: 900 }, 1396, [{ left: 0, right: 0, top: 0, bottom: 0 }, { left: 10, right: 300, top: 120, bottom: 150 }], caption), { left: 0, right: 0 });

console.log("ok");
