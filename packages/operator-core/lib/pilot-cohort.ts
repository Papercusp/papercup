/**
 * Production runtime for the directed-pair three-arm pilot
 * (`directed-pair-work-items-2026-08-25`, P-007 / D-023 / D-027).
 *
 * P-006 deliberately shipped the pure assignment/statistics instruments first and
 * deferred the database collector until P-007. This module is that missing seam. It
 * reuses the canonical work-item, scorecard, session and usage ledgers; it creates no
 * parallel experiment store.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  asPilotArm,
  assignCohort,
  assignmentPayloadPatch,
  type AssignmentPlan,
  type PilotArm,
  type PilotCandidate,
  type PilotTier,
  verifyAssignments,
} from './pilot-arm-assignment.js';
import { buildPilotReport, type ArmObservation, type PilotReport } from './pilot-metrics.js';
import { listScorecards, type ListScorecardsFilter, type ScorecardRow } from './scorecards.js';
import { getWorkItem, mergeWorkItemPayload, TERMINAL_WORK_ITEM_STATES, type WorkItem } from './work-items.js';

export const DEFAULT_PILOT_RUBRIC = 'directed-pair-pilot-item-quality';
export const DEFAULT_ARM_B_PROBE_ITEM = 'WI-41764';

export type PilotParticipantRole = 'solo' | 'director' | 'implementer';

/**
 * Attribution is explicit rather than inferred. A coord owner can have several
 * sessions, and a session can perform several work items; the session + item window
 * is the smallest stable key the existing usage ledger can answer exactly.
 */
export interface PilotParticipantBinding {
  ownerId: string;
  sessionId: string;
  role: PilotParticipantRole;
  windowStartMs: number;
}

export interface PilotAssignmentCandidate {
  id: string;
  tier: PilotTier;
  stratum?: string;
  participants?: readonly PilotParticipantBinding[];
}

export interface PilotStamp {
  arm: PilotArm;
  seed: string;
  stratum: string;
  blockIndex: number;
  partialBlock: boolean;
  assignedAtMs: number;
  participants: readonly PilotParticipantBinding[];
}

export const PILOT_STAMP_KEYS = [
  'pilotArm',
  'pilotSeed',
  'pilotStratum',
  'pilotBlockIndex',
  'pilotPartialBlock',
  'pilotAssignedAtMs',
  'pilotParticipants',
] as const;

export interface ArmBGateProbeProof {
  status: 'passed';
  testedSha: string;
  deployedSha: string;
  judgementPersisted: true;
}

export interface PilotGap {
  itemId: string;
  code:
    | 'missing-item'
    | 'not-terminal'
    | 'missing-stamp'
    | 'invalid-participants'
    | 'invalid-window'
    | 'missing-scorecard'
    | 'non-independent-scorecard'
    | 'incomplete-scorecard'
    | 'missing-cost'
    | 'mixed-seed'
    | 'assignment-mismatch';
  detail: string;
}

export interface ParticipantCost {
  key: string;
  sampleCount: number;
  unpricedCount: number;
  costUsd: number | null;
}

export interface PilotCollectedItem {
  itemId: string;
  arm: PilotArm;
  scorecardId: string;
  grader: string;
  participantCosts: readonly ParticipantCost[];
  observation: ArmObservation;
}

export interface PilotCollectionResult {
  ok: true;
  complete: boolean;
  rubricRef: string;
  itemCount: number;
  observationCount: number;
  assignmentVerification: {
    seed: string | null;
    ok: boolean;
    mismatches: readonly { id: string; recorded: string; expected: PilotArm }[];
    unverifiable: readonly string[];
  };
  items: PilotCollectedItem[];
  observations: ArmObservation[];
  gaps: PilotGap[];
  report: PilotReport;
}

export type PilotCohortDeps = {
  getWorkItem: typeof getWorkItem;
  mergeWorkItemPayload: typeof mergeWorkItemPayload;
  listScorecards: (filter: ListScorecardsFilter) => Promise<ScorecardRow[]>;
  readUsageCosts: (workspaceId: string, windows: readonly UsageWindow[]) => Promise<Map<string, ParticipantCost>>;
  nowMs: () => number;
};

