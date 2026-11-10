// dsh-compact-rail, browser half. Hand-written, no build step.
//
// Why this exists: in the Windows desktop shell (html[data-windows-titlebar]) DSH
// collapses the left sidebar to a 0px column and moves the toggle and New Session
// into the window caption. The browser build keeps a 56px icon rail instead. This
// plugin gives the desktop shell that rail back:
//   1. the frame's first grid track is rewritten 0px -> 56px while collapsed
//      (ui-layout hardcodes 0 for the Windows titlebar);
//   2. the Windows-only sidebar rules that hide the panel icons / settings and pin
//      New Session into the caption are neutralised, so the stock rail styles apply.
// The sidebar toggle stays in the caption's top-left corner, as in the expanded state.
//
// CSS-module class names are hashed per DSH build (`wtg9ga_root`, ...), so the hash
// prefix is read from the sidebar's own <style data-plugin-css> tag at runtime.
window.__ModuleLoader__.load({
	id: "dsh-compact-rail",
	factory: function () {
		var module = { exports: {} };

		var RAIL_PX = 56;
		var SIDEBAR_CSS_TAG = "@deepseek-ai/dsh-client-ui-sidebar/SidebarRoot.module.css";
		var FALLBACK_PREFIX = "wtg9ga";
		var ROOT_ATTR = "data-dsh-rail";
		var NOBRAND_ATTR = "data-dsh-rail-nobrand";

		function isWindowsShell() {
			return document.documentElement.hasAttribute("data-windows-titlebar");
		}

		function sidebarPrefix() {
			var tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(SIDEBAR_CSS_TAG) + "]");
			var match = tag && /\.([A-Za-z0-9-]+)_root\{/.exec(tag.textContent || "");
			return match ? match[1] : null;
		}

		function buildCss(p) {
			var c = function (name) { return "." + p + "_" + name; };
			var R = "html[data-windows-titlebar][" + ROOT_ATTR + "]";
			var H = "html[data-windows-titlebar][" + NOBRAND_ATTR + "]";
			return [
				// Rail padding of the browser build (the caption already sits above the column).
				R + " " + c("root") + c("collapsed") + "{padding:12px 10px 6px!important}",
				// Windows hides these three in the collapsed state; the rail needs them back.
				R + " " + c("collapsed") + " " + c("panelList") + "," +
					R + " " + c("collapsed") + " " + c("regionArea") + "," +
					R + " " + c("collapsed") + " " + c("footArea") + "{display:flex!important}",
				// New Session: out of the caption, first icon of the rail.
				R + " " + c("collapsed") + " " + c("newSession") + "{position:static!important;left:auto!important;top:auto!important;z-index:auto!important;" +
					"width:36px!important;height:36px!important;margin:0 0 12px!important;align-self:flex-start!important;" +
					"border-radius:var(--dsw-radius-md)!important;color:var(--dsw-alias-label-primary)!important}",
				// The caption now holds only the toggle: keep the Desktop menu where the expanded state has it.
				R + ":has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:48px!important}",
				// Optional: drop the brand row of the expanded sidebar (the toggle is position:fixed, it stays).
				H + " " + c("root") + ":not(" + c("collapsed") + ") " + c("logoRow") + "{height:0!important;overflow:visible!important}",
				H + " " + c("root") + ":not(" + c("collapsed") + ") " + c("brand") + "{display:none!important}",
			].join("\n");
		}

		// "0px minmax(400px, 1fr) minmax(0px, 0px)" -> "56px minmax(0px, 1fr) minmax(0px, 0px)".
		// The center minimum drops to 0 so the extra 56px squeezes the center instead of
		// pushing an open right panel off screen.
		var COLLAPSED_TRACKS = /^\s*0px\s+minmax\(\s*[\d.]+px\s*,\s*1fr\s*\)\s+(.+)$/;
		var RAIL_TRACKS = new RegExp("^\\s*" + RAIL_PX + "px\\s+minmax\\(\\s*0px\\s*,\\s*1fr\\s*\\)\\s+(.+)$");

		function widenFrame(frame) {
			if (!isWindowsShell() || !frame.hasAttribute("data-sidebar-collapsed")) return;
			var match = COLLAPSED_TRACKS.exec(frame.style.gridTemplateColumns || "");
			if (match) frame.style.gridTemplateColumns = RAIL_PX + "px minmax(0px, 1fr) " + match[1];
			if (frame.style.getPropertyValue("--dsh-windows-sidebar-width") !== RAIL_PX + "px") {
				frame.style.setProperty("--dsh-windows-sidebar-width", RAIL_PX + "px");
			}
		}

		function restoreFrame(frame) {
			var match = RAIL_TRACKS.exec(frame.style.gridTemplateColumns || "");
			if (match) frame.style.gridTemplateColumns = "0px minmax(0px, 1fr) " + match[1];
			if (frame.hasAttribute("data-sidebar-collapsed")) frame.style.setProperty("--dsh-windows-sidebar-width", "0px");
		}

		// The frame is the parent of ui-layout's `data-shell-bottom` row (a stable attribute).
		function findFrame() {
			var bottom = document.querySelector("[data-shell-bottom]");
			return bottom ? bottom.parentElement : null;
		}

		function readConfig(config) {
			var source = config && typeof config === "object" ? config : {};
			return {
				startCollapsed: source.startCollapsed !== false,
				hideBrand: source.hideBrand === true,
			};
		}

		module.exports.inject = ["layout"];
		module.exports.apply = function apply(ctx, config) {
			var options = readConfig(config);
			var root = document.documentElement;
			var startHandled = false;

			// Stylesheet: wait for the sidebar's own CSS tag to learn this build's class prefix.
			ctx.effect(function () {
				var style = null;
				var headWatch = null;
				var fallbackTimer = null;
				var install = function () {
					var prefix = sidebarPrefix();
					if (prefix === null) return false;
					style = document.createElement("style");
					style.setAttribute("data-dsh-compact-rail", prefix);
					style.textContent = buildCss(prefix);
					document.head.appendChild(style);
					return true;
				};
				if (!install()) {
					headWatch = new MutationObserver(function () {
						if (install()) { headWatch.disconnect(); headWatch = null; }
					});
					headWatch.observe(document.head, { childList: true });
					// Last resort if the tag id ever changes: use the prefix known for 0.2.1-rc.3.
					fallbackTimer = setTimeout(function () {
						if (style !== null) return;
						if (headWatch !== null) { headWatch.disconnect(); headWatch = null; }
						style = document.createElement("style");
						style.setAttribute("data-dsh-compact-rail", FALLBACK_PREFIX);
						style.textContent = buildCss(FALLBACK_PREFIX);
						document.head.appendChild(style);
					}, 5000);
				}
				root.setAttribute(ROOT_ATTR, "");
				if (options.hideBrand) root.setAttribute(NOBRAND_ATTR, "");
				return function () {
					if (headWatch !== null) headWatch.disconnect();
					if (fallbackTimer !== null) clearTimeout(fallbackTimer);
					if (style !== null) style.remove();
					root.removeAttribute(ROOT_ATTR);
					root.removeAttribute(NOBRAND_ATTR);
				};
			}, "dsh-compact-rail: stylesheet");

			// Frame: keep the collapsed column at 56px whatever ui-layout writes.
			ctx.effect(function () {
				var frame = null;
				var frameWatch = null;
				var attach = function () {
					var next = findFrame();
					if (next === frame) return;
					if (frameWatch !== null) frameWatch.disconnect();
					frame = next;
					frameWatch = null;
					if (frame === null) return;
					frameWatch = new MutationObserver(function () { widenFrame(frame); });
					frameWatch.observe(frame, { attributes: true, attributeFilter: ["style", "data-sidebar-collapsed"] });
					widenFrame(frame);
					maybeStartCollapsed(frame);
				};
				var maybeStartCollapsed = function (target) {
					if (startHandled || !options.startCollapsed) return;
					startHandled = true;
					var layout = ctx.layout;
					if (!layout || typeof layout.toggleSidebar !== "function") return;
					// Let the frame finish its first layout pass, then collapse once.
					requestAnimationFrame(function () {
						requestAnimationFrame(function () {
							if (!target.isConnected || target.hasAttribute("data-sidebar-collapsed")) return;
							if (window.innerWidth < 1024) return; // narrow windows auto-collapse already
							layout.toggleSidebar();
						});
					});
				};
				// The frame mounts after plugins apply and may remount; a connected check per batch is cheap.
				var bodyWatch = new MutationObserver(function () {
					if (frame === null || !frame.isConnected) attach();
				});
				bodyWatch.observe(document.body, { childList: true, subtree: true });
				attach();
				return function () {
					bodyWatch.disconnect();
					if (frameWatch !== null) frameWatch.disconnect();
					if (frame !== null && frame.isConnected) restoreFrame(frame);
				};
			}, "dsh-compact-rail: frame width");
		};
		module.exports.__internals = { buildCss: buildCss, widenFrame: widenFrame, restoreFrame: restoreFrame, COLLAPSED_TRACKS: COLLAPSED_TRACKS, RAIL_TRACKS: RAIL_TRACKS, readConfig: readConfig };
		return module.exports;
	},
});
