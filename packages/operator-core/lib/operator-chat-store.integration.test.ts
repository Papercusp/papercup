import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { TurnRecovery, type TurnIdentity } from '@papercusp/chat-protocol/recovery';
import { InteractionResolver, type InteractionRecord, type InteractionScope } from '@papercusp/chat-protocol/interactions';
import type { ChatEventEnvelope } from '@papercusp/chat-protocol';
import { OperatorChatStore, operatorChatSessionAuthority, operatorChatTurnWorkflow } from './operator-chat-store';

let first: postgres.Sql;
let second: postgres.Sql;
let turn: TurnIdentity;
let databaseUrl: string;
const workspaceId = 'p010-workspace';
const scope: InteractionScope = { principalId: 'owner', tenantId: 'tenant',
  customerId: 'customer', publicOwnerId: 'public-owner' };
const capabilities = { connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: true,
  completedToolCheckpoints: true, interruptedTurnRecovery: true };
const migration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1569-operator-chat-durable-state.sql.DRAFT', import.meta.url));

beforeAll(async () => {
  const uri = await getTestPg();
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  const dbName = `p010_chat_${randomBytes(5).toString('hex')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  databaseUrl = url.toString();
  first = postgres(url.toString(), { max: 3, onnotice: () => {} });
  second = postgres(url.toString(), { max: 1, onnotice: () => {} });
  await first.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.operator_conversations (id uuid PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE harness_shared.operator_turns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
      workspace_id text NOT NULL, tools jsonb NOT NULL DEFAULT '[]', seq integer NOT NULL DEFAULT 0,
      role text NOT NULL DEFAULT 'assistant', text text NOT NULL DEFAULT '', source text,
      created_at bigint, UNIQUE(conversation_id,seq));
    CREATE TABLE harness_shared.user_sessions (token text PRIMARY KEY, workspace_id text NOT NULL,
      user_id text NOT NULL, expires_at timestamptz NOT NULL, capabilities jsonb NOT NULL DEFAULT '["*"]');
    CREATE TABLE harness_shared.users (id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE harness_shared.system_principals (workspace_id text NOT NULL, name text NOT NULL,
      bearer_hash text NOT NULL, capabilities jsonb NOT NULL, PRIMARY KEY(workspace_id,name));
    CREATE TABLE harness_shared.pi_sessions (workspace_id text NOT NULL, session_id text NOT NULL,
      bearer_hash text NOT NULL, capabilities jsonb NOT NULL, allowed_tools jsonb,
      ended_at timestamptz, expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,session_id));
    CREATE TABLE harness_shared.token_index (token text PRIMARY KEY, kind text NOT NULL,
      harness_slug text NOT NULL, workspace_id text NOT NULL);
  `);
  // Apply the exact additive draft twice: legacy turn bytes remain untouched.
  await first.unsafe(readFileSync(migration, 'utf8'));
  await first.unsafe(readFileSync(migration, 'utf8'));
}, 90_000);
afterAll(async () => { await Promise.all([first?.end({ timeout: 5 }), second?.end({ timeout: 5 })]); });
beforeEach(async () => {
  await first.unsafe('TRUNCATE harness_shared.operator_turns, harness_shared.operator_conversations, harness_shared.user_sessions, harness_shared.users, harness_shared.system_principals, harness_shared.pi_sessions, harness_shared.token_index');
  turn = { conversationId: randomUUID(), turnId: randomUUID() };
  await first.unsafe('INSERT INTO harness_shared.operator_conversations VALUES ($1,$2)', [turn.conversationId, workspaceId]);
  await first.unsafe('INSERT INTO harness_shared.operator_turns (id,conversation_id,workspace_id) VALUES ($1,$2,$3)',
    [turn.turnId, turn.conversationId, workspaceId]);
  await first.unsafe("INSERT INTO harness_shared.user_sessions (token,workspace_id,user_id,expires_at) VALUES ('current',$1,$2,clock_timestamp()+interval '1 hour')",
    [workspaceId, scope.principalId]);
  await first.unsafe('INSERT INTO harness_shared.users (id) VALUES ($1)', [scope.principalId]);
});

