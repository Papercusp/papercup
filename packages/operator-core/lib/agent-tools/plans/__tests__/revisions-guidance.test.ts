import { describe, expect, it } from 'vitest';
import revisionDiff from '../revision-diff';
import revisions from '../revisions-list';

function guidanceText(tool: typeof revisions): string {
  return [
    tool.description,
    tool.guidance?.when,
    tool.guidance?.notWhen,
    tool.guidance?.chaining,
    ...(tool.guidance?.seeAlso ?? []),
  ].join('\n');
}

describe('plan revision tool guidance', () => {
  it('routes the revision list only to current plan tools', () => {
    const text = guidanceText(revisions);

    expect(text).not.toContain('plans:history');
    expect(text).not.toContain('plans:diff');
    expect(text).toContain('plans:revision-diff');
    expect(text).toContain('plans:revision-transcript');
  });

  it('does not direct revision-diff callers to the removed git-diff tool', () => {
    const text = guidanceText(revisionDiff);

    expect(text).not.toContain('plans:history');
    expect(text).not.toContain('plans:diff');
    expect(text).toContain('plans:revisions');
    expect(text).toContain('plans:revision-transcript');
  });
});
