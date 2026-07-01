/**
 * GET (?action=spawn) / POST / OPTIONS /api/agent-mcp/console/launch
 *
 * Server-side native-console launcher. Principal-gated; CORS-open
 * (the endpoint itself is gated, operator binds loopback-only).
 *
 * Ported from app/api/agent-mcp/console/launch/route.ts. `auth: 'public'` —
 * requirePrincipal() inline.
 *
 * The OS-native spawn primitive (terminal selection, the launcher one-liner,
 * the per-plan window appearance) lives in `lib/console-spawn.ts` so this route
 * and the `capability:terminal` agent tool share ONE spawner.
 */
import type { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { advSessionTitleTag, spawnConsole } from '../../../console-spawn';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';
import { recordAdvSession, markAdvSessionEnded, resolveWindowIdForTitleFragment, setAdvSessionPid, setAdvSessionWindowId } from '../../../adv-sessions';

// Fire-and-forget child-exit listener that ends the adv_sessions row
// when the spawned terminal closes. detached+unref'd children still
// emit 'exit' on the parent's ChildProcess handle as long as we keep
// the JS reference alive — we don't, because the parent process
// outlives any one terminal. So we attach the listener and let Node
// hold it via the closure; the row will close when the terminal exits
// if the operator process is still alive, otherwise the row stays
// "active" (acceptable — operator-restart is the recovery boundary
// anyway). A future reaper can sweep stale rows by querying live pids.
function attachExitWatcher(child: ChildProcess, sessionPromise: Promise<number | null>): void {
  child.on('exit', (code) => {
    sessionPromise
      .then((id) => {
        if (id != null) void markAdvSessionEnded(id, code);
      })
      .catch(() => { /* best-effort */ });
  });
}

const DEBUG_LOG = '/tmp/console-launch.log';
function dlog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
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

async function resolveAndStoreWindowIdForAdvSession(id: number): Promise<void> {
  const tag = advSessionTitleTag(id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const wid = await resolveWindowIdForTitleFragment(tag);
    if (wid) {
      await setAdvSessionWindowId(id, wid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Safety floor for INTERACTIVE launches (P-012 / D-013 residual 3): the shared
// helper lives in lib/interactive-safety-floor.ts so EVERY interactive launch
// route (this console launch + adv/launch-su's psu web launch) passes the same
// floor — admission waived (human-initiated), ceiling still enforced, fail-open
// on a read error. Re-exported for compat (console-launch-floor.test.ts + any
// existing importer).
export { checkInteractiveSafetyFloor } from '../../../interactive-safety-floor';
import { checkInteractiveSafetyFloor } from '../../../interactive-safety-floor';

async function doSpawn(opts: { slug: string | null; operatorBaseUrl: string }): Promise<void> {
  // Safety floor (admission waived, human-initiated) — refuse over-ceiling. The
  // GET ?action=spawn handler catches + dlogs this throw, so no terminal launches.
  const floor = await checkInteractiveSafetyFloor(dlog);
  if (!floor.ok) throw new Error(floor.reason);
  const envelope = await buildConsoleEnvelope({
    workspaceId: activeWorkspaceId(),
    slug: opts.slug,
    operatorBaseUrl: opts.operatorBaseUrl,
  });
  const result = spawnConsole({ envelope, writeMcpJson: true });
  if (result.status === 'error') throw new Error(result.error);
  dlog(`doSpawn launched ${result.terminal} pid=${result.pid}`);
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/launch',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/launch',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const slug = url.searchParams.get('slug');
    const origin = req.headers.get('origin') ?? '(no-origin)';
    const ua = req.headers.get('user-agent') ?? '(no-ua)';

    if (action !== 'spawn') {
      dlog(`GET probe origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
      return jsonRes(
        { status: 'probe-ok', note: 'use ?action=spawn or POST to actually spawn a terminal' },
      );
    }

    dlog(`GET spawn origin=${origin} host=${req.headers.get('host')} slug=${slug ?? '(null)'} ua=${ua.slice(0, 60)}`);

    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    try {
      await doSpawn({ slug: slug || null, operatorBaseUrl: new URL(req.url).origin });
    } catch (e: any) {
      dlog(`GET spawn failed: ${e?.message}`);
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    return new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/launch',
  auth: 'loopback',
  async handler(req) {
    const origin = req.headers.get('origin') ?? '(no-origin)';
    const ua = req.headers.get('user-agent') ?? '(no-ua)';
    dlog(`POST hit origin=${origin} host=${req.headers.get('host')} ua=${ua.slice(0, 60)}`);
    console.log(`[console-launch] POST hit from origin=${origin} host=${req.headers.get('host')}`);

    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    // Safety floor (P-012 / D-013): interactive launches waive brain admission
    // but still pass the deterministic floor (the absolute concurrency ceiling).
    // Over-ceiling → 429 with an actionable message; admission itself is waived.
    const floorCheck = await checkInteractiveSafetyFloor(dlog);
    if (!floorCheck.ok) return jsonRes({ status: 'error', error: floorCheck.reason }, 429);
    let body: {
      slug?: string | null;
      // plan-agent-launch P-023: when set, the new terminal resumes an
      // existing session (`<agent-cli> -r <sessionId>`) instead of opening fresh.
      resumeSessionId?: string | null;
      // /adv plumbing: tag this session with the plan it was
      // launched from so /adv/sessions can group + display.
      planSlug?: string | null;
      label?: string | null;
      // psu-in-desktop-builds B: launch straight into a psu superuser session
      // (flag-gated server-side on PSU_END_USER in buildConsoleEnvelope).
      runPsu?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — empty body is fine */ }

    // This route is the SHELL superuser-console launcher. The omp launch
    // flavour was retired in P-032 — omp now rides launch-su → psu like
    // every other backend, so there is no longer a mode/kickoff/model branch
    // here. (resumeSessionId stays: shell consoles can resume `<cli> -r`.)
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: activeWorkspaceId(),
        slug: body.slug ?? null,
        operatorBaseUrl: new URL(req.url).origin,
        resumeSessionId: body.resumeSessionId ?? undefined,
        runPsu: body.runPsu ?? false,
      });
    } catch (e: any) {
      console.warn(`[console-launch] envelope build failed: ${e?.message}`);
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // Spawn (writes/back-ups .mcp.json, picks a terminal, opens a new window).
    // Linux-only at this tier; non-Linux operators get code 501 and the
    // renderer falls back to the Tauri console_launch command.
    const result = spawnConsole({
      envelope,
      planSlug: body.planSlug ?? null,
      label: body.label ?? null,
      writeMcpJson: true,
    });
    if (result.status === 'error') {
      console.warn(`[console-launch] spawn failed (${result.code}): ${result.error}`);
      return jsonRes({ status: 'error', error: result.error }, result.code);
    }

    const sessionPromise = recordAdvSession({
      planSlug: body.planSlug ?? null,
      mode: 'console',
      terminalBin: result.terminal,
      pid: result.pid,
      label: body.label ?? null,
      cwd: envelope.cwd,
      // WI-1343: record the actual command run in the spawned terminal — the terminal
      // binary + the envelope's greeting command (a resume `<cli> -r <id>`, `psu`, or
      // the shell greeting). Before this, launch_argv was NULL for every console
      // launch, so a spawned session could not be reconstructed after the fact.
      launchArgv: [result.terminal, envelope.greetingCmd].filter((s): s is string => !!s),
    });
    attachExitWatcher(result.child, sessionPromise);
    console.log(`[console-launch] spawned ${result.terminal} pid=${result.pid} cwd=${envelope.cwd}`);
    return jsonRes({
      status: 'ok',
      pid: result.pid,
      terminal: result.terminal,
    });
  },
});

export default [options, get, post];
