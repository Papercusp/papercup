/**
 * Shipping-gate Agent Chat E2E (own-tui-full-divorce-2026-08-24 P-022).
 *
 * This is intentionally above the reducer/parser layer:
 *
 *   installed/built `pui` -> real PTY -> production Hono operator app ->
 *   real owned loop -> real migrated Postgres
 *
 * By default, the scripted peer replaces only the external engine protocol.
 * PUI_REAL_ENGINE=1 uses the actual maintained engine and an installed artifact.
 * SU bootstrap, engine translation, command execution, chat/session persistence,
 * HTTP/SSE transport and Ratatui UI stay real. Explicit transport faults exercise
 * acknowledgement loss and retry without spending provider credentials.
 */
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Session as InspectorSession } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import type { ClaudeEngineOptions, ClaudeSuEngine } from '../su-session-claude-engine';
import type { SuRpcEngine } from '../su-session-rpc-engine';
import type { SuSessionCommand, SuSessionEvent } from '@papercusp/chat-protocol';
import type { OrgTestDb } from '../../test/_org-test-db';
import { screenContains, VtScreen } from './vt-screen';

const scriptedEngine = vi.hoisted(() => ({
  real: process.env.PUI_REAL_ENGINE === '1',
  backend: process.env.PUI_REAL_BACKEND ?? 'claude',
  mode: 'success' as 'success' | 'failure' | 'stall' | 'startup-exit',
  successText: 'PUI structured engine replied',
  requests: [] as string[],
  engines: [] as (ClaudeSuEngine | SuRpcEngine)[],
  events: [] as SuSessionEvent[],
  initialization: Promise.resolve(),
}));

// Observe real maintenance scheduling so the fixture can dispose its own
// timers before dropping their database. Production passes still run normally.
const maintenance = vi.hoisted(() => ({ jobs: [] as Array<{ stop(): Promise<void> }> }));
vi.mock('../session-end-lease-release-hook', async (original) => {
  const actual = await original<typeof import('../session-end-lease-release-hook')>();
  return { ...actual, scheduleSessionEndLeaseRelease(...args: Parameters<typeof actual.scheduleSessionEndLeaseRelease>) {
    const job = actual.scheduleSessionEndLeaseRelease(...args);
    maintenance.jobs.push(job);
    return job;
  } };
});
vi.mock('../session-archive-hook', async (original) => {
  const actual = await original<typeof import('../session-archive-hook')>();
  return { ...actual, async scheduleArchiveForAdvSession(...args: Parameters<typeof actual.scheduleArchiveForAdvSession>) {
    const job = await actual.scheduleArchiveForAdvSession(...args);
    if (job) maintenance.jobs.push(job);
    return job;
  } };
});

vi.mock('../su-session-claude-engine', async (original) => {
  const actual = await original<typeof import('../su-session-claude-engine')>();
  return {
    ...actual,
    startClaudeSuEngine(...args: Parameters<typeof actual.startClaudeSuEngine>) {
      if (scriptedEngine.real) {
        // Observe the production host; never supply a query, attach an adapter,
        // or send an owner turn from the fixture in the live-provider journey.
        const engine = actual.startClaudeSuEngine(...args);
        scriptedEngine.engines.push(engine);
        void (async () => {
          for await (const { event } of engine.adapter.host.subscribe()) {
            scriptedEngine.events.push(event);
          }
        })();
        return engine;
      }
      const query: NonNullable<ClaudeEngineOptions['query']> = ({ prompt }) => {
        const output = new PassThrough({ objectMode: true });
        let nativeId = '';
        const result = () => output.write({ type: 'result', subtype: 'success', session_id: nativeId, is_error: false });
        void (async () => {
          for await (const message of prompt) {
            if (!message.session_id) throw new Error('The PUI engine must stamp a native session ID on every input');
            nativeId = message.session_id;
            scriptedEngine.requests.push(String(message.message.content));
            output.write({ type: 'system', subtype: 'init', session_id: nativeId, cwd: args[0].cwd });
            output.write(message); // The engine's exact native receipt.
            if (scriptedEngine.mode === 'stall') {
              output.write({ type: 'assistant', session_id: nativeId, message: { content: [
                { type: 'text', text: 'PUI tool is still running' },
                { type: 'tool_use', id: 'pui-pending-tool', name: 'Bash', input: { command: 'sleep 30' } },
              ] } });
              continue;
            }
            if (scriptedEngine.mode === 'failure') {
              output.write({ type: 'result', subtype: 'error_during_execution', session_id: nativeId,
                is_error: true, errors: ['PUI-E2E engine failed visibly'] });
              continue;
            }
            output.write({ type: 'assistant', session_id: nativeId, message: { content: [
              { type: 'tool_use', id: 'pui-e2e-tool', name: 'Read', input: { file_path: 'README.md' } },
            ] } });
            output.write({ type: 'user', session_id: nativeId, message: { role: 'user', content: [
              { type: 'tool_result', tool_use_id: 'pui-e2e-tool', content: 'scripted engine tool result' },
            ] } });
            output.write({ type: 'assistant', session_id: nativeId, message: { content: [
              { type: 'text', text: scriptedEngine.successText },
            ] } });
            result();
          }
        })().catch((error: Error) => output.destroy(error));
        return {
          [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          initializationResult: async () => {
            await scriptedEngine.initialization;
            if (scriptedEngine.mode === 'startup-exit') {
              output.end();
              throw new Error('PUI-E2E engine exited during initialization');
            }
            return { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] };
          },
          mcpServerStatus: async () => [{ name: 'papercusp-su', status: 'connected' as const }],
          interrupt: async () => { result(); },
          close: () => output.end(),
        };
      };
      const engine = actual.startClaudeSuEngine(args[0], args[1], args[2], { ...args[3], query });
      scriptedEngine.engines.push(engine);
      return engine;
    },
  };
});

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');

vi.mock('../su-session-rpc-engine', async (original) => {
  const actual = await original<typeof import('../su-session-rpc-engine')>();
  return { ...actual, startSuRpcEngine(...args: Parameters<typeof actual.startSuRpcEngine>) {
    const engine = actual.startSuRpcEngine(...args);
    scriptedEngine.engines.push(engine);
    void (async () => {
      for await (const { event } of engine.adapter.host.subscribe()) scriptedEngine.events.push(event);
    })();
    return engine;
  } };
});
const HARNESS = 'papercusp';
const WORKSPACE = 'pui-agent-chat-e2e';
const OWNER = 'pui-agent-chat-e2e-owner';
const execFileAsync = promisify(execFile);

