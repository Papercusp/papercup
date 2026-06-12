/**
 * POST / OPTIONS /api/agent-mcp/console/bootstrap-su
 *
 * Bootstraps a tracked superuser engineer session for one of the three
 * `*-su` wrappers (claude-su / omp-su / codex-su). Called by the
 * plan-tracked launcher after the user picks a harness + plan; the
 * launcher cd's to `cwd`, exports `envelopeEnv`, and exec's `wrapperBin`.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` (P-006), pivoted
 * onto the shipped `*-su` wrappers + reconciled against the data model:
 *   - the session is an `adv_sessions` row (NOT a plan_run/spawn — those
 *     are the autonomous-execution surface). plan_slug set → plan-bound;
 *     null → a "No plan" row (D-005). Both appear in /adv Sessions.
 *   - the `*-su` wrappers already inject the playbook + skip-permissions
 *     + MCP auth (codex-su via a dedicated CODEX_HOME), so this returns
 *     only WHICH wrapper to exec + the tracking env — no cliFlags, no
 *     token handling.
 *
 * Principal-gated; CORS-open (operator binds loopback-only). `auth:
 * 'public'` — requirePrincipal() inline, mirroring console-launch.ts.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, readRegistry, workspaceById } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { recordAdvSession } from '../../../adv-sessions';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';
import { buildLaunchSpec } from '../../../role-launch-spec';
import { writeSuCodexHome } from '../../../role-codex-home';
import { writeInteractiveClaudeConfig } from '../../../interactive-claude-config';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { resolveInstallPaths } from '../../../desktop-install/papercusp-files';
import { readSuperuserToken } from '../../../superuser-token';
import { homedir } from 'node:os';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
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

export interface BootstrapSuResult {
  status: 'ok';
  /** adv_sessions row id; null if the insert failed (best-effort). */
  sessionId: number | null;
  /** The agent's NATIVE session id the launcher must force on the CLI so the
   *  session is resumable + recognizable by id. claude → a forced UUID
   *  (`claude --session-id`); omp/codex → null (they don't take a forced id). */
  nativeSessionId: string | null;
  agent: SuAgent;
  /** Workspace the harness + session belong to. */
  workspaceId: string;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  harnessSlug: string | null;
  planSlug: string | null;
  /**
   * File holding the engineer playbook + per-launch scope/plan addendum —
   * the launcher feeds it as the system prompt. claude/omp: a launch-context
   * `.md` (--append-system-prompt[-file]). codex: the CODEX_HOME AGENTS.md.
   */
  promptFile: string;
  /**
   * Per-session CODEX_HOME for a codex su session (AGENTS.md = playbook,
   * config.toml = superuser MCP, settings.json = lock hooks, auth symlink).
   * null for claude/omp (their MCP + hooks are user-level). Also surfaced in
   * `envelopeEnv.CODEX_HOME`.
   */
  codexHome: string | null;
  /**
   * The omp coordination extension path (`~/.papercusp/papercusp-coord.ts`)
   * the launcher loads via `-e` for lock enforcement, or null if not
   * installed. Ignored for claude (hooks are user-level) + codex (home).
   */
  coordExtPath: string | null;
  /**
   * Env the launcher exports into the CHILD process (the raw CLI). Carries
   * the MCP/context vars + PAPERCUSP_AGENT + PAPERCUSP_SID (per-session
   * coord/lock owner) + PAPERCUSP_ADV_SESSION_ID + CODEX_HOME (codex) +
   * CLAUDE_CONFIG_DIR (claude — the per-session transcript-isolated config dir,
   * EI-155). No secrets — the superuser bearer is read from the 0600 token file
   * by the launcher, never sent over HTTP.
   */
  envelopeEnv: Record<string, string>;
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForOptions = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * GET /api/agent-mcp/console/bootstrap-su/brain
 *
 * The canonical brain pin (native-terminal-desktop D-013): the native session
 * uuid of THE persistent psu engineer session the desktop chat dock's brain
 * pane resumes. `{ brainSessionId: string | null }` — null until a
 * `brain: true` launch pins one. `psu --brain` resolves this to an exact
 * picker-free resume (and falls back to a fresh re-pinning launch when null
 * or no longer resumable).
 */
const brainGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/brain',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    try {
      const { getBrainSession } = await import('../../../brain-pin');
      return jsonRes({ brainSessionId: await getBrainSession() });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `brain pin read failed: ${e?.message ?? e}` }, 500);
    }
  },
});

