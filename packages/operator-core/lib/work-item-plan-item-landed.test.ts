/**
 * Tests for the claim-time "THE TREE SAYS DONE" hint (EI-18713141708830049).
 *
 * Only the PURE surface is exercised here — the predicate, the reference resolver and
 * the rendered warning. The PG read is fail-soft by construction (its whole body is
 * inside one try/catch returning null), so the behaviour worth pinning is the logic a
 * future edit could silently weaken.
 *
 * Falsifiability: per the repo's mutation-probe policy ("a MODULE / logic you import"
 * row), the deliberately-wrong implementations live PERMANENTLY in this file as
 * controls rather than being mutated into the real module. An in-tree mutation on this
 * shared, continuously-swept checkout can be committed by git-sync even when nothing
 * goes wrong, so the copy-out/control form is the only safe one here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getClaimTimePlanItemLanded,
  isTerminalPlanItemStatus,
  planItemLandedWarning,
  proseNamesPlanItem,
  resolvePlanItemRef,
  type ClaimTimePlanItemLandedHint,
} from './work-item-plan-item-landed';

const SLUG = 'shared-hive-cross-machine-scale-10k-2026-06-29';
const ITEM = 'P-020';

const hint = (over: Partial<ClaimTimePlanItemLandedHint> = {}): ClaimTimePlanItemLandedHint => ({
  planSlug: SLUG,
  itemId: ITEM,
  planItemStatus: 'todo',
  siblings: [{ workItemId: 'WI-1234', title: 'landed it', state: 'done', linkSource: 'stamp' }],
  strongest: 'stamp',
  ...over,
});

describe('proseNamesPlanItem', () => {
  it('matches only when BOTH the plan slug and the item id are present', () => {
    expect(proseNamesPlanItem(`fix for ${SLUG} ${ITEM}`, SLUG, ITEM)).toBe(true);
  });

  /**
   * THE SAFETY PROPERTY THIS MODULE RESTS ON. A bare "P-020" appears in plan items of
   * every plan in the workspace, so matching on it alone would attach one plan's
   * sibling to another plan's item — and a false "your work already landed" is worse
   * than no hint, because it invites an agent to skip work that was never done.
   */
  it('REJECTS a bare item id with no plan slug — the ambiguity guard', () => {
    expect(proseNamesPlanItem('STAGE B — something about P-020', SLUG, ITEM)).toBe(false);
  });

  it('rejects the plan slug alone', () => {
    expect(proseNamesPlanItem(`work on ${SLUG}`, SLUG, ITEM)).toBe(false);
  });

  it('is case-insensitive in both operands', () => {
    expect(proseNamesPlanItem(`${SLUG.toUpperCase()} ${ITEM.toLowerCase()}`, SLUG, ITEM)).toBe(true);
  });

  it('is empty-safe rather than throwing', () => {
    expect(proseNamesPlanItem('', SLUG, ITEM)).toBe(false);
    expect(proseNamesPlanItem('anything', '', ITEM)).toBe(false);
    expect(proseNamesPlanItem('anything', SLUG, '')).toBe(false);
  });

  describe('falsifiability controls (permanent wrong implementations)', () => {
    /** The exact bug the ambiguity guard exists to prevent: item id alone. */
    const matchesItemIdOnly = (text: string, _slug: string, itemId: string) =>
      text.toLowerCase().includes(itemId.toLowerCase());
    /** The other plausible weakening: either operand rather than both. */
    const matchesEither = (text: string, slug: string, itemId: string) =>
      text.toLowerCase().includes(slug.toLowerCase()) || text.toLowerCase().includes(itemId.toLowerCase());

    const ambiguous = 'STAGE B — something about P-020';

    it('the controls accept what the real predicate rejects', () => {
      // If this ever fails, the controls have stopped being wrong and the tests above
      // prove nothing.
      expect(matchesItemIdOnly(ambiguous, SLUG, ITEM)).toBe(true);
      expect(matchesEither(ambiguous, SLUG, ITEM)).toBe(true);
      expect(proseNamesPlanItem(ambiguous, SLUG, ITEM)).toBe(false);
    });

    it('calibration: the real predicate still accepts a genuine both-operand match', () => {
      // Without this, a predicate hard-coded to `false` would pass every test above.
      const genuine = `${SLUG} ${ITEM} implemented`;
      expect(proseNamesPlanItem(genuine, SLUG, ITEM)).toBe(true);
      expect(matchesItemIdOnly(genuine, SLUG, ITEM)).toBe(true);
    });
  });
});

