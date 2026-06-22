/**
 * triage.test.ts — inbox:triage HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21 P-006). The triage store + identity
 * are mocked. Pins the inline n=1 form, the items:[…] many form (per-item
 * results keyed by itemId, with heterogeneous action/note), the downgrade →
 * "handled" tier vs confirm/escalate → "decision" tier mapping, and the
 * note-required-on-downgrade/resolve refine.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/inbox/triage.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ identity: vi.fn(), upsertTriage: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../../attention/triage-store', () => ({ upsertTriage: h.upsertTriage }));

import triageTool from './triage';

const CTX = {} as never;
type Out = { data: any };
const env = async (args: unknown) =>
  (((await triageTool.handler(args as never, CTX)) as Out).data) as {
    ok: boolean;
    results: any[];
    counts: { ok: number; failed: number };
  };

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'op-1' });
  h.upsertTriage.mockResolvedValue(undefined);
});

describe('inbox:triage handler (bulk keyed-array, P-006)', () => {
  it('n=1 inline { itemId, action } → one keyed result; confirm maps to the decision tier', async () => {
    const b = await env({ itemId: 'coord-escalation:m1', action: 'confirm' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      itemId: 'coord-escalation:m1',
      action: 'confirm',
      triageState: 'confirmed',
      tier: 'decision',
    });
    expect(h.upsertTriage).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'coord-escalation:m1', action: 'confirm', triagedBy: 'op-1' }),
    );
  });

  it('downgrade with a note maps to the auditable "handled" tier', async () => {
    const b = await env({ itemId: 'x:1', action: 'downgrade', note: 'false positive — already resolved upstream' });
    expect(b.results[0]).toMatchObject({ itemId: 'x:1', triageState: 'downgraded', tier: 'handled' });
    expect(h.upsertTriage.mock.calls[0]![0]).toMatchObject({ note: 'false positive — already resolved upstream' });
  });

  it('n=1 downgrade WITHOUT a note is rejected by the arg refine (note required)', () => {
    expect(triageTool.args.safeParse({ itemId: 'x:1', action: 'downgrade' }).success).toBe(false);
    expect(triageTool.args.safeParse({ itemId: 'x:1', action: 'resolve' }).success).toBe(false);
    expect(triageTool.args.safeParse({ itemId: 'x:1', action: 'confirm' }).success).toBe(true);
  });

  it('items:[…] triages many heterogeneous actions, each result keyed by itemId', async () => {
    const b = await env({
      items: [
        { itemId: 'a:1', action: 'confirm' },
        { itemId: 'b:2', action: 'resolve', note: 'handled by operator' },
        { itemId: 'c:3', action: 'escalate' },
      ],
    });
    expect(b.counts).toEqual({ ok: 3, failed: 0 });
    expect(b.results.map((r) => [r.itemId, r.tier])).toEqual([
      ['a:1', 'decision'],
      ['b:2', 'handled'],
      ['c:3', 'decision'],
    ]);
    expect(h.upsertTriage).toHaveBeenCalledTimes(3);
  });

  it('items[] requires note on a downgrade/resolve entry (per-item refine)', () => {
    expect(triageTool.args.safeParse({ items: [{ itemId: 'a:1', action: 'downgrade' }] }).success).toBe(false);
    expect(
      triageTool.args.safeParse({ items: [{ itemId: 'a:1', action: 'downgrade', note: 'why' }] }).success,
    ).toBe(true);
  });

  it('a failing upsert fails ONLY that item — batch survives (top-level ok:true)', async () => {
    h.upsertTriage.mockImplementation(async ({ itemId }: { itemId: string }) => {
      if (itemId === 'boom') throw new Error('store write failed');
    });
    const b = await env({
      items: [
        { itemId: 'a:1', action: 'confirm' },
        { itemId: 'boom', action: 'escalate' },
        { itemId: 'c:3', action: 'confirm' },
      ],
    });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r) => [r.itemId, r.ok])).toEqual([
      ['a:1', true],
      ['boom', false],
      ['c:3', true],
    ]);
    expect(b.results[1].error).toContain('store write failed');
  });
});
