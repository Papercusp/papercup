/**
 * promotion-model — the generated staging→main contract section (per-hive-git-and-release-gate
 * P-012/P-013). Pure renderer over an injected config; non-coding (disabled) renders nothing.
 */
import { describe, expect, it } from 'vitest';
import { renderPromotionModelSection } from './promotion-model';

describe('renderPromotionModelSection', () => {
  it('renders the contract from the config branches + green command', () => {
    const out = renderPromotionModelSection({
      enabled: true,
      integrationBranch: 'staging',
      releaseRef: 'main',
      greenCmd: 'npm run test:affected',
    });
    // The live branch names + green command are present (authoritative, config-sourced).
    expect(out).toContain('`staging`');
    expect(out).toContain('`main`');
    expect(out).toContain('npm run test:affected');
    // The contract: main is green-only; red holds; never push main; tests gate; watch /admin/git.
    expect(out).toContain('GREEN-ONLY');
    expect(out).toMatch(/red suite/i);
    expect(out).toMatch(/never .*push.*main|never `git push`/i);
    expect(out).toContain('/admin/git');
    // The cause→consequence reinforcement (D-005): a flaky/skipped test freezes the whole hive.
    expect(out).toMatch(/flaky.*freezes|freezes .*WHOLE hive/i);
  });

  it('reflects custom per-hive branches + green command (no hardcoding)', () => {
    const out = renderPromotionModelSection({
      enabled: true,
      integrationBranch: 'integration',
      releaseRef: 'release',
      greenCmd: 'make ci',
    });
    expect(out).toContain('`integration`');
    expect(out).toContain('`release`');
    expect(out).toContain('make ci');
    expect(out).not.toContain('`staging`');
  });

  it('renders NOTHING for a non-coding hive (disabled gate) — never describes a gate that does not run', () => {
    expect(
      renderPromotionModelSection({ enabled: false, integrationBranch: 'staging', releaseRef: 'main', greenCmd: 'x' }),
    ).toBe('');
  });
});
