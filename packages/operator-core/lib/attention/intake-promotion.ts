/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-006 (D-013) — execute a
 * recorded intake decision against its source work-item.
 *
 * P-004 records a typed, attributable decision on the bulk run
 * (`attention_bulk_run_items.intake_decision`). This module is the ONLY place that
 * turns one into canonical work:
 *
 *   promote / investigate → exactly one ready canonical item (R-5), sealed with the
 *       P-005 acceptance contract. A suitable candidate keeps its id (promoted in
 *       place); an observation, or a candidate of a different kind, yields a distinct
 *       item and the source is retained (R-22). The item's source link, acceptance
 *       provenance and promotion receipt ride in ONE write (R-23).
 *   merge  → the source's evidence is appended to an existing target with
 *       bidirectional links; a distinct remedy keeps its own obligation (R-28).
 *   retain / reject → a triage disposition with an occurrence watermark; nothing is
 *       deleted or terminalized, and a later occurrence reopens the SAME decision
 *       (R-29).
 *   retry  → executes nothing: the input stays in intake (refused as not executable).
 *
 * Idempotency: a promotion is keyed `intake-exec:<sourceId>:<sourceRevision>`, and the
 * key is stored on the promoted row in the same write that promotes it. A UNIQUE
 * partial index on that key (migration 1298) makes "one row per key" a database
 * guarantee: a double accept, an overlapping run or a retry racing a slow first
 * attempt loses with a unique violation and converges on the row that already carries
 * the key. Executions for one source are additionally serialized by a bounded,
 * transaction-scoped advisory lock (so merge appends and dispositions do not
 * interleave), but correctness against duplicate work never depends on that lock.
 * Graph edges and the source pointer are completed idempotently on every convergence.
 *
 * Staleness: a promote/investigate decision is bound to the source revision the
 * resolver judged (`decision.sourceRevision`, stamped server-side at report time). An
 * edited source no longer matches and the promotion is refused — the decision never
 * becomes a ready receipt for content nobody reviewed.
 *
 * Server-only. The browser-shared terminal dispatcher reaches this through an
 * injected dependency (`executeIntakeDecision`).
 */
import { isDeepStrictEqual } from 'node:util';

// Static on purpose: a lazily `import()`ed DB accessor was observed resolving to two
// different clients for two concurrent executors (one per first-use import), so their
// advisory locks never contended. One module record ⇒ one client.
import { getOrgPg } from '@papercusp/db-org';

import type { BulkIntakeDecision } from './bulk-dispositions';
import {
  createIssue,
  getIssue,
  issueRef,
  linkIssue,
  mergeIssuePayload,
  setIssueState,
} from '../issues-engineer';
import {
  acceptanceSourceRevision,
  createImplementationReadiness,
  evaluateImplementationAcceptance,
  readImplementationAcceptanceProposal,
  readImplementationReadiness,
  sealImplementationAcceptance,
  type ImplementationAcceptanceContract,
  type ImplementationAcceptanceProposal,
} from '../harness/improvements/agent-review-policy';
import { neutralizeToolCallTags, sanitizePersistedText } from '../text-safety';

export const INTAKE_EXECUTION_SCHEMA_VERSION = 'intake-execution-v1' as const;

/** Terminal storage states — an item in one of these is not suitable work. */
const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed']);
const WORK_KINDS = new Set(['bug', 'change', 'task']);

export type IntakeStorageKind = 'bug' | 'change' | 'task';

/** The slice of a work-item this module reads. */
export interface IntakeWorkItem {
  id: string;
  kind: string;
  title: string;
  /** Storage `summary` (the issue body) — part of the acceptance source revision. */
  body: string;
  state: string;
  scope: string;
  severity?: string | null;
  createdBy: string | null;
  payload: unknown;
}

export interface IntakeExecutionInput {
  sourceId: string;
  decision: BulkIntakeDecision;
  /** Bulk run + attention item the decision was recorded on (the receipt's origin). */
  runId: string;
  itemId: string;
}

export type IntakeExecutionOutcome = 'promoted' | 'merged' | 'retained' | 'rejected';

