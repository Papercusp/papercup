/**
 * datatype-firstclass-scaffold.test — P-001 first-class tier codegen (pure, no DB/IO).
 * Locks: payload_schema → SQL columns (type mapping + required→NOT NULL); idempotent
 * workspace-scoped table; the migration rides the PR rail (review notes); bad specs rejected.
 */
import { describe, it, expect } from 'vitest';
import { scaffoldFirstClassDatatype, sqlColumnType } from './datatype-firstclass-scaffold';

const BET_SCHEMA = {
  type: 'object',
  properties: {
    market: { type: 'string' },
    edge: { type: 'number' },
    rounds: { type: 'integer' },
    settled: { type: 'boolean' },
    legs: { type: 'array' },
    meta: { type: 'object' },
    opened_at: { type: 'string', format: 'date-time' },
  },
  required: ['market', 'edge'],
};

function ok(spec: Parameters<typeof scaffoldFirstClassDatatype>[0]) {
  const r = scaffoldFirstClassDatatype(spec);
  if (!r.ok) throw new Error(`expected ok, got ${r.message}`);
  return r;
}

describe('sqlColumnType — JSON Schema → Postgres', () => {
  it('maps the primitive + container types, jsonb catch-all', () => {
    expect(sqlColumnType({ type: 'string' })).toBe('text');
    expect(sqlColumnType({ type: 'string', format: 'date-time' })).toBe('timestamptz');
    expect(sqlColumnType({ type: 'integer' })).toBe('bigint');
    expect(sqlColumnType({ type: 'number' })).toBe('numeric');
    expect(sqlColumnType({ type: 'boolean' })).toBe('boolean');
    expect(sqlColumnType({ type: 'object' })).toBe('jsonb');
    expect(sqlColumnType({ type: 'array' })).toBe('jsonb');
    expect(sqlColumnType(undefined)).toBe('jsonb');
    expect(sqlColumnType({ enum: ['a', 'b'] })).toBe('jsonb'); // no type → catch-all
  });
});

describe('scaffoldFirstClassDatatype — the generated migration', () => {
  it('derives columns from payload_schema with correct types + NOT NULL on required', () => {
    const r = ok({ id: 'bet', title: 'Bet', payloadSchema: BET_SCHEMA });
    const sql = r.files[0].contents;
    expect(r.files[0].path).toBe('libs/papercusp/libs/db/sql/NNN-datatype-bet.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS harness_shared.datatype_bet');
    expect(sql).toMatch(/market\s+text NOT NULL,/);
    expect(sql).toMatch(/edge\s+numeric NOT NULL,/);
    expect(sql).toMatch(/rounds\s+bigint,/); // not required → nullable
    expect(sql).toMatch(/settled\s+boolean,/);
    expect(sql).toMatch(/legs\s+jsonb,/);
    expect(sql).toMatch(/opened_at\s+timestamptz,/);
    // the standard workspace-scoped shape
    expect(sql).toContain('workspace_id       text NOT NULL');
    expect(sql).toContain('PRIMARY KEY (workspace_id, id)');
    expect(sql).toMatch(/RLS|ROW LEVEL SECURITY/);
  });

  it('skips reserved column names (id/workspace_id/created_at/updated_at)', () => {
    const sql = ok({
      id: 'thing',
      title: 'Thing',
      payloadSchema: { type: 'object', properties: { id: { type: 'string' }, workspace_id: { type: 'string' }, real: { type: 'string' } } },
    }).files[0].contents;
    // 'real' is a domain column; the reserved ones are not re-declared.
    expect(sql).toMatch(/real\s+text,/);
    expect((sql.match(/^\s*id\s+text NOT NULL,$/gm) ?? []).length).toBe(1); // only the PK id line
  });

  it('no payload_schema ⇒ a TODO-columns table (still valid)', () => {
    const sql = ok({ id: 'empty', title: 'Empty' }).files[0].contents;
    expect(sql).toContain('TODO: domain columns');
    expect(sql).toContain('harness_shared.datatype_empty');
  });

  it('respects a table override + a suggested migration number', () => {
    const r = ok({ id: 'bet', title: 'Bet', table: 'wagers', suggestedMigrationNumber: 426 });
    expect(r.files[0].path).toBe('libs/papercusp/libs/db/sql/426-datatype-wagers.sql');
    expect(r.files[0].contents).toContain('harness_shared.datatype_wagers');
  });

  it('flags the PR rail (D-003) — not a runtime apply', () => {
    const r = ok({ id: 'bet', title: 'Bet' });
    expect(r.reviewNotes.join(' ')).toMatch(/PR rail|D-003/);
    expect(r.nextSteps.join(' ')).toMatch(/db:next-migration/);
  });
});

describe('scaffoldFirstClassDatatype — rejects bad specs', () => {
  it('non-kebab id, empty title, bad table', () => {
    expect(scaffoldFirstClassDatatype({ id: 'Bet_Thing', title: 'x' }).ok).toBe(false);
    expect(scaffoldFirstClassDatatype({ id: 'bet', title: '  ' }).ok).toBe(false);
    expect(scaffoldFirstClassDatatype({ id: 'bet', title: 'x', table: '9bad table' }).ok).toBe(false);
  });
});
