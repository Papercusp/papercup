/**
 * MCP transport gating matrix — drives the REAL `tools/list` / `tools/call`
 * request handlers registered by routes/transport/_mcp-handler.ts and pins
 * the auth → role → profile → workspace boundary end-to-end (the
 * "handler-path test for that wiring" that tool-auth-gating.test.ts's header
 * records as still owed).
 *
 * NOT duplicated here (already covered elsewhere):
 *   - tool-auth-gating.test.ts — the projected WRAPPER's principal+tx gate
 *     (`t.fn({}, {})` throws), issues:list's identity gate, and the
 *     operator-converse allowedTools↔registry sync.
 *   - transport-mcp-notifications.test.ts — buildMcpToolContext's emit /
 *     notifications/progress wiring.
 *   - tool-allowlist.test.ts — parseToolsAllowlist/filterListingsByAllowlist
 *     as unit functions (here we only pin their WIRING into tools/list).
 *   - role-principal-caps.test.ts — loadRoleCapabilities row/blueprint logic
 *     and effectiveDispatchWorkspace as a unit (here: its dispatch wiring).
 *
 * Harness: `createMcpHandler` is mocked to capture the JSON-RPC request
 * handlers; the registry is the REAL one (agent-tools/index side-effect
 * import) plus two synthetic probe tools under the 'gating-matrix-test'
 * plugin. PG seams (db-org, spawn-signing, power-user-token, superuser
 * bearer, harness paths) are stubbed; everything between the request handler
 * and the tool fn — tryBuildSpawnContext, the profile gate, the power-user
 * clamp, EI-30 workspace promotion, tx/principal synthesis, the tooldef
 * dispatch stack — runs for real.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const h = vi.hoisted(() => {
  const fakeTx = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
  });
  const fakeSql = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx),
  });
  return {
    fakeTx,
    fakeSql,
    /** scoped-superuser-workspace-clamp: dispatch tests toggle the flag via this. */
    scopedClampFlag: { value: false },
    /** Hive-tier resolver seam: maps a harness → its hive home slug (null = no hive). */
    hiveHomeSlugForHarness: vi.fn(
      async (_ws: string, harness: string): Promise<string | null> =>
        harness === 'hiveA-home' || harness === 'hiveA-member'
          ? 'hiveA-home'
          : harness === 'hiveB-home'
            ? 'hiveB-home'
            : null,
    ),
    /**
     * Workspace-tier resolver seam (P-017): maps (preferredWs, harness) → the
     * workspace that carries the harness. 'foreign-ws-harness' lives in another
     * workspace; 'unregistered-harness' is nowhere; everything else resolves to
     * the caller's OWN (preferred) workspace.
     */
    resolveWorkspaceForHarnessSlugIn: vi.fn(
      async (preferredWs: string, harness: string): Promise<string | null> =>
        harness === 'foreign-ws-harness'
          ? 'other-ws'
          : harness === 'unregistered-harness'
            ? null
            : preferredWs,
    ),
    /** Every workspace id the (mocked) withWorkspace opened a tx for. */
    withWorkspaceCalls: [] as string[],
    handlers: new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>(),
    verifySpawnParams: vi.fn(
      async (_u: unknown): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }),
    ),
    logVerificationFailure: vi.fn(async (_rec: unknown): Promise<void> => {}),
    verifyAccessToken: vi.fn(
      async (_bearer: string): Promise<Record<string, unknown> | null> => null,
    ),
    isValidSuperuserBearer: vi.fn(
      (bearer: string | null | undefined): boolean => bearer === 'test-su-bearer',
    ),
    /** SID→adv-row workspace fallback seam (psu-workspace-scoping fix). */
    workspaceForCoordOwner: vi.fn(async (_sid: string): Promise<string | null> => null),
  };
});

