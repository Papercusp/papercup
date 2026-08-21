import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
  parseFrozenCandidateRepairQueue,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import {
  buildPassingTaskVerdictIdentity,
  decidePassingTaskVerdict,
  emptyPassingTaskVerdictCache,
  mergePassingTaskVerdictUpdates,
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictEntry,
  passingTaskVerdictIdentityEnvironment,
  readPassingTaskVerdictCache,
  shouldStorePassingTaskVerdict,
  writePassingTaskVerdictCacheAtomic,
  type PassingTaskVerdictIdentity,
} from "../../../../scripts/lib/passing-task-verdict-cache.mjs";
import {
  buildGreenCheckpointEnv,
  runPostSuiteLegs,
  type CheckpointExec,
} from "./green-checkpoint";

type FixtureTask = {
  key: string;
  script: string;
  workspace: string;
  initialStatus: number;
  finalStatus: number;
  absorptionRan: boolean;
};

const CANDIDATE = "1".repeat(40);
const REPAIRED = "2".repeat(40);
const BASE = "0".repeat(40);
const INITIAL_RUN = "initial-proof-run";
const VERIFIER_RUN = "repair-verifier-run";

const commandFor = (task: FixtureTask, root: string) => ({
  cmd: "npm",
  argv: ["run", task.script, "--workspace", task.workspace],
  cwd: root,
  scriptText: `vitest run ${task.workspace}`,
});

const gateConfig = {
  retryFailed: true,
  scheduler: { workers: 2, memoryMb: 4096 },
};

