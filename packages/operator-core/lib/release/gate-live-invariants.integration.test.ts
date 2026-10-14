import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { GATE_INVARIANT_NAMES, readGateInvariantWindow, evaluateGateInvariantWindow,
  GATE_INVARIANT_ACCEPTANCE_WINDOW_MS, GATE_INVARIANT_HEARTBEAT_MS } from './gate-live-invariants';

describe('historical invariant acceptance (real PG)', () => {
  let db: FreshPgDb;
  const start = Date.parse('2026-10-01T21:56:00Z');
  const window = { windowStartMs: start, windowEndMs: start + GATE_INVARIANT_ACCEPTANCE_WINDOW_MS };
  const scope = { workspaceId: 'acceptance-workspace', installSlug: 'acceptance-install' };
  beforeAll(async () => {
    db = await createFreshPgDb();
    await db.sql`CREATE TABLE harness_shared.pipeline_events (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
      kind text NOT NULL, status text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL)`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.sql`DELETE FROM harness_shared.pipeline_events`; });

  async function insert(at: number, extra: { workspace?: string; install?: string; kind?: string; status?: string } = {}) {
    const detail = { results: GATE_INVARIANT_NAMES.map(name => ({ name, status: extra.status ?? 'pass', observed: 'original observation' })) };
    const rows = await db.sql`INSERT INTO harness_shared.pipeline_events
      (workspace_id, install_slug, kind, status, detail, created_at)
      VALUES (${extra.workspace ?? scope.workspaceId}, ${extra.install ?? scope.installSlug},
        ${extra.kind ?? 'gate_invariants'}, ${extra.status ?? 'pass'},
        ${JSON.stringify(detail)}::text::jsonb, ${new Date(at)}) RETURNING id::text`;
    return rows[0]!.id as string;
  }

  it('reads the exact predecessor and scoped window, preserving original identities', async () => {
    await insert(start - 2 * GATE_INVARIANT_HEARTBEAT_MS, { status: 'breach' });
    const expected = [];
    for (let i = 0; i <= 168; i++) expected.push(await insert(start + i * GATE_INVARIANT_HEARTBEAT_MS));
    await insert(start + 1, { workspace: 'foreign' });
    await insert(start + 1, { install: 'foreign' });
    await insert(start + 1, { kind: 'green_checkpoint' });
    await insert(window.windowEndMs + 1, { status: 'breach' });
    const history = await readGateInvariantWindow(db.sql, scope, window);
    expect(history).toMatchObject({ status: 'complete', total: 169 });
    expect(history.rows.map(row => row.id)).toEqual(expected);
    expect(evaluateGateInvariantWindow(history).assertions.every(assertion => assertion.passed)).toBe(true);
  });

  it('retains an interior unknown and reports a capped healthy prefix as incomplete', async () => {
    await insert(start);
    await insert(start + GATE_INVARIANT_HEARTBEAT_MS, { status: 'unknown' });
    await insert(start + 2 * GATE_INVARIANT_HEARTBEAT_MS);
    const all = await readGateInvariantWindow(db.sql, scope, window);
    expect(all.rows.map(row => row.status)).toEqual(['pass', 'unknown', 'pass']);
    expect(evaluateGateInvariantWindow(all).assertions.find(a => a.id === 'pass-only-invariant-history')!.passed).toBe(false);
    const capped = await readGateInvariantWindow(db.sql, scope, { ...window, maxRows: 1 });
    expect(capped).toMatchObject({ status: 'capped', total: 3 });
    expect(capped.rows).toHaveLength(1);
    expect(evaluateGateInvariantWindow(capped).assertions.every(assertion => assertion.passed)).toBe(false);
  });

  it('keeps absence and read failure distinct and refuses an invalid scope before querying', async () => {
    expect(await readGateInvariantWindow(db.sql, scope, window)).toMatchObject({ status: 'complete', total: 0, rows: [] });
    expect(await readGateInvariantWindow(db.sql, { ...scope, workspaceId: '' }, window)).toMatchObject({ status: 'invalid', total: null });
    await db.sql`DROP TABLE harness_shared.pipeline_events`;
    try {
      expect(await readGateInvariantWindow(db.sql, scope, window)).toMatchObject({ status: 'unavailable', total: null, rows: [] });
    } finally {
      await db.sql`CREATE TABLE harness_shared.pipeline_events (
        id bigserial PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
        kind text NOT NULL, status text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL)`;
    }
  });
});
