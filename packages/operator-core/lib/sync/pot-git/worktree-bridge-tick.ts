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
   * Receives the ANNOUNCING device's pubkey so the caller can dial that
   * specific peer (EI-14555). WI-3583's per-device registry
   * (`peer-dial-registry.ts`) resolves device pubkey → live swarm socket, so
   * git-sync-action.ts now wires this the same way it wires the ref-announce
   * leg's `openStream` — a cold machine whose mirror lacks the announced sha
   * fetches on demand instead of rejecting `unknown-sha` forever. Still
   * optional: omit when the objects are always local (the integrator's own
   * machine) or in offline tests that serve from a fixed socket.
   */
  openDuplex?: (devicePubkeyBase64: string) => Promise<Duplex>;
  runGit?: RunGit;
  fetchTimeoutMs?: number;
}

export interface WorktreeBridgeTickResultEntry {
  epoch: number;
  seq: number;
  stagingSha: string;
  bridge: StagingAdvanceBridgeResult;
}

/**
 * Rejections that are TRANSIENT-STATE, not verdicts on the envelope (P-505,
 * the WI-3497 drop-forever fix): `unknown-sha` = the objects haven't fetched
 * into the local mirror yet (P-202's ref-announce fetch races the fed-event);
 * `ungranted-epoch` = a successor authority's first advance arrived before
 * its granting handoff token federated. Both verify unchanged on a later
 * tick, so the batch STOPS there (same rationale as `fetch-failed`) and the
 * caller must NOT advance its cursor past the item. Every other reason
 * (stale/forged/wrong-device/non-ff/malformed) is a terminal verdict on the
 * envelope itself — retrying can never change it — so those skip-and-continue.
 */
export const RETRYABLE_REJECT_REASONS: ReadonlySet<string> = new Set(['unknown-sha', 'ungranted-epoch']);

/** P-505: how long a transient staging-advance rejection may pin the
 * fed-event cursor before the stopped row is consumed as genuinely lost. */
export const WORKTREE_BRIDGE_RETRY_TTL_MS = 6 * 60 * 60 * 1000;

export interface WorktreeBridgeCursorRow {
  id: number;
  tsMs: number | null;
}

/**
 * Translate a tick's stop index into the durable fed-event cursor.
 *
 * This is deliberately pure because the boundary is the drop-forever rail:
 * before the TTL (including the exact boundary, or when age is unknowable),
 * hold immediately BEFORE the stopped row so it re-collects next tick. After
 * the TTL, consume ONLY that row and remain before its tail, so one lost
 * object/token cannot wedge every later announcement.
 */
