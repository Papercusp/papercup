import { describe, expect, it, vi } from 'vitest';
import type { SimilarRecipe } from './code-recipes-search';
import type { FailureLoopHint } from './failure-loop-circuit-breaker';
import type { InsightEntry } from './memory/insights-index';
import { buildFailureLoopHintText, rankFailureLoopInsights } from './failure-loop-hints';

const hint: FailureLoopHint = {
  ownerId: 'su-test',
  toolName: 'docs:get',
  argsShape: 'shape-only',
  errorClass: 'refused:harness_required',
  count: 3,
  detectedAt: 10,
};

const insight = (slug: string, title: string, description = ''): InsightEntry => ({
  slug,
  title,
  description,
  status: 'active',
  tags: [],
});

describe('failure-loop hints', () => {
  it('delivers an actionable repetition warning without another runbook lookup', async () => {
    const readInsights = vi.fn();
    const text = await buildFailureLoopHintText({ ...hint, kind: 'repetition', category: 'test', toolName: 'testing:run' }, { readInsights });
    expect(text).toContain('recheckReason');
    expect(text).toContain('does not block execution');
    expect(text.length).toBeLessThan(1_200);
    expect(readInsights).not.toHaveBeenCalled();
  });

  it('ranks runbooks against the tool and normalized error class', () => {
    const ranked = rankFailureLoopInsights(
      [
        insight('unrelated-git', 'Git release workflow'),
        insight('harness-scoped-docs', 'Docs calls require an explicit harness'),
        insight('docs-search', 'Finding docs with docs:get'),
      ],
      hint,
    );
    expect(ranked.map((entry) => entry.slug)).toEqual(['harness-scoped-docs', 'docs-search']);
  });

  it('composes bounded insight and recipe references from both reused sources', async () => {
    const readInsights = vi
      .fn()
      .mockResolvedValue([insight('harness-scoped-docs', 'Docs calls require an explicit harness')]);
    const searchRecipes = vi
      .fn()
      .mockResolvedValue([{ id: 'recipe-1', title: 'Resolve harness-scoped tool calls' } as SimilarRecipe]);

    const text = await buildFailureLoopHintText(hint, { readInsights, searchRecipes });

    expect(readInsights).toHaveBeenCalledOnce();
    expect(searchRecipes).toHaveBeenCalledWith(hint);
    expect(text).toContain('`docs:get`');
    expect(text).toContain('`refused:harness_required` 3 times');
    expect(text).toContain("docs:get { slugs: ['harness-scoped-docs'] }");
    expect(text).toContain('`recipe-1`');
    expect(text).not.toContain(hint.argsShape);
    expect(text.length).toBeLessThanOrEqual(1_200);
  });

  it('keeps the base intervention when both retrieval legs fail', async () => {
    const text = await buildFailureLoopHintText(hint, {
      readInsights: async () => {
        throw new Error('docs unavailable');
      },
      searchRecipes: async () => {
        throw new Error('db unavailable');
      },
    });
    expect(text).toContain('Repeated tool failure detected');
    expect(text).toContain('No matching indexed runbook or recipe was found');
  });
});
