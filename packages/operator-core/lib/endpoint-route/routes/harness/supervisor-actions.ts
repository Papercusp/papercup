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
import { resolvePhasedProject, harnessDir, safeRead } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { harnessPath } from '../../../harness-paths';
import { defineTool } from '@papercusp/agent-mcp';

const supervisor = defineTool({
  method: 'POST',
  path: '/harness/:slug/supervisor',
  auth: 'public',
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
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(
      slug,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { response?: unknown; action?: unknown };
    const response = typeof body.response === 'string' ? body.response.trim() : '';
    const action = body.action === 'clear' ? 'clear' : 'keep';

    const supervisorNotesPath = join(harnessDir(project), 'supervisor-notes.md');
    const { appendTextArtifact, loadTextArtifact, deleteTextArtifact } = await import('../../../text-artifacts');
    if (response) {
      const block = `\n## Human response ${new Date().toISOString()}\n\n${response}\n`;
      await appendTextArtifact(slug, 'supervisor-notes.md', block);
      try { await appendFile(supervisorNotesPath, block, 'utf8'); } catch {}
    }

    if (action === 'clear') {
      await deleteTextArtifact(slug, 'escalation.md');
      try { await unlink(join(harnessDir(project), 'escalation.md')); } catch {}
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
