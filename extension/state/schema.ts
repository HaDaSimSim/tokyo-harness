/**
 * Tokyo state schema — ported from GJC's `state-schema.ts`.
 *
 * DESIGN: read-lenient / write-strict asymmetry.
 *   - Read schemas are LENIENT/ADDITIVE (`.passthrough()`, every non-structural
 *     field optional). Reads never reject evolving or older state. An invalid file
 *     fails OPEN (the reader returns the raw payload for the caller to normalize),
 *     never crashes.
 *   - The strict `RequiredOnWriteEnvelopeSchema` is the WRITE-side gate (fail-closed),
 *     anchored to exactly what the sanctioned writer emits. `content_sha256` is
 *     REQUIRED here so every written envelope is tamper-evident.
 *
 * Pure module: no fs, no pi API. Imported only by `writer.ts` and tests.
 */
import { z } from "zod";

/** Bump when the on-disk envelope shape changes incompatibly. */
export const WORKFLOW_STATE_VERSION = 1 as const;

/**
 * Canonical workflow skills. The write gate anchors `skill` to this set, so an
 * envelope written for an unknown skill is rejected before it touches disk.
 * Reads stay lenient (any string) for forward/backward compatibility.
 */
export const CANONICAL_TOKYO_WORKFLOW_SKILLS = [
	"interview",
	"plan",
	"execute",
	"verify",
	"team",
] as const;
export type TokyoWorkflowSkill = (typeof CANONICAL_TOKYO_WORKFLOW_SKILLS)[number];

const skillEnum = z.enum(CANONICAL_TOKYO_WORKFLOW_SKILLS);

/** Audit categories — what kind of mutation a primitive performed. */
export const AUDIT_CATEGORIES = [
	"state",
	"artifact",
	"ledger",
	"log",
	"report",
	"agents",
	"prune",
	"force",
	"transaction",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Who performed the mutation. */
export const AUDIT_OWNERS = ["tokyo-state-cli", "tokyo-runtime", "tokyo-hook"] as const;
export type AuditOwner = (typeof AUDIT_OWNERS)[number];

// ---- content checksum receipt -------------------------------------------------

/** Read side: checksum block is optional and additive. */
export const ContentChecksumSchema = z
	.object({
		algorithm: z.string().optional(),
		value: z.string().optional(),
		covered_path: z.string().optional(),
		computed_at: z.string().optional(),
	})
	.passthrough();
export type ContentChecksum = z.infer<typeof ContentChecksumSchema>;

/** Write side: every field of the checksum is required. */
export const RequiredContentChecksumSchema = z.object({
	algorithm: z.literal("sha256"),
	value: z.string().min(1),
	covered_path: z.string().min(1),
	computed_at: z.string().min(1),
});

/** Read side: receipt is optional/additive. */
export const WorkflowStateReceiptSchema = z
	.object({
		content_sha256: ContentChecksumSchema.optional(),
	})
	.passthrough();
export type WorkflowStateReceipt = z.infer<typeof WorkflowStateReceiptSchema>;

/** Write side: receipt MUST carry a complete content_sha256 block. */
export const RequiredWorkflowStateReceiptSchema = z
	.object({
		content_sha256: RequiredContentChecksumSchema,
	})
	.passthrough();

// ---- the envelope -------------------------------------------------------------

/**
 * READ schema (lenient). Unknown keys preserved; non-anchored fields optional.
 * Upholds the read contract: reads never reject evolving/old state.
 */
export const WorkflowStateEnvelopeSchema = z
	.object({
		skill: z.string().optional(),
		active: z.boolean().optional(),
		current_phase: z.string().optional(),
		version: z.number().optional(),
		updated_at: z.string().optional(),
		session_id: z.string().optional(),
		receipt: WorkflowStateReceiptSchema.optional(),
	})
	.passthrough();
export type WorkflowStateEnvelope = z.infer<typeof WorkflowStateEnvelopeSchema>;

/**
 * WRITE schema (strict, fail-closed). Anchored to exactly what the sanctioned
 * writer emits. Extra keys are still allowed (`.passthrough()`) so callers can
 * attach skill-specific payload, but the anchored fields and a complete
 * `content_sha256` receipt are mandatory.
 */
export const RequiredOnWriteEnvelopeSchema = z
	.object({
		skill: skillEnum,
		version: z.literal(WORKFLOW_STATE_VERSION),
		updated_at: z.string().min(1),
		current_phase: z.string().min(1),
		active: z.boolean(),
		receipt: RequiredWorkflowStateReceiptSchema,
	})
	.passthrough();
export type RequiredOnWriteEnvelope = z.infer<typeof RequiredOnWriteEnvelopeSchema>;

// ---- audit entry --------------------------------------------------------------

export const AuditEntrySchema = z
	.object({
		ts: z.string(),
		skill: z.string().optional(),
		category: z.enum(AUDIT_CATEGORIES),
		verb: z.string(),
		owner: z.enum(AUDIT_OWNERS),
		mutation_id: z.string(),
		from_phase: z.string().optional(),
		to_phase: z.string().optional(),
		forced: z.boolean().optional(),
		paths: z.array(z.string()),
	})
	.passthrough();
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
