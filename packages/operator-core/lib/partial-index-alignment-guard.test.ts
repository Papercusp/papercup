/**
 * partial-index-alignment-guard.test.ts — WI-8806
 *
 * Proves `scripts/check-partial-index-alignment.mjs` DISCRIMINATES. A lint nobody has
 * watched fail is not a guard: it is a script that has only ever agreed with the tree.
 * Every case below therefore asserts a DIFFERENCE — vulnerable flagged, fixed clean —
 * rather than asserting the current tree happens to pass.
 *
 * The lint catches queries that filter a PARTIAL index's indexed expression while omitting
 * its predicate, so the planner cannot use the index and silently falls back to a full
 * table scan. Four instances measured on the live DB (EXPLAIN ANALYZE, BUFFERS):
 *
 *   reply-deadline-sweep       40,684 ->   721 buffers    (56x)
 *   allhive-broadcast-sweep  4,731,095 -> 3,341 buffers (1,416x)
 *   repliedMsgIdsBatch          40,717 ->   113 buffers   (360x)  111.6ms -> 2.4ms
 *   getTaskByBashJobId             197 ->     1 buffer    (197x)    4.93ms -> 0.042ms
 *
 * The last two were found BY THIS LINT, not by hand. The first two were found by hand,
 * one at a time — which is the argument for the lint.
 *
 * The false-negative cases (COALESCE, IS NULL, neighbouring-line guard) are not
 * hypothetical politeness: each is a real site in this repo that a naive line-scoped or
 * semantics-blind version of this check flagged wrongly while it was being written.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  extractSqlTemplates,
  findMisalignedUses,
  parseGuardedIndexes,
} from '../../../scripts/check-partial-index-alignment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-partial-index-alignment.mjs');

const RELATED = { col: 'body', key: 'related_msg_id' };

/** Run the lint's detector over one statement, as the driver does. */
function flag(sqlText: string, idx = RELATED): number[] {
  const [tpl] = extractSqlTemplates(`sql\`${sqlText}\``);
  expect(tpl, 'test fixture did not parse as a sql template').toBeTruthy();
  return findMisalignedUses(tpl!.text, idx);
}

describe('the index set is DERIVED from the schema, not hardcoded', () => {
  const indexes = parseGuardedIndexes(
    readFileSync(join(REPO_ROOT, 'libs/papercusp/libs/db/src/schema/generated.ts'), 'utf8'),
  );

  it('finds the known partial value-and-presence indexes', () => {
    const names = indexes.map((i) => i.index);
    expect(names).toContain('coord_event_log_related_msg_id_idx');
    expect(names).toContain('coord_event_log_reply_deadline');
    expect(names).toContain('task_ledger_bash_job_id_idx');
  });

  it('EXCLUDES a partial index whose indexed expression is not the guarded key', () => {
    // coord_event_log_conditions_idx is PARTIAL on (body ? 'condition_key' OR ...) but
    // indexes (workspace_id, id) -- plain columns. A query filtering those columns is not
    // in this lint's class, and flagging it would be a false positive on a very hot index
    // (132,515 scans at the time of writing, i.e. demonstrably working).
    expect(indexes.map((i) => i.index)).not.toContain('coord_event_log_conditions_idx');
  });

  it('pairs each index with the column and key its queries must state', () => {
    const bash = indexes.find((i) => i.index === 'task_ledger_bash_job_id_idx');
    expect(bash).toMatchObject({ col: 'detail', key: 'bashJobId' });
  });
});

describe('discrimination: the vulnerable shape fails, the fixed shape passes', () => {
  it('FLAGS an equality on the indexed expression with no presence guard', () => {
    expect(flag(`SELECT 1 FROM t WHERE body->>'related_msg_id' = 'm-1'`)).toHaveLength(1);
  });

  it('PASSES once the presence guard is stated', () => {
    expect(
      flag(`SELECT 1 FROM t WHERE body ? 'related_msg_id' AND body->>'related_msg_id' = 'm-1'`),
    ).toHaveLength(0);
  });

  it('FLAGS the anti-join shape that cost 1,416x on allhive-broadcast-sweep', () => {
    expect(
      flag(`SELECT 1 FROM e1 WHERE NOT EXISTS (
              SELECT 1 FROM coord_event_log e2 WHERE e2.body->>'related_msg_id' = e1.msg_id)`),
    ).toHaveLength(1);
  });

  it('FLAGS an = ANY(...) filter -- the repliedMsgIdsBatch shape (360x)', () => {
    expect(flag(`SELECT 1 FROM t WHERE body->>'related_msg_id' = ANY('{a,b}')`)).toHaveLength(1);
  });

  it('FLAGS a reversed join operand (indexed expression on the RIGHT)', () => {
    expect(flag(`SELECT 1 FROM t JOIN u ON u.msg_id = t.body->>'related_msg_id'`)).toHaveLength(1);
  });

  it('FLAGS a cast comparison -- the reply-deadline shape', () => {
    expect(
      flag(`SELECT 1 FROM t WHERE (body->>'replyDeadlineAt')::bigint <= 123`, {
        col: 'body',
        key: 'replyDeadlineAt',
      }),
    ).toHaveLength(1);
  });
});

