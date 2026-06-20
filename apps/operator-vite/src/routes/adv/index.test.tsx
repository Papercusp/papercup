// @vitest-environment jsdom
/**
 * adv/index.test.tsx — the /adv tab router. The ?tab= nuqs enum selects both
 * the AdvShell title and which tab surface renders (a big switch). Covers every
 * branch: the eight first-class tabs, the Create dock (plans), the harness-panel
 * tabs (brainstorm/prs/insights/git/testing → AdvHarnessPanelPage with the panel
 * id), and the overview default when ?tab is absent. Every tab child + AdvShell
 * are stubbed to markers.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route), nuqs (real adapter
 * for ?tab=), AdvShell (exposes its title prop + ADV_TABS for the enum),
 * AdvHarnessPanelPage (exposes ADV_HARNESS_PANEL_LABELS).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));

const ADV_TABS = [
  'overview', 'conversations', 'learning', 'harnesses', 'health', 'frames',
  'evals', 'calendar', 'plans', 'brainstorm', 'prs', 'insights', 'settings',
  'docs', 'git', 'testing',
].map((id) => ({ id }));

vi.mock('../../components/adv/AdvShell', () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="adv-shell" data-title={title}>{children}</div>
  ),
  ADV_TABS,
}));
vi.mock('../../components/adv/AdvOverviewTab', () => ({ default: () => <div data-testid="tab-overview" /> }));
vi.mock('../../components/adv/AdvConversationsTab', () => ({ default: () => <div data-testid="tab-conversations" /> }));
vi.mock('../../components/adv/LearningTab', () => ({ default: () => <div data-testid="tab-learning" /> }));
vi.mock('../../components/adv/AdvFramesTab', () => ({ default: () => <div data-testid="tab-frames" /> }));
vi.mock('../../components/adv/AdvEvalsTab', () => ({ default: () => <div data-testid="tab-evals" /> }));
vi.mock('../../components/adv/ScheduledCalendarTab', () => ({ default: () => <div data-testid="tab-calendar" /> }));
vi.mock('../../components/adv/HealthTab', () => ({ default: () => <div data-testid="tab-health" /> }));
vi.mock('../../components/adv/AdvHarnessPanelPage', () => ({
  default: ({ panel }: { panel: string }) => <div data-testid="harness-panel" data-panel={panel} />,
  ADV_HARNESS_PANEL_LABELS: {
    brainstorm: 'Brainstorm', prs: 'PRs', insights: 'Insights',
    settings: 'Settings', docs: 'Docs', git: 'Git', testing: 'Testing',
  },
}));
vi.mock('@/app/adv/harnesses/HarnessesWorkspace', () => ({ default: () => <div data-testid="tab-harnesses" /> }));
vi.mock('@/app/adv/create/AdvCreateDock', () => ({ default: () => <div data-testid="tab-create-dock" /> }));
vi.mock('@/app/admin/plans/plans.css', () => ({}));

import { Route } from './index';

const Comp = Route.component as () => JSX.Element;
function renderAdv(searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}><Comp /></NuqsTestingAdapter>);
}
const title = () => screen.getByTestId('adv-shell').getAttribute('data-title');

afterEach(cleanup);

describe('/adv tab router', () => {
  const FIRST_CLASS = [
    { tab: 'overview', t: 'Overview', child: 'tab-overview' },
    { tab: 'conversations', t: 'Conversations', child: 'tab-conversations' },
    { tab: 'learning', t: 'Learning', child: 'tab-learning' },
    { tab: 'harnesses', t: 'Working', child: 'tab-harnesses' },
    { tab: 'health', t: 'Health', child: 'tab-health' },
    { tab: 'frames', t: 'Frames', child: 'tab-frames' },
    { tab: 'evals', t: 'Evaluation', child: 'tab-evals' },
    { tab: 'calendar', t: 'Calendar', child: 'tab-calendar' },
    { tab: 'plans', t: 'Create', child: 'tab-create-dock' },
  ] as const;

  it.each(FIRST_CLASS)('renders the $tab surface with title "$t"', ({ tab, t, child }) => {
    renderAdv(`?tab=${tab}`);
    expect(title()).toBe(t);
    expect(screen.getByTestId(child)).toBeTruthy();
  });

  const PANELS = [
    { tab: 'brainstorm', t: 'Brainstorm' },
    { tab: 'prs', t: 'PRs' },
    { tab: 'insights', t: 'Insights' },
    { tab: 'git', t: 'Git' },
    { tab: 'testing', t: 'Testing' },
  ] as const;

  it.each(PANELS)('routes the $tab tab to the harness panel page', ({ tab, t }) => {
    renderAdv(`?tab=${tab}`);
    expect(title()).toBe(t);
    expect(screen.getByTestId('harness-panel').getAttribute('data-panel')).toBe(tab);
  });

  it('defaults to the overview surface when ?tab is absent', () => {
    renderAdv('');
    expect(title()).toBe('Overview');
    expect(screen.getByTestId('tab-overview')).toBeTruthy();
  });

  it('falls back to overview for an unknown ?tab value (enum guard)', () => {
    renderAdv('?tab=bogus');
    expect(title()).toBe('Overview');
    expect(screen.getByTestId('tab-overview')).toBeTruthy();
  });
});
