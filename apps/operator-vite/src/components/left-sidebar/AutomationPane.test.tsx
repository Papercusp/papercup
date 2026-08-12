// @vitest-environment jsdom
/**
 * AutomationPane.test — the shared body behind the Blender / Docs / Agents tabs.
 *
 * Covers the 2026-07-25 owner ask "improve the design of the blender and docs tab
 * so it more closely models the mug tab design" — the pane leads with the Mug's
 * header bar (identity + scope + whole-pane action) over a titled section, not a
 * bare list — plus the same day's correction that COST does not belong here at
 * all (see the no-spend regression below). It also pins what must survive both:
 * the pause writes, and the pane invalidating its OWN read after its own write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blend } from 'lucide-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  catalogResult: { data: [] as unknown[], loading: false, error: null as unknown },
  nuqsState: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  invalidated: [] as string[],
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = (H.nuqsSetters[key] ??= vi.fn((v: unknown) => {
      H.nuqsState[key] = v;
    }));
    // Per-key defaults matching the real parsers: `<lens>Open` is an ARRAY of open
    // fold ids (a scalar default would blow up the `.filter()` in the toggle), and
    // `<lens>View` defaults to the state-ordered view.
    const fallback = key.endsWith('Open') ? [] : key.endsWith('View') ? 'attention' : 'schedule';
    return [H.nuqsState[key] ?? fallback, setter];
  },
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => ({
    ...H.catalogResult,
    invalidate: () => H.invalidated.push(opts.queryName),
  }),
}));

import AutomationPane, { armBudgetLabel, armingLaneValue, rowMeta, scheduleLaneValue } from './AutomationPane';

type Routine = {
  name: string;
  installSlug: string;
  category: string;
  cadence: string | null;
  /** Derived from `target_role` upstream — `spend === 'llm'`. */
  spawnsAgent: boolean;
  spend: 'llm' | 'none' | 'unknown';
  spendWhy: string | null;
  kind: 'scheduled' | 'triggered' | 'loop';
  family: string;
  /** `active` alone cannot say whether a row will run again — see routine-classification. */
  liveness: 'running' | 'stalled' | 'dormant';
  /** WI-6447: the tri-state `active` destroys — `unknown` is a real answer here. */
  armedState: 'armed' | 'disarmed' | 'unknown';
  control: 'routine' | 'flag' | 'none';
  /** Where the switch is, or WHY there is none — rendered as the padlock tooltip. */
  controlWhy: string;
  flagKey: string | null;
  needsAttention: boolean;
  /** One routine can be installed on many pots; the row carries them all. */
  installs: string[];
  ownerId: string | null;
  ownerLastActiveAt: string | null;
  triggerLabel: string | null;
  active: boolean;
  lastFiredAt: string | null;
  /** Which of the five host scheduling mechanisms this row came from. */
  source: string;
  /** Only `routines` rows can be paused from the pane — `routines:set` writes
   *  that table and nothing else. */
  controllable: boolean;
};

const routine = (over: Partial<Routine> = {}): Routine => {
  const active = over.active ?? true;
  return {
    name: 'gym-cycle',
    installSlug: 'papercusp',
    category: 'learning',
    cadence: 'every 6h',
    spawnsAgent: true,
    spend: 'llm',
    spendWhy: 'Runs one bounded gym cycle',
    kind: 'scheduled',
    family: 'learning',
    liveness: active ? 'running' : 'dormant',
    armedState: active ? 'armed' : 'disarmed',
    control: 'routine',
    controlWhy: 'Pause or resume it right here.',
    flagKey: null,
    needsAttention: false,
    installs: [over.installSlug ?? 'papercusp'],
    ownerId: null,
    ownerLastActiveAt: null,
    triggerLabel: null,
    active,
    lastFiredAt: '2026-07-25T18:00:00.000Z',
    source: 'routines',
    controllable: true,
    ...over,
  };
};

const catalog = {
  routines: [
    routine(),
    routine({ name: 'blueprint-singleton', active: false }),
    // A deterministic row. It now lives in the OTHER lens, so the llm pane must not
    // render it at all — that split is the point of the change.
    routine({
      name: 'tidy-cache',
      spawnsAgent: false,
      spend: 'none',
      spendWhy: 'Prunes cache rows',
      family: 'cleanup',
      cadence: null,
    }),
    routine({ name: 'doc-sweep', category: 'docs', family: 'docs' }),
  ],
  spend7d: [
    { role: 'gym', modelClass: 'sonnet', turns: 1200, costUsd: 12.5 },
    { role: 'scout', modelClass: null, turns: 300, costUsd: 4.25 },
    { role: 'worker', modelClass: null, turns: 90, costUsd: 1 },
  ],
};

