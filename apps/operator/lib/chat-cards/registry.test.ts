/**
 * Unit tests for the chat-card registry. Phase 4 T2.1.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerCard,
  renderCard,
  _resetCardRegistryForTests,
} from './registry';

beforeEach(() => {
  _resetCardRegistryForTests();
});

describe('chat-card registry', () => {
  it('returns null for unregistered tool names', () => {
    const result = renderCard('chat:unknown', {
      args: {},
      onAnswer: () => {},
    });
    expect(result).toBeNull();
  });

  it('dispatches to a registered renderer', () => {
    const sentinel = { __kind: 'card-rendered' };
    registerCard('chat:test', () => sentinel as unknown as null);
    const result = renderCard('chat:test', { args: {}, onAnswer: () => {} });
    expect(result).toBe(sentinel);
  });

  it('passes args, answered, onAnswer through to the renderer', () => {
    let captured: { args: unknown; answered: unknown; onAnswer: unknown } | null = null;
    registerCard('chat:capture', (props) => {
      captured = { args: props.args, answered: props.answered, onAnswer: props.onAnswer };
      return null;
    });
    const cb = (): void => {};
    renderCard('chat:capture', {
      args: { question: 'pick one', options: [{ id: 'a', label: 'A' }] },
      answered: { picks: [{ option_id: 'a', label: 'A' }] },
      onAnswer: cb,
    });
    expect(captured).not.toBeNull();
    expect(captured!.args).toEqual({ question: 'pick one', options: [{ id: 'a', label: 'A' }] });
    expect(captured!.answered).toEqual({ picks: [{ option_id: 'a', label: 'A' }] });
    expect(captured!.onAnswer).toBe(cb);
  });

  it('re-registration replaces the prior renderer (HMR support)', () => {
    const sentinelA = { __kind: 'A' };
    const sentinelB = { __kind: 'B' };
    registerCard('chat:replaceable', () => sentinelA as unknown as null);
    registerCard('chat:replaceable', () => sentinelB as unknown as null);
    const result = renderCard('chat:replaceable', { args: {}, onAnswer: () => {} });
    expect(result).toBe(sentinelB);
  });

  it('returns whatever the renderer returns (including null)', () => {
    // Bad-payload short-circuit pattern: renderer returns null and
    // the consumer falls through to the default chip.
    registerCard('chat:short-circuit', () => null);
    const result = renderCard('chat:short-circuit', {
      args: { bad: 'payload' },
      onAnswer: () => {},
    });
    expect(result).toBeNull();
  });

  it('isolates renderer per tool name', () => {
    registerCard('chat:a', () => 'a' as unknown as null);
    registerCard('chat:b', () => 'b' as unknown as null);
    expect(renderCard('chat:a', { args: {}, onAnswer: () => {} })).toBe('a');
    expect(renderCard('chat:b', { args: {}, onAnswer: () => {} })).toBe('b');
    expect(renderCard('chat:c', { args: {}, onAnswer: () => {} })).toBeNull();
  });

  describe('MCP-mangled tool names (gui-chat-session-controls-2026-07-25 P-008)', () => {
    it('matches a mangled `mcp__<server>__<verb>` name against its registered colon-form card', () => {
      const sentinel = { __kind: 'ask-choice' };
      registerCard('chat:ask_choice', () => sentinel as unknown as null);
      // What a live su/interactive session's raw tool_use block actually
      // carries for an MCP-routed call — never the colon form directly.
      const result = renderCard('mcp__papercusp-su__chat_ask_choice', { args: {}, onAnswer: () => {} });
      expect(result).toBe(sentinel);
    });

    it('matches regardless of which MCP server prefix mangled it', () => {
      const sentinel = { __kind: 'ask-choice' };
      registerCard('chat:ask_choice', () => sentinel as unknown as null);
      expect(renderCard('mcp__some-other-server__chat_ask_choice', { args: {}, onAnswer: () => {} })).toBe(sentinel);
    });

    it('still returns null for an mcp-shaped name with no matching registered card', () => {
      registerCard('chat:ask_choice', () => ({}) as unknown as null);
      expect(renderCard('mcp__papercusp-su__work_items_claim', { args: {}, onAnswer: () => {} })).toBeNull();
    });

    it('does not touch a plain (non-mcp-shaped) unregistered name', () => {
      expect(renderCard('some_plain_tool', { args: {}, onAnswer: () => {} })).toBeNull();
    });

    it('a direct colon-form hit still wins without going through the mcp fallback', () => {
      const direct = { __kind: 'direct' };
      registerCard('chat:ask_choice', () => direct as unknown as null);
      expect(renderCard('chat:ask_choice', { args: {}, onAnswer: () => {} })).toBe(direct);
    });
  });
});
