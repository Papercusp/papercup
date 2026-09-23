/**
 * plan-scope-cascade.ts — propagate a plan SCOPE write to the work it made moot
 * (review-system-rework-reduction-2026-09-23 P-030, unified with P-031 by D-005).
 *
 * WHY. Measured by the fifth audit (D-004): 3,474 tool calls — 29% of
 * ship-main-greening-program-2026-09-15 — went to three "Ship <slug>" carrier items that
 * were later dropped as moot after D-019 superseded their subject plans. P-022 alone drew
 * 1,840 calls on 09-21/22, two days AFTER its subject plan was superseded on 09-19.
 * Nothing connected the write that superseded a plan to the items in OTHER plans whose
 * whole deliverable was shipping that plan, so they stayed claimable and kept pulling
 * agents in. Readiness had the same gap: the carrier plan's acceptance/BAR verdict was only
 * recomputed when somebody happened to ask.
 *
 * WHAT. Called by the write that supersedes a plan (plans:set-plan-status → superseded,
 * which is also how a consolidation retires the plans it absorbs):
 *   1. DETECT carriers: non-terminal, non-observation work items in ANOTHER plan whose title
 *      names shipping / accepting / carrying / grading the superseded plan (whole-slug
 *      token, verb before it — `isMootCarrierTitle`).
 *   2. PARK each one durably out of claim_next / scheduler self-select (the existing
 *      `_claimHold` durable park — NOT a drop: dropping stays a recorded Decision on the
 *      carrier plan). Its typed release contract is keyed to the carrier plan's
 *      acceptance-changed event, so the next re-scope of that plan is the re-evaluation cue.
 *   3. NOTIFY the carrier's live holder, if any.
 *   4. RE-EVALUATE each carrier plan's acceptance/BAR readiness and SURFACE it where readers
 *      look: a prepend-only, idempotent stamp in the carrier plan's `## Now` (the repair
 *      obligation, with the gate's blocking code) and a `now_updated` plan event, which
 *      rides orient's plan-events delta. `now_updated` is deliberately NOT an
 *      acceptance-changing event, so the cascade can never fire its own release trigger.
 *
 * Every step after detection is best-effort PER CARRIER: a failure is reported in the
 * result and never thrown into the plan write that triggered it.
 */

import { parsePlan } from './parser';
import { replaceNowBlock } from './set-now';

/** Sentinel for the carrier-plan Now stamp. Keyed per subject so a re-run is a no-op. */
export const MOOT_CARRIER_NOW_MARK = '⚠ MOOT CARRIER PARKED';

export type PlanScopeWriteCause = 'superseded';

/** Verbs that make an item a CARRIER of another plan (its deliverable is that plan). */
const CARRIER_VERB_RE =
  /\b(?:ship|ships|shipped|shipping|carry|carries|carried|carrying|accept|accepts|accepted|acceptance|grade|grades|graded|grading|land|lands|landing)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `title` a carrier of `subjectSlug`? The slug must appear as a WHOLE token (a slug is
 * `[a-z0-9-]`, so a longer sibling slug sharing a prefix never matches) and a carrier verb
 * must precede it. The verb is only searched BEFORE the slug, so a slug that itself contains
 * a verb (`ship-main-greening-…`) cannot satisfy the check on its own.
 */
export function isMootCarrierTitle(title: string, subjectSlug: string): boolean {
  const slug = subjectSlug.trim();
  if (!slug || !title) return false;
  const tokenRe = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(slug)}(?=$|[^A-Za-z0-9-])`, 'i');
  const match = tokenRe.exec(title);
  if (!match) return false;
  const slugAt = match.index + match[1]!.length;
  return CARRIER_VERB_RE.test(title.slice(0, slugAt));
}

export interface CarrierCandidate {
  featureId: string;
  workspaceId: string;
  harnessSlug: string | null;
  /** The plan the carrier lives in (never the superseded subject). */
  sourcePlanSlug: string;
  sourcePlanItemIds: string[];
  title: string;
  status: string;
  takenBy: string | null;
  payload: unknown;
}

export interface GateReading {
  satisfied: boolean | null;
  code: string | null;
  error?: string;
}

export interface MootCarrierStamp {
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  /** Rendered carrier refs, e.g. `WI-10001493 (P-022)`. */
  carriers: string[];
  gate: GateReading | null;
  today?: Date;
}

function gateText(gate: GateReading | null): string {
  if (!gate || gate.satisfied === null) return `not measured${gate?.error ? ` (${gate.error})` : ''}`;
  return gate.satisfied ? 'acceptance gate satisfied' : `acceptance gate BLOCKED: ${gate.code ?? 'unknown code'}`;
}

/** Where the first `**State:**` / `**Next:**` marker begins, or -1. */
const FIRST_MARKER_RE = /\*\*(?:State|Next):\*\*/i;

/**
 * Return the carrier plan's body with a repair banner prepended to its `## Now`, or `null`
 * when there is nothing to do (no Now block — never invent one; or this subject's banner is
 * already present). Pure. Prepend-only: the author's State/Next survive verbatim beneath it.
 */
