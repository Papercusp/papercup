// @vitest-environment jsdom
/**
 * The P-008 scope picker, asserted through the RENDER
 * (learning-pot-scope-gate-2026-08-30).
 *
 * The model's rules are asserted directly in learning-pot-picker.test.ts. What
 * that suite cannot see is whether the surface actually carries them — a model
 * is free to compute "switching on starts nothing" and a component free to
 * print nothing at all. So every test here asserts a rule SURVIVING THE RENDER,
 * and the write tests assert the ONE call D-007 requires rather than a loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type {
  AutomationArming,
  AutomationCatalog,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

const H = vi.hoisted(() => ({
  arming: null as AutomationArming | null,
  projects: [] as { slug: string; harness_kind?: string | null }[],
}));

vi.mock('@papercusp/sync', () => ({
  // Not decoration — useLexicon reaches flag-hooks, which subscribes to the
  // sync bus during render; omitting it throws mid-render and reports as a
  // failed FILE while individual assertions still say they passed.
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    const invalidate = vi.fn();
    if (queryName === 'harnessProjects.lite') {
      return { data: H.projects, loading: false, invalidate };
    }
    if (queryName !== 'automation.catalog' || !H.arming) {
      return { data: [], loading: false, invalidate };
    }
    const catalog: AutomationCatalog = {
      routines: [],
      categories: [],
      spend7d: [],
      spend7dTotalUsd: 0,
      arming: H.arming,
      generatedAt: '2026-08-31T00:00:00.000Z',
    };
    return { data: [catalog], loading: false, invalidate };
  },
}));

import LearningPotPicker from './LearningPotPicker';

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

function scope(disabledPots: string[]): AutomationArming['potScope'] {
  return {
    disabledPots,
    rows: disabledPots.map((potSlug) => ({
      potSlug,
      enabled: false,
      setBy: 'test',
      setAt: '2026-08-31T00:00:00.000Z',
    })),
  };
}

/**
 * The picker is URL-driven, so it opens by starting at its own key.
 *
 * Fixture projects default to `harness_kind:'hive'` — i.e. they are POTS. The
 * real `harnessProjects.lite` returns every project in the workspace and the
 * picker filters to pots, so a bare `{ slug }` fixture would model a repo and
 * be excluded. Pass an explicit `harness_kind` to model a non-pot on purpose.
 */
function renderPicker(
  a: AutomationArming | null,
  projects: { slug: string; harness_kind?: string | null }[],
) {
  H.arming = a;
  H.projects = projects.map((p) => ('harness_kind' in p ? p : { ...p, harness_kind: 'hive' }));
  return render(
    <NuqsTestingAdapter searchParams="?lpick=true">
      <LearningPotPicker />
    </NuqsTestingAdapter>,
  );
}

const rowNames = () =>
  [...document.querySelectorAll('.pc-potpick__name')].map((n) => n.textContent?.trim());

const rowFor = (slug: string): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>('.pc-potpick__row')].find((r) =>
    r.querySelector('.pc-potpick__name')?.textContent?.includes(slug),
  );
  if (!el) throw new Error(`no rendered row for ${slug}`);
  return el;
};

/**
 * The row's toggle is the shared Radix primitive (@/app/harness/Checkbox), which
 * renders a <button role="checkbox">, NOT a native <input type=checkbox> — the
 * design-primitives lint forbids a native one outside the primitive. Query the
 * ARIA role so this keeps hitting the real toggle target whichever element the
 * primitive renders.
 */
const checkboxFor = (slug: string): HTMLElement => {
  const box = rowFor(slug).querySelector<HTMLElement>('[role="checkbox"]');
  if (!box) throw new Error(`row ${slug} has no checkbox`);
  return box;
};

const button = (label: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
};

