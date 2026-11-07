/**
 * P-006 (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-10007901, D-015) over real Postgres.
 *
 * ENT-P-006-OUTCOME: a separated sensitive action executes only after the required distinct authorized
 * approvers approve it. The sample sensitive action is an organization/department governance policy
 * change, driven through the same control functions every door (governance:policy tool, admin pane
 * route) calls. Fixture: org-acme > dept-a > ws-a, org-acme > dept-b > ws-b, with delegations:
 *   admin:root      bootstrap root on org-acme (prepare, approve, delegate)
 *   admin:alice     approve + prepare on org-acme
 *   su-agent-1      prepare on org-acme (a SERVICE identity: an agent session)
 *   admin:dept-a    prepare + approve on dept-a only (a delegated department administrator)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type FreshTestDb } from '@papercusp/test-config/pg';
import {
  applyGovernancePolicyChange,
  decideGovernancePolicyChange,
  prepareGovernancePolicyChange,
  setGovernancePolicyLayer,
  type GovernancePolicyControlDeps,
  type PrepareChangeRequest,
} from './control';
import {
  authorize,
  coveringDelegations,
  createOrganizationLayer,
  grantDelegation,
  recordBootstrapDelegation,
  revokeDelegation,
} from './authority';
import {
  decideSensitiveAction,
  executeSensitiveAction,
  executeSensitiveActionInTransaction,
  getSensitiveAction,
  prepareSensitiveAction,
  SensitiveActionError,
  SENSITIVE_ACTION_EXECUTION_WINDOW_MS,
} from './sensitive-action';
import { listVersions, loadChainForWorkspace, loadLayer, lockPolicyChainForWorkspace, upsertLayer, upsertLayerInTx, type UpsertLayerInput } from './store';
import { evaluateInheritedPolicy } from './inherited-policy';

const SQL_DIR = '../../../../libs/papercusp/libs/db/sql/';
const MIGRATIONS = ['1497-governance-policy-layers.sql', '1498-governance-sensitive-actions.sql'].map((f) =>
  fileURLToPath(new URL(`${SQL_DIR}${f}`, import.meta.url)),
);

let sql: postgres.Sql;
let fixtureDb: FreshTestDb;
let clock: Date;
const HOUR = 60 * 60_000;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'govsensitive' });
  sql = postgres(fixtureDb.url, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  for (const file of MIGRATIONS) await sql.unsafe(readFileSync(file, 'utf8'));
  await sql`CREATE TABLE harness_shared.execution_fixture_effects (request_id text PRIMARY KEY, marker text NOT NULL)`;
}, 60_000);

afterAll(async () => {
  try {
    await sql?.end({ timeout: 5 });
  } finally {
    if (fixtureDb) {
      const outcome = await fixtureDb.dropWithResult({ sweepBudgetMs: 0 });
      console.log('SENSITIVE_ACTION_FIXTURE_CLEANUP', JSON.stringify({ database: fixtureDb.name, outcome }));
    }
  }
});

/** Control deps bound to the throwaway database and the test clock. */
function pg(): Partial<GovernancePolicyControlDeps> {
  return {
    loadChain: (workspaceId) => loadChainForWorkspace(workspaceId, sql),
    loadLayer: (layerId) => loadLayer(layerId, sql),
    upsertLayer: (input) => upsertLayer(input, sql),
    authorize: (principal, layerId, capability) => authorize(principal, layerId, capability, { now: clock, sql }),
    createOrganization: async (input) => (await createOrganizationLayer(input, sql)).layer,
    prepareAction: (input) => prepareSensitiveAction(input, sql),
    decideAction: (input) => decideSensitiveAction(input, sql),
    executeAction: (input, run) => executeSensitiveAction(input, run, sql),
    invalidateCache: () => {},
    notify: async () => {},
    now: () => clock,
  };
}

