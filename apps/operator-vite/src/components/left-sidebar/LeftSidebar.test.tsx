// @vitest-environment jsdom
/**
 * LeftSidebar shell coverage (left-sidebar-tauri-2026-06-07) — the docked,
 * collapsible Colony rail. Mirrors the DevAdminRail shell test: the 5 lazy tab
 * panels are stubbed so this covers the SHELL — the collapsed icon rail vs the
 * expanded shell, open/collapse + tab switching writing ?lsb/?lst atomically (one
 * setRail), the OVERWATCH flag gating its tab (and snapping a stale ?lst=overwatch
 * back to Mug), Mug as the default tab, the body-reservation side effect, and
 * the chromeless-route null-out. nuqs runs via the real testing adapter so the
 * atomic useQueryStates write is exercised end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// `blanketFlagOn` is the BLANKET answer the shared useFlag mock gives every flag —
// it predates there being more than one gated tab, and the order tests lean on it
// to turn the whole rail on at once. `flags` overrides it PER KEY, which is what
// the CONVERSATIONS_RAIL_TAB tests need: that flag is DEFAULT OFF (WI-37561), so
// "sentinel on, convos off" is a real configuration and a single boolean cannot
// express it. Without the per-key override, a test asserting the Convos tab is
// hidden would be indistinguishable from one asserting Sentinel is hidden.
// (It was called `overwatchOn` until 2026-08-11, when the Kettle tab retired —
// P-059/D-083. The name was already a misnomer by then: it answers EVERY flag
// except MUG_KETTLE, so it is what turns Sentinel and Convos on, and the several
// `= true` assignments below are load-bearing for THOSE tabs. Renamed rather than
// removed precisely so the next reader does not delete them as overwatch residue.)
// `mugKettleOn` is a THIRD knob, separate from the blanket for the same reason
// `flags` is: a single boolean cannot express a real configuration. It defaults
// to TRUE — the inverse of `blanketFlagOn` — because MUG_KETTLE_SYSTEM is the only
// gate here whose OFF state removes the rail's DEFAULT tab, so letting the
// blanket answer it would silently retire the Mug tier underneath every test
// written before the gate existed. Those tests would not fail loudly; the
// "defaults to OPEN on the Mug tab" and "snaps ?lst=overwatch back to Mug" cases
// would just start asserting the retirement instead of their own subject
// (retire-mug-kettle-su-only-2026-08-09 — the quiet vi.mock trap the plan warns
// about). Defaulting it ON keeps every existing case testing what it was written
// to test; the gate's own OFF behaviour is covered by its describe block below,
// which sets this false explicitly.
//
// It is read BEFORE `flags` rather than after, so the wholesale `H.flags = {…}`
// assignments several tests do cannot clobber it by omission.
const MUG_KETTLE = 'papercusp-mug-kettle-system';
const H = vi.hoisted(() => ({
  blanketFlagOn: false,
  mugKettleOn: true,
  flags: {} as Record<string, boolean>,
  pathname: '/adv',
}));

vi.mock('@papercusp/flags/client', () => ({
  useFlag: (key: string) =>
    key === 'papercusp-mug-kettle-system'
      ? (H.flags[key] ?? H.mugKettleOn)
      : (H.flags[key] ?? H.blanketFlagOn),
}));
vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => H.pathname }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));
// Stub the lazy tab panels with trivial markers — their own surfaces are tested
// separately (MugTab).
// (No './PotsTab' stub: this rail no longer mounts it at all — the Pots tab was
// removed 2026-08-10 on owner directive. A stub here would hide a regression that
// re-added the tab, the same reasoning as the SwarmTab/VoiceTab note below.)
vi.mock('./AccountsTab', () => ({ default: () => <div data-testid="panel-accounts" /> }));
vi.mock('./MugTab', () => ({ default: () => <div data-testid="panel-queen" /> }));
// (No './OverwatchTab' stub: that module RETIRED to _retired/mug-kettle-deciders/
// with the Kettle tab — P-059/D-083. A vi.mock naming a module that no longer
// exists is the strand this repo has been bitten by before, so it goes with the
// tab rather than lingering as a harmless-looking line.)
vi.mock('./SystemTab', () => ({ default: () => <div data-testid="panel-system" /> }));
vi.mock('./AgentsTab', () => ({ default: () => <div data-testid="panel-agents" /> }));
vi.mock('./SpendTab', () => ({ default: () => <div data-testid="panel-spend" /> }));
vi.mock('./ConversationsTab', () => ({ default: () => <div data-testid="panel-conversations" /> }));
// SwarmTab / VoiceTab are deliberately NOT stubbed: this rail no longer mounts
// them at all (WI-5162 — they are op-chat sidebar faces now). A stub here would
// hide a regression that re-added them. See the "moved out" test below.

import LeftSidebar from './LeftSidebar';

beforeAll(() => {
  // The vitest jsdom localStorage shim can be broken (`getItem is not a function`);
  // install a real in-memory Storage so components rendered in the tree that read
  // localStorage at render (VoiceButton's wake/ptt-hint useState init; LeftSidebar's
  // own width restore) don't crash. Mirrors AdvShell.test.tsx's pattern.
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
beforeEach(() => {
  localStorage.clear();
  H.blanketFlagOn = false;
  H.mugKettleOn = true;
  H.flags = {};
  H.pathname = '/adv';
  document.body.className = '';
});
afterEach(() => {
  cleanup();
  document.body.className = '';
});

function renderRail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<LeftSidebar />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

describe('<LeftSidebar> shell', () => {
  it('defaults to OPEN on the Mug tab (the owner-default Colony tab)', async () => {
    renderRail();
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rail.getAttribute('data-tab')).toBe('queen');
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  // Pins the WHOLE owner-set order, not just the first pair (owner ask
  // 2026-07-25: "move the pots tab to the right of the accounts tab" + "move the
  // papercup tab to the right of the pots tab"). The previous version asserted
  // only ['Accounts', 'brain'], which would have stayed green through exactly the
  // reordering the owner asked for — a placement request needs a test that fails
  // when the placement changes, or the next refactor silently undoes it.
  //
  // Labels route through the lexicon (t('pot'), t('operator'), t('brain'),
  // t('overwatch')); the useLexicon mock above echoes the key, so they render as
  // the bare key names (restore-pot-lexicon P-005 — the classic pack shows
  // Pots / Papercup / Brain / Kettle at runtime).
  it('orders the rail Accounts · Papercup · Mug · Kettle · Agents · System · Spend', () => {
    // The blanket useFlag answer turns EVERY gated tab on — overwatch, sentinel
    // and (since WI-37561) conversations. The full rail is what the owner's
    // ordering describes, and pinning it with the gates open is deliberate: a
    // dark tab still has a place in the order, and this test is what keeps that
    // place from drifting while nobody can see the tab. The gated-OFF subsets are
    // covered by the flag tests below.
    H.blanketFlagOn = true;
    renderRail();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((x) => x.textContent?.trim())).toEqual([
      'Accounts',
      // ('pot' sat HERE, right of Accounts, 2026-07-25 → 2026-08-10. REMOVED on
      // owner directive: "Remove the 'Pots' tab from the middle pane." Like the
      // Goals removal noted below this is a removal from the MIDDLE, so every
      // entry after it shifts up one — if you are reading this because the test
      // red'd, check whether your change meant to move a tab at all before
      // editing the expectation.)
      'operator',
      'brain',
      // ('overwatch' (the Kettle) sat HERE, between Mug and Agents, until
      // 2026-08-11. RETIRED with its tier — P-059/D-083 — so unlike the gated-OFF
      // case this is a removal from TABS itself, and every entry after it shifts
      // up one. If you are reading this because the test red'd, check whether your
      // change meant to move a tab at all before editing the expectation.)
      // (🎯 Goals sat HERE, between Kettle and Agents, 2026-08-07 → 2026-08-09.
      // REMOVED on owner directive: "remove the goals middle pane tab entirely.
      // We already have a goals tab inside the hud tab lets just use that."
      // Unlike every prior change to this rail, this is a removal from the
      // MIDDLE, so everything below shifts up one — which is exactly the kind of
      // silent reshuffle this test exists to make loud. If you are reading this
      // because the test red'd, check whether your change meant to move a tab at
      // all before editing the expectation.)
      // The scheduled-work rail, split by whether a fire RUNS A MODEL (owner ask
      // 2026-07-26). These two REPLACE the former Blender + Docs tabs, whose rows
      // redistributed into the split.
      'Agents',
      'System',
      // Cost is ONE workspace-wide tab at the end of the rail, not a lane inside
      // each automation pane (owner correction 2026-07-25).
      'Spend',
      // WI-5754 — APPENDED, never inserted: the order above is owner-set, so a
      // new tab goes last rather than reshuffling it. The label is "Convos"
      // because a 3-column tab cell fits ~8 characters beside its icon at the
      // rail's 300px minimum; the pane header carries the full word.
      //
      // WI-37561: Convos is now DEFAULT OFF behind CONVERSATIONS_RAIL_TAB (owner
      // directive 2026-08-09), so at runtime the rail normally ends at Spend. It
      // is asserted here because the flag is ON in this test — its POSITION is
      // what survives the park, and holding that position is precisely what makes
      // flipping the flag back on a one-click change rather than a code change.
      'Convos',
      // NOTE there is deliberately no 'Tasks' here any more: the task manager left
      // this rail on 2026-08-02 for the AdvShell header (WI-6844, owner ask) and is
      // now TasksRunningPill. Removing it was a REMOVAL from the end, so every
      // position above is untouched — which is exactly what this test exists to
      // prove about any change to the rail, additions and removals alike.
    ]);
  });

  // The collapsed icon rail is a SECOND rendering of the same TABS array, and the
  // owner navigates by it while collapsed — so it must carry the same order.
  it('keeps the collapsed icon rail in the same order as the expanded tabs', () => {
    H.blanketFlagOn = true;
    renderRail('?lsb=false');
    const railButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="left-sidebar-rail-"]'),
    )
      .map((el) => el.getAttribute('data-testid')!.replace('left-sidebar-rail-', ''))
      // drop the expand control that sits above the tab icons
      .filter((id) => id !== 'expand');
    expect(railButtons).toEqual([
      'accounts',
      // ('hives' was here — removed 2026-08-10 with the Pots tab. It joins
      // 'goal'/'blender'/'docs'/'tasks' as a RETIRED id: a stale `?lst=hives` no
      // longer matches the nuqs literal parser and falls through to the default.)
      'sentinel',
      'queen',
      // ('overwatch' was here — removed 2026-08-11 with the Kettle tab. It joins
      // 'hives'/'goal'/'blender'/'docs'/'tasks' as a RETIRED id: a stale
      // `?lst=overwatch` no longer matches the nuqs literal parser and falls
      // through to the default tab.)
      // ('goal' was here — removed 2026-08-09 with the Goals tab. It joins
      // 'blender'/'docs'/'tasks' as a RETIRED id: a stale `?lst=goal` no longer
      // matches the nuqs literal parser and falls through to the default tab.)
      'agents',
      'system',
      'spend',
      'conversations',
    ]);
  });

  // Subject is `system`, not the removed `hives` (2026-08-10). It must stay a
  // NON-DEFAULT, ungated, stubbed tab or the test stops proving anything: point it
  // at the default tab and it passes without the deep link doing any work.
  it('deep-links a tab from ?lst= and mounts only that panel', async () => {
    renderRail('?lst=system');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('system');
    expect(await screen.findByTestId('panel-system')).toBeTruthy();
    expect(screen.queryByTestId('panel-queen')).toBeNull();
  });

  // A retired tab id must not resolve. `hives` joins goal/blender/docs/tasks: the
  // nuqs literal parser no longer lists it, so a stale deep link falls through to
  // the default tab rather than rendering a blank rail.
  it('falls through to the default tab for the RETIRED ?lst=hives deep link', () => {
    renderRail('?lst=hives');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).not.toBe('hives');
    expect(screen.queryByTestId('panel-hives')).toBeNull();
  });

  it('collapses to the icon rail on ?lsb=false and unmounts the active panel', () => {
    renderRail('?lsb=false');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByTestId('panel-queen')).toBeNull();
    // The collapsed expand-rail icon buttons are present.
    expect(screen.getByTestId('left-sidebar-rail-system')).toBeTruthy();
    // ...and the removed Pots icon is NOT (2026-08-10) — the collapsed rail is a
    // second rendering of TABS, so a tab removed from one must vanish from both.
    expect(screen.queryByTestId('left-sidebar-rail-hives')).toBeNull();
  });

  it('clicking a tab switches the active panel and writes ?lst', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByTestId('left-sidebar-tab-system'));
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('system'));
    expect(await screen.findByTestId('panel-system')).toBeTruthy();
    expect(lastQuery()).toContain('lst=system');
  });

  it('the collapse button writes ?lsb=false', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    await waitFor(() => expect(lastQuery()).toContain('lsb=false'));
  });

  it('a collapsed icon-rail button expands AND selects its tab atomically (one write)', async () => {
    // ?lsb default is `true`, so the URL omits lsb=true once re-opened; assert the
    // observable rail state instead — both the expand (collapsed=false) AND the tab
    // selection (data-tab=accounts) must land from the single setRail write.
    renderRail('?lsb=false');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('left-sidebar-rail-accounts'));
    await waitFor(() => {
      const rail = screen.getByTestId('left-sidebar');
      expect(rail.getAttribute('data-collapsed')).toBe('false');
      expect(rail.getAttribute('data-tab')).toBe('accounts');
    });
    expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
  });

  it('the expand control is the TOPMOST collapsed-rail button and re-expands to the last pane without switching tabs (WI-4800)', async () => {
    // Subject moved off the removed `hives` to `system` (2026-08-10). It must be a
    // NON-DEFAULT tab (the default is 'queen') or "re-expands WITHOUT switching
    // tabs" would pass even if the tab silently reset.
    renderRail('?lsb=false&lst=system');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(rail.getAttribute('data-tab')).toBe('system');
    // The expand control is the FIRST button in the collapsed rail (topmost) —
    // the mirror of the collapse chevron, not buried under the tab icons.
    const railEl = document.querySelector('.pclsb__expand-rail');
    const firstBtn = railEl!.querySelector('button');
    expect(firstBtn?.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(firstBtn?.getAttribute('data-testid')).toBe('left-sidebar-rail-expand');
    // Clicking it re-expands to the SAME (last) pane — no tab switch.
    fireEvent.click(screen.getByTestId('left-sidebar-rail-expand'));
    await waitFor(() => {
      expect(rail.getAttribute('data-collapsed')).toBe('false');
    });
    expect(rail.getAttribute('data-tab')).toBe('system');
  });

  // WI-5162 (owner ask 2026-07-17): Fleet + Peers MOVED to the op-chat sidebar,
  // right of the 🎯 Pot Health button. They must be gone from this rail —
  // expanded tabs AND collapsed icon rail — or the owner sees them in two
  // places at once, which is exactly what the move was meant to end.
  it('no longer hosts the Fleet or Peers tabs — they moved to the op-chat sidebar (WI-5162)', () => {
    H.blanketFlagOn = true;
    renderRail();
    for (const gone of ['swarm', 'voice']) {
      expect(screen.queryByTestId(`left-sidebar-tab-${gone}`)).toBeNull();
      expect(screen.queryByTestId(`left-sidebar-rail-${gone}`)).toBeNull();
    }
    // The steering/settings tabs this rail kept are all still here. ('hives' left
    // this list on 2026-08-10 — the Pots tab was removed on owner directive, so
    // asserting it is KEPT would now be asserting the opposite of the intent.)
    for (const kept of ['accounts', 'queen', 'overwatch']) {
      expect(screen.getByTestId(`left-sidebar-tab-${kept}`)).toBeTruthy();
    }
    // ...and Pots is gone from BOTH renderings, same as Fleet/Peers above.
    expect(screen.queryByTestId('left-sidebar-tab-hives')).toBeNull();
    expect(screen.queryByTestId('left-sidebar-rail-hives')).toBeNull();
  });

  // A bookmarked ?lst=swarm must not wedge the rail on a tab that no longer
  // exists: the nuqs literal parser rejects it and falls back to the default.
  it('falls back to the default tab for a stale ?lst pointing at a moved tab (WI-5162)', () => {
    renderRail('?lst=swarm');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen');
  });

  it('hides the Overwatch tab while the OVERWATCH flag is off', () => {
    H.blanketFlagOn = false;
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
    // Other tabs are present.
    expect(screen.getByTestId('left-sidebar-tab-queen')).toBeTruthy();
  });

  it('shows the Overwatch tab when the flag is on', () => {
    H.blanketFlagOn = true;
    renderRail();
    expect(screen.getByTestId('left-sidebar-tab-overwatch')).toBeTruthy();
  });

  it('snaps a stale ?lst=overwatch back to Mug while the flag is off', async () => {
    H.blanketFlagOn = false;
    renderRail('?lst=overwatch');
    // The guard effect rewrites lst → queen (the default, so it's omitted from the
    // URL); assert the rail lands on the Mug tab + panel.
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen'));
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  // 🎯 Goals left this rail on 2026-08-09 (owner: "remove the goals middle pane
  // tab entirely. We already have a goals tab inside the hud tab lets just use
  // that."). Unlike Convos it is DELETED, not flag-gated — the owner asked for
  // two different things and the difference is the point, so this pair of tests
  // is what stops a later change "restoring" it by reflex.
  it('no longer hosts a Goals tab — the HUD Goals tab is the one goals surface', () => {
    H.blanketFlagOn = true;
    H.flags = { 'papercusp-conversations-rail-tab': true };
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-goal')).toBeNull();
    expect(screen.queryByTestId('left-sidebar-rail-goal')).toBeNull();
    // Its former neighbours are both still here — the removal came out of the
    // MIDDLE of the array, so this is the pair most likely to be disturbed.
    expect(screen.getByTestId('left-sidebar-tab-overwatch')).toBeTruthy();
    expect(screen.getByTestId('left-sidebar-tab-agents')).toBeTruthy();
  });

  it("retires the 'goal' id so a stale ?lst=goal falls through to the default tab", async () => {
    const { TAB_IDS } = await import('./LeftSidebar');
    expect(TAB_IDS).not.toContain('goal');
    // Deliberately UNLIKE the flag-gated Convos case: there is no snap-back
    // effect for `goal`, because nuqs's literal parser no longer accepts the
    // value at all — it never becomes the active tab in the first place.
    renderRail('?lst=goal');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen');
  });

  // ── 💬 Convos behind its testing flag (WI-37561) ─────────────────────────────
  // Owner directive 2026-08-09: "Put the 'convos' tab in the middle pane behind a
  // testing flag", with hidden-until-flipped chosen over a visible kill-switch.
  // CONVERSATIONS_RAIL_TAB is therefore DEFAULT OFF (a DARK_FLAGS 'parked' entry),
  // which makes the hidden case the DEFAULT rendering of this rail, not an edge.
  //
  // Each of these pins the flag EXPLICITLY via H.flags rather than leaning on the
  // blanket-off default. Relying on the default would keep them green if the gate
  // were deleted and the tab simply removed from TABS — the assertion has to fail
  // for the right reason, and "the flag is off" and "the entry is gone" are
  // different states with the same screen.
  describe('the Convos tab gate', () => {
    const CONVOS = 'papercusp-conversations-rail-tab';

    it('hides Convos from BOTH the tab strip and the collapsed icon rail while the flag is off', () => {
      // Everything else on, convos off — the configuration the single blanket
      // boolean could not express, and the one the owner actually ships.
      H.blanketFlagOn = true;
      H.flags = { [CONVOS]: false };
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-conversations')).toBeNull();
      // The collapsed rail is a SECOND rendering of TABS — a gate applied to only
      // one of the two leaves the tab reachable from the icon rail while invisible
      // in the strip, which is worse than not gating it at all.
      expect(screen.queryByTestId('left-sidebar-rail-conversations')).toBeNull();
      // The rail is otherwise intact: hiding the last tab must not disturb Spend,
      // the tab it sits beside.
      expect(screen.getByTestId('left-sidebar-tab-spend')).toBeTruthy();
    });

    it('shows Convos again the moment the flag is flipped on', () => {
      H.blanketFlagOn = true;
      H.flags = { [CONVOS]: true };
      renderRail();
      expect(screen.getByTestId('left-sidebar-tab-conversations')).toBeTruthy();
      expect(screen.getByTestId('left-sidebar-rail-conversations')).toBeTruthy();
    });

    it('mounts the Convos panel when the flag is on and the tab is selected', async () => {
      H.flags = { [CONVOS]: true };
      renderRail('?lst=conversations');
      expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('conversations');
      expect(await screen.findByTestId('panel-conversations')).toBeTruthy();
    });

    // The failure this prevents: `conversations` stays in TAB_IDS (so the flag can
    // be flipped back on without a code change), which means nuqs still PARSES a
    // bookmarked ?lst=conversations. Without the guard, `active` falls through to
    // visibleTabs[0] — Accounts — while ?lst= still reads `conversations`, so the
    // URL, `data-tab` and ui:get_state disagree with what is on screen.
    it('snaps a bookmarked ?lst=conversations back to Mug while the flag is off', async () => {
      H.flags = { [CONVOS]: false };
      renderRail('?lst=conversations');
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen'),
      );
      expect(await screen.findByTestId('panel-queen')).toBeTruthy();
      expect(screen.queryByTestId('panel-conversations')).toBeNull();
    });

    // The one failure the mocked useFlag above CANNOT see, and it is silent in the
    // expensive direction. `useFlag` resolves `current.flags[key] ?? FLAG_DEFAULTS[key]`
    // — so if `FLAGS.CONVERSATIONS_RAIL_TAB` were ever undefined at runtime (a typo, or
    // operator-vite resolving a stale second copy of @papercusp/flags — a documented
    // hazard in this tree), the lookup would be `FLAG_DEFAULTS[undefined]` → undefined →
    // falsy → tab hidden. The VISIBLE outcome would be exactly right, so every assertion
    // above would still pass, while the owner's flip at /admin/features could never turn
    // the tab back on. Pin the key against its wire value from the REAL module.
    it('resolves a defined flag key against the real flags module, so the flip can work', async () => {
      const { FLAGS } = await import('@papercusp/flags');
      expect(FLAGS.CONVERSATIONS_RAIL_TAB).toBe(CONVOS);
    });

    // The id must SURVIVE in TAB_IDS: it is what keeps the nuqs enum parsing the
    // deep link (so the snap-back above is reachable rather than a silent default)
    // and what makes flipping the flag on a /admin/features action instead of a
    // code change. A tab deleted outright would pass every assertion above.
    it('keeps `conversations` in TAB_IDS so the park is a flag flip, not a deletion', async () => {
      const { TAB_IDS } = await import('./LeftSidebar');
      expect(TAB_IDS).toContain('conversations');
    });
  });

  // MUG_KETTLE_SYSTEM (retire-mug-kettle-su-only-2026-08-09 P-012). Unlike the
  // three gates above, this one hides the rail's DEFAULT tab, so the interesting
  // assertions are not "is the tab gone" but "where does everything that used to
  // land on Mug land now". Note the polarity: OFF is the shipped end state here,
  // so this block describes production and the rest of the file describes the
  // testing escape hatch.
  describe('the Mug/Kettle tier gate', () => {
    // Re-declared rather than shared with the Convos block above: the two gates
    // are independent, and the cross-gate test below is the only place they meet.
    const CONVOS_KEY = 'papercusp-conversations-rail-tab';

    it('hides Mug AND Overwatch from both the tab strip and the collapsed icon rail while the tier is retired', () => {
      H.blanketFlagOn = true; // even with OVERWATCH explicitly ON
      H.mugKettleOn = false;
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-queen')).toBeNull();
      expect(screen.queryByTestId('left-sidebar-rail-queen')).toBeNull();
      expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
      expect(screen.queryByTestId('left-sidebar-rail-overwatch')).toBeNull();
      // The ungated rail is otherwise intact — removing two tabs from the middle
      // must not disturb their neighbours on either side.
      expect(screen.getByTestId('left-sidebar-tab-accounts')).toBeTruthy();
      expect(screen.getByTestId('left-sidebar-tab-agents')).toBeTruthy();
    });

    it('shows both again the moment the testing flag is flipped on', () => {
      H.blanketFlagOn = true;
      H.mugKettleOn = true;
      renderRail();
      expect(screen.getByTestId('left-sidebar-tab-queen')).toBeTruthy();
      expect(screen.getByTestId('left-sidebar-tab-overwatch')).toBeTruthy();
    });

    // The two gates on `overwatch` are an AND, and this is the direction that
    // matters: OVERWATCH is a SEPARATE flag an owner can flip at /admin/features,
    // and it must not resurrect a tab for a tier that cannot run. Asserting only
    // the tier-off case above would pass even if the gate were an OR.
    it('keeps Overwatch hidden when its own flag is ON but the tier is retired', () => {
      H.blanketFlagOn = true;
      H.mugKettleOn = false;
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
    });

    it('keeps Overwatch hidden when the tier is ON but its own OVERWATCH flag is off', () => {
      H.blanketFlagOn = false;
      H.mugKettleOn = true;
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
      // ...while Mug, gated only by the tier, is unaffected.
      expect(screen.getByTestId('left-sidebar-tab-queen')).toBeTruthy();
    });

    // THE DEFAULT-TAB FIX. The nuqs default is a static 'queen', so a first load
    // with no ?lst at all reads `queen` — a hidden tab. Without the snap-back the
    // rail renders Accounts (via `active`'s ?? visibleTabs[0]) while data-tab and
    // ui:get_state still say `queen`: the URL and the screen disagree.
    it('lands a fresh load on Accounts instead of the hidden default Mug tab', async () => {
      H.mugKettleOn = false;
      renderRail();
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
      expect(screen.queryByTestId('panel-queen')).toBeNull();
    });

    it('snaps a bookmarked ?lst=queen back to Accounts while the tier is retired', async () => {
      H.mugKettleOn = false;
      renderRail('?lst=queen');
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(screen.queryByTestId('panel-queen')).toBeNull();
    });

    it('snaps a bookmarked ?lst=overwatch back to Accounts while the tier is retired', async () => {
      H.blanketFlagOn = true;
      H.mugKettleOn = false;
      renderRail('?lst=overwatch');
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(screen.queryByTestId('panel-overwatch')).toBeNull();
    });

    // The OTHER gates' snap-backs used to hardcode 'queen' as their landing. With
    // the tier retired that target is itself hidden, so every one of them would
    // have snapped a stale deep link onto a tab that is not on screen — the exact
    // URL-vs-screen disagreement those snap-backs exist to prevent, reintroduced
    // one level up. This is the regression `homeTab` exists to stop, and it is
    // invisible unless a test crosses TWO gates at once.
    it('lands the OTHER gates’ snap-backs on Accounts too, not on the hidden Mug tab', async () => {
      H.mugKettleOn = false;
      H.flags = { [CONVOS_KEY]: false };
      renderRail('?lst=conversations');
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(screen.queryByTestId('panel-queen')).toBeNull();
      expect(screen.queryByTestId('panel-conversations')).toBeNull();
    });

    // Same reasoning as the Convos gate: the ids must SURVIVE so the flag stays a
    // flip rather than a code change, and so the snap-backs above are reachable
    // (a deleted id would not parse, and the deep link would silently default).
    it('keeps `queen` and `overwatch` in TAB_IDS so the retirement is a flag flip, not a deletion', async () => {
      const { TAB_IDS } = await import('./LeftSidebar');
      expect(TAB_IDS).toContain('queen');
      expect(TAB_IDS).toContain('overwatch');
    });

    it('resolves a defined flag key against the real flags module, so the flip can work', async () => {
      const { FLAGS } = await import('@papercusp/flags');
      expect(FLAGS.MUG_KETTLE_SYSTEM).toBe(MUG_KETTLE);
    });
  });

  it('renders nothing on a chromeless (iframe-target) route', () => {
    H.pathname = '/pi/some-embed';
    const { container } = render(
      <NuqsTestingAdapter>
        <LeftSidebar />
      </NuqsTestingAdapter>,
    );
    expect(container.querySelector('[data-testid="left-sidebar"]')).toBeNull();
  });

  it('reserves left-side layout space (body.has-left-sidebar) when docked', async () => {
    renderRail();
    await waitFor(() => expect(document.body.classList.contains('has-left-sidebar')).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--left-sidebar-w')).toBeTruthy();
  });

  // Agents + System (owner ask 2026-07-25, split 2026-07-26) — the automation-
  // control tabs. These exist so scheduled agents that SPEND TOKENS are visible and
  // pausable; if a refactor drops them from TABS the owner silently loses that
  // control again, which is exactly the failure they were added to fix.
  it('opens the Agents tab from ?lst=agents', async () => {
    renderRail('?lst=agents');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('agents');
    expect(await screen.findByTestId('panel-agents')).toBeTruthy();
    expect(screen.queryByTestId('panel-queen')).toBeNull();
  });

  it('opens the System tab from ?lst=system', async () => {
    renderRail('?lst=system');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('system');
    expect(await screen.findByTestId('panel-system')).toBeTruthy();
  });

  it('places Agents and System immediately after the kettle/overwatch tab', () => {
    renderRail();
    const ids = Array.from(document.querySelectorAll('[role="tab"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    const kettle = ids.indexOf('left-sidebar-tab-overwatch');
    const agents = ids.indexOf('left-sidebar-tab-agents');
    const system = ids.indexOf('left-sidebar-tab-system');
    expect(agents).toBeGreaterThan(-1);
    expect(system).toBe(agents + 1);
    // Overwatch is flag-gated, so only assert adjacency when it is actually rendered.
    if (kettle > -1) expect(agents).toBe(kettle + 1);
  });

  // The retired ids must not silently resolve to something else — a stale
  // `?lst=blender` bookmark falls through to the default tab (see the TABS note in
  // LeftSidebar.tsx).
  it('no longer resolves the retired blender / docs tab ids', () => {
    renderRail('?lst=blender');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).not.toBe('blender');
  });

  /**
   * The other half of the deep-link contract (owner report 2026-07-27: "what does
   * the Open Arming button do, it doesnt seem to do anything").
   *
   * `lst` is parseAsStringLiteral(TAB_IDS), so a link writing a NON-member id is
   * silently rejected and the rail falls back to its default tab. The Learning
   * tab's Open Arming button used to write the retired `blender` id: the test
   * above asserted blender does not resolve, and a LearningTab test asserted the
   * button writes blender — both passed, and between them they encoded a dead
   * button as intended behaviour. This test pins the LIVE target so a future tab
   * rename breaks here instead of silently neutering the button again. Keep it in
   * sync with LearningTab's ARMING_SIDEBAR_TAB.
   */
  it("resolves the tab Learning's Open Arming deep-links to (ARMING_SIDEBAR_TAB = 'agents')", () => {
    renderRail('?lst=agents');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('agents');
  });

  it('exports TAB_IDS containing that target, so deep-linkers can be validated', async () => {
    const { TAB_IDS } = await import('./LeftSidebar');
    expect(TAB_IDS).toContain('agents');
    expect(TAB_IDS).not.toContain('blender');
  });

});
