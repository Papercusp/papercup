/**
 * Per-leg routing of a frozen repair queue (green-main-cycle-time-2026-10-08 P-013,
 * D-028 as amended by D-029) — the effectful half.
 *
 * The gate's terminal handler calls {@link routeFrozenRepairLegs} once per tick with the
 * queue the tick ended holding. It reads which leg items are already open (the condition
 * fold), plans the delta with the pure `planFrozenRepairLegRouting`, opens the new legs as
 * one-shot conditions and resolves the departed ones in ONE message. The condition bridge
 * then mints / settles the claimable work-items exactly as it does for every other
 * actionable condition; nothing here touches work_items directly.
 *
 * Every dependency is injectable so the whole flow is unit-testable without a database.
 * Best-effort by contract: callers swallow, because routing must never fail a gate tick.
 */

import { createHash } from 'node:crypto';
import {
  MAX_ROUTED_LEGS,
  type FrozenRepairFailure,
  type FrozenRepairRoutingQueue,
  frozenRepairLegKeyPrefix,
  planFrozenRepairLegRouting,
  type FrozenRepairLegRoutingPlan,
} from './frozen-repair-agent-routing';

export interface FrozenRepairLegRoutingDeps {
  /** Keys currently OPEN in the condition fold that start with `prefix`. */
  readOpenConditionKeys(prefix: string): Promise<string[]>;
  /** Latest recorded failure output per entry on either sha; best-effort, may be empty. */
  readFailureTails(input: {
    candidate: string;
    repairHead: string;
    entries: readonly string[];
  }): Promise<Map<string, string>>;
  /**
   * Entries whose LATEST clean CI row at `repairHead` is a pass: the fix landed and only
   * awaits re-verify, so no owner item may be minted for them (EI-27221104393614066).
   * Optional + best-effort: absent or throwing = no evidence, route as before.
   */
  readPassedAtRepairHead?(input: { repairHead: string; entries: readonly string[] }): Promise<Set<string>>;
  /** Persist an item through the native bridge, without a per-item audience message. */
  broadcastOpen(ev: { conditionKey: string; summary: string; body: string; failure: FrozenRepairFailure }): Promise<boolean>;
  readPendingSummaryKeys?(pipeline: string): Promise<string[]>;
  acknowledgeSummary?(pipeline: string, keys: readonly string[]): Promise<void>;
  broadcastSummary?(input: { pipeline: string; queue: FrozenRepairRoutingQueue | null; opened: number; resolved: number; failed: number; pendingKeys: readonly string[] }): Promise<boolean>;
  broadcastResolved(res: { conditionKeys: string[]; summary: string; body?: string }): Promise<boolean>;
}

export interface FrozenRepairLegRoutingRequest {
  pipeline: string;
  /** See FrozenRepairLegRoutingInput.queue: null resolves every open leg of the pipeline. */
  queue: FrozenRepairRoutingQueue | null;
  /**
   * WI-6554700010018714: failure output the CALLER already holds, keyed by failing entry —
   * the non-test legs (`lint:condition-rail`, …) the gate measured at repairHead this tick.
   * test_runs is structurally test-file-only, so without this a lint leg's item said "none
   * recorded for this leg" while the gate's own verdict line carried its tail, and the fixer
   * reproduced it outside the gate's env, where it passed. An entry supplied here is not
   * looked up in the ledger; every other new entry still is.
   */
  failureTails?: ReadonlyMap<string, string>;
}

export interface FrozenRepairLegRoutingOutcome {
  plan: FrozenRepairLegRoutingPlan;
  opened: string[];
  resolved: string[];
  /** Misses stay in the complete queue; the next pass retries their exact identities. */
  failed: { conditionKey: string; error: string }[];
  summaryPublished?: boolean;
}