// Opt-in diagnosis uses the actual worker (including cold module evaluation),
// preserves every console warning, and writes no request bodies or credentials.
const timingTrace: Array<Record<string, unknown>> = [];
const namedQueryRequests: string[] = [];
const namedQueryReplies: Array<{ name: string; status: number }> = [];
const pipelineCellRequests: string[] = [];
const PIPELINE_CELLS = new Set([
  'gate.greenCheckpoint.verdict', 'gate.greenCheckpoint.candidate',
  'git.mainBehindStaging', 'deploy.3070.sha',
]);
let timingInspector: InspectorSession | undefined;
let timingInterval: ReturnType<typeof setInterval> | undefined;
let timingScan: Promise<void> | undefined;
function traceTiming(kind: string, fields: Record<string, unknown> = {}): void {
  if (process.env.PUI_TIMING_DIR && timingTrace.length < 20_000) {
    timingTrace.push({ atMs: performance.now(), kind, ...fields });
  }
}
function profileCommand(method: string): Promise<unknown> {
  return new Promise((resolve, reject) => timingInspector!.post(method, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  }));
}

async function startTimingProfile(): Promise<void> {
  if (!process.env.PUI_TIMING_DIR) return;
  timingInspector = new InspectorSession();
  timingInspector.connect();
  await profileCommand('Profiler.enable');
  await profileCommand('Profiler.start');
  traceTiming('profile-start', { timeOriginMs: performance.timeOrigin });
  const diagnostics = await import('../../../../libs/papercusp/libs/db/src/acquire-registry');
  let expected = performance.now() + 25;
  let lastScan = 0;
  timingInterval = setInterval(() => {
    const now = performance.now();
    if (now - expected > 100) traceTiming('event-loop-delay', { delayMs: now - expected });
    expected = now + 25;
    if (!timingScan && now - lastScan >= 250) {
      lastScan = now;
      timingScan = (async () => {
        const active = await db.adminSql`
          SELECT pid, application_name, state, wait_event_type, wait_event,
                 EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000 AS age_ms,
                 pg_blocking_pids(pid) AS blockers, query
            FROM pg_stat_activity
           WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
        `;
        traceTiming('database', {
          // The shared diagnostic writer strips SQL literals and parameters.
          active: active.map(({ query, ...row }) => ({ ...row, family: diagnostics.pgQueryFamily(String(query)) })),
          pool: diagnostics.acquireSnapshot('org-admin'),
          results: diagnostics.pgResultDiagnosticSnapshot('org-admin').results,
        });
      })().catch((error: { code?: string }) => traceTiming('database-error', { code: error.code }))
        .finally(() => { timingScan = undefined; });
    }
  }, 25);
}

afterAll(async () => {
  if (!timingInspector) return;
  if (timingInterval) clearInterval(timingInterval);
  await timingScan;
  const { profile } = await profileCommand('Profiler.stop') as { profile: unknown };
  traceTiming('profile-stop');
  timingInspector.disconnect();
  mkdirSync(process.env.PUI_TIMING_DIR!, { recursive: true });
  writeFileSync(path.join(process.env.PUI_TIMING_DIR!, `worker-${process.pid}.json`),
    JSON.stringify({ trace: timingTrace, profile }));
});

function cargoTargetDir(): string | null {
  const probe = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  try {
    return (JSON.parse(probe.stdout) as { target_directory?: string }).target_directory ?? null;
  } catch {
    return null;
  }
}

