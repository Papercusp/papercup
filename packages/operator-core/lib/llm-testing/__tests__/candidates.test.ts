/**
 * Tests for formatCandidatesReport — the pure CLI renderer for promotion candidates.
 * Run with: cd packages/operator-core && npx vitest run lib/llm-testing/__tests__/candidates.test.ts
 */
import { describe, expect, it } from 'vitest';
import { formatCandidatesReport, type PromotionCandidate } from '../promotion/candidates';

const cand = (over: Partial<PromotionCandidate> = {}): PromotionCandidate =>
  ({
    shape: 'abcdef1234567890deadbeef',
    axis: 'correctness',
    scenarioCount: 3,
    runCount: 9,
    lastSeen: new Date('2026-01-02T03:04:05.000Z'),
    exampleClaim: 'the model invented a features:update tool',
    ...over,
  }) as PromotionCandidate;

describe('formatCandidatesReport', () => {
  it('reports nothing-to-promote on an empty list', () => {
    expect(formatCandidatesReport([])).toMatch(/Nothing to promote/);
  });

  it('renders a header, the per-candidate lines, and the promote command', () => {
    const out = formatCandidatesReport([cand()]);
    expect(out).toContain('Found 1 candidate(s)');
    expect(out).toContain('abcdef123456…'); // shape truncated to 12 chars
    expect(out).toContain('axis=correctness');
    expect(out).toContain('scenarios: 3');
    expect(out).toContain('runs: 9');
    expect(out).toContain('2026-01-02T03:04:05.000Z');
    expect(out).toContain('pnpm llm-test promote --shape <full-hash>');
  });

  it('truncates a long example claim to ~100 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = formatCandidatesReport([cand({ exampleClaim: long })]);
    expect(out).toContain('x'.repeat(99) + '…');
    expect(out).not.toContain('x'.repeat(101));
  });

  it('counts multiple candidates', () => {
    expect(formatCandidatesReport([cand(), cand({ axis: 'safety' })])).toContain('Found 2 candidate(s)');
  });
});