export type IntakeExecutionRefusal =
  | 'source-not-found'
  | 'source-terminal'
  | 'retry-not-executable'
  | 'source-revision-unjudged'
  | 'source-revision-changed'
  | 'acceptance-incomplete'
  | 'acceptance-invalid-authority'
  | 'merge-target-missing'
  | 'merge-target-not-found'
  | 'merge-target-terminal'
  | 'merge-target-is-source'
  | 'already-merged-elsewhere';

export type IntakeExecutionResult =
  | {
      ok: true;
      outcome: IntakeExecutionOutcome;
      sourceId: string;
      /** The canonical item the decision now points at (null for retain/reject). */
      workItemId: string | null;
      /** promote: was a NEW item created (vs. in-place / converged)? */
      created: boolean;
      /** true when this call found the effect already applied and only completed it. */
      converged: boolean;
      mode?: 'in-place' | 'distinct';
      /** merge: did the source carry a remedy distinct from the target's? */
      distinctRemedy?: boolean;
    }
  | { ok: false; refusal: IntakeExecutionRefusal; detail: string; missing?: string[] };

export interface IntakeCreateInput {
  kind: IntakeStorageKind;
  title: string;
  body: string;
  scope: string;
  severity?: string | null;
  createdBy: string;
  payload: Record<string, unknown>;
}

export interface IntakePromotionDeps {
  /** Run `fn` while holding transaction-scoped advisory locks on every id. */
  withLocks<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T>;
  getItem(id: string): Promise<IntakeWorkItem | null>;
  /** The one row carrying this promotion key (unique index, migration 1298). */
  findByPromotionKey(key: string): Promise<IntakeWorkItem | null>;
  /** Every item whose `payload.intakeSource.id` names this source. */
  findPromotedFromSource(sourceId: string): Promise<IntakeWorkItem[]>;
  /** ONE insert carrying the whole payload (source link + acceptance + receipt). */
  createItem(input: IntakeCreateInput): Promise<IntakeWorkItem>;
  /** Shallow top-level payload merge in ONE update. */
  mergePayload(id: string, patch: Record<string, unknown>): Promise<IntakeWorkItem | null>;
  /** Idempotent relation edge src → dst. */
  link(srcId: string, dstId: string, rel: string, by: string): Promise<void>;
  /** Close a candidate whose obligation is fully carried by the merge target. */
  closeAsDuplicate(id: string, targetId: string, by: string, reason: string): Promise<void>;
  /** Highest `work_item_occurrences.occurrence_id` for the item (null when none). */
  latestOccurrenceId(id: string): Promise<number | null>;
  now(): Date;
}

/** Relations written by promotion and merge (coord_links). */
export const INTAKE_LINK_RELS = {
  promotedTo: 'promoted-to',
  promotedFrom: 'promoted-from',
  mergedInto: 'merged-into',
  mergedFrom: 'merged-from',
} as const;