/** PUI_BIN explicitly selects an installed artifact; otherwise use this build. */
function resolvePuiBinary(): string | null {
  const target = cargoTargetDir();
  const candidates = [
    process.env.PUI_BIN,
    target ? path.join(target, 'debug', 'pui') : null,
    target ? path.join(target, 'release', 'pui') : null,
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
    path.join(TUI_DIR, 'target', 'release', 'pui'),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function ensurePuiBinary(): string {
  if (scriptedEngine.real && !process.env.PUI_BIN) {
    throw new Error('PUI_REAL_ENGINE requires PUI_BIN from the supported install-update.sh installer');
  }
  if (process.env.PUI_BIN) {
    if (!existsSync(process.env.PUI_BIN)) throw new Error('The explicit PUI_BIN artifact does not exist');
    return process.env.PUI_BIN;
  }
  const built = spawnSync('cargo', ['build', '--locked', '--bin', 'pui'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 840_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (built.status !== 0) {
    throw new Error(`cargo build --locked --bin pui failed:\n${built.stderr?.slice(-4_000)}`);
  }
  const resolved = resolvePuiBinary();
  if (!resolved) throw new Error('pui binary is absent after a successful cargo build');
  return resolved;
}

class PuiPane {
  readonly pty: IPty;
  private raw = '';
  private exit: Promise<{ exitCode: number; signal?: number }>;

  constructor(bin: string, operatorPort: number, home: string) {
    this.pty = ptySpawn(bin, [], {
      name: 'xterm-256color',
      cols: 150,
      rows: 44,
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm-256color',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PUI_OPERATOR: `http://127.0.0.1:${operatorPort}`,
        PAPERCUSP_TUI_OWNER: OWNER,
        // Keep this direct-PTY test out of any ambient zellij/tmux session.
        ZELLIJ: '',
        ZELLIJ_SESSION_NAME: '',
        TMUX: '',
      },
    });
    this.pty.onData((chunk) => {
      this.raw += chunk;
    });
    this.exit = new Promise((resolve) => this.pty.onExit(resolve));
  }

  screen(): string {
    const vt = new VtScreen(44, 150);
    vt.feed(this.raw);
    return vt.text();
  }

  failureEvidence(): Record<string, unknown> {
    return {
      screen: this.screen(),
      traffic: sessionTraffic,
      commands: commandPosts.map(({ type, commandId }) => ({ type, commandId })),
      commandReplies,
      engines: scriptedEngine.engines.map((engine) => {
        const descriptor = engine.adapter.host.descriptor();
        return { pid: engine.pid(), identity: descriptor.identity, lifecycle: descriptor.lifecycle,
          diagnostics: engine.adapter.host.recent.map(({ event }) => event)
            .filter((event) => event.type === 'error' || event.type === 'lifecycle' || event.type === 'command_result')
            .slice(-20),
        };
      }),
    };
  }

  write(keys: string): void {
    this.pty.write(keys);
  }

  /** Crossterm's raw-mode Enter encoding (its parser fixture: CSI 13 u). */
  enter(): void {
    this.pty.write('\x1b[13u');
  }

  /** Crossterm's raw-mode Escape encoding (its parser fixture: CSI 27 u). */
  escape(): void {
    this.pty.write('\x1b[27u');
  }

  interrupt(): void {
    this.pty.write('\x1b[120;5u');
  }

  async waitFor(needle: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (screenContains(this.screen(), needle)) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)} on the rendered screen:\n` + this.screen(),
      { cause: new Error(`Production session evidence: ${JSON.stringify({ binary: bin, binarySha256, traffic: sessionTraffic })}`) },
    );
  }

  async waitForReply(needle: string): Promise<void> {
    try {
      await vi.waitFor(() => {
        // Match the rendered assistant bubble itself. History can scroll the
        // echoed owner request away (especially after a long interrupted reply),
        // and a context-dependent answer need not occur in the request at all.
        const lines = this.screen().split('\n').map((line) => line.replace(/^│|│$/g, '').trim());
        expect(lines.some((line, index) => line === 'agent' && lines[index + 1]?.includes(needle))).toBe(true);
      }, { timeout: 120_000, interval: 100 });
    } catch (cause) {
      const engineState = scriptedEngine.engines.map((engine) => ({ pid: engine.pid(),
        lifecycle: engine.adapter.host.descriptor().lifecycle,
        diagnostics: engine.adapter.host.recent.map(({ event }) => event)
          .filter((event) => event.type === 'error' || event.type === 'lifecycle'),
      }));
      throw new Error(`Correlated reply was not rendered:\n${this.screen()}\nProduction traffic: ${JSON.stringify(sessionTraffic)}\nEngine state: ${JSON.stringify(engineState)}`, { cause });
    }
    await this.waitFor('Message — Enter send', { timeoutMs: 120_000 });
  }

  async stop(): Promise<void> {
    try {
      this.pty.write('q');
    } catch {
      /* exited */
    }
    const graceful = await Promise.race([
      this.exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (!graceful) {
      try {
        this.pty.kill();
      } catch {
        /* exited */
      }
      await Promise.race([
        this.exit,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pui PTY did not exit')), 5_000)),
      ]);
    }
    await waitForNoChildren(this.pty.pid);
  }
}

async function processRows(args: string[]): Promise<string> {
  try {
    return (await execFileAsync('ps', args, { encoding: 'utf8' })).stdout;
  } catch (error) {
    // ps uses 1 for an empty selection (including a process that just exited).
    if ((error as { code?: number }).code === 1) return '';
    throw error;
  }
}

async function childPids(parent: number): Promise<number[]> {
  const rows = await processRows(['-o', 'pid=', '--ppid', String(parent)]);
  return rows
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForNoChildren(parent: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await childPids(parent)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  expect(await childPids(parent), `processes leaked below pui pid ${parent}`).toEqual([]);
}

async function listen(server: ServerType): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ServerType | undefined): Promise<void> {
  if (!server) return;
  if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function putViewState(tab: string): Promise<void> {
  const { putViewState: put } = await import('../tui-workbench-store');
  await put(OWNER, { tab, harness: HARNESS, operator_dock_open: false });
}

type PersistedChat = {
  id: string;
  role: string;
  transcript: Array<{ role: string; content: string; error?: boolean; su_command?: { command: SuSessionCommand; outcome?: unknown } }>;
};

async function persistedChats(db: OrgTestDb): Promise<PersistedChat[]> {
  return db.adminSql<PersistedChat[]>`
    SELECT id, role, transcript
    FROM harness_shared.agent_chats_consolidated
    WHERE workspace_id = ${WORKSPACE}
    ORDER BY updated_at DESC
  `;
}

async function waitForPersistedChat(
  db: OrgTestDb,
  predicate: (chat: PersistedChat) => boolean,
  timeoutMs = 15_000,
): Promise<PersistedChat> {
  const deadline = Date.now() + timeoutMs;
  let last: PersistedChat[] = [];
  while (Date.now() < deadline) {
    last = await persistedChats(db);
    const chat = last.find(predicate);
    if (chat) return chat;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`timed out waiting for persisted Agent Chat state; last rows: ${JSON.stringify(last)}`);
}

let db: OrgTestDb;
let bin: string;
let binarySha256: string;
let home: string;
let operatorServer: ServerType;
let operatorPort: number;
let previousEnv: Record<string, string | undefined>;
let sessionTraffic: Array<Record<string, unknown>> = [];
type TransportFault = 'none' | 'startup-disconnect' | 'refuse' | 'lost-ack' | 'wrong-command-ack' | 'wrong-session-ack';
let transportFault: TransportFault = 'none';
let commandPosts: SuSessionCommand[] = [];
let commandReplies: Array<{ status: number; replayed?: boolean }> = [];
let initializeWarnings: Array<Record<string, unknown>> = [];
let optionalMemoryWarnings: string[] = [];

// Drop command frames only for deliberate acknowledgement-loss cases. All other
// production SSE events still traverse the real HTTP connection to the PTY.
function withoutCommandReceipts(response: Response): Response {
  if (!response.body) throw new Error('production event stream has no body');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data && JSON.parse(data).type === 'command_result') continue;
        controller.enqueue(encoder.encode(frame + '\n\n'));
      }
    },
    flush(controller) { if (pending) controller.enqueue(encoder.encode(pending)); },
  })), { status: response.status, headers: response.headers });
}

async function openComposer(pane: PuiPane): Promise<void> {
  await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
  pane.write('o');
  await pane.waitFor(`pot ${HARNESS} · role operator · session new`);
  pane.escape();
  await pane.waitFor('i type · v speak');
  if (scriptedEngine.real && scriptedEngine.backend !== 'claude') {
    const selection = ['claude', 'codex', 'omp'].indexOf(scriptedEngine.backend);
    if (selection < 0) throw new Error(`Unknown PUI_REAL_BACKEND: ${scriptedEngine.backend}`);
    pane.write('b');
    await pane.waitFor('Backend — Enter select');
    pane.write('j'.repeat(selection));
    pane.enter();
    await pane.waitFor(`backend ${['Claude', 'Codex', 'OMP'][selection]}`);
  }
  pane.write('i');
}

async function waitForSavedTurn(content: string): Promise<PersistedChat> {
  return waitForPersistedChat(db, (chat) => chat.transcript.some((turn) => turn.role === 'user' && turn.content === content));
}

async function waitForCorrelatedReply(prompt: string, reply: string): Promise<PersistedChat> {
  // The chat table stores accepted command receipts. Assistant text belongs to
  // the native transcript, exposed through the real adapter's SU event stream.
  const chat = await waitForPersistedChat(db, (candidate) => {
    if (candidate.transcript.some((turn) => turn.role === 'user' && turn.content === prompt)) return true;
    const refusedLaunch = sessionTraffic.find((entry) => entry.path === '/api/adv/sessions/launch-su' && Number(entry.status) >= 400);
    if (refusedLaunch) throw new Error(`Native launch refused: ${String(refusedLaunch.error ?? refusedLaunch.status)}`);
    // A resumed conversation deliberately retains its stopped predecessor in
    // the evidence list. Only the current native process can refuse this turn.
    const active = scriptedEngine.engines.at(-1);
    if (active?.adapter.host.snapshot().terminal) {
      const diagnostics = active.adapter.host.recent.map(({ event }) => event)
        .filter((event) => event.type === 'error' || event.type === 'lifecycle').slice(-5);
      throw new Error(`Native engine stopped before the owner turn was saved: ${JSON.stringify(diagnostics)}`);
    }
    return false;
  }, 120_000);
  const command = chat.transcript.find((turn) => turn.content === prompt)?.su_command?.command;
  if (command?.type !== 'owner_turn') throw new Error('Greeting/follow-up lacks a durable owner-turn receipt');
  await vi.waitFor(() => expect(scriptedEngine.events).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'transcript', phase: 'completed', role: 'assistant', channel: 'text',
      content: reply, turnId: command.turnId, session: command.target,
    }),
  ])), { timeout: 120_000, interval: 100 });
  return chat;
}

async function stopEngines(): Promise<void> {
  for (const engine of scriptedEngine.engines.splice(0)) {
    // The protocol peer has no native CLI lifecycle hook. Remove only its
    // bootstrap presence in this isolated DB before the real close/reaper runs.
    const owner = engine.adapter.host.descriptor().identity.ownerId;
    if (!scriptedEngine.real) {
      await db.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${owner}`;
    }
    await engine.close();
    engine.adapter.dispose();
  }
}


