/**
 * watchdog-red-test-infra-enoent.integration.test.ts — EI-20770395938680312.
 *
 * BUG: when the vitest/vite-node transform cache under /tmp is wiped mid-run,
 * every not-yet-loaded test file instantly "fails" with duration_ms = 0 and an
 * identical `ENOENT: no such file or directory, open '/tmp/<root>/{ssr,client}/…`
 * tail. The test never executed — it is an infra fault carrying zero code signal.
 * `fetchRedTestRows` counted those rows like any other red, so ONE wiped cache
 * poisoned 9,246 rows across 4,963 files in a single 45-minute run (2026-08-18)
 * and manufactured four bogus `Test failing repeatedly:` major work-items against
 * files that were green both before and after the window.
 *
 * FIX: exclude a fail/error row that has BOTH duration_ms = 0 AND the tmp-cache
 * ENOENT tail, from BOTH the fail count and the `rn = 1` freshness check (the
 * poisoned row shares the real test's path, so leaving it in would also mask
 * which run is the newest genuine one).
 *
 * The two conjuncts are separately necessary, and the controls below encode the
 * measurement that proved it over 30 days of `harness_shared.test_runs`:
 *   - duration_ms = 0 alone would ALSO swallow 648 real rows / 440 files whose
 *     tail is an ordinary env break ('afterAll is not defined');
 *   - the ENOENT tail alone would suppress 3 real assertion failures / 2 files
 *     whose own output merely quotes that string.
 * Either half on its own therefore turns a control below red — which is the
 * point of keeping all three.
 *
 * Real Postgres via the shared testcontainer (Docker required), a fresh database
 * per file with a minimal hand-rolled test_runs table — same pattern as the
 * sibling watchdog-red-test-scratch-config.integration.test.ts.
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/harness/improvements/watchdog-red-test-infra-enoent.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { fetchRedTestRows } from './watchdog';

let db: FreshPgDb;

/** The exact tail shape a wiped vite-node transform cache produces. */
const ENOENT_TAIL =
  "ENOENT: no such file or directory, open '/tmp/mHiyI31YP2gt3Bxy_zzOg/ssr/a840d7df4b7ecb7bd8c054ce0820018df96d7351'";

const fetch = async () =>
  fetchRedTestRows(db.sql as unknown as Parameters<typeof fetchRedTestRows>[0], {
    redTestWindowHours: 6,
    redTestMinFails: 3,
  });

