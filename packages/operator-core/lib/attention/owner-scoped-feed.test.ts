/**
 * WI-2144754 — the session popup's Decisions shelf must be scoped to its
 * agent BEFORE the feed is paged, never after.
 *
 * The bug this pins was not a wrong filter; the filter was correct. It ran in
 * the browser, over `plans.attention`'s FIRST PAGE (100 items, offset 0, and
 * `SessionChatModal` never calls `loadMore`). So the popup asked "which of the
 * newest 100 attention items fleet-wide belong to this agent" when it meant
 * "which items belong to this agent" — two questions that agree only while the
 * feed is small. Measured 2026-09-05 on papercusp-workspace: 294 open
 * escalations, 145 of them agent-filed decision-tier, against that 100-item
 * page. 13 of 13 live sessions driven in the Tauri shell showed an empty
 * shelf, one of them while genuinely holding two open `question` escalations
 * that sat 97 places past the boundary.
 *
 * An empty shelf and "nothing needs you" render identically, which is why it
 * stayed invisible. These tests therefore assert the ORDER of the two
 * operations, not merely that a filter exists — a scope applied after the page
 * still type-checks, still filters, and still loses the item.
 */
import { describe, it, expect } from 'vitest';
import { buildAttentionGroups, scopeGroupsToOwner } from './group';
import { coordEscalationToAttention } from './adapters';
import { paginateAttentionGroups } from './window';
import { groupByTier, type AttentionItem } from './types';

/**
 * An owner-owed decision-tier ask, as `coord:ask-owner` files it.
 *
 * `occurredAt` is stamped by the READER (agent-tools/plans/attention.ts, from
 * the escalation's `ts`), not by the adapter — so it must be added here or the
 * window's ordering falls through to its `id.localeCompare` tiebreak and the
 * fixture orders alphabetically instead of by recency. That tiebreak is fine
 * in production, where every escalation carries a timestamp, and fatal in a
 * fixture meant to reproduce burial: a target named "mine" sorts to the FRONT
 * of a hundred "other" rows and the control passes for the wrong reason.
 */
function ask(msgId: string, from: string, occurredAt: string): AttentionItem {
  return {
    ...coordEscalationToAttention({
      msgId,
      severity: 'question',
      summary: `ask ${msgId}`,
      from,
      options: [],
    }),
    occurredAt,
  };
}

const MINE_ASKED_AT = '2026-09-04T09:28:42.982Z';

/**
 * The measured shape: one agent's ask buried under a fleet's worth of NEWER
 * asks from other agents, all decision-tier, so tier ranking cannot rescue it.
 * Mirrors the live case — su-17376349's 09:28 ask sat behind 97 newer ones.
 */
function fleetFeedBurying(target: AttentionItem, aheadOfIt: number) {
  const base = Date.parse(MINE_ASKED_AT);
  const others = Array.from({ length: aheadOfIt }, (_, i) =>
    ask(
      `other-${String(i).padStart(4, '0')}`,
      `su-other-${i}`,
      new Date(base + (i + 1) * 60_000).toISOString(),
    ),
  );
  return buildAttentionGroups([...others, target]);
}

