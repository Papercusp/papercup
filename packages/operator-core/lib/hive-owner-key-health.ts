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

const defaultDeps: OwnerKeyHealthDeps = {
  // eslint-disable-next-line no-console
  warn: (msg: string) => console.warn(msg),
  escalate: defaultEscalate,
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
  if (signaled.has(k)) return false; // already escalated; suppress until recovery
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
