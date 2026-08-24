/**
 * P-001 of state-plane-interest-and-hardening-2026-08-21 — the fire payload's
 * plane handle.
 *
 * The defect this pins: a subscription wake handed the agent `observed` (a
 * FIRE-TIME value, stale across the fire→delivery lag) with no cell to re-answer
 * it — the one state-plane delivery surface without a handle, at the moment the
 * agent is most likely to act on the snapshot.
 *
 * These are BEHAVIOUR tests over `deriveCellReread`, not shape assertions: each
 * case states a false reading the handle kills, and the audience cases assert the
 * P-019 non-oracle property (out-of-audience derives NOTHING — never a leaked
 * cell name).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';
import { deriveCellReread } from './predicate-watch';

/** A minimal, CONTRACT-VALID spec (every D-038 axis satisfied) — the registration
 *  gate throws otherwise, so this doubles as a check that the fixtures are legal. */
function spec(over: Partial<CellSpec> & Pick<CellSpec, 'cell'>): CellSpec {
  return {
    owner: 'test',
    headline: 'value.headline',
    assessment: {
      path: 'probe.assessment',
      codes: {
        current: { meaning: 'the measured value is current', safeAction: 'use the value' },
        stale: { meaning: 'the measured value predates the subject', safeAction: 're-measure before acting' },
      },
      evidence: ['probe.independent'],
    },
    falsifier: {
      field: 'probe.independent',
      measurement: 'an independent probe against the live subject',
      kills: 'reading the headline as authoritative when the probe disagrees',
    },
    nullable: false,
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'test resolver', liveExercised: true, evidence: 'exercised in this suite' },
    resolver: `resolver:${over.cell}`,
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'test:door', path: 'value.headline' },
    shape: '{ value: { headline } }',
    ...over,
  } as CellSpec;
}

const ROW = {
  tool: 'test:door',
  path: 'value.headline',
  args: {} as unknown,
  ownerId: 'su-reader',
  role: 'su',
  harnessSlug: 'papercusp',
};

describe('deriveCellReread — the wake carries the handle that re-answers its own trigger', () => {
  beforeEach(() => __resetCellRegistryForTests());
  afterEach(() => __resetCellRegistryForTests());

  it('derives the handle for the cell whose changeSignal the watch polls', () => {
    registerCell(spec({ cell: 'test.headline' }));
    expect(deriveCellReread(ROW)).toEqual({ tool: 'state:read', args: { cell: 'test.headline' } });
  });

  it('derives it for a MATERIALITY path too — a target:"material" subscription watches that path, not changeSignal.path', () => {
    registerCell(
      spec({
        cell: 'test.material',
        materiality: { path: 'value.coarse', why: 'the headline churns; this is the question the cell answers' },
      }),
    );
    // A watch registered with target:'material' stores the materiality path.
    expect(deriveCellReread({ ...ROW, path: 'value.coarse' })).toEqual({
      tool: 'state:read',
      args: { cell: 'test.material' },
    });
  });

  /**
   * P-005 — the ASSESSMENT path is a third subscribable target, and since D-007 made it
   * the DEFAULT for an operand-free subscription on an assessed cell, a row storing it
   * is the COMMON case, not an exotic one. Missing it here would strip the re-read
   * handle from most wakes in the plane while every other case still passed.
   */
  it('derives it for an ASSESSMENT path — the default target for an operand-free subscription (D-007)', () => {
    registerCell(
      spec({
        cell: 'test.assessed',
        assessment: {
          path: 'value.code',
          codes: {
            live: { meaning: 'the reading is current', safeAction: 'act on it' },
            stale: { meaning: 'the reading predates the subject', safeAction: 're-measure before acting' },
          },
          evidence: ['value.headline'],
        },
      }),
    );
    expect(deriveCellReread({ ...ROW, path: 'value.code' })).toEqual({
      tool: 'state:read',
      args: { cell: 'test.assessed' },
    });
  });

  it('threads the SUBJECT for a caller-relative cell, so the re-read answers about the same subject', () => {
    registerCell(
      spec({
        cell: 'test.perPath',
        callerRelativity: { kind: 'parameter', param: 'path' },
      }),
    );
    expect(deriveCellReread({ ...ROW, args: { path: 'libs/flags/src/types.ts' } })).toEqual({
      tool: 'state:read',
      args: { cell: 'test.perPath', as: 'libs/flags/src/types.ts' },
    });
  });

  it('emits NO handle when a caller-relative cell has no subject — an unaddressed handle answers about a DIFFERENT subject, which is worse than none', () => {
    registerCell(spec({ cell: 'test.perPath', callerRelativity: { kind: 'parameter', param: 'path' } }));
    expect(deriveCellReread({ ...ROW, args: {} })).toBeUndefined();
  });

  it('emits NO handle to an out-of-audience reader — P-019: a refusal must not reveal that the cell exists', () => {
    registerCell(spec({ cell: 'test.narrow', visibility: { kind: 'owner', ref: 'su-somebody-else' } }));
    expect(deriveCellReread(ROW)).toBeUndefined();
    // …and the SAME row derives it once the reader IS the audience, proving the
    // absence above is the audience check and not a broken match.
    expect(deriveCellReread({ ...ROW, ownerId: 'su-somebody-else' })).toEqual({
      tool: 'state:read',
      args: { cell: 'test.narrow' },
    });
  });

  it('emits no handle for a watch on a tool/path no cell declares — a hand-rolled watch:create is untouched', () => {
    registerCell(spec({ cell: 'test.headline' }));
    expect(deriveCellReread({ ...ROW, tool: 'other:door' })).toBeUndefined();
    expect(deriveCellReread({ ...ROW, path: 'some.other.path' })).toBeUndefined();
  });

  it('is TOTAL — a hostile args value degrades to no handle instead of throwing into the fire path', () => {
    registerCell(spec({ cell: 'test.perPath', callerRelativity: { kind: 'parameter', param: 'path' } }));
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    expect(() => deriveCellReread({ ...ROW, args: hostile })).not.toThrow();
    expect(deriveCellReread({ ...ROW, args: hostile })).toBeUndefined();
  });

  it('an empty registry derives nothing and does not throw (the pre-P-001 payload shape)', () => {
    expect(deriveCellReread(ROW)).toBeUndefined();
  });
});
