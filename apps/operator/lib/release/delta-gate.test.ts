/**
 * Delta-protocol SAFETY GATE tests (agent-tool-delta-protocol-2026-06-22 P-016 / D-008).
 *
 * The gate blocks advancing the green pin when the production semantic-delta flag
 * is ON but the Lane-C scenarios (S23/S24/S25) are not recorded-green-and-fresh.
 * Pure decision table + the IO-seam runner, all deterministic (no PG, no model).
 */

import { describe, expect, it } from 'vitest';

import {
  DELTA_GATE_SCENARIO_IDS,
  DELTA_GATE_DEFAULT_MAX_AGE_MS,
  deltaGatePolicyFromEnv,
  evaluateDeltaGate,
  runDeltaGate,
  type DeltaGatePolicy,
  type ScenarioVerdict,
} from './delta-gate';

const NOW = 1_800_000_000_000;
const POLICY_WARN: DeltaGatePolicy = { enabled: true, block: false, maxAgeMs: DELTA_GATE_DEFAULT_MAX_AGE_MS };
const POLICY_BLOCK: DeltaGatePolicy = { enabled: true, block: true, maxAgeMs: DELTA_GATE_DEFAULT_MAX_AGE_MS };

/** All three scenarios green + fresh. */
function allGreen(): ScenarioVerdict[] {
  return DELTA_GATE_SCENARIO_IDS.map((scenarioId) => ({
    scenarioId,
    status: 'passed' as const,
    finishedAtMs: NOW - 60_000, // a minute ago
  }));
}

describe('evaluateDeltaGate (pure decision table)', () => {
  it('disabled → pass (no-op, reads nothing)', () => {
    const d = evaluateDeltaGate(
      { flagEnabled: true, verdicts: [], now: NOW },
      { enabled: false, block: true, maxAgeMs: DELTA_GATE_DEFAULT_MAX_AGE_MS },
      'abc1234',
    );
    expect(d.action).toBe('pass');
    expect(d.summary).toMatch(/disabled/);
  });

  it('flag OFF → pass (nothing risky shipping), even when armed', () => {
    const d = evaluateDeltaGate({ flagEnabled: false, verdicts: [], now: NOW }, POLICY_BLOCK, 'abc1234');
    expect(d.action).toBe('pass');
    expect(d.summary).toMatch(/flag OFF/);
  });

  it('flag ON + all three green+fresh → pass', () => {
    const d = evaluateDeltaGate({ flagEnabled: true, verdicts: allGreen(), now: NOW }, POLICY_BLOCK, 'abc1234');
    expect(d.action).toBe('pass');
    expect(d.proof.every((p) => p.state === 'green')).toBe(true);
  });

  it('flag ON + a MISSING scenario → warn (not armed) / block (armed)', () => {
    const verdicts = allGreen().filter((v) => v.scenarioId !== 'su-S25-delta-wrong-merge-detector');
    expect(evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_WARN).action).toBe('warn');
    const blocked = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_BLOCK);
    expect(blocked.action).toBe('block');
    expect(blocked.reasons.join()).toMatch(/su-S25-delta-wrong-merge-detector: missing/);
    expect(blocked.proof.find((p) => p.scenarioId === 'su-S25-delta-wrong-merge-detector')!.state).toBe('missing');
  });

  it('flag ON + a STALE green → not proven (warn/block)', () => {
    const verdicts = allGreen();
    verdicts[0] = { ...verdicts[0], finishedAtMs: NOW - DELTA_GATE_DEFAULT_MAX_AGE_MS - 1 };
    const d = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_BLOCK);
    expect(d.action).toBe('block');
    expect(d.proof.find((p) => p.scenarioId === verdicts[0].scenarioId)!.state).toBe('stale');
  });

  it('flag ON + a RED scenario → not proven (warn/block)', () => {
    const verdicts = allGreen();
    verdicts[1] = { ...verdicts[1], status: 'failed' };
    const d = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_BLOCK);
    expect(d.action).toBe('block');
    expect(d.proof.find((p) => p.scenarioId === verdicts[1].scenarioId)!.state).toBe('red');
  });

  it('flag ON + an ERRORED scenario → not proven (errored ≠ green)', () => {
    const verdicts = allGreen();
    verdicts[2] = { ...verdicts[2], status: 'errored' };
    const d = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_WARN);
    expect(d.action).toBe('warn');
    expect(d.proof.find((p) => p.scenarioId === verdicts[2].scenarioId)!.state).toBe('errored');
  });

  // WI-10890: block-mode must never wedge `main` forever on a precondition
  // that cannot become green (all three scenarios consistently red, matching
  // S23-S25's actual state under the current delta-proxy architecture).
  describe('WI-10890 — structurally-unreachable precondition (all-red) escape hatch', () => {
    function allRed(): ScenarioVerdict[] {
      return DELTA_GATE_SCENARIO_IDS.map((scenarioId) => ({
        scenarioId,
        status: 'failed' as const,
        finishedAtMs: NOW - 60_000,
      }));
    }

    it('ALL THREE red + block ARMED → downgrades to warn, and flags unreachable:true', () => {
      const d = evaluateDeltaGate({ flagEnabled: true, verdicts: allRed(), now: NOW }, POLICY_BLOCK, 'abc1234');
      expect(d.action).toBe('warn');
      expect(d.unreachable).toBe(true);
      expect(d.summary).toMatch(/structurally unreachable/);
      expect(d.summary).toMatch(/WI-10890/);
      // still names all three as not-proven, so the signal isn't lost
      expect(d.reasons).toHaveLength(3);
      expect(d.proof.every((p) => p.state === 'red')).toBe(true);
    });

    it('ALL THREE red + block NOT armed → plain warn (unreachable still reported)', () => {
      const d = evaluateDeltaGate({ flagEnabled: true, verdicts: allRed(), now: NOW }, POLICY_WARN, 'abc1234');
      expect(d.action).toBe('warn');
      expect(d.unreachable).toBe(true);
    });

    it('a MIX of red + green (partial failure, NOT the all-red signature) + block armed → still BLOCKS', () => {
      const verdicts = allGreen();
      verdicts[0] = { ...verdicts[0], status: 'failed' };
      const d = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_BLOCK, 'abc1234');
      expect(d.action).toBe('block');
      expect(d.unreachable).toBeUndefined();
    });

    it('a mix of red + missing (still not all-red) + block armed → still BLOCKS', () => {
      const verdicts: ScenarioVerdict[] = [
        { scenarioId: DELTA_GATE_SCENARIO_IDS[0], status: 'failed', finishedAtMs: NOW - 60_000 },
        { scenarioId: DELTA_GATE_SCENARIO_IDS[1], status: null, finishedAtMs: null },
        { scenarioId: DELTA_GATE_SCENARIO_IDS[2], status: 'failed', finishedAtMs: NOW - 60_000 },
      ];
      const d = evaluateDeltaGate({ flagEnabled: true, verdicts, now: NOW }, POLICY_BLOCK, 'abc1234');
      expect(d.action).toBe('block');
      expect(d.unreachable).toBeUndefined();
    });

    it('all green (proven) never reports unreachable', () => {
      const d = evaluateDeltaGate({ flagEnabled: true, verdicts: allGreen(), now: NOW }, POLICY_BLOCK, 'abc1234');
      expect(d.unreachable).toBeUndefined();
    });
  });
});

