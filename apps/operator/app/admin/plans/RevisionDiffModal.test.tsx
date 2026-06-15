// @vitest-environment jsdom
//
// RevisionDiffModal — the per-revision diff modal (plan-agent-launch P-018).
// The two pure helpers (formatFilePath / countChanges) and the conditional
// <DiffBody /> are already exported; they're tested branch-by-branch. The
// default component gets a render-smoke driving a mocked fetchPlanRevisionDiff
// (the title label + raw-patch fallback surfaces) — react-diff-view's heavy
// <Diff>/<Hunk> + the Radix Modal are stubbed since they're not under test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { FileData } from 'react-diff-view';

// Hoisted holder so the plans-api mock factory can resolve a per-test result.
const { diffResult } = vi.hoisted(() => ({
  diffResult: {
    value: null as null | { diff: string; slug: string; seq: number; priorSeq: number | null },
    reject: null as null | Error,
  },
}));

vi.mock('./plans-api', () => ({
  fetchPlanRevisionDiff: () =>
    diffResult.reject ? Promise.reject(diffResult.reject) : Promise.resolve(diffResult.value),
}));

// react-diff-view ships an ESM build that touches layout APIs jsdom lacks and
// isn't under test here — stub Diff/Hunk to inert nodes and keep the real
// parseDiff so the component's parse path still exercises.
vi.mock('react-diff-view', async () => {
  const actual = await vi.importActual<typeof import('react-diff-view')>('react-diff-view');
  return {
    ...actual,
    Diff: ({ children }: { children?: unknown }) => <div data-testid="diff-stub" />,
    Hunk: () => <div data-testid="hunk-stub" />,
  };
});

// The Modal wraps content in a Radix Dialog with a portal/overlay we don't need
// here — render an inert passthrough that only mounts children when `open`.
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

import RevisionDiffModal, {
  DiffBody,
  formatFilePath,
  countChanges,
} from './RevisionDiffModal';

afterEach(() => {
  cleanup();
  diffResult.value = null;
  diffResult.reject = null;
});

describe('formatFilePath', () => {
  it('returns the new path when there is no old path (added file)', () => {
    expect(formatFilePath('', 'lib/new.ts')).toBe('lib/new.ts');
  });
  it('returns the old path when paths are equal (modified in place)', () => {
    expect(formatFilePath('lib/x.ts', 'lib/x.ts')).toBe('lib/x.ts');
  });
  it('returns the old path when the new path is empty (deleted file)', () => {
    expect(formatFilePath('lib/gone.ts', '')).toBe('lib/gone.ts');
  });
  it('renders "a → b" when the paths differ (rename)', () => {
    expect(formatFilePath('old/a.ts', 'new/b.ts')).toBe('old/a.ts → new/b.ts');
  });
});

function fileWith(changeTypes: string[]): FileData {
  return {
    oldPath: 'a.ts',
    newPath: 'a.ts',
    oldRevision: '0',
    newRevision: '1',
    type: 'modify',
    hunks: [{ changes: changeTypes.map((type) => ({ type })) }],
  } as unknown as FileData;
}

describe('countChanges', () => {
  it('tallies inserts and deletes across hunks', () => {
    const file = fileWith(['insert', 'insert', 'delete', 'normal']);
    expect(countChanges(file)).toEqual({ additions: 2, deletions: 1 });
  });
  it('returns zeros for a file with no changing lines', () => {
    expect(countChanges(fileWith(['normal', 'normal']))).toEqual({ additions: 0, deletions: 0 });
  });
  it('sums across multiple hunks', () => {
    const file = {
      hunks: [
        { changes: [{ type: 'insert' }] },
        { changes: [{ type: 'insert' }, { type: 'delete' }] },
      ],
    } as unknown as FileData;
    expect(countChanges(file)).toEqual({ additions: 2, deletions: 1 });
  });
});

describe('<DiffBody />', () => {
  it('renders the empty-state when there are no files and the diff is blank', () => {
    render(<DiffBody diff="   " files={[]} parseError={null} />);
    expect(screen.getByText(/no changes in this revision/i)).toBeTruthy();
  });

  it('falls back to the raw patch (in a <pre>) when parsing yielded no files', () => {
    const { container } = render(
      <DiffBody diff="some raw patch text" files={[]} parseError={null} />,
    );
    const pre = container.querySelector('pre.pc-git-diff__raw');
    expect(pre?.textContent).toBe('some raw patch text');
  });

  it('shows the parse-warning banner above the raw patch when parseError is set', () => {
    render(<DiffBody diff="raw" files={[]} parseError="bad patch" />);
    expect(screen.getByText(/couldn’t parse the diff into structured hunks/i)).toBeTruthy();
  });

  it('renders one file card per parsed file with its +/- stats', () => {
    const file = {
      oldPath: 'a.ts',
      newPath: 'a.ts',
      oldRevision: '0',
      newRevision: '1',
      type: 'modify',
      hunks: [{ oldStart: 1, newStart: 1, changes: [{ type: 'insert' }, { type: 'delete' }] }],
    } as unknown as FileData;
    const { container } = render(<DiffBody diff="x" files={[file]} parseError={null} />);
    expect(container.querySelectorAll('section.pc-git-diff-file')).toHaveLength(1);
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });
});

describe('<RevisionDiffModal />', () => {
  it('renders nothing (no dialog) when revisionId is null', () => {
    const { container } = render(<RevisionDiffModal revisionId={null} onClose={() => {}} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the creation title and a parsed file card for a real diff (no prior seq)', async () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 111..222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' same',
    ].join('\n');
    diffResult.value = { diff, slug: 'p', seq: 1, priorSeq: null };
    const { container } = render(<RevisionDiffModal revisionId={5} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Revision #1 (creation)')).toBeTruthy());
    expect(container.querySelector('section.pc-git-diff-file')).toBeTruthy();
  });

  it('shows the "#N vs #M" comparison title when a prior seq exists', async () => {
    diffResult.value = { diff: 'x', slug: 'p', seq: 4, priorSeq: 3 };
    render(<RevisionDiffModal revisionId={9} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Revision #4 vs #3')).toBeTruthy());
  });

  it('surfaces the fetch error in the error slot', async () => {
    diffResult.reject = new Error('diff fetch failed');
    render(<RevisionDiffModal revisionId={2} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('diff fetch failed')).toBeTruthy());
  });
});
