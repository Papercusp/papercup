/**
 * harness_shared.desktop_sessions — REAL-PG guard for migration 900
 * (agent-virtual-desktops-2026-08-23 P-003 / WI-40829; D-004/D-005/D-006).
 *
 * WHY REAL PG, NOT A UNIT TEST. Every behaviour asserted below lives in a CHECK
 * constraint or a PARTIAL UNIQUE INDEX. A unit test over the registry module can
 * only prove the module was ASKED to write a row; it cannot prove Postgres
 * REFUSED a second live lease on the same display, which is the entire safety
 * property D-005 asks the database to enforce rather than trusting every caller
 * to remember.
 *
 * WHAT IT PINS, and why each one earns its place:
 *   1. the table exists with the D-004 column set;
 *   2. the migration is IDEMPOTENT (part of the contract, not just a comment);
 *   3. the live-scope uniqueness REJECTS a second live session for one
 *      (workspace, scope, scope_ref) — D-005's exclusivity;
 *   4. THE CALIBRATION CASE for (3): once the first session is RELEASED, a second
 *      one is ALLOWED. Without this, a plain (non-partial) unique index would pass
 *      assertion 3 just as happily while permanently bricking desktop re-lease
 *      after the first release — strictly worse than no index at all;
 *   5. the live-display uniqueness rejects two live sessions on one display —
 *      INCLUDING the NULL-host_ref case. This is the subtle one: Postgres treats
 *      NULLs as DISTINCT in a unique index, so without the COALESCE(host_ref,'')
 *      the two local ':110' rows that this asserts against would BOTH be accepted
 *      and two agents would drive the same X display;
 *   6. the released_at invariant both ways — a live row may not carry one, a
 *      terminal row must. A one-way test passes against a column that drifts;
 *   7. the enum CHECKs actually reject an out-of-set value (a typo'd kind is how
 *      an unroutable session gets written);
 *   8. the geometry CHECK rejects a non-positive dimension — a 0-width capture
 *      geometry would divide-by-zero the D-006 token maths downstream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
// Overridable so `scripts/mutation-probe.sh` can point this at a MUTATED COPY
// outside the tree (its tier-2 path) and prove these guards actually fail on a
// weakened constraint — without ever mutating the shared checkout, where a
// git-sync tick would commit the mutant. Defaults to the real armed migration.
const MIGRATION_900 =
  process.env.PAPERCUSP_DESKTOP_SESSIONS_MIGRATION ??
  join(SQL_DIR, '900-desktop-sessions-registry.sql');

const WS = 'ws-desktop-sessions-test';

let db: FreshPgDb | undefined;
let sql: FreshPgDb['sql'];

/** A complete, valid row; each test overrides only the field it is probing. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    workspace_id: WS,
    harness_slug: 'papercusp',
    kind: 'xvfb-local',
    scope: 'pot',
    scope_ref: `pot-${Math.random().toString(36).slice(2, 10)}`,
    host_ref: null,
    owner_pid: 4242,
    owner_boot_id: 'boot-abc',
    display: `:${100 + Math.floor(Math.random() * 800)}`,
    display_width: 1024,
    display_height: 768,
    display_depth: 24,
    capture_width: 1024,
    capture_height: 768,
    state: 'ready',
    lease_holder: null,
    viewer_mode: 'none',
    viewer_actor: null,
    capabilities: JSON.stringify({ gl: true, wayland: false, kvm: false, a11y: false }),
    ttl_sec: null,
    released_at: null,
    ...over,
  };
}

async function insert(over: Record<string, unknown> = {}): Promise<void> {
  const r = row(over);
  const cols = Object.keys(r);
  await sql.unsafe(
    `INSERT INTO harness_shared.desktop_sessions (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

beforeAll(async () => {
  db = await createFreshPgDb('desktopsessions');
  sql = db.sql;
  await applyMigrationForTest(sql, MIGRATION_900);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 900 — desktop_sessions registry', () => {
  it('creates the table with the D-004 column set', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'desktop_sessions'`;
    const names = new Set(cols.map((c) => c.column_name));
    for (const expected of [
      'id', 'workspace_id', 'harness_slug', 'kind', 'scope', 'scope_ref',
      'host_ref', 'owner_pid', 'owner_boot_id', 'display',
      'display_width', 'display_height', 'display_depth',
      'capture_width', 'capture_height',
      'state', 'lease_holder', 'viewer_mode', 'viewer_actor',
      'capabilities', 'ttl_sec', 'created_at', 'last_active_at', 'released_at',
    ]) {
      expect(names, `missing column ${expected}`).toContain(expected);
    }
  });

  it('is idempotent — re-applying changes nothing and does not throw', async () => {
    await expect(applyMigrationForTest(sql, MIGRATION_900)).resolves.not.toThrow();
  });

  it('accepts a well-formed live session', async () => {
    await expect(insert({ scope_ref: 'pot-happy', display: ':900' })).resolves.not.toThrow();
  });

  describe('D-005 live-scope exclusivity', () => {
    it('REJECTS a second live session for the same (workspace, scope, scope_ref)', async () => {
      await insert({ scope_ref: 'pot-dup', display: ':901' });
      await expect(insert({ scope_ref: 'pot-dup', display: ':902' })).rejects.toThrow(
        /desktop_sessions_live_scope_uq|duplicate key/i,
      );
    });

    // CALIBRATION: proves the index is genuinely PARTIAL. A non-partial unique
    // index passes the assertion above and fails this one.
    it('ALLOWS re-leasing the same scope once the previous session is released', async () => {
      await insert({ scope_ref: 'pot-relet', display: ':903' });
      await sql`UPDATE harness_shared.desktop_sessions
                   SET state = 'released', released_at = now()
                 WHERE scope_ref = 'pot-relet'`;
      await expect(insert({ scope_ref: 'pot-relet', display: ':904' })).resolves.not.toThrow();
    });

    it('scopes uniqueness per workspace — another tenant may hold the same scope_ref', async () => {
      await insert({ scope_ref: 'pot-tenant', display: ':905' });
      await expect(
        insert({ workspace_id: 'ws-other', scope_ref: 'pot-tenant', display: ':906' }),
      ).resolves.not.toThrow();
    });
  });

  describe('live-display exclusivity', () => {
    // THE NULL CASE. Postgres treats NULLs as distinct in a unique index, so
    // without COALESCE(host_ref, '') both of these local rows are accepted and
    // two agents drive one X display.
    it('REJECTS two live LOCAL (NULL host_ref) sessions on the same display', async () => {
      await insert({ scope_ref: 'pot-disp-a', display: ':910', host_ref: null });
      await expect(
        insert({ scope_ref: 'pot-disp-b', display: ':910', host_ref: null }),
      ).rejects.toThrow(/desktop_sessions_live_display_uq|duplicate key/i);
    });

    it('ALLOWS the same display number on two different hosts', async () => {
      await insert({ scope_ref: 'pot-host-a', display: ':911', host_ref: 'frame-1' });
      await expect(
        insert({ scope_ref: 'pot-host-b', display: ':911', host_ref: 'frame-2' }),
      ).resolves.not.toThrow();
    });
  });

  describe('released_at invariant (both directions)', () => {
    it('REJECTS a live row that carries a released_at', async () => {
      await expect(
        insert({ scope_ref: 'pot-bad-live', display: ':920', state: 'ready', released_at: new Date() }),
      ).rejects.toThrow(/desktop_sessions_released_at_ck/i);
    });

    it('REJECTS a terminal row with no released_at', async () => {
      await expect(
        insert({ scope_ref: 'pot-bad-term', display: ':921', state: 'released', released_at: null }),
      ).rejects.toThrow(/desktop_sessions_released_at_ck/i);
    });

    it('accepts a terminal row that carries one', async () => {
      await expect(
        insert({ scope_ref: 'pot-ok-term', display: ':922', state: 'dead', released_at: new Date() }),
      ).resolves.not.toThrow();
    });
  });

  describe('enum CHECKs reject out-of-set values', () => {
    it.each([
      ['kind', { kind: 'vmware' }, /desktop_sessions_kind_ck/i],
      ['scope', { scope: 'global' }, /desktop_sessions_scope_ck/i],
      ['state', { state: 'zombie' }, /desktop_sessions_state_ck/i],
      ['viewer_mode', { viewer_mode: 'record' }, /desktop_sessions_viewer_mode_ck/i],
    ])('rejects an invalid %s', async (_label, over, pattern) => {
      await expect(insert(over as Record<string, unknown>)).rejects.toThrow(pattern as RegExp);
    });

    it('accepts every declared kind, including the P-010/P-011 tiers', async () => {
      for (const kind of ['xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm']) {
        await expect(insert({ kind, scope_ref: `pot-kind-${kind}` })).resolves.not.toThrow();
      }
    });

    it('accepts the workspace scope D-005 added for the BYOC desktop', async () => {
      await expect(
        insert({ scope: 'workspace', scope_ref: 'ws-byoc', display: ':930' }),
      ).resolves.not.toThrow();
    });
  });

  it('REJECTS a non-positive geometry', async () => {
    await expect(
      insert({ scope_ref: 'pot-geo', display: ':940', capture_width: 0 }),
    ).rejects.toThrow(/desktop_sessions_geometry_ck/i);
  });
});
