/**
 * P-010 admission control (mcp-reliability-hardening-2026-07-11) — pin the
 * load-shed decision: only a POST tools/call is shed, only under CRITICAL loop
 * pressure, the body is peeked NON-destructively (the handler still gets it), and
 * the shed response is a retryable 429 the proxy absorbs.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMcpBody,
  shouldShedForPressure,
  evaluateAdmission,
  admissionShedResponse,
} from './mcp-admission';

const toolsCall = (id: unknown = 7) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'plans:get', arguments: {} } });

function post(body: string): Request {
  return new Request('http://127.0.0.1:3070/api/mcp?superuser=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('classifyMcpBody — only a tools/call is sheddable', () => {
  it('flags a tools/call and echoes its id', () => {
    expect(classifyMcpBody(toolsCall(42))).toEqual({ sheddable: true, id: 42 });
    expect(classifyMcpBody(toolsCall('abc'))).toEqual({ sheddable: true, id: 'abc' });
  });
  it('does NOT shed cheap protocol methods', () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'resources/list', 'prompts/list', 'notifications/initialized']) {
      expect(classifyMcpBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))).toEqual({ sheddable: false, id: null });
    }
  });
  it('sheds a batch that CONTAINS a tools/call and echoes the first call id', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
    ]);
    expect(classifyMcpBody(batch)).toEqual({ sheddable: true, id: 2 });
  });
  it('unparseable body → not sheddable (never shed blind)', () => {
    expect(classifyMcpBody('not json')).toEqual({ sheddable: false, id: null });
    expect(classifyMcpBody('')).toEqual({ sheddable: false, id: null });
  });
});

describe('shouldShedForPressure — critical band only, respects the kill-switch', () => {
  it('sheds only when enabled AND critical', () => {
    expect(shouldShedForPressure('critical', true)).toBe(true);
    expect(shouldShedForPressure('elevated', true)).toBe(false); // elevated still admits
    expect(shouldShedForPressure('ok', true)).toBe(false);
    expect(shouldShedForPressure('critical', false)).toBe(false); // kill-switch
  });
});

describe('admissionShedResponse — a retryable 429 the proxy absorbs', () => {
  it('is a 429 with Retry-After and a JSON-RPC error envelope echoing the id', async () => {
    const res = admissionShedResponse(9);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1'); // default
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 9, error: { data: { retryable: true, reason: 'loop_pressure_critical' } } });
  });
  it('honors an explicit Retry-After', () => {
    expect(admissionShedResponse(null, 3).headers.get('retry-after')).toBe('3');
  });
});

describe('evaluateAdmission — end-to-end gate against a real Request', () => {
  it('sheds a POST tools/call under critical pressure and does NOT consume the body', async () => {
    const req = post(toolsCall(5));
    const res = await evaluateAdmission(req, 'critical', true);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    // The gate peeked via req.clone() — the ORIGINAL body must still be readable by the handler.
    const passthroughBody = await req.text();
    expect(JSON.parse(passthroughBody).method).toBe('tools/call');
  });
  it('admits (null) when pressure is only elevated', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'elevated', true)).toBeNull();
  });
  it('admits (null) a non-tools/call even under critical pressure', async () => {
    const req = post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(await evaluateAdmission(req, 'critical', true)).toBeNull();
  });
  it('admits (null) when the kill-switch disables admission control', async () => {
    expect(await evaluateAdmission(post(toolsCall()), 'critical', false)).toBeNull();
  });
  it('never sheds a GET (SSE reconnect / discovery), even critical', async () => {
    const get = new Request('http://127.0.0.1:3070/api/mcp', { method: 'GET' });
    expect(await evaluateAdmission(get, 'critical', true)).toBeNull();
  });
});
