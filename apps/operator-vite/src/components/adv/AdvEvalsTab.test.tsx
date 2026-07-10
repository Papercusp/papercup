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
import type { ReactNode } from 'react';

// ── nuqs: per-key store with spy setters captured per render. ──
const nuqsState: Record<string, unknown> = { evalView: 'external', evalSuite: null, evalRun: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
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
  mutatePaths: [] as string[],
}));
const blank = () => ({ data: [] as unknown[], loading: false, fetching: false, error: null, invalidate: vi.fn() });
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => H.results[queryName] ?? blank(),
  useSyncMutate: (path: string, restFallback: (args: unknown) => Promise<unknown>) => {
    H.mutatePaths.push(path);
    return restFallback;
  },
}));

// RichGrid is layout-heavy; the tab only owns columns/rows wiring here.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: Array<{ key: string; render?: (ctx: { row: Record<string, unknown>; rowIndex: number; rowBg: string; isSelected: boolean }) => ReactNode }> }) => (
    <div data-testid="rich-grid" data-rows={rows.length}>
      {rows.map((row, rowIndex) => (
        <div key={String(row.instanceId ?? row.id ?? rowIndex)}>
          {columns.map((col) => (
            <span key={col.key}>{col.render ? col.render({ row, rowIndex, rowBg: '', isSelected: false }) : String(row[col.key] ?? '')}</span>
          ))}
        </div>
      ))}
    </div>
  ),
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
  computeValiditySignals: () => [
    { key: 'empty-diff', label: 'Non-empty diffs', status: 'warn', detail: 'some empty' },
  ],
  isRunValid: () => true,
  validityCaveats: (sigs: Array<{ status: string }>) => sigs.filter((s) => s.status === 'warn' || s.status === 'fail'),
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
  nuqsState.compareA = null;
  nuqsState.compareB = null;
  H.results = {};
  H.mutatePaths = [];
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

// The "Preserved runs" / live-runs subtab now reads the operational bench-run
// store via the @papercusp/sync resolvers evals.benchRuns + evals.benchRun
// (benchmark-evaluation-ui-2026-06-16 P-003), not the old REST evalApi.
describe('<AdvEvalsTab> runs subtab (evals.benchRuns / evals.benchRun)', () => {
  const RUN_LIST = [
    {
      id: 'm3-realqueen-2026-06-16',
      arm: 'hive-realqueen',
      taskSetId: '11-task-pilot',
      status: 'done',
      source: 'import',
      resolvedPct: 0.5,
      costUsd: 33.98,
      createdAt: '2026-06-16T04:00:00Z',
    },
  ];
  const RUN_DETAIL = {
    id: 'm3-realqueen-2026-06-16',
    arm: 'hive-realqueen',
    status: 'done',
    run: { arm: 'hive-realqueen', startedAt: '2026-06-16T04:00:00Z', coordEvents: [{ kind: 'placement' }, { kind: 'complete' }] },
    perTask: [
      { instanceId: 'instance_a', resolved: true, costUsd: 5, turns: 1, diffBytes: 100 },
      { instanceId: 'instance_b', resolved: false, costUsd: 2, turns: 1, diffBytes: 0 },
    ],
    summary: {
      arm: 'hive-realqueen', gradedCount: 2, resolvedCount: 1, taskCount: 2, resolvedPct: 0.5,
      costUsd: 7, tokensIn: 100, tokensOut: 200, wallMs: 0, peakConcurrentBees: 3,
      nonEmptyDiffs: 1, coordEventCount: 2, recovered: true,
    },
    coordRates: {
      duplicationRate: 0, coordinationBreakdownRate: 0, misalignmentRate: 0, redundantWorkRate: 0,
      counts: { duplicate: 0, breakdown: 0, misalignment: 0, redundant: 0 }, coordinationActions: 2,
    },
  };

  it('shows the empty card when the store has no runs', () => {
    nuqsState.evalView = 'preserved';
    render(<AdvEvalsTab />);
    expect(screen.getByText('No preserved runs yet')).toBeTruthy();
  });

  it('renders the run picker + summary + per-task/coordination viz from the live store', () => {
    nuqsState.evalView = 'preserved';
    H.results['evals.benchRuns'] = { ...blank(), data: RUN_LIST };
    H.results['evals.benchRun'] = { ...blank(), data: [RUN_DETAIL] };
    render(<AdvEvalsTab />);
    // The run picker is populated from evals.benchRuns.
    expect(screen.getByLabelText('Preserved run')).toBeTruthy();
    // The selected run's summary scoreboard renders from evals.benchRun.
    expect(screen.getByLabelText(/hive-realqueen — preserved run summary/)).toBeTruthy();
    expect(screen.getByTestId('preserved-task-grid')).toBeTruthy();
    expect(screen.getByTestId('rich-grid').getAttribute('data-rows')).toBe('2');
    // The per-task Compare + the single-arm throughput/MAST viz are fed from the detail.
    expect(screen.getByTestId('viz-throughput')).toBeTruthy();
    expect(screen.getByTestId('viz-mast')).toBeTruthy();
  });
});

