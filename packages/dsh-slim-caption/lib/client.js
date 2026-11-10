// dsh-slim-caption, browser half. Hand-written, no build step.
//
// The Windows desktop shell (html[data-windows-titlebar]) reserves a 40px caption
// row above every column: sidebar toggle, the "Application / Edit" menubar, an
// empty drag strip and the native Window Controls Overlay (min / max / close).
// The conversation header (title, mode, status, actions) then sits in its own row
// right below that strip. This plugin, each part switchable:
//   1. hideMenu            - removes the preload's "Application / Edit" menubar;
//   2. mergeHeader         - lifts the conversation column into the caption row, so
//                            the title row IS the caption (macOS already does this).
//                            Nothing is duplicated: the header just moves up 40px;
//   3. transparentControls - the preload paints the native buttons with the sidebar
//                            fill it reads from a hidden probe <span>; overriding that
//                            probe makes the button strip transparent, so the buttons
//                            float over the app (and over a skin) instead of sitting
//                            on a solid block;
//   4. f11Fullscreen       - F11 toggles whole-window fullscreen (HTML Fullscreen API).
// The native buttons themselves cannot be removed or resized from a plugin: their
// overlay is created in the Electron main process (see README).
//
// CSS-module class names are hashed per DSH build (`mP3x-q_frame`, ...), so every
// prefix is read from the module's own <style data-plugin-css> tag at runtime.
window.__ModuleLoader__.load({
	id: "dsh-slim-caption",
	factory: function () {
		var module = { exports: {} };

		var MODULES = {
			layout: { tag: "@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css", probe: /\.([A-Za-z0-9-]+)_frame\{/, fallback: "mP3x-q" },
			conv: { tag: "@deepseek-ai/dsh-client-ui-conversation/ConversationRoot.module.css", probe: /\.([A-Za-z0-9-]+)_root\{/, fallback: "an3WzG" },
			sidebar: { tag: "@deepseek-ai/dsh-client-ui-sidebar/SidebarRoot.module.css", probe: /\.([A-Za-z0-9-]+)_root\{/, fallback: "wtg9ga" },
		};
		var ATTR_MENU = "data-dsh-sc-nomenu";
		var ATTR_MERGE = "data-dsh-sc-merge";
		var ATTR_CLEAR = "data-dsh-sc-clear";
		var ATTR_FS = "data-dsh-sc-fullscreen"; // set while F11 fullscreen is on
		// Width of the native min / max / close strip when the CSS env() is unavailable.
		var CONTROLS_FALLBACK_PX = 140;

		function isWindowsShell() {
			return document.documentElement.hasAttribute("data-windows-titlebar");
		}

		function modulePrefix(spec) {
			var tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(spec.tag) + "]");
			var match = tag && spec.probe.exec(tag.textContent || "");
			return match ? match[1] : null;
		}

		function readPrefixes(useFallback) {
			var out = {};
			for (var key in MODULES) {
				var found = modulePrefix(MODULES[key]);
				if (found === null) {
					if (!useFallback) return null;
					found = MODULES[key].fallback;
				}
				out[key] = found;
			}
			return out;
		}

		function buildCss(p) {
			var L = function (name) { return "." + p.layout + "_" + name; };
			var C = function (name) { return "." + p.conv + "_" + name; };
			var W = "html[data-windows-titlebar]";
			var rules = [];

			// 1. Menubar host is a light-DOM <div data-windows-menu> with a shadow root.
			// Not tied to data-windows-titlebar: F11 removes that marker while fullscreen, and the
			// menubar (height = caption height = 0px then) would spill above the screen edge.
			rules.push("html[" + ATTR_MENU + "] [data-windows-menu],html[" + ATTR_FS + "] [data-windows-menu]{display:none!important}");

			// 3. The caption colour probe: <span style="...background-color:var(--dsw-specific-sidebar-fill)...">.
			rules.push(W + "[" + ATTR_CLEAR + "] body>span[style*=\"--dsw-specific-sidebar-fill\"]{background-color:transparent!important}");

			// 2. Lift the conversation column into the caption (not in fullscreen, where the caption is gone).
			var col = W + "[" + ATTR_MERGE + "]:not([data-fullscreen]) " + L("centerCol") + ":has(" + C("header") + ")";
			var head = col + " " + C("header");
			rules.push(
				// Grid item with a negative top margin grows up into the frame's 40px padding.
				// Positioned + z-index so it paints over the frame's caption band (frame:before).
				col + "{margin-top:calc(-1 * var(--dsh-windows-titlebar-height));position:relative;z-index:1}",
				// First header row = caption row: no top padding, row exactly as tall as the caption.
				// Side paddings keep clear of the sidebar toggle (left) and the native buttons (right).
				head + "{padding-top:0;padding-left:max(20px,var(--dsh-sc-left,0px));padding-right:max(28px,var(--dsh-sc-right,0px))}",
				head + " " + C("titleRow") + "," + head + " " + C("headerLeading") + "{min-height:var(--dsh-windows-titlebar-height)}",
				// The title row's empty space drags the window, like the caption it replaces.
				head + " " + C("titleRow") + "{-webkit-app-region:drag}",
				// Everything clickable stays clickable (the frame's caption band underneath is a drag region too).
				head + " " + C("headerLeading") + "," + head + " " + C("headerActions") + "," +
					head + " " + C("headerUtilities") + "," + head + " " + C("headerCorner") + "," +
					head + " " + C("crumbs") + "," + head + " " + C("tabs") + "," +
					head + " :is(button,a,input,textarea,select,[role=button],[role=tab],[role=combobox],[contenteditable=true],[tabindex]:not([tabindex=\"-1\"]))" +
					"{-webkit-app-region:no-drag}"
			);
			return rules.join("\n");
		}

		function readConfig(config) {
			var source = config && typeof config === "object" ? config : {};
			return {
				hideMenu: source.hideMenu !== false,
				mergeHeader: source.mergeHeader !== false,
				transparentControls: source.transparentControls !== false,
				f11Fullscreen: source.f11Fullscreen !== false,
				escKeepsFullscreen: source.escKeepsFullscreen !== false,
			};
		}

		// F11 = plain F11 only (Ctrl/Alt/Shift/Win+F11 stay free for other bindings).
		function isF11(event) {
			return event.key === "F11" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
		}

		// Right edge of the free caption area (left edge of the native buttons), in CSS px.
		function captionRight(probe) {
			var width = probe ? probe.getBoundingClientRect().width : 0;
			if (width > 0) return probe.getBoundingClientRect().left + width;
			return window.innerWidth - CONTROLS_FALLBACK_PX;
		}

		// How far the header must step in so nothing sits under the caption's fixed controls.
		// rect values are plain {left,right,top,bottom}; kept pure for the offline test.
		function clearances(colRect, controlsLeft, leadingRects, captionHeight) {
			var right = colRect.right > controlsLeft ? Math.ceil(colRect.right - controlsLeft) + 12 : 0;
			var leadingEdge = -Infinity;
			for (var i = 0; i < leadingRects.length; i++) {
				var r = leadingRects[i];
				if (r.right - r.left <= 0 || r.top >= captionHeight) continue;
				if (r.right > leadingEdge) leadingEdge = r.right;
			}
			var left = leadingEdge > colRect.left ? Math.ceil(leadingEdge - colRect.left) + 8 : 0;
			return { left: left, right: right };
		}

		module.exports.inject = [];
		module.exports.apply = function apply(ctx, config) {
			var options = readConfig(config);
			var root = document.documentElement;
			var prefixes = null;

			// Stylesheet + feature attributes.
			ctx.effect(function () {
				var style = null;
				var headWatch = null;
				var fallbackTimer = null;
				var install = function (useFallback) {
					var found = readPrefixes(useFallback);
					if (found === null) return false;
					prefixes = found;
					style = document.createElement("style");
					style.setAttribute("data-dsh-slim-caption", "");
					style.textContent = buildCss(found);
					document.head.appendChild(style);
					return true;
				};
				if (!install(false)) {
					headWatch = new MutationObserver(function () {
						if (install(false)) { headWatch.disconnect(); headWatch = null; }
					});
					headWatch.observe(document.head, { childList: true });
					// Last resort if a tag id ever changes: the prefixes of the build this was written for.
					fallbackTimer = setTimeout(function () {
						if (style !== null) return;
						if (headWatch !== null) { headWatch.disconnect(); headWatch = null; }
						install(true);
					}, 5000);
				}
				if (options.hideMenu) root.setAttribute(ATTR_MENU, "");
				if (options.mergeHeader) root.setAttribute(ATTR_MERGE, "");
				if (options.transparentControls) root.setAttribute(ATTR_CLEAR, "");
				return function () {
					if (headWatch !== null) headWatch.disconnect();
					if (fallbackTimer !== null) clearTimeout(fallbackTimer);
					if (style !== null) style.remove(); // <head> mutation: the preload re-sends the caption colours
					root.removeAttribute(ATTR_MENU);
					root.removeAttribute(ATTR_MERGE);
					root.removeAttribute(ATTR_CLEAR);
					root.style.removeProperty("--dsh-sc-left");
					root.style.removeProperty("--dsh-sc-right");
				};
			}, "dsh-slim-caption: stylesheet");

			// F11: whole-window fullscreen through the HTML Fullscreen API. In Electron the
			// window itself goes fullscreen and the native caption buttons disappear; the
			// page only has to drop its own 40px caption reservation while it lasts.
			if (options.f11Fullscreen) ctx.effect(function () {
				var busy = false;
				var savedHeight = null; // caption height we removed, restored on exit
				var onKey = function (event) {
					if (!isF11(event)) return;
					event.preventDefault();
					event.stopPropagation();
					if (busy) return;
					busy = true;
					var done = function () { busy = false; };
					try {
						var action = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen();
						Promise.resolve(action).catch(function (error) {
							console.warn("dsh-slim-caption: fullscreen toggle failed", error);
						}).then(done, done);
					} catch (error) {
						console.warn("dsh-slim-caption: fullscreen toggle failed", error);
						done();
					}
				};
				// Esc: Chromium exits HTML fullscreen on Esc before the page sees the key, so Esc
				// meant "leave fullscreen" first and "close the dialog" only on the second press.
				// The Keyboard Lock API hands Esc to the page while fullscreen; F11 stays the way out.
				var keyboard = navigator.keyboard;
				var lockEsc = function (on) {
					if (!keyboard || typeof keyboard.lock !== "function") return;
					try {
						if (on) Promise.resolve(keyboard.lock(["Escape"])).catch(function (error) {
							console.warn("dsh-slim-caption: Esc lock unavailable", error);
						});
						else keyboard.unlock();
					} catch (error) {
						console.warn("dsh-slim-caption: Esc lock failed", error);
					}
				};
				var onChange = function () {
					var full = document.fullscreenElement !== null;
					if (options.escKeepsFullscreen) lockEsc(full);
					root.toggleAttribute(ATTR_FS, full);
					if (full && savedHeight === null && root.hasAttribute("data-windows-titlebar")) {
						savedHeight = root.style.getPropertyValue("--dsh-windows-titlebar-height") || "40px";
						root.removeAttribute("data-windows-titlebar");
						root.style.setProperty("--dsh-windows-titlebar-height", "0px");
					} else if (!full && savedHeight !== null) {
						root.setAttribute("data-windows-titlebar", "");
						root.style.setProperty("--dsh-windows-titlebar-height", savedHeight);
						savedHeight = null;
					}
				};
				document.addEventListener("keydown", onKey, true);
				document.addEventListener("fullscreenchange", onChange);
				return function () {
					document.removeEventListener("keydown", onKey, true);
					document.removeEventListener("fullscreenchange", onChange);
					lockEsc(false);
					root.removeAttribute(ATTR_FS);
					if (savedHeight !== null) {
						root.setAttribute("data-windows-titlebar", "");
						root.style.setProperty("--dsh-windows-titlebar-height", savedHeight);
						savedHeight = null;
					}
				};
			}, "dsh-slim-caption: F11 fullscreen");

			if (!options.mergeHeader) return;

			// Keep the lifted header clear of the sidebar toggle / New Session (left)
			// and of the native buttons (right) whatever the sidebar and right panel do.
			ctx.effect(function () {
				var probe = document.createElement("div");
				probe.setAttribute("aria-hidden", "true");
				probe.style.cssText = "position:fixed;top:0;height:0;visibility:hidden;pointer-events:none;" +
					"left:env(titlebar-area-x,0px);width:env(titlebar-area-width,0px)";
				document.body.appendChild(probe);

				var col = null;
				var sizeWatch = typeof ResizeObserver === "function" ? new ResizeObserver(function () { schedule(); }) : null;
				var frame = 0;
				var lastLeft = "";
				var lastRight = "";

				var findCol = function () {
					if (prefixes === null) return null;
					return document.querySelector("." + prefixes.layout + "_centerCol");
				};
				var update = function () {
					frame = 0;
					if (!isWindowsShell() || root.hasAttribute("data-fullscreen")) return;
					var next = findCol();
					if (next !== col) {
						if (sizeWatch !== null) {
							if (col !== null) sizeWatch.unobserve(col);
							if (next !== null) sizeWatch.observe(next);
						}
						col = next;
					}
					if (col === null) return;
					var leading = [];
					var s = prefixes.sidebar;
					var nodes = document.querySelectorAll("." + s + "_toggle, ." + s + "_collapsed ." + s + "_newSession");
					for (var i = 0; i < nodes.length; i++) leading.push(nodes[i].getBoundingClientRect());
					var captionHeight = parseFloat(root.style.getPropertyValue("--dsh-windows-titlebar-height")) || 40;
					var result = clearances(col.getBoundingClientRect(), captionRight(probe), leading, captionHeight);
					var left = result.left + "px";
					var right = result.right + "px";
					if (left !== lastLeft) { root.style.setProperty("--dsh-sc-left", left); lastLeft = left; }
					if (right !== lastRight) { root.style.setProperty("--dsh-sc-right", right); lastRight = right; }
				};
				var schedule = function () {
					if (frame === 0) frame = requestAnimationFrame(update);
				};

				// Sidebar / right panel animate the grid: the ResizeObserver follows the column
				// through the transition; the attribute watch catches state flips and remounts.
				var domWatch = new MutationObserver(function () {
					if (col === null || !col.isConnected) schedule();
				});
				domWatch.observe(document.body, { childList: true, subtree: true });
				var rootWatch = new MutationObserver(schedule);
				rootWatch.observe(root, { attributes: true, attributeFilter: ["data-fullscreen", "data-windows-titlebar", "class"] });
				window.addEventListener("resize", schedule);
				schedule();

				return function () {
					if (frame !== 0) cancelAnimationFrame(frame);
					if (sizeWatch !== null) sizeWatch.disconnect();
					domWatch.disconnect();
					rootWatch.disconnect();
					window.removeEventListener("resize", schedule);
					probe.remove();
				};
			}, "dsh-slim-caption: header clearance");
		};
		module.exports.__internals = { buildCss: buildCss, readConfig: readConfig, clearances: clearances, isF11: isF11, MODULES: MODULES };
		return module.exports;
	},
});
