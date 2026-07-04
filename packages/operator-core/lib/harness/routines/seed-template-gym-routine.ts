/**
 * Seed the template-gym routine — app-templates-2026-07-04 P-009 (anti-rot,
 * D-007: "the template is tested by building an app from it").
 *
 *   - `template-gym` (every 6h at :43 — offset from green-checkpoint's :15,
 *     git-sync's short ticks, and the nightly p2p benches): fire
 *     `system:template-gym`, which runs the five-leg anti-rot union
 *     (materialization verbatim-copy ⇄ consumer #1, docs⇄catalog drift, kit
 *     drift pins, template-side suite, quartermaster's materialized checks)
 *     and auto-files a `template-drift` work-item per standing RED leg
 *     (stable watchdogKey, EI-7254-style exact dedup).
 *
 * ACTIVE by default — the gym is advisory (never gates), bounded (~3-5 min
 * green-path), and files at most once per standing red. Override the
 * quartermaster clone location via trigger_config `qmRoot` (routines:set
 * { triggerConfig: { qmRoot } }); default is the sibling clone
 * `../quartermaster` of the integration tree.
 *
 *   npx tsx packages/operator-core/lib/harness/routines/seed-template-gym-routine.ts
 *   npx tsx … --inactive   # seed but leave off
 *
 * Idempotent (upsert on (install_slug, name)).
 */

import { getOrgPg } from "@papercusp/db-org";
import { activeWorkspaceId } from "../../workspace-registry";
import { operatorHomeHarnessSlug } from "../operator-home-harness";

const SLUG = process.env.TEMPLATE_GYM_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = "template-gym";
const TARGET = "system:template-gym";
const CRON = "0 43 */6 * * *";

async function main(): Promise<void> {
  const active = process.argv.includes("--inactive") ? false : true;
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${NAME}, 'cron', ${JSON.stringify({ cron: CRON })}::text::jsonb, ${TARGET},
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      active = EXCLUDED.active,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-template-gym-routine] seeded for "${SLUG}" (ws=${ws}): ${NAME}=${active ? "ACTIVE" : "inactive"} ` +
      `(cron "${CRON}", target ${TARGET}). Advisory — reds file template-drift work-items; nothing gates.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[seed-template-gym-routine] failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
