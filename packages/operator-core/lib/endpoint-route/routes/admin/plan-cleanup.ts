/**
 * POST /api/admin/plan-cleanup — owner-side run control for the Plans-pane
 * cleanup flow (cleanup-report-flows-2026-08-24 P-005).
 *
 * The client posts the exact visible plan slugs: membership is a click-time
 * snapshot, never a server-side filter re-derivation. Start/accept act and are
 * feature-gated; stop/dismiss remain reachable when the kill switch is off.
 */
import { randomUUID } from 'node:crypto';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { requireAllowedOriginOr403 } from '../../cors';
import { gateApiRoute } from '../../../require-flag';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import {
  BulkRunAlreadyActiveError,
  createRun,
  failRunIfExecuting,
  restartRun,
  setRunPhase,
  settleRunPhase,
} from '../../../attention/bulk-run-store';
import { notifyPlanCleanupRunChanged } from '../../../attention/bulk-run-sync';
import { markCleanupFindingAccepted } from '../../../plan-cleanup/run-store';
import { buildCleanupResolverBrief } from '../../../plan-cleanup/resolver-brief';
import {
  buildPlanCleanupSystemCall,
  runDeterministicPlanCleanup,
} from '../../../plan-cleanup/deterministic-runner';
import {
  buildResolverLaunchCommand,
  preflightResolverLaunch,
  resolvePersistedResolverLaunch,
  resolverSpawnOutcome,
} from './attention-bulk-resolve';
import type { EffectiveBulkResolverLaunch } from '../../../agent-config-constants';

export const MAX_RUN_PLANS = 200;

export function parsePlanSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const slug = typeof value === 'string' ? value.trim() : '';
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= MAX_RUN_PLANS) break;
  }
  return out;
}

async function invalidateCleanupRun(): Promise<void> {
  await notifyPlanCleanupRunChanged().catch(() => undefined);
}

