// @vitest-environment jsdom
/**
 * PlanActions.test.tsx — the plan read-mode action strip + its pure helpers.
 * Thoroughly covers previewNextDecisionId / previewNextItemId / writeError /
 * parseRefList, then the component: the bucket-gated button set (draft → Approve,
 * ready → Start + Demote, running → Pause), the approve success/rollback paths,
 * start, launch-agent, and the Set-Now dialog open + submit.
 *
 * Seams: Tooltip/Modal/Select/useLexicon stubbed, launchAgent + every plans-api
 * write fn mocked (bucketOf given a small real impl so buckets are controllable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/app/harness/Modal', () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-testid="modal">{children}</div> : null) }));
vi.mock('@/app/harness/Select', () => ({ Select: ({ value, onChange, options, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel?: string; options: { value: string; label: string }[] }) => (
  <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
) }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

const launchAgentMock = vi.fn(async () => ({ ok: true }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({ launchAgent: (a: unknown) => launchAgentMock(a as never) }));

const approveMock = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string });
const demoteMock = vi.fn(async () => ({ ok: true }));
const startMock = vi.fn(async () => ({}));
const pauseMock = vi.fn(async () => ({}));
const setNowMock = vi.fn(async () => ({ ok: true }));
// `writeError` is spread in REAL from the module (WI-6941) — the describe block below
// tests it directly, and a hand-stubbed copy would pass while the shipped reader
// reported failed bulk writes as successes. Everything listed after the spread is
// still explicitly overridden.
vi.mock('./plans-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plans-api')>()),
  bucketOf: ({ status, startStatus }: { status: string; startStatus: string | null }) => {
    if (status === 'shipped') return 'shipped';
    if (status === 'rejected' || status === 'superseded') return 'rejected';
    if (startStatus === 'started') return 'running';
    if (status === 'ready') return 'ready';
    return 'draft';
  },
  approvePlan: (s: string) => approveMock(s as never),
  demotePlanToDraft: (s: string) => demoteMock(s as never),
  rejectDraftPlan: vi.fn(async () => ({ ok: true })),
  setPlanNow: (a: unknown) => setNowMock(a as never),
  addPlanDecision: vi.fn(async () => ({ ok: true })),
  addPlanItem: vi.fn(async () => ({ ok: true })),
  promoteToHarness: vi.fn(async () => ({ ok: true, features_created: 1 })),
  startPlan: (s: string) => startMock(s as never),
  pausePlan: (s: string) => pauseMock(s as never),
  // P-013: the real predicate, not a stub — the whole point of the refusal branch
  // is that it discriminates on the wire shape, so a stub would test nothing.
  isPlanStartRefusal: (r: unknown) =>
    !!r && typeof r === 'object' && (r as { error?: unknown }).error === 'plan_inputs_not_ready',
  IMPORTANCE_LEVELS: ['urgent', 'high', 'normal', 'low'],
}));

/**
 * P-047 (retire-mug-kettle-su-only-2026-08-09): the Start half of the Start/Pause
 * button is gated on FLAGS.MUG_KETTLE_SYSTEM, whose default is OFF — so the
 * unmocked useFlag fallback (FLAG_DEFAULTS) would hide Start and red every
 * assertion below with a signature naming neither the flag nor the gate. Pin the
 * tier ON for the pre-retirement contract; the retired shape has its own block at
 * the foot of this file.
 */
const F = vi.hoisted(() => ({ mugKettleOn: true }));
vi.mock('@/lib/flag-hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flag-hooks')>()),
  useFlag: (key: string) => (key === 'papercusp-mug-kettle-system' ? F.mugKettleOn : true),
}));

import PlanActions, { previewNextDecisionId, previewNextItemId, writeError, parseRefList } from './PlanActions';

