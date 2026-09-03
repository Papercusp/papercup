/**
 * messages-project-dir.test.ts — the messagesRoute must resolve the project
 * dir IN-PROCESS (workspace-aware live registry) and hand it to
 * `assembleRolePrompt`.
 *
 * Regression for the 2026-06-10 P-019 agent-path smoke failure: the route
 * assembled WITHOUT `projectDir`, so the orchestrator assembler fell back to
 * its workspace-blind `lookupProjectDir` (curl of the operator base — default
 * :3055, not an API port — then the legacy ~/.restart-harness-projects.json),
 * and every harness that exists only in the live registry failed with
 * "not registered in any known registry" despite `/api/harness/projects`
 * listing it. Same class as role-launch-spec step 0 / EI-220.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { projectDirForSlugMock, assembleRolePromptMock, prepareLog } = vi.hoisted(() => ({
  projectDirForSlugMock: vi.fn(),
  assembleRolePromptMock: vi.fn(),
  prepareLog: [] as string[],
}));

// Keep the module import light: the side-effect tool-catalog import and the
// transport deps are irrelevant to the seam under test.
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('@papercusp/sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sse')>()),
  sseResponse: () => new Response('sse-started') }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (d: unknown) => d,
  dispatchProjectedToolStream: vi.fn(),
  // After assembly the handler looks the chat tool up; returning null makes it
  // exit with a deterministic 500 — far enough to prove assembly succeeded.
  lookupByMcpName: () => null,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  // The route acquires a PG-backed per-chat lock (agent-chat-lock.ts, WI-7139)
  // before assembling, and that lock calls `getOrgPg().sql` when no sql is
  // injected. A factory WITHOUT getOrgPg makes it throw -> the lock fails CLOSED
  // -> console.warn -> vitest-fail-on-console reds this test (WI-7267).
  //
  // Echo the generated token back so the lock ACQUIRES: it compares
  // rows[0].token against the uuid it just minted, so returning [] would swap
  // the throw for a silent 409 and the assertions below would still fail. Match
  // by UUID SHAPE, not argument position, so reordering the query's
  // interpolations cannot quietly turn this back into a 409.
  getOrgPg: () => ({
    sql: Object.assign(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const token = values.find(
          (v): v is string =>
            typeof v === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
        );
        return token ? [{ token }] : [];
      },
      { begin: vi.fn() },
    ),
  }),
  // WI-5383: the route now reads/writes agent_chats via harnessQuery(slug,
  // (sql) => sql.unsafe(text, params)) instead of getLegacyClient().prepare().
  // Route on the SQL text the same way the old prepare() mock did.
  harnessQuery: async (
    _slug: string,
    fn: (sql: { unsafe: (text: string, params?: unknown[]) => Promise<unknown[]> }) => unknown,
  ) =>
    fn({
      unsafe: async (sql: string) => {
        prepareLog.push(sql);
        if (sql.includes('FROM agent_chats WHERE id')) {
          return [
            {
              id: 'chat-1',
              role: 'worker',
              feature_id: 'F-TEST-1',
              title: 'smoke chat',
              transcript: '[]',
              total_input_tokens: 0,
              total_output_tokens: 0,
              total_cost_usd_cents: 0,
              created_at: Date.now(),
              updated_at: Date.now(),
              archived_at: null,
            },
          ];
        }
        if (sql.includes('SUM(total_cost_usd_cents)')) return [{ total: 0 }];
        return [];
      },
    }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()), loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('../../../harness-effective-config', () => ({ readEffectiveHarnessConfig: async () => ({}) }));
vi.mock('../../../harness-prompt-overrides', () => ({ getPromptOverride: async () => null }));
vi.mock('../../../memory/injection', () => ({ buildMemoryContextBlock: async () => null }));
vi.mock('../../../operator-notes', () => ({ projectDirForSlug: projectDirForSlugMock }));
vi.mock('@papercusp/orchestrator/role-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/orchestrator/role-prompt')>()),
  assembleRolePrompt: assembleRolePromptMock }));
vi.mock('../../../agent-chats-data', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../agent-chats-data')>();
  return { ...orig, readFeatureLockState: async () => null };
});

import agentChatTools from './index';

// default export order: [list, create, get, archive, messages]
const messagesRoute = (agentChatTools as Array<{ path: string; method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>)
  .find((t) => t.method === 'POST' && t.path.endsWith('/messages'))!;

function postMessage(slug = 'e2e-smoke-h') {
  const req = new Request(`http://localhost/api/harness/${slug}/agent-chats/chat-1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'reply pong' }),
  });
  return messagesRoute.handler(req, { params: { slug, chatId: 'chat-1' } });
}

beforeEach(() => {
  projectDirForSlugMock.mockReset();
  assembleRolePromptMock.mockReset();
  assembleRolePromptMock.mockReturnValue({ text: 'PROMPT', meta: { runId: 'run-1' } });
});

describe('agent-chats messagesRoute projectDir resolution (P-019 regression)', () => {
  it('404s with a workspace-naming error when the harness is not in the live registry — and never assembles', async () => {
    projectDirForSlugMock.mockResolvedValue(null);
    const res = await postMessage();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('e2e-smoke-h');
    expect(body.error).toContain('ws-test');
    // The old behavior threw INSIDE assembly (fallback registry miss) → 500
    // "failed to assemble prompt: …not registered in any known registry".
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
  });

  it('passes the in-process projectDir to assembleRolePrompt for a live-registry harness', async () => {
    projectDirForSlugMock.mockResolvedValue('/tmp/proj-x');
    const res = await postMessage();
    // lookupByMcpName is mocked to null → deterministic 500 AFTER assembly.
    expect(res.status).toBe(500);
    expect(assembleRolePromptMock).toHaveBeenCalledTimes(1);
    expect(assembleRolePromptMock.mock.calls[0][0]).toMatchObject({
      slug: 'e2e-smoke-h',
      role: 'worker',
      projectDir: '/tmp/proj-x',
    });
  });
});