beforeAll(async () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  bin = ensurePuiBinary();
  binarySha256 = createHash('sha256').update(readFileSync(bin)).digest('hex');
  home = mkdtempSync(path.join(tmpdir(), 'pui-agent-chat-e2e-'));
  mkdirSync(path.join(home, '.papercusp'), { recursive: true });
  writeFileSync(path.join(home, '.papercusp', 'pui-state.json'), JSON.stringify({ tutorialSeen: true }));

  const { createOrgTestDb } = await import('../../test/_org-test-db');
  db = await createOrgTestDb();
  const keys = [
    'HARNESS_DATABASE_URL',
    'HARNESS_ADMIN_DATABASE_URL',
    'DATABASE_URL',
    'PAPERCUSP_SKIP_PG_DISCOVERY',
    'PAPERCUSP_PGBOUNCER',
    'PAPERCUSP_LISTEN_HUB',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACES_ROOT',
    'PAPERCUSP_SERVE_UI',
    'PAPERCUSP_HONO_PORT',
    'PAPERCUSP_OPERATOR_URL',
    'PAPERCUSP_MCP_PROXY_BASE',
    'PAPERCUSP_SU_CODEX_HOMES_DIR',
    'PAPERCUSP_SU_OMP_HOMES_DIR',
    'PAPERCUSP_SESSION_CLAUDE_DIR',
    'PAPERCUSP_SESSION_MCP_DIR',
  ];
  previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HARNESS_DATABASE_URL: db.appDsn,
    HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
    DATABASE_URL: db.adminDsn,
    PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    PAPERCUSP_PGBOUNCER: '0',
    PAPERCUSP_LISTEN_HUB: '0',
    PAPERCUSP_WORKSPACE_ID: WORKSPACE,
    PAPERCUSP_WORKSPACES_ROOT: path.join(home, '.papercusp-workspaces'),
    PAPERCUSP_SERVE_UI: '0',
    PAPERCUSP_SU_CODEX_HOMES_DIR: path.join(home, 'native-codex'),
    PAPERCUSP_SU_OMP_HOMES_DIR: path.join(home, 'native-omp'),
    PAPERCUSP_SESSION_CLAUDE_DIR: path.join(home, 'native-claude'),
    PAPERCUSP_SESSION_MCP_DIR: path.join(home, 'native-mcp'),
  });
  // The org fixture reuses numeric ids. Resolve the actual writers' roots
  // before any bootstrap so they cannot replace a real user's native home.
  const { codexHomeForSessionKey, sessionClaudeConfigDir } = await import('@papercusp/orchestrator/session-launch-dirs');
  const { ompAgentHomeForSessionKey } = await import('../session-transcript-resolvers');
  for (const nativeHome of [codexHomeForSessionKey('isolation-check'),
    sessionClaudeConfigDir('isolation-check'), ompAgentHomeForSessionKey('isolation-check')]) {
    expect(path.relative(home, nativeHome).startsWith('..'), `native home escaped fixture: ${nativeHome}`).toBe(false);
  }

  const dbOrg = await import('@papercusp/db-org');
  await dbOrg._resetForTests();
  const connection = await import('../../../../libs/papercusp/libs/db/src/connection');
  connection._resetUrlCacheForTests();
  await dbOrg._resetForTests();

  const { saveHarnessRegistry } = await import('../harness-registry');
  await saveHarnessRegistry(
    {
      projects: [{ slug: HARNESS, path: REPO_ROOT, harness_kind: 'hive', self_repo: true }],
    },
    WORKSPACE,
  );
  // createOrgTestDb supplies the canonical migrated org substrate; a real
  // harness also has the production compatibility schema/views that route
  // unqualified `agent_chats` through the consolidated PG table.
  const { scaffoldHarnessSchema } = await import('../scaffold-harness-schema');
  await scaffoldHarnessSchema(HARNESS);
  await putViewState('Plans');

  await startTimingProfile();
  const { app } = await import('../../../../apps/operator/bin/host-app');
  operatorServer = createAdaptorServer({
    fetch: async (request, env) => {
      const requestUrl = new URL(request.url);
      const pathname = requestUrl.pathname;
      const requestStarted = performance.now();
      const traceFields = { path: pathname, query: requestUrl.searchParams.get('name') };
      traceTiming('request-start', traceFields);
      if (pathname === '/api/zero-harness/rest-query' && traceFields.query) {
        namedQueryRequests.push(traceFields.query);
      }
      if (request.method === 'POST' && pathname === '/api/agent-mcp/run-tool') {
        const input = await request.clone().json() as { name?: string; args?: { cell?: string } };
        if (input.name === 'state:read' && input.args?.cell && PIPELINE_CELLS.has(input.args.cell)) {
          pipelineCellRequests.push(input.args.cell);
        }
      }
      const isLaunch = pathname === '/api/adv/sessions/launch-su';
      const launchInput = isLaunch ? await request.clone().json() : null;
      const isCommand = request.method === 'POST' && pathname.endsWith('/su-session/commands');
      if (isCommand) commandPosts.push(await request.clone().json() as SuSessionCommand);
      if (isLaunch && transportFault === 'startup-disconnect') {
        transportFault = 'none';
        return Response.json({ error: 'PUI-E2E startup connection interrupted' }, { status: 503 });
      }
      const host = scriptedEngine.engines.at(-1)?.adapter.host;
      if (isCommand && transportFault === 'refuse') host?.transition('starting', 'injected readiness withdrawal');
      let response = await app.fetch(request, env);
      traceTiming('request-end', { ...traceFields, elapsedMs: performance.now() - requestStarted, status: response.status });
      if (pathname === '/api/zero-harness/rest-query' && traceFields.query) {
        namedQueryReplies.push({ name: traceFields.query, status: response.status });
      }
      if (isCommand) {
        const body = await response.clone().json();
        commandReplies.push({ status: response.status, replayed: body.replayed });
        if (transportFault === 'refuse') {
          host?.transition('ready', 'readiness restored');
          transportFault = 'none';
        } else if (transportFault === 'lost-ack') {
          response = new Response('PUI-E2E acknowledgement connection lost', { status: 502 });
        } else if (transportFault === 'wrong-command-ack') {
          response = Response.json({ ...body, accepted: { ...body.accepted, commandId: 'unrelated-command' } }, { status: response.status });
        } else if (transportFault === 'wrong-session-ack') {
          response = Response.json({ ...body, accepted: { ...body.accepted, session: { ...body.accepted.session, nativeSessionId: 'unrelated-native-session' } } }, { status: response.status });
        }
      }
      if (pathname.endsWith('/su-session/events') && transportFault.endsWith('-ack')) {
        response = withoutCommandReceipts(response);
      }
      if (isLaunch || pathname.includes('/su-session')) {
        const result = isLaunch ? await response.clone().json() : null;
        // Keep an allowlisted trace of the production boundary. Never capture
        // authorization headers, endpoint credentials or arbitrary request text.
        const observation = {
          method: request.method,
          path: pathname,
          status: response.status,
          count: 1,
          ...(isLaunch ? {
            agent: launchInput?.agent,
            deferSpawn: launchInput?.defer_spawn,
            attachedEngine: launchInput?.attached_engine === true,
            transport: result?.transport,
            headless: launchInput?.headless === true,
            deferred: result?.deferred === true,
            advSessionId: result?.advSessionId,
            nativeSessionPresent: Boolean(result?.nativeSession),
            ...(result?.error ? { errorCode: result.code,
              error: (typeof result.error === 'string' ? result.error : JSON.stringify(result.error)).slice(0, 500) } : {}),
          } : {}),
        };
        const existing = sessionTraffic.find((entry) =>
          entry.method === observation.method && entry.path === pathname && entry.status === response.status);
        if (existing) existing.count = Number(existing.count) + 1;
        else if (sessionTraffic.length < 30) sessionTraffic.push(observation);
      }
      return response;
    },
  });
  operatorPort = await listen(operatorServer);
  // Native lifecycle hooks and MCP must rendezvous with this isolated host,
  // never the developer's inherited live/staging endpoint or shared proxy.
  process.env.PAPERCUSP_HONO_PORT = String(operatorPort);
  process.env.PAPERCUSP_OPERATOR_URL = `http://127.0.0.1:${operatorPort}`;
  process.env.PAPERCUSP_MCP_PROXY_BASE = `http://127.0.0.1:${operatorPort}`;
  // Fail at the actual rendezvous boundary instead of spending every PTY
  // timeout on a fixture operator that the installed client cannot identify.
  const identityResponse = await fetch(`http://127.0.0.1:${operatorPort}/api/tui/identity`);
  const identity = await identityResponse.json();
  expect(identityResponse.status, JSON.stringify(identity)).toBe(200);
  expect(identity).toMatchObject({
    schemaVersion: 1,
    workspaceId: WORKSPACE,
    agentChat: { scope: `workspace:${WORKSPACE}` },
  });
}, 900_000);

