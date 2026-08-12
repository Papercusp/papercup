/** release:trace — one exact-SHA projection over the existing release authorities. */
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { gitPipelineSnapshot } from '../../git-pipeline-stats';
import { computeDeployStatus } from '../../release-deploy-launch';
import { buildReleaseTrace, type ReleaseTraceAwait, type ReleaseTraceWake } from '../../release-trace';
import { buildKey } from '../../events/await/catalog';
import { inspectEventKey } from '../../events/await/store';
import { withBoundedTimeout, type BoundedTimeoutResult } from '../../bounded-timeout';
import { resolveAgentIdentity } from '../coordination/identity';

/**
 * Keep the composite diagnostic below the MCP transport deadline even when one
 * of its independent release/PG reads is queued behind a saturated pool.
 * The three budgets are sequential in the handler, so their sum remains below
 * the ~55s client deadline in the worst case.
 */
export const RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS = 20_000;
export const RELEASE_TRACE_POSITION_TIMEOUT_MS = 15_000;
export const RELEASE_TRACE_AWAIT_TIMEOUT_MS = 10_000;

type TraceTimeoutStage = 'pipeline_snapshot' | 'pipeline_position' | 'await_history';

function throwReadError(read: BoundedTimeoutResult<unknown>, label: string): never {
  if (read.error instanceof Error) throw read.error;
  throw new Error(read.errorMessage ?? `${label} failed`);
}

function traceTimeoutResponse(
  args: { path?: string; sha?: string },
  stage: TraceTimeoutStage,
  timeoutMs: number,
  read: BoundedTimeoutResult<unknown>,
  event?: string,
) {
  return {
    data: {
      ok: false,
      target: { path: args.path ?? null, sha: args.sha ?? null },
      trace: { status: 'unknown', complete: false },
      nextVerb: null,
      error: {
        code: 'trace_timeout',
        stage,
        retryable: true,
        timeoutMs,
        elapsedMs: read.elapsedMs,
        ...(event ? { event } : {}),
        message: `release:trace ${stage} did not complete within ${timeoutMs}ms; release truth is unknown — retry the read`,
      },
    },
  };
}

function payloadSha(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ['sha', 'commitSha', 'commit_sha', 'deployedSha', 'deployed_sha', 'testedSha', 'tested_sha']) {
    if (typeof row[key] === 'string') return row[key].toLowerCase();
  }
  return null;
}

