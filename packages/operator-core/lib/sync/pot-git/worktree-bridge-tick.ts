/**
 * pot-git/worktree-bridge-tick.ts — P-204: the RUNTIME DRIVER for the
 * worktree bridge (p2p-git-live-activation-2026-07-09 P-204).
 *
 * Every piece already exists as a pure library: `staging-advance.ts` (G-5d
 * signed, epoch-fenced announcement), `worktree-bridge.ts` (G-7 announcement
 * → fetch → accept → ff-only worktree advance), `worktree-advance.ts` (G-7c/
 * G-7b). NONE of it runs on a schedule yet — this module is that missing
 * tick, composed exactly the way `integrator-tick.ts` (P-203) and
 * `ref-announce-tick.ts` (P-202) compose their own already-landed legs
 * (D-003: no new scheduler — the caller rides the existing `system:git-sync`
 * tick, mode-gated to `hiveGit.mode != legacy`).
 *
 * ONE TICK: given the pending inbound `pot-git:staging-advance` announcements
 * the caller collected off the P-009 fed-event log since its watermark
 * (`STAGING_ADVANCE_EVENT_KEY`, OLDEST FIRST — normally just one, since
 * `integrator-tick.ts` only ever emits on an actual advance, but a sparse
 * tick cadence or a caught-up cold start can hand this several at once), run
 * `handleStagingAdvance` per announcement, IN ORDER, threading the running
 * watermark from one to the next:
 *
 *   - `accepted` ⇒ advance the running watermark to this announcement's and
 *     continue to the next pending item (the worktree-level result rides
 *     along — a deferred/diverged worktree is NOT a rejection, see
 *     worktree-bridge.ts; the next sweep or the next accepted staging-advance
 *     retries it).
 *   - `rejected` (stale/malformed/forged/non-ff/unknown-sha) ⇒ skip it and
 *     continue — one bad/stale envelope in the batch must never starve the
 *     rest (mirrors `ref-announce-tick.ts`'s receive-tick contract).
 *   - `fetch-failed` ⇒ STOP processing further pending items this tick and
 *     return what's been done so far. Unlike a rejection, a transport failure
 *     usually means every LATER item (same integrator, same transport) will
 *     fail identically — better to stop cleanly and retry the whole
 *     unprocessed tail next tick than burn n transport attempts on one dead
 *     link.
 *
 * The caller MUST persist the returned `watermark` (unconditionally — even
 * when nothing advanced this tick, so a resumed/retried caller doesn't
 * re-derive it) and should re-drive `bridgeStagingShaToWorktree` from a
 * separate dirty-drain sweep for any `deferred-dirty`/`diverged-manual`
 * worktree result it wants to retry outside of a fresh announcement (see
 * worktree-bridge.ts's own header — this tick does not do that itself).
 *
 * Never throws — every failure is folded into `errors`; a tick that hits one
 * always still returns its partial results (matches `handleStagingAdvance`'s
 * own fail-soft contract, plus a defensive catch here in case a future seam
 * bug breaks that contract).
 */
import type { Duplex } from 'node:stream';
import type { RunGit } from './storage';
import {
  type AcceptStagingAdvanceOpts,
  type EpochSeq,
  type SignedStagingAdvance,
} from './staging-advance';
import { type StagingAdvanceBridgeResult, type WorktreeBridgeConfig, handleStagingAdvance } from './worktree-bridge';

