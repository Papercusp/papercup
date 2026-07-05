// @vitest-environment jsdom
//
// LearningTab render coverage — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
// Mounts the tab against realistic `learning.improvements` / `learning.gym` /
// `learning.apiary` / `learning.knowledge` / `learning.scout` snapshots (useSyncQuery +
// nuqs mocked, the pinned sibling pattern — see AdvConversationsTab.test.tsx).
// useSyncQuery dispatches on queryName so each sub-view gets its own shape. Asserts the
// Improvements scoreboard + lanes (default view), the Gym sub-view, the Benchmark trend
// (+ owner-gated empty state), the Scout rails/tick view, and the Knowledge runbooks +
// memory health + Insights cross-link — plus the how-this-works strip — guarding against
// render-time crashes the typecheck can't catch. Empty states are pinned per view.
// Scout grading (B-07, scout-idea-grading-2026-06-12): star control, attribution
// chip, optimistic write through the `blender:grade-idea` tool proxy (+ rollback),
// the `?grade=` note popover, and the lens-weight strip.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const nuqsState: Record<string, unknown> = { lview: 'improvements', lane: 'all', how: true, tab: null, grade: null, lhive: '' };
// Capture the setter per key so tests can assert the hive picker writes ?lhive.
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    const setter = (nuqsSetters[key] ??= vi.fn((v: unknown) => { nuqsState[key] = v; }));
    return [nuqsState[key], setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsBoolean: { withDefault: () => ({}) },
  parseAsString: { withDefault: () => ({}) },
}));

// LearningTab's dropdowns now use the themed <Select> (Radix). Mock it as a native
// <select> with the same contract (mirrors AdvShell.test) so the hive-lens
// assertions (getByLabelText / option roles / value / disabled) still hold; the
// placeholder is rendered as the value="" option so the "no hives yet" case asserts.
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const improvementsDigest = {
  generatedAt: new Date(0).toISOString(),
  total: 135,
  open: 117,
  byKind: { bug: 107, change: 28 },
  bySeverity: { major: 87, minor: 40, critical: 5, nit: 3 },
  byState: { open: 117, resolved: 15, closed: 3 },
  autoEligible: [
    {
      id: 'EI-75', kind: 'bug', title: 'cup:spawn children are coordination-MUTE', scope: 'operator',
      severity: 'critical', state: 'open', assignee: null, assignedAt: null, attempts: 0,
      tier: 'auto', score: 46, ageDays: 2.6, tierReason: 'no protected path → AUTO', ideaType: 'process',
    },
  ],
  humanQueue: [
    {
      id: 'EI-85', kind: 'bug', title: 'Peer restarts massacre in-flight spawns', scope: 'operator',
      severity: 'critical', state: 'open', assignee: null, assignedAt: null, attempts: 0,
      tier: 'human', score: 42, ageDays: 2.5, tierReason: 'protected keyword deploy → human', ideaType: 'process',
    },
  ],
  likelyDuplicates: [],
  recurringSignatures: [],
  headline: 'papercusp-improvement digest: 135 captured (117 open)',
  // P-041 flow scoreboard — flows, not stocks. lastTickAt is relative to now
  // because the strip's watchdog-health tone is computed against Date.now().
  flow: {
    captured7d: 12,
    resolved7d: 8,
    net7d: 4,
    medianOpenAgeDays: 14.2,
    recurringSignatureCount: 3,
    watchdog: { lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(), ticks24h: 96, captured24h: 5 },
  },
};

const gymSnapshot = {
  proposals: [
    { id: 'v1__worker', harnessSlug: 'papercup-gym', cycle: 3, role: 'worker', rationale: 'tighten the worker acceptance check', devAnchorDelta: 0.042, costDelta: -0.01, status: 'accepted', createdAt: 1, decidedAt: 2 },
    { id: 'v2__architect', harnessSlug: 'papercup-gym', cycle: 3, role: 'architect', rationale: 'more explicit chunk sizing', devAnchorDelta: -0.018, costDelta: 0.02, status: 'rejected', createdAt: 1, decidedAt: 2 },
  ],
  autoloops: [
    { harnessSlug: 'papercup-gym', enabled: true, status: 'running', budgetUsd: 20, spentUsd: 4.5, lastCycle: 3 },
  ],
};

