/**
 * hive-git/bootstrap.ts — cold-clone bootstrap for a new joiner (Phase 7 G-8,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-032, D-010/D-011).
 *
 * A NEW machine joining a hive has an EMPTY local mirror. Because every device
 * publishes under its own `refs/namespaces/<devHex>/…` and all namespaces share
 * one ODB (G-1), the whole hive state is seedable from ANY ONE member peer over
 * the G-2 transport — no bundle infrastructure needed (D-010 noted bundle-uri
 * as a LATER optimization).
 *
 * REWIND SAFETY (HIGH fix, 2026-07-02 cross-review): bootstrap must NEVER move
 * a namespace that already exists locally. A direct forced wildcard fetch
 * (`+refs/namespaces/*:refs/namespaces/*`) let a RE-RUN against a STALE peer
 * force-rewind locally-advanced namespaces — destroying the G-4b sigrefs
 * watermark a verified reconcile had already established. So the fetch lands in
 * a private QUARANTINE area (`refs/bootstrap-quarantine/*`, ours to clobber),
 * and only namespaces with NO local refs are then seeded from it; every
 * pre-existing namespace is SKIPPED wholesale and reported in
 * `skippedExisting`. Updates to existing namespaces flow EXCLUSIVELY through
 * the verified announcement pipeline (G-3 rail + G-4 `reconcileFetchedHeads`),
 * never through bootstrap.
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
 * re-runnable against the same or ANY OTHER member peer.
 */

import type { Duplex } from 'node:stream';
import { type TransportResult, fetchOverDuplex } from './fetch-transport';
import { type RunGit, defaultRunGit, deviceNamespaceKey, listNamespaces } from './storage';

/** update-ref's "the ref must NOT exist" old-value (create-only CAS). */
const ZERO_SHA = '0'.repeat(40);

/** The private landing area for the bootstrap fetch — never read by anything
 *  else, always safe to clobber/delete. */
export const BOOTSTRAP_QUARANTINE_PREFIX = 'refs/bootstrap-quarantine';

/** Mirror EVERY device namespace into QUARANTINE (forced — quarantine is ours).
 *  The real `refs/namespaces/*` refs are only ever CREATED from it, per
 *  namespace, and only when the namespace does not exist locally. */
export const ALL_NAMESPACES_QUARANTINE_REFSPEC = `+refs/namespaces/*:${BOOTSTRAP_QUARANTINE_PREFIX}/*`;

export interface BootstrapResult extends TransportResult {
  /** True when the fetch AND every seed ref-write succeeded. */
  ok: boolean;
  /** Device namespace keys (hex) present locally AFTER the bootstrap —
   *  UNVERIFIED until the caller runs the G-4 sigrefs reconciliation. */
  namespaces: string[];
  /** Namespace keys the peer offered that already exist locally — left
   *  UNTOUCHED (rewind safety); they update via the announcement pipeline. */
  skippedExisting: string[];
}

interface QuarantineRef {
  key: string; // device namespace key (hex)
  rest: string; // the within-namespace ref path, e.g. 'refs/heads/work'
  sha: string;
}

async function readQuarantine(repoPath: string, runGit: RunGit): Promise<QuarantineRef[]> {
  const r = await runGit(
    ['for-each-ref', '--format=%(objectname) %(refname)', `${BOOTSTRAP_QUARANTINE_PREFIX}/`],
    repoPath,
  );
  if (r.code !== 0) return [];
  const out: QuarantineRef[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40,64}) refs\/bootstrap-quarantine\/([0-9a-f]+)\/(.+)$/);
    if (m) out.push({ sha: m[1], key: m[2], rest: m[3] });
  }
  return out;
}

/** Best-effort delete of every quarantine ref (start-of-run stale debris from
 *  a crashed prior bootstrap, and end-of-run cleanup). */
async function dropQuarantine(repoPath: string, runGit: RunGit): Promise<void> {
  for (const q of await readQuarantine(repoPath, runGit)) {
    await runGit(['update-ref', '-d', `${BOOTSTRAP_QUARANTINE_PREFIX}/${q.key}/${q.rest}`], repoPath);
  }
}

/**
 * G-8: seed the hive repo's MISSING namespaces (any member's work + the
 * integrator's published staging, which lives inside its namespace) from one
 * member peer over `duplex`. The local bare repo must exist (G-1
 * `ensureHiveGitRepo`); the caller picks any live peer and dials the per-fetch
 * stream. Namespaces that already exist locally are NEVER touched (see the
 * rewind-safety header note) and come back in `skippedExisting`.
 */
export async function bootstrapFromPeer(
  localRepoPath: string,
  duplex: Duplex,
  opts: { timeoutMs?: number; runGit?: RunGit } = {},
): Promise<BootstrapResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  await dropQuarantine(localRepoPath, runGit); // stale debris from a crashed run

  const preExisting = new Set(await listNamespaces(localRepoPath, runGit));
  const res = await fetchOverDuplex(localRepoPath, duplex, [ALL_NAMESPACES_QUARANTINE_REFSPEC], {
    timeoutMs: opts.timeoutMs,
  });
  if (res.code !== 0) {
    await dropQuarantine(localRepoPath, runGit);
    return { ...res, ok: false, namespaces: [], skippedExisting: [] };
  }

  const qrefs = await readQuarantine(localRepoPath, runGit);
  const skipped = new Set<string>();
  let ok = true;
  let stderr = res.stderr;
  for (const q of qrefs) {
    if (preExisting.has(q.key)) {
      skipped.add(q.key);
      continue;
    }
    // The namespace has no local refs — creating from quarantine can't rewind.
    const w = await runGit(['update-ref', `refs/namespaces/${q.key}/${q.rest}`, q.sha], localRepoPath);
    if (w.code !== 0) {
      ok = false;
      stderr += `\nseed ${q.key}/${q.rest}: ${w.stderr.trim()}`;
    }
  }
  await dropQuarantine(localRepoPath, runGit);

  const namespaces = await listNamespaces(localRepoPath, runGit);
  return { ...res, stderr, ok, namespaces, skippedExisting: [...skipped].sort() };
}
