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
// embedded-postgres-server is plain JS (no .d.ts) — type the one export we use.
// @ts-expect-error untyped JS package; signature pinned by ApplyPendingMigrations below.
import { applyPendingMigrations as _applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

type ApplyPendingMigrations = (args: {
  client: unknown;
  sqlDir: string;
  log?: (s: string) => void;
  skipFile?: (f: string) => boolean;
  continueOnError?: boolean;
}) => Promise<{ appliedCount: number; totalKnown: number; failed: Array<{ file: string; error: string }> }>;

const applyPendingMigrations = _applyPendingMigrations as ApplyPendingMigrations;
import { resolveSqlDir } from './migration-drift';
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
  const client = postgres(getHarnessAdminUrl(), { max: 1, prepare: false, onnotice: () => {} });
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
      }).catch(() => {});
    }
    return { applied: appliedCount, failed };
  } catch (err) {
    console.error('[boot-migrate] boot apply failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}
