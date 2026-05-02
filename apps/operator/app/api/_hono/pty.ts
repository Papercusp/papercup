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
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
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
  consumeReplay,
  PtyError,
} from '../../../lib/pty-bridge';

import { papercuspPath } from '@/lib/papercusp-root';
import { loadHarnessRegistry } from '@/lib/harness-registry';
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
  return loadHarnessRegistry().projects.find((p) => p.slug === slug)?.path ?? null;
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

    // TODO: getFeatureLineage signature changed to (sql, schemaName, slug, featureId);
    // skip lineage block until callers wire those through. The block was best-effort so
    // omitting it doesn't break Pi context — it just loses the "## Lineage" section.
    let lineageBlock = '';
    void getFeatureLineage; void formatLineageForPrompt;

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
 * Find pi/omp session jsonl files created within `windowMs` ms of the
 * pty's startup. With `PI_CODING_AGENT_DIR=<stateDir>/pi-sessions/`,
 * omp organizes sessions as:
 *
 *   <agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 *
 * encoded-cwd replaces `/` with `-`. Multiple ptys can share an agent
 * dir, so we filter by mtime to pick only files that almost certainly
 * belong to the pty that just exited.
 */
function findRecentSessionFiles(
  agentDir: string,
  startedAtMs: number,
  windowMs: number,
): string[] {
  const sessionsRoot = join(agentDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  // Walk one level deep — workspace dirs.
  let workspaces: string[];
  try { workspaces = readdirSync(sessionsRoot); } catch { return []; }
  for (const ws of workspaces) {
    const wsDir = join(sessionsRoot, ws);
    let entries: string[];
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const full = join(wsDir, e);
      try {
        const st = statSync(full);
        // mtime > startedAtMs - 5s slack (in case of clock drift)
        if (st.mtimeMs >= startedAtMs - 5_000) out.push(full);
      } catch { /* file vanished */ }
    }
  }
  return out;
}

/**
 * Best-effort: export pi/omp sessions created during this pty's lifetime
 * to HTML under `<stateDir>/audit/pi-sessions/`. Runs `omp --export` per
 * session file with cwd set to the audit dir (omp writes a file named
 * `omp-session-<id>.html` in cwd). After the child exits, rename to our
 * preferred `<tagPrefix>-<stem>.html` shape so the audit dir doesn't
 * collide across multiple pty lifetimes for the same feature.
 *
 * All errors are swallowed — this is non-blocking polish, not a failure
 * path.
 */