const DEFAULT_DEPS: PilotCohortDeps = {
  getWorkItem,
  mergeWorkItemPayload,
  listScorecards,
  readUsageCosts: readPilotUsageCosts,
  nowMs: Date.now,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function readParticipants(value: unknown): PilotParticipantBinding[] | null {
  if (!Array.isArray(value)) return null;
  const out: PilotParticipantBinding[] = [];
  for (const entry of value) {
    const row = record(entry);
    const ownerId = typeof row?.ownerId === 'string' ? row.ownerId.trim() : '';
    const sessionId = typeof row?.sessionId === 'string' ? row.sessionId.trim() : '';
    const role = row?.role;
    const windowStartMs = finiteNumber(row?.windowStartMs);
    if (
      !ownerId ||
      !sessionId ||
      (role !== 'solo' && role !== 'director' && role !== 'implementer') ||
      windowStartMs === null ||
      windowStartMs <= 0
    ) {
      return null;
    }
    out.push({ ownerId, sessionId, role, windowStartMs });
  }
  return out;
}

export function readPilotStamp(payload: unknown): PilotStamp | null {
  const p = record(payload);
  if (!p) return null;
  const arm = asPilotArm(typeof p.pilotArm === 'string' ? p.pilotArm : undefined);
  const seed = typeof p.pilotSeed === 'string' ? p.pilotSeed.trim() : '';
  const stratum = typeof p.pilotStratum === 'string' ? p.pilotStratum.trim() : '';
  const blockIndex = finiteNumber(p.pilotBlockIndex);
  const assignedAtMs = finiteNumber(p.pilotAssignedAtMs);
  const participants = readParticipants(p.pilotParticipants);
  if (
    !arm ||
    !seed ||
    !stratum ||
    blockIndex === null ||
    blockIndex < 0 ||
    !Number.isInteger(blockIndex) ||
    assignedAtMs === null ||
    assignedAtMs <= 0 ||
    participants === null
  ) {
    return null;
  }
  return {
    arm,
    seed,
    stratum,
    blockIndex,
    partialBlock: p.pilotPartialBlock === true,
    assignedAtMs,
    participants,
  };
}

function terminal(item: WorkItem): boolean {
  return TERMINAL_WORK_ITEM_STATES.includes(item.state);
}

/**
 * The probe's structured output is written by work_items:complete under payload.out.
 * Requiring tested===deployed closes the stale-process loophole: a local passing test
 * against staging is not proof that the live completion verb ran the gate.
 */
export function readArmBGateProbeProof(item: WorkItem | null): ArmBGateProbeProof | null {
  if (!item || !terminal(item)) return null;
  const out = record(record(item.payload)?.out);
  const proof = record(out?.pilotArmBGateProbe);
  const testedSha = typeof proof?.testedSha === 'string' ? proof.testedSha.trim() : '';
  const deployedSha = typeof proof?.deployedSha === 'string' ? proof.deployedSha.trim() : '';
  if (proof?.status !== 'passed' || proof.judgementPersisted !== true || !testedSha || testedSha !== deployedSha) {
    return null;
  }
  return { status: 'passed', testedSha, deployedSha, judgementPersisted: true };
}

function participantsFitArm(arm: PilotArm, participants: readonly PilotParticipantBinding[]): boolean {
  if (arm === 'A' || arm === 'B') {
    return participants.length === 1 && participants[0]?.role === 'solo';
  }
  if (participants.length !== 2) return false;
  const roles = participants.map((p) => p.role).sort();
  return roles[0] === 'director' && roles[1] === 'implementer';
}

export interface MaterializePilotInput {
  seed: string;
  candidates: readonly PilotAssignmentCandidate[];
  harness?: string;
  probeItemId?: string;
  confirm?: boolean;
}

export interface MaterializePilotResult {
  ok: boolean;
  committed: boolean;
  plan: AssignmentPlan;
  applied: string[];
  rolledBack: string[];
  proof?: ArmBGateProbeProof;
  error?: string;
}

/**
 * Preview or materialize one cohort. The write path is fail-closed on participant
 * attribution and arm-B live proof, then verifies the persisted assignment. A failed
 * multi-row write removes only the pilot keys it just added, so a cohort never remains
 * silently half-stamped.
 */
export async function materializePilotCohort(
  input: MaterializePilotInput,
  deps: PilotCohortDeps = DEFAULT_DEPS,
): Promise<MaterializePilotResult> {
  const seed = input.seed.trim();
  if (!seed) throw new Error('pilot seed must be non-empty');
  const ids = input.candidates.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('pilot candidates contain duplicate ids');

  const rows = await Promise.all(ids.map((id) => deps.getWorkItem(id, input.harness)));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length) throw new Error(`pilot candidates not found: ${missing.join(', ')}`);

  const candidates: PilotCandidate[] = input.candidates.map((candidate, i) => ({
    id: candidate.id,
    tier: candidate.tier,
    ...(candidate.stratum ? { stratum: candidate.stratum } : {}),
    payload: rows[i]!.payload,
  }));
  const plan = assignCohort(candidates, seed);
  if (!input.confirm) return { ok: true, committed: false, plan, applied: [], rolledBack: [] };

  const invalidSkips = plan.skipped.filter((s) => s.reason !== 'already-assigned');
  if (invalidSkips.length) {
    return {
      ok: false,
      committed: false,
      plan,
      applied: [],
      rolledBack: [],
      error: `refusing materialization: ${invalidSkips.map((s) => `${s.id}:${s.reason}`).join(', ')}`,
    };
  }

  let proof: ArmBGateProbeProof | undefined;
  if (plan.assignments.some((a) => a.arm === 'B')) {
    const probe = await deps.getWorkItem(input.probeItemId ?? DEFAULT_ARM_B_PROBE_ITEM, input.harness);
    proof = readArmBGateProbeProof(probe) ?? undefined;
    if (!proof) {
      return {
        ok: false,
        committed: false,
        plan,
        applied: [],
        rolledBack: [],
        error:
          `arm B is present but ${input.probeItemId ?? DEFAULT_ARM_B_PROBE_ITEM} lacks a terminal ` +
          `payload.out.pilotArmBGateProbe pass with testedSha=deployedSha and judgementPersisted=true`,
      };
    }
  }

  const candidateById = new Map(input.candidates.map((c) => [c.id, c]));
  for (const assignment of plan.assignments) {
    const participants = candidateById.get(assignment.id)?.participants ?? [];
    if (!participantsFitArm(assignment.arm, participants)) {
      return {
        ok: false,
        committed: false,
        plan,
        applied: [],
        rolledBack: [],
        ...(proof ? { proof } : {}),
        error:
          `${assignment.id} arm ${assignment.arm} has invalid participant bindings; ` +
          `A/B require one solo session, C requires one director plus one implementer`,
      };
    }
  }

  const assignedAtMs = deps.nowMs();
  const applied: string[] = [];
  const rolledBack: string[] = [];
  try {
    for (const assignment of plan.assignments) {
      const spec = candidateById.get(assignment.id)!;
      const participants = spec.participants!.map((participant) => ({ ...participant }));
      const patch = {
        ...assignmentPayloadPatch(assignment, seed),
        pilotPartialBlock: assignment.partialBlock,
        pilotAssignedAtMs: assignedAtMs,
        pilotParticipants: participants,
      };
      const updated = await deps.mergeWorkItemPayload(assignment.id, patch, { harness: input.harness });
      if (!updated) throw new Error(`work item ${assignment.id} disappeared during materialization`);
      applied.push(assignment.id);
    }

    const persisted = await Promise.all(ids.map((id) => deps.getWorkItem(id, input.harness)));
    const verification = verifyAssignments(
      input.candidates.map((candidate, i) => ({
        id: candidate.id,
        tier: candidate.tier,
        ...(candidate.stratum ? { stratum: candidate.stratum } : {}),
        payload: persisted[i]?.payload,
      })),
      seed,
    );
    if (!verification.ok || verification.unverifiable.length) {
      throw new Error(
        `persisted assignment verification failed: mismatches=${verification.mismatches.length}, ` +
          `unverifiable=${verification.unverifiable.join(',') || 'none'}`,
      );
    }
    return {
      ok: true,
      committed: true,
      plan,
      applied,
      rolledBack,
      ...(proof ? { proof } : {}),
    };
  } catch (error) {
    for (const id of applied) {
      try {
        const reverted = await deps.mergeWorkItemPayload(
          id,
          {},
          {
            harness: input.harness,
            unset: PILOT_STAMP_KEYS,
          },
        );
        if (reverted) rolledBack.push(id);
      } catch {
        // Report the incomplete rollback below; never hide the original failure.
      }
    }
    return {
      ok: false,
      committed: false,
      plan,
      applied,
      rolledBack,
      ...(proof ? { proof } : {}),
      error:
        `${error instanceof Error ? error.message : String(error)}; ` +
        `rollback ${rolledBack.length === applied.length ? 'complete' : `INCOMPLETE (${rolledBack.length}/${applied.length})`}`,
    };
  }
}

