/**
 * Work-item operational brief (plan use-existing-router-for-review-requests-2026-09-08
 * P-008, spec OP-BRIEF-P008-WORKITEM): claim/state, blocked-on dependencies, last
 * verified evidence, next action and successor residue, projected from ONE
 * work_items:get result row. Nothing here reads a store: every value comes from a
 * field the work_items:get handler already read for that row, and anything the read
 * did not measure is an explicit `unknown` with a reason — never a silent zero.
 *
 * The falsifier this module exists to satisfy: the brief must never HIDE an active
 * claim, a blocked dependency, a missing checkpoint, or successor residue that the
 * same read exposes. So the claim, the checkpoint status and every blocker source are
 * always projected (as known values or as named gaps), and free-form checkpoint prose
 * is never promoted into a next action — only the carry-note `## Next action`
 * section is, because anything else is a guess about what the holder meant.
 */
import { parseCarryNote, type CarryNoteFields } from '../carry-note';
import { activeExternalBlockers } from '../external-blockers';
import {
  finalizeOperationalBrief,
  known,
  unknown,
  type BriefField,
  type BriefVerifiedEvidence,
  type OperationalBrief,
} from './brief';

type Rec = Record<string, unknown>;

/** Terminal work-item states across the feature and issue families. */
const TERMINAL = new Set(['done', 'dropped', 'closed', 'resolved']);

export interface WorkItemBriefClaim {
  assignee: string | null;
  takenAt: string | null;
  lastProgressAt: string | null;
  /** The holder's declared goal as coord presence reports it, when the read carried one. */
  holderGoal: string | null;
  /** True when coord presence flags the holder's declared intent as not progressing. */
  holderStale: boolean | null;
}

export interface WorkItemBriefCheckpoint {
  status: 'available' | 'absent';
  updatedAt: string | null;
  contentHash: string | null;
  /** Whether the checkpoint uses the structured carry-note sections. */
  structured: boolean;
}

export interface WorkItemBriefResidue {
  left: string | null;
  walls: string[];
}

export interface WorkItemDeliveryEvidence {
  state: 'reported' | 'confirmed' | 'stale' | 'absent';
  ref: string;
  summary: string;
}

export interface WorkItemBriefFacts extends Record<string, unknown> {
  kind: string | null;
  plan: { slug: string; itemIds: string[] } | null;
  claim: BriefField<WorkItemBriefClaim>;
  checkpoint: BriefField<WorkItemBriefCheckpoint>;
  successorResidue: BriefField<WorkItemBriefResidue>;
  /** Items THIS item holds up (outgoing `blocks`: src blocks dst); only measured
   * when the read loaded the item's outgoing links (`detail:true`). */
  holdsUp: BriefField<string[]>;
  /** Incoming `blocks` edges (other items that must finish first). work_items:get
   * never reads incoming edges, so this is always an explicit gap with a pointer —
   * never a silent "no dependencies". */
  blockedByLinks: BriefField<string[]>;
  settlement: BriefField<string>;
  delivery: Record<'localTests' | 'committedSource' | 'runtimeAdoption' | 'independentAcceptance' | 'shipment', BriefField<WorkItemDeliveryEvidence>>;
}

export type WorkItemOperationalBrief = OperationalBrief<WorkItemBriefFacts>;

