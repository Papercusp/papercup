// @vitest-environment jsdom
/**
 * testing-custom-tabs.test.tsx — coverage for the testing-tab wiring hooks.
 * `useUniversalTestingTabs` / `useTestingCustomTabs` compose the universal
 * panels (from `buildUniversalTesting`) with the operator-specific tabs
 * (test-runs / vitals / memory / routes / packaged). We mock the testing-shell
 * builder + lexicon + the operator sub-tab components, render a probe that
 * calls each hook, and assert the merged tab list + customTabs map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('@papercusp/testing-shell', () => ({
  buildUniversalTesting: (cfg: unknown) => ({
    config: cfg,
    tabs: [
      { id: 'live-web', label: 'Live' },
      { id: 'chaos-web', label: 'Chaos web' },
      { id: 'ai-explore', label: 'AI Explore' },
    ],
    customTabs: {
      'live-web': () => null,
      'chaos-web': () => null,
      'ai-explore': () => null,
    },
  }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('./_components/LiveMetricsTab', () => ({ default: () => null }));
vi.mock('./_components/RoutesTab', () => ({ default: () => null }));
vi.mock('./_components/PackagedBuildTab', () => ({ default: () => null }));
vi.mock('./_components/TestRunsTab', () => ({ default: () => null }));
vi.mock('./_components/MemoryTab', () => ({ default: () => null }));
// The colocated CSS side-effect import is a no-op in jsdom but must resolve.
vi.mock('./testing.css', () => ({}));

import { useTestingCustomTabs, useUniversalTestingTabs } from './testing-custom-tabs';

/** Probe: render the hook outputs as data-attributes / text we can assert. */
function Probe() {
  const tabs = useUniversalTestingTabs();
  const custom = useTestingCustomTabs();
  return (
    <div>
      <div data-testid="tab-ids">{tabs.map((t) => t.id).join(',')}</div>
      <div data-testid="custom-keys">{Object.keys(custom).sort().join(',')}</div>
    </div>
  );
}

afterEach(cleanup);

describe('testing-custom-tabs hooks', () => {
  it('useUniversalTestingTabs returns the universal tabs from the builder', () => {
    render(<Probe />);
    expect(screen.getByTestId('tab-ids').textContent).toBe('live-web,chaos-web,ai-explore');
  });

  it('useTestingCustomTabs merges the universal customTabs with the operator-specific tabs', () => {
    render(<Probe />);
    const keys = screen.getByTestId('custom-keys').textContent!.split(',');
    // Universal panels…
    expect(keys).toContain('live-web');
    expect(keys).toContain('chaos-web');
    expect(keys).toContain('ai-explore');
    // …plus the operator-specific panels wired in this module.
    for (const k of ['test-runs', 'vitals', 'memory', 'routes', 'packaged']) {
      expect(keys).toContain(k);
    }
  });

  it('the operator-specific customTabs map to React components', () => {
    let map: Record<string, () => unknown> = {};
    function Capture() {
      map = useTestingCustomTabs();
      return null;
    }
    render(<Capture />);
    expect(typeof map['memory']).toBe('function');
    expect(typeof map['test-runs']).toBe('function');
    expect(typeof map['vitals']).toBe('function');
  });
});
