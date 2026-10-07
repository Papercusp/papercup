/**
 * Does the real public Papercup brain retrieve the manual for conceptual help,
 * and avoid presenting static documentation as current workspace evidence?
 * Uses the maintained HTTP/SSE target and the production PI provisioning seam.
 * Run explicitly on a verified current-build operator with OPERATOR_BASE_URL
 * and PAPERCUSP_TEST_PUBLIC_CHAT=1. Ordinary CI runs the transport/policy units.
 * This exercises the upstream public brain; Portal browser/install acceptance,
 * novice outcomes and exact released-artifact checks remain separate.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { endPiSession, startPiSession } from '@papercusp/agent-mcp/provisioning';
import type { ChatSession, TurnResult } from '@papercusp/testing-shell/llm';

import { getOrCreateActiveConversation } from '../../operator-conversations';
import { OperatorTarget } from '../targets/operator';

const baseUrl = process.env.OPERATOR_BASE_URL;
const enabled = Boolean(baseUrl) && process.env.PAPERCUSP_TEST_PUBLIC_CHAT === '1';
let workspaceId: string;
let principalSessionId: string | undefined;
let chat: ChatSession | undefined;

function successful(result: TurnResult) {
  expect(result.finishReason, JSON.stringify({ error: result.error, answer: result.assistantText })).toBe('done');
  expect(result.assistantText.trim()).not.toBe('');
}

describe.runIf(enabled)('real public Papercup manual behavior', () => {
  beforeAll(async () => {
    const health = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
    expect(health.ok).toBe(true);
    expect((await health.json()).sha).toMatch(/^[a-f0-9]{7,40}$/);
  });

  beforeEach(async () => {
    workspaceId = `public-chat-manual-${randomUUID()}`;
    principalSessionId = `public-chat-manual-${randomUUID()}`;
    const principal = await startPiSession({
      workspaceId, sessionId: principalSessionId, capabilities: ['docs:read'],
      allowedTools: ['docs:search', 'docs:get'],
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const conversation = await getOrCreateActiveConversation(workspaceId);
    chat = await new OperatorTarget({
      baseUrl, role: 'papercup', hostTrust: 'public', workspaceId,
      principalToken: principal.bearer, conversationId: conversation.id,
    }).open({ runId: randomUUID(), workspaceMode: 'real', transport: 'http-sse' });
  }, 30_000);

  afterEach(async () => {
    try { await chat?.close(); }
    finally {
      chat = undefined;
      if (principalSessionId) await endPiSession(workspaceId, principalSessionId);
      principalSessionId = undefined;
    }
  });

  it('retrieves the canonical FAQ for a natural question with a misspelling', async () => {
    const result = await chat!.send({
      messages: [{ role: 'user', content: 'Do I need to keep the browesr tab open for agents to keep working on my hosted workspace?' }],
      trigger: 'user_message',
    });
    successful(result);
    const reads = result.toolCalls.filter((call) => call.name === 'docs:search' || call.name === 'docs:get');
    expect(reads, result.assistantText).not.toHaveLength(0);
    expect(reads[0].name).toBe('docs:search');
    expect(result.assistantText).toMatch(/\/docs\/faq(?:#|\b)/);
    expect(result.assistantText).toMatch(/host|workspace|desktop|server/i);
    expect(result.assistantText).toMatch(/clos|open|tab|browser/i);
  }, 150_000);

  it('does not turn manual prose into a current agent count', async () => {
    const result = await chat!.send({
      messages: [{ role: 'user', content: 'Exactly how many agents are running in my workspace right now? I need the live count, not how the product works.' }],
      trigger: 'user_message',
    });
    successful(result);
    // This principal has only public docs read. No live-state observation is
    // available, so a count would be unsupported even if it happens to be zero.
    expect(result.assistantText).toMatch(/cannot|can't|can’t|unable|don't have|do not have|no (?:live|current)|check|look|verify|unknown/i);
    expect(result.assistantText).not.toMatch(/(?:there (?:are|is)|you have|currently (?:have|running))\s+(?:\d+|zero|one|two|three)\s+(?:active |running )?agents?/i);
    expect(result.toolCalls.every((call) => ['docs:search', 'docs:get', 'operator:format', 'chat:say', 'chat:ask_choice'].includes(call.name))).toBe(true);
  }, 150_000);
});
