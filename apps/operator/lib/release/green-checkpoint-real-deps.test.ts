/**
 * green-checkpoint REAL-path wiring (hive-run-evaluation gap #10).
 *
 * The sibling green-checkpoint.test.ts covers the ORCHESTRATION (advance-only-
 * when-green, FF-only) with STUB deps. This covers the REAL deps
 * (realCheckpointDeps) the stub replaces — the heavy ops are shelled through an
 * injected `exec` seam (default = the spawn-backed runCmd), so the WIRING is
 * asserted WITHOUT running the suite, the SPA build, or a git push:
 *   - runGreen passes the stripped checkpoint env (GREEN_CHECKPOINT + AFFECTED_BASE)
 *     to the green command, in the checkpoint tree;
 *   - P-005: the SPA build is PART of green — a green suite + a FAILED build is
 *     NOT green, and the build break folds into the failure signature;
 *   - a red suite short-circuits (no build attempt);
 *   - setupTree invokes setup-release-checkout.sh with the right flags;
 *   - push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past
 *     the main pre-push hook).
 * The actual FF-of-main (advance → advanceReady) is the orchestration test's
 * real-git temp-repo path; here we never touch a real branch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNpmScript,
  hasNpmScript,
  realCheckpointDeps,
  resolveWorkspaceFileTestInvocation,
  resolveWorkspaceTestInvocation,
  CONCURRENT_CONFIRM_TIMEOUT_MS,
  ISOLATION_RUN_TIMEOUT_MS,
  RESCUE_TEST_TIMEOUT_MS,
  WORKSPACE_RERUN_TIMEOUT_MS,
  GREEN_CHECKPOINT_POST_SUITE_HEAP_MB,
  GREEN_CHECKPOINT_RESERVED_MAX_FORKS,
  GATE_ESCALATION_SOURCE,
  DETECTOR_ESCALATION_SOURCE,
  ESCALATION_CLASS_META_KEY,
  RELEASE_NOT_GREEN_ESCALATION_CLASS,
  isReleaseNotGreenEscalation,
  type CheckpointExec,
} from "./green-checkpoint";
import { releaseConfig, type ReleaseConfig } from "./release-config";
import {
  selectStaleEscalations,
  SELF_RECONCILING_META_KEY,
  type StaleEscalationInput,
} from "@papercusp/operator-core/lib/attention/reconcile-escalations";

// EI-18661485259809120: push() also fires a workflow_dispatch of test.yml (since the
// pushed commit's `[skip ci]` message means the plain `git push` above never actually
// triggers GitHub's push-event listener). Mock the two dynamic-import seams
// dispatchCiWorkflow uses so this is asserted without a real GitHub API call.
const mockCreateWorkflowDispatch = vi.fn(async () => ({}) as unknown);
const mockGetOctokit = vi.fn(async () => ({
  rest: { actions: { createWorkflowDispatch: mockCreateWorkflowDispatch } },
}));
const mockGitOriginUrl = vi.fn(
  async (_dir: string) => "https://github.com/Papercusp/papercup.git",
);

vi.mock("@papercusp/operator-core/lib/cupboard/resolve-repo-coords", () => ({
  gitOriginUrl: (dir: string) => mockGitOriginUrl(dir),
  parseGithubRemote: (url: string) => {
    const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
    return m ? { owner: m[1], repo: m[2] } : null;
  },
}));
vi.mock("@papercusp/operator-core/lib/identity/octokit-client", () => ({
  getOctokit: () => mockGetOctokit(),
}));

// WI-36238: `escalate` dynamic-imports these two seams. Mocking them lets the
// REAL dep run without a database, so the coupling test at the bottom of this
// file asserts against the record the gate actually emits.
const openEscalationCalls: {
  identity: Record<string, unknown>;
  input: Record<string, unknown>;
}[] = [];
// WI-39686: the open-row set the mocked `listEscalations` returns, and the
// resolve calls the sweep makes. Both DEFAULT to today's behaviour (no open
// rows, resolves unobserved) so every pre-existing test in this file is
// unaffected; the sweep-scoping tests below populate them per-case.
let openEscalationRows: Record<string, unknown>[] = [];
const resolveEscalationCalls: Record<string, unknown>[] = [];
vi.mock(
  "@papercusp/operator-core/lib/agent-tools/coordination/escalations",
  () => ({
    openEscalation: async (
      identity: Record<string, unknown>,
      input: Record<string, unknown>,
    ) => {
      openEscalationCalls.push({ identity, input });
    },
    listEscalations: async () => openEscalationRows,
    resolveEscalation: async (input: Record<string, unknown>) => {
      resolveEscalationCalls.push(input);
    },
    resolveEscalationsBatch: async () => ({ resolved: 0 }),
  }),
);
vi.mock("@papercusp/operator-core/lib/attention-notify", () => ({
  notifyAttention: async () => {},
}));

// EI-20339710858167842: this file asserts the checkpoint's OWN concurrency profile. An outer
// affected-tests scheduler legitimately constrains this Vitest process with VITEST_MAX_FORKS=1;
// letting that ambient allocation leak into buildGreenCheckpointEnv makes the co-execution
// contract tests fail only when this file shares a scheduler lane, then pass on the serial retry.
// Clear the runner allocation for this fixture and restore it after the file so the assertions
// measure committed gate defaults regardless of how the containing test process was scheduled.
const inheritedVitestMaxForks = process.env.VITEST_MAX_FORKS;
const inheritedVitestMaxThreads = process.env.VITEST_MAX_THREADS;
beforeAll(() => {
  delete process.env.VITEST_MAX_FORKS;
  delete process.env.VITEST_MAX_THREADS;
});
afterAll(() => {
  if (inheritedVitestMaxForks === undefined)
    delete process.env.VITEST_MAX_FORKS;
  else process.env.VITEST_MAX_FORKS = inheritedVitestMaxForks;
  if (inheritedVitestMaxThreads === undefined)
    delete process.env.VITEST_MAX_THREADS;
  else process.env.VITEST_MAX_THREADS = inheritedVitestMaxThreads;
});

interface ExecResp {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** A fake exec returning programmed results in call order, recording every call. */
function makeExec(responses: ExecResp[]) {
  const calls: Array<{
    cmd: string;
    args: string[];
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean };
  }> = [];
  let i = 0;
  const exec: CheckpointExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = responses[i++] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

// Redirect the per-run checkpoint suite-log dir to a throwaway temp dir so this
// real-deps test (which exercises runGreen's writeFileSync log-persist) NEVER
// pollutes the real ~/.papercusp/checkpoint-logs/ — fixture logs landing there
// masquerade as real checkpoint failures + mislead freeze diagnosis (2026-06-20).
const tmpLogDir = mkdtempSync(join(tmpdir(), "green-cp-log-"));
afterAll(() => rmSync(tmpLogDir, { recursive: true, force: true }));

// EI-8744: runGreen probes the checkpoint tree for a root package.json (the
// nothing-to-gate short-circuit) with a REAL existsSync — a bare fake path like
// cpTree now green-short-circuits before the injected exec is ever consulted,
// which is the opposite of what these wiring tests assert. Give them a real
// tree with a package.json so the full pipeline runs.
const cpTree = mkdtempSync(join(tmpdir(), "green-cp-tree-"));
writeFileSync(
  join(cpTree, "package.json"),
  JSON.stringify({ name: "cp-fixture" }),
);

// EI-20234934941780220: the desktop package is a git submodule, not a root npm workspace. Keep
// a minimal standalone fixture here so rescue tests assert the cwd/argv contract without running
// the real desktop suite or depending on the checkout's current submodule contents.
const standaloneTree = mkdtempSync(join(tmpdir(), "green-cp-standalone-tree-"));
mkdirSync(join(standaloneTree, "papercusp-desktop"), { recursive: true });
writeFileSync(
  join(standaloneTree, "papercusp-desktop", "package.json"),
  JSON.stringify({
    name: "@papercusp/desktop",
    scripts: { test: "vitest run" },
  }),
);

// WI-7255 — DO NOT materialise the `failingTests` paths (lib/foo.test.ts,
// lib/llm-testing/__tests__/runner-aggregate.test.ts, ...) inside cpTree. Their ABSENCE is
// load-bearing, and this comment exists because it was already done once and had to be
// reverted.
//
// The two cases below asserting `failingTests` CONTAINS the failing file are the recurrence
// guard for WI-7239: `validateFailingTestPaths` once DROPPED any FILE-shaped entry that did
// not resolve under `treeDir`, which was unsound — vitest reports test files
// WORKSPACE-relative while treeDir is the repo ROOT, so the join never resolves for a genuine
// failure and every real entry was stripped (emptying the input to applyTestQuarantine, so
// `allFailuresQuarantined` could never fire). It is advisory now: report, drop nothing.
//
// A cpTree fixture at the tree-root-relative path makes exists(join(treeDir, entry)) TRUE,
// which SILENTLY DISARMS that guard — re-introduce the drop and these cases stay green,
// because the fixture satisfies the very check whose unsoundness they exist to catch. That is
// exactly what happened on 2026-08-03 (WI-7244 -> WI-7255): the assertions were failing
// because they were CORRECT, and were "fixed" by feeding the broken impl what it wanted.
//
// If these go red again, fix the resolution logic — never the fixtures.
afterAll(() => rmSync(cpTree, { recursive: true, force: true }));
afterAll(() => rmSync(standaloneTree, { recursive: true, force: true }));

const typecheckTree = mkdtempSync(join(tmpdir(), "green-cp-typecheck-tree-"));
writeFileSync(
  join(typecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-typecheck-fixture",
    scripts: { "lint:tsc": "node scripts/lint-tsc.mjs" },
  }),
);
afterAll(() => rmSync(typecheckTree, { recursive: true, force: true }));

// WI-6841: a candidate tree that provides `lint:tsc:papercusp-libs` but not `lint:tsc` —
// isolates the libs/papercusp typecheck leg's wiring (position in the sequence, env, failure
// signature) from the operator-core typecheck leg's, the same way typecheckTree isolates that
// one from cpTree's no-optional-legs baseline. The eight libs/papercusp gates were executed by
// NOTHING before this leg existed; these tests are what stop it silently un-gating again.
const libsTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-libs-typecheck-tree-"),
);
writeFileSync(
  join(libsTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-libs-typecheck-fixture",
    scripts: {
      "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
    },
  }),
);
afterAll(() => rmSync(libsTypecheckTree, { recursive: true, force: true }));

// WI-7155 / EI-19376779013716004: a candidate tree that provides `lint:tsc:workspaces` but no
// other typecheck script — isolates the superproject fan-out leg's wiring from its two siblings,
// exactly as libsTypecheckTree isolates the libs/papercusp one. apps/*, packages/* and
// libs/generic/* were typechecked by NOTHING before this leg; these tests are what stop that
// silently returning.
const workspacesTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-workspaces-typecheck-tree-"),
);
writeFileSync(
  join(workspacesTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-workspaces-typecheck-fixture",
    scripts: { "lint:tsc:workspaces": "node scripts/lint-tsc-workspaces.mjs" },
  }),
);
afterAll(() =>
  rmSync(workspacesTypecheckTree, { recursive: true, force: true }),
);

