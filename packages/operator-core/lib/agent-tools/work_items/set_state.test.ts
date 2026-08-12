/**
 * set_state.test.ts — work_items:set_state handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine + P-114 arm mocked. Pins: inline
 * single → one result; ids:[…]+state homogeneous; items:[…] heterogeneous states; a
 * not-found item fails only itself; the P-114 arm is evaluated per item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({ getWorkItem: vi.fn(), setWorkItemStateWithAliasInfo: vi.fn() }));
vi.mock('../../scheduler/plan-item-lane-guard', () => ({ resolvePlanItemStamp: vi.fn() }));
vi.mock('./arm-reversible-work-item', () => ({ planWorkItemArm: vi.fn(async () => null), commitWorkItemArm: vi.fn() }));

import { getWorkItem, setWorkItemStateWithAliasInfo } from '../../work-items';
import { resolvePlanItemStamp } from '../../scheduler/plan-item-lane-guard';
import { planWorkItemArm } from './arm-reversible-work-item';
const getM = vi.mocked(getWorkItem);
const setM = vi.mocked(setWorkItemStateWithAliasInfo);
const planStampM = vi.mocked(resolvePlanItemStamp);
const armM = vi.mocked(planWorkItemArm);
const tool = (await import('./set_state')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

/** Default mock: no alias — the item lands exactly on the requested state. */
function noAlias(id: string, state: string) {
  return { workItem: { id, state }, aliased: false, requestedState: state, appliedState: state } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  armM.mockResolvedValue(null as never);
  getM.mockResolvedValue(null);
  planStampM.mockResolvedValue(null);
  setM.mockImplementation(async (id: string, state: string) => noAlias(id, state));
});

describe('work_items:set_state handler (keyed-array)', () => {
  it('sets one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1', state: 'passed' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', state: 'passed' } });
    expect(setM).toHaveBeenCalledWith('WI-1', 'passed', {
      harness: undefined,
      by: 'me',
      completionRef: undefined,
      force: undefined,
    });
  });

  it('sets MANY to the same state via ids:[…] (homogeneous) — arm evaluated per item', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], state: 'resolved', harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.every((r: { workItem: { state: string } }) => r.workItem.state === 'resolved')).toBe(true);
    expect(armM).toHaveBeenCalledTimes(2);
    expect(setM).toHaveBeenCalledWith('WI-2', 'resolved', {
      harness: 'h',
      by: 'me',
      completionRef: undefined,
      force: undefined,
    });
  });

  it('items:[…] sets heterogeneous states per item', async () => {
    const b = await body({ items: [{ id: 'WI-1', state: 'passed' }, { id: 'WI-2', state: 'failing' }] });
    expect(b.results[0].workItem.state).toBe('passed');
    expect(b.results[1].workItem.state).toBe('failing');
  });

  it('a not-found item (null workItem) fails only itself', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      id === 'WI-X'
        ? ({ workItem: null, aliased: false, requestedState: state, appliedState: null } as never)
        : noAlias(id, state),
    );
    const b = await body({ ids: ['WI-1', 'WI-X'], state: 'done' });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
  });

  it('a thrown engine error (unmappable state) becomes that item\'s {ok:false}', async () => {
    setM.mockRejectedValueOnce(new Error('cannot take state'));
    const b = await body({ id: 'WI-1', state: 'bogus' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-1' });
    expect(String(b.results[0].error)).toMatch(/cannot take state/);
  });

  it('refuses direct blocked writes for plan-linked work-items and points to the plan source of truth', async () => {
    getM.mockResolvedValue({ id: 'WI-plan', family: 'feature', payload: {}, harness: 'papercusp' } as never);
    planStampM.mockResolvedValue({ plan_slug: 'plan-slug', item_ids: ['P-015'] });

    const b = await body({ id: 'WI-plan', state: 'blocked' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-plan' });
    expect(String(b.results[0].error)).toMatch(/plan-slug#P-015/);
    expect(String(b.results[0].error)).toMatch(/plans:set-status/);
    expect(setM).not.toHaveBeenCalled();
    expect(armM).not.toHaveBeenCalled();
  });

  it('keeps standalone blocked writes on the existing lifecycle path', async () => {
    const b = await body({ id: 'WI-standalone', state: 'blocked' });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(setM).toHaveBeenCalledWith('WI-standalone', 'blocked', {
      harness: undefined,
      by: 'me',
      completionRef: undefined,
      force: undefined,
    });
  });
});

// EI-7125 / WI-2573: an issue-family 'blocked'/'needs-human'/etc request silently
// aliases to 'open' inside setWorkItemState (EI-450) — this used to read as an
// unexplained ok:true no-op. onAlias now lets the tool surface a per-item note.
describe('work_items:set_state — alias note (EI-7125 / WI-2573)', () => {
  it('surfaces an aliasNote when the write aliases', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'blocked' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { state: 'open' } });
    expect(b.results[0].aliasNote).toMatch(/requested state 'blocked'.*recorded as 'open'/);
  });

  it('omits aliasNote entirely when the requested state is already canonical (no alias fired)', async () => {
    // Default mock: no alias — mirrors a canonical state like 'resolved'.
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('aliasNote');
  });

  it('each item in a heterogeneous batch gets its OWN aliasNote independently', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      state === 'wip'
        ? ({
            workItem: { id, state: 'open' },
            aliased: true,
            requestedState: state,
            appliedState: 'open',
            aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
          } as never)
        : noAlias(id, state),
    );
    const b = await body({ items: [{ id: 'WI-1', state: 'wip' }, { id: 'WI-2', state: 'resolved' }] });
    expect(b.results[0].aliasNote).toBeTruthy();
    expect(b.results[1]).not.toHaveProperty('aliasNote');
  });
});

