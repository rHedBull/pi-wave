/**
 * Plan Markdown parser — supports both new feature-based format and legacy flat format.
 *
 * New format:
 *   ## Wave N: <name>
 *   ### Foundation
 *   ### Feature: <name>
 *   ### Integration
 *   #### Task <id>: <title>
 *
 * Legacy format (backward compat):
 *   ## Wave N: <name>
 *   ### Task <id>: <title>
 *   → wraps all tasks in a single "default" feature
 */

import type { Feature, Plan, Task, Wave } from "./types.js";

// ── New format parser ──────────────────────────────────────────────

export function parsePlanV2(markdown: string): Plan {
	const lines = markdown.split("\n");
	const plan: Plan = { goal: "", dataSchemas: "", waves: [] };

	// Extract ## Data Schemas section (everything between ## Data Schemas and the next ## heading)
	plan.dataSchemas = extractDataSchemas(markdown);

	// Detect format: if any line starts with "### Feature:" or "### Foundation" or "### Integration", it's the new format
	const hasFeatureHeaders = lines.some(
		(l) =>
			/^### Feature:/i.test(l.trim()) ||
			/^### Foundation/i.test(l.trim()) ||
			/^### Integration/i.test(l.trim()),
	);

	if (!hasFeatureHeaders) {
		return parsePlanLegacy(markdown);
	}

	let currentWave: Wave | null = null;
	// Which section we're in: "foundation" | "feature" | "integration" | null
	let currentSection: "foundation" | "feature" | "integration" | null = null;
	let currentFeature: Feature | null = null;
	let currentTask: Task | null = null;
	let inDescription = false;
	let descriptionLines: string[] = [];
	let goalNextLine = false;

	const flushTask = () => {
		if (currentTask) {
			currentTask.description = descriptionLines.join("\n").trim();
			if (currentSection === "foundation" && currentWave) {
				currentWave.foundation.push(currentTask);
			} else if (currentSection === "feature" && currentFeature) {
				currentFeature.tasks.push(currentTask);
			} else if (currentSection === "integration" && currentWave) {
				currentWave.integration.push(currentTask);
			}
		}
		currentTask = null;
		inDescription = false;
		descriptionLines = [];
	};

	const flushFeature = () => {
		flushTask();
		if (currentFeature && currentWave) {
			currentWave.features.push(currentFeature);
		}
		currentFeature = null;
	};

	const flushWave = () => {
		flushFeature();
		flushTask(); // flush any remaining task in foundation/integration
		if (currentWave) {
			plan.waves.push(currentWave);
		}
		currentWave = null;
		currentSection = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Goal header
		if (/^## Goal/i.test(line.trim())) {
			goalNextLine = true;
			continue;
		}
		if (goalNextLine && line.trim()) {
			plan.goal = line.trim();
			goalNextLine = false;
			continue;
		}
		if (goalNextLine && !line.trim()) {
			continue; // skip blank lines between ## Goal and the actual goal
		}

		// Wave header: ## Wave N: Name
		const waveMatch = line.match(/^## Wave \d+:\s*(.+)/);
		if (waveMatch) {
			flushWave();
			currentWave = {
				name: waveMatch[1].trim(),
				description: "",
				foundation: [],
				features: [],
				integration: [],
			};
			currentSection = null;
			continue;
		}

		// Wave description: first non-empty line after wave header, before any ### section
		if (
			currentWave &&
			currentSection === null &&
			!currentTask &&
			line.trim() &&
			!line.startsWith("#") &&
			!line.startsWith("---")
		) {
			if (!currentWave.description) {
				currentWave.description = line.trim();
			}
			continue;
		}

		// Foundation section
		if (/^### Foundation/i.test(line.trim())) {
			flushFeature();
			flushTask();
			currentSection = "foundation";
			continue;
		}

		// Feature section: ### Feature: <name>
		const featureMatch = line.match(/^### Feature:\s*(.+)/i);
		if (featureMatch) {
			flushFeature();
			flushTask();
			currentSection = "feature";
			currentFeature = {
				name: featureMatch[1].trim(),
				files: [],
				tasks: [],
			};
			continue;
		}

		// Integration section
		if (/^### Integration/i.test(line.trim())) {
			flushFeature();
			flushTask();
			currentSection = "integration";
			continue;
		}

		// Feature-level Files line (right after ### Feature: header)
		if (currentSection === "feature" && currentFeature && !currentTask) {
			const featureFilesMatch = line.match(/^Files?:\s*(.+)/i);
			if (featureFilesMatch) {
				currentFeature.files = featureFilesMatch[1]
					.split(",")
					.map((f) => f.trim().replace(/`/g, ""))
					.filter(Boolean);
				continue;
			}
		}

		// Task header: #### Task <id>: <title>
		const taskMatch = line.match(/^#{3,4} Task ([\w-]+):\s*(.+)/);
		if (taskMatch) {
			flushTask();
			currentTask = {
				id: taskMatch[1],
				title: taskMatch[2].trim(),
				agent: "worker",
				files: [],
				depends: [],
				specRefs: [],
				testFiles: [],
				description: "",
			};
			inDescription = false;
			descriptionLines = [];
			continue;
		}

		// Task metadata lines
		if (currentTask) {
			// Agent
			const agentMatch = line.match(/^\s*-\s*\*\*Agent\*\*:\s*(.+)/);
			if (agentMatch) {
				currentTask.agent = agentMatch[1].trim().replace(/`/g, "");
				inDescription = false;
				continue;
			}

			// Files
			const filesMatch = line.match(/^\s*-\s*\*\*Files?\*\*:\s*(.+)/);
			if (filesMatch) {
				currentTask.files = filesMatch[1]
					.split(",")
					.map((f) => f.trim().replace(/`/g, ""))
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			// Depends
			const dependsMatch = line.match(/^\s*-\s*\*\*Depends?\*\*:\s*(.+)/);
			if (dependsMatch) {
				const raw = dependsMatch[1].trim();
				if (raw === "(none)" || raw.toLowerCase() === "none" || raw === "-") {
					currentTask.depends = [];
				} else {
					currentTask.depends = raw
						.split(",")
						.map((d) => d.trim())
						.filter(Boolean);
				}
				inDescription = false;
				continue;
			}

			// Tests
			const testsMatch = line.match(/^\s*-\s*\*\*Tests?\*\*:\s*(.+)/);
			if (testsMatch) {
				currentTask.testFiles = testsMatch[1]
					.split(",")
					.map((f) => f.trim().replace(/`/g, ""))
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			// Spec refs
			const refsMatch = line.match(/^\s*-\s*\*\*Spec refs?\*\*:\s*(.+)/);
			if (refsMatch) {
				currentTask.specRefs = refsMatch[1]
					.split(",")
					.map((r) => r.trim())
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			// Description start
			const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)/);
			if (descMatch) {
				inDescription = true;
				if (descMatch[1].trim()) {
					descriptionLines.push(descMatch[1].trim());
				}
				continue;
			}

			// Description continuation: indented or non-metadata lines after description starts
			if (inDescription) {
				// Stop description at next task header or section header
				if (line.match(/^#{2,4}\s/) || line.match(/^\s*-\s*\*\*(Agent|Files?|Depends?|Tests?|Spec refs?)\*\*/)) {
					// Don't consume this line — re-process it
					// We need to flush the task and re-parse this line
					// Simplest approach: just stop accumulating
					inDescription = false;
					// Re-parse this line in the next iteration by decrementing i
					i--;
					continue;
				}
				descriptionLines.push(line);
			}
		}
	}

	flushWave();

	// Extract goal from first line if not found via ## Goal
	if (!plan.goal) {
		const goalMatch = markdown.match(/^# Implementation Plan\s*\n+(.+)/m);
		if (goalMatch) plan.goal = goalMatch[1].trim();
	}

	return plan;
}

// ── Legacy format parser (backward compatibility) ──────────────────

export function parsePlanLegacy(markdown: string): Plan {
	const lines = markdown.split("\n");
	const plan: Plan = { goal: "", dataSchemas: "", waves: [] };

	// Extract ## Data Schemas section if present
	plan.dataSchemas = extractDataSchemas(markdown);

	let currentWave: Wave | null = null;
	let currentTask: Task | null = null;
	let inDescription = false;
	let descriptionLines: string[] = [];
	let goalNextLine = false;

	const flushTask = () => {
		if (currentTask && currentWave) {
			currentTask.description = descriptionLines.join("\n").trim();
			// In legacy format, all tasks go into a single "default" feature
			if (currentWave.features.length === 0) {
				currentWave.features.push({ name: "default", files: [], tasks: [] });
			}
			currentWave.features[0].tasks.push(currentTask);
		}
		currentTask = null;
		inDescription = false;
		descriptionLines = [];
	};

	const flushWave = () => {
		flushTask();
		if (currentWave && currentWave.features.some((f) => f.tasks.length > 0)) {
			plan.waves.push(currentWave);
		}
		currentWave = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Goal header
		if (/^## Goal/i.test(line.trim())) {
			goalNextLine = true;
			continue;
		}
		if (goalNextLine && line.trim()) {
			plan.goal = line.trim();
			goalNextLine = false;
			continue;
		}
		if (goalNextLine && !line.trim()) {
			continue;
		}

		// Wave header
		const waveMatch = line.match(/^## Wave \d+:\s*(.+)/);
		if (waveMatch) {
			flushWave();
			currentWave = {
				name: waveMatch[1].trim(),
				description: "",
				foundation: [],
				features: [],
				integration: [],
			};
			continue;
		}

		// Wave description
		if (
			currentWave &&
			currentWave.features.length === 0 &&
			!currentTask &&
			line.trim() &&
			!line.startsWith("#") &&
			!line.startsWith("---")
		) {
			if (!currentWave.description) {
				currentWave.description = line.trim();
			}
			continue;
		}

		// Task header: ### Task <id>: <title>
		const taskMatch = line.match(/^### Task ([\w-]+):\s*(.+)/);
		if (taskMatch) {
			flushTask();
			currentTask = {
				id: taskMatch[1],
				title: taskMatch[2].trim(),
				agent: "worker",
				files: [],
				depends: [],
				specRefs: [],
				testFiles: [],
				description: "",
			};
			inDescription = false;
			descriptionLines = [];
			continue;
		}

		if (currentTask) {
			const agentMatch = line.match(/^\s*-\s*\*\*Agent\*\*:\s*(.+)/);
			if (agentMatch) {
				currentTask.agent = agentMatch[1].trim().replace(/`/g, "");
				inDescription = false;
				continue;
			}

			const filesMatch = line.match(/^\s*-\s*\*\*Files?\*\*:\s*(.+)/);
			if (filesMatch) {
				currentTask.files = filesMatch[1]
					.split(",")
					.map((f) => f.trim().replace(/`/g, ""))
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			const dependsMatch = line.match(/^\s*-\s*\*\*Depends?\*\*:\s*(.+)/);
			if (dependsMatch) {
				const raw = dependsMatch[1].trim();
				if (raw === "(none)" || raw.toLowerCase() === "none" || raw === "-") {
					currentTask.depends = [];
				} else {
					currentTask.depends = raw
						.split(",")
						.map((d) => d.trim())
						.filter(Boolean);
				}
				inDescription = false;
				continue;
			}

			const testsMatch = line.match(/^\s*-\s*\*\*Tests?\*\*:\s*(.+)/);
			if (testsMatch) {
				currentTask.testFiles = testsMatch[1]
					.split(",")
					.map((f) => f.trim().replace(/`/g, ""))
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			const refsMatch = line.match(/^\s*-\s*\*\*Spec refs?\*\*:\s*(.+)/);
			if (refsMatch) {
				currentTask.specRefs = refsMatch[1]
					.split(",")
					.map((r) => r.trim())
					.filter(Boolean);
				inDescription = false;
				continue;
			}

			const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.*)/);
			if (descMatch) {
				inDescription = true;
				if (descMatch[1].trim()) {
					descriptionLines.push(descMatch[1].trim());
				}
				continue;
			}

			if (inDescription) {
				if (line.match(/^#{2,3}\s/) || line.match(/^\s*-\s*\*\*(Agent|Files?|Depends?|Tests?|Spec refs?)\*\*/)) {
					inDescription = false;
					i--;
					continue;
				}
				descriptionLines.push(line);
			}
		}
	}

	flushWave();

	if (!plan.goal) {
		const goalMatch = markdown.match(/^# Implementation Plan\s*\n+(.+)/m);
		if (goalMatch) plan.goal = goalMatch[1].trim();
	}

	return plan;
}

// ── Data Schemas Extraction ────────────────────────────────────────

/**
 * Extract the ## Data Schemas section from a plan's Markdown.
 *
 * Returns the full content between `## Data Schemas` and the next `## ` heading
 * (or `---` separator followed by a wave heading). Returns empty string if not found.
 */
export function extractDataSchemas(markdown: string): string {
	const lines = markdown.split("\n");
	let capturing = false;
	const captured: string[] = [];

	for (const line of lines) {
		// Start capturing at ## Data Schemas
		if (/^## Data Schemas/i.test(line.trim())) {
			capturing = true;
			captured.push(line);
			continue;
		}

		if (capturing) {
			// Stop at the next ## heading (but not ### subsections within Data Schemas)
			if (/^## (?!#)/.test(line) && !/^## Data Schemas/i.test(line)) {
				break;
			}
			// Also stop at --- separator (typically before Wave sections)
			if (line.trim() === "---") {
				break;
			}
			captured.push(line);
		}
	}

	return captured.join("\n").trim();
}
