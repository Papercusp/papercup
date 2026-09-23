/** Exact goal-plan exposure + native final-turn receipts, on existing stores. */
import { z } from 'zod';
import { formatAgentObligationLine } from './agent-obligations';
import type { AgentObligationBrief, AgentObligationAgendaRead } from './agent-obligation-reader';
import type { TranscriptTailTurn } from './turn-journal';
import type { SelfSession } from './search/self-session';
import type { ActivityRecord } from '@papercusp/activity-bridge';

export const GOAL_PLACEMENT_DELIVERY_KEY = 'goalPlacementDeliveryV1';
const nonempty = z.string().trim().min(1).max(1000);
const rowSchema = z.object({
  goalId: nonempty, planSlug: nonempty, planRef: z.string().regex(/^plan:[^/\s]+\/\S+$/),
  obligationId: nonempty, sourceGeneration: nonempty, ruleRevision: nonempty,
}).strict();
export const goalPlacementDeliverySchema = z.object({
  version: z.literal(1), ownerId: nonempty, workspaceId: nonempty, token: nonempty,
  offeredAt: z.string().datetime({ offset: true }), nativeSessionId: nonempty,
  sourceKind: z.enum(['claude', 'codex', 'omp']), baselineTurnRef: nonempty.nullable(),
  rows: z.array(rowSchema).min(1).max(3),
}).strict();
export type GoalPlacementDelivery = z.infer<typeof goalPlacementDeliverySchema>;

/** A delayed journal must not relabel today's state as an old turn's state. */
export const GOAL_PLACEMENT_TURN_END_MAX_LAG_MS = 60_000;
export interface GoalPlacementTurnEndDeps extends Pick<GoalPlacementTurnReceiptDeps, 'current' | 'tail' | 'append' | 'now'> {
  agenda: (ownerId: string, workspaceId: string) => Promise<AgentObligationAgendaRead>;
}

export interface GoalPlacementTurnReceiptDeps {
  current: (ownerId: string) => Promise<SelfSession | null>;
  lookup: (ownerId: string, sessionId: string) => Promise<SelfSession | null>;
  tail: (session: SelfSession) => Promise<TranscriptTailTurn[]>;
  append: (record: ActivityRecord) => Promise<unknown>;
  now: () => number;
}
const defaults: GoalPlacementTurnReceiptDeps = {
  current: async (ownerId) => (await import('./search/self-session')).resolveSelfSession(ownerId),
  lookup: async (ownerId, sessionId) => {
    const resolver = await import('./search/self-session');
    const current = await resolver.resolveSelfSession(ownerId);
    return current?.sessionId === sessionId ? current : resolver.resolveOwnerIsolatedSessionByPrefix(ownerId, sessionId);
  },
  tail: async (session) => (await import('./turn-journal')).readVerbatimTail(session.filePath, session.sourceKind, 50),
  append: async (record) => (await import('./activity-pg-store')).createPgTelemetryStore().append(record),
  now: Date.now,
};

function completedRef(session: SelfSession, turn: TranscriptTailTurn): string | null {
  if (turn.speaker !== 'assistant' || turn.responseDisposition !== 'delivered' ||
    !turn.requestId || !turn.ts || !Number.isFinite(turn.ts.getTime())) return null;
  return `${session.sourceKind}:${session.sessionId}:${turn.requestId}`;
}

function latestCompletedDecision(session: SelfSession, turns: TranscriptTailTurn[]): TranscriptTailTurn | null {
  // A newer user request or progress response is a LIVE call, not completion
  // of the last delivered response still visible earlier in the tail.
  const latest = turns[turns.length - 1];
  return latest && completedRef(session, latest) ? latest : null;
}

/** Sample policy at the native turn-end seam, independently of the next-turn ACK.
 * This is descriptive policy evidence, not a grade or a delivery receipt. Its
 * observedAt remains explicit; a later replay cannot masquerade as timely proof. */
