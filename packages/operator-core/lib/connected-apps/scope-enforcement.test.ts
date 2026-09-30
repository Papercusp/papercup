/**
 * external-app-access-to-workspaces-2026-09-29 P-003 — R-5 (a key reaches only the tools,
 * harnesses and workspace its scopes name) and R-6 (shell, files, admin and credential tools
 * are never reachable by an app key), on BOTH transports.
 *
 * Only the database handle is faked: it answers the connected_apps lookups (the auth chain's
 * `verifyAppKey` and the dispatch seat's `loadAppScopeRow`) with one row the test controls.
 * Everything above it is real — the HTTP `/api/agent-tools/*` catch-all, the MCP host
 * (`registerMcpHost` over an in-memory transport), the dispatcher, and the kernel port
 * `operatorKernelEnforcement` that calls `enforceAppKeyScope`.
 */
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** When set, what the DISPATCH SEAT's read (`loadAppScopeRow`) sees instead of `row`. */
  seatRow: undefined as Record<string, unknown> | null | undefined,
  seatReads: 0,
  /** Every fixture tool that actually ran — the negative assertions read this, not response text. */
  runs: [] as string[],
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(
    // Other modules in the transports' graphs also reach this client, some via postgres.js
    // helper calls (`sql(value)`) rather than a tagged template — answer those with no rows.
    async (strings: TemplateStringsArray | unknown) => {
      const text = Array.isArray(strings) ? strings.join('?') : '';
      if (!/SELECT[\s\S]*FROM harness_shared\.connected_apps/.test(text)) return [];
      // loadAppScopeRow names its columns literally; verifyAppKey interpolates them.
      if (/SELECT id, workspace_id, scopes, revoked_at/.test(text)) {
        db.seatReads += 1;
        const seat = db.seatRow === undefined ? db.row : db.seatRow;
        return seat ? [seat] : [];
      }
      return db.row ? [db.row] : [];
    },
    {
      unsafe: (fragment: string) => fragment,
      // A kernel denial records to the decision ledger through `sql.begin(tx => tx.unsafe(...))`;
      // answer it in-memory so the fire-and-forget insert does not warn (vitest-fail-on-console).
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
    },
  );
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});

