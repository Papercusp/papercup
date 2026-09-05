/**
 * Tests for the curated `papercusp-su` tool catalog used by the in-process `su`
 * target — the name sanitizer, the Anthropic-shape builder, and the
 * load-bearing playbook invariants the SU behavioral scenarios assert against.
 * Run with: cd packages/operator-core && npx vitest run lib/llm-testing/__tests__/su-catalog.test.ts
 */
import { describe, expect, it } from 'vitest';
import { sanitizeToolName, buildCatalog, SU_CATALOG } from '../targets/su-catalog';

const ANTHROPIC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe('sanitizeToolName', () => {
  it('replaces every colon with a double underscore', () => {
    expect(sanitizeToolName('docs:get')).toBe('docs__get');
    expect(sanitizeToolName('a:b:c')).toBe('a__b__c');
  });

  it('leaves hyphens and underscores untouched', () => {
    expect(sanitizeToolName('design-phase:list_tokens')).toBe('design-phase__list_tokens');
  });

  it('passes through a name with no colon', () => {
    expect(sanitizeToolName('repomix_pack')).toBe('repomix_pack');
  });
});

describe('buildCatalog', () => {
  it('defaults to SU_CATALOG and produces one tool per entry', () => {
    const built = buildCatalog();
    expect(built.tools).toHaveLength(SU_CATALOG.length);
  });

  it('sanitizes every tool name to the Anthropic constraint', () => {
    for (const t of buildCatalog().tools) {
      expect(t.name).toMatch(ANTHROPIC_NAME_RE);
      expect(t.name).not.toContain(':');
    }
  });

  it('round-trips sanitized → canonical via canonicalBySanitized', () => {
    const built = buildCatalog();
    for (const t of built.tools) {
      const canonical = built.canonicalBySanitized.get(t.name);
      expect(canonical).toBeDefined();
      expect(sanitizeToolName(canonical!)).toBe(t.name);
    }
  });

  it('forces input_schema.type === "object" on every tool', () => {
    for (const t of buildCatalog().tools) {
      expect(t.input_schema.type).toBe('object');
    }
  });

  it('falls back to a bare object schema for a non-object input', () => {
    const built = buildCatalog([
      { name: 'x:y', description: 'd', input: { type: 'string' } as Record<string, unknown> },
    ]);
    expect(built.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('honors a custom catalog argument', () => {
    const built = buildCatalog([{ name: 'only:one', description: 'd', input: { type: 'object' } }]);
    expect(built.tools).toHaveLength(1);
    expect(built.canonicalBySanitized.get('only__one')).toBe('only:one');
  });
});

describe('SU_CATALOG load-bearing invariants (what the scenarios assert)', () => {
  const names = SU_CATALOG.map((e) => e.name);

  it('every entry uses the canonical colon form', () => {
    for (const n of names) expect(n).toContain(':');
  });

  it('has no duplicate names', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes NO feature-update / raw-SQL write tool (SU-S05)', () => {
    expect(names).not.toContain('features:update');
    expect(names.some((n) => /features:(update|set)|sql|raw/i.test(n))).toBe(false);
  });

  it('docs:* and plans:* readers carry the harness scope arg', () => {
    for (const e of SU_CATALOG.filter((e) => e.name.startsWith('docs:') || e.name.startsWith('plans:'))) {
      const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).toHaveProperty('harness');
    }
  });

  it('advertises improvements:capture ideation.cheapExperiment as a structured ScoutExperiment', () => {
    const entry = SU_CATALOG.find((e) => e.name === 'improvements:capture')!;
    const properties = (entry.input as { properties?: Record<string, any> }).properties ?? {};
    const ideation = properties.ideation as { properties?: Record<string, any> };
    const cheapExperiment = ideation.properties?.cheapExperiment;

    expect(cheapExperiment).toMatchObject({
      type: 'object',
      required: ['hypothesis', 'method', 'falsifiableSignal'],
    });
    expect(cheapExperiment.properties).toEqual({
      hypothesis: expect.objectContaining({ type: 'string' }),
      method: expect.objectContaining({ type: 'string' }),
      falsifiableSignal: expect.objectContaining({ type: 'string' }),
    });
  });

  it('work_items:set_state is advertised with keyed lifecycle args', () => {
    const e = SU_CATALOG.find((e) => e.name === 'work_items:set_state')!;
    const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('ids');
    expect(props).toHaveProperty('items');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('completionRef');
    expect(props).toHaveProperty('assumptions');
    expect(props).not.toHaveProperty('row');
    expect((props.ids as { maxItems?: number }).maxItems).toBe(200);
    expect(e.input).not.toHaveProperty('anyOf');
  });

  it('work_items:get advertises the real scalar-or-bulk id contract', () => {
    const e = SU_CATALOG.find((entry) => entry.name === 'work_items:get')!;
    const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('ids');
    expect((props.ids as { minItems?: number; maxItems?: number })).toMatchObject({
      minItems: 1,
      maxItems: 100,
    });
    expect(e.input).not.toHaveProperty('anyOf');
  });

  it('locks:acquire exposes the queued wake path required by SU-S11', () => {
    const entry = SU_CATALOG.find((candidate) => candidate.name === 'locks:acquire')!;
    const properties = (entry.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties.wake_on_grant).toMatchObject({ type: 'boolean' });
    expect(entry.description).toMatch(/wake_on_grant:true/);
    expect(entry.description).toMatch(/end your turn/i);
  });

  it('keeps every Anthropic tool input schema free of unsupported top-level combinators', () => {
    for (const entry of SU_CATALOG) {
      expect(entry.input, entry.name).not.toHaveProperty('oneOf');
      expect(entry.input, entry.name).not.toHaveProperty('anyOf');
      expect(entry.input, entry.name).not.toHaveProperty('allOf');
    }
  });

  it('audit:list documents its self-describing TOON read contract (EI-136)', () => {
    const e = SU_CATALOG.find((e) => e.name === 'audit:list')!;
    // The catalog the SUT reads must describe the encoding it will actually be
    // handed, or SU-S08 measures the model against a contract that isn't shipped.
    expect(e.description).toMatch(/toon/i);
    expect(e.description).toMatch(/id,ts,actor,action,subject/);
    // It must NOT still advertise the headerless form that EI-136 retired.
    expect(e.description).not.toMatch(/headerless/i);
  });

  it('reserves harness:overview for a compound picture and routes one status fact directly (SU-S19/S20)', () => {
    const e = SU_CATALOG.find((entry) => entry.name === 'harness:overview')!;
    expect(e.description).toContain("COMPOUND 'state of X'");
    expect(e.description).toContain('multi-part/full-picture');
    expect(e.description).toContain('single fact such as active/current phase');
    expect(e.description).toContain('direct harness:status call');
  });

  it('includes the design-phase group the playbook mandates for UI work', () => {
    expect(names.some((n) => n.startsWith('design-phase:'))).toBe(true);
  });
});
