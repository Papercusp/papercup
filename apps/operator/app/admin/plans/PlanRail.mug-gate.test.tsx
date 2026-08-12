// @vitest-environment jsdom
/**
 * PlanRail — the Start/Pause toggle under the Mug/Kettle retirement
 * (retire-mug-kettle-su-only-2026-08-09 P-047 / D-010).
 *
 * WHAT THIS PINS, and why it is not cosmetic. `op_status` ('started'|'paused')
 * is the OPERATIONAL axis — the "pickable by the orchestrator" bit — and this
 * button is its only owner-facing WRITER. Owner-directed, verbatim: "its just
 * the start/stopped functionality that made them 'pickable' for the mug that we
 * no longer need and the gui buttons driving that functionality."
 *
 * It matters beyond tidiness because op_status does not ENABLE anything for su:
 * `reservedPlanLaneExclusionSql` RESERVES a started plan's items FROM scheduler
 * self-selection, on the premise that a dispatcher will hand them out. With the
 * tier retired there is no dispatcher, so every press of this button silently
 * strands that plan's items — presenting as "the queue is empty", not as a bug.
 *
 * THE ASYMMETRY IS THE POINT (and the thing most likely to be "cleaned up" by a
 * later reader): Start disappears, PAUSE SURVIVES for an already-started plan.
 * The DBOS orchestrator frontier still reads op_status='started' and is NOT
 * gated by the retirement, so hiding pause too would freeze every plan started
 * before P-047 landed as permanently dispatchable with no off switch. The server
 * makes the same split — plans:start's write is gated, plans:pause is
 * deliberately not (D-061, and _mug-kettle-gate.ts's own rule that refusing a
 * stop is never the safe direction).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { FLAGS } from '@papercusp/flags';
import PlanRail from './PlanRail';
import type { AsyncResult, PlanListRow } from './plans-api';

// P-068/D-098: the tier flag is DELETED, so there is no longer a key to pin
// either way — the component reads no flag at all now. EVERY flag is forced ON
// instead, which turns the assertions below into a TRIPWIRE rather than a test
// of a default: Start must stay absent even in the most permissive flag state
// the app can reach. That is strictly stronger than the old both-ways pinning,
// and it is what catches a later reader re-adding a flag to bring Start back.
vi.mock('@/lib/flag-hooks', async (orig) => ({
  ...(await orig<typeof import('@/lib/flag-hooks')>()),
  useFlag: () => true,
}));

beforeEach(() => {
  // The row nests the Start/Pause <button> inside the row <button> — a
  // pre-existing invalid-nesting warning, orthogonal to this gate.
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (
      msg.includes('cannot be a descendant of') ||
      msg.includes('cannot contain a nested') ||
      msg.includes('validateDOMNesting')
    ) {
      return;
    }
    throw new Error(`Unexpected console.error: ${msg}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function plan(slug: string, over: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug,
    title: slug,
    status: 'ready',
    updated: undefined,
    created: undefined,
    owner: undefined,
    archived: false,
    isLegacy: false,
    itemCounts: undefined,
    nextAction: undefined,
    // Empty so the HarnessPill (a Radix Tooltip needing a provider) is skipped.
    harness: '',
    startStatus: undefined,
    priority: undefined,
    maxImportance: undefined,
    ...over,
  };
}

function renderRail(plans: PlanListRow[]) {
  const list: AsyncResult<{ plans: PlanListRow[] }> = {
    data: { plans },
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  return render(<PlanRail list={list} selectedSlugs={[]} query="" onSelect={vi.fn()} />, {
    wrapper: withNuqsTestingAdapter({ searchParams: '' }),
  });
}

/** Every Start/Pause toggle rendered, by its accessible label. */
const toggleLabels = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.pc-plan-row__start-btn')).map(
    (el) => el.getAttribute('aria-label') ?? '',
  );

describe('PlanRail Start/Pause under the retired op_status axis', () => {
  it('offers NO Start button for a ready, never-started plan', () => {
    const { container } = renderRail([plan('ready-plan-2026-08-10')]);
    expect(toggleLabels(container)).toEqual([]);
  });

  it('offers NO Start button for a PAUSED plan — the axis cannot be re-entered', () => {
    // The trap this catches: `isStarted` is false for 'paused', so a naive
    // "keep the button when the plan is on the axis" reading would render
    // "Start" here and hand the owner a way straight back onto it.
    const { container } = renderRail([plan('paused-plan-2026-08-10', { startStatus: 'paused' })]);
    expect(toggleLabels(container)).toEqual([]);
  });

  it('KEEPS Pause for an already-started plan — the frontier still reads op_status', () => {
    const { container } = renderRail([plan('running-plan-2026-08-10', { startStatus: 'started' })]);
    expect(toggleLabels(container)).toEqual(['Pause plan running-plan-2026-08-10']);
  });

  // This block used to assert the OPPOSITE — "restores Start when the tier is
  // flipped back ON (the testing escape hatch)" — and pinned the gate to the flag
  // key. P-068/D-098 deleted that flag, so the escape hatch no longer exists and
  // a test of it would have no subject. What replaces it is the tripwire the
  // deletion actually needs: there is no flag state that brings Start back.
  it('CALIBRATION: the rail really rendered (so the empty-toggle assertions are not vacuous)', () => {
    // Every load-bearing assertion above is an ABSENCE, which passes just as
    // happily against a rail that failed to render at all.
    const { container } = renderRail([plan('ready-plan-2026-08-10')]);
    expect(container.querySelectorAll('.pc-plan-row').length).toBeGreaterThan(0);
  });

  it('keeps Start gone with EVERY flag forced on — no flag can re-open the axis', () => {
    // useFlag is stubbed true for every key above, so this is the most permissive
    // state reachable. Start must still be absent.
    const { container } = renderRail([plan('ready-plan-2026-08-10')]);
    expect(toggleLabels(container)).toEqual([]);
  });

  it('no longer has a tier flag to flip — the retirement is permanent', () => {
    expect('MUG_KETTLE_SYSTEM' in FLAGS).toBe(false);
    expect(Object.values(FLAGS as Record<string, string>)).not.toContain(
      'papercusp-mug-kettle-system',
    );
  });
});
