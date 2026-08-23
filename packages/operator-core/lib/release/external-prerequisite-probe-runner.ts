/**
 * external-prerequisite-probe-runner.ts — typed-external-prerequisite-attestations-for-release-gates-2026-08-15 P-003.
 *
 * Executes a prerequisite's declared non-secret probe, writes an expiring
 * attestation receipt, and drives the absent->ready and ready->expired
 * transitions that keep a release scorecard honest about an external wall.
 *
 * ## Read plan Decision D-001 before extending this
 *
 * `release:preflight` DOES NOT EXIST. Every item in this plan is phrased as
 * "wire into release:preflight", and EI-7025 is a done row with no artifact
 * behind it. This module therefore stands alone and is CONSUMED by the gate
 * surfaces that already exist; do not go looking for a preflight contract to
 * extend, and do not build a scheduler here. (D-001 (b): the absence of
 * release:preflight is not licence to invent an orchestration plane.)
 *
 * ## Why every side effect is an injected PORT
 *
 * This module is pure logic over {@link ProbeRunnerPorts}. It does not open a
 * database handle, call `emitAwaitedEvent`, or touch the scorecards tools
 * directly. Three reasons, in order of importance:
 *
 *   1. It keeps the "no parallel orchestration plane" constraint satisfiable.
 *      A runner that reaches for its own storage and its own event bus IS the
 *      beginning of a second plane; one that takes ports is a function the
 *      existing gate calls.
 *   2. The lifecycle rules below — which transition fires, what never gets
 *      written — are the part that must be provably correct, and they are only
 *      cheaply testable if no I/O is welded in.
 *   3. P-005 wires the concrete adapters (`emitAwaitedEvent` from
 *      `lib/events/await/engine`, the scorecards emit surface, the migration-928
 *      table). Those mappings are named on each port so the wiring is mechanical.
 *
 * ## The invariant this file adds: a FAILED probe is not an OBSERVED ABSENCE
 *
 * `external-prerequisites.ts` establishes that an absence must never read as
 * ready. This module carries the dual, and it is the easier one to get wrong:
 *
 *   **a probe that could not determine the answer must never be recorded as a
 *   probe that determined the wall was down.**
 *
 * Both "feel" like failure and both fail the gate, so collapsing them looks
 * harmless. It is not. `present: false` is a positive claim — *the probe ran and
 * the wall is down* — and it is durable: it lands in the store, it is what an
 * operator reads, and it is what a later "it came back" transition is computed
 * against. A timeout, a crashed adapter, or an unregistered `probeRef` support
 * none of that. So an indeterminate outcome writes NOTHING and is reported as
 * {@link PrerequisiteReadiness} `unknown` — which is already not-satisfied, so
 * the gate still fails closed without the store being taught a fact that is not
 * true. See {@link ProbeOutcome} and {@link runPrerequisiteProbe}.
 *
 * ## Expiry is DERIVED, which is what makes the sweep idempotent
 *
 * Nothing writes a row when a receipt lapses: `resolvePrerequisiteReadiness`
 * computes `expired` from `expiresAt` against the evaluation instant. That is
 * deliberate — the receipt remains a true record of what was observed, and
 * "expired" is a statement about now, not about the observation.
 *
 * The consequence is that {@link sweepLapsedPrerequisites} has no natural
 * once-only marker, and a sweep on a timer would re-announce the same lapse on
 * every tick. Rather than add a `lapse_announced_at` column (schema for what is
 * really an emission concern), the lapse event KEY is derived from the spent
 * receipt's own expiry instant — see {@link lapseEventKey}. Re-sweeping the same
 * lapse produces a byte-identical key, so the event layer's own dedupe/latch
 * collapses it; a genuinely NEW lapse (a re-probe succeeded, then that newer
 * receipt lapsed) has a different `expiresAt` and so is a different key and does
 * fire. Idempotency without state.
 */

import {
  buildAttestation,
  isPrerequisiteSatisfied,
  resolvePrerequisiteReadiness,
  type ExternalPrerequisiteAttestation,
  type ExternalPrerequisiteSpec,
  type PrerequisiteReadiness,
} from './external-prerequisites';

