// @vitest-environment jsdom
/**
 * ChatRefPopupHost (WI-6601) — the single root-level mount of the chat
 * ref-pill popups.
 *
 * THE REGRESSION THIS PINS: the popups used to be mounted inside OperatorChat,
 * gated on that instance's own `harnessSlug`. The persistent chat sidebar is a
 * cross-harness surface that never receives one, so on any mount without a
 * resolvable `?slug` the drill-in wrote a correct `wpop=papercusp::WI-6594`
 * and NOTHING rendered it. The first test below is that exact case and fails
 * against the old code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const { nuqs, nuqsSetters, harness, phaseSpy, lazyRenderSpy } = vi.hoisted(() => ({
  phaseSpy: vi.fn(),
  lazyRenderSpy: vi.fn(),
  nuqs: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  // The surrounding surface's resolved harness (`?slug`), mutable per test.
  harness: { current: null as string | null },
}));
function mkNuqsSetter(key: string) {
  if (!nuqsSetters[key]) nuqsSetters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return nuqsSetters[key];
}
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d ?? null,
    mkNuqsSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
vi.mock('@/app/adv/create/use-create-data', () => ({
  useResolvedHarnessSlug: () => harness.current,
}));
vi.mock('../perf/perf-marks', () => ({
  markInteractionPhase: phaseSpy,
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));
// `lazyWithRetry` is React.lazy + a retry; in jsdom the dynamic import
// resolves on a microtask, which would force every assertion through
// findBy*. Render the module's default synchronously instead — this suite is
// about WHICH props the host computes, not about Suspense.
vi.mock('@papercusp/operator-core/lib/lazy-with-retry', () => ({
  lazyWithRetry: (loader: () => Promise<{ default: unknown }>) => {
    let Comp: any = null;
    void loader().then((m) => { Comp = m.default; });
    return (props: Record<string, unknown>) => {
      lazyRenderSpy();
      return Comp ? <Comp {...props} /> : null;
    };
  },
}));
// Tiny probes, gated on id/planSlug exactly like the real components, so a
// "closed" assertion means the same thing it does in production.
vi.mock('../work-items/WorkItemPopupModal', () => ({
  default: (props: Record<string, any>) =>
    props.id ? (
      <div data-testid="wi-popup" data-id={props.id} data-harness={props.harnessSlug ?? ''} />
    ) : null,
}));
vi.mock('../plans/PlanPopupModal', () => ({
  default: (props: Record<string, any>) =>
    props.planSlug ? (
      <div data-testid="plan-popup" data-plan={props.planSlug} data-harness={props.harnessSlug ?? ''} />
    ) : null,
}));

import ChatRefPopupHost, { loadPlanPopupModal, preloadPlanPopupModal } from './ChatRefPopupHost';

afterEach(() => {
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  harness.current = null;
  cleanup();
});

/** The lazy mock resolves its import on a microtask; flush it, then re-render. */
async function renderHost() {
  const utils = render(<ChatRefPopupHost />);
  await vi.waitFor(() => {});
  utils.rerender(<ChatRefPopupHost />);
  return utils;
}

describe('ChatRefPopupHost (WI-6601 — one mount, driven by the param)', () => {
  it('renders the first prepared popup synchronously without entering the lazy boundary', async () => {
    await preloadPlanPopupModal();
    lazyRenderSpy.mockClear();
    phaseSpy.mockClear();
    nuqs.wppop = 'papercusp::prepared-plan';
    render(<ChatRefPopupHost />);
    expect(screen.getByTestId('plan-popup').getAttribute('data-plan')).toBe('prepared-plan');
    expect(lazyRenderSpy).not.toHaveBeenCalled();
    expect(phaseSpy.mock.calls).toEqual([
      ['plan-popup-open', 'popup-module-requested'],
      ['plan-popup-open', 'popup-module-ready'],
    ]);
  });
  it('records lazy module request and completion separately from component mount', async () => {
    phaseSpy.mockClear();
    const module = await loadPlanPopupModal();
    expect(typeof module.default).toBe('function');
    expect(phaseSpy.mock.calls).toEqual([
      ['plan-popup-open', 'popup-module-requested'],
      ['plan-popup-open', 'popup-module-ready'],
    ]);
  });
  it('renders a harness-qualified `wpop` with NO surface harness at all', async () => {
    // ⇦ THE BUG. `?slug` absent ⇒ the old per-instance gate closed and nothing
    // mounted, even though the param names its own harness.
    harness.current = null;
    nuqs.wpop = 'papercusp::WI-6594';

    await renderHost();

    const popup = screen.getByTestId('wi-popup');
    expect(popup.getAttribute('data-id')).toBe('WI-6594');
    expect(popup.getAttribute('data-harness')).toBe('papercusp');
  });

  it('renders a harness-qualified `wppop` with no surface harness', async () => {
    harness.current = null;
    nuqs.wppop = 'papercusp::my-plan-2026-07-28';

    await renderHost();

    const popup = screen.getByTestId('plan-popup');
    expect(popup.getAttribute('data-plan')).toBe('my-plan-2026-07-28');
    expect(popup.getAttribute('data-harness')).toBe('papercusp');
  });

  it("prefers the REF's harness over the surface's when they disagree", async () => {
    // A session chat for harness X open over a board scoped to Y: the ref is
    // the stricter source, so scoping to `?slug` would open the wrong item.
    harness.current = 'other-harness';
    nuqs.wpop = 'papercusp::WI-6594';

    await renderHost();

    expect(screen.getByTestId('wi-popup').getAttribute('data-harness')).toBe('papercusp');
  });

  it('falls back to the surface harness for a BARE (pre-WI-6601) value', async () => {
    // Back-compat: links minted before the value carried a harness.
    harness.current = 'papercusp';
    nuqs.wpop = 'WI-6594';
    nuqs.wppop = 'my-plan-2026-07-28';

    await renderHost();

    expect(screen.getByTestId('wi-popup').getAttribute('data-id')).toBe('WI-6594');
    expect(screen.getByTestId('wi-popup').getAttribute('data-harness')).toBe('papercusp');
    expect(screen.getByTestId('plan-popup').getAttribute('data-harness')).toBe('papercusp');
  });

  it('renders nothing when neither param is set', async () => {
    harness.current = 'papercusp';

    await renderHost();

    expect(screen.queryByTestId('wi-popup')).toBeNull();
    expect(screen.queryByTestId('plan-popup')).toBeNull();
  });

  it('renders both popups at once when both params are set', async () => {
    harness.current = null;
    nuqs.wpop = 'papercusp::WI-1';
    nuqs.wppop = 'other::plan-2';

    await renderHost();

    expect(screen.getByTestId('wi-popup').getAttribute('data-harness')).toBe('papercusp');
    expect(screen.getByTestId('plan-popup').getAttribute('data-harness')).toBe('other');
  });

  it('renders EXACTLY ONE popup per param (the duplicate-stack the old gate guarded)', async () => {
    // The per-instance gate existed to stop two chat instances double-rendering
    // one global param. A singleton must not reintroduce that.
    harness.current = 'papercusp';
    nuqs.wpop = 'papercusp::WI-6594';

    await renderHost();

    expect(screen.getAllByTestId('wi-popup')).toHaveLength(1);
  });
});
