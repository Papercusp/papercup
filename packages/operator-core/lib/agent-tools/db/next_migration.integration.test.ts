/**
 * next_migration.integration.test.ts
 *
 * handoff-coordination-dx-followups-2026-06-04 §A1 — automated coverage for the
 * migration-number allocator (`db:next-migration`).
 *
 * Plan acceptance: "two concurrent allocations never collide". The allocator
 * hands out GREATEST(max-on-disk, max-reserved) + 1 under a pg advisory lock
 * (pg_advisory_xact_lock), recorded in harness_shared.migration_reservations
 * (the `num` PK is the last-line-of-defence). This proves, against a REAL
 * Postgres (testcontainer) with migration 135 applied:
 *
 *   1. CONCURRENCY — N parallel handler calls on a pooled (max>1) connection
 *      return N DISTINCT, sequential numbers (the advisory lock serialises the
 *      read-compute-insert across connections, so no two callers see the same
 *      MAX(num)). This is the headline anti-collision invariant.
 *   2. RESERVATION-MAX — a single allocation after the run is max(reserved)+1.
 *   3. FILESYSTEM-MAX — an UNRESERVED on-disk `NNN-*.sql` higher than any
 *      reservation is still respected (the tool folds in the fs max), so a peer
 *      who wrote a file without reserving cannot be clobbered.
 *
 * Mirrors the testcontainer + vi.mock('@papercusp/db-org') setup of
 * harness-issues.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
// Strip psql metacommands exactly like the migration runner so the real 135
// file applies via postgres-js .simple().
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

// Holders the hoisted vi.mock factories reach (assigned in beforeAll — avoids TDZ).
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  sqlDir: '' as string,
}));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// The tool reads the filesystem max from resolveSqlDir(); point it at a temp
// dir we control so fsMax is deterministic (independent of the real sql/ tree).
vi.mock('../../migration-drift', async () => {
  const actual = await vi.importActual<typeof import('../../migration-drift')>('../../migration-drift');
  return { ...actual, resolveSqlDir: () => h.sqlDir };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted).
const { default: tool } = await import('./next_migration');

// Superuser ctx so resolveAgentIdentity attributes the reservation without mocking.
const CTX = { isSuperuser: true, uiClientId: 'a1-alloc-test-client' } as never;

let rootSql: postgres.Sql;
let dbName: string;

async function allocate(): Promise<{ ok: boolean; number?: number }> {
  const res = (await tool.handler({} as never, CTX)) as { content: { text: string }[] };
  return JSON.parse(res.content[0]!.text);
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `nm_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The real migration that creates the allocator ledger.
  await rootSql.unsafe(readMigration('135-migration-reservations.sql')).simple();

  // A POOLED connection (max>1) so concurrent sql.begin() calls in the handler
  // actually run on separate connections — that is what makes the advisory-lock
  // serialisation a real test rather than connection-level serialisation.
  h.sql = postgres(u.toString(), { max: 12, onnotice: () => {} });

  // Temp sql dir with an on-disk max of 137 → first allocation is 138.
  h.sqlDir = mkdtempSync(join(tmpdir(), 'a1-nm-'));
  writeFileSync(join(h.sqlDir, '100-foo.sql'), '-- x');
  writeFileSync(join(h.sqlDir, '137-bar.sql'), '-- x');
}, 90_000);

afterAll(async () => {
  await h.sql?.end({ timeout: 5 });
  await rootSql?.end({ timeout: 5 });
});

describe('db:next-migration allocator (§A1)', () => {
  it('two+ CONCURRENT allocations never collide — N parallel calls → N distinct sequential numbers', async () => {
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => allocate()));
    expect(results.every((r) => r.ok)).toBe(true);

    const numbers = results.map((r) => r.number!);
    // All distinct — the core anti-collision guarantee.
    expect(new Set(numbers).size).toBe(N);
    // Contiguous block starting at fsMax+1 (138) — the advisory lock means each
    // caller sees the previous insert, so there are no gaps or repeats.
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => 138 + i),
    );

    // And the ledger has exactly N rows, all unique (the `num` PK held).
    const rows = await rootSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.migration_reservations`;
    expect(rows[0]!.n).toBe(N);
  });

  it('reservation-max wins: the next single allocation is max(reserved)+1', async () => {
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(150); // GREATEST(fsMax 137, reserved 149) + 1
  });

  it('filesystem-max is respected: an unreserved on-disk NNN-*.sql higher than any reservation bumps the number', async () => {
    writeFileSync(join(h.sqlDir, '300-baz.sql'), '-- a peer wrote this without reserving');
    const r = await allocate();
    expect(r.ok).toBe(true);
    expect(r.number).toBe(301); // GREATEST(fsMax 300, reserved 150) + 1
  });
});