export function decideWorktreeBridgeCursor(input: {
  maxRowId: number;
  pendingRows: readonly WorktreeBridgeCursorRow[];
  unprocessedFromIndex: number | null;
  nowMs: number;
  retryTtlMs?: number;
}): { cursor: number; expiredRow: WorktreeBridgeCursorRow | null } {
  const retryTtlMs = input.retryTtlMs ?? WORKTREE_BRIDGE_RETRY_TTL_MS;
  const k = input.unprocessedFromIndex;
  if (k === null) {
    return { cursor: input.maxRowId, expiredRow: null };
  }
  if (!Number.isInteger(k) || k < 0 || k >= input.pendingRows.length) {
    // Fail closed. A non-null stop index means the tick explicitly left one
    // row unprocessed. If it no longer maps to the index-aligned row census,
    // advancing to maxRowId would silently consume that row and recreate the
    // P-505 drop-forever failure this helper exists to prevent. The caller's
    // outer tick guard logs the error and leaves the prior cursor untouched.
    throw new RangeError(
      `worktree-bridge stop index ${k} is outside pendingRows[0..${input.pendingRows.length - 1}]`,
    );
  }

  const stuck = input.pendingRows[k]!;
  const age = stuck.tsMs === null ? null : input.nowMs - stuck.tsMs;
  if (age !== null && age > retryTtlMs) {
    return { cursor: stuck.id, expiredRow: stuck };
  }
  return { cursor: stuck.id - 1, expiredRow: null };
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
  /**
   * Index into `input.pending` of the first item NOT durably processed this
   * tick, or null when every item was (accepted or terminally rejected).
   * Set by BOTH stop paths — a `fetch-failed` and a retryable rejection
   * ({@link RETRYABLE_REJECT_REASONS}) — and it is the value the caller's
   * cursor math needs: advance the fed-event cursor only past items BEFORE
   * this index (the stopped item re-collects and retries next tick). The
   * caller should age-bound the retry (a row stuck retryable for hours is a
   * genuinely lost object, not a race) so one poisoned row can't wedge the
   * cursor forever.
   */
  unprocessedFromIndex: number | null;
  errors: string[];
  /**
   * EI-19332963201820362: how many announcements this tick ACCEPTED. Together
   * with `results.length` (how many it consumed) this is the acceptance census
   * a health layer needs, and it exists because the absence of it hid a ~6h
   * canonical-staging freeze on 2026-08-02 behind uniformly green surfaces.
   *
   * `consumed >= 1 && acceptedCount === 0` is a REPORTABLE condition. It is not
   * necessarily a fault for ONE tick (a single stale/replayed envelope is
   * ordinary), but it is never healthy as a STEADY STATE: it means the cursor
   * is draining the announcement log while the watermark stands still.
   */
  acceptedCount: number;
  /**
   * EI-19332963201820362: terminal (non-retryable) rejections this tick, counted
   * by reason — `{ 'non-fast-forward': 12 }`.
   *
   * Note the inversion this exists to correct: RETRYABLE rejections, which are
   * transient and self-correcting, each push to {@link WorktreeBridgeTickOutcome.errors}
   * and halt the batch — they are LOUD. TERMINAL rejections, which by definition
   * can never succeed on retry and therefore indicate a PERSISTENT problem, used
   * to skip-and-continue emitting nothing at all. The quiet path was the
   * dangerous one.
   */
  terminalRejections: Record<string, number>;
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
  // EI-19332963201820362: the acceptance census. Both were already derivable
  // from `results` and simply never aggregated — the information was computed
  // and dropped on every one of ~6h of ticks.
  let acceptedCount = 0;
  const terminalRejections: Record<string, number> = {};

  if (input.pending.length === 0) {
    return {
      ran: false,
      results,
      watermark,
      stoppedOnFetchFailure: false,
      unprocessedFromIndex: null,
      errors,
      acceptedCount,
      terminalRejections,
    };
  }

  for (const [index, incoming] of input.pending.entries()) {
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
      acceptedCount += 1;
      continue;
    }
    if (bridge.outcome === 'fetch-failed') {
      errors.push(
        `fetch failed for epoch=${incoming.epoch},seq=${incoming.seq}: ${bridge.detail} — stopping this tick's batch, retrying next tick`,
      );
      return {
        ran: true,
        results,
        watermark,
        stoppedOnFetchFailure: true,
        unprocessedFromIndex: index,
        errors,
        acceptedCount,
        terminalRejections,
      };
    }
    if (bridge.outcome === 'rejected' && RETRYABLE_REJECT_REASONS.has(bridge.reason)) {
      // P-505: transient-state rejection — the SAME envelope verifies once the
      // missing objects / granting token federate. Stop here so the caller's
      // cursor holds at this item (mirrors the fetch-failed contract).
      errors.push(
        `retryable rejection (${bridge.reason}) for epoch=${incoming.epoch},seq=${incoming.seq} — ` +
          `holding the batch here, retrying next tick`,
      );
      return {
        ran: true,
        results,
        watermark,
        stoppedOnFetchFailure: false,
        unprocessedFromIndex: index,
        errors,
        acceptedCount,
        terminalRejections,
      };
    }
    // 'rejected' with a TERMINAL reason (stale/malformed/forged/wrong-device/
    // non-ff): skip, never starve the rest of the batch — but COUNT it
    // (EI-19332963201820362). Skipping is still right; skipping SILENTLY is not.
    if (bridge.outcome === 'rejected') {
      terminalRejections[bridge.reason] = (terminalRejections[bridge.reason] ?? 0) + 1;
    }
  }

  return {
    ran: true,
    results,
    watermark,
    stoppedOnFetchFailure: false,
    unprocessedFromIndex: null,
    errors,
    acceptedCount,
    terminalRejections,
  };
}
