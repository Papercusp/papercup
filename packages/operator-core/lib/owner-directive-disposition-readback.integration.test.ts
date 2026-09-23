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
// R-5 drives the VERB's own schema: the mandatory-reason guard is declared there,
// not in the store, so importing the tool is what makes the guard reachable.
const dispositionTool = (await import('./agent-tools/orders/disposition')).default;

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

  // R-4 (turn-start-memory-two-class-2026-09-21, rev-9 bar set) grades the FIRST
  // clause only: that no writer OTHER than an explicit disposition moves a captured
  // directive out of the open standing state. The cases above all drive the
  // disposition path itself, so none of them can fail for the reason this one does.
  it('R-4: no writer other than an explicit disposition moves a captured directive out of open', async () => {
    const id = await capture('turn-r4-other-writers', 'review the acceptance bars');

    // (a) a capture RE-RUN for the same source turn.
    await capture('turn-r4-other-writers', 'review the acceptance bars');
    let row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('open');
    expect(row!.dispositionedAtMs).toBeNull();

    // (b) the orientation / re-injection READS that run on every wake.
    await listOwnerDirectives({ workspaceId, open: true, limit: 200 }, db.adminSql);
    await getOwnerDirective(id, db.adminSql);
    row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('open');
    expect(row!.dispositionedAtMs).toBeNull();

    // (c) the SWEEP path. Migration 1196 (owner-directive-unstick-dispositioned-
    // pending-captures) is the one real non-disposition WRITER against this table:
    // it force-moves capture_status to 'open'. Its WHERE excludes unresolved rows,
    // so against an open directive it must be a no-op.
    await db.adminSql`
      UPDATE harness_shared.owner_directives
         SET capture_status = 'open',
             capture_promoted_at = COALESCE(capture_promoted_at, dispositioned_at, now()),
             capture_promoted_by = COALESCE(capture_promoted_by, dispositioned_by, 'migration-1196')
       WHERE capture_status = 'pending' AND dispositioned_at IS NOT NULL
    `;
    row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('open');
    expect(row!.dispositionedAtMs).toBeNull();

    // CALIBRATION — without this the three assertions above would also pass on a
    // row that can never leave 'open' at all, which is not what the bar claims.
    const closed = await dispositionOwnerDirective(
      { id, status: 'done', note: 'carried out', dispositionedBy: 'su-closer' },
      db.adminSql,
    );
    expect(closed.ok).toBe(true);
    row = await getOwnerDirective(id, db.adminSql);
    expect(ownerDirectiveState(row!)).toBe('done');
    expect(row!.dispositionedAtMs).not.toBeNull();
  });

  // R-5 (same bar set). The mandatory-reason guard lives on the VERB
  // (agent-tools/orders/disposition.ts: `.trim().min(4)`, plus a refine that
  // requires note on the single form) — NOT on the store. A store-level
  // dispositionOwnerDirective call bypasses it entirely, so this drives the
  // verb's own schema object and then proves the row was never written.
  it('R-5: a close with an absent, empty, or whitespace-only reason is refused and writes nothing', async () => {
    const id = await capture('turn-r5-reason-guard', 'explain the routing change');
    const before = await getOwnerDirective(id, db.adminSql);

    for (const note of [undefined, '', '    ']) {
      const parsed = dispositionTool.args.safeParse({ id, status: 'declined', note });
      expect(parsed.success, `reason ${JSON.stringify(note)} must be refused`).toBe(false);
      // A refusal that wrote first and reported an error afterwards is the
      // regression that matters, so read the row back independently each time.
      expect(await getOwnerDirective(id, db.adminSql)).toEqual(before);
    }

    // CALIBRATION — a real reason clears the SAME guard and does close the row.
    // Without it, every assertion above would also hold for a guard that refuses
    // everything, which would make this test vacuous.
    const reason = 'declined: superseded by the successor plan';
    expect(dispositionTool.args.safeParse({ id, status: 'declined', note: reason }).success).toBe(true);
    await dispositionOwnerDirective(
      { id, status: 'declined', note: reason, dispositionedBy: 'su-closer' },
      db.adminSql,
    );
    expect(ownerDirectiveState((await getOwnerDirective(id, db.adminSql))!)).toBe('declined');
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
