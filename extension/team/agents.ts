/**
 * Tokyo agent loader (node fs + pi's parseFrontmatter only).
 *
 * Loads role-agent definitions (planner/architect/critic) from the package's
 * own `agents/` directory, resolved relative to this module. Each is a markdown
 * file with frontmatter (name/description/tools/model) + body = system prompt.
 *
 * Unlike pi's subagent example (which discovers ~/.pi/agent/agents), tokyo ships
 * its role agents in-package so they travel with the harness.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface RoleAgent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

/** Absolute path to the package's agents/ directory (../../agents from here). */
function agentsDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// extension/team/agents.ts → repo root → agents/
	return path.resolve(here, "..", "..", "agents");
}

let cache: Map<string, RoleAgent> | null = null;

export function loadRoleAgents(): Map<string, RoleAgent> {
	if (cache) return cache;
	const dir = agentsDir();
	const map = new Map<string, RoleAgent>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		cache = map;
		return map;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		let content: string;
		try {
			content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		map.set(frontmatter.name, {
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
		});
	}
	cache = map;
	return map;
}

export function getRoleAgent(name: string): RoleAgent | undefined {
	return loadRoleAgents().get(name);
}

export function roleAgentNames(): string[] {
	return Array.from(loadRoleAgents().keys());
}
