/**
 * Coverage for projects-data.rowToProject — the PG-row → ProjectRow mapping
 * (bigint→Number coercion, spent/created/updated default-to-0, optional string
 * fields default-to-null). Pure.
 */
import { describe, expect, it } from 'vitest';
import { rowToProject } from './projects-data';

describe('rowToProject', () => {
  it('maps a full row, coercing bigints', () => {
    expect(
      rowToProject({
        id: 'p1',
        name: 'Proj',
        status: 'active',
        budget_cents: 5000n,
        spent_cents: 1200,
        owning_dept: 'eng',
        vertical: 'infra',
        created_ts: 100,
        updated_ts: 200n,
      }),
    ).toEqual({
      id: 'p1',
      name: 'Proj',
      status: 'active',
      budget_cents: 5000,
      spent_cents: 1200,
      owning_dept: 'eng',
      vertical: 'infra',
      spec: null,
      spec_updated_at: null,
      spec_manually_edited_at: null,
      created_ts: 100,
      updated_ts: 200,
    });
  });

  it('defaults spent/created/updated to 0 and optional strings to null', () => {
    const p = rowToProject({ id: 'p2', name: 'X', status: 'todo' });
    expect(p.spent_cents).toBe(0);
    expect(p.created_ts).toBe(0);
    expect(p.updated_ts).toBe(0);
    expect(p.budget_cents).toBeNull(); // num(undefined) → null (no ?? 0)
    expect(p.owning_dept).toBeNull();
  });
});