function layer(over: Partial<UpsertLayerInput> & Pick<UpsertLayerInput, 'layerId' | 'level' | 'scopeRef'>): UpsertLayerInput {
  return { parentLayerId: null, rules: {}, exceptions: [], actor: 'admin:root', reason: 'pilot baseline', ...over };
}

async function grant(grantor: string, principal: string, layerId: string, capabilities: string[], hours = 24) {
  return grantDelegation(
    { grantor, principal, layerId, capabilities, reason: 'pilot administration', expiresAt: new Date(clock.getTime() + hours * HOUR), now: clock },
    sql,
  );
}

beforeEach(async () => {
  clock = new Date();
  await sql.unsafe(`TRUNCATE harness_shared.sensitive_action_approvals, harness_shared.sensitive_action_requests,
    harness_shared.governance_delegations, harness_shared.governance_policy_layer_versions,
    harness_shared.governance_policy_layers, harness_shared.execution_fixture_effects`);
  await upsertLayer(layer({ layerId: 'org-acme', level: 'organization', scopeRef: 'acme', rules: { models: { allow: ['claude-*'] } } }), sql);
  await upsertLayer(layer({ layerId: 'dept-a', level: 'department', scopeRef: 'a', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'dept-b', level: 'department', scopeRef: 'b', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-a' }), sql);
  await upsertLayer(layer({ layerId: 'ws-b', level: 'workspace', scopeRef: 'ws-b', parentLayerId: 'dept-b' }), sql);
  await recordBootstrapDelegation(sql, { principal: 'admin:root', layerId: 'org-acme', now: clock });
  await grant('admin:root', 'admin:alice', 'org-acme', ['prepare', 'approve']);
  await grant('admin:root', 'su-agent-1', 'org-acme', ['prepare']);
  await grant('admin:root', 'admin:dept-a', 'dept-a', ['prepare', 'approve']);
});

/** A department-level change that denies processes:kill below dept-a, simulated against ws-a. */
const lockDeptA: PrepareChangeRequest = {
  layerId: 'dept-a',
  level: 'department',
  scopeRef: 'a',
  parentLayerId: 'org-acme',
  rules: { tools: { deny: ['processes:kill'] } },
  workspaceId: 'ws-a',
  reason: 'lock process control for the pilot',
  requests: [{ tools: ['processes:kill'] }],
};

async function prepared(actor = 'su-agent-1', change: PrepareChangeRequest = lockDeptA): Promise<string> {
  const out = await prepareGovernancePolicyChange(change, actor, pg());
  if (!out.ok) throw new Error(`prepare failed: ${out.code} ${out.error}`);
  return out.request.requestId;
}

async function deptAVersion(): Promise<number> {
  return (await loadLayer('dept-a', sql))!.version;
}

describe('ENT-P-006-OUTCOME: a separated sensitive action executes only after distinct authorized approval', () => {
  it('an agent prepares, cannot approve or execute alone, and executes once after a distinct human approves', async () => {
    const id = await prepared();
    const pending = await getSensitiveAction(id, sql);
    expect(pending).toMatchObject({ status: 'pending', preparedBy: 'su-agent-1', baseVersion: 1, authorityLayerId: 'dept-a' });
    expect(pending!.simulation).toMatchObject({ affectsWorkspace: true, changedCount: 1 });

    // Missing approval: execution is refused and nothing is written.
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'not-approved' });
    expect(await deptAVersion()).toBe(1);

    // The agent is a service identity: it can never approve, not even someone else's request.
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'lgtm' }, 'su-agent-1', pg())).toMatchObject({
      ok: false,
      code: 'self-approval',
    });
    const otherAgent = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'lgtm' }, 'su-agent-2', pg());
    // The refusal names the human-only rule, not a missing grant: granting authority can never make a
    // service identity an approver (authority.ts filters approve out and the DB check constraint agrees).
    expect(otherAgent).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringContaining('only a human administrator can decide') });

    const approved = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'reviewed the simulation' }, 'admin:alice', pg());
    expect(approved).toMatchObject({ ok: true, request: { status: 'approved' } });

    const applied = await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg());
    expect(applied).toMatchObject({ ok: true, revision: 'dept-a@v2', request: { status: 'executed', executedBy: 'su-agent-1' } });
    const history = await listVersions('dept-a', 5, sql);
    expect(history[0]).toMatchObject({ version: 2, actor: 'su-agent-1' });
    expect(history[0]!.reason).toContain('approved by admin:alice');

    // The enforcement path sees the change: ws-a now refuses processes:kill, inherited from dept-a.
    const load = await loadChainForWorkspace('ws-a', sql);
    if (load.status !== 'ok') throw new Error(`chain ${load.status}`);
    expect(evaluateInheritedPolicy(load.chain, { tools: ['processes:kill'] }).allow).toBe(false);

    // Replay: the one-time authorization is spent.
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'replayed' });
    expect(await deptAVersion()).toBe(2);
  });

  it('the same identity can never satisfy both roles: self-approval is refused in code and by the database', async () => {
    const id = await prepared('admin:alice');
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'mine' }, 'admin:alice', pg())).toMatchObject({
      ok: false,
      code: 'self-approval',
    });
    await expect(
      sql`INSERT INTO harness_shared.sensitive_action_approvals (request_id, approver, decision, reason) VALUES (${id}, 'admin:alice', 'approve', 'bypass')`,
    ).rejects.toMatchObject({ code: '42501' });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'pending', approvals: [] });
  });

  it('two required approvals need two DISTINCT authorized approvers', async () => {
    const out = await prepareGovernancePolicyChange({ ...lockDeptA, requiredApprovals: 2 }, 'su-agent-1', pg());
    if (!out.ok) throw new Error(out.error);
    const id = out.request.requestId;
    await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'one' }, 'admin:alice', pg());
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'again' }, 'admin:alice', pg())).toMatchObject({
      ok: false,
      code: 'already-decided',
    });
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'not-approved' });
    const second = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'two' }, 'admin:dept-a', pg());
    expect(second).toMatchObject({ ok: true, request: { status: 'approved' } });
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: true });
  });

  it('an approver without authority over the scope is refused; a delegated department admin approves only its own department', async () => {
    const deptChange = await prepared();
    expect(await decideGovernancePolicyChange({ requestId: deptChange, decision: 'approve', reason: 'x' }, 'admin:mallory', pg())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const orgChange = await prepared('su-agent-1', {
      ...lockDeptA,
      layerId: 'org-acme',
      level: 'organization',
      scopeRef: 'acme',
      parentLayerId: null,
      rules: { models: { allow: ['claude-*', 'gpt-*'] } },
    });
    expect(await decideGovernancePolicyChange({ requestId: orgChange, decision: 'approve', reason: 'x' }, 'admin:dept-a', pg())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await decideGovernancePolicyChange({ requestId: deptChange, decision: 'approve', reason: 'mine to approve' }, 'admin:dept-a', pg())).toMatchObject({
      ok: true,
      request: { status: 'approved' },
    });
  });

  it('an expired authorization is refused, and the request is closed', async () => {
    const id = await prepared();
    await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'ok' }, 'admin:alice', pg());
    clock = new Date(clock.getTime() + SENSITIVE_ACTION_EXECUTION_WINDOW_MS + 60_000);
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'expired' });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'expired' });
    expect(await deptAVersion()).toBe(1);
  });

  it('apply refuses without a fresh simulation: a change approved against an older chain is cancelled as stale', async () => {
    const first = await prepared();
    const second = await prepared('su-agent-1', { ...lockDeptA, rules: { tools: { deny: ['capability:bash'] } } });
    for (const id of [first, second]) {
      await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'ok' }, 'admin:alice', pg());
    }
    expect(await applyGovernancePolicyChange({ requestId: first }, 'su-agent-1', pg())).toMatchObject({ ok: true });
    expect(await applyGovernancePolicyChange({ requestId: second }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'stale' });
    expect(await getSensitiveAction(second, sql)).toMatchObject({ status: 'cancelled' });
    expect((await loadLayer('dept-a', sql))!.rules).toEqual(lockDeptA.rules);
  });
});

