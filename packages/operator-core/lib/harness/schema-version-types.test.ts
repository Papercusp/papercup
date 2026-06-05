import { describe, expect, it } from 'vitest';
import {
  MIN_OP_SCHEMA_VERSION,
  buildKnownSchemaVersionRow,
  decideOpAcceptance,
  isKnownSchemaVersionRow,
  isValidOpSchemaVersion,
  maxNewerVersionSeen,
  shouldBumpKnownVersionRow,
  shouldFireNewerVersionToast,
  type KnownSchemaVersionRow,
  type OpAcceptanceDecision,
} from './schema-version-types';

function makeRow(over: Partial<KnownSchemaVersionRow> = {}): KnownSchemaVersionRow {
  return {
    harness_slug: 'papercup',
    max_known_version: 1,
    updated_at: 1716_000_000_000,
    ...over,
  };
}

describe('MIN_OP_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(MIN_OP_SCHEMA_VERSION).toBe(1);
  });
});

describe('isKnownSchemaVersionRow', () => {
  it('accepts well-formed row', () => {
    expect(isKnownSchemaVersionRow(makeRow())).toBe(true);
  });

  it('rejects empty harness_slug', () => {
    expect(isKnownSchemaVersionRow(makeRow({ harness_slug: '' }))).toBe(false);
  });

  it('rejects non-integer max_known_version', () => {
    expect(isKnownSchemaVersionRow(makeRow({ max_known_version: 1.5 }))).toBe(false);
  });

  it('rejects max_known_version < 1', () => {
    expect(isKnownSchemaVersionRow(makeRow({ max_known_version: 0 }))).toBe(false);
    expect(isKnownSchemaVersionRow(makeRow({ max_known_version: -1 }))).toBe(false);
  });

  it('rejects bad updated_at', () => {
    expect(isKnownSchemaVersionRow(makeRow({ updated_at: 0 }))).toBe(false);
    expect(isKnownSchemaVersionRow(makeRow({ updated_at: Number.NaN }))).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isKnownSchemaVersionRow(null)).toBe(false);
    expect(isKnownSchemaVersionRow('x')).toBe(false);
  });
});

describe('decideOpAcceptance', () => {
  it('accepts op at known version', () => {
    expect(decideOpAcceptance({ op_schema_version: 1, my_max_known: 1 })).toEqual({
      kind: 'accept',
    });
    expect(decideOpAcceptance({ op_schema_version: 1, my_max_known: 5 })).toEqual({
      kind: 'accept',
    });
  });

  it('ignores op at newer version', () => {
    const d = decideOpAcceptance({ op_schema_version: 3, my_max_known: 1 });
    expect(d.kind).toBe('ignore_newer');
    if (d.kind === 'ignore_newer') {
      expect(d.op_version).toBe(3);
      expect(d.my_max_known).toBe(1);
    }
  });

  it('ignores op with invalid version', () => {
    expect(decideOpAcceptance({ op_schema_version: 0, my_max_known: 1 }).kind).toBe('ignore_invalid');
    expect(decideOpAcceptance({ op_schema_version: -1, my_max_known: 1 }).kind).toBe('ignore_invalid');
    expect(decideOpAcceptance({ op_schema_version: 1.5, my_max_known: 1 }).kind).toBe('ignore_invalid');
    expect(decideOpAcceptance({ op_schema_version: 'two', my_max_known: 1 }).kind).toBe('ignore_invalid');
    expect(decideOpAcceptance({ op_schema_version: null, my_max_known: 1 }).kind).toBe('ignore_invalid');
    expect(decideOpAcceptance({ op_schema_version: undefined, my_max_known: 1 }).kind).toBe('ignore_invalid');
  });
});

