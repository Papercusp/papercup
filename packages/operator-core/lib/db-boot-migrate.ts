/**
 * Boot-time migration apply for the NATIVE :5432 operator
 * (handoff-coordination-dx-followups-2026-06-04 §A1).
 *
 * Embedded-pg applies pending `libs/papercusp/libs/db/sql/*.sql` when ITS
 * server boots; the native dev box has no such runner, so a migration added
 * since the last restart stayed unapplied until a manual `psql -f` + a manual
 * `schema_migrations` INSERT — the long-flagged gap that let a colliding
 * migration number go silently dark (one of two same-numbered files never ran).
 *
 * This runs the SAME idempotent runner against the operator's admin DB on host
 * boot, in LOG-AND-CONTINUE mode: a migration that fails to apply is logged +
 * coord-broadcast and left pending (retried next boot) rather than halting the
 * dev-api the whole fleet shares. (Embedded-pg keeps the fail-loud default —
 * only this shared-box boot opts into continueOnError.)
 */
import postgres from 'postgres';
// Types come from the package's generated `src/index.d.ts` (EI-18804531117413708).
// This import used to carry a `@ts-expect-error` plus a hand-written
// `ApplyPendingMigrations` type it cast to — a local projection of a signature
// in another package, kept in sync by nothing, and duplicated verbatim in
// release-preflight-migration-boot-smoke.integration.test.ts. The suppression
// also meant the cast was unchecked: it could have drifted from the real
// function silently.
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { checkMigrationDrift, resolveSqlDir } from './migration-drift';
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

