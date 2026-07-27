/**
 * Recurrence guard for the "SEEDED ACTIVE by default, but nobody ever ran the seed
 * script" bug class (EI-18746253391734322 — `supervision-reconcile` had never been
 * seeded: the script existed, its own header said "SEEDED ACTIVE by default", but no
 * boot path / CI step / manual run ever invoked it, so `harness_shared.routines` had
 * no row for it and the reconciler had never once ticked).
 *
 * A bespoke `seed-*-routine.ts` script in this directory (unlike a blueprint
 * `triggers.schedule` entry, which materializes automatically at `harness:create`) is
 * a manually-run, idempotent upsert — nothing re-runs it on its own. That design is
 * fine; the failure mode is that "manually run once" quietly became "never run". This
 * script makes that failure DETECTABLE instead of relying on someone noticing a
 * routines row is missing.
 *
 * BESPOKE_ACTIVE_SEEDS is the explicit registry of every `seed-*-routine.ts` in this
 * directory whose header commits to "SEEDED ACTIVE by default" (i.e. the intended
 * steady state is an ACTIVE row for the operator-home harness right after a fresh
 * checkout/deploy, not a human-gated bring-up). Grep for the marker to keep this list
 * honest:
 *
 *   grep -rl 'SEEDED ACTIVE by default' packages/operator-core/lib/harness/routines/*.ts
 *
 * Adding a NEW always-on bespoke seed script? Add its {name, seedScript} pair below in
 * the SAME change that lands the seed script — that is what closes the loop this
 * checker exists to close. A script seeded INACTIVE-by-default (human-gated bring-up)
 * does NOT belong here; only entries whose own doc-comment already promises ACTIVE.
 *
 * Usage:
 *   tsx packages/operator-core/lib/harness/routines/check-bespoke-active-seeds.ts
 *
 * Exit codes:
 *   0 — every registered routine has an ACTIVE row for the operator-home harness
 *   1 — at least one is missing or inactive (prints the exact `tsx …` command to fix it)
 *
 * Dev/ops diagnostic (like `db:check_drift`), not CI-gated — it asserts live-box
 * deploy state, which a fresh CI database never has.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

export interface BespokeActiveSeed {
  /** `harness_shared.routines.name` this seed script upserts. */
  name: string;
  /** Path (relative to this file's directory) to the seed script that arms it. */
  seedScript: string;
}

export const BESPOKE_ACTIVE_SEEDS: BespokeActiveSeed[] = [
  { name: 'unguarded-halt-rescue', seedScript: 'seed-unguarded-halt-rescue-routine.ts' },
  { name: 'unclaimed-work-digest', seedScript: 'seed-unclaimed-work-digest-routine.ts' },
  { name: 'improvement-human-digest', seedScript: 'seed-human-digest-routine.ts' },
  { name: 'claim-discipline-watch', seedScript: 'seed-claim-discipline-routine.ts' },
  { name: 'task-reconcile', seedScript: 'seed-task-reconcile-routine.ts' },
  { name: 'supervision-reconcile', seedScript: 'seed-supervision-reconcile-routine.ts' },
];

export interface CheckResult {
  missing: BespokeActiveSeed[];
  inactive: BespokeActiveSeed[];
  ok: boolean;
}

/** Pure-ish core: given a sql client + scope, report which registered routines are
 *  missing or seeded-but-inactive. Exported so it's testable against a fake `sql`
 *  without a real PG connection (mirrors seed-hive-release-routines.test.ts's pattern). */
export async function checkBespokeActiveSeeds(opts: {
  sql: Pick<Sql, never> & (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>);
  installSlug: string;
  workspaceId: string;
  entries?: BespokeActiveSeed[];
}): Promise<CheckResult> {
  const entries = opts.entries ?? BESPOKE_ACTIVE_SEEDS;
  const rows = (await opts.sql<{ name: string; active: boolean }[]>`
    SELECT name, active FROM harness_shared.routines
    WHERE install_slug = ${opts.installSlug} AND workspace_id = ${opts.workspaceId}
      AND name = ANY(${entries.map((s) => s.name)})
  `) as unknown as { name: string; active: boolean }[];
  const byName = new Map(rows.map((r) => [r.name, r.active]));

  const missing: BespokeActiveSeed[] = [];
  const inactive: BespokeActiveSeed[] = [];
  for (const entry of entries) {
    const active = byName.get(entry.name);
    if (active === undefined) missing.push(entry);
    else if (active !== true) inactive.push(entry);
  }
  return { missing, inactive, ok: missing.length === 0 && inactive.length === 0 };
}

async function main(): Promise<void> {
  const slug = operatorHomeHarnessSlug();
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const result = await checkBespokeActiveSeeds({ sql: sql as unknown as never, installSlug: slug, workspaceId: ws });

  if (result.ok) {
    console.log(
      `[check-bespoke-active-seeds] ok — all ${BESPOKE_ACTIVE_SEEDS.length} always-on bespoke ` +
        `routines have an ACTIVE row for "${slug}" (ws=${ws}).`,
    );
    await sql.end({ timeout: 5 });
    return;
  }

  for (const entry of result.missing) {
    console.error(
      `[check-bespoke-active-seeds] MISSING: no "${entry.name}" row for "${slug}" — never seeded. Fix: ` +
        `tsx packages/operator-core/lib/harness/routines/${entry.seedScript}`,
    );
  }
  for (const entry of result.inactive) {
    console.error(
      `[check-bespoke-active-seeds] INACTIVE: "${entry.name}" row for "${slug}" is seeded but active=false — ` +
        `its own header commits to ACTIVE by default. Fix: ` +
        `tsx packages/operator-core/lib/harness/routines/${entry.seedScript}`,
    );
  }
  await sql.end({ timeout: 5 });
  process.exitCode = 1;
}

if (require.main === module || process.argv[1]?.includes('check-bespoke-active-seeds')) {
  main().catch((e) => {
    console.error('[check-bespoke-active-seeds] FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
