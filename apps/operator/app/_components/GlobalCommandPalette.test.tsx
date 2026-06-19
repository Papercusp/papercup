// @vitest-environment jsdom
/**
 * GlobalCommandPalette.test.tsx — render-tier coverage for the app-wide command
 * palette host. It owns the `?palette=` nuqs state + the `palette.toggle`
 * shortcut, and only mounts the (lazy, heavy) CommandPalette chunk when open.
 * We stub CommandPalette to a marker, mock the registry/server-capability
 * command sources, and assert: closed → null, open (via ?palette=true) → the
 * palette mounts, and the registered shortcut toggles the URL state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// The palette UI is lazy + heavy (cmdk + Radix Dialog); stub it to a marker so
// we only assert the host's mount/gating logic.
vi.mock('./CommandPalette', () => ({
  default: ({ commands }: { commands: unknown[] }) => (
    <div data-testid="palette">palette open · {commands.length} cmds</div>
  ),
}));

// Capture the registered `palette.toggle` action so a test can fire it.
const registered: Array<{ id: string; run: (e: KeyboardEvent) => void }> = [];
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: (e: KeyboardEvent) => void) => {
    registered.push({ id, run });
  },
}));

vi.mock('@papercusp/operator-core/lib/commands/shims/palette-shim', () => ({
  buildRegistryPaletteItems: () => [
    { id: 'nav.home', title: 'Home', section: 'nav', perform: vi.fn() },
  ],
}));
vi.mock('./use-server-capabilities', () => ({
  useServerCapabilityCommands: () => [],
}));
vi.mock('@/lib/router-compat/navigation', () => ({
  useSearchParams: () => new URLSearchParams('ws=default'),
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/lazy-with-retry', () => ({
  // Return the (mocked) CommandPalette default synchronously so Suspense
  // resolves immediately in the test.
  lazyWithRetry: (factory: () => Promise<{ default: unknown }>) => {
    // mirror React.lazy: a component that throws a resolved promise once.
    let mod: { default: any } | null = null;
    let promise: Promise<void> | null = null;
    return (props: any) => {
      if (mod) return <mod.default {...props} />;
      if (!promise) promise = factory().then((m) => { mod = m as { default: any }; });
      throw promise;
    };
  },
}));

import GlobalCommandPalette from './GlobalCommandPalette';

function renderHost(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

beforeEach(() => {
  registered.length = 0;
});
afterEach(cleanup);

describe('GlobalCommandPalette', () => {
  it('renders nothing when the palette is closed (default ?palette absent)', () => {
    const { container } = renderHost(<GlobalCommandPalette />);
    expect(container.querySelector('[data-testid="palette"]')).toBeNull();
  });

  it('renders nothing for ?palette=1 (only the literal "true" opens it)', () => {
    const { container } = renderHost(<GlobalCommandPalette />, '?palette=1');
    expect(container.querySelector('[data-testid="palette"]')).toBeNull();
  });

  it('mounts the palette when ?palette=true', async () => {
    renderHost(<GlobalCommandPalette />, '?palette=true');
    await waitFor(() => expect(screen.getByTestId('palette')).toBeTruthy());
    // The registry command source feeds 1 command into the palette.
    expect(screen.getByText(/1 cmds/)).toBeTruthy();
  });

  it('registers the palette.toggle shortcut', () => {
    renderHost(<GlobalCommandPalette />);
    expect(registered.some((r) => r.id === 'palette.toggle')).toBe(true);
  });

  it('firing the palette.toggle shortcut opens the (previously closed) palette', async () => {
    renderHost(<GlobalCommandPalette />);
    // Closed initially.
    expect(screen.queryByTestId('palette')).toBeNull();
    const toggle = registered.find((r) => r.id === 'palette.toggle')!;
    toggle.run(new KeyboardEvent('keydown'));
    await waitFor(() => expect(screen.getByTestId('palette')).toBeTruthy());
  });
});
