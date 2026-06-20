/**
 * Plan-template registry (plan-templates-and-rubric-v2 P-004) — the code-registry
 * infra: register/get/list/isKnown + validate-on-write. Pure unit tests with a
 * fixture schema (the real 'rubric' schema is P-006).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  registerPlanTemplate,
  getPlanTemplate,
  isKnownPlanTemplate,
  listPlanTemplates,
  validateTemplateData,
  _resetPlanTemplateRegistryForTests,
} from './template-registry';

const fixture = {
  name: 'test-template',
  description: 'a test template',
  schema: z.object({ characteristic: z.string(), n: z.number() }),
};

describe('plan-template registry', () => {
  beforeEach(() => _resetPlanTemplateRegistryForTests());

  it('register → get / isKnown / list round-trip', () => {
    expect(isKnownPlanTemplate('test-template')).toBe(false);
    registerPlanTemplate(fixture);
    expect(isKnownPlanTemplate('test-template')).toBe(true);
    expect(getPlanTemplate('test-template')?.description).toBe('a test template');
    expect(listPlanTemplates().map((t) => t.name)).toEqual(['test-template']);
  });

  it('register is idempotent by name (last write wins)', () => {
    registerPlanTemplate(fixture);
    registerPlanTemplate({ ...fixture, description: 'updated' });
    expect(listPlanTemplates()).toHaveLength(1);
    expect(getPlanTemplate('test-template')?.description).toBe('updated');
  });

  describe('validateTemplateData', () => {
    beforeEach(() => registerPlanTemplate(fixture));

    it('accepts valid data + returns the parsed value', () => {
      const r = validateTemplateData('test-template', { characteristic: 'x', n: 3 });
      expect(r).toEqual({ ok: true, data: { characteristic: 'x', n: 3 } });
    });

    it('rejects an unknown template, naming the known set', () => {
      const r = validateTemplateData('nope', {});
      expect(r).toEqual({ ok: false, code: 'unknown_template', known: ['test-template'] });
    });

    it('rejects schema-invalid data fail-loud with issue paths', () => {
      const r = validateTemplateData('test-template', { characteristic: 'x' }); // missing n
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === 'invalid_data') {
        expect(r.issues.join(' ')).toMatch(/n/);
      } else {
        throw new Error('expected invalid_data');
      }
    });
  });
});