export function intakePromotionKey(sourceId: string, sourceRevision: string): string {
  return `intake-exec:${sourceId}:${sourceRevision}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isObservation(item: IntakeWorkItem): boolean {
  return record(item.payload).lane === 'observation';
}

function isTerminal(item: IntakeWorkItem): boolean {
  return TERMINAL_STATES.has(item.state);
}

/** The acceptance-revision source of a stored item. */
export function intakeSourceRevision(item: Pick<IntakeWorkItem, 'kind' | 'title' | 'body'>): string {
  return acceptanceSourceRevision({ kind: item.kind, title: item.title, summary: item.body ?? '' });
}

/**
 * The revision the resolver is judging when it records a decision. Called by the
 * report path so the decision carries it; a later edit to the source then makes the
 * promotion refuse instead of sealing unreviewed content.
 */
export async function currentIntakeSourceRevision(
  sourceId: string | null | undefined,
  deps: Pick<IntakePromotionDeps, 'getItem'> = defaultIntakePromotionDeps(),
): Promise<string | null> {
  if (!sourceId) return null;
  const source = await deps.getItem(sourceId);
  return source ? intakeSourceRevision(source) : null;
}

/** promote → bug/change (default: the candidate's own kind; observations default to a fix); investigate → task. */
export function intakeTargetKind(decision: BulkIntakeDecision, source: IntakeWorkItem): IntakeStorageKind {
  if (decision.disposition === 'investigate') return 'task';
  if (decision.workKind === 'fix') return 'bug';
  if (decision.workKind === 'build') return 'change';
  if (!isObservation(source) && WORK_KINDS.has(source.kind)) return source.kind as IntakeStorageKind;
  return 'bug';
}

function mergedProposal(
  source: IntakeWorkItem,
  decision: BulkIntakeDecision,
): Partial<ImplementationAcceptanceProposal> {
  const proposal: Partial<ImplementationAcceptanceProposal> = readImplementationAcceptanceProposal(source.payload);
  const supplied = decision.acceptance ?? null;
  if (!supplied) return proposal;
  // The decision's drafted fields win: the resolver judged exactly what it wrote.
  for (const field of ['problem', 'outcome', 'scope', 'completionCheck'] as const) {
    const value = supplied[field];
    if (typeof value === 'string' && value.trim()) proposal[field] = value.trim();
  }
  if (Array.isArray(supplied.evidence)) {
    const evidence = supplied.evidence.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim());
    if (evidence.length > 0) proposal.evidence = evidence;
  }
  return proposal;
}

function normalizeRemedy(value: string | undefined | null): string | null {
  const text = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return text || null;
}

interface PromotionReceipt {
  schemaVersion: typeof INTAKE_EXECUTION_SCHEMA_VERSION;
  key: string;
  disposition: 'promote' | 'investigate';
  sourceId: string;
  sourceRevision: string;
  mode: 'in-place' | 'distinct';
  targetKind: IntakeStorageKind;
  runId: string;
  itemId: string;
  decidedBy: string;
  reason: string;
  promotedAt: string;
}

/** The stored receipt on an item, when it is a current-version one. */
export function readIntakePromotionReceipt(payload: unknown): PromotionReceipt | null {
  const receipt = record(record(payload).intakePromotion);
  if (receipt.schemaVersion !== INTAKE_EXECUTION_SCHEMA_VERSION || typeof receipt.key !== 'string') return null;
  return receipt as unknown as PromotionReceipt;
}

export interface IntakeDispositionState {
  disposition: 'retain' | 'reject';
  reason: string;
  decidedBy: string;
  occurrenceWatermark: number | null;
  /** New evidence arrived after the decision: the SAME decision is open again (R-29). */
  reopened: boolean;
}

/** Derive the retain/reject decision state at read time from the occurrence series. */
export function readIntakeDispositionState(
  payload: unknown,
  latestOccurrenceId: number | null,
): IntakeDispositionState | null {
  const stored = record(record(payload).intakeDisposition);
  if (stored.schemaVersion !== INTAKE_EXECUTION_SCHEMA_VERSION) return null;
  if (stored.disposition !== 'retain' && stored.disposition !== 'reject') return null;
  const watermark = typeof stored.occurrenceWatermark === 'number' ? stored.occurrenceWatermark : null;
  return {
    disposition: stored.disposition,
    reason: String(stored.reason ?? ''),
    decidedBy: String(stored.decidedBy ?? ''),
    occurrenceWatermark: watermark,
    reopened: latestOccurrenceId != null && latestOccurrenceId > (watermark ?? 0),
  };
}

/**
 * Execute one recorded intake decision. Refusals write nothing; every success is
 * idempotent under retry, double accept and overlapping runs.
 */
export async function executeIntakeDecision(
  input: IntakeExecutionInput,
  deps: IntakePromotionDeps = defaultIntakePromotionDeps(),
): Promise<IntakeExecutionResult> {
  const { decision } = input;
  if (decision.disposition === 'retry') {
    return {
      ok: false,
      refusal: 'retry-not-executable',
      detail: `a retry decision executes nothing; ${input.sourceId} stays in intake until this is supplied: ${decision.missingInformation ?? 'the missing information'}`,
    };
  }
  if (decision.disposition === 'merge') return executeMerge(input, deps);
  if (decision.disposition === 'retain' || decision.disposition === 'reject') return executeDisposition(input, deps);
  return executePromotion(input, deps);
}

async function executePromotion(input: IntakeExecutionInput, deps: IntakePromotionDeps): Promise<IntakeExecutionResult> {
  const { decision } = input;
  const disposition = decision.disposition as 'promote' | 'investigate';
  return deps.withLocks([input.sourceId], async () => {
    const source = await deps.getItem(input.sourceId);
    if (!source) return { ok: false, refusal: 'source-not-found', detail: `${input.sourceId} does not exist` };
    const sourceRevision = intakeSourceRevision(source);
    const key = intakePromotionKey(source.id, sourceRevision);
    const targetKind = intakeTargetKind(decision, source);
    const inPlace = !isObservation(source) && source.kind === targetKind;

    // ── convergence: this source revision was already promoted (one row per key) ──
    const existing = await deps.findByPromotionKey(key);
    if (existing && existing.id !== source.id) {
      await completeDistinctPromotion(source, existing, input, key, deps);
      return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: existing.id, created: false, converged: true, mode: 'distinct' };
    }
    if (existing) {
      const verdict = evaluateImplementationAcceptance(source.payload, {
        kind: source.kind,
        title: source.title,
        summary: source.body,
      });
      if (verdict.state === 'qualifying') {
        return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: source.id, created: false, converged: true, mode: 'in-place' };
      }
      // Receipt present but the row no longer qualifies: re-seal it under the same key below.
    }
    if (!inPlace) {
      const prior = await deps.findPromotedFromSource(source.id);
      const earlier = prior.find((item) => !isTerminal(item) && readIntakePromotionReceipt(item.payload));
      if (earlier) {
        return {
          ok: false,
          refusal: 'source-revision-changed',
          detail: `${source.id} was already promoted to ${earlier.id} at an earlier revision; the source has changed since, so this decision does not describe that promotion. Re-review the source against ${earlier.id}.`,
        };
      }
    }

    // ── preconditions (refusals write nothing) ──────────────────────────────
    if (isTerminal(source) && inPlace) {
      return { ok: false, refusal: 'source-terminal', detail: `${source.id} is ${source.state}; a closed candidate cannot become ready work` };
    }
    if (!decision.sourceRevision) {
      return {
        ok: false,
        refusal: 'source-revision-unjudged',
        detail: `the ${disposition} decision for ${source.id} does not record which source revision was judged; record the decision again so it is bound to the content reviewed`,
      };
    }
    if (decision.sourceRevision !== sourceRevision) {
      return {
        ok: false,
        refusal: 'source-revision-changed',
        detail: `${source.id} changed after the ${disposition} decision was recorded (judged ${decision.sourceRevision.slice(0, 18)}…, now ${sourceRevision.slice(0, 18)}…); re-review the current content`,
      };
    }
    const submittedBy = source.createdBy?.trim() || '';
    if (!submittedBy) {
      return {
        ok: false,
        refusal: 'acceptance-invalid-authority',
        detail: `${source.id} has no recorded filer, so reviewer independence cannot be established`,
      };
    }

    const now = deps.now().toISOString();
    const receipt: PromotionReceipt = {
      schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION,
      key,
      disposition,
      sourceId: source.id,
      sourceRevision,
      mode: inPlace ? 'in-place' : 'distinct',
      targetKind,
      runId: input.runId,
      itemId: input.itemId,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
      promotedAt: now,
    };
    const round = Number(record(record(source.payload).agentReview).round) || 1;
    const authority = { kind: 'agent-review', reviewer: decision.decidedBy, submittedBy, round } as const;
    const proposal = mergedProposal(source, decision);

    if (inPlace) {
      const sealed = sealImplementationAcceptance({
        proposal,
        authority,
        reason: `intake ${disposition}: ${decision.reason}`,
        source: { kind: source.kind, title: source.title, summary: source.body },
        acceptedAt: now,
      });
      if (!sealed.ok) return sealRefusal(sealed, source.id);
      let merged: IntakeWorkItem | null;
      try {
        merged = await deps.mergePayload(source.id, {
          implementationReadiness: readyReadiness(source.payload, sealed.contract, authority, now),
          intakeSource: { id: source.id, mode: 'in-place', revision: sourceRevision },
          intakePromotion: receipt,
        });
      } catch (error) {
        const converged = await convergeOnKeyConflict(error, source, input, key, deps);
        if (converged) return converged;
        throw error;
      }
      if (!merged) return { ok: false, refusal: 'source-not-found', detail: `${source.id} disappeared during promotion` };
      return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: source.id, created: false, converged: false, mode: 'in-place' };
    }

    // Distinct item: seal against the content the NEW row will store, so the
    // contract's revision is the one its own readers recompute.
    const title = sanitizePersistedText(neutralizeToolCallTags(source.title)) ?? source.title;
    const body = sanitizePersistedText(neutralizeToolCallTags(source.body)) ?? source.body ?? '';
    const sealed = sealImplementationAcceptance({
      proposal,
      authority,
      reason: `intake ${disposition}: ${decision.reason}`,
      source: { kind: targetKind, title, summary: body },
      acceptedAt: now,
    });
    if (!sealed.ok) return sealRefusal(sealed, source.id);
    let created: IntakeWorkItem;
    try {
      created = await deps.createItem({
        kind: targetKind,
        title,
        body,
        scope: source.scope,
        severity: source.severity ?? null,
        createdBy: decision.decidedBy,
        payload: {
          implementationReadiness: readyReadiness(undefined, sealed.contract, authority, now),
          intakeSource: {
            id: source.id,
            mode: 'distinct',
            revision: sourceRevision,
            observation: isObservation(source),
            kind: source.kind,
          },
          intakePromotion: receipt,
        },
      });
    } catch (error) {
      const converged = await convergeOnKeyConflict(error, source, input, key, deps);
      if (converged) return converged;
      throw error;
    }
    await completeDistinctPromotion(source, created, input, key, deps);
    return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: created.id, created: true, converged: false, mode: 'distinct' };
  });
}

/** The unique index that fences one row per promotion key (migration 1298). */
export const INTAKE_PROMOTION_KEY_INDEX = 'work_items_intake_promotion_key_uniq';

/** Is this (possibly wrapped) error a unique violation of the promotion-key fence? */
export function isPromotionKeyConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '23505') {
      const constraint = String(e.constraint_name ?? e.constraint ?? '');
      if (constraint === INTAKE_PROMOTION_KEY_INDEX || String(e.message ?? '').includes(INTAKE_PROMOTION_KEY_INDEX)) return true;
    }
    current = e.cause;
  }
  return false;
}

/** A concurrent executor won the key: converge on its row instead of failing. */
async function convergeOnKeyConflict(
  error: unknown,
  source: IntakeWorkItem,
  input: IntakeExecutionInput,
  key: string,
  deps: IntakePromotionDeps,
): Promise<IntakeExecutionResult | null> {
  if (!isPromotionKeyConflict(error)) return null;
  const winner = await deps.findByPromotionKey(key);
  if (!winner) return null;
  if (winner.id === source.id) {
    return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: source.id, created: false, converged: true, mode: 'in-place' };
  }
  await completeDistinctPromotion(source, winner, input, key, deps);
  return { ok: true, outcome: 'promoted', sourceId: source.id, workItemId: winner.id, created: false, converged: true, mode: 'distinct' };
}

function sealRefusal(
  sealed: { ok: false; refusal: 'incomplete'; missing: string[] } | { ok: false; refusal: 'invalid-authority' },
  sourceId: string,
): IntakeExecutionResult {
  if (sealed.refusal === 'incomplete') {
    return {
      ok: false,
      refusal: 'acceptance-incomplete',
      missing: sealed.missing,
      detail: `${sourceId} cannot be accepted: the acceptance contract is missing ${sealed.missing.join(', ')}; supply them on the decision (acceptance) or the source proposal`,
    };
  }
  return {
    ok: false,
    refusal: 'acceptance-invalid-authority',
    detail: `${sourceId} cannot be accepted: the decider is the source's own filer (self-review is not acceptance authority)`,
  };
}

