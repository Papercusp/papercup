/**
 * WI-562584 — fail-CLOSED cross-domain conflict guard for named-resource acquires.
 *
 * The defect this closes: `resourceLockDomain()` INFERS one coordination domain
 * from the resource NAME (host-global set / `git-sync:` prefix / else the
 * caller-tree). git-sync, by contrast, acquires EVERY member of its lock set —
 * the restart barrier, `git-sync:<slug>`, AND each
 * `trigger_config.extra_lock_resources` name — under one `cd = workspaceId ||
 * '*'` (`git-sync-action.ts`'s `handleGitSync`). An extra name such as
 * `libs-papercusp-submodule` advertises neither family, so an agent's acquire
 * lands in the caller-tree domain while git-sync holds it in the workspace
 * domain. Two disjoint namespaces: the acquire is GRANTED, `ok:true` is
 * returned, and mutual exclusion silently does not hold.
 *
 * The harm is not that the inference is wrong — it is that a wrong inference
 * fails OPEN. This module closes that independently of fixing the inference:
 * before granting, look for a live conflicting holder in the OTHER candidate
 * domains and refuse instead, naming the holder AND the domain it holds in.
 *
 * Two properties make this safe rather than a source of false conflicts:
 *
 *  - **It cannot see another checkout's locks.** `candidateResourceLockDomains()`
 *    returns exactly three values computed for THIS process —
 *    `lockCoordinationDomain()`, `hostGlobalLockDomain()`,
 *    `workspaceScopedLockDomain()`. A different tree's caller-tree domain is not
 *    among them, so an unrelated same-named lock elsewhere stays invisible,
 *    exactly as today.
 *
 *  - **It is symmetric with the already-landed read-side fix.** `locks:list`
 *    (EI-21733256625452096) stopped inferring one domain and now queries all
 *    candidates and merges, stamping `coordination_domain` per holder
 *    (`list.ts`). The acquire path is the same shape; this is that shape applied
 *    to the write side.
 *
 * NOT the root fix. The root fix is to make the domain KNOWN rather than merely
 * SAFE — a `coordination_domain_kind` column on `agent_resource_registry`,
 * written by git-sync's own auto-register INSERT so the value is DERIVED from
 * the acquirer. This guard is the invariant that should hold permanently
 * regardless of how the domain is resolved.
 */

import { candidateResourceLockDomains } from './coordination-domain';
import { getTxPool, readResourceQueue, type ResourceHolder } from './su-lock-store';

export type ResourceAcquireMode = 'shared' | 'exclusive';

/** A live holder found in a domain OTHER than the one the acquire targets. */
export interface CrossDomainHolder {
  /** The domain the holder actually holds it in — the field a reader needs to act. */
  coordination_domain: string;
  resource: string;
  owner: string;
  owner_label: string | null;
  mode: ResourceAcquireMode;
  status: string;
  reason: string;
  acquired_ts: string;
  expires_ts: string;
}

/** Live holders read from one non-target domain. */
export interface DomainHolders {
  coordinationDomain: string;
  holders: ResourceHolder[];
}

/**
 * The conflict predicate, as a PURE function of what was read — kept separate
 * from the read so it can be exercised without a database and so a deliberately
 * wrong implementation can be held beside it as a falsifiability control.
 *
 * The rule mirrors the in-domain semantics of `tryAcquireResource` as closely as
 * a foreign domain allows:
 *
 *  - a holder owned by the CALLER never conflicts (re-acquire / refresh);
 *  - a `shared` request conflicts only with a foreign EXCLUSIVE (writer
 *    priority — `held` and `draining` alike, matching the in-domain check);
 *  - an `exclusive` request conflicts with ANY foreign holder. In-domain, live
 *    shared holders put the exclusive into `draining` and the drain protocol
 *    retires them; across domains there is no drain to run and no way to wait
 *    for one, so the honest answer is a refusal rather than a grant that claims
 *    an exclusivity the caller does not have.
 *
 * Rows are filtered by `resource` here as well as in the query, so handing this
 * an unfiltered queue can never manufacture a conflict from an unrelated name.
 */
export function selectCrossDomainConflicts(params: {
  resource: string;
  requestedMode: ResourceAcquireMode;
  owner: string;
  foreign: DomainHolders[];
}): CrossDomainHolder[] {
  const { resource, requestedMode, owner, foreign } = params;
  const conflicts: CrossDomainHolder[] = [];
  for (const { coordinationDomain, holders } of foreign) {
    for (const h of holders) {
      if (h.resource !== resource) continue;
      if (h.owner === owner) continue;
      const blocks = requestedMode === 'exclusive' || h.mode === 'exclusive';
      if (!blocks) continue;
      conflicts.push({
        coordination_domain: coordinationDomain,
        resource: h.resource,
        owner: h.owner,
        owner_label: h.owner_label,
        mode: h.mode,
        status: h.status,
        reason: h.reason,
        acquired_ts: h.acquired_ts.toISOString(),
        expires_ts: h.expires_ts.toISOString(),
      });
    }
  }
  return conflicts;
}

/**
 * Read every candidate domain OTHER than the one this acquire targets and
 * return the conflicting holders. Empty when the acquire is safe.
 *
 * Costs nothing on a single-domain host: when the candidate set collapses to
 * the target domain (`PAPERCUSP_LOCK_DOMAIN` set, or a workspace whose id
 * equals the repo root) no query is issued at all and the acquire path is
 * byte-identical to before this guard.
 *
 * Expired rows are excluded by `readResourceQueue`'s own
 * `expires_ts > clock_timestamp()` predicate, so a lapsed hold never blocks.
 *
 * Errors are NOT swallowed: a failed read means the caller does not know
 * whether mutual exclusion holds, and the call site must refuse rather than
 * grant on an unanswered question.
 */
export async function findCrossDomainResourceConflicts(params: {
  resource: string;
  targetDomain: string;
  requestedMode: ResourceAcquireMode;
  owner: string;
}): Promise<CrossDomainHolder[]> {
  const { resource, targetDomain, requestedMode, owner } = params;
  const foreignDomains = candidateResourceLockDomains().filter((d) => d !== targetDomain);
  if (foreignDomains.length === 0) return [];

  const pool = getTxPool();
  const foreign = await Promise.all(
    foreignDomains.map(async (coordinationDomain) => ({
      coordinationDomain,
      holders: (await readResourceQueue(pool, { coordinationDomain, resource })).holders,
    })),
  );
  return selectCrossDomainConflicts({ resource, requestedMode, owner, foreign });
}

/** The advice a refused caller needs, kept next to the rule that produces it. */
export const CROSS_DOMAIN_CONFLICT_HINT =
  'This resource is already held in a DIFFERENT lock coordination domain (see holders[].coordination_domain). ' +
  'Acquiring it here would grant a lock that the existing holder cannot see, so mutual exclusion would not hold. ' +
  'Wait for the listed holder to release (locks:list shows every domain), or coordinate with its owner.';