export async function recordGoalPlacementTurnEnd(input: {
  ownerId: string; workspaceId: string; nativeSessionId: string; sourceKind: SelfSession['sourceKind'];
}, deps: GoalPlacementTurnEndDeps = { ...defaults,
  agenda: async (ownerId, workspaceId) => (await import('./agent-obligation-reader')).readAgentObligationAgenda({ ownerId, workspaceId }),
}): Promise<{ recorded: boolean; reason: string }> {
  const session = await deps.current(input.ownerId);
  if (!session || session.sessionId !== input.nativeSessionId || session.sourceKind !== input.sourceKind) {
    return { recorded: false, reason: 'native-session-mismatch' };
  }
  const completed = latestCompletedDecision(session, await deps.tail(session));
  if (!completed) return { recorded: false, reason: 'native-decision-not-complete' };
  const endedAt = completed.ts!.getTime();
  const timely = (now: number) => Number.isFinite(now) && now >= endedAt && now - endedAt <= GOAL_PLACEMENT_TURN_END_MAX_LAG_MS;
  if (!timely(deps.now())) return { recorded: false, reason: 'turn-end-observation-stale' };
  const read = await deps.agenda(input.ownerId, input.workspaceId);
  if (!read.goalId) return { recorded: false, reason: 'no-canonical-goal' };
  const observedAt = Date.parse(read.observedAt);
  if (!timely(observedAt) || !timely(deps.now()) || observedAt > deps.now()) {
    return { recorded: false, reason: 'turn-end-observation-stale' };
  }
  const again = latestCompletedDecision(session, await deps.tail(session));
  if (!again || completedRef(session, again) !== completedRef(session, completed)) {
    return { recorded: false, reason: 'native-decision-advanced-during-observation' };
  }
  const rows = read.agenda.evaluations.filter((row) => row.family === 'plan-placement' &&
    row.scope.ownerId === input.ownerId && row.scope.workspaceId === input.workspaceId && row.scope.goalId === read.goalId)
    .map((row) => ({ planSlug: row.scope.planSlug ?? null,
      planRef: row.action?.targetRef?.startsWith('plan:') ? row.action.targetRef : null,
      status: row.status, applicableDemand: row.applicableDemand, actionKind: row.action?.kind ?? null,
      obligationId: row.id, sourceGeneration: row.sourceGeneration, ruleRevision: row.ruleRevision }));
  if (!rows.length) return { recorded: false, reason: 'placement-policy-unmeasured' };
  await deps.append({ workspaceId: input.workspaceId, owner: input.ownerId, agent: session.sourceKind,
    sessionId: session.sessionId, scope: read.portfolio?.worklist[0]?.harness ?? null,
    kind: 'lifecycle', toolName: null, phase: null, toolUseId: `goal-placement-turn-end:${completedRef(session, completed)}`,
    summary: 'Goal placement policy observed at native turn end', status: 'ok', cwd: null,
    detail: { goalPlacementTurnEnd: { version: 1, goalId: read.goalId,
      completedTurnRef: completedRef(session, completed), completedAt: completed.ts!.toISOString(),
      observedAt: read.observedAt, rows } },
  });
  return { recorded: true, reason: 'turn-end-policy-recorded-not-yet-graded' };
}

/** Fail-soft bounded extension of the existing journal hook. No new Stop hook,
 * local token file, model call or background routine is introduced. */
export async function boundedRecordGoalPlacementTurnEnd(input: Parameters<typeof recordGoalPlacementTurnEnd>[0]) {
  const [{ withBoundedTimeout }, { trackDetached }] = await Promise.all([
    import('./bounded-timeout'), import('./detached-imports'),
  ]);
  return (await withBoundedTimeout(trackDetached(recordGoalPlacementTurnEnd(input)), {
    timeoutMs: 1000, label: 'goal-placement-turn-end', fallback: { recorded: false, reason: 'turn-end-read-unavailable' },
  })).value;
}

