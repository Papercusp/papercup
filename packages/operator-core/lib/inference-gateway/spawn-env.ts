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
