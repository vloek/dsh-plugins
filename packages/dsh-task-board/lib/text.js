// Every word this plugin says to a model lives here, so it is reviewable in one place.

const STATUS_TEXT = {
	in_progress: "in_progress (being worked on, not yet submitted)",
	review: "review (waiting for the human reviewer)",
	changes_requested: "changes_requested (the reviewer sent it back — rework it)",
	approved: "approved (the reviewer accepted it — close it with `complete`)",
	done: "done (closed)",
};

/** The format note written to `<root>/FORMAT.md` for agents that work outside DSH. */
export function formatDoc(root) {
	return `# Task board format

Доска задач на проверку (плагин dsh-task-board). Этот файл генерируется автоматически.

This folder is a review board. A human reviews each task in the DSH "Задачи" panel and either
approves it or sends it back with a comment. Any agent that can write files can take part.

Root: \`${root}\`

## Layout

\`\`\`
<root>/
  FORMAT.md                 this file (rewritten by the plugin)
  events.jsonl              append-only log of everything that happened (see "Events")
  <task-id>/                one folder per task; the folder name is the id
    task.json               metadata (UTF-8 JSON, the only required file)
    *.png *.jpg *.webp *.gif   screenshots — shown as a gallery
    *.mp4 *.webm *.mov      videos — shown with a player
    *.md *.txt *.log *.json other evidence — shown as previewable files
  _archive/<task-id>/       closed tasks (moved here when the task is done)
\`\`\`

Folder names: no slashes, no leading \`.\` or \`_\`, at most 100 characters. Subfolders are fine
(files up to 4 levels deep are shown). Names starting with \`.\` are ignored.

## task.json

\`\`\`json
{
  "id": "login-form-validation",
  "title": "Validate the login form",
  "description": "## Что сделано\\nWhat was done.\\n\\n## Зачем это нужно\\nWhy.\\n\\n## Чем проверено\\n- unit tests\\n- checked in the browser",
  "acceptance": ["Empty email shows an error", "Wrong password shows an error"],
  "checks": ["Empty email shows an error"],
  "labels": ["CI зелёный", "конфликт"],
  "status": "review",
  "branch": "feature/login-validation",
  "pr": "https://github.com/org/repo/pull/123",
  "author": "claude-code",
  "createdAt": "2026-10-29T10:00:00.000Z",
  "updatedAt": "2026-10-29T10:00:00.000Z",
  "round": 1,
  "evidence": [
    { "file": "01-empty-email.png", "caption": "Empty email" },
    { "file": "flow.mp4", "caption": "Full flow" }
  ],
  "review": null,
  "history": [
    { "at": "2026-10-29T10:00:00.000Z", "by": "claude-code", "action": "submitted", "comment": "Ready" }
  ]
}
\`\`\`

Only \`title\` is really needed; everything else has a default. Unknown fields are kept.
\`evidence\` only sets order and captions — every media file in the folder is shown anyway.

Presentation in the panel:

- \`description\` is Markdown (a safe subset): a line starting with \`## \` starts a titled section
  (e.g. \`## Что сделано\`, \`## Зачем это нужно\`, \`## Чем проверено\`); \`-\` / \`1.\` lists, **bold**,
  \`inline code\`, fenced code blocks, \`> quotes\` and http(s) links are rendered. Text before the first
  heading is shown under "Что сделано".
- \`acceptance\` is shown as "На что смотреть" with a checkbox per item. The reviewer ticks the items
  that pass while checking; the ticked ones are stored in \`checks\` (by text, so criteria you add later
  simply appear unticked). A new \`review\` round starts with nothing ticked.
- \`labels\` — up to 12 short chips next to the status (\`CI зелёный\`, \`конфликт\`, \`in QA 2\`…).
  Colour is picked from the words: green for passing/green/ok, red for conflict/failing/red, amber for QA/waiting.
- Files changed after the reviewer's last decision are marked "новое", so put fresh screenshots in
  (or overwrite the old ones) when you resubmit.

Code links (strongly recommended whenever the work is code):

- \`branch\` — the git branch with the work, plain name without \`refs/heads/\` (e.g. \`feature/login-validation\`).
  The board shows it with a copy button so the reviewer can check it out.
- \`pr\` — the full http(s) URL of the pull / merge request (GitHub, GitLab, Bitbucket, Gitea…).
  The board shows it as a link that opens in the browser.

Fill them in when you create the task, or as soon as the PR exists; update \`pr\` if you open a new PR
after rework. Leave them out (or empty) when the task is not about code.

## Statuses and who changes them

| status | meaning | next step |
|---|---|---|
| \`in_progress\` | the agent is still working | agent sets \`review\` when ready |
| \`review\` | waiting for the human | human: approve or send back |
| \`changes_requested\` | sent back; read \`review.comment\` and \`review.unchecked\` | agent reworks, updates evidence, sets \`review\` again |
| \`approved\` | accepted by the human | agent (or human) closes it → \`done\`, folder moves to \`_archive/\` |
| \`done\` | closed | — |

When the reviewer decides, the board writes:

\`\`\`json
"status": "changes_requested",
"review": {
  "decision": "changes_requested",
  "comment": "The error text overlaps the button",
  "at": "…", "by": "reviewer", "round": 1,
  "checked": ["Empty email shows an error"],
  "unchecked": ["Wrong password shows an error"]
},
"history": [ …, { "at": "…", "by": "reviewer", "action": "changes_requested", "comment": "…" } ]
\`\`\`

\`review.unchecked\` lists the acceptance criteria the reviewer did not tick — treat each as something
to fix or to explain, even when \`comment\` does not mention it.

## Events

Every change made through the board is appended to \`<root>/events.jsonl\`, one JSON object per line:

\`\`\`json
{"at":"2026-11-09T19:02:11.412Z","type":"changes_requested","id":"login-form-validation","by":"reviewer","round":1,"comment":"The error text overlaps the button","unchecked":["Wrong password shows an error"]}
{"at":"2026-11-09T19:05:40.001Z","type":"checked","id":"login-form-validation","by":"reviewer","item":"Empty email shows an error","done":1,"total":2}
\`\`\`

\`type\` is one of \`created\`, \`updated\`, \`attached\`, \`submitted\`, \`resubmitted\`, \`commented\`, \`checked\`, \`unchecked\`,
\`approved\`, \`changes_requested\`, \`done\`, \`restored\`, \`deleted\`. The reviewer's decisions carry \`comment\` and
\`unchecked\`. Tasks written by hand (outside the board) do not appear here until the reviewer acts on them.

To wait for the reviewer instead of polling task.json, watch this one file (tail it, \`fs.watch\` it, or use a
file-monitor tool on it) and read the task when a line with your task id arrives. The DSH host also answers
\`POST /api/dsh-task-board/rpc\` with \`{"action":"wait","since":<version>,"timeout":<ms ≤ 30000>}\` (long poll;
\`{"action":"version"}\` gives the current version) and \`{"action":"events","offset":<byte offset>}\` for the lines after
an offset. Inside DeepSeek Harness the \`task_board\` tool has \`wait\`.

## Agent loop

1. Create \`<root>/<task-id>/task.json\` with status \`in_progress\`; put screenshots/videos next to it;
   fill \`branch\` and \`pr\` if the work is in a repository.
2. When the work is ready, set \`status\` to \`review\`, increase \`round\`, remove \`checks\`, append a history entry
   \`{ "action": "submitted", "by": "<you>", "comment": "what to check" }\`.
3. Later, read \`task.json\`:
   - \`changes_requested\` → fix what \`review.comment\` and \`review.unchecked\` say, replace the evidence,
     set \`review\` again (history action \`resubmitted\`).
   - \`approved\` → set \`status\` to \`done\` and move the folder to \`_archive/\` (or let the human press
     "Выполнено" in the board).
   - To tell the reviewer something without changing the status, append
     \`{ "action": "commented", "by": "<you>", "comment": "…" }\` to \`history\`.
4. Write task.json atomically if you can (write a temp file, then rename).

Inside DeepSeek Harness, use the \`task_board\` tool instead of editing files by hand.
`;
}

