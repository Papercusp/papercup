import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildOracleSchemaIndex,
  classifyArms,
  r6PrimaryVerdict,
  validateToolCall,
  type OracleCatalogTool,
  type OracleToolCall,
} from '../r6-malformed-call-oracle';

/**
 * TWO-WAY VALIDATION of the R-6 primary oracle (plan
 * `deterministic-tool-definition-delivery-2026-09-21`, decisions D-033 / D-037).
 *
 * R-6 and R-9 both route a grader to this instrument, so the instrument itself needs a
 * committed falsifier. A malformed-call oracle fails in exactly one interesting
 * direction: it goes SILENT and reports a confident `0 vs 0` PASS. That reading is
 * indistinguishable between "the arms emitted no malformed calls" and "the validator
 * matches nothing" — and the second has already happened once here (keying schemas by
 * the catalog's SANITIZED name while transcripts record the CANONICAL one made every
 * call read as `unknown-tool`, cancelling across both arms).
 *
 * So both directions are asserted, over a COMMITTED fixture of REAL shipping-seed
 * schemas: the oracle CATCHES one deliberate violation of every kind it claims to
 * detect, and is SILENT on well-formed calls against the same schemas. A fixture that
 * quietly loses the constraint a case depends on would make that case pass vacuously,
 * so each case first asserts its own constraint is still present.
 */

type Fixture = {
  sourceToolCount: number;
  tools: Array<{ canonical: string; sanitized: string; input_schema: Record<string, unknown> }>;
};

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/r6-oracle-catalog.json', import.meta.url)), 'utf8'),
) as Fixture;

const COMPACT_ARM = 'compact-tier-shipping-seed';
const FULL_ARM = 'full-tier-shipping-seed';
const ARMS = { compactArm: COMPACT_ARM, fullArm: FULL_ARM };

const catalogTools: OracleCatalogTool[] = fixture.tools.map((t) => ({
  name: t.sanitized,
  input_schema: t.input_schema,
}));
const canonicalBySanitized = new Map(fixture.tools.map((t) => [t.sanitized, t.canonical]));
const schemas = buildOracleSchemaIndex(catalogTools, canonicalBySanitized);

const propsOf = (canonical: string) =>
  (fixture.tools.find((t) => t.canonical === canonical)!.input_schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
const requiredOf = (canonical: string) =>
  (fixture.tools.find((t) => t.canonical === canonical)!.input_schema.required ?? []) as string[];

/** A minimal well-formed input: every required property, with a schema-valid value. */
function wellFormed(canonical: string): Record<string, unknown> {
  const props = propsOf(canonical);
  const out: Record<string, unknown> = {};
  for (const key of requiredOf(canonical)) out[key] = sampleFor(props[key]);
  return out;
}

function sampleFor(prop: Record<string, unknown> | undefined): unknown {
  if (!prop) return 'x';
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum[0];
  const want = Array.isArray(prop.type) ? (prop.type as string[])[0] : (prop.type as string | undefined);
  switch (want) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'x';
  }
}

const firstWith = (predicate: (schema: Record<string, unknown>) => boolean) =>
  fixture.tools.find((t) => predicate(t.input_schema))?.canonical;

describe('R-6 primary oracle — fixture integrity', () => {
  it('carries real shipping-seed schemas with the constraints the cases depend on', () => {
    expect(fixture.sourceToolCount).toBeGreaterThan(40);
    expect(fixture.tools.length).toBeGreaterThan(0);
    // Every canonical name is `group:verb`; a sanitized spelling replaces the colon.
    for (const tool of fixture.tools) {
      expect(tool.canonical).toMatch(/^[a-z0-9_.]+[:.][a-z0-9_.-]+$/i);
      expect(tool.input_schema).toBeTypeOf('object');
    }
    expect(firstWith((s) => ((s.required ?? []) as string[]).length > 0)).toBeTruthy();
    expect(
      firstWith((s) =>
        Object.values((s.properties ?? {}) as Record<string, Record<string, unknown>>).some(
          (p) => Array.isArray(p.enum) && p.enum.length > 1,
        ),
      ),
    ).toBeTruthy();
  });

  it('indexes every schema under BOTH the canonical and the sanitized spelling', () => {
    // The vacuous-pass bug: transcripts record the canonical name, catalogs carry the
    // sanitized one. A miss here makes every call `unknown-tool` in both arms at once.
    for (const tool of fixture.tools) {
      expect(schemas.get(tool.canonical), `canonical ${tool.canonical}`).toBeDefined();
      expect(schemas.get(tool.sanitized), `sanitized ${tool.sanitized}`).toBeDefined();
    }
    expect(fixture.tools.some((t) => t.canonical !== t.sanitized)).toBe(true);
  });
});