describe("P-009: frozen-repair passing-task reuse recurs end to end", () => {
  it("skips only unchanged clean first-pass tasks and reruns every unsafe class", () => {
    const root = mkdtempSync(join(tmpdir(), "repair-cache-chain-"));
    const cachePath = join(root, ".cache", "passing.json");
    const files = [
      "package-lock.json",
      "scripts/affected-tests.mjs",
      "packages/clean/src/index.ts",
      "packages/failing/src/index.ts",
      "packages/retried/src/index.ts",
      "packages/core/src/index.ts",
      "packages/dependent/src/index.ts",
      "packages/external/src/index.ts",
      "packages/other/src/index.ts",
    ];
    try {
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), `${file}:initial\n`);
      }
      const workspaces = new Map([
        ["@fixture/clean", { dir: "packages/clean", deps: [] }],
        ["@fixture/failing", { dir: "packages/failing", deps: [] }],
        ["@fixture/retried", { dir: "packages/retried", deps: [] }],
        ["@fixture/core", { dir: "packages/core", deps: [] }],
        [
          "@fixture/dependent",
          { dir: "packages/dependent", deps: ["@fixture/core"] },
        ],
        ["@fixture/external", { dir: "packages/external", deps: [] }],
        ["@fixture/other", { dir: "packages/other", deps: [] }],
      ]);
      const tasks: FixtureTask[] = [
        {
          key: "@fixture/clean :: test",
          script: "test",
          workspace: "@fixture/clean",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/failing :: test",
          script: "test",
          workspace: "@fixture/failing",
          initialStatus: 1,
          finalStatus: 1,
          absorptionRan: false,
        },
        {
          key: "@fixture/retried :: test",
          script: "test",
          workspace: "@fixture/retried",
          initialStatus: 1,
          finalStatus: 0,
          absorptionRan: true,
        },
        {
          key: "@fixture/dependent :: test",
          script: "test",
          workspace: "@fixture/dependent",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/external :: test:integration",
          script: "test:integration",
          workspace: "@fixture/external",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/clean :: lint:repo-wide",
          script: "lint:repo-wide",
          workspace: "@fixture/clean",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
      ];
      const repoWideTaskKeys = new Set([tasks[5]!.key]);
      const trackedScan = { files, unscannedPresent: [] as string[] };
      const initialEnv = buildGreenCheckpointEnv(BASE, {}, INITIAL_RUN);
      const initialIdentityEnv =
        passingTaskVerdictIdentityEnvironment(initialEnv).environment;
      const identityFor = (
        task: FixtureTask,
        environment: Record<string, unknown>,
      ): PassingTaskVerdictIdentity | null => {
        const provenance = passingTaskVerdictDependencyProvenance({
          root,
          taskKey: task.key,
          script: task.script,
          workspaceName: task.workspace,
          workspaces,
          trackedScan,
          repoWideTaskKeys,
        });
        if (!provenance.ok) return null;
        return buildPassingTaskVerdictIdentity({
          taskKey: task.key,
          command: commandFor(task, root),
          environment,
          gateConfig,
          dependencyHash: provenance.hash,
        });
      };

      const initialEntries: Record<
        string,
        ReturnType<typeof passingTaskVerdictEntry>
      > = {};
      for (const task of tasks) {
        const identity = identityFor(task, initialIdentityEnv);
        if (
          shouldStorePassingTaskVerdict({
            enabled: true,
            cacheStatus: "miss",
            initialStatus: task.initialStatus,
            finalStatus: task.finalStatus,
            absorptionRan: task.absorptionRan,
            identity,
          })
        ) {
          initialEntries[task.key] = passingTaskVerdictEntry(
            identity!,
            "initial-pass",
          );
        }
      }
      const initialCache = mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        initialEntries,
      );
      writePassingTaskVerdictCacheAtomic(cachePath, initialCache, "initial");

      expect(Object.keys(initialCache.entries).sort()).toEqual(
        [tasks[0]!.key, tasks[3]!.key, tasks[5]!.key].sort(),
      );

      // The repair touches a transitive dependency and an otherwise unrelated path.
      // The clean workspace remains byte-identical; the whole-tree guard does not.
      writeFileSync(
        join(root, "packages/core/src/index.ts"),
        "core:repaired\n",
      );
      writeFileSync(
        join(root, "packages/other/src/index.ts"),
        "other:repaired\n",
      );

      const queue = createFrozenCandidateRepairQueue({
        candidate: CANDIDATE,
        base: BASE,
        worktreePath: join(root, ".papercusp", "worktrees", "repair"),
        affectedTestProofGroup: INITIAL_RUN,
        nowMs: 100,
      });
      const verifierEnv = buildGreenCheckpointEnv(
        BASE,
        {},
        VERIFIER_RUN,
        "shared",
        queue.affectedTestProofGroup,
      );
      const verifierIdentityEnv =
        passingTaskVerdictIdentityEnvironment(verifierEnv).environment;
      const persisted = readPassingTaskVerdictCache(cachePath);
      const decisions = new Map(
        tasks.map((task) => {
          const identity = identityFor(task, verifierIdentityEnv);
          return [
            task.key,
            decidePassingTaskVerdict({
              enabled: true,
              cacheRead: persisted,
              entry: persisted.cache.entries[task.key],
              identity,
            }),
          ];
        }),
      );

      expect(decisions.get(tasks[0]!.key)).toEqual({
        hit: true,
        reason: "identity-match",
      });
      expect(decisions.get(tasks[1]!.key)).toEqual({
        hit: false,
        reason: "no-prior-verdict",
      });
      expect(decisions.get(tasks[2]!.key)).toEqual({
        hit: false,
        reason: "no-prior-verdict",
      });
      expect(decisions.get(tasks[3]!.key)).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });
      expect(decisions.get(tasks[4]!.key)).toEqual({
        hit: false,
        reason: "provenance-incomplete",
      });
      expect(decisions.get(tasks[5]!.key)).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });
      expect(
        [...decisions.values()]
          .filter((decision) => !decision.hit)
          .map((_decision, index) => index),
      ).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("misses on every identity component and on corrupt or legacy cache state", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-cache-identity-"));
    const path = join(dir, "cache.json");
    try {
      const baseline = buildPassingTaskVerdictIdentity({
        taskKey: "@fixture/app :: test",
        command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
        environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
        gateConfig,
        dependencyHash: "closure-a",
      });
      const entry = passingTaskVerdictEntry(baseline);
      const variants: Array<[string, PassingTaskVerdictIdentity]> = [
        [
          "command-changed",
          buildPassingTaskVerdictIdentity({
            ...baseline,
            command: {
              cmd: "npm",
              argv: ["run", "test:changed"],
              cwd: "/checkpoint",
            },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-a",
          }),
        ],
        [
          "environment-changed",
          buildPassingTaskVerdictIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: {
              CI: "1",
              FEATURE: "changed",
              PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN,
            },
            gateConfig,
            dependencyHash: "closure-a",
          }),
        ],
        [
          "gate-config-changed",
          buildPassingTaskVerdictIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig: { ...gateConfig, retryFailed: false },
            dependencyHash: "closure-a",
          }),
        ],
        [
          "implementation-version-changed",
          buildPassingTaskVerdictIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-a",
            implementationVersion: "tooling-v-next",
          }),
        ],
        [
          "dependency-closure-changed",
          buildPassingTaskVerdictIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-b",
          }),
        ],
      ];
      for (const [reason, identity] of variants) {
        expect(
          decidePassingTaskVerdict({
            enabled: true,
            cacheRead: { reason: "cache-ready" },
            entry,
            identity,
          }),
        ).toEqual({ hit: false, reason });
      }

      writeFileSync(path, "{corrupt");
      const corrupt = readPassingTaskVerdictCache(path);
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: corrupt,
          entry: corrupt.cache.entries[baseline.taskKey],
          identity: baseline,
        }),
      ).toEqual({ hit: false, reason: "cache-corrupt" });
      writeFileSync(path, JSON.stringify({ version: 0, entries: {} }));
      expect(readPassingTaskVerdictCache(path).reason).toBe(
        "cache-version-mismatch",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps candidate and verifier identity exact while foreign or legacy runs miss", () => {
    let queue = createFrozenCandidateRepairQueue({
      candidate: CANDIDATE,
      base: BASE,
      worktreePath: "/checkpoint/.papercusp/worktrees/repair",
      affectedTestProofGroup: INITIAL_RUN,
      nowMs: 100,
    });
    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: "fixer-1",
      nowMs: 101,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: "fixer-1",
      repairHead: REPAIRED,
      nowMs: 102,
    });
    expect(queue).toMatchObject({
      candidate: CANDIDATE,
      repairHead: REPAIRED,
      affectedTestProofGroup: INITIAL_RUN,
    });

    const verifierEnv = buildGreenCheckpointEnv(
      BASE,
      {},
      VERIFIER_RUN,
      "shared",
      queue.affectedTestProofGroup,
    );
    expect(verifierEnv.PAPERCUSP_TEST_RUN_GROUP).toBe(VERIFIER_RUN);
    expect(verifierEnv.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBe(INITIAL_RUN);

    const initialIdentity = buildPassingTaskVerdictIdentity({
      taskKey: "@fixture/app :: test",
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: { PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
      gateConfig,
      dependencyHash: "closure",
    });
    const foreignIdentity = buildPassingTaskVerdictIdentity({
      taskKey: initialIdentity.taskKey,
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: { PAPERCUSP_TEST_RUN_GROUP: "foreign-pipeline-run" },
      gateConfig,
      dependencyHash: "closure",
    });
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: "cache-ready" },
        entry: passingTaskVerdictEntry(initialIdentity),
        identity: foreignIdentity,
      }),
    ).toEqual({ hit: false, reason: "environment-changed" });

    const legacy = parseFrozenCandidateRepairQueue({
      ...queue,
      schemaVersion: 1,
      affectedTestProofGroup: undefined,
    });
    expect(legacy?.affectedTestProofGroup).toBeNull();
    const legacyVerifierEnv = buildGreenCheckpointEnv(
      BASE,
      {},
      VERIFIER_RUN,
      "shared",
      legacy?.affectedTestProofGroup,
    );
    expect(legacyVerifierEnv.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBeUndefined();
  });

  it("runs typecheck, migration, live-plane, and build assurance after suite reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "repair-post-suite-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "repair-post-suite-fixture",
          scripts: {
            "lint:tsc": "node lint-tsc.mjs",
            "lint:migrations": "node lint-migrations.mjs",
            "lint:migration-forward-compat": "node migration-forward.mjs",
            "lint:plane-producers": "node plane-producers.mjs",
          },
        }),
      );
      const calls: string[] = [];
      const exec: CheckpointExec = async (cmd, args) => {
        const runIndex = args.indexOf("run");
        calls.push(
          cmd === "npm" && runIndex >= 0
            ? args[runIndex + 1]!
            : `${cmd}:${args[0] ?? ""}`,
        );
        return {
          code: cmd === "git" ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      };
      const result = await runPostSuiteLegs(
        root,
        buildGreenCheckpointEnv(BASE, {}, VERIFIER_RUN),
        exec,
        "@papercusp/operator-vite",
        {
          identity: {
            runId: VERIFIER_RUN,
            candidate: REPAIRED,
            headAtStart: REPAIRED,
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(calls).toEqual(
        expect.arrayContaining([
          "lint:tsc",
          "lint:migrations",
          "lint:migration-forward-compat",
          "lint:plane-producers",
          "build",
        ]),
      );
      expect(
        result.records.find((record) => record.id === "lint:tsc"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "lint:migrations"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "lint:plane-integrity"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "spa-build"),
      ).toMatchObject({ status: "passed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
