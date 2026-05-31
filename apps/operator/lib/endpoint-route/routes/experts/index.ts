/**
 * /api/harness/:slug/experts/* + /chat-agents + /expert-roles —
 * instanced "expert" detailed-spec authoring agents. Phase A2
 * (endpoint-hono-elimination-2026-05-21). Ported off `_hono/experts.ts`
 * (mounted via `registerExperts`). URLs unchanged.
 *
 * The expert-data helpers (identity read/write, convergence, cost
 * rollup) live in `lib/experts-core.ts` — this file is just the 17
 * route handlers. `auth: 'public'` — the legacy `harness` sub-app
 * gated none of these.
 */
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import {
  EXPERT_ID_RE,
  FEEDBACK_ID_RE,
  PERSONA_RE,
  VALID_STATUSES,
  VALID_FEATURE_SIZES,
  expertDir,
  lookupProjectDir,
  projectDirToSlug,
  readIdentity,
  writeIdentity,
  readExpertCaps,
  evaluateConvergence,
  aggregateExpertSpendCents,
  nextExpertId,
  nextFeedbackId,
  type Identity,
} from '@/lib/experts-core';

/* eslint-disable @typescript-eslint/no-explicit-any */

const listExperts = defineTool({
  method: 'GET',
  path: '/harness/:slug/experts',
  auth: 'public',
  async handler(_req, ctx) {
    const { listExperts: list } = await import('@/lib/experts-data');
    const result = await list(ctx.params.slug);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const createExpert = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      title?: string; highLevelSpec?: string; budgetCents?: number;
      featureSize?: string; forkedFrom?: string;
    };
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return Response.json({ error: 'title required' }, { status: 400 });
    }
    if (typeof body.highLevelSpec !== 'string' || !body.highLevelSpec.trim()) {
      return Response.json({ error: 'highLevelSpec required' }, { status: 400 });
    }
    if (typeof body.budgetCents !== 'number' || body.budgetCents <= 0) {
      return Response.json({ error: 'budgetCents required (positive integer)' }, { status: 400 });
    }
    const featureSize = body.featureSize ?? 'standard';
    if (!VALID_FEATURE_SIZES.has(featureSize)) {
      return Response.json(
        { error: `featureSize must be one of: ${[...VALID_FEATURE_SIZES].join(', ')}` },
        { status: 400 },
      );
    }

    const id = await nextExpertId(projectDir);
    const now = new Date().toISOString();
    const identity: Identity = {
      id,
      title: body.title.trim(),
      slug,
      status: 'drafting',
      budgetCents: body.budgetCents,
      featureSize: featureSize as Identity['featureSize'],
      highLevelSpec: body.highLevelSpec,
      agentCount: 0,
      roundCount: 0,
      personasUsed: [],
      userEngaged: false,
      forkedFrom: body.forkedFrom,
      createdAt: now,
      updatedAt: now,
    };
    await writeIdentity(projectDir, identity);
    return Response.json(identity, { status: 201 });
  },
});

const expertRoles = defineTool({
  method: 'GET',
  path: '/harness/:slug/expert-roles',
  auth: 'public',
  async handler(_req, ctx) {
    const { listExpertRoles } = await import('@/lib/experts-data');
    const result = await listExpertRoles(ctx.params.slug);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const dispatch = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/dispatch',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const reg = await (await import('@/lib/harness-registry')).loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      role?: string; reason?: string; context?: Record<string, unknown>;
    };
    if (!body.role || typeof body.role !== 'string') {
      return Response.json({ error: 'role required' }, { status: 400 });
    }
    const { getRole } = await import('@/lib/role-registry');
    if (!getRole(body.role, slug)) {
      return Response.json({ error: `unknown role: ${body.role}` }, { status: 404 });
    }
    const { dispatchExpert } = await import('@/lib/expert-dispatcher');
    try {
      const result = await dispatchExpert(
        { slug, path: project.path },
        body.role,
        { reason: body.reason, context: body.context },
      );
      if (!result.ok) return Response.json(result, { status: 409 });
      return Response.json(result, { status: 200 });
    } catch (e) {
      return Response.json({ error: String((e as Error).message) }, { status: 400 });
    }
  },
});

