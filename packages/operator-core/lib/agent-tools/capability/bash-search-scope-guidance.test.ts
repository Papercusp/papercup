/**
 * capability:bash search guidance regression for EI-21133502363929449.
 *
 * A repository-root `rg --hidden` search traverses generated public docs and
 * per-checkout `.papercusp/` artifacts; the rendered snapshots can overwhelm
 * the caller before the source matches are useful. Keep the actionable
 * source-root/exclusion rule in the tool guidance, backed by the shared
 * code-intelligence contract.
 */
import { describe, expect, it } from 'vitest';
import bashTool from './bash';
import { RIPGREP_SCOPE_GUIDANCE } from '../../code-intelligence/contracts.ts';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

type GuidanceTool = {
  description?: string;
  guidance?: {
    when?: string;
  };
};

describe('capability:bash — repository search scope guidance', () => {
  it('warns against generated snapshots and names bounded source roots', () => {
    const guidance = (bashTool as unknown as GuidanceTool).guidance?.when ?? '';

    expect(guidance).toContain(RIPGREP_SCOPE_GUIDANCE);
    expect(guidance).toContain('Probe `rg` in the target shell');
    expect(guidance).toContain('`command -v rg >/dev/null 2>&1`');
    expect(guidance).toContain('client-private binaries may not be inherited');
    expect(guidance).toContain('prefer ripgrep (`rg`)');
    expect(guidance).toContain('`grep`/`grep -E`');
    expect(guidance).toContain('else `grep -F`');
    expect(guidance).toContain('apps/operator/lib');
    expect(guidance).toContain('packages/operator-core/lib');
    expect(guidance).toContain('.papercusp');
    expect(guidance).toContain('apps/operator/public/internal/docs');
    expect(guidance).toContain('Do not run an unbounded search from the repository root');
    expect(guidance).toContain('--max-columns 256 --max-columns-preview');
    expect(guidance).toContain('head` limits rows, not bytes');

    // EI-21603394979563992: the optional jq tip is intentionally kept out of the
    // prompt (see bash.ts) so this guidance stays within the shared soft budget.
    expect(promptWeight(bashTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });
});
