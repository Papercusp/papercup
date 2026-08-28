// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import type { AutomationCatalog, AutomationRoutine } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';

const H = vi.hoisted(() => ({
  runTool: vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<{
      ok: boolean;
      message?: string;
      data?: Record<string, unknown>;
    }>
  >(
    async () => ({ ok: true }),
  ),
  invalidates: [] as string[],
  queries: [] as Array<{ queryName: string; args: unknown }>,
  emptyData: false,
}));

function routine(): AutomationRoutine {
  return {
    name: 'git-sync', installSlug: 'papercusp', group: 'git-sync', category: 'infra',
    cron: '0 */2 * * * *', cadence: 'every 2m', active: true, spend: 'none',
    spendWhy: 'Runs inline', spawnsAgent: false, kind: 'scheduled', family: 'git-release',
    liveness: 'running', armedState: 'armed', control: 'routine', controlWhy: 'Pause from routines:set',
    flagKey: null, needsAttention: false, installs: ['papercusp'], ownerId: null,
    ownerLastActiveAt: null, triggerLabel: null, lastFiredAt: '2026-08-22T19:58:00.000Z',
    nextFireAt: '2026-08-22T20:02:00.000Z', source: 'routines', controllable: true,
  };
}

const catalog: AutomationCatalog = {
  routines: [routine()],
  categories: [],
  spend7d: [{ role: 'doc-steward', modelClass: 'claude', turns: 4, outputTokens: 1200, cacheReadTokens: 800, costUsd: 2.4, lastSeenAt: '2026-08-22T19:00:00.000Z' }],
  spend7dTotalUsd: 2.4,
  arming: { gymPots: [], lanes: [], scoutCeiling: null },
  generatedAt: '2026-08-22T20:00:00.000Z',
};

const external: ExternalTriggerAdminSnapshot = {
  enabled: true,
  counts: { sources: 1, bindings: 1, armed: 1, recentFailures: 0 },
  sources: [{ id: 'source-slack', kind: 'slack', status: 'connected', config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0, social: null }],
  bindings: [{ id: '11111111-1111-4111-8111-111111111111', sourceId: 'source-slack', sourceKind: 'slack', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', eventPattern: 'ext:slack:message', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: { id: 'run-1', status: 'done', triggeredAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', error: null } }],
  recentRuns: [{
    id: 'run-1', bindingId: '11111111-1111-4111-8111-111111111111', sourceKind: 'slack', eventPattern: 'ext:slack:message', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', status: 'done', attempts: 1,
    dedupeKey: 'slack:run-1', triggeredAt: '2026-08-22T19:00:00.000Z', startedAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', planRunRef: 'run:1', error: null,
    causeSummary: 'Slack message matched', policyDisposition: 'ran', policyDetail: 'ran', eventFilter: {}, stormPolicy: {}, redactedPayload: {}, outcomeLinks: [], timeline: [], planRun: null,
  }],
};

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args, enabled }: { queryName: string; args: unknown; enabled?: boolean }) => {
    H.queries.push({ queryName, args });
    const invalidate = vi.fn(() => H.invalidates.push(queryName));
    // The real useSyncQuery does not run a disabled query. Honouring that here matters:
    // without it the mock hands run history to a routine that has no plan, and the
    // inspector's "no verified run cost" path can never be exercised.
    if (enabled === false) return { data: [], loading: false, invalidate };
    if (H.emptyData) return { data: [], loading: false, invalidate };
    if (queryName === 'automation.catalog') return { data: [catalog], loading: false, invalidate };
    if (queryName === 'harnessProjects.lite') return { data: [{ slug: 'papercusp' }], loading: false, invalidate };
    if (queryName === 'plans.list') return { data: [
      { slug: 'customer-digest', title: 'Customer feedback digest', harness: 'papercusp', status: 'ready', nextAction: 'Turns feedback into a prioritized brief', triggered: true, triggerSources: ['schedule', 'external', 'manual'], scheduled: true, scheduleActive: true },
      { slug: 'rubric-ratification', title: 'Rubric ratification', harness: 'papercusp', status: 'ready', nextAction: 'Wait for independent review', triggered: true, triggerSources: ['manual'], scheduled: false, scheduleActive: false },
    ], loading: false, invalidate };
    if (queryName === 'plans.schedule') return { data: [{ templateSlug: 'customer-digest', title: 'Customer feedback digest', harnessSlug: 'papercusp', schedule: { rrule: 'RRULE:FREQ=DAILY;BYHOUR=9', tzid: 'America/New_York' }, scheduledAt: null, expiresAt: null, tzid: 'America/New_York', scheduleActive: true }], loading: false, invalidate };
    if (queryName === 'plans.scheduledOccurrences') return { data: [{ templateSlug: 'customer-digest', title: 'Customer feedback digest', harnessSlug: 'papercusp', occurrenceMs: Date.now() + 18 * 60_000, kind: 'recurring', scheduleActive: true, lastOutcome: 'success' }], loading: false, invalidate };
    if (queryName === 'plans.runHistory') return { data: [{ runs: [{ id: 1, status: 'done', trigger: 'manual', outcome: 'success', launchedAt: Date.now() - 60_000, durationMs: 45_000, costUsd: 0.62 }], rollup: { total: 1, successRate: 1, totalCostUsd: 0.62, medianDurationMs: 45_000, running: 0, failed: 0 } }], loading: false, invalidate };
    return { data: [], loading: false, invalidate };
  },
}));