/** The tool description the model reads. */
export function toolDescription(root) {
	return `Review board for finished work: put a task with screenshots or videos up for the human to check, then act on the verdict.

Tasks live in \`${root}\`, one folder per task with a \`task.json\` and its evidence files. The human reviews them in the "Задачи" panel of the app and either approves a task or sends it back with a comment.

Statuses: \`in_progress\` → \`review\` → \`changes_requested\` (rework, then submit again) or \`approved\` → \`done\` (archived).

Commands:
- \`list\` — tasks on the board; \`status\` filters: \`active\` (default), \`review\`, \`changes_requested\`, \`approved\`, \`in_progress\`, \`archived\`, \`all\`.
- \`get\` — one task in full: description, acceptance criteria with the reviewer's ticks, files, the reviewer's latest comment, history. Needs \`id\`.
- \`create\` — new task. Needs \`title\`; optional \`id\` (folder name, generated from the title otherwise), \`description\` (Markdown; \`## \` lines become section headings), \`acceptance\` (list of checks the reviewer ticks off), \`labels\` (short status chips such as \`CI зелёный\`), \`branch\` (git branch with the work), \`pr\` (pull/merge request URL), \`submit: true\` to put it up for review at once.
- \`update\` — change \`title\`, \`description\`, \`acceptance\`, \`labels\`, \`branch\` or \`pr\` of task \`id\` (an empty string clears \`branch\`/\`pr\`, an empty list clears \`labels\`).
- \`attach\` — copy a file (absolute path in \`source\`) into task \`id\` as evidence; optional \`name\` and \`caption\`. Screenshots (.png .jpg .webp .gif) show as a gallery, videos (.mp4 .webm .mov) get a player, other files are listed.
- \`submit\` — put task \`id\` up for review (first time or after rework); \`note\` tells the reviewer what to check or what changed; \`branch\`/\`pr\` may be set here too.
- \`comment\` — leave \`note\` for the reviewer on task \`id\` without changing its status (a question, a heads-up).
- \`wait\` — block until the reviewer acts on task \`id\` (decision, tick, comment) or \`seconds\` pass (default 120, max 600); returns the task as it is then. Use it right after \`submit\` instead of polling with \`get\`.
- \`complete\` — close an approved task \`id\`; it moves to the archive.

When the work is code, always give \`branch\` and, once it exists, \`pr\` — the reviewer opens the PR from the board.

Typical loop: \`create\` → \`attach\` the evidence → \`submit\` → \`wait\`. Later \`list\` with \`status: "changes_requested"\` and \`status: "approved"\`: rework and \`submit\` again, or \`complete\`. When a task comes back, \`get\` shows which acceptance criteria the reviewer left unticked — fix or explain each of them, not only what the comment says. Never mark your own task approved — only the human approves.`;
}

