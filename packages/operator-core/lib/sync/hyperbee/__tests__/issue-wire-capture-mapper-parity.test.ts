/**
 * issue-wire-capture-mapper-parity — the detector for WI-6327's bug class:
 * **the CDC mapper reads a key the SQL capture trigger never writes.**
 *
 * When that happens nothing errors. The mapper's `??` / `strOrNull` fallbacks quietly
 * substitute null (or, worse, a FABRICATED value), the op ships, the projection applies
 * it, and the column simply arrives empty on every peer forever. It is silent,
 * permanent, cross-machine data loss with a green test suite.
 *
 * It bit three columns of the issue family at once (found live on the P-302 rig
 * 2026-07-27, fixed by mig 688):
 *
 *   • `created_at`/`created_ts` — absent, so `toEngineerIssueValue` fell through to
 *     `new Date().toISOString()`. Every op then claimed it was created at drain time,
 *     and the receiver's EI-13285 id-collision guard — which compares exactly that
 *     field against the local row's created_ts — read EVERY update as a distinct-entity
 *     collision and DROPPED it. 10,070 distinct issue_ids refused; issue federation was
 *     dead for any row a peer already held, and the refusals alone wrote ~1GB/hr of log.
 *   • `terminal_owner` + `terminal_completion_ref` — the completion-integrity pair
 *     (WI-1403/EI-5269), added precisely so a peer could see who resolved an item and
 *     the evidence. They reached every peer NULL.
 *
 * WHY THE EXISTING TESTS ALL MISSED IT — the two gaps this file closes:
 *
 *  1. `federated-column-completeness.integration.test.ts` runs the real mapper over a
 *     SYNTHETIC full-column row, so `created_at` was always present and the fabricating
 *     branch never ran. It proves "table column → mapper key"; it cannot see the SQL.
 *  2. `engineer-issues-federation-trigger.integration.test.ts` (DELETED, WI-41780) DID
 *     drive real SQL, but loaded migrations only through 197, so it exercised
 *     `capture_engineer_issues_outbox` against a real `engineer_issues` TABLE. P-010
 *     (work-items-unify) turned that into a compat VIEW; the live producer is
 *     `capture_work_items_outbox` on `work_items`. It had been guarding a code path
 *     production no longer runs, and mig-969 then DROPPED its subject function outright
 *     as unreachable dead code (EI-21474657831529811) — so the file was green while
 *     exercising a function that does not exist at head, via a schema shape that does
 *     not exist at head. Its live-mapper (RESHAPE) assertions were verified to be a
 *     strict SUBSET of the `outboxRowToLocalWriteOp — engineer_issues` block in
 *     `../feature-issue-op-keys.test.ts` (which additionally covers del ops,
 *     `terminal_reason`, `storage_harness_slug`, and BOTH the harness-qualified and
 *     the pre-829 bare-key forms), so deleting it dropped no live coverage.
 *
 * So this check deliberately spans BOTH artifacts and asserts the one invariant that
 * actually matters — every key the mapper consumes is emitted by the shipped capture
 * SQL — with no PG required, so it runs in the fast unit lane on every `test:affected`.
 *
 * The mapper's key set is not regex-scraped: the mapper is invoked with a Proxy that
 * records each property read, so the expectation is the mapper's REAL behaviour and
 * cannot drift from it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');

const CAPTURE_FN = 'harness_shared.capture_work_items_outbox';

/**
 * Keys the capture intentionally does NOT put in the wire row, with the reason. The
 * mapper reads them defensively (a legacy/pre-unify outbox row could carry them) but
 * their absence is by design, not data loss.
 */
const INTENTIONALLY_ABSENT: Readonly<Record<string, string>> = {
  // The receiver stamps provenance from the op ENVELOPE (author/ts/hlc), never from the
  // row value — carrying them in the row would let a peer forge its own provenance.
  origin: 'op provenance — the projection sets it from the envelope, not the row value',
  author_pubkey: 'op provenance — set from the op envelope (writerPubkey)',
  fed_ts: 'op provenance — set from the op envelope ts',
  fed_hlc: 'op provenance — set from the op envelope hlc',
  // Legacy alias: pre-688 ops carried an ISO `created_at`; the capture now emits the
  // authoritative epoch-ms `created_ts` and the mapper DERIVES created_at from it. The
  // mapper still reads created_at so pre-688 ops in the log keep working.
  created_at: 'pre-688 legacy alias — superseded by created_ts, which the capture emits',
};