// EI-7712: the fail-loud contract every result row now carries — `aliased` /
// `requestedState` / `appliedState` are present on EVERY successful result, not just
// when an aliasNote string is generated, so a careless caller comparing appliedState
// against what it asked for catches a divergence even without pattern-matching prose.
describe('work_items:set_state — aliased/requestedState/appliedState on every result (EI-7712)', () => {
  it('a clean (non-aliased) write reports aliased:false with matching requested/applied state', async () => {
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ aliased: false, requestedState: 'resolved', appliedState: 'resolved' });
  });

  it('an aliased write reports aliased:true with DIVERGENT requested/applied state, even without reading aliasNote', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'blocked' });
    expect(b.results[0].aliased).toBe(true);
    expect(b.results[0].requestedState).toBe('blocked');
    expect(b.results[0].appliedState).toBe('open');
    expect(b.results[0].requestedState).not.toBe(b.results[0].appliedState);
  });

  it('a silent divergence with NO onAlias fire (a hypothetical future bug class) still surfaces as aliased:true — the WI-2381 recurrence guard', async () => {
    // Simulates a lower-layer bug that persists a DIFFERENT state than requested
    // WITHOUT the normalize-layer onAlias ever firing — setWorkItemStateWithAliasInfo's
    // own appliedState-vs-requestedState comparison (not just onAlias) must still catch it.
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' }, // silently stayed 'open' instead of 'blocked'
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' was not applied verbatim — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-2381', state: 'blocked' });
    expect(b.results[0].ok).toBe(true); // the write itself succeeded — this is exactly why `ok` alone is not enough
    expect(b.results[0].aliased).toBe(true); // but the discriminator catches the divergence
    expect(b.results[0].appliedState).not.toBe(b.results[0].requestedState);
  });
});

/**
 * P-005 / D-006 — the terminal-state evidence requirement is STRUCTURAL.
 *
 * These assert the SCHEMA (tool.args), not the handler: the point of the change is
 * that an evidence-less terminal write is unrepresentable at the boundary, so it
 * never reaches the handler at all. Before this, `state` was a bare string and
 * `completionRef` was `.optional()` with the rule living in its .describe() — the
 * IFEval-FC failure mode (models miss rules embedded in schema descriptions).
 */
