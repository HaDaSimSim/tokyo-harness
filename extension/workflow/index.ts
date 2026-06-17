/**
 * Tokyo workflow layer — public surface.
 *
 * Pure phase machine + mutation gate. No fs, no pi API; `extension/index.ts`
 * is the only file that touches pi and wires these in.
 */
export {
	evaluateToolCall,
	type GateDecision,
	guardsDotDirBash,
	guardsDotDirWrite,
	isSafeCommand,
	type ToolCallLike,
} from "./gates.ts";
export {
	BROWNFIELD_WEIGHTS,
	computeAmbiguity,
	type DimensionScores,
	evaluateClarity,
	type GateResult,
	GREENFIELD_WEIGHTS,
	type ProjectKind,
	renderProgress,
} from "./ambiguity.ts";
export {
	DEFAULT_PROFILE,
	isProfileName,
	parseProfileFlag,
	PROFILES,
	type ProfileName,
	resolveThreshold,
	type ResolvedThreshold,
} from "./settings.ts";
export {
	allGoalsSettled,
	buildReceipt,
	type CompletionReceipt,
	emptyGoalsState,
	type EvidenceItem,
	type EvidenceKind,
	type EvidenceStatus,
	type Goal,
	type GoalsState,
	type GoalStatus,
	type LedgerEvent,
	nextActiveGoal,
	receiptContentSha256,
	type ReceiptValidation,
	validateReceipt,
	verifyCompletionFromDisk,
} from "./goals.ts";
export {
	type ContinuationDecision,
	type ContinuationState,
	decideContinuation,
	freshContinuationState,
	MAX_CONTINUATION_ITERATIONS,
} from "./continuation.ts";
export {
	canTransition,
	isPhase,
	isPlanMode,
	MUTATION_TOOLS,
	nextPhases,
	type Phase,
	PHASE_POLICY,
	PHASES,
	PhaseMachine,
	phaseContract,
	type PlanMode,
	PLAN_MODE_LABELS,
	PLAN_MODES,
	type ToolPolicy,
	type TransitionResult,
	transitionRequiresConsent,
} from "./phases.ts";
