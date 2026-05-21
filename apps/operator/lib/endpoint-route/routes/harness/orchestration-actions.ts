/**
 * Independent orchestration actions:
 *
 *   POST /api/harness/:slug/smoke-test/run     — exec service-smoke-test.sh; capture combined stdout+stderr
 *   POST /api/harness/:slug/architect/apply    — write a body to SPEC.md, validation-contract.md, or append to supervisor-notes.md (target switch)
 *
 * Two unrelated POSTs with no shared helpers — bundled into one batch
 * to keep the file count manageable.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 33).
 */
import { existsSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveProject, resolvePhasedProject, harnessDir } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { harnessPath } from '@/lib/harness-paths';
import { defineRoute } from '../../define-route';

const runSmokeTest = defineRoute({
  method: 'POST',
  path: '/harness/:slug/smoke-test/run',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const scriptPath = harnessPath('bin', 'service-smoke-test.sh');
    if (!existsSync(scriptPath)) return Response.json({ error: 'smoke-test script not found' }, { status: 500 });
    return new Promise<Response>((resolve) => {
      let stdout = '';
      const p = spawn('bash', [scriptPath], {
        env: { ...process.env, PROJECT_DIR: project.path, STATE_DIR: join(project.path, '.harness') },
      });
      p.stdout.on('data', (d) => { stdout += d.toString(); });
      p.stderr.on('data', (d) => { stdout += d.toString(); });
      p.on('close', (code) => {
        resolve(Response.json({ ok: code === 0, rc: code, output: stdout }));
      });
    });
  },
});

const architectApply = defineRoute({
  method: 'POST',
  path: '/harness/:slug/architect/apply',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const slug = ctx.params.slug as string;
    const project = await resolvePhasedProject(
      slug,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as { target: string; content: string };
    if (!body.content) return Response.json({ error: 'content required' }, { status: 400 });

    let path: string;
    switch (body.target) {
      case 'SPEC.md': path = join(project.path, 'SPEC.md'); break;
      case 'contract': path = join(harnessDir(project), 'validation-contract.md'); break;
      case 'supervisor-notes': {
        const notesPath = join(harnessDir(project), 'supervisor-notes.md');
        const block = `\n## architect ${new Date().toISOString()}\n\n${body.content}\n`;
        const { appendTextArtifact } = await import('@/lib/text-artifacts');
        await appendTextArtifact(slug, 'supervisor-notes.md', block);
        try { await appendFile(notesPath, block, 'utf8'); } catch {}
        return Response.json({ ok: true, appended: 'supervisor-notes.md' });
      }
      default: return Response.json({ error: 'unknown target' }, { status: 400 });
    }

    const tmp = `${path}.tmp.${Date.now()}`;
    await writeFile(tmp, body.content, 'utf8');
    await rename(tmp, path);
    return Response.json({ ok: true, written: path });
  },
});

export default [runSmokeTest, architectApply];
