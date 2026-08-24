/**
 * `harness_shared.routines.active_changed_at` + `routines_active_changed_at_trg` (migration 933) —
 * the pause-age signal the release-trigger freeze alarm depends on. EI-21299569563939689.
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A MOCK. The guarantee being pinned is not a branch in
 * TypeScript — it is a database trigger's WHEN clause. The whole value of the fix is that NO
 * application writer can opt out of it: routines:set, routines:group-set, autoloop:control,
 * dead-owner-control-sweep, git-sync-action and a psql one-liner all get the stamp without
 * knowing the column exists. A fake `sql` tag cannot express that property at all — it would
 * only re-assert the thing the old code already believed and that was already false.
 *
 * The defect this closes was a watchdog that stays QUIET during the outage it guards, so the
 * central test below is a calibrated pair: the same row, read through the OLD expression and the
 * NEW column, driven through the real `evaluateReleaseTriggerFreeze`. The old reading must fail
 * to alarm and the new one must alarm. A guard that only asserts the new column is "correct"
 * would pass just as happily if the bug had never existed.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/release/routines-active-changed-at.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { evaluateReleaseTriggerFreeze } from './green-stall-watchdog';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-routines-active-changed-at';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
});

async function seedRoutine(id: string, opts: { active?: boolean } = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES (
      ${id}, 'papercusp', 'release-trigger', 'cron', '{}'::jsonb,
      'system:release-trigger', ${opts.active ?? true}, ${WS}, '{}'::jsonb
    )`;
}

interface Stamps {
  activeChangedAtMs: number | null;
  updatedAtMs: number | null;
  active: boolean;
}

async function readStamps(id: string): Promise<Stamps> {
  const rows = await sql<
    { active: boolean; active_changed_at_ms: string | null; updated_at_ms: string | null }[]
  >`
    SELECT active,
           extract(epoch from active_changed_at) * 1000 AS active_changed_at_ms,
           extract(epoch from updated_at) * 1000 AS updated_at_ms
      FROM harness_shared.routines WHERE id = ${id}`;
  const r = rows[0];
  return {
    active: r.active,
    activeChangedAtMs: r.active_changed_at_ms != null ? Number(r.active_changed_at_ms) : null,
    updatedAtMs: r.updated_at_ms != null ? Number(r.updated_at_ms) : null,
  };
}

/** Backdate a pause WITHOUT flipping `active`, so the trigger does not overwrite the value. */
async function backdatePause(id: string, agoMs: number): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET active_changed_at = now() - ${`${Math.round(agoMs / 1000)} seconds`}::interval
     WHERE id = ${id}`;
}

/**
 * The shape every raw metadata writer in the tree uses — gate-health-merge's candidate/retriage
 * markers, green-stall-watchdog's own watchdogAlerted flips, the routines tick's next_fire_at.
 * None of them touch `active`; all of them stamp `updated_at`.
 */
async function metadataOnlyWrite(id: string, key: string): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[${key}]::text[], 'true'::jsonb),
           updated_at = now()
     WHERE id = ${id}`;
}