function renderPane(overrideCatalog?: { routines: Routine[] }, lens: 'llm' | 'system' = 'llm') {
  if (overrideCatalog) {
    H.catalogResult = {
      data: [{ ...catalog, ...overrideCatalog }],
      loading: false,
      error: null,
    };
  }
  return render(
    <AutomationPane
      active
      lens={lens}
      title="Agents"
      subtitle="Scheduled model runs"
      icon={Blend}
      blurb="Scheduled work that runs a model."
    />,
  );
}

beforeEach(() => {
  H.catalogResult = { data: [catalog], loading: false, error: null };
  H.nuqsState = {};
  H.nuqsSetters = {};
  H.invalidated = [];
});
afterEach(cleanup);

describe('scheduleLaneValue', () => {
  it('leads with how many scheduled agents can SPEND — the pane’s whole reason to exist', () => {
    expect(scheduleLaneValue([routine(), routine({ name: 'b' })] as never)).toBe('2 can spend');
  });
  it('says None can spend when every spender is off (not "0 can spend")', () => {
    expect(scheduleLaneValue([routine({ active: false })] as never)).toBe('None can spend');
  });
  // Regression for the live Docs-pane misread (2026-07-25): the old wording was
  // "All paused", which is FALSE whenever a non-spending routine is still
  // running — exactly the Docs case, where knowledge-pack-delivery/hygiene were
  // both active. The counter only ever means money, so its zero case must not
  // make a claim about running-ness.
  it('never says "paused" when a non-spending routine is still active', () => {
    const rows = [
      routine({ name: 'doc-steward-dispatch', active: false, spawnsAgent: true }),
      routine({ name: 'knowledge-pack-delivery', active: true, spawnsAgent: false }),
    ];
    const value = scheduleLaneValue(rows as never);
    expect(value).toBe('None can spend');
    expect(value).not.toMatch(/paused/i);
  });
  it('reports a plain count when nothing in the category spends tokens', () => {
    expect(scheduleLaneValue([routine({ spawnsAgent: false })] as never)).toBe('1 scheduled');
  });
  it('handles the empty category', () => {
    expect(scheduleLaneValue([])).toBe('None scheduled');
  });
});

