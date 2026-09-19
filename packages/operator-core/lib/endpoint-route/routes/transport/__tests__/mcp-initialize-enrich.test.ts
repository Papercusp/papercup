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
import { describe, it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {
  takeStoredInitializeHandler,
  wrapInitializeWithInstructions,
  buildInitializeStageTelemetry,
  isNativeInstructionBudgetClient,
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

function initializeRequest(protocolVersion: string, clientName = 'test-client') {
  return {
    method: 'initialize' as const,
    params: {
      protocolVersion,
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: clientName, version: '9.9.9' },
    },
  };
}

describe('isNativeInstructionBudgetClient', () => {
  it.each(['codex', 'codex-su', 'codex-cli', 'omp', 'omp-su', 'oh-my-pi', 'oh-my-pi (omp)'])(
    'recognizes native client name %s',
    (clientName) => {
      expect(isNativeInstructionBudgetClient(initializeRequest('2025-03-26', clientName))).toBe(true);
    },
  );

  it.each(['test-client', 'claude-code', 'papercusp_pui', 'codexish', ''])(
    'does not classify non-native client name %s',
    (clientName) => {
      expect(isNativeInstructionBudgetClient(initializeRequest('2025-03-26', clientName))).toBe(false);
    },
  );

  it('fails closed for malformed or missing client info', () => {
    expect(isNativeInstructionBudgetClient(undefined)).toBe(false);
    expect(isNativeInstructionBudgetClient({ params: {} })).toBe(false);
    expect(isNativeInstructionBudgetClient({ params: { clientInfo: { name: 42 } } })).toBe(false);
  });
});

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

  it('passes SDK-stage timing without exposing the request to telemetry helpers', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    let timing: { startedAtMs: number; sdkMs: number } | undefined;
    const wrapped = wrapInitializeWithInstructions(original, async (_base, _extra, seen) => {
      timing = seen;
      return null;
    });
    await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION), {});
    expect(timing?.startedAtMs).toEqual(expect.any(Number));
    expect(timing?.sdkMs).toEqual(expect.any(Number));
  });

  it('skips dynamic enrichment for a native client while retaining static instructions', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    const enrich = vi.fn(async () => 'SHOULD NOT BE USED');
    const wrapped = wrapInitializeWithInstructions(original, enrich, (req) => !isNativeInstructionBudgetClient(req));

    const res = (await wrapped(initializeRequest(LATEST_PROTOCOL_VERSION, 'codex-su'), {})) as InitResult;
    expect(res.instructions).toBe(STATIC_INSTRUCTIONS);
    expect(enrich).not.toHaveBeenCalled();
  });

  it('still enriches an ordinary client and passes the initialize request to enrich', async () => {
    const server = makeServer();
    const original = takeStoredInitializeHandler(server)!;
    let seenReq: unknown;
    const request = initializeRequest(LATEST_PROTOCOL_VERSION, 'ordinary-client');
    const wrapped = wrapInitializeWithInstructions(original, async (base, _extra, _timing, req) => {
      seenReq = req;
      return `${base}\n\nENRICHED`;
    }, (req) => !isNativeInstructionBudgetClient(req));

    const res = (await wrapped(request, {})) as InitResult;
    expect(res.instructions).toBe(`${STATIC_INSTRUCTIONS}\n\nENRICHED`);
    expect(seenReq).toBe(request);
  });
});

describe('buildInitializeStageTelemetry — slow/timeout-only privacy boundary', () => {
  const traceId = '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4';
  const stages = {
    sdkMs: 2,
    spawnContextMs: 3,
    userLookupMs: 5,
    preludeMs: 7,
    enrichmentMs: 15,
    totalMs: 17,
  };

  it('keeps a fast initialize silent', () => {
    expect(buildInitializeStageTelemetry({ traceId, pid: 7, outcome: 'enriched', slowMs: 100, stages })).toBeNull();
  });

  it('records timeouts regardless of duration and slow completions only', () => {
    expect(buildInitializeStageTelemetry({ traceId, pid: 7, outcome: 'timeout', slowMs: 100, stages })).toEqual({
      traceId,
      pid: 7,
      outcome: 'timeout',
      stages,
    });
    expect(buildInitializeStageTelemetry({ traceId, pid: 7, outcome: 'base', slowMs: 10, stages })?.outcome).toBe(
      'slow_base',
    );
  });

  it('emits only correlation, pid, outcome, and stage durations', () => {
    const record = buildInitializeStageTelemetry({ traceId, pid: 7, outcome: 'enriched', slowMs: 10, stages })!;
    expect(Object.keys(record).sort()).toEqual(['outcome', 'pid', 'stages', 'traceId']);
    expect(JSON.stringify(record)).not.toMatch(/client|request|header|method|tool|args|payload/i);
  });
});
