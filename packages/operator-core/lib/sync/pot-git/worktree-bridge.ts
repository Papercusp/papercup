/**
 * pot-git/worktree-bridge.ts — the staging→worktree bridge (Phase 7 G-7,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-031, D-010/D-011).
 *
 * WHAT THIS IS: the receiver-side glue that turns a SIGNED staging-advance
 * announcement (G-5d, staging-advance.ts — built by the integrator, carried by
 * the G-3 announcement rail) into a LOCAL working-tree update, composing the
 * already-landed seams end to end:
 *
 *   announcement → [pure fence: sig + device + (epoch,seq)]        (G-5d, no I/O)
 *               → [fetch the integrator's namespace over a duplex]  (G-2)
 *               → [full acceptance: ff of the last accepted staging](G-5d + git)
 *               → [object-bridge mirror → worktree ODB]             (this module)
 *               → [ff-only, dirty-safe worktree advance]            (G-7c/G-7b)
 *
 * ORDERING MATTERS: the PURE fence runs FIRST so a forged / stale / replayed
 * announcement is rejected for free — it can never trigger fetch traffic (a
 * hostile peer must not be able to make us dial out with junk envelopes).
 *
 * TWO LEVELS OF ACCEPTANCE, deliberately separate:
 *   - MIRROR acceptance (the watermark): the canonical staging moved — the
 *     caller persists `watermark` (epoch, seq, sha) whenever `outcome:
 *     'accepted'`, EVEN IF the worktree could not advance yet (deferred-dirty /
 *     diverged-manual). Staging is authority-published truth; the worktree is a
 *     best-effort follower.
 *   - WORKTREE advance (`advance` in the result): ff-only + dirty-safe per
 *     G-7c/G-7b — a deferral here is retried by the next sweep
 *     (`bridgeStagingShaToWorktree` with the persisted watermark sha) after the
 *     local autocommit picks the dirty files up.
 *
 * Injectable seams (all of it tests offline against real repos + a socket
 * duplex, no swarm): `openDuplex` dials the per-fetch stream (prod: a
 * `papercusp/pot-git` Protomux sub-stream on an existing hive connection —
 * leader-held wiring; tests: a unix socket). Omit `openDuplex` when the
 * objects are already local (the integrator's own machine).
 *
 * Fail-soft by contract: never throws on runtime data; every failure is a
 * typed outcome. (Sole exception: a config missing the mandatory device gate
 * throws — that is a wiring bug, not runtime data.)
 */

import type { Duplex } from 'node:stream';
import { type RunGit, defaultRunGit, deviceNamespaceKey } from './storage';
import { fetchPeerNamespace } from './fetch-transport';
import { STAGING_REF } from './integrator';
import {
  type AcceptStagingAdvanceOpts,
  type EpochSeq,
  type SignedStagingAdvance,
  type StagingAdvanceAcceptance,
  acceptStagingAdvance,
  acceptStagingAdvanceFF,
} from './staging-advance';
import { type WorktreeAdvanceResult, advanceWorktree } from './worktree-advance';

/** Where the worktree-side repo tracks the canonical staging it last bridged
 *  (a plain local ref — NEVER a branch anyone works on). */
export const WORKTREE_STAGING_REF = 'refs/hive/staging';

export interface WorktreeBridgeConfig {
  /** The local pot-git bare mirror for this (hive, managed repo) — G-1. */
  bareRepoPath: string;
  /** The machine's working tree that follows canonical staging. */
  worktreePath: string;
  /** The last ACCEPTED watermark (both null before the first accept). The
   *  caller persists this and threads it back on the next announcement. */
  prior: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /**
   * Dial a FRESH per-fetch duplex to a peer that can serve the integrator's
   * namespace (G-2). Omitted ⇒ no transport fetch — the objects are expected
   * to already be in the local mirror (e.g. this machine IS the integrator).
   */
  openDuplex?: () => Promise<Duplex>;
  /**
   * Device gate for the announcement — MANDATORY (HIGH fix, 2026-07-02
   * cross-review): `expectedDevice` = the current integrator authority, or
   * `allowedDevices` = the admitted member set (see staging-advance.ts). One of
   * the two MUST be set — without a device gate `acceptStagingAdvance` checks
   * signature SELF-consistency only, so ANY key can self-sign an
   * `epoch: 1e9` envelope over the CURRENT sha; the fence would accept it,
   * poison the persisted watermark, and every legitimate future advance would
   * be rejected as `stale-epoch-seq` (a one-message DoS). A gate-less config is
   * a programmer error and THROWS (the one deliberate exception to the
   * fail-soft contract).
   *
   * With `allowedDevices` (a member SET), ALSO set `maxGrantedEpoch` (WI-1560,
   * see AcceptStagingAdvanceOpts) — the ADMITTED-member variant of the same
   * poisoning is otherwise still open: any member key passes the set gate and
   * can claim an arbitrary epoch. Cap it at the last verified G-0 handoff
   * grant (`adoptHandoffToken(...).nextEpoch`) / the lease epoch.
   */
  accept: AcceptStagingAdvanceOpts;
  runGit?: RunGit;
  fetchTimeoutMs?: number;
}

export type StagingAdvanceBridgeResult =
  | {
      /** The announcement failed the fence (forged / stale / wrong device /
       *  non-ff / unknown sha). Nothing was applied; watermark unchanged. */
      outcome: 'rejected';
      reason: Extract<StagingAdvanceAcceptance, { ok: false }>['reason'];
      /** True when the reject happened BEFORE any fetch (the pure fence). */
      preFetch: boolean;
    }
  | {
      /** The transport fetch failed — try again on the next announcement. */
      outcome: 'fetch-failed';
      detail: string;
    }
  | {
      /** Accepted: the canonical staging moved. PERSIST `watermark`. The
       *  worktree-level result rides along (advanced / noop / deferred-dirty /
       *  diverged-manual / error) — a non-advance there is NOT a rejection. */
      outcome: 'accepted';
      watermark: { epochSeq: EpochSeq; stagingSha: string };
      advance: WorktreeAdvanceResult;
    };

