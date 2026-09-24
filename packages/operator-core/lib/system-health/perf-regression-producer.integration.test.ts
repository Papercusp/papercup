import { describe, expect, it, vi } from 'vitest';
import {
  collectPerfRegressionWhenDue,
  readPerfRegressionProducerHealth,
  PERF_REGRESSION_SAMPLE_INTERVAL_MS,
} from './perf-regression-rig';
import { infraStatus, infraSummary } from './thresholds';
import type { InfraHealth } from './types';

// Exercise the producer -> persisted timestamp -> independent reader -> Infra
// contract. Storage and clock are injected; no production database is mutated.
function fixture() {
  const start = Date.parse('2026-09-23T12:00:00Z');
  let now = start;
  let persisted: Date | null = new Date(start);
  const collect = vi.fn(async () => {
    persisted = new Date(now);
    return { signals: [], note: undefined as string | undefined };
  });
  const deps = {
    nowMs: () => now,
    latestCapturedAt: async () => persisted,
    isEnabled: async () => true,
    collect,
  };
  return {
    start, deps, collect,
    advance: (ms: number) => { now += ms; },
    setPersisted: (value: Date | null) => { persisted = value; },
  };
}

async function infraFor(f: ReturnType<typeof fixture>): Promise<InfraHealth> {
  return {
    pg: { version: 'test', total: 2, active: 1, idle: 1, postmasterStartMs: null },
    gatewayReachable: true, perf: null, mcpProxy: null,
    performanceHistory: await readPerfRegressionProducerHealth('ws', f.deps),
  };
}

describe('performance producer freshness in the Infra health surface', () => {
  it('detects a stopped producer after two missed intervals without invoking it', async () => {
    const f = fixture();
    f.advance(2 * PERF_REGRESSION_SAMPLE_INTERVAL_MS - 1);
    expect(infraStatus(await infraFor(f))).toBe('ok');
    f.advance(1);
    const health = await infraFor(f);
    expect(infraStatus(health)).toBe('warn');
    expect(infraSummary(health, true)).toContain('performance producer stale; lastCapturedAt=2026-09-23T12:00:00.000Z');
    expect(f.collect).not.toHaveBeenCalled();
  });

  it('keeps an insert failure visible until a subsequent collection actually persists', async () => {
    const f = fixture();
    f.advance(2 * PERF_REGRESSION_SAMPLE_INTERVAL_MS);
    f.collect.mockImplementationOnce(async () => ({ signals: [], note: 'snapshot insert failed' }));
    expect(await collectPerfRegressionWhenDue('ws', f.deps)).toMatchObject({ persisted: false, overdue: true });
    expect(infraStatus(await infraFor(f))).toBe('warn');
    expect(await collectPerfRegressionWhenDue('ws', f.deps)).toMatchObject({ persisted: true, overdue: false });
    const health = await infraFor(f);
    expect(infraStatus(health)).toBe('ok');
    expect(health.performanceHistory?.lastCapturedAt).toBe('2026-09-23T12:30:00.000Z');
  });

  it('reports an absent series instead of inventing a recent successful sample', async () => {
    const f = fixture();
    f.setPersisted(null);
    const health = await infraFor(f);
    expect(infraStatus(health)).toBe('warn');
    expect(infraSummary(health, true)).toContain('lastCapturedAt=never');
  });

  it('keeps an unreadable history unknown and names the failed read', async () => {
    const f = fixture();
    f.deps.latestCapturedAt = async () => { throw new Error('snapshot relation unavailable'); };
    const health = await infraFor(f);
    expect(infraStatus(health)).toBe('unknown');
    expect(infraSummary(health, true)).toContain('performance history unreadable: snapshot relation unavailable');
  });

  it('keeps future timestamps unknown rather than granting indefinite freshness', async () => {
    const f = fixture();
    f.setPersisted(new Date(f.start + 60_000));
    expect(infraStatus(await infraFor(f))).toBe('unknown');
  });

  it('honors the explicit kill switch without querying storage or alarming', async () => {
    const f = fixture();
    f.deps.isEnabled = async () => false;
    const read = vi.fn(async () => { throw new Error('must not read'); });
    f.deps.latestCapturedAt = read;
    const health = await infraFor(f);
    expect(health.performanceHistory?.status).toBe('disabled');
    expect(infraStatus(health)).toBe('ok');
    expect(read).not.toHaveBeenCalled();
  });
});
