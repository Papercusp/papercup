// @vitest-environment jsdom
/**
 * AgentsPanel.test.tsx — the plan Agents tab. Thoroughly covers the seven
 * exported pure helpers (pickOriginRevision, isStaleAgainst, formatOriginAuthor,
 * formatRunLaunchedBy, formatOriginWhen, launchErrorLabel, describeRunStatus)
 * and the component branches: the ?run detail takeover, the origin card states
 * (loading/error/none/drillable/tagged), the runs empty/list, and the launch
 * compose toggle + success-refresh / error-label paths.
 *
 * Seams: nuqs via NuqsTestingAdapter, plans-api hooks + launchPlanAgent,
 * rowSessionTag + RunDetailPanel stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

let revState: { data: unknown[] | null; loading: boolean; error: string | null };
let runState: { data: unknown[] | null; loading: boolean; error: string | null; refresh: () => void };
let launchImpl: (a: unknown) => Promise<unknown>;
const refreshMock = vi.fn();
vi.mock('./plans-api', () => ({
  usePlanRevisions: () => revState,
  usePlanRuns: () => runState,
  launchPlanAgent: (a: unknown) => launchImpl(a),
}));
vi.mock('./RevisionConversationModal', () => ({ rowSessionTag: (sid: string | null, kind: string | null) => (sid && kind === 'plan_run' ? null : 'from git history') }));
vi.mock('./RunDetailPanel', () => ({ default: () => <div data-testid="run-detail" /> }));

import AgentsPanel, {
  pickOriginRevision, isStaleAgainst, formatOriginAuthor, formatRunLaunchedBy,
  formatOriginWhen, launchErrorLabel, describeRunStatus,
} from './AgentsPanel';

const rev = (over: Record<string, unknown> = {}) => ({ id: 1, seq: 1, sessionId: 's1', sessionKind: 'plan_run', authorId: 'ada@x.com', authorKind: 'human', rationale: 'because', createdAt: 1_700_000_000_000, ...over });
const run = (over: Record<string, unknown> = {}) => ({ id: 1, title: 'Run A', status: 'idle', launchedBy: 'bob@x.com', launchedAt: 1_700_000_000_000, turnCount: 3, note: null, planContentHash: 'h1', ...over });

describe('AgentsPanel pure helpers', () => {
  it('pickOriginRevision finds the seq-1 origin (newest-first) or null', () => {
    expect(pickOriginRevision([])).toBeNull();
    const origin = rev({ id: 10, seq: 1 });
    expect(pickOriginRevision([rev({ seq: 3 }), rev({ seq: 2 }), origin] as never)).toBe(origin);
    expect(pickOriginRevision([rev({ seq: 2 }), rev({ seq: 3 })] as never)).toBeNull();
  });

  it('isStaleAgainst compares hashes, false on missing data', () => {
    expect(isStaleAgainst(run({ planContentHash: 'a' }) as never, 'b')).toBe(true);
    expect(isStaleAgainst(run({ planContentHash: 'a' }) as never, 'a')).toBe(false);
    expect(isStaleAgainst(run({ planContentHash: 'a' }) as never, undefined)).toBe(false);
    expect(isStaleAgainst(run({ planContentHash: null }) as never, 'b')).toBe(false);
  });

  it('formatOriginAuthor handles human emails and agent ids', () => {
    expect(formatOriginAuthor(rev({ authorKind: 'human', authorId: 'ada@x.com' }) as never)).toBe('ada');
    expect(formatOriginAuthor(rev({ authorKind: 'human', authorId: 'plainname' }) as never)).toBe('plainname');
    expect(formatOriginAuthor(rev({ authorKind: 'agent', authorId: 'claude-abc-def' }) as never)).toBe('claude-abc');
    expect(formatOriginAuthor(rev({ authorKind: 'agent', authorId: 'bot' }) as never)).toBe('bot');
  });

  it('formatRunLaunchedBy strips the email domain / truncates', () => {
    expect(formatRunLaunchedBy('bob@x.com')).toBe('bob');
    expect(formatRunLaunchedBy('short')).toBe('short');
    expect(formatRunLaunchedBy('x'.repeat(30))).toBe(`${'x'.repeat(24)}…`);
  });

  it('formatOriginWhen returns empty for non-positive/NaN ms', () => {
    expect(formatOriginWhen(0)).toBe('');
    expect(formatOriginWhen(-5)).toBe('');
    expect(formatOriginWhen(Number.NaN)).toBe('');
    expect(formatOriginWhen(1_700_000_000_000)).not.toBe('');
  });

  it('launchErrorLabel surfaces busy/not_found/other codes', () => {
    expect(launchErrorLabel({ error: 'busy', busy: [{ owner_label: 'shellX', intent: 'editing' }] })).toBe('Plan busy — shellX (editing)');
    expect(launchErrorLabel({ error: 'busy', busy: [{ owner_label: 'shellX' }] })).toBe('Plan busy — shellX');
    expect(launchErrorLabel({ error: 'busy', busy: [{}] })).toBe('Plan busy — another shell');
    expect(launchErrorLabel({ error: 'not_found' })).toBe('Plan not found.');
    expect(launchErrorLabel({ error: 'weird' })).toBe('Launch failed: weird');
    expect(launchErrorLabel({})).toBe('Launch failed: launch_failed');
  });

  it('describeRunStatus labels every status', () => {
    expect(describeRunStatus('running')).toMatch(/in progress/);
    expect(describeRunStatus('idle')).toMatch(/between turns/);
    expect(describeRunStatus('done')).toMatch(/manually marked/);
    expect(describeRunStatus('archived')).toMatch(/archived/);
    expect(describeRunStatus('failed')).toMatch(/failed/);
  });
});

describe('AgentsPanel component', () => {
  function renderPanel(opts: { searchParams?: string; currentHash?: string; onUrlUpdate?: (e: unknown) => void } = {}) {
    return render(
      <NuqsTestingAdapter searchParams={opts.searchParams ?? ''} onUrlUpdate={opts.onUrlUpdate}>
        <AgentsPanel slug="p1" planTitle="P1" currentContentHash={opts.currentHash ?? 'h1'} />
      </NuqsTestingAdapter>,
    );
  }
  beforeEach(() => {
    refreshMock.mockReset();
    revState = { data: [rev()], loading: false, error: null };
    runState = { data: [run()], loading: false, error: null, refresh: refreshMock };
    launchImpl = async () => ({ ok: true });
  });
  afterEach(cleanup);

  it('swaps to the run detail panel when ?run is set', () => {
    renderPanel({ searchParams: '?run=7' });
    expect(screen.getByTestId('run-detail')).toBeTruthy();
  });

  it('shows the origin author + a drillable conversation button', () => {
    renderPanel();
    expect(screen.getByText('ada')).toBeTruthy();
    expect(screen.getByRole('button', { name: /View authoring conversation/i })).toBeTruthy();
  });

  it('shows the origin loading and none states', () => {
    revState = { data: null, loading: true, error: null };
    renderPanel();
    expect(screen.getByText(/Loading author/i)).toBeTruthy();
    cleanup();
    revState = { data: [], loading: false, error: null };
    renderPanel();
    expect(screen.getByText(/No origin recorded/i)).toBeTruthy();
  });

  it('shows a session tag instead of the convo button when not drillable', () => {
    revState = { data: [rev({ sessionId: null, sessionKind: 'git_backfill' })], loading: false, error: null };
    renderPanel();
    expect(screen.getByText('from git history')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /View authoring conversation/i })).toBeNull();
  });

  it('lists past runs, empty when none', () => {
    renderPanel();
    expect(screen.getByText('Run A')).toBeTruthy();
    cleanup();
    runState = { data: [], loading: false, error: null, refresh: refreshMock };
    renderPanel();
    expect(screen.getByText(/No agents have been launched/i)).toBeTruthy();
  });

  it('opens the run detail view when a run row is clicked', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Run A'));
    expect(screen.getByTestId('run-detail')).toBeTruthy();
  });

  it('toggles the launch compose and refreshes on a successful launch', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    expect(screen.getByRole('button', { name: 'Launch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('shows the launch error label on a failed launch', async () => {
    launchImpl = async () => ({ error: 'not_found' });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(await screen.findByText('Plan not found.')).toBeTruthy();
  });
});