// Composites use the LIVE judge scale (0..10 — real gen-0 rows sit at 4.06..5.95),
// not 0..1: the BenchmarkTrend projection must stay scale-free (B-12).
const apiarySnapshot = {
  instances: [
    { instanceId: 'gen0-bbb2222-ws', codeSha: 'bbb2222', createdAt: new Date(2_000_000).toISOString(), totalRuns: 20, successfulRuns: 16, successRate: 0.8, meanComposite: 5.95, meanTimeToGreenSecs: 95, meanTokens: 12000, escalationRate: 0.1, firstAttemptRate: 0.6 },
    { instanceId: 'gen0-aaa1111-ws', codeSha: 'aaa1111', createdAt: new Date(1_000_000).toISOString(), totalRuns: 20, successfulRuns: 14, successRate: 0.7, meanComposite: 4.06, meanTimeToGreenSecs: 110, meanTokens: 13500, escalationRate: 0.15, firstAttemptRate: 0.5 },
  ],
};

const knowledgeSnapshot = {
  insights: {
    count: 38,
    recent: [
      { slug: 'adding-a-sync-query', title: 'Adding a sync query', description: 'The per-entry resolver recipe.', status: 'active', tags: ['sync'], modifiedAt: new Date(3_000_000).toISOString() },
      { slug: 'postgres-js-jsonb-binding', title: 'postgres.js jsonb binding', description: 'sql.json throws under getOrgPg.', status: 'active', tags: ['pg'], modifiedAt: new Date(2_000_000).toISOString() },
    ],
  },
  memory: {
    totalMemories: 168,
    entityRows: 1829,
    feedback30d: 3,
    recalls7d: 40,
    zeroHit7d: 10,
    zeroHitRate7d: 0.25,
    topScoreP50: 0.52,
    topScoreP90: 0.74,
    fragmentHits7d: 0,
  },
};

const scoutSnapshot = {
  totalRouted: 4,
  railCounts: [
    { rail: 'plan', count: 3 },
    { rail: 'gym', count: 1 },
  ],
  recent: [
    {
      ideaId: 'idea-1', lens: 'reframing', rail: 'plan', routedRef: 'plan:scout-cache-warmup',
      title: 'Cache-warmup plan draft', routedAt: new Date(Date.now() - 10 * 60_000).toISOString(), outcome: 'pending',
      humanGrade: null, humanFeedback: null, gradedBy: null,
    },
    {
      ideaId: 'idea-2', lens: 'analogical', rail: 'gym', routedRef: 'gym:proposal-7',
      title: 'Tighter scoper prompt', routedAt: new Date(Date.now() - 60 * 60_000).toISOString(), outcome: 'won',
      // Queen auto-graded (C-1c) — the row shows the attribution chip; owner regrade stays open.
      humanGrade: 4, humanFeedback: 'Sharp framing — ship it', gradedBy: 'Queen',
    },
  ],
  lastTick: { at: new Date(Date.now() - 5 * 60_000).toISOString(), outcome: 'gated', detail: 'min-interval' },
};

