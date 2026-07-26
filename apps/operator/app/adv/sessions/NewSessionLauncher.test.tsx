// @vitest-environment jsdom
/**
 * NewSessionLauncher — the "+ New session" control lifted out of
 * AdvSessionsClient (hud-consolidation-2026-07-26 P-001) so the HUD board
 * header can reuse the same launch-from-plan-context path.
 *
 * Seams: Select/useLexicon/plans-api/launch-agent/sonner stubbed — same
 * pattern as PlanActions.test.tsx and AgentLauncherButton.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  planListData: { plans: [] as Array<Record<string, unknown>>, loading: false },
  launchAgent: vi.fn(async (_opts: unknown) => ({ ok: true as const })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (opts: unknown) => h.launchAgent(opts),
}));
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => ({ data: { plans: h.planListData.plans }, loading: h.planListData.loading }),
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

import NewSessionLauncher, { PLAN_SELECT_PLACEHOLDER } from './NewSessionLauncher';

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
});
afterEach(() => cleanup());

describe('NewSessionLauncher', () => {
  it('renders a plan picker, a model picker, and a disabled launch button by default', () => {
    render(<NewSessionLauncher />);
    expect(screen.getByRole('combobox', { name: 'Plan for new session' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model for new session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ New session' })).toBeDisabled();
  });

  it('enables the button once a plan is chosen, and launches with the selected plan', async () => {
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'beta-plan' },
    });
    const btn = screen.getByRole('button', { name: '+ New session' });
    expect(btn).not.toBeDisabled();
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
    render(<NewSessionLauncher />);
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

  it('toasts an error and does not call onLaunched when launchAgent fails', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('boom');
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it('the plan picker default value is the placeholder sentinel with no selection', () => {
    render(<NewSessionLauncher />);
    const select = screen.getByRole('combobox', {
      name: 'Plan for new session',
    }) as HTMLSelectElement;
    expect(select.value).toBe(PLAN_SELECT_PLACEHOLDER);
  });
});
