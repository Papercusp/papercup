/**
 * PostgreSQL tuning-drift alarm (EI-19314331871893219).
 *
 * `databaseTuningToSettings()` in @papercusp/resource-profile is the source of
 * truth for every server GUC we set. On a NATIVE PostgreSQL those settings reach
 * the cluster only when someone runs `scripts/pg-autotune.ts --apply` — and until
 * this alarm existed, NOTHING checked that they had. A setting added to the map
 * simply never arrived, silently, and the source, its tests and its comments all
 * went on saying the defense was in place.
 *
 * That is not a hypothetical failure mode; it is the one that produced this file.
 * Two settings were found unapplied on the live cluster, both for weeks:
 *
 *   - `max_slot_wal_keep_size` (WI-347) — the disk-fill-SPOF defense. The live
 *     cluster was running PG's default of `-1` (UNLIMITED), which is precisely
 *     the condition {@link ./replication-slot-alarm} can only WARN about and
 *     cannot cap. The guard everyone believed was armed was not.
 *   - `shared_preload_libraries` (P-020) — query telemetry across a re-provision.
 *
 * The mechanism was mundane and will recur: `--apply` used to RESTART Postgres,
 * which nobody dares do on a shared box, so a later agent hand-appended its knob
 * to the managed drop-in instead. The live config forked from the map and every
 * setting added in between was dropped. (pg-autotune now reloads instead of
 * restarting when it can, which removes the reason to hand-edit — but a fix that
 * relies on nobody ever hand-editing again is not a fix, so: this detector.)
 *
 * Read-only and best-effort — it never throws, mirroring replication-slot-alarm
 * and the other periodic monitors, so it can never affect the cluster it watches.
 *
 * ── Scope: NATIVE PG only ─────────────────────────────────────────────────────
 * An embedded/desktop Postgres is launched by us with `-c` flags fed from the SAME
 * derivation at every boot, so it cannot accumulate this drift and the remedy
 * (`pg-autotune --apply`) does not apply to it. The check skips that host rather
 * than emitting an alarm nobody can act on.
 */
import { readFileSync } from 'node:fs';
import { generated, getOrgPg } from '@papercusp/db-org';
import {
  databaseTuningToSettings,
  deriveDatabaseTuning,
  detectResourceSignals,
  diffPgSettings,
  type PgLiveSetting,
  type PgSettingsDrift,
} from '@papercusp/resource-profile';
import { desc, inArray } from 'drizzle-orm';
import { detectEmbeddedPg } from '../resource-profile';
import { notifySyncInvalidate } from '../sync-sse';

const TOAST_RING_BUFFER = 2000;

/**
 * The GUCs we intend the cluster to run. Mirrors what `pg-autotune` writes:
 * the derived map, for a DEDICATED database (`embeddedPg: false` — this check
 * only ever runs against a native PG, see the header).
 *
 * `shared_preload_libraries` is deliberately NOT included, for two independent
 * reasons. pg-autotune computes it as a UNION with whatever is already loaded, so
 * its target depends on live state rather than on the derivation — a fixed
 * expectation here would alarm on any host that legitimately preloads an extra
 * library. And `pg_settings` does not expose it to the operator's non-superuser
 * role at all (verified on the dev box: the derived GUCs below are readable,
 * `shared_preload_libraries` is not), so it would only ever land in `unknown`.
 */
export function targetSettings(): Record<string, string> {
  return databaseTuningToSettings(deriveDatabaseTuning(detectResourceSignals({ embeddedPg: false })));
}

export interface TuningDriftDeps {
  /** Injectable for tests — defaults to a read-only pg_settings scan. */
  fetchLiveSettings?: (names: string[]) => Promise<PgLiveSetting[]>;
  /** Injectable for tests — defaults to `detectEmbeddedPg()`. */
  isEmbeddedPg?: () => boolean;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

/** Build the toast body for a drift result. Pure — unit-testable. */
export function formatTuningDriftToast(drift: PgSettingsDrift): {
  level: string;
  message: string;
  description: string;
} {
  const lines = drift.diverged
    .map(
      (d) =>
        `• ${d.name}: live=${d.live}, should be ${d.target}` +
        (d.restartOnly ? ' (needs a PG restart)' : ' (SIGHUP-reloadable — no downtime)'),
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Postgres tuning drift — ${drift.diverged.length} setting(s) not applied`,
    description:
      `The live cluster does not match databaseTuningToSettings() in ` +
      `@papercusp/resource-profile, so tuning/safety settings the code believes are ` +
      `in force are NOT:\n${lines}\n\n` +
      `This is how the max_slot_wal_keep_size disk-fill defense sat unapplied for weeks ` +
      `(EI-19314331871893219). Fix: \`npx tsx scripts/pg-autotune.ts --check\` to see the ` +
      `full diff, then \`--apply\` to close it (it reloads rather than restarting when ` +
      `nothing postmaster-level changed).`,
  };
}

async function defaultFetchLiveSettings(names: string[]): Promise<PgLiveSetting[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { name: string; setting: string; unit: string | null; context: string | null }[]
  >`
    select name, setting, unit, context
    from pg_settings
    where name = any(${names})
  `;
  return rows.map((r) => ({
    name: r.name,
    setting: String(r.setting ?? ''),
    unit: r.unit,
    context: r.context,
  }));
}

async function defaultEmitToast(t: {
  level: string;
  message: string;
  description: string;
}): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors replication-slot-alarm / storage-growth-alarm).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

export interface TuningDriftResult {
  /** True when the host was skipped (embedded PG) — NOT a clean bill of health. */
  skipped: boolean;
  checked: number;
  drift: PgSettingsDrift | null;
}

/** One read-only pass: compare the live cluster against the derived tuning and
 *  toast on any divergence. Never throws. */
export async function runPgTuningDriftCheckOnce(
  deps: TuningDriftDeps = {},
): Promise<TuningDriftResult> {
  const fetchLiveSettings = deps.fetchLiveSettings ?? defaultFetchLiveSettings;
  const isEmbeddedPg = deps.isEmbeddedPg ?? detectEmbeddedPg;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  try {
    if (isEmbeddedPg()) return { skipped: true, checked: 0, drift: null };
  } catch {
    return { skipped: true, checked: 0, drift: null };
  }

  const target = targetSettings();
  let live: PgLiveSetting[];
  try {
    live = await fetchLiveSettings(Object.keys(target));
  } catch (err) {
    console.warn(
      `[pg-tuning-drift] settings scan skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`,
    );
    return { skipped: false, checked: 0, drift: null };
  }

  const drift = diffPgSettings(target, live);
  if (drift.diverged.length > 0) {
    console.warn(
      `[pg-tuning-drift] ${drift.diverged.length} setting(s) not applied: ` +
        drift.diverged.map((d) => `${d.name} live=${d.live} want=${d.target}`).join('; ') +
        '. Remedy: npx tsx scripts/pg-autotune.ts --check (then --apply).',
    );
    try {
      await emitToast(formatTuningDriftToast(drift));
    } catch (err) {
      console.warn(
        `[pg-tuning-drift] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  return { skipped: false, checked: live.length, drift };
}
