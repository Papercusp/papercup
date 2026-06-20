/**
 * Stateful glue around the PURE `gateway-wedge` detector (B-GW-5). The detector confirms the
 * TEMPORAL half of the wedge signature (frozen `totalRequests`) by comparing the current `/stats`
 * against a recent PRIOR sample — this module holds that prior across the periodic system-health
 * recomputes (the ~30s-2min health tick / liveness-alarm loop), so the tokens panel can surface a
 * confirmed wedge without re-implementing the watchdog's freeze logic.
 *
 * Kept OUT of `gateway-wedge.ts` (which stays pure + trivially testable) and OUT of `compute.ts`
 * (which stays a stateless aggregator). The only mutable state is one rolling sample per operator
 * worker — a metric cache, not durable state (the gateway is a separate process; an operator
 * restart simply re-baselines, and the standalone watchdog owns the real-time freeze→restart).
 *
 * The prior is refreshed at most once per `SAMPLE_MIN_INTERVAL_MS` so two near-simultaneous health
 * computes (the background tick + an on-demand UI read) can't churn it into a ~0s-old prior that
 * would false-confirm a freeze.
 */
import {
  detectGatewayWedge,
  sampleGateway,
  type GatewayMetrics,
  type GatewaySample,
  type GatewayWedgeVerdict,
} from '../inference-gateway/gateway-wedge';

/** Don't refresh the prior more often than this — keeps it a meaningful PREVIOUS tick, not a
 *  sub-second echo of the current read. Roughly one health-tick; below the watchdog's 120s freeze. */
export const SAMPLE_MIN_INTERVAL_MS = 15_000;

let priorSample: GatewaySample | undefined;

/**
 * Run the wedge/throttle detector against `metrics`, using the module's rolling prior to confirm a
 * freeze, then (rate-limited) advance the prior. Pure detection + a thin stateful prior — returns the
 * full verdict for the tokens panel.
 */
export function readGatewayWedge(metrics: GatewayMetrics, now: number): GatewayWedgeVerdict {
  const verdict = detectGatewayWedge(metrics, priorSample, now);
  // Advance the rolling prior only once per interval (and always on the first reading).
  if (priorSample === undefined || now - priorSample.at >= SAMPLE_MIN_INTERVAL_MS) {
    priorSample = sampleGateway(metrics, now);
  }
  return verdict;
}

/** Test seam — reset the rolling prior so cases don't bleed across each other. */
export function __resetGatewaySampleCacheForTests(): void {
  priorSample = undefined;
}
