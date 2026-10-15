import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { measureWorkOverheadWindow, rateWorkOverhead } from './agent-work-overhead-metrics';

let db: FreshPgDb;
const window = { workspaceId: 'ws', harnessSlug: 'papercusp',
  windowStart: '2026-10-15T10:00:00Z', windowEnd: '2026-10-15T13:00:00Z' };

beforeAll(async () => {
  db = await createFreshPgDb('work-overhead');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL);
    CREATE TABLE harness_shared.adv_sessions (
      workspace_id text NOT NULL, plan_slug text, coord_owner_id text, session_id text,
      started_at timestamptz NOT NULL, ended_at timestamptz);
    CREATE TABLE harness_shared.session_turn_parts (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
      owner text, part_idx int NOT NULL, ts timestamptz, speaker text NOT NULL,
      part_kind text NOT NULL, tool_name text, text text NOT NULL,
      PRIMARY KEY(workspace_id,source_kind,session_id,part_idx));
  `);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.session_turn_parts, harness_shared.adv_sessions, harness_shared.harness_plans`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans VALUES
      ('ws','papercusp','plan'), ('foreign-ws','papercusp','plan'), ('ws','other-harness','other-plan')`;
  await db.sql`
    INSERT INTO harness_shared.adv_sessions VALUES
      ('ws','plan','stable-owner','native-a','2026-10-15T09:00:00Z',NULL),
      ('foreign-ws','plan','foreign-owner','foreign-native','2026-10-15T09:00:00Z',NULL),
      ('ws','other-plan','other-owner','other-native','2026-10-15T09:00:00Z',NULL)`;
  await db.sql`
    INSERT INTO harness_shared.session_turn_parts VALUES
      ('default','codex','native-a','stable-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','capability:read','{}'),
      ('ws','codex','native-a','stable-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-a','stable-owner',1,'2026-10-15T10:01:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-a','stable-owner',2,'2026-10-15T10:50:00Z','assistant','text',NULL,'done'),
      ('default','codex','native-b','stable-owner',0,'2026-10-15T11:00:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-b','stable-owner',1,'2026-10-15T11:01:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-b','stable-owner',2,'2026-10-15T12:10:00Z','assistant','text',NULL,'done'),
      ('default','codex','boundary','stable-owner',0,'2026-10-15T09:59:00Z','assistant','text',NULL,'before window'),
      ('default','codex','boundary','stable-owner',1,'2026-10-15T10:10:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','foreign-native','foreign-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','plans:audit','{}'),
      ('default','codex','other-native','other-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','plans:audit','{}')`;
});

describe('work-overhead query against real Postgres', () => {
  it('finds a native successor through owner/process membership, separates contexts and deduplicates partitions', async () => {
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.unavailableReason).toBeNull();
    expect(metrics.population).toMatchObject({ sessions: 2, boundarySessions: 1, toolCalls: 4,
      clients: { codex: 2 }, censoredSessions: 2 });
    expect(metrics.medianObservedSessionMinutes).toBe(60);
    expect(metrics.time).toMatchObject({ activeMs: 120_000, acceptanceMs: 0 });
    expect(rateWorkOverhead(metrics)).toMatchObject({ acceptanceShare: { verdict: 'pass' }, sessionMinutes: { verdict: 'pass' } });
  });
  it('excludes an event at the exclusive end and keeps a missing timestamp unknown', async () => {
    const beforeSuccessor = await measureWorkOverheadWindow({ ...window, windowEnd: '2026-10-15T11:00:00Z' }, db.sql);
    expect(beforeSuccessor.population.sessions).toBe(1);
    expect(beforeSuccessor.medianObservedSessionMinutes).toBe(50);
    await db.sql`
      INSERT INTO harness_shared.session_turn_parts VALUES
      ('default','codex','native-a','stable-owner',3,NULL,'assistant','tool_use','plans:audit','{}')`;
    const missing = await measureWorkOverheadWindow(window, db.sql);
    expect(missing.population.missingTimestampSessions).toBe(1);
    expect(rateWorkOverhead(missing).acceptanceShare.verdict).toBe('unknown');
  });
});
