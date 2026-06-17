---
name: hyperplan
description: "Adversarial multi-agent planning via the tokyo orchestrator. Runs 5 hostile members (skeptic, validator, researcher, architect, creative) through 3 rounds of cross-critique, then hands surviving insights to the planner. Use when planning needs maximum rigor. Triggers: 'hyperplan', 'hpp', 'adversarial plan', 'hostile planning', '하이퍼플랜', '적대적 계획'."
---

# HYPERPLAN — Adversarial Multi-Agent Planning

> **REQUIRES the tokyo orchestrator.** Hyperplan runs via `tokyo_team op:"hyperplan_run"`,
> which needs the Rust orchestrator's IPC socket at `.tokyo/orchestrator.sock`.
> Start with `tokyo start --team` to pre-spawn the 5 adversarial workers.
>
> If `tokyo_team` is not available or `hyperplan_run` returns an orchestrator error,
> **fall back to consensus planning** (planner→architect→critic loop).

## WHAT THIS IS

The orchestrator runs 5 maximally-hostile members through 3 rounds of cross-critique
**in parallel**, then returns the full debate transcript. You (the Lead) distill the
surviving insights and hand them to the planner agent for formalization.

## THE 5 ADVERSARIAL MEMBERS

| Member | Role |
|--------|------|
| `skeptic` | Pragmatist Skeptic — enemy of over-engineering |
| `validator` | Integration Tester — enemy of incompleteness |
| `researcher` | Autonomous Researcher — enemy of unfounded claims |
| `architect` | Architect Strategist — enemy of bad architecture |
| `creative` | Creative Challenger — enemy of orthodox thinking |

## EXECUTION (4 steps)

### Step 1: Run hyperplan
```
tokyo_team op:"hyperplan_run" team:"hyperplan" objective:"<the full clarified request>"
```
This single call:
- Broadcasts to all 5 members (Round 1: independent analysis)
- Feeds each others' findings back (Round 2: cross-attack)
- Each defends/refines/concedes (Round 3: final critique)
- Returns the full 3-round transcript

### Step 2: Distill (you, the Lead)
From the transcript, extract only what **survived**:
- **Hard Constraints** — uncontested or successfully defended
- **Decisions** — converged through debate
- **Risks & Mitigations** — identified and addressed
- **Open Questions** — unresolved, needs user input

Drop everything that was conceded. Do NOT write the plan yourself.

### Step 3: MANDATORY planner handoff
```
spawn_subagents agent:'tokyo-planner'" task:"Produce an executable plan from these battle-tested insights: [paste distilled bundle]. Every constraint respected, every risk mitigated, every open question a user-input gate, every step with success criteria."
```
Present the planner's output verbatim with provenance:
```
*Plan from hyperplan adversarial review (5 members, 3 rounds), formalized by planner.*
```

### Step 4: Save and advance
```
tokyo_plan_save title:"..." body:"[planner output]"
tokyo_phase EXECUTE
```

## ANTI-PATTERNS
- Skipping the planner handoff (Lead writing the plan directly)
- Softening member hostility
- Including conceded findings in the bundle
- Running hyperplan for trivial tasks (use quick/consensus instead)
