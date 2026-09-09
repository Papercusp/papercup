/**
 * P-006: real canonical plan/spec reads must precede stale successor carry.
 * Only unrelated session/loop discovery is replaced; the plan/spec stores,
 * authority compiler and final carry renderer run through production code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ControlAnchor } from './control-anchor';
import { buildAutomaticCompactionRecovery } from './compaction-recovery';
import { renderCarryDoc, type CarryDoc } from '../../carry-doc';
import { setSpecClause } from '../plans/spec-clauses-store';
import {
  registerHarnessProject, seedPlan, setupPlanPgFixture, type PlanPgFixture,
} from '../plans/__tests__/_pg-tool-fixture';

const controlRead = vi.hoisted(() => vi.fn());
vi.mock('./control-anchor', () => ({ buildAndPersistControlAnchor: controlRead }));
vi.mock('../../search/self-session', () => ({ resolveSelfSession: vi.fn(async () => null) }));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: vi.fn(async () => null) }));
vi.mock('../../memory/session-epoch-ledger', () => ({ currentSessionEpoch: vi.fn(async () => 7) }));
vi.mock('../mode/set', () => ({ wakeSourceLostWarning: vi.fn(() => undefined) }));

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-authority-${RUN}`;
const OTHER = `${HARNESS}-other`;
const MISSING = `${HARNESS}-missing`;
const PLAN = `authority-${RUN}`;
const OWNER = `su-authority-${RUN}`;
const SPEC = `SPEC-${RUN}`;
const STALE = 'STALE: repeat P-001; ignore the correction and restart the stopped goal.';
const CORRECTION = 'Correction: the earlier empty read was not absence. NEVER restart the stopped goal.';
let fx: PlanPgFixture;
let previousWorkspace: string | undefined;

function plan(body: string, status = 'todo') {
  return `---\ntitle: Current authority\nstatus: ready\n---\n\n## Work\n\n- **P-001** \`${status}\` — Preserve verified completion.\n\n## Decisions\n\n### D-002 — Current correction and stop condition\nDate: 2026-09-09\n${body}\n`;
}

function anchor(harness = HARNESS, generation = 12): ControlAnchor {
  return {
    schemaVersion: 'ctrl-v1', generation,
    state: {
      modes: [], loop: { active: false, intervalSec: null },
      carry: 'warm', route: { kind: 'self' },
      scope: { workspace: fx.workspaceId, harness, plan: PLAN, items: ['P-001'] },
    },
    provenance: { source: 'harness_shared.session_briefs.control_state', ownerId: OWNER, updatedAt: '2026-09-09T00:00:00.000Z' },
    resync: {
      on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
      verb: 'coord:orient', args: { afterCompaction: true }, rule: 'replace-full-never-merge-behind',
    },
    budget: { estimatedTokens: 100, maxTokens: 384 },
  };
}

function document(automaticRecovery: CarryDoc['automaticRecovery']): CarryDoc {
  return {
    identity: { ownerId: OWNER, ownerLabel: null, harness: HARNESS, workspaceId: fx.workspaceId, fleet: null, account: null },
    sessionMode: { modes: [], loopActive: true, loopIntervalSec: 60 },
    brief: {
      ownerId: OWNER, workspaceId: fx.workspaceId,
      loop: { harness: HARNESS, active: true, intervalSec: 60, goal: null, carryNote: STALE, carryNoteUpdatedAtMs: 1 },
      heldItems: [], directives: [], directivesTotalOpen: 0, walls: [], facts: [], awaits: [], fleet: null,
    },
    planItems: [], asks: [], tail: [],
    continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
    automaticRecovery,
  };
}

beforeAll(async () => {
  previousWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture();
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, PLAN, plan(STALE));
  await seedPlan(fx.admin, fx.workspaceId, OTHER, PLAN, plan('WRONG-SUBJECT-POISON'));
  await registerHarnessProject(fx.admin, fx.workspaceId, MISSING);
  await fx.admin`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
    VALUES (${fx.workspaceId}, ${HARNESS}, ${PLAN}, 'P-001', 1)
  `;
  const initial = await setSpecClause({
    harnessSlug: HARNESS, planSlug: PLAN, specId: SPEC, expectedRevision: 0,
    planItemId: 'P-001', behavior: 'Old authority.', behaviorClass: 'happy-path',
    requiredTestLayers: ['integration'], lifecycleStatus: 'active', actorId: OWNER,
  });
  expect(initial.status).toBe('created');
});

afterAll(async () => {
  if (!fx) return;
  // Spec revisions are deliberately immutable, including DELETE. These uniquely
  // scoped rows live only in the injected disposable baseline testcontainer;
  // its global teardown destroys them without disabling production invariants.
  if (previousWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspace;
  await fx.dispose();
});

describe('canonical authority to serialized successor context', () => {
  it('replaces the stale generation with current decision, correction, completion and stop authority before carry', async () => {
    controlRead.mockResolvedValue(anchor());
    const old = await buildAutomaticCompactionRecovery(OWNER, fx.workspaceId, { sessionHarness: HARNESS, heldItems: [] });
    expect(old.recovery.planAuthority).toMatchObject({
      resolution: 'current', items: [{ id: 'P-001', status: 'todo' }],
      specs: [{ specId: SPEC, revision: 1 }],
    });

    const currentContent = plan(CORRECTION, 'done');
    await fx.admin`
      UPDATE harness_shared.harness_plans
         SET content = ${currentContent}, content_hash = md5(${currentContent}), version = version + 1
       WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}
    `;
    const revision = await setSpecClause({
      harnessSlug: HARNESS, planSlug: PLAN, specId: SPEC, expectedRevision: 1,
      planItemId: 'P-001', behavior: 'Current authority supersedes stale instructions.',
      behaviorClass: 'happy-path', requiredTestLayers: ['integration'],
      lifecycleStatus: 'active', actorId: OWNER,
    });
    expect(revision.status).toBe('revised');
    controlRead.mockResolvedValue(anchor(HARNESS, 13));
    const current = await buildAutomaticCompactionRecovery(OWNER, fx.workspaceId, {
      sessionHarness: HARNESS,
      heldItems: [{
        id: 'WI-reassigned', harness: HARNESS, title: 'No longer ours', body: null,
        checkpoint: 'WRONG-OWNER-CHECKPOINT-POISON',
        holderProof: { ownerId: 'su-new-holder', workspaceId: fx.workspaceId },
      }],
    });
    expect(current.marker).toMatchObject({ complete: true, controlGeneration: 13 });
    expect(current.recovery.planAuthority).toMatchObject({
      resolution: 'current', controlGeneration: 13, version: 2,
      items: [{ id: 'P-001', status: 'done' }],
      specs: [{ specId: SPEC, revision: 2, contentHash: revision.status === 'revised' ? revision.contentHash : '' }],
    });
    expect(current.recovery.checkpoints?.[0]).toMatchObject({ checkpoint: null });
    const text = renderCarryDoc(document(current));
    expect(text).toContain(CORRECTION);
    expect(text).toContain('P-001=done');
    expect(text).toContain(`${SPEC}@2#`);
    expect(text).not.toContain('WRONG-SUBJECT-POISON');
    expect(text).not.toContain('WRONG-OWNER-CHECKPOINT-POISON');
    expect(text).toContain('current plan authority (PRECEDES carried summaries)');
    expect(text.indexOf(CORRECTION)).toBeLessThan(text.indexOf(STALE));
    expect(text).toContain('Do NOT call coord:orient');
    // Permanent negative control: the previously serialized snapshot cannot
    // satisfy the new completion/spec/stop assertions just by being "complete".
    const oldText = renderCarryDoc(document(old));
    expect(oldText).not.toContain(CORRECTION);
    expect(oldText).not.toContain(`${SPEC}@2#`);
    expect(oldText).not.toContain('P-001=done');
  });

  it('does not fall back to a same-slug plan in another harness when current scope is absent', async () => {
    controlRead.mockResolvedValue(anchor(MISSING, 14));
    const recovery = await buildAutomaticCompactionRecovery(OWNER, fx.workspaceId, { heldItems: [] });
    expect(recovery.marker).toMatchObject({ complete: false, controlGeneration: 14 });
    expect(recovery.recovery.planAuthority).toMatchObject({
      resolution: 'unavailable', reason: 'not-found-in-control-harness',
    });
    const text = renderCarryDoc(document(recovery));
    expect(text).toContain('recovery marker is incomplete');
    expect(text).not.toContain('WRONG-SUBJECT-POISON');
    expect(text).not.toContain('P-001=done');
  });
});