export interface UsageWindow {
  key: string;
  sessionId: string;
  startMs: number;
  endMs: number;
}

/** One indexed query for every participant window; no N-per-item usage reads. */
export async function readPilotUsageCosts(
  workspaceId: string,
  windows: readonly UsageWindow[],
): Promise<Map<string, ParticipantCost>> {
  if (!windows.length) return new Map();
  const { sql } = getOrgPg();
  const encoded = JSON.stringify(
    windows.map((window) => ({
      key: window.key,
      session_id: window.sessionId,
      start_ms: window.startMs,
      end_ms: window.endMs,
    })),
  );
  const rows = await sql<
    Array<{
      key: string;
      sample_count: number | string;
      unpriced_count: number | string;
      cost_usd: number | string;
    }>
  >`
    WITH windows AS (
      SELECT *
        FROM jsonb_to_recordset(${encoded}::text::jsonb)
          AS w(key text, session_id text, start_ms bigint, end_ms bigint)
    )
    SELECT w.key,
           COUNT(u.id)::int AS sample_count,
           COUNT(*) FILTER (WHERE u.id IS NOT NULL AND u.cost_usd IS NULL)::int AS unpriced_count,
           COALESCE(SUM(u.cost_usd), 0)::float8 AS cost_usd
      FROM windows w
      LEFT JOIN harness_shared.agent_usage_samples u
        ON u.workspace_id = ${workspaceId}
       AND u.session_id = w.session_id
       AND u.ts >= w.start_ms
       AND u.ts <= w.end_ms
     GROUP BY w.key`;

  return new Map(
    rows.map((row) => {
      const sampleCount = Number(row.sample_count);
      const unpricedCount = Number(row.unpriced_count);
      const cost = Number(row.cost_usd);
      return [
        row.key,
        {
          key: row.key,
          sampleCount,
          unpricedCount,
          costUsd: sampleCount > 0 && unpricedCount === 0 && Number.isFinite(cost) ? cost : null,
        },
      ];
    }),
  );
}

