import { describe, expect, it } from "vitest";

import {
  NON_TEST_GATE_SCRIPTS,
  parseRepairHeadRadius,
  partitionRepairSignatureEntries,
  makeTestWorkspaceResolver,
  repairSignatureFromVerdict,
  verifyRepairHead,
  validateTargetedFileOutcomes,
  type FailingFile,
  type RepairHeadVerificationDeps,
} from "./green-checkpoint";
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  markFrozenRepairVerificationRed,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
  type RepairSignatureEntry,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

/**
 * P-006 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-004) — the GATE side of
 * the typed repair signature.
 *
 * The queue module proves the signature is CLASSIFIED and PERSISTED correctly
 * (`frozen-repair-signature.test.ts`). These tests prove the gate CONSUMES it the way P-006
 * promised: every entry's `kind` picks the runner that re-measures it (nothing re-guesses a
 * kind from the id's shape), a kind no runner can re-measure forces the full gate at the
 * repair head instead of being silently dropped, every runner is handed `queue.repairHead`
 * and never the frozen candidate, and a verdict reports WHICH kinds it measured so the queue
 * extends rather than replaces the signature (a suite-only run must not erase a lint red).
 */

const CANDIDATE = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const CORE = "@papercusp/operator-core";
const WEB = "@papercusp/web";

function entry(
  partial: Pick<RepairSignatureEntry, "kind" | "id"> & Partial<RepairSignatureEntry>,
): RepairSignatureEntry {
  return {
    recipe: `npm run ${partial.id}`,
    admittedRound: 1,
    measuredHead: HEAD,
    ...partial,
  };
}

function queueWith(
  signature: RepairSignatureEntry[],
  extra: Partial<FrozenCandidateRepairQueue> = {},
): FrozenCandidateRepairQueue {
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: "ready-to-verify",
    candidate: CANDIDATE,
    base: BASE,
    repairHead: HEAD,
    attempts: 1,
    openedAtMs: 1,
    updatedAtMs: 2,
    fixerSpawnId: "fixer-1",
    failingTests: signature.map((e) => e.id),
    signature,
    ...extra,
  };
}

/** Deps that record every ref they are handed, so "never the candidate" is asserted, not assumed. */
function recordingDeps(opts: {
  filesPass?: boolean;
  gatesPass?: boolean;
  radius?: { files: FailingFile[]; gateIds: string[]; summary: string } | null;
  withRadius?: boolean;
} = {}) {
  const refs: string[] = [];
  const fileRuns: FailingFile[][] = [];
  const gateRuns: string[][] = [];
  const radiusCalls: string[][] = [];
  const deps: RepairHeadVerificationDeps = {
    runTestsAtRef: async (ref, files) => {
      refs.push(ref);
      fileRuns.push(files);
      return { pass: opts.filesPass ?? true, summary: `${files.length} file(s) ${opts.filesPass === false ? "failed" : "passed"}` };
    },
    runGateAtRef: async (ref, gateIds) => {
      refs.push(ref);
      gateRuns.push(gateIds);
      return { pass: opts.gatesPass ?? true, summary: `${gateIds.length} gate(s) ${opts.gatesPass === false ? "failed" : "passed"}` };
    },
    ...(opts.withRadius
      ? {
          affectedTestsAtRef: async (ref: string, paths: string[]) => {
            refs.push(ref);
            radiusCalls.push(paths);
            return opts.radius ?? null;
          },
        }
      : {}),
  };
  return { deps, refs, fileRuns, gateRuns, radiusCalls };
}

