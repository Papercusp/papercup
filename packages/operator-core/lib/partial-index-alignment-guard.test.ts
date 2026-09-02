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
 *   allpot-broadcast-sweep   4,731,095 -> 3,341 buffers (1,416x)
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

/**
 * The scope boundary is a MEASURED conclusion, not unfinished work — and the shapes it
 * excludes are the ones a widening edit picks up FIRST, so they are pinned here against
 * synthetic fixtures rather than against whatever the live schema happens to hold.
 *
 * `harness_shared` has ~194 partial indexes and this lint claims 3 of them. That reads as
 * a 191-index gap and was filed as one (EI-19452064467168046). Both ways to close it were
 * measured and both are worse than staying narrow:
 *
 *   D-031  the syntactic rule does not generalise. Stating `col ? 'k'` in a comparison is
 *          semantically free; stating `verb <> ''` is not. Aligning a real query to
 *          `tool_usage_rollup_verb_idx` as this lint's rule would demand measured 27%
 *          SLOWER while silently dropping 26% of the result rows.
 *   D-035  the `idx_scan = 0` shortcut does not generalise either. Of 54 zero-match partial
 *          indexes, ~40 KB is the real upside — while `arc_running_idx` matches zero rows
 *          and is the 8th most-scanned index in the database (45.2M scans).
 *
 * Both on plan `db-performance-remediation-2026-07-26`. Widening is ALLOWED; it owes the
 * D-031 gate (flag on syntax, never prescribe without a measured plan read). If you are
 * widening deliberately, change these expectations deliberately — do not delete them.
 */
