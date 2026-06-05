import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EndpointStreamEvent } from '@papercusp/desktop-ipc';

const h = vi.hoisted(() => ({
  httpCalls: [] as Array<{ opts: { overrideUrl?: string } }>,
}));

vi.mock('@papercusp/desktop-ipc', () => ({
  dispatchEndpointStreamHttp: (_n: string, _i: unknown, opts: { overrideUrl?: string }) => {
    h.httpCalls.push({ opts });
    return (async function* () {
      yield { kind: 'done', result: { content: [] } } as EndpointStreamEvent;
    })();
  },
  dispatchEndpointStreamIpc: () =>
    (async function* () {
      yield { kind: 'done', result: { content: [] } } as EndpointStreamEvent;
    })(),
}));

import { operatorToolResolver, installCallToolResolver } from './call-tool-resolver';
import { callTool, resetCallTool } from './call-tool';

beforeEach(() => {
  h.httpCalls.length = 0;
  resetCallTool();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('operatorToolResolver', () => {
  it('maps the seeded streaming tools to their canonical shim routes', () => {
    expect(operatorToolResolver('oracle:chat').route).toBe('/api/oracle/chat');
    expect(operatorToolResolver('operator:converse').route).toBe('/api/agent-mcp/operator-converse');
  });

  it('falls back to the projected convention for unmapped tools', () => {
    expect(operatorToolResolver('dev:ipc_echo').route).toBe('/api/agent-tools/dev/ipc_echo');
    expect(operatorToolResolver('something:else').route).toBe('/api/agent-tools/something/else');
    // operator:scan was UNMAPPED with the scanner teardown (D-005) — it now
    // projects like any unknown tool rather than hitting a dead shim route.
    expect(operatorToolResolver('operator:scan').route).toBe('/api/agent-tools/operator/scan');
  });

  it('maps operator:delegate to its delegate-chat shim route', () => {
    expect(operatorToolResolver('operator:delegate').route).toBe('/api/agent-mcp/delegate-chat');
  });

  it('Phase E: marks the verified self-contained tools direct-eligible', () => {
    for (const n of ['operator:converse', 'operator:delegate']) {
      expect(operatorToolResolver(n).directEligible).toBe(true);
    }
  });

  it('keeps route-dependent / parameterized / unmapped tools NOT direct-eligible', () => {
    // oracle:chat = route-dependent footgun; architect/brainstorm = harness-scoped
    // parameterized; dev:ipc_echo + unknowns = not in the audited set.
    for (const n of ['oracle:chat', 'architect:chat', 'brainstorm:chat', 'dev:ipc_echo', 'foo:bar']) {
      expect(operatorToolResolver(n).directEligible).toBe(false);
    }
  });
});

describe('installCallToolResolver', () => {
  it('makes callTool route through the operator resolver (canonical shim route)', async () => {
    installCallToolResolver();
    await callTool('oracle:chat', {});
    expect(h.httpCalls).toHaveLength(1);
    expect(h.httpCalls[0].opts.overrideUrl).toBe('/api/oracle/chat');
  });
});
