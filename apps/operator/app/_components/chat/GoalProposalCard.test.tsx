// @vitest-environment jsdom
/**
 * GoalProposalCard tests (goal-mode-2026-08-07 P-022).
 *
 * WHAT THESE DELIBERATELY POLICE. This card's whole reason to exist is that the
 * owner's EDITS reach `goals:create`. A card that renders the proposal
 * beautifully and then posts the agent's original values would look perfect and
 * be worthless, so most of what follows drives the inputs and asserts the
 * PAYLOAD — not the pixels.
 *
 * Two silent-wrong-result risks get their own cases:
 *   - `parentId` is set for a sub-goal and NOT for a sibling. A sub-goal filed
 *     without it silently becomes a top-level goal that looks correct.
 *   - `plan-in-existing-pot` offers NO create button at all, because creating a
 *     goal there is the one thing GOAL mode's contract forbids.
 *
 * The `createGoal` injection is asserted for its ARGS only; the endpoint itself
 * was verified live against :3170 (D-024) rather than mocked into passing here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

// The relationship control is the shared `Select` primitive (a Radix listbox —
// design-primitives allowlists ZERO native <select>s). Radix's popup does not
// open under jsdom, so stand in a native <select> carrying the SAME testId and
// the same value/onChange contract. This is the house pattern for the primitive
// (PlanActions, PlanFilters, LiveMetricsTab, MemoryTab all do it) and it keeps
// these cases pointed at what they exist to police — that the owner's edits
// reach the `goals:create` payload — rather than at Radix's internals, which
// harness/Select.test.tsx covers directly.
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    testId,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: React.ReactNode }[];
    testId?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {String(o.label)}
        </option>
      ))}
    </select>
  ),
}));

afterEach(() => cleanup());

import {
  GoalProposalCard,
  buildCreatePayload,
  centsToUsdInput,
  usdInputToCents,
  type GoalProposalArgs,
} from './GoalProposalCard';

const baseArgs: GoalProposalArgs = {
  title: 'Ship a paid iOS app',
  body: 'One app, live on the App Store, with at least one paying customer.',
  killCriterion: 'Kill if 30 days pass with no shipped build, or spend passes $500.',
  budgetCents: 50_000,
  relationship: {
    kind: 'new-top-level',
    why: 'Nothing in the portfolio targets a paid app — the closest pot is the reading-list tool.',
  },
};

const renderCard = (
  overrides: Partial<GoalProposalArgs> = {},
  createGoal = vi.fn().mockResolvedValue({ ok: true, id: 'ship-a-paid-ios-app-ab12cd' }),
) => {
  const args = { ...baseArgs, ...overrides } as GoalProposalArgs;
  render(<GoalProposalCard args={args} workspaceId="papercusp-workspace" createGoal={createGoal} />);
  return createGoal;
};

// This app registers NO jest-dom matchers (verified: zero uses across the chat
// tests, and `toHaveTextContent` fails as "Invalid Chai property"), so these
// assertions read the DOM directly — the same convention AskChoiceCard.test.tsx
// uses. Typed accessors keep that from being verbose.
const createBtn = () => screen.getByTestId('goal-proposal-create') as HTMLButtonElement;
const field = (id: string) => screen.getByTestId(id) as HTMLInputElement | HTMLTextAreaElement;
const text = (id: string) => screen.getByTestId(id).textContent ?? '';

describe('ceiling parsing', () => {
  it('round-trips cents through the dollar field', () => {
    expect(centsToUsdInput(50_000)).toBe('500.00');
    expect(usdInputToCents('500.00')).toBe(50_000);
    expect(usdInputToCents('$1,250.50')).toBe(125_050);
  });

  // null, never 0: a ceiling that silently becomes $0 reads as "unbudgeted"
  // downstream, and the ceiling is one of the two things that can stop a goal.
  it('rejects unusable figures as null rather than coercing them to zero', () => {
    expect(usdInputToCents('')).toBeNull();
    expect(usdInputToCents('   ')).toBeNull();
    expect(usdInputToCents('abc')).toBeNull();
    expect(usdInputToCents('-5')).toBeNull();
    expect(usdInputToCents('0')).toBe(0);
  });
});

describe('buildCreatePayload', () => {
  it('carries parentId for a sub-goal', () => {
    const p = buildCreatePayload({
      title: 'T',
      killCriterion: 'C',
      budgetCents: 100,
      kind: 'sub-goal',
      ref: 'parent-goal-9f',
    });
    expect(p.parentId).toBe('parent-goal-9f');
  });

  it('does NOT carry parentId for a sibling — a sibling shares projects, not a parent', () => {
    const p = buildCreatePayload({
      title: 'T',
      killCriterion: 'C',
      budgetCents: 100,
      kind: 'sibling-goal',
      ref: 'other-goal-4a',
    });
    expect(p.parentId).toBeUndefined();
  });

  it('omits an empty body instead of sending a blank string', () => {
    const p = buildCreatePayload({
      title: 'T',
      body: '   ',
      killCriterion: 'C',
      budgetCents: 100,
      kind: 'new-top-level',
    });
    expect(p.body).toBeUndefined();
  });
});

describe('GoalProposalCard', () => {
  it('arrives PRE-FILLED with the agent proposal — not blank', () => {
    renderCard();
    expect(field('goal-proposal-title').value).toBe('Ship a paid iOS app');
    expect(field('goal-proposal-criterion').value).toBe(baseArgs.killCriterion);
    expect(field('goal-proposal-ceiling').value).toBe('500.00');
    expect(text('goal-proposal-why')).toMatch(/nothing in the portfolio/i);
  });

  it("sends the OWNER'S EDITS, not the agent's original values", async () => {
    const createGoal = renderCard();
    fireEvent.change(screen.getByTestId('goal-proposal-title'), {
      target: { value: 'Ship a paid iPad app' },
    });
    fireEvent.change(screen.getByTestId('goal-proposal-criterion'), {
      target: { value: 'Kill if 14 days pass with no paying customer.' },
    });
    fireEvent.change(screen.getByTestId('goal-proposal-ceiling'), { target: { value: '250' } });
    fireEvent.click(createBtn());

    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(1));
    expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Ship a paid iPad app',
        killCriterion: 'Kill if 14 days pass with no paying customer.',
        budgetCents: 25_000,
      }),
    );
  });

  it('maps a sub-goal ref onto parentId through the UI', async () => {
    const createGoal = renderCard({
      relationship: { kind: 'sub-goal', ref: 'ship-app-7c', why: 'Only matters because the app does.' },
    });
    fireEvent.click(createBtn());
    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(1));
    expect(createGoal.mock.calls[0]?.[0]).toMatchObject({ parentId: 'ship-app-7c' });
  });

  it('offers NO create button for plan-in-existing-pot — that is a plan, not a goal', () => {
    renderCard({
      relationship: {
        kind: 'plan-in-existing-pot',
        ref: 'ship-app-7c',
        why: 'Releasing to the App Store is a step in shipping the app.',
      },
    });
    expect(screen.queryByTestId('goal-proposal-create')).toBeNull();
    expect(text('goal-proposal-notagoal')).toMatch(/no goal to create/i);
  });

  it('switching the relationship to plan-in-existing-pot withdraws the button', () => {
    renderCard();
    expect(screen.queryByTestId('goal-proposal-create')).not.toBeNull();
    fireEvent.change(screen.getByTestId('goal-proposal-kind'), {
      target: { value: 'plan-in-existing-pot' },
    });
    expect(screen.queryByTestId('goal-proposal-create')).toBeNull();
  });

  it('blocks the create when the criterion is emptied — the goal could never stop', () => {
    const createGoal = renderCard();
    fireEvent.change(screen.getByTestId('goal-proposal-criterion'), { target: { value: '  ' } });
    expect(createBtn().disabled).toBe(true);
    expect(text('goal-proposal-blocked')).toMatch(/kill criterion/i);
    fireEvent.click(createBtn());
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('blocks the create when the ceiling is not a usable figure', () => {
    renderCard();
    fireEvent.change(screen.getByTestId('goal-proposal-ceiling'), { target: { value: 'lots' } });
    expect(createBtn().disabled).toBe(true);
    expect(text('goal-proposal-blocked')).toMatch(/ceiling/i);
  });

  it('requires the ref for any kind that names an existing thing', () => {
    renderCard({ relationship: { kind: 'sub-goal', why: 'w' } });
    expect(createBtn().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('goal-proposal-ref'), { target: { value: 'parent-1a' } });
    expect(createBtn().disabled).toBe(false);
  });

  it('reports the created id instead of leaving the form live', async () => {
    renderCard();
    fireEvent.click(createBtn());
    await waitFor(() =>
      expect(screen.getByTestId('goal-proposal-card').getAttribute('data-created')).toBe('true'),
    );
    expect(text('goal-proposal-card')).toContain('ship-a-paid-ios-app-ab12cd');
  });

  // A failed create must SAY so and leave the values editable — the owner has
  // just typed a criterion and a ceiling, and losing them to a silent failure
  // is the worst outcome on this surface.
  it('surfaces a failed create and keeps the fields editable', async () => {
    renderCard({}, vi.fn().mockResolvedValue({ ok: false, error: 'unknown_workspace' }));
    fireEvent.click(createBtn());
    await waitFor(() =>
      expect(text('goal-proposal-error')).toContain('unknown_workspace'),
    );
    expect(field('goal-proposal-title').value).toBe('Ship a paid iOS app');
  });

  it('surfaces a THROWN create rather than hanging on "Creating…"', async () => {
    renderCard({}, vi.fn().mockRejectedValue(new Error('network down')));
    fireEvent.click(createBtn());
    await waitFor(() =>
      expect(text('goal-proposal-error')).toContain('network down'),
    );
    expect(createBtn().disabled).toBe(false);
  });
});
