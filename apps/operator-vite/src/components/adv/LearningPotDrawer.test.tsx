// @vitest-environment jsdom
/**
 * The P-012 per-pot drawer, asserted through the RENDER
 * (learning-pot-scope-gate-2026-08-30).
 *
 * The model's rules are asserted in learning-pot-drawer.test.ts. What that
 * suite cannot see is whether the surface carries them — a model is free to
 * compute "this per-cycle cap has no remaining balance" and a component free to
 * print a subtraction anyway. So every test here asserts a rule SURVIVING THE
 * RENDER, plus the two things only a render can check: that the drawer opens
 * for a pot with no chip and no arming rows, and that arming and budgeting are
 * two separate writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type {
  AutomationArming,
  AutomationCatalog,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

const H = vi.hoisted(() => ({
  arming: null as AutomationArming | null,
  /** Rows the `hive.overrides` query returns — the pot's settings config (P-013). */
  overrides: [] as { kind: string; name: string; value: unknown }[],
}));

const setOverride = vi.fn(async (_args: unknown) => ({ ok: true }));

/**
 * ⚠ THIS FACTORY IS HAND-LISTED, WHICH MAKES IT A WHOLE-FILE FUSE. Vitest
 * replaces the module with EXACTLY these keys, so the first time the component
 * reaches an export missing here, every test in the file fails at import with
 * `No "<name>" export is defined` — not on the assertion that needed it. P-013
 * adding the config write is what proved it: 25 passing tests went red at once
 * for a missing `useSyncMutate`. Add the export here when you add the call.
 */
vi.mock('@papercusp/sync', () => ({
  // Not decoration — useLexicon reaches flag-hooks, which subscribes to the
  // sync bus during render; omitting it throws mid-render and reports as a
  // failed FILE while individual assertions still say they passed.
  onSyncBusEvent: () => () => {},
  // The pot-config write (P-013 / D-011). Returns the mutate fn the component
  // calls; the REST fallback is never exercised under a mocked transport.
  useSyncMutate: () => (args: unknown) => setOverride(args),
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    const invalidate = vi.fn();
    if (queryName === 'hive.overrides') {
      return { data: H.overrides, loading: false, invalidate };
    }
    if (queryName !== 'automation.catalog' || !H.arming) {
      return { data: [], loading: false, invalidate };
    }
    const catalog: AutomationCatalog = {
      routines: [],
      categories: [],
      spend7d: [],
      spend7dTotalUsd: 0,
      arming: H.arming,
      generatedAt: '2026-08-31T00:00:00.000Z',
    };
    return { data: [catalog], loading: false, invalidate };
  },
}));

const runAgentTool = vi.fn(async () => {});
vi.mock('./run-tool', () => ({ runAgentTool: (...a: unknown[]) => runAgentTool(...(a as [])) }));

import LearningPotDrawer from './LearningPotDrawer';

function gym(harnessSlug: string, over: Partial<AutomationGymArm> = {}): AutomationGymArm {
  return { harnessSlug, enabled: true, budgetUsd: 20, spentUsd: 5, status: 'idle', ...over };
}

function lane(loopId: string, potSlug: string, over: Partial<AutomationLaneArm> = {}): AutomationLaneArm {
  return {
    loopId,
    displayName: loopId,
    potSlug,
    enabled: true,
    budgetUsd: 50,
    budgetKind: 'lifetime',
    spentUsd: 10,
    enforcement: 'governor',
    ...over,
  };
}

function arming(over: Partial<AutomationArming> = {}): AutomationArming {
  return {
    gymPots: [],
    lanes: [],
    scoutCeiling: { overrideUsd: null, effectiveUsd: 10, envUsd: 10 },
    potScope: { disabledPots: [], rows: [] },
    ...over,
  };
}

/** Render with the drawer OPEN on `slug` — that is what `lpot=<slug>` means. */
function open(slug: string) {
  return render(
    <NuqsTestingAdapter searchParams={{ lpot: slug }}>
      <LearningPotDrawer />
    </NuqsTestingAdapter>,
  );
}

/**
 * The Save/Reset/Clear button INSIDE one field row.
 *
 * A bare `getByRole('button', { name: 'Save' })` was unambiguous only while the
 * drawer had at most one editable budget on screen. P-013 gives every pot three
 * always-present config fields, so the global lookup now matches several — and
 * scoping is the stronger assertion anyway: it pins that the button belongs to
 * the row under test rather than to whichever one happened to render first.
 */