function store(sql = first, overrides: Partial<ConstructorParameters<typeof OperatorChatStore>[0]> = {}) {
  return new OperatorChatStore({ sql, workspaceId, turn, scope, replayLimit: 4,
    // This fixture uses PG session rows and a real authority lock. The production
    // route must supply its own current principal/ACL resolver at this port.
    async authorize(tx) {
      const rows = await tx.unsafe(`SELECT token FROM harness_shared.user_sessions
        WHERE token='current' AND workspace_id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE`,
      [workspaceId, scope.principalId]);
      return rows.length === 1;
    }, ...overrides });
}
function worker(s = store()) {
  return new TurnRecovery({ capabilities, store: s, authorize: async () => true,
    replay: (identity, after) => s.replay(identity, after), abortExecution: async () => {} });
}
function record(correlationId = 'choice'): InteractionRecord {
  return { schemaVersion: 1, conversationId: turn.conversationId, correlationId, scope, revision: 0,
    schema: { id: 'choice-schema', revision: 1 }, spec: { prompt: 'Proceed?', allowDecline: true },
    expiresAt: Date.now() + 60_000, status: 'pending' };
}
function resolver(s: OperatorChatStore, failAdvance = false) {
  const port = s.interactions(async (tx, next) => {
    // Stand in for the existing persisted host workflow, in the SAME PG tx.
    // A worker recovering the decision never calls this transition again.
    await tx.unsafe('UPDATE harness_shared.operator_turns SET tools=tools || $1::jsonb WHERE id=$2',
      [tx.json([next.decision] as unknown as postgres.JSONValue), turn.turnId]);
    if (failAdvance) throw new Error('workflow-write-failed');
  });
  return { port, make: (storage = port) => new InteractionResolver({ store: storage,
    validate: async (schema, value) => schema.id === 'choice-schema' && schema.revision === 1
      && Object.keys(value).length === 1 && value.pick === 'yes' ? { ok: true, value } : { ok: false } }) };
}
const answer = (submissionId: string) => ({ submissionId, revision: 0,
  response: { action: 'submit', correlationId: 'choice', value: { pick: 'yes' } } });
const envelope = (sequence: number): ChatEventEnvelope => ({ schemaVersion: 1, ...turn,
  eventId: `event-${sequence}`, sequence, event: { type: 'delta', text: `delta-${sequence}` } });