afterAll(async () => {
  await stopEngines();
  await close(operatorServer);
  const { drainDetached } = await import('../detached-imports');
  await drainDetached();
  for (const job of maintenance.jobs.splice(0)) await job.stop();
  const { stopInvalidationListener } = await import('../sync-sse');
  await stopInvalidationListener();
  const dbOrg = await import('@papercusp/db-org');
  await dbOrg._resetForTests().catch(() => {});
  await db?.cleanup();
  for (const [key, value] of Object.entries(previousEnv ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}, 120_000);

afterEach(stopEngines);

beforeEach(async () => {
  namedQueryRequests.length = 0;
  namedQueryReplies.length = 0;
  pipelineCellRequests.length = 0;
  sessionTraffic = [];
  commandPosts = [];
  commandReplies = [];
  transportFault = 'none';
  scriptedEngine.mode = 'success';
  scriptedEngine.successText = 'PUI structured engine replied';
  scriptedEngine.requests = [];
  scriptedEngine.events = [];
  scriptedEngine.initialization = Promise.resolve();
  initializeWarnings = [];
  optionalMemoryWarnings = [];
  if (scriptedEngine.real) {
    const warn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[mcp-initialize-stage]') {
        // Optional memory enrichment has a bounded production fallback in a
        // fresh test DB. Retain that diagnostic and prove the actual MCP
        // connection works; any other warning remains a test failure.
        const detail = args[1] as Record<string, unknown>;
        expect(['base', 'enriched', 'timeout']).toContain(detail.outcome);
        initializeWarnings.push(detail);
        console.info('PUI_MCP_INITIALIZE_DIAGNOSTIC', JSON.stringify(detail));
      } else if (args.length === 1 && args[0] === '[memory-injection] block build exceeded the 2000ms prompt-build deadline — omitting the section this turn; the in-flight build will serve the next one (P-010).') {
        // A fresh isolated DB can take the documented optional-enrichment
        // fallback. Preserve the exact diagnostic; hard memory/SU errors and
        // every other warning still fail this test (EI-22628413686876169).
        optionalMemoryWarnings.push(String(args[0]));
        console.info('PUI_OPTIONAL_MEMORY_DIAGNOSTIC', args[0]);
      } else {
        if (typeof args[0] === 'string' && /^\[bounded-timeout\].* exceeded \d+ms/.test(args[0])) {
          traceTiming('diagnostic-warning', { label: args[0] });
        }
        warn(...args);
      }
    });
  }
  await db.adminSql`
    TRUNCATE harness_shared.agent_chat_locks,
      harness_shared.agent_loop_approvals,
      harness_shared.agent_loop_sessions,
      harness_shared.agent_chats_consolidated CASCADE
  `;
  await putViewState('Plans');
});

