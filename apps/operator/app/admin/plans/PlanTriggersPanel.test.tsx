// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const askConfirm = vi.fn(async () => true);
const fetchSnapshot = vi.fn();
const patchAdmin = vi.fn(async () => ({ ok: true }));
const authorSchedule = vi.fn(async () => ({ ok: true }));
const armSchedule = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
const disarmSchedule = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
const setInputSchema = vi.fn(async () => ({ ok: true }));
const clearTemplate = vi.fn(async () => ({ ok: true }));
const start = vi.fn(async () => ({ slug: 'triage-mail', harnessSlug: 'papercusp', status: null }));

vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: askConfirm, element: null }),
}));
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../triggers/trigger-admin-api', () => ({
  fetchTriggerAdminSnapshot: (...args: unknown[]) => fetchSnapshot(...args),
  patchTriggerAdmin: (...args: unknown[]) => patchAdmin(...args),
}));
vi.mock('./plans-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plans-api')>()),
  authorPlanSchedule: (...args: unknown[]) => authorSchedule(...args),
  armPlanSchedule: (...args: unknown[]) => armSchedule(...args),
  disarmPlanSchedule: (...args: unknown[]) => disarmSchedule(...args),
  setPlanInputSchema: (...args: unknown[]) => setInputSchema(...args),
  clearPlanTemplateTrigger: (...args: unknown[]) => clearTemplate(...args),
  startPlan: (...args: unknown[]) => start(...args),
}));
vi.mock('./PlanInputsPanel', () => ({
  default: ({ onReadinessChange }: { onReadinessChange?: (ready: boolean) => void }) => {
    useEffect(() => {
      onReadinessChange?.(true);
      return () => onReadinessChange?.(false);
    }, [onReadinessChange]);
    return <div data-testid="manual-inputs">Declared inputs</div>;
  },
}));

import PlanTriggersPanel from './PlanTriggersPanel';

const SOURCE_ID = '20000000-0000-4000-8000-000000000001';
const BINDING_ID = '10000000-0000-4000-8000-000000000001';
const payload = {
  enabled: true,
  counts: { sources: 1, bindings: 1, armed: 0, recentFailures: 0 },
  sources: [{
    id: SOURCE_ID,
    kind: 'gmail',
    status: 'connected',
    config: {},
    credentialRef: 'opaque',
    cursor: {},
    lastConnectedAt: null,
    lastError: null,
    bindingCount: 1,
    armedBindingCount: 0,
    failedDeliveries24h: 0,
  }],
  bindings: [{
    id: BINDING_ID,
    sourceId: SOURCE_ID,
    sourceKind: 'gmail',
    sourceStatus: 'connected',
    planHarnessSlug: 'papercusp',
    planSlug: 'triage-mail',
    eventPattern: 'ext:gmail:message.received',
    eventFilter: { label: 'support' },
    action: { type: 'launch-plan' },
    armed: false,
    stormPolicy: { maxRuns: 2, windowSeconds: 60 },
    createdBy: 'owner',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    lastRun: { id: 'r1', status: 'succeeded', triggeredAt: '2026-08-22T12:00:00.000Z', completedAt: null, error: null },
  }],
  recentRuns: [],
  plan: {
    harnessSlug: 'papercusp',
    planSlug: 'triage-mail',
    schedule: { kind: 'cron', cron: '0 9 * * 1-5', concurrency: 'skip', catchup: 'skip-old' },
    scheduleActive: false,
    scheduledAt: null,
    expiresAt: null,
    tzid: 'America/New_York',
    lastFire: '2026-08-22T12:00:00.000Z',
    nextFire: '2026-08-23T13:00:00.000Z',
    manualSource: 'input-schema',
  },
};

