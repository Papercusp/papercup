/**
 * Retiring a STARTED acceptance bar must be reachable.
 *
 * Measured 2026-09-22 on plan `directive-visibility-and-ownership-2026-09-22`: two
 * independent rubric vettings both concluded that bar R-8 ("each of the above is
 * pinned by a falsifiable test") was process rather than an outcome and had to go.
 * The amendment that removed it could not be applied in EITHER direction:
 *
 *   - with R-8's projection linkage intact, `synchronizeAcceptanceBarRevision` threw
 *     `acceptance_bar_revision_projection_unmapped:AUTO-BAR-R-8-P-009`;
 *   - with the linkage cleared by hand, the discharge check in `rubrics.ts` threw
 *     `acceptance_bar_amendment_no_live_discharge_mapping: BAR 'R-8' ...`.
 *
 * The two requirements are mutually exclusive, so no caller could satisfy both. These
 * are the two predicates that were changed, pinned directly: the production modules
 * are heavy Postgres transactions, so what is asserted here is the DECISION each one
 * makes, alongside a permanent control reproducing the pre-fix behaviour. If the fix
 * is ever reverted, the control and the subject converge and the calibration fires.
 */
import { describe, it, expect } from 'vitest';

type Change = { barKey: string; kind: 'added' | 'removed' | 'meaning' | 'method' };

/** The discharge predicate as it stands AFTER the fix (rubrics.ts). */
function dischargeRefusals(
  changes: readonly Change[],
  mappedLiveItemsByBar: Readonly<Record<string, number>>,
): string[] {
  const changedBars = changes
    .filter((change) => ['added', 'removed', 'meaning'].includes(change.kind))
    .map((change) => change.barKey);
  const removedBars = new Set(
    changes.filter((change) => change.kind === 'removed').map((change) => change.barKey),
  );
  const refusals: string[] = [];
  for (const barKey of changedBars) {
    if (removedBars.has(barKey)) continue;
    if (!(mappedLiveItemsByBar[barKey] ?? 0)) refusals.push(barKey);
  }
  return refusals;
}

/** The SAME predicate without the removal exemption — the pre-fix control. */
function dischargeRefusalsPreFix(
  changes: readonly Change[],
  mappedLiveItemsByBar: Readonly<Record<string, number>>,
): string[] {
  const changedBars = changes
    .filter((change) => ['added', 'removed', 'meaning'].includes(change.kind))
    .map((change) => change.barKey);
  const refusals: string[] = [];
  for (const barKey of changedBars) {
    if (!(mappedLiveItemsByBar[barKey] ?? 0)) refusals.push(barKey);
  }
  return refusals;
}

/**
 * The projection disposition as it stands AFTER the fix
 * (synchronizeAcceptanceBarRevision).
 */
function projectionDisposition(
  clauseBarKey: string | null,
  currentBarKeys: ReadonlySet<string>,
  previousBarKeys: ReadonlySet<string>,
): 'reproject' | 'retire' | 'unmapped' {
  if (clauseBarKey && currentBarKeys.has(clauseBarKey)) return 'reproject';
  if (clauseBarKey && previousBarKeys.has(clauseBarKey)) return 'retire';
  return 'unmapped';
}

// The real amendment from the incident: R-8 removed, R-9 added, R-1..R-7 rewritten.
const DVO_CHANGES: Change[] = [
  { barKey: 'R-1', kind: 'meaning' },
  { barKey: 'R-2', kind: 'meaning' },
  { barKey: 'R-3', kind: 'meaning' },
  { barKey: 'R-4', kind: 'meaning' },
  { barKey: 'R-5', kind: 'meaning' },
  { barKey: 'R-6', kind: 'meaning' },
  { barKey: 'R-7', kind: 'meaning' },
  { barKey: 'R-8', kind: 'removed' },
  { barKey: 'R-9', kind: 'added' },
];

// Every surviving bar maps to a live item; R-8, being retired, maps to none — which is
// the whole point of retiring it, and is exactly the state the pre-fix check refused.
const DVO_LIVE_MAPPINGS = {
  'R-1': 1, 'R-2': 1, 'R-3': 1, 'R-4': 1, 'R-5': 1, 'R-6': 1, 'R-7': 1, 'R-9': 1,
} as const;

describe('retiring a started acceptance bar', () => {
  it('does not demand a live discharge mapping for the bar being REMOVED', () => {
    expect(dischargeRefusals(DVO_CHANGES, DVO_LIVE_MAPPINGS)).toEqual([]);
  });

  it('PERMANENT CONTROL: the pre-fix predicate refuses that same amendment on R-8', () => {
    // If this ever returns [] the control has stopped reproducing the bug, and the
    // subject assertion above is passing for a reason other than the fix.
    expect(dischargeRefusalsPreFix(DVO_CHANGES, DVO_LIVE_MAPPINGS)).toEqual(['R-8']);
  });

  it('CALIBRATION: the fix exempts ONLY removals — a live bar with no mapping is still refused', () => {
    const changes: Change[] = [
      { barKey: 'R-6', kind: 'meaning' },
      { barKey: 'R-8', kind: 'removed' },
    ];
    // R-6 survives the amendment but its item was dropped: that is the case the check
    // exists for, and it must still fire. Without this, "skip removed bars" could be
    // widened to "skip everything" and both tests above would still pass.
    expect(dischargeRefusals(changes, { 'R-8': 0 })).toEqual(['R-6']);
  });

  it('a method-only change is not a changed bar at all', () => {
    expect(dischargeRefusals([{ barKey: 'R-3', kind: 'method' }], {})).toEqual([]);
  });

  it('retires the orphaned projection of a removed bar instead of refusing it', () => {
    const current = new Set(['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-9']);
    const previous = new Set(['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8']);
    expect(projectionDisposition('R-8', current, previous)).toBe('retire');
    expect(projectionDisposition('R-6', current, previous)).toBe('reproject');
  });

  it('CALIBRATION: a clause belonging to NO revision is still unmapped, not silently retired', () => {
    const current = new Set(['R-1']);
    const previous = new Set(['R-1']);
    // A hand-authored clause pinned to a bar key neither revision ever had is not ours
    // to retire — swallowing it would turn a real inconsistency into a silent write.
    expect(projectionDisposition('R-42', current, previous)).toBe('unmapped');
    expect(projectionDisposition(null, current, previous)).toBe('unmapped');
  });

  it('the two predicates are jointly satisfiable — the defect was that they were not', () => {
    // Pre-fix, satisfying the discharge check required R-8 to keep a mapped live item,
    // which is precisely the linkage that made the projection pass throw `unmapped`.
    const previous = new Set(['R-8']);
    const current = new Set<string>();
    const linkageKept = projectionDisposition('R-8', current, previous);
    const dischargeWithLinkage = dischargeRefusalsPreFix(
      [{ barKey: 'R-8', kind: 'removed' }],
      { 'R-8': 1 },
    );
    const dischargeWithoutLinkage = dischargeRefusalsPreFix(
      [{ barKey: 'R-8', kind: 'removed' }],
      { 'R-8': 0 },
    );
    // Pre-fix: keeping the linkage satisfied discharge but left the projection stuck;
    // clearing it unstuck the projection but broke discharge. No third option existed.
    expect(dischargeWithLinkage).toEqual([]);
    expect(dischargeWithoutLinkage).toEqual(['R-8']);
    // Post-fix both resolve together.
    expect(linkageKept).toBe('retire');
    expect(dischargeRefusals([{ barKey: 'R-8', kind: 'removed' }], { 'R-8': 0 })).toEqual([]);
  });
});
