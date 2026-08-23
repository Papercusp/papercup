import {
  resolveEffectiveStatusForItems,
  type ItemStatus,
  type PlanItem,
} from '@papercusp/plan-parser';

const TERMINAL_STATUSES = new Set<ItemStatus>(['done', 'dropped']);

const RELEASE_GATE_RE =
  /\b(?:alpha|beta|distribution|general availability|go[- ]?live|launch|publish|release|rollout|ship(?:ping)?|production)\b/i;
const FOUNDATION_BUILD_RE =
  /\b(?:adapter|api|backend|build|core|database|foundation(?:al)?|frontend|implement(?:ation)?|infrastructure|provider|provision|scaffold|schema|storage)\b/i;

export interface PlanDagBlockingEdge {
  itemId: string;
  blockerId: string;
  itemPhase: string | null;
  blockerPhase: string | null;
  blockerStatus: ItemStatus | 'missing';
}

export interface PlanDagFanInChokepoint {
  itemId: string;
  blockerIds: string[];
}

export interface PlanDagPhaseInversion {
  itemId: string;
  itemPhase: string;
  blockerId: string;
  blockerPhase: string;
}

export interface PlanDagReleaseGateBlock {
  itemId: string;
  itemPhase: string | null;
  blockerId: string;
  blockerPhase: string | null;
}

export type PlanDagNonReadyReason =
  | 'cycle'
  | 'dangling'
  | 'dependency'
  | 'needs-human'
  | 'sticky-blocked'
  | 'in-progress'
  | 'non-actionable-status';

export interface PlanDagNonReadyItem {
  itemId: string;
  effectiveStatus: ItemStatus;
  reason: PlanDagNonReadyReason;
  blockerIds: string[];
}

export interface PlanDagParallelismDiagnostics {
  nonTerminal: number;
  nonTerminalItemIds: string[];
  readyWidth: number;
  readyItemIds: string[];
  criticalPathDepth: number;
  criticalPathItemIds: string[];
  blockingEdges: PlanDagBlockingEdge[];
  nonReadyItems: PlanDagNonReadyItem[];
  fanInChokepoints: PlanDagFanInChokepoint[];
  phaseInversions: PlanDagPhaseInversion[];
  releaseGateBlocksBuild: PlanDagReleaseGateBlock[];
}