export interface ProjectWorkItemBriefOptions {
  /** True when the row was read with `detail:true`, so `workItem.links` is present. */
  linksRead: boolean;
  /** Hash-validated current authored span from getWorkItemCheckpointWithMeta. */
  latestUpdate?: { status: 'available' | 'unknown'; text: string | null };
}

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isoFromMs(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function isStructured(fields: CarryNoteFields): boolean {
  return Boolean(
    fields.did || fields.left || fields.insight || fields.next || fields.walls?.length || fields.checks?.length,
  );
}

function readPlan(workItem: Rec): { slug: string; itemIds: string[] } | null {
  const slug = str(workItem.sourcePlanSlug);
  if (!slug) return null;
  const ids = Array.isArray(workItem.sourcePlanItemIds)
    ? workItem.sourcePlanItemIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { slug, itemIds: ids };
}

/** Blocker sources the row carries: the plan-item lane guard and set_blocker records.
 * The payload is required to see set_blocker records, so a row without it is a gap. */
function readBlockers(row: Rec, workItem: Rec, state: string | null): BriefField<string[]> {
  const out: string[] = [];
  const sources: string[] = [];
  const lane = rec(row.planItemBlocked);
  if (lane) {
    const reason = str(lane.reason);
    out.push(
      `plan item ${str(lane.planSlug) ?? '?'}#${str(lane.itemId) ?? '?'} is ${str(lane.effectiveStatus) ?? 'blocked'}` +
        (reason ? ` (${reason})` : ''),
    );
    sources.push('work_items:get.planItemBlocked');
  }
  if (!('payload' in workItem)) {
    return unknown('the work-item payload is not in this read, so set_blocker records are unmeasured');
  }
  for (const blocker of activeExternalBlockers(workItem.payload)) {
    out.push(`${blocker.kind} blocker ${blocker.ref}: ${blocker.summary}${blocker.nextVerb ? ` (next: ${blocker.nextVerb})` : ''}`);
  }
  sources.push('workItem.payload external blockers (active)');
  if (out.length === 0 && state === 'blocked') {
    out.push('state is blocked but no blocker reason is recorded');
  }
  return known(out, sources.join(' + '));
}

/** Outgoing `blocks` links are `{ rel, dst: { kind, ref } }` with src = this item. */
function readHoldsUp(workItem: Rec, options: ProjectWorkItemBriefOptions): BriefField<string[]> {
  if (!options.linksRead || !Array.isArray(workItem.links)) {
    return unknown('outgoing work-item links are read only with detail:true');
  }
  const held = workItem.links
    .map(rec)
    .filter((link): link is Rec => link !== null && str(link.rel) === 'blocks')
    .map((link) => {
      const dst = rec(link.dst);
      return dst ? `${str(dst.kind) ?? 'object'}:${str(dst.ref) ?? '?'}` : '(unreadable link target)';
    });
  return known(held, 'workItem.links (outgoing rel=blocks)');
}

function readLastVerified(row: Rec, id: string): BriefField<BriefVerifiedEvidence> {
  const completion = rec(row.completion);
  if (row.hasCompletionEvidence === true && completion) {
    const summary = str(completion.verifiedHow) ?? str(completion.summary) ?? str(completion.testResult);
    if (summary) {
      const workItem = rec(row.workItem) ?? {};
      return known(
        { ref: `${id}#completion`, at: str(workItem.closedAt) ?? str(workItem.updatedAt), summary },
        'work_items:get.completion',
      );
    }
  }
  return unknown('no completion evidence is recorded; checkpoint prose is a claim, not verification');
}

function readDelivery(row: Rec, id: string): WorkItemBriefFacts['delivery'] {
  const completion = rec(row.completion);
  const evidence = (state: WorkItemDeliveryEvidence['state'], stage: string, summary: string) =>
    known({ state, ref: `${id}#${stage}`, summary }, `work_items:get.${stage}`);
  const tests = completion?.testsRun;
  const testsRun = Array.isArray(tests) ? tests.filter((entry): entry is string => !!str(entry)).join('; ') : str(tests);
  const result = str(completion?.testResult);
  const localTests = testsRun && result
    ? evidence('reported', 'completion', `${testsRun}: ${result} (reported completion evidence; test ledger not read)`)
    : unknown<WorkItemDeliveryEvidence>('completion.testsRun/testResult are missing; test ledger not read');

  const stamp = rec(completion?.treeStamp);
  const freshness = rec(row.completionFreshness);
  const identities = Array.isArray(stamp?.contentIdentity) ? stamp.contentIdentity.map(rec) : [];
  const repoIdentities = identities.filter((entry) => entry?.outOfRepoArtifact !== true);
  let committedSource: BriefField<WorkItemDeliveryEvidence> = unknown('server-stamped source content identity and read-time completionFreshness are required');
  if (stamp && identities.length && repoIdentities.length && freshness) {
    if (freshness.verdict === 'stale') {
      committedSource = evidence('stale', 'completionFreshness', str(freshness.reason) ?? 'source evidence is stale');
    } else if (freshness.verdict === 'fresh') {
      const readable = repoIdentities.every((entry) => entry && str(entry.path) && !entry.headBlobUnresolvable &&
        (entry.deletion === true
          ? entry.workingTreeBlobSha === null && entry.headBlobSha === null
          : str(entry.workingTreeBlobSha) && str(entry.headBlobSha)));
      if (readable) {
        const matched = repoIdentities.every((entry) => entry!.deletion === true
          ? entry!.workingTreeBlobSha === null && entry!.headBlobSha === null
          : entry!.workingTreeBlobSha === entry!.headBlobSha);
        committedSource = evidence(matched ? 'confirmed' : 'absent', 'completion.treeStamp', matched
          ? 'declared source content matches Git HEAD; completion evidence is fresh'
          : 'declared source content differs from Git HEAD');
      }
    }
  }

  const position = rec(row.deploymentPosition);
  const declaredPaths = Array.isArray(completion?.filesChanged)
    ? [...new Set(completion.filesChanged.filter((path): path is string => !!str(path)))] : [];
  const paths = Array.isArray(position?.paths) ? position.paths.map(rec) : [];
  const complete = declaredPaths.length > 0 && position?.truncated === false && !position.unknownReason &&
    position.totalPaths === declaredPaths.length && paths.length === declaredPaths.length &&
    Array.isArray(position.unknownPaths) && position.unknownPaths.length === 0 &&
    new Set(paths.map((path) => path?.path)).size === declaredPaths.length &&
    paths.every((path) => path && declaredPaths.includes(String(path.path)) && str(path.targetSha) && str(path.deployedSha) &&
      typeof rec(path.positions)?.deployed === 'boolean' &&
      // compactPosition omits these optional markers when there are no exceptions.
      (path.positionsUnknown === undefined || (Array.isArray(path.positionsUnknown) && path.positionsUnknown.length === 0)) &&
      (path.positionsNewerCommit === undefined || (Array.isArray(path.positionsNewerCommit) && path.positionsNewerCommit.length === 0)));
  const runtimeAdoption: BriefField<WorkItemDeliveryEvidence> = complete
    ? evidence(paths.every((path) => rec(path!.positions)?.deployed === true) ? 'confirmed' : 'absent', 'deploymentPosition',
      paths.map((path) => `${path!.path}: target ${path!.targetSha}, deployed ${path!.deployedSha}, contained=${rec(path!.positions)?.deployed === true}`).join('; '))
    : unknown('exact-target deploymentPosition is missing, partial, degraded or marked as a newer-commit comparison; read dev:pipeline_position for the declared paths');
  return {
    localTests, committedSource, runtimeAdoption,
    independentAcceptance: unknown('independent acceptance receipts are not read here; read plans:get with shipReadiness:true for the source plan'),
    shipment: unknown('final shipment receipts are not read here; read the exact shipped-artifact release evidence'),
  };
}

/** Project one work_items:get result row. The row must be the handler's unshaped
 * result (payload present) for set_blocker records to be measured. */
export function projectWorkItemOperationalBrief(row: Rec, options: ProjectWorkItemBriefOptions): WorkItemOperationalBrief {
  const workItem = rec(row.workItem) ?? {};
  const id = str(row.id) ?? str(workItem.id) ?? '(unknown work-item)';
  const state = str(workItem.state);
  const terminal = state !== null && TERMINAL.has(state);
  const assignee = str(workItem.assignee);
  const holder = rec(row.holder);

  const claim: BriefField<WorkItemBriefClaim> = known(
    {
      assignee,
      takenAt: str(workItem.takenAt),
      lastProgressAt: str(workItem.lastProgressAt),
      holderGoal: holder ? str(holder.goalText) ?? str(holder.goalRef) : null,
      holderStale: holder && typeof holder.stale === 'boolean' ? holder.stale : null,
    },
    'work_items:get.workItem + holder',
  );

  const checkpointText = typeof row.checkpoint === 'string' ? row.checkpoint : null;
  const fullFields: CarryNoteFields = checkpointText ? parseCarryNote(checkpointText) : {};
  const latestUpdate = options.latestUpdate;
  let latestUpdateUnknown = false;
  let fields: CarryNoteFields;
  if (latestUpdate?.status === 'unknown') {
    latestUpdateUnknown = true;
    fields = {};
  } else if (latestUpdate?.status === 'available') {
    if (!latestUpdate.text) {
      latestUpdateUnknown = true;
      fields = {};
    } else {
      fields = parseCarryNote(latestUpdate.text);
    }
  } else if (!latestUpdate && /^---\s*$/m.test(checkpointText ?? '')) {
    // A preserved-history separator without a valid span makes the current
    // section unknowable; older carry instructions must not become current.
    latestUpdateUnknown = true;
    fields = {};
  } else {
    fields = fullFields;
  }
  const structured = checkpointText !== null && isStructured(latestUpdateUnknown ? fullFields : fields);

  let checkpoint: BriefField<WorkItemBriefCheckpoint>;
  if (row.checkpointReadFailed === true) {
    checkpoint = unknown('the checkpoint read failed, so it is not known whether one exists');
  } else if (!('checkpoint' in row)) {
    checkpoint = unknown('the checkpoint is not in this read');
  } else {
    checkpoint = known(
      {
        status: checkpointText ? 'available' : 'absent',
        updatedAt: isoFromMs(row.checkpointUpdatedAtMs),
        contentHash: str(row.checkpointContentHash),
        structured,
      },
      'work_items:get.checkpoint',
    );
  }
  const checkpointAbsent = checkpoint.status === 'known' && checkpoint.value.status === 'absent';

  let successorResidue: BriefField<WorkItemBriefResidue>;
  if (checkpoint.status === 'unknown') {
    successorResidue = unknown(checkpoint.reason);
  } else if (checkpointAbsent) {
    successorResidue = unknown('no checkpoint is recorded, so no successor residue was handed over');
  } else if (latestUpdateUnknown) {
    successorResidue = unknown('the latest checkpoint update is missing or invalid, so preserved history cannot establish current residue');
  } else if (!structured) {
    successorResidue = unknown('the checkpoint is free-form prose (no carry-note sections); read it directly');
  } else {
    successorResidue = known(
      { left: fields.left?.trim() || null, walls: (fields.walls ?? []).map((wall) => wall.claim) },
      'checkpoint carry-note ## Left + ## Walls',
    );
  }

  const blockers = readBlockers(row, workItem, state);
  const claimEligibilityReason =
    state === 'blocked'
      ? 'the work-item state is blocked; resolve its blocker before claiming'
      : blockers.status === 'unknown'
        ? `blocker and plan eligibility are unknown: ${blockers.reason}`
        : blockers.value.length > 0
          ? 'active blockers are present; resolve them before claiming'
          : null;
  const claimableState = state === 'open' || state === 'failing';

  let nextAction: BriefField<string>;
  const authority = str(workItem.completionAuthority) ?? str(row.completionAuthority);
  const settlement: BriefField<string> = authority === 'proposed' || authority === 'pending_human'
    ? known('completion proposed; settlement pending', 'work_items:get.workItem.completionAuthority')
    : authority === 'invalid'
      ? known('completion rejected; evidence requires repair', 'work_items:get.workItem.completionAuthority')
      : authority === 'committed' || authority === 'validated'
        ? known('completion claim settled; this proves no delivery stage', 'work_items:get.workItem.completionAuthority')
        : unknown('completion settlement authority is missing or unrecognized');
  if (state === null) {
    nextAction = unknown('the work-item state is not in this read');
  } else if (terminal && authority !== 'committed' && authority !== 'validated') {
    nextAction = known(`reconcile completion settlement: work_items:get { id: '${id}' }; ${authority === 'invalid' ? 'repair rejected evidence before resubmitting completion' : 'settlement remains pending or unknown'}`, 'work_items:get.workItem.completionAuthority');
  } else if (terminal) {
    nextAction = known(`none — the item is terminal (${state})`, 'work_items:get.workItem.state');
  } else if (checkpoint.status === 'unknown') {
    nextAction = unknown(checkpoint.reason);
  } else if (latestUpdateUnknown) {
    nextAction = unknown('the latest checkpoint update is missing or invalid, so preserved history cannot establish a current next action');
  } else if (fields.next?.trim()) {
    nextAction = known(fields.next.trim(), 'checkpoint carry-note ## Next action');
  } else if (checkpointAbsent && assignee === null && claimEligibilityReason) {
    nextAction = unknown(claimEligibilityReason);
  } else if (checkpointAbsent && assignee === null && !claimableState) {
    nextAction = unknown(`work-item state ${state} is not claimable`);
  } else if (checkpointAbsent && assignee === null) {
    nextAction = known(`claim it: work_items:claim { id: '${id}' }`, 'derived: open/failing, unclaimed, no checkpoint, no blockers');
  } else if (checkpointAbsent) {
    nextAction = unknown(`claimed by ${assignee} but no checkpoint records a next action`);
  } else {
    nextAction = unknown('the checkpoint has no "## Next action" section; read it directly');
  }

  return finalizeOperationalBrief<WorkItemBriefFacts>({
    surface: 'work-item',
    subject: id,
    state: state !== null ? known(state, 'work_items:get.workItem.state') : unknown('the work-item state is not in this read'),
    owner: known(assignee, 'work_items:get.workItem.assignee'),
    nextAction,
    blockers,
    lastVerified: readLastVerified(row, id),
    deadline: terminal
      ? known(null, 'terminal items carry no deadline')
      : unknown('work_items:get exposes no claim-lease or wake deadline for this item'),
    facts: {
      kind: str(workItem.kind),
      plan: readPlan(workItem),
      claim,
      checkpoint,
      successorResidue,
      holdsUp: readHoldsUp(workItem, options),
      blockedByLinks: unknown(
        'work_items:get does not read incoming blocks edges; the scheduler resolves them at claim time (work_items:claimable)',
      ),
      settlement,
      delivery: readDelivery(row, id),
    },
  });
}

/** Text form: the shared core lines plus the work-item facts a waiting reader needs,
 * so the claim, checkpoint and residue are visible in turn text too. */
export function renderWorkItemFactLines(brief: WorkItemOperationalBrief): string[] {
  const { claim, checkpoint, successorResidue, holdsUp } = brief.facts;
  const lines: string[] = [];
  lines.push(
    claim.status === 'known'
      ? `claim: ${claim.value.assignee ?? 'unclaimed'}${claim.value.takenAt ? ` since ${claim.value.takenAt}` : ''}` +
          (claim.value.holderStale === true ? ' (holder intent stale)' : '')
      : `claim: unknown (${claim.reason})`,
  );
  lines.push(
    checkpoint.status === 'known'
      ? `checkpoint: ${checkpoint.value.status}${checkpoint.value.updatedAt ? ` @ ${checkpoint.value.updatedAt}` : ''}` +
          (checkpoint.value.status === 'available' && !checkpoint.value.structured ? ' (free-form)' : '')
      : `checkpoint: unknown (${checkpoint.reason})`,
  );
  if (successorResidue.status === 'known') {
    const { left, walls } = successorResidue.value;
    lines.push(`residue: ${left ?? 'none left'}${walls.length > 0 ? `; walls: ${walls.join('; ')}` : ''}`);
  }
  if (holdsUp.status === 'known' && holdsUp.value.length > 0) lines.push(`holds up: ${holdsUp.value.join(', ')}`);
  const { settlement, delivery } = brief.facts;
  lines.push(settlement.status === 'known' ? `completion settlement: ${settlement.value}` : `completion settlement: unknown (${settlement.reason})`);
  for (const [stage, field] of Object.entries(delivery)) {
    lines.push(field.status === 'known'
      ? `delivery ${stage}: ${field.value.state} — ${field.value.summary} (${field.value.ref})`
      : `delivery ${stage}: unknown (${field.reason})`);
  }
  return lines;
}
