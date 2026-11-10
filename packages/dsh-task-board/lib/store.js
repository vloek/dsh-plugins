// Task store: one folder per task, `task.json` for metadata, any media beside it.
// Pure node:fs — no harness imports, so it is testable on its own.
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { appendFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TASK_FILE = "task.json";
export const ARCHIVE_DIR = "_archive";
export const FORMAT_FILE = "FORMAT.md";
export const EVENTS_FILE = "events.jsonl";
export const MAX_WAIT_MS = 10 * 60 * 1000;
const EVENTS_TAIL_LIMIT = 256 * 1024;
export const STATUSES = Object.freeze(["in_progress", "review", "changes_requested", "approved", "done"]);
export const DECISIONS = Object.freeze(["approved", "changes_requested"]);

const IMAGE_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
};
const VIDEO_TYPES = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".ogv": "video/ogg",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
};
// Text is always served as text/plain: an .html or .svg written by an agent must
// never run as a page on the app's origin.
const TEXT_EXT = new Set([".md", ".txt", ".log", ".json", ".yaml", ".yml", ".xml", ".csv", ".html", ".htm", ".diff", ".patch"]);

const MAX_ID = 100;
const MAX_WALK_DEPTH = 4;
const MAX_FILES = 500;
const MAX_LABELS = 12;
const WATCH_DEBOUNCE_MS = 200;

/** Classify a file name by extension. */
export function fileKind(name) {
	const ext = extname(name).toLowerCase();
	if (IMAGE_TYPES[ext]) return "image";
	if (VIDEO_TYPES[ext]) return "video";
	if (TEXT_EXT.has(ext)) return "text";
	return "other";
}

/** MIME type a file is served with. */
export function mimeOf(name) {
	const ext = extname(name).toLowerCase();
	return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? (TEXT_EXT.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

/** A business failure, the same shape every caller reports. */
export function fail(code, message) {
	return Object.freeze({ ok: false, error: Object.freeze({ code, message }) });
}
function ok(value) {
	return Object.freeze({ ok: true, value });
}

/** True when `id` is usable as a task folder name on every platform. */
export function isValidId(id) {
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID) return false;
	if (id === "." || id === "..") return false;
	if (id.startsWith(".") || id.startsWith("_")) return false;
	if (/[\\/:*?"<>|\u0000-\u001f]/.test(id)) return false;
	if (/[. ]$/.test(id)) return false;
	return true;
}

/** Turn a title into a folder name; keeps letters of any script. */
export function slugify(title) {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug === "" ? "task" : slug;
}

const now = () => new Date().toISOString();

function asText(value) {
	return typeof value === "string" ? value : "";
}
function asList(value) {
	if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : String(item))).filter((item) => item.trim() !== "");
	if (typeof value === "string") return value.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
	return [];
}

/** A PR reference as written by any agent: a URL string, or `{ url }` / `{ href }`. */
export function readPr(value) {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object") {
		const url = typeof value.url === "string" ? value.url : typeof value.href === "string" ? value.href : "";
		return url.trim();
	}
	return "";
}

