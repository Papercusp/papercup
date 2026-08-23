// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import type { AutomationCatalog, AutomationRoutine } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';

const H = vi.hoisted(() => ({
  runTool: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>>(
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
  sources: [{ id: 'source-slack', kind: 'slack', status: 'connected', config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0 }],
  bindings: [{ id: '11111111-1111-4111-8111-111111111111', sourceId: 'source-slack', sourceKind: 'slack', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', eventPattern: 'ext:slack:message', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: { id: 'run-1', status: 'done', triggeredAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', error: null } }],
  recentRuns: [{
    id: 'run-1', bindingId: '11111111-1111-4111-8111-111111111111', sourceKind: 'slack', eventPattern: 'ext:slack:message', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', status: 'done', attempts: 1,
    dedupeKey: 'slack:run-1', triggeredAt: '2026-08-22T19:00:00.000Z', startedAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', planRunRef: 'run:1', error: null,
    causeSummary: 'Slack message matched', policyDisposition: 'ran', policyDetail: 'ran', eventFilter: {}, stormPolicy: {}, redactedPayload: {}, outcomeLinks: [], timeline: [], planRun: null,
  }],
};

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args }: { queryName: string; args: unknown }) => {
    H.queries.push({ queryName, args });
    const invalidate = vi.fn(() => H.invalidates.push(queryName));
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
vi.mock('./ScheduleEditor', () => ({ runScheduleTool: H.runTool }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdvAutomationsTab from './AdvAutomationsTab';

function renderTab() {
  return render(<NuqsTestingAdapter><AdvAutomationsTab /></NuqsTestingAdapter>);
}

beforeEach(() => {
  H.runTool.mockReset();
  H.runTool.mockResolvedValue({ ok: true });
  H.invalidates.length = 0;
  H.queries.length = 0;
  H.emptyData = false;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

describe('<AdvAutomationsTab>', () => {
  it('lands on the causal trigger-flow view and keeps non-triggered routines in Catalog', async () => {
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Automations' })).toBeTruthy();
    expect(H.queries.some(({ queryName, args }) => queryName === 'plans.list' && JSON.stringify(args) === '{}')).toBe(true);
    expect(H.queries.some(({ queryName }) => queryName === 'harnessProjects.lite')).toBe(false);
    expect(screen.getAllByText('Outcome / next').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Trigger flows')).toBeTruthy();
    const flowToolbar = screen.getByRole('group', { name: 'Filter trigger flows' }).parentElement;
    expect(flowToolbar?.firstElementChild).toBe(screen.getByLabelText('Search trigger flows').closest('label'));
    const planRow = screen.getByRole('button', { name: /Schedule \+ Slack starts Customer feedback digest/ });
    expect(planRow).toBeTruthy();
    expect(within(planRow).getByText('2 installed triggers')).toBeTruthy();
    expect(screen.queryByText('Rubric ratification')).toBeNull();
    fireEvent.click(planRow);
    const details = screen.getByLabelText('Automation details');
    expect(within(details).getByText('Flow inspector')).toBeTruthy();
    expect(within(details).getByText('Causal path')).toBeTruthy();
    expect(within(details).getAllByText('Turns feedback into a prioritized brief').length).toBeGreaterThanOrEqual(2);
    expect(within(details).getByText('schedule')).toBeTruthy();
    expect(within(details).getByText('slack')).toBeTruthy();
    const triggers = within(details).getByText('Automatic triggers').closest('section');
    expect(triggers).toBeTruthy();
    expect(within(triggers as HTMLElement).queryByText('manual')).toBeNull();
    expect(within(details).getByRole('button', { name: 'Run manually' })).toBeTruthy();
    await waitFor(() => expect(within(details).getByText(/2 required · ready/)).toBeTruthy());
    expect(within(details).getByText('$0.62 · 1 runs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Catalog/ }));
    expect(screen.getAllByText('git-sync').length).toBeGreaterThan(0);
  });

  it('renders truthful empty states instead of synthesizing automations when every producer is empty', async () => {
    H.emptyData = true;
    renderTab();
    expect(await screen.findByRole('heading', { name: 'Automations' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Flows/ }).textContent).toContain('0');
    expect(screen.getByText(/No triggered plans match this view/)).toBeTruthy();
    expect(screen.queryByText('Customer feedback digest')).toBeNull();
    expect(screen.queryByText('git-sync')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Catalog/ }));
    expect(screen.getByText('No automations match this filter.')).toBeTruthy();
  });

  it('fires Run manually through plans:run-now and keeps role spend inside Activity', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Customer feedback digest/ }));
    fireEvent.click(screen.getByRole('button', { name: /Run manually/ }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('plans:run-now', { slug: 'customer-digest', harness: 'papercusp' }));
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    expect(await screen.findByText('Workspace spend · 7 days')).toBeTruthy();
    expect(screen.getByText('doc-steward')).toBeTruthy();
    expect(screen.getByText('$2.40')).toBeTruthy();
  });

  it('toggles an external binding through the audited trigger admin route', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Customer feedback digest/ }));
    const details = await screen.findByLabelText('Automation details');
    const armed = within(details).getAllByRole('button', { name: 'Armed' });
    fireEvent.click(armed[1]);
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init.body).includes('11111111-1111-4111-8111-111111111111'))).toBe(true);
    });
  });

  it('creates and arms a schedule in place instead of redirecting to Plans', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an automation' });
    expect(within(dialog).getByRole('button', { name: /Schedule/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Use an existing plan' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm automation' }));
    await waitFor(() => {
      expect(H.runTool).toHaveBeenCalledWith('plans:set-schedule', expect.objectContaining({
        slug: 'customer-digest',
        harness: 'papercusp',
        schedule: expect.objectContaining({ kind: 'cron', cron: '*/15 * * * *' }),
      }));
      expect(H.runTool).toHaveBeenCalledWith('plans:arm-schedule', { slug: 'customer-digest', harness: 'papercusp' });
    });
    expect(await within(dialog).findByText('Automation armed')).toBeTruthy();
    expect(within(dialog).getByText('Armed')).toBeTruthy();
  });

  it('creates a plan inline, attaches an external binding, and explicitly arms it', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an automation' });
    fireEvent.click(within(dialog).getByRole('button', { name: /External event/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the plan here' }));
    fireEvent.change(within(dialog).getByLabelText('Automation name'), { target: { value: 'Summarize support escalations' } });
    fireEvent.change(within(dialog).getByLabelText('What should the plan produce?'), { target: { value: 'Publish a prioritized escalation brief' } });
    fireEvent.change(within(dialog).getByLabelText('Event pattern'), { target: { value: 'ext:slack:mention' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm automation' }));

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
    expect(await within(dialog).findByText('Automation armed')).toBeTruthy();
  });

  it('reports a saved-but-unarmed schedule and retries only the arm step', async () => {
    H.runTool
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: 'Set required plan inputs first' })
      .mockResolvedValueOnce({ ok: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    const dialog = screen.getByRole('dialog', { name: 'Create an automation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm automation' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Schedule saved for Customer feedback digest, but it is not armed.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry arming' }));
    expect(await within(dialog).findByText('Automation armed')).toBeTruthy();
    expect(H.runTool.mock.calls.map(([name]) => name)).toEqual([
      'plans:set-schedule',
      'plans:arm-schedule',
      'plans:arm-schedule',
    ]);
  });
});
