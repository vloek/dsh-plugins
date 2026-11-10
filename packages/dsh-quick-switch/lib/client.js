// dsh-quick-switch, browser half. Hand-written, no build step: React comes from
// the module loader; data and navigation come from DSH's own client services.
//
//   Ctrl+Space (Desktop) / Ctrl+Shift+Space (Web) opens a palette over the app.
//   Typing filters sessions by title (fuzzy, word starts first; the workspace name
//   matches too, more weakly; a query typed in the wrong keyboard layout still
//   matches). Enter opens the highlighted session, Esc closes, arrows move.
//   With an empty query the list is "recently opened" and the previous session
//   is preselected, so Ctrl+Space, Enter jumps back and forth like Ctrl+Tab.
//   After a short pause, matches inside the conversation text are appended below.
window.__ModuleLoader__.load({
	id: "dsh-quick-switch",
	factory: function (require) {
		var module = { exports: {} };
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useRef = React.useRef;
		var useCallback = React.useCallback;
		// DSH's own dialogs portal into <body>; do the same to sit above the window caption controls.
		var createPortal = null;
		try {
			var ReactDOM = require("react-dom");
			if (ReactDOM && typeof ReactDOM.createPortal === "function") createPortal = ReactDOM.createPortal;
		} catch (_e) { createPortal = null; }

		var COMMAND_ID = "session.quickSwitch";
		var MODAL_ID = "quick-switch";
		var MRU_KEY = "dsh-quick-switch:mru";
		var MRU_LIMIT = 60;
		var RESULT_LIMIT = 60;
		var CONTENT_LIMIT = 10;
		var CONTENT_MIN_QUERY = 3;
		var CONTENT_DEBOUNCE_MS = 250;
		var PAGE_STEP = 8;

		// ---------- keyboard layout fallback (ЙЦУКЕН <-> QWERTY) ----------

		var EN_KEYS = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
		var RU_KEYS = "ёйцукенгшщзхъфывапролджэячсмитьбю";
		var EN_TO_RU = {};
		var RU_TO_EN = {};
		for (var k = 0; k < EN_KEYS.length; k++) {
			EN_TO_RU[EN_KEYS.charAt(k)] = RU_KEYS.charAt(k);
			RU_TO_EN[RU_KEYS.charAt(k)] = EN_KEYS.charAt(k);
		}

		/** Retype a lowercase token as if the other layout had been active. */
		function swapLayout(token) {
			var out = "";
			var changed = false;
			for (var i = 0; i < token.length; i++) {
				var ch = token.charAt(i);
				var mapped = EN_TO_RU[ch] || RU_TO_EN[ch];
				if (mapped !== undefined) { out += mapped; changed = true; } else out += ch;
			}
			return changed ? out : null;
		}

		// ---------- fuzzy scoring ----------

		var SEPARATOR = /[\s\-_.\/\\:;,|()[\]{}<>«»"'`#@!?+=*&~]/;

		function isUpper(ch) { return ch !== ch.toLowerCase() && ch === ch.toUpperCase(); }

		function isBoundary(raw, i) {
			if (i <= 0) return true;
			var prev = raw.charAt(i - 1);
			if (SEPARATOR.test(prev)) return true;
			var cur = raw.charAt(i);
			if (isUpper(cur) && !isUpper(prev)) return true;
			return /\d/.test(cur) !== /\d/.test(prev);
		}

		function range(from, to) {
			var out = [];
			for (var i = from; i < to; i++) out.push(i);
			return out;
		}

		/**
		 * Score one lowercase token against a text.
		 * @returns {{score:number, positions:number[]}|null} null when the token is not a subsequence.
		 */
		function scoreToken(token, raw) {
			if (!token) return { score: 0, positions: [] };
			if (!raw) return null;
			var text = raw.toLowerCase();
			// 1) contiguous substring: strongest, prefer an occurrence at a word start.
			var idx = text.indexOf(token);
			if (idx !== -1) {
				var best = idx;
				for (var j = idx; j !== -1; j = text.indexOf(token, j + 1)) {
					if (isBoundary(raw, j)) { best = j; break; }
				}
				var score = 100 + token.length * 10 + (isBoundary(raw, best) ? 40 : 0) + (best === 0 ? 30 : 0) - Math.min(best, 30);
				return { score: score, positions: range(best, best + token.length) };
			}
			// 2) subsequence: try a few start positions, keep the best alignment.
			var first = token.charAt(0);
			var bestResult = null;
			var tries = 0;
			for (var start = text.indexOf(first); start !== -1 && tries < 24; start = text.indexOf(first, start + 1), tries++) {
				var positions = [];
				var ti = 0;
				var s = 0;
				var last = -2;
				for (var i = start; i < text.length && ti < token.length; i++) {
					if (text.charAt(i) !== token.charAt(ti)) continue;
					var bonus = 1;
					if (i === last + 1) bonus += 5;
					if (isBoundary(raw, i)) bonus += 8;
					s += bonus;
					positions.push(i);
					last = i;
					ti++;
				}
				if (ti < token.length) break; // later starts cannot complete either
				var gaps = positions[positions.length - 1] - positions[0] + 1 - positions.length;
				s -= Math.min(gaps, 40) * 0.5;
				if (bestResult === null || s > bestResult.score) bestResult = { score: s, positions: positions };
			}
			return bestResult;
		}

		/** Best match of a token in a field, also trying the other keyboard layout. */
		function matchField(token, raw) {
			var direct = scoreToken(token, raw);
			var swapped = swapLayout(token);
			var alt = swapped === null ? null : scoreToken(swapped, raw);
			if (alt !== null) alt = { score: alt.score - 5, positions: alt.positions };
			if (direct === null) return alt;
			if (alt === null) return direct;
			return alt.score > direct.score ? alt : direct;
		}

		/**
		 * Rank sessions for a query.
		 * @param entries - collected sessions.
		 * @param query - raw input.
		 * @param mru - session ids, most recently opened first.
		 * @returns [{entry, score, positions}] best first.
		 */
		function rankSessions(entries, query, mru) {
			var mruRank = {};
			for (var m = 0; m < mru.length; m++) if (mruRank[mru[m]] === undefined) mruRank[mru[m]] = m;
			var recencyCompare = function (a, b) {
				var ra = mruRank[a.entry.id];
				var rb = mruRank[b.entry.id];
				if (ra !== undefined || rb !== undefined) {
					if (ra === undefined) return 1;
					if (rb === undefined) return -1;
					if (ra !== rb) return ra - rb;
				}
				return (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0);
			};
			var q = query.trim().toLowerCase();
			if (q === "") {
				return entries.map(function (entry) { return { entry: entry, score: 0, positions: [] }; }).sort(recencyCompare);
			}
			var tokens = q.split(/\s+/).filter(Boolean);
			var out = [];
			for (var e = 0; e < entries.length; e++) {
				var entry = entries[e];
				var total = 0;
				var positions = [];
				var ok = true;
				for (var t = 0; t < tokens.length; t++) {
					var inTitle = matchField(tokens[t], entry.title);
					var inWorkspace = matchField(tokens[t], entry.workspace);
					var workspaceScore = inWorkspace === null ? -Infinity : inWorkspace.score * 0.5;
					if (inTitle === null && inWorkspace === null) { ok = false; break; }
					if (inTitle !== null && inTitle.score >= workspaceScore) {
						total += inTitle.score;
						positions = positions.concat(inTitle.positions);
					} else total += workspaceScore;
				}
				if (!ok) continue;
				if (tokens.length > 1 && entry.title && entry.title.toLowerCase().indexOf(q) !== -1) total += 50;
				var rank = mruRank[entry.id];
				if (rank !== undefined && rank < 10) total += (10 - rank) * 1.5;
				out.push({ entry: entry, score: total, positions: positions });
			}
			out.sort(function (a, b) { return b.score !== a.score ? b.score - a.score : recencyCompare(a, b); });
			return out;
		}

		// ---------- data ----------

		function basename(path) {
			if (!path) return "";
			var parts = String(path).replace(/[\\/]+$/, "").split(/[\\/]/);
			return parts[parts.length - 1] || String(path);
		}

		function mainSessionId(list) {
			var byId = (list && list.byId) || {};
			for (var id in byId) {
				var s = byId[id];
				if (s && s.retainedBy && (s.retainedBy.mainView || 0) > 0) return s.id;
			}
			return undefined;
		}

		/** Sessions a user can open: no blanks, no subagent children, no archived rows. */
		function collectEntries(list, workspaces) {
			var byId = (list && list.byId) || {};
			var ids = (list && list.ids) || Object.keys(byId);
			var items = (workspaces && workspaces.items) || [];
			var archived = {};
			((workspaces && workspaces.archivedSessionIds) || []).forEach(function (id) { archived[id] = true; });
			var workspaceOf = {};
			items.forEach(function (w) {
				(w.sessionIds || []).forEach(function (sid) { if (workspaceOf[sid] === undefined) workspaceOf[sid] = w.title || basename(w.path); });
			});
			var current = mainSessionId(list);
			var out = [];
			var seen = {};
			ids.forEach(function (id) {
				var s = byId[id];
				if (!s || seen[s.id] || s.blank || s.origin === "subagent" || archived[s.id]) return;
				seen[s.id] = true;
				out.push({
					id: s.id,
					title: typeof s.title === "string" ? s.title.trim() : "",
					workspace: workspaceOf[s.id] !== undefined ? workspaceOf[s.id] : basename(s.cwd),
					updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.parse(s.updatedAt || "") || 0,
					running: s.running === true,
					current: s.id === current,
				});
			});
			return out;
		}

		function relTime(stamp, now) {
			if (!stamp) return "";
			var ms = stamp < 1e12 ? stamp * 1000 : stamp;
			var min = Math.floor(((now || Date.now()) - ms) / 60000);
			if (min < 1) return "сейчас";
			if (min < 60) return min + " мин";
			var hours = Math.floor(min / 60);
			if (hours < 24) return hours + " ч";
			var days = Math.floor(hours / 24);
			if (days < 30) return days + " дн";
			var months = Math.floor(days / 30);
			return months < 12 ? months + " мес" : Math.floor(months / 12) + " г";
		}

		function readMru() {
			try {
				var raw = window.localStorage.getItem(MRU_KEY);
				var parsed = raw ? JSON.parse(raw) : [];
				return Array.isArray(parsed) ? parsed.filter(function (x) { return typeof x === "string"; }) : [];
			} catch (_e) { return []; }
		}

		function writeMru(list) {
			try { window.localStorage.setItem(MRU_KEY, JSON.stringify(list)); } catch (_e) { /* storage unavailable */ }
		}

		function pushMru(list, id) {
			return [id].concat(list.filter(function (x) { return x !== id; })).slice(0, MRU_LIMIT);
		}

		// ---------- tiny observable ----------

		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				get: function () { return value; },
				set: function (next) { value = next; listeners.forEach(function (l) { l(); }); },
				subscribe: function (l) { listeners.add(l); return function () { listeners.delete(l); }; },
			};
		}

		function useExternal(store, read) {
			var subscribe = useCallback(function (listener) {
				var off = store.subscribe(listener);
				return typeof off === "function" ? off : function () {};
			}, [store]);
			return React.useSyncExternalStore(subscribe, read);
		}

		// ---------- UI ----------

		function Highlight(props) {
			var text = props.text;
			var marks = {};
			props.positions.forEach(function (p) { marks[p] = true; });
			var parts = [];
			var buf = "";
			var on = false;
			for (var i = 0; i < text.length; i++) {
				var mark = marks[i] === true;
				if (mark !== on && buf) { parts.push(on ? h("mark", { key: i, className: "qs-mark" }, buf) : buf); buf = ""; }
				on = mark;
				buf += text.charAt(i);
			}
			if (buf) parts.push(on ? h("mark", { key: "end", className: "qs-mark" }, buf) : buf);
			return h(React.Fragment, null, parts);
		}

		function Palette(props) {
			var services = props.services;
			var list = useExternal(services.sessions.list, function () { return services.sessions.list.getSnapshot(); });
			var ws = useExternal(services.workspaces.list, function () { return services.workspaces.list.getSnapshot(); });
			var entries = useMemo(function () { return collectEntries(list, ws); }, [list, ws]);
			var mru = useMemo(function () { return services.mru.get(); }, []);
			var queryState = useState("");
			var query = queryState[0];
			var setQuery = queryState[1];
			var ranked = useMemo(function () { return rankSessions(entries, query, mru).slice(0, RESULT_LIMIT); }, [entries, query, mru]);
			var contentState = useState({ query: "", items: [] });
			var content = contentState[0];
			var setContent = contentState[1];

			// Matches inside the conversation text, after a pause in typing.
			useEffect(function () {
				var q = query.trim();
				if (q.length < CONTENT_MIN_QUERY || typeof services.sessions.search !== "function") {
					setContent({ query: q, items: [] });
					return undefined;
				}
				var controller = new AbortController();
				var timer = setTimeout(function () {
					Promise.resolve(services.sessions.search(q, controller.signal)).then(function (result) {
						if (controller.signal.aborted || !result || !result.ok) return;
						var items = (result.value && result.value.items) || [];
						setContent({ query: q, items: items });
					}).catch(function () { /* metadata results stay; nothing to report */ });
				}, CONTENT_DEBOUNCE_MS);
				return function () { clearTimeout(timer); controller.abort(); };
			}, [query]);

			var rows = useMemo(function () {
				var out = ranked.map(function (r) { return { entry: r.entry, positions: r.positions, snippet: null }; });
				if (content.query !== query.trim() || content.items.length === 0) return out;
				var shown = {};
				out.forEach(function (r) { shown[r.entry.id] = true; });
				var byId = {};
				entries.forEach(function (e) { byId[e.id] = e; });
				var extra = 0;
				for (var i = 0; i < content.items.length && extra < CONTENT_LIMIT; i++) {
					var item = content.items[i];
					var entry = byId[item.sessionId];
					if (!entry || shown[entry.id]) continue;
					shown[entry.id] = true;
					out.push({ entry: entry, positions: [], snippet: typeof item.snippet === "string" ? item.snippet : "", contentMatch: true });
					extra++;
				}
				return out;
			}, [ranked, content, entries, query]);

			var initialIndex = function (q, list2) {
				if (q.trim() === "" && list2.length > 1 && list2[0].entry.current) return 1;
				return 0;
			};
			var selState = useState(function () { return initialIndex("", rows); });
			var sel = Math.min(selState[0], Math.max(rows.length - 1, 0));
			var setSel = selState[1];
			var lastQuery = useRef(query);
			useEffect(function () {
				if (lastQuery.current === query) return;
				lastQuery.current = query;
				setSel(initialIndex(query, rows));
			}, [query, rows]);

			var inputRef = useRef(null);
			var listRef = useRef(null);
			useEffect(function () {
				var input = inputRef.current;
				if (input) input.focus({ preventScroll: true });
			}, []);
			useEffect(function () {
				var box = listRef.current;
				var node = box && box.querySelector("[data-qs-index='" + sel + "']");
				if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
			}, [sel, rows]);

			var open = function (row) {
				if (!row) return;
				services.openSession(row.entry.id);
			};
			var move = function (delta) {
				if (rows.length === 0) return;
				var next = sel + delta;
				if (Math.abs(delta) === 1) next = (next + rows.length) % rows.length;
				else next = Math.max(0, Math.min(rows.length - 1, next));
				setSel(next);
			};
			var onKeyDown = function (e) {
				// Keep Enter/Esc away from DSH's DOM-level fixed actions (approve/reject, double-Esc stop).
				e.stopPropagation();
				var native = e.nativeEvent || {};
				if (native.isComposing || e.keyCode === 229) return;
				var key = e.key;
				if (key === "Escape") { e.preventDefault(); services.close(true); return; }
				if (key === "Enter") { e.preventDefault(); open(rows[sel]); return; }
				if (key === "ArrowDown" || (key === "Tab" && !e.shiftKey)) { e.preventDefault(); move(1); return; }
				if (key === "ArrowUp" || (key === "Tab" && e.shiftKey)) { e.preventDefault(); move(-1); return; }
				if (key === "PageDown") { e.preventDefault(); move(PAGE_STEP); return; }
				if (key === "PageUp") { e.preventDefault(); move(-PAGE_STEP); return; }
				if (e.code === "Space" && e.ctrlKey) { e.preventDefault(); services.close(true); return; }
			};

			var now = Date.now();
			var firstContentIndex = -1;
			for (var r = 0; r < rows.length; r++) if (rows[r].contentMatch) { firstContentIndex = r; break; }

			return h("div", { className: "qs-root", role: "presentation" },
				h("div", { className: "qs-mask", "aria-hidden": "true", onMouseDown: function (e) { e.preventDefault(); services.close(true); } }),
				h("div", {
					className: "qs-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "Переход к сессии",
					"data-shortcut-modal": MODAL_ID,
					onKeyDown: onKeyDown,
				},
					h("div", { className: "qs-input-row" },
						h("svg", { className: "qs-search-icon", width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" },
							h("circle", { cx: 7, cy: 7, r: 4.75, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }),
							h("path", { d: "M10.5 10.5 14 14", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })),
						h("input", {
							ref: inputRef,
							className: "qs-input",
							type: "text",
							value: query,
							placeholder: "Перейти к сессии…",
							spellCheck: false,
							autoComplete: "off",
							role: "combobox",
							"aria-expanded": "true",
							"aria-controls": "qs-list",
							"aria-activedescendant": rows.length ? "qs-row-" + sel : undefined,
							onChange: function (e) { setQuery(e.target.value); },
						})),
					h("div", { id: "qs-list", className: "qs-list", role: "listbox", ref: listRef },
						rows.length === 0
							? h("div", { className: "qs-empty" }, entries.length === 0 ? "Сессий пока нет" : "Ничего не найдено")
							: rows.map(function (row, i) {
								var entry = row.entry;
								var title = entry.title || "Без названия";
								return h(React.Fragment, { key: entry.id },
									i === firstContentIndex ? h("div", { className: "qs-section" }, "Найдено в переписке") : null,
									h("div", {
										id: "qs-row-" + i,
										"data-qs-index": i,
										role: "option",
										"aria-selected": i === sel,
										className: "qs-row" + (i === sel ? " qs-selected" : ""),
										onMouseMove: function () { if (i !== sel) setSel(i); },
										onMouseDown: function (e) { e.preventDefault(); },
										onClick: function () { open(row); },
									},
										h("span", { className: "qs-dot" + (entry.running ? " qs-running" : ""), "aria-hidden": "true" }),
										h("span", { className: "qs-main" },
											h("span", { className: "qs-title" + (entry.title ? "" : " qs-untitled") },
												entry.title ? h(Highlight, { text: entry.title, positions: row.positions }) : title),
											row.snippet ? h("span", { className: "qs-snippet" }, row.snippet) : null),
										entry.current ? h("span", { className: "qs-tag" }, "открыта") : null,
										h("span", { className: "qs-workspace" }, entry.workspace || ""),
										h("span", { className: "qs-time" }, relTime(entry.updatedAt, now))));
							})),
					h("div", { className: "qs-footer" },
						h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), " выбрать"),
						h("span", null, h("kbd", null, "Enter"), " открыть"),
						h("span", null, h("kbd", null, "Esc"), " закрыть"))));
		}

		// The palette is fixed dark glass on purpose: skins make the theme's bg-base
		// translucent, and text on a translucent dialog over the chat was unreadable.
		// The theme tokens the rows use are redefined on the dialog itself, so every
		// rule below picks up the dark values without touching the rest of the app.
		var CSS = [
			".qs-root{position:fixed;inset:0;z-index:1200;pointer-events:auto;display:flex;justify-content:center;align-items:flex-start;padding-top:max(12vh,calc(var(--dsh-frame-top-clearance,0px) + 24px))}",
			".qs-mask{position:absolute;inset:0;background:rgba(0,0,0,.4)}",
			".qs-dialog{position:relative;width:min(640px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 18vh));display:flex;flex-direction:column;overflow:hidden;" +
				"--dsw-alias-label-primary:#f2f3f5;--dsw-alias-label-secondary:rgba(235,236,240,.74);--dsw-alias-label-tertiary:rgba(235,236,240,.52);" +
				"--dsw-alias-border-l3:rgba(255,255,255,.12);--dsw-alias-interactive-bg-hover:rgba(255,255,255,.1);" +
				"background:rgba(18,20,26,.82);-webkit-backdrop-filter:blur(22px) saturate(140%);backdrop-filter:blur(22px) saturate(140%);" +
				"color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);" +
				"border-radius:var(--dsw-radius-lg,12px);box-shadow:0 18px 48px rgba(0,0,0,.45);font-size:14px;color-scheme:dark}",
			".qs-input-row{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3))}",
			".qs-search-icon{flex:none;color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:24px;padding:2px 0}",
			".qs-input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-list{overflow-y:auto;padding:6px;flex:1;min-height:0}",
			".qs-row{display:flex;align-items:center;gap:10px;min-height:36px;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer}",
			".qs-row.qs-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
			".qs-dot{flex:none;width:6px;height:6px;border-radius:50%;background:transparent}",
			".qs-dot.qs-running{background:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".qs-main{flex:1;min-width:0;display:flex;flex-direction:column}",
			".qs-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px}",
			".qs-untitled{color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-snippet{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#666)}",
			".qs-mark{background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font-weight:600}",
			".qs-tag{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
			".qs-workspace{flex:none;max-width:34%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-time{flex:none;width:44px;text-align:right;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}",
			".qs-section{padding:8px 10px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-footer{display:flex;gap:16px;padding:7px 14px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));font-size:12px;color:var(--dsw-alias-label-tertiary,#888)}",
			".qs-footer kbd{font:inherit;font-size:11px;padding:0 4px;margin-right:2px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4))}",
		].join("\n");

		var PANEL_SLOTS = 9;
		// DSH command ids: every dot segment must start with a letter ("sidebar.panel.1" is invalid
		// and would make the registry reject the whole catalog).
		var PANEL_COMMAND_PREFIX = "sidebar.openPanel";
		var SIDEBAR_CSS_TAG = "@deepseek-ai/dsh-client-ui-sidebar/SidebarRoot.module.css";
		var sidebarPrefix = null;
		// Panel rows of the left sidebar, in order. CSS-module class names are hashed per DSH
		// build, so the prefix is read from the sidebar's own <style data-plugin-css> tag.
		function panelRows() {
			if (sidebarPrefix === null) {
				var tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(SIDEBAR_CSS_TAG) + "]");
				var match = tag && /\.([A-Za-z0-9-]+)_root\{/.exec(tag.textContent || "");
				if (!match) return [];
				sidebarPrefix = match[1];
			}
			var list = document.querySelector("." + sidebarPrefix + "_panelList");
			return list ? Array.prototype.slice.call(list.querySelectorAll("." + sidebarPrefix + "_panelRow")) : [];
		}

		module.exports.inject = ["slots", "sessions", "workspaces", "uiWorkspace", "shortcuts"];
		module.exports.apply = function apply(ctx) {
			var sessions = ctx.get("sessions");
			var workspaces = ctx.get("workspaces");
			var uiWorkspace = ctx.get("uiWorkspace");
			var openState = createStore(false);
			var mru = createStore(readMru());
			var returnFocus = null;

			var close = function (restoreFocus) {
				if (!openState.get()) return;
				openState.set(false);
				var target = returnFocus;
				returnFocus = null;
				if (restoreFocus && target && target.isConnected && typeof target.focus === "function") {
					try { target.focus({ preventScroll: true }); } catch (_e) { /* element gone */ }
				}
			};
			var show = function () {
				if (openState.get()) return;
				var active = document.activeElement;
				returnFocus = active && active !== document.body ? active : null;
				openState.set(true);
			};
			var toggle = function () { if (openState.get()) close(true); else show(); };
			var services = {
				sessions: sessions,
				workspaces: workspaces,
				mru: mru,
				close: close,
				openSession: function (id) {
					close(false);
					try { uiWorkspace.openSession(id); } catch (error) { console.warn("dsh-quick-switch: open failed", error); }
				},
			};

			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-dsh-quick-switch", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, "dsh-quick-switch: stylesheet");

			// Remember which sessions were opened, newest first (drives the empty-query list).
			ctx.effect(function () {
				var lastMain;
				var track = function () {
					var snapshot = sessions.list.getSnapshot();
					var id = mainSessionId(snapshot);
					if (!id || id === lastMain) return;
					lastMain = id;
					var row = snapshot.byId && snapshot.byId[id];
					if (!row || row.blank || row.origin === "subagent") return;
					var next = pushMru(mru.get(), id);
					mru.set(next);
					writeMru(next);
				};
				track();
				var off = sessions.list.subscribe(track);
				return typeof off === "function" ? off : function () {};
			}, "dsh-quick-switch: recent sessions");

			ctx.effect(function () {
				return ctx.shortcuts.register({
					id: COMMAND_ID,
					label: function () { return "Быстрый переход к сессии"; },
					aliases: ["quick switch", "go to session", "switch session", "quick open", "ctrl p"],
					// Every declared profile must pass DSH's validator: Space is reserved on Web and
					// Linux Desktop, so those get Ctrl+Shift+Space or stay unbound.
					defaults: {
						"desktop:windows": { code: "Space", modifiers: ["primary"] },
						"desktop:macos": { code: "Space", modifiers: ["primary"] },
						"web:windows": { code: "Space", modifiers: ["primary", "shift"] },
						"web:macos": { code: "Space", modifiers: ["primary", "shift"] },
					},
					regions: ["page", "editable"],
					modals: [MODAL_ID],
					resolve: function () { return { status: "handled", run: toggle }; },
				});
			}, "dsh-quick-switch: shortcut");

			// Alt+1…9: open the N-th entry of the left sidebar's panel list (Artifacts, tasks,
			// notes, …) in its on-screen order, so plugin panels get keys too. Registered with
			// DSH's shortcut registry, so they show up in Ctrl+/ and can be rebound there.
			for (var slot = 1; slot <= PANEL_SLOTS; slot++) (function (n) {
				ctx.effect(function () {
					var binding = { code: "Digit" + n, modifiers: ["alt"] };
					return ctx.shortcuts.register({
						id: PANEL_COMMAND_PREFIX + n,
						label: function () {
							var row = panelRows()[n - 1];
							var name = row ? (row.getAttribute("aria-label") || row.textContent || "").trim() : "";
							return "Панель сайдбара " + n + (name ? " — " + name : "");
						},
						aliases: ["sidebar panel " + n, "panel " + n],
						defaults: { "desktop:windows": binding, "desktop:linux": binding },
						regions: ["page", "editable"],
						resolve: function () {
							var row = panelRows()[n - 1];
							if (!row) return { status: "pass" };
							return { status: "handled", run: function () { row.click(); } };
						},
					});
				}, "dsh-quick-switch: sidebar panel " + n);
			})(slot);

			function Overlay() {
				var isOpen = useExternal(openState, openState.get);
				if (!isOpen) return null;
				var palette = h(Palette, { services: services });
				return createPortal !== null ? createPortal(palette, document.body) : palette;
			}

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({ name: "shell.overlay", id: "quick-switch" }, Overlay);
			});

			ctx.effect(function () {
				return function () { openState.set(false); };
			}, "dsh-quick-switch: close on unload");
		};
		module.exports.__internals = {
			swapLayout: swapLayout,
			scoreToken: scoreToken,
			rankSessions: rankSessions,
			collectEntries: collectEntries,
			mainSessionId: mainSessionId,
			relTime: relTime,
			pushMru: pushMru,
			COMMAND_ID: COMMAND_ID,
		};
		return module.exports;
	},
});
