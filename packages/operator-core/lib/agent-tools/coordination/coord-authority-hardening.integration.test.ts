/**
 * coord-authority-hardening.integration.test.ts — the P-010/P-011 moving pieces
 * against REAL Postgres (baseline-schema DB), covering exactly what the unit
 * suites CANNOT: the PG fast paths and the cross-piece interactions.
 *
 * Unit coverage (allpot-broadcast-sweep.test.ts, retraction.test.ts,
 * tools/retract.test.ts, inbox-retraction-suppression.test.ts, feed.test.ts)
 * exercises orchestration with the DB mocked and the seam-read fallbacks. This
 * file pins the layers those mocks stand in for:
 *   • coord:retract HANDLER end-to-end: real getMessageById (PG fast path),
 *     real findExistingRetraction (the `body->>'retracts'` SQL), real notice
 *     write, real readInbox suppression (the recipient-pushdown branch);
 *   • readInbox fast-path parity WITH suppression vs the authoritative
 *     full-scan reference;
 *   • readCoordFeed + readThread against real bounded-cursor reads;
 *   • the allpot sweep's REAL SELECT (jsonb predicates, queen/system/flag/
 *     kind exclusions, lookback window, NOT EXISTS dedupe) + REAL audit INSERT
 *     against the live audit_log schema;
 *   • the retract↔detector interaction: a retraction notice for a '*' blast is
 *     itself exempt from H5b, and retracting a broadcast does NOT erase the
 *     incident from the detector;
 *   • mig-576 partial index present in the migration baseline.
 *
 * Run: cd packages/operator-core && npx vitest run -c vitest.integration.config.ts \
 *        lib/agent-tools/coordination/coord-authority-hardening.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock in this file: the tool handler's caller identity (there is no
// real MCP ctx in a test). Everything else — messages, log, presence, feed,
// the sweep — runs for real against the baseline DB.
vi.mock('./identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identity')>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'someone', workspaceId: null })),
}));

import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { filterInbox, type CoordEnvelope } from '@papercusp/coordination/core';
import { coordLog } from './log';
import { readInbox, readThread } from './messages';
import { readCoordFeed } from './feed';
import { resolveAgentIdentity } from './identity';
import { RETRACTS_FIELD, suppressRetracted, collectRetractedIds } from './retraction';
import {
  runAllPotBroadcastSweepOnce,
  ALLPOT_SWEEP_OWNER,
  ALLPOT_AUDIT_ACTION,
} from './allpot-broadcast-sweep';
import { ALLHIVE_BROADCAST_FIELD } from './scope-broadcast';

const identityM = vi.mocked(resolveAgentIdentity);
const retractTool = (await import('./tools/retract')).default;
const { RETRACT_NOTICE_OWNER } = await import('./tools/retract');

type ToolResult = { isError?: boolean; content: [{ type: 'text'; text: string }] };
async function retract(args: Record<string, unknown>, as: string) {
  identityM.mockReturnValue({ ownerId: as, workspaceId: null } as never);
  const res = (await retractTool.handler(args as never, {} as never)) as ToolResult;
  return { ...JSON.parse(res.content[0].text), isError: res.isError === true };
}

let fx: BaselineCoordFixture;

/** Append one raw envelope to the messages surface (read-path tests own their
 *  exact bodies; the retract NOTICE, by contrast, is written by the real tool). */
async function seed(env: Partial<CoordEnvelope> & { msg_id: string; from: string }): Promise<void> {
  const full = {
    kind: 'message',
    ts: new Date().toISOString(),
    summary: env.msg_id,
    to: [],
    ...env,
  } as unknown as CoordEnvelope;
  await coordLog.appendLine('messages', env.from, full);
}