describe('isTerminalPlanItemStatus', () => {
  it.each(['done', 'dropped', 'DONE', ' done '])('treats %j as terminal', (s) => {
    expect(isTerminalPlanItemStatus(s)).toBe(true);
  });

  it.each(['todo', 'wip', 'blocked', ''])('treats %j as non-terminal', (s) => {
    expect(isTerminalPlanItemStatus(s)).toBe(false);
  });
});

/**
 * DISJOINTNESS WITH work-item-plan-contradiction.ts (WI-39498).
 *
 * The two modules are mirrors: that one requires a TERMINAL plan item, this one
 * requires a NON-terminal one. They therefore cannot both fire for one subject. Pinned
 * here so a future edit cannot quietly turn a single divergence into two competing
 * warnings — which would be worse than either alone, because an agent reading both has
 * no way to tell which direction is real.
 */
describe('disjointness with the plan-says-done hint', () => {
  /**
   * A DRIFT PIN, not a tautology. The two modules partition plan-item status between
   * them, but each states its own half independently: this module lists
   * TERMINAL_PLAN_ITEM_STATUSES, while work-item-plan-contradiction.ts inlines
   * `status !== 'done' && status !== 'dropped'`. If someone adds a third terminal
   * status (say 'superseded') to one and not the other, the partition silently grows a
   * GAP — a status where neither hint fires — and nothing else in the tree would catch
   * it. So assert the sibling really does gate on exactly the statuses we call terminal.
   */
  it("the sibling module gates on exactly this module's terminal set", () => {
    const sibling = readFileSync(join(__dirname, 'work-item-plan-contradiction.ts'), 'utf8');
    for (const status of ['done', 'dropped']) {
      expect(
        sibling.includes(`'${status}'`),
        `work-item-plan-contradiction.ts must still treat '${status}' as terminal, or the two ` +
          `directions no longer partition plan-item status between them.`,
      ).toBe(true);
      expect(isTerminalPlanItemStatus(status)).toBe(true);
    }
    // And the statuses this module must claim are ones the sibling declines.
    for (const status of ['todo', 'wip', 'blocked']) {
      expect(isTerminalPlanItemStatus(status)).toBe(false);
    }
  });
});

