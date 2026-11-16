// node test/run.mjs — store, routes, text and the pure parts of the panel, without a harness.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { TaskStore, isValidId, slugify, normalizeTask } from "../lib/store.js";
import { createMediaHandler, createRpcHandler } from "../lib/routes.js";
import { formatDoc, renderList, renderTask, toolDescription } from "../lib/text.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function fresh() {
	const base = await mkdtemp(join(process.env.TB_TMP ?? tmpdir(), "tb-"));
	const store = new TaskStore(join(base, "board"));
	await store.ensureRoot(formatDoc(store.root));
	return { base, store };
}

async function rpcCall(handler, body) {
	const response = await handler(new Request("http://127.0.0.1/api/dsh-task-board/rpc", { method: "POST", body: JSON.stringify(body) }));
	return await response.json();
}

test("ids and slugs", () => {
	assert.equal(isValidId("login-form"), true);
	assert.equal(isValidId("Задача 1"), true);
	assert.equal(isValidId("../x"), false);
	assert.equal(isValidId("_archive"), false);
	assert.equal(isValidId(".hidden"), false);
	assert.equal(isValidId("a/b"), false);
	assert.equal(isValidId("trailing."), false);
	assert.equal(slugify("Починить форму логина!"), "починить-форму-логина");
	assert.equal(slugify("  "), "task");
});

test("normalize tolerates junk", () => {
	const task = normalizeTask({ status: "weird", acceptance: "- a\n- b", evidence: ["x.png", { nope: 1 }] }, "t");
	assert.equal(task.status, "review");
	assert.deepEqual(task.acceptance, ["a", "b"]);
	assert.deepEqual(task.evidence, [{ file: "x.png" }]);
	assert.equal(task.title, "t");
});

