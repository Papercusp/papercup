/**
 * GET (?action=spawn) / POST / OPTIONS /api/agent-mcp/console/launch
 *
 * Server-side native-console launcher. Principal-gated; CORS-open
 * (the endpoint itself is gated, operator binds loopback-only).
 *
 * Ported from app/api/agent-mcp/console/launch/route.ts. `auth: 'public'` —
 * requirePrincipal() inline.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';
import { recordAdvSession, markAdvSessionEnded, resolveWindowIdForTitleFragment, setAdvSessionPid, setAdvSessionWindowId } from '../../../adv-sessions';

// Fire-and-forget child-exit listener that ends the adv_sessions row
// when the spawned terminal closes. detached+unref'd children still
// emit 'exit' on the parent's ChildProcess handle as long as we keep
// the JS reference alive — we don't, because the parent process
// outlives any one terminal. So we attach the listener before
// `unref()` and let Node hold it via the closure; the row will close
// when the terminal exits if the operator process is still alive,
// otherwise the row stays "active" (acceptable — operator-restart is
// the recovery boundary anyway). A future reaper can sweep stale
// rows by querying live pids.
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

// (kickoff-kind allowlist + validator moved to @/lib/agent-kickoff/kickoff-kind
//  in P-032 — this route no longer launches omp/kickoff; omp rides launch-su.)

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

const LINUX_TERMINALS: Array<[string, string[]]> = [
  // gnome-terminal is a thin client talking to gnome-terminal-server; without
  // `--wait` the client process exits immediately after creating the window,
  // which makes adv_sessions rows look "ended" even while the real terminal is
  // still open.
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push('/usr/bin', '/usr/local/bin');
  return paths.some((p) => existsSync(join(p, bin)));
}

// Cache the terminal selection — it's the same on every call
// (terminal binaries don't appear/disappear at runtime), and the
// existsSync sweep across LINUX_TERMINALS was adding noticeable
// latency to every console launch.
let cachedTerminal: { bin: string; args: string[] } | null | undefined;
function findLinuxTerminal(): { bin: string; args: string[] } | null {
  if (cachedTerminal !== undefined) return cachedTerminal;
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    cachedTerminal =
      fromEnv === 'gnome-terminal'
        ? { bin: fromEnv, args: ['--wait', '--'] }
        : { bin: fromEnv, args: ['-e'] };
    return cachedTerminal;
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) {
      cachedTerminal = { bin, args: [...args] };
      return cachedTerminal;
    }
  }
  cachedTerminal = null;
  return cachedTerminal;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Emit the OSC escape sequences that recolor + retitle the terminal
 * window: foreground (OSC 10), background (OSC 11), window title
 * (OSC 0). Per-plan background is hashed from the plan slug for
 * visual identity; foreground is fixed white for contrast.
 *
 * Why dark backgrounds + light foreground (not light + black):
 * agent CLIs (omp / claude / codex) emit ANSI bright colors
 * (bright-yellow, bright-cyan, bright-white) which are designed for
 * dark-themed terminals. On a light pastel background they become
 * illegible — the "bright text on bright background" failure mode.
 * Dark saturated backgrounds keep those ANSI brights readable while
 * still letting each plan's terminal be visually distinct at a
 * glance.
 *
 * Wrapped in `printf` with literal escape bytes (`\033` = ESC,
 * `\007` = BEL) so the sequence reaches the tty verbatim regardless
 * of the shell's echo dialect, before the spawned shell starts
 * reading.
 */
