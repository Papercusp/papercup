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
  classifyDeclaredShapers,
  SHAPER_CONTRACT_EXEMPT,
  SHAPER_BASELINE_HIGH_WATERMARK,
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

describe('checkTrimmedContract — the TOP-LEVEL axis (WI-2145870)', () => {
  const withPreserve = (
    trimmed: (d: unknown) => unknown,
    preserve: readonly string[] = ['scope'],
    over: Partial<TrimmedContractSubject> = {},
  ): TrimmedContractSubject => ({
    name: 'fixture:tool',
    returns: RETURNS,
    shape: { trimmed, contract: { rows: 'rows', preserve } },
    ...over,
  });

  /** Correct on BOTH axes: every row field preserved AND the top-level block carried. */
  const keepsTopLevel = (data: unknown) => ({
    ...(rightShaper(data) as Record<string, unknown>),
    scope: (data as { scope?: unknown }).scope,
  });

  it('CATCHES a shaper that keeps every ROW field but drops a top-level block', () => {
    // `rightShaper` is this file's own "correct" shaper — and it IS correct, on
    // the row axis. It also rebuilds the envelope as `{ rows }`, so the block
    // beside the rows vanishes. That combination is the whole point of this
    // item: the row guard reads green while the qualifier is gone, which is how
    // a self-scoped `fleet:assignments` became indistinguishable from a
    // measured-empty fleet (EI-18763132241176410).
    const v = checkTrimmedContract(withPreserve(rightShaper));
    expect(v).not.toBeNull();
    expect(v?.droppedTopLevel).toEqual(['scope']);
    expect(v?.dropped).toEqual([]);
  });

  it('calibration: carrying the top-level block through comes back CLEAN', () => {
    expect(checkTrimmedContract(withPreserve(keepsTopLevel))).toBeNull();
  });

  it('checks the top-level axis even when NO row field list resolves (preserve-only)', () => {
    // The same vacuity this item reports, one level down: a preserve-only
    // contract must not be silently skipped by the row axis's opt-in test.
    const v = checkTrimmedContract(
      withPreserve(rightShaper, ['scope'], { returns: 'prose that names no row block' }),
    );
    expect(v?.droppedTopLevel).toEqual(['scope']);
  });

  it('does NOT report a preserve-only contract as unresolvable (WI-2145871)', () => {
    // The sibling assertion the test above was missing. `checkTrimmedContract`
    // opts in on the UNION of the two axes, but `unresolvableContracts` judged
    // vacuity on the ROW axis alone — so the very subject the test above proves
    // is fully checked was simultaneously reported as checking nothing. Because
    // the live-registry assertion requires that list to be EMPTY, this made a
    // preserve-only opt-in unlandable: exactly the repair shape this class's
    // confirmed instance needs (`fleet:assignments` dropped a top-level `scope`
    // block, EI-18763132241176410), which is why no baseline entry could be
    // retired that way.
    const preserveOnly = withPreserve(keepsTopLevel, ['scope'], {
      returns: 'prose that names no row block',
    });
    // Pin the premise: this fixture resolves NO row fields, so it is the case
    // the old row-axis-only test reported.
    expect(parseReturnsRowFields(preserveOnly.returns)).toBeNull();
    expect(unresolvableContracts([preserveOnly])).toEqual([]);
    // ...and it is genuinely CHECKED, not merely unreported — the dropping
    // variant on that same axis is still caught. Without this pair, silencing
    // the false positive would be indistinguishable from silencing the guard.
    expect(checkTrimmedContract(preserveOnly)).toBeNull();
    expect(
      checkTrimmedContract(
        withPreserve(rightShaper, ['scope'], { returns: 'prose that names no row block' }),
      )?.droppedTopLevel,
    ).toEqual(['scope']);
  });

  it('STILL reports a contract that resolves NEITHER axis', () => {
    // The guard this fix must not weaken. No row fields and no preserve keys is
    // genuinely vacuous and has to stay loud.
    expect(
      unresolvableContracts([
        withPreserve(keepsTopLevel, [], { returns: 'prose that names no row block' }),
      ]),
    ).toEqual(['fixture:tool']);
  });

  it('does not let `rows` itself make a contract resolvable', () => {
    // `rows` names the row CONTAINER, so preserving it is not a top-level
    // guarantee. `checkTrimmedContract` excludes it from the preserve set and
    // this must agree, or `preserve: ['rows']` would be a way to silence the
    // vacuity report while promising nothing.
    expect(
      unresolvableContracts([
        withPreserve(keepsTopLevel, ['rows'], { returns: 'prose that names no row block' }),
      ]),
    ).toEqual(['fixture:tool']);
  });

  it('treats an explicitly-nulled top-level key as PRESENT (the key is the signal)', () => {
    const nulling = (data: unknown) => ({
      ...(rightShaper(data) as Record<string, unknown>),
      scope: null,
    });
    expect(checkTrimmedContract(withPreserve(nulling))).toBeNull();
  });

  it('reports BOTH axes when a shaper drops a row field AND a top-level block', () => {
    const v = checkTrimmedContract(withPreserve(wrongShaper));
    expect(v?.dropped).toEqual(['triggerKind']);
    expect(v?.droppedTopLevel).toEqual(['scope']);
    expect(v?.detail).toContain('top-level');
  });

  it('ignores a preserve entry naming the rows key itself (no self-collision)', () => {
    expect(checkTrimmedContract(withPreserve(rightShaper, ['rows']))).toBeNull();
  });

  it('does not fire on a contract that declares no preserve list', () => {
    expect(checkTrimmedContract(subject(rightShaper))).toBeNull();
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
    //
    // EI-21353488282456582: this used to read `toBeGreaterThanOrEqual(1)`, a
    // floor set at the then-current population of one. It passed for 18 days
    // while adoption stayed at that single tool, because a floor of one is
    // satisfied forever by the tool that motivated the guard. The real
    // coverage property is the classification assertion below; this stays as
    // the vacuous-green tripwire it was always meant to be.
    const optedIn = subjects.filter((s) => s.shape?.contract && typeof s.shape.trimmed === 'function');
    expect(optedIn.length).toBeGreaterThanOrEqual(1);
  });

  it('every tool declaring a payload shaper is a deliberate covered/exempt decision', () => {
    const { unclassified } = classifyDeclaredShapers(subjects);
    // The offenders are interpolated into the MESSAGE, not left to the value
    // diff: vitest truncates a long array or string repr after a few entries,
    // and the whole point of this failure is to name every tool still awaiting
    // a decision.
    expect(
      unclassified,
      `${unclassified.length} tool(s) declare a \`shape.trimmed\` payload shaper but neither ` +
        'opt in via `shape.contract` nor appear in SHAPER_CONTRACT_EXEMPT:\n' +
        unclassified.map((t) => `  - ${t}`).join('\n') +
        '\n\nA shaper that rebuilds its result from a hand-written key list drops anything ' +
        'not on that list with no truncation notice, and the result still reads ok:true — so ' +
        'the field looks absent from the data rather than removed by the shaper. Decide: add ' +
        '`contract: { rows }` to opt in, or add an entry with a REASON to SHAPER_CONTRACT_EXEMPT.',
    ).toEqual([]);
  });

  it('the unaudited baseline only ever SHRINKS', () => {
    const { baseline } = classifyDeclaredShapers(subjects);
    expect(
      baseline.length,
      `SHAPER_CONTRACT_EXEMPT records ${baseline.length} shaper(s) as unaudited debt, over a ` +
        `watermark of ${SHAPER_BASELINE_HIGH_WATERMARK}. This list is SHRINK-ONLY. If you added ` +
        'a new payload shaper, do not park it here — opt it in with `contract: { rows }`, or ' +
        'record a `reasoned` exemption saying why a row contract is wrong for it. Lower the ' +
        'watermark when you audit one; raising it means a shaper shipped unclassified, which ' +
        'is what this gate exists to stop.',
    ).toBeLessThanOrEqual(SHAPER_BASELINE_HIGH_WATERMARK);
  });

  it('no exemption names a tool that has stopped declaring a shaper', () => {
    // The other direction. A one-way allowlist rots into a set of claims about
    // code that has moved — the same hand-typed-list failure this file's header
    // describes. An exemption whose tool no longer declares a shaper is a stale
    // claim, and it must be removed rather than left to look like coverage.
    const { staleExemptions } = classifyDeclaredShapers(subjects);
    expect(staleExemptions, 'stale SHAPER_CONTRACT_EXEMPT entries — remove them').toEqual([]);
  });
});

