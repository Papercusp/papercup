import { describe, expect, it } from 'vitest';
import {
  buildMcpSessionSurfaceTraceEvent,
  mcpDataPlaneDegradedAtFromExtra,
  mcpTraceIdFromExtra,
  MCP_DATA_PLANE_DEGRADED_AT_HEADER,
  MCP_REQUEST_TRACE_HEADER,
} from './mcp-request-trace';

describe('buildMcpSessionSurfaceTraceEvent', () => {
  it('distinguishes a new MCP transport session while retaining the native-session correlation', () => {
    const nativeSessionId = 'native-codex-session-123';
    const listed = buildMcpSessionSurfaceTraceEvent({
      traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
      toolName: 'tools/list',
      stage: 'tools_list_completed',
      elapsedMs: 2,
      extra: {
        sessionId: 'mcp-transport-a',
        requestInfo: { headers: {
          'mcp-session-id': 'mcp-transport-a',
          'x-papercusp-native-session': nativeSessionId,
        } },
      },
      sessionKey: 'mcp-transport-a',
      sessionBaseline: 'recorded',
      servingGeneration: 'generation-1',
      outcome: 'success',
    });
    const rejected = buildMcpSessionSurfaceTraceEvent({
      traceId: '31abefb3-1770-443d-9a6f-37526761d3b0',
      toolName: 'coord:orient',
      stage: 'stale_contract_rejected',
      elapsedMs: 0,
      extra: {
        sessionId: 'mcp-transport-b',
        requestInfo: { headers: {
          'mcp-session-id': 'mcp-transport-b',
          'x-papercusp-native-session': nativeSessionId,
        } },
      },
      sessionKey: 'mcp-transport-b',
      sessionBaseline: 'missing',
      servingGeneration: 'generation-1',
      phase: 'pre_dispatch',
      outcome: 'rejected',
    });

    expect(listed).toMatchObject({
      stage: 'tools_list_completed',
      sessionBaseline: 'recorded',
      nativeSessionCarrier: 'header',
      servingGeneration: 'generation-1',
    });
    expect(rejected).toMatchObject({
      stage: 'stale_contract_rejected',
      phase: 'pre_dispatch',
      outcome: 'rejected',
      sessionBaseline: 'missing',
      servingGeneration: 'generation-1',
    });
    expect(rejected.mcpSessionKeyFingerprint).not.toBe(listed.mcpSessionKeyFingerprint);
    expect(rejected.wireMcpSessionIdFingerprint).not.toBe(listed.wireMcpSessionIdFingerprint);
    expect(rejected.nativeSessionClaimFingerprint).toBe(listed.nativeSessionClaimFingerprint);
    expect(JSON.stringify({ listed, rejected })).not.toContain(nativeSessionId);
  });
});

describe('mcpTraceIdFromExtra', () => {
  it('accepts only a bounded UUID trace header', () => {
    const valid = '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4';
    expect(
      mcpTraceIdFromExtra({
        requestInfo: { headers: { [MCP_REQUEST_TRACE_HEADER]: valid } },
      }),
    ).toBe(valid);
    for (const invalid of ['', 'caller-controlled', 'x'.repeat(200), '00000000-0000-0000-0000-000000000000']) {
      expect(
        mcpTraceIdFromExtra({
          requestInfo: { headers: { [MCP_REQUEST_TRACE_HEADER]: invalid } },
        }),
      ).toBeNull();
    }
  });
});

describe('mcpDataPlaneDegradedAtFromExtra', () => {
  it('accepts only a bounded positive integer timestamp', () => {
    const timestamp = 1_788_554_800_123;
    expect(
      mcpDataPlaneDegradedAtFromExtra({
        requestInfo: { headers: { [MCP_DATA_PLANE_DEGRADED_AT_HEADER]: String(timestamp) } },
      }),
    ).toBe(timestamp);

    for (const invalid of ['', '0', '-1', '1.5', 'not-a-timestamp', '8640000000000001', '9'.repeat(40)]) {
      expect(
        mcpDataPlaneDegradedAtFromExtra({
          requestInfo: { headers: { [MCP_DATA_PLANE_DEGRADED_AT_HEADER]: invalid } },
        }),
      ).toBeNull();
    }
  });
});