function readyReadiness(
  existingPayload: unknown,
  contract: ImplementationAcceptanceContract,
  authority: { reviewer: string; submittedBy: string; round: number },
  now: string,
) {
  const existing = readImplementationReadiness(existingPayload)?.evidence ?? {};
  return createImplementationReadiness({
    status: 'ready',
    source: 'agent-review',
    reason: 'intake-promotion',
    updatedAt: now,
    evidence: {
      ...existing,
      review: { submittedBy: authority.submittedBy, reviewer: authority.reviewer, round: authority.round },
      acceptance: contract,
    },
  });
}

/** Idempotently finish a distinct promotion: graph edges, then the source pointer. */
async function completeDistinctPromotion(
  source: IntakeWorkItem,
  promoted: IntakeWorkItem,
  input: IntakeExecutionInput,
  key: string,
  deps: IntakePromotionDeps,
): Promise<void> {
  const by = input.decision.decidedBy;
  await deps.link(promoted.id, source.id, INTAKE_LINK_RELS.promotedFrom, by);
  await deps.link(source.id, promoted.id, INTAKE_LINK_RELS.promotedTo, by);
  const pointer = {
    schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION,
    disposition: input.decision.disposition,
    workItemId: promoted.id,
    key,
    runId: input.runId,
    itemId: input.itemId,
    decidedBy: by,
  };
  const existing = record(record(source.payload).intakeExecution);
  const { at: _at, ...existingComparable } = existing;
  if (isDeepStrictEqual(existingComparable, pointer)) return;
  await deps.mergePayload(source.id, { intakeExecution: { ...pointer, at: deps.now().toISOString() } });
}

