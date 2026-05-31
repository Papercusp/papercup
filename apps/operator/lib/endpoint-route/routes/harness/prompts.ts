/**
 * Per-harness prompt overrides — WORKSPACE-OWNED (PG), D-7 / decision (c).
 *
 *   GET    /api/harness/:slug/prompts            — role list + which have a workspace override
 *   GET    /api/harness/:slug/prompts/:role      — effective override + base + committed default
 *   PUT    /api/harness/:slug/prompts/:role      — set the workspace override (PG)
 *   DELETE /api/harness/:slug/prompts/:role      — clear the override = reset that role to default
 *   POST   /api/harness/:slug/prompts/reset-all  — clear all overrides = reset every role
 *
 * The live per-(workspace,harness,role) override lives in the PG store
 * (harness_prompt_overrides), scoped to the ACTIVE workspace. The committed
 * `.harness/prompts/<role>.md` (if a harness ships one) is the immutable DEFAULT
 * — the app never writes it, so the harness repo's git tree stays clean and a
 * "reset" simply clears the PG override (the orchestrator's PG→file fallback then
 * yields the committed default, or the base role prompt when none is committed).
 * Standalone/CLI harness runs keep using the committed file directly. See
 * orchestrator resolvePromptOverrideWithStore for the read side.
 */
import { join } from 'node:path';
import { resolvePhasedProject, harnessDir, safeRead } from '@/lib/harness-core';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { harnessPath } from '@/lib/harness-paths';
import { getKnownRoles } from '@/lib/known-roles';
import type { ProjectEntry } from '@/lib/harness-registry';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  listPromptOverrides,
  clearAllPromptOverrides,
} from '@/lib/harness-prompt-overrides';
import { defineTool } from '@papercusp/agent-mcp';

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

/** Committed repo default for a role (`.harness/prompts/<role>.md`), or null. */
const committedDefault = (p: ProjectEntry, role: string): string | null =>
  safeRead(join(harnessDir(p), 'prompts', `${role}.md`));

function safeRole(role: string): string | null {
  if (!getKnownRoles().includes(role)) return null;
  return role;
}

const getPrompts = defineTool({
  method: 'GET',
  path: '/harness/:slug/prompts',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    let overrides: string[] = [];
    try {
      overrides = (await listPromptOverrides(activeWorkspaceId(), project.slug))
        .map((o) => o.role)
        .filter((r) => getKnownRoles().includes(r))
        .sort();
    } catch { /* store unavailable → report none */ }
    return Response.json({ roles: getKnownRoles(), overrides });
  },
});

const getPromptByRole = defineTool({
  method: 'GET',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });

    let stored: string | null = null;
    try { stored = await getPromptOverride(activeWorkspaceId(), project.slug, role); } catch {}
    const def = committedDefault(project, role); // immutable repo default (or null)
    const globalPath = harnessPath('prompts', `${role}.md`);
    return Response.json({
      role,
      // effective value the editor shows: workspace override → committed default → ''
      content: stored ?? def ?? '',
      overrideExists: stored !== null, // a workspace override is set (→ show "reset")
      defaultContent: def ?? '', // what a reset restores (committed repo default)
      globalContent: safeRead(globalPath) ?? '', // base role prompt
    });
  },
});

const putPrompt = defineTool({
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

    // PG-only (decision c): the workspace owns the live override; the harness
    // folder is never modified, so the repo git tree stays clean.
    await setPromptOverride(activeWorkspaceId(), project.slug, role, body.content);
    return Response.json({ ok: true, role });
  },
});

const deletePrompt = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/prompts/:role',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const role = safeRole(ctx.params.role as string);
    if (!role) return Response.json({ error: 'unknown role' }, { status: 400 });
    // Clearing the workspace override IS "reset to default": the orchestrator's
    // PG→file fallback then yields the committed default (or the base prompt).
    const existed = await deletePromptOverride(activeWorkspaceId(), project.slug, role);
    return Response.json({ ok: true, reset: existed });
  },
});

const resetAllPrompts = defineTool({
  method: 'POST',
  path: '/harness/:slug/prompts/reset-all',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const cleared = await clearAllPromptOverrides(activeWorkspaceId(), project.slug);
    return Response.json({ ok: true, cleared });
  },
});

export default [getPrompts, getPromptByRole, putPrompt, deletePrompt, resetAllPrompts];
