/**
 * rung1-invalid-arg-ledger.integration.test.ts
 *
 * AUTO-BAR-R-9-P-011 RUNG 1, made DURABLE AND RERUNNABLE.
 *
 * R-9 bars an OUTCOME — "the per-tool invalid-argument rate shows no
 * TIER-ATTRIBUTABLE regression" — via an escalating evidence ladder. Rung 1 is
 * the chronological pre/post comparison over `harness_shared.tool_invocations`
 * across the compact-tier cutover, and D-026 recorded that it was taken and did
 * not alarm. But it was recorded only as PROSE in a plan decision, so
 * `plans:evaluate-spec-test-adequacy` rated R-9's traceability `unknown`:
 *
 *     lineage=unknown, lineageReason="no durable rerun anchor"
 *     suggestion: "Attach a durable testRunId, coverageEvidenceRef,
 *                  work-item/artifact/test-run reference, or durable file probe."
 *
 * This file IS that anchor: the rung-1 measurement as committed, rerunnable code.
 *
 * ── WHY PER-TOOL AND NOT THE AGGREGATE ───────────────────────────────────────
 * The aggregate rate FELL across the cutover (1.105% -> 0.822%), which reads as
 * reassuring and is how rung 1 was originally summarised. It is the wrong
 * instrument, for two independent reasons:
 *
 *  1. R-9 is phrased PER-TOOL. An aggregate can hide a per-tool regression.
 *  2. The aggregate is dominated by VOLUME MIX, not by argument correctness.
 *     Measured over the fixed window below, `capability:bash` went 385 -> 2727
 *     invocations at a low error rate, which drags the pooled rate down on its
 *     own. Meanwhile several individual tools moved UP: coord:send
 *     16.51% -> 20.97%, tools:invoke 0.23% -> 0.44%, code:run 0.00% -> 0.41%.
 *     Pooling a mix that shifted is a Simpson's-paradox shape: the pooled
 *     direction and the per-stratum direction genuinely disagree.
 *
 * So this test stratifies by tool, and the aggregate is reported as CONTEXT ONLY,
 * never as the verdict.
 *
 * ── WHAT THIS CAN AND CANNOT ESTABLISH ───────────────────────────────────────
 * D-026 labelled rung 1 CONFOUNDED by model/scenario/fleet drift, and that label
 * is load-bearing rather than decorative. Across this window the fleet's tool
 * mix, active agents and models all changed. A non-alarm here therefore means
 * "rung 1 did not detect a regression", NOT "there is no regression". Only rung 3
 * (the randomized live split behind PAPERCUSP_CLAUDE_FULL_SEED) could establish
 * the stronger claim, and R-9 deliberately does not pay for it unless a cheaper
 * rung alarms. Do not upgrade a green run here into an absence claim.
 *
 * ── WINDOW ───────────────────────────────────────────────────────────────────
 * FIXED and symmetric, never `now()`-relative: a moving window is not
 * reproducible, and an anchor that answers differently on every run is not an
 * anchor. Both halves are closed, so this measurement is deterministic forever.
 *
 * ── FLAKE POLICY ─────────────────────────────────────────────────────────────
 * Integration tier, and it reads the LIVE harness ledger (a testcontainer
 * fixture has no invocation history, so the fixture pattern cannot serve this).
 * It SKIPS loudly when the ledger is unreachable and FAILS only on a measured
 * alarm. "Could not measure" and "measured a regression" are never conflated —
 * which is the same reporting defect this plan exists to remove.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';

const WORKSPACE_ID = 'papercusp-workspace';
const HARNESS_SLUG = 'papercusp';

/** Compact tool-definition tier cutover (D-018). */
const CUTOVER = '2026-09-21T23:46:45Z';
const WINDOW_START = '2026-09-21T11:46:45Z'; // cutover - 12h
const WINDOW_END = '2026-09-22T11:46:45Z'; // cutover + 12h

const INVALID_CODES = ['invalid_input', 'invalid_args'];

/**
 * ALARM RULE — conjunctive on purpose. Per-tool rates over a 12h window are
 * noisy in the tail (several tools moved 0 -> 1 or 1 -> 3 invocations), and a
 * rule that fires on those would cry wolf and then be deleted by whoever next
 * hit it. A rung-1 alarm must be worth escalating to rung 3, so it requires
 * volume AND a large relative move AND a material absolute move, together.
 */
const MIN_POST_VOLUME = 200;
const ALARM_RELATIVE = 2.0; // post rate >= 2x pre rate
const ALARM_ABSOLUTE_PP = 2.0; // AND at least +2 percentage points

type Row = {
  tool_name: string;
  pre_n: number;
  pre_bad: number;
  post_n: number;
  post_bad: number;
};

