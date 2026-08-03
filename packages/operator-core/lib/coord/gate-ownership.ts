/**
 * gate-ownership.ts — P-004 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * Folds "who owns this incident" onto the gate state cells, so an agent reading
 * `gate.greenCheckpoint.verdict` learns whether someone is ALREADY on the red
 * before it files the seventh work-item about it.
 *
 * ── WHY THIS IS A SEPARATE MODULE ─────────────────────────────────────────────
 * The natural place is inline in `git-pipeline-position.ts`, which owns both gate
 * cells. That file is 3,400 lines and its resolver is not unit-testable without a
 * repo + a snapshot. The interesting logic here — the projection, and the two
 * misreads it has to defend against — is pure, so it lives where it can be tested
 * with no git and no database.
 *
 * ── THE EVENT KEY, VERIFIED RATHER THAN ASSUMED (D-012) ───────────────────────
 * `green-stall:<harness>` is the gate's condition, confirmed against the live
 * alarm text rather than inferred from the name:
 *
 *   green-stall:papercusp        "green-checkpoint STALLED on papercusp — no green
 *                                 verdicts; deploys frozen."          <- THIS cell
 *   main-behind-staging:papercusp "main is 52 commits behind staging — promotion
 *                                 pipeline stalled."                  <- the SIBLING
 *                                 falsifier cell (git.mainBehindStaging), not this one
 *
 * Both read as "the pipeline is stalled" in English, and they are measured by
 * different apparatus — which is exactly why `GATE_VERDICT_CELL` and the
 * main-behind cell are declared MUTUAL FALSIFIERS. Attaching the wrong key here
 * would quietly point the gate's ownership at the other cell's incident.
 */
import {
  findConditionObjects,
  type ConditionClaimState,
  type ConditionObject,
} from './condition-object';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { cellUnknown, type CellUnknown } from '../cell-contract';
import {
  noSubjectThread,
  readCellThread,
  unmeasuredThread,
  type CellThread,
} from './cell-thread';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';

/**
 * The condition whose lifetime IS a green-checkpoint stall.
 *
 * Emitted by `green-stall-watchdog.ts` as `green-stall:${row.install_slug}` — a
 * SLUG-suffixed family, so unlike `single-primary:` the harness is recoverable
 * from the key (see D-012 for why that is worth stating per-family rather than
 * assuming).
 */
export function gateStallConditionKey(harness: string): string {
  return `green-stall:${harness}`;
}

/**
 * Ownership of the incident a state cell describes.
 *
 * ⚠ TWO MISREADS THIS BLOCK INVITES, both of which turn a helpful field into a
 * confidently wrong conclusion. They are the reason `claimState` is an explicit
 * enum and the reason this doc-block exists:
 *
 *   1. `claimState: 'no-object'` does NOT mean "the gate is fine". It means no
 *      work-item owns the condition — which is equally true of a healthy gate and
 *      of a red one nobody has filed yet. OWNERSHIP IS ORTHOGONAL TO REDNESS: read
 *      `gate.consecutiveReds` / `verdictStale` for the gate's health, and this
 *      block only for "is someone already on it".
 *
 *   2. `takenBy != null` does NOT mean someone is working on it. A dead agent's
 *      abandoned lease has a non-null `takenBy` forever. That is what separates
 *      `held` from `lease-expired`, and why a caller must branch on `claimState`
 *      rather than null-testing `takenBy` — reporting a dead holder as live
 *      ownership is worse than reporting none, because it suppresses the next
 *      agent from picking the work up.
 *
 * `lease-expired` is still only a LEASE check — it asks whether the claim's clock
 * ran out, not whether the holder is alive. An agent that died holding a long
 * lease reads `held` here. Closing that gap is P-005's falsifier
 * (`ownership.holderSessionState`, measured by the presence oracle), which is a
 * deliberately independent apparatus rather than a refinement of this field.
 */