async function executeMerge(input: IntakeExecutionInput, deps: IntakePromotionDeps): Promise<IntakeExecutionResult> {
  const { decision } = input;
  const targetId = decision.targetRef?.trim() ?? '';
  if (!targetId) return { ok: false, refusal: 'merge-target-missing', detail: 'a merge decision must name its target' };
  if (targetId === input.sourceId) {
    return { ok: false, refusal: 'merge-target-is-source', detail: `${input.sourceId} cannot merge into itself` };
  }
  return deps.withLocks([input.sourceId, targetId], async () => {
    const source = await deps.getItem(input.sourceId);
    if (!source) return { ok: false, refusal: 'source-not-found', detail: `${input.sourceId} does not exist` };
    const target = await deps.getItem(targetId);
    if (!target) return { ok: false, refusal: 'merge-target-not-found', detail: `merge target ${targetId} does not exist` };
    if (isTerminal(target)) {
      return { ok: false, refusal: 'merge-target-terminal', detail: `merge target ${targetId} is ${target.state}; merge into live work` };
    }
    const sourceExecution = record(record(source.payload).intakeExecution);
    if (sourceExecution.disposition === 'merge' && sourceExecution.workItemId && sourceExecution.workItemId !== target.id) {
      return {
        ok: false,
        refusal: 'already-merged-elsewhere',
        detail: `${source.id} was already merged into ${String(sourceExecution.workItemId)}`,
      };
    }

    const sourceOutcome = normalizeRemedy(readImplementationAcceptanceProposal(source.payload).outcome);
    const targetOutcome = normalizeRemedy(readImplementationAcceptanceProposal(target.payload).outcome);
    const distinctRemedy = sourceOutcome !== null && sourceOutcome !== targetOutcome;

    const mergedSources = Array.isArray(record(target.payload).intakeMergedSources)
      ? (record(target.payload).intakeMergedSources as unknown[])
      : [];
    const already = mergedSources.some((entry) => record(entry).sourceId === source.id);
    const now = deps.now().toISOString();
    if (!already) {
      const proposal = readImplementationAcceptanceProposal(source.payload);
      await deps.mergePayload(target.id, {
        intakeMergedSources: [
          ...mergedSources,
          {
            sourceId: source.id,
            sourceKind: source.kind,
            observation: isObservation(source),
            sourceRevision: intakeSourceRevision(source),
            title: source.title,
            evidence: proposal.evidence ?? [],
            outcome: proposal.outcome ?? null,
            distinctRemedy,
            decidedBy: decision.decidedBy,
            reason: decision.reason,
            runId: input.runId,
            itemId: input.itemId,
            mergedAt: now,
          },
        ],
      });
    }
    await deps.link(source.id, target.id, INTAKE_LINK_RELS.mergedInto, decision.decidedBy);
    await deps.link(target.id, source.id, INTAKE_LINK_RELS.mergedFrom, decision.decidedBy);
    if (sourceExecution.disposition !== 'merge') {
      await deps.mergePayload(source.id, {
        intakeExecution: {
          schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION,
          disposition: 'merge',
          workItemId: target.id,
          distinctRemedy,
          runId: input.runId,
          itemId: input.itemId,
          decidedBy: decision.decidedBy,
          reason: decision.reason,
          at: now,
        },
      });
    }
    // An observation is evidence and is always retained. A candidate whose
    // obligation is fully carried by the target closes as a duplicate; one with a
    // distinct remedy stays open with its own obligation.
    if (!isObservation(source) && !distinctRemedy && !isTerminal(source)) {
      await deps.closeAsDuplicate(
        source.id,
        target.id,
        decision.decidedBy,
        `merged into ${target.id} by intake decision (run ${input.runId}): ${decision.reason}`,
      );
    }
    return {
      ok: true,
      outcome: 'merged',
      sourceId: source.id,
      workItemId: target.id,
      created: false,
      converged: already,
      distinctRemedy,
    };
  });
}

