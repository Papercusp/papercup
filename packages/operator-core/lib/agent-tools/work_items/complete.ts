/**
 * work_items:complete — the STRUCTURED completion op
 * (coord-lifecycle-automation-2026-06-04 D-004, "stop narrating, emit structure").
 *
 * The single biggest token + signal win of the plan: instead of finishing a
 * unit of work and hand-writing a prose `coord:send`
 *   "F-12 BUILT+TESTED, migration 137, 40 tests, deferred X/Y…",
 * an agent calls `work_items:complete { id, completion: {…structured fields…} }`.
 * The completion event (D-002 `emits` on this tool) renders the coord
 * notification from the structured record via the pure render layer and fires
 * `coord:emit` — the agent spends zero tokens narrating, and NOTHING is lost
 * (the deferred-set especially is carried structurally, D-006).
 *
 * State transition is OPTIONAL + explicit (`state`) so this never silently
 * steps on the validator/reviewer pipeline's own status semantics — pass it to
 * also move the item to a terminal state, omit it to record+emit only.
 *
 * The `emits` rule is registered separately (../../coord-lifecycle/lifecycle-rules)
 * so the render-layer import stays out of the hot tool dispatch path; it fires
 * on `work_items:complete` and reads `result.completion`.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): complete ONE inline
 * ({ id, completion }) or MANY (items:[{ id, completion, state?, harness? }]) →
 * { ok, results:[{ ok, id, workItem, completion, reflect, stateError? } | { ok:false,
 * id, error }], counts }. Each completion record is per-item (there is no shared-
 * record homogeneous form). The completion emit + plan-item reflect fire per item
 * (D-007), so a bulk complete broadcasts N completion notifications, one per item.
 */

import { z } from 'zod';
import {
  assumptionsArg,
  hasAssumptionDeclaration,
  resolveDeclaredAssumptions,
  ASSUMPTIONS_REQUIRED_MESSAGE,
} from './_assumptions';
import { nonAssumptionKindAdvisory } from '../../agent-facts/assumptions';
import type { StoredAssumptionDeclaration } from '../../coord-lifecycle/records';
import { defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import { objectSelector } from '../coordination/audience';
// Imported from the LEAF module, not from '../../work-items': this file's unit tests
// mock that module wholesale, which would make the guard `undefined` exactly here.
import { harnessScopeMismatch } from '../../work-items-harness-scope';
import {
  getWorkItem,
  setWorkItemStateWithAliasInfo,
  workItemObjectRef,
  mergeWorkItemOutputPayload,
  resolveWorkItemRef,
  linkWorkItem,
  subscribeWorkItem,
  SETTLED_WORK_ITEM_STATES,
  type TerminalCompletionConflict,
} from '../../work-items';
import {
  CompletionRecordSchema,
  stripNulBytesDeep,
  type CompletionRecord,
  type CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';
import { isBackedLiveDroveUiClaim, verifyLiveDroveUiArtifacts } from '../../completion-audit';
import { authorityForCompletion, countsTowardBurnDown } from '../../work-item-completion-authority';
import { renderCompletion } from '../../coord-lifecycle/render';
import { renderReflectStep } from '../../harness/improvements/friction-markers';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { shapeWorkItemWriteEcho } from './write-echo-shape';
import { coerceCompletionShape, gatherFlatCompletion } from './completion-coerce';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../../workspace-registry';
import { itemTestGate } from '../../harness-test-gate';
import { FEATURE_TERMINAL_STATES, normalizeFeatureStateInput } from '../../work-item-dispatch-states';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { fireReactionInProcess } from '../../events';
import {
  isPlaneGapItem,
  preflightPlaneCloseLive,
  renderPlaneClosePreflightWarning,
} from '../../agent-plane-close-preflight';

// EI-7031: coerce common LLM mis-shapes (bare string, scalar↔array swaps, missing
// summary) to the CompletionRecord contract BEFORE validation — a finished
// completion is normalised, never hard-rejected+lost. Well-formed input is
// unchanged. Mirrors the `stringTolerantBool` z.preprocess pattern (plans/new.ts).
const completionSpec = z
  .preprocess(
    coerceCompletionShape,
    CompletionRecordSchema.extend({
      workItem: z.string().min(1).optional(),
      // EI-13687: internal marker set by coerceCompletionShape when the caller passed
      // `completion` as a bare (non-JSON) string — declared here so it survives the
      // schema's default field-stripping instead of vanishing before completeOne can
      // see it and warn loudly. Stripped from the record before it is used/returned.
      __shapeCoercedFrom: z.literal('bare-string').optional(),
    }),
  )
  .describe(
    // EI-13687: this is the shape a caller only discovers today by tripping the wrong-type
    // error once — state it up front. A bare string is ACCEPTED (never hard-rejected, EI-24)
    // but coerces to { summary: <string> } ONLY: testsRun/testResult/verifiedHow/addedTests/
    // filesChanged/whatLanded/deferred/migrations all come back EMPTY, silently. Pass an
    // object when you have any of those to report.
    "Structured completion record: { summary, testsRun?, testResult?, verifiedHow?: 'unit'|'integration'|'live-drove-ui'|'manual'|'already-passing', addedTests?: boolean, filesChanged?: string[], whatLanded?: string[], deferred?: string[], migrations?: string[], coordNotes? }. " +
      'A bare STRING is also accepted but is coerced to { summary: <string> } ONLY — every other field above comes back empty, not just unset. Pass the object form whenever you have tests/files/verification to report.',
  );

/**
 * EI-5269 / EI-18127483322976472: the canonical terminal states across BOTH families
 * (feature: passed/deprecated; issue: resolved/closed) — and, post work-item-status-full-unify
 * (2026-07-19), their UNIFIED representations (done/dropped) that the issue-family write path
 * (ISSUE_STATE_ALIASES) now actually persists (resolved→done, closed→dropped). A completion
 * that leaves the item in ANY other state has NOT closed it, so the row stays claimable +
 * reclaimable.
 *
 * MUST be sourced from work-items.ts's `SETTLED_WORK_ITEM_STATES` (the single source of
 * truth for "this work_item is done, one way or another") rather than a locally-duplicated
 * literal list: a stale local copy that omits 'done'/'dropped' is exactly what caused this
 * receipt to report "COMPLETION RECORDED, BUT ... DID NOT CLOSE" for a change/issue-family
 * completion that had, in fact, already landed terminal as 'done' — the pre-alias name list
 * disagreeing with the family's actual post-alias terminal representation.
 */
const TERMINAL_WORK_ITEM_STATES = new Set<string>(SETTLED_WORK_ITEM_STATES);

/**
 * WI-4529: states a caller passes MEANING "close this" — the true terminals PLUS the common
 * close-synonyms the alias layer silently downgrades for the issue family (which stores only
 * open|resolved|closed, so a `state:'done'` lands as 'open' — the caller said "done" and the
 * item stayed claimable).
 *
 * This set is what separates a FAILED CLOSE from an INTENTIONAL non-terminal park: passing
 * `needs_human` / `blocked` / `wip` and landing on 'open' is correct and stays ok:true (the
 * caller recorded a completion and deliberately left the item open). Passing a close-intent
 * state and NOT landing terminal is a failed close, and must report ok:false.
 */
const CLOSE_INTENT_STATES = new Set([...TERMINAL_WORK_ITEM_STATES, 'done', 'complete', 'completed', 'dropped']);

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  /** Optional terminal state to also set (e.g. 'passed'|'resolved'|'closed').
   *  Omit to record + emit the completion WITHOUT changing lifecycle state. */
  state: z.string().min(1).max(40).optional(),
  /** The structured completion record (D-004). `workItem` defaults to this item's `id`. */
  completion: completionSpec,
  /**
   * Optional kind-specific STRUCTURED OUTPUT the completion produced (domain-free).
   * Carried verbatim onto the completion result + the completion reaction event, so a
   * domain reaction rule can read the work's output WITHOUT a re-fetch. Example: an
   * analyst bee completing a `bet-analysis` item attaches its `Signal` here, and the
   * `oddsmith:bet-signal` reaction (decision-ledger/bet-signal-rule.ts) emits a
   * decision-ledger disposition from it. Stays out of the fixed `completion` record.
   */
  outputPayload: z.unknown().optional(),
  /**
   * P-017 (b) gate #2 / D-016 / D-050 — REQUIRED on every item.
   *
   * Unconditional here, unlike work_items:set_state (where only the TERMINAL branch
   * carries it): this tool ALWAYS writes the terminal completion record
   * (terminal_owner + terminalCompletionRef — which is why reopening one later needs
   * `force:true`), even on a call that deliberately omits `state` and so does not
   * flip lifecycle. The commitment is the completion record, not the state change.
   */
  assumptions: assumptionsArg,
});

