/** Plan-line storage over the existing work graph (migration 1601). */
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { deriveIndexFromContent, type PlanIndexItem } from './derive-index';
import { ISSUE_FAMILY_ROUTE_KINDS } from '../../work-nature/agent-work-predicate';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import {
  mutateWorkItemDependenciesInTransaction, withWorkItemDependencyAdmissionTransaction,
  type WorkItemDependencyMutation,
} from '../../dbos/work-item-deps-store';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './plan-lock-key';
import { hashPlanContent } from './content-hash';
import { summarizeItemParse } from './item-parse-feedback';

export interface PlanLineScope { workspaceId: string; harnessSlug: string; slug: string }
export interface PlanLineNode extends PlanIndexItem { featureId: string; kind: string; planSlug: string }
export interface PlanLineWorkItemRef {
  workItemId: string;
  planSlug: string | null;
  planItemId: string | null;
}

/** Join canonical nodes with an existing reader's legacy cohort without rewriting either representation. */
export async function readPlanLineWorkItemRefs(tx: Sql, scope: PlanLineScope & {
  workItemIds: string[];
  limit: number;
}): Promise<PlanLineWorkItemRef[]> {
  const rows = await tx<{ feature_id: string; plan_slug: string | null; plan_line_id: string | null }[]>`
    SELECT feature_id, plan_slug, plan_line_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND (plan_slug = ${scope.slug} OR feature_id = ANY(${scope.workItemIds}::text[]))
     ORDER BY feature_id
     LIMIT ${scope.limit}`;
  return rows.map(row => ({ workItemId: row.feature_id, planSlug: row.plan_slug, planItemId: row.plan_line_id }));
}
export interface ValidatedPlanLineAdoption { featureId: string; kind: string; status: string; planStatus: string }
/** Transaction-validated status projection from a distinct committed execution row. */
export interface ValidatedPlanLineLifecycleProjection {
  canonicalFeatureId: string;
  sourceWorkItemId: string;
  terminalStatus: 'done';
}
export function planLineStatusFromWorkItem(status: string): string {
  return ['done', 'resolved', 'closed'].includes(status) ? 'done'
    : ['dropped', 'superseded'].includes(status) ? 'dropped'
      : status === 'wip' ? 'wip' : status === 'needs-human' ? 'needs-human'
        : status === 'blocked' ? 'blocked' : 'todo';
}

const endpoint = (node: PlanLineNode, harness: string) =>
  (ISSUE_FAMILY_ROUTE_KINDS as readonly string[]).includes(node.kind)
    ? { kind: 'issue' as const, ref: node.featureId }
    : { kind: 'feature' as const, ref: `${harness}#${node.featureId}` };

