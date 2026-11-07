import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoute } from '../define-route';
import type { SessionArchiveStore } from '../../session-archive';
import { tryRematerializeFromArchive } from '../../../../../apps/operator/scripts/psu-launcher.mjs';

// These tests exercise archive state and the real HTTP route stack. Telemetry
// and the loopback-tier flag do not need a database for this private server.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => true),
}));

const state = vi.hoisted(() => ({
  root: '',
  store: null as unknown as SessionArchiveStore,
  restoreEntered: false,
  seedEntered: false,
  writeGate: Promise.resolve(),
  seedGate: Promise.resolve(),
}));

vi.mock('../../session-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-archive')>();
  return {
    ...actual,
    pgSessionArchiveStore: () => state.store,
    rematerializeSession: async (...args: Parameters<typeof actual.rematerializeSession>) => {
      state.restoreEntered = true;
      await state.writeGate;
      return actual.rematerializeSession(...args);
    },
  };
});

vi.mock('../../interactive-claude-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../interactive-claude-config')>()),
  ensureInteractiveClaudeConfig: async () => {
    state.seedEntered = true;
    await state.seedGate;
  },
}));

vi.mock('@papercusp/orchestrator/session-launch-dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return {
    ...actual,
    sessionClaudeConfigDir: (owner: string) => owner === 'su-archive-status-test'
      ? state.root : actual.sessionClaudeConfigDir(owner),
  };
});

type Route = { method: string; path: string; handler: (request: Request) => Promise<Response> };
const SESSION = 'ebf27730-2256-462c-ad5e-19b4331cb81b';
const TRANSCRIPT = '{"type":"user","message":{"content":"retained source"}}\n';
const RELPATH = `projects/archive-project/${SESSION}.jsonl`;
const posts: Array<Promise<Response>> = [];
const servers: Server[] = [];
let releaseWrite = () => {};
let releaseSeed = () => {};

async function route(method: string, path: string) {
  const routes = (await import('../routes/adv/sessions')).default as unknown as Route[];
  const found = routes.find(r => r.method === method && r.path === path);
  if (!found) throw new Error(`Missing ${method} ${path}`);
  return found;
}

async function startRestore() {
  const target = await route('POST', '/adv/sessions/rematerialize');
  const post = target.handler(new Request('https://operator.test/api/adv/sessions/rematerialize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, sourceKind: 'claude' }),
  }));
  posts.push(post);
}

async function statusResponse() {
  const target = await route('GET', '/adv/sessions/rematerialize/status');
  return target.handler(new Request(
    `https://operator.test/api/adv/sessions/rematerialize/status?sessionId=${SESSION}&sourceKind=claude`,
  ));
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'archive-status-'));
  state.restoreEntered = false;
  state.seedEntered = false;
  state.writeGate = Promise.resolve();
  releaseWrite = () => {};
  state.seedGate = new Promise<void>(resolve => { releaseSeed = resolve; });
  const blob = Buffer.from(TRANSCRIPT);
  const sha256 = createHash('sha256').update(blob).digest('hex');
  const stamp = {
    workspace_id: 'default', source_kind: 'claude', session_id: SESSION,
    owner: 'su-archive-status-test', cwd: '/repo', session_root: state.root,
    manifest: [{ relpath: RELPATH, sha256, bytes_raw: blob.length }],
  };
  state.store = {
    readStamp: async (kind: string, id: string) => kind === 'claude' && id === SESSION ? stamp : null,
    readFiles: async () => [{ relpath: RELPATH, codec: 'none', blob }],
  } as unknown as SessionArchiveStore;
});

afterEach(async () => {
  releaseWrite();
  releaseSeed();
  try {
    await Promise.all(posts.splice(0));
  } finally {
    try {
      await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      })));
    } finally {
      rmSync(state.root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }
});

describe('archive rematerialize status across an unfinished POST', () => {
  it('reports verified transcript bytes and their root while optional config seeding is pending', async () => {
    await startRestore();
    await vi.waitFor(() => expect(state.seedEntered).toBe(true), { timeout: 10_000 });

    expect(readFileSync(join(state.root, RELPATH), 'utf8')).toBe(TRANSCRIPT);
    const response = await statusResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'ready', ready: true, pending: false, sourceKind: 'claude', root: state.root,
      statuses: [{ ready: true, inFlight: true, root: state.root }],
    });
  });

  it('keeps a restore pending while the transcript has not been materialized', async () => {
    state.writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    await startRestore();
    await vi.waitFor(() => expect(state.restoreEntered).toBe(true), { timeout: 10_000 });

    expect(await (await statusResponse()).json()).toMatchObject({
      state: 'pending', ready: false, pending: true,
      statuses: [{ inFlight: true, ready: false }],
    });
  });

  it('lets the native launcher recover a timed-out POST and bind the exact restored source root', async () => {
    const statusLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sourceSession = { agent: 'claude', sessionId: SESSION, configDir: '/old/config' };
    const routes = (await import('../routes/adv/sessions')).default;
    const api = new Hono();
    for (const target of routes.filter(r => r.path === '/adv/sessions/rematerialize'
      || r.path === '/adv/sessions/rematerialize/status')) registerRoute(api, target);
    const app = new Hono().route('/api', api);
    let postFinished = false;
    const server = serve({
      hostname: '127.0.0.1', port: 0,
      fetch: (request, bindings) => {
        const response = Promise.resolve(app.fetch(request, bindings));
        if (request.method === 'POST') {
          posts.push(response.then(result => { postFinished = true; return result; }));
        }
        return response;
      },
    }) as Server;
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    const operatorUrl = `http://127.0.0.1:${address.port}`;
    const abortPost = new AbortController();
    const timeout = new DOMException('client restore deadline', 'TimeoutError');
    const statusResponses: Response[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const signal = AbortSignal.any([init.signal!, abortPost.signal]);
        const [response] = await Promise.all([
          fetch(url, { ...init, signal }),
          vi.waitFor(() => expect(state.seedEntered).toBe(true), { timeout: 10_000 })
            .then(() => abortPost.abort(timeout)),
        ]);
        return response;
      }
      const response = await fetch(url, init);
      statusResponses.push(response.clone());
      return response;
    });

    const restored = await tryRematerializeFromArchive(SESSION, 'claude', {
      fetchImpl, operatorUrl, token: 'test-token',
      statusAttempts: 1, sleep: async () => {}, sourceSession,
    });

    expect(abortPost.signal.reason).toBe(timeout);
    expect(readFileSync(join(state.root, RELPATH), 'utf8')).toBe(TRANSCRIPT);
    expect(posts).toHaveLength(1);
    expect(postFinished).toBe(false);
    expect(statusResponses).toHaveLength(1);
    expect(statusResponses[0].status).toBe(200);
    expect(await statusResponses[0].json()).toMatchObject({
      state: 'ready', ready: true, pending: false, sourceKind: 'claude', root: state.root,
      statuses: [{ ready: true, inFlight: true, root: state.root }],
    });
    expect(restored).toMatchObject({
      ok: true, restoredAfterTimeout: true, sourceKind: 'claude', root: state.root,
    });
    expect(sourceSession.configDir).toBe(state.root);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(statusLog).toHaveBeenCalledTimes(1);
    expect(statusLog).toHaveBeenCalledWith(expect.stringContaining(
      `transcript restored from the session archive (claude, 0 file(s) → ${state.root})`,
    ));
  });
});
