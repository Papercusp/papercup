/**
 * orientation-telemetry.test.ts — the coord:orientation_telemetry TOOL (P-020).
 *
 * The aggregation, the class-A/class-B split and the 500-turn flag are tested
 * against the module in lib/orientation-telemetry.test.ts. This file tests the
 * ONE thing the tool layer adds: the VERDICT rail that stops an unreadable
 * telemetry table from being mistaken for a measured zero.
 *
 * That distinction is the whole point of the rail. "could not measure" and
 * "measured, nothing rendered" both arrive as `classes: []`, and they prescribe
 * OPPOSITE actions — the first means "fix the instrument, decide nothing", the
 * second means "the evidence genuinely does not exist yet". A caller that
 * conflates them removes an orientation class on the strength of a failed read,
 * which is exactly the decision P-020 exists to prevent.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/orientation-telemetry.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: vi.fn(() => ({ sql: {} })) };
});
vi.mock('../../orientation-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../orientation-telemetry')>();
  return { ...actual, readOrientationTelemetry: vi.fn() };
});

import { readOrientationTelemetry, ORIENTATION_ZERO_ACTION_FLAG_TURNS } from '../../orientation-telemetry';
import type {
  OrientationClassTelemetry,
  OrientationTelemetryRead,
} from '../../orientation-telemetry';
const readM = vi.mocked(readOrientationTelemetry);

const tool = (await import('./orientation-telemetry')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const CTX = { role: 'su', workspaceId: 'ws-from-ctx' } as never;

const BASE = {
  observedAt: '2026-09-22T00:00:00.000Z',
  sink: 'turn-start',
  flagThresholdTurns: ORIENTATION_ZERO_ACTION_FLAG_TURNS,
};
const A_CLASS: OrientationClassTelemetry = {
  classId: 'ownerDirectives',
  turnsRendered: 12,
  rowsRendered: 30,
  meanRowsPerTurn: 2.5,
  firstRenderedAt: null,
  lastRenderedAt: null,
  actionMeasurable: true,
  unmeasuredReason: null,
  dispositions: 4,
  openRows: 1,
  medianTurnsToDisposition: 2,
  flagged: false,
  flagReason: null,
};

/** The three readings the rail must keep apart. */
const UNAVAILABLE: OrientationTelemetryRead = {
  ...BASE,
  classes: [],
  flagged: [],
  unavailableReason: 'relation does not exist',
};
const EMPTY: OrientationTelemetryRead = { ...BASE, classes: [], flagged: [], unavailableReason: null };
const MEASURED: OrientationTelemetryRead = {
  ...BASE,
  classes: [A_CLASS],
  flagged: [],
  unavailableReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue(MEASURED);
});

describe('coord:orientation_telemetry — the verdict rail', () => {
  it('reports verdict:unavailable when the read could not run', async () => {
    readM.mockResolvedValue(UNAVAILABLE);
    const b = body(await tool.handler({} as never, CTX));
    expect(b.verdict).toBe('unavailable');
    expect(b.unavailableReason).toBe('relation does not exist');
    // The note must actively warn against the decision this rail exists to stop.
    expect(b.note).toMatch(/NOT a zero-reach reading/);
    expect(b.note).toMatch(/Do not remove a class/);
  });

  it('reports verdict:measured-empty when the read ran and found nothing', async () => {
    readM.mockResolvedValue(EMPTY);
    const b = body(await tool.handler({} as never, CTX));
    expect(b.verdict).toBe('measured-empty');
    expect(b.unavailableReason).toBeNull();
    expect(b.note).toMatch(/not evidence of zero reach/);
  });

  it('separates the two zero-length readings — the whole point of the rail', async () => {
    readM.mockResolvedValue(UNAVAILABLE);
    const unavailable = body(await tool.handler({} as never, CTX));
    readM.mockResolvedValue(EMPTY);
    const empty = body(await tool.handler({} as never, CTX));

    // Both are `classes: []` — identical on the field a caller would naively read.
    expect(unavailable.classes).toEqual([]);
    expect(empty.classes).toEqual([]);
    // And must still be distinguishable.
    expect(unavailable.verdict).not.toBe(empty.verdict);
  });

  it('reports verdict:measured with no note when classes are present', async () => {
    const b = body(await tool.handler({} as never, CTX));
    expect(b.verdict).toBe('measured');
    expect(b.note).toBeUndefined();
    expect(b.classes).toHaveLength(1);
    expect(b.flagThresholdTurns).toBe(ORIENTATION_ZERO_ACTION_FLAG_TURNS);
  });

  it('passes a class-A null disposition through unflattened', async () => {
    const classA: OrientationClassTelemetry = {
      ...A_CLASS,
      classId: 'delta',
      actionMeasurable: false,
      unmeasuredReason: 'class-A (delta): no disposition event exists to observe',
      dispositions: null,
      openRows: null,
      medianTurnsToDisposition: null,
    };
    readM.mockResolvedValue({ ...BASE, classes: [classA], flagged: [], unavailableReason: null });
    const b = body(await tool.handler({} as never, CTX));
    // D-085 ruling 4: a class-A class reports null, never 0 — a 0 would trip the guard.
    expect(b.classes[0].dispositions).toBeNull();
    expect(b.classes[0].dispositions).not.toBe(0);
  });
});

