/**
 * Regression test for the SU SUT's Claude Code system-prompt framing.
 *
 * WHY THIS EXISTS: the su target drives the SUT via a raw Anthropic Messages API
 * call. Under this box's setup there is no ANTHROPIC_API_KEY, so the call uses the
 * Claude Max OAuth token — which is only admitted to the full, CLI-equivalent
 * rate-limit bucket when the request is FRAMED AS CLAUDE CODE (first system block
 * = the Claude Code identifier). Without that block the identical call 429s on a
 * stricter raw-OAuth bucket, which silently broke the entire suite for ~40h
 * (su-scenario-suite P-005; root-caused + fixed 2026-06-08). This test locks the
 * framing in so a future refactor of the system-prompt assembly can't regress it.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_IDENTIFIER,
  SU_PLAYBOOK_FRAMING,
  SuTarget,
  buildSuSystemBlocks,
  loadPlaybookBody,
  parseSuConfigDelta,
} from '../targets/su';

const PLAYBOOK = '# Papercusp engineer-collaborator playbook\n...body...';

describe('su SUT system-prompt framing', () => {
  it('uses the exact canonical Claude Code identifier string', () => {
    // A typo here silently re-throttles the OAuth bucket — pin the literal.
    expect(CLAUDE_CODE_IDENTIFIER).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('puts the Claude Code identifier as the FIRST system block (the load-bearing invariant)', () => {
    for (const cache of [true, false]) {
      const blocks = buildSuSystemBlocks(PLAYBOOK, cache);
      expect(blocks[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTIFIER });
      expect(blocks[0].cache_control).toBeUndefined();
    }
  });

  it('puts the playbook as the second block, cache_control only when caching is on', () => {
    const cached = buildSuSystemBlocks(PLAYBOOK, true);
    expect(cached).toHaveLength(2);
    expect(cached[1].text).toBe(PLAYBOOK);
    expect(cached[1].cache_control).toEqual({ type: 'ephemeral' });

    const uncached = buildSuSystemBlocks(PLAYBOOK, false);
    expect(uncached).toHaveLength(2);
    expect(uncached[1].text).toBe(PLAYBOOK);
    expect(uncached[1].cache_control).toBeUndefined();
  });

  it('always leads with the identifier regardless of playbook content', () => {
    // Even if the playbook itself happened to start with the identifier text,
    // the dedicated first block must still be present and first.
    const blocks = buildSuSystemBlocks(CLAUDE_CODE_IDENTIFIER + '\nmore', true);
    expect(blocks[0].text).toBe(CLAUDE_CODE_IDENTIFIER);
    expect(blocks).toHaveLength(2);
  });
});

describe('su SUT eval-variant knob (test-gym-apiary P-001)', () => {
  it('appends the prompt overlay as a third, UNCACHED block after the playbook', () => {
    const blocks = buildSuSystemBlocks(PLAYBOOK, true, 'Always answer in haiku.');
    expect(blocks).toHaveLength(3);
    // Identifier + cached playbook untouched (the overlay must not bust the
    // playbook's cache entry by landing before the cache breakpoint).
    expect(blocks[0].text).toBe(CLAUDE_CODE_IDENTIFIER);
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Always answer in haiku.' });
  });

  it('no overlay → exactly the baseline two blocks', () => {
    expect(buildSuSystemBlocks(PLAYBOOK, true)).toHaveLength(2);
    expect(buildSuSystemBlocks(PLAYBOOK, true, undefined)).toHaveLength(2);
  });

  it('parseSuConfigDelta accepts sutModel and rejects unknown keys loudly', () => {
    expect(parseSuConfigDelta(undefined)).toEqual({});
    expect(parseSuConfigDelta({ sutModel: 'claude-haiku-4-5' })).toEqual({ sutModel: 'claude-haiku-4-5' });
    expect(() => parseSuConfigDelta({ temperature: 0.7 })).toThrow(/unsupported variant configDelta key.*temperature/);
    expect(() => parseSuConfigDelta({ sutModel: '' })).toThrow(/non-empty string/);
    expect(() => parseSuConfigDelta({ sutModel: 42 as unknown as string })).toThrow(/non-empty string/);
  });
});
