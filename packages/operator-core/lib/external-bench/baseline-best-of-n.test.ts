/**
 * Unit tests for the Baseline C best-of-N + test-verifier runner (BRIEF 6 / P-008).
 *
 * Pure orchestration over the deterministic fake ports — no LLM / git / grader / PG. Each test
 * asserts a fairness or correctness invariant of the arm: N-sampling, verifier-driven selection,
 * summed iso-budget accounting, the METR best-effort fallback, and the infra-exclusion paths
 * (whole-arm generation failure, grader error).
 */
import { describe, expect, it } from 'vitest';
import {
  runBestOfNOnce,
  makeFakeBestOfNPorts,
  defaultVerifierScore,
  DEFAULT_BEST_OF_N,
  BASELINE_C_ARM_ID,
  type BestOfNConfig,
  type FakeSampleScript,
} from './baseline-best-of-n';

function baseConfig(overrides: Partial<BestOfNConfig> = {}): BestOfNConfig {
  return {
    runId: 'run-1',
    preregHash: 'prereg-abc',
    suite: 'swe-bench-pro',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'best-of-n@0.1.0',
    task: {
      benchmark: 'swe-bench-pro',
      instanceId: 'instance_astropy__astropy-12345',
      repo: 'astropy/astropy',
      baseCommit: 'a'.repeat(40),
      problemStatement: 'Fix the off-by-one in the WCS transform.',
      graderMeta: { dockerhub_tag: 'astropy-12345', FAIL_TO_PASS: ['test_secret'], PASS_TO_PASS: [] },
    },
    seed: 0,
    budgetTokens: 1000,
    ...overrides,
  };
}

/** A cheap sample (50+50 tokens) so 5 of them stay well under a 1000 budget (capped=false). */
const cheap = (over: Partial<FakeSampleScript> = {}): FakeSampleScript => ({ tokensIn: 50, tokensOut: 50, ...over });

describe('runBestOfNOnce — sampling + emit shape', () => {
  it('samples N times with deterministic inner seeds and emits exactly one baseline-c row', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap() });
    const out = await runBestOfNOnce(baseConfig({ n: 5 }), fake.ports);

    expect(fake.sampledSeeds).toEqual(['0-c0', '0-c1', '0-c2', '0-c3', '0-c4']);
    expect(fake.emitted).toHaveLength(1);
    expect(out.emitted.arm).toBe(BASELINE_C_ARM_ID);
    expect(out.emitted.seed).toBe(0);
    expect(out.emitted.modality).toBe('diff');
    expect(out.emitted.run_id).toBe('run-1');
    expect(out.emitted.prereg_hash).toBe('prereg-abc');
    expect(out.emitted.task_id).toBe('instance_astropy__astropy-12345');
    expect(out.emitted.generation.arm_meta?.n).toBe(5);
    expect(out.emitted.generation.arm_meta?.samples_run).toBe(5);
    expect(out.emitted.generation.arm_meta?.blueprint_id).toBe('coding-solo');
    expect(out.rollout_id).toBe('rollout-1');
  });

  it('defaults N to DEFAULT_BEST_OF_N', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap() });
    await runBestOfNOnce(baseConfig(), fake.ports);
    expect(fake.sampledSeeds).toHaveLength(DEFAULT_BEST_OF_N);
  });
});

