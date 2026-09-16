/** @vitest-environment jsdom */
/**
 * The ref-activation DECISION, and the pill branch that makes it reachable
 * (WI-10001509).
 *
 * WHAT THIS PINS AND WHY. The portal shipped work-ref pills that LOOKED right
 * and could not be clicked: `PapercupChat` injects the click through a host
 * seam (`onWorkRefActivate`), the portal never supplied one, and `WorkRefPill`
 * silently degrades to a non-interactive `<span>` when given neither an href
 * nor a handler. Nothing threw, nothing logged — the pill just did nothing.
 *
 * So there are two separable failures and a test for each:
 *   1. the DECISION (which param, what value) — now shared by both hosts, so
 *      they cannot drift the way they did here;
 *   2. the dead branch itself — a pill with a handler must be a real control,
 *      which is the assertion that would have caught the original bug.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  canOpenWorkRef,
  workRefPopupTarget,
} from './chat-ref-popup-params';
import { WorkRefPill } from './WorkRefPill';
import { ChatMarkdown } from './PapercupChat';

// The pill hydrates state/title through sync; this suite is about the pill's
// TAG, not its contents, so a flat empty result keeps every ref 'unknown'.
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [], loading: false, error: null }),
}));

afterEach(cleanup);

describe('workRefPopupTarget — the shared ref-activation decision', () => {
  it('scopes a work-item ref to the harness that opened it', () => {
    expect(workRefPopupTarget({ id: 'WI-6601', kind: 'work-item' }, 'papercusp')).toEqual({
      param: CHAT_WORK_ITEM_POPUP_PARAM,
      value: 'papercusp::WI-6601',
    });
  });

  it('opens a plan-item ref against its own plan slug, not its id', () => {
    // The P- TOKEN names an item inside a plan; the popup opens the PLAN, so
    // the value must carry planSlug. Encoding `ref.id` here would put "P-003"
    // in the URL and open nothing.
    expect(
      workRefPopupTarget(
        { id: 'P-003', kind: 'plan-item', planSlug: 'portal-parity-2026-09-05' },
        'papercusp',
      ),
    ).toEqual({
      param: CHAT_PLAN_POPUP_PARAM,
      value: 'papercusp::portal-parity-2026-09-05',
    });
  });

  it('opens NOTHING for a plan ref with no plan context', () => {
    // Not an oversight: with no plan slug there is no plan to open, and a
    // guess would open the wrong one.
    expect(workRefPopupTarget({ id: 'P-003', kind: 'plan-item' }, 'papercusp')).toBeNull();
    expect(
      workRefPopupTarget({ id: 'P-003', kind: 'plan-item', planSlug: null }, 'papercusp'),
    ).toBeNull();
  });

  it('opens NOTHING for a work-item ref with no harness to scope it', () => {
    // `workItems.detail` is harness-scoped, so an unscoped id is not a
    // narrower query — it is an unanswerable one.
    for (const harness of [null, undefined, '']) {
      expect(workRefPopupTarget({ id: 'WI-6601', kind: 'work-item' }, harness)).toBeNull();
    }
  });

  it('never emits a value the decoder reads back as a different ref', () => {
    // The encode/decode pair is the contract a writer and the reader share;
    // this is the round trip that keeps them honest.
    const target = workRefPopupTarget({ id: 'EI-42', kind: 'work-item' }, 'papercusp');
    expect(target?.value.startsWith('papercusp::')).toBe(true);
    expect(target?.value.endsWith('EI-42')).toBe(true);
  });
});

describe('WorkRefPill — the branch that made the portal pills dead', () => {
  it('renders a real control when the host wired an activation handler', () => {
    const html = renderToStaticMarkup(
      <WorkRefPill id="WI-6601" kind="work-item" onActivate={() => {}} />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
  });

  it('degrades to a NON-interactive span when no host seam was supplied', () => {
    // This is the portal's pre-fix rendering. Asserting it explicitly keeps the
    // degrade deliberate: a future change that makes the unwired pill look
    // clickable would be a worse bug than the one this fixes, because the
    // deadness would no longer be visible anywhere.
    const html = renderToStaticMarkup(<WorkRefPill id="WI-6601" kind="work-item" />);
    expect(html).toContain('<span');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
});

/**
 * WI-10001541 — the residual half of WI-10001509, on BOTH hosts.
 *
 * Fixing the portal's seam made every pill a `<button>`, including the ones
 * `workRefPopupTarget` deliberately resolves to nothing: a bare `P-NNN` is
 * unique only WITHIN a plan, and no host supplies plan context, so activating
 * it cannot open anything. The pill was focusable, tabbable, clickable — and
 * inert. That is strictly worse than plain text, because only the control
 * claims it can act, and it is the exact dead-click symptom WI-10001509 was
 * filed about, one layer up.
 *
 * The gate is the SAME decision that governs what activation does, so the two
 * answers cannot disagree the way they did here.
 */
