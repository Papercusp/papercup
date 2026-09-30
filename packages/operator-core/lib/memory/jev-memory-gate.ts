/**
 * Jev on the memory push path (plan jev-decision-model-integration-2026-09-29,
 * P-007 Log only; P-008 On). The owner's switch lives in jev-settings.ts (D-008).
 *
 * Decision D-012 measured this filter and did NOT adopt it: its answers moved
 * with candidate order (about 1 in 10 flipped when the order was reversed). So
 * the recommended default stays Off, and these modes exist only because the
 * owner asked for a working switch. The contract:
 *
 *  - effective `off` (mode off, OR no key stored) makes ZERO decision calls and
 *    returns before building anything, so the injection block is byte-identical
 *    to the pre-Jev system (D-009, pinned in jev-memory-gate.test.ts).
 *  - `shadow` (Log only) fires ONE request per turn and does not wait for it.
 *    Injection is never delayed or changed; the decision client's ledger hook
 *    records the call, including every P(yes), in decision_model_calls
 *    (consumer `memory-injection`). A would-drop is any P(yes) below the threshold.
 *  - `on` waits for the answer under the client's hard bound (400 ms) and returns
 *    which candidates to keep. Any inconclusive outcome (timeout, error, no key,
 *    malformed answer) fails OPEN: the caller keeps every candidate (D-002).
 *
 * Jev only filters; it never reorders and never authorizes anything (D-001).
 */
import type { DecisionClient } from '@papercusp/decision-model';

import { activeWorkspaceId } from '../workspace-registry';
import { admissionPYes, buildAdmissionRequest, type AdmissionEncoding } from './jev-admission-request';
import { ensureJevDecisionClient, resolveJevMemoryInjection, type JevMemoryInjectionResolution } from './jev-settings';

/** The ledger consumer label for push-path calls (the bench uses `memory-bench`). */
export const JEV_MEMORY_CONSUMER = 'memory-injection';

/**
 * The operating point D-012 measured as arm B: the production floor, then keep a
 * candidate when Jev's P(yes) >= 0.4, with the memory text in `state`. P-015 may
 * change these if a pre-registered re-run meets the full D-007 bar.
 */
export const JEV_MEMORY_ADMIT_THRESHOLD = 0.4;
export const JEV_MEMORY_ENCODING: AdmissionEncoding = 'state';

export interface JevGateCandidate {
  readonly id: string;
  readonly text: string;
}

export type JevMemoryGateResult =
  /** No call was made. */
  | { readonly effective: 'off' }
  /** Log only: the request was fired and nothing waits for it. */
  | { readonly effective: 'shadow'; readonly fired: boolean }
  /** On, answered: `keep` is index-aligned with the candidates. */
  | { readonly effective: 'on'; readonly outcome: 'answered'; readonly keep: readonly boolean[]; readonly scores: readonly number[] }
  /** On, no verdict: the caller keeps every candidate (fail open). */
  | { readonly effective: 'on'; readonly outcome: 'inconclusive'; readonly reason: string };

export interface JevMemoryGateDeps {
  readonly resolve: (workspaceId: string) => Promise<Pick<JevMemoryInjectionResolution, 'effective'>>;
  readonly client: () => DecisionClient;
}

const defaultDeps: JevMemoryGateDeps = {
  resolve: resolveJevMemoryInjection,
  client: ensureJevDecisionClient,
};

export interface JevMemoryGateInput {
  readonly workspaceId?: string;
  /** The recall query the candidates were retrieved for (the recent user turn text). */
  readonly message: string;
  /** Floor-admitted candidates in retrieval order. */
  readonly candidates: readonly JevGateCandidate[];
}

export async function runJevMemoryGate(input: JevMemoryGateInput, deps: JevMemoryGateDeps = defaultDeps): Promise<JevMemoryGateResult> {
  let effective: JevMemoryInjectionResolution['effective'];
  try {
    effective = (await deps.resolve(input.workspaceId ?? activeWorkspaceId())).effective;
  } catch {
    // An unreadable setting is not consent to call out: behave as Off.
    return { effective: 'off' };
  }
  if (effective === 'off') return { effective: 'off' };

  const candidates = input.candidates.filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0 || !input.message.trim()) {
    return effective === 'shadow' ? { effective, fired: false } : { effective, outcome: 'inconclusive', reason: 'no-candidates' };
  }

  const { request, questionIds } = buildAdmissionRequest(input.message, candidates, JEV_MEMORY_ENCODING);
  const options = { consumer: JEV_MEMORY_CONSUMER, subjectIds: candidates.map((c) => c.id) };

  if (effective === 'shadow') {
    // Fire and forget. decide() never throws for expected failures; the catch is
    // for the unexpected, so a shadow fault can never reach the turn.
    void Promise.resolve()
      .then(() => deps.client().decide(request, options))
      .catch(() => undefined);
    return { effective, fired: true };
  }

  try {
    const outcome = await deps.client().decide(request, options);
    const p = admissionPYes(outcome, questionIds);
    if ('failure' in p) return { effective, outcome: 'inconclusive', reason: p.failure };
    // `candidates` may be shorter than `input.candidates` (empty texts were never
    // asked about); map back so `keep` stays aligned with the caller's list.
    const byId = new Map(candidates.map((c, i) => [c.id, p.scores[i]]));
    const scores = input.candidates.map((c) => byId.get(c.id) ?? 1);
    return { effective, outcome: 'answered', scores, keep: scores.map((s) => s >= JEV_MEMORY_ADMIT_THRESHOLD) };
  } catch (e) {
    return { effective, outcome: 'inconclusive', reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
