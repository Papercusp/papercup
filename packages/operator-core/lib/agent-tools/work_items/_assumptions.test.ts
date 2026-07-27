import { describe, it, expect, vi, beforeEach } from 'vitest';

// The selector builder and the ledger read are both mocked: this suite is about
// WHICH SCOPES the resolver asks for, not about how facts are stored.
vi.mock('../../agent-facts/assumptions', () => ({
  assumptionSelectorsFor: vi.fn(() => [{ scope: 'workspace', scopeRef: null }]),
  resolveAssumptions: vi.fn(async (declared: unknown) =>
    (Array.isArray(declared) ? declared : []).map((key) => ({ key, condition: 'resolved' })),
  ),
  isDanglingCondition: vi.fn(() => false),
  danglingAssumptionsMessage: vi.fn(() => 'dangling assumption'),
}));

vi.mock('../../work-items', () => ({
  getWorkItem: vi.fn(),
}));

import { resolveDeclaredAssumptions } from './_assumptions';
import { assumptionSelectorsFor } from '../../agent-facts/assumptions';
import { getWorkItem } from '../../work-items';

const selectorsFor = vi.mocked(assumptionSelectorsFor);
const workItem = vi.mocked(getWorkItem);

/**
 * EI-18806393166489384 — a fact asserted at `scope:'harness'` for a work-item's
 * OWN harness was refused as unresolvable when the closing call did not also
 * name that harness redundantly.
 *
 * THE DIAGNOSIS THAT MATTERS, because three separate agents filed this and all
 * three got it wrong: the resolver is NOT missing harness support.
 * `assumptionSelectorsFor` has always pushed a 'harness' selector. The defect is
 * that its `push` helper silently no-ops on an empty ref, so when the caller
 * passed an UNDEFINED harness the selector did not merely fail — it vanished,
 * with no error, and the refusal message then truthfully listed the scopes it
 * had searched (work_item, owner, workspace) with harness simply absent. That is
 * why the message reads like a missing feature rather than a dropped argument.
 *
 * Deriving the scope from the work-item here rather than at each call site is
 * deliberate: `complete.ts` happens to have already fetched the row, but
 * `set_state.ts` has not, and a third caller would have to remember. Fixing the
 * two known call sites would leave the trap armed for the next one.
 */
describe('resolveDeclaredAssumptions — harness scope derivation (EI-18806393166489384)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectorsFor.mockReturnValue([{ scope: 'workspace', scopeRef: null }]);
  });

  it("derives the harness scope from the work-item when the caller did not name it", async () => {
    workItem.mockResolvedValue({ id: 'EI-1', harness: 'papercusp' } as never);

    await resolveDeclaredAssumptions({
      declared: ['some-harness-scoped-key'],
      workItemId: 'EI-1',
      ownerId: 'su-1',
      // harnessSlug deliberately omitted — this is the reported call shape.
    });

    expect(selectorsFor).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'papercusp' }),
    );
  });

  it('prefers an explicitly passed harness and does not re-read the work-item', async () => {
    await resolveDeclaredAssumptions({
      declared: ['k'],
      workItemId: 'EI-1',
      ownerId: 'su-1',
      harnessSlug: 'explicit-harness',
    });

    expect(selectorsFor).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: 'explicit-harness' }),
    );
    // The caller already knew the harness, so the derive path must not add a read.
    expect(workItem).not.toHaveBeenCalled();
  });

  // The file's stated discipline: "a PG blip never turns into a fleet-wide block
  // on closing work". The derive is a convenience, so it must never be the thing
  // that fails a close.
  it('fails OPEN when the work-item read throws, rather than blocking the close', async () => {
    workItem.mockRejectedValue(new Error('PG blip'));

    await expect(
      resolveDeclaredAssumptions({
        declared: ['k'],
        workItemId: 'EI-1',
        ownerId: 'su-1',
      }),
    ).resolves.toBeTruthy();

    expect(selectorsFor).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: null }),
    );
  });

  it('does not read the work-item at all for a "none" declaration', async () => {
    const out = await resolveDeclaredAssumptions({
      declared: 'none',
      workItemId: 'EI-1',
      ownerId: 'su-1',
    });

    expect(out.declared).toBe('none');
    expect(workItem).not.toHaveBeenCalled();
    expect(selectorsFor).not.toHaveBeenCalled();
  });
});
