/**
 * Resolve the distinctId used to evaluate feature flags for a given
 * request. For V1 we don't have per-user targeting, so a single
 * machine-stable id is sufficient and PostHog still records the eval.
 *
 * If we later wire identity (session cookie, auth header, etc.) into
 * the operator, this helper is the only place to update.
 */
import * as os from 'node:os';

const SYSTEM_ID = `papercusp-host-${os.hostname()}`;

export function resolveDistinctId(_req: Request): string {
  return SYSTEM_ID;
}

/**
 * The machine-stable distinctId, with no request in hand. Used by background /
 * non-request server code that still needs to evaluate a (machine-global) flag
 * — e.g. the lexicon brand-pack selector.
 */
export function systemDistinctId(): string {
  return SYSTEM_ID;
}
