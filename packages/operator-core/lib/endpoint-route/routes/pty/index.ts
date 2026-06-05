/**
 * /api/harness/:slug/pty/* + /pi-sessions/audit/* — pseudo-terminal
 * bridge for embedded TUI panes. Phase A2 (endpoint-hono-elimination-
 * 2026-05-21). Ported off `_hono/pty.ts` (mounted via `registerPty`).
 * URLs unchanged.
 *
 *   POST /api/harness/:slug/pty/spawn
 *   POST /api/harness/:slug/pty/resolve
 *   POST /api/harness/:slug/pty/prewarm
 *   GET  /api/harness/:slug/pty/:id/stream         (SSE — events: data, exit)
 *   POST /api/harness/:slug/pty/:id/input
 *   POST /api/harness/:slug/pty/:id/resize
 *   POST /api/harness/:slug/pty/:id/kill
 *   GET  /api/harness/:slug/pi-sessions/audit
 *   GET  /api/harness/:slug/pi-sessions/audit/:filename
 *   GET  /api/harness/:slug/pty/tools
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 * No WebSocket here: terminal output streams over SSE, input over POST.
 * The prewarm pool (previously a closure inside `registerPty`) is now
 * module-level state — same one-instance-per-process lifetime.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { sseResponse } from '@papercusp/sse';
import {
  killPty, markActive, resizePty, spawnPty, writePty, getPty, getPtyMeta, getHistory, PtyError,
} from '../../../pty-bridge';
import { papercuspPath } from '../../../papercusp-root';
import { resolveProjectDir, resolveStateDir, resolveSpawnCwd, resolveContextEnv } from '../../../spawn-config';
import { buildKickoffPromptFile } from '../../../agent-kickoff/prompt-file';
import { defineTool } from '@papercusp/agent-mcp';

interface SpawnBody {
  command?: string;
  args?: readonly string[];
  laneId?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  resumePtyId?: string;
}

const stateDirForSlug = resolveStateDir;

/**
 * Build a markdown system-prompt fragment describing the feature pi is
 * scoped to. Thin wrapper around the shared kickoff factory.
 */
async function buildFeaturePromptFile(
  slug: string,
  featureId: string,
  _stateDir: string,
): Promise<string | null> {
  return buildKickoffPromptFile({ kind: 'feature', harnessSlug: slug, featureId });
}

/** pi/omp session jsonls created within `windowMs` of the pty's startup. */
function findRecentSessionFiles(agentDir: string, startedAtMs: number, _windowMs: number): string[] {
  const sessionsRoot = join(agentDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
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
        if (st.mtimeMs >= startedAtMs - 5_000) out.push(full);
      } catch { /* file vanished */ }
    }
  }
  return out;
}

