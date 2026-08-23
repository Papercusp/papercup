/**
 * Hosted-control-plane HTTP profile.
 *
 * The local Server intentionally mounts the complete endpoint registry. The
 * internet-facing hosted control plane must use the opposite posture: an
 * explicit, reviewed allowlist where absence means "not mounted". Keeping the
 * profile separate also prevents a future local route added to ALL_ROUTES from
 * becoming remotely reachable by accident.
 *
 * This leaf is deliberately not wired into the local host. Hosted integration
 * chooses this profile explicitly once the hosted identity/session routes are
 * available.
 */
import { Hono } from 'hono';
import type { ZodTypeAny } from 'zod';
import type { RouteDefinition, RouteMethod } from './define-route';
import { registerRoute } from './define-route';
import { ALL_ROUTES } from './routes';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

export type HostedRouteAccess = 'public' | 'authenticated';

export interface HostedRouteAllowlistEntry {
  readonly method: RouteMethod;
  readonly path: string;
  readonly access: HostedRouteAccess;
}

/**
 * The initial hosted surface is intentionally tiny. Hosted identity,
 * organization, workspace, and entitlement routes are added here only after
 * their own implementations land and declare concrete permission checks.
 */
export const HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/health', access: 'public' },
  { method: 'GET', path: '/health/ready', access: 'public' },
] as const satisfies ReadonlyArray<HostedRouteAllowlistEntry>;

/** Local single-user authentication routes that can never enter this profile. */
export const HOSTED_FORBIDDEN_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/signup',
  'POST /auth/change-password',
  'GET /auth/me',
  'PATCH /auth/me',
]);

/** Local installation surfaces are likewise never valid hosted endpoints. */
const HOSTED_FORBIDDEN_PATH_PREFIXES = [
  '/cupboard/install-',
  '/desktop/install-',
  '/provision/',
] as const;

function routeKey(route: Pick<AnyRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function isCatchAllPath(path: string): boolean {
  return path.includes('*') || /\{\.[+*]/.test(path) || path === '/:transport';
}

function assertAllowlistEntryIsSafe(entry: HostedRouteAllowlistEntry): void {
  const key = routeKey(entry);
  if (HOSTED_FORBIDDEN_ROUTE_KEYS.has(key)) {
    throw new Error(`hosted-profile: local authentication route is forbidden: ${key}`);
  }
  if (HOSTED_FORBIDDEN_PATH_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) {
    throw new Error(`hosted-profile: local installation route is forbidden: ${key}`);
  }
  if (isCatchAllPath(entry.path)) {
    throw new Error(`hosted-profile: catch-all routes cannot be allowlisted: ${key}`);
  }
}

function assertRouteAccess(route: AnyRoute, expected: HostedRouteAccess): void {
  const key = routeKey(route);
  if (expected === 'public') {
    if (route.auth !== 'public') {
      throw new Error(`hosted-profile: ${key} is allowlisted as public but declares a different auth tier`);
    }
    return;
  }

  if (typeof route.auth !== 'object' || route.auth === null) {
    throw new Error(`hosted-profile: ${key} must require an authenticated principal`);
  }
  const capabilities = route.auth.capabilities;
  if (!capabilities?.length) {
    throw new Error(`hosted-profile: ${key} must require at least one concrete capability`);
  }
  if (capabilities.includes('*')) {
    throw new Error(`hosted-profile: ${key} cannot require or admit wildcard capability authority`);
  }
}

/**
 * Resolve and validate the exact routes mounted by the hosted profile.
 *
 * Both arguments are injectable so focused security tests and later hosted
 * integration can exercise the profile without mutating the shared registry.
 */
export function selectHostedControlPlaneRoutes(
  routes: ReadonlyArray<AnyRoute>,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
): ReadonlyArray<AnyRoute> {
  const selected: AnyRoute[] = [];
  const allowlistedKeys = new Set<string>();

  for (const entry of allowlist) {
    assertAllowlistEntryIsSafe(entry);
    const key = routeKey(entry);
    if (allowlistedKeys.has(key)) {
      throw new Error(`hosted-profile: duplicate allowlist entry: ${key}`);
    }
    allowlistedKeys.add(key);

    const matches = routes.filter((route) => routeKey(route) === key);
    if (matches.length === 0) {
      throw new Error(`hosted-profile: allowlisted route is not registered: ${key}`);
    }
    if (matches.length > 1) {
      throw new Error(`hosted-profile: allowlisted route is ambiguous: ${key}`);
    }

    const route = matches[0];
    assertRouteAccess(route, entry.access);
    selected.push(route);
  }

  return selected;
}

/** Mount only the validated hosted allowlist onto an existing Hono app. */
export function registerHostedControlPlaneRoutes(
  app: Hono,
  routes: ReadonlyArray<AnyRoute> = ALL_ROUTES,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
): ReadonlyArray<AnyRoute> {
  const selected = selectHostedControlPlaneRoutes(routes, allowlist);
  for (const route of selected) registerRoute(app, route);
  return selected;
}

/** Create a default-deny `/api` app using the dedicated hosted profile. */
export function createHostedControlPlaneApp(
  routes: ReadonlyArray<AnyRoute> = ALL_ROUTES,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
): Hono {
  const app = new Hono().basePath('/api');
  registerHostedControlPlaneRoutes(app, routes, allowlist);
  return app;
}
