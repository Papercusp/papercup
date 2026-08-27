/**
 * The L4 gap closure — proves that the canonical MCP streamable-HTTP
 * client (the same one OMP uses) works against a transport whose
 * server runs **stateless** (`disableSse: true` / no Mcp-Session-Id).
 *
 * Up to now this was source-verified only: I read OMP's HttpTransport
 * and confirmed `#sessionId` is nullable and the header is omitted
 * when null. This test executes the contract end-to-end:
 *
 *   server: SDK StreamableHTTPServerTransport in stateless mode
 *         (sessionIdGenerator: undefined — same shape as operator's
 *         createMcpHandler({ disableSse: true }))
 *   client: SDK Client + StreamableHTTPClientTransport — the canonical
 *         streamable-HTTP client; what OMP wraps.
 *
 * Plus a faithful drive of the plugin's bundle path:
 *   - Mints power-user tokens against a stubbed /agent-tokens endpoint.
 *   - Calls fetchBundle / writeProfile (the real plugin code).
 *   - Reads back .mcp.json and uses its url+headers to connect.
 *   - Calls tools/list + tools/call to prove the catalog works.
 *   - Exercises a token refresh and continues using the connection
 *     (rewriteAccessToken + a second tools/call with the new token).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { fetchBundle, refreshAccessToken } from '../src/bundle-client.js';
import {
  writeProfile,
  rewriteAccessToken,
  cleanupProfile,
  type SessionProfile,
} from '../src/profile-writer.js';

/* ─── Force runtime-dir to a private tmp root for cleanup ────────────── */

const tmpRoot = mkdtempSync(join(tmpdir(), 'omp-l4-'));
process.env.XDG_RUNTIME_DIR = tmpRoot;
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

/* ─── Mock operator (HTTP + MCP) ─────────────────────────────────────── */

// Toy access-token table. Real verifier would HMAC; this is just so the
// MCP server can refuse unauthorized calls.
const ACCESS_TOKENS = new Map<
  string,
  { authSessionId: string; workspaceId: string; userId: string; exp: number }
>();
const REFRESH_TOKENS = new Map<
  string,
  { authSessionId: string; workspaceId: string; userId: string; exp: number }
>();

const TOOLS_MD = '# tools.md L4 fixture\n';
const PERSONA = '# persona L4 fixture\n';

function bearerFrom(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Build a fresh McpServer + StreamableHTTPServerTransport pair.
 *
 * In stateless mode (`sessionIdGenerator: undefined`) the SDK expects
 * a new pair PER REQUEST — same shape as `mcp-handler` with
 * `disableSse: true`. Sharing one pair across requests breaks the
 * post-initialize notification flow.
 */
function buildPerRequestMcp(): {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
} {
  const server = new McpServer(
    { name: 'mock-papercusp', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'echo back the text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
      {
        name: 'whoami',
        description: 'returns the auth-session for the request',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'echo') {
      const args = req.params.arguments as { text?: string };
      return { content: [{ type: 'text', text: args?.text ?? '' }] };
    }
    return { content: [{ type: 'text', text: 'unknown' }], isError: true };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  return { server, transport };
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const tok = bearerFrom(req);
  const claims = tok ? ACCESS_TOKENS.get(tok) : null;
  if (!claims || claims.exp <= Math.floor(Date.now() / 1000)) {
    jsonRes(res, 401, { error: 'invalid or expired access token' });
    return;
  }
  const body = await readBody(req);
  let parsed: unknown = undefined;
  if (body.length > 0) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      jsonRes(res, 400, { error: 'invalid json' });
      return;
    }
  }
  const { server, transport } = buildPerRequestMcp();
  await server.connect(transport);
  // Close the per-request pair after the response finishes.
  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });
  await transport.handleRequest(req, res, parsed);
}

