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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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

function renderRail(a: AutomationArming | null) {
  H.arming = a;
  H.queries.length = 0;
  return render(<LearningPotRail />);
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
