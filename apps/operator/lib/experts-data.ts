/**
 * Experts read API (function-of-truth for both transports).
 *
 * The hono routes at /api/harness/:slug/experts* and the experts:* MCP
 * tools both call into here. Helpers (lookupProjectDir, listExpertIds,
 * readIdentity, computeNextAction, aggregateExpertSpendCents) live in
 * the hono module — exported there and imported here.
 */

import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';
import {
  EXPERT_ID_RE,
  aggregateExpertSpendCents,
  computeNextAction,
  expertDir,
  listExpertIds,
  lookupProjectDir,
  readIdentity,
  type Identity,
} from '../app/api/_hono/experts';
import { getKnownRoles } from './known-roles';
import { activeWorkspaceId } from './workspace-registry';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export type ExpertSummary = Pick<
  Identity,
  | 'id'
  | 'title'
  | 'status'
  | 'featureSize'
  | 'agentCount'
  | 'roundCount'
  | 'userEngaged'
  | 'forkedFrom'
  | 'createdAt'
  | 'updatedAt'
> & { nextAction: string };

export interface ExpertDetail extends Identity {
  specPath: string;
  spec: string;
  spentCents: number;
  nextAction: string;
}

export interface ExpertFeedback {
  id: string;
  persona: string;
  ended: boolean;
  verdict: unknown;
}

export interface ChatAgent {
  role: string;
  instanceId?: string;
  title?: string;
  status?: string;
}

// ── list ────────────────────────────────────────────────────────────

export async function listExperts(
  slug: string,
): Promise<Result<{ experts: ExpertSummary[] }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  const ids = await listExpertIds(projectDir);
  const out: ExpertSummary[] = [];
  for (const id of ids) {
    const ident = await readIdentity(projectDir, id);
    if (!ident) continue;
    out.push({
      id: ident.id,
      title: ident.title,
      status: ident.status,
      featureSize: ident.featureSize,
      agentCount: ident.agentCount,
      roundCount: ident.roundCount,
      userEngaged: ident.userEngaged,
      forkedFrom: ident.forkedFrom,
      createdAt: ident.createdAt,
      updatedAt: ident.updatedAt,
      nextAction: await computeNextAction(projectDir, ident.id, ident),
    });
  }
  return { ok: true, data: { experts: out } };
}

// ── expert-roles list (registered cross-cutting roles) ─────────────

export async function listExpertRoles(slug: string): Promise<Result<{ roles: unknown[] }>> {
  const reg = await (await import('./harness-registry')).loadHarnessRegistry();
  if (!reg.projects.find((p) => p.slug === slug)) {
    return { ok: false, status: 404, error: 'unknown harness' };
  }
  const { listRoles, __clearRoleRegistryCache } = await import('./role-registry');
  __clearRoleRegistryCache();
  const roles = listRoles(slug);
  return { ok: true, data: { roles } };
}

// ── single expert (with spec content + spend + nextAction) ─────────

export async function getExpert(
  slug: string,
  expertId: string,
): Promise<Result<ExpertDetail>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  if (!EXPERT_ID_RE.test(expertId)) return { ok: false, status: 400, error: 'invalid expert id' };
  const ident = await readIdentity(projectDir, expertId);
  if (!ident) return { ok: false, status: 404, error: 'expert not found' };
  const dir = expertDir(projectDir, expertId);
  const specPath = join(dir, 'SPEC.md');
  let spec = '';
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ spec_content: string }[]>`
    SELECT spec_content FROM harness_shared.harness_experts
     WHERE workspace_id = ${ws} AND harness_slug = ${slug}
       AND expert_id    = ${expertId}
     LIMIT 1
  `;
  if (rows.length > 0) spec = rows[0].spec_content ?? '';
  const spentCents = await aggregateExpertSpendCents(projectDir, expertId);
  const nextAction = await computeNextAction(projectDir, expertId, ident);
  return { ok: true, data: { ...ident, specPath, spec, spentCents, nextAction } };
}

// ── spec content only ──────────────────────────────────────────────

export async function getExpertSpec(
  slug: string,
  expertId: string,
): Promise<Result<{ content: string }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  if (!EXPERT_ID_RE.test(expertId)) return { ok: false, status: 400, error: 'invalid expert id' };
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ spec_content: string }[]>`
    SELECT spec_content FROM harness_shared.harness_experts
     WHERE workspace_id = ${ws} AND harness_slug = ${slug}
       AND expert_id    = ${expertId}
     LIMIT 1
  `;
  if (rows.length === 0) return { ok: false, status: 404, error: 'expert not found' };
  return { ok: true, data: { content: rows[0].spec_content ?? '' } };
}

// ── feedback list ──────────────────────────────────────────────────

export async function listExpertFeedback(
  slug: string,
  expertId: string,
): Promise<Result<{ feedback: ExpertFeedback[] }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  if (!EXPERT_ID_RE.test(expertId)) return { ok: false, status: 400, error: 'invalid expert id' };
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ feedback_id: string; persona: string; verdict: unknown | null }[]>`
    SELECT feedback_id, persona, verdict FROM harness_shared.harness_expert_feedback
     WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND expert_id = ${expertId}
     ORDER BY feedback_id ASC
  `;
  const out: ExpertFeedback[] = rows.map((r) => ({
    id: r.feedback_id,
    persona: r.persona,
    ended: r.verdict !== null,
    verdict: r.verdict,
  }));
  return { ok: true, data: { feedback: out } };
}

// ── chat-agents (sidebar) ──────────────────────────────────────────

export async function listChatAgents(slug: string): Promise<Result<{ agents: ChatAgent[] }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };

  const staticRoles = getKnownRoles().filter((r) => r !== 'feedback' && r !== 'expert');
  const agents: ChatAgent[] = [];
  for (const role of staticRoles) agents.push({ role });

  for (const id of await listExpertIds(projectDir)) {
    const ident = await readIdentity(projectDir, id);
    if (!ident) continue;
    if (ident.status === 'cancelled' || ident.status === 'superseded') continue;
    agents.push({
      role: 'expert',
      instanceId: ident.id,
      title: ident.title,
      status: ident.status,
    });
  }
  return { ok: true, data: { agents } };
}
