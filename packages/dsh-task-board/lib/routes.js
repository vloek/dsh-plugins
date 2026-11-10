// HTTP faces of the store, mounted as exact Fetch routes on the host connection.
// Plain Web Request -> Response functions so they run (and test) without a harness.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export const RPC_PATH = "/api/dsh-task-board/rpc";
export const MEDIA_PATH = "/api/dsh-task-board/media";

const MAX_BODY = 1024 * 1024;
// One HTTP long poll never hangs longer than this; the client simply asks again.
const MAX_RPC_WAIT_MS = 30000;
const RANGE_CHUNK = 8 * 1024 * 1024;
const WHOLE_LIMIT = 32 * 1024 * 1024;

// Files the agent wrote are served on the app's own origin, so nothing in them may run.
const SAFE_HEADERS = {
	"x-content-type-options": "nosniff",
	"content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
	"cache-control": "no-store",
};

function json(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

/** Show a folder in the OS file manager (Explorer / Finder / xdg-open). */
export function openInFileManager(dir) {
	const [command, args] =
		process.platform === "win32" ? ["explorer.exe", [dir.replace(/\//g, "\\")]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
	return new Promise((done, reject) => {
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", reject);
			child.unref();
			done();
		} catch (error) {
			reject(error);
		}
	});
}

/** POST {action, ...} -> {ok, value} | {ok:false, error}. */
export function createRpcHandler(store, { formatDoc, reveal = openInFileManager } = {}) {
	return async function handle(request) {
		if (request.method !== "POST") return json({ ok: false, error: { code: "method-not-allowed", message: "POST only" } }, 405);
		let input;
		try {
			const raw = await request.text();
			if (raw.length > MAX_BODY) return json({ ok: false, error: { code: "too-large", message: "request too large" } }, 413);
			input = JSON.parse(raw);
		} catch {
			return json({ ok: false, error: { code: "invalid-request", message: "body must be JSON" } }, 400);
		}
		if (!input || typeof input !== "object") return json({ ok: false, error: { code: "invalid-request", message: "body must be an object" } }, 400);
		try {
			switch (input.action) {
				case "version":
					// The cheap poll: nothing is read from disk while fs.watch works; without it, a throttled rescan.
					await store.refreshIfUnwatched();
					return json({ ok: true, value: store.info() });
				case "wait": {
					// The long poll: answers when the board changes past `since`, or after `timeout` ms.
					const result = await store.waitForChange(input.since, Math.min(Number(input.timeout) || 25000, MAX_RPC_WAIT_MS));
					return json({ ok: true, value: { ...store.info(), ...result } });
				}
				case "events":
					return json({ ok: true, value: await store.events({ offset: input.offset, limit: input.limit }) });
				case "list":
					return json(await store.list({ archived: input.archived === true }));
				case "get":
					return json(await store.get(input.id, { archived: input.archived === true }));
				case "check":
					return json(await store.setCheck(input.id, { item: input.item, checked: input.checked !== false }));
				case "review":
					return json(await store.review(input.id, { decision: input.decision, comment: input.comment, by: "reviewer" }));
				case "done":
					return json(await store.done(input.id, { by: "reviewer" }));
				case "restore":
					return json(await store.restore(input.id));
				case "delete":
					return json(await store.remove(input.id, { archived: input.archived === true }));
				case "reveal": {
					// No id: show the board's root folder.
					if (input.id === undefined || input.id === null || input.id === "") {
						await reveal(store.root);
						return json({ ok: true, value: { dir: store.root } });
					}
					const dir = await store.existingDir(input.id, input.archived === true);
					if (dir === undefined) return json({ ok: false, error: { code: "not-found", message: `no task ${JSON.stringify(input.id)}` } });
					await reveal(dir);
					return json({ ok: true, value: { dir } });
				}
				case "format":
					return json({ ok: true, value: { root: store.root, format: formatDoc ?? "" } });
				default:
					return json({ ok: false, error: { code: "unknown-action", message: String(input.action) } }, 400);
			}
		} catch (error) {
			return json({ ok: false, error: { code: "failed", message: error?.message ?? String(error) } }, 500);
		}
	};
}

/** GET ?id=&file=&archived=1 — a task file, with byte ranges so videos can seek. */
export function createMediaHandler(store) {
	return async function handle(request) {
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
		const url = new URL(request.url);
		const id = url.searchParams.get("id") ?? "";
		const file = url.searchParams.get("file") ?? "";
		const archived = url.searchParams.get("archived") === "1";
		const found = await store.resolveFile(id, file, { archived });
		if (found === undefined) return new Response("not found", { status: 404, headers: SAFE_HEADERS });
		const base = { ...SAFE_HEADERS, "content-type": found.type, "accept-ranges": "bytes", "content-disposition": "inline" };
		const size = found.size;
		const range = request.headers.get("range");
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
			let start;
			let end;
			if (match && (match[1] !== "" || match[2] !== "")) {
				if (match[1] === "") {
					const suffix = Number(match[2]);
					start = Math.max(0, size - suffix);
					end = size - 1;
				} else {
					start = Number(match[1]);
					end = match[2] === "" ? Math.min(size - 1, start + RANGE_CHUNK - 1) : Math.min(Number(match[2]), size - 1);
				}
			}
			if (start === undefined || !(start <= end) || start >= size) {
				return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
			}
			end = Math.min(end, start + RANGE_CHUNK - 1);
			const body = request.method === "HEAD" ? null : await store.readRange(found.abs, start, end);
			return new Response(body, {
				status: 206,
				headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
			});
		}
		if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...base, "content-length": String(size) } });
		if (size <= WHOLE_LIMIT) {
			const body = size === 0 ? new Uint8Array(0) : await store.readRange(found.abs, 0, size - 1);
			return new Response(body, { status: 200, headers: { ...base, "content-length": String(size) } });
		}
		return new Response(Readable.toWeb(createReadStream(found.abs)), { status: 200, headers: { ...base, "content-length": String(size) } });
	};
}
