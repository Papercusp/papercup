import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mock = vi.hoisted(() => ({
  connect: vi.fn(), clientClose: vi.fn(), transportClose: vi.fn(), transport: vi.fn(),
  readDiscovery: vi.fn(), listTools: vi.fn(), callTool: vi.fn(),
}));
vi.mock('./endpoint-ipc-discovery', async original => ({
  ...await original<typeof import('./endpoint-ipc-discovery')>(),
  readAgentMcpDiscoveryForPort: mock.readDiscovery,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mock.connect; close = mock.clientClose;
    listTools(...args: unknown[]) { return mock.listTools(...args); }
    callTool(...args: unknown[]) { return mock.callTool(...args); }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async original => ({
  ...await original<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>(),
  StreamableHTTPClientTransport: class {
    close = mock.transportClose;
    constructor(...args: unknown[]) { mock.transport(...args); }
  },
}));
import { AgentMcpConnectionError, connectAgentMcp, prepareNativeOmpConfig } from './agent-mcp-client';

beforeEach(() => {
  vi.clearAllMocks();
  mock.readDiscovery.mockResolvedValue(null);
  mock.connect.mockResolvedValue(undefined);
  mock.clientClose.mockResolvedValue(undefined);
  mock.transportClose.mockResolvedValue(undefined);
  mock.listTools.mockResolvedValue({ tools: [] });
  mock.callTool.mockResolvedValue({ content: [] });
});

describe('owned MCP listed generation', () => {
  const listed = (generation: string | undefined) => ({ tools: [{ name: 'tools:invoke',
    inputSchema: { type: 'object' }, _meta: { 'papercusp/servingGeneration': generation } }] });
  const request = { name: 'tools:invoke', arguments: { name: 'work_items:complete', args: {} } };

  it('requires a measured generation and preserves the caller native identity with it', async () => {
    const { client } = await connectAgentMcp({ url: 'http://127.0.0.1:1/api/mcp' });
    await expect(client.callTool(request)).rejects.toThrow(/listed serving generation/);
    mock.listTools.mockResolvedValueOnce(listed(undefined));
    await client.listTools();
    await expect(client.callTool(request)).rejects.toThrow(/listed serving generation/);
    expect(mock.callTool).not.toHaveBeenCalled();
    const catalog = listed('generation:first');
    mock.listTools.mockResolvedValueOnce(catalog);
    const page = await client.listTools();
    page.tools[0]._meta!['papercusp/servingGeneration'] = 'caller-mutated';
    await client.callTool({ ...request, _meta: { threadId: 'native', callId: 'call-1' } });
    expect(mock.callTool.mock.calls[0][0]).toMatchObject({ _meta: {
      threadId: 'native', callId: 'call-1', 'papercusp/servingGeneration': 'generation:first' } });
  });

  it('does not refresh or replay a stale mutation and refuses a contradictory declaration', async () => {
    const { client } = await connectAgentMcp({ url: 'http://127.0.0.1:1/api/mcp' });
    mock.listTools.mockResolvedValueOnce(listed('generation:first'));
    await client.listTools();
    mock.callTool.mockRejectedValueOnce(new Error('stale_tool_contract'));
    await expect(client.callTool(request)).rejects.toThrow(/stale_tool_contract/);
    expect(mock.listTools).toHaveBeenCalledTimes(1);
    expect(mock.callTool).toHaveBeenCalledTimes(1);
    await expect(client.callTool({ ...request, _meta: {
      'papercusp/servingGeneration': 'generation:second' } })).rejects.toThrow(/differs/);
    expect(mock.callTool).toHaveBeenCalledTimes(1);
    mock.listTools.mockResolvedValueOnce(listed('generation:second'));
    await client.listTools();
    await client.callTool(request);
    expect(mock.callTool.mock.calls[1][0]._meta).toEqual({ 'papercusp/servingGeneration': 'generation:second' });
  });

  it('invalidates a failed refresh and retains generations across catalog pages', async () => {
    const { client } = await connectAgentMcp({ url: 'http://127.0.0.1:1/api/mcp' });
    mock.listTools.mockResolvedValueOnce({ ...listed('generation:first'), nextCursor: 'next' });
    await client.listTools();
    await client.listTools({ cursor: 'next' });
    await client.callTool(request);
    mock.listTools.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(client.listTools()).rejects.toThrow(/catalog unavailable/);
    await expect(client.callTool(request)).rejects.toThrow(/listed serving generation/);
    expect(mock.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('owned MCP initialization failure evidence', () => {
  it('moves managed HTTP SU profiles to the owned client while preserving their connection', () => {
    const server = { url: 'http://127.0.0.1:3170/api/mcp?client=private-owner',
      headers: { Authorization: 'Bearer private-token' } };
    const text = JSON.stringify({ mcpServers: { 'papercusp-su': server } });
    const prepared = prepareNativeOmpConfig(text, { mode: 'http', observeNativeCalls: true });
    expect(prepareNativeOmpConfig(text, { mode: 'http' })).toBe(prepared);
    expect(JSON.parse(prepared)).toEqual({ mcpServers: {}, papercuspNativeMcp: {
      version: 1, mode: 'http', servers: { 'papercusp-su': server },
    } });
    expect(prepareNativeOmpConfig(prepared, { mode: 'http', observeNativeCalls: true })).toBe(prepared);
    const saved = JSON.stringify({ papercuspNativeMcp: { version: 1, mode: 'uds', home: '/saved-home',
      servers: { 'papercusp-su': server } }, mcpServers: { other: { url: 'http://localhost:3170/api/mcp' } } });
    expect(JSON.parse(prepareNativeOmpConfig(saved, { mode: 'http', observeNativeCalls: true })).papercuspNativeMcp)
      .toEqual({ version: 1, mode: 'uds', home: '/saved-home', servers: {
        'papercusp-su': server, other: { url: 'http://localhost:3170/api/mcp', headers: {} },
      } });
  });
  it('resolves the installed harness carrier without executing unknown shell headers', () => {
    const entry = { type: 'http', url: 'http://127.0.0.1:3170/api/mcp', headers: {
      'x-papercusp-client': '!printf %s "${PAPERCUSP_SID:-}"',
      'x-papercusp-harness': '!printf %s "${PAPERCUSP_HARNESS_SLUG:-}"',
    } };
    const text = JSON.stringify({ mcpServers: { 'papercusp-su': entry } });
    const result = JSON.parse(prepareNativeOmpConfig(text, { mode: 'http',
      env: { PAPERCUSP_SID: 'actual-session', PAPERCUSP_HARNESS_SLUG: 'actual-harness' } }));
    expect(result.mcpServers).toEqual({});
    expect(result.papercuspNativeMcp.servers['papercusp-su'].headers).toEqual({
      'x-papercusp-client': 'actual-session', 'x-papercusp-harness': 'actual-harness',
    });
    entry.headers['x-papercusp-harness'] = '!unknown-command';
    const unknown = JSON.stringify({ mcpServers: { 'papercusp-su': entry } });
    expect(JSON.parse(prepareNativeOmpConfig(unknown, { mode: 'http' })).mcpServers['papercusp-su'])
      .toEqual(entry);
  });
  it.each([
    [new McpError(ErrorCode.RequestTimeout, 'secret timeout'), { category: 'request-timeout' }],
    [new McpError(ErrorCode.ConnectionClosed, 'secret close'), { category: 'connection-closed' }],
    [new StreamableHTTPError(503, 'secret upstream'), { category: 'http-status', httpStatus: 503 }],
    [Object.assign(new Error('secret URL'), { cause: { code: 'ECONNREFUSED' } }), { category: 'network', systemCode: 'ECONNREFUSED' }],
    [Object.assign(new Error('secret'), { code: 'secret-untrusted-code' }), { category: 'unknown' }],
    [new StreamableHTTPError(999, 'secret'), { category: 'unknown' }],
    ['secret primitive', { category: 'unknown' }],
  ])('keeps only classified evidence for %o', (raw, diagnostic) => {
    const error = new AgentMcpConnectionError('http', raw);
    expect(error.message).toBe('http_connection_failed');
    expect(error.diagnostic).toEqual(diagnostic);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(String(error)).not.toContain('secret');
  });
  it('bounds recursive causes and does not serialize them', () => {
    const raw: { cause?: unknown } = {}; raw.cause = raw;
    expect(new AgentMcpConnectionError('uds', raw)).toMatchObject({ message: 'uds_connection_failed:unknown', diagnostic: { category: 'unknown' } });
  });
  it('surfaces only sanitized UDS cause classes for a missing socket, timeout, and MCP error', () => {
    const missingSocket = new AgentMcpConnectionError('uds',
      Object.assign(new Error('secret URL and bearer'), { cause: { code: 'ENOENT' } }));
    expect(missingSocket.message).toBe('uds_connection_failed:ENOENT');
    expect(missingSocket.diagnostic).toEqual({ category: 'network', systemCode: 'ENOENT' });
    expect(missingSocket.cause).toBeUndefined();
    expect(String(missingSocket)).not.toContain('secret');

    const timeout = new AgentMcpConnectionError('uds', new McpError(ErrorCode.RequestTimeout, 'secret timeout'));
    expect(timeout.message).toBe('uds_connection_failed:timeout');
    expect(String(timeout)).not.toContain('secret');

    const rpc = new AgentMcpConnectionError('uds', new McpError(-32042, 'secret JSON-RPC message'));
    expect(rpc.message).toBe('uds_connection_failed:mcp-json-rpc(-32042)');
    expect(rpc.diagnostic).toEqual({ category: 'mcp-error', mcpErrorCode: -32042 });
    expect(String(rpc)).not.toContain('secret');
  });
  it('surfaces sanitized ENOENT from a missing UDS socket without URL or credential data', async () => {
    mock.readDiscovery.mockResolvedValueOnce({
      version: 1,
      port: 3170,
      pid: 123,
      agentMcp: {
        socketPath: '/run/user/1000/secret-agent-mcp.sock',
        operatorId: 'secret-operator',
        generation: 'secret-generation',
      },
    });
    mock.connect.mockRejectedValueOnce(
      Object.assign(new Error('secret URL and bearer'), { cause: { code: 'ENOENT' } }),
    );

    let caught: unknown;
    try {
      await connectAgentMcp({
        url: 'http://127.0.0.1:3170/api/mcp?token=secret-token',
        headers: { Authorization: 'Bearer secret-token' },
        mode: 'uds',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentMcpConnectionError);
    expect(caught).toMatchObject({
      message: 'uds_connection_failed:ENOENT',
      diagnostic: { category: 'network', systemCode: 'ENOENT' },
    });
    expect(String(caught)).not.toContain('secret');
    expect(mock.readDiscovery).toHaveBeenCalledOnce();
  });
  it('closes both resources once without a retry or fallback, even when cleanup rejects', async () => {
    const raw = new McpError(ErrorCode.RequestTimeout, 'secret URL and bearer');
    mock.connect.mockRejectedValueOnce(raw);
    mock.clientClose.mockRejectedValueOnce(new Error('secret cleanup'));
    mock.transportClose.mockRejectedValueOnce(new Error('secret cleanup'));
    await expect(connectAgentMcp({ url: 'http://127.0.0.1:1/api/mcp?sig=secret',
      headers: { Authorization: 'Bearer secret' }, mode: 'http', timeoutMs: 123 }))
      .rejects.toMatchObject({ message: 'http_connection_failed', diagnostic: { category: 'request-timeout' } });
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.clientClose).toHaveBeenCalledOnce();
    expect(mock.transportClose).toHaveBeenCalledOnce();
    expect(mock.transport).toHaveBeenCalledOnce();
    expect(mock.connect.mock.calls[0][1]).toEqual({ timeout: 123 });
  });
  it('leaves successful connections open and uses the original URL and headers', async () => {
    const url = 'http://127.0.0.1:1/api/mcp?sig=unchanged';
    const headers = { Authorization: 'Bearer unchanged' };
    const result = await connectAgentMcp({ url, headers, mode: 'http' });
    expect(result.transportKind).toBe('http');
    expect(mock.transport.mock.calls[0][0].href).toBe(url);
    expect(mock.transport.mock.calls[0][1]).toEqual({ requestInit: { headers } });
    expect(mock.clientClose).not.toHaveBeenCalled();
    expect(mock.transportClose).not.toHaveBeenCalled();
  });
});
