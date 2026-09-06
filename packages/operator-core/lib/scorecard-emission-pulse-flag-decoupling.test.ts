/**
 * scorecard-emission-pulse — the FLAG-DECOUPLING guard
 * (retire-mug-kettle-su-only-2026-08-09 P-035 / D-015).
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM scorecard-emission-pulse.test.ts:
 * that suite is deliberately hermetic — "fully deps-injected: no PG / flags /
 * vi.mock" — and every one of its cases passes `enabled` explicitly. That is the
 * right shape for the pulse's LOGIC, but it means the suite is structurally
 * blind to the question asked here: which flag does the pulse read when the
 * caller injects NOTHING? Reverting the default to `overwatchEnabled` leaves
 * that whole suite green. So this guard mocks the flag store and exercises the
 * DEFAULT path on purpose, and it lives in its own file so the hermetic suite
 * keeps its no-vi.mock property.
 *
 * THE REGRESSION IT POLICES (measured 2026-08-09): the pulse is the deterministic
 * FLOOR that keeps `pot-coordination-health` scorecards landing when no agent
 * emits one — it exists BECAUSE the supervisor may be stopped or dead. It used to
 * gate on `overwatchEnabled()` (= FLAGS.OVERWATCH), the flag of the very agent it
 * backstops. Retiring the Kettle therefore returned
 * `{ outcome:'skipped', reason:'papercusp-overwatch flag off' }` — no throw, no
 * alarm, emission silently stops. That is WI-2374's original silent death (there:
 * the `started` bit) reintroduced one level up (here: the flag).
 *
 * FALSIFIABILITY: the load-bearing case is `overwatch OFF + pulse ON => does NOT
 * skip`, which FAILS if the default gate is put back to the overwatch flag. It is
 * paired with a calibration case (`pulse OFF => skips`) so the pair cannot both
 * pass by the gate having been deleted altogether.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Flag store the mocked `getFlag` reads. Keyed by flag KEY string, set per test. */
const flagValues = new Map<string, boolean>();
/** Every flag key the code under test actually asked for, in order. */
const flagReads: string[] = [];

vi.mock('@papercusp/flags/server', async (importOriginal) => {
  // Spread the original: this module has other exports, and a partial mock makes
  // unrelated importers in the graph fail to COLLECT with an error naming neither
  // this file nor this change.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getFlag: vi.fn(async (key: string) => {
      flagReads.push(key);
      return flagValues.get(key) ?? false;
    }),
  };
});

import { FLAGS } from '@papercusp/flags';
import {
  runScorecardEmissionPulse,
  scorecardEmissionPulseEnabled,
  type ScorecardEmissionPulseDeps,
} from './scorecard-emission-pulse';
import { COORDINATION_RUBRIC_REF } from './overwatch/scorecard-backstop';
import type { SystemHealth } from './system-health/types';
import type { ScorecardFreshness } from './scorecard-freshness';

const EMPTY_HEALTH = { panels: {}, evaluatedAt: 0 } as unknown as SystemHealth;

function staleFreshness(): ScorecardFreshness {
  return {
    rubricRef: COORDINATION_RUBRIC_REF,
    since: '2026-08-09T00:00:00Z',
    status: 'stale',
    rubricKnown: true,
    emitted: false,
    complete: false,
    count: 0,
    partialCount: 0,
    lastEmittedAt: null,
    lastCompleteAt: null,
    latestMissingKeys: [],
    latestExtraKeys: [],
  };
}

/**
 * Every dep EXCEPT `enabled` — that omission is the entire point, so the pulse
 * falls through to its DEFAULT gate. The rest are stubbed hermetically (the real
 * ones hit PG).
 */
function depsWithoutEnabled(): {
  deps: ScorecardEmissionPulseDeps;
  capture: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn(async () => ({}) as never);
  return {
    capture,
    deps: {
      controlState: async () => ({ potSlug: 'papercusp' }) as never,
      freshness: vi.fn(async () => staleFreshness()),
      computeHealth: async () => EMPTY_HEALTH,
      capture: capture as never,
      recordFire: vi.fn(async () => {}),
      toolUtilizationGrade: async () => undefined,
      findOpenPulseFloor: async () => null,
      bumpPulseRepeat: vi.fn(async () => {}) as never,
    },
  };
}

beforeEach(() => {
  flagValues.clear();
  flagReads.length = 0;
});

describe('scorecard-emission-pulse: gate is decoupled from the overwatch flag (D-015)', () => {
  it('reads its OWN flag, not the overwatch flag', async () => {
    flagValues.set(FLAGS.SCORECARD_EMISSION_PULSE, true);

    await expect(scorecardEmissionPulseEnabled()).resolves.toBe(true);

    expect(flagReads).toContain(FLAGS.SCORECARD_EMISSION_PULSE);
    // The regression, stated directly: the floor must never consult the flag of
    // the agent it backstops.
    expect(flagReads).not.toContain(FLAGS.OVERWATCH);
  });

  it('THE RETIREMENT SCENARIO: overwatch flag OFF + pulse flag ON => still files the floor', async () => {
    // Exactly the post-retirement state: the Kettle's flag is off for good.
    flagValues.set(FLAGS.OVERWATCH, false);
    flagValues.set(FLAGS.SCORECARD_EMISSION_PULSE, true);

    const { deps, capture } = depsWithoutEnabled();
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws-test' }, deps);

    // Fails loudly if the default gate is reverted to overwatchEnabled: the pulse
    // would come back `skipped: papercusp-overwatch flag off`.
    expect(r.outcome).toBe('filed');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('CALIBRATION: its own flag OFF => skips (the gate still exists and still bites)', async () => {
    // Overwatch ON here, so a pass cannot come from reading the wrong flag.
    flagValues.set(FLAGS.OVERWATCH, true);
    flagValues.set(FLAGS.SCORECARD_EMISSION_PULSE, false);

    const { deps, capture } = depsWithoutEnabled();
    const r = await runScorecardEmissionPulse({ workspaceId: 'ws-test' }, deps);

    expect(r.outcome).toBe('skipped');
    expect(r.reason).toContain('papercusp-scorecard-emission-pulse');
    expect(capture).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the flag store throws (never files unbidden)', async () => {
    const { getFlag } = await import('@papercusp/flags/server');
    vi.mocked(getFlag).mockRejectedValueOnce(new Error('flag store down'));

    await expect(scorecardEmissionPulseEnabled()).resolves.toBe(false);
  });
});
