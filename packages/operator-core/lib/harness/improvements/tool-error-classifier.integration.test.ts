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