export interface WorktreeBridgeTickInput {
  /** The local pot-git bare mirror for this (hive, managed repo) — G-1. */
  bareRepoPath: string;
  /** The machine's working tree that follows canonical staging. */
  worktreePath: string;
  /** Pending inbound staging-advance announcements collected off the fed-event
   *  log since the caller's watermark, OLDEST FIRST. Empty ⇒ a fast no-op
   *  (the common case on a git-sync tick where staging hasn't moved). */
  pending: readonly SignedStagingAdvance[];
  /** The last ACCEPTED watermark (both null before the first accept). The
   *  caller persists this and threads it back on the next tick. */
  prior: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /** Device gate for every announcement this tick — MANDATORY, see
   *  worktree-bridge.ts's `WorktreeBridgeConfig.accept` for why a gate-less
   *  config throws (watermark-poisoning DoS). */
  accept: AcceptStagingAdvanceOpts;
  /**
   * Dial a FRESH per-fetch duplex to a peer that can serve the announcing
   * integrator's namespace (G-2, P-201's `openHiveGitFetchDuplex` client
   * seam). Called once PER pending announcement that reaches the fetch step
   * (a rejected-pre-fetch announcement never dials). Omit when the objects
   * are already local (this machine IS the integrator, or P-202's
   * ref-announce fetch already synced the namespace into the local mirror).
   *
   * KNOWN LIMITATION (mirrors the integrator-tick.ts EPOCH NOTE): the caller
   * wiring (git-sync-action.ts) does not yet resolve a live swarm connection
   * to a SPECIFIC peer by device pubkey — a peer-connection registry keyed by
   * device identity doesn't exist yet (P-201 built the dial primitive,
   * `openHiveGitFetchDuplex`, but not "which live socket is device X on").
   * Until that lands, this seam is safe to omit on a single-authority
   * dev-box run (the integrator's own machine never needs it) and on any
   * machine whose local mirror is already current via P-202's ref-announce
   * fetch; a true cold multi-machine fetch-on-demand needs the registry —
   * tracked for Phase 3 (P-301 live drill).
   */
  openDuplex?: () => Promise<Duplex>;
  runGit?: RunGit;
  fetchTimeoutMs?: number;
}

export interface WorktreeBridgeTickResultEntry {
  epoch: number;
  seq: number;
  stagingSha: string;
  bridge: StagingAdvanceBridgeResult;
}

export interface WorktreeBridgeTickOutcome {
  ran: boolean;
  results: WorktreeBridgeTickResultEntry[];
  /** The watermark to persist — advances to the LAST accepted announcement's
   *  (epoch, seq, sha); unchanged from `input.prior` when nothing in this
   *  batch was accepted. ALWAYS persist this (even when `ran: false` or
   *  unchanged) so a resumed caller has a stable value to thread back. */
  watermark: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /** True when a `fetch-failed` outcome stopped the batch before every
   *  pending item was processed — the caller should NOT advance its
   *  fed-event-log cursor past the un-processed tail (retry them next tick,
   *  same `pending` order they'd be re-collected in). */
  stoppedOnFetchFailure: boolean;
  errors: string[];
}

/**
 * ONE tick: process every pending staging-advance announcement against the
 * local mirror + worktree, in order. Never throws — see module header for
 * the per-outcome continue/stop contract.
 */
export async function runWorktreeBridgeTick(
  input: WorktreeBridgeTickInput,
): Promise<WorktreeBridgeTickOutcome> {
  const errors: string[] = [];
  const results: WorktreeBridgeTickResultEntry[] = [];
  let watermark = input.prior;

  if (input.pending.length === 0) {
    return { ran: false, results, watermark, stoppedOnFetchFailure: false, errors };
  }

  for (const incoming of input.pending) {
    const cfg: WorktreeBridgeConfig = {
      bareRepoPath: input.bareRepoPath,
      worktreePath: input.worktreePath,
      prior: watermark,
      accept: input.accept,
      ...(input.openDuplex ? { openDuplex: input.openDuplex } : {}),
      ...(input.runGit ? { runGit: input.runGit } : {}),
      ...(input.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: input.fetchTimeoutMs } : {}),
    };

    let bridge: StagingAdvanceBridgeResult;
    try {
      bridge = await handleStagingAdvance(cfg, incoming);
    } catch (e) {
      // handleStagingAdvance is documented never-throw on runtime data (only a
      // gate-less config throws, which is a caller wiring bug we want loud —
      // let it propagate rather than silently swallow a misconfiguration).
      if (e instanceof TypeError && /device gate/.test(e.message)) throw e;
      errors.push(
        `handleStagingAdvance(epoch=${incoming.epoch},seq=${incoming.seq}) threw: ${
          e instanceof Error ? e.message : e
        }`,
      );
      continue;
    }

    results.push({ epoch: incoming.epoch, seq: incoming.seq, stagingSha: incoming.staging_sha, bridge });

    if (bridge.outcome === 'accepted') {
      watermark = bridge.watermark;
      continue;
    }
    if (bridge.outcome === 'fetch-failed') {
      errors.push(
        `fetch failed for epoch=${incoming.epoch},seq=${incoming.seq}: ${bridge.detail} — stopping this tick's batch, retrying next tick`,
      );
      return { ran: true, results, watermark, stoppedOnFetchFailure: true, errors };
    }
    // 'rejected' (stale/malformed/forged/non-ff/unknown-sha): skip, never
    // starve the rest of the batch.
  }

  return { ran: true, results, watermark, stoppedOnFetchFailure: false, errors };
}
