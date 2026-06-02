/**
 * Deterministic, collision-free identity for one hermetic gym run.
 *
 * Every `(task × variant × cycle)` evaluation runs in its own throwaway harness
 * — its own `harness_<slug>` PG schema, its own filed feature, its own substrate
 * clone dir. This derives those names purely from the run key so the same key
 * always resolves to the same names (idempotent re-runs / DBOS replay) and
 * distinct keys never collide.
 *
 * The slug is `gym-`-prefixed on purpose: the dedicated gym-operator scopes its
 * DBOS autoloop to gym harnesses via a slug match
 * (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`), and the prefix keeps gym schemas
 * visually distinct from real harnesses. It is kept short enough that
 * `harness_<slug>` stays within Postgres's 63-char identifier limit.
 */
import { createHash } from 'node:crypto';

export interface GymRunKey {
  /** The synthetic-task id (one feature per task). */
  taskId: string;
  /** The prompt-variant id (the overlay under test). */
  variantId: string;
  /** Optimization cycle index (0 for the spine's manual A/B). */
  cycle: number;
}

export interface GymRunIdentity {
  /** Throwaway harness slug → `harness_<slug>` schema; gym-prefixed for autoloop scoping. */
  harnessSlug: string;
  /** The synthetic feature id filed into the throwaway harness (task-derived). */
  featureId: string;
  /** Scratch dir name for the substrate clone (== harnessSlug; filesystem-safe). */
  cloneDirName: string;
}

/** `harness_` (8) + slug ≤ 63 ⇒ slug ≤ 55; reserve room for the prefix + hash. */
const MAX_SLUG_LEN = 55;
const HASH_LEN = 10;
const MAX_HINT_LEN = 20;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Lowercase, collapse any run of non-`[a-z0-9]` to a single `-`, trim dashes. */
function sanitizeSlugPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function gymRunIdentity(key: GymRunKey): GymRunIdentity {
  const canonical = `${key.taskId}::${key.variantId}::${key.cycle}`;
  const hash = sha256hex(canonical).slice(0, HASH_LEN);
  const hint = sanitizeSlugPart(`${key.variantId}-${key.cycle}`).slice(0, MAX_HINT_LEN);

  let harnessSlug = hint ? `gym-${hint}-${hash}` : `gym-${hash}`;
  if (harnessSlug.length > MAX_SLUG_LEN) harnessSlug = harnessSlug.slice(0, MAX_SLUG_LEN);
  // Truncation could leave a trailing dash; the hash suffix already disambiguates,
  // so just tidy the tail to keep the slug well-formed.
  harnessSlug = harnessSlug.replace(/-+$/g, '');

  const taskHash = sha256hex(key.taskId).slice(0, 8).toUpperCase();
  const featureId = `F-GYM-${taskHash}`;

  return { harnessSlug, featureId, cloneDirName: harnessSlug };
}