function saveIn(dataKey: string): HTMLButtonElement {
  const row = document.querySelector(`.pc-potdraw__field[data-key="${dataKey}"]`);
  if (!row) throw new Error(`no field row ${dataKey}`);
  const btn = row.querySelector('.pc-potdraw__save');
  if (!btn) throw new Error(`field row ${dataKey} has no save button`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  H.arming = arming();
  H.overrides = [];
  runAgentTool.mockClear();
  runAgentTool.mockImplementation(async () => {});
  setOverride.mockClear();
  setOverride.mockImplementation(async () => ({ ok: true }));
});
afterEach(cleanup);

describe('opening', () => {
  it('renders nothing when lpot is empty', () => {
    render(
      <NuqsTestingAdapter searchParams={{}}>
        <LearningPotDrawer />
      </NuqsTestingAdapter>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('OPENS FOR A POT WITH NO ARMING ROWS AT ALL — the D-008 constraint', () => {
    // This is the whole reason P-012 is load-bearing. A pot that is switched
    // off, or that the rail never rendered a chip for, must still reach its
    // per-lane controls, or P-052 can never bury it. The drawer takes a SLUG,
    // so there is nothing to be missing.
    open('a-pot-with-nothing');
    expect(screen.getByRole('dialog')).toBeTruthy();
    // All five sections render, stating absence rather than hiding it.
    for (const title of ['Scout', 'Gym', 'Frontier', 'Blender', 'Other lanes']) {
      expect(screen.getByRole('region', { name: title })).toBeTruthy();
    }
    expect(screen.getByText(/never been set up/i)).toBeTruthy();
  });

  it('gives a switched-off pot live per-lane controls', () => {
    H.arming = arming({
      potScope: { disabledPots: ['p'], rows: [] },
      gymPots: [gym('p', { enabled: false })],
      lanes: [lane('red-queen', 'p', { enabled: false })],
    });
    open('p');
    // Arming a lane on an off pot is meaningful — it pre-stages what switching
    // the pot back on restores — so the controls are live, not disabled.
    expect(screen.getByRole('button', { name: /^Arm Gym autoloop$/ })).not.toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: /^Arm red-queen$/ })).toBeTruthy();
    expect(screen.getByText(/switching the pot back on restores exactly this/i)).toBeTruthy();
  });
});

describe('the master switch comes first and dominates', () => {
  it('offers a single switch when the scope is readable', () => {
    open('p');
    expect(screen.getByRole('button', { name: /Switch off learning for/ })).toBeTruthy();
  });

  it('offers BOTH explicit actions when the scope is unreadable, never a disabled control', () => {
    // Disabling here would make a failed read unrecoverable from the only
    // surface that can fix it.
    H.arming = { gymPots: [], lanes: [], scoutCeiling: null } as unknown as AutomationArming;
    open('p');
    expect(screen.getByRole('button', { name: 'Switch on' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch off' })).toBeTruthy();
    // Specifically the MASTER note. `/could not be read/` alone also matches the
    // unreadable-ceiling note in the Scout section, and a two-match getByText
    // throws — which would have read as "the note is missing".
    expect(screen.getByText(/every field below is unconfirmed/i)).toBeTruthy();
  });

  it('writes the master switch through learning:set-pot-scope for THIS pot only', async () => {
    open('p');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Switch off learning for/ }));
    });
    expect(runAgentTool).toHaveBeenCalledWith('learning:set-pot-scope', {
      pots: ['p'],
      enabled: false,
    });
  });
});

describe('every budget renders with its unit, and per-cycle shows no remaining', () => {
  it('states the unit beside the field rather than a bare number', () => {
    H.arming = arming({ gymPots: [gym('p')] });
    open('p');
    expect(screen.getByLabelText('Budget for Gym autoloop in USD lifetime')).toHaveProperty(
      'value',
      '20',
    );
    expect(screen.getByText('remaining 15.00')).toBeTruthy();
  });

  it('prints the REASON there is no remaining balance for a per-cycle cap', () => {
    // The live shape: blender:papercusp is $5 per-cycle with $513.82 spent.
    // A blank cell here is what invites someone to fill in budget − spent.
    H.arming = arming({
      lanes: [lane('blender:p', 'p', { budgetKind: 'per-cycle', budgetUsd: 5, spentUsd: 513.82 })],
    });
    open('p');
    expect(screen.getByText(/bounds one run/i)).toBeTruthy();
    expect(screen.queryByText(/remaining -/)).toBeNull();
    expect(screen.getByText('spent 513.82')).toBeTruthy();
  });

  it('names the consequence of an unset budget instead of leaving it blank', () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p', { budgetUsd: null })] });
    open('p');
    expect(screen.getByText(/governor refuses unattended spend/i)).toBeTruthy();
  });
});

