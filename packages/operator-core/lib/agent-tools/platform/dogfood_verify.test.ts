/**
 * dogfood_verify.test.ts — the platform:dogfood_verify HANDLER (the witness
 * verifyDogfoodRoundTrip is unit-tested in lib/pr-host/dogfood-roundtrip.test.ts).
 * Asserts the handler resolves the default harness, delegates to the witness with
 * PR-2's report reader wired, and surfaces the verdict.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/platform/dogfood_verify.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-default') }));
vi.mock('../../pr-host/dogfood-roundtrip', () => ({
  verifyDogfoodRoundTrip: vi.fn(),
  defaultReadReviewReport: vi.fn(),
}));
vi.mock('../../pot/enable-platform-mode', () => ({ PLATFORM_SELF_POT_SLUG: 'papercusp-platform' }));

import { verifyDogfoodRoundTrip, defaultReadReviewReport } from '../../pr-host/dogfood-roundtrip';
const verifyM = vi.mocked(verifyDogfoodRoundTrip);
const tool = (await import('./dogfood_verify')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  verifyM.mockResolvedValue({
    ok: true,
    stages: { prTracked: 'pass', reviewed: 'pass', merged: 'pass', shipped: 'pass', linked: 'pass' },
    featureId: 'F-001',
    gaps: [],
  } as never);
});

describe('platform:dogfood_verify', () => {
  it('delegates to the witness with the default self-hive harness + PR-2 reader, returns ok', async () => {
    const b = body(await call({ prUrl: 'https://github.com/Papercusp/papercup/pull/42' }));
    expect(b).toMatchObject({ ok: true, harnessSlug: 'papercusp-platform', featureId: 'F-001' });
    expect(verifyM).toHaveBeenCalledTimes(1);
    expect(verifyM.mock.calls[0]![0]).toMatchObject({
      harnessSlug: 'papercusp-platform',
      prUrl: 'https://github.com/Papercusp/papercup/pull/42',
      workspaceId: 'ws-1',
      readReviewReport: defaultReadReviewReport,
    });
  });

  it('honors an explicit harnessSlug', async () => {
    await call({ prUrl: 'https://x/pull/1', harnessSlug: 'other-member' });
    expect(verifyM.mock.calls[0]![0]).toMatchObject({ harnessSlug: 'other-member' });
  });

  it('surfaces a not-yet-round-tripped verdict (ok:false + gaps)', async () => {
    verifyM.mockResolvedValue({
      ok: false,
      stages: { prTracked: 'fail', reviewed: 'gated', merged: 'fail', shipped: 'fail', linked: 'fail' },
      featureId: null,
      gaps: ['WI↔PR producer wrote no row for this PR'],
    } as never);
    const b = body(await call({ prUrl: 'https://x/pull/2' }));
    expect(b.ok).toBe(false);
    expect(b.gaps[0]).toContain('WI↔PR producer');
  });

  it('never throws — a witness error becomes a structured failure', async () => {
    verifyM.mockRejectedValue(new Error('pg down'));
    const b = body(await call({ prUrl: 'https://x/pull/3' }));
    expect(b).toMatchObject({ ok: false, error: 'dogfood_verify_failed' });
    expect(b.message).toContain('pg down');
  });
});
