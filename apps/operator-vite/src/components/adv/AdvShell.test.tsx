// @vitest-environment jsdom
//
// AdvShell render coverage — the /adv shell: header (pot selector · scope
// toggle · New/Share · status bar) + the Radix tab strip. Mounts against a
// stubbed /api/harness/projects/lite (nuqs mocked with STABLE per-key setter
// spies — the restore effect lists the setters as deps, so per-render vi.fn()
// identities would re-fire it forever; otherwise the pinned sibling pattern,
// see AdvConversationsTab.test.tsx). Children with their own suites
// (AdvNowRunning, Select, CreateHarnessPicker, PublishHiveCard) are stubbed;
// the pure exports (buildHarnessSelectOptions, visibleAdvTabs, ADV_TABS shape)
// are pinned in __tests__/adv-shell-logic.test.ts. Asserts:
//   - the full vs workspace-level tab strip + the all-mode snap-back,
//   - the persisted-selection restore precedence (URL slug > persisted >
//     All), written SEQUENTIALLY (slug then scope),
//   - selector changes: concrete pick persists + exits all-mode first; the
//     All row flips ?scope=all and persists the sentinel,
//   - Share = hive publish (hive pots only — per-harness sharing retired,
//     comb-retire-per-harness-sharing-2026-06-11); legacy Shared badge,
//   - the create flow (?create= → picker, onCreated selects + persists),
//   - the Discord-parity shortcuts (tab cycling, harness cycling, goto.inbox,
//     harness.create).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

// nuqs: stable [value, setter] per key. State is plain module data the tests
// seed before render; setters are spies that DON'T write back (assert-only).
const nuqsState: Record<string, unknown> = {
  tab: 'overview',
  slug: null,
  scope: 'expanded',
  create: false,
  share: false,
};
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
  parseAsString: {},
  parseAsBoolean: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

// Radix Select portals are noise here — render a native select with the same
// contract so options + onChange routing stay assertable.
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/app/harness/CreateHarnessPicker', () => ({
  CreateHarnessPicker: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (slug: string) => void;
  }) =>
    open ? (
      <div data-testid="create-picker">
        <button type="button" onClick={() => onCreated('fresh-pot')}>
          simulate-created
        </button>
      </div>
    ) : null,
}));
vi.mock('@/app/harness/PublishHiveCard', () => ({
  PublishHiveCard: ({ hiveSlug }: { hiveSlug: string }) => (
    <div data-testid="publish-hive-card" data-slug={hiveSlug} />
  ),
}));
// The share modal wrapper — passthrough so the card renders without Radix.
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="share-modal">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-share
        </button>
        {children}
      </div>
    ) : null,
}));
vi.mock('./AdvNowRunning', () => ({
  default: ({ slug }: { slug: string | null }) => (
    <div data-testid="now-running" data-slug={slug ?? ''} />
  ),
}));
vi.mock('./DiscordBadge', () => ({
  default: ({ slug }: { slug: string | null }) => (
    <div data-testid="discord-badge" data-slug={slug ?? ''} />
  ),
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean }) => {
    const base = key === 'pot' ? 'Pot' : key;
    return opts?.plural ? `${base}s` : base;
  },
}));

// Shortcut bus: capture each registered action so tests can trigger it.
const shortcutHandlers = new Map<string, () => void>();
vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: () => void) => {
    shortcutHandlers.set(id, run);
  },
}));

import AdvShell, { ADV_TABS } from './AdvShell';

const LS_KEY = () => wsLocalKey('harness.activeProject');

const PROJECTS = [
  // pot-a is a hive home: the header Share affordance is hive-publish-only
  // (per-harness sharing retired — comb-retire-per-harness-sharing-2026-06-11).
  { slug: 'pot-a', harness_kind: 'hive', is_shared: false },
  { slug: 'pot-b', is_shared: true },
  { slug: 'pot-a-child', parent_slug: 'pot-a' },
];

beforeAll(() => {
  // The vitest node localStorage shim can be broken — install a real
  // in-memory Storage (the AutoLoginWelcomeToast.component pattern).
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
});

function stubProjects(payload: unknown = { projects: PROJECTS }, opts: { fail?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/harness/projects/lite')) {
        if (opts.fail) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

/** Render the shell and wait for the projects/lite fetch to land. */
async function renderShell() {
  const utils = render(
    <AdvShell title="Advanced">
      <div data-testid="tab-body" />
    </AdvShell>,
  );
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'pot-a' })).toBeTruthy(),
  );
  return utils;
}