describe('terminal writes structurally require completion evidence (P-005)', () => {
  const parse = (args: unknown) => (tool.args as { safeParse: (v: unknown) => { success: boolean } }).safeParse(args);

  /**
   * P-017 (b) gate #2 added a SECOND terminal requirement (`assumptions`, D-050). This
   * block is about the EVIDENCE rule, so every payload here carries a satisfied
   * assumption declaration — otherwise `rejects(...)` would pass for the wrong reason
   * (missing assumptions rather than missing evidence) and would keep passing even if
   * the evidence gate were deleted. The assumption gate is isolated symmetrically in
   * its own describe block below.
   */
  const withAssumptions = (args: unknown): unknown => {
    if (typeof args !== 'object' || args === null) return args;
    const o = { ...(args as Record<string, unknown>) };
    if (Array.isArray(o.items)) {
      o.items = o.items.map((it) =>
        typeof it === 'object' && it !== null ? { assumptions: 'none', ...(it as Record<string, unknown>) } : it,
      );
    }
    if (o.assumptions === undefined) o.assumptions = 'none';
    return o;
  };

  const accepts = (args: unknown) => expect(parse(withAssumptions(args)).success).toBe(true);
  const rejects = (args: unknown) => expect(parse(withAssumptions(args)).success).toBe(false);

  it('rejects an evidence-less terminal write in ALL THREE call shapes', () => {
    // Fixing only itemSpec would MOVE the bypass to the shorthand rather than close it.
    rejects({ id: 'WI-1', state: 'done' });
    rejects({ ids: ['WI-1', 'WI-2'], state: 'dropped' });
    rejects({ items: [{ id: 'WI-1', state: 'done' }] });
  });

  it('accepts a terminal write that carries evidence, in all three shapes', () => {
    accepts({ id: 'WI-1', state: 'done', completionRef: 'landed in abc123' });
    accepts({ ids: ['WI-1'], state: 'dropped', completionRef: 'superseded by WI-9' });
    accepts({ items: [{ id: 'WI-1', state: 'done', completionRef: 'ref' }] });
  });

  it('enforces the rule on LEGACY terminal spellings too, not just done/dropped', () => {
    // These are terminal only after aliasing — a gate keyed on the raw unified pair
    // would let `passed`/`resolved` close an item with no evidence at all.
    rejects({ id: 'WI-1', state: 'passed' });
    rejects({ id: 'WI-1', state: 'resolved' });
    rejects({ id: 'WI-1', state: 'closed' });
    rejects({ id: 'WI-1', state: 'deprecated' });
  });

  it('leaves non-terminal writes alone — no evidence required', () => {
    for (const state of ['wip', 'blocked', 'needs-human', 'open', 'todo']) {
      accepts({ id: 'WI-1', state });
    }
  });

  it('still folds case drift, and enforces the gate on the folded value', () => {
    // Acceptance must not narrow: `DONE`/`WIP` worked before and still do — but
    // `DONE` is now correctly recognized as terminal rather than slipping the gate.
    rejects({ id: 'WI-1', state: 'DONE' });
    accepts({ id: 'WI-1', state: 'DONE', completionRef: 'ref' });
    accepts({ id: 'WI-1', state: 'WIP' });
  });

  it('rejects an unknown state instead of parking it in limbo (GAP-5)', () => {
    // `state` used to be z.string().max(40), so a typo was accepted and landed the
    // row in a non-dispatchable state no queue would ever offer again.
    rejects({ id: 'WI-1', state: 'donee' });
    rejects({ items: [{ id: 'WI-1', state: 'complete' }] });
  });
});

/**
 * P-017 (b) gate #2 / D-016 / D-050 — a terminal close must DECLARE the assumptions it
 * rests on, or say "none" explicitly.
 *
 * Isolated from the evidence block above by construction: every payload here carries a
 * satisfied `completionRef`, so each assertion can only be about `assumptions`. If the
 * two gates shared fixtures, either could be deleted without a test going red.
 */
