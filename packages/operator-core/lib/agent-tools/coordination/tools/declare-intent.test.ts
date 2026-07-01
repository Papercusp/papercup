/**
 * Handler-level tests for coord:declare-intent's lane VALIDATION (EI-356):
 * declared items are checked against the same parsed-item set plans:items /
 * plans:set-status see (planItemsForRow — kept REAL here), so an id those
 * surfaces reject with item_not_found is never silently claimed. Unknown ids
 * come back in `claims.unknown` + `hint`; an entirely-unknown lane (or a
 * missing plan) skips reconcile so a typo'd declaration can't release the
 * caller's real claims; an explicit `[]` still releases the whole lane.
 *
 * The PG-touching seams (presence, plan row read, reconcile) are mocked at
 * their modules; planItemsForRow + the zod schema run real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── module-seam mocks (arrow-deref so the hoisted vi.mock factory sees them) ──
const writePresence = vi.fn(async () => {});
const getPresence = vi.fn(async () => ({ ownerId: 'su-test', intent: 'x' }));
vi.mock('../presence', async (importOriginal) => ({
  // Spread the real module so PRESENCE_STALE_MS (consumed transitively by
  // presence-wakeability.ts via fleet-roster) survives; override only the
  // PG-touching fns we stub.
  ...(await importOriginal<typeof import('../presence')>()),
  writePresence: (...a: unknown[]) => writePresence(...(a as [])),
  getPresence: (...a: unknown[]) => getPresence(...(a as [])),
}));

const resolveAgentIdentity = vi.fn(() => ({ ownerId: 'su-test', ownerLabel: 'su · test' }));
vi.mock('../identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => resolveAgentIdentity(...(a as [])),
}));

const resolvePlanScope = vi.fn(async () => ({ workspaceId: 'ws-test', harnessSlug: 'papercup' }));
const getPlanRow = vi.fn<() => Promise<Record<string, unknown> | null>>(async () => null);
vi.mock('../../plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), // planItemsForRow stays REAL
  resolvePlanScope: (...a: unknown[]) => resolvePlanScope(...(a as [])),
  getPlanRow: (...a: unknown[]) => getPlanRow(...(a as [])),
}));

const reconcileDeclaredClaims = vi.fn(
  async (opts: { items: string[] }) => ({
    claimed: [...opts.items],
    alreadyHeld: [],
    conflicts: [],
    released: [],
  }),
);
vi.mock('../../../plan-items/claim-discipline', () => ({
  reconcileDeclaredClaims: (...a: unknown[]) =>
    reconcileDeclaredClaims(...(a as [{ items: string[] }])),
}));
vi.mock('../../../plan-items/agent-names', () => ({
  resolveAdoptedName: async () => null,
  bestEffortOwnerUser: () => 'tester',
}));

// SUT imported AFTER the seams are wired.
import declareIntentTool from './declare-intent';

type Tool = {
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const tool = declareIntentTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
const ctx = {} as never;

/** A plan row whose Stage-3 structured index carries the given item ids. */
const rowWithItems = (ids: string[]): Record<string, unknown> => ({
  items: ids.map((id) => ({
    id,
    status: 'todo',
    text: `item ${id}`,
    importance: 'normal',
    blockedBy: [],
    decisionRefs: [],
    phase: null,
  })),
  content: '# plan\n',
});

beforeEach(() => {
  vi.clearAllMocks();
  getPlanRow.mockResolvedValue(null);
});

