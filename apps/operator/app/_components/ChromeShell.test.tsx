// @vitest-environment jsdom
/**
 * ChromeShell.test.tsx — render-tier coverage for the operator's global chrome
 * (header + nav). ChromeShell pulls a large dependency tree (lazy docks, motion,
 * voice, flag/theme hooks); we stub every heavy child + external hook and assert
 * ChromeShell's OWN logic:
 *   - chromeless path prefixes (/pi, /project-docs, /el-min) → render null
 *   - a normal route → the header + primary nav links render
 *   - onAdv branch: on /adv the OPS CTA is a non-link "current page" span
 *   - testingFlag gating: Plugins link + the web OperatorChatSidebar appear
 *     only when the TESTING flag is on
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Hook mocks (controllable per-test) ────────────────────────────── */
let pathname = '/';
let testingFlag = false;
vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => pathname,
}));
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: () => testingFlag,
}));
vi.mock('@/lib/visual-effects', () => ({
  reconcileVisualEffectsMode: vi.fn(),
  useFancyEffectsEnabled: () => false,
}));
vi.mock('@/lib/theme', () => ({ reconcileActiveTheme: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  reconcileShortcutOverrides: vi.fn(),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { TESTING: 'papercusp-testing' } }));
vi.mock('motion', () => ({ animate: vi.fn(() => ({ stop: vi.fn() })), stagger: vi.fn(() => 0) }));
vi.mock('motion/react', () => ({ useReducedMotion: () => false }));
vi.mock('@papercusp/operator-core/lib/lazy-with-retry', () => ({
  // ChromeShell only renders lazy docks behind a deferred idle gate / Suspense;
  // a never-resolving lazy keeps them from mounting in the test (fallback=null).
  lazyWithRetry: () => () => null,
}));

/* ── Child component stubs (render nothing / a marker) ──────────────── */
vi.mock('./ChromeNavMarks', () => ({ BrainMark: () => null, ResMark: () => null }));
vi.mock('./voice/AriaLiveRegions', () => ({ AriaLiveRegions: () => null }));
vi.mock('./voice/VoiceLeaderBootstrap', () => ({ VoiceLeaderBootstrap: () => null }));
vi.mock('./HostCheckBanner', () => ({ HostCheckBanner: () => null }));
vi.mock('./WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('./ThemeSelector', () => ({ default: () => null }));
vi.mock('./BrandSwitcher', () => ({ default: () => null }));
vi.mock('./UserPicker', () => ({ default: () => null }));
vi.mock('./AutoLoginWelcomeToast', () => ({ default: () => null }));
vi.mock('./UpdateChip', () => ({ default: () => null }));
vi.mock('./NotificationCenter', () => ({ NotificationCenter: () => null }));
vi.mock('./RecentActionsCenter', () => ({ RecentActionsCenter: () => null }));
vi.mock('./TutorialButton', () => ({ default: () => <button type="button">Tutorial</button> }));
vi.mock('./AnimatedPapercuspCup', () => ({ AnimatedPapercuspCup: () => null }));
vi.mock('./RouteLink', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('./PuiLauncherButton', () => ({ PuiLauncherButton: () => null }));
vi.mock('./OperatorChatSidebar', () => ({ OperatorChatSidebar: () => <div data-testid="op-chat" /> }));
vi.mock('./ChatwootWidget', () => ({ ChatwootWidget: () => null }));

import ChromeShell from './ChromeShell';

beforeEach(() => {
  pathname = '/';
  testingFlag = false;
});
afterEach(cleanup);

describe('ChromeShell', () => {
  it('renders null on a chromeless route (/pi)', () => {
    pathname = '/pi';
    const { container } = render(<ChromeShell />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null on a nested chromeless route (/project-docs/x)', () => {
    pathname = '/project-docs/some-doc';
    const { container } = render(<ChromeShell />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header + primary nav on a normal route', () => {
    pathname = '/';
    render(<ChromeShell />);
    expect(screen.getByText('OPS')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Support' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'DEV' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeTruthy();
  });

  it('renders the OPS CTA as a navigable link when NOT on /adv', () => {
    pathname = '/';
    render(<ChromeShell />);
    expect(screen.getByRole('link', { name: 'Ops' })).toBeTruthy();
  });

  it('renders the OPS CTA as a non-link "current page" span when on /adv', () => {
    pathname = '/adv';
    render(<ChromeShell />);
    // On /adv the CTA is aria-current="page" and NOT a link.
    expect(screen.queryByRole('link', { name: 'Ops' })).toBeNull();
    expect(screen.getByLabelText(/Ops \(current page\)/i)).toBeTruthy();
  });

  it('hides the testing-only surfaces when the TESTING flag is off', () => {
    pathname = '/';
    testingFlag = false;
    render(<ChromeShell />);
    expect(screen.queryByRole('link', { name: 'Plugins' })).toBeNull();
    expect(screen.queryByTestId('op-chat')).toBeNull();
    expect(screen.queryByText('Tutorial')).toBeNull();
  });

  it('shows the testing-only surfaces (Plugins link + web chat + Tutorial) when TESTING is on', () => {
    pathname = '/';
    testingFlag = true;
    render(<ChromeShell />);
    expect(screen.getByRole('link', { name: 'Plugins' })).toBeTruthy();
    expect(screen.getByTestId('op-chat')).toBeTruthy();
    expect(screen.getByText('Tutorial')).toBeTruthy();
  });
});
