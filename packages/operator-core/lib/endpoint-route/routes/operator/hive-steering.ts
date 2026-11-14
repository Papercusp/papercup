/**
 * GET /api/operator/hive-steering — the HTTP bridge for the oddsmith engine's
 * `pot:get-steering` (DOWN) leg (oddsmith P-020).
 *
 * The oddsmith trading engine reads owner/hive policy DOWN once per tick to learn
 * the kill-switch + its trading knobs (capital ceiling / watchlist / strategy
 * enable). It GETs here; this route returns {@link getOwnerSteering} — the SAME
 * internal accessor `pot:get-steering` uses — as the raw JSON the engine consumes.
 *
 * CONTRACT (mirrors the oddsmith bridge — `operator-bridge-wiring.ts` `getSteering`
 * + `engine/src/loop.ts` `RawHiveSteering` / `defaultMapSteering`): the engine reads
 * the response body's TOP-LEVEL fields
 *   { directive: string | null; pauseNewWork: boolean; pausedUntil: number | null; … }
 * — `pauseNewWork` / an unexpired `pausedUntil` map to the engine kill-switch, and
 * the trading knobs ride a fenced ```oddsmith-steering``` block the owner embeds in
 * the free-text `directive`. {@link OwnerSteering} carries exactly these fields at
 * the top level (extra native fields are ignored by the engine), so we return it
 * verbatim — NOT wrapped in an `{ ok, steering }` envelope.
 *
 * Hive + workspace resolve from defaults (the loopback sidecar carries no principal):
 * optional `?hive=` / `?workspace=` query overrides, else `activeWorkspaceId()` +
 * `resolvePotHomeSlug()` (PAPERCUSP_POT_HOME_SLUG).
 *
 * ADDITIVE + INERT: nothing GETs here until the oddsmith bridge is armed (its
 * `ODDSMITH_OPERATOR_URL` env is set in a later step), so mounting this route does
 * Read availability and provenance are additive in `steeringRead`. Legacy consumers
 * still receive the same top-level fields. Strict consumers must only replace policy
 * after an available read for their exact workspace and canonical pot. In particular,
 * an HTTP200 default on backend failure is NOT an authoritative policy clear.
 *
 * `auth: 'loopback'` — the engine sidecar is a local process; the host's dispatch
 * chokepoint rejects any non-loopback caller. No principal is required.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOwnerSteering, DEFAULT_OWNER_STEERING } from '../../../owner-steering';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolvePotHomeSlug } from '../../../pot/wake';
import { resolveFederatedPotScope } from '../../../federated-pot-scope';
import { getHiveBySlug } from '../../../hive-store';

export default defineTool({
  method: 'GET',
  path: '/operator/hive-steering',
  auth: 'loopback',
  // Polled once per trading tick — no audit signal per poll. Don't record it.
  sampleRate: 0,
  async handler(req) {
    let workspaceId: string | null = null;
    let potHomeSlug: string | null = null;
    const unavailable = () => Response.json({
      ...DEFAULT_OWNER_STEERING,
      steeringRead: { availability: 'unavailable', workspaceId, potHomeSlug },
    });
    try {
      const url = new URL(req.url);
      workspaceId = url.searchParams.get('workspace')?.trim() || activeWorkspaceId();
      const requestedPot = resolvePotHomeSlug(url.searchParams.get('hive'));
      if (!workspaceId || !requestedPot) return unavailable();
      // Unknown/foreign pot handles must not look like a successfully cleared policy.
      if (!await getHiveBySlug(workspaceId, requestedPot)) return unavailable();
      potHomeSlug = await resolveFederatedPotScope(workspaceId, requestedPot);
      const steering = await getOwnerSteering(workspaceId, potHomeSlug);
      return Response.json({
        ...steering,
        steeringRead: { availability: 'available', workspaceId, potHomeSlug },
      });
    } catch {
      return unavailable();
    }
  },
});
