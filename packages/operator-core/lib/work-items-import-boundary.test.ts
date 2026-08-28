/**
 * Import-boundary recurrence guards for the unified work-items facade.
 *
 * `work-items.ts` is a deliberately broad PG facade.  Keeping optional cleanup
 * and policy-only helpers behind leaf/dynamic boundaries prevents a tiny create
 * test from eagerly transforming the boot/orchestrator graph (the OOM failure
 * recorded in WI-313756).  These checks read source rather than importing the
 * facade, so the guard itself remains cheap and cannot reproduce the pressure it
 * protects against.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workItemsSource = readFileSync(new URL('./work-items.ts', import.meta.url), 'utf8');
const fulltextGuardSource = readFileSync(
  new URL('./agent-tools/work_items/fulltext-lexical-dupe-guard.ts', import.meta.url),
  'utf8',
);

describe('work-items eager import boundaries', () => {
  it('keeps claim-lease cleanup behind a dynamic import', () => {
    expect(workItemsSource).toContain("import('./work-item-claim-lease-wiring')");
    expect(workItemsSource).not.toMatch(
      /^import\s+\{[^}]*releaseWorkItemLease[^}]*\}\s+from\s+['"]\.\/work-item-claim-lease-wiring['"];?$/m,
    );
  });

  it('takes the lexical threshold from the lightweight digest policy', () => {
    expect(fulltextGuardSource).toContain("from '../../harness/improvements/digest'");
    expect(fulltextGuardSource).not.toContain("from '../../harness/improvements/capture-core'");
  });
});
