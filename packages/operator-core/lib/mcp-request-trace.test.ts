import { describe, expect, it } from 'vitest';
import {
  mcpDataPlaneDegradedAtFromExtra,
  mcpTraceIdFromExtra,
  MCP_DATA_PLANE_DEGRADED_AT_HEADER,
  MCP_REQUEST_TRACE_HEADER,
} from './mcp-request-trace';

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
