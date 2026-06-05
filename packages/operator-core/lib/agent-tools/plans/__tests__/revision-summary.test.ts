/**
 * Unit coverage for the pure helpers in `revision-summary.ts`
 * (plan-agent-launch-2026-05-21, P-007).
 *
 * `buildRationaleSummaryPrompt` / `sanitizeRationaleSummary` are pure.
 * `summarizeRevisionRationale` and the tool handler are heavy IO
 * (revision lookup, transcript read, haiku call) — exercised live in
 * P-027 / P-028.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRationaleSummaryPrompt,
  MAX_RATIONALE_LEN,
  sanitizeRationaleSummary,
} from '../revision-summary';

describe('buildRationaleSummaryPrompt', () => {
  const turns = [
    { role: 'user', content: 'add a phase' },
    { role: 'assistant', content: 'done — added phase 4' },
  ];

  it('names the plan and labels each turn by role', () => {
    const prompt = buildRationaleSummaryPrompt('plan-agent-launch-2026-05-21', turns);
    expect(prompt).toContain('plan-agent-launch-2026-05-21');
    expect(prompt).toContain('User: add a phase');
    expect(prompt).toContain('Assistant: done — added phase 4');
    expect(prompt.trimEnd().endsWith('Why:')).toBe(true);
  });

  it('keeps only the last 12 turns', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));
    const prompt = buildRationaleSummaryPrompt('p', many);
    expect(prompt).toContain('turn-29');
    expect(prompt).toContain('turn-18');
    expect(prompt).not.toContain('turn-17');
  });

  it('caps each turn at 600 chars', () => {
    const prompt = buildRationaleSummaryPrompt('p', [
      { role: 'user', content: 'x'.repeat(5000) },
    ]);
    // 'User: ' + 600 x's — the 601st must not appear.
    expect(prompt).toContain('User: ' + 'x'.repeat(600));
    expect(prompt).not.toContain('x'.repeat(601));
  });
});

describe('sanitizeRationaleSummary', () => {
  it('trims and passes a clean one-liner through', () => {
    expect(sanitizeRationaleSummary('  Split phase 3 for clarity.  ')).toBe(
      'Split phase 3 for clarity.',
    );
  });

  it('strips an echoed "Why:" label', () => {
    expect(sanitizeRationaleSummary('Why: the runner was voice-shaped')).toBe(
      'the runner was voice-shaped',
    );
  });

  it('strips wrapping quotes', () => {
    expect(sanitizeRationaleSummary('"re-scoped the verb"')).toBe(
      're-scoped the verb',
    );
    expect(sanitizeRationaleSummary("'fixed the FK'")).toBe('fixed the FK');
  });

  it('collapses internal whitespace and newlines to single spaces', () => {
    expect(sanitizeRationaleSummary('line one\n\n   line two')).toBe(
      'line one line two',
    );
  });

  it('caps an over-long summary with an ellipsis', () => {
    const out = sanitizeRationaleSummary('z'.repeat(900));
    expect(out.length).toBe(MAX_RATIONALE_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
});
