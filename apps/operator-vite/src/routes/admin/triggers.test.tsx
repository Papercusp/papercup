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
vi.mock('@/app/admin/triggers/TriggersClient', () => ({
  default: () => <div data-testid="triggers-client" />,
}));

import { Route } from './triggers';

const Component = (Route as unknown as { component: () => JSX.Element }).component;

afterEach(() => cleanup());

describe('/admin/triggers desktop route', () => {
  it('renders the canonical TriggersClient inside the Vite AdminShell', () => {
    render(<Component />);

    expect(screen.getByTestId('admin-shell').getAttribute('data-title')).toBe('Triggers');
    expect(screen.getByTestId('triggers-client')).toBeTruthy();
  });
});
