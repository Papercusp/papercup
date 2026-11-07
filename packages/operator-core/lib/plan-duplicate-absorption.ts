import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { ISSUE_FAMILY_ROUTE_KINDS } from './work-nature/agent-work-predicate';
import { readBlockerResolution, type PreparedBlockerDecision } from './blocker-resolution-decision';
import type { WorkItemDepEndpoint, WorkItemDependencyMutation } from './dbos/work-item-deps-store';

const terminal = new Set(['done', 'passed', 'resolved', 'closed', 'dropped', 'deprecated', 'superseded']);
type Row = { feature_id: string; harness_slug: string; item_kind: string; status: string;
  taken_by: string | null; plan_slug: string | null; plan_line_id: string | null; payload: unknown };
const endpoint = (row: Row): WorkItemDepEndpoint => ISSUE_FAMILY_ROUTE_KINDS.includes(row.item_kind as never)
  ? { kind: 'issue', ref: row.feature_id } : { kind: 'feature', ref: `${row.harness_slug}#${row.feature_id}` };
const fail = (detail: string): never => { throw new Error(`plan_absorption_refused: ${detail}`); };
export const absorptionDecisionHash = (title: string, body: string) =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex');

/** Bind existing plan decision, producer custody and the complete dependency
 * preimage under the lifecycle transaction. No producer state/claim is changed. */
export async function bindPlanAbsorptionInTransaction(
  tx: Sql,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string; itemId: string },
  prepared: Extract<PreparedBlockerDecision, { ok: true }>,
): Promise<{ prepared: Extract<PreparedBlockerDecision, { ok: true }>; mutations: WorkItemDependencyMutation[] }> {
  const decision = prepared.record.decision;
  if (decision.disposition !== 'absorb' || prepared.replayed) fail('fresh absorption decision required');
  if (decision.disposition !== 'absorb') throw new Error('unreachable');
  const rows = await tx<Row[]>`SELECT feature_id, harness_slug, item_kind, status, taken_by,
      plan_slug, plan_line_id, payload FROM harness_shared.work_items
    WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug}
      AND feature_id=${prepared.record.workItemId} FOR UPDATE`;
  const source = rows[0];
  if (!source || source.plan_slug !== scope.planSlug || source.plan_line_id !== scope.itemId ||
      source.taken_by !== prepared.record.authorId || terminal.has(source.status)) fail('current canonical source custody');
  if ((source.payload as { _claimHold?: unknown } | null)?._claimHold) fail('source hold must be lifted through its owner');
  // The preflight already parsed blocker evidence. Here inspect the raw stored
  // boundary conservatively, without initializing any live runtime resolver
  // while holding database locks. The paired payload CAS fences these bytes.
  const storedBlockers = (source.payload as { externalBlockers?: unknown } | null)?.externalBlockers;
  if (storedBlockers !== undefined && !Array.isArray(storedBlockers)) fail('unreadable stored blockers');
  for (const blocker of (storedBlockers ?? []) as Array<Record<string, unknown>>) {
    if (!blocker || typeof blocker !== 'object') fail('unreadable stored blocker');
    if (blocker.status === 'cleared') continue;
    if (blocker.status !== 'active') fail('unknown stored blocker status');
    if (blocker.kind !== 'runtime' || blocker.ref !== `plan-lane:${scope.planSlug}#${scope.itemId}` ||
        blocker.createdBy !== 'system:plan-item-lane-sync') fail('active external condition or hold');
  }
  const [authority] = await tx<{ title: string; body: string; item_refs: string[] }[]>`
    SELECT title, body, item_refs FROM harness_shared.plan_decisions
    WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug}
      AND plan_slug=${scope.planSlug} AND decision_id=${decision.absorption.decisionId} FOR SHARE`;
  if (!authority || !authority.item_refs.includes(scope.itemId) ||
      absorptionDecisionHash(authority.title, authority.body) !== decision.absorption.decisionHash) fail('exact governing decision and source item reference');
  const survivors: WorkItemDepEndpoint[] = [];
  for (const target of decision.absorption.survivors) {
    if (target.harness !== scope.harnessSlug || target.id === source.feature_id) fail('self or out-of-scope survivor');
    const [row] = await tx<Row[]>`SELECT feature_id, harness_slug, item_kind, status, taken_by,
        plan_slug, plan_line_id, payload FROM harness_shared.work_items
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${target.harness}
        AND feature_id=${target.id} FOR SHARE`;
    if (!row || terminal.has(row.status) || row.taken_by !== target.responsibleParty || !row.taken_by ||
        !row.plan_slug || row.plan_slug === scope.planSlug || !row.plan_line_id) fail('existing accountable surviving producer plan node');
    const prior = readBlockerResolution(row.payload);
    if (prior.status === 'invalid' || (prior.status === 'recorded' && prior.current.decision.disposition === 'absorb')) fail('survivor must be a real unabsorbed node');
    survivors.push(endpoint(row));
  }
  if (new Set(survivors.map(row => JSON.stringify(row))).size !== survivors.length) fail('duplicate survivor');
  const subject = endpoint(source);
  const edges = await tx<{ blocker_kind: 'feature' | 'issue'; blocker_ref: string; satisfaction: 'settled' | 'success' }[]>`
    SELECT blocker_kind, blocker_ref, satisfaction FROM harness_shared.work_item_deps
    WHERE workspace_id='default' AND dep_type='blocks' AND blocked_kind=${subject.kind}
      AND blocked_ref=${subject.ref} ORDER BY blocker_kind, blocker_ref FOR UPDATE`;
  if (edges.length > 128) fail('complete bounded source dependency census');
  const record = { ...prepared.record, absorptionGraph: {
    survivors: survivors as NonNullable<typeof prepared.record.absorptionGraph>['survivors'],
    obligations: edges.map(row => ({ blocker: { kind: row.blocker_kind, ref: row.blocker_ref }, satisfaction: row.satisfaction })),
  } };
  const state = { ...prepared.state, history: prepared.state.history.map(row => row === prepared.record ? record : row) };
  // A harmless remove requests the existing SERIALIZABLE dependency admission
  // seam even when the source currently has no consumers. It never adds a self edge.
  return { prepared: { ...prepared, record, state, patch: { blockerResolution: state } },
    mutations: [{ op: 'remove', blocked: subject, blocker: subject }] };
}