describe('statement scope, not line scope', () => {
  // The real false positive: sync-resolver's reply-chain CTE states the guard on the line
  // ABOVE the join it protects. A line-scoped check reported three violations there, all wrong.
  it('accepts a guard stated on a NEIGHBOURING line of the same statement', () => {
    expect(
      flag(`
        SELECT c.id FROM coord_event_log c
          JOIN chain ON c.body ->> 'related_msg_id' = chain.msg_id
         WHERE c.body ? 'related_msg_id' AND chain.depth < 8`),
    ).toHaveLength(0);
  });

  it('accepts a guard whose alias differs -- alias-insensitive by design', () => {
    expect(
      flag(`SELECT 1 FROM coord_event_log e2 WHERE e2.body ? 'related_msg_id'
              AND e2.body->>'related_msg_id' = 'm-1'`),
    ).toHaveLength(0);
  });
});

describe('semantic exclusions -- adding the guard would CHANGE these results', () => {
  it('does NOT flag a COALESCE wrapper, which deliberately admits key-absent rows', () => {
    // escalation-log-gc.ts: COALESCE(body->>'related_msg_id', msg_id) IN (...) wants the
    // rows WITHOUT the key. Adding the presence test would silently drop them.
    expect(
      flag(`SELECT 1 FROM e WHERE COALESCE(e.body->>'related_msg_id', e.msg_id) IN (SELECT x FROM f)`),
    ).toHaveLength(0);
  });

  it('does NOT flag IS NULL, which is not equivalent to the presence test', () => {
    // A key PRESENT with a JSON null value makes `body ? k` true while `body->>k` is NULL,
    // so these genuinely disagree -- unanswered-directed.ts documents exactly this case.
    expect(flag(`SELECT 1 FROM t WHERE body->>'related_msg_id' IS NULL`)).toHaveLength(0);
    expect(flag(`SELECT 1 FROM t WHERE body->>'related_msg_id' IS NOT NULL`)).toHaveLength(0);
  });

  it('does NOT flag a bare projection -- no comparison, so no index opportunity missed', () => {
    expect(flag(`SELECT body->>'related_msg_id' AS related_msg_id FROM t WHERE surface = 'messages'`)).toHaveLength(0);
  });
});

describe('comments cannot satisfy or trigger the check', () => {
  it('a comment MENTIONING the guard does not count as stating it', () => {
    // unanswered-directed.ts carries paragraphs naming these very expressions.
    expect(
      flag(`SELECT 1 FROM t
              -- we rely on body ? 'related_msg_id' here
             WHERE body->>'related_msg_id' = 'm-1'`),
    ).toHaveLength(1);
  });

  it('a commented-out comparison is not reported as a use', () => {
    expect(
      flag(`SELECT 1 FROM t
              -- WHERE body->>'related_msg_id' = 'm-1'
             WHERE surface = 'messages'`),
    ).toHaveLength(0);
  });
});

describe('line attribution survives interpolation', () => {
  it('reports the line of the offending comparison, not a drifted neighbour', () => {
    // `${...}` collapses to a shorter token, so naive offset arithmetic under-reports.
    const src = [
      'const q = sql`',
      "  SELECT 1 FROM t",
      "   WHERE workspace_id = ${aVeryLongInterpolatedExpressionName}",
      "     AND surface = ${anotherLongInterpolationHere}",
      "     AND body->>'related_msg_id' = ${id}",
      '`;',
    ].join('\n');
    const [tpl] = extractSqlTemplates(src);
    const hits = findMisalignedUses(tpl!.text, RELATED);
    expect(hits).toHaveLength(1);
    const line = src.slice(0, tpl!.srcIndex[hits[0]!]).split('\n').length;
    expect(line, 'offset map should point at the comparison line').toBe(5);
  });
});

describe('the tree is currently aligned (ratchet)', () => {
  it('the lint exits 0 on the repo as it stands', () => {
    // If this fails, a NEW misaligned query landed. Read the lint output: it names the
    // file, the missing clause and the index that becomes unusable without it.
    const out = execFileSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(out).toContain('[partial-index-alignment] OK');
  });
});
