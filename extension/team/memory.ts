/**
 * tokyo_memory — cross-session memory persistence.
 *
 * Stores key decisions, learnings, and project context to .tokyo/memory/
 * so they survive across sessions. Injected into the work context at start.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StateWriter } from "../state/index.ts";

const MemoryParams = Type.Object({
	op: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("clear")], {
		description: "save a memory, list all memories, or clear all.",
	}),
	key: Type.Optional(Type.String({ description: "Memory key/title (for save)." })),
	value: Type.Optional(Type.String({ description: "Memory content (for save)." })),
	category: Type.Optional(
		Type.Union([Type.Literal("decision"), Type.Literal("learning"), Type.Literal("constraint"), Type.Literal("preference")], {
			description: "Category of memory. Default: learning.",
		}),
	),
});

interface MemoryDetails {
	op: string;
	count: number;
}

export interface MemoryEntry {
	key: string;
	value: string;
	category: string;
	saved_at: string;
}

export interface MemoryHooks {
	state: StateWriter;
}

const MEMORY_PATH = "memory/entries.jsonl";

export function makeMemoryTool(hooks: MemoryHooks): ToolDefinition<typeof MemoryParams, MemoryDetails> {
	return {
		name: "tokyo_memory",
		label: "Tokyo Memory",
		description: [
			"Persist key decisions, learnings, constraints, and preferences to cross-session memory.",
			"Saved memories are automatically injected at the start of future sessions.",
			"Use this when you discover something important that future work should know.",
		].join(" "),
		parameters: MemoryParams,
		promptGuidelines: [
			"When you make an important architectural decision, discover a project constraint, or learn something that would help future sessions, save it with tokyo_memory.",
		],
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<MemoryDetails>> {
			if (params.op === "save") {
				if (!params.key?.trim() || !params.value?.trim()) {
					return {
						content: [{ type: "text", text: "save requires key and value." }],
						details: { op: "save", count: 0 },
						isError: true,
					} as AgentToolResult<MemoryDetails>;
				}
				const entry: MemoryEntry = {
					key: params.key.trim(),
					value: params.value.trim(),
					category: params.category ?? "learning",
					saved_at: new Date().toISOString(),
				};
				await hooks.state.appendJsonl(MEMORY_PATH, entry, {
					audit: { category: "state", verb: "memory_save", skill: "memory" },
				});
				const all = await hooks.state.readJsonl<MemoryEntry>(MEMORY_PATH).catch(() => []);
				return {
					content: [{ type: "text", text: `Memory saved: "${entry.key}" (${entry.category}). Total: ${all.length} memories.` }],
					details: { op: "save", count: all.length },
				};
			}
			if (params.op === "list") {
				const all = await hooks.state.readJsonl<MemoryEntry>(MEMORY_PATH).catch(() => []);
				if (all.length === 0) {
					return { content: [{ type: "text", text: "(no memories saved yet)" }], details: { op: "list", count: 0 } };
				}
				const lines = all.map((m) => `- [${m.category}] ${m.key}: ${m.value}`);
				return {
					content: [{ type: "text", text: `Memories (${all.length}):\n${lines.join("\n")}` }],
					details: { op: "list", count: all.length },
				};
			}
			if (params.op === "clear") {
				try {
					const fs = await import("node:fs");
					const p = hooks.state.resolveTarget(MEMORY_PATH);
					if (fs.existsSync(p)) fs.unlinkSync(p);
				} catch { /* ok */ }
				return { content: [{ type: "text", text: "All memories cleared." }], details: { op: "clear", count: 0 } };
			}
			return { content: [{ type: "text", text: "Unknown op." }], details: { op: params.op, count: 0 }, isError: true } as AgentToolResult<MemoryDetails>;
		},
	};
}

/** Read all memories for injection into work context. */
export async function readMemories(state: StateWriter): Promise<MemoryEntry[]> {
	return state.readJsonl<MemoryEntry>(MEMORY_PATH).catch(() => []);
}