beforeEach(() => {
  nuqsState.tab = 'overview';
  nuqsState.slug = 'pot-a';
  nuqsState.scope = 'expanded';
  nuqsState.create = false;
  nuqsState.share = false;
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  shortcutHandlers.clear();
  localStorage.clear();
  stubProjects();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvShell — strip + header', () => {
  it('renders the title, kicker, and the full tab strip for a single pot', async () => {
    await renderShell();
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByText('Advanced orchestration')).toBeTruthy();
    // Every ADV tab EXCEPT 'overwatch' renders: overwatch is gated on the
    // papercusp-overwatch flag, which defaults OFF (overwatch-role-2026-06-15
    // B-08/D-009 — hidden until B-12 proves it). Health is also flag-gated but
    // defaults ON, so it shows. The test uses the real useFlag → FLAG_DEFAULTS.
    expect(screen.getAllByRole('tab')).toHaveLength(ADV_TABS.length - 1);
    expect(screen.queryByRole('tab', { name: 'overwatch' })).toBeNull();
    // labels render lowercased in the trigger span
    expect(screen.getByRole('tab', { name: 'working' })).toBeTruthy();
    expect(screen.getByText('sub-harnesses')).toBeTruthy();
    // single-slug widgets get the active slug
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('pot-a');
  });

  it('collapses to the workspace-level tabs under All Pots and blanks single-pot widgets', async () => {
    nuqsState.scope = 'all';
    await renderShell();
    const tabs = screen.getAllByRole('tab').map((t) => t.getAttribute('title'));
    expect(tabs).toEqual(['Overview', 'Create', 'Working', 'Health', 'Frames', 'Conversations', 'Learning', 'Evaluation']);
    expect(screen.queryByText('sub-harnesses')).toBeNull();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('');
  });

  it('snaps a per-pot tab back to Overview when the scope is All', async () => {
    nuqsState.scope = 'all';
    nuqsState.tab = 'docs';
    await renderShell();
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('overview'));
  });

  it('snaps away from a direct ?tab=overwatch deep-link when papercusp-overwatch is OFF', async () => {
    // overwatch-role-2026-06-15 B-10/D-009: the tab strip hides the Overwatch
    // button when the flag is off, but a direct deep-link / ui:dispatch must not
    // render the (dark) pane either — snap to Overview so the role is FULLY dark.
    // The flag defaults OFF (real useFlag → FLAG_DEFAULTS).
    nuqsState.tab = 'overwatch';
    await renderShell();
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('overview'));
  });

  it('selecting a tab trigger writes the tab to the URL', async () => {
    await renderShell();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'git' }));
    fireEvent.click(screen.getByRole('tab', { name: 'git' }));
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('git'));
  });
});

describe('AdvShell — selection restore (resolveAdvHarnessSelection wiring)', () => {
  it('a valid URL slug wins — no restore writes', async () => {
    nuqsState.slug = 'pot-a';
    localStorage.setItem(LS_KEY(), 'pot-b');
    await renderShell();
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
    expect(nuqsSetters.scope).not.toHaveBeenCalled();
  });

  it('restores a persisted concrete pot (slug then scope=expanded, sequential)', async () => {
    nuqsState.slug = null;
    localStorage.setItem(LS_KEY(), 'pot-b');
    await renderShell();
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('expanded'));
  });

  it('falls back to All harnesses when nothing usable is persisted', async () => {
    nuqsState.slug = null;
    await renderShell();
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('all'));
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
  });

  it('surfaces a projects/lite failure in the selector placeholder', async () => {
    stubProjects(null, { fail: true });
    render(
      <AdvShell title="Advanced">
        <div />
      </AdvShell>,
    );
    expect(
      await screen.findByRole('option', { name: 'Failed to load harnesses' }),
    ).toBeTruthy();
  });
});

describe('AdvShell — selector + actions', () => {
  it('picking a concrete pot writes the slug and persists it', async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(localStorage.getItem(LS_KEY())).toBe('pot-b');
    // already out of all-mode — no scope write needed
    expect(nuqsSetters.scope).not.toHaveBeenCalled();
  });

  it('picking a pot from All-mode exits all FIRST (sequential scope→slug)', async () => {
    nuqsState.scope = 'all';
    await renderShell();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(nuqsSetters.scope).toHaveBeenCalledWith('expanded');
    expect(nuqsSetters.scope.mock.invocationCallOrder[0]).toBeLessThan(
      nuqsSetters.slug.mock.invocationCallOrder[0],
    );
  });

  it('the All row routes to the scope axis and persists the sentinel', async () => {
    await renderShell();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: '__all__' } });
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('all'));
    expect(localStorage.getItem(LS_KEY())).toBe('__all__');
    // ?slug= keeps the last real harness — switching back is one click
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
  });

  it('the sub-harnesses toggle flips scope between expanded and self', async () => {
    await renderShell();
    const toggle = screen.getByText('sub-harnesses').closest('label')!.querySelector('input')!;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('self'));
  });

  it('shows Share (hive publish) for a hive pot; legacy Shared badge for a shared non-hive pot', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    await waitFor(() => expect(nuqsSetters.share).toHaveBeenCalledWith(true));

    cleanup();
    nuqsState.slug = 'pot-b'; // legacy shared.json share, NOT a hive
    await renderShell();
    expect(screen.getByText('Shared')).toBeTruthy();
    // Per-harness sharing is retired: a non-hive pot gets no Share button.
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });

  it('mounts the hive-publish share modal from URL state and closes it', async () => {
    nuqsState.share = true;
    await renderShell();
    const card = screen.getByTestId('publish-hive-card');
    expect(card.getAttribute('data-slug')).toBe('pot-a');
    fireEvent.click(screen.getByText('close-share'));
    await waitFor(() => expect(nuqsSetters.share).toHaveBeenCalledWith(false));
  });

  it('New opens the create picker; onCreated selects + persists the new pot', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(nuqsSetters.create).toHaveBeenCalledWith(true));

    cleanup();
    nuqsState.create = true;
    await renderShell();
    fireEvent.click(screen.getByText('simulate-created'));
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('fresh-pot'));
    expect(localStorage.getItem(LS_KEY())).toBe('fresh-pot');
  });
});

describe('AdvShell — Discord-parity shortcuts', () => {
  it('goto.nextTab / goto.prevTab cycle the visible strip with wrap-around', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('goto.nextTab')!());
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('brainstorm'));
    act(() => shortcutHandlers.get('goto.prevTab')!());
    // from overview (idx 0) backwards wraps to the last tab
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('settings'));
  });

  it('harness.next cycles to the next project and persists the pick', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('harness.next')!());
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(localStorage.getItem(LS_KEY())).toBe('pot-b');
  });

  it('goto.inbox jumps to Conversations and harness.create opens the picker', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('goto.inbox')!());
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('conversations'));
    act(() => shortcutHandlers.get('harness.create')!());
    await waitFor(() => expect(nuqsSetters.create).toHaveBeenCalledWith(true));
  });
});