beforeEach(() => {
  fetchSnapshot.mockResolvedValue(payload);
  askConfirm.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlanTriggersPanel', () => {
  it('renders the unified schedule, external-event, and manual sources', async () => {
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    expect(await screen.findByText('cron · 0 9 * * 1-5')).toBeTruthy();
    expect(screen.getByText('ext:gmail:message.received')).toBeTruthy();
    expect(screen.getByText('Start with declared inputs')).toBeTruthy();
    expect(screen.getByText(/next fire:/)).toBeTruthy();
    expect(screen.getByText(/storm:/)).toBeTruthy();
  });

  it('keeps installed separate from armed and confirms schedule arming', async () => {
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    const toggle = await screen.findByRole('switch', { name: 'Arm schedule' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Arm schedule?' }));
      expect(armSchedule).toHaveBeenCalledWith('triage-mail', 'papercusp');
    });
  });

  it('soft-detaches an external binding with explicit confirmation', async () => {
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    const buttons = await screen.findAllByRole('button', { name: 'Detach' });
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(patchAdmin).toHaveBeenCalledWith({
      op: 'detach-external', id: BINDING_ID, confirm: true,
    }));
  });

  it('authors a schedule off through the existing set-schedule surface', async () => {
    fetchSnapshot.mockResolvedValue({
      ...payload,
      plan: { ...payload.plan, schedule: null, scheduledAt: null, scheduleActive: false },
    });
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach schedule' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(authorSchedule).toHaveBeenCalledWith(
      'triage-mail',
      expect.objectContaining({
        schedule: expect.objectContaining({ kind: 'cron', cron: '0 9 * * 1-5' }),
        scheduledAt: null,
      }),
      'papercusp',
    ));
  });

  it('uses shared select controls in trigger composers', async () => {
    fetchSnapshot.mockResolvedValue({
      ...payload,
      plan: { ...payload.plan, schedule: null, scheduledAt: null, scheduleActive: false },
    });
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach schedule' });
    // Radix keeps hidden form-sync selects for native form submission; the user-facing
    // controls must still be its accessible combobox triggers, not visible native selects.
    expect(dialog.querySelectorAll('select:not([aria-hidden="true"])')).toHaveLength(0);
    expect(within(dialog).getByRole('combobox', { name: 'Kind' })).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Overlap policy' })).toBeTruthy();
  });

  it('attaches an external event to the selected existing source', async () => {
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach event' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach external event' });
    fireEvent.change(within(dialog).getByLabelText('Event pattern'), {
      target: { value: 'ext:gmail:message.received' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach off' }));
    await waitFor(() => expect(patchAdmin).toHaveBeenCalledWith(expect.objectContaining({
      op: 'attach-external',
      sourceId: SOURCE_ID,
      planSlug: 'triage-mail',
      eventPattern: 'ext:gmail:message.received',
    })));
  });

  it('attaches and detaches the manual input-schema trigger', async () => {
    fetchSnapshot.mockResolvedValue({
      ...payload,
      plan: { ...payload.plan, manualSource: null },
    });
    const view = render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Attach manual' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach manual trigger' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach manual' }));
    await waitFor(() => expect(setInputSchema).toHaveBeenCalledWith(
      'triage-mail',
      expect.objectContaining({ type: 'object', properties: {} }),
      'papercusp',
    ));

    fetchSnapshot.mockResolvedValue(payload);
    view.unmount();
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    const detachButtons = await screen.findAllByRole('button', { name: 'Detach' });
    fireEvent.click(detachButtons[2]!);
    await waitFor(() => expect(setInputSchema).toHaveBeenCalledWith('triage-mail', null, 'papercusp'));
  });

  it('renders declared inputs in the manual-start dialog and uses the existing start gate', async () => {
    render(<PlanTriggersPanel slug="triage-mail" harnessSlug="papercusp" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start manually' }));
    expect(await screen.findByTestId('manual-inputs')).toBeTruthy();
    const startButton = screen.getByRole('button', { name: 'Start plan' });
    await waitFor(() => expect((startButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton);
    await waitFor(() => expect(start).toHaveBeenCalledWith('triage-mail', 'papercusp'));
  });
});
