/**
 * partial-jsonb-index-alignment.test.ts — pins migration 691's PARTIAL index and the
 * sweep queries that DEPEND on stating its predicate (EI-19448297390091252).
 *
 * WHY THIS FILE EXISTS. `coord_event_log_related_msg_id_idx` is a PARTIAL index:
 *
 *   CREATE INDEX ... USING btree (((body ->> 'related_msg_id')))
 *     WHERE (body ? 'related_msg_id');
 *
 * A query may only use a partial index if the planner can prove the index covers every
 * row the query needs — which means the query must state the index's WHERE predicate.
 * Filtering on the indexed EXPRESSION alone is not enough. So a NOT EXISTS written as
 * just `e2.body->>'related_msg_id' = e1.msg_id` cannot use the index, and PostgreSQL
 * falls back to reading the entire table.
 *
 * This failure is SILENT: the query is correct and returns the right rows. Only the plan
 * is catastrophic. Measured 2026-08-03 against the live DB with EXPLAIN (ANALYZE,BUFFERS):
 *
 *   reply-deadline-sweep  before: 40,684 buffers / 156.9ms   (Hash Anti Join, seq-scanning
 *                                 all 86,722 'messages' rows to return ZERO rows)
 *                          after:     721 buffers /   8.96ms  (Nested Loop + partial index)
 *   allhive-broadcast-sweep before: 4,731,095 buffers / 13,312ms (Parallel Seq Scan, loops=600)
 *                          after:      3,341 buffers /    25.9ms
 *
 * i.e. 56x and 1,416x fewer buffers respectively.
 *
 * The added clause is LOGICALLY REDUNDANT — `body->>k` is NULL when the key is absent and
 * NULL never equals a msg_id — which is exactly why a future reader will be tempted to
 * delete it as noise. It is load-bearing for the PLAN, not for the RESULT. Empirically
 * confirmed redundant at the time of writing:
 *   SELECT count(*) FROM harness_shared.coord_event_log
 *    WHERE body->>'related_msg_id' IS NOT NULL AND NOT (body ? 'related_msg_id');  -- 0
 *
 * Sibling guard, same defect class on a different table: payload-object-shape-guard.test.ts
 * (WI-6993), whose "keeps the bare payload->'plan_item' predicate the partial index needs"
 * case is the work_items analogue of this one.
 *
 * This is a source/migration-text assertion rather than a live-PG one, matching the
 * convention of payload-object-shape-guard.test.ts: the plan regression is a property of
 * the SQL text, and asserting it here catches a reintroduction at edit time rather than
 * hours later at the fleet gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const MIGRATION = join(REPO_ROOT, 'libs/papercusp/libs/db/sql/691-coord-event-log-related-msg-id-idx.sql');

const INDEX = 'coord_event_log_related_msg_id_idx';

/**
 * Sources whose `related_msg_id` anti-join depends on stating the partial predicate.
 * Repo-relative; a path that stops existing fails loudly here rather than silently
 * dropping its guard (a renamed file must be re-listed, not forgotten).
 */
const GUARDED_SWEEPS = [
  'packages/operator-core/lib/agent-tools/coordination/reply-deadline-sweep.ts',
  'packages/operator-core/lib/agent-tools/coordination/allpot-broadcast-sweep.ts',
  'packages/operator-core/lib/agent-tools/coordination/delivery-ladder-sweep.ts',
];

/** Strip SQL (`--`) and JS (`//`, block) comments so a comment ABOUT the clause never satisfies the check. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(?:--|\/\/).*$/gm, '')
    .replace(/(?:--|\/\/).*$/gm, '');
}

describe('migration 691 partial index (EI-19448297390091252)', () => {
  it('still declares the PARTIAL predicate the sweep queries are written against', () => {
    const sql = stripComments(readFileSync(MIGRATION, 'utf8')).replace(/\s+/g, ' ');

    expect(sql, `migration 691 no longer names ${INDEX}`).toContain(INDEX);
    // If this index is ever made NON-partial, the guard clauses in the sweeps become
    // genuinely redundant and this whole file should be deleted along with them.
    expect(
      sql,
      `${INDEX} is no longer PARTIAL on (body ? 'related_msg_id'). If that was deliberate, ` +
        'the guard clauses in the sweep queries are now dead weight and both should be ' +
        'removed together — but if it was accidental, every query written against the ' +
        'partial form silently keeps its clause for no reason.',
    ).toMatch(/WHERE \(?\s*body \?\s*'related_msg_id'\s*\)?/i);
  });
});

describe('the coord sweeps stay compatible with the partial index', () => {
  it.each(GUARDED_SWEEPS)('%s states the partial predicate alongside the equality', (rel) => {
    const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8')).replace(/\s+/g, ' ');

    // Only meaningful for a file that actually filters on the indexed expression.
    expect(src, `${rel} no longer filters on body->>'related_msg_id' — re-scope this guard`).toMatch(
      /body->>'related_msg_id'\s*=/i,
    );

    expect(
      src,
      `${rel} filters on body->>'related_msg_id' WITHOUT the accompanying ` +
        "`body ? 'related_msg_id'` clause. That clause looks redundant (body->>key is NULL " +
        'when the key is absent, so the equality can never match) but it is REQUIRED for the ' +
        `planner to use ${INDEX}, which is PARTIAL. Without it this anti-join reads the whole ` +
        'table: measured 40,684 -> 721 buffers (56x) and 4,731,095 -> 3,341 buffers (1,416x) ' +
        'on the two sweeps. Re-add the clause rather than "simplifying" it away.',
    ).toMatch(/body \?\s*'related_msg_id'/i);
  });

  it('keeps the guard clause BEFORE the equality so the index is chosen, not just permitted', () => {
    // Ordering is not semantically required by SQL, but keeping them adjacent and in this
    // order is what makes the pairing obvious to the next reader — the two clauses are one
    // idea, and separating them is how the guard gets deleted as "a stray duplicate".
    for (const rel of GUARDED_SWEEPS) {
      const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8')).replace(/\s+/g, ' ');
      const guardAt = src.search(/body \?\s*'related_msg_id'/i);
      const equalityAt = src.search(/body->>'related_msg_id'\s*=/i);
      expect(guardAt, `${rel}: guard clause missing`).toBeGreaterThan(-1);
      expect(equalityAt, `${rel}: equality missing`).toBeGreaterThan(-1);
      expect(guardAt, `${rel}: the 'body ? related_msg_id' guard should sit immediately before the equality`).toBeLessThan(
        equalityAt,
      );
    }
  });
});
