/**
 * POST /api/harness/:slug/bootstrap-from-template
 *
 * Copy a template's source files into a fresh harness — SPEC.md, AGENTS.md
 * (from `PROJECT_FILES_TO_COPY`), and `.harness/config.json`. Skips files
 * that already exist unless `overwrite: true`.
 *
 * Templates live at `<HARNESS_PATH>/templates/projects/<id>/`.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 42).
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { harnessPath } from '@/lib/harness-paths';
import { PROJECT_FILES_TO_COPY } from '@/lib/harness-state-files';
import { defineRoute } from '../../define-route';

const TEMPLATES_DIR = harnessPath('templates', 'projects');

export default defineRoute({
  method: 'POST',
  path: '/harness/:slug/bootstrap-from-template',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { templateId?: string; overwrite?: boolean };
    const tid = (body.templateId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!tid) return Response.json({ error: 'templateId required' }, { status: 400 });
    const tdir = join(TEMPLATES_DIR, tid);
    if (!existsSync(tdir)) return Response.json({ error: `template not found: ${tid}` }, { status: 404 });

    const overwrite = body.overwrite === true;
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const f of PROJECT_FILES_TO_COPY) {
      const src = join(tdir, f);
      if (!existsSync(src)) continue;
      const dest = join(project.path, f);
      if (existsSync(dest) && !overwrite) { skipped.push(f); continue; }
      const tmp = `${dest}.tmp.${Date.now()}`;
      await copyFile(src, tmp);
      await rename(tmp, dest);
      copied.push(f);
    }
    const configSrc = join(tdir, 'config.json');
    if (existsSync(configSrc)) {
      await mkdir(harnessDir(project), { recursive: true });
      const dest = join(harnessDir(project), 'config.json');
      if (existsSync(dest) && !overwrite) {
        skipped.push('.harness/config.json');
      } else {
        const tmp = `${dest}.tmp.${Date.now()}`;
        await copyFile(configSrc, tmp);
        await rename(tmp, dest);
        copied.push('.harness/config.json');
      }
    }

    return Response.json({ ok: true, copied, skipped });
  },
});
