/**
 * owner-directive-disposition-readback.integration.test.ts — real-PG read-back proof for
 * the directive lifecycle of plan `owner-directive-delivery-redesign-2026-09-22`:
 * every owner turn lands OPEN (D-001) and ends only as `done` or `declined` with a
 * reason; a directive over the 500-char cap carries an agent-written summary (D-004,
 * P-003). It replaces the P-005 read-back of `turn-start-memory-two-class-2026-09-21`,
 * whose promote/dismiss clauses D-001 retired.
 *
 * WHY THIS FILE EXISTS. The handler suites (disposition-foreign-directive.test.ts,
 * summarize.test.ts) MOCK the store and assert on the returned envelope. Every claim
 * that matters here is about DURABLE state — "a read still returns it", "a refused
 * write leaves the row as it was" — and none of that is observable on a return value.
 * So this file tests only what a mock cannot reach: the row in Postgres afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { OWNER_DIRECTIVE_VERBATIM_CAP } from './owner-directive-display';
import {
  dispositionOwnerDirective,
  getOwnerDirective,
  listOwnerDirectives,
  ownerDirectiveState,
  recordOwnerDirective,
  summarizeOwnerDirective,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive disposition + summary read-back', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-readback-ws';
  const LONG = 'please rework the whole delivery pipeline so that '.repeat(12);

  async function capture(turnRef: string, text: string): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-readback',
        sourceTurnRef: turnRef,
        verbatimText: text,
        recordedBy: 'su-readback-test',
        capturedByHook: true,
      },
      db.adminSql,
    );
    return row.id;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('a freshly captured turn reads back OPEN, distinct from done and declined', async () => {
    const id = await capture('turn-fresh', 'answer the question about the router');
    const row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('open');
    expect(row!.dispositionedAtMs).toBeNull();
    expect(row!.dispositionStatus).toBeNull();
  });

  it('done reads back done, carrying the note and who closed it', async () => {
    const id = await capture('turn-done', 'ship the thing');
    const result = await dispositionOwnerDirective(
      { id, status: 'done', note: 'shipped in WI-1', dispositionedBy: 'su-closer' },
      db.adminSql,
    );
    expect(result.ok).toBe(true);
    const row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('done');
    expect(row!.dispositionNote).toBe('shipped in WI-1');
    expect(row!.dispositionedBy).toBe('su-closer');
  });

  it('a declined directive is never deleted: a read returns it, declined, carrying the reason', async () => {
    const id = await capture('turn-declined', 'delete production');
    await dispositionOwnerDirective(
      { id, status: 'declined', note: 'irreversible; asked the owner to confirm', dispositionedBy: 'su-closer' },
      db.adminSql,
    );
    const row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('declined');
    expect(row!.dispositionNote).toBe('irreversible; asked the owner to confirm');
    expect(row!.verbatimText).toBe('delete production');

    // ...and it stays QUERYABLE through the list read.
    const declined = await listOwnerDirectives({ workspaceId, state: 'declined', limit: 200 }, db.adminSql);
    expect(declined.map((r) => r.id)).toContain(id);
    const open = await listOwnerDirectives({ workspaceId, open: true, limit: 200 }, db.adminSql);
    expect(open.map((r) => r.id)).not.toContain(id);
  });

  it('a REFUSED second disposition leaves the stored row exactly as it was', async () => {
    const id = await capture('turn-refused', 'do the other thing');
    await dispositionOwnerDirective(
      { id, status: 'done', note: 'first close', dispositionedBy: 'su-first' },
      db.adminSql,
    );
    const before = await getOwnerDirective(id, db.adminSql);

    const second = await dispositionOwnerDirective(
      { id, status: 'declined', note: 'second close', dispositionedBy: 'su-second' },
      db.adminSql,
    );
    expect(second).toMatchObject({ ok: false, error: 'already_dispositioned' });
    expect(await getOwnerDirective(id, db.adminSql)).toEqual(before);
  });

  it('P-003: a long directive persists its summary with author and time; the verbatim is untouched', async () => {
    expect(LONG.trim().length).toBeGreaterThan(OWNER_DIRECTIVE_VERBATIM_CAP);
    const id = await capture('turn-long', LONG);
    const result = await summarizeOwnerDirective(
      { id, summary: 'Rework the delivery pipeline.', summarizedBy: 'su-summarizer' },
      db.adminSql,
    );
    expect(result.ok).toBe(true);
    const row = await getOwnerDirective(id, db.adminSql);
    expect(row!.summaryText).toBe('Rework the delivery pipeline.');
    expect(row!.summaryBy).toBe('su-summarizer');
    expect(typeof row!.summaryAtMs).toBe('number');
    expect(row!.verbatimText).toBe(LONG.slice(0, row!.verbatimText.length));
    expect(ownerDirectiveState(row!)).toBe('open');
  });

  it('P-003: a summary for a SHORT directive is refused and writes nothing', async () => {
    const id = await capture('turn-short', 'a short turn needs no summary');
    const result = await summarizeOwnerDirective(
      { id, summary: 'Short.', summarizedBy: 'su-summarizer' },
      db.adminSql,
    );
    expect(result).toMatchObject({ ok: false, error: 'summary_not_needed' });
    expect((await getOwnerDirective(id, db.adminSql))!.summaryText ?? null).toBeNull();
  });

  it('P-003: a closed directive cannot be summarized', async () => {
    const id = await capture('turn-long-closed', LONG);
    await dispositionOwnerDirective(
      { id, status: 'done', note: 'done before summary', dispositionedBy: 'su-closer' },
      db.adminSql,
    );
    const result = await summarizeOwnerDirective(
      { id, summary: 'Too late.', summarizedBy: 'su-summarizer' },
      db.adminSql,
    );
    expect(result).toMatchObject({ ok: false, error: 'already_dispositioned' });
    expect((await getOwnerDirective(id, db.adminSql))!.summaryText ?? null).toBeNull();
  });

  it('P-003: the database itself refuses a summary over 200 chars or a partial summary', async () => {
    const id = await capture('turn-long-db', LONG);
    await expect(
      db.adminSql`UPDATE harness_shared.owner_directives
                     SET summary_text = ${'x'.repeat(201)}, summary_by = 'su-x', summary_at = now()
                   WHERE id = ${id}`,
    ).rejects.toThrow(/owner_directives_summary_length_check/);
    await expect(
      db.adminSql`UPDATE harness_shared.owner_directives SET summary_text = 'no author' WHERE id = ${id}`,
    ).rejects.toThrow(/owner_directives_summary_consistent/);
  });
});