/**
 * Bring the objects reachable from the integrator's published staging into the
 * WORKTREE's own ODB (worktree and mirror are separate repos), then ff-advance
 * the worktree (G-7c/G-7b). Fetches BY REF NAME (always advertised), pinning
 * the worktree-side `refs/hive/staging`; the advance itself targets `sha` —
 * even if the mirror ref has already moved past it, ff-only means the newer
 * ref contains `sha`, so the objects are present either way.
 *
 * Also the RETRY path for a deferred/diverged worktree: call it from the sweep
 * with the persisted watermark sha once the local autocommit has drained the
 * dirty files.
 */
export async function bridgeStagingShaToWorktree(
  bareRepoPath: string,
  worktreePath: string,
  integratorDevicePubkeyBase64: string,
  sha: string,
  opts: { runGit?: RunGit } = {},
): Promise<WorktreeAdvanceResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  try {
    const nsStaging = `refs/namespaces/${deviceNamespaceKey(integratorDevicePubkeyBase64)}/${STAGING_REF}`;
    const fetched = await runGit(
      ['fetch', '-q', bareRepoPath, `+${nsStaging}:${WORKTREE_STAGING_REF}`],
      worktreePath,
    );
    if (fetched.code !== 0) {
      return {
        outcome: 'error',
        from: null,
        to: sha,
        detail: `object-bridge fetch from the mirror failed: ${fetched.stderr.trim()}`,
      };
    }
    return advanceWorktree(worktreePath, sha, { runGit });
  } catch (e) {
    return { outcome: 'error', from: null, to: sha, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * G-7: handle ONE staging-advance announcement end to end. Never throws.
 *
 *   1. PURE fence (no I/O): signature + device gate + strict (epoch, seq)
 *      monotonicity vs `cfg.prior.epochSeq` — a junk envelope never dials out.
 *   2. Fetch the integrator's namespace into the local mirror (when
 *      `openDuplex` is given) — G-2 `fetchPeerNamespace`.
 *   3. FULL acceptance vs the mirror: the announced sha resolves locally AND
 *      is a fast-forward of the last accepted staging (never rewinds).
 *   4. Object-bridge to the worktree + ff-only dirty-safe advance.
 *
 * On `outcome: 'accepted'` the caller MUST persist `watermark` — including
 * when the worktree advance was deferred (the sweep catches it up later).
 *
 * Never throws on runtime DATA (announcements, transport, git) — but a config
 * with no device gate is a programmer error and throws immediately (see
 * `WorktreeBridgeConfig.accept`).
 */
export async function handleStagingAdvance(
  cfg: WorktreeBridgeConfig,
  incoming: SignedStagingAdvance,
): Promise<StagingAdvanceBridgeResult> {
  // MANDATORY device gate — misconfiguration must fail LOUD, before any
  // envelope can reach a self-consistency-only fence (watermark poisoning).
  if (
    cfg.accept === undefined ||
    (cfg.accept.expectedDevice === undefined && cfg.accept.allowedDevices === undefined)
  ) {
    throw new TypeError(
      'worktree-bridge: cfg.accept must pin a device gate (expectedDevice or allowedDevices) — ' +
        'without one, any key can self-sign a max-epoch staging-advance over the current sha ' +
        'and poison the watermark fence (accepted, then every real advance is stale-epoch-seq)',
    );
  }
  const runGit = cfg.runGit ?? defaultRunGit;
  try {
    // 1) Pure fence FIRST — reject junk before any network or git I/O.
    const pure = acceptStagingAdvance(incoming, cfg.prior.epochSeq, cfg.accept);
    if (!pure.ok) return { outcome: 'rejected', reason: pure.reason, preFetch: true };

    // 2) Mirror the integrator's namespace (objects + refs) over the duplex.
    if (cfg.openDuplex) {
      let duplex: Duplex;
      try {
        duplex = await cfg.openDuplex();
      } catch (e) {
        return { outcome: 'fetch-failed', detail: `openDuplex failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      const fetched = await fetchPeerNamespace(cfg.bareRepoPath, duplex, incoming.device_pubkey, {
        timeoutMs: cfg.fetchTimeoutMs,
      });
      if (fetched.code !== 0) {
        return { outcome: 'fetch-failed', detail: fetched.stderr.trim() || `fetch exited ${fetched.code}` };
      }
    }

    // 3) Full acceptance: sha present locally + ff of the last accepted staging.
    const full = await acceptStagingAdvanceFF(
      cfg.bareRepoPath,
      incoming,
      cfg.prior.epochSeq,
      cfg.prior.stagingSha,
      { ...cfg.accept, runGit },
    );
    if (!full.ok) return { outcome: 'rejected', reason: full.reason, preFetch: false };

    // 4) Follow with the worktree (ff-only, dirty-safe; deferral is fine).
    const advance = await bridgeStagingShaToWorktree(
      cfg.bareRepoPath,
      cfg.worktreePath,
      incoming.device_pubkey,
      incoming.staging_sha,
      { runGit },
    );

    return {
      outcome: 'accepted',
      watermark: {
        epochSeq: { epoch: incoming.epoch, seq: incoming.seq },
        stagingSha: incoming.staging_sha,
      },
      advance,
    };
  } catch (e) {
    // Fail-soft backstop: surface as a transport-class failure, never throw.
    return { outcome: 'fetch-failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
