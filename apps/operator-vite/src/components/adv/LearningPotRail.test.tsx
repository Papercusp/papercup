// @vitest-environment jsdom
/**
 * LearningPotRail render coverage (learning-pot-scope-gate-2026-08-30, P-006).
 *
 * The MODEL's rules are already asserted directly in learning-pot-rail.test.ts.
 * What that suite cannot see is whether the rendered chip actually carries them
 * — a component is free to compute 'unknown' and then paint it green. So every
 * test here asserts a rule SURVIVING THE RENDER, via the `data-` attributes and
 * assistive text the CSS and screen readers key on, and one test asserts the
 * wiring itself: that the rail reads `automation.catalog`, without which the
 * whole component renders a permanently empty rail and nobody notices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type {
  AutomationArming,
  AutomationCatalog,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

const H = vi.hoisted(() => ({
  arming: null as AutomationArming | null,
  queries: [] as string[],
}));

vi.mock('@papercusp/sync', () => ({
  // `onSyncBusEvent` is NOT decoration: the rail's `useLexicon` reaches
  // flag-hooks, which subscribes to the sync bus at first render. A mock that
  // omits it makes vitest throw on property access DURING RENDER — which
  // surfaces as an unhandled error and a FAILED file while all 11 assertions
  // still report passing (a-failure-that-fails-no-assertion-2026-07-12).
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    H.queries.push(queryName);
    const invalidate = vi.fn();
    if (queryName !== 'automation.catalog') return { data: [], loading: false, invalidate };
    if (!H.arming) return { data: [], loading: false, invalidate };
    const catalog: AutomationCatalog = {
      routines: [],
      categories: [],
      spend7d: [],
      spend7dTotalUsd: 0,
      arming: H.arming,
      generatedAt: '2026-08-30T20:00:00.000Z',
    };
    return { data: [catalog], loading: false, invalidate };
  },
}));

import LearningPotRail from './LearningPotRail';

function gym(harnessSlug: string, over: Partial<AutomationGymArm> = {}): AutomationGymArm {
  return { harnessSlug, enabled: true, budgetUsd: 10, spentUsd: 1, status: 'idle', ...over };
}

function lane(potSlug: string, over: Partial<AutomationLaneArm> = {}): AutomationLaneArm {
  return {
    loopId: `${potSlug}-lane`,
    displayName: `${potSlug} lane`,
    potSlug,
    enabled: true,
    budgetUsd: 5,
    budgetKind: 'lifetime',
    spentUsd: 1,
    enforcement: 'hard',
    ...over,
  };
}

function arming(over: Partial<AutomationArming> = {}): AutomationArming {
  return { gymPots: [], lanes: [], scoutCeiling: null, potScope: null, ...over };
}

/** Every stored row carries an audit stamp; the tests only care about disabledPots. */
function scope(disabledPots: string[]): AutomationArming['potScope'] {
  return {
    disabledPots,
    rows: disabledPots.map((potSlug) => ({
      potSlug,
      enabled: false,
      setBy: 'test',
      setAt: '2026-08-30T00:00:00.000Z',
    })),
  };
}

/**
 * The adapter is REQUIRED, not ceremony: P-008 made the rail's `+N idle` chip
 * open the scope picker, and that open state is URL state (nuqs), per the repo
 * rule that anything user-meaningful is addressable — which is also what lets
 * P-009 retarget its call sites at the picker. Without an adapter every render
 * here throws "nuqs requires an adapter" before a single assertion runs.
 */
function renderRail(a: AutomationArming | null) {
  H.arming = a;
  H.queries.length = 0;
  return render(
    <NuqsTestingAdapter>
      <LearningPotRail />
    </NuqsTestingAdapter>,
  );
}

function chips(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.pc-potrail__chip')];
}

function segment(chip: HTMLElement, label: string): HTMLElement {
  const found = [...chip.querySelectorAll<HTMLElement>('.pc-potrail__seg')].find((seg) =>
    (seg.getAttribute('aria-label') ?? '').startsWith(`${label} `),
  );
  if (!found) throw new Error(`no "${label}" segment on chip ${chip.textContent}`);
  return found;
}

afterEach(() => {
  cleanup();
  H.arming = null;
});

