import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CellReadEnv } from './cell-read';
import type { ExternalBlockerRecord } from './external-blockers';
import { activeWorkspaceId } from './workspace-registry';
import { readGitFilePublicationCondition, type GitFilePublicationBinding } from './git-file-publication-condition';
import { hasUnresolvedBlockerObligation, prepareBlockerDecision, readBlockerResolution,
  validateBlockerDecisionEvidence, type BlockerEvidenceMeasurement, type BlockerEvidenceRef,
  type BlockerDecisionProblem, type PreparedBlockerDecision, type UnmeasuredRuntimeScope } from './blocker-resolution-decision';
import type { WorkItem } from './work-items';

/** Authenticated host context; never part of the public tool's arguments. */
export interface BlockerBoundaryContext extends CellReadEnv {
  ownerId: string;
  sessionId: string;
  root: string | null;
}
type BoundaryItem = Pick<WorkItem, 'id' | 'harness' | 'state' | 'assignee' | 'payload'>;

/** Preserve the dispatch role and tenant; resolve source roots from the existing
 * harness registry rather than request fields or the server's working directory. */
export async function blockerBoundaryContext(
  ctx: { workspaceId?: string | null; role?: string; signal?: AbortSignal },
  ownerId: string,
  harness: string | null | undefined,
): Promise<BlockerBoundaryContext> {
  const { resolveConcreteWorkspaceId } = await import('./workspace-registry');
  return { ownerId, sessionId: ownerId, workspaceId: resolveConcreteWorkspaceId(ctx.workspaceId),
    harnessSlug: harness ?? null, role: ctx.role ?? '', signal: ctx.signal,
    root: null };
}

function boundaryProblem(missing: string[]): BlockerDecisionProblem {
  return { ok: false, code: 'blocker_decision_evidence', missing,
    nextAction: 'Investigate the canonical blocker, attempt a safe remedy, and provide blockerDecision with measured self-resolution or an accountable deferral. Keep custody while refused.' };
}

/** Only the public handler's complete ordinary release effect qualifies. Keep
 * its reason intact for the audit and effect hash; explicit hold:false mutates
 * a hold too. The separate writer payload must independently be empty. */
function plainPublicRelease(effect: unknown, payload?: { patch: unknown; unset: readonly string[] }): boolean {
  const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plain(effect) || !payload || !plain(payload.patch) || Reflect.ownKeys(payload.patch).length ||
      !Array.isArray(payload.unset) || payload.unset.length) return false;
  const keys = ['release', 'claimHold', 'claimHoldRelease', 'reason', 'force'];
  return Reflect.ownKeys(effect).length === keys.length && keys.every(key => Object.hasOwn(effect, key)) &&
    effect.release === true && effect.claimHold === null && effect.claimHoldRelease === null && effect.force === false &&
    (effect.reason === null || (typeof effect.reason === 'string' && effect.reason.length <= 500));
}

/** Shared agent-boundary preflight. The lifecycle writer supplies its exact effect
 * and canonical pre-write row, then fences that row in its existing transaction.
 * Ordinary handoffs need no decision. Once observed, an unresolved condition also
 * survives clearing an edge, changing status, or using a different public verb.
 * An exact historical retry returns before any live evidence/dependency reads. */