// WI-38284: root `scripts/*.ts` is its own no-emit typecheck project. Keep a candidate
// fixture that opts into only that script so these tests exercise the real optional-leg
// discovery and failure path without coupling them to the other typecheck fixtures.
const scriptsTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-scripts-typecheck-tree-"),
);
writeFileSync(
  join(scriptsTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-scripts-typecheck-fixture",
    scripts: { "lint:tsc:scripts": "node scripts/lint-tsc-scripts.mjs" },
  }),
);
afterAll(() => rmSync(scriptsTypecheckTree, { recursive: true, force: true }));

// EI-485: a candidate tree that provides `lint:migrations` but not `lint:tsc` — isolates
// the migrations-lint leg's wiring (position in the sequence, env, failure signature)
// from the typecheck leg's, the same way typecheckTree isolates typecheck from cpTree's
// no-optional-legs baseline.
const migrationsLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-migrations-lint-tree-"),
);
writeFileSync(
  join(migrationsLintTree, "package.json"),
  JSON.stringify({
    name: "cp-migrations-lint-fixture",
    scripts: { "lint:migrations": "node scripts/lint-migrations.mjs" },
  }),
);
afterAll(() => rmSync(migrationsLintTree, { recursive: true, force: true }));

// EI-18218408212070282: a candidate tree that provides `lint:design-primitives` but not
// `lint:tsc`/`lint:migrations` — isolates the design-primitives leg's wiring (position in
// the sequence, env, failure signature) the same way the trees above isolate their own legs.
const designPrimitivesLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-design-primitives-lint-tree-"),
);
writeFileSync(
  join(designPrimitivesLintTree, "package.json"),
  JSON.stringify({
    name: "cp-design-primitives-lint-fixture",
    scripts: {
      "lint:design-primitives":
        "node scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts",
    },
  }),
);
afterAll(() =>
  rmSync(designPrimitivesLintTree, { recursive: true, force: true }),
);

// EI-18147177863084708: a candidate tree that provides all 3 identity-leak lints
// (check-no-owner-name-tags.mjs / check-no-box-identity.mjs / check-no-identity-literals.mjs)
// but not `lint:tsc`/`lint:migrations`/`lint:design-primitives` — isolates the identity-leak
// leg's wiring (position in the sequence, all-3-run-unconditionally, combined failure
// signature) the same way the trees above isolate their own legs.
const identityLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-identity-lint-tree-"),
);
writeFileSync(
  join(identityLintTree, "package.json"),
  JSON.stringify({
    name: "cp-identity-lint-fixture",
    scripts: {
      "lint:no-owner-name-tags": "node scripts/check-no-owner-name-tags.mjs",
      "lint:no-box-identity": "node scripts/check-no-box-identity.mjs",
      "lint:no-identity-literals":
        "node scripts/check-no-identity-literals.mjs",
    },
  }),
);
afterAll(() => rmSync(identityLintTree, { recursive: true, force: true }));

// WI-38185: a candidate tree providing TWO independent cheap legs (design-primitives and
// no-control-bytes) so a red in the FIRST can be shown not to hide a red in the SECOND.
const twoCheapLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-two-cheap-lint-tree-"),
);
writeFileSync(
  join(twoCheapLintTree, "package.json"),
  JSON.stringify({
    name: "cp-two-cheap-lint-fixture",
    scripts: {
      "lint:design-primitives": "node scripts/check-design-primitives.mjs",
      "lint:no-control-bytes": "node scripts/check-no-control-bytes.mjs",
    },
  }),
);
afterAll(() => rmSync(twoCheapLintTree, { recursive: true, force: true }));

// WI-6056: a candidate tree whose package.json EXISTS but is corrupt/truncated — the
// freshly-materialised checkpoint tree can genuinely land in this state (a partial copy /
// interrupted write), and it must NOT read the same as "this hive opts out of every leg".
const corruptPkgJsonTree = mkdtempSync(
  join(tmpdir(), "green-cp-corrupt-pkgjson-tree-"),
);
writeFileSync(
  join(corruptPkgJsonTree, "package.json"),
  '{ "name": "truncated-mid-wri',
);
afterAll(() => rmSync(corruptPkgJsonTree, { recursive: true, force: true }));

const cfg: ReleaseConfig = releaseConfig({
  integrationRoot: "/int",
  releaseRoot: "/int",
  checkpointRoot: cpTree,
  releaseRef: "ready",
  integrationBranch: "main",
  checkpointLogDir: tmpLogDir,
});
const [GREEN_CMD0, ...GREEN_ARGS] = cfg.greenCmd.split(" ");

describe("realCheckpointDeps.runChangedFileTypecheckPreflight — WI-38422", () => {
  const preflightCfg: ReleaseConfig = { ...cfg, checkpointRoot: typecheckTree };

  it("runs the existing lint:tsc gate with the exact committed diff, release env, and sequential-leg heap", async () => {
    const { exec, calls } = makeExec([
      {
        code: 0,
        stdout:
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean\n",
      },
    ]);
    const deps = realCheckpointDeps(preflightCfg, exec, "preflight-run-id");

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "docs/note.md",
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toMatchObject({ status: "passed", failingSignatures: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "npm",
      opts: {
        cwd: typecheckTree,
        allowNonZero: true,
        heavy: true,
      },
    });
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[0].opts?.env?.PC_HEAVY_RELEASE_GATE).toBe("1");
    expect(calls[0].opts?.env?.NODE_OPTIONS).toContain(
      `--max-old-space-size=${GREEN_CHECKPOINT_POST_SUITE_HEAP_MB}`,
    );
    expect(calls[0].args.slice(0, 3)).toEqual(["run", "lint:tsc", "--"]);
    const responseArg = calls[0].args[3];
    expect(responseArg).toMatch(/^--files-from=/);
    expect(responseArg.startsWith(`--files-from=${tmpdir()}/`)).toBe(true);
    expect(responseArg).toContain("green-checkpoint-typecheck-files-");
  });

  it("keeps a large changed-file set out of argv while preserving the exact response-file set", async () => {
    const files = Array.from(
      { length: 50_000 },
      (_, index) => `packages/operator-core/lib/generated-${index}.ts`,
    );
    let responseArg: string | undefined;
    let responseFiles: string[] | undefined;
    const exec: CheckpointExec = async (_cmd, args) => {
      responseArg = args.find((arg) => arg.startsWith("--files-from="));
      expect(responseArg).toBeDefined();
      responseFiles = JSON.parse(
        readFileSync(responseArg!.slice("--files-from=".length), "utf8"),
      ) as string[];
      return {
        code: 0,
        stdout:
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean\n",
        stderr: "",
      };
    };
    const deps = realCheckpointDeps(preflightCfg, exec, "large-preflight-run");

    const result = await deps.runChangedFileTypecheckPreflight?.(files);

    expect(result).toMatchObject({ status: "passed", failingSignatures: [] });
    expect(responseArg).toBeDefined();
    expect(responseArg!.length).toBeLessThan(256);
    expect(responseFiles).toEqual(files);
  });

  it("maps a completed non-zero scoped lint verdict to the stable lint:tsc failure signature", async () => {
    const { exec } = makeExec([
      {
        code: 1,
        stdout:
          "packages/operator-core/lib/a.ts(1,14): error TS2322: Type string is not assignable to number\n" +
          "LINT_TSC_RESULT label=operator-core scope=files exit=1 status=regressed\n",
      },
    ]);
    const deps = realCheckpointDeps(preflightCfg, exec);

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toMatchObject({
      status: "failed",
      failingSignatures: ["lint:tsc"],
    });
    expect(result?.summary).toContain("TS2322");
    expect(result?.summary).toContain("status=regressed");
  });

  it("reports a subject hive without lint:tsc as skipped and shells nothing", async () => {
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(cfg, exec);

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toEqual({
      status: "skipped",
      summary: "candidate provides no lint:tsc script",
    });
    expect(calls).toEqual([]);
  });
});

