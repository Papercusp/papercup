/**
 * Automation catalog — the read model behind the owner-facing automation panes
 * (Blender = learning agents, Docs = documentation agents).
 *
 * WHY THIS EXISTS (2026-07-25, owner ask): the owner's weekly Claude limit was
 * being consumed by cron-spawned agents with NO owner-facing surface to see or
 * configure them. Every existing surface produced a false negative — the
 * agents-running roster reads empty because these agents are EPHEMERAL (spawn →
 * a few turns → exit), so nothing is ever listed while spend is continuous.
 * See /internal/docs/agent-insights/attributing-claude-token-spend.
 *
 * This module joins the two halves the owner needs in one place:
 *   - WHAT IS SCHEDULED — `harness_shared.routines` (cadence, active, last/next fire)
 *   - WHAT IT COSTS     — `harness_shared.agent_usage_samples` rolled up by role
 *
 * ⚠ DELIBERATELY NOT JOINED: routine → cost. `agent_usage_samples.account_id` is
 * frequently NULL and there is no foreign key from a usage row back to the routine
 * that spawned it, so any per-routine cost number would be a guess presented as a
 * fact. Spend is reported by ROLE alongside the schedule, never fused into it.
 * (An earlier version of this investigation asserted exactly such an unproven link
 * and was wrong twice.) If per-routine attribution is wanted, the fix is to stamp
 * the spawning routine onto the usage row at spawn time — not to infer it here.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { ScheduleSource } from '../schedule-inventory';

// The owner-facing category set + which pane renders each one now live in a
// dependency-free module, because the sidebar tabs import them as VALUES and
// this file top-level-imports a Postgres client. Re-exported so existing
// importers (and the automation.catalog consumers) are unaffected.
export {
  AUTOMATION_CATEGORIES,
  BLENDER_PANE_CATEGORIES,
  DOCS_PANE_CATEGORIES,
  CATCH_ALL_PANE_CATEGORIES,
} from './pane-categories';
export type { AutomationCategory } from './pane-categories';
import type { AutomationCategory } from './pane-categories';
import { AUTOMATION_CATEGORIES } from './pane-categories';

export interface AutomationRoutine {
  name: string;
  installSlug: string;
  group: string | null;
  category: AutomationCategory;
  cron: string | null;
  /** Human cadence, e.g. "every 30m" — derived from cron for display. */
  cadence: string | null;
  active: boolean;
  /** True when this routine's fire spawns a model-backed agent (i.e. it can cost tokens). */
  spawnsAgent: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  /**
   * Which scheduling mechanism this row came from. `harness_shared.routines` is
   * only ONE of five (see lib/schedule-inventory.ts); the pane used to read that
   * one table alone, which is why scheduled work living in a DBOS workflow, a
   * managedSetInterval timer or an in-process sweep was structurally invisible
   * in the rail no matter how the categories were wired.
   */
  source: ScheduleSource;
  /**
   * Whether this row can be paused from the pane. Only `routines` rows can:
   * `routines:set` writes that table and nothing else. A row with
   * `controllable:false` MUST NOT render a working-looking pause button — the
   * whole reason this pane was broken is that it offered controls that could
   * not act, so an inert control here would repeat the same lie in a new place.
   */
  controllable: boolean;
}

export interface AutomationRoleSpend {
  role: string;
  modelClass: string | null;
  turns: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  lastSeenAt: string | null;
}

export interface AutomationCategorySummary {
  category: AutomationCategory;
  total: number;
  active: number;
  /** Active routines in this category that spawn a model-backed agent. */
  activeSpawning: number;
}

/** Per-pot gym arm state (harness_shared.gym_autoloop_config) — armed via gym:arm. */
export interface AutomationGymArm {
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  status: string;
}

/** Per-lane learning-governor arm state (harness_shared.learning_governor_loops) — armed via governor:arm. */
export interface AutomationLaneArm {
  loopId: string;
  displayName: string;
  potSlug: string | null;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  enforcement: string;
}