export async function readPlanLineNodes(tx: Sql, scope: Omit<PlanLineScope, 'slug'> & { slug: string | string[] }): Promise<PlanLineNode[]> {
  const { workspaceId, harnessSlug, slug } = scope;
  const rows = await tx<{
    feature_id: string; item_kind: string; plan_slug: string; plan_line_id: string; status: string;
    plan_line_text: string; plan_importance: string | null; plan_phase: string | null;
    plan_decision_refs: string[]; plan_deliverable: string | null;
    plan_owner_gate_marker: string | null; blocked_by: string[];
  }[]>`
    SELECT n.feature_id, n.item_kind, n.plan_slug, n.plan_line_id, n.status, n.plan_line_text,
           n.plan_importance, n.plan_phase, n.plan_decision_refs, n.plan_deliverable,
           n.plan_owner_gate_marker,
           ARRAY(SELECT b.plan_line_id FROM harness_shared.work_item_deps d
             JOIN harness_shared.work_items b ON b.workspace_id = n.workspace_id
              AND b.harness_slug = n.harness_slug AND b.plan_slug = n.plan_slug
              AND b.plan_line_id IS NOT NULL
              AND d.blocker_kind = CASE WHEN b.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN 'issue' ELSE 'feature' END
              AND d.blocker_ref = CASE WHEN b.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN b.feature_id ELSE b.harness_slug || '#' || b.feature_id END
             WHERE d.workspace_id = ${DEFAULT_COORD_WORKSPACE} AND d.dep_type = 'blocks'
               AND d.blocked_kind = CASE WHEN n.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN 'issue' ELSE 'feature' END
               AND d.blocked_ref = CASE WHEN n.item_kind = ANY(${[...ISSUE_FAMILY_ROUTE_KINDS]}::text[]) THEN n.feature_id ELSE n.harness_slug || '#' || n.feature_id END
             ORDER BY b.plan_seq, b.plan_line_id) AS blocked_by
      FROM harness_shared.work_items n
     WHERE n.workspace_id = ${workspaceId} AND n.harness_slug = ${harnessSlug}
       AND n.plan_slug = ANY(${Array.isArray(slug) ? slug : [slug]}::text[]) AND n.plan_line_id IS NOT NULL
     ORDER BY n.plan_seq, n.plan_line_id`;
  return rows.map((r) => ({
    id: r.plan_line_id, featureId: r.feature_id, kind: r.item_kind, planSlug: r.plan_slug,
    text: r.plan_line_text, importance: r.plan_importance ?? 'normal',
    phase: r.plan_phase, decisionRefs: r.plan_decision_refs,
    deliverable: r.plan_deliverable, ownerGateMarker: r.plan_owner_gate_marker,
    status: ['done', 'resolved', 'closed'].includes(r.status) ? 'done'
      : ['dropped', 'superseded'].includes(r.status) ? 'dropped'
        : r.status === 'wip' ? 'wip' : r.status === 'needs-human' ? 'needs-human'
          : r.status === 'blocked' ? 'blocked' : 'todo',
    blockedBy: r.blocked_by,
  }));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPlanIndexItem(value: unknown): value is PlanIndexItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PlanIndexItem>;
  return typeof item.id === 'string' && typeof item.status === 'string' &&
    typeof item.text === 'string' && typeof item.importance === 'string' &&
    isStringArray(item.blockedBy) && isStringArray(item.decisionRefs) &&
    (item.phase == null || typeof item.phase === 'string') &&
    (item.ownerGateMarker == null || typeof item.ownerGateMarker === 'string') &&
    (item.deliverable == null || typeof item.deliverable === 'string');
}

function planIndexFingerprint(items: readonly PlanIndexItem[]): string {
  return JSON.stringify(items.map((item) => [
    item.id, item.status, item.text, item.importance, item.blockedBy, item.decisionRefs,
    item.phase ?? null, item.ownerGateMarker ?? null, item.deliverable ?? null,
  ]));
}

/** Compare the existing subgraph exactly while allowing edges involving new
 * candidate lines. Unknown blocker IDs remain visible to the normal guards. */
function representedItemsForAdditiveComparison(items: readonly PlanIndexItem[], before: readonly PlanIndexItem[]): PlanIndexItem[] {
  const prior = new Map(before.map(item => [item.id, item]));
  const addedIds = new Set(items.filter(item => !prior.has(item.id)).map(item => item.id));
  return items.filter(item => prior.has(item.id)).map(item => {
    const oldText = prior.get(item.id)?.text ?? item.text;
    // The ordinary writer retains canonical bytes for whitespace-only edits.
    // Compare those same bytes here without rewriting a represented row.
    const sameText = item.text.replace(/\s+/g, ' ').trim() === oldText.replace(/\s+/g, ' ').trim();
    return { ...item, text: sameText ? oldText : item.text,
      blockedBy: item.blockedBy.filter(id => !addedIds.has(id)) };
  });
}

/**
 * A pre-1601 writer persisted the derived JSON index but did not create work-graph
 * line nodes. Use that index only as a verified witness for the canonical bytes:
 * an explicit empty index or a mismatching/stale JSON twin never resurrects text.
 */