describe('runDeltaGate (IO seam)', () => {
  const baseIO = {
    readFlagEnabled: async () => true,
    readVerdicts: async () => allGreen(),
    now: () => NOW,
  };

  it('disabled → pass WITHOUT reading flag or verdicts', async () => {
    let read = false;
    const d = await runDeltaGate(
      { enabled: false, block: true, maxAgeMs: DELTA_GATE_DEFAULT_MAX_AGE_MS },
      'abc1234',
      {
        readFlagEnabled: async () => {
          read = true;
          return true;
        },
        readVerdicts: async () => {
          read = true;
          return [];
        },
        now: () => NOW,
      },
    );
    expect(d.action).toBe('pass');
    expect(read).toBe(false);
  });

  it('flag off → pass without reading verdicts', async () => {
    let verdictsRead = false;
    const d = await runDeltaGate(POLICY_BLOCK, 'abc1234', {
      ...baseIO,
      readFlagEnabled: async () => false,
      readVerdicts: async () => {
        verdictsRead = true;
        return [];
      },
    });
    expect(d.action).toBe('pass');
    expect(verdictsRead).toBe(false);
  });

  it('flag on + all green → pass', async () => {
    expect((await runDeltaGate(POLICY_BLOCK, 'abc1234', baseIO)).action).toBe('pass');
  });

  it('flag-read THROWS → fail-closed (assume on, require proof)', async () => {
    // verdicts read fine + all green → still passes (proof present), but the flag
    // is treated as ON, so a missing proof would block.
    const d = await runDeltaGate(POLICY_BLOCK, 'abc1234', {
      ...baseIO,
      readFlagEnabled: async () => {
        throw new Error('flag store down');
      },
      readVerdicts: async () => [],
    });
    expect(d.action).toBe('block'); // no proof + flag assumed on → blocked
  });

  it('verdict-read THROWS → every scenario missing → block (armed)', async () => {
    const d = await runDeltaGate(POLICY_BLOCK, 'abc1234', {
      ...baseIO,
      readVerdicts: async () => {
        throw new Error('pg down');
      },
    });
    expect(d.action).toBe('block');
    expect(d.proof.every((p) => p.state === 'missing')).toBe(true);
  });
});

describe('deltaGatePolicyFromEnv', () => {
  it('defaults to disabled, warn-only, default max-age', () => {
    expect(deltaGatePolicyFromEnv({})).toEqual({
      enabled: false,
      block: false,
      maxAgeMs: DELTA_GATE_DEFAULT_MAX_AGE_MS,
    });
  });

  it('reads the env switches + a custom max-age', () => {
    const p = deltaGatePolicyFromEnv({
      PAPERCUSP_DELTA_GATE: '1',
      PAPERCUSP_DELTA_GATE_BLOCK: '1',
      PAPERCUSP_DELTA_GATE_MAX_AGE_MS: '3600000',
    });
    expect(p).toEqual({ enabled: true, block: true, maxAgeMs: 3_600_000 });
  });

  it('ignores a non-numeric / non-positive max-age (falls back to default)', () => {
    expect(deltaGatePolicyFromEnv({ PAPERCUSP_DELTA_GATE: '1', PAPERCUSP_DELTA_GATE_MAX_AGE_MS: 'nope' }).maxAgeMs).toBe(
      DELTA_GATE_DEFAULT_MAX_AGE_MS,
    );
    expect(deltaGatePolicyFromEnv({ PAPERCUSP_DELTA_GATE: '1', PAPERCUSP_DELTA_GATE_MAX_AGE_MS: '-5' }).maxAgeMs).toBe(
      DELTA_GATE_DEFAULT_MAX_AGE_MS,
    );
  });
});
