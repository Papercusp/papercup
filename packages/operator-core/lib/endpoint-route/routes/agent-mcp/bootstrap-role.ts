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
import { activeWorkspaceId, workspaceById } from '../../../workspace-registry';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { recordAdvSession } from '../../../adv-sessions';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { roleConsumes } from '../../../role-registry';
import { buildRoleLaunchSpec } from '../../../role-launch-spec';
import { getPlanContextBySlug } from '../../../plan-context-for-feature';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { assembleSpawnHydration } from '../../../fleet/spawn-hydration';
import { productionSpawnHydrationDeps } from '../../../fleet/spawn-hydration-deps';
import { writeRoleCodexHome } from '../../../role-codex-home';
import { writeInteractiveClaudeConfig } from '../../../interactive-claude-config';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { emitCodexSlashToolPrompts } from '../../../slash-tool-prompts-codex';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';
import { resolveAccountPin } from './bootstrap-su';
import { backendFeatureGuard } from '../../../backend-feature-capabilities';

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
  /** null = a workspace-level (harness-less) role session (P-003). */
  harnessSlug: string | null;
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
  /** Human-facing account pin result; null when no pin was requested or it resolved cleanly to default behavior. */
  accountNotice?: string | null;
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
  auth: 'loopback',
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
      account?: string | null;
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
    // null = a WORKSPACE-LEVEL role session (owner-confirmed, hive-agent-tabs
    // P-003: operator/planner launch without a harness — the SU model). A
    // feature-consuming role still needs the harness its feature lives in.
    const harnessSlug = body.harness_slug?.trim() || null;
    const feature = body.feature?.trim() || null;
    const plan = body.plan?.trim() || null;
    const accountPin = await resolveAccountPin(workspace, body.account ?? null, agent);

    // Feature + plan gating from the single source (roleConsumes / consumes).
    const consumes = roleConsumes(role, harnessSlug ?? '');
    if (consumes.feature === 'required' && !feature) {
      return jsonRes({ status: 'error', code: 'feature_required', error: `role '${role}' requires a feature (consumes.feature=required)` }, 400);
    }
    if (consumes.feature === 'required' && !harnessSlug) {
      return jsonRes({ status: 'error', code: 'harness_required', error: `role '${role}' consumes a feature — launch it against the feature's harness (--harness)` }, 400);
    }

    // Plan context for plan-consuming roles (scoper/reviewer: consumes.plan
    // !== 'none'). Honors the `consumes` single source the same way feature
    // does: only fetch+inject when the role actually consumes a plan AND one
    // was chosen. Best-effort — an unreadable plan just yields no section.
    let planContext: string | undefined;
    if (plan && consumes.plan !== 'none') {
      planContext = (await getPlanContextBySlug(plan).catch(() => null)) ?? undefined;
    }

    // directed-wake-honesty-and-spawn-handoff P-021/P-012: the INTERACTIVE launch's
    // call of the shared spawn/wake-hydration seam — the human-driven counterpart of
    // the autonomous path (operator-spawn → extraEnv.SPAWN_HANDOFF). Both paths bind
    // the source seam through productionSpawnHydrationDeps so they never diverge on
    // predecessor-handoff + roster + carry-note. NOTE: this path deliberately omits
    // `deliverTo`/`role`, so B2 slot-parked draining (P-023) does NOT fire here —
    // slot delivery is the AUTONOMOUS spawn's domain (the Queen parks for a
    // not-yet-spawned bee; delivered_to = its spawnId). Wiring it here needs the
    // session owner BEFORE buildRoleLaunchSpec mints `sid` (a small follow-up).
    // Harness-scoped: skipped for a workspace-level (no-harness) session. Gated on
    // SPAWN_HANDOFF_HYDRATION (default on); fully fail-soft so a hydration failure
    // never blocks the launch.
    let handoff: string | undefined;
    if (harnessSlug) {
      try {
        if (await getFlag(FLAGS.SPAWN_HANDOFF_HYDRATION, 'system')) {
          const hydration = await assembleSpawnHydration({
            harness: harnessSlug,
            featureId: feature ?? undefined,
            // Honor the role's `consumes.plan` contract for the handoff's plan SLICE,
            // exactly as the full planContext above does: a non-plan-consuming role
            // gets predecessor handoff + roster + carry-note, but no plan slice.
            planSlug: plan && consumes.plan !== 'none' ? plan : undefined,
            workItemId: feature ?? undefined,
            workspaceId: workspace,
            deps: productionSpawnHydrationDeps(),
            log: (m) => console.log(`[bootstrap-role] ${m}`),
          });
          if (hydration.text) handoff = hydration.text;
        }
      } catch (err) {
        console.warn(
          `[bootstrap-role] spawn-handoff hydration failed (degraded, launch continues): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Build the shared spec: role prompt + signed role-scoped MCP URL + cwd.
    let spec;
    try {
      spec = await buildRoleLaunchSpec({
        role,
        workspaceId: workspace,
        harnessSlug,
        ...(planContext ? { planContext } : {}),
        ...(handoff ? { handoff } : {}),
        operatorBaseUrl: new URL(req.url).origin,
        featureId: feature,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'role launch spec build failed' }, 400);
    }

    // Per-session coord/lock owner (P-022) — now MINTED BY THE LAUNCH-SPEC
    // PRIMITIVE (unify-launch-mechanics P-002), not here, so the one place that
    // signs the MCP URL also owns the identity: spec.sid === the URL's
    // `client=` param (EI-4) === PAPERCUSP_SID (below) === the codex-home baked
    // client. It's stored as coord_owner_id, the live-roster join key to
    // coord_presence.owner_id (adv-sessions-live-roster P-001).
    const sid = spec.sid;

    // Forced native session UUID for EXACT resumability (claude --session-id;
    // unify-launch-mechanics P-003 invariant d). Recording it as the adv row's
    // session_id lets wake-executor resume THIS conversation by uuid instead of
    // degrading to inbox — previously role sessions carried no native id and so
    // could not be woken-by-resume. claude-only: codex recovers its uuid from
    // the rollout, omp resumes by thread id.
    const nativeSessionId = backendFeatureGuard(agent, 'forced-native-session-id').supported
      ? spec.nativeSessionId
      : null;

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
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
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
          codexGatewayAccountId: accountPin.provider === 'codex' ? accountPin.accountId : null,
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

      // Also stash the signed .mcp.json at the per-session MCP dir (keyed by
      // sid via the shared helper, the same path wake-executor's resume leg
      // remounts via `--mcp-config … --strict-mcp-config`). Without this a woken
      // claude role session resumed TOOLLESS (its original launch loaded the
      // role MCP via --mcp-config; the resume must too). unify-launch-mechanics
      // P-003/P-004 — claude only (omp resumes by thread, codex by CODEX_HOME).
      if (agent === 'claude') {
        try {
          mkdirSync(spec.sessionMcpDir, { recursive: true });
          writeFileSync(join(spec.sessionMcpDir, '.mcp.json'), spec.mcpJsonContents, { mode: 0o600 });
        } catch (e: any) {
          // Non-fatal: the launch still works; only a later wake-by-resume would
          // degrade to a toolless turn. stderr (not console.*) for the vitest guard.
          process.stderr.write(`[bootstrap-role] session-mcp stash failed (non-fatal): ${e?.message}\n`);
        }
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

    // EI-155: an interactive claude role session gets the SAME per-session,
    // transcript-isolated CLAUDE_CONFIG_DIR the SU path does (the role path
    // already COMPUTES spec.claudeConfigDir = sessionClaudeConfigDir(sid) but
    // never materialized it — a half-wired unify-launch-mechanics invariant).
    // It carries the lock/coord hooks (user-level ~/.claude/settings.json) +
    // onboarding/trust through, isolating only the transcript store; the role
    // MCP stays scoped via the launcher's --mcp-config --strict-mcp-config (the
    // symlinked .claude.json servers are ignored under strict). Best-effort.
    let claudeConfigDir: string | null = null;
    if (agent === 'claude') {
      try {
        claudeConfigDir = writeInteractiveClaudeConfig({ sid }).configDir;
      } catch (e: any) {
        process.stderr.write(`[bootstrap-role] claude config-dir materialize failed (non-fatal): ${e?.message}\n`);
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
        if (harnessSlug) await materializeCodexPrompts(codexHome, workspace, harnessSlug);
        // Slash exposure (slash-exposure-tool-catalog-2026-06-12 P-009):
        // Codex doesn't surface MCP prompts as slash commands, so the
        // session-visible (role-filtered) tool catalog is materialized as
        // prompt FILES — the same walk tools/list serves this role.
        const r = await emitCodexSlashToolPrompts(codexHome, role as never);
        process.stderr.write(
          `[bootstrap-role] slash tool prompts: ${r.written} written, ${r.pruned} pruned in ${Math.round(r.ms)}ms\n`,
        );
      } else {
        await materializeWorkspacePrompts(workspace);
        if (harnessSlug) await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-role] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // resolve server-side + thread via envelopeEnv (same env the fleet + su paths read) so an
    // interactive role session's prompt REPLACES the Claude base when armed (coherent with
    // suLaunchArgs). Fail-soft ⇒ off (the launcher uses --append, byte-identical to today).
    let replaceClaudeBase = false;
    try {
      replaceClaudeBase = await getFlag(FLAGS.REPLACE_CLAUDE_BASE, workspace);
    } catch {
      /* flag miss ⇒ replace-base stays off */
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
      accountNotice: accountPin.notice,
      envelopeEnv: {
        PAPERCUSP_AGENT: agent,
        PAPERCUSP_ROLE: role,
        // P-022: per-session coord/lock owner. The lock hooks (claude
        // user-level; codex in the role home's settings.json) read this, so a
        // session's calls + hooks share one owner and concurrent sessions
        // don't collide. Same value recorded as adv_sessions.coord_owner_id.
        PAPERCUSP_SID: sid,
        ...(replaceClaudeBase ? { PAPERCUSP_REPLACE_CLAUDE_BASE: '1' } : {}),
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...accountPin.env,
        ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
        ...(feature ? { PAPERCUSP_FEATURE_ID: feature } : {}),
        ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
        // claude exact-resume: the launcher forces `--session-id <this>` so the
        // session's conversation id is known up-front and wake-executor resumes
        // EXACTLY it (never `--continue`'s most-recent-in-cwd peer). P-003 inv d.
        ...(nativeSessionId ? { PAPERCUSP_NATIVE_SESSION_ID: nativeSessionId } : {}),
      },
    };
    return jsonRes(result);
  },
});

export default [options, post];
