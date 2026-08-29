import { describe, expect, it } from "vitest";

import {
  DEFAULT_TARGETED_REVERDICT_LIMITS,
  TARGETED_REVERDICT_ENABLED,
  assessTargetedReVerdict,
  planTargetedReVerdict,
  type TargetedReVerdictFile,
  type TargetedReVerdictPlan,
  type TargetedReVerdictPlanInput,
  type TargetedReVerdictRunResult,
} from "./targeted-reverdict.js";

const CANDIDATE = "8104d3804ac4aa11bb22cc33dd44ee55ff667788";
const TIP = "ffeeddccbbaa00998877665544332211aabbccdd";

const file = (workspace: string, name: string): TargetedReVerdictFile => ({
  workspace,
  file: name,
});

function baseInput(
  over: Partial<TargetedReVerdictPlanInput> = {},
): TargetedReVerdictPlanInput {
  return {
    candidate: CANDIDATE,
    tip: TIP,
    candidateGreen: false,
    candidateCoverage: "full-suite",
    candidateFailingFiles: [file("packages/operator-core", "lib/a.test.ts")],
    changedPathsSinceCandidate: ["packages/operator-core/lib/a.ts"],
    affectedWorkspaces: ["packages/operator-core"],
    affectedFiles: [file("packages/operator-core", "lib/b.test.ts")],
    incrementalChainDepth: 0,
    msSinceLastFullSuiteVerdict: 10 * 60_000,
    ...over,
  };
}

function admitted(
  over: Partial<TargetedReVerdictPlanInput> = {},
): Extract<TargetedReVerdictPlan, { admitted: true }> {
  const plan = planTargetedReVerdict(baseInput(over));
  if (!plan.admitted)
    throw new Error(`expected an admitted plan, got ${plan.reasonCode}`);
  return plan;
}

/**
 * The DELIBERATELY-WRONG control, kept permanently beside the real assessor.
 *
 * This is the implementation an agent reaches for first: "every result came back passing, so
 * upgrade." It is what {@link assessTargetedReVerdict} must beat, and several tests below
 * assert that it accepts a case the real assessor refuses. Without the control those tests
 * would only prove that the real assessor said no — not that saying no was the hard part.
 */
function naiveUpgrade(results: readonly TargetedReVerdictRunResult[]): boolean {
  return results.every((r) => r.passed);
}

describe("targeted-reverdict: activation", () => {
  it("ships enabled behind fail-closed admission and assessment", () => {
    expect(TARGETED_REVERDICT_ENABLED).toBe(true);
  });
});

describe("planTargetedReVerdict: admission", () => {
  it("admits a bounded red against a newer tip and names the TIP, never the candidate", () => {
    const plan = admitted();
    expect(plan.verdictSha).toBe(TIP);
    expect(plan.verdictSha).not.toBe(CANDIDATE);
    expect(plan.candidate).toBe(CANDIDATE);
    expect(plan.coverageBasis.carriedFrom).toBe(CANDIDATE);
    expect(plan.coverageBasis.chainDepth).toBe(1);
  });

  it("re-runs the failing set UNION the affected radius, de-duplicated", () => {
    const shared = file("packages/operator-core", "lib/shared.test.ts");
    const plan = admitted({
      candidateFailingFiles: [
        shared,
        file("packages/operator-core", "lib/a.test.ts"),
      ],
      affectedFiles: [shared, file("apps/operator", "lib/c.test.ts")],
    });
    expect(plan.reRunFiles).toHaveLength(3);
    expect(plan.reRunWorkspaces).toEqual([
      "apps/operator",
      "packages/operator-core",
    ]);
  });

  it("admits an empty diff with an empty radius (nothing changed, nothing to cover)", () => {
    const plan = admitted({
      changedPathsSinceCandidate: [],
      affectedWorkspaces: [],
      affectedFiles: [],
    });
    expect(plan.reRunFiles).toHaveLength(1);
    expect(plan.coverageBasis.changedPaths).toEqual([]);
  });
});

