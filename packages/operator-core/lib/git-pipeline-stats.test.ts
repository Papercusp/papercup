/**
 * git-pipeline-stats.test.ts — pure unit coverage for the aggregator's helpers
 * (resolver-model resolution + routine-row mapping). The full snapshot read is
 * exercised against real Postgres via the pipeline-events integration test +
 * verified live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolverModel, toRoutineInfo, pinProvenGateCorrection, type RawGateCounters } from './git-pipeline-stats';

describe('resolverModel', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the merge-resolver spec from AGENT_MODELS', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus', 'merge-resolver': 'opus:xhigh' }));
    expect(resolverModel()).toBe('opus:xhigh');
  });

  it('falls back to the committed default when unset or malformed', () => {
    vi.stubEnv('AGENT_MODELS', '');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', '{not json');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus' })); // no merge-resolver key
    expect(resolverModel()).toBe('opus:xhigh');
  });
});

describe('toRoutineInfo', () => {
  it('returns null for a missing routine', () => {
    expect(toRoutineInfo(undefined)).toBeNull();
  });

  it('maps a routine row into the typed info (cron from trigger_config, dates → ms)', () => {
    const fired = new Date('2026-06-06T11:00:00Z');
    const next = new Date('2026-06-06T11:10:00Z');
    const info = toRoutineInfo({
      name: 'git-sync',
      active: true,
      trigger_config: { cron: '0 */10 * * * *', push: true },
      metadata: {},
      last_fired_at: fired,
      next_fire_at: next,
    });
    expect(info).toEqual({
      name: 'git-sync',
      active: true,
      cron: '0 */10 * * * *',
      lastFiredAtMs: fired.getTime(),
      nextFireAtMs: next.getTime(),
    });
  });

  it('tolerates a null trigger_config / null schedule timestamps', () => {
    const info = toRoutineInfo({
      name: 'release-trigger',
      active: false,
      trigger_config: null,
      metadata: null,
      last_fired_at: null,
      next_fire_at: null,
    });
    expect(info).toMatchObject({ name: 'release-trigger', active: false, cron: null, lastFiredAtMs: null, nextFireAtMs: null });
  });
});

/**
 * EI-13714 — the gate reports "STALLED — N consecutive reds" long after it has GREENED, because
 * the raw `gate_health` counters (`consecutiveReds` / `stalled` / `failingTests`) are the cache
 * `verdictStale` already proves superseded, yet every reader (`release:deploy{op:status}`, the
 * `/admin` Git tab, `dev:pipeline_position`) reported them unchanged in the SAME response that
 * carried `verdictStale:true` with a pin-advance reason. `pinProvenGateCorrection` is the single
 * point that resets those counters — pure, so it's covered here without a live Postgres (the full
 * `gitPipelineSnapshot` read that calls it is only exercised via integration test / live).
 */
describe('pinProvenGateCorrection (EI-13714)', () => {
  const RAW: RawGateCounters = {
    consecutiveReds: 11,
    stalled: true,
    failingTests: ['apps/operator/lib/some.test.ts'],
    firstRedAtMs: 1_700_000_000_000,
  };

  it('⭐ resets the streak to 0 when the pin advance PROVES a green happened since', () => {
    const out = pinProvenGateCorrection('pin-advance', RAW);
    expect(out).toEqual({ consecutiveReds: 0, stalled: false, failingTests: [], firstRedAtMs: null });
  });

  it('leaves the raw counters untouched for writer-starved (unverified, not proven green)', () => {
    expect(pinProvenGateCorrection('writer-starved', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched for retriage-proven (proves specific tests, not full-suite green)', () => {
    expect(pinProvenGateCorrection('retriage-proven', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched when the verdict is not stale at all', () => {
    expect(pinProvenGateCorrection(null, RAW)).toEqual(RAW);
  });
});
