import { describe, expect, it } from 'vitest';
import {
  abnormalEnd,
  classifyEndedHolder,
  type ClassifyEndedHolderInput,
} from './session-end-classifier';
import {
  resolveFleetParkResumePath,
  type FleetParkDirectiveLike,
  type FleetParkResumePath,
} from './fleet-park-resume-path';
import type { EngineLoopRowsByOwner } from './harness/routines/engine-loop-standdown';

const OWNER = 'su-test-owner';
const NOW = 1_756_742_400_000; // fixed instant so deadline comparisons are deterministic

/** Park path resolved through the REAL resolver, so these tests exercise the
 *  same composition production will (a hand-built path could drift from mig
 *  1065's semantics). */
function park(directive: Partial<FleetParkDirectiveLike>): FleetParkResumePath {
  return resolveFleetParkResumePath({ controlState: 'winding-down', ...directive }, NOW);
}

const NEVER_ARMED: EngineLoopRowsByOwner = {};
const STOOD_DOWN: EngineLoopRowsByOwner = { [OWNER]: [{ active: false }, { active: false }] };
const ACTIVE_LOOP: EngineLoopRowsByOwner = { [OWNER]: [{ active: false }, { active: true }] };

function input(overrides: Partial<ClassifyEndedHolderInput>): ClassifyEndedHolderInput {
  return {
    engineLoopRows: NEVER_ARMED,
    ownerId: OWNER,
    parkPath: null,
    heldWorkItems: 1,
    ...overrides,
  };
}

describe('classifyEndedHolder — population gate (held work)', () => {
  it('classifies zero held items as no-work regardless of every other signal', () => {
    expect(classifyEndedHolder(input({ heldWorkItems: 0 }))).toBe('no-work');
    // Even a stood-down owner is out of population without held work…
    expect(
      classifyEndedHolder(input({ heldWorkItems: 0, engineLoopRows: STOOD_DOWN })),
    ).toBe('no-work');
    // …and so is an abnormal-shaped one.
    expect(
      classifyEndedHolder(
        input({ heldWorkItems: 0, parkPath: park({ controlNoResumePath: true }) }),
      ),
    ).toBe('no-work');
  });

  it('treats a non-finite or negative count as no-work (defensive, never NaN-abnormal)', () => {
    expect(classifyEndedHolder(input({ heldWorkItems: Number.NaN }))).toBe('no-work');
    expect(classifyEndedHolder(input({ heldWorkItems: -3 }))).toBe('no-work');
  });
});

describe('classifyEndedHolder — standdown residue (engine-loop rows)', () => {
  it('never-armed owner (no rows) holding work with no park is abnormal', () => {
    expect(classifyEndedHolder(input({ engineLoopRows: NEVER_ARMED }))).toBe('abnormal');
  });

  it('stood-down owner (rows present, all inactive) is deliberate', () => {
    expect(classifyEndedHolder(input({ engineLoopRows: STOOD_DOWN }))).toBe('deliberate');
  });

  it('an owner with any ACTIVE loop row is NOT stood down — abnormal when inert holding work', () => {
    expect(classifyEndedHolder(input({ engineLoopRows: ACTIVE_LOOP }))).toBe('abnormal');
  });

  it("another owner's standdown residue does not speak for this owner", () => {
    const rows: EngineLoopRowsByOwner = { 'someone-else': [{ active: false }] };
    expect(classifyEndedHolder(input({ engineLoopRows: rows }))).toBe('abnormal');
  });

  it('fail-open: a null/undefined rows read degrades to "not stood down" (abnormal)', () => {
    expect(classifyEndedHolder(input({ engineLoopRows: null }))).toBe('abnormal');
    expect(classifyEndedHolder(input({ engineLoopRows: undefined }))).toBe('abnormal');
  });

  it('standdown residue wins even under a terminal park (compliance left the residue)', () => {
    expect(
      classifyEndedHolder(
        input({ engineLoopRows: STOOD_DOWN, parkPath: park({ controlNoResumePath: true }) }),
      ),
    ).toBe('deliberate');
  });
});

describe('classifyEndedHolder — park resume contract (per kind)', () => {
  it('gate: a declared latching resume gate makes the stop deliberate', () => {
    expect(
      classifyEndedHolder(input({ parkPath: park({ controlResumeGate: 'fleet:x:resume' }) })),
    ).toBe('deliberate');
  });

  it('both: gate + live deadline is deliberate', () => {
    expect(
      classifyEndedHolder(
        input({
          parkPath: park({
            controlResumeGate: 'fleet:x:resume',
            controlExpiresAt: NOW + 60_000,
          }),
        }),
      ),
    ).toBe('deliberate');
  });

  it('deadline: a live deadline with no gate is deliberate (a lift is expected)', () => {
    expect(
      classifyEndedHolder(input({ parkPath: park({ controlExpiresAt: NOW + 60_000 }) })),
    ).toBe('deliberate');
  });

  it('overdue: a passed deadline with no gate offers no live way back — abnormal', () => {
    const p = park({ controlExpiresAt: NOW - 60_000 });
    expect(p.kind).toBe('overdue');
    expect(classifyEndedHolder(input({ parkPath: p }))).toBe('abnormal');
  });

  it('terminal: a declared-terminal park does not excuse held work without standdown residue — abnormal', () => {
    const p = park({ controlNoResumePath: true });
    expect(p.kind).toBe('terminal');
    expect(classifyEndedHolder(input({ parkPath: p }))).toBe('abnormal');
  });

  it('none: an indefinite park (no gate, no deadline, not terminal) is abnormal', () => {
    const p = park({});
    expect(p.kind).toBe('none');
    expect(classifyEndedHolder(input({ parkPath: p }))).toBe('abnormal');
  });

  it('not parked at all (active fleet, or resolver saw no directive) is abnormal', () => {
    const notParked = resolveFleetParkResumePath({ controlState: 'active' }, NOW);
    expect(notParked.parked).toBe(false);
    expect(classifyEndedHolder(input({ parkPath: notParked }))).toBe('abnormal');
  });

  it('null/undefined parkPath (non-fleet session, or failed read) is abnormal', () => {
    expect(classifyEndedHolder(input({ parkPath: null }))).toBe('abnormal');
    expect(classifyEndedHolder(input({ parkPath: undefined }))).toBe('abnormal');
  });
});

describe('abnormalEnd — the D-003 boolean form', () => {
  it('is exactly classify === abnormal across the verdict space', () => {
    const cases: ClassifyEndedHolderInput[] = [
      input({}), // abnormal
      input({ engineLoopRows: STOOD_DOWN }), // deliberate
      input({ parkPath: park({ controlResumeGate: 'g' }) }), // deliberate
      input({ heldWorkItems: 0 }), // no-work
      input({ parkPath: park({ controlNoResumePath: true }) }), // abnormal
    ];
    for (const c of cases) {
      expect(abnormalEnd(c)).toBe(classifyEndedHolder(c) === 'abnormal');
    }
  });
});
