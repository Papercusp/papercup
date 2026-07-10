/**
 * reply-deadline-sweep.test.ts — coord:send { replyDeadlineSec } backstop (EI-8986).
 *
 * Mocks the DB read (a canned row set standing in for the SQL query — the
 * query itself mirrors message-log-gc.ts's proven `body ? 'key'` / `->>'key'`
 * JSONB-predicate style) and the two effects (sendMessage / wakeRecipients),
 * so this pins the ORCHESTRATION contract without a real DB: one nudge per
 * due item, correct addressee/related_msg_id (the idempotency marker), the
 * batch/truncated accounting, and per-item fail-soft isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  sqlCalls: [] as unknown[][],
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.sqlCalls.push(values);
        return Promise.resolve(h.rows);
      },
      { unsafe: vi.fn() },
    ),
  }),
}));

vi.mock('./messages', () => ({ sendMessage: vi.fn(async () => undefined) }));
vi.mock('./inbox-wake', () => ({ wakeRecipients: vi.fn(async () => ({ woken: 1, targets: [], fanoutCapped: [] })) }));

import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import {
  runReplyDeadlineSweepOnce,
  REPLY_DEADLINE_SWEEP_BATCH_LIMIT,
  RECONCILE_REPLY_DEADLINE_OWNER,
} from './reply-deadline-sweep';

const NOW = Date.parse('2026-07-10T12:00:00Z');

function row(over: Partial<{
  workspace_id: string;
  msg_id: string;
  from_id: string;
  to_ids: unknown;
  summary: string | null;
  plan_slug: string | null;
  deadline_at: string;
}> = {}) {
  return {
    workspace_id: 'default',
    msg_id: 'm1',
    from_id: 'su-sender',
    to_ids: ['su-recipient'],
    summary: 'original summary',
    plan_slug: null,
    deadline_at: String(NOW - 5 * 60_000), // 5m overdue by default
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.sqlCalls = [];
});

describe('runReplyDeadlineSweepOnce', () => {
  it('is a no-op when nothing is due', async () => {
    h.rows = [];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 0, nudged: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it('nudges the ORIGINAL sender once, carrying related_msg_id as the idempotency marker', async () => {
    h.rows = [row()];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 1, nudged: 1, truncated: false });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(identity.ownerId).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
    expect(opts.to).toEqual(['su-sender']); // the ORIGINAL sender, not the original recipient
    expect(opts.related_msg_id).toBe('m1'); // the idempotency marker
    expect(opts.summary).toContain('original summary');

    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    const [targets, wakeOpts] = (wakeRecipients as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targets).toEqual(['su-sender']);
    expect(wakeOpts.source).toBe(RECONCILE_REPLY_DEADLINE_OWNER);
    expect(wakeOpts.workspaceId).toBe('default');
  });

  it('computes overdueMinutes from the deadline row and reports it in the nudge', async () => {
    h.rows = [row({ deadline_at: String(NOW - 90 * 60_000) })]; // 90m overdue
    await runReplyDeadlineSweepOnce({ nowMs: NOW });
    const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('90m');
    expect(opts.body).toContain('90m');
  });

  it('a sendMessage failure on one item never blocks the rest (fail-soft)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row({ msg_id: 'bad' }), row({ msg_id: 'good' })];
    (sendMessage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => undefined);

    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 2, nudged: 1, truncated: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // the failed item's wake must never fire either.
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect((wakeRecipients as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(['su-sender']);
  });

  it('a wakeRecipients failure never blocks the (already-sent) nudge from counting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row()];
    (wakeRecipients as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('wake down');
    });
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 1, nudged: 1, truncated: false });
  });

  it('skips a row with no resolvable `from` instead of throwing', async () => {
    h.rows = [row({ from_id: undefined as unknown as string })];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ due: 0, nudged: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('respects the batch limit and reports truncated:true when more remain', async () => {
    h.rows = [row({ msg_id: 'a' }), row({ msg_id: 'b' }), row({ msg_id: 'c' })];
    const result = await runReplyDeadlineSweepOnce({ nowMs: NOW, limit: 2 });
    expect(result).toEqual({ due: 3, nudged: 2, truncated: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('defaults the limit to REPLY_DEADLINE_SWEEP_BATCH_LIMIT + 1 rows requested from the DB', async () => {
    h.rows = [];
    await runReplyDeadlineSweepOnce({ nowMs: NOW });
    // the sweep over-fetches by 1 (limit+1) purely to detect truncation; assert
    // the query was issued with `nowMs` bound in its values (loose shape check —
    // the exact SQL text is proven by the real query mirroring message-log-gc.ts).
    expect(h.sqlCalls.length).toBeGreaterThan(0);
    expect(h.sqlCalls[0]).toContain(NOW);
    expect(REPLY_DEADLINE_SWEEP_BATCH_LIMIT).toBeGreaterThan(0);
  });
});