export async function preflightBlockerDecision(
  item: BoundaryItem,
  input: unknown,
  context: BlockerBoundaryContext,
  options: { effect: unknown; enteringDeferral?: boolean; requireResolution?: boolean;
    /** Supplied only by the actual release writer, separately from its effect
     * override, which can otherwise conceal payload/hold mutations. */
    releasePayload?: { patch: unknown; unset: readonly string[] };
    /** Host-only: paired dropped plan-line/receipt/dependency admission. */
    allowAbsorption?: boolean;
    /** Host-validated proposed conditions, checked before their first write. */
    additionalBlockers?: readonly ExternalBlockerRecord[];
    /** Canonical prospective dependency identities from the relation writer. */
    additionalDependencyRefs?: readonly string[] },
): Promise<PreparedBlockerDecision | { ok: true; ordinary: true }> {
  let prepared: PreparedBlockerDecision | undefined;
  if (input !== undefined) {
    prepared = prepareBlockerDecision(item.payload, input, { ownerId: context.ownerId,
      sessionId: context.sessionId, workItemId: item.id, custodianId: item.assignee }, { effect: options.effect });
    if (!prepared.ok || prepared.replayed) return prepared;
    if (prepared.record.decision.disposition === 'absorb' && !options.allowAbsorption) {
      return boundaryProblem(['absorption requires the canonical plan drop and graph transaction']);
    }
    if (options.requireResolution && prepared.record.decision.disposition !== 'self_resolve' &&
        !(options.allowAbsorption && prepared.record.decision.disposition === 'absorb')) {
      return boundaryProblem(['measured self-resolution before a terminal transition; deferral retains the unresolved work']);
    }
  }
  try {
    const { activeWorkspaceId } = await import('./workspace-registry');
    if (activeWorkspaceId() !== context.workspaceId) return boundaryProblem(['canonical tenant context']);
    const { readUnresolvedDepBlockers } = await import('./work-items');
    const dependencies = await readUnresolvedDepBlockers(item.id, item.harness ?? undefined);
    // This reporting reader is capped at 25. A full page is not a complete
    // census, so it cannot authorize clearing all remaining obligations.
    if (dependencies.length >= 25) return boundaryProblem(['complete dependency census (reporting page reached its limit)']);
    const required = options.enteringDeferral || hasUnresolvedBlockerObligation(item.payload, item.state) ||
      dependencies.length > 0 || (options.additionalBlockers?.length ?? 0) > 0 ||
      (options.additionalDependencyRefs?.length ?? 0) > 0;
    if (!prepared) return required ? boundaryProblem(['blockerDecision with investigation and evidence']) : { ok: true, ordinary: true };
    if (!prepared.ok) return prepared;
    const { activeExternalBlockers } = await import('./external-blockers');
    const blockers = [...activeExternalBlockers(item.payload), ...(options.additionalBlockers ?? [])];
    const absorbing = prepared.record.decision.disposition === 'absorb';
    if (absorbing && blockers.some(blocker => blocker.kind !== 'runtime' ||
        !blocker.ref.startsWith('plan-lane:') || blocker.createdBy !== 'system:plan-item-lane-sync')) {
      return boundaryProblem(['absorption cannot bypass active holds or external conditions']);
    }
    // Issue edges use a bare global id; evidence may name its actual harness.
    // Resolve through the canonical work reader instead of assuming the blocked
    // item's harness or comparing two valid spellings as unrelated conditions.
    const { getWorkItem } = await import('./work-items');
    const dependencyRefs = (refs: readonly string[]): Promise<BlockerEvidenceRef[]> => Promise.all(
      refs.map(async ref => {
        if (ref.includes('#')) return { kind: 'work-item' as const, ref };
        const dependency = await getWorkItem(ref);
        if (!dependency?.harness) throw new Error('canonical dependency harness is unavailable');
        return { kind: 'work-item' as const, ref: `${dependency.harness}#${dependency.id}` };
      }));
    const obligationRefs = await dependencyRefs([
      ...dependencies.map(dep => dep.ref), ...(options.additionalDependencyRefs ?? []),
    ]);
    // Completed endpoints disappear from the unresolved reporting set while
    // their canonical edges still explain why this item was blocked. Retain
    // those actual edges as verification relevance, never as clearance of a
    // different pending obligation or as grounds for a deferral.
    let relatedConditionRefs: BlockerEvidenceRef[] = [];
    if (prepared.record.decision.disposition === 'self_resolve') {
      const related = await readUnresolvedDepBlockers(item.id, item.harness ?? undefined, { includeSatisfied: true });
      if (related.length >= 25) return boundaryProblem(['complete dependency census (related reporting page reached its limit)']);
      relatedConditionRefs = await dependencyRefs(related.map(dep => dep.ref));
    }
    for (const blocker of blockers) {
      if (absorbing) continue; // exact source gate is fenced again in the graph transaction
      if (blocker.kind === 'human' || blocker.kind === 'hold') obligationRefs.push({ kind: 'authority', ref: blocker.ref });
      else if (blocker.kind === 'runtime' && blocker.runtimeConditionBinding !== undefined) obligationRefs.push({ kind: 'runtime', ref: blocker.ref });
      else if (blocker.kind === 'runtime' && blocker.ref.startsWith('state:')) obligationRefs.push({ kind: 'state', ref: blocker.ref });
      else if (blocker.kind === 'runtime') obligationRefs.push({ kind: 'runtime', ref: blocker.ref });
      else obligationRefs.push({ kind: 'event', ref: blocker.ref });
    }
    const prior = readBlockerResolution(item.payload);
    if (prior.status === 'recorded' && prior.current.decision.disposition === 'defer') {
      obligationRefs.push(prior.current.decision.deferral.recheckRef);
    }
    const { ALL_TERMINAL_STATUSES } = await import('./work-item-blocking');
    const plainReleaseScope = !options.requireResolution && !options.allowAbsorption &&
      !options.additionalBlockers?.length && !options.additionalDependencyRefs?.length &&
      !ALL_TERMINAL_STATUSES.has(item.state) && item.assignee === context.ownerId && context.workspaceId && item.harness &&
      plainPublicRelease(options.effect, options.releasePayload)
      ? { workspaceId: context.workspaceId, harnessSlug: item.harness, workItemId: item.id, custodianId: context.ownerId }
      : undefined;
    const readEvidence = createBlockerEvidenceReader({ ...context, harnessSlug: item.harness,
      workItemId: item.id, custodianId: item.assignee, blockers,
      retainedReservationRelease: prepared.record.decision.disposition === 'defer' ? plainReleaseScope : undefined });
    const checked = await validateBlockerDecisionEvidence(prepared.record.decision, {
      ownerId: context.ownerId, workItemId: item.id, obligationRefs, relatedConditionRefs,
      allowAbsorption: options.allowAbsorption, unmeasuredRuntimeDeferral: plainReleaseScope, readEvidence,
    });
    return checked.ok ? prepared : checked;
  } catch {
    return boundaryProblem(['authoritative canonical blocker/dependency evidence (reader unavailable)']);
  }
}

