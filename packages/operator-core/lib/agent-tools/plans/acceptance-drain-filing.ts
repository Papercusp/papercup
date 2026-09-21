/**
 * The one place an ACCEPTANCE-DRAIN work item is written — P-020 of
 * design-to-code-coverage-seam-2026-09-02 (D-032).
 *
 * # The defect this closes
 *
 * Entry into `awaiting-acceptance` is AUTOMATED and exit is not, so the state
 * accumulates monotonically:
 *
 *   - `plan-drain-rule.ts` (reaction) and `plan-drain-sweep.ts` (backstop) flip a
 *     plan to `awaiting-acceptance` the moment its last item goes terminal.
 *   - `applyPlanDrainTransition` performs a bare frontmatter flip and nothing
 *     else. Its own header says "Whether the rubric has been authored yet is the
 *     next ACTION, not a different state" — and nothing anywhere takes that next
 *     action, files it, or tells a soul.
 *   - Exit is a seven-step ceremony whose refusals are only ever seen by someone
 *     who explicitly attempts a ship or asks `plans:get { shipReadiness }`.
 *
 * Measured over ALL 187 awaiting-acceptance papercusp plans (D-032, full census
 * via the same evaluator `plans:set-plan-status` enforces): 161 (86.1%) have
 * never had `plans:audit` run even once, and the oldest has been sitting since
 * 2026-06-04. That population does not shrink on its own, for exactly the reason
 * `plan-drain-sweep.ts` gives about its own backlog: nothing will ever re-examine
 * it, because the event that would have is already in the past.
 *
 * # Why this files work instead of notifying an author
 *
 * `spec-triad-sweep.ts` states the standing design mandate this obeys, verbatim:
 * "a design that routes a decision to a person is a defect. Nothing here
 * escalates, notifies a human, or waits for approval — it files claimable work."
 * Notifying each plan's author would ALSO be the wrong instrument on the facts:
 * these plans' authors are overwhelmingly ended sessions, so a notify is a
 * message to nobody, while a claimable item can be drained by any agent.
 *
 * # Why the body carries the gate's OWN message
 *
 * `evaluatePlanAcceptanceGate` already writes a precise, actionable repair into
 * every refusal — `acceptance_unaudited` names the literal
 * `plans:audit { slug, items:[{ itemId, verdict, citations }] }` call to make.
 * That instruction has always existed and has simply never been DELIVERED to
 * anyone. So this filer quotes the live verdict rather than restating it: a
 * second copy of the repair text would drift from the gate that enforces it,
 * which is the derived-truth ladder's whole point.
 *
 * The dedupe key is `payload.acceptanceDrainPlan` — the plan's fully-qualified
 * `workspace/harness/slug` ref, for the same reason spec-triad uses one: two
 * tenants can hold a plan of the same name, and suppressing one tenant's filing
 * because another has one open would strand a lane with no way to notice.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';
import { agentObligationSourceGeneration } from '../../agent-obligations';
import {
  upsertConditionWorkItem,
  upsertConditionWorkItemInTransaction,
} from '../../coord/condition-upsert';

/**
 * Work-item statuses that mean an existing filing is still outstanding.
 *
 * Kept identical to `SPEC_TRIAD_NON_TERMINAL_STATUSES` rather than imported from
 * it: the two sweeps file against different gates and must be able to diverge
 * without one silently redefining the other's idea of "still open".
 */
export const ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES = [
  'open',
  'todo',
  'wip',
  'in_progress',
  'blocked',
  'needs-human',
  'validating',
  'failing',
];

export interface AcceptanceDrainFilingInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** The gate's first refusal code, e.g. `acceptance_unaudited`. Null is an
   * unknown/read failure and must never be turned into a fabricated blocker. */
  code: string | null;
  /** The gate's own refusal message — quoted, never paraphrased. */
  message: string;
  /** Full canonical gate observation, when the caller has one. */
  observation?: AcceptanceDrainGateObservation;
  /** Observation clock. Tests may pin it; production defaults to now. */
  observedAt?: Date;
}

export type AcceptanceDrainFilingOutcome = 'created' | 'already-open' | 'unknown' | 'error';

export interface AcceptanceDrainFilingResult {
  outcome: AcceptanceDrainFilingOutcome;
  id: string | null;
  ref: string;
  error?: string;
}

export const ACCEPTANCE_DRAIN_AGE_WARN_AFTER_MS = 2 * 60 * 60 * 1000;
export const ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS = 12 * 60 * 60 * 1000;

