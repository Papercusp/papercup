/**
 * tool-error-classifier.integration.test.ts — the anti-drift guarantee with
 * TEETH (watchdog-and-exposed-systems-improvement-2026-06-18 P-011/P-012).
 *
 * The TS classifier and the watchdog's in-DB classification are GENERATED from
 * one rule table, so they can't drift by construction. This test PROVES it
 * against a real Postgres: it runs the GENERATED `toolErrorClassSqlCase` (real
 * `~*` POSIX-ERE) and `toolErrorFingerprintSqlCase` over the SAME fixture corpus
 * the unit test uses, and asserts row-by-row agreement with `classifyToolError`
 * / `toolErrorFingerprint`. If the SQL `~*` and the JS `RegExp` ever diverge on a
 * real shape (the bug class P-011 closes), this goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  classifyToolError,
  toolErrorFingerprint,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  FINGERPRINTED_TOOL_ERROR_CLASSES,
} from './tool-error-classifier';
import { collectToolErrorSignals } from './watchdog';
import { TOOL_ERROR_CORPUS } from './tool-error-corpus.fixture';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  await db.adminSql`
    CREATE TEMP TABLE tool_err_corpus (
      idx int, error_code text, status text, error_message text
    )`;
  for (const [idx, r] of TOOL_ERROR_CORPUS.entries()) {
    await db.adminSql`
      INSERT INTO tool_err_corpus (idx, error_code, status, error_message)
      VALUES (${idx}, ${r.errorCode}, ${r.status}, ${r.message})`;
  }
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('generated SQL CASE ↔ classifyToolError parity (P-011)', () => {
  it('classifies every corpus row identically in SQL and TS', async () => {
    const sql = db.adminSql;
    const rows = await sql<{ idx: number; error_code: string | null; status: string; error_message: string | null; klass: string }[]>`
      SELECT idx, error_code, status, error_message, ${toolErrorClassSqlCase(sql)} AS klass
        FROM tool_err_corpus
       ORDER BY idx`;
    expect(rows.length).toBe(TOOL_ERROR_CORPUS.length);

    const disagreements: string[] = [];
    for (const row of rows) {
      const ts = classifyToolError(row.error_code, row.status, row.error_message);
      if (ts !== row.klass) {
        disagreements.push(`idx=${row.idx} code=${row.error_code} status=${row.status}: SQL=${row.klass} TS=${ts} :: ${String(row.error_message).slice(0, 60)}`);
      }
      // …and both must equal the pinned expected class.
      expect(row.klass).toBe(TOOL_ERROR_CORPUS[row.idx].expectedClass);
    }
    expect(disagreements).toEqual([]);
  });
});

describe('generated SQL fingerprint ↔ toolErrorFingerprint parity (P-012)', () => {
  it('computes the same fingerprint (and null-for-coarse-classes) in SQL and TS', async () => {
    const sql = db.adminSql;
    // The fingerprint CASE references `class` + `error_message`, so classify first.
    const rows = await sql<{ idx: number; klass: string; fingerprint: string | null }[]>`
      SELECT idx, class AS klass, ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM (
          SELECT idx, error_message, ${toolErrorClassSqlCase(sql)} AS class
            FROM tool_err_corpus
        ) f
       ORDER BY idx`;

    const disagreements: string[] = [];
    for (const row of rows) {
      const message = TOOL_ERROR_CORPUS[row.idx].message;
      const tsFingerprint = FINGERPRINTED_TOOL_ERROR_CLASSES.has(row.klass as never)
        ? toolErrorFingerprint(message)
        : null;
      const sqlFp = row.fingerprint ?? null;
      if (sqlFp !== tsFingerprint) {
        disagreements.push(`idx=${row.idx} class=${row.klass}: SQL=${sqlFp} TS=${tsFingerprint} :: ${message.slice(0, 60)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('rate-limit rows are NEVER fingerprinted in SQL (kept coarse)', async () => {
    const sql = db.adminSql;
    const rows = await sql<{ fingerprint: string | null }[]>`
      SELECT ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM (
          SELECT error_message, ${toolErrorClassSqlCase(sql)} AS class
            FROM tool_err_corpus
        ) f
       WHERE class = 'rate-limit'`;
    expect(rows.length).toBeGreaterThan(0); // the corpus has rate-limit rows
    expect(rows.every((r) => r.fingerprint === null)).toBe(true);
  });
});

describe('the FULL collectToolErrorSignals query embeds the generated fragments validly (P-011)', () => {
  it('runs against real PG without a syntax error and emits new-shape fingerprinted keys', async () => {
    const sql = db.adminSql;
    // Two distinct caller modes + a timeout under the SAME tool — pre-P-012 these
    // collapsed onto one `:caller` / `:transient` key; the generated SQL must now
    // split the caller modes apart by fingerprint and run the whole CTE cleanly.
    // Counts are above the per-class FIRE bars (caller ≥10, transient ≥15) so the
    // signals actually fire; the two caller modes share the SAME tool so only the
    // fingerprint splits them (the P-012 win).
    const seed: { tool: string; status: string; code: string | null; msg: string; n: number }[] = [
      { tool: 'plans:new', status: 'error', code: null, msg: 'invalid_args: note: Too big: expected string to have <=400 characters', n: 11 },
      { tool: 'plans:new', status: 'error', code: 'handler_error', msg: 'invalid_args: status: Invalid option: expected one of "draft"|"ready"', n: 11 },
      { tool: 'plans:list', status: 'timeout', code: null, msg: 'tool "plans:list" exceeded timeout of 60s (handler returned but signal had aborted)', n: 16 },
    ];
    for (const s of seed) {
      for (let k = 0; k < s.n; k++) {
        await sql`
          INSERT INTO harness_shared.tool_invocations
            (workspace_id, tool_name, status, error_code, error_message, invoked_at)
          VALUES ('*', ${s.tool}, ${s.status}, ${s.code}, ${s.msg}, now())`;
      }
    }

    const signals = await collectToolErrorSignals(sql);
    expect(Array.isArray(signals)).toBe(true);
    const keys = signals.map((s) => s.key);
    // the two caller modes split into distinct fingerprinted keys (P-012)…
    expect(keys).toContain('plans:new:caller:invalid-args-note-too-big-expected');
    expect(keys).toContain('plans:new:caller:invalid-args-status-invalid-option-expected');
    // …and the timeout is a fingerprinted transient key.
    expect(keys.some((k) => k.startsWith('plans:list:transient:'))).toBe(true);
  });
});