function pipelineName(root: string): string {
  return (path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

const tracePath = z
  .string()
  .min(1)
  .max(400)
  .describe('Repo-relative path whose release position should be traced; required unless sha is supplied.');
const traceSha = z
  .string()
  .min(4)
  .max(64)
  .describe('Commit SHA whose release lineage should be traced; required unless path is supplied.');
const traceContext = {
  work_item: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Optional work item to make the terminal nextVerb a ready work_items:set_live_verified call; it does not replace the required path or sha.',
    ),
  after_generation: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('generatedAtMs from the caller’s cached trace; any different generation requires full replacement.'),
};

export default defineTool({
  name: 'release:trace',
  profile: 'engineer',
  description:
    'One read-only, SHA-centric release truth: commit presence, exact gate + authoritative failing tests, green pin, deployed SHA, registered awaits, stale-wake lineage, tested/deployed parity, applicable safety constraints, and at most one safe nextVerb. Composes dev:pipeline_position, release:deploy status, and events:status authorities instead of creating another release state machine.',
  capability: 'intel:read',
  requirePrincipal: false,
  // EI-20246294559310854: this diagnostic composes several independent admin-pool,
  // git, and await-history reads and never consumes ctx.tx. Do not retain the
  // dispatcher's ambient org-app transaction while red-verdict reconciliation runs;
  // under pool pressure that held slot made release:trace itself hit
  // withWorkspace:acquire(app) before the read could finish.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  guidance: {
    when: 'After a release/gate/deploy wake, or whenever one commit’s truth is scattered across pipeline, gate, deploy, and await reads. Pass path when runtime ownership matters; pass sha for an exact lineage audit.',
    notWhen:
      'To mutate the release pipeline. Follow the returned nextVerb; release:trace itself never commits, runs a gate, or deploys.',
    chaining:
      'release:trace { path | sha, work_item? } → follow the single non-null nextVerb → after a wake, call release:trace again with after_generation from the prior response.',
    returns:
      '{ generatedAtMs, target, gate, greenPin, deploy, testedDeployedParity, awaits, staleWake, constraints, nextVerb, resync, summary }',
    seeAlso: ['dev:pipeline_position', 'release:deploy', 'events:status', 'deploy:await', 'checkpoint:await'],
  },
  // Use a representable union rather than a refinement: the same schema is published to
  // callers as JSON Schema, where a custom refinement would disappear and advertise the
  // rejected work_item-only shape (EI-20232784385629302).
  args: z.union([
    z.object({ path: tracePath, sha: traceSha.optional(), ...traceContext }),
    z.object({ path: tracePath.optional(), sha: traceSha, ...traceContext }),
  ]),
  async handler(args, ctx) {
    if (!args.path && !args.sha) return { data: { ok: false, error: 'Provide path or sha.' } };
    const identity = resolveAgentIdentity(ctx);
    // A diagnostic read must stay fork/sidecar-free. The default enables the
    // dev-deploy spawner sidecar, which can block this read while composing
    // release truth (EI-20264406467393669).
    const snapshotRead = await withBoundedTimeout(() => gitPipelineSnapshot(undefined, { useSpawnerSidecar: false }), {
      fallback: null,
      timeoutMs: RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
      label: 'release:trace:pipeline-snapshot',
    });
    if (snapshotRead.degraded) {
      if (snapshotRead.reason === 'error') throwReadError(snapshotRead, 'release:trace:pipeline-snapshot');
      return traceTimeoutResponse(args, 'pipeline_snapshot', RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS, snapshotRead);
    }
    const snapshot = snapshotRead.value;
    if (!snapshot) throw new Error('release:trace:pipeline-snapshot returned no snapshot');

    const positionRead = await withBoundedTimeout(
      () =>
        gitPipelinePosition(
          { path: args.path, sha: args.sha },
          {
            loadSnapshot: () => Promise.resolve(snapshot),
            loadDeploy: () => Promise.resolve(snapshot.deploy),
          },
        ),
      {
        fallback: null,
        timeoutMs: RELEASE_TRACE_POSITION_TIMEOUT_MS,
        label: 'release:trace:pipeline-position',
      },
    );
    if (positionRead.degraded) {
      if (positionRead.reason === 'error') throwReadError(positionRead, 'release:trace:pipeline-position');
      return traceTimeoutResponse(args, 'pipeline_position', RELEASE_TRACE_POSITION_TIMEOUT_MS, positionRead);
    }
    const position = positionRead.value;
    if (!position) throw new Error('release:trace:pipeline-position returned no position');
    const deploy = computeDeployStatus(snapshot);
    const pipeline = pipelineName(snapshot.deploy.integrationRoot);
    const keys = [
      buildKey('deploy', { sha: position.targetSha ?? args.sha }),
      buildKey('deploy-failed'),
      buildKey('checkpoint', { pipeline }),
      buildKey('checkpoint-red', { pipeline }),
    ];
    const historyReads = await Promise.all(
      keys.map(async (event) => {
        const read = await withBoundedTimeout(() => inspectEventKey(event), {
          fallback: null,
          timeoutMs: RELEASE_TRACE_AWAIT_TIMEOUT_MS,
          label: `release:trace:await-history:${event}`,
        });
        if (read.degraded && read.reason === 'error') throwReadError(read, `release:trace:await-history:${event}`);
        return { event, read };
      }),
    );
    const timedOutHistory = historyReads.find(({ read }) => read.degraded);
    if (timedOutHistory) {
      return traceTimeoutResponse(
        args,
        'await_history',
        RELEASE_TRACE_AWAIT_TIMEOUT_MS,
        timedOutHistory.read,
        timedOutHistory.event,
      );
    }
    const histories = historyReads.map(({ event, read }) => {
      if (!read.value) throw new Error(`release:trace:await-history:${event} returned no history`);
      return { event, history: read.value };
    });
    const awaits: ReleaseTraceAwait[] = histories.flatMap(({ event, history }) =>
      history.waiters.map((row) => ({
        event,
        awaitId: row.id,
        subscriberId: row.subscriberId,
        state: row.cancelledAt
          ? 'cancelled'
          : row.firedAt
            ? row.firedReason === 'expired'
              ? 'expired'
              : 'fired'
            : 'registered',
        registeredAt: row.createdAt,
        firedAt: row.firedAt,
        firedReason: row.firedReason,
        observedSha: payloadSha(row.firedPayload),
      })),
    );
    const wakes: ReleaseTraceWake[] = histories.flatMap(({ event, history }) =>
      history.deliveries.map((row) => ({
        event,
        deliveryId: row.id,
        subscriberId: row.subscriberId,
        status: row.status,
        channel: row.channel,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
        observedSha: payloadSha(row.payload),
      })),
    );

    return {
      data: buildReleaseTrace({
        position,
        deploy,
        pipeline,
        inspectedKeys: keys,
        awaits,
        wakes,
        snapshotGeneration: snapshot.generatedAtMs,
        consumerGeneration: args.after_generation,
        requesterId: identity.ownerId,
        workItem: args.work_item,
        gate: {
          state: deploy.state,
          authoritative: !snapshot.gate.verdictStale,
          consecutiveReds: snapshot.gate.consecutiveReds,
          failingTests: snapshot.gate.verdictStale ? [] : snapshot.gate.failingTests,
          fireStale: snapshot.gate.fireStale,
          fireStaleReason: snapshot.gate.fireStaleReason,
          verdictStale: snapshot.gate.verdictStale,
          verdictStaleReason: snapshot.gate.verdictStaleReason,
          // The checkpoint judges the local integration root. Preserve the exact
          // candidate so release:trace can distinguish gate eligibility from the
          // separate origin/GitHub publication leg.
          observedCandidate: snapshot.gate.observedCandidate,
          // EI-18672078222841101: who already owns this red. Unlike `failingTests` above
          // this is NOT blanked on a stale verdict — `describeGateRedOwnership` renders the
          // staleness itself ('verdict-stale'), which is exactly the case that misled a
          // reader of this tool into diagnosing an already-fixed leg.
          redOwner: snapshot.gate.redOwner,
        },
      }),
    };
  },
});