export async function routeFrozenRepairLegs(
  req: FrozenRepairLegRoutingRequest,
  deps: FrozenRepairLegRoutingDeps = productionFrozenRepairLegRoutingDeps(),
): Promise<FrozenRepairLegRoutingOutcome> {
  const openLegKeys = await deps.readOpenConditionKeys(frozenRepairLegKeyPrefix(req.pipeline));
  // Plan once without tails to learn which legs are NEW; read tails only for those, so a
  // steady-state tick (nothing changed) costs one fold read and no test_runs query.
  const firstPass = planFrozenRepairLegRouting({ pipeline: req.pipeline, queue: req.queue, openLegKeys });
  let plan = firstPass;
  if (req.queue && firstPass.open.length > 0) {
    const tails = new Map<string, string>();
    for (const o of firstPass.open) {
      const known = req.failureTails?.get(o.entry);
      if (typeof known === 'string') tails.set(o.entry, known);
    }
    const fromLedger = firstPass.open.map((o) => o.entry).filter((e) => !tails.get(e)?.trim());
    if (fromLedger.length > 0) {
      try {
        const read = await deps.readFailureTails({
          candidate: req.queue.candidate,
          repairHead: req.queue.repairHead,
          entries: fromLedger,
        });
        for (const [entry, tail] of read) if (!tails.get(entry)?.trim()) tails.set(entry, tail);
      } catch {
        // Best-effort: an item without its tail still names the leg and the admit call.
      }
    }
    let passedAtRepairHead: Set<string> | undefined;
    if (deps.readPassedAtRepairHead) {
      try {
        passedAtRepairHead = await deps.readPassedAtRepairHead({
          repairHead: req.queue.repairHead,
          entries: firstPass.open.map((o) => o.entry),
        });
      } catch {
        // Best-effort: without evidence, route as before.
      }
    }
    plan = planFrozenRepairLegRouting({
      pipeline: req.pipeline,
      queue: req.queue,
      openLegKeys,
      failureTails: tails,
      passedAtRepairHead,
    });
  }
  const opened: string[] = [];
  const failed: FrozenRepairLegRoutingOutcome['failed'] = [];
  // Drain every bounded batch. Durable keys let a restart skip completed batches;
  // one refused early item cannot starve a later check.
  for (let offset = 0; offset < plan.open.length; offset += MAX_ROUTED_LEGS) {
    const batch = plan.open.slice(offset, offset + MAX_ROUTED_LEGS);
    const results = await Promise.allSettled(batch.map((o) => deps.broadcastOpen(o)));
    for (const [i, result] of results.entries()) {
      const conditionKey = batch[i]!.conditionKey;
      if (result.status === 'fulfilled' && result.value) opened.push(conditionKey);
      else failed.push({ conditionKey, error: result.status === 'rejected' ? String(result.reason) : 'publication refused' });
    }
  }
  const resolved: string[] = [];
  if (plan.resolve.length > 0) {
    const ok = await deps.broadcastResolved({
      conditionKeys: plan.resolve,
      summary: req.queue
        ? `[${req.pipeline}] ${plan.resolve.length} frozen-repair leg(s) left the failing set — their items close.`
        : `[${req.pipeline}] the frozen repair queue cleared — ${plan.resolve.length} leg item(s) close.`,
      body: plan.resolve.map((k) => `  · ${k}`).join('\n'),
    });
    if (ok) resolved.push(...plan.resolve);
  }
  let summaryPublished: boolean | undefined;
  const pendingKeys = await deps.readPendingSummaryKeys?.(req.pipeline) ?? [];
  if (deps.broadcastSummary && (opened.length || resolved.length || failed.length || pendingKeys.length)) {
    summaryPublished = await deps.broadcastSummary({ pipeline: req.pipeline, queue: req.queue,
      opened: opened.length, resolved: resolved.length, failed: failed.length, pendingKeys });
    if (summaryPublished && pendingKeys.length) await deps.acknowledgeSummary?.(req.pipeline, pendingKeys);
  }
  return { plan, opened, resolved, failed, ...(summaryPublished === undefined ? {} : { summaryPublished }) };
}