/**
 * What a probe adapter reports. A discriminated union for the same reason
 * readiness is one: so `indeterminate` cannot be silently coerced to either
 * real answer.
 *
 * P-004 ships the first two adapters (Stripe endpoint binding, Apple signing);
 * this module never implements one.
 */
export type ProbeOutcome =
  /** The capability is present. `binding` is fingerprint/binding metadata — never a credential. */
  | { readonly status: 'present'; readonly binding: Readonly<Record<string, string>> }
  /** The probe RAN and found the wall down. A positive, durable claim. */
  | { readonly status: 'absent'; readonly detail?: string }
  /** The probe could not determine the answer. Writes nothing. */
  | { readonly status: 'indeterminate'; readonly reason: string };

/** A probe: given a spec, report what it observes. Must not throw for "absent" — return it. */
export type ExternalPrerequisiteProbe = (
  spec: ExternalPrerequisiteSpec,
) => Promise<ProbeOutcome> | ProbeOutcome;

/** Resolves a spec's non-secret `probeRef` to an executable probe. */
export interface ProbeRegistry {
  resolve(probeRef: string): ExternalPrerequisiteProbe | undefined;
}

/** Build a registry from a plain record. */
export function createProbeRegistry(
  probes: Readonly<Record<string, ExternalPrerequisiteProbe>>,
): ProbeRegistry {
  return {
    resolve(probeRef: string): ExternalPrerequisiteProbe | undefined {
      return Object.prototype.hasOwnProperty.call(probes, probeRef) ? probes[probeRef] : undefined;
    },
  };
}

/** The lifecycle edge a run crossed. */
export type PrerequisiteTransition =
  /** Not standing (or unknown) -> standing. Fires `spec.completionEvent`. */
  | 'became-ready'
  /** Standing -> lapsed by time. Fires {@link lapseEventKey}. */
  | 'lapsed'
  /** Standing -> observed down. A regression, distinct from a lapse. */
  | 'regressed'
  /** No edge worth announcing. */
  | 'none';

/**
 * Side effects, injected. Each names the concrete surface P-005 binds it to, so
 * the wiring is a mapping exercise rather than a design one.
 */