describe('coord:declare-intent lane validation (EI-356)', () => {
  it('items that parse as plan items are claimed (the happy path is unchanged)', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001', 'P-002']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001', 'P-002']);
    expect(claims.unknown).toBeUndefined();
  });

  it('a mixed lane claims only the parseable ids and reports the rest as unknown', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-099'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']);
    expect(claims.unknown).toEqual(['P-099']);
    expect(String(claims.hint)).toMatch(/item_not_found/);
  });

  it('the EI-356 repro: legacy checkbox lines parse as NO items → nothing claimed, nothing released', async () => {
    // Exactly the filed shape: `- [ ] P-006 …` checkbox lines, empty structured index.
    getPlanRow.mockResolvedValue({
      items: [],
      content: '# plan\n\n- [ ] P-006 grading UI\n- [ ] P-007 lens chips\n',
    });
    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'scout-idea-grading', items: ['P-006', 'P-007'] },
        ctx,
      ),
    );
    expect(res.ok).toBe(true); // presence must still write
    expect(writePresence).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled(); // a typo'd lane releases nothing
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual([]);
    expect(claims.unknown).toEqual(['P-006', 'P-007']);
    expect(String(claims.hint)).toMatch(/plans:items|plan format/);
  });

  it('a missing plan claims nothing and says so', async () => {
    getPlanRow.mockResolvedValue(null);
    const res = parse(
      await tool.handler({ intent: 'work', current_plan_slug: 'no-such-plan', items: ['P-001'] }, ctx),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
    const claims = res.claims as Record<string, unknown>;
    expect(claims.unknown).toEqual(['P-001']);
    expect(String(claims.hint)).toMatch(/not found/);
  });

  it('an explicit [] still releases the whole lane (reconcile runs with no items)', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001']));
    const res = parse(
      await tool.handler({ intent: 'done here', current_plan_slug: 'my-plan', items: [] }, ctx),
    );
    expect(res.ok).toBe(true);
    expect(reconcileDeclaredClaims).toHaveBeenCalledTimes(1);
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual([]);
  });

  it('items without current_plan_slug is still rejected', async () => {
    const res = parse(await tool.handler({ intent: 'work', items: ['P-001'] }, ctx));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/current_plan_slug/);
  });

  it('the items-without-plan guard writes NOTHING — no presence row, no lane reconcile (P2-14)', async () => {
    // The guard short-circuits at handler top (declare-intent.ts:78-91) BEFORE
    // writePresence / reconcileDeclaredClaims, so a malformed call leaves no
    // presence or lane-claim side effect — it isn't a half-applied declaration.
    const res = parse(await tool.handler({ intent: 'work', items: ['P-001'] }, ctx));
    expect(res.ok).toBe(false);
    expect(res.isError ?? undefined).toBeUndefined(); // parse() reads only the text body
    expect(String(res.error)).toMatch(/items requires current_plan_slug/);
    expect(writePresence).not.toHaveBeenCalled();
    expect(reconcileDeclaredClaims).not.toHaveBeenCalled();
  });

  it('the guard sets isError:true on the tool result (P2-14)', async () => {
    const raw = (await tool.handler({ intent: 'work', items: ['P-001'] }, ctx)) as unknown as {
      isError?: boolean;
    };
    expect(raw.isError).toBe(true);
  });
});

describe('coord:declare-intent conflict surfacing (the DOUBLE-PLACEMENT invariant)', () => {
  // The MCP contract: "a claim_conflict means a live peer holds it — coordinate,
  // don't take it." reconcileDeclaredClaims REPORTS a contested item rather than
  // throwing; the handler must still succeed (presence written, the rest of the
  // lane claimed) and surface `claims.conflicts` VERBATIM so the caller can re-lane.
  // The EI-356 suite above only ever sees the mock's default `conflicts:[]`, so
  // the handler's behavior WHEN A CONFLICT IS RETURNED was asserted nowhere — this
  // pins it.
  it('a reported conflict does NOT fail the call: presence still writes, the rest of the lane still claims, conflict surfaced verbatim', async () => {
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    reconcileDeclaredClaims.mockResolvedValueOnce({
      claimed: ['P-001'],
      conflicts: [{ item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' }],
      released: [],
      alreadyHeld: [],
    } as never);

    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002'] },
        ctx,
      ),
    );

    expect(res.ok).toBe(true); // a contested item is REPORTED, never thrown
    expect(writePresence).toHaveBeenCalledTimes(1); // presence still written
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']); // the uncontested item still claims
    // the conflict is carried through the envelope BYTE-FOR-BYTE (reason + holder intact)
    expect(claims.conflicts).toEqual([
      { item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' },
    ]);
    expect(claims.unknown).toBeUndefined(); // every declared id parsed — no unknown leg
  });

  it('a mixed unknown-id + conflict lane: conflict surfaced verbatim AND unknown reported alongside', async () => {
    // P-001 claims, P-002 conflicts (live peer), P-099 is not a plan item.
    getPlanRow.mockResolvedValue(rowWithItems(['P-001', 'P-002']));
    reconcileDeclaredClaims.mockResolvedValueOnce({
      claimed: ['P-001'],
      conflicts: [{ item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' }],
      released: [],
      alreadyHeld: [],
    } as never);

    const res = parse(
      await tool.handler(
        { intent: 'work', current_plan_slug: 'my-plan', items: ['P-001', 'P-002', 'P-099'] },
        ctx,
      ),
    );

    expect(res.ok).toBe(true);
    expect(writePresence).toHaveBeenCalledTimes(1);
    // only the KNOWN ids reach reconcile — the unknown id is filtered before the claim seam
    expect(reconcileDeclaredClaims.mock.calls[0][0].items).toEqual(['P-001', 'P-002']);
    const claims = res.claims as Record<string, unknown>;
    expect(claims.claimed).toEqual(['P-001']);
    expect(claims.conflicts).toEqual([
      { item: 'P-002', reason: 'claimed by su · peer — coordinate', holder: 'su-peer' },
    ]);
    // the unknown leg is spread on TOP of the reconcile result — both survive
    expect(claims.unknown).toEqual(['P-099']);
    expect(String(claims.hint)).toMatch(/item_not_found/);
  });
});
