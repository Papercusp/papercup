/**
 * Shipping-gate Agent Chat E2E (own-tui-full-divorce-2026-08-24 P-022).
 *
 * This is intentionally above the reducer/parser layer:
 *
 *   installed/built `pui` -> real PTY -> production Hono operator app ->
 *   real owned loop -> real migrated Postgres
 *
 * The only fake is the external model-provider port. Keeping that seam
 * deterministic lets the gate prove success, HITL, provider failure and a
 * stalled/cancelled stream without spending credentials or depending on a
 * third-party service. The loop, capability projection/dispatch, PG approval
 * store, chat/session persistence, HTTP/SSE transport and Ratatui UI are real.
 */
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ModelRequest, ModelStreamEvent } from '../agent-loop/model-port';
import type { OrgTestDb } from '../../test/_org-test-db';
import { screenContains, VtScreen } from './vt-screen';

const scriptedProvider = vi.hoisted(() => ({
  mode: 'success' as 'success' | 'hitl' | 'failure' | 'stall',
  successText: 'PUI provider fixture replied',
  requests: [] as Array<{ messages: unknown[]; tools: string[] }>,
}));

// Provider-only fake: everything above ModelPort stays production-real.
vi.mock('../agent-loop/provider-router', () => ({
  createRoutedModelPort: () => ({
    async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
      scriptedProvider.requests.push({
        messages: req.messages,
        tools: (req.tools ?? []).map((tool) => tool.name),
      });
      if (scriptedProvider.mode === 'failure') {
        yield { type: 'error', message: 'PUI-E2E provider stream failed visibly' };
        return;
      }
      if (scriptedProvider.mode === 'stall') {
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) return resolve();
          const timer = setTimeout(resolve, 15_000);
          timer.unref?.();
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        yield req.signal?.aborted
          ? { type: 'stop', reason: 'aborted' }
          : { type: 'error', message: 'PUI-E2E stalled provider safety deadline fired' };
        return;
      }
      if (scriptedProvider.mode === 'hitl') {
        const hasResult = req.messages.some((message) => message.content.some((part) => part.type === 'tool_result'));
        if (!hasResult) {
          yield {
            type: 'tool_call',
            id: 'pui-e2e-call-1',
            name: 'capability:bash',
            input: {
              command: "printf 'PUI-E2E-HITL-OK'",
              description: 'prove real HITL capability round trip',
            },
          };
          yield {
            type: 'stop',
            reason: 'tool_use',
            usage: { inputTokens: 4, outputTokens: 2 },
          };
          return;
        }
        yield { type: 'text_delta', text: 'PUI HITL round-trip complete' };
        yield {
          type: 'stop',
          reason: 'end_turn',
          usage: { inputTokens: 8, outputTokens: 4 },
        };
        return;
      }
      yield { type: 'text_delta', text: scriptedProvider.successText };
      yield {
        type: 'stop',
        reason: 'end_turn',
        usage: { inputTokens: 6, outputTokens: 3 },
      };
    },
  }),
}));

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');
const HARNESS = 'papercusp';
const WORKSPACE = 'pui-agent-chat-e2e';
const OWNER = 'pui-agent-chat-e2e-owner';

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

