/**
 * Unowned-critical escalation (WI-5213, owner-prompted 2026-07-17): "our system
 * should have a better way to handle this, to prevent this kind of thing from
 * happening in the first place." — EI-13306 (claim-spec NULL-poisoning) was
 * filed severity:critical and left UNASSIGNED for 8h, during which the same
 * defect nearly re-starved the same fleet a second time. The filer was also
 * the victim. Filing is not fixing: severity existed but drove no escalation.
 *
 * This is the standing sweep. Pure detection (`unownedAgedCriticals`) + the
 * same claim-spec predicate the scheduler uses (`matchesWorkItemClaimSpec`,
 * reused verbatim, not reimplemented) to answer "which FLEET would be bitten
 * by this" — the leader most likely to hit it is the leader whose fleet pulls
 * through that subsystem. `readUnownedCriticalsForFleet` is the thin IO shell
 * `fleet:leader-brief` calls each monitor tick, so an orphaned critical
 * surfaces on the leader's brief WITHOUT anyone asking (the acceptance bar).
 *
 * No new scheduler, no new store: `listWorkItems` (the existing cross-family
 * read) + `getClaimSpec`/`fleetSpecBeeKey` (the existing fleet-spec resolver)
 * + `matchesWorkItemClaimSpec` (the existing claim-spec predicate) are the
 * whole substrate.
 */
import { listWorkItems, type WorkItem } from '../../work-items';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import { getClaimSpec, fleetSpecBeeKey } from '../../scheduler/claim-spec-store';

/** Default staleness bar (hours) before an unowned critical escalates. Config,
 *  not hardcoded — callers (the leader-brief tool) may override it. */
export const DEFAULT_UNOWNED_CRITICAL_AGE_HOURS = 4;

export interface UnownedCriticalCandidate {
  id: string;
  kind: string;
  title: string;
  harness: string | null;
  /** Hours since the item was filed, rounded to 1 decimal. */
  ageHours: number;
  createdAt: string;
}

/**
 * Pure: severity='critical' AND state='open' (the issue-family's single
 * unresolved state — feature-family items don't carry `severity` at all, so
 * this is inherently issue-family: bug/change/task, matching EI-13306's own
 * kind) AND assignee IS NULL AND age >= ageHours. Unparseable createdAt is
 * dropped (never escalate on a timestamp we can't trust).
 */
export function unownedAgedCriticals(
  items: readonly WorkItem[],
  opts: { ageHours?: number; nowMs?: number } = {},
): UnownedCriticalCandidate[] {
  const ageHours = opts.ageHours ?? DEFAULT_UNOWNED_CRITICAL_AGE_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const out: UnownedCriticalCandidate[] = [];
  for (const item of items) {
    if (item.severity !== 'critical') continue;
    if (item.assignee != null) continue;
    if (item.state !== 'open') continue;
    const createdMs = Date.parse(item.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const hours = (nowMs - createdMs) / 3_600_000;
    if (hours < ageHours) continue;
    out.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      harness: item.harness,
      ageHours: Math.round(hours * 10) / 10,
      createdAt: item.createdAt,
    });
  }
  return out;
}

/**
 * Pure (WI-5213's routing rule): the subset of already-unowned-aged criticals
 * a given FLEET's claim spec would ADMIT — reuses `matchesWorkItemClaimSpec`
 * (the SAME predicate scheduler:get_next evaluates), so "would this fleet
 * pull it" here and at claim time can never drift apart.
 */
export function unownedCriticalsMatchingFleetSpec(
  items: readonly WorkItem[],
  spec: Parameters<typeof matchesWorkItemClaimSpec>[1],
  opts: { ageHours?: number; nowMs?: number } = {},
): UnownedCriticalCandidate[] {
  const admitted = items.filter((item) => matchesWorkItemClaimSpec(item, spec));
  return unownedAgedCriticals(admitted, opts);
}

/**
 * IO: read the workspace's open+critical+unassigned issue-family backlog and
 * narrow it to what `fleet`'s claim spec would admit — the one-call shell
 * `fleet:leader-brief` uses. Fails soft to `[]` on any read error (this must
 * never break the health brief it decorates); callers that need to
 * distinguish "none found" from "read failed" should call the two pure
 * halves directly instead.
 */
export async function readUnownedCriticalsForFleet(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string;
  ageHours?: number;
}): Promise<UnownedCriticalCandidate[]> {
  try {
    const [items, spec] = await Promise.all([
      listWorkItems({ harness: args.harness, state: 'open', limit: 200 }),
      getClaimSpec({ cupId: fleetSpecBeeKey(args.fleet), workspaceId: args.workspaceId }),
    ]);
    return unownedCriticalsMatchingFleetSpec(items, spec, { ageHours: args.ageHours });
  } catch {
    return [];
  }
}