describe('AutomationPane — Mug-modelled layout (owner ask 2026-07-25)', () => {
  it('renders the Mug-style header bar: title, subtitle and a workspace scope chip', () => {
    renderPane();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Scheduled model runs')).toBeTruthy();
    // Same correction as the Mug/Kettle headers: these are workspace schedules,
    // never a per-pot control, so the chip must say so.
    expect(screen.getByText('workspace')).toBeTruthy();
  });

  /**
   * THE LENS SPLIT (owner ask 2026-07-26): "its an 'agents' tab, only the actual
   * llm runs should show there". A row belongs to exactly one pane, decided by
   * whether firing it bills a model — so the deterministic `tidy-cache` must not
   * appear in the llm pane at all, and must appear in the system pane.
   */
  it('renders only rows that can bill a model', () => {
    renderPane();
    const names = screen.getAllByTestId(/^automation-row-/).map((el) => el.getAttribute('data-testid'));
    expect(names).toContain('automation-row-gym-cycle');
    expect(names).not.toContain('automation-row-tidy-cache');
  });

  it('claims the deterministic rows for the system lens instead', () => {
    // Running is folded in this lens, so the row is counted rather than listed —
    // open it and the row is there.
    H.nuqsState.systemOpen = ['running'];
    renderPane(undefined, 'system');
    const names = screen.getAllByTestId(/^automation-row-/).map((el) => el.getAttribute('data-testid'));
    expect(names).toEqual(['automation-row-tidy-cache']);
  });

  /**
   * STATE, NOT SUBJECT (mockup C). The owner opens this pane with two questions —
   * is anything broken, and what is spending — so the buckets answer those in that
   * order, and everything dormant folds behind one line with a count.
   */
  it('sorts rows into state buckets, running before dormant', () => {
    renderPane();
    expect(screen.getByTestId('automation-bucket-attention')).toBeTruthy();
    expect(screen.getByTestId('automation-bucket-count-running').textContent).toContain('2');
    // gym-cycle + doc-sweep are running; blueprint-singleton is paused.
    expect(screen.getByTestId('automation-bucket-count-dormant').textContent).toBe('1');
  });

  it('folds the dormant bucket shut so 750 dead rows cannot bury the live ones', () => {
    renderPane();
    // Present and counted in the header, but its rows are not rendered until opened.
    expect(screen.getByTestId('automation-bucket-dormant')).toBeTruthy();
    expect(screen.queryByTestId('automation-row-blueprint-singleton')).toBeNull();

    fireEvent.click(screen.getByTestId('automation-bucket-toggle-dormant'));
    expect(H.nuqsSetters.llmOpen).toHaveBeenCalledWith(['dormant']);
  });

  it('says "all clear" rather than 0 when nothing needs the owner', () => {
    renderPane();
    expect(screen.getByTestId('automation-bucket-count-attention').textContent).toBe('all clear');
  });

  /**
   * Measured live 2026-07-26: 19 of 19 needs-you rows were stalled loops. Listed
   * individually they push "Spending now" off the first screen — the same burial
   * this pane was rebuilt to end, recreated in miniature. They are one class with
   * one remedy, so they roll up.
   */
  describe('stalled-loop roll-up', () => {
    const stalledLoop = (n: number) =>
      routine({
        name: `loop-su-dead${n}`,
        kind: 'loop',
        family: 'loops',
        liveness: 'stalled',
        needsAttention: true,
        ownerId: `su-dead${n}abc`,
        ownerLastActiveAt: '2026-07-21T15:28:00.000Z',
        cadence: 'every 5m',
      });

    it('collapses three or more stalled loops into one summary line', () => {
      renderPane({ routines: [stalledLoop(1), stalledLoop(2), stalledLoop(3)] });
      const rollup = screen.getByTestId('automation-stalled-loops-rollup');
      expect(rollup.textContent).toContain('3 stalled loops');
      expect(screen.queryByTestId('automation-row-loop-su-dead1')).toBeNull();
    });

    it('expands to the individual loops on click', () => {
      H.nuqsState.llmOpen = ['attn-loops'];
      renderPane({ routines: [stalledLoop(1), stalledLoop(2), stalledLoop(3)] });
      expect(screen.getByTestId('automation-row-loop-su-dead1')).toBeTruthy();
    });

    // Below the threshold there is nothing to gain from a roll-up, and an
    // indirection costs more than it saves.
    it('lists one or two stalled loops directly', () => {
      renderPane({ routines: [stalledLoop(1), stalledLoop(2)] });
      expect(screen.queryByTestId('automation-stalled-loops-rollup')).toBeNull();
      expect(screen.getByTestId('automation-row-loop-su-dead1')).toBeTruthy();
    });

    // Other needs-you rows are DISTINCT problems with distinct fixes — they must
    // never be swept into the loop roll-up.
    it('keeps non-loop attention rows individually listed beside the roll-up', () => {
      renderPane({
        routines: [
          stalledLoop(1),
          stalledLoop(2),
          stalledLoop(3),
          routine({ name: 'template-gym', spend: 'unknown', needsAttention: true }),
        ],
      });
      expect(screen.getByTestId('automation-stalled-loops-rollup')).toBeTruthy();
      expect(screen.getByTestId('automation-row-template-gym')).toBeTruthy();
    });

    // A loop is named by its owning SESSION, not by the UUID the owner cannot say
    // out loud — the row they quoted verbatim when asking for this change.
    it('names a loop by its owning session and pot, not its raw uuid', () => {
      H.nuqsState.llmOpen = ['attn-loops'];
      renderPane({ routines: [stalledLoop(1), stalledLoop(2), stalledLoop(3)] });
      const row = screen.getByTestId('automation-row-loop-su-dead1');
      expect(row.textContent).toContain('su-dead1');
      expect(row.textContent).not.toContain('loop-su-dead1');
      // And it explains WHY it is stalled.
      expect(row.textContent).toContain('owner last active');
    });
  });

  /**
   * The bucket that earns the System tab its place: ~30 healthy sweeps read as ONE
   * line until one breaks. In the llm pane the same bucket stays open, because
   * every row in it costs money and there are only ~20.
   */
  it('leaves Running OPEN in the llm lens — every row there costs money', () => {
    renderPane();
    expect(screen.getByTestId('automation-row-gym-cycle')).toBeTruthy();
  });

  it('folds Running SHUT in the system lens, summarising it in one line', () => {
    renderPane(undefined, 'system');
    expect(screen.queryByTestId('automation-row-tidy-cache')).toBeNull();
    // The fold still reports what it is hiding, and when it last ran.
    expect(screen.getByTestId('automation-bucket-count-running').textContent).toMatch(/1 running · last/);
  });

  /**
   * REGRESSION (owner correction 2026-07-25): "Why is the spend tab inside
   * blender? is that showing only blender related spend? It looks like not." It
   * wasn't — spend has no routine-level attribution, so the per-pane lane was
   * double-counting shared roles across Blender/Docs/Agents. Cost lives ONLY in
   * the workspace SpendTab now; this pane must never grow a cost readout again.
   */
  it('shows NO spend figures — cost belongs to the one workspace Spend tab', () => {
    renderPane();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/turns/)).toBeNull();
    // The only tabs here are the two VIEW switches (by state / by family). There is
    // no spend lane, which is what this regression exists to hold.
    expect(screen.queryAllByRole('tab').map((t) => t.getAttribute('data-testid'))).toEqual([
      'automation-view-attention',
      'automation-view-family',
    ]);
  });
});

