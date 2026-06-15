// @vitest-environment jsdom
//
// HealthBadge — the per-harness health verdict (assembled from several Zero
// queries). The verdict logic is extracted into the pure `deriveHealth` +
// `healthTone` and tested branch-by-branch; a render-smoke drives mocked
// sync queries to confirm the loading and populated badge surfaces.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

beforeAll(() => {
  // Radix Tooltip uses ResizeObserver, which jsdom lacks.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// One hoisted store keyed by queryName; the badge fires several useSyncQuery
// calls and each reads its slice.
const { results } = vi.hoisted(() => ({
  results: {} as Record<string, { data?: unknown[]; loading?: boolean }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) => {
    const r = results[opts.queryName] ?? {};
    return {
      data: r.data ?? [],
      loading: r.loading ?? false,
      error: null,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
    };
  },
}));

vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'default' }));

// The badge wraps its StatCard in a Radix Tooltip that needs a root
// TooltipProvider the app supplies in production. It's not under test here,
// so render it as a passthrough that exposes the tooltip text via title.
vi.mock('./Tooltip', () => ({
  Tooltip: ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
    <div title={typeof label === 'string' ? label : undefined}>{children}</div>
  ),
}));

// ui-primitives ships a classic-JSX build that expects a React global the
// vitest transform doesn't inject here; StatCard isn't under test, so render
// a minimal stand-in that surfaces the label + value the badge passes.
vi.mock('@papercusp/ui-primitives', () => ({
  StatCard: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  ),
}));

import { HealthBadge, deriveHealth, healthTone } from './HealthBadge';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(results)) delete results[k];
});

const HEALTHY = {
  lanesLoading: false,
  lanes: [{ phase: 'staging' }],
  escalations: [] as { escalation?: string | null }[],
  features: [{ status: 'passed' }, { status: 'passed' }],
  decisions: [{ isGhost: false }, { isGhost: false }],
  checkpoints: [{ granted: true }],
  smoke: [{ status: 'pass' }],
  lastRunMs: 0,
};

describe('deriveHealth', () => {
  it('returns null while the lanes query is still loading', () => {
    expect(deriveHealth({ ...HEALTHY, lanesLoading: true })).toBeNull();
  });

  it('marks all checks ok for a clean harness', () => {
    const d = deriveHealth(HEALTHY)!;
    expect(d.ok).toBe(true);
    expect(d.alive).toBe(true);
    expect(d.escalated).toBe(false);
    expect(d.checks.every((c) => c.ok)).toBe(true);
    expect(d.features).toEqual({ total: 2, passed: 2, failing: 0, inProgress: 0, blocked: 0 });
  });

  it('alive=false when no staging lane row is present', () => {
    expect(deriveHealth({ ...HEALTHY, lanes: [] })!.alive).toBe(false);
  });

  it('flags escalation when the first escalation row carries a non-empty string', () => {
    const d = deriveHealth({ ...HEALTHY, escalations: [{ escalation: 'blocked on X' }] })!;
    expect(d.escalated).toBe(true);
    expect(d.ok).toBe(false);
    const check = d.checks.find((c) => c.name === 'not_escalated')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('see escalation.md');
  });

  it('does not flag escalation for an empty-string escalation column', () => {
    expect(deriveHealth({ ...HEALTHY, escalations: [{ escalation: '' }] })!.escalated).toBe(false);
  });

  it('tallies feature statuses across all buckets', () => {
    const d = deriveHealth({
      ...HEALTHY,
      features: [
        { status: 'passed' },
        { status: 'failing' },
        { status: 'in_progress' },
        { status: 'validating' },
        { status: 'blocked' },
      ],
    })!;
    expect(d.features).toEqual({ total: 5, passed: 1, failing: 1, inProgress: 2, blocked: 1 });
  });

  it('fails features_present when there are no features', () => {
    const d = deriveHealth({ ...HEALTHY, features: [] })!;
    expect(d.checks.find((c) => c.name === 'features_present')!.ok).toBe(false);
  });

  it('counts pending (ungranted) checkpoints and surfaces the detail', () => {
    const d = deriveHealth({
      ...HEALTHY,
      checkpoints: [{ granted: false }, { granted: false }, { granted: true }],
    })!;
    const check = d.checks.find((c) => c.name === 'no_pending_checkpoints')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('2 awaiting grant');
  });

  it('fails smoke_passing when the smoke row status is "fail"', () => {
    const d = deriveHealth({ ...HEALTHY, smoke: [{ status: 'fail' }] })!;
    expect(d.checks.find((c) => c.name === 'smoke_passing')!.ok).toBe(false);
  });

  it('fails parser_clean when ghost rate is >= 5%', () => {
    // 1 ghost of 10 = 10% → over threshold.
    const decisions = [{ isGhost: true }, ...Array(9).fill({ isGhost: false })];
    const d = deriveHealth({ ...HEALTHY, decisions })!;
    expect(d.ghostRate).toBeCloseTo(0.1, 6);
    const check = d.checks.find((c) => c.name === 'parser_clean')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('10.0% ghost decisions');
  });

  it('treats an empty decision set as a 0% ghost rate (clean)', () => {
    const d = deriveHealth({ ...HEALTHY, decisions: [] })!;
    expect(d.ghostRate).toBe(0);
    expect(d.checks.find((c) => c.name === 'parser_clean')!.ok).toBe(true);
  });

  it('computes lastRunAgeSeconds from lastRunMs and an injected now', () => {
    const now = 1_000_000;
    const d = deriveHealth({ ...HEALTHY, lastRunMs: now - 30_000, now })!;
    expect(d.lastRunAgeSeconds).toBe(30);
  });

  it('leaves lastRunAgeSeconds null when there is no run', () => {
    expect(deriveHealth({ ...HEALTHY, lastRunMs: 0 })!.lastRunAgeSeconds).toBeNull();
  });
});

describe('healthTone', () => {
  it('is "good" when every check passes', () => {
    expect(healthTone(deriveHealth(HEALTHY)!)).toBe('good');
  });

  it('is "warn" when >=70% of checks pass (one failure of five)', () => {
    // Single escalation failure → 4/5 = 80% pass → warn.
    const d = deriveHealth({ ...HEALTHY, escalations: [{ escalation: 'x' }] })!;
    expect(healthTone(d)).toBe('warn');
  });

  it('is "bad" when fewer than 70% of checks pass', () => {
    // No features + escalated + smoke fail + ghosts → many failures.
    const d = deriveHealth({
      ...HEALTHY,
      features: [],
      escalations: [{ escalation: 'x' }],
      smoke: [{ status: 'fail' }],
      decisions: [{ isGhost: true }],
    })!;
    expect(healthTone(d)).toBe('bad');
  });
});

describe('<HealthBadge />', () => {
  it('shows a loading placeholder while the lanes query is loading', () => {
    results['harnessLanes.byHarness'] = { loading: true };
    render(<HealthBadge slug="my-harness" />);
    expect(screen.getByText('…')).toBeTruthy();
  });

  it('renders the passing-checks tally once the verdict resolves', () => {
    results['harnessLanes.byHarness'] = { data: [{ phase: 'staging' }], loading: false };
    results['featuresConsolidated.bySlug'] = { data: [{ status: 'passed' }] };
    render(<HealthBadge slug="my-harness" />);
    // All five checks pass with this fixture → "5/5".
    expect(screen.getByText('5/5')).toBeTruthy();
    expect(screen.getByText('health')).toBeTruthy();
  });
});
