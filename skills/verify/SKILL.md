---
name: verify
description: "Independently verify implemented work against the plan's acceptance criteria before the user review. Runs build/tests, delegates code review to the reviewer agent, and records evidence via tokyo_verify. Runs in the tokyo VERIFY phase (full bash, no source edits). Gates VERIFY->REVIEW."
---

# TOKYO — Verify

You are in the VERIFY phase: full bash (run anything), but edit/write are barred — no source changes here. Your job is to independently confirm the work meets the plan's acceptance criteria, then record the evidence so the workflow can advance to the user's REVIEW.

## The loop

1. **Run the checks.** Build and run the relevant tests/linters/type-checks. Capture the actual commands + results.

2. **Delegate a code review.** Use `spawn_subagents` with `agent: "reviewer"` against the implemented diff. The reviewer traces cross-boundary integration (new types reaching their consuming dispatch point) and returns a CORRECT/INCORRECT verdict with P0–P3 findings.

3. **Decide:**
   - If a check failed or the reviewer returns INCORRECT with a P0/P1, advance with `tokyo_phase` back to EXECUTE to fix. Do NOT patch source here.
   - If everything passes, record the evidence with `tokyo_verify`: the build/test commands (status passed), inspections (verified), and the reviewer's verdict (kind: review). Then advance with `tokyo_phase` to REVIEW.

## The gate

`tokyo_verify` requires ≥1 passed/verified check and no failed check. VERIFY→REVIEW is blocked until you've recorded verification evidence — the final step is not a rubber-stamp. Map the checks to the plan's acceptance criteria: each criterion should have a corresponding passed/verified check.

## Rules

- No source edits in VERIFY (the gate enforces it). Fixes happen in EXECUTE.
- Evidence must be real — run the command before you cite it; cite the reviewer's actual verdict.
- A failing verification routes back to EXECUTE, not silently patched.
