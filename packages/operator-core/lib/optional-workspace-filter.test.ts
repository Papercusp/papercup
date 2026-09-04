/**
 * WI-6055 — optional scope filters must stay index-visible under GENERIC plans.
 *
 * A nullable parameter OR looks harmless under a CUSTOM plan because Postgres
 * can fold the null arm. Once postgres.js promotes the statement to a GENERIC
 * plan, however, the unknown parameter hides the equality on workspace_id (or
 * harness_slug) from the planner. These five modules were the complete
 * WI-6055 population; pin the source shape so the scan-prone form cannot return.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SUBJECTS = [
  'why-chain.ts',
  'adv-sessions.ts',
  'agent-tools/events/graph.ts',
  'agent-tools/ui/list_clients.ts',
  'shared-pot-loop/fleet-monitors.ts',
] as const;

const legacyNullableScopeOr =
  /\$\{[^}]+\}::text IS NULL OR (?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:workspace_id|harness_slug) = \$\{/g;
const directWorkspaceFragment = /sql`(?:AND\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\.)?workspace_id = \$\{/;

describe('optional workspace filters use direct conditional predicates', () => {
  for (const path of SUBJECTS) {
    it(`${path} has no nullable-parameter scope OR and keeps a direct workspace equality`, () => {
      const source = readFileSync(new URL(`./${path}`, import.meta.url), 'utf8');
      expect(source.match(legacyNullableScopeOr) ?? []).toEqual([]);
      expect(source).toMatch(directWorkspaceFragment);
    });
  }
});
