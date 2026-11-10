// dsh-task-board, browser half. Hand-written, no build step: React comes from the
// module loader, the host half answers on /api/dsh-task-board/{rpc,media}.
//
// Layout: "Приёмка задач" — a task list on the left, the selected task on the right.
// Clicking a row (or ↑/↓ in the list) swaps the right pane; review actions stay at
// the bottom of the right pane.
//
// Refresh: the panel polls one cheap number (the board version) and re-reads tasks
// only when it changes; the host bumps it on its own writes and on fs.watch events.
window.__ModuleLoader__.load({
	id: "dsh-task-board",
	factory: (require) => {
		var module = { exports: {} };
		var React = require("react");
		var h = React.createElement;
		var Fragment = React.Fragment;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var useRef = React.useRef;
		var useMemo = React.useMemo;

		var PANEL_ID = "dsh-task-board";
		var RPC_URL = "api/dsh-task-board/rpc";
		var MEDIA_URL = "api/dsh-task-board/media";
		var VERSION_POLL_MS = 2500;
		var WAIT_MS = 25000;
		var TEXT_PREVIEW_LIMIT = 200 * 1024;
		var CONFIRM_RESET_MS = 4000;

		var STATUS = {
			review: { label: "На проверке", tone: "accent" },
			changes_requested: { label: "На доработке", tone: "warn" },
			approved: { label: "Принято", tone: "ok" },
			in_progress: { label: "В работе", tone: "neutral" },
			done: { label: "Выполнено", tone: "neutral" },
		};
		// Order of the list: what needs the reviewer first.
		var STATUS_ORDER = { review: 0, approved: 1, changes_requested: 2, in_progress: 3, done: 4 };
		var HISTORY_TEXT = {
			created: "создал(а) задачу",
			submitted: "отправил(а) на проверку",
			resubmitted: "отправил(а) на проверку повторно",
			commented: "оставил(а) комментарий",
			approved: "принял(а)",
			changes_requested: "вернул(а) на доработку",
			done: "закрыл(а) задачу",
			restored: "восстановил(а) из архива",
		};

		// Review comment drafts survive switching between tasks (until the page reloads).
		var drafts = new Map();

		// ---------- helpers ----------

		function plural(n, forms) {
			var mod10 = n % 10;
			var mod100 = n % 100;
			if (mod10 === 1 && mod100 !== 11) return forms[0];
			if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
			return forms[2];
		}

		function relTime(iso, nowMs) {
			var t = Date.parse(iso || "");
			if (!Number.isFinite(t)) return "";
			var diff = Math.floor(((nowMs || Date.now()) - t) / 60000);
			if (diff < 1) return "только что";
			if (diff < 60) return diff + " мин назад";
			var hours = Math.floor(diff / 60);
			if (hours < 24) return hours + " ч назад";
			var days = Math.floor(hours / 24);
			if (days < 7) return days + " " + plural(days, ["день", "дня", "дней"]) + " назад";
			return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
		}

		function fullTime(iso) {
			var t = Date.parse(iso || "");
			if (!Number.isFinite(t)) return "";
			return new Date(t).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
		}

		function formatBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "";
			if (n < 1024) return n + " Б";
			if (n < 1024 * 1024) return Math.round(n / 1024) + " КБ";
			return (n / (1024 * 1024)).toFixed(1) + " МБ";
		}

		function mediaUrl(id, file, archived, version) {
			return (
				MEDIA_URL +
				"?id=" +
				encodeURIComponent(id) +
				"&file=" +
				encodeURIComponent(file) +
				(archived ? "&archived=1" : "") +
				(version ? "&v=" + encodeURIComponent(String(version)) : "")
			);
		}

		function errorText(error) {
			if (!error) return "Неизвестная ошибка";
			return error.message || error.code || "Ошибка";
		}

		/** Only http(s) URLs become links; anything else is shown as text. */
		function safeUrl(value) {
			if (typeof value !== "string" || value.trim() === "") return null;
			try {
				var url = new URL(value.trim());
				return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
			} catch (_) {
				return null;
			}
		}

		/** "org/repo #123" for GitHub/GitLab/Bitbucket/Gitea-style URLs, host+path otherwise. */
		function prLabel(value) {
			var href = safeUrl(value);
			if (!href) return String(value || "");
			var url = new URL(href);
			var parts = url.pathname.split("/").filter(Boolean);
			var marker = -1;
			for (var i = 0; i < parts.length; i++) {
				if (parts[i] === "pull" || parts[i] === "pulls" || parts[i] === "merge_requests" || parts[i] === "pull-requests") {
					marker = i;
					break;
				}
			}
			if (marker >= 2 && /^\d+$/.test(parts[marker + 1] || "")) {
				var repo = parts.slice(0, marker).filter(function (p) { return p !== "-" && p !== "projects" && p !== "repos"; });
				return repo.slice(-2).join("/") + " #" + parts[marker + 1];
			}
			return url.host + url.pathname.replace(/\/$/, "");
		}

		/** Just the PR number ("1375"), or "" when the link has none. */
		function prNumber(value) {
			var label = prLabel(value);
			var match = /#(\d+)$/.exec(label);
			if (match) return match[1];
			var bare = /(?:^|\D)(\d{1,7})$/.exec(String(value || "").trim());
			return bare && !safeUrl(value) ? bare[1] : "";
		}

		/** Chip colour from the words of a label. */
		function labelTone(label) {
			var text = String(label || "").toLowerCase();
			if (/конфликт|conflict|красн|\bred\b|fail|упал|ошибк|error|broken|сломан|блок|block/.test(text)) return "bad";
			if (/зел[её]н|green|pass|\bok\b|✓|✔|success|прош[её]л|готов|merged|смерж/.test(text)) return "ok";
			if (/\bqa\b|review|ревью|wait|ждёт|ждет|pending|draft|черновик|warn|скринов нет/.test(text)) return "warn";
			return "neutral";
		}

		/** Split a description into titled sections on `## Heading` lines (outside fenced code). */
		function parseSections(description) {
			var text = String(description || "").replace(/\r\n/g, "\n");
			if (text.trim() === "") return [];
			var sections = [];
			var current = { title: "Что сделано", lines: [] };
			var inFence = false;
			text.split("\n").forEach(function (line) {
				if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
				var heading = inFence ? null : /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
				if (heading) {
					if (current.lines.join("\n").trim() !== "") sections.push(current);
					current = { title: heading[1], lines: [] };
				} else current.lines.push(line);
			});
			if (current.lines.join("\n").trim() !== "" || sections.length === 0) sections.push(current);
			return sections.map(function (section) { return { title: section.title, text: section.lines.join("\n").replace(/^\n+|\s+$/g, "") }; });
		}

		// ---------- markdown (a safe subset, rendered to React nodes, never to HTML) ----------

		var INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()\[\]"']+[^\s<>()\[\]"'.,;:!?])/g;

		function renderInline(text, keyPrefix) {
			var out = [];
			var last = 0;
			var n = 0;
			var match;
			INLINE_RE.lastIndex = 0;
			while ((match = INLINE_RE.exec(text)) !== null) {
				if (match.index > last) out.push(text.slice(last, match.index));
				var key = keyPrefix + "-" + n++;
				if (match[1]) out.push(h("code", { key: key }, match[1].slice(1, -1)));
				else if (match[2]) out.push(h("strong", { key: key }, match[2].slice(2, -2)));
				else if (match[3]) {
					var label = match[3].slice(1, match[3].indexOf("]("));
					out.push(h("a", { key: key, href: match[4], target: "_blank", rel: "noopener noreferrer" }, label));
				} else if (match[5]) out.push(h("a", { key: key, href: match[5], target: "_blank", rel: "noopener noreferrer" }, match[5]));
				last = match.index + match[0].length;
			}
			if (last < text.length) out.push(text.slice(last));
			return out;
		}

		/** Lines of one paragraph, soft breaks kept. */
		function renderLines(lines, keyPrefix) {
			var out = [];
			lines.forEach(function (line, index) {
				if (index > 0) out.push(h("br", { key: keyPrefix + "-br" + index }));
				out.push.apply(out, renderInline(line, keyPrefix + "-l" + index));
			});
			return out;
		}

		/** Paragraphs, `-`/`*`/`1.` lists, `>` quotes and fenced code; everything else is text. */
		function renderMarkdown(text) {
			var lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
			var blocks = [];
			var i = 0;
			var k = 0;
			function key() { return "b" + k++; }
			while (i < lines.length) {
				var line = lines[i];
				if (line.trim() === "") { i++; continue; }
				var fence = /^\s{0,3}(```|~~~)\s*(\S*)/.exec(line);
				if (fence) {
					var code = [];
					i++;
					while (i < lines.length && !new RegExp("^\\s{0,3}" + fence[1]).test(lines[i])) code.push(lines[i++]);
					i++;
					blocks.push(h("pre", { key: key(), className: "tb-md-pre" }, h("code", null, code.join("\n"))));
					continue;
				}
				var bullet = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
				if (bullet) {
					var ordered = /\d/.test(bullet[1]);
					var items = [];
					while (i < lines.length) {
						var m = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
						if (!m || /\d/.test(m[1]) !== ordered) break;
						var item = [m[2]];
						i++;
						// Indented continuation lines belong to the item.
						while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/.test(lines[i])) item.push(lines[i++].trim());
						items.push(item);
					}
					blocks.push(h(ordered ? "ol" : "ul", { key: key(), className: "tb-md-list" }, items.map(function (item, index) { return h("li", { key: index }, renderLines(item, "i" + index)); })));
					continue;
				}
				if (/^\s{0,3}>/.test(line)) {
					var quote = [];
					while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
					blocks.push(h("blockquote", { key: key(), className: "tb-md-quote" }, renderLines(quote, "q")));
					continue;
				}
				var para = [];
				while (i < lines.length && lines[i].trim() !== "" && !/^\s{0,3}(```|~~~)/.test(lines[i]) && !/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/.test(lines[i]) && !/^\s{0,3}>/.test(lines[i])) para.push(lines[i++]);
				blocks.push(h("p", { key: key() }, renderLines(para, "p")));
			}
			return blocks;
		}

		function sortTasks(tasks) {
			return tasks.slice().sort(function (a, b) {
				var sa = STATUS_ORDER[a.status] !== undefined ? STATUS_ORDER[a.status] : 9;
				var sb = STATUS_ORDER[b.status] !== undefined ? STATUS_ORDER[b.status] : 9;
				if (sa !== sb) return sa - sb;
				return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
			});
		}

		function counters(tasks) {
			var out = { review: 0, approved: 0, changes: 0, working: 0 };
			tasks.forEach(function (task) {
				if (task.status === "approved") out.approved++;
				else if (task.status === "changes_requested") out.changes++;
				else if (task.status === "in_progress") out.working++;
				else out.review++;
			});
			return out;
		}

		function byLabel(by) {
			if (!by || by === "reviewer") return "Ты";
			return by;
		}

		/** True when the file changed after the reviewer's last decision. */
		function isNewSince(file, review) {
			if (!review || !review.at || !file || !file.mtime) return false;
			var at = Date.parse(review.at);
			return Number.isFinite(at) && file.mtime > at + 1000;
		}

		async function rpc(action, payload) {
			var response;
			try {
				response = await fetch(RPC_URL, {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ action: action }, payload || {})),
				});
			} catch (error) {
				return { ok: false, error: { code: "network", message: "Нет связи с DSH: " + ((error && error.message) || String(error)) } };
			}
			var data = null;
			try {
				data = await response.json();
			} catch (_) {}
			if (data && typeof data.ok === "boolean") return data;
			return {
				ok: false,
				error: {
					code: "http-" + response.status,
					message: response.status === 404 ? "Сервис доски не отвечает — перезапусти DSH, чтобы подхватилась серверная часть плагина" : "Ошибка сервера " + response.status,
				},
			};
		}

		function sleep(ms) {
			return new Promise(function (done) { setTimeout(done, ms); });
		}

		/**
		 * Keep one long poll open against the host: `wait` answers when the board version moves
		 * past ours (or after WAIT_MS). When `wait` is not available or keeps failing, fall back
		 * to asking for the version every few seconds. Pauses while the tab is hidden.
		 */
		function useBoardWatch(getVersion, onVersion, onError) {
			var saved = useRef({ getVersion: getVersion, onVersion: onVersion, onError: onError });
			saved.current = { getVersion: getVersion, onVersion: onVersion, onError: onError };
			useEffect(function () {
				var alive = true;
				var fallback = false;
				var failures = 0;
				async function loop() {
					while (alive) {
						if (typeof document !== "undefined" && document.hidden) {
							await sleep(1000);
							continue;
						}
						var since = saved.current.getVersion();
						var result = fallback ? await rpc("version") : await rpc("wait", { since: since, timeout: WAIT_MS });
						if (!alive) return;
						if (!result.ok) {
							failures++;
							if (result.error && result.error.code === "unknown-action") fallback = true;
							else if (failures >= 2) fallback = true;
							saved.current.onError(result.error);
							await sleep(VERSION_POLL_MS);
							continue;
						}
						failures = 0;
						saved.current.onVersion(result.value.version);
						if (fallback) await sleep(VERSION_POLL_MS);
					}
				}
				loop();
				return function () { alive = false; };
			}, []);
		}

		function copyText(text, onToast, message) {
			if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				navigator.clipboard.writeText(text).then(
					function () { onToast(message); },
					function () { onToast("Не удалось скопировать", true); },
				);
			}
		}

		// ---------- icons ----------

		function Svg(props, children) {
			var size = props.size || 16;
			return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", className: props.className }, children);
		}
		function IconBoard(props) {
			return Svg(props, [
				h("rect", { key: "a", x: 3.5, y: 4, width: 17, height: 16, rx: 2.5 }),
				h("path", { key: "b", d: "M7.5 9.5l1.5 1.5 3-3" }),
				h("path", { key: "c", d: "M7.5 15l1.5 1.5 3-3" }),
				h("path", { key: "d", d: "M14.5 10h3M14.5 15.5h3" }),
			]);
		}
		function IconRefresh(props) {
			return Svg(props, [h("path", { key: "a", d: "M20 11a8 8 0 1 0-2.3 5.7" }), h("path", { key: "b", d: "M20 4v7h-7" })]);
		}
		function IconFile(props) {
			return Svg(props, [h("path", { key: "a", d: "M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" }), h("path", { key: "b", d: "M14 3.5v5h5" })]);
		}
		function IconCopy(props) {
			return Svg(props, [h("rect", { key: "a", x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }), h("path", { key: "b", d: "M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" })]);
		}
		function IconFolder(props) {
			return Svg(props, [h("path", { key: "a", d: "M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" })]);
		}
		function IconImage(props) {
			return Svg(props, [h("rect", { key: "a", x: 3.5, y: 5, width: 17, height: 14, rx: 2 }), h("circle", { key: "b", cx: 9, cy: 10, r: 1.6 }), h("path", { key: "c", d: "M20 15.5l-4.5-4.5-6 6.5" })]);
		}
		function IconImageOff(props) {
			return Svg(props, [h("path", { key: "a", d: "M4 4l16 16" }), h("path", { key: "b", d: "M8.5 5h10a2 2 0 0 1 2 2v10M5.5 7.5V17a2 2 0 0 0 2 2H17" }), h("path", { key: "c", d: "M6 16l4-4 2 2" })]);
		}
		function IconVideo(props) {
			return Svg(props, [h("rect", { key: "a", x: 3.5, y: 6, width: 12, height: 12, rx: 2 }), h("path", { key: "b", d: "M15.5 10l5-3v10l-5-3z" })]);
		}
		function IconCheckbox(props) {
			return Svg(props, [h("rect", { key: "a", x: 4, y: 4, width: 16, height: 16, rx: 3 }), h("path", { key: "b", d: "M8 12.5l2.5 2.5 5.5-6" })]);
		}
		function IconClose(props) {
			return Svg(props, [h("path", { key: "a", d: "M6 6l12 12M18 6L6 18" })]);
		}
		function IconChevron(props) {
			return Svg(props, [h("path", { key: "a", d: props.left ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6" })]);
		}

		function SidebarIcon(props) {
			return h(IconBoard, { size: props && props.size ? props.size : 18 });
		}

		// ---------- small pieces ----------

		function Chip(props) {
			return h("span", { className: "tb-chip tb-chip-" + (props.tone || "neutral"), title: props.title }, props.children);
		}

		function StatusChip(props) {
			var meta = STATUS[props.status] || { label: props.status, tone: "neutral" };
			return h(Chip, { tone: meta.tone }, meta.label);
		}

		function TaskChips(props) {
			var task = props.task;
			var labels = Array.isArray(task.labels) ? task.labels : [];
			return h(
				"div",
				{ className: "tb-chips" },
				labels.map(function (label, index) { return h(Chip, { key: "l" + index, tone: labelTone(label) }, label); }),
				h(StatusChip, { key: "s", status: task.archived ? "done" : task.status }),
				task.round > 1 ? h(Chip, { key: "r", tone: "neutral" }, "раунд " + task.round) : null,
				props.noEvidence ? h(Chip, { key: "e", tone: "warn" }, "Скринов нет") : null,
				task.error ? h(Chip, { key: "x", tone: "bad", title: task.error }, "task.json битый") : null,
			);
		}

		function NewChip() {
			return h("span", { className: "tb-new", title: "Изменено после твоего последнего решения" }, "новое");
		}

		function Toast(props) {
			if (!props.message) return null;
			return h("div", { className: "tb-toast" + (props.error ? " tb-toast-error" : ""), role: "status", "aria-live": "polite" }, props.message);
		}

		// ---------- list ----------

		/** "4 скриншота · 1 видео · 2 файла · 2/5 галочек" in icons, for a list row. */
		function RowCounts(props) {
			var task = props.task;
			var files = task.files || {};
			var checks = task.checks || {};
			var parts = [];
			if (files.images > 0) parts.push(h("span", { key: "i", title: files.images + " " + plural(files.images, ["скриншот", "скриншота", "скриншотов"]) }, h(IconImage, { size: 13 }), files.images));
			if (files.videos > 0) parts.push(h("span", { key: "v", title: files.videos + " " + plural(files.videos, ["видео", "видео", "видео"]) }, h(IconVideo, { size: 13 }), files.videos));
			if (files.other > 0) parts.push(h("span", { key: "f", title: files.other + " " + plural(files.other, ["файл", "файла", "файлов"]) }, h(IconFile, { size: 13 }), files.other));
			if (checks.total > 0) parts.push(h("span", { key: "c", className: checks.done === checks.total ? "tb-row-count-ok" : "", title: "Отмечено критериев: " + checks.done + " из " + checks.total }, h(IconCheckbox, { size: 13 }), checks.done + "/" + checks.total));
			if (parts.length === 0) return null;
			return h("span", { className: "tb-row-counts" }, parts);
		}

		function TaskRow(props) {
			var task = props.task;
			var pr = task.pr ? prNumber(task.pr) : "";
			var cover = task.cover ? mediaUrl(task.id, task.cover, task.archived, task.coverVersion || task.updatedAt) : null;
			return h(
				"div",
				{ role: "listitem", className: "tb-row-item" },
				h(
					"button",
					{
						type: "button",
						className: "tb-row" + (props.selected ? " tb-row-selected" : ""),
						"aria-current": props.selected ? "true" : undefined,
						"data-task-id": task.id,
						onClick: function () { props.onSelect(task); },
					},
					h(
						"span",
						{ className: "tb-row-thumb" + (cover ? "" : " tb-row-thumb-empty"), "aria-hidden": "true" },
						cover ? h("img", { src: cover, alt: "", loading: "lazy" }) : h(IconImageOff, { size: 18 }),
					),
					h(
						"span",
						{ className: "tb-row-body" },
						h(
							"span",
							{ className: "tb-row-key" },
							h("span", { className: "tb-row-id" }, task.id),
							pr ? h("span", { className: "tb-row-pr" }, " · PR " + pr) : null,
						),
						h("span", { className: "tb-row-title" }, task.title),
						task.status === "changes_requested" && task.review && task.review.comment
							? h("span", { className: "tb-row-comment" }, "«" + task.review.comment + "»")
							: null,
						h("span", { className: "tb-row-foot" }, h(TaskChips, { task: task }), h(RowCounts, { task: task })),
					),
				),
			);
		}

		function TaskList(props) {
			var tasks = props.tasks;
			var listRef = useRef(null);
			function onKeyDown(event) {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				if (tasks.length === 0) return;
				event.preventDefault();
				var index = tasks.findIndex(function (task) { return task.id === props.selectedId; });
				var next = event.key === "ArrowDown" ? Math.min(tasks.length - 1, index + 1) : Math.max(0, index - 1);
				if (index === -1) next = 0;
				var task = tasks[next];
				props.onSelect(task);
				var escape = window.CSS && typeof window.CSS.escape === "function" ? window.CSS.escape : function (value) { return String(value).replace(/["\\]/g, "\\$&"); };
				var node = listRef.current && listRef.current.querySelector('[data-task-id="' + escape(task.id) + '"]');
				if (node) node.focus();
			}
			if (tasks.length === 0) return h("div", { className: "tb-list-empty" }, props.emptyText);
			return h(
				"div",
				{ className: "tb-list", role: "list", ref: listRef, onKeyDown: onKeyDown },
				tasks.map(function (task) {
					return h(TaskRow, { key: task.id, task: task, selected: task.id === props.selectedId, onSelect: props.onSelect });
				}),
			);
		}

		// ---------- how to connect an AI ----------

		var DSH_PHRASE = "Создай задачу на проверку, приложи скриншоты и отправь мне.";

		/** Join with the host's own separator; guessed from the path only when the host did not say. */
		function joinPath(root, name, sep) {
			var base = String(root || "").replace(/[\\/]+$/, "");
			var by = sep === "\\" || sep === "/" ? sep : base.indexOf("\\") !== -1 && base.indexOf("/") === -1 ? "\\" : "/";
			return base + by + name;
		}

		/** Real paths of the board as the host's OS writes them (`env` is what the host reported). */
		function boardPaths(root, env) {
			var paths = (env && env.paths) || {};
			var sep = env && env.sep;
			var dir = String(paths.root || root || "<папка доски>");
			return {
				root: dir,
				format: paths.format || joinPath(dir, "FORMAT.md", sep),
				events: paths.events || joinPath(dir, "events.jsonl", sep),
				archive: paths.archive || joinPath(dir, "_archive", sep),
				task: joinPath(dir, "<id-задачи>", sep),
			};
		}

		/** The text the user pastes into any AI that can read and write files on this machine. */
		function buildAgentPrompt(root, env) {
			var raw = boardPaths(root, env);
			// Backticks keep a path with spaces in one piece for the reader.
			var at = {};
			Object.keys(raw).forEach(function (key) { at[key] = "`" + raw[key] + "`"; });
			var dir = at.root;
			return [
				"У меня есть доска приёмки задач: папка " + dir,
				"Я смотрю её в панели «Задачи» в DeepSeek Harness и по каждой задаче жму «Принять» или «На доработку».",
				"",
				"Сначала прочитай " + at.format + " — там точный формат task.json, статусы и цикл работы. Дальше действуй по нему.",
				"",
				"Когда я прошу сдать работу на проверку:",
				"1. Создай папку " + at.task + " и в ней task.json: title, description (Markdown с разделами «## Что сделано», «## Зачем это нужно», «## Чем проверено»), acceptance (список того, что мне проверить), а для кода ещё branch и pr.",
				"2. Положи в ту же папку доказательства: скриншоты (png, jpg, webp), видео (mp4, webm), логи и отчёты (md, txt, log). Подписи к ним — в поле evidence.",
				'3. Когда всё готово, поставь "status": "review", увеличь round на 1, убери поле checks и добавь в history запись с action "submitted" и коротким комментарием, что смотреть.',
				"",
				'Решение принимаю только я. Никогда не ставь "approved" сам.',
				"",
				"Как узнать моё решение: следи за файлом " + at.events + " (доска дописывает туда строку на каждое моё действие) или перечитай task.json задачи.",
				'- "changes_requested": прочитай review.comment и review.unchecked (критерии, которые я не отметил), исправь, замени доказательства и снова поставь "review" (action "resubmitted").',
				'- "approved": поставь "status": "done" и перенеси папку задачи в ' + at.archive + ".",
				"",
				"Пиши task.json атомарно: сначала во временный файл, потом переименуй.",
			].join("\n");
		}

		function GuideStep(props) {
			return h("li", { className: "tb-guide-step" }, h("div", { className: "tb-guide-step-title" }, props.title), props.children);
		}

		/** Shown on an empty board and from the header: how to let an AI work with the board. */
		function AgentGuide(props) {
			var root = (props.env && props.env.paths && props.env.paths.root) || props.root || "";
			var prompt = buildAgentPrompt(root, props.env);
			async function openRoot() {
				var result = await rpc("reveal", {});
				if (!result.ok) props.onToast("Не удалось открыть папку: " + errorText(result.error), true);
			}
			return h(
				"div",
				{ className: "tb-detail" },
				h(
					"div",
					{ className: "tb-detail-body tb-guide" },
					h(
						"div",
						{ className: "tb-guide-head" },
						h("h2", { className: "tb-detail-title" }, props.empty ? "Задач на проверку пока нет" : "Как подключить ИИ к доске"),
						props.onClose ? h("button", { type: "button", className: "tb-icon-btn", title: "Закрыть", "aria-label": "Закрыть инструкцию", onClick: props.onClose }, h(IconClose, { size: 16 })) : null,
					),
					h("p", { className: "tb-guide-lead" }, "ИИ кладёт сюда задачу с доказательствами, ты проверяешь и жмёшь «Принять» или «На доработку», ИИ видит решение и действует дальше. Подключить можно любого ИИ, который умеет читать и писать файлы на этом компьютере."),

					h(
						Section,
						{ title: "ИИ внутри DeepSeek Harness" },
						h("p", { className: "tb-guide-text" }, "Уже подключён: у него есть инструмент task_board. Достаточно попросить в чате:"),
						h(
							"div",
							{ className: "tb-guide-phrase" },
							h("span", null, "«" + DSH_PHRASE + "»"),
							h("button", { type: "button", className: "tb-icon-btn tb-small", title: "Скопировать фразу", "aria-label": "Скопировать фразу", onClick: function () { copyText(DSH_PHRASE, props.onToast, "Фраза скопирована"); } }, h(IconCopy, { size: 14 })),
						),
					),

					h(
						Section,
						{ title: "Любой другой ИИ: Claude Code, Cursor, Codex и прочие" },
						h(
							"ol",
							{ className: "tb-guide-steps" },
							h(
								GuideStep,
								{ title: "Дай ИИ доступ к папке доски" },
								h("p", { className: "tb-guide-text" }, "Доска — обычная папка на диске. ИИ должен иметь право читать и писать в неё: добавь её в рабочие папки сессии или разреши доступ, когда он спросит."),
								root
									? h(
											"div",
											{ className: "tb-guide-path" },
											h("code", null, root),
											h("button", { type: "button", className: "tb-icon-btn tb-small", title: "Скопировать путь", "aria-label": "Скопировать путь к доске", onClick: function () { copyText(root, props.onToast, "Путь скопирован"); } }, h(IconCopy, { size: 14 })),
											h("button", { type: "button", className: "tb-icon-btn tb-small", title: "Открыть папку", "aria-label": "Открыть папку доски в файловом менеджере", onClick: openRoot }, h(IconFolder, { size: 14 })),
										)
									: null,
							),
							h(
								GuideStep,
								{ title: "Вставь ему эту инструкцию" },
								h("p", { className: "tb-guide-text" }, "Скопируй текст и отправь ИИ первым сообщением. Путь к твоей доске уже подставлен."),
								h("pre", { className: "tb-guide-prompt" }, prompt),
								h(
									"div",
									{ className: "tb-buttons" },
									h("button", { type: "button", className: "tb-btn tb-btn-primary", onClick: function () { copyText(prompt, props.onToast, "Инструкция скопирована"); } }, "Скопировать инструкцию"),
								),
							),
							h(
								GuideStep,
								{ title: "Чтобы не повторять каждый раз" },
								h("p", { className: "tb-guide-text" }, "Положи тот же текст в постоянные инструкции проекта: CLAUDE.md для Claude Code, AGENTS.md для Codex, правила проекта в Cursor. Тогда хватит фразы «сдай на проверку»."),
							),
							h(
								GuideStep,
								{ title: "Как ИИ узнаёт твоё решение" },
								h("p", { className: "tb-guide-text" }, "Каждое твоё действие доска дописывает строкой в events.jsonl в корне папки и записывает в task.json задачи. ИИ может следить за этим файлом или просто перечитать задачу, когда ты скажешь «посмотри, что я ответил»."),
							),
						),
					),

					h(
						Section,
						{ title: "Что делаешь ты" },
						h(
							"ul",
							{ className: "tb-md-list tb-guide-text" },
							h("li", null, "Открываешь задачу в списке слева: описание, скриншоты, видео, файлы."),
							h("li", null, "Отмечаешь галочками критерии в «На что смотреть», которые проверил. Неотмеченные ИИ увидит сам."),
							h("li", null, "Жмёшь «Принять» или пишешь комментарий и жмёшь «На доработку»."),
							h("li", null, "Принятую задачу закрываешь кнопкой «Выполнено», она уезжает в архив."),
						),
					),
				),
			);
		}

		// ---------- detail ----------

		function Lightbox(props) {
			var items = props.items;
			var index = props.index;
			var item = items[index];
			useEffect(
				function () {
					function onKey(event) {
						if (event.key === "Escape") props.onClose();
						else if (event.key === "ArrowRight") props.onIndex((index + 1) % items.length);
						else if (event.key === "ArrowLeft") props.onIndex((index - 1 + items.length) % items.length);
					}
					window.addEventListener("keydown", onKey);
					return function () { window.removeEventListener("keydown", onKey); };
				},
				[index, items.length],
			);
			if (!item) return null;
			return h(
				"div",
				{ className: "tb-lightbox", role: "dialog", "aria-modal": "true", "aria-label": "Просмотр скриншота", onClick: props.onClose },
				h("img", { src: item.src, alt: item.caption || item.path, onClick: function (event) { event.stopPropagation(); } }),
				h(
					"div",
					{ className: "tb-lightbox-bar", onClick: function (event) { event.stopPropagation(); } },
					items.length > 1 ? h("button", { type: "button", className: "tb-icon-btn tb-on-dark", "aria-label": "Предыдущий", onClick: function () { props.onIndex((index - 1 + items.length) % items.length); } }, h(IconChevron, { left: true, size: 18 })) : null,
					h("span", { className: "tb-lightbox-caption" }, (items.length > 1 ? index + 1 + " / " + items.length + " · " : "") + (item.caption || item.path)),
					items.length > 1 ? h("button", { type: "button", className: "tb-icon-btn tb-on-dark", "aria-label": "Следующий", onClick: function () { props.onIndex((index + 1) % items.length); } }, h(IconChevron, { size: 18 })) : null,
					h("button", { type: "button", className: "tb-icon-btn tb-on-dark", "aria-label": "Закрыть", onClick: props.onClose }, h(IconClose, { size: 18 })),
				),
			);
		}

		function TextPreview(props) {
			var _state = useState({ loading: true, text: "", error: "" });
			var state = _state[0];
			var setState = _state[1];
			useEffect(
				function () {
					var alive = true;
					fetch(props.src, { credentials: "same-origin" })
						.then(function (response) {
							if (!response.ok) throw new Error("HTTP " + response.status);
							return response.text();
						})
						.then(function (text) {
							if (!alive) return;
							var cut = text.length > TEXT_PREVIEW_LIMIT;
							setState({ loading: false, text: cut ? text.slice(0, TEXT_PREVIEW_LIMIT) + "\n…" : text, error: "" });
						})
						.catch(function (error) {
							if (alive) setState({ loading: false, text: "", error: String(error.message || error) });
						});
					return function () { alive = false; };
				},
				[props.src],
			);
			if (state.loading) return h("div", { className: "tb-muted tb-pad" }, "Загрузка…");
			if (state.error) return h("div", { className: "tb-error tb-pad" }, "Не удалось открыть: " + state.error);
			return h("pre", { className: "tb-pre" }, state.text);
		}

		function Section(props) {
			return h("section", { className: "tb-section" }, h("h3", null, props.title), props.children);
		}

		/** "task-id · PR 123 · branch" line under the title. */
		function MetaLine(props) {
			var task = props.task;
			var href = safeUrl(task.pr);
			var number = task.pr ? prNumber(task.pr) : "";
			var parts = [h("span", { key: "id", className: "tb-meta-id" }, task.id)];
			if (task.pr) {
				parts.push(h("span", { key: "s1", className: "tb-meta-sep" }, "·"));
				parts.push(
					href
						? h("a", { key: "pr", className: "tb-pr-link", href: href, target: "_blank", rel: "noopener noreferrer", title: prLabel(href) }, number ? "PR " + number : prLabel(href))
						: h("span", { key: "pr", title: "Не похоже на http(s)-ссылку" }, task.pr),
				);
			}
			if (task.branch) {
				parts.push(h("span", { key: "s2", className: "tb-meta-sep" }, "·"));
				parts.push(
					h(
						"button",
						{ key: "br", type: "button", className: "tb-branch-name", title: "Скопировать имя ветки", onClick: function () { copyText(task.branch, props.onToast, "Имя ветки скопировано"); } },
						task.branch,
					),
				);
			}
			return h("div", { className: "tb-meta" }, parts);
		}

		/** Acceptance criteria as a checklist the reviewer ticks while checking. */
		function Checklist(props) {
			var task = props.task;
			var checks = Array.isArray(task.checks) ? task.checks : [];
			var done = task.acceptance.filter(function (item) { return checks.indexOf(item) !== -1; }).length;
			return h(
				Section,
				{ title: "На что смотреть · " + done + "/" + task.acceptance.length },
				h(
					"ul",
					{ className: "tb-checks" },
					task.acceptance.map(function (item, index) {
						var checked = checks.indexOf(item) !== -1;
						return h(
							"li",
							{ key: index, className: checked ? "tb-check-done" : "" },
							h(
								"label",
								{ className: "tb-check" },
								h("input", {
									type: "checkbox",
									checked: checked,
									disabled: !props.editable,
									onChange: function (event) { props.onCheck(item, event.target.checked); },
								}),
								h("span", { className: "tb-check-text" }, renderInline(item, "c" + index)),
							),
						);
					}),
				),
			);
		}

		function TaskDetail(props) {
			var target = props.target;
			var draftKey = (target.archived ? "a:" : "t:") + target.id;
			var _task = useState(null);
			var task = _task[0];
			var setTask = _task[1];
			var _error = useState("");
			var error = _error[0];
			var setError = _error[1];
			var _comment = useState(function () { return drafts.get(draftKey) || ""; });
			var comment = _comment[0];
			var setCommentState = _comment[1];
			var _busy = useState(false);
			var busy = _busy[0];
			var setBusy = _busy[1];
			var _light = useState(-1);
			var light = _light[0];
			var setLight = _light[1];
			var _openText = useState(null);
			var openText = _openText[0];
			var setOpenText = _openText[1];
			var _confirm = useState("");
			var confirm = _confirm[0];
			var setConfirm = _confirm[1];
			var _needComment = useState(false);
			var needComment = _needComment[0];
			var setNeedComment = _needComment[1];
			var confirmTimer = useRef(0);

			function setComment(value) {
				setCommentState(value);
				if (value) drafts.set(draftKey, value);
				else drafts.delete(draftKey);
			}

			var load = useCallback(
				async function () {
					var result = await rpc("get", { id: target.id, archived: target.archived });
					if (result.ok) {
						setTask(result.value);
						setError("");
					} else if (result.error && result.error.code === "not-found") {
						props.onGone("Задача «" + target.id + "» больше не на доске");
					} else setError(errorText(result.error));
				},
				[target.id, target.archived],
			);
			// Initial load, then again whenever the board version moves (the panel polls it).
			useEffect(function () { if (!busy) load(); }, [load, props.version]);
			useEffect(function () { return function () { clearTimeout(confirmTimer.current); }; }, []);

			async function act(action, extra, message, leave) {
				setBusy(true);
				setError("");
				var result = await rpc(action, Object.assign({ id: target.id, archived: target.archived }, extra || {}));
				setBusy(false);
				setConfirm("");
				if (!result.ok) {
					setError(errorText(result.error));
					return;
				}
				setComment("");
				if (leave) {
					props.onGone(message, true);
					return;
				}
				setNeedComment(false);
				props.onToast(message);
				if (result.value && result.value.id) setTask(function (old) { return old ? Object.assign({}, old, result.value, { files: old.files, dir: old.dir, archived: old.archived }) : old; });
				load();
				props.onChanged();
			}

			function approve() {
				act("review", { decision: "approved", comment: comment.trim() }, "Задача принята");
			}
			function sendBack() {
				if (comment.trim() === "") {
					setNeedComment(true);
					return;
				}
				act("review", { decision: "changes_requested", comment: comment.trim() }, "Отправлено на доработку");
			}
			function done() {
				act("done", {}, props.onDone === "delete" ? "Задача закрыта и удалена" : "Задача закрыта и перенесена в архив", true);
			}
			function remove() {
				if (confirm !== "delete") {
					setConfirm("delete");
					clearTimeout(confirmTimer.current);
					confirmTimer.current = setTimeout(function () { setConfirm(""); }, CONFIRM_RESET_MS);
					return;
				}
				clearTimeout(confirmTimer.current);
				act("delete", {}, "Задача удалена", true);
			}
			function restore() {
				act("restore", {}, "Задача восстановлена на доску", true);
			}
			async function reveal() {
				var result = await rpc("reveal", { id: target.id, archived: target.archived });
				if (!result.ok) props.onToast("Не удалось открыть папку: " + errorText(result.error), true);
			}
			async function check(item, checked) {
				// Optimistic: tick at once, the host confirms on the next load.
				setTask(function (old) {
					if (!old) return old;
					var next = (old.checks || []).filter(function (entry) { return entry !== item; });
					if (checked) next.push(item);
					return Object.assign({}, old, { checks: next });
				});
				var result = await rpc("check", { id: target.id, item: item, checked: checked });
				if (!result.ok) {
					setError(errorText(result.error));
					load();
				} else props.onChanged();
			}
			function onCommentKey(event) {
				if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || busy) return;
				event.preventDefault();
				if (event.shiftKey) sendBack();
				else if (task && task.status !== "approved") approve();
			}

			if (!task) {
				return h("div", { className: "tb-detail" }, error ? h("div", { className: "tb-error tb-pad" }, error) : h("div", { className: "tb-muted tb-pad" }, "Загрузка…"));
			}

			var version = task.updatedAt;
			var images = task.files.filter(function (file) { return file.kind === "image" && !file.missing; });
			var videos = task.files.filter(function (file) { return file.kind === "video" && !file.missing; });
			var others = task.files.filter(function (file) { return (file.kind === "text" || file.kind === "other") && !file.missing; });
			var missing = task.files.filter(function (file) { return file.missing; });
			var lightItems = images.map(function (file) { return { path: file.path, caption: file.caption, src: mediaUrl(task.id, file.path, task.archived, file.mtime || version) }; });
			var lastNote = null;
			for (var i = task.history.length - 1; i >= 0; i--) {
				var entry = task.history[i];
				if ((entry.action === "submitted" || entry.action === "resubmitted" || entry.action === "commented") && entry.comment) {
					lastNote = entry;
					break;
				}
			}
			var archived = task.archived;
			var reviewable = !archived && task.status !== "done";
			var sections = parseSections(task.description);
			var review = task.review && task.review.at ? task.review : null;
			var newCount = task.files.filter(function (file) { return !file.missing && isNewSince(file, review); }).length;

			var body = h(
				"div",
				{ className: "tb-detail-body" },
				h("h2", { className: "tb-detail-title" }, task.title),
				h(MetaLine, { task: task, onToast: props.onToast }),
				h(TaskChips, { task: task, noEvidence: images.length + videos.length === 0 }),
				h(
					"div",
					{ className: "tb-detail-sub tb-muted" },
					task.author ? task.author + " · " : "",
					h("span", { title: fullTime(task.updatedAt) }, "обновлено " + relTime(task.updatedAt)),
					newCount > 0 ? h("span", null, " · " + newCount + " " + plural(newCount, ["новый файл", "новых файла", "новых файлов"]) + " с прошлого решения") : null,
				),
				error ? h("div", { className: "tb-error tb-banner" }, error) : null,
				task.status === "changes_requested" && task.review && task.review.comment
					? h("div", { className: "tb-banner tb-banner-changes" }, h("strong", null, "Ты вернул(а) на доработку: "), task.review.comment)
					: null,
				lastNote
					? h("div", { className: "tb-banner tb-banner-note" }, h("strong", null, lastNote.action === "commented" ? "Исполнитель пишет: " : "Комментарий исполнителя: "), lastNote.comment)
					: null,
				sections.map(function (section, index) {
					return h(Section, { key: "d" + index, title: section.title }, h("div", { className: "tb-prose" }, renderMarkdown(section.text)));
				}),
				task.acceptance.length > 0 ? h(Checklist, { task: task, editable: reviewable && !busy, onCheck: check }) : null,
				images.length > 0
					? h(
							Section,
							{ title: "Скриншоты · " + images.length },
							h(
								"div",
								{ className: "tb-gallery" },
								images.map(function (file, index) {
									return h(
										"figure",
										{ key: file.path, className: "tb-shot" },
										h(
											"button",
											{ type: "button", className: "tb-shot-btn", onClick: function () { setLight(index); }, "aria-label": "Открыть " + (file.caption || file.path) },
											h("img", { src: lightItems[index].src, alt: file.caption || file.path, loading: "lazy" }),
											isNewSince(file, review) ? h(NewChip) : null,
										),
										h("figcaption", null, file.caption || file.path),
									);
								}),
							),
						)
					: null,
				videos.length > 0
					? h(
							Section,
							{ title: "Видео · " + videos.length },
							videos.map(function (file) {
								return h(
									"figure",
									{ key: file.path, className: "tb-video" },
									h("video", { src: mediaUrl(task.id, file.path, task.archived, file.mtime || version), controls: true, preload: "metadata" }),
									h("figcaption", null, isNewSince(file, review) ? h(NewChip) : null, (file.caption || file.path) + (file.size ? " · " + formatBytes(file.size) : "")),
								);
							}),
						)
					: null,
				others.length > 0
					? h(
							Section,
							{ title: "Файлы · " + others.length },
							h(
								"ul",
								{ className: "tb-files" },
								others.map(function (file) {
									var isOpen = openText === file.path;
									return h(
										"li",
										{ key: file.path },
										h(
											"div",
											{ className: "tb-file-row" },
											h(IconFile, { size: 15 }),
											file.kind === "text"
												? h("button", { type: "button", className: "tb-link", onClick: function () { setOpenText(isOpen ? null : file.path); } }, file.path)
												: h("span", null, file.path),
											isNewSince(file, review) ? h(NewChip) : null,
											file.caption ? h("span", { className: "tb-muted" }, "— " + file.caption) : null,
											h("span", { className: "tb-muted tb-push" }, formatBytes(file.size)),
										),
										isOpen ? h(TextPreview, { src: mediaUrl(task.id, file.path, task.archived, file.mtime || version) }) : null,
									);
								}),
							),
						)
					: null,
				missing.length > 0
					? h("div", { className: "tb-banner tb-banner-warn" }, "В task.json указаны, но не найдены: " + missing.map(function (file) { return file.path; }).join(", "))
					: null,
				task.history.length > 0
					? h(
							Section,
							{ title: "История" },
							h(
								"ol",
								{ className: "tb-history" },
								task.history
									.slice()
									.reverse()
									.map(function (entry, index) {
										return h(
											"li",
											{ key: index },
											h("span", { className: "tb-history-time", title: fullTime(entry.at) }, relTime(entry.at)),
											h("span", null, h("strong", null, byLabel(entry.by)), " " + (HISTORY_TEXT[entry.action] || entry.action)),
											entry.comment ? h("div", { className: "tb-history-comment" }, entry.comment) : null,
										);
									}),
							),
						)
					: null,
				task.dir
					? h(
							"div",
							{ className: "tb-muted tb-path" },
							"Папка: ",
							h("code", null, task.dir),
							h("button", { type: "button", className: "tb-icon-btn tb-small", title: "Скопировать путь", "aria-label": "Скопировать путь к папке", onClick: function () { copyText(task.dir, props.onToast, "Путь скопирован"); } }, h(IconCopy, { size: 14 })),
							h("button", { type: "button", className: "tb-icon-btn tb-small", title: "Открыть папку", "aria-label": "Открыть папку задачи в файловом менеджере", onClick: reveal }, h(IconFolder, { size: 14 })),
						)
					: null,
			);

			var actions = null;
			if (archived) {
				actions = h(
					"div",
					{ className: "tb-actions" },
					h(
						"div",
						{ className: "tb-buttons" },
						h("button", { type: "button", className: "tb-btn tb-btn-primary", disabled: busy, onClick: restore }, "Восстановить на доску"),
						h("button", { type: "button", className: "tb-btn tb-btn-danger", disabled: busy, onClick: remove }, confirm === "delete" ? "Точно удалить навсегда?" : "Удалить навсегда"),
					),
				);
			} else if (reviewable) {
				actions = h(
					"div",
					{ className: "tb-actions" },
					h("textarea", {
						className: "tb-textarea" + (needComment ? " tb-textarea-invalid" : ""),
						rows: 2,
						value: comment,
						placeholder: task.status === "approved" ? "Комментарий (необязательно)…" : "Комментарий для исполнителя: что исправить или что понравилось…",
						"aria-label": "Комментарий для исполнителя",
						onChange: function (event) {
							setComment(event.target.value);
							if (event.target.value.trim() !== "") setNeedComment(false);
						},
						onKeyDown: onCommentKey,
						disabled: busy,
					}),
					needComment ? h("div", { className: "tb-error tb-hint" }, "Чтобы вернуть на доработку, напиши, что нужно исправить.") : null,
					h(
						"div",
						{ className: "tb-buttons" },
						task.status !== "approved"
							? h("button", { type: "button", className: "tb-btn tb-btn-ok", disabled: busy, onClick: approve, title: "Ctrl+Enter" }, "Принять")
							: h("button", { type: "button", className: "tb-btn tb-btn-primary", disabled: busy, onClick: done }, props.onDone === "delete" ? "Выполнено → удалить" : "Выполнено → в архив"),
						h("button", { type: "button", className: "tb-btn tb-btn-warn", disabled: busy, onClick: sendBack, title: "Ctrl+Shift+Enter" }, "На доработку"),
						h("span", { className: "tb-push" }),
						h("button", { type: "button", className: "tb-btn tb-btn-ghost", disabled: busy, onClick: remove }, confirm === "delete" ? "Точно удалить?" : "Удалить"),
					),
				);
			}

			return h(
				"div",
				{ className: "tb-detail" },
				body,
				actions,
				light >= 0 ? h(Lightbox, { items: lightItems, index: Math.min(light, lightItems.length - 1), onIndex: setLight, onClose: function () { setLight(-1); } }) : null,
			);
		}

		// ---------- panel ----------

		function MainPanel() {
			var _tab = useState("board");
			var tab = _tab[0];
			var setTab = _tab[1];
			var _active = useState(null);
			var active = _active[0];
			var setActive = _active[1];
			var _archive = useState(null);
			var archive = _archive[0];
			var setArchive = _archive[1];
			var _error = useState("");
			var error = _error[0];
			var setError = _error[1];
			var _selected = useState(null);
			var selected = _selected[0];
			var setSelected = _selected[1];
			var _toast = useState(null);
			var toast = _toast[0];
			var setToast = _toast[1];
			var _spin = useState(false);
			var spin = _spin[0];
			var setSpin = _spin[1];
			var _version = useState(0);
			var version = _version[0];
			var setVersion = _version[1];
			var _guide = useState(false);
			var guide = _guide[0];
			var setGuide = _guide[1];
			var toastTimer = useRef(0);
			var tabRef = useRef(tab);
			tabRef.current = tab;
			// Position of the selected row, so a task that leaves the list hands selection to its neighbour.
			var lastIndex = useRef(0);

			var showToast = useCallback(function (message, isError) {
				clearTimeout(toastTimer.current);
				setToast({ message: message, error: Boolean(isError) });
				toastTimer.current = setTimeout(function () { setToast(null); }, 3200);
			}, []);
			useEffect(function () { return function () { clearTimeout(toastTimer.current); }; }, []);

			var loadBoard = useCallback(async function () {
				var result = await rpc("list", { archived: false });
				if (result.ok) {
					setActive(result.value);
					setError("");
					if (typeof result.value.version === "number") setVersion(result.value.version);
				} else setError(errorText(result.error));
			}, []);
			var loadArchive = useCallback(async function () {
				var result = await rpc("list", { archived: true });
				if (result.ok) setArchive(result.value);
			}, []);
			var load = useCallback(async function () {
				var jobs = [loadBoard()];
				if (tabRef.current === "archive") jobs.push(loadArchive());
				await Promise.all(jobs);
			}, [loadBoard, loadArchive]);

			useEffect(function () { load(); }, [load]);
			useEffect(function () { if (tab === "archive" && archive === null) loadArchive(); }, [tab, archive, loadArchive]);

			// One long poll instead of re-listing: reload only when the host says the board changed.
			var versionRef = useRef(version);
			versionRef.current = version;
			useBoardWatch(
				function () { return versionRef.current; },
				function (next) {
					if (next !== versionRef.current) {
						setVersion(next);
						load();
					}
					setError(function (current) { return current && /^(Нет связи|Сервис доски|Ошибка сервера)/.test(current) ? "" : current; });
				},
				function (err) { setError(errorText(err)); },
			);

			async function refresh() {
				setSpin(true);
				await Promise.all([loadBoard(), loadArchive()]);
				setTimeout(function () { setSpin(false); }, 300);
			}

			var boardTasks = useMemo(function () { return sortTasks(active ? active.tasks : []); }, [active]);
			var archivedTasks = useMemo(function () {
				return (archive ? archive.tasks : []).slice().sort(function (a, b) { return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0); });
			}, [archive]);
			var visible = tab === "board" ? boardTasks : archivedTasks;
			var root = active ? active.root : "";
			// Paths and separator exactly as the host's OS reports them (the panel may run in a browser elsewhere).
			var env = active ? { sep: active.sep, paths: active.paths } : null;
			var onDone = active ? active.onDone : "archive";
			var archivedCount = archive ? archivedTasks.length : active && typeof active.archivedCount === "number" ? active.archivedCount : 0;
			var count = counters(boardTasks);
			var loaded = tab === "board" ? active !== null : archive !== null;

			// Keep a valid selection: the same task if it is still listed, else its neighbour, else the first row.
			var selectedId = selected && selected.archived === (tab === "archive") ? selected.id : null;
			var selectedIndex = visible.findIndex(function (task) { return task.id === selectedId; });
			useEffect(function () {
				if (!loaded) return;
				if (selectedIndex !== -1) {
					lastIndex.current = selectedIndex;
					return;
				}
				if (visible.length === 0) {
					if (selected !== null) setSelected(null);
					return;
				}
				var task = visible[Math.min(lastIndex.current, visible.length - 1)];
				setSelected({ id: task.id, archived: tab === "archive" });
			}, [loaded, selectedIndex, visible, tab]);

			function select(task) {
				setGuide(false);
				setSelected({ id: task.id, archived: Boolean(task.archived) || tab === "archive" });
			}
			function switchTab(next) {
				if (next === tab) return;
				lastIndex.current = 0;
				setTab(next);
			}

			var countParts = [];
			if (count.review > 0) countParts.push("ждут проверки " + count.review);
			if (count.approved > 0) countParts.push("принято " + count.approved);
			if (count.changes > 0) countParts.push("на доработке " + count.changes);
			if (count.working > 0) countParts.push("в работе " + count.working);

			var detail;
			if (!loaded) detail = h("div", { className: "tb-muted tb-pad" }, "Загрузка…");
			else if (guide) detail = h(AgentGuide, { root: root, env: env, onToast: showToast, onClose: function () { setGuide(false); } });
			else if (selectedIndex !== -1)
				detail = h(TaskDetail, {
					key: (tab === "archive" ? "a:" : "t:") + selectedId,
					target: { id: selectedId, archived: tab === "archive" },
					version: version,
					onDone: onDone,
					onGone: function (message, ok) { load(); showToast(message, !ok); },
					onToast: showToast,
					onChanged: load,
				});
			else if (tab === "board") detail = h(AgentGuide, { root: root, env: env, onToast: showToast, empty: true });
			else detail = h("div", { className: "tb-empty" }, h("p", null, "Архив пуст. Сюда попадают задачи после «Выполнено»."));

			return h(
				"div",
				{ className: "tb-root" },
				h(
					"div",
					{ className: "tb-page" },
					h(
						"header",
						{ className: "tb-head" },
						h("h1", null, "Приёмка задач"),
						h("span", { className: "tb-head-sub" }, "Что сделано, зачем, чем проверено"),
						h("span", { className: "tb-push" }),
						h("span", { className: "tb-counters" }, countParts.length > 0 ? countParts.join(" · ") : "доска пуста"),
						h("button", { type: "button", className: "tb-head-btn" + (guide ? " tb-head-btn-on" : ""), "aria-pressed": guide, onClick: function () { setGuide(!guide); }, title: "Как дать ИИ работать с доской" }, "Подключить ИИ"),
						h("button", { type: "button", className: "tb-icon-btn" + (spin ? " tb-spin" : ""), onClick: refresh, title: "Обновить", "aria-label": "Обновить" }, h(IconRefresh, { size: 16 })),
					),
					error ? h("div", { className: "tb-error tb-banner tb-head-error" }, error) : null,
					h(
						"div",
						{ className: "tb-split" },
						h(
							"aside",
							{ className: "tb-listpane", "aria-label": "Список задач" },
							h(
								"div",
								{ className: "tb-tabs", role: "tablist" },
								h("button", { type: "button", role: "tab", "aria-selected": tab === "board", className: "tb-tab", onClick: function () { switchTab("board"); } }, "На доске · " + boardTasks.length),
								h("button", { type: "button", role: "tab", "aria-selected": tab === "archive", className: "tb-tab", onClick: function () { switchTab("archive"); } }, "Архив · " + archivedCount),
							),
							loaded
								? h(TaskList, { tasks: visible, selectedId: selectedId, onSelect: select, emptyText: tab === "board" ? "На доске пусто" : "Архив пуст" })
								: h("div", { className: "tb-list-empty" }, "Загрузка…"),
						),
						h("main", { className: "tb-detailpane" }, detail),
					),
				),
				h(Toast, toast || {}),
			);
		}

		// ---------- styles ----------

		var MONO = "ui-monospace,'JetBrains Mono','Cascadia Mono',SFMono-Regular,Consolas,monospace";
		var CSS = [
			// Palette: DSH design tokens first, plain fallbacks when the host has none.
			".tb-root{--tb-bg:var(--dsw-alias-bg-base,#fff);--tb-l1:var(--dsw-alias-bg-layer-1,#f6f6f7);--tb-l2:var(--dsw-alias-bg-layer-2,#ececee);--tb-fg:var(--dsw-alias-label-primary,#16181d);--tb-fg2:var(--dsw-alias-label-secondary,#4b5058);--tb-fg3:var(--dsw-alias-label-tertiary,#8a8f98);--tb-line:var(--dsw-alias-border-l1,rgba(127,127,127,.16));--tb-line2:var(--dsw-alias-border-l2,rgba(127,127,127,.28));--tb-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));--tb-accent:var(--dsw-alias-state-business-primary,#4176e6);--tb-err:var(--dsw-alias-state-error-primary,#d64545);--tb-ok:var(--dsw-alias-state-success-primary,#2f9e5b);--tb-warn:var(--dsw-alias-state-warn-primary,#d9822b);--tb-code-bg:var(--dsw-alias-markdown-inline-code,var(--tb-l1));--tb-code-block-bg:var(--dsw-alias-markdown-code-block,var(--tb-l1));",
			"--tb-card:color-mix(in srgb,var(--tb-fg) 3.5%,var(--tb-bg));--tb-mono:" + MONO + ";",
			// The root fills the slot when the slot has a height, and grows with the content when it does not;
			// the page wrapper paints the backdrop, so it always reaches the end of the task either way.
			"position:relative;flex:1 1 auto;height:100%;min-height:100%;min-width:0;display:flex;flex-direction:column;color:var(--tb-fg);font-size:14px;line-height:1.5;box-sizing:border-box;container-type:inline-size}",
			".tb-root *,.tb-root *::before,.tb-root *::after{box-sizing:border-box}",
			".tb-page{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:16px 24px 0;background:var(--tb-bg)}",
			".tb-muted{color:var(--tb-fg3)}",
			".tb-push{flex:1}",
			// header
			".tb-head{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--tb-line2);flex:none}",
			".tb-head h1{font-size:22px;line-height:30px;margin:0;font-weight:700}",
			".tb-head-sub{color:var(--tb-fg2);font-size:14px}",
			".tb-counters{font-family:var(--tb-mono);font-size:13px;color:var(--tb-fg2);white-space:nowrap}",
			".tb-head .tb-icon-btn{align-self:center}",
			".tb-head-btn{align-self:center;border:1px solid var(--tb-line2);background:transparent;color:var(--tb-fg2);font:inherit;font-size:13px;line-height:20px;padding:3px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}",
			".tb-head-btn:hover{background:var(--tb-hover);color:var(--tb-fg)}",
			".tb-head-btn-on{color:var(--tb-accent);border-color:color-mix(in srgb,var(--tb-accent) 55%,transparent);background:color-mix(in srgb,var(--tb-accent) 10%,transparent)}",
			// guide: how to connect an AI
			".tb-guide-head{display:flex;align-items:flex-start;gap:12px}",
			".tb-guide-head .tb-detail-title{flex:1}",
			".tb-guide-lead{margin:4px 0 0;font-size:15px;line-height:1.7;color:var(--tb-fg2);max-width:760px}",
			".tb-guide-text{margin:0 0 8px;font-size:14px;line-height:1.65;color:var(--tb-fg2);max-width:760px}",
			".tb-guide-phrase,.tb-guide-path{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:760px;padding:8px 8px 8px 12px;border-radius:8px;background:var(--tb-l1);font-size:14px}",
			".tb-guide-phrase span{flex:1;min-width:0}",
			".tb-guide-path code{flex:1;min-width:0;background:transparent;padding:0;font-size:13px}",
			".tb-guide-steps{margin:0;padding:0;list-style:none;counter-reset:tb-step;max-width:760px}",
			".tb-guide-step{position:relative;padding:0 0 16px 36px;counter-increment:tb-step}",
			".tb-guide-step::before{content:counter(tb-step);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;background:var(--tb-l2);color:var(--tb-fg);font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center}",
			".tb-guide-step-title{font-size:15px;font-weight:600;line-height:24px;margin-bottom:4px}",
			".tb-guide-prompt{margin:0 0 10px;padding:12px 14px;border-radius:8px;background:var(--tb-code-block-bg);border:1px solid var(--tb-line);font:12.5px/1.6 var(--tb-mono);white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;user-select:text}",
			".tb-head-error{margin:10px 0 0}",
			// split: fills the remaining height when there is one, otherwise sizes to its content
			".tb-split{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(260px,380px) minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:20px;padding:16px 0}",
			".tb-listpane{min-height:0;display:flex;flex-direction:column;gap:8px}",
			".tb-tabs{display:flex;gap:2px;background:var(--tb-l1);border-radius:8px;padding:2px;flex:none;align-self:flex-start}",
			".tb-tab{border:0;background:transparent;color:var(--tb-fg2);font:inherit;font-size:13px;padding:3px 12px;border-radius:6px;cursor:pointer}",
			".tb-tab[aria-selected=true]{background:var(--tb-bg);color:var(--tb-fg);box-shadow:0 1px 2px rgba(0,0,0,.12)}",
			".tb-list{flex:1;min-height:0;overflow-y:auto;padding:0 4px 16px 0;display:flex;flex-direction:column}",
			".tb-list-empty{color:var(--tb-fg3);padding:24px 8px;text-align:center}",
			// list rows
			".tb-row-item{display:block}",
			".tb-row{position:relative;display:flex;flex-direction:row;align-items:flex-start;gap:12px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--tb-line);background:transparent;color:inherit;font:inherit;padding:12px 12px 12px 26px;cursor:pointer}",
			".tb-row::before{content:'';position:absolute;left:12px;top:12px;bottom:12px;width:3px;border-radius:2px;background:var(--tb-line2)}",
			".tb-row-thumb{flex:none;width:72px;height:52px;border-radius:6px;border:1px solid var(--tb-line);background:var(--tb-bg);overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--tb-fg3)}",
			".tb-row-thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}",
			".tb-row-thumb-empty{border-style:dashed;border-color:var(--tb-line2)}",
			".tb-row-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}",
			".tb-row-foot{display:flex;align-items:flex-end;gap:8px;min-width:0}",
			".tb-row-foot .tb-chips{flex:1;min-width:0}",
			".tb-row-counts{margin-left:auto;flex:none;display:inline-flex;gap:8px;align-items:center;font-size:12px;color:var(--tb-fg2);white-space:nowrap;padding-bottom:1px}",
			".tb-row-counts>span{display:inline-flex;align-items:center;gap:3px}",
			".tb-row-count-ok{color:var(--tb-ok)}",
			".tb-row:hover{background:var(--tb-hover)}",
			".tb-row-selected,.tb-row-selected:hover{background:var(--tb-card)}",
			".tb-row-selected::before{background:var(--tb-accent)}",
			".tb-row-key{font-family:var(--tb-mono);font-size:13px;color:var(--tb-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".tb-row-selected .tb-row-key{color:var(--tb-accent)}",
			".tb-row-title{color:var(--tb-fg2);font-size:14px;line-height:20px;word-break:break-word}",
			".tb-row-comment{font-size:12px;color:var(--tb-warn);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			// chips
			".tb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}",
			".tb-chip{font-family:var(--tb-mono);font-size:12px;line-height:20px;padding:1px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}",
			".tb-chip-ok{color:var(--tb-ok);background:color-mix(in srgb,var(--tb-ok) 15%,transparent)}",
			".tb-chip-bad{color:var(--tb-err);background:color-mix(in srgb,var(--tb-err) 14%,transparent)}",
			".tb-chip-warn{color:var(--tb-warn);background:color-mix(in srgb,var(--tb-warn) 16%,transparent)}",
			".tb-chip-accent{color:var(--tb-accent);background:color-mix(in srgb,var(--tb-accent) 15%,transparent)}",
			".tb-chip-neutral{color:var(--tb-fg2);background:var(--tb-l2)}",
			".tb-new{font-family:var(--tb-mono);font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;color:#fff;background:var(--tb-accent);flex:none}",
			".tb-shot-btn .tb-new{position:absolute;top:6px;left:6px;box-shadow:0 1px 3px rgba(0,0,0,.3)}",
			".tb-video figcaption .tb-new,.tb-file-row .tb-new{margin-right:6px;vertical-align:middle}",
			// detail pane: the card is the content wrapper, which grows with the task; the pane only scrolls
			".tb-detailpane{align-self:stretch;min-height:0;min-width:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column}",
			".tb-detail{display:flex;flex-direction:column;flex:1 0 auto;min-height:100%;background:var(--tb-card);border:1px solid var(--tb-line);border-radius:8px}",
			".tb-detail-body{flex:1;padding:24px 28px 8px;max-width:900px}",
			".tb-detail-title{font-size:20px;line-height:28px;margin:0 0 6px;font-weight:700;word-break:break-word}",
			".tb-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-family:var(--tb-mono);font-size:13px;color:var(--tb-fg2)}",
			".tb-meta-sep{color:var(--tb-fg3)}",
			".tb-pr-link{color:var(--tb-accent);text-decoration:underline;text-underline-offset:3px}",
			".tb-branch-name{border:0;background:transparent;padding:0;font:inherit;color:inherit;cursor:copy;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}",
			".tb-branch-name:hover{color:var(--tb-fg)}",
			".tb-detail-sub{font-size:12px;margin:6px 0 4px}",
			".tb-section{margin:22px 0 0}",
			".tb-section h3{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--tb-fg2);margin:0 0 8px}",
			// prose (markdown subset)
			".tb-prose{word-break:break-word;font-size:15px;line-height:1.75;max-width:760px}",
			".tb-prose p{margin:0 0 10px}",
			".tb-prose p:last-child,.tb-prose .tb-md-list:last-child,.tb-prose .tb-md-pre:last-child,.tb-prose .tb-md-quote:last-child{margin-bottom:0}",
			".tb-md-list{margin:0 0 10px;padding-left:22px}",
			".tb-md-list li{margin:2px 0}",
			".tb-md-quote{margin:0 0 10px;padding:2px 0 2px 12px;border-left:3px solid var(--tb-line2);color:var(--tb-fg2)}",
			".tb-md-pre{margin:0 0 10px;padding:10px 12px;border-radius:8px;background:var(--tb-code-block-bg);font:12.5px/1.55 var(--tb-mono);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:420px}",
			".tb-md-pre code{background:transparent;padding:0;font:inherit}",
			".tb-prose a,.tb-check-text a{color:var(--tb-accent);text-decoration:underline;text-underline-offset:3px}",
			// checklist
			".tb-checks{margin:0;padding:0;list-style:none;font-size:15px;line-height:1.6;max-width:760px}",
			".tb-checks li{margin:0}",
			".tb-check{display:flex;align-items:flex-start;gap:10px;padding:5px 6px 5px 4px;border-radius:6px;cursor:pointer}",
			".tb-check:hover{background:var(--tb-hover)}",
			".tb-check input{appearance:none;-webkit-appearance:none;flex:none;width:18px;height:18px;margin:3px 0 0;border:1.5px solid var(--tb-line2);border-radius:5px;background:var(--tb-bg);cursor:pointer;display:inline-grid;place-content:center}",
			".tb-check input::before{content:'';width:10px;height:10px;transform:scale(0);transition:transform .08s ease-in-out;clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0%,43% 62%);background:#fff}",
			".tb-check input:checked{background:var(--tb-ok);border-color:var(--tb-ok)}",
			".tb-check input:checked::before{transform:scale(1)}",
			".tb-check input:disabled{cursor:default;opacity:.7}",
			".tb-check-done .tb-check-text{color:var(--tb-fg3);text-decoration:line-through;text-decoration-color:var(--tb-line2)}",
			".tb-empty{max-width:560px;margin:48px auto;padding:0 24px;text-align:center;color:var(--tb-fg2)}",
			".tb-empty h2{color:var(--tb-fg);font-size:17px;margin:12px 0 8px}",
			".tb-empty p{margin:0 0 10px}",
			".tb-empty-icon{color:var(--tb-fg3)}",
			".tb-code,.tb-root code{font-family:var(--tb-mono);font-size:12px;background:var(--tb-code-bg);padding:2px 6px;border-radius:4px;word-break:break-all}",
			".tb-prose code,.tb-check-text code{font-size:13px;word-break:break-word}",
			".tb-code{display:inline-block;margin:4px 0 12px;padding:6px 10px}",
			".tb-pad{padding:24px 28px}",
			".tb-error{color:var(--tb-err)}",
			".tb-banner{border-radius:8px;padding:10px 12px;margin:14px 0 0;background:var(--tb-l1);font-size:13px;white-space:pre-wrap;word-break:break-word;max-width:760px}",
			".tb-banner.tb-error{background:color-mix(in srgb,var(--tb-err) 10%,transparent)}",
			".tb-banner-changes{background:color-mix(in srgb,var(--tb-warn) 12%,transparent)}",
			".tb-banner-note{background:color-mix(in srgb,var(--tb-accent) 9%,transparent)}",
			".tb-banner-warn{background:color-mix(in srgb,var(--tb-warn) 9%,transparent);color:var(--tb-fg2)}",
			".tb-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}",
			".tb-shot{margin:0;min-width:0}",
			".tb-shot-btn{position:relative;display:block;width:100%;padding:0;border:1px solid var(--tb-line);border-radius:8px;overflow:hidden;background:var(--tb-bg);cursor:zoom-in}",
			".tb-shot-btn img{display:block;width:100%;height:160px;object-fit:contain}",
			".tb-shot figcaption,.tb-video figcaption{font-size:12px;color:var(--tb-fg2);margin-top:4px;word-break:break-word}",
			".tb-video{margin:0 0 14px}",
			".tb-video video{display:block;width:100%;max-height:520px;border-radius:8px;background:#000}",
			".tb-files{list-style:none;margin:0;padding:0}",
			".tb-file-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--tb-line);font-size:13px;color:var(--tb-fg2)}",
			".tb-link{border:0;background:transparent;padding:0;font:inherit;color:var(--tb-accent);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;word-break:break-all;text-align:left}",
			".tb-pre{margin:6px 0 10px;max-height:360px;overflow:auto;background:var(--tb-code-block-bg);border-radius:8px;padding:10px 12px;font:12px/1.5 var(--tb-mono);white-space:pre-wrap;word-break:break-word}",
			".tb-history{list-style:none;margin:0;padding:0;border-left:2px solid var(--tb-line)}",
			".tb-history li{position:relative;padding:2px 0 10px 14px;font-size:13px}",
			".tb-history li::before{content:'';position:absolute;left:-5px;top:8px;width:8px;height:8px;border-radius:50%;background:var(--tb-line2)}",
			".tb-history-time{color:var(--tb-fg3);margin-right:8px;font-variant-numeric:tabular-nums}",
			".tb-history-comment{color:var(--tb-fg2);white-space:pre-wrap;word-break:break-word;margin-top:2px}",
			".tb-path{font-size:12px;margin:18px 0 12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
			// actions
			".tb-actions{position:sticky;bottom:0;padding:12px 28px 14px;background:var(--tb-card);border-top:1px solid var(--tb-line);border-radius:0 0 8px 8px;display:flex;flex-direction:column;gap:8px}",
			".tb-textarea{width:100%;max-width:760px;resize:vertical;min-height:48px;border:1px solid var(--tb-line2);border-radius:8px;background:var(--tb-bg);color:var(--tb-fg);font:inherit;padding:8px 10px}",
			".tb-textarea-invalid{border-color:var(--tb-err)}",
			".tb-hint{font-size:12px}",
			".tb-buttons{display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:760px}",
			".tb-btn{border:1px solid transparent;border-radius:8px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;min-height:32px}",
			".tb-btn:disabled{opacity:.55;cursor:default}",
			".tb-btn-ok{background:var(--tb-ok);color:#fff}",
			".tb-btn-ok:hover:not(:disabled){filter:brightness(1.07)}",
			".tb-btn-primary{background:var(--tb-accent);color:#fff}",
			".tb-btn-primary:hover:not(:disabled){filter:brightness(1.07)}",
			".tb-btn-warn{background:transparent;color:var(--tb-warn);border-color:color-mix(in srgb,var(--tb-warn) 55%,transparent)}",
			".tb-btn-warn:hover:not(:disabled){background:color-mix(in srgb,var(--tb-warn) 10%,transparent)}",
			".tb-btn-ghost{background:transparent;color:var(--tb-fg3);font-weight:500}",
			".tb-btn-ghost:hover:not(:disabled){background:var(--tb-hover);color:var(--tb-err)}",
			".tb-btn-danger{background:transparent;color:var(--tb-err);border-color:color-mix(in srgb,var(--tb-err) 50%,transparent)}",
			".tb-icon-btn{width:28px;height:28px;padding:0;border:0;background:transparent;color:var(--tb-fg2);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}",
			".tb-icon-btn:hover{background:var(--tb-hover);color:var(--tb-fg)}",
			".tb-icon-btn.tb-small{width:24px;height:24px}",
			".tb-spin svg{animation:tb-spin .6s linear}",
			"@keyframes tb-spin{to{transform:rotate(360deg)}}",
			".tb-root button:focus-visible,.tb-root textarea:focus-visible,.tb-root a:focus-visible,.tb-root input:focus-visible{outline:2px solid var(--tb-accent);outline-offset:-2px}",
			// overlays
			".tb-toast{position:fixed;left:50%;top:20px;transform:translateX(-50%);background:var(--tb-fg);color:var(--tb-bg);padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);z-index:50;pointer-events:none}",
			".tb-toast-error{background:var(--tb-err);color:#fff}",
			".tb-lightbox{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.86);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 24px 72px;cursor:zoom-out}",
			".tb-lightbox img{max-width:100%;max-height:100%;object-fit:contain;cursor:default;border-radius:4px}",
			".tb-lightbox-bar{position:absolute;left:0;right:0;bottom:16px;display:flex;align-items:center;justify-content:center;gap:12px;color:#fff;cursor:default}",
			".tb-lightbox-caption{font-size:13px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tb-on-dark{color:#fff}",
			".tb-on-dark:hover{background:rgba(255,255,255,.15);color:#fff}",
			// narrow panel: list above the card
			"@container (max-width:760px){.tb-split{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(120px,38%) minmax(0,1fr);gap:12px}.tb-page{padding:12px 14px 0}.tb-detail-body{padding:18px 16px 8px}.tb-actions{padding:10px 16px 12px}.tb-counters{white-space:normal}.tb-row-thumb{width:56px;height:40px}}",
		].join("\n");

		module.exports.inject = ["slots"];
		module.exports.apply = function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-dsh-task-board", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, "dsh-task-board: stylesheet");
			ctx.slots.inject("main", function () {
				return ctx.slots.register({ name: "main", key: PANEL_ID }, MainPanel);
			});
			ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 7, label: "Задачи" }, SidebarIcon);
			});
		};
		module.exports.__internals = {
			prLabel: prLabel,
			prNumber: prNumber,
			labelTone: labelTone,
			parseSections: parseSections,
			renderMarkdown: renderMarkdown,
			renderInline: renderInline,
			isNewSince: isNewSince,
			sortTasks: sortTasks,
			counters: counters,
			safeUrl: safeUrl,
			plural: plural,
			relTime: relTime,
			mediaUrl: mediaUrl,
			formatBytes: formatBytes,
			MainPanel: MainPanel,
			TaskDetail: TaskDetail,
			TaskList: TaskList,
			TaskRow: TaskRow,
			RowCounts: RowCounts,
			AgentGuide: AgentGuide,
			buildAgentPrompt: buildAgentPrompt,
			boardPaths: boardPaths,
			joinPath: joinPath,
			CSS: CSS,
		};
		return module.exports;
	},
});
