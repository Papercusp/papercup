import { describe, expect, it } from 'vitest';
import { OPERATOR_SUBSTRATE_PROMPT } from './operator-prompt-system';

// Substrate prompt is the LLM-facing contract — every change here is
// behavior-affecting. Pin the load-bearing pieces so an accidental
// scanner.md edit (or a botched fallback merge) trips a test instead
// of silently changing operator output.

describe('OPERATOR_SUBSTRATE_PROMPT', () => {
  it('is a non-trivial string', () => {
    expect(typeof OPERATOR_SUBSTRATE_PROMPT).toBe('string');
    expect(OPERATOR_SUBSTRATE_PROMPT.length).toBeGreaterThan(500);
  });

  it('teaches the LLM the <suggestion> block format', () => {
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('<suggestion>');
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('</suggestion>');
  });

  it('lists all 3 v5 action variants', () => {
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('send_directive');
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('navigate');
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('inform');
  });

  it('does NOT include the v4 action variants (would re-introduce them)', () => {
    // The v4 schema had `open` (replaced by `navigate`) and `draft` /
    // `advise` (collapsed into `inform`). A regression here would mean
    // the LLM tries to emit removed variants — Zod would reject them.
    // Whole-word match to avoid catching `--open` or `advisory`.
    expect(/\b(action: ['"]?(open|draft|advise)['"]?)/i.test(OPERATOR_SUBSTRATE_PROMPT)).toBe(false);
  });

  it('declares the canonical tier mappings', () => {
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('messages:write');
    expect(OPERATOR_SUBSTRATE_PROMPT).toContain('harness:dispatch:*');
  });

  it('teaches "always ask on tier=high" rule', () => {
    expect(/high/i.test(OPERATOR_SUBSTRATE_PROMPT)).toBe(true);
    expect(/(always ask|ask first|fail-safe)/i.test(OPERATOR_SUBSTRATE_PROMPT)).toBe(true);
  });
});
