/**
 * hive-git/bootstrap.ts — cold-clone bootstrap for a new joiner (Phase 7 G-8,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-032, D-010/D-011).
 *
 * A NEW machine joining a hive has an EMPTY local mirror. Because every device
 * publishes under its own `refs/namespaces/<devHex>/…` and all namespaces share
 * one ODB (G-1), the whole hive state is seedable from ANY ONE member peer with
 * a single wildcard fetch of `refs/namespaces/*` over the G-2 transport — no
 * bundle infrastructure needed (D-010 noted bundle-uri as a LATER optimization;
 * a native v2 wildcard fetch is the interim and is fully incremental if
 * re-run).
 *
 * TRUST BOUNDARY (deliberate): bootstrap moves BYTES, not TRUST. The seeded
 * namespaces are claims by the SERVING peer about everyone else's refs until
 * the caller verifies each namespace's device-signed sigrefs (G-4
 * `reconcileFetchedHeads` — closes the transitive-relay tamper hole) and gates
 * devices against the admitted member set. Callers MUST run that verification
 * before treating any seeded head as a member's real state; the integrator /
 * bridge layers already do.
 *
 * Fail-soft: never throws; a failed bootstrap returns ok:false and is safely
 * re-runnable against the same or ANY OTHER member peer (the fetch is
 * idempotent + incremental).
 */

import type { Duplex } from 'node:stream';
import { type TransportResult, fetchOverDuplex } from './fetch-transport';
import { type RunGit, defaultRunGit, listNamespaces } from './storage';

/** Mirror EVERY device namespace verbatim — the one-refspec cold clone. Forced
 *  (`+`): each namespace's sole writer is its device; the serving peer's view
 *  is authoritative-until-sigrefs-verified, and a fresh joiner has nothing to
 *  clobber. */
export const ALL_NAMESPACES_REFSPEC = '+refs/namespaces/*:refs/namespaces/*';

export interface BootstrapResult extends TransportResult {
  /** True when the fetch completed (code 0). */
  ok: boolean;
  /** Device namespace keys (hex) present locally AFTER the bootstrap —
   *  UNVERIFIED until the caller runs the G-4 sigrefs reconciliation. */
  namespaces: string[];
}

/**
 * G-8: seed the WHOLE hive repo (all member namespaces + the integrator's
 * published staging, which lives inside its namespace) from one member peer
 * over `duplex`. The local bare repo must exist (G-1 `ensureHiveGitRepo`);
 * the caller picks any live peer and dials the per-fetch stream.
 */
export async function bootstrapFromPeer(
  localRepoPath: string,
  duplex: Duplex,
  opts: { timeoutMs?: number; runGit?: RunGit } = {},
): Promise<BootstrapResult> {
  const res = await fetchOverDuplex(localRepoPath, duplex, [ALL_NAMESPACES_REFSPEC], {
    timeoutMs: opts.timeoutMs,
  });
  const ok = res.code === 0;
  const namespaces = ok ? await listNamespaces(localRepoPath, opts.runGit ?? defaultRunGit) : [];
  return { ...res, ok, namespaces };
}
