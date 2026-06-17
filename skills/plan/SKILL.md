---
name: plan
description: "Reference for the tokyo PLAN phase. The harness asks planning depth on PLAN entry (quick / consensus / adversarial-hyperplan) and injects the matching contract automatically — you normally do not need to load this skill. Read it only for the consensus loop details."
---

# TOKYO — Plan phase reference

The harness drives planning. When you enter PLAN, tokyo asks the user for a planning depth
and injects the matching contract into your system prompt. You follow that contract; this
file is just background detail.

## Planning depths (chosen by the harness, not you)

- **Quick** — draft the plan directly. Small/clear tasks. Optional critic sanity-check.
- **Consensus** — planner drafts (via `spawn_subagents`), architect + critic review, iterate
  to approval. The default.
- **Adversarial (hyperplan)** — 5 hostile members cross-critique over 3 rounds via
  `tokyo_team`, then the planner formalizes the surviving insights. Built into the PLAN
  contract; runs automatically when chosen.

## Consensus loop detail

1. **Draft (Planner).** Delegate to the `planner` agent with `spawn_subagents`:
   - Give it the full clarified spec from the interview (it has no prior context — be self-contained).
   - It returns a plan: summary, in/out of scope, file-level changes, sequencing, acceptance criteria, verification, risks.

2. **Review (Architect).** Delegate the planner's plan to the `architect` agent. It returns severity-rated findings + an Architectural Status (`CLEAR`/`WATCH`/`BLOCK`) and a Code Review Recommendation (`APPROVE`/`COMMENT`/`REQUEST CHANGES`).

3. **Vet (Critic).** Delegate the plan to the `critic` agent. It returns `OKAY` / `ITERATE` / `REJECT` with concrete required fixes.
   - You may run Architect and Critic in one `spawn_subagents` call using the `parallel` argument to save a round.

4. **Iterate (max 5 passes).** If Architect says `BLOCK`/`REQUEST CHANGES` or Critic says `ITERATE`/`REJECT`:
   - Consolidate their feedback into one revision brief.
   - Re-delegate to `planner` with the original plan + the consolidated feedback.
   - Re-review. Repeat until Critic returns `OKAY` and Architect is not `BLOCK`, or you hit 5 passes (then present the best version and say so).

5. **Save the plan.** Once consensus holds, call `tokyo_plan_save` with the final plan markdown. This writes it to `.tokyo/plans/` (atomic, checksummed, audited) and marks it pending-approval. Do NOT write the plan file yourself — the tool is the only sanctioned writer.

6. **Request consent.** Present the final plan to the user (summary + key decisions + acceptance criteria + an ADR: Decision, Drivers, Alternatives, Why chosen, Consequences). Then advance with `tokyo_phase` to EXECUTE — this triggers the consent prompt. If the user declines, stay in PLAN and revise.

## Rules

- Read-only here: no edit/write/write-bash. The phase gate enforces it; the plan is `pending approval` until consent.
- Do not write product code or the plan file directly. Delegate drafting; use `tokyo_plan_save` for the artifact.
- Right-size the plan to the task. A one-file change does not need a 12-step plan.
- Architect and Critic must ground findings in the actual repo (they can read it). Reject vibes-based plans.
- Do not advance to EXECUTE until the user consents. The `tokyo_phase` tool prompts for it; you cannot bypass it.