const getExpert = defineTool({
  method: 'GET',
  path: '/harness/:slug/experts/:expertId',
  auth: 'public',
  async handler(_req, ctx) {
    const { getExpert: get } = await import('@/lib/experts-data');
    const result = await get(ctx.params.slug, ctx.params.expertId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const patchExpert = defineTool({
  method: 'PATCH',
  path: '/harness/:slug/experts/:expertId',
  auth: 'public',
  async handler(req, ctx) {
    const projectDir = await lookupProjectDir(ctx.params.slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return Response.json({ error: 'expert not found' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Partial<Identity>;

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) {
        return Response.json(
          { error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` },
          { status: 400 },
        );
      }
      ident.status = body.status;
    }
    if (body.terminationReason !== undefined) ident.terminationReason = String(body.terminationReason);
    if (body.userEngaged !== undefined) ident.userEngaged = !!body.userEngaged;
    if (body.title !== undefined && typeof body.title === 'string') ident.title = body.title;
    if (body.highLevelSpec !== undefined && typeof body.highLevelSpec === 'string') {
      ident.highLevelSpec = body.highLevelSpec;
    }
    await writeIdentity(projectDir, ident);
    return Response.json(ident);
  },
});

const openFeedback = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/:expertId/feedback',
  auth: 'public',
  async handler(req, ctx) {
    const projectDir = await lookupProjectDir(ctx.params.slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return Response.json({ error: 'expert not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { persona?: string };
    if (!body.persona || typeof body.persona !== 'string' || !PERSONA_RE.test(body.persona)) {
      return Response.json({ error: 'persona required (alpha + apostrophe/hyphen)' }, { status: 400 });
    }

    const fbId = await nextFeedbackId(projectDir, expertId);
    {
      const slug = await projectDirToSlug(projectDir);
      if (!slug) return Response.json({ error: 'unknown harness' }, { status: 404 });
      const { db } = (await import('@papercusp/db-org')).getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const ws = activeWorkspaceId();
      await db.insert(generated.harnessExpertFeedbackInHarnessShared).values({
        workspaceId: ws,
        harnessSlug: slug,
        expertId,
        feedbackId: fbId,
        persona: body.persona,
        createdAt: Date.now(),
      });
    }

    ident.agentCount += 1;
    if (!ident.personasUsed.includes(body.persona)) ident.personasUsed.push(body.persona);
    if (ident.status === 'drafting') ident.status = 'gathering_feedback';
    await writeIdentity(projectDir, ident);

    const caps = readExpertCaps(projectDir, ident);
    if (ident.agentCount >= caps.maxAgents) {
      ident.status = 'max_rounds';
      ident.terminationReason = `agentCount >= maxAgents (${caps.maxAgents})`;
      await writeIdentity(projectDir, ident);
    }

    return Response.json({ feedbackId: fbId, persona: body.persona, expertId, expert: ident }, { status: 201 });
  },
});

const appendTurn = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/:expertId/feedback/:fbId/turn',
  auth: 'public',
  async handler(req, ctx) {
    const projectDir = await lookupProjectDir(ctx.params.slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    const fbId = ctx.params.fbId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    if (!FEEDBACK_ID_RE.test(fbId)) return Response.json({ error: 'invalid feedback id' }, { status: 400 });

    const slug = await projectDirToSlug(projectDir);
    if (!slug) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const { db } = (await import('@papercusp/db-org')).getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq, sql: dsql, count } = await import('drizzle-orm');
    const hef = generated.harnessExpertFeedbackInHarnessShared;
    const het = generated.harnessExpertTurnsInHarnessShared;
    const ws = activeWorkspaceId();
    const fbExists = await db
      .select({ ok: dsql<number>`1` })
      .from(hef)
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)))
      .limit(1);
    if (fbExists.length === 0) return Response.json({ error: 'feedback conversation not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { from?: string; body?: string };
    if (body.from !== 'expert' && body.from !== 'feedback') {
      return Response.json({ error: 'from must be "expert" or "feedback"' }, { status: 400 });
    }
    if (typeof body.body !== 'string' || !body.body) {
      return Response.json({ error: 'body required' }, { status: 400 });
    }

    const countRows = await db
      .select({ n: count() })
      .from(het)
      .where(and(eq(het.workspaceId, ws), eq(het.harnessSlug, slug), eq(het.expertId, expertId), eq(het.feedbackId, fbId)));
    const nextIdx = Number(countRows[0]?.n ?? 0) + 1;
    await db.insert(het).values({
      workspaceId: ws,
      harnessSlug: slug,
      expertId,
      feedbackId: fbId,
      turnIdx: nextIdx,
      speaker: body.from,
      body: body.body,
      createdAt: Date.now(),
    });
    const fname = `turn-${String(nextIdx).padStart(3, '0')}-${body.from}.md`;
    return Response.json({ ok: true, turn: fname });
  },
});

const endFeedback = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/:expertId/feedback/:fbId/end',
  auth: 'public',
  async handler(req, ctx) {
    const projectDir = await lookupProjectDir(ctx.params.slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    const fbId = ctx.params.fbId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    if (!FEEDBACK_ID_RE.test(fbId)) return Response.json({ error: 'invalid feedback id' }, { status: 400 });

    const slug = await projectDirToSlug(projectDir);
    if (!slug) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const { db } = (await import('@papercusp/db-org')).getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { and, eq, sql: dsql } = await import('drizzle-orm');
    const hef = generated.harnessExpertFeedbackInHarnessShared;
    const he = generated.harnessExpertsInHarnessShared;
    const ws = activeWorkspaceId();
    const fbExists = await db
      .select({ ok: dsql<number>`1` })
      .from(hef)
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)))
      .limit(1);
    if (fbExists.length === 0) return Response.json({ error: 'feedback conversation not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      verdict?: { newIssues?: Array<{ summary?: string; severity?: string; specLines?: string }>; coversPriorIssues?: string[] };
    };
    if (!body.verdict || typeof body.verdict !== 'object') {
      return Response.json({ error: 'verdict required' }, { status: 400 });
    }
    const newIssues = Array.isArray(body.verdict.newIssues) ? body.verdict.newIssues : [];
    const coversPriorIssues = Array.isArray(body.verdict.coversPriorIssues) ? body.verdict.coversPriorIssues : [];
    const verdict = { newIssues, coversPriorIssues };
    await db
      .update(hef)
      .set({ verdict: verdict as any, endedAt: Date.now() })
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)));

    // Audit snapshot of SPEC content after this agent ended.
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return Response.json({ error: 'expert not found' }, { status: 404 });
    {
      const specRows = await db
        .select({ spec_content: he.specContent })
        .from(he)
        .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, expertId)))
        .limit(1);
      const specBody = specRows[0]?.spec_content ?? '';
      if (specBody) {
        ident.roundCount += 1;
        const dst = join(expertDir(projectDir, expertId), 'rounds', `round-${String(ident.roundCount).padStart(3, '0')}.md`);
        try {
          await mkdir(join(expertDir(projectDir, expertId), 'rounds'), { recursive: true });
          await writeFile(dst, specBody, 'utf8');
        } catch { /* best-effort audit snapshot */ }
      }
    }

    // Server-side termination checks (in order).
    const terminal = new Set(['final', 'max_rounds', 'cancelled', 'superseded', 'error']);
    if (!terminal.has(ident.status)) {
      const spentCents = await aggregateExpertSpendCents(projectDir, expertId);
      if (ident.budgetCents > 0 && spentCents >= ident.budgetCents) {
        ident.status = 'final';
        ident.terminationReason = `budget: ${spentCents}¢ spent of ${ident.budgetCents}¢ envelope`;
      } else {
        const caps = readExpertCaps(projectDir, ident);
        if (ident.roundCount >= caps.maxRounds) {
          ident.status = 'max_rounds';
          ident.terminationReason = `roundCount >= maxRounds (${caps.maxRounds})`;
        } else {
          const converged = await evaluateConvergence(projectDir, expertId);
          if (converged === 'final') {
            ident.status = 'final';
            ident.terminationReason = 'convergence: 2 consecutive non-substantive verdicts';
          }
        }
      }
    }
    await writeIdentity(projectDir, ident);
    return Response.json({ ok: true, verdict, expert: ident });
  },
});

const fork = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/:expertId/fork',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const oldId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(oldId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const oldIdent = await readIdentity(projectDir, oldId);
    if (!oldIdent) return Response.json({ error: 'expert not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { title?: string; budgetCents?: number };

    const newId = await nextExpertId(projectDir);
    const now = new Date().toISOString();
    const fresh: Identity = {
      ...oldIdent,
      id: newId,
      title: body.title ?? oldIdent.title,
      status: 'drafting',
      terminationReason: undefined,
      budgetCents: body.budgetCents ?? oldIdent.budgetCents,
      agentCount: 0,
      roundCount: 0,
      personasUsed: [],
      userEngaged: false,
      forkedFrom: oldId,
      createdAt: now,
      updatedAt: now,
    };
    await writeIdentity(projectDir, fresh);
    {
      const slugInner = await projectDirToSlug(projectDir);
      if (slugInner) {
        const { db } = (await import('@papercusp/db-org')).getOrgPg();
        const { generated } = await import('@papercusp/db-org');
        const { and, eq } = await import('drizzle-orm');
        const he = generated.harnessExpertsInHarnessShared;
        const ws = activeWorkspaceId();
        const srcRows = await db
          .select({ spec_content: he.specContent })
          .from(he)
          .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slugInner), eq(he.expertId, oldId)))
          .limit(1);
        if (srcRows.length > 0) {
          await db
            .update(he)
            .set({ specContent: srcRows[0].spec_content })
            .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slugInner), eq(he.expertId, newId)));
        }
      }
    }

    oldIdent.status = 'superseded';
    oldIdent.terminationReason = `forked into ${newId}`;
    await writeIdentity(projectDir, oldIdent);
    return Response.json(fresh, { status: 201 });
  },
});

const cancel = defineTool({
  method: 'POST',
  path: '/harness/:slug/experts/:expertId/cancel',
  auth: 'public',
  async handler(_req, ctx) {
    const projectDir = await lookupProjectDir(ctx.params.slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return Response.json({ error: 'expert not found' }, { status: 404 });
    ident.status = 'cancelled';
    ident.terminationReason = 'user cancelled';
    await writeIdentity(projectDir, ident);
    return Response.json(ident);
  },
});

const getSpec = defineTool({
  method: 'GET',
  path: '/harness/:slug/experts/:expertId/spec',
  auth: 'public',
  async handler(_req, ctx) {
    const { getExpertSpec } = await import('@/lib/experts-data');
    const result = await getExpertSpec(ctx.params.slug, ctx.params.expertId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const putSpec = defineTool({
  method: 'PUT',
  path: '/harness/:slug/experts/:expertId/spec',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const updated = await sql<{ updated: boolean }[]>`
      UPDATE harness_shared.harness_experts
         SET spec_content = ${body.content}, updated_at = ${Date.now()}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND expert_id = ${expertId}
      RETURNING TRUE AS updated
    `;
    if (updated.length === 0) return Response.json({ error: 'expert not found' }, { status: 404 });
    void notifySyncInvalidate('harnessIdentity').catch(() => {});
    return Response.json({ ok: true });
  },
});

const getAssertions = defineTool({
  method: 'GET',
  path: '/harness/:slug/experts/:expertId/assertions',
  auth: 'public',
  async handler(_req, ctx) {
    const { getExpertAssertions } = await import('@/lib/experts-data');
    const result = await getExpertAssertions(ctx.params.slug, ctx.params.expertId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const putAssertions = defineTool({
  method: 'PUT',
  path: '/harness/:slug/experts/:expertId/assertions',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const expertId = ctx.params.expertId;
    if (!EXPERT_ID_RE.test(expertId)) return Response.json({ error: 'invalid expert id' }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const updated = await sql<{ updated: boolean }[]>`
      UPDATE harness_shared.harness_experts
         SET assertions_content = ${body.content}, updated_at = ${Date.now()}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND expert_id = ${expertId}
      RETURNING TRUE AS updated
    `;
    if (updated.length === 0) return Response.json({ error: 'expert not found' }, { status: 404 });
    void notifySyncInvalidate('harnessIdentity').catch(() => {});
    return Response.json({ ok: true });
  },
});

const listFeedback = defineTool({
  method: 'GET',
  path: '/harness/:slug/experts/:expertId/feedback',
  auth: 'public',
  async handler(_req, ctx) {
    const { listExpertFeedback } = await import('@/lib/experts-data');
    const result = await listExpertFeedback(ctx.params.slug, ctx.params.expertId);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const chatAgents = defineTool({
  method: 'GET',
  path: '/harness/:slug/chat-agents',
  auth: 'public',
  async handler(_req, ctx) {
    const { listChatAgents } = await import('@/lib/experts-data');
    const result = await listChatAgents(ctx.params.slug);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

export default [
  listExperts,
  createExpert,
  expertRoles,
  dispatch,
  getExpert,
  patchExpert,
  openFeedback,
  appendTurn,
  endFeedback,
  fork,
  cancel,
  getSpec,
  putSpec,
  getAssertions,
  putAssertions,
  listFeedback,
  chatAgents,
];
