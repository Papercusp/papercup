/**
 * The spawn-env patch that points a bee at the pacing gateway (hive-inference-gateway P-012).
 *
 * Pure + flag-evaluated by the caller (the spawn chokepoint), so the hot spawn path stays sync and
 * this stays trivially testable. When the `INFERENCE_GATEWAY` flag is ON, every bee spawn gets
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` → the `claude -p` subprocess sends UNAUTHENTICATED
 * to the localhost gateway, which paces + injects the bound account's OAuth. The bee keeps its
 * symlinked `~/.claude` credential (harmlessly ignored — the gateway strips + reinjects auth), so
 * flipping the flag OFF instantly reverts to direct egress with no other change.
 */
import { DEFAULT_GATEWAY_PORT } from './launch';

export const GATEWAY_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
/** The papercusp-specific override the in-process anthropic-direct SDK transport reads
 *  (chat-stream.ts `anthropicDirectTransport`), distinct from the standard `ANTHROPIC_BASE_URL`
 *  the `claude` CLI honors. */
export const GATEWAY_SDK_URL_ENV = 'PAPERCUSP_ANTHROPIC_URL';

/** The localhost gateway port (env override → default 8788). */
export function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_GATEWAY_PORT;
}

/**
 * The env patch to merge into a bee spawn's environment. `{}` when the gateway is disabled
 * (unchanged direct egress); `{ ANTHROPIC_BASE_URL }` when enabled. The caller passes the
 * resolved flag value so flag evaluation (PostHog / FLAG_DEFAULTS) stays at the chokepoint.
 */
export function gatewaySpawnEnv(enabled: boolean): Record<string, string> {
  if (!enabled) return {};
  return { [GATEWAY_BASE_URL_ENV]: `http://127.0.0.1:${gatewayPort()}` };
}

/**
 * The env patch for an IN-PROCESS caller that makes anthropic-direct SDK calls (the gym's
 * judge/proposer `llmCall`, FB-16). The spawn chokepoint only patches SPAWNED subprocesses, so an
 * in-process LLM call never receives `gatewaySpawnEnv`. This returns BOTH the standard
 * `ANTHROPIC_BASE_URL` (for any `claude` CLI subprocess the caller in turn spawns) and the
 * papercusp `PAPERCUSP_ANTHROPIC_URL` (read by `anthropicDirectTransport`) so every egress —
 * subprocess or in-process SDK — routes through the localhost pacing gateway. `{}` when disabled.
 */
export function gatewayLlmEnv(enabled: boolean): Record<string, string> {
  if (!enabled) return {};
  const url = `http://127.0.0.1:${gatewayPort()}`;
  return { [GATEWAY_BASE_URL_ENV]: url, [GATEWAY_SDK_URL_ENV]: url };
}
