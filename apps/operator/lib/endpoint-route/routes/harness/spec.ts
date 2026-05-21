/**
 * GET/PUT /api/harness/:slug/spec — read/write the per-harness project
 * files (SPEC.md, AGENTS.md, validation-contract.md, config.json).
 *
 * PG canonical (Migration 034), with disk mirrors for editor convenience.
 * Optimistic concurrency: PUT accepts `expected_version` and returns 409
 * with the current version on mismatch so the caller can rebase.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 2).
 */
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import {
  loadProjectFiles,
  saveProjectFiles,
  ProjectFilesVersionConflict,
} from '@/lib/harness-project-files';
import { defineRoute } from '../../define-route';

const getSpec = defineRoute({
  method: 'GET',
  path: '/harness/:slug/spec',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const pg = await loadProjectFiles(slug);
    return Response.json({
      spec: pg.spec ?? safeRead(join(project.path, 'SPEC.md')),
      agents: pg.agents ?? safeRead(join(project.path, 'AGENTS.md')),
      contract: pg.contract ?? safeRead(join(harnessDir(project), 'validation-contract.md')),
      config: pg.config ?? safeRead(join(harnessDir(project), 'config.json')),
      version: pg.version,
    });
  },
});

const putSpec = defineRoute({
  method: 'PUT',
  path: '/harness/:slug/spec',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const body = (await req.json()) as {
      spec?: string; agents?: string; contract?: string; config?: string;
      expected_version?: number;
    };

    let saved: { version: number };
    try {
      saved = await saveProjectFiles(slug, body, { expectedVersion: body.expected_version });
    } catch (err) {
      if (err instanceof ProjectFilesVersionConflict) {
        return Response.json({
          ok: false,
          error: 'version_conflict',
          expected: body.expected_version,
          current: err.currentVersion,
          detail: err.message,
        }, { status: 409 });
      }
      throw err;
    }

    const targets: Array<{ path: string; content: string | undefined; label: string }> = [
      { path: join(project.path, 'SPEC.md'), content: body.spec, label: 'spec' },
      { path: join(project.path, 'AGENTS.md'), content: body.agents, label: 'agents' },
      { path: join(harnessDir(project), 'validation-contract.md'), content: body.contract, label: 'contract' },
      { path: join(harnessDir(project), 'config.json'), content: body.config, label: 'config' },
    ];

    const written: string[] = [];
    for (const t of targets) {
      if (typeof t.content !== 'string') continue;
      const tmp = `${t.path}.tmp.${Date.now()}`;
      try {
        await writeFile(tmp, t.content, 'utf8');
        await rename(tmp, t.path);
        written.push(t.label);
      } catch { /* mirror is best-effort; PG already has it */ }
    }
    return Response.json({ ok: true, written, version: saved.version });
  },
});

export default [getSpec, putSpec];