describe('owner-scoped attention feed (WI-2144754)', () => {
  const MINE = 'su-mine';
  const PAGE = 100;

  it('scoping BEFORE the page returns the agent\'s ask even when it sorts far past the page', () => {
    const mine = ask('mine-1', MINE, MINE_ASKED_AT);
    const groups = fleetFeedBurying(mine, 145);

    const scopedThenPaged = paginateAttentionGroups(scopeGroupsToOwner(groups, MINE), {
      limit: PAGE,
      offset: 0,
    });

    const ids = scopedThenPaged.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual([mine.id]);
    expect(scopedThenPaged.meta.total).toBe(1);
    expect(scopedThenPaged.meta.hasMore).toBe(false);
  });

  it('paging BEFORE the scope loses it — this is the regression, kept as a control', () => {
    const mine = ask('mine-1', MINE, MINE_ASKED_AT);
    const groups = fleetFeedBurying(mine, 145);

    // Exactly what the popup used to do: take page one of the fleet-wide feed,
    // then filter it client-side by owner.
    const pagedThenScoped = paginateAttentionGroups(groups, { limit: PAGE, offset: 0 })
      .groups.flatMap((g) => g.items)
      .filter((i) => i.ownerAgentId === MINE);

    expect(pagedThenScoped).toEqual([]);
    // ...and the page was FULL, so nothing about the result says "truncated":
    // an empty shelf here is indistinguishable from having no open asks.
    expect(paginateAttentionGroups(groups, { limit: PAGE, offset: 0 }).meta.returned).toBe(PAGE);
  });

  it('scoping keeps every one of the agent\'s items and no one else\'s', () => {
    const a = ask('mine-1', MINE, MINE_ASKED_AT);
    const b = ask('mine-2', MINE, '2026-09-04T10:00:00.000Z');
    const groups = buildAttentionGroups([
      ask('theirs-1', 'su-other', '2026-09-04T11:00:00.000Z'),
      a,
      ask('theirs-2', 'su-other-2', '2026-09-04T12:00:00.000Z'),
      b,
    ]);

    const scoped = scopeGroupsToOwner(groups, MINE);
    const items = scoped.flatMap((g) => g.items);
    expect(items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect(items.every((i) => i.ownerAgentId === MINE)).toBe(true);
  });

  it('drops groups emptied by the scope rather than leaving a titled empty shelf', () => {
    const groups = buildAttentionGroups([
      ask('theirs-1', 'su-other', '2026-09-04T11:00:00.000Z'),
      ask('mine-1', MINE, MINE_ASKED_AT),
    ]);
    expect(groups.length).toBeGreaterThan(0);

    const scoped = scopeGroupsToOwner(groups, 'su-nobody');
    expect(scoped).toEqual([]);
    expect(scoped.every((g) => g.items.length > 0)).toBe(true);
  });

  it('re-derives group ordering metadata instead of carrying the unscoped feed\'s', () => {
    // A splice-based scope would keep `maxImportance` from an item that the
    // scope removed, so the surviving group would claim an urgency no item in
    // it justifies.
    // `blocker`, not `critical`: severityToImportance's union is
    // blocker|question|advisory, so an out-of-union severity falls to the
    // `normal` default and the two items end up sharing a maxImportance —
    // which made the final assertion below pass vacuously on the first run.
    const theirsUrgent = coordEscalationToAttention({
      msgId: 'theirs-urgent',
      severity: 'blocker',
      summary: 'theirs',
      from: 'su-other',
      options: [],
    });
    const mineQuiet = ask('mine-quiet', MINE, MINE_ASKED_AT);
    const groups = buildAttentionGroups([theirsUrgent, mineQuiet]);
    const together = groups.find((g) => g.items.some((i) => i.id === mineQuiet.id))!;

    const scoped = scopeGroupsToOwner(groups, MINE);
    const mineGroup = scoped.find((g) => g.items.some((i) => i.id === mineQuiet.id))!;

    expect(mineGroup.items).toHaveLength(1);
    expect(mineGroup.maxImportance).toBe(mineQuiet.importance);
    // Only meaningful as a regression guard if the unscoped group really did
    // carry a different (louder) importance — otherwise this passes vacuously.
    expect(together.maxImportance).not.toBe(mineGroup.maxImportance);
  });

  it('tier counts describe the scoped set, so a scoped read cannot report fleet-wide totals', () => {
    const mine = ask('mine-1', MINE, MINE_ASKED_AT);
    const groups = fleetFeedBurying(mine, 145);

    const unscoped = groupByTier(groups.flatMap((g) => g.items)).counts;
    const scoped = groupByTier(scopeGroupsToOwner(groups, MINE).flatMap((g) => g.items)).counts;

    expect(unscoped.decision).toBe(146);
    expect(scoped.decision).toBe(1);
  });
});
