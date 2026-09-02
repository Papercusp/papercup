import { describe, expect, it } from 'vitest';

import { checkReferences, formatRow, rowsAreComplete } from './hosted-check-refs';

/**
 * Deliberately NOT secret-shaped. The property under test is "a resolved value
 * never reaches the output", which a benign sentinel proves exactly as well as
 * a realistic key would — without writing a secret-shaped blob into a git-sync
 * tree that is auto-committed to history.
 */
const RESOLVED_VALUE = 'RESOLVED-VALUE-SENTINEL-MUST-NOT-BE-PRINTED';

function rendered(rows: readonly Awaited<ReturnType<typeof checkReferences>>[number][]): string {
  return rows.map(formatRow).join('\n');
}

describe('hosted-check-refs', () => {
  it('resolves a present reference and reports presence only — never the value', async () => {
    const rows = await checkReferences({
      required: ['WORKOS_API_KEY_REF'],
      env: { WORKOS_API_KEY_REF: 'integration:WORKOS_API_KEY' },
      resolve: async () => RESOLVED_VALUE,
    });

    expect(rows).toEqual([{ name: 'WORKOS_API_KEY_REF', status: 'resolved' }]);
    expect(rowsAreComplete(rows)).toBe(true);
    // The whole point of the gate: it proves the secret is there without disclosing it.
    expect(rendered(rows)).not.toContain(RESOLVED_VALUE);
  });

  it('fails a reference whose pointer is set but whose secret is absent from the store', async () => {
    // This is the exact WI-2141402 trap: the old `-n` test called this `set`.
    const rows = await checkReferences({
      required: ['WORKOS_API_KEY_REF'],
      env: { WORKOS_API_KEY_REF: 'integration:WORKOS_API_KEY' },
      resolve: async (reference) => {
        throw new Error(`hosted_secret_ref_missing:${reference} (no value stored)`);
      },
    });

    expect(rows[0]?.status).toBe('UNRESOLVED');
    expect(rows[0]?.detail).toContain('no_value_stored');
    expect(rowsAreComplete(rows)).toBe(false);
  });

  it('never leaks an unexpected error message, which can embed a DB connection string', async () => {
    const embedded = 'CONNECTION-STRING-CREDENTIAL-SENTINEL';
    const rows = await checkReferences({
      required: ['WORKOS_API_KEY_REF'],
      env: { WORKOS_API_KEY_REF: 'integration:WORKOS_API_KEY' },
      resolve: async () => {
        throw new Error(`connect ECONNREFUSED postgres://admin:${embedded}@127.0.0.1:5432/papercusp`);
      },
    });

    expect(rows[0]?.status).toBe('UNRESOLVED');
    expect(rows[0]?.detail).toContain('resolution_error');
    expect(rendered(rows)).not.toContain(embedded);
    expect(rendered(rows)).not.toContain('ECONNREFUSED');
    expect(rowsAreComplete(rows)).toBe(false);
  });

  it('treats an unset required name as UNSET and incomplete', async () => {
    const rows = await checkReferences({
      required: ['WORKOS_WEBHOOK_SECRET_REF'],
      env: {},
      resolve: async () => RESOLVED_VALUE,
    });

    expect(rows).toEqual([{ name: 'WORKOS_WEBHOOK_SECRET_REF', status: 'UNSET' }]);
    expect(rowsAreComplete(rows)).toBe(false);
  });

  // The example name here is deliberately generic. WORKOS_WEBHOOK_SECRET_KEY_REF
  // used to stand in for it and is NOT an optional reference — despite the
  // suffix, the runtime never dereferences it (it is stored verbatim as receipt
  // provenance), so the cut-over script reports it as a label and never passes
  // it here. See WI-2141402 and doc-claims/hosted-cutover-gate-ref-set.test.ts.
  it('treats an absent OPTIONAL name as complete, but still resolves it when set', async () => {
    const absent = await checkReferences({
      required: [],
      optional: ['AN_OPTIONAL_SECRET_REF'],
      env: {},
      resolve: async () => RESOLVED_VALUE,
    });
    expect(absent[0]?.status).toBe('absent-optional');
    expect(rowsAreComplete(absent)).toBe(true);

    const setButBroken = await checkReferences({
      required: [],
      optional: ['AN_OPTIONAL_SECRET_REF'],
      env: { AN_OPTIONAL_SECRET_REF: 'integration:NOPE' },
      resolve: async (reference) => {
        throw new Error(`hosted_secret_ref_missing:${reference}`);
      },
    });
    expect(setButBroken[0]?.status).toBe('UNRESOLVED');
    expect(rowsAreComplete(setButBroken)).toBe(false);
  });

  it('does not read an empty resolved value as success', async () => {
    const rows = await checkReferences({
      required: ['PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF'],
      env: { PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: 'integration:COOKIE' },
      resolve: async () => '   ',
    });

    expect(rows[0]?.status).toBe('UNRESOLVED');
    expect(rowsAreComplete(rows)).toBe(false);
  });

  it('reports every name rather than stopping at the first failure', async () => {
    const rows = await checkReferences({
      required: ['A_REF', 'B_REF', 'C_REF'],
      env: { A_REF: 'integration:A', B_REF: '', C_REF: 'integration:C' },
      resolve: async (reference) => {
        if (reference === 'integration:A') throw new Error('hosted_secret_ref_missing:integration:A');
        return RESOLVED_VALUE;
      },
    });

    expect(rows.map((row) => row.status)).toEqual(['UNRESOLVED', 'UNSET', 'resolved']);
  });
});