/**
 * The SPEND-GATING layer, distinct from the schedule layer above (P-011): a
 * routine can be active while its pot/lane is disarmed (fires, spends nothing)
 * and vice versa. `gym:*` governor rows are deliberately folded into `gymPots`
 * (via gym_autoloop_config) rather than listed as lanes — gym arming writes both
 * layers through gym:arm, and the dozens of disabled `gym:<dead-test-pot>` rows
 * would otherwise swamp the list.
 */
export interface AutomationArming {
  gymPots: AutomationGymArm[];
  lanes: AutomationLaneArm[];
}

export interface AutomationCatalog {
  routines: AutomationRoutine[];
  categories: AutomationCategorySummary[];
  /** 7-day spend by agent role. NOT attributable per-routine — see module header. */
  spend7d: AutomationRoleSpend[];
  spend7dTotalUsd: number;
  /** Arming (spend-gate) state for the Blender pane's Arming section. */
  arming: AutomationArming;
  generatedAt: string;
}

/**
 * Routines whose fire spawns a model-backed agent (and therefore consumes tokens),
 * matched by name. Everything else is a pure system sweep (SQL/git/gc) that costs
 * nothing — keeping them visually distinct is the whole point of the pane: the owner
 * must be able to tell "this one can spend money" from "this one cannot" at a glance.
 */
const AGENT_SPAWNING_PATTERNS: RegExp[] = [
  /^bp-singleton-/i, // blueprint learning singletons (scout, red-queen, regret, …)
  /^gym-cycle$/i,
  /^template-gym$/i,
  /^pot-eval-battery$/i,
  /^improvement-(implement|triage|watchdog|human-digest|invalid-args-miner)$/i,
  // `wake` as a whole word ANYWHERE in the name — not an anchored suffix. The
  // dominant spender observed on 2026-07-25 was `wake-brain` ($706/7d on opus),
  // which a `/wake$/` suffix match silently misses while still matching its
  // siblings `overwatch-wake` / `pot-wake` — i.e. the pane would have flagged the
  // cheap ones and hidden the expensive one.
  /(^|-)wake($|-)/i,
  /^loop-su-/i, // agent-armed continuation loops
  // The post-git-sync doc repair. It spawns an LLM doc-steward per drift batch
  // (555 lifetime spawns, ~$40/day before it was gated), so it MUST carry the
  // token flag — the detection half beside it is free, and the owner has to be
  // able to tell them apart at a glance.
  /^doc-steward/i,
  /prospector-cadence$/i,
  /^hive-canary$/i,
  /^autonomy-trust-scan$/i,
  /^coord-invariant-monitor$/i,
  /^claim-discipline-watch$/i,
];

const DOCS_PATTERNS: RegExp[] = [/doc/i, /^knowledge-pack-/i];

/**
 * Learning-pipeline routines identified by NAME, checked BEFORE the group slug for the same
 * reason Docs is: the owner thinks of the whole `improvement-*` family as one pipeline (the
 * Blender) and expects one place to pause it, but the DB files them across different groups —
 * `improvement-watchdog` is grouped `health` while its siblings `improvement-implement` /
 * `-triage` / `-human-digest` are grouped `self-improvement`. That split rendered the
 * pipeline's single biggest work-item emitter in the Agents pane while the rest of the family
 * sat in Blender, so pausing "the Blender" demonstrably did NOT stop it (2026-07-25: the
 * watchdog kept minting duplicate work items every 15 min).
 */
const LEARNING_NAME_PATTERNS: RegExp[] = [
  /^improvement-/i,
  /^bp-singleton-/i,
  /^gym-cycle$/i,
  /^template-gym$/i,
  /^pot-eval-battery$/i,
  /^scout-/i,
  /prospector-cadence$/i,
];

export function routineSpawnsAgent(name: string): boolean {
  return AGENT_SPAWNING_PATTERNS.some((re) => re.test(name));
}

/**
 * Classify a routine into an owner-facing category.
 *
 * Docs is checked BEFORE the group, because a documentation routine may be filed
 * under self-improvement/health by its group_slug while the owner thinks of it as
 * "the documentation agent" and looks for it in the Docs pane.
 */
