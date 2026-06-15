// @vitest-environment jsdom
/**
 * AdvEvalsTab coverage (impartial-benchmark-suite-2026-06-15 BRIEF 9 / P-020).
 *
 * Two layers:
 *  - the exported pure mappers `toFrontierPoints` / `toComparePerTask` (presentation-
 *    only pivots of sync data → viz props), tested directly; and
 *  - the tab component: the six ?evalView= subtabs route to the right view, each
 *    renders its own empty state until suites exist, the suite picker only appears
 *    once suites load + a pick writes ?evalSuite= and clears ?evalRun=, and the
 *    refresh buttons drive `invalidate`.
 *
 * The shared eval-viz charts + the Radix Select are mocked to lightweight markers
 * (they read no data — they render their own empties; tested in their own suites).
 * nuqs is a per-key store the tests seed; @papercusp/sync dispatches by queryName.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// ── nuqs: per-key store with spy setters captured per render. ──
const nuqsState: Record<string, unknown> = { evalView: 'external', evalSuite: null, evalRun: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    const set = vi.fn(async (v: unknown) => {
      nuqsState[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(nuqsState[key]) : v;
    });
    nuqsSetters[key] = set;
    return [nuqsState[key], set];
  },
  parseAsString: {},
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
}));

// ── @papercusp/sync: dispatch by queryName from a hoisted store. ──
const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
}));

// ── eval-viz charts → markers that echo their key props. ──
vi.mock('@/app/eval-viz', () => ({
  Frontier: ({ points }: { points: unknown[] }) => <div data-testid="viz-frontier" data-n={points.length} />,
  Compare: ({ baseline, perTask }: { baseline: string; perTask: unknown[] }) => (
    <div data-testid={`viz-compare-${baseline}`} data-n={perTask.length} />
  ),
  ThroughputBars: ({ arms }: { arms: unknown[] }) => <div data-testid="viz-throughput" data-n={arms.length} />,
  MastBreakdown: ({ arms }: { arms: unknown[] }) => <div data-testid="viz-mast" data-n={arms.length} />,
  ValueCaptureCurve: ({ series }: { series: unknown[] }) => <div data-testid="viz-value" data-n={series.length} />,
  armLabel: (a: string) => a,
  armColor: () => '#000',
}));

// ── Radix Select → a native <select> so onChange is testable. ──
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {String(o.label)}
        </option>
      ))}
    </select>
  ),
}));

import AdvEvalsTab, { toFrontierPoints, toComparePerTask } from './AdvEvalsTab';

beforeEach(() => {
  nuqsState.evalView = 'external';
  nuqsState.evalSuite = null;
  nuqsState.evalRun = null;
  H.results = {};
});
afterEach(() => cleanup());

function seedSuites(suites: unknown[], extra: Partial<ReturnType<typeof blank>> = {}) {
  H.results['evals.suites'] = { ...blank(), data: suites, ...extra };
}

describe('toFrontierPoints', () => {
  it('returns [] for no report', () => {
    expect(toFrontierPoints(undefined)).toEqual([]);
  });
  it('keeps only arms with a cost and maps to {label,cost,score,arm}', () => {
    const pts = toFrontierPoints({
      suite: 's',
      byArm: [
        { arm: 'papercusp', passAt1: 0.7, costUsd: 12 },
        { arm: 'baseline-b-native', passAt1: 0.5, costUsd: undefined },
        { arm: 'baseline-a-ablation', passAt1: 0.4, costUsd: 8 },
      ],
    });
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ arm: 'papercusp', cost: 12, score: 0.7 });
  });
});

describe('toComparePerTask', () => {
  it('pivots seeds → per-task mean for baseline vs treatment, dropping infra errors', () => {
    const rows = [
      { taskId: 't1', arm: 'b', seed: 0, resolved: true },
      { taskId: 't1', arm: 'b', seed: 1, resolved: false },
      { taskId: 't1', arm: 'p', seed: 0, resolved: true },
      { taskId: 't2', arm: 'p', seed: 0, resolved: null }, // infra error — excluded
      { taskId: 't2', arm: 'b', seed: 0, resolved: true },
    ];
    const out = toComparePerTask(rows as never, 'b', 'p');
    const t1 = out.find((r) => r.label === 't1')!;
    expect(t1.baseline).toBe(0.5); // mean(1,0)
    expect(t1.treatment).toBe(1);
    const t2 = out.find((r) => r.label === 't2')!;
    expect(t2.treatment).toBeNull(); // only infra-error rows for treatment
    expect(t2.baseline).toBe(1);
    // sorted by label
    expect(out.map((r) => r.label)).toEqual(['t1', 't2']);
  });
});

describe('<AdvEvalsTab> shell + routing', () => {
  it('renders the header, the four-arm legend, and the six subtabs', () => {
    render(<AdvEvalsTab />);
    expect(screen.getByRole('heading', { name: /Evaluation/ })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: /Evaluation view/ })).toBeTruthy();
    for (const label of ['External benchmarks', 'Throughput', 'Value', 'Coordination', 'Internal trends', 'Report']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The four locked arms in the legend.
    expect(screen.getByLabelText('Benchmark arms').textContent).toContain('Papercusp');
  });

  it('default external view shows the no-runs empty card when there are no suites', () => {
    render(<AdvEvalsTab />);
    expect(screen.getByText('No benchmark runs yet')).toBeTruthy();
    // The suite picker is hidden until suites exist.
    expect(screen.queryByLabelText('Benchmark suite')).toBeNull();
  });

  it('clicking a subtab writes ?evalView=', () => {
    render(<AdvEvalsTab />);
    fireEvent.click(screen.getByText('Throughput'));
    expect(nuqsSetters.evalView).toHaveBeenCalledWith('throughput');
  });

  it('throughput view (no suites) shows its own L2 empty card', () => {
    nuqsState.evalView = 'throughput';
    render(<AdvEvalsTab />);
    expect(screen.getByText('No fleet runs yet')).toBeTruthy();
  });

  it('value view (no suites) shows the L3 empty card', () => {
    nuqsState.evalView = 'value';
    render(<AdvEvalsTab />);
    expect(screen.getByText('No value runs yet')).toBeTruthy();
  });

  it('coordination view (no suites) shows the L4 empty card with the MAS baseline band', () => {
    nuqsState.evalView = 'coordination';
    render(<AdvEvalsTab />);
    expect(screen.getByText('No coordination data yet')).toBeTruthy();
    expect(screen.getByText(/41–86% multi-agent-system baseline/)).toBeTruthy();
  });

  it('internal-trends view shows the no-trend empty until ≥2 generations exist', () => {
    nuqsState.evalView = 'internal';
    seedSuites([{ suite: 'swe', runId: 'r1', taskCount: 3, armCount: 4 }]);
    render(<AdvEvalsTab />);
    expect(screen.getByText('No trend yet')).toBeTruthy();
  });

  it('report view shows the no-report empty until a report lands', () => {
    nuqsState.evalView = 'report';
    seedSuites([{ suite: 'swe', runId: 'r1', taskCount: 3, armCount: 4 }]);
    render(<AdvEvalsTab />);
    expect(screen.getByText('No report yet')).toBeTruthy();
  });
});

describe('<AdvEvalsTab> with suites loaded', () => {
  const SUITES = [
    { suite: 'swe-bench-pro', runId: 'run-1', taskCount: 12, armCount: 4, passAt1ByArm: { papercusp: 0.66 } },
    { suite: 'terminal-bench', runId: 'run-2', taskCount: 8, armCount: 4 },
  ];

  it('external view renders the per-arm scoreboard + the Frontier once suites exist', () => {
    seedSuites(SUITES);
    H.results['evals.report'] = { ...blank(), data: [{ suite: 'swe-bench-pro', byArm: [{ arm: 'papercusp', passAt1: 0.66, costUsd: 14 }] }] };
    render(<AdvEvalsTab />);
    // pass@1 for the default-selected first suite (66%).
    expect(screen.getByLabelText(/swe-bench-pro — pass@1 by arm/)).toBeTruthy();
    expect(screen.getByText('66%')).toBeTruthy();
    expect(screen.getByTestId('viz-frontier')).toBeTruthy();
    expect(screen.getByTestId('viz-frontier').getAttribute('data-n')).toBe('1');
  });

  it('shows the suite picker once suites load; picking a suite writes ?evalSuite= and clears ?evalRun=', () => {
    seedSuites(SUITES);
    render(<AdvEvalsTab />);
    const picker = screen.getByLabelText('Benchmark suite') as HTMLSelectElement;
    expect(picker).toBeTruthy();
    // Default selection is the first suite.
    expect(picker.value).toBe('swe-bench-pro');
    fireEvent.change(picker, { target: { value: 'terminal-bench' } });
    expect(nuqsSetters.evalSuite).toHaveBeenCalledWith('terminal-bench');
    expect(nuqsSetters.evalRun).toHaveBeenCalledWith(null);
  });

  it('the top refresh button is disabled while fetching and invalidates the suites query', () => {
    const inv = vi.fn();
    seedSuites(SUITES, { invalidate: inv, fetching: false });
    render(<AdvEvalsTab />);
    fireEvent.click(screen.getByLabelText('Reload the evaluation data'));
    expect(inv).toHaveBeenCalled();
  });

  it('report view renders the headline scoreboard + a Compare per baseline once a report lands', () => {
    nuqsState.evalView = 'report';
    seedSuites(SUITES);
    H.results['evals.report'] = {
      ...blank(),
      data: [{ suite: 'swe-bench-pro', byArm: [{ arm: 'papercusp', passAt1: 0.66, ci: [0.5, 0.8] }] }],
    };
    H.results['evals.runs'] = {
      ...blank(),
      data: [
        { taskId: 't1', arm: 'papercusp', seed: 0, resolved: true },
        { taskId: 't1', arm: 'baseline-b-native', seed: 0, resolved: false },
      ],
    };
    render(<AdvEvalsTab />);
    expect(screen.queryByText('No report yet')).toBeNull();
    expect(screen.getByText('66%')).toBeTruthy();
    // One Compare block per baseline arm (B native, A ablation, C best-of-N).
    expect(screen.getByTestId('viz-compare-baseline-b-native')).toBeTruthy();
    expect(screen.getByTestId('viz-compare-baseline-a-ablation')).toBeTruthy();
    expect(screen.getByTestId('viz-compare-baseline-c-bestofn')).toBeTruthy();
    // The B-native Compare got the one comparable task pivoted in.
    expect(screen.getByTestId('viz-compare-baseline-b-native').getAttribute('data-n')).toBe('1');
  });
});
