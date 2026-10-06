/**
 * report-attachments.integration.test.ts — the consented-attachment store
 * (unified-bug-pipeline P-014, D-013, D-048 pt 4) against real PostgreSQL and
 * the real migration 1411.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  REPORT_ATTACHMENT_MAX_BYTES,
  REPORT_ATTACHMENTS_PER_ITEM,
  listReportAttachments,
  prepareReportAttachment,
  putReportAttachment,
  sweepExpiredReportAttachments,
} from './report-attachments';

const WS = 'ws-report-attachments';
let db: FreshPgDb;

const migration = () => readFile(fileURLToPath(new URL(
  '../../../../../libs/papercusp/libs/db/sql/1411-report-attachments.sql', import.meta.url)), 'utf8');

beforeAll(async () => {
  db = await createFreshPgDb('report-attachments');
  await db.sql.unsafe(`DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    workspace_id text, feature_id text PRIMARY KEY, status text, state_changed_at timestamptz)`);
  await db.sql.unsafe(await migration());
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql.unsafe('DELETE FROM harness_shared.report_attachments');
  await db.sql.unsafe('DELETE FROM harness_shared.work_items');
});

const deps = () => ({ sql: db.sql as never });
const fetchContent = async (id: string) => {
  const [row] = await db.sql.unsafe<Array<{ content: Buffer; redaction: string }>>(
    'SELECT content, redaction FROM harness_shared.report_attachments WHERE id = $1', [id]);
  return { text: row.content.toString('utf8'), redaction: row.redaction };
};

describe('putReportAttachment', () => {
  it('re-redacts a text attachment at write, whatever the door sent', async () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const r = await putReportAttachment({
      workspaceId: WS, workItemId: 'EI-1', door: 'desktop', kind: 'log', mime: 'text/plain',
      content: `boot ok\nAuthorization: Bearer ${secret}\n`,
    }, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.redaction).toBe('redacted');
    const stored = await fetchContent(r.id);
    expect(stored.text).toContain('boot ok');
    expect(stored.text).not.toContain(secret);
  });

  it('stores an image as received and marks it not-redactable', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const r = await putReportAttachment({
      workspaceId: WS, workItemId: 'EI-1', door: 'chat', kind: 'screenshot', mime: 'image/png', content: png,
    }, deps());
    expect(r).toMatchObject({ ok: true, redaction: 'not-redactable', byteSize: 7 });
    const [row] = await db.sql.unsafe<Array<{ content: Buffer }>>(
      'SELECT content FROM harness_shared.report_attachments WHERE work_item_id = $1', ['EI-1']);
    expect([...row.content]).toEqual([...png]);
  });

  it('is idempotent per door and external id', async () => {
    const input = { workspaceId: WS, workItemId: 'EI-2', door: 'chat', kind: 'text' as const, mime: 'text/plain', content: 'same', externalId: 'slack:F123' };
    const first = await putReportAttachment(input, deps());
    const again = await putReportAttachment(input, deps());
    expect(first).toMatchObject({ ok: true, deduplicated: false });
    expect(again).toMatchObject({ ok: true, deduplicated: true });
    if (first.ok && again.ok) expect(again.id).toBe(first.id);
    expect(await listReportAttachments(WS, 'EI-2', deps())).toHaveLength(1);
  });

  it(`refuses the attachment past ${REPORT_ATTACHMENTS_PER_ITEM} per item`, async () => {
    for (let i = 0; i < REPORT_ATTACHMENTS_PER_ITEM; i++) {
      const r = await putReportAttachment({ workspaceId: WS, workItemId: 'EI-3', door: 'desktop', kind: 'text', mime: 'text/plain', content: `n${i}` }, deps());
      expect(r.ok).toBe(true);
    }
    const over = await putReportAttachment({ workspaceId: WS, workItemId: 'EI-3', door: 'desktop', kind: 'text', mime: 'text/plain', content: 'one more' }, deps());
    expect(over).toMatchObject({ ok: false, reason: 'too-many' });
  });

  it('refuses an attachment over the byte cap before touching the database', () => {
    const big = new Uint8Array(REPORT_ATTACHMENT_MAX_BYTES + 1);
    expect(prepareReportAttachment({ kind: 'file', mime: 'application/octet-stream', door: 'desktop', content: big }))
      .toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('sweepExpiredReportAttachments (D-013: deleted 90 days after the item closes)', () => {
  const put = (item: string) => putReportAttachment({ workspaceId: WS, workItemId: item, door: 'desktop', kind: 'text', mime: 'text/plain', content: item }, deps());

  it('deletes attachments of items closed more than 90 days ago and keeps the rest', async () => {
    await db.sql.unsafe(`INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, state_changed_at) VALUES
      ($1, 'EI-old-closed', 'done', now() - interval '91 days'),
      ($1, 'EI-new-closed', 'done', now() - interval '89 days'),
      ($1, 'EI-old-open',   'open', now() - interval '400 days')`, [WS]);
    for (const item of ['EI-old-closed', 'EI-new-closed', 'EI-old-open']) expect((await put(item)).ok).toBe(true);

    const result = await sweepExpiredReportAttachments(WS, deps());
    expect(result).toEqual({ deleted: 1, more: false });
    expect(await listReportAttachments(WS, 'EI-old-closed', deps())).toHaveLength(0);
    expect(await listReportAttachments(WS, 'EI-new-closed', deps())).toHaveLength(1);
    expect(await listReportAttachments(WS, 'EI-old-open', deps())).toHaveLength(1);
  });

  it('deletes an orphan only once it is older than the retention window', async () => {
    expect((await put('EI-gone-recent')).ok).toBe(true);
    expect((await put('EI-gone-old')).ok).toBe(true);
    await db.sql.unsafe(`UPDATE harness_shared.report_attachments SET created_at = now() - interval '91 days' WHERE work_item_id = 'EI-gone-old'`);
    expect(await sweepExpiredReportAttachments(WS, deps())).toEqual({ deleted: 1, more: false });
    expect(await listReportAttachments(WS, 'EI-gone-recent', deps())).toHaveLength(1);
  });

  it('never touches another workspace', async () => {
    await db.sql.unsafe(`INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, state_changed_at)
      VALUES ('ws-other', 'EI-x', 'done', now() - interval '200 days')`);
    const r = await putReportAttachment({ workspaceId: 'ws-other', workItemId: 'EI-x', door: 'desktop', kind: 'text', mime: 'text/plain', content: 'x' }, deps());
    expect(r.ok).toBe(true);
    expect(await sweepExpiredReportAttachments(WS, deps())).toEqual({ deleted: 0, more: false });
    expect(await listReportAttachments('ws-other', 'EI-x', deps())).toHaveLength(1);
  });
});
