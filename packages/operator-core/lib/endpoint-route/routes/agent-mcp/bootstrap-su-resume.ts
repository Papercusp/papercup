/** Existing managed resume routes, independent of launch/persona assembly. */
import { isAbsolute } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { bindLiveAgentSessionTasksToNativeSession } from '../../../task-manager/store';
import { defineTool } from '@papercusp/agent-mcp';
import { requirePrincipal } from '../../../auth/require-principal';
import {
  NATIVE_SESSION_ID_RE,
  reanchorAdvSessionNativeId,
  reanchorAdvSessionNativeIdByOwner,
  acquireAdvSessionResume,
  claimAdvSessionResume,
  finalizeAdvSessionResume,
  getAdvSession,
  isAdvSessionLocalLivenessEvidence,
  releaseAdvSessionResume,
} from '../../../adv-sessions';
import { CORS_HEADERS, gatePrincipal, jsonRes } from './bootstrap-su-shared';

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-resumed
 *   { advSessionId, resumeClaimKey? }
 *
 * The psu launcher's atomic RESUME acquisition. A keyed caller receives an
 * explicit short-lived reservation; acquisition preserves terminal evidence and
 * therefore does not assert that a child exists. The caller must finalize that
 * reservation from concrete spawn evidence, or release it on setup failure.
 * Legacy no-key callers retain the historical one-step claim during rollout.
 *
 * The keyed response is typed (`acquired` + `status` and lease metadata) and also
 * keeps the historical `reactivated` field for compatibility. In either shape,
 * false means "the right to resume was not acquired — do not spawn".
 */