async function executeDisposition(
  input: IntakeExecutionInput,
  deps: IntakePromotionDeps,
): Promise<IntakeExecutionResult> {
  const { decision } = input;
  const disposition = decision.disposition as 'retain' | 'reject';
  return deps.withLocks([input.sourceId], async () => {
    const source = await deps.getItem(input.sourceId);
    if (!source) return { ok: false, refusal: 'source-not-found', detail: `${input.sourceId} does not exist` };
    const stored = record(record(source.payload).intakeDisposition);
    const outcome: IntakeExecutionOutcome = disposition === 'retain' ? 'retained' : 'rejected';
    if (
      stored.schemaVersion === INTAKE_EXECUTION_SCHEMA_VERSION &&
      stored.disposition === disposition &&
      stored.runId === input.runId &&
      stored.itemId === input.itemId
    ) {
      return { ok: true, outcome, sourceId: source.id, workItemId: null, created: false, converged: true };
    }
    const watermark = await deps.latestOccurrenceId(source.id);
    const now = deps.now().toISOString();
    const patch: Record<string, unknown> = {
      intakeDisposition: {
        schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION,
        disposition,
        reason: decision.reason,
        decidedBy: decision.decidedBy,
        runId: input.runId,
        itemId: input.itemId,
        decidedAt: now,
        occurrenceWatermark: watermark,
      },
    };
    // A retained/rejected CANDIDATE is not accepted work: hold it out of claiming
    // with an affirmative not-ready verdict. The row and its occurrence series stay
    // exactly where they are — nothing is deleted or terminalized.
    if (!isObservation(source) && WORK_KINDS.has(source.kind)) {
      const existing = readImplementationReadiness(source.payload)?.evidence;
      patch.implementationReadiness = createImplementationReadiness({
        status: 'not-ready',
        source: 'agent-review',
        reason: `intake-${disposition}`,
        updatedAt: now,
        ...(existing ? { evidence: existing } : {}),
      });
    }
    await deps.mergePayload(source.id, patch);
    return { ok: true, outcome, sourceId: source.id, workItemId: null, created: false, converged: false };
  });
}