describe.skipIf(scriptedEngine.real).sequential('pui SU composer (current binary, real PTY/operator/PG)', () => {
  test('a refused reconnect stays visible without submitting a new owner turn', async () => {
    const pane = new PuiPane(bin, operatorPort, home);
    let saved: PersistedChat;
    try {
      await openComposer(pane);
      const prompt = `saved reconnect ${randomUUID()}`;
      pane.write(prompt); pane.enter();
      saved = await waitForSavedTurn(prompt);
      await pane.waitFor(scriptedEngine.successText);
    } finally { await pane.stop(); }
    await stopEngines();
    await putViewState('Plans');
    transportFault = 'startup-disconnect';
    const reopened = new PuiPane(bin, operatorPort, home);
    try {
      await reopened.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      reopened.write('o');
      await reopened.waitFor(`pot ${HARNESS} · role operator · session new`);
      reopened.escape();
      await reopened.waitFor('i type · v speak');
      reopened.write('l');
      await reopened.waitFor('Conversation — Enter select');
      reopened.enter();
      await reopened.waitFor('PUI-E2E startup connection interrupted');
      await reopened.waitFor('choose session to reconnect');
      expect(commandPosts.filter((command) => command.type === 'owner_turn')).toHaveLength(1);
      expect(await persistedChats(db)).toEqual(expect.arrayContaining([expect.objectContaining({ id: saved!.id })]));
      console.info('PUI_RECONNECT_REFUSAL_ACCEPTANCE', JSON.stringify({ binarySha256, chatId: saved!.id,
        screen: reopened.screen(), commands: commandPosts.map((command) => command.type) }));
    } finally { await reopened.stop(); }
  });

  test('first exact draft reaches the structured SU engine, streams tools/reply, and reopens', async () => {
    const prompt = '  PUI exact Unicode draft λ 雪  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      expect(pane.screen()).toContain('Read');
      expect(pane.screen().split('PUI exact Unicode draft')).toHaveLength(2);
      expect(pane.screen().split(scriptedEngine.successText)).toHaveLength(2);
      expect(scriptedEngine.requests).toEqual([prompt]);
      const chat = await waitForSavedTurn(prompt);
      expect(chat.role).toBe('operator');
      expect(chat.transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      expect(commandPosts).toHaveLength(1);
      expect(commandPosts[0]).toMatchObject({ type: 'owner_turn', content: prompt });
      expect(commandReplies).toEqual([{ status: 202, replayed: false }]);
      expect(sessionTraffic).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/api/adv/sessions/launch-su', status: 200,
          attachedEngine: true, transport: 'structured', nativeSessionPresent: true }),
      ]));
      // The test peer never opens a native terminal. PUI requested only the
      // attached-engine path and the protocol peer received the exact draft.
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')).toHaveLength(1);
      expect(pane.screen()).not.toContain(`> ${prompt}`);
      await pane.stop();
      await putViewState('Plans');
      const reopened = new PuiPane(bin, operatorPort, home);
      try {
        await reopened.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        reopened.write('o');
        await reopened.waitFor(prompt.trim(), { timeoutMs: 30_000 });
        await reopened.waitFor(scriptedEngine.successText);
        expect(reopened.screen().split('PUI exact Unicode draft')).toHaveLength(2);
        expect(reopened.screen().split(scriptedEngine.successText)).toHaveLength(2);
      } finally { await reopened.stop(); }
      expect(namedQueryRequests).not.toContain('network.board');
      expect(pipelineCellRequests).toEqual([]);
      console.info('PUI_COMPOSER_ACCEPTANCE', JSON.stringify({ binary: bin, binarySha256,
        chatId: chat.id, exactText: scriptedEngine.requests[0], traffic: sessionTraffic }));
    } finally { await pane.stop().catch(() => {}); }
  });

  test('Network loads on navigation, manual refresh, and saved-view restoration', async () => {
    const pane = new PuiPane(bin, operatorPort, home);
    const networkReads = () => namedQueryReplies.filter((reply) => reply.name === 'network.board' && reply.status === 200).length;
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      expect(namedQueryRequests).not.toContain('network.board');
      pane.write('n');
      await pane.waitFor('Network');
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(0), { timeout: 30_000 });
      const beforeRefresh = networkReads();
      pane.write('g');
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(beforeRefresh), { timeout: 30_000 });
    } finally { await pane.stop(); }
    await putViewState('Network');
    const beforeRestore = networkReads();
    const restored = new PuiPane(bin, operatorPort, home);
    try {
      await restored.waitFor('Network', { timeoutMs: 40_000 });
      await vi.waitFor(() => expect(networkReads()).toBeGreaterThan(beforeRestore), { timeout: 30_000 });
    } finally { await restored.stop(); }
  });

  test('delayed readiness sends the first draft once and accepts a follow-up after completion', async () => {
    let releaseInitialization!: () => void;
    scriptedEngine.initialization = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    const prompt = '  PUI delayed startup draft λ  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('· starting ·', { timeoutMs: 60_000 });
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(pane.screen()).not.toContain('Message not accepted');
      expect(commandPosts).toHaveLength(0);
      expect(scriptedEngine.requests).toHaveLength(0);
      releaseInitialization();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      await pane.waitFor('Message — Enter send');
      expect(commandPosts).toHaveLength(1);
      expect(commandPosts[0]).toMatchObject({ type: 'owner_turn', content: prompt });
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su')).toHaveLength(1);
      const followup = 'PUI follow-up after waiting-for-owner';
      scriptedEngine.successText = 'PUI follow-up completed';
      pane.write(followup);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText);
      await pane.waitFor('Message — Enter send');
      expect(scriptedEngine.requests).toEqual([prompt, followup]);
      expect(commandPosts).toHaveLength(2);
      expect((await waitForSavedTurn(followup)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(2);
    } finally {
      releaseInitialization();
      await pane.stop();
    }
  });

  test('delivery receipt and assistant segment keep input locked until interruption completes', async () => {
    scriptedEngine.mode = 'stall';
    const prompt = 'PUI pending tool turn';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('PUI tool is still running', { timeoutMs: 60_000 });
      await pane.waitFor('Running — input locked');
      await pane.waitFor('Bash');
      expect(pane.screen()).not.toContain('Message — Enter send');
      await waitForSavedTurn(prompt);
      pane.interrupt();
      await pane.waitFor('Message — Enter send');
      expect(commandPosts.some((command) => command.type === 'interrupt')).toBe(true);
      scriptedEngine.mode = 'success';
      const followup = 'PUI continued after interrupt';
      pane.write(followup);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText);
      await pane.waitFor('Message — Enter send');
      expect(scriptedEngine.requests).toEqual([prompt, followup]);
    } finally { await pane.stop(); }
  });

  test('interrupted startup retains the draft and retries without creating another chat', async () => {
    transportFault = 'startup-disconnect';
    const prompt = '  PUI startup retry λ  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      expect(pane.screen()).toContain('PUI-E2E startup connection interrupted');
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(commandPosts).toHaveLength(0);
      const chats = await persistedChats(db);
      expect(chats).toHaveLength(1);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 60_000 });
      expect((await waitForSavedTurn(prompt)).id).toBe(chats[0].id);
      expect(await persistedChats(db)).toHaveLength(1);
      expect(scriptedEngine.requests).toEqual([prompt]);
    } finally { await pane.stop(); }
  });

  test('engine startup exit releases input while preserving the exact unsent draft', async () => {
    scriptedEngine.mode = 'startup-exit';
    const prompt = 'PUI failed engine startup';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      expect(pane.screen()).toMatch(/PUI-E2E engine exited during initialization|Claude event stream closed unexpectedly/);
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(pane.screen()).not.toContain('Sending — awaiting acceptance');
      expect(scriptedEngine.requests).toHaveLength(0);
      expect(commandPosts).toHaveLength(0);
      expect((await persistedChats(db))[0].transcript).toHaveLength(0);
    } finally { await pane.stop(); }
  });

  test('host refusal retains an editable draft and a ready retry commits it once', async () => {
    transportFault = 'refuse';
    const prompt = '  PUI refused exact draft  ';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await openComposer(pane);
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('Message not accepted — draft retained', { timeoutMs: 60_000 });
      expect(pane.screen()).toContain(`> ${prompt}`);
      expect(commandReplies[0].status).toBe(409);
      expect(scriptedEngine.requests).toHaveLength(0);
      expect((await persistedChats(db))[0].transcript).toHaveLength(0);
      pane.enter();
      await pane.waitFor(scriptedEngine.successText, { timeoutMs: 30_000 });
      expect(scriptedEngine.requests).toEqual([prompt]);
      expect((await waitForSavedTurn(prompt)).transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
    } finally { await pane.stop(); }
  });

  test.each(['lost-ack', 'wrong-command-ack', 'wrong-session-ack'] as const)(
    '%s keeps the draft and retries the exact persisted command without a second execution', async (fault) => {
      transportFault = fault;
      const prompt = `  PUI ${fault} λ  `;
      const pane = new PuiPane(bin, operatorPort, home);
      try {
        await openComposer(pane);
        pane.write(prompt);
        pane.enter();
        await pane.waitFor('Delivery uncertain', { timeoutMs: 60_000 });
        expect(pane.screen()).toContain(`> ${prompt}`);
        await pane.waitFor(scriptedEngine.successText);
        await vi.waitFor(() => expect(scriptedEngine.requests).toEqual([prompt]));
        const chat = await waitForSavedTurn(prompt);
        expect(chat.transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
        transportFault = 'none';
        pane.enter();
        await pane.waitFor('Message — Enter send');
        expect(pane.screen()).not.toContain(`> ${prompt}`);
        expect(commandPosts).toHaveLength(2);
        expect(commandPosts[1]).toEqual(commandPosts[0]);
        expect(commandReplies[1]).toEqual({ status: 202, replayed: true });
        expect(scriptedEngine.requests).toEqual([prompt]);
        expect((await persistedChats(db))[0].transcript.filter((turn) => turn.role === 'user')).toHaveLength(1);
      } finally { await pane.stop(); }
    },
  );

  test('canonical-identity mismatch fails quickly with an actionable visible error', async () => {
    const proxy = createServer(async (req, res) => {
      try {
        const target = `http://127.0.0.1:${operatorPort}${req.url ?? '/'}`;
        const body: Buffer[] = [];
        for await (const chunk of req) body.push(Buffer.from(chunk));
        const upstream = await fetch(target, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: body.length ? Buffer.concat(body) : undefined,
          duplex: body.length ? 'half' : undefined,
        } as RequestInit & { duplex?: 'half' });
        let payload = Buffer.from(await upstream.arrayBuffer());
        if ((req.url ?? '').startsWith('/api/tui/identity')) {
          const identity = JSON.parse(payload.toString()) as { agentChat: { scope: string } };
          identity.agentChat.scope = 'workspace:intentionally-wrong';
          payload = Buffer.from(JSON.stringify(identity));
        }
        const headers = Object.fromEntries(upstream.headers.entries());
        delete headers['content-length'];
        headers['content-length'] = String(payload.byteLength);
        res.writeHead(upstream.status, headers);
        res.end(payload);
      } catch {
        // The pui deliberately exits as soon as the identity mismatch is
        // rendered. Its concurrent background reads can therefore disconnect
        // while this proxy still awaits the canonical operator response.
        if (!res.writableEnded) res.destroy();
      }
    });
    const proxyPort = await listen(proxy);
    const pane = new PuiPane(bin, proxyPort, home);
    try {
      await pane.waitFor('operator identity-mismatch', { timeoutMs: 12_000 });
    } finally {
      await pane.stop();
      await close(proxy);
    }
  });
});