beforeAll(async () => {
  db = await createFreshPgDb('redtest-infra-enoent');

  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.test_runs (
      id bigint generated always as identity primary key,
      file_path text NOT NULL,
      framework text,
      status text NOT NULL,
      duration_ms bigint,
      started_at timestamptz,
      finished_at timestamptz,
      output_tail text,
      run_group_id text,
      source text,
      branch text,
      commit_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      harness_slug text,
      workspace_id text,
      is_scratch_config boolean NOT NULL DEFAULT false
    )
  `);

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  const rows: Array<{
    filePath: string;
    status: string;
    startedAt: Date;
    durationMs: number;
    tail: string | null;
  }> = [
    // THE live repro (EI-20770382118019284 / EI-20770384048873414): a file with a
    // clean history whose only recent "failures" are zero-duration tmp-cache
    // ENOENTs, with the poisoned rows NEWEST — the state the watchdog actually
    // ticks in right after a cache wipe, and the only ordering that exercises
    // this filter at all.
    //
    // ⚠ The poisoned rows MUST be the most recent runs. If a later green run is
    // appended, `fetchRedTestRows`'s pre-existing `rn = 1` freshness check
    // ("latest run in the window is still red") already excludes the file on its
    // own, and this test passes IDENTICALLY with or without the fix under test —
    // i.e. it silently becomes vacuous. `surfacesWithoutTheFix` below is the
    // guard against exactly that: it fails if this fixture ever stops being
    // fire-worthy for the pre-fix query.
    { filePath: 'packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts', status: 'pass', startedAt: at(60), durationMs: 11, tail: null },
    { filePath: 'packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts', status: 'pass', startedAt: at(50), durationMs: 12, tail: null },
    { filePath: 'packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts', status: 'fail', startedAt: at(40), durationMs: 0, tail: ENOENT_TAIL },
    { filePath: 'packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts', status: 'fail', startedAt: at(38), durationMs: 0, tail: ENOENT_TAIL },
    { filePath: 'packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts', status: 'fail', startedAt: at(36), durationMs: 0, tail: ENOENT_TAIL },

    // CONTROL A — a genuinely broken file: same fail count, real durations, real
    // assertion tail, latest run still red. The fix must not suppress it.
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'pass', startedAt: at(60), durationMs: 120, tail: null },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(40), durationMs: 165, tail: 'measured window outranks the spec-derived guess > seed pass > falls back' },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(30), durationMs: 247, tail: 'measured window outranks the spec-derived guess > seed pass > falls back' },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(5), durationMs: 134, tail: 'measured window outranks the spec-derived guess > seed pass > falls back' },

    // CONTROL B — a REAL assertion failure whose own output merely QUOTES the
    // ENOENT string, with a real duration (the 3 measured rows across 2 files).
    // Matching on the tail alone would wrongly suppress this.
    { filePath: 'packages/operator-core/lib/quotes-enoent-in-assertion.test.ts', status: 'fail', startedAt: at(40), durationMs: 88, tail: `expected handler to surface ${ENOENT_TAIL} but it threw` },
    { filePath: 'packages/operator-core/lib/quotes-enoent-in-assertion.test.ts', status: 'fail', startedAt: at(30), durationMs: 91, tail: `expected handler to surface ${ENOENT_TAIL} but it threw` },
    { filePath: 'packages/operator-core/lib/quotes-enoent-in-assertion.test.ts', status: 'fail', startedAt: at(5), durationMs: 77, tail: `expected handler to surface ${ENOENT_TAIL} but it threw` },

    // CONTROL C — a zero-duration failure that is NOT the tmp-cache ENOENT (the
    // 648 measured rows across 440 files). Matching on duration alone would
    // wrongly suppress this.
    { filePath: 'packages/operator-core/lib/zero-duration-env-break.test.ts', status: 'fail', startedAt: at(40), durationMs: 0, tail: 'afterAll is not defined' },
    { filePath: 'packages/operator-core/lib/zero-duration-env-break.test.ts', status: 'fail', startedAt: at(30), durationMs: 0, tail: 'afterAll is not defined' },
    { filePath: 'packages/operator-core/lib/zero-duration-env-break.test.ts', status: 'fail', startedAt: at(5), durationMs: 0, tail: 'afterAll is not defined' },

    // CONTROL E — failures in one file can carry unrelated tails. The aggregate
    // must expose the newest tail, not lexical MAX(output_tail).
    { filePath: 'packages/operator-core/lib/newest-tail.test.ts', status: 'fail', startedAt: at(40), durationMs: 120, tail: 'zzz-oldest failure' },
    { filePath: 'packages/operator-core/lib/newest-tail.test.ts', status: 'fail', startedAt: at(30), durationMs: 120, tail: 'yyy-middle failure' },
    { filePath: 'packages/operator-core/lib/newest-tail.test.ts', status: 'fail', startedAt: at(5), durationMs: 120, tail: 'aaa-newest failure' },

    // CONTROL D — a file whose ONLY recent runs are poisoned rows (no real
    // history at all in the window). Must never fire either.
    { filePath: 'packages/operator-core/lib/only-poisoned.test.ts', status: 'fail', startedAt: at(20), durationMs: 0, tail: ENOENT_TAIL },
    { filePath: 'packages/operator-core/lib/only-poisoned.test.ts', status: 'fail', startedAt: at(15), durationMs: 0, tail: ENOENT_TAIL },
    { filePath: 'packages/operator-core/lib/only-poisoned.test.ts', status: 'fail', startedAt: at(10), durationMs: 0, tail: ENOENT_TAIL },
  ];

  for (const r of rows) {
    await db.sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail)
      VALUES
        (${r.filePath}, 'vitest', ${r.status}, ${r.durationMs}, ${r.startedAt}, ${r.startedAt}, ${r.tail})
    `;
  }
});