const BOOT_MIGRATE_IDENTITY: AgentIdentity = {
  ownerId: 'boot-migrate',
  ownerLabel: 'boot-migrate',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

let _ran = false;

export interface BootMigrateResult {
  applied: number;
  failed: { file: string; error: string }[];
}

/** Apply pending sql/*.sql on operator boot (native box). Idempotent per
 *  process (the schema_migrations tracker also makes a re-run a no-op).
 *  Never throws — a failure leaves migrations pending, it never wedges boot. */
export async function applyPendingMigrationsAtBoot(): Promise<BootMigrateResult | null> {
  if (_ran) return null;
  _ran = true;
  return applyPendingMigrationsNow();
}

/**
 * EI-13992: the UNGUARDED core of {@link applyPendingMigrationsAtBoot} — no
 * `_ran` singleton, safe to call from any per-invocation caller (not just
 * once-per-process boot). Extracted so the green-checkpoint gate can apply
 * pending migrations to the live dev PG as a PREFLIGHT, independent of
 * operator boot: the self-sustaining deadlock this closes is "gate red →
 * main frozen → db-boot-migrate (boot-only) never re-fires → dev PG stays
 * behind → tests asserting new columns fail → gate stays red". A gate run
 * happens on its own schedule regardless of whether main is frozen, so
 * applying migrations HERE — every run, not just at boot — means the dev PG
 * can never drift far enough behind to red-pin the gate on missing-column
 * failures again. Same idempotent runner (the schema_migrations tracker
 * makes a re-run with nothing pending a fast no-op); never throws. */
export async function applyPendingMigrationsNow(): Promise<BootMigrateResult | null> {
  const sqlDir = resolveSqlDir();
  if (!sqlDir) {
    console.warn('[boot-migrate] sql dir not found — skipping boot apply');
    return null;
  }

  // A DEDICATED max:1 client — the runner applies each file as a raw
  // `BEGIN; <ddl>; COMMIT;` via .unsafe(), which postgres-js rejects with
  // UNSAFE_TRANSACTION on a pooled (max>1) connection (it can't guarantee the
  // BEGIN/COMMIT land on the same socket). getOrgPg's shared handle is max:2,
  // so we use a throwaway single-connection client (mirrors the embedded-pg
  // boot runner + the migration tests) and close it after.
  // lock_timeout (root-caused 2026-06-08): fail-fast on lock contention instead
  // of queuing. A boot `ALTER TABLE … ADD COLUMN` needs ACCESS EXCLUSIVE; queued
  // behind a pg_dump backup's ACCESS SHARE it would block ALL access to the
  // table for the dump's duration (the coord_event_log → coord → psu-bootstrap
  // wedge). Boot apply is already continueOnError, so a lock_timeout abort just
  // leaves the (idempotent) migration pending for next boot. application_name
  // self-identifies a stuck boot migration in pg_stat_activity.
  const client = postgres(getHarnessAdminUrl(), {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { lock_timeout: 15_000, application_name: 'papercusp-boot-migrate' },
  });
  try {
    const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
      client,
      sqlDir,
      continueOnError: true,
      log: (s) => console.log(`[boot-migrate] ${s}`),
    });
    if (appliedCount > 0) {
      console.log(`[boot-migrate] applied ${appliedCount} pending migration(s) (of ${totalKnown} known)`);
    }
    if (failed.length > 0) {
      const files = failed.map((f) => f.file).join(', ');
      console.error(
        `[boot-migrate] ⚠ ${failed.length} migration(s) FAILED and were left pending (retried next boot): ${files}\n` +
          failed.map((f) => `    ${f.file}: ${f.error}`).join('\n'),
      );
      // Loud coord broadcast so peers see the broken migration (the dev-api
      // booted anyway). Ambient-categorised so it doesn't spam every inbox by
      // default but is opt-in visible (include_ambient) + in the coord stream.
      await sendMessage(BOOT_MIGRATE_IDENTITY, {
        to: ['*'],
        summary: `⚠ ${failed.length} migration(s) failed to apply on operator boot — left pending: ${files}`,
        body: `The native-box boot apply (A1) skipped these so the dev-api could start; they will retry next restart. Fix the SQL then restart the operator (or db:migrate). Errors:\n${failed
          .map((f) => `- ${f.file}: ${f.error}`)
          .join('\n')}`,
        category: 'service-health',
        // P-033 (d): `boot-migrate` does not match the conservative
        // MACHINE_SENDER_PATTERN — mark it machine chatter explicitly so the
        // sendMessage seam stamps `expects:'none'` (D-072).
        extra: { auto: true },
      }).catch(() => {});
    }
    // WI-5050 (WI-4070 class): detect the INVERSE drift — the shared DB was
    // migrated by a NEWER code tree than the one booting. Renames/drops that
    // newer tree performed have already executed, so THIS tree's queries can
    // hit `relation does not exist` at runtime and (worst case) the federation
    // plane dies silently — exactly how a stale dev-source tree (hives→pots,
    // mig-557) killed the VM peer with nothing but scattered PG errors. Loud
    // log + ambient coord broadcast; the operator still boots (the stale tree
    // may serve read paths fine and a refusal would take the whole box down).
    try {
      const drift = await checkMigrationDrift();
      if (drift.schemaAhead.length > 0) {
        const head = drift.schemaAhead.slice(0, 5).join(', ');
        console.error(
          `[boot-migrate] 🚨 SCHEMA AHEAD OF CODE: the DB has ${drift.schemaAhead.length} migration(s) NEWER than anything this code tree ships (${head}${drift.schemaAhead.length > 5 ? ', …' : ''}). ` +
            'This operator is running STALE CODE against a newer-migrated shared DB — expect `relation does not exist` failures on renamed tables and a silently-dead federation plane (WI-4070 class). ' +
            'Update/redeploy this code tree (stale dev-source / old bundle / lagging checkout) before trusting this host.',
        );
        await sendMessage(BOOT_MIGRATE_IDENTITY, {
          to: ['*'],
          summary: `🚨 schema AHEAD of code on operator boot: DB carries ${drift.schemaAhead.length} migration(s) newer than this code tree — stale operator (WI-4070 class), update/redeploy it`,
          body: `Newest DB-side migrations unknown to this tree: ${head}${drift.schemaAhead.length > 5 ? ', …' : ''}. A stale tree against a newer-migrated DB fails as scattered "relation does not exist" errors and can silently kill federation. Refresh the running code (dev-source tree / bundle / checkout), then restart.`,
          category: 'service-health',
        }).catch(() => {});
      }
    } catch {
      /* detection is best-effort — never blocks boot */
    }
    return { applied: appliedCount, failed };
  } catch (err) {
    console.error('[boot-migrate] boot apply failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}