/** The migration file that currently defines the live capture function. */
function latestCaptureMigration(): { file: string; sql: string } {
  const definesCaptureFunction =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+harness_shared\.capture_work_items_outbox\s*\(/i;
  const candidates = readdirSync(SQL_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    // Later trigger-only migrations mention the function in comments and
    // EXECUTE clauses. Neither is a definition, so selecting on the bare words
    // `FUNCTION <name>` can silently inspect a file with no wire-row builder.
    .filter((f) => definesCaptureFunction.test(readFileSync(resolve(SQL_DIR, f), 'utf8')))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const file = candidates[candidates.length - 1];
  if (!file) throw new Error(`no migration defines ${CAPTURE_FN}`);
  return { file, sql: readFileSync(resolve(SQL_DIR, file), 'utf8') };
}

/**
 * The key literals the ISSUE-family builder emits. Scoped to the
 * `jsonb_build_object(...)` that follows `v_tbl := 'engineer_issues'` so the FEATURE
 * branch (which ships `to_jsonb(v_rec)` and therefore carries every column for free)
 * can never be mistaken for it.
 */
function issueWireKeysEmittedBySql(sql: string): Set<string> {
  const start = sql.indexOf(`v_tbl := 'engineer_issues'`);
  if (start < 0) throw new Error('issue-family branch not found in capture SQL');
  const buildStart = sql.indexOf('jsonb_build_object', start);
  const buildEnd = sql.indexOf('END IF;', buildStart);
  if (buildStart < 0 || buildEnd < 0) throw new Error('issue-family jsonb_build_object not found');
  const block = sql.slice(buildStart, buildEnd);
  const keys = new Set<string>();
  for (const m of block.matchAll(/'([a-z_]+)'\s*,/g)) keys.add(m[1]);
  return keys;
}

/**
 * Every key `toEngineerIssueValue` actually reads off the outbox row — captured by
 * handing the mapper a recording Proxy instead of a literal row, so this is the
 * mapper's real behaviour rather than a hand-maintained list that can rot.
 */
function issueWireKeysReadByMapper(): Set<string> {
  const read = new Set<string>();
  const probe = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string') read.add(prop);
        return undefined;
      },
      has: () => true,
    },
  ) as Record<string, unknown>;
  const outboxRow: OutboxRow = { table_name: 'engineer_issues', op: 'put', key: 'EI-1', ts: 1, row: probe };
  outboxRowToLocalWriteOp(outboxRow);
  return read;
}

describe('issue-family CDC wire row — capture SQL covers every key the mapper reads (WI-6327)', () => {
  it('the capture trigger emits every key toEngineerIssueValue consumes', () => {
    const { file, sql } = latestCaptureMigration();
    const emitted = issueWireKeysEmittedBySql(sql);
    const read = issueWireKeysReadByMapper();

    const missing = [...read].filter((k) => !emitted.has(k) && !(k in INTENTIONALLY_ABSENT)).sort();

    expect(
      missing,
      `${missing.join(', ')} — the engineer-issues MAPPER reads these keys but the capture ` +
        `trigger in ${file} never writes them, so they federate as null/fabricated on EVERY ` +
        `peer. This is silent, permanent cross-machine data loss (WI-6327: created_at + the ` +
        `terminal_owner/terminal_completion_ref pair were lost this exact way). Either add the ` +
        `key to the issue-family jsonb_build_object in a new migration, or — if it is genuinely ` +
        `not meant to federate — document it in INTENTIONALLY_ABSENT with the reason.`,
    ).toEqual([]);
  });

  it('emits the creation instant as created_ts — the field the EI-13285 collision guard trusts', () => {
    // Regression pin for the blocker itself. `created_ts` (epoch ms, same unit as the
    // work_items column) must be on the wire: absent it, the mapper fabricates a
    // created_at and the receiver refuses every update as an id collision.
    const { file, sql } = latestCaptureMigration();
    expect(
      issueWireKeysEmittedBySql(sql).has('created_ts'),
      `the issue-family wire row in ${file} must carry created_ts — the EI-13285 guard keys ` +
        `on it, and without it the drain fabricates a creation time and every remote update ` +
        `is dropped as a distinct-entity collision`,
    ).toBe(true);
  });

  it('emits the completion-integrity pair (WI-1403/EI-5269) so a peer sees who resolved an item', () => {
    const { file, sql } = latestCaptureMigration();
    const emitted = issueWireKeysEmittedBySql(sql);
    expect(
      [...['terminal_owner', 'terminal_completion_ref', 'terminal_reason'].filter((k) => !emitted.has(k))],
      `missing from the issue-family wire row in ${file} — completion evidence would land NULL on every peer`,
    ).toEqual([]);
  });

  it('the mapper never fabricates created_ts — a guard must not be fed a synthesized value', () => {
    // The class fix. `created_at` may be defaulted (it only feeds an INSERT default),
    // but `created_ts` drives a REFUSE-THE-WRITE decision, so an op that did not carry
    // one must surface as null rather than as an invented timestamp the guard would
    // then treat as authoritative.
    const op = outboxRowToLocalWriteOp({
      table_name: 'engineer_issues',
      op: 'put',
      key: 'EI-1',
      ts: 1,
      row: { harness_slug: 'h', issue_id: 'EI-1', scope: 'harness:h', title: 't', body: 'b' },
    });
    const value = (op as { value: Record<string, unknown> }).value;
    expect(value.created_ts).toBeNull();
  });

  it('passes a carried created_ts through UNCHANGED (exact epoch ms — no ISO round-trip)', () => {
    const createdTs = 1_784_233_143_544; // a real work_items.created_ts
    const op = outboxRowToLocalWriteOp({
      table_name: 'engineer_issues',
      op: 'put',
      key: 'EI-1',
      ts: 1,
      row: {
        harness_slug: 'h',
        issue_id: 'EI-1',
        scope: 'harness:h',
        title: 't',
        body: 'b',
        created_ts: createdTs,
      },
    });
    const value = (op as { value: Record<string, unknown> }).value;
    // Exactness matters: the guard compares this against work_items.created_ts with a
    // 5s tolerance, so any lossy conversion here silently narrows the guard.
    expect(value.created_ts).toBe(createdTs);
    expect(value.created_at).toBe(new Date(createdTs).toISOString());
  });
});
