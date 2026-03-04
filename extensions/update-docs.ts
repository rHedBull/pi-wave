/**
 * Update Docs Extension
 *
 * Manual: `/update-docs [scope]` command
 *   - Triggers the update-docs skill to analyze and update documentation
 *   - Optional scope: a module/service name, or "all"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("update-docs", {
		description: "Update project documentation to match current code",
		handler: async (args, ctx) => {
			const scope = args?.trim() || "";
			const scopeMsg = scope ? `\n\nFocus on: ${scope}` : "";

			ctx.ui.notify("Triggering docs update...", "info");

			pi.sendUserMessage(
				`Follow the update-docs skill workflow now. Read the skill file first, then execute every step.${scopeMsg}\n\n/skill:update-docs`
			);
		},
	});
}
