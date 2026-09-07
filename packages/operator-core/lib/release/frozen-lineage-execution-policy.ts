/**
 * Shared fail-closed policy for work that can select or judge a frozen gate
 * candidate.
 *
 * The persisted repair queue remains the only identity store. This module only
 * projects its marker into the smaller identity every execution boundary needs
 * and compares a captured identity with the live marker immediately before
 * launch. Ordinary staging edits, focused tests, and explicit repair admission
 * are outside the governed operation set by design.
 */
import { readFrozenRepairMarker, type FrozenRepairEditMarker } from './frozen-repair-edit-marker';

export interface FrozenLineageIdentity {
  candidate: string;
  repairHead: string;
  /** The repair queue's monotonic update stamp (`updatedAtMs` on the marker). */
  queueRevision: number;
}

export type FrozenLineageIdentityField = keyof FrozenLineageIdentity;

export interface FrozenLineageIdentityComparison {
  matches: boolean;
  mismatchedFields: FrozenLineageIdentityField[];
  expected: FrozenLineageIdentity;
  actual: FrozenLineageIdentity;
}

export function frozenLineageIdentityFromMarker(
  marker: Pick<FrozenRepairEditMarker, 'candidate' | 'repairHead' | 'updatedAtMs'>,
): FrozenLineageIdentity {
  return {
    candidate: marker.candidate,
    repairHead: marker.repairHead,
    queueRevision: marker.updatedAtMs,
  };
}

export function readFrozenLineageIdentity(path?: string): FrozenLineageIdentity | null {
  const marker = path === undefined ? readFrozenRepairMarker() : readFrozenRepairMarker(path);
  return marker ? frozenLineageIdentityFromMarker(marker) : null;
}

export function compareFrozenLineageIdentity(
  expected: FrozenLineageIdentity,
  actual: FrozenLineageIdentity,
): FrozenLineageIdentityComparison {
  const mismatchedFields: FrozenLineageIdentityField[] = [];
  if (expected.candidate !== actual.candidate) mismatchedFields.push('candidate');
  if (expected.repairHead !== actual.repairHead) mismatchedFields.push('repairHead');
  if (expected.queueRevision !== actual.queueRevision) mismatchedFields.push('queueRevision');
  return {
    matches: mismatchedFields.length === 0,
    mismatchedFields,
    expected,
    actual,
  };
}

export function frozenLineageIdentityMatches(expected: FrozenLineageIdentity, actual: FrozenLineageIdentity): boolean {
  return compareFrozenLineageIdentity(expected, actual).matches;
}

export type FrozenLineageOperation =
  | 'candidate-selection'
  | 'canonical-verification'
  | 'ordinary-edit'
  | 'focused-test'
  | 'repair-admission';

export type FrozenLineageSelectionSource =
  | 'live-repair-head'
  | 'effective-checkout-head'
  | 'staging'
  | 'current-head'
  | 'integration-branch'
  | 'caller-selected-sha'
  | 'unknown';

export const UNSAFE_FROZEN_CANDIDATE_SOURCES = Object.freeze([
  'staging',
  'current-head',
  'integration-branch',
  'caller-selected-sha',
] as const satisfies readonly FrozenLineageSelectionSource[]);

const unsafeSources = new Set<FrozenLineageSelectionSource>(UNSAFE_FROZEN_CANDIDATE_SOURCES);

export function isGovernedFrozenLineageOperation(operation: FrozenLineageOperation): boolean {
  return operation === 'candidate-selection' || operation === 'canonical-verification';
}

export function isUnsafeFrozenCandidateSource(source: FrozenLineageSelectionSource): boolean {
  return unsafeSources.has(source);
}

export interface FrozenLineagePolicyInput {
  operation: FrozenLineageOperation;
  selectionSource: FrozenLineageSelectionSource;
  /** Effective checkout HEAD observed at the execution boundary. */
  checkoutHead?: string | null;
  /** Queue identity captured by the authority boundary that requested the launch. */
  expectedIdentity?: FrozenLineageIdentity | null;
}

export type FrozenLineagePolicyAllowReason = 'no-frozen-queue' | 'operation-not-governed' | 'repair-head-match';

export type FrozenLineagePolicyRefusalReason =
  | 'selection-source-unknown'
  | 'unsafe-candidate-source'
  | 'queue-identity-required'
  | 'queue-identity-mismatch'
  | 'checkout-head-required'
  | 'checkout-head-mismatch';

interface FrozenLineagePolicyBase {
  operation: FrozenLineageOperation;
  selectionSource: FrozenLineageSelectionSource;
}

