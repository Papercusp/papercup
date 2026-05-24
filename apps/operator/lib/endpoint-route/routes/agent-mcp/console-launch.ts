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
import { appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { buildConsoleEnvelope } from '@/lib/console-launcher';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';
import { recordAdvSession, markAdvSessionEnded, setAdvSessionPid } from '@/lib/adv-sessions';

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
  ['gnome-terminal', ['--window', '--']],
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

function findLinuxTerminal(): { bin: string; args: string[] } | null {
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    return { bin: fromEnv, args: ['-e'] };
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) return { bin, args: [...args] };
  }
  return null;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Emit the OSC escape sequences that recolor + retitle the terminal
 * window: foreground (OSC 10), background (OSC 11), window title
 * (OSC 0). User did this manually as
 *   echo -ne '\e]10;#000000\e\\' && printf '\033]11;#51febf\007'
 *     && printf '\033]0;RUNNERS\a'
 * — Batch D automates it per-session by hashing the plan slug into a
 * distinguishable background color. Foreground is black (#000000)
 * for readable contrast on the bright backgrounds we pick. Wrapping
 * in `printf` with literal escape bytes so the sequence reaches the
 * terminal before the spawned shell starts reading.
 */
interface AppearanceOpts {
  mode: 'omp' | 'console';
  planSlug: string | null;
  label: string | null;
}
function buildAppearancePrelude(opts: AppearanceOpts): string {
  const bg = hashSlugToColor(opts.planSlug, opts.mode);
  const fg = '#000000';
  const title = formatWindowTitle(opts);
  // Use printf with octal escape codes so the bytes reach the tty
  // verbatim regardless of the shell's echo dialect. OSC sequences:
  //   ESC ] 10 ; <fg> BEL    → foreground
  //   ESC ] 11 ; <bg> BEL    → background
  //   ESC ] 0  ; <title> BEL → window + tab title
  // \033 = ESC (octal 33), \007 = BEL.
  const titleEsc = title.replace(/'/g, "'\\''");
  return [
    `printf '\\033]10;${fg}\\007'`,
    `printf '\\033]11;${bg}\\007'`,
    `printf '\\033]0;${titleEsc}\\007'`,
  ].join(' && ');
}

/**
 * Deterministic slug → background color. Picks from a curated palette
 * of high-saturation, high-luminance hues so all options stay readable
 * against the black foreground. Returns a fixed neutral fallback when
 * planSlug is null (untagged session).
 */
function hashSlugToColor(planSlug: string | null, mode: 'omp' | 'console'): string {
  if (!planSlug) return mode === 'omp' ? '#51febf' : '#a8b3ff';
  const palette = [
    '#51febf', '#fcd34d', '#fda4af', '#86efac', '#7dd3fc',
    '#c4b5fd', '#fdba74', '#f0abfc', '#5eead4', '#fde68a',
    '#bef264', '#a5b4fc', '#fb7185', '#34d399', '#facc15',
  ];
  let h = 0;
  for (let i = 0; i < planSlug.length; i++) {
    h = ((h << 5) - h + planSlug.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length];
}

function formatWindowTitle(opts: AppearanceOpts): string {
  const tag = opts.mode === 'omp' ? 'OMP' : 'SH';
  const name = opts.label?.trim() || opts.planSlug;
  return name ? `${tag}: ${name}` : tag;
}

function buildOmpOneliner(
  cwd: string,
  env: Record<string, string>,
  launchCommand: string,
  appearance: AppearanceOpts,
): string {
  const envExports: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  return [
    buildAppearancePrelude(appearance),
    `cd ${shellEscape(cwd)}`,
    ...envExports,
    `exec ${launchCommand}`,
  ].join(' && ');
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

async function doSpawn(opts: { slug: string | null; operatorBaseUrl: string }): Promise<void> {
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
    let body: {
      slug?: string | null;
      mode?: 'shell' | 'omp';
      // plan-agent-launch P-023: when set, the new terminal resumes
      // an existing session (`<agent-cli> -r <sessionId>` in shell mode,
      // `omp-su -r <sessionId>` in OMP mode) instead of opening fresh.
      resumeSessionId?: string | null;
      // /adv plumbing: tag this session with the plan it was
      // launched from so /adv/sessions can group + display.
      planSlug?: string | null;
      label?: string | null;
      model?: string | null;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch { /* ignore — empty body is fine */ }

    const mode = body.mode === 'omp' ? 'omp' : 'shell';

    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: activeWorkspaceId(),
        slug: body.slug ?? null,
        operatorBaseUrl: new URL(req.url).origin,
        mode,
        resumeSessionId: body.resumeSessionId ?? undefined,
        ompModel: body.model?.trim() || undefined,
      });
    } catch (e: any) {
      console.warn(`[console-launch] envelope build failed: ${e?.message}`);
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    if (envelope.mode === 'omp') {
      if (process.platform !== 'linux') {
        return jsonRes(
          { status: 'error', error: 'server-side spawn only implemented for Linux' },
          501,
        );
      }
      if (!isOnPath('omp')) {
        return jsonRes(
          {
            status: 'error',
            code: 'omp_not_installed',
            error:
              '@oh-my-pi/cli not found on PATH. Install the OMP runtime with `npm i -g @oh-my-pi/cli`; the operator supplies the engineer playbook + coordination files for /adv launches.',
            installCmd: 'npm i -g @oh-my-pi/cli',
          },
          200,
        );
      }
      const term = findLinuxTerminal();
      if (!term) {
        return jsonRes(
          { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm' },
          500,
        );
      }
      const advSessionId = await recordAdvSession({
        planSlug: body.planSlug ?? null,
        mode: 'omp',
        terminalBin: term.bin,
        pid: null,
        label: body.label ?? null,
        cwd: envelope.cwd,
      });
      const ompEnv = {
        ...envelope.env,
        ...(advSessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(advSessionId) } : {}),
      };
      const ompOneliner = buildOmpOneliner(
        envelope.cwd,
        ompEnv,
        envelope.launchCommand ?? 'omp-su',
        { mode: 'omp', planSlug: body.planSlug ?? null, label: body.label ?? null },
      );
      try {
        const child = spawn(term.bin, [...term.args, 'bash', '-lc', ompOneliner], {
          detached: true,
          stdio: 'ignore',
          cwd: envelope.cwd,
          env: { ...process.env, ...ompEnv, ...(envelope.secretEnv ?? {}) },
        });
        if (advSessionId != null) {
          void setAdvSessionPid(advSessionId, child.pid ?? null);
        }
        attachExitWatcher(child, Promise.resolve(advSessionId));
        child.unref();
        console.log(`[console-launch] spawned omp agent ${term.bin} pid=${child.pid}`);
        return jsonRes({ status: 'ok', pid: child.pid, terminal: term.bin, mode: 'omp', advSessionId });
      } catch (e: any) {
        if (advSessionId != null) void markAdvSessionEnded(advSessionId, -1);
        console.warn(`[console-launch] omp spawn ${term.bin} failed: ${e?.message}`);
        return jsonRes(
          { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` },
          500,
        );
      }
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
