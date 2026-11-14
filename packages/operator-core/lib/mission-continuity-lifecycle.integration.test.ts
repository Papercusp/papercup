import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { acceptMissionActivityInTransaction, applyMissionEvent, applyMissionEventInTransaction, readCurrentMissionContinuity, readSessionMission, updateMissionOutboxInTransaction } from './session-brief-mission';
import type { MissionParent, MissionEvent } from './mission-continuity';
import { applySessionTaskOp, type SessionTaskOpArgs } from './session-tasks';
import { commitMissionTaskTransition } from './mission-continuity-task-acceptance';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, '../../../libs/papercusp/libs/db/sql');
let db: FreshPgDb;
const scope = (ownerId: string) => ({ ownerId, workspaceId: 'mission-test' });
const parent = (ownerId: string): MissionParent => ({
  assignmentRef: 'plan:main', ownerDirectiveRef: 'order:1', objectiveRefs: ['plan:main'],
  completionCriteriaRefs: ['plan:main#Requirements'], accountableOwner: ownerId, custodyGeneration: 1,
  assignmentRevision: 1, authorityRef: 'plan-start:1', disposition: 'ready', blockerRef: null, nextActionRef: 'P-002',
});
const select: MissionEvent = { id: 'select:repair', kind: 'activity-accepted', activity: {
  selectedRef: 'WI-repair', acceptedOperationRef: 'operation:repair', accepted: true, changesFocus: true,
  displacedContinuationRef: 'WI-step', relationship: 'blocking-repair', selectionRevision: 1,
} };
const done: MissionEvent = { id: 'done:repair', kind: 'child-ended', childRef: 'WI-repair', terminal: true };

async function seed(ownerId: string) {
  const p = parent(ownerId);
  await applyMissionEvent(scope(ownerId), { id: 'bind', kind: 'assignment-accepted', binding: p, currentWorkRef: 'WI-step' },
    async () => p, { sql: db.sql, nowMs: 1_000 });
  await applyMissionEvent(scope(ownerId), select, async () => p, { sql: db.sql, nowMs: 2_000 });
  return p;
}

