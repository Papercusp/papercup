/**
 * Dispositions for the condition-rail inventory (plan `degradation-signals-on-condition-rail-2026-10-11`,
 * P-001, BAR R-4). Keyed `class|file` (a whole cluster) or `class|file|symbol` (one site).
 *
 *   { disposition: 'migrate', item: 'P-NNN' }               — moves onto the rail under that plan item
 *   { disposition: 'not-applicable', reason: '<why, >=20 chars>' }
 *
 * Seeded from a measured run of scripts/condition-rail-inventory.mjs, never from a hand grep.
 */
export const DISPOSITIONS = Object.freeze({});