describe.skipIf(!scriptedEngine.real).sequential(`installed PUI with the real ${scriptedEngine.backend} engine`, () => {
  test('greeting, real file tool, interrupt and continued reply stay in one first-party session', async () => {
    const manifestPath = process.env.PUI_INSTALL_MANIFEST
      ?? path.join(process.env.HOME!, '.papercusp', 'pui-install.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(path.resolve(manifest.binaryPath)).toBe(path.resolve(bin));
    expect(manifest.binarySha256).toBe(binarySha256);
    expect(createHash('sha256').update(readFileSync(manifest.companionPath)).digest('hex'))
      .toBe(manifest.companionSha256);

    const nonce = randomUUID();
    const greetingReply = `PUI-HELLO-${nonce}`;
    const greeting = `Hi. Reply with exactly ${greetingReply} and no other text.`;
    // The answer is intentionally absent from the request: only reading this
    // newly generated file can supply the expected result.
    const fileResult = `PUI-FILE-${randomUUID()}`;
    const fixturePath = path.join(home, `read-${nonce}.txt`);
    writeFileSync(fixturePath, fileResult + '\n');
    const fileRequest = `Use your file-reading tool to inspect ${fixturePath}, then reply with its contents. Do not modify any file.`;
    const longRequest = `For interruption check PUI-CANCELLED-${nonce}, count from 1 through 10000, one number per line. Do not summarize or use tools.`;
    const followupReply = `PUI-CONTINUED-${nonce}`;
    const followup = `Reply with exactly ${followupReply} and no other text. Do not resume the interrupted task.`;
    const pane = new PuiPane(bin, operatorPort, home);
    const frames: Record<string, string> = {};
    try {
      await openComposer(pane);
      pane.write(greeting);
      pane.enter();
      const firstChat = await waitForCorrelatedReply(greeting, greetingReply);
      await pane.waitForReply(greetingReply);
      frames.greeting = pane.screen();
      const engine = scriptedEngine.engines[0];
      expect(engine?.pid()).toBeGreaterThan(0);
      const identity = structuredClone(engine.adapter.host.descriptor().identity);
      expect(identity.backend).toBe(scriptedEngine.backend);
      expect(identity.nativeSessionId).toBeTruthy();
      if ('nativeSession' in engine) {
        expect(engine.nativeSession()).toMatchObject({ backend: scriptedEngine.backend, exactResumeSupported: true });
      }

      pane.write(fileRequest);
      pane.enter();
      await pane.waitFor(fileResult, { timeoutMs: 120_000 });
      await pane.waitFor('Message — Enter send', { timeoutMs: 120_000 });
      frames.file = pane.screen();
      const readStart = scriptedEngine.events.find((event): event is Extract<SuSessionEvent, { type: 'tool'; phase: 'started' }> => event.type === 'tool'
        && event.phase === 'started' && JSON.stringify(event.input).includes(fixturePath));
      expect(readStart, 'the model must actually request the generated fixture').toBeDefined();
      expect(pane.screen()).toContain(readStart!.name);
      const readEnd = scriptedEngine.events.find((event) => event.type === 'tool'
        && event.phase === 'completed' && event.callId === readStart?.callId
        && JSON.stringify(event.output).includes(fileResult));
      expect(readEnd, 'the real tool result must return in the same turn').toMatchObject({ turnId: readStart?.turnId });

      pane.write(longRequest);
      pane.enter();
      const longChat = await waitForSavedTurn(longRequest);
      const longCommand = longChat.transcript.find((turn) => turn.content === longRequest)?.su_command?.command;
      if (longCommand?.type !== 'owner_turn') throw new Error('Interrupt target lacks an owner-turn receipt');
      // The engine's completed owner-turn receipt follows the native input
      // acknowledgement, not model completion. Interrupt real inference after
      // that receipt; a refused sleep command cannot stand in for running work.
      await vi.waitFor(() => expect(scriptedEngine.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'command_result', commandId: longCommand.commandId,
          commandType: 'owner_turn', status: 'completed', session: longCommand.target }),
      ])), { timeout: 120_000, interval: 100 });
      await pane.waitFor('Running — input locked');
      expect(engine.adapter.host.descriptor().lifecycle).toBe('running');
      expect(scriptedEngine.events.some((event) => event.type === 'transcript'
        && event.role === 'assistant' && event.phase === 'completed' && event.turnId === longCommand.turnId),
      'the native long reply must still be running before the PUI interrupt').toBe(false);
      frames.running = pane.screen();
      pane.interrupt();
      await vi.waitFor(() => expect(commandPosts.some((command) => command.type === 'interrupt')).toBe(true),
        { timeout: 15_000, interval: 100 });
      await pane.waitFor('Message — Enter send', { timeoutMs: 30_000 });
      frames.interrupted = pane.screen();
      pane.write(followup);
      pane.enter();
      const finalChat = await waitForCorrelatedReply(followup, followupReply);
      await pane.waitForReply(followupReply);
      frames.followup = pane.screen();
      expect(finalChat.id).toBe(firstChat.id);
      expect(engine.adapter.host.descriptor().identity).toEqual(identity);
      expect(scriptedEngine.engines).toHaveLength(1);
      expect(commandPosts.filter((command) => command.type === 'owner_turn').map((command) => command.content))
        .toEqual([greeting, fileRequest, longRequest, followup]);
      expect(commandReplies.every((reply) => reply.status === 202 && !reply.replayed)).toBe(true);
      // RPC backends obtain their native identity asynchronously after the
      // launch response. The real greeting above proves the later handshake
      // and persisted native resume handle, independently of response timing.
      expect(sessionTraffic.filter((entry) => entry.path === '/api/adv/sessions/launch-su'))
        .toEqual([expect.objectContaining({ count: 1, attachedEngine: true, transport: 'structured' })]);

      // Inspect this launch's process family only, without printing argv or
      // touching an existing human/peer terminal. The real CLI has pipe stdio;
      // only the PUI process is attached to our allocated terminal.
      const processes: Array<{ pid: number; tty: string; name: string }> = [];
      const pending = [engine.pid()!, ...await childPids(pane.pty.pid)];
      const seen = new Set<number>();
      while (pending.length) {
        const pid = pending.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const rows = await processRows(['-o', 'tty=,comm=', '-p', String(pid)]);
        if (rows.trim()) {
          const [tty, ...name] = rows.trim().split(/\s+/);
          processes.push({ pid, tty, name: name.join(' ') });
        }
        pending.push(...await childPids(pid));
      }
      expect(processes.length).toBeGreaterThan(0);
      expect(processes.every((proc) => proc.tty === '?')).toBe(true);
      expect(processes.some((proc) => /zellij|tmux|xterm|gnome-terminal|konsole|wezterm|alacritty|kitty/.test(proc.name))).toBe(false);
      // Lose the native process and its in-memory host, then reconnect using
      // the installed PUI's conversation picker. This tests the production
      // resume door; the Hono fixture itself remains in the same process.
      const savedDescriptor = engine.adapter.host.descriptor();
      await pane.stop();
      await engine.close();
      await engine.done;
      const teardownRows = await db.adminSql`
        SELECT s.session_id, s.omp_thread_id, s.ended_at, s.pid AS native_pid,
               p.pid AS presence_pid, p.host AS presence_host,
               p.last_active_at <= s.ended_at AS activity_before_end,
               p.heartbeat_at <= s.ended_at AS heartbeat_before_end,
               EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated WHERE taken_by = s.coord_owner_id) AS held_features,
               EXISTS (SELECT 1 FROM harness_shared.engineer_issues WHERE assignee = s.coord_owner_id) AS held_issues,
               EXISTS (SELECT 1 FROM harness_shared.work_item_claims WHERE owner = s.coord_owner_id) AS held_claims,
               EXISTS (SELECT 1 FROM harness_shared.plan_item_claims WHERE owner = s.coord_owner_id) AS held_plan_claims
        FROM harness_shared.adv_sessions s
        LEFT JOIN harness_shared.coord_presence p ON p.owner_id = s.coord_owner_id
        WHERE s.id = ${identity.advSessionId}`;
      console.info('PUI_NATIVE_TEARDOWN_DIAGNOSTIC', JSON.stringify(teardownRows));
      engine.adapter.dispose();
      await putViewState('Plans');
      const resumedPane = new PuiPane(bin, operatorPort, home);
      let resumedDescriptor;
      const resumePrompt = 'Reply with RESUMED: followed immediately by the exact marker from my first greeting. Do not use tools.';
      const resumedReply = `RESUMED:${greetingReply}`;
      try {
        await resumedPane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        resumedPane.write('o');
        // Opening Agent Chat starts at the new-conversation composer. Select
        // the saved conversation before expecting any of its history.
        await resumedPane.waitFor(`pot ${HARNESS} · role operator · session new`);
        resumedPane.escape();
        await resumedPane.waitFor('i type · v speak');
        resumedPane.write('l');
        await resumedPane.waitFor('Conversation — Enter select');
        resumedPane.enter();
        await vi.waitFor(() => expect(scriptedEngine.engines).toHaveLength(2), { timeout: 120_000, interval: 100 });
        const resumedEngine = scriptedEngine.engines[1];
        await resumedEngine.ready;
        expect(resumedEngine.adapter.host.recent.map(({ event }) => event)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'transcript', phase: 'completed', role: 'assistant', content: followupReply }),
        ]));
        resumedPane.write('i');
        await resumedPane.waitForReply(followupReply);
        frames.history = resumedPane.screen();
        resumedDescriptor = resumedEngine.adapter.host.descriptor();
        expect(resumedDescriptor).toMatchObject({ identity, carry: savedDescriptor.carry,
          modes: savedDescriptor.modes, accountRoute: savedDescriptor.accountRoute,
          runtimeGeneration: savedDescriptor.runtimeGeneration + 1 });
        resumedPane.write(resumePrompt);
        resumedPane.enter();
        const resumedChat = await waitForCorrelatedReply(resumePrompt, resumedReply);
        await resumedPane.waitForReply(resumedReply);
        expect(resumedChat.id).toBe(firstChat.id);
        frames.resumed = resumedPane.screen();
      } catch (cause) {
        console.info('PUI_INSTALLED_RESUME_FAILURE', JSON.stringify(resumedPane.failureEvidence()));
        throw cause;
      } finally { await resumedPane.stop(); }
      expect(namedQueryRequests).not.toContain('network.board');
      expect(pipelineCellRequests).toEqual([]);
      console.info('PUI_INSTALLED_REAL_ENGINE_ACCEPTANCE', JSON.stringify({
        binary: bin, binarySha256, manifest, chatId: finalChat.id, identity, frames,
        greetingReply, fileResult, followupReply, resumedReply, resumedDescriptor, readStart, readEnd,
        commandTypes: commandPosts.map((command) => command.type), processes, traffic: sessionTraffic,
        initializeWarnings, optionalMemoryWarnings,
        assistantReplies: scriptedEngine.events.filter((event) => event.type === 'transcript'
          && event.phase === 'completed' && event.role === 'assistant' && event.channel === 'text'),
      }));
    } catch (cause) {
      console.info('PUI_INSTALLED_REAL_ENGINE_FAILURE', JSON.stringify({
        backend: scriptedEngine.backend, binary: bin, binarySha256, frames, ...pane.failureEvidence(),
      }));
      throw cause;
    } finally { await pane.stop().catch(() => {}); }
  }, 600_000);
});
