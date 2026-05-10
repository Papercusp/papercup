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
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  getPtyMeta,
  getHistory,
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
  /**
   * If provided, try to adopt this existing pty instead of spawning a
   * new one. Used by PiPanel on remount (tab-switch resume) to keep
   * session state alive across React unmount/mount cycles. Falls
   * through to prewarm/cold-spawn if the id is unknown or its handle
   * has been killed.
   */
  resumePtyId?: string;
}

/** Resolve the harness's project directory by reading its registry. */
async function projectDirForSlug(slug: string): Promise<string | null> {
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

/** Resolve the harness's state directory. */
async function stateDirForSlug(slug: string): Promise<string | null> {
  const projectDir = await projectDirForSlug(slug);
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

    // Write to a ramTmpRoot dir (Linux: /dev/shm tmpfs; macOS+Windows:
    // os.tmpdir() page-cache-backed). omp reads --append-system-prompt
    // once at startup, so we schedule a cleanup ~30s later to keep
    // /tmp clean. The harness directory stays pure-code.
    const ramRoot = (process.platform === 'linux' && existsSync('/dev/shm'))
      ? '/dev/shm'
      : tmpdir();
    const tmpDir = mkdtempSync(join(ramRoot, 'papercusp-pty-'));
    const path = join(tmpDir, `${featureId}.md`);
    writeFileSync(path, lines.join('\n'), 'utf8');
    setTimeout(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* GC */ }
    }, 30_000).unref();
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
/**
 * Resolve the agent terminal binary. Respects the user's /settings/agent
 * toggle: when AGENT_BACKEND === 'claude-code' (or AGENT_CMD points at
 * claude), launch the claude CLI; otherwise launch omp/pi-coding-agent.
 *
 * Many launch contexts (mac homebrew + Tauri-Cocoa, Linux desktop
 * launchers) miss the user's login-shell PATH entries — probe known
 * locations on top of $PATH and fall back to the bare name.
 */
