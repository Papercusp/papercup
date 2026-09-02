/**
 * allpot-broadcast-sweep.test.ts — the H5b non-queen hive-wide broadcast
 * detector (coord-authority-hardening-2026-07-11 P-010 / WI-4175).
 *
 * Mirrors reply-deadline-sweep.test.ts: mocks the DB (a canned row set
 * standing in for the SELECT; a call recorder for the audit INSERT — the
 * SELECT itself mirrors the proven JSONB-predicate style and its
 * queen/system/dedupe exclusions live in SQL, asserted here only via the
 * bound values) and the notice effect (sendMessage), pinning the
 * ORCHESTRATION contract: audit row + owner one-liner per detection,
 * related_msg_id as the idempotency marker, audit-before-notice ordering,
 * batch/truncated accounting, and per-item fail-soft isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** every sql`` invocation: { text, values } (text joined with $n slots) */
  sqlCalls: [] as { text: string; values: unknown[] }[],
  auditFailure: null as Error | null,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('$');
        h.sqlCalls.push({ text, values });
        if (/INSERT INTO harness_shared\.audit_log/i.test(text)) {
          return h.auditFailure ? Promise.reject(h.auditFailure) : Promise.resolve([]);
        }
        return Promise.resolve(h.rows);
      },
      { begin: vi.fn(), unsafe: vi.fn(), json: (v: unknown) => v },
    ),
  }),
}));

vi.mock('./messages', () => ({ sendMessage: vi.fn(async () => undefined) }));

import { sendMessage } from './messages';
import {
  runAllPotBroadcastSweepOnce,
  ALLPOT_SWEEP_OWNER,
  ALLPOT_SWEEP_BATCH_LIMIT,
  ALLPOT_SWEEP_LOOKBACK_MS,
  ALLPOT_AUDIT_ACTION,
} from './allpot-broadcast-sweep';

const NOW = Date.parse('2026-07-11T12:00:00Z');

function row(over: Partial<{
  workspace_id: string;
  msg_id: string;
  from_id: string;
  summary: string | null;
  authority: string | null;
  sent_at: string | null;
}> = {}) {
  return {
    workspace_id: 'default',
    msg_id: 'm-blast-1',
    from_id: 'su-rogue-leader',
    summary: 'ALL AGENTS: stop work now',
    authority: 'fleet-leader',
    sent_at: '2026-07-11T11:30:00Z',
    ...over,
  };
}