export type AcceptanceDrainGateObservation = {
  satisfied: boolean;
  code?: string;
  message?: string;
  buildProvenance?: unknown;
  repairAction?: unknown;
  acceptanceBarLifecycle?: unknown;
  gradingRef?: string;
  rubricId?: string;
  gradedBy?: string | null;
};

export type AcceptanceDrainObservationState = 'pending' | 'blocked' | 'unknown' | 'ready';

export interface AcceptanceDrainObservationSignals {
  gateObservation: AcceptanceDrainObservationState;
  blockerCode: string | null;
  sourceGeneration: string | null;
  evidenceRef: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  ageMs: number;
  ageBand: 'fresh' | 'aging' | 'overdue';
  escalation: 'none' | 'due';
}

function isoNow(value?: Date): string {
  return (value ?? new Date()).toISOString();
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Pure, durable projection used by both the SQL writer and tests. */
export function acceptanceDrainObservationSignals(
  observation: AcceptanceDrainGateObservation | undefined,
  existingPayload: Record<string, unknown> | null | undefined,
  observedAt = new Date(),
  planSlug?: string,
): AcceptanceDrainObservationSignals {
  const now = isoNow(observedAt);
  const state: AcceptanceDrainObservationState = observation == null
    ? ((existingPayload?.gateObservation as AcceptanceDrainObservationState | undefined) ?? 'pending')
    : observation.satisfied ? 'ready' : observation.code ? 'blocked' : 'unknown';
  const sourceGeneration = observation == null
    ? (typeof existingPayload?.sourceGeneration === 'string' ? existingPayload.sourceGeneration : null)
    : agentObligationSourceGeneration({ planSlug, gate: observation });
  const sameGeneration = sourceGeneration !== null && sourceGeneration === existingPayload?.sourceGeneration;
  const firstObservedAt = sameGeneration && validIso(existingPayload?.firstObservedAt)
    ? existingPayload.firstObservedAt
    : now;
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(firstObservedAt));
  return {
    gateObservation: state,
    blockerCode: observation && !observation.satisfied ? (observation.code ?? null) : null,
    sourceGeneration,
    evidenceRef: sourceGeneration && planSlug ? `plan-acceptance:${planSlug}:${sourceGeneration}` : null,
    firstObservedAt,
    lastObservedAt: now,
    ageMs,
    ageBand: ageMs >= ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS ? 'overdue' : ageMs >= ACCEPTANCE_DRAIN_AGE_WARN_AFTER_MS ? 'aging' : 'fresh',
    escalation: ageMs >= ACCEPTANCE_DRAIN_ESCALATE_AFTER_MS ? 'due' : 'none',
  };
}

export function acceptanceDrainPlanRef(i: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): string {
  return `${i.workspaceId}/${i.harnessSlug}/${i.planSlug}`;
}

/**
 * The item body. Extracted so every caller says exactly the same thing.
 *
 * `message` is the gate's live text and is quoted whole. The surrounding prose
 * says only what the gate does NOT say: which state the plan is in, that the
 * refusal short-circuits (so clearing this code can reveal another), and that
 * dropping the plan is a legitimate resolution.
 */
export function acceptanceDrainFilingBody(
  planSlug: string,
  code: string,
  message: string,
): string {
  return (
    `Plan \`${planSlug}\` is sitting in \`awaiting-acceptance\` — its items are all terminal, ` +
    `so the implementation is done, but the plan is NOT shipped and nothing is moving it.\n\n` +
    `**Its first ship-gate blocker right now is \`${code}\`.**\n\n` +
    `The gate's own instruction, quoted verbatim from \`evaluatePlanAcceptanceGate\`:\n\n` +
    `> ${message}\n\n` +
    `**Read this before starting:** the gate SHORT-CIRCUITS on its first refusal, so clearing ` +
    `\`${code}\` can reveal another behind it. Re-read \`plans:get { slug:'${planSlug}', ` +
    `shipReadiness: true }\` after each step rather than assuming this is the only thing owed. ` +
    `The code-truth family (items finished → audit → citations → requirements) is checked ` +
    `ENTIRELY BEFORE the rubric family, so do not author a rubric first — on a plan that owes ` +
    `an audit it moves the gate by exactly zero (D-032).\n\n` +
    `**You do not have to be the plan's original author.** A code-truth audit compares each ` +
    `item to the ACTUAL CODE — not the plan text, not the work-item records, not anyone's ` +
    `memory of writing it — so it is performable by whoever picks this up. Citations are ` +
    `re-resolved against the real tree, so a path that does not exist is refused.\n\n` +
    `**If this plan should not ship at all**, that is a legitimate resolution and not a ` +
    `failure: supersede or archive it, or drop its residual items with a reason, and close ` +
    `this item with that as the completion evidence. What is not acceptable is leaving it ` +
    `where it is — the backlog's oldest entry has been in this state since 2026-06-04.`
  );
}

