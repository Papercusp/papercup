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

  it('work_items:set_state is advertised positionally (single `row` arg)', () => {
    const e = SU_CATALOG.find((e) => e.name === 'work_items:set_state')!;
    const props = (e.input as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(['row']);
  });

  it('audit:list documents its headerless-CSV read contract', () => {
    const e = SU_CATALOG.find((e) => e.name === 'audit:list')!;
    expect(e.description).toMatch(/headerless csv/i);
  });

  it('includes the design-phase group the playbook mandates for UI work', () => {
    expect(names.some((n) => n.startsWith('design-phase:'))).toBe(true);
  });
});