function matchingLegacyPlanItems(items: unknown, content: string): PlanIndexItem[] | null {
  if (!Array.isArray(items) || items.length === 0 || !items.every(isPlanIndexItem)) return null;
  const legacyItems = items as PlanIndexItem[];
  try {
    const canonicalItems = deriveIndexFromContent(content).items;
    return canonicalItems.length > 0 &&
      planIndexFingerprint(legacyItems) === planIndexFingerprint(canonicalItems)
      ? legacyItems
      : null;
  } catch {
    return null;
  }
}

/** A matching saved index can witness an old writer's addition to a partial graph.
 * Refuse a rewrite rather than silently deleting that line or guessing that it
 * should be resurrected. Graphless plans retain their validated fallback.
 */
export function missingStoredPlanLineIds(
  nodes: readonly PlanLineNode[],
  parentRow: { items: unknown; content: string | null },
): string[] {
  if (nodes.length === 0) return [];
  const witnessed = matchingLegacyPlanItems(parentRow.items, parentRow.content ?? '');
  const represented = new Set(nodes.map((node) => node.id));
  return witnessed?.filter((item) => !represented.has(item.id)).map((item) => item.id) ?? [];
}

async function readValidatedLegacyPlanItems(
  tx: Sql,
  scope: Omit<PlanLineScope, 'slug'>,
  slugs: readonly string[],
): Promise<Map<string, PlanIndexItem[]>> {
  const uniqueSlugs = [...new Set(slugs)];
  if (uniqueSlugs.length === 0) return new Map();
  // The graph path avoids detoasting plan content. Only graphless rows with a
  // nonempty JSON index reach this query, and only those rows return content.
  const rows = await tx<{ plan_slug: string; items: unknown; content: string | null }[]>`
    SELECT plan_slug, items, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ANY(${uniqueSlugs}::text[])
       AND items IS NOT NULL AND items <> '[]'::jsonb
  `;
  const result = new Map<string, PlanIndexItem[]>();
  for (const row of rows) {
    const items = matchingLegacyPlanItems(row.items, row.content ?? '');
    if (items) result.set(row.plan_slug, items);
  }
  return result;
}

/** Read graph rows first; consult the validated old JSON index only when the graph is empty. */
export async function readPlanLineItems(
  tx: Sql,
  scope: PlanLineScope,
  parentRow?: { items: unknown; content: string | null },
): Promise<PlanIndexItem[]> {
  const nodes = await readPlanLineNodes(tx, scope);
  if (nodes.length > 0) return nodes;
  if (parentRow) return matchingLegacyPlanItems(parentRow.items, parentRow.content ?? '') ?? [];
  const legacy = await readValidatedLegacyPlanItems(tx, scope, [scope.slug]);
  return legacy.get(scope.slug) ?? [];
}

/** Batched graph-first item read for one harness; legacy JSON is queried only for graphless plans. */
export async function readPlanLineItemsByPlan(
  tx: Sql,
  scope: Omit<PlanLineScope, 'slug'>,
  slugs: readonly string[],
): Promise<Map<string, PlanIndexItem[]>> {
  const uniqueSlugs = [...new Set(slugs)];
  const nodes = await readPlanLineNodes(tx, { ...scope, slug: uniqueSlugs });
  const result = new Map<string, PlanIndexItem[]>();
  for (const node of nodes) {
    const items = result.get(node.planSlug) ?? [];
    items.push(node);
    result.set(node.planSlug, items);
  }
  const graphless = uniqueSlugs.filter((slug) => !result.has(slug));
  const legacy = await readValidatedLegacyPlanItems(tx, scope, graphless);
  for (const [slug, items] of legacy) result.set(slug, items);
  return result;
}

