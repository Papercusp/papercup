// EI-8 repro: exercise the FULL claim write path the plan_items:claim tool uses.
// Installs the swarm claim authority (as the tool barrel does), then runs
// claimPlanItem → acquireClaim → routeToAuthority → acquireClaimLocal (SQL insert).
import { installSwarmClaimAuthority } from './packages/operator-core/lib/plan-items/claim-authority-swarm.ts';
import { registerPlanItemClaimAuthorityOps } from './packages/operator-core/lib/plan-items/plan-item-claim-authority-ops.ts';
import { claimPlanItem } from './packages/operator-core/lib/plan-items/liveness.ts';
import { releaseClaim } from './packages/operator-core/lib/plan-items/claims.ts';
import { DEFAULT_WORKSPACE_ID } from './packages/operator-core/lib/workspace-id-constant.ts';

const SCRATCH_PLAN = 'ei8-repro-scratch-plan';
const SCRATCH_ITEM = 'P-EI8';
const OWNER = 'ei8-repro-owner';

async function main() {
  installSwarmClaimAuthority();
  registerPlanItemClaimAuthorityOps();
  try {
    const result = await claimPlanItem({
      workspaceId: DEFAULT_WORKSPACE_ID,
      harnessSlug: 'papercup',
      planSlug: SCRATCH_PLAN,
      itemId: SCRATCH_ITEM,
      owner: OWNER,
      ownerLabel: 'ei8-repro',
      ownerName: null,
      ownerUser: 'ei8-repro',
      intent: 'EI-8 reproduction probe',
      livenessMode: 'availability',
      ttlSec: 60,
    });
    console.log('claimPlanItem RESULT:', JSON.stringify(result));
    if (result.status === 'claimed') {
      const freed = await releaseClaim(
        DEFAULT_WORKSPACE_ID, 'papercup', SCRATCH_PLAN, SCRATCH_ITEM,
        result.claim.claimId, OWNER,
      );
      console.log('cleanup releaseClaim freed:', freed);
    }
    console.log('NO require-not-defined error — claim write path is healthy.');
  } catch (err) {
    console.error('claim write path THREW:', err);
  }
}
main();