describe('AutomationPane — controls', () => {
  it('pauses every spending routine in the pane and refreshes its own read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane();

    fireEvent.click(screen.getByTestId('automation-pause-all'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));

    // Only ACTIVE spenders are written — never a row outside this lens
    // (tidy-cache is deterministic), and never one already in the target state
    // (blueprint-singleton is already paused).
    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { name: string; args: { name: string } },
    );
    expect(sent.map((s) => s.args.name).sort()).toEqual(['doc-sweep', 'gym-cycle']);
    expect(sent[0].name).toBe('routines:set');
    vi.unstubAllGlobals();
  });

  /**
   * EI-18680916805234639 recurrence guard: `routines:set { active: false }`
   * (server-side) has REQUIRED a `reason` since EI-18654017982759582, but this
   * pane's pause paths went un-updated and hit that validation error on every
   * single pause click (3/14 = 21% of all routines:set calls in a 24h window,
   * every one coord_owner_id 'loopback' — this exact call site). Pin that a
   * pause write always carries a reason, and a resume write never needs one.
   */
  it('attaches a reason when pausing (pause-all) — routines:set rejects an unattributed pause', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane();

    fireEvent.click(screen.getByTestId('automation-pause-all'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));

    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { args: { active: boolean; reason?: string } },
    );
    expect(sent[0].args.active).toBe(false);
    expect(typeof sent[0].args.reason).toBe('string');
    expect(sent[0].args.reason!.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('attaches a reason when pausing a single routine via the row toggle', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane();

    // gym-cycle starts active:true, so this click pauses it.
    fireEvent.click(screen.getByTestId('automation-toggle-gym-cycle'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));

    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { args: { active: boolean; reason?: string } },
    );
    expect(sent[0].args.active).toBe(false);
    expect(typeof sent[0].args.reason).toBe('string');
    expect(sent[0].args.reason!.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('does NOT send a reason when resuming — routines:set only requires it on pause', async () => {
    H.catalogResult = {
      data: [{ ...catalog, routines: catalog.routines.map((r) => ({ ...r, active: false })) }],
      loading: false,
      error: null,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane();

    // Every routine is now inactive, so the toggle resumes it.
    fireEvent.click(screen.getByTestId('automation-toggle-gym-cycle'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));

    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { args: { active: boolean; reason?: string } },
    );
    expect(sent[0].args.active).toBe(true);
    expect(sent[0].args.reason).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('offers Resume all once nothing is spending', () => {
    H.catalogResult = {
      data: [{ ...catalog, routines: catalog.routines.map((r) => ({ ...r, active: false })) }],
      loading: false,
      error: null,
    };
    renderPane();
    expect(screen.getByTestId('automation-resume-all')).toBeTruthy();
    expect(screen.queryByTestId('automation-pause-all')).toBeNull();
  });

  it('surfaces a refused write inline instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { content: [{ text: JSON.stringify({ ok: false, message: 'routine locked' }) }] },
        }),
      }),
    );
    renderPane();
    fireEvent.click(screen.getByTestId('automation-toggle-gym-cycle'));
    await waitFor(() => expect(screen.getByText(/routine locked/)).toBeTruthy());
    vi.unstubAllGlobals();
  });
});

