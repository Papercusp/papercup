/**
 * @vitest-environment jsdom
 *
 * ActivityFeedCard — P-073b tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  ActivityFeedCard,
  type ActivityFeedEvent,
} from '../ActivityFeedCard';

afterEach(() => {
  cleanup();
});

function ev(
  id: string,
  overrides: Partial<ActivityFeedEvent> = {},
): ActivityFeedEvent {
  return {
    id,
    kind: 'feature_shipped',
    text: `did ${id}`,
    actorLogin: 'alice',
    whenLabel: '5m ago',
    href: null,
    ...overrides,
  };
}

describe('ActivityFeedCard — P-073b', () => {
  it('empty state when no events', () => {
    render(<ActivityFeedCard events={[]} />);
    expect(screen.getByTestId('activity-feed-empty').textContent).toContain(
      'No activity yet',
    );
  });

  it('renders rows in order', () => {
    render(
      <ActivityFeedCard
        events={[ev('e1'), ev('e2'), ev('e3')]}
      />,
    );
    expect(screen.getByTestId('activity-row-e1')).toBeTruthy();
    expect(screen.getByTestId('activity-row-e2')).toBeTruthy();
    expect(screen.getByTestId('activity-row-e3')).toBeTruthy();
  });

  it('labels tier A for pr_merged', () => {
    render(<ActivityFeedCard events={[ev('e1', { kind: 'pr_merged' })]} />);
    expect(screen.getByTestId('activity-row-tier-e1').textContent).toBe('A');
  });

  it('labels tier B for feature_shipped', () => {
    render(
      <ActivityFeedCard
        events={[ev('e1', { kind: 'feature_shipped' })]}
      />,
    );
    expect(screen.getByTestId('activity-row-tier-e1').textContent).toBe('B');
  });

  it('labels tier C for contributor_joined / decision_added / escalation_opened', () => {
    render(
      <ActivityFeedCard
        events={[
          ev('e1', { kind: 'contributor_joined' }),
          ev('e2', { kind: 'decision_added' }),
          ev('e3', { kind: 'escalation_opened' }),
        ]}
      />,
    );
    expect(screen.getByTestId('activity-row-tier-e1').textContent).toBe('C');
    expect(screen.getByTestId('activity-row-tier-e2').textContent).toBe('C');
    expect(screen.getByTestId('activity-row-tier-e3').textContent).toBe('C');
  });

  it('renders as <a> when href set, <div> otherwise', () => {
    render(
      <ActivityFeedCard
        events={[
          ev('a', { href: '/x' }),
          ev('b', { href: null }),
        ]}
      />,
    );
    const a = screen.getByTestId('activity-row-a');
    const b = screen.getByTestId('activity-row-b');
    expect(a.tagName.toLowerCase()).toBe('a');
    expect(b.tagName.toLowerCase()).toBe('div');
    expect((a as HTMLAnchorElement).getAttribute('href')).toBe('/x');
  });

  it('truncates to maxRows', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev(`e${i + 1}`));
    render(<ActivityFeedCard events={events} maxRows={10} />);
    expect(screen.getByTestId('activity-row-e10')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-e11')).toBeNull();
  });

  it('default maxRows is 20', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev(`e${i + 1}`));
    render(<ActivityFeedCard events={events} />);
    expect(screen.getByTestId('activity-row-e20')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-e21')).toBeNull();
  });

  it('renders prose + actor login + when label', () => {
    render(
      <ActivityFeedCard
        events={[
          ev('x', {
            text: 'shipped F-DOGFOOD-001',
            actorLogin: 'bob',
            whenLabel: '3h ago',
          }),
        ]}
      />,
    );
    const row = screen.getByTestId('activity-row-x');
    expect(row.textContent).toContain('shipped F-DOGFOOD-001');
    expect(row.textContent).toContain('@bob');
    expect(row.textContent).toContain('3h ago');
  });

  it('renders icon for each kind', () => {
    render(
      <ActivityFeedCard
        events={[
          ev('e1', { kind: 'pr_merged' }),
          ev('e2', { kind: 'feature_shipped' }),
          ev('e3', { kind: 'contributor_joined' }),
        ]}
      />,
    );
    expect(screen.getByTestId('activity-row-icon-e1').textContent).toBe('⤴');
    expect(screen.getByTestId('activity-row-icon-e2').textContent).toBe('✓');
    expect(screen.getByTestId('activity-row-icon-e3').textContent).toBe('+');
  });
});