/** Prefer the P-021 supported installed artifact, then current cargo output. */
function resolvePuiBinary(): string | null {
  const target = cargoTargetDir();
  const candidates = [
    process.env.PUI_BIN,
    path.join(process.env.HOME ?? '', '.cargo', 'bin', 'pui'),
    target ? path.join(target, 'debug', 'pui') : null,
    target ? path.join(target, 'release', 'pui') : null,
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
    path.join(TUI_DIR, 'target', 'release', 'pui'),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

function ensurePuiBinary(): string {
  const existing = resolvePuiBinary();
  if (existing) return existing;
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

function childPids(parent: number): number[] {
  const out = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parent)], { encoding: 'utf8' });
  return (out.stdout ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForNoChildren(parent: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (childPids(parent).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  expect(childPids(parent), `processes leaked below pui pid ${parent}`).toEqual([]);
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
  transcript: Array<{ role: string; content: string; error?: boolean }>;
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
  });

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

  const { app } = await import('../../../../apps/operator/bin/host-app');
  operatorServer = createAdaptorServer({
    fetch: async (request, env) => {
      const pathname = new URL(request.url).pathname;
      const isLaunch = pathname === '/api/adv/sessions/launch-su';
      const launchInput = isLaunch ? await request.clone().json() : null;
      const response = await app.fetch(request, env);
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
            headless: launchInput?.headless === true,
            deferred: result?.deferred === true,
            advSessionId: result?.advSessionId,
            nativeSessionPresent: Boolean(result?.nativeSession),
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
  await close(operatorServer);
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

beforeEach(async () => {
  sessionTraffic = [];
  scriptedProvider.mode = 'success';
  scriptedProvider.successText = 'PUI provider fixture replied';
  scriptedProvider.requests = [];
  await db.adminSql`
    TRUNCATE harness_shared.agent_chat_locks,
      harness_shared.agent_loop_approvals,
      harness_shared.agent_loop_sessions,
      harness_shared.agent_chats_consolidated CASCADE
  `;
  await putViewState('Plans');
});

describe.sequential('pui Agent Chat shipping gate (installed binary, real PTY/operator/PG)', () => {
  // Investigation evidence only. This intentionally describes the pre-fix
  // product and is never a passing release journey or a provider substitute.
  test.runIf(process.env.PUI_CAPTURE_BASELINE === '1')('captures the pre-fix first-message counterexample', async () => {
    const prompt = `PUI-BASELINE-${Date.now()}`;
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      await pane.waitFor(`pot ${HARNESS} · role operator · session new`);
      pane.escape();
      await pane.waitFor('i type · v speak');
      pane.write('i');
      pane.write(prompt);
      pane.enter();
      await pane.waitFor('su-session/events -> 404', { timeoutMs: 30_000 });
      expect(pane.screen()).toContain(prompt);
      expect(pane.screen()).toContain('Running — input locked');
      expect(sessionTraffic).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/api/adv/sessions/launch-su', status: 200,
          deferSpawn: true, headless: false, deferred: true, nativeSessionPresent: false }),
        expect.objectContaining({ method: 'GET', status: 404 }),
      ]));
      expect(scriptedProvider.requests).toHaveLength(0);
      console.info('PUI_BASELINE_COUNTEREXAMPLE', JSON.stringify({
        binary: bin, binarySha256, prompt, traffic: sessionTraffic, screen: pane.screen(),
      }));
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('restored non-chat -> visible Agent Chat -> real role -> streamed done -> persisted reopen', async () => {
    const prompt = `PUI-E2E-${Date.now()}-success`;
    scriptedProvider.successText = `streamed reply for ${prompt}`;
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      await pane.waitFor('Agent Chat');
      await pane.waitFor(`pot ${HARNESS} · role operator · session new`);

      // The first composer submission owns session creation. `s` is global
      // Sessions navigation; it no longer opens an agent-chat session picker.
      pane.escape();
      await pane.waitFor('i type · v speak');

      pane.write('i');
      pane.write(prompt);
      pane.enter();
      await pane.waitFor(scriptedProvider.successText, { timeoutMs: 30_000 });
      await pane.waitFor('Message — Enter send');

      const chat = await waitForPersistedChat(db, (candidate) =>
        candidate.transcript.some((turn) => turn.role === 'assistant' && turn.content === scriptedProvider.successText),
      );
      expect(chat?.role).toBe('operator');
      expect(chat?.transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: prompt }),
          expect.objectContaining({ role: 'assistant', content: scriptedProvider.successText }),
        ]),
      );
      expect(chat?.transcript.some((turn) => turn.role === 'assistant' && !turn.content.trim())).toBe(false);
      expect(scriptedProvider.requests.length).toBeGreaterThanOrEqual(1);

      await pane.stop();
      await putViewState('Plans');
      const reopened = new PuiPane(bin, operatorPort, home);
      try {
        await reopened.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
        reopened.write('o');
        await reopened.waitFor(prompt, { timeoutMs: 30_000 });
        await reopened.waitFor(scriptedProvider.successText);
      } finally {
        await reopened.stop();
      }
    } finally {
      await pane.stop().catch(() => {});
    }
  });

  test('real PG-backed HITL blocks on the exact call id, approves, executes, and resumes', async () => {
    scriptedProvider.mode = 'hitl';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      pane.write('PUI-E2E request a gated capability');
      pane.enter();
      await pane.waitFor('pui-e2e-call-1', { timeoutMs: 30_000 });
      await pane.waitFor('capability:bash');
      pane.write('\x19'); // Ctrl+Y — approve the exact pending call
      await pane.waitFor('PUI HITL round-trip complete', { timeoutMs: 30_000 });
      await pane.waitFor('Message — Enter send');

      const chat = await waitForPersistedChat(
        db,
        (candidate) =>
          candidate.transcript.at(-1)?.role === 'assistant' &&
          candidate.transcript.at(-1)?.content === 'PUI HITL round-trip complete',
      );
      expect(chat?.transcript.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'PUI HITL round-trip complete',
      });
      expect(scriptedProvider.requests).toHaveLength(2);
      expect(scriptedProvider.requests[0]?.tools).toContain('capability:bash');
    } finally {
      await pane.stop();
    }
  });

  test('provider/stream failure is visible, persisted as failure, and leaves the composer retryable', async () => {
    scriptedProvider.mode = 'failure';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      pane.write('PUI-E2E provider failure');
      pane.enter();
      await pane.waitFor('PUI-E2E provider stream failed visibly', { timeoutMs: 30_000 });
      await pane.waitFor('Message — Enter send');
      const chat = await waitForPersistedChat(
        db,
        (candidate) => candidate.transcript.at(-1)?.role === 'assistant' && candidate.transcript.at(-1)?.error === true,
      );
      expect(chat?.transcript.at(-1)).toMatchObject({
        role: 'assistant',
        error: true,
      });
      expect(chat?.transcript.at(-1)?.content).toContain('provider stream failed visibly');
    } finally {
      await pane.stop();
    }
  });

  test('stalled turn is visibly cancellable and a retry succeeds without an empty persisted assistant row', async () => {
    scriptedProvider.mode = 'stall';
    const pane = new PuiPane(bin, operatorPort, home);
    try {
      await pane.waitFor('o:Agent Chat', { timeoutMs: 40_000 });
      pane.write('o');
      pane.write('PUI-E2E stalled turn');
      pane.enter();
      await pane.waitFor('Ctrl+X cancel');
      pane.write('\x18');
      await pane.waitFor('cancelled — ready to retry', { timeoutMs: 10_000 });
      await pane.waitFor('Message — Enter send');

      scriptedProvider.mode = 'success';
      scriptedProvider.successText = 'PUI retry recovered';
      pane.write('PUI-E2E retry after cancel');
      pane.enter();
      await pane.waitFor(scriptedProvider.successText, { timeoutMs: 30_000 });

      const chat = await waitForPersistedChat(
        db,
        (candidate) =>
          candidate.transcript.at(-1)?.role === 'assistant' &&
          candidate.transcript.at(-1)?.content === scriptedProvider.successText,
      );
      expect(chat?.transcript.some((turn) => turn.role === 'assistant' && !turn.content.trim())).toBe(false);
      expect(chat?.transcript.at(-1)).toMatchObject({ role: 'assistant', content: scriptedProvider.successText });
    } finally {
      await pane.stop();
    }
  });

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
      await pane.waitFor('operator identity is internally inconsistent', { timeoutMs: 12_000 });
      await pane.waitFor('workspace');
    } finally {
      await pane.stop();
      await close(proxy);
    }
  });
});