/** Only whole, actually rendered actionable rows may become receipt candidates. */
export function deliveredGoalPlacementRows(input: {
  ownerId: string; workspaceId: string; brief: AgentObligationBrief | null | undefined; block: string;
}): GoalPlacementDelivery['rows'] {
  return (input.brief?.projection.entries ?? []).flatMap((row) => {
    if (row.family !== 'plan-placement' || row.status !== 'due' || row.applicableDemand <= 0 ||
      row.scope.ownerId !== input.ownerId || row.scope.workspaceId !== input.workspaceId ||
      !row.scope.goalId || !row.scope.planSlug || !row.action ||
      !['delegate', 'continue', 'repair'].includes(row.action.kind) ||
      !input.block.includes(formatAgentObligationLine(row, 'action'))) return [];
    const parsed = rowSchema.safeParse({ goalId: row.scope.goalId, planSlug: row.scope.planSlug,
      planRef: row.action.targetRef, obligationId: row.id, sourceGeneration: row.sourceGeneration,
      ruleRevision: row.ruleRevision });
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 3);
}

export async function prepareGoalPlacementDelivery(input: {
  ownerId: string; workspaceId: string; token: string;
  brief: AgentObligationBrief | null | undefined; block: string;
}, deps: GoalPlacementTurnReceiptDeps = defaults): Promise<GoalPlacementDelivery | null> {
  const rows = deliveredGoalPlacementRows(input);
  if (!rows.length) return null;
  const session = await deps.current(input.ownerId);
  if (!session) return null;
  const turns = await deps.tail(session);
  const baseline = [...turns].reverse().find((turn) => completedRef(session, turn) !== null);
  // Without a retained baseline, a truncated tail cannot prove this is the
  // first decision of a session. Missing evidence is not zero prior decisions.
  if (!baseline && turns.some((turn) => turn.requestHistoryStatus === 'truncated')) return null;
  const now = deps.now();
  if (!Number.isFinite(now) || (baseline?.ts && baseline.ts.getTime() > now)) return null;
  return goalPlacementDeliverySchema.parse({ version: 1, ownerId: input.ownerId,
    workspaceId: input.workspaceId, token: input.token, offeredAt: new Date(now).toISOString(),
    nativeSessionId: session.sessionId, sourceKind: session.sourceKind,
    baselineTurnRef: baseline ? completedRef(session, baseline) : null, rows });
}

/**
 * Record evidence, NOT an eligible-opportunity count or an agent grade. Later
 * progress readers must still join canonical effects and typed exclusions.
 * The current observation is named "at confirmation", never backdated to
 * the native completion timestamp.
 */
export async function confirmGoalPlacementDelivery(input: {
  ownerId: string; workspaceId: string; confirmedToken: string | null | undefined;
  candidate: unknown; brief: AgentObligationBrief | null | undefined;
}, deps: GoalPlacementTurnReceiptDeps = defaults): Promise<{ recorded: number; reason: string }> {
  const parsed = goalPlacementDeliverySchema.safeParse(input.candidate);
  if (!parsed.success || !input.confirmedToken) return { recorded: 0, reason: 'no-exact-proof-candidate' };
  const candidate = parsed.data;
  if (candidate.ownerId !== input.ownerId || candidate.workspaceId !== input.workspaceId ||
    candidate.token !== input.confirmedToken) return { recorded: 0, reason: 'scope-or-token-mismatch' };
  const session = await deps.lookup(input.ownerId, candidate.nativeSessionId);
  if (!session || session.sessionId !== candidate.nativeSessionId || session.sourceKind !== candidate.sourceKind) {
    return { recorded: 0, reason: 'native-session-unavailable' };
  }
  const turns = await deps.tail(session);
  let baseline = -1;
  if (candidate.baselineTurnRef !== null) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (completedRef(session, turns[index]!) === candidate.baselineTurnRef) {
        baseline = index;
        break;
      }
    }
  }
  if ((candidate.baselineTurnRef !== null && baseline < 0) ||
    (candidate.baselineTurnRef === null && turns.some((turn) => turn.requestHistoryStatus === 'truncated'))) {
    return { recorded: 0, reason: 'native-window-incomplete' };
  }
  const now = deps.now();
  const completed = turns.slice(baseline + 1).find((turn) => {
    const ref = completedRef(session, turn);
    return ref !== null && ref !== candidate.baselineTurnRef && turn.ts!.getTime() >= Date.parse(candidate.offeredAt)
      && turn.ts!.getTime() <= now;
  });
  if (!completed) return { recorded: 0, reason: 'no-completed-native-decision' };
  let recorded = 0;
  for (const row of candidate.rows) {
    const current = input.brief?.evaluations.find((entry) => entry.family === 'plan-placement' &&
      entry.scope.ownerId === input.ownerId && entry.scope.workspaceId === input.workspaceId &&
      entry.scope.goalId === row.goalId && entry.scope.planSlug === row.planSlug);
    await deps.append({ workspaceId: input.workspaceId, owner: input.ownerId, agent: session.sourceKind,
      sessionId: session.sessionId, scope: row.planRef.slice(5).split('/')[0]!, kind: 'lifecycle',
      toolName: null, phase: null, toolUseId: `goal-placement:${candidate.token}:${row.obligationId}`,
      summary: 'Confirmed goal-plan delivery with a native completed decision', status: 'ok', cwd: null,
      detail: { goalPlacementTurn: { version: 1, ...row, deliveryToken: candidate.token,
        offeredAt: candidate.offeredAt, completedAt: completed.ts!.toISOString(),
        completedTurnRef: completedRef(session, completed), confirmedAt: new Date(now).toISOString(),
        atConfirmation: current ? { status: current.status, obligationId: current.id,
          sourceGeneration: current.sourceGeneration, ruleRevision: current.ruleRevision } : null,
      } },
    });
    recorded += 1;
  }
  return { recorded, reason: 'native-decision-recorded-not-yet-graded' };
}