/** Production wiring: the condition fold, the CI test ledger, and the severe-event rail. */
export function productionFrozenRepairLegRoutingDeps(): FrozenRepairLegRoutingDeps {
  return {
    async readOpenConditionKeys(prefix) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
      const { ANY_FAMILY_TERMINAL_STATES } = await import('../work-item-dispatch-states');
      const workspaceId = coordScopeWorkspace();
      if (!workspaceId) throw new Error('Frozen failure publication requires a workspace');
      const rows = await getOrgPg().sql<{ condition_key: string }[]>`
        SELECT condition_key FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND starts_with(condition_key, ${prefix})
           AND NOT (COALESCE(status, '') = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}))
         ORDER BY condition_key`;
      return rows.map((r) => r.condition_key);
    },
    async readFailureTails({ candidate, repairHead, entries }) {
      const out = new Map<string, string>();
      if (entries.length === 0) return out;
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      // The gate's own rows only (source='ci', clean checkout), on the two shas the queue
      // judges; newest first so a repairHead failure outranks the candidate's original one.
      const rows = await sql<{ file_path: string; output_tail: string | null }[]>`
        SELECT DISTINCT ON (file_path) file_path, output_tail
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND worktree_dirty = false
           AND commit_sha IN (${candidate}, ${repairHead})
           AND file_path = ANY(${[...entries]})
           AND status IN ('fail', 'error')
           AND output_tail IS NOT NULL
         ORDER BY file_path, finished_at DESC
      `;
      for (const r of rows) if (r.output_tail !== null) out.set(r.file_path, r.output_tail);
      return out;
    },
    async readPassedAtRepairHead({ repairHead, entries }) {
      const out = new Set<string>();
      if (entries.length === 0) return out;
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      // Latest clean gate row per file AT repairHead; only a pass there counts, so a later
      // fail on the same sha keeps the leg routed.
      const rows = await sql<{ file_path: string; status: string }[]>`
        SELECT DISTINCT ON (file_path) file_path, status
          FROM harness_shared.test_runs
         WHERE source = 'ci'
           AND worktree_dirty = false
           AND commit_sha = ${repairHead}
           AND file_path = ANY(${[...entries]})
           AND status IN ('pass', 'fail', 'error')
         ORDER BY file_path, finished_at DESC
      `;
      for (const r of rows) if (r.status === 'pass') out.add(r.file_path);
      return out;
    },
    async broadcastOpen(ev) {
      const { acquireConditionOwner } = await import('../coord/condition-bridge');
      const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
      const workspaceId = coordScopeWorkspace();
      if (!workspaceId) throw new Error('Frozen failure publication requires a workspace');
      const result = await acquireConditionOwner(ev.conditionKey, {
        title: ev.summary,
        summary: ev.body + '\n\nComplete recorded identity and output: work_items:get → payload.frozenRepairFailure.',
        harness: ev.failure.pipeline, workspaceId, severity: 'major',
        payload: { frozenRepairFailure: ev.failure, _frozenRepairAnnouncementPending: true },
      });
      return !!result.workItem && !result.skipped && !result.duplicateLeftOpen;
    },
    async broadcastResolved(res) {
      const { releaseConditionOwner } = await import('../coord/condition-bridge');
      const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
      const workspaceId = coordScopeWorkspace();
      if (!workspaceId) throw new Error('Frozen failure publication requires a workspace');
      const { getOrgPg } = await import('@papercusp/db-org');
      for (const conditionKey of res.conditionKeys) {
        // Persist notification intent before the lifecycle transition can clear its key.
        await getOrgPg().sql`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(payload, '{_frozenRepairAnnouncementPending}', 'true'::jsonb)
           WHERE workspace_id = ${workspaceId} AND condition_key = ${conditionKey}
             AND payload -> 'frozenRepairFailure' IS NOT NULL`;
        const result = await releaseConditionOwner(conditionKey, { workspaceId, settle: true, reason: res.summary });
        if (result.released && !result.settled) return false;
      }
      return true;
    },
    async readPendingSummaryKeys(pipeline) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
      const rows = await getOrgPg().sql<{ token: string }[]>`
        SELECT feature_id || ':' || CASE WHEN condition_key IS NULL THEN 'resolved' ELSE 'published' END AS token
          FROM harness_shared.work_items
         WHERE workspace_id = ${coordScopeWorkspace()}
           AND payload -> 'frozenRepairFailure' ->> 'pipeline' = ${pipeline}
           AND payload ->> '_frozenRepairAnnouncementPending' = 'true'
         ORDER BY feature_id`;
      return rows.map((r) => r.token);
    },
    async acknowledgeSummary(pipeline, keys) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
      // A concurrent resolve has a new phase token and must retain its own notification.
      await getOrgPg().sql`
        UPDATE harness_shared.work_items
           SET payload = payload - '_frozenRepairAnnouncementPending'
         WHERE workspace_id = ${coordScopeWorkspace()}
           AND payload -> 'frozenRepairFailure' ->> 'pipeline' = ${pipeline}
           AND (feature_id || ':' || CASE WHEN condition_key IS NULL THEN 'resolved' ELSE 'published' END) = ANY(${[...keys]})`;
    },
    async broadcastSummary(input) {
      const { broadcastSevereEvent } = await import('../severe-event-broadcast');
      const replayIdentity = input.pendingKeys.length ? [...input.pendingKeys].sort() :
        [input.opened, input.resolved, input.failed, input.queue?.failingTests];
      const msgId = 'frozen-repair-publication-' + createHash('sha256')
        .update(JSON.stringify([input.pipeline, input.queue?.candidate, input.queue?.repairHead, replayIdentity])).digest('hex');
      const published = input.pendingKeys.length ? input.pendingKeys.filter((k) => k.endsWith(':published')).length : input.opened;
      const resolved = input.pendingKeys.length ? input.pendingKeys.filter((k) => k.endsWith(':resolved')).length : input.resolved;
      return broadcastSevereEvent({
        msgId,
        summary: `[${input.pipeline}] frozen failures: ${published} publication notices, ${resolved} resolution notices, ${input.failed} awaiting publication.`,
        body: `Candidate: ${input.queue?.candidate ?? 'none'}\nRepair head: ${input.queue?.repairHead ?? 'none'}\n` +
          `${input.pendingKeys.length} retained publication/resolution notice(s) in this message. ` +
          'Read native item payload.frozenRepairFailure for complete recorded identity and evidence. ' +
          'Pending publications remain in the complete queue and are retried on the next routing pass.',
      });
    },
  };
}
