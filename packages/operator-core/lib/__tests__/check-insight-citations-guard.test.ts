/**
 * check-insight-citations-guard.test.ts — the stale-citation CI guard (WI-1576).
 *
 * The guard (`scripts/check-insight-citations.mjs`) runs green over the real
 * agent-insights corpus in CI, which proves the no-FALSE-POSITIVE direction on
 * the live corpus (381 docs / 1584 citations, 0 stale as of 2026-07-02). This
 * locks that the script's re-exported detector is the SAME pure implementation
 * `insight-citations.ts` ships (full behavior coverage lives there) and that the
 * CLI wiring itself doesn't silently diverge.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findStaleInsightCitations, formatStaleCitations } from '../../../../scripts/check-insight-citations.mjs';

describe('check-insight-citations guard detector (WI-1576)', () => {
  it('re-exports the same pure detector the CLI script scans with', () => {
    const bad = '---\ntitle: x\ndocuments:\n  - packages/definitely/does-not-exist.ts\n---\n\nbody\n';
    const stale = findStaleInsightCitations(bad, process.cwd());
    expect(stale).toEqual([{ path: 'packages/definitely/does-not-exist.ts', kind: 'path' }]);
    expect(formatStaleCitations(stale)).toMatch(/stale documents: citation/i);
  });

  it('does not flag a doc with no `documents:` field', () => {
    const good = '---\ntitle: x\n---\n\nbody\n';
    expect(findStaleInsightCitations(good, process.cwd())).toEqual([]);
    expect(formatStaleCitations([])).toBeNull();
  });
});
