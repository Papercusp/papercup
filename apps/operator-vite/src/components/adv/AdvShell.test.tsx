// @vitest-environment jsdom
//
// AdvShell render coverage — the /adv shell: header (pot selector · scope
// toggle · New/Share · status bar) + the Radix tab strip. Mounts against a
// mocked harnessProjects.lite sync query (data-sync-push P-010 — the live
// registry list replaced the old one-shot /api/harness/projects/lite fetch;
// nuqs mocked with STABLE per-key setter spies — the restore effect keyed on
// the project count would re-fire forever with per-render vi.fn() identities;
// otherwise the pinned sibling pattern, see AdvNowRunning.test.tsx). Children with their own suites
// (AdvNowRunning, Select, CreateHarnessPicker, PublishHiveCard) are stubbed;
// the pure exports (buildHarnessSelectOptions, visibleAdvTabs, ADV_TABS shape)
// are pinned in __tests__/adv-shell-logic.test.ts. Asserts:
//   - the full vs workspace-level tab strip + the all-mode pinned-tab behavior,
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

// Live harnessProjects.lite registry list (P-010). The tests seed `projectRows`
// (the resolver's projects[] row shape) and optionally `projectsError`; the
// component reads `data`, `error`, `invalidate` off the result. `invalidate` is
// a spy so the create/share refetch paths stay assertable.
let projectRows: unknown[] | undefined = [];
let projectsError: Error | null = null;
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    if (queryName === 'harnessProjects.lite') {
      return { data: projectsError ? undefined : projectRows, error: projectsError, invalidate: invalidateSpy };
    }
    return { data: undefined, error: null, invalidate: vi.fn() };
  },
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
    // SelectEntry[] — flat options OR { kind:'group', label, options } groups.
    options: Array<
      | { value: string; label: string; disabled?: boolean }
      | { kind: 'group'; label: string; options: Array<{ value: string; label: string; disabled?: boolean }> }
    >;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o, i) =>
        'kind' in o && o.kind === 'group' ? (
          <optgroup key={`g-${i}`} label={o.label}>
            {o.options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ),
      )}
    </select>
  ),
}));
vi.mock('@/app/harness/CreateHarnessPicker', () => ({
  CreateHarnessPicker: ({
    open,
    onCreated,
    hiveScope,
  }: {
    open: boolean;
    onCreated: (slug: string) => void;
    hiveScope?: string | null;
  }) =>
    open ? (
      <div data-testid="create-picker" data-hive-scope={hiveScope ?? ''}>
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
// The active hive's directory share-meta (GET /api/discovery/hive-meta) drives
// the header's Share-button → Shared-badge swap (comb-hive-native-sharing).
// Seed `hiveShareMeta` per test; default null = never published (unshared → the
// Share button shows). `public`/`invite` = shared → the Shared badge shows.
let hiveShareMeta: { found: boolean; visibility: 'public' | 'invite' | 'private' | null } | null = null;
vi.mock('@/app/harness/ShareHiveDialog', () => ({
  defaultFetchShareMeta: vi.fn(async () => hiveShareMeta),
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
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    let s = key === 'pot' ? 'Pot' : key;
    if (opts?.plural) s += 's';
    if (opts?.lower) s = s.toLowerCase();
    return s;
  },
}));

// Shortcut bus: capture each registered action so tests can trigger it.
const shortcutHandlers = new Map<string, () => void>();
vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: () => void) => {
    shortcutHandlers.set(id, run);
  },
}));

import AdvShell, { ADV_TABS, buildHarnessSelectOptions } from './AdvShell';

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

/** Seed the live harnessProjects.lite result (rows or an error). */
function stubProjects(rows: unknown[] = PROJECTS, opts: { fail?: boolean } = {}) {
  if (opts.fail) {
    projectRows = undefined;
    projectsError = new Error('HTTP 500');
  } else {
    projectRows = rows;
    projectsError = null;
  }
}

/** Render the shell and wait for the live projects list to render. */
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
  invalidateSpy.mockClear();
  stubProjects();
});

afterEach(() => {
  cleanup();
});

