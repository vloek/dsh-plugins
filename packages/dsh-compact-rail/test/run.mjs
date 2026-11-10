// Offline checks for the browser half: loads lib/client.js through a fake module
// loader, feeds it the real SidebarRoot CSS of the installed DSH build when the
// extracted copy is available, and drives widenFrame/restoreFrame on a fake frame.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let exportsOut = null;
const attrs = new Set(["data-windows-titlebar"]);
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { exportsOut = factory(() => ({})); } } };
globalThis.document = {
	documentElement: { hasAttribute: (n) => attrs.has(n) },
	querySelector: () => null,
};
new Function(source)();
assert.ok(exportsOut, "module registered");
const { buildCss, widenFrame, restoreFrame, readConfig } = exportsOut.__internals;
assert.deepEqual(exportsOut.inject, ["layout"]);

// --- config defaults
assert.deepEqual(readConfig(undefined), { startCollapsed: true, hideBrand: false });
assert.deepEqual(readConfig({ startCollapsed: false, hideBrand: true }), { startCollapsed: false, hideBrand: true });

// --- CSS targets classes that really exist in this build
const realCssPath = join(here, "..", "..", "_tmp", "sidebar.css.txt");
const css = buildCss("wtg9ga");
const classes = [...css.matchAll(/\.wtg9ga_([A-Za-z]+)/g)].map((m) => m[1]);
if (existsSync(realCssPath)) {
	const real = readFileSync(realCssPath, "utf8");
	for (const name of new Set(classes)) assert.ok(real.includes(".wtg9ga_" + name), "class exists in DSH css: " + name);
	assert.match(real, /\.([A-Za-z0-9-]+)_root\{/, "prefix regex finds the root rule");
	assert.equal(/\.([A-Za-z0-9-]+)_root\{/.exec(real)[1], "wtg9ga");
	console.log("checked", new Set(classes).size, "class names against the installed build");
}
assert.ok(css.includes("--dsh-windows-menu-start:48px"));

// --- frame track rewriting
function fakeFrame(tracks, collapsed) {
	const props = new Map([["--dsh-windows-sidebar-width", collapsed ? "0px" : "280px"]]);
	return {
		style: {
			gridTemplateColumns: tracks,
			getPropertyValue: (k) => props.get(k) ?? "",
			setProperty: (k, v) => props.set(k, v),
		},
		hasAttribute: (n) => n === "data-sidebar-collapsed" && collapsed,
		props,
	};
}

const closed = fakeFrame("0px minmax(0px, 1fr) minmax(0px, 0px)", true);
widenFrame(closed);
assert.equal(closed.style.gridTemplateColumns, "56px minmax(0px, 1fr) minmax(0px, 0px)");
assert.equal(closed.props.get("--dsh-windows-sidebar-width"), "56px");
widenFrame(closed); // idempotent: no double widening
assert.equal(closed.style.gridTemplateColumns, "56px minmax(0px, 1fr) minmax(0px, 0px)");

const withRight = fakeFrame("0px minmax(400px, 1fr) minmax(0px, 612px)", true);
widenFrame(withRight);
assert.equal(withRight.style.gridTemplateColumns, "56px minmax(0px, 1fr) minmax(0px, 612px)");

const expanded = fakeFrame("280px minmax(0px, 1fr) minmax(0px, 0px)", false);
widenFrame(expanded);
assert.equal(expanded.style.gridTemplateColumns, "280px minmax(0px, 1fr) minmax(0px, 0px)", "expanded untouched");
assert.equal(expanded.props.get("--dsh-windows-sidebar-width"), "280px");

restoreFrame(withRight);
assert.equal(withRight.style.gridTemplateColumns, "0px minmax(0px, 1fr) minmax(0px, 612px)");
assert.equal(withRight.props.get("--dsh-windows-sidebar-width"), "0px");

// --- browser build (no Windows titlebar): never touched
attrs.delete("data-windows-titlebar");
const web = fakeFrame("56px minmax(0px, 1fr) minmax(0px, 0px)", true);
const webZero = fakeFrame("0px minmax(0px, 1fr) minmax(0px, 0px)", true);
widenFrame(web);
widenFrame(webZero);
assert.equal(webZero.style.gridTemplateColumns, "0px minmax(0px, 1fr) minmax(0px, 0px)");

console.log("ok");