// Capture the ListTools/CallTool handlers instead of standing up the real
// streamable-HTTP transport. Keyed by the SDK schema's method literal.
vi.mock('mcp-handler', () => ({
  createMcpHandler: (
    setup: (server: {
      server: { setRequestHandler: (schema: unknown, fn: unknown) => void };
    }) => void,
  ) => {
    setup({
      server: {
        setRequestHandler: (schema: unknown, fn: unknown) => {
          const s = schema as {
            shape?: { method?: { value?: string; _def?: { value?: string } } };
          };
          const method = s?.shape?.method?.value ?? s?.shape?.method?._def?.value;
          h.handlers.set(String(method), fn as (req: unknown, extra: unknown) => Promise<unknown>);
        },
      },
    });
    return () => {
      throw new Error('HTTP fetch handler is not exercised by this test');
    };
  },
}));

// PG seams. Spread the real modules so the wide agent-tools import graph keeps
// every other export; only the connection/verification leaves are stubbed.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.fakeSql }),
    withWorkspace: async <T>(ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.withWorkspaceCalls.push(ws);
      return fn(h.fakeTx);
    },
  };
});
vi.mock('../../spawn-signing', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    verifySpawnParams: h.verifySpawnParams,
    logVerificationFailure: h.logVerificationFailure,
  };
});
vi.mock('../../power-user-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifyAccessToken: h.verifyAccessToken };
});
vi.mock('../../superuser-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // isLoopbackRequest stays REAL (pure header logic — part of the matrix).
  return { ...actual, isValidSuperuserBearer: h.isValidSuperuserBearer };
});
vi.mock('../../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, workspaceForCoordOwner: h.workspaceForCoordOwner };
});
vi.mock('../../resolve-harness-paths', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHarnessPaths: async () => ({
      projectDir: '/tmp/gating-matrix-proj',
      stateDir: '/tmp/gating-matrix-state',
    }),
  };
});
// scoped-superuser-workspace-clamp: toggle ONLY this flag via h.scopedClampFlag;
// every other flag defers to the real resolver (PG is stubbed → FLAG_DEFAULTS),
// so existing cases see unchanged flag behavior.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getFlag: async (key: string, scope?: string) =>
      key === 'papercusp-scoped-superuser-clamp'
        ? h.scopedClampFlag.value
        : (actual.getFlag as (k: string, s?: string) => Promise<boolean>)(key, scope),
  };
});
vi.mock('../../hive-federation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, hiveHomeSlugForHarness: h.hiveHomeSlugForHarness };
});
// P-017 workspace-tier clamp seam — only the foreign-workspace harness resolver
// is stubbed; the rest of harness-core stays real (the wide agent-tools import graph).
vi.mock('../../harness-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveWorkspaceForHarnessSlugIn: h.resolveWorkspaceForHarnessSlugIn };
});

