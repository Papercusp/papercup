import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPlanPartsStore } from './store';
import {
  reconcilePlanParts,
  ensurePlanPartsReconciledOnce,
  __resetPlanPartsReconcileOnceForTests,
  type PlanContentRow,
} from './reconcile';
import { joinFederatedParts } from '@papercusp/plan-parser';

const PLAN_A = `---\ntitle: A\nslug: a\n---\n\n# A\n\n## Phase 1 — x\n\n- **P-001** \`todo\` one\n- **P-002** \`todo\` two\n`;
const PLAN_B = `---\ntitle: B\nslug: b\n---\n\n# B\n\n## Now\n\n**State:** hi\n`;

function rig(plans: PlanContentRow[]) {
  const stores = new Map<string, InMemoryPlanPartsStore>();
  const storeFor = (_sql: unknown, _ws: string, h: string) => {
    let s = stores.get(h);
    if (!s) { s = new InMemoryPlanPartsStore(); stores.set(h, s); }
    return s;
  };
  return {
    stores,
    deps: {
      workspaceId: 'ws',
      sql: {} as never,
      loadPlans: async () => plans,
      storeFor: storeFor as never,
      now: () => 1000,
    },
  };
}

describe('reconcilePlanParts (P-005 capture / P-007 backfill)', () => {
  it('backfills every plan into per-part rows; the parts recompose to the source', async () => {
    const { stores, deps } = rig([
      { harness_slug: 'h', plan_slug: 'a', content: PLAN_A },
      { harness_slug: 'h', plan_slug: 'b', content: PLAN_B },
    ]);
    const r = await reconcilePlanParts(deps);
    expect(r.plansScanned).toBe(2);
    expect(r.partsWritten).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    const store = stores.get('h')!;
    expect(joinFederatedParts(await store.getParts('a'))).toBe(PLAN_A); // round-trips
    expect(joinFederatedParts(await store.getParts('b'))).toBe(PLAN_B);
  });

  it('is idempotent — a second run over unchanged content writes nothing', async () => {
    const { deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A }]);
    const first = await reconcilePlanParts(deps);
    expect(first.partsWritten).toBeGreaterThan(0);
    const second = await reconcilePlanParts(deps);
    expect(second.partsWritten).toBe(0); // diff sees no change
  });

  it('captures only the CHANGED part on an edit', async () => {
    const { deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A }]);
    await reconcilePlanParts(deps);
    // Edit one item; re-point loadPlans at the edited content.
    const edited = PLAN_A.replace('`todo` one', '`done` ONE');
    (deps.loadPlans as unknown) = async () => [{ harness_slug: 'h', plan_slug: 'a', content: edited }];
    const r = await reconcilePlanParts(deps);
    expect(r.partsWritten).toBe(1); // just item:P-001
  });

  it('isolates a per-plan failure (loadPlans throw → errors, never throws)', async () => {
    const r = await reconcilePlanParts({
      workspaceId: 'ws',
      sql: {} as never,
      loadPlans: async () => { throw new Error('db down'); },
    });
    expect(r.errors).toBe(1);
    expect(r.plansScanned).toBe(0);
  });
});

describe('ensurePlanPartsReconciledOnce (flag-gated, once-per-process)', () => {
  beforeEach(() => __resetPlanPartsReconcileOnceForTests());

  it('flag OFF → no-op (DARK): the reconcile never loads plans', async () => {
    let loaded = false;
    ensurePlanPartsReconciledOnce(['ws'], {
      isFlagOn: async () => false,
      loadPlans: async () => { loaded = true; return []; },
      storeFor: (() => new InMemoryPlanPartsStore()) as never,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(loaded).toBe(false);
  });

  it('flag ON → runs once; a second call no-ops (once-flag)', async () => {
    let runs = 0;
    // Wait on the EVENT, not on a duration. ensurePlanPartsReconciledOnce fires a
    // detached async IIFE (await isFlagOn → await reconcilePlanParts → loadPlans),
    // and this used to sleep a fixed 5ms for that chain to land. That passes on an
    // idle box and fails under full-suite load, where 5ms elapses before the chain
    // reaches loadPlans — leaving runs at 0 and reddening the shared gate with
    // "expected +0 to be 1" while the production code was entirely correct.
    let firstRunReached!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      firstRunReached = resolve;
    });
    const seams = {
      isFlagOn: async () => true,
      // `sql` must be injected even though every other seam is: reconcilePlanParts
      // resolves `deps.sql ?? getOrgPg().sql` BEFORE it calls loadPlans, so without
      // this the real pool is opened (and the no-real-PG rail throws) before any
      // seam runs — swallowed by the best-effort catch, leaving runs at 0.
      sql: {} as never,
      loadPlans: async () => {
        runs++;
        firstRunReached();
        return [];
      },
      storeFor: (() => new InMemoryPlanPartsStore()) as never,
      now: () => 1,
    };
    ensurePlanPartsReconciledOnce(['ws'], seams);
    await firstRun; // the first run provably happened — no timing assumption
    ensurePlanPartsReconciledOnce(['ws'], seams); // once-flag → skipped
    // This second wait asserts NON-occurrence, so a fixed settle is sound: under
    // load a would-be second run is slower, which can only mask a regression here,
    // never manufacture the false failure the first wait was causing.
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
  });
});
