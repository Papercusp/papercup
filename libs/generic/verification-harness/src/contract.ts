/**
 * The verification-harness CONTRACT: what an expensive harness declares about itself so a
 * shared runner can give it structured per-phase results, one evidence dir per run,
 * phase-selective re-runs, and never-abort continuation.
 *
 * A harness is an ordered list of phases. A phase names the phases whose PASS it needs
 * (`dependsOn`); a dependency must be declared EARLIER, so declaration order is always a
 * valid execution order and a cycle cannot be written. A phase marked `reusable` is setup
 * whose passed result a later `--only` / `--from` run may take from a prior run's evidence
 * instead of paying for it again.
 */
import { GUARD_RAIL_TAG, type GuardRailReport } from './guard-rails.js';

export interface PhaseSpec {
  id: string;
  /** Phases whose pass (or reuse) this phase needs. Declared earlier than this phase. */
  dependsOn?: readonly string[];
  /** Setup whose passed result a selective re-run may reuse from a prior run. */
  reusable?: boolean;
  description?: string;
}

export interface HarnessContract {
  name: string;
  phases: readonly PhaseSpec[];
  /** Where this harness sits, for guard-rail selection: its preflight runs every probe sharing a tag. */
  scopeTags?: readonly string[];
}

/** passed · failed · blocked (a dependency did not pass) · skipped (not selected) · reused (prior run). */
export type PhaseStatus = 'passed' | 'failed' | 'blocked' | 'skipped' | 'reused';

export interface PhaseResult {
  phase: string;
  status: PhaseStatus;
  /** The last step the phase marked before it ended (null when it never marked one). */
  step: string | null;
  /** Machine-readable cause for any status other than passed. */
  reasonCode: string | null;
  detail?: string;
  evidenceDir: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number;
  /** Set when status is 'reused': the run whose passed result satisfied this phase. */
  reusedFromRunId?: string;
}

export type HarnessVerdict = 'pass' | 'fail' | 'preflight-failed';

export interface HarnessSelection {
  only: string[] | null;
  from: string | null;
}

export interface HarnessRunResult {
  schemaVersion: 1;
  harness: string;
  runId: string;
  evidenceDir: string;
  selection: HarnessSelection;
  reuseFromRunId: string | null;
  preflight: PhaseResult | null;
  phases: PhaseResult[];
  verdict: HarnessVerdict;
  firstFailure: { phase: string; step: string | null; reasonCode: string | null } | null;
  /** Guard rails checked in preflight; null when the harness declares no scope tags. */
  guardRails?: GuardRailReport | null;
  startedAt: string;
  endedAt: string | null;
}

export class HarnessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessContractError';
  }
}

/** Throws HarnessContractError on a duplicate id, an unknown dependency, or a forward reference. */
export function validateContract(contract: HarnessContract): void {
  if (!contract.name) throw new HarnessContractError('contract.name is required');
  if (contract.phases.length === 0) throw new HarnessContractError(`${contract.name}: no phases declared`);
  const badTag = (contract.scopeTags ?? []).find((t) => !GUARD_RAIL_TAG.test(t));
  if (badTag !== undefined) throw new HarnessContractError(`${contract.name}: invalid scope tag ${JSON.stringify(badTag)}`);
  const seen = new Set<string>();
  for (const p of contract.phases) {
    if (!p.id || /[\s,/]/.test(p.id)) {
      throw new HarnessContractError(`${contract.name}: invalid phase id ${JSON.stringify(p.id)} (no spaces, commas or slashes)`);
    }
    if (seen.has(p.id)) throw new HarnessContractError(`${contract.name}: duplicate phase id ${p.id}`);
    for (const d of p.dependsOn ?? []) {
      if (!contract.phases.some((q) => q.id === d)) {
        throw new HarnessContractError(`${contract.name}: phase ${p.id} depends on unknown phase ${d}`);
      }
      if (!seen.has(d)) {
        throw new HarnessContractError(`${contract.name}: phase ${p.id} depends on ${d}, which is declared later`);
      }
    }
    seen.add(p.id);
  }
}
