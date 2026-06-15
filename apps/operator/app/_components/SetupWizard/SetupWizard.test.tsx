// @vitest-environment jsdom
/**
 * SetupWizard footer — the finish/skip affordance.
 *
 * The first-run wizard is reached via a HARD redirect (`/` → `/setup` until
 * `finished_at` is set, app/page.tsx), so the footer must never be a dead end:
 *   - minimum met  → a primary Finish button;
 *   - minimum NOT met → a "Skip for now" escape that still finishes the
 *     wizard (never just an actionless hint), so a fresh machine with no
 *     coding agent — or an older build that still gated sign-in — isn't trapped.
 *
 * Seams: nuqs (useQueryState), router-compat (useRouter), useWizardStatuses,
 * and the child Step components are module-mocked so the footer renders alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  statuses: {} as Record<string, string>,
  stepId: 'telemetry' as string | null,
  push: vi.fn(),
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [h.stepId, vi.fn()] as const,
}));
vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: h.push }),
}));
vi.mock('./useWizardStatuses', () => ({
  useWizardStatuses: () => ({
    statuses: h.statuses,
    persisted: {},
    refreshAll: vi.fn(),
    setLastVisitedStep: vi.fn(),
  }),
}));
// Stub the step bodies — the footer renders regardless of the active step.
vi.mock('./StepAgents', () => ({ StepAgents: () => null }));
vi.mock('./StepAutoUpdate', () => ({ StepAutoUpdate: () => null }));
vi.mock('./StepBackups', () => ({ StepBackups: () => null }));
vi.mock('./StepEmbeddedPg', () => ({ StepEmbeddedPg: () => null }));
vi.mock('./StepGit', () => ({ StepGit: () => null }));
vi.mock('./StepKeys', () => ({ StepKeys: () => null }));
vi.mock('./StepLogins', () => ({ StepLogins: () => null }));
vi.mock('./StepMobilePairing', () => ({ StepMobilePairing: () => null }));
vi.mock('./StepOsPermissions', () => ({ StepOsPermissions: () => null }));
vi.mock('./StepPlaceholder', () => ({ StepPlaceholder: () => null }));
vi.mock('./StepTelemetry', () => ({ StepTelemetry: () => null }));
vi.mock('./StepWelcome', () => ({ StepWelcome: () => null }));
vi.mock('./StepWorkspace', () => ({ StepWorkspace: () => null }));

import { SetupWizard } from './SetupWizard';

beforeEach(() => {
  h.statuses = {};
  h.stepId = 'telemetry';
  h.push.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ projects: [] }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetupWizard finish/skip footer', () => {
  it('offers a Skip escape (not a dead-end hint) when the minimum is not met', () => {
    h.statuses = { 'embedded-pg': 'ok', agents: 'needs-attention' };
    render(<SetupWizard mode="settings" />);
    expect(
      screen.getByRole('button', { name: /mark complete anyway/i }),
    ).toBeTruthy();
  });

  it('shows the primary finish (and no skip) when the minimum is met', () => {
    h.statuses = { 'embedded-pg': 'ok', agents: 'ok' };
    render(<SetupWizard mode="settings" />);
    expect(
      screen.getByRole('button', { name: /mark setup complete/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /anyway/i }),
    ).toBeNull();
  });

  it('the Skip escape finishes the wizard (PATCH finished_at)', () => {
    h.statuses = { 'embedded-pg': 'ok', agents: 'needs-attention' };
    render(<SetupWizard mode="settings" />);
    fireEvent.click(
      screen.getByRole('button', { name: /mark complete anyway/i }),
    );
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const patched = calls.some(
      (c) =>
        String(c[0]).includes('/api/desktop/setup-wizard-state') &&
        (c[1] as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(patched).toBe(true);
  });
});
