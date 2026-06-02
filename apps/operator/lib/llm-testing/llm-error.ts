/**
 * Typed LLM-call error (RB-006).
 *
 * `llmCall` (the gym judge / sim-user / generators) used to throw a bare `Error(message)` on a
 * failed turn, which a rate-limited judge turned into a thrown exception that aborted the WHOLE
 * A/B run. `LlmCallError` instead carries the classified `TurnError` so the A/B loop can tell a
 * `rate_limited` failure (pause + resume) from a permanent one (skip) — never crashing the run.
 *
 * Tiny by design (only a type-only dep on the agent taxonomy) so it can be imported by both the
 * concrete `llm-client` (which pulls in node/child_process) and the PURE `ab-runner`
 * orchestration unit without dragging the subprocess machinery into the latter.
 */
import type { TurnError } from '@papercusp/papercup-shared/agent';

export class LlmCallError extends Error {
  readonly turn: TurnError;
  constructor(turn: TurnError) {
    super(turn.message);
    this.name = 'LlmCallError';
    this.turn = turn;
  }
}

export function isLlmCallError(e: unknown): e is LlmCallError {
  return e instanceof LlmCallError;
}

export interface RateLimitInfo {
  resetAt?: number;
  retryAfterMs?: number;
}

/**
 * If `e` is a rate-limited / overloaded turn error, return its reset hints (so the caller can
 * wait-until-reset and resume); otherwise null. `overloaded` (529/5xx) is included because it,
 * like a 429, is a transient backpressure the gym should wait out rather than score as a result.
 */
export function rateLimitInfo(e: unknown): RateLimitInfo | null {
  if (e instanceof LlmCallError && (e.turn.class === 'rate_limited' || e.turn.class === 'overloaded')) {
    return { resetAt: e.turn.resetAt, retryAfterMs: e.turn.retryAfterMs };
  }
  return null;
}
