/**
 * `system:gate-canary-sweep` — the missing SCHEDULED counterpart of the
 * on-demand `gates:canary-check` tool (fleet-reliability-verification-
 * 2026-07-10 P-011 substrate, `gates/canary.ts`).
 *
 * WI-5977 (explicit-presence-as-convention-2026-07-26): "a built-in CANARY
 * job that deliberately [proves it can fail], so a runner that ever reports
 * it green is caught by the system rather than by whoever happened to be
 * careful that day." The `GateCanaryDef` substrate + the federation-probe and
 * green-checkpoint canaries have existed since 2026-07-10, and
 * green-checkpoint-canary.ts's own file header already claimed a "scheduled
 * (system:gate-canary-sweep) counterpart" — but nothing ever registered that
 * action or seeded a routine for it (reuse-first search, 2026-07-26: zero
 * hits for `gate-canary-sweep` anywhere in the tree before this file). This
 * closes that gap for the ONE canary this tier can reach without a layering
 * violation.
 *
 * SCOPE (deliberately conservative, same discipline as every canary above):
 * this sweeps ONLY the federation-probe canary (`federation-probe-canary.ts`,
 * operator-core-native). The green-checkpoint result-parser canary
 * (apps/operator/lib/release/green-checkpoint-canary.ts) is APPS/OPERATOR
 * tier — operator-core must not import it (the same layering
 * `system:green-checkpoint` / `system:autoloop-release-readiness-monitor`
 * already respect; see autoloop-release-readiness-action.ts's header). Wiring
 * that canary into this sweep needs the same shell-out-to-a-standalone-CLI
 * pattern those two actions use — left as an explicit, named follow-on, not
 * silently dropped.
 *
 * TARGET HARNESS: the routine's OWN `install_slug` (`ctx.installSlug`) is the
 * harness this sweep canary-checks, exactly like every other per-harness
 * system action. If that harness is not actually a registered federated hive
 * (isRegisteredHive), the sweep reports INDETERMINATE (verdict 'unknown',
 * alarm 'none') rather than manufacturing a false 'gate-broken' alarm — the
 * same EI-11574 lesson `gates:canary-check` already applies to a missing/
 * wildcard harness.
 *
 * Records the verdict as a per-harness fact every tick
 * (GATE_CANARY_SWEEP_FACT_KEY) so a stale/silently-stopped sweep is visible
 * via `facts:list`, mirroring autoloop-release-readiness-action.ts. Does NOT
 * page/escalate on a gate-broken finding (out of scope for this pass — see
 * the follow-on note above); the fact + the log line are the only surfaces
 * today.
 *
 * Seeded INACTIVE (seed-gate-canary-sweep-routine.ts) — same bring-up
 * discipline as every other routine registered here: the routines engine on
 * the GREEN `:3070` operator won't know this action name until the staging→
 * main deploy carries it, and the seed script also needs a real federated
 * harness slug named explicitly (never guessed) before it is worth arming.
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { assertFact } from '../agent-facts/store';
import { isRegisteredHive } from '../harness-registry';
import { insertProbe } from '../sync/pot-git/federation-probe-store';
import { buildFederationProbeCanary } from './federation-probe-canary';
import { runGateCanary } from './canary';

export const GATE_CANARY_SWEEP_FACT_KEY = 'gate-canary-sweep-verdict';
export const GATE_CANARY_SWEEP_ACTION_NAME = 'gate-canary-sweep';

registerSystemAction(GATE_CANARY_SWEEP_ACTION_NAME, async (ctx: SystemActionCtx) => {
  const harnessSlug = ctx.installSlug;
  const federated = await isRegisteredHive(ctx.workspaceId, harnessSlug).catch((e) => {
    console.warn(`[gate-canary-sweep] isRegisteredHive lookup failed (treating as indeterminate): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  if (federated !== true) {
    // NOT gate-broken: a non-federated (or lookup-failed) target harness is not
    // evidence the apparatus is broken — per EI-11574, an indeterminate target
    // must never manufacture a false critical alarm.
    const detail =
      federated === null
        ? `harness-federation lookup failed for "${harnessSlug}" — canary indeterminate, not evidence of a gate failure`
        : `"${harnessSlug}" is not a registered federated hive — canary indeterminate, nothing to sweep here`;
    console.log(`[gate-canary-sweep] ${detail}`);
    await assertFact({
      scope: 'harness',
      scopeRef: harnessSlug,
      key: GATE_CANARY_SWEEP_FACT_KEY,
      body: `gate-canary-sweep: UNKNOWN (indeterminate) — ${detail}`.slice(0, 500),
      createdBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
      ttlSec: 24 * 3600,
      workspaceId: ctx.workspaceId,
    }).catch((e) => {
      console.warn('[gate-canary-sweep] fact assert failed (non-fatal):', e instanceof Error ? e.message : e);
    });
    return;
  }

  const canary = buildFederationProbeCanary({
    workspaceId: ctx.workspaceId,
    harnessSlug,
    emittedBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
    harnessIsFederated: () => Promise.resolve(true),
    insertProbe,
  });
  // No live systemGreen signal wired here (this is an apparatus-only sweep,
  // like the on-demand gates:canary-check tool) — pass null so a healthy
  // apparatus reads 'unknown'/alarm:'none' rather than a manufactured 'healthy'.
  const report = await runGateCanary(canary, null);

  const line = `[gate-canary-sweep] ${harnessSlug}: verdict=${report.classification.verdict} alarm=${report.classification.alarm} — ${report.classification.detail}`;
  if (report.classification.alarm === 'none') {
    console.log(line);
  } else {
    // alarm:'gate' — a KNOWN-GOOD sample failed the apparatus itself. This is
    // exactly the class WI-5977 exists to catch: a runner that would otherwise
    // report green (or silently stop reporting at all) while broken.
    console.warn(line);
  }

  await assertFact({
    scope: 'harness',
    scopeRef: harnessSlug,
    key: GATE_CANARY_SWEEP_FACT_KEY,
    body: `gate-canary-sweep: ${report.classification.verdict.toUpperCase()} (alarm=${report.classification.alarm}) — ${report.canaryDetail}`.slice(0, 500),
    createdBy: `system:${GATE_CANARY_SWEEP_ACTION_NAME}`,
    ttlSec: 24 * 3600,
    workspaceId: ctx.workspaceId,
  }).catch((e) => {
    console.warn('[gate-canary-sweep] fact assert failed (non-fatal):', e instanceof Error ? e.message : e);
  });
});