/** Best-effort: export pi/omp sessions from this pty's lifetime to HTML. */
function exportPiSessions(opts: {
  agentDir: string; auditDir: string; startedAtMs: number; ompBin: string; tagPrefix: string;
}): void {
  const { agentDir, auditDir, startedAtMs, ompBin, tagPrefix } = opts;
  setImmediate(() => {
    const files = findRecentSessionFiles(agentDir, startedAtMs, 24 * 60 * 60 * 1000);
    if (files.length === 0) return;
    try { mkdirSync(auditDir, { recursive: true }); } catch { return; }
    for (const sessionFile of files) {
      const stem = basename(sessionFile, '.jsonl');
      const desiredPath = join(auditDir, `${tagPrefix}-${stem}.html`);
      const ompDefaultPath = join(auditDir, `omp-session-${stem}.html`);
      const child = spawnChild(ompBin, ['--export', sessionFile], {
        cwd: auditDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => {});
      child.on('exit', (code) => {
        if (code !== 0) return;
        try {
          if (existsSync(ompDefaultPath) && !existsSync(desiredPath)) {
            renameSync(ompDefaultPath, desiredPath);
          }
        } catch { /* keep omp's default name */ }
      });
    }
  });
}

/** Resolve the agent terminal binary (claude-code vs omp), probing known paths. */
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

function resolvePiBinary(): string {
  return resolveAgentTerminalBinary();
}

/* ─── Prewarm pool ───────────────────────────────────────────────────── */
// Keyed by `<slug>|<laneId>|<command>`. A /pty/prewarm reserves a warm
// pty; /pty/spawn adopts it, eliminating omp's ~1.2s startup from the
// critical path. The slot stores a Promise so /spawn can await an
// in-flight prewarm. Module-level (was a closure inside `registerPty`).

type PrewarmEntry = {
  promise: Promise<ReturnType<typeof spawnPty> | null>;
  reaper: NodeJS.Timeout | null;
};
const prewarmed = new Map<string, PrewarmEntry>();
const PREWARM_TTL_MS = 60_000;

function prewarmKey(slug: string, laneId: string | undefined, command: string): string {
  return `${slug}|${laneId ?? ''}|${command}`;
}

function reservePrewarmSlot(opts: {
  slug: string;
  laneId: string | undefined;
  command: string;
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
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, cols: 80, rows: 24, env: cfg.env,
      });
      attachAuditExport(handle, cfg.sd, cfg.command, laneId);
      entry.reaper = setTimeout(() => {
        if (prewarmed.get(key) === entry) prewarmed.delete(key);
        try { killPty(handle.id); } catch { /* ignore */ }
      }, PREWARM_TTL_MS);
      entry.reaper.unref?.();

      // Hold the slot for PREWARM_BOOT_MS before marking it adoptable so
      // omp's MCP-connection chatter is past before the client adopts.
      const PREWARM_BOOT_MS = 1500;
      let resolved = false;
      const ready = () => {
        if (resolved) return;
        resolved = true;
        resolveHandle(handle);
      };
      const bootTimer = setTimeout(ready, PREWARM_BOOT_MS);
      bootTimer.unref?.();
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

async function buildSpawnConfig(opts: {
  slug: string;
  body: SpawnBody;
  requestUrl: string;
}): Promise<{ kind: 'ok'; command: string; args: readonly string[]; cwd: string; env: Record<string, string>; sd: string | null } | { kind: 'unknown-slug' }> {
  const { slug, body, requestUrl } = opts;
  const command = body.command ?? resolvePiBinary();

  const projectDir = await resolveProjectDir(slug);
  if (!projectDir) return { kind: 'unknown-slug' };

  const sd = await resolveStateDir(slug);
  const cwd = resolveSpawnCwd({ projectDir, stateDir: sd, laneId: body.laneId });
  const env = resolveContextEnv({ slug, stateDir: sd, requestUrl });

  const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
  const piExtensionAvailable = existsSync(piExtensionPath);

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

/* ─── Routes ─────────────────────────────────────────────────────────── */

const spawn = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/spawn',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }

    const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
    const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));

    // Resume path: adopt an alive pty by id (PiPanel remount fast path).
    if (body.resumePtyId) {
      const existing = getPtyMeta(body.resumePtyId);
      if (existing) {
        try { resizePty(body.resumePtyId, cols, rows); } catch { /* ignore */ }
        return Response.json({ ...existing, resumed: true });
      }
    }

    // Compute the prewarm key synchronously so we can adopt an in-flight
    // prewarm slot without awaiting buildSpawnConfig.
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
            buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: req.url }),
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
        return Response.json({
          id: handle.id,
          command: handle.command,
          args: handle.args,
          cwd: handle.cwd,
          pid: handle.pty.pid,
          prewarmed: true,
        });
      }
      // prewarm failed or its handle died — fall through to a cold spawn.
    }

    const cfg = await buildSpawnConfig({ slug, body, requestUrl: req.url });
    if (cfg.kind === 'unknown-slug') {
      return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    }

    try {
      const handle = spawnPty({
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, cols, rows, env: cfg.env,
      });
      attachAuditExport(handle, cfg.sd, cfg.command, body.laneId);
      refill();
      return Response.json({
        id: handle.id,
        command: handle.command,
        args: handle.args,
        cwd: handle.cwd,
        pid: handle.pty.pid,
      });
    } catch (err) {
      if (err instanceof PtyError) {
        return Response.json({ error: err.message, code: err.code }, { status: 503 });
      }
      return Response.json({ error: (err as Error).message, code: 'UNKNOWN' }, { status: 500 });
    }
  },
});

const resolve = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/resolve',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }
    const cfg = await buildSpawnConfig({ slug, body, requestUrl: req.url });
    if (cfg.kind === 'unknown-slug') {
      return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    }
    return Response.json({ command: cfg.command, args: cfg.args, cwd: cfg.cwd, env: cfg.env });
  },
});

const prewarm = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/prewarm',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug ?? '';
    let body: SpawnBody;
    try { body = ((await req.json()) as SpawnBody) ?? {}; } catch { body = {}; }

    const command = body.command ?? resolvePiBinary();
    const key = prewarmKey(slug, body.laneId, command);
    const existing = prewarmed.get(key);
    if (existing) {
      const handle = await existing.promise.catch(() => null);
      if (handle && !handle.killed) return Response.json({ reserved: true, reused: true });
      if (existing.reaper) clearTimeout(existing.reaper);
      if (prewarmed.get(key) === existing) prewarmed.delete(key);
    }

    const entry = reservePrewarmSlot({
      slug,
      laneId: body.laneId,
      command,
      buildCfg: () => buildSpawnConfig({ slug, body, requestUrl: req.url }),
    });
    const handle = await entry.promise;
    if (!handle) {
      return Response.json({ error: 'prewarm spawn failed' }, { status: 503 });
    }
    return Response.json({ reserved: true });
  },
});

