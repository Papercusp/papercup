/**
 * Orchestrator status reporting + human-gated checkpoints:
 *
 *   POST   /api/harness/:slug/orchestrator/status         — heartbeat status row
 *   POST   /api/harness/:slug/checkpoint/:name/request    — create a pending checkpoint
 *   POST   /api/harness/:slug/checkpoint/:name/grant      — grant a checkpoint
 *
 * The run.sh-era loopback lane WRITERS (POST /orchestrator/lane, DELETE
 * /orchestrator/lanes, POST /orchestrator/clear-running) were removed —
 * legacy-harness-cleanup Workstream E (dead: sourced only by the retired pg-status.sh;
 * the TS orchestrator writes/sweeps harness_lanes + agent_runs directly, D-006).
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 19).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolveProject, harnessDir } from '../../../harness-core';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const orchestratorStatus = defineTool({
  method: 'POST',
  path: '/harness/:slug/orchestrator/status',
  auth: 'loopback',
  async handler(req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    let body: {
      phase?: string; status?: string; iteration?: number; totalFeatures?: number;
      passedCount?: number; todoCount?: number; blockedCount?: number;
      lastActiveTs?: number; costUsd?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    const phase = body.phase === 'testing' || body.phase === 'production' ? body.phase : 'staging';
    const allowed = new Set(['idle', 'running', 'stalled', 'paused', 'error']);
    if (!body.status || !allowed.has(body.status)) {
      return Response.json({ error: 'status must be one of idle/running/stalled/paused/error' }, { status: 400 });
    }
    const { db } = getOrgPg();
    const { generated } = await import('@papercusp/db-org');
    const { sql: dsql } = await import('drizzle-orm');
    const hs = generated.harnessStatusInHarnessShared;
    const ws = activeWorkspaceId();
    const STATUS_LEASE_MS = 5 * 60_000;
    const now = Date.now();
    await db
      .insert(hs)
      .values({
        harnessSlug: project.slug,
        phase,
        status: body.status,
        iteration: Number(body.iteration) || 0,
        totalFeatures: Number(body.totalFeatures) || 0,
        passedCount: Number(body.passedCount) || 0,
        todoCount: Number(body.todoCount) || 0,
        blockedCount: Number(body.blockedCount) || 0,
        lastActiveTs: body.lastActiveTs ?? null,
        costUsd: body.costUsd != null ? String(body.costUsd) : null,
        workspaceId: ws,
        updatedAt: now,
        expiresAt: now + STATUS_LEASE_MS,
      })
      .onConflictDoUpdate({
        target: [hs.harnessSlug, hs.phase],
        set: {
          status: dsql`EXCLUDED.status`,
          iteration: dsql`EXCLUDED.iteration`,
          totalFeatures: dsql`EXCLUDED.total_features`,
          passedCount: dsql`EXCLUDED.passed_count`,
          todoCount: dsql`EXCLUDED.todo_count`,
          blockedCount: dsql`EXCLUDED.blocked_count`,
          lastActiveTs: dsql`EXCLUDED.last_active_ts`,
          costUsd: dsql`EXCLUDED.cost_usd`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
          updatedAt: dsql`EXCLUDED.updated_at`,
          expiresAt: dsql`EXCLUDED.expires_at`,
        },
      });
    const { notifySyncInvalidate } = await import('../../../sync-sse');
    await notifySyncInvalidate('harnessStatus.byHarness', { harnessSlug: project.slug });
    return Response.json({ ok: true });
  },
});

// legacy-harness-cleanup-2026-06-15 Workstream E: the run.sh-era loopback WRITE
// endpoints (POST /orchestrator/lane, DELETE /orchestrator/lanes, POST
// /orchestrator/clear-running) were REMOVED — they were sourced only by the retired
// run.sh helper `pg-status.sh` (itself deleted). The TS orchestrator now writes +
// sweeps `harness_lanes` and the agent_runs running-flag directly (D-006), so these
// HTTP writers were dead (verified: no live caller, no test). The GET
// `/orchestrator/status` reader stays (the UI consumes it).

const checkpointRequest = defineTool({
  method: 'POST',
  path: '/harness/:slug/checkpoint/:name/request',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const project = await resolveProject(slug);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = String(ctx.params.name).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!name) return Response.json({ error: 'invalid name' }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { message?: string };
    const cpPath = join(harnessDir(project), `checkpoint-${name}.md`);
    if (existsSync(cpPath)) {
      return Response.json({ error: 'checkpoint already pending', path: cpPath }, { status: 409 });
    }
    writeFileSync(cpPath, `# Checkpoint: ${name} (manual request)

Requested at: ${new Date().toISOString()}
By: human operator via UI

${body.message ?? ''}

## How to grant
- UI: click "Grant" in the CheckpointBanner, or POST /api/harness/${slug}/checkpoint/${name}/grant
- CLI: touch ${cpPath}.granted; then re-run the harness
`);
    return Response.json({ ok: true, requested: name });
  },
});

const checkpointGrant = defineTool({
  method: 'POST',
  path: '/harness/:slug/checkpoint/:name/grant',
  auth: 'loopback',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const name = String(ctx.params.name).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!name) return Response.json({ error: 'invalid name' }, { status: 400 });
    const cpPath = join(harnessDir(project), `checkpoint-${name}.md`);

    // Phase 3 PG path: flip granted=true + emit sync_invalidate so the UI
    // refetches. bash run.sh reads .granted files at pre-loop, so the file
    // write below stays for back-compat.
    let pgGranted = false;
    try {
      const { db } = (await import('@papercusp/db-org')).getOrgPg();
      const { generated } = await import('@papercusp/db-org');
      const { and, eq } = await import('drizzle-orm');
      const hc = generated.harnessCheckpointsInHarnessShared;
      const ws = activeWorkspaceId();
      const rows = await db
        .update(hc)
        .set({ granted: true })
        .where(and(
          eq(hc.harnessSlug, project.slug),
          eq(hc.workspaceId, ws),
          eq(hc.name, name),
          eq(hc.granted, false),
          eq(hc.consumed, false),
        ))
        .returning({ id: hc.harnessSlug });
      if (rows.length > 0) {
        pgGranted = true;
        const { sql } = (await import('@papercusp/db-org')).getOrgPg();
        await sql`
          SELECT pg_notify('sync_invalidate',
            ${JSON.stringify({
              name: 'harnessCheckpoints.byHarness',
              args: { harnessSlug: project.slug },
            })})
        `;
      }
    } catch {
      /* fall through; file write below still works */
    }

    // File path is the source of truth for bash run.sh. Orchestrator-TS
    // mode reads PG directly. Skip the file when the .md isn't on disk
    // (orchestrator-TS only creates PG rows).
    if (existsSync(cpPath)) {
      writeFileSync(`${cpPath}.granted`, `granted at ${new Date().toISOString()}\n`);
    } else if (!pgGranted) {
      return Response.json({ error: 'no such checkpoint' }, { status: 404 });
    }

    return Response.json({
      ok: true,
      granted: name,
      via: pgGranted ? 'pg' : 'file',
      next: pgGranted
        ? 'Orchestrator will pick up the grant on next pre-loop pass.'
        : 'Re-run the harness to consume the grant.',
    });
  },
});

export default [
  orchestratorStatus,
  checkpointRequest, checkpointGrant,
];
