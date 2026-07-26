/**
 * Attention COUNTS — the aggregate behind the always-mounted inbox badges,
 * without shipping the feed those badges are counting (WI-5955).
 *
 * THE PROBLEM. `useInboxPendingCount` (the sidebar "needs you" badge) and
 * `usePlansNeedingYouCount` (the Plans-face badge) are mounted on every app
 * start, and both derived their number by pulling the WHOLE unscoped
 * `plans.attention` feed — ~1MB after the P-003 projection — to compute two
 * integers. A session that never opens the Inbox paid the entire feed for a
 * badge; a session that did opened a SECOND, harness-scoped copy alongside it.
 *
 * WHY NOT THE OBVIOUS FIXES. Two smaller-looking options are both wrong:
 *   - "have the badge read the scoped feed the panels already fetch" —
 *     undercounts. The badge answers "how many decisions need you" across the
 *     WORKSPACE; a harness-scoped feed silently drops the rest.
 *   - "have the panels client-filter the unscoped feed" — measured and
 *     refuted (plan slim-plans-attention-sync-payload-2026-07-26 D-001).
 *     `harnessSlug` is pushed down into ~10 sources as a server-side query
 *     arg, so the filtered-away rows never carry the field that filtered them.
 * So the feed cannot be shared. What CAN be shared is the cheap aggregate.
 *
 * DRIFT IS THE REAL RISK HERE, NOT BYTES. The badge and the pane's own chips
 * were deliberately derived from ONE client-side list so they could never
 * disagree (the comment in use-inbox-pending.ts says exactly that). Moving the
 * count server-side reintroduces the chance they diverge, so:
 *   - the derivation below is a faithful mirror of the client's, INCLUDING the
 *     dedupe-by-id and the `effectiveTier` wire-lag fallback, and
 *   - `attention-counts-parity.test.ts` (apps/operator) pins the two against a
 *     shared case table, so a change to one that is not made to the other reds.
 * Counting here rather than from the tool's own `tierCounts` is deliberate for
 * the same reason: `tierCounts` is computed pre-grouping over an internal list,
 * whereas the client counts the GROUPS it renders. Counting what the client
 * counts is what makes the parity test meaningful.
 *
 * NOTE ON WHAT THIS SAVES. Server-side work is unchanged — this rides the same
 * `cachedRead` entry the feed uses. The saving is wire bytes, IPC/base64
 * inflation, JSON.parse, and retained client memory: ~1MB becomes ~100 bytes.
 */

/** The attention tiers, as the client's `AttentionTier` union. */
export type AttentionTierName = 'decision' | 'alert' | 'activity' | 'handled';

interface AttentionItemish {
  id?: unknown;
  tier?: unknown;
  kind?: unknown;
  needsHuman?: unknown;
  planSlug?: unknown;
}

interface AttentionGroupish {
  items?: unknown;
}

export interface AttentionCounts {
  /** Decision-tier items — the "needs you" badge. */
  decisionItems: number;
  /** DISTINCT plans with >=1 decision-tier item — the Plans-face badge. */
  decisionPlans: number;
  /** Alert-tier items (the alerts affordance reads this). */
  alerts: number;
  /** Total distinct items in the feed — lets a consumer tell "empty feed" from
   *  "feed loaded, nothing needs you", which a bare zero cannot. */
  total: number;
}

/**
 * The tier of an attention item, with the wire-lag fallback.
 *
 * MUST stay identical to `effectiveTier` in
 * apps/operator/app/_components/inbox/use-inbox-pending.ts — a row served by a
 * pre-tier server arrives without `tier`, and both sides infer it the same way.
 */
export function effectiveAttentionTier(item: AttentionItemish): AttentionTierName {
  const tier = item.tier;
  if (typeof tier === 'string' && tier) return tier as AttentionTierName;
  if (item.needsHuman === true) return 'decision';
  if (item.kind === 'smoke-fail' || item.kind === 'coord-escalation') return 'alert';
  return 'activity';
}

/**
 * Derive the badge counts from the attention groups.
 *
 * Dedupes by `id` first: an item that is not plan-scoped (an owner-wall, a
 * loop carry-note, a workspace alert) is emitted into MULTIPLE plan groups, so
 * a bare flatMap counts it 2-5 times — the same duplication WI-5337 fixed
 * client-side. Counting without the dedupe makes the badge disagree with the
 * list the user then opens.
 */
export function deriveAttentionCounts(groups: readonly unknown[]): AttentionCounts {
  const seen = new Set<string>();
  const decisionPlans = new Set<string>();
  let decisionItems = 0;
  let alerts = 0;

  for (const group of groups) {
    const items = (group as AttentionGroupish | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as AttentionItemish;
      const id = typeof item.id === 'string' ? item.id : null;
      // An id-less row cannot be deduped; skip it rather than over-count.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const tier = effectiveAttentionTier(item);
      if (tier === 'decision') {
        decisionItems += 1;
        if (typeof item.planSlug === 'string' && item.planSlug) decisionPlans.add(item.planSlug);
      } else if (tier === 'alert') {
        alerts += 1;
      }
    }
  }

  return { decisionItems, decisionPlans: decisionPlans.size, alerts, total: seen.size };
}