vi.mock('@/app/admin/plans/plans-api', () => ({
  fetchPlanInputs: vi.fn(async () => ({ ok: true, slug: 'customer-digest', source: 'input-schema', inputSchema: {}, template: null, required: ['topic', 'urgency'], missing: [], values: { topic: 'feedback', urgency: 'high' }, ready: true })),
}));
vi.mock('@/app/adv/create/use-create-data', () => ({ useResolvedHarnessSlug: () => 'papercusp' }));
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => (
    open ? <div role="dialog" aria-label={title}>{children}</div> : null
  ),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: ReactNode }>;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));
vi.mock('@/app/harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }) }));
vi.mock('@/app/harness/ChatPanel', () => ({
  default: ({ initialMessage, context }: { initialMessage?: string; context?: string }) => (
    <div data-testid="workflow-composer-chat" data-context={context ?? ''}>{initialMessage ?? 'Empty composer chat'}</div>
  ),
}));
vi.mock('./ScheduleEditor', () => ({ runScheduleTool: H.runTool }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdvWorkflowsTab from './AdvWorkflowsTab';

const DIGEST = 'plan:papercusp:customer-digest';

function renderTab(searchParams?: Record<string, string>) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <AdvWorkflowsTab />
    </NuqsTestingAdapter>,
  );
}

/**
 * Selection is seeded through the URL rather than clicked, for the same reason the previous
 * suite did it: nuqs batches its URL writes, so a click-then-assert races the flush.
 */
function renderTabOnDigest() {
  return renderTab({ wfSelId: DIGEST });
}

async function openAdvancedWorkflowSetup() {
  fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
  const composer = await screen.findByRole('dialog', { name: 'Compose a workflow with the agent' });
  fireEvent.click(within(composer).getByRole('button', { name: 'Advanced manual setup' }));
  return screen.getByRole('dialog', { name: 'Create a workflow' });
}

beforeEach(() => {
  H.runTool.mockReset();
  H.runTool.mockResolvedValue({ ok: true });
  H.invalidates.length = 0;
  H.queries.length = 0;
  H.emptyData = false;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(_input).includes('/agent-chats')) {
      return new Response(JSON.stringify({ id: 'workflow-composer-chat-1' }), { status: 200 });
    }
    if (init?.method === 'PATCH') {
      const request = JSON.parse(String(init.body ?? '{}')) as { op?: string; id?: string };
      if (request.op === 'attach-external') {
        return new Response(JSON.stringify({ ok: true, binding: { id: '22222222-2222-4222-8222-222222222222' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, binding: { id: request.id } }), { status: 200 });
    }
    return new Response(JSON.stringify(H.emptyData
      ? { enabled: true, counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 }, sources: [], bindings: [], recentRuns: [] }
      : external), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('<AdvWorkflowsTab> — one frame (D-001)', () => {
  it('renders a single frame: one masthead, the ledger and the inspector together', async () => {
    renderTab();
    // ONE heading. The retired landing painted a second "Workflows" under this one.
    expect(await screen.findByRole('heading', { name: 'Workflows', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Workflows' })).toHaveLength(1);

    expect(screen.getByRole('region', { name: 'Describe a workflow' })).toBeTruthy();
    expect(screen.getByLabelText('Workflow inspector')).toBeTruthy();
    // Both populations are in ONE ledger — routines are no longer exiled to a Catalog view.
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
    expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();

    // The five sub-views are gone.
    for (const gone of ['Overview', 'Flows', 'Catalog', 'Sources']) {
      expect(screen.queryByRole('tab', { name: gone })).toBeNull();
    }
    expect(screen.queryByLabelText('Search trigger flows')).toBeNull();
  });

  it('summarises the population and surfaces source health as a filter (D-003)', async () => {
    renderTab();
    expect(await screen.findByText('1 triggered · 1 system task')).toBeTruthy();

    const sources = screen.getByRole('group', { name: 'Source health' });
    const slack = within(sources).getByRole('button', { name: /^Slack: connected/ });
    expect(within(sources).getByRole('button', { name: /^Schedule:/ })).toBeTruthy();

    fireEvent.click(slack);
    await waitFor(() => expect(slack.getAttribute('aria-pressed')).toBe('true'));
    // Filtering to Slack keeps the slack-triggered plan and drops the internal routine.
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
    expect(screen.queryByTestId('wf-row:routine:git-sync:papercusp')).toBeNull();
  });

  it('renders NOTHING for the needs-you strip when nothing needs the operator (D-018/D-004)', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    // The rule this preserves: no "all clear" card, no empty frame — absence IS the state.
    expect(screen.queryByTestId('workflows-needs-you')).toBeNull();
  });

  it('filters by state and kind facets over one ledger instead of switching views', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: /^Running/ }));
    await waitFor(() => expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull());
    expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Triggered/ }));
    await waitFor(() => expect(screen.queryByTestId('wf-row:routine:git-sync:papercusp')).toBeNull());
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
  });

  it('says which kind of empty it is', async () => {
    renderTab({ wfQ: 'nothing-matches-this' });
    expect(await screen.findByText('No workflows match these filters.')).toBeTruthy();

    cleanup();
    H.emptyData = true;
    renderTab();
    expect(await screen.findByText(/No workflows are installed yet/)).toBeTruthy();
  });

  it('renders the ledger truthfully: a spend classification, never invented dollars (D-005)', async () => {
    renderTab();
    const row = await screen.findByTestId(`wf-row:${DIGEST}`);
    // The verified dollars live in the inspector; the row carries the classification.
    expect(within(row).getByText('per run')).toBeTruthy();
    expect(within(row).queryByText(/^\$/)).toBeNull();
    expect(within(screen.getByTestId('wf-row:routine:git-sync:papercusp')).getByText('$0')).toBeTruthy();
  });
});

