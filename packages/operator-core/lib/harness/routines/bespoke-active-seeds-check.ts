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
 * This file is the PURE core (importable by a unit test with a fake `sql`, no real PG,
 * no side effect on import — mirrors seed-hive-release-routines.ts/.test.ts). The
 * runnable CLI is the sibling `check-bespoke-active-seeds.ts`:
 *
 *   tsx packages/operator-core/lib/harness/routines/check-bespoke-active-seeds.ts
 *
 * Exit codes (of the CLI):
 *   0 — every registered routine has an ACTIVE row for the operator-home harness
 *   1 — at least one is missing or inactive (prints the exact `tsx …` command to fix it)
 *
 * Not CI-gated — it asserts live-box deploy state, which a fresh CI database never has.
 *
 * ⚠ That sentence used to end "Dev/ops diagnostic (like `db:check_drift`), not CI-gated",
 * and it was silently read as an argument for having NO caller at all. It is not: "a fresh
 * CI database cannot assert this" rules out CI, not the live box. For its entire life this
 * module had ZERO callers outside its own test and its manual CLI — so the recurrence guard
 * for "a seed script nobody ever ran" was itself a script nobody ever ran, reproducing one
 * level up the exact failure it was written to close. Measured 2026-08-08 (plan
 * silent-halt-detection-and-owner-rails-2026-08-08, D-007): `unguarded-halt-rescue` — entry
 * #1 below — sat `active=false` for 11.9 days while the other six registered routines were
 * all firing. This check would have named it, alone, with zero noise. Nothing ran it.
 * Same shape as EI-10660 (`validateActiveRoutines`, zero callers for its whole life).
 *
 * IT NOW HAS TWO LIVE CALLERS, and both are deliberately SELF-ARMING:
 *   1. `routines:set` (agent-tools/routines/set.ts) escalates at the SILENCING INSTANT when
 *      a pause targets one of these names — D-001: the only moment the system holds both
 *      facts (that it is being silenced, and who owns it).
 *   2. `host-bootstrap.ts`, beside its sibling startup guards — the backstop for a flip that
 *      bypassed `routines:set` entirely (the EI-18137248342636257 instance was flipped
 *      through an UNAUDITED path, so a write-path hook alone cannot be the whole answer).
 *
 * This checker must NEVER become a bespoke-seeded routine itself: the failure class it
 * detects applies to it, and it is the only thing that would detect that. Any future caller
 * must be self-arming (boot, or a write path, or the tick of an already-verified routine).
 */
import type { Sql } from 'postgres';
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
  { name: 'corpus-term-df', seedScript: 'seed-corpus-term-df-routine.ts' },
  { name: 'sql-read-census', seedScript: 'seed-sql-read-census-routine.ts' },
];

/**
 * The names in {@link BESPOKE_ACTIVE_SEEDS}, as a set — the "this routine is EXPECTED to be
 * running" property, derived from the registry so it can never drift from it.
 *
 * Deliberately DERIVED rather than a second hand-written list. The two comparable carve-outs
 * in this codebase are both hardcoded name sets that went stale in exactly the way that
 * matters: `RELEASE_CRITICAL_ROUTINE_NAMES` (system-health/compute.ts) is 2 names, and
 * `ALWAYS_ON_LEARNING_LOOPS` (blueprint/learning-loop-health.ts) is 3 — and a routine whose
 * entire job is noticing silence was in neither, so every age-based exemption swallowed it.
 * Anchor membership to the PROPERTY (this routine's own header commits it to ACTIVE), never
 * to a spelling someone has to remember to copy.
 */
export const ALWAYS_ON_SYSTEM_ROUTINE_NAMES: ReadonlySet<string> = new Set(
  BESPOKE_ACTIVE_SEEDS.map((s) => s.name),
);

/** Is this routine one whose own seed script commits it to ACTIVE — i.e. is a pause of it
 *  always worth a human's attention, no matter how old it gets? */
export function isAlwaysOnSystemRoutine(name: string): boolean {
  return ALWAYS_ON_SYSTEM_ROUTINE_NAMES.has(name);
}

/** A registered routine found seeded-but-paused, with the pause attribution that decides
 *  whether it warrants waking someone. */