describe('enforcement is stated in words, per row', () => {
  it('says the gym self-gates and the governor row mirrors it', () => {
    H.arming = arming({ gymPots: [gym('p')] });
    open('p');
    expect(screen.getByText(/autoloop tick's own eligibility check IS the gate/i)).toBeTruthy();
  });

  it('says a governor lane is gated by the preflight', () => {
    H.arming = arming({ lanes: [lane('frontier:replay', 'p')] });
    open('p');
    expect(screen.getByText(/learning-governor preflight gates every run/i)).toBeTruthy();
  });
});

describe('Scout is the workspace ceiling, and says where the per-pot control is', () => {
  it('renders the ceiling read-only with a workspace-wide unit', () => {
    open('p');
    expect(screen.getByText(/USD per 24h, workspace-wide/)).toBeTruthy();
    // No editable budget and no arm button in the Scout section.
    const scout = screen.getByRole('region', { name: 'Scout' });
    expect(scout.querySelector('input')).toBeNull();
    expect(scout.querySelector('button')).toBeNull();
  });

  it('points at the blender: lane rather than leaving a dead end', () => {
    open('p');
    expect(screen.getByText(/blender: lane below/i)).toBeTruthy();
  });
});

describe('arming and budgeting are two separate writes', () => {
  it('arms a lane with enabled only — governor:arm refuses a call with neither field', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p', { enabled: false })] });
    open('p');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Arm red-queen' }));
    });
    expect(runAgentTool).toHaveBeenCalledWith('governor:arm', {
      loopId: 'red-queen',
      enabled: true,
    });
  });

  /**
   * ⚠ THIS TEST IS THE REASON P-052 IS SAFE — it did not start here.
   *
   * It was `LearningPotRail.test.tsx`'s 'KEEPS lane switches operable while the
   * pot is off', where it twice falsified attempts to make switched-off pots
   * dormant: a fully-idle off pot still owns live per-lane switches (arming one
   * pre-stages what switching the pot back on restores), and D-007 keeps
   * per-lane control off the picker, so the chip's popover was their only home.
   * P-052 makes exactly that pot dormant — no chip, no popover — so the rail
   * can no longer carry this. The drawer is what made that trade legal, and
   * this test is the proof, moved to the surface that now owns it.
   *
   * If this test is ever deleted rather than moved again, `isPotChipDormant`
   * must stop treating 'off' as eligible, or these switches strand silently.
   *
   * ⚠ `LearningPotRail.test.tsx` NO LONGER EXISTS (2026-09-07): the rail's
   * chips were folded into the Learning tab's start/pause dropdown and both the
   * component and its test were deleted. The provenance above is kept because
   * it is the REASON this assertion lives here, and the move is what made the
   * deletion safe — but do not go looking for that file.
   */
  it('arms a lane on a switched-off idle pot — the case the rail no longer carries', async () => {
    H.arming = arming({
      gymPots: [gym('p', { enabled: false })],
      lanes: [lane('red-queen', 'p', { enabled: false })],
      potScope: { disabledPots: ['p'], rows: [] },
    });
    open('p');
    const btn = screen.getByRole('button', { name: 'Arm red-queen' }) as HTMLButtonElement;
    // Operable, not merely present: a disabled switch would strand it just as
    // completely as no switch at all.
    expect(btn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(runAgentTool).toHaveBeenCalledWith('governor:arm', {
      loopId: 'red-queen',
      enabled: true,
    });
  });

  it('arms the gym by HARNESS slug, which is what gym:arm takes', async () => {
    H.arming = arming({ gymPots: [gym('p', { enabled: true })] });
    open('p');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disarm Gym autoloop' }));
    });
    expect(runAgentTool).toHaveBeenCalledWith('gym:arm', { harness: 'p', enabled: false });
  });

  it('does NOT write while a budget is merely being typed', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    open('p');
    const input = screen.getByLabelText('Budget for red-queen in USD lifetime');
    await act(async () => {
      fireEvent.change(input, { target: { value: '75' } });
    });
    // A spend control that wrote on change (or on blur) would let a stray
    // focus change alter a budget. Submitting is the decision.
    expect(runAgentTool).not.toHaveBeenCalled();
  });

  it('writes the budget only on Save, with budgetUsd only', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    open('p');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Budget for red-queen in USD lifetime'), {
        target: { value: '75' },
      });
    });
    await act(async () => {
      fireEvent.click(saveIn('lane/red-queen'));
    });
    expect(runAgentTool).toHaveBeenCalledWith('governor:arm', {
      loopId: 'red-queen',
      budgetUsd: 75,
    });
  });

  it('does not offer to "Clear" a budget that is already unset', () => {
    // Observed live on the gym row of an unbudgeted pot: the button read
    // "Clear" beside an empty field, advertising an action that would be a
    // no-op. It was disabled, so it could not misfire — but a control that
    // names an action it is not going to perform is the same class of lie this
    // whole surface exists to avoid.
    H.arming = arming({ lanes: [lane('red-queen', 'p', { budgetUsd: null })] });
    open('p');
    expect(saveIn('lane/red-queen').textContent).toBe('Save');
    expect(saveIn('lane/red-queen').disabled).toBe(true);
  });

  it('treats an emptied box as an explicit CLEAR and says so on the button', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    open('p');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Budget for red-queen in USD lifetime'), {
        target: { value: '' },
      });
    });
    expect(saveIn('lane/red-queen').textContent).toBe('Clear');
    await act(async () => {
      fireEvent.click(saveIn('lane/red-queen'));
    });
    expect(runAgentTool).toHaveBeenCalledWith('governor:arm', {
      loopId: 'red-queen',
      budgetUsd: null,
    });
  });

  it('refuses to submit a value the tool would reject, and says the bounds', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    open('p');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Budget for red-queen in USD lifetime'), {
        target: { value: '-4' },
      });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/between 0 and 100000/);
    expect(saveIn('lane/red-queen').disabled).toBe(true);
  });

  it('surfaces a refusal instead of rendering the old state as if it landed', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    runAgentTool.mockImplementation(async () => {
      throw new Error('governor:arm: no learning-governor lane');
    });
    open('p');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disarm red-queen' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/no learning-governor lane/);
  });
});