describe('the scope picker', () => {
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
    cleanup();
  });

  it('lists EVERY pot, not only the ones that learn', () => {
    renderPicker(arming({ gymPots: [gym('alpha')] }), [
      { slug: 'alpha' },
      { slug: 'beta' },
      { slug: 'gamma' },
    ]);
    expect(rowNames()).toHaveLength(3);
  });

  it('does NOT list workspace repos as if they were pots', () => {
    // Measured live 2026-08-30: this surface rendered 116 rows against 28 real
    // pots because it read the whole project listing. 38 were `papercusp/libs/*`
    // submodules — rows whose only possible outcome was a refused write.
    renderPicker(arming({ gymPots: [gym('alpha')] }), [
      { slug: 'alpha' },
      { slug: 'papercusp/libs/generic/cache', harness_kind: 'repo' },
      { slug: 'papercusp/papercusp-desktop', harness_kind: null },
    ]);
    expect(rowNames()).toEqual(['alpha']);
  });

  it('puts armed pots first', () => {
    renderPicker(arming({ gymPots: [gym('zeta'), gym('alpha', { enabled: false })] }), [
      { slug: 'zeta' },
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
    expect(rowNames()[0]).toContain('zeta');
  });

  it('STATES that switching on starts nothing when every lane is disarmed', () => {
    // The lie this prevents: a gate-shaped control reporting a pot as learning
    // when releasing the gate starts nothing at all (D-007). 47 of 54 live pots.
    renderPicker(arming({ gymPots: [gym('alpha', { enabled: false })] }), [{ slug: 'alpha' }]);
    expect(rowFor('alpha').textContent).toContain('starts nothing');
    expect(rowFor('alpha').textContent).toContain('arm Gym');
  });

  it('names the lane a NEVER-learned pot will start', () => {
    renderPicker(arming({}), [{ slug: 'fresh' }]);
    expect(rowFor('fresh').textContent).toContain('Never learned');
    expect(rowFor('fresh').textContent).toContain('starts Gym');
  });

  it('names the lanes that would RESUME for an armed pot', () => {
    renderPicker(
      arming({ gymPots: [gym('alpha')], lanes: [lane('alpha', { displayName: 'Fleet EKG' })] }),
      [{ slug: 'alpha' }],
    );
    expect(rowFor('alpha').textContent).toContain('resumes Gym, Fleet EKG');
  });

  it('paints an unreadable scope as unknown, never as on', () => {
    renderPicker(arming({ gymPots: [gym('alpha')], potScope: null }), [{ slug: 'alpha' }]);
    expect(rowFor('alpha').querySelector('.pc-potpick__state')?.textContent).toBe('unreadable');
  });

  it('reports a switched-off pot as off', () => {
    renderPicker(arming({ gymPots: [gym('alpha')], potScope: scope(['alpha']) }), [
      { slug: 'alpha' },
    ]);
    expect(rowFor('alpha').querySelector('.pc-potpick__state')?.textContent).toBe('off');
  });
});

describe('selection and the footer’s one write', () => {
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
    cleanup();
  });

  it('refuses to write with nothing selected', () => {
    renderPicker(arming({ gymPots: [gym('alpha')] }), [{ slug: 'alpha' }]);
    expect(button('Switch learning off').disabled).toBe(true);
  });

  it('sends the WHOLE selection in ONE call, not a call per pot', async () => {
    // D-007: set-pot-scope takes pots[] and is one atomic write + one audit
    // event, so a loop here would be both slower and a worse audit record.
    renderPicker(arming({ gymPots: [gym('alpha'), gym('beta')] }), [
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
    fireEvent.click(checkboxFor('alpha'));
    fireEvent.click(checkboxFor('beta'));
    await act(async () => {
      fireEvent.click(button('Switch learning off'));
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('learning:set-pot-scope');
    expect(calls[0].args.enabled).toBe(false);
    expect([...(calls[0].args.pots as string[])].sort()).toEqual(['alpha', 'beta']);
  });

  it('switches learning ON with the same single call', async () => {
    renderPicker(arming({ gymPots: [gym('alpha', { enabled: false })] }), [{ slug: 'alpha' }]);
    fireEvent.click(checkboxFor('alpha'));
    await act(async () => {
      fireEvent.click(button('Switch learning on'));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ pots: ['alpha'], enabled: true });
  });

  it('never writes a pot the search has hidden', async () => {
    // Select two, then narrow the search — the write must act on the VISIBLE
    // rows only, so a stale selection cannot flip a pot nobody can see.
    renderPicker(arming({ gymPots: [gym('alpha'), gym('beta')] }), [
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
    fireEvent.click(checkboxFor('alpha'));
    fireEvent.click(checkboxFor('beta'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^Search /i), { target: { value: 'alpha' } });
    });
    await act(async () => {
      fireEvent.click(button('Switch learning off'));
    });
    expect(calls[0].args.pots).toEqual(['alpha']);
  });

  it('filters the list by search', async () => {
    renderPicker(arming({ gymPots: [gym('alpha'), gym('beta')] }), [
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
    expect(rowNames()).toHaveLength(2);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^Search /i), { target: { value: 'bet' } });
    });
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain('beta');
  });

  it('select-all takes only the VISIBLE rows', async () => {
    renderPicker(arming({ gymPots: [gym('alpha'), gym('beta')] }), [
      { slug: 'alpha' },
      { slug: 'beta' },
    ]);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^Search /i), { target: { value: 'alpha' } });
    });
    fireEvent.click(button('Select all'));
    await act(async () => {
      fireEvent.click(button('Switch learning off'));
    });
    expect(calls[0].args.pots).toEqual(['alpha']);
  });

  it('surfaces a refusal instead of silently rendering the old state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          // set-pot-scope refuses an unknown slug precisely so a typo cannot
          // read as a successful switch-off; that refusal must reach the user.
          result: { content: [{ text: 'invalid_input: unknown pot slug' }] },
        }),
      })),
    );
    renderPicker(arming({ gymPots: [gym('alpha')] }), [{ slug: 'alpha' }]);
    fireEvent.click(checkboxFor('alpha'));
    await act(async () => {
      fireEvent.click(button('Switch learning off'));
    });
    expect(document.querySelector('.pc-potpick__err')?.textContent).toContain(
      'invalid_input: unknown pot slug',
    );
  });
});
