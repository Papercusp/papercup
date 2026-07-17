/**
 * affected-owners — identify the live sessions routed through an account at the
 * moment it is disabled, and format the at-risk alert (EI-15153, P-001 + detector).
 *
 * Incident (2026-07-17 ~20:30Z): inference account 'aviynw7' was org/subscription
 * DISABLED; the gateway correctly removed it from the pool + broadcast, BUT the
 * live sessions routing through it (su-b621dc7f mid-E2E, su-18f2fc5d) went cold
 * WITHOUT a handoff — orphaning claimed work. The gateway's org-disallowed
 * broadcast was untargeted ("to *"), so nobody knew WHICH sessions were at risk.
 *
 * This module is the PURE core of the fix: given a snapshot of the gateway's
 * per-owner routing ledger, it selects the owners whose LAST route was the
 * now-dead account (recently) — i.e. the sessions that did NOT successfully
 * fail over off it and are therefore at risk of a cold orphan — and formats the
 * at-risk line the disable escalation/broadcast now carries. Kept pure (no PG /
 * gateway internals) so it unit-tests directly; the gateway wires the snapshot
 * in (it owns `ownerLedger`) and launch.ts appends the formatted line to the
 * existing alert.
 *
 * Scope note: this is the DETECTOR half (identify + name who is at risk). The
 * ACTING halves — a directed self-drain wake to each at-risk session, and an
 * orphan-claim reaper — are deliberately NOT here (they change live behavior in
 * the critical gateway disable path and carry a real policy choice; held for the
 * owner go on plan account-disable-graceful-drain-2026-07-17, D1/D2).
 */

/** The fields of an owner's routing-ledger entry this selection needs — a
 *  structural subset of the gateway's internal OwnerLedgerEntry so the accessor
 *  is decoupled from the gateway's private shape. */
export interface OwnerRouteSnapshot {
  ownerId: string;
  /** The account this owner most-recently routed through (null = never routed). */
  lastAccount: string | null;
  /** Epoch ms of the owner's last routing activity. */
  lastAt: number;
}

/** How recent an owner's last activity must be to count as an at-risk LIVE
 *  session (vs. a long-idle ledger entry that happens to name the account). The
 *  disable fires moments after the affected sessions' 403s, so their lastAt is
 *  seconds old; this window is generous but still excludes stale entries. */
export const AFFECTED_OWNER_RECENCY_MS = 10 * 60_000;

/**
 * The owners at risk of an orphaned cold-death from `accountId` being disabled:
 * those whose LAST route was that account (they did not fail over off it) and
 * who were active within `recencyMs`. Sorted + de-duplicated for a stable alert.
 * An owner who successfully moved to another account has a different
 * `lastAccount` and is correctly excluded.
 */
export function selectAffectedOwners(
  entries: readonly OwnerRouteSnapshot[],
  accountId: string,
  nowMs: number,
  recencyMs: number = AFFECTED_OWNER_RECENCY_MS,
): string[] {
  if (!accountId) return [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.ownerId) continue;
    if (e.lastAccount !== accountId) continue;
    if (nowMs - e.lastAt > recencyMs) continue;
    seen.add(e.ownerId);
  }
  return [...seen].sort();
}

/**
 * The at-risk suffix appended to the org-disable escalation body + fleet
 * broadcast, so a leader/human sees exactly WHICH sessions to check instead of a
 * bare "account removed" notice. Empty string when no owner is at risk (so the
 * alert is unchanged in the common case), keeping the enrichment purely additive.
 */
export function formatAtRiskAlertSuffix(affectedOwners: readonly string[]): string {
  const atRisk = affectedOwners.filter((o) => Boolean(o));
  if (atRisk.length === 0) return '';
  return (
    ` ⚠ Live sessions that were routing through this account when it was disabled may now be ORPHANED — ` +
    `their next inference turn fails, so they cannot self-drain: ${atRisk.join(', ')}. ` +
    `A fleet leader should check + reclaim their in-flight claims (release a cold session's claim with a reason).`
  );
}
