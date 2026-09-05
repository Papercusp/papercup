/**
 * Guard for the capability:fetch MCP-endpoint corrective (EI-20233057540755917).
 *
 * FALSIFIABILITY. The discriminating property here is NARROWNESS — the hint must
 * stay silent for everything that is not an MCP transport rejection — and a
 * subject that simply returned null forever would satisfy every narrowness
 * assertion perfectly. So this file keeps two deliberately-wrong controls
 * PERMANENTLY in-tree (they never touch production code, so no mutation probe
 * and no sweep race), each paired with a calibration case the REAL subject must
 * pass. Together they pin the property from both sides: the controls fail if the
 * subject stops discriminating, and the calibrations fail if it goes silent.
 */
import { describe, it, expect } from 'vitest';
import { mcpEndpointHint, type McpEndpointHintInput } from './fetch-mcp-hint';

const MCP_405: McpEndpointHintInput = {
  url: 'http://127.0.0.1:3170/api/mcp?superuser=1',
  method: 'GET',
  status: 405,
};

/** CONTROL A — ignores the pathname. Fires on any 405, MCP endpoint or not. */
function pathBlindHint(input: McpEndpointHintInput): string | null {
  return input.status === 405 ? 'blind: method not allowed' : null;
}

/** CONTROL B — ignores the status. Fires on any /api/mcp URL, including 200. */
function statusBlindHint(input: McpEndpointHintInput): string | null {
  try {
    return new URL(input.url).pathname === '/api/mcp' ? 'blind: mcp endpoint' : null;
  } catch {
    return null;
  }
}

describe('mcpEndpointHint', () => {
  it('fires on the measured failure: GET /api/mcp → 405', () => {
    const hint = mcpEndpointHint(MCP_405);
    expect(hint).not.toBeNull();
    // The load-bearing correction is the INVERSION — a 405 is evidence the host
    // is UP. Both measured GET callers read it as a failure instead.
    expect(hint).toMatch(/is up with the route mounted/);
    expect(hint).toMatch(/dev:service_health/);
    // ...and a runnable door carrying the caller's OWN port, not an example one.
    expect(hint).toContain('--port 3170');
    expect(hint).toContain('node scripts/mcp-call.mjs');
  });

  // Pinned after a peer (EI-20233090880522791) falsified an earlier draft that
  // claimed "initialize/tools/list then succeed". tools/list DOES bite, in a
  // different shape from tools/call, and all three are HTTP 200 — which is the
  // whole reason a status-keyed check cannot see the credential gate. Measured
  // against :3170 on 2026-09-05; if the transport ever changes shape, this fails
  // rather than leaving a confidently wrong recipe in the caller's hands.
  it('describes the bearer gate as three HTTP-200 shapes, not a tools/list success', () => {
    const hint = mcpEndpointHint(MCP_405) ?? '';
    // The two rejection shapes, named exactly as the server emits them.
    expect(hint).toContain('mcp_auth_failed: superuser_invalid_bearer');
    expect(hint).toContain('request_rejected: superuser_invalid_bearer');
    expect(hint).toContain('-32603');
    // The zero-tools misreading the server itself warns about.
    expect(hint).toMatch(/NO tools/);
    // And the property that makes all of it invisible to a status check.
    expect(hint).toMatch(/ALSO HTTP 200/);
    // The falsified claim must not come back.
    expect(hint).not.toMatch(/tools\/list then succeed/);
  });

  it('fires on 406 with the Accept-negotiation correction', () => {
    const hint = mcpEndpointHint({ ...MCP_405, method: 'POST', status: 406 });
    expect(hint).toMatch(/application\/json, text\/event-stream/);
    expect(hint).toContain('--port 3170');
  });

  it('carries the port the caller actually used (3070, not a hardcoded 3170)', () => {
    const hint = mcpEndpointHint({ ...MCP_405, url: 'http://127.0.0.1:3070/api/mcp' });
    expect(hint).toContain('--port 3070');
    expect(hint).not.toContain('--port 3170');
  });

  it('defaults the port by scheme when the URL omits one', () => {
    const hint = mcpEndpointHint({ ...MCP_405, url: 'https://example.test/api/mcp' });
    expect(hint).toContain('--port 443');
  });

  // ---- narrowness, each pinned against a control that gets it wrong ----

  it('stays silent for a 405 that is NOT the MCP endpoint (control A fires)', () => {
    const other: McpEndpointHintInput = {
      url: 'http://127.0.0.1:3170/api/health',
      method: 'GET',
      status: 405,
    };
    expect(mcpEndpointHint(other)).toBeNull();
    // CALIBRATION: the control fires here, so a null above is real discrimination
    // and not a subject that returned null for everything.
    expect(pathBlindHint(other)).not.toBeNull();
    expect(pathBlindHint(MCP_405)).not.toBeNull();
    expect(mcpEndpointHint(MCP_405)).not.toBeNull();
  });

  it('stays silent for a SUCCESSFUL POST to the MCP endpoint (control B fires)', () => {
    const okPost: McpEndpointHintInput = {
      url: 'http://127.0.0.1:3170/api/mcp?superuser=1',
      method: 'POST',
      status: 200,
    };
    expect(mcpEndpointHint(okPost)).toBeNull();
    // CALIBRATION: control B fires on this same input, so the null is a status
    // decision rather than a dead subject.
    expect(statusBlindHint(okPost)).not.toBeNull();
    expect(statusBlindHint(MCP_405)).not.toBeNull();
    expect(mcpEndpointHint(MCP_405)).not.toBeNull();
  });

  it('stays silent for unrelated error statuses on the MCP endpoint', () => {
    for (const status of [400, 401, 404, 500, 502]) {
      expect(mcpEndpointHint({ ...MCP_405, status })).toBeNull();
    }
  });

  it('does not throw on an unparseable URL', () => {
    expect(mcpEndpointHint({ url: 'not a url', method: 'GET', status: 405 })).toBeNull();
  });

  it('matches on pathname, so a path merely CONTAINING /api/mcp does not fire', () => {
    expect(
      mcpEndpointHint({ ...MCP_405, url: 'http://127.0.0.1:3170/docs/api/mcp/overview' }),
    ).toBeNull();
  });
});