describe('P010 durable PG turn ports (independent connections; no actual-host claim)', () => {
  it('P010 durable worker recovery reads a completed tool without re-execution on a new connection', async () => {
    const a = worker();
    const dispatch = () => Promise.resolve({ ref: 'document:retained', text: 'Stored result' });
    expect((await a.start(turn, ['read'])).ok).toBe(true);
    expect((await a.runEffect(turn, 'read', dispatch, new AbortController().signal)).ok).toBe(true);
    const b = worker(store(second));
    let redispatches = 0;
    expect(await b.runEffect(turn, 'read', async () => { redispatches++; }, new AbortController().signal))
      .toMatchObject({ ok: true, value: { source: 'checkpoint', result: { ref: 'document:retained' } } });
    expect(redispatches).toBe(0);
  });

  it('P010 two-worker terminal CAS admits one effect and preserves unrelated turn bytes', async () => {
    const other = randomUUID();
    await first.unsafe('INSERT INTO harness_shared.operator_turns (id,conversation_id,workspace_id,seq) VALUES ($1,$2,$3,1)',
    [other, turn.conversationId, workspaceId]);
    const a = worker(), b = worker(store(second));
    await a.start(turn, ['effect']);
    let effects = 0;
    const dispatch = async () => ++effects;
    const results = await Promise.all([a.runEffect(turn, 'effect', dispatch, new AbortController().signal),
      b.runEffect(turn, 'effect', dispatch, new AbortController().signal)]);
    expect(results.some(result => result.ok)).toBe(true);
    expect(effects).toBe(1);
    const rows = await first.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [other]);
    expect(rows[0].chat_state).toBeNull();
  });

  it('cancellation wins its PG fence before admission and prevents dispatch', async () => {
    const s = store();
    const original = s.compareAndSwap.bind(s);
    const b = worker(store(second));
    s.compareAndSwap = async (identity, revision, next) => {
      const result = await original(identity, revision, next);
      if (result && next.effects.read?.status === 'dispatching') expect((await b.cancel(turn)).ok).toBe(true);
      return result;
    };
    const a = worker(s);
    await a.start(turn, ['read']);
    let effects = 0;
    expect(await a.runEffect(turn, 'read', async () => ++effects, new AbortController().signal))
      .toEqual({ ok: false, code: 'cancelled' });
    expect(effects).toBe(0);
  });

  it('authority revoked at effect admission returns a typed refusal before launching', async () => {
    const s = store();
    await worker(s).start(turn, ['read']);
    const claimed = (await s.read(turn))!;
    claimed.state.revision++;
    claimed.effects.read = { status: 'dispatching', claimRevision: claimed.state.revision, admitted: false };
    expect(await s.compareAndSwap(turn, 0, claimed)).toBe(true);
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    let effects = 0;
    expect(await s.admitDispatch(turn, 'read', 1, async () => ++effects))
      .toEqual({ admitted: false, reason: 'unauthorized' });
    expect(effects).toBe(0);
    await second.unsafe("INSERT INTO harness_shared.user_sessions (token,workspace_id,user_id,expires_at) VALUES ('current',$1,$2,clock_timestamp()+interval '1 hour')",
      [workspaceId, scope.principalId]);
    const allowed = await s.admitDispatch(turn, 'read', 1, async () => ++effects);
    expect(allowed.admitted).toBe(true);
    if (allowed.admitted) expect(await allowed.result).toBe(1);
    expect(effects).toBe(1);
  });

  it('bounded PG replay keeps the stable cursor and reconciles duplicate event acknowledgement', async () => {
    const s = store();
    await worker(s).start(turn, ['read']);
    for (let i = 1; i <= 5; i++) await s.appendEvent(envelope(i));
    const replacement = store(second);
    expect(await replacement.appendEvent(envelope(5))).toEqual(envelope(5));
    expect(await replacement.replay(turn, 2)).toMatchObject({ firstAvailableSequence: 2, lastSequence: 5,
      events: [envelope(3), envelope(4), envelope(5)] });
    expect(await worker(replacement).replay(turn, 0)).toEqual({ ok: false, code: 'replay-expired' });
    await expect(replacement.appendEvent(envelope(1))).rejects.toThrow('replay-expired');
    await expect(replacement.appendEvent({ ...envelope(5), event: { type: 'delta', text: 'competing bytes' } }))
      .rejects.toThrow('event-conflict');
  });

  it('foreign workspace, conversation and principal scopes cannot read a persisted checkpoint', async () => {
    await worker().start(turn, ['read']);
    await expect(store(second, { workspaceId: 'foreign' }).read(turn)).rejects.toThrow('unauthorized');
    await expect(store(second).read({ ...turn, conversationId: randomUUID() })).rejects.toThrow('unauthorized');
    for (const key of ['principalId', 'tenantId', 'customerId', 'publicOwnerId'] as const) {
      await expect(store(second, { scope: { ...scope, [key]: `foreign-${key}` } }).read(turn))
        .rejects.toThrow('unauthorized');
    }
    expect((await store(second).read(turn))?.state.phase).toBe('running');
  });

  it('future persisted versions and state/transient frames refuse without mutation', async () => {
    await first.unsafe('UPDATE harness_shared.operator_turns SET chat_state=$1::jsonb WHERE id=$2',
      [first.json({ schemaVersion: 2, sentinel: 'unchanged' }), turn.turnId]);
    await expect(store().read(turn)).rejects.toThrow('invalid-state');
    await expect(store().appendEvent({ ...envelope(1), event: { type: 'navigate', href: '/reports' } }))
      .rejects.toThrow('invalid-frame');
    const rows = await first.unsafe('SELECT chat_state FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].chat_state).toEqual({ schemaVersion: 2, sentinel: 'unchanged' });
  });

  it('P010 two-worker terminal CAS commits one decision and one workflow transition', async () => {
    const a = store(), b = store(second);
    expect(await a.seedInteraction(record())).toBe(true);
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    const results = await Promise.all([resolver(a).make().resolve(id, scope, answer('a')),
      resolver(b).make().resolve(id, scope, answer('b'))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toHaveLength(1);
    expect((await resolver(store(second)).make().read(id, scope))).toMatchObject({ ok: true, value: { status: 'resolved' } });
  });

  it('a workflow storage failure rolls back the decision and never acknowledges success', async () => {
    const s = store();
    await s.seedInteraction(record());
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolver(s, true).make().resolve(id, scope, answer('a')))
      .toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(await resolver(store(second)).make().read(id, scope)).toMatchObject({ ok: true, value: { status: 'pending' } });
    const rows = await first.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
    expect((await resolver(s).make().resolve(id, scope, answer('b'))).ok).toBe(true);
  });

  it('commit-success acknowledgement loss reconciles the exact durable decision without another transition', async () => {
    const s = store();
    await s.seedInteraction(record());
    const { port, make } = resolver(s);
    let lost = false;
    const resolved = make({ transact: async (identity, caller, decide) => {
      let changed = false;
      const result = await port.transact(identity, caller, current => {
        const mutation = decide(current); changed = !!mutation.next; return mutation;
      });
      if (changed && !lost) { lost = true; throw new Error('commit-ack-lost'); }
      return result;
    } });
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolved.resolve(id, scope, answer('same-submission'))).toMatchObject({ ok: true,
      value: { submissionId: 'same-submission', revision: 1 } });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toHaveLength(1);
  });

  it('current authority revoked after render prevents both reads and decisions', async () => {
    const s = store();
    await s.seedInteraction(record());
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect((await resolver(s).make().read(id, scope)).ok).toBe(true);
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    expect(await resolver(s).make().read(id, scope)).toEqual({ ok: false, code: 'unauthorized' });
    expect(await resolver(s).make().resolve(id, scope, answer('revoked'))).toEqual({ ok: false, code: 'unauthorized' });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
  });

  it('an unpersistable completed result refuses acknowledgement and cannot be redispatched', async () => {
    const a = worker();
    await a.start(turn, ['read']);
    let effects = 0;
    expect(await a.runEffect(turn, 'read', async () => { effects++; return { count: Number.NaN }; },
      new AbortController().signal)).toEqual({ ok: false, code: 'checkpoint-write-failed' });
    expect(await worker(store(second)).runEffect(turn, 'read', async () => ++effects,
      new AbortController().signal)).toEqual({ ok: false, code: 'needs-reconciliation' });
    expect(effects).toBe(1);
  });

  it('cancelling a turn durably closes pending decisions before a late answer', async () => {
    const s = store();
    const a = worker(s);
    await a.start(turn, ['read']);
    await s.seedInteraction(record());
    expect((await a.cancel(turn)).ok).toBe(true);
    const id = { conversationId: turn.conversationId, correlationId: 'choice' };
    expect(await resolver(store(second)).make().resolve(id, scope, answer('late')))
      .toEqual({ ok: false, code: 'cancelled' });
    const rows = await second.unsafe('SELECT tools FROM harness_shared.operator_turns WHERE id=$1', [turn.turnId]);
    expect(rows[0].tools).toEqual([]);
  });

  it('a genuinely fresh Node process recovers the committed result from existing PG rows', async () => {
    const a = worker();
    await a.start(turn, ['read']);
    expect((await a.runEffect(turn, 'read', async () => ({ ref: 'document:fresh-process' }),
      new AbortController().signal)).ok).toBe(true);
    const script = `
      import postgres from 'postgres';
      import { OperatorChatStore } from './packages/operator-core/lib/operator-chat-store.ts';
      import { TurnRecovery } from '@papercusp/chat-protocol/recovery';
      const sql = postgres(process.env.P010_CHAT_TEST_DSN, { max: 1 });
      const turn = JSON.parse(process.env.P010_CHAT_TEST_IDENTITY);
      const scope = JSON.parse(process.env.P010_CHAT_TEST_SCOPE);
      try {
        const store = new OperatorChatStore({ sql, workspaceId: 'p010-workspace', turn, scope, replayLimit: 4,
          async authorize(tx) {
            const rows = await tx.unsafe("SELECT token FROM harness_shared.user_sessions WHERE token='current' AND user_id=$1 AND workspace_id='p010-workspace' AND expires_at>clock_timestamp() FOR SHARE", [scope.principalId]);
            return rows.length === 1;
          } });
        const worker = new TurnRecovery({ capabilities: ${JSON.stringify(capabilities)}, store,
          authorize: async () => true, replay: (id, after) => store.replay(id, after), abortExecution: async () => {} });
        process.stdout.write(JSON.stringify(await worker.recover(turn, 'read')));
      } finally { await sql.end({ timeout: 5 }); }
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 30_000, maxBuffer: 16_384,
      env: { ...process.env, P010_CHAT_TEST_DSN: databaseUrl,
        P010_CHAT_TEST_IDENTITY: JSON.stringify(turn), P010_CHAT_TEST_SCOPE: JSON.stringify(scope) },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true,
      value: { source: 'checkpoint', result: { ref: 'document:fresh-process' } } });
  }, 40_000);
});

describe('P010 production session authority and existing persisted card workflow', () => {
  const cookie = () => operatorChatSessionAuthority({ workspaceId, principalId: scope.principalId,
    credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
    capability: 'chat:write', toolName: 'chat:ask_choice' });

  it('rechecks cookie expiry, active user, capability and workspace without trusting the rendered scope', async () => {
    const s = store(first, { authorize: cookie() });
    expect(await s.read(turn)).toBeNull();
    for (const mutation of ["UPDATE harness_shared.user_sessions SET expires_at=clock_timestamp()-interval '1 second'",
      'UPDATE harness_shared.users SET is_active=false',
      "UPDATE harness_shared.user_sessions SET capabilities='[\"chat:*\"]'",
      "UPDATE harness_shared.user_sessions SET workspace_id='foreign'"]) {
      await first.unsafe(mutation);
      await expect(s.read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe("UPDATE harness_shared.user_sessions SET expires_at=clock_timestamp()+interval '1 hour', capabilities='[\"chat:write\"]',workspace_id=$1", [workspaceId]);
      await first.unsafe('UPDATE harness_shared.users SET is_active=true');
      expect(await s.read(turn)).toBeNull();
    }
    const foreign = operatorChatSessionAuthority({ workspaceId, principalId: 'foreign',
      credential: { kind: 'user-session', token: 'current', userId: scope.principalId },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    await expect(store(first, { authorize: foreign }).read(turn)).rejects.toThrow('unauthorized');
  });

  it('holds the real session and user revocation fence until the chat transaction finishes', async () => {
    for (const mutation of ["DELETE FROM harness_shared.user_sessions WHERE token='current'",
      'UPDATE harness_shared.users SET is_active=false']) {
      let checked = false;
      const s = store(first, { authorize: async tx => {
        const allowed = await cookie()(tx);
        await expect(second.begin(async other => {
          await other.unsafe("SET LOCAL lock_timeout='30ms'");
          await other.unsafe(mutation);
        })).rejects.toMatchObject({ code: '55P03' });
        checked = true;
        return allowed;
      } });
      expect(await s.read(turn)).toBeNull();
      expect(checked).toBe(true);
    }
    await second.unsafe("DELETE FROM harness_shared.user_sessions WHERE token='current'");
    await expect(store(first, { authorize: cookie() }).read(turn)).rejects.toThrow('unauthorized');
  });

  it('PI reads require the current bearer, exact tool allowlist, scope, expiry and unended session', async () => {
    const bearer = 'fixture-pi-secret';
    const hash = createHash('sha256').update(bearer).digest('hex');
    await first.unsafe(`INSERT INTO harness_shared.pi_sessions
      (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
      VALUES ($1,'public-chat',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'pi','pi:public-chat',$2)", [bearer, workspaceId]);
    const make = (token = bearer, ws = workspaceId, principalId = 'pi:public-chat') => store(first, {
      scope: { ...scope, principalId }, authorize: operatorChatSessionAuthority({ workspaceId: ws, principalId,
        credential: { kind: 'pi', bearer: token, sessionId: 'public-chat' }, capability: 'chat:write', toolName: 'chat:ask_choice' }),
    });
    expect(await make().read(turn)).toBeNull();
    for (const denied of [make('wrong-secret'), make(bearer, 'foreign'), make(bearer, workspaceId, 'pi:other')]) {
      await expect(denied.read(turn)).rejects.toThrow('unauthorized');
    }
    for (const mutation of ["UPDATE harness_shared.pi_sessions SET allowed_tools='[\"chat:*\"]'",
      "UPDATE harness_shared.pi_sessions SET capabilities='[]'", 'UPDATE harness_shared.pi_sessions SET ended_at=clock_timestamp()',
      "UPDATE harness_shared.pi_sessions SET expires_at=clock_timestamp()-interval '1 second'"]) {
      await first.unsafe(mutation);
      await expect(make().read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe(`UPDATE harness_shared.pi_sessions SET allowed_tools='["chat:ask_choice"]',
        capabilities='["chat:write"]',ended_at=NULL,expires_at=clock_timestamp()+interval '1 hour'`);
      expect(await make().read(turn)).toBeNull();
    }
  });

  it('system reads recheck the stored credential and capability after rotation', async () => {
    const bearer = 'fixture-system-secret';
    const hash = createHash('sha256').update(bearer).digest('hex');
    await first.unsafe(`INSERT INTO harness_shared.system_principals VALUES ($1,'operator',$2,'["*"]')`, [workspaceId, hash]);
    await first.unsafe("INSERT INTO harness_shared.token_index VALUES ($1,'system','system:operator',$2)", [bearer, workspaceId]);
    const s = store(first, { scope: { ...scope, principalId: 'system:operator' },
      authorize: operatorChatSessionAuthority({ workspaceId, principalId: 'system:operator',
        credential: { kind: 'system', bearer, name: 'operator' }, capability: 'operator:converse', toolName: 'operator:converse' }) });
    expect(await s.read(turn)).toBeNull();
    await second.unsafe("UPDATE harness_shared.system_principals SET bearer_hash='rotated'");
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
    await second.unsafe('UPDATE harness_shared.system_principals SET bearer_hash=$1', [hash]);
    expect(await s.read(turn)).toBeNull();
  });

  it.each(['system', 'pi'] as const)('bearer identity %s must still exist and stay locked in the current transaction', async kind => {
    const bearer = `fixture-${kind}-identity`;
    const hash = createHash('sha256').update(bearer).digest('hex');
    const principalId = `${kind}:chat`;
    if (kind === 'system') {
      await first.unsafe("INSERT INTO harness_shared.system_principals VALUES ($1,'chat',$2,'[\"chat:write\"]')", [workspaceId, hash]);
    } else {
      await first.unsafe(`INSERT INTO harness_shared.pi_sessions
        (workspace_id,session_id,bearer_hash,capabilities,allowed_tools,expires_at)
        VALUES ($1,'chat',$2,'["chat:write"]','["chat:ask_choice"]',clock_timestamp()+interval '1 hour')`, [workspaceId, hash]);
    }
    const credential = kind === 'system' ? { kind, bearer, name: 'chat' } : { kind, bearer, sessionId: 'chat' };
    const authorize = operatorChatSessionAuthority({ workspaceId, principalId, credential,
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const s = store(first, { scope: { ...scope, principalId }, authorize });
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
    await first.unsafe('INSERT INTO harness_shared.token_index VALUES ($1,$2,$3,$4)', [bearer, kind, principalId, workspaceId]);
    expect(await s.read(turn)).toBeNull();
    for (const mutation of ["UPDATE harness_shared.token_index SET kind='foreign'",
      "UPDATE harness_shared.token_index SET harness_slug='pi:foreign'",
      "UPDATE harness_shared.token_index SET workspace_id='foreign'"]) {
      await first.unsafe(mutation);
      await expect(s.read(turn)).rejects.toThrow('unauthorized');
      await first.unsafe('UPDATE harness_shared.token_index SET kind=$1,harness_slug=$2,workspace_id=$3', [kind, principalId, workspaceId]);
    }
    const guarded = store(first, { scope: { ...scope, principalId }, authorize: async tx => {
      const allowed = await authorize(tx);
      await expect(second.begin(async other => {
        await other.unsafe("SET LOCAL lock_timeout='30ms'");
        await other.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
      })).rejects.toMatchObject({ code: '55P03' });
      return allowed;
    } });
    expect(await guarded.read(turn)).toBeNull();
    await second.unsafe('DELETE FROM harness_shared.token_index WHERE token=$1', [bearer]);
    await expect(s.read(turn)).rejects.toThrow('unauthorized');
  });

  async function productionDecision(sql = first) {
    const s = store(sql, { authorize: cookie() });
    const workflow = operatorChatTurnWorkflow({ workspaceId, turn });
    const errors: string[] = [];
    return { s, errors, resolver: new InteractionResolver({ store: s.interactions(async (tx, next) => {
      try { await workflow(tx, next); }
      catch (error) { errors.push(String(error)); throw error; }
    }),
      validate: async (_schema, value) => ({ ok: true, value }) }) };
  }
  async function seedChoice() {
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=$1::jsonb WHERE id=$2`,
      [first.json([{ name: 'chat_ask_choice', callId: 'choice', input: {
        options: JSON.stringify([{ id: 'YES', label: 'Proceed' }, { id: 'no', label: 'Stop' }]),
      } }, { name: 'read', callId: 'unrelated', input: { ref: 'retained' } }]), turn.turnId]);
    const { s } = await productionDecision();
    await s.seedInteraction(record());
    return { conversationId: turn.conversationId, correlationId: 'choice' };
  }
  const pick = (submissionId: string, ids = ['yes']) => ({ submissionId, revision: 0,
    response: { action: 'submit', correlationId: 'choice', value: { picks: ids } } });

  it('two workers commit one real answered marker and card_pick turn, preserving unrelated tools', async () => {
    const identity = await seedChoice();
    const a = await productionDecision(), b = await productionDecision(second);
    const results = await Promise.all([a.resolver.resolve(identity, scope, pick('a')),
      b.resolver.resolve(identity, scope, pick('b'))]);
    expect([...a.errors, ...b.errors]).toEqual([]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const rows = await first.unsafe('SELECT role,text,source,tools,created_at FROM harness_shared.operator_turns ORDER BY seq');
    expect(rows).toHaveLength(2);
    expect(rows[0].tools).toEqual([{ name: 'chat_ask_choice', callId: 'choice', input: {
      options: JSON.stringify([{ id: 'YES', label: 'Proceed' }, { id: 'no', label: 'Stop' }]),
    }, answered: { picks: [{ option_id: 'yes', label: 'Proceed' }], at: expect.any(Number) } },
    { name: 'read', callId: 'unrelated', input: { ref: 'retained' } }]);
    expect(rows[1]).toMatchObject({ role: 'user', text: 'Proceed', source: 'card_pick' });
    expect(Number(rows[1].created_at)).toBe(Math.trunc(rows[0].tools[0].answered.at));
    const winner = results.find(result => result.ok)!;
    if (winner.ok) {
      expect(await b.resolver.resolve(identity, scope, pick(winner.value.submissionId)))
        .toEqual({ ok: false, code: 'already-decided' });
      expect(await b.resolver.read(identity, scope)).toMatchObject({ ok: true, value: { decision: winner.value } });
    }
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });

  it('missing tool binding and invalid option rolls back the decision; valid retry commits once', async () => {
    const identity = await seedChoice();
    const { resolver: resolve } = await productionDecision();
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=jsonb_set(tools,'{0,callId}','"foreign"') WHERE id=$1`, [turn.turnId]);
    expect(await resolve.resolve(identity, scope, pick('wrong-binding'))).toEqual({ ok: false, code: 'needs-reconciliation' });
    await first.unsafe(`UPDATE harness_shared.operator_turns SET tools=jsonb_set(tools,'{0,callId}','"choice"') WHERE id=$1`, [turn.turnId]);
    for (const ids of [['invented'], ['yes','no'], ['yes','yes']]) {
      expect(await resolve.resolve(identity, scope, pick('bad-picks', ids))).toEqual({ ok: false, code: 'needs-reconciliation' });
    }
    expect(await resolve.read(identity, scope)).toMatchObject({ ok: true, value: { status: 'pending' } });
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(0);
    expect((await resolve.resolve(identity, scope, pick('valid'))).ok).toBe(true);
    expect(await first.unsafe("SELECT id FROM harness_shared.operator_turns WHERE role='user'")).toHaveLength(1);
  });
});