/**
 * GET /api/agent-mcp/console/bootstrap-su/options
 *
 * Picker data for the `psu` launcher (and the /adv "Launch SU" modal).
 * Harnesses are workspace-scoped, so the picker walks workspace → harness
 * → plan:
 *   - no query                   → { activeWorkspace, workspace, workspaces:
 *                                    [{ id, name }], harnesses: [{ slug, path, status }] }
 *   - ?workspace=<id>            → harnesses for that workspace
 *   - ?workspace=<id>&harness=<slug> → { plans: [{ slug }] } (non-archived)
 * `workspace` defaults to the active workspace when omitted.
 */
const optionsGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    const url = new URL(req.url);
    const workspace = url.searchParams.get('workspace')?.trim() || activeWorkspaceId();
    const harness = url.searchParams.get('harness')?.trim() || null;
    const wantFeatures = url.searchParams.get('features') === '1';

    // ?harness=X&features=1 → feature list (for the psu --role feature picker).
    if (harness && wantFeatures) {
      try {
        const { listFeaturesForHarness } = await import('../../../harness-readers');
        const r = await listFeaturesForHarness(harness, 'staging');
        const features = r.ok
          ? (r.data.features as Array<{ id?: string; feature_id?: string; title?: string; description?: string; status?: string }>).map((f) => ({
              id: f.id ?? f.feature_id ?? '',
              title: f.title ?? f.description ?? '',
              status: f.status ?? null,
            })).filter((f) => f.id)
          : [];
        return jsonRes({ status: 'ok', workspace, harness, features });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'features listing failed' }, 400);
      }
    }

    if (harness) {
      try {
        const { resolveHarnessPlansDir, listPlanFiles } = await import('../../../agent-tools/plans/source');
        const resolved = await resolveHarnessPlansDir(harness, { workspaceId: workspace });
        const entries = await listPlanFiles({ harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
        return jsonRes({
          status: 'ok',
          workspace,
          harness,
          plans: entries.filter((e) => !e.archived).map((e) => ({ slug: e.slug })),
        });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'plans listing failed' }, 400);
      }
    }

    const { listHarnessesFor } = await import('../../../device-harnesses');
    const harnesses = (await listHarnessesFor(workspace)).map((h) => ({
      slug: h.slug,
      path: h.path,
      status: h.status,
    }));
    const workspaces = readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name }));
    // Roles + their consumes (feature/plan needs) for the psu --role picker.
    const { getKnownRoles } = await import('../../../known-roles');
    const { roleConsumes } = await import('../../../role-registry');
    const roles = getKnownRoles().map((id) => ({ id, consumes: roleConsumes(id, harness ?? '') }));
    return jsonRes({ status: 'ok', activeWorkspace: activeWorkspaceId(), workspace, workspaces, harnesses, roles });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let body: {
      agent?: string;
      workspace?: string | null;
      harness_slug?: string | null;
      plan_slug?: string | null;
      label?: string | null;
      /** Playbook profile (engineer|power), assembled per-launch (P-023).
       *  Omitted/invalid → 'engineer'. */
      profile?: string | null;
      /** The launcher's own cwd — used for no-harness launches so the
       *  agent's cwd-scoped session resume works from the user's terminal. */
      cwd?: string | null;
      /** Pin this launch as THE canonical brain session (the desktop chat
       *  dock's right pane — native-terminal-desktop D-013). claude-only:
       *  the pin is the forceable native session uuid, which only claude
       *  has (`--session-id`). `psu --brain` reads it back for an exact
       *  picker-free resume. */
      brain?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonRes({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (!isSuAgent(body.agent)) {
      return jsonRes(
        { status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` },
        400,
      );
    }
    const agent: SuAgent = body.agent;
    const workspace = body.workspace?.trim() || activeWorkspaceId();
    if (body.workspace?.trim() && !workspaceById(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    const harnessSlug = body.harness_slug?.trim() || null;
    const planSlug = body.plan_slug?.trim() || null;
    const callerCwd = body.cwd?.trim() || null;
    // P-023: playbook profile. Only 'engineer' | 'power' are valid base
    // playbooks (prompts/papercusp-su-<profile>.tools.md); anything else → 400
    // so a typo doesn't silently fall back. Omitted → engineer.
    const profileRaw = body.profile?.trim() || null;
    if (profileRaw && profileRaw !== 'engineer' && profileRaw !== 'power') {
      return jsonRes({ status: 'error', error: `profile must be engineer|power (got ${profileRaw.slice(0, 24)})` }, 400);
    }
    const profile = profileRaw ?? 'engineer';

    // D-013 brain pin: only claude has a forceable native session uuid (the
    // pin's value), so a brain launch with another agent is a caller bug —
    // fail loud rather than silently launching an unpinnable "brain".
    const brain = body.brain === true;
    if (brain && agent !== 'claude') {
      return jsonRes(
        { status: 'error', error: `brain launches must use agent=claude (the pin is the forced --session-id uuid; got ${agent})` },
        400,
      );
    }

    // Resolve cwd + context env from the existing console envelope builder
    // (shell mode), scoped to the chosen workspace. We use its env + cwd;
    // the prompt + MCP come from buildLaunchSpec(su) below.
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: workspace,
        slug: harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // cwd: a harness launch runs in the harness repo (envelope.cwd). A
    // no-harness launch prefers the launcher's own cwd (the user's
    // terminal) over the internal .papercusp dir — agents scope their
    // resumable sessions by cwd, so this makes `--resume` work from where
    // the user is. Recorded + returned + exec'd consistently.
    const cwd = harnessSlug ? envelope.cwd : (callerCwd || envelope.cwd);

    // Fetch the bound plan's `## Now` + title for the launch-context addendum
    // (best-effort — buildLaunchSpec composes the addendum from these).
    let planNow: { state: string; next: string } | null = null;
    let planTitle: string | null = null;
    if (planSlug && harnessSlug) {
      try {
        const { resolveHarnessPlansDir, readPlanBySlug } = await import('../../../agent-tools/plans/source');
        const resolved = await resolveHarnessPlansDir(harnessSlug, { workspaceId: workspace });
        const found = await readPlanBySlug(planSlug, { harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
        if (found) {
          planNow = found.parsed.now;
          planTitle = found.parsed.frontmatter?.title ?? null;
        }
      } catch {
        // plan context is optional — proceed without it
      }
    }

    // Build the su launch spec: engineer playbook + per-launch scope/plan
    // addendum (promptText) + the superuser MCP url (codex consumes it). The
    // SAME builder roles use, at the superuser tier (D-001).
    let spec;
    try {
      spec = await buildLaunchSpec({
        kind: 'su',
        agent,
        workspaceId: workspace,
        operatorBaseUrl: new URL(req.url).origin,
        harnessSlug,
        profile,
        planSlug,
        planTitle,
        planNow,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'su launch spec build failed' }, 400);
    }

    // Per-session coord/lock owner (P-022). Replaces the wrapper's SID
    // minting: claude's user-level papercusp-su url env-expands ${PAPERCUSP_SID}
    // and the lock hooks read the same var, so a session's interactive calls
    // and its hooks share ONE owner — and two concurrent psu sessions get
    // distinct owners (the collapse the per-session id fixes). Minted BEFORE the
    // adv_sessions row so it's recorded as coord_owner_id — the live-roster join
    // key to coord_presence.owner_id (adv-sessions-live-roster P-001).
    const sid = `su-${randomUUID()}`;

    // The agent's NATIVE session id. claude lets us FORCE it (`--session-id`),
    // so we mint it here, record it, and the launcher passes it through — that's
    // the only way `psu --resume <native-uuid>` can later correlate this exact
    // session back to its adv row (without it, resume-by-uuid falls through to
    // the false "not started by psu" path). omp's native handle is the
    // omp_thread_id (linked post-launch); codex resumes via its per-session
    // CODEX_HOME and can't have its rollout id forced — so both stay null.
    const nativeSessionId = agent === 'claude' ? randomUUID() : null;

    // Record the tracked session first so the prompt/home files key off its id.
    const sessionId = await recordAdvSession({
      planSlug,
      agent,
      workspaceId: workspace,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd,
      label: body.label?.trim() || null,
      coordOwnerId: sid,
      sessionId: nativeSessionId,
    });

    const sessionKey = sessionId ?? `t-${randomUUID()}`;

    // D-013: pin this launch as THE canonical brain. The uuid is minted above
    // and forced via `--session-id`, so the pin lands BEFORE the session's
    // first turn — `psu --brain` resumes exactly it from now on. Pin failure
    // fails the launch (a silent unpinned "brain" would fork a new brain on
    // every dock open — worse than a loud error).
    if (brain) {
      if (!nativeSessionId) {
        return jsonRes({ status: 'error', error: 'brain launch minted no native session id' }, 500);
      }
      try {
        const { setBrainSession } = await import('../../../brain-pin');
        await setBrainSession(nativeSessionId);
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `brain pin failed: ${e?.message ?? e}` }, 500);
      }
    }

    // Materialize the launch artifacts. codex (no --mcp-config/-prompt flags)
    // gets a per-session CODEX_HOME (P-030); claude/omp get a launch-context
    // prompt file and rely on their USER-LEVEL papercusp-su MCP (it survives
    // a raw launch — no per-launch .mcp.json needed for su).
    let promptFile = '';
    let codexHome: string | null = null;
    try {
      if (agent === 'codex') {
        // D-006: the superuser bearer is baked into the home's config.toml
        // (codex 0.135's bearer_token_env_var doesn't deliver for HTTP MCP).
        // Read it server-side — it never transits the bootstrap HTTP response.
        const ch = writeSuCodexHome({ sessionKey, mcpUrl: spec.mcpUrl, promptText: spec.promptText, sid, token: readSuperuserToken() });
        codexHome = ch.codexHome;
        promptFile = ch.agentsPath; // AGENTS.md — diagnostics
      } else {
        promptFile = launchContextPathFor(sessionKey);
        mkdirSync(launchContextDir(), { recursive: true });
        writeFileSync(promptFile, spec.promptText, { mode: 0o600 });
      }
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `write su launch artifacts: ${e?.message}` }, 500);
    }

    // Materialize saved prompts so the session starts with the workspace's
    // `/name` commands (+ the harness's, when this su session is harness-
    // scoped) available in this client (plan saved-prompts-cross-client).
    // Codex needs them in its ephemeral home; claude/omp read .claude/commands.
    // Best-effort — never block a launch.
    try {
      if (agent === 'codex' && codexHome) {
        await materializeCodexPrompts(codexHome, workspace, harnessSlug);
      } else {
        await materializeWorkspacePrompts(workspace);
        if (harnessSlug) await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-su] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    // omp loads the coordination extension via -e for lock enforcement.
    const coordExt = resolveInstallPaths(homedir()).extensionPath;
    const coordExtPath = existsSync(coordExt) ? coordExt : null;

    // EI-155: an interactive claude session gets a per-session, transcript-
    // isolated CLAUDE_CONFIG_DIR (keyed by sid via the shared helper, so the
    // wake-executor resume leg resolves the SAME dir). It is a symlink mirror of
    // ~/.claude with only `projects/` isolated — the user-level papercusp-su MCP,
    // the lock/coord hooks, plugins, and onboarding/trust all carry through (a
    // creds-only dir like the bee path would strip all of those — see
    // writeInteractiveClaudeConfig). codex isolates via its CODEX_HOME; omp's
    // store is its own. Best-effort: a materialize failure must not block a
    // launch (the session falls back to the shared ~/.claude, exactly as before).
    let claudeConfigDir: string | null = null;
    if (agent === 'claude') {
      try {
        claudeConfigDir = writeInteractiveClaudeConfig({ sid }).configDir;
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] claude config-dir materialize failed (non-fatal): ${e?.message}\n`);
      }
    }

    const envelopeEnv: Record<string, string> = {
      ...envelope.env,
      PAPERCUSP_AGENT: agent,
      PAPERCUSP_SID: sid,
      // Per-launch dispatch profile. claude's user-level MCP url expands
      // ${PAPERCUSP_PROFILE:-}; omp carries it via the x-papercusp-profile
      // header — without this export, --profile=power changed only the
      // playbook text while the MCP dispatcher kept gating as engineer.
      PAPERCUSP_PROFILE: profile,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
    };

    const result: BootstrapSuResult = {
      status: 'ok',
      sessionId,
      nativeSessionId,
      agent,
      workspaceId: workspace,
      cwd,
      harnessSlug,
      planSlug,
      promptFile,
      codexHome,
      coordExtPath,
      envelopeEnv,
    };
    return jsonRes(result);
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/heartbeat  { ownerId }
 *
 * The psu SUPERVISOR beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-003): the launcher process — which stays alive as the agent's parent —
 * POSTs this every ~60s while its child runs, so a session in a long turn
 * with NO tool calls keeps its coord_presence row warm (process-alive
 * semantics, the interactive analog of the fleet nursery beat).
 *
 * touchHeartbeat is a no-op when no presence row exists (D-003 — the beat
 * never mints roster rows; declare-intent at session start does that).
 *
 * Deliberately NO audit/adv-session write: high-frequency + zero
 * information. Trust: principal-gated like the sibling console routes;
 * a same-UID loopback caller naming another ownerId is inside the existing
 * console trust boundary (same model as the cc/ hook chain).
 */
const heartbeat = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let ownerId = '';
    try {
      const body = (await req.json()) as { ownerId?: unknown };
      if (typeof body.ownerId === 'string') ownerId = body.ownerId.trim();
    } catch {
      /* fall through to the 400 */
    }
    if (!ownerId || ownerId.length > 200) {
      return jsonRes({ error: 'ownerId required' }, 400);
    }
    try {
      const { touchHeartbeat } = await import('../../../agent-tools/coordination/presence');
      await touchHeartbeat(ownerId);
      return jsonRes({ ok: true });
    } catch (err) {
      // Best-effort contract: the launcher treats any failure as a missed
      // beat, never an error loop.
      return jsonRes(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        503,
      );
    }
  },
});

const optionsForHeartbeat = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

export default [options, optionsForOptions, post, optionsGet, brainGet, heartbeat, optionsForHeartbeat];