describe('sensitive action composition in an existing transaction (recovery D011)', () => {
  const dbClock = async (tx: postgres.Sql) => (await tx`SELECT clock_timestamp() AS now`)[0]!.now as Date;
  const executeInput = (requestId: string) => ({ requestId, executor: 'su-agent-1' });
  const effectCount = async () => Number((await sql`SELECT count(*)::int AS n FROM harness_shared.execution_fixture_effects`)[0]!.n);
  const effect = async (tx: postgres.Sql, requestId: string) => {
    await tx`INSERT INTO harness_shared.execution_fixture_effects VALUES (${requestId}, 'fenced')`;
    return { requestId, state: 'fenced' };
  };
  const approved = async () => {
    const id = await prepared();
    await decideSensitiveAction({ requestId: id, approver: 'admin:alice', decision: 'approve', reason: 'fixture approval', now: clock }, sql);
    return id;
  };
  function signal<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it('commits the effect, result and one-use mark together on the caller connection', async () => {
    const id = await approved();
    const effected = signal<number>();
    const commit = signal();
    const executing = sql.begin(async (tx) => {
      // A real scope lock may precede the request; the executor must not open a new transaction.
      await tx`SELECT pg_advisory_xact_lock(hashtext('sensitive-action-composition-fixture'))`;
      const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
      return executeSensitiveActionInTransaction(tx, executeInput(id), async (sp) => {
        expect((await sp`SELECT pg_backend_pid() AS pid`)[0]!.pid).toBe(pid);
        const result = await effect(sp, id);
        effected.resolve(pid);
        await commit.promise;
        return result;
      }, dbClock);
    });
    try {
      await effected.promise;
      expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'approved', executedAt: null });
      expect(await effectCount()).toBe(0);
    } finally {
      commit.resolve();
    }
    const outcome = await executing;
    expect(outcome).toMatchObject({ ok: true, request: { status: 'executed', executedBy: 'su-agent-1' }, result: { requestId: id, state: 'fenced' } });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'executed', result: { requestId: id, state: 'fenced' } });
    expect(await effectCount()).toBe(1);
  });

  it('rolls stale effects back before committing cancellation outside the savepoint', async () => {
    const id = await approved();
    const outcome = await sql.begin((tx) => executeSensitiveActionInTransaction(tx, executeInput(id), async (sp) => {
      await effect(sp, id);
      throw new SensitiveActionError('stale', 'fixture pin changed');
    }, dbClock));
    expect(outcome).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'cancelled', executedAt: null, result: { cancelled: 'stale' } });
    expect(await effectCount()).toBe(0);
  });

  it.each([new Error('effect failed'), new SensitiveActionError('expired', 'effect-specific error')])(
    'preserves public rollback behavior for an ordinary callback failure: %s', async (failure) => {
      const id = await approved();
      await expect(executeSensitiveAction(executeInput(id), async (sp) => {
        await effect(sp, id);
        throw failure;
      }, sql)).rejects.toBe(failure);
      expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'approved', executedAt: null, result: null });
      expect(await effectCount()).toBe(0);
    },
  );

  it('rolls back a successful inner execution if the owning transaction aborts', async () => {
    const id = await approved();
    await expect(sql.begin(async (tx) => {
      const result = await executeSensitiveActionInTransaction(tx, executeInput(id), (sp) => effect(sp, id), dbClock);
      expect(result).toMatchObject({ ok: true });
      throw new Error('outer abort');
    })).rejects.toThrow('outer abort');
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'approved', executedAt: null, result: null });
    expect(await effectCount()).toBe(0);
  });

  it('serializes two connections so one request funds exactly one effect', async () => {
    const id = await approved();
    let calls = 0;
    const outcomes = await Promise.all([1, 2].map(() => sql.begin((tx) => executeSensitiveActionInTransaction(
      tx, executeInput(id), async (sp) => { calls++; return effect(sp, id); }, dbClock,
    ))));
    expect(outcomes.filter((out) => out.ok)).toHaveLength(1);
    expect(outcomes.filter((out) => !out.ok)).toMatchObject([{ ok: false, error: { code: 'replayed' } }]);
    expect(calls).toBe(1);
    expect(await effectCount()).toBe(1);
  });

  it('reads database wall time after a request-lock wait and commits expiry without running effects', async () => {
    const id = await approved();
    const locked = signal();
    const release = signal();
    const lockDispatched = signal();
    const executorSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {},
      debug: (_connection, query) => {
        if (query.includes('sensitive_action_requests') && query.includes('FOR UPDATE')) lockDispatched.resolve();
      },
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT request_id FROM harness_shared.sensitive_action_requests WHERE request_id = ${id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
      // Expire under the held lock. Cross the stored Date's millisecond boundary before
      // commit, so the real post-lock clock must distinguish it without a timed host poll.
      await tx`UPDATE harness_shared.sensitive_action_requests
        SET execute_by = date_trunc('milliseconds', clock_timestamp()) WHERE request_id = ${id}`;
      await tx`SELECT pg_sleep(GREATEST(0, extract(epoch FROM (execute_by + interval '1 millisecond' - clock_timestamp()))))
        FROM harness_shared.sensitive_action_requests WHERE request_id = ${id}`;
    });
    await locked.promise;
    let calls = 0, clockReads = 0;
    const executing = executorSql.begin((tx) => executeSensitiveActionInTransaction(tx, executeInput(id),
      async (sp) => { calls++; return effect(sp, id); },
      async (sp) => { clockReads++; return dbClock(sp); }));
    let outcome: Awaited<typeof executing>;
    try {
      await Promise.race([lockDispatched.promise, executing.then(() => { throw new Error('execution finished before its lock barrier'); })]);
      expect(clockReads).toBe(0);
      release.resolve();
      await holder;
      outcome = await executing;
    } finally {
      release.resolve();
      await Promise.allSettled([holder, executing]);
      await executorSql.end({ timeout: 5 });
    }
    expect(outcome).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(clockReads).toBe(1);
    expect(calls).toBe(0);
    expect(await effectCount()).toBe(0);
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'expired', executedAt: null });
  });

  it('rechecks database time at the execution mark and rolls every late effect back before expiry', async () => {
    const id = await approved();
    await sql`UPDATE harness_shared.sensitive_action_requests SET execute_by = clock_timestamp() + interval '1 second' WHERE request_id = ${id}`;
    let calls = 0;
    const outcome = await sql.begin((tx) => executeSensitiveActionInTransaction(tx, executeInput(id), async (sp) => {
      calls++;
      const result = await effect(sp, id);
      await sp`SELECT pg_sleep(GREATEST(0, extract(epoch FROM (execute_by - clock_timestamp()))) + 0.02)
        FROM harness_shared.sensitive_action_requests WHERE request_id = ${id}`;
      return result;
    }, dbClock));
    expect(outcome).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(calls).toBe(1);
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'expired', executedAt: null, result: null });
    expect(await effectCount()).toBe(0);
  });

  it('keeps public replay and payload-mismatch refusals without rerunning an effect', async () => {
    const id = await approved();
    await expect(executeSensitiveAction({ ...executeInput(id), expectedPayloadHash: 'wrong' }, (sp) => effect(sp, id), sql))
      .rejects.toMatchObject({ code: 'payload-mismatch' });
    expect(await effectCount()).toBe(0);
    await executeSensitiveAction(executeInput(id), (sp) => effect(sp, id), sql);
    await expect(executeSensitiveAction(executeInput(id), (sp) => effect(sp, id), sql)).rejects.toMatchObject({ code: 'replayed' });
    expect(await effectCount()).toBe(1);
  });
});

