import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { fleetProductivityRescore, measureFleetProductivity } from './execution-productivity';
import * as database from '@papercusp/db-org';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import { getRegisteredInstrument } from '../rubric-instrument-registry';

let db: OrgTestDb;
const start = '2026-10-01T00:00:00Z', end = '2026-10-02T00:00:00Z';
const window = { workspaceId: 'ws-productivity', harnessSlug: 'productivity-h', fleet: 'fleet-a',
  windowStart: start, windowEnd: end };

beforeAll(async () => {
  db = await createOrgTestDb();
  for (const [workspace, fleet, owner, role, at] of [
    [window.workspaceId, 'fleet-a', 'old-member', 'member', '2026-09-01T00:00:00Z'],
    [window.workspaceId, 'fleet-a', 'inactive', 'member', '2026-09-02T00:00:00Z'],
    [window.workspaceId, 'fleet-a', 'leader', 'member', '2026-09-01T00:00:00Z'],
    [window.workspaceId, 'fleet-a', 'leader', 'leader', '2026-09-03T00:00:00Z'],
    [window.workspaceId, 'fleet-a', 'at-end', 'member', end],
    [window.workspaceId, 'fleet-b', 'other-fleet', 'member', start],
    ['other-ws', 'fleet-a', 'other-workspace', 'member', start],
  ]) await db.adminSql`INSERT INTO harness_shared.fleet_membership_events
    (workspace_id, fleet_slug, owner_id, fleet_role, event, at)
    VALUES (${workspace}, ${fleet}, ${owner}, ${role}, 'join', ${at}::timestamptz)`;
  await db.adminSql`INSERT INTO harness_shared.fleet_membership_events
    (workspace_id, fleet_slug, owner_id, fleet_role, event, at)
    VALUES (${window.workspaceId}, 'fleet-a', 'old-member', 'member', 'leave', ${start}::timestamptz)`;
  for (const [owner, workspace, at] of [
    ['old-member', window.workspaceId, start], ['old-member', window.workspaceId, '2026-10-01T00:01:00Z'],
    ['old-member', window.workspaceId, '2026-10-01T00:15:00Z'], ['old-member', window.workspaceId, '2026-10-01T00:30:00Z'],
    ['old-member', window.workspaceId, '2026-09-30T23:59:59Z'], ['old-member', window.workspaceId, end],
    ['old-member', 'other-ws', '2026-10-01T00:45:00Z'],
    ['leader', window.workspaceId, start], ['other-fleet', window.workspaceId, start],
  ]) await db.adminSql`INSERT INTO harness_shared.tool_invocations
    (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, coord_owner_id, invoked_at)
    VALUES (${workspace}, 'other-tool-harness', 'fixture', 'fixture:call', 'su', 'fixture', 'fixture', 'ok', ${owner}, ${at}::timestamptz)`;
  for (const [id, owner, workspace, harness, status, at, lane] of [
    ['start', 'old-member', window.workspaceId, window.harnessSlug, 'done', start, null],
    ['in-1', 'old-member', window.workspaceId, window.harnessSlug, 'resolved', '2026-10-01T01:00:00Z', null],
    ['in-2', 'old-member', window.workspaceId, window.harnessSlug, 'closed', '2026-10-01T02:00:00Z', null],
    ['in-3', 'old-member', window.workspaceId, window.harnessSlug, 'done', '2026-10-01T03:00:00Z', null],
    ['in-4', 'old-member', window.workspaceId, window.harnessSlug, 'done', '2026-10-01T04:00:00Z', null],
    ['end', 'old-member', window.workspaceId, window.harnessSlug, 'done', end, null],
    ['drop', 'old-member', window.workspaceId, window.harnessSlug, 'dropped', start, null],
    ['observation', 'old-member', window.workspaceId, window.harnessSlug, 'done', start, 'observation'],
    ['leader', 'leader', window.workspaceId, window.harnessSlug, 'done', start, null],
    ['fleet', 'other-fleet', window.workspaceId, window.harnessSlug, 'done', start, null],
    ['workspace', 'old-member', 'other-ws', window.harnessSlug, 'done', start, null],
    ['harness', 'old-member', window.workspaceId, 'other-harness', 'done', start, null],
  ]) await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, status, terminal_owner, closed_ts, payload)
    VALUES (${workspace}, ${harness}, ${id}, ${status}, ${owner}, ${Date.parse(at!)}, ${db.adminSql.json(lane ? { lane } : {})})`;
  await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, status, taken_by, taken_at)
    VALUES (${window.workspaceId}, ${window.harnessSlug}, 'held', 'open', 'old-member', '2026-09-30T12:00:00Z')`;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('real fleet productivity source populations', () => {
  it('includes old joiners, deduplicates activity buckets, excludes leaders/drops/observations and bounds every source', async () => {
    const m = await measureFleetProductivity(window, db.adminSql);
    expect(m.unavailableReason).toBeUndefined();
    expect(m.members.map(r => r.ownerId)).toEqual(['at-end', 'inactive', 'old-member']);
    expect(m.totals).toMatchObject({ activeSeatHours: 1, closes: 6, currentHeldItems: 1, currentHeldWindowHours: 24 });
    expect(m.claimHours.historicalWindowEndVerified).toBe(false);
  });

  it('separates fleet, workspace, harness and observation windows without consulting a current roster', async () => {
    const other = await measureFleetProductivity({ ...window, fleet: 'fleet-b' }, db.adminSql);
    expect(other.members.map(r => r.ownerId)).toEqual(['other-fleet']); expect(other.totals.closes).toBe(1);
    const harness = await measureFleetProductivity({ ...window, harnessSlug: 'other-harness' }, db.adminSql);
    expect(harness.totals.closes).toBe(1);
    const workspace = await measureFleetProductivity({ ...window, workspaceId: 'other-ws' }, db.adminSql);
    expect(workspace.members.map(r => r.ownerId)).toEqual(['other-workspace']);
    const later = await measureFleetProductivity({ ...window, windowStart: end, windowEnd: '2026-10-03T00:00:00Z' }, db.adminSql);
    expect(later.totals).toMatchObject({ closes: 1, activeSeatHours: 0.25 });
  });

  it('executes the registered resolver and preserves unknown historical claim-hours instead of certifying only its throughput', async () => {
    const spy = vi.spyOn(database, 'getOrgPg');
    mockOrgPgSql(vi.mocked(database.getOrgPg), db.adminSql);
    try {
      expect(getRegisteredInstrument('fleet:member-productivity')).toMatchObject({ evaluator: 'platform', rescore: { scope: 'subject' } });
      const result = await fleetProductivityRescore().resolve({ ...window, subject: { kind: 'fleet', ref: window.fleet } });
      expect(result.verdict).toBe('unknown'); expect(result).not.toHaveProperty('value');
      const details = JSON.parse(result.detail);
      expect(details.throughput.rating).toBe('healthy');
      expect(details.missingSubchecks).toEqual(['historical claimed-but-unclosed item-hours']);
      expect(details.totals.closes).toBe(6); expect(result.evidenceRefs).toHaveLength(3);
      expect(details.claimHours.retainedHistory).toMatchObject({ observedCandidates: 1,
        classificationCounts: { 'no-observed-transition-before-cutoff': 1 }, qualifiesHistoricalTotal: false });
    } finally { spy.mockRestore(); }
  });

  it('reads historical candidates through the exact workspace/harness and keeps remote, ambiguous and oversized histories unqualified', async () => {
    const events = [{ owner: 'other', at: '2026-09-30T23:00:00Z' },
      { owner: 'old-member', at: '2026-10-01T01:00:00Z' }];
    const rows = [
      ['qualified', window.workspaceId, window.harnessSlug, 'local', 'old-member', events, null],
      ['remote', window.workspaceId, window.harnessSlug, 'remote', 'old-member', events, null],
      ['remote-issue', window.workspaceId, window.harnessSlug, 'remote:engineer-issues', 'old-member', events, null],
      ['remote-feature', window.workspaceId, window.harnessSlug, 'remote:features-by-id', 'old-member', events, null],
      ['remote-future', window.workspaceId, window.harnessSlug, 'remote:future-projection', 'old-member', events, null],
      ['ambiguous', window.workspaceId, window.harnessSlug, 'local', 'other',
        [{ owner: 'old-member', at: start }, { owner: 'other', at: '2026-10-02T01:00:00Z' }], null],
      ['oversized', window.workspaceId, window.harnessSlug, 'local', 'old-member', Array(1025).fill(events[1]), null],
      ['history-workspace', 'other-ws', window.harnessSlug, 'local', 'old-member', events, null],
      ['history-harness', window.workspaceId, 'other-harness', 'local', 'old-member', events, null],
      ['history-observation', window.workspaceId, window.harnessSlug, 'local', 'old-member', events, 'observation'],
      ['history-leader', window.workspaceId, window.harnessSlug, 'local', 'leader',
        [{ owner: 'leader', at: start }], null],
    ] as const;
    try {
      for (const [id, workspace, harness, origin, holder, history, lane] of rows) {
        await db.adminSql`INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, status, origin, taken_by, taken_at, worked_by_history, payload)
          VALUES (${workspace}, ${harness}, ${id}, 'open', ${origin}, ${holder}, ${start}::timestamptz,
            ${db.adminSql.json(history)}, ${db.adminSql.json(lane ? { lane } : {})})`;
      }
      const m = await measureFleetProductivity(window, db.adminSql);
      expect(m.claimHours.retainedHistory).toMatchObject({ observedCandidates: 8, candidateSetComplete: true,
        classificationCounts: { 'no-observed-transition-before-cutoff': 1, 'retained-history-member-held': 1,
          'remote-history-unqualified': 4, 'cutoff-phase-ambiguous': 1, 'truncated-history-unqualified': 1 },
        conditionalMemberHeldItems: 1, conditionalMemberHeldWindowHours: 23,
        historicalPopulationVerified: false, terminalStateAtCutoffVerified: false, qualifiesHistoricalTotal: false });
    } finally {
      await db.adminSql`DELETE FROM harness_shared.work_items WHERE feature_id IN ${db.adminSql(rows.map(r => r[0]))}`;
    }
  });
});
