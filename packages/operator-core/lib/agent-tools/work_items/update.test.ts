/**
 * update.test.ts — the work_items:update HANDLER (updateWorkItem mocked), bulk
 * keyed-array contract. Pins the single-inline patch passthrough, the items:[…]
 * fan-out, the per-item not_found mapping (batch survives), and the feature-family
 * `unsupported_family` error mapping. The unified replacement for the retired
 * issues:update (coordination-unification-2026-06-23 P-009).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/update.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../work-items', () => ({ updateWorkItem: vi.fn() }));

import { updateWorkItem } from '../../work-items';
const updM = vi.mocked(updateWorkItem);
const tool = (await import('./update')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => vi.clearAllMocks());

describe('work_items:update handler (bulk keyed-array)', () => {
  it('edits one inline { id, …fields } and passes the patch + owner through', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-1', title: 'new' } } as never);
    const b = await body({ id: 'EI-1', title: 'new', severity: 'major' });
    expect(updM).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ title: 'new', severity: 'major' }),
      'me',
      expect.objectContaining({ harness: undefined }),
    );
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', item: { id: 'EI-1', title: 'new' } });
  });

  it('items:[…] heterogeneous fan-out preserves order + per-item harness', async () => {
    updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
    const b = await body({ items: [{ id: 'EI-1', title: 'a', harness: 'h1' }, { id: 'EI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['EI-1', 'EI-2']);
    expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.any(Object), 'me', { harness: 'h1' });
  });

  it('a not_found item maps to { ok:false, error } without failing the rest', async () => {
    updM.mockImplementation(
      async (id: string) =>
        (id === 'EI-X' ? { ok: false, reason: 'not_found' } : { ok: true, item: { id } }) as never,
    );
    const b = await body({ items: [{ id: 'EI-1' }, { id: 'EI-X' }] });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-X', error: expect.stringContaining('not found') });
  });

  it('a feature-family item maps to an unsupported_family error', async () => {
    updM.mockResolvedValue({ ok: false, reason: 'unsupported_family' } as never);
    const b = await body({ id: 'F-1', title: 'x' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'F-1', error: expect.stringContaining('feature-family') });
  });

  // EI-7639: a top-level field-edit was previously SILENTLY DROPPED in the
  // items:[] batch form — `{ kind:'change', items:[{id},{id}] }` returned
  // ok:true for every item (updated_ts bumped) while applying NO kind change,
  // because only each item's OWN (undefined) field was used. A top-level
  // field must now apply as the default for every item that omits its own.
  describe('top-level field-edit as a batch default (EI-7639)', () => {
    it('applies a top-level `kind` to every item in items:[] that omits its own', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ kind: 'change', items: [{ id: 'EI-1' }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });

    it('a per-item field WINS over the top-level default (per-item is more specific)', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ kind: 'change', items: [{ id: 'EI-1', kind: 'bug' }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ kind: 'bug' }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });

    it('applies a top-level `harness` default alongside a top-level `severity` default', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ severity: 'major', harness: 'papercusp', items: [{ id: 'EI-1' }, { id: 'EI-2', harness: 'h2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ severity: 'major' }), 'me', { harness: 'papercusp' });
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ severity: 'major' }), 'me', { harness: 'h2' });
    });

    it('an explicit item-level `null` (clear the field) is NOT overridden by a top-level default', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ foundDuring: 'wave-1', items: [{ id: 'EI-1', foundDuring: null }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ foundDuring: null }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ foundDuring: 'wave-1' }), 'me', expect.any(Object));
    });

    it('the single-id inline form is unaffected (no items[] present)', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
      await body({ id: 'EI-1', kind: 'change' });
      expect(updM).toHaveBeenCalledWith('EI-1', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });
  });
});

// EI-6060: `status`/`state` are lifecycle fields owned by work_items:set_state. Zod's
// default object() SILENTLY STRIPPED them, so an update({ id, state:'resolved' }) parsed
// clean, changed nothing, and returned ok:true — a silent no-op read as success. The args
// schema now REJECTS them with a pointer to set_state. (Tested at the schema layer because
// the handler is invoked directly in the tests above, bypassing arg parsing.)
describe('work_items:update args schema — rejects lifecycle-state footguns (EI-6060)', () => {
  const hasSetStatePointer = (r: ReturnType<typeof tool.args.safeParse>) =>
    !r.success && r.error.issues.some((i) => /set_state/.test(i.message));

  it('rejects an inline `state` field instead of silently stripping it', () => {
    const r = tool.args.safeParse({ id: 'EI-1', state: 'resolved' });
    expect(r.success).toBe(false);
    expect(hasSetStatePointer(r)).toBe(true);
  });

  it('rejects an inline `status` field', () => {
    const r = tool.args.safeParse({ id: 'EI-1', status: 'resolved' });
    expect(r.success).toBe(false);
    expect(hasSetStatePointer(r)).toBe(true);
  });

  it('rejects a `state`/`status` field inside items:[…]', () => {
    expect(hasSetStatePointer(tool.args.safeParse({ items: [{ id: 'EI-1', state: 'closed' }] }))).toBe(true);
    expect(hasSetStatePointer(tool.args.safeParse({ items: [{ id: 'EI-2', status: 'open' }] }))).toBe(true);
  });

  it('still ACCEPTS a valid field-only patch (no false positive)', () => {
    expect(tool.args.safeParse({ id: 'EI-1', title: 'new', severity: 'major' }).success).toBe(true);
    expect(tool.args.safeParse({ items: [{ id: 'EI-1', body: 'b', kind: 'change' }] }).success).toBe(true);
  });

  it('still enforces id-or-items', () => {
    const r = tool.args.safeParse({ title: 'orphan' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /pass \{ id/.test(i.message))).toBe(true);
  });
});