/** Host-only context. The boundary supplies authenticated scope, the canonical
 * repository root and stored blocker rows, never request-supplied measurements.
 * Imports with DB/runtime initialization stay lazy so collecting tests is pure. */
export interface BlockerEvidenceContext extends CellReadEnv {
  ownerId: string;
  workItemId: string;
  root: string | null;
  blockers: readonly ExternalBlockerRecord[];
  /** Canonical pre-write subject custody, never request-supplied. */
  custodianId?: string | null;
  /** Host-only plain-release deferral: the writer preserves this custodian's
   * reservation and every blocker while releasing only the inactive assignment. */
  retainedReservationRelease?: UnmeasuredRuntimeScope;
}
const absent = (detail: string): BlockerEvidenceMeasurement => ({ status: 'absent', detail });
const unknown = (detail: string): BlockerEvidenceMeasurement => ({ status: 'unknown', detail });

function readGitText(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolveText => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
      ...(signal ? { signal } : {}) }, (error, stdout) => resolveText(error ? null : stdout.trim()));
  });
}

/** `git-sync:committed` is a global wake, so it cannot prove which files it
 * committed. For a current custodian whose host-stamped codeWorkingSet names
 * the affected paths, measure the exact file-acceptance predicate instead.
 * The broad event remains only a wake hint: unrelated commits leave this
 * subject-bound predicate pending. */
async function readGitSyncWorkingSetCondition(context: BlockerEvidenceContext, root: string):
Promise<BlockerEvidenceMeasurement> {
  const { activeWorkspaceId } = await import('./workspace-registry');
  if (!context.workspaceId || activeWorkspaceId() !== context.workspaceId || !context.harnessSlug ||
      !context.workItemId || !context.ownerId || context.custodianId !== context.ownerId) {
    return unknown('canonical work-item custody and tenant are required for a git-sync file predicate');
  }
  const supplied = context.blockers.filter(blocker => blocker.ref === 'git-sync:committed' &&
    blocker.kind === 'event' && blocker.status === 'active' && blocker.capability === 'live-dependency');
  if (supplied.length !== 1) return unknown('one exact active git-sync commit blocker is required');

  const { getWorkItem } = await import('./work-items');
  const current = await getWorkItem(context.workItemId, context.harnessSlug);
  if (!current || current.id !== context.workItemId || current.harness !== context.harnessSlug ||
      current.assignee !== context.ownerId || !['blocked', 'open', 'todo', 'wip'].includes(current.state)) {
    return unknown('canonical nonterminal work-item custody is unavailable');
  }
  const { activeExternalBlockers } = await import('./external-blockers');
  const canonicalBlockers = activeExternalBlockers(current.payload).filter(blocker => blocker.ref === 'git-sync:committed');
  if (canonicalBlockers.length !== 1 || !isDeepStrictEqual(canonicalBlockers[0], supplied[0])) {
    return unknown('canonical git-sync blocker changed or is ambiguous');
  }

  const payload = current.payload && typeof current.payload === 'object' && !Array.isArray(current.payload)
    ? current.payload as Record<string, unknown> : null;
  const stamp = payload?.codeWorkingSet;
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) {
    return unknown('host-stamped code working set is unavailable');
  }
  const workingSet = stamp as { owner?: unknown; epoch?: unknown; derivedAt?: unknown; paths?: unknown };
  const takenAt = (current as typeof current & { takenAt?: string | null }).takenAt;
  const derivedAtMs = typeof workingSet.derivedAt === 'string' ? Date.parse(workingSet.derivedAt) : NaN;
  const takenAtMs = typeof takenAt === 'string' ? Date.parse(takenAt) : NaN;
  if (workingSet.owner !== context.ownerId || !Number.isInteger(workingSet.epoch) ||
      !Number.isFinite(derivedAtMs) || !Number.isFinite(takenAtMs) || derivedAtMs < takenAtMs ||
      !Array.isArray(workingSet.paths) || workingSet.paths.length < 1 || workingSet.paths.length > 12 ||
      !workingSet.paths.every(path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
        !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..')) ||
      new Set(workingSet.paths).size !== workingSet.paths.length) {
    return unknown('a current, owner-stamped, bounded code working set is required');
  }
  const paths = workingSet.paths as string[];
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return unknown('canonical harness repository root is unavailable');
  const parentCommit = await readGitText(canonicalRoot, ['rev-parse', 'HEAD'], context.signal);
  if (!parentCommit || !/^[a-f0-9]{40}$/.test(parentCommit)) return unknown('current parent commit could not be measured');

  const checks = await Promise.all(paths.map(async filePath => {
    const [sourceCommit, expectedBlob] = await Promise.all([
      readGitText(canonicalRoot, ['log', '-1', '--format=%H', 'HEAD', '--', filePath], context.signal),
      readGitText(canonicalRoot, ['hash-object', '--', filePath], context.signal),
    ]);
    if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit) || !expectedBlob || !/^[a-f0-9]{40}$/.test(expectedBlob)) {
      return unknown(`current committed and working blobs could not be measured for ${filePath}`);
    }
    const binding: GitFilePublicationBinding = { schemaVersion: 1, kind: 'git-file-publication', filePath,
      sourceCommit, expectedBlob, parentCommit,
      reason: 'Measure the current work-item code working-set blob in the local git-sync commit',
      reasonRef: context.workItemId };
    return readGitFilePublicationCondition(binding, canonicalRoot);
  }));
  const unavailable = checks.find(check => check.status !== 'available');
  if (unavailable) return unknown(`exact local git-sync file predicate is unavailable: ${unavailable.status}`);
  const condition = checks.every(check => check.status === 'available' && check.condition === 'satisfied')
    ? 'satisfied' : 'pending';
  return { status: 'available', condition, reachable: true, responsibleParty: 'system:git-sync',
    subjectWorkItemId: current.id,
    conditionIdentity: JSON.stringify(['git-sync-code-working-set', context.workspaceId,
      context.harnessSlug, current.id, workingSet.epoch, paths]) };
}

