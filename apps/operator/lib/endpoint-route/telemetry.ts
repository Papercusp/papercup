/**
 * Route-invocation telemetry.
 *
 * R1 ships this as a no-op stub so the route-stack has a stable seam to
 * call. Phase R2 implements `recordRouteInvocation` against the
 * `route_invocations` table (RFC Q1 — separate table, not
 * `tool_invocations`) and wires the `/dev → Sessions` route-traffic view.
 *
 * Kept in its own module so R2 is a single-file change with no
 * route-stack churn.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md §6 R2
 */

import type { RouteExecution } from './route-stack';

/**
 * Record one route invocation. R1: no-op. R2: writes a `route_invocations`
 * row honoring `def.sampleRate`.
 */
export function recordRouteInvocation(_exec: RouteExecution): void {
  // R1 stub — intentionally empty. R2 implements.
}
