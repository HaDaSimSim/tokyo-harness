/**
 * Tokyo state layer — public surface.
 *
 * `StateWriter` is the sole sanctioned `.tokyo/**` writer (gate G1). The schema
 * exports define the read-lenient / write-strict contract. Nothing here imports
 * the pi API; `extension/index.ts` remains the only pi-API boundary.
 */
export * from "./schema.ts";
export {
	AlreadyExistsError,
	type AuditOptions,
	canonicalizeJson,
	detectWorkflowEnvelopeIntegrityMismatch,
	InvalidEnvelopeError,
	PathContainmentError,
	type ReadResult,
	stampWorkflowEnvelopeChecksum,
	StateWriter,
	workflowEnvelopeContentSha256,
} from "./writer.ts";
