/**
 * Test-only re-export of the private `validateKickoff` helper inside
 * the console-launch route. Kept in its own module so production code
 * never imports it; the route's surface stays clean.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-008.
 */

// eslint-disable-next-line import/no-internal-modules
export { __validateKickoffForTest as validateKickoffForTest } from '@/lib/endpoint-route/routes/agent-mcp/console-launch';