export interface InactiveBespokeSeed extends BespokeActiveSeed {
  /** `metadata.pause.reason` — null when the flip bypassed `routines:set` (which requires
   *  one). A null here is itself a finding: it means an UNAUDITED path wrote active=false. */
  pauseReason: string | null;
  /** `metadata.pause.reviewBy` — while it is in the FUTURE the pause counts as explicitly
   *  re-affirmed and does not escalate. Same convention as the learning-loop-health sweep
   *  (EI-19370236916382521); reused rather than reinvented so one `reviewBy` means one thing. */
  reviewBy: string | null;
  /** `metadata.pause.pausedAtMs`, when recorded. */
  pausedAtMs: number | null;
}

export interface CheckResult {
  missing: BespokeActiveSeed[];
  inactive: InactiveBespokeSeed[];
  /**
   * The subset of `missing` + `inactive` that warrants waking a human right now: everything
   * missing, plus every inactive routine NOT covered by a future `reviewBy`.
   *
   * Split from `ok` on purpose. `ok` is the strict steady-state assertion the dev/ops CLI
   * wants (any deviation at all). `escalatable` is the owner-rail question, and a deliberate,
   * dated pause must be able to answer it "no" — otherwise the notice re-fires on every boot
   * forever and becomes the cry-wolf noise that got the ORIGINAL routine paused.
   */
  escalatable: Array<BespokeActiveSeed | InactiveBespokeSeed>;
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
  /** Injectable clock for the `reviewBy` comparison (tests). Defaults to `Date.now()`. */
  now?: number;
}): Promise<CheckResult> {
  const entries = opts.entries ?? BESPOKE_ACTIVE_SEEDS;
  const now = opts.now ?? Date.now();
  type Row = { name: string; active: boolean; metadata: { pause?: PauseMeta } | null };
  const rows = (await opts.sql<Row[]>`
    SELECT name, active, metadata FROM harness_shared.routines
    WHERE install_slug = ${opts.installSlug} AND workspace_id = ${opts.workspaceId}
      AND name = ANY(${entries.map((s) => s.name)})
  `) as unknown as Row[];
  const byName = new Map(rows.map((r) => [r.name, r]));

  const missing: BespokeActiveSeed[] = [];
  const inactive: InactiveBespokeSeed[] = [];
  for (const entry of entries) {
    const row = byName.get(entry.name);
    if (row === undefined) missing.push(entry);
    else if (row.active !== true) inactive.push({ ...entry, ...readPause(row.metadata) });
  }
  // A missing row can carry no re-affirmation (there is nothing to write it on), so every
  // missing entry escalates; an inactive one escalates unless its reviewBy is still ahead.
  const escalatable = [...missing, ...inactive.filter((e) => !isReaffirmed(e.reviewBy, now))];
  return { missing, inactive, escalatable, ok: missing.length === 0 && inactive.length === 0 };
}

interface PauseMeta {
  reason?: unknown;
  reviewBy?: unknown;
  pausedAtMs?: unknown;
}

/** Narrow `metadata.pause` (free-form jsonb) to the three fields this check reports. */
function readPause(metadata: { pause?: PauseMeta } | null): Pick<InactiveBespokeSeed, 'pauseReason' | 'reviewBy' | 'pausedAtMs'> {
  const p = metadata?.pause ?? null;
  return {
    pauseReason: typeof p?.reason === 'string' && p.reason.length > 0 ? p.reason : null,
    reviewBy: typeof p?.reviewBy === 'string' && p.reviewBy.length > 0 ? p.reviewBy : null,
    pausedAtMs: typeof p?.pausedAtMs === 'number' ? p.pausedAtMs : null,
  };
}

/**
 * Is this pause explicitly re-affirmed — i.e. does it carry a `reviewBy` still in the future?
 *
 * Fails CLOSED (returns false, so it DOES escalate) on an absent or unparseable date. The
 * asymmetry is the whole point of this subsystem: a spurious notice about a routine someone
 * deliberately paused costs one glance, while a missed one cost 11.9 days of a dark rescue
 * sweep. Never let an unreadable field buy silence.
 */
export function isReaffirmed(reviewBy: string | null, now: number): boolean {
  if (!reviewBy) return false;
  const t = Date.parse(reviewBy);
  return Number.isFinite(t) && t > now;
}

/** Convenience for the CLI wrapper — resolves the operator-home scope the same way
 *  every `seed-*-routine.ts` in this directory does. */
export function operatorHomeScope(): { installSlug: string; workspaceId: string } {
  return { installSlug: operatorHomeHarnessSlug(), workspaceId: activeWorkspaceId() };
}