describe('AdvShell — strip + header', () => {
  it('renders the title, kicker, and the full tab strip for a single pot', async () => {
    await renderShell();
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByText('Advanced orchestration')).toBeTruthy();
    // The full ADV strip renders: Health is flag-gated but defaults ON (real
    // useFlag → FLAG_DEFAULTS), so every ADV_TABS entry shows. Overwatch is NOT
    // an /adv tab anymore — it moved to the left sidebar next to Queen
    // (system-health-tab P-008, 2026-06-15), so the strip must never carry it.
    expect(screen.getAllByRole('tab')).toHaveLength(ADV_TABS.length);
    expect(screen.queryByRole('tab', { name: 'overwatch' })).toBeNull();
    // Tab-strip overflow affordance (owner ask 2026-06-15 #1): the scroll
    // chevrons are wired into the strip (CSS reveals them only when clipped, so
    // query the DOM directly rather than the a11y tree).
    expect(document.querySelector('button.pc-advshell__tabnav--left')).toBeTruthy();
    expect(document.querySelector('button.pc-advshell__tabnav--right')).toBeTruthy();
    // labels render lowercased in the trigger span
    expect(screen.getByRole('tab', { name: 'working' })).toBeTruthy();
    expect(screen.getByText('sub-pots')).toBeTruthy();
    // single-slug widgets get the active slug
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('pot-a');
  });

  it('collapses to the workspace-level tabs under All Pots and blanks single-pot widgets', async () => {
    nuqsState.scope = 'all';
    await renderShell();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['overview', 'create', 'calendar', 'working', 'health', 'frames', 'conversations', 'learning', 'evaluation']);
    expect(screen.queryByText('sub-pots')).toBeNull();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('');
  });

  it('keeps a per-pot tab pinned (no snap to Overview) under All scope so it can prompt to pick a hive', async () => {
    nuqsState.scope = 'all';
    nuqsState.tab = 'docs';
    await renderShell();
    // No snap-back: the active per-pot tab is NOT rewritten to Overview…
    expect(nuqsSetters.tab).not.toHaveBeenCalledWith('overview');
    // …and it stays pinned + visible in the strip (its body shows the pick-a-hive prompt).
    await waitFor(() => expect(screen.getByRole('tab', { name: 'docs' })).toBeTruthy());
  });

  it('selecting a tab trigger writes the tab to the URL', async () => {
    await renderShell();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'git' }));
    fireEvent.click(screen.getByRole('tab', { name: 'git' }));
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('git'));
  });
});

