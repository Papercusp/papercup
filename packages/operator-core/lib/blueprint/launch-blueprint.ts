/**
 * The launch-blueprint primitive — unify-agent-launches-as-blueprints-2026-06-04
 * (P0 / D-002 / D-007).
 *
 * THE unification seam. Before this plan every repeatable agent launch was a
 * hand-wired invoke-caller that hardcoded a role string into
 * `loopbackFetch(/invoke?role=<string>)` (git-sync's merge-resolver, the release
 * routine, the self-improvement implementer) or `spawnInvokeOnce(<string>)` (the
 * auditor lane). This module replaces that with ONE declarative primitive: a
 * **launch blueprint** declares its role (`spine.decider`) + its trigger, and a
 * caller fires it by id (or by event key) — the role + model come from the
 * blueprint, not a literal. The `/invoke?role=` route stays as the low-level spawn
 * mechanism the primitive uses (D-002); only the *caller* becomes declarative.
 *
 * Two kinds of trigger-able built-in blueprint coexist:
 *   - **launch blueprints** (this module) — single-role, fired through the invoke
 *     route by `fireLaunchBlueprint` (deploy / scan / implement / merge-resolution /
 *     audit). The degenerate "one role, one trigger" case (D-007).
 *   - **program blueprints** (`coord-ops/trigger.ts`) — coord-op `steps` + `gate`
 *     programs fired by `startCoordProgramForEvent` (vote / deliberate).
 *
 * Pure resolution (`resolveLaunchTarget*`) is separated from the side-effecting
 * fire so a caller that needs to OBSERVE the dispatch result (git-sync records the
 * resolver's HTTP status / exit code) resolves the target here but keeps its own
 * fire+observe loop, while the simple fire-and-forget callers use
 * `fireLaunchBlueprint`.
 */
