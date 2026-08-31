/**
 * gate-owner-brief.ts — gate-audit-hardening-2026-08-31 P-001.
 *
 * ONE COMPOSED, VINTAGE-STAMPED ANSWER to the owner's four-part question: *is main
 * green — if not, why not — who owns it — and is remediation actually alive?*
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Audited 2026-08-31 (WI-1820224 + its correction comment), over the 11-day red that
 * began 2026-08-20T20:57Z: the owner's recurring experience was AGENTS TELLING HIM
 * CONFLICTING THINGS. Traced, none of the conflicts were factual disagreement — every
 * one was a vintage or denominator mismatch between separately-read surfaces:
 *
 *   • a streak counter ("42 reds") read as a current failure count;
 *   • a scoped typecheck ("clean on MY files") read as the gate's lint:tsc leg;
 *   • "plan shipped" read as "main green";
 *   • an instrument abort (zero tests executed) read as a code red — and vice versa;
 *   • a holder claim read as remediation, hours after the dispatched fixer had died.
 *
 * Each leg of that answer ALREADY EXISTS on `dev:pipeline_position` (verdict counters,
 * ownership + holder liveness, the frozen-repair-queue diagnostic with `fixerAlive`,
 * `inconclusive`) — what did not exist is the COMPOSITION: one read that answers all
 * four parts together, with each leg carrying the timestamp of the observation it came
 * from, so two agents quoting it cannot diverge without the divergence being visible.
 *
 * ── DESIGN RULES ────────────────────────────────────────────────────────────────
 * PURE COMPOSITION, ONE DERIVATION (the axis-5 doctrine): `composeGateOwnerBrief`
 * performs NO I/O and re-derives NOTHING — every input is a value
 * `gitPipelinePosition()` already computed for its existing gate block. Adding I/O
 * here would create a second derivation that can disagree with the first, which is
 * the exact class of defect the brief exists to end.
 *
 * VINTAGE ON EVERY LEG. A leg without a timestamp is a leg that can be quoted stale
 * without anyone noticing; `vintageSpreadMs` names the worst-case spread between the
 * legs so a reader can see when the composed answer mixes observations minutes apart.
 */

import type { CellOwnership } from './coord/gate-ownership';

/** The closed answer vocabulary — mirrored by the cell registration's assessment codes. */
export type GateOwnerBriefAnswer =
  | 'green'
  | 'red-owned-remediating'
  | 'red-owned-stalled'
  | 'red-unowned'
  | 'not-judging'
  | 'unknown';

/** WHEN a leg's underlying observation was made, and by what apparatus. */
export interface GateOwnerBriefVintage {
  observedAtMs: number | null;
  /** Age relative to the compose call's `nowMs`; null when the observation is unstamped. */
  ageMs: number | null;
  /** The apparatus the observation came from — prose, for a human reader. */
  source: string;
}

export interface GateOwnerBriefAssessment {
  code: GateOwnerBriefAnswer;
  meaning: string;
  safeAction: string;
}

export interface GateOwnerBrief {
  /** The composed verdict — the one word the owner asked for. */
  answer: GateOwnerBriefAnswer;
  assessment: GateOwnerBriefAssessment;
  /** Is the gate green about what it last judged? null = counters unmeasured. */
  mainGreen: { value: boolean | null; vintage: GateOwnerBriefVintage };
  /** Present exactly when the answer is a red/unknown family member with named legs. */
  whyNot: {
    failingLegs: string[];
    /** True only when a real verdict measured `failingLegs`; false/null = carried or unstamped. */
    measured: boolean | null;
    inconclusiveStatus: string | null;
    vintage: GateOwnerBriefVintage;
  } | null;
  ownership: {
    claimState: string | null;
    holder: string | null;
    workItem: string | null;
    /** The branchable liveness reading — `held-live` etc. — from the ownership oracle. */
    assessmentCode: string | null;
    vintage: GateOwnerBriefVintage;
  };
  /** Present when a frozen repair queue exists — the "is anyone actually fixing it" leg. */
  remediation: {
    phase: string | null;
    attempts: number | null;
    fixerSpawnId: string | null;
    /** null = liveness unmeasurable; false = a dispatched fixer is DEAD (the 5h-gap case). */
    fixerAlive: boolean | null;
    zeroAttemptStalled: boolean | null;
    queueAgeMs: number | null;
    vintage: GateOwnerBriefVintage;
  } | null;
  lastGreen: { atMs: number | null; ageMs: number | null };
  /**
   * Worst-case spread (ms) between the newest and oldest stamped legs — the
   * conflicting-reports detector: a large spread means this answer mixes observations
   * from different moments, which is exactly how two honest reads diverge.
   */
  vintageSpreadMs: number | null;
  /** Legs that could not be read, named — so absence is never silent. */
  unknownLegs: Array<{ leg: string; why: string }>;
}

