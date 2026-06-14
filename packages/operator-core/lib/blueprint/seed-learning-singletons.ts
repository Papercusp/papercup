/**
 * Seed the workspace-SINGLETON learning-loop cadence routines from the blueprints that
 * declare them — deterministic-blueprints-migration-2026-06-13 P-144 / D-018 step 2.
 *
 * This REPLACES the per-loop bespoke `seed-*-routine.ts` scripts. For each migrated learning
 * blueprint that declares `singleton: true` on its schedule trigger, it calls the production
 * `materializeBlueprintTriggers` — which upserts ONE dark routine per workspace under the
 * reserved `@singleton` host-slug, stamped `payload_template.blueprintId` so the harness-less
 * row fires the right program. Governor registration is NOT done here: every frontier loop
 * self-registers its learning-governor loop at first armed contact (`<loop>GovernorGate`), so
 * retiring the bespoke seed leaves the loop registered-on-first-contact (the D-018 "capability
 * does routine-materialization only" finding).
 *
 * It also (opt-in) RETIRES the legacy `papercup`-slug bespoke row each migrated loop used to
 * seed — but ONLY if that row is DARK (`active = false`). It never deletes an ACTIVE routine
 * (the 3 active loops change-ledger/scout/iq-battery are not migrated here and must not be
 * darkened); an active legacy row is reported and left for an explicit, owner-watched cutover.
 *
 * DRY-RUN by default — prints the plan, writes nothing. `--execute` performs the upserts;
 * `--retire-legacy` additionally deletes the (dark) legacy rows. `--only <blueprintId>`
 * restricts to one loop (the recommended per-loop cadence — verify each before the next).
 *
 *   PAPERCUSP_WORKSPACE_ID=<ws> DATABASE_URL=... tsx packages/operator-core/lib/blueprint/seed-learning-singletons.ts            # dry-run, all
 *   ... --only graduation                          # dry-run, one loop
 *   ... --only graduation --execute                # create the @singleton row
 *   ... --only graduation --execute --retire-legacy  # + delete the dark legacy papercup row
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { activeWorkspaceId } from '../workspace-registry';
import { materializeBlueprintTriggers, triggerRoutineSpecs, type MaterializedRoutine } from './materialize-triggers';

/** A migrated learning loop: its blueprint id + the legacy `papercup`-slug routine name its
 *  bespoke seed used to create (the row this cutover retires once the loop declares
 *  `singleton: true`). The legacy name is the routine's `name` column, not the blueprint id. */
export interface LearningSingleton {
  blueprintId: string;
  legacyRoutine: string;
}

/**
 * The migrated frontier learning loops (the dark, governed, workspace-singleton set — D-013).
 * A loop is only acted on once its blueprint actually declares `singleton: true`, so this list
 * can name loops whose blueprint isn't migrated yet (they're skipped until then). The 3 ACTIVE
 * loops (change-ledger/scout/iq-battery) and gym are deliberately ABSENT — they're not
 * behavior-neutral under dark-seeding and need their own decision (D-021).
 */