export function stampMootCarrierNowBlock(body: string, stamp: MootCarrierStamp): string | null {
  if (stamp.carriers.length === 0) return null;
  const now = parsePlan(body).now;
  if (!now) return null;
  const key = `${MOOT_CARRIER_NOW_MARK}: ${stamp.subjectSlug}`;
  if (now.raw.includes(key)) return null;

  const iso = (stamp.today ?? new Date()).toISOString().slice(0, 10);
  const list = stamp.carriers.join(', ');
  const plural = stamp.carriers.length > 1;
  const banner =
    `${key} (${iso}) — plan ${stamp.subjectSlug} was ${stamp.cause}, so ${list} ${plural ? 'are' : 'is'} moot ` +
    `and ${plural ? 'were' : 'was'} parked out of claim_next (parked, not dropped). BAR readiness re-evaluated ` +
    `in the same write: ${gateText(stamp.gate)}. (stamped by plans:set-plan-status, P-030)`;
  const repair =
    `Repair the moot carrier${plural ? 's' : ''} ${list}: record a Decision that re-scopes or drops ` +
    `${plural ? 'them' : 'it'} (plan ${stamp.subjectSlug} was ${stamp.cause}).`;

  const markerAt = now.raw.search(FIRST_MARKER_RE);
  const preamble = markerAt > 0 ? now.raw.slice(0, markerAt).trim() : '';
  const freeProse = !now.state && !now.next ? now.raw.trim() : '';
  const state = [banner, preamble, now.state, freeProse].filter(Boolean).join('\n\n');
  const next = now.next ? `${repair} Then: ${now.next}` : repair;
  return replaceNowBlock(body, state, next);
}

export interface PlanScopeCascadeInput {
  workspaceId: string;
  harnessSlug: string | null;
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  /** Who made the scope write (park provenance, notify sender). */
  actor: string;
}

export interface PlanScopeCascadeDeps {
  listCandidates(input: { workspaceId: string; subjectSlug: string }): Promise<CarrierCandidate[]>;
  isParked(payload: unknown): boolean;
  park(
    carrier: CarrierCandidate,
    park: { reason: string; condition: string; trigger: string; owner: string },
  ): Promise<boolean>;
  notifyHolder(carrier: CarrierCandidate, summary: string): Promise<void>;
  evaluateGate(planSlug: string, harnessSlug: string | null): Promise<GateReading>;
  stampNow(
    planSlug: string,
    scope: { workspaceId: string; harnessSlug: string | null },
    stamp: MootCarrierStamp,
  ): Promise<boolean>;
  emitPlanEvent(planSlug: string, detail: string): Promise<void>;
  /** The release trigger for a park on a carrier in `carrierPlanSlug`. */
  releaseTrigger(carrierPlanSlug: string): string;
}

export interface PlanScopeCascadeCarrierResult {
  id: string;
  plan: string;
  items: string[];
  parked: boolean;
  alreadyParked: boolean;
  holderNotified: boolean;
  error?: string;
}

export interface PlanScopeCascadePlanResult {
  slug: string;
  gate: GateReading;
  nowStamped: boolean;
  eventEmitted: boolean;
  error?: string;
}

