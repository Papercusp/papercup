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

import {
  normalizePersistedAssumptionDeclaration,
  resolveDeclaredAssumptions,
} from './_assumptions';
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

/**
 * EI-19339908198998425 — `["none"]` is the sentinel in a container, and used to be
 * resolved as a fact KEY literally named "none", which of course dangled.
 *
 * Why that was worth fixing rather than filing as caller error: the refusal it
 * produced came from `danglingAssumptionsMessage`, whose remediation is "...or pass
 * \"none\" if this close rests on nothing you recorded" — a description of what the
 * caller had just passed. It names the VALUE and is silent on the CONTAINER, which
 * was the only thing wrong. So the two natural next moves were to re-send the
 * identical call, or to assert a junk fact keyed `none` to satisfy the resolver —
 * i.e. the guard's own error text steered callers into exactly the ledger
 * laundering D-050/D-079 exists to prevent.
 */
describe('resolveDeclaredAssumptions — the ["none"] container fumble (EI-19339908198998425)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectorsFor.mockReturnValue([{ scope: 'workspace', scopeRef: null }]);
  });

  it('treats ["none"] as the sentinel, not as a fact key named "none"', async () => {
    const out = await resolveDeclaredAssumptions({
      declared: ['none'],
      workItemId: 'EI-1',
      ownerId: 'su-1',
    });

    expect(out.declared).toBe('none');
    // Same observable behaviour as the bare sentinel: no ledger read at all, so it
    // cannot dangle. Before the fix this reached resolveAssumptions with ['none'].
    expect(workItem).not.toHaveBeenCalled();
    expect(selectorsFor).not.toHaveBeenCalled();
  });

  it('tolerates surrounding whitespace, since the fumble is a hand-built payload', async () => {
    const out = await resolveDeclaredAssumptions({
      declared: ['  none  '],
      workItemId: 'EI-1',
      ownerId: 'su-1',
    });

    expect(out.declared).toBe('none');
    expect(selectorsFor).not.toHaveBeenCalled();
  });

  /**
   * THE CONTROL. The two assertions above are NEGATIVE (`not.toHaveBeenCalled`),
   * and a negative passes just as happily when the call under test never does
   * anything at all. This case differs from them in exactly one character —
   * the key — and asserts the POSITIVE, so the negatives above carry weight.
   */
  it('CONTROL: an ordinary key array still resolves through the ledger', async () => {
    const out = await resolveDeclaredAssumptions({
      declared: ['nonexistent-but-real-key'],
      workItemId: 'EI-1',
      ownerId: 'su-1',
    });

    expect(out.declared).not.toBe('none');
    expect(selectorsFor).toHaveBeenCalled();
  });

  it('REFUSES the sentinel mixed with real keys — that is a contradiction, not a fumble', async () => {
    // "none" asserts the close rests on NOTHING recorded; a key asserts it rests on
    // that fact. Silently picking either reading would discard a real declaration.
    await expect(
      resolveDeclaredAssumptions({
        declared: ['none', 'gate-red-is-flake-not-regression'],
        workItemId: 'EI-1',
        ownerId: 'su-1',
      }),
    ).rejects.toThrow(/contradictory/i);

    expect(selectorsFor).not.toHaveBeenCalled();
  });
});

describe('normalizePersistedAssumptionDeclaration — read→retry shape (EI-22404076241784390)', () => {
  it('unwraps the stored explicit-none declaration and drops the server timestamp', () => {
    expect(
      normalizePersistedAssumptionDeclaration({
        declared: 'none',
        resolvedAt: '2026-09-05T21:00:00.000Z',
      }),
    ).toBe('none');
  });

  it('recovers the original keys from resolved assumption entries', () => {
    expect(
      normalizePersistedAssumptionDeclaration({
        declared: [
          { declared: 'gate-red-is-flake', condition: 'live', ref: 'fact:workspace:gate-red-is-flake@v1' },
          { declared: 'fact:owner:su-1:staging-is-current', condition: 'lapsed', ref: null },
        ],
        resolvedAt: '2026-09-05T21:00:00.000Z',
      }),
    ).toEqual(['gate-red-is-flake', 'fact:owner:su-1:staging-is-current']);
  });

  it('leaves malformed or ordinary caller values untouched', () => {
    const malformed = { declared: [{ condition: 'live' }], resolvedAt: '2026-09-05T21:00:00.000Z' };
    expect(normalizePersistedAssumptionDeclaration(malformed)).toBe(malformed);
    const native = ['gate-red-is-flake'];
    expect(normalizePersistedAssumptionDeclaration(native)).toBe(native);
  });
});