function phaseOrdinal(phase: string | null): number | null {
  if (!phase) return null;
  const match = /^Phase\s+(\d+)\b/i.exec(phase.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function itemSearchText(item: PlanItem): string {
  return `${item.phase ?? ''} ${item.text}`;
}

/**
 * Pure, snapshot-local analysis of the remaining plan DAG.
 *
 * `readyWidth` deliberately uses the same actionable definition as exact-plan
 * admission: a todo item with no unresolved blocker and no needs-human gate.
 * `criticalPathDepth` counts only non-terminal items, so completed setup does
 * not keep making a mature plan look artificially deep.
 */
export function analyzePlanDagParallelism(planItems: readonly PlanItem[]): PlanDagParallelismDiagnostics {
  const items = [...planItems];
  const byId = new Map(items.map((item) => [item.id, item]));
  const resolved = resolveEffectiveStatusForItems(items);
  const resolvedById = new Map(resolved.items.map((item) => [item.id, item]));
  const cycleMembers = new Set(resolved.cycleMembers);
  const danglingItems = new Set(resolved.missingRefs.map((entry) => entry.itemId));
  const nonTerminalItems = resolved.items.filter((item) => !TERMINAL_STATUSES.has(item.storedStatus));
  const nonTerminalIds = new Set(nonTerminalItems.map((item) => item.id));
  const readyItems = nonTerminalItems.filter(
    (item) => item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman,
  );

  const blockingEdges: PlanDagBlockingEdge[] = [];
  for (const item of nonTerminalItems) {
    for (const blockerId of item.unresolvedBlockers) {
      const blocker = byId.get(blockerId);
      blockingEdges.push({
        itemId: item.id,
        blockerId,
        itemPhase: item.phase,
        blockerPhase: blocker?.phase ?? null,
        blockerStatus: blocker?.storedStatus ?? 'missing',
      });
    }
  }

  const nonReadyItems: PlanDagNonReadyItem[] = nonTerminalItems
    .filter((item) => !readyItems.some((ready) => ready.id === item.id))
    .map((item) => {
      let reason: PlanDagNonReadyReason;
      if (cycleMembers.has(item.id)) reason = 'cycle';
      else if (danglingItems.has(item.id)) reason = 'dangling';
      else if (item.needsHuman) reason = 'needs-human';
      else if (item.staleBlockedHint) reason = 'sticky-blocked';
      else if (item.unresolvedBlockers.length > 0) reason = 'dependency';
      else if (item.effectiveStatus === 'wip') reason = 'in-progress';
      else reason = 'non-actionable-status';
      return {
        itemId: item.id,
        effectiveStatus: item.effectiveStatus,
        reason,
        blockerIds: [...item.unresolvedBlockers],
      };
    });

  const fanInChokepoints = nonTerminalItems.flatMap<PlanDagFanInChokepoint>((item) => {
    const blockerIds = item.unresolvedBlockers.filter((id) => nonTerminalIds.has(id) || !byId.has(id));
    return blockerIds.length >= 2 ? [{ itemId: item.id, blockerIds }] : [];
  });

  const phaseInversions: PlanDagPhaseInversion[] = [];
  const releaseGateBlocksBuild: PlanDagReleaseGateBlock[] = [];
  for (const item of nonTerminalItems) {
    for (const blockerId of item.blockedBy) {
      const blocker = byId.get(blockerId);
      if (!blocker || TERMINAL_STATUSES.has(blocker.storedStatus)) continue;
      const itemOrder = phaseOrdinal(item.phase);
      const blockerOrder = phaseOrdinal(blocker.phase);
      if (item.phase && blocker.phase && itemOrder != null && blockerOrder != null && blockerOrder > itemOrder) {
        phaseInversions.push({
          itemId: item.id,
          itemPhase: item.phase,
          blockerId,
          blockerPhase: blocker.phase,
        });
      }
      if (RELEASE_GATE_RE.test(itemSearchText(blocker)) && FOUNDATION_BUILD_RE.test(itemSearchText(item))) {
        releaseGateBlocksBuild.push({
          itemId: item.id,
          itemPhase: item.phase,
          blockerId,
          blockerPhase: blocker.phase,
        });
      }
    }
  }

  const depthMemo = new Map<string, { depth: number; path: string[] }>();
  const depthFor = (id: string, visiting: Set<string>): { depth: number; path: string[] } => {
    const memo = depthMemo.get(id);
    if (memo) return memo;
    if (visiting.has(id)) return { depth: 0, path: [] };
    const item = resolvedById.get(id);
    if (!item || !nonTerminalIds.has(id)) return { depth: 0, path: [] };
    const nextVisiting = new Set(visiting).add(id);
    let deepest = { depth: 0, path: [] as string[] };
    for (const blockerId of item.blockedBy) {
      if (!nonTerminalIds.has(blockerId)) continue;
      const candidate = depthFor(blockerId, nextVisiting);
      if (candidate.depth > deepest.depth) deepest = candidate;
    }
    const result = { depth: deepest.depth + 1, path: [...deepest.path, id] };
    depthMemo.set(id, result);
    return result;
  };

  let criticalPath = { depth: 0, path: [] as string[] };
  for (const item of nonTerminalItems) {
    const candidate = depthFor(item.id, new Set());
    if (candidate.depth > criticalPath.depth) criticalPath = candidate;
  }

  return {
    nonTerminal: nonTerminalItems.length,
    nonTerminalItemIds: nonTerminalItems.map((item) => item.id),
    readyWidth: readyItems.length,
    readyItemIds: readyItems.map((item) => item.id),
    criticalPathDepth: criticalPath.depth,
    criticalPathItemIds: criticalPath.path,
    blockingEdges,
    nonReadyItems,
    fanInChokepoints,
    phaseInversions,
    releaseGateBlocksBuild,
  };
}
