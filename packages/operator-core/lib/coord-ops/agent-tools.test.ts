/**
 * agent-tools.test.ts — the agent-facing `coord:ask-owner` TOOL wrapper
 * (EI-18682693723293580 recurrence guard).
 *
 * Bug: calling `coord:ask-owner` from inside `code:run` (foreground, ~55s hard
 * cap) ALWAYS script_timeout'd, because the tool inherited the internal
 * `coord:ask` op's `timeout_s: 120` default and blocked in a 2s poll loop —
 * the write (open thread + escalate) had already landed by the time the
 * caller's script budget ran out, leaving a live double-post risk with no
 * cheap way to check what landed.
 *
 * Fix: the exposed tool declares its own args schema with `timeout_s`
 * defaulting to 0 — return immediately once the question is opened. This
 * test pins the schema default AND the end-to-end handler behavior (no
 * `sleep`, resolves on the first microtask tick) so the regression can't
 * silently return.
 *
 * Run: cd packages/operator-core && npx vitest run lib/coord-ops/agent-tools.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent-tools/coordination/identity.js', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'owner-1', ownerLabel: 'Owner', workspaceId: 'ws1' })),
}));
vi.mock('../agent-tools/coordination/conversations.js', () => ({
  openConversation: vi.fn(async () => ({ thread_id: 't1', conversation: { id: 'c1' } })),
  getConversation: vi.fn(async () => null),
  postReply: vi.fn(),
}));
vi.mock('../agent-tools/coordination/escalations.js', () => ({
  openEscalation: vi.fn(async () => ({ msg_id: 'e1' })),
}));
vi.mock('../agent-tools/coordination/messages.js', () => ({
  sendMessage: vi.fn(),
}));

import { lookup } from '@papercusp/agent-mcp';
import { openConversation } from '../agent-tools/coordination/conversations.js';
import './agent-tools'; // side-effect: registers coord:ask-owner (and its siblings)

const openConv = vi.mocked(openConversation);

function getAskOwnerTool() {
  const tool = lookup('coord:ask-owner');
  if (!tool) throw new Error('coord:ask-owner not registered');
  return tool;
}

beforeEach(() => vi.clearAllMocks());

describe('coord:ask-owner tool', () => {
  it('defaults timeout_s to 0 in its args schema (not the op\'s 120s default)', () => {
    const tool = getAskOwnerTool();
    const argsSchema = (tool as unknown as { args: { parse: (v: unknown) => { timeout_s: number } } }).args;
    const parsed = argsSchema.parse({ question: 'A or B?' });
    expect(parsed.timeout_s).toBe(0);
  });

  it('returns immediately (no polling) when called with no timeout_s — the code:run-safe path', async () => {
    openConv.mockResolvedValue({ thread_id: 't1', conversation: { id: 'c1' } } as never);
    const tool = getAskOwnerTool();
    const handler = (tool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }>;
    }).handler;

    const start = Date.now();
    const out = await handler({ question: 'Ship it?' }, {});
    const elapsedMs = Date.now() - start;

    const parsed = JSON.parse(out.content[0].text) as {
      answered: boolean;
      answer: string | null;
      conversation_id: string;
    };
    expect(parsed).toEqual({ answered: false, answer: null, conversation_id: 'c1' });
    // No poll loop ran — this resolves in well under a single poll_ms tick (2000ms
    // by default), let alone code:run's ~55s foreground ceiling.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('still honors an explicit positive timeout_s for a caller that genuinely wants to block', () => {
    const tool = getAskOwnerTool();
    const argsSchema = (tool as unknown as { args: { parse: (v: unknown) => { timeout_s: number } } }).args;
    const parsed = argsSchema.parse({ question: 'q', timeout_s: 30 });
    expect(parsed.timeout_s).toBe(30);
  });
});
