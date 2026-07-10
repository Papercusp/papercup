/**
 * probe:emit — self-verifying federation probe (fleet-reliability-verification-
 * 2026-07-10 P-010, WI-3812).
 *
 * Root lesson (2026-07-10 cause #10): every prior ad-hoc "v2t" liveness probe
 * was UNSTAMPED — nothing forced it to carry the keys required to prove it
 * actually rode the real federation pipeline, so "green" was unreachable by
 * construction for ~6h and nothing said so. This tool makes a probe
 * correct-by-construction: it stamps the required federation keys and REFUSES
 * loudly (a typed reason, in the response AND persisted) when the target
 * harness cannot possibly federate — never a silent no-op.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { isRegisteredHive } from '../../harness-registry';
import { buildProbeKey, PROBE_HOPS, stampProbe } from '../../sync/pot-git/federation-probe';
import { insertProbe, insertRefusedProbe } from '../../sync/pot-git/federation-probe-store';

export default defineTool({
  name: 'probe:emit',
  description:
    'Emit a self-verifying federation probe: stamps required federation keys (workspace_id, harness_slug) and REFUSES LOUDLY (never silently) when the target harness cannot federate — fixes 2026-07-10 cause #10, where every prior ad-hoc "v2t" marker probe was unstamped and green was unreachable for ~6h with nothing saying so. Tracked durably with a `captured` hop stamped; later hops (drain/replicate/merge/member_guard/project) land via probe:record-hop. Read with probe:get — its verdict NAMES the exact stalled hop.',
  guidance: {
    when:
      'Proving a federation/replication claim is REAL, not just "looks green" — verifying a fresh 2-machine rig federates content, diagnosing a "rosters but no content" stall, or replacing an ad-hoc marker write (the v2t convention) with something that cannot be emitted unstamped.',
    notWhen:
      'Routine coord messaging or an ordinary content write (features/issues/plans) — a probe is diagnostic, not a deliverable. Not a substitute for events:emit/events:await (in-process wake, not a federation-pipeline check).',
    chaining: 'probe:emit → probe:get { probeKey } to read the verdict; pipeline-stage code calls probe:record-hop as the op is observed at each stage.',
    seeAlso: ['probe:get', 'probe:record-hop'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Harness to probe federation for. Defaults to the session harness (ctx.harnessSlug) when omitted.'),
    expectedHops: z
      .array(z.enum(PROBE_HOPS))
      .min(1)
      .max(PROBE_HOPS.length)
      .optional()
      .describe(
        'Narrow which hops this probe is expected to traverse (default: all six). Pass a shorter list for a local-only probe with no live peer expected (e.g. [\'captured\',\'drained\']) so probe:get never reads it as perpetually stalled on a hop that was never going to fire.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? activeWorkspaceId();
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness = typeof ctxHarnessRaw === 'string' && ctxHarnessRaw ? ctxHarnessRaw : undefined;
    const harnessSlug = args.harnessSlug ?? ctxHarness;
    const nowMs = Date.now();

    let harnessIsFederated = false;
    if (workspaceId && workspaceId !== '*' && harnessSlug && harnessSlug !== '*') {
      try {
        harnessIsFederated = await isRegisteredHive(workspaceId, harnessSlug);
      } catch {
        // fail-closed: an unresolvable registry read means we cannot PROVE
        // this harness federates, so refuse (never assume federated).
        harnessIsFederated = false;
      }
    }

    const result = stampProbe({
      workspaceId,
      harnessSlug,
      emittedBy: identity.ownerId,
      harnessIsFederated,
      nowMs,
    });

    if (!result.ok) {
      // Best-effort durable record of the refusal (only when we have enough
      // to scope it — a structurally-missing workspace/harness/identity has
      // nowhere meaningful to persist against).
      if (workspaceId && workspaceId !== '*' && harnessSlug && harnessSlug !== '*' && identity.ownerId) {
        try {
          await insertRefusedProbe({
            workspaceId,
            harnessSlug,
            emittedBy: identity.ownerId,
            probeKey: buildProbeKey(harnessSlug, identity.ownerId, nowMs),
            reason: result.reason,
            nowMs,
          });
        } catch {
          // persistence of the refusal is best-effort — the refusal itself
          // is still returned to the caller either way.
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, refused: true, reason: result.reason, detail: result.detail }),
          },
        ],
      };
    }

    const receipt = await insertProbe(result.stamped);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            probeKey: receipt.probeKey,
            harnessSlug: receipt.harnessSlug,
            workspaceId: receipt.workspaceId,
            emittedAt: new Date(receipt.emittedAtMs).toISOString(),
            hopsExpected: args.expectedHops ?? PROBE_HOPS,
            hopsCaptured: ['captured'],
            next: 'poll probe:get { probeKey } for the verdict; pipeline stages record later hops via probe:record-hop',
          }),
        },
      ],
    };
  },
});
