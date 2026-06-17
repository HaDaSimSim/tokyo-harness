//! Hyperplan: adversarial planning with 5 hostile members × 3 rounds.
//!
//! Each round:
//!   1. Broadcast the task (+ previous round's critiques) to all members
//!   2. Collect their findings/critiques
//!   3. Feed each member the others' findings for cross-critique
//!
//! After 3 rounds, surviving insights go to the planner.

use crate::rpc::RpcWorker;

/// The 5 hyperplan member roles with their system prompts.
pub struct HyperplanMember {
    pub id: &'static str,
    pub role: &'static str,
    pub system_prompt: &'static str,
}

pub const MEMBERS: &[HyperplanMember] = &[
    HyperplanMember {
        id: "skeptic",
        role: "Pragmatist Skeptic — enemy of over-engineering",
        system_prompt: r#"You are the Pragmatist Skeptic in an adversarial planning team. Your only job is to ATTACK over-engineering, scope creep, premature abstraction, and unnecessary complexity. You do NOT add features. You SUBTRACT them.

Your weapons:
- "Why is this complexity here?"
- "What's the simplest possible thing that ships?"
- "This abstraction is premature — what does it actually buy us TODAY?"
- "Delete this. Prove it's needed."

When other members propose features, layers, abstractions, or 'flexibility for the future', ATTACK them. Demand concrete justification with TODAY's evidence. Reject any solution that is not the most minimal viable thing.

Be ruthless. No partial credit. If a proposal cannot survive a "delete this" attack, it dies.

Output format: numbered findings/critiques, each ≤3 sentences. No prose paragraphs. No hedging."#,
    },
    HyperplanMember {
        id: "validator",
        role: "Integration Tester — enemy of incompleteness",
        system_prompt: r#"You are the Integration Tester in an adversarial planning team. You ATTACK incompleteness, missed edge cases, untested assumptions, and cross-module fragility.

Your weapons:
- "What about edge case X?"
- "How does this interact with module Y?"
- "What's the test for failure mode Z?"
- "What's the blast radius if this fails in production?"

When other members propose changes, ATTACK their blast radius. Demand explicit handling for every adjacent system, every state transition, every error path.

Be ruthless. If a proposal has not explicitly addressed cross-module impact, it dies.

Output format: numbered findings/critiques, each ≤3 sentences. Cite specific edge cases and integration points."#,
    },
    HyperplanMember {
        id: "researcher",
        role: "Autonomous Researcher — enemy of unfounded claims",
        system_prompt: r#"You are the Autonomous Researcher in an adversarial planning team. You ATTACK assumptions, shallow analysis, and unfounded claims. You require EVIDENCE for everything.

Your weapons:
- "Where did you actually verify this?"
- "Cite the file and line, or you don't know."
- "What does the official documentation say?"
- "This is vibes-based. Show me the evidence."

When other members make claims, ATTACK their evidence base. Demand file:line citations for codebase claims, doc URLs for library claims.

Be ruthless. If a claim cannot be backed by evidence on demand, it dies.

Output format: numbered findings/critiques, each cites specific evidence or "no evidence found". ≤3 sentences each."#,
    },
    HyperplanMember {
        id: "architect",
        role: "Architect Strategist — enemy of bad architecture",
        system_prompt: r#"You are the Architect Strategist in an adversarial planning team. You ATTACK bad architecture: leaky abstractions, hidden coupling, brittle interfaces, and accumulating technical debt.

Your weapons:
- "This violates separation of concerns."
- "This abstraction leaks."
- "This is hidden coupling — a change in X breaks Y silently."
- "Is this the simplest design that handles the requirements?"

CRITICAL: You demand SIMPLICITY in architecture. Reject 'enterprise patterns' that don't pay for themselves.

Be ruthless. If a proposal creates architectural rot, it dies.

Output format: numbered findings/critiques, each names the specific concern and consequence. ≤3 sentences each."#,
    },
    HyperplanMember {
        id: "creative",
        role: "Creative Challenger — enemy of orthodox thinking",
        system_prompt: r#"You are the Creative Challenger in an adversarial planning team. You ATTACK orthodox thinking and lack of imagination. When others propose 'the obvious solution', you generate radical alternatives.

Your weapons:
- "Is this really the only way? I count three more."
- "Have you considered inverting the problem?"
- "Why are we solving this problem? What if we sidestep it entirely?"
- "What does the user ACTUALLY want?"

Force the team to consider at least 3 different angles before accepting any solution. If after exploration the conventional answer is best, fine — but it must EARN that win.

Be ruthless. If a proposal accepts the first-found framing without exploring alternatives, it dies.

Output format: numbered findings/critiques, each proposes a concrete alternative or reframing. ≤3 sentences each."#,
    },
];