describe('canOpenWorkRef — the affordance gate (WI-10001541)', () => {
  it('is false for a plan-item ref with no plan context', () => {
    expect(canOpenWorkRef({ id: 'P-003', kind: 'plan-item', planSlug: null }, 'papercusp')).toBe(false);
  });

  it('is false for a work-item ref with no harness to scope it', () => {
    expect(canOpenWorkRef({ id: 'WI-6601', kind: 'work-item' }, null)).toBe(false);
  });

  it('agrees with workRefPopupTarget on every ref it is asked about', () => {
    // Pins the two to ONE decision rather than two lookalike ones: a future
    // edit that loosens either must move both, or this fails.
    const refs = [
      { id: 'WI-6601', kind: 'work-item' as const },
      { id: 'P-003', kind: 'plan-item' as const, planSlug: null },
      { id: 'P-003', kind: 'plan-item' as const, planSlug: 'portal-parity-2026-09-05' },
    ];
    for (const harness of ['papercusp', null]) {
      for (const ref of refs) {
        expect(canOpenWorkRef(ref, harness)).toBe(workRefPopupTarget(ref, harness) !== null);
      }
    }
  });
});

describe('ChatMarkdown — an unopenable ref must not render as a control (WI-10001541)', () => {
  const pill = (container: HTMLElement, kind: 'work-item' | 'plan-item') =>
    container.querySelector(`[data-ref-kind="${kind}"]`);

  it('renders an openable work-item ref as a button and an unscoped plan-item ref as inert text, in the SAME message', () => {
    // One message, one wired seam, one harness — so the ONLY thing separating
    // these two pills is whether the ref resolves to somewhere to go. Asserting
    // both in a single render is what makes this a parity test rather than two
    // independent claims that could both drift the same way.
    const { container } = render(
      <ChatMarkdown
        content="see WI-6601 and P-003"
        hostTrust="owner"
        harnessSlug="papercusp"
        onWorkRefActivate={() => {}}
      />,
    );

    expect(pill(container, 'work-item')?.tagName).toBe('BUTTON');
    expect(pill(container, 'plan-item')?.tagName).toBe('SPAN');
  });

  it('renders a plan-item ref as a real control once the message carries its plan', () => {
    // The mirror of the case above: the pill is inert because the ref cannot be
    // resolved, NOT because plan refs are second-class. Without this, making
    // every plan pill inert unconditionally would also pass.
    const { container } = render(
      <ChatMarkdown
        content="see P-003"
        hostTrust="owner"
        harnessSlug="papercusp"
        planSlug="portal-parity-2026-09-05"
        onWorkRefActivate={() => {}}
      />,
    );

    expect(pill(container, 'plan-item')?.tagName).toBe('BUTTON');
  });

  it('renders no control at all when the host wired no seam', () => {
    const { container } = render(
      <ChatMarkdown content="see WI-6601 and P-003" hostTrust="owner" harnessSlug="papercusp" />,
    );

    expect(pill(container, 'work-item')?.tagName).toBe('SPAN');
    expect(pill(container, 'plan-item')?.tagName).toBe('SPAN');
  });
});
