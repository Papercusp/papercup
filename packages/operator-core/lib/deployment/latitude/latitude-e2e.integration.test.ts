/**
 * LIVE Latitude.sh E2E (`cloud-deployment-layer-2026-06-06` P-013).
 *
 * SKIPPED unless the owner-provided creds are present — it provisions a REAL
 * machine and costs money. Set to run it:
 *   LATITUDE_API_KEY=<key>          # the account API key
 *   LATITUDE_E2E_PROJECT=<id|slug>  # the Latitude project to bill
 *   LATITUDE_E2E_SITE=NYC             # (optional) site pin; default AUTO-PICKED from live stock
 *   LATITUDE_E2E_PLAN=m4-metal-small  # (optional) plan slug,   default m4-metal-small
 *
 * Plan default updated 2026-06-06: `c2-small-x86` no longer exists in the live
 * Latitude catalog (GET /plans); `m4-metal-small` is the cheapest in-stock small
 * metal plan (hourly billing).
 *
 * Stock is VOLATILE — a site can be in stock one run and SERVERS_OUT_OF_STOCK
 * (HTTP 422) the next (observed live: consuming NYC's last unit emptied it for
 * the following run). So when LATITUDE_E2E_SITE is unset, the test queries
 * `GET /plans` fresh and picks an in-stock site (US-preferred) via pickInStockSite.
 *
 * It ALWAYS tears the frame down (DESTROY) in a finally, so a failed run never
 * leaks billing. The full "run a coding feature on the frame + watch from the
 * local app" loop (the rest of P-013) additionally needs a registered harness
 * with a `deployment` + an SSH identity for the bootstrap; that path runs via
 * `deployHarness`/`teardownHarness` when LATITUDE_E2E_HARNESS is also set.
 */
import { describe, it, expect } from 'vitest';
import type { DeploymentConfig, DeploymentContext } from '@papercusp/deployment-driver';
import { LatitudeDriver } from './latitude-driver';
import { createLatitudeApiClient, pickInStockSite } from './latitude-api';

const haveCreds = !!process.env.LATITUDE_API_KEY && !!process.env.LATITUDE_E2E_PROJECT;
const TWENTY_MIN = 20 * 60_000;
/** The full lifecycle includes the on-frame install (apt + node + 198MB tarball scp +
 *  monorepo npm ci) — far heavier than the provision smoke. */
const FORTY_FIVE_MIN = 45 * 60_000;

const ctx: DeploymentContext = {
  harnessSlug: 'e2e-smoke',
  workspaceId: 'e2e',
  log: (lvl, msg) => console.log(`[latitude-e2e ${lvl}] ${msg}`),
};

const E2E_PLAN = process.env.LATITUDE_E2E_PLAN ?? 'm4-metal-small';

/** Site pin from env, else auto-pick from LIVE stock (volatile — fresh per run). */
async function resolveSite(): Promise<string> {
  if (process.env.LATITUDE_E2E_SITE) return process.env.LATITUDE_E2E_SITE;
  const client = createLatitudeApiClient({ apiKey: process.env.LATITUDE_API_KEY! });
  const site = pickInStockSite(await client.listPlans(), E2E_PLAN, ['ASH', 'NYC', 'DAL', 'CHI']);
  if (!site) throw new Error(`latitude-e2e: no site has live stock for plan '${E2E_PLAN}' — pick another plan`);
  console.log(`[latitude-e2e] auto-picked in-stock site ${site} for ${E2E_PLAN}`);
  return site;
}

const liveConfig = async (): Promise<DeploymentConfig> => ({
  target: 'latitude',
  region: await resolveSite(),
  size: E2E_PLAN,
  provider: { project: process.env.LATITUDE_E2E_PROJECT },
});

describe.skipIf(!haveCreds)('LatitudeDriver live E2E (needs LATITUDE_API_KEY + LATITUDE_E2E_PROJECT)', () => {
  it(
    'provisions a real frame then DESTROYS it (round-trip; teardown ends billing)',
    async () => {
      const config = await liveConfig();
      let frame: Awaited<ReturnType<typeof LatitudeDriver.provision>> | undefined;
      try {
        frame = await LatitudeDriver.provision(config, ctx);
        expect(frame.placement).toBe('remote');
        expect(frame.target).toBe('latitude');
        expect(frame.host).toBeTruthy(); // got a reachable IP
        expect(frame.id).toBeTruthy();
        console.log(`[latitude-e2e] provisioned ${frame.id} @ ${frame.host}`);
      } finally {
        if (frame) {
          // ALWAYS destroy — a leaked frame bills indefinitely.
          await LatitudeDriver.teardown(frame, config, ctx);
          console.log(`[latitude-e2e] destroyed ${frame.id}`);
        }
      }
    },
    TWENTY_MIN,
  );
});

const haveFull = haveCreds && !!process.env.LATITUDE_E2E_HARNESS;

describe.skipIf(!haveFull)('Full deploy lifecycle E2E (also needs LATITUDE_E2E_HARNESS + an SSH identity)', () => {
  it(
    'deploys a harness onto a frame (provision→install→join), then tears down (DESTROY)',
    async () => {
      const { deployHarness, teardownHarness, defaultDeployDeps } = await import('../deploy');
      const slug = process.env.LATITUDE_E2E_HARNESS!;
      const ws = process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
      const deps = defaultDeployDeps((lvl, m) => console.log(`[${lvl}] ${m}`));
      try {
        const { frame } = await deployHarness(slug, ws, deps);
        expect(frame.host).toBeTruthy();
        console.log(`[latitude-e2e] ${slug} deployed on ${frame.id} @ ${frame.host}`);
        // The frame now runs its own loop (D-006) against its own embedded-pg (D-007);
        // feature completion federates back to the local peer. Asserting a completed
        // feature here requires a seeded work-item + wait-for-federation; left as the
        // documented extended step (it's the same federation the unit suite covers).
      } finally {
        const r = await teardownHarness(slug, ws, deps);
        console.log(`[latitude-e2e] ${slug} teardown destroyed=${r.destroyed}`);
      }
    },
    FORTY_FIVE_MIN,
  );
});
