/**
 * hive-owner-key-health — LOUD, deduped "owner can't sign/serve its hive" signal.
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 — D-024 (split-brain) +
 * D-023 BUG A (orphaned owner keys).
 *
 * When THIS box is the OWNER of a hive (the hive is in its own
 * `listOwnedHiveMeta` directory) but `loadHivePubkey` returns null, the owner can
 * neither stand up the cross-Hive transport nor sign/serve epoch keys — the hive
 * "stays dark" and its members silently never receive content. That detection was
 * previously a single `console.warn` that scrolled away in the boot log, so an
 * orphaned/missing owner key was effectively invisible.
 *
 * This turns it into a deduped owner-facing ESCALATION (a coord broadcast + a
 * toast row, the same rail `notifications:recent` reads), mirroring
 * learning-infra-health's "infra escalates, it doesn't queue" posture: the
 * improvement queue can't fix a missing on-box key, so it pings the owner.
 *
 * Deduped per (workspace, hive): the cross-hive reconcile / outbox-drain re-runs
 * every tick and re-detects the SAME dark hive, so a raw emit would spam. The
 * first detection alerts; subsequent ones are suppressed until
 * `clearOwnedHiveKeyHealth` marks the hive recovered (the key loaded on a later
 * tick) — so a key that disappears AGAIN re-alerts. Cross-tick state is a module
 * singleton (resets on operator restart), deliberately matching
 * learning-infra-health's transition singleton.
 *
 * Every emission is best-effort: a logger or notify failure must NEVER throw into
 * the boot / reconcile path that called it.
 */

import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The system identity the owner-key-missing escalation is attributed to. */
const OWNER_KEY_HEALTH_IDENTITY: AgentIdentity = {
  ownerId: 'hive-owner-key-health',
  ownerLabel: 'hive-owner-key-health',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface OwnedHiveKeyMissingRef {
  workspaceId: string;
  hiveSlug: string;
  /** Where the null key was detected ("cross-hive-boot", "epoch-key-reconcile"). */
  context: string;
}

export interface OwnerKeyHealthDeps {
  /** WARN-level log line. Default: console.warn. */
  warn: (msg: string) => void;
  /** Owner-facing escalation (coord broadcast + toast). Best-effort. */
  escalate: (ref: OwnedHiveKeyMissingRef, summary: string) => Promise<void>;
  /**
   * Cross-restart dedup floor: was this hive already alerted within the cooldown
   * window, in THIS or a PRIOR operator process? Default: a persistent toast_log
   * read. The in-memory `signaled` set below dedups within one process, but it
   * RESETS on every operator restart — so on a box that restarts often a
   * persistently-dark hive would re-alert on every boot. This persistent check
   * makes the alert fire once per window, not once per restart. Best-effort +
   * fail-open (see defaultRecentlyAlerted).
   */
  recentlyAlerted?: (ref: OwnedHiveKeyMissingRef) => Promise<boolean>;
}

function dedupKey(workspaceId: string, hiveSlug: string): string {
  return `${workspaceId}::${hiveSlug}`;
}

/** Hives we've already escalated; cleared by clearOwnedHiveKeyHealth on recovery. */
const signaled = new Set<string>();

/** The default escalation: coord broadcast (the floor) + a toast row (best-effort). */
async function defaultEscalate(ref: OwnedHiveKeyMissingRef, summary: string): Promise<void> {
  await sendMessage(OWNER_KEY_HEALTH_IDENTITY, {
    to: ['*'],
    summary,
    category: 'hive-owner-health',
  }).catch(() => {});
  // Toast row — the notification panel / notifications:recent rail. PG may not be
  // ready this early in boot, so the whole write is best-effort; the coord
  // broadcast above is the floor.
  try {
    const { getOrgPg, generated } = await import('@papercusp/db-org');
    const { db } = getOrgPg();
    await db.insert(generated.toastLogInHarnessShared).values({
      level: 'error',
      message: 'Hive owner key missing',
      description: `${summary} Restore this box's hive identity key (or re-own the hive) — until then the hive stays dark for its members.`,
      harnessSlug: ref.hiveSlug,
      createdAt: Date.now(),
      actionLabel: 'Open Insights',
      actionHref: '/adv?tab=insights',
    });
  } catch {
    /* PG not ready / write failed — the coord broadcast is the floor */
  }
}

/**
 * How long a prior owner-key-missing toast suppresses a re-alert for the SAME
 * hive. Bridges operator-restart churn: the in-memory `signaled` set resets on
 * every restart, so without this a persistently-dark hive re-alerts on every
 * boot (the noise this module was created to prevent, defeated by frequent
 * dev-box restarts). A still-dark hive re-surfaces once per window.
 */
const RE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The default cross-restart dedup floor: has an owner-key-missing toast for this
 * hive been written within RE_ALERT_COOLDOWN_MS, in THIS or a PRIOR process?
 * Reads the persistent `toast_log` — the SAME rail defaultEscalate writes — so
 * the suppression survives the in-memory singleton's restart reset.
 *
 * Fail-OPEN: any error (PG not ready this early in boot, query failure) returns
 * false → the alert proceeds. A missed suppression costs one extra toast; the
 * in-memory dedup still guards within a process. We never fail CLOSED (that
 * would risk silently swallowing a real owner-key-missing alert).
 */
async function defaultRecentlyAlerted(ref: OwnedHiveKeyMissingRef): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const cutoff = Date.now() - RE_ALERT_COOLDOWN_MS;
    const rows = await sql/* sql */ `
      select 1
        from harness_shared.toast_log
       where message = 'Hive owner key missing'
         and harness_slug = ${ref.hiveSlug}
         and created_at > ${cutoff}
       limit 1`;
    return rows.length > 0;
  } catch {
    return false; // fail-open — never swallow a real alert on a transient read error
  }
}

