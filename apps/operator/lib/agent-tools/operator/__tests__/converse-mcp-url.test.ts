/**
 * operator:converse — MCP URL construction (audit4 regression).
 *
 * Audit-pass-4 found that operator:converse's mcpUrl was missing the
 * &workspace= param, so claude-code's MCP HTTP calls were dispatched
 * with workspaceId='*' (superuser-path default). Cards published by
 * chat:ask_choice never reached the PendingCardsBar — the chat
 * surface subscribed to the real workspace, but the cards lived under
 * '*'. Result: tool blocked until 60s timeoutSec and returned cancel.
 *
 * This test pins the URL shape by stubbing dependencies and inspecting
 * what mcpConfig the handler hands off to runAgentChat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agent-chat-stream', () => ({
  runAgentChat: vi.fn(),
}));
vi.mock('@/lib/superuser-token', () => ({
  readSuperuserToken: vi.fn(() => 'fake-superuser-token'),
}));
vi.mock('@/lib/operator-budget', () => ({
  recordSpend: vi.fn(),
  checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
}));
vi.mock('@/lib/operator-converse-prompt', () => ({
  buildOperatorPrompt: vi.fn(async () => 'a-prompt'),
}));
vi.mock('@/lib/system-principal', () => ({
  readSystemPrincipal: vi.fn(async () => ({
    workspaceId: 'ws-real',
    capabilities: new Set(['tasks:read']),
    name: 'operator',
  })),
}));
vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-real'),
}));

import { runAgentChat } from '@/lib/agent-chat-stream';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import tool from '@/lib/agent-tools/operator/converse';

interface McpServerEntry { type: string; command: string; args: string[] }
interface McpConfig { mcpServers: { agentmcp: McpServerEntry } }

function extractMcpUrl(mcpConfig: McpConfig | undefined): string | null {
  if (!mcpConfig?.mcpServers?.agentmcp) return null;
  const args = mcpConfig.mcpServers.agentmcp.args;
  const urlArg = args.find((a) => a.startsWith('http://') || a.startsWith('https://'));
  return urlArg ?? null;
}

describe('operator:converse mcpUrl', () => {
  beforeEach(() => {
    vi.mocked(runAgentChat).mockReset();
    vi.mocked(runAgentChat).mockImplementation(async function* () {
      // empty stream
    });
  });
  afterEach(() => {
    vi.mocked(runAgentChat).mockReset();
  });

  function makeCtx() {
    return {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'ws-real',
      role: 'operator',
      runId: 'r-test',
      spawnId: 's-test',
    };
  }

  it('audit4 fix: mcpUrl includes &workspace=<workspaceId> for state-channel scoping', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tool as any).handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      makeCtx(),
    );
    expect(runAgentChat).toHaveBeenCalled();
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = extractMcpUrl(call.mcpConfig);
    expect(url).not.toBeNull();
    expect(url).toContain('?superuser=1');
    expect(url).toContain('&workspace=ws-real');
  });

  it('workspaceId is properly URL-encoded', async () => {
    const wonkyId = 'ws with space/slash';
    vi.mocked(activeWorkspaceId).mockReturnValue(wonkyId);
    // principal.workspaceId must match for principalOk → mcpConfig truthy.
    const { readSystemPrincipal } = await import('@/lib/system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({
      workspaceId: wonkyId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      capabilities: new Set(['tasks:read']) as any,
      slug: 'system:operator',
      kind: 'system',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tool as any).handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      makeCtx(),
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = extractMcpUrl(call.mcpConfig);
    expect(url).toContain('&workspace=ws%20with%20space%2Fslash');
  });
});