let improvementsResult: Record<string, unknown> = { data: [improvementsDigest], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let gymResult: Record<string, unknown> = { data: [gymSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let apiaryResult: Record<string, unknown> = { data: [apiarySnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let knowledgeResult: Record<string, unknown> = { data: [knowledgeSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let scoutResult: Record<string, unknown> = { data: [scoutSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let hiveEvalResult: Record<string, unknown> = { data: [{ instances: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
// P-042: the tab-level hive picker reuses learning.hiveList; the Learnings view
// reads learning.hive + learningPacks.list. Defaults: two hives so the picker
// renders real options.
let hiveListResult: Record<string, unknown> = { data: [{ slug: 'alpha-hive', remote: false }, { slug: 'beta-hive', remote: true }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
let hiveResult: Record<string, unknown> = { data: [{ hive: 'alpha-hive', rows: [], packs: [], organicCount: 0 }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
// Per-query args the tab passed — asserted by the P-042 hive-lens tests.
const seenArgs: Record<string, unknown> = {};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: unknown }) => {
    seenArgs[opts.queryName] = opts.args;
    return opts.queryName === 'learning.gym'
      ? gymResult
      : opts.queryName === 'learning.apiary'
        ? apiaryResult
        : opts.queryName === 'learning.hiveEvalTrend'
          ? hiveEvalResult
          : opts.queryName === 'learning.knowledge'
            ? knowledgeResult
            : opts.queryName === 'learning.scout'
              ? scoutResult
              : opts.queryName === 'learning.hiveList'
                ? hiveListResult
                : opts.queryName === 'learning.hive'
                  ? hiveResult
                  : opts.queryName === 'learningPacks.list' || opts.queryName === 'learningPacks.candidates'
                    ? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() }
                    : improvementsResult;
  },
}));

// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot', t('brain') → 'brain',
// t('contributor') → 'contributor') — isolates the routed copy from the THE_HIVE
// flag hook so assertions pin the ROUTED KEY, not a pack word (restore-pot-lexicon P-006).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import LearningTab from './LearningTab';

beforeEach(() => {
  nuqsState.lview = 'improvements';
  nuqsState.lane = 'all';
  nuqsState.how = true;
  nuqsState.tab = null;
  nuqsState.grade = null;
  nuqsState.lhive = '';
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  for (const k of Object.keys(seenArgs)) delete seenArgs[k];
  improvementsResult = { data: [improvementsDigest], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  gymResult = { data: [gymSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  apiaryResult = { data: [apiarySnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  knowledgeResult = { data: [knowledgeSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  scoutResult = { data: [scoutSnapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  hiveEvalResult = { data: [{ instances: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  hiveListResult = { data: [{ slug: 'alpha-hive', remote: false }, { slug: 'beta-hive', remote: true }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  hiveResult = { data: [{ hive: 'alpha-hive', rows: [], packs: [], organicCount: 0 }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});
afterEach(() => cleanup());

describe('LearningTab — Improvements view (default)', () => {
  it('renders the scoreboard from the digest rollups', () => {
    render(<LearningTab />);
    expect(screen.getByText('Learning')).toBeTruthy();
    expect(screen.getByText('135')).toBeTruthy(); // captured total
    expect(screen.getByText('117')).toBeTruthy(); // open
    expect(screen.getByText('15')).toBeTruthy(); // resolved (byState)
  });

  it('lists both lanes in the all view', () => {
    render(<LearningTab />);
    expect(screen.getByText('cup:spawn children are coordination-MUTE')).toBeTruthy();
    // The human-lane title renders twice: the list row + the "Decide next"
    // drain panel over the blocking-impact order (consume-edges P-022 / B-08).
    expect(screen.getAllByText('Peer restarts massacre in-flight spawns').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('EI-75')).toBeTruthy();
    expect(screen.getByText('Decide next')).toBeTruthy();
  });

  it('shows the lane filter tabs and the sub-view tabs', () => {
    render(<LearningTab />);
    expect(screen.getByRole('tab', { name: 'Auto-fixable' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Needs review' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Improvements/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Gym/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Benchmark/ })).toBeTruthy();
    // tab label pack-routes via t('scout'); the identity useLexicon mock echoes
    // the key, so the tab reads "scout" (live classic/Pot label is "Blender").
    expect(screen.getByRole('tab', { name: /scout/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Knowledge/ })).toBeTruthy();
  });

  it('renders the how-this-works strip for the improvements pipeline, hidden when toggled off', () => {
    render(<LearningTab />);
    expect(screen.getByText('Notice')).toBeTruthy();
    expect(screen.getByText('Triage')).toBeTruthy();
    expect(screen.getByText('Resolve')).toBeTruthy();
    cleanup();
    nuqsState.how = false;
    render(<LearningTab />);
    expect(screen.queryByText('Notice')).toBeNull();
  });

  it('renders the empty state when no improvements match the lane', () => {
    improvementsResult = {
      data: [{ ...improvementsDigest, total: 0, open: 0, autoEligible: [], humanQueue: [], byState: {} }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText('Nothing in this lane')).toBeTruthy();
  });

  it('renders the P-041 flow strip above the scoreboard — in/out, net, median age, recurrence, watchdog health', () => {
    render(<LearningTab />);
    const strip = screen.getByLabelText('Improvement flow (trailing window)');
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain('12'); // captured 7d
    expect(strip.textContent).toContain('8'); // resolved 7d
    expect(strip.textContent).toContain('+4'); // net arrow (backlog grew)
    expect(strip.textContent).toContain('median open');
    expect(strip.textContent).toContain('14d'); // median open age label
    expect(strip.textContent).toContain('3 recurring');
    // last tick 10 minutes ago → green ("Nm ago" label, wd-good chip)
    expect(strip.textContent).toMatch(/watchdog\s*\d+m ago/);
    expect(strip.querySelector('.pc-learning__flowchip--wd-good')).toBeTruthy();
    expect(strip.textContent).toContain('96 ticks / 5 captured · 24h');
  });

  it('omits the flow strip when the resolver row carries no flow block (older payloads)', () => {
    const { flow: _flow, ...digestSansFlow } = improvementsDigest as Record<string, unknown> & { flow: unknown };
    improvementsResult = { data: [digestSansFlow], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.queryByLabelText('Improvement flow (trailing window)')).toBeNull();
    expect(screen.getByText('135')).toBeTruthy(); // the stock scoreboard still renders
  });

  it('renders the dispatch-ledger chip when flow.dispatch is present — fired/fixed counts, red on dead dispatches (P-010 / B-04)', () => {
    const base = improvementsDigest as Record<string, unknown> & { flow: Record<string, unknown> };
    const dispatch = {
      total: 9,
      fired7d: 6,
      firing: 0,
      inProgress: 2,
      overdue: 1,
      fireFailed: 1,
      orphaned: 1,
      resolved: { fixed: 3, couldNotFix: 1, needsHuman: 0 },
      fixed7d: 3,
      lastDispatchAt: new Date().toISOString(),
      lastOutcomeAt: new Date().toISOString(),
    };
    improvementsResult = {
      data: [{ ...base, flow: { ...base.flow, dispatch } }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    const strip = screen.getByLabelText('Improvement flow (trailing window)');
    expect(strip.textContent).toMatch(/dispatch\s*6\s*fired \/\s*3\s*fixed/);
    expect(strip.textContent).toContain('3 dead'); // overdue + fire-failed + orphaned
    expect(strip.querySelectorAll('.pc-learning__flowchip--wd-bad').length).toBeGreaterThanOrEqual(1);
    // The base fixture carries no dispatch block → the existing flow-strip test
    // doubles as the omitted-chip case.
  });
});

describe('LearningTab — Gym view', () => {
  beforeEach(() => {
    nuqsState.lview = 'gym';
  });

  it('renders the gym scoreboard and recent proposals', () => {
    render(<LearningTab />);
    expect(screen.getByText('Prompt experiments')).toBeTruthy();
    expect(screen.getByText('tighten the worker acceptance check')).toBeTruthy();
    expect(screen.getByText('more explicit chunk sizing')).toBeTruthy();
    // the champion (accepted) proposal's role
    expect(screen.getByText('worker')).toBeTruthy();
  });

  it('renders the gym how-this-works strip (experiment → score → promote)', () => {
    render(<LearningTab />);
    expect(screen.getByText('Experiment')).toBeTruthy();
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Promote')).toBeTruthy();
  });

  it('renders the gym empty state when no proposals exist', () => {
    gymResult = { data: [{ proposals: [], autoloops: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('No gym experiments yet')).toBeTruthy();
  });
});

describe('LearningTab — Benchmark view', () => {
  beforeEach(() => {
    nuqsState.lview = 'benchmark';
  });

  it('renders the benchmark scoreboard and the generation trend', () => {
    render(<LearningTab />);
    expect(screen.getByText('Benchmark generations')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy(); // latest success rate (scoreboard)
    // shas + composites appear in the generation rows AND the BenchmarkTrend line (B-12)
    expect(screen.getAllByText('bbb2222').length).toBeGreaterThanOrEqual(1); // latest generation sha
    expect(screen.getAllByText('4.060').length).toBeGreaterThanOrEqual(1); // older generation composite
    expect(screen.getAllByText('5.950').length).toBeGreaterThanOrEqual(1); // latest composite (scoreboard + trend)
    // the trend line itself: one polyline + one dot per scored generation
    const figure = document.querySelector('figure.pc-benchtrend');
    expect(figure).not.toBeNull();
    expect(figure!.querySelectorAll('circle')).toHaveLength(2);
  });

  it('renders the owner-gated empty state when there are no generations', () => {
    apiaryResult = { data: [{ instances: [] }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('No baseline runs yet')).toBeTruthy();
    // owner-gated copy now appears on BOTH benchmark empty cards (apiary + Hive-eval); assert the apiary one.
    expect(screen.getByText(/IQ-battery is owner-gated/)).toBeTruthy();
  });

  it('renders the Hive-orchestration trend + scoreboard when generations exist (HE-07)', () => {
    hiveEvalResult = {
      data: [{ instances: [
        { instanceId: 'hev-new', codeSha: 'ccc3333', createdAt: new Date(2_000_000).toISOString(), totalRuns: 4, scoredRuns: 4, meanComposite: 7.2, meanEfficiency: 7, meanSpeed: 8, meanCriticalPathRatio: 1.3, outcomeGatePassRate: 1, fabricationRate: 0 },
        { instanceId: 'hev-old', codeSha: 'ddd4444', createdAt: new Date(1_000_000).toISOString(), totalRuns: 4, scoredRuns: 4, meanComposite: 5.5, meanEfficiency: 6, meanSpeed: 6, meanCriticalPathRatio: 1.6, outcomeGatePassRate: 0.75, fabricationRate: 0 },
      ] }], loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText('outcome gate')).toBeTruthy(); // a Stat label unique to the Hive-eval scoreboard
    expect(screen.getByText('1.30×')).toBeTruthy(); // latest critical-path ratio
    expect(screen.getAllByText('7.200').length).toBeGreaterThanOrEqual(1); // latest composite
    // two trend figures now: the apiary trend + the Hive-orchestration trend.
    expect(document.querySelectorAll('figure.pc-benchtrend')).toHaveLength(2);
  });

  it('renders the Hive-eval empty state when there are no Hive-eval generations', () => {
    render(<LearningTab />); // hiveEvalResult defaults to empty instances
    expect(screen.getByText('No pot-eval generations yet')).toBeTruthy();
  });
});

describe('LearningTab — Scout view', () => {
  beforeEach(() => {
    nuqsState.lview = 'scout';
  });

  it('renders the scoreboard, the routed-idea ledger rows, and the last-tick chip', () => {
    render(<LearningTab />);
    // Scoreboard: totalRouted stat + one Stat per rail (labelled via RAIL_META).
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(1); // totalRouted stat (also the Grade how-strip step number)
    expect(screen.getAllByText('plan draft').length).toBeGreaterThanOrEqual(1); // rail stat label + ledger row rail label
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1); // plan-rail count (also a how-strip step number)
    // The per-item ledger (replaced the by-rail rows): openable rows with
    // title, producing lens, and the classified outcome (pending suppressed).
    expect(screen.getByText('Routed ideas')).toBeTruthy();
    expect(screen.getByText('Cache-warmup plan draft')).toBeTruthy();
    expect(screen.getByText('Tighter scoper prompt')).toBeTruthy();
    expect(screen.getByText('reframing')).toBeTruthy(); // lens chip
    expect(screen.getByText('won')).toBeTruthy(); // classified outcome shown
    expect(screen.queryByText('pending')).toBeNull(); // pending outcome suppressed
    expect(screen.getAllByRole('button', { name: /Cache-warmup|Tighter scoper/ }).length).toBe(2); // rows are openable
    const tickChip = screen.getByLabelText('scout tick health');
    expect(tickChip.textContent).toContain('last tick');
    expect(tickChip.textContent).toContain('5m ago');
    expect(tickChip.textContent).toContain('gated · min-interval'); // status + the self-gate that withheld the cycle
  });

  it('renders the scout how-this-works strip (watch → gate → route → grade)', () => {
    render(<LearningTab />);
    expect(screen.getByText('Watch')).toBeTruthy();
    expect(screen.getByText('Gate')).toBeTruthy();
    expect(screen.getByText('Route')).toBeTruthy();
    expect(screen.getByText('Grade')).toBeTruthy(); // P-007 steering-visibility sentence
  });

  it('renders the graceful empty state when nothing has been routed and no tick exists', () => {
    scoutResult = { data: [{ totalRouted: 0, railCounts: [], lastTick: null }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('scout has not routed ideas yet')).toBeTruthy();
    expect(screen.getByLabelText('scout tick health').textContent).toContain('none yet');
  });
});

describe('LearningTab — Scout grading (B-07, scout-idea-grading-2026-06-12)', () => {
  beforeEach(() => {
    nuqsState.lview = 'scout';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the star control on every routed row and the attribution chip on graded rows', () => {
    render(<LearningTab />);
    // 5 stars per row × 2 rows — each star is a radio named "Grade N of 5".
    expect(screen.getAllByRole('radio', { name: 'Grade 3 of 5' }).length).toBe(2);
    // idea-2 is Queen-graded ★4 in the fixture (gradedBy:'Queen' is the raw server
    // value) → the attribution chip routes it through the lexicon; under the echo
    // mock t('brain') → 'brain' (restore-pot-lexicon P-006).
    expect(screen.getByText('★4 · brain')).toBeTruthy();
    // idea-1 is ungraded → no chip; its note button reads "grade with a note".
    expect(screen.getByRole('button', { name: 'Grade with a note' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit the grading note' })).toBeTruthy();
  });

  it('writes a star click through the blender:grade-idea proxy optimistically and invalidates', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ applied: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LearningTab />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Grade 5 of 5' })[0]); // idea-1's row
    // Optimistic: the owner chip appears before any refetch.
    expect(screen.getByText('★5 · Owner')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent-tools/scout/grade-idea');
    expect(JSON.parse(String(init.body))).toEqual({ ideaId: 'idea-1', grade: 5 });
    await waitFor(() => expect(scoutResult.invalidate).toHaveBeenCalled());
  });

  it('rolls back the optimistic grade and surfaces the error when the write fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LearningTab />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Grade 5 of 5' })[0]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 404'));
    expect(screen.queryByText('★5 · Owner')).toBeNull(); // rolled back to ungraded
  });

  it('opens the note popover from ?grade=<ideaId>, gates save on a grade, and saves grade + note together', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ applied: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    nuqsState.grade = 'idea-1';
    render(<LearningTab />);
    const panel = screen.getByLabelText('Grading note').closest('.pc-learning__gradepanel') as HTMLElement;
    expect(panel).toBeTruthy();
    const save = within(panel).getByRole('button', { name: 'save grade' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // idea-1 is ungraded — a grade must be picked first
    fireEvent.click(within(panel).getByRole('radio', { name: 'Grade 2 of 5' }));
    fireEvent.change(within(panel).getByLabelText('Grading note'), { target: { value: 'Too speculative' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ideaId: 'idea-1', grade: 2, feedback: 'Too speculative' });
  });

  it('renders the lens-weight strip as shares sorted descending, hidden when absent', () => {
    // Default fixture carries no lensWeights → no strip.
    render(<LearningTab />);
    expect(screen.queryByLabelText('Lens sampling weights')).toBeNull();
    cleanup();
    scoutResult = {
      data: [{ ...scoutSnapshot, lensWeights: { reframing: 3, analogical: 1 } }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    const strip = screen.getByLabelText('Lens sampling weights');
    expect(strip.textContent).toContain('lens weights');
    expect(strip.textContent).toContain('75%');
    expect(strip.textContent).toContain('25%');
    // Sorted descending: reframing (75%) before analogical (25%).
    expect(strip.textContent!.indexOf('reframing')).toBeLessThan(strip.textContent!.indexOf('analogical'));
  });
});

describe('LearningTab — Knowledge view', () => {
  beforeEach(() => {
    nuqsState.lview = 'knowledge';
  });

  it('renders the runbook count, the recent-5 list, and the memory-health chips', () => {
    render(<LearningTab />);
    expect(screen.getByText('38')).toBeTruthy(); // runbook count stat
    expect(screen.getByText('Recent runbooks')).toBeTruthy();
    expect(screen.getByText('Adding a sync query')).toBeTruthy();
    expect(screen.getByText('postgres.js jsonb binding')).toBeTruthy();
    expect(screen.getByText('adding-a-sync-query')).toBeTruthy(); // slug column
    const memCard = screen.getByLabelText('Memory health');
    expect(memCard.textContent).toContain('168');
    expect(memCard.textContent).toContain('memories');
    expect(memCard.textContent).toContain('3');
    expect(memCard.textContent).toContain('feedback events');
    // Recall-quality signals (P-031 / B-10): volume, zero-hit share, score distribution.
    expect(memCard.textContent).toContain('40');
    expect(memCard.textContent).toContain('recalls');
    expect(memCard.textContent).toContain('25%');
    expect(memCard.textContent).toContain('zero-hit');
    expect(memCard.textContent).toContain('0.52');
    expect(memCard.textContent).toContain('0.74');
    // The EI-366 regression canary stays hidden at zero leakage.
    expect(memCard.textContent).not.toContain('fragment hits');
  });

  it('renders the fragment-leakage canary chip ONLY when entity rows leak into recall', () => {
    knowledgeResult = {
      data: [{ insights: knowledgeSnapshot.insights, memory: { ...knowledgeSnapshot.memory, fragmentHits7d: 7 } }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<LearningTab />);
    const memCard = screen.getByLabelText('Memory health');
    expect(memCard.textContent).toContain('7');
    expect(memCard.textContent).toContain('fragment hits');
  });

  it('renders the agent-insights cross-link to the Insights tab', () => {
    render(<LearningTab />);
    expect(screen.getByText(/Agent insights/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open the Insights library/ })).toBeTruthy();
  });

  it('renders the empty runbooks state (cross-link intact) when the library is empty', () => {
    knowledgeResult = { data: [{ insights: { count: 0, recent: [] }, memory: { ...knowledgeSnapshot.memory, feedback30d: 0 } }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByText('No runbooks yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open the Insights library/ })).toBeTruthy();
  });

  it('marks memory health unavailable when the memory half degraded to null', () => {
    knowledgeResult = { data: [{ insights: knowledgeSnapshot.insights, memory: null }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    expect(screen.getByLabelText('Memory health').textContent).toContain('memory health unavailable');
    expect(screen.getByText('Adding a sync query')).toBeTruthy(); // insights half still renders
  });
});

describe('LearningTab — per-Hive lens (per-hive-learning-loops-2026-06-14 P-042)', () => {
  it('renders the tab-level hive picker on hive-aware views (Improvements) with the hiveList options', () => {
    render(<LearningTab />); // default view = improvements (hive-aware)
    const picker = screen.getByLabelText('pot lens') as HTMLSelectElement;
    expect(picker).toBeTruthy();
    // Labels are the friendly hive name — hiveHomeLabel strips the `-hive` home
    // suffix for display (workspace-hive-ui-2026-06-17) — while the option VALUE
    // stays the raw slug for backend calls.
    const alpha = within(picker).getByRole('option', { name: 'alpha' }) as HTMLOptionElement;
    expect(alpha.value).toBe('alpha-hive');
    // remote hives are badged "(joined)".
    const beta = within(picker).getByRole('option', { name: 'beta (joined)' }) as HTMLOptionElement;
    expect(beta.value).toBe('beta-hive');
  });

  it('shows the picker on the Gym and Learnings views too', () => {
    nuqsState.lview = 'gym';
    render(<LearningTab />);
    expect(screen.getByLabelText('pot lens')).toBeTruthy();
    cleanup();
    nuqsState.lview = 'learnings';
    render(<LearningTab />);
    expect(screen.getByLabelText('pot lens')).toBeTruthy();
  });

  it('HIDES the picker on workspace-global views (Benchmark, Scout, Knowledge, Throughput)', () => {
    for (const v of ['benchmark', 'scout', 'knowledge', 'throughput']) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(screen.queryByLabelText('pot lens')).toBeNull();
    }
  });

  it('defaults the selection to the first hive and scopes the feed to it (consistent per-Hive lens)', () => {
    // lhive='' → the resolved hive falls back to the first list entry, and EVERY
    // hive-aware view scopes to that concrete hive (matches what the Learnings
    // view already did). The picker value + the threaded arg agree, so the lens
    // is never silently workspace-wide while showing a specific hive selected.
    render(<LearningTab />);
    const picker = screen.getByLabelText('pot lens') as HTMLSelectElement;
    expect(picker.value).toBe('alpha-hive'); // first hive shown as the selection
    expect(seenArgs['learning.improvements']).toEqual({ hive: 'alpha-hive' });
  });

  it('threads the chosen hive into the Improvements query args', () => {
    nuqsState.lhive = 'beta-hive';
    render(<LearningTab />);
    expect(seenArgs['learning.improvements']).toEqual({ hive: 'beta-hive' });
  });

  it('threads the chosen hive into the Gym query args', () => {
    nuqsState.lview = 'gym';
    nuqsState.lhive = 'beta-hive';
    render(<LearningTab />);
    expect(seenArgs['learning.gym']).toEqual({ hive: 'beta-hive' });
  });

  it('threads the chosen hive into the Learnings (learning.hive) query args', () => {
    nuqsState.lview = 'learnings';
    nuqsState.lhive = 'beta-hive';
    render(<LearningTab />);
    expect(seenArgs['learning.hive']).toEqual({ hive: 'beta-hive' });
  });

  it('writes ?lhive when the picker changes', () => {
    render(<LearningTab />);
    fireEvent.change(screen.getByLabelText('pot lens'), { target: { value: 'beta-hive' } });
    expect(nuqsSetters.lhive).toHaveBeenCalledWith('beta-hive');
  });

  it('disables the picker (no hives yet) and queries improvements workspace-wide', () => {
    hiveListResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<LearningTab />);
    const picker = screen.getByLabelText('pot lens') as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(within(picker).getByRole('option', { name: 'no pot yet' })).toBeTruthy();
    expect(seenArgs['learning.improvements']).toEqual({});
  });
});
