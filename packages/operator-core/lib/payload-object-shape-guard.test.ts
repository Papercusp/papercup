/**
 * payload-object-shape-guard.test.ts — pins migration 725's structural invariant
 * and the read-side deletions that DEPEND on it (WI-6993 / EI-19342686955096692).
 *
 * WHY THIS FILE EXISTS. The `payload.plan_item` stamp lookup was the single largest
 * live consumer of database time in the system: measured 2026-08-02 by rate,
 * 142.1 calls/min x 133.9ms mean returning ONE row = ~7.6 HOURS of DB time PER DAY.
 * The cause was a defensive shape-normalizer every reader had independently grown:
 *
 *   (CASE WHEN jsonb_typeof(payload) = 'string'
 *         THEN (payload #>> '{}')::jsonb ELSE payload END)->'plan_item'->>'plan_slug'
 *
 * An index on `payload->'plan_item'->>'plan_slug'` can never match that CASE-wrapped
 * expression, so the wrap silently forced a full sequential scan on every lookup.
 * Migration 725 deleted the wraps and replaced them with a STRUCTURAL guarantee —
 * a CHECK constraint making the string-scalar shape unstorable in the first place.
 *
 * That trade is only sound while BOTH halves hold, and nothing else asserts either:
 *  - if the CONSTRAINT is dropped/edited away, the readers under-report silently (a
 *    stamp reads as null -> the plan item looks genuinely unworked), which is exactly
 *    the false "orphaned lane" diagnosis EI-13721 was filed for; and
 *  - if a future reader rediscovers the postgres-js binding quirk and re-adds the
 *    wrap "defensively", the 7.6h/day regression comes straight back.
 * Four separate sites had independently grown a copy of that mitigation, and one of
 * their comments asked the reader to "keep both in sync" — manual synchronisation
 * between copies of a workaround is the tell that the defect was never closed out.
 *
 * This is a source/migration-text assertion, not a PG one, deliberately: the fixture
 * DDL in test/_work-items-schema.ts omits CHECK constraints on purpose so fixtures can
 * insert deliberately-odd rows, so a live-PG test cannot observe the constraint. Same
 * convention as work-item-completion-authority.test.ts, which asserts migration 677's
 * CHECK against the migration file rather than against a fixture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const MIGRATION = join(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/725-payload-object-shape-guard-and-plan-item-stamp-index.sql',
);

const CONSTRAINT = 'work_items_payload_is_object_ck';

/**
 * The readers whose stamp queries were un-wrapped on the strength of the constraint
 * above. Each is repo-relative; a path that stops existing fails loudly here rather
 * than silently dropping its guard (a renamed file must be re-listed, not forgotten).
 */
const UNWRAPPED_READERS = [
  'packages/operator-core/lib/plan-item-coverage.ts',
  'packages/operator-core/lib/plan-items/reconcile-linked-work-items.ts',
  'packages/operator-core/lib/plan-items/convert.ts',
];

/** Strip SQL (`--`) and JS (`//`, block) comments so a comment ABOUT the wrap never trips the check. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(?:--|\/\/).*$/gm, '')
    .replace(/(?:--|\/\/).*$/gm, '');
}

describe('migration 725 payload-object-shape guard (WI-6993)', () => {
  it('still declares the CHECK constraint the read-side deletions depend on', () => {
    const sql = readFileSync(MIGRATION, 'utf8');

    expect(sql, `migration 725 no longer names ${CONSTRAINT}`).toContain(CONSTRAINT);
    // The predicate itself, whitespace-insensitively: payload IS NULL OR jsonb_typeof(payload) = 'object'.
    const predicate = stripComments(sql).replace(/\s+/g, ' ');
    expect(
      predicate,
      'migration 725 no longer CHECKs that payload is object-shaped — the readers that ' +
        'dropped their string-scalar unwrap now under-report stamps silently (EI-13721 regression)',
    ).toMatch(/CHECK \(\s*payload IS NULL OR jsonb_typeof\(payload\) = 'object'\s*\)/i);
    // NOT VALID + a separate VALIDATE is what keeps the backfill off ACCESS EXCLUSIVE;
    // collapsing them into one statement locks the largest table in the system.
    expect(predicate).toMatch(/ADD CONSTRAINT work_items_payload_is_object_ck[\s\S]*?NOT VALID/i);
    expect(predicate).toMatch(/VALIDATE CONSTRAINT work_items_payload_is_object_ck/i);
  });

  it('applies the constraint to the base TABLE, never to a consolidated VIEW', () => {
    // WI-7049: harness_features_consolidated has been a VIEW over work_items since
    // migration 374, and ALTER TABLE ... ADD CONSTRAINT on a view fails 42809 every
    // time — dead code that breaks the next full db:migrate replay. The base-table
    // constraint already covers the view, which projects payload straight through.
    const sql = stripComments(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toMatch(/ALTER TABLE harness_shared\.work_items\s+ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/ALTER TABLE harness_shared\.harness_features_consolidated/i);
  });
});

describe('the read-side stamp queries stay index-compatible', () => {
  it.each(UNWRAPPED_READERS)('%s does not reintroduce the index-defeating jsonb unwrap', (rel) => {
    const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8')).replace(/\s+/g, ' ');

    // The exact shape that cost ~7.6h of DB time per day. Matched on the CASE/jsonb_typeof
    // pair rather than the whole expression so a reformatted copy is still caught.
    expect(
      src,
      `${rel} reintroduced a "CASE WHEN jsonb_typeof(payload) = 'string'" unwrap. That ` +
        'expression cannot match the index on payload->\'plan_item\'->>\'plan_slug\', so it ' +
        'forces a full sequential scan on the hottest query in the system (WI-6993). ' +
        "Migration 725's CHECK constraint already makes the shape it defends against " +
        'unstorable — delete the wrap instead of re-adding it.',
    ).not.toMatch(/CASE WHEN jsonb_typeof\(\s*\w*\.?payload\s*\)\s*=\s*'string'/i);
  });

  it('plan-item-coverage.ts keeps the bare payload->\'plan_item\' predicate the partial index needs', () => {
    // The leading `payload->'plan_item' IS NOT NULL` must match
    // work_items_plan_item_stamp_idx's PARTIAL predicate exactly, or the planner
    // cannot use the index even though the wrap is gone.
    const src = stripComments(
      readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/plan-item-coverage.ts'), 'utf8'),
    ).replace(/\s+/g, ' ');
    expect(src).toMatch(/WHERE payload->'plan_item' IS NOT NULL/i);
  });
});
