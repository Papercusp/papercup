// @vitest-environment jsdom
//
// EnvSwitcherBar — the cross-platform in-webview env switcher (dogfood-silent-
// canonical-hive-join P-013/P-014/P-017, D-008). Covers: self-hide when <2 ENV envs
// reachable; renders a button per env + a distinct "release" button with the active
// (self) env highlighted; switching navigates the webview (window.location) to the
// target origin carrying the current route; clicking the active env is a no-op; the
// release button navigates to the release origin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import EnvSwitcherBar from './EnvSwitcherBar';

function op(p: { id: string; port: number; reachable: boolean; isSelf?: boolean; kind?: 'env' | 'release' }) {
  return {
    id: p.id,
    label: p.id,
    port: p.port,
    tooltip: `${p.id} tooltip`,
    origin: `http://127.0.0.1:${p.port}`,
    reachable: p.reachable,
    sha: null,
    isSelf: p.isSelf ?? false,
    kind: p.kind ?? 'env',
  };
}

function mockOperatorsFetch(operators: ReturnType<typeof op>[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/desktop/dev-operators')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, operators, selfPort: operators.find((o) => o.isSelf)?.port ?? null }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const realLocation = window.location;
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...realLocation,
      assign: vi.fn(),
      pathname: '/adv',
      search: '?tab=overview',
      hash: '',
      port: '3270',
      origin: 'http://127.0.0.1:3270',
    },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  cleanup();
  vi.clearAllMocks();
});

describe('EnvSwitcherBar', () => {
  it('self-hides when fewer than 2 ENV envs are reachable (single-operator install)', async () => {
    mockOperatorsFetch([
      op({ id: 'dev', port: 3270, reachable: true, isSelf: true }),
      op({ id: 'prod', port: 3070, reachable: false }),
      op({ id: 'release', port: 3070, reachable: true, kind: 'release' }),
    ]);
    render(<EnvSwitcherBar />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('env-switcher-bar')).toBeNull();
  });

  it('renders a button per env + a release button, with the self env active', async () => {
    mockOperatorsFetch([
      op({ id: 'dev', port: 3270, reachable: true, isSelf: true }),
      op({ id: 'prod', port: 3070, reachable: true }),
      op({ id: 'staging', port: 3170, reachable: true }),
      op({ id: 'local', port: 3055, reachable: false }),
      op({ id: 'release', port: 3070, reachable: true, kind: 'release' }),
    ]);
    render(<EnvSwitcherBar />);
    await screen.findByTestId('env-switcher-bar');
    expect(screen.getByTestId('env-btn-dev').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('env-btn-prod').getAttribute('data-active')).toBe('false');
    expect((screen.getByTestId('env-btn-local') as HTMLButtonElement).disabled).toBe(true);
    // The release escape button is present.
    expect(screen.getByTestId('env-btn-release')).toBeTruthy();
  });

  it('switching to a reachable env navigates the webview to its origin, carrying the route', async () => {
    mockOperatorsFetch([
      op({ id: 'dev', port: 3270, reachable: true, isSelf: true }),
      op({ id: 'staging', port: 3170, reachable: true }),
    ]);
    render(<EnvSwitcherBar />);
    await screen.findByTestId('env-switcher-bar');
    fireEvent.click(screen.getByTestId('env-btn-staging'));
    expect(window.location.assign).toHaveBeenCalledWith('http://127.0.0.1:3170/adv?tab=overview');
  });

  it('does not navigate when clicking the active (self) env', async () => {
    mockOperatorsFetch([
      op({ id: 'dev', port: 3270, reachable: true, isSelf: true }),
      op({ id: 'staging', port: 3170, reachable: true }),
    ]);
    render(<EnvSwitcherBar />);
    await screen.findByTestId('env-switcher-bar');
    fireEvent.click(screen.getByTestId('env-btn-dev'));
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('the release button navigates to the release origin', async () => {
    mockOperatorsFetch([
      op({ id: 'dev', port: 3270, reachable: true, isSelf: true }),
      op({ id: 'staging', port: 3170, reachable: true }),
      op({ id: 'release', port: 9999, reachable: true, kind: 'release' }),
    ]);
    render(<EnvSwitcherBar />);
    await screen.findByTestId('env-switcher-bar');
    fireEvent.click(screen.getByTestId('env-btn-release'));
    expect(window.location.assign).toHaveBeenCalledWith('http://127.0.0.1:9999/adv?tab=overview');
  });
});
