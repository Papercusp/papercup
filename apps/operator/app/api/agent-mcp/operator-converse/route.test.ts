/**
 * operator-converse SSE route — state-snapshot fan-out gating (audit).
 *
 * Verifies the modality-gated subscribe: text-mode turns must NOT
 * receive state-snapshot events from concurrent conversations in the
 * same workspace (cross-talk leak). Voice-mode turns receive snapshots
 * that have fallbackText set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({
    id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    has_password: true,
  })),
}));
vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));
vi.mock('@/lib/operator-budget', () => ({
  checkBudget: vi.fn(async () => ({ state: null, exceeded: false })),
}));
// The route imports the operator:converse tool via the agent-tools/index
// side-effect. We sub in a tiny stub via lookupByMcpName so the test
// doesn't drag in the full LLM stack.
const fakeTool = {
  pluginName: 'test',
  description: 'fake',
  capabilities: [],
  expose: { mcp: { name: 'operator:converse' } },
  inputSchema: { type: 'object' },
  fn: async () => ({ content: [{ type: 'text', text: '{"totalCost":0,"assembled":""}' }] }),
};

vi.mock('@papercusp/agent-mcp', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/agent-mcp')>(
    '@papercusp/agent-mcp',
  );
  return {
    ...actual,
    lookupByMcpName: vi.fn((name: string) =>
      name === 'operator:converse' ? fakeTool : null,
    ),
  };
});

vi.mock('@/lib/agent-tools/index', () => ({}));

import {
  _resetStateChannelForTests,
  openRun,
  setOpenCards,
} from '@papercusp/agent-mcp';
import { POST } from './route';

afterEach(() => _resetStateChannelForTests());

function makeReq(body: object): import('next/server').NextRequest {
  return new Request('http://localhost/api/agent-mcp/operator-converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

async function collectEvents(
  res: Response,
  timeoutMs: number,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timed = await Promise.race([
      readPromise,
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (!timed) break;
    if (timed.done) break;
    buf += decoder.decode(timed.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.includes('event: state-snapshot')) events.push(block);
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe('POST /api/agent-mcp/operator-converse — state-snapshot fan-out', () => {
  it('TEXT mode: does NOT subscribe; cross-conversation snapshots stay out', async () => {
    // Open the SSE first (text turn), then publish a state-snapshot
    // from a sibling run in the SAME workspace. Verify the snapshot
    // does NOT appear on this stream.
    const resPromise = POST(makeReq({ messages: [], trigger: 'user_message' }));
    const res = await resPromise;
    // Stream is open; concurrent sibling publishes a card.
    openRun({ workspaceId: 'ws-test', runId: 'sibling-run' });
    setOpenCards('sibling-run', [
      {
        correlationId: 'cid-sibling',
        prompt: 'card from sibling',
        dataSchemaJson: {},
        fallbackText: 'sibling fallback',
        createdAt: 0,
      },
    ]);
    const events = await collectEvents(res, 300);
    expect(events).toEqual([]);
  });

  it('VOICE mode: forwards state-snapshots WITH fallbackText only', async () => {
    const resPromise = POST(
      makeReq({ messages: [], trigger: 'user_message', modality: 'voice' }),
    );
    const res = await resPromise;
    openRun({ workspaceId: 'ws-test', runId: 'voice-run' });
    // First snapshot: no fallbackText — should be SKIPPED by the filter.
    setOpenCards('voice-run', [
      {
        correlationId: 'cid-no-fb',
        prompt: 'no-fallback',
        dataSchemaJson: {},
        createdAt: 0,
      },
    ]);
    // Second snapshot: WITH fallbackText — should be forwarded.
    setOpenCards('voice-run', [
      {
        correlationId: 'cid-no-fb',
        prompt: 'no-fallback',
        dataSchemaJson: {},
        createdAt: 0,
      },
      {
        correlationId: 'cid-with-fb',
        prompt: 'with-fallback',
        dataSchemaJson: {},
        fallbackText: 'spoken text',
        createdAt: 0,
      },
    ]);
    const events = await collectEvents(res, 300);
    // First setOpenCards (no fallbackText anywhere) skipped.
    // Second setOpenCards (has fallbackText) forwarded → 1 event.
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].split('data: ')[1]);
    expect(payload.runId).toBe('voice-run');
    expect(payload.snapshot.openCards.some((c: { fallbackText?: string }) => c.fallbackText === 'spoken text')).toBe(true);
  });
});