/** Everything the composer needs — all values the position resolver already holds. */
export interface GateOwnerBriefInput {
  nowMs: number;
  consecutiveReds: number | null | undefined;
  failingTests: string[] | null | undefined;
  failingTestsMeasured: boolean | null | undefined;
  lastGreenAtMs: number | null | undefined;
  verdictObservedAtMs: number | null | undefined;
  fireStale: boolean | null | undefined;
  verdictStale: boolean | null | undefined;
  inconclusive: { status: string; detail: string | null; observedAtMs: number | null } | null | undefined;
  repairQueue:
    | {
        phase: string;
        attempts: number;
        updatedAtMs: number;
        ageMs: number;
        fixerSpawnId: string | null;
        fixerAlive: boolean | null;
        zeroAttemptStalled: boolean;
      }
    | null
    | undefined;
  ownership: Pick<CellOwnership, 'claimState' | 'takenBy' | 'workItem' | 'assessment'> | null | undefined;
}

const vintage = (observedAtMs: number | null | undefined, source: string, nowMs: number): GateOwnerBriefVintage => ({
  observedAtMs: observedAtMs ?? null,
  ageMs: observedAtMs != null ? Math.max(0, nowMs - observedAtMs) : null,
  source,
});

/** The ownership-oracle codes that mean "a live session holds this incident". */
const OWNED_LIVE_CODES = new Set(['held-live', 'held-needs-confirmation']);

