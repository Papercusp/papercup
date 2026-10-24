/** Private-data composition for native takeover tests. Only the administrative
 * grant is fixture-owned; preparation readers, custody, pause/recovery, host
 * inspection and coordination storage are production implementations. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { setupBaselineCoordFixture } from '../../../packages/operator-core/lib/_baseline-coord-fixture';
import { prepareAssume, validateAssume, commitAssume, type AssumePreparation,
  verifyAssumeExecution, type AssumeExecutionObservation,
  type AssumeTransitionReceipt } from '../../../packages/operator-core/lib/session-assume';
import { readAssumeCaller, readAssumeTarget } from '../../../packages/operator-core/lib/session-assume-preparation';
import { createAssumeTransitionDeps, inspectManagedAssumeRequest } from '../../../packages/operator-core/lib/session-assume-runtime';
import { createManagedAssumeHost } from '../../../packages/operator-core/lib/session-assume-host';
import { findLiveHostAsync, injectIntoHostWithConfirmation } from
  '../../../packages/operator-core/lib/events/await/psu-pty-discovery';
import { createAssumeReceiptStore } from '../../../packages/operator-core/lib/session-assume-store';
import { readAssumeCallerPause } from '../../../packages/operator-core/lib/session-assume-pause';
import { loopScope, setCarryNote } from '../../../packages/operator-core/lib/carry-note';
import { runWithWorkspace } from '../../../packages/operator-core/lib/workspace-als';
import { getWorkItem } from '../../../packages/operator-core/lib/work-items';
import { setWorkItemCheckpoint } from '../../../packages/operator-core/lib/work-item-checkpoint';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from
  '../../../packages/operator-core/lib/agent-tools/coordination/messages';
import { resolveAgentIdentity } from '../../../packages/operator-core/lib/agent-tools/coordination/identity';
import { getAdvSession, finalizeAdvSessionResume, reanchorAdvSessionNativeId } from '../../../packages/operator-core/lib/adv-sessions';
import { cleanupScopedNativeFixtureDatabase } from './scoped-native-fixture-cleanup';

export async function productionAssumeFixture(workspaceId: string,
  onDatabase: (sql: OrgTestDb['adminSql']) => void) {
  const database = await createOrgTestDb();
  onDatabase(database.adminSql);
  const fixture = await setupBaselineCoordFixture({ dsn: database.adminDsn });
  const secret = randomBytes(32);
  const sql = fixture.admin;
  const identity = (ownerId: string) => resolveAgentIdentity({ uiClientId: ownerId,
    workspaceId, isSuperuser: true });
  const scoped = <T>(fn: () => Promise<T>) => runWithWorkspace(workspaceId, fn);
  const records = new Map<string, number>();
  const trace: Array<{ stage: string; error?: string }> = [];
  return {
    sql, records, trace,
    async register(owner: string, native: string, home: string, ended: boolean) {
      const [row] = await sql`INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, role, coord_owner_id, session_id, cwd, launch_argv, started_at, ended_at, ended_by)
        VALUES (${workspaceId}, 'codex', 'console', 'su', ${owner}, ${native}, ${home},
          '["--harness=papercusp"]'::jsonb, now(), ${ended ? new Date() : null}, ${ended ? 'self' : null}) RETURNING id`;
      records.set(owner, Number(row.id));
      return Number(row.id);
    },
    async checkpoint(owner: string, body: string) {
      await setCarryNote({ scope: loopScope('papercusp', owner), workspaceId }, body);
    },
    async prepare(owner: string, targetOwnerId: string, contextMode: 'native-resume' | 'checkpoint') {
      const actor = { ownerId: owner, workspaceId };
      const request = { requestId: randomUUID(), targetOwnerId, contextMode };
      const deps = { now: Date.now, secret, authorize: async () => 'fixture:administrative-launch-grant',
        caller: readAssumeCaller, target: (value: typeof request) => readAssumeTarget(value, workspaceId) };
      const result = await scoped(() => prepareAssume(actor, request, deps));
      if (!result.ok) throw new Error('Production preparation refused: ' + result.code);
      const validated = await scoped(() => validateAssume(actor, result.token, deps));
      if (!validated.ok) throw new Error('Production validation refused: ' + validated.code);
      return validated.preparation;
    },
    commit: (plan: AssumePreparation) => scoped(() => commitAssume(plan,
      new Proxy(createAssumeTransitionDeps(plan, createManagedAssumeHost(plan, {
        async findHost(owner) {
          const found = await findLiveHostAsync(owner);
          trace.push({ stage: 'host-discovery', error: JSON.stringify({ native: found?.nativeSessionId,
            expected: plan.caller.nativeSessionId, pid: found?.ptyPid, expectedPid: plan.caller.nativePid }) });
          return found;
        },
        async send(sock, message, timeoutMs) {
          const result = await injectIntoHostWithConfirmation(sock, message, timeoutMs);
          trace.push({ stage: 'host-send', error: JSON.stringify(result) });
          return result;
        },
      })), {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function' || key === 'now') return value;
          return async (...args: unknown[]) => {
            try { const result = await value.apply(target, args); trace.push({ stage: String(key) }); return result; }
            catch (error) { trace.push({ stage: String(key), error: String(error) }); throw error; }
          };
        },
      }))),
    inspect: (request: unknown, afterExit = false, action = 'observe') =>
      scoped(() => inspectManagedAssumeRequest(request, afterExit, action)),
    load: (plan: AssumePreparation) => scoped(() => createAssumeReceiptStore(plan).load()),
    save: (receipt: AssumeTransitionReceipt) => scoped(() => createAssumeReceiptStore(receipt.preparation).save(receipt)),
    verify: (receipt: AssumeTransitionReceipt, observation: AssumeExecutionObservation) => scoped(async () => {
      const store = createAssumeReceiptStore(receipt.preparation);
      await store.load(); // initialize the existing receipt CAS, never bypass it
      return verifyAssumeExecution(receipt, observation, async value => {
        try { await store.save(value); }
        catch (error) { trace.push({ stage: 'verify-save', error: String(error) }); throw error; }
      });
    }),
    pause: (owner: string) => scoped(() => readAssumeCallerPause(owner)),
    resolve: (id: number) => scoped(() => getAdvSession(id)),
    async finalize(plan: AssumePreparation, transitionKey: string, native: string) {
      return scoped(async () => {
        if (!await finalizeAdvSessionResume(plan.target.advSessionId, transitionKey))
          throw new Error('Native fixture resume finalization refused');
        if (native !== plan.target.nativeSessionId) {
          const result = await reanchorAdvSessionNativeId(plan.target.advSessionId, native);
          if (!result.reanchored || result.owner !== plan.target.ownerId)
            throw new Error('Native fixture checkpoint reanchor refused');
        }
        return getAdvSession(plan.target.advSessionId);
      });
    },
    async depart(owner: string) {
      await sql`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'self', pid = NULL
        WHERE id = ${records.get(owner)!}`;
    },
    async send(owner: string, text: string) {
      return scoped(() => sendMessage(identity('test-assume-router'), { to: [owner], summary: text }));
    },
    async assign(owner: string) {
      const id = 'WI-native-assume-' + randomUUID();
      await sql`INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, admission, taken_by, taken_at, updated_ts)
        VALUES (${workspaceId}, 'papercusp', ${id}, 'native target assignment', 'open', 'feature', 'local',
          NULL, ${owner}, now(), ${Date.now()})`;
      await setWorkItemCheckpoint({ workspaceId, harness: 'papercusp', workItemId: id },
        'Native fixture work remains recoverable under ' + owner);
      return id;
    },
    async probe(owner: string, workId: string) {
      return scoped(async () => {
        const who = identity(owner);
        const inbox = await readInbox(who.ownerId);
        const prior = await readAckedMsgIds(who.ownerId);
        const unread = inbox.filter(row => !prior.has(row.msg_id));
        for (const row of unread) await appendAck(who, row.msg_id, row.from);
        const work = await getWorkItem(workId, 'papercusp');
        return { ownerId: who.ownerId, messages: unread.map(row => ({ id: row.msg_id, to: row.to, from: row.from })),
          assignment: { id: work?.id, assignee: work?.assignee, observedBy: who.ownerId } };
      });
    },
    pending: (owner: string) => scoped(async () => {
      const acked = await readAckedMsgIds(owner);
      return (await readInbox(owner)).filter(row => !acked.has(row.msg_id));
    }),
    async dispose() {
      await cleanupScopedNativeFixtureDatabase({ adminSql: database.adminSql, cleanup: async () => {
        try { await fixture.dispose(); } finally { await database.cleanup(); }
      } });
    },
  };
}