describe('maxNewerVersionSeen', () => {
  it('returns 0 when no decisions', () => {
    expect(maxNewerVersionSeen([])).toBe(0);
  });

  it('returns 0 when no ignore_newer decisions', () => {
    const decisions: OpAcceptanceDecision[] = [
      { kind: 'accept' },
      { kind: 'ignore_invalid', raw_version: 'bad' },
    ];
    expect(maxNewerVersionSeen(decisions)).toBe(0);
  });

  it('returns the max op_version across ignore_newer decisions', () => {
    const decisions: OpAcceptanceDecision[] = [
      { kind: 'accept' },
      { kind: 'ignore_newer', op_version: 2, my_max_known: 1 },
      { kind: 'ignore_newer', op_version: 5, my_max_known: 1 },
      { kind: 'ignore_newer', op_version: 3, my_max_known: 1 },
    ];
    expect(maxNewerVersionSeen(decisions)).toBe(5);
  });
});

describe('shouldFireNewerVersionToast', () => {
  it('true when version is new + not already toasted', () => {
    expect(
      shouldFireNewerVersionToast({
        newer_version: 3,
        already_toasted_versions: new Set([2]),
      }),
    ).toBe(true);
  });

  it('false when version already toasted', () => {
    expect(
      shouldFireNewerVersionToast({
        newer_version: 3,
        already_toasted_versions: new Set([2, 3]),
      }),
    ).toBe(false);
  });

  it('false when version <= 0', () => {
    expect(
      shouldFireNewerVersionToast({
        newer_version: 0,
        already_toasted_versions: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldFireNewerVersionToast({
        newer_version: -1,
        already_toasted_versions: new Set(),
      }),
    ).toBe(false);
  });
});

describe('isValidOpSchemaVersion', () => {
  it('accepts positive integers ≥ MIN', () => {
    expect(isValidOpSchemaVersion(1)).toBe(true);
    expect(isValidOpSchemaVersion(2)).toBe(true);
    expect(isValidOpSchemaVersion(99)).toBe(true);
  });

  it('rejects 0 / negative / non-integer / non-number', () => {
    expect(isValidOpSchemaVersion(0)).toBe(false);
    expect(isValidOpSchemaVersion(-1)).toBe(false);
    expect(isValidOpSchemaVersion(1.5)).toBe(false);
    expect(isValidOpSchemaVersion('1')).toBe(false);
    expect(isValidOpSchemaVersion(null)).toBe(false);
    expect(isValidOpSchemaVersion(undefined)).toBe(false);
  });
});

describe('buildKnownSchemaVersionRow', () => {
  it('builds a valid row', () => {
    const row = buildKnownSchemaVersionRow({
      harness_slug: 'papercup',
      max_known_version: 3,
      now: 1716_000_000_000,
    });
    expect(row.harness_slug).toBe('papercup');
    expect(row.max_known_version).toBe(3);
    expect(row.updated_at).toBe(1716_000_000_000);
  });

  it('rejects bad inputs', () => {
    expect(() =>
      buildKnownSchemaVersionRow({ harness_slug: '', max_known_version: 1, now: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildKnownSchemaVersionRow({ harness_slug: 'x', max_known_version: 0, now: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildKnownSchemaVersionRow({ harness_slug: 'x', max_known_version: 1.5, now: 1 }),
    ).toThrow(TypeError);
  });

  it('round-trips through isKnownSchemaVersionRow', () => {
    const row = buildKnownSchemaVersionRow({
      harness_slug: 'x',
      max_known_version: 1,
      now: 1,
    });
    expect(isKnownSchemaVersionRow(row)).toBe(true);
  });
});

describe('shouldBumpKnownVersionRow', () => {
  it('true when no existing row', () => {
    expect(shouldBumpKnownVersionRow(null, 1)).toBe(true);
  });

  it('true when version differs', () => {
    expect(shouldBumpKnownVersionRow(makeRow({ max_known_version: 1 }), 2)).toBe(true);
    expect(shouldBumpKnownVersionRow(makeRow({ max_known_version: 5 }), 3)).toBe(true);
  });

  it('false when version matches', () => {
    expect(shouldBumpKnownVersionRow(makeRow({ max_known_version: 3 }), 3)).toBe(false);
  });
});
