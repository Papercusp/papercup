/** Native transcript -> exact PG cursor ACK -> existing agent_activity writer.
 * This proves receipt persistence, NOT eligibility, a worker claim or a grade. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { ackAndRead, stage, resetReadCursorStore } from './agent-tools/coordination/read-cursors';
import { runWithWorkspace } from './workspace-als';
import { createPgTelemetryStore } from './activity-pg-store';
import { readVerbatimTail } from './turn-journal';
import { AGENT_OBLIGATION_SCHEMA_VERSION, defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import { projectAgentTurnStartObligationBrief } from './agent-obligation-reader';
import { ORIENTATION_CURSOR_SURFACE } from './turn-start-orientation';
import { drainDetached } from './detached-imports';
import { recordVerifiedGoalPlacementEffects, readGoalPlacementProgress } from './goal-placement-progress-store';
import { compileGoalPlanPlacement, type GoalPortfolioBrief } from './goal-launch-settings';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import { confirmGoalPlacementDelivery, prepareGoalPlacementDelivery, GOAL_PLACEMENT_DELIVERY_KEY,
  settleGoalPlacementTurn, reconcileConfirmedGoalPlacementTurns, readGoalPlacementAdmissionAttempts,
  type GoalPlacementAdmissionObservation, type GoalPlacementTurnReceiptDeps } from './goal-placement-turn-receipts';

const OWNER_PREFIX = 'su-goal-receipt-';
const OWNER = `${OWNER_PREFIX}${Date.now()}`;
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
  // The previous version's workspace-filtered cleanup could strand a cursor
  // written under the process workspace when the test called the endpoint
  // handler without request ALS. The fixture mutex makes this reserved-prefix
  // sweep safe across test processes; remove only rows owned by this test.
  const staleCursorOwners = await fx.admin<Array<{ owner_id: string }>>`
    SELECT DISTINCT owner_id FROM harness_shared.coord_read_cursors
     WHERE owner_id LIKE ${`${OWNER_PREFIX}%`} AND surface = ${SURFACE}`;
  for (const stale of staleCursorOwners) {
    await fx.admin`DELETE FROM harness_shared.coord_read_cursors
     WHERE owner_id = ${stale.owner_id} AND surface = ${SURFACE}`;
  }
  resetReadCursorStore();
  directory = await mkdtemp(join(tmpdir(), 'goal-receipt-pg-'));
}, 150_000);
afterEach(async () => {
  await fx.admin`DELETE FROM harness_shared.coord_read_cursors WHERE owner_id = ${OWNER} AND surface = ${SURFACE}`;
  await fx.admin`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.resource_governor_admissions
    WHERE workspace_id = ${WS} AND record->'metadata'->>'launchedBy' = ${OWNER}`;
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
  await runWithWorkspace(WS, () => stage(OWNER, SURFACE,
    { [GOAL_PLACEMENT_DELIVERY_KEY]: candidate }, { deliveryToken: 'exact-token' }));
  return { deps, candidate,
    finish: async (phase: 'commentary' | 'final_answer') => {
      await write([...prior, ...native('next', 3, phase)]); now = Date.parse(at(4));
    },
    confirm: async (token: string | null) => {
      const ack = await runWithWorkspace(WS, () => ackAndRead(OWNER, SURFACE, { confirmedToken: token }));
      return confirmGoalPlacementDelivery({ ownerId: OWNER, workspaceId: WS, confirmedToken: token,
        candidate: ack?.committed?.[GOAL_PLACEMENT_DELIVERY_KEY], brief }, deps);
    },
  };
}
async function records() {
  return fx.admin`SELECT owner_id, workspace_id, session_id, harness_slug, tool_use_id, detail
    FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
}

describe('completed eligibility joined on existing activity and cursor stores', () => {
  const planRef = 'plan:papercusp/plan';
  const read = async () => (await readGoalPlacementProgress({ workspaceId: WS, ownerId: OWNER,
    goalId: 'goal', planRefs: [planRef] }))[planRef];
  function proof(n: number) {
    const measured = (minute: number): GoalPlacementAdmissionObservation => ({ version: 1, planRef,
      observedAt: at(minute), planReason: 'ready', governor: 'open', attempts: 'none',
      launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 },
      evidenceRefs: ['fixture:canonical-preflight', 'fixture:governor'] });
    const receipt = { version: 1, goalId: 'goal', planSlug: 'plan', planRef, obligationId: row.id,
      sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision, deliveryToken: `token-${n}`,
      offeredAt: at(n * 2), completedAt: at(n * 2 + 1), confirmedAt: at(n * 2 + 2),
      completedTurnRef: `codex:${OWNER}:request-${n}`, launch: { fleetSlug: 'plan-fleet', requestedSeats: 1 }, admission: measured(n * 2) };
    const end = { version: 1, goalId: 'goal', completedTurnRef: receipt.completedTurnRef,
      completedAt: receipt.completedAt, observedAt: receipt.completedAt, deliveryToken: receipt.deliveryToken,
      rows: [{ planSlug: 'plan', planRef, status: 'due', applicableDemand: 1, actionKind: 'delegate',
        obligationId: row.id, sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision }],
      admissions: [{ planRef, admission: measured(n * 2 + 1) }] };
    const append = async (kind: 'turn' | 'end', value: unknown) => createPgTelemetryStore().append({
      workspaceId: WS, owner: OWNER, agent: 'codex', sessionId: OWNER, scope: 'papercusp',
      kind: 'lifecycle', toolName: null, phase: null, status: 'ok', cwd: null, summary: 'Placement proof fixture',
      toolUseId: kind === 'end' ? `goal-placement-turn-end:${receipt.completedTurnRef}` : `goal-placement:${receipt.deliveryToken}:${row.id}`,
      detail: kind === 'end' ? { goalPlacementTurnEnd: value } : { goalPlacementTurn: value },
    });
    return { receipt, end, append, settle: () => settleGoalPlacementTurn({ ownerId: OWNER, workspaceId: WS,
      nativeSessionId: OWNER, receipt }) };
  }
  it('serializes duplicate ACK reductions and recovers a missed immediate write on a later orientation', async () => {
    const one = proof(1); await one.append('end', one.end); await one.append('turn', one.receipt);
    const outcomes = await Promise.all([one.settle(), one.settle()]);
    expect(outcomes.filter((result) => result.recorded)).toHaveLength(1);
    expect((await read())?.opportunities).toBe(1);
    const two = proof(2); await two.append('end', two.end); await two.append('turn', two.receipt);
    expect(await reconcileConfirmedGoalPlacementTurns({ ownerId: OWNER, workspaceId: WS, goalId: 'goal' })).toBe(1);
    expect(await read()).toMatchObject({ opportunities: 2, stalledAt: two.receipt.completedAt });
    expect(await reconcileConfirmedGoalPlacementTurns({ ownerId: OWNER, workspaceId: WS, goalId: 'goal' })).toBe(0);
  });
  it('cannot upgrade a blocked first observation by replaying a later eligible snapshot', async () => {
    const f = proof(1); f.end.rows[0]!.status = 'blocked';
    await f.append('end', f.end); await f.append('turn', f.receipt);
    expect((await f.settle()).recorded).toBe(true);
    expect((await read())?.opportunities).toBe(0);
    f.end.rows[0]!.status = 'due'; await f.append('end', f.end);
    expect((await f.settle()).recorded).toBe(false);
    expect((await read())?.opportunities).toBe(0);
  });
  it('persists the second repair bound from real qualified repair receipts and survives replay', async () => {
    for (const n of [1, 2, 3, 4]) {
      const f = proof(n);
      if (n > 2) f.end.rows[0]!.actionKind = 'repair';
      await f.append('end', f.end); await f.append('turn', f.receipt);
      expect((await f.settle()).recorded).toBe(true);
    }
    expect(await read()).toMatchObject({ opportunities: 2, repairOpportunities: 2, stalledAt: at(5) });
    expect(await reconcileConfirmedGoalPlacementTurns({ ownerId: OWNER, workspaceId: WS, goalId: 'goal' })).toBe(0);
    expect(await read()).toMatchObject({ repairOpportunities: 2, stalledAt: at(5) });
  });
  it('does not count missing, wrong-token, foreign-session or unknown admission proof', async () => {
    const f = proof(1); await f.append('turn', f.receipt);
    expect((await f.settle()).recorded).toBe(false);
    f.end.deliveryToken = 'wrong'; await f.append('end', f.end);
    expect((await f.settle()).recorded).toBe(false);
    expect((await settleGoalPlacementTurn({ ownerId: OWNER, workspaceId: WS, nativeSessionId: 'other', receipt: f.receipt })).recorded).toBe(false);
    const next = proof(2); next.end.admissions[0]!.admission.governor = 'unknown';
    await next.append('end', next.end); await next.append('turn', next.receipt);
    expect((await next.settle()).recorded).toBe(false);
    expect(await read()).toBeNull();
  });
  it('does not persist debt when the admission was measured for another fleet or seat count', async () => {
    const first = proof(1); first.receipt.admission.launch!.fleetSlug = 'other-fleet';
    await first.append('end', first.end); await first.append('turn', first.receipt);
    const second = proof(2); second.end.admissions[0]!.admission.launch!.requestedSeats = 2;
    await second.append('end', second.end); await second.append('turn', second.receipt);
    expect(await reconcileConfirmedGoalPlacementTurns({ ownerId: OWNER, workspaceId: WS, goalId: 'goal' })).toBe(0);
    expect(await read()).toBeNull();
  });
  it('reads actual scoped governor receipts as interval exclusions, without treating another fleet as a blocker', async () => {
    const f = proof(1);
    const input = { workspaceId: WS, ownerId: OWNER, row: { goalId: 'goal', planSlug: 'plan', planRef,
      obligationId: row.id, sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision,
      launch: { fleetSlug: 'target-fleet', requestedSeats: 1 } },
      window: { offeredAt: f.receipt.offeredAt, completedAt: f.receipt.completedAt } };
    const record = { schemaVersion: 1, namespace: 'agent-process', idempotencyKey: `${OWNER}:attempt`,
      requestFingerprint: 'fixture-fingerprint', admissionClass: 'agent', state: 'cancelled', priority: 0,
      enqueuedAtMs: Date.parse(at(2)), updatedAtMs: Date.parse(at(3)), deadlineAtMs: null,
      decision: { generation: 1, atMs: Date.parse(at(3)), reason: 'not-leaseable', evidence: {} },
      metadata: { launchedBy: OWNER, fleetSlug: 'other-fleet' } };
    const inserted = await fx.admin<Array<{ receipt_id: string }>>`INSERT INTO harness_shared.resource_governor_admissions
      (workspace_id, record) VALUES (${WS}, ${JSON.stringify(record)}::text::jsonb) RETURNING receipt_id`;
    expect(await readGoalPlacementAdmissionAttempts(input, Date.parse(at(4)))).toEqual([]);
    record.metadata.fleetSlug = 'target-fleet';
    await fx.admin`UPDATE harness_shared.resource_governor_admissions SET record = ${JSON.stringify(record)}::text::jsonb
      WHERE workspace_id = ${WS} AND receipt_id = ${inserted[0]!.receipt_id}`;
    expect(await readGoalPlacementAdmissionAttempts(input, Date.parse(at(4)))).toEqual([inserted[0]!.receipt_id]);
  });
});

/** The claim compiler is production code; PG tests below exercise persistence.
 * Canonical fleet/claim writers themselves are covered by the P003 integration. */