/* ─── Wire up the full operator-shaped HTTP surface ──────────────────── */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      // 1. POST /api/agent-tokens/power-user
      if (req.method === 'POST' && url.pathname === '/api/agent-tokens/power-user') {
        const body = (await readBody(req)).toString('utf8') || '{}';
        const parsed = JSON.parse(body) as { workspace?: string };
        const workspaceId = (parsed.workspace ?? '').trim() || 'workspace-l4';
        const authSessionId = `pus-${randomUUID()}`;
        const userId = 'user-l4';
        const access = `acc-${randomUUID()}`;
        const refresh = `ref-${randomUUID()}`;
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const refExp = Math.floor(Date.now() / 1000) + 24 * 3600;
        ACCESS_TOKENS.set(access, { authSessionId, workspaceId, userId, exp });
        REFRESH_TOKENS.set(refresh, { authSessionId, workspaceId, userId, exp: refExp });
        jsonRes(res, 200, {
          access_token: access,
          access_expires_at: new Date(exp * 1000).toISOString(),
          refresh_token: refresh,
          refresh_expires_at: new Date(refExp * 1000).toISOString(),
          workspace_id: workspaceId,
          user_id: userId,
          auth_session_id: authSessionId,
        });
        return;
      }
      // 2. POST /api/agent-tokens/power-user/refresh
      if (req.method === 'POST' && url.pathname === '/api/agent-tokens/power-user/refresh') {
        const tok = bearerFrom(req);
        const claims = tok ? REFRESH_TOKENS.get(tok) : null;
        if (!claims || claims.exp <= Math.floor(Date.now() / 1000)) {
          jsonRes(res, 401, { error: 'invalid or expired refresh token' });
          return;
        }
        const access = `acc-${randomUUID()}`;
        const exp = Math.floor(Date.now() / 1000) + 3600;
        ACCESS_TOKENS.set(access, {
          authSessionId: claims.authSessionId,
          workspaceId: claims.workspaceId,
          userId: claims.userId,
          exp,
        });
        jsonRes(res, 200, {
          access_token: access,
          access_expires_at: new Date(exp * 1000).toISOString(),
        });
        return;
      }
      // 3. GET /api/agent-bundle
      if (req.method === 'GET' && url.pathname === '/api/agent-bundle') {
        const tok = bearerFrom(req);
        const claims = tok ? ACCESS_TOKENS.get(tok) : null;
        if (!claims) {
          jsonRes(res, 401, { error: 'invalid or expired access token' });
          return;
        }
        jsonRes(res, 200, {
          persona: PERSONA,
          toolsmd: TOOLS_MD,
          skills: [],
          hooks: [],
          mcp_url: `${url.origin}/api/mcp?power_user=1`,
          workspace: { id: claims.workspaceId, name: claims.workspaceId },
          user: { id: claims.userId, username: claims.userId, displayName: claims.userId },
          expires_at: new Date(claims.exp * 1000).toISOString(),
        });
        return;
      }
      // 4. The MCP endpoint (stateless).
      if (url.pathname === '/api/mcp') {
        await handleMcpRequest(req, res);
        return;
      }
      jsonRes(res, 404, { error: 'not found' });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ─── The actual end-to-end ──────────────────────────────────────────── */

const ListToolsResult = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});
const CallToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

