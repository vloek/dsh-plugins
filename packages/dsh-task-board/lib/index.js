// dsh-task-board, host half: the store, two exact Fetch routes for the browser
// half, the model-facing `task_board` tool, a prompt section and a runtime skill.
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskStore } from "./store.js";
import { createMediaHandler, createRpcHandler, MEDIA_PATH, RPC_PATH } from "./routes.js";
import { formatDoc, promptSection, renderError, renderList, renderTask, skillContent, toolDescription } from "./text.js";

export const name = "task-board";
export const inject = ["tools"];

// Schemastery fields are optional by default; there is no `.optional()`.
export const Config = z.object({
	/** Absolute folder holding the tasks (default: `$DSH_HOME/task-board`). */
	root: z.string(),
	/** What "done" does with a task folder: `archive` (move to `_archive/`) or `delete`. */
	onDone: z.string().default("archive"),
	promptSection: z.boolean().default(true),
	skill: z.boolean().default(true),
});

const LIST_FILTERS = ["active", "review", "changes_requested", "approved", "in_progress", "archived", "all"];
const COMMANDS = ["list", "get", "create", "update", "attach", "submit", "comment", "wait", "complete"];
const WAIT_DEFAULT_S = 120;
const WAIT_MAX_S = 600;

/** Block until the task's status or review changes (or `seconds` pass); returns the task as it is then. */
async function waitForTask(store, id, seconds) {
	const first = await store.get(id);
	if (!first.ok) return first;
	const ms = Math.max(1, Math.min(Number(seconds) || WAIT_DEFAULT_S, WAIT_MAX_S)) * 1000;
	const deadline = Date.now() + ms;
	const mark = (task) => `${task.status}|${task.review?.at ?? ""}|${task.history.length}`;
	const start = mark(first.value);
	let since = store.version;
	while (Date.now() < deadline) {
		const { version, changed } = await store.waitForChange(since, deadline - Date.now());
		since = version;
		if (!changed) break;
		const current = await store.get(id);
		if (!current.ok) return current;
		if (mark(current.value) !== start) return { ok: true, value: current.value, changed: true };
	}
	const last = await store.get(id);
	return last.ok ? { ok: true, value: last.value, changed: false } : last;
}

async function listFor(store, filter) {
	if (filter === "archived") return await store.list({ archived: true });
	const active = await store.list({ archived: false });
	if (!active.ok) return active;
	if (filter === "all") {
		const archived = await store.list({ archived: true });
		const tasks = [...active.value.tasks, ...(archived.ok ? archived.value.tasks : [])];
		return { ok: true, value: { ...active.value, tasks } };
	}
	if (filter === "active") return active;
	return { ok: true, value: { ...active.value, tasks: active.value.tasks.filter((task) => task.status === filter) } };
}

