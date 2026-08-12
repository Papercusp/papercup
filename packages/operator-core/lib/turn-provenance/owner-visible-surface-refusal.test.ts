/**
 * P-007 (owner-visibility-provenance-2026-08-11) / D-019 — the REFUSING tier.
 *
 * ── WHAT THIS PROVES, AND WHY IT IS SEPARATE FROM THE WARN TIER'S SUITE ────
 * `owner-visible-surface-acceptance.test.ts` proves the PREDICATE (when a gap
 * exists). This file proves the DECISION built on it: that a terminal write
 * carrying that gap is REFUSED, and — the half that is easy to get wrong — that
 * the three cases which must still pass actually pass. A gate that refuses
 * everything is indistinguishable, from the fleet's point of view, from a gate
 * that is broken; it gets force-overridden into irrelevance within a day.
 *
 * ── WHY UNIT TIER IS LEGITIMATE HERE, WHEN IT IS NOT FOR THE SURFACE ───────
 * D-019's corollary: this function's inputs are a boolean, a path string and a
 * `verifiedHow` value — all things the AUTHOR is entitled to invent, because
 * they are the completion's own declared fields rather than machine turn text
 * whose shape the author has already been proven wrong about three times. The
 * acceptance constrains the HIDING direction on the rendering surface; nothing
 * about this decision function is hidden from the author's own model.
 *
 * The wiring — that `setWorkItemState` actually CALLS this — is a different
 * failure and is pinned separately in `work-items-live-drive-refusal-wiring.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  liveDriveTerminalRefusal,
  OWNER_VISIBLE_SURFACE_FILES,
  LIVE_DRIVE_ACCEPTED_VERIFICATIONS,
} from './owner-visible-surface-acceptance';

const SURFACE_FILE = OWNER_VISIBLE_SURFACE_FILES[0];
const base = {
  id: 'WI-1',
  state: 'resolved',
  isCompletingTransition: true,
} as const;

describe('liveDriveTerminalRefusal — it REFUSES', () => {
  it('refuses a terminal write that changed the surface on unit evidence alone', () => {
    const msg = liveDriveTerminalRefusal({
      ...base,
      evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
    });
    expect(msg).toBeTruthy();
    expect(msg).toContain('rejected');
    expect(msg).toContain(SURFACE_FILE);
  });

  it('refuses when the completion declares no verification at all', () => {
    expect(
      liveDriveTerminalRefusal({ ...base, evidence: { filesChanged: [SURFACE_FILE] } }),
    ).toBeTruthy();
  });

  it("tells the agent their completion SURVIVED — the property that makes refusing here legitimate", () => {
    // D-005 / EI-24 forbid destroying the completion. This seam does not, and an
    // agent who cannot tell the difference will assume it did and rewrite it.
    const msg = liveDriveTerminalRefusal({
      ...base,
      evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
    })!;
    expect(msg).toMatch(/NOT LOST/);
    expect(msg).toMatch(/stays open/);
  });

  it('names both ways forward — re-close live-driven, or override with a reason', () => {
    const msg = liveDriveTerminalRefusal({
      ...base,
      evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
    })!;
    expect(msg).toContain("verifiedHow: 'live-drove-ui'");
    expect(msg).toMatch(/force:\s*true/);
    // work_items:complete has no `force` arg (WI-4530) — an error that sends the
    // caller to pass a flag their tool silently drops is worse than one that
    // names nothing, because the item then stays open with no signal.
    expect(msg).toMatch(/complete does NOT accept a `force` arg/);
  });
});

describe('liveDriveTerminalRefusal — it STAYS SILENT (the half that keeps it usable)', () => {
  it('allows a live-driven close', () => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        evidence: { verifiedHow: 'live-drove-ui', filesChanged: [SURFACE_FILE] },
      }),
    ).toBeNull();
  });

  it.each(LIVE_DRIVE_ACCEPTED_VERIFICATIONS)('allows verifiedHow: %s', (how) => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        evidence: { verifiedHow: how, filesChanged: [SURFACE_FILE] },
      }),
    ).toBeNull();
  });

  it('allows a change that touches no registered surface file', () => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        evidence: { verifiedHow: 'unit', filesChanged: ['packages/operator-core/lib/work-items.ts'] },
      }),
    ).toBeNull();
  });

  it('allows a NON-terminal write — those are not completions', () => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        isCompletingTransition: false,
        evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
      }),
    ).toBeNull();
  });

  it('allows an explicit force override', () => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        force: true,
        evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
      }),
    ).toBeNull();
  });

  it('allows a trusted system write (skipCompletionGate) — restore/watchdog/reconcile carry no evidence to judge', () => {
    expect(
      liveDriveTerminalRefusal({
        ...base,
        skipCompletionGate: true,
        evidence: { verifiedHow: 'unit', filesChanged: [SURFACE_FILE] },
      }),
    ).toBeNull();
  });

  it('allows a close with no evidence object at all', () => {
    // A bare set_state carries nothing to judge. The completion-integrity gate
    // already refuses those on its own grounds; inventing a second refusal here
    // would fire this gate on closes that never touched the surface.
    expect(liveDriveTerminalRefusal({ ...base, evidence: undefined })).toBeNull();
  });

  it('allows a completion that changed no files', () => {
    expect(
      liveDriveTerminalRefusal({ ...base, evidence: { verifiedHow: 'unit', filesChanged: [] } }),
    ).toBeNull();
  });
});

describe('the invariant the refusal rests on', () => {
  it("does not accept 'unit' — widening this would neuter the gate in a one-word diff", () => {
    expect(LIVE_DRIVE_ACCEPTED_VERIFICATIONS).not.toContain('unit');
  });

  it('refuses on EVERY registered surface file, not just the first', () => {
    // A matcher that happened to work for one path shape and not the others
    // would leave most of the registry unguarded while this suite stayed green.
    for (const file of OWNER_VISIBLE_SURFACE_FILES) {
      expect(
        liveDriveTerminalRefusal({ ...base, evidence: { verifiedHow: 'unit', filesChanged: [file] } }),
        `expected a refusal for ${file}`,
      ).toBeTruthy();
    }
  });
});
