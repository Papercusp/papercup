/** Production adapter for the shared interruption classifier. Uses the existing
 * host-event WAL/ingest, session lifecycle JSON, and governed exact-resume door. */
import { getOrgPg } from '@papercusp/db-org';
import { findLiveHostAsync } from '../../events/await/psu-pty-discovery';
import { readWorkItemAwaitTargets, isWakeSource,
  readHeldWorkItems } from '../../events/await/wake-source-predicate';
import { hasPendingDeliberateWakeDelivery } from '../../events/await/store';
import { listPendingGates } from '../../attention/gate-store';
import { readAssumeCallerPause } from '../../session-assume-pause';
import { getLoopStatuses } from './loop';
import { ingestPsuPtyHostEvents } from './psu-pty-host-events-ingest';
import { recoverInterruptedSessions, sessionRecoveryKey, SESSION_RECOVERY_LEASE_MS,
  type SessionInterruption, type SessionRecoveryEvidence } from './session-interruption-recovery';
import type { SystemActionCtx } from './system-actions';

interface SourceRow {
  owner_id: string; session_id: string; retired_at: unknown; pid: number | null;
  launch_spec: Record<string, unknown> | null; payload: Record<string, unknown>; ts: Date | string;
  receipt: (SessionInterruption & { key: string }) | null;
}