describe('routines.active_changed_at (real PG, migration 933)', () => {
  it('is stamped at INSERT — a new row has a flip instant, never null', async () => {
    await seedRoutine('rt-insert');
    const s = await readStamps('rt-insert');
    expect(s.activeChangedAtMs).not.toBeNull();
    expect(Date.now() - (s.activeChangedAtMs as number)).toBeLessThan(60_000);
  });

  it('a RAW UPDATE that flips active is stamped — no writer has to know the column exists', async () => {
    // This is the property that makes the fix durable. The write below deliberately does NOT go
    // through routines:set, and deliberately does NOT mention active_changed_at: it is the shape
    // used by dead-owner-control-sweep and autoloop/control today.
    await seedRoutine('rt-raw-flip');
    await backdatePause('rt-raw-flip', 3 * 60 * 60 * 1000);
    const before = await readStamps('rt-raw-flip');

    await sql`UPDATE harness_shared.routines SET active = FALSE, updated_at = now() WHERE id = 'rt-raw-flip'`;

    const after = await readStamps('rt-raw-flip');
    expect(after.active).toBe(false);
    expect(after.activeChangedAtMs as number).toBeGreaterThan(before.activeChangedAtMs as number);
    expect(Date.now() - (after.activeChangedAtMs as number)).toBeLessThan(60_000);
  });

  it('a metadata-only write does NOT reset the pause age, though it does move updated_at', async () => {
    // The trap, stated directly: `updated_at` moves, `active_changed_at` must not.
    await seedRoutine('rt-meta', { active: false });
    await backdatePause('rt-meta', 2 * 60 * 60 * 1000);
    const before = await readStamps('rt-meta');

    await metadataOnlyWrite('rt-meta', 'watchdogAlerted');
    await metadataOnlyWrite('rt-meta', 'inFlightCandidate');

    const after = await readStamps('rt-meta');
    expect(after.activeChangedAtMs).toBe(before.activeChangedAtMs);
    expect(after.updatedAtMs as number).toBeGreaterThan(before.updatedAtMs as number);
    expect(Date.now() - (after.updatedAtMs as number)).toBeLessThan(60_000);
  });

  it('a write that sets active to the value it already has does not re-stamp (IS DISTINCT FROM)', async () => {
    await seedRoutine('rt-noop', { active: false });
    await backdatePause('rt-noop', 90 * 60 * 1000);
    const before = await readStamps('rt-noop');

    await sql`UPDATE harness_shared.routines SET active = FALSE, updated_at = now() WHERE id = 'rt-noop'`;

    const after = await readStamps('rt-noop');
    expect(after.activeChangedAtMs).toBe(before.activeChangedAtMs);
  });

  it('CALIBRATED: the old updated_at reading misses the freeze the new column catches', async () => {
    // The regression, end to end. A release-trigger paused 2h ago, then touched by the ordinary
    // metadata traffic every green-checkpoint row sees, with green commits stranded behind it.
    await seedRoutine('rt-calib', { active: false });
    await backdatePause('rt-calib', 2 * 60 * 60 * 1000);
    await metadataOnlyWrite('rt-calib', 'watchdogAlerted');

    const s = await readStamps('rt-calib');
    const now = Date.now();
    const common = { active: false, deployedBehindGreenPin: 44 } as const;

    // OLD reading — what the code did before 933. It must NOT alarm: this is the bug, reproduced
    // against a real database rather than argued about.
    const oldVerdict = evaluateReleaseTriggerFreeze({ ...common, activeChangedAtMs: s.updatedAtMs }, now);
    expect(oldVerdict.frozen).toBe(false);

    // NEW reading — the same row, same instant, same evaluator.
    const newVerdict = evaluateReleaseTriggerFreeze(
      { ...common, activeChangedAtMs: s.activeChangedAtMs },
      now,
    );
    expect(newVerdict.frozen).toBe(true);
    expect(newVerdict.reason).toContain('PAUSED');
    expect(newVerdict.reason).toMatch(/~1[0-2]\dm/); // ~120m, not ~0m
  });

  it("the freeze check's own SELECT resolves the flip instant, not the last metadata write", async () => {
    // checkReleaseTriggerFreeze swallows its errors as "(non-fatal)", so a column typo or a
    // revert to bare `updated_at` would be INVISIBLE at runtime. This runs that SELECT's
    // expression verbatim against a migrated database so the failure is loud here instead.
    await seedRoutine('rt-select', { active: false });
    await backdatePause('rt-select', 45 * 60 * 1000);
    await metadataOnlyWrite('rt-select', 'inFlightCandidate');

    const rows = await sql<{ active: boolean; active_changed_at_ms: string | null }[]>`
      SELECT active,
             extract(epoch from COALESCE(active_changed_at, updated_at)) * 1000 AS active_changed_at_ms
        FROM harness_shared.routines
       WHERE install_slug = 'papercusp' AND name = 'release-trigger' AND workspace_id = ${WS}
       LIMIT 1`;

    const ageMs = Date.now() - Number(rows[0].active_changed_at_ms);
    expect(ageMs).toBeGreaterThan(40 * 60 * 1000);
    expect(ageMs).toBeLessThan(50 * 60 * 1000);
  });

  it('COALESCE floors a NULL active_changed_at to updated_at rather than reading as maximally stale', async () => {
    // Only reachable for a row written by a path that names the column explicitly; pinned because
    // the reader's null-handling is "assume maximally stale", which would alarm on every paused
    // routine at once.
    await seedRoutine('rt-null', { active: false });
    await sql`UPDATE harness_shared.routines SET active_changed_at = NULL WHERE id = 'rt-null'`;

    const rows = await sql<{ active_changed_at_ms: string | null }[]>`
      SELECT extract(epoch from COALESCE(active_changed_at, updated_at)) * 1000 AS active_changed_at_ms
        FROM harness_shared.routines WHERE id = 'rt-null'`;
    expect(rows[0].active_changed_at_ms).not.toBeNull();
  });
});
