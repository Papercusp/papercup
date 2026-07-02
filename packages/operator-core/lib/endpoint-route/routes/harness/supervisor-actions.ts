/**
 * Supervisor + escalation actions:
 *
 *   POST /api/harness/:slug/supervisor             — run the supervisor.sh script and parse SUPERVISOR: outcome
 *   POST /api/harness/:slug/escalation/resolve     — append human response to supervisor-notes.md; optionally clear escalation.md
 *
 * Both write back to PG text-artifacts AND the on-disk markdown copy so
 * the harness FS watcher sees the change.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 32).
 */
import { existsSync } from 'node:fs';
import { appendFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const supervisor = defineTool({
  method: 'POST',
  path: '/harness/:slug/supervisor',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const script = harnessPath('bin', 'supervisor.sh');
    if (!existsSync(script)) return Response.json({ error: 'supervisor.sh not found' }, { status: 500 });
    return new Promise<Response>((resolve) => {
      execFile('bash', [script], {
        cwd: project.path,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p' },
      }, (err, stdout, stderr) => {
        if (err) {
          resolve(Response.json({ ok: false, error: String(err.message || err), stderr: stderr?.toString() ?? '', stdout: stdout?.toString() ?? '' }, { status: 500 }));
          return;
        }
        const last = (stdout?.toString() ?? '').trim().split('\n').reverse().find((l) => l.startsWith('SUPERVISOR:')) ?? '';
        resolve(Response.json({ ok: true, outcome: last, stdout: stdout?.toString(), stderr: stderr?.toString() }));
      });
    });
  },
});

const resolveEscalation = defineTool({
  method: 'POST',
  path: '/harness/:slug/escalation/resolve',
  auth: 'loopback',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const slug = ctx.params.slug as string;
    const requestedPhase = url.searchParams.get('phase') ?? undefined;
    const project = await resolvePhasedProject(
      slug,
      phasePhaseLabel(requestedPhase),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { response?: unknown; action?: unknown };
    const response = typeof body.response === 'string' ? body.response.trim() : '';
    const action = body.action === 'clear' ? 'clear' : 'keep';
    const rowPhase = requestedPhase ?? 'staging';

    const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
    const { appendTextArtifact, loadTextArtifact, deleteTextArtifact } = await import('../../../text-artifacts');
    const block = response
      ? `\n## Human response ${new Date().toISOString()}\n\n${response}\n`
      : '';
    if (response) {
      await appendTextArtifact(slug, 'supervisor-notes.md', block);
      try { await appendFile(supervisorNotesPath, block, 'utf8'); } catch {}
    }

    if (action === 'clear') {
      await deleteTextArtifact(slug, 'escalation.md');
      try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
    }

    if (block || action === 'clear') {
      const { sql } = getOrgPg();
      await sql.unsafe(
        `UPDATE harness_shared.harness_escalations
            SET supervisor_notes = CASE
                  WHEN $4 <> '' THEN COALESCE(supervisor_notes, '') || $4
                  ELSE supervisor_notes
                END,
                escalation = CASE
                  WHEN $5 THEN NULL
                  ELSE escalation
                END,
                mtime_ms = $6
          WHERE workspace_id = $1
            AND harness_slug = $2
            AND phase = $3`,
        [activeWorkspaceId(), slug, rowPhase, block, action === 'clear', Date.now()],
      );
    }

    const pgNotes = await loadTextArtifact(slug, 'supervisor-notes.md');
    return Response.json({
      ok: true,
      supervisorNotes: pgNotes ?? safeRead(supervisorNotesPath),
      cleared: action === 'clear',
    });
  },
});

export default [supervisor, resolveEscalation];