function processState(pid: number | null): 'live' | 'dead' | 'unknown' {
  if (!pid || !Number.isInteger(pid)) return 'dead';
  try { process.kill(pid, 0); return 'live'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/** Reject malformed or foreign snapshots instead of turning absent execution into work. */
export function interruptionFromEvent(row: Pick<SourceRow, 'owner_id' | 'session_id' | 'payload' | 'ts'>): SessionInterruption | null {
  const p = row.payload;
  const x = p.execution as SessionInterruption['execution'] | undefined;
  if (!x || p.ownerId !== row.owner_id || p.nativeSessionId !== row.session_id ||
      x.ownerId !== row.owner_id || x.hostPid !== p.hostPid ||
      typeof p.hostPid !== 'number' || typeof p.hostStartedAt !== 'number') return null;
  return { v: 1, ownerId: row.owner_id, nativeSessionId: row.session_id,
    hostPid: p.hostPid, hostStartedAt: p.hostStartedAt, execution: x,
    capturedAt: new Date(row.ts).getTime(), attempts: 0, nextAttemptAt: 0, state: 'pending' };
}

export async function sweepSessionInterruptions(ctx: SystemActionCtx, dryRun = false) {
  const sql = getOrgPg().sql;
  // Make the host WAL durable before reading it; reuse its bounded, fair ingest.
  if (!dryRun) {
    const ingested = await ingestPsuPtyHostEvents({ workspaceId: ctx.workspaceId });
    if (ingested.ingestErrors) throw new Error(`interruption witness ingest failed: ${ingested.firstIngestError}`);
  }
  const readRows = async (owner?: string): Promise<SourceRow[]> => sql<SourceRow[]>`
    SELECT e.owner_id, COALESCE(a.session_id, a.omp_thread_id) AS session_id, a.retired_at, a.pid, a.launch_spec, e.payload, e.ts,
           b.control_state #> '{lifecycle,interruption}' AS receipt
      FROM (
        SELECT DISTINCT ON (owner_id) owner_id, payload, ts
          FROM harness_shared.psu_pty_host_events
         WHERE workspace_id = ${ctx.workspaceId} AND kind = 'session-execution-observed'
           AND payload->>'workspaceId' = ${ctx.workspaceId}
           AND ${owner ? sql`owner_id = ${owner}` : sql`true`}
         ORDER BY owner_id, ts DESC
      ) e
      JOIN harness_shared.adv_sessions a ON a.id::text = e.payload->>'advSessionId'
        AND a.workspace_id = ${ctx.workspaceId} AND a.coord_owner_id = e.owner_id
        AND COALESCE(a.session_id, a.omp_thread_id) = e.payload->>'nativeSessionId'
      LEFT JOIN harness_shared.session_briefs b ON b.owner_id = e.owner_id
        AND b.workspace_id = ${ctx.workspaceId}
     WHERE NOT EXISTS (SELECT 1 FROM harness_shared.adv_sessions newer
       WHERE newer.coord_owner_id = a.coord_owner_id AND newer.workspace_id = a.workspace_id
         AND newer.started_at > a.started_at)
       AND NOT (COALESCE(b.control_state #>> '{lifecycle,interruption,state}', '') IN ('restored', 'blocked')
         AND b.control_state #>> '{lifecycle,interruption,hostPid}' = e.payload->>'hostPid'
         AND b.control_state #>> '{lifecycle,interruption,hostStartedAt}' = e.payload->>'hostStartedAt'
         AND b.control_state #>> '{lifecycle,interruption,nativeSessionId}' = e.payload->>'nativeSessionId')
     ORDER BY e.ts ASC LIMIT 100`;
  const evidence = async (row: SourceRow): Promise<SessionRecoveryEvidence> => {
    const owner = row.owner_id;
    let interruption = interruptionFromEvent(row);
    if (interruption && row.receipt?.key === sessionRecoveryKey(interruption)) interruption = row.receipt;
    const host = await findLiveHostAsync(owner);
    const liveness = host ? 'live' : processState(row.pid);
    const [awaits, statuses, held, gates, pause, delivery] = await Promise.all([
      // policy=wake is load-bearing: notify-only interest must not suppress work.
      sql<Array<{ subscriber_id: string; event_key: string; expires_ts: Date | null;
        timeout_behavior: string | null; once: boolean }>>`
        SELECT subscriber_id, event_key, expires_ts, timeout_behavior, once
          FROM harness_shared.event_awaits WHERE subscriber_id = ${owner} AND policy = 'wake'
           AND fired_at IS NULL AND cancelled_at IS NULL AND (expires_ts IS NULL OR expires_ts > now())`,
      getLoopStatuses([owner], { sql }), readHeldWorkItems(owner, ctx.workspaceId, sql),
      listPendingGates({ workspaceId: ctx.workspaceId, sessionId: row.session_id, limit: 1 }),
      readAssumeCallerPause(owner), hasPendingDeliberateWakeDelivery(owner),
    ]);
    const shaped = awaits.map(a => ({ subscriberId: a.subscriber_id, eventKey: a.event_key,
      expiresTs: a.expires_ts?.toISOString() ?? null, timeoutBehavior: a.timeout_behavior, once: a.once }));
    const targets = await readWorkItemAwaitTargets(shaped, sql);
    const loop = statuses.get(owner);
    return { ownerId: owner, nativeSessionId: row.session_id, liveness,
      retired: row.retired_at != null, recoveryEnabled: true,
      deliberatelyPaused: pause != null || loop?.explicitlyEnded === true,
      launchRecipeAvailable: row.launch_spec != null,
      headless: typeof row.launch_spec?.headless === 'boolean' ? row.launch_spec.headless : null,
      interruption, humanDecisionPending: gates.length > 0,
      meaningfulWaits: shaped.filter(a => isWakeSource(a, targets, 'coord:inbox-wake:')).length + Number(delivery),
      actionableHeldWork: held.filter(h => h.eventBlockers.length === 0).length,
      loop: loop ? { active: loop.active, goal: loop.goal,
        nextFireAt: loop.nextFireAt ? Date.parse(loop.nextFireAt) : null } : null };
  };
  return recoverInterruptedSessions({
    list: async () => Promise.all((await readRows()).map(evidence)),
    claim: async (candidate, key) => {
      if (dryRun || !candidate.interruption) return null;
      const s = candidate.interruption;
      const next = { ...s, key, leaseKey: key, state: 'recovering', attempts: s.attempts + 1,
        nextAttemptAt: Date.now() + SESSION_RECOVERY_LEASE_MS };
      const rows = await sql`
        INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
        VALUES (${s.ownerId}, ${ctx.workspaceId},
          jsonb_build_object('lifecycle', jsonb_build_object('interruption', ${JSON.stringify(next)}::jsonb)))
        ON CONFLICT (owner_id) DO UPDATE SET control_state =
          COALESCE(session_briefs.control_state, '{}'::jsonb) || jsonb_build_object('lifecycle',
            COALESCE(session_briefs.control_state->'lifecycle', '{}'::jsonb) ||
              jsonb_build_object('interruption', ${JSON.stringify(next)}::jsonb))
        WHERE session_briefs.workspace_id = ${ctx.workspaceId} AND (
          session_briefs.control_state #>> '{lifecycle,interruption,key}' IS DISTINCT FROM ${key}
          OR (session_briefs.control_state #>> '{lifecycle,interruption,state}' NOT IN ('restored', 'blocked')
            AND (session_briefs.control_state #>> '{lifecycle,interruption,attempts}')::int = ${s.attempts}
            AND (session_briefs.control_state #>> '{lifecycle,interruption,nextAttemptAt}')::bigint <= ${Date.now()}))
        RETURNING owner_id`;
      if (!rows.length) return null;
      const fresh = (await readRows(s.ownerId))[0];
      // A newer host/native session invalidates this lease instead of inheriting it.
      if (!fresh) return { ...candidate, retired: true };
      const e = await evidence(fresh);
      return e.interruption && sessionRecoveryKey(e.interruption) === key ? e : { ...e, retired: true };
    },
    restore: async (candidate, decision, key) => {
      const { default: tool, INTERNAL_INTERRUPTION_RECOVERY } = await import('../../agent-tools/capability/launch-agent');
      const response = await tool.handler({ resume: { agentId: candidate.ownerId }, fork: false,
        headless: decision.headless,
        ...(decision.action === 'resume-work' ? { brief:
          'Your native session was interrupted. Continue only the unfinished request and registered work already in this conversation. Re-read current controls and checkpoints; honor stops and pending human decisions.' } : {}),
        idempotencyKey: `${key}:${candidate.interruption!.attempts}`,
        [INTERNAL_INTERRUPTION_RECOVERY]: { ownerId: candidate.ownerId,
          nativeSessionId: candidate.nativeSessionId!, wait: decision.action === 'restore-wait' },
      } as never, { workspaceId: ctx.workspaceId, harnessSlug: ctx.installSlug, isSuperuser: true,
        uiClientId: `system:session-interruption:${ctx.routineId ?? 'default'}` } as never) as {
          data?: { launch?: { resumeVerified?: boolean | null } }; isError?: boolean };
      return { verified: response.data?.launch?.resumeVerified === true && !response.isError,
        reason: response.data?.launch?.resumeVerified === true ? 'exact-native-host-verified' : 'resume-unconfirmed' };
    },
    finish: async (candidate, key, result) => {
      const s = candidate.interruption!;
      const marker = { ...s, key, leaseKey: null, state: result.verified ? 'restored' : s.attempts >= 3 ? 'blocked' : 'pending',
        nextAttemptAt: Date.now() + Math.max(1, s.attempts) * SESSION_RECOVERY_LEASE_MS, reason: result.reason };
      await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state,
        '{lifecycle,interruption}', ${JSON.stringify(marker)}::jsonb)
        WHERE owner_id = ${candidate.ownerId} AND workspace_id = ${ctx.workspaceId}
          AND control_state #>> '{lifecycle,interruption,leaseKey}' = ${key}
          AND control_state #>> '{lifecycle,interruption,state}' = 'recovering'`;
    },
  });
}