function reopenAfter(payload: unknown, startMs: number): boolean {
  const entries = record(payload)?.reopenHistory;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const at = record(entry)?.at;
    const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isFinite(atMs) && atMs >= startMs;
  });
}

function scorecardIssue(card: ScorecardRow, participantOwners: ReadonlySet<string>): string | null {
  if (!card.rubricResolved || card.missingKeys.length || card.extraKeys.length || card.score10 === null) {
    return 'scorecard is incomplete, unresolved, or has no numeric projection';
  }
  if (card.provisional) return 'scorecard is provisional';
  const auditState = (card.gradingAudit as { state?: unknown } | undefined)?.state;
  if (auditState === 'pending' || auditState === 'failed') return `scorecard grading audit is ${auditState}`;
  if (!card.createdBy) return 'scorecard has no recorded grader identity';
  if (participantOwners.has(card.createdBy)) return 'scorecard grader participated in the item';
  return null;
}

export async function collectPilotCohort(
  input: {
    workspaceId: string;
    itemIds: readonly string[];
    harness?: string;
    rubricRef?: string;
  },
  deps: PilotCohortDeps = DEFAULT_DEPS,
): Promise<PilotCollectionResult> {
  const rubricRef = input.rubricRef ?? DEFAULT_PILOT_RUBRIC;
  const ids = [...new Set(input.itemIds)];
  const rows = await Promise.all(ids.map((id) => deps.getWorkItem(id, input.harness)));
  const gaps: PilotGap[] = [];
  const valid: Array<{ item: WorkItem; stamp: PilotStamp; closedAtMs: number }> = [];

  for (let i = 0; i < ids.length; i++) {
    const item = rows[i];
    if (!item) {
      gaps.push({ itemId: ids[i]!, code: 'missing-item', detail: 'work item was not found' });
      continue;
    }
    if (!terminal(item) || !item.closedAt) {
      gaps.push({ itemId: item.id, code: 'not-terminal', detail: `state=${item.state}; closedAt is required` });
      continue;
    }
    const stamp = readPilotStamp(item.payload);
    if (!stamp) {
      gaps.push({
        itemId: item.id,
        code: 'missing-stamp',
        detail: 'pilot assignment/participant stamp is absent or malformed',
      });
      continue;
    }
    if (!participantsFitArm(stamp.arm, stamp.participants)) {
      gaps.push({
        itemId: item.id,
        code: 'invalid-participants',
        detail: `participant roles do not fit arm ${stamp.arm}`,
      });
      continue;
    }
    const closedAtMs = Date.parse(item.closedAt);
    if (!Number.isFinite(closedAtMs) || stamp.participants.some((p) => p.windowStartMs >= closedAtMs)) {
      gaps.push({
        itemId: item.id,
        code: 'invalid-window',
        detail: 'participant claim window does not end after it starts',
      });
      continue;
    }
    valid.push({ item, stamp, closedAtMs });
  }

  const sinceMs = valid.length ? Math.min(...valid.map((v) => v.stamp.assignedAtMs)) : null;
  const cards = await deps.listScorecards({
    rubricRef,
    ...(sinceMs !== null ? { since: new Date(sinceMs).toISOString() } : {}),
    limit: 500,
  });
  const cardsByItem = new Map<string, ScorecardRow[]>();
  for (const card of cards) {
    const ref = card.subject?.ref;
    if (!ref) continue;
    const bucket = cardsByItem.get(ref);
    if (bucket) bucket.push(card);
    else cardsByItem.set(ref, [card]);
  }

  const windows: UsageWindow[] = [];
  for (const { item, stamp, closedAtMs } of valid) {
    stamp.participants.forEach((participant, index) => {
      windows.push({
        key: `${item.id}:${index}:${participant.sessionId}`,
        sessionId: participant.sessionId,
        startMs: participant.windowStartMs,
        endMs: closedAtMs,
      });
    });
  }
  const costs = await deps.readUsageCosts(input.workspaceId, windows);
  const items: PilotCollectedItem[] = [];

  for (const { item, stamp, closedAtMs } of valid) {
    const owners = new Set(stamp.participants.map((p) => p.ownerId));
    const candidates = (cardsByItem.get(item.id) ?? []).filter(
      (card) => Date.parse(card.createdAt) >= stamp.assignedAtMs,
    );
    const card = candidates.find((candidate) => scorecardIssue(candidate, owners) === null);
    if (!card) {
      const participantCard = candidates.find((candidate) =>
        candidate.createdBy ? owners.has(candidate.createdBy) : false,
      );
      gaps.push({
        itemId: item.id,
        code: participantCard
          ? 'non-independent-scorecard'
          : candidates.length
            ? 'incomplete-scorecard'
            : 'missing-scorecard',
        detail: participantCard
          ? `scorecard ${participantCard.issueId} was emitted by participant ${participantCard.createdBy}`
          : candidates.length
            ? candidates.map((candidate) => `${candidate.issueId}: ${scorecardIssue(candidate, owners)}`).join('; ')
            : `no ${rubricRef} scorecard with subject.ref=${item.id} exists after assignment`,
      });
      continue;
    }

    const participantCosts = stamp.participants.map((participant, index) => {
      const key = `${item.id}:${index}:${participant.sessionId}`;
      return costs.get(key) ?? { key, sampleCount: 0, unpricedCount: 0, costUsd: null };
    });
    if (participantCosts.some((cost) => cost.costUsd === null)) {
      gaps.push({
        itemId: item.id,
        code: 'missing-cost',
        detail: participantCosts
          .filter((cost) => cost.costUsd === null)
          .map((cost) => `${cost.key} samples=${cost.sampleCount} unpriced=${cost.unpricedCount}`)
          .join('; '),
      });
      continue;
    }

    const startMs = Math.min(...stamp.participants.map((participant) => participant.windowStartMs));
    const observation: ArmObservation = {
      itemId: item.id,
      arm: stamp.arm,
      score: card.score10!,
      wallClockMs: closedAtMs - startMs,
      agentCostsUsd: participantCosts.map((cost) => cost.costUsd!),
      reopened: reopenAfter(item.payload, startMs),
      authorityProposed: item.completionAuthority === 'proposed',
    };
    items.push({
      itemId: item.id,
      arm: stamp.arm,
      scorecardId: card.issueId,
      grader: card.createdBy!,
      participantCosts,
      observation,
    });
  }

  const seeds = new Set(valid.map((v) => v.stamp.seed));
  let assignmentVerification: PilotCollectionResult['assignmentVerification'] = {
    seed: seeds.size === 1 ? [...seeds][0]! : null,
    ok: false,
    mismatches: [],
    unverifiable: [],
  };
  if (seeds.size !== 1) {
    gaps.push({
      itemId: '*',
      code: 'mixed-seed',
      detail: `expected one seed, found ${[...seeds].join(', ') || 'none'}`,
    });
  } else {
    const seed = [...seeds][0]!;
    const verification = verifyAssignments(
      valid.map(({ item, stamp }) => ({
        id: item.id,
        tier: 'substantive',
        stratum: stamp.stratum,
        payload: item.payload,
      })),
      seed,
    );
    assignmentVerification = { seed, ...verification };
    if (!verification.ok || verification.unverifiable.length) {
      gaps.push({
        itemId: '*',
        code: 'assignment-mismatch',
        detail: `mismatches=${verification.mismatches.length}; unverifiable=${verification.unverifiable.join(',') || 'none'}`,
      });
    }
  }

  const observations = items.map((item) => item.observation);
  return {
    ok: true,
    complete: gaps.length === 0 && observations.length === ids.length,
    rubricRef,
    itemCount: ids.length,
    observationCount: observations.length,
    assignmentVerification,
    items,
    observations,
    gaps,
    report: buildPilotReport(observations),
  };
}
