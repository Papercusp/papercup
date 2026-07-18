/**
 * work-item-chat-context-modernize P-003 — the messagesRoute must resolve a
 * chat's `feature_id` to the ITEM's OWN harness (via `getWorkItem`, cross-
 * harness) and key the dossier/checkpoint/plan-context/lock lookups to THAT
 * harness, not the route's `:slug` (a cross-harness queue/view's harness can
 * differ from the item's own). It must also render a LOUD "no dossier
 * available" notice on a miss instead of silently leaving the section empty,
 * and use blueprint-aware lock-notice guidance (the legacy `.papercusp/notes`
 * mechanics only apply to a legacy, non-hive harness).
 *
 * Styled after messages-project-dir.test.ts's lighter self-contained mock
 * style: `dispatchProjectedToolStream` is mocked directly (bypassing the real
 * chat tool / runAgentChat plumbing) so the final `promptText` + `harness`
 * it was called with are directly capturable and assertable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  projectDirForSlugMock,
  assembleRolePromptMock,
  dispatchMock,
  getWorkItemMock,
  computeCupWakeDossierMock,
  getWorkItemCheckpointMock,
  loadHarnessRegistryMock,
} = vi.hoisted(() => ({
  projectDirForSlugMock: vi.fn(),
  assembleRolePromptMock: vi.fn(),
  dispatchMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  computeCupWakeDossierMock: vi.fn(),
  getWorkItemCheckpointMock: vi.fn(),
  loadHarnessRegistryMock: vi.fn(),
}));

vi.mock('../../../agent-tools/index', () => ({}));
// NOTE: unlike messages-project-dir.test.ts, `@papercusp/sse` is left REAL —
// that file's canned-Response mock never invokes `setup()`, so
// dispatchProjectedToolStream (called inside setup) would never fire. The
// real sseResponse DOES invoke setup() and returns a real ReadableStream we
// drain below, letting the dispatch call args become observable.
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (d: unknown) => d,
  // A truthy stub tool + an empty async generator: the route's `for await`
  // loop over dispatchProjectedToolStream completes immediately with no
  // events, letting the handler reach its post-stream bookkeeping without
  // needing the real chat tool / runAgentChat plumbing.
  lookupByMcpName: () => ({}),
  dispatchProjectedToolStream: (...args: unknown[]) => {
    dispatchMock(...args);
    return (async function* () {})();
  },
}));
vi.mock('@papercusp/db-org', () => ({
  getLegacyClient: () => ({
    prepare: (sql: string) => ({
      get: async () => {
        if (sql.includes('FROM agent_chats WHERE id')) {
          return {
            id: 'chat-1',
            role: 'worker',
            feature_id: 'WI-CROSS-1',
            title: 'cross-harness chat',
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
    }),
  }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: loadHarnessRegistryMock }));
vi.mock('../../../harness-effective-config', () => ({ readEffectiveHarnessConfig: async () => ({}) }));
vi.mock('../../../harness-prompt-overrides', () => ({ getPromptOverride: async () => null }));
vi.mock('../../../memory/injection', () => ({ buildMemoryContextBlock: async () => null }));
vi.mock('../../../operator-notes', () => ({ projectDirForSlug: projectDirForSlugMock }));
vi.mock('@papercusp/orchestrator/role-prompt', () => ({ assembleRolePrompt: assembleRolePromptMock }));
vi.mock('../../../agent-chats-data', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../agent-chats-data')>();
  return { ...orig, readFeatureLockState: async () => null };
});
vi.mock('../../../work-items', () => ({ getWorkItem: getWorkItemMock }));
vi.mock('../../../pot/cup-wake-dossier', () => ({ computeCupWakeDossier: computeCupWakeDossierMock }));
vi.mock('../../../work-item-checkpoint', () => ({ getWorkItemCheckpoint: getWorkItemCheckpointMock }));
vi.mock('../../../plan-context-for-feature', () => ({ getPlanContextForFeature: async () => null }));
vi.mock('../../../fleet/chat-spawn-tracking', () => ({
  beginChatSpawnTracking: async () => ({ spawnId: 'test-spawn', finish: async () => {} }),
  resolveChatRunOutcome: () => ({ status: 'done' }),
}));

import agentChatTools from './index';

const messagesRoute = (agentChatTools as Array<{ path: string; method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>)
  .find((t) => t.method === 'POST' && t.path.endsWith('/messages'))!;

function postMessage(slug = 'chat-owning-harness') {
  const req = new Request(`http://localhost/api/harness/${slug}/agent-chats/chat-1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'what is this item about?' }),
  });
  return messagesRoute.handler(req, { params: { slug, chatId: 'chat-1' } });
}

beforeEach(() => {
  projectDirForSlugMock.mockReset();
  projectDirForSlugMock.mockResolvedValue('/tmp/proj-x');
  assembleRolePromptMock.mockReset();
  assembleRolePromptMock.mockReturnValue({ text: 'ROLE PROMPT', meta: { runId: 'run-1' } });
  dispatchMock.mockReset();
  getWorkItemMock.mockReset();
  computeCupWakeDossierMock.mockReset();
  getWorkItemCheckpointMock.mockReset();
  loadHarnessRegistryMock.mockReset();
  loadHarnessRegistryMock.mockResolvedValue({ projects: [] });
});

async function drainToClose(body: ReadableStream<Uint8Array> | null, maxMs = 5_000): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const deadline = Date.now() + maxMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const step = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
      ]);
      if (step === 'timeout' || step.done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function runAndCapture(slug = 'chat-owning-harness') {
  const res = await postMessage(slug);
  expect(res.status).toBe(200);
  await drainToClose(res.body);
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const [, , streamOpts] = dispatchMock.mock.calls[0] as [unknown, unknown, { promptText: string; harness?: string }];
  return streamOpts;
}

describe('agent-chats messagesRoute — item-own-harness scoping (P-003)', () => {
  it('keys dossier/checkpoint to the WORK ITEM\'s own harness, not the chat/queue-view slug', async () => {
    getWorkItemMock.mockResolvedValue({ id: 'WI-CROSS-1', harness: 'item-owning-harness' } as never);
    computeCupWakeDossierMock.mockResolvedValue('DOSSIER TEXT for WI-CROSS-1');
    getWorkItemCheckpointMock.mockResolvedValue(null);

    const streamOpts = await runAndCapture('chat-owning-harness');

    expect(computeCupWakeDossierMock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'item-owning-harness', workItemId: 'WI-CROSS-1' }),
    );
    expect(getWorkItemCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'item-owning-harness', workItemId: 'WI-CROSS-1' }),
    );
    // Never the chat's own harness — that's exactly the bug this fix closes.
    expect(computeCupWakeDossierMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'chat-owning-harness' }),
    );
    expect(streamOpts.promptText).toContain('DOSSIER TEXT for WI-CROSS-1');
    expect(streamOpts.harness).toBe('item-owning-harness');
  });

  it('falls back to the chat\'s own harness when the item cannot be resolved (never blocks the chat)', async () => {
    getWorkItemMock.mockResolvedValue(null);
    computeCupWakeDossierMock.mockResolvedValue(null);
    getWorkItemCheckpointMock.mockResolvedValue(null);

    const streamOpts = await runAndCapture('chat-owning-harness');

    expect(computeCupWakeDossierMock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'chat-owning-harness' }),
    );
    expect(streamOpts.promptText).toContain('No dossier available for WI-CROSS-1');
  });

  it('renders a LOUD "no dossier available" notice on a miss instead of silent absence', async () => {
    getWorkItemMock.mockResolvedValue({ id: 'WI-CROSS-1', harness: 'item-owning-harness' } as never);
    computeCupWakeDossierMock.mockResolvedValue(null);
    getWorkItemCheckpointMock.mockResolvedValue(null);

    const streamOpts = await runAndCapture();

    expect(streamOpts.promptText).toContain('⚠ No dossier available for WI-CROSS-1');
    expect(streamOpts.promptText).toContain('item-owning-harness');
    expect(streamOpts.promptText).toContain('work_items:get');
  });

  it('does NOT render the miss notice when a dossier successfully loads', async () => {
    getWorkItemMock.mockResolvedValue({ id: 'WI-CROSS-1', harness: 'item-owning-harness' } as never);
    computeCupWakeDossierMock.mockResolvedValue('all good here');
    getWorkItemCheckpointMock.mockResolvedValue(null);

    const streamOpts = await runAndCapture();

    expect(streamOpts.promptText).not.toContain('No dossier available');
    expect(streamOpts.promptText).toContain('all good here');
  });
});
