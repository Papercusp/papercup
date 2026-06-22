/**
 * set-status.bulk.test.ts — the plans:set-status HANDLER bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Sibling to set-status.test.ts (which
 * pins the pure helpers). Pins: inline { slug, itemId, status } → one result; the
 * itemIds:[…] (one plan) + items:[…] (heterogeneous) fan-out keyed by { slug, itemId
 * }; and a partial failure (one item_not_found) that fails ONLY itself — top-level
 * ok:true, counts.failed===1.
 *
 * The lock + revision + identity deps are mocked so this is a pure unit test (no PG).
 * resolveAgentIdentity is mocked to throw → agentId=null, which (by design) skips the
 * claim / auto-convert / terminal-grip discipline so the core flip + envelope is what
 * we exercise here; the discipline itself is covered by set-status.test.ts +
 * integration tests.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.bulk.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real `harnessArg` zod schema; only stub `harnessScopedCtx` so the test
// ctx (which carries no harnessSlug) does not trip the harness-required gate.
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// No attributable agent identity → the claim/terminal discipline is skipped.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
// The lock helper is the single seam: it invokes the mutator and we shape its result.
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

type Out = { content: { text: string }[] };
const body = async (args: Record<string, unknown>) =>
  JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

beforeEach(() => vi.clearAllMocks());

/** Drive the lock: run the mutator against a fake body, then return its ok-value as a
 *  successful lock outcome (or a not_found mutator-value for an unknown item). */
function lockReturnsMutatorValue(knownItems: Set<string>) {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    // `intent` carries the item id we're flipping: "plans:set-status P-NNN → status".
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const fakeBody = knownItems.has(itemId) ? `- **${itemId}** \`todo\` x` : '';
    const { value } = await (mutate as (b: string | null) => Promise<{ value: unknown }>)(fakeBody);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

describe('plans:set-status handler (bulk keyed-array)', () => {
  it('inline { slug, itemId, status } returns a single result', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', itemId: 'P-001', status: 'wip' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      slug: 'plan-a',
      itemId: 'P-001',
      oldStatus: 'todo',
      newStatus: 'wip',
    });
  });

  it('itemIds:[…] flips many of one plan to the same status', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-002'], status: 'done' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { itemId: string }) => r.itemId)).toEqual(['P-001', 'P-002']);
    expect(b.results.every((r: { newStatus: string }) => r.newStatus === 'done')).toBe(true);
  });

  it('items:[…] heterogeneous; per-item status overrides the batch default', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({
      slug: 'plan-a',
      status: 'done',
      items: [
        { slug: 'plan-a', itemId: 'P-001' },
        { slug: 'plan-b', itemId: 'P-002', status: 'blocked' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results[0]).toMatchObject({ slug: 'plan-a', itemId: 'P-001', newStatus: 'done' });
    expect(b.results[1]).toMatchObject({ slug: 'plan-b', itemId: 'P-002', newStatus: 'blocked' });
  });

  it('a partial failure (one unknown item) fails ONLY itself — batch survives', async () => {
    lockReturnsMutatorValue(new Set(['P-001'])); // P-099 is unknown → item_not_found
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-099'], status: 'wip' });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: true, itemId: 'P-001' });
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-099', error: 'item_not_found' });
  });

  it('a busy lock maps to that item\'s { ok:false, error:"busy" } without throwing', async () => {
    lockM.mockResolvedValue({ kind: 'busy', busy: [{ path: 'p', owner_label: 'o', intent: 'i', expires_ts: 1 }] } as never);
    const b = await body({ slug: 'plan-a', itemId: 'P-001', status: 'wip' });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-001', error: 'busy' });
  });
});
