/**
 * Workspace-global Postgres advisory-lock key for migration-number allocation.
 *
 * Both allocation doors import this zero-dependency module so a key change
 * cannot split the lock domain and let concurrent callers mint collisions.
 */
export const ALLOC_ADVISORY_KEY = 873_135;
