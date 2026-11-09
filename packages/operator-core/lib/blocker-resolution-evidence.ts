import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CellReadEnv } from './cell-read';
import type { ExternalBlockerRecord } from './external-blockers';
import { hasUnresolvedBlockerObligation, prepareBlockerDecision, readBlockerResolution,
  validateBlockerDecisionEvidence, type BlockerEvidenceMeasurement, type BlockerEvidenceRef,
  type BlockerDecisionProblem, type PreparedBlockerDecision } from './blocker-resolution-decision';
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
      else obligationRefs.push({ kind: 'event', ref: blocker.ref });
    }
    const prior = readBlockerResolution(item.payload);
    if (prior.status === 'recorded' && prior.current.decision.disposition === 'defer') {
      obligationRefs.push(prior.current.decision.deferral.recheckRef);
    }
    const readEvidence = createBlockerEvidenceReader({ ...context, harnessSlug: item.harness,
      workItemId: item.id, blockers });
    const checked = await validateBlockerDecisionEvidence(prepared.record.decision, {
      ownerId: context.ownerId, workItemId: item.id, obligationRefs, relatedConditionRefs,
      allowAbsorption: options.allowAbsorption, readEvidence,
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
}
const absent = (detail: string): BlockerEvidenceMeasurement => ({ status: 'absent', detail });
const unknown = (detail: string): BlockerEvidenceMeasurement => ({ status: 'unknown', detail });

/** Read-only adapter over the existing work, presence, cell, event, docs and
 * test ledgers. No dispatch under a substituted role, new table or new monitor.
 * Grammar: work-item:[harness#]ID; state:CELL[#/json/pointer=JSON];
 * event keys verbatim; source:repo/path[:line]; doc:ID; session:OWNER;
 * testing:runs:RUN_GROUP:ROW_ID; authority:STORED_BLOCKER_REF.
 * Plain refs omit the kind prefix except test refs, which retain testing:runs.
 */
export function createBlockerEvidenceReader(context: BlockerEvidenceContext) {
  async function workItem(ref: string): Promise<BlockerEvidenceMeasurement> {
    const { activeWorkspaceId } = await import('./workspace-registry');
    // The work reader resolves the request's active tenant. A mismatch is not
    // permission to read an unscoped fallback row from another workspace.
    if (activeWorkspaceId() !== context.workspaceId) return unknown('work-item tenant context mismatch');
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
      conditionIdentity: JSON.stringify(['work-item', context.workspaceId, harness, item.id]),
      ...(item.assignee ? { responsibleParty: item.assignee } : {}), ...(liveOwnerId ? { liveOwnerId } : {}) };
  }

  return async function readEvidence(ref: BlockerEvidenceRef): Promise<BlockerEvidenceMeasurement> {
    try {
      switch (ref.kind) {
        case 'work-item': return await workItem(ref.ref);
        case 'runtime': {
          const blockers = context.blockers.filter(entry => entry.kind === 'runtime' && entry.ref === ref.ref && entry.status === 'active');
          if (blockers.length !== 1) return absent('exact canonical active runtime blocker is required');
          const { readRuntimeBlockerCondition } = await import('./runtime-blocker-condition');
          return await readRuntimeBlockerCondition(blockers[0], context.root);
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
          const { readEventConditionReachability } = await import('./external-condition-reachability');
          const read = await readEventConditionReachability(ref.ref, { requireSpecificCondition: true });
          if (!read.authoritative || read.verdict === 'unknown') return unknown('event condition could not be measured');
          if (read.uncertifiedReason) return absent('event cannot certify this specific condition');
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
          const registeredRoot = context.root ?? (context.harnessSlug
            ? await (await import('./harness/docs/harness-repo')).resolveHarnessRepoRoot(context.harnessSlug) : null);
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