function resolveAgentTerminalBinary(): string {
  const cmdEnv = (process.env.AGENT_CMD ?? '').trim();
  if (cmdEnv) {
    const first = cmdEnv.split(/\s+/)[0];
    if (first) return first;
  }
  const backend = (process.env.AGENT_BACKEND ?? '').trim().toLowerCase();
  const wantClaude = backend === 'claude-code' || backend === 'claude';
  if (wantClaude) {
    const candidates = [
      process.env.PAPERCUSP_CLAUDE_BIN,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.claude', 'local', 'claude'),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const p of candidates) if (existsSync(p)) return p;
    return 'claude';
  }
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

// Back-compat alias: existing callers used resolvePiBinary; keep the
// name working but route through the backend-aware resolver above.
function resolvePiBinary(): string {
  return resolveAgentTerminalBinary();
}

// Legacy: registered the deprecated `@restart/papercusp-mcp-server` (7
// read-only tools) as a stdio entry in `~/.omp/agent/mcp.json`. That
// package was deleted 2026-05-09; the agent-mcp HTTP/SSE transport at
// `/api/[transport]/route.ts` is the canonical surface and exposes 27
// tools versus the legacy 7. omp clients should be configured against
// the HTTP endpoint, not stdio — kept as a no-op shim only because
// the call site in pty spawn flow is best-effort.
function ensurePapercuspMcpRegistered(): void {
  // Intentionally empty. If a future client needs auto-registration of
  // the agent-mcp HTTP endpoint, do it here — but the current pattern
  // is to surface the URL in operator UI / docs and let users configure
  // it themselves.
  return;
}

  /**
   * Prewarm pool. Keyed by `<slug>|<laneId>|<command>` so a /pty/prewarm
   * call from PiTerminalsDock.onMount reserves a pty whose env/cwd/args
   * exactly match what /pty/spawn would build for the same dock. Spawn
   * adopts the warm handle instead of forking fresh, eliminating the
   * ~500–1500 ms omp startup from the user-visible critical path.
   *
   * The slot stores a Promise<handle | null>, not a handle, so /spawn can
   * await an in-flight prewarm. Without this, spawn races prewarm: dock
   * mount fires both POSTs nearly simultaneously, prewarm's spawnPty()
   * returns synchronously but the slot wasn't visible to spawn yet,
   * spawn cold-forks, and the warm handle becomes an orphan.
   *
   * If a prewarmed handle isn't claimed within PREWARM_TTL_MS we kill
   * it from a one-shot timer so we don't accumulate orphans on tab
   * navigations away from the dock.
   */
  type PrewarmEntry = {
    promise: Promise<ReturnType<typeof spawnPty> | null>;
    reaper: NodeJS.Timeout | null;
  };
  const prewarmed = new Map<string, PrewarmEntry>();
  const PREWARM_TTL_MS = 60_000;

  function prewarmKey(slug: string, laneId: string | undefined, command: string): string {
    return `${slug}|${laneId ?? ''}|${command}`;
  }

  /**
   * Internal: reserve a prewarm slot and spawn a pty into it. Shared by
   * the /pty/prewarm endpoint and the /pty/spawn refill path. Idempotent
   * — if a slot is already reserved (warm or in-flight), we leave it.
   *
   * CRITICAL: the slot is registered in `prewarmed` SYNCHRONOUSLY before
   * any async work or fork. The actual cfg-build + spawnPty fork runs
   * out-of-band on setImmediate; the entry's promise resolves once that
   * lands. This is what makes prewarm race-safe: a /pty/spawn POST that
   * arrives milliseconds after /pty/prewarm sees the slot immediately
   * and awaits the eventual handle, instead of cold-forking past it.
   *
   * The `command` argument is REQUIRED — callers compute it synchronously
   * (body.command ?? resolvePiBinary()) so the slot key matches what
   * /pty/spawn computes synchronously without buildSpawnConfig.
   */
  function reservePrewarmSlot(opts: {
    slug: string;
    laneId: string | undefined;
    command: string;
    /** Async builder run AFTER the slot is registered. Returns 'unknown-slug' on bad input. */
    buildCfg: () => Promise<
      | { kind: 'ok'; command: string; args: readonly string[]; cwd: string; env: Record<string, string>; sd: string | null }
      | { kind: 'unknown-slug' }
    >;
  }): PrewarmEntry {
    const { slug, laneId, command, buildCfg } = opts;
    const key = prewarmKey(slug, laneId, command);
    const existing = prewarmed.get(key);
    if (existing) return existing;

    let resolveHandle: (h: ReturnType<typeof spawnPty> | null) => void = () => {};
    const entry: PrewarmEntry = {
      promise: new Promise<ReturnType<typeof spawnPty> | null>((r) => { resolveHandle = r; }),
      reaper: null,
    };
    // Register the slot SYNCHRONOUSLY so a concurrent /pty/spawn sees it.
    prewarmed.set(key, entry);

    setImmediate(async () => {
      try {
        const cfg = await buildCfg();
        if (cfg.kind === 'unknown-slug') {
          if (prewarmed.get(key) === entry) prewarmed.delete(key);
          resolveHandle(null);
          return;
        }
        const handle = spawnPty({
          command: cfg.command,
          args: cfg.args,
          cwd: cfg.cwd,
          cols: 80,
          rows: 24,
          env: cfg.env,
        });
        attachAuditExport(handle, cfg.sd, cfg.command, laneId);
        entry.reaper = setTimeout(() => {
          if (prewarmed.get(key) === entry) prewarmed.delete(key);
          try { killPty(handle.id); } catch { /* ignore */ }
        }, PREWARM_TTL_MS);
        entry.reaper.unref?.();

        // Don't mark the slot adoptable until omp has finished its init.
        //
        // Naively resolving with the handle right after spawnPty made warm
        // adoption feel cold: omp spends ~1.2s connecting to its MCP
        // servers and emits visible chatter ("Connecting to MCP servers:
        // voice-mode, hindsight, plur, …") before clearing the screen and
        // showing its welcome banner. When the client adopted a freshly-
        // forked warm pty, the byte history replayed into xterm started
        // with that connection log — the user perceived it as "starting
        // pi for several seconds" and reported warming as broken.
        //
        // Hold the slot for PREWARM_BOOT_MS before marking it adoptable.
        // 1500 ms is comfortably past omp's measured cold-boot time
        // (~1.2 s on this box: 265 ms `omp --version` + ~1 s MCP server
        // connection). After that, the pty's history buffer contains the
        // full welcome banner *plus* the post-init clear-screen sequence,
        // so the SSE/WS replay into the client's xterm scrubs the boot
        // chatter and the user sees a ready prompt immediately.
        //
        // We tried data-driven detection (clear-screen sequence + byte
        // threshold) but the pty.onData fan-out wasn't reliably hitting
        // the prewarm subscriber inside the bundled chunk — the slot was
        // always falling through to the time fallback anyway. A fixed
        // wait is simpler, deterministic, and within budget.
        const PREWARM_BOOT_MS = 1500;
        let resolved = false;
        const ready = () => {
          if (resolved) return;
          resolved = true;
          resolveHandle(handle);
        };
        const bootTimer = setTimeout(ready, PREWARM_BOOT_MS);
        bootTimer.unref?.();
        // If the pty exits during boot (omp crash, missing binary), make
        // sure we still resolve so /pty/spawn doesn't hang. The handle
        // will be `killed` so the adopt branch falls through to cold-fork.
        handle.onExit.add(() => {
          clearTimeout(bootTimer);
          ready();
        });
      } catch {
        if (prewarmed.get(key) === entry) prewarmed.delete(key);
        resolveHandle(null);
      }
    });

    return entry;
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

    const projectDir = await projectDirForSlug(slug);
    if (!projectDir) return { kind: 'unknown-slug' };

    let cwd = projectDir;
    const sd = await stateDirForSlug(slug);
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
    } else if (command.includes('omp')) {
      const baseArgs: string[] = ['--no-pty'];
      if (piExtensionAvailable) {
        baseArgs.push('-e', piExtensionPath);
      }
      if (body.laneId && sd) {
        const promptPath = await buildFeaturePromptFile(slug, body.laneId, sd);
        if (promptPath) baseArgs.push(`--append-system-prompt=${promptPath}`);
      }
      args = baseArgs;
    } else {
      // claude (or other): launch interactive REPL with no flags. omp's
      // --no-pty / -e extension / --append-system-prompt are all
      // backend-specific and do not apply here.
      args = [];
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

  // Resume path: if the client passed a previously-issued pty id and that
  // handle is still alive, adopt it. This is the fast path for PiPanel
  // remounts (tab-switch resume) — no spawn, no prewarm, just hand the
  // same pty back so the new SSE consumer can replay history into the
  // fresh xterm.
  if (body.resumePtyId) {
    const existing = getPtyMeta(body.resumePtyId);
    if (existing) {
      try { resizePty(body.resumePtyId, cols, rows); } catch { /* ignore */ }
      return c.json({ ...existing, resumed: true });
    }
    // Stale id — fall through to a normal spawn flow.
  }

  // Compute the prewarm key synchronously so we can adopt an in-flight
  // prewarm slot WITHOUT awaiting buildSpawnConfig. Without this,
  // /pty/spawn and /pty/prewarm race through their respective awaits and
  // /spawn frequently checks `prewarmed` before /prewarm has registered
  // its slot — every fresh terminal then cold-forks omp, defeating the
  // prewarm pool entirely.
  const command = body.command ?? resolvePiBinary();
  const key = prewarmKey(slug, body.laneId, command);
  const reserved = prewarmed.get(key);
  const refill = () => {
    setImmediate(() => {
      try {
        reservePrewarmSlot({
          slug,
          laneId: body.laneId,
          command,
          buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: c.req.url }),
        });
      } catch { /* best-effort */ }
    });
  };

  if (reserved) {
    const handle = await reserved.promise;
    if (prewarmed.get(key) === reserved) prewarmed.delete(key);
    if (reserved.reaper) clearTimeout(reserved.reaper);
    if (handle && !handle.killed) {
      try { handle.pty.resize(cols, rows); } catch { /* ignore */ }
      refill();
      return c.json({
        id: handle.id,
        command: handle.command,
        args: handle.args,
        cwd: handle.cwd,
        pid: handle.pty.pid,
        prewarmed: true,
      });
    }
    // prewarm failed (cap reached, spawn error) or its handle already died
    // — fall through to a normal cold spawn.
  }

  // No (or dead) prewarm slot — pay the full config-build + fork cost now.
  const cfg = await buildSpawnConfig({ slug, body, requestUrl: c.req.url });
  if (cfg.kind === 'unknown-slug') {
    return c.json({ error: 'unknown harness slug', slug }, 404);
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
    refill();
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
   * Resolve-only: return the spawn config (command, args, cwd, env)
   * that /pty/spawn WOULD have used, without actually forking. Used by
   * the desktop (Tauri) renderer to forward those args to its native
   * pty-host (src-tauri/src/pty.rs) — pty fork lives in the Rust
   * process, but the harness-aware config-building (prompt prepending,
   * worktree resolution, MCP wiring) stays here on the operator side.
   */
  harness.post('/:slug/pty/resolve', async (c) => {
    const slug = c.req.param('slug') ?? '';
    let body: SpawnBody;
    try { body = (await c.req.json<SpawnBody>()) ?? {}; } catch { body = {}; }
    const cfg = await buildSpawnConfig({ slug, body, requestUrl: c.req.url });
    if (cfg.kind === 'unknown-slug') {
      return c.json({ error: 'unknown harness slug', slug }, 404);
    }
    return c.json({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      env: cfg.env,
    });
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

    // Compute the slot key synchronously and reserve immediately, BEFORE
    // any await — the actual omp fork happens out-of-band on setImmediate
    // (see reservePrewarmSlot). This way a /pty/spawn POST arriving
    // microseconds later finds the slot and adopts it.
    const command = body.command ?? resolvePiBinary();
    const key = prewarmKey(slug, body.laneId, command);
    const existing = prewarmed.get(key);
    if (existing) {
      const handle = await existing.promise.catch(() => null);
      if (handle && !handle.killed) return c.json({ reserved: true, reused: true });
      if (existing.reaper) clearTimeout(existing.reaper);
      if (prewarmed.get(key) === existing) prewarmed.delete(key);
    }

    const entry = reservePrewarmSlot({
      slug,
      laneId: body.laneId,
      command,
      buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: c.req.url }),
    });
    const handle = await entry.promise;
    if (!handle) {
      // buildCfg returned unknown-slug or spawnPty threw. The slot was
      // already removed from `prewarmed` by reservePrewarmSlot's error
      // path; surface to caller.
      return c.json({ error: 'prewarm spawn failed' }, 503);
    }
    return c.json({ reserved: true });
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

    // Replay full session history into the new subscriber. Non-empty for
    // prewarmed handles AND for tab-switch remounts where the same pty
    // had output that earlier consumers already saw — the new xterm
    // starts blank and needs the whole history to re-render the prior
    // state.
    const history = getHistory(id);
    if (history && history.length > 0) {
      try { onData(history); } catch { /* see onData */ }
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
      // Don't kill the pty on SSE disconnect — PiPanel unmounts on
      // every dashboard tab switch, and killing here would force a
      // full respawn (and full omp restart) when the user comes back.
      // The handle keeps writing to its history buffer; the next
      // /stream connection replays it. Idle reaper still cleans up
      // truly-abandoned ptys after IDLE_TIMEOUT_MS.
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

  harness.get('/:slug/pi-sessions/audit', async (c) => {
    const slug = c.req.param('slug') ?? '';
    const sd = await stateDirForSlug(slug);
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

  harness.get('/:slug/pi-sessions/audit/:filename', async (c) => {
    const slug = c.req.param('slug') ?? '';
    const filename = c.req.param('filename');
    // Defense in depth: filename must be a simple HTML basename, no path traversal.
    if (!/^[\w.-]+\.html$/.test(filename)) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const sd = await stateDirForSlug(slug);
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