// Mutation-probe seam (copy-out tier): `scripts/mutation-probe.sh --test
// 'PAPERCUSP_SCOPE_POLICY_PROBE={} …'` points the policy at a mutated COPY, so proving these
// guards falsifiable never mutates the shared tree. scope-policy.ts has only a type-only
// import, so the copy runs standalone. Unset (every normal run): the real module.
vi.mock('./scope-policy', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_SCOPE_POLICY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

// The MCP host's transport setup calls a bare `require(...)` for the SDK schemas.
(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/scope-enforcement-no-manifest.json';

const { registerProjectedTool, _resetProjectionRegistryForTests } = await import('@papercusp/agent-mcp');
type ProjectedTool = import('@papercusp/agent-mcp').ProjectedTool;
const { default: catchall } = await import('../endpoint-route/routes/agent-tools/catchall');
const { registerMcpHost, mcpHostServerOptions } = await import('../endpoint-route/routes/transport/_mcp-host');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { mintAppKey } = await import('./key');
type RouteContext = import('../endpoint-route/define-route').RouteContext;
type Transport = import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
type MessageExtraInfo = import('@modelcontextprotocol/sdk/types.js').MessageExtraInfo;

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const postRoute = catchall.find((d) => d.method === 'POST');
if (!postRoute) throw new Error('agent-tools catchall has no POST route');

/** A fixture tool that echoes who called it; `group:verb` decides its policy class. */
function echoTool(name: string, over: Partial<ProjectedTool> = {}): ProjectedTool {
  const path = `/api/agent-tools/${name.replace(':', '/')}`;
  return {
    pluginName: 'agent-mcp',
    description: `fixture ${name}`,
    inputSchema: { type: 'object', properties: { harness: { type: 'string' } } },
    capabilities: [],
    public: true,
    expose: { http: { path, methods: ['POST'] }, mcp: { name } },
    fn: async (_input, ctx) => {
      db.runs.push(name);
      return { content: [{ type: 'text', text: JSON.stringify({ ran: name, slug: ctx.principal?.slug ?? null }) }] };
    },
    ...over,
  };
}

const IN_SCOPE = 'fix:app-whoami';
const OUT_OF_SCOPE = 'fix:app-other';
/** A hard-deny GROUP (dev:*) with no dangerous capability string — the curated half of R-6. */
const HARD_DENIED_GROUP = 'dev:fixture-restart';
/** A hard-deny CAPABILITY (capability:*) in an ordinary group — the derived half of R-6. */
const HARD_DENIED_CAPABILITY = 'fix:fixture-shell';

function appRow(tokenHash: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_email: 'owner@example.com',
    workspace_id: 'ws-app',
    kind: 'app',
    label: 'ci bot',
    // The row LISTS the hard-denied tools too: a tampered or pre-existing row must still be
    // refused at call time, not only at issue time.
    scopes: {
      capabilities: ['capability:bash'],
      tools: [IN_SCOPE, HARD_DENIED_GROUP, HARD_DENIED_CAPABILITY],
      harnesses: ['h-allowed'],
    },
    limits: {},
    paired_at: new Date('2026-09-29T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    token_hash: tokenHash,
    ...over,
  };
}

let minted: ReturnType<typeof mintAppKey>;

beforeEach(() => {
  _resetProjectionRegistryForTests();
  registerProjectedTool(echoTool(IN_SCOPE));
  registerProjectedTool(echoTool(OUT_OF_SCOPE));
  registerProjectedTool(echoTool(HARD_DENIED_GROUP));
  registerProjectedTool(echoTool(HARD_DENIED_CAPABILITY, { capabilities: ['capability:bash'] }));
  minted = mintAppKey();
  db.row = appRow(minted.tokenHash, minted.id);
  db.seatRow = undefined;
  db.seatReads = 0;
  db.runs = [];
});

// ── HTTP ────────────────────────────────────────────────────────────────────────

async function httpCall(name: string, args: Record<string, unknown> = {}): Promise<{ status: number; text: string }> {
  const res = await postRoute!.handler(
    new Request(`http://x.test/api/agent-tools/${name.replace(':', '/')}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${minted.key}` },
      body: JSON.stringify(args),
    }),
    CTX,
  );
  return { status: res.status, text: await res.text() };
}

describe('HTTP /api/agent-tools — app key scope (R-5, R-6)', () => {
  it('R-5: a tool in the key allowlist runs as app:<id>', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { content: Array<{ text: string }> };
    expect(JSON.parse(body.content[0].text)).toEqual({ ran: IN_SCOPE, slug: `app:${minted.id}` });
    // Positive control for every `db.runs` negative below: the recorder sees a real run.
    expect(db.runs).toEqual([IN_SCOPE]);
  });

  it('R-5: a tool NOT in the allowlist is refused and never runs', async () => {
    const res = await httpCall(OUT_OF_SCOPE, { harness: 'h-allowed' });
    expect(res.status).not.toBe(200);
    expect(res.text).toContain('app_scope:tool_not_in_scope');
    expect(db.runs).not.toContain(OUT_OF_SCOPE);
  });

  it('R-5: a harness outside the key allowlist is refused', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-other' });
    expect(res.status).not.toBe(200);
    expect(res.text).toContain('app_scope:harness_not_in_scope');
  });

  it('R-5: a harness-accepting tool must name an allowed harness when the key is harness-limited', async () => {
    const res = await httpCall(IN_SCOPE, {});
    expect(res.text).toContain('app_scope:harness_required_by_scope');
  });

  it('R-5: an argument naming another workspace is refused', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed', workspace: 'ws-other' });
    expect(res.text).toContain('app_scope:workspace_mismatch');
  });

  it('R-6: a hard-denied tool group is refused even though the row lists it', async () => {
    const res = await httpCall(HARD_DENIED_GROUP, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:hard_denied');
    expect(db.runs).not.toContain(HARD_DENIED_GROUP);
  });

  it('R-6: a tool needing a capability:* grant is refused even though the key holds it', async () => {
    const res = await httpCall(HARD_DENIED_CAPABILITY, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:hard_denied');
    expect(db.runs).not.toContain(HARD_DENIED_CAPABILITY);
  });

  it('the dispatch seat re-reads the row: a key paused after authentication is stopped', async () => {
    db.seatRow = { ...db.row!, paused_at: new Date() };
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(db.seatReads).toBeGreaterThan(0);
    expect(res.text).toContain('app_scope:key_paused');
    expect(db.runs).not.toContain(IN_SCOPE);
  });

  it('a key deleted between authentication and dispatch is refused (fail closed)', async () => {
    db.seatRow = null;
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:key_unknown');
  });
});