describe('classifyDeclaredShapers — falsifiability controls', () => {
  const shaper = (data: unknown) => data;
  const declaring = (name: string, contract?: { rows: string }): TrimmedContractSubject => ({
    name,
    returns: RETURNS,
    shape: contract ? { trimmed: shaper, contract } : { trimmed: shaper },
  });

  it('CATCHES a tool that declares a shaper with no decision recorded', () => {
    const { unclassified } = classifyDeclaredShapers([declaring('fixture:undecided')], {});
    expect(unclassified).toEqual(['fixture:undecided']);
  });

  it('calibration: an opted-in tool and an exempt tool both come back CLEAN', () => {
    const { unclassified } = classifyDeclaredShapers(
      [declaring('fixture:opted', { rows: 'rows' }), declaring('fixture:exempt')],
      {
        'fixture:exempt': {
          case: 'reasoned',
          reason: 'deliberately omits optional legs and says so in-band',
        },
      },
    );
    expect(unclassified).toEqual([]);
  });

  it('counts baseline DEBT separately from a reasoned decision', () => {
    // The split is the point: a reasoned exemption is an answer and must not be
    // rationed, while unaudited debt must be. Conflating them would let the
    // watermark be satisfied by decisions and hide the debt it exists to cap.
    const { baseline } = classifyDeclaredShapers(
      [declaring('fixture:decided'), declaring('fixture:debt')],
      {
        'fixture:decided': { case: 'reasoned', reason: 'dropping data is this tool\'s job' },
        'fixture:debt': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
      },
    );
    expect(baseline).toEqual(['fixture:debt']);
  });

  it('does not count baseline debt for a tool that no longer declares a shaper', () => {
    // Otherwise the watermark could be satisfied by debt that has evaporated,
    // leaving room for a real new shaper to be parked without failing the gate.
    const { baseline } = classifyDeclaredShapers([], {
      'fixture:departed': { case: 'unclassified-baseline', reason: 'pre-existing; not yet audited' },
    });
    expect(baseline).toEqual([]);
  });

  it('does not demand a decision from a tool that declares no shaper at all', () => {
    const noShaper: TrimmedContractSubject = { name: 'fixture:plain', returns: RETURNS };
    expect(classifyDeclaredShapers([noShaper], {}).unclassified).toEqual([]);
  });

  it('CATCHES an exemption whose tool no longer declares a shaper', () => {
    const { staleExemptions } = classifyDeclaredShapers([declaring('fixture:live')], {
      'fixture:live': { case: 'reasoned', reason: 'still declares one' },
      'fixture:departed': { case: 'reasoned', reason: 'this tool lost its shaper in a refactor' },
    });
    expect(staleExemptions).toEqual(['fixture:departed']);
  });
});