describe('AUTO-BAR-R-9-P-011 rung 1 — per-tool invalid-argument ledger across the compact-tier cutover', () => {
  let sql: Sql | null = null;
  let rows: Row[] = [];
  let skipReason = '';

  beforeAll(async () => {
    try {
      sql = postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 5, connect_timeout: 10 });
      const result = await sql<Row[]>`
        WITH scoped AS (
          SELECT CASE WHEN invoked_at >= ${CUTOVER}::timestamptz THEN 'post' ELSE 'pre' END AS era,
                 tool_name,
                 error_code
            FROM harness_shared.tool_invocations
           WHERE workspace_id = ${WORKSPACE_ID}
             AND harness_slug = ${HARNESS_SLUG}
             AND invoked_at >= ${WINDOW_START}::timestamptz
             AND invoked_at <  ${WINDOW_END}::timestamptz
        )
        SELECT tool_name,
               count(*) FILTER (WHERE era = 'pre')::int  AS pre_n,
               count(*) FILTER (WHERE era = 'pre'  AND error_code = ANY(${INVALID_CODES}))::int AS pre_bad,
               count(*) FILTER (WHERE era = 'post')::int AS post_n,
               count(*) FILTER (WHERE era = 'post' AND error_code = ANY(${INVALID_CODES}))::int AS post_bad
          FROM scoped
         GROUP BY tool_name
      `;
      rows = [...result];
    } catch (err) {
      skipReason = String(err).slice(0, 300);
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
  });

  it('rung 1 does not alarm: no tool shows a large, high-volume invalid-argument regression', (ctx) => {
    if (!rows.length) {
      ctx.skip(`harness ledger unreachable or window empty — rung 1 could NOT be measured. ${skipReason}`);
      return;
    }

    const preTotal = rows.reduce((a, r) => a + r.pre_n, 0);
    const postTotal = rows.reduce((a, r) => a + r.post_n, 0);
    const preBad = rows.reduce((a, r) => a + r.pre_bad, 0);
    const postBad = rows.reduce((a, r) => a + r.post_bad, 0);

    // POSITIVE CONTROLS. Without these a shrunken or mis-scoped window returns
    // few/empty rows, every per-tool comparison is vacuously fine, and the test
    // passes while having measured nothing — the precise false-green this plan
    // is about. An absence claim needs a positive control.
    expect(preTotal, 'positive control: PRE window has no invocations — window or tenant scope is wrong').toBeGreaterThan(1_000);
    expect(postTotal, 'positive control: POST window has no invocations — window or tenant scope is wrong').toBeGreaterThan(1_000);
    expect(rows.length, 'positive control: implausibly few distinct tools — the ledger query is not measuring the fleet').toBeGreaterThan(50);

    const pct = (bad: number, n: number) => (n > 0 ? (100 * bad) / n : 0);

    const alarms = rows
      .filter((r) => r.post_n >= MIN_POST_VOLUME)
      .map((r) => {
        const prePct = pct(r.pre_bad, r.pre_n);
        const postPct = pct(r.post_bad, r.post_n);
        return { ...r, prePct, postPct, deltaPP: postPct - prePct, ratio: prePct > 0 ? postPct / prePct : Infinity };
      })
      .filter((r) => r.deltaPP >= ALARM_ABSOLUTE_PP && r.ratio >= ALARM_RELATIVE);

    // Always report the movers, so a passing run is still informative rather
    // than a bare green that tells a reader nothing.
    const movers = rows
      .filter((r) => r.post_n >= MIN_POST_VOLUME)
      .map((r) => ({ t: r.tool_name, d: pct(r.post_bad, r.post_n) - pct(r.pre_bad, r.pre_n), pre: pct(r.pre_bad, r.pre_n), post: pct(r.post_bad, r.post_n) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 5);

    const context =
      `aggregate (CONTEXT ONLY, not the verdict — volume mix shifted): ` +
      `pre ${preBad}/${preTotal} = ${pct(preBad, preTotal).toFixed(3)}% -> ` +
      `post ${postBad}/${postTotal} = ${pct(postBad, postTotal).toFixed(3)}%. ` +
      `top per-tool movers: ` +
      movers.map((m) => `${m.t} ${m.pre.toFixed(2)}%->${m.post.toFixed(2)}% (${m.d >= 0 ? '+' : ''}${m.d.toFixed(2)}pp)`).join('; ');

    // eslint-disable-next-line no-console
    console.log(`[R-9 rung 1] window ${WINDOW_START}..${WINDOW_END} cutover ${CUTOVER}\n[R-9 rung 1] ${context}`);

    expect(
      alarms.map((a) => `${a.tool_name}: ${a.prePct.toFixed(2)}% -> ${a.postPct.toFixed(2)}% on n=${a.post_n}`),
      `RUNG 1 ALARMED. Per R-9 this escalates to rung 3 (the time-boxed randomized live split behind ` +
        `PAPERCUSP_CLAUDE_FULL_SEED, with a stated N and end date) — it does NOT by itself prove a ` +
        `tier-attributable regression, because this comparison is confounded by model/scenario/fleet drift. ${context}`,
    ).toEqual([]);
  });
});