/** Under the plan lock; admit the returned edge changes in the SAME transaction. */
export async function writePlanLineNodes(
  tx: Sql, scope: PlanLineScope, before: readonly PlanLineNode[], items: readonly PlanIndexItem[],
  options: {
    /** Migration only: preserve every represented row without even a timestamp UPDATE. */
    addOnly?: boolean;
    allowDraftStatusProjection?: boolean;
    validatedAdoptions?: ReadonlyMap<string, ValidatedPlanLineAdoption>;
    validatedLifecycleProjections?: ReadonlyMap<string, ValidatedPlanLineLifecycleProjection>;
  } = {},
): Promise<WorkItemDependencyMutation[]> {
  const { workspaceId, harnessSlug, slug } = scope;
  const prior = new Map(before.map((n) => [n.id, n]));
  if (options.addOnly) {
    const represented = representedItemsForAdditiveComparison(items, before);
    if (new Set(items.map(item => item.id)).size !== items.length ||
        planIndexFingerprint(represented) !== planIndexFingerprint(before) ||
        before.some((node, seq) => items[seq]?.id !== node.id) ||
        items.some(item => !prior.has(item.id) && item.status !== 'todo') ||
        options.validatedAdoptions?.size || options.validatedLifecycleProjections?.size) {
      throw new Error('saved_plan_lines_not_additive');
    }
  }
  const next = new Map<string, PlanLineNode>();
  const now = Date.now();
  for (const [seq, item] of items.entries()) {
    const old = prior.get(item.id);
    const status = item.status === 'todo' ? 'open' : item.status;
    const adopted = options.validatedAdoptions?.get(item.id);
    if (adopted) {
      if (old || item.status !== adopted.planStatus) throw new Error('adoption_canonical_conflict');
      // A validated adoption is an UPDATE of the original row, never a late
      // attachment followed by INSERT against the frozen prior-node map.
      const updated = await tx<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items SET plan_slug=${slug},plan_line_id=${item.id},plan_seq=${seq},
          plan_phase=${item.phase},plan_importance=${item.importance},plan_decision_refs=${item.decisionRefs}::text[],
          plan_deliverable=${item.deliverable ?? null},plan_owner_gate_marker=${item.ownerGateMarker ?? null},
          plan_line_text=${item.text},updated_ts=${now},origin='local'
        WHERE workspace_id=${workspaceId} AND harness_slug=${harnessSlug} AND feature_id=${adopted.featureId}
          AND item_kind=${adopted.kind} AND status=${adopted.status} AND plan_slug IS NULL AND plan_line_id IS NULL
        RETURNING feature_id`;
      if (updated.length !== 1) throw new Error('adoption_canonical_conflict');
      next.set(item.id, { ...item, featureId: adopted.featureId, kind: adopted.kind, planSlug: slug });
    } else if (old) {
      if (options.addOnly) {
        // Keep the row untouched; validated new blockers are written only by
        // the canonical dependency writer below.
        next.set(item.id, { ...old, blockedBy: item.blockedBy });
        continue;
      }
      const changeStatus = item.status !== old.status;
      // Match planExecutionMeaning's whitespace semantics. Rendering metadata
      // before a legacy inline note can change its separator spacing; storing
      // that cosmetic change revokes the start via fence_plan_execution_graph.
      // Retain the canonical bytes (and title/summary) until the text changes.
      const changeText = item.text.replace(/\s+/g, ' ').trim() !== old.text.replace(/\s+/g, ' ').trim();
      // A plan rewrite has no authenticated completion evidence. It must not
      // close a claimed node while preserving its holder and null authority,
      // or reopen a settled node while retaining its old completion record.
      // Canonical lifecycle writers update the graph first; their subsequent
      // plan reflection has no status edge here and remains a normal rewrite.
      const lifecycleProjection = options.validatedLifecycleProjections?.get(item.id);
      const verifiedCompletionProjection =
        lifecycleProjection?.canonicalFeatureId === old.featureId &&
        lifecycleProjection.sourceWorkItemId !== old.featureId &&
        lifecycleProjection.terminalStatus === status;
      if (!options.allowDraftStatusProjection && changeStatus &&
          [status, old.status].some(value => value === 'done' || value === 'dropped') &&
          !verifiedCompletionProjection) {
        throw new Error(`plan_line_status_change_requires_lifecycle_writer: ${harnessSlug}#${old.featureId} ` +
          `(${slug}#${item.id}); use work_items:complete for completion or work_items:set_state for other lifecycle changes`);
      }
      await tx`
        UPDATE harness_shared.work_items SET plan_seq = ${seq}, plan_phase = ${item.phase},
          plan_importance = ${item.importance}, plan_decision_refs = ${item.decisionRefs}::text[],
          plan_deliverable = ${item.deliverable ?? null}, plan_owner_gate_marker = ${item.ownerGateMarker ?? null},
          plan_line_text = CASE WHEN ${changeText} THEN ${item.text} ELSE plan_line_text END,
          title = CASE WHEN ${changeText} THEN ${item.text.slice(0, 300)} ELSE title END,
          summary = CASE WHEN ${changeText} THEN ${item.text} ELSE summary END,
          status = CASE WHEN ${changeStatus} THEN ${status} ELSE status END,
          closed_ts = CASE WHEN ${changeStatus} THEN CASE WHEN ${status} IN ('done', 'dropped') THEN ${now}::bigint ELSE NULL END ELSE closed_ts END,
          updated_ts = ${now}, origin = 'local'
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${old.featureId}`;
      next.set(item.id, { ...item, featureId: old.featureId, kind: old.kind, planSlug: slug });
    } else {
      const park = status === 'open' ? {
        _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes',
        claim_hold_at: new Date(now).toISOString(),
        claim_hold_reason: 'Plan-line transition park until one-work-graph-structured-holds-2026-10-26 P-008 (D-011).',
      } : {};
      const [row] = await tx<{ feature_id: string }[]>`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, nature, audience,
           origin, source_plan_slug, source_plan_item_ids, feature_order, payload, created_ts, updated_ts, ts,
           plan_slug, plan_line_id, plan_seq, plan_phase, plan_importance, plan_decision_refs,
           plan_deliverable, plan_owner_gate_marker, plan_line_text)
        VALUES (${workspaceId}, ${harnessSlug}, harness_shared.next_work_item_id(), ${item.text.slice(0, 300)},
          ${item.text}, ${status}, 'feature', 'work', 'agent', 'local', ${slug}, ${[item.id]}::text[],
          ${seq}, ${JSON.stringify(park)}::text::jsonb, ${now}, ${now}, ${now},
          ${slug}, ${item.id}, ${seq}, ${item.phase}, ${item.importance}, ${item.decisionRefs}::text[],
          ${item.deliverable ?? null}, ${item.ownerGateMarker ?? null}, ${item.text}) RETURNING feature_id`;
      next.set(item.id, { ...item, featureId: row.feature_id, kind: 'feature', planSlug: slug });
    }
  }
  const mutations: WorkItemDependencyMutation[] = [];
  for (const old of before) {
    const desired = next.get(old.id);
    for (const id of old.blockedBy) if (!desired?.blockedBy.includes(id)) {
      const blocker = prior.get(id);
      if (blocker) mutations.push({ op: 'remove', blocked: endpoint(old, harnessSlug), blocker: endpoint(blocker, harnessSlug) });
    }
    if (!desired) {
      // Unlink the line without deleting work, descendants, history, or external edges.
      await tx`UPDATE harness_shared.work_items SET plan_slug = NULL, plan_line_id = NULL,
        plan_seq = NULL, updated_ts = ${now}, origin = 'local'
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${old.featureId}`;
    }
  }
  for (const node of next.values()) for (const id of node.blockedBy) {
    const blocker = next.get(id);
    if (!blocker) throw new Error(`plan_line_blocker_missing: ${slug}#${node.id} requires ${id}`);
    if (!prior.get(node.id)?.blockedBy.includes(id)) mutations.push({ op: 'add',
      blocked: endpoint(node, harnessSlug), blocker: endpoint(blocker, harnessSlug),
      satisfaction: 'settled', createdBy: `plan-dependency:${harnessSlug}/${slug}`,
    });
  }
  return mutations;
}

