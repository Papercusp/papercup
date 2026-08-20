/**
 * Canonical prior-attempt context compiler (P-009, D-007/D-008).
 *
 * This is deliberately a projection over existing authority, not another history
 * store.  The collector reads spec revisions, plan decisions, exact spec-evidence
 * edges, work-item lifecycle/checkpoints/comments/completions, and release
 * provenance.  The pure compiler then normalizes, deduplicates and orders those
 * facts.  Claim-time payload budgeting belongs to the consumer (P-010); this
 * module exposes stable priorities and raw references so truncation cannot change
 * authority or make the omitted source impossible to retrieve.
 */
import { createHash } from 'node:crypto';
import { getPlanRow } from './agent-tools/plans/source';
import { parsePlan } from './agent-tools/plans/parser';
import { listSpecClauses, type SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import {
  listSpecEvidence,
  listWorkItemSpecRevisionEdges,
  type WorkItemSpecRevisionEdge,
} from './agent-tools/plans/spec-evidence-store';
import {
  getWorkItem,
  getWorkItemThreadWindow,
  listWorkItems,
  type WorkItem,
} from './work-items';
import { getWorkItemCheckpointWithMeta } from './work-item-checkpoint';
import { getWorkItemLifecycleHistory } from './work-item-lifecycle-history';
import { getClaimTimePriorWorkHint } from './work-item-prior-work';
import { resolveConcreteWorkspaceId } from './workspace-registry';

export type PriorAttemptScope = 'same-spec' | 'same-plan-item' | 'plan-wide';
export type PriorAttemptAuthority =
  | 'current-spec'
  | 'plan-decision'
  | 'retraction'
  | 'verified-completion'
  | 'checkpoint'
  | 'lifecycle'
  | 'release-provenance'
  | 'comment';

export interface PriorAttemptSource {
  scope: PriorAttemptScope;
  authority: PriorAttemptAuthority;
  rawRef: string;
  workItemId?: string | null;
  specId?: string | null;
  specRevision?: number | null;
  planItemId?: string | null;
  at?: string | null;
  actor?: string | null;
  text: string;
  /** Explicit source metadata (evidence refs, lifecycle detail, fingerprints). */
  detail?: Record<string, unknown> | null;
}

export interface PriorAttemptRecord extends PriorAttemptSource {
  id: string;
  approach: string | null;
  outcome: string | null;
  rootCauses: string[];
  falsePremises: string[];
  touchedFiles: string[];
  tests: string[];
  residue: string[];
}

export interface PriorAttemptCompilation {
  records: PriorAttemptRecord[];
  sourceCount: number;
  deduplicatedCount: number;
  byScope: Record<PriorAttemptScope, number>;
  byAuthority: Record<PriorAttemptAuthority, number>;
  fingerprint: string;
}

const SCOPE_RANK: Record<PriorAttemptScope, number> = {
  'same-spec': 0,
  'same-plan-item': 1,
  'plan-wide': 2,
};

// D-008: this order is authority, not a relevance guess.  In particular, a
// semantic/comment summary can never outrank a retraction or current spec.
const AUTHORITY_RANK: Record<PriorAttemptAuthority, number> = {
  'current-spec': 0,
  'plan-decision': 1,
  retraction: 2,
  'verified-completion': 3,
  checkpoint: 4,
  lifecycle: 5,
  'release-provenance': 6,
  comment: 7,
};

const FILE_RE = /(?:^|[\s`("'])([A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.+-]+)+\.[A-Za-z0-9_-]+)(?=$|[.\s`),:"'])/g;
const TEST_RE = /(?:^|\s)((?:npm|pnpm|yarn)\s+(?:run\s+)?test[^\n;]*|(?:vitest|jest|pytest|cargo\s+test)\s+[^\n;]*)/gi;

function boundedLine(text: string, max = 1200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function markedFragments(text: string, labels: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!labels.test(line)) continue;
    labels.lastIndex = 0;
    const value = boundedLine(line.replace(labels, '').replace(/^\s*[:—-]\s*/, ''), 500);
    if (value) out.push(value);
  }
  return [...new Set(out)].slice(0, 12);
}

function filesIn(text: string): string[] {
  const out: string[] = [];
  FILE_RE.lastIndex = 0;
  for (const match of text.matchAll(FILE_RE)) out.push(match[1]!);
  return [...new Set(out)].slice(0, 40);
}

function testsIn(text: string): string[] {
  TEST_RE.lastIndex = 0;
  const commands = [...text.matchAll(TEST_RE)].map((match) => boundedLine(match[1]!, 500));
  const namedFiles = filesIn(text).filter((path) => /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/i.test(path));
  return [...new Set([...commands, ...namedFiles])].slice(0, 30);
}

function normalizedRecord(source: PriorAttemptSource): PriorAttemptRecord {
  const text = source.text.trim();
  const isCompletion = source.authority === 'verified-completion';
  const isCheckpoint = source.authority === 'checkpoint';
  const id = createHash('sha256')
    .update(`${source.rawRef}\0${source.authority}\0${source.scope}\0${text}`)
    .digest('hex')
    .slice(0, 20);
  return {
    ...source,
    text,
    id,
    approach: isCheckpoint || source.authority === 'comment' ? boundedLine(text) || null : null,
    outcome: isCompletion ? boundedLine(text) || null : null,
    rootCauses: markedFragments(text, /\b(?:root\s*cause|origin(?:ates|ated)?\s+at)\b/gi),
    falsePremises: markedFragments(text, /\b(?:false\s+premise|retract(?:ed|ion)?|was\s+wrong|incorrect\s+assumption)\b/gi),
    touchedFiles: filesIn(text),
    tests: testsIn(text),
    residue: markedFragments(text, /\b(?:residue|remaining|follow[- ]?up|still\s+open|deferred)\b/gi),
  };
}

function atMs(at: string | null | undefined): number {
  const n = at ? Date.parse(at) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Pure canonical normalization/order seam. */
export function compilePriorAttempts(sources: readonly PriorAttemptSource[]): PriorAttemptCompilation {
  const byIdentity = new Map<string, PriorAttemptRecord>();
  for (const source of sources) {
    const record = normalizedRecord(source);
    if (!record.text) continue;
    // A raw authority ref denotes one fact.  If a caller accidentally supplies it
    // twice, retain the fresher/richer form instead of spending claim budget twice.
    const key = `${record.authority}\0${record.rawRef}`;
    const prior = byIdentity.get(key);
    if (!prior || atMs(record.at) > atMs(prior.at) || record.text.length > prior.text.length) {
      byIdentity.set(key, record);
    }
  }
  const records = [...byIdentity.values()].sort((a, b) => {
    return (
      SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
      AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority] ||
      atMs(b.at) - atMs(a.at) ||
      a.rawRef.localeCompare(b.rawRef)
    );
  });
  const byScope = { 'same-spec': 0, 'same-plan-item': 0, 'plan-wide': 0 } satisfies Record<PriorAttemptScope, number>;
  const byAuthority = Object.fromEntries(
    (Object.keys(AUTHORITY_RANK) as PriorAttemptAuthority[]).map((key) => [key, 0]),
  ) as Record<PriorAttemptAuthority, number>;
  for (const record of records) {
    byScope[record.scope] += 1;
    byAuthority[record.authority] += 1;
  }
  const fingerprint = createHash('sha256')
    .update(records.map((r) => `${r.id}:${r.at ?? ''}`).join('\n'))
    .digest('hex');
  return {
    records,
    sourceCount: sources.length,
    deduplicatedCount: sources.length - records.length,
    byScope,
    byAuthority,
    fingerprint,
  };
}

export interface CollectPriorAttemptsOptions {
  harnessSlug?: string;
  planSlug: string;
  planItemId: string;
  workItemId: string;
  /** Optional exact target specs.  When absent, derive them from the work-item
   * evidence edges, then from current clauses owned by the plan item. */
  specIds?: string[];
  maxPlanWorkItems?: number;
  maxThreadPosts?: number;
}

interface CollectorDeps {
  getPlan: typeof getPlanRow;
  specs: typeof listSpecClauses;
  edges: typeof listWorkItemSpecRevisionEdges;
  evidence: typeof listSpecEvidence;
  item: typeof getWorkItem;
  items: typeof listWorkItems;
  thread: typeof getWorkItemThreadWindow;
  checkpoint: typeof getWorkItemCheckpointWithMeta;
  lifecycle: typeof getWorkItemLifecycleHistory;
  priorWork: typeof getClaimTimePriorWorkHint;
}

const DEFAULT_DEPS: CollectorDeps = {
  getPlan: getPlanRow,
  specs: listSpecClauses,
  edges: listWorkItemSpecRevisionEdges,
  evidence: listSpecEvidence,
  item: getWorkItem,
  items: listWorkItems,
  thread: getWorkItemThreadWindow,
  checkpoint: getWorkItemCheckpointWithMeta,
  lifecycle: getWorkItemLifecycleHistory,
  priorWork: getClaimTimePriorWorkHint,
};

function planItemIdsOf(item: WorkItem): string[] {
  if (item.sourcePlanItemIds?.length) return item.sourcePlanItemIds;
  const payload = item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : null;
  const pointer = payload?.plan_item && typeof payload.plan_item === 'object'
    ? (payload.plan_item as Record<string, unknown>)
    : null;
  const id = typeof pointer?.item_id === 'string' ? pointer.item_id : null;
  return id ? [id] : [];
}

function scopeFor(item: WorkItem, targetSpecIds: Set<string>, edgeSpecs: ReadonlySet<string>, planItemId: string): PriorAttemptScope {
  if ([...edgeSpecs].some((id) => targetSpecIds.has(id))) return 'same-spec';
  if (planItemIdsOf(item).includes(planItemId)) return 'same-plan-item';
  return 'plan-wide';
}

function retractionText(text: string): boolean {
  return /\b(?:retract(?:ed|ion)?|false\s+premise|was\s+wrong|incorrect\s+assumption)\b/i.test(text);
}

/** Read existing stores and compile their canonical prior-attempt projection. */
export async function collectPriorAttempts(
  options: CollectPriorAttemptsOptions,
  deps: CollectorDeps = DEFAULT_DEPS,
): Promise<PriorAttemptCompilation> {
  const harness = options.harnessSlug;
  const workspaceId = resolveConcreteWorkspaceId();
  const [plan, currentItem, allSpecs, targetEdges] = await Promise.all([
    deps.getPlan(options.planSlug, harness ? { harnessSlug: harness } : {}).catch(() => null),
    deps.item(options.workItemId, harness).catch(() => null),
    deps.specs({ harnessSlug: harness, planSlug: options.planSlug, includeHistory: true }).catch(() => []),
    deps.edges({ harnessSlug: harness, planSlug: options.planSlug, workItemId: options.workItemId }).catch(() => []),
  ]);
  const derivedSpecIds = targetEdges.map((edge) => edge.specId);
  const fallbackSpecIds = allSpecs.filter((spec) => spec.planItemId === options.planItemId).map((spec) => spec.specId);
  const targetSpecIds = new Set(options.specIds?.length ? options.specIds : derivedSpecIds.length ? derivedSpecIds : fallbackSpecIds);

  const evidence = targetSpecIds.size
    ? await deps.evidence({
        harnessSlug: harness,
        planSlug: options.planSlug,
        specIds: [...targetSpecIds],
        limit: Math.max(options.maxPlanWorkItems ?? 200, 1) * 10,
      }).catch(() => [])
    : [];
  const evidenceItemIds = new Set(evidence.map((entry) => entry.workItemId));
  const listed = await deps.items({
    harness,
    sourcePlanSlug: options.planSlug,
    includeChildren: true,
    includeObservations: true,
    limit: options.maxPlanWorkItems ?? 200,
  }).catch(() => []);
  const candidates = new Map<string, WorkItem>();
  for (const item of listed) candidates.set(item.id, item);
  if (currentItem) candidates.set(currentItem.id, currentItem);
  for (const id of evidenceItemIds) {
    if (!candidates.has(id)) {
      const item = await deps.item(id, harness).catch(() => null);
      if (item) candidates.set(id, item);
    }
  }

  const edgePairs = await Promise.all(
    [...candidates.values()].map(async (item) => [
      item.id,
      await deps.edges({ harnessSlug: harness, planSlug: options.planSlug, workItemId: item.id }).catch(() => []),
    ] as const),
  );
  const edgesByItem = new Map<string, WorkItemSpecRevisionEdge[]>(edgePairs);
  const sources: PriorAttemptSource[] = [];

  for (const spec of allSpecs) {
    if (!targetSpecIds.has(spec.specId)) continue;
    sources.push(specSource(spec, options.planItemId));
  }
  if (plan) {
    for (const decision of parsePlan(plan.content).decisions) {
      sources.push({
        scope: 'plan-wide',
        authority: 'plan-decision',
        rawRef: `${options.planSlug}#${decision.id}`,
        planItemId: options.planItemId,
        text: `${decision.title}\n${decision.body}`,
      });
    }
  }

  await Promise.all(
    [...candidates.values()].map(async (item) => {
      const edges = edgesByItem.get(item.id) ?? [];
      const edgeSpecs = new Set(edges.map((edge) => edge.specId));
      const scope = scopeFor(item, targetSpecIds, edgeSpecs, options.planItemId);
      const [thread, checkpoint, lifecycle, priorWork] = await Promise.all([
        deps.thread(item.id, options.maxThreadPosts ?? 50, harness).catch(() => null),
        deps.checkpoint({ harness: item.harness, workItemId: item.id }).catch(() => ({ checkpoint: null, updatedAtMs: null })),
        workspaceId
          ? deps.lifecycle({ id: item.id, workspaceId, payload: item.payload, family: item.family }).catch(() => null)
          : Promise.resolve(null),
        deps.priorWork({ harness: item.harness, workItemId: item.id }).catch(() => null),
      ]);
      if (item.terminalCompletionRef || item.terminalCompletionEvidence) {
        const evidenceText = item.terminalCompletionEvidence
          ? JSON.stringify(item.terminalCompletionEvidence)
          : item.terminalCompletionRef!;
        sources.push({
          scope,
          authority: 'verified-completion',
          rawRef: `${item.id}#completion`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: item.closedAt ?? item.updatedAt,
          actor: item.terminalOwner,
          text: evidenceText,
          detail: { completionRef: item.terminalCompletionRef, authority: item.completionAuthority },
        });
      }
      if (checkpoint.checkpoint) {
        sources.push({
          scope,
          authority: retractionText(checkpoint.checkpoint) ? 'retraction' : 'checkpoint',
          rawRef: `${item.id}#checkpoint`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: checkpoint.updatedAtMs ? new Date(checkpoint.updatedAtMs).toISOString() : null,
          text: checkpoint.checkpoint,
        });
      }
      for (const post of thread?.posts ?? []) {
        sources.push({
          scope,
          authority: retractionText(post.body) ? 'retraction' : 'comment',
          rawRef: `${item.id}#comment:${post.id}`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: post.created_ts,
          actor: post.author_id,
          text: post.body,
        });
      }
      for (const event of lifecycle?.events ?? []) {
        sources.push({
          scope,
          authority: 'lifecycle',
          rawRef: `${item.id}#lifecycle:${event.source}:${event.atMs}:${event.kind}`,
          workItemId: item.id,
          planItemId: planItemIdsOf(item)[0] ?? null,
          at: event.at,
          actor: event.by,
          text: `${event.kind}${event.action ? ` (${event.action})` : ''}: ${JSON.stringify(event.detail ?? {})}`,
          detail: { source: event.source, ...event.detail },
        });
      }
      if (priorWork) {
        const lastReleasedBy = priorWork.lastReleasedBy;
        const releasedAt = priorWork.releasedAtMs ? new Date(priorWork.releasedAtMs).toISOString() : null;
        if (lastReleasedBy || releasedAt) {
          sources.push({
            scope,
            authority: 'release-provenance',
            rawRef: `${item.id}#release:${releasedAt ?? 'unknown'}`,
            workItemId: item.id,
            planItemId: planItemIdsOf(item)[0] ?? null,
            at: releasedAt,
            actor: lastReleasedBy,
            text: `claim released${lastReleasedBy ? ` by ${lastReleasedBy}` : ''}${releasedAt ? ` at ${releasedAt}` : ''}`,
          });
        }
      }
    }),
  );
  return compilePriorAttempts(sources);
}

function specSource(spec: SpecClauseRevision, targetPlanItemId: string): PriorAttemptSource {
  return {
    scope: 'same-spec',
    authority: 'current-spec',
    rawRef: `${spec.planSlug}#${spec.specId}@${spec.revision}`,
    specId: spec.specId,
    specRevision: spec.revision,
    planItemId: spec.planItemId,
    at: spec.createdAt,
    actor: spec.createdBy,
    text: `${spec.behavior} Required evidence: ${spec.requiredEvidence.join('; ')}. Required test layers: ${spec.requiredTestLayers.join('; ')}. Lifecycle: ${spec.lifecycleStatus}.`,
    detail: {
      currentRevision: spec.currentRevision,
      contentHash: spec.contentHash,
      targetPlanItemId,
      acceptanceRef: spec.acceptanceRef,
    },
  };
}