const stream = defineTool({
  method: 'GET',
  path: '/harness/:slug/pty/:id/stream',
  auth: 'public',
  // Pure SSE transport — don't flood route_invocations per connection.
  sampleRate: 0,
  handler(req, ctx) {
    const id = ctx.params.id;
    const handle = getPty(id);
    if (!handle) {
      return Response.json({ error: 'unknown pty id', id }, { status: 404 });
    }

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: (sink) => {
        const onData = (chunk: Buffer) => {
          if (sink.closed) return;
          sink.eventRaw('data', chunk.toString('base64'));
        };
        const onExit = (code: number) => {
          if (sink.closed) return;
          sink.event('exit', { code });
          sink.close();
        };

        // Replay full session history into the new subscriber.
        const history = getHistory(id);
        if (history && history.length > 0) {
          try { onData(history); } catch { /* see onData */ }
        }

        handle.onData.add(onData);
        handle.onExit.add(onExit);

        if (handle.killed) {
          onExit(handle.exitCode ?? 0);
          return;
        }

        // Keep the SSE consumer counted as activity so the reaper spares it.
        const ticker = setInterval(() => {
          if (!sink.closed) markActive(id);
        }, 15_000);
        if (typeof ticker.unref === 'function') ticker.unref();

        sink.onClose(() => {
          clearInterval(ticker);
          handle.onData.delete(onData);
          handle.onExit.delete(onExit);
          // Don't kill the pty on SSE disconnect — PiPanel unmounts on
          // every dashboard tab switch.
        });
      },
    });
  },
});

const input = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/input',
  auth: 'public',
  async handler(req, ctx) {
    const id = ctx.params.id;
    let body: { data?: string };
    try { body = ((await req.json()) as { data?: string }) ?? {}; } catch { body = {}; }
    if (!body.data) return Response.json({ error: 'missing data' }, { status: 400 });
    const ok = writePty(id, Buffer.from(body.data, 'base64'));
    if (!ok) return Response.json({ error: 'unknown or killed pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const resize = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/resize',
  auth: 'public',
  async handler(req, ctx) {
    const id = ctx.params.id;
    let body: { cols?: number; rows?: number };
    try { body = ((await req.json()) as { cols?: number; rows?: number }) ?? {}; } catch { body = {}; }
    const cols = Math.max(20, Math.min(500, Math.floor(body.cols ?? 80)));
    const rows = Math.max(5, Math.min(200, Math.floor(body.rows ?? 24)));
    const ok = resizePty(id, cols, rows);
    if (!ok) return Response.json({ error: 'unknown or killed pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const kill = defineTool({
  method: 'POST',
  path: '/harness/:slug/pty/:id/kill',
  auth: 'public',
  handler(_req, ctx) {
    const ok = killPty(ctx.params.id);
    if (!ok) return Response.json({ error: 'unknown pty' }, { status: 404 });
    return new Response(null, { status: 204 });
  },
});

const auditList = defineTool({
  method: 'GET',
  path: '/harness/:slug/pi-sessions/audit',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug ?? '';
    const sd = await stateDirForSlug(slug);
    if (!sd) return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    const auditDir = join(sd, 'audit', 'pi-sessions');
    if (!existsSync(auditDir)) return Response.json({ sessions: [] });

    let entries: string[];
    try { entries = readdirSync(auditDir); } catch { return Response.json({ sessions: [] }); }

    const sessions = entries
      .filter((e) => e.endsWith('.html'))
      .map((e) => {
        const full = join(auditDir, e);
        try {
          const st = statSync(full);
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
      .sort((a, b) => ((b as { mtimeMs?: number }).mtimeMs ?? 0) - ((a as { mtimeMs?: number }).mtimeMs ?? 0));

    return Response.json({ sessions });
  },
});

const auditFile = defineTool({
  method: 'GET',
  path: '/harness/:slug/pi-sessions/audit/:filename',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug ?? '';
    const filename = ctx.params.filename;
    // Defense in depth: simple HTML basename only, no path traversal.
    if (!/^[\w.-]+\.html$/.test(filename)) {
      return Response.json({ error: 'invalid filename' }, { status: 400 });
    }
    const sd = await stateDirForSlug(slug);
    if (!sd) return Response.json({ error: 'unknown harness slug', slug }, { status: 404 });
    const full = join(sd, 'audit', 'pi-sessions', filename);
    if (!existsSync(full)) return Response.json({ error: 'not found' }, { status: 404 });

    let html: Buffer;
    try { html = readFileSync(full); } catch { return Response.json({ error: 'read failed' }, { status: 500 }); }
    // Buffer → ArrayBuffer view for the Web `Response` body (the legacy
    // Hono handler did the same `as unknown as ArrayBuffer` cast).
    return new Response(html as unknown as ArrayBuffer, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

const tools = defineTool({
  method: 'GET',
  path: '/harness/:slug/pty/tools',
  auth: 'public',
  handler() {
    const piExtensionPath = papercuspPath('global-plugins', 'pi', 'extension.ts');
    if (!existsSync(piExtensionPath)) {
      return Response.json({ extensionAvailable: false, tools: [] });
    }
    return Response.json({
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
  },
});

export default [spawn, resolve, prewarm, stream, input, resize, kill, auditList, auditFile, tools];
