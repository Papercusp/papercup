/**
 * Regression pins for the per-session initialize.instructions enrichment
 * (memory-delivery-unification-2026-07-12 P-001).
 *
 * The critical properties, pinned against the REAL SDK Server (not a mock)
 * so an @modelcontextprotocol/sdk upgrade that changes the stored-handler
 * shape or the negotiation semantics fails HERE instead of silently
 * dropping the prelude or breaking version negotiation:
 *   1. takeStoredInitializeHandler finds the ctor-registered handler.
 *   2. Delegation preserves negotiation: supported version echoed,
 *      unsupported version → server's latest, capabilities/serverInfo intact.
 *   3. Delegation preserves the SDK side effects (clientCapabilities /
 *      clientVersion recorded on the Server).
 *   4. Enrichment replaces instructions; null/undefined/throwing enrich
 *      leaves the SDK result byte-identical (never-throws contract).
 */
import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {
  takeStoredInitializeHandler,
  wrapInitializeWithInstructions,
} from '../_mcp-initialize-enrich';

const STATIC_INSTRUCTIONS = 'STATIC BASE INSTRUCTIONS';

function makeServer(instructions: string | null = STATIC_INSTRUCTIONS) {
  return new Server(
    { name: 'test-server', version: '0.0.1' },
    {
      capabilities: { tools: { listChanged: true }, prompts: {} },
      ...(instructions ? { instructions } : {}),
    },
  );
}

function initializeRequest(protocolVersion: string) {
  return {
    method: 'initialize' as const,
    params: {
      protocolVersion,
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'test-client', version: '9.9.9' },
    },
  };
}

type InitResult = {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
  instructions?: string;
};

describe('takeStoredInitializeHandler', () => {
  it('finds the SDK ctor-registered initialize handler on a real Server', () => {
    const server = makeServer();
    const handler = takeStoredInitializeHandler(server);
    expect(handler).toBeTypeOf('function');
  });

  it('returns null on shapes without the private handler map', () => {
    expect(takeStoredInitializeHandler({})).toBeNull();
    expect(takeStoredInitializeHandler(null)).toBeNull();
    expect(takeStoredInitializeHandler(undefined)).toBeNull();
    expect(takeStoredInitializeHandler({ _requestHandlers: 'nope' })).toBeNull();
  });
});

describe('wrapInitializeWithInstructions — delegation preserves SDK negotiation', () => {
  it('echoes a supported protocol version and appends the enrichment', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async (base) => `${base}\n\nENRICHED`);

    const supported = SUPPORTED_PROTOCOL_VERSIONS[0];
    const res = (await wrapped(initializeRequest(supported), {})) as InitResult;

    expect(res.protocolVersion).toBe(supported);
    expect(res.serverInfo).toEqual({ name: 'test-server', version: '0.0.1' });
    expect(res.capabilities).toMatchObject({ tools: { listChanged: true } });
    expect(res.instructions).toBe(`${STATIC_INSTRUCTIONS}\n\nENRICHED`);
  });

  it('falls back to the latest protocol version for an unsupported one', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async () => null);

    const res = (await wrapped(initializeRequest('1999-01-01'), {})) as InitResult;
    expect(res.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('preserves the SDK side effects: clientCapabilities + clientVersion recorded', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async (base) => `${base} +x`);

    await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {});
    expect(server.getClientCapabilities()).toEqual({ roots: { listChanged: true } });
    expect(server.getClientVersion()).toEqual({ name: 'test-client', version: '9.9.9' });
  });
});

describe('wrapInitializeWithInstructions — never-throws / keep-base contract', () => {
  it('keeps the SDK result unchanged when enrich returns null', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async () => null);

    const res = (await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {})) as InitResult;
    expect(res.instructions).toBe(STATIC_INSTRUCTIONS);
  });

  it('keeps the SDK result unchanged when enrich THROWS', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async () => {
      throw new Error('memory backend down');
    });

    const res = (await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {})) as InitResult;
    expect(res.instructions).toBe(STATIC_INSTRUCTIONS);
    expect(res.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('keeps a server WITHOUT static instructions instruction-less when enrich yields nothing', async () => {
    const server = makeServer(null);
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async () => undefined);

    const res = (await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {})) as InitResult;
    expect(res.instructions).toBeUndefined();
  });

  it('can ADD instructions to a server that had none (prelude-only session)', async () => {
    const server = makeServer(null);
    const original = takeStoredInitializeHandler(server)!;
    const wrapped = wrapInitializeWithInstructions(original, async (base) => {
      expect(base).toBeUndefined();
      return 'PRELUDE ONLY';
    });

    const res = (await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {})) as InitResult;
    expect(res.instructions).toBe('PRELUDE ONLY');
  });

  it('passes the request extra through to enrich (URL/header resolution seam)', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    let seenExtra: unknown = null;
    const wrapped = wrapInitializeWithInstructions(original, async (_base, extra) => {
      seenExtra = extra;
      return null;
    });

    const marker = { requestInfo: { headers: {} } };
    await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), marker);
    expect(seenExtra).toBe(marker);
  });
});