async function launchCleanupResolver(
  runId: string,
  planSlugs: string[],
  harness: string,
  launch: EffectiveBulkResolverLaunch | null,
  resolverOwner: string,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const [{ buildConsoleEnvelope }, { spawnHeadless }, { activeWorkspaceId }, { resolveSpawnHostOperatorBaseUrl }] =
      await Promise.all([
        import('../../../console-launcher'),
        import('../../../console-spawn'),
        import('../../../workspace-registry'),
        import('../../../mcp-base-url'),
      ]);
    const workspaceId = activeWorkspaceId();
    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: harness,
      operatorBaseUrl: await resolveSpawnHostOperatorBaseUrl(),
      headless: true,
      role: 'su',
    } as Parameters<typeof buildConsoleEnvelope>[0]);
    const result = await spawnHeadless({
      envelope: {
        ...envelope,
        greetingCmd: buildResolverLaunchCommand({
          workspaceId,
          harness,
          ownerId: resolverOwner,
          launch,
        }),
        env: {
          ...envelope.env,
          PAPERCUSP_KICKOFF_PROMPT: buildCleanupResolverBrief(runId, planSlugs),
        },
      },
      label: `plan-cleanup-${runId.slice(0, 12)}`,
      coordOwnerId: resolverOwner,
      launchedBy: 'plan-cleanup',
    });
    const outcome = resolverSpawnOutcome(result, resolverOwner);
    if (!outcome.ok) return outcome;

    let exitHandled = false;
    const failForExit = (detail: string): void => {
      if (exitHandled) return;
      exitHandled = true;
      void failRunIfExecuting({
        runId,
        workspaceId,
        resolverOwner,
        error: `cleanup resolver process ended before settling the run: ${detail}`,
      })
        .then(async (failed) => {
          if (failed) await invalidateCleanupRun();
        })
        .catch(() => undefined);
    };
    outcome.child.once('error', (error) => failForExit(error.message));
    outcome.child.once('exit', (code, signal) =>
      failForExit(signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`),
    );
    return { ok: true, sessionId: outcome.sessionId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleOwnerOp(op: string, body: Record<string, unknown>): Promise<Response> {
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!runId) {
    return Response.json(
      { error: { code: 'missing_run_id', message: `op "${op}" requires runId` } },
      { status: 400 },
    );
  }

  try {
    if (op === 'stop') {
      const run = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, stopped: true });
    }
    if (op === 'dismiss') {
      const run = await setRunPhase({ runId, phase: 'complete' });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, phase: run?.phase ?? null, dismissed: true });
    }
    if (op === 'restart') {
      const resolverOwner = `su-${randomUUID()}`;
      const restarted = await restartRun({ runId, resolverOwner });
      if (!restarted.ok) {
        return Response.json(
          {
            error: {
              code: restarted.reason,
              message: restarted.reason === 'run_not_found'
                ? `plan clean-up run ${runId} was not found`
                : `plan clean-up run ${runId} is still healthy or no longer restartable`,
              runId,
              phase: restarted.phase,
            },
          },
          { status: restarted.reason === 'run_not_found' ? 404 : 409 },
        );
      }
      const launch = resolvePersistedResolverLaunch(restarted.run.launchSnapshot);
      if (!launch.ok || !launch.effective) {
        await setRunPhase({
          runId,
          phase: 'failed',
          error: launch.message ?? 'persisted launch settings are no longer valid',
        });
        await invalidateCleanupRun();
        return Response.json(
          {
            error: {
              code: 'invalid_persisted_launch_settings',
              message: launch.message ?? 'persisted launch settings are no longer valid',
              runId,
            },
          },
          { status: 409 },
        );
      }
      const harness = restarted.run.harnessSlug ?? operatorHomeHarnessSlug();
      const launched = await launchCleanupResolver(
        runId,
        restarted.run.seedRefs,
        harness,
        launch.effective,
        resolverOwner,
      );
      const phase = launched.ok ? 'running' : 'failed';
      await setRunPhase({
        runId,
        phase,
        resolverOwner,
        ...(launched.ok ? {} : { error: launched.error ?? 'restart launch failed' }),
      });
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId,
        phase,
        restarted: true,
        launched: launched.ok,
        preservedOutcomes: restarted.preservedOutcomes,
        ...(launched.ok ? {} : { launchError: launched.error }),
      });
    }
    if (op === 'accept') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      if (!findingId) {
        return Response.json(
          { error: { code: 'missing_finding_id', message: 'op "accept" requires findingId' } },
          { status: 400 },
        );
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
      const accepted = await markCleanupFindingAccepted({ runId, findingId, note });
      if (!accepted.finding) {
        return Response.json(
          {
            error: {
              code: 'finding_not_reviewable',
              message: `${findingId} is not a recommended finding in review for run ${runId}`,
            },
          },
          { status: 404 },
        );
      }
      const run = await settleRunPhase({ runId });
      await invalidateCleanupRun();
      return Response.json({ ok: true, runId, findingId, phase: run?.phase ?? null, accepted: true });
    }
    return Response.json(
      { error: { code: 'unknown_op', message: `op must be start | stop | restart | accept | dismiss (got "${op}")` } },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      { error: { code: 'plan_cleanup_op_failed', message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    );
  }
}

export async function planCleanupHandler(req: Request, ctx: RouteContext): Promise<Response> {
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }
  const op = typeof body.op === 'string' ? body.op : 'start';
  const STOP_OPS = new Set(['stop', 'dismiss']);
  if (!STOP_OPS.has(op)) {
    const gated = await gateApiRoute(req, FLAGS.PLAN_CLEANUP);
    if (gated) return gated;
  }
  if (op !== 'start') return handleOwnerOp(op, body);

  const planSlugs = parsePlanSlugs(body.planSlugs);
  if (planSlugs.length === 0) {
    return Response.json(
      {
        error: {
          code: 'no_plans',
          message: 'planSlugs[] must contain the exact plans currently shown in the pane',
        },
      },
      { status: 400 },
    );
  }
  const harness =
    typeof body.harness === 'string' && body.harness.trim()
      ? body.harness.trim()
      : operatorHomeHarnessSlug();
  const filter = body.filter && typeof body.filter === 'object'
    ? (body.filter as Record<string, unknown>)
    : {};

  // P-004 — PREFLIGHT BEFORE createRun, via the SAME validator the Inbox route
  // uses, so the two panes cannot drift into judging one profile differently.
  const preflight = preflightResolverLaunch(body.launch);
  if (!preflight.ok) return preflight.response;

  try {
    const run = await createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: planSlugs,
      filterSnapshot: filter,
      launchSnapshot: preflight.launch,
      requestedBy: 'owner',
      harnessSlug: harness,
    });
    // P-008 — deterministic first. Scanner-authorized findings run through the
    // SAME run-row authority + canonical plan/claim dispatcher as
    // plans:cleanup-act. Re-scan to a fixed point before deciding whether any
    // judgment work remains; only that residue earns an LLM process.
    const deterministic = await runDeterministicPlanCleanup({
      run,
      call: buildPlanCleanupSystemCall({
        workspaceId: run.workspaceId,
        harnessSlug: harness,
        runId: run.runId,
        signal: ctx.signal,
      }),
    });
    if (deterministic.fatalError) {
      const failed = await setRunPhase({
        runId: run.runId,
        phase: 'failed',
        error: deterministic.fatalError,
      });
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId: run.runId,
        phase: failed?.phase ?? 'failed',
        totalPlans: run.totalItems,
        launched: false,
        resolverNeeded: false,
        deterministic,
        launchError: deterministic.fatalError,
      });
    }
    if (deterministic.authorityRevoked) {
      await invalidateCleanupRun();
      return Response.json(
        {
          error: {
            code: 'plan_cleanup_authority_revoked',
            message: `plan clean-up run ${run.runId} stopped accepting deterministic writes (${deterministic.phase})`,
            runId: run.runId,
            phase: deterministic.phase,
            refusal: deterministic.authorityRefusal?.reason ?? 'run_authority_revoked',
          },
          deterministic,
          launched: false,
          resolverNeeded: false,
        },
        { status: 409 },
      );
    }
    if (!deterministic.needsResolver) {
      await invalidateCleanupRun();
      return Response.json({
        ok: true,
        runId: run.runId,
        phase: deterministic.phase,
        totalPlans: run.totalItems,
        launched: false,
        resolverNeeded: false,
        deterministic,
      });
    }

    const resolverOwner = `su-${randomUUID()}`;
    await setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner });
    const launched = await launchCleanupResolver(
      run.runId,
      planSlugs,
      harness,
      preflight.launch,
      resolverOwner,
    );
    if (launched.ok) {
      await setRunPhase({
        runId: run.runId,
        phase: 'running',
        resolverOwner,
      });
    } else {
      await setRunPhase({
        runId: run.runId,
        phase: 'failed',
        error: launched.error ?? 'launch failed',
      });
    }
    await invalidateCleanupRun();
    return Response.json({
      ok: true,
      runId: run.runId,
      phase: launched.ok ? 'running' : 'failed',
      totalPlans: run.totalItems,
      launched: launched.ok,
      resolverNeeded: true,
      deterministic,
      ...(launched.ok ? {} : { launchError: launched.error }),
    });
  } catch (error) {
    if (error instanceof BulkRunAlreadyActiveError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            runId: error.activeRunId,
            phase: error.activePhase,
          },
        },
        { status: 409 },
      );
    }
    return Response.json(
      { error: { code: 'plan_cleanup_start_failed', message: error instanceof Error ? error.message : String(error) } },
      { status: 500 },
    );
  }
}

const route = defineTool({
  method: 'POST',
  path: '/admin/plan-cleanup',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  timeoutSec: 300,
  handler: planCleanupHandler,
});

export default [route];