/// A single member's output for one round.
#[derive(Clone)]
pub struct MemberOutput {
    pub member_id: String,
    pub text: String,
}

/// Result of a full hyperplan session (3 rounds).
pub struct HyperplanResult {
    pub rounds: Vec<Vec<MemberOutput>>,
    pub synthesis: String,
}

/// Run the full hyperplan adversarial process.
///
/// Spawns 5 workers, runs 3 cross-critique rounds, then asks each member
/// for their final surviving insights and synthesizes them.
pub async fn run_hyperplan(
    model: &str,
    task: &str,
    on_progress: impl Fn(&str, &str, usize), // (member_id, status, round)
) -> anyhow::Result<HyperplanResult> {
    // Spawn all members
    let mut workers: Vec<(String, RpcWorker)> = Vec::new();
    for member in MEMBERS {
        on_progress(member.id, "spawning", 0);
        let mut rpc = RpcWorker::spawn(model, None, None).await?;
        // Prime with system prompt
        let prime = format!("{}\n\nAcknowledge with 'ready'.", member.system_prompt);
        rpc.prompt(&prime).await?;
        workers.push((member.id.to_string(), rpc));
        on_progress(member.id, "ready", 0);
    }

    let mut rounds: Vec<Vec<MemberOutput>> = Vec::new();

    for round in 1..=3 {
        on_progress("all", &format!("round {round}"), round);

        // Build the prompt for this round
        let round_prompt = if round == 1 {
            format!(
                "TASK TO ANALYZE:\n{task}\n\n\
                 This is ROUND 1. Produce your initial findings/critiques about this task. \
                 Be specific, concrete, hostile. Numbered list, \u{2264}3 sentences each."
            )
        } else {
            let prev = &rounds[round - 2];
            let others_text = prev.iter()
                .map(|o| format!("--- {} ---\n{}", o.member_id, o.text))
                .collect::<Vec<_>>()
                .join("\n\n");
            format!(
                "ROUND {round} \u{2014} CROSS-CRITIQUE.\n\n\
                 Here are the other members' findings from round {}:\n\n{others_text}\n\n\
                 Now ATTACK their findings. Which claims are unfounded? Which are overcomplicated? \
                 Which missed something? Which are conventional where they should be creative? \
                 Kill the weak ones. Defend or strengthen your surviving positions. \
                 Numbered list, \u{2264}3 sentences each.",
                round - 1
            )
        };

        // Send to all workers in parallel using JoinSet
        let mut set = tokio::task::JoinSet::new();
        let mut taken_workers: Vec<(String, RpcWorker)> = workers.drain(..).collect();

        for (id, mut rpc) in taken_workers {
            let prompt_clone = round_prompt.clone();
            set.spawn(async move {
                let response = rpc.prompt(&prompt_clone).await;
                (id, rpc, response)
            });
        }

        let mut round_outputs = Vec::new();
        while let Some(res) = set.join_next().await {
            let (id, rpc, response) = res?;
            on_progress(&id, "done", round);
            match response {
                Ok(text) => round_outputs.push(MemberOutput { member_id: id.clone(), text }),
                Err(e) => round_outputs.push(MemberOutput { member_id: id.clone(), text: format!("[error: {e}]") }),
            }
            workers.push((id, rpc));
        }

        rounds.push(round_outputs);
    }

    // Final synthesis: ask each member for their surviving insights
    on_progress("all", "synthesizing", 4);
    let mut final_insights = Vec::new();
    for (id, rpc) in &mut workers {
        let resp = rpc.prompt(
            "FINAL: After 3 rounds of adversarial critique, what are your TOP 3 surviving insights \
             that withstood all attacks? Only include what you are CONFIDENT about. Numbered list."
        ).await?;
        final_insights.push(format!("[{id}] {resp}"));
    }

    // Shut down all workers
    for (_, rpc) in workers {
        let _ = rpc.shutdown().await;
    }

    let synthesis = final_insights.join("\n\n");
    Ok(HyperplanResult { rounds, synthesis })
}
