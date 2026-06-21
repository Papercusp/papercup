/**
 * Step F (Tier-2 follow-up arc) — remaining surface coverage.
 *
 * The fixture + the per-handler wire format are covered by:
 *   - lib/test-fixtures/fake-agent-chat.test.ts (fixture self-tests)
 *   - lib/agent-tools/__tests__/streaming-tools-migration.test.ts (wire)
 *   - __tests__/e2e/chat-architect.e2e.test.ts (architect via fixture)
 *
 * This file fills the remaining gap: for each remaining surface
 * (brainstorm, oracle, operator-converse),
 * verify the registry-level invariants that the round-13 #34 + #36
 * regressions broke:
 *   - replayBufferSize set on the projected tool (round-13 #34)
 *   - modality forwarded from defineTool to projection (round-13 #36)
 *   - tool registered under its canonical name
 *
 * The fixture-pattern itself is exercised on each surface; the only
 * difference per surface is which `prompts.ts` to mock and which
 * tool-name to look up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRunAgentChat } from '@papercusp/operator-core/lib/test-fixtures/fake-agent-chat';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@papercusp/operator-core/lib/agent-chat-stream');
  vi.doUnmock('@papercusp/operator-core/lib/agent-tools/architect/prompts');
  vi.doUnmock('@papercusp/operator-core/lib/agent-tools/oracle/prompts');
  vi.doUnmock('@papercusp/operator-core/lib/agent-tools/operator/converse-prompt');
  vi.doUnmock('@papercusp/operator-core/lib/memory/injection');
});

function mockAgentChat() {
  vi.doMock('@papercusp/operator-core/lib/agent-chat-stream', () => ({
    runAgentChat: () => fakeRunAgentChat({}),
  }));
  vi.doMock('@papercusp/operator-core/lib/memory/injection', () => ({
    buildMemoryContextBlock: async () => null,
  }));
}

describe('brainstorm:chat — registry invariants', () => {
  it('registers with replayBufferSize > 0 and exposes the projected entry', async () => {
    mockAgentChat();
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    await import('@papercusp/operator-core/lib/agent-tools/architect/chat'); // side-effect: registers both architect + brainstorm
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('brainstorm:chat');
    expect(tool, 'brainstorm:chat is registered').toBeTruthy();
    expect(tool!.replayBufferSize).toBeGreaterThan(0);
    // Modality must be `undefined` or an array — never `null`
    // (round-13 #36: null would mean defineTool→projection forwarding broke).
    expect(tool!.modality === undefined || Array.isArray(tool!.modality)).toBe(true);
  });
});

describe('oracle:chat — registry invariants', () => {
  it('registers with replayBufferSize > 0', async () => {
    mockAgentChat();
    await import('@papercusp/operator-core/lib/agent-tools/oracle/chat'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('oracle:chat');
    expect(tool).toBeTruthy();
    expect(tool!.replayBufferSize).toBeGreaterThan(0);
    expect(tool!.modality === undefined || Array.isArray(tool!.modality)).toBe(true);
  });
});

describe('operator:converse — registry invariants', () => {
  it('registers with replayBufferSize > 0', async () => {
    mockAgentChat();
    await import('@papercusp/operator-core/lib/agent-tools/operator/converse'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('operator:converse');
    expect(tool).toBeTruthy();
    expect(tool!.replayBufferSize).toBeGreaterThan(0);
    expect(tool!.modality === undefined || Array.isArray(tool!.modality)).toBe(true);
  });
});

describe('streaming surfaces declare consistent replay-buffer + modality', () => {
  it('canonical sweep: each surface present in registry with sane invariants', async () => {
    mockAgentChat();
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    await import('@papercusp/operator-core/lib/agent-tools/architect/chat');
    await import('@papercusp/operator-core/lib/agent-tools/oracle/chat');
    await import('@papercusp/operator-core/lib/agent-tools/operator/converse');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const surfaces = [
      'architect:chat',
      'brainstorm:chat',
      'oracle:chat',
      'operator:converse',
    ] as const;

    for (const name of surfaces) {
      const tool = lookupByMcpName(name);
      expect(tool, `${name} registered`).toBeTruthy();
      expect(tool!.replayBufferSize, `${name} has replayBufferSize`).toBeGreaterThan(0);
      // Round-13 #36 regression: modality must be forwarded.
      expect(
        tool!.modality === undefined || Array.isArray(tool!.modality),
        `${name} modality is array or undefined (not null)`,
      ).toBe(true);
    }
  });
});