/** Read-only adapter over the existing work, presence, cell, event, docs and
 * test ledgers. No dispatch under a substituted role, new table or new monitor.
 * Grammar: work-item:[harness#]ID; state:CELL[#/json/pointer=JSON];
 * event keys verbatim; source:repo/path[:line]; doc:ID; session:OWNER;
 * testing:runs:RUN_GROUP:ROW_ID; authority:STORED_BLOCKER_REF.
 * Plain refs omit the kind prefix except test refs, which retain testing:runs.
 */
/** A legacy grading-audit reservation names a scorecard predicate, not a fire.
 * Resolve both spellings against that exact tenant-scoped target and its settled
 * independent audit; superseding target cards never substitute for this gate. */
async function readGradingAuditCondition(
  ref: string, context: BlockerEvidenceContext,
  loadHeader: () => Promise<typeof import('./scorecards').readScorecardRecipeHeader>,
): Promise<BlockerEvidenceMeasurement> {
  const match = /^(?:scorecard:)?grading-audit:(EI-[A-Za-z0-9_-]+)$/.exec(ref);
  if (!match) return absent('expected an exact grading-audit scorecard id');
  const activeWorkspace = activeWorkspaceId();
  if (!context.workspaceId || activeWorkspace !== context.workspaceId) {
    return unknown(`grading-audit tenant context mismatch (${JSON.stringify({
      active: activeWorkspace, expected: context.workspaceId,
    })})`);
  }
  const readScorecardRecipeHeader = await loadHeader();
  const targetRead = await readScorecardRecipeHeader(match[1]);
  if (targetRead.kind !== 'found') return unknown('grading-audit target is unavailable');
  const target = targetRead.scorecard;
  if (target.issueId !== match[1] || target.retracted || target.provisional) {
    return unknown('grading-audit target identity is not eligible');
  }
  const stamp = target.gradingAudit;
  if (!stamp || stamp.metaRubricRef !== 'grading-integrity') return unknown('canonical grading-audit stamp is unavailable');
  const measurement = { status: 'available' as const, reachable: true,
    conditionIdentity: JSON.stringify(['scorecard-grading-audit', context.workspaceId, match[1]]) };
  if (['pending', 'awaiting-reemit', 'failed', 'cancelled'].includes(stamp.state)) {
    return { ...measurement, condition: 'pending' };
  }
  if (stamp.state !== 'passed' || !stamp.auditIssueId || !/^EI-[A-Za-z0-9_-]+$/.test(stamp.auditIssueId) ||
      !target.createdBy || !stamp.auditor || stamp.auditor === target.createdBy ||
      !stamp.auditedAt || !Number.isFinite(Date.parse(stamp.auditedAt)) ||
      !Number.isInteger(stamp.rubricRevision) || (stamp.rubricRevision ?? 0) < 1 || !stamp.criteriaHash?.trim()) {
    return unknown('settled grading-audit identity is incomplete');
  }
  const auditRead = await readScorecardRecipeHeader(stamp.auditIssueId);
  if (auditRead.kind !== 'found') return unknown('canonical grading-audit card is unavailable');
  const audit = auditRead.scorecard;
  if (audit.issueId !== stamp.auditIssueId || audit.rubricRef !== 'grading-integrity' ||
      audit.subject?.kind !== 'scorecard' || audit.subject.ref !== target.issueId ||
      audit.createdBy !== stamp.auditor || audit.retracted || audit.provisional || audit.supersededBy ||
      audit.rubricRevision !== stamp.rubricRevision || audit.criteriaHash !== stamp.criteriaHash) {
    return unknown('canonical grading-audit card does not match its target stamp');
  }
  return { ...measurement, condition: 'satisfied' };
}