// ── default (Postgres) dependencies ───────────────────────────────────────────

function toIntakeWorkItem(issue: {
  id: string;
  kind: string;
  title: string;
  body: string;
  state: string;
  scope: string;
  severity?: string | null;
  createdBy: string | null;
  payload: unknown;
}): IntakeWorkItem {
  return {
    id: issue.id,
    kind: issue.kind,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    scope: issue.scope,
    severity: issue.severity ?? null,
    createdBy: issue.createdBy,
    payload: issue.payload,
  };
}

/**
 * Bound on WAITING for another executor's lock (never on holding it). The holder pins
 * one pooled connection for its transaction while its writes use others, so an
 * unbounded queue of waiters could pin the whole pool; a waiter past this budget fails
 * with PG 55P03 and its bulk item is recorded as failed and retryable. Duplicate work
 * is fenced by the unique index regardless (migration 1298).
 */
export const INTAKE_LOCK_WAIT_BUDGET_MS = 10_000;

/**
 * Connection budget of {@link defaultIntakePromotionDeps}' withLocks: the lock
 * transaction pins one pooled connection for the whole of `fn`, and `fn`'s writers
 * (createIssue, mergeIssuePayload, linkIssue, setIssueState) run on the SAME pool, so
 * a holder needs two connections and every concurrent waiter pins one more until it
 * acquires or its {@link INTAKE_LOCK_WAIT_BUDGET_MS} wait fails (55P03, retryable).
 * On a one-connection pool the holder would wait forever for its own writers, with
 * no timeout to end it (lock_timeout bounds only the lock wait, not a client-side
 * pool wait), so that configuration is refused loudly instead of hanging.
 */
