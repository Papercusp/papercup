// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const capture = vi.hoisted(() => ({ active: false }));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock('../components/adv/TasksRosterPanel', () => ({
  default: ({ active }: { active: boolean }) => {
    capture.active = active;
    return <div data-testid="canonical-tasks-roster" />;
  },
}));

vi.mock('../components/adv/adv-header-pills.css', () => ({}));

import { TasksRosterEmbedRoute } from './tasks-roster';

afterEach(cleanup);

describe('/tasks-roster embed route', () => {
  it('renders the canonical roster active inside the chromeless viewport', () => {
    render(<TasksRosterEmbedRoute />);

    expect(screen.getByTestId('tasks-roster-embed')).toBeTruthy();
    expect(screen.getByTestId('canonical-tasks-roster')).toBeTruthy();
    expect(capture.active).toBe(true);
  });
});
