/** Real process boundary for the canonical mission transaction integration test. */
import postgres from 'postgres';
import type { Sql } from 'postgres';
import type { MissionParent, MissionEvent } from '../../lib/mission-continuity';
import { applyMissionEvent, applyMissionEventInTransaction, readSessionMission } from '../../lib/session-brief-mission';

const [action, ownerId] = process.argv.slice(2);
if (!process.env.MISSION_CRASH_DB_URL || !process.env.MISSION_CRASH_PARENT || !ownerId) {
  throw new Error('mission crash fixture requires an isolated database and parent');
}
const sql = postgres(process.env.MISSION_CRASH_DB_URL, { prepare: false, max: 1 });
const identity = { ownerId, workspaceId: 'mission-test' };
const parent: MissionParent = JSON.parse(process.env.MISSION_CRASH_PARENT);
const done: MissionEvent = { id: 'done:repair', kind: 'child-ended', childRef: 'WI-repair', terminal: true };

try {
  if (action === 'read-and-replay') {
    const before = await readSessionMission(identity, sql);
    const [business] = await sql`SELECT state FROM harness_shared.mission_process_fixture WHERE owner_id=${ownerId}`;
    let after = null;
    if (business.state === 'done') {
      await applyMissionEvent(identity, done, async () => parent, { sql, nowMs: 4_000 });
      after = await readSessionMission(identity, sql);
    }
    console.log('MISSION-CRASH-READ:' + JSON.stringify({ pid: process.pid, businessState: business.state, before, after }));
  } else {
    if (!['commit', 'before-commit', 'after-commit'].includes(action)) throw new Error('unknown mission crash phase');
    await sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_process_fixture SET state='done' WHERE owner_id=${ownerId}`;
      await applyMissionEventInTransaction(tx, identity, done, async () => parent, 3_000);
      if (action === 'before-commit') process.kill(process.pid, 'SIGKILL');
    });
    if (action === 'after-commit') process.kill(process.pid, 'SIGKILL');
  }
} finally {
  await sql.end({ timeout: 5 });
}
