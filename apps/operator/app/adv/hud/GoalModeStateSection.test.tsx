// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import GoalModeStateSection from './GoalModeStateSection';
import type { GoalModeStateInput } from './goal-detail-model';

afterEach(cleanup);

function known(over: Partial<GoalModeStateInput> = {}): GoalModeStateInput {
  return {
    schemaVersion: 'agent-goal-mode-state-v1',
    status: 'known',
    ownerId: 'su-goal',
    observedAt: '2026-09-06T00:00:00.000Z',
    portfolio: {
      goal: { id: 'goal-1', title: 'Ship it', status: 'active' },
      queue: { total: 4, inFlight: 1, blocked: 1, needsHuman: 0, claimable: 2 },
      priorities: ['finish the current plan'],
    },
    obligations: {
      evaluatedAt: '2026-09-06T00:00:00.000Z',
      sourceGeneration: 'agenda-generation',
      projection: {
        entries: [],
        receipt: {
          sink: 'turn-start',
          entriesAvailable: 0,
          entriesDelivered: 0,
          entriesOmitted: 0,
          bodyTruncated: false,
          refused: false,
        },
      },
      detailRef: 'coord:orient for the complete obligation agenda',
    },
    degradedReasons: [],
    ...over,
  };
}

describe('GoalModeStateSection', () => {
  it('renders the same server-selected obligation fields and delivery overflow', () => {
    render(
      <GoalModeStateSection
        state={known({
          obligations: {
            sourceGeneration: 'agenda-generation',
            projection: {
              entries: [
                {
                  id: 'obligation-1',
                  title: 'Independent verification',
                  status: 'due',
                  applicableDemand: 2,
                  sourceGeneration: 'rule-generation',
                  dueAt: '2026-09-06T00:30:00.000Z',
                  ageMs: 120_000,
                  reason: 'acceptance evidence is missing',
                  action: { summary: 'Run independent acceptance' },
                },
              ],
              receipt: {
                sink: 'turn-start',
                entriesAvailable: 4,
                entriesDelivered: 1,
                entriesOmitted: 3,
                bodyTruncated: true,
                refused: false,
                reason: 'entry-cap',
              },
            },
            detailRef: 'coord:orient for the complete obligation agenda',
          },
        })}
      />,
    );

    expect(screen.getByTestId('goal-mode-state').getAttribute('data-status')).toBe('known');
    expect(screen.getByText('Independent verification')).toBeTruthy();
    expect(screen.getByTestId('goal-mode-primary-action').textContent).toContain('Run independent acceptance');
    expect(screen.getByTestId('goal-mode-obligation').textContent).toContain(
      'demand 2 · due 2026-09-06T00:30:00.000Z · age 2m · source rule-generation',
    );
    expect(screen.getByTestId('goal-mode-omissions').textContent).toContain(
      'Showing 1 of 4 primary obligations; 3 omitted (entry-cap).',
    );
    expect(screen.getByTestId('goal-mode-provenance').textContent).toContain('agenda agenda-generation');
    expect(screen.getByTestId('goal-mode-detail-ref').textContent).toContain(
      'coord:orient for the complete obligation agenda',
    );
  });

  it('renders measured no-demand as quiet empty state', () => {
    render(<GoalModeStateSection state={known()} />);
    expect(screen.getByTestId('goal-mode-no-demand').textContent).toContain('No obligation is due');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders degraded and provider measurement failures explicitly', () => {
    render(
      <GoalModeStateSection
        state={known({
          status: 'degraded',
          degradedReasons: ['goal portfolio timed out'],
          obligations: {
            sourceGeneration: 'degraded-generation',
            projection: {
              entries: [
                {
                  id: 'obligation-unknown',
                  title: 'Plan placement',
                  status: 'unknown',
                  applicableDemand: 0,
                  sourceGeneration: 'source-unknown',
                  measurementFailure: {
                    code: 'canonical-plan-placement-read-failed',
                    detail: 'portfolio unavailable',
                    retry: 'refresh the portfolio',
                  },
                },
              ],
              receipt: { entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0 },
            },
            detailRef: 'coord:orient',
          },
        })}
      />,
    );

    expect(screen.getByTestId('goal-mode-degraded').textContent).toContain('goal portfolio timed out');
    expect(screen.getByTestId('goal-mode-measurement-failure').textContent).toContain(
      'canonical-plan-placement-read-failed',
    );
    expect(screen.getByTestId('goal-mode-measurement-failure').textContent).toContain('refresh the portfolio');
  });

  it('never turns missing state or an all-omitted delivery into no-demand', () => {
    const { rerender } = render(<GoalModeStateSection />);
    expect(screen.getByTestId('goal-mode-unknown').textContent).toContain('not included');
    expect(screen.getByTestId('goal-mode-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('goal-mode-no-demand')).toBeNull();

    rerender(
      <GoalModeStateSection
        state={known({
          obligations: {
            sourceGeneration: 'overflow-generation',
            projection: {
              entries: [],
              receipt: {
                entriesAvailable: 2,
                entriesDelivered: 0,
                entriesOmitted: 2,
                bodyTruncated: true,
                refused: false,
                reason: 'character-cap',
              },
            },
            detailRef: 'coord:orient',
          },
        })}
      />,
    );
    expect(screen.getByTestId('goal-mode-overflow-empty')).toBeTruthy();
    expect(screen.getByTestId('goal-mode-omissions').textContent).toContain('2 omitted');
    expect(screen.queryByTestId('goal-mode-no-demand')).toBeNull();
  });
});