export interface CellOwnership {
  /** The condition key this cell's incident is keyed by. */
  eventKey: string;
  /** The singleton work-item owning it, or null when nothing owns it yet. */
  workItem: string | null;
  /**
   * EXPLICIT — never infer this from which of the fields below are null.
   *
   * NULL means UNMEASURED (see `unknown`), which is deliberately NOT the same
   * value as `'no-object'`. P-004 shipped this as a non-null enum that degraded to
   * `'no-object'` when the store was unreachable — so "nobody owns this" and "we
   * could not tell" were the same byte, and the failure read as the reassuring
   * one. Registering the cell forced the question (`CellSpec` axis 2: can the
   * verdict be unknown?) and the honest answer is yes.
   */
  claimState: ConditionClaimState | null;
  /** In-band unknown, non-null exactly when `claimState` is null. */
  unknown: CellUnknown | null;
  takenBy: string | null;
  takenAt: string | null;
  expiresAt: string | null;
  /**
   * THE FALSIFIER (P-005). The holder's liveness per the presence oracle —
   * INDEPENDENT apparatus from `claimState`, which is computed purely from the
   * work-item's own lease columns (`taken_by`, `expires_at`).
   *
   * That independence is the entire point. A lease expires on a CLOCK, so a claim
   * with a long or absent expiry reads `held` forever — including one held by an
   * agent that died minutes after taking it. The oracle measures something the
   * lease cannot see (heartbeat, wakeability, a pid probe, recorded sessions), so
   * `claimState: 'held'` + `holderSessionState: 'ended'` is the exact contradiction
   * this field exists to expose.
   *
   * ⚠ Do NOT substitute `heartbeatFresh` if you ever reach for the raw verdict:
   * that is process-keepalive freshness, not a liveness verdict, and a warm-dead
   * session reads `heartbeatFresh: true` with `sessionState: 'ended'`.
   *
   * NULL when there is no holder to measure, or when the oracle could not answer —
   * both of which mean "no contradiction established", never "the holder is live".
   */
  holderSessionState: SessionState | null;
  /**
   * Extra open work-items on the SAME key beyond the canonical one.
   *
   * Expected EMPTY now that P-002's partial unique index is enforcing. A non-empty
   * value means rows predating the index (or hand-set keys) — surfaced rather than
   * hidden, because a silently-picked canonical row is how a duplicate becomes
   * invisible instead of fixed.
   */
  duplicates: readonly string[];
  /**
   * P-006. What has already been SAID about this incident — the last few posts on
   * the owning work-item's thread, plus pointers to the areas it is filed under.
   *
   * ⚠ ADVISORY PAYLOAD, deliberately OUTSIDE this cell's falsifier contract
   * (D-006). The falsifier is `holderSessionState`, which measures the HOLDER; a
   * prose excerpt asserts nothing beyond "these bytes were posted", so there is no
   * apparatus that could contradict it. Do not reach for it when you want to know
   * whether the ownership above is TRUE — it answers a different question ("has
   * anyone explained this yet"), and treating a confident-sounding comment as
   * evidence about the claim is how a stale message outranks a measurement.
   */
  thread: CellThread;
}

/** PURE. Project a resolved condition onto a cell's ownership block. */
export function toCellOwnership(
  obj: ConditionObject,
  holderSessionState: SessionState | null = null,
  thread: CellThread = noSubjectThread('thread not read on this projection'),
): CellOwnership {
  return {
    eventKey: obj.conditionKey,
    workItem: obj.workItem,
    claimState: obj.claimState,
    unknown: null,
    takenBy: obj.takenBy,
    takenAt: obj.takenAt,
    expiresAt: obj.expiresAt,
    holderSessionState,
    duplicates: obj.duplicates,
    thread,
  };
}

/**
 * PURE. A MEASURED "nobody owns this" — the store answered and found nothing.
 *
 * Distinct from {@link unmeasuredCell}. Collapsing the two is the bug the
 * `claimState` doc describes.
 */