/** Canonical dependency writers expand both existing and future consumer edges.
 * Replacing the terminal duplicate preserves SUCCESS vs SETTLED requirements;
 * old source conditions remain in the immutable receipt and are inherited too. */
export async function expandAbsorbedDependenciesInTransaction<T extends {
  blocked: WorkItemDepEndpoint; blocker: WorkItemDepEndpoint;
  satisfaction: 'success' | 'settled'; createdBy: string | null;
}>(tx: Sql, workspaceId: string, candidate: readonly T[]): Promise<T[]> {
  const rows = await tx<Row[]>`SELECT feature_id, harness_slug, item_kind, status, taken_by,
      plan_slug, plan_line_id, payload FROM harness_shared.work_items
    WHERE workspace_id=${workspaceId}
      AND payload->'blockerResolution'->'history'->-1->'decision'->>'disposition'='absorb'`;
  if (!rows.length) return [...candidate];
  const absorbed = new Map(rows.map(row => {
    const read = readBlockerResolution(row.payload);
    if (read.status !== 'recorded' || !read.current.absorptionGraph) fail('unreadable absorption graph witness');
    if (read.status !== 'recorded' || !read.current.absorptionGraph) throw new Error('unreachable');
    return [JSON.stringify(endpoint(row)), read.current.absorptionGraph] as const;
  }));
  const key = (edge: T) => JSON.stringify([edge.blocked, edge.blocker]);
  let graph = new Map(candidate.map(edge => [key(edge), edge]));
  for (let depth = 0; depth <= absorbed.size; depth++) {
    let changed = false;
    const next = new Map<string, T>();
    const add = (edge: T, projected = false) => {
      if (projected && JSON.stringify(edge.blocked) === JSON.stringify(edge.blocker)) fail('self or cyclic survivor mapping');
      const prior = next.get(key(edge));
      next.set(key(edge), prior?.satisfaction === 'success' ? { ...edge, satisfaction: 'success' } : edge);
    };
    for (const edge of graph.values()) {
      const receipt = absorbed.get(JSON.stringify(edge.blocker));
      if (!receipt) { add(edge); continue; }
      changed = true;
      for (const blocker of receipt.survivors) add({ ...edge, blocker }, true);
      for (const condition of receipt.obligations) add({ ...edge, ...condition }, true);
    }
    graph = next;
    if (!changed) return [...graph.values()];
  }
  return fail('cyclic or incomplete transitive absorption mapping');
}