/** The short system-prompt section. */
export function promptSection(root) {
	return `## Task review board

A human-run review board is available through the \`task_board\` tool (store: \`${root}\`). When the user asks to put work up for review, to check what was sent back, or to close accepted tasks, use it: create a task, attach screenshots/videos as evidence, submit it, and later rework \`changes_requested\` tasks or \`complete\` \`approved\` ones. Only the human approves.`;
}

/** The bundled skill: the same format note, for agents that prefer reading files. */
export function skillContent(root) {
	return formatDoc(root);
}

function fileLine(file) {
	const tag = file.missing ? " (missing)" : "";
	const caption = file.caption ? ` — ${file.caption}` : "";
	return `  - ${file.path} [${file.kind}]${caption}${tag}`;
}

/** One task, in full, for the model. */
export function renderTask(task) {
	const lines = [];
	const checks = Array.isArray(task.checks) ? task.checks : [];
	lines.push(`Task \`${task.id}\`${task.archived ? " (archived)" : ""}: ${task.title}`);
	lines.push(`Status: ${STATUS_TEXT[task.status] ?? task.status}; round ${task.round}`);
	if (task.labels && task.labels.length > 0) lines.push(`Labels: ${task.labels.join(", ")}`);
	if (task.branch) lines.push(`Branch: \`${task.branch}\``);
	if (task.pr) lines.push(`PR: ${task.pr}`);
	if (task.dir) lines.push(`Folder: \`${task.dir}\``);
	if (task.review && task.review.decision) {
		lines.push("");
		lines.push(`Reviewer's latest decision (round ${task.review.round ?? "?"}): ${task.review.decision}`);
		if (task.review.comment) lines.push(`Reviewer's comment: ${task.review.comment}`);
		if (Array.isArray(task.review.unchecked) && task.review.unchecked.length > 0) {
			lines.push("Criteria the reviewer did NOT tick:", ...task.review.unchecked.map((item) => `  - ${item}`));
		}
	}
	if (task.description) {
		lines.push("", "Description:", task.description);
	}
	if (task.acceptance.length > 0) {
		const ticked = task.acceptance.filter((item) => checks.includes(item)).length;
		lines.push("", `Acceptance criteria (reviewer ticked ${ticked} of ${task.acceptance.length}):`, ...task.acceptance.map((item) => `  - [${checks.includes(item) ? "x" : " "}] ${item}`));
	}
	lines.push("", task.files && task.files.length > 0 ? "Files:" : "Files: none yet — attach screenshots or videos with `attach`.");
	if (task.files) lines.push(...task.files.map(fileLine));
	if (task.history.length > 0) {
		lines.push("", "History:");
		for (const entry of task.history.slice(-12)) lines.push(`  - ${entry.at ?? ""} ${entry.by ?? ""}: ${entry.action ?? ""}${entry.comment ? ` — ${entry.comment}` : ""}`);
	}
	if (task.status === "changes_requested") lines.push("", "Next: fix what the reviewer asked for (comment and unticked criteria), update the evidence, then `submit` with a note on what changed.");
	if (task.status === "approved") lines.push("", "Next: the reviewer accepted this task — close it with `complete`.");
	return lines.join("\n");
}

/** A list of task summaries, for the model. */
export function renderList(tasks, filter) {
	if (tasks.length === 0) return `No tasks (${filter}).`;
	const lines = [`${tasks.length} task(s) (${filter}):`];
	for (const task of tasks) {
		const media = task.files ? `${task.files.images} img, ${task.files.videos} video` : "";
		const comment = task.status === "changes_requested" && task.review?.comment ? ` — reviewer: ${task.review.comment.slice(0, 160)}` : "";
		const error = task.error ? ` — ${task.error}` : "";
		const code = [task.branch ? `branch ${task.branch}` : "", task.pr ? `PR ${task.pr}` : ""].filter(Boolean).join(", ");
		const checks = task.checks && task.checks.total > 0 ? `; ticked ${task.checks.done}/${task.checks.total}` : "";
		lines.push(`- \`${task.id}\` [${task.status}${task.archived ? ", archived" : ""}] ${task.title} (${media}${code ? "; " + code : ""}${checks})${comment}${error}`);
	}
	return lines.join("\n");
}

/** A failure, for the model. */
export function renderError(error) {
	return `task_board: ${error?.code ?? "failed"} — ${error?.message ?? "unknown error"}`;
}