describe('previewNextDecisionId / previewNextItemId', () => {
  it('returns the padded next id, defaulting to 001', () => {
    expect(previewNextDecisionId(undefined)).toBe('D-001');
    expect(previewNextDecisionId([])).toBe('D-001');
    expect(previewNextDecisionId([{ id: 'D-001' }, { id: 'D-005' }] as never)).toBe('D-006');
    expect(previewNextItemId([{ id: 'P-003' }, { id: 'P-010' }] as never)).toBe('P-011');
    expect(previewNextItemId(undefined)).toBe('P-001');
  });
});

describe('writeError', () => {
  it('returns null on ok, the holder on busy, the code otherwise', () => {
    expect(writeError({ ok: true } as never)).toBeNull();
    expect(writeError({ error: 'busy', busy: [{ owner_label: 'shellX', intent: 'editing' }] } as never)).toBe('busy: held by shellX (editing)');
    expect(writeError({ error: 'busy', busy: [{}] } as never)).toBe('busy: held by another agent');
    expect(writeError({ error: 'nope' } as never)).toBe('nope');
    expect(writeError(null as never)).toBe('unexpected response shape');
    expect(writeError({} as never)).toBe('unexpected response shape');
  });
});

describe('parseRefList', () => {
  it('keeps only well-formed P-/D- ids', () => {
    expect(parseRefList('P-001, P-007')).toEqual(['P-001', 'P-007']);
    expect(parseRefList('P-1 garbage D-012')).toEqual(['D-012']);
    expect(parseRefList('')).toEqual([]);
    expect(parseRefList('P-001  D-002,P-003')).toEqual(['P-001', 'D-002', 'P-003']);
  });
});

