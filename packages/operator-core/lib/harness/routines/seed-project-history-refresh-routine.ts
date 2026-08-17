/**
 * Seed a `project-history-refresh` routine — `system:project-history-refresh` →
 * `project-history-refresh-action.ts`, the refresh owner for a hive's committed
 * Project History artifact (EI-20475585438015488, cause 3).
 *
 * Defaults describe SIDESTAGE, the first hive to ship a History tab, but every
 * field is a flag: a second hive seeds another row and needs no code change.
 *
 *   tsx seed-project-history-refresh-routine.ts                    # seed sidestage ACTIVE
 *   tsx seed-project-history-refresh-routine.ts --inactive         # seed off
 *   tsx seed-project-history-refresh-routine.ts --harness other \
 *        --repo-root /path/to/hive --output apps/api/src/history.ts \
 *        --project-id other --project-name Other --export-name HISTORY
 *
 * CADENCE: every 6 hours at :50 (02:50, 08:50, 14:50, 20:50). Offset from the
 * :15 green-checkpoint, :35 gitnexus-reindex and :45 cargo-test so a multi-minute
 * generation never starts in the same tick minute as the release gate. Six hours
 * is a freshness choice, not a cost one — regeneration that yields identical bytes
 * is a git no-op, so the only real cost of the cadence is the generation itself.
 *
 * ⚠ REPO ROOT: the canonical SideStage tree is the HIVE tree
 * (`~/.papercusp/hives/sidestage`), which is what the running API serves from
 * (it executes `src/main.ts` under tsx, so it reads SRC, not dist). The sibling
 * `papercupai-workspace/sidestage` checkout is VESTIGIAL. Pointing this routine at
 * the vestigial tree would regenerate an artifact nothing serves, and the History
 * tab would keep decaying while the routine reported success every six hours.
 *
 * Seeded ACTIVE by default: the action is precondition-gated (it refuses rather
 * than writing when the CLI or `ptool` cannot be resolved), bounded by a timeout,
 * and writes exactly one artifact path that an operator supplied explicitly — so
 * an active routine is safe from the moment it exists. Finished work never ships
 * dark (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return fallback;
}

/** Where the hive trees live. PAPERCUSP_HOME wins so a non-default install seeds correctly. */
function hiveRoot(slug: string): string {
  const home = process.env.PAPERCUSP_HOME?.trim() || path.join(os.homedir(), '.papercusp');
  return path.join(home, 'hives', slug);
}

/** Every 6h at :50 — clear of green-checkpoint (:15), gitnexus-reindex (:35), cargo-test (:45). */
const CRON = '0 50 2,8,14,20 * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const harness = flag('harness', 'sidestage');
  const repoRoot = flag('repo-root', hiveRoot(harness));
  const output = flag('output', 'apps/api/src/build-history/build-history.snapshot.ts');
  const projectId = flag('project-id', harness);
  const projectName = flag('project-name', harness === 'sidestage' ? 'SideStage' : harness);
  const exportName = flag('export-name', harness === 'sidestage' ? 'BUILD_HISTORY_SNAPSHOT' : 'PROJECT_HISTORY');
  const planPrefix = flag('plan-prefix', '');

  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'project-history-refresh';
  const id = `rt_${harness}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    repo_root: repoRoot,
    output,
    project_id: projectId,
    project_name: projectName,
    export_name: exportName,
    plan_prefix: planPrefix,
    format: output.endsWith('.ts') ? 'typescript' : 'json',
    harness,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${harness}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:project-history-refresh', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-project-history-refresh-routine] seeded "${name}" for "${harness}" (ws=${ws}, active=${active}) — ` +
      `every 6h at :50, regenerating ${path.join(repoRoot, output)}. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-project-history-refresh-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