describe("EI-21007486441633274: real frozen-repair ancestry reconciliation", () => {
  it("publishes an unchanged-tree staging join for an already-represented local repair head", async () => {
    const root = mkdtempSync(join(tmpdir(), "green-cp-repair-bridge-"));
    const remote = join(root, "origin.git");
    const repo = join(root, "work");
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      if (result.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
      }
      return result.stdout.trim();
    };
    const priorWorkspace = process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
    const priorHarness = process.env.PAPERCUSP_GATE_VERDICT_HARNESS;

    try {
      git(root, "init", "--bare", "-q", remote);
      git(repo, "init", "-q", "-b", "staging");
      git(repo, "config", "user.email", "fixture@example.invalid");
      git(repo, "config", "user.name", "fixture");
      writeFileSync(join(repo, "a"), "1");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "ready");
      const ready = git(repo, "rev-parse", "HEAD");

      git(repo, "switch", "-qc", "repair");
      writeFileSync(join(repo, "b"), "broken");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "frozen");
      const frozen = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "b"), "fixed");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "verified repair");
      const repairHead = git(repo, "rev-parse", "HEAD");

      git(repo, "switch", "-q", "staging");
      writeFileSync(join(repo, "b"), "fixed");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "patch-equivalent staging repair");
      writeFileSync(join(repo, "c"), "later staging work");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "later staging work");
      const stagingTip = git(repo, "rev-parse", "HEAD");
      const stagingTree = git(repo, "rev-parse", `${stagingTip}^{tree}`);
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-qu", "origin", "staging");

      process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = "fixture-workspace";
      process.env.PAPERCUSP_GATE_VERDICT_HARNESS = "fixture-harness";
      const deps = realCheckpointDeps({
        ...cfg,
        integrationRoot: repo,
        releaseRoot: repo,
        checkpointRoot: repo,
        integrationBranch: "staging",
      });
      const joined = await deps.reconcileFrozenRepairIntoStaging?.({
        schemaVersion: 2,
        phase: "ready-to-promote",
        candidate: frozen,
        base: ready,
        repairHead,
        worktreePath: join(root, "repair-worktree"),
        attempts: 1,
        openedAtMs: Date.now() - 1_000,
        updatedAtMs: Date.now(),
        fixerSpawnId: "fixture-fixer",
        failingTests: [],
      });

      expect(joined).toMatch(/^[0-9a-f]{40}$/);
      expect(git(repo, "rev-parse", "staging")).toBe(joined);
      expect(git(repo, "rev-parse", `${joined}^{tree}`)).toBe(stagingTree);
      git(repo, "merge-base", "--is-ancestor", stagingTip, joined!);
      git(repo, "merge-base", "--is-ancestor", repairHead, joined!);
      expect(git(repo, "ls-remote", "origin", "refs/heads/staging")).toBe(
        `${joined}\trefs/heads/staging`,
      );
    } finally {
      if (priorWorkspace === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
      else process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = priorWorkspace;
      if (priorHarness === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_HARNESS;
      else process.env.PAPERCUSP_GATE_VERDICT_HARNESS = priorHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("WI-40231: frozen-repair worktree is submodule-complete", () => {
  it("populates submodule working trees so a fixer can reproduce the red it was sent to fix", async () => {
    const root = mkdtempSync(join(tmpdir(), "green-cp-repair-submodule-"));
    const subOrigin = join(root, "sub.git");
    const subWork = join(root, "sub-work");
    const repo = join(root, "work");
    // Submodule clones over a local path are refused by default since CVE-2022-39253.
    // Production submodule URLs are ssh, so this is a FIXTURE concession only — it lets
    // the local submodule clone at all and never weakens the assertions below.
    const allowFile = ["-c", "protocol.file.allow=always"];
    mkdirSync(repo);
    mkdirSync(subWork);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      if (result.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
      }
      return result.stdout.trim();
    };
    const priorWorkspace = process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
    const priorHarness = process.env.PAPERCUSP_GATE_VERDICT_HARNESS;
    const priorProtocol = process.env.GIT_ALLOW_PROTOCOL;

    try {
      // A submodule carrying a file the superproject reaches by RELATIVE path — the exact
      // shape (packages/operator-core/test/_org-test-db.ts -> ../../../libs/papercusp/...)
      // that node_modules resolution can never repair.
      // -b main so the bare repo's HEAD names the branch we push; without it the clone
      // lands on an unborn default branch and the submodule checkout fails.
      git(root, "init", "--bare", "-q", "-b", "main", subOrigin);
      git(subWork, "init", "-q", "-b", "main");
      git(subWork, "config", "user.email", "fixture@example.invalid");
      git(subWork, "config", "user.name", "fixture");
      writeFileSync(join(subWork, "raw-serializers.ts"), "export const x = 1;\n");
      git(subWork, "add", "-A");
      git(subWork, "commit", "-qm", "sub");
      git(subWork, "push", "-q", subOrigin, "main");

      git(repo, "init", "-q", "-b", "staging");
      git(repo, "config", "user.email", "fixture@example.invalid");
      git(repo, "config", "user.name", "fixture");
      writeFileSync(join(repo, "a"), "1");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "ready");
      const base = git(repo, "rev-parse", "HEAD");
      git(repo, ...allowFile, "submodule", "add", "-q", subOrigin, "libs/sub");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "add submodule");
      const repairHead = git(repo, "rev-parse", "HEAD");

      process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = "fixture-workspace";
      process.env.PAPERCUSP_GATE_VERDICT_HARNESS = "fixture-harness";
      // The subject's submodule clone is its own `git clone` subprocess and does NOT
      // inherit the superproject's local `protocol.file.allow`, so the fixture grants the
      // file transport through the environment the subject forwards. Real submodule URLs
      // are ssh and never take this path.
      process.env.GIT_ALLOW_PROTOCOL = "file:git:ssh:https";
      const deps = realCheckpointDeps({
        ...cfg,
        integrationRoot: repo,
        releaseRoot: repo,
        checkpointRoot: repo,
        integrationBranch: "staging",
      });

      const worktreePath = join(root, "repair-worktree");
      await deps.prepareFrozenRepairWorktree?.({
        schemaVersion: 2,
        phase: "awaiting-fixer",
        candidate: repairHead,
        base,
        repairHead,
        worktreePath,
        attempts: 1,
        openedAtMs: Date.now() - 1_000,
        updatedAtMs: Date.now(),
        fixerSpawnId: "fixture-fixer",
        failingTests: ["lint:tsc"],
      });

      // The superproject checkout itself (a plain `git worktree add` already does this).
      expect(existsSync(join(worktreePath, "a"))).toBe(true);

      // THE GUARD: the submodule WORKING TREE. `git worktree add` alone leaves this
      // absent, which made lint:tsc fail TS2307 "Cannot find module" in the repair tree
      // no matter what the fixer edited — three fixers were dispatched on candidate
      // 3a3e4587 and `repairHead` never advanced. Drop the submodule init from
      // prepareFrozenRepairWorktree and these two expectations fail.
      expect(existsSync(join(worktreePath, "libs", "sub", "raw-serializers.ts"))).toBe(
        true,
      );
      // git's own verdict: a leading '-' on any line means "not initialized".
      expect(git(worktreePath, "submodule", "status")).not.toMatch(/^-/m);
    } finally {
      if (priorWorkspace === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
      else process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = priorWorkspace;
      if (priorHarness === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_HARNESS;
      else process.env.PAPERCUSP_GATE_VERDICT_HARNESS = priorHarness;
      if (priorProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = priorProtocol;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("realCheckpointDeps.runGreen — real-path wiring (gap #10)", () => {
  it("detects the optional lint:tsc script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc")).toBe(false);
    expect(hasNpmScript(typecheckTree, "lint:tsc")).toBe(true);
  });

  it("wires an explicitly reserved ReleaseConfig into the real suite process environment", async () => {
    const reservedCfg: ReleaseConfig = {
      ...cfg,
      greenCheckpointCapacityMode: "reserved",
    };
    // suite green → marker grep has no match → SPA build green.
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(reservedCfg, exec).runGreen(
      cpTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls[0].opts?.env?.VITEST_MAX_FORKS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
    expect(calls[0].opts?.env?.VITEST_MAX_THREADS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
  });

  it("classifies a post-suite ENOSPC red before publishing failing-file evidence", async () => {
    const lowSpaceOutput =
      ">>> @papercusp/operator-core :: npm run test\n" +
      "Error: ENOSPC: no space left on device, open '/tmp/pcv/worker.json'\n" +
      "Error: ENOSPC: no space left on device, write '/tmp/pcv/reporter.json'\n";
    const healthy = {
      path: "/tmp",
      totalBytes: 7.3 * 1024 ** 4,
      freeBytes: 1_000 * 1024 ** 3,
      freePct: 0.2,
      totalInodes: 1_000_000,
      freeInodes: 500_000,
      freeInodesPct: 0.5,
    };
    const exhausted = {
      ...healthy,
      freeBytes: 0,
      freePct: 0,
    };
    let samples = 0;
    const { exec, calls } = makeExec([{ code: 1, stdout: lowSpaceOutput }]);
    const r = await realCheckpointDeps(
      cfg,
      exec,
      "disk-infra-run",
      undefined,
      undefined,
      async () => [samples++ === 0 ? healthy : exhausted],
    ).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(r.infraFault).toMatchObject({
      kind: "disk-space-exhausted",
      paths: ["/tmp"],
    });
    expect(r.infraFault?.note).toMatch(/must NOT be triaged/);
    expect(samples).toBe(2);
    // A red suite defers post-suite legs; disk attribution happens before any rescue path.
    expect(calls).toHaveLength(1);
  });

  it("threads a frozen repair proof group into the candidate suite without replacing the verifier run id", async () => {
    // suite green → marker grep has no match → SPA build green.
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec, "repair-verifier-run").runGreen(
      cpTree,
      "base-sha",
      {
        candidate: "c".repeat(40),
        affectedTestProofGroup: "initial-proof-run",
      },
    );

    expect(r.green).toBe(true);
    expect(calls[0].opts?.env?.PAPERCUSP_TEST_RUN_GROUP).toBe(
      "repair-verifier-run",
    );
    expect(calls[0].opts?.env?.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBe(
      "initial-proof-run",
    );
  });

  it("runs the Papercusp lint:tsc leg before the SPA build when the candidate provides it", async () => {
    // suite green → typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      typecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc"]);
    expect(calls[1].opts?.cwd).toBe(typecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("EI-203121: threads real-path run, tree, setup, dependency, and result identity into the verdict", async () => {
    const { exec } = makeExec([
      { code: 0 },
      { code: 0, stdout: "typecheck passed" },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec, "run-identity-42").runGreen(
      typecheckTree,
      "base-sha",
      {
        candidate: "c".repeat(40),
        headAtStart: "h".repeat(40),
        setup: {
          identity: "setup-release-checkout:candidate",
          output: "setup copied dependencies",
        },
      },
    );

    expect(r.green).toBe(true);
    expect(r.postSuiteLegs?.length).toBeGreaterThan(0);
    const typecheck = r.postSuiteLegs?.find((leg) => leg.id === "lint:tsc");
    expect(typecheck?.executionIdentity).toMatchObject({
      runId: "run-identity-42",
      candidate: "c".repeat(40),
      treeDir: typecheckTree,
      cwd: typecheckTree,
      headAtStart: "h".repeat(40),
      setup: {
        identity: "setup-release-checkout:candidate",
        output: "setup copied dependencies",
      },
      result: {
        status: "passed",
        exit: "completed",
        exitCode: 0,
        output: "typecheck passed",
      },
    });
    expect(typecheck?.executionIdentity?.dependencies.nodeModules).toMatchObject({
      hash: null,
      inode: null,
      source: "missing",
    });
  });

  it("holds the candidate when lint:tsc reports a type regression and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(typecheckTree, null);

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc");
    expect(r.summary).toContain("TYPECHECK FAILED");
    expect(calls).toHaveLength(2);
  });

  it("EI-19995300915348764: publishes GATE_HELD_BY before returning a real red", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([
      { code: 0 },
      { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(typecheckTree, null);

    expect(r.green).toBe(false);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const body = readFileSync(join(tmpLogDir, writtenLog), "utf8");
    // This line is written by realCheckpointDeps.runGreen itself, before the orchestration
    // layer can append its richer verdict block or be interrupted by a watchdog.
    const heldByLine = body
      .split("\n")
      .find((line) => line.startsWith("GATE_HELD_BY count="));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain("count=1");
    expect(heldByLine).toContain('entries=["lint:tsc"]');
  });

  it("EI-20689175600678908: strips control bytes before persisting the checkpoint log", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([
      {
        code: 0,
        stdout: "suite output before\0after\u0007\n",
      },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(true);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const bytes = readFileSync(join(tmpLogDir, writtenLog));
    expect(bytes.includes(0)).toBe(false);
    expect(bytes.includes(7)).toBe(false);
    expect(bytes.toString("utf8")).toContain("suite output beforeafter");
  });

  it("EI-20336874238055183: GATE_HELD_BY uses the final authoritative break set, not stale retry rows", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const staleRowsThenAuthoritativeEmptyFiles = [
      ">>> @papercusp/operator-core :: npm run test",
      " FAIL  lib/stale-first.test.ts > stale retry output",
      " ❯ lib/stale-second.test.ts (1 test | 1 failed) 10ms",
      "",
      "1 non-quarantined task(s) failed:",
      "  - @papercusp/web :: test:el-suite",
      "",
      "0 failing test file(s) — the per-FILE break set (the failed=1 above counts TASKS, not files):",
      "1 failed task(s) could NOT be attributed to files — their failures are REAL but unnamed here; do not read the list above as complete:",
      "  - @papercusp/web :: test:el-suite (no-file-rows)",
      'AFFECTED_TESTS_FAILING_FILES run=fixture-20336874238055183 coverage=unattributed files=[] unattributed=[{"task":"@papercusp/web :: test:el-suite","reason":"no-file-rows"}] transformCulprits=[]',
    ].join("\n");
    const { exec } = makeExec([
      { code: 1, stdout: staleRowsThenAuthoritativeEmptyFiles },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(r.failingTests).toEqual([
      "@papercusp/web",
      "@papercusp/web :: test:el-suite",
    ]);
    expect(r.failingTests).not.toContain("lib/stale-first.test.ts");
    expect(r.failingTests).not.toContain("lib/stale-second.test.ts");

    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const body = readFileSync(join(tmpLogDir, writtenLog), "utf8");
    const heldByLine = body
      .split("\n")
      .find((line) => line.startsWith("GATE_HELD_BY count="));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain(
      'entries=["@papercusp/web","@papercusp/web :: test:el-suite"]',
    );
    expect(heldByLine).not.toContain("stale-first.test.ts");
    expect(heldByLine).not.toContain("stale-second.test.ts");
  });

  // WI-6841: `lint:tsc` resolves to packages/operator-core alone, so the EIGHT typecheck
  // gates libs/papercusp packages had earned (libs/db, file-claim, blueprint-distribution,
  // harness, harness/docs-viewer, locks, gitnexus-bridge at a strict zero + orchestrator on a
  // per-file baseline) ran under NO automation — they existed, passed by hand, and gated
  // nothing. Mirrors the lint:tsc wiring tests above; these are the teeth.
  it("detects the optional lint:tsc:papercusp-libs script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:papercusp-libs")).toBe(false);
    expect(hasNpmScript(libsTypecheckTree, "lint:tsc:papercusp-libs")).toBe(
      true,
    );
  });

  it("runs the libs/papercusp typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → libs typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      libsTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
    expect(calls[1].opts?.cwd).toBe(libsTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when a libs/papercusp package regresses and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ libs/papercusp/packages/locks\nsrc/claim.ts(12,3): error TS2322: Type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      libsTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:papercusp-libs");
    expect(r.summary).toContain("LIBS/PAPERCUSP TYPECHECK FAILED");
    // The package that regressed must be NAMED in the held verdict — a gate that says only
    // "typecheck failed" across 8 packages costs the reader the diagnosis.
    expect(r.summary).toContain("libs/papercusp/packages/locks");
    // Short-circuits: no marker grep, no SPA build.
    expect(calls).toHaveLength(2);
  });

  it("runs the libs/papercusp typecheck leg AFTER operator-core lint:tsc when a candidate provides both", async () => {
    // Both legs present: the order is asserted, not incidental — operator-core imports
    // libs/papercusp, so its red is the more diagnostic one to surface first.
    const bothTree = mkdtempSync(
      join(tmpdir(), "green-cp-both-typecheck-tree-"),
    );
    writeFileSync(
      join(bothTree, "package.json"),
      JSON.stringify({
        name: "cp-both-typecheck-fixture",
        scripts: {
          "lint:tsc": "node scripts/lint-tsc.mjs",
          "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
        },
      }),
    );
    try {
      const { exec, calls } = makeExec([
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(bothTree, null);

      expect(r.green).toBe(true);
      expect(calls[1].args).toEqual(["run", "lint:tsc"]);
      expect(calls[2].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
    } finally {
      rmSync(bothTree, { recursive: true, force: true });
    }
  });

  // WI-7155 / EI-19376779013716004: the same phantom-gate shape a THIRD time, generalized.
  // `lint:tsc` covers operator-core and the leg above covers the libs/papercusp submodule,
  // which left the SUPERPROJECT roots (apps/*, packages/*, libs/generic/*) typechecked by
  // NOTHING — `test:affected` is type-blind by design, so a regression there sat committed
  // indefinitely. Unlike its two siblings this leg DISCOVERS its packages, so the next one to
  // land is gated without anyone remembering. These are its teeth.
  it("detects the optional lint:tsc:workspaces script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:workspaces")).toBe(false);
    expect(hasNpmScript(workspacesTypecheckTree, "lint:tsc:workspaces")).toBe(
      true,
    );
  });

  it("runs the workspaces typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → workspaces typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      workspacesTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:workspaces"]);
    expect(calls[1].opts?.cwd).toBe(workspacesTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when a workspace package regresses and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ libs/generic/search-core\nsrc/rank.ts(9,1): error TS2345: Argument type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      workspacesTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:workspaces");
    expect(r.summary).toContain("WORKSPACE TYPECHECK FAILED");
    // The package that regressed must be NAMED in the held verdict — a gate that says only
    // "typecheck failed" across 8 packages costs the reader the diagnosis.
    expect(r.summary).toContain("libs/generic/search-core");
    // Short-circuits: no marker grep, no SPA build.
    expect(calls).toHaveLength(2);
  });

  it("runs the three typecheck legs in order: operator-core, then libs/papercusp, then workspaces", async () => {
    // Order is asserted, not incidental. operator-core imports libs/papercusp, so its red is
    // the more diagnostic one to surface first; the workspaces fan-out is the widest and
    // cheapest-to-diagnose, so it goes last of the three.
    const allTree = mkdtempSync(join(tmpdir(), "green-cp-all-typecheck-tree-"));
    writeFileSync(
      join(allTree, "package.json"),
      JSON.stringify({
        name: "cp-all-typecheck-fixture",
        scripts: {
          "lint:tsc": "node scripts/lint-tsc.mjs",
          "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
          "lint:tsc:workspaces": "node scripts/lint-tsc-workspaces.mjs",
        },
      }),
    );
    try {
      const { exec, calls } = makeExec([
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(allTree, null);

      expect(r.green).toBe(true);
      expect(calls[1].args).toEqual(["run", "lint:tsc"]);
      expect(calls[2].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
      expect(calls[3].args).toEqual(["run", "lint:tsc:workspaces"]);
    } finally {
      rmSync(allTree, { recursive: true, force: true });
    }
  });

  // WI-38284: root scripts are load-bearing TypeScript CLIs, but they sit outside every
  // package project. The dedicated leg must be discovered and run by the REAL checkpoint
  // dependency path, not merely exported in the post-suite helper.
  it("detects the optional lint:tsc:scripts script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:scripts")).toBe(false);
    expect(hasNpmScript(scriptsTypecheckTree, "lint:tsc:scripts")).toBe(true);
  });

  it("runs the root scripts typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → scripts typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      scriptsTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:scripts"]);
    expect(calls[1].opts?.cwd).toBe(scriptsTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when root scripts typecheck reports a regression and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout: "scripts/leak-ratchet.ts(42,7): error TS2322: Type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      scriptsTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:scripts");
    expect(r.summary).toContain("SCRIPTS TYPECHECK FAILED");
    expect(r.summary).toContain("scripts/leak-ratchet.ts");
    // The scripts leg is a soft failure, so later cheap legs may run; the expensive SPA
    // build must still not be reached on a red post-suite leg.
    expect(calls.some((c) => c.args.includes("build"))).toBe(false);
  });

  // EI-485: lint:migrations' PG-backed unreserved-number check was never wired into any
  // automated gate (its 3 pure-fs checks got wired into the vitest suite itself,
  // lint-migrations.test.ts, EI-6843, so they already rode test:affected — only the
  // PG-backed leg was still manual-only). Mirrors the lint:tsc wiring tests above.
  it("detects the optional lint:migrations script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:migrations")).toBe(false);
    expect(hasNpmScript(migrationsLintTree, "lint:migrations")).toBe(true);
  });

  it("runs lint:migrations after a green suite, before the SPA build, when the candidate provides it", async () => {
    // suite green → lint:migrations green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      migrationsLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:migrations"]);
    expect(calls[1].opts?.cwd).toBe(migrationsLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when lint:migrations reports a violation and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ migration number(s) ≥494 on disk without a reservation row (use db:next-migration): 620",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      migrationsLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:migrations");
    expect(r.summary).toContain("MIGRATION LINT FAILED");
    expect(calls).toHaveLength(2); // build NOT attempted — held before the SPA build leg
  });

  // EI-18218408212070282: design-primitives.test.ts et al. are GLOBAL source-scanning
  // lints — `test:affected` only runs them when @papercusp/web happens to be in the
  // candidate diff's affected set, so a real violation elsewhere in the tree could
  // silently ride an unrelated candidate's diff into the green pin. This leg must run
  // UNCONDITIONALLY (never gated by the affected set) so "green" reflects the whole tree.
  it("detects the optional identity-leak lint scripts without requiring them from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:no-owner-name-tags")).toBe(false);
    expect(hasNpmScript(cpTree, "lint:no-box-identity")).toBe(false);
    expect(hasNpmScript(cpTree, "lint:no-identity-literals")).toBe(false);
    expect(hasNpmScript(identityLintTree, "lint:no-owner-name-tags")).toBe(
      true,
    );
    expect(hasNpmScript(identityLintTree, "lint:no-box-identity")).toBe(true);
    expect(hasNpmScript(identityLintTree, "lint:no-identity-literals")).toBe(
      true,
    );
  });

  it("runs all 3 identity-leak lints after a green suite, before the SPA build, when the candidate provides them", async () => {
    // suite green → all 3 identity lints green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      identityLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls[1].args).toEqual(["run", "lint:no-owner-name-tags"]);
    expect(calls[2].args).toEqual(["run", "lint:no-box-identity"]);
    expect(calls[3].args).toEqual(["run", "lint:no-identity-literals"]);
    expect(calls[1].opts?.cwd).toBe(identityLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[4].cmd).toBe("git"); // conflict-marker grep
    expect(calls[5].args).toContain("build");
  });

  it("EI-18147177863084708: reports EVERY failing identity-leak lint together (not just the first) and holds before the SPA build", async () => {
    // owner-name-tags FAILS, box-identity FAILS, identity-literals passes — unlike
    // release-local.sh's `&&`-chain, all 3 must run and every failure must be visible
    // in one verdict instead of whack-a-mole across builds.
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "FOUND: [owner:Jane 2026-07-20] in packages/operator-core/lib/foo.ts",
      },
      { code: 1, stdout: "FOUND: /home/jdoe/ in some.service" },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      identityLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:identity-leak");
    expect(r.summary).toContain("OWNER-NAME TAG LINT FAILED");
    expect(r.summary).toContain("BOX-IDENTITY PATH LINT FAILED");
    expect(calls).toHaveLength(4); // all 3 lints ran (unconditional) — build NOT attempted
  });

  // WI-6056: hasNpmScript's bare `catch { return false }` used to conflate "this hive
  // legitimately has no such script" with "package.json could not be read/parsed" — a
  // corrupt/partial candidate tree (a real, reachable state: it is freshly materialised
  // on every checkpoint run) would silently skip every optional leg and still report
  // green. checkNpmScript's 'unreadable' result must instead fail the leg loudly.
  // WI-38185: the leg chain used to halt on the FIRST failing lint, so one ~55min gate run
  // could report at most ONE cheap red while every later leg recorded "not run" — measured
  // 2026-08-12 with FOUR cheap legs red at once, which would have needed >=4 sequential
  // cycles just to discover. The cheap legs must now all run and all report, exactly as the
  // identity-leak leg already does for its own three sub-lints.
  it("WI-38185: a failing cheap lint does NOT hide the next one — both run, both are named, build still skipped", async () => {
    // suite green → design-primitives FAILS → no-control-bytes FAILS (must still run).
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout: "design-primitives violation in apps/operator/app/foo.tsx",
      },
      {
        code: 1,
        stdout: "control byte U+0007 in packages/operator-core/lib/bar.ts",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      twoCheapLintTree,
      "base-sha",
    );

    expect(r.green).toBe(false);
    // BOTH legs ran — the second is the one that used to be skipped as "not run".
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "run test:affected",
      "run lint:design-primitives",
      "run lint:no-control-bytes",
    ]);
    // BOTH are named in the one verdict, so the fleet can fix them in parallel.
    expect(r.failingTests).toContain("lint:design-primitives");
    expect(r.failingTests).toContain("lint:no-control-bytes");
    expect(r.summary).toContain("design-primitives violation");
    expect(r.summary).toContain("control byte");
    // …but the EXPENSIVE leg is still short-circuited: 3 calls, no SPA build.
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.args.includes("@papercusp/operator-vite"))).toBe(
      false,
    );
  });

  it("WI-6056: distinguishes a corrupt/unreadable package.json from a legitimate script-absent hive", () => {
    expect(checkNpmScript(corruptPkgJsonTree, "lint:tsc")).toBe("unreadable");
    expect(checkNpmScript(cpTree, "lint:tsc")).toBe("absent"); // valid package.json, just no such script
    expect(hasNpmScript(corruptPkgJsonTree, "lint:tsc")).toBe(false); // boolean wrapper still collapses to false
  });

  it("WI-6056: a corrupt/unreadable package.json fails the gate loudly instead of silently skipping every leg", async () => {
    // suite green → the very first post-suite leg (typecheck) finds package.json
    // unreadable and must halt the whole chain as a FAILURE, never a silent skip that
    // lets an untypechecked, unlinted, unbuilt candidate ride through as green.
    const { exec, calls } = makeExec([{ code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      corruptPkgJsonTree,
      "base-sha",
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("package.json-unreadable");
    expect(r.summary).toContain("PACKAGE.JSON UNREADABLE");
    expect(calls).toHaveLength(1); // only the suite ran — every post-suite leg short-circuited, none silently skipped as green
  });

  it("detects the optional lint:design-primitives script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:design-primitives")).toBe(false);
    expect(
      hasNpmScript(designPrimitivesLintTree, "lint:design-primitives"),
    ).toBe(true);
  });

  it("runs lint:design-primitives after a green suite, before the SPA build, when the candidate provides it", async () => {
    // suite green → lint:design-primitives green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      designPrimitivesLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:design-primitives"]);
    expect(calls[1].opts?.cwd).toBe(designPrimitivesLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when lint:design-primitives reports a violation and skips the SPA build — even though the diff never touched @papercusp/web", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "FAIL app/_lints/design-primitives.test.ts > blocks direct sky brand primitives",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      designPrimitivesLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:design-primitives");
    expect(r.summary).toContain("DESIGN PRIMITIVES LINT FAILED");
    expect(calls).toHaveLength(2); // build NOT attempted — held before the SPA build leg
  });

  it("green suite + clean tree + green build → green, with the stripped checkpoint env on the green command", async () => {
    // suite green → EI-1836 conflict-marker grep (code 1 = clean) → SPA build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    // (1) the green command ran in the checkpoint tree with the gate env wired.
    expect(calls[0].cmd).toBe(GREEN_CMD0);
    expect(calls[0].args).toEqual(GREEN_ARGS);
    expect(calls[0].opts?.cwd).toBe(cpTree);
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    // (2) EI-1836: the conflict-marker grep ran second, in the same tree, before the build.
    expect(calls).toHaveLength(3);
    expect(calls[1].cmd).toBe("git");
    expect(calls[1].args).toContain("grep");
    expect(calls[1].opts?.cwd).toBe(cpTree);
    // (3) the SPA build ran third, in the same tree (P-005 — build is part of green).
    expect(calls[2].cmd).toBe("npm");
    expect(calls[2].args).toContain("@papercusp/operator-vite");
    expect(calls[2].args).toContain("build");
    expect(calls[2].opts?.cwd).toBe(cpTree);
  });

  it("P-005: green suite but FAILED SPA build → NOT green, build break in the failure signature", async () => {
    // suite green → marker grep clean (code 1) → SPA build fails (code 1).
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 1 },
      { code: 1, stdout: "vite: bundle failed" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false); // the key wiring: a passing suite does NOT make a broken build green
    expect(calls).toHaveLength(3); // marker grep + build WAS attempted (suite was green, tree clean)
    expect(calls[2].cmd).toBe("npm"); // the build ran (grep was clean)
    expect(r.failingTests).toContain("@papercusp/operator-vite"); // dedup signature folds the build break in
    expect(r.summary).toContain("vite: bundle failed");
  });

  it("EI-1836: green suite but COMMITTED conflict markers → NOT green, build SKIPPED, marker NAMED in the signature", async () => {
    // suite green → marker grep FINDS one (code 0 + named stdout) → the cryptic SPA
    // build is SKIPPED, the marker folds into the @papercusp/operator-vite signature.
    const markerHit = `app/globals.css:26492:${"<".repeat(7)} Updated upstream`;
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0, stdout: markerHit },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(2); // suite + grep only — the build was NOT attempted
    expect(calls[1].cmd).toBe("git");
    expect(calls[1].args).toContain("grep");
    expect(r.failingTests).toContain("@papercusp/operator-vite"); // held + dedup like a build break
    expect(r.summary).toContain("globals.css"); // the root is NAMED, not a cryptic CssSyntaxError
  });

  it("red suite short-circuits — no SPA build attempted, suite failures in the signature", async () => {
    const { exec, calls } = makeExec([
      { code: 1, stdout: "FAIL lib/foo.test.ts\n" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(1); // build NOT attempted on a red suite
    expect(r.failingTests).toContain("lib/foo.test.ts");
  });

  it("no AFFECTED_BASE when base is null (full affected run)", async () => {
    // suite green → marker grep clean (code 1) → build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBeUndefined();
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
  });

  // load-flake-isolation-2026-06-23: the real-path wiring of the isolation re-run —
  // a red suite whose failing FILES (parsed from the affected-runner output) re-run
  // GREEN at single concurrency is a load-flake, so runGreen reports green + the suspects.
  const RED_OUTPUT =
    ">>> @papercusp/operator-core :: npm run test\n" +
    " FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates\n" +
    " ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms\n" +
    "2 non-quarantined task(s) failed.";

  it("load-flake: red suite, both failing files PASS in isolation → green + flakeSuspects, single-fork env", async () => {
    // call 0: green command (red suite). call 1: isolation re-run of file #1 (pass).
    // call 2: isolation re-run of file #2 (pass). No build runs (it only runs on a
    // suite that was green from the start: r.code === 0).
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true); // absorbed: both files passed in isolation
    expect(r.flakeSuspects).toEqual([
      "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
      "@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts",
    ]);
    // WI-6053: the suite + 2 isolation re-runs + the post-suite legs the absorption now
    // pays for (cpTree declares no lint scripts, so that is the conflict-marker grep and
    // the SPA build). This assertion previously read `toHaveLength(3)` with the comment
    // "no SPA build (the suite started red)" — it was encoding the defect: an absorbed
    // candidate reached `main` having never been built or typechecked.
    // WI-6956 adds call 3: the CONFIRMING co-execution re-run that now gates absorption.
    expect(calls).toHaveLength(6);
    expect(calls[4].cmd).toBe("git"); // conflict-marker grep
    expect(calls[5].args).toContain("build"); // the SPA build DID run post-absorption
    // WI-6956: the confirming re-run puts BOTH originally-failing files in ONE npm
    // invocation and — the whole point — does NOT pass --no-file-parallelism or pin the
    // fork/thread caps, so a shared-state concurrency defect reproduces here.
    expect(calls[3].cmd).toBe("npm");
    expect(calls[3].args.slice(0, 4)).toEqual([
      "run",
      "test",
      "--workspace",
      "@papercusp/operator-core",
    ]);
    expect(calls[3].args).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
    expect(calls[3].args).toContain(
      "lib/scout/scheduler-workspace-scope.test.ts",
    );
    expect(calls[3].args).not.toContain("--no-file-parallelism");
    // It inherits the GATE's own concurrency profile rather than the isolation run's
    // forced single fork — that is precisely what makes it a co-execution experiment.
    expect(calls[3].opts?.env?.VITEST_MAX_FORKS).not.toBe("1");
    expect(calls[3].opts?.env?.VITEST_MAX_THREADS).not.toBe("1");
    expect(calls[3].opts?.env?.VITEST_MAX_FORKS).toBe(
      calls[0].opts?.env?.VITEST_MAX_FORKS,
    );
    expect(calls[3].opts?.cwd).toBe(cpTree);
    expect(calls[3].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    // the isolation re-runs are `npm run test --workspace <ws> -- --no-file-parallelism <file>`
    // at SINGLE concurrency, in the checkpoint tree, with the stripped gate env.
    for (const c of calls.slice(1, 3)) {
      expect(c.cmd).toBe("npm");
      expect(c.args.slice(0, 4)).toEqual([
        "run",
        "test",
        "--workspace",
        "@papercusp/operator-core",
      ]);
      expect(c.args).toContain("--no-file-parallelism");
      expect(c.opts?.cwd).toBe(cpTree);
      expect(c.opts?.env?.VITEST_MAX_FORKS).toBe("1");
      expect(c.opts?.env?.VITEST_MAX_THREADS).toBe("1");
      expect(c.opts?.env?.GREEN_CHECKPOINT).toBe("1");
    }
    expect(calls[1].args).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
    expect(calls[2].args).toContain(
      "lib/scout/scheduler-workspace-scope.test.ts",
    );
  });

  // WI-6956 real-path recurrence guard: the concurrency-dependent class. Every file
  // passes ALONE (which is that class's DEFINING property, not evidence of flakiness),
  // but reproduces the moment they are re-run TOGETHER. Before the confirming pass this
  // exact shape absorbed to green and fast-forwarded `main` onto a broken tree.
  it("concurrency defect: files pass in isolation but REPRODUCE co-executed → stays NOT green", async () => {
    // call 0: red suite. calls 1-2: both files pass ALONE. call 3: the confirming
    // co-execution re-run FAILS — the failure reproduces when they run together.
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 0 },
      { code: 1, stdout: RED_OUTPUT },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(false); // NOT absorbed — this is a real defect, not box-weather
    expect(r.flakeSuspects ?? []).toEqual([]);
    // no post-suite leg runs: absorption never happened, so the suite is still what failed
    expect(calls).toHaveLength(4);
  });

  it("real break: red suite where ONE file still fails in isolation → stays NOT green", async () => {
    // call 0: red suite. call 1: file #1 re-run PASSES. call 2: file #2 re-run FAILS —
    // and because a DETERMINISTIC break re-fails on EVERY attempt, call 3 is file #2's
    // ISOLATION_RETRY_MAX(=1) retry, which must ALSO fail (isolation-retry-resilience /
    // EI-15849). Without scripting the retry result the exhausted-queue default ({code:0})
    // would let file #2's retry "pass", masking the real break as an absorbed load-flake.
    // EI-18104902318285612: that retry is gated behind a REAL ISOLATION_RETRY_DELAY_MS
    // (5s) setTimeout unless a sleep seam is injected — inject a no-op so this stays a
    // fast, hermetic unit test with zero host-load timing correlation.
    const { exec } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 1 },
      { code: 1 },
    ]);
    const r = await realCheckpointDeps(cfg, exec, undefined, {
      sleep: async () => {},
    }).runGreen(cpTree, null);

    expect(r.green).toBe(false); // a real deterministic break is NEVER hidden
    expect(r.flakeSuspects).toBeUndefined();
    // the suite signature still names the failing files (from the FAIL row) for the
    // release-fixer dedup — extractFailingTests reads `FAIL <file>` + `>>> <ws> FAILED`.
    expect(r.failingTests).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
  });

  it("fail-safe: an isolation re-run that THROWS leaves the gate red (no false green)", async () => {
    // A red suite with one parseable failing file; the isolation exec throws — on every
    // attempt, so this also drives the ISOLATION_RETRY_MAX(=1) retry path (EI-18104902318285612):
    // inject a no-op sleep so the retry's real ISOLATION_RETRY_DELAY_MS wait never fires.
    let i = 0;
    const throwingExec: CheckpointExec = async (cmd, _args, _opts) => {
      i++;
      if (i === 1)
        return {
          code: 1,
          stdout: ">>> @papercusp/x :: npm run test\n FAIL  lib/a.test.ts > c",
          stderr: "",
        };
      throw new Error("vitest spawn ENOMEM"); // the isolation re-run itself errors
    };
    const r = await realCheckpointDeps(cfg, throwingExec, undefined, {
      sleep: async () => {},
    }).runGreen(cpTree, null);
    expect(r.green).toBe(false);
    expect(r.flakeSuspects).toBeUndefined();
  });

  // WI-806: a vitest WORKER-POOL crash (a fork OOM under fleet load) emits NO per-file
  // FAIL lines, so the per-file isolation absorber finds nothing. The workspace re-run at
  // reduced concurrency decides load-crash flake vs real break.
  const CRASH_OUTPUT =
    ">>> @papercusp/operator-core :: npm run test\n" +
    "Error: [vitest-pool]: Worker forks emitted error.\n" +
    "Caused by: Error: Worker exited unexpectedly\n" +
    "npm error workspace @papercusp/operator-core@0.1.0\n" +
    "npm error command sh -c vitest run --passWithNoTests\n" +
    "1 non-quarantined task(s) failed.";

  it("worker-crash: pool crash, zero per-file FAILs, workspace re-run PASSES → green + flakeSuspect, single-fork env", async () => {
    // call 0: green command crashes the pool (no FAIL files). call 1: workspace re-run passes.
    const { exec, calls } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true); // absorbed: the crashed workspace passed on the re-run
    expect(r.flakeSuspects).toEqual([
      "@papercusp/operator-core (worker-pool crash)",
    ]);
    // WI-6053: the suite + 1 workspace re-run + the post-suite legs the absorption now pays
    // for (marker grep + SPA build). Previously `toHaveLength(2)` — the worker-crash
    // absorber had the identical hole, so a pool-crash candidate was also fast-forwarded
    // with its build and typecheck never run.
    expect(calls).toHaveLength(4);
    expect(calls[2].cmd).toBe("git"); // conflict-marker grep
    expect(calls[3].args).toContain("build"); // the SPA build DID run post-absorption
    const rerun = calls[1];
    expect(rerun.cmd).toBe("npm");
    // EI-19332206710686203 added the explicit per-test deadline (and the `--` separator this
    // argv previously had no need for) — see the RESCUE_TEST_TIMEOUT_MS guards below.
    expect(rerun.args).toEqual([
      "run",
      "test",
      "--workspace",
      "@papercusp/operator-core",
      "--",
      `--testTimeout=${RESCUE_TEST_TIMEOUT_MS}`,
    ]);
    expect(rerun.opts?.cwd).toBe(cpTree);
    expect(rerun.opts?.env?.VITEST_MAX_FORKS).toBe("1"); // reduced concurrency
    expect(rerun.opts?.env?.VITEST_MAX_THREADS).toBe("1");
    expect(rerun.opts?.env?.GREEN_CHECKPOINT).toBe("1");
  });

  it("worker-crash: re-run STILL crashes the pool → stays NOT green (never blanket-green a crash)", async () => {
    const { exec } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 1, stdout: CRASH_OUTPUT },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(r.green).toBe(false);
    expect(r.flakeSuspects).toBeUndefined();
  });

  it("worker-crash: re-run reveals a REAL failure → stays NOT green", async () => {
    const realFail =
      ">>> @papercusp/operator-core :: npm run test\n FAIL  lib/x.test.ts > c\nAssertionError";
    const { exec } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 1, stdout: realFail },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(r.green).toBe(false);
  });

  // ── WI-6053 ────────────────────────────────────────────────────────────────
  // Every post-suite leg (typecheck, the 3 identity lints, lint:migrations,
  // lint:design-primitives, the SPA build) used to be gated on `r.code === 0` while its
  // `*Ok` flag DEFAULTED TO `true`. So on a red suite they all skipped and stayed
  // "passed", and flake-absorption then set `green = true` without re-running or
  // re-checking any of them: an absorbed-green candidate was fast-forwarded to `main`
  // with five legs merely ASSUMED. That is how afdbda332b's operator-core type errors
  // reached `main` (2026-07-26). An absorbed-green candidate must clear the SAME bar as
  // a natively-green one — "never ran" must never render as "passed".
  describe("WI-6053: an absorbed-green candidate must still clear every post-suite leg", () => {
    it("red suite → absorbed → FAILING typecheck still comes out RED (the leg runs after absorption)", async () => {
      // call 0: suite red. calls 1-2: both files pass in isolation. call 3 (WI-6956):
      // the confirming co-execution re-run PASSES too → genuine weather → absorbed.
      // call 4: the typecheck leg — which previously never ran at all — FAILS.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        "base-sha",
      );

      expect(r.green).toBe(false); // the whole point: absorption is not a bypass
      expect(r.failingTests).toContain("lint:tsc");
      expect(r.summary).toContain("TYPECHECK FAILED");
      // the leg genuinely EXECUTED post-absorption (not merely assumed), in the
      // candidate tree, with the stripped gate env.
      expect(calls).toHaveLength(5);
      expect(calls[4].cmd).toBe("npm");
      expect(calls[4].args).toEqual(["run", "lint:tsc"]);
      expect(calls[4].opts?.cwd).toBe(typecheckTree);
      expect(calls[4].opts?.env?.GREEN_CHECKPOINT).toBe("1");
      // ...and the SPA build is still skipped behind the failing leg.
    });

    it("the post-absorption red is attributed to the LEG, not to the absorbed flake files (else the tip re-triage clears it as STALE)", async () => {
      // Compounding hazard: runGreen's `failingFiles` drives the stale-candidate
      // re-triage (green-checkpoint.ts :2043) — it re-runs those files at tip and, if
      // they pass, declares the red STALE and re-fires green. The absorbed files pass
      // BY DEFINITION (that is what absorption proved), so leaking them here would hand
      // the typecheck red a second false-green path straight to `main`.
      const { exec } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 }, // WI-6956: confirming co-execution re-run passes → absorbed
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        null,
      );

      expect(r.green).toBe(false);
      expect(r.failingFiles ?? []).toEqual([]); // no test file is failing — the LEG is
      expect(r.failingTests).toEqual(["lint:tsc"]);
      expect(r.failingTests).not.toContain(
        "lib/llm-testing/__tests__/runner-aggregate.test.ts",
      );
    });

    it("red suite → absorbed → all legs PASS → green, with the legs actually run and the flake suspects preserved", async () => {
      // Guards the opposite failure: the fix must not turn every absorbed candidate red,
      // and must not disable flake absorption (it exists for real 8-fork load flakes).
      // call 0: red suite. 1-2: isolation passes. 3 (WI-6956): confirming co-execution
      // re-run passes → absorbed. 4: lint:tsc green. 5: conflict-marker grep clean
      // (code 1). 6: SPA build green.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        "base-sha",
      );

      expect(r.green).toBe(true);
      expect(r.flakeSuspects).toEqual([
        "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
        "@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts",
      ]);
      expect(calls).toHaveLength(7);
      expect(calls[4].args).toEqual(["run", "lint:tsc"]);
      expect(calls[5].cmd).toBe("git"); // marker grep
      expect(calls[6].args).toContain("build"); // the SPA build DID run
    });

    it("red suite → absorbed → FAILING SPA build still comes out RED", async () => {
      // The build is the leg the original comment explicitly assumed safe ("the build
      // only runs on a green suite, so buildOk is still true here") — which is exactly
      // why an absorbed candidate shipped with it never having been built.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 }, // WI-6956: confirming co-execution re-run passes → absorbed
        { code: 1 }, // marker grep clean
        { code: 1, stdout: "vite: bundle failed" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

      expect(r.green).toBe(false);
      expect(r.failingTests).toContain("@papercusp/operator-vite");
      expect(r.summary).toContain("vite: bundle failed");
      expect(calls).toHaveLength(6);
    });

    it("worker-crash absorption takes the same path: crash absorbed → FAILING typecheck still RED", async () => {
      // The second absorber (green-checkpoint.ts :2783) had an identical hole.
      const { exec, calls } = makeExec([
        { code: 1, stdout: CRASH_OUTPUT },
        { code: 0 }, // workspace re-run passes → absorbed
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        null,
      );

      expect(r.green).toBe(false);
      expect(r.failingTests).toContain("lint:tsc");
      expect(calls).toHaveLength(3);
      expect(calls[2].args).toEqual(["run", "lint:tsc"]);
    });

    it("a NON-absorbed red suite still short-circuits — no leg is run on a genuinely red suite", async () => {
      // The legs are the price of claiming green; a red that stays red must not pay it
      // (a full typecheck + 3 lints + an SPA build on every red tick is real gate time).
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 }, // file #1 passes
        { code: 1 }, // file #2 still fails → NOT absorbed
        { code: 1 }, // ...and its ISOLATION_RETRY_MAX retry fails too
      ]);
      const r = await realCheckpointDeps(cfg, exec, undefined, {
        sleep: async () => {},
      }).runGreen(typecheckTree, null);

      expect(r.green).toBe(false);
      expect(r.failingTests).not.toContain("lint:tsc"); // never ran ⇒ never reported as failed
      expect(calls).toHaveLength(4); // suite + 2 isolation runs + 1 retry — no legs
    });
  });
});