export function createBlockerEvidenceReader(context: BlockerEvidenceContext) {
  // Alias checks in one decision share a lazy module binding, while every read
  // still measures current tenant-scoped rows rather than caching a verdict.
  let auditHeader: Promise<typeof import('./scorecards').readScorecardRecipeHeader> | undefined;
  const loadAuditHeader = () => auditHeader ??= import('./scorecards').then(module => module.readScorecardRecipeHeader);

  async function repositoryRoot(): Promise<string | null> {
    return context.root ?? (context.harnessSlug
      ? await (await import('./harness/docs/harness-repo')).resolveHarnessRepoRoot(context.harnessSlug) : null);
  }

  async function workItem(ref: string): Promise<BlockerEvidenceMeasurement> {
    const { activeWorkspaceId } = await import('./workspace-registry');
    // The work reader resolves the request's active tenant. A mismatch is not
    // permission to read an unscoped fallback row from another workspace.
    const activeWorkspace = activeWorkspaceId();
    if (activeWorkspace !== context.workspaceId) {
      return unknown(`work-item tenant context mismatch (${JSON.stringify({
        active: activeWorkspace, expected: context.workspaceId,
      })})`);
    }
    const raw = ref.replace(/^work-item:/, '');
    const match = /^(?:([A-Za-z0-9_.-]+)#)?((?:WI|EI|F)-[A-Za-z0-9_-]+)$/.exec(raw);
    if (!match) return absent('expected work-item:[harness#]ID');
    const harness = match[1] ?? context.harnessSlug;
    if (!harness) return unknown('canonical work-item harness is required');
    const { getWorkItem } = await import('./work-items');
    const item = await getWorkItem(match[2], harness);
    if (!item || item.harness !== harness) return absent('no canonical work-item in the named harness');
    const { ALL_TERMINAL_STATUSES } = await import('./work-item-blocking');
    const settled = ALL_TERMINAL_STATUSES.has(item.state);
    let liveOwnerId: string | undefined;
    if (!settled && item.assignee) {
      const { getPresence } = await import('./agent-tools/coordination/presence');
      const presence = await getPresence(item.assignee);
      if (presence && !presence.stale && presence.workspaceId === context.workspaceId) liveOwnerId = item.assignee;
    }
    return { status: 'available', condition: settled ? 'satisfied' : 'pending', reachable: true,
      conditionIdentity: JSON.stringify(['work-item', context.workspaceId, harness, item.id]), canonicalWorkItemId: item.id,
      ...(item.assignee ? { responsibleParty: item.assignee } : {}), ...(liveOwnerId ? { liveOwnerId } : {}) };
  }

  return async function readEvidence(ref: BlockerEvidenceRef): Promise<BlockerEvidenceMeasurement> {
    try {
      switch (ref.kind) {
        case 'work-item': return await workItem(ref.ref);
        case 'runtime': {
          const blockers = context.blockers.filter(entry => entry.kind === 'runtime' && entry.ref === ref.ref && entry.status === 'active');
          if (blockers.length !== 1) return absent('exact canonical active runtime blocker is required');
          const binding = blockers[0].runtimeConditionBinding;
          if (binding === undefined && !ref.ref.startsWith('state:')) {
            if (!context.workspaceId || !context.harnessSlug || !context.workItemId ||
                context.custodianId !== context.ownerId || !context.ownerId) return unknown('canonical current runtime custodian and scope required');
            return { status: 'unmeasured-runtime', ref: ref.ref,
              scope: { workspaceId: context.workspaceId, harnessSlug: context.harnessSlug,
                workItemId: context.workItemId, custodianId: context.ownerId },
              detail: 'Original canonical runtime predicate has no measuring adapter; no recovery or pending verdict' };
          }
          const { readRuntimeBlockerCondition } = await import('./runtime-blocker-condition');
          const publication = binding !== null && typeof binding === 'object' &&
            'kind' in binding && binding.kind === 'git-file-publication';
          return await readRuntimeBlockerCondition(blockers[0], publication ? await repositoryRoot() : context.root);
        }
        case 'state': {
          const raw = ref.ref.replace(/^state:/, '');
          const hash = raw.indexOf('#');
          const cell = hash < 0 ? raw : raw.slice(0, hash);
          const { readCell, formatCellHoist } = await import('./cell-read');
          const read = await readCell(cell, { ownerId: context.ownerId, roles: context.role ? [context.role] : [],
            harnessSlug: context.harnessSlug ?? undefined, workItems: [context.workItemId] }, context);
          if (read.status === 'absent') return absent('cell is not available to this caller');
          if (read.status === 'unknown') return unknown('cell resolver did not measure a value');
          if (read.source?.authoritative === false || read.assessment?.status === 'unavailable' ||
              (read.unknownHoist && formatCellHoist(read.unknownHoist) !== null)) {
            return unknown('cell carries non-authoritative or incomplete measurement');
          }
          if (hash < 0) return { status: 'available' }; // existence is not a predicate
          const predicate = raw.slice(hash + 1);
          const equals = predicate.indexOf('=');
          if (equals < 0) return absent('state predicate requires #/json/pointer=JSON');
          const pointer = predicate.slice(0, equals);
          if (pointer && !pointer.startsWith('/')) return absent('state predicate requires a JSON pointer');
          let actual = read.value;
          for (const token of pointer ? pointer.slice(1).split('/') : []) {
            if (/~(?:[^01]|$)/.test(token)) return absent('invalid JSON pointer escape');
            const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
            if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, key)) {
              return unknown('state predicate path was not measured');
            }
            actual = (actual as Record<string, unknown>)[key];
          }
          const expected: unknown = JSON.parse(predicate.slice(equals + 1));
          return { status: 'available', reachable: true,
            condition: isDeepStrictEqual(actual, expected) ? 'satisfied' : 'pending' };
        }
        case 'event': {
          if (ref.ref.startsWith('grading-audit:') || ref.ref.startsWith('scorecard:grading-audit:')) {
            return await readGradingAuditCondition(ref.ref, context, loadAuditHeader);
          }
          // A generated plan lane is a predicate over the canonical graph, not
          // an emitted event. Keep the existing reference/decision contract;
          // never manufacture a fire or let a caller assert its measurement.
          if (ref.ref.startsWith('plan-lane:')) {
            const match = /^plan-lane:([^#]+)#(P-\d{3,})$/.exec(ref.ref);
            const gates = context.blockers.filter(blocker => blocker.ref === ref.ref &&
              blocker.kind === 'gate' && blocker.status === 'active' &&
              blocker.capability === 'live-dependency' && blocker.createdBy === 'system:plan-item-lane-sync');
            if (!match || gates.length !== 1 || !context.workspaceId || !context.harnessSlug ||
                !context.ownerId || context.custodianId !== context.ownerId) {
              return unknown('exact system-derived lane and authenticated current custody required');
            }
            const { activeWorkspaceId } = await import('./workspace-registry');
            if (activeWorkspaceId() !== context.workspaceId) return unknown('plan-lane tenant context mismatch');
            const { getWorkItem, readWorkItemClaimHoldProvenance, isClaimHoldParked } = await import('./work-items');
            const current = await getWorkItem(context.workItemId, context.harnessSlug);
            if (!current || current.harness !== context.harnessSlug || current.assignee !== context.ownerId ||
                !['blocked', 'open', 'todo', 'wip'].includes(current.state)) {
              return unknown('canonical nonterminal lane custody is unavailable');
            }
            const { activeExternalBlockers } = await import('./external-blockers');
            const canonicalGates = activeExternalBlockers(current.payload).filter(blocker => blocker.ref === ref.ref);
            if (canonicalGates.length !== 1 || !isDeepStrictEqual(canonicalGates[0], gates[0])) {
              return unknown('canonical derived blocker changed or is ambiguous');
            }
            const payload = current.payload as Record<string, unknown> | null;
            if (!payload || !['open', 'todo', 'wip'].includes(String(payload.planLaneParkedFrom))) {
              return unknown('generated lane lacks actionable pre-park provenance');
            }
            const hold = readWorkItemClaimHoldProvenance(current.payload);
            const release = context.retainedReservationRelease;
            const preservesOwnReservation = release && release.workspaceId === context.workspaceId &&
              release.harnessSlug === context.harnessSlug && release.workItemId === current.id &&
              release.custodianId === context.ownerId && hold.heldOpen?.by === context.ownerId &&
              !hold.parked && payload.claim_hold_by == null && payload.claim_hold_reason == null &&
              payload.claim_hold_at == null;
            if (hold.parked || ((isClaimHoldParked(current.payload) || hold.heldOpen) && !preservesOwnReservation)) {
              return unknown('independent park or lease must be resolved through its own authority');
            }
            const { getOrgPg } = await import('@papercusp/db-org');
            const { readPlanLineNodes } = await import('./agent-tools/plans/plan-line-graph');
            const { getPlanRow, planItemsForRow } = await import('./agent-tools/plans/source');
            const { resolveEffectiveStatusForItems } = await import('@papercusp/plan-parser');
            const [nodes, plan] = await Promise.all([
              readPlanLineNodes(getOrgPg().sql, { workspaceId: context.workspaceId,
                harnessSlug: context.harnessSlug, slug: match[1] }),
              getPlanRow(match[1], { workspaceId: context.workspaceId, harnessSlug: context.harnessSlug }),
            ]);
            const identities = nodes.filter(node => node.id === match[2]);
            if (!plan || plan.workspaceId !== context.workspaceId || plan.harnessSlug !== context.harnessSlug ||
                identities.length !== 1 || identities[0].featureId !== current.id || identities[0].ownerGateMarker ||
                new Set(nodes.map(node => node.id)).size !== nodes.length) {
              return unknown('exact canonical plan-line identity is unavailable or ambiguous');
            }
            const graph = resolveEffectiveStatusForItems(planItemsForRow(plan));
            const item = graph.items.find(item => item.id === match[2]);
            // A stale generated gate can outlive the lane's last dependency.
            // Only an actionable lane may establish that dependency-free case;
            // a still-explicitly-blocked lane supplies no release predicate.
            if (!item || (!item.blockedBy.length && item.storedStatus === 'blocked') || item.needsHuman ||
                !['blocked', 'todo', 'wip'].includes(item.storedStatus ?? '') ||
                graph.missingRefs.length || graph.cycleMembers.length) {
              return unknown('complete unambiguous derived dependency condition required');
            }
            return { status: 'available', condition: item.unresolvedBlockers.length ? 'pending' : 'satisfied',
              reachable: true, subjectWorkItemId: current.id,
              conditionIdentity: JSON.stringify(['plan-lane', context.workspaceId, context.harnessSlug, match[1], match[2]]) };
          }
          if (ref.ref === 'git-sync:committed' && context.blockers.some(blocker =>
            blocker.kind === 'event' && blocker.ref === ref.ref && blocker.status === 'active')) {
            const root = await repositoryRoot();
            return root ? readGitSyncWorkingSetCondition(context, root)
              : unknown('canonical harness repository root is unavailable');
          }
          const { readEventConditionReachability } = await import('./external-condition-reachability');
          const read = await readEventConditionReachability(ref.ref, { requireSpecificCondition: true });
          if (!read.authoritative || read.verdict === 'unknown') {
            return unknown(read.evidence
              ? `event condition could not be measured: ${read.evidence}`
              : 'event condition could not be measured');
          }
          if (read.uncertifiedReason) return absent('event cannot certify this specific condition');
          const settlement = /^work-item:settled:((?:WI|EI|F)-[A-Za-z0-9_-]+)$/.exec(ref.ref);
          if (settlement) {
            // Completion state and committed-content settlement are distinct.
            // Only an authenticated plain release may retain this exact pending
            // proposal as its custodian's next recheck; never reopen the repair.
            const scope = context.retainedReservationRelease;
            const { activeWorkspaceId } = await import('./workspace-registry');
            if (!scope || scope.workspaceId !== context.workspaceId || scope.harnessSlug !== context.harnessSlug ||
                scope.workItemId !== context.workItemId || scope.custodianId !== context.ownerId ||
                context.custodianId !== context.ownerId || activeWorkspaceId() !== context.workspaceId ||
                settlement[1] === context.workItemId || read.basis === 'fired' || read.verdict !== 'reachable') {
              return unknown('exact pending settlement and authenticated retained custody required');
            }
            const { getWorkItem } = await import('./work-items');
            const item = await getWorkItem(settlement[1], scope.harnessSlug);
            const { ALL_SUCCESSFUL_STATUSES } = await import('./work-item-blocking');
            if (!item || item.id !== settlement[1] || item.harness !== scope.harnessSlug ||
                !ALL_SUCCESSFUL_STATUSES.has(item.state) || item.completionAuthority !== 'proposed' ||
                item.terminalOwner !== context.ownerId || (item.assignee != null && item.assignee !== context.ownerId)) {
              return unknown('canonical same-custodian proposed completion required');
            }
            const { CompletionSettlementManifestSchema } = await import('./coord-lifecycle/records');
            const parsed = CompletionSettlementManifestSchema.safeParse(item.terminalCompletionEvidence?.settlementManifest);
            if (!parsed.success) return unknown('canonical settlement manifest is missing or invalid');
            const manifest = parsed.data;
            const paths = manifest.contentIdentity.map(entry => entry.path).sort();
            if (!isDeepStrictEqual(paths, [...manifest.normalizedPaths].sort()) ||
                manifest.contentIdentity.some(entry => isAbsolute(entry.path) || entry.path.startsWith(':') ||
                  entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
                  (entry.deletion === true ? entry.workingTreeBlobSha !== null :
                    typeof entry.workingTreeBlobSha !== 'string')) ||
                manifest.residualPaths?.some(entry => ['superseded-before-commit', 'not-a-repository-path'].includes(entry.reason))) {
              return unknown('complete settleable content identity required');
            }
            return { status: 'available', condition: 'pending', reachable: true,
              canonicalWorkItemId: item.id, responsibleParty: item.terminalOwner,
              conditionIdentity: JSON.stringify(['work-item-settlement', context.workspaceId, scope.harnessSlug,
                item.id, manifest.generation, manifest.evidenceHash]),
              pendingCommitSettlement: { generation: manifest.generation, evidenceHash: manifest.evidenceHash } };
          }
          const dependency = /^work-item:done:((?:WI|EI|F)-[A-Za-z0-9_-]+)$/.exec(ref.ref);
          const owner = dependency ? await workItem(dependency[1]) : null;
          return { ...(owner?.status === 'available' ? owner : {}), status: 'available',
            condition: read.basis === 'fired' ? 'satisfied' : 'pending', reachable: read.verdict === 'reachable',
            responsibleParty: owner?.status === 'available' && owner.responsibleParty
              ? owner.responsibleParty : `event:${ref.ref}` };
        }
        case 'authority': {
          const raw = ref.ref.replace(/^authority:/, '');
          const blocker = context.blockers.find((entry) => entry.ref === raw && entry.status === 'active');
          if (!blocker || !['human', 'hold'].includes(blocker.kind)) return absent('no canonical human-capability or restriction blocker');
          const { externalBlockerCapabilityPolicy } = await import('./external-blockers');
          const policy = externalBlockerCapabilityPolicy(blocker.capability);
          if (blocker.kind !== 'hold' && !policy.requiresOwnerCapability) return absent('capability is agent-resolvable');
          return { status: 'available', subjectWorkItemId: context.workItemId, condition: 'pending',
            authorityDenied: true, humanAction: blocker.kind === 'human', unsafeToAttempt: true,
            responsibleParty: blocker.kind === 'hold' ? blocker.createdBy : policy.resolutionOwner };
        }
        case 'source': {
          const registeredRoot = await repositoryRoot();
          if (!registeredRoot) return unknown('canonical repository root is unavailable');
          const raw = ref.ref.replace(/^source:/, '');
          const match = /^(.*?)(?::([1-9][0-9]*))?$/.exec(raw)!;
          if (!match[1] || isAbsolute(match[1])) return absent('source requires a repository-relative file');
          const root = await realpath(registeredRoot);
          const path = await realpath(resolve(root, match[1]));
          const rel = relative(root, path);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(path)).isFile()) {
            return absent('source is outside the canonical repository or is not a file');
          }
          if (match[2] && Number(match[2]) > (await readFile(path, 'utf8')).split('\n').length) return absent('source line does not exist');
          return { status: 'available' };
        }
        case 'doc': {
          if (!context.harnessSlug) return unknown('canonical document harness is required');
          const { getAuthoredDocContent } = await import('./harness/docs/doc-record');
          return await getAuthoredDocContent(context.harnessSlug, ref.ref.replace(/^doc:/, ''), context.workspaceId)
            ? { status: 'available' } : absent('canonical authored document not found');
        }
        case 'session': {
          const { getSessionBrief } = await import('./session-brief');
          const session = await getSessionBrief({ ownerId: ref.ref.replace(/^session:/, '') });
          return session?.workspaceId === context.workspaceId ? { status: 'available' } : absent('no session in this workspace');
        }
        case 'test': {
          const match = /^testing:runs:([A-Za-z0-9_-]+):([1-9][0-9]*)$/.exec(ref.ref);
          if (!match || !context.harnessSlug || !Number.isSafeInteger(Number(match[2]))) return absent('expected testing:runs:RUN_GROUP:ROW_ID in a canonical harness');
          const { readHarnessTestRunEvidence } = await import('./testing-run-store');
          const rows = await readHarnessTestRunEvidence({ workspaceId: context.workspaceId, harnessSlug: context.harnessSlug,
            runGroupId: match[1], testRunIds: [Number(match[2])] });
          if (rows === null) return unknown('test ledger is unavailable');
          if (rows.length !== 1 || rows[0].id !== Number(match[2])) return absent('exact scoped test run not found');
          // A passing row proves a run occurred. It does not establish current
          // source/runtime containment or that the blocked condition recovered.
          return { status: 'available' };
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        return absent('reference does not resolve');
      }
      return unknown('canonical evidence reader failed');
    }
  };
}