describe('the partition survives the render', () => {
  it('shows an unprefixed lane under Other lanes rather than dropping it', () => {
    H.arming = arming({ lanes: [lane('fleet-ekg', 'p'), lane('dream:p', 'p')] });
    open('p');
    const other = screen.getByRole('region', { name: 'Other lanes' });
    expect(other.textContent).toContain('fleet-ekg');
    expect(other.textContent).toContain('dream:p');
  });

  it('renders every lane the pot owns, across sections', () => {
    H.arming = arming({
      lanes: [
        lane('frontier:replay', 'p'),
        lane('blender:p', 'p'),
        lane('red-queen', 'p'),
        lane('dream:p', 'p'),
      ],
    });
    open('p');
    expect(document.querySelectorAll('.pc-potdraw__field[data-key^="lane/"]')).toHaveLength(4);
  });

  it('shows the loop id each control writes by, so a row can be matched to its DB row', () => {
    H.arming = arming({ lanes: [lane('frontier:replay-harness', 'p', { displayName: 'Replay harness' })] });
    open('p');
    expect(screen.getByText('Replay harness')).toBeTruthy();
    expect(screen.getByText('frontier:replay-harness')).toBeTruthy();
  });
});

/** The three scout-cycle budget inputs, by their spelled-out labels. */
const COST = 'Cost cap in USD per cycle';
const IDEATORS = 'Ideators in ideators per cycle';

