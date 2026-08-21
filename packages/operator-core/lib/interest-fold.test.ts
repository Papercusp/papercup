import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEPLOYED_SHA_CELL,
  GATE_VERDICT_CELL,
  GIT_PIPELINE_POSITION_CELL,
  HOST_MEMORY_PRESSURE_CELL,
  registerBuiltinCells,
} from './cell-registrations';
import type { CellReader } from './cell-registry';
import { foldInterests, interestFold, type InterestFoldRow } from './interest-fold';
import type { InterestProfileRow } from './interest-profiles';

/**
 * P-011 of state-plane-interest-and-hardening-2026-08-21.
 *
 * The rows are INJECTED in most cases below rather than read from the live registry.
 * That is the same choice `validateInterestProfiles` made and for the same reason: a
 * filter that has only ever run against known-good data is not a filter. Injecting
 * deliberately-wrong control rows proves each rule CAN reject, without mutating a
 * shared-tree module to do it.
 */

/** Reader INSIDE the pipeline cells' audience (`{ kind:'harness', ref:'papercusp' }`). */
const insider: CellReader = { ownerId: 'su-test-insider', harnessSlug: 'papercusp' };
/** Reader OUTSIDE it — still sees workspace-visible cells. Not a stranger; a neighbour. */
const outsider: CellReader = { ownerId: 'su-test-outsider', harnessSlug: 'sidestage' };

beforeAll(() => {
  // getCell reads the registry MAP, which the spec array alone does not populate.
  registerBuiltinCells();
});

describe('foldInterests — audience', () => {
  it('folds a restricted cell for a reader inside its audience', () => {
    const rows = foldInterests({ contexts: ['plan-holder'], reader: insider });
    expect(rows.map((r) => r.cell)).toContain(GATE_VERDICT_CELL.cell);
  });

  it('omits a restricted cell for a reader outside its audience', () => {
    const rows = foldInterests({ contexts: ['plan-holder'], reader: outsider });
    expect(rows.map((r) => r.cell)).not.toContain(GATE_VERDICT_CELL.cell);
  });

  it('the positive control passes: the SAME outsider still folds a workspace-visible cell', () => {
    // Without this, the assertion above is satisfied just as well by a fold that is
    // broken for everyone — an empty result would read as a working audience check.
    const rows = foldInterests({ contexts: ['item-holder'], reader: outsider });
    expect(rows.map((r) => r.cell)).toContain(HOST_MEMORY_PRESSURE_CELL.cell);
  });

  it('discloses NOTHING about what the audience check removed (no count, no marker)', () => {
    // P-019's enumeration-oracle property: "outside your audience" and "does not
    // exist" must stay indistinguishable. A withheld COUNT would rebuild the oracle,
    // so its absence is the assertion — measured against the insider's larger fold so
    // the test knows rows really were dropped rather than never matching.
    const insiderRows = foldInterests({ contexts: ['plan-holder', 'item-holder'], reader: insider });
    const outsiderRows = foldInterests({ contexts: ['plan-holder', 'item-holder'], reader: outsider });
    expect(outsiderRows.length).toBeLessThan(insiderRows.length);

    const block = interestFold({ contexts: ['plan-holder', 'item-holder'], reader: outsider });
    const serialized = JSON.stringify(block);
    expect(serialized).not.toMatch(/withheld|omitted|hidden|denied|forbidden|notReadable/i);
    // and no cell it may not read is named anywhere, not even in prose
    expect(serialized).not.toContain(GATE_VERDICT_CELL.cell);
  });

  it('fails CLOSED when no reader is supplied', () => {
    expect(foldInterests({ contexts: ['plan-holder'], reader: undefined as unknown as CellReader })).toEqual([]);
  });
});

describe('foldInterests — selection', () => {
  const cellRow = (over: Partial<InterestProfileRow> = {}): InterestProfileRow => ({
    context: 'item-holder',
    watch: { kind: 'cell', cell: HOST_MEMORY_PRESSURE_CELL.cell },
    tier: 'fold',
    why: 'control row',
    ...over,
  });

  it('folds only the `fold` tier — control rows at other tiers are rejected', () => {
    const rows = [cellRow({ tier: 'suggest' }), cellRow({ tier: 'auto-arm', on: { op: 'changed' } })];
    expect(foldInterests({ contexts: ['item-holder'], reader: insider, rows })).toEqual([]);
    // control: the identical row at tier `fold` IS folded, so the emptiness above is
    // the tier filter and not a broken fixture.
    expect(foldInterests({ contexts: ['item-holder'], reader: insider, rows: [cellRow()] })).toHaveLength(1);
  });

  it('skips EVENT rows even at the fold tier (no state:read handle exists for a family)', () => {
    const rows = [
      cellRow({ watch: { kind: 'event', family: 'fleet-item-completed' }, context: 'fleet-leader' }),
      cellRow({ watch: { kind: 'event', family: 'fleet-claim-released' }, context: 'fleet-leader' }),
    ];
    expect(foldInterests({ contexts: ['fleet-leader'], reader: insider, rows })).toEqual([]);
  });

  it('folds only contexts the caller actually occupies', () => {
    const rows = [cellRow({ context: 'plan-holder' })];
    expect(foldInterests({ contexts: ['item-holder'], reader: insider, rows })).toEqual([]);
    expect(foldInterests({ contexts: ['plan-holder'], reader: insider, rows })).toHaveLength(1);
  });

  it('de-duplicates a repeated (context, cell) pair', () => {
    expect(foldInterests({ contexts: ['item-holder'], reader: insider, rows: [cellRow(), cellRow()] })).toHaveLength(1);
  });

  it('is deterministic across calls', () => {
    const once = foldInterests({ contexts: ['plan-holder', 'item-holder'], reader: insider });
    const twice = foldInterests({ contexts: ['plan-holder', 'item-holder'], reader: insider });
    expect(once).toEqual(twice);
  });
});

