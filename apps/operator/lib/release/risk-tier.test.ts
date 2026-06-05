/** Deploy risk-tiering (Phase 5) — the auto/review boundary gates unattended deploys. */
import { describe, it, expect } from 'vitest';
import { assessRisk } from './risk-tier';

describe('assessRisk', () => {
  it('docs-only is auto', () => {
    const r = assessRisk(['apps/operator-docs/src/content/docs/x.mdx', 'README.md'], []);
    expect(r.tier).toBe('auto');
    expect(r.autoDeployable).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('tests-only (vitest + playwright + e2e) is auto', () => {
    const r = assessRisk(
      ['packages/operator-core/lib/x.test.ts', 'apps/operator/e2e/y.spec.ts'],
      [],
    );
    expect(r.tier).toBe('auto');
  });

  it('any code change is review', () => {
    const r = assessRisk(['packages/operator-core/lib/foo.ts'], []);
    expect(r.tier).toBe('review');
    expect(r.autoDeployable).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/non-safe/);
  });

  it('any staged migration forces review', () => {
    const r = assessRisk(['apps/operator-docs/x.mdx'], ['libs/papercusp/libs/db/sql/300-z.sql']);
    expect(r.tier).toBe('review');
    expect(r.reasons.join(' ')).toMatch(/migration/);
  });

  it('a destructive migration is blocked', () => {
    const mig = 'libs/papercusp/libs/db/sql/301-drop.sql';
    const r = assessRisk([mig], [mig], { [mig]: 'ALTER TABLE harness_shared.x DROP COLUMN y;' });
    expect(r.tier).toBe('review');
    expect(r.blocked.some((b) => b.includes('destructive'))).toBe(true);
  });

  it('a non-destructive migration is review but not blocked-as-destructive', () => {
    const mig = 'libs/papercusp/libs/db/sql/302-add.sql';
    const r = assessRisk([mig], [mig], { [mig]: 'CREATE TABLE harness_shared.x (id int);' });
    expect(r.tier).toBe('review');
    expect(r.blocked.some((b) => b.includes('destructive'))).toBe(false);
    // the migration file itself is still flagged blocked (schema surface)
    expect(r.blocked).toContain(mig);
  });

  it('changing the deploy system itself is review + blocked', () => {
    const r = assessRisk(['apps/operator/lib/release/deploy.ts'], []);
    expect(r.tier).toBe('review');
    expect(r.reasons.join(' ')).toMatch(/deploy system/);
    expect(r.blocked).toContain('apps/operator/lib/release/deploy.ts');
  });

  it('core-infra (role config, coord, endpoint) is review', () => {
    for (const f of [
      'packages/agent-mcp/src/role-config.ts',
      'packages/operator-core/lib/coordination/x.ts',
      'packages/operator-core/lib/endpoint-route/routes/foo.ts',
    ]) {
      expect(assessRisk([f], []).tier).toBe('review');
    }
  });

  it('empty change set is auto (noop)', () => {
    expect(assessRisk([], []).tier).toBe('auto');
  });

  it('mixed safe + one code file is review (conservative)', () => {
    const r = assessRisk(['README.md', 'packages/operator-core/lib/foo.ts'], []);
    expect(r.tier).toBe('review');
  });
});