// _mcp-handler's transport setup calls a bare `require(...)` for the MCP SDK
// schemas; under vite-node's ESM transform there is no module-scope require,
// so provide the global fallback before the module loads.
(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
// No pinned tool manifest — tools/list must expose the live registry.
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/gating-matrix-no-manifest.json';
delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;

await import('../routes/transport/_mcp-handler');
const { registerProjectedTool, unregisterProjectedToolsForPlugin, lookupByMcpName, getCatalog } =
  await import('@papercusp/agent-mcp');
const { currentRequestWorkspaceId } = await import('../../workspace-als');

/* ─── Synthetic probe tools ──────────────────────────────────────────── */

interface SeenCall {
  tool: string;
  args: unknown;
  ctx: UnifiedToolContext;
  /** The request-scoped ALS workspace at handler time (P-022 pin). */
  alsWorkspace: string | undefined;
}
const seen: SeenCall[] = [];

function probeFn(name: string) {
  return async (input: unknown, ctx: UnifiedToolContext) => {
    seen.push({ tool: name, args: input, ctx, alsWorkspace: currentRequestWorkspaceId() });
    return { content: [{ type: 'text' as const, text: `${name}-ok` }] };
  };
}

registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: role-gated to scoper',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:scoped' } },
  fn: probeFn('gatingtest:scoped'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: engineer-profile, operator role',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  profile: 'engineer',
  expose: { mcp: { name: 'gatingtest:engineer' } },
  fn: probeFn('gatingtest:engineer'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: crossWorkspace (spans workspaces)',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  crossWorkspace: true,
  expose: { mcp: { name: 'gatingtest:crossworkspace' } },
  fn: probeFn('gatingtest:crossworkspace'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: a cross_harness-prefixed tool (reads other harnesses)',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  expose: { mcp: { name: 'cross_harness:probe' } },
  fn: probeFn('cross_harness:probe'),
});
// NB: the REAL flags:set (crossWorkspace:true, global flag store) is already registered,
// so the clamp-exemption test below calls it directly — registering a 'flags:set' probe
// here would collide (ToolRegistrationError). We assert only that the GATE doesn't deny it
// (no workspace_forbidden); the handler's own arg-validation result is irrelevant.

afterAll(() => {
  unregisterProjectedToolsForPlugin('gating-matrix-test');
});

/* ─── Drivers ────────────────────────────────────────────────────────── */

const MCP = 'http://127.0.0.1:3070/api/mcp';

/** mcp-handler-shaped `extra` (requestInfo.{url,headers}) on a loopback host. */
function extraFor(url: string, headers: Record<string, string> = {}): unknown {
  return { requestInfo: { url, headers: { host: '127.0.0.1:3070', ...headers } } };
}

/** A per-spawn signed URL (sig verification itself is mocked OK by default). */
function signedUrl(over: Record<string, string> = {}): string {
  const u = new URL(MCP);
  const params: Record<string, string> = {
    harness: 'papercup',
    workspace: 'ws-test',
    role: 'scoper',
    run: 'run-1',
    spawn: 'spawn-1',
    exp: '9999999999',
    sig: 'test-sig',
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v !== '') u.searchParams.set(k, v);
  return u.toString();
}

function superuserExtra(query = '', headers: Record<string, string> = {}): unknown {
  return extraFor(`${MCP}?superuser=1${query}`, {
    authorization: 'Bearer test-su-bearer',
    ...headers,
  });
}

const POWER_CLAIMS = {
  t: 'access',
  workspaceId: 'ws-claim',
  userId: 'u-1',
  authSessionId: 'sess-1',
  exp: 9999999999,
};

interface ToolsListResult {
  tools: Array<{ name: string }>;
}
interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

async function listTools(extra: unknown): Promise<ToolsListResult> {
  return (await h.handlers.get('tools/list')!({}, extra)) as ToolsListResult;
}
async function callTool(
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
): Promise<CallResult> {
  return (await h.handlers.get('tools/call')!(
    { params: { name, arguments: args } },
    extra,
  )) as CallResult;
}
const textOf = (r: CallResult): string => r.content.map((c) => c.text ?? '').join('');

beforeEach(() => {
  vi.resetAllMocks(); // restores the vi.fn() originals, drops *Once queues
  seen.length = 0;
  h.withWorkspaceCalls.length = 0;
  h.scopedClampFlag.value = false;
  delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
});

/* ─── scoped-superuser-workspace-clamp (P-006 / P-007) ───────────────── */

describe('scoped-superuser-workspace-clamp', () => {
  // A scoped superuser session = ?superuser=1 + a concrete ?workspace=.
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('flag OFF: a scoped superuser may call a crossWorkspace tool (today’s behavior)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: a scoped superuser is DENIED a crossWorkspace tool (workspace_forbidden)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden');
  });

  it('flag ON: an UNSCOPED (?workspace=*) superuser may still call a crossWorkspace tool', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('*'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: a scoped superuser MAY call autonomy:decide — a scoped-safe self-confining crossWorkspace tool (EI-1810)', async () => {
    // The Overwatch role runs workspace-scoped and its prompt MANDATES autonomy:decide,
    // but the clamp made it deterministically unusable. The scoped-safe allowlist exempts
    // it: it's crossWorkspace only for the unscoped path, yet self-scopes to the caller's
    // own workspace + is read-only, so a scoped session calling it never reads another ws.
    h.scopedClampFlag.value = true;
    const res = await callTool('autonomy:decide', { action: 'improvements:capture' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
    // …and it reached the handler, which self-scoped to the caller's OWN workspace.
    expect(textOf(res)).toContain('"workspaceId": "ws-test"');
  });

  it('flag ON: a scoped superuser MAY call memory:search — a scoped-safe user/harness-scoped tool (EI-2378)', async () => {
    // After EI-2378, memory:search's crossWorkspace:true survives projection (so an
    // unscoped psu gets the admin handle). For a SCOPED session it must NOT be clamped:
    // the memory store is partitioned by user-id/harness-slug, not workspace, so a scoped
    // session reads only its OWN user's memory — no cross-workspace tenant-data access.
    // The SCOPED_SAFE_CROSSWORKSPACE allowlist exempts it (it reaches its handler rather
    // than being denied; the handler erroring on the stubbed PG is irrelevant to the gate).
    h.scopedClampFlag.value = true;
    const res = await callTool('memory:search', { query: 'pricing' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a scoped superuser MAY call flags:set — a GLOBAL-config meta-control exempt from the clamp (no tenant data; fixes the circular lockout)', async () => {
    // flags:set is crossWorkspace:true (it writes the global flag store + audit log), but it
    // touches NO per-workspace tenant data — and denying it would lock the operator out of the
    // very control that GOVERNS this clamp (a scoped superuser couldn't disable it). The
    // SUPERUSER_GLOBAL_FLAG_ADMIN exemption lets a scoped superuser reach the flag system.
    h.scopedClampFlag.value = true;
    const res = await callTool('flags:set', {}, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a NON-exempt crossWorkspace tool is STILL denied (clamp intact for tenant-data tools)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden'); // the clamp's data-isolation is unchanged
  });

  it('flag ON: a scoped superuser’s foreign `workspace` ARG is overwritten with its own workspace', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { workspace: 'other-ws' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.args).toMatchObject({ workspace: 'ws-test' });
  });

  it('flag ON: a superuser with an UNRESOLVED workspace is rejected (no silent god-mode)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', {}, superuserExtra()); // no ?workspace=, no header
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('scoped_superuser_workspace_unresolved');
  });

  it('flag OFF: an unresolved-workspace superuser still gets unscoped god-mode (unchanged)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:crossworkspace', {}, superuserExtra());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: rejects the harness:\'all\' global escape for a (workspace-)scoped session', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'all' }, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  // P-017: a per-call `harness` arg that resolves to a DIFFERENT workspace must be
  // rejected even for a workspace-only (non-hive) scoped session. The plan/work-item
  // readers resolve a harness→workspace from the REGISTRY (not the clamped ctx.workspaceId),
  // so without this dispatch clamp a scoped session could read a foreign workspace's plans
  // by naming its harness — the gap the active-ws-first fallback alone left open.
  it('flag ON: rejects a per-call `harness` that belongs to ANOTHER workspace (workspace-only scope)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('other-ws');
    expect(h.resolveWorkspaceForHarnessSlugIn).toHaveBeenCalledWith('ws-test', 'foreign-ws-harness');
  });

  it('flag ON: ALLOWS a per-call `harness` that belongs to the session\'s OWN workspace', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'own-ws-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag ON: ALLOWS an UNREGISTERED harness (fail-open; the tool resolves/fails loud, not the clamp)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'unregistered-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag OFF: a foreign-workspace `harness` arg is NOT clamped (today\'s behavior)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag ON: an UNSCOPED (?workspace=*) superuser is NOT P-017-clamped on a foreign harness', async () => {
    // The clamp is gated on workspaceId !== '*', so an unscoped session is never
    // harness_forbidden here (it may still fail downstream for needing a concrete
    // workspace tx — that's a separate gate, not this clamp).
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('*'));
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.resolveWorkspaceForHarnessSlugIn).not.toHaveBeenCalled();
  });
});