describe('foldInterests — handles, not values (D-001)', () => {
  const ALLOWED_KEYS = new Set(['context', 'cell', 'answers', 'why', 'reread', 'unreadable']);

  it('emits no field beyond the handle shape', () => {
    // The guard that matters: D-001 forbids an ambient copy of a value, and the way
    // that gets reintroduced is a well-meaning `value`/`current`/`headlineValue` field.
    // Whitelisting the shape fails on the next such addition instead of trusting it.
    const rows = foldInterests({ contexts: ['plan-holder', 'item-holder'], reader: insider });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(ALLOWED_KEYS).toContain(key);
    }
  });

  it('`answers` is the headline FIELD PATH from the registry, never a reading', () => {
    const rows = foldInterests({ contexts: ['item-holder'], reader: insider });
    const host = rows.find((r) => r.cell === HOST_MEMORY_PRESSURE_CELL.cell);
    expect(host?.answers).toBe(HOST_MEMORY_PRESSURE_CELL.headline);
  });

  it('carries the profile row rationale verbatim', () => {
    const rows = foldInterests({ contexts: ['item-holder'], reader: insider });
    const host = rows.find((r) => r.cell === HOST_MEMORY_PRESSURE_CELL.cell);
    expect(host?.why).toMatch(/pressure/i);
  });
});

describe('foldInterests — caller-relative subjects', () => {
  const relativeCell = GIT_PIPELINE_POSITION_CELL;
  const param = relativeCell.callerRelativity.kind === 'parameter' ? relativeCell.callerRelativity.param : null;

  it('the fixture really is caller-relative (otherwise the two tests below prove nothing)', () => {
    expect(param).toBeTruthy();
  });

  it('refuses an unqualified handle when the subject is unresolved', () => {
    const rows = foldInterests({ contexts: ['item-holder'], reader: insider });
    const row = rows.find((r) => r.cell === relativeCell.cell) as InterestFoldRow | undefined;
    expect(row).toBeTruthy();
    // An unqualified re-read of a per-path cell SUCCEEDS and answers about a different
    // path, so refusing is strictly safer than emitting a handle that looks complete.
    expect(row?.reread).toBeUndefined();
    expect(row?.unreadable?.needs).toBe(param);
  });

  it('emits a complete `as`-qualified handle once the subject resolves', () => {
    const rows = foldInterests({
      contexts: ['item-holder'],
      reader: insider,
      subjects: { 'workItem.primaryPath': 'packages/operator-core/lib/interest-fold.ts' },
    });
    const row = rows.find((r) => r.cell === relativeCell.cell);
    expect(row?.unreadable).toBeUndefined();
    expect(row?.reread).toEqual({
      tool: 'state:read',
      args: { cell: relativeCell.cell, as: 'packages/operator-core/lib/interest-fold.ts' },
    });
  });

  it('a non-caller-relative cell needs no subject', () => {
    const rows = foldInterests({ contexts: ['item-holder'], reader: insider });
    const host = rows.find((r) => r.cell === HOST_MEMORY_PRESSURE_CELL.cell);
    expect(host?.reread).toEqual({ tool: 'state:read', args: { cell: HOST_MEMORY_PRESSURE_CELL.cell } });
  });
});

describe('interestFold — block', () => {
  it('returns null rather than an empty shell when nothing folds', () => {
    // An empty block asserts "your contexts have no interests", which would be false
    // for the common caller whose matches were all dropped by the audience check.
    expect(interestFold({ contexts: [], reader: insider })).toBeNull();
  });

  it('returns a note plus the folded watches', () => {
    const block = interestFold({ contexts: ['item-holder'], reader: insider });
    expect(block?.watches.length).toBeGreaterThan(0);
    expect(block?.note).toMatch(/handle/i);
  });

  it('never throws — a malformed row degrades to a dropped leg, not a failed orient', () => {
    const bad = [{ context: 'item-holder', tier: 'fold' }] as unknown as InterestProfileRow[];
    expect(() => interestFold({ contexts: ['item-holder'], reader: insider, rows: bad })).not.toThrow();
  });

  it('does not fold a suggest-tier cell that only the SUGGEST tier should carry', () => {
    // DEPLOYED_SHA_CELL is registered at tier `suggest` in the live profiles; if it
    // appears in a fold the tier filter has regressed against real registry data.
    const rows = foldInterests({ contexts: ['item-holder'], reader: insider });
    expect(rows.map((r) => r.cell)).not.toContain(DEPLOYED_SHA_CELL.cell);
  });
});