/**
 * Schedules that are LISTED but not pausable from this pane.
 *
 * The pane now reads all five host scheduling mechanisms, not just
 * `harness_shared.routines`, so the owner can see every scheduled thing (owner
 * mandate 2026-07-25). But `routines:set` only writes the routines table — the
 * other four have no switch here. They must therefore render as INERT MARKERS,
 * never as buttons: this pane's original defect was offering pause controls
 * that could not act, and a clickable-but-doomed toggle would reproduce exactly
 * that failure in a new place.
 */
describe('AutomationPane — non-routine schedules', () => {
  const uncontrollable = routine({
    name: 'doc-freshness-sweep',
    source: 'in-process',
    controllable: false,
    spawnsAgent: true,
    active: true,
  });

  it('renders a marker, NOT a toggle, for a schedule it cannot pause', () => {
    renderPane({ routines: [uncontrollable] });
    expect(screen.queryByTestId('automation-toggle-doc-freshness-sweep')).toBeNull();
    expect(screen.getByTestId('automation-nocontrol-doc-freshness-sweep')).toBeTruthy();
  });

  it('still LISTS it — being unpausable is not a reason to hide it', () => {
    renderPane({ routines: [uncontrollable] });
    expect(screen.getByTestId('automation-row-doc-freshness-sweep')).toBeTruthy();
  });

  it('offers no "Pause all" when nothing in the pane is actually pausable', () => {
    // The button's count must equal what the click can deliver; a pane of
    // uncontrollable rows can deliver nothing, so it must not offer the action.
    renderPane({ routines: [uncontrollable] });
    expect(screen.queryByTestId('automation-pause-all')).toBeNull();
    expect(screen.queryByTestId('automation-resume-all')).toBeNull();
  });

  it('counts only pausable spenders in "Pause all"', () => {
    renderPane({ routines: [uncontrollable, routine({ name: 'gym-cycle' })] });
    const btn = screen.getByTestId('automation-pause-all');
    // One controllable spender present, so the button promises exactly one.
    expect(btn.textContent).toMatch(/Pause all/);
    expect(screen.getByTestId('automation-nocontrol-doc-freshness-sweep')).toBeTruthy();
    expect(screen.getByTestId('automation-toggle-gym-cycle')).toBeTruthy();
  });

  /**
   * WI-6313. The marker used to say "Runs as a <source> schedule, not a routine —
   * paused from its own subsystem" for EVERY uncontrollable row, which named a
   * limitation and pointed nowhere; the owner had to ask a human what it meant.
   * The reason now comes from the row's own `controlWhy`, so a watchdog and a
   * per-connection keepalive no longer give the same non-answer.
   */
  it('shows the row-specific reason it cannot be paused, not a generic subsystem line', () => {
    // Built on `uncontrollable` deliberately: a spend:'none' healthy row folds into
    // the collapsed Running bucket and would not be in the DOM to assert against.
    const watchdog = {
      ...uncontrollable,
      controlWhy: 'A watchdog — deliberately outside the routine system.',
    };
    renderPane({ routines: [watchdog] });
    expect(screen.getByTestId('automation-nocontrol-doc-freshness-sweep')).toBeTruthy();
    // The old generic copy must be gone wherever the reason is rendered.
    expect(document.body.textContent).not.toMatch(/paused from its own subsystem/);
  });

  /**
   * WI-6447 — owner ask 2026-07-27: *"can you make whether its enabled or not
   * visible in the display?"*
   *
   * The pane rendered `r.cadence` alone, so an in-process sweep reporting
   * `armed: false` showed "every 1m" and read exactly like one that fires every
   * minute — the owner was looking at a list of sweeps whose state they could
   * neither see nor turn off. The `unknown` case is the worse half: those rows
   * carry no verified state at all, and the old `armed !== false` funnel made
   * them read as on.
   */
  it('says out loud that a sweep is NOT armed instead of showing a bare cadence', () => {
    const meta = rowMeta({ ...uncontrollable, armedState: 'disarmed' } as never);
    expect(meta).toContain('every 6h');
    expect(meta).toContain('not armed');
  });

  it('renders the unverified rows as unknown, never as armed', () => {
    // The 7 external-process rows: live fire-state needs P-014 federation, so
    // nothing has checked them. Asserting "running" there is the bug.
    const unknown = { ...uncontrollable, source: 'external-process', armedState: 'unknown' as const };
    renderPane({ routines: [unknown] });
    const row = screen.getByTestId('automation-row-doc-freshness-sweep');
    expect(row.textContent).toMatch(/arm state unknown/);
    expect(row.textContent).not.toMatch(/·\s*armed/);
  });

  it('does not render an unverified row at full "this is live" weight', () => {
    // The visual half of the same claim: `.is-active` is opacity 1. Keying it on
    // `active` (which swallows unknown) made the ROW assert what its own meta
    // line qualifies — full brightness beside the words "arm state unknown".
    renderPane({ routines: [{ ...uncontrollable, armedState: 'unknown' as const }] });
    const row = screen.getByTestId('automation-row-doc-freshness-sweep');
    expect(row.className).toContain('is-unverified');
    expect(row.className).not.toContain('is-active');
  });

  it('still renders a confirmed-armed row at full weight', () => {
    renderPane({ routines: [{ ...uncontrollable, armedState: 'armed' as const }] });
    expect(screen.getByTestId('automation-row-doc-freshness-sweep').className).toContain('is-active');
  });

  it('renders a not-armed row dimmed, with neither class claiming otherwise', () => {
    renderPane({ routines: [{ ...uncontrollable, armedState: 'disarmed' as const }] });
    const row = screen.getByTestId('automation-row-doc-freshness-sweep');
    expect(row.className).not.toContain('is-active');
    expect(row.className).not.toContain('is-unverified');
  });

  it('leaves a plainly-armed row unsuffixed — the unsurprising case adds no noise', () => {
    // Suffixing every row would bury the two states that CHANGE what the owner
    // should believe; a running schedule showing its cadence already says it.
    expect(rowMeta({ ...uncontrollable, armedState: 'armed' } as never)).toBe('every 6h');
  });

  it('does not tell a stalled row it is "not armed" — it already explains itself', () => {
    // "stalled · owner last active 2h ago · not armed" is two ways of saying the
    // same thing, and the stall reason is the one that helps.
    const stalled = { ...uncontrollable, liveness: 'stalled' as const, armedState: 'disarmed' as const };
    expect(rowMeta(stalled as never)).not.toMatch(/not armed/);
  });

  it('says it on a TRIGGERED row too — those have no cadence to read state from', () => {
    const triggered = {
      ...uncontrollable,
      kind: 'triggered' as const,
      triggerLabel: 'after each git-sync',
      armedState: 'disarmed' as const,
    };
    expect(rowMeta(triggered as never)).toBe('after each git-sync · not armed');
  });

  it('never renders an undefined reason when a row omits one', () => {
    // A row arriving without `controlWhy` (an older cached payload) must not put
    // the literal string "undefined" in front of the owner.
    const stale = { ...uncontrollable, controlWhy: undefined } as unknown as typeof uncontrollable;
    renderPane({ routines: [stale] });
    expect(document.body.textContent).not.toMatch(/undefined/);
  });
});

