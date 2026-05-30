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
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { buildConsoleEnvelope } from '@/lib/console-launcher';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { recordAdvSession } from '@/lib/adv-sessions';
import { SU_WRAPPER_BIN, isSuAgent, type SuAgent } from '@/lib/su-agents';

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
 * Picker data for the `psu` launcher (and the /adv "Launch SU" modal):
 *   - no query        → { workspace, harnesses: [{ slug, path, status }] }
 *   - ?harness=<slug> → { harness, plans: [{ slug }] } (non-archived)
 *
 * Scoped to the active workspace (bootstrap-su uses activeWorkspaceId);
 * cross-workspace picking can come later.
 */
const optionsGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    const workspace = activeWorkspaceId();
    const harness = new URL(req.url).searchParams.get('harness')?.trim() || null;

    if (harness) {
      try {
        const { resolveHarnessPlansDir, listPlanFiles } = await import('@/lib/agent-tools/plans/source');
        const { plans, archive } = await resolveHarnessPlansDir(harness, { workspaceId: workspace });
        const entries = await listPlanFiles({ plansDir: plans, archiveDir: archive });
        return jsonRes({
          status: 'ok',
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
    return jsonRes({ status: 'ok', workspace, harnesses });
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
      harness_slug?: string | null;
      plan_slug?: string | null;
      label?: string | null;
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
    const harnessSlug = body.harness_slug?.trim() || null;
    const planSlug = body.plan_slug?.trim() || null;

    // Resolve cwd + context env from the existing console envelope builder
    // (shell mode). We don't use its .mcp.json/launchCommand — the *-su
    // wrapper carries its own MCP config + flags.
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: activeWorkspaceId(),
        slug: harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
        mode: 'shell',
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // Record the tracked session. plan_slug null → a "No plan" row (D-005).
    // mode mirrors the agent kind for the legacy omp|console CHECK; the
    // new `agent` column carries the precise kind.
    const sessionId = await recordAdvSession({
      planSlug,
      agent,
      mode: agent === 'omp' ? 'omp' : 'console',
      cwd: envelope.cwd,
      label: body.label?.trim() || null,
    });

    const envelopeEnv: Record<string, string> = {
      ...envelope.env,
      PAPERCUSP_AGENT: agent,
      ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
    };

    const result: BootstrapSuResult = {
      status: 'ok',
      sessionId,
      agent,
      cwd: envelope.cwd,
      harnessSlug,
      planSlug,
      wrapperBin: SU_WRAPPER_BIN[agent],
      envelopeEnv,
    };
    return jsonRes(result);
  },
});

export default [options, optionsForOptions, post, optionsGet];
