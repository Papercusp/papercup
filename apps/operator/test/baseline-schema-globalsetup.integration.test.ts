/**
 * baseline-schema-globalsetup.integration.test.ts — proves the P-015 globalSetup
 * delivers the COMPLETE schema to the integration tier (self-contained-migration-baseline-2026-06-02).
 *
 * It connects to the shared DB the globalSetup built (the real migration set applied
 * once) and asserts that tables/columns/triggers which USED to exist only via runtime
 * ensure-schema / dogfood DDL are now present from migrations alone. This is the
 * end-to-end confirmation that the integration tier can query the true schema without
 * booting the operator — the capability the owed baseline rebuild (D-005) unblocked,
 * and the pattern new tool-suite integration tests build on (`inject('baselineSchemaDsn')`).
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';

let sql: postgres.Sql;

beforeAll(() => {
  sql = postgres(inject('baselineSchemaDsn'), { max: 2, onnotice: () => {} });
});
afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe('integration globalSetup — full schema from migrations alone', () => {
  it('has the ex-ensure-schema tables (created lazily at runtime before the baseline)', async () => {
    // These were the tables the empty→head tripwire used to choke on / that
    // ensure-schema created out-of-band. They must now exist from 000-baseline.
    const expected = [
      'operator_turns',
      'harness_decisions',
      'autoloop_state',
      'feature_queue',
      'memory_canonical',
    ];
    const rows = await sql.unsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_name = ANY($1)`,
      [expected],
    );
    expect(rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual([...expected].sort());
  });

  it('applies the full 2nd-migration chain incl. the delegate collapse (152 drops delegates)', async () => {
    // The delegate primitives are GONE at head: claude_sessions was renamed →
    // delegates (commands/003), then migration 152 (collapse-delegate D-001/D-003)
    // DROPPED both `delegates` + `delegate_inbox` — a delegated task is now a
    // work_item[kind=task], no bespoke session table. This asserts empty→head
    // applies the whole chain including that drop (the migration-system invariant),
    // not just the additive tail.
    const [{ has_delegates }] = await sql.unsafe(
      `SELECT to_regclass('harness_shared.delegates') IS NOT NULL AS has_delegates`,
    );
    expect(has_delegates).toBe(false);
    const [{ has_inbox }] = await sql.unsafe(
      `SELECT to_regclass('harness_shared.delegate_inbox') IS NOT NULL AS has_inbox`,
    );
    expect(has_inbox).toBe(false);
    // The pre-rename name is gone too.
    const [{ has_claude }] = await sql.unsafe(
      `SELECT to_regclass('harness_shared.claude_sessions') IS NOT NULL AS has_claude`,
    );
    expect(has_claude).toBe(false);
  });

  it('has P-070 contributor_usage_events.origin (migration 108)', async () => {
    const rows = await sql.unsafe(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'contributor_usage_events' AND column_name = 'origin'`,
    );
    expect(rows.length).toBe(1);
  });

  it('has the reactivity + capture triggers from migrations (107/108), not runtime DDL', async () => {
    const [{ reactive }] = await sql.unsafe(
      `SELECT count(*)::int AS reactive FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'emit_change_notify_trg'`,
    );
    expect(reactive).toBeGreaterThanOrEqual(18);
    const [{ capture }] = await sql.unsafe(
      `SELECT count(*)::int AS capture FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = 'capture_substrate_outbox_trg'`,
    );
    expect(capture).toBeGreaterThanOrEqual(3); // features + issues + contributor_usage_events
  });

  // EI-18748424931934157 — the globalSetup seeds a per-harness DEPENDENT VIEW before
  // replaying migrations, so a migration that drops or incompatibly redefines a
  // depended-on view fails HERE instead of at a real operator's boot. Migration 678
  // passed every existing test and then crash-looped the operator with "cannot drop view
  // harness_shared.harness_features_consolidated because other objects depend on it" —
  // a fresh testcontainer was the one environment where it was safe, and the only one we
  // tested in.
  //
  // Pinned because the guard is otherwise INVISIBLE when it is working: it only ever
  // announces itself by failing. Without this assertion the probe could be dropped, or
  // silently stop being created, and every test would still pass — restoring exactly the
  // blind spot it was added to close.
  it('carries the per-harness dependent-view probe, so migrations are replayed against a realistic schema graph', async () => {
    const [{ probe }] = await sql.unsafe(
      `SELECT to_regclass('harness_migration_probe.harness_features') IS NOT NULL AS probe`,
    );
    expect(probe).toBe(true);
    // It must be a REAL dependency, not a decoy — asserted through pg_depend rather than
    // by attempting the drop. Deliberately NOT `expect(DROP ...).rejects`: this DB is a
    // REUSED container shared by every integration process on the box, so if the guard
    // were ever broken that drop would SUCCEED and take out the consolidated view for
    // everyone — a test that corrupts shared infrastructure precisely when it finds the
    // bug it was written to find.
    const [{ deps }] = await sql.unsafe(
      `SELECT count(*)::int AS deps
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class dependent ON dependent.oid = r.ev_class
        WHERE d.refobjid = 'harness_shared.harness_features_consolidated'::regclass
          AND dependent.relnamespace = 'harness_migration_probe'::regnamespace`,
    );
    expect(deps).toBeGreaterThan(0);
  });

  it('the harness_shared schema is fully built (≥184 base tables)', async () => {
    const [{ n }] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'harness_shared' AND table_type = 'BASE TABLE'`,
    );
    expect(n).toBeGreaterThanOrEqual(184);
  });
});
