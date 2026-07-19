/**
 * work_items:get — auditProseEvidenceLikely field (EI-13845).
 *
 * Completion evidence lives on TWO surfaces: the STRUCTURED `terminalCompletionEvidence`
 * (testsRun/testResult/verifiedHow/…, populated only when the closer filled those specific
 * `completion.*` fields) and the PROSE `terminalCompletionRef` (`completion.summary`, which
 * many closers use to write the real verification detail instead). `work_items:list`'s
 * `audit:'no-evidence'` sweep already stamps a best-effort `auditProseEvidenceLikely` signal
 * (looksLikeCitedProseEvidence, EI-13424) so a bulk audit doesn't misread "structured field
 * empty" as "never verified" — but a caller reading ONE item via `work_items:get` (as the
 * WI-5153 near-wrongful-reopen did) got no such signal and nearly reverted a real, evidenced
 * close because the empty structured field looked bare. These pin get.ts's wiring of the same
 * signal onto the single-item read path.
 *
 * `looksLikeCitedProseEvidence` itself is unit-pinned separately in completion-audit.test.ts;
 * here we only pin get.ts's wiring (when the field is present/absent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
}));

const getWorkItemCheckpointWithMeta = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
}));

const getPresence = vi.fn();
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));

const planItemLaneBlockReason = vi.fn();
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...a: unknown[]) => planItemLaneBlockReason(...a),
}));

import get from './get';

const ctx = { uiClientId: 'su-tester', workspaceId: 'default' } as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const env = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
const one = async (x: unknown) => (await env(x)).results[0];

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'WI-5153',
  harness: 'papercup',
  kind: 'bug',
  family: 'issue',
  title: 'plan-drain lane item',
  state: 'resolved',
  terminalOwner: 'su-c62713e3',
  terminalCompletionRef: null as string | null,
  terminalCompletionEvidence: null as unknown,
  payload: {},
  ...overrides,
});

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  getPresence.mockReset().mockResolvedValue(null);
  planItemLaneBlockReason.mockReset().mockResolvedValue(null);
});

describe('work_items:get — auditProseEvidenceLikely field (EI-13845)', () => {
  it('flags a cited-looking prose ref when the structured evidence surface is empty', async () => {
    getWorkItem.mockResolvedValue(
      baseItem({
        terminalCompletionEvidence: null,
        terminalCompletionRef:
          'Diagnosed 4 blocked items as stale (P-005 scheduler/plan-item-lane-guard.ts:204); 535/535 tests green; unblocked P-005.',
      }),
    );
    const r = await one({ id: 'WI-5153' });
    expect(r).toMatchObject({ ok: true, id: 'WI-5153', auditProseEvidenceLikely: true });
  });

  it('flags false for a genuinely bare prose ref with no citation pattern, even though the field fires', async () => {
    getWorkItem.mockResolvedValue(
      baseItem({ terminalCompletionEvidence: null, terminalCompletionRef: 'done' }),
    );
    const r = await one({ id: 'WI-5153' });
    expect(r).toMatchObject({ ok: true, id: 'WI-5153', auditProseEvidenceLikely: false });
  });

  it('omits the field entirely (not even false) when structured evidence IS present', async () => {
    getWorkItem.mockResolvedValue(
      baseItem({
        terminalCompletionEvidence: { verifiedHow: 'unit', testResult: '27/27 passed' },
        terminalCompletionRef: 'fixed it',
      }),
    );
    const r = await one({ id: 'WI-5153' });
    expect(r).toMatchObject({ ok: true, id: 'WI-5153' });
    expect(r.auditProseEvidenceLikely).toBeUndefined();
  });

  it('omits the field when there is no completion ref at all (never terminally completed)', async () => {
    getWorkItem.mockResolvedValue(
      baseItem({ state: 'open', terminalCompletionEvidence: null, terminalCompletionRef: null }),
    );
    const r = await one({ id: 'WI-5153' });
    expect(r.auditProseEvidenceLikely).toBeUndefined();
  });

  it('surfaces on the detail path (args.detail:true) too', async () => {
    getWorkItemDetail.mockResolvedValue({
      ...baseItem({
        terminalCompletionEvidence: null,
        terminalCompletionRef:
          'verified via events:await(watchdog-drill-9b1e2c3d-4444-4444-4444-abcdefabcdef) — reran the full suite, confirmed the drill converged cleanly with no residual alerts.',
      }),
      topics: [],
      posts: [],
      links: [],
    });
    const r = await one({ id: 'WI-5153', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r.auditProseEvidenceLikely).toBe(true);
  });

  it('never consults the signal for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
    expect(r.auditProseEvidenceLikely).toBeUndefined();
  });
});
