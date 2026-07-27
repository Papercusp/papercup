// @vitest-environment jsdom
/**
 * NewSessionLauncher — the "+ New session" control lifted out of
 * AdvSessionsClient (hud-consolidation-2026-07-26 P-001) so the HUD board
 * header can reuse the same launch-from-plan-context path.
 *
 * Seams: Select/useLexicon/plans-api/launch-agent/sonner stubbed — same
 * pattern as PlanActions.test.tsx and AgentLauncherButton.test.tsx.
 * Uses @testing-library/react + vitest only (no jest-dom matchers) — see
 * those files' identical note; jest-dom's Chai plugin isn't registered in
 * this workspace's vitest setup, so `.toBeDisabled()` throws
 * "Invalid Chai property" rather than failing the assertion (WI-5963).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

/** Mirrors the useful part of launchAgent's result union. Declared explicitly
 *  because inferring it from the default implementation narrows to
 *  `{ ok: true }`, which then rejects every mockResolvedValueOnce for the
 *  warning and failure paths below. */
type LaunchResult = { ok: boolean; warning?: string; error?: string; installCmd?: string };

const h = vi.hoisted(() => ({
  planListData: { plans: [] as Array<Record<string, unknown>>, loading: false },
  launchAgent: vi.fn(async (_opts: unknown): Promise<LaunchResult> => ({ ok: true })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: h.toastSuccess, error: h.toastError, warning: h.toastWarning },
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (opts: unknown) => h.launchAgent(opts),
}));
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => ({ data: { plans: h.planListData.plans }, loading: h.planListData.loading }),
}));
// The pickers became searchable Comboboxes under
// `hud-session-launcher-and-board-tabs-2026-07-26` P-003. Stubbed to a native
// <select> (which also reports role="combobox") so these tests keep exercising
// LAUNCHER logic — which plan/model/effort reaches launchAgent — rather than
// re-testing the combobox. The combobox's own behaviour (full list on focus,
// filter as you type, scroll container, detail rows) is covered for real in
// app/harness/__tests__/Combobox.test.tsx.
vi.mock('@/app/harness/Combobox', () => ({
  Combobox: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel?: string;
    disabled?: boolean;
    options: Array<
      | { value: string; label: string }
      | { kind: 'group'; label: string; options: { value: string; label: string }[] }
    >;
  }) => {
    const flat = options.flatMap((o) => ('kind' in o ? o.options : [o]));
    return (
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {flat.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
}));

import NewSessionLauncher, {
  composeModelSpec,
  PLAN_SELECT_PLACEHOLDER,
  OMP_MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_SELECT_DEFAULT,
  EFFORT_SELECT_DEFAULT,
} from './NewSessionLauncher';
import {
  CLOUD_MODEL_MENU,
  MODEL_EFFORT_LEVELS,
} from '@papercusp/operator-core/lib/agent-config-constants';

function plan(slug: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    slug,
    title: `Title for ${slug}`,
    status: 'active',
    updated: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'papercusp',
    ...over,
  };
}

beforeEach(() => {
  h.planListData = { plans: [plan('alpha-plan'), plan('beta-plan')], loading: false };
  h.launchAgent.mockReset().mockResolvedValue({ ok: true });
  h.toastSuccess.mockReset();
  h.toastError.mockReset();
  h.toastWarning.mockReset();
});
afterEach(() => cleanup());