describe('LearningPotRail', () => {
  it('reads automation.catalog — the wiring the whole rail depends on', () => {
    renderRail(arming({ gymPots: [gym('papercusp')], potScope: scope([]) }));
    expect(H.queries).toContain('automation.catalog');
  });

  it('renders one chip per pot that is actually learning', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('papercusp')], lanes: [lane('acme')], potScope: scope([]) }),
    );
    expect(chips(container).map((c) => c.textContent)).toHaveLength(2);
  });

  it('renders nothing at all when no pot is learning', () => {
    const { container } = renderRail(arming({ potScope: scope([]) }));
    expect(container.querySelector('.pc-potrail')).toBeNull();
  });

  it('renders nothing while the catalog has not arrived', () => {
    const { container } = renderRail(null);
    expect(container.querySelector('.pc-potrail')).toBeNull();
  });

  it('KEEPS a switched-off pot on the rail, marked off — it is the surface that switches it back on', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('papercusp'), gym('acme')], potScope: scope(['acme']) }),
    );
    const byPot = chips(container).map((c) => c.getAttribute('data-learning'));
    expect(byPot).toHaveLength(2);
    expect(byPot).toContain('off');
    expect(byPot).toContain('on');
  });

  it('paints an unreadable scope as unknown, NEVER as on', () => {
    const { container } = renderRail(arming({ gymPots: [gym('papercusp')], potScope: null }));
    const [chip] = chips(container);
    expect(chip.getAttribute('data-learning')).toBe('unknown');
    expect(chip.textContent).toContain('learning unreadable');
  });

  it('distinguishes a gym that was never set up from one switched off', () => {
    const { container } = renderRail(
      // papercusp has a lane but no gym row (absent); acme has a disarmed gym
      // (off) PLUS an armed lane, which is what keeps it on the rail at all —
      // a disarmed gym and nothing else would be dormant, and dormant chips do
      // not render.
      arming({
        gymPots: [gym('acme', { enabled: false, spentUsd: 0 })],
        lanes: [lane('papercusp'), lane('acme')],
        potScope: scope([]),
      }),
    );
    const byPot = new Map(
      chips(container).map((c) => [c.textContent?.includes('acme') ? 'acme' : 'papercusp', c]),
    );
    expect(segment(byPot.get('papercusp')!, 'gym').dataset.state).toBe('absent');
    expect(segment(byPot.get('acme')!, 'gym').dataset.state).toBe('off');
  });

  it('reports a lane segment as armed/total, and as on while ANY lane is armed', () => {
    const { container } = renderRail(
      arming({
        lanes: [lane('papercusp'), lane('papercusp', { loopId: 'b', enabled: false })],
        potScope: scope([]),
      }),
    );
    const lanes = segment(chips(container)[0], 'lanes');
    expect(lanes.dataset.state).toBe('on');
    expect(lanes.textContent).toContain('1/2');
  });

  it('reports a segment’s OWN arming even when the pot switch is off', () => {
    // The restore property: switching the pot back on must restore what was
    // armed, so the gym segment may NOT be collapsed into the master switch.
    const { container } = renderRail(
      arming({ gymPots: [gym('papercusp', { enabled: true })], potScope: scope(['papercusp']) }),
    );
    const [chip] = chips(container);
    expect(chip.getAttribute('data-learning')).toBe('off');
    expect(segment(chip, 'gym').dataset.state).toBe('on');
  });

  it('marks the spend as a floor, because scout spend is not attributable per pot', () => {
    const { container } = renderRail(
      arming({
        gymPots: [gym('papercusp', { spentUsd: 2.5 })],
        lanes: [lane('papercusp', { spentUsd: 1.25 })],
        potScope: scope([]),
      }),
    );
    expect(
      container.querySelector('.pc-potrail__spend')?.textContent,
    ).toBe('$3.75+');
  });

  it('summarises the dormant tail instead of rendering it as chips', () => {
    // The shape measured live: a handful armed, a long tail of configured-but-idle.
    const { container } = renderRail(
      arming({
        gymPots: [
          gym('armed', { spentUsd: 4 }),
          ...['i1', 'i2', 'i3'].map((s) => gym(s, { enabled: false, spentUsd: 0 })),
        ],
        potScope: scope([]),
      }),
    );
    const rendered = chips(container).filter((c) => !c.className.includes('--dormant'));
    expect(rendered).toHaveLength(1);
    expect(container.querySelector('.pc-potrail__dormant')?.textContent).toBe('+3 idle');
  });

  /**
   * P-052 REGRESSION GUARD — the summary must not rename a decision.
   *
   * Before P-052 this bucket held only configured-but-unarmed pots, and the
   * tooltip said so in as many words: "They are not switched off." Making
   * switched-off pots dormant put exactly the denied population into it, and
   * the owner's real 28-pot pause makes that population EVERYTHING — so the one
   * affordance accounting for the whole rail would have described 26
   * deliberately paused pots as incidentally idle. Nothing throws; the count
   * stays right; only the meaning is wrong, which is why it needs a test.
   */
  it('calls a switched-off tail OFF, not idle — the summary must not relabel a decision', () => {
    const slugs = ['a', 'b', 'c'];
    const { container } = renderRail(
      arming({
        gymPots: slugs.map((s) => gym(s, { enabled: false })),
        potScope: scope(slugs),
      }),
    );
    const btn = container.querySelector('.pc-potrail__dormant');
    expect(btn?.textContent).toBe('+3 off');
    // The tooltip is a Radix portal that only exists on hover, so the summary
    // also has to reach a screen reader as the button's accessible name —
    // otherwise the only control accounting for the hidden tail announces "+3
    // off" and nothing else.
    const said = btn?.getAttribute('aria-label') ?? '';
    expect(said).toContain('3 switched off deliberately');
    expect(said).not.toContain('not switched off');
  });

  it('distinguishes a MIXED tail — switched-off and merely-unarmed are different facts', () => {
    const { container } = renderRail(
      arming({
        gymPots: [gym('off1', { enabled: false }), gym('idle1', { enabled: false })],
        potScope: scope(['off1']),
      }),
    );
    const btn = container.querySelector('.pc-potrail__dormant');
    expect(btn?.textContent).toBe('+2 quiet');
    const said = btn?.getAttribute('aria-label') ?? '';
    expect(said).toContain('1 switched off deliberately');
    expect(said).toContain('1 with a learning setup');
  });

  it('renders no dormant summary when every pot is actually learning', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('armed')], potScope: scope([]) }),
    );
    expect(container.querySelector('.pc-potrail__dormant')).toBeNull();
  });

  it('still renders a rail when EVERY pot is dormant — the count, not nothing', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('i1', { enabled: false })], potScope: scope([]) }),
    );
    expect(container.querySelector('.pc-potrail__dormant')?.textContent).toBe('+1 idle');
  });

  it('orders switched-off pots last so the live ones read first', () => {
    const { container } = renderRail(
      arming({
        gymPots: [gym('aaa'), gym('zzz')],
        potScope: scope(['aaa']),
      }),
    );
    expect(chips(container).map((c) => c.getAttribute('data-learning'))).toEqual(['on', 'off']);
  });
});