export function acceptanceDrainCarryBody(planSlug: string): string {
  return (
    `Plan \`${planSlug}\` has entered \`awaiting-acceptance\`: implementation is terminal, ` +
    `but shipment still requires the canonical acceptance gate. The gate observation is ` +
    `pending; re-read \`plans:get { slug:'${planSlug}', shipReadiness: true }\` and continue ` +
    `the acceptance ceremony. This item owns the handoff and remains open until the plan ` +
    `ships or reaches an explicit terminal not-to-ship disposition.`
  );
}

function observationTitle(planSlug: string, signals: AcceptanceDrainObservationSignals): string {
  if (signals.gateObservation === 'ready') return `Ship plan '${planSlug}' — acceptance gate ready`;
  if (signals.gateObservation === 'unknown') return `Inspect plan '${planSlug}' — acceptance gate unreadable`;
  if (signals.gateObservation === 'pending') return `Carry plan '${planSlug}' through acceptance/shipment`;
  return `Unstick plan '${planSlug}' from awaiting-acceptance — blocked on ${signals.blockerCode ?? 'unknown'}`;
}

function observationSummary(planSlug: string, code: string | null, message: string, signals: AcceptanceDrainObservationSignals): string {
  const age = `Observation age: ${signals.ageMs}ms (${signals.ageBand}); escalation: ${signals.escalation}.`;
  if (signals.gateObservation === 'ready') {
    return `Plan '${planSlug}' has a fresh acceptance-ready gate observation. ` +
      `Run plans:set-plan-status { slug:'${planSlug}', status:'shipped', expectedCurrent:'awaiting-acceptance' }. ${age}`;
  }
  if (signals.gateObservation === 'unknown') {
    return `The canonical acceptance gate for plan '${planSlug}' was unreadable or returned no refusal code; retry the scoped gate read. ${age}`;
  }
  if (signals.gateObservation === 'pending') return `${acceptanceDrainCarryBody(planSlug)} ${age}`;
  return `${acceptanceDrainFilingBody(planSlug, code ?? 'unknown', message)}\n\n${age}`;
}

/**
 * Commit the acceptance accountability handoff in the SAME transaction as the
 * plan's transition into `awaiting-acceptance`. This is a pending observation,
 * not a fabricated gate refusal; the next sweep refreshes the same keyed row
 * with canonical refusal/evidence or observes readiness.
 */
