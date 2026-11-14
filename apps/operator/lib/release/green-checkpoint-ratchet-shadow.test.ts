import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PROOF_CONTEXT_COMPONENTS, createProofContextIdentity, type ProofContextIdentity } from "@papercusp/test-config/configuration-snapshot";
import {
  parseRepairHeadRadius,
  shadowComposedProofAtRepairHead,
  shadowNewRedEjectionAtCandidate,
  realCheckpointDeps,
  type RepairHeadRadius,
} from "./green-checkpoint";
import { releaseConfig } from "./release-config";

/** green-main-ratchet-convergence-2026-10-17 #D-025: the P-018 shadow reads a real lineage diff. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ratchet-shadow-"));
  dirs.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (fs: Record<string, string>) => {
    for (const [p, body] of Object.entries(fs)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), body);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD");
  };
  return { root, candidate: commit(files), commit };
}

const exactRadius = (files: string[]): RepairHeadRadius => ({
  files: files.map((file) => ({ workspace: "w", file })),
  gateIds: [],
  coverageComplete: true,
  widenedTasks: 0,
  summary: "exact",
});

describe("shadowComposedProofAtRepairHead (P-018 shadow)", () => {
  const context = createProofContextIdentity(Object.fromEntries(PROOF_CONTEXT_COMPONENTS.map(key =>
    [key, createHash('sha256').update(key).digest('hex')])) as ProofContextIdentity['components'])!;
  const proofContext = { before: context, after: context };
  it("re-runs the radius of a runtime change, carries the rest of round 1, and asks the selector at the repair head", async () => {
    const { root, candidate, commit } = repoWith({ "src/a.ts": "export const a = 1;\n", "src/t.ts": "export type T = number;\n" });
    const repairHead = commit({ "src/a.ts": "export const a = 2;\n" });
    const asked: Array<[string, string[]]> = [];
    const shadow = await shadowComposedProofAtRepairHead({
      proofContext,
      root,
      queue: {
        candidate,
        convergenceRounds: [{ round: 1, head: candidate, failingCount: 2, failingTests: ["src/a.test.ts", "src/b.test.ts"], atMs: 1 }],
      },
      repairHead,
      affectedTestsAtRef: async (ref, paths) => {
        asked.push([ref, paths]);
        return exactRadius(["src/a.test.ts"]);
      },
      nowMs: 1,
    });
    expect(asked).toEqual([[repairHead, ["src/a.ts"]]]);
    expect(shadow.record).toMatchObject({ status: "planned", mode: "composed", rerunCount: 1, carriedFailing: ["src/b.test.ts"] });
    // The actual caller uses boot-time observability, never this fixture's Git
    // checkout as evidence of the executing artifact. Vitest has no boot receipt.
    expect(shadow.record.instrument).toMatchObject({ schemaVersion: 'instrument-v1', status: 'unknown',
      fingerprint: null, missing: expect.arrayContaining(['executing-artifact-unmeasured']) });
  });

  it("asks nothing for a type-only change and reads a widened selector as a full gate", async () => {
    const { root, candidate, commit } = repoWith({ "src/t.ts": "export type T = number;\n", "src/a.ts": "export const a = 1;\n" });
    const typeOnly = commit({ "src/t.ts": "export type T = string;\n" });
    let calls = 0;
    const quiet = await shadowComposedProofAtRepairHead({
      proofContext,
      root,
      queue: { candidate, convergenceRounds: [{ round: 1, head: candidate, failingCount: 0, failingTests: [], atMs: 1 }] },
      repairHead: typeOnly,
      affectedTestsAtRef: async () => {
        calls += 1;
        return exactRadius([]);
      },
      nowMs: 1,
    });
    expect(calls).toBe(0);
    expect(quiet.record).toMatchObject({ mode: "composed", typeOnlyFileCount: 1, rerunCount: 0 });

    const runtime = commit({ "src/a.ts": "export const a = 3;\n" });
    const widened = await shadowComposedProofAtRepairHead({
      proofContext,
      root,
      queue: { candidate, convergenceRounds: [{ round: 1, head: candidate, failingCount: 0, failingTests: [], atMs: 1 }] },
      repairHead: runtime,
      affectedTestsAtRef: async () => ({ ...exactRadius([]), widenedTasks: 1 }),
      nowMs: 1,
    });
    expect(widened.record).toMatchObject({ status: "planned", mode: "full-gate" });
  });

  it("skips when no round-1 failing set is recorded at the frozen candidate", async () => {
    const { root, candidate, commit } = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const head = commit({ "src/a.ts": "export const a = 2;\n" });
    const s = await shadowComposedProofAtRepairHead({ root, queue: { candidate }, repairHead: head, nowMs: 1 });
    expect(s.record).toMatchObject({ status: "skipped" });
  });

  it("keeps legacy production observations in full fallback when context is absent", async () => {
    const { root, candidate, commit } = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const head = commit({ "src/a.ts": "export const a = 2;\n" });
    const shadow = await shadowComposedProofAtRepairHead({ root,
      queue: { candidate, convergenceRounds: [{ round: 1, head: candidate, failingCount: 0, failingTests: [], atMs: 1 }] },
      repairHead: head, affectedTestsAtRef: async () => exactRadius(["src/a.test.ts"]), nowMs: 1 });
    expect(shadow.record).toMatchObject({ status: "planned", mode: "full-gate", reason: "proof-context-unmeasured" });
  });

  it("captures candidate then repair head sequentially and rejects incomplete actual evidence over a supplied context", async () => {
    const { root, candidate, commit } = repoWith({ "src/t.ts": "export type T = number;" });
    const repairHead = commit({ "src/t.ts": "export type T = string;" });
    const refs: string[] = [];
    const shadow = await shadowComposedProofAtRepairHead({ root, proofContext,
      queue: { candidate, convergenceRounds: [{ round: 1, head: candidate, failingCount: 0, failingTests: [], atMs: 1 }] },
      repairHead, nowMs: 1, captureProofContextAtRef: async ref => {
        refs.push(ref);
        return { ref, context: null, reach: { status: 'unknown', reason: 'consumer-census-incomplete' } };
      } });
    expect(refs).toEqual([candidate, repairHead]);
    expect(shadow.record).toMatchObject({ mode: 'full-gate', reason: 'proof-context-unmeasured' });
  });

  it("keeps the full gate when real capture throws or returns a context for another ref", async () => {
    const { root, candidate, commit } = repoWith({ "src/t.ts": "export type T = number;" });
    const repairHead = commit({ "src/t.ts": "export type T = string;" });
    for (const fails of [true, false]) {
      const shadow = await shadowComposedProofAtRepairHead({ root, proofContext,
        queue: { candidate, convergenceRounds: [{ round: 1, head: candidate, failingCount: 0, failingTests: [], atMs: 1 }] },
        repairHead, nowMs: 1, captureProofContextAtRef: async () => {
          if (fails) throw new Error('setup unavailable');
          return { ref: 'foreign', context, reach: { status: 'unknown', reason: 'unmeasured' } };
        } });
      expect(shadow.record).toMatchObject({ mode: 'full-gate', reason: 'proof-context-unmeasured' });
    }
  });

  it("real CheckpointDeps pins the isolated root and skips discovery when actual post-suite inputs are unmeasured", async () => {
    const { root, candidate } = repoWith({ 'package.json': JSON.stringify({ name: 'source-fixture', scripts: {} }) });
    const executed: string[] = [];
    const deps = realCheckpointDeps(releaseConfig({ integrationRoot: path.join(root, 'not-the-source'),
      releaseRoot: root, checkpointRoot: root, checkpointLogDir: root, spaBuildWorkspace: '@fixture/spa' }),
      async (command) => { executed.push(command); throw new Error('no child should run'); });
    const refs: string[] = [];
    deps.setupTree = async ref => { refs.push(ref); };
    const capture = await deps.captureProofContextAtRef!(candidate);
    expect(refs).toEqual([candidate]); expect(executed).toEqual([]);
    expect(capture).toMatchObject({ ref: candidate, context: null,
      reach: { status: 'unknown', reason: 'post-suite-leg-inputs-unmeasured' } });
  });
});

describe("shadowNewRedEjectionAtCandidate (P-007 shadow)", () => {
  /** Radius by source file: src/x.ts selects src/x.test.ts. */
  const radiusBySource = async (paths: readonly string[]) =>
    new Set(paths.filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts")).map((p) => p.replace(/\.ts$/, ".test.ts")));

  it("reads the commits since the green pin and attributes a failure to the one commit whose radius selects it", async () => {
    const { root, candidate: base, commit } = repoWith({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" });
    const touchA = commit({ "src/a.ts": "export const a = 2;\n" });
    const touchB = commit({ "src/b.ts": "export const b = 2;\n" });
    const asked: string[][] = [];
    const record = await shadowNewRedEjectionAtCandidate({
      root,
      candidateSha: touchB,
      candidateLabel: touchB,
      base,
      newFailures: ["src/a.test.ts"],
      radius: async (paths) => {
        asked.push([...paths]);
        return radiusBySource(paths);
      },
    });
    expect(record).toMatchObject({
      status: "planned",
      candidate: touchB,
      base,
      commitCount: 2,
      newFailureCount: 1,
      plan: "eject",
      attributions: [{ test: "src/a.test.ts", kind: "attributed", commit: touchA }],
      blameCheck: "not-run",
    });
    // The selector was asked about the range's changed files, never about the base commit's.
    expect(asked.length).toBeGreaterThan(0);
    for (const paths of asked) expect(paths.every((p) => p === "src/a.ts" || p === "src/b.ts")).toBe(true);
  });

  it("records an over-long range as skipped with its commit count, without reading the log", async () => {
    const { root, candidate: base, commit } = repoWith({ "src/a.ts": "export const a = 1;\n" });
    commit({ "src/a.ts": "export const a = 2;\n" });
    const head = commit({ "src/a.ts": "export const a = 3;\n" });
    let calls = 0;
    const lines: string[] = [];
    const record = await shadowNewRedEjectionAtCandidate({
      root,
      candidateSha: head,
      candidateLabel: head,
      base,
      newFailures: ["src/a.test.ts"],
      radius: async () => {
        calls += 1;
        return new Set<string>();
      },
      maxCommits: 1,
      log: (l) => lines.push(l),
    });
    expect(calls).toBe(0);
    expect(record).toMatchObject({ status: "skipped", commitCount: 2, reason: "commit range too long (2 > 1)" });
    expect(lines.join("\n")).toContain("2 commits since the green pin (cap 1)");
  });

  it("records an unreadable range as skipped instead of throwing", async () => {
    const { root, candidate } = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const record = await shadowNewRedEjectionAtCandidate({
      root,
      candidateSha: candidate,
      candidateLabel: candidate,
      base: "0".repeat(40),
      newFailures: ["src/a.test.ts"],
      radius: async () => new Set<string>(),
      log: () => {},
    });
    expect(record).toMatchObject({ status: "skipped", reason: "the commit range since the green pin is unreadable" });
  });

  it("records nothing-new when no file-level failure remains", async () => {
    const { root, candidate } = repoWith({ "src/a.ts": "export const a = 1;\n" });
    const record = await shadowNewRedEjectionAtCandidate({
      root,
      candidateSha: candidate,
      candidateLabel: candidate,
      base: candidate,
      newFailures: [],
      radius: async () => new Set<string>(),
    });
    expect(record.status).toBe("nothing-new");
  });
});

describe("parseRepairHeadRadius widenedTasks", () => {
  it("reports how many affected test tasks the selector widened", () => {
    const out = [
      "AFFECTED_DERIVATION source=explicit workspaces=1 tasks=1 guards=0",
      "AFFECTED_WS\t@x/core",
      "AFFECTED_WS_CMD\t@x/core\tnpm run --workspace @x/core test",
      "RELATED_AFFECTED_FILES status=full reason=unresolved",
    ].join("\n");
    expect(parseRepairHeadRadius(out)?.widenedTasks).toBe(1);
  });
});
