/** Native transcript -> exact PG cursor ACK -> existing agent_activity writer.
 * This proves receipt persistence, NOT eligibility, a worker claim or a grade. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { ackAndRead, stage, resetReadCursorStore } from './agent-tools/coordination/read-cursors';
import { createPgTelemetryStore } from './activity-pg-store';
import { readVerbatimTail } from './turn-journal';
import { AGENT_OBLIGATION_SCHEMA_VERSION, defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import { ORIENTATION_CURSOR_SURFACE } from './turn-start-orientation';
import { recordVerifiedGoalPlacementEffects, readGoalPlacementProgress } from './goal-placement-progress-store';
import { compileGoalPlanPlacement, type GoalPortfolioBrief } from './goal-launch-settings';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import { confirmGoalPlacementDelivery, prepareGoalPlacementDelivery, GOAL_PLACEMENT_DELIVERY_KEY,
  type GoalPlacementTurnReceiptDeps } from './goal-placement-turn-receipts';

const OWNER = `su-goal-receipt-${Date.now()}`;
const WS = 'default';
const SURFACE = ORIENTATION_CURSOR_SURFACE;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 0, minute)).toISOString();
const row = defineAgentObligation({
  family: 'plan-placement', ruleId: 'placement', ruleRevision: 'v1',
  scope: { ownerId: OWNER, workspaceId: WS, goalId: 'goal', planSlug: 'plan' },
  responsibleOwnerId: OWNER, title: 'Place plan', status: 'due', reason: 'No member claim.',
  authority: { kind: 'policy', sourceRef: 'fixture:policy', revision: 'v1' },
  priority: 'high', causalRank: 1, evidence: [], applicableDemand: 1,
  sourceGeneration: 'generation-1', episode: 'fixture-episode',
  clearsWhen: { id: 'claimed', summary: 'Member claim exists.', evidenceKind: 'state', sourceRef: 'fixture:claims' },
  action: { kind: 'delegate', summary: 'Staff plan.', targetRef: 'plan:papercusp/plan', tool: 'fleet:launch-on-plan' },
});
const brief = projectAgentTurnStartObligationBrief({ schemaVersion: AGENT_OBLIGATION_SCHEMA_VERSION,
  evaluatedAt: at(2), sourceGeneration: 'generation-1', evaluations: [row], primary: [row], conflicts: [] });
let fx: BaselineCoordFixture;
let directory: string;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  resetReadCursorStore();
  directory = await mkdtemp(join(tmpdir(), 'goal-receipt-pg-'));
}, 150_000);
afterEach(async () => {
  await fx.admin`DELETE FROM harness_shared.coord_read_cursors WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
});
afterAll(async () => {
  resetReadCursorStore();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (fx) await fx.dispose();
});

async function fixture() {
  const session = { sourceKind: 'codex' as const, sessionId: OWNER, filePath: join(directory, 'session.jsonl') };
  let now = Date.parse(at(2));
  function native(id: string, minute: number, phase: 'commentary' | 'final_answer') {
    return ['user', 'assistant'].map((role) => ({ type: 'response_item', timestamp: at(minute),
      payload: { type: 'message', role, ...(role === 'assistant' ? { phase } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: id },
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: 'Fixture native response' }] },
    }));
  }
  const prior = native('prior', 1, 'final_answer');
  const write = async (rows: unknown[]) => writeFile(session.filePath, rows.map((value) => JSON.stringify(value)).join('\n') + '\n');
  await write(prior);
  const deps: GoalPlacementTurnReceiptDeps = {
    current: async () => session, lookup: async (owner, id) => owner === OWNER && id === session.sessionId ? session : null,
    tail: (source) => readVerbatimTail(source.filePath, source.sourceKind, 50),
    append: createPgTelemetryStore().append, now: () => now,
  };
  const candidate = await prepareGoalPlacementDelivery({ ownerId: OWNER, workspaceId: WS,
    token: 'exact-token', brief, block: formatAgentObligationLine(row, 'action') }, deps);
  expect(candidate).not.toBeNull();
  await stage(OWNER, SURFACE, { [GOAL_PLACEMENT_DELIVERY_KEY]: candidate }, { deliveryToken: 'exact-token' });
  return { deps, candidate,
    finish: async (phase: 'commentary' | 'final_answer') => {
      await write([...prior, ...native('next', 3, phase)]); now = Date.parse(at(4));
    },
    confirm: async (token: string | null) => {
      const ack = await ackAndRead(OWNER, SURFACE, { confirmedToken: token });
      return confirmGoalPlacementDelivery({ ownerId: OWNER, workspaceId: WS, confirmedToken: token,
        candidate: ack?.committed?.[GOAL_PLACEMENT_DELIVERY_KEY], brief }, deps);
    },
  };
}
async function records() {
  return fx.admin`SELECT owner_id, workspace_id, session_id, harness_slug, tool_use_id, detail
    FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
}

/** The claim compiler is production code; PG tests below exercise persistence.
 * Canonical fleet/claim writers themselves are covered by the P003 integration. */
