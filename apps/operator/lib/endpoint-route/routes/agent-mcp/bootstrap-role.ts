/**
 * POST / OPTIONS /api/agent-mcp/console/bootstrap-role
 *
 * Bootstraps a tracked, role-scoped INTERACTIVE session (psu --role).
 * The agent wears a pipeline role's persona + tools + feature context —
 * the same setup the orchestrator gives that role — but a human drives
 * it. Sibling to bootstrap-su (which is the plain SU/engineer path).
 *
 * Per agent-launch-unification Phase 3 (P-021). Composes the shared
 * keystone `buildRoleLaunchSpec` (role prompt via assembleRolePrompt + a
 * signed ROLE-SCOPED MCP URL → dispatch enforces the role's tool
 * allowlist, D-001), then:
 *   - writes the signed `.mcp.json` into the session cwd (backing up any
 *     existing one, like console-launch),
 *   - writes the role prompt to a launch-context file the launcher feeds
 *     the CLI as its system prompt,
 *   - records an `adv_sessions` row tagged role + feature + agent,
 *   - returns what psu needs to exec the chosen backend interactively.
 *
 * Feature gating: a role whose `consumes.feature === 'required'`
 * (roleConsumes) must be given a feature, else 400.
 *
 * Principal-gated; CORS-open (operator binds loopback-only).
 */
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, workspaceById } from '@/lib/workspace-registry';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { recordAdvSession } from '@/lib/adv-sessions';
import { isSuAgent, type SuAgent } from '@/lib/su-agents';
import { roleConsumes } from '@/lib/role-registry';
import { buildRoleLaunchSpec } from '@/lib/role-launch-spec';
import { launchContextDir, launchContextPathFor } from '@/lib/su-launch-context';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization',
};

function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

async function gatePrincipal(headers: Headers): Promise<Response | null> {
  try {
    await requirePrincipal(headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return jsonRes({ status: 'error', error: err.reason }, err.status);
    }
    throw err;
  }
}

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

export interface BootstrapRoleResult {
  status: 'ok';
  sessionId: number | null;
  role: string;
  agent: SuAgent;
  workspaceId: string;
  harnessSlug: string;
  feature: string | null;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  /** File holding the role prompt — the launcher feeds it as the system prompt. */
  promptFile: string;
  /** The signed role-scoped `.mcp.json` written into cwd. */
  mcpJsonPath: string;
  /** Non-secret env the launcher exports into the child. */
  envelopeEnv: Record<string, string>;
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-role',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-role',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let body: {
      role?: string;
      agent?: string;
      workspace?: string | null;
      harness_slug?: string | null;
      feature?: string | null;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonRes({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    const role = body.role?.trim() || '';
    if (!ROLE_RE.test(role)) {
      return jsonRes({ status: 'error', error: `invalid role: ${role.slice(0, 32)}` }, 400);
    }
    // Codex interactive role sessions need a per-session CODEX_HOME (no
    // --append-system-prompt / --mcp-config flags); deferred until the
    // codex spawn machinery from Phase 2 is reusable. claude/omp now.
    if (!isSuAgent(body.agent)) {
      return jsonRes({ status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` }, 400);
    }
    const agent: SuAgent = body.agent;
    if (agent === 'codex') {
      return jsonRes({ status: 'error', code: 'codex_role_unsupported', error: 'codex interactive role sessions are not supported yet — use claude or omp (codex pipeline support is Phase 2).' }, 400);
    }

    const workspace = body.workspace?.trim() || activeWorkspaceId();
    if (body.workspace?.trim() && !workspaceById(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    const harnessSlug = body.harness_slug?.trim() || '';
    if (!harnessSlug) {
      return jsonRes({ status: 'error', error: 'role sessions are harness-scoped — harness_slug is required' }, 400);
    }
    const feature = body.feature?.trim() || null;

    // Feature gating from the single source (roleConsumes / consumes).
    const consumes = roleConsumes(role, harnessSlug);
    if (consumes.feature === 'required' && !feature) {
      return jsonRes({ status: 'error', code: 'feature_required', error: `role '${role}' requires a feature (consumes.feature=required)` }, 400);
    }

    // Build the shared spec: role prompt + signed role-scoped MCP URL + cwd.
    let spec;
    try {
      spec = await buildRoleLaunchSpec({
        role,
        workspaceId: workspace,
        harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
        featureId: feature,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'role launch spec build failed' }, 400);
    }

    // Record the tracked session first so the prompt/mcp files key off its id.
    const sessionId = await recordAdvSession({
      workspaceId: workspace,
      role,
      feature,
      agent,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd: spec.cwd,
      label: feature ? `${role} · ${feature}` : role,
    });

    // Write the signed role-scoped .mcp.json into cwd (back up any existing
    // one, mirroring console-launch). omp path-discovers it; claude is
    // pointed at it via --mcp-config by the launcher.
    let mcpJsonPath = '';
    try {
      mcpJsonPath = join(spec.cwd, '.mcp.json');
      if (existsSync(mcpJsonPath)) {
        const bak = `${mcpJsonPath}.papercusp.bak`;
        if (!existsSync(bak)) renameSync(mcpJsonPath, bak);
      }
      writeFileSync(mcpJsonPath, spec.mcpJsonContents, { mode: 0o600 });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `write .mcp.json: ${e?.message}` }, 500);
    }

    // Write the role prompt to a launch-context file the launcher injects
    // as the system prompt (NOT the engineer playbook the *-su wrappers use).
    const promptFile = launchContextPathFor(sessionId ?? `role-${Date.now()}`);
    try {
      mkdirSync(launchContextDir(), { recursive: true });
      writeFileSync(promptFile, spec.promptText, { mode: 0o600 });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `write role prompt: ${e?.message}` }, 500);
    }

    const result: BootstrapRoleResult = {
      status: 'ok',
      sessionId,
      role,
      agent,
      workspaceId: workspace,
      harnessSlug,
      feature,
      cwd: spec.cwd,
      promptFile,
      mcpJsonPath,
      envelopeEnv: {
        PAPERCUSP_AGENT: agent,
        PAPERCUSP_ROLE: role,
        ...(feature ? { PAPERCUSP_FEATURE_ID: feature } : {}),
        ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
      },
    };
    return jsonRes(result);
  },
});

export default [options, post];
