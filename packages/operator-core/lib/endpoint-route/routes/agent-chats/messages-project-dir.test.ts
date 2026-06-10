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
vi.mock('@papercusp/sse', () => ({ sseResponse: () => new Response('sse-started') }));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (d: unknown) => d,
  dispatchProjectedToolStream: vi.fn(),
  // After assembly the handler looks the chat tool up; returning null makes it
  // exit with a deterministic 500 — far enough to prove assembly succeeded.
  lookupByMcpName: () => null,
}));
vi.mock('@papercusp/db-org', () => ({
  getLegacyClient: () => ({
    prepare: (sql: string) => {
      prepareLog.push(sql);
      return {
        get: async () => {
          if (sql.includes('FROM agent_chats WHERE id')) {
            return {
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
            };
          }
          if (sql.includes('SUM(total_cost_usd_cents)')) return { total: 0 };
          return undefined;
        },
        run: async () => ({}),
      };
    },
  }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('../../../harness-effective-config', () => ({ readEffectiveHarnessConfig: async () => ({}) }));
vi.mock('../../../harness-prompt-overrides', () => ({ getPromptOverride: async () => null }));
vi.mock('../../../memory/injection', () => ({ buildMemoryContextBlock: async () => null }));
vi.mock('../../../operator-notes', () => ({ projectDirForSlug: projectDirForSlugMock }));
vi.mock('@papercusp/orchestrator/role-prompt', () => ({ assembleRolePrompt: assembleRolePromptMock }));
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
