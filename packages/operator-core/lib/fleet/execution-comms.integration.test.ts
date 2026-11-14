import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import * as database from '@papercusp/db-org';
import { FLEET_COMMS_KEY, fleetCommsRescore, measureFleetComms, rateFleetComms } from './execution-comms';

let db: OrgTestDb;
const start = '2026-10-01T00:00:00Z', end = '2026-10-02T00:00:00Z';
const window = { workspaceId: 'ws-comms', harnessSlug: 'comms-h', fleet: 'fleet-a', windowStart: start, windowEnd: end };

beforeAll(async () => {
  db = await createOrgTestDb();
  for (const [workspace, fleet, owner, role, at] of [
    ['ws-comms', 'fleet-a', 'old-member', 'member', '2026-09-01T00:00:00Z'],
    ['default', 'fleet-a', 'legacy-member', 'member', '2026-09-01T00:00:00Z'],
    ['ws-comms', 'fleet-a', 'leader', 'member', start], ['ws-comms', 'fleet-a', 'leader', 'leader', start],
    ['ws-comms', 'fleet-b', 'other-fleet', 'member', start], ['other-ws', 'fleet-a', 'other-workspace', 'member', start],
    ['ws-comms', 'fleet-a', 'future-member', 'member', '2026-10-03T00:00:00Z'],
    // Same-owner carry/rejoin is one ever-member, not a duplicate message source.
    ['ws-comms', 'fleet-a', 'old-member', 'member', start],
  ]) await db.adminSql`INSERT INTO harness_shared.fleet_membership_events
    (workspace_id,fleet_slug,owner_id,fleet_role,event,at)
    VALUES (${workspace},${fleet},${owner},${role},'join',${at}::timestamptz)`;

  const base = { kind: 'message', to: ['peer'], expects: 'none' };
  const messages = [
    ['start', 'ws-comms', 'old-member', start, { ...base, summary: 'same', body: 'one', audience: ['@fleet:fleet-a'], to: ['expanded-1', 'expanded-2'] }],
    ['duplicate', 'ws-comms', 'old-member', '2026-10-01T01:00:00Z', { ...base, summary: 'same', body: 'two' }],
    ['legacy', 'default', 'legacy-member', start, { ...base, summary: 'legacy', body: 'three' }],
    ['leader', 'ws-comms', 'leader', start, { ...base, summary: 'leader', body: 'four' }],
    ['auto', 'ws-comms', 'old-member', start, { ...base, auto: true }],
    ['provenance', 'ws-comms', 'old-member', start, { ...base, fieldProvenance: { expects: 'system-emitter-derived' } }],
    ['ack', 'ws-comms', 'old-member', start, { ...base, kind: 'ack' }],
    ['before', 'ws-comms', 'old-member', '2026-09-30T23:59:59Z', base],
    ['at-end', 'ws-comms', 'old-member', end, base],
    ['other-fleet', 'ws-comms', 'other-fleet', start, base],
    ['other-workspace', 'other-ws', 'old-member', start, base],
    ['future-member', 'ws-comms', 'future-member', start, base],
  ] as const;
  for (const [id, workspace, owner, at, body] of messages) await db.adminSql`INSERT INTO harness_shared.coord_event_log
    (workspace_id,surface,writer_key,msg_id,ts,body)
    VALUES (${workspace},'messages',${owner},${id},${at}::timestamptz,${db.adminSql.json(body)})`;

  for (const [id, workspace, owner, status, at, lane] of [
    ['close-start', 'ws-comms', 'old-member', 'done', start, null],
    ['close-end', 'ws-comms', 'old-member', 'resolved', end, null],
    ['legacy-close', 'default', 'legacy-member', 'closed', start, null],
    ['leader-close', 'ws-comms', 'leader', 'done', start, null],
    ['dropped', 'ws-comms', 'old-member', 'dropped', start, null],
    ['observation', 'ws-comms', 'old-member', 'done', start, 'observation'],
    ['wrong-workspace', 'other-ws', 'old-member', 'done', start, null],
    ['wrong-fleet', 'ws-comms', 'other-fleet', 'done', start, null],
  ] as const) await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,status,terminal_owner,closed_ts,payload)
    VALUES (${workspace},'other-work-harness',${id},${status},${owner},${Date.parse(at)},${db.adminSql.json(lane ? { lane } : {})})`;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('real exact fleet communication sources', () => {
  it('keeps both ever-member populations, excludes system emissions and retains the writer audience', async () => {
    const m = await measureFleetComms(window, db.adminSql);
    expect(m.unavailableReason).toBeNull();
    expect(m.source).toMatchObject({ members: 3, nonleaders: 2, messages: 7, closes: 3 });
    expect(m.cohorts.allDeclaredMembers).toMatchObject({ raw: 7, authored: 4, excluded: 3 });
    expect(m.cohorts.nonleaderMembers).toMatchObject({ raw: 6, authored: 3, excluded: 3,
      messagesPerTerminalClose: 1, routes: { 'this-fleet-selector': 1, directed: 2 },
      duplicateBeyondFirst: 1, duplicateParticipants: 2 });
    expect(m.cohorts.nonleaderMembers.lifecycleHeuristic.total).toBe(3);
    expect(rateFleetComms(m).rating).toBe('degraded');
  });

  it('separates fleet, workspace and window while keeping all-harness terminal scope explicit', async () => {
    const other = await measureFleetComms({ ...window, fleet: 'fleet-b' }, db.adminSql);
    expect(other.source).toMatchObject({ members: 1, nonleaders: 1, messages: 1, closes: 1 });
    const later = await measureFleetComms({ ...window, windowStart: end, windowEnd: '2026-10-03T00:00:00Z' }, db.adminSql);
    expect(later.source.messages).toBe(1); // previous window's excluded endpoint
    const absent = await measureFleetComms({ ...window, workspaceId: 'absent-ws', fleet: 'absent-fleet' }, db.adminSql);
    expect(rateFleetComms(absent).rating).toBe('unknown');
    expect(other.closeScope).toContain('all harnesses');
  });

  it('resolves the registered subject instrument with numeric severity and source evidence', async () => {
    const spy = vi.spyOn(database, 'getOrgPg').mockReturnValue({ sql: db.adminSql } as never);
    try {
      expect(getRegisteredInstrument(FLEET_COMMS_KEY)).toMatchObject({ evaluator: 'platform', rescore: { scope: 'subject' } });
      const result = await fleetCommsRescore().resolve({ ...window, subject: { kind: 'fleet', ref: window.fleet } });
      expect(result).toMatchObject({ verdict: 'fail', value: 1 });
      expect(JSON.parse(result.detail).threshold.rating).toBe('degraded');
      expect(result.evidenceRefs).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });
});