describe('the scout cycle budget is edited HERE, and the lane row is read-only (D-011)', () => {
  it('renders a field per budget key, with its own unit — not all of them money', () => {
    open('p');
    expect((screen.getByLabelText(COST) as HTMLInputElement).tagName).toBe('INPUT');
    expect(screen.getByLabelText(IDEATORS)).toBeTruthy();
    expect(screen.getByLabelText('Critics per idea in critics per idea')).toBeTruthy();
  });

  it('shows the ENGINE DEFAULT in an unset box, so empty never reads as zero', () => {
    open('p');
    const cost = screen.getByLabelText(COST) as HTMLInputElement;
    expect(cost.value).toBe('');
    expect(cost.placeholder).toBe('1'); // DEFAULT_SCOUT_BUDGET.maxCostUsd
    expect(screen.getByText(/Unset — the engine default of 1 USD per cycle applies/)).toBeTruthy();
  });

  it('renders a stored 0 as a REAL value, not as an unset box', () => {
    // The distinction D-011 turns on, at the surface: `maxCostUsd: 0` is "no
    // spend this cycle", and rendering it as empty would report a hard stop as
    // a default.
    H.overrides = [{ kind: 'config', name: 'budget', value: { maxCostUsd: 0 } }];
    open('p');
    const cost = screen.getByLabelText(COST) as HTMLInputElement;
    expect(cost.value).toBe('0');
    expect(
      (document.querySelector('.pc-potdraw__field[data-key="budget/maxCostUsd"]') as HTMLElement)
        .dataset.set,
    ).toBe('1');
  });

  it('writes the WHOLE budget object, preserving the keys it did not edit', async () => {
    // The endpoint stores one json value per (pot, section), so a write that
    // posted only the edited key would silently clear the other two.
    H.overrides = [
      { kind: 'config', name: 'budget', value: { maxCostUsd: 0.25, maxCriticsPerIdea: 4 } },
    ];
    open('p');
    fireEvent.change(screen.getByLabelText(IDEATORS), { target: { value: '3' } });
    await act(async () => {
      fireEvent.click(saveIn('budget/maxIdeators'));
    });
    expect(setOverride).toHaveBeenCalledWith({
      potSlug: 'p',
      kind: 'config',
      name: 'budget',
      value: { maxCostUsd: 0.25, maxCriticsPerIdea: 4, maxIdeators: 3 },
    });
  });

  it('emptying a box DELETES the key rather than storing a null', async () => {
    // An absent key is what the engine reads as "use the default"; a null would
    // make unset and zero indistinguishable to anything reading the raw config.
    H.overrides = [{ kind: 'config', name: 'budget', value: { maxCostUsd: 5, maxIdeators: 3 } }];
    open('p');
    fireEvent.change(screen.getByLabelText(COST), { target: { value: '' } });
    expect(saveIn('budget/maxCostUsd').textContent).toBe('Reset');
    await act(async () => {
      fireEvent.click(saveIn('budget/maxCostUsd'));
    });
    expect(setOverride).toHaveBeenCalledWith({
      potSlug: 'p',
      kind: 'config',
      name: 'budget',
      value: { maxIdeators: 3 },
    });
  });

  it('does NOT write while a value is merely being typed', () => {
    open('p');
    fireEvent.change(screen.getByLabelText(COST), { target: { value: '2' } });
    expect(setOverride).not.toHaveBeenCalled();
  });

  it('refuses 0 on a COUNT — the engine discards it — while allowing 0 on the cap', () => {
    open('p');
    fireEvent.change(screen.getByLabelText(IDEATORS), { target: { value: '0' } });
    expect(saveIn('budget/maxIdeators').disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(COST), { target: { value: '0' } });
    expect(saveIn('budget/maxCostUsd').disabled).toBe(false);
  });

  it('gives the blender LANE row no controls, and says the config is the real one', () => {
    H.arming = arming({ lanes: [lane('blender:p', 'p')] });
    open('p');
    const row = document.querySelector(
      '.pc-potdraw__field[data-key="lane/blender:p"]',
    ) as HTMLElement;
    expect(row.querySelector('button')).toBeNull();
    expect(row.textContent).toMatch(/rewrites this row/i);
  });

  it('offers the budget for a pot with NO blender lane, and still says it has none', () => {
    open('p');
    const blender = screen.getByRole('region', { name: 'Blender' });
    expect(blender.textContent).toMatch(/no blender: lane/i);
    expect(blender.querySelectorAll('.pc-potdraw__cfg input')).toHaveLength(3);
  });

  it('surfaces a refused write instead of rendering as if it landed', async () => {
    setOverride.mockImplementation(async () => {
      throw new Error('pot not found');
    });
    open('p');
    fireEvent.change(screen.getByLabelText(COST), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(saveIn('budget/maxCostUsd'));
    });
    expect(screen.getByRole('alert').textContent).toContain('pot not found');
  });
});