/**
 * THE PER-POT POPOVER (P-007).
 *
 * The chip stopped being inert here, so these assert the two things a control
 * surface can get wrong in ways a render test above cannot see: WHICH tool a
 * switch fires (with which args), and whether the panel tells the truth about
 * state it could not read. Writes go through the gated `/api/agent-mcp/run-tool`
 * bridge, so `fetch` is the seam — asserting the tool NAME and ARGS is asserting
 * the actual contract, not a click handler's existence.
 */
describe('the per-pot popover', () => {
  let calls: Array<{ name: string; args: Record<string, unknown> }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        calls.push(JSON.parse(init?.body ?? '{}'));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { content: [{ text: JSON.stringify({ ok: true }) }] },
          }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Open the Nth chip's panel. Radix portals the content, so it lands in body. */
  function openChip(container: HTMLElement, index = 0): HTMLElement {
    const trigger = chips(container)[index].querySelector<HTMLElement>('.pc-potrail__trigger');
    if (!trigger) throw new Error('chip has no popover trigger');
    fireEvent.click(trigger);
    const panel = document.body.querySelector<HTMLElement>('.pc-potrail__pop');
    if (!panel) throw new Error('popover did not open');
    return panel;
  }

  /** The switch on the row whose name cell reads `name`. */
  function armSwitch(panel: HTMLElement, name: string): HTMLButtonElement {
    const row = [...panel.querySelectorAll<HTMLElement>('.pc-potrail__poprow')].find(
      (r) => r.querySelector('.pc-potrail__popname')?.textContent?.trim() === name,
    );
    if (!row) throw new Error(`no row named ${name} in the panel`);
    const btn = row.querySelector<HTMLButtonElement>('.pc-potrail__arm');
    if (!btn) throw new Error(`row ${name} has no arm switch`);
    return btn;
  }

  it('makes the chip a real trigger and opens a panel', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: scope([]) }),
    );
    expect(chips(container)[0].querySelector('.pc-potrail__trigger')).not.toBeNull();
    expect(openChip(container).textContent).toContain('alpha');
  });

  it('fires learning:set-pot-scope for the MASTER switch, with this pot and the flipped value', async () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: scope([]) }),
    );
    const panel = openChip(container);
    await act(async () => {
      fireEvent.click(armSwitch(panel, 'Learning'));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('learning:set-pot-scope');
    // Pot is currently ON (empty scope), so the click must switch it OFF.
    expect(calls[0].args).toMatchObject({ pots: ['alpha'], enabled: false });
  });

  it('fires gym:arm for the gym row and governor:arm for a lane row', async () => {
    const { container } = renderRail(
      arming({
        gymPots: [gym('alpha')],
        lanes: [lane('alpha', { loopId: 'dream:alpha', displayName: 'dream' })],
        potScope: scope([]),
      }),
    );
    let panel = openChip(container);
    await act(async () => {
      fireEvent.click(armSwitch(panel, 'Gym'));
    });
    expect(calls[0].name).toBe('gym:arm');
    expect(calls[0].args).toMatchObject({ harness: 'alpha', enabled: false });

    panel = document.body.querySelector<HTMLElement>('.pc-potrail__pop')!;
    await act(async () => {
      fireEvent.click(armSwitch(panel, 'dream'));
    });
    expect(calls[1].name).toBe('governor:arm');
    expect(calls[1].args).toMatchObject({ loopId: 'dream:alpha', enabled: false });
  });

  it('offers EXPLICIT on/off when the scope is unreadable, instead of a switch asserting a position it never read', async () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: null }),
    );
    const panel = openChip(container);
    const row = [...panel.querySelectorAll<HTMLElement>('.pc-potrail__poprow')].find(
      (r) => r.getAttribute('data-master') === '1',
    )!;
    // No two-state toggle on an unreadable scope...
    expect(row.querySelector('.pc-potrail__arm')).toBeNull();
    // ...but the write is still well defined, so recovery must be reachable
    // from the only surface that can perform it.
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('.pc-potrail__poptext')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Switch on', 'Switch off']);
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(calls[0].args).toMatchObject({ pots: ['alpha'], enabled: true });
  });

  it('KEEPS lane switches operable while the pot is off — a lane owns its own arming', async () => {
    // Rule 3: switching the pot back on must restore exactly what was armed, so
    // arming a lane on a switched-off pot is meaningful, not a no-op to disable.
    //
    // ⚠ P-052 CHANGED THIS FIXTURE, NOT THE RULE. A switched-off pot with
    // NOTHING armed is now dormant, so it has no chip and no popover — this
    // test cannot reach the switches that way any more. The requirement did not
    // go away, it MOVED: that case is asserted in LearningPotDrawer.test.tsx
    // ('arms a lane on a switched-off idle pot — the case the rail no longer
    // carries'). What the RAIL still owns is the case where the chip survives:
    // an off pot with a lane already armed. So `l2` is armed here purely to
    // keep the chip on the rail; `l1` is the disarmed lane under test, and the
    // assertion below is the original one, unweakened.
    const { container } = renderRail(
      arming({
        gymPots: [gym('alpha', { enabled: false })],
        lanes: [
          lane('alpha', { loopId: 'l1', displayName: 'lane one', enabled: false }),
          lane('alpha', { loopId: 'l2', displayName: 'lane two', enabled: true }),
        ],
        potScope: scope(['alpha']),
      }),
    );
    const panel = openChip(container);
    const laneBtn = armSwitch(panel, 'lane one');
    expect(laneBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(laneBtn);
    });
    expect(calls[0]).toMatchObject({
      name: 'governor:arm',
      args: { loopId: 'l1', enabled: true },
    });
  });

  it('gives Scout NO switch, because no per-pot scout arming exists to write', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: scope([]) }),
    );
    const panel = openChip(container);
    const scoutRow = [...panel.querySelectorAll<HTMLElement>('.pc-potrail__poprow')].find(
      (r) => r.querySelector('.pc-potrail__popname')?.textContent?.trim() === 'Scout',
    );
    expect(scoutRow).toBeDefined();
    expect(scoutRow!.querySelector('.pc-potrail__arm')).toBeNull();
    expect(scoutRow!.textContent).toContain('follows the pot switch');
  });

  it('surfaces a refusal from the bridge instead of silently rendering the old state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          // A validation failure arrives as PLAIN TEXT, not JSON — the exact
          // case the shared run-tool helper exists to preserve.
          result: { content: [{ text: 'invalid_input: unknown pot slug' }] },
        }),
      })),
    );
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: scope([]) }),
    );
    const panel = openChip(container);
    await act(async () => {
      fireEvent.click(armSwitch(panel, 'Learning'));
    });
    expect(
      document.body.querySelector('.pc-potrail__poperr')?.textContent,
    ).toContain('invalid_input: unknown pot slug');
  });

  /**
   * The shared <Popover> paints NO surface: RP.Content gets only zIndex plus
   * the caller's `contentClassName` (harness/Popover.tsx). So a caller that
   * passes a class it never styles renders a TRANSPARENT panel — the page's
   * own text reads straight through the rows.
   *
   * This shipped once, and nothing caught it: the four live DOM assertions
   * (rows present, master first, Scout switchless, head named) were all TRUE
   * of an invisible panel, because structure is exactly what an unpainted
   * surface preserves. A screenshot caught it. This is that screenshot's
   * falsifiable form — it fails if the surface class loses its background,
   * or is renamed in the TSX without the stylesheet following.
   */
  it('paints the popover surface opaque — the primitive supplies none', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha')], potScope: scope([]) }),
    );
    const panel = openChip(container);
    const surface = panel.closest<HTMLElement>('[role="dialog"]');
    if (!surface) throw new Error('popover content element not found');

    const classes = [...surface.classList];
    expect(classes.length).toBeGreaterThan(0);

    const css = [...container.querySelectorAll('style')]
      .map((s) => s.textContent ?? '')
      .join('\n');
    const paints = classes.some((cls) => {
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
      return !!rule && /background\s*:/.test(rule[1]);
    });
    expect(
      paints,
      `none of [${classes.join(', ')}] declares a background, so the panel is ` +
        `transparent and the page shows through it`,
    ).toBe(true);
  });
});