export const LEARNING_SINGLETONS: LearningSingleton[] = [
  { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' },
  { blueprintId: 'negative-space', legacyRoutine: 'negative-space-mine' },
  { blueprintId: 'neologism', legacyRoutine: 'neologism-mine' },
  { blueprintId: 'fleet-ekg', legacyRoutine: 'fleet-ekg-scan' },
  { blueprintId: 'calibration', legacyRoutine: 'calibration-resolve' },
  { blueprintId: 'deferral-interest', legacyRoutine: 'deferral-interest-refit' },
  { blueprintId: 'prompt-ablation', legacyRoutine: 'prompt-ablation' },
  { blueprintId: 'regret', legacyRoutine: 'regret-mine' },
  { blueprintId: 'transfer', legacyRoutine: 'transfer-distill' },
];

export interface LegacyRowState {
  found: boolean;
  active: boolean | null;
  deleted: boolean;
  /** When a legacy row was found ACTIVE and therefore NOT deleted (the active-loop guard). */
  keptActive?: boolean;
}

export interface CutoverResult {
  blueprintId: string;
  /** false → the blueprint doesn't declare `singleton: true` yet; the loop is skipped. */
  declaresSingleton: boolean;
  /** The singleton routine specs the blueprint implies (always computed, for the report). */
  plannedNames: string[];
  /** Set when `execute` and the blueprint declares a singleton — the upserted rows. */
  materialized?: MaterializedRoutine[];
  legacy: LegacyRowState;
  /** Why this loop was skipped (no @singleton row materialized), if it was:
   *  - `not-declared`: the blueprint hasn't added `singleton: true` yet.
   *  - `legacy-active`: the legacy `papercup` row is ACTIVE — this dark CLI must NOT create a
   *    duplicate beside a firing loop (D-023 collision guard); it needs the owner-watched
   *    atomic active cutover instead. */
  skipped?: 'not-declared' | 'legacy-active';
}

/** The legacy `papercup`-slug row a migrated loop seeded — read its current active state. */
async function readLegacyRow(
  sql: Sql,
  workspaceId: string,
  legacyRoutine: string,
): Promise<{ active: boolean } | null> {
  const rows = await sql<{ active: boolean }[]>`
    SELECT active FROM harness_shared.routines
     WHERE install_slug = 'papercup' AND name = ${legacyRoutine} AND workspace_id = ${workspaceId}
  `;
  return rows.length ? { active: rows[0].active } : null;
}

/**
 * Materialize the singleton routines for the migrated learning blueprints and (opt-in) retire
 * their dark legacy rows. Pure-ish: all DB access goes through `sql`; injectable for tests.
 */
export async function materializeLearningSingletons(
  sql: Sql,
  workspaceId: string,
  opts: { only?: string; execute: boolean; retireLegacy: boolean; log?: (m: string) => void },
): Promise<CutoverResult[]> {
  const log = opts.log ?? (() => {});
  const targets = opts.only
    ? LEARNING_SINGLETONS.filter((s) => s.blueprintId === opts.only)
    : LEARNING_SINGLETONS;
  if (opts.only && targets.length === 0) {
    throw new Error(`seed-learning-singletons: unknown blueprint '${opts.only}' (not in LEARNING_SINGLETONS)`);
  }

  const out: CutoverResult[] = [];
  for (const t of targets) {
    const { blueprint } = loadBuiltinBlueprint(t.blueprintId);
    const declaresSingleton = (blueprint.triggers?.schedule ?? []).some(
      (s) => (s as { singleton?: boolean }).singleton === true,
    );
    const plannedNames = triggerRoutineSpecs(blueprint)
      .filter((s) => s.singleton)
      .map((s) => s.name);

    const legacyBefore = await readLegacyRow(sql, workspaceId, t.legacyRoutine);
    const legacy: LegacyRowState = {
      found: legacyBefore !== null,
      active: legacyBefore?.active ?? null,
      deleted: false,
    };

    if (!declaresSingleton) {
      log(`SKIP ${t.blueprintId}: blueprint does not declare singleton:true yet (not migrated)`);
      out.push({ blueprintId: t.blueprintId, declaresSingleton: false, plannedNames, legacy, skipped: 'not-declared' });
      continue;
    }

    // COLLISION GUARD (D-023): if the legacy papercup row is ACTIVE, this loop is being actively
    // used — the frontier-arming campaign re-creates + arms papercup rows via `seed --active`.
    // Materializing a dark @singleton row beside it is exactly the double-state the revert cleaned
    // up. An active loop must go through the owner-watched ATOMIC active cutover (copy active +
    // payload → @singleton, delete papercup, in one step), NOT this dark CLI. Skip it untouched.
    if (legacy.found && legacy.active === true) {
      log(`SKIP ${t.blueprintId}: legacy papercup/${t.legacyRoutine} is ACTIVE — needs the owner-watched active cutover, not the dark CLI (collision guard, D-023)`);
      out.push({ blueprintId: t.blueprintId, declaresSingleton, plannedNames, legacy: { ...legacy, keptActive: true }, skipped: 'legacy-active' });
      continue;
    }

    let materialized: MaterializedRoutine[] | undefined;
    if (opts.execute) {
      materialized = await materializeBlueprintTriggers(t.blueprintId, blueprint, { sql, workspaceId });
      log(`MATERIALIZED ${t.blueprintId}: ${materialized.map((r) => `${r.hostSlug}/${r.name} (active=${!r.singleton ? 'true' : 'false'})`).join(', ')}`);
    } else {
      log(`DRY-RUN ${t.blueprintId}: would upsert @singleton/${plannedNames.join(', ')} (dark) + payload.blueprintId=${t.blueprintId}`);
    }

    // Retire the legacy papercup-slug row — DARK ONLY. Never darken an active loop.
    if (legacy.found && legacy.active === true) {
      legacy.keptActive = true;
      log(`KEEP-ACTIVE ${t.blueprintId}: legacy papercup/${t.legacyRoutine} is ACTIVE — NOT deleting (active-loop guard); cut it over under owner watch`);
    } else if (legacy.found && opts.retireLegacy) {
      if (opts.execute) {
        await sql`
          DELETE FROM harness_shared.routines
           WHERE install_slug = 'papercup' AND name = ${t.legacyRoutine} AND workspace_id = ${workspaceId} AND active = false
        `;
        legacy.deleted = true;
        log(`RETIRED ${t.blueprintId}: deleted dark legacy papercup/${t.legacyRoutine}`);
      } else {
        log(`DRY-RUN ${t.blueprintId}: would delete dark legacy papercup/${t.legacyRoutine}`);
      }
    } else if (legacy.found) {
      log(`LEAVE ${t.blueprintId}: dark legacy papercup/${t.legacyRoutine} present (pass --retire-legacy to delete)`);
    }

    out.push({ blueprintId: t.blueprintId, declaresSingleton: true, plannedNames, materialized, legacy });
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const retireLegacy = argv.includes('--retire-legacy');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  const workspaceId =
    process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  console.log(
    `[seed-learning-singletons] ws=${workspaceId} ${execute ? 'EXECUTE' : 'DRY-RUN'}` +
      `${retireLegacy ? ' +retire-legacy' : ''}${only ? ` only=${only}` : ' (all migrated loops)'}`,
  );
  try {
    const results = await materializeLearningSingletons(sql, workspaceId, {
      only,
      execute,
      retireLegacy,
      log: (m) => console.log(`  ${m}`),
    });
    const acted = results.filter((r) => r.declaresSingleton);
    console.log(
      `[seed-learning-singletons] ${acted.length}/${results.length} loop(s) declare singleton:true` +
        ` — ${execute ? 'materialized' : 'would materialize'} ${acted.length}; ` +
        `legacy: ${results.filter((r) => r.legacy.deleted).length} deleted, ` +
        `${results.filter((r) => r.legacy.keptActive).length} kept-active(guarded).`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run as a CLI (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[seed-learning-singletons] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
