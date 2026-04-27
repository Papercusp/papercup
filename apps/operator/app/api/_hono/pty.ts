/**
 * /api/harness/:slug/pty/* — pseudo-terminal bridge for embedded TUI panes.
 *
 * Mounted under /api/harness/:slug/pty by the parent Hono app.
 *
 * Endpoints:
 *   POST /spawn               — start a pty subprocess (returns id)
 *   GET  /:id/stream          — SSE stream of stdout (events: data, exit)
 *   POST /:id/input           — write user keystrokes (base64 over JSON)
 *   POST /:id/resize          — resize cols/rows
 *   POST /:id/kill            — terminate the pty
 *
 * Wire format: bytes are base64 over JSON to keep the SSE stream uniform
 * regardless of encoding (xterm.js handles arbitrary byte streams; pi may
 * emit non-UTF-8 in edge cases like binary file contents).
 *
 * The body shape on /spawn is intentionally permissive — the caller chooses
 * the binary (`pi`/`omp`/`bash`/whatever) and args. We resolve the cwd
 * against the harness's project dir or a worktree.
 */
import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getLegacyClient,
  getFeatureLineage,
  formatLineageForPrompt,
} from '@restart/db-org';
import {
  killPty,
  markActive,
  resizePty,
  spawnPty,
  writePty,
  getPty,
  PtyError,
} from '../../../lib/pty-bridge';

/**
 * Attach pty endpoints to an existing Hono router (typically the harness
 * router mounted at /api/harness). We register handlers directly rather
 * than mounting a sub-router because Hono's `.route()` doesn't reliably
 * propagate path parameters across mount boundaries.
 */
