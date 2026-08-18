/**
 * `system:coverage-census` — the census cadence's routine-engine registration.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-002).
 *
 * A bespoke `tier:'ephemeral'` operator-HOME cadence (same deviation reasoning as
 * supervision-reconcile-action: one sweep serves the host, not a per-blueprint-install generic
 * schedule). Ephemeral rows are armed by the per-host ephemeral executor — NOT a bare
 * setInterval (`lint:no-raw-setinterval`).
 *
 * REGISTERED HERE EVEN THOUGH NO PROVIDERS EXIST YET (they land in P-003). That is deliberate:
 * a routine seeded ACTIVE whose `system:` action is registered NOWHERE silently skips every
 * fire and looks alive in the routines table (EI-18741229858124453 — `template-gym` sat in
 * exactly that state). Registering the handler up front means the cadence is genuinely running;
 * with an empty provider set it is a correct no-op, because no provider reporting success means
 * no kind is retirable and the census cannot write a retirement.
 */
import { getOrgPg } from '@papercusp/db-org';
import { runCensus } from '@papercusp/testing-shell/census';
import { activeWorkspaceId } from '../../workspace-registry';
import { createPgCensusStore } from '../../coverage-census/pg-store';
import { censusProviders } from '../../coverage-census/provider-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

registerSystemAction('coverage-census', async (_ctx: SystemActionCtx) => {
  const providers = censusProviders();
  const scope = {
    workspaceId: activeWorkspaceId(),
    harnessSlug: operatorHomeHarnessSlug(),
  };

  const store = createPgCensusStore({ getSql: () => getOrgPg().sql });

  const report = await runCensus({
    scope,
    store,
    providers,
    repoRoot: process.cwd(),
  });

  // The breaker refusing a write is the one outcome that must never be quiet: it means the
  // census believes most of the world disappeared, and a silent refusal would leave the gate
  // reading a stale census with nobody aware.
  if (report.retirementBlocked) {
    console.warn(
      `[coverage-census] MASS-RETIREMENT REFUSED for ${scope.harnessSlug}: ` +
        `${report.retirementBlocked.wouldRetire} of ${report.retirementBlocked.liveRows} live rows ` +
        `would have been retired (threshold ${report.retirementBlocked.threshold}). ` +
        `Upserts were still applied; retirements were NOT. Inspect the providers before re-running ` +
        `with allowMassRetirement.`,
    );
  }

  if (report.failedProviders.length > 0) {
    console.warn(
      `[coverage-census] ${report.failedProviders.length} provider(s) FAILED — their kinds were ` +
        `left untouched this run (absent means unknown, not gone): ` +
        report.failedProviders.map((f) => `${f.provider}: ${f.error}`).join('; '),
    );
  }

  if (report.unimplementedProviders.length > 0) {
    console.warn(
      `[coverage-census] registered but not implemented in this build: ` +
        report.unimplementedProviders.join(', '),
    );
  }

  console.log(
    `[coverage-census] ${scope.harnessSlug}: ran ${report.ranProviders.length} provider(s), ` +
      `upserted ${report.applied?.upserted ?? 0}, retired ${report.applied?.retired ?? 0} ` +
      `(retirable kinds: ${report.diff.retirableKinds.join(',') || 'none'})`,
  );
});