export function classifyRoutine(name: string, groupSlug: string | null): AutomationCategory {
  if (DOCS_PATTERNS.some((re) => re.test(name))) return 'docs';
  // Before the group, like Docs: the learning pipeline must present as ONE pane even though
  // its routines are filed under different group slugs (see LEARNING_NAME_PATTERNS).
  if (LEARNING_NAME_PATTERNS.some((re) => re.test(name))) return 'learning';
  if (groupSlug === 'agent-loops' || /^loop-su-/i.test(name)) return 'agent-loops';
  if (groupSlug === 'self-improvement') return 'learning';
  if (groupSlug === 'supervision') return 'supervision';
  if (groupSlug === 'health') return 'health';
  if (groupSlug === 'git-sync' || groupSlug === 'release') return 'infra';
  // Ungrouped: fall back to name shape so nothing lands in a category the owner
  // would never think to open.
  if (/^bp-singleton-|gym|improvement-|eval-battery|prospector/i.test(name)) return 'learning';
  if (/git-sync|checkpoint|release|deploy|gc|reaper|retention|precompute/i.test(name)) return 'infra';
  if (/wake|overwatch|coord-|claim-|canary|autonomy/i.test(name)) return 'supervision';
  return 'health';
}

/** Render a cron expression as a short human cadence for the pane. */
export function cronCadence(cron: string | null): string | null {
  if (!cron) return null;
  const f = cron.trim().split(/\s+/);
  // 6-field (with seconds) or 5-field.
  const [, min, hour] = f.length >= 6 ? f : ['0', ...f];
  const everyMin = min?.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*') return `every ${everyMin[1]}m`;
  const everyHour = hour?.match(/^\*\/(\d+)$/);
  if (everyHour) return `every ${everyHour[1]}h`;
  if (min?.includes(',') && hour === '*') return `${min.split(',').length}×/hour`;
  if (hour === '*') return 'hourly';
  if (/^\d+$/.test(hour ?? '')) return 'daily';
  return cron;
}