function registerTool(ctx, store) {
	ctx.tools.register(
		defineTool({
			name: "task_board",
			description: toolDescription(store.root),
			parameters: {
				command: {
					type: "string",
					required: true,
					enum: COMMANDS,
					description: "The command to run: " + COMMANDS.map((command) => `\`${command}\``).join(", ") + ".",
				},
				id: { type: "string", description: "Task id (its folder name). Required for every command except `list`; optional for `create`." },
				status: { type: "string", enum: LIST_FILTERS, description: "For `list`: which tasks to show. Default `active`." },
				title: { type: "string", description: "For `create` (required) and `update`: short task title." },
				description: { type: "string", description: "For `create` and `update`: what was done and how the reviewer can check it. Markdown: `## ` lines become section headings (e.g. `## Что сделано`, `## Зачем это нужно`, `## Чем проверено`); lists, **bold**, `code`, fenced code blocks and http(s) links are rendered." },
				labels: { type: "array", items: { type: "string" }, description: "For `create` and `update`: short status chips shown on the task, e.g. `CI зелёный`, `конфликт`, `in QA 2`. Empty array clears them." },
				acceptance: { type: "array", items: { type: "string" }, description: "For `create` and `update`: the checks the reviewer should make, one per item. The reviewer ticks them off in the panel; `get` shows which are ticked." },
				submit: { type: "boolean", description: "For `create`: put the task up for review immediately." },
				branch: { type: "string", description: "For `create`, `update` and `submit`: the git branch with the work, e.g. `feature/login-validation`. Empty string clears it." },
				pr: { type: "string", description: "For `create`, `update` and `submit`: full URL of the pull/merge request, e.g. `https://github.com/org/repo/pull/123`. Empty string clears it." },
				source: { type: "string", description: "For `attach`: absolute path of the file to copy into the task." },
				name: { type: "string", description: "For `attach`: file name inside the task folder (default: the source's name)." },
				caption: { type: "string", description: "For `attach`: one line saying what the file shows." },
				note: { type: "string", description: "For `submit` and `create` with `submit`: what to check, or what changed since the last review. For `comment`: the message for the reviewer." },
				seconds: { type: "number", description: `For \`wait\`: how long to wait for the reviewer, in seconds (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}).` },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute(args, exec) {
				const by = exec?.agent?.id ? `agent:${String(exec.agent.id).slice(0, 8)}` : "agent";
				switch (args.command) {
					case "list": {
						const filter = LIST_FILTERS.includes(args.status) ? args.status : "active";
						const result = await listFor(store, filter);
						return result.ok ? renderList(result.value.tasks, filter) : renderError(result.error);
					}
					case "get": {
						const result = await store.get(args.id);
						return result.ok ? renderTask(result.value) : renderError(result.error);
					}
					case "create": {
						const result = await store.create({ id: args.id, title: args.title, description: args.description, acceptance: args.acceptance, labels: args.labels, author: by, submit: args.submit === true, note: args.note, pr: args.pr, branch: args.branch });
						return result.ok ? `Created.\n\n${renderTask(result.value)}` : renderError(result.error);
					}
					case "update": {
						const result = await store.update(args.id, { title: args.title, description: args.description, acceptance: args.acceptance, labels: args.labels, pr: args.pr, branch: args.branch });
						return result.ok ? `Updated \`${args.id}\`.` : renderError(result.error);
					}
					case "attach": {
						const result = await store.attach(args.id, args.source, { name: args.name, caption: args.caption });
						return result.ok ? `Attached to \`${args.id}\`; it now has ${result.value.evidence.length} evidence file(s).` : renderError(result.error);
					}
					case "submit": {
						const result = await store.submit(args.id, { note: args.note, by, pr: args.pr, branch: args.branch });
						return result.ok ? `Submitted \`${args.id}\` for review (round ${result.value.round}). The reviewer decides in the "Задачи" panel; check back with \`get\` or \`list\`.` : renderError(result.error);
					}
					case "comment": {
						const result = await store.comment(args.id, { note: args.note, by });
						return result.ok ? `Comment added to \`${args.id}\` (status unchanged: ${result.value.status}).` : renderError(result.error);
					}
					case "wait": {
						const result = await waitForTask(store, args.id, args.seconds);
						if (!result.ok) return renderError(result.error);
						const head = result.changed ? "The task changed:" : `Nothing happened in ${Math.min(Number(args.seconds) || WAIT_DEFAULT_S, WAIT_MAX_S)} s; current state:`;
						return `${head}\n\n${renderTask(result.value)}`;
					}
					case "complete": {
						const result = await store.done(args.id, { by });
						return result.ok ? `Closed \`${args.id}\`: ${result.value.closed}.` : renderError(result.error);
					}
					default:
						return "task_board: unknown command";
				}
			},
			presentCall(args) {
				return { card: "generic", title: `task_board ${args.command ?? ""}${args.id ? " " + args.id : ""}` };
			},
		}),
	);
}

export function apply(ctx, config = {}) {
	const root = typeof config.root === "string" && config.root.trim() !== "" ? config.root : dshHomePath("task-board");
	const store = new TaskStore(root, { onDone: config.onDone });
	const doc = formatDoc(store.root);
	store.ensureRoot(doc, { watch: true }).catch((error) => {
		console.warn(`[dsh-task-board] could not prepare ${store.root}: ${error?.message ?? error}`);
	});
	if (typeof ctx.effect === "function") ctx.effect(() => () => store.close());

	registerTool(ctx, store);

	if (config.promptSection !== false) {
		const systemPrompt = ctx.get("systemPrompt");
		if (systemPrompt !== undefined) systemPrompt.section({ name: "task-board", order: 160, text: promptSection(store.root) });
	}
	if (config.skill !== false) {
		const skills = ctx.get("skills");
		if (skills !== undefined) {
			skills.register({
				name: "task-board-format",
				description: "The on-disk format of the task review board (`task_board` tool): folder per task, task.json fields, statuses, and the agent loop for submitting work with screenshots/videos and acting on the reviewer's verdict. Read when editing task folders by hand or explaining the board to another agent.",
				source: "runtime",
				content: skillContent(store.root),
			});
		}
	}

	// Optional: the browser half talks to these routes. Without a web connection the tool still works.
	ctx.inject(["connection"], (child) => {
		if (typeof child.connection?.fetch?.register !== "function") return;
		child.effect(() => {
			const rpc = createRpcHandler(store, { formatDoc: doc });
			const media = createMediaHandler(store);
			const stops = [
				child.connection.fetch.register({ path: RPC_PATH, methods: ["POST"], requestBody: "buffered", fetch: rpc }),
				child.connection.fetch.register({ path: MEDIA_PATH, methods: ["GET", "HEAD"], requestBody: "buffered", fetch: media }),
			];
			return async () => {
				for (const stop of stops) if (typeof stop === "function") await stop();
			};
		});
	});
}