/**
 * Arming section (P-011 — owner ask 2026-07-25: "where is the ability to
 * disable/enable this in the gui? it should be in the blender tab").
 *
 * On the $-figures note: the no-spend regression above bans per-ROLE spend
 * attribution (a guess rendered as fact). The arming rows show each pot/lane's
 * OWN governor ledger — the metered spend and the budget the owner arms
 * against — which is exactly the number an arming switch must show. The two
 * must not be conflated; the default fixture has no `arming`, so the no-spend
 * test keeps guarding the role-attribution ban.
 */
const arming = {
  gymPots: [
    { harnessSlug: 'papercusp', enabled: true, budgetUsd: 50, spentUsd: 12.892153, status: 'running' },
  ],
  lanes: [
    { loopId: 'red-queen', displayName: 'Red Queen', potSlug: 'papercusp', enabled: false, budgetUsd: null, spentUsd: 0, enforcement: 'governor' },
  ],
  scoutCeiling: { overrideUsd: null, effectiveUsd: 400, envUsd: 400 },
};

describe('armingLaneValue / armBudgetLabel', () => {
  it('counts open spend gates across both groups', () => {
    expect(armingLaneValue(arming.gymPots as never, arming.lanes as never)).toBe('1 armed');
    expect(armingLaneValue([], [])).toBe('None registered');
    expect(
      armingLaneValue([{ ...arming.gymPots[0], enabled: false }] as never, arming.lanes as never),
    ).toBe('All disarmed');
  });
  it('renders one honest money label per row', () => {
    expect(armBudgetLabel(12.892153, 50)).toBe('$12.89 of $50');
    expect(armBudgetLabel(0, null)).toBe('$0 · no budget');
  });
});