interface AppearanceOpts {
  mode: 'omp' | 'console';
  planSlug: string | null;
  label: string | null;
  advSessionId?: number | null;
}
function buildAppearancePrelude(opts: AppearanceOpts): string {
  const bg = hashSlugToColor(opts.planSlug, opts.mode);
  const fg = '#f4f4f5'; // zinc-100 — bright but not pure white (avoids halation on dark bg)
  const title = formatWindowTitle(opts);
  // OSC sequences:
  //   ESC ] 10 ; <fg> BEL    → default foreground
  //   ESC ] 11 ; <bg> BEL    → default background
  //   ESC ] 0  ; <title> BEL → window + tab title
  const titleEsc = title.replace(/'/g, "'\\''");
  return [
    `printf '\\033]10;${fg}\\007'`,
    `printf '\\033]11;${bg}\\007'`,
    `printf '\\033]0;${titleEsc}\\007'`,
  ].join(' && ');
}

/**
 * Deterministic slug → background color. Picks from a curated palette
 * of dark, saturated, high-distinctness hues. Every color is dark
 * enough that ANSI bright colors (90–97 / brights 8–15 / true-color
 * pastels) remain readable on top — the contrast budget is reserved
 * for whatever the agent CLI emits, not for the default text. Fixed
 * neutral fallback when planSlug is null.
 */
function hashSlugToColor(planSlug: string | null, mode: 'omp' | 'console'): string {
  // mode-specific defaults: deep teal for OMP, dark indigo for raw consoles.
  if (!planSlug) return mode === 'omp' ? '#0f3a36' : '#1e1b4b';
  const palette = [
    '#1e293b', // slate-800
    '#0f172a', // slate-900
    '#1e1b4b', // indigo-950
    '#312e81', // indigo-900
    '#3b0764', // purple-950
    '#581c87', // purple-900
    '#831843', // pink-900
    '#7f1d1d', // red-900
    '#7c2d12', // orange-900
    '#78350f', // amber-900
    '#365314', // lime-900
    '#14532d', // green-900
    '#134e4a', // teal-900
    '#164e63', // cyan-900
    '#0c4a6e', // sky-900
  ];
  let h = 0;
  for (let i = 0; i < planSlug.length; i++) {
    h = ((h << 5) - h + planSlug.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length];
}

function advSessionTitleTag(id: number | null | undefined): string {
  return id != null ? `[adv:${id}]` : '';
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

function formatWindowTitle(opts: AppearanceOpts): string {
  const tag = opts.mode === 'omp' ? 'OMP' : 'SH';
  const advTag = advSessionTitleTag(opts.advSessionId);
  const name = opts.label?.trim() || opts.planSlug;
  return name ? `${tag}${advTag}: ${name}` : `${tag}${advTag}`;
}

function buildOneliner(
  cwd: string,
  env: Record<string, string>,
  greeting: string,
  appearance: AppearanceOpts,
): string {
  const envExports: string[] = [];
  if (env.PAPERCUSP_SCRIPTS_DIR) {
    envExports.push(`export PATH=${shellEscape(env.PAPERCUSP_SCRIPTS_DIR)}:\${PATH}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  const escapedCwd = shellEscape(cwd);
  return [
    buildAppearancePrelude(appearance),
    `cd ${escapedCwd}`,
    ...envExports,
    `touch .papercup-console-active.$`,
    `trap 'rm -f .papercup-console-active.$' EXIT`,
    `(${greeting.replace(/'/g, "'\\''")})`,
    `exec "\${SHELL:-/bin/bash}" -l`,
  ].join(' && ').replace(' && (', ' ; (');
}

/**
 * Safety floor for INTERACTIVE launches (P-012 / D-013 residual 3). A
 * human-initiated console WAIVES brain admission (no `new_subagent` worth-it
 * round-trip — the human is the judgment + the durability), but STILL passes the
 * deterministic safety floor: the absolute concurrency ceiling
 * (`maxSimultaneousAgents`), the plan's last-resort guard. Over-ceiling → refuse
 * with an actionable message (the human can `fleet:cancel` a spawn or raise the
 * cap live). Reading the floor also feeds the interactive launch into the same
 * headroom picture the brain consults, so console sessions are no longer
 * invisible to the floor.
 *
 * Fail-OPEN: if the headroom read throws (e.g. PG briefly down) we NEVER block a
 * human launch on it — the floor is a guard, not a gate that can wedge a person.
 *
 * Lazy import: `fleet/operator-spawn` pulls `dbos/orchestrator-runner` (which
 * registers the DBOS workflow graph at module load), so importing it eagerly here
 * would drag those process-global registrations into this route's import graph.
 */
export async function checkInteractiveSafetyFloor(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { getSpawnHeadroom } = await import('../../../fleet/operator-spawn');
    const floor = await getSpawnHeadroom(activeWorkspaceId());
    if (floor.headroom <= 0) {
      return {
        ok: false,
        reason:
          `console launch refused by the safety floor: ${floor.running} agent(s) running ≥ ceiling ` +
          `${floor.ceiling} (maxSimultaneousAgents). Interactive launches WAIVE brain admission but still ` +
          `pass the floor (P-012 / D-013) — fleet:cancel a spawn or raise maxSimultaneousAgents ` +
          `(operator:rate_limit_config), then retry.`,
      };
    }
    dlog(`safety floor OK: running=${floor.running} ceiling=${floor.ceiling} headroom=${floor.headroom} (admission waived — human-initiated)`);
    return { ok: true };
  } catch (e: any) {
    // Fail-open: never block a human-initiated launch on a floor-read failure.
    dlog(`safety floor read failed (${e?.message}); proceeding (fail-open for interactive)`);
    return { ok: true };
  }
}

async function doSpawn(opts: { slug: string | null; operatorBaseUrl: string }): Promise<void> {
  // Safety floor (admission waived, human-initiated) — refuse over-ceiling. The
  // GET ?action=spawn handler catches + dlogs this throw, so no terminal launches.
  const floor = await checkInteractiveSafetyFloor();
  if (!floor.ok) throw new Error(floor.reason);
  const envelope = await buildConsoleEnvelope({
    workspaceId: activeWorkspaceId(),
    slug: opts.slug,
    operatorBaseUrl: opts.operatorBaseUrl,
  });
  const mcpPath = join(envelope.cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
    if (!existsSync(bak)) renameSync(mcpPath, bak);
  }
  writeFileSync(mcpPath, envelope.mcpJsonContents);
  if (process.platform !== 'linux') throw new Error('linux-only spawn for now');
  const term = findLinuxTerminal();
  if (!term) throw new Error('no terminal emulator found');
  const oneliner = buildOneliner(envelope.cwd, envelope.env, envelope.greetingCmd, {
    mode: 'console',
    planSlug: null,
    label: null,
  });
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  const child = spawn(term.bin, childArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: envelope.cwd,
    env: { ...process.env, ...envelope.env },
  });
  child.unref();
  dlog(`doSpawn launched ${term.bin} pid=${child.pid}`);
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
  auth: 'public',
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
    const floorCheck = await checkInteractiveSafetyFloor();
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
      });
    } catch (e: any) {
      console.warn(`[console-launch] envelope build failed: ${e?.message}`);
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    try {
      const mcpPath = join(envelope.cwd, '.mcp.json');
      if (existsSync(mcpPath)) {
        const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
        if (!existsSync(bak)) renameSync(mcpPath, bak);
      }
      writeFileSync(mcpPath, envelope.mcpJsonContents);
    } catch (e: any) {
      console.warn(`[console-launch] write .mcp.json failed: ${e?.message}`);
      return jsonRes({ status: 'error', error: `write .mcp.json: ${e?.message}` }, 500);
    }

    if (process.platform !== 'linux') {
      return jsonRes(
        { status: 'error', error: 'server-side spawn only implemented for Linux; use the Tauri path on macOS/Windows' },
        501,
      );
    }
    const term = findLinuxTerminal();
    if (!term) {
      return jsonRes(
        { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm' },
        500,
      );
    }

    const oneliner = buildOneliner(envelope.cwd, envelope.env, envelope.greetingCmd, {
      mode: 'console',
      planSlug: body.planSlug ?? null,
      label: body.label ?? null,
    });
    const childArgs = [...term.args, 'bash', '-lc', oneliner];
    try {
      const child = spawn(term.bin, childArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: envelope.cwd,
        env: { ...process.env, ...envelope.env },
      });
      const sessionPromise = recordAdvSession({
        planSlug: body.planSlug ?? null,
        mode: 'console',
        terminalBin: term.bin,
        pid: child.pid ?? null,
        label: body.label ?? null,
        cwd: envelope.cwd,
      });
      attachExitWatcher(child, sessionPromise);
      child.unref();
      console.log(`[console-launch] spawned ${term.bin} pid=${child.pid} cwd=${envelope.cwd}`);
      return jsonRes({
        status: 'ok',
        pid: child.pid,
        terminal: term.bin,
      });
    } catch (e: any) {
      console.warn(`[console-launch] spawn ${term.bin} failed: ${e?.message}`);
      return jsonRes(
        { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` },
        500,
      );
    }
  },
});

export default [options, get, post];
