// @vitest-environment jsdom
//
// PlansPane render (owner-plans-single-pane-2026-07-17 P-002/P-007): rows
// render with their needs-you / live / progress badges, the finished toggle
// flips ?plf, and clicking a row opens the plan popup (?pplan). The data hooks
// (usePlanList / useInboxAttention / useSyncQuery roster / useWorkspaceId) and
// the heavy PlanPopupModal (→ PlanDetail) are mocked; nuqs is a seeded store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

const { nuqs, setters, planListData, attentionItems, rosterData } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  planListData: { value: null as { plans: PlanListRow[] } | null },
  attentionItems: { value: [] as Array<{ planSlug: string | null; tier: string; needsHuman?: boolean; kind?: string }> },
  rosterData: { value: [{ active: [] as Array<{ currentPlanSlug?: string | null }> }] },
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  // Apply the parser's withDefault (stored as `_d`) when the key is unset, so a
  // component reading `query.trim()` never sees undefined (real nuqs behavior).
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
  parseAsBoolean: { withDefault: (d: unknown) => ({ _d: d }) },
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: rosterData.value, loading: false, error: null, invalidate: vi.fn() }),
}));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
// Keep bucketOf real (buildGlanceRows uses it) — only stub the data hook.
vi.mock('@/app/admin/plans/plans-api', async (orig) => ({
  ...(await orig<typeof import('@/app/admin/plans/plans-api')>()),
  usePlanList: () => ({ data: planListData.value, loading: planListData.value === null, error: null, refresh: vi.fn() }),
}));
vi.mock('../inbox/use-inbox-pending', () => ({
  effectiveTier: (i: { tier?: string }) => i.tier ?? 'activity',
  useInboxAttention: () => ({ items: attentionItems.value, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('./PlanPopupModal', () => ({
  default: ({ planSlug }: { planSlug: string | null }) =>
    planSlug ? <div data-testid="popup-open">{planSlug}</div> : null,
}));

import PlansPane from './PlansPane';

function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug, title: over.title ?? over.slug, status: over.status ?? 'active',
    updated: over.updated ?? '2026-07-17T00:00:00Z', created: null, owner: null,
    archived: false, isLegacy: false, itemCounts: over.itemCounts ?? null, nextAction: null,
    harness: 'papercusp', startStatus: over.startStatus ?? null, priority: null, maxImportance: null,
  } as PlanListRow;
}

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  attentionItems.value = [];
  rosterData.value = [{ active: [] }];
});

describe('PlansPane', () => {
  it('renders active plans with needs-you, live, and progress badges', () => {
    planListData.value = {
      plans: [
        plan({ slug: 'p-hot', title: 'Hot plan', itemCounts: { done: 2, todo: 3 } }),
        plan({ slug: 'p-cold', title: 'Cold plan' }),
      ],
    };
    attentionItems.value = [{ planSlug: 'p-hot', tier: 'decision' }];
    rosterData.value = [{ active: [{ currentPlanSlug: 'p-hot' }, { currentPlanSlug: 'p-hot' }] }];

    render(<PlansPane />);
    expect(screen.getByText('Hot plan')).toBeTruthy();
    expect(screen.getByText('Cold plan')).toBeTruthy();
    // needs-you badge (1 decision item) + live badge (2 agents) on p-hot
    expect(screen.getByTestId('plans-pane-needs-badge').textContent).toBe('1');
    expect(screen.getByTestId('plans-pane-live-badge').textContent).toContain('2');
  });

  it('opens the plan popup (sets ?pplan) when a row is clicked', () => {
    planListData.value = { plans: [plan({ slug: 'p-open', title: 'Open me' })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-row-p-open'));
    expect(setters.pplan).toHaveBeenCalledWith('p-open');
  });

  it('finished toggle flips ?plf', () => {
    planListData.value = { plans: [plan({ slug: 'p1' })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-finished-toggle'));
    expect(setters.plf).toHaveBeenCalledWith(true);
  });

  it('shows the active-empty message when there are no active plans', () => {
    planListData.value = { plans: [plan({ slug: 'shipped', status: 'shipped' })] };
    render(<PlansPane />);
    expect(screen.getByText(/everything is finished/i)).toBeTruthy();
  });
});