describe('AutomationPane — Arming section (P-011)', () => {
  it('renders gym pots and governor lanes with toggles for the learning pane', () => {
    renderPane({ arming } as never);
    expect(screen.getByTestId('automation-arming')).toBeTruthy();
    expect(screen.getByTestId('automation-arming-status').textContent).toBe('1 armed');
    expect(screen.getByTestId('arming-row-gym-papercusp')).toBeTruthy();
    expect(screen.getByTestId('arming-row-lane-red-queen')).toBeTruthy();
  });

  // Spend gates belong beside the things that spend. The deterministic pane has
  // nothing to gate, so rendering an arming section there would be meaningless.
  it('does NOT render in the deterministic (system) pane', () => {
    H.catalogResult = { data: [{ ...catalog, arming }], loading: false, error: null };
    render(
      <AutomationPane
        active
        lens="system"
        title="System"
        subtitle="Runs without a model"
        icon={Blend}
        blurb="Deterministic scheduled work."
      />,
    );
    expect(screen.queryByTestId('automation-arming')).toBeNull();
  });

  it('disarming a gym pot fires gym:arm and refreshes the pane read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane({ arming } as never);

    fireEvent.click(screen.getByTestId('arming-toggle-gym-papercusp'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent).toEqual([{ name: 'gym:arm', args: { harness: 'papercusp', enabled: false }, confirmed: true }]);
  });

  it('budget click-to-edit saves via governor:arm on Enter (empty clears)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane({ arming } as never);

    fireEvent.click(screen.getByTestId('arming-budget-lane-red-queen'));
    const input = screen.getByTestId('arming-budget-input-lane-red-queen');
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent).toEqual([{ name: 'governor:arm', args: { loopId: 'red-queen', budgetUsd: 25 }, confirmed: true }]);
  });

  it('renders the workspace-ceiling row above the arms (P-012: effective value + default/override state)', () => {
    renderPane({ arming } as never);
    expect(screen.getByTestId('arming-row-scout-workspace-ceiling')).toBeTruthy();
    expect(screen.getByTestId('arming-budget-scout-workspace-ceiling').textContent).toContain('$400 ceiling');
    expect(screen.getByTestId('arming-row-scout-workspace-ceiling').textContent).toContain('default');
  });

  it('ceiling click-to-edit saves via learning:set-scout-budget on Enter (empty clears the override)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane({ arming } as never);

    fireEvent.click(screen.getByTestId('arming-budget-scout-workspace-ceiling'));
    const input = screen.getByTestId('arming-budget-input-scout-workspace-ceiling');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent).toEqual([
      { name: 'learning:set-scout-budget', args: { op: 'set', workspaceCeilingUsd: 250 }, confirmed: true },
    ]);

    fetchMock.mockClear();
    fireEvent.click(screen.getByTestId('arming-budget-scout-workspace-ceiling'));
    const input2 = screen.getByTestId('arming-budget-input-scout-workspace-ceiling');
    fireEvent.change(input2, { target: { value: '' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))).toEqual([
        { name: 'learning:set-scout-budget', args: { op: 'clear' }, confirmed: true },
      ]),
    );
  });
});

/**
 * The pause/start control (owner ask 2026-07-26: "the pause and start buttons in
 * the middle pane in the blender docs and agents tabs all don't look like
 * pause/start buttons").
 *
 * This was the FOURTH time it was raised. Rounds 2 and 3 each restyled the
 * control to match a neighbouring chip (.pc-queen__btn, the Mug tab's button)
 * and the same complaint came straight back, because "matches the button next to
 * it" was never the property the owner was asking for — "reads as a transport
 * control" was. These tests pin the four properties that actually deliver that,
 * so a fifth restyle cannot quietly undo them:
 *
 *   1. the glyph shows the ACTION, not the state,
 *   2. the glyph is SOLID (a stroke-only ▶/⏸ at this size is a faint mark),
 *   3. layout stays OFF the <button> (WebKitGTK drops it — invisible in a
 *      browser, broken on the owner's actual desktop),
 *   4. the busy state keeps the control's shape.
 *
 * They assert rendered STRUCTURE, not cosmetics — colour and radius are free to
 * change, these are not.
 */