export function registerPty(harness: Hono): void {

interface SpawnBody {
  /** Binary to launch. If absent, defaults to user-configured pi binary. */
  command?: string;
  /** Args to pass. */
  args?: readonly string[];
  /** Optional feature/lane id — scopes cwd to that worktree. */
  laneId?: string;
  /** Initial dims. */
  cols?: number;
  rows?: number;
  /** Optional extra env merged into the spawn. */
  env?: Record<string, string>;
}

/** Resolve the harness's project directory by reading its registry. */
function projectDirForSlug(slug: string): string | null {
  const registry = join(homedir(), '.restart-harness-projects.json');
  if (!existsSync(registry)) return null;
  try {
    const data = JSON.parse(readFileSync(registry, 'utf8'));
    const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
    const match = projects.find((p) => p.slug === slug);
    return match?.path ?? null;
  } catch {
    return null;
  }
}

/** Resolve the harness's state directory. */
function stateDirForSlug(slug: string): string | null {
  const projectDir = projectDirForSlug(slug);
  if (!projectDir) return null;
  return join(projectDir, '.harness');
}

/**
 * Build a markdown system-prompt fragment describing the feature pi is being
 * scoped to, and write it to the harness state dir so we can pass its path
 * via `--append-system-prompt`. Returns the file path on success, null if
 * the feature can't be resolved (caller falls back to no injection).
 */
async function buildFeaturePromptFile(
  slug: string,
  featureId: string,
  stateDir: string,
): Promise<string | null> {
  try {
    const c = getLegacyClient(slug);
    const feature = (await c
      .prepare('SELECT feature_id, title, summary, status FROM harness_features WHERE harness_slug = ? AND feature_id = ? LIMIT 1')
      .get(slug, featureId)) as { feature_id: string; title?: string; summary?: string; status?: string } | undefined;
    if (!feature) return null;

    let lineageBlock = '';
    try {
      const lineage = await getFeatureLineage(slug, featureId);
      const formatted = formatLineageForPrompt(lineage);
      if (formatted && formatted.trim().length > 0) {
        lineageBlock = `\n## Lineage\n\n${formatted.trim()}\n`;
      }
    } catch {}

    const lines = [
      `# Pi context — ${slug} / ${featureId}`,
      '',
      `You are running inside an isolated git worktree dedicated to **feature ${featureId}**.`,
      `The Papercusp harness expects you to make focused changes for THIS feature only,`,
      `then commit them in this worktree. The validator role will pick up your commits and`,
      `decide whether to merge.`,
      '',
      `## Feature: ${feature.title ?? featureId}`,
    ];
    if (feature.status) lines.push('', `Status: ${feature.status}`);
    if (feature.summary && feature.summary.trim().length > 0) {
      lines.push('', '## Spec', '', feature.summary.trim());
    }
    if (lineageBlock) lines.push(lineageBlock);

    const promptDir = join(stateDir, 'pi-prompts');
    mkdirSync(promptDir, { recursive: true });
    const path = join(promptDir, `${featureId}.md`);
    writeFileSync(path, lines.join('\n'), 'utf8');
    return path;
  } catch {
    return null;
  }
}

/**
 * Resolve the pi binary. Many launch contexts (mac homebrew + Tauri-Cocoa,
 * Linux desktop launchers) miss the user's login-shell PATH entries. Probe
 * the known locations on top of $PATH and fall back to the bare name.
 */
function resolvePiBinary(): string {
  const candidates = [
    process.env.PAPERCUSP_PI_BIN,
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    join(homedir(), '.cargo', 'bin', 'omp'),
    join(homedir(), '.local', 'bin', 'omp'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) if (existsSync(p)) return p;
  return 'omp';
}

  harness.post('/:slug/pty/spawn', async (c) => {
  const slug = c.req.param('slug') ?? '';
  let body: SpawnBody;
  try {
    body = (await c.req.json<SpawnBody>()) ?? {};
  } catch {
    body = {};
  }

  const command = body.command ?? resolvePiBinary();
  const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
  const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));

  const projectDir = projectDirForSlug(slug);
  if (!projectDir) {
    return c.json({ error: 'unknown harness slug', slug }, 404);
  }

  let cwd = projectDir;
  const sd = stateDirForSlug(slug);
  if (body.laneId) {
    if (sd) {
      const wt = join(sd, 'worktrees', body.laneId);
      if (existsSync(wt)) cwd = wt;
    }
  }

  // Default env additions: scope pi's session storage to the harness state
  // dir so per-harness sessions don't pollute ~/.omp/agent/.
  const defaultEnv: Record<string, string> = {};
  if (sd) {
    defaultEnv.PI_CODING_AGENT_DIR = join(sd, 'pi-sessions');
  }

  // Build args. If caller didn't pass an explicit args array, start from
  // the canonical defaults and append --append-system-prompt when we have
  // a feature scope. Caller-provided args override entirely.
  let args: readonly string[];
  if (body.args) {
    args = body.args;
  } else {
    const baseArgs: string[] = ['--no-pty'];
    if (body.laneId && sd && command.includes('omp')) {
      const promptPath = await buildFeaturePromptFile(slug, body.laneId, sd);
      if (promptPath) baseArgs.push(`--append-system-prompt=${promptPath}`);
    }
    args = baseArgs;
  }

  try {
    const handle = spawnPty({
      command,
      args,
      cwd,
      cols,
      rows,
      env: { ...defaultEnv, ...body.env },
    });
    return c.json({
      id: handle.id,
      command: handle.command,
      args: handle.args,
      cwd: handle.cwd,
      pid: handle.pty.pid,
    });
  } catch (err) {
    if (err instanceof PtyError) {
      return c.json({ error: err.message, code: err.code }, 503);
    }
    return c.json({ error: (err as Error).message, code: 'UNKNOWN' }, 500);
  }
});

  harness.get('/:slug/pty/:id/stream', (c) => {
  const id = c.req.param('id');
  const handle = getPty(id);
  if (!handle) {
    return c.json({ error: 'unknown pty id', id }, 404);
  }

  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    let cleanup: (() => void) | null = null;
    let closed = false;

    const onData = (chunk: Buffer) => {
      if (closed) return;
      s.write(`event: data\ndata: ${chunk.toString('base64')}\n\n`).catch(() => {
        closed = true;
        cleanup?.();
      });
    };
    const onExit = (code: number) => {
      if (closed) return;
      const payload = JSON.stringify({ code });
      s.write(`event: exit\ndata: ${payload}\n\n`).catch(() => {});
      closed = true;
    };

    handle.onData.add(onData);
    handle.onExit.add(onExit);
    cleanup = () => {
      handle.onData.delete(onData);
      handle.onExit.delete(onExit);
    };

    if (handle.killed) {
      onExit(handle.exitCode ?? 0);
      cleanup();
      return;
    }

    // Keep the SSE consumer counted as activity so the reaper spares this pty.
    const ticker = setInterval(() => {
      if (closed) return;
      markActive(id);
      // SSE comment ping — no event delivered to the client.
      s.write(': keepalive\n\n').catch(() => {
        closed = true;
        cleanup?.();
        clearInterval(ticker);
      });
    }, 15_000);

    s.onAbort(() => {
      closed = true;
      cleanup?.();
      clearInterval(ticker);
      // PTY is tied to one UI pane. Once the SSE consumer disconnects
      // (tab close, navigation away, network drop), the pty has no
      // reader and should die immediately — relying on the 5-min idle
      // reaper would orphan a pi process the user already abandoned.
      killPty(id);
    });

    // Block until exit or abort.
    while (!closed && !handle.killed) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(ticker);
    cleanup?.();
  });
});

  harness.post('/:slug/pty/:id/input', async (c) => {
  const id = c.req.param('id');
  let body: { data?: string };
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    body = {};
  }
  if (!body.data) return c.json({ error: 'missing data' }, 400);
  const ok = writePty(id, Buffer.from(body.data, 'base64'));
  if (!ok) return c.json({ error: 'unknown or killed pty' }, 404);
  return c.body(null, 204);
});

  harness.post('/:slug/pty/:id/resize', async (c) => {
  const id = c.req.param('id');
  let body: { cols?: number; rows?: number };
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    body = {};
  }
  const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
  const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));
  const ok = resizePty(id, cols, rows);
  if (!ok) return c.json({ error: 'unknown or killed pty' }, 404);
  return c.body(null, 204);
});

  harness.post('/:slug/pty/:id/kill', (c) => {
    const id = c.req.param('id');
    const ok = killPty(id);
    if (!ok) return c.json({ error: 'unknown pty' }, 404);
    return c.body(null, 204);
  });
}
