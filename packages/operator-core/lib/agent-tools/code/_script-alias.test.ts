/**
 * Script Alias Tests (EI-11400, WI-4652)
 *
 * Verify that code:run accepts the canonical script and the backward-compatibility
 * alias code, resolves correctly, and rejects genuine conflicts when both are passed
 * with different values.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { rejectScriptCodeConflict, resolveScriptAlias } from './_script-alias';

describe('Script Alias Helpers (EI-11400)', () => {
  describe('rejectScriptCodeConflict — conflict detection', () => {
    it('accepts neither script nor code (validation handles requirement elsewhere)', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectScriptCodeConflict({}, ctx)).not.toThrow();
    });

    it('accepts only script', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectScriptCodeConflict({ script: 'return 1;' }, ctx)).not.toThrow();
    });

    it('accepts only code', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() => rejectScriptCodeConflict({ code: 'return 1;' }, ctx)).not.toThrow();
    });

    it('accepts both with the SAME value', () => {
      const ctx = { addIssue: () => {} } as unknown as z.RefinementCtx;
      expect(() =>
        rejectScriptCodeConflict({ script: 'return 1;', code: 'return 1;' }, ctx),
      ).not.toThrow();
    });

    it('rejects both with DIFFERENT values', () => {
      const issues: unknown[] = [];
      const ctx = {
        addIssue: (issue) => issues.push(issue),
      } as unknown as z.RefinementCtx;

      rejectScriptCodeConflict({ script: 'return 1;', code: 'return 2;' }, ctx);

      expect(issues).toHaveLength(1);
      const issue = issues[0] as Record<string, unknown>;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect((issue.message as string).toLowerCase()).toContain('same field');
      expect((issue.message as string).toLowerCase()).toContain('ambiguous');
    });
  });

  describe('resolveScriptAlias — script resolution', () => {
    it('returns script when only script is passed', () => {
      expect(resolveScriptAlias({ script: 'return 1;' })).toBe('return 1;');
    });

    it('returns code when only code is passed (alias)', () => {
      expect(resolveScriptAlias({ code: 'console.log("hi");' })).toBe('console.log("hi");');
    });

    it('returns script when both are passed with the same value', () => {
      const scriptBody = 'return 1 + 1;';
      expect(resolveScriptAlias({ script: scriptBody, code: scriptBody })).toBe(scriptBody);
    });

    it('prefers script when both are passed (script takes precedence)', () => {
      // After conflict rejection, at most one differs, so preference doesn't matter in practice
      // But we assert the ?? order: script ?? code
      expect(resolveScriptAlias({ script: 'return 1;', code: 'return 2;' })).toBe('return 1;');
    });

    it('returns undefined when neither is passed', () => {
      expect(resolveScriptAlias({})).toBeUndefined();
    });
  });

  describe('Integration: Zod schema with script/code alias', () => {
    const makeCodeRunSchema = () =>
      z
        .object({
          script: z.string().min(1).max(100).optional(),
          code: z.string().min(1).max(100).optional(),
          title: z.string().optional(),
        })
        .superRefine(rejectScriptCodeConflict)
        .refine((a) => Boolean(resolveScriptAlias({ script: a.script, code: a.code })), {
          message: 'pass `script` or `code` (required)',
        });

    it('schema accepts canonical script', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ script: 'return 1;' });
      expect(result.success).toBe(true);
    });

    it('schema accepts alias code', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ code: 'console.log("hi");' });
      expect(result.success).toBe(true);
    });

    it('schema accepts optional title with script', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ script: 'return 1;', title: 'add one' });
      expect(result.success).toBe(true);
    });

    it('schema accepts optional title with code', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ code: 'console.log(1);', title: 'log' });
      expect(result.success).toBe(true);
    });

    it('schema rejects conflict (both with different values)', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ script: 'return 1;', code: 'return 2;' });
      expect(result.success).toBe(false);
    });

    it('schema accepts both with the same value (no conflict)', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ script: 'return 1;', code: 'return 1;' });
      expect(result.success).toBe(true);
    });

    it('schema rejects when neither is passed (required validation)', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('schema rejects script when it exceeds max length', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ script: 'x'.repeat(101) });
      expect(result.success).toBe(false);
    });

    it('schema rejects code when it exceeds max length', () => {
      const schema = makeCodeRunSchema();
      const result = schema.safeParse({ code: 'x'.repeat(101) });
      expect(result.success).toBe(false);
    });
  });
});
