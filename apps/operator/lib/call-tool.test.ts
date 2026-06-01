import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EndpointStreamEvent } from '@papercusp/desktop-ipc';

// Capture which adapter the picker chose + with what args; `events` lets a test
// drive the stream the chosen adapter yields. Hoisted so the vi.mock factory can
// close over it.
const h = vi.hoisted(() => ({
  httpCalls: [] as Array<{ name: string; input: unknown; opts: { overrideUrl?: string } }>,
  ipcCalls: [] as Array<{ name: string; input: unknown; opts: unknown }>,
  events: null as EndpointStreamEvent[] | null,
}));

vi.mock('@papercusp/desktop-ipc', () => ({
  dispatchEndpointStreamHttp: (name: string, input: unknown, opts: { overrideUrl?: string }) => {
    h.httpCalls.push({ name, input, opts });
    const evs = h.events ?? [
      { kind: 'done', result: { content: [{ type: 'text', text: 'http-ok' }] } } as EndpointStreamEvent,
    ];
    return (async function* () {
      for (const e of evs) yield e;
    })();
  },
  dispatchEndpointStreamIpc: (name: string, input: unknown, opts: unknown) => {
    h.ipcCalls.push({ name, input, opts });
    return (async function* () {
      yield { kind: 'done', result: { content: [{ type: 'text', text: 'ipc-ok' }] } } as EndpointStreamEvent;
    })();
  },
}));

import {
  callTool,
  callRoute,
  configureCallTool,
  resetCallTool,
  CallToolError,
} from './call-tool';

function clearTauri(): void {
  const g = globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } };
  if (g.window) delete g.window.__TAURI_INTERNALS__;
  else delete (g as { window?: unknown }).window;
}
function setTauri(): void {
  const g = globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } };
  if (!g.window) (g as { window?: unknown }).window = {};
  g.window!.__TAURI_INTERNALS__ = { invoke: () => {} };
}

beforeEach(() => {
  h.httpCalls.length = 0;
  h.ipcCalls.length = 0;
  h.events = null;
  resetCallTool();
  clearTauri();
});

describe('callTool — transport picker (Phase A: default route-preserving, direct off)', () => {
  it('defaults to the route-preserving (http/sys:http) transport with the projected route', async () => {
    const r = await callTool('operator:scan', { a: 1 });
    expect(h.httpCalls).toHaveLength(1);
    expect(h.ipcCalls).toHaveLength(0);
    expect(h.httpCalls[0].name).toBe('operator:scan');
    expect(h.httpCalls[0].input).toEqual({ a: 1 });
    expect(h.httpCalls[0].opts.overrideUrl).toBe('/api/agent-tools/operator/scan');
    expect(r.content[0].text).toBe('http-ok');
  });

  it('honors an explicit route override (custom shim)', async () => {
    await callTool('oracle:chat', {}, { route: '/api/oracle/chat' });
    expect(h.httpCalls[0].opts.overrideUrl).toBe('/api/oracle/chat');
  });

  it('honors a resolver-supplied route', async () => {
    configureCallTool(() => ({ route: '/api/custom/path', directEligible: false }));
    await callTool('x:y', {});
    expect(h.httpCalls[0].opts.overrideUrl).toBe('/api/custom/path');
  });

  it('the DEFAULT resolver never marks a tool eligible — direct stays off even on the desktop', async () => {
    setTauri();
    await callTool('operator:scan', {});
    expect(h.ipcCalls).toHaveLength(0);
    expect(h.httpCalls).toHaveLength(1);
  });

  it('uses DIRECT dispatch only for an eligible tool AND only on the desktop', async () => {
    setTauri();
    configureCallTool(() => ({ route: '/api/agent-tools/x', directEligible: true }));
    const r = await callTool('x', {});
    expect(h.ipcCalls).toHaveLength(1);
    expect(h.httpCalls).toHaveLength(0);
    expect(r.content[0].text).toBe('ipc-ok');
  });

  it('does NOT direct-dispatch off the desktop even if the tool is eligible', async () => {
    configureCallTool(() => ({ route: '/api/x', directEligible: true }));
    await callTool('x', {});
    expect(h.httpCalls).toHaveLength(1);
    expect(h.ipcCalls).toHaveLength(0);
  });
});

describe('callTool — result / error handling', () => {
  it('throws CallToolError on an error terminal', async () => {
    h.events = [{ kind: 'error', code: 'boom', message: 'nope' }];
    await expect(callTool('x', {})).rejects.toMatchObject({
      name: 'CallToolError',
      code: 'boom',
      message: 'nope',
    });
  });

  it('throws no_terminal when the stream ends without done/error', async () => {
    h.events = [{ kind: 'event', name: 'delta', data: { text: 'hi' } }];
    await expect(callTool('x', {})).rejects.toBeInstanceOf(CallToolError);
    await expect(callTool('x', {})).rejects.toMatchObject({ code: 'no_terminal' });
  });
});

describe('callRoute — arbitrary non-tool routes', () => {
  it('calls fetch with the path + init (polyfill carries it off-HTTP on desktop)', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = f as unknown as typeof fetch;
    await callRoute('/api/ui/presence', { method: 'POST' });
    expect(f).toHaveBeenCalledWith('/api/ui/presence', { method: 'POST' });
  });
});
