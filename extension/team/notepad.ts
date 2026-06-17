/**
 * tokyo_notepad — durable cross-session notebook for the harness.
 *
 * The model writes notes, decisions, evidence snapshots, and findings here so
 * they survive compaction, resume, and new pi sessions. Each category gets its
 * own append-only JSONL file under .tokyo/state/notebook/.
 *
 * Ops (all via tool call):
 *   add       Append to the category's file (content + optional goal_id, tags)
 *   read      Read entries (latest N from a category or all categories)
 *   clear     Write tombstone to every category file (old entries stay for audit)
 */

import type { ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StateWriter } from "../state/index.ts";

const NOTEBOOK_DIR = "state/notebook";

const CATEGORIES = ["note", "decision", "evidence", "finding", "risk", "question"] as const;
type Category = (typeof CATEGORIES)[number];

function categoryPath(cat: Category): string {
	return `${NOTEBOOK_DIR}/${cat}.jsonl`;
}

export interface NotebookEntry {
	ts: string;
	content: string;
	goal_id?: string;
	tags?: string[];
}

const NotebookParams = Type.Object({
	op: Type.Union([Type.Literal("add"), Type.Literal("read"), Type.Literal("clear")], {
		description: "add (append entry), read (list entries), clear (archive all)",
	}),
	category: Type.Optional(
		Type.Union(CATEGORIES.map((c) => Type.Literal(c)), {
			description: "Entry category: note, decision, evidence, finding, risk, question.",
		}),
	),
	content: Type.Optional(Type.String({ description: "For add: the entry text." })),
	goal_id: Type.Optional(Type.String({ description: "For add/read: tie to a specific goal." })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "For add: freeform tags." })),
	limit: Type.Optional(Type.Number({ description: "For read: max entries (default 20)." })),
});

export interface NotebookHooks {
	state: StateWriter;
}

export function makeNotepadTool(hooks: NotebookHooks): ToolDefinition<typeof NotebookParams> {
	return {
		name: "tokyo_notepad",
		label: "Tokyo Notepad",
		description: [
			"Durable cross-session notebook. Each category (note/decision/evidence/finding/risk/question)",
			"gets its own file under .tokyo/state/notebook/ (append-only JSONL, never overwritten).",
			"Use it to record decisions, evidence snapshots, risks, findings — anything",
			"that must survive context compaction or session restart.",
			"Ops: add (append to category file), read (latest entries from one or all categories),",
			"clear (archive tombstone in each category). All ops are tool calls — no shell needed.",
		].join(" "),
		parameters: NotebookParams,
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<any>> {
			const state = hooks.state;

			switch (params.op) {
				case "add": {
					if (!params.content?.trim()) {
						return {
							content: [{ type: "text", text: "add requires 'content'." }],
							details: { op: "add", count: 0 },
							isError: true,
						} as AgentToolResult<any>;
					}
					const cat = (params.category ?? "note") as Category;
					const entry: NotebookEntry = {
						ts: new Date().toISOString(),
						content: params.content.trim(),
						goal_id: params.goal_id || undefined,
						tags: params.tags?.length ? params.tags : undefined,
					};
					await state.appendJsonl(categoryPath(cat), entry);
					const tagStr = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
					const goalStr = entry.goal_id ? ` (goal: ${entry.goal_id})` : "";
					return {
						content: [{ type: "text", text: `Noted [${cat}]${goalStr}${tagStr}: ${entry.content.slice(0, 100)}${entry.content.length > 100 ? "…" : ""}` }],
						details: { op: "add", category: cat, goal_id: entry.goal_id },
					} as AgentToolResult<any>;
				}

				case "read": {
					const cats: Category[] = params.category
						? [params.category as Category]
						: [...CATEGORIES];
					const limit = params.limit ?? 20;
					const allEntries: Array<{ category: Category; entry: NotebookEntry }> = [];
					for (const cat of cats) {
						const raw = await state.readJsonl<NotebookEntry>(categoryPath(cat));
						for (const e of raw) {
							if (params.goal_id && e.goal_id !== params.goal_id) continue;
							allEntries.push({ category: cat, entry: e });
						}
					}
					allEntries.sort((a, b) => a.entry.ts.localeCompare(b.entry.ts));
					const sliced = allEntries.slice(-limit);
					if (sliced.length === 0) {
						return {
							content: [{ type: "text", text: "(notebook empty — no entries match)" }],
							details: { op: "read", count: 0 },
						} as AgentToolResult<any>;
					}
					const lines = sliced.map(({ category, entry }) => {
						const goalStr = entry.goal_id ? ` [goal:${entry.goal_id}]` : "";
						const tagStr = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
						return `[${entry.ts.slice(0, 19).replace("T", " ")}] [${category}]${goalStr}${tagStr}\n${entry.content}`;
					});
					return {
						content: [{ type: "text", text: `--- Notebook (${sliced.length} entries) ---\n\n${lines.join("\n\n")}\n\n--- end ---` }],
						details: { op: "read", count: sliced.length },
					} as AgentToolResult<any>;
				}

				case "clear": {
					const tombstone = { ts: new Date().toISOString(), content: "[ARCHIVE TOMBSTONE]" };
					for (const cat of CATEGORIES) {
						await state.appendJsonl(categoryPath(cat), tombstone);
					}
					return { content: [{ type: "text", text: "Notebook archived (tombstones written to all categories). Prior entries preserved for audit." }], details: { op: "clear", archived: true } } as AgentToolResult<any>;
				}

				default:
					return { content: [{ type: "text", text: `Unknown op: ${(params as any).op}` }], details: { op: (params as any).op }, isError: true } as AgentToolResult<any>;
			}
		},
	};
}
