// @vitest-environment jsdom
//
// ReviewReportShell (cleanup-report-flows-2026-08-24 P-001): the shared
// grouped report-review surface — default selection covers every PENDING row,
// the group checkbox is tri-state (checked / indeterminate / unchecked) and
// toggles its pending rows as a block, applied rows render as done and are
// never selectable, Apply-selected emits the sorted selected ids, and busy
// freezes the whole surface.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ReviewReportShell, { type ReviewReportGroup } from './ReviewReportShell';

afterEach(cleanup);

function groupsFixture(): ReviewReportGroup[] {
  return [
    {
      id: 'flip-to-done',
      title: 'Flip to done',
      description: 'Open items whose linked work-item finished with evidence.',
      rows: [
        {
          id: 'f1',
          title: 'Index the finished work',
          sourceLabel: 'my-plan',
          referenceLabel: 'P-001',
          transition: { from: 'wip', to: 'done' },
          evidence: ['WI-100 done; completion recorded'],
          confidence: 'provable',
        },
        {
          id: 'f2',
          title: 'my-plan#P-002 → done',
          evidence: ['WI-101 done; NO completion record'],
          confidence: 'recommended',
        },
      ],
    },
    {
      id: 'orphaned-claim',
      title: 'Orphaned claims',
      rows: [
        {
          id: 'o1',
          title: 'my-plan#P-003 claim released',
          evidence: ['lease lapsed 42min ago; holder dead'],
          confidence: 'provable',
          status: 'applied',
        },
        {
          id: 'o2',
          title: 'other-plan#P-004 claim released',
          evidence: ['lease lapsed 12min ago; holder dead'],
          confidence: 'provable',
        },
      ],
    },
  ];
}

function renderShell(over: Partial<Parameters<typeof ReviewReportShell>[0]> = {}) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ReviewReportShell
      title="Plan clean-up report"
      icon={<span>✦</span>}
      subtitle="run #7"
      groups={groupsFixture()}
      onApply={onApply}
      onDismiss={onDismiss}
      {...over}
    />,
  );
  return { onApply, onDismiss };
}

const applyBtn = () => screen.getByTestId('review-report-apply') as HTMLButtonElement;
const groupCheck = (id: string) => screen.getByTestId(`review-group-check-${id}`) as HTMLButtonElement;
const rowCheck = (id: string) => screen.getByTestId(`review-row-check-${id}`) as HTMLButtonElement;

describe('rendering', () => {
  it('renders title, subtitle, groups, rows, evidence and confidence flags', () => {
    renderShell();
    expect(screen.getByText('Plan clean-up report')).toBeTruthy();
    expect(screen.getByTestId('review-report-icon')).toBeTruthy();
    expect(screen.getByText('run #7')).toBeTruthy();
    expect(screen.getByText('Flip to done')).toBeTruthy();
    expect(screen.getByText('WI-100 done; completion recorded')).toBeTruthy();
    expect(screen.getByText('my-plan')).toBeTruthy();
    expect(screen.getByText('P-001')).toBeTruthy();
    expect(screen.getByTestId('review-row-transition-f1').textContent).toContain('wip→done');
    expect(applyBtn().className).toContain('pc-btn');
    expect(screen.getByTestId('review-row-conf-f1').textContent).toBe('provable');
    expect(screen.getByTestId('review-row-conf-f2').textContent).toBe('recommended');
  });

  it('renders an applied row as done — status mark, no checkbox', () => {
    renderShell();
    expect(screen.getByTestId('review-row-mark-o1').textContent).toBe('✓');
    expect(screen.queryByTestId('review-row-check-o1')).toBeNull();
  });

  it('keeps a manual pending row visible but out of selection, and renders the flow footer', () => {
    renderShell({
      groups: [
        {
          id: 'manual',
          title: 'Refresh Now',
          rows: [
            {
              id: 'm1',
              title: 'rewrite Now',
              evidence: ['current Now is stale'],
              confidence: 'recommended',
              selectable: false,
            },
          ],
        },
      ],
      footer: 'Writes use the same hand-edit verbs.',
    });
    expect(screen.getByTestId('review-row-m1')).toBeTruthy();
    expect(screen.queryByTestId('review-row-check-m1')).toBeNull();
    expect(screen.getByTestId('review-row-mark-m1').textContent).toBe('↗');
    expect(applyBtn().disabled).toBe(true);
    expect(screen.getByText('Writes use the same hand-edit verbs.')).toBeTruthy();
  });
});

describe('selection + apply', () => {
  it('defaults to every PENDING row selected (applied rows excluded) and applies the sorted ids', () => {
    const { onApply } = renderShell();
    expect(applyBtn().textContent).toContain('(3)');
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['f1', 'f2', 'o2']);
  });

  it('unchecking a row removes it from the apply set', () => {
    const { onApply } = renderShell();
    fireEvent.click(rowCheck('f2'));
    expect(applyBtn().textContent).toContain('(2)');
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['f1', 'o2']);
  });

  it("defaultSelected 'none' starts empty with Apply disabled; an explicit id list is honored", () => {
    renderShell({ defaultSelected: 'none' });
    expect(applyBtn().disabled).toBe(true);
    cleanup();
    const { onApply } = renderShell({ defaultSelected: ['f1'] });
    expect(applyBtn().textContent).toContain('(1)');
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['f1']);
  });

  it('dismiss fires onDismiss; busy disables apply, dismiss and checkboxes', () => {
    const { onDismiss } = renderShell();
    fireEvent.click(screen.getByTestId('review-report-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    cleanup();
    renderShell({ busy: true });
    expect(applyBtn().disabled).toBe(true);
    expect((screen.getByTestId('review-report-dismiss') as HTMLButtonElement).disabled).toBe(true);
    expect(rowCheck('f1').disabled).toBe(true);
  });
});

describe('tri-state group checkbox', () => {
  it('reflects all → indeterminate → none, and toggles its pending rows as a block', () => {
    renderShell();
    const check = groupCheck('flip-to-done');
    expect(check.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(rowCheck('f2'));
    expect(groupCheck('flip-to-done').getAttribute('aria-checked')).toBe('mixed');

    // some → select ALL pending in the group
    fireEvent.click(groupCheck('flip-to-done'));
    expect(groupCheck('flip-to-done').getAttribute('aria-checked')).toBe('true');
    expect(applyBtn().textContent).toContain('(3)');

    // all → clear the group (other groups untouched)
    fireEvent.click(groupCheck('flip-to-done'));
    expect(groupCheck('flip-to-done').getAttribute('aria-checked')).toBe('false');
    expect(applyBtn().textContent).toContain('(1)');
    expect(rowCheck('o2').getAttribute('aria-checked')).toBe('true');
  });

  it('only counts pending rows — a group of applied rows renders its checkbox disabled', () => {
    renderShell({
      groups: [
        {
          id: 'all-applied',
          title: 'All applied',
          rows: [
            { id: 'a1', title: 'done already', evidence: [], confidence: 'provable', status: 'applied' },
          ],
        },
      ],
    });
    expect(groupCheck('all-applied').disabled).toBe(true);
  });
});

describe('collapse', () => {
  it('collapsing a group hides its rows (and description) without touching selection', () => {
    renderShell();
    expect(screen.getByTestId('review-row-f1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('review-group-toggle-flip-to-done'));
    expect(screen.queryByTestId('review-row-f1')).toBeNull();
    expect(applyBtn().textContent).toContain('(3)'); // selection preserved
    fireEvent.click(screen.getByTestId('review-group-toggle-flip-to-done'));
    expect(screen.getByTestId('review-row-f1')).toBeTruthy();
  });
});