/** Branch name, tolerant of `refs/heads/` prefixes. */
export function readBranch(value) {
	return typeof value === "string" ? value.trim().replace(/^refs\/heads\//, "") : "";
}

/** Apply optional `pr` / `branch` changes to raw task.json data; an empty string clears the field. */
function applyLinks(raw, { pr, branch } = {}) {
	if (typeof pr === "string") {
		const value = pr.trim();
		if (value === "") delete raw.pr;
		else raw.pr = value;
		delete raw.prUrl;
		delete raw.pullRequest;
	}
	if (typeof branch === "string") {
		const value = readBranch(branch);
		if (value === "") delete raw.branch;
		else raw.branch = value;
	}
}

/** Normalise whatever is in task.json into the shape the board reads; unknown fields survive in `raw`. */
export function normalizeTask(raw, id) {
	const task = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const status = STATUSES.includes(task.status) ? task.status : "review";
	const history = Array.isArray(task.history) ? task.history.filter((entry) => entry && typeof entry === "object") : [];
	const evidence = Array.isArray(task.evidence)
		? task.evidence
				.map((entry) => (typeof entry === "string" ? { file: entry } : entry))
				.filter((entry) => entry && typeof entry.file === "string")
		: [];
	const review = task.review && typeof task.review === "object" ? task.review : null;
	const acceptance = asList(task.acceptance);
	// Checked acceptance items are stored by text, so criteria added later simply show up unchecked.
	const checks = asList(task.checks).filter((item) => acceptance.includes(item));
	return {
		id,
		title: asText(task.title) || id,
		description: asText(task.description),
		acceptance,
		checks,
		labels: asList(task.labels).slice(0, MAX_LABELS),
		status,
		branch: readBranch(task.branch),
		pr: readPr(task.pr ?? task.prUrl ?? task.pullRequest),
		author: asText(task.author),
		createdAt: asText(task.createdAt),
		updatedAt: asText(task.updatedAt),
		round: Number.isInteger(task.round) ? task.round : 0,
		evidence,
		review,
		history,
	};
}

/**
 * One store over one root directory.
 *
 *   <root>/<task-id>/task.json
 *   <root>/<task-id>/<any images, videos, logs…>
 *   <root>/_archive/<task-id>/…        (tasks closed with "done")
 *
 * `version` grows on every change the store makes or sees on disk (fs.watch), so a
 * client can poll one cheap number instead of re-listing the board.
 */
export class TaskStore {
	constructor(root, options = {}) {
		this.root = resolve(root);
		this.archiveRoot = join(this.root, ARCHIVE_DIR);
		this.onDone = options.onDone === "delete" ? "delete" : "archive";
		this.locks = new Map();
		this.version = 1;
		this.watcher = null;
		this.watchTimer = null;
		this.waiters = new Set();
		this.eventsPath = join(this.root, EVENTS_FILE);
		// Fallback for platforms where a recursive fs.watch is not available: rescan this often.
		this.scanMs = Number.isFinite(options.scanMs) ? options.scanMs : 2000;
		this.lastScan = 0;
		this.fingerprint = null;
	}

	/** What a client needs to know about this board: real paths, as this OS writes them. */
	info() {
		return {
			root: this.root,
			onDone: this.onDone,
			version: this.version,
			watching: this.watcher !== null,
			sep,
			paths: { root: this.root, format: join(this.root, FORMAT_FILE), events: this.eventsPath, archive: this.archiveRoot },
		};
	}

	/** Cheap signature of the board: task folder names with the mtimes of each folder and its task.json. */
	async scanFingerprint() {
		const parts = [];
		for (const base of [this.root, this.archiveRoot]) {
			let entries;
			try {
				entries = await readdir(base, { withFileTypes: true });
			} catch {
				continue;
			}
			const dirs = entries.filter((entry) => entry.isDirectory() && isValidId(entry.name));
			const marks = await Promise.all(
				dirs.map(async (entry) => {
					const dir = join(base, entry.name);
					const [folder, file] = await Promise.all([stat(dir).catch(() => null), stat(join(dir, TASK_FILE)).catch(() => null)]);
					return `${entry.name}:${folder?.mtimeMs ?? 0}:${file?.mtimeMs ?? 0}:${file?.size ?? 0}`;
				}),
			);
			parts.push(base === this.root ? "board" : "archive", ...marks.sort());
		}
		return parts.join("|");
	}

	/** Without a working watcher, notice changes made outside the store by rescanning (throttled). */
	async refreshIfUnwatched() {
		if (this.watcher !== null) return;
		const at = Date.now();
		if (at - this.lastScan < this.scanMs * 0.9) return;
		this.lastScan = at;
		const print = await this.scanFingerprint();
		const changed = this.fingerprint !== null && print !== this.fingerprint;
		this.fingerprint = print;
		if (changed) this.bump();
	}

	/** Create the root, the archive and the format note for agents working outside DSH. */
	async ensureRoot(formatDoc, { watch: shouldWatch = false } = {}) {
		await mkdir(this.archiveRoot, { recursive: true });
		if (typeof formatDoc === "string") {
			const target = join(this.root, FORMAT_FILE);
			const current = await readFile(target, "utf8").catch(() => null);
			if (current !== formatDoc) await writeFile(target, formatDoc, "utf8");
		}
		if (shouldWatch) this.startWatching();
	}

	/** Every change anyone makes under the root bumps `version` (debounced). */
	startWatching() {
		if (this.watcher) return;
		try {
			this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, file) => {
				if (typeof file === "string" && /(^|[\\/])\.[^\\/]*\.tmp$/.test(file)) return;
				// The store's own side files: writing them is not a change of the board.
				if (file === EVENTS_FILE || file === FORMAT_FILE) return;
				if (this.watchTimer) clearTimeout(this.watchTimer);
				this.watchTimer = setTimeout(() => {
					this.watchTimer = null;
					this.bump();
				}, WATCH_DEBOUNCE_MS);
			});
			this.watcher.on("error", () => this.stopWatching());
		} catch {
			this.watcher = null;
		}
	}

	stopWatching() {
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = null;
		if (this.watcher) {
			try {
				this.watcher.close();
			} catch {}
		}
		this.watcher = null;
	}

	close() {
		this.stopWatching();
		for (const waiter of this.waiters) waiter.settle();
	}

	bump() {
		this.version += 1;
		for (const waiter of this.waiters) waiter.settle();
		return this.version;
	}

	/**
	 * Resolve with `{ version, changed }` as soon as the version moves past `since`,
	 * or after `timeoutMs` (capped) with `changed: false`. The long poll behind the panel
	 * and the agent's `wait` command.
	 */
	waitForChange(since, timeoutMs = 25000) {
		const from = Number.isFinite(Number(since)) ? Number(since) : this.version;
		if (this.version !== from) return Promise.resolve({ version: this.version, changed: true });
		const ms = Math.max(0, Math.min(Number(timeoutMs) || 0, MAX_WAIT_MS));
		return new Promise((resolve) => {
			let scanner = null;
			const waiter = {
				settle: () => {
					clearTimeout(timer);
					if (scanner) clearInterval(scanner);
					this.waiters.delete(waiter);
					resolve({ version: this.version, changed: this.version !== from });
				},
			};
			const timer = setTimeout(waiter.settle, ms);
			this.waiters.add(waiter);
			if (this.watcher === null) {
				const rescan = () => this.refreshIfUnwatched().catch(() => {});
				rescan();
				scanner = setInterval(rescan, this.scanMs);
				if (typeof scanner.unref === "function") scanner.unref();
			}
		});
	}

	/** Append one line to `<root>/events.jsonl`: what happened, to which task, by whom. */
	async log(type, id, extra = {}) {
		const entry = { at: now(), type, id, ...extra };
		for (const key of Object.keys(entry)) if (entry[key] === undefined || entry[key] === "" || entry[key] === null) delete entry[key];
		try {
			await appendFile(this.eventsPath, JSON.stringify(entry) + "\n", "utf8");
		} catch {}
		return entry;
	}

	/** Events after byte `offset` (default: the last 256 KB), oldest first, plus the offset to continue from. */
	async events({ offset, limit = 200 } = {}) {
		const info = await stat(this.eventsPath).catch(() => null);
		if (info === null) return { offset: 0, events: [] };
		const size = info.size;
		let start = Number.isFinite(Number(offset)) && Number(offset) >= 0 && Number(offset) <= size ? Number(offset) : Math.max(0, size - EVENTS_TAIL_LIMIT);
		if (start >= size) return { offset: size, events: [] };
		const buffer = await this.readRange(this.eventsPath, start, size - 1);
		let text = buffer.toString("utf8");
		// Not on a line boundary (tail read): drop the partial first line.
		if (start > 0 && offset === undefined) {
			const cut = text.indexOf("\n");
			text = cut === -1 ? "" : text.slice(cut + 1);
		}
		const events = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line));
			} catch {}
		}
		return { offset: size, events: events.slice(-Math.max(1, Math.min(Number(limit) || 200, 2000))) };
	}

	/** Absolute folder of a task, or undefined when the id is unusable or escapes the root. */
	taskDir(id, archived = false) {
		if (!isValidId(id)) return undefined;
		const base = archived ? this.archiveRoot : this.root;
		const dir = resolve(base, id);
		const rel = relative(base, dir);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) return undefined;
		return dir;
	}

	/** Absolute folder of an existing task (board first, then archive), or undefined. */
	async existingDir(id, archived) {
		const places = archived === undefined ? [false, true] : [Boolean(archived)];
		for (const place of places) {
			const dir = this.taskDir(id, place);
			if (dir === undefined) return undefined;
			if ((await stat(join(dir, TASK_FILE)).catch(() => null)) !== null) return dir;
		}
		return undefined;
	}

	/** Serialise read-modify-write cycles per task folder. */
	async withLock(dir, fn) {
		const previous = this.locks.get(dir) ?? Promise.resolve();
		let release;
		const current = new Promise((done) => (release = done));
		const chained = previous.then(() => current);
		this.locks.set(dir, chained);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.locks.get(dir) === chained) this.locks.delete(dir);
		}
	}

	async readRaw(dir) {
		const text = await readFile(join(dir, TASK_FILE), "utf8");
		const parsed = JSON.parse(text.replace(/^﻿/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("task.json is not an object");
		return parsed;
	}

	async writeRaw(dir, data) {
		const target = join(dir, TASK_FILE);
		const temp = join(dir, `.${TASK_FILE}.${randomUUID()}.tmp`);
		const body = JSON.stringify(data, null, 2) + "\n";
		await writeFile(temp, body, "utf8");
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					await rename(temp, target);
					return;
				} catch (error) {
					if (attempt >= 4) {
						await rm(temp, { force: true });
						await writeFile(target, body, "utf8");
						return;
					}
					await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
				}
			}
		} finally {
			this.bump();
		}
	}

	/** Read, change and save one task under its lock. `mutate` returns a failure to abort. */
	async modify(id, mutate, archived = false) {
		const dir = this.taskDir(id, archived);
		if (dir === undefined) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)}`);
		return await this.withLock(dir, async () => {
			let raw;
			try {
				raw = await this.readRaw(dir);
			} catch (error) {
				if (error?.code === "ENOENT") return fail("not-found", `no task ${JSON.stringify(id)}`);
				return fail("unreadable", `task.json of ${JSON.stringify(id)} is not valid JSON: ${error.message}`);
			}
			const outcome = await mutate(raw, normalizeTask(raw, id), dir);
			if (outcome && outcome.ok === false) return outcome;
			raw.updatedAt = now();
			await this.writeRaw(dir, raw);
			return ok(normalizeTask(raw, id));
		});
	}

	/** Every file in a task folder (task.json excluded), evidence order first. */
	async files(dir, task) {
		const found = [];
		const walk = async (abs, rel, depth) => {
			if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) return;
			let entries;
			try {
				entries = await readdir(abs, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			const plain = entries.filter((entry) => !entry.name.startsWith(".") && entry.isFile() && (rel !== "" || entry.name !== TASK_FILE));
			const infos = await Promise.all(plain.map((entry) => stat(join(abs, entry.name)).catch(() => null)));
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
				if (entry.isDirectory()) await walk(join(abs, entry.name), childRel, depth + 1);
				else if (entry.isFile() && childRel !== TASK_FILE) {
					const info = infos[plain.indexOf(entry)];
					found.push({ path: childRel, kind: fileKind(entry.name), size: info?.size ?? 0, mtime: info?.mtimeMs ?? 0 });
				}
				if (found.length >= MAX_FILES) return;
			}
		};
		await walk(dir, "", 0);
		const byPath = new Map(found.map((file) => [file.path, file]));
		const ordered = [];
		for (const entry of task.evidence) {
			const path = entry.file.replace(/\\/g, "/").replace(/^\.\//, "");
			const file = byPath.get(path);
			if (file) {
				ordered.push({ ...file, caption: asText(entry.caption) });
				byPath.delete(path);
			} else ordered.push({ path, kind: fileKind(path), size: 0, caption: asText(entry.caption), missing: true });
		}
		for (const file of byPath.values()) ordered.push({ ...file, caption: "" });
		return ordered;
	}

	async summarize(dir, id, archived) {
		let raw;
		try {
			raw = await this.readRaw(dir);
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			const info = await stat(dir).catch(() => null);
			return { id, title: id, status: "review", archived, error: `task.json не читается: ${error.message}`, updatedAt: info ? new Date(info.mtimeMs).toISOString() : "", files: { images: 0, videos: 0, other: 0 } };
		}
		const task = normalizeTask(raw, id);
		const files = await this.files(dir, task);
		const cover = files.find((file) => file.kind === "image" && !file.missing);
		return {
			id,
			title: task.title,
			status: task.status,
			archived,
			round: task.round,
			labels: task.labels,
			branch: task.branch,
			pr: task.pr,
			author: task.author,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			review: task.review,
			checks: { done: task.checks.length, total: task.acceptance.length },
			cover: cover ? cover.path : null,
			coverVersion: cover ? cover.mtime : 0,
			files: {
				images: files.filter((file) => file.kind === "image" && !file.missing).length,
				videos: files.filter((file) => file.kind === "video" && !file.missing).length,
				other: files.filter((file) => (file.kind === "text" || file.kind === "other") && !file.missing).length,
			},
		};
	}

	/** Number of task folders in the archive, without reading them. */
	async archivedCount() {
		try {
			const entries = await readdir(this.archiveRoot, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory() && isValidId(entry.name)).length;
		} catch {
			return 0;
		}
	}

	/** Summaries of every task in the board (or in the archive). */
	async list({ archived = false } = {}) {
		const base = archived ? this.archiveRoot : this.root;
		const meta = this.info();
		let entries;
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch (error) {
			if (error?.code === "ENOENT") return ok({ ...meta, archivedCount: 0, tasks: [] });
			return fail("unreadable", error.message);
		}
		const dirs = entries.filter((entry) => entry.isDirectory() && isValidId(entry.name));
		const summaries = await Promise.all(dirs.map((entry) => this.summarize(join(base, entry.name), entry.name, archived)));
		const tasks = summaries.filter(Boolean);
		tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
		const archivedCount = archived ? tasks.length : await this.archivedCount();
		return ok({ ...meta, archivedCount, tasks });
	}

	/** One task in full, with its files. Looks in the archive too when `archived` is not given. */
	async get(id, { archived } = {}) {
		const places = archived === undefined ? [false, true] : [Boolean(archived)];
		for (const place of places) {
			const dir = this.taskDir(id, place);
			if (dir === undefined) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)}`);
			let raw;
			try {
				raw = await this.readRaw(dir);
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				return fail("unreadable", `task.json of ${JSON.stringify(id)} is not valid JSON: ${error.message}`);
			}
			const task = normalizeTask(raw, id);
			return ok({ ...task, archived: place, dir, version: this.version, files: await this.files(dir, task) });
		}
		return fail("not-found", `no task ${JSON.stringify(id)}`);
	}

	async uniqueId(wanted, { boardOnly = false } = {}) {
		const base = wanted.slice(0, MAX_ID - 4);
		for (let n = 1; n < 1000; n++) {
			const id = n === 1 ? base : `${base}-${n}`;
			const free =
				(await stat(join(this.root, id)).catch(() => null)) === null &&
				(boardOnly || (await stat(join(this.archiveRoot, id)).catch(() => null)) === null);
			if (free) return id;
		}
		return `${base}-${randomUUID().slice(0, 8)}`;
	}

	/** Create a task folder and its task.json. */
	async create({ id, title, description, acceptance, labels, author, submit = false, note, pr, branch } = {}) {
		if (typeof title !== "string" || title.trim() === "") return fail("invalid-request", "a task needs a title");
		let taskId;
		if (id !== undefined && id !== null && id !== "") {
			if (!isValidId(id)) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)} (no slashes, no leading dot or underscore, at most ${MAX_ID} characters)`);
			if ((await stat(join(this.root, id)).catch(() => null)) !== null) return fail("exists", `task ${JSON.stringify(id)} already exists`);
			taskId = id;
		} else taskId = await this.uniqueId(slugify(title));
		const dir = join(this.root, taskId);
		await mkdir(dir, { recursive: true });
		const at = now();
		const raw = {
			id: taskId,
			title: title.trim(),
			description: asText(description),
			acceptance: asList(acceptance),
			status: submit ? "review" : "in_progress",
			author: asText(author),
			createdAt: at,
			updatedAt: at,
			round: submit ? 1 : 0,
			evidence: [],
			review: null,
			history: [{ at, by: asText(author) || "agent", action: "created" }],
		};
		applyLinks(raw, { pr, branch });
		if (labels !== undefined && asList(labels).length > 0) raw.labels = asList(labels).slice(0, MAX_LABELS);
		if (submit) raw.history.push({ at, by: asText(author) || "agent", action: "submitted", ...(asText(note) ? { comment: asText(note) } : {}) });
		await this.writeRaw(dir, raw);
		await this.log("created", taskId, { by: asText(author) || "agent", title: raw.title });
		if (submit) await this.log("submitted", taskId, { by: asText(author) || "agent", round: 1, comment: asText(note) });
		return ok({ ...normalizeTask(raw, taskId), dir, archived: false, files: [] });
	}

	/** Change title, description, acceptance criteria, labels, PR link or branch ("" clears the last two, [] clears labels). */
	async update(id, { title, description, acceptance, labels, pr, branch } = {}) {
		const result = await this.modify(id, (raw) => {
			if (typeof title === "string" && title.trim() !== "") raw.title = title.trim();
			if (typeof description === "string") raw.description = description;
			if (acceptance !== undefined) raw.acceptance = asList(acceptance);
			if (labels !== undefined) {
				const list = asList(labels).slice(0, MAX_LABELS);
				if (list.length === 0) delete raw.labels;
				else raw.labels = list;
			}
			applyLinks(raw, { pr, branch });
		});
		if (result.ok) await this.log("updated", id, { by: "agent" });
		return result;
	}

	/** Copy a file into the task folder and list it as evidence. */
	async attach(id, source, { name, caption } = {}) {
		if (typeof source !== "string" || !isAbsolute(source)) return fail("invalid-request", "`source` must be an absolute path to an existing file");
		const info = await stat(source).catch(() => null);
		if (info === null || !info.isFile()) return fail("not-found", `no file at ${source}`);
		const fileName = typeof name === "string" && name.trim() !== "" ? basename(name.trim()) : basename(source);
		if (!isValidId(fileName) || fileName === TASK_FILE) return fail("invalid-request", `not a usable file name: ${JSON.stringify(fileName)}`);
		const result = await this.modify(id, async (raw, _task, dir) => {
			const target = join(dir, fileName);
			if (resolve(source) !== resolve(target)) await copyFile(source, target);
			const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((entry) => (typeof entry === "string" ? entry : entry?.file) !== fileName) : [];
			evidence.push({ file: fileName, ...(asText(caption) ? { caption: asText(caption) } : {}) });
			raw.evidence = evidence;
		});
		if (result.ok) await this.log("attached", id, { by: "agent", file: fileName });
		return result;
	}

	/** The agent hands the task to the reviewer (first time or after rework). A new round starts with no boxes ticked. */
	async submit(id, { note, by, pr, branch } = {}) {
		let action = "submitted";
		const result = await this.modify(id, (raw, task) => {
			if (task.status === "done") return fail("invalid-state", "the task is already done");
			applyLinks(raw, { pr, branch });
			const at = now();
			action = task.round > 0 ? "resubmitted" : "submitted";
			raw.status = "review";
			raw.round = task.round + 1;
			delete raw.checks;
			raw.history = [...task.history, { at, by: asText(by) || "agent", action, ...(asText(note) ? { comment: asText(note) } : {}) }];
		});
		if (result.ok) await this.log(action, id, { by: asText(by) || "agent", round: result.value.round, comment: asText(note) });
		return result;
	}

	/** The agent leaves a note for the reviewer without changing the status. */
	async comment(id, { note, by } = {}) {
		const text = asText(note).trim();
		if (text === "") return fail("invalid-request", "a comment needs text in `note`");
		const result = await this.modify(id, (raw, task) => {
			if (task.status === "done") return fail("invalid-state", "the task is already done");
			raw.history = [...task.history, { at: now(), by: asText(by) || "agent", action: "commented", comment: text }];
		});
		if (result.ok) await this.log("commented", id, { by: asText(by) || "agent", comment: text });
		return result;
	}

	/** The reviewer ticks (or unticks) one acceptance criterion while checking. */
	async setCheck(id, { item, checked } = {}) {
		const text = asText(item).trim();
		if (text === "") return fail("invalid-request", "`item` must be the text of an acceptance criterion");
		const result = await this.modify(id, (raw, task) => {
			if (!task.acceptance.includes(text)) return fail("not-found", `no acceptance criterion ${JSON.stringify(text)}`);
			const next = task.checks.filter((entry) => entry !== text);
			if (checked !== false) next.push(text);
			const ordered = task.acceptance.filter((entry) => next.includes(entry));
			if (ordered.length === 0) delete raw.checks;
			else raw.checks = ordered;
		});
		if (result.ok) await this.log(checked !== false ? "checked" : "unchecked", id, { by: "reviewer", item: text, done: result.value.checks.length, total: result.value.acceptance.length });
		return result;
	}

	/** The reviewer's decision: approve, or send back with a comment. */
	async review(id, { decision, comment, by } = {}) {
		if (!DECISIONS.includes(decision)) return fail("invalid-request", "decision must be `approved` or `changes_requested`");
		const text = asText(comment).trim();
		if (decision === "changes_requested" && text === "") return fail("invalid-request", "say what needs changing: a comment is required to send a task back");
		const result = await this.modify(id, (raw, task) => {
			if (task.status === "done") return fail("invalid-state", "the task is already done");
			const at = now();
			raw.status = decision;
			raw.review = { decision, comment: text, at, by: asText(by) || "reviewer", round: task.round };
			if (task.acceptance.length > 0) {
				raw.review.checked = task.checks;
				raw.review.unchecked = task.acceptance.filter((item) => !task.checks.includes(item));
			}
			raw.history = [...task.history, { at, by: asText(by) || "reviewer", action: decision, ...(text ? { comment: text } : {}) }];
		});
		if (result.ok) await this.log(decision, id, { by: asText(by) || "reviewer", round: result.value.round, comment: text, unchecked: result.value.review?.unchecked?.length ? result.value.review.unchecked : undefined });
		return result;
	}

	async moveDir(from, to) {
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					await rename(from, to);
					return;
				} catch (error) {
					if (attempt >= 3) {
						await cp(from, to, { recursive: true, errorOnExist: true, force: false });
						await rm(from, { recursive: true, force: true });
						return;
					}
					await new Promise((done) => setTimeout(done, 80 * (attempt + 1)));
				}
			}
		} finally {
			this.bump();
		}
	}

	/** Close an approved task: archive it (default) or delete it, per `onDone`. */
	async done(id, { by, force = false } = {}) {
		const dir = this.taskDir(id, false);
		if (dir === undefined) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)}`);
		const marked = await this.modify(id, (raw, task) => {
			if (task.status !== "approved" && !force) return fail("invalid-state", `only an approved task can be closed; ${JSON.stringify(id)} is ${task.status}`);
			const at = now();
			raw.statusBeforeDone = task.status;
			raw.status = "done";
			raw.doneAt = at;
			raw.history = [...task.history, { at, by: asText(by) || "reviewer", action: "done" }];
		});
		if (!marked.ok) return marked;
		const closed = await this.withLock(dir, async () => {
			if (this.onDone === "delete") {
				await rm(dir, { recursive: true, force: true });
				this.bump();
				return ok({ id, closed: "deleted" });
			}
			await mkdir(this.archiveRoot, { recursive: true });
			let targetId = id;
			if ((await stat(join(this.archiveRoot, id)).catch(() => null)) !== null) {
				targetId = `${id}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
			}
			await this.moveDir(dir, join(this.archiveRoot, targetId));
			return ok({ id: targetId, closed: "archived" });
		});
		await this.log("done", id, { by: asText(by) || "reviewer", closed: closed.value.closed, archivedAs: closed.value.id !== id ? closed.value.id : undefined });
		return closed;
	}

	/** Bring an archived task back to the board. */
	async restore(id) {
		const from = this.taskDir(id, true);
		if (from === undefined) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)}`);
		if ((await stat(from).catch(() => null)) === null) return fail("not-found", `no archived task ${JSON.stringify(id)}`);
		const targetId = await this.uniqueId(id, { boardOnly: true });
		const to = join(this.root, targetId);
		await this.withLock(from, () => this.moveDir(from, to));
		const result = await this.modify(targetId, (raw, task) => {
			const back = STATUSES.includes(raw.statusBeforeDone) && raw.statusBeforeDone !== "done" ? raw.statusBeforeDone : "approved";
			raw.status = back;
			delete raw.statusBeforeDone;
			delete raw.doneAt;
			if (targetId !== id) raw.id = targetId;
			raw.history = [...task.history, { at: now(), by: "reviewer", action: "restored" }];
		});
		if (result.ok) await this.log("restored", targetId, { by: "reviewer", status: result.value.status, from: targetId !== id ? id : undefined });
		return result;
	}

	/** Delete a task folder outright. */
	async remove(id, { archived = false } = {}) {
		const dir = this.taskDir(id, archived);
		if (dir === undefined) return fail("invalid-id", `not a usable task id: ${JSON.stringify(id)}`);
		if ((await stat(dir).catch(() => null)) === null) return fail("not-found", `no task ${JSON.stringify(id)}`);
		await this.withLock(dir, () => rm(dir, { recursive: true, force: true }));
		this.bump();
		await this.log("deleted", id, { by: "reviewer", archived: archived || undefined });
		return ok({ id, deleted: true });
	}

	/** Resolve a file inside a task folder for serving; undefined when it escapes. */
	async resolveFile(id, file, { archived = false } = {}) {
		const dir = this.taskDir(id, archived);
		if (dir === undefined || typeof file !== "string" || file === "") return undefined;
		const abs = resolve(dir, file);
		const rel = relative(dir, abs);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
		if (rel.split(sep).some((part) => part.startsWith("."))) return undefined;
		const info = await stat(abs).catch(() => null);
		if (info === null || !info.isFile()) return undefined;
		return { abs, size: info.size, mtime: info.mtimeMs, type: mimeOf(abs), kind: fileKind(abs) };
	}

	/** Read a byte range of a file (inclusive `end`). */
	async readRange(abs, start, end) {
		const length = Math.max(0, end - start + 1);
		const buffer = Buffer.alloc(length);
		const handle = await open(abs, "r");
		try {
			let read = 0;
			while (read < length) {
				const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
				if (bytesRead === 0) break;
				read += bytesRead;
			}
			return read === length ? buffer : buffer.subarray(0, read);
		} finally {
			await handle.close();
		}
	}
}
