/**
 * @module endpoint-route — the `defineRoute` projection.
 *
 * The endpoint-system's second projection (sibling to `defineTool`):
 * HTTP-native plumbing endpoints, mounted on the Hono app, with the
 * cross-cutting machinery (auth, input validation, timeout, telemetry,
 * uniform errors) — but deliberately NOT in the agent tool catalog.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

export {
  defineRoute,
  registerRoute,
  type RouteDefinition,
  type RouteContext,
  type RouteMethod,
  type RouteAuth,
} from './define-route';
export {
  runRouteStack,
  DEFAULT_ROUTE_STACK,
  type RouteStep,
  type RouteStepName,
  type RouteExecution,
} from './route-stack';
export { registerAllRoutes, registeredRouteCount } from './register';
export { ALL_ROUTES } from './routes';
export { routeToOpenApiFragment, allRouteFragments } from './openapi';