export async function ensureAcceptanceDrainCarryInTransaction(
  tx: TransactionSql,
  input: Pick<AcceptanceDrainFilingInput, 'workspaceId' | 'harnessSlug' | 'planSlug'> & {
    accountableOwnerId?: string | null;
  },
): Promise<AcceptanceDrainFilingResult & { outcome: 'created' | 'already-open' }> {
  const ref = acceptanceDrainPlanRef(input);
  // Reuse pre-key filers too. This predicate is the existing payload identity;
  // locking the row prevents a concurrent claim from being overwritten.
  const open = await tx<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND payload->>'acceptanceDrainPlan' = ${ref}
       AND status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
     ORDER BY created_ts, feature_id
     LIMIT 1 FOR UPDATE
  `;
  if (open[0]) {
    if (input.accountableOwnerId) {
      await tx`
        UPDATE harness_shared.work_items
           SET taken_by = ${input.accountableOwnerId}, taken_at = clock_timestamp(),
               expires_at = clock_timestamp() + INTERVAL '7 days'
         WHERE workspace_id = ${input.workspaceId}
           AND harness_slug = ${open[0].harness_slug}
           AND feature_id = ${open[0].feature_id} AND taken_by IS NULL
      `;
    }
    return { outcome: 'already-open', id: open[0].feature_id, ref };
  }
  const res = await upsertConditionWorkItemInTransaction(
    tx,
    `acceptance-drain:${input.harnessSlug}/${input.planSlug}`,
    {
      kind: 'task',
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
      createdBy: 'system:acceptance-drain',
      assignee: input.accountableOwnerId ?? undefined,
      title: `Carry plan '${input.planSlug}' through acceptance/shipment`,
      summary: acceptanceDrainCarryBody(input.planSlug),
      payload: {
        acceptanceDrainPlan: ref,
        planSlug: input.planSlug,
        ...acceptanceDrainObservationSignals(undefined, null, new Date(), input.planSlug),
      },
    },
  );
  return {
    outcome: res.created ? 'created' : 'already-open',
    id: res.id,
    ref,
  };
}

/**
 * File the acceptance-drain work item for a plan, unless one is already open.
 *
 * Never throws. The caller is a periodic sweep, and a DBOS step that throws is
 * marked permanently dead — i.e. one transient PG error would stop this sweep
 * FOREVER, silently, which is the same shape of invisible stall the sweep exists
 * to fix. A failure is returned, logged by the caller, and retried next pass.
 */
export async function ensureAcceptanceDrainFiling(
  input: AcceptanceDrainFilingInput,
): Promise<AcceptanceDrainFilingResult> {
  const ref = acceptanceDrainPlanRef(input);
  const observedAt = input.observedAt ?? new Date();
  const observation = input.observation ?? (input.code == null ? undefined : {
    satisfied: false,
    code: input.code,
    message: input.message,
  });
  try {
    const { sql } = getOrgPg();
    // Payload fast-path, mirroring spec-triad-filing: adopt an existing open
    // filing rather than letting a keyed sibling join it. Cheap, and it also
    // covers any row filed before this condition key existed.
    const open = (await sql`
      SELECT feature_id, harness_slug, payload, payload->>'gateObservation' AS gate_observation
        FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId}
         AND payload->>'acceptanceDrainPlan' = ${ref}
         AND status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
       LIMIT 1
    `) as unknown as Array<{ feature_id: string; harness_slug: string; payload?: Record<string, unknown> | null; gate_observation?: string | null }>;
    if (open.length > 0) {
      const incumbent = open[0]!;
      const signals = acceptanceDrainObservationSignals(observation, incumbent.payload, observedAt, input.planSlug);
      const patch = {
        acceptanceDrainPlan: ref,
        planSlug: input.planSlug,
        ...signals,
        buildProvenance: observation?.buildProvenance ?? null,
        repairAction: observation?.repairAction ?? null,
        acceptanceBarLifecycle: observation?.acceptanceBarLifecycle ?? null,
        gradingRef: observation?.gradingRef ?? null,
        rubricId: observation?.rubricId ?? null,
        gradedBy: observation?.gradedBy ?? null,
      };
      {
        await sql`
          UPDATE harness_shared.work_items
             SET title = ${observationTitle(input.planSlug, signals)},
                 summary = ${observationSummary(input.planSlug, input.code, input.message, signals)},
                 updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
                 payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
           WHERE feature_id = ${incumbent.feature_id}
             AND workspace_id = ${input.workspaceId}
             AND harness_slug = ${incumbent.harness_slug}
             AND status = ANY(${ACCEPTANCE_DRAIN_NON_TERMINAL_STATUSES})
        `;
      }
      return {
        outcome: 'already-open',
        id: incumbent.feature_id,
        ref,
      };
    }

    // A gate/read failure must not create a blocker with an invented code. The
    // next sweep retries; only a known refusal is claimable new work.
    if (input.code == null && observation?.satisfied !== true) {
      return { outcome: 'unknown', id: null, ref };
    }

    // The read above is check-then-act and therefore RACED; the upsert claims the
    // unique condition-key index so a concurrent double-file resolves to ONE open
    // item regardless of timing (the failure WI-39594 recorded for spec-triad,
    // which filed 11 exact-title pairs before it was keyed). The key embeds
    // harness + plan, which is workspace-unique by construction.
    const res = await upsertConditionWorkItem(
      `acceptance-drain:${input.harnessSlug}/${input.planSlug}`,
      {
        kind: 'task',
        harness: input.harnessSlug,
        workspaceId: input.workspaceId,
        createdBy: 'system:acceptance-drain',
        title: observationTitle(input.planSlug, acceptanceDrainObservationSignals(observation, null, observedAt, input.planSlug)),
        summary: observationSummary(input.planSlug, input.code, input.message, acceptanceDrainObservationSignals(observation, null, observedAt, input.planSlug)),
        payload: {
          acceptanceDrainPlan: ref,
          planSlug: input.planSlug,
          ...acceptanceDrainObservationSignals(observation, null, observedAt, input.planSlug),
          buildProvenance: observation?.buildProvenance ?? null,
          repairAction: observation?.repairAction ?? null,
          acceptanceBarLifecycle: observation?.acceptanceBarLifecycle ?? null,
          gradingRef: observation?.gradingRef ?? null,
          rubricId: observation?.rubricId ?? null,
          gradedBy: observation?.gradedBy ?? null,
        },
      },
    );
    return res.created
      ? { outcome: 'created', id: res.id, ref }
      : { outcome: 'already-open', id: res.id, ref };
  } catch (err) {
    return { outcome: 'error', id: null, ref, error: (err as Error).message };
  }
}
