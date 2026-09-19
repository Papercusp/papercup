import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('work-item relation write timeout guard (EI-23686882821651126)', () => {
  it('routes issue and feature non-block relations through bounded transactions', () => {
    const issues = readFileSync(join(here, 'issues-engineer.ts'), 'utf8');
    const workItems = readFileSync(join(here, 'work-items.ts'), 'utf8');

    expect(issues).toContain('async function linkIssueRelationBounded');
    expect(issues).toContain('async function unlinkIssueRelationBounded');
    expect(issues).toMatch(/await linkIssueRelationBounded\(src, dst, rel, by\)/);
    expect(issues).toMatch(/await unlinkIssueRelationBounded\(src, dst, rel\)/);
    expect(workItems).toContain('async function linkFeatureRelationBounded');
    expect(workItems).toContain('async function unlinkFeatureRelationBounded');
    expect(workItems).toMatch(/await linkFeatureRelationBounded\(src, dst, rel, opts\.by\)/);
    expect(workItems).toMatch(/await unlinkFeatureRelationBounded\(src, dst, rel\)/);
  });

  it('keeps the serializable work-item blocking seam separate', () => {
    const issues = readFileSync(join(here, 'issues-engineer.ts'), 'utf8');
    const workItems = readFileSync(join(here, 'work-items.ts'), 'utf8');

    expect(issues).toContain('await mirrorWorkItemBlockingEdge(src, dst');
    expect(workItems).toContain('await mirrorWorkItemBlockingEdge(src, dst');
    expect(issues).toContain('await removeMirroredWorkItemBlockingEdge(src, dst)');
    expect(workItems).toContain('await removeMirroredWorkItemBlockingEdge(src, dst)');
  });
});
