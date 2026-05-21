/**
 * Per-harness prompt overrides (`.harness/prompts/<role>.md`):
 *
 *   GET    /api/harness/:slug/prompts         — role list + which have overrides
 *   GET    /api/harness/:slug/prompts/:role   — override + global prompt content
 *   PUT    /api/harness/:slug/prompts/:role   — write override + register in config.json
 *   DELETE /api/harness/:slug/prompts/:role   — remove override + un-register
 *
 * The override is registered in `.harness/config.json` under
 * `promptOverrides[role]` so run.sh's invoke() picks it up.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 17).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { harnessPath } from '@/lib/harness-paths';
import { getKnownRoles } from '@/lib/known-roles';
import type { ProjectEntry } from '@/lib/harness-registry';
import { defineRoute } from '../../define-route';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

const promptsDir = (p: ProjectEntry) => join(harnessDir(p), 'prompts');

function safeRole(role: string): string | null {
  if (!getKnownRoles().includes(role)) return null;
  return role;
}

const getPrompts = defineRoute({
  method: 'GET',
  path: '/harness/:slug/prompts',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const dir = promptsDir(project);
    let overrides: string[] = [];
    try {
      if (existsSync(dir)) {
        overrides = readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace(/\.md$/, ''))
          .filter((r) => getKnownRoles().includes(r))
          .sort();
      }
    } catch {}
    return Response.json({ roles: getKnownRoles(), overrides });
  },
});

const getPromptByRole = defineRoute({
  method: 'GET',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    const overridePath = join(promptsDir(project), `${role}.md`);
    const globalPath = harnessPath('prompts', `${role}.md`);
    return Response.json({
      role,
      content: safeRead(overridePath) ?? '',
      overrideExists: existsSync(overridePath),
      globalContent: safeRead(globalPath) ?? '',
    });
  },
});

const putPrompt = defineRoute({
  method: 'PUT',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    const body = await req.json().catch(() => ({} as any));
    if (typeof body.content !== 'string') return Response.json({ error: 'content required' }, { status: 400 });

    const dir = promptsDir(project);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const overridePath = join(dir, `${role}.md`);
    await writeFile(overridePath, body.content, 'utf8');

    // Register the override in .harness/config.json so run.sh's invoke()
    // picks it up via promptOverrides[role] = "prompts/<role>.md".
    const configPath = join(harnessDir(project), 'config.json');
    let cfg: any = {};
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    if (!cfg.promptOverrides) cfg.promptOverrides = {};
    cfg.promptOverrides[role] = `prompts/${role}.md`;
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    return Response.json({ ok: true, role });
  },
});

const deletePrompt = defineRoute({
  method: 'DELETE',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    try { await unlink(join(promptsDir(project), `${role}.md`)); } catch {}

    // Un-register from config.json.
    const configPath = join(harnessDir(project), 'config.json');
    let cfg: any = {};
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    if (cfg.promptOverrides && cfg.promptOverrides[role]) {
      delete cfg.promptOverrides[role];
      if (Object.keys(cfg.promptOverrides).length === 0) delete cfg.promptOverrides;
      await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    }
    return Response.json({ ok: true });
  },
});

export default [getPrompts, getPromptByRole, putPrompt, deletePrompt];
