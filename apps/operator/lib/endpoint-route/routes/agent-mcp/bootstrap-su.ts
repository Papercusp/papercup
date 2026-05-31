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
import { mkdirSync, writeFileSync } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, readRegistry, workspaceById } from '@/lib/workspace-registry';
import { buildConsoleEnvelope } from '@/lib/console-launcher';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { recordAdvSession } from '@/lib/adv-sessions';
import { SU_WRAPPER_BIN, isSuAgent, type SuAgent } from '@/lib/su-agents';
import { composeLaunchContext, launchContextDir, launchContextPathFor } from '@/lib/su-launch-context';

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
  agent: SuAgent;
  /** Workspace the harness + session belong to. */
  workspaceId: string;
  /** Working directory the launcher should exec the wrapper in. */
  cwd: string;
  harnessSlug: string | null;
  planSlug: string | null;
  /** The `*-su` wrapper the launcher should exec (e.g. 'claude-su'). */
  wrapperBin: string;
  /**
   * Env the launcher exports into the CHILD process (the *-su wrapper).
   * Carries the MCP/context vars + PAPERCUSP_AGENT + PAPERCUSP_ADV_SESSION_ID.
   * No secrets — the wrappers self-authenticate via their own config.
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

    if (harness) {
      try {
        const { resolveHarnessPlansDir, listPlanFiles } = await import('@/lib/agent-tools/plans/source');
        const { plans, archive } = await resolveHarnessPlansDir(harness, { workspaceId: workspace });
        const entries = await listPlanFiles({ plansDir: plans, archiveDir: archive });
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

    const { listHarnessesFor } = await import('@/lib/device-harnesses');
    const harnesses = (await listHarnessesFor(workspace)).map((h) => ({
      slug: h.slug,
      path: h.path,
      status: h.status,
    }));
    const workspaces = readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name }));
    return jsonRes({ status: 'ok', activeWorkspace: activeWorkspaceId(), workspace, workspaces, harnesses });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let body: {
      agent?: string;
      workspace?: string | null;
      harness_slug?: string | null;
      plan_slug?: string | null;
      label?: string | null;
      /** The launcher's own cwd — used for no-harness launches so the
       *  agent's cwd-scoped session resume works from the user's terminal. */
      cwd?: string | null;
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

    // Resolve cwd + context env from the existing console envelope builder
    // (shell mode), scoped to the chosen workspace. We don't use its
    // .mcp.json/launchCommand — the *-su wrapper carries its own MCP
    // config + flags.
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: workspace,
        slug: harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
        mode: 'shell',
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

    // Record the tracked session. plan_slug null → a "No plan" row (D-005).
    // mode mirrors the agent kind for the legacy omp|console CHECK; the
    // new `agent` column carries the precise kind.
    const sessionId = await recordAdvSession({
      planSlug,
      agent,
      workspaceId: workspace,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd,
      label: body.label?.trim() || null,
    });

    // Compose a launch-specific context addendum (harness scope + the
    // bound plan's `## Now`) and stash it where the chosen `*-su` wrapper
    // can `--append-system-prompt[-file]` it (P-021/P-022). Entirely
    // best-effort: plan reads are a nice-to-have, and a failed write must
    // not fail the launch — the wrapper only appends the file if it exists.
    let launchContextEnv: Record<string, string> = {};
    {
      let planNow: { state: string; next: string } | null = null;
      let planTitle: string | null = null;
      if (planSlug && harnessSlug) {
        try {
          const { resolveHarnessPlansDir, readPlanBySlug } = await import('@/lib/agent-tools/plans/source');
          const { plans, archive } = await resolveHarnessPlansDir(harnessSlug, { workspaceId: workspace });
          const found = await readPlanBySlug(planSlug, { plansDir: plans, archiveDir: archive });
          if (found) {
            planNow = found.parsed.now;
            planTitle = found.parsed.frontmatter?.title ?? null;
          }
        } catch {
          // plan context is optional — proceed without it
        }
      }
      const addendum = composeLaunchContext({ harnessSlug, planSlug, planTitle, planNow });
      if (addendum) {
        const file = launchContextPathFor(sessionId ?? `t-${Date.now()}`);
        try {
          mkdirSync(launchContextDir(), { recursive: true });
          writeFileSync(file, addendum, 'utf8');
          launchContextEnv = { PAPERCUSP_LAUNCH_CONTEXT_FILE: file };
        } catch {
          // couldn't persist the addendum — skip the env var (wrapper guards on the file)
        }
      }
    }

    const envelopeEnv: Record<string, string> = {
      ...envelope.env,
      PAPERCUSP_AGENT: agent,
      ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
      ...launchContextEnv,
    };

    const result: BootstrapSuResult = {
      status: 'ok',
      sessionId,
      agent,
      workspaceId: workspace,
      cwd,
      harnessSlug,
      planSlug,
      wrapperBin: SU_WRAPPER_BIN[agent],
      envelopeEnv,
    };
    return jsonRes(result);
  },
});

export default [options, optionsForOptions, post, optionsGet];
