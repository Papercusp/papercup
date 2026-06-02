/**
 * GET/PUT/DELETE /api/agent-mcp/saved-prompts — cross-client saved-prompts
 * CRUD for the harness-settings + personalization UI (plan
 * saved-prompts-cross-client).
 *
 * Route-shaped `defineTool` with `auth: 'public'` (loopback-trusted), the
 * same shape every other settings surface uses (operator-config,
 * operator-credentials, omp-config) — the dashboard has no bearer/principal
 * path, so this is the idiomatic settings endpoint (D-007; supersedes the
 * principal-gated D-005). Each write re-materializes the affected scope's
 * on-disk command files so ambient Claude/OMP sessions pick them up.
 *
 * Scope: no `?harness=` ⇒ workspace-global; `?harness=<slug>` ⇒ that harness.
 * Workspace is the request's active workspace.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import {
  listSavedPrompts,
  upsertSavedPrompt,
  removeSavedPrompt,
  type PromptScope,
} from '@/lib/saved-prompts-store';
import {
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '@/lib/saved-prompts-materialize';
import { validatePromptName } from '@/lib/saved-prompts-projection';

function scopeFromHarness(harness: string | null): PromptScope {
  return harness ? { kind: 'harness', slug: harness } : { kind: 'workspace' };
}

/** Re-project the affected scope to disk so a save/delete is reflected immediately. */
async function rematerialize(workspaceId: string, scope: PromptScope): Promise<void> {
  if (scope.kind === 'harness') await materializeHarnessPrompts(workspaceId, scope.slug);
  else await materializeWorkspacePrompts(workspaceId);
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/saved-prompts',
  auth: 'public',
  async handler(req) {
    const harness = new URL(req.url).searchParams.get('harness');
    const ws = activeWorkspaceId();
    const prompts = await listSavedPrompts(getOrgPg().sql, ws, scopeFromHarness(harness));
    return Response.json({ prompts });
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/saved-prompts',
  auth: 'public',
  async handler(req) {
    const body = (await req.json()) as {
      harness?: string | null;
      name?: string;
      body?: string;
      description?: string | null;
      argHint?: string | null;
    };
    const name = (body.name ?? '').trim();
    if (!validatePromptName(name)) {
      return Response.json(
        { error: 'invalid_name', detail: 'name must match ^[a-z0-9][a-z0-9-]*$' },
        { status: 400 },
      );
    }
    if (typeof body.body !== 'string' || body.body.trim().length === 0) {
      return Response.json({ error: 'missing_body' }, { status: 400 });
    }
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const prompt = await upsertSavedPrompt(getOrgPg().sql, {
      workspaceId: ws,
      scope,
      name,
      body: body.body,
      description: body.description ?? null,
      argHint: body.argHint ?? null,
    });
    await rematerialize(ws, scope);
    return Response.json({ prompt });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/saved-prompts',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness');
    const name = (url.searchParams.get('name') ?? '').trim();
    if (!name) return Response.json({ error: 'missing_name' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(harness?.trim() || null);
    const removed = await removeSavedPrompt(getOrgPg().sql, ws, scope, name);
    await rematerialize(ws, scope);
    return Response.json({ removed });
  },
});

export default [get, put, del];