import { loadBuiltinBlueprint, assertNotNestedHive, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { loopbackFetch } from '../loopback-fetch';
import { dbosOrchestratorActive } from '../dbos/dbos-flags';

const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

/**
 * The built-in SINGLE-ROLE launch blueprints (vs the program-mode vote/deliberate,
 * which `coord-ops/trigger.ts` owns). Each declares one role in `spine.decider` +
 * a trigger (`triggers.schedule` for cadence launches, `triggers.event` for
 * event-driven ones). Firing one invokes that role once via the invoke route.
 */
export const BUILTIN_LAUNCH_BLUEPRINTS = ['deploy', 'scan', 'implement', 'merge-resolution', 'audit', 'pot', 'bee'] as const;
export type LaunchBlueprintId = (typeof BUILTIN_LAUNCH_BLUEPRINTS)[number];

/**
 * The blueprint-resolver seam — default loads the built-in by id. The operator can
 * override (a PG-cache / Cupboard-installed / forked launch blueprint) the same way
 * the coord-program workflow's resolver is overridable. Pass `null` to restore.
 */
export type LaunchResolverFn = (blueprintId: string) => Blueprint | Promise<Blueprint>;
const builtinResolver: LaunchResolverFn = (id) => loadBuiltinBlueprint(id).blueprint;
let _resolver: LaunchResolverFn = builtinResolver;
export function setLaunchBlueprintResolver(fn: LaunchResolverFn | null): void {
  _resolver = fn ?? builtinResolver;
}

/** Build the invoke-route URL for a role launch. */
function invokeUrl(installSlug: string, role: string, workspaceId: string, bpkind?: 'hive' | 'harness'): string {
  const ws = encodeURIComponent(workspaceId);
  // `bpkind=hive` tells the invoke route this launch is a kind:'hive' blueprint
  // (the pot/Queen) so it records a TRACKED, resumable session (D-010) — the
  // route can't resolve the blueprint itself (it only sees the install slug).
  const kind = bpkind === 'hive' ? '&bpkind=hive' : '';
  return `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}${kind}`;
}

export interface LaunchTarget {
  /** The launch blueprint id resolved. */
  blueprintId: string;
  /** The role to invoke — the blueprint's `spine.decider` (single-role launch). */
  role: string;
  /** The resolved `/invoke?role=` URL. */
  url: string;
}

/**
 * Resolve a launch blueprint id → its launch target (role + invoke URL). The
 * DECLARATIVE primitive: "which role does this launch fire?" comes from the
 * blueprint's `spine.decider`, not a hardcoded literal. A caller that observes the
 * dispatch (git-sync) uses this + its own fire loop; simple callers use
 * `fireLaunchBlueprint`.
 */
export async function resolveLaunchTarget(
  blueprintId: string,
  opts: { installSlug: string; workspaceId: string },
): Promise<LaunchTarget> {
  const bp = await _resolver(blueprintId);
  const role = bp.spine.decider;
  return { blueprintId, role, url: invokeUrl(opts.installSlug, role, opts.workspaceId, bp.kind) };
}

/**
 * Resolve just the ROLE a launch blueprint fires (its `spine.decider`). For a
 * caller that spawns the role through a path OTHER than the invoke route — the
 * auditor lane uses `spawnInvokeOnce` (a direct subprocess), so it needs the role
 * name, not an invoke URL — making the role declarative without building a URL.
 */
export async function resolveLaunchRole(blueprintId: string): Promise<string> {
  const bp = await _resolver(blueprintId);
  return bp.spine.decider;
}

// ── event-keyed launch (D-004) ──────────────────────────────────────────────

let _eventMap: Record<string, string> | null = null;
/**
 * event key → launch blueprint id, built once from the built-in launch blueprints'
 * `triggers.event` (e.g. `git-sync:conflict` → `merge-resolution`,
 * `feature:reaches-auditor-lane` → `audit`). The sibling of
 * `coordOpTriggerMap` for single-role launches.
 */
export function launchBlueprintTriggerMap(): Record<string, string> {
  if (_eventMap) return _eventMap;
  const map: Record<string, string> = {};
  for (const id of BUILTIN_LAUNCH_BLUEPRINTS) {
    try {
      const { blueprint } = loadBuiltinBlueprint(id);
      const key = blueprint.triggers?.event;
      if (key) map[key] = id;
    } catch {
      /* a missing/invalid built-in just isn't a trigger target */
    }
  }
  _eventMap = map;
  return map;
}

/** Resolve an event key to the launch blueprint id that declares it, or null. */
export function resolveLaunchTriggerEvent(eventKey: string): string | null {
  return launchBlueprintTriggerMap()[eventKey] ?? null;
}

/** Clear the memoised event map (tests / dev prompt reload). */
export function resetLaunchBlueprintTriggerMap(): void {
  _eventMap = null;
}

/**
 * Resolve an EVENT key → its launch target (role + invoke URL). The declarative
 * "what does this event launch?" — git-sync resolves `git-sync:conflict` here
 * (→ merge-resolver) instead of hardcoding the role. Returns null when no launch
 * blueprint declares the key.
 */
export async function resolveLaunchTargetForEvent(
  eventKey: string,
  opts: { installSlug: string; workspaceId: string },
): Promise<LaunchTarget | null> {
  const blueprintId = resolveLaunchTriggerEvent(eventKey);
  if (!blueprintId) return null;
  return resolveLaunchTarget(blueprintId, opts);
}

// ── fire-and-forget launch ───────────────────────────────────────────────────

export interface FireLaunchInput {
  installSlug: string;
  workspaceId: string;
  /** Human-readable kickoff (the route forwards it; agents read it as context). */
  kickoff?: string;
  /** Extra args forwarded to invoke-once (the route's `extra`). */
  extra?: string[];
  /** Per-launch timeout for the invoke route (defaults to the route's own). */
  timeoutMs?: number;
  /**
   * The parent/initiator context, when this launch is fired BY something with a
   * parent (a spawning agent, a recursion parent). Presence of a parent triggers
   * the no-nest guard (local-hive D-009 / swarm D-018): a `kind:'hive'` blueprint
   * fired with a parent is REJECTED — hives launch only as roots. The pot's own
   * launch (the parentless `system:blueprint-run` routine) omits this and is
   * allowed. Carries `spawnId`/`role` for lineage; either being set marks a parent.
   */
  parent?: { spawnId?: string | null; role?: string | null } | null;
}

/**
 * The fire seam — injectable so tests capture the dispatch without a real HTTP call
 * (the codebase's `setPipelineInvokeRunner` pattern). Default = the invoke route.
 */
export type LaunchFireFn = (input: FireLaunchInput & LaunchTarget) => void | Promise<void>;
let _fire: LaunchFireFn | null = null;
/** Override the launch-fire fn (tests). Pass `null` to restore the default route fire. */
export function setLaunchBlueprintFire(fn: LaunchFireFn | null): void {
  _fire = fn;
}

const defaultFire: LaunchFireFn = async ({ url, role, installSlug, blueprintId, kickoff, extra, timeoutMs }) => {
  const body: Record<string, unknown> = {};
  if (kickoff) body.kickoff = kickoff;
  // `BLUEPRINT_ID=<id>` scopes the role's prompt resolution to
  // `blueprints/<id>/prompts/<role>.md` (invoke.ts), falling back to the global
  // `prompts/<role>.md` — so a launch blueprint can ship its own role prompt (the
  // `scan` blueprint does, to capture work-items instead of operator cards) while
  // the others inherit their global persona unchanged.
  body.extra = [`BLUEPRINT_ID=${blueprintId}`, ...(extra ?? [])];
  if (timeoutMs) body.timeoutMs = timeoutMs;

  // DURABLE when DBOS is on (unify-agent-spawn-chokepoint P-010): the launch runs
  // inside a registered, step-retried DBOS workflow that survives a host crash +
  // re-fires once, instead of the historical `void loopbackFetch` that LOST the
  // agent on crash. Gated on the flag so durable-spawn.ts (it registers a DBOS
  // workflow at import) is only loaded under DBOS; `durableSpawnFire` returns false
  // when it can't durably enqueue here (e.g. called from inside another step) so we
  // fall through to fire-and-forget.
  if (dbosOrchestratorActive()) {
    try {
      const { durableSpawnFire } = await import('../dbos/durable-spawn');
      const idempotencyKey = `launch:${installSlug}:${blueprintId}:${role}:${Date.now()}`;
      if (await durableSpawnFire({ url, body, idempotencyKey, label: `${installSlug}/${role}` })) {
        return;
      }
    } catch (e) {
      console.warn(
        `[launch-blueprint] durable fire unavailable (${installSlug}/${role}); falling back: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Fire-and-forget fallback (DBOS off, or a durable start isn't possible here):
  // the invoke route runs the agent to completion (up to its timeout); a launch
  // must NOT block the caller (a routine's durable step, an event reaction) on the
  // whole agent lifetime. Mirrors the bespoke callers this replaces (the git-sync
  // merge-resolver dispatch, the release/improvement fires).
  void loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) =>
    console.warn(`[launch-blueprint] fire failed (${installSlug}/${role}): ${e instanceof Error ? e.message : e}`),
  );
};

/**
 * Fire a named launch blueprint: resolve its role (`spine.decider`) and invoke it
 * once via the invoke route. The fire-and-forget convenience over
 * `resolveLaunchTarget` — for the simple callers (release cadence, self-improvement
 * implement, the `system:blueprint-run` blueprintId path). Returns the resolved
 * target so the caller can log/record what it fired.
 */
export async function fireLaunchBlueprint(blueprintId: string, input: FireLaunchInput): Promise<LaunchTarget> {
  // No-nest guard (local-hive D-009 / swarm D-018 enforcement A): a kind:'hive'
  // blueprint fired WITH a parent context is rejected — hives are peers, launchable
  // only as a root. A root launch (the pot's parentless system:blueprint-run) omits
  // `parent` and passes. Resolve the full blueprint only when a parent is present so
  // root launches keep their cheap role-only resolution.
  const hasParent = Boolean(input.parent && (input.parent.spawnId || input.parent.role));
  if (hasParent) {
    const bp = await _resolver(blueprintId);
    assertNotNestedHive(bp, true);
  }
  const target = await resolveLaunchTarget(blueprintId, input);
  const fire = _fire ?? defaultFire;
  await fire({ ...input, ...target });
  return target;
}

/**
 * Fire the launch blueprint that declares `eventKey` (D-004). Returns the resolved
 * target, or null when no launch blueprint declares the key. The event-driven
 * sibling of `fireLaunchBlueprint` — parallel to `startCoordProgramForEvent` for
 * program-mode blueprints.
 */
export async function fireLaunchBlueprintForEvent(
  eventKey: string,
  input: FireLaunchInput,
): Promise<LaunchTarget | null> {
  const blueprintId = resolveLaunchTriggerEvent(eventKey);
  if (!blueprintId) {
    console.warn(`[launch-blueprint] no launch blueprint declares trigger event "${eventKey}"`);
    return null;
  }
  return fireLaunchBlueprint(blueprintId, input);
}
