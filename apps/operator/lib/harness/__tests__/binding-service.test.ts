/**
 * binding-service.test.ts — unit tests for rowToBinding's timestamp handling.
 *
 * Regression for the 2026-06-02 bug: `getOrgPg()` (postgres-js 3.4.9) returns
 * `timestamptz` columns as Postgres-format STRINGS (e.g.
 * "2026-06-02 08:12:44.631-04"), NOT JavaScript `Date` objects. `rowToBinding`
 * assumed `Date` and called `.toISOString()` directly, so the moment a binding
 * cache row existed, /api/harness/binding/resolve 500'd with
 * "r.created_at.toISOString is not a function" — which broke the ShareWizard's
 * step-2 binding lookup. rowToBinding must normalize whatever shape the column
 * arrives in (PG-text string, ISO string, Date, or epoch number) to an ISO
 * string.
 */

import { describe, it, expect } from 'vitest';
import { rowToBinding, type SrbcRow } from '../binding-service';

function row(over: Partial<SrbcRow> = {}): SrbcRow {
  return {
    workspace_id: 'papercusp-workspace',
    provider: 'github',
    github_repository_id: 1223568103,
    github_full_name: 'Papercusp/papercup',
    harness_topic: 'a'.repeat(64),
    harness_slug: 'papercup',
    harness_link: 'papercusp://harness?topic=' + 'a'.repeat(64),
    privacy: 'shared-private',
    claim_status: 'unclaimed',
    provisional_owner_github_user_id: 279242982,
    provisional_owner_github_login: 'papercupai',
    claimed_by_github_user_ids: [],
    // The shape getOrgPg actually returns for a timestamptz column:
    created_at: '2026-06-02 08:12:44.631-04' as unknown as Date,
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_topic: null,
    cached_at: '2026-06-02 08:12:44.631-04' as unknown as Date,
    ...over,
  };
}

describe('rowToBinding timestamp normalization', () => {
  it('normalizes a Postgres-text-format string created_at to ISO (the getOrgPg reality)', () => {
    const b = rowToBinding(row());
    // 08:12:44.631-04 == 12:12:44.631Z
    expect(b.created_at).toBe('2026-06-02T12:12:44.631Z');
  });

  it('accepts a real Date created_at too (passthrough robustness)', () => {
    const b = rowToBinding(row({ created_at: new Date('2026-06-02T12:12:44.631Z') }));
    expect(b.created_at).toBe('2026-06-02T12:12:44.631Z');
  });

  it('normalizes string claimed_at + last_permission_verified_at when present', () => {
    const b = rowToBinding(
      row({
        claim_status: 'claimed',
        claimed_at: '2026-06-02 09:00:00-04' as unknown as Date,
        last_permission_verified_at: '2026-06-02 09:30:00-04' as unknown as Date,
      }),
    );
    expect(b.claimed_at).toBe('2026-06-02T13:00:00.000Z');
    expect(b.last_permission_verified_at).toBe('2026-06-02T13:30:00.000Z');
  });

  it('leaves null claimed_at / last_permission_verified_at unset', () => {
    const b = rowToBinding(row());
    expect(b.claimed_at).toBeUndefined();
    expect(b.last_permission_verified_at).toBeUndefined();
  });

  it('throws on a null created_at (NOT NULL corruption) rather than silently emitting the 1970 epoch', () => {
    // new Date(null) === epoch; a null in a NOT NULL column means real
    // corruption, so toIso must surface it instead of returning 1970-01-01.
    expect(() => rowToBinding(row({ created_at: null as unknown as Date }))).toThrow(/null/i);
  });
});
