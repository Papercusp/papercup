/**
 * operator-conversation-compaction — pure-function unit tests
 * (operator-context-compaction-2026-06-05 P-007).
 *
 * The PG-touching lifecycle (incremental folding, CAS, budget gate,
 * restart-survival) lives in the sibling .integration.test.ts; this file
 * pins the deterministic pieces: prompt construction, summary sanitizing,
 * and the backlog threshold.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SUMMARY_CHARS,
  MIN_NEW_TOKENS,
  MIN_NEW_TURNS,
  backlogWorthCompacting,
  buildCompactionPrompt,
  sanitizeSummary,
} from './operator-conversation-compaction';

describe('buildCompactionPrompt', () => {
  it('is incremental: carries the existing summary + the new turns', () => {
    const p = buildCompactionPrompt('Earlier: user picked plan X over Y.', [
      { role: 'user', text: 'now rename the harness' },
      { role: 'assistant', text: 'renamed sheets → ledger' },
    ]);
    expect(p).toContain('EXISTING SUMMARY:\nEarlier: user picked plan X over Y.');
    expect(p).toContain('[user] now rename the harness');
    expect(p).toContain('[assistant] renamed sheets → ledger');
    // The merge instruction + the hard cap are load-bearing prompt pieces.
    expect(p).toContain('UPDATED SUMMARY:');
    expect(p).toContain(String(MAX_SUMMARY_CHARS));
  });

  it('marks conversation start when there is no summary yet', () => {
    const p = buildCompactionPrompt(null, [{ role: 'user', text: 'hello' }]);
    expect(p).toContain('(none — conversation start)');
  });

  it('caps a single oversized turn inside the prompt', () => {
    const big = 'x'.repeat(10_000);
    const p = buildCompactionPrompt(null, [{ role: 'user', text: big }]);
    // 2000-char per-turn cap — the prompt must not embed all 10k chars.
    expect(p).not.toContain('x'.repeat(2_001));
    expect(p).toContain('x'.repeat(2_000));
  });
});

describe('sanitizeSummary', () => {
  it('trims and strips an echoed label', () => {
    expect(sanitizeSummary('  UPDATED SUMMARY: the gist  ')).toBe('the gist');
  });

  it('enforces the stored-summary char cap', () => {
    const out = sanitizeSummary('y'.repeat(MAX_SUMMARY_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('passes a normal summary through unchanged', () => {
    expect(sanitizeSummary('- decided A\n- prefers B')).toBe('- decided A\n- prefers B');
  });
});

describe('backlogWorthCompacting', () => {
  const turn = (text: string) => ({ text });

  it('fires on turn count', () => {
    const turns = Array.from({ length: MIN_NEW_TURNS }, (_, i) => turn(`t${i}`));
    expect(backlogWorthCompacting(turns)).toBe(true);
    expect(backlogWorthCompacting(turns.slice(1))).toBe(false);
  });

  it('fires on token mass even under the turn-count threshold', () => {
    // 2 turns, but each ~3k estimated tokens (4 chars/token heuristic).
    const fat = [turn('z'.repeat(MIN_NEW_TOKENS * 2)), turn('z'.repeat(MIN_NEW_TOKENS * 2))];
    expect(backlogWorthCompacting(fat)).toBe(true);
  });

  it('stays quiet for a small fresh backlog', () => {
    expect(backlogWorthCompacting([turn('hi'), turn('ok')])).toBe(false);
  });
});
