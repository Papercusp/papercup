/**
 * Route registry barrel.
 *
 * Every `defineRoute` module is side-effect-free and `export default`s
 * either one `RouteDefinition` or an array of them (a route file that
 * serves multiple methods on one path — e.g. GET + OPTIONS). This barrel
 * imports them all and flattens into `ALL_ROUTES`.
 *
 * Add a route: drop a file under `routes/<family>/<name>.ts`, then add a
 * line here. Mirrors the `lib/agent-tools/index.ts` barrel pattern.
 *
 * R1 — 3 pilots. R4/R5 grow this to all 243 endpoints.
 */
import type { ZodTypeAny } from 'zod';
import type { RouteDefinition } from '../define-route';

import desktopVersion from './desktop/version';
import operatorDismissed from './agent-mcp/operator-dismissed';
import flagsWebhook from './flags/webhook';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function flatten(entry: AnyRoute | AnyRoute[]): AnyRoute[] {
  return Array.isArray(entry) ? entry : [entry];
}

/** Every registered route, flattened. The order here is the mount order. */
export const ALL_ROUTES: ReadonlyArray<AnyRoute> = [
  ...flatten(desktopVersion as AnyRoute | AnyRoute[]),
  ...flatten(operatorDismissed as AnyRoute),
  ...flatten(flagsWebhook as AnyRoute),
];