afterAll(async () => {
  await db.cleanup();
});

describe('fetchRedTestRows excludes wiped-tmp-cache infra reds (EI-20770395938680312)', () => {
  it('does NOT surface a file whose only recent fails were zero-duration tmp-cache ENOENTs (THE live repro)', async () => {
    const paths = (await fetch()).map((r) => r.file_path);
    expect(paths).not.toContain('packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts');
  });

  it('does NOT surface a file whose ONLY recent runs are poisoned rows', async () => {
    const paths = (await fetch()).map((r) => r.file_path);
    expect(paths).not.toContain('packages/operator-core/lib/only-poisoned.test.ts');
  });

  it('STILL surfaces a genuinely broken file with real durations and a real tail (no over-suppression)', async () => {
    const row = (await fetch()).find((r) => r.file_path === 'packages/operator-core/lib/real-regression.test.ts');
    expect(row).toBeDefined();
    expect(row?.fails).toBe(3);
  });

  it('STILL surfaces a real assertion failure whose output merely QUOTES the ENOENT string (tail alone is not enough)', async () => {
    const row = (await fetch()).find((r) => r.file_path === 'packages/operator-core/lib/quotes-enoent-in-assertion.test.ts');
    expect(row).toBeDefined();
    expect(row?.fails).toBe(3);
  });

  it('STILL surfaces a zero-duration failure that is not the tmp-cache ENOENT (duration alone is not enough)', async () => {
    const row = (await fetch()).find((r) => r.file_path === 'packages/operator-core/lib/zero-duration-env-break.test.ts');
    expect(row).toBeDefined();
    expect(row?.fails).toBe(3);
  });

  it('selects the newest failure tail rather than lexical MAX(output_tail)', async () => {
    const row = (await fetch()).find((r) => r.file_path === 'packages/operator-core/lib/newest-tail.test.ts');
    expect(row).toBeDefined();
    expect(row?.sample).toBe('aaa-newest failure');
  });

  /**
   * FALSIFIABILITY CONTROL — the deliberately-wrong (pre-fix) implementation,
   * kept permanently in the test file rather than mutated into the shared tree
   * (a tree mutation can be swept into a commit by git-sync even when nothing
   * goes wrong). This is the PRE-FIX `recent` CTE: byte-identical to the real
   * one except that the tmp-cache-ENOENT exclusion is absent.
   *
   * It asserts the repro fixture IS fire-worthy without the fix. Without this,
   * the suppression assertions above could pass for the wrong reason — because
   * the fixture stopped being able to fire at all — and the suite would look
   * green while testing nothing. If this ever goes red, the fixture has drifted
   * vacuous; fix the FIXTURE, never this control.
   */
  it('surfacesWithoutTheFix: the repro fixture DOES fire under the pre-fix query (proves the filter is what suppresses it)', async () => {
    const rows = await db.sql<Array<{ file_path: string; fails: number }>>`
      WITH recent AS (
        SELECT file_path, status,
               row_number() OVER (PARTITION BY file_path ORDER BY started_at DESC) AS rn
          FROM harness_shared.test_runs
         WHERE started_at > now() - make_interval(hours => 6)
           AND status IN ('pass', 'fail', 'error')
           AND file_path LIKE '%/%'
           AND is_scratch_config = false
      )
      SELECT file_path,
             count(*) FILTER (WHERE status IN ('fail', 'error'))::int AS fails
        FROM recent
       GROUP BY file_path
      HAVING count(*) FILTER (WHERE status IN ('fail', 'error')) >= 3
         AND max(CASE WHEN rn = 1 THEN status END) IN ('fail', 'error')`;

    const paths = rows.map((r) => r.file_path);
    expect(paths).toContain('packages/operator-core/lib/harness/improvements/dispatch-ledger.test.ts');
    expect(paths).toContain('packages/operator-core/lib/only-poisoned.test.ts');
  });
});
