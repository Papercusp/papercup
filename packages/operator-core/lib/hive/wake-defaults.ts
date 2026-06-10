/**
 * wake-defaults.ts — the Queen's DEFAULT event-wake subscriptions
 * (start-hive-wake-orchestration-2026-06-09 P-002 / D-001).
 *
 * The event-wake substrate (./wake) is policy-free: it projects whatever
 * subscriptions are declared. THIS is the declared default policy — the three
 * demand producers (start-hive P-001 added their `emits:`/result gates):
 *
 *   - `plans:start`        — a plan actually transitioned to started
 *   - `work_items:create`  — new demand entered a queue
 *   - `coord:escalate`     — an escalation was raised
 *
 * Armed at hive:create (REPLACE — nothing to preserve) and re-affirmed on
 * hive:start (ENSURE — union; the Queen's own runtime tuning via
 * hive:declare-wake is hers to keep, per D-001's "re-tunable at runtime").
 * Start-minimal per OQ-5: exactly these three; the Queen adds more herself.
 */
import {
  readHiveWakeState,
  setHiveEventSubscriptions,
  type HiveEventSubscription,
} from './wake';

/** The three default demand subscriptions (fresh array each call — callers may mutate). */
export function defaultHiveEventSubscriptions(): HiveEventSubscription[] {
  return [
    {
      on: 'plans:start',
      // Only a REAL op_status flip (not the idempotent re-start) is demand.
      when: { 'result.data.transitioned': true },
      note: 'default demand wake: a plan was started (start-hive-wake P-002)',
    },
    {
      on: 'work_items:create',
      // The handler reports failures as { ok:false } inside a successful tool
      // result, so onlyOnSuccess alone is not enough.
      when: { 'result.data.ok': true },
      note: 'default demand wake: a work item was created (start-hive-wake P-002)',
    },
    {
      on: 'coord:escalate',
      when: { 'result.data.ok': true },
      note: 'default demand wake: an escalation was raised (start-hive-wake P-002)',
    },
  ];
}

const onKeys = (on: string | string[]): string[] => (Array.isArray(on) ? on : [on]);

/**
 * Arm the default subscriptions for a workspace.
 *
 * - `'replace'` — the set becomes exactly the defaults (hive:create: the state
 *   is empty; nothing to preserve).
 * - `'ensure'` — union: every existing subscription is kept verbatim (the
 *   Queen's declared policy), and only defaults whose trigger tool is not
 *   already covered are added. hive:start uses this so Pause→Start never
 *   clobbers her tuning. Always re-persists + re-projects the live rules, so
 *   Start also repairs a registry that lost its in-memory rules.
 */
export async function armDefaultHiveWakeSubscriptions(
  workspaceId: string,
  opts: { mode: 'replace' | 'ensure' },
): Promise<{ rules: number; added: number }> {
  const defaults = defaultHiveEventSubscriptions();
  if (opts.mode === 'replace') {
    const rules = await setHiveEventSubscriptions(workspaceId, defaults);
    return { rules, added: defaults.length };
  }
  const current = (await readHiveWakeState(workspaceId)).subscriptions;
  const covered = new Set(current.flatMap((s) => onKeys(s.on)));
  const missing = defaults.filter((d) => onKeys(d.on).some((k) => !covered.has(k)));
  const rules = await setHiveEventSubscriptions(workspaceId, [...current, ...missing]);
  return { rules, added: missing.length };
}
