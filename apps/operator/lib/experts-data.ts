/**
 * Experts read API (function-of-truth for both transports).
 *
 * The hono routes at /api/harness/:slug/experts* and the experts:* MCP
 * tools both call into here. Helpers (lookupProjectDir, listExpertIds,
 * readIdentity, computeNextAction, aggregateExpertSpendCents) live in
 * the hono module — exported there and imported here.
 */

import { join } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, asc, eq } from 'drizzle-orm';

const he = generated.harnessExpertsInHarnessShared;
const hef = generated.harnessExpertFeedbackInHarnessShared;
import {
  EXPERT_ID_RE,
  aggregateExpertSpendCents,
  computeNextAction,
  expertDir,
  listExpertIds,
  lookupProjectDir,
  readIdentity,
  type Identity,
} from './experts-core';
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
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ spec_content: he.specContent })
    .from(he)
    .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, expertId)))
    .limit(1);
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
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ spec_content: he.specContent })
    .from(he)
    .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, expertId)))
    .limit(1);
  if (rows.length === 0) return { ok: false, status: 404, error: 'expert not found' };
  return { ok: true, data: { content: rows[0].spec_content ?? '' } };
}

// ── assertions content only ────────────────────────────────────────
// Mirror of getExpertSpec for the assertions_content column added in
// libs/db/sql/057-expert-assertions.sql. Experts write this during
// finalization; phase-2 scoper merges them into validation-contract.md
// verbatim (instead of re-deriving assertions from prose).

export async function getExpertAssertions(
  slug: string,
  expertId: string,
): Promise<Result<{ content: string }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  if (!EXPERT_ID_RE.test(expertId)) return { ok: false, status: 400, error: 'invalid expert id' };
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ assertions_content: he.assertionsContent })
    .from(he)
    .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, expertId)))
    .limit(1);
  if (rows.length === 0) return { ok: false, status: 404, error: 'expert not found' };
  return { ok: true, data: { content: rows[0].assertions_content ?? '' } };
}

// ── feedback list ──────────────────────────────────────────────────

export async function listExpertFeedback(
  slug: string,
  expertId: string,
): Promise<Result<{ feedback: ExpertFeedback[] }>> {
  const projectDir = await lookupProjectDir(slug);
  if (!projectDir) return { ok: false, status: 404, error: 'unknown harness' };
  if (!EXPERT_ID_RE.test(expertId)) return { ok: false, status: 400, error: 'invalid expert id' };
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ feedback_id: hef.feedbackId, persona: hef.persona, verdict: hef.verdict })
    .from(hef)
    .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId)))
    .orderBy(asc(hef.feedbackId));
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
