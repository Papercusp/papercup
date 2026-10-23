/** Supplementary independent R4 detector; WI-6554700010020448.
 * The frozen prepared-selection acceptance file remains unchanged.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginCheckpointPreflight,
  checkpointRunLockDir,
  ensureCheckpointDependencyGeneration,
  runCmd,
  type CheckpointDeps,
  type CheckpointOpts,
} from "./green-checkpoint";
import { releaseConfig } from "./release-config";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "p023-prepared-continuity-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const integration = join(root, "integration");
  mkdirSync(join(integration, "node_modules", "fixture-dep"), { recursive: true });
  vi.stubEnv("PC_HEAVY_DIR", join(root, "pc-heavy"));
  vi.stubEnv("PAPERCUSP_DEPENDENCY_GENERATION_ROOT", join(root, "generations"));
  vi.stubEnv("DEPENDENCY_GENERATION_COPY_LOCK_FILE", join(root, "copy.lock"));
  vi.stubEnv("PAPERCUSP_QUIET_CUT", "0");
  const forward = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && / dependency-prewarm (stdout|stderr): /.test(args[0])) return;
    forward(...args);
  });
  const exec: typeof runCmd = (command, args, options = {}) => runCmd(command, args, {
    ...options, timeoutMs: 60_000, hardTimeoutMs: 60_000,
    killProcessGroupOnTimeout: true, signal: controller.signal,
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", integration, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "staging");
  git("config", "user.name", "Independent continuity fixture");
  git("config", "user.email", "independent@example.invalid");
  const commit = (version: string) => {
    writeFileSync(join(integration, "package.json"), JSON.stringify({ name: "continuity-fixture", private: true }));
    writeFileSync(join(integration, "package-lock.json"), JSON.stringify({
      name: "continuity-fixture", lockfileVersion: 3,
      packages: { "node_modules/fixture-dep": { version } },
    }));
    writeFileSync(join(integration, "node_modules", "fixture-dep", "package.json"), JSON.stringify({ name: "fixture-dep", version }));
    writeFileSync(join(integration, "node_modules", "fixture-dep", "index.js"), `module.exports = '${version}';\n`);
    git("add", "package.json", "package-lock.json");
    git("commit", "-qm", `fixture dependencies ${version}`);
    return git("rev-parse", "HEAD");
  };
  const ready = commit("1.0.0");
  git("branch", "main", ready);
  const cfg = releaseConfig({
    integrationRoot: integration, releaseRoot: join(root, "release"),
    checkpointRoot: join(root, "checkpoint"), checkpointLogDir: join(root, "logs"),
    integrationBranch: "staging", releaseRef: "main",
  });
  const knownGood = commit("2.0.0");
  await ensureCheckpointDependencyGeneration(cfg, knownGood, exec);
  const tip = commit("3.0.0");
  const attemptId = "independent-inherited-active-attempt";
  const observedAttempts: string[] = [];
  const deps: CheckpointDeps = {
    qualificationAttemptId: attemptId,
    runId: "a-different-run-id-must-not-replace-the-attempt",
    setupTree: async () => { throw new Error("preparation must not materialize a tree"); },
    runGreen: async () => { throw new Error("preparation must not execute a suite"); },
    advance: async () => {}, push: async () => {}, broadcast: async () => {},
    escalate: async () => {}, clearEscalation: async () => {}, emitEvent: async () => {}, log: () => {},
    readFrozenRepairQueue: async () => null,
    resolveKnownGoodRecutTarget: async () => knownGood,
    readPreparedCheckpointSelection: async (authority) => {
      observedAttempts.push(authority.attemptId);
      return null;
    },
    commitPreparedCheckpointSelection: async (record) => {
      observedAttempts.push(record.attemptId);
      return true;
    },
  };
  return { cfg, root, integration, knownGood, tip, exec, deps, attemptId, observedAttempts };
}

describe("fresh preparation preserves inherited active-run authority (R4)", () => {
  it.each([
    { name: "commits with the inherited attempt while time remains", elapsedDuringPublication: 0, expected: "ready" },
    { name: "charges preparation to the inherited clock before commit", elapsedDuringPublication: 200, expected: "deadline" },
  ])("$name", async ({ elapsedDuringPublication, expected }) => {
    const f = await fixture();
    const budgetMs = 10_000;
    let clock = Date.now();
    const inheritedStart = clock - (budgetMs - 100);
    vi.stubEnv("PAPERCUSP_GATE_REFIRE_RUN_BUDGET_MS", String(budgetMs));
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let publications = 0;
    const exec: typeof runCmd = async (command, args, options) => {
      const publishing = args.includes("--ensure-ref");
      if (publishing) {
        expect(clock - inheritedStart).toBeLessThan(budgetMs);
        expect(existsSync(checkpointRunLockDir(f.cfg.checkpointLogDir, f.integration))).toBe(false);
        publications += 1;
      }
      const result = await f.exec(command, args, options);
      if (publishing) clock += elapsedDuringPublication;
      return result;
    };
    const opts: CheckpointOpts = { runStartedAtMs: inheritedStart, totalRefires: 1, noPush: true };
    const outcome = await beginCheckpointPreflight(f.cfg, f.tip, exec, {
      target: null, checkpointSelection: { deps: f.deps, opts },
    }).then((result) => {
      if (result.kind === "ready") onTestFinished(() => { if (result.lock.acquired) result.lock.release(); });
      return { result, error: null };
    }, (error: unknown) => ({ result: null, error }));
    expect(publications).toBe(1);
    expect(opts).toEqual({ runStartedAtMs: inheritedStart, totalRefires: 1, noPush: true });
    expect(f.deps.qualificationAttemptId).toBe(f.attemptId);
    if (expected === "ready") {
      expect(outcome.error).toBeNull();
      expect(outcome.result?.kind).toBe("ready");
      if (outcome.result?.kind !== "ready") throw new Error("active-budget preparation did not succeed");
      expect(outcome.result.preparedSelection).toMatchObject({ attemptId: f.attemptId, candidate: f.knownGood });
      expect(f.observedAttempts).toEqual([f.attemptId, f.attemptId]);
    } else {
      expect(outcome.result).toBeNull();
      expect(String(outcome.error)).toMatch(/run deadline\/refire budget exhausted before commit/);
      expect(f.observedAttempts).toEqual([f.attemptId]);
      expect(existsSync(checkpointRunLockDir(f.cfg.checkpointLogDir, f.integration))).toBe(false);
    }
  }, 180_000);
});
