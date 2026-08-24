/**
 * resolve-message-ref.integration.test.ts — WI-6725, against REAL Postgres.
 *
 * A full coord msg_id is `<short>-0000-<32 hex>`, but the LEADING SHORT FORM is
 * what circulates in prose, summaries and carry-notes. `getMessageById` matches
 * exactly, so a short-form lookup returned a well-formed EMPTY result that was
 * indistinguishable from "no such message" — and on 2026-08-01 a fleet leader
 * retracted a real, unanswered commitment on exactly that false negative.
 *
 * These pin the three-valued contract: a unique prefix RESOLVES, an ambiguous
 * one is reported AS ambiguous with candidates, and only a genuine miss is
 * not-found. Driven through `sendMessage` so the stored envelope shape matches
 * production exactly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage, resolveMessageRef, getMessageById } from './messages';
import { coordWorkspaceId } from './log';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const ASKER = ident('ref-asker');
const READER = ident('ref-reader');

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`;
});

describe('resolveMessageRef (WI-6725)', () => {
  it('a FULL msg_id resolves exactly (unchanged fast path)', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'the design fork' });

    const res = await resolveMessageRef(sent.msg_id);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('exact');
    expect(res.msgId).toBe(sent.msg_id);
    expect(res.message.summary).toBe('the design fork');
  });

  it('WI-6725: the TRUNCATED short form — the one that circulates in prose — now RESOLVES', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'the design fork' });
    const shortForm = sent.msg_id.split('-')[0];
    expect(shortForm).not.toBe(sent.msg_id);
    // The exact-match primitive still misses it — that is the bug being fixed.
    expect(await getMessageById(shortForm)).toBeNull();

    const res = await resolveMessageRef(shortForm);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('prefix');
    expect(res.msgId).toBe(sent.msg_id);
    expect(res.message.summary).toBe('the design fork');
  });

  it('EI-21271857379493174: resolves an open escalation retained only in the projection', async () => {
    const fullId = 'mqlfq7me-0000-18f69a47da0046dd85a61f17ff88f87f';
    const escalation = {
      ts: '2026-06-19T21:22:38.388Z',
      msg_id: fullId,
      from: ASKER.ownerId,
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: 'projection-only open escalation',
      resolved: null,
    };
    const workspaceId = coordWorkspaceId();
    await fx.admin`
      INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
      VALUES (${workspaceId}, ${fullId}, ${escalation.ts}, ${fx.admin.json(escalation)})
    `;

    const eventRows = await fx.admin`
      SELECT 1 FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND msg_id = ${fullId}
    `;
    expect(eventRows).toHaveLength(0);

    const res = await resolveMessageRef(fullId.split('-')[0]);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('prefix');
    expect(res.msgId).toBe(fullId);
    expect(res.message.kind).toBe('escalation');
    expect(res.message.summary).toBe('projection-only open escalation');
  });

  it('a genuinely absent FULL id is not-found, and is NOT flagged as truncated', async () => {
    const res = await resolveMessageRef('msnope99-0000-0123456789abcdef0123456789abcdef');
    expect(res.status).toBe('not-found');
    if (res.status !== 'not-found') return;
    expect(res.looksTruncated).toBe(false);
  });

  it('a short ref matching nothing is not-found AND flagged as truncated (so the caller can say why)', async () => {
    await sendMessage(ASKER, { to: [READER.ownerId], summary: 'unrelated' });

    const res = await resolveMessageRef('zzzznope');
    expect(res.status).toBe('not-found');
    if (res.status !== 'not-found') return;
    expect(res.looksTruncated).toBe(true);
  });

  it('an AMBIGUOUS prefix reports ambiguity with candidates — never a silent empty', async () => {
    const a = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'first' });
    const b = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'second' });
    // A 2-char prefix both ids share (coord short ids share the 'ms' stem).
    const shared = a.msg_id.slice(0, 2);
    expect(b.msg_id.startsWith(shared)).toBe(true);

    const res = await resolveMessageRef(shared);
    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.candidates.length).toBeGreaterThan(1);
    expect(res.candidates).toContain(a.msg_id);
    expect(res.candidates).toContain(b.msg_id);
  });

  it('an empty/whitespace ref is not-found rather than matching everything', async () => {
    await sendMessage(ASKER, { to: [READER.ownerId], summary: 'present' });

    expect((await resolveMessageRef('   ')).status).toBe('not-found');
    expect((await resolveMessageRef('')).status).toBe('not-found');
  });

  it('prefix matching is anchored at the START — a mid-id substring does not resolve', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'anchored' });
    const middle = sent.msg_id.slice(4, 12);

    const res = await resolveMessageRef(middle);
    expect(res.status).toBe('not-found');
  });
});
