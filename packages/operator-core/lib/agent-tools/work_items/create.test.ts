/**
 * create.test.ts — work_items:create handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The per-item core (`createOneWorkItem`)
 * is mocked — this exercises the tool's normalization (single spec OR items:[…] +
 * batch-level harness / workspace / assign_all_to_self) and the keyed-array envelope
 * that RETIRED work_items:create_batch. Each result self-describes; a mirror-duplicate
 * fails only that item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'me' }),
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));
vi.mock('./_create-core', () => ({ createOneWorkItem: vi.fn() }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
}));
// Create-time dedup port (P-009) — mock so this handler test stays hermetic
// (the memory-pools leg is pinned in memory/claim-port.test.ts).
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

import { createOneWorkItem } from './_create-core';
const createM = vi.mocked(createOneWorkItem);
const tool = (await import('./create')).default;
const codeSmellsLikeCode = (await import('./create')).codeSmellsLikeCode;

const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(parse(args) as never, ctx)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  fleetAdmission.decision = { allowed: true, scoped: false };
  createM.mockImplementation(async (spec: { title: string }) => ({ ok: true, workItem: { id: `WI-${spec.title}`, kind: 'bug', title: spec.title } }) as never);
});

describe('codeSmellsLikeCode + the task nudge (WI-2874)', () => {
  it('flags code work via structural signals (source path / file ext / backticked ident / edit verbs)', () => {
    expect(codeSmellsLikeCode('Fix packages/operator-core/lib/foo.ts race')).toBe(true);
    expect(codeSmellsLikeCode('Update the docs-qa.ts endpoint')).toBe(true);
    expect(codeSmellsLikeCode('Rename `myHelperFn` in the resolver')).toBe(true);
    expect(codeSmellsLikeCode('Refactor the claim path', 'implement the new guard')).toBe(true);
  });
  it('does NOT flag genuine non-code tasks (false positives would be harmless anyway — it never blocks)', () => {
    expect(codeSmellsLikeCode('Research the best charting library for the dashboard')).toBe(false);
    expect(codeSmellsLikeCode('Decide whether to sunset the classic lexicon')).toBe(false);
    expect(codeSmellsLikeCode('Manually verify the 2-box federation drill on the rig')).toBe(false);
  });
  it('a code-smelling TASK is still created, with a non-blocking warning', async () => {
    const b = await body({ kind: 'task', title: 'refactor packages/foo/bar.ts' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].warning).toMatch(/NON-CODE only/);
  });
  it('a genuine non-code TASK gets NO warning', async () => {
    const b = await body({ kind: 'task', title: 'research the best date library' });
    expect(b.results[0].warning).toBeUndefined();
  });
  it('the nudge is task-only — a code-smelling change/bug is never warned', async () => {
    const b = await body({ kind: 'change', title: 'fix packages/foo/bar.ts' });
    expect(b.results[0].warning).toBeUndefined();
  });
});

// EI-18655063958515097: "a residual split off a closing plan item silently leaves
// the lane — no plan link, not claimable, parent reads done while its acceptance
// ask is unmet". Non-blocking nudge (never refuses the create) when a residual-
// smelling item is filed with no plan_item/targetPlanItem link.
describe('residualLinkNudge (EI-18655063958515097)', () => {
  it('nudges when a residual-smelling item is created with no plan_item link', async () => {
    const b = await body({
      kind: 'bug',
      title: 'residual: the real second frame acceptance ask was not met, split off from P-413',
    });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].residualLinkNudge).toMatch(/plan_item/);
  });

  it('does NOT nudge when plan_item is already set (properly linked)', async () => {
    const b = await body({
      kind: 'bug',
      title: 'residual: split off from P-413, real second frame not met',
      plan_item: { slug: 'some-plan', item: 'P-413' },
    });
    expect(b.results[0].residualLinkNudge).toBeUndefined();
  });

  it('does NOT nudge on an ordinary (non-residual-smelling) item', async () => {
    const b = await body({ kind: 'bug', title: 'fix the login race condition' });
    expect(b.results[0].residualLinkNudge).toBeUndefined();
  });

  it('works in the bulk items:[…] path too', async () => {
    const b = await body({
      items: [
        { kind: 'bug', title: 'split off the remaining acceptance criteria' },
        { kind: 'bug', title: 'a totally unrelated fix' },
      ],
    });
    expect(b.results[0].residualLinkNudge).toMatch(/plan_item/);
    expect(b.results[1].residualLinkNudge).toBeUndefined();
  });
});

describe('work_items:create handler (keyed-array)', () => {
  it('creates one inline and returns { ok, id, title, workItem }', async () => {
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-boom', title: 'boom', workItem: { id: 'WI-boom' } });
    expect(createM).toHaveBeenCalledTimes(1);
  });

  it('creates MANY via items:[…] — one self-describing result per item', async () => {
    const b = await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'change', title: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-a', 'WI-b']);
  });

  it('assign_all_to_self claims every item unless the item overrides via assign_to', async () => {
    await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }], assign_all_to_self: true });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('EI-7766: assign_to:"self" resolves to the caller ownerId, not the literal string (single-create path)', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'self' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
  });

  it('EI-7766: assign_to:"self" resolves to the caller ownerId in the bulk items[] path too', async () => {
    await body({ items: [{ kind: 'bug', title: 'a', assign_to: 'self' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('a concrete assign_to ownerId is passed through unchanged (not confused with "self")', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'someone-else' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'someone-else' }), expect.anything());
  });

  it('P-016 refuses an out-of-scope create+assign before the item exists', async () => {
    fleetAdmission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'new item is outside fixed cohort',
      scope: { fleetSlug: 'fixed-wave', ownerId: 'bee-7', fleetRole: 'member', record: { spec: { specId: 'fixed', revision: 7 } } },
    };
    const b = await body({ kind: 'bug', title: 'outside', assign_to: 'bee-7' });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'fleet_scope_violation' });
    expect(createM).not.toHaveBeenCalled();
    expect(fleetAdmission.notify).toHaveBeenCalledOnce();
  });

  it('batch-level harness is the default for items that omit one', async () => {
    await body({ items: [{ kind: 'feature', title: 'a' }], harness: 'h-default' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', harness: 'h-default' }), expect.anything());
  });

  it('threads explicit routing intent + cadence through single and bulk creates', async () => {
    await body({
      kind: 'task',
      title: 'daily digest',
      routing_intent: 'schedule-recurrence',
      cadence: 'daily at 09:00',
    });
    expect(createM).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routing_intent: 'schedule-recurrence',
        cadence: 'daily at 09:00',
      }),
      expect.anything(),
    );

    await body({
      items: [{
        kind: 'task',
        title: 'release alert',
        routing_intent: 'watch-alert',
      }],
    });
    expect(createM).toHaveBeenLastCalledWith(
      expect.objectContaining({ routing_intent: 'watch-alert' }),
      expect.anything(),
    );
  });

  it('a mirror-duplicate fails only that item (carries error + existing), batch still runs', async () => {
    createM.mockImplementation(async (spec: { title: string }) =>
      spec.title === 'dup'
        ? ({ ok: false, error: 'duplicate_mirror', message: 'references WI-9', existing: { id: 'WI-9', state: 'open' } } as never)
        : ({ ok: true, workItem: { id: `WI-${spec.title}`, title: spec.title } } as never),
    );
    const b = await body({ items: [{ kind: 'bug', title: 'ok' }, { kind: 'bug', title: 'dup' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, title: 'dup', error: 'duplicate_mirror', existing: { id: 'WI-9' } });
  });
});

// WI-4492: create took `summary` and SILENTLY DROPPED a `body` arg (Zod stripped it), so a
// caller who learned the name `body` from work_items:update filed an EMPTY-BODIED item with
// a cheerful ok — proven live when WI-4491/WI-4492 themselves were filed as empty shells.
// create now ACCEPTS `body` as an alias for `summary`, is `.strict()` (unknown field → loud
// error), and rejects both-with-different-values.
describe('work_items:create — body/summary alias + strict (WI-4492)', () => {
  it('maps a `body` arg to `summary` when calling createOneWorkItem (no stray `body` leaks through)', async () => {
    await body({ kind: 'bug', title: 'boom', body: 'the real text' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'boom', summary: 'the real text' }), expect.anything());
    expect(createM.mock.calls[0][0]).not.toHaveProperty('body');
  });

  it('maps a per-item `body` alias to summary inside items:[…]', async () => {
    await body({ items: [{ kind: 'bug', title: 'a', body: 'aa' }, { kind: 'bug', title: 'b', summary: 'bb' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', summary: 'aa' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', summary: 'bb' }), expect.anything());
    expect(createM.mock.calls[0][0]).not.toHaveProperty('body');
  });

  describe('args schema', () => {
    it('ACCEPTS `body` as an alias for `summary`', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'text' })).not.toThrow();
    });

    it('REJECTS an unknown field loudly instead of silently stripping it (strict)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', summry: 'a typo for summary' })).toThrow();
    });

    it('REJECTS both `body` and `summary` with DIFFERENT values (ambiguous)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'a', summary: 'b' })).toThrow(/same field/i);
    });

    it('ACCEPTS both `body` and `summary` when EQUAL (no false positive)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'same', summary: 'same' })).not.toThrow();
    });

    it('REJECTS an unknown field inside items:[…]', () => {
      expect(() => parse({ items: [{ kind: 'bug', title: 'x', bogus: 1 }] })).toThrow();
    });

    it('REJECTS an explicit schedule intent without cadence in either arity', () => {
      expect(() => parse({
        kind: 'task',
        title: 'digest',
        routing_intent: 'schedule-recurrence',
      })).toThrow(/cadence is required/i);
      expect(() => parse({
        items: [{
          kind: 'task',
          title: 'digest',
          routing_intent: 'schedule-recurrence',
        }],
      })).toThrow(/cadence is required/i);
    });
  });
});

describe('state-on-create (EI-10897)', () => {
  const safeParse = (x: unknown) => (tool.args as { safeParse: (x: unknown) => { success: boolean; error?: unknown } }).safeParse(x);

  it("accepts `state` — the su persona already prescribes { title, assign_to:'self', state:'wip' }, and the tool used to REJECT it as an unrecognized key", async () => {
    await body({ kind: 'change', title: 'ad-hoc unit I am starting now', assign_to: 'self', state: 'wip' });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'ad-hoc unit I am starting now', state: 'wip', assign_to: 'me' }),
      expect.anything(),
    );
  });

  it('threads `state` through the BULK path too (the item spec, not just the single shorthand)', async () => {
    await body({ items: [{ kind: 'change', title: 'a', state: 'wip' }, { kind: 'bug', title: 'b' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', state: 'wip' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b' }), expect.anything());
    expect((createM.mock.calls[1][0] as { state?: string }).state).toBeUndefined();
  });

  it('REFUSES a terminal state on create — that would manufacture a "done" item with no evidence (the EI-10867 laundering path)', () => {
    for (const s of ['done', 'resolved', 'closed', 'passed']) {
      const r = safeParse({ kind: 'change', title: 'sneaky', state: s });
      expect(r.success, `state '${s}' must be refused on create`).toBe(false);
    }
  });

  it('still accepts a create with NO state (the default entry state is untouched)', () => {
    expect(safeParse({ kind: 'bug', title: 'plain' }).success).toBe(true);
  });
});