function auditInserts() {
  return h.sqlCalls.filter((c) => /INSERT INTO harness_shared\.audit_log/i.test(c.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.sqlCalls = [];
  h.auditFailure = null;
});

describe('runAllPotBroadcastSweepOnce', () => {
  it('is a no-op when nothing unflagged exists', async () => {
    h.rows = [];
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ detected: 0, notified: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(auditInserts()).toHaveLength(0);
  });

  it('writes the audit row AND sends the owner one-liner, marker = related_msg_id', async () => {
    h.rows = [row()];
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ detected: 1, notified: 1, truncated: false });

    // Audit row: actor = the OFFENDING sender, subject = the broadcast msg_id.
    const inserts = auditInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain('su-rogue-leader');
    expect(inserts[0].values).toContain(ALLPOT_AUDIT_ACTION);
    expect(inserts[0].values).toContain('m-blast-1');
    expect(inserts[0].values).toContain('default'); // workspace_id from the row
    // The details payload must travel as a JSON STRING with a ::jsonb cast —
    // NOT sql.json(), which mis-binds/throws on the prepare:false org pool
    // (caught live by coord-authority-hardening.integration.test.ts; this
    // pins the shape so a revert fails here too, without a DB).
    expect(inserts[0].text).toContain('::jsonb');
    expect(inserts[0].values.some((v) => typeof v === 'string' && v.includes('"detected_by"'))).toBe(true);

    // Owner notice: to ['human'], from the sweep identity, carrying the
    // original msg_id as related_msg_id — the idempotency marker the SQL
    // NOT EXISTS dedupe (scoped to this sweep's from) keys on.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(identity.ownerId).toBe(ALLPOT_SWEEP_OWNER);
    expect(opts.to).toEqual(['human']);
    expect(opts.related_msg_id).toBe('m-blast-1');
    expect(opts.summary).toContain('su-rogue-leader');
    expect(opts.summary).toContain('ALL AGENTS: stop work now');
    expect(opts.summary).toContain('m-blast-1');
    expect(opts.body).toContain('fleet-leader'); // the stamped (non-queen) authority
    expect(opts.body).toContain(ALLPOT_AUDIT_ACTION);
  });

  it('an unstamped sender is reported as carrying no hive-queen stamp', async () => {
    h.rows = [row({ authority: null })];
    await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.body).toContain('no hive-queen authority stamp');
  });

  it('audit-before-notice: an audit failure suppresses the notice, so the item stays selectable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row()];
    h.auditFailure = new Error('audit db down');
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ detected: 1, notified: 0, truncated: false });
    // No notice sent ⇒ no marker landed ⇒ the next tick retries BOTH legs.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a sendMessage failure on one item never blocks the rest (fail-soft)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.rows = [row({ msg_id: 'bad' }), row({ msg_id: 'good' })];
    (sendMessage as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => undefined);
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ detected: 2, notified: 1, truncated: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips a row with no resolvable `from` instead of throwing', async () => {
    h.rows = [row({ from_id: undefined as unknown as string })];
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    expect(result).toEqual({ detected: 0, notified: 0, truncated: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('respects the batch limit and reports truncated:true when more remain', async () => {
    h.rows = [row({ msg_id: 'a' }), row({ msg_id: 'b' }), row({ msg_id: 'c' })];
    const result = await runAllPotBroadcastSweepOnce({ nowMs: NOW, limit: 2 });
    expect(result).toEqual({ detected: 3, notified: 2, truncated: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('binds the lookback watermark + the sweep identity into the SELECT', async () => {
    h.rows = [];
    await runAllPotBroadcastSweepOnce({ nowMs: NOW, lookbackMs: 60_000 });
    const selects = h.sqlCalls.filter((c) => /FROM harness_shared\.coord_event_log/i.test(c.text));
    expect(selects).toHaveLength(1);
    expect(selects[0].values).toContain(NOW - 60_000); // the ts window bound
    expect(selects[0].values).toContain(ALLPOT_SWEEP_OWNER); // the dedupe scope
    // The FLAG scope (the conscious allHive claim — NOT every literal '*',
    // which is routine solo-agent traffic) is bound as a value.
    expect(selects[0].values).toContain('allHiveBroadcast');
    // The static predicates (queen exemption / system exemption / the
    // mig-576-index-matching '*'/kind clauses) live in the SQL text — pin
    // them so an accidental predicate drop fails a test, not just live
    // behavior.
    expect(selects[0].text).toContain(`'hive-queen'`);
    expect(selects[0].text).toContain(`NOT LIKE 'system%'`);
    expect(selects[0].text).toContain(`'["*"]'::jsonb`);
    expect(selects[0].text).toContain(`->>'kind'`);
    expect(ALLPOT_SWEEP_BATCH_LIMIT).toBeGreaterThan(0);
    expect(ALLPOT_SWEEP_LOOKBACK_MS).toBeGreaterThan(0);
  });

  it('clamps an over-long offending summary to one line in the notice', async () => {
    h.rows = [row({ summary: `URGENT ${'x'.repeat(400)}\nsecond line` })];
    await runAllPotBroadcastSweepOnce({ nowMs: NOW });
    const [, opts] = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary.length).toBeLessThan(300);
    expect(opts.summary).not.toContain('\n');
    expect(opts.summary).toContain('…');
  });
});