function exportPiSessions(opts: {
  agentDir: string;
  auditDir: string;
  startedAtMs: number;
  ompBin: string;
  tagPrefix: string;
}): void {
  const { agentDir, auditDir, startedAtMs, ompBin, tagPrefix } = opts;
  // Run async; caller doesn't await.
  setImmediate(() => {
    const files = findRecentSessionFiles(agentDir, startedAtMs, 24 * 60 * 60 * 1000);
    if (files.length === 0) return;
    try { mkdirSync(auditDir, { recursive: true }); } catch { return; }
    for (const sessionFile of files) {
      const stem = basename(sessionFile, '.jsonl');
      const desiredPath = join(auditDir, `${tagPrefix}-${stem}.html`);
      // omp's default output filename is omp-session-<stem>.html in cwd.
      const ompDefaultName = `omp-session-${stem}.html`;
      const ompDefaultPath = join(auditDir, ompDefaultName);
      const child = spawnChild(ompBin, ['--export', sessionFile], {
        cwd: auditDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => {});
      child.on('exit', (code) => {
        if (code !== 0) return;
        // Rename to our naming scheme. If the rename target already
        // exists, just leave both — re-running is idempotent.
        try {
          if (existsSync(ompDefaultPath) && !existsSync(desiredPath)) {
            renameSync(ompDefaultPath, desiredPath);
          }
        } catch { /* keep omp's default name; not a failure */ }
      });
    }
  });
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

// Ensure ~/.omp/agent/mcp.json has the `papercusp` server entry pointing at
// the bundled MCP server. Idempotent: only writes if missing or stale.
function ensurePapercuspMcpRegistered(): void {
  const mcpPath = join(homedir(), '.omp', 'agent', 'mcp.json');
  // Find the bundled MCP server. Production: bundled into the sidecar at
  // <sidecar>/papercusp-mcp-server/bin/papercusp-mcp-server.mjs. Dev: at
  // <repo>/packages/papercusp-mcp-server/bin/papercusp-mcp-server.mjs.
  const bundledCandidates = [
    process.env.PAPERCUSP_MCP_SERVER,
    // Production bundle (Tauri sidecar): co-located inside the sidecar dir.
    join(process.cwd(), 'papercusp-mcp-server', 'bin', 'papercusp-mcp-server.mjs'),
    // Dev: papercupai/papercup workspace at apps/operator → walk up to repo
    // root, then sibling submodule papercusp/packages/.
    join(process.cwd(), '..', '..', '..', '..', 'papercusp', 'packages', 'papercusp-mcp-server', 'bin', 'papercusp-mcp-server.mjs'),
    // Direct local clones side-by-side (e.g. /home/<user>/papercupai-workspace/).
    join(homedir(), 'papercupai-workspace', 'papercusp', 'packages', 'papercusp-mcp-server', 'bin', 'papercusp-mcp-server.mjs'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  let serverBin: string | null = null;
  for (const p of bundledCandidates) {
    if (existsSync(p)) { serverBin = p; break; }
  }
  if (!serverBin) return; // Server not bundled — skip silently.

  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try { cfg = JSON.parse(readFileSync(mcpPath, 'utf-8')); } catch { return; }
  } else {
    mkdirSync(join(homedir(), '.omp', 'agent'), { recursive: true });
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  const existing = cfg.mcpServers.papercusp as { command?: string; args?: string[] } | undefined;
  const desired = { type: 'stdio', command: 'node', args: [serverBin] };
  if (existing && existing.command === 'node' && existing.args?.[0] === serverBin) return; // Already correct.
  cfg.mcpServers.papercusp = desired;
  writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
}

  /**
   * Prewarm pool. Keyed by `<slug>|<laneId>|<command>` so a /pty/prewarm
   * call from PiTerminalsDock.onReady reserves a pty whose env/cwd/args
   * exactly match what /pty/spawn would build for the same dock. Spawn
   * then adopts the warm handle instead of forking fresh, eliminating
   * the ~500–1500 ms omp startup from the user-visible critical path.
   *
   * If a prewarmed handle isn't claimed within PREWARM_TTL_MS we kill
   * it from a one-shot timer so we don't accumulate orphans on tab
   * navigations away from the dock.
   */
  const prewarmed = new Map<string, { handle: Awaited<ReturnType<typeof spawnPty>>; reaper: NodeJS.Timeout }>();
  const PREWARM_TTL_MS = 60_000;

  function prewarmKey(slug: string, laneId: string | undefined, command: string): string {
    return `${slug}|${laneId ?? ''}|${command}`;
  }

  /**
   * Build the spawn config (cwd, args, env) for a given slug/laneId.
   * Shared between /pty/spawn and /pty/prewarm so prewarmed handles
   * match exactly what spawn would have built.
   */
  async function buildSpawnConfig(opts: {
    slug: string;
    body: SpawnBody;
    requestUrl: string;
  }): Promise<{ kind: 'ok'; command: string; args: readonly string[]; cwd: string; env: Record<string, string>; sd: string | null } | { kind: 'unknown-slug' }> {
    const { slug, body, requestUrl } = opts;
    const command = body.command ?? resolvePiBinary();

    const projectDir = projectDirForSlug(slug);
    if (!projectDir) return { kind: 'unknown-slug' };

    let cwd = projectDir;
    const sd = stateDirForSlug(slug);
    if (body.laneId && sd) {
      const wt = join(sd, 'worktrees', body.laneId);
      if (existsSync(wt)) cwd = wt;
    }

    const env: Record<string, string> = {};
    if (sd) env.PI_CODING_AGENT_DIR = join(sd, 'pi-sessions');
    env.PAPERCUSP_HARNESS_SLUG = slug;
    try {
      const u = new URL(requestUrl);
      env.PAPERCUSP_API_BASE = `${u.protocol}//${u.host}`;
    } catch { /* non-URL request */ }

    const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
    const piExtensionAvailable = existsSync(piExtensionPath);

    if (command.includes('omp')) {
      try { ensurePapercuspMcpRegistered(); } catch { /* best-effort */ }
    }

    let args: readonly string[];
    if (body.args) {
      args = body.args;
    } else {
      const baseArgs: string[] = ['--no-pty'];
      if (command.includes('omp') && piExtensionAvailable) {
        baseArgs.push('-e', piExtensionPath);
      }
      if (body.laneId && sd && command.includes('omp')) {
        const promptPath = await buildFeaturePromptFile(slug, body.laneId, sd);
        if (promptPath) baseArgs.push(`--append-system-prompt=${promptPath}`);
      }
      args = baseArgs;
    }

    return { kind: 'ok', command, args, cwd, env: { ...env, ...body.env }, sd };
  }

  function attachAuditExport(handle: ReturnType<typeof spawnPty>, sd: string | null, command: string, laneId?: string): void {
    if (!sd || !command.includes('omp')) return;
    const agentDir = join(sd, 'pi-sessions');
    const auditDir = join(sd, 'audit', 'pi-sessions');
    const tagPrefix = laneId ?? `pid${handle.pty.pid}`;
    const startedAtMs = handle.startedAtMs;
    handle.onExit.add(() => {
      exportPiSessions({ agentDir, auditDir, startedAtMs, ompBin: command, tagPrefix });
    });
  }

  harness.post('/:slug/pty/spawn', async (c) => {
  const slug = c.req.param('slug') ?? '';
  let body: SpawnBody;
  try {
    body = (await c.req.json<SpawnBody>()) ?? {};
  } catch {
    body = {};
  }

  const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
  const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));

  const cfg = await buildSpawnConfig({ slug, body, requestUrl: c.req.url });
  if (cfg.kind === 'unknown-slug') {
    return c.json({ error: 'unknown harness slug', slug }, 404);
  }

  // Try to adopt a prewarmed handle for this slug+laneId+command. The
  // prewarm path uses the same buildSpawnConfig output, so cwd/args/env
  // already match. Resize the pty to the caller's dims before handing it
  // off — the prewarmed shell was started at default 80x24.
  const key = prewarmKey(slug, body.laneId, cfg.command);
  const reserved = prewarmed.get(key);
  if (reserved && !reserved.handle.killed) {
    prewarmed.delete(key);
    clearTimeout(reserved.reaper);
    try { reserved.handle.pty.resize(cols, rows); } catch { /* ignore */ }
    return c.json({
      id: reserved.handle.id,
      command: reserved.handle.command,
      args: reserved.handle.args,
      cwd: reserved.handle.cwd,
      pid: reserved.handle.pty.pid,
      prewarmed: true,
    });
  }

  try {
    const handle = spawnPty({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      cols,
      rows,
      env: cfg.env,
    });
    attachAuditExport(handle, cfg.sd, cfg.command, body.laneId);
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

  /**
   * Reserve a hot pty for an upcoming /pty/spawn call. The dock fires this
   * on mount so omp's startup overlaps with xterm.js initialization in the
   * browser. No-op (200) if a handle is already reserved for this key, so
   * the dock can call it idempotently on every render.
   */
  harness.post('/:slug/pty/prewarm', async (c) => {
    const slug = c.req.param('slug') ?? '';
    let body: SpawnBody;
    try { body = (await c.req.json<SpawnBody>()) ?? {}; } catch { body = {}; }

    const cfg = await buildSpawnConfig({ slug, body, requestUrl: c.req.url });
    if (cfg.kind === 'unknown-slug') {
      return c.json({ error: 'unknown harness slug', slug }, 404);
    }

    const key = prewarmKey(slug, body.laneId, cfg.command);
    const existing = prewarmed.get(key);
    if (existing && !existing.handle.killed) {
      return c.json({ reserved: true, reused: true });
    }
    if (existing) {
      // Stale entry from a prior killed handle — drop and re-spawn.
      clearTimeout(existing.reaper);
      prewarmed.delete(key);
    }

    try {
      const handle = spawnPty({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        cols: 80,
        rows: 24,
        env: cfg.env,
      });
      attachAuditExport(handle, cfg.sd, cfg.command, body.laneId);
      const reaper = setTimeout(() => {
        // Caller never claimed this handle — kill so it doesn't hold a
        // pty slot. spawnPty's own idle reaper would eventually catch
        // this too, but at 5min that's too lax for a pre-warm.
        if (prewarmed.get(key)?.handle === handle) prewarmed.delete(key);
        try { handle.pty.kill(); } catch { /* ignore */ }
      }, PREWARM_TTL_MS);
      reaper.unref?.();
      prewarmed.set(key, { handle, reaper });
      return c.json({ reserved: true });
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

    // Drain anything emitted before this subscriber attached (only
    // non-empty for prewarmed handles where omp printed its banner
    // while the browser was still loading xterm).
    const replay = consumeReplay(id);
    if (replay && replay.length > 0) {
      try { onData(replay); } catch { /* see onData */ }
    }

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

  // ── Audit sessions (pi-export HTML) ─────────────────────────────────
  // The pty's onExit handler async-exports any pi/omp session jsonls
  // created during the pane's lifetime to <stateDir>/audit/pi-sessions/.
  // These endpoints surface those HTML files to the UI so users can
  // browse past pi conversations from the harness dashboard.

  harness.get('/:slug/pi-sessions/audit', (c) => {
    const slug = c.req.param('slug') ?? '';
    const sd = stateDirForSlug(slug);
    if (!sd) return c.json({ error: 'unknown harness slug', slug }, 404);
    const auditDir = join(sd, 'audit', 'pi-sessions');
    if (!existsSync(auditDir)) return c.json({ sessions: [] });

    let entries: string[];
    try { entries = readdirSync(auditDir); } catch { return c.json({ sessions: [] }); }

    const sessions = entries
      .filter((e) => e.endsWith('.html'))
      .map((e) => {
        const full = join(auditDir, e);
        try {
          const st = statSync(full);
          // Filename shape: <tag>-<timestamp>_<id>.html
          // Try to surface the tag (laneId / pid) and a friendly date.
          const stem = e.slice(0, -'.html'.length);
          const m = stem.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/);
          return {
            filename: e,
            tag: m?.[1] ?? null,
            timestamp: m?.[2] ?? null,
            sessionId: m?.[3] ?? null,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          };
        } catch {
          return { filename: e };
        }
      })
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    return c.json({ sessions });
  });

  harness.get('/:slug/pi-sessions/audit/:filename', (c) => {
    const slug = c.req.param('slug') ?? '';
    const filename = c.req.param('filename');
    // Defense in depth: filename must be a simple HTML basename, no path traversal.
    if (!/^[\w.-]+\.html$/.test(filename)) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const sd = stateDirForSlug(slug);
    if (!sd) return c.json({ error: 'unknown harness slug', slug }, 404);
    const full = join(sd, 'audit', 'pi-sessions', filename);
    if (!existsSync(full)) return c.json({ error: 'not found' }, 404);

    let html: Buffer;
    try { html = readFileSync(full); } catch { return c.json({ error: 'read failed' }, 500); }
    c.header('Content-Type', 'text/html; charset=utf-8');
    // Audit HTML is self-contained (omp embeds CSS); allow inline.
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(html as unknown as ArrayBuffer);
  });

  // ── Pi extension tool surface ──────────────────────────────────────
  // Returns the static list of papercusp_* tools that the bundled pi
  // extension registers. Lets the PiPanel UI show users which tools are
  // available without invoking pi or asking the LLM. Source-of-truth
  // is the extension file at ~/.papercusp/global-plugins/pi/extension.ts.

  harness.get('/:slug/pty/tools', (c) => {
    const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
    const available = existsSync(piExtensionPath);
    if (!available) return c.json({ extensionAvailable: false, tools: [] });

    // Hard-coded list — keeping in sync with extension.ts. If we add a
    // tool there, add it here too. Cheaper than parsing the .ts file
    // at runtime.
    return c.json({
      extensionAvailable: true,
      extensionPath: piExtensionPath,
      tools: [
        { name: 'papercusp_status', label: 'Harness Status', description: 'Mission state, iteration, last decision, cost.' },
        { name: 'papercusp_list_features', label: 'List Features', description: 'List features, optionally filtered by status.' },
        { name: 'papercusp_lineage', label: 'Feature Lineage', description: "Walk a feature's parent_id chain to root goal." },
        { name: 'papercusp_audit', label: 'Feature Audit Log', description: 'Audit log for a specific feature.' },
        { name: 'papercusp_proposals', label: 'Pending Proposals', description: 'Proposals from the scoper role.' },
        { name: 'papercusp_decisions', label: 'Recent Decisions', description: 'Recent orchestrator decisions.' },
        { name: 'papercusp_issues', label: 'Open Issues', description: 'Open issues for the harness.' },
      ],
    });
  });
}
