/**
 * Harness Issues tracker — list + mutations:
 *
 *   GET  /api/harness/:slug/issues-list           — issues.json + pending queue
 *   POST /api/harness/:slug/issues                — human-filed issue
 *   POST /api/harness/:slug/issues/append-pending — validator-facing append
 *   POST /api/harness/:slug/issues/:id/update     — edit fields / add a note
 *   POST /api/harness/:slug/triage                — curator-style merge of pending → issues
 *
 * `POST /:slug/issues/:id/promote` stays in `_hono/harness.ts` — depends
 * on the `auditFeatureChange` helper still living there. It migrates
 * with the features-mutation cluster (later batch).
 *
 * Issues data is JSON-canonical on disk (`.harness/issues.json`) with a
 * PG mirror in `harness_issues`; the validator's structured findings live
 * in `harness_pending_issues`. Helpers in `@/lib/harness-issues`.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 25b — paired with 25a which carved out the helpers).
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';
import { resolvePhasedProject, harnessDir } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import {
  loadIssuesOrSeed,
  saveIssues,
  readPendingIssues,
} from '@/lib/harness-issues';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import type { Issue, IssueSeverity, IssueStatus } from '@/app/harness/issues/types';
import { defineRoute } from '../../define-route';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const issuesList = defineRoute({
  method: 'GET',
  path: '/harness/:slug/issues-list',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const file = loadIssuesOrSeed(project);
    const pending = await readPendingIssues(project);
    return Response.json({ ...file, pending });
  },
});

const createIssue = defineRoute({
  method: 'POST',
  path: '/harness/:slug/issues',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = await req.json().catch(() => ({} as any));
    if (!body.title || typeof body.title !== 'string') {
      return Response.json({ error: 'title required' }, { status: 400 });
    }
    const file = loadIssuesOrSeed(project);
    const id = `I-${String(file.nextId).padStart(4, '0')}`;
    const issue: Issue = {
      id,
      title: body.title,
      severity: body.severity ?? 'minor',
      source: 'human',
      foundAt: new Date().toISOString(),
      status: 'open',
      evidence: body.evidence,
      repro: body.repro,
      suggestedFix: body.suggestedFix,
      codePointer: body.codePointer,
      attempts: 0,
      notes: [],
    };
    file.issues.unshift(issue);
    file.nextId += 1;
    await saveIssues(project, file);
    return Response.json(issue);
  },
});

/**
 * POST /:slug/issues/append-pending — validator-facing.
 *
 * Replaces the validator's direct write to `.harness/pending-issues.jsonl`.
 * Inserts directly into `harness_pending_issues` (the same table the
 * fs-watcher mirrors disk writes to). The next /triage call merges into
 * issues.json + harness_issues using the curator's dedup pass.
 */
const appendPendingIssue = defineRoute({
  method: 'POST',
  path: '/harness/:slug/issues/append-pending',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => null)) as null | {
      title?: string;
      severity?: 'critical' | 'major' | 'minor' | 'nit';
      foundDuring?: string;
      repro?: string;
      evidence?: string;
      suggestedFix?: string;
      codePointer?: string;
      linkedFeatureId?: string;
    };
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return Response.json({ error: 'title required' }, { status: 400 });
    }
    const payload = {
      title: body.title.trim(),
      severity: body.severity ?? 'minor',
      source: 'validator',
      foundAt: new Date().toISOString(),
      foundDuring: body.foundDuring,
      repro: body.repro,
      evidence: body.evidence,
      suggestedFix: body.suggestedFix,
      codePointer: body.codePointer,
      linkedFeatureId: body.linkedFeatureId,
      status: 'open',
      attempts: 1,
      notes: [],
    };
    const { ensureHarnessPendingIssuesTable } = await import('@/lib/ensure-schema');
    await ensureHarnessPendingIssuesTable();
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const hpi = generated.harnessPendingIssuesInHarnessShared;
    const issueId = `PENDING-${Date.now()}`;
    const ts = Date.now();
    await db
      .insert(hpi)
      .values({
        harnessSlug: project.slug,
        phase: (project as any).phase ?? 'staging',
        issueId,
        featureId: body.linkedFeatureId ?? null,
        title: payload.title,
        severity: payload.severity,
        source: 'validator',
        payload: payload as any,
        ts,
        mtimeMs: ts,
        workspaceId: activeWorkspaceId(),
      })
      .onConflictDoNothing();
    void notifySyncInvalidate('harnessPendingIssues.byHarness', { harnessSlug: project.slug });
    return Response.json({ ok: true });
  },
});

