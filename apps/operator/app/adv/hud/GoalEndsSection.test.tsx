// @vitest-environment jsdom
/**
 * GoalEndsSection behaviour (goals-tab-improvement-2026-08-09 P-009).
 *
 * The item's whole point is that the panel's loudest alarm stops being a dead
 * end, so the claims worth pinning are the ones where a plausible
 * implementation is silently wrong rather than visibly broken:
 *
 *   1. The editor seeds from the STORED criterion, never from the rendered
 *      line. When none is set, `killCriterionLine` returns alarm PROSE ("No
 *      kill criterion was set — nothing can stop this goal…"), and that prose
 *      is long enough and placeholder-free enough to PASS the shared rule. An
 *      editor seeded from what it displays would therefore offer the alarm
 *      itself as the criterion, and Save would accept it — a goal "fixed" with
 *      a criterion that is a description of its own absence.
 *   2. A refused criterion never reaches the network. The shared rule is the
 *      server's, and the server still has the last word, but a stub that costs
 *      a round-trip to reject reads as a flaky save rather than a refusal.
 *   3. The write is PARTIAL. `goals:update` merges, which is the only reason it
 *      is safe to save one field from a section that displays two; a patch that
 *      also carried the other one would let saving a criterion overwrite a
 *      ceiling a peer changed a second earlier.
 *   4. `degraded: true` is not success. It is HTTP 200, and it is how the
 *      server's own copy of the criterion rule comes back — so a flattened
 *      "saved" would close the editor over an unchanged row and leave the alarm
 *      standing with no explanation.
 *   5. Blank means different things on the two halves, and each has to be the
 *      thing the button says. The criterion cannot be cleared here BY
 *      JUDGEMENT, so blank is a refusal. The ceiling CAN be (its `budgetCents`
 *      became nullable in EI-20072247655456262), so blank REMOVES it — and
 *      offers that Save only when there is a ceiling to remove, or it would
 *      report a removal that removed nothing.
 *
 * Every negative is paired with a positive control, per the note in
 * GoalStatusControl.test.tsx: an absence assertion in jsdom passes for reasons
 * that have nothing to do with the design unless something proves the thing CAN
 * happen.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* Same local stand-in the sibling suites use — a real adapter would drag the
   router in for a param whose only job here is to say which editor is open. */
