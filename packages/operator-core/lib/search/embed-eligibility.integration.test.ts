/**
 * The LIVE-SQL half of the session_turns embedding ELIGIBILITY contract (P-028,
 * semantic-search-fingerprint-coverage-2026-08-03).
 *
 * `embed-backfill.test.ts` next door asserts PROPERTIES OF THE STRING — that
 * every target's `bodySql` caps its input with `left(…, N<=2000)`. Nothing
 * executes it. That gap matters here specifically, because eligibility is a
 * `CASE` expression whose semantics are entirely in SQL: a change that is
 * well-formed as a string, passes every string-shaped assertion, and silently
 * admits or drops tens of thousands of rows is exactly the failure this file
 * exists to catch. The predicate is also load-bearing twice over — it is the
 * sweep's row filter AND (via `eligiblePredicateSql`) the DENOMINATOR of P-027's
 * coverage alarm — so a drift here quietly moves a metric people trust.
 *
 * WHY THESE CASES: the floor used to be a flat `length(text) >= 80`, which
 * dropped 71,026 rows (17.4% of the table, measured 2026-08-03). Its stated
 * rationale — "short acks are noise" — over-applied: a short turn is very often
 * a terse OWNER QUESTION, and the dropped set literally contained "which one was
 * about the theory of mind work?" (44 chars), the query class the plan was
 * opened to fix. The discriminator is `speaker`, not length alone: among turns
 * 20-79 chars, 5.4% of user turns are questions vs 0.19% of assistant turns.
 * Each `it` below pins one edge of that decision so it cannot be quietly undone.
 *
 * The predicate is IMPORTED, never restated — a copy here would drift from the
 * sweep the moment anyone edited `TARGETS`, which is the same class of bug one
 * layer down.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';

import { TARGETS, eligiblePredicateSql } from './embed-backfill';

const SESSION_TURNS = 'harness_shared.session_turns';

describe('session_turns embedding eligibility (live SQL)', () => {
  let sql: postgres.Sql;
  /** The production predicate, executed verbatim. */
  let predicate: string;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'embed-eligibility.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });

    const target = TARGETS.find((t) => t.table === SESSION_TURNS);
    if (!target) throw new Error(`no ${SESSION_TURNS} target in TARGETS`);
    predicate = eligiblePredicateSql(target);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /**
   * Evaluate the REAL predicate against a synthetic row. `SELECT <predicate>`
   * over a one-row VALUES list, so the expression is exercised by Postgres
   * exactly as the sweep's WHERE clause would exercise it — including operator
   * precedence, which is where a hand-checked `A OR B AND C` goes wrong.
   */
  const isEligible = async (text: string, speaker: string): Promise<boolean> => {
    const rows = await sql.unsafe<Array<{ ok: boolean }>>(
      `SELECT (${predicate}) AS ok FROM (VALUES ($1::text, $2::text)) AS t(text, speaker)`,
      [text, speaker],
    );
    return rows[0].ok;
  };

  it('admits a terse OWNER QUESTION — the regression P-028 exists to prevent', async () => {
    // The literal turn found in the dropped set on 2026-08-03. 44 chars: under
    // the old flat floor of 80, so it was unembeddable and therefore invisible
    // to the semantic leg no matter how complete coverage got.
    expect(await isEligible('which one was about the theory of mind work?', 'user')).toBe(true);
  });

  it('still excludes a short ASSISTANT turn — the noise the floor was written for', async () => {
    // Same length band as the question above. If this ever returns true the
    // speaker discriminator has been lost and ~54k assistant acks are back in.
    expect(await isEligible('Understood. Running the tests now to confirm.', 'assistant')).toBe(
      false,
    );
  });

  it('excludes sub-20-char turns in EITHER voice (acks are acks in both)', async () => {
    expect(await isEligible('ok', 'user')).toBe(false);
    expect(await isEligible('yes continue', 'user')).toBe(false);
    expect(await isEligible('Done.', 'assistant')).toBe(false);
  });

  it('admits any turn at or above the 80-char floor regardless of speaker', async () => {
    const long = 'x'.repeat(80);
    expect(await isEligible(long, 'assistant')).toBe(true);
    expect(await isEligible(long, 'user')).toBe(true);
  });

  it('is exclusive at the boundaries, not inclusive-by-accident', async () => {
    // 79 chars from an assistant is the last excluded length; 19 from a user is
    // the last excluded length on the other arm. Off-by-one here silently moves
    // tens of thousands of rows, so both edges are pinned.
    expect(await isEligible('a'.repeat(79), 'assistant')).toBe(false);
    expect(await isEligible('a'.repeat(80), 'assistant')).toBe(true);
    expect(await isEligible('a'.repeat(19), 'user')).toBe(false);
    expect(await isEligible('a'.repeat(20), 'user')).toBe(true);
  });

  it('caps the embedded body at 2000 chars even for an admitted long turn', async () => {
    // The eligibility predicate is `length(bodySql) > 0`, so this asserts the
    // BODY the sweep would send to the embedder, not just admission.
    const target = TARGETS.find((t) => t.table === SESSION_TURNS)!;
    const rows = await sql.unsafe<Array<{ len: number }>>(
      `SELECT length(${target.bodySql}) AS len FROM (VALUES ($1::text, $2::text)) AS t(text, speaker)`,
      ['y'.repeat(8000), 'assistant'],
    );
    expect(Number(rows[0].len)).toBe(2000);
  });

  it('produces an EMPTY body (not NULL) for an excluded row', async () => {
    // The sweep excludes via `length(bodySql) > 0`. A NULL would make that
    // predicate NULL rather than false — still excluded, but it would also make
    // the coverage denominator NULL-propagate, so the '' branch is load-bearing.
    const target = TARGETS.find((t) => t.table === SESSION_TURNS)!;
    const rows = await sql.unsafe<Array<{ body: string | null }>>(
      `SELECT (${target.bodySql}) AS body FROM (VALUES ($1::text, $2::text)) AS t(text, speaker)`,
      ['nope', 'assistant'],
    );
    expect(rows[0].body).toBe('');
  });
});
