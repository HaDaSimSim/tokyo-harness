/**
 * Safe identifier + shell quoting helpers (ported verbatim from GJC team-runtime).
 *
 * Worker ids, team names, and model strings flow into filesystem path segments
 * and (for orchestrator worker IDs) shell command lines. They can be model-controlled,
 * so they MUST be validated before use. GJC's `isSafeId`/`assertSafeId`/`shellQuote`
 * are the reference defense; tokyo dropped them during the port (security gap CR4).
 */

/** A safe id: alnum start, then alnum/_.:- ; no `..`, `/`, or `\`. */
export function isSafeId(value: string): boolean {
	return (
		/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) &&
		!value.includes("..") &&
		!value.includes("/") &&
		!value.includes("\\")
	);
}

export function assertSafeId(kind: string, value: string): void {
	if (!isSafeId(value)) throw new Error(`invalid_${kind}: ${JSON.stringify(value)}`);
}

/** A model string: provider/name[:tag]. Allows one slash, alnum and _.:- otherwise. */
export function isSafeModel(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*\/[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) && !value.includes("..");
}

export function assertSafeModel(value: string): void {
	if (!isSafeModel(value)) throw new Error(`invalid_model: ${JSON.stringify(value)}`);
}

/** POSIX single-quote shell escaping. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