describe('coord:orientation_telemetry — scoping', () => {
  it('defaults workspaceId to the calling session', async () => {
    const b = body(await tool.handler({} as never, CTX));
    expect(readM.mock.calls[0]![1]).toMatchObject({ workspaceId: 'ws-from-ctx' });
    expect(b.workspaceId).toBe('ws-from-ctx');
  });

  it('an explicit workspaceId overrides the session', async () => {
    const b = body(await tool.handler({ workspaceId: 'ws-explicit' } as never, CTX));
    expect(readM.mock.calls[0]![1]).toMatchObject({ workspaceId: 'ws-explicit' });
    expect(b.workspaceId).toBe('ws-explicit');
  });

  it('omits sink entirely when not given, so the module default applies', async () => {
    await tool.handler({} as never, CTX);
    expect(readM.mock.calls[0]![1]).not.toHaveProperty('sink');
  });

  it('forwards an explicit sink', async () => {
    await tool.handler({ sink: 'wake' } as never, CTX);
    expect(readM.mock.calls[0]![1]).toMatchObject({ sink: 'wake' });
  });
});

/**
 * TIER-1 FALSIFIABILITY CONTROL (permanent, per the repo's mutation-probe rule:
 * keep a deliberately-wrong implementation in the test file rather than mutating
 * the shared tree).
 *
 * The plausible wrong way to write this rail is to branch on `classes.length`
 * FIRST and only then consider `unavailableReason` — which collapses the failed
 * read into "measured-empty" and hands a caller a clean-looking zero. The
 * control below is that bug, asserted to FAIL the assertion the real selector
 * passes, plus a calibration case so the control cannot pass vacuously.
 */
function brokenVerdict(read: { classes: readonly unknown[]; unavailableReason: string | null }) {
  // ⛔ deliberately wrong: length is checked before availability.
  return read.classes.length === 0 ? 'measured-empty' : 'measured';
}

describe('falsifiability control — the length-first verdict bug', () => {
  it('the broken selector mislabels an unavailable read as measured-empty', () => {
    expect(brokenVerdict(UNAVAILABLE)).toBe('measured-empty');
    // The real tool must NOT agree with it on this input.
    expect(brokenVerdict(UNAVAILABLE)).not.toBe('unavailable');
  });

  it('calibration: the broken selector is still right on the inputs that do not discriminate', () => {
    // If these ever diverge, the control is testing something other than the bug.
    expect(brokenVerdict(EMPTY)).toBe('measured-empty');
    expect(brokenVerdict(MEASURED)).toBe('measured');
  });

  it('the real tool disagrees with the broken selector exactly on the unavailable input', async () => {
    readM.mockResolvedValue(UNAVAILABLE);
    const real = body(await tool.handler({} as never, CTX)).verdict;
    expect(real).not.toBe(brokenVerdict(UNAVAILABLE));
    expect(real).toBe('unavailable');
  });
});
