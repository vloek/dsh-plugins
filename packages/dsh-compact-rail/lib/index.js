// dsh-compact-rail, host half: nothing runs here. The row only exists so the
// browser half (lib/client.js) is loaded and receives its config.
import z from "@deepseek-ai/schemastery";

export const name = "compact-rail";

export const Config = z.object({
	/** Collapse the left sidebar to the rail once when the app starts. */
	startCollapsed: z.boolean().default(true),
	/** Hide the brand row (logo + build label) of the expanded sidebar. */
	hideBrand: z.boolean().default(false),
});

export function apply() {}