export function composeGateOwnerBrief(inp: GateOwnerBriefInput): GateOwnerBrief {
  const unknownLegs: Array<{ leg: string; why: string }> = [];

  const verdictVintage = vintage(
    inp.verdictObservedAtMs,
    'gate_health snapshot (green-checkpoint routine metadata)',
    inp.nowMs,
  );
  const ownershipVintage = vintage(inp.nowMs, 'readGateOwnership() — resolved live at this read', inp.nowMs);
  const remediationVintage = vintage(
    inp.repairQueue?.updatedAtMs ?? null,
    'frozen-repair-queue diagnostic (incl. live fixer-spawn liveness)',
    inp.nowMs,
  );

  const reds = inp.consecutiveReds ?? null;
  if (reds === null) {
    unknownLegs.push({ leg: 'verdict', why: 'consecutiveReds was not measured on the gate_health snapshot' });
  }
  if (inp.ownership == null) {
    unknownLegs.push({ leg: 'ownership', why: 'the ownership oracle returned nothing for this read' });
  }
  if (inp.repairQueue != null && inp.repairQueue.fixerAlive === null) {
    unknownLegs.push({ leg: 'remediation.fixerAlive', why: 'fixer-spawn liveness was unmeasurable on this read' });
  }

  // `assessment` is the ownership oracle's closed string union (GateOwnershipAssessment).
  const ownershipCode = inp.ownership?.assessment ?? null;
  const ownedLive = ownershipCode !== null && OWNED_LIVE_CODES.has(ownershipCode);

  const red = (reds ?? 0) > 0 || inp.inconclusive != null;
  const green = reds === 0 && !inp.verdictStale && inp.inconclusive == null;

  let answer: GateOwnerBriefAnswer;
  if (inp.fireStale) {
    answer = 'not-judging';
  } else if (reds === null) {
    answer = 'unknown';
  } else if (green) {
    answer = 'green';
  } else if (!red) {
    // reds === 0 but the verdict is stale: judged state is green, subject may have moved.
    answer = 'green';
  } else if (!ownedLive) {
    answer = 'red-unowned';
  } else if (
    inp.repairQueue != null &&
    (inp.repairQueue.fixerAlive === false || inp.repairQueue.zeroAttemptStalled) &&
    inp.repairQueue.fixerAlive !== true
  ) {
    answer = 'red-owned-stalled';
  } else {
    answer = 'red-owned-remediating';
  }

  const ASSESSMENTS: Record<GateOwnerBriefAnswer, Omit<GateOwnerBriefAssessment, 'code'>> = {
    green: {
      meaning: 'The gate is green about what it last judged. Check mainBehindStaging separately for the ordinary promotion buffer.',
      safeAction: 'Proceed; nothing on the gate needs an owner decision.',
    },
    'red-owned-remediating': {
      meaning: 'The gate is red, a LIVE session owns the incident, and remediation shows signs of life.',
      safeAction:
        'Do not open a second lane and do not re-derive status by hand — quote THIS read (it is vintage-stamped) and coordinate with the holder for anything that must move.',
    },
    'red-owned-stalled': {
      meaning:
        'The gate is red and owned, but the dispatched fixer is dead or the queue shows zero-attempt stall — remediation is NOT visibly progressing. This is the shape that once idled ~5h before a human noticed.',
      safeAction:
        'Tell the holder their fixer is dead (coord:send with this read attached). If the holder does not respond, escalate — a dead fixer never resumes by itself.',
    },
    'red-unowned': {
      meaning: 'The gate is red and NO live session owns the incident — the every-agent-waits / 37-agent-pileup shape.',
      safeAction:
        'Read gate.greenCheckpoint.ownership and claim the incident (or wake whoever should) — an unowned red is everyone\'s blocker and no one\'s work.',
    },
    'not-judging': {
      meaning: 'The gate has not fired within its interval — nothing is being judged, so red/green counters describe the past.',
      safeAction: 'Recover the green-checkpoint producer first; do not act on the counters beside this answer.',
    },
    unknown: {
      meaning: 'The verdict counters were not measured on this read — this answer says NOTHING about gate health.',
      safeAction: 'Treat gate state as unknown; read unknownLegs for what was missing and retry or escalate the instrument.',
    },
  };

  const stampedLegs = [
    verdictVintage.observedAtMs,
    ownershipVintage.observedAtMs,
    ...(inp.repairQueue != null ? [remediationVintage.observedAtMs] : []),
    ...(inp.inconclusive?.observedAtMs != null ? [inp.inconclusive.observedAtMs] : []),
  ].filter((v): v is number => v != null);

  return {
    answer,
    assessment: { code: answer, ...ASSESSMENTS[answer] },
    mainGreen: {
      value: reds === null ? null : green || !red,
      vintage: verdictVintage,
    },
    whyNot:
      answer === 'green'
        ? null
        : {
            failingLegs: inp.failingTests ?? [],
            measured: inp.failingTestsMeasured ?? null,
            inconclusiveStatus: inp.inconclusive?.status ?? null,
            vintage:
              inp.inconclusive?.observedAtMs != null
                ? vintage(inp.inconclusive.observedAtMs, 'gate inconclusive record', inp.nowMs)
                : verdictVintage,
          },
    ownership: {
      claimState: inp.ownership?.claimState ?? null,
      holder: inp.ownership?.takenBy ?? null,
      workItem: inp.ownership?.workItem ?? null,
      assessmentCode: ownershipCode,
      vintage: ownershipVintage,
    },
    remediation:
      inp.repairQueue == null
        ? null
        : {
            phase: inp.repairQueue.phase,
            attempts: inp.repairQueue.attempts,
            fixerSpawnId: inp.repairQueue.fixerSpawnId,
            fixerAlive: inp.repairQueue.fixerAlive,
            zeroAttemptStalled: inp.repairQueue.zeroAttemptStalled,
            queueAgeMs: inp.repairQueue.ageMs,
            vintage: remediationVintage,
          },
    lastGreen: {
      atMs: inp.lastGreenAtMs ?? null,
      ageMs: inp.lastGreenAtMs != null ? Math.max(0, inp.nowMs - inp.lastGreenAtMs) : null,
    },
    vintageSpreadMs: stampedLegs.length >= 2 ? Math.max(...stampedLegs) - Math.min(...stampedLegs) : null,
    unknownLegs,
  };
}