/**
 * P-008 wired the rail's `+N idle` chip to the every-pot scope picker.
 *
 * D-005 designated THIS chip as the picker's trigger and deliberately left it
 * inert until the picker existed — "wire it there rather than adding a second
 * entry point" — so a dormant pot's ONLY route to its controls runs through
 * here. If this chip stops opening the picker, 47 of 54 pots silently lose
 * every control they have, and nothing else in this suite would notice: the
 * chip still renders, still counts correctly, and still reads the same.
 */
describe('the idle chip opens the scope picker', () => {
  it('is a real button, not inert text', () => {
    const { container } = renderRail(
      arming({ gymPots: [gym('alpha', { enabled: false })], potScope: scope([]) }),
    );
    const idle = container.querySelector('.pc-potrail__dormant');
    expect(idle).not.toBeNull();
    expect(idle?.tagName).toBe('BUTTON');
  });

  it('writes the picker’s URL key when clicked', async () => {
    // URL state, not component state — that is what lets P-009 retarget its
    // three useOpenArming call sites at this picker.
    H.arming = arming({
      gymPots: [gym('alpha', { enabled: false })],
      potScope: scope([]),
    });
    const updates: string[] = [];
    const { container } = render(
      <NuqsTestingAdapter onUrlUpdate={(e) => updates.push(e.queryString)}>
        <LearningPotRail />
      </NuqsTestingAdapter>,
    );

    const idle = container.querySelector<HTMLElement>('.pc-potrail__dormant');
    if (!idle) throw new Error('no idle chip rendered');
    // nuqs THROTTLES its URL write, so asserting straight after the click reads
    // an empty update list and looks exactly like a chip that is not wired.
    await act(async () => {
      fireEvent.click(idle);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(updates.join('&')).toContain('lpick=true');
  });
});
