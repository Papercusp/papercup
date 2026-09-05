// @vitest-environment jsdom

import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
}));
vi.mock('../../components/admin/AdminShell', () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="admin-shell" data-title={title}>{children}</div>
  ),
}));
vi.mock('@/app/admin/work-scope/WorkScopeAdmin', () => ({
  default: () => <div data-testid="work-scope-admin" />,
}));

import { Route } from './work-scope';

const Component = (Route as unknown as { component: () => JSX.Element }).component;

afterEach(() => cleanup());

describe('/admin/work-scope desktop route', () => {
  // WI-2145092: the Next page + Next AdminShell tab alone leave the pane unreachable in the
  // desktop (the SPA renders its fallback for an unknown path) — this route is the door.
  it('renders the canonical WorkScopeAdmin inside the Vite AdminShell', () => {
    render(<Component />);

    expect(screen.getByTestId('admin-shell').getAttribute('data-title')).toBe('Work scope');
    expect(screen.getByTestId('work-scope-admin')).toBeTruthy();
  });
});