describe('<AdvWorkflowsTab> — the inspector is the detail surface (D-002)', () => {
  it('inspects the selected workflow, with its triggers and verified run cost', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    expect(within(inspector).getByRole('heading', { name: 'Customer feedback digest' })).toBeTruthy();
    expect(within(inspector).getByText('Turns feedback into a prioritized brief')).toBeTruthy();
    // Both installed triggers, each with its own arm control.
    expect(within(inspector).getByText('FREQ=DAILY · BYHOUR=9')).toBeTruthy();
    expect(within(inspector).getByText('ext:slack:message')).toBeTruthy();
    // Measured here, so a dollar figure is honest here.
    await waitFor(() => expect(within(inspector).getByText('$0.62 · 1 run')).toBeTruthy());
  });

  it('reports no verified run cost rather than formatting an absent number as $0.00', async () => {
    renderTab({ wfSelId: 'routine:git-sync:papercusp' });
    const inspector = await screen.findByLabelText('Workflow inspector');
    expect(within(inspector).getByText('$0 model spend')).toBeTruthy();
    expect(within(inspector).queryByText('$0.00')).toBeNull();
  });

  it('fires Run manually through plans:run-now', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Run manually' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('plans:run-now', { slug: 'customer-digest', harness: 'papercusp' }));
  });

  it('toggles one external binding through the audited trigger admin route', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Disarm ext:slack:message' }));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH'
        && String(init.body).includes('11111111-1111-4111-8111-111111111111')
        && String(init.body).includes('"armed":false'))).toBe(true);
    });
  });

  it('expands into the topology + agent destination rather than opening a second detail view', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: /^Expand Customer feedback digest/ }));
    // The expansion replaces the frame — one destination, reached from the inspector.
    expect(await screen.findByLabelText('Workflow detail')).toBeTruthy();
    expect(screen.queryByLabelText('Workflow inspector')).toBeNull();
  });

  it('confirms and queues a distinct last-event run from the expanded view', async () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    H.runTool.mockResolvedValueOnce({ ok: true, data: { ok: true, run: { id: runId } } });
    renderTab({ wfId: DIGEST });
    fireEvent.click(await screen.findByRole('button', { name: 'Test with last event' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('triggers:run-with-last-event', {
      bindingId: '11111111-1111-4111-8111-111111111111',
      confirm: true,
    }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Test run 33333333 queued from the last provider event',
    );
  });
});

