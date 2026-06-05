/**
 * D-024 — schema-version handling for Hyperbee ops.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-030d.
 * v5 D-024 — every Autobase op carries `schema_version BIGINT`; peers
 * ignore ops with newer-than-known schemas + raise an
 * "upgrade Papercusp available" toast.
 *
 * Per-harness, per-process state:
 *   knownMaxSchemaVersion(harnessSlug)   — read by the apply gate
 *   notedHigherSchemaVersion(...)        — write whenever a higher
 *                                           one arrives; emits the
 *                                           alert exactly once per
 *                                           (slug, version) pair
 *
 * The "known_schema_versions" LOCAL table eventually persists this
 * across restarts; for now the in-process map is sufficient — the
 * worst case on restart is one extra alert per session.
 */

import { EventEmitter } from 'node:events';

/**
 * The current version this build of the operator knows. Bump when
 * adding a backwards-incompatible field to any Hyperbee op shape.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

const knownByHarness = new Map<string, number>();
const alertedKeys = new Set<string>();        // `${slug}::${version}`

export const schemaVersionEvents = new EventEmitter();

export type SchemaVersionAlert = {
  harnessSlug: string;
  observed_version: number;
  known_version: number;
};

export function getKnownMaxSchemaVersion(harnessSlug: string): number {
  return knownByHarness.get(harnessSlug) ?? CURRENT_SCHEMA_VERSION;
}

/**
 * Decide whether an incoming op's schema_version is acceptable.
 * Returns:
 *   - true  → apply this op
 *   - false → drop this op (and an alert may have fired)
 */
export function acceptOpVersion(harnessSlug: string, version: number | undefined): boolean {
  if (version === undefined) return true;        // legacy / not yet versioned
  const known = getKnownMaxSchemaVersion(harnessSlug);
  if (version <= known) return true;
  // Newer-than-known — drop + alert once per (slug, version).
  const alertKey = `${harnessSlug}::${version}`;
  if (!alertedKeys.has(alertKey)) {
    alertedKeys.add(alertKey);
    const alert: SchemaVersionAlert = {
      harnessSlug,
      observed_version: version,
      known_version: known,
    };
    schemaVersionEvents.emit('alert', alert);
  }
  return false;
}

/** For tests. */
export function _resetForTests(): void {
  knownByHarness.clear();
  alertedKeys.clear();
  schemaVersionEvents.removeAllListeners();
}
