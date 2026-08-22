// @vitest-environment jsdom
/**
 * ChromeShell.test.tsx — render-tier coverage for the operator's global chrome
 * (header + nav). ChromeShell pulls a large dependency tree (lazy docks, motion,
 * voice, flag/theme hooks); we stub every heavy child + external hook and assert
 * ChromeShell's OWN logic:
 *   - chromeless path prefixes (/pi, /project-docs, /el-min) → render null
 *   - a normal route → the header + primary nav links render
 *   - onAdv branch: on /adv the OPS CTA is a non-link "current page" span
 *   - testingFlag gating: Plugins link + the RES and PUI header CTAs appear
 *     only when the TESTING flag is on
 *   - OPERATOR_CHAT_SIDEBAR gating: the revived OperatorChatSidebar renders
 *     iff ITS flag is on (independent of TESTING); OracleDock + Tutorial
 *     stay retired regardless of flags
 *   - the website-matched header quote types on the measured cadence and
 *     settles immediately when motion/effects are disabled
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/* ── Hook mocks (controllable per-test) ────────────────────────────── */
let pathname = '/';
let testingFlag = false;
let operatorChatSidebarFlag = false;
let fancyEffectsEnabled = false;
let reducedMotion = false;
vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => pathname,
}));
vi.mock('@/lib/flag-hooks', () => ({
  // The sidebar has its OWN flag (operator-chat-sidebar-revival-2026-07-13);
  // every other flag read (TESTING, RES_ALLOCATION) follows testingFlag, as
  // the pre-revival tests assumed.
  useFlag: (key: string) =>
    key === 'papercusp-operator-chat-sidebar' ? operatorChatSidebarFlag : testingFlag,
}));
vi.mock('@/lib/visual-effects', () => ({
  reconcileVisualEffectsMode: vi.fn(),
  useFancyEffectsEnabled: () => fancyEffectsEnabled,
}));
vi.mock('@/lib/theme', () => ({ reconcileActiveTheme: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  reconcileShortcutOverrides: vi.fn(),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    TESTING: 'papercusp-testing',
    OPERATOR_CHAT_SIDEBAR: 'papercusp-operator-chat-sidebar',
  },
}));
vi.mock('motion', () => ({ animate: vi.fn(() => ({ stop: vi.fn() })), stagger: vi.fn(() => 0) }));
vi.mock('motion/react', () => ({ useReducedMotion: () => reducedMotion }));
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
// (TutorialButton + OracleDock stay retired 2026-07-09 →
// _retired/legacy-web-chats/ — design-simplification-2026-07-09 P-003.
// OperatorChatSidebar is REVIVED: operator-chat-sidebar-revival-2026-07-13.)
vi.mock('./OperatorChatSidebar', () => ({ OperatorChatSidebar: () => <div data-testid="op-chat" /> }));
vi.mock('./AnimatedPapercuspCup', () => ({ AnimatedPapercuspCup: () => null }));
vi.mock('./RouteLink', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('./PuiLauncherButton', () => ({ PuiLauncherButton: () => null }));
vi.mock('./ChatwootWidget', () => ({ ChatwootWidget: () => null }));

import ChromeShell from './ChromeShell';

beforeEach(() => {
  pathname = '/';
  testingFlag = false;
  operatorChatSidebarFlag = false;
  fancyEffectsEnabled = false;
  reducedMotion = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    expect(screen.getByRole('link', { name: 'Cloud Workspaces' }).getAttribute('href')).toBe('/cloud-workspaces');
    expect(screen.getByRole('link', { name: 'Support' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'DEV' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeTruthy();
  });

  it('types the header quote on the papercusp.com cadence, then settles', () => {
    vi.useFakeTimers();
    fancyEffectsEnabled = true;
    const quote = 'Nothing Is So Painful To The Human Mind As A Great And Sudden Change';
    const { container } = render(<ChromeShell />);
    const wrapper = container.querySelector('.pc-header-quote');
    const text = container.querySelector('.pc-header-quote-text');

    expect(text?.textContent).toBe('');
    expect(wrapper?.classList.contains('is-settled')).toBe(false);

    act(() => vi.advanceTimersByTime(949));
    expect(text?.textContent).toBe('');

    act(() => vi.advanceTimersByTime(1));
    expect(text?.textContent).toBe('N');

    act(() => vi.advanceTimersByTime((quote.length - 1) * 24));
    expect(text?.textContent).toBe(quote);
    expect(wrapper?.classList.contains('is-settled')).toBe(true);
    expect(wrapper?.classList.contains('is-static')).toBe(false);
  });

  it('renders the complete settled quote immediately when reduced motion is enabled', () => {
    fancyEffectsEnabled = true;
    reducedMotion = true;
    const { container } = render(<ChromeShell />);
    const wrapper = container.querySelector('.pc-header-quote');
    const text = container.querySelector('.pc-header-quote-text');

    expect(text?.textContent).toBe('Nothing Is So Painful To The Human Mind As A Great And Sudden Change');
    expect(wrapper?.classList.contains('is-settled')).toBe(true);
    expect(wrapper?.classList.contains('is-static')).toBe(true);
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
    // RES CTA (RouteLink aria-label="Resources") is now TESTING-gated too.
    expect(screen.queryByRole('link', { name: 'Resources' })).toBeNull();
  });

  it('shows the testing-only surfaces (Plugins link) when TESTING is on', () => {
    pathname = '/';
    testingFlag = true;
    render(<ChromeShell />);
    expect(screen.getByRole('link', { name: 'Plugins' })).toBeTruthy();
    // RES CTA appears (mock useFlag returns testingFlag for every flag, so the
    // RES_ALLOCATION gate is satisfied too); RES RouteLink aria-label="Resources".
    expect(screen.getByRole('link', { name: 'Resources' })).toBeTruthy();
  });

  it('renders the operator chat sidebar when OPERATOR_CHAT_SIDEBAR is on, even with TESTING off', () => {
    // operator-chat-sidebar-revival-2026-07-13: the sidebar is the app's
    // primary chat surface on its OWN default-ON flag — NOT a testing surface.
    pathname = '/';
    testingFlag = false;
    operatorChatSidebarFlag = true;
    render(<ChromeShell />);
    expect(screen.getByTestId('op-chat')).toBeTruthy();
  });

  it('hides the operator chat sidebar when OPERATOR_CHAT_SIDEBAR is off', () => {
    pathname = '/';
    testingFlag = true; // TESTING must NOT leak the sidebar back in
    operatorChatSidebarFlag = false;
    render(<ChromeShell />);
    expect(screen.queryByTestId('op-chat')).toBeNull();
  });

  it('never renders the still-retired legacy chats (OracleDock / Tutorial), regardless of flags', () => {
    // Recurrence guard for design-simplification-2026-07-09 P-003: OracleDock
    // and TutorialButton stay in _retired/legacy-web-chats/ — only the
    // OperatorChatSidebar was revived.
    pathname = '/';
    testingFlag = true;
    operatorChatSidebarFlag = true;
    render(<ChromeShell />);
    expect(screen.queryByText('Tutorial')).toBeNull();
    expect(document.querySelector('[data-oracle-dock]')).toBeNull();
  });
});