describe("planTargetedReVerdict: refusals", () => {
  const cases: Array<{
    name: string;
    over: Partial<TargetedReVerdictPlanInput>;
    reasonCode: string;
  }> = [
    {
      name: "a green base has nothing to upgrade",
      over: { candidateGreen: true },
      reasonCode: "not-red",
    },
    {
      name: "an absent base verdict is not a base",
      over: { candidateGreen: null },
      reasonCode: "not-red",
    },
    {
      name: "the tip equals the candidate",
      over: { tip: CANDIDATE },
      reasonCode: "no-newer-tip",
    },
    {
      name: "partial candidate coverage cannot be carried forward",
      over: { candidateCoverage: "partial" },
      reasonCode: "candidate-coverage-not-full",
    },
    {
      name: "unknown coverage is NOT read as full-suite",
      over: { candidateCoverage: "unknown" },
      reasonCode: "candidate-coverage-not-full",
    },
    {
      name: "a red with no failing-file signature has no targeted question",
      over: { candidateFailingFiles: [] },
      reasonCode: "failing-set-empty",
    },
    {
      name: "a broad red is a real regression",
      over: {
        candidateFailingFiles: Array.from(
          { length: DEFAULT_TARGETED_REVERDICT_LIMITS.maxFailingFiles + 1 },
          (_, i) => file("packages/operator-core", `lib/f${i}.test.ts`),
        ),
      },
      reasonCode: "failing-set-unbounded",
    },
    {
      name: "an uncomputable diff leaves the radius unknown",
      over: { changedPathsSinceCandidate: null },
      reasonCode: "diff-unavailable",
    },
    {
      name: "a diff with no derivable radius is refused",
      over: { affectedWorkspaces: null },
      reasonCode: "affected-radius-unavailable",
    },
    {
      name: "a non-empty diff selecting ZERO workspaces is refused, not treated as safe",
      over: { affectedWorkspaces: [], affectedFiles: [] },
      reasonCode: "affected-radius-empty-with-diff",
    },
    {
      name: "a radius wider than the cap is a full suite wearing a targeted label",
      over: {
        affectedWorkspaces: Array.from(
          {
            length: DEFAULT_TARGETED_REVERDICT_LIMITS.maxAffectedWorkspaces + 1,
          },
          (_, i) => `packages/w${i}`,
        ),
      },
      reasonCode: "affected-radius-too-wide",
    },
    {
      name: "no full-suite verdict on record",
      over: { msSinceLastFullSuiteVerdict: null },
      reasonCode: "full-suite-overdue",
    },
    {
      name: "the last full suite is older than the cadence bound",
      over: {
        msSinceLastFullSuiteVerdict:
          DEFAULT_TARGETED_REVERDICT_LIMITS.fullSuiteMaxAgeMs + 1,
      },
      reasonCode: "full-suite-overdue",
    },
    {
      name: "the incremental chain is exhausted",
      over: {
        candidateCoverage: "incremental",
        incrementalChainDepth: DEFAULT_TARGETED_REVERDICT_LIMITS.maxChainDepth,
      },
      reasonCode: "incremental-chain-exhausted",
    },
    {
      name: "a re-run that cannot finish inside the freshness window",
      over: {
        estimatedRunDurationMs:
          DEFAULT_TARGETED_REVERDICT_LIMITS.freshnessBudgetMs + 1,
      },
      reasonCode: "cannot-finish-in-freshness-window",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const plan = planTargetedReVerdict(baseInput(c.over));
      expect(plan.admitted).toBe(false);
      if (plan.admitted) throw new Error("unreachable");
      expect(plan.reasonCode).toBe(c.reasonCode);
      expect(plan.summary).toContain("targeted-reverdict");
    });
  }

  it("admits the last chain slot but refuses the one past it", () => {
    const max = DEFAULT_TARGETED_REVERDICT_LIMITS.maxChainDepth;
    const ok = planTargetedReVerdict(
      baseInput({
        candidateCoverage: "incremental",
        incrementalChainDepth: max - 1,
      }),
    );
    expect(ok.admitted).toBe(true);
    const refused = planTargetedReVerdict(
      baseInput({ candidateCoverage: "incremental", incrementalChainDepth: max }),
    );
    expect(refused.admitted).toBe(false);
  });
});

