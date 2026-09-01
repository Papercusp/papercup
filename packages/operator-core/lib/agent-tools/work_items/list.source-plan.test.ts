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
