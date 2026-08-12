#!/usr/bin/env node
/**
 * PURE predicate: does this file spawn a detached process without enrolling it?
 *
 * Exported for the unit test — the guard's own correctness is a property that must
 * be verified, not assumed from a green run on a tree that happens to be clean.
 *
 * @param {string} relPath - Repo-relative path, as it appears in ALLOWLIST.
 * @param {string} source - The file's full source text.
 * @returns {boolean}
 */
export function isUnenrolledDetachedSpawn(relPath: string, source: string): boolean;
/**
 * Sites that legitimately spawn a detached process WITHOUT task-manager enrolment.
 * Every entry needs a reason. Shrinking this list is the point; growing it needs a
 * justification in review.
 */
export const ALLOWLIST: Map<string, string>;