function effectPortfolio(minute: number, workItemId: string | null = 'WI-member',
  filter: unknown = { field: 'plan', op: '=', value: 'plan' }): GoalPortfolioBrief {
  const placement = compileGoalPlanPlacement({ plan: { harness: 'papercusp', slug: 'plan', ambiguousMatches: 1 },
    status: 'started', itemStatuses: ['wip'], actionableItemId: 'P-001', now: new Date(at(minute)),
    source: { goalHolderOwnerIds: [OWNER],
      claims: [{ itemId: 'P-001', ownerId: 'su-member', fleetSlug: 'plan-fleet', holderLive: true,
        workItemId, expiresAt: at(minute + 10) }],
      fleet: { slug: 'plan-fleet', controlState: 'active', leaderOwnerId: 'su-leader', leaderLive: true, liveMembers: 2, target: 1,
        claimSpec: { ...DEFAULT_CLAIM_SPEC, view: { filter } },
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
      spentCentsSource: null, interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null, budgetWindowSec: null }, tripwires: [], pending: { blenderIdeas: 0, acceptanceRubric: null },
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
  it('credits the member claim under the sanctioned plan+id widen, never under an id-only spec (D-033)', async () => {
    const idOnly = effectPortfolio(2, 'WI-member', { field: 'id', op: 'in', value: ['WI-member'] });
    expect(idOnly.worklist[0]!.placement.state).toBe('blocked');
    expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: idOnly })).toBe(0);
    expect((await read())['plan:papercusp/plan']).toBeNull();
    const widened = effectPortfolio(3, 'WI-member',
      { any: [{ field: 'plan', op: '=', value: 'plan' }, { field: 'id', op: '=', value: 'WI-standalone' }] });
    expect(widened.worklist[0]!.placement).toMatchObject({ state: 'working', fleet: { planScoped: false, planAdmitted: true } });
    expect(await recordVerifiedGoalPlacementEffects({ ...scope, portfolio: widened })).toBe(1);
    expect((await read())['plan:papercusp/plan']?.lastEffect).toMatchObject({ kind: 'member-claim', at: at(3) });
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

  it('records a mismatched ACK outcome through the operator turn-start endpoint without promoting the candidate', async () => {
    await fixture();
    const routes = (await import('./endpoint-route/routes/agent-mcp/turn-start-memory')).default;
    const endpoint = routes[0] as unknown as { handler: (req: Request) => Promise<Response> };
    const response = await runWithWorkspace(WS, () => endpoint.handler(new Request('http://localhost/agent-mcp/turn-start-memory', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, prompt: '', workspace: WS, harness: 'papercusp',
        memoryEnabled: false, confirmedDelivery: 'wrong-token' }),
    })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await drainDetached();

    const outcomeRows = (await records()).filter((record) =>
      (record.detail.goalPlacementDeliveryOutcome as { token?: string } | undefined)?.token === 'exact-token');
    expect(outcomeRows).toHaveLength(1);
    expect(outcomeRows[0]).toMatchObject({
      owner_id: OWNER, workspace_id: WS, session_id: OWNER,
      tool_use_id: expect.stringMatching(/^goal-placement-delivery-outcome:confirm:exact-token:/),
      detail: { goalPlacementDeliveryOutcome: {
        version: 1, stage: 'confirm', recorded: false, reason: 'confirmation-token-mismatch',
        token: 'exact-token', unavailable: false, candidateReason: null, planSlugs: ['plan'],
      } },
    });

    const cursorRows = await fx.admin<Array<{ workspace_id: string; committed_candidate: { token?: string } | null;
      pending_candidate: { token?: string } | null }>>`
      SELECT workspace_id,
             committed->${GOAL_PLACEMENT_DELIVERY_KEY} AS committed_candidate,
             pending->${GOAL_PLACEMENT_DELIVERY_KEY} AS pending_candidate
        FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${OWNER} AND surface = ${SURFACE}`;
    expect(cursorRows).toHaveLength(1);
    expect(cursorRows[0]!.workspace_id).toBe(WS);
    expect(cursorRows[0]!.committed_candidate?.token).not.toBe('exact-token');
    expect(cursorRows[0]!.pending_candidate?.token).not.toBe('exact-token');
  });
});
