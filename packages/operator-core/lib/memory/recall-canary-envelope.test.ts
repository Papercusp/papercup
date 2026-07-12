/**
 * recall-canary-envelope.test.ts — EI-10368: the settings-page read of the
 * live recall canary must be FAIL-OPEN in every direction: a health line that
 * can 500 the settings envelope is worse than no health line.
 *
 * Run: cd packages/operator-core && npx vitest run lib/memory/recall-canary-envelope.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./bench/recall-canary-read', () => ({
  readRecallCanary: vi.fn(),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

import { recallCanaryForEnvelope } from './recall-canary-envelope';
import { readRecallCanary } from './bench/recall-canary-read';
import { getOrgPg } from '@papercusp/db-org';

const okRun = {
  ranAt: '2026-07-12T05:45:00.000Z',
  setVersion: 1,
  backend: 'mem0',
  pairsTotal: 20,
  pairsScored: 19,
  pairsMissing: 1,
  hits: 17,
  rAt10: 0.89,
  baselineRAt10: 0.9,
  delta: -0.01,
  zeroHitRate: 0,
  latencyP50Ms: 120,
  status: 'ok' as const,
  notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrgPg).mockReturnValue({ sql: {} } as ReturnType<typeof getOrgPg>);
});

describe('recallCanaryForEnvelope — fail-open canary read (EI-10368)', () => {
  it('returns the snapshot when the canary has run', async () => {
    vi.mocked(readRecallCanary).mockResolvedValue({ latest: okRun, trend: [okRun], runCount: 12 });
    const snap = await recallCanaryForEnvelope();
    expect(snap).toMatchObject({ latest: { status: 'ok', rAt10: 0.89 }, runCount: 12 });
    // One verdict, not a chart — the trend read is capped to the latest run.
    expect(readRecallCanary).toHaveBeenCalledWith({}, 'ws-1', 1);
  });

  it('returns null when the canary has never run (empty snapshot)', async () => {
    vi.mocked(readRecallCanary).mockResolvedValue({ latest: null, trend: [], runCount: 0 });
    await expect(recallCanaryForEnvelope()).resolves.toBeNull();
  });

  it('returns null instead of throwing when the read itself rejects', async () => {
    vi.mocked(readRecallCanary).mockRejectedValue(new Error('pg down'));
    await expect(recallCanaryForEnvelope()).resolves.toBeNull();
  });

  it('returns null instead of throwing when the PG handle is unavailable', async () => {
    vi.mocked(getOrgPg).mockImplementation(() => {
      throw new Error('no org pg in this process');
    });
    await expect(recallCanaryForEnvelope()).resolves.toBeNull();
  });
});