describe("P-003/P-006 partitionRepairSignatureEntries — the kind picks a bounded runner", () => {
  it("routes test-file → files, re-runnable workspace-task/lint-leg/seed → gates, and the rest → full run", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
      // The workspace's own `test` task is covered by its file re-run — not a gate.
      entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
      entry({ kind: "workspace-task", id: `${WEB} :: lint:styles`, workspace: WEB }),
      entry({ kind: "lint-leg", id: "lint:tsc" }),
      entry({ kind: "seed", id: `${WEB} :: seed:demo:check`, workspace: WEB }),
      // A seed id that is neither registered nor a `<ws> :: seed:*:check` task: nothing re-runs it.
      entry({ kind: "seed", id: "seed:demo" }),
      // A post-suite leg is full-gate-only by construction, whatever its id looks like.
      entry({ kind: "post-suite-leg", id: "@papercusp/operator-vite" }),
      // A bare workspace marker with no paired file has no selective runner either.
      entry({ kind: "workspace-task", id: "@papercusp/sync", workspace: "@papercusp/sync" }),
    ]);
    expect(out.files).toEqual([{ workspace: CORE, file: "lib/a.test.ts" }]);
    expect(out.gateIds).toEqual([
      `${WEB} :: lint:styles`,
      "lint:tsc",
      `${WEB} :: seed:demo:check`,
      "seed:demo",
      "@papercusp/sync :: test",
    ]);
    expect(out.fullRun).toEqual(["@papercusp/operator-vite"]);
    expect(out.unavailable).toEqual([]);
  });

  it("pairs a workspace-less test-file (a derived pre-schema-4 row) with the ONE bare workspace beside it", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
    ]);
    expect(out.files).toEqual([{ workspace: WEB, file: "lib/a.test.ts" }]);
    expect(out.gateIds).toEqual([]);
    expect(out.fullRun).toEqual([]);
    expect(out.unavailable).toEqual([]);
  });

  it("an unpairable workspace-less test-file (two candidate workspaces) forces the full run, never a guess", () => {
    const out = partitionRepairSignatureEntries([
      entry({ kind: "test-file", id: "lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
      entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
    ]);
    expect(out.files).toEqual([]);
    expect(out.gateIds).toEqual([`${WEB} :: test`, `${CORE} :: test`]);
    expect(out.fullRun).toEqual([]);
    expect(out.unavailable).toEqual(["lib/a.test.ts"]);
  });

  it("WI-10000288: workspace-less test-files beside SEVERAL bare workspaces are paired by the disk resolver, never held as unroutable", () => {
    const DESKTOP = "@papercusp/desktop";
    const UI = "@papercusp/operator-ui";
    const resolver = makeTestWorkspaceResolver("/repo", {
      dirs: ["apps/operator", "packages/operator-core", "packages/operator-ui", "papercusp-desktop"],
      exists: (p) =>
        [
          "/repo/apps/operator/app/_components/chat/SessionChatModal.test.tsx",
          "/repo/packages/operator-core/lib/desktop-install/__tests__/papercusp-files.test.ts",
          "/repo/packages/operator-ui/src/papercup-chat/parity-matrix.test.ts",
          "/repo/papercusp-desktop/test/verify-tauri-headless-assertion-integrity.test.js",
        ].includes(p),
      readFile: (p) =>
        JSON.stringify({
          name: p.includes("apps/operator/")
            ? WEB
            : p.includes("operator-core/")
              ? CORE
              : p.includes("operator-ui/")
                ? UI
                : DESKTOP,
        }),
    });
    const out = partitionRepairSignatureEntries(
      [
        entry({ kind: "workspace-task", id: DESKTOP, workspace: DESKTOP }),
        entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
        entry({ kind: "workspace-task", id: UI, workspace: UI }),
        entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
        entry({ kind: "test-file", id: "app/_components/chat/SessionChatModal.test.tsx" }),
        entry({ kind: "test-file", id: "lib/desktop-install/__tests__/papercusp-files.test.ts" }),
        entry({ kind: "test-file", id: "src/papercup-chat/parity-matrix.test.ts" }),
        entry({ kind: "test-file", id: "test/verify-tauri-headless-assertion-integrity.test.js" }),
      ],
      resolver,
    );
    expect(out.unavailable).toEqual([]);
    expect(out.files).toEqual([
      { workspace: WEB, file: "app/_components/chat/SessionChatModal.test.tsx" },
      { workspace: CORE, file: "lib/desktop-install/__tests__/papercusp-files.test.ts" },
      { workspace: UI, file: "src/papercup-chat/parity-matrix.test.ts" },
      { workspace: DESKTOP, file: "test/verify-tauri-headless-assertion-integrity.test.js" },
    ]);
    // Each workspace's bare `test` task is covered by its own file's re-run.
    expect(out.gateIds).toEqual([]);
    expect(out.fullRun).toEqual([]);
  });

  it("the disk resolver answers null — and the entry stays unroutable — when zero or several workspace dirs contain the file", () => {
    const resolver = makeTestWorkspaceResolver("/repo", {
      dirs: ["apps/operator", "packages/operator-core"],
      exists: (p) => p.endsWith("/lib/shared.test.ts"),
      readFile: () => JSON.stringify({ name: WEB }),
    });
    expect(resolver("lib/shared.test.ts")).toBeNull();
    expect(resolver("lib/nowhere.test.ts")).toBeNull();
    expect(resolver("../escape.test.ts")).toBeNull();
    const out = partitionRepairSignatureEntries(
      [
        entry({ kind: "test-file", id: "lib/shared.test.ts" }),
        entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
        entry({ kind: "workspace-task", id: CORE, workspace: CORE }),
      ],
      resolver,
    );
    expect(out.files).toEqual([]);
    expect(out.unavailable).toEqual(["lib/shared.test.ts"]);
  });
});