async function mint(): Promise<{
  accessToken: string;
  refreshToken: string;
  authSessionId: string;
}> {
  const res = await fetch(`${baseUrl}/api/agent-tokens/power-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    auth_session_id: string;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    authSessionId: j.auth_session_id,
  };
}

function makeClient(): Client {
  return new Client(
    { name: 'l4-roundtrip-test', version: '0.0.1' },
    { capabilities: {} },
  );
}

describe('L4 — OMP-shaped MCP client against a stateless operator transport', () => {
  let profile: SessionProfile | null = null;
  afterAll(() => {
    if (profile) cleanupProfile(profile);
  });

  it('initialize → tools/list → tools/call works against `disableSse: true`', async () => {
    const { accessToken, authSessionId } = await mint();
    const bundle = await fetchBundle(`${baseUrl}/api/agent-bundle`, accessToken);
    profile = writeProfile(authSessionId, bundle, accessToken);

    // Read .mcp.json back the same way OMP would.
    const cfg = JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8')) as {
      mcpServers: { papercusp: { url: string; headers: Record<string, string> } };
    };
    const ent = cfg.mcpServers.papercusp;
    expect(ent.url).toBe(`${baseUrl}/api/mcp?power_user=1`);
    expect(ent.headers.Authorization).toBe(`Bearer ${accessToken}`);
    expect(ent.headers['x-papercusp-client']).toBe(
      '!printf %s "${PAPERCUSP_SID:-}"',
    );

    const transport = new StreamableHTTPClientTransport(new URL(ent.url), {
      requestInit: { headers: { Authorization: ent.headers.Authorization } },
    });
    const client = makeClient();

    // The actual handshake — the whole point of this test.
    await client.connect(transport);

    const list = await client.request({ method: 'tools/list' }, ListToolsResult);
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'whoami']);

    const call = await client.request(
      { method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello L4' } } },
      CallToolResult,
    );
    expect(call.content[0]?.text).toBe('hello L4');

    await client.close();
  });

  it('connects with no Mcp-Session-Id ever received from the server', async () => {
    // This is the heart of the source-verified-only gap. The MCP spec
    // makes Mcp-Session-Id optional; OMP's HttpTransport must tolerate
    // its absence. We send a raw initialize and assert the response
    // omits the header.
    const { accessToken } = await mint();
    const initRes = await fetch(`${baseUrl}/api/mcp?power_user=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0.0.1' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('mcp-session-id')).toBeNull();
  });

  it('rejects an MCP call with a bad token (transport-level auth gate)', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/api/mcp?power_user=1`),
      { requestInit: { headers: { Authorization: 'Bearer bogus' } } },
    );
    const client = makeClient();
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('token refresh: rewriteAccessToken swaps the header, a new client picks it up', async () => {
    const { accessToken, refreshToken, authSessionId } = await mint();
    const bundle = await fetchBundle(`${baseUrl}/api/agent-bundle`, accessToken);
    const p = writeProfile(authSessionId, bundle, accessToken);

    // First call works with the original token.
    {
      const cfg1 = JSON.parse(readFileSync(p.mcpConfigPath, 'utf8')) as {
        mcpServers: { papercusp: { url: string; headers: Record<string, string> } };
      };
      const t = new StreamableHTTPClientTransport(new URL(cfg1.mcpServers.papercusp.url), {
        requestInit: { headers: { Authorization: cfg1.mcpServers.papercusp.headers.Authorization } },
      });
      const c = makeClient();
      await c.connect(t);
      const list = await c.request({ method: 'tools/list' }, ListToolsResult);
      expect(list.tools.length).toBeGreaterThan(0);
      await c.close();
    }

    // Refresh, rewrite .mcp.json, simulate OMP picking up the new file.
    const refreshed = await refreshAccessToken(
      `${baseUrl}/api/agent-tokens/power-user/refresh`,
      refreshToken,
    );
    expect(refreshed.access_token).not.toBe(accessToken);
    rewriteAccessToken(p, bundle, refreshed.access_token);

    const cfg2 = JSON.parse(readFileSync(p.mcpConfigPath, 'utf8')) as {
      mcpServers: { papercusp: { url: string; headers: Record<string, string> } };
    };
    expect(cfg2.mcpServers.papercusp.headers.Authorization).toBe(
      `Bearer ${refreshed.access_token}`,
    );
    expect(cfg2.mcpServers.papercusp.headers['x-papercusp-client']).toBe(
      '!printf %s "${PAPERCUSP_SID:-}"',
    );

    // New client with the new header — works.
    {
      const t2 = new StreamableHTTPClientTransport(new URL(cfg2.mcpServers.papercusp.url), {
        requestInit: {
          headers: { Authorization: cfg2.mcpServers.papercusp.headers.Authorization },
        },
      });
      const c2 = makeClient();
      await c2.connect(t2);
      const r = await c2.request(
        { method: 'tools/call', params: { name: 'echo', arguments: { text: 'after refresh' } } },
        CallToolResult,
      );
      expect(r.content[0]?.text).toBe('after refresh');
      await c2.close();
    }

    cleanupProfile(p);
  });
});