export function unownedCell(eventKey: string): CellOwnership {
  return {
    eventKey,
    workItem: null,
    claimState: 'no-object',
    unknown: null,
    takenBy: null,
    takenAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    // Nothing owns the condition, so there is no thread to have — FINAL
    // (`not-applicable`), not an empty one and not a failed read.
    thread: noSubjectThread('no work-item owns this condition, so there is no thread to read'),
  };
}

/** PURE. Ownership could NOT be read — never rendered as "nobody owns this". */
export function unmeasuredCell(eventKey: string, detail: string): CellOwnership {
  return {
    eventKey,
    workItem: null,
    claimState: null,
    unknown: cellUnknown('resolver-failed', detail),
    takenBy: null,
    takenAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    // Ownership was unreadable, so the thread is unknown TOO — never silence.
    // Reporting "nothing was said" here would restate the failure as reassurance.
    thread: unmeasuredThread(`ownership unreadable, so its thread was not read: ${detail}`),
  };
}

/**
 * PURE. Does the lease-derived claim CONTRADICT the presence oracle?
 *
 * The falsifier's verdict in one call, so a consumer never has to re-derive the
 * comparison (and get it subtly wrong by treating `parked` as dead — a parked
 * agent is alive and will wake).
 */
export function ownershipContradicted(own: CellOwnership): boolean {
  if (own.claimState !== 'held') return false;
  return own.holderSessionState === 'ended' || own.holderSessionState === 'recorded';
}

/**
 * Read ownership of the green-checkpoint gate's stall condition.
 *
 * Costs ONE indexed SELECT (`findConditionObjects` is batched and capped), not a
 * fork or a git call — the same reasoning that makes `checkpointRunInFlight` safe
 * to read on every `dev:pipeline_position` call.
 *
 * FAIL-SOFT to `no-object`: `findConditionObjects` already degrades rather than
 * throwing when the store is unreachable, and this adds the same guarantee at the
 * boundary. A cell must always render; "no owner" is the correct non-misleading
 * answer when ownership cannot be seen. It is NOT, however, a claim that the gate
 * is healthy — see misread #1 above.
 */
export async function readGateOwnership(
  opts: {
    harness?: string;
    findConditionObjects?: typeof findConditionObjects;
    resolveSessionStates?: typeof resolveSessionStates;
    readCellThread?: typeof readCellThread;
  } = {},
): Promise<CellOwnership> {
  const harness = opts.harness?.trim() || operatorHomeHarnessSlug();
  const eventKey = gateStallConditionKey(harness);

  let obj: ConditionObject | undefined;
  try {
    const find = opts.findConditionObjects ?? findConditionObjects;
    obj = (await find([eventKey], { harnessSlug: harness })).get(eventKey);
  } catch (err) {
    return unmeasuredCell(eventKey, `ownership store unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!obj) return unownedCell(eventKey);

  // The falsifier leg. Only worth a call when there IS a holder to measure —
  // and its failure degrades to null (no contradiction established), never to a
  // guess about liveness in either direction.
  let holderSessionState: SessionState | null = null;
  if (obj.takenBy) {
    try {
      const resolve = opts.resolveSessionStates ?? resolveSessionStates;
      const verdicts = await resolve([{ ownerId: obj.takenBy }], { hydratePerId: true });
      holderSessionState = verdicts.get(obj.takenBy)?.sessionState ?? null;
    } catch {
      holderSessionState = null;
    }
  }

  // P-006, advisory. Independent of the falsifier above and fails soft on its own
  // — a thread that cannot be read must never degrade the OWNERSHIP verdict, which
  // was measured successfully and is the part of this cell anyone branches on.
  const readThread = opts.readCellThread ?? readCellThread;
  const thread = await readThread(obj.workItem, { harness });

  return toCellOwnership(obj, holderSessionState, thread);
}
