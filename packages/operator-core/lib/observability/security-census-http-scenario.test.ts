import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn(), fetch: vi.fn() }));
vi.mock('../agent-mcp-client', () => ({ connectAgentMcp: h.connect }));
vi.mock('../superuser-token', () => ({ readSuperuserToken: () => 'private-test-bearer' }));
vi.mock('../text-artifacts', () => ({ loadImmutableTextArtifact: vi.fn() }));
vi.mock('../coverage-census/security-qualification', () => ({ verifyAuthenticatedRuntimeSecurityCensus: vi.fn() }));
import * as scenario from '../../test/security-census-http-scenario';

const url = new URL('http://127.0.0.1:3170/api/mcp?superuser=1&workspace=test-runtime-census');
const refusal = { isError: true, content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }] };

beforeEach(() => {
  vi.resetAllMocks();
  h.connect.mockResolvedValue({ client: { callTool: h.call, close: h.close } });
  h.call.mockResolvedValue(refusal);
  h.close.mockResolvedValue(undefined);
  // MCP initialize can succeed before the server authenticates tools/call.
  h.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => vi.unstubAllGlobals());

it('checks the producer dispatch after a successful MCP initialize', async () => {
  h.connect.mockResolvedValueOnce({ client: { callTool: h.call, close: h.close } })
    .mockRejectedValueOnce(new Error('valid-client-boundary'));
  await expect(scenario.measureSecurityCensusScenario({ workspace: 'test-runtime-census',
    base: 'http://127.0.0.1:3170', evidenceDir: '/unused', bundle: '/unused', hostPid: 1,
    expectedSha: 'abcdef0' })).rejects.toThrow('valid-client-boundary');
  expect(h.call).toHaveBeenCalledExactlyOnceWith({ name: 'dev:telemetry',
    arguments: { view: 'security-census', capture: true, harness: 'test-runtime-census' } },
  undefined, { timeout: 10_000 });
  expect(h.connect.mock.calls[0][0]).toMatchObject({ mode: 'http', timeoutMs: 10_000,
    headers: { Authorization: 'Bearer invalid-private-census-token' } });
  expect(h.close).toHaveBeenCalledOnce();
});

it('retains the exact producer auth refusal as the invalid-bearer proof', async () => {
  await expect(scenario.verifyInvalidSecurityCensusBearerRefusal(url, 'test-runtime-census'))
    .resolves.toEqual({ tool: 'dev:telemetry', reason: 'superuser_invalid_bearer', isError: true });
  expect(h.close).toHaveBeenCalledOnce();
});

it.each([
  { isError: false, content: refusal.content },
  { isError: true, content: [{ type: 'text', text: 'stale_tool_contract' }] },
  { isError: true, content: [{ type: 'text', text: 'request_rejected: superuser_non_loopback' }] },
  { isError: true, content: [] },
])('refuses unrelated or successful control results: %j', async result => {
  h.call.mockResolvedValueOnce(result);
  await expect(scenario.verifyInvalidSecurityCensusBearerRefusal(url, 'test-runtime-census')).rejects.toThrow();
  expect(h.close).toHaveBeenCalledOnce();
});

it('preserves a request failure and closes the invalid-bearer connection', async () => {
  h.call.mockRejectedValueOnce(new Error('request-timeout'));
  await expect(scenario.verifyInvalidSecurityCensusBearerRefusal(url, 'test-runtime-census'))
    .rejects.toThrow('request-timeout');
  expect(h.close).toHaveBeenCalledOnce();
});