describe('PlanActions component', () => {
  function renderActions(over: { items?: unknown[]; planStatus?: string; startStatus?: string | null } = {}) {
    const cb = { onChanged: vi.fn(), onOptimisticStatus: vi.fn(), onStartStatusChange: vi.fn(), onPlanStatusChange: vi.fn(), onStartRefused: vi.fn() };
    render(
      <PlanActions
        slug="proj" items={(over.items ?? []) as never} decisions={[]} currentNow={null}
        planStatus={(over.planStatus ?? 'draft') as never} startStatus={(over.startStatus ?? null) as never}
        {...cb}
      />,
    );
    return cb;
  }
  beforeEach(() => { vi.clearAllMocks(); approveMock.mockResolvedValue({ ok: true }); F.mugKettleOn = true; });
  afterEach(cleanup);

  it('shows Approve for a draft (no Start)', () => {
    renderActions({ planStatus: 'draft' });
    expect(screen.getByRole('button', { name: /Approve Plan/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start Plan/ })).toBeNull();
  });

  it('shows Start + Demote for a ready plan', () => {
    renderActions({ planStatus: 'ready' });
    expect(screen.getByRole('button', { name: /Start Plan/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Demote to Draft/ })).toBeTruthy();
  });

  it('shows Pause for a started plan', () => {
    renderActions({ planStatus: 'ready', startStatus: 'started' });
    expect(screen.getByRole('button', { name: /Pause Plan/ })).toBeTruthy();
  });

  // ── P-047: the retired OPERATIONAL axis ──────────────────────────────────
  // op_status does not ENABLE anything for su — it RESERVES the plan's items
  // from scheduler self-selection for a dispatcher that no longer runs (D-010),
  // so a press of Start here strands that plan's lane silently. Start goes;
  // PAUSE STAYS, because the DBOS frontier still reads op_status='started' and
  // is not gated, making pause the only remaining off switch for a plan started
  // before this landed. Deleting the asymmetry is the tempting "cleanup" — it
  // would leave those plans dispatchable forever.
  it('retired tier: no Start button for a ready plan', () => {
    F.mugKettleOn = false;
    renderActions({ planStatus: 'ready' });
    expect(screen.queryByRole('button', { name: /Start Plan/ })).toBeNull();
    // The rest of the action bar is untouched — this gate is about one axis,
    // not about disabling plan management.
    expect(screen.getByRole('button', { name: /Demote to Draft/ })).toBeTruthy();
  });

  it('retired tier: KEEPS Pause for an already-started plan', () => {
    F.mugKettleOn = false;
    renderActions({ planStatus: 'ready', startStatus: 'started' });
    expect(screen.getByRole('button', { name: /Pause Plan/ })).toBeTruthy();
  });

  it('approves optimistically and toasts on success', async () => {
    const cb = renderActions({ planStatus: 'draft' });
    fireEvent.click(screen.getByRole('button', { name: /Approve Plan/ }));
    expect(cb.onOptimisticStatus).toHaveBeenCalledWith('ready');
    await waitFor(() => expect(approveMock).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('rolls the status back on a failed approve', async () => {
    approveMock.mockResolvedValue({ ok: false, error: 'denied' });
    const cb = renderActions({ planStatus: 'draft' });
    fireEvent.click(screen.getByRole('button', { name: /Approve Plan/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(cb.onOptimisticStatus).toHaveBeenLastCalledWith('draft');
  });

  it('starts a ready plan', async () => {
    const cb = renderActions({ planStatus: 'ready' });
    fireEvent.click(screen.getByRole('button', { name: /Start Plan/ }));
    await waitFor(() => expect(startMock).toHaveBeenCalled());
    expect(cb.onStartStatusChange).toHaveBeenCalledWith('started');
  });

  // plan-structured-inputs-2026-08-01 P-013. The start gate refuses with a 200 body
  // carrying { error: 'plan_inputs_not_ready' }, NOT an HTTP error — so before this
  // branch existed the UI reported "Plan started" and flipped to Pause for a plan
  // that never started. These two pin the halves of that fix.
  it('surfaces a refused start and does NOT report it as started', async () => {
    startMock.mockResolvedValueOnce({
      ok: false,
      error: 'plan_inputs_not_ready',
      code: 'missing_required',
      slug: 'proj',
      missing: ['harness', 'paths'],
      issues: [],
      source: 'input-schema',
      hint: 'Required inputs not supplied: harness, paths.',
    } as never);
    const cb = renderActions({ planStatus: 'ready' });
    fireEvent.click(screen.getByRole('button', { name: /Start Plan/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The missing field NAMES are what the human can act on, so they must appear.
    expect(String(toastError.mock.calls[0]?.[0])).toContain('harness, paths');
    expect(cb.onStartStatusChange).not.toHaveBeenCalled();
    expect(cb.onStartRefused).toHaveBeenCalled();
  });

  it('falls back to the refusal hint when nothing is merely missing', async () => {
    startMock.mockResolvedValueOnce({
      ok: false,
      error: 'plan_inputs_not_ready',
      code: 'bad_schema',
      slug: 'proj',
      missing: [],
      issues: [],
      source: 'input-schema',
      hint: 'This plan\'s input_schema is not compilable.',
    } as never);
    const cb = renderActions({ planStatus: 'ready' });
    fireEvent.click(screen.getByRole('button', { name: /Start Plan/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain('not compilable');
    expect(cb.onStartStatusChange).not.toHaveBeenCalled();
  });

  it('launches a workbench agent', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Launch agent' }));
    await waitFor(() => expect(launchAgentMock).toHaveBeenCalled());
    expect(launchAgentMock).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'proj', deferSpawn: true }));
  });

  it('opens the Set-Now dialog and submits it', async () => {
    const cb = renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Set Now' }));
    fireEvent.change(screen.getByPlaceholderText(/where the plan currently stands/i), { target: { value: 'state text' } });
    fireEvent.change(screen.getByPlaceholderText(/next concrete action/i), { target: { value: 'next text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace Now' }));
    await waitFor(() => expect(setNowMock).toHaveBeenCalled());
    expect(setNowMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'proj', state: 'state text', next: 'next text' }));
    await waitFor(() => expect(cb.onChanged).toHaveBeenCalled());
  });
});
