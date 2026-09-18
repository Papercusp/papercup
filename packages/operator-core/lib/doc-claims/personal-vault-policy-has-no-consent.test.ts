/**
 * `pg-read-query.ts` tells the next reader, in the comment above
 * `PERSONAL_VAULT_RELATIONS`, that the vault's RLS policy "encodes no grant at
 * all" — and concludes from that that the SQL refusal is the ONLY control, not a
 * belt-and-braces addition to a working one (WI-10001796).
 *
 * That conclusion is load-bearing and it is downstream of a fact in the
 * migrations. If someone makes the policy consent-aware — the right fix — the
 * comment's premise is gone and its conclusion becomes wrong in the dangerous
 * direction: it would keep telling readers the data layer is inert after it had
 * teeth. So this test fails ON THE FIX, deliberately, to force the comment to be
 * re-read rather than left to rot.
 *
 * The FIXTURE controls carry the usual weight: once the live assertion goes green
 * it stops being evidence that the detector can distinguish the two shapes at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeVaultPolicyConsent } from './personal-vault-policy-has-no-consent';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SQL = join(ROOT, 'libs/papercusp/libs/db/sql');

/** Every migration that defines an RLS policy on a `personal_*` relation. */
const VAULT_MIGRATIONS = ['874-personal-vault.sql', '983-personal-vault-import-jobs.sql'];

describe('Personal Vault RLS policies encode workspace, not consent', () => {
  describe('fixture controls (the detector must be able to tell the shapes apart)', () => {
    it('reads the workspace-only shape as NOT consent-aware', () => {
      const verdict = judgeVaultPolicyConsent(`
        CREATE POLICY personal_documents_workspace_isolation
          ON harness_shared.personal_documents FOR ALL TO public
          USING (workspace_id = current_setting('app.workspace_id', true));
      `);
      expect(verdict.policies).toHaveLength(1);
      expect(verdict.consentAware).toBe(false);
    });

    it('catches a policy that consults the grant rows', () => {
      const verdict = judgeVaultPolicyConsent(`
        CREATE POLICY personal_documents_consent
          ON harness_shared.personal_documents FOR ALL TO public
          USING (EXISTS (
            SELECT 1 FROM harness_shared.personal_grants g
             WHERE g.workspace_id = personal_documents.workspace_id
               AND g.revoked_at IS NULL));
      `);
      expect(verdict.consentAware).toBe(true);
      expect(verdict.policies[0]?.consentTokens).toContain('personal_grants');
    });

    it('sees through the format() loop migration 874 builds its policies with', () => {
      // The relation is a %I placeholder here, so it is the FOREACH array above
      // that ties the statement to the vault — and the predicate arrives as a SQL
      // string literal with its quotes doubled.
      const verdict = judgeVaultPolicyConsent(`
        FOREACH tbl IN ARRAY ARRAY['personal_documents', 'personal_grants']
        LOOP
          EXECUTE format(
            'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
            || 'USING (workspace_id = current_setting(''app.workspace_id'', true))', pol, tbl);
        END LOOP;
      `);
      expect(verdict.policies).toHaveLength(1);
      expect(verdict.policies[0]?.boundBy).toBe('format-loop');
      expect(verdict.consentAware).toBe(false);
    });

    it('catches consent inside that same format() shape', () => {
      const verdict = judgeVaultPolicyConsent(`
        FOREACH tbl IN ARRAY ARRAY['personal_documents']
        LOOP
          EXECUTE format(
            'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
            || 'USING (revoked_at IS NULL)', pol, tbl);
        END LOOP;
      `);
      expect(verdict.consentAware).toBe(true);
    });

    it('ignores a policy on a relation outside the vault', () => {
      const verdict = judgeVaultPolicyConsent(`
        CREATE POLICY work_items_workspace_isolation
          ON harness_shared.work_items FOR ALL TO public
          USING (workspace_id = current_setting('app.workspace_id', true));
      `);
      expect(verdict.policies).toHaveLength(0);
    });
  });

  for (const file of VAULT_MIGRATIONS) {
    it(`${file} still defines vault policies, and none consults consent`, () => {
      const verdict = judgeVaultPolicyConsent(readFileSync(join(SQL, file), 'utf8'));

      // Calibration: a migration that stopped defining vault policies at all would
      // otherwise satisfy the consent assertion vacuously.
      expect(verdict.policies.length).toBeGreaterThan(0);

      expect(
        verdict.consentAware,
        `${file} now encodes consent in RLS. That is the right fix — and it invalidates the ` +
          'comment above PERSONAL_VAULT_RELATIONS in pg-read-query.ts, which tells readers the ' +
          'data-layer control is inert and that the SQL refusal is therefore the only one. ' +
          'Re-read that comment and say what is now true before deleting this expectation.',
      ).toBe(false);
    });
  }
});
