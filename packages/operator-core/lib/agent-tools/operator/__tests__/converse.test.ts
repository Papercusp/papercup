/**
 * operator:converse — handler coverage (P-019 of production-readiness-test-coverage).
 *
 * The operator brain's converse loop was effectively untested: the prior
 * converse-mcp-url.test.ts mocked the WRONG modules (`@/lib/operator-converse-prompt`
 * instead of the `./converse-prompt` the tool imports, and `@/lib/superuser-token`
 * while the tool read the token from disk via a local copy) and asserted the
 * retired mcp-remote stdio `args` shape — so it ran the real prompt builder, then
 * failed on the empty-output retry's console.error.
 *
 * This file drives the handler directly with a mocked runAgentChat stream and a
 * mock ctx, covering: the mcpUrl/state-channel shape, the budget gate, the
 * single empty-output retry, the no-retry-once-committed path, and server-side
 * <spawn>-tag dispatch. All collaborators are mocked at their real import paths;
 * parseOperatorTurn is left real so the <spawn> parsing is exercised end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent-chat-stream', () => ({ runAgentChat: vi.fn() }));
// converse reads the superuser token from disk via a local readFileSync; stub
// just that one read so mcpConfig is built without depending on the real token
// file existing. Everything else passes through to the real fs.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSync: ((p: any, ...rest: any[]) =>
      String(p).includes('superuser-token')
        ? 'fake-superuser-token-0123456789'
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (actual.readFileSync as any)(p, ...rest)) as typeof actual.readFileSync,
  };
});
vi.mock('../../../operator-budget', () => ({
  recordSpend: vi.fn(),
  checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
}));
// The tool imports buildOperatorPrompt from './converse-prompt' (the agent-tools
// copy) and destructures { systemPromptText, userPromptText } — mock that path
// with the correct object shape.
vi.mock('../converse-prompt', () => ({
  buildOperatorPrompt: vi.fn(async () => ({
    systemPromptText: 'sys',
    userPromptText: 'usr',
  })),
}));
vi.mock('../../../system-principal', () => ({
  readSystemPrincipal: vi.fn(async () => ({
    workspaceId: 'ws-real',
    capabilities: new Set(['tasks:read']),
    slug: 'system:operator',
    kind: 'system',
  })),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-real'),
}));
vi.mock('../../../self-url', () => ({ selfUrl: vi.fn(() => 'http://localhost:3070') }));
vi.mock('../../../agent-config', () => ({
  readAgentConfig: vi.fn(async () => ({ models: {} })),
  surfaceBackend: vi.fn(async () => undefined),
  surfaceModel: vi.fn(async () => undefined),
}));
vi.mock('../../../operator-mcp-tools', () => ({
  ALL_AGENT_MCP_TOOLS: ['tasks:read', 'mcp__agentmcp__chat:ask_choice'],
}));
// The <spawn>-tag dispatch goes through the durable nursery spawn engine
// (fleet/operator-spawn), dynamically imported by the handler — mock the module
// so the test asserts the dispatch contract without touching PG / processes.
vi.mock('../../../fleet/operator-spawn', () => ({
  spawnAgentInHarness: vi.fn(async () => ({
    ok: true,
    spawnId: 's-mock',
    harness: 'demo',
    projectDir: '/tmp/demo',
    error: null,
  })),
}));
vi.mock('../../../operator-sentinel-handoff', () => ({
  dispatchSentinelHandoff: vi.fn(async () => ({ status: 'filed', workItemId: 'WI-101', tier: 'low', nudged: true })),
}));
vi.mock('../../../operator-sentinel-handoff-deps', () => ({
  defaultSentinelHandoffDeps: vi.fn(() => ({})),
}));
vi.mock('../../../sentinel/sentinel-deep-delegate', () => ({
  delegateDeep: vi.fn(async () => ({ ok: true, workItemId: 'WI-301', spawnId: 's-deep', spawned: true })),
}));
vi.mock('../../../sentinel/sentinel-deep-delegate-deps', () => ({
  defaultDeepDelegateDeps: vi.fn(() => ({})),
}));

import { runAgentChat } from '../../../agent-chat-stream';
import { spawnAgentInHarness } from '../../../fleet/operator-spawn';
import { dispatchSentinelHandoff } from '../../../operator-sentinel-handoff';
import { delegateDeep } from '../../../sentinel/sentinel-deep-delegate';
import { activeWorkspaceId } from '../../../workspace-registry';
import { checkBudget } from '../../../operator-budget';
import tool from '../converse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGen = AsyncGenerator<any, void, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = (input: unknown, ctx: unknown) => (tool as any).handler(input, ctx);

interface McpConfig {
  mcpServers: { agentmcp: { type: string; url: string; headers: Record<string, string> } };
}
const mcpUrlOf = (cfg: McpConfig | undefined): string | null =>
  cfg?.mcpServers?.agentmcp?.url ?? null;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

beforeEach(() => {
  vi.mocked(runAgentChat).mockReset();
  // Default: a non-empty stream so the handler commits output (no retry/throw).
  vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
    yield { type: 'delta', text: 'hi' };
  });
  vi.mocked(checkBudget).mockResolvedValue({ state: null, exceeded: false } as never);
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('operator:converse — mcpUrl / state-channel shape', () => {
  it('mcpUrl includes ?superuser=1 + &workspace=<id> (http MCP shape)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    expect(runAgentChat).toHaveBeenCalled();
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig);
    expect(url).not.toBeNull();
    expect(url).toContain('?superuser=1');
    expect(url).toContain('&workspace=ws-real');
    expect(call.mcpConfig?.mcpServers.agentmcp.type).toBe('http');
  });

  it('mcpUrl carries &tools=<operator set> so the surface loads non-deferred (P-009)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).toContain('&tools=');
    // The param is the colon MCP-catalog name (mcp__agentmcp__ prefix stripped).
    const tools = new URL(url).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toEqual(['tasks:read', 'chat:ask_choice']);
  });

  it('spawns with disableToolSearch so the shrunk surface loads non-deferred (P-009)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { disableToolSearch?: boolean };
    expect(call.disableToolSearch).toBe(true);
  });

  it('spawns with disallowBuiltins so the brain has NO Bash/Task/file tools (P-008)', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { disallowBuiltins?: boolean };
    expect(call.disallowBuiltins).toBe(true);
  });

  it('mcpUrl workspace comes from ctx.workspaceId, NOT the process-global (voice-card state-channel keying, P-003)', async () => {
    // The dispatch ctx carries the REQUEST's workspace (resolved in-ALS by the
    // route); activeWorkspaceId() inside the handler runs outside the request
    // scope and resolves the process-global. The two diverging mis-keyed the
    // state channel and killed every voice disambiguation card (found live
    // 2026-06-07). Pin ctx-first precedence.
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValueOnce({
      workspaceId: 'ws-window',
      capabilities: new Set(['tasks:read']),
      slug: 'system:operator',
      kind: 'system',
    } as never);
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-global');
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: 'ws-window' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const url = mcpUrlOf(call.mcpConfig)!;
    expect(url).toContain('&workspace=ws-window');
    expect(url).not.toContain('ws-global');
    // The principal lookup must target the same request workspace — the
    // implicit default resolves the ALS-lost global and yields a tool-less
    // brain (principal/comparison workspace mismatch).
    expect(vi.mocked(readSystemPrincipal)).toHaveBeenCalledWith('operator', 'ws-window');
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
  });

  it("ctx.workspaceId='*' (superuser wildcard) falls through to activeWorkspaceId()", async () => {
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValueOnce({
      workspaceId: 'ws-real',
      capabilities: new Set(['tasks:read']),
      slug: 'system:operator',
      kind: 'system',
    } as never);
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: '*' },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    expect(mcpUrlOf(call.mcpConfig)!).toContain('&workspace=ws-real');
  });

  it('&tools= keeps chat:ask_choice on surface="tui" (inline cards, Phase 2a)', async () => {
    // sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a: the pui renders
    // inline terminal cards from the state-channel snapshot, so chat:ask_choice
    // is no longer dropped on the TUI surface (it stays identical to desktop).
    await handler(
      { messages: [], trigger: 'user_message', surface: 'tui', sessionUser: null },
      makeCtx(),
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    const tools = new URL(mcpUrlOf(call.mcpConfig)!).searchParams.get('tools') ?? '';
    expect(tools.split(',')).toEqual(['tasks:read', 'chat:ask_choice']);
  });

  it('workspaceId is URL-encoded in the mcpUrl', async () => {
    const wonky = 'ws with space/slash';
    const { readSystemPrincipal } = await import('../../../system-principal');
    // converse only reads principal.workspaceId; cast past the full
    // SystemPrincipal shape (which is in flux from the capability work).
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: wonky } as never);
    // ctx.workspaceId is the authoritative source (request-scoped) — the
    // wonky value rides the ctx, not the process-global.
    await handler(
      { messages: [], trigger: 'user_message', sessionUser: null },
      { ...makeCtx(), workspaceId: wonky },
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { mcpConfig?: McpConfig };
    expect(mcpUrlOf(call.mcpConfig)).toContain('&workspace=ws%20with%20space%2Fslash');
  });
});

describe('operator:converse — loop behaviors (P-019)', () => {
  it('budget exceeded → throws + never invokes the model', async () => {
    vi.mocked(checkBudget).mockResolvedValue({
      state: { capUsd: 5 },
      exceeded: true,
      todaySpendUsd: 5.5,
      capUsd: 5,
    } as never);
    await expect(
      handler({ messages: [], sessionUser: null }, makeCtx()),
    ).rejects.toThrow(/budget reached/i);
    expect(runAgentChat).not.toHaveBeenCalled();
  });

  it('empty output on every attempt → retries once, then throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      /* empty stream */
    });
    await expect(
      handler({ messages: [], sessionUser: null }, makeCtx()),
    ).rejects.toThrow(/no output/i);
    expect(runAgentChat).toHaveBeenCalledTimes(2); // MAX_BRAIN_ATTEMPTS
    errSpy.mockRestore();
  });

  it('empty first attempt, output on the retry → succeeds without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      n += 1;
      if (n === 1) return; // empty first attempt
      yield { type: 'delta', text: 'hello' };
      yield { type: 'result', costUsd: 0.02 };
    });
    const res = await handler({ messages: [], sessionUser: null }, makeCtx());
    expect(runAgentChat).toHaveBeenCalledTimes(2);
    const out = JSON.parse(res.content[0].text);
    expect(out.assembled).toBe('hello');
    expect(out.totalCost).toBeCloseTo(0.02);
    errSpy.mockRestore();
  });

  it('output on the first attempt → no retry; the delta is emitted', async () => {
    const ctx = makeCtx();
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield { type: 'delta', text: 'hi there' };
    });
    await handler({ messages: [], sessionUser: null }, ctx);
    expect(runAgentChat).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith('delta', { text: 'hi there' });
  });

  it('a <spawn> tag in the turn dispatches through the nursery spawn engine', async () => {
    // Re-pin the workspace mocks: the URL-encoding test above swaps them to a
    // wonky id and vi.clearAllMocks() does not restore implementations.
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: 'ws-real' } as never);
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield {
        type: 'delta',
        text: 'on it <spawn role="worker" harness="demo" feature="F-1" chunk="F-1.c1">',
      };
    });
    await handler({ messages: [], sessionUser: null }, makeCtx());
    expect(spawnAgentInHarness).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnAgentInHarness).mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-real',
      harness: 'demo',
      role: 'worker',
      featureId: 'F-1',
      chunkId: 'F-1.c1',
      parentRole: 'operator',
    });
    // The retired plugin route must NOT be fetched anymore.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('role=sentinel dispatches <handoff_to_queen> and <delegate_deep> but never spawn', async () => {
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-real');
    const { readSystemPrincipal } = await import('../../../system-principal');
    vi.mocked(readSystemPrincipal).mockResolvedValue({ workspaceId: 'ws-real' } as never);
    vi.mocked(runAgentChat).mockImplementation(async function* (): AnyGen {
      yield {
        type: 'delta',
        text:
          '<say>On it.</say>' +
          '<handoff_to_queen summary="ship the export flow" harness="papercup">' +
          '<delegate_deep summary="compare the migration strategies" brief="Need the safer recommendation." harness="papercup">' +
          '<spawn role="worker" harness="demo" feature="F-1">',
      };
    });

    await handler(
      { messages: [], trigger: 'user_message', role: 'sentinel', sessionUser: null },
      { ...makeCtx(), role: 'sentinel' },
    );

    expect(dispatchSentinelHandoff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchSentinelHandoff).mock.calls[0][0]).toMatchObject({
      summary: 'ship the export flow',
      harness: 'papercup',
    });
    expect(delegateDeep).toHaveBeenCalledTimes(1);
    expect(vi.mocked(delegateDeep).mock.calls[0][0]).toMatchObject({
      question: 'compare the migration strategies',
      brief: 'Need the safer recommendation.',
      harness: 'papercup',
      workspaceId: 'ws-real',
    });
    expect(spawnAgentInHarness).not.toHaveBeenCalled();
  });
});

describe('operator:converse — per-surface tool filtering (tui-operator-surface)', () => {
  it('keeps chat:ask_choice in allowedTools on surface="tui" (inline cards, Phase 2a)', async () => {
    // The pui now renders inline terminal cards + answers via /card-response
    // (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a), so the TUI
    // surface keeps chat:ask_choice — identical to the desktop surface.
    await handler(
      { messages: [], trigger: 'user_message', surface: 'tui', sessionUser: null },
      makeCtx(),
    );
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { allowedTools?: string[] };
    expect(call.allowedTools).toContain('tasks:read');
    expect(call.allowedTools).toContain('mcp__agentmcp__chat:ask_choice');
  });

  it('keeps chat:ask_choice on the default (desktop) surface', async () => {
    await handler({ messages: [], trigger: 'user_message', sessionUser: null }, makeCtx());
    const call = vi.mocked(runAgentChat).mock.calls[0][0] as { allowedTools?: string[] };
    expect(call.allowedTools).toContain('mcp__agentmcp__chat:ask_choice');
  });
});