export type FrozenLineagePolicyVerdict =
  | (FrozenLineagePolicyBase & {
      allowed: true;
      reason: FrozenLineagePolicyAllowReason;
      liveIdentity: FrozenLineageIdentity | null;
    })
  | (FrozenLineagePolicyBase & {
      allowed: false;
      reason: FrozenLineagePolicyRefusalReason;
      liveIdentity: FrozenLineageIdentity;
      expectedIdentity: FrozenLineageIdentity | null;
      checkoutHead: string | null;
      mismatchedIdentityFields: FrozenLineageIdentityField[];
      sanctionedRoute: string;
    });

export interface FrozenLineagePolicyProbe {
  /** Injected by tests/callers that already performed the live marker read. */
  marker?: FrozenRepairEditMarker | null;
}

function refusal(
  input: FrozenLineagePolicyInput,
  liveIdentity: FrozenLineageIdentity,
  reason: FrozenLineagePolicyRefusalReason,
  mismatchedIdentityFields: FrozenLineageIdentityField[] = [],
): FrozenLineagePolicyVerdict {
  return {
    allowed: false,
    reason,
    operation: input.operation,
    selectionSource: input.selectionSource,
    liveIdentity,
    expectedIdentity: input.expectedIdentity ?? null,
    checkoutHead: input.checkoutHead ?? null,
    mismatchedIdentityFields,
    sanctionedRoute:
      `Select and re-read live repairHead ${liveIdentity.repairHead} from queue revision ` +
      `${liveIdentity.queueRevision} immediately before launch. Land fixes through ` +
      "release:repair-queue { op:'admit', paths:[...] }.",
  };
}

/**
 * Evaluate one candidate-selection or canonical-verification boundary.
 *
 * Governed work fails closed on an unknown/unsafe source, a missing or stale
 * captured queue identity, a missing checkout observation, or any checkout HEAD
 * other than the current repairHead. Non-governed staging work remains legal.
 */
export function evaluateFrozenLineagePolicy(
  input: FrozenLineagePolicyInput,
  probe: FrozenLineagePolicyProbe = {},
): FrozenLineagePolicyVerdict {
  const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker();
  if (!marker) {
    return {
      allowed: true,
      reason: 'no-frozen-queue',
      operation: input.operation,
      selectionSource: input.selectionSource,
      liveIdentity: null,
    };
  }

  const liveIdentity = frozenLineageIdentityFromMarker(marker);
  if (!isGovernedFrozenLineageOperation(input.operation)) {
    return {
      allowed: true,
      reason: 'operation-not-governed',
      operation: input.operation,
      selectionSource: input.selectionSource,
      liveIdentity,
    };
  }
  if (input.selectionSource === 'unknown') {
    return refusal(input, liveIdentity, 'selection-source-unknown');
  }
  if (isUnsafeFrozenCandidateSource(input.selectionSource)) {
    return refusal(input, liveIdentity, 'unsafe-candidate-source');
  }
  if (!input.expectedIdentity) {
    return refusal(input, liveIdentity, 'queue-identity-required');
  }
  const comparison = compareFrozenLineageIdentity(input.expectedIdentity, liveIdentity);
  if (!comparison.matches) {
    return refusal(input, liveIdentity, 'queue-identity-mismatch', comparison.mismatchedFields);
  }
  if (!input.checkoutHead) {
    return refusal(input, liveIdentity, 'checkout-head-required');
  }
  if (input.checkoutHead !== liveIdentity.repairHead) {
    return refusal(input, liveIdentity, 'checkout-head-mismatch');
  }
  return {
    allowed: true,
    reason: 'repair-head-match',
    operation: input.operation,
    selectionSource: input.selectionSource,
    liveIdentity,
  };
}

export function renderFrozenLineagePolicyRefusal(verdict: FrozenLineagePolicyVerdict): string | null {
  if (verdict.allowed) return null;
  const identity = verdict.liveIdentity;
  const mismatch = verdict.mismatchedIdentityFields.length
    ? ` Mismatched identity fields: ${verdict.mismatchedIdentityFields.join(', ')}.`
    : '';
  return (
    `frozen_lineage_refused:${verdict.reason}: ${verdict.operation} selected source ` +
    `'${verdict.selectionSource}' with checkout HEAD ${verdict.checkoutHead ?? 'unmeasured'}. ` +
    `Live queue identity is candidate=${identity.candidate}, repairHead=${identity.repairHead}, ` +
    `queueRevision=${identity.queueRevision}.${mismatch} ${verdict.sanctionedRoute}`
  );
}