/* ─── scoped-superuser HIVE clamp (P-014a — auto-confine on harness) ──── */

describe('scoped-superuser hive clamp', () => {
  // Flag ON, scoped to ws-test, launched ON a hive harness ⇒ hive-confined.
  const hiveScoped = () => superuserExtra('&workspace=ws-test&harness=hiveA-home');

  it('flag ON: denies a cross_harness:* tool (it reads other harnesses)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('cross_harness:probe', {}, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: rejects a per-call `harness` in a DIFFERENT hive', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: rejects a harness:\'all\' escape', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'all' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: ALLOWS a harness within the same hive subtree (a member)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'hiveA-member' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.tool).toBe('gatingtest:scoped');
  });

  it('flag OFF: a hive-harness session may still use cross_harness:* (unchanged)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('cross_harness:probe', {}, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('cross_harness:probe-ok');
  });
});

/* ─── tools/list ─────────────────────────────────────────────────────── */

describe('tools/list — strict-mode listing matrix', () => {
  it('handlers were captured for both verbs', () => {
    expect(h.handlers.has('tools/list')).toBe(true);
    expect(h.handlers.has('tools/call')).toBe(true);
  });

  it('a spawn URL that FAILS signature verification gets an EMPTY list (mirrors tools/call)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.verifySpawnParams.mockResolvedValueOnce({ ok: false, reason: 'expired' });
      const res = await listTools(extraFor(signedUrl()));
      expect(res.tools).toEqual([]);
      // The failure is audited, not silent.
      expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
      expect(h.logVerificationFailure.mock.calls[0][0]).toMatchObject({
        reason: 'expired',
        claimedRole: 'scoper',
        claimedWorkspace: 'ws-test',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[spawn-signing] rejected MCP request: expired'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('?superuser=1 from a NON-loopback host is a failed ctx → empty list (real isLoopbackRequest)', async () => {
    const res = await listTools(
      extraFor(`${MCP}?superuser=1`, {
        host: 'evil.example.com',
        authorization: 'Bearer test-su-bearer',
      }),
    );
    expect(res.tools).toEqual([]);
  });

  it('a verified role-scoped caller sees ONLY tools its role admits', async () => {
    const res = await listTools(extraFor(signedUrl({ role: 'scoper' })));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped');
    expect(names).not.toContain('gatingtest:engineer'); // operator-only
    // Full-matrix invariant: nothing listed excludes scoper in its allowlist.
    const violations = names.filter((n) => {
      const reg = lookupByMcpName(n);
      return Boolean(reg?.agentRoles && !reg.agentRoles.includes('scoper'));
    });
    expect(violations).toEqual([]);
  });

  it('a different role does NOT see the scoper-only tool', async () => {
    const res = await listTools(extraFor(signedUrl({ role: 'worker' })));
    expect(res.tools.map((t) => t.name)).not.toContain('gatingtest:scoped');
  });

  it('?tools= allowlist narrows the listing to exactly the named set', async () => {
    const u = new URL(signedUrl({ role: 'scoper' }));
    u.searchParams.set('tools', 'gatingtest:scoped, definitely:not-registered');
    const res = await listTools(extraFor(u.toString()));
    expect(res.tools.map((t) => t.name)).toEqual(['gatingtest:scoped']);
  });

  it('superuser listing is operator-role-filtered (call-time bypass does NOT widen the list)', async () => {
    const res = await listTools(superuserExtra());
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:engineer'); // agentRoles: ['operator']
    expect(names).not.toContain('gatingtest:scoped'); // scoper-only stays hidden
  });

  it('superuser ?profile=power hides engineer-profile tools from the listing', async () => {
    const res = await listTools(superuserExtra('&profile=power'));
    const names = res.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('gatingtest:engineer');
  });

  it('superuser ?role=<r> narrows the listing to that role catalog (token-usage P-011 — SU-bearer fleet spawns)', async () => {
    const res = await listTools(superuserExtra('&role=scoper'));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped'); // scoper-allowlisted
    expect(names).not.toContain('gatingtest:engineer'); // operator-only no longer advertised
    // Full-matrix invariant: nothing listed excludes scoper in its allowlist.
    const violations = names.filter((n) => {
      const reg = lookupByMcpName(n);
      return Boolean(reg?.agentRoles && !reg.agentRoles.includes('scoper'));
    });
    expect(violations).toEqual([]);
  });

  it('a bare probe (no spawn params at all) keeps the soft, UNfiltered listing', async () => {
    const res = await listTools(extraFor(MCP));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped');
    expect(names).toContain('gatingtest:engineer');
  });
});

/* ─── tools/call — auth rejection BEFORE dispatch ────────────────────── */

describe('tools/call — auth failures reject before any dispatch', () => {
  it('an invalid/expired spawn signature → request_rejected, no fall-through to bearer dispatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.verifySpawnParams.mockResolvedValueOnce({ ok: false, reason: 'expired' });
      // Use a LEGACY catalog tool name: if the handler wrongly fell through to
      // bearer dispatch we would see `invalid_bearer`, not `request_rejected`.
      const legacyName = getCatalog()[0]?.name;
      expect(legacyName).toBeTruthy();
      const res = await callTool(legacyName!, {}, extraFor(signedUrl()));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('request_rejected: spawn_sig_expired');
      expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('PAPERCUSP_REQUIRE_SPAWN_SIG=1: an UNSIGNED URL that claims a spawn ctx is rejected + audited', async () => {
    process.env.PAPERCUSP_REQUIRE_SPAWN_SIG = '1';
    const res = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({ sig: '', exp: '' })));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: spawn_sig_missing_sig_required_mode');
    expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
    expect(h.logVerificationFailure.mock.calls[0][0]).toMatchObject({
      reason: 'missing_sig_required_mode',
      claimedRole: 'scoper',
    });
    expect(seen).toEqual([]);
  });

  it('?superuser=1 with a bad bearer → superuser_invalid_bearer, tool never executes', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?superuser=1&workspace=ws-test`, { authorization: 'Bearer wrong' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: superuser_invalid_bearer');
    expect(seen).toEqual([]);
  });

  it('?superuser=1 from a non-loopback origin → superuser_non_loopback', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?superuser=1`, {
        host: 'evil.example.com',
        authorization: 'Bearer test-su-bearer',
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: superuser_non_loopback');
    expect(seen).toEqual([]);
  });

  it('?power_user=1 with an invalid/expired access token → power_user_invalid_token', async () => {
    // verifyAccessToken default-resolves null (expired / tampered / unknown).
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?power_user=1`, { authorization: 'Bearer stale-token' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: power_user_invalid_token');
    expect(seen).toEqual([]);
  });

  it('unknown tool name → unknown_tool error envelope', async () => {
    const res = await callTool('gatingtest:does-not-exist', {}, extraFor(MCP));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('unknown_tool: no tool named "gatingtest:does-not-exist"');
  });

  it('a projected tool called WITHOUT any spawn ctx → invalid_request_context (not unknown)', async () => {
    const res = await callTool('gatingtest:scoped', {}, extraFor(MCP));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^invalid_request_context: /);
    expect(textOf(res)).toContain('harness/workspace/role/run/spawn');
    expect(seen).toEqual([]);
  });

  it('legacy bearer fallback: catalog tool + no bearer → invalid_bearer BEFORE the handler runs', async () => {
    const legacyName = getCatalog()[0]?.name;
    expect(legacyName).toBeTruthy();
    const res = await callTool(legacyName!, {}, extraFor(MCP)); // no Authorization header
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('invalid_bearer: Bearer token did not resolve to a principal');
  });
});

/* ─── tools/call — role / profile / workspace dispatch matrix ────────── */

describe('tools/call — role, profile, and workspace gating through the dispatcher', () => {
  it('out-of-role call → role_not_allowed, handler NOT executed', async () => {
    const res = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({ role: 'worker' })));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'role_not_allowed: Role "worker" cannot call tool "gatingtest:scoped" (allowed roles: scoper)',
    );
    expect(seen).toEqual([]);
  });

  it('in-role call dispatches with a synthesized least-privilege principal + workspace tx + ALS pin', async () => {
    const res = await callTool('gatingtest:scoped', { a: 1 }, extraFor(signedUrl({ role: 'scoper' })));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.args).toEqual({ a: 1 });
    expect(call.ctx.workspaceId).toBe('ws-test');
    expect(call.ctx.role).toBe('scoper');
    // tx synthesized via withWorkspace(ws-test); principal is the role's own,
    // NOT a bypass (gateBypass all-false for signed role-scoped callers).
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(call.ctx.principal?.slug).toBe('system:scoper');
    expect(call.ctx.principal?.capabilities.has('agent_tools:read')).toBe(true);
    expect(call.ctx.gateBypass).toEqual({ role: false, capability: false, quota: false });
    // P-022: the request-scoped workspace ALS is pinned for the handler.
    expect(call.alsWorkspace).toBe('ws-test');
  });

  it('superuser BYPASSES the role allowlist on the same tool (workspace-scoped call)', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.isSuperuser).toBe(true);
    expect(call.ctx.principal?.slug).toBe('system:operator');
    expect(call.ctx.gateBypass).toEqual({ role: true, capability: true, quota: true });
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
  });

  it('power-profile callers cannot invoke engineer-profile tools by name (mirrors the list filter)', async () => {
    h.verifyAccessToken.mockResolvedValueOnce(POWER_CLAIMS);
    const res = await callTool(
      'gatingtest:engineer',
      {},
      extraFor(`${MCP}?power_user=1`, { authorization: 'Bearer pu-token' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'tool_not_available_for_profile: "gatingtest:engineer" is not available in the power-engineer profile',
    );
    expect(seen).toEqual([]);
  });

  it('superuser testing ?profile=power hits the SAME profile gate (no superuser carve-out)', async () => {
    const res = await callTool('gatingtest:engineer', {}, superuserExtra('&profile=power&workspace=ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^tool_not_available_for_profile: /);
    expect(seen).toEqual([]);
  });

  it('power-user workspace is CLAMPED to the token claim — URL ?workspace= and the workspace ARG are both overridden', async () => {
    h.verifyAccessToken.mockResolvedValueOnce(POWER_CLAIMS);
    const res = await callTool(
      'gatingtest:scoped',
      { workspace: 'evil-workspace', x: 1 },
      extraFor(`${MCP}?power_user=1&workspace=evil-workspace`, {
        authorization: 'Bearer pu-token',
      }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-claim'); // token claim, never the URL
    expect((call.args as Record<string, unknown>).workspace).toBe('ws-claim'); // arg overwritten
    expect(call.ctx.isPowerUser).toBe(true);
    // Power-user bypasses role+capability but NOT quota.
    expect(call.ctx.gateBypass).toEqual({ role: true, capability: true, quota: false });
    expect(h.withWorkspaceCalls).toEqual(['ws-claim']);
  });

  it('EI-30: an UNSCOPED superuser passing a per-call `workspace` arg dispatches under THAT workspace', async () => {
    const res = await callTool('gatingtest:scoped', { workspace: 'ws-arg' }, superuserExtra());
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-arg');
    expect(call.ctx.principal?.slug).toBe('system:operator');
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toEqual(['ws-arg']);
    expect(call.alsWorkspace).toBe('ws-arg');
  });

  it('an UNSCOPED superuser call with NO workspace gets neither tx nor principal nor ALS pin', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra());
    expect(res.isError).toBeUndefined(); // this probe tool itself needs no principal
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('*');
    expect(call.ctx.tx).toBeUndefined();
    expect(call.ctx.principal).toBeUndefined();
    expect(call.alsWorkspace).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
    // No SID rode the request → the adv-row fallback is never consulted.
    expect(h.workspaceForCoordOwner).not.toHaveBeenCalled();
  });

  // ── psu-workspace-scoping fix: header carrier + SID→adv-row fallback ──

  it('x-papercusp-workspace header scopes a superuser call (OMP per-launch carrier) and beats ?workspace=', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&workspace=ws-url', { 'x-papercusp-workspace': 'ws-header' }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-header');
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toEqual(['ws-header']);
    expect(call.alsWorkspace).toBe('ws-header');
    expect(h.workspaceForCoordOwner).not.toHaveBeenCalled(); // explicit scope → no lookup
  });

  it('no explicit workspace + a client SID → the adv-row fallback scopes the call', async () => {
    h.workspaceForCoordOwner.mockResolvedValueOnce('ws-adv');
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-xyz'));
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(h.workspaceForCoordOwner).toHaveBeenCalledWith('su-xyz');
    expect(call.ctx.workspaceId).toBe('ws-adv');
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toEqual(['ws-adv']);
    expect(call.alsWorkspace).toBe('ws-adv');
  });

  it('a client SID with NO adv row falls through to unscoped `*` (pre-fix behavior)', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-unknown'));
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(h.workspaceForCoordOwner).toHaveBeenCalledWith('su-unknown');
    expect(call.ctx.workspaceId).toBe('*');
    expect(call.ctx.tx).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('x-papercusp-profile header gates like ?profile=power (psu --profile per-launch carrier)', async () => {
    const res = await callTool(
      'gatingtest:engineer',
      {},
      superuserExtra('&workspace=ws-test', { 'x-papercusp-profile': 'power' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^tool_not_available_for_profile: /);
    expect(seen).toEqual([]);
  });

  it('a principal-gated BUILT-IN under an unscoped superuser fails with the workspace-scoping error (handler path)', async () => {
    // The wrapper-level version of this gate is pinned in tool-auth-gating.test.ts;
    // this is the handler-path wiring its header records as owed.
    // (console silenced: the dispatch stack's invoke catch currently carries a
    // transient `[DBG dispatch-stack catch]` console.error from an in-flight
    // debugging session on the shared tree — not part of this contract.)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(lookupByMcpName('features:get')).toBeTruthy();
      const res = await callTool('features:get', {}, superuserExtra());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/^unauthorized: /);
      expect(textOf(res)).toContain('requires a workspace-scoped call');
    } finally {
      err.mockRestore();
    }
  });
});

/* ─── cross-workspace-denial invariant (workspace-data-isolation-leaks #4) ──
 *
 * The isolation plan's Verification §, invariant #4: "authenticate as workspace B,
 * attempt to read A's data through every surface, assert denial." The
 * scoped-superuser-workspace-clamp is the enforcement; the synthetic-probe
 * MECHANISM is pinned above. This block wires the invariant on the REAL
 * WORKSPACE-partitioned cross-workspace READ surfaces a foreign reader would use:
 *   - papercusp:list_workspaces — the workspace ENUMERATOR (reads every workspace's
 *     registry off the admin handle).
 *   - search:fulltext / search:semantic — cross-workspace prose/embedding search.
 * Each is crossWorkspace:true (runs on the getOrgPg admin handle, which bypasses
 * per-workspace RLS) and is NOT on the scoped-safe / global-flag-admin allowlists,
 * so a SCOPED session is denied (workspace_forbidden) and only an UNSCOPED
 * (--all-workspaces) superuser may span. A NEW such read surface added without
 * confinement (or without an explicit allowlist review) makes this fail loudly.
 *
 * NOT asserted here (confined by a DIFFERENT axis, not the workspace clamp):
 *   - memory:search — the memory store is partitioned by user-id/harness-slug, NOT
 *     by workspace, so it is not a "read workspace A's data" surface. (Its declared
 *     crossWorkspace:true also does not reach the clamp — it dispatches on a
 *     workspace-scoped tx, not the admin-handle path; tracked separately as a
 *     declared-vs-projected discrepancy, not a workspace leak.)
 */
describe('cross-workspace-denial invariant (isolation-plan #4)', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  const FOREIGN_READ_SURFACES = [
    'papercusp:list_workspaces',
    'search:fulltext',
    'search:semantic',
  ] as const;

  for (const tool of FOREIGN_READ_SURFACES) {
    it(`flag ON: a session scoped to ws-b is DENIED ${tool} (cannot read another workspace's data)`, async () => {
      // Guard: the invariant must run against a tool that is actually registered +
      // crossWorkspace — a silently-unregistered surface would vacuously "pass".
      expect(lookupByMcpName(tool), `${tool} must be a registered MCP tool`).toBeTruthy();
      h.scopedClampFlag.value = true;
      const res = await callTool(tool, { query: 'secret-from-ws-a' }, scoped('ws-b'));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('workspace_forbidden');
    });
  }

  it('flag ON: a session scoped to ws-b is DENIED reading another workspace\'s plans by naming its harness', async () => {
    // The harness-arg vector (P-017): plan/work-item readers derive harness→workspace
    // from the registry, so naming a foreign-workspace harness would otherwise read it.
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:get', { harness: 'foreign-ws-harness', slug: 'anything' }, scoped('ws-b'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag OFF: the invariant is a no-op (today\'s behavior — the surfaces are reachable)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('papercusp:list_workspaces', {}, scoped('ws-b'));
    expect(textOf(res)).not.toContain('workspace_forbidden');
  });

  it('an UNSCOPED (--all-workspaces, ?workspace=*) superuser may still span — the invariant confines only SCOPED sessions', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('papercusp:list_workspaces', {}, scoped('*'));
    expect(textOf(res)).not.toContain('workspace_forbidden');
  });
});