const defaultDeps: OwnerKeyHealthDeps = {
  // eslint-disable-next-line no-console
  warn: (msg: string) => console.warn(msg),
  escalate: defaultEscalate,
  recentlyAlerted: defaultRecentlyAlerted,
};

/**
 * Emit a LOUD, deduped owner-key-missing health signal for a hive THIS box owns
 * but cannot load the identity key for. Returns true when a NEW signal fired,
 * false when it was suppressed (already escalated for this hive — call
 * clearOwnedHiveKeyHealth first if the key recovered). Best-effort + never
 * throws; safe to `void` from a boot/reconcile path.
 */
export async function signalOwnedHiveKeyMissing(
  ref: OwnedHiveKeyMissingRef,
  deps: Partial<OwnerKeyHealthDeps> = {},
): Promise<boolean> {
  const d = { ...defaultDeps, ...deps };
  const k = dedupKey(ref.workspaceId, ref.hiveSlug);
  if (signaled.has(k)) return false; // already escalated THIS process; suppress until recovery

  // Cross-restart dedup: the in-memory `signaled` set above resets on every
  // operator restart, so a persistently-dark hive would re-alert on each boot.
  // Gate on a PERSISTENT check (the toast_log) so the owner is alerted once per
  // cooldown window, not once per restart. Recovery still re-arms the in-process
  // set immediately (clearOwnedHiveKeyHealth) — this floor only rate-limits how
  // often a still-dark hive re-surfaces. Fail-open, so it never swallows a real
  // alert. Cache the outcome in-process so we don't re-query on every reconcile.
  const recentlyAlerted = d.recentlyAlerted ?? defaultRecentlyAlerted;
  if (await recentlyAlerted(ref).catch(() => false)) {
    signaled.add(k);
    return false;
  }
  signaled.add(k);

  const summary =
    `🔴 owner key MISSING for owned hive ${ref.workspaceId}/${ref.hiveSlug} (${ref.context}) — ` +
    `this box owns the hive but loadHivePubkey returned null, so it cannot sign or serve it.`;
  try {
    d.warn(`[hive-owner-key-health] ${summary}`);
  } catch {
    /* a logger that throws must not break the caller */
  }
  try {
    await d.escalate(ref, summary);
  } catch {
    /* best-effort: an escalation failure never throws into boot */
  }
  return true;
}

/**
 * Recovery edge: the owner key loaded for this hive again. Clears the dedup entry
 * so a FUTURE loss re-alerts. Call on the success path (a non-null pubkey).
 */
export function clearOwnedHiveKeyHealth(ref: { workspaceId: string; hiveSlug: string }): void {
  signaled.delete(dedupKey(ref.workspaceId, ref.hiveSlug));
}

/** Whether this hive currently has an outstanding (un-recovered) owner-key alert. */
export function isOwnedHiveKeyMissingSignaled(ref: { workspaceId: string; hiveSlug: string }): boolean {
  return signaled.has(dedupKey(ref.workspaceId, ref.hiveSlug));
}

/** Test-only — reset the cross-tick dedup singleton. */
export function _resetOwnerKeyHealthForTests(): void {
  signaled.clear();
}
