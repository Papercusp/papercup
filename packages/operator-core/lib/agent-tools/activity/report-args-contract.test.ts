/**
 * Regression coverage for activity:report's failure-path argument guidance
 * (EI-22571277074273886).
 *
 * Adjacent activity tools use `ownerId` and `limit`, so callers can reasonably
 * carry those names into activity:report. The report surface intentionally
 * records one event and has no bounded-read argument; these redirects must
 * explain the distinction without adding aliases with different semantics.
 */
import { describe, expect, it } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import reportTool from './report';
import recentTool from './recent';

type ToolLike = {
  args: unknown;
  guidance?: { argRedirects?: Record<string, unknown> };
};

/** Walk through ZodEffects if the source schema gains a refinement later. */
function declaredKeys(tool: ToolLike): string[] {
  let node: unknown = tool.args;
  for (let hop = 0; hop < 8 && node; hop += 1) {
    const shape = (node as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return Object.keys(shape);
    const def = (node as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    node = def?.schema ?? def?.innerType;
  }
  throw new Error("could not read activity:report's args schema");
}

const report = reportTool as unknown as ToolLike;
const reportKeys = declaredKeys(report);
const redirects = report.guidance?.argRedirects ?? {};

describe('activity:report guidance.argRedirects (EI-22571277074273886)', () => {
  it('relocates ownerId to the declared owner key on the same tool', () => {
    const redirect = redirects.ownerId;
    expect(typeof redirect).toBe('string');

    const split = splitLocalSchemaTarget(redirect as string, reportKeys);
    expect(split, 'ownerId must be authored as `owner — explanation`').not.toBeNull();
    expect(split?.path).toBe('owner');
    expect(split?.note).toMatch(/rename/i);
    expect(reportKeys).toContain('owner');
    expect(reportKeys).not.toContain('ownerId');
    expect(reportTool.args.safeParse({ ownerId: 'su-example' }).success).toBe(false);
    expect(reportTool.args.safeParse({ owner: 'su-example' }).success).toBe(true);
  });

  it('routes limit to activity:recent and explains that reports have no limit', () => {
    const redirect = redirects.limit;
    expect(redirect).toMatchObject({
      tool: 'activity:recent',
      args: { limit: 50 },
      note: expect.stringMatching(/no `limit` argument/i),
    });

    const call = redirect as { tool: string; args: Record<string, unknown>; note: string };
    expect(call.note).toContain('activity:recent');
    expect(recentTool.args.safeParse(call.args).success).toBe(true);
    expect(reportKeys).not.toContain('limit');
    expect(reportTool.args.safeParse({ limit: 50 }).success).toBe(false);
  });
});
