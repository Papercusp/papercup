/**
 * Product-proposal action routes (the file-mode pair):
 *
 *   POST /api/harness/:slug/proposals/:id/accept   — append acceptance bullets to SPEC.md + stamp proposal + optional replan
 *   POST /api/harness/:slug/proposals/:id/reject   — stamp proposal as rejected
 *
 * File is source-of-truth: the harness FS watcher mirrors stamps into
 * `harness_proposals_shared` automatically; no explicit PG write here.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 29). Helper `invokeScoperBackground` lives in
 * `lib/harness-scoper.ts` (carve-out from this batch).
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveProject, harnessDir, safeRead } from '@/lib/harness-core';
import { invokeScoperBackground } from '@/lib/harness-scoper';
import { firePluginLifecycle, firePluginEvent } from '@/lib/plugin-host-runtime';
import { defineRoute } from '../../define-route';

const acceptProposal = defineRoute({
  method: 'POST',
  path: '/harness/:slug/proposals/:id/accept',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!id || !id.endsWith('.md')) return Response.json({ error: 'invalid id' }, { status: 400 });
    const proposalPath = join(harnessDir(project), 'proposals', id);
    if (!existsSync(proposalPath)) return Response.json({ error: 'not found' }, { status: 404 });

    const body = safeRead(proposalPath) ?? '';
    // Extract acceptance bullets — same heuristic as run.sh's product_auto_apply_latest.
    const bullets: string[] = [];
    const lines = body.split('\n');
    let inBar = false;
    for (const ln of lines) {
      if (/(\*\*Acceptance bar\*\*|Acceptance bar.*\*\*)/.test(ln)) { inBar = true; continue; }
      if (inBar) {
        if (ln.startsWith('- ') || ln.startsWith('  - ')) bullets.push(ln.replace(/^\s*-\s*/, '- '));
        else if (ln.startsWith('**') || ln.startsWith('#')) inBar = false;
      }
    }
    const specPath = join(project.path, 'SPEC.md');
    if (!existsSync(specPath)) return Response.json({ error: 'SPEC.md not found' }, { status: 404 });
    if (bullets.length === 0) return Response.json({ ok: false, error: 'no acceptance bullets found in proposal' }, { status: 400 });

    const append = `\n<!-- accepted from proposals/${id} at ${new Date().toISOString()} -->\n${bullets.join('\n')}\n`;
    await appendFile(specPath, append, 'utf8');
    await appendFile(proposalPath, `\n---\napplied: true\nappliedAt: ${new Date().toISOString()}\n`, 'utf8');

    // Phase 6b plugin lifecycle — typed + free-form. Best-effort.
    void firePluginLifecycle('onProposalAccepted', {
      installSlug: project.slug,
      projectDir: project.path,
      stateDir: harnessDir(project),
    }, `proposals/${id}`);
    void firePluginEvent('proposal.accepted', { proposalId: id, installSlug: project.slug });

    // Optional auto-replan: config.reviewer.replanOnAccept defaults true.
    // Set false to opt out. The unified scoper MODE=replan path is
    // non-destructive (no MAX_ITERATIONS=0 expert-respawn footgun).
    let replanFired = false;
    try {
      const cfg = JSON.parse(readFileSync(join(harnessDir(project), 'config.json'), 'utf8'));
      const wantReplan = cfg?.reviewer?.replanOnAccept !== false;
      if (wantReplan) {
        invokeScoperBackground(project, 'replan');
        replanFired = true;
      }
    } catch {}

    return Response.json({ ok: true, bulletsAdded: bullets.length, replanFired });
  },
});

const rejectProposal = defineRoute({
  method: 'POST',
  path: '/harness/:slug/proposals/:id/reject',
  auth: 'public',
  async handler(_req, ctx) {
    const project = await resolveProject(ctx.params.slug as string);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');
    if (!id || !id.endsWith('.md')) return Response.json({ error: 'invalid id' }, { status: 400 });
    const proposalPath = join(harnessDir(project), 'proposals', id);
    if (!existsSync(proposalPath)) return Response.json({ error: 'not found' }, { status: 404 });
    await appendFile(proposalPath, `\n---\nrejected: true\nrejectedAt: ${new Date().toISOString()}\n`, 'utf8');
    return Response.json({ ok: true });
  },
});

export default [acceptProposal, rejectProposal];