describe('resolvePlanItemRef', () => {
  it('prefers the payload stamp over explicit arguments', () => {
    expect(
      resolvePlanItemRef({
        payload: { plan_item: { plan_slug: SLUG, item_id: ITEM } },
        planSlug: 'other-plan',
        planItemId: 'P-001',
      }),
    ).toEqual({ planSlug: SLUG, itemId: ITEM });
  });

  it('falls back to explicit arguments when there is no stamp', () => {
    expect(resolvePlanItemRef({ planSlug: SLUG, planItemId: ITEM })).toEqual({
      planSlug: SLUG,
      itemId: ITEM,
    });
  });

  it('returns null when only half the reference is available', () => {
    expect(resolvePlanItemRef({ planSlug: SLUG })).toBeNull();
    expect(resolvePlanItemRef({ planItemId: ITEM })).toBeNull();
    expect(resolvePlanItemRef({})).toBeNull();
    expect(resolvePlanItemRef({ payload: { plan_item: { plan_slug: SLUG } } })).toBeNull();
  });

  it('tolerates junk payloads rather than throwing', () => {
    expect(resolvePlanItemRef({ payload: null })).toBeNull();
    expect(resolvePlanItemRef({ payload: 'not an object' })).toBeNull();
    expect(resolvePlanItemRef({ payload: { plan_item: 42 } as unknown })).toBeNull();
  });

  // The COLUMN tier. Measured coverage is why it exists at all: the payload stamp
  // reaches 24 of 119 real work-items and source_plan_slug another 7, so dropping the
  // columns would leave those 7 resolvable only by prose.
  it('falls back to the source_plan columns when there is no stamp and no explicit ref', () => {
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: [ITEM] })).toEqual({
      planSlug: SLUG,
      itemId: ITEM,
    });
  });

  it('lets the stamp and explicit arguments outrank the columns', () => {
    expect(
      resolvePlanItemRef({
        payload: { plan_item: { plan_slug: SLUG, item_id: ITEM } },
        sourcePlanSlug: 'other-plan',
        sourcePlanItemIds: ['P-001'],
      }),
    ).toEqual({ planSlug: SLUG, itemId: ITEM });

    expect(
      resolvePlanItemRef({
        planSlug: SLUG,
        planItemId: ITEM,
        sourcePlanSlug: 'other-plan',
        sourcePlanItemIds: ['P-001'],
      }),
    ).toEqual({ planSlug: SLUG, itemId: ITEM });
  });

  // The guard that keeps a false hint off the wire: with several linked plan items
  // there is no principled pick, and naming the wrong one would assert "already landed"
  // about work that is not this item's. Staying silent is the cheaper error.
  it('refuses to guess when the columns name more than one plan item', () => {
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: [ITEM, 'P-021'] })).toBeNull();
  });

  it('ignores blank and empty column ids rather than resolving half a reference', () => {
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: [] })).toBeNull();
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: ['   '] })).toBeNull();
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: null })).toBeNull();
    expect(resolvePlanItemRef({ sourcePlanItemIds: [ITEM] })).toBeNull();
    // One real id beside blanks is still exactly one real id.
    expect(resolvePlanItemRef({ sourcePlanSlug: SLUG, sourcePlanItemIds: ['', ITEM] })).toEqual({
      planSlug: SLUG,
      itemId: ITEM,
    });
  });
});

describe('getClaimTimePlanItemLanded', () => {
  it('returns null without touching PG when no plan item resolves', async () => {
    // No stamp and no explicit reference => the overwhelmingly common claim, which
    // must be completely unaffected by this leg (and must not require a database).
    await expect(getClaimTimePlanItemLanded({ workItemId: 'WI-1', payload: {} })).resolves.toBeNull();
  });

  it('returns null when the work-item id is missing', async () => {
    await expect(
      getClaimTimePlanItemLanded({ workItemId: '', planSlug: SLUG, planItemId: ITEM }),
    ).resolves.toBeNull();
  });
});

describe('planItemLandedWarning', () => {
  it('returns null for no hint — saying nothing asserts nothing', () => {
    expect(planItemLandedWarning(null, 'WI-1')).toBeNull();
  });

  it('names the plan item, the stored status and every sibling', () => {
    const msg = planItemLandedWarning(hint(), 'WI-9') ?? '';
    expect(msg).toContain(`${SLUG}#${ITEM}`);
    expect(msg).toContain("still 'todo'");
    expect(msg).toContain('WI-1234');
    expect(msg).toContain('matched by stamp');
  });

  it('prescribes reconcile-then-close rather than a bare warning', () => {
    const msg = planItemLandedWarning(hint(), 'WI-9') ?? '';
    expect(msg).toContain('plans:set-status');
    expect(msg).toContain('WI-9');
  });

  /**
   * The derived tier must announce itself. This is the telemetry-call-origin lesson:
   * a wrong classification that renders identically to a right one is what lets a bad
   * inference survive contact with a reader.
   */
  it('flags a prose-only match as DERIVED', () => {
    const msg =
      planItemLandedWarning(
        hint({
          strongest: 'prose',
          siblings: [{ workItemId: 'WI-7', title: 't', state: 'done', linkSource: 'prose' }],
        }),
        'WI-9',
      ) ?? '';
    expect(msg).toContain('DERIVED FROM PROSE');
    expect(msg).toContain('CONFIRM');
  });

  it('does NOT add the derived caveat when a recorded link backs the hint', () => {
    const msg = planItemLandedWarning(hint({ strongest: 'stamp' }), 'WI-9') ?? '';
    expect(msg).not.toContain('DERIVED FROM PROSE');
  });
});
