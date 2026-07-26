/**
 * Who, if anyone, already OWNS the current red gate — rendered for the humans and
 * agents who receive a gate-red alert (EI-18672078222841101).
 *
 * THE PROBLEM THIS EXISTS FOR. On 2026-07-26 between 02:09 and 02:24, THREE agents
 * independently ran the identical diagnosis of the identical gate leg, each reached the
 * same conclusion, and each independently decided not to re-fire the run. ~3x waste on a
 * strictly single-owner question, and it scales with fleet size. Each agent behaved
 * CORRECTLY: the su playbook says verbatim that a red gate blocking your work is YOURS to
 * green, and that rule is deliberate — it exists because a days-red gate previously sat
 * unowned for days. The collectively-wrong outcome came from the alert, not the rule.
 *
 * WHY THIS IS A RENDERING MODULE AND NOT A NEW REGISTRY. The system ALREADY computes
 * ownership at red time and has since P-012/D-009: `last_fixer` (green-checkpoint routine
 * metadata) is keyed by the stable FAILURE SIGNATURE, carries the dispatched fixer's
 * `spawnId`, and `releaseFixerSpawnAlive` resolves real liveness off it using the same
 * definition the fleet_assignment view and the stale-claim reconciler use.
 * `decideReleaseFixerDispatch` already returns reason:'covered' when a live fixer holds the
 * current signature. All of that is used for exactly ONE purpose — suppressing a duplicate
 * fixer dispatch — and is never shown to anyone. So the fix is to SURFACE the owner the
 * system already knows about; minting a parallel per-signature ownership record beside
 * `last_fixer` would be a second answer to a question the first one already answers.
 *
 * WHY NOT THE TWO OBVIOUS FIXES:
 *  - "Tell agents to check first": adds a round-trip for every recipient and STILL races —
 *    all three of the above started within ~10 minutes, so a check at t=0 shows nobody.
 *  - "Make the gate leader-only": breaks the deliberate "a red gate is everyone's problem"
 *    property that keeps a red gate from sitting unowned.
 * Hence `unowned` is a first-class, LOUD state here: the point is not to stop agents from
 * taking the gate, it is to stop them from taking it THREE TIMES.
 */

/** The ownership states a red gate can be in, most-covered first. */
export type GateRedOwnershipState =
  /** A fixer holds the CURRENT signature and is confirmed alive. Stand down. */
  | 'owned-live'
  /** A fixer holds the current signature; liveness is unknowable (durable/legacy fire, no
   *  spawn id). `decideReleaseFixerDispatch` treats this as covered, so we do too. */
  | 'owned-unknown'
  /** A fixer was dispatched for this signature and is CONFIRMED GONE without clearing it.
   *  Genuinely unowned RIGHT NOW — and the most valuable state to name, because the alert
   *  prose ("a release-fixer is on it") is actively false here. */
  | 'owner-gone'
  /** A fixer exists but for a DIFFERENT failure signature — it is not working on this red. */
  | 'stale-signature'
  /** No fixer record at all. */
  | 'unowned';

export interface GateRedOwnership {
  state: GateRedOwnershipState;
  /** True only when a responder should stand down rather than investigate. */
  covered: boolean;
  /** The dispatched fixer's spawn id, when there is one to name. */
  spawnId: string | null;
  /** The signature the recorded fixer is actually working on. */
  ownerSignature: string | null;
  /** ms since that fixer was dispatched, when known. */
  ageMs: number | null;
  /** One line, safe to paste into an alert body or a tool result. */
  label: string;
}

export interface GateRedOwnershipInput {
  /** `last_fixer.signature` — the failure signature the recorded fixer was dispatched for. */
  ownerSignature?: string | null;
  /** The signature of the red being reported RIGHT NOW. */
  currentSignature?: string | null;
  /** `last_fixer.at` (epoch ms). */
  dispatchedAtMs?: number | null;
  /** `last_fixer.spawnId`. */
  spawnId?: string | null;
  /** `releaseFixerSpawnAlive` result: true=alive, false=confirmed gone, null=unknowable.
   *  Deliberately the SAME tri-state that `decideReleaseFixerDispatch` consumes, so this
   *  renderer can never disagree with the dispatcher about who is covering the gate. */
  fixerAlive?: boolean | null;
  nowMs: number;
}

function humanAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown age';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * PURE. Decide + render who owns the current red.
 *
 * Note the signature comparison is what makes this meaningful rather than decorative:
 * while the gate stays red, staging advances hourly so every checkpoint is a NEW candidate
 * — which is precisely why P-012 keyed the dedup on the signature and not the sha. A
 * surface that reports `lastFixerCandidate` (as the pipeline snapshot did) therefore tells
 * a reader almost nothing about whether anyone is on THIS failure.
 */
export function describeGateRedOwnership(input: GateRedOwnershipInput): GateRedOwnership {
  const ownerSignature = input.ownerSignature ?? null;
  const currentSignature = input.currentSignature ?? null;
  const spawnId = input.spawnId ?? null;
  const dispatchedAtMs =
    typeof input.dispatchedAtMs === 'number' && Number.isFinite(input.dispatchedAtMs)
      ? input.dispatchedAtMs
      : null;
  const ageMs = dispatchedAtMs != null ? Math.max(0, input.nowMs - dispatchedAtMs) : null;
  const who = spawnId ? `release-fixer ${spawnId}` : 'a release-fixer';

  if (!ownerSignature) {
    return {
      state: 'unowned',
      covered: false,
      spawnId: null,
      ownerSignature: null,
      ageMs: null,
      label: 'UNOWNED — no release-fixer has been dispatched for this red. Claim it before investigating.',
    };
  }

  // A fixer on a DIFFERENT failure is not covering this one. Only compare when we actually
  // know the current signature — with it unknown we cannot claim a mismatch, so fall
  // through to the liveness answer rather than inventing a false 'stale-signature'.
  if (currentSignature && ownerSignature !== currentSignature) {
    return {
      state: 'stale-signature',
      covered: false,
      spawnId,
      ownerSignature,
      ageMs,
      label:
        `UNOWNED — the last release-fixer (dispatched ${humanAge(ageMs)}) is working a DIFFERENT failure ` +
        `(${ownerSignature}), not this one. Claim this red before investigating.`,
    };
  }

  if (input.fixerAlive === false) {
    return {
      state: 'owner-gone',
      covered: false,
      spawnId,
      ownerSignature,
      ageMs,
      label:
        `UNOWNED — ${who} was dispatched ${humanAge(ageMs)} but is CONFIRMED GONE without clearing this red. ` +
        `Claim it before investigating.`,
    };
  }

  const unknown = input.fixerAlive == null;
  return {
    state: unknown ? 'owned-unknown' : 'owned-live',
    covered: true,
    spawnId,
    ownerSignature,
    ageMs,
    label:
      `OWNED — ${who} has been on this exact failure since ${humanAge(ageMs)}` +
      (unknown
        ? ' (liveness unknowable: durable fire with no spawn id — treated as covered).'
        : ' and is alive.') +
      ' Do NOT start a parallel diagnosis; coordinate with the owner instead.',
  };
}
