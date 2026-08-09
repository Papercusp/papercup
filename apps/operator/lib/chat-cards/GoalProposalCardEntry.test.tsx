// @vitest-environment jsdom
/**
 * GoalProposalCardEntry.test.tsx — coverage for the registry-side glue that
 * wires `goals:propose` into the chat-card registry (goal-mode-2026-08-07
 * P-022, ruling D-024).
 *
 * Three properties are load-bearing and each has a specific way of failing
 * SILENTLY, which is why they are asserted rather than assumed:
 *
 *  1. The card is registered under the CANONICAL colon name, but a live su
 *     session's transcript carries the MCP-mangled form
 *     (`mcp__papercusp-su__goals_propose`). A miss there is invisible — the
 *     call falls through to the default tool chip and the goal is narrated in
 *     prose instead of confirmed, i.e. exactly the pre-P-022 behaviour, with
 *     no error anywhere.
 *  2. Malformed args must yield `null` (fall through to the chip), never a
 *     card with blank required fields — a blank confirm card IS the blank form
 *     P-022 exists to remove.
 *  3. The workspace must come from `useWorkspaceId`, not a default. Writing a
 *     goal into the wrong tenant is the failure GoalTab documents (WI-5125:
 *     181 rows invisible because a read was pointed at the wrong tenant and
 *     merely looked empty).
 *
 * `GoalProposalCard` is stubbed to a marker so this file asserts the ENTRY's
 * logic — validation, name resolution, workspace bridge — and not the card's
 * internals, which GoalProposalCard.test.tsx already covers.
 *
 * NOTE: apps/operator registers NO jest-dom matchers (`toHaveTextContent` &c
 * fail as "Invalid Chai property"). Assert the DOM directly, as
 * AskChoiceCardEntry.test.tsx does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-from-hook',
}));

// Stub the card so the entry's validation + prop bridge is what's under test.
vi.mock('@/app/_components/chat/GoalProposalCard', () => ({
  GoalProposalCard: ({
    args,
    workspaceId,
  }: {
    args: { title: string; relationship: { kind: string } };
    workspaceId: string;
  }) => (
    <div
      data-testid="card"
      data-workspace={workspaceId}
      data-kind={args.relationship.kind}
    >
      {args.title}
    </div>
  ),
}));

// Importing the entry registers the card as a side effect.
import './GoalProposalCardEntry';
import { isGoalProposalArgs } from './GoalProposalCardEntry';
import { renderCard } from './registry';

afterEach(cleanup);

function validArgs(over: Record<string, unknown> = {}) {
  return {
    title: 'Ship the App Store build',
    killCriterion: 'No TestFlight build accepted by 2026-09-01',
    budgetCents: 250_000,
    relationship: { kind: 'new-top-level' },
    ...over,
  };
}

function renderResult(node: ReactNode | null) {
  return render(<>{node}</>);
}

describe('GoalProposalCardEntry (goals:propose registry glue)', () => {
  it('registers a renderer under the canonical goals:propose name', () => {
    const node = renderCard('goals:propose', { args: validArgs(), onAnswer: vi.fn() });
    expect(node).toBeTruthy();
  });

  it('resolves the MCP-mangled transcript name a live su session actually carries', () => {
    // The one that silently degrades to a tool chip if unmangling regresses.
    const node = renderCard('mcp__papercusp-su__goals_propose', {
      args: validArgs(),
      onAnswer: vi.fn(),
    });
    expect(node).toBeTruthy();
    renderResult(node);
    expect(screen.getByTestId('card').textContent).toBe('Ship the App Store build');
  });

  it('does not resolve an unrelated mangled name', () => {
    expect(
      renderCard('mcp__papercusp-su__goals_create', { args: validArgs(), onAnswer: vi.fn() }),
    ).toBeNull();
  });

  it('passes the hook-resolved workspace to the card rather than a default', () => {
    const node = renderCard('goals:propose', { args: validArgs(), onAnswer: vi.fn() });
    renderResult(node);
    expect(screen.getByTestId('card').getAttribute('data-workspace')).toBe('ws-from-hook');
  });

  it('passes the proposal args through unchanged', () => {
    const node = renderCard('goals:propose', {
      args: validArgs({ relationship: { kind: 'sub-goal', ref: 'GOAL-7' } }),
      onAnswer: vi.fn(),
    });
    renderResult(node);
    expect(screen.getByTestId('card').getAttribute('data-kind')).toBe('sub-goal');
  });

  it('returns null when args is missing or not an object', () => {
    expect(renderCard('goals:propose', { args: undefined, onAnswer: vi.fn() })).toBeNull();
    expect(renderCard('goals:propose', { args: 'nope', onAnswer: vi.fn() })).toBeNull();
    expect(renderCard('goals:propose', { args: null, onAnswer: vi.fn() })).toBeNull();
  });

  it('returns null when the title is missing or blank', () => {
    expect(
      renderCard('goals:propose', { args: validArgs({ title: undefined }), onAnswer: vi.fn() }),
    ).toBeNull();
    expect(
      renderCard('goals:propose', { args: validArgs({ title: '   ' }), onAnswer: vi.fn() }),
    ).toBeNull();
  });

  it('returns null when the kill criterion is missing or blank', () => {
    // The kill criterion + ceiling are the two fields a blank form degrades
    // most (they are the only ones that can ever STOP a goal), so a proposal
    // without one must not render as a confirmable card.
    expect(
      renderCard('goals:propose', {
        args: validArgs({ killCriterion: undefined }),
        onAnswer: vi.fn(),
      }),
    ).toBeNull();
    expect(
      renderCard('goals:propose', { args: validArgs({ killCriterion: '' }), onAnswer: vi.fn() }),
    ).toBeNull();
  });

  it('returns null when the budget ceiling is absent or not a finite number', () => {
    for (const budgetCents of [undefined, '250000', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        renderCard('goals:propose', { args: validArgs({ budgetCents }), onAnswer: vi.fn() }),
      ).toBeNull();
    }
  });

  it('returns null when the relationship is absent or has no kind', () => {
    expect(
      renderCard('goals:propose', {
        args: validArgs({ relationship: undefined }),
        onAnswer: vi.fn(),
      }),
    ).toBeNull();
    expect(
      renderCard('goals:propose', { args: validArgs({ relationship: {} }), onAnswer: vi.fn() }),
    ).toBeNull();
    expect(
      renderCard('goals:propose', {
        args: validArgs({ relationship: 'sub-goal' }),
        onAnswer: vi.fn(),
      }),
    ).toBeNull();
  });

  it('accepts a zero ceiling — 0 is a real answer, and a falsy-check would reject it', () => {
    expect(isGoalProposalArgs(validArgs({ budgetCents: 0 }))).toBe(true);
  });
});