export interface ProbeRunnerPorts {
  /** Read the stored receipt. P-005: SELECT from `harness_shared.external_prerequisite_attestations` + `rowToAttestation`. */
  loadAttestation(key: string): Promise<ExternalPrerequisiteAttestation | null>;
  /** Upsert the receipt. P-005: `attestationToRow` -> UPSERT on (workspace, harness, prerequisite_key). */
  saveAttestation(attestation: ExternalPrerequisiteAttestation): Promise<void>;
  /** Announce a lifecycle edge. P-005: `emitAwaitedEvent` from `lib/events/await/engine`. */
  emitEvent(event: {
    key: string;
    summary: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** Refresh the bound release-scorecard criterion. P-005: the scorecards emit surface. */
  refreshScorecardCriterion(refresh: {
    prerequisiteKey: string;
    owningWorkItem: string;
    readiness: PrerequisiteReadiness;
    satisfied: boolean;
  }): Promise<void>;
  /** Wake the lane owner accountable for the wall. P-005: `coord:send { wake }` to the work-item's holder. */
  wakeLaneOwner(wake: { owningWorkItem: string; summary: string }): Promise<void>;
}

/** The deterministic lapse key. See the idempotency note in the file header. */
export function lapseEventKey(spec: ExternalPrerequisiteSpec, spentExpiresAt: string): string {
  return `external-prerequisite:lapsed:${spec.key}:${spentExpiresAt}`;
}

/** The regression key — a wall observed DOWN, as opposed to a receipt timing out. */
export function regressionEventKey(spec: ExternalPrerequisiteSpec, observedAt: string): string {
  return `external-prerequisite:regressed:${spec.key}:${observedAt}`;
}

/** What one probe run did. Returned rather than thrown so a scope run can continue. */
export interface ProbeRunResult {
  readonly key: string;
  /** Readiness BEFORE this run, evaluated at the same instant as `readiness`. */
  readonly previous: PrerequisiteReadiness;
  /** Readiness AFTER this run. */
  readonly readiness: PrerequisiteReadiness;
  readonly satisfied: boolean;
  readonly transition: PrerequisiteTransition;
  /** True when this run wrote a receipt. False for every indeterminate outcome. */
  readonly attestationWritten: boolean;
  /** Set when the probe could not determine an answer, or a port failed. */
  readonly problem?: string;
}

/** Default ceiling on a single probe. An external wall that hangs must not hang the gate. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface RunProbeOptions {
  /** Evaluation instant. Injected so expiry is deterministic and one scope run uses ONE instant. */
  readonly nowMs: number;
  readonly timeoutMs?: number;
}

/** Run a probe under a deadline, converting every failure mode to `indeterminate`. */
async function executeProbe(
  probe: ExternalPrerequisiteProbe,
  spec: ExternalPrerequisiteSpec,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'indeterminate', reason: `probe timed out after ${timeoutMs}ms` }),
        timeoutMs,
      );
    });
    // Wrapped in Promise.resolve so a SYNCHRONOUS throw from a probe is caught
    // here too, rather than escaping past the race.
    const ran = (async () => probe(spec))();
    const outcome = await Promise.race([ran, timeout]);
    return normalizeOutcome(outcome);
  } catch (err) {
    return {
      status: 'indeterminate',
      reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Refuse to trust an adapter's shape. An adapter returning `undefined`, or a
 * status this module does not know, is INDETERMINATE — never a default-absent,
 * which would be exactly the coercion this file exists to prevent.
 */
function normalizeOutcome(outcome: ProbeOutcome | undefined | null): ProbeOutcome {
  if (!outcome || typeof outcome !== 'object') {
    return { status: 'indeterminate', reason: 'probe returned no outcome' };
  }
  if (outcome.status === 'present') {
    return { status: 'present', binding: outcome.binding ?? {} };
  }
  if (outcome.status === 'absent') return outcome;
  if (outcome.status === 'indeterminate') {
    return { status: 'indeterminate', reason: outcome.reason || 'unspecified' };
  }
  return {
    status: 'indeterminate',
    reason: `probe returned unrecognized status: ${String((outcome as { status?: unknown }).status)}`,
  };
}

/** Classify the lifecycle edge between two readiness verdicts. */
export function classifyTransition(
  previous: PrerequisiteReadiness,
  next: PrerequisiteReadiness,
): PrerequisiteTransition {
  const wasReady = previous.state === 'ready';
  const isReady = next.state === 'ready';
  // Recovery (expired->ready) counts as became-ready: the wall is standing again,
  // and whoever is blocked on it needs the same wake as a first-time success.
  if (!wasReady && isReady) return 'became-ready';
  if (wasReady && next.state === 'expired') return 'lapsed';
  if (wasReady && next.state === 'absent') return 'regressed';
  return 'none';
}

/**
 * Announce a transition. Every port failure is swallowed into the returned
 * problem string rather than thrown: by the time we are here the attestation is
 * already durable, and losing that write because a downstream emit failed would
 * be strictly worse than a missed announcement.
 */
async function announce(
  spec: ExternalPrerequisiteSpec,
  ports: ProbeRunnerPorts,
  transition: PrerequisiteTransition,
  readiness: PrerequisiteReadiness,
): Promise<string | undefined> {
  const satisfied = isPrerequisiteSatisfied(readiness);
  const problems: string[] = [];

  const safely = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (transition !== 'none') {
    const key =
      transition === 'became-ready'
        ? spec.completionEvent
        : transition === 'lapsed'
          ? lapseEventKey(spec, readiness.state === 'expired' ? readiness.expiredAt : '')
          : regressionEventKey(spec, new Date().toISOString());

    await safely('emitEvent', () =>
      ports.emitEvent({
        key,
        summary: `external prerequisite '${spec.key}' ${transition}`,
        payload: {
          prerequisiteKey: spec.key,
          capabilityKind: spec.capabilityKind,
          transition,
          state: readiness.state,
          owningWorkItem: spec.owningWorkItem,
        },
      }),
    );

    await safely('wakeLaneOwner', () =>
      ports.wakeLaneOwner({
        owningWorkItem: spec.owningWorkItem,
        summary: `external prerequisite '${spec.key}' ${transition} (${readiness.state})`,
      }),
    );
  }

  // The scorecard is refreshed on EVERY run, not only on a transition: a
  // criterion that is never re-stated goes stale, which is the exact "green
  // while the wall changed" failure this plan exists to close.
  await safely('refreshScorecardCriterion', () =>
    ports.refreshScorecardCriterion({
      prerequisiteKey: spec.key,
      owningWorkItem: spec.owningWorkItem,
      readiness,
      satisfied,
    }),
  );

  return problems.length > 0 ? problems.join('; ') : undefined;
}

/**
 * Probe one prerequisite and drive its lifecycle.
 *
 * Fails CLOSED throughout: every path that does not positively establish a live
 * receipt returns a readiness that {@link isPrerequisiteSatisfied} rejects.
 */
export async function runPrerequisiteProbe(
  spec: ExternalPrerequisiteSpec,
  registry: ProbeRegistry,
  ports: ProbeRunnerPorts,
  options: RunProbeOptions,
): Promise<ProbeRunResult> {
  const { nowMs } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Prior readiness is evaluated at the SAME instant as the new one, so a
  // transition can never be an artifact of two different clock reads.
  let stored: ExternalPrerequisiteAttestation | null = null;
  let loadProblem: string | undefined;
  try {
    stored = await ports.loadAttestation(spec.key);
  } catch (err) {
    loadProblem = `loadAttestation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const previous: PrerequisiteReadiness = loadProblem
    ? { state: 'unknown', reason: loadProblem }
    : resolvePrerequisiteReadiness(stored, nowMs);

  const probe = registry.resolve(spec.probeRef);
  if (!probe) {
    // An unregistered probeRef is NOT an absence — nothing observed the wall.
    const readiness: PrerequisiteReadiness = {
      state: 'unknown',
      reason: `no probe registered for probeRef '${spec.probeRef}'`,
    };
    const problem = await announce(spec, ports, 'none', readiness);
    return {
      key: spec.key,
      previous,
      readiness,
      satisfied: false,
      transition: 'none',
      attestationWritten: false,
      problem: [readiness.reason, problem].filter(Boolean).join('; '),
    };
  }

  const outcome = await executeProbe(probe, spec, timeoutMs);

  if (outcome.status === 'indeterminate') {
    // WRITE NOTHING. See the file header: an indeterminate probe must not be
    // durably recorded as an observed absence.
    const readiness: PrerequisiteReadiness = { state: 'unknown', reason: outcome.reason };
    const problem = await announce(spec, ports, 'none', readiness);
    return {
      key: spec.key,
      previous,
      readiness,
      satisfied: false,
      transition: 'none',
      attestationWritten: false,
      problem: [outcome.reason, problem].filter(Boolean).join('; '),
    };
  }

  // buildAttestation is the zero-secret chokepoint; a credential-shaped binding
  // throws here and is reported as a problem rather than being stored.
  let attestation: ExternalPrerequisiteAttestation;
  try {
    attestation = buildAttestation({
      key: spec.key,
      capabilityKind: spec.capabilityKind,
      present: outcome.status === 'present',
      binding: outcome.status === 'present' ? outcome.binding : {},
      observedAt: new Date(nowMs).toISOString(),
      expirySec: spec.expirySec,
      provenance: 'probe',
      probeRef: spec.probeRef,
    });
  } catch (err) {
    const reason = `attestation rejected: ${err instanceof Error ? err.message : String(err)}`;
    const readiness: PrerequisiteReadiness = { state: 'unknown', reason };
    const problem = await announce(spec, ports, 'none', readiness);
    return {
      key: spec.key,
      previous,
      readiness,
      satisfied: false,
      transition: 'none',
      attestationWritten: false,
      problem: [reason, problem].filter(Boolean).join('; '),
    };
  }

  let writeProblem: string | undefined;
  let attestationWritten = false;
  try {
    await ports.saveAttestation(attestation);
    attestationWritten = true;
  } catch (err) {
    writeProblem = `saveAttestation failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Readiness is resolved from the attestation we actually built. When the write
  // failed we report `unknown` rather than the in-memory verdict: a receipt that
  // did not land cannot be relied on by a later evaluation, and claiming `ready`
  // off an unpersisted value is the same silent widening in a new costume.
  const readiness: PrerequisiteReadiness = writeProblem
    ? { state: 'unknown', reason: writeProblem }
    : resolvePrerequisiteReadiness(attestation, nowMs);

  const transition = classifyTransition(previous, readiness);
  const announceProblem = await announce(spec, ports, transition, readiness);

  return {
    key: spec.key,
    previous,
    readiness,
    satisfied: isPrerequisiteSatisfied(readiness),
    transition,
    attestationWritten,
    problem: [writeProblem, announceProblem].filter(Boolean).join('; ') || undefined,
  };
}

/**
 * Probe every prerequisite in a scope against ONE instant.
 *
 * Runs sequentially and isolates failures: one wall's collapse must not prevent
 * the rest of the scope from being measured, or a gate would report a truncated
 * view as a complete one.
 */
export async function runPrerequisiteProbes(
  specs: readonly ExternalPrerequisiteSpec[],
  registry: ProbeRegistry,
  ports: ProbeRunnerPorts,
  options: RunProbeOptions,
): Promise<ProbeRunResult[]> {
  const results: ProbeRunResult[] = [];
  for (const spec of specs) {
    try {
      results.push(await runPrerequisiteProbe(spec, registry, ports, options));
    } catch (err) {
      // Defense in depth — runPrerequisiteProbe is written not to throw.
      const reason = `probe run threw: ${err instanceof Error ? err.message : String(err)}`;
      results.push({
        key: spec.key,
        previous: { state: 'unknown', reason },
        readiness: { state: 'unknown', reason },
        satisfied: false,
        transition: 'none',
        attestationWritten: false,
        problem: reason,
      });
    }
  }
  return results;
}

/** One lapse the sweep found and announced. */
export interface LapseSweepResult {
  readonly key: string;
  readonly expiredAt: string;
  readonly announced: boolean;
  readonly problem?: string;
}

/**
 * The staleness half of P-003.
 *
 * Expiry has no actor: no probe runs, nothing writes a row, and so without this
 * sweep a lapse is invisible until someone happens to evaluate the gate. That is
 * precisely the window in which "a scorecard stays green while the external wall
 * silently changed", so detecting the ready->expired edge on a cadence is what
 * closes it.
 *
 * Announcement is idempotent by key construction (see the file header), so this
 * is safe to call on a routine tick without a once-only marker.
 *
 * Note it does NOT re-probe and does NOT mutate the receipt: the stored row
 * remains a true record of what was observed. The sweep reports a lapse; a
 * re-probe is {@link runPrerequisiteProbe}'s job.
 */
export async function sweepLapsedPrerequisites(
  specs: readonly ExternalPrerequisiteSpec[],
  ports: ProbeRunnerPorts,
  options: { nowMs: number },
): Promise<LapseSweepResult[]> {
  const lapses: LapseSweepResult[] = [];
  for (const spec of specs) {
    let stored: ExternalPrerequisiteAttestation | null = null;
    try {
      stored = await ports.loadAttestation(spec.key);
    } catch (err) {
      lapses.push({
        key: spec.key,
        expiredAt: '',
        announced: false,
        problem: `loadAttestation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const readiness = resolvePrerequisiteReadiness(stored, options.nowMs);
    if (readiness.state !== 'expired') continue;

    const problem = await announce(spec, ports, 'lapsed', readiness);
    lapses.push({
      key: spec.key,
      expiredAt: readiness.expiredAt,
      announced: problem === undefined,
      problem,
    });
  }
  return lapses;
}