export interface SavedPlanLinesPreview {
  issuedAt: string;
  fingerprint: string;
}

/** Bounded reconciliation for a matching old-writer witness, never a plan rewrite.
 * The caller supplies the normal app SQL client; the dependency writer owns the
 * SERIALIZABLE boundary. DB-rendered JSON/xmin retains all claim, hold, completion
 * and edge versions without JS timestamp/number round trips.
 */
export async function repairSavedPlanLines(sql: Sql, input: PlanLineScope & {
  expectedVersion: number;
  expectedContentHash: string;
  dryRun: boolean;
  preview?: SavedPlanLinesPreview;
}) {
  return withWorkItemDependencyAdmissionTransaction(sql, async tx => {
    const { workspaceId, harnessSlug, slug } = input;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),
      set_config('search_path', 'harness_shared, papercusp_shared, public', true)`;
    await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(workspaceId, harnessSlug, slug));
    const [parent] = await tx<{
      content: string; content_hash: string; version: string; items: unknown; record: string;
    }[]>`SELECT p.content,p.content_hash,p.version::text,p.items,
        jsonb_build_object('row',to_jsonb(p),'xmin',p.xmin::text)::text AS record
      FROM harness_shared.harness_plans p WHERE p.workspace_id=${workspaceId}
        AND p.harness_slug=${harnessSlug} AND p.plan_slug=${slug} FOR UPDATE`;
    if (!parent || parent.version !== String(input.expectedVersion) ||
        parent.content_hash !== input.expectedContentHash || hashPlanContent(parent.content) !== parent.content_hash)
      throw new Error('saved_plan_lines_parent_changed');
    // A matching derived index is insufficient when both copies omitted an
    // invalid physical item line (for example an unknown status token).
    if (summarizeItemParse(parent.content, { bodyProvided: true }).unparsedItemLines)
      throw new Error('saved_plan_lines_not_additive');
    const saved = matchingLegacyPlanItems(parent.items, parent.content);
    if (!saved) throw new Error('saved_plan_lines_witness_mismatch');
    const rows = await tx<{ feature_id: string; plan_seq: number; record: string }[]>`
      SELECT w.feature_id,w.plan_seq,jsonb_build_object('row',to_jsonb(w),'xmin',w.xmin::text)::text AS record
      FROM harness_shared.work_items w WHERE w.workspace_id=${workspaceId}
        AND w.harness_slug=${harnessSlug} AND w.plan_slug=${slug} AND w.plan_line_id IS NOT NULL
      ORDER BY w.plan_seq,w.plan_line_id,w.feature_id LIMIT 513 FOR UPDATE`;
    if (!rows.length || rows.length > 512 || saved.length > 512)
      throw new Error('saved_plan_lines_scope_unavailable');
    const before = await readPlanLineNodes(tx, input);
    const ids = rows.map(row => row.feature_id);
    const refs = [...ids, ...ids.map(id => `${harnessSlug}#${id}`)];
    const dependencies = await tx<{ record: string }[]>`
      SELECT jsonb_build_object('row',to_jsonb(d),'xmin',d.xmin::text)::text AS record
      FROM harness_shared.work_item_deps d WHERE d.workspace_id=${DEFAULT_COORD_WORKSPACE}
        AND (d.blocked_ref=ANY(${refs}::text[]) OR d.blocker_ref=ANY(${refs}::text[]))
      ORDER BY d.workspace_id,d.blocked_kind,d.blocked_ref,d.blocker_kind,d.blocker_ref,d.dep_type,d.id
      LIMIT 2049 FOR UPDATE`;
    const links = await tx<{ record: string }[]>`
      SELECT jsonb_build_object('row',to_jsonb(l),'xmin',l.xmin::text)::text AS record
      FROM harness_shared.coord_links l WHERE l.workspace_id=${DEFAULT_COORD_WORKSPACE}
        AND (l.src_ref=ANY(${refs}::text[]) OR l.dst_ref=ANY(${refs}::text[]))
      ORDER BY l.workspace_id,l.src_kind,l.src_ref,l.dst_kind,l.dst_ref,l.rel,l.id LIMIT 2049 FOR UPDATE`;
    if (dependencies.length + links.length > 2048) throw new Error('saved_plan_lines_scope_too_large');
    const prior = new Map(before.map(node => [node.id, node]));
    // The graph owns represented lifecycle state: legacy saved todo bytes may
    // predate a current blocked hold. Preserve that state rather than projecting
    // the stale index back over it; all other represented meaning must agree.
    const withCanonicalStatuses = saved.map(item => ({
      ...item, status: prior.get(item.id)?.status ?? item.status,
    }));
    const represented = representedItemsForAdditiveComparison(withCanonicalStatuses, before);
    const missing = saved.filter(item => !prior.has(item.id));
    if (new Set(saved.map(item => item.id)).size !== saved.length ||
        rows.some((row, seq) => row.plan_seq !== seq) ||
        planIndexFingerprint(represented) !== planIndexFingerprint(before) ||
        before.some((node, seq) => saved[seq]?.id !== node.id) ||
        missing.some(item => item.status !== 'todo') ||
        saved.some(item => item.blockedBy.some(id => !saved.some(candidate => candidate.id === id))))
      throw new Error('saved_plan_lines_not_additive');
    const issuedAt = input.dryRun ? new Date().toISOString() : input.preview?.issuedAt;
    const age = issuedAt ? Date.now() - Date.parse(issuedAt) : NaN;
    if (!Number.isFinite(age) || age < 0 || age > 300_000) throw new Error('saved_plan_lines_preview_expired');
    const record = { schemaVersion: 1, workspaceId, harnessSlug, slug, issuedAt,
      parent: parent.record, nodes: rows.map(row => row.record),
      dependencies: dependencies.map(row => row.record), links: links.map(row => row.record) };
    const [canonical] = await tx<{ canonical: string }[]>`SELECT ${tx.json(record)}::jsonb::text AS canonical`;
    const preview: SavedPlanLinesPreview = { issuedAt: issuedAt!,
      fingerprint: `v1:${createHash('sha256').update(canonical.canonical).digest('hex')}` };
    // An already reconciled request is a no-op, even when its original preview
    // predates the inserts. Never run the ordinary writer over represented rows.
    if (!input.dryRun && missing.length && input.preview?.fingerprint !== preview.fingerprint)
      throw new Error('saved_plan_lines_preview_changed');
    let edgesWritten = 0;
    if (!input.dryRun && missing.length) {
      const desired = saved.map(item => {
        const old = prior.get(item.id);
        return old ? { ...old, blockedBy: item.blockedBy } : item;
      });
      const mutations = await writePlanLineNodes(tx, input, before, desired, { addOnly: true });
      if (mutations.some(mutation => mutation.op !== 'add')) throw new Error('saved_plan_lines_not_additive');
      const result = await mutateWorkItemDependenciesInTransaction(tx, {
        workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: workspaceId, mutations,
      });
      edgesWritten = result.inserted;
    }
    return { dryRun: input.dryRun, slug, expectedVersion: input.expectedVersion,
      expectedContentHash: input.expectedContentHash, preview,
      representedItemIds: before.map(node => node.id),
      representedRows: rows.map(row => row.record), missingItems: missing,
      nodesAdded: input.dryRun ? 0 : missing.length, edgesWritten,
      alreadyReconciled: missing.length === 0 };
  });
}
