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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, workspaceById } from '../../../workspace-registry';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { recordAdvSession } from '../../../adv-sessions';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { roleConsumes } from '../../../role-registry';
import { buildRoleLaunchSpec } from '../../../role-launch-spec';
import { getPlanContextBySlug } from '../../../plan-context-for-feature';
import { writeRoleCodexHome } from '../../../role-codex-home';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';

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
  /** Plan whose context was injected (plan-consuming roles), else null. */
  planSlug: string | null;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  /**
   * File holding the role prompt — the launcher feeds it as the system
   * prompt. claude/omp: a launch-context `.md`. codex: the CODEX_HOME
   * `AGENTS.md` (codex has no per-launch system-prompt flag).
   */
  promptFile: string;
  /**
   * The signed role-scoped MCP config the agent discovers. claude/omp: a
   * `.mcp.json` written into cwd. codex: the CODEX_HOME `config.toml`.
   */
  mcpJsonPath: string;
  /**
   * Per-session CODEX_HOME for a codex role session (AGENTS.md +
   * config.toml + auth symlink). null for claude/omp. Also surfaced in
   * `envelopeEnv.CODEX_HOME` for the launcher.
   */
  codexHome: string | null;
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
      plan?: string | null;
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
    if (!isSuAgent(body.agent)) {
      return jsonRes({ status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` }, 400);
    }
    const agent: SuAgent = body.agent;

    const workspace = body.workspace?.trim() || activeWorkspaceId();
    if (body.workspace?.trim() && !workspaceById(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    const harnessSlug = body.harness_slug?.trim() || '';
    if (!harnessSlug) {
      return jsonRes({ status: 'error', error: 'role sessions are harness-scoped — harness_slug is required' }, 400);
    }
    const feature = body.feature?.trim() || null;
    const plan = body.plan?.trim() || null;

    // Feature + plan gating from the single source (roleConsumes / consumes).
    const consumes = roleConsumes(role, harnessSlug);
    if (consumes.feature === 'required' && !feature) {
      return jsonRes({ status: 'error', code: 'feature_required', error: `role '${role}' requires a feature (consumes.feature=required)` }, 400);
    }

    // Plan context for plan-consuming roles (scoper/reviewer: consumes.plan
    // !== 'none'). Honors the `consumes` single source the same way feature
    // does: only fetch+inject when the role actually consumes a plan AND one
    // was chosen. Best-effort — an unreadable plan just yields no section.
    let planContext: string | undefined;
    if (plan && consumes.plan !== 'none') {
      planContext = (await getPlanContextBySlug(plan).catch(() => null)) ?? undefined;
    }

    // Build the shared spec: role prompt + signed role-scoped MCP URL + cwd.
    let spec;
    try {
      spec = await buildRoleLaunchSpec({
        role,
        workspaceId: workspace,
        harnessSlug,
        ...(planContext ? { planContext } : {}),
        operatorBaseUrl: new URL(req.url).origin,
        featureId: feature,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'role launch spec build failed' }, 400);
    }

    // Per-session coord/lock owner (P-022) — minted BEFORE the adv_sessions row
    // so it's stored as coord_owner_id, the live-roster join key to
    // coord_presence.owner_id (adv-sessions-live-roster P-001). The lock hooks +
    // the session's MCP calls share this one owner via PAPERCUSP_SID (below).
    const sid = `role-${randomUUID()}`;

    // Record the tracked session first so the prompt/mcp files key off its id.
    const sessionId = await recordAdvSession({
      workspaceId: workspace,
      role,
      feature,
      agent,
      planSlug: planContext ? plan : null,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd: spec.cwd,
      label: feature ? `${role} · ${feature}` : (planContext ? `${role} · ${plan}` : role),
      coordOwnerId: sid,
    });

    // Materialize the launch artifacts. claude/omp consume a `.mcp.json` +
    // a launch-context prompt file; codex (no --mcp-config /
    // --append-system-prompt flags) consumes a per-session CODEX_HOME whose
    // AGENTS.md is the role prompt and config.toml the role-scoped MCP. All
    // three carry the SAME signed role-scoped url (spec.mcpUrl).
    const sessionKey = sessionId ?? `role-${Date.now()}`;
    let mcpJsonPath = '';
    let promptFile = '';
    let codexHome: string | null = null;

    if (agent === 'codex') {
      try {
        const ch = writeRoleCodexHome({
          sessionKey,
          mcpUrl: spec.mcpUrl,
          promptText: spec.promptText,
          // The session's coordination identity → the activity-bridge hook reports
          // this worker's tool calls under it (codex bakes it; can't env-expand).
          sid,
        });
        codexHome = ch.codexHome;
        mcpJsonPath = ch.configPath; // config.toml — diagnostics
        promptFile = ch.agentsPath; // AGENTS.md — diagnostics
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `write codex home: ${e?.message}` }, 500);
      }
    } else {
      // Write the signed role-scoped .mcp.json into cwd (back up any existing
      // one, mirroring console-launch). omp path-discovers it; claude is
      // pointed at it via --mcp-config by the launcher.
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
      promptFile = launchContextPathFor(sessionKey);
      try {
        mkdirSync(launchContextDir(), { recursive: true });
        writeFileSync(promptFile, spec.promptText, { mode: 0o600 });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `write role prompt: ${e?.message}` }, 500);
      }
    }

    // Materialize this harness's + the workspace's saved prompts into the
    // locations this client reads, so the session starts with the `/name`
    // commands available (plan saved-prompts-cross-client; interactive only,
    // D-004). Codex needs them written into its ephemeral per-session home;
    // claude/omp read the on-disk .claude/commands files (kept fresh on save,
    // refreshed here belt-and-suspenders). Best-effort — a projection hiccup
    // must never block a launch.
    try {
      if (agent === 'codex' && codexHome) {
        await materializeCodexPrompts(codexHome, workspace, harnessSlug);
      } else {
        await materializeWorkspacePrompts(workspace);
        await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-role] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    const result: BootstrapRoleResult = {
      status: 'ok',
      sessionId,
      role,
      agent,
      workspaceId: workspace,
      harnessSlug,
      feature,
      planSlug: planContext ? plan : null,
      cwd: spec.cwd,
      promptFile,
      mcpJsonPath,
      codexHome,
      envelopeEnv: {
        PAPERCUSP_AGENT: agent,
        PAPERCUSP_ROLE: role,
        // P-022: per-session coord/lock owner. The lock hooks (claude
        // user-level; codex in the role home's settings.json) read this, so a
        // session's calls + hooks share one owner and concurrent sessions
        // don't collide. Same value recorded as adv_sessions.coord_owner_id.
        PAPERCUSP_SID: sid,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...(feature ? { PAPERCUSP_FEATURE_ID: feature } : {}),
        ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
      },
    };
    return jsonRes(result);
  },
});

export default [options, post];