type CompleteItem = z.infer<typeof itemSpec>;

/**
 * EI-10949 — does this completion prose name ANOTHER WORK-ITEM as a duplicate?
 *
 * The nudge exists for the WI-3646 failure: an item dup-closed 3× with the survivor named
 * only in prose ("dup of WI-3543"), so no scanner could follow the link. But the old test
 * was `/dup(licate)? of/` alone, which fires on any English sentence containing the phrase.
 * It fired on a completion that said a duplicated *type interface* had been removed — the
 * word "duplicate" was about CODE, not a work-item, and there was no duplicate item to link.
 *
 * A false positive here is not free, which is the assumption the old comment got wrong: this
 * warning shares a channel with real ones, and a heuristic that misfires on ordinary prose
 * teaches agents to skim past the channel entirely — including the time it is right. (Same
 * class as EI-10951: a derived claim asserted with more confidence than its evidence carries.)
 *
 * So require what the WI-3646 case actually had and ordinary prose does not: a work-item ID
 * near the phrase. "dup of WI-3543" still warns; "removed a duplicate of the SelectEntry
 * interface" no longer does.
 *
 * PURE — unit-tested without PG.
 */
export function mentionsWorkItemDuplicate(text: string): boolean {
  // "dup/dupe/duplicate(s) of" … then a work-item id within a short window (same clause).
  return /\b(?:is\s+a\s+)?dup(?:e|licate)?s?\s+of\b[^.\n;]{0,40}?\b(?:WI|EI|F)-\d+\b/i.test(text);
}

