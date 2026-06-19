// @vitest-environment jsdom
/**
 * OracleDock — the always-mounted Oracle assistant dock (FAB + multi-tab chat).
 * This is a 1407-loc component; we cover the tractable render branches and the
 * primary interactions, stubbing the heavy children (ChatConversation, motion,
 * hud primitives, logos, RouteLink) and the router/visual-effect hooks. We
 * drive: the FAB render when closed, opening the dock via ?oracle=1, the
 * default Oracle tab + header, the new-chat picker toggle, the reset-chat and
 * close header actions, and the ChatConversation send wiring (the input + send
 * button fire the SSE fetch). The SSE stream fetch is stubbed to an empty body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// ChatConversation: a tiny controllable surface exposing the empty-state body
// and an input + send button wired to the props OracleDock passes.
let lastChatProps: Record<string, any> = {};
vi.mock('./chat/ChatConversation', () => ({
  ChatConversation: (props: Record<string, any>) => {
    lastChatProps = props;
    return (
      <div data-testid="chat">
        <div data-testid="empty-body">{props.emptyState?.body}</div>
        <input
          data-testid="chat-input"
          value={props.inputValue}
          onChange={(e) => props.onInputChange?.(e.currentTarget.value)}
        />
        <button data-testid="chat-send" onClick={() => props.onSubmit?.()}>send</button>
      </div>
    );
  },
}));

// Router-compat navigation: inert hooks (no harness slug derivable).
vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

// motion + reduced-motion: no-op animate, reduced motion ON so the fancy
// animate effect early-returns (no DOM querying in jsdom).
vi.mock('motion', () => ({ animate: () => ({ stop: vi.fn() }), stagger: () => 0 }));
vi.mock('motion/react', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/visual-effects', () => ({ useFancyEffectsEnabled: () => false }));

vi.mock('./hud/HudPrimitives', () => ({
  HudFrameCorners: () => null,
  HudReticleGlyph: () => null,
}));
vi.mock('./OracleLogoMark', () => ({ OracleLogoMark: () => null }));
vi.mock('./RouteLink', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/chat-cards', () => ({ renderCard: () => null }));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({ wsLocalKey: (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/ui/client-id', () => ({ getOrCreateClientId: () => 'client-1' }));

import { OracleDock } from './OracleDock';

function renderDock(searchParams = ''): ReturnType<typeof render> {
  const ui: ReactElement = <OracleDock />;
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

// jsdom's web-storage is unreliable under Node's experimental webstorage on
// this box; back both stores with a Map (same pattern as AudienceModeSelector's
// test). OracleDock reads sessionStorage (tabs) + localStorage (seen/tutorial).
function installStorage(name: 'localStorage' | 'sessionStorage') {
  const state = new Map<string, string>();
  Object.defineProperty(window, name, {
    configurable: true,
    value: {
      getItem: (k: string) => state.get(k) ?? null,
      setItem: (k: string, v: string) => { state.set(k, String(v)); },
      removeItem: (k: string) => { state.delete(k); },
      clear: () => state.clear(),
    },
  });
}

beforeEach(() => {
  lastChatProps = {};
  installStorage('localStorage');
  installStorage('sessionStorage');
  // Mark the tutorial done + dock seen so first-run auto-open + tutorial POST
  // do not fire; we test the steady-state surfaces.
  window.localStorage.setItem('oracle_seen_v1', '1');
  window.localStorage.setItem('papercusp_tutorial_done_v1', '1');
  // SSE fetch: an ok response with an empty stream body.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('OracleDock (always-mounted assistant dock)', () => {
  it('renders the FAB (closed dock) with the Ask Oracle label', () => {
    renderDock('');
    expect(screen.getByLabelText('Open Oracle assistant')).toBeTruthy();
    expect(screen.getByText('Ask Oracle')).toBeTruthy();
  });

  it('clicking the FAB opens the dock (sets ?oracle and shows the dialog)', () => {
    renderDock('');
    fireEvent.click(screen.getByLabelText('Open Oracle assistant'));
    expect(screen.getByRole('dialog', { name: 'Oracle' })).toBeTruthy();
  });

  it('opens directly to the Oracle tab when ?oracle=1', () => {
    renderDock('?oracle=true');
    // The dock dialog + the default Oracle tab header render.
    expect(screen.getByRole('dialog', { name: 'Oracle' })).toBeTruthy();
    expect(screen.getByText('general help across Papercusp')).toBeTruthy();
  });

  it('renders the new-chat (+) button and toggles the picker open', () => {
    renderDock('?oracle=true');
    const add = screen.getByLabelText('New chat');
    fireEvent.click(add);
    // Picker region appears with its harness/agent fields.
    expect(screen.getByRole('region', { name: 'Start a new chat' })).toBeTruthy();
  });

  it('the Close header button hides the dock (clears ?oracle)', () => {
    renderDock('?oracle=true');
    fireEvent.click(screen.getByLabelText('Close'));
    // Back to the closed FAB-only state.
    expect(screen.queryByRole('dialog', { name: 'Oracle' })).toBeNull();
    expect(screen.getByLabelText('Open Oracle assistant')).toBeTruthy();
  });

  it('sending a message fires the oracle SSE fetch with the typed text', () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    renderDock('?oracle=true');

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'how does X work?' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/oracle/chat');
    expect(String(init.body)).toContain('how does X work?');
  });

  it('the reset-chat header action keeps the dock open on the Oracle tab', () => {
    renderDock('?oracle=true');
    fireEvent.click(screen.getByLabelText('Reset this chat'));
    // Still the Oracle dialog (reset re-seeds the welcome message, no crash).
    expect(screen.getByRole('dialog', { name: 'Oracle' })).toBeTruthy();
  });
});
