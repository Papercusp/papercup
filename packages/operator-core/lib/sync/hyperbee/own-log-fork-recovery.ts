/**
 * own-log-fork-recovery — SKETCHED, flag-gated, default-OFF auto-recovery
 * for an own-log fork (own-log-fork-guard.ts).
 *
 * Plan: p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535). The plan
 * explicitly allows sketching auto-recovery but requires it flag-gated
 * default-OFF because it's DESTRUCTIVE: the only supported recovery for a
 * forked own-log is a per-harness STORE RESET (delete the harness's
 * Corestore directory so Corestore lazily mints a fresh keypair on next
 * open) — this throws away any local hypercore-only history that hasn't
 * already merged into PG. `rekeyHarness` (boot-all.ts) does NOT do this; it
 * only re-binds the swarm topic.
 *
 * Gated on `FLAGS.OWN_LOG_FORK_AUTO_RECOVERY` — an owner-authority DARK flag
 * (libs/flags/src/types.ts). This module is NEVER wired into any automatic
 * pass (own-log-fork-guard.ts's detector only reports + files an EI); it is
 * meant to be invoked deliberately — a runbook step, an admin action, or an
 * agent that has already read the filed EI and decided recovery is
 * warranted for THIS specific harness — with the flag gate as the owner's
 * kill-switch on unattended destructive action, and `confirm: true` as a
 * second, in-code guard against an accidental call.
 */

import { closeHarnessStore, harnessStorePath } from './corestore';
import { clearOwnLogForkState } from './own-log-fork-guard';
import { resolveOwnLogForkEi } from './own-log-fork-ei';

export interface OwnLogForkRecoveryOpts {
  workspaceRoot: string;
  workspaceId: string;
  harnessSlug: string;
  /** The forked own-log key being retired — threaded into the EI-resolve
   *  dedup title and the recovery detail note. */
  keyHex: string;
  /**
   * Explicit double-confirmation, mirroring the confirm-gated destructive
   * actions elsewhere in this repo (locks:dev:restart / db:migrate). Must be
   * `true` or this returns `{ ok: false, reason: 'not_confirmed' }` without
   * touching disk — a caller that didn't mean to run this must never get a
   * false sense that it ran.
   */
  confirm: true;
  /** DI seam for the destructive removal step — default `fs/promises.rm`.
   *  Tests MUST pass this (never exercise the real filesystem). */
  rm?: (path: string) => Promise<void>;
  /** DI seam for the flag check — default `@papercusp/flags` `getFlag`.
   *  Tests pass this to avoid a real flag-store round-trip. */
  isEnabled?: () => Promise<boolean>;
}

export type OwnLogForkRecoveryReason = 'flag_off' | 'not_confirmed';

export interface OwnLogForkRecoveryResult {
  ok: boolean;
  reason?: OwnLogForkRecoveryReason;
  resetPath?: string;
}

async function defaultIsEnabled(): Promise<boolean> {
  const [{ FLAGS }, { getFlag }] = await Promise.all([
    import('@papercusp/flags'),
    import('@papercusp/flags/server'),
  ]);
  return getFlag(FLAGS.OWN_LOG_FORK_AUTO_RECOVERY, 'system').catch(() => false);
}

async function defaultRm(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { recursive: true, force: true });
}

/**
 * Perform the supported recovery: close the harness's cached Corestore
 * handle, then DELETE its on-disk directory so the next `getHarnessStore` /
 * `openOwnLog` lazily creates a brand-new keypair, clear the in-process fork
 * latch, and auto-resolve the durable EI the fork filed. The caller is
 * responsible for re-booting the harness afterward — composing that belongs
 * to whatever orchestrates harness lifecycle (e.g. boot-all.ts), not this
 * narrowly-scoped recovery step.
 *
 * No-ops (never touches disk) when `confirm` isn't `true` or the flag reads
 * off — both are reported via `reason`, never a silent success.
 */
export async function recoverForkedOwnLog(
  opts: OwnLogForkRecoveryOpts,
): Promise<OwnLogForkRecoveryResult> {
  if (opts.confirm !== true) return { ok: false, reason: 'not_confirmed' };
  const isEnabled = opts.isEnabled ?? defaultIsEnabled;
  if (!(await isEnabled())) return { ok: false, reason: 'flag_off' };

  const path = harnessStorePath({
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  });
  // Best-effort close — an already-closed / never-opened store must not block
  // the reset (the whole point is recovering from a wedged/crash-looping boot).
  await closeHarnessStore({
    workspaceRoot: opts.workspaceRoot,
    harnessSlug: opts.harnessSlug,
  }).catch(() => {});

  const rm = opts.rm ?? defaultRm;
  await rm(path);

  clearOwnLogForkState(opts.workspaceId, opts.harnessSlug);
  await resolveOwnLogForkEi({
    harnessSlug: opts.harnessSlug,
    keyHex: opts.keyHex,
    detail: `store reset at ${path}`,
  }).catch(() => {
    /* best-effort: the reset itself already succeeded */
  });

  return { ok: true, resetPath: path };
}