function effectPortfolio(minute: number, workItemId: string | null = 'WI-member'): GoalPortfolioBrief {
  const placement = compileGoalPlanPlacement({ plan: { harness: 'papercusp', slug: 'plan', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', now: new Date(at(minute)),
    source: { goalHolderOwnerIds: [OWNER],
      claims: [{ itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'plan-fleet', holderLive: true,
        workItemId, expiresAt: at(minute + 10) }],
      fleet: { slug: 'plan-fleet', controlState: 'active', leaderOwnerId: 'su-leader', leaderLive: true, liveMembers: 2, target: 1,
        claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'plan', op: '=', value: 'plan' } } },
        launchTransaction: { transactionId: 'tx-plan', state: 'verified' } },
    } });
  return {
    schemaVersion: 1, assembledAt: at(minute),
    goal: { id: 'goal', title: 'Goal', status: 'active', body: null, killCriterion: null, standing: false, parentId: null },
    worklist: [{ ref: 'plan:papercusp/plan', ordinal: 0, harness: 'papercusp', slug: 'plan', title: 'Plan', status: 'started',
      next: { id: 'P-001', text: 'Execute', phase: null, blockedBy: [] },
      counts: { todo: 0, wip: 1, blocked: 0, needsHuman: 0, done: 0 }, ambiguousMatches: 1, placement }],
    pots: [], drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
    queue: { total: 1, terminal: 0, inFlight: 1, blocked: 0, needsHuman: 0, claimable: 0, claimabilityScope: 'issue-family' },
    launch: { settings: null, ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 2, fleet: null } },
    budget: { budgetCents: null, spentCents: null, unmeasuredPricedSpend: false, spentCentsAt: null,
      spentCentsSource: null, budgetWindowSec: null }, tripwires: [], pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null }, priorities: [], degradedReasons: [],
  };
}

describe('first verified effect clock on canonical cursor storage', () => {
  const scope = { workspaceId: WS, ownerId: OWNER, goalId: 'goal' };
  const read = () => readGoalPlacementProgress({ ...scope, planRefs: ['plan:papercusp/plan'] });
  it('retains the first verified identity through repeated reads, lease renewal and concurrent observations', async () => {
    expect((await read())['plan:papercusp/plan']).toBeNull();
    const first = { ...scope, portfolio: effectPortfolio(2) };
    expect(first.portfolio.worklist[0]!.placement.state).toBe('working');
    expect((await Promise.all([recordVerifiedGoalPlacementEffects(first), recordVerifiedGoalPlacementEffects(first)])).sort()).toEqual([0, 1]);
    const initial = (await read())['plan:papercusp/plan'];
    expect(initial?.lastEffect).toMatchObject({ kind: 'member-claim', at: at(2) });
    expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: effectPortfolio(5) })).toBe(0);
    expect((await read())['plan:papercusp/plan']).toEqual(initial);
  });
  it('advances only for a new verified member work item, not an admitting launch', async () => {
    expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: effectPortfolio(2, null) })).toBe(0);
    expect((await read())['plan:papercusp/plan']).toBeNull();
    await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: effectPortfolio(3) });
    expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: effectPortfolio(5, 'WI-new-member-work') })).toBe(1);
    expect((await read())['plan:papercusp/plan']?.lastEffect?.at).toBe(at(5));
  });
  it('does not create effects for paused, foreign, degraded or malformed lease observations', async () => {
    for (const change of ['paused', 'foreign', 'degraded', 'bad-lease']) {
      const p = effectPortfolio(2);
      if (change === 'paused') p.goal.status = 'paused';
      if (change === 'foreign') p.goal.id = 'foreign-goal';
      if (change === 'degraded') p.degradedReasons.push('measurement unavailable');
      if (change === 'bad-lease') p.worklist[0]!.placement.activeLane!.expiresAt = 'not-a-date';
      expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: p })).toBe(0);
    }
    expect((await read())['plan:papercusp/plan']).toBeNull();
  });
  it('isolates the stored clock by owner and goal', async () => {
    await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: effectPortfolio(2) });
    expect((await readGoalPlacementProgress({ ...scope, ownerId: 'other', planRefs: ['plan:papercusp/plan'] }))['plan:papercusp/plan']).toBeNull();
    expect((await readGoalPlacementProgress({ ...scope, goalId: 'other', planRefs: ['plan:papercusp/plan'] }))['plan:papercusp/plan']).toBeNull();
  });
});

describe('goal delivery receipt canonical persistence', () => {
  it('persists the exact native request through PG ACK and the existing telemetry writer', async () => {
    const f = await fixture();
    expect(await records()).toHaveLength(0);
    await f.finish('final_answer');
    expect((await f.confirm('exact-token')).recorded).toBe(1);
    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_id: OWNER, workspace_id: WS, session_id: OWNER, harness_slug: 'papercusp',
      tool_use_id: `goal-placement:exact-token:${row.id}`, detail: { goalPlacementTurn: {
        version: 1, deliveryToken: 'exact-token', offeredAt: at(2), completedAt: at(3), confirmedAt: at(4),
        completedTurnRef: `codex:${OWNER}:next`, obligationId: row.id, sourceGeneration: 'generation-1',
        atConfirmation: { status: 'due', sourceGeneration: 'generation-1' },
      } } });
    expect(rows[0]!.detail.goalPlacementTurn).not.toHaveProperty('eligibleAtCompletion');
    expect(rows[0]!.detail.goalPlacementTurn).not.toHaveProperty('opportunities');
  });

  it('cannot persist a staged but unconfirmed delivery', async () => {
    const f = await fixture(); await f.finish('final_answer');
    expect((await f.confirm('wrong-token')).recorded).toBe(0);
    expect(await records()).toHaveLength(0);
  });

  it('a valid PG ACK without a native final is not a completed decision', async () => {
    const f = await fixture(); await f.finish('commentary');
    expect((await f.confirm('exact-token')).reason).toBe('no-completed-native-decision');
    expect(await records()).toHaveLength(0);
  });

  it('keeps evidence unknown when a cold continuation cannot resolve the original native session', async () => {
    const f = await fixture(); await f.finish('final_answer');
    f.deps.lookup = async () => null;
    expect((await f.confirm('exact-token')).reason).toBe('native-session-unavailable');
    expect(await records()).toHaveLength(0);
  });
});
