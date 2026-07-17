/**
 * Rubric Ref Alias Tests (EI-11400, WI-4652)
 *
 * Verify that both rubrics:get and rubrics:trend accept the canonical rubricRef
 * and the backward-compatibility alias rubricId, resolve correctly, and reject
 * genuine conflicts when both are passed with different values.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { rejectRubricRefIdConflict, resolveRubricRefAlias, resolveRubricRefArrayAlias } from './_ref-alias';

describe('Rubric Ref Alias Helpers (EI-11400)', () => {
  describe('rejectRubricRefIdConflict — conflict detection', () => {
    it('accepts neither rubricRef nor rubricId (validation handles requirement elsewhere)', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectRubricRefIdConflict({}, ctx)).not.toThrow();
    });

    it('accepts only rubricRef', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectRubricRefIdConflict({ rubricRef: 'foo' }, ctx)).not.toThrow();
    });

    it('accepts only rubricId', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectRubricRefIdConflict({ rubricId: 'foo' }, ctx)).not.toThrow();
    });

    it('accepts both with the SAME value', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() =>
        rejectRubricRefIdConflict({ rubricRef: 'foo', rubricId: 'foo' }, ctx),
      ).not.toThrow();
    });

    it('rejects both with DIFFERENT values', () => {
      const issues: unknown[] = [];
      const ctx = {
        addIssue: (issue) => issues.push(issue),
      } as unknown as z.RefinementCtx;

      rejectRubricRefIdConflict({ rubricRef: 'foo', rubricId: 'bar' }, ctx);

      expect(issues).toHaveLength(1);
      const issue = issues[0] as Record<string, unknown>;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect((issue.message as string).toLowerCase()).toContain('same field');
      expect((issue.message as string).toLowerCase()).toContain('ambiguous');
    });
  });

  describe('resolveRubricRefAlias — single ref resolution', () => {
    it('returns rubricRef when only rubricRef is passed', () => {
      expect(resolveRubricRefAlias({ rubricRef: 'foo' })).toBe('foo');
    });

    it('returns rubricId when only rubricId is passed (alias)', () => {
      expect(resolveRubricRefAlias({ rubricId: 'bar' })).toBe('bar');
    });

    it('returns rubricRef when both are passed with the same value', () => {
      expect(resolveRubricRefAlias({ rubricRef: 'foo', rubricId: 'foo' })).toBe('foo');
    });

    it('prefers rubricRef when both are passed (rubricRef takes precedence)', () => {
      // After conflict rejection, at most one differs, so preference doesn't matter in practice
      // But we assert the ?? order: rubricRef ?? rubricId
      expect(resolveRubricRefAlias({ rubricRef: 'foo', rubricId: 'bar' })).toBe('foo');
    });

    it('returns undefined when neither is passed', () => {
      expect(resolveRubricRefAlias({})).toBeUndefined();
    });
  });

  describe('resolveRubricRefArrayAlias — array resolution', () => {
    it('returns rubricRefs when only rubricRefs is passed', () => {
      const refs = ['a', 'b', 'c'];
      expect(resolveRubricRefArrayAlias({ rubricRefs: refs })).toEqual(refs);
    });

    it('returns rubricIds when only rubricIds is passed (alias)', () => {
      const ids = ['x', 'y', 'z'];
      expect(resolveRubricRefArrayAlias({ rubricIds: ids })).toEqual(ids);
    });

    it('prefers rubricRefs when both are passed', () => {
      const refs = ['a', 'b'];
      const ids = ['x', 'y'];
      expect(resolveRubricRefArrayAlias({ rubricRefs: refs, rubricIds: ids })).toEqual(refs);
    });

    it('returns undefined when neither is passed', () => {
      expect(resolveRubricRefArrayAlias({})).toBeUndefined();
    });
  });

  describe('Integration: Zod schema with alias support', () => {
    const makeRubricRefSchema = (singleName: string, arrayName: string) =>
      z
        .object({
          [singleName]: z.string().optional(),
          rubricId: z.string().optional(),
          [arrayName]: z.array(z.string()).optional(),
          rubricIds: z.array(z.string()).optional(),
        })
        .superRefine(rejectRubricRefIdConflict)
        .refine((a) => {
          const ref = resolveRubricRefAlias({ rubricRef: a[singleName], rubricId: a.rubricId });
          const refs = resolveRubricRefArrayAlias({
            rubricRefs: a[arrayName],
            rubricIds: a.rubricIds,
          });
          return Boolean(ref) || (refs?.length ?? 0) > 0;
        }, {
          message: 'pass at least one ref',
        });

    it('schema accepts canonical rubricRef', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricRef: 'foo' });
      expect(result.success).toBe(true);
    });

    it('schema accepts alias rubricId', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricId: 'bar' });
      expect(result.success).toBe(true);
    });

    it('schema accepts canonical rubricRefs array', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricRefs: ['a', 'b'] });
      expect(result.success).toBe(true);
    });

    it('schema accepts alias rubricIds array', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricIds: ['x', 'y'] });
      expect(result.success).toBe(true);
    });

    it('schema rejects conflict (both with different values)', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricRef: 'foo', rubricId: 'bar' });
      expect(result.success).toBe(false);
    });

    it('schema accepts both with the same value (no conflict)', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({ rubricRef: 'foo', rubricId: 'foo' });
      expect(result.success).toBe(true);
    });

    it('schema rejects when neither is passed (required validation)', () => {
      const schema = makeRubricRefSchema('rubricRef', 'rubricRefs');
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