function completionEvidenceFromRecord(
  rec: Omit<CompletionRecord, 'workItem'> & { workItem?: string },
): CompletionVerificationEvidence | undefined {
  const nested = rec.verification ?? {};
  const filesChanged = rec.filesChanged ?? nested.filesChanged;
  const testsRun = rec.testsRun ?? nested.testsRun ?? rec.tests;
  const testResult = rec.testResult ?? nested.testResult;
  const verifiedHow = rec.verifiedHow ?? nested.verifiedHow;
  const addedTests = rec.addedTests ?? nested.addedTests;
  const evidence: CompletionVerificationEvidence = {};
  if (filesChanged?.length) evidence.filesChanged = filesChanged;
  if (testsRun?.trim()) evidence.testsRun = testsRun;
  if (testResult?.trim()) evidence.testResult = testResult;
  if (verifiedHow) evidence.verifiedHow = verifiedHow;
  if (addedTests !== undefined) evidence.addedTests = addedTests;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

interface FinishPlanStamp {
  plan_slug: string;
  item_id: string;
  harness_slug: string;
}

export interface FinishWorkReceipt {
  idempotent: true;
  complete: boolean;
  workItemState: string;
  completionEvidenceStored: boolean;
  checkpointCleared: boolean;
  planItem: 'not-linked' | 'done' | 'dropped' | 'failed';
  claimRelease: 'not-linked' | 'released-or-absent' | 'failed';
  errors?: string[];
}

function finishPlanStamp(workItem: Record<string, unknown>): FinishPlanStamp | null {
  const payload = workItem.payload as { plan_item?: Partial<FinishPlanStamp> } | null | undefined;
  const stamp = payload?.plan_item;
  if (!stamp?.plan_slug || !stamp.item_id || !stamp.harness_slug) return null;
  if (!/^P-\d{3,}$/.test(stamp.item_id)) return null;
  return stamp as FinishPlanStamp;
}

function reflectedTerminalStatus(state: string): 'done' | 'dropped' | null {
  if (state === 'passed' || state === 'resolved' || state === 'done') return 'done';
  if (state === 'deprecated' || state === 'closed' || state === 'dropped') return 'dropped';
  return null;
}

/**
 * Synchronously converge every mechanical finish leg before reporting success.
 * The operation is retry-safe: terminal state writes, plan status flips, claim
 * release, and checkpoint clear are all idempotent. This is a small finish saga
 * rather than a cross-store SQL transaction (plan docs are filesystem-canonical),
 * but it has atomic CALLER semantics: `complete:false` means do not walk away;
 * re-call the same completion and it resumes/converges the missing legs.
 */
export async function synchronizeFinishWork(
  opts: {
    id: string;
    workItem: Record<string, unknown>;
    completionEvidenceStored: boolean;
    ctx: UnifiedToolContext;
  },
  deps: {
    clearCheckpoint?: typeof setWorkItemCheckpoint;
    fire?: typeof fireReactionInProcess;
  } = {},
): Promise<FinishWorkReceipt> {
  const clearCheckpoint = deps.clearCheckpoint ?? setWorkItemCheckpoint;
  const fire = deps.fire ?? fireReactionInProcess;
  const state = String(opts.workItem.state ?? '').toLowerCase();
  const reflected = reflectedTerminalStatus(state);
  const stamp = finishPlanStamp(opts.workItem);
  const errors: string[] = [];

  let checkpointCleared = false;
  try {
    await clearCheckpoint(
      {
        harness: (opts.workItem.harness as string | null | undefined) ?? null,
        workItemId: opts.id,
        workspaceId: opts.ctx.workspaceId,
      },
      null,
    );
    checkpointCleared = true;
  } catch (error) {
    errors.push(`checkpoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let planItem: FinishWorkReceipt['planItem'] = 'not-linked';
  let claimRelease: FinishWorkReceipt['claimRelease'] = 'not-linked';
  if (stamp && reflected) {
    const statusResult = await fire({
      fire: 'plans:set-status',
      args: {
        harness: stamp.harness_slug,
        slug: stamp.plan_slug,
        item: stamp.item_id,
        status: reflected,
        note: `← ${opts.id} completed (${state})`,
      },
      parentCtx: opts.ctx,
      cause: {
        depth: 1,
        chain: ['work-items:finish'],
        ruleId: 'work-items:finish:plan-status',
        rootRunId: typeof opts.ctx.runId === 'string' ? opts.ctx.runId : null,
      },
    }).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (statusResult.ok) planItem = reflected;
    else {
      planItem = 'failed';
      errors.push(`plan-item status failed: ${statusResult.error ?? 'unknown error'}`);
    }

    const releaseResult = await fire({
      fire: 'plan_items:release',
      args: { harness: stamp.harness_slug, plan: stamp.plan_slug, item: stamp.item_id },
      parentCtx: opts.ctx,
      cause: {
        depth: 1,
        chain: ['work-items:finish'],
        ruleId: 'work-items:finish:claim-release',
        rootRunId: typeof opts.ctx.runId === 'string' ? opts.ctx.runId : null,
      },
    }).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (releaseResult.ok) claimRelease = 'released-or-absent';
    else {
      claimRelease = 'failed';
      errors.push(`claim release failed: ${releaseResult.error ?? 'unknown error'}`);
    }
  }

  const complete =
    Boolean(reflected) &&
    opts.completionEvidenceStored &&
    checkpointCleared &&
    planItem !== 'failed' &&
    claimRelease !== 'failed';
  return {
    idempotent: true,
    complete,
    workItemState: state,
    completionEvidenceStored: opts.completionEvidenceStored,
    checkpointCleared,
    planItem,
    claimRelease,
    ...(errors.length ? { errors } : {}),
  };
}

/** Complete ONE item — confirm it exists, optionally transition state (a failed
 *  state write NEVER loses the completion, EI-24), fill provenance defaults, and
 *  return the reflect step. Self-describes its id. */
async function completeOne(
  it: CompleteItem,
  ident: { ownerId: string; ownerLabel?: string },
  ctx: UnifiedToolContext,
): Promise<BulkItemResult> {
  // EI-13687: a bare-string `completion` was silently coerced to `{ summary }` —
  // every other field is necessarily empty (not merely "unset"). Pull the marker
  // off BEFORE anything downstream sees it (rendering, evidence extraction, the
  // broadcast record) — it is purely an internal signal for the warning below.
  const shapeCoercedFromBareString = (it.completion as { __shapeCoercedFrom?: string }).__shapeCoercedFrom === 'bare-string';
  if (shapeCoercedFromBareString) delete (it.completion as { __shapeCoercedFrom?: string }).__shapeCoercedFrom;

  // EI-18764241942332131: Postgres' jsonb text-input parser rejects a literal NUL
  // byte with the opaque "unsupported Unicode escape sequence" — a caller who quotes
  // raw source (e.g. evidence ABOUT a NUL byte, as the reporter did) into testResult/
  // testsRun/summary/etc previously got a completion record that was RECORDED, then a
  // terminal STATE WRITE that silently failed downstream in setWorkItemState's evidence
  // merge, well after this tool had already accepted the call. Sanitize HERE, at the
  // tool boundary, before evidence extraction / coord:emit rendering / anything else
  // touches the record — so the state write and the completion record can never
  // disagree about whether a NUL-bearing close landed (terminalPayloadMergeJson in
  // coord-lifecycle/records.ts also sanitizes defensively, for callers other than this
  // tool). The caller is told via `nulBytesStrippedWarning` below — this silently
  // rewrites their evidence, which is worth surfacing even though it never blocks
  // (EI-24 record-and-warn discipline).
  const { value: sanitizedCompletion, stripped: nulBytesStripped } = stripNulBytesDeep(it.completion);
  if (nulBytesStripped) it.completion = sanitizedCompletion;

  const existing = await getWorkItem(it.id, it.harness);
  if (!existing) return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  // EI-19313515375179600 (WI-6822 follow-up): `origin` can flip local→remote well after
  // creation (still-under-investigation federation/replay-provenance defect). Trusting it
  // ALONE strands the true author — check IDENTITY first: createdBy === the caller means
  // they genuinely ARE the authoring peer regardless of what `origin` currently reads. This
  // is only the early-exit guard; the actual base-table origin self-heal (required before the
  // trigger-guarded write below can succeed — see selfHealAuthorOriginIfStranded in
  // work-items.ts) happens inside setWorkItemStateWithAliasInfo → setWorkItemState, which this
  // function calls further down when `it.state` is set.
  const callerIsAuthor = !!existing.createdBy && existing.createdBy === ident.ownerId;
  if (it.state && existing.family === 'issue' && existing.origin === 'remote' && !callerIsAuthor) {
    return {
      ok: false,
      id: it.id,
      error:
        `work_item '${it.id}' is remote-authored and cannot be completed locally; ` +
        `its authoring peer must claim/resolve it, and this node will receive the terminal state through federation.`,
    };
  }

  // EI-7264: a fast multi-wake self-sustaining loop creates+completes its own tracking
  // task each wake, while PEER fleet members' work-item ids flow through the exact same
  // coord broadcast stream — nothing visually distinguishes "an id I just created" from
  // "an id a peer just mentioned". A near-miss: an agent skipped its own create step and
  // called complete on a peer's actively-held item, briefly flipping its state. WARN (never
  // block — this tool's whole contract is record-and-warn, EI-24) when the caller is not the
  // item's current assignee, so the caller catches a wrong-id grab before it lands elsewhere.
  const assigneeMismatchWarning =
    existing.assignee && existing.assignee !== ident.ownerId
      ? `completing ${it.id} but it is currently assigned to '${existing.assignee}', not you ('${ident.ownerId}') — ` +
        `if you grabbed this id from a peer's coord broadcast instead of your own claimed/created item, stop and ` +
        `re-check before this lands on someone else's active work.`
      : undefined;

  // EI-19393623437103599: the SIBLING of the assignee warning above, for the case that
  // slips past it. `getWorkItem` does NOT apply `harness` to the issue-family branch, so
  // naming a harness does not scope the lookup — a caller can ask for an item in one pot
  // and be handed a DIFFERENT pot's row of the same id, silently. `WI-<n>` ids make that
  // reachable in practice rather than theoretically: D-008 (migration 142) mints them from
  // a PER-DATABASE sequence starting at 1, so WI-1/WI-2/WI-3 exist in every long-lived
  // store and a fresh or recovered one mints exactly those first.
  //
  // Why the assignee warning above does not already cover it: that one keys on the item
  // being held by SOMEONE ELSE. The row this lands on is typically UNASSIGNED (a stale
  // plan-item task nobody holds), so it fires on neither leg. Observed 2026-08-03: an id
  // reported by `work_items:create` against a recovered store resolved to an unrelated
  // 2026-07-18 plan item here, and a terminal completion with `authority: committed` was
  // recorded onto it — forging evidence in a live two-machine federation experiment. The
  // ONLY thing that surfaced it was the echoed `title` happening to look unfamiliar.
  //
  // WARN rather than refuse, deliberately, on this tool's record-and-warn contract (EI-24,
  // as the assignee warning above): a cross-harness complete is not always wrong, and the
  // failure here was the ABSENCE of any signal, not the absence of a block. Naming both
  // harnesses plus the row's title and age is what makes a wrong-id grab self-evident.
  const harnessMismatch = harnessScopeMismatch(existing, it.harness);
  const harnessMismatchWarning = harnessMismatch
    ? `completing '${it.id}' under harness '${harnessMismatch.requested}', but the row that ` +
      `resolved belongs to harness '${harnessMismatch.resolved}' — titled "${existing.title}"` +
      (existing.createdAt ? `, created ${new Date(existing.createdAt).toISOString()}` : '') +
      (existing.createdBy ? ` by '${existing.createdBy}'` : '') +
      `. A bare WI-<n> id is NOT globally unique (it comes from a per-database sequence that ` +
      `starts at 1), so an id minted in one store can resolve to a completely different item ` +
      `in another. If that title is not the work you meant to complete, STOP — you are about ` +
      `to record a completion on someone else's item.`
    : undefined;

  // TEST-COMPLETION GATE (enforce-system-on-generic-work-2026-06-29 P-006). A feature
  // work-item being moved to a TERMINAL state must have every plan-derived test-requiring
  // VAL passing. Flag-gated (FLAGS.TEST_COMPLETION_GATE, default OFF → inert) and FAIL-OPEN
  // (itemTestGate returns ok:true on any error, never blocking a completion on a gate bug).
  // On refusal we return the SAME shape as the not-found case (ok:false + error, NO completion
  // record) so the completion emit rule — which keys on result.completion — fires no false
  // completion notification.
  if (it.state && existing.family === 'feature' && existing.harness) {
    const norm = normalizeFeatureStateInput(it.state);
    const isTerminal = norm.ok && FEATURE_TERMINAL_STATES.includes(norm.state);
    if (isTerminal && (await getFlag(FLAGS.TEST_COMPLETION_GATE, activeWorkspaceId()).catch(() => false))) {
      const gate = await itemTestGate(existing.harness, it.id);
      if (!gate.ok) return { ok: false, id: it.id, error: `refusing to complete ${it.id}: ${gate.reason}` };
    }
  }

  // EI-12027: `completion.status` (defaults to 'done') is NOT the same field as the
  // top-level `state` transition — an agent that sets `completion: { status: 'resolved' }`
  // and omits `state` reads, to a human, exactly like "resolve this item", but the row
  // stayed open (record-only by design, D-004) with only a POST-HOC `stateWarning` to
  // catch it. That warning is easy to miss (it isn't `ok:false`), and the reporter had
  // to make a second `work_items:complete`/`set_state` call to actually close.
  //
  // We do NOT blanket-auto-close (that would reopen the exact landmine D-004 avoided:
  // `completion.status` DEFAULTS to 'done', so treating every default as "close it"
  // would auto-close every bare completion ever made). Instead we infer ONLY when the
  // caller's `completion.status` is an EXPLICIT, unambiguous issue-lifecycle word that
  // can never arise from the schema default — the issue family's own native terminal
  // vocabulary, 'resolved' | 'closed' (never 'done', which collides with the default;
  // never feature-only 'passed'/'deprecated', which would risk stepping on the
  // scoper→…→curator pipeline's own status semantics for feature-family items, exactly
  // what D-004 was written to avoid). Scoped to `family === 'issue'` for the same reason.
  const rawCompletionStatus = typeof it.completion.status === 'string' ? it.completion.status.trim().toLowerCase() : undefined;
  const inferredCloseState =
    // work-item-status-full-unify: `dropped` (the unified drop-terminal) is equally unambiguous —
    // it can never arise from the schema default — so it also infers a close. `done` stays
    // EXCLUDED for the reason above (it IS the schema default; inferring from it would auto-close
    // every bare completion).
    !it.state &&
    existing.family === 'issue' &&
    (rawCompletionStatus === 'resolved' || rawCompletionStatus === 'closed' || rawCompletionStatus === 'dropped')
      ? rawCompletionStatus
      : undefined;
  const effectiveState = it.state ?? inferredCloseState;

  // Optional explicit terminal transition. A failed state write must NEVER lose the
  // completion record (EI-24): catch, report it as `stateError`, still record + emit.
  //
  // agent-protocol-authority-semantics-2026-07-26 P-004 REPLACED what satisfies the
  // completion-integrity gate here. It used to pass `completionRef: it.completion.summary`
  // — and because `completion.summary` is a required non-empty field, that made the gate's
  // "a terminal transition requires a completionRef" check unfailable BY CONSTRUCTION for
  // every caller of this tool. A gate that cannot reject is not a gate; it is ceremony that
  // reads like one, which is worse, because it made 65.6% of terminal rows (P-002, of
  // 14,663) look gate-approved while carrying no verification evidence at all.
  //
  // What it passes instead is a JUDGEMENT about the evidence: `authorityForCompletion`
  // returns `committed` only for verifiedHow PLUS one of testsRun/testResult, and
  // `proposed` otherwise. Both are accepted by the gate — the close is always RECORDED —
  // but only `committed` counts toward burn-down. That is D-003's restructure: an
  // unverified assertion no longer reaches the authoritative state and gets corrected by a
  // later audit; it never reaches it at all.
  let workItem = existing;
  let stateError: string | undefined;
  let aliasNote: string | undefined;
  // EI-18736669939338784: set when this close met an item ALREADY completed by someone
  // else, so the write was reshaped to preserve the stronger record. Surfaced as a loud
  // warning below — the caller being told `ok:true` while their evidence was destroyed IS
  // the bug this closes.
  let terminalConflict: TerminalCompletionConflict | undefined;
  // EI-7712: same shared discriminator as work_items:set_state — compares the
  // ACTUALLY-persisted state against what the caller asked for, not just whether the
  // normalize-layer onAlias fired. Only meaningful when a terminal `state` was passed;
  // a bare completion (no state transition) has nothing to compare, so both stay unset.
  let aliased: boolean | undefined;
  let requestedState: string | undefined;
  let appliedState: string | null | undefined;

  // WI-5891 (leader audit follow-up to WI-5874/P-001): a completion that intends to
  // CLOSE the item while claiming `verifiedHow: 'live-drove-ui'` must cite a real
  // artifact (a screenshot/capture path, or a recorded tauri-agent-tools capture/
  // screenshot/check invocation) — the exact gap that let P-001 close on this label
  // citing only two vitest runs, with no screenshot anywhere on the host. Checked
  // BEFORE the state write is attempted, so an unbacked claim never partially
  // transitions the item (nothing to roll back) — the completion record itself is
  // still built + returned below (EI-24: the narrative is never lost), it just
  // cannot land the CLOSE. This is a deliberate, narrow exception to this file's
  // usual record-and-warn discipline — see isBackedLiveDroveUiClaim's doc comment.
  const closeIntentRequested = Boolean(effectiveState) && CLOSE_INTENT_STATES.has(String(effectiveState).trim().toLowerCase());
  const completionEvidenceForGate = completionEvidenceFromRecord(it.completion);
  // P-004: the whole decision, in one call. `completionEvidenceFromRecord` returning
  // `undefined` (no evidence fields supplied at all) and returning a PARTIAL object
  // (P-002 measured 4.2% of evidence-bearing rows carry no `verifiedHow`) both land
  // `proposed` — the partial case is rejected explicitly rather than assumed away,
  // because an "is the object present?" test passes every one of them.
  const completionAuthority = authorityForCompletion(completionEvidenceForGate);
  const unbackedLiveDroveUiClose = closeIntentRequested && !isBackedLiveDroveUiClaim(completionEvidenceForGate);

  // EI-19319623239777505: the object actually PERSISTED to the row additionally carries
  // the caller's free-text `completion.summary`. This is deliberately a SEPARATE object
  // from `completionEvidenceForGate` above — that one stays exactly as before (scoped to
  // the load-bearing structured fields) because `hasTests` below, `authorityForCompletion`,
  // and `isBackedLiveDroveUiClaim` all key off whether STRUCTURED evidence was supplied;
  // folding `summary` into `completionEvidenceForGate` itself would make a bare-summary,
  // no-verification completion silently read as "evidence supplied" to every one of those
  // checks. Before this, `summary` was written nowhere durable: work_items:complete never
  // passes a `completionRef` (see the P-004 comment above), and the second-terminal-close
  // attestation path in work-items.ts falls back to that same absent `opts.completionRef`
  // — so a caller's whole narrative lived only in this call's RETURN value, gone the
  // moment the response was read. Persisting it under `evidence.summary` (both on a normal
  // close AND inside a second-close attestation, since that path reads `opts.completionEvidence`)
  // fixes both cases from one write, without touching the authority/warning semantics above.
  const summaryText = it.completion.summary?.trim();
  const completionEvidenceToPersist: CompletionVerificationEvidence | undefined = summaryText
    ? { ...(completionEvidenceForGate ?? {}), summary: summaryText }
    : completionEvidenceForGate;

  // EI-18797014705631713: citing an artifact is not the same as HAVING one. The text
  // check above proves a path was written down; this reads the file. A screenshot of a
  // window that never painted is a valid PNG at a valid path proving nothing, and it is
  // produced by the same command as a real one — so the strongest-looking evidence type
  // was the easiest to fake by accident. Deliberately fail-open: it refuses only when
  // every cited artifact is confidently bad (see verifyLiveDroveUiArtifacts).
  const artifactVerdict = closeIntentRequested
    ? await verifyLiveDroveUiArtifacts(completionEvidenceForGate)
    : null;
  const falseLiveDroveUiClose = !unbackedLiveDroveUiClose && artifactVerdict?.ok === false;

  // EI-18850142725126359 fix #4 — PRE-FLIGHT THE PLANE RATCHET.
  //
  // Closing a METRIC_KNOWN_GAPS item is a fleet-gate mutation: `lint:plane-ratchet`
  // reads live work-item status, so the exemption is withdrawn the instant the row
  // goes terminal and the very next green-checkpoint reds — candidate-independently,
  // three minutes later, on a release-fixer who is handed a causally-irrelevant SHA.
  // Say it HERE instead, to the agent who is about to cause it.
  //
  // Computed BEFORE the state write for two reasons: the warning is the caller's
  // last cheap moment to reconsider, and it must still be reported when the write
  // itself fails. Warn-only, and deliberately so — see the provenance argument in
  // agent-plane-close-preflight.ts's header (this process holds the DEPLOYED gap
  // map, the gate judges the candidate's, so a refusal could block a correct close
  // on data known to be stale). Fully fail-open: a guard fault must never cost a
  // completion (EI-24).
  let planeRatchetWarning: string | undefined;
  if (closeIntentRequested && isPlaneGapItem(it.id)) {
    try {
      const verdict = await preflightPlaneCloseLive({ closingIds: [it.id], workspaceId: ctx.workspaceId });
      if (verdict) planeRatchetWarning = renderPlaneClosePreflightWarning(verdict);
    } catch {
      /* fail-open: never turn a ratchet-check fault into a failed completion */
    }
  }

  // P-008 (d) / D-050 / D-079: resolve the declared assumptions BEFORE the state
  // write, so a dangling reference cannot land a close.
  //
  // ⚠ Deliberately NOT a throw, unlike work_items:set_state. A throw here would
  // discard the completion narrative the caller wrote, which is exactly what this
  // file's record-and-warn discipline (EI-24: "the narrative is never lost")
  // forbids. The precedent is `unbackedLiveDroveUiClose` immediately below — the
  // same shape of failure, an unbacked claim — which blocks the CLOSE via
  // `stateError` and still returns the record. So a dangling assumption refuses
  // the commitment (the item stays claimable) without costing the caller the
  // write-up. `set_state` has no narrative to lose, so it throws.
  let resolvedAssumptions: StoredAssumptionDeclaration | undefined;
  let assumptionsError: string | undefined;
  try {
    resolvedAssumptions = await resolveDeclaredAssumptions({
      declared: it.assumptions,
      workItemId: it.id,
      ownerId: ident.ownerId,
      // EI-18806393166489384: `it.harness` is the caller's OPTIONAL arg, so a
      // close that did not redundantly name the harness resolved no harness
      // scope at all. The resolver now derives it when absent, but pass the row
      // we already fetched above so the common path costs no extra read.
      harnessSlug: it.harness ?? existing.harness,
    });
  } catch (e) {
    assumptionsError = e instanceof Error ? e.message : String(e);
  }
  // EI-19298742806956600: WARN-ONLY — a cited key that resolves fine but was never
  // asserted as an assumption (kind:'assumption' or legacy confidence:'suspected').
  // Never refuses (see nonAssumptionKindAdvisory's own header for why); surfaced the
  // same way planeRatchetWarning is, below.
  const assumptionKindWarning =
    resolvedAssumptions && Array.isArray(resolvedAssumptions.declared)
      ? nonAssumptionKindAdvisory(resolvedAssumptions.declared)
      : undefined;

  if (assumptionsError) {
    stateError = `REJECTED — ${assumptionsError}`;
  } else if (unbackedLiveDroveUiClose) {
    stateError =
      `REJECTED — this completion claims verifiedHow:'live-drove-ui' to close ${it.id} but cites no real ` +
      'artifact (a screenshot/capture image path, or a recorded tauri-agent-tools capture/screenshot/check ' +
      "invocation) in testsRun/testResult/filesChanged. This is exactly the gap that shipped WI-5874/P-001 past " +
      "its own author: unit tests verify structure, not pixels. Either cite the artifact, or honestly set " +
      "verifiedHow to 'unit'/'manual'/'integration' and re-send.";
  } else if (falseLiveDroveUiClose) {
    stateError =
      `REJECTED — this completion claims verifiedHow:'live-drove-ui' to close ${it.id}, but its cited evidence ` +
      `does not hold up: ${artifactVerdict?.reason}. A capture of a window that never painted ` +
      'exits 0 and writes a normal-looking file, so citing it proves a command ran, not that any UI was seen ' +
      '(scripts/verify-tauri-headless.sh warns about exactly this when the box has no real GPU GL). ' +
      'Strongest fix, and cheaper than another screenshot: cite a `tauri-agent-tools check --pid <pid> --eval ' +
      '"<assertion>" --json` run — it exits non-zero when the assertion is false, so it is falsifiable and ' +
      'records WHAT you asserted. Otherwise re-capture, OPEN the image to confirm it rendered, and cite that ' +
      "path — or honestly set verifiedHow to 'unit'/'manual'/'integration' and re-send.";
  } else if (effectiveState) {
    try {
      const res = await setWorkItemStateWithAliasInfo(it.id, effectiveState, {
        harness: it.harness,
        by: ident.ownerId,
        // NO `completionRef` — see the block comment above. The narrative is not
        // lost: `completionEvidenceToPersist` (EI-19319623239777505) carries the
        // caller's free-text `summary` alongside whatever structured fields exist,
        // so it lands durably on the row's `_completionEvidence`, not just in this
        // call's return value.
        completionEvidence: completionEvidenceToPersist,
        // P-008 (d): the resolved declaration, persisted under
        // TERMINAL_ASSUMPTIONS_KEY beside the evidence it rests on.
        assumptions: resolvedAssumptions,
        completionAuthority,
        onTerminalConflict: (info) => {
          terminalConflict = info;
        },
      });
      workItem = res.workItem ?? existing;
      aliasNote = res.aliasNote;
      aliased = res.aliased;
      requestedState = res.requestedState;
      appliedState = res.appliedState;
    } catch (e) {
      stateError = e instanceof Error ? e.message : String(e);
    }
  }

  // EI-5269: `completion.status` (defaults to 'done') is NOT the state transition — only the
  // top-level `state` arg moves the row terminal. Completing WITHOUT a terminal `state` records
  // the completion (so it READS as done) but leaves the item non-terminal → still claimable, and
  // the stale-reclaim sweep re-places work on it (real duplicate bee spawns the reporter hit). We
  // deliberately do NOT auto-close (that would step on the validator/reviewer pipeline's own status
  // semantics — state is optional BY DESIGN, D-004). Instead we make the silent footgun LOUD: warn
  // whenever the item is non-terminal after this completion, so the caller re-calls with a terminal
  // `state` (exactly the fix the reporter applied). Also fires when an explicit `state` write failed
  // (stateError) or landed on a non-terminal state — in every case the item is still claimable.
  const finalState = (workItem?.state ?? existing.state ?? '').toLowerCase();
  // EI-18661904412177717: the warning MUST distinguish "you passed no state" from "your state
  // was not applied". The single wording ("Pass top-level `state` …") told a caller who HAD
  // passed one to do the exact thing they just did — so the natural next move is to re-send the
  // identical call and get the identical result (the reporter did, twice). A warning that
  // prescribes an action the caller already took is worse than no warning: it actively routes
  // them into a loop instead of at the real cause.
  const nonTerminalHint = `so it stays claimable and the auto-loop may re-place work on it`;
  const terminalVocab = `(feature: 'passed'|'deprecated'; issue: 'resolved'|'closed')`;
  const stateWarning = !finalState || TERMINAL_WORK_ITEM_STATES.has(finalState)
    ? undefined
    : stateError
      ? `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${nonTerminalHint}. Your state '${effectiveState}' was REJECTED by the state write: ${stateError}. Re-sending the same state will fail the same way — fix the cause, or pass a valid TERMINAL state ${terminalVocab}.`
      : effectiveState
        ? `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${nonTerminalHint}. Your state '${requestedState ?? effectiveState}' WAS received and applied as '${appliedState ?? workItem?.state ?? existing.state}', which is NOT terminal${aliasNote ? ` (${aliasNote})` : ''}. Do NOT re-send the same value — pass a TERMINAL state ${terminalVocab}.`
        : `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${nonTerminalHint}. No top-level \`state\` was passed. Pass top-level \`state\` ${terminalVocab} to close it.`;

  // flush-to-proceed-stretch-discipline-2026-07-04 P-006: verification linting. A settled
  // unit is either VERIFIED (`tests`) or CONSCIOUSLY DEFERRED (`deferred`) — never silent. A
  // completion carrying NEITHER is exactly the "settled a unit without saying whether it was
  // checked" gap the discipline closes. SOFT warning, not a hard reject (D-005): this file's
  // whole contract is EI-24 "a finished completion is normalised, never hard-rejected+lost"
  // — the coerce layer, the state-write catch, and stateWarning all record-and-warn rather
  // than drop, so hard-rejecting HERE would be the one place that violates it. Mirrors
  // stateWarning: attached to the result + surfaced to the caller; the completion is still
  // recorded + emitted. Rides the write-echo passthrough (write-echo-shape.ts).
  //
  // EI-7316: the schema carries verification evidence across SEVEN sibling fields
  // (tests / testsRun / testResult / verifiedHow, each also duplicated under the
  // nested `verification.*` alias) — completionEvidenceFromRecord (above) already
  // treats all of them as equally valid evidence when filling completionEvidence for
  // the state write. This check used to inspect ONLY the bare `tests` field, so a
  // caller who documented verification via `testsRun`/`testResult`/`verifiedHow` (or
  // the nested `verification.*` aliases) — every one a legitimate, schema-blessed
  // way to record it — got a FALSE "neither tests nor deferred populated" warning
  // even though they HAD stated how it was verified. Reuse the SAME evidence
  // extraction as the state write (completionEvidenceFromRecord) as the one source
  // of truth, so "did this completion record verification" can never disagree
  // between the two call sites.
  const hasTests = completionEvidenceForGate !== undefined;
  const hasDeferred = Array.isArray(it.completion.deferred) && it.completion.deferred.length > 0;
  // EI-13687: when `completion` arrived as a bare string, hasTests/hasDeferred are
  // UNCONDITIONALLY false (the coercion can only ever populate `summary`) — so give
  // the caller the concrete dropped-fields list + the exact object shape to resend,
  // instead of the generic "fill `tests`" nudge that reads like a nag about one
  // missing field rather than "your structured evidence was silently discarded".
  const verificationWarning =
    !hasTests && !hasDeferred
      ? shapeCoercedFromBareString
        ? `completion for ${it.id} was passed as a bare STRING and silently coerced to { summary: ${JSON.stringify(it.completion.summary)} } — every other field (testsRun, testResult, verifiedHow, addedTests, filesChanged, whatLanded, deferred, migrations) is EMPTY, not just unfilled, because a string can only ever populate \`summary\`. If you have structured evidence, RESEND as an object: work_items:complete({ id, state, completion: { summary, testsRun: '<what you ran>', testResult: '<pass/fail summary>', verifiedHow: 'unit'|'integration'|'live-drove-ui'|'manual'|'already-passing', addedTests: <boolean>, filesChanged: [...] } }) — or, if genuinely unverified, resend with \`deferred: ['<what you left undone + why>']\`.`
        : `recorded a completion for ${it.id} with neither \`tests\` nor \`deferred\` populated — a settled unit should state whether it was VERIFIED (fill \`tests\`: what you ran / how you checked it, e.g. "18 vitest green" or "n/a — docs only") or CONSCIOUSLY DEFERRED (fill \`deferred\`: what you left undone + why). Add one so the unit isn't silently unverified (flush-to-proceed: a unit settles only live-verified or explicitly deferred-with-reason).`
      : undefined;

  // P-004: the authority actually STAMPED on the row, or null when this call stamped
  // none (no terminal `state`, or the state write was rejected). Reporting the computed
  // judgement in either of those cases would tell the caller their close was graded when
  // no close happened — the same class of lie the deleted auto-fill told.
  const stampedAuthority =
    !stateError && finalState && TERMINAL_WORK_ITEM_STATES.has(finalState) ? completionAuthority : null;
  // The change is worthless if it is silent. An agent whose close just landed `proposed`
  // must be TOLD, in the response to the call that did it, what it costs and what would
  // have avoided it — otherwise the first they learn of it is a leader asking why their
  // burn-down did not move. Names the two fields that flip it, because "supply evidence"
  // is exactly the vague instruction the old gate got away with.
  const authorityWarning =
    stampedAuthority === 'proposed'
      ? `${it.id} is CLOSED but its completion landed authority:'proposed' — recorded and out of the ` +
        `claimable pool, but NOT counted toward burn-down, and it stays owned by you until it is settled. ` +
        `\`committed\` requires \`verifiedHow\` ('unit'|'integration'|'live-drove-ui'|'manual'|'already-passing') ` +
        `PLUS at least one of \`testsRun\` / \`testResult\`. \`filesChanged\` and \`addedTests\` do NOT qualify — ` +
        `both say what changed, neither says anything was checked. To settle it, re-call ` +
        `work_items:complete for this id with those fields filled; if the work genuinely cannot be verified, ` +
        `say so in \`deferred\` and leave it proposed.`
      : undefined;

  // Fill provenance defaults so the rendered notification is complete (D-006).
  const completion = {
    ...it.completion,
    workItem: it.completion.workItem || it.id,
    agent: it.completion.agent || ident.ownerLabel || ident.ownerId,
    planSlug: it.completion.planSlug,
  };

  // P-020 (su-ideate-learning-substrate): checkpoint-HARVEST. A completion's
  // `coordNotes` — the design-note residual the structured fields can't hold — is
  // the insight-bearing free-text agents ALREADY write at this boundary; auto-file
  // it as a lane:observation with ZERO new workflow (D-016/D-017). Fire-and-forget +
  // fully fail-open: harvest must NEVER affect the completion (EI-24 record-and-warn
  // discipline). The leg coalesces a repeated note against the agent's own recent harvest.
  const harvestNote = it.completion.coordNotes;
  if (harvestNote && harvestNote.trim()) {
    const ownerId = ident.ownerId;
    const harvestHarness = it.harness && it.harness !== '*' ? it.harness : undefined;
    void (async () => {
      try {
        const filedByRole = (await getPresence(ownerId).catch(() => null))?.agentRole ?? undefined;
        const { harvestInsight } = await import('../../harness/improvements/checkpoint-harvest');
        await harvestInsight({
          insight: harvestNote,
          createdBy: ownerId,
          source: 'work-item-completion',
          ref: `wi:${it.id}`,
          ...(filedByRole ? { filedByRole } : {}),
          ...(harvestHarness ? { harness: harvestHarness, sourceHive: harvestHarness } : {}),
        });
      } catch {
        /* fail-open: harvest never affects the completion the agent recorded */
      }
    })();
  }

  // EI-8993 (dup-close accountability): a completion that names `duplicateOf`
  // auto-creates the structured `duplicates` coord_links edge (so dup-scanners
  // and future readers see the graph, not just free-text prose) and
  // auto-subscribes the item's PRIOR assignee (the WI-3646 gap — a leader who
  // force-reopened + re-claimed it wasn't watching, so the wrong dup-close
  // reached no one who could catch it) so the existing per-completion watcher
  // fan-out (the `emits` block below, `@object:<kind>:<ref>`) reaches them even
  // if they never explicitly subscribed. Best-effort + record-and-warn (EI-24,
  // same discipline as every other check in this file) — a bad/missing target
  // must never lose an otherwise-good completion.
  let duplicateOfWarning: string | undefined;
  const duplicateOf = it.completion.duplicateOf;
  if (duplicateOf) {
    if (duplicateOf === it.id) {
      duplicateOfWarning = `completion.duplicateOf ('${duplicateOf}') is the same id as the item being closed — ignored; a duplicate must name a DIFFERENT surviving item.`;
    } else {
      const dst = await resolveWorkItemRef(duplicateOf, it.harness).catch(() => null);
      if (!dst) {
        duplicateOfWarning = `completion.duplicateOf ('${duplicateOf}') was not found — no \`duplicates\` link was created. Double-check the surviving id.`;
      } else {
        const linkRes = await linkWorkItem(it.id, dst, 'duplicates', { harness: it.harness, by: ident.ownerId }).catch(
          (e) => ({ error: e instanceof Error ? e.message : String(e) }),
        );
        if ('error' in linkRes) duplicateOfWarning = `failed to record the \`duplicates\` link to '${duplicateOf}': ${linkRes.error}`;
      }
    }
  } else if (mentionsWorkItemDuplicate(`${it.completion.summary} ${it.completion.status ?? ''}`)) {
    // The exact free-text pattern that let WI-3646 get dup-closed 3× with no structured
    // trace ("dup of WI-3543" in prose, nothing a scanner could follow). Nudge toward the
    // structured field without blocking.
    duplicateOfWarning = `this completion's summary/status names another work-item as a duplicate but \`completion.duplicateOf\` was not set — pass the SURVIVING item's id there so a \`duplicates\` link + assignee notification are recorded, not just free text.`;
  }
  if (duplicateOf && duplicateOf !== it.id && existing.assignee && existing.assignee !== ident.ownerId) {
    await subscribeWorkItem(existing.assignee, it.id, 'full', { harness: it.harness }).catch(() => {});
  }

  // EI-7214: persist outputPayload onto the item row (payload.out) so it's a
  // self-serve, queryable read surface for a harness sidecar pulling completed
  // outputs over HTTP — not just a transient field on this call's own result /
  // the emitted reaction event. Best-effort (mergeWorkItemOutputPayload never
  // throws): a payload-persist failure must never turn an already-recorded
  // completion into a failed one.
  if (it.outputPayload !== undefined) {
    await mergeWorkItemOutputPayload(it.id, it.outputPayload, { harness: it.harness });
  }

  // Reflect-and-capture STEP at the completion boundary (self-learning-central P-001/B).
  const reflect = renderReflectStep({ harnessActive: Boolean(workItem?.harness) });

  // WI-4529 — `ok` MUST reflect the state transition the caller asked for, not merely that the
  // completion record got written.
  //
  // THE BUG: a `state` that did not land (held-open refusal, completion-integrity gate, or an
  // alias that silently downgraded a terminal request to a NON-terminal state — e.g. issue-family
  // 'done' → 'open') still returned ok:true, with the real failure buried in a sibling `stateError`
  // / `stateWarning` STRING. Every caller checks `ok` — so every caller read it as success and
  // walked away leaving the item OPEN and re-claimable, believing it closed. That is precisely the
  // silent-success class (a write that reports success while doing half the thing).
  //
  // EI-24 IS PRESERVED — this does NOT hard-reject or drop anything. The completion record is
  // still built, still returned on the result, and still BROADCAST: the `emits` rule keys on
  // `result.completion`, which is present on the ok:false result too (BulkItemResult carries an
  // index signature). A failed state write still never loses the completion. We only stop lying
  // about whether the item actually closed.
  //
  // Scoped deliberately, in TWO cases — and NOT a blanket "state didn't land terminal":
  //   (1) the state write THREW (stateError) — the caller asked for a transition and got none.
  //       This is the reported bug (a peer's HOLD-OPEN refusal came back ok:true, item still open).
  //   (2) the caller used a CLOSE-INTENT state but the item did not land terminal — the
  //       issue-family alias trap (`state:'done'` silently lands as 'open').
  // A bare completion with NO `state`, or a deliberate non-terminal park (`needs_human`,
  // `blocked`), is a legitimate record-only call and stays ok:true with the existing loud
  // `stateWarning` / `aliasNote`. Those callers did not ask to close, so we must not fail them.
  const landedState = workItem?.state ?? existing.state;
  const closeLanded = TERMINAL_WORK_ITEM_STATES.has(finalState);
  const closeIntended = Boolean(effectiveState) && CLOSE_INTENT_STATES.has(String(effectiveState).trim().toLowerCase());
  const stateWriteFailed = Boolean(effectiveState) && Boolean(stateError);
  const closeFailed = closeIntended && !closeLanded && !stateError;
  const stateNotApplied = stateWriteFailed || closeFailed;
  const stateFailure = !stateNotApplied
    ? undefined
    : stateError
      ? `COMPLETION RECORDED, BUT ${it.id} DID NOT CLOSE — it is still '${landedState}' and stays claimable. The state write failed: ${stateError}`
      : `COMPLETION RECORDED, BUT ${it.id} DID NOT CLOSE — you requested state '${requestedState ?? effectiveState}' and it applied as '${appliedState ?? landedState}'${aliasNote ? ` (${aliasNote})` : ''}, which is NOT terminal, so the item stays claimable and the auto-loop may re-place work on it. Pass a TERMINAL state (issue: 'resolved'|'closed'; feature: 'passed'|'deprecated').`;

  const finish = closeLanded
    ? await synchronizeFinishWork({
        id: it.id,
        workItem: workItem as unknown as Record<string, unknown>,
        completionEvidenceStored: true,
        ctx,
      })
    : undefined;
  const finishFailed = Boolean(finish && !finish.complete);
  const finishFailure = finishFailed
    ? `COMPLETION RECORDED AND ITEM CLOSED, BUT FINISH DID NOT FULLY CONVERGE — ${finish!.errors?.join('; ') ?? 'a finish leg failed'}. Re-call the SAME completion; finish is idempotent and resumes the missing legs.`
    : undefined;

  // EI-19312103118112942: a fleet drain member's confirmed failure mode is treating
  // *completing* an item as the end of the wake instead of its midpoint — it closes
  // the item, holds nothing, and settles, even though its own claim spec still has
  // hundreds of claimable rows (measured: half of a 10-member fleet idle simultaneously
  // against 436 claimable). Fire this INLINE on every real close for a fleet member —
  // no extra query needed: `deriveFleetMembership()` is a pure env read
  // (PAPERCUSP_FLEET_SLUG), and a fleet member always drains one item at a time, so
  // "just closed" reliably means "likely holds nothing else right now". False positives
  // (the rare member juggling >1 claim) cost nothing — scheduler:get_next is a cheap,
  // idempotent no-op when the caller already holds enough work.
  const fleetRepullNudge =
    closeLanded && !stateError && !finishFailed && deriveFleetMembership().fleetSlug != null
      ? `${it.id} is CLOSED. If you hold no other claim right now, do NOT settle — call scheduler:get_next immediately to pull the next unit before ending this turn (EI-19312103118112942: completing is the midpoint of a wake, not the end).`
      : undefined;

  // EI-15982: every LOUD signal (anything the caller must not miss — a hard failure
  // OR a soft "recorded but not closed"/"evidence dropped"/etc warning) is placed
  // BEFORE the bulky echoed data (`workItem`, `completion`, `reflect`, `finish`).
  // The per-result context door (result-door.ts) truncates an oversized tool
  // result's serialized text FROM THE FRONT of the budget — i.e. it keeps a
  // PREFIX of the JSON and cuts the tail — so a warning key that serializes
  // AFTER the two large echoed objects is exactly the content most likely to be
  // silently sliced off (the reported failure: `stateWarning` on a completion
  // whose `workItem`+`completion` echo alone pushed the response past the
  // ~1500-token door, so the one field telling the caller "this did NOT close"
  // never reached them). Warnings are cheap (short strings); ordering them first
  // costs nothing and makes them survive truncation whenever ANYTHING fits.
  return {
    ok: !stateNotApplied && !finishFailed,
    id: it.id,
    ...(stateFailure || finishFailure ? { error: stateFailure ?? finishFailure } : {}),
    ...(stateError ? { stateError } : {}),
    ...(stateWarning ? { stateWarning } : {}),
    // EI-18850142725126359 fix #4 — reported ONLY when the close actually LANDED.
    // The text is written in the future tense ("will red the next checkpoint"),
    // which is true of a terminal row and false of a close that was rejected — and
    // a fleet-gate alarm that cries wolf on a no-op close is exactly how this
    // channel would earn the skim it must not get. Ordered with the other LOUD
    // signals, ahead of the bulky echo, for the EI-15982 reason above.
    ...(planeRatchetWarning && closeLanded && !stateError ? { planeRatchetWarning } : {}),
    ...(assumptionKindWarning && closeLanded && !stateError ? { assumptionKindWarning } : {}),
    ...(nulBytesStripped
      ? {
          nulBytesStrippedWarning: `completion for ${it.id} contained one or more raw NUL bytes (invisible in most editors/terminals — renders as nothing or a plain space) — they were silently removed before recording, because Postgres cannot store a NUL in a text/jsonb column ("unsupported Unicode escape sequence") and an unremoved one would have failed the state write while leaving the completion recorded (EI-18764241942332131). If the NUL was meaningful (e.g. you were quoting a literal NUL byte as evidence), describe it in prose instead (e.g. "a raw NUL / 0x00 byte") rather than embedding the literal character.`,
        }
      : {}),
    ...(aliased !== undefined ? { aliased, requestedState, appliedState } : {}),
    ...(aliasNote ? { aliasNote } : {}),
    ...(inferredCloseState
      ? {
          stateInferredFromCompletionStatus: `no top-level \`state\` was passed, but completion.status ('${inferredCloseState}') is this issue's own terminal vocabulary — inferred state:'${inferredCloseState}' and closed it (EI-12027). Pass top-level \`state\` explicitly to avoid relying on this inference.`,
        }
      : {}),
    // EI-18736669939338784 — ordered with the other LOUD signals, ahead of the bulky echoed
    // data, for the reason documented above: the result door truncates from the tail, and
    // this is precisely the field a caller must not lose. `completionEvidenceStored` stays
    // true and is NOT repurposed to report this: the evidence WAS durably recorded (as an
    // attestation), and that flag feeds `finish.complete`, whose `false` means "re-call the
    // same completion to converge" — advice that cannot help here and would send the caller
    // into a retry loop against a guard that will make the same decision every time.
    ...(terminalConflict
      ? {
          terminalConflictWarning:
            terminalConflict.outcome === 'attested'
              ? `COMPLETION RECORDED AS A SECOND ATTESTATION, NOT AS THIS ITEM'S RECORD — ${terminalConflict.note}`
              : `YOUR COMPLETION REPLACED AN EARLIER, THINNER ONE — ${terminalConflict.note}`,
          terminalConflict,
        }
      : {}),
    ...(authorityWarning ? { authorityWarning } : {}),
    ...(verificationWarning ? { verificationWarning } : {}),
    ...(assigneeMismatchWarning ? { assigneeMismatchWarning } : {}),
    ...(harnessMismatchWarning ? { harnessMismatchWarning } : {}),
    // Reported unconditionally on a real close (including `committed`) so the caller can
    // see the judgement rather than infer it from the absence of a warning.
    ...(stampedAuthority
      ? { completionAuthority: stampedAuthority, countsTowardBurnDown: countsTowardBurnDown(stampedAuthority, true) }
      : {}),
    ...(duplicateOfWarning ? { duplicateOfWarning } : {}),
    ...(fleetRepullNudge ? { fleetRepullNudge } : {}),
    workItem,
    completion,
    reflect,
    ...(it.outputPayload !== undefined ? { outputPayload: it.outputPayload } : {}),
    ...(finish ? { finish } : {}),
  };
}

export default defineTool({
  name: 'work_items:complete',
  profile: 'engineer',
  description:
    "Finish one OR many work-items with a STRUCTURED completion record (whatLanded/migrations/tests/deferred) — the system renders + broadcasts it, never narrate in prose. A terminal `state` converges the whole finish: item state + plan-item + claim release + checkpoint cleanup. Omit `state` and `ok:true` does NOT mean closed — check `finish.complete`/`stateWarning` (see seeAlso for idempotency + batch-result semantics).",
  guidance: {
    when: 'Finished work/plan-item(s). Fill the fields; do NOT also coord:send a prose summary — this emits it. To CLOSE pass a terminal top-level `state` (feature: \'passed\'|\'deprecated\'; issue: \'resolved\'|\'closed\'); other `completion.status` values record WITHOUT closing (issue status \'resolved\'|\'closed\' alone also closes, EI-12027). `verifiedHow` is a CLOSED ENUM, not free text — prose goes in testsRun/testResult. A CLOSE claiming `verifiedHow:\'live-drove-ui\'` is REJECTED unless testsRun/testResult/filesChanged cite a REAL artifact — the cited image is opened, and a blank or non-existent capture is refused (WI-5891, EI-18797014705631713). A `tauri-agent-tools check` run is accepted on its own. Duplicate? set `completion.duplicateOf` to the surviving id.',
    notWhen: 'For a contextual aside (a question, a design note), use coord:send. To change state without a completion record, use work_items:set_state.',
    chaining: 'work_items:claim → … → work_items:complete { id, state, completion }. On success, `finish.complete:true` proves state/plan/claim/checkpoint convergence and auto-emits to coord:inbox.',
    seeAlso: [
      'work_items:set_state (change state without recording a completion)',
      'coord:send (a note/question that is not a completion)',
      'improvements:capture (file the friction the reflect step surfaced)',
      "The `finish` receipt is idempotent — ok:false means a leg did not converge; re-call the SAME completion to resume it.",
      "Single-item call ({id,completion}): top-level `ok` IS this item's own outcome (EI-14676) — ok:false means it did NOT converge. Explicit `items:[…]` batch: top-level `ok:true` only means the batch ran — check each result's own `ok` + `counts.failed`.",
      'EI-7746: items run sequentially — if the CALL itself times out mid-batch, already-processed items are already committed but you never see their results. Re-check via work_items:get before assuming failure; a blind retry of the SAME items+state is safe (re-applying an already-terminal state is a no-op, never trips the reopen/force guard).',
    ],
  },
  capability: 'work_items:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007; EI-11507): a completion
  // whose wall-clock beat the 55s transport deadline under load STILL COMMITTED — the handler ran
  // to completion, and every finish leg is documented-idempotent (synchronizeFinishWork: terminal
  // state re-apply, plan-status flip, claim release, checkpoint clear are all no-ops on re-apply;
  // see the seeAlso "a blind retry of the SAME items+state is safe"). Surfacing the TRUTHFUL success
  // instead of a spurious `timeout` stops the mandatory *:get verify-read + partial-batch
  // reconciliation the reporter hit every time (EI-11507). Same opt-in already shipped for
  // plans:set-status. Inert except in the dispatch abort-race branch (dispatch-stack.ts).
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  // INTRINSIC emission (D-002/D-004): a completion always auto-broadcasts its
  // structured record as a coord notification. The desugar registers this as an
  // event-reaction rule (`emits:work_items:complete#completion`); the render
  // stays PURE — the engine owns dispatch/durability/loop-protection. With the
  // bulk envelope it fires PER completed item via the D-007 event-layer fan-out.
  emits: [
    {
      fire: 'coord:emit',
      // Only when the handler returned a real completion record (i.e. the item
      // existed). A not-found returns { ok:false } with no completion. The D-007
      // fan-out hands this rule one per-item event whose result.data IS the item.
      when: (e) => Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion),
      render: (e) => {
        const data = e.result.data as {
          completion: CompletionRecord;
          workItem?: { family?: 'feature' | 'issue'; harness?: string | null; id?: string };
        };
        const rec = data.completion;
        const { summary, body } = renderCompletion(rec);
        // Scope to watchers (coord-emit-subscription-scoping-2026-06-05): peers on
        // the completed item's plan + the item's own object subscribers.
        const to: string[] = [];
        if (rec.planSlug) to.push(`@plan:${rec.planSlug}`);
        const wi = data.workItem;
        if (wi?.family && wi.id) {
          to.push(objectSelector(workItemObjectRef({ family: wi.family, harness: wi.harness ?? null, id: wi.id })));
        }
        return {
          category: 'completion',
          summary,
          ...(body ? { body } : {}),
          ...(rec.planSlug ? { plan_slug: rec.planSlug } : {}),
          to,
        };
      },
    },
  ],
  // EI-7031: rescue a FLAT single-complete (completion fields passed directly on
  // args, no `completion` wrapper — the 22× "pass { id, completion } …" reject) by
  // gathering them into `completion` BEFORE the object parse strips unknown keys.
  // A well-formed { id, completion } / items:[…] call is returned unchanged.
  args: z.preprocess(
    gatherFlatCompletion,
    z
      .object({
        id: z.string().min(1).optional().describe('single-complete shorthand: the work-item id (use with `completion`)'),
        harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
        /** Optional terminal state to also set. Like `harness`, it is the DEFAULT for
         *  items:[…] entries that omit their own `state` (EI-18661904412177717). */
        state: z.string().min(1).max(40).optional(),
        /** The structured completion record (single-complete shorthand). */
        completion: completionSpec.optional(),
        /** Optional kind-specific structured output (single-complete shorthand). */
        outputPayload: z.unknown().optional(),
        /** P-017 (b) gate #2: `.optional()` ONLY so an items[]-only call need not carry
         *  one; the single-complete shorthand's requirement is closed by the refine below. */
        assumptions: assumptionsArg
          .optional()
          .describe('assumption declaration for the single-complete shorthand (see items[].assumptions)'),
        items: z
          .array(itemSpec)
          .min(1)
          .max(100)
          .optional()
          .describe('complete many work-items at once — each { id, completion, state?, harness? }; an omitted per-item state/harness falls back to the top-level one'),
      })
      .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.completion)), {
        // EI-6999: the first shape error a caller hits should state the FULL
        // minimal shape needed to actually CLOSE an item, not just "you're
        // missing `completion`" — a caller who fixes that alone still hits a
        // SECOND round-trip discovering `completion.summary` is required, then
        // a THIRD discovering `completion` alone never changes lifecycle state
        // (a bare `completion` records the note but leaves the item claimable
        // — pass `state` too to actually close it). Say all of it up front.
        message:
          'to CLOSE a work-item, pass { id, state, completion: { summary } } ' +
          '(or items:[{ id, state, completion: { summary } }] for many) — ' +
          '`state` is the terminal lifecycle (issue: "resolved"|"closed"; feature: "passed"|"deprecated") ' +
          'and is REQUIRED to actually close it: a completion with no `state` only records the note, ' +
          'the item stays claimable (see work_items:set_state to change state alone, without a completion record).',
      })
      // P-017 (b) gate #2 / D-050 — the same rule itemSpec enforces for items[], closed
      // for the single-complete shorthand so the gate cannot simply relocate to it.
      .refine((a) => (a.items?.length ?? 0) > 0 || hasAssumptionDeclaration(a.assumptions), {
        path: ['assumptions'],
        message: ASSUMPTIONS_REQUIRED_MESSAGE,
      }),
  ),
  // context-trimming-tiers P-025 (write-echo diet): trimmed/standard sessions
  // get a compact workItem ref per result instead of the full echoed row;
  // outcome fields (ok/error/holder/hint/reflect) pass through verbatim —
  // see write-echo-shape.ts.
  shape: {
    standard: (data) => shapeWorkItemWriteEcho(data, 'standard'),
    trimmed: (data) => shapeWorkItemWriteEcho(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const isBulkForm = Boolean(args.items?.length);
    // EI-18661904412177717: the batch path defaulted `harness` from the top level but SILENTLY
    // DROPPED the top-level `state` — so `{ state:'resolved', items:[…] }` recorded every
    // completion, returned ok:true, and left every item `wip`/claimable, while the stateWarning
    // instructed the caller to "pass top-level `state`" — exactly what they had just passed.
    // An agent that trusts ok:true walks away believing a batch is closed when it is all still
    // claimable, and the auto-loop re-places finished work: a silent correctness failure in the
    // completion-integrity path. `state` now defaults per-item exactly like `harness` (a
    // per-item `state` still wins), so the two forms cannot disagree. Defaulted HERE, at the
    // single list-construction site, so every downstream `it.state` reader (the remote-authored
    // refusal, the test-completion gate, the inference/close-intent logic) sees the same value.
    const list: CompleteItem[] = isBulkForm
      ? args.items!.map((it) => ({ ...it, harness: it.harness ?? args.harness, state: it.state ?? args.state }))
      : [{
          id: args.id as string,
          harness: args.harness,
          state: args.state,
          completion: args.completion!,
          outputPayload: args.outputPayload,
          // P-017 (b) gate #2: the refine above guarantees this is present on the
          // shorthand axis, so the assertion is safe — but it must be threaded HERE or
          // the declaration the gate just forced would be collected and then dropped on
          // the floor for every single-complete call.
          assumptions: args.assumptions!,
        }];
    const env = await runBulk(list, (it) => completeOne(it, ident, ctx), { keyOf: (it) => ({ id: it.id }) });
    // EI-14676: the generic bulk contract's top-level `ok` means "the batch ran" (see
    // _bulk.ts) — correct for an explicit N-item `items:[…]` batch, where partial failure
    // across items is expected and `counts.failed` is the right signal to check. But the
    // single-item shorthand ({ id, completion }) is how the overwhelming majority of callers
    // use this tool, and to them there is no "batch": there is exactly one completion that
    // either converged or it didn't. Reporting a structurally-hardcoded `ok:true` there, while
    // the ONE item's own `ok` is false (a state write that failed to land, a close-intent state
    // that landed non-terminal, or a finish leg — plan-status/claim-release/checkpoint-clear —
    // that didn't converge), is exactly how an agent can read the envelope, see `ok:true`, and
    // write a "TERMINAL — do not re-open" checkpoint off a call that never actually closed the
    // item (EI-14676: WI-5218 stayed state:'open'/terminalOwner:null while the completing agent
    // believed, and recorded, that it had converged). So for the single-item form the
    // caller-visible top-level `ok` IS the item's own `ok` — impossible to miss without opening
    // `results[0]`. The explicit-batch form keeps the standard bulk semantics unchanged.
    const result = isBulkForm || env.results.length !== 1 ? env : { ...env, ok: env.results[0].ok };
    return bulkContent(result);
  },
});