describe('runBestOfNOnce — verifier-driven selection (invariant #2: visible-only)', () => {
  it('submits the highest-verifier-score candidate and grades ONLY that diff', async () => {
    // Candidate 2 is the only one whose repro passes ⇒ highest score ⇒ selected.
    const fake = makeFakeBestOfNPorts({
      samples: (i) =>
        cheap({ diff: `patch-${i}`, verify: { reproPassed: i === 2, regressionsPassed: true } }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 4 }), fake.ports);

    expect(out.emitted.generation.arm_meta?.selected_candidate).toBe(2);
    expect(out.emitted.generation.arm_meta?.selection_reason).toBe('verified-best');
    expect(out.emitted.generation.submission).toBe('patch-2');
    expect(out.emitted.generation.trajectory_ref).toBe('traj://0-c2');
    // Exactly the selected diff reaches the grader — not all N.
    expect(fake.gradedPatches).toEqual(['patch-2']);
    expect(out.emitted.grading.status).toBe('passed');
    expect(out.emitted.grading.resolved).toBe(true);
  });

  it('tie-breaks equal scores by fewer tokens, then earliest seed', async () => {
    // All repros pass ⇒ equal score; candidate 1 is cheapest ⇒ wins the tie.
    const fake = makeFakeBestOfNPorts({
      samples: (i) => ({
        diff: `patch-${i}`,
        tokensIn: i === 1 ? 10 : 80,
        tokensOut: i === 1 ? 10 : 80,
        verify: { reproPassed: true, regressionsPassed: true },
      }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.arm_meta?.selected_candidate).toBe(1);
    expect(fake.gradedPatches).toEqual(['patch-1']);
  });

  it('marks the selected candidate in arm_meta.candidates', async () => {
    const fake = makeFakeBestOfNPorts({
      samples: (i) => cheap({ verify: { reproPassed: i === 0 } }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    const cands = out.emitted.generation.arm_meta!.candidates;
    expect(cands).toHaveLength(3);
    expect(cands.filter((c) => c.selected)).toHaveLength(1);
    expect(cands[0].selected).toBe(true);
    expect(cands[0].verifier_pass).toBe(true);
  });
});

describe('runBestOfNOnce — iso-budget accounting (invariant #1: summed)', () => {
  it('tokens_total = SUM over all N candidate attempts + verifier', async () => {
    const fake = makeFakeBestOfNPorts({
      samples: () => cheap({ tokensIn: 50, tokensOut: 50, verify: { tokensIn: 5, tokensOut: 5 } }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 4 }), fake.ports);
    // 4 samples × (50+50) + 4 verifiers × (5+5) = 400 + 40 = 440.
    expect(out.emitted.generation.tokens_in).toBe(4 * 50 + 4 * 5);
    expect(out.emitted.generation.tokens_out).toBe(4 * 50 + 4 * 5);
    expect(out.emitted.generation.tokens_total).toBe(440);
    expect(out.emitted.generation.arm_meta?.verifier.tokens_in).toBe(20);
  });

  it('passes each sample a per-candidate cap of floor(budget/n) and reports budget_tokens', async () => {
    const seenBudgets: number[] = [];
    const fake = makeFakeBestOfNPorts({ samples: () => cheap() });
    const origSample = fake.ports.sample;
    fake.ports.sample = async (input) => {
      seenBudgets.push(input.budgetTokens);
      return origSample(input);
    };
    const out = await runBestOfNOnce(baseConfig({ n: 4, budgetTokens: 1000 }), fake.ports);
    expect(seenBudgets).toEqual([250, 250, 250, 250]); // floor(1000/4)
    expect(out.emitted.generation.budget_tokens).toBe(1000);
    expect(out.emitted.generation.arm_meta?.per_candidate_budget_tokens).toBe(250);
  });

  it('capped=false when samples finish under budget; capped=true when they exhaust it', async () => {
    const under = makeFakeBestOfNPorts({ samples: () => cheap({ tokensIn: 50, tokensOut: 50 }) });
    const outUnder = await runBestOfNOnce(baseConfig({ n: 5, budgetTokens: 1000 }), under.ports);
    expect(outUnder.emitted.generation.capped).toBe(false);

    // Each sample spends its full per-candidate cap (200) ⇒ summed 1000 == budget ⇒ capped.
    const atCap = makeFakeBestOfNPorts({ samples: () => cheap({ tokensIn: 100, tokensOut: 100 }) });
    const outAtCap = await runBestOfNOnce(baseConfig({ n: 5, budgetTokens: 1000 }), atCap.ports);
    expect(outAtCap.emitted.generation.capped).toBe(true);
  });

  it('a budget-exhausted sample stop reason marks the run capped', async () => {
    const fake = makeFakeBestOfNPorts({
      samples: (i) => cheap({ stopReason: i === 0 ? 'budget-exhausted' : 'done' }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.capped).toBe(true);
  });

  it('reserves budget for a model-driven verifier when verifierReserveFrac > 0', async () => {
    const seenBudgets: number[] = [];
    const fake = makeFakeBestOfNPorts({ samples: () => cheap() });
    const origSample = fake.ports.sample;
    fake.ports.sample = async (input) => {
      seenBudgets.push(input.budgetTokens);
      return origSample(input);
    };
    await runBestOfNOnce(baseConfig({ n: 4, budgetTokens: 1000, verifierReserveFrac: 0.2 }), fake.ports);
    // generationBudget = floor(1000 * 0.8) = 800; per-candidate = floor(800/4) = 200.
    expect(seenBudgets).toEqual([200, 200, 200, 200]);
  });
});

describe('runBestOfNOnce — wall clock + turns', () => {
  it('sums turns over samples + verifiers and measures wall clock deterministically', async () => {
    const fake = makeFakeBestOfNPorts({
      samples: () => cheap({ turns: 3, verify: { turns: 1 } }),
      advanceMs: 1000,
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.turns).toBe(3 * 3 + 3 * 1);
    // 3 samples + 3 verifiers + 1 grade = 7 ops × 1000ms.
    expect(out.emitted.generation.wall_clock_ms).toBe(7000);
  });
});

describe('runBestOfNOnce — METR best-effort fallback', () => {
  it('falls back to the cheapest non-empty diff when no candidate verifies (still submits)', async () => {
    // No candidate applies in the verifier ⇒ none "verified" ⇒ fallback to cheapest diff.
    const fake = makeFakeBestOfNPorts({
      samples: (i) => ({
        diff: `patch-${i}`,
        tokensIn: i === 2 ? 10 : 90,
        tokensOut: i === 2 ? 10 : 90,
        verify: { applied: false },
      }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.arm_meta?.selection_reason).toBe('fallback:unverified-diff');
    expect(out.emitted.generation.arm_meta?.selected_candidate).toBe(2); // cheapest
    expect(out.emitted.generation.submission).toBe('patch-2');
    expect(fake.gradedPatches).toEqual(['patch-2']);
  });
});

describe('runBestOfNOnce — infra exclusion (METR)', () => {
  it('whole-arm generation failure → generation error + grading skipped + resolved null, no grade call', async () => {
    const fake = makeFakeBestOfNPorts({
      samples: () => ({ diff: '', generationError: 'sandbox boot failed', tokensIn: 10, tokensOut: 0 }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.status).toBe('error');
    expect(out.emitted.generation.error).toContain('all 3 samples failed');
    expect(out.emitted.generation.submission).toBeUndefined();
    expect(out.emitted.grading.status).toBe('skipped');
    expect(out.emitted.grading.resolved).toBeNull();
    expect(out.emitted.generation.arm_meta?.selected_candidate).toBe(-1);
    expect(fake.gradedPatches).toEqual([]); // nothing graded
  });

  it('a partial generation failure still submits the best usable candidate and marks status completed', async () => {
    // Candidate 0 errors; candidates 1,2 are usable ⇒ run completes with a submission.
    const fake = makeFakeBestOfNPorts({
      samples: (i) =>
        i === 0
          ? { diff: '', generationError: 'one sample crashed', tokensIn: 10, tokensOut: 0 }
          : cheap({ diff: `patch-${i}`, verify: { reproPassed: true } }),
    });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.status).toBe('completed');
    expect(out.emitted.generation.error).toContain('partial');
    expect(out.emitted.generation.arm_meta?.selected_candidate).not.toBe(0);
    expect(['patch-1', 'patch-2']).toContain(out.emitted.generation.submission);
    expect(fake.gradedPatches).toHaveLength(1);
  });

  it('grader infra error → grading status error + resolved null (excluded from accuracy)', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap(), graderError: 'image pull failed' });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.status).toBe('completed');
    expect(out.emitted.grading.status).toBe('error');
    expect(out.emitted.grading.resolved).toBeNull();
    expect(out.emitted.grading.error).toBe('image pull failed');
  });

  it('grader timeout maps to grading status timeout', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap(), graderError: 'grading timeout after 600s' });
    const out = await runBestOfNOnce(baseConfig({ n: 2 }), fake.ports);
    expect(out.emitted.grading.status).toBe('timeout');
    expect(out.emitted.grading.resolved).toBeNull();
  });
});

describe('runBestOfNOnce — not-resolved (genuine fail, scoreable)', () => {
  it('a non-resolving submission yields grading failed + resolved false (NOT excluded)', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap({ diff: 'bad-patch' }), resolves: () => false });
    const out = await runBestOfNOnce(baseConfig({ n: 3 }), fake.ports);
    expect(out.emitted.generation.status).toBe('completed');
    expect(out.emitted.grading.status).toBe('failed');
    expect(out.emitted.grading.resolved).toBe(false);
  });
});

describe('cache token accounting', () => {
  it('emits null cache columns (the shared generation unit carries no cache breakdown yet)', async () => {
    const fake = makeFakeBestOfNPorts({ samples: () => cheap() });
    const out = await runBestOfNOnce(baseConfig({ n: 2 }), fake.ports);
    expect(out.emitted.generation.tokens_cache_read).toBeNull();
    expect(out.emitted.generation.tokens_cache_write).toBeNull();
  });
});

describe('defaultVerifierScore', () => {
  it('is 0 for a non-applying candidate', () => {
    expect(defaultVerifierScore({ applied: false, reproPassed: true, regressionsPassed: true, visiblePassed: 2, visibleTotal: 2 })).toBe(0);
  });
  it('ranks repro-pass above no-regressions above visible-fraction', () => {
    const repro = defaultVerifierScore({ applied: true, reproPassed: true, regressionsPassed: false, visiblePassed: 1, visibleTotal: 2 });
    const noRepro = defaultVerifierScore({ applied: true, reproPassed: false, regressionsPassed: true, visiblePassed: 1, visibleTotal: 2 });
    expect(repro).toBeGreaterThan(noRepro);
  });
  it('is monotonic and bounded in [0,1]', () => {
    const best = defaultVerifierScore({ applied: true, reproPassed: true, regressionsPassed: true, visiblePassed: 2, visibleTotal: 2 });
    expect(best).toBeCloseTo(1, 5);
  });
});