export const INTAKE_LOCK_MIN_POOL = 2;

export function assertIntakeLockPool(sql: { options?: { max?: unknown } }): void {
  const max = sql.options?.max;
  if (typeof max === 'number' && max < INTAKE_LOCK_MIN_POOL) {
    throw new Error(
      `intake promotion needs a Postgres pool of at least ${INTAKE_LOCK_MIN_POOL} connections (got max=${max}): ` +
        'the advisory-lock transaction pins one connection while the promotion writes use another',
    );
  }
}

export function defaultIntakePromotionDeps(): IntakePromotionDeps {
  const orgSql = () => getOrgPg().sql;
  return {
    async withLocks(ids, fn) {
      const sql = orgSql();
      assertIntakeLockPool(sql);
      const keys = [...new Set(ids)].sort();
      // The advisory locks live for this transaction; `fn` runs while it is open,
      // so every executor for an overlapping source waits here and then sees the
      // committed result of the one before it.
      let result!: Awaited<ReturnType<typeof fn>>;
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('lock_timeout', ${String(INTAKE_LOCK_WAIT_BUDGET_MS)}, true)`;
        for (const id of keys) {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`intake-exec:${id}`}, 0))`;
        }
        await tx`SELECT set_config('lock_timeout', '0', true)`;
        result = await fn();
      });
      return result;
    },
    async getItem(id) {
      const issue = await getIssue(id);
      return issue ? toIntakeWorkItem(issue) : null;
    },
    async findByPromotionKey(key) {
      const rows = await orgSql()<{ feature_id: string }[]>`
        SELECT feature_id
          FROM harness_shared.work_items
         WHERE payload ? 'intakePromotion'
           AND payload -> 'intakePromotion' ->> 'key' = ${key}
         LIMIT 1`;
      if (!rows[0]) return null;
      const issue = await getIssue(rows[0].feature_id);
      return issue ? toIntakeWorkItem(issue) : null;
    },
    async findPromotedFromSource(sourceId) {
      const sql = orgSql();
      const rows = await sql<{ feature_id: string }[]>`
        SELECT w.feature_id
          FROM harness_shared.work_items w
         WHERE w.workspace_id IN (
                 SELECT s.workspace_id FROM harness_shared.work_items s WHERE s.feature_id = ${sourceId})
           AND w.item_kind = ANY (ARRAY['bug', 'change', 'task'])
           AND w.payload -> 'intakeSource' ->> 'id' = ${sourceId}
           AND w.feature_id <> ${sourceId}
         ORDER BY w.created_ts`;
      const items: IntakeWorkItem[] = [];
      for (const row of rows) {
        const issue = await getIssue(row.feature_id);
        if (issue) items.push(toIntakeWorkItem(issue));
      }
      return items;
    },
    async createItem(input) {
      const created = await createIssue({
        kind: input.kind,
        title: input.title,
        body: input.body,
        scope: input.scope,
        ...(input.severity ? { severity: input.severity as never } : {}),
        createdBy: input.createdBy,
        payload: input.payload,
      });
      return toIntakeWorkItem(created);
    },
    async mergePayload(id, patch) {
      const merged = await mergeIssuePayload(id, patch);
      return merged ? toIntakeWorkItem(merged) : null;
    },
    async link(srcId, dstId, rel, by) {
      await linkIssue(srcId, issueRef(dstId), rel, by);
    },
    async closeAsDuplicate(id, _targetId, by, reason) {
      await setIssueState(id, 'dropped', by, reason);
    },
    async latestOccurrenceId(id) {
      const rows = await orgSql()<{ latest: string | number | null }[]>`
        SELECT max(occurrence_id) AS latest
          FROM harness_shared.work_item_occurrences
         WHERE canonical_work_item_id = ${id}`;
      const latest = rows[0]?.latest;
      return latest == null ? null : Number(latest);
    },
    now: () => new Date(),
  };
}