describe('<AdvWorkflowsTab> — ledger controls and activity', () => {
  it('pauses every automatic trigger from the row control when the workflow is armed', async () => {
    renderTab();
    const row = await screen.findByTestId(`wf-row:${DIGEST}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Disarm Customer feedback digest' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('plans:disarm-schedule', { slug: 'customer-digest', harness: 'papercusp' }));
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init.body).includes('"armed":false'))).toBe(true);
    });
  });

  it('pauses a controllable routine through routines:set', async () => {
    renderTab();
    const row = await screen.findByTestId('wf-row:routine:git-sync:papercusp');
    fireEvent.click(within(row).getByRole('button', { name: 'Disarm git-sync' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('routines:set', expect.objectContaining({
      name: 'git-sync',
      installSlug: 'papercusp',
      active: false,
    })));
  });

  it('shows Activity as a mode of the same frame, keeping the inspector', async () => {
    renderTab({ wfMode: 'activity' });
    expect(await screen.findByTestId('wf-activity:external-run:run-1')).toBeTruthy();
    // Same frame: the inspector does not disappear when the mode changes.
    expect(screen.getByLabelText('Workflow inspector')).toBeTruthy();
    expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull();
  });

  it('switches into Activity from the mode control', async () => {
    renderTab();
    // Radix activates a tab on mousedown, not on a bare click event.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    await waitFor(() => expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull());
    expect(screen.getByTestId('wf-activity:external-run:run-1')).toBeTruthy();
  });

  it('reads plans workspace-wide without fanning out the project registry', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    expect(H.queries.some(({ queryName, args }) => queryName === 'plans.list' && JSON.stringify(args) === '{}')).toBe(true);
    expect(H.queries.some(({ queryName }) => queryName === 'harnessProjects.lite')).toBe(false);
  });

  it('excludes a plan with no automatic trigger — manual launch is not a trigger', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    expect(screen.queryByText('Rubric ratification')).toBeNull();
  });
});

describe('<AdvWorkflowsTab> — composing and creating', () => {
  it('opens the canonical workflow-agent composer with intent and source context, never the manual form by default', async () => {
    renderTab();
    const input = await screen.findByLabelText(/What should happen automatically/);
    fireEvent.change(input, { target: { value: 'When a client email arrives, draft a concise reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wire it' }));

    const dialog = await screen.findByRole('dialog', { name: 'Compose a workflow with the agent' });
    expect(within(dialog).queryByLabelText('Event pattern')).toBeNull();
    expect(within(dialog).queryByText('Automatic trigger')).toBeNull();
    const chat = await within(dialog).findByTestId('workflow-composer-chat');
    expect(chat.textContent).toContain('When a client email arrives, draft a concise reply');
    const context = JSON.parse(chat.getAttribute('data-context') ?? '{}') as {
      harness?: string;
      sources?: Array<{ id: string; kind: string; status: string }>;
      contract?: { autoArm?: boolean; operatorReviewsAndArmsDirectly?: boolean };
    };
    expect(context).toMatchObject({
      harness: 'papercusp',
      sources: [{ id: 'source-slack', kind: 'slack', status: 'connected' }],
      contract: { autoArm: false, operatorReviewsAndArmsDirectly: true },
    });
    expect(H.runTool).not.toHaveBeenCalled();
  });

  it('suggests only what a connected source could actually wire', async () => {
    renderTab();
    const chips = await screen.findByTestId('workflows-chips');
    expect(within(chips).getByText('When someone mentions me in Slack…')).toBeTruthy();
  });

  it('creates and arms a schedule in place instead of redirecting to Plans', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    expect(within(dialog).getByRole('button', { name: /Schedule/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Use an existing plan' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));
    await waitFor(() => {
      expect(H.runTool).toHaveBeenCalledWith('plans:set-schedule', expect.objectContaining({
        slug: 'customer-digest',
        harness: 'papercusp',
        schedule: expect.objectContaining({ kind: 'cron', cron: '*/15 * * * *' }),
      }));
      expect(H.runTool).toHaveBeenCalledWith('plans:arm-schedule', { slug: 'customer-digest', harness: 'papercusp' });
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
    expect(within(dialog).getByText('Armed')).toBeTruthy();
  });

  it('creates a plan inline, attaches an external binding, and explicitly arms it', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    fireEvent.click(within(dialog).getByRole('button', { name: /External event/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the plan here' }));
    fireEvent.change(within(dialog).getByLabelText('Workflow name'), { target: { value: 'Summarize support escalations' } });
    fireEvent.change(within(dialog).getByLabelText('What should the plan produce?'), { target: { value: 'Publish a prioritized escalation brief' } });
    fireEvent.change(within(dialog).getByLabelText('Event pattern'), { target: { value: 'ext:slack:mention' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    await waitFor(() => {
      expect(H.runTool).toHaveBeenCalledWith('plans:new', expect.objectContaining({
        harness: 'papercusp',
        title: 'Summarize support escalations',
        status: 'ready',
        content: expect.stringContaining('- **P-001** `todo` Publish a prioritized escalation brief importance: normal'),
      }));
      const patchBodies = vi.mocked(fetch).mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)) as { op: string; eventPattern?: string; armed?: boolean });
      expect(patchBodies).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'attach-external', eventPattern: 'ext:slack:mention' }),
        expect.objectContaining({ op: 'set-armed', armed: true }),
      ]));
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
  });

  it('reports a saved-but-unarmed schedule and retries only the arm step', async () => {
    H.runTool
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: 'Set required plan inputs first' })
      .mockResolvedValueOnce({ ok: true });
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Schedule saved for Customer feedback digest, but it is not armed.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry arming' }));
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
    expect(H.runTool.mock.calls.map(([name]) => name)).toEqual([
      'plans:set-schedule',
      'plans:arm-schedule',
      'plans:arm-schedule',
    ]);
  });
});