describe('AdvShell — hive pick resets the member focus (?harness)', () => {
  it('picking a hive in the selector CLEARS ?harness so the Harnesses dock re-scopes (bugfix: panels stayed pinned to a drilled-into sub-hive)', async () => {
    nuqsState.slug = 'pot-a';
    nuqsState.harness = 'pot-b'; // a sticky within-hive member focus from a prior drill-in
    await renderShell();
    fireEvent.change(screen.getByLabelText(/Select pot/i), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    // THE FIX: the member focus is reset to null so dockSlug follows the picked hive
    // instead of the stale sub-hive (which is a valid member, so the stale-guard kept it).
    await waitFor(() => expect(nuqsSetters.harness).toHaveBeenCalledWith(null));
    nuqsState.harness = undefined; // don't leak into other tests
  });

  it('cycling the harness via the keyboard (harness.next) ALSO clears ?harness so the dock follows the newly-cycled hive (same stale-?harness bugfix, keyboard path)', async () => {
    nuqsState.slug = 'pot-a';
    nuqsState.harness = 'pot-a-child'; // a sticky within-hive member focus from a prior drill-in
    await renderShell();
    act(() => shortcutHandlers.get('harness.next')!());
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    // THE FIX (keyboard path, AdvShell cycleHarness): member focus reset to null
    // so the dock follows the cycled-to hive instead of the stale sub-hive.
    await waitFor(() => expect(nuqsSetters.harness).toHaveBeenCalledWith(null));
    nuqsState.harness = undefined; // don't leak into other tests
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
    stubProjects([], { fail: true });
    render(
      <AdvShell title="Advanced">
        <div />
      </AdvShell>,
    );
    expect(
      await screen.findByRole('option', { name: 'Failed to load Pots' }),
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
    const toggle = screen.getByRole('checkbox', { name: /include sub-pots/i });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
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

  it('New opens the create picker; onCreated persists the new pot', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(nuqsSetters.create).toHaveBeenCalledWith(true));

    cleanup();
    nuqsState.create = true;
    await renderShell();
    fireEvent.click(screen.getByText('simulate-created'));
    // onCreated is side-effects only now (localStorage). The new pot's FOCUS
    // (?slug/?harness) is written by the picker ITSELF in the SAME atomic
    // useQueryStates write as the modal close — doing it here too would be a second
    // same-tick write the custom adapter clobbers (the stuck-modal bug). The
    // focus+close atomicity is covered by nuqs-two-write-race.router-integration.
    await waitFor(() => expect(localStorage.getItem(LS_KEY())).toBe('fresh-pot'));
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

describe('AdvShell — CreateHarnessPicker into-hive scope gating', () => {
  // Regression: `?slug=` outlives the entity, so a removed hive or a non-hive
  // active harness must NOT be handed to the picker as `hiveScope` — doing so
  // defaulted the picker to the into-hive "Add to <X>" fork, and submitting
  // posted `intoHive=<X>`, which the backend rejects as `hive_not_found`
  // ("The selected hive wasn't found"), blocking a plain new-hive create.
  it('passes the active slug as hiveScope only when it is a live kind:hive home', async () => {
    nuqsState.slug = 'pot-a'; // PROJECTS: harness_kind:'hive'
    nuqsState.create = true;
    await renderShell();
    expect(screen.getByTestId('create-picker').getAttribute('data-hive-scope')).toBe('pot-a');
  });

  it('does NOT pass a non-hive active harness as hiveScope (→ null, new-hive default)', async () => {
    nuqsState.slug = 'pot-b'; // PROJECTS: a real project but NOT a hive
    nuqsState.create = true;
    await renderShell();
    // Gated to '' (null) — the picker defaults to new-hive, so submitting cannot
    // post intoHive=pot-b and trip the backend hive_not_found.
    expect(screen.getByTestId('create-picker').getAttribute('data-hive-scope')).toBe('');
  });
});

describe('buildHarnessSelectOptions — hive-home folding (the repo-less `-hive` plumbing is never shown)', () => {
  const lite = (slug: string, extra: Record<string, unknown> = {}) =>
    ({ slug, path: '/p', hasState: false, hasSpec: false, ...extra }) as never;
  // Pull the member tree out of the workspace group entry.
  const treeOf = (entries: ReturnType<typeof buildHarnessSelectOptions>) =>
    (entries.find((e) => 'kind' in e && e.kind === 'group') as { options: { value: string; label: string }[] } | undefined)
      ?.options ?? [];

  it('collapses a single-repo hive: `<x>-hive` home + member `<x>` → ONE "x" row (no -hive, no redundant member)', () => {
    const tree = treeOf(
      buildHarnessSelectOptions([lite('shop-hive', { harness_kind: 'hive' }), lite('shop', { hive_slug: 'shop-hive' })], null, 'Hives', 'WS'),
    );
    // label = the stripped hive name; value = the home slug so ?slug= scopes to the hive.
    expect(tree).toEqual([{ value: 'shop-hive', label: 'shop' }]);
  });

  it('multi-repo hive: friendly header (`-hive` stripped) + member rows; the raw `-hive` slug never appears', () => {
    const tree = treeOf(
      buildHarnessSelectOptions(
        [lite('team-hive', { harness_kind: 'hive' }), lite('backend', { hive_slug: 'team-hive' }), lite('frontend', { hive_slug: 'team-hive' })],
        null, 'Hives', 'WS',
      ),
    );
    expect(tree[0]).toEqual({ value: 'team-hive', label: 'team' });
    expect(tree.map((o) => o.label)).toEqual(expect.arrayContaining(['  ↳ backend', '  ↳ frontend']));
    expect(tree.some((o) => o.label === 'team-hive')).toBe(false);
  });

  it('a legacy/standalone non-hive root keeps its slug as-is', () => {
    const tree = treeOf(buildHarnessSelectOptions([lite('solo', { is_shared: true })], null, 'Hives', 'WS'));
    expect(tree).toEqual([{ value: 'solo', label: 'solo' }]);
  });

  it('shows a repo-less operations hive that is not suffix plumbing, e.g. oddsmith-ops', () => {
    const tree = treeOf(buildHarnessSelectOptions([lite('oddsmith-ops', { harness_kind: 'hive' })], null, 'Hives', 'WS'));
    expect(tree).toEqual([{ value: 'oddsmith-ops', label: 'oddsmith-ops' }]);
  });

  it('folds a `-hive` home by SUFFIX even when harness_kind is absent (projects-lite robustness)', () => {
    // projects-lite doesn't always carry harness_kind; the `-hive` suffix alone
    // must still fold the home (members never end in -hive). Guards the case
    // where the kind-only gate would leave a raw `<x>-hive` row in the picker.
    const tree = treeOf(
      buildHarnessSelectOptions([lite('shop-hive'), lite('shop', { hive_slug: 'shop-hive' })], null, 'Hives', 'WS'),
    );
    expect(tree).toEqual([{ value: 'shop-hive', label: 'shop' }]);
    expect(tree.some((o) => o.label.includes('-hive'))).toBe(false);
  });
});