beforeAll(async () => {
  db = await createFreshPgDb('mission-continuity');
  // Task migration 981 installs the canonical notification trigger.
  await applyMigrationForTest(db.sql, resolve(migrations, '1436-emit-change-notify-row-workspace.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '322-session-briefs-ei1742.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '1618-session-brief-mission-continuity.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '981-session-task-engine.sql'));
  await applyMigrationForTest(db.sql, resolve(migrations, '982-session-task-work-item-links.sql'));
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.owner_directives(id bigint PRIMARY KEY,workspace_id text,
      source_turn_ref text,captured_by_hook boolean,disposition_status text);
    CREATE TABLE harness_shared.work_items(feature_id text,harness_slug text,workspace_id text,
      source_plan_slug text,taken_by text,taken_at timestamptz,status text,directive_ref bigint,goal_id text);
    CREATE TABLE harness_shared.harness_plans(workspace_id text,harness_slug text,plan_slug text,
      status text,op_status text,execution_start_revision_seq integer);
    CREATE TABLE harness_shared.plan_revisions(workspace_id text,harness_slug text,plan_slug text,
      seq integer,content_snapshot text);
  `).simple();
  await db.sql`INSERT INTO harness_shared.owner_directives VALUES(31,'mission-test','owner-turn:31',true,null)`;
  await db.sql`INSERT INTO harness_shared.harness_plans VALUES('mission-test','eng','root','ready','started',7)`;
  await db.sql`INSERT INTO harness_shared.plan_revisions VALUES('mission-test','eng','root',7,
    ${JSON.stringify({schema:'plan-execution-start-v1',scope:{workspaceId:'mission-test',harnessSlug:'eng',planSlug:'root'},body:'accepted mission'})})`;
}, 90_000);
afterAll(async () => db?.cleanup());



async function seedTaskAuthority(ownerId: string, id: string, plan = 'root') {
  await db.sql`INSERT INTO harness_shared.work_items VALUES(${id},'eng','mission-test',${plan},${ownerId},
    '2026-11-06T00:00:00Z','open',31,null)`;
}
async function taskOp(ownerId: string, args: SessionTaskOpArgs, workItemId?: string, crash = false, appendId?: string) {
  return db.sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    return applySessionTaskOp(tx, { ...args,workspaceId:'mission-test',sessionId:ownerId,
      idFactory:()=>{if(appendId) return appendId; throw new Error('test task ids must be explicit');},now:'2026-11-06T00:00:00.000Z',
      bridge:{
        seedWorkItem:workItemId?{workItemId,workItemHarness:'eng',relation:'for'}:null,
        async commitTransition(port,before,result) {
          await commitMissionTaskTransition(port,scope(ownerId),ownerId,before,result,1_000);
          if(crash) throw new Error('injected acceptance commit crash');
        },
      },
    });
  });
}
async function mission(ownerId:string) {
  const result=await readSessionMission(scope(ownerId),db.sql);
  if(result.availability!=='available') throw new Error('missing mission');
  return result.envelope;
}
async function initTask(ownerId:string,id:string,workItemId:string) {
  await seedTaskAuthority(ownerId,workItemId);
  await taskOp(ownerId,{op:'append',content:'canonical step'},workItemId,false,id);
}

describe('canonical accepted task operations compose with retained mission state',()=>{
  it('binds automatically at acceptance and keeps the plan open after a child completes',async()=>{
    const owner='su-task-root';
    await initTask(owner,'a','WI-task-a');
    await initTask(owner,'b','WI-task-b');
    expect((await readSessionMission(scope(owner),db.sql)).availability).toBe('absent');
    await taskOp(owner,{op:'start',taskId:'a'});
    const first=await mission(owner);
    expect(first.state.binding).toMatchObject({assignmentRef:'plan:eng:root',ownerDirectiveRef:'order:31',
      assignmentRevision:7,accountableOwner:owner,completionCriteriaRefs:['plan:eng:root#Requirements']});
    expect(first.state.currentWorkRef).toBe('session-task:'+owner+':a');
    await taskOp(owner,{op:'done',taskId:'a'});
    expect((await mission(owner)).state.disposition).toBe('ready');
    await taskOp(owner,{op:'start',taskId:'b'});
    const second=await mission(owner);
    expect(second.state.binding?.assignmentRef).toBe('plan:eng:root');
    expect(second.state.selectionRevision).toBeGreaterThan(first.state.selectionRevision);
    expect(second.state.frames).toEqual([]);
    const revision=second.revision;
    await Promise.all([taskOp(owner,{op:'start',taskId:'b'}),taskOp(owner,{op:'start',taskId:'b'})]);
    expect((await mission(owner)).revision).toBe(revision);
  });

  it('rolls back both accepted focus and binding when continuation persistence fails',async()=>{
    const owner='su-task-rollback';
    await initTask(owner,'a','WI-task-rollback');
    await expect(taskOp(owner,{op:'start',taskId:'a'},undefined,true)).rejects.toThrow('acceptance commit crash');
    expect((await taskOp(owner,{op:'view'})).tasks[0].status).toBe('pending');
    expect((await readSessionMission(scope(owner),db.sql)).availability).toBe('absent');
    await taskOp(owner,{op:'start',taskId:'a'});
    expect((await mission(owner)).state.currentWorkRef).toBe('session-task:'+owner+':a');
  });

  it('keeps ambiguous displacement unknown and can accept later same-root progress at the same clock',async()=>{
    const owner='su-task-unknown';
    await initTask(owner,'a','WI-task-known');
    await taskOp(owner,{op:'append',content:'unrecorded purpose'},undefined,false,'unlinked');
    await taskOp(owner,{op:'start',taskId:'a'});
    await taskOp(owner,{op:'start',taskId:'unlinked'});
    const unknown=await mission(owner);
    expect(unknown.state.stateAvailability).toBe('unknown');
    expect(unknown.state.binding?.assignmentRef).toBe('plan:eng:root');
    expect(unknown.state.frames).toEqual([]);
    await taskOp(owner,{op:'start',taskId:'a'});
    const restored=await mission(owner);
    expect(restored.state.stateAvailability).toBe('available');
    expect(restored.state.selectionRevision).toBeGreaterThan(unknown.state.selectionRevision);
    expect(new Set(restored.state.processedEvents).size).toBe(restored.state.processedEvents.length);
  });

  it('invalidates stale return authority after an actual custody transfer',async()=>{
    const owner='su-task-transfer';
    await initTask(owner,'a','WI-task-transfer');
    await taskOp(owner,{op:'start',taskId:'a'});
    await db.sql`UPDATE harness_shared.work_items SET taken_by='su-peer',taken_at=now() WHERE feature_id='WI-task-transfer'`;
    await taskOp(owner,{op:'done',taskId:'a'});
    const transferred=await mission(owner);
    expect(transferred.state.disposition).toBe('transferred');
    expect(transferred.state.nextActionRef).toBeNull();
    expect(transferred.outbox).toEqual([]);
  });

  it('does not turn an agent-authored directive into owner authority',async()=>{
    const owner='su-task-untrusted';
    await initTask(owner,'a','WI-task-untrusted');
    await db.sql`INSERT INTO harness_shared.owner_directives VALUES(32,'mission-test','agent-turn:32',false,null)`;
    await db.sql`UPDATE harness_shared.work_items SET directive_ref=32 WHERE feature_id='WI-task-untrusted'`;
    await taskOp(owner,{op:'start',taskId:'a'});
    const unknown=await mission(owner);
    expect(unknown.state.binding).toBeNull();
    expect(unknown.state.stateAvailability).toBe('unknown');
  });
});


describe('retained mission state and atomic consequence intent on Postgres', () => {
  it.each(['unfinished', 'paused', 'peer-claim', 'released-without-successor'])(
    'refreshes consumer authority after bounded close without a lifecycle write: %s', async condition => {
      const owner = 'su-consumer-' + condition;
      const workItem = 'WI-consumer-' + condition;
      await initTask(owner, 'review', workItem);
      await taskOp(owner, { op: 'start', taskId: 'review' });
      await taskOp(owner, { op: 'done', taskId: 'review' });
      if (condition === 'paused') {
        await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL WHERE plan_slug='root'`;
      } else if (condition === 'peer-claim') {
        await db.sql`UPDATE harness_shared.work_items SET taken_by='su-peer',taken_at=now() WHERE feature_id=${workItem}`;
      } else if (condition === 'released-without-successor') {
        await db.sql`UPDATE harness_shared.work_items SET taken_by=NULL,taken_at=NULL WHERE feature_id=${workItem}`;
      }
      try {
        const before = await mission(owner);
        const read = await readCurrentMissionContinuity(scope(owner), { sql: db.sql, nowMs: 5_000 });
        expect(read.availability).toBe('available');
        if (read.availability !== 'available') throw new Error('missing consumer view');
        expect(read.projection.accountableOwner).toBe(owner);
        expect(read.projection.disposition).toBe(condition === 'paused' ? 'unknown'
          : condition === 'peer-claim' ? 'transferred' : 'ready');
        expect(read.projection.assignmentRef).toBe('plan:eng:root');
        if (condition === 'peer-claim') expect(read.projection.nextActionRef).toBeNull();
        expect(await mission(owner)).toEqual(before);
      } finally {
        await db.sql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=7 WHERE plan_slug='root'`;
      }
    },
  );

  it('retains the root and deadlines across recovery and current-activity changes', async () => {
    const p = await seed('su-recover');
    await db.sql`UPDATE harness_shared.session_briefs SET current_plan_slug='other-activity', intent='a short question' WHERE owner_id='su-recover'`;
    const recovered = await applyMissionEvent(scope('su-recover'), { id: 'recover', kind: 'recovered' }, async () => p,
      { sql: db.sql, nowMs: 500_000 });
    expect(recovered.state.binding?.assignmentRef).toBe('plan:main');
    expect(recovered.state.frames[0].absoluteDeadline).toBe(2_000 + 30 * 60_000);
    expect(recovered.consequences).toEqual([]);
  });

  it('rejects a ninth displacement atomically and retains the pending obligation and eight returns', async () => {
    const owner = 'su-depth-capacity';
    const p = parent(owner);
    await applyMissionEvent(scope(owner), {
      id: 'depth-bind', kind: 'assignment-accepted', binding: p, currentWorkRef: 'WI-step',
    }, async () => p, { sql: db.sql, nowMs: 1_000 });
    await db.sql`CREATE TABLE harness_shared.mission_capacity_fixture (current_ref text, pending_ref text)`;
    await db.sql`INSERT INTO harness_shared.mission_capacity_fixture VALUES ('WI-step', 'WI-depth-9')`;
    const accept = (depth: number) => db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_capacity_fixture SET current_ref=${'WI-depth-' + depth},
        pending_ref=CASE WHEN ${depth}=9 THEN NULL ELSE pending_ref END`;
      return acceptMissionActivityInTransaction(tx, scope(owner), {
        selectedRef: 'WI-depth-' + depth, accepted: true, changesFocus: true,
        displacedContinuationRef: depth === 1 ? 'WI-step' : 'WI-depth-' + (depth - 1),
        relationship: 'directed-obligation',
      }, async () => p, 1_000 + depth);
    });
    for (let depth = 1; depth <= 8; depth += 1) await accept(depth);
    const before = await mission(owner);
    expect(before.state.frames).toHaveLength(8);
    expect(new Set(before.state.frames.map(frame => frame.absoluteDeadline)).size).toBe(1);
    await expect(accept(9)).rejects.toMatchObject({
      name: 'MissionInterruptionCapacityError', code: 'mission-interruption-capacity-exhausted',
    });
    expect(await mission(owner)).toEqual(before);
    expect((await db.sql`SELECT * FROM harness_shared.mission_capacity_fixture`)[0]).toEqual({
      current_ref: 'WI-depth-8', pending_ref: 'WI-depth-9',
    });
    const recovered = await applyMissionEvent(scope(owner), { id: 'depth-recovery', kind: 'recovered' },
      async () => p, { sql: db.sql, nowMs: 2_000 });
    expect(recovered.state.frames).toEqual(before.state.frames);
    expect(recovered.state.currentWorkRef).toBe('WI-depth-8');
    expect(recovered.consequences).toEqual([]);
  });

  it('commits child mutation, frame closure and pending intent together before enqueue', async () => {
    const p = await seed('su-commit');
    await db.sql`CREATE TABLE harness_shared.mission_child_fixture (id text PRIMARY KEY, state text)`;
    await db.sql`INSERT INTO harness_shared.mission_child_fixture VALUES ('WI-repair','open')`;
    await db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_child_fixture SET state='done' WHERE id='WI-repair'`;
      await applyMissionEventInTransaction(tx, scope('su-commit'), done, async () => p, 3_000);
    });
    const stored = await readSessionMission(scope('su-commit'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing committed mission');
    expect(stored.envelope.state.frames).toEqual([]);
    expect(stored.envelope.state.disposition).toBe('ready');
    expect(stored.envelope.outbox).toMatchObject([{ status: 'pending', consequence: { continuationRef: 'P-002' } }]);
    expect((await db.sql`SELECT state FROM harness_shared.mission_child_fixture WHERE id='WI-repair'`)[0].state).toBe('done');
  });

  it('rolls back completion and intent at the business-commit crash window', async () => {
    const p = await seed('su-rollback');
    await db.sql`CREATE TABLE harness_shared.mission_rollback_fixture (state text)`;
    await db.sql`INSERT INTO harness_shared.mission_rollback_fixture VALUES ('open')`;
    await expect(db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_rollback_fixture SET state='done'`;
      await applyMissionEventInTransaction(tx, scope('su-rollback'), done, async () => p, 3_000);
      throw new Error('injected crash before business commit');
    })).rejects.toThrow('injected crash');
    const stored = await readSessionMission(scope('su-rollback'), db.sql);
    if (stored.availability !== 'available') throw new Error('lost retained state');
    expect(stored.envelope.state.frames).toHaveLength(1);
    expect(stored.envelope.outbox).toEqual([]);
    expect((await db.sql`SELECT state FROM harness_shared.mission_rollback_fixture`)[0].state).toBe('open');
  });

  it.each(['commit', 'before-commit', 'after-commit'] as const)(
    'reopens committed state and pending intent in a fresh process after %s', async phase => {
      const owner = 'su-process-' + phase;
      const p = await seed(owner);
      const before = await mission(owner);
      await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.mission_process_fixture
        (owner_id text PRIMARY KEY, state text NOT NULL)`;
      await db.sql`INSERT INTO harness_shared.mission_process_fixture VALUES (${owner}, 'open')`;
      const worker = resolve(here, '../test/fixtures/mission-continuity-crash-worker.ts');
      const run = (action: string) => spawnSync(process.execPath, ['--import', 'tsx', worker, action, owner], {
        env: { ...process.env, MISSION_CRASH_DB_URL: db.url, MISSION_CRASH_PARENT: JSON.stringify(p) },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
      });
      const writer = run(phase);
      expect(writer.error, writer.stderr).toBeUndefined();
      if (phase === 'commit') expect(writer.status, writer.stderr).toBe(0);
      else expect(writer.signal, writer.stdout + writer.stderr).toBe('SIGKILL');
      const reader = run('read-and-replay');
      expect(reader.error, reader.stderr).toBeUndefined();
      expect(reader.status, reader.stderr).toBe(0);
      const line = reader.stdout.split('\n').find(value => value.startsWith('MISSION-CRASH-READ:'));
      expect(line, reader.stdout + reader.stderr).toBeDefined();
      const recovered = JSON.parse(line!.slice('MISSION-CRASH-READ:'.length));
      expect(recovered.pid).not.toBe(process.pid);
      expect(recovered.before.availability).toBe('available');
      const stored = recovered.before.envelope;
      if (phase === 'before-commit') {
        expect(recovered.businessState).toBe('open');
        expect(stored).toEqual(before);
        expect(recovered.after).toBeNull();
      } else {
        expect(recovered.businessState).toBe('done');
        expect(stored.state.frames).toEqual([]);
        expect(stored.state.binding).toEqual(before.state.binding);
        expect(stored.outbox).toMatchObject([{ status: 'pending', workflowId: null,
          consequence: { continuationRef: 'P-002' } }]);
        expect(stored.outbox).toHaveLength(1);
        expect(recovered.after.envelope.outbox).toEqual(stored.outbox);
        expect(recovered.after.envelope.state.frames).toEqual([]);
      }
    }, 90_000,
  );

  it('serializes concurrent completions and preserves terminal receipts on late acknowledgement', async () => {
    const p = await seed('su-concurrent');
    const receipts = await Promise.all([1, 2].map(() => applyMissionEvent(scope('su-concurrent'), done, async () => p,
      { sql: db.sql, nowMs: 3_000 })));
    expect(receipts.flatMap(receipt => receipt.consequences)).toHaveLength(1);
    const stored = await readSessionMission(scope('su-concurrent'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing concurrent receipt');
    expect(stored.envelope.outbox).toHaveLength(1);
    const id = stored.envelope.outbox[0].consequence.id;
    await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope('su-concurrent'), id,
      { status: 'settled', workflowId: id, admissionError: null, resolution: 'delivered' }));
    await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope('su-concurrent'), id,
      { status: 'enqueued', workflowId: id, admissionError: null, resolution: null }));
    const replayed = await readSessionMission(scope('su-concurrent'), db.sql);
    if (replayed.availability !== 'available') throw new Error('missing terminal receipt');
    expect(replayed.envelope.outbox[0].status).toBe('settled');
  });

  it('preserves pending intent and refuses to overwrite malformed persisted state', async () => {
    const p = await seed('su-malformed');
    await applyMissionEvent(scope('su-malformed'), done, async () => p, { sql: db.sql, nowMs: 3_000 });
    const stored = await readSessionMission(scope('su-malformed'), db.sql);
    if (stored.availability !== 'available') throw new Error('missing pending intent');
    expect(stored.envelope.outbox[0].status).toBe('pending');
    await db.sql`UPDATE harness_shared.session_briefs SET mission_continuity='{"schemaVersion":99}'::jsonb WHERE owner_id='su-malformed'`;
    expect((await readSessionMission(scope('su-malformed'), db.sql)).availability).toBe('unknown');
    await expect(applyMissionEvent(scope('su-malformed'), { id: 'recover', kind: 'recovered' }, async () => p,
      { sql: db.sql, nowMs: 4_000 })).rejects.toThrow('mission-state-invalid');
    expect((await db.sql`SELECT mission_continuity FROM harness_shared.session_briefs WHERE owner_id='su-malformed'`)[0].mission_continuity).toEqual({ schemaVersion: 99 });
  });

  it('retains unresolved intent and settled identities after the 33rd receipt and older-than-cache replay', async () => {
    const owner = 'su-receipt-rollover';
    const p = await seed(owner);
    await applyMissionEvent(scope(owner), done, async () => p, { sql: db.sql, nowMs: 3_000 });
    const unresolved = (await mission(owner)).outbox[0];
    for (let index = 1; index <= 33; index += 1) {
      await db.sql.begin(tx => acceptMissionActivityInTransaction(tx as unknown as Sql, scope(owner), {
        selectedRef: 'WI-rollover-' + index, accepted: true, changesFocus: true,
        displacedContinuationRef: 'WI-step', relationship: 'blocking-repair',
      }, async () => p, 4_000 + index));
      await applyMissionEvent(scope(owner), {
        id: 'rollover-done-' + index, kind: 'child-ended', childRef: 'WI-rollover-' + index, terminal: true,
      }, async () => p, { sql: db.sql, nowMs: 5_000 + index });
      const intent = (await mission(owner)).outbox.at(-1)!;
      await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope(owner), intent.consequence.id,
        { status: 'settled', workflowId: intent.consequence.id, admissionError: null, resolution: 'delivered' }));
    }
    const before = await mission(owner);
    expect(before.state.processedEvents).toHaveLength(32);
    expect(before.state.processedEvents).not.toContain(done.id);
    expect(before.state.processedEvents).not.toContain('rollover-done-1');
    expect(before.outbox).toHaveLength(34);
    expect(before.outbox[0]).toEqual(unresolved);
    expect(before.outbox.filter(entry => entry.status === 'settled')).toHaveLength(33);
    for (const event of [select, done, {
      id: 'rollover-done-1', kind: 'child-ended', childRef: 'WI-rollover-1', terminal: true,
    } satisfies MissionEvent]) {
      const replay = await applyMissionEvent(scope(owner), event, async () => p, { sql: db.sql, nowMs: 9_000 });
      expect(replay.consequences).toEqual([]);
      expect(replay.envelope.outbox).toEqual(before.outbox);
      expect(replay.state.frames).toEqual([]);
      expect(replay.state.currentWorkRef).toBe('WI-step');
    }
  });

  it('backpressures displacement before accepting more unresolved consequences than can be retained', async () => {
    const owner = 'su-intent-capacity';
    const p = await seed(owner);
    await applyMissionEvent(scope(owner), done, async () => p, { sql: db.sql, nowMs: 3_000 });
    for (let index = 1; index < 64; index += 1) {
      await db.sql.begin(tx => acceptMissionActivityInTransaction(tx as unknown as Sql, scope(owner), {
        selectedRef: 'WI-capacity-' + index, accepted: true, changesFocus: true,
        displacedContinuationRef: 'WI-step', relationship: 'blocking-repair',
      }, async () => p, 4_000 + index));
      await applyMissionEvent(scope(owner), {
        id: 'capacity-done-' + index, kind: 'child-ended', childRef: 'WI-capacity-' + index, terminal: true,
      }, async () => p, { sql: db.sql, nowMs: 5_000 + index });
    }
    const before = await mission(owner);
    expect(before.outbox).toHaveLength(64);
    expect(before.outbox.every(entry => entry.status === 'pending')).toBe(true);
    await db.sql`CREATE TABLE harness_shared.mission_intent_capacity_fixture (current_ref text, pending_ref text)`;
    await db.sql`INSERT INTO harness_shared.mission_intent_capacity_fixture VALUES ('WI-step', 'WI-overflow')`;
    await expect(db.sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`UPDATE harness_shared.mission_intent_capacity_fixture SET current_ref='WI-overflow', pending_ref=NULL`;
      await acceptMissionActivityInTransaction(tx, scope(owner), {
        selectedRef: 'WI-overflow', accepted: true, changesFocus: true,
        displacedContinuationRef: 'WI-step', relationship: 'blocking-repair',
      }, async () => p, 9_000);
    })).rejects.toThrow('mission-outbox-capacity-exhausted');
    expect(await mission(owner)).toEqual(before);
    expect((await db.sql`SELECT * FROM harness_shared.mission_intent_capacity_fixture`)[0]).toEqual({
      current_ref: 'WI-step', pending_ref: 'WI-overflow',
    });
    // Settling one intent makes exactly one return slot available again.
    const first = before.outbox[0].consequence.id;
    await db.sql.begin(tx => updateMissionOutboxInTransaction(tx as unknown as Sql, scope(owner), first,
      { status: 'settled', workflowId: first, admissionError: null, resolution: 'delivered' }));
    await db.sql.begin(tx => acceptMissionActivityInTransaction(tx as unknown as Sql, scope(owner), {
      selectedRef: 'WI-overflow', accepted: true, changesFocus: true,
      displacedContinuationRef: 'WI-step', relationship: 'blocking-repair',
    }, async () => p, 10_000));
    const reserved = await mission(owner);
    await expect(db.sql.begin(tx => acceptMissionActivityInTransaction(tx as unknown as Sql, scope(owner), {
      selectedRef: 'WI-overflow-nested', accepted: true, changesFocus: true,
      displacedContinuationRef: 'WI-overflow', relationship: 'blocking-repair',
    }, async () => p, 10_001))).rejects.toThrow('mission-outbox-capacity-exhausted');
    expect(await mission(owner)).toEqual(reserved);
    await applyMissionEvent(scope(owner), {
      id: 'overflow-done', kind: 'child-ended', childRef: 'WI-overflow', terminal: true,
    }, async () => p, { sql: db.sql, nowMs: 11_000 });
    const after = await mission(owner);
    expect(after.outbox).toHaveLength(64);
    expect(after.outbox.some(entry => entry.consequence.id === first)).toBe(false);
    expect(after.outbox.slice(0, 63)).toEqual(before.outbox.slice(1));
    expect(after.outbox.at(-1)).toMatchObject({ status: 'pending', consequence: { triggerEvent: 'overflow-done' } });
  });

  it('fences workspace and owner mismatches', async () => {
    const p = await seed('su-scope');
    await expect(applyMissionEvent({ ownerId: 'su-scope', workspaceId: 'foreign' }, { id: 'recover', kind: 'recovered' },
      async () => p, { sql: db.sql, nowMs: 3_000 })).rejects.toThrow('mission-session-scope-conflict');
    await expect(applyMissionEvent(scope('su-scope'), { id: 'foreign-bind', kind: 'assignment-accepted', binding: parent('su-peer'), currentWorkRef: null },
      async () => p, { sql: db.sql, nowMs: 3_000 })).rejects.toThrow('mission-owner-mismatch');
  });
});