vi.mock('nuqs', async () => {
  const React = await import('react');
  const parser = <T,>() => ({
    withDefault(defaultValue: T) {
      return { defaultValue };
    },
  });
  return {
    parseAsBoolean: parser<boolean>(),
    parseAsString: parser<string>(),
    parseAsStringEnum: <T,>(_values: readonly T[]) => parser<T>(),
    useQueryState(_key: string, p?: { defaultValue?: unknown }) {
      /* Explicit <unknown>: inferring from `p?.defaultValue ?? null` widens the
         state to `{} | null`, and the setter then rejects the `unknown` it is
         handed (TS2345) — invisible to vitest, which does not typecheck. */
      const [value, setValue] = React.useState<unknown>(p?.defaultValue ?? null);
      const set = React.useCallback(
        (next: unknown) => {
          setValue(typeof next === 'function' ? (next as (prev: unknown) => unknown)(value) : next);
          return Promise.resolve(new URLSearchParams());
        },
        [value],
      );
      return [value, set];
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';
import { ceilingLine, killCriterionLine } from './goal-detail-model';
import GoalEndsSection from './GoalEndsSection';

const fetchMock = vi.fn();

function reply(body: Record<string, unknown>, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(reply({ data: {} }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(cleanup);

const REAL_CRITERION = 'Stop if no paying user by day 30.';

/**
 * Renders with the REAL display derivations rather than hand-written line
 * objects, so a test about the editor cannot disagree with what the panel
 * actually shows — which is precisely the seam claim 1 is about.
 */
function renderEnds(
  over: { killCriterion?: string | null; budgetCents?: number | null; goalId?: string | null } = {},
) {
  const goal = {
    id: 'goal-1',
    title: 'g',
    status: 'active',
    killCriterion: 'killCriterion' in over ? (over.killCriterion ?? null) : REAL_CRITERION,
    budgetCents: 'budgetCents' in over ? (over.budgetCents ?? null) : 50_000,
    spendUsd: 310,
  };
  return render(
    <GoalEndsSection
      goalId={'goalId' in over ? (over.goalId ?? null) : 'goal-1'}
      killCriterion={goal.killCriterion}
      budgetCents={goal.budgetCents}
      criterion={killCriterionLine(goal)}
      ceiling={ceilingLine(goal)}
      burn={null}
      spendLabel="fleet spend"
      spendNote={null}
    />,
  );
}

/** The JSON body of the Nth (default: only) write, as the route received it. */
function writtenBody(n = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[n];
  return JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>;
}

describe('the alarm carries its remedy', () => {
  it('offers to SET a criterion when none is written, and to EDIT one when there is', () => {
    renderEnds({ killCriterion: null });
    const set = screen.getByTestId('goal-criterion-edit');
    expect(set.textContent).toBe('Set a kill criterion');
    // Prominent, not a quiet link: this state is the reason the control exists.
    expect(set.className).toBe('hud-goal__addsub-go');
    expect(screen.getByTestId('goal-kill-criterion').className).toContain(
      'hud-goal__criterion--missing',
    );

    cleanup();
    renderEnds();
    expect(screen.getByTestId('goal-criterion-edit').textContent).toBe('Edit criterion');
  });

  it('offers no editors at all without a goal id — there is nothing to write to', () => {
    renderEnds({ goalId: null });
    expect(screen.queryByTestId('goal-criterion-edit')).toBeNull();
    expect(screen.queryByTestId('goal-ceiling-edit')).toBeNull();
    // Paired control: the same render WITH an id offers both.
    cleanup();
    renderEnds();
    expect(screen.getByTestId('goal-criterion-edit')).toBeTruthy();
    expect(screen.getByTestId('goal-ceiling-edit')).toBeTruthy();
  });
});

describe('seeding', () => {
  it('seeds an EMPTY field when no criterion is set — never the alarm prose', () => {
    // The trap this pins: the displayed line is "No kill criterion was set —
    // nothing can stop this goal. Ask the agent to set one." — 84 chars with no
    // placeholder opener, so the shared rule ACCEPTS it. Seeding from the
    // display would let Save write the alarm as the criterion.
    renderEnds({ killCriterion: null });
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    const input = screen.getByTestId('goal-criterion-input') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(screen.getByTestId('goal-criterion-save')).toHaveProperty('disabled', true);
  });

  it('seeds the STORED criterion when one exists, so an edit starts from the text', () => {
    renderEnds();
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    expect((screen.getByTestId('goal-criterion-input') as HTMLTextAreaElement).value).toBe(
      REAL_CRITERION,
    );
  });

  it('seeds the ceiling in DOLLARS from cents', () => {
    renderEnds({ budgetCents: 125_050 });
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    expect((screen.getByTestId('goal-ceiling-input') as HTMLInputElement).value).toBe('1250.50');
  });
});

describe('the criterion write', () => {
  it('refuses a stub with the SHARED message and never reaches the network', async () => {
    renderEnds({ killCriterion: null });
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    fireEvent.change(screen.getByTestId('goal-criterion-input'), { target: { value: 'no sales' } });
    fireEvent.click(screen.getByTestId('goal-criterion-save'));

    await waitFor(() => expect(screen.getByTestId('goal-criterion-problem')).toBeTruthy());
    expect(screen.getByTestId('goal-criterion-problem').textContent).toMatch(
      /states no abandonment condition/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // Paired control: a real criterion from the SAME editor does reach it.
    fireEvent.change(screen.getByTestId('goal-criterion-input'), {
      target: { value: 'nobody buys it by day 30' },
    });
    fireEvent.click(screen.getByTestId('goal-criterion-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('writes ONLY the criterion — a partial patch, so it cannot clobber the ceiling', async () => {
    renderEnds({ killCriterion: null });
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    fireEvent.change(screen.getByTestId('goal-criterion-input'), {
      target: { value: '  nobody buys it by day 30  ' },
    });
    fireEvent.click(screen.getByTestId('goal-criterion-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/goals/update');
    expect(writtenBody()).toEqual({ id: 'goal-1', killCriterion: 'nobody buys it by day 30' });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Closed on success — the panel re-reads from the invalidated query.
    await waitFor(() => expect(screen.queryByTestId('goal-criterion-editor')).toBeNull());
  });

  it('keeps the editor OPEN on a degraded 200 and shows the server reason', async () => {
    fetchMock.mockResolvedValue(
      reply({ data: null, degraded: true, degradedReasons: ['killCriterion states no abandonment condition'] }),
    );
    renderEnds({ killCriterion: null });
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    fireEvent.change(screen.getByTestId('goal-criterion-input'), {
      target: { value: 'nobody buys it by day 30' },
    });
    fireEvent.click(screen.getByTestId('goal-criterion-save'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(screen.getByTestId('goal-criterion-editor')).toBeTruthy();
    expect(screen.getByTestId('goal-criterion-problem').textContent).toMatch(
      /no abandonment condition/,
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('keeps the editor open and surfaces the reason when the write FAILS', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { message: 'goal is closed' } }, { ok: false, status: 409 }),
    );
    renderEnds({ killCriterion: null });
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    fireEvent.change(screen.getByTestId('goal-criterion-input'), {
      target: { value: 'nobody buys it by day 30' },
    });
    fireEvent.click(screen.getByTestId('goal-criterion-save'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByTestId('goal-criterion-editor')).toBeTruthy();
    expect(screen.getByTestId('goal-criterion-problem').textContent).toMatch(/goal is closed/);
  });
});

describe('the ceiling write', () => {
  it('writes CENTS, from dollars the owner typed', async () => {
    renderEnds({ budgetCents: null });
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: '$1,250.50' } });
    fireEvent.click(screen.getByTestId('goal-ceiling-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(writtenBody()).toEqual({ id: 'goal-1', budgetCents: 125_050 });
  });

  it('refuses a non-amount before the network, and says what it wanted', async () => {
    renderEnds();
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: '1e9' } });
    fireEvent.click(screen.getByTestId('goal-ceiling-save'));

    await waitFor(() => expect(screen.getByTestId('goal-ceiling-problem')).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends budgetCents:null for a blank field — the removal, not an omission', async () => {
    // The assertion that matters is `toEqual`, not a key check: an omitted
    // budgetCents is what `goals:update` reads as "leave unchanged", so a body
    // of `{ id }` alone would close the editor having removed nothing.
    renderEnds({ budgetCents: 50_000 });
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: '' } });
    expect(screen.getByTestId('goal-ceiling-save')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('goal-ceiling-save').textContent).toContain('Remove');
    fireEvent.click(screen.getByTestId('goal-ceiling-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(writtenBody()).toEqual({ id: 'goal-1', budgetCents: null });
  });

  it('offers no Save over a blank field when there is no ceiling to remove', () => {
    renderEnds({ budgetCents: null });
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: '' } });
    expect(screen.getByTestId('goal-ceiling-save')).toHaveProperty('disabled', true);
    // Paired control: a first amount DOES enable it, so the disabled state
    // above is the blank rule and not a Save that never enables at all.
    fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: '600' } });
    expect(screen.getByTestId('goal-ceiling-save')).toHaveProperty('disabled', false);
  });

  it('offers no Save for a re-typed identical ceiling ($500 == 500 == 500.00)', () => {
    renderEnds({ budgetCents: 50_000 });
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    for (const same of ['500', '$500', '500.00']) {
      fireEvent.change(screen.getByTestId('goal-ceiling-input'), { target: { value: same } });
      expect(screen.getByTestId('goal-ceiling-save')).toHaveProperty('disabled', true);
    }
  });
});

describe('the two editors are alternatives, not independent toggles', () => {
  it('opening the ceiling closes the criterion editor', () => {
    renderEnds();
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    expect(screen.getByTestId('goal-criterion-editor')).toBeTruthy();
    fireEvent.click(screen.getByTestId('goal-ceiling-edit'));
    expect(screen.queryByTestId('goal-criterion-editor')).toBeNull();
    expect(screen.getByTestId('goal-ceiling-editor')).toBeTruthy();
  });

  it('Cancel restores the display without writing', () => {
    renderEnds();
    fireEvent.click(screen.getByTestId('goal-criterion-edit'));
    fireEvent.click(screen.getByTestId('goal-criterion-cancel'));
    expect(screen.queryByTestId('goal-criterion-editor')).toBeNull();
    expect(screen.getByTestId('goal-kill-criterion').textContent).toBe(REAL_CRITERION);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
