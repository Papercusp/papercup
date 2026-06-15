// @vitest-environment jsdom
//
// ThemeSelector — the navbar theme dropdown. Real render logic: the trigger
// labels itself from the active theme, the open menu lists built-ins + custom
// themes, marks the current one (aria-checked), and picking a theme calls
// writeActiveTheme. A render-smoke drives a mocked @/lib/theme; the portaled
// menu is opened via the ?themeSwitch nuqs param (real testing adapter).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const { theme } = vi.hoisted(() => ({
  theme: {
    active: 'dark',
    writeActiveTheme: vi.fn(),
    custom: [] as { id: string; label: string }[],
  },
}));

vi.mock('@/lib/theme', () => ({
  useActiveTheme: () => theme.active,
  writeActiveTheme: (id: string) => theme.writeActiveTheme(id),
  fetchCustomThemes: vi.fn(async () => theme.custom),
  themeList: (custom: { id: string; label: string }[]) => [
    { id: 'dark', label: 'Dark', builtin: true },
    { id: 'light', label: 'Light', builtin: true },
    ...custom.map((c) => ({ id: `custom:${c.id}`, label: c.label, builtin: false })),
  ],
}));

vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./RouteLink', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import ThemeSelector from './ThemeSelector';

beforeEach(() => {
  theme.active = 'dark';
  theme.custom = [];
  theme.writeActiveTheme.mockClear();
});
afterEach(cleanup);

describe('<ThemeSelector />', () => {
  it('labels the trigger with the active theme', () => {
    render(<ThemeSelector />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    const trigger = screen.getByRole('button', { name: /switch theme/i });
    expect(trigger.textContent).toContain('Dark');
  });

  it('renders the closed selector without a menu', () => {
    render(<ThemeSelector />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lists built-in themes and marks the active one when open', async () => {
    render(<ThemeSelector />, { wrapper: withNuqsTestingAdapter({ searchParams: '?themeSwitch=true' }) });
    const menu = await screen.findByRole('menu');
    const dark = within(menu).getByRole('menuitemradio', { name: /Dark/ });
    const light = within(menu).getByRole('menuitemradio', { name: /Light/ });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    expect(light.getAttribute('aria-checked')).toBe('false');
  });

  it('includes custom themes alongside the built-ins', async () => {
    theme.custom = [{ id: 'sunset', label: 'Sunset' }];
    render(<ThemeSelector />, { wrapper: withNuqsTestingAdapter({ searchParams: '?themeSwitch=true' }) });
    const menu = await screen.findByRole('menu');
    expect(await within(menu).findByRole('menuitemradio', { name: /Sunset/ })).toBeTruthy();
  });

  it('writes the picked theme on click', async () => {
    render(<ThemeSelector />, { wrapper: withNuqsTestingAdapter({ searchParams: '?themeSwitch=true' }) });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Light/ }));
    expect(theme.writeActiveTheme).toHaveBeenCalledWith('light');
  });
});
