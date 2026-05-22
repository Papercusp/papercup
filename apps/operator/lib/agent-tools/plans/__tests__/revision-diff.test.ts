/**
 * Unit coverage for buildRevisionDiffText (P-018).
 *
 * The handler is thin around `createPatch`; what matters is the
 * file/header naming + the seq-1 (no predecessor) behaviour, since
 * a malformed patch breaks `react-diff-view`'s parser at runtime.
 */
import { describe, expect, it } from 'vitest';
import { buildRevisionDiffText } from '../revision-diff';
import type { PlanRevisionPair } from '../revisions';

const newer = (snapshot: string): PlanRevisionPair['newer'] => ({
  id: 42,
  planSlug: 'plan-x-2026-05-22',
  seq: 3,
  contentSnapshot: snapshot,
  createdAt: 1716_000_000_000,
});

const older = (snapshot: string): NonNullable<PlanRevisionPair['older']> => ({
  seq: 2,
  contentSnapshot: snapshot,
  createdAt: 1715_900_000_000,
});

describe('buildRevisionDiffText', () => {
  it('uses <slug>.md as the diff filename', () => {
    const diff = buildRevisionDiffText({
      newer: newer('hello\n'),
      older: older('world\n'),
    });
    expect(diff).toMatch(/Index: plan-x-2026-05-22\.md/);
    expect(diff).toMatch(/--- plan-x-2026-05-22\.md/);
    expect(diff).toMatch(/\+\+\+ plan-x-2026-05-22\.md/);
  });

  it('labels both sides with the revision seq', () => {
    const diff = buildRevisionDiffText({
      newer: newer('hello\n'),
      older: older('world\n'),
    });
    expect(diff).toContain('revision #2');
    expect(diff).toContain('revision #3');
  });

  it('seq 1 (no predecessor) diffs against an empty string', () => {
    const diff = buildRevisionDiffText({
      newer: { ...newer('first line\nsecond line\n'), seq: 1 },
      older: null,
    });
    expect(diff).toContain('(empty)');
    expect(diff).toContain('revision #1');
    // Every content line is an addition; no content line is a deletion.
    expect(diff).toContain('+first line');
    expect(diff).toContain('+second line');
    // Exclude the `---` file-header line (unified-diff metadata) and
    // assert no single-`-` content lines appear (a `-X` would be a
    // deletion, which can't exist in an against-empty diff).
    const contentLines = diff
      .split('\n')
      .filter((l) => !l.startsWith('---'));
    expect(contentLines.some((l) => /^-[^-]/.test(l))).toBe(false);
  });

  it('produces a parseable unified-diff with normal +/- markers', () => {
    const diff = buildRevisionDiffText({
      newer: newer('line1\nNEW\nline3\n'),
      older: older('line1\nOLD\nline3\n'),
    });
    expect(diff).toContain('-OLD');
    expect(diff).toContain('+NEW');
    expect(diff).toMatch(/^@@/m); // at least one hunk header
  });

  it('identical snapshots yield no hunks', () => {
    const diff = buildRevisionDiffText({
      newer: newer('same\n'),
      older: older('same\n'),
    });
    // createPatch emits the file header but no @@ hunk when there is
    // no change — the modal's `diff.trim()` fallback handles this.
    expect(diff).not.toMatch(/^@@/m);
  });
});
