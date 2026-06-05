/**
 * Coverage for renderHarnessPlanReviewsForPrompt — surfaces only non-`accept`
 * plan-review verdicts (accept is the boring case) as a compact prompt section,
 * with a '(no body)' fallback for an empty summary.
 */
import { describe, expect, it } from 'vitest';
import { renderHarnessPlanReviewsForPrompt } from './harness-plan-reviews';

const e = (slug: string, verdict: string, summary = '') =>
  ({ slug, verdict, summary, mtimeMs: 0 }) as never;

describe('renderHarnessPlanReviewsForPrompt', () => {
  it('returns empty for no entries', () => {
    expect(renderHarnessPlanReviewsForPrompt([])).toBe('');
  });

  it('returns empty when every verdict is accept (boring case)', () => {
    expect(renderHarnessPlanReviewsForPrompt([e('a', 'accept'), e('b', 'accept')])).toBe('');
  });

  it('renders only the non-accept verdicts as bullets', () => {
    const out = renderHarnessPlanReviewsForPrompt([
      e('a', 'accept', 'ignored'),
      e('b', 'accept-with-notes', 'mind the schema'),
      e('c', 'reject', 'wrong approach'),
    ]);
    expect(out).toContain('## Plan reviews');
    expect(out).toContain('- **b** · accept-with-notes — mind the schema');
    expect(out).toContain('- **c** · reject — wrong approach');
    expect(out).not.toContain('- **a**'); // accept filtered out
  });

  it('falls back to (no body) for an empty summary', () => {
    expect(renderHarnessPlanReviewsForPrompt([e('c', 'reject', '')])).toContain('- **c** · reject — (no body)');
  });
});
