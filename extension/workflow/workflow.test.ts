/**
 * Unit tests for the tokyo phase machine + mutation gate.
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { evaluateToolCall, isSafeCommand } from "./gates.ts";
import {
	canTransition,
	isPhase,
	nextPhases,
	PHASE_POLICY,
	PhaseMachine,
	phaseContract,
	transitionRequiresConsent,
} from "./phases.ts";

describe("phase predicates", () => {
	test("isPhase recognizes valid phases and rejects junk", () => {
		expect(isPhase("EXECUTE")).toBe(true);
		expect(isPhase("IDLE")).toBe(true);
		expect(isPhase("nope")).toBe(false);
		expect(isPhase(undefined)).toBe(false);
	});
});

describe("transition graph", () => {
	test("the happy path is legal end to end", () => {
		expect(canTransition("IDLE", "INTERVIEW")).toBe(true);
		expect(canTransition("INTERVIEW", "RESEARCH")).toBe(true);
		expect(canTransition("INTERVIEW", "PLAN")).toBe(true);
		expect(canTransition("RESEARCH", "PLAN")).toBe(true);
		expect(canTransition("PLAN", "EXECUTE")).toBe(true);
		expect(canTransition("EXECUTE", "VERIFY")).toBe(true);
		expect(canTransition("VERIFY", "REVIEW")).toBe(true);
		expect(canTransition("REVIEW", "DONE")).toBe(true);
		// iteration + re-plan edges
		expect(canTransition("REVIEW", "PLAN")).toBe(true);
		expect(canTransition("REVIEW", "EXECUTE")).toBe(true);
		expect(canTransition("EXECUTE", "PLAN")).toBe(true);
	});

	test("illegal skips are rejected", () => {
		expect(canTransition("IDLE", "EXECUTE")).toBe(false);
		expect(canTransition("INTERVIEW", "EXECUTE")).toBe(false);
		expect(canTransition("IDLE", "PLAN")).toBe(false);
		expect(canTransition("PLAN", "DONE")).toBe(false);
	});

	test("self-transition is an idempotent no-op", () => {
		expect(canTransition("EXECUTE", "EXECUTE")).toBe(true);
	});

	test("verify can loop back to execute on failure", () => {
		expect(canTransition("VERIFY", "EXECUTE")).toBe(true);
	});

	test("plan can return to interview to re-clarify", () => {
		expect(canTransition("PLAN", "INTERVIEW")).toBe(true);
	});

	test("done can begin a fresh workflow", () => {
		expect(canTransition("DONE", "INTERVIEW")).toBe(true);
	});

	test("only PLAN→EXECUTE requires consent", () => {
		expect(transitionRequiresConsent("PLAN", "EXECUTE")).toBe(true);
		expect(transitionRequiresConsent("INTERVIEW", "PLAN")).toBe(false);
		expect(transitionRequiresConsent("VERIFY", "REVIEW")).toBe(false);
		expect(transitionRequiresConsent("REVIEW", "DONE")).toBe(true);
	});

	test("nextPhases lists legal targets", () => {
		expect(nextPhases("PLAN").sort()).toEqual(["EXECUTE", "IDLE", "INTERVIEW", "RESEARCH"]);
	});
});

describe("PhaseMachine", () => {
	test("starts IDLE by default", () => {
		expect(new PhaseMachine().current).toBe("IDLE");
	});

	test("applies a legal non-consent transition", () => {
		const m = new PhaseMachine();
		const r = m.transition("INTERVIEW");
		expect(r.ok).toBe(true);
		expect(m.current).toBe("INTERVIEW");
	});

	test("rejects an illegal transition and stays put", () => {
		const m = new PhaseMachine("IDLE");
		const r = m.transition("EXECUTE");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("illegal transition");
		expect(m.current).toBe("IDLE");
	});

	test("a consent-gated transition is refused without consent", () => {
		const m = new PhaseMachine("PLAN");
		const r = m.transition("EXECUTE");
		expect(r.ok).toBe(false);
		expect(r.needsConsent).toBe(true);
		expect(m.current).toBe("PLAN"); // not applied
	});

	test("a consent-gated transition succeeds with consent", () => {
		const m = new PhaseMachine("PLAN");
		const r = m.transition("EXECUTE", { withConsent: true });
		expect(r.ok).toBe(true);
		expect(r.needsConsent).toBe(true); // reports that it did need it
		expect(m.current).toBe("EXECUTE");
	});

	test("restore bypasses validation (disk rehydrate)", () => {
		const m = new PhaseMachine("IDLE");
		m.restore("EXECUTE");
		expect(m.current).toBe("EXECUTE");
	});

	test("reset returns to IDLE", () => {
		const m = new PhaseMachine("DONE");
		m.reset();
		expect(m.current).toBe("IDLE");
	});

	test("policy reflects the current phase", () => {
		const m = new PhaseMachine("INTERVIEW");
		expect(m.policy().mutationsAllowed).toBe(false);
		m.restore("EXECUTE");
		expect(m.policy().mutationsAllowed).toBe(true);
	});
});

describe("phase policy", () => {
	test("planning phases bar mutations but allow full bash (MCP/tooling)", () => {
		for (const p of ["INTERVIEW", "PLAN"] as const) {
			expect(PHASE_POLICY[p].mutationsAllowed).toBe(false);
			expect(PHASE_POLICY[p].bash).toBe("full");
		}
	});

	test("execute allows everything", () => {
		expect(PHASE_POLICY.EXECUTE.mutationsAllowed).toBe(true);
		expect(PHASE_POLICY.EXECUTE.bash).toBe("full");
	});

	test("verify allows full bash but bars source mutation", () => {
		expect(PHASE_POLICY.VERIFY.mutationsAllowed).toBe(false);
		expect(PHASE_POLICY.VERIFY.bash).toBe("full");
	});

	test("idle behaves like plain pi", () => {
		expect(PHASE_POLICY.IDLE.mutationsAllowed).toBe(true);
		expect(PHASE_POLICY.IDLE.bash).toBe("full");
	});
});

describe("phase contract injection", () => {
	test("IDLE injects nothing", () => {
		expect(phaseContract("IDLE")).toBeNull();
	});

	test("planning phases announce read-only", () => {
		expect(phaseContract("INTERVIEW")).toContain("READ-ONLY");
		expect(phaseContract("PLAN")).toContain("READ-ONLY");
	});

	test("execute announces full access", () => {
		expect(phaseContract("EXECUTE")).toContain("Full tool access");
	});

	test("PLAN contract varies by planning depth", () => {
		expect(phaseContract("PLAN", "quick")).toContain("QUICK");
		expect(phaseContract("PLAN", "consensus")).toContain("CONSENSUS");
		const adv = phaseContract("PLAN", "adversarial");
		expect(adv).toContain("HYPERPLAN");
		expect(adv).toContain("hyperplan_run");
		expect(adv).toContain("3-round");
	});

	test("PLAN defaults to consensus depth", () => {
		expect(phaseContract("PLAN")).toContain("CONSENSUS");
	});
});

describe("bash safety classifier", () => {
	test("allows read-only commands", () => {
		expect(isSafeCommand("cat file.txt")).toBe(true);
		expect(isSafeCommand("grep -r foo src/")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("ls -la")).toBe(true);
	});

	test("blocks destructive commands", () => {
		expect(isSafeCommand("rm -rf /")).toBe(false);
		expect(isSafeCommand("echo x > file")).toBe(false);
		expect(isSafeCommand("git commit -m x")).toBe(false);
		expect(isSafeCommand("npm install")).toBe(false);
		expect(isSafeCommand("bun add zod")).toBe(false);
	});

	test("blocks commands not on the allowlist", () => {
		expect(isSafeCommand("some-random-binary --go")).toBe(false);
	});
});

describe("gate evaluation", () => {
	const planning = PHASE_POLICY.PLAN;
	const exec = PHASE_POLICY.EXECUTE;
	const verify = PHASE_POLICY.VERIFY;

	test("blocks edit/write in a planning phase", () => {
		expect(evaluateToolCall(planning, { toolName: "edit", input: { path: "x" } }, "PLAN").block).toBe(true);
		expect(evaluateToolCall(planning, { toolName: "write", input: { path: "x" } }, "PLAN").block).toBe(true);
	});

	test("allows read in a planning phase", () => {
		expect(evaluateToolCall(planning, { toolName: "read", input: { path: "x" } }, "PLAN").block).toBe(false);
	});

	test("bash is unrestricted in planning phases (MCP/tooling must work)", () => {
		expect(evaluateToolCall(planning, { toolName: "bash", input: { command: "echo x > f" } }, "PLAN").block).toBe(
			false,
		);
		expect(evaluateToolCall(planning, { toolName: "bash", input: { command: "git status" } }, "PLAN").block).toBe(
			false,
		);
	});

	test("allows everything in EXECUTE", () => {
		expect(evaluateToolCall(exec, { toolName: "write", input: { path: "x" } }, "EXECUTE").block).toBe(false);
		expect(evaluateToolCall(exec, { toolName: "bash", input: { command: "rm -rf build" } }, "EXECUTE").block).toBe(
			false,
		);
	});

	test("VERIFY bars source mutation but allows full bash (e.g. running tests)", () => {
		expect(evaluateToolCall(verify, { toolName: "write", input: { path: "x" } }, "VERIFY").block).toBe(true);
		expect(evaluateToolCall(verify, { toolName: "bash", input: { command: "npm test" } }, "VERIFY").block).toBe(
			false,
		);
	});

	test("block reason names the phase", () => {
		const d = evaluateToolCall(planning, { toolName: "edit", input: {} }, "PLAN");
		expect(d.reason).toContain("PLAN");
	});
});