const ids = (envs: { msg_id: string }[]): string[] => envs.map((e) => e.msg_id);

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.audit_log WHERE action = ${ALLPOT_AUDIT_ACTION}`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`DELETE FROM harness_shared.audit_log WHERE action = ${ALLPOT_AUDIT_ACTION}`;
});

// ───────────────────────── P-011 coord:retract — real PG ─────────────────────────

describe('coord:retract end-to-end (PG fast paths)', () => {
  it('sender retracts: durable notice row lands; readInbox (pushdown branch) suppresses the original for every recipient', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob', 'carol'], summary: 'WRONG: stop work' });
    await seed({ msg_id: 'm-ok', from: 'sender-1', to: ['bob'] });

    const out = await retract({ msg_id: 'm-bad', reason: 'mis-sent' }, 'sender-1');
    expect(out).toMatchObject({ ok: true, retracted: true, invokedAs: 'sender', audience: ['bob', 'carol'] });

    // The notice is a REAL row carrying the marker (the durable "marked retracted" state).
    const noticeRows = await fx.admin`
      SELECT body FROM harness_shared.coord_event_log
       WHERE surface = 'messages' AND body->>${RETRACTS_FIELD} = 'm-bad'
    `;
    expect(noticeRows).toHaveLength(1);
    const notice = noticeRows[0].body as CoordEnvelope;
    expect(notice.from).toBe(RETRACT_NOTICE_OWNER);
    expect(notice.related_msg_id).toBe('m-bad');
    expect(notice.to).toEqual(['bob', 'carol']); // original audience verbatim

    // readInbox rides the real recipient-pushdown SQL here — suppression applied on it.
    const bobInbox = await readInbox('bob');
    expect(ids(bobInbox)).not.toContain('m-bad');
    expect(ids(bobInbox)).toContain('m-ok');
    expect(ids(bobInbox)).toContain(notice.msg_id); // the "disregard that" line survives
    expect(ids(await readInbox('carol'))).not.toContain('m-bad');
  });

  it('idempotency rides the REAL findExistingRetraction SQL: second retract → alreadyRetracted, no duplicate notice', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob'] });
    expect((await retract({ msg_id: 'm-bad' }, 'sender-1')).retracted).toBe(true);

    const again = await retract({ msg_id: 'm-bad' }, 'sender-1');
    expect(again).toMatchObject({ ok: true, alreadyRetracted: true });
    // …even for a caller who could never pass the guard (idempotency before guard).
    const stranger = await retract({ msg_id: 'm-bad' }, 'random-peer');
    expect(stranger).toMatchObject({ ok: true, alreadyRetracted: true });

    const notices = await fx.admin`
      SELECT 1 FROM harness_shared.coord_event_log
       WHERE surface = 'messages' AND body->>${RETRACTS_FIELD} = 'm-bad'
    `;
    expect(notices).toHaveLength(1);
  });

  it('an unauthorized caller is refused and writes NOTHING', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob'] });
    const before = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.coord_event_log`;
    const out = await retract({ msg_id: 'm-bad' }, 'random-peer');
    expect(out.isError).toBe(true);
    expect(out.error).toBe('not_authorized');
    const after = await fx.admin`SELECT count(*)::int AS n FROM harness_shared.coord_event_log`;
    expect(after[0].n).toBe(before[0].n);
  });

  it('the REAL notice row cannot itself be retracted (getMessageById PG fast path → cannot_retract_retraction)', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob'] });
    const first = await retract({ msg_id: 'm-bad' }, 'sender-1');
    const out = await retract({ msg_id: first.notice_msg_id }, 'sender-1');
    expect(out.isError).toBe(true);
    expect(out.error).toBe('cannot_retract_retraction');
  });

  it('readInbox fast path stays byte-identical to the authoritative reference WITH suppression', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob'] });
    await seed({ msg_id: 'm-ok', from: 'carol', to: ['bob'] });
    await seed({ msg_id: 'm-bcast', from: 'dave', to: ['*'] });
    await retract({ msg_id: 'm-bad' }, 'sender-1');

    const got = await readInbox('bob');
    const lines = await coordLog.readLines('messages');
    const reference = suppressRetracted(filterInbox(lines, 'bob', {}), collectRetractedIds(lines));
    expect(ids(got)).toEqual(ids(reference));
    expect(ids(got)).not.toContain('m-bad');
  });

  it('readCoordFeed (real bounded-cursor reads): suppressed by default, includeRetracted is the escape hatch, coord:thread shows BOTH', async () => {
    await seed({ msg_id: 'm-bad', from: 'sender-1', to: ['bob'], summary: 'WRONG directive' });
    const first = await retract({ msg_id: 'm-bad' }, 'sender-1');

    const feed = await readCoordFeed({});
    expect(ids(feed.rows)).not.toContain('m-bad');
    expect(ids(feed.rows)).toContain(first.notice_msg_id);

    const forensic = await readCoordFeed({ includeRetracted: true });
    expect(ids(forensic.rows)).toContain('m-bad');
    expect(ids(forensic.rows)).toContain(first.notice_msg_id);

    // coord:thread is deliberately unsuppressed (forensics): original + notice.
    const thread = await readThread('m-bad');
    expect(ids(thread)).toEqual(expect.arrayContaining(['m-bad', first.notice_msg_id]));
  });
});

// ───────────────────────── P-010 allpot sweep — real PG ─────────────────────────