export async function getAutomationCatalog(): Promise<AutomationCatalog> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const iso = (d: Date | null | undefined): string | null =>
    d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

  const rows = await sql<
    Array<{
      name: string;
      install_slug: string;
      group_slug: string | null;
      trigger_config: Record<string, unknown> | null;
      active: boolean;
      last_fired_at: Date | null;
      next_fire_at: Date | null;
    }>
  >`
    SELECT name, install_slug, group_slug, trigger_config, active, last_fired_at, next_fire_at
      FROM harness_shared.routines
     WHERE workspace_id = ${ws}
     ORDER BY active DESC, name ASC`;

  const routines: AutomationRoutine[] = rows.map((r) => {
    const cron = typeof r.trigger_config?.cron === 'string' ? (r.trigger_config.cron as string) : null;
    return {
      name: r.name,
      installSlug: r.install_slug,
      group: r.group_slug,
      category: classifyRoutine(r.name, r.group_slug),
      cron,
      cadence: cronCadence(cron),
      active: r.active === true,
      spawnsAgent: routineSpawnsAgent(r.name),
      lastFiredAt: iso(r.last_fired_at),
      nextFireAt: iso(r.next_fire_at),
      source: 'routines' as const,
      controllable: true,
    };
  });

  /*
   * The other four scheduling mechanisms. `harness_shared.routines` above is one
   * of five sources in the host (schedule-inventory.ts); reading only it is why
   * the owner could ask "what about the routine that checks for drifted
   * documentation?" and be right that it was missing — that sweep does not live
   * in the routines table, so no amount of category wiring could surface it.
   *
   * These rows are LISTED but not controllable: `routines:set` writes the
   * routines table and nothing else, so the pane shows them with their cadence
   * and last fire and says plainly that they cannot be paused from here.
   * Degrades to routines-only if the inventory throws — a partial pane beats a
   * pane that fails to load.
   */
  let external: AutomationRoutine[] = [];
  try {
    const { collectScheduleInventory } = await import('../schedule-inventory');
    const inventory = await collectScheduleInventory();
    external = inventory
      .filter((row) => row.source !== 'routines')
      .map((row) => ({
        name: row.name,
        installSlug: row.installSlug ?? row.source,
        group: row.groupSlug,
        category: classifyRoutine(row.name, row.groupSlug),
        cron: null,
        cadence: row.cadence || null,
        // `armed` is null for sources that cannot report it; treat unknown as
        // running, because claiming a live sweep is "off" is the worse error.
        active: row.armed !== false,
        spawnsAgent: routineSpawnsAgent(row.name),
        lastFiredAt: row.lastFire,
        nextFireAt: row.nextFire,
        source: row.source,
        controllable: false,
      }));
  } catch {
    external = [];
  }

  const allRoutines = [...routines, ...external];

  const categories: AutomationCategorySummary[] = AUTOMATION_CATEGORIES.map((category) => {
    const inCat = allRoutines.filter((x) => x.category === category);
    return {
      category,
      total: inCat.length,
      active: inCat.filter((x) => x.active).length,
      activeSpawning: inCat.filter((x) => x.active && x.spawnsAgent).length,
    };
  });

  const spendRows = await sql<
    Array<{
      role: string | null;
      model_class: string | null;
      turns: string | null;
      out_tok: string | null;
      cache_r: string | null;
      usd: string | null;
      last_ts: string | null;
    }>
  >`
    SELECT role,
           model_class,
           sum(turn_count)::text          AS turns,
           sum(output_tokens)::text       AS out_tok,
           sum(cache_read_tokens)::text   AS cache_r,
           sum(cost_usd)::text            AS usd,
           max(ts)::text                  AS last_ts
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${ws}
       AND ts > (extract(epoch from now()) * 1000 - 7 * 86400000)
     GROUP BY role, model_class
     ORDER BY sum(cost_usd) DESC NULLS LAST`;

  const spend7d: AutomationRoleSpend[] = spendRows
    .filter((r) => r.role)
    .map((r) => ({
      role: r.role as string,
      modelClass: r.model_class,
      turns: Number(r.turns ?? 0) || 0,
      outputTokens: Number(r.out_tok ?? 0) || 0,
      cacheReadTokens: Number(r.cache_r ?? 0) || 0,
      costUsd: Number(r.usd ?? 0) || 0,
      lastSeenAt: r.last_ts ? new Date(Number(r.last_ts)).toISOString() : null,
    }));

  // Arming (spend-gate) state — same degrade-to-empty posture as the schedule
  // inventory above: a partial pane beats a pane that fails to load.
  let arming: AutomationArming = { gymPots: [], lanes: [] };
  try {
    const gymRows = await sql<
      Array<{ harness_slug: string; enabled: boolean; budget_usd: number | null; spent_usd: number | null; status: string | null }>
    >`
      SELECT harness_slug, enabled, budget_usd, spent_usd, status
        FROM harness_shared.gym_autoloop_config
       WHERE workspace_id = ${ws}
       ORDER BY enabled DESC, harness_slug ASC`;
    const laneRows = await sql<
      Array<{ loop_id: string; display_name: string | null; pot_slug: string | null; enabled: boolean; budget_usd: string | null; spent_usd: string | null; enforcement: string | null }>
    >`
      SELECT loop_id, display_name, pot_slug, enabled, budget_usd, spent_usd, enforcement
        FROM harness_shared.learning_governor_loops
       WHERE workspace_id = ${ws}
         AND loop_id NOT LIKE 'gym:%'
       ORDER BY enabled DESC, loop_id ASC`;
    arming = {
      gymPots: gymRows.map((r) => ({
        harnessSlug: r.harness_slug,
        enabled: r.enabled === true,
        budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
        spentUsd: Number(r.spent_usd ?? 0) || 0,
        status: r.status ?? 'idle',
      })),
      lanes: laneRows.map((r) => ({
        loopId: r.loop_id,
        displayName: r.display_name ?? r.loop_id,
        potSlug: r.pot_slug,
        enabled: r.enabled === true,
        budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
        spentUsd: Number(r.spent_usd ?? 0) || 0,
        enforcement: r.enforcement ?? 'governor',
      })),
    };
  } catch {
    /* degrade: arming section renders empty, schedule section still loads */
  }

  return {
    routines: allRoutines,
    categories,
    spend7d,
    spend7dTotalUsd: spend7d.reduce((a, b) => a + b.costUsd, 0),
    arming,
    generatedAt: new Date().toISOString(),
  };
}