export const FROZEN_CANDIDATE_LINEAGE_VIOLATION = 'frozen_candidate_lineage_violation' as const;

export type FrozenLineageCarrySurface =
  | 'work-item-checkpoint'
  | 'loop-checkpoint'
  | 'compaction-continuation'
  | 'fact'
  | 'plan-decision';

export type UnsafeFrozenCarrySource = Extract<
  FrozenLineageSelectionSource,
  'staging' | 'current-head' | 'integration-branch'
>;

export interface UnsafeFrozenCarryInstruction {
  unsafeSource: UnsafeFrozenCarrySource;
  /** The bounded clause that established the positive instruction. */
  matchedText: string;
}

export interface FrozenLineageCarryPolicyInput {
  surface: FrozenLineageCarrySurface;
  text: string;
}

export type FrozenLineageCarryPolicyVerdict =
  | {
      allowed: true;
      reason: 'no-frozen-queue' | 'no-unsafe-candidate-instruction';
      surface: FrozenLineageCarrySurface;
      liveIdentity: FrozenLineageIdentity | null;
    }
  | {
      allowed: false;
      errorCode: typeof FROZEN_CANDIDATE_LINEAGE_VIOLATION;
      surface: FrozenLineageCarrySurface;
      unsafeSource: UnsafeFrozenCarrySource;
      matchedText: string;
      liveIdentity: FrozenLineageIdentity;
      sanctionedRoute: string;
    };

const CARRY_SOURCE_PATTERNS: readonly {
  source: UnsafeFrozenCarrySource;
  pattern: string;
}[] = [
  { source: 'current-head', pattern: String.raw`\bcurrent[\s_-]+head\b` },
  { source: 'integration-branch', pattern: String.raw`\bintegration[\s_-]*branch\b` },
  { source: 'staging', pattern: String.raw`\b(?:origin\/)?staging(?:\s+(?:tip|head))?\b` },
];

const CARRY_STRONG_SELECTION_ACTIONS =
  String.raw`(?:use|select|choose|take|derive|pin|cut|recut|base|set|treat|resolve)`;
const CARRY_EXECUTION_ACTIONS = String.raw`(?:create|check\s*out|checkout|launch|run|test|verify|judge|evaluate)`;
const CARRY_JUDGED_CONTEXT =
  /\b(?:candidate|judged|canonical|verdict|verification|worktree|root\s+test|full[-\s]+suite)\b/i;
const CARRY_NEGATION_BEFORE =
  /\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|refus(?:e|es|ed|ing)|reject(?:s|ed|ing)?|forbid(?:s|den|ding)?|block(?:s|ed|ing)?)\b(?:\s+\S+){0,7}\s*$/i;
const CARRY_RETRACTION_AFTER =
  /\b(?:is|are|was|were|has\s+been|have\s+been|must\s+be|will\s+be)\s+(?:wrong|unsafe|invalid|retracted|withdrawn|superseded|rejected|refused|forbidden|blocked)\b/i;

