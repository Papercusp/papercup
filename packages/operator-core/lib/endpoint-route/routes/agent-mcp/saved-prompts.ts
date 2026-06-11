/**
 * Cross-client saved-prompts CRUD for the harness-settings + personalization
 * UI (plan saved-prompts-cross-client):
 *
 *   GET  /api/agent-mcp/saved-prompts          — list one scope
 *   POST /api/agent-mcp/saved-prompts          — upsert
 *   POST /api/agent-mcp/saved-prompts/remove   — delete by name
 *
 * Route-shaped `defineTool` with `auth: 'public'` (loopback-trusted), the
 * same shape every other settings surface uses (operator-config,
 * operator-credentials, omp-config) — the dashboard has no bearer/principal
 * path, so this is the idiomatic settings endpoint (D-007; supersedes the
 * principal-gated D-005). Each write re-materializes the affected scope's
 * on-disk command files so ambient Claude/OMP sessions pick them up.
 *
 * Why writes are POST, not PUT/DELETE (D-010): the desktop WebView
 * (WebKitGTK) silently fails CORS preflight handshakes, and the client
 * routes these calls through the sibling loopback host (crossOriginUrl) to
 * escape SSE socket-pool starvation — which makes them cross-origin. Only
 * GET/HEAD/POST + a safelisted content-type (text/plain) are CORS-"simple"
 * (no preflight); PUT/DELETE always preflight. So both writes are POST and
 * the client sends `text/plain` bodies. The global `/api/*` host CORS
 * (bin/host-cors.ts) reflects the loopback origin on the response, so no
 * per-route `cors` field is needed (mirrors the git/show read).
 * `req.json()` parses the body regardless of its content-type header.
 *
 * Scope: no `?harness=`/`harness` ⇒ workspace-global; a slug ⇒ that harness.
 * Workspace is the request's active workspace.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  listSavedPrompts,
  upsertSavedPrompt,
  removeSavedPrompt,
  type PromptScope,
} from '../../../saved-prompts-store';
import {
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { validatePromptName } from '../../../saved-prompts-projection';

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

const upsert = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts',
  auth: 'loopback',
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

const remove = defineTool({
  method: 'POST',
  path: '/agent-mcp/saved-prompts/remove',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => ({}))) as {
      harness?: string | null;
      name?: string;
    };
    const name = (body.name ?? '').trim();
    if (!name) return Response.json({ error: 'missing_name' }, { status: 400 });
    const ws = activeWorkspaceId();
    const scope = scopeFromHarness(body.harness?.trim() || null);
    const removed = await removeSavedPrompt(getOrgPg().sql, ws, scope, name);
    await rematerialize(ws, scope);
    return Response.json({ removed });
  },
});

export default [get, upsert, remove];
