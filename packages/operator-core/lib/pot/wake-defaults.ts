/**
 * wake-defaults.ts — the Mug's DEFAULT event-wake subscriptions
 * (start-hive-wake-orchestration-2026-06-09 P-002 / D-001).
 *
 * The event-wake substrate (./wake) is policy-free: it projects whatever
 * subscriptions are declared. THIS is the declared default policy — the three
 * demand producers (start-pot P-001 added their `emits:`/result gates):
 *
 *   - `plans:start`        — a plan actually transitioned to started
 *   - `work_items:create`  — new demand entered a queue
 *   - `coord:escalate`     — an escalation was raised
 *
 * Armed at pot:create (REPLACE — nothing to preserve) and re-affirmed on
 * pot:start (ENSURE — union; the Mug's own runtime tuning via
 * pot:declare-wake is hers to keep, per D-001's "re-tunable at runtime").
 * Start-minimal per OQ-5: exactly these three; the Mug adds more herself.
 */
import {
  readPotWakeState,
  setPotEventSubscriptions,
  type PotEventSubscription,
} from './wake';

/**
 * Map a blueprint's declared `wake.subscriptions` ({ on, note }) into runtime
 * PotEventSubscriptions (pot-blueprint-generalization P-013). Returns `undefined`
 * when the blueprint declares none, so the caller falls back to the built-in
 * `defaultPotEventSubscriptions()` — a pot that declares no `wake` (today's coding
 * pot AND generic-pot) is therefore byte-identical to before. A future pot can
 * declare its own demand wakes in its blueprint instead of the universal three.
 * (The blueprint schema's subscription is coarser than the built-in — no `when`
 * filter — so a declared sub wakes on every emit of `on`; the built-ins keep their
 * result-gates.)
 */
export function blueprintWakeSubscriptions(
  wake: { subscriptions?: Array<{ on: string; note?: string }> } | undefined,
): PotEventSubscription[] | undefined {
  const subs = wake?.subscriptions ?? [];
  if (subs.length === 0) return undefined;
  return subs.map((s) => ({ on: s.on, ...(s.note ? { note: s.note } : {}) }));
}

/** The three default demand subscriptions (fresh array each call — callers may mutate). */
export function defaultPotEventSubscriptions(): PotEventSubscription[] {
  return [
    {
      on: 'plans:start',
      // Only a REAL op_status flip (not the idempotent re-start) is demand.
      when: { 'result.data.transitioned': true },
      note: 'default demand wake: a plan was started (start-pot-wake P-002)',
    },
    {
      on: 'work_items:create',
      // Only UNPLACED demand needs the Mug. Gate on a successful create whose item
      // is UNASSIGNED — a pre-placed / self-assigned create (work_items:create {assign_to};
      // e.g. a warm /loop self-assigning its own work each wake) is already owned, so it
      // must NOT wake her every cycle (EI-1850). `exists:false` is the engine's not-null
      // operator → `$eq null`, matching assignee null/unset = unassigned. The handler still
      // reports in-band failures as { ok:false } inside a successful tool result, so the ok
      // gate stays (onlyOnSuccess alone is not enough).
      when: {
        'result.data.ok': true,
        'result.data.workItem.assignee': { exists: false },
      },
      note: 'default demand wake: an UNPLACED (unassigned) work item was created (start-pot-wake P-002; a pre-assigned create skips — EI-1850)',
    },
    {
      on: 'coord:escalate',
      when: { 'result.data.ok': true },
      note: 'default demand wake: an escalation was raised (start-pot-wake P-002)',
    },
  ];
}

const onKeys = (on: string | string[]): string[] => (Array.isArray(on) ? on : [on]);

/**
 * Arm the default subscriptions for a workspace.
 *
 * - `'replace'` — the set becomes exactly the defaults (pot:create: the state
 *   is empty; nothing to preserve).
 * - `'ensure'` — union: every existing subscription is kept verbatim (the
 *   Mug's declared policy), and only defaults whose trigger tool is not
 *   already covered are added. pot:start uses this so Pause→Start never
 *   clobbers her tuning. Always re-persists + re-projects the live rules, so
 *   Start also repairs a registry that lost its in-memory rules.
 */
export async function armDefaultPotWakeSubscriptions(
  workspaceId: string,
  opts: { mode: 'replace' | 'ensure'; subscriptions?: PotEventSubscription[] },
): Promise<{ rules: number; added: number }> {
  // P-013: the blueprint's declared wake.subscriptions WIN over the built-in
  // universal three; a pot that declares none (the coding pot + generic-pot
  // today) falls back to the defaults, so behavior is unchanged.
  const defaults =
    opts.subscriptions && opts.subscriptions.length > 0
      ? opts.subscriptions
      : defaultPotEventSubscriptions();
  if (opts.mode === 'replace') {
    const rules = await setPotEventSubscriptions(workspaceId, defaults);
    return { rules, added: defaults.length };
  }
  const current = (await readPotWakeState(workspaceId)).subscriptions;
  const covered = new Set(current.flatMap((s) => onKeys(s.on)));
  const missing = defaults.filter((d) => onKeys(d.on).some((k) => !covered.has(k)));
  const rules = await setPotEventSubscriptions(workspaceId, [...current, ...missing]);
  return { rules, added: missing.length };
}