// The Launch subtab (P-006) posts to the managed engine launcher; it reads the
// active-run guard from evals.benchRuns + evals.benchEstimate.
describe('<AdvEvalsTab> launch subtab (P-006)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/runs/launch')) {
          expect(init?.method).toBe('POST');
          return { ok: true, json: async () => ({ ok: true, runId: 'ui-hive-realqueen-123' }) } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the arm picker + a launch button when no run is in flight', async () => {
    nuqsState.evalView = 'launch';
    H.results['evals.benchEstimate'] = { ...blank(), data: [{ taskCount: 11, estCostUsd: 38.5, estWallMin: 36, perTaskUsd: 3.5, basis: 'm3' }] };
    render(<AdvEvalsTab />);
    expect(screen.getByLabelText('Benchmark arm')).toBeTruthy();
    expect(screen.getByLabelText('Launch benchmark run')).toBeTruthy();
    expect(H.mutatePaths).toContain('externalBench.launchRun');
    // The cost estimate (≥$20) requires an owner-confirm before launch is enabled.
    await screen.findByLabelText('Approve this spend');
    expect((screen.getByLabelText('Launch benchmark run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables launch + shows the in-flight banner when a run is already running', () => {
    nuqsState.evalView = 'launch';
    H.results['evals.benchRuns'] = { ...blank(), data: [{ id: 'busy-1', status: 'running' }] };
    render(<AdvEvalsTab />);
    expect(screen.getByText(/A run is already in flight/)).toBeTruthy();
    expect((screen.getByLabelText('Launch benchmark run') as HTMLButtonElement).disabled).toBe(true);
  });
});

// The Compare subtab (P-011/P-012) — arm vs arm over the operational store.
describe('<AdvEvalsTab> compare subtab (P-011/P-012)', () => {
  const RUN = (id: string, arm: string) => ({ id, arm, taskSetId: '11-task-pilot', status: 'done', source: 'import' });
  const DETAIL = {
    id: 'm3', arm: 'hive-realqueen', taskSetId: '11-task-pilot', status: 'done', source: 'import', config: { cap: 5 },
    run: { arm: 'hive-realqueen', coordEvents: [] },
    perTask: [{ instanceId: 'instance_a', resolved: true }, { instanceId: 'instance_b', resolved: false }],
    summary: { arm: 'hive-realqueen', gradedCount: 2, resolvedCount: 1, taskCount: 2, resolvedPct: 0.5, costUsd: 7, tokensIn: 1, tokensOut: 1, wallMs: 0, peakConcurrentBees: 1, nonEmptyDiffs: 1, coordEventCount: 0, recovered: true },
    coordRates: { duplicationRate: 0, coordinationBreakdownRate: 0, misalignmentRate: 0, redundantWorkRate: 0, counts: { duplicate: 0, breakdown: 0, misalignment: 0, redundant: 0 }, coordinationActions: 0 },
  };

  it('asks for a second run when fewer than two exist', () => {
    nuqsState.evalView = 'compare';
    H.results['evals.benchRuns'] = { ...blank(), data: [RUN('m3', 'hive-realqueen')] };
    render(<AdvEvalsTab />);
    expect(screen.getByText('Need at least two runs to compare')).toBeTruthy();
  });

  it('renders the A/B pickers + the delta + caveats once two runs are picked', () => {
    nuqsState.evalView = 'compare';
    nuqsState.compareA = 'm3';
    nuqsState.compareB = 'mini';
    H.results['evals.benchRuns'] = { ...blank(), data: [RUN('m3', 'hive-realqueen'), RUN('mini', 'mini-swe-agent')] };
    H.results['evals.benchRun'] = { ...blank(), data: [DETAIL] };
    render(<AdvEvalsTab />);
    expect(screen.getByLabelText('Baseline run (A)')).toBeTruthy();
    expect(screen.getByLabelText('Treatment run (B)')).toBeTruthy();
    // The honest-caveats panel is always present once both arms are picked (D-003).
    expect(screen.getByText(/Honest caveats/)).toBeTruthy();
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
