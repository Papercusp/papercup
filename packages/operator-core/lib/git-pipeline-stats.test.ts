/**
 * git-pipeline-stats.test.ts — pure unit coverage for the aggregator's helpers
 * (resolver-model resolution + routine-row mapping). The full snapshot read is
 * exercised against real Postgres via the pipeline-events integration test +
 * verified live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolverModel, toRoutineInfo } from './git-pipeline-stats';

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