describe('terminal writes structurally require an assumption declaration (P-017 b#2)', () => {
  // A DISCRIMINATED union, not `{ success: boolean }`: the message-shape test below
  // reads `r.error.issues` on the failure branch, and a plain boolean cannot narrow
  // — it yields both "Property 'error' does not exist" and an implicitly-any `i` in
  // the `.map`. Modelling only the two fields these tests actually touch keeps the
  // cast honest about what it is asserting.
  const parse = (args: unknown) =>
    (
      tool.args as {
        safeParse: (
          v: unknown,
        ) => { success: true } | { success: false; error: { issues: { message: string }[] } };
      }
    ).safeParse(args);
  const REF = 'landed in abc123';

  it('rejects a terminal write with evidence but NO assumption declaration, in all three shapes', () => {
    // Fixing only itemSpec would MOVE the bypass to the shorthand rather than close it —
    // and the shorthand is the cheaper call, so it would carry all the traffic.
    expect(parse({ id: 'WI-1', state: 'done', completionRef: REF }).success).toBe(false);
    expect(parse({ ids: ['WI-1', 'WI-2'], state: 'dropped', completionRef: REF }).success).toBe(false);
    expect(parse({ items: [{ id: 'WI-1', state: 'done', completionRef: REF }] }).success).toBe(false);
  });

  it('accepts the explicit "none" — saying nothing-recorded is a valid answer', () => {
    expect(parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' }).success).toBe(true);
    expect(
      parse({ items: [{ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' }] }).success,
    ).toBe(true);
  });

  it('accepts one or more facts:assert keys', () => {
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: ['gate-red-is-flake'] }).success,
    ).toBe(true);
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: ['a-key', 'b-key'] }).success,
    ).toBe(true);
  });

  it('rejects the shapes that would let the field die — empty array, empty string, wrong type', () => {
    const bad: unknown[] = [[], [''], ['   '], '', 'None', true, 0, null, {}];
    for (const assumptions of bad) {
      expect(
        parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions }).success,
        `assumptions: ${JSON.stringify(assumptions)} must be refused`,
      ).toBe(false);
    }
  });

  /**
   * EI-18812234312014879. Rejecting the wrong shape (above) is only half the job —
   * the refusal has to say what the right one IS. Both refusals described the VALUE
   * ("the key(s) ... or the literal \"none\"") without the CONTAINER, so a caller with
   * exactly one key passed a bare string and got back zod's default `Invalid input`:
   * no expected type, no example. Hit live while closing a work item; cost two calls.
   */
  it('names the ARRAY shape when the value is malformed, not a bare "Invalid input"', () => {
    const r = parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'my-fact-key' });
    expect(r.success, 'a bare key string is still (correctly) refused').toBe(false);

    const message = r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
    expect(message, "must not be zod's contentless default").not.toMatch(/^Invalid input$/);
    expect(message, 'must show the brackets, which is the whole point').toContain('["my-fact-key"]');
    expect(message, 'must still offer the "none" escape hatch').toContain('none');
  });

  it('leaves NON-terminal writes alone — no declaration required', () => {
    for (const state of ['wip', 'blocked', 'needs-human', 'open', 'todo']) {
      expect(parse({ id: 'WI-1', state }).success, state).toBe(true);
    }
  });

  it('enforces the rule on LEGACY terminal spellings and case drift, not just done/dropped', () => {
    for (const state of ['passed', 'resolved', 'closed', 'deprecated', 'DONE']) {
      expect(parse({ id: 'WI-1', state, completionRef: REF }).success, state).toBe(false);
      expect(
        parse({ id: 'WI-1', state, completionRef: REF, assumptions: 'none' }).success,
        `${state} + assumptions`,
      ).toBe(true);
    }
  });

  it('a mixed items[] batch refuses as a whole when ONE item omits the declaration', () => {
    expect(
      parse({
        items: [
          { id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' },
          { id: 'WI-2', state: 'done', completionRef: REF },
        ],
      }).success,
    ).toBe(false);
  });
});