function normalizedCarryClause(clause: string): string {
  return clause
    .replace(/[`*_>#\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function carryDirectiveIsNegated(clause: string, start: number, end: number): boolean {
  const before = clause.slice(Math.max(0, start - 120), start);
  const span = clause.slice(start, end);
  const after = clause.slice(end, Math.min(clause.length, end + 160));
  if (CARRY_NEGATION_BEFORE.test(before)) return true;
  if (/\b(?:not|never)\b/i.test(span)) return true;
  if (CARRY_RETRACTION_AFTER.test(after)) return true;
  return false;
}

/**
 * Detect a POSITIVE instruction to select a moving source as the judged frozen
 * candidate. This deliberately does not flag a bare mention of staging: ordinary
 * edits and focused tests there remain legal. Negated/refused/retracted directions
 * are also allowed so a successor can carry the correction that retires a stale
 * instruction.
 */
export function detectUnsafeFrozenCarryInstruction(text: string): UnsafeFrozenCarryInstruction | null {
  const clauses = text
    .split(/\n+|[.!?;](?:\s+|$)/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  for (const originalClause of clauses) {
    const clause = normalizedCarryClause(originalClause);
    if (!clause) continue;
    const hasJudgedContext = CARRY_JUDGED_CONTEXT.test(clause);

    for (const { source, pattern } of CARRY_SOURCE_PATTERNS) {
      if (!new RegExp(pattern, 'i').test(clause)) continue;

      const directRelations = [
        new RegExp(
          String.raw`\b(?:candidate|judged\s+candidate|canonical(?:\s+(?:test|verification|verdict|run))?|verification|verdict|worktree)\b.{0,140}\b(?:from|at|on|to|is|equals?)\b.{0,70}${pattern}`,
          'i',
        ),
        new RegExp(
          String.raw`${pattern}.{0,100}\b(?:as|for)\b.{0,60}\b(?:the\s+)?(?:judged\s+)?(?:candidate|canonical(?:\s+(?:test|verification|verdict|run))?|verification|verdict|worktree)\b`,
          'i',
        ),
      ];
      const strongAction = new RegExp(String.raw`\b(${CARRY_STRONG_SELECTION_ACTIONS})\b.{0,160}${pattern}`, 'i').exec(
        clause,
      );
      const executionAction = new RegExp(String.raw`\b(${CARRY_EXECUTION_ACTIONS})\b.{0,160}${pattern}`, 'i').exec(
        clause,
      );
      const relation = directRelations.map((candidate) => candidate.exec(clause)).find(Boolean) ?? null;
      const strongActionName = strongAction?.[1]?.toLowerCase() ?? '';
      const strongActionIsCandidateSpecific = ['pin', 'cut', 'recut'].includes(strongActionName);
      const positive =
        relation ??
        (strongAction && (hasJudgedContext || strongActionIsCandidateSpecific) ? strongAction : null) ??
        (executionAction && hasJudgedContext ? executionAction : null);
      if (!positive || carryDirectiveIsNegated(clause, positive.index, positive.index + positive[0].length)) continue;

      return {
        unsafeSource: source,
        matchedText: originalClause.replace(/\s+/g, ' ').trim().slice(0, 320),
      };
    }
  }
  return null;
}

function frozenLineageSanctionedRoute(identity: FrozenLineageIdentity): string {
  return (
    `Select and re-read live repairHead ${identity.repairHead} from queue revision ${identity.queueRevision} ` +
    "immediately before launch. Land fixes through release:repair-queue { op:'admit', paths:[...] }."
  );
}

/** Evaluate one durable successor/carry text boundary against the live marker. */
export function evaluateFrozenLineageCarryText(
  input: FrozenLineageCarryPolicyInput,
  probe: FrozenLineagePolicyProbe = {},
): FrozenLineageCarryPolicyVerdict {
  const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker();
  if (!marker) {
    return {
      allowed: true,
      reason: 'no-frozen-queue',
      surface: input.surface,
      liveIdentity: null,
    };
  }
  const liveIdentity = frozenLineageIdentityFromMarker(marker);
  const instruction = detectUnsafeFrozenCarryInstruction(input.text);
  if (!instruction) {
    return {
      allowed: true,
      reason: 'no-unsafe-candidate-instruction',
      surface: input.surface,
      liveIdentity,
    };
  }
  return {
    allowed: false,
    errorCode: FROZEN_CANDIDATE_LINEAGE_VIOLATION,
    surface: input.surface,
    unsafeSource: instruction.unsafeSource,
    matchedText: instruction.matchedText,
    liveIdentity,
    sanctionedRoute: frozenLineageSanctionedRoute(liveIdentity),
  };
}

export function renderFrozenLineageCarryRefusal(verdict: FrozenLineageCarryPolicyVerdict): string | null {
  if (verdict.allowed) return null;
  const identity = verdict.liveIdentity;
  return (
    `${FROZEN_CANDIDATE_LINEAGE_VIOLATION} — ${verdict.surface} would persist an instruction selecting source ` +
    `'${verdict.unsafeSource}' as the judged frozen candidate. Live queue identity is ` +
    `candidate=${identity.candidate}, repairHead=${identity.repairHead}, queueRevision=${identity.queueRevision}. ` +
    `Detected instruction: "${verdict.matchedText}". ${verdict.sanctionedRoute}`
  );
}

/** Machine-readable refusal shared by heterogeneous MCP writer envelopes. */
export function frozenLineageCarryViolationPayload(verdict: FrozenLineageCarryPolicyVerdict) {
  if (verdict.allowed) return null;
  return {
    ok: false as const,
    error: FROZEN_CANDIDATE_LINEAGE_VIOLATION,
    errorCode: FROZEN_CANDIDATE_LINEAGE_VIOLATION,
    surface: verdict.surface,
    unsafeSource: verdict.unsafeSource,
    matchedText: verdict.matchedText,
    liveIdentity: verdict.liveIdentity,
    sanctionedRoute: verdict.sanctionedRoute,
    message: renderFrozenLineageCarryRefusal(verdict),
  };
}
