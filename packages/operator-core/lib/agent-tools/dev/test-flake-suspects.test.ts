/**
 * flagFlakeSuspects (EI-7443) — the flake-vs-regression detector folded into
 * dev:build_status as `flake_suspects`. Mirrors telemetry-poll-suspects.test.ts's
 * shape: a pure fixture-driven test of the threshold/flag decision, independent
 * of the live SQL rollup (testFlakeRollup) which needs a real PG (VERIFY step is
 * a live dev:pg_query run, not this unit test).
 *
 * The core distinction under test: a file that FAILS A LOT but only ever on its
 * own commit (fail-only shas) is a REGRESSION, not a flake — never flag it. A
 * file whose SAME commit shows BOTH a pass and a fail (repeated across ≥2 commits)
 * cannot be reflecting that commit's own correctness — that is the flake
 * signature this guard exists to surface.
 */
import { describe, expect, it } from 'vitest';
import {
  flagFlakeSuspects,
  FLAKE_SUSPECT_MIN_FAILS,
  FLAKE_SUSPECT_MIN_BOTH_STATUS_SHAS,
  type TestFlakeEntry,
} from '../../dev-data';

function entry(overrides: Partial<TestFlakeEntry>): TestFlakeEntry {
  return {
    file_path: 'some/file.test.ts',
    fails: 0,
    passes: 0,
    both_status_shas: 0,
    flake_rate: 0,
    last_fail: null,
    last_pass: null,
    ...overrides,
  };
}

describe('flagFlakeSuspects', () => {
  it('flags a mixed-status file: many fails, repeated pass+fail on the same commit', () => {
    // e.g. misc.test.ts 15F/52P from the EI-7443 evidence — flaky, not broken.
    const flaky = entry({
      file_path: 'misc.test.ts',
      fails: 15,
      passes: 52,
      both_status_shas: 4,
      flake_rate: 0.224,
    });
    const out = flagFlakeSuspects([flaky], 7);
    expect(out).toHaveLength(1);
    expect(out[0].file_path).toBe('misc.test.ts');
    expect(out[0].reason).toContain('flake-shaped');
    expect(out[0].reason).toContain('EI-7443');
  });

  it('does NOT flag a fail-only file (a real regression, not a flake)', () => {
    // Every fail is on its OWN commit — no commit shows both a pass and a fail.
    const regression = entry({
      file_path: 'broken-feature.test.ts',
      fails: 12,
      passes: 0,
      both_status_shas: 0,
    });
    expect(flagFlakeSuspects([regression], 7)).toHaveLength(0);
  });

  it('does NOT flag a low-volume file even with a mixed-status commit', () => {
    // Below the MIN_FAILS floor — a 2-off blip is noise, not a pattern worth alerting on.
    const lowVolume = entry({
      file_path: 'rarely-run.test.ts',
      fails: 2,
      passes: 3,
      both_status_shas: 1,
    });
    expect(flagFlakeSuspects([lowVolume], 7)).toHaveLength(0);
  });

  it('does NOT flag a busy file with only ONE mixed-status commit (could be fixed-then-re-broken)', () => {
    const single = entry({
      file_path: 'once-flipped.test.ts',
      fails: 10,
      passes: 40,
      both_status_shas: 1,
    });
    expect(flagFlakeSuspects([single], 7)).toHaveLength(0);
  });

  it('applies both thresholds exactly at the boundary', () => {
    const boundary = entry({
      file_path: 'edge:case',
      fails: FLAKE_SUSPECT_MIN_FAILS,
      passes: 10,
      both_status_shas: FLAKE_SUSPECT_MIN_BOTH_STATUS_SHAS,
    });
    expect(flagFlakeSuspects([boundary], 7)).toHaveLength(1);

    const justUnderFails = entry({
      file_path: 'edge:under-fails',
      fails: FLAKE_SUSPECT_MIN_FAILS - 1,
      passes: 10,
      both_status_shas: FLAKE_SUSPECT_MIN_BOTH_STATUS_SHAS,
    });
    expect(flagFlakeSuspects([justUnderFails], 7)).toHaveLength(0);

    const justUnderShas = entry({
      file_path: 'edge:under-shas',
      fails: FLAKE_SUSPECT_MIN_FAILS,
      passes: 10,
      both_status_shas: FLAKE_SUSPECT_MIN_BOTH_STATUS_SHAS - 1,
    });
    expect(flagFlakeSuspects([justUnderShas], 7)).toHaveLength(0);
  });

  it('sorts worst-first by fail count, ties broken by flake-signature strength', () => {
    const worst = entry({ file_path: 'w', fails: 20, both_status_shas: 5 });
    const mild = entry({ file_path: 'm', fails: 8, both_status_shas: 2 });
    const tiedHigherSig = entry({ file_path: 't-hi', fails: 8, both_status_shas: 4 });
    const out = flagFlakeSuspects([mild, worst, tiedHigherSig], 7);
    expect(out.map((s) => s.file_path)).toEqual(['w', 't-hi', 'm']);
  });

  it('survives an empty entry list', () => {
    expect(flagFlakeSuspects([], 7)).toEqual([]);
  });

  it('carries every source field through onto the suspect (additive, not lossy)', () => {
    const e = entry({
      file_path: 'x.test.ts',
      fails: 9,
      passes: 30,
      both_status_shas: 3,
      flake_rate: 0.231,
      last_fail: '2026-07-05T10:00:00.000Z',
      last_pass: '2026-07-05T11:00:00.000Z',
    });
    const out = flagFlakeSuspects([e], 7);
    expect(out[0]).toMatchObject({
      file_path: 'x.test.ts',
      fails: 9,
      passes: 30,
      both_status_shas: 3,
      flake_rate: 0.231,
      last_fail: '2026-07-05T10:00:00.000Z',
      last_pass: '2026-07-05T11:00:00.000Z',
    });
  });
});
