/**
 * addHarnessToHive — make a harness a MEMBER of a Hive
 * (shared-hive-federation-2026-06-08 P-004 follow-up / D-010 gap-closer).
 *
 * Sets `ProjectEntry.hive_slug` on a member harness so its substrate federates
 * over the HIVE topic (resolveHiveSwarmBinding), with `harness_slug` staying the
 * within-Hive component scope (D-003). This is the missing PRODUCER for hive_slug
 * the P-004 work flagged: until something sets it, a Hive has only its home and no
 * members. Membership is the registry edit ONLY — it never moves the harness folder
 * or its run data (cf. harness:membership).
 *
 * Contributor/device admission to the Hive (hive_members, P-006) is a SEPARATE
 * concern — a person joins via the Hive swarm + admission gate; this adds a member
 * HARNESS whose work federates within the Hive.
 *
 * Idempotent (re-adding to the same Hive is a no-op success). Pure over injectable
 * registry seams so it unit-tests without PG.
 */
import {
  loadHarnessRegistry as realLoad,
  saveHarnessRegistry as realSave,
  type HarnessRegistry,
} from '../../harness-registry';
import { HIVE_KIND } from './_resolve';

export interface AddHiveMemberOpts {
  workspaceId: string;
  /** The Hive's home_slug — a `kind:'hive'` harness that owns the Hive identity. */
  hiveHomeSlug: string;
  /** The member harness slug to add to the Hive. */
  memberHarnessSlug: string;
}

export interface AddHiveMemberResult {
  ok: boolean;
  error?:
    | 'hive_not_found'
    | 'harness_not_found'
    | 'is_hive_home'
    | 'self'
    | 'already_member_elsewhere';
  message?: string;
  hiveHomeSlug?: string;
  memberHarnessSlug?: string;
  /** True when the membership was newly set; false when it already held (idempotent). */
  changed?: boolean;
}

export interface AddHiveMemberSeams {
  loadRegistry?: (workspaceId: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId: string) => Promise<void>;
}

export async function addHarnessToHive(
  opts: AddHiveMemberOpts,
  seams: AddHiveMemberSeams = {},
): Promise<AddHiveMemberResult> {
  const loadRegistry = seams.loadRegistry ?? realLoad;
  const saveRegistry = seams.saveRegistry ?? realSave;
  const ws = opts.workspaceId;

  if (opts.memberHarnessSlug === opts.hiveHomeSlug) {
    return { ok: false, error: 'self', message: 'a Hive home cannot be a member of itself' };
  }

  const reg = await loadRegistry(ws);

  const hive = reg.projects.find((p) => p.slug === opts.hiveHomeSlug && p.harness_kind === HIVE_KIND);
  if (!hive) {
    return { ok: false, error: 'hive_not_found', message: `no hive '${opts.hiveHomeSlug}' in this workspace` };
  }

  const member = reg.projects.find((p) => p.slug === opts.memberHarnessSlug);
  if (!member) {
    return { ok: false, error: 'harness_not_found', message: `no harness '${opts.memberHarnessSlug}' in this workspace` };
  }
  if (member.harness_kind === HIVE_KIND) {
    return {
      ok: false,
      error: 'is_hive_home',
      message: `'${opts.memberHarnessSlug}' is itself a Hive home — a Hive cannot be nested as another Hive's member`,
    };
  }
  if (member.hive_slug && member.hive_slug !== opts.hiveHomeSlug) {
    return {
      ok: false,
      error: 'already_member_elsewhere',
      message: `'${opts.memberHarnessSlug}' is already a member of hive '${member.hive_slug}' — remove it first`,
    };
  }
  if (member.hive_slug === opts.hiveHomeSlug) {
    // Already a member — idempotent success.
    return { ok: true, hiveHomeSlug: opts.hiveHomeSlug, memberHarnessSlug: opts.memberHarnessSlug, changed: false };
  }

  member.hive_slug = opts.hiveHomeSlug;
  await saveRegistry(reg, ws);
  return { ok: true, hiveHomeSlug: opts.hiveHomeSlug, memberHarnessSlug: opts.memberHarnessSlug, changed: true };
}

/**
 * Remove a harness from its Hive (clear `hive_slug`) — the inverse, so membership
 * is editable (and a harness can be re-pointed). Idempotent.
 */
export async function removeHarnessFromHive(
  opts: { workspaceId: string; memberHarnessSlug: string },
  seams: AddHiveMemberSeams = {},
): Promise<{ ok: boolean; error?: 'harness_not_found'; changed?: boolean }> {
  const loadRegistry = seams.loadRegistry ?? realLoad;
  const saveRegistry = seams.saveRegistry ?? realSave;
  const reg = await loadRegistry(opts.workspaceId);
  const member = reg.projects.find((p) => p.slug === opts.memberHarnessSlug);
  if (!member) return { ok: false, error: 'harness_not_found' };
  if (!member.hive_slug) return { ok: true, changed: false };
  delete member.hive_slug;
  await saveRegistry(reg, opts.workspaceId);
  return { ok: true, changed: true };
}