describe('custody supporting-delegation locks (D011)', () => {
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('requires a real transaction and rejects caller time for a locked authority read', async () => {
    await expect(coveringDelegations('admin:alice', 'ws-a', { sql, lock: 'share' }))
      .rejects.toMatchObject({ code: 'invalid' });
    await sql.begin(async raw => {
      await expect(coveringDelegations('admin:alice', 'ws-a', { sql: raw as unknown as postgres.Sql,
        lock: 'share', now: clock })).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  it('locks the full distinct population in delegation-id order and blocks a concurrent revoke', async () => {
    const held = signal(), release = signal();
    let grants: Awaited<ReturnType<typeof coveringDelegations>> = [];
    const holder = sql.begin(async raw => {
      grants = await coveringDelegations(['su-agent-1', 'admin:alice', 'admin:alice'], 'ws-a',
        { sql: raw as unknown as postgres.Sql, lock: 'share' });
      held.resolve();
      await release.promise;
    });
    try {
      await Promise.race([held.promise, holder.then(() => { throw new Error('holder exited before lock receipt'); })]);
      expect(grants.map(d => d.delegationId)).toEqual(grants.map(d => d.delegationId).sort());
      expect(grants.map(d => d.principal).sort()).toEqual(['admin:alice', 'su-agent-1']);
      expect(grants.find(d => d.principal === 'su-agent-1')!.capabilities).toEqual(['prepare']);
      // A real UPDATE, with a local lock timeout, cannot revoke through a held SHARE lock.
      const id = grants.find(d => d.principal === 'admin:alice')!.delegationId;
      await expect(sql.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        await revokeDelegation({ delegationId: id, revoker: 'admin:alice', reason: 'concurrent revocation' }, tx as unknown as postgres.Sql);
      })).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release.resolve();
      await holder;
    }
    const id = grants.find(d => d.principal === 'admin:alice')!.delegationId;
    await revokeDelegation({ delegationId: id, revoker: 'admin:alice', reason: 'after fence commit' }, sql);
    expect(await sql.begin(tx => coveringDelegations('admin:alice', 'ws-a',
      { sql: tx as unknown as postgres.Sql, lock: 'share' }))).toEqual([]);
  });

  it.each(['expiry', 'revocation'] as const)('revalidates %s after waiting for a supporting delegation lock', async fault => {
    const principal = fault === 'expiry' ? 'admin:deadline' : 'admin:alice';
    const grant = fault === 'expiry'
      ? await grantDelegation({ grantor: 'admin:root', principal, layerId: 'org-acme', capabilities: ['approve'],
        reason: 'immutable short-lived fixture grant', expiresAt: new Date(Date.now() + 1500) }, sql)
      : (await coveringDelegations(principal, 'ws-a', { sql }))[0];
    const held = signal(), release = signal(), dispatched = signal();
    const reader = postgres(fixtureDb.url, { max: 1, onnotice: () => {}, debug: (_connection, query) => {
      if (query.includes('governance_delegations') && query.includes('FOR SHARE')) dispatched.resolve();
    } });
    const holder = sql.begin(async tx => {
      await tx`SELECT delegation_id FROM harness_shared.governance_delegations WHERE delegation_id = ${grant.delegationId} FOR UPDATE`;
      held.resolve();
      await release.promise;
      if (fault === 'revocation') {
        await revokeDelegation({ delegationId: grant.delegationId, revoker: principal, reason: 'revoked before consumption' },
          tx as unknown as postgres.Sql);
      } else {
        // Grant fields are immutable. Cross the real grant deadline without editing it.
        await tx`SELECT pg_sleep(GREATEST(0, extract(epoch FROM (expires_at - clock_timestamp()))) + 0.002)
          FROM harness_shared.governance_delegations
          WHERE delegation_id = ${grant.delegationId}`;
      }
    });
    await held.promise;
    const reading = reader.begin(tx => coveringDelegations(principal, 'ws-a', { sql: tx as unknown as postgres.Sql, lock: 'share' }));
    try {
      await Promise.race([dispatched.promise, reading.then(() => { throw new Error('reader finished before lock dispatch'); })]);
      release.resolve();
      await holder;
      expect(await reading).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([holder, reading]);
      await reader.end({ timeout: 5 });
    }
  });

  it('cannot borrow a covering grant from a sibling workspace', async () => {
    expect(await sql.begin(tx => coveringDelegations('admin:dept-a', 'ws-b',
      { sql: tx as unknown as postgres.Sql, lock: 'share' }))).toEqual([]);
  });
});

describe('custody root-first policy-chain locks (D011)', () => {
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('refuses a pool outside a transaction and preserves missing workspace refusal', async () => {
    await expect(lockPolicyChainForWorkspace('ws-a', sql)).rejects.toThrow('existing transaction');
    expect(await sql.begin(tx => lockPolicyChainForWorkspace('unknown', tx as unknown as postgres.Sql)))
      .toEqual({ status: 'none' });
  });

  it('locks root, department and leaf in order and holds them through the outer commit', async () => {
    const queries: unknown[][] = [], held = signal(), release = signal();
    const reader = postgres(fixtureDb.url, { max: 1, onnotice: () => {}, debug: (_connection, query, params) => {
      if (query.includes('governance_policy_layers') && query.includes('FOR SHARE')) queries.push([...params]);
    } });
    const holding = reader.begin(async raw => {
      const result = await lockPolicyChainForWorkspace('ws-a', raw as unknown as postgres.Sql);
      expect(result.status).toBe('ok');
      held.resolve();
      await release.promise;
    });
    try {
      await Promise.race([held.promise, holding.then(() => { throw new Error('reader exited before chain lock receipt'); })]);
      expect(queries).toEqual([['org-acme'], ['dept-a'], ['ws-a']]);
      for (const id of ['org-acme', 'dept-a', 'ws-a']) {
        await expect(sql.begin(async tx => {
          await tx`SET LOCAL lock_timeout = '100ms'`;
          await tx`SELECT layer_id FROM harness_shared.governance_policy_layers WHERE layer_id = ${id} FOR UPDATE`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
      // Sibling rows are not accidentally locked by a recursive table scan.
      await sql.begin(tx => tx`SELECT layer_id FROM harness_shared.governance_policy_layers WHERE layer_id = 'dept-b' FOR UPDATE NOWAIT`);
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
      await reader.end({ timeout: 5 });
    }
    await sql.begin(tx => tx`SELECT layer_id FROM harness_shared.governance_policy_layers WHERE layer_id = 'org-acme' FOR UPDATE NOWAIT`);
  });

  it.each(['version', 'parent'] as const)('refuses %s drift committed while waiting on the root', async fault => {
    const held = signal(), release = signal(), dispatched = signal();
    const reader = postgres(fixtureDb.url, { max: 1, onnotice: () => {}, debug: (_connection, query) => {
      if (query.includes('governance_policy_layers') && query.includes('FOR SHARE')) dispatched.resolve();
    } });
    const holder = sql.begin(async tx => {
      await tx`SELECT layer_id FROM harness_shared.governance_policy_layers WHERE layer_id = 'org-acme' FOR UPDATE`;
      held.resolve();
      await release.promise;
      if (fault === 'version') {
        await upsertLayerInTx(tx as unknown as postgres.Sql, layer({ layerId: 'org-acme', level: 'organization', scopeRef: 'acme',
          rules: { models: { allow: ['codex-*'] } } }));
      } else {
        await upsertLayerInTx(tx as unknown as postgres.Sql,
          layer({ layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-b' }));
      }
    });
    await held.promise;
    const reading = reader.begin(tx => lockPolicyChainForWorkspace('ws-a', tx as unknown as postgres.Sql));
    try {
      await Promise.race([dispatched.promise, reading.then(() => { throw new Error('reader finished before root lock dispatch'); })]);
      release.resolve();
      await holder;
      expect(await reading).toMatchObject({ status: 'malformed', reason: 'policy chain changed while acquiring root-first locks' });
    } finally {
      release.resolve();
      await Promise.allSettled([holder, reading]);
      await reader.end({ timeout: 5 });
    }
  });
});

describe('delegated administration and ordinary permitted work (R-3)', () => {
  const wsWrite = (layerId: string, parentLayerId: string) => ({
    layerId,
    level: 'workspace' as const,
    scopeRef: layerId,
    parentLayerId,
    rules: { tools: { allow: ['work_items:*'] } },
    reason: 'workspace tool allowance',
  });

  it('a department admin writes its own workspaces directly but nothing outside its delegated scope', async () => {
    expect(await setGovernancePolicyLayer(wsWrite('ws-a', 'dept-a'), 'admin:dept-a', pg())).toMatchObject({ ok: true, revision: 'ws-a@v2' });
    expect(await setGovernancePolicyLayer(wsWrite('ws-b', 'dept-b'), 'admin:dept-a', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await setGovernancePolicyLayer(wsWrite('ws-a', 'dept-b'), 'admin:dept-a', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await loadLayer('ws-b', sql))!.version).toBe(1);
    // An org- or department-level edit is never a direct write, even for the root administrator.
    expect(
      await setGovernancePolicyLayer({ ...wsWrite('dept-a', 'org-acme'), level: 'department', scopeRef: 'a' }, 'admin:root', pg()),
    ).toMatchObject({ ok: false, code: 'approval-required' });
  });

  it('authority is bounded: no self-grant, no escalation beyond the grantor, no approve for a service identity', async () => {
    await expect(grant('admin:dept-a', 'admin:eve', 'org-acme', ['prepare'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant('admin:dept-a', 'admin:dept-a', 'dept-a', ['prepare'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant('admin:root', 'su-agent-2', 'org-acme', ['approve'])).rejects.toMatchObject({ code: 'invalid' });
    await expect(grant('admin:root', 'admin:eve', 'org-acme', ['prepare'], 24 * 120)).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      sql`INSERT INTO harness_shared.governance_delegations (principal, principal_kind, layer_id, capabilities, granted_by, reason, expires_at)
          VALUES ('su-agent-9', 'service', 'org-acme', ARRAY['approve'], 'admin:root', 'bypass', now() + interval '1 day')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('revoked and expired delegations stop authorizing, and grant rows are revoke-only', async () => {
    const short = await grant('admin:root', 'admin:temp', 'dept-b', ['prepare'], 1);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: clock, sql })).toBe(true);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: new Date(clock.getTime() + 2 * HOUR), sql })).toBe(false);
    await revokeDelegation({ delegationId: short.delegationId, revoker: 'admin:root', reason: 'pilot ended', now: clock }, sql);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: clock, sql })).toBe(false);
    await expect(sql`DELETE FROM harness_shared.governance_delegations WHERE delegation_id = ${short.delegationId}`).rejects.toMatchObject({
      code: '55000',
    });
  });

  it('only a human can bootstrap a new organization, and an administered organization cannot be re-rooted', async () => {
    const org = { layerId: 'org-new', level: 'organization' as const, scopeRef: 'new', parentLayerId: null, rules: {}, reason: 'new tenant' };
    expect(await setGovernancePolicyLayer(org, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await setGovernancePolicyLayer(org, 'admin:founder', pg())).toMatchObject({ ok: true, revision: 'org-new@v1' });
    expect(await authorize('admin:founder', 'org-new', 'delegate', { now: clock, sql })).toBe(true);
    await expect(recordBootstrapDelegation(sql, { principal: 'admin:usurper', layerId: 'org-new', now: clock })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