// WI-6300 (owner ask 2026-07-27). These lists used to be hand-maintained literals
// that drifted behind psu: 4 of 7 models (no fable/sol/terra/luna) plus a stale
// `gpt-5.2`, and 3 of 5 efforts (no xhigh/max). They are now DERIVED, and the
// cross-file guard that CLOUD_MODEL_MENU / MODEL_EFFORT_LEVELS still match psu's
// own menus lives in apps/operator/lib/psu-launcher.test.ts. What this suite pins
// is the second half of the chain: that the pickers actually render everything
// those constants offer, so a future "tidy-up" can't quietly re-hardcode a subset.
describe('model + effort options are derived from the psu vocabulary (WI-6300)', () => {
  it('offers every psu base model, plus the explicit Default row', () => {
    expect(OMP_MODEL_OPTIONS.map((o) => o.value)).toEqual([
      MODEL_SELECT_DEFAULT,
      ...CLOUD_MODEL_MENU.map((m) => m.value),
    ]);
  });

  it('includes the four models the old hand-written list was missing', () => {
    const values = OMP_MODEL_OPTIONS.map((o) => o.value);
    for (const missing of ['fable', 'sol', 'terra', 'luna']) {
      expect(values, missing).toContain(missing);
    }
  });

  it('no longer offers gpt-5.2 — it is not a psu-recognized alias', () => {
    expect(OMP_MODEL_OPTIONS.map((o) => o.value)).not.toContain('gpt-5.2');
  });

  it('labels each model with the CLI it launches, so a codex pick is not mistaken for claude', () => {
    for (const m of CLOUD_MODEL_MENU) {
      const opt = OMP_MODEL_OPTIONS.find((o) => o.value === m.value);
      expect(opt?.detail, m.value).toBe(m.backend === 'codex' ? 'codex CLI' : 'claude CLI');
    }
  });

  it('offers every psu effort level including xhigh and max, plus the Default row', () => {
    expect(EFFORT_OPTIONS.map((o) => o.value)).toEqual([
      EFFORT_SELECT_DEFAULT,
      ...MODEL_EFFORT_LEVELS,
    ]);
    expect(EFFORT_OPTIONS.map((o) => o.value)).toContain('xhigh');
    expect(EFFORT_OPTIONS.map((o) => o.value)).toContain('max');
  });

  it('every effort row renders a non-empty label — a new psu level falls back to its token, never blank', () => {
    for (const o of EFFORT_OPTIONS) expect(o.label?.trim(), o.value).toBeTruthy();
  });

  it('every offered model×effort pair composes to the spec psu expects', () => {
    for (const m of CLOUD_MODEL_MENU) {
      for (const e of MODEL_EFFORT_LEVELS) {
        expect(composeModelSpec(m.value, e)).toBe(`${m.value}:${e}`);
      }
      // effort left at Default ⇒ bare model, no dangling colon
      expect(composeModelSpec(m.value, '')).toBe(m.value);
    }
  });
});

describe('NewSessionLauncher', () => {
  it('renders a plan picker, a model picker, and an ENABLED launch button by default', () => {
    // P-005 (owner ask 2026-07-26): "You should be able to launch a session
    // with no plan selected." This assertion previously required the button to
    // be DISABLED until a plan was chosen — that was the requirement the owner
    // reversed, so the inverted expectation here is the point of the change.
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    expect(screen.getByRole('combobox', { name: 'Plan for new session' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model for new session' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '+ New session' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('launches with NO plan selected, passing planSlug: null', async () => {
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    // Deliberately choose nothing — the placeholder is still selected.
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith({
      slug: null,
      planSlug: null,
      label: 'su session',
      model: null,
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('enables the button once a plan is chosen, and launches with the selected plan', async () => {
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'beta-plan' },
    });
    const btn = screen.getByRole('button', { name: '+ New session' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith({
      slug: null,
      planSlug: 'beta-plan',
      label: 'Title for beta-plan',
      model: null,
    });
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('threads a non-default model choice through to launchAgent', async () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
      target: { value: 'opus' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'alpha-plan', model: 'opus' }),
    );
  });

  // EI-18696184925888288: launch-su can report ok:true with a `warning` when
  // the spawned terminal process exited almost immediately (a likely silent
  // no-op) — the UI must say so rather than a flat success toast.
  it('toasts a warning (not success) when launchAgent reports ok:true with a warning', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true, warning: 'the spawned terminal process exited almost immediately' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastWarning).toHaveBeenCalledTimes(1));
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    // onLaunched still fires — the session row genuinely may exist; the
    // warning is advisory, not a hard failure.
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('toasts an error and does not call onLaunched when launchAgent fails', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('boom');
    expect(onLaunched).not.toHaveBeenCalled();
  });

  // P-008 (owner ask 2026-07-26): "add another box with search/filter/dropdown
  // behavior … to select the effort level."
  it('renders an effort picker and folds the choice into the model spec', async () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
      target: { value: 'opus' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort level for new session' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus:high' }));
  });

  it('drops a bare effort when no model is chosen (never sends ":high")', async () => {
    // Effort is meaningless without an explicit model — the default model's
    // effort is the backend's to choose, so a lone effort must not synthesise
    // a malformed spec.
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort level for new session' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
  });

  it('composeModelSpec joins model and effort, and degrades cleanly', () => {
    expect(composeModelSpec('sonnet', 'high')).toBe('sonnet:high');
    expect(composeModelSpec('sonnet', '')).toBe('sonnet');
    expect(composeModelSpec('', 'high')).toBe(null);
    expect(composeModelSpec('', '')).toBe(null);
    expect(composeModelSpec('  sonnet  ', '  high  ')).toBe('sonnet:high');
  });

  it('the plan picker default value is the placeholder sentinel with no selection', () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    const select = screen.getByRole('combobox', {
      name: 'Plan for new session',
    }) as HTMLSelectElement;
    expect(select.value).toBe(PLAN_SELECT_PLACEHOLDER);
  });
});