describe("P-006 repairSignatureFromVerdict — a verdict names WHICH kinds it measured", () => {
  it("a suite-only verdict (post-suite skipped) measures no lint kind, so a prior lint red survives the extend", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lib/a.test.ts", CORE],
      postSuiteMeasured: false,
    });
    expect(out.failingTests).toEqual(["lib/a.test.ts", CORE]);
    expect(out.measuredKinds).toEqual(["test-file", "workspace-task", "seed"]);
    expect(out.measuredKinds).not.toContain("lint-leg");
    expect(out.measuredKinds).not.toContain("post-suite-leg");
    expect(out.signatureContext.gateRegistry).toBe(NON_TEST_GATE_SCRIPTS);
    expect(out.signatureContext.postSuiteLegIds).toEqual([]);
  });

  it("a verdict whose post-suite phase RAN measures the lint kinds and unions every red leg into the signature", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lib/a.test.ts", "lint:plane-integrity"],
      postSuiteMeasured: true,
      postSuiteLegs: [
        { id: "lint:plane-integrity", status: "failed" },
        { id: "lint:identity-leak", status: "failed" },
        { id: "lint:tsc", status: "passed" },
      ],
    });
    // Deduplicated on id: the leg the suite already named is not doubled.
    expect(out.failingTests).toEqual(["lib/a.test.ts", "lint:plane-integrity", "lint:identity-leak"]);
    expect(out.measuredKinds).toEqual(["test-file", "workspace-task", "seed", "lint-leg", "post-suite-leg"]);
    expect(out.signatureContext.postSuiteLegIds).toEqual(["lint:plane-integrity", "lint:identity-leak"]);
  });

  it("a failed typecheck preflight measured only the ids it names — no kind at all — so nothing prior is erased", () => {
    const out = repairSignatureFromVerdict({
      failingTests: ["lint:tsc"],
      typecheckPreflight: { status: "failed" },
      postSuiteMeasured: false,
    });
    expect(out.failingTests).toEqual(["lint:tsc"]);
    expect(out.measuredKinds).toEqual([]);
  });
});