export interface PlanScopeCascadeResult {
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  carriers: PlanScopeCascadeCarrierResult[];
  carrierPlans: PlanScopeCascadePlanResult[];
  /** Detection itself failed — nothing was parked and nothing was measured. */
  error?: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function carrierRef(c: CarrierCandidate): string {
  return c.sourcePlanItemIds.length > 0 ? `${c.featureId} (${c.sourcePlanItemIds.join(', ')})` : c.featureId;
}

/**
 * Run the cascade for one scope write. Never throws: detection failure is returned as
 * `error`, per-carrier and per-plan failures ride their own rows.
 */
export async function propagatePlanScopeWrite(
  input: PlanScopeCascadeInput,
  deps: PlanScopeCascadeDeps,
): Promise<PlanScopeCascadeResult> {
  const result: PlanScopeCascadeResult = {
    subjectSlug: input.subjectSlug,
    cause: input.cause,
    carriers: [],
    carrierPlans: [],
  };

  let candidates: CarrierCandidate[];
  try {
    candidates = await deps.listCandidates({ workspaceId: input.workspaceId, subjectSlug: input.subjectSlug });
  } catch (err) {
    return { ...result, error: `carrier detection failed: ${errText(err)}` };
  }
  const carriers = candidates.filter(
    (c) => c.sourcePlanSlug !== input.subjectSlug && isMootCarrierTitle(c.title, input.subjectSlug),
  );

  const byPlan = new Map<string, { harnessSlug: string | null; workspaceId: string; refs: string[] }>();
  for (const carrier of carriers) {
    const row: PlanScopeCascadeCarrierResult = {
      id: carrier.featureId,
      plan: carrier.sourcePlanSlug,
      items: carrier.sourcePlanItemIds,
      parked: false,
      alreadyParked: deps.isParked(carrier.payload),
      holderNotified: false,
    };
    result.carriers.push(row);
    const group = byPlan.get(carrier.sourcePlanSlug) ?? {
      harnessSlug: carrier.harnessSlug,
      workspaceId: carrier.workspaceId,
      refs: [],
    };
    group.refs.push(carrierRef(carrier));
    byPlan.set(carrier.sourcePlanSlug, group);
    if (row.alreadyParked) continue;

    const reason =
      `moot: its subject plan ${input.subjectSlug} was ${input.cause} — parked out of claim_next by the ` +
      `plan supersede cascade (P-030). Parked, not dropped: re-scope or drop it with a Decision on ` +
      `${carrier.sourcePlanSlug}.`;
    try {
      row.parked = await deps.park(carrier, {
        reason,
        condition: `plan ${carrier.sourcePlanSlug} records a Decision that re-scopes or drops ${carrier.featureId}`,
        trigger: deps.releaseTrigger(carrier.sourcePlanSlug),
        owner: carrier.takenBy?.trim() || input.actor,
      });
    } catch (err) {
      row.error = `park failed: ${errText(err)}`;
      continue;
    }
    const holder = carrier.takenBy?.trim();
    if (row.parked && holder) {
      try {
        await deps.notifyHolder(
          carrier,
          `${carrier.featureId} is moot: plan ${input.subjectSlug} was ${input.cause}. It is parked out of ` +
            `claim_next (not dropped); re-scope or drop it with a Decision on ${carrier.sourcePlanSlug}.`,
        );
        row.holderNotified = true;
      } catch {
        /* best-effort: the Now stamp and plan event still carry the obligation */
      }
    }
  }

  for (const [slug, group] of byPlan) {
    const planRow: PlanScopeCascadePlanResult = {
      slug,
      gate: { satisfied: null, code: null },
      nowStamped: false,
      eventEmitted: false,
    };
    result.carrierPlans.push(planRow);
    try {
      planRow.gate = await deps.evaluateGate(slug, group.harnessSlug);
    } catch (err) {
      planRow.gate = { satisfied: null, code: null, error: errText(err) };
    }
    const stamp: MootCarrierStamp = {
      subjectSlug: input.subjectSlug,
      cause: input.cause,
      carriers: group.refs,
      gate: planRow.gate,
    };
    try {
      planRow.nowStamped = await deps.stampNow(
        slug,
        { workspaceId: group.workspaceId, harnessSlug: group.harnessSlug },
        stamp,
      );
    } catch (err) {
      planRow.error = `Now stamp failed: ${errText(err)}`;
    }
    try {
      await deps.emitPlanEvent(
        slug,
        `moot carrier(s) ${group.refs.join(', ')} parked: plan ${input.subjectSlug} ${input.cause}; ` +
          `repair = a Decision that re-scopes or drops them; ${gateText(planRow.gate)}`,
      );
      planRow.eventEmitted = true;
    } catch {
      /* best-effort: observability, not state */
    }
  }
  return result;
}
