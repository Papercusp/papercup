// @vitest-environment node
/**
 * Projection-vs-feed parity: resolving a curator card `ref` against the SLIM
 * `plans.attentionRefs` rows must give the identical answer as resolving it
 * against the full `plans.attention` items (no-http-anywhere-2026-07-28 D-031).
 *
 * WHY THIS TEST EXISTS. The chat sidebar is mounted by ChromeShell on every
 * non-chromeless route and held the whole attention feed — measured 1,461 KB on
 * :3055 (891 KB on :3270) on a git tab that renders no attention feed at all —
 * for ONE purpose: resolving a card row's ref. D-031 replaced that read with a
 * four-field server-side projection.
 *
 * That is safe ONLY while the projection carries every field the resolver
 * reads, and this subsystem has been bitten twice by exactly this class of
 * drift: the badge-vs-pane divergence `attention-counts-parity.test.ts` guards,
 * and slim-plans-attention D-001, where pushing `harnessSlug` down as a query
 * arg silently dropped ~677 items. A drift here would be just as quiet — an
 * "Open ↗" button that stops rendering, or renders and no-ops, with nothing
 * throwing.
 *
 * Two guards, deliberately of different kinds:
 *   1. TYPE-LEVEL (REF_FIELDS below) — adding a field to `RefDestinationItem`
 *      fails TYPECHECK here until the projection carries it. This is the one
 *      that catches the dangerous case, because a NEW optional field the
 *      projection omits reads as `undefined` at runtime and looks like an item
 *      that simply lacks it.
 *   2. BEHAVIOURAL — both derivations run over the same fixtures and their
 *      resolved destinations must match, ref by ref.
 */
import { describe, expect, it } from 'vitest';
import { deriveAttentionRefs } from '@papercusp/operator-core/lib/sync-resolver/attention-counts';
import {
  refNeedsLiveItems,
  resolveRefDestination,
  type RefDestinationItem,
} from './curator-card-drill-in';

/**
 * Every field the client resolver reads, as a type-checked key set.
 *
 * ⚠ If `RefDestinationItem` gains a field, THIS OBJECT fails to typecheck until
 * you add the key here AND teach `deriveAttentionRefs` (operator-core
 * attention-counts.ts) to carry it. Do not silence it by widening the type —
 * that is the drift this guard exists to catch.
 */
const REF_FIELDS: Record<keyof RefDestinationItem, true> = {
  id: true,
  itemRef: true,
  planSlug: true,
  ownerAgentId: true,
};

/** A feed shaped like the real one: full items, plan-grouped, with the
 *  non-plan-scoped duplication the server actually emits (WI-5337). */
const FULL_ITEMS = [
  {
    id: 'coord-escalation:msg-1',
    kind: 'coord-escalation',
    tier: 'alert',
    title: 'an escalation with an owner',
    body: 'x'.repeat(400),
    ownerAgentId: 'su-abc12345',
    itemRef: null,
    planSlug: null,
    actions: [{ id: 'chat', label: 'Chat' }],
  },
  {
    id: 'wi-blocked:WI-6594',
    kind: 'work-item-blocked',
    tier: 'decision',
    title: 'a blocked work item',
    body: 'y'.repeat(400),
    itemRef: 'papercusp#WI-6594',
    planSlug: 'my-plan-2026-07-17',
    ownerAgentId: 'su-def67890',
  },
  {
    id: 'plan-item:P-003',
    kind: 'plan-item',
    tier: 'decision',
    title: 'a plan item',
    itemRef: null,
    planSlug: 'other-plan-2026-07-20',
    ownerAgentId: null,
  },
  {
    id: 'owner-wall:w-1',
    kind: 'owner-wall',
    tier: 'decision',
    title: 'a workspace-scoped item, emitted into every group',
    itemRef: null,
    planSlug: null,
    ownerAgentId: 'su-999aaaaa',
  },
];

const GROUPS = [
  { planSlug: 'my-plan-2026-07-17', items: [FULL_ITEMS[0], FULL_ITEMS[1], FULL_ITEMS[3]] },
  // FULL_ITEMS[3] appears AGAIN here — the non-plan-scoped duplication.
  { planSlug: 'other-plan-2026-07-20', items: [FULL_ITEMS[2], FULL_ITEMS[3]] },
];

/** Every ref kind the curator emits, plus the ones that resolve to nothing. */
const REFS = [
  'escalation:msg-1',
  'escalation:aged-out-msg',
  'wi:papercusp#WI-6594',
  'wi:WI-6594',
  'plan:my-plan-2026-07-17',
  'plan:other-plan-2026-07-20',
  'papercusp#WI-6594',
  'WI-6594',
  'plan-item:P-003',
  'owner-wall:w-1',
  'health:some-panel',
  'decision:nope',
  '',
];

describe('plans.attentionRefs projection parity (D-031)', () => {
  it('carries exactly the fields the client resolver reads', () => {
    const rows = deriveAttentionRefs(GROUPS);
    const declared = Object.keys(REF_FIELDS).sort();
    // Union of keys actually emitted across the fixture (nulls are omitted on
    // the wire, so no single row need carry all four).
    const emitted = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
    expect(emitted).toEqual(declared.filter((k) => emitted.includes(k)));
    // And every declared field IS reachable — a projection that silently
    // stopped emitting one would otherwise pass the check above.
    expect(emitted).toEqual(declared);
  });

  it('dedupes by id exactly as the feed consumer does', () => {
    const rows = deriveAttentionRefs(GROUPS);
    expect(rows.map((r) => r.id)).toEqual([
      'coord-escalation:msg-1',
      'wi-blocked:WI-6594',
      'owner-wall:w-1',
      'plan-item:P-003',
    ]);
  });

  it('THE INVARIANT: every ref resolves identically over slim rows and full items', () => {
    const slim = deriveAttentionRefs(GROUPS) as RefDestinationItem[];
    const full = FULL_ITEMS as unknown as RefDestinationItem[];
    for (const ref of REFS) {
      expect(resolveRefDestination(ref, slim), `ref ${ref || '(empty)'}`).toEqual(
        resolveRefDestination(ref, full),
      );
    }
  });

  it('the refs that need live items are exactly the ones the projection has to serve', () => {
    // Ties the fetch GATE to this projection: a ref the gate declines to fetch
    // for must resolve without any rows at all, or gating it off would change
    // behaviour.
    for (const ref of REFS.filter((r) => r && !refNeedsLiveItems(r))) {
      expect(resolveRefDestination(ref, []), `ref ${ref}`).toEqual(
        resolveRefDestination(ref, deriveAttentionRefs(GROUPS) as RefDestinationItem[]),
      );
    }
  });

  it('drops id-less rows rather than emitting unmatchable ones', () => {
    const rows = deriveAttentionRefs([{ items: [{ title: 'no id' }, { id: 'ok' }] }]);
    expect(rows).toEqual([{ id: 'ok' }]);
  });
});
