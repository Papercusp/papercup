import { describe, expect, it } from 'vitest';
import listTool from './list';

describe('work_items:list sourcePlanSlug semantics (EI-21269238253955881)', () => {
  it('distinguishes persisted item provenance from a session or fleet plan declaration', () => {
    const description = listTool.args.shape.sourcePlanSlug.description ?? '';

    expect(description).toContain('Persisted item provenance only');
    expect(description).toMatch(/does NOT include ad-hoc work/i);
    expect(description).toMatch(/scheduler `plan` predicates are item-provenance filters/i);
  });

  it('routes current lane status to scheduler-owned surfaces', () => {
    expect(listTool.guidance?.notWhen).toContain('current lane status');
    expect(listTool.guidance?.notWhen).toContain('scheduler:get_next');
    expect(listTool.guidance?.notWhen).toContain('work_items:claimable');
  });
});

/**
 * EI-21592729279587188 (tool-contract-repair-2026-09-05 P-008, disposition ALIAS).
 *
 * The schema rejected `plan` while its OWN sourcePlanSlug describe text referred to
 * "scheduler `plan` predicates" — the tool documented the word it refused. Per the
 * plan's Framing the filing is the symptom and the missing alias is the defect, so
 * this guards the alias itself, not the filing.
 */
describe('work_items:list plan → sourcePlanSlug alias (EI-21592729279587188)', () => {
  it('accepts `plan` as a declared, documented alias of sourcePlanSlug', () => {
    expect(listTool.args.shape.plan).toBeDefined();
    const planDesc = listTool.args.shape.plan.description ?? '';
    expect(planDesc).toMatch(/alias for `sourcePlanSlug`/i);
    expect(planDesc).toContain('alias-group:sourcePlanSlug|plan');
  });

  it('names the alias on sourcePlanSlug too, so either name discovers the other', () => {
    const desc = listTool.args.shape.sourcePlanSlug.description ?? '';
    expect(desc).toContain('alias-group:sourcePlanSlug|plan');
  });

  it('parses `plan` instead of rejecting it as an unrecognized key', () => {
    const parsed = listTool.args.safeParse({ harness: 'papercusp', plan: 'some-plan' });
    expect(parsed.success).toBe(true);
  });

  // The differing-pair case is the one aliasing cannot silently resolve. It is rejected
  // LOUDLY rather than picking a winner — the _body-alias.ts precedent (WI-4492), where
  // silently choosing one name discarded the caller's payload behind an ok:true.
  it('rejects both names supplied with DIFFERENT values rather than picking a winner', async () => {
    await expect(
      (listTool.handler as (a: unknown, c: unknown) => Promise<unknown>)(
        { sourcePlanSlug: 'plan-a', plan: 'plan-b' },
        {},
      ),
    ).rejects.toThrow(/SAME filter/i);
  });

  // Equal values are not a conflict: a caller echoing one name into the other is
  // unambiguous, so it must survive the guard and reach the filter.
  it('allows both names when the values agree', () => {
    const parsed = listTool.args.safeParse({ sourcePlanSlug: 'same', plan: 'same' });
    expect(parsed.success).toBe(true);
  });
});
