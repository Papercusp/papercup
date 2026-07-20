/**
 * UI control surface — presence, list_clients, get_state, dispatch.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/ui-control.mjs.
 *
 * Stands up a fake browser tab (SSE consumer + result POSTer) and
 * drives the full agent ↔ UI round-trip end-to-end through the live
 * operator. Skipped when operator is not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { liveTest, probeLive, type SkippableTestContext } from '../testing/live-integration';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

let TOKEN = '';
try {
  TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
} catch { /* no token on disk — probe below fails closed */ }

const baseUrl = await probeLive(async () => {
  const probe = await fetch(`${BASE}/api/ui/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'probe', url: BASE, title: 'probe' }),
    signal: AbortSignal.timeout(3000),
  });
  return probe.status < 500;
}, 3000)
  ? BASE
  : '';

const itLive = baseUrl ? it : it.skip;

// EI-52: the file-load probe only confirms `/api/ui/presence` answers — it does NOT
// prove the SSE intents stream (opened in `beforeAll` below) will actually connect. When
// it doesn't, `startStream()`'s first `fetch` used to hang until Vitest's 60s hook
// timeout, which fails the HOOK itself and drags every one of this suite's 9 tests down
// with it (not a clean per-test skip). `degraded` lets `beforeAll` bound that connect
// attempt and fall back to a graceful per-test skip instead.
let degraded = false;

/** `itLive` test body wrapper for this file: skip when the SSE fixture never connected,
 * in addition to the live-transient handling `liveTest` already provides. */
function uiLiveTest(fn: () => Promise<void>): (ctx: SkippableTestContext) => Promise<void> {
  return liveTest(async () => {
    if (degraded) throw Object.assign(new Error('ui SSE fixture never connected'), { name: 'TimeoutError' });
    await fn();
  });
}

function uuid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function callTool(name: string, args: Record<string, unknown>, urlSuffix: string) {
  const r = await fetch(`${baseUrl}/api/mcp${urlSuffix}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    // _meta.format:'json' — the MCP result-format default flipped to compact (TOON-
    // rendered text); this test JSON.parses the result content, so declare json per-call
    // (P-009 negotiation: _meta.format wins over the URL ?format=).
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { format: 'json' } } }),
  });
  const body = await r.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data frame: ${body.slice(0, 200)}`);
  const env = JSON.parse(dataLine.slice('data:'.length).trim());
  const text: string = env.result?.content?.[0]?.text ?? '';
  return { text, isError: env.result?.isError === true };
}

class FakeBrowser {
  clientId: string;
  lastUrl: string;
  private aborter = new AbortController();
  private running: Promise<void>;
  private handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  private connectedResolve!: () => void;
  private connectedReject!: (e: unknown) => void;
  private readonly connectedPromise: Promise<void>;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.lastUrl = `${BASE}/test?tab=initial`;
    this.handlers = {
      'set_url': (args) => {
        const u = new URL(this.lastUrl);
        for (const [k, v] of Object.entries((args.params as Record<string, string | null>) ?? {})) {
          if (v === null) u.searchParams.delete(k);
          else u.searchParams.set(k, String(v));
        }
        this.lastUrl = u.toString();
        return { url: this.lastUrl };
      },
      'snapshot': () => ({ found: true, text: 'fake-snapshot' }),
      'refresh-build': (args) => ({ feature_registered: true, args }),
    };
    this.connectedPromise = new Promise((resolve, reject) => {
      this.connectedResolve = resolve;
      this.connectedReject = reject;
    });
    this.running = this.startStream();
  }

  /** Resolves once the SSE fetch's response headers arrive (connection established),
   * rejects if the connect attempt itself fails. EI-52: `beforeAll` races this against
   * a bound timeout instead of letting a never-connecting stream hang the hook. */
  connected(): Promise<void> {
    return this.connectedPromise;
  }

  private async startStream() {
    let r: Response;
    try {
      r = await fetch(`${baseUrl}/api/ui/intents/stream?client_id=${encodeURIComponent(this.clientId)}`, {
        headers: { Accept: 'text/event-stream' },
        signal: this.aborter.signal,
      });
    } catch (e) {
      this.connectedReject(e);
      return;
    }
    if (!r.body) {
      this.connectedReject(new Error('no SSE body'));
      return;
    }
    this.connectedResolve();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      try {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const dl = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dl) continue;
          const msg = JSON.parse(dl.slice(5).trim());
          await this.execute(msg);
        }
      } catch (e) {
        if (this.aborter.signal.aborted) return;
        throw e;
      }
    }
  }

  private async execute(msg: { id: string; intent: string; args?: Record<string, unknown> }) {
    let result: unknown = null;
    let error: string | null = null;
    try {
      const h = this.handlers[msg.intent];
      if (!h) error = `unknown_intent: ${msg.intent}`;
      else result = await h(msg.args ?? {});
    } catch (e) { error = (e as Error).message; }
    await fetch(`${baseUrl}/api/ui/intents/${msg.id}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result, error }),
    });
  }

  async heartbeat() {
    await fetch(`${baseUrl}/api/ui/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, url: this.lastUrl, title: 'Fake Browser' }),
    });
  }

  async stop() {
    this.aborter.abort();
    try { await this.running; } catch { /* aborted */ }
  }
}

describe('UI control surface (ui:list_clients / ui:get_state / ui:dispatch)', () => {
  let clientId: string;
  let browser: FakeBrowser;

  beforeAll(async () => {
    if (!baseUrl) return;
    clientId = uuid();
    browser = new FakeBrowser(clientId);
    // EI-52: bound the SSE connect attempt instead of letting a never-connecting stream
    // hang this hook to its full timeout — that used to fail the HOOK itself (dragging
    // every test in the file down as a hard failure) rather than cleanly skipping.
    try {
      await Promise.race([
        browser.connected(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sse_connect_timeout')), 8000)),
      ]);
    } catch {
      degraded = true;
      return;
    }
    await browser.heartbeat();
    await new Promise((r) => setTimeout(r, 500));
  }, 15_000);

  afterAll(async () => {
    if (browser) await browser.stop();
  });

  itLive('list_clients includes the new client', uiLiveTest(async () => {
    const res = JSON.parse((await callTool('ui:list_clients', {}, `?superuser=1&workspace=default`)).text);
    expect(res.clients.some((c: any) => c.client_id === clientId)).toBe(true);
    expect(res.self_client_id).toBeNull();
  }));

  itLive('ctx.uiClientId populated via &client= URL param', uiLiveTest(async () => {
    const res = JSON.parse((await callTool('ui:list_clients', {}, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(res.self_client_id).toBe(clientId);
    expect(res.clients.find((c: any) => c.client_id === clientId)?.is_self).toBe(true);
  }));

  itLive('get_state returns parsed params', uiLiveTest(async () => {
    const state = JSON.parse((await callTool('ui:get_state', {}, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(state.client_id).toBe(clientId);
    expect(state.params.tab).toBe('initial');
    expect(state.stale).toBe(false);
  }));

  itLive('get_state errors when no client_id available', uiLiveTest(async () => {
    const res = await callTool('ui:get_state', {}, `?superuser=1&workspace=default`);
    expect(res.text.startsWith('client_id_required')).toBe(true);
  }));

  itLive('dispatch set_url updates URL in FakeBrowser', uiLiveTest(async () => {
    const res = JSON.parse((await callTool('ui:dispatch', { intent: 'set_url', args: { params: { tab: 'sessions' } }, timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(res.status).toBe('done');
    expect(String(res.result?.url ?? '')).toContain('tab=sessions');
  }));

  itLive('dispatch feature-registered intent runs custom handler', uiLiveTest(async () => {
    const res = JSON.parse((await callTool('ui:dispatch', { intent: 'refresh-build', args: { reason: 'test' }, timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(res.status).toBe('done');
    expect(res.result?.feature_registered).toBe(true);
    expect(res.result?.args?.reason).toBe('test');
  }));

  itLive('dispatch unknown intent → error', uiLiveTest(async () => {
    const res = JSON.parse((await callTool('ui:dispatch', { intent: 'never-registered-xyz', timeout_ms: 3000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(res.status).toBe('error');
    expect(String(res.error ?? '')).toContain('unknown_intent');
  }));

  itLive('dispatch errors when no client_id available', uiLiveTest(async () => {
    const res = await callTool('ui:dispatch', { intent: 'set_url', args: {} }, `?superuser=1&workspace=default`);
    expect(res.text.startsWith('client_id_required')).toBe(true);
  }));

  itLive('dispatch timeout after browser stops responding', uiLiveTest(async () => {
    await browser.stop();
    const res = JSON.parse((await callTool('ui:dispatch', { intent: 'set_url', args: { params: { tab: 'never' } }, timeout_ms: 1000 }, `?superuser=1&workspace=default&client=${clientId}`)).text);
    expect(res.status).toBe('timeout');
    expect(String(res.error ?? '')).toContain('dispatch_timeout');
  }));
});
