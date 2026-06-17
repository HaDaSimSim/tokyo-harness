---
name: execute
description: "Goal-tracked execution of an approved plan with evidence-gated completion. Runs in the tokyo EXECUTE phase (full tool access, post-consent). Register each plan step as a tokyo_goal, implement it, then complete it with tokyo_complete + real evidence. Triggers automatically after plan approval."
---

# TOKYO — Execute

You are in the EXECUTE phase: full tool access, granted only after the user approved the plan. Implement the approved plan yourself (you, the main thread, do the edits — subagents are read-only thinkers). Track progress in the durable goal ledger so the work survives restarts and drives the continuation loop.

## The loop

1. **Seed goals from the plan.** For each step in the approved plan, call `tokyo_goal` with `op: "create"` and a concrete objective. Keep them small and independently verifiable.

2. **Work the current goal.** Implement it with edit/write/bash. Stay within the approved scope — if you discover the plan was wrong, surface it rather than silently expanding scope.

3. **Complete with evidence.** When a goal is actually done, call `tokyo_complete` with concrete evidence:
   - `command`: a check you ran (e.g. `bun test`, `tsc --noEmit`) with status `passed`.
   - `inspection`: something you read and verified, status `verified`.
   - `artifact`: a file you produced, status `verified`.
   - You need ≥1 `passed`/`verified` item. No `todo` or `failed` items are accepted — the gate rejects forged completion. Only claim done when it is genuinely done and checked.

4. **Repeat** until `tokyo_complete` reports all goals settled, then advance with `tokyo_phase` to VERIFY.

## Rules

- Do the work yourself here. Use `spawn_subagents` only for read-only consultation (e.g. ask `architect` to review a tricky change), never to perform the edit.
- Evidence must be real. Run the check before you cite it. Fabricated evidence defeats the entire harness.
- Keep goals current: create them up front or as you go, but every plan step should map to a goal that gets completed with evidence.
- **Goal steering mid-flight:** If a goal turns out too big, use `tokyo_goal op:"split" goal_id:"..." sub_goals:["sub-objective 1", "sub-objective 2"]`. If priorities change, use `tokyo_goal op:"reorder" order:["id1","id2","id3"]` to re-sequence execution. To refine a goal's wording: `tokyo_goal op:"revise" goal_id:"..." objective:"new clearer objective"`. If a goal is blocked by an external dependency: `tokyo_goal op:"block" goal_id:"..." reason:"waiting for API access"`. When the blocker is resolved: `tokyo_goal op:"unblock" goal_id:"..."`.
- When everything is complete, move to VERIFY — do not declare success from EXECUTE.

## Test-First Discipline

- **Write the test BEFORE the implementation.** For each goal, the workflow is:
  1. Write a failing test that captures the requirement (RED)
  2. Implement the minimum code to make it pass (GREEN)
  3. Clean up / refactor with tests still passing (REFACTOR)
- If you find yourself writing production code without a prior failing test, STOP and write the test first.
- The test IS your evidence. A `tokyo_complete` with evidence kind `command` citing the test run is the gold standard.
- If a goal is purely non-code (documentation, config), a manual verification counts — but code changes without tests are incomplete.
- If the project has no test framework, set one up as your first goal before implementing features.