describe("P-006 verifyRepairHead — the typed signature drives the runners, at the repair head only", () => {
  it.each([
    { selected: 2, workspaces: 1, files: 2, rows: ["lib/a.test.ts"] },
    { selected: 1, workspaces: 2, files: 1, rows: ["lib/a.test.ts"] },
    { selected: 1, workspaces: 1, files: 2, rows: ["lib/a.test.ts"] },
    { selected: 2, workspaces: 1, files: 2, rows: ["lib/a.test.ts", "lib/a.test.ts"] },
  ])("rejects truncated/inconsistent selector counts: $selected/$workspaces/$files", (fixture) => {
    const output = [
      `RELATED_SELECTION ws=${WEB} selected=${fixture.selected} total=5 mode=related reason=ok`,
      `AFFECTED_WS_CMD\t${WEB}\tnpm run --workspace packages/web test`,
      `RELATED_AFFECTED_FILES status=selected workspaces=${fixture.workspaces} files=${fixture.files}`,
      ...fixture.rows.map((file) => `RELATED_AFFECTED_FILE\t${WEB}\t${file}`),
    ].join("\n");
    expect(parseRepairHeadRadius(output)).toBeNull();
  });

  it("cannot mint a complete receipt from a cumulative radius whose initial admission history is missing", async () => {
    const queue = queueWith([entry({ kind: "lint-leg", id: "lint:remaining" })], {
      admissions: [{
        atMs: 2, actor: "test", source: { ref: "staging", sha: HEAD },
        fromRepairHead: "d".repeat(40), toRepairHead: HEAD,
        paths: ["lib/only-retained.ts"], unchanged: [], blobs: { "lib/only-retained.ts": "e".repeat(40) },
      }],
    });
    const deps: RepairHeadVerificationDeps = {
      affectedTestsAtRef: async () => ({ files: [], gateIds: [], summary: "retained radius" }),
      runGateAtRef: async (head, ids) => ({
        pass: false, summary: "remaining failure", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "fail" as const })),
      }),
    };
    const result = await verifyRepairHead(deps, queue);
    expect(result.kind).toBe("red");
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("carries complete coverage across ordinary repair rounds and selects only the new admission radius", async () => {
    const nextHead = "d".repeat(40);
    const firstAdmission: FrozenRepairAdmission = {
      atMs: 2, actor: "test", source: { ref: "staging", sha: HEAD },
      fromRepairHead: CANDIDATE, toRepairHead: HEAD,
      paths: ["lib/first.ts"], unchanged: [], blobs: { "lib/first.ts": "e".repeat(40) },
    };
    const initial = queueWith([entry({ kind: "lint-leg", id: "lint:remaining" })], { admissions: [firstAdmission] });
    const selected: string[][] = [];
    const executed: string[][] = [];
    const deps: RepairHeadVerificationDeps = {
      affectedTestsAtRef: async (_head, paths) => {
        selected.push(paths);
        return {
          files: paths.map((p) => ({ workspace: CORE, file: p.replace(".ts", ".test.ts") })),
          gateIds: [], summary: "exact radius", coverageComplete: true,
        };
      },
      runTestsAtRef: async (head, files) => {
        executed.push(files.map((f) => f.file));
        return {
          pass: true, summary: "all groups passed", measuredHead: head, coverageComplete: true,
          perWorkspace: [{ workspace: CORE, files: files.map((f) => f.file), status: "pass" }],
        };
      },
      runGateAtRef: async (head, ids) => ({
        pass: false, summary: "remaining lint failed", measuredHead: head, coverageComplete: true,
        perGate: ids.map((id) => ({ id, status: "fail" as const })),
      }),
    };
    const first = await verifyRepairHead(deps, initial);
    if (first.kind !== "red") throw new Error("expected first red");
    expect(first.selectiveCoverage).toEqual({ schemaVersion: 1, candidate: CANDIDATE, head: HEAD });
    const measured = markFrozenRepairVerificationRed(initial, {
      repairHead: HEAD, nowMs: 3, failingTests: first.failingTests,
      signature: first.signature, selectiveCoverage: first.selectiveCoverage,
    });
    const next: FrozenCandidateRepairQueue = {
      ...measured, phase: "ready-to-verify", repairHead: nextHead,
      admissions: [firstAdmission, {
        ...firstAdmission, fromRepairHead: HEAD, toRepairHead: nextHead,
        paths: ["lib/second.ts"], blobs: { "lib/second.ts": "f".repeat(40) },
      }],
    };
    const second = await verifyRepairHead(deps, next);
    expect(second).toMatchObject({ kind: "red", failingTests: ["lint:remaining"] });
    expect(second.summary).toContain("REPAIR_RADIUS mode=delta");
    expect(selected).toEqual([["lib/first.ts"], ["lib/second.ts"]]);
    expect(executed).toEqual([["lib/first.test.ts"], ["lib/second.test.ts"]]);
  });

  it("retains a failed coexecution group even when every diagnostic file passes alone", async () => {
    const files = [{ workspace: CORE, file: "lib/a.test.ts" }, { workspace: WEB, file: "lib/b.test.ts" }];
    const queue = queueWith(files.flatMap((f) => [
      entry({ kind: "test-file", id: f.file, workspace: f.workspace }),
      entry({ kind: "workspace-task", id: f.workspace, workspace: f.workspace }),
    ]));
    const deps: RepairHeadVerificationDeps = {
      runTestsAtRef: async () => ({
        pass: false, summary: "core group fails, web passes", measuredHead: HEAD, coverageComplete: true,
        perFile: files.map((f) => ({ ...f, pass: true })),
        perWorkspace: [
          { workspace: CORE, files: [files[0]!.file], status: "fail" },
          { workspace: WEB, files: [files[1]!.file], status: "pass" },
        ],
      }),
    };
    const result = await verifyRepairHead(deps, queue);
    expect(result).toMatchObject({
      kind: "red", failingTests: ["lib/a.test.ts", CORE],
    });
    // Legacy head with no admission chain cannot establish whole prior-radius coverage.
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("retains every legacy coexecution member when diagnostics mix individual passes and failures", async () => {
    const files = [{ workspace: WEB, file: "lib/a.test.ts" }, { workspace: WEB, file: "lib/b.test.ts" }];
    const queue = queueWith([
      ...files.map((f) => entry({ kind: "test-file", id: f.file, workspace: WEB })),
      entry({ kind: "workspace-task", id: WEB, workspace: WEB }),
    ]);
    const result = await verifyRepairHead({
      runTestsAtRef: async () => ({
        pass: false, summary: "group failed; b passes alone",
        perFile: [{ ...files[0]!, pass: false }, { ...files[1]!, pass: true }],
      }),
    }, queue);
    expect(result).toMatchObject({ kind: "red", failingTests: ["lib/a.test.ts", WEB, "lib/b.test.ts"] });
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("does not mint coverage from a legacy aggregate or an errored group", async () => {
    const queue = queueWith([entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE })]);
    const { deps } = recordingDeps({ filesPass: false });
    expect(await verifyRepairHead(deps, queue)).not.toHaveProperty("selectiveCoverage");
    deps.runTestsAtRef = async () => ({
      pass: false, summary: "spawn failed", measuredHead: HEAD, coverageComplete: true,
      perWorkspace: [{ workspace: CORE, files: ["lib/a.test.ts"], status: "errored" }],
    });
    const result = await verifyRepairHead(deps, queue);
    expect(result.kind).toBe("red");
    expect(result).not.toHaveProperty("selectiveCoverage");
  });

  it("requires exact file population and head before using a group result", () => {
    const files = [{ workspace: CORE, file: "lib/a.test.ts" }];
    const result = {
      pass: true, summary: "pass", measuredHead: HEAD,
      perWorkspace: [{ workspace: CORE, files: ["lib/a.test.ts"], status: "pass" as const }],
    };
    expect(validateTargetedFileOutcomes(result, files, HEAD)).toEqual(result.perWorkspace);
    expect(validateTargetedFileOutcomes({ ...result, measuredHead: CANDIDATE }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [] }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [...result.perWorkspace, ...result.perWorkspace] }, files, HEAD)).toBeNull();
    expect(validateTargetedFileOutcomes({ ...result, perWorkspace: [{ workspace: WEB, files: ["lib/a.test.ts"], status: "pass" }] }, files, HEAD)).toBeNull();
  });

  it("retains only the actual failing gate after a complete per-task measurement", async () => {
    const queue = queueWith([
      entry({ kind: "lint-leg", id: "lint:good" }),
      entry({ kind: "lint-leg", id: "lint:bad" }),
      entry({ kind: "lint-leg", id: "lint:later" }),
    ]);
    const { deps } = recordingDeps();
    deps.runGateAtRef = async () => ({
      pass: false,
      summary: "good and later passed; bad failed",
      measuredHead: HEAD,
      perGate: [
        { id: "lint:good", status: "pass" },
        { id: "lint:bad", status: "fail" },
        { id: "lint:later", status: "pass" },
      ],
    });
    const verdict = await verifyRepairHead(deps, queue);
    expect(verdict).toMatchObject({ kind: "red", failingTests: ["lint:bad"] });
  });

  it("holds on a foreign or incomplete gate population, even with aggregate pass", async () => {
    const queue = queueWith([entry({ kind: "lint-leg", id: "lint:required" })]);
    const { deps } = recordingDeps();
    deps.runGateAtRef = async () => ({
      pass: true,
      summary: "wrong task passed",
      measuredHead: HEAD,
      perGate: [{ id: "lint:foreign", status: "pass" }],
    });
    expect(await verifyRepairHead(deps, queue)).toMatchObject({ kind: "unavailable" });
  });

  it("a typed red re-emits files as test-file + workspace-task and a gate from the entry it was re-run from", async () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE, recipe: "npm run test:file -- lib/a.test.ts" }),
      entry({ kind: "workspace-task", id: CORE, workspace: CORE, recipe: `npm run test -w ${CORE}` }),
      // A registry recipe wider than the bare `npm run lint:tsc` — the re-queue must carry it
      // forward from the prior entry rather than re-classify the id.
      entry({ kind: "lint-leg", id: "lint:tsc", recipe: "npm run lint:tsc && npm run lint:tsc:scripts" }),
    ]);
    const { deps, refs, fileRuns, gateRuns } = recordingDeps({ filesPass: false, gatesPass: false });

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("red");
    if (verdict.kind !== "red") throw new Error("unreachable");
    expect(verdict.signature).toEqual([
      { kind: "test-file", id: "lib/a.test.ts", recipe: "npm run test:file -- lib/a.test.ts", workspace: CORE },
      { kind: "workspace-task", id: CORE, recipe: `npm run test -w ${CORE}`, workspace: CORE },
      { kind: "lint-leg", id: "lint:tsc", recipe: "npm run lint:tsc && npm run lint:tsc:scripts" },
    ]);
    expect(verdict.failingTests).toEqual(verdict.signature.map((e) => e.id));
    expect(fileRuns).toEqual([[{ workspace: CORE, file: "lib/a.test.ts" }]]);
    expect(gateRuns).toEqual([["lint:tsc"]]);
    // D-004: every runner call is AT the repair head; the frozen candidate is never handed out.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => ref === HEAD)).toBe(true);
    expect(refs).not.toContain(CANDIDATE);
  });

  it("a post-suite-leg entry is full-run-required — named in the summary, with no runner spent", async () => {
    const queue = queueWith([
      entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE }),
      entry({ kind: "post-suite-leg", id: "@papercusp/operator-vite" }),
    ]);
    const { deps, refs } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("full-run-required");
    expect(verdict.summary).toContain("@papercusp/operator-vite");
    expect(verdict.summary).toContain(HEAD.slice(0, 8));
    expect(refs).toEqual([]);
  });

  it("a typed root seed entry runs its named bounded script — it does not spend the full gate", async () => {
    const queue = queueWith([entry({ kind: "seed", id: "seed:demo" })]);
    const { deps, refs, gateRuns } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("green");
    expect(gateRuns).toEqual([["seed:demo"]]);
    expect(refs).toEqual([HEAD]);
  });

  it("a row handed in without a typed signature is classified from its flat list, the way the parser types a persisted one", async () => {
    const queue = queueWith([], { failingTests: ["lib/a.test.ts", WEB] });
    const { deps, refs, fileRuns, gateRuns } = recordingDeps();

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("green");
    expect(fileRuns).toEqual([[{ workspace: WEB, file: "lib/a.test.ts" }]]);
    // The bare workspace marker is the file's own `test` task — covered, not a second gate run.
    expect(gateRuns).toEqual([]);
    expect(refs).toEqual([HEAD]);
  });

  it("a runner that fails to EXECUTE is `unavailable` — absence of evidence, never a verdict", async () => {
    const queue = queueWith([entry({ kind: "test-file", id: "lib/a.test.ts", workspace: CORE })]);
    const deps: RepairHeadVerificationDeps = {
      runTestsAtRef: async () => {
        throw new Error("tree setup failed");
      },
      runGateAtRef: async () => ({ pass: true, summary: "unused" }),
    };

    const verdict = await verifyRepairHead(deps, queue);

    expect(verdict.kind).toBe("unavailable");
    expect(verdict.summary).toContain("file runner failed to execute");
  });

  describe("the admitted paths' radius is measured beside the signature", () => {
    const admission: FrozenRepairAdmission = {
      atMs: 3,
      actor: "su-test",
      source: { ref: "staging", sha: "d".repeat(40) },
      fromRepairHead: CANDIDATE,
      toRepairHead: HEAD,
      paths: ["lib/x.ts"],
      unchanged: [],
      blobs: { "lib/x.ts": "e".repeat(40) },
    };

    it("without a radius resolver the queue holds unavailable — it never spends the full gate", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, refs } = recordingDeps({ withRadius: false });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("unavailable");
      expect(verdict.summary).toContain("1 admitted path(s)");
      expect(verdict.summary).toContain("without spending the full gate");
      expect(refs).toEqual([]);
    });

    it("a resolvable radius is merged into the file and gate runs, all resolved AT the repair head", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, refs, fileRuns, gateRuns, radiusCalls } = recordingDeps({
        withRadius: true,
        radius: {
          files: [{ workspace: CORE, file: "lib/x.test.ts" }],
          gateIds: [`${CORE} :: lint:tsc:orchestrator`],
          summary: "1 file, 1 leg",
        },
      });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("green");
      expect(radiusCalls).toEqual([["lib/x.ts"]]);
      expect(fileRuns).toEqual([[{ workspace: CORE, file: "lib/x.test.ts" }]]);
      expect(gateRuns).toEqual([["lint:tsc", `${CORE} :: lint:tsc:orchestrator`]]);
      expect(refs.every((ref) => ref === HEAD)).toBe(true);
      expect(refs).toHaveLength(3);
    });

    it("a malformed/unavailable radius holds rather than falling through to the full gate", async () => {
      const queue = queueWith([entry({ kind: "lint-leg", id: "lint:tsc" })], { admissions: [admission] });
      const { deps, fileRuns, gateRuns } = recordingDeps({ withRadius: true, radius: null });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("unavailable");
      expect(verdict.summary).toContain("could not be resolved");
      expect(fileRuns).toEqual([]);
      expect(gateRuns).toEqual([]);
    });

    it("P-003: an over-threshold selector widening runs only the named affected workspace lanes plus signature kinds", async () => {
      const radius = parseRepairHeadRadius([
        "RELATED_SELECTION ws=@papercusp/operator-core selected=40 total=40 mode=full reason=over-threshold widenThreshold=0.95",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-pure",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-stateful",
        "RELATED_AFFECTED_FILES status=full reason=no-complete-exact-file-radius",
      ].join("\n"));
      expect(radius).toEqual({
        files: [],
        coverageComplete: false,
        gateIds: [
          "@papercusp/operator-core :: test:lane-pure",
          "@papercusp/operator-core :: test:lane-stateful",
        ],
        summary: "0 exact related file(s), 2 widened affected test task(s), 0 guard/task leg(s)",
      });

      const queue = queueWith(
        [entry({ kind: "lint-leg", id: "lint:tsc" })],
        { admissions: [admission] },
      );
      const { deps, refs, fileRuns, gateRuns } = recordingDeps({
        withRadius: true,
        radius,
      });

      const verdict = await verifyRepairHead(deps, queue);

      expect(verdict.kind).toBe("green");
      expect(fileRuns).toEqual([]);
      expect(gateRuns).toEqual([[
        "lint:tsc",
        "@papercusp/operator-core :: test:lane-pure",
        "@papercusp/operator-core :: test:lane-stateful",
      ]]);
      expect(refs.every((ref) => ref === HEAD)).toBe(true);
      expect(refs).toHaveLength(2);
    });

    it("keeps an exact related selection on the file runner even with the threshold suffix", () => {
      expect(parseRepairHeadRadius([
        "RELATED_SELECTION ws=@papercusp/operator-core selected=1 total=40 mode=related reason=ok widenThreshold=0.95",
        "AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test",
        "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1",
        "RELATED_AFFECTED_FILE\t@papercusp/operator-core\tlib/x.test.ts",
      ].join("\n"))).toEqual({
        files: [{ workspace: "@papercusp/operator-core", file: "lib/x.test.ts" }],
        gateIds: [],
        coverageComplete: false,
        summary: "1 exact related file(s), 0 widened affected test task(s), 0 guard/task leg(s)",
      });
    });
    it("requires a complete producer census before permitting receipt reuse", () => {
      const output = [
        "AFFECTED_DERIVATION source=explicit changedPaths=1 workspaces=1 guards=0 tasks=1",
        `AFFECTED_WS\t${CORE}`,
        `RELATED_SELECTION ws=${CORE} selected=1 total=5 mode=related reason=ok`,
        `AFFECTED_WS_CMD\t${CORE}\tnpm run --workspace packages/operator-core test`,
        "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1",
        `RELATED_AFFECTED_FILE\t${CORE}\tlib/a.test.ts`,
      ].join("\n");
      expect(parseRepairHeadRadius(output)?.coverageComplete).toBe(true);
      expect(parseRepairHeadRadius(output.replace("tasks=1", "tasks=2"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius(output.replace("guards=0", "guards=1"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius(output.replace("workspaces=1 guards", "workspaces=2 guards"))?.coverageComplete).toBe(false);
      expect(parseRepairHeadRadius("")?.coverageComplete).toBe(false);
    });
  });
});