test("full loop: create, attach, submit, send back, resubmit, approve, done, restore", async () => {
	const { base, store } = await fresh();
	try {
		assert.ok((await readFile(join(store.root, "FORMAT.md"), "utf8")).includes("task.json"));
		const shot = join(base, "shot.png");
		await writeFile(shot, PNG);

		const created = await store.create({ title: "Форма логина", description: "Проверь ошибки", acceptance: ["пустой email", "неверный пароль"], author: "agent" });
		assert.equal(created.ok, true);
		const id = created.value.id;
		assert.equal(id, "форма-логина");
		assert.equal(created.value.status, "in_progress");

		const attached = await store.attach(id, shot, { name: "01-empty.png", caption: "Пустой email" });
		assert.equal(attached.ok, true, JSON.stringify(attached));
		await mkdir(join(store.root, id, "extra"));
		await writeFile(join(store.root, id, "extra", "run.log"), "ok\n");
		await writeFile(join(store.root, id, "clip.mp4"), Buffer.alloc(3000, 1));

		const submitted = await store.submit(id, { note: "Готово" });
		assert.equal(submitted.value.status, "review");
		assert.equal(submitted.value.round, 1);

		const got = await store.get(id);
		assert.equal(got.ok, true);
		assert.deepEqual(got.value.files.map((file) => [file.path, file.kind]), [["01-empty.png", "image"], ["clip.mp4", "video"], ["extra/run.log", "text"]]);
		assert.equal(got.value.files[0].caption, "Пустой email");

		const noComment = await store.review(id, { decision: "changes_requested", comment: "  " });
		assert.equal(noComment.ok, false);
		const back = await store.review(id, { decision: "changes_requested", comment: "Текст налезает на кнопку" });
		assert.equal(back.value.status, "changes_requested");
		assert.equal(back.value.review.comment, "Текст налезает на кнопку");

		const tooEarly = await store.done(id);
		assert.equal(tooEarly.ok, false);
		assert.equal(tooEarly.error.code, "invalid-state");

		const again = await store.submit(id, { note: "Исправил" });
		assert.equal(again.value.round, 2);
		assert.equal(again.value.history.at(-1).action, "resubmitted");

		const approved = await store.review(id, { decision: "approved", comment: "" });
		assert.equal(approved.value.status, "approved");

		const listed = await store.list();
		assert.equal(listed.value.tasks.length, 1);
		assert.equal(listed.value.tasks[0].cover, "01-empty.png");
		assert.deepEqual(listed.value.tasks[0].files, { images: 1, videos: 1, other: 1 });

		const closed = await store.done(id);
		assert.equal(closed.ok, true, JSON.stringify(closed));
		assert.equal(closed.value.closed, "archived");
		assert.equal((await store.list()).value.tasks.length, 0);
		const arch = await store.list({ archived: true });
		assert.equal(arch.value.tasks[0].status, "done");
		const fromArchive = await store.get(id);
		assert.equal(fromArchive.value.archived, true);

		const restored = await store.restore(id);
		assert.equal(restored.ok, true, JSON.stringify(restored));
		assert.equal(restored.value.status, "approved");
		assert.equal((await store.list()).value.tasks.length, 1);

		const raw = JSON.parse(await readFile(join(store.root, id, "task.json"), "utf8"));
		assert.deepEqual(raw.history.map((entry) => entry.action), ["created", "submitted", "changes_requested", "resubmitted", "approved", "done", "restored"]);
		assert.equal(raw.statusBeforeDone, undefined);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("externally written task with unknown fields and broken json", async () => {
	const { base, store } = await fresh();
	try {
		await mkdir(join(store.root, "ext-task"));
		await writeFile(join(store.root, "ext-task", "task.json"), "\uFEFF" + JSON.stringify({ title: "Внешняя", status: "review", custom: { keep: true } }));
		await mkdir(join(store.root, "broken"));
		await writeFile(join(store.root, "broken", "task.json"), "{not json");
		await mkdir(join(store.root, "no-json"));
		const listed = await store.list();
		const ids = listed.value.tasks.map((task) => task.id).sort();
		assert.deepEqual(ids, ["broken", "ext-task"]);
		assert.ok(listed.value.tasks.find((task) => task.id === "broken").error);
		const r = await store.review("ext-task", { decision: "approved" });
		assert.equal(r.ok, true);
		const raw = JSON.parse(await readFile(join(store.root, "ext-task", "task.json"), "utf8"));
		assert.deepEqual(raw.custom, { keep: true });
		const bad = await store.review("broken", { decision: "approved" });
		assert.equal(bad.error.code, "unreadable");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rpc and media routes, ranges and path escapes", async () => {
	const { base, store } = await fresh();
	try {
		const rpc = createRpcHandler(store);
		const media = createMediaHandler(store);
		const created = await store.create({ title: "Видео", submit: true });
		const id = created.value.id;
		const video = Buffer.alloc(20000);
		for (let i = 0; i < video.length; i++) video[i] = i % 251;
		await writeFile(join(store.root, id, "a.mp4"), video);
		await writeFile(join(base, "secret.txt"), "nope");

		const list = await rpcCall(rpc, { action: "list" });
		assert.equal(list.ok, true);
		assert.equal(list.value.tasks[0].id, id);

		const back = await rpcCall(rpc, { action: "review", id, decision: "changes_requested", comment: "Звук пропал" });
		assert.equal(back.ok, true);
		assert.equal(back.value.status, "changes_requested");
		const unknown = await rpcCall(rpc, { action: "nope" });
		assert.equal(unknown.ok, false);

		const url = (file, extra = "") => `http://127.0.0.1/api/dsh-task-board/media?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}${extra}`;
		const whole = await media(new Request(url("a.mp4")));
		assert.equal(whole.status, 200);
		assert.equal(whole.headers.get("content-type"), "video/mp4");
		assert.equal((await whole.arrayBuffer()).byteLength, 20000);

		const part = await media(new Request(url("a.mp4"), { headers: { range: "bytes=100-199" } }));
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), "bytes 100-199/20000");
		const bytes = new Uint8Array(await part.arrayBuffer());
		assert.equal(bytes.length, 100);
		assert.equal(bytes[0], 100 % 251);

		const open = await media(new Request(url("a.mp4"), { headers: { range: "bytes=19990-" } }));
		assert.equal(open.headers.get("content-range"), "bytes 19990-19999/20000");
		const suffix = await media(new Request(url("a.mp4"), { headers: { range: "bytes=-10" } }));
		assert.equal(suffix.headers.get("content-range"), "bytes 19990-19999/20000");
		const bad = await media(new Request(url("a.mp4"), { headers: { range: "bytes=30000-" } }));
		assert.equal(bad.status, 416);

		for (const evil of ["../../secret.txt", "..\\..\\secret.txt", "task.json/../../../secret.txt", join(base, "secret.txt")]) {
			const r = await media(new Request(url(evil)));
			assert.equal(r.status, 404, evil);
		}
		const evilId = await media(new Request(`http://127.0.0.1/x?id=..&file=secret.txt`));
		assert.equal(evilId.status, 404);
		const json = await media(new Request(url("task.json")));
		assert.equal(json.status, 200);
		assert.match(json.headers.get("content-type"), /^text\/plain/);
		assert.match(json.headers.get("content-security-policy"), /sandbox/);

		const done = await rpcCall(rpc, { action: "done", id });
		assert.equal(done.ok, false);
		await rpcCall(rpc, { action: "review", id, decision: "approved" });
		const done2 = await rpcCall(rpc, { action: "done", id });
		assert.equal(done2.ok, true);
		const archivedFile = await media(new Request(url("a.mp4", "&archived=1"), { headers: { range: "bytes=0-9" } }));
		assert.equal(archivedFile.status, 206);
		const del = await rpcCall(rpc, { action: "delete", id, archived: true });
		assert.equal(del.ok, true);
		assert.equal(await stat(join(store.root, "_archive", id)).catch(() => null), null);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("onDone=delete removes the folder", async () => {
	const base = await mkdtemp(join(process.env.TB_TMP ?? tmpdir(), "tb-"));
	try {
		const store = new TaskStore(join(base, "b"), { onDone: "delete" });
		await store.ensureRoot();
		const { value } = await store.create({ title: "x", submit: true });
		await store.review(value.id, { decision: "approved" });
		const closed = await store.done(value.id);
		assert.equal(closed.value.closed, "deleted");
		assert.equal((await store.list({ archived: true })).value.tasks.length, 0);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("branch and pr: create, list, update, clear, tolerant reading", async () => {
	const { base, store } = await fresh();
	try {
		const { value } = await store.create({ title: "PR", branch: "refs/heads/feature/x", pr: " https://github.com/org/repo/pull/7 " });
		assert.equal(value.branch, "feature/x");
		assert.equal(value.pr, "https://github.com/org/repo/pull/7");
		const listed = (await store.list()).value.tasks[0];
		assert.equal(listed.branch, "feature/x");
		assert.equal(listed.pr, "https://github.com/org/repo/pull/7");
		const sub = await store.submit(value.id, { pr: "https://github.com/org/repo/pull/8" });
		assert.equal(sub.value.pr, "https://github.com/org/repo/pull/8");
		assert.equal(sub.value.branch, "feature/x", "submit without branch keeps it");
		const cleared = await store.update(value.id, { pr: "", branch: "" });
		assert.equal(cleared.value.pr, "");
		assert.equal(cleared.value.branch, "");
		const raw = JSON.parse(await readFile(join(store.root, value.id, "task.json"), "utf8"));
		assert.equal("pr" in raw, false);
		assert.equal("branch" in raw, false);
		assert.equal(normalizeTask({ prUrl: "https://x/y" }, "a").pr, "https://x/y");
		assert.equal(normalizeTask({ pullRequest: { url: "https://x/z", number: 3 } }, "a").pr, "https://x/z");
		const text = renderTask({ ...normalizeTask({ title: "T", branch: "b", pr: "https://p" }, "t"), files: [] });
		assert.match(text, /Branch: `b`/);
		assert.match(text, /PR: https:\/\/p/);
		assert.match(formatDoc("C:/x"), /"branch": "feature\/login-validation"/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("labels: create, list, update, clear, tolerant reading", async () => {
	const { base, store } = await fresh();
	try {
		const { value } = await store.create({ title: "Chips", labels: ["CI зелёный", "  ", "конфликт"], submit: true });
		assert.deepEqual(value.labels, ["CI зелёный", "конфликт"], "blank labels dropped");
		assert.deepEqual((await store.list()).value.tasks[0].labels, ["CI зелёный", "конфликт"], "list summary carries labels");
		const updated = await store.update(value.id, { labels: ["in QA 2"] });
		assert.deepEqual(updated.value.labels, ["in QA 2"]);
		const untouched = await store.update(value.id, { title: "Chips 2" });
		assert.deepEqual(untouched.value.labels, ["in QA 2"], "update without labels keeps them");
		const cleared = await store.update(value.id, { labels: [] });
		assert.deepEqual(cleared.value.labels, []);
		const raw = JSON.parse(await readFile(join(store.root, value.id, "task.json"), "utf8"));
		assert.equal("labels" in raw, false, "empty list removes the field");
		const plain = await store.create({ title: "No chips" });
		assert.equal("labels" in JSON.parse(await readFile(join(store.root, plain.value.id, "task.json"), "utf8")), false);
		assert.deepEqual(normalizeTask({ labels: "a\n- b" }, "t").labels, ["a", "b"], "newline string accepted");
		assert.equal(normalizeTask({ labels: Array.from({ length: 20 }, (_, i) => "l" + i) }, "t").labels.length, 12, "capped");
		assert.deepEqual(normalizeTask({}, "t").labels, []);
		assert.match(renderTask({ ...normalizeTask({ title: "T", labels: ["CI зелёный"] }, "t"), files: [] }), /Labels: CI зелёный/);
		assert.match(formatDoc("C:/x"), /"labels": \["CI зелёный", "конфликт"\]/);
		assert.match(formatDoc("C:/x"), /## Что сделано/);
		assert.match(toolDescription("C:/x"), /`labels`/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("text renders without throwing", async () => {
	assert.match(toolDescription("C:/x"), /task_board|`create`/);
	const task = normalizeTask({ title: "T", status: "changes_requested", review: { decision: "changes_requested", comment: "fix", round: 1 } }, "t");
	const text = renderTask({ ...task, files: [{ path: "a.png", kind: "image", caption: "c" }] });
	assert.match(text, /Reviewer's comment: fix/);
	assert.match(renderList([{ id: "t", title: "T", status: "review", files: { images: 1, videos: 0 } }], "active"), /`t`/);
});

test("checks: tick by text, survive new criteria, reset on submit, recorded in review", async () => {
	const { base, store } = await fresh();
	try {
		const { value } = await store.create({ title: "Чеклист", acceptance: ["a", "b"], submit: true });
		const id = value.id;
		const v0 = store.version;
		const ticked = await store.setCheck(id, { item: "a", checked: true });
		assert.deepEqual(ticked.value.checks, ["a"]);
		assert.ok(store.version > v0, "version bumps on a write");
		const nope = await store.setCheck(id, { item: "zzz", checked: true });
		assert.equal(nope.error.code, "not-found");
		await store.update(id, { acceptance: ["b", "a", "c"] });
		const got = await store.get(id);
		assert.deepEqual(got.value.checks, ["a"], "new criteria appear unticked, old tick stays");
		const summary = (await store.list()).value.tasks[0];
		assert.deepEqual(summary.checks, { done: 1, total: 3 });
		assert.equal(typeof summary.coverVersion, "number");
		const back = await store.review(id, { decision: "changes_requested", comment: "не всё" });
		assert.deepEqual(back.value.review.checked, ["a"]);
		assert.deepEqual(back.value.review.unchecked, ["b", "c"]);
		assert.match(renderTask({ ...back.value, files: [] }), /did NOT tick:\n  - b\n  - c/);
		assert.match(renderTask({ ...back.value, files: [] }), /\[x\] a/);
		const again = await store.submit(id, { note: "готово" });
		assert.deepEqual(again.value.checks, [], "a new round starts clean");
		const raw = JSON.parse(await readFile(join(store.root, id, "task.json"), "utf8"));
		assert.equal("checks" in raw, false);
		const untick = await store.setCheck(id, { item: "a", checked: true });
		assert.deepEqual(untick.value.checks, ["a"]);
		const cleared = await store.setCheck(id, { item: "a", checked: false });
		assert.deepEqual(cleared.value.checks, []);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("comment: history entry without a status change", async () => {
	const { base, store } = await fresh();
	try {
		const { value } = await store.create({ title: "Вопрос", submit: true });
		const empty = await store.comment(value.id, { note: "  " });
		assert.equal(empty.error.code, "invalid-request");
		const noted = await store.comment(value.id, { note: "А точно нужен тёмный фон?", by: "agent" });
		assert.equal(noted.value.status, "review");
		assert.deepEqual(noted.value.history.at(-1), { ...noted.value.history.at(-1), action: "commented", comment: "А точно нужен тёмный фон?" });
		assert.match(toolDescription("C:/x"), /`comment`/);
		assert.match(formatDoc("C:/x"), /"commented"/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rpc: version, archivedCount, check and reveal", async () => {
	const { base, store } = await fresh();
	try {
		const revealed = [];
		const rpc = createRpcHandler(store, { reveal: async (dir) => { revealed.push(dir); } });
		const v1 = await rpcCall(rpc, { action: "version" });
		assert.equal(v1.ok, true);
		assert.equal(typeof v1.value.version, "number");
		const created = await store.create({ title: "Задача", acceptance: ["x"], submit: true });
		const v2 = await rpcCall(rpc, { action: "version" });
		assert.ok(v2.value.version > v1.value.version);
		const list = await rpcCall(rpc, { action: "list" });
		assert.equal(list.value.archivedCount, 0);
		assert.equal(list.value.version, v2.value.version);
		const checked = await rpcCall(rpc, { action: "check", id: created.value.id, item: "x" });
		assert.deepEqual(checked.value.checks, ["x"]);
		const shown = await rpcCall(rpc, { action: "reveal", id: created.value.id });
		assert.equal(shown.ok, true);
		assert.equal(revealed.length, 1);
		assert.equal(revealed[0], join(store.root, created.value.id));
		const missing = await rpcCall(rpc, { action: "reveal", id: "nope" });
		assert.equal(missing.error.code, "not-found");
		await store.review(created.value.id, { decision: "approved" });
		await store.done(created.value.id);
		const list2 = await rpcCall(rpc, { action: "list" });
		assert.equal(list2.value.archivedCount, 1);
		assert.equal(list2.value.tasks.length, 0);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("fs.watch bumps the version for external writes", async () => {
	const { base, store } = await fresh();
	try {
		await store.ensureRoot(undefined, { watch: true });
		const before = store.version;
		await mkdir(join(store.root, "ext"));
		await writeFile(join(store.root, "ext", "task.json"), JSON.stringify({ title: "Внешняя" }));
		const deadline = Date.now() + 3000;
		while (store.version === before && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
		assert.ok(store.version > before, "watcher noticed the new task");
	} finally {
		store.close();
		await rm(base, { recursive: true, force: true });
	}
});

test("events.jsonl: one line per action, readable by offset", async () => {
	const { base, store } = await fresh();
	try {
		const { value } = await store.create({ title: "События", acceptance: ["a"], submit: true, note: "смотри" });
		await store.setCheck(value.id, { item: "a", checked: true });
		await store.review(value.id, { decision: "changes_requested", comment: "не так" });
		const lines = (await readFile(join(store.root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines.map((e) => e.type), ["created", "submitted", "checked", "changes_requested"]);
		assert.equal(lines[1].comment, "смотри");
		assert.equal(lines[2].done, 1);
		assert.deepEqual(lines[3].unchecked, undefined, "all ticked → no unchecked key");
		assert.equal(lines.every((e) => e.id === value.id && typeof e.at === "string"), true);
		const all = await store.events();
		assert.equal(all.events.length, 4);
		assert.ok(all.offset > 0);
		await store.comment(value.id, { note: "ок" });
		const tail = await store.events({ offset: all.offset });
		assert.deepEqual(tail.events.map((e) => e.type), ["commented"]);
		assert.ok(tail.offset > all.offset);
		assert.deepEqual((await store.events({ offset: tail.offset })).events, []);
		const rpc = createRpcHandler(store);
		const viaRpc = await rpcCall(rpc, { action: "events", offset: all.offset });
		assert.equal(viaRpc.value.events[0].type, "commented");
		assert.equal((await store.list()).value.tasks.length, 1, "events.jsonl is not mistaken for a task");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("waitForChange: resolves on a write, times out otherwise, rpc wait caps the timeout", async () => {
	const { base, store } = await fresh();
	try {
		const quiet = await store.waitForChange(store.version, 30);
		assert.deepEqual(quiet, { version: store.version, changed: false });
		const since = store.version;
		const pending = store.waitForChange(since, 5000);
		const t0 = Date.now();
		setTimeout(() => { store.create({ title: "Проснись", submit: true }); }, 20);
		const woke = await pending;
		assert.equal(woke.changed, true);
		assert.ok(woke.version > since);
		assert.ok(Date.now() - t0 < 2000, "did not wait for the timeout");
		const stale = await store.waitForChange(since, 5000);
		assert.equal(stale.changed, true, "an old version resolves at once");
		const rpc = createRpcHandler(store);
		const t1 = Date.now();
		const viaRpc = await rpcCall(rpc, { action: "wait", since: store.version, timeout: 40 });
		assert.equal(viaRpc.value.changed, false);
		assert.ok(Date.now() - t1 < 1500);
		assert.equal(typeof viaRpc.value.root, "string");
		store.close();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rpc reveal without an id opens the board root", async () => {
	const { base, store } = await fresh();
	try {
		const revealed = [];
		const rpc = createRpcHandler(store, { reveal: async (dir) => { revealed.push(dir); } });
		const shown = await rpcCall(rpc, { action: "reveal" });
		assert.equal(shown.ok, true);
		assert.deepEqual(revealed, [store.root]);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("info: real paths of this OS; list, version and wait carry them", async () => {
	const { base, store } = await fresh();
	try {
		const info = store.info();
		assert.equal(info.paths.root, store.root);
		assert.equal(info.paths.format, join(store.root, "FORMAT.md"));
		assert.equal(info.paths.events, join(store.root, "events.jsonl"));
		assert.equal(info.paths.archive, join(store.root, "_archive"));
		assert.ok(info.sep === "/" || info.sep === "\\");
		assert.equal(info.watching, false);
		const rpc = createRpcHandler(store);
		for (const action of ["list", "version"]) {
			const result = await rpcCall(rpc, { action });
			assert.equal(result.value.paths.format, info.paths.format, action);
			assert.equal(result.value.sep, info.sep, action);
		}
		const waited = await rpcCall(rpc, { action: "wait", since: store.version, timeout: 20 });
		assert.equal(waited.value.paths.events, info.paths.events);
		assert.equal(waited.value.changed, false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("no watcher: outside writes are still noticed by the rescan", async () => {
	const base = await mkdtemp(join(process.env.TB_TMP ?? tmpdir(), "tb-"));
	const store = new TaskStore(join(base, "board"), { scanMs: 40 });
	try {
		await store.ensureRoot();
		assert.equal(store.watcher, null);
		const since = store.version;
		const pending = store.waitForChange(since, 4000);
		setTimeout(async () => {
			await mkdir(join(store.root, "outside"));
			await writeFile(join(store.root, "outside", "task.json"), JSON.stringify({ title: "Снаружи" }));
		}, 120);
		const woke = await pending;
		assert.equal(woke.changed, true, "the rescan saw the new folder");
		const rpc = createRpcHandler(store);
		const v1 = (await rpcCall(rpc, { action: "version" })).value.version;
		await new Promise((done) => setTimeout(done, 60));
		await writeFile(join(store.root, "outside", "task.json"), JSON.stringify({ title: "Снаружи, правка", status: "review" }));
		await new Promise((done) => setTimeout(done, 60));
		const v2 = (await rpcCall(rpc, { action: "version" })).value.version;
		assert.ok(v2 > v1, "version poll rescans too");
	} finally {
		store.close();
		await rm(base, { recursive: true, force: true });
	}
});

/** Loads lib/client.js the way the app's module loader does and returns its test exports. */
async function clientInternals() {
	const source = await readFile(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	const react = { createElement: () => null, Fragment: "Fragment", useState: (init) => [init, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }), useMemo: (fn) => fn() };
	let exports;
	const window = { __ModuleLoader__: { load: (def) => { exports = def.factory(() => react); } } };
	vm.runInNewContext(source, { window, document: {}, navigator: {}, URL, console, setTimeout, clearTimeout });
	return exports.__internals;
}

test("panel: list filters by status", async () => {
	const { BOARD_TABS, boardTab, groupTasks } = await clientInternals();
	// Array.from: values made inside the vm context have another realm's prototypes.
	assert.deepEqual(Array.from(BOARD_TABS, (tab) => tab.label), ["В работе", "На доработке", "На проверке"]);
	assert.equal(boardTab({ status: "in_progress" }), "working");
	assert.equal(boardTab({ status: "changes_requested" }), "changes");
	assert.equal(boardTab({ status: "review" }), "review");
	assert.equal(boardTab({ status: "approved" }), "review", "an accepted task waits under «На проверке» until it is closed");
	assert.equal(boardTab({ status: "something-new" }), "review", "an unknown status is never hidden");
	const groups = groupTasks([
		{ id: "a", status: "review" },
		{ id: "b", status: "in_progress" },
		{ id: "c", status: "approved" },
		{ id: "d", status: "changes_requested" },
		{ id: "e", status: "in_progress" },
	]);
	assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, tasks]) => [key, Array.from(tasks, (task) => task.id)])), { working: ["b", "e"], changes: ["d"], review: ["a", "c"] });
	assert.equal(Array.from(BOARD_TABS).every((tab) => Array.isArray(groups[tab.id])), true);
});