describe('allpot-broadcast-sweep against the real schema', () => {
  const offender = (over: Partial<CoordEnvelope> = {}) =>
    seed({
      msg_id: over.msg_id ?? 'm-blast',
      from: (over.from as string) ?? 'su-rogue-leader',
      to: ['*'],
      summary: 'ALL AGENTS: stop work now',
      [ALLHIVE_BROADCAST_FIELD]: true,
      cueAuthority: { authority: 'fleet-leader' },
      ...over,
    });

  it('detects a flagged non-queen blast: REAL audit_log row + owner notice row; second pass dedupes via the REAL NOT EXISTS', async () => {
    await offender();
    const r1 = await runAllPotBroadcastSweepOnce();
    expect(r1).toEqual({ detected: 1, notified: 1, truncated: false });

    const audit = await fx.admin`
      SELECT actor, action, subject FROM harness_shared.audit_log WHERE action = ${ALLPOT_AUDIT_ACTION}
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'su-rogue-leader', subject: 'm-blast' });

    const notice = await fx.admin`
      SELECT body FROM harness_shared.coord_event_log
       WHERE surface = 'messages' AND body->>'from' = ${ALLPOT_SWEEP_OWNER}
         AND body->>'related_msg_id' = 'm-blast'
    `;
    expect(notice).toHaveLength(1);
    expect((notice[0].body as CoordEnvelope).to).toEqual(['human']);

    // Idempotency in the real SQL: the notice row IS the marker.
    const r2 = await runAllPotBroadcastSweepOnce();
    expect(r2).toEqual({ detected: 0, notified: 0, truncated: false });
  });

  it('exclusions hold in the real SQL: queen stamp, system principal, unflagged bare *, flagged-but-directed, non-message kind', async () => {
    await offender({ msg_id: 'q1', cueAuthority: { authority: 'hive-queen' } });
    await offender({ msg_id: 's1', from: 'system:watchdog' });
    await seed({ msg_id: 'u1', from: 'su-solo', to: ['*'], summary: 'routine solo broadcast' }); // no flag
    await offender({ msg_id: 'd1', to: ['bob'] }); // flag but not '*'
    await offender({ msg_id: 'k1', kind: 'plan_event' as CoordEnvelope['kind'] }); // wrong kind
    const r = await runAllPotBroadcastSweepOnce();
    expect(r).toEqual({ detected: 0, notified: 0, truncated: false });
    expect(await fx.admin`SELECT 1 FROM harness_shared.audit_log WHERE action = ${ALLPOT_AUDIT_ACTION}`).toHaveLength(0);
  });

  it('the lookback window bounds the real ts range scan', async () => {
    await offender();
    // Window [now+59s, now+60s] — the just-inserted row (ts ≈ now) falls outside.
    const r = await runAllPotBroadcastSweepOnce({ nowMs: Date.now() + 60_000, lookbackMs: 1_000 });
    expect(r.detected).toBe(0);
  });

  it('INTERACTION: retracting a * blast — the system retraction notice is exempt from H5b, and the incident is NOT erased from the detector', async () => {
    await offender({ from: 'su-rogue-leader' });

    // The rogue sender cleans up their own blast (the EI-9501 cleanup path).
    const out = await retract({ msg_id: 'm-blast', reason: 'EI-9501 cleanup' }, 'su-rogue-leader');
    expect(out).toMatchObject({ ok: true, retracted: true, audience: ['*'] });

    // The retraction notice went to ['*'] from system:coord-retract — the sweep
    // must NOT flag it (system exemption + no allHiveBroadcast stamp)…
    const r = await runAllPotBroadcastSweepOnce();
    // …while the ORIGINAL blast is STILL detected: retraction withdraws the
    // message from readers, it does not erase the authority incident (the
    // retraction notice is not a sweep marker — dedupe is scoped to the
    // sweep's own from).
    expect(r).toEqual({ detected: 1, notified: 1, truncated: false });
    const audit = await fx.admin`
      SELECT actor, subject FROM harness_shared.audit_log WHERE action = ${ALLPOT_AUDIT_ACTION}
    `;
    expect(audit).toEqual([expect.objectContaining({ actor: 'su-rogue-leader', subject: 'm-blast' })]);

    // And the retracted blast stays suppressed for readers even as the audit trail keeps it.
    expect(ids(await readInbox('anybody'))).not.toContain('m-blast');
  });

  it('mig 576: the partial index is part of the migration baseline', async () => {
    const idx = await fx.admin`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'harness_shared' AND indexname = 'coord_event_log_allhive_broadcast'
    `;
    expect(idx).toHaveLength(1);
  });
});