describe("realCheckpointDeps.setupTree / push — real-path wiring (gap #10)", () => {
  it("setupTree shells setup-release-checkout.sh with the integration/checkpoint/ref flags", async () => {
    const { exec, calls } = makeExec([
      { code: 0, stdout: "copied checkpoint dependencies" },
    ]);
    const setup = await realCheckpointDeps(cfg, exec).setupTree("cand123");
    expect(calls[0].cmd).toBe("bash");
    expect(
      calls[0].args[0].endsWith(
        "apps/operator/bin/release/setup-release-checkout.sh",
      ),
    ).toBe(true);
    expect(calls[0].args).toEqual(
      // `force` (not `auto`): the checkpoint tree must always re-copy node_modules — the
      // `auto` heuristic is blind to nested-dep drift and spuriously red the gate (EI-2699).
      expect.arrayContaining([
        "--ref",
        "cand123",
        "--integration",
        "/int",
        "--release",
        cpTree,
        "--node-modules",
        "force",
      ]),
    );
    expect(setup).toEqual({
      identity: "setup-release-checkout:cand123",
      output: "copied checkpoint dependencies",
    });
  });

  it("push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past the main pre-push hook)", async () => {
    const { exec, calls } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push(
      "ready",
      "base123",
      "candidate123",
    );
    expect(calls[0].cmd).toBe("git");
    expect(calls[0].args).toEqual([
      "-C",
      "/int",
      "push",
      "origin",
      "candidate123:refs/heads/ready",
    ]);
    expect(calls[0].opts?.env?.PAPERCUSP_MAIN_PUSH_OK).toBe("1");
  });

  it("push also workflow_dispatches test.yml (EI-18661485259809120: [skip ci] on every commit means the git push above never actually triggers it)", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push("ready");
    expect(mockCreateWorkflowDispatch).toHaveBeenCalledWith({
      owner: "Papercusp",
      repo: "papercup",
      workflow_id: "test.yml",
      ref: "ready",
    });
  });

  it("push never throws when the CI dispatch fails (best-effort — a GitHub API hiccup must not fail the checkpoint)", async () => {
    mockGetOctokit.mockRejectedValueOnce(new Error("network down"));
    const { exec, calls } = makeExec([{ code: 0 }]);
    await expect(
      realCheckpointDeps(cfg, exec).push("ready"),
    ).resolves.toBeUndefined();
    // the git push itself still happened
    expect(calls[0].cmd).toBe("git");
  });

  it("push skips the CI dispatch (without throwing) when no GitHub origin resolves", async () => {
    mockGitOriginUrl.mockResolvedValueOnce(null as unknown as string);
    mockCreateWorkflowDispatch.mockClear();
    const { exec } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push("ready");
    expect(mockCreateWorkflowDispatch).not.toHaveBeenCalled();
  });

  // WI-7013: the dispatched workflow_dispatch run must carry the pre-FF sha as its
  // `base` input, or test.yml's AFFECTED_BASE falls back to origin/main — which on a
  // workflow_dispatch run checked out AT main IS HEAD, an always-empty diff that
  // reports `tasks=0 status=passed` having verified nothing.
  it("push threads a given baseSha through to the workflow_dispatch inputs.base", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push("ready", "deadbeef00112233");
    expect(mockCreateWorkflowDispatch).toHaveBeenCalledWith({
      owner: "Papercusp",
      repo: "papercup",
      workflow_id: "test.yml",
      ref: "ready",
      inputs: { base: "deadbeef00112233" },
    });
  });

  // AdvanceResult.from is `null` on a freshly-created ready branch (the first-ever
  // advance) — the dispatch must degrade to the pre-WI-7013 shape (no `inputs` key
  // at all) rather than sending a literal "null"/"undefined" base.
  it("push omits inputs.base entirely when baseSha is null or omitted", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec: exec1 } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec1).push("ready", null);
    const { exec: exec2 } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec2).push("ready");
    for (const call of mockCreateWorkflowDispatch.mock.calls) {
      expect(call[0]).not.toHaveProperty("inputs");
    }
  });
});

