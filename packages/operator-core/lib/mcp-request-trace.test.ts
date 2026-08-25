import { describe, expect, it } from 'vitest';
import { mcpTraceIdFromExtra, MCP_REQUEST_TRACE_HEADER } from './mcp-request-trace';

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
