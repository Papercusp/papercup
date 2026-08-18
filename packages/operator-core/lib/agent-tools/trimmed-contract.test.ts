/**
 * trimmed-contract.test.ts — EI-20803112372029993.
 *
 * Guards the class described in `trimmed-contract.ts`: a `shape.trimmed` shaper
 * that rebuilds rows from an allowlist silently drops fields the tool's own
 * `returns` block promises, on the tier agents get by default.
 *
 * The controls below are PERMANENT, not scaffolding. A guard that has never
 * failed is a guard nobody has tested, and the repo's falsifiability rule bars
 * proving it by mutating the shared tree — so the deliberately-wrong shaper
 * lives here as a fixture instead. `calibration` is the other half: if the
 * checker were broken in the direction of "never reports anything", the
 * wrong-shaper control would still pass, so a correct shaper must also be shown
 * to come back CLEAN.
 */
import { describe, it, expect } from 'vitest';
import { listDeclaredToolShapers, listAllProjectedTools } from '@papercusp/tooldef';
import '../agent-tools/index';
import {
  parseReturnsRowFields,
  checkTrimmedContract,
  trimmedContractViolations,
  unresolvableContracts,
  type TrimmedContractSubject,
} from './trimmed-contract';

const RETURNS = 'Each row: { installSlug, name, triggerKind, active }. Other prose follows.';

/** A shaper that rebuilds the row from an allowlist and DROPS `triggerKind`. */
const wrongShaper = (data: unknown) => {
  const d = data as { rows?: unknown[] };
  return {
    rows: (d.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        installSlug: row.installSlug ?? null,
        name: row.name ?? null,
        active: row.active === true,
      };
    }),
  };
};

/** The same shaper, correct: every promised field survives. */
const rightShaper = (data: unknown) => {
  const d = data as { rows?: unknown[] };
  return {
    rows: (d.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        installSlug: row.installSlug ?? null,
        name: row.name ?? null,
        triggerKind: row.triggerKind ?? null,
        active: row.active === true,
      };
    }),
  };
};

const subject = (
  trimmed: (d: unknown) => unknown,
  over: Partial<TrimmedContractSubject> = {},
): TrimmedContractSubject => ({
  name: 'fixture:tool',
  returns: RETURNS,
  shape: { trimmed, contract: { rows: 'rows' } },
  ...over,
});

describe('parseReturnsRowFields', () => {
  it('parses the documented "Each row: { ... }" convention', () => {
    expect(parseReturnsRowFields(RETURNS)).toEqual(['installSlug', 'name', 'triggerKind', 'active']);
  });

  it('returns NULL — not [] — when the prose is not in that form', () => {
    // An empty contract passes vacuously, so "no contract" must be a distinct
    // value the caller is forced to handle.
    expect(parseReturnsRowFields('Returns a snapshot of the fleet.')).toBeNull();
    expect(parseReturnsRowFields(undefined)).toBeNull();
    expect(parseReturnsRowFields('Each row: {  }')).toBeNull();
  });

  it('ignores prose fragments that are not identifiers', () => {
    expect(parseReturnsRowFields('Each row: { a, some phrase, b }')).toEqual(['a', 'b']);
  });
});

describe('checkTrimmedContract — falsifiability controls', () => {
  it('CATCHES a shaper that drops a promised field', () => {
    const v = checkTrimmedContract(subject(wrongShaper));
    expect(v).not.toBeNull();
    expect(v!.dropped).toEqual(['triggerKind']);
    expect(v!.detail).toMatch(/BY DEFAULT/);
  });

  it('calibration: a shaper that preserves every promised field comes back CLEAN', () => {
    expect(checkTrimmedContract(subject(rightShaper))).toBeNull();
  });

  it('does not fire on a tool that has not opted in', () => {
    expect(checkTrimmedContract({ name: 'x', returns: RETURNS, shape: { trimmed: wrongShaper } })).toBeNull();
  });

  it('reports a contract whose `rows` key names the wrong envelope field', () => {
    const v = checkTrimmedContract(subject(rightShaper, { shape: { trimmed: rightShaper, contract: { rows: 'nope' } } }));
    expect(v).not.toBeNull();
    expect(v!.detail).toMatch(/names the wrong key|dropped the row set/);
  });

  it('reports rather than swallows a shaper that throws', () => {
    const v = checkTrimmedContract(
      subject(() => {
        throw new Error('boom');
      }),
    );
    expect(v!.detail).toMatch(/THREW/);
  });

  it('treats an explicitly-nulled field as PRESENT (the key is the signal, not the value)', () => {
    const nulling = (data: unknown) => ({
      rows: ((data as { rows?: unknown[] }).rows ?? []).map(() => ({
        installSlug: null,
        name: null,
        triggerKind: null,
        active: null,
      })),
    });
    expect(checkTrimmedContract(subject(nulling))).toBeNull();
  });

  it('flags an opted-in tool from which no field list can be resolved', () => {
    const bare = subject(rightShaper, { returns: 'no row convention here' });
    expect(unresolvableContracts([bare])).toEqual(['fixture:tool']);
    // ...and such a tool must NOT be silently counted as a pass.
    expect(checkTrimmedContract(bare)).toBeNull();
  });
});

describe('the LIVE tool catalog honours every declared trimmed contract', () => {
  const declared = listDeclaredToolShapers();

  it('reads a plausibly-registered catalog (a vacuous green is worse than a red)', () => {
    // Mirrors MIN_PLAUSIBLE_CATALOG_SIZE in tool-guidance-budget.ts: outside the
    // barrel side-effect the registry holds a handful of tools and every check
    // below would pass having examined nothing.
    expect(listAllProjectedTools().length).toBeGreaterThanOrEqual(500);
  });

  const subjects: TrimmedContractSubject[] = declared.map((d) => ({
    name: d.name,
    returns: d.returns,
    shape: d.shape as TrimmedContractSubject['shape'],
  }));

  it('every opted-in tool resolves a field list', () => {
    expect(unresolvableContracts(subjects)).toEqual([]);
  });

  it('no trimmed shaper drops a field its own `returns` block promises', () => {
    const violations = trimmedContractViolations(subjects);
    expect(
      violations.map((v) => `${v.tool}: dropped ${v.dropped.join(', ')} — ${v.detail}`),
      'a promised row field is unreachable on the DEFAULT payload tier',
    ).toEqual([]);
  });

  it('the guard is actually covering the tools that opted in', () => {
    // Coverage is measured, not assumed: if this drops to zero the suite above
    // is green because it checked nothing.
    const optedIn = subjects.filter((s) => s.shape?.contract && typeof s.shape.trimmed === 'function');
    expect(optedIn.length).toBeGreaterThanOrEqual(1);
  });
});
