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

const H = vi.hoisted(() => ({ arming: null as AutomationArming | null }));

vi.mock('@papercusp/sync', () => ({
  // Not decoration — useLexicon reaches flag-hooks, which subscribes to the
  // sync bus during render; omitting it throws mid-render and reports as a
  // failed FILE while individual assertions still say they passed.
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    const invalidate = vi.fn();
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

beforeEach(() => {
  H.arming = arming();
  runAgentTool.mockClear();
  runAgentTool.mockImplementation(async () => {});
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
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
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
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('treats an emptied box as an explicit CLEAR and says so on the button', async () => {
    H.arming = arming({ lanes: [lane('red-queen', 'p')] });
    open('p');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Budget for red-queen in USD lifetime'), {
        target: { value: '' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
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
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
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
