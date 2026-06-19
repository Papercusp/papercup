// @vitest-environment jsdom
/**
 * PiTerminalsDock.test.tsx — coverage for the multi-pane pi/omp terminal dock.
 *
 * The component fires a /pty/prewarm during render (before child effects),
 * renders a header (consoles title + an "Open another terminal" button), and
 * seeds/restores panels via dockview's onReady. We stub dockview with a
 * DockviewReact that invokes onReady with a controllable fake DockviewApi so
 * the seed/restore branch runs, and stub PiPanel/ChatPanel/Tooltip to no-ops.
 * Assertions cover:
 *   - the header chrome + the prewarm fetch on first render
 *   - the "+" button prewarming + adding a terminal panel (pointer-enter + click)
 *   - onReady seeding an initial terminal when there's no saved layout
 *   - onReady restoring a saved layout instead of seeding
 *   - the exported openFeatureChat() helper (success + error paths)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── dockview stub: a DockviewReact that hands onReady a fake api ─────── */
interface FakePanel { id: string; api: { setActive: () => void } }
let fakeApi: {
  panels: FakePanel[];
  activeGroup: unknown;
  addPanel: ReturnType<typeof vi.fn>;
  getPanel: ReturnType<typeof vi.fn>;
  removePanel: ReturnType<typeof vi.fn>;
  fromJSON: ReturnType<typeof vi.fn>;
  toJSON: ReturnType<typeof vi.fn>;
  onDidLayoutChange: ReturnType<typeof vi.fn>;
  onDidAddPanel: ReturnType<typeof vi.fn>;
  onDidRemovePanel: ReturnType<typeof vi.fn>;
};
function makeFakeApi() {
  const panels: FakePanel[] = [];
  return {
    panels,
    activeGroup: null,
    addPanel: vi.fn((spec: { id: string }) => {
      const p: FakePanel = { id: spec.id, api: { setActive: vi.fn() } };
      panels.push(p);
      return p;
    }),
    getPanel: vi.fn((id: string) => panels.find((p) => p.id === id) ?? null),
    removePanel: vi.fn(),
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({})),
    onDidLayoutChange: vi.fn(),
    onDidAddPanel: vi.fn(),
    onDidRemovePanel: vi.fn(),
  };
}

vi.mock('dockview', async () => {
  const React = await import('react');
  return {
    DockviewReact: ({ onReady }: { onReady: (e: { api: typeof fakeApi }) => void }) => {
      // Invoke onReady in an effect (not during render) so the parent's
      // setApi() doesn't trip React's "update while rendering" warning, which
      // vitest-fail-on-console turns into a failure.
      React.useEffect(() => {
        onReady({ api: fakeApi });
      }, []);
      return React.createElement('div', { 'data-testid': 'dockview' });
    },
  };
});
vi.mock('dockview-react/dist/styles/dockview.css', () => ({}));
// Make the localStorage layout key predictable (skip the workspace prefix).
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => k,
}));
vi.mock('./PiPanel', () => ({ default: () => null }));
vi.mock('./ChatPanel', () => ({ default: () => null }));
vi.mock('./Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('lucide-react', () => ({
  Plus: () => null,
  TerminalSquare: () => null,
}));

import PiTerminalsDock, { openFeatureChat } from './PiTerminalsDock';

/* ── env shims + fetch stub ─────────────────────────────────────────── */
const fetchCalls: string[] = [];
let savedLayout: string | null;

function installStorageShim() {
  // jsdom localStorage/sessionStorage throw "not a function" on this box →
  // Map-backed shims.
  const mk = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => Array.from(m.keys())[i] ?? null,
      get length() { return m.size; },
    } as Storage;
  };
  Object.defineProperty(window, 'localStorage', { value: mk(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: mk(), configurable: true });
  if (savedLayout) window.localStorage.setItem('papercusp:pi-dock-layout:demo', savedLayout);
}

beforeEach(() => {
  fetchCalls.length = 0;
  savedLayout = null;
  fakeApi = makeFakeApi();
  installStorageShim();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      // dock-layouts PG read returns a non-overlay row; agent-chats returns empty.
      return new Response(JSON.stringify({ chats: [] }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Unique slug per test so the module-level FIRED_PREWARMS dedup guard (keyed
// by slug|laneId, with a 55s expiry) doesn't carry the prewarm fetch over
// between cases.
let slugCounter = 0;
const nextSlug = () => `demo${++slugCounter}`;

describe('PiTerminalsDock (multi-pane terminal dock)', () => {
  it('renders the consoles header + the add-terminal button, and fires a prewarm on render', () => {
    const slug = nextSlug();
    render(<PiTerminalsDock slug={slug} />);
    expect(screen.getByText(/consoles/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /terminal/i })).toBeTruthy();
    // Prewarm fired during render for the slug.
    expect(fetchCalls.some((c) => c.includes(`/api/harness/${slug}/pty/prewarm`))).toBe(true);
  });

  it('seeds an initial terminal panel when there is no saved layout', async () => {
    render(<PiTerminalsDock slug={nextSlug()} />);
    // onReady runs in an effect; wait for the seed.
    await waitFor(() => expect(fakeApi.addPanel).toHaveBeenCalled());
    const seeded = fakeApi.addPanel.mock.calls.find((c) => c[0].id === 'term-initial');
    expect(seeded).toBeTruthy();
  });

  it('restores a saved layout instead of seeding a fresh terminal', async () => {
    const slug = nextSlug();
    // A saved layout that restores ≥1 panel → restored=true, no seed.
    fakeApi.fromJSON = vi.fn(() => { fakeApi.panels.push({ id: 'restored', api: { setActive: vi.fn() } }); });
    window.localStorage.setItem(`papercusp:pi-dock-layout:${slug}`, JSON.stringify({ grid: {} }));
    render(<PiTerminalsDock slug={slug} />);
    await waitFor(() => expect(fakeApi.fromJSON).toHaveBeenCalled());
    // No 'term-initial' seed because the saved layout restored panels.
    const seeded = fakeApi.addPanel.mock.calls.find((c) => c[0].id === 'term-initial');
    expect(seeded).toBeFalsy();
  });

  it('the "+" button adds a fresh terminal panel on click', async () => {
    const slug = nextSlug();
    render(<PiTerminalsDock slug={slug} />);
    await waitFor(() => expect(fakeApi.addPanel).toHaveBeenCalled());
    const btn = screen.getByRole('button', { name: /terminal/i });
    // (The no-laneId prewarm key already fired at render, so pointer-enter is
    // deduped; we assert the click's panel-add, which always runs.)
    const before = fakeApi.addPanel.mock.calls.length;
    fireEvent.click(btn);
    // Click adds a new term-<id> terminal panel.
    expect(fakeApi.addPanel.mock.calls.length).toBeGreaterThan(before);
    const added = fakeApi.addPanel.mock.calls.at(-1)![0] as { id: string; component: string };
    expect(added.component).toBe('terminal');
    expect(added.id.startsWith('term-')).toBe(true);
  });

  it('openFeatureChat() POSTs a chat and returns the new chat id on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'chat-99', title: 'x', role: 'worker' }), { status: 200 })));
    const res = await openFeatureChat({ slug: 'demo', role: 'worker', featureId: 'F-1' });
    expect(res).toEqual({ chatId: 'chat-99' });
  });

  it('openFeatureChat() returns an error when the create fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })));
    const res = await openFeatureChat({ slug: 'demo', role: 'worker', featureId: 'F-1' });
    expect(res).toEqual({ error: 'nope' });
  });
});