describe('R-6 primary oracle — direction 1: it CATCHES each class it claims to detect', () => {
  it('flags a call to a tool that is not in the catalog', () => {
    expect(validateToolCall(schemas, 'not-a-real:tool', {})).toEqual([
      { kind: 'unknown-tool', detail: 'not-a-real:tool' },
    ]);
  });

  it('flags an input that is not an object', () => {
    const canonical = fixture.tools[0]!.canonical;
    expect(validateToolCall(schemas, canonical, 'a string')[0]?.kind).toBe('input-not-object');
    expect(validateToolCall(schemas, canonical, ['a', 'list'])[0]?.kind).toBe('input-not-object');
    expect(validateToolCall(schemas, canonical, null)[0]?.kind).toBe('input-not-object');
  });

  it('flags a missing required property', () => {
    const canonical = firstWith((s) => ((s.required ?? []) as string[]).length > 0)!;
    const missing = requiredOf(canonical)[0]!;
    const input = wellFormed(canonical);
    delete input[missing];
    expect(validateToolCall(schemas, canonical, input)).toContainEqual({
      kind: 'missing-required',
      detail: missing,
    });
  });

  it('flags a value of the wrong type', () => {
    const canonical = firstWith((s) =>
      Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>).some(
        ([, p]) => p.type === 'string',
      ),
    )!;
    const stringProp = Object.entries(propsOf(canonical)).find(([, p]) => p.type === 'string')![0];
    const violations = validateToolCall(schemas, canonical, { ...wellFormed(canonical), [stringProp]: 12345 });
    expect(violations.some((v) => v.kind.startsWith('type-mismatch:') && v.detail === stringProp)).toBe(true);
  });

  it('flags a value outside a declared enum', () => {
    const canonical = firstWith((s) =>
      Object.values((s.properties ?? {}) as Record<string, Record<string, unknown>>).some(
        (p) => Array.isArray(p.enum) && p.enum.length > 1,
      ),
    )!;
    const enumProp = Object.entries(propsOf(canonical)).find(([, p]) => Array.isArray(p.enum))![0];
    const violations = validateToolCall(schemas, canonical, {
      ...wellFormed(canonical),
      [enumProp]: '__not_a_member__',
    });
    expect(violations).toContainEqual({ kind: 'enum-violation', detail: enumProp });
  });

  it('flags an unknown property ONLY where the schema closes the object', () => {
    // Data-driven over EVERY fixture tool rather than one representative: an
    // `if (open) { … }` shape goes silently vacuous the day the fixture happens to hold
    // no open schema, which is exactly the failure this file exists to make impossible.
    // An OPEN schema legitimately permits extra keys — flagging them would manufacture a
    // class difference out of a schema the model was never told was closed.
    let checked = 0;
    for (const tool of fixture.tools) {
      const closed = tool.input_schema.additionalProperties === false;
      const violations = validateToolCall(schemas, tool.canonical, {
        ...wellFormed(tool.canonical),
        __stray__: 1,
      });
      const flagged = violations.some((v) => v.kind === 'unknown-property' && v.detail === '__stray__');
      expect(flagged, `${tool.canonical} (additionalProperties:${String(tool.input_schema.additionalProperties)})`).toBe(
        closed,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('R-6 primary oracle — the VACUOUS-PASS control', () => {
  it('a schema index missing the canonical spelling reports a confident PASS having validated nothing', () => {
    // The deliberately-wrong implementation, kept permanently as a control: index the
    // schemas ONLY under their sanitized spelling, the way the first draft of this oracle
    // did. Transcripts record the canonical name, so every call in BOTH arms degrades to
    // `unknown-tool`, the classes cancel, and D-033's rule returns PASS — a green verdict
    // from an instrument that validated zero calls. If this control ever stops producing
    // a PASS, the oracle has changed shape and the index assertion above needs revisiting.
    const sanitizedOnly = new Map<string, Record<string, unknown>>(
      fixture.tools.map((t) => [t.sanitized, t.input_schema] as const),
    );
    const rows: OracleToolCall[] = fixture.tools.flatMap((t) => [
      { arm: COMPACT_ARM, name: t.canonical, input: wellFormed(t.canonical) },
      { arm: FULL_ARM, name: t.canonical, input: wellFormed(t.canonical) },
    ]);
    const blind = r6PrimaryVerdict(rows, sanitizedOnly, ARMS);
    expect(blind.verdict).toBe('PASS');
    expect(blind.compactClasses.every((cls) => cls.endsWith(':: unknown-tool'))).toBe(true);
    expect(blind.compactClasses.length).toBe(fixture.tools.length);

    // The SAME rows through the correctly-built index validate for real and stay silent.
    const sound = r6PrimaryVerdict(rows, schemas, ARMS);
    expect(sound.verdict).toBe('PASS');
    expect(sound.compactClasses).toEqual([]);
  });
});

describe('R-6 primary oracle — direction 2: it is SILENT on well-formed calls', () => {
  it('reports no violation for a minimal valid input to every fixture tool', () => {
    for (const tool of fixture.tools) {
      expect(validateToolCall(schemas, tool.canonical, wellFormed(tool.canonical)), tool.canonical).toEqual([]);
      expect(validateToolCall(schemas, tool.sanitized, wellFormed(tool.canonical)), tool.sanitized).toEqual([]);
    }
  });
});

describe('R-6 primary oracle — the D-033 decision rule', () => {
  const clean = (arm: string): OracleToolCall[] =>
    fixture.tools.map((t) => ({ arm, scenario: 's1', name: t.canonical, input: wellFormed(t.canonical) }));

  it('PASSES when both arms carry only well-formed calls', () => {
    const verdict = r6PrimaryVerdict([...clean(COMPACT_ARM), ...clean(FULL_ARM)], schemas, ARMS);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.onlyInCompact).toEqual([]);
    expect(verdict.callCounts[COMPACT_ARM]).toBe(fixture.tools.length);
  });

  it('FAILS, naming the class, when a malformed class appears ONLY in the compact arm', () => {
    const canonical = firstWith((s) => ((s.required ?? []) as string[]).length > 0)!;
    const missing = requiredOf(canonical)[0]!;
    const broken = wellFormed(canonical);
    delete broken[missing];
    const verdict = r6PrimaryVerdict(
      [
        ...clean(COMPACT_ARM),
        { arm: COMPACT_ARM, scenario: 's2', name: canonical, input: broken },
        ...clean(FULL_ARM),
      ],
      schemas,
      ARMS,
    );
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.onlyInCompact).toEqual([`${canonical} :: missing-required`]);
  });

  it('PASSES when the SAME malformed class appears in both arms — this bars a TIER effect, not errors', () => {
    const canonical = firstWith((s) => ((s.required ?? []) as string[]).length > 0)!;
    const missing = requiredOf(canonical)[0]!;
    const broken = wellFormed(canonical);
    delete broken[missing];
    const verdict = r6PrimaryVerdict(
      [
        ...clean(COMPACT_ARM),
        { arm: COMPACT_ARM, scenario: 's2', name: canonical, input: broken },
        ...clean(FULL_ARM),
        { arm: FULL_ARM, scenario: 's2', name: canonical, input: broken },
      ],
      schemas,
      ARMS,
    );
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.compactClasses).toEqual([`${canonical} :: missing-required`]);
    expect(verdict.fullClasses).toEqual([`${canonical} :: missing-required`]);
  });

  it('is INDETERMINATE — never PASS — when an arm contributed no calls at all', () => {
    // The pool-starvation outage of D-039 emptied an arm exactly this way. A "0 vs 0"
    // read as a pass there would have shipped a verdict from an unmeasured contrast.
    const verdict = r6PrimaryVerdict(clean(COMPACT_ARM), schemas, ARMS);
    expect(verdict.verdict).toBe('INDETERMINATE');
    expect(verdict.reason).toMatch(/no calls/);
  });

  it('counts a CLASS once per arm however many instances it has', () => {
    const canonical = firstWith((s) => ((s.required ?? []) as string[]).length > 0)!;
    const missing = requiredOf(canonical)[0]!;
    const broken = wellFormed(canonical);
    delete broken[missing];
    const rows: OracleToolCall[] = [
      ...clean(COMPACT_ARM),
      ...Array.from({ length: 7 }, () => ({ arm: COMPACT_ARM, name: canonical, input: broken })),
      ...clean(FULL_ARM),
    ];
    const { perArm } = classifyArms(rows, schemas, ARMS);
    const compact = perArm.get(COMPACT_ARM)!;
    expect(compact.size).toBe(1);
    expect(compact.get(`${canonical} :: missing-required`)?.count).toBe(7);
  });
});
