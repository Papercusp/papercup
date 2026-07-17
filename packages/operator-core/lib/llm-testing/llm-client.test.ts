/**
 * Coverage for llm-client.ts's PURE model-spec helpers — no network, no
 * runAgentChat mocking (that already gets exercised end-to-end by the scout
 * integration tests). This suite only guards backendForLlmCall / modelForLlmCall
 * / canonicalizeAnthropicModel, the layer EI-13118 was filed against: a
 * fleet-spec model string (`claude-sonnet-5[1m]:high`) reaching the raw
 * anthropic-direct API call 404s there with no local signal — that silently
 * killed organic scout ideation for 2.3 days (07-14→07-16 2026) because the
 * 404 got folded into an ordinary "ran/no-ideas" cycle upstream.
 */
import { describe, expect, it } from 'vitest';
import {
  backendForLlmCall,
  modelForLlmCall,
  canonicalizeAnthropicModel,
} from './llm-client';

describe('backendForLlmCall', () => {
  it('routes chatgpt: / gpt- / openai-codex/ prefixed models to codex', () => {
    expect(backendForLlmCall('chatgpt:5.5')).toBe('codex');
    expect(backendForLlmCall('gpt-5.5')).toBe('codex');
    expect(backendForLlmCall('openai-codex/gpt-5')).toBe('codex');
  });

  it('routes a bare/claude model (or undefined) to anthropic-direct', () => {
    expect(backendForLlmCall('claude-sonnet-5')).toBe('anthropic-direct');
    expect(backendForLlmCall(undefined)).toBe('anthropic-direct');
  });

  it('an explicit backend override wins regardless of the model string', () => {
    expect(backendForLlmCall('gpt-5.5', 'claude-code')).toBe('claude-code');
  });
});

describe('modelForLlmCall', () => {
  it('maps chatgpt:<x> to gpt-<x> for the codex backend', () => {
    expect(modelForLlmCall('chatgpt:5.5', 'codex')).toBe('gpt-5.5');
  });

  it('strips the openai-codex/ prefix for the codex backend', () => {
    expect(modelForLlmCall('openai-codex/gpt-5', 'codex')).toBe('gpt-5');
  });

  it('passes non-codex backends through unchanged (canonicalization is a separate step)', () => {
    expect(modelForLlmCall('claude-sonnet-5[1m]:high', 'anthropic-direct')).toBe(
      'claude-sonnet-5[1m]:high',
    );
  });
});

describe('canonicalizeAnthropicModel (EI-13118)', () => {
  it('passes a bare Anthropic model id through unchanged', () => {
    expect(canonicalizeAnthropicModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('strips a trailing recognized :effort suffix', () => {
    expect(canonicalizeAnthropicModel('claude-sonnet-5:high')).toBe('claude-sonnet-5');
    expect(canonicalizeAnthropicModel('claude-opus-4-7:max')).toBe('claude-opus-4-7');
  });

  it('strips the [1m] window marker', () => {
    expect(canonicalizeAnthropicModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5');
  });

  it('EI-13118 repro: strips BOTH [1m] and :effort together (the exact killer spec)', () => {
    expect(canonicalizeAnthropicModel('claude-sonnet-5[1m]:high')).toBe('claude-sonnet-5');
  });

  it('is case-insensitive on the [1m] marker and effort suffix', () => {
    expect(canonicalizeAnthropicModel('claude-sonnet-5[1M]:HIGH')).toBe('claude-sonnet-5');
  });

  it('rejects an unrecognized colon suffix (not a known effort word) — a raw Anthropic id never has a colon', () => {
    expect(() => canonicalizeAnthropicModel('claude-sonnet-5:turbo')).toThrow(
      /unresolvable model spec/,
    );
  });

  it('rejects a claude- prefixed id carrying an unstripped provider-style suffix', () => {
    expect(() => canonicalizeAnthropicModel('claude-sonnet-5:provider')).toThrow(
      /unresolvable model spec/,
    );
  });

  it('throws loudly for a non-claude base id (e.g. a stray chatgpt: spec on the wrong backend)', () => {
    expect(() => canonicalizeAnthropicModel('chatgpt:5.5')).toThrow(
      /unresolvable model spec.*chatgpt:5\.5/s,
    );
  });

  it('throws loudly for a bare fleet alias with no raw id (e.g. "opus")', () => {
    expect(() => canonicalizeAnthropicModel('opus')).toThrow(/unresolvable model spec/);
  });

  it('error message names both the original spec and the stripped base, and cites EI-13118', () => {
    try {
      canonicalizeAnthropicModel('gemini:pro');
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/gemini:pro/);
      expect(msg).toMatch(/EI-13118/);
    }
  });

  it('passes an empty string through as-is (no false-positive throw on an absent model)', () => {
    expect(canonicalizeAnthropicModel('')).toBe('');
    expect(canonicalizeAnthropicModel('   ')).toBe('');
  });
});