describe("assessTargetedReVerdict", () => {
  const resultsFor = (
    plan: Extract<TargetedReVerdictPlan, { admitted: true }>,
    over: Partial<TargetedReVerdictRunResult> = {},
  ): TargetedReVerdictRunResult[] =>
    plan.reRunFiles.map((f) => ({
      workspace: f.workspace,
      file: f.file,
      passed: true,
      executedCount: 3,
      ...over,
    }));

  it("upgrades when every planned file passes, and names the measured sha", () => {
    const plan = admitted();
    const outcome = assessTargetedReVerdict({
      plan,
      results: resultsFor(plan),
    });
    expect(outcome.upgraded).toBe(true);
    if (!outcome.upgraded) throw new Error("unreachable");
    expect(outcome.verdictSha).toBe(TIP);
    expect(outcome.tipMovedDuringRun).toBe(false);
    expect(outcome.coverageBasis.carriedFrom).toBe(CANDIDATE);
  });

  it("still names the MEASURED sha when the tip advanced mid-run, and flags the debt", () => {
    const plan = admitted();
    const outcome = assessTargetedReVerdict({
      plan,
      results: resultsFor(plan),
      tipAtCompletion: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(outcome.upgraded).toBe(true);
    if (!outcome.upgraded) throw new Error("unreachable");
    // The verdict must never drift onto a sha whose content was not run.
    expect(outcome.verdictSha).toBe(TIP);
    expect(outcome.tipMovedDuringRun).toBe(true);
    expect(outcome.summary).toContain("further re-verdict is owed");
  });

  it("keeps the red when a planned file still fails", () => {
    const plan = admitted();
    const results = resultsFor(plan);
    results[0] = { ...results[0], passed: false };
    const outcome = assessTargetedReVerdict({ plan, results });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("still-failing");
    expect(outcome.offendingFiles).toHaveLength(1);
  });

  it("keeps the red when a file errored — undetermined is not passing", () => {
    const plan = admitted();
    const results = resultsFor(plan);
    // A timeout reports errored WITHOUT reporting a failure; the naive control, which only
    // reads `passed`, would upgrade on this.
    results[0] = { ...results[0], passed: false, errored: true };
    const outcome = assessTargetedReVerdict({ plan, results });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("run-errored");
  });

  it("refuses a PASS that executed zero tests — where the naive control would upgrade", () => {
    const plan = admitted();
    const results = resultsFor(plan, { executedCount: 0 });
    // Control: the obvious implementation accepts this outright.
    expect(naiveUpgrade(results)).toBe(true);
    const outcome = assessTargetedReVerdict({ plan, results });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("zero-tests-executed");
  });

  it("refuses an incomplete result set — where the naive control would upgrade", () => {
    const plan = admitted();
    const results = resultsFor(plan).slice(0, 1);
    expect(results.length).toBeLessThan(plan.reRunFiles.length);
    // Control: `every` over a truncated list is vacuously satisfied.
    expect(naiveUpgrade(results)).toBe(true);
    const outcome = assessTargetedReVerdict({ plan, results });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("results-incomplete");
  });

  it("refuses an EMPTY result set — where the naive control would upgrade vacuously", () => {
    const plan = admitted();
    expect(naiveUpgrade([])).toBe(true);
    const outcome = assessTargetedReVerdict({ plan, results: [] });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("results-incomplete");
  });

  it("refuses results for files that were never planned", () => {
    const plan = admitted();
    const outcome = assessTargetedReVerdict({
      plan,
      results: [
        ...resultsFor(plan),
        {
          workspace: "packages/somewhere-else",
          file: "lib/unrelated.test.ts",
          passed: true,
          executedCount: 1,
        },
      ],
    });
    expect(outcome.upgraded).toBe(false);
    if (outcome.upgraded) throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("results-unplanned");
  });

  it("tolerates a runner that does not report an execution count", () => {
    const plan = admitted();
    const results = resultsFor(plan).map(
      ({ executedCount: _drop, ...rest }) => rest,
    );
    const outcome = assessTargetedReVerdict({ plan, results });
    expect(outcome.upgraded).toBe(true);
  });

  it("CALIBRATION: the real assessor still upgrades a genuinely clean run", () => {
    // Without this, every refusal test above would also pass against an assessor that
    // refuses unconditionally — which would be a guard that measures nothing.
    const plan = admitted();
    const results = resultsFor(plan);
    expect(naiveUpgrade(results)).toBe(true);
    expect(assessTargetedReVerdict({ plan, results }).upgraded).toBe(true);
  });
});