describe('the scope boundary holds: shapes outside the value-and-presence slice stay OUT', () => {
  /** One generated-schema line in drizzle's real emitted shape. */
  const schemaLine = (name: string, expr: string, where: string) =>
    `\tindex("${name}").using("btree", ${expr}).where(sql\`${where}\`),`;

  const names = (src: string) => parseGuardedIndexes(src).map((i: { index: string }) => i.index);

  it('SELECTS the value-and-presence shape — so the exclusions below are not vacuous', () => {
    expect(
      names(schemaLine('fixture_aligned_idx', "sql`((body ->> 'k'::text))`", "(body ? 'k'::text)")),
    ).toEqual(['fixture_aligned_idx']);
  });

  it('EXCLUDES an ordinary-column predicate over an indexed jsonb value (the D-035 majority)', () => {
    // `WHERE ended_at IS NULL` is the commonest partial shape in harness_shared, and stating
    // it is NOT semantically free: a query that wants ended rows must omit it. A widening
    // that "also handles column predicates" selects this line first.
    expect(
      names(
        schemaLine('fixture_column_pred_idx', "sql`((body ->> 'k'::text))`", '(ended_at IS NULL)'),
      ),
    ).toEqual([]);
  });

  it('EXCLUDES a presence predicate guarding a DIFFERENT key than the expression reads', () => {
    // This is the `readsValue` gate itself. The planner cannot derive `body ? 'b'` from a
    // comparison on `body ->> 'a'` any more than the query can, so demanding the clause
    // would not make the index usable — it would just add a result-changing filter.
    expect(
      names(schemaLine('fixture_key_mismatch_idx', "sql`((body ->> 'a'::text))`", "(body ? 'b'::text)")),
    ).toEqual([]);
  });

  it('EXCLUDES a presence predicate whose index is over plain columns', () => {
    // The live counterpart is coord_event_log_conditions_idx (asserted against the real
    // schema above). Pinned synthetically too, so dropping that index cannot quietly turn
    // the real-schema assertion into one that passes for the wrong reason.
    expect(
      names(
        schemaLine(
          'fixture_plain_column_idx',
          'table.workspaceId.asc().nullsLast().op("text_ops")',
          "((surface = 'messages'::text) AND (body ? 'condition_key'::text))",
        ),
      ),
    ).toEqual([]);
  });

  it('EXCLUDES a NON-partial index of the indexed-value shape', () => {
    // No `.where(...)` at all means no predicate to omit, so there is nothing to align.
    expect(
      names('\tindex("fixture_total_idx").using("btree", sql`((body ->> \'k\'::text))`),'),
    ).toEqual([]);
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

  it('FLAGS the anti-join shape that cost 1,416x on allpot-broadcast-sweep', () => {
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

  /**
   * EI-20073035509369492 — the private `--`-only stripper was replaced by the shared SQL mask.
   * Both directions below were MEASURED against the old implementation, so each assertion is a
   * falsifier: revert the stripper and the expected number changes. A no-diff test would have
   * proved nothing, since a stripper that silently no-ops returns what a clean corpus returns.
   */
  it('a BLOCK comment cannot trigger the check (old `--`-only stripper: 1 false positive)', () => {
    // Measured: with block-comment content left live, the detector reports 1 here.
    expect(
      flag(`SELECT 1 FROM t /* body ->> 'related_msg_id' = $1 */ WHERE x = 1`),
    ).toHaveLength(0);
  });

  it('a `--` inside a quoted identifier is NOT a comment (old stripper blanked the rest of the line)', () => {
    // The dangerous direction: the old regex blanked from `--` to end of line, erasing live SQL.
    // Erasing live SQL can delete the presence guard itself and turn an aligned query into a
    // reported violation — or, as here, delete the comparison and hide a real one. Measured 0
    // under the old stripper, 1 under the shared mask.
    expect(
      flag(`SELECT 1 FROM t WHERE "weird--name" = 1 AND body ->> 'related_msg_id' = $1`),
    ).toHaveLength(1);
  });
});

describe('the sql`` tag is matched against MASKED source, so prose cannot mint a statement', () => {
  /**
   * Measured 2026-08-10: the bare tag regex fires on the word `sql` in a markdown code span
   * inside a doc comment, because the span's CLOSING backtick supplies the backtick it wants.
   * gc-plan-runs.ts says "`sql` is a seam." and that minted a 427-char "SQL statement" made of
   * the file's imports and an interface. Corpus-wide: 61 phantom statements in 33 files.
   */
  const PROSE = [
    '/**',
    ' * Keeps the ledger row. `sql` is a seam.',
    ' */',
    "import { getOrgPg } from '@papercusp/db-org';",
    'export const KEEP_LAST_DEFAULT = 90;',
    'const q = other`x`;',
  ].join('\n');

  it('the raw tag regex DOES fire on that prose — otherwise this test is vacuous', () => {
    // Guards the guard: if the regex stops matching, the assertion below passes for the wrong
    // reason and silently stops testing anything.
    expect(/\bsql\s*(?:<[^`>]*>)?\s*`/.test(PROSE)).toBe(true);
  });

  it('extracts NO template from it', () => {
    expect(extractSqlTemplates(PROSE, 'gc-plan-runs.ts')).toHaveLength(0);
  });

  it('still extracts a real adjacent template in the same file', () => {
    // The mask must not cost real coverage: a genuine tag after the prose is still found.
    const src = `${PROSE}\nconst rows = await sql\`SELECT body->>'related_msg_id' FROM t\`;`;
    const tpls = extractSqlTemplates(src, 'gc-plan-runs.ts');
    expect(tpls).toHaveLength(1);
    expect(tpls[0]!.text).toContain('SELECT');
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

describe('nested sql fragments inside interpolations stay in the parent statement', () => {
  it('does not flag a child comparison when the parent supplies the presence guard', () => {
    const src =
      "const q = sql`SELECT 1 FROM t WHERE body ? 'related_msg_id' AND ${condition ? sql`body->>'related_msg_id' = ${id}` : sql``}`;";
    const templates = extractSqlTemplates(src, 'nested-fragment.ts');
    expect(templates).toHaveLength(1);
    expect(templates[0]!.text).toContain("body->>'related_msg_id'");
    expect(findMisalignedUses(templates[0]!.text, RELATED)).toHaveLength(0);
  });

  it('finds a child comparison that the parent does not guard and maps it to the child line', () => {
    const src = [
      'const q = sql`SELECT 1 FROM t',
      "  WHERE ${condition ? sql`body->>'related_msg_id' = ${id}` : sql``}",
      '`;',
    ].join('\n');
    const templates = extractSqlTemplates(src, 'nested-fragment.ts');
    expect(templates).toHaveLength(1);
    const hits = findMisalignedUses(templates[0]!.text, RELATED);
    expect(hits).toHaveLength(1);
    expect(src.slice(0, templates[0]!.srcIndex[hits[0]!]!).split('\n')).toHaveLength(2);
  });

  it('does not mistake a similarly named tagged template for a nested sql fragment', () => {
    const src =
      "const q = sql`SELECT 1 FROM t WHERE ${condition ? not_sql`body->>'related_msg_id' = ${id}` : sql``}`;";
    const templates = extractSqlTemplates(src, 'nested-fragment.ts');
    expect(templates).toHaveLength(1);
    expect(findMisalignedUses(templates[0]!.text, RELATED)).toHaveLength(0);
  });
});

describe('the self-reference exclusion stays NARROW', () => {
  // This lint necessarily scans a tree containing its own test, whose fixtures are
  // deliberately-vulnerable SQL. It excludes files that IMPORT it. The tempting future
  // "simplification" is to skip *.test.ts wholesale -- which would have silently dropped
  // a genuine find (store.integration.test.ts had drifted from the production predicate
  // set it claims to pin). Pin the narrow rule so that shortcut fails loudly.
  const src = readFileSync(SCRIPT, 'utf8');

  it('skips only files that reference this lint by name', () => {
    expect(src).toContain('SELF_BASENAME');
  });

  it('does NOT blanket-exclude test files from scanning', () => {
    const skipsAllTests = /if\s*\(\s*\/\\?\.test\\?\.ts\$?\/.test\([^)]*\)\s*\)\s*continue/.test(src);
    expect(
      skipsAllTests,
      'the lint appears to skip all *.test.ts files. A test whose raw SQL has drifted from ' +
        'the production shape it pins is a real finding -- exclude this lint\'s own fixtures ' +
        'by self-reference instead.',
    ).toBe(false);
  });
});

describe('the tree is currently aligned (ratchet)', () => {
  it('the lint exits 0 on the repo as it stands', () => {
    // If this fails, a NEW misaligned query landed. Read the lint output: it names the
    // file, the missing clause and the index that becomes unusable without it.
    const out = execFileSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(out).toContain('[partial-index-alignment] OK');
  });
});
