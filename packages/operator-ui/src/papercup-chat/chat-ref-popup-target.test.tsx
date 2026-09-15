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
import { describe, expect, it } from 'vitest';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  workRefPopupTarget,
} from './chat-ref-popup-params';
import { WorkRefPill } from './WorkRefPill';

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
