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
  /** EXPLICIT — never infer this from which of the fields below are null. */
  claimState: ConditionClaimState;
  takenBy: string | null;
  takenAt: string | null;
  expiresAt: string | null;
  /**
   * Extra open work-items on the SAME key beyond the canonical one.
   *
   * Expected EMPTY now that P-002's partial unique index is enforcing. A non-empty
   * value means rows predating the index (or hand-set keys) — surfaced rather than
   * hidden, because a silently-picked canonical row is how a duplicate becomes
   * invisible instead of fixed.
   */
  duplicates: readonly string[];
}

/** PURE. Project a resolved condition onto a cell's ownership block. */
export function toCellOwnership(obj: ConditionObject): CellOwnership {
  return {
    eventKey: obj.conditionKey,
    workItem: obj.workItem,
    claimState: obj.claimState,
    takenBy: obj.takenBy,
    takenAt: obj.takenAt,
    expiresAt: obj.expiresAt,
    duplicates: obj.duplicates,
  };
}

/** PURE. The un-owned block for a key we could not resolve. */
export function unownedCell(eventKey: string): CellOwnership {
  return {
    eventKey,
    workItem: null,
    claimState: 'no-object',
    takenBy: null,
    takenAt: null,
    expiresAt: null,
    duplicates: [],
  };
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
  opts: { harness?: string; findConditionObjects?: typeof findConditionObjects } = {},
): Promise<CellOwnership> {
  const harness = opts.harness?.trim() || operatorHomeHarnessSlug();
  const eventKey = gateStallConditionKey(harness);
  try {
    const find = opts.findConditionObjects ?? findConditionObjects;
    const found = await find([eventKey], { harnessSlug: harness });
    const obj = found.get(eventKey);
    return obj ? toCellOwnership(obj) : unownedCell(eventKey);
  } catch {
    return unownedCell(eventKey);
  }
}