const updateIssue = defineRoute({
  method: 'POST',
  path: '/harness/:slug/issues/:id/update',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = ctx.params.id as string;
    const body = await req.json().catch(() => ({} as any));
    const file = loadIssuesOrSeed(project);
    const issue = file.issues.find((i) => i.id === id);
    if (!issue) return Response.json({ error: 'issue not found' }, { status: 404 });

    if (typeof body.status === 'string') issue.status = body.status as IssueStatus;
    if (typeof body.severity === 'string') issue.severity = body.severity as IssueSeverity;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.linkedFeatureId === 'string' || body.linkedFeatureId === null) {
      issue.linkedFeatureId = body.linkedFeatureId ?? undefined;
    }
    if (typeof body.note === 'string' && body.note.trim()) {
      issue.notes.push({ ts: new Date().toISOString(), by: body.by ?? 'human', text: body.note });
    }
    await saveIssues(project, file);
    return Response.json(issue);
  },
});

/**
 * Manual triage: merge pending-issues → issues.json using the same
 * algorithm the curator runs, then clear the pending queue. Useful when
 * a human wants to surface fresh findings without waiting for the next
 * DONE/ESCALATE.
 */
const triage = defineRoute({
  method: 'POST',
  path: '/harness/:slug/triage',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    const pending = await readPendingIssues(project);
    if (pending.length === 0) return Response.json({ ok: true, merged: 0, deduped: 0 });

    const file = loadIssuesOrSeed(project);

    const tokenize = (s: string): Set<string> =>
      new Set(s.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2));
    const jaccard = (a: Set<string>, b: Set<string>): number => {
      if (a.size === 0 || b.size === 0) return 0;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      return inter / (a.size + b.size - inter);
    };

    let merged = 0;
    let deduped = 0;

    for (const p of pending) {
      const ptok = tokenize(p.title);
      const dup = file.issues.find((e) => {
        if (e.status === 'closed' || e.status === 'wontfix') return false;
        const samePtr = p.codePointer && e.codePointer && p.codePointer === e.codePointer;
        const nameMatch = jaccard(ptok, tokenize(e.title)) >= 0.85;
        return samePtr || nameMatch;
      });
      if (dup) {
        dup.attempts += 1;
        dup.notes.push({
          ts: new Date().toISOString(),
          by: 'validator',
          text: `Resurfaced during ${p.foundDuring ?? 'validation'}`,
        });
        const sevOrder = ['nit', 'minor', 'major', 'critical'];
        if (sevOrder.indexOf(p.severity) > sevOrder.indexOf(dup.severity)) {
          dup.severity = p.severity;
        }
        deduped++;
      } else {
        const id = `I-${String(file.nextId).padStart(4, '0')}`;
        file.nextId += 1;
        file.issues.unshift({ ...p, id });
        merged++;
      }
    }

    await saveIssues(project, file);
    // Clear the pending queue — DELETE from PG + truncate the on-disk
    // feed (the watcher would mirror the empty file → DELETE anyway,
    // idempotent with the explicit DELETE here).
    {
      const { ensureHarnessPendingIssuesTable } = await import('@/lib/ensure-schema');
      await ensureHarnessPendingIssuesTable();
      const { db } = (await import('@restart/db-org')).getOrgPg();
      const { generated } = await import('@restart/db-org');
      const { and, eq } = await import('drizzle-orm');
      const hpi = generated.harnessPendingIssuesInHarnessShared;
      await db
        .delete(hpi)
        .where(and(eq(hpi.harnessSlug, project.slug), eq(hpi.phase, (project as any).phase ?? 'staging')));
      void notifySyncInvalidate('harnessPendingIssues.byHarness', { harnessSlug: project.slug });
    }
    const pendingPath = join(harnessDir(project), 'pending-issues.jsonl');
    if (existsSync(pendingPath)) await writeFile(pendingPath, '', 'utf8');

    return Response.json({ ok: true, merged, deduped });
  },
});

// Silence unused-import warning — `getOrgPg` survives at the top so the
// dynamic imports inside append-pending / triage still type-check against
// the same @restart/db-org module surface.
void getOrgPg;

export default [issuesList, createIssue, appendPendingIssue, updateIssue, triage];