// ── MCP ─────────────────────────────────────────────────────────────────────────

async function withMcpClient<T>(run: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const extra = {
    requestInfo: {
      url: 'http://127.0.0.1:3070/api/mcp',
      headers: { host: '127.0.0.1:3070', authorization: `Bearer ${minted.key}` },
    },
  } as unknown as MessageExtraInfo;
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  let requestInfo: MessageExtraInfo | undefined;
  const transport: Transport = {
    async start() {
      serverWire.onmessage = (message) => transport.onmessage?.(message, requestInfo);
      serverWire.onclose = () => transport.onclose?.();
      serverWire.onerror = (error) => transport.onerror?.(error);
      await serverWire.start();
    },
    send: (message) => serverWire.send(message),
    close: () => serverWire.close(),
  };
  const server = new McpServer({ name: 'app-scope', version: '1' }, mcpHostServerOptions());
  registerMcpHost(server);
  const client = new Client({ name: 'app-scope-client', version: '1' });
  try {
    await server.connect(transport);
    await client.connect(clientWire);
    requestInfo = extra;
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const mcpText = (r: { content?: unknown }): string =>
  ((r.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

describe('MCP /api/mcp — app key scope (R-5, R-6)', () => {
  it('R-5 + R-6: tools/list shows exactly the in-scope tool — no out-of-scope or hard-denied tool', async () => {
    const names = await withMcpClient(async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain(IN_SCOPE);
    expect(names).not.toContain(OUT_OF_SCOPE);
    expect(names).not.toContain(HARD_DENIED_GROUP);
    expect(names).not.toContain(HARD_DENIED_CAPABILITY);
  });

  it('R-5: an in-scope call runs as app:<id>', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: IN_SCOPE, arguments: { harness: 'h-allowed' } }));
    expect(res.isError ?? false).toBe(false);
    expect(mcpText(res)).toContain(`app:${minted.id}`);
    expect(db.runs).toEqual([IN_SCOPE]);
  });

  it('R-5: a direct call to an unlisted tool is refused', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: OUT_OF_SCOPE, arguments: { harness: 'h-allowed' } }));
    expect(res.isError).toBe(true);
    expect(mcpText(res)).toContain('app_scope:tool_not_in_scope');
  });

  it('R-5: a disallowed harness is refused', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: IN_SCOPE, arguments: { harness: 'h-other' } }));
    expect(res.isError).toBe(true);
    expect(mcpText(res)).toContain('app_scope:harness_not_in_scope');
  });

  it('R-6: a direct call to a hard-denied tool is refused', async () => {
    for (const name of [HARD_DENIED_GROUP, HARD_DENIED_CAPABILITY]) {
      const res = await withMcpClient((client) => client.callTool({ name, arguments: { harness: 'h-allowed' } }));
      expect(res.isError, name).toBe(true);
      expect(mcpText(res), name).toContain('app_scope:hard_denied');
      expect(db.runs, name).not.toContain(name);
    }
  });
});