describe('AutomationPane — the pause/start control', () => {
  it('shows the ACTION the click performs, not the current state', () => {
    renderPane({ routines: [routine({ name: 'gym-cycle', active: true })] });
    const btn = screen.getByTestId('automation-toggle-gym-cycle');
    // Running, so the button offers PAUSE.
    expect(btn.getAttribute('data-glyph')).toBe('pause');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Pause gym-cycle');
  });

  it('offers START on a paused routine', () => {
    // A paused row lands in the folded Dormant bucket, so open it to reach the row.
    H.nuqsState.llmOpen = ['dormant'];
    renderPane({ routines: [routine({ name: 'gym-cycle', active: false })] });
    const btn = screen.getByTestId('automation-toggle-gym-cycle');
    expect(btn.getAttribute('data-glyph')).toBe('play');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Start gym-cycle');
  });

  it('draws the transport glyph SOLID — a stroke-only ▶/⏸ is what made these unreadable', () => {
    // lucide defaults every icon to fill="none". At 13px that renders a hollow
    // triangle and two hairline bars, which is the single biggest reason these
    // never read as pause/start buttons. The fill is load-bearing, not decorative.
    for (const active of [true, false]) {
      // The paused pass lands in the folded Dormant bucket — open it to reach the row.
      H.nuqsState.llmOpen = active ? [] : ['dormant'];
      renderPane({ routines: [routine({ name: 'gym-cycle', active })] });
      const svg = screen.getByTestId('automation-toggle-gym-cycle').querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('fill')).toBe('currentColor');
      cleanup();
    }
  });

  it('keeps layout OFF the <button> — WebKitGTK silently drops flex declared there', () => {
    // EI-18135716653974462 / WI-5581. The Tauri webview ignores flex/grid set on
    // a <button> element, so the centring must live on an inner element or the
    // glyph sits uncentred on the real desktop while looking perfect in a
    // browser. If a future edit puts the glyph back as a direct child of the
    // button, this fails — which is the whole point.
    renderPane({ routines: [routine({ name: 'gym-cycle', active: true })] });
    const btn = screen.getByTestId('automation-toggle-gym-cycle');
    const inner = btn.querySelector('.pc-auto__glyph');
    expect(inner).not.toBeNull();
    expect(inner!.querySelector('svg')).not.toBeNull();
    expect([...btn.children].some((c) => c.tagName.toLowerCase() === 'svg')).toBe(false);
  });

  it('keeps the header actions off the <button> too, with a solid glyph', () => {
    renderPane({ routines: [routine({ name: 'gym-cycle', active: true })] });
    const pauseAll = screen.getByTestId('automation-pause-all');
    expect(pauseAll.querySelector('.pc-auto__action-inner')).not.toBeNull();
    const svg = pauseAll.querySelector('.pc-auto__action-dot svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('fill')).toBe('currentColor');
    expect([...pauseAll.children].some((c) => c.tagName.toLowerCase() === 'svg')).toBe(false);
  });

  it('keeps its shape while busy instead of collapsing to a "…" character', async () => {
    // The old busy state replaced the glyph with a literal ellipsis, so at the
    // one moment the owner most needs to see the click landed, the control
    // stopped looking like a control.
    let release: (v: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => { release = resolve; })),
    );
    renderPane({ routines: [routine({ name: 'gym-cycle', active: true })] });

    fireEvent.click(screen.getByTestId('automation-toggle-gym-cycle'));

    const btn = await screen.findByTestId('automation-toggle-gym-cycle');
    await waitFor(() => expect(btn.querySelector('.pc-auto__spinner')).not.toBeNull());
    expect(btn.textContent).not.toContain('…');
    expect(btn.querySelector('.pc-auto__glyph')).not.toBeNull();

    release({ ok: true, json: async () => ({ ok: true, result: { content: [] } }) });
    vi.unstubAllGlobals();
  });

  it('gives the arming rows their OWN verb, so ▶/⏸ means exactly one thing in the pane', () => {
    // The arming rows gate SPEND — their verb is arm/disarm, not start/pause.
    // They used to borrow the play/pause glyph, so the same mark meant two
    // unrelated things a few rows apart.
    renderPane({ arming } as never);
    const armed = screen.getByTestId('arming-toggle-gym-papercusp');
    const disarmed = screen.getByTestId('arming-toggle-lane-red-queen');
    expect(armed.getAttribute('data-glyph')).toBe('disarm');
    expect(disarmed.getAttribute('data-glyph')).toBe('arm');
    // and never the transport glyphs
    for (const btn of [armed, disarmed]) {
      expect(['play', 'pause']).not.toContain(btn.getAttribute('data-glyph'));
    }
  });
});