/**
 * WI-6068 recurrence guard. The suite log used to be named `<ts>-base-<sha>.log`, where
 * `base` is `main` — CONSTANT between fast-forwards. So consecutive runs judging DIFFERENT
 * candidates produced near-identical names, and a STALE red read exactly like a fresh
 * verdict (2026-07-26: `ls -t | head -1` surfaced a red for a superseded candidate while
 * the real run was still in flight and logging to /tmp; the candidate was only recovered
 * by archaeology on failing TEST NAMES). These assert the candidate is recoverable from
 * the artifact itself — and that resolving it can never break the gate.
 */
describe("WI-6068: the checkpoint log identifies the CANDIDATE it judged", () => {
  /**
   * A real git repo, because the candidate sha is read from the tree's HEAD.
   * `marker` must differ between fixtures: git derives the sha from tree content +
   * commit timestamp, so two identical trees committed inside the same second would
   * collide on ONE sha — and the "distinguishable names" test below would pass
   * vacuously while asserting the exact opposite of what it claims.
   */
  function makeGitTree(marker = "fixture"): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), "green-cp-git-tree-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "cp-git-fixture" }),
    );
    writeFileSync(join(dir, "marker.txt"), marker);
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    git("add", "-A");
    git("commit", "-qm", "fixture");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    return { dir, sha };
  }

  it("writes the candidate sha into BOTH the log filename and the log body", async () => {
    const { dir, sha } = makeGitTree();
    try {
      expect(sha).toMatch(/^[0-9a-f]{40}$/); // fixture sanity: HEAD really resolved
      const before = new Set(readdirSync(tmpLogDir));
      const { exec } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);

      await realCheckpointDeps(cfg, exec).runGreen(dir, "base-sha");

      const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
      expect(written).toHaveLength(1);
      // The filename alone must answer "what was judged" — that is the whole point.
      expect(written[0]).toContain(`-cand-${sha.slice(0, 12)}`);
      // ...and the body repeats it, so a tailed/copied log stays self-identifying.
      expect(readFileSync(join(tmpLogDir, written[0]), "utf8")).toContain(
        `candidate=${sha}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two runs on DIFFERENT candidates produce distinguishable log names (the actual failure)", async () => {
    const a = makeGitTree("candidate-a");
    const b = makeGitTree("candidate-b");
    try {
      expect(a.sha).not.toBe(b.sha); // fixture sanity: genuinely different candidates
      const before = new Set(readdirSync(tmpLogDir));
      // Same `base` for both — exactly the real-world case the old name could not separate.
      await realCheckpointDeps(
        cfg,
        makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]).exec,
      ).runGreen(a.dir, "same-base");
      await realCheckpointDeps(
        cfg,
        makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]).exec,
      ).runGreen(b.dir, "same-base");

      const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
      expect(written).toHaveLength(2);
      const candidatePart = (f: string) => /-cand-([0-9a-f]+)\./.exec(f)?.[1];
      expect(new Set(written.map(candidatePart)).size).toBe(2);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it("FAILS OPEN on a non-git candidate tree — still logs, never throws (a naming nicety must not gate a verdict)", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);

    // cpTree is a bare temp dir with a package.json and no git repo at all.
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("-cand-");
    expect(readFileSync(join(tmpLogDir, written[0]), "utf8")).toContain(
      "candidate=unresolved",
    );
  });
});

// ── EI-19332206710686203 ──────────────────────────────────────────────────────
// Every RESCUE re-run must pass vitest an explicit, generous per-test deadline.
//
// The defect these guard: vitest's default testTimeout is 5s and nothing in this repo's
// config chain raises it, so each re-run below inherited 5s. That is self-defeating — a
// rescue re-run exists to decide "box, or code?", and at loadavg 130+ the dominant flake
// shape is a test that is merely SLOW. On a 5s deadline the re-run re-observes the very
// symptom it was launched to discriminate, and votes to keep the red. Measured 2026-08-02:
// github-identity-drift.test.ts timed out at 11,725ms with ZERO real offenders and
// red-pinned the fleet's gate.
//
// These are argv-level guards on purpose: the flag IS the entire fix, it is invisible to
// any behavioural assertion (an injected exec never runs vitest), and dropping it would
// silently restore the 5s default with every other test in this file still green.
describe("EI-19332206710686203: rescue re-runs carry an explicit per-test timeout", () => {
  const TIMEOUT_FLAG = `--testTimeout=${RESCUE_TEST_TIMEOUT_MS}`;

  // Generous vs the 5s default, yet well inside every outer wall-clock cap — so raising it
  // can delay a red (the subprocess cap still fires on a real hang), never invent a green.
  it("the deadline is generous vs vitest 5s, yet stays inside every outer subprocess cap", () => {
    expect(RESCUE_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(ISOLATION_RUN_TIMEOUT_MS);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(CONCURRENT_CONFIRM_TIMEOUT_MS);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(WORKSPACE_RERUN_TIMEOUT_MS);
  });

  const RED_TWO_FILES =
    ">>> @papercusp/operator-core :: npm run test\n" +
    " FAIL  lib/a.test.ts > alpha\n" +
    " FAIL  lib/b.test.ts > beta\n" +
    "2 non-quarantined task(s) failed.";

  it("the per-file isolation re-run passes it — and still AFTER the `--` npm separator", async () => {
    // calls: 0 red suite, 1+2 the two isolation re-runs, 3 the confirming co-execution run.
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_TWO_FILES },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    for (const c of calls.slice(1, 3)) {
      expect(c.cmd).toBe("npm");
      expect(c.args).toContain(TIMEOUT_FLAG);
      // npm forwards only what FOLLOWS `--` to the script; a flag placed before it is
      // swallowed by npm and never reaches vitest — a failure mode with no runtime symptom.
      expect(c.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
        c.args.indexOf("--"),
      );
      // ...and it must not have displaced the single-concurrency isolation contract.
      expect(c.args).toContain("--no-file-parallelism");
      expect(c.opts?.env?.VITEST_MAX_FORKS).toBe("1");
    }
  });

  // The counterintuitive one. Absorption requires BOTH every file to pass alone AND this
  // confirming run to come back clean — so leaving THIS on the 5s default would have kept
  // the isolation fix inert: under the same load a slow test re-times-out here and is
  // scored `reproduced`. The room does not blunt the experiment, because what this run
  // measures is whether the failure is CORRECTNESS-dependent on co-execution (which still
  // fails at 60s); being merely slower when co-executed is what contention IS, not a defect.
  it("the confirming co-execution re-run passes it too — otherwise the isolation fix is inert", async () => {
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_TWO_FILES },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    const confirming = calls[3];
    expect(confirming.cmd).toBe("npm");
    expect(confirming.args).toContain(TIMEOUT_FLAG);
    expect(confirming.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      confirming.args.indexOf("--"),
    );
    // ...without becoming an isolation run: co-execution is the variable it exists to test.
    expect(confirming.args).not.toContain("--no-file-parallelism");
    expect(confirming.opts?.env?.VITEST_MAX_FORKS).not.toBe("1");
    // both originally-failing files still run TOGETHER in the one invocation
    expect(confirming.args).toContain("lib/a.test.ts");
    expect(confirming.args).toContain("lib/b.test.ts");
  });

  it("the worker-pool-crash workspace re-run passes it", async () => {
    const crash =
      ">>> @papercusp/operator-core :: npm run test\n" +
      "Error: [vitest-pool]: Worker forks emitted error.\n" +
      "Caused by: Error: Worker exited unexpectedly\n" +
      "1 non-quarantined task(s) failed.";
    const { exec, calls } = makeExec([{ code: 1, stdout: crash }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    const rerun = calls[1];
    expect(rerun.cmd).toBe("npm");
    expect(rerun.args).toContain(TIMEOUT_FLAG);
    expect(rerun.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      rerun.args.indexOf("--"),
    );
    expect(rerun.opts?.env?.VITEST_MAX_FORKS).toBe("1"); // still the reduced-concurrency re-run
  });

  it("the stale-candidate tip re-run passes it", async () => {
    // runTestsAtRef is the "is this red already fixed at tip?" rescue: a false pass:false
    // there reports a genuinely-fixed tip as still broken and keeps `main` frozen.
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(cfg, exec);
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/operator-core", file: "lib/a.test.ts" },
    ]);

    const testRun = calls.find(
      (c) => c.cmd === "npm" && c.args.includes("test"),
    );
    expect(testRun).toBeDefined();
    expect(testRun!.args).toContain(TIMEOUT_FLAG);
    expect(testRun!.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      testRun!.args.indexOf("--"),
    );
    expect(testRun!.args).toContain("lib/a.test.ts");
  });

  it("routes standalone package rescue runs through the package directory", async () => {
    const standaloneCfg = releaseConfig({
      integrationRoot: "/int",
      releaseRoot: "/int",
      checkpointRoot: standaloneTree,
      releaseRef: "ready",
      integrationBranch: "main",
      checkpointLogDir: tmpLogDir,
    });
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(standaloneCfg, exec);
    const file = "test/test-registry-coverage.test.js";

    await deps.isolationRun?.({ workspace: "@papercusp/desktop", file });
    await deps.concurrentRun?.({
      workspace: "@papercusp/desktop",
      files: [file],
    });
    await deps.workspaceRerun?.({ workspace: "@papercusp/desktop" });
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/desktop", file },
    ]);

    const testRuns = calls.filter(
      (c) => c.cmd === "npm" && c.args[0] === "run" && c.args[1] === "test",
    );
    expect(testRuns).toHaveLength(4);
    for (const run of testRuns) {
      expect(run.opts?.cwd).toBe(join(standaloneTree, "papercusp-desktop"));
      expect(run.args).not.toContain("--workspace");
      expect(run.args.slice(0, 3)).toEqual(["run", "test", "--"]);
    }
    expect(testRuns.at(-1)?.args).toContain(file);
  });

  it("routes Bash self-test rescues through Bash, never the package Vitest command", async () => {
    const standaloneCfg = releaseConfig({
      integrationRoot: "/int",
      releaseRoot: "/int",
      checkpointRoot: standaloneTree,
      releaseRef: "ready",
      integrationBranch: "main",
      checkpointLogDir: tmpLogDir,
    });
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(standaloneCfg, exec);
    const file = "bin/lib/release-artifacts.selftest.sh";

    expect(
      resolveWorkspaceFileTestInvocation(
        standaloneTree,
        "@papercusp/desktop",
        file,
        ["--no-file-parallelism", "--testTimeout=60000"],
      ),
    ).toEqual({
      cmd: "bash",
      args: [file],
      cwd: join(standaloneTree, "papercusp-desktop"),
    });

    await deps.isolationRun?.({ workspace: "@papercusp/desktop", file });
    await deps.concurrentRun?.({
      workspace: "@papercusp/desktop",
      files: [file],
    });
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/desktop", file },
    ]);

    const bashRuns = calls.filter(
      (call) => call.cmd === "bash" && call.args.includes(file),
    );
    expect(bashRuns).toHaveLength(3);
    for (const run of bashRuns) {
      expect(run.args).toEqual([file]);
      expect(run.opts?.cwd).toBe(join(standaloneTree, "papercusp-desktop"));
    }
    expect(
      calls.some(
        (call) => call.cmd === "npm" && call.args.includes(file),
      ),
    ).toBe(false);
  });
});

// ── WI-36238: the `release-not-green` row must SURVIVE the attention TTL sweep ──
//
// COUPLING test, not a unit test: it drives the REAL `escalate` dep and feeds
// the record it emits to the REAL selector. The two halves live in different
// packages, so a unit test on either side alone would stay green if the marker
// were renamed, dropped from the meta bag, or no longer honoured.
//
// WHY IT MATTERS: `escalate` is transition-only — it returns early while one of
// its rows is open — and `clearEscalation` resolves that row itself when the
// gate recovers. So a sweep that GC's the row does not tidy a duplicate, it
// RE-ARMS a human-facing alarm on a still-red gate. Measured before the fix: an
// idle-2d GC at 2026-08-06T08:20:03.146Z was followed 46s later by a fresh
// escalation for the same still-red gate on a newer candidate.
describe("realCheckpointDeps.escalate — release-not-green survives the idle-TTL sweep (WI-36238)", () => {
  const TTL_MS = 2 * 24 * 60 * 60 * 1000;

  /** Mirrors buildOpenEscalationRecord (escalations.ts:170-190) — in particular
   *  `Object.assign(env, input.meta)`, which FLATTENS the meta bag onto the
   *  stored record, which is how the sweep sees the marker at all. */
  function openRecordFor(call: {
    identity: Record<string, unknown>;
    input: Record<string, unknown>;
  }): StaleEscalationInput {
    return {
      ts: "2026-08-06T08:20:48.996Z",
      msg_id: "esc-green-checkpoint-1",
      from: String(call.identity.ownerId),
      to: ["human"],
      kind: "escalation",
      severity: call.input.severity,
      summary: call.input.summary,
      resolved: null,
      ...((call.input.meta as Record<string, unknown> | undefined) ?? {}),
    } as unknown as StaleEscalationInput;
  }

  it("emits a row the idle-TTL sweep will NOT garbage-collect", async () => {
    openEscalationCalls.length = 0;
    const { exec } = makeExec([]);
    await realCheckpointDeps(cfg, exec).escalate?.(
      "green-checkpoint held: 65e99488 not green",
      "the gate is red",
    );
    expect(openEscalationCalls).toHaveLength(1);

    const emitted = openRecordFor(openEscalationCalls[0]!);
    // Age it well past the sweep's TTL and run the REAL selector.
    const nowMs = Date.parse(emitted.ts) + 30 * 24 * 60 * 60 * 1000;
    expect(selectStaleEscalations([emitted], { nowMs, ttlMs: TTL_MS })).toEqual(
      [],
    );

    // CALIBRATION: the same row WITHOUT the marker IS swept — proving the
    // assertion above turns on the marker, not on some other property of the
    // row (its sender, its lack of options, its age). Without this, a selector
    // that never selected this row for an unrelated reason would look like a
    // passing exemption.
    const { [SELF_RECONCILING_META_KEY]: _marker, ...unmarked } =
      emitted as unknown as Record<string, unknown>;
    expect(
      selectStaleEscalations([unmarked as unknown as StaleEscalationInput], {
        nowMs,
        ttlMs: TTL_MS,
      }),
    ).toHaveLength(1);
  });
});

// WI-39686: the green-recovery sweep matched on escalation SOURCE alone, while
// `clearEscalation`'s interface doc promised only the `release-not-green` row.
//
// ⚠ READ THIS BEFORE "FIXING" A FAILURE HERE: the defect these tests guard is
// LATENT, not live. At the time of writing this file has exactly two
// `openEscalation` call sites — the release-not-green row and the detector alert
// — and the detector already carries its own DISTINCT source, so the old
// source-only sweep resolved precisely the one row it should. Nothing was
// misbehaving in production. What these tests protect is the NEXT author who
// opens a row under the gate's own source: under the old sweep it would be
// silently self-resolved on the advance path, in its own run. That is exactly
// what D-008 nearly did to the detector alert, and the near-miss is why the
// class marker exists. So a failure here is not "an alarm is being cleared
// wrongly today" — it is "the trap has been re-armed".
describe("clearEscalation — sweeps the release-not-green CLASS, not the whole source (WI-39686)", () => {
  function row(extra: Record<string, unknown>): Record<string, unknown> {
    return { msg_id: "esc-1", status: "open", ...extra };
  }

  describe("isReleaseNotGreenEscalation", () => {
    it("matches the class the sweep owns", () => {
      expect(
        isReleaseNotGreenEscalation(
          row({
            source: GATE_ESCALATION_SOURCE,
            [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
          }),
        ),
      ).toBe(true);
    });

    // The backward-compatibility arm, and it is load-bearing rather than lenient:
    // rows opened BEFORE the class marker existed carry the source only, and one
    // may be open on a genuinely red gate at deploy time. If the predicate
    // demanded the marker, that row could never be resolved again — an immortal
    // human-facing alarm. Deleting this case to "tighten" the predicate would
    // reintroduce precisely that.
    it("still matches a legacy row that predates the class marker", () => {
      expect(
        isReleaseNotGreenEscalation(row({ source: GATE_ESCALATION_SOURCE })),
      ).toBe(true);
    });

    it("does NOT match another class opened under the gate's own source", () => {
      expect(
        isReleaseNotGreenEscalation(
          row({
            source: GATE_ESCALATION_SOURCE,
            [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
          }),
        ),
      ).toBe(false);
    });

    it("does not match the detector alert, or a foreign row", () => {
      expect(
        isReleaseNotGreenEscalation(row({ source: DETECTOR_ESCALATION_SOURCE })),
      ).toBe(false);
      expect(isReleaseNotGreenEscalation(row({ source: "some-other-tool" }))).toBe(
        false,
      );
      expect(isReleaseNotGreenEscalation(null)).toBe(false);
      expect(isReleaseNotGreenEscalation(undefined)).toBe(false);
    });
  });

  // COUPLING half — a predicate unit test alone would stay green if the sweep
  // stopped calling it and went back to a bare source comparison. This drives
  // the REAL `clearEscalation` dep against a mixed set of open rows.
  describe("the real clearEscalation dep", () => {
    it("resolves the release-not-green row and LEAVES a sibling gate-sourced row open", async () => {
      resolveEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-release-not-green",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
        }),
        row({
          msg_id: "esc-legacy-unmarked",
          source: GATE_ESCALATION_SOURCE,
        }),
        row({
          msg_id: "esc-future-gate-alert",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
        }),
        row({ msg_id: "esc-detector", source: DETECTOR_ESCALATION_SOURCE }),
        row({ msg_id: "esc-foreign", source: "some-other-tool" }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).clearEscalation?.();

      const resolved = resolveEscalationCalls.map((c) => c.msg_id).sort();
      // Behaviour-PRESERVING for everything that exists today: the real row and
      // the legacy unmarked row are still resolved on recovery.
      expect(resolved).toEqual(["esc-legacy-unmarked", "esc-release-not-green"]);
      // ...and the rows the old source-only sweep would have wrongly swept are
      // untouched. `esc-future-gate-alert` is the whole point of the change.
      expect(resolved).not.toContain("esc-future-gate-alert");
      expect(resolved).not.toContain("esc-detector");
      expect(resolved).not.toContain("esc-foreign");
    });

    // CALIBRATION, mirroring the WI-36238 test above: prove the assertion turns
    // on the class scoping rather than on some unrelated property of the fixture
    // (a missing field, the resolve mock never being called at all). The OLD
    // predicate is inlined here as the control — against the same rows it sweeps
    // three of them, so the test above genuinely discriminates.
    it("CALIBRATION: the old source-only predicate would have swept the sibling rows", () => {
      const oldPredicate = (e: Record<string, unknown>) =>
        e.source === "green-checkpoint";
      const rows = [
        row({ msg_id: "esc-release-not-green", source: GATE_ESCALATION_SOURCE, [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS }),
        row({ msg_id: "esc-legacy-unmarked", source: GATE_ESCALATION_SOURCE }),
        row({ msg_id: "esc-future-gate-alert", source: GATE_ESCALATION_SOURCE, [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert" }),
      ];
      expect(rows.filter(oldPredicate)).toHaveLength(3);
      expect(rows.filter(isReleaseNotGreenEscalation)).toHaveLength(2);
    });
  });

  // The dedup guard in `escalate` had the SAME over-broad match, in the direction
  // that loses a page: any gate-sourced row being open suppressed the red
  // escalation from opening at all.
  describe("the escalate dedup guard", () => {
    it("still opens the red escalation when only a DIFFERENT gate-sourced class is open", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-future-gate-alert",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
        }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(1);
      expect(
        (openEscalationCalls[0]!.input.meta as Record<string, unknown>)[
          ESCALATION_CLASS_META_KEY
        ],
      ).toBe(RELEASE_NOT_GREEN_ESCALATION_CLASS);
    });

    it("still suppresses a duplicate while its OWN row is open (transition-only preserved)", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-release-not-green",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
        }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(0);
    });

    it("still suppresses a duplicate while a LEGACY unmarked row is open", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({ msg_id: "esc-legacy-unmarked", source: GATE_ESCALATION_SOURCE }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(0);
    });
  });

  afterAll(() => {
    openEscalationRows = [];
  });
});