const sessionResumed = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume admission reaches notification wrappers whose mandatory consequences must survive the request ending.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let resumeClaimKey: string | null = null;
    let localLivenessEvidence: unknown = undefined;
    let allowRetired = false;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        resumeClaimKey?: unknown;
        localLivenessEvidence?: unknown;
        allowRetired?: unknown;
        assumeHost?: { request?: unknown; afterExit?: unknown; action?: unknown; startup?: unknown };
      };
      if (body.assumeHost !== undefined) {
        // Extend the existing managed resume control plane; never let a normal
        // authenticated app principal inspect administrative custody receipts.
        // notify-classification: {"classification":"durable","reason":"Administrative custody admission must retain any notification consequences reached through its principal wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
        const principal = await requirePrincipal(req.headers, { kind: ['system'], trust: ['trusted'] });
        if (principal.slug !== 'system:superuser' || principal.authMethod !== 'bearer-token' ||
            typeof body.assumeHost?.afterExit !== 'boolean') return jsonRes({ ok: false }, 403);
        if (body.assumeHost.action !== undefined && (typeof body.assumeHost.action !== 'string' ||
            !['freeze', 'queue', 'thaw', 'observe', 'complete-return', 'begin-startup', 'startup-started'].includes(body.assumeHost.action))) return jsonRes({ ok: false }, 400);
        try {
          const { inspectManagedAssumeRequest } = await import('../../../session-assume-runtime');
          // notify-classification: {"classification":"durable","reason":"Managed assume transitions restore caller responsibilities and their mandatory audit consequences across request loss.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
          return jsonRes(await inspectManagedAssumeRequest(body.assumeHost.request, body.assumeHost.afterExit,
            body.assumeHost.action as string | undefined, body.assumeHost.startup));
        } catch { return jsonRes({ ok: false, reason: 'assume-custody-unverified' }, 409); }
      }
      if (body.allowRetired !== undefined && typeof body.allowRetired !== 'boolean') {
        return jsonRes({ error: 'allowRetired must be boolean' }, 400);
      }
      allowRetired = body.allowRetired === true;
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (body.resumeClaimKey != null) {
        if (typeof body.resumeClaimKey !== 'string') {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
        resumeClaimKey = body.resumeClaimKey.trim();
        if (!resumeClaimKey || resumeClaimKey.length > 200) {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'localLivenessEvidence')) {
        if (!isAdvSessionLocalLivenessEvidence(body.localLivenessEvidence)) {
          return jsonRes({
            error:
              "localLivenessEvidence must be { version: 1, kind: 'no-live-codex-writer' | 'no-live-claude-process' | 'no-live-omp-process' }",
          }, 400);
        }
        localLivenessEvidence = body.localLivenessEvidence;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    try {
      if (resumeClaimKey) {
        const reservation = localLivenessEvidence === undefined && !allowRetired
          ? await acquireAdvSessionResume(advSessionId, resumeClaimKey)
          : await acquireAdvSessionResume(
            advSessionId,
            resumeClaimKey,
            undefined,
            undefined,
            localLivenessEvidence,
            allowRetired,
          );
        return jsonRes({ ok: true, ...reservation, reactivated: reservation.acquired });
      }
      const claimed = await claimAdvSessionResume(advSessionId, null);
      return jsonRes({ ok: true, reactivated: claimed === true,
        ...(claimed === 'retired' ? { status: 'retired' } : {}) });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

async function parseResumeTransitionBody(
  req: Request,
): Promise<{ advSessionId: number; resumeClaimKey: string; launchArgv?: string[]; allowRetired?: boolean } | Response> {
  let advSessionId: number | null = null;
  let resumeClaimKey: string | null = null;
  let launchArgv: string[] | undefined;
  let allowRetired: boolean | undefined;
  try {
    const body = (await req.json()) as {
      advSessionId?: unknown;
      resumeClaimKey?: unknown;
      launchArgv?: unknown;
      allowRetired?: unknown;
    };
    if (body.allowRetired !== undefined && typeof body.allowRetired !== 'boolean') {
      return jsonRes({ error: 'allowRetired must be boolean' }, 400);
    }
    if (body.allowRetired === true) allowRetired = true;
    if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
      advSessionId = body.advSessionId;
    }
    if (typeof body.resumeClaimKey === 'string') {
      const candidate = body.resumeClaimKey.trim();
      if (candidate && candidate.length <= 200) resumeClaimKey = candidate;
    }
    if (body.launchArgv !== undefined) {
      if (
        !Array.isArray(body.launchArgv) ||
        body.launchArgv.length === 0 ||
        body.launchArgv.length > 256 ||
        !body.launchArgv.every(
          (arg): arg is string =>
            typeof arg === 'string' && arg.length > 0 && arg.length <= 4096,
        )
      ) {
        return jsonRes(
          {
            error:
              'launchArgv must be a non-empty array of strings (at most 256 entries, each at most 4096 characters)',
          },
          400,
        );
      }
      launchArgv = body.launchArgv;
    }
  } catch {
    /* return the shared validation response below */
  }
  if (advSessionId == null || advSessionId <= 0) {
    return jsonRes({ error: 'advSessionId required' }, 400);
  }
  if (!resumeClaimKey) {
    return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
  }
  return { advSessionId, resumeClaimKey, ...(launchArgv ? { launchArgv } : {}),
    ...(allowRetired ? { allowRetired } : {}) };
}

/** Finalize a keyed resume reservation from concrete child/host spawn evidence. */
const sessionResumeFinalized = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume finalization admission must retain mandatory notification consequences reached through its gate wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const finalized = await finalizeAdvSessionResume(
        parsed.advSessionId,
        parsed.resumeClaimKey,
        parsed.launchArgv,
        parsed.allowRetired,
      );
      if (finalized) {
        try {
          const session = await getAdvSession(parsed.advSessionId);
          if (session?.coordOwnerId) {
            const { armInboxWake } = await import('../../../events/await/inbox-wake-arm');
            await armInboxWake({ ownerId: session.coordOwnerId });
          } else {
            process.stderr.write(
              `[bootstrap-su] resumed inbox-wake arm skipped: no coord owner for adv session ${parsed.advSessionId}\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[bootstrap-su] resumed inbox-wake arm failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return jsonRes({ ok: true, finalized, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeFinalized = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/** Release a keyed reservation after setup/pre-spawn failure without asserting liveness. */
const sessionResumeReleased = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'loopback',
  async handler(req) {
    // notify-classification: {"classification":"durable","reason":"Resume release admission must retain mandatory notification consequences reached through its gate wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const released = await releaseAdvSessionResume(parsed.advSessionId, parsed.resumeClaimKey);
      return jsonRes({ ok: true, released, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeReleased = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForSessionResumed = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * Join a pre-fork headless task row to the native session identity bootstrap
 * learned inside the child. This is intentionally best-effort: task-manager
 * attribution/reaping must heal when it can, but a ledger outage must never
 * turn an otherwise valid agent launch or carry-respawn into a boot failure.
 */
export async function bindKnownAgentSessionTasks(input: {
  workspaceId: string;
  coordOwnerId: string;
  sessionId: string | null;
  initialTaskId?: string;
  source: 'bootstrap' | 'session-port' | 'respawn';
}): Promise<string[]> {
  if (!input.sessionId) return [];
  const bound = new Set<string>();
  const base = {
    workspaceId: input.workspaceId,
    coordOwnerId: input.coordOwnerId,
    sessionId: input.sessionId,
  };
  const logFailure = (error: unknown): void => {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.warn(
      `[bootstrap-su] ${input.source} task/session bind failed for ${input.coordOwnerId.slice(0, 120)}: ${detail}`,
    );
  };
  if (input.initialTaskId) {
    try {
      for (const taskId of await bindLiveAgentSessionTasksToNativeSession({ ...base, initialTaskId: input.initialTaskId })) {
        bound.add(taskId);
      }
    } catch (error) {
      logFailure(error);
    }
  }
  try {
    for (const taskId of await bindLiveAgentSessionTasksToNativeSession(base)) bound.add(taskId);
  } catch (error) {
    logFailure(error);
  }
  return [...bound];
}

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-respawned
 *   { advSessionId?, coordOwnerId?, sessionId }
 *
 * The psu launcher's RESPAWN report (WI-5075) — the managed pty host replaced the
 * agent child with a fresh successor under a NEW native `--session-id` (P-018
 * carry-respawn / cold-loop RECYCLE), keeping the same coord identity and adv
 * row. Re-anchors the row's `session_id` to the successor so every owner→native
 * consumer — above all the compaction watchdog's context estimate — tracks the
 * LIVE incarnation instead of the dead predecessor's transcript. Without this,
 * the estimate stays pinned over-limit and the watchdog re-kills each successor
 * at every retry-grace expiry (the 2026-07-15/16 kill loop).
 *
 * Keyed by `advSessionId` when the launch env carried one (the adv-spawned
 * cohort). Only reports with NO adv id use the legacy `coordOwnerId` fallback;
 * a supplied-but-missing id must never be redirected to a sibling row, because
 * the row id is also the Codex home key (WI-42507). At least one key is required.
 *
 * Best-effort + idempotent like its ended/resumed siblings: re-anchoring to the
 * already-recorded id is a no-op, and the launcher swallows any failure.
 */
const sessionRespawned = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-respawned',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let coordOwnerId: string | null = null;
    let sessionId: string | null = null;
    let turnProvenanceDir: string | undefined;
    let managedSuccession: { phase?: unknown; request?: unknown; permit?: unknown } | undefined;
    // WI-6554700010030031: present only on an in-place context-reset report — the
    // launch id of the SAME child, kept as an accepted alias of the rotated id.
    let childLaunchSessionId: string | null = null;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        coordOwnerId?: unknown;
        sessionId?: unknown;
        childLaunchSessionId?: unknown;
        turnProvenanceDir?: unknown;
        managedSuccession?: typeof managedSuccession;
      };
      managedSuccession = body.managedSuccession;
      if (body.turnProvenanceDir !== undefined) {
        if (typeof body.turnProvenanceDir !== 'string' || !isAbsolute(body.turnProvenanceDir) || body.turnProvenanceDir.includes('\0'))
          return jsonRes({ error: 'turnProvenanceDir must be an absolute runtime namespace' }, 400);
        turnProvenanceDir = body.turnProvenanceDir;
      }
      if (typeof body.childLaunchSessionId === 'string'
        && NATIVE_SESSION_ID_RE.test(body.childLaunchSessionId.trim())) {
        childLaunchSessionId = body.childLaunchSessionId.trim();
      }
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (typeof body.coordOwnerId === 'string' && body.coordOwnerId.trim().length > 0) {
        coordOwnerId = body.coordOwnerId.trim().slice(0, 200);
      }
      if (typeof body.sessionId === 'string' && NATIVE_SESSION_ID_RE.test(body.sessionId.trim())) {
        sessionId = body.sessionId.trim();
      }
    } catch {
      /* fall through to the 400 */
    }
    if ((advSessionId == null || advSessionId <= 0) && !coordOwnerId) {
      return jsonRes({ error: 'advSessionId or coordOwnerId required' }, 400);
    }
    if (!sessionId) {
      return jsonRes({ error: 'sessionId (native session UUID) required' }, 400);
    }
    try {
      if (managedSuccession !== undefined) {
        const principal = await requirePrincipal(req.headers, { kind: ['system'], trust: ['trusted'] });
        if (principal.slug !== 'system:superuser' || principal.authMethod !== 'bearer-token')
          return jsonRes({ ok: false }, 403);
        if (!advSessionId || !coordOwnerId || !managedSuccession ||
            !['reserve', 'settle'].includes(String(managedSuccession.phase)))
          return jsonRes({ ok: false, error: 'invalid managed succession' }, 400);
        if (managedSuccession.phase === 'reserve') {
          const request = managedSuccession.request as { ownerId?: unknown; advSessionId?: unknown;
            sourceNativeSessionId?: unknown } | undefined;
          if (request?.ownerId !== coordOwnerId || request?.advSessionId !== advSessionId ||
              request?.sourceNativeSessionId !== sessionId) return jsonRes({ ok: false }, 400);
          const { reserveBlindReviewManagedSuccession } = await import('../../../blind-review-continuation-custody');
          const permit = await reserveBlindReviewManagedSuccession(activeWorkspaceId(), request);
          return jsonRes({ ok: true, managedSuccessionPermit: permit });
        }
      }
      let reanchored = false;
      let owner: string | null = null;
      if (advSessionId != null && advSessionId > 0) {
        ({ reanchored, owner } = await reanchorAdvSessionNativeId(advSessionId, sessionId, {
          childLaunchSessionId, ...(turnProvenanceDir ? { turnProvenanceDir } : {}),
          ...(managedSuccession ? { managedSuccessionPermit: managedSuccession.permit as
            import('../../../blind-review-continuation-custody').BlindReviewManagedSuccessionPermit } : {}),
        }));
      }
      // Owner-keyed fallback is reserved for legacy reports that genuinely carry
      // no adv id. A supplied id that touches no row is NOT permission to choose
      // a different row by owner; that is the numeric-home identity split this
      // route is responsible for preventing.
      if (advSessionId == null && coordOwnerId) {
        const fallback = turnProvenanceDir
          ? await reanchorAdvSessionNativeIdByOwner(coordOwnerId, sessionId, { turnProvenanceDir })
          : await reanchorAdvSessionNativeIdByOwner(coordOwnerId, sessionId);
        reanchored = fallback.reanchored;
        owner = fallback.owner ?? owner;
      }
      // The launcher treats HTTP success as authoritative confirmation before
      // writing successor input. A 2xx with no resolved owner would acknowledge
      // an unbound native id, leaving the old owner→native mapping in force.
      // Fail closed and let the durable reporter retry if the row is not ready.
      if (!owner) {
        return jsonRes({ ok: false, reanchored, error: 'native session binding is not established' }, 503);
      }
      // The host confirms the native binding before sending a fresh Codex
      // kickoff. An accepted worker also needs its launch-proven identity and
      // model evidence sink ready at that boundary, before any provider call.
      // Use the existing activation writer; a lifecycle receipt never widens
      // grants or acknowledges delivery of a control update.
      if (owner) {
        const { readSuLaunchSpecByOwner } = await import('../../../adv-sessions');
        const launch = await readSuLaunchSpecByOwner(owner) as {
          acceptedOperation?: { kind?: string; modelPolicy?: unknown };
        } | null;
        if (launch?.acceptedOperation?.kind === 'blueprint-operation-worker') {
          const workspaceId = activeWorkspaceId();
          const {
            preparePendingControlTransition, applyRelaunchedActivation,
          } = await import('../../../agent-tools/coordination/control-anchor');
          const pending = await preparePendingControlTransition(owner, workspaceId);
          if (pending?.state.activation?.desired) {
            await applyRelaunchedActivation(
              owner, workspaceId, pending.generation, pending.state.activation.desired,
            );
          }
          const { readActiveOperationWorkerClaimBinding, readActiveOperationModelPolicy } =
            await import('../../../blueprint/operation-worker-binding');
          const binding = await readActiveOperationWorkerClaimBinding(workspaceId, owner);
          if (binding.status !== 'bound') {
            return jsonRes({ ok: false, reanchored, error: 'accepted operation identity is not ready' }, 503);
          }
          if (launch.acceptedOperation.modelPolicy != null) {
            const [native] = await getOrgPg().sql<Array<{ agent: string }>>`
              SELECT agent FROM harness_shared.adv_sessions
               WHERE id = ${binding.receipt.sessionId} AND workspace_id = ${workspaceId}
                 AND coord_owner_id = ${owner} AND session_id = ${sessionId}
                 AND ended_at IS NULL AND ended_by IS NULL
            `;
            if (native?.agent !== 'claude' && native?.agent !== 'codex') {
              return jsonRes({ ok: false, reanchored, error: 'accepted operation native session is not ready' }, 503);
            }
            const policy = await readActiveOperationModelPolicy(workspaceId, owner, native.agent);
            if (policy.status !== 'bound' || policy.attestation?.nativeSessionId !== sessionId) {
              return jsonRes({ ok: false, reanchored, error: 'accepted operation attestation is not ready' }, 503);
            }
          }
        }
      }
      if (owner) {
        await bindKnownAgentSessionTasks({
          workspaceId: activeWorkspaceId(),
          coordOwnerId: owner,
          sessionId,
          source: 'respawn',
        });
      }
      // Frozen-gauge fix: the successor keeps the coord ownerId, so the
      // in-process context-usage cache still holds the DEAD predecessor's
      // near-limit estimate — a fresh successor rendering "89%" gets nudged
      // into an immediate pointless re-cut. Clear it; the next watchdog pass
      // measures the real successor transcript. Best-effort like the reanchor.
      // WI-41555: gauge hygiene follows the EVENT (a respawn happened, and here
      // is the owner it happened to), NEVER "did a DB row change". `owner` used
      // to come back null on every no-op re-anchor, which is the ORDINARY case
      // for the cold-loop recycle cohort — the spawn path stamps the new native
      // id onto the row before this report lands, so both UPDATEs match zero
      // rows. That silently skipped the two clears below and left the anchored
      // gauge serving the DEAD predecessor's token count indefinitely: a fresh
      // successor renders ~81%, obeys its own compaction discipline, re-cuts at
      // once, and ITS successor inherits the same frozen number — an unbounded
      // reset loop in which no session ever does any work. The re-anchors now
      // report the row's owner regardless; this falls back to the owner the
      // REPORT names so a missing or racing adv row cannot resurrect the bug.
      // Clearing is idempotent and self-healing (the next read reseeds from the
      // successor's real transcript), so an extra clear costs nothing.
      const gaugeOwner = owner ?? coordOwnerId;
      if (gaugeOwner) {
        // EI-21567375926533125: scheduler:get_next reads the PG-canonical
        // coord_presence estimate, not either in-process render cache below.
        // A carry-respawn can preserve pid=NULL, so the store's pid-transition
        // invalidation never fires; clear the predecessor estimate at this
        // confirmed native-session replacement boundary. The detached
        // session-compacted bridge may race this route, but it now writes only
        // after proving it resolved this exact successor native id.
        try {
          const { clearContextEstimate } = await import('../../../agent-tools/coordination/presence');
          await clearContextEstimate(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
        try {
          const { clearContextUsage } = await import('../../../system-health/context-usage-cache');
          clearContextUsage(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
        // EI-12966: the watchdog-mirror cache above is only a fallback/limit
        // source now — the LIVE render paths (P-013 result annotator, P-015
        // PostToolUse hook fold) read the WI-4154 anchored incremental cache
        // in compaction-usage.ts instead, which has its OWN per-owner cache
        // keyed on the dead predecessor's transcript path. That anchor's fast
        // path never re-resolves the session ref, so left uncleared it keeps
        // serving the byte-identical PRE-respawn reading indefinitely (the
        // "stale CRITICAL gauge on the first post-compaction tool call" bug —
        // not just for up to one watchdog pass, but forever until this clears
        // it). Clear it too so the very next read reseeds from the successor's
        // real transcript.
        try {
          const { clearContextAnchor } = await import('../../../compaction-usage');
          clearContextAnchor(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
      }
      return jsonRes({ ok: true, reanchored });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionRespawned = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-respawned',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});


export default [
  sessionRespawned,
  optionsForSessionRespawned,
  sessionResumed,
  optionsForSessionResumed,
  sessionResumeFinalized,
  optionsForSessionResumeFinalized,
  sessionResumeReleased,
  optionsForSessionResumeReleased,
];
