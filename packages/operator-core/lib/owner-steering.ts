/**
 * owner-steering — the owner's per-Hive steering controls for the Queen
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * The owner's "what should the Queen work on, and how" knobs live as
 * `owner-steering:*` keys in the existing `harness_shared.hive_settings` KV (D-001
 * — no migration; Hive-scoped, federates over the Hive peer-log via the capture
 * trigger). This module OWNS the key names + the decoded {@link OwnerSteering}
 * shape (C-1): `hive:set-steering` writes through it, the `hive.steering` sync
 * resolver (B-01) + the Queen wake-brief inject (B-02 `gatherOwnerSteering`) + the
 * survey pause-enforcement (B-02 P-003) read through it. Mirrors `beacon-consent.ts`
 * (the sibling hive_settings-backed owner-policy accessor).
 *
 * Phase 1 keys (focus steering):
 *   owner-steering:directive       — free-text directive surfaced in the wake brief
 *   owner-steering:eligible-plans  — JSON [slug]; empty/absent ⇒ NO restriction
 *   owner-steering:eligible-hives  — JSON [harness-slug]; the placement SCOPE — the
 *                                    hives/harnesses the home Queen may place into
 *                                    (→ scopeFilter.allowedHarnesses, C-2). Empty ⇒
 *                                    NO restriction. (queen-steering-panel B-04 round-2.)
 *   owner-steering:pause-new-work  — bool; pause starting NEW work (HARD in survey)
 *   owner-steering:paused-until    — epoch ms; the pause auto-expires at this time
 *
 * Defaults (a missing/cleared key) reproduce today's pre-steering behaviour, so the
 * feature is purely additive — an un-steered Hive reads `DEFAULT_OWNER_STEERING`.
 */
import type { Sql } from 'postgres';
import { listHiveSettings, setHiveSetting, deleteHiveSetting } from './hive-settings-store';

/** The `hive_settings` keys the steering controls occupy (C-1). */
export const OWNER_STEERING_KEYS = {
  directive: 'owner-steering:directive',
  eligiblePlans: 'owner-steering:eligible-plans',
  eligibleHives: 'owner-steering:eligible-hives',
  pauseNewWork: 'owner-steering:pause-new-work',
  pausedUntil: 'owner-steering:paused-until',
} as const;

/**
 * The decoded owner-steering state — the C-1 payload the `hive.steering` resolver
 * returns and the Queen wake-brief reads. Every field defaults to the
 * no-restriction value, so an un-steered Hive is exactly today's behaviour.
 */
export interface OwnerSteering {
  /** Free-text owner directive surfaced in the wake brief, or null when unset. */
  directive: string | null;
  /** Slugs the Queen may pick up NOW (eligibility, DISTINCT from lifecycle status,
   *  D-002). Empty ⇒ no restriction. */
  eligiblePlans: string[];
  /** The placement SCOPE — hives/harnesses the home Queen may place into (→
   *  scopeFilter.allowedHarnesses, C-2). Empty ⇒ no restriction. (B-04 round-2.) */
  eligibleHives: string[];
  /** Pause starting NEW work (the Queen drives existing placements to terminal then idles). */
  pauseNewWork: boolean;
  /** Epoch ms the pause auto-expires at, or null. A future value pauses like `pauseNewWork`. */
  pausedUntil: number | null;
}

export const DEFAULT_OWNER_STEERING: OwnerSteering = {
  directive: null,
  eligiblePlans: [],
  eligibleHives: [],
  pauseNewWork: false,
  pausedUntil: null,
};

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Read the owner-steering state for a Hive in ONE query (listHiveSettings), with
 * every missing key defaulting per {@link DEFAULT_OWNER_STEERING}. Fail-soft by
 * construction — a junk/legacy value for any key falls back to its default rather
 * than throwing into the wake brief / resolver.
 */
export async function getOwnerSteering(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<OwnerSteering> {
  const rows = await listHiveSettings(workspaceId, hiveHomeSlug, sql);
  const byKey = new Map(rows.map((r) => [r.settingKey, r.value]));
  const directiveVal = byKey.get(OWNER_STEERING_KEYS.directive);
  return {
    directive: typeof directiveVal === 'string' && directiveVal.trim() ? directiveVal : null,
    eligiblePlans: asStringArray(byKey.get(OWNER_STEERING_KEYS.eligiblePlans)),
    eligibleHives: asStringArray(byKey.get(OWNER_STEERING_KEYS.eligibleHives)),
    pauseNewWork: byKey.get(OWNER_STEERING_KEYS.pauseNewWork) === true,
    pausedUntil: asFiniteNumber(byKey.get(OWNER_STEERING_KEYS.pausedUntil)),
  };
}

/** A partial steering update — omitted fields are left unchanged; `clear` wipes all. */
export interface OwnerSteeringPatch {
  directive?: string | null;
  eligiblePlans?: string[];
  eligibleHives?: string[];
  pauseNewWork?: boolean;
  pausedUntil?: number | null;
  /** Wipe ALL steering keys back to {@link DEFAULT_OWNER_STEERING}. */
  clear?: boolean;
}

/**
 * Write an owner-steering patch (upsert per field). `clear:true` deletes EVERY
 * steering key (back to the default no-restriction state); otherwise only the
 * provided fields are written (a normalized null/empty CLEARS that field; an
 * omitted field is untouched). Returns the resulting full state. The values
 * federate over the Hive peer-log via the hive_settings capture trigger.
 */
export async function setOwnerSteering(
  workspaceId: string,
  hiveHomeSlug: string,
  patch: OwnerSteeringPatch,
  sql?: Sql,
): Promise<OwnerSteering> {
  if (patch.clear) {
    for (const key of Object.values(OWNER_STEERING_KEYS)) {
      await deleteHiveSetting(workspaceId, hiveHomeSlug, key, sql);
    }
    return DEFAULT_OWNER_STEERING;
  }
  const writes: Array<[string, unknown]> = [];
  if (patch.directive !== undefined) {
    writes.push([OWNER_STEERING_KEYS.directive, patch.directive && patch.directive.trim() ? patch.directive : null]);
  }
  if (patch.eligiblePlans !== undefined) {
    writes.push([OWNER_STEERING_KEYS.eligiblePlans, asStringArray(patch.eligiblePlans)]);
  }
  if (patch.eligibleHives !== undefined) {
    writes.push([OWNER_STEERING_KEYS.eligibleHives, asStringArray(patch.eligibleHives)]);
  }
  if (patch.pauseNewWork !== undefined) {
    writes.push([OWNER_STEERING_KEYS.pauseNewWork, patch.pauseNewWork === true]);
  }
  if (patch.pausedUntil !== undefined) {
    writes.push([OWNER_STEERING_KEYS.pausedUntil, asFiniteNumber(patch.pausedUntil)]);
  }
  for (const [settingKey, value] of writes) {
    await setHiveSetting({ workspaceId, hiveHomeSlug, settingKey, value }, sql);
  }
  return getOwnerSteering(workspaceId, hiveHomeSlug, sql);
}

/**
 * True when starting NEW work is paused right now — an explicit `pauseNewWork` OR
 * an un-expired `pausedUntil`. The single predicate the survey pause-enforcement
 * (B-02 P-003) and the wake brief share, so "paused" means the same everywhere.
 */
export function isPausedNow(s: OwnerSteering, nowMs: number): boolean {
  if (s.pauseNewWork) return true;
  return s.pausedUntil != null && nowMs < s.pausedUntil;
}
