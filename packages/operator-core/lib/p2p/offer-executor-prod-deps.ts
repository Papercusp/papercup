/**
 * p2p/offer-executor-prod-deps.ts — WI-1937 production implementation of the
 * two REQUIRED-with-no-default `OfferExecutorDeps` ports offer-executor.ts
 * leaves for the caller to inject: `applyCapabilityEnvelope` and
 * `launchSession`.
 *
 * Split out from offer-executor.ts itself (which stays pure/host-agnostic and
 * unit-tests against hand-rolled stubs) so the actual envelope + spawn wiring
 * lives next to what it wires INTO (capability-envelope/policy.ts,
 * fleet/operator-spawn.ts) rather than inside the pure execution engine.
 *
 * Sequencing note (leader decision, WI-1937, msg mre4g13q 2026-07-09,
 * UPDATED 2026-07-09 once step 7 landed): this module intentionally does NOT
 * edit capability-envelope/policy.ts — it only READS the exported
 * `ROLE_ENVELOPES` map. `applyCapabilityEnvelope` below is a FAIL-CLOSED
 * GUARD: it verifies (never mutates) that `ROLE_ENVELOPES['foreign-session']`
 * resolves to a genuine deny-all profile before permitting ANY foreign-work
 * spawn. Step 7 has now landed `denyCapabilities: ['*']` on that entry
 * (policy.ts) — the SHIPPING v1 policy, not a placeholder — so this guard now
 * RESOLVES rather than throws, and the spawn leg this module wires
 * (`launchSession`) is LIVE: every foreign session that actually launches
 * still runs under a default-deny-ALL capability envelope, confined further
 * by the P-105 sandbox tier. Any grant beyond deny-all is a separate,
 * explicitly owner-ratified follow-up work-item — never widened here.
 */
import { ROLE_ENVELOPES, matchesAny } from '../capability-envelope/policy';
import { spawnAgentInHarness } from '../fleet/operator-spawn';
import { ephemeralForeignHarnessSlug } from '../harness-registry';
import { buildForeignProcessEnv } from './sandbox/pg-credential-isolation';
import type { ForeignLaunchSpec, OfferExecutorDeps } from './offer-executor';

/**
 * C2: verify (never mutate) that `ROLE_ENVELOPES['foreign-session']` resolves
 * to a genuine deny-all profile before permitting ANY foreign-work spawn.
 * `denyCapabilities: ['*']` is the correct deny-all shape — an EMPTY
 * `allowCapabilities: []` does NOT deny anything (evaluateCapabilityEnvelope's
 * `env.allowCapabilities.length > 0` guard treats it as absent ⇒ default-allow;
 * this was the exact gotcha this WI's plan flagged and resolved by reading
 * evaluateCapabilityEnvelope's implementation directly, not by guessing).
 *
 * Throws (never returns a falsy "refused" value) so a caller that forgets to
 * check a return value can't accidentally launch unclamped — the offer-executor
 * pipeline doc comment already documents "an envelope failure parks the row".
 */
export async function applyCapabilityEnvelopeForForeignSession(spec: {
  sessionRole: 'foreign-session';
  offerId: string;
  workspaceId: string;
  fleetSlug: string;
}): Promise<void> {
  const env = ROLE_ENVELOPES[spec.sessionRole];
  const isDenyAll = !!env?.denyCapabilities && matchesAny('capability:anything-at-all', env.denyCapabilities);
  if (!isDenyAll) {
    throw new Error(
      `applyCapabilityEnvelope: ROLE_ENVELOPES['${spec.sessionRole}'] does not resolve to a deny-all ` +
        `envelope (expected denyCapabilities:['*']) — refusing to launch a foreign session unclamped ` +
        `(offer ${spec.offerId}, workspace ${spec.workspaceId}, fleet ${spec.fleetSlug}). This is the ` +
        `expected refusal until WI-1937 step 7 lands the deny-all ROLE_ENVELOPES entry — it is not a bug.`,
    );
  }
}

/**
 * D-001 `launchSession` — WI-1937 option B (leader steer, msg mre5tvu2
 * 2026-07-09): resolved.
 *
 * `spawnAgentInHarness` (fleet/operator-spawn.ts) — the ONE production spawn
 * chokepoint every other agent in this codebase goes through — resolves its
 * process cwd EXCLUSIVELY via `resolveProject(harnessSlug, workspaceId)`
 * against `harness_shared` project registry rows (`lib/harness-core.ts`).
 * There is NO parameter, extras key, or override path that lets a caller
 * spawn a real agent process cwd'd into an ARBITRARY filesystem path — and a
 * foreign-work clone (`ForeignLaunchSpec.clonePath`, produced by
 * `provisionForeignClone`, foreign-clone.ts) is exactly that: a standalone git
 * clone the offer-executor pipeline creates on the fly.
 *
 * The gap is closed WITHOUT any core-spawn-path change: `provisionForeignClone`
 * now registers an EPHEMERAL `harness_registry` row for the clone the moment
 * it's provisioned (foreign-clone.ts, `registerEphemeralForeignHarness`),
 * deregistered when the session is reaped (revocation-reaper.ts) or caught by
 * the orphan sweep (`sweepOrphanedEphemeralForeignHarnesses`) if that call was
 * missed. So by the time THIS function runs, `resolveProject` already finds
 * the clone under `ephemeralForeignHarnessSlug(spec.offer.offerId)` — this
 * just spawns into that slug like any other harness. Enumeration/listing
 * sites (`projects-lite.ts`, the default-harness inference in
 * `operator-spawn.ts`, `/api/harness/projects`) filter the row out via
 * `isEphemeralForeignProject` so it never leaks into human-facing UI; a
 * slug-scoped lookup — exactly what this does — is unaffected by design.
 *
 * WI-3786 P-105 WIRING (Phase 1 — §3.2 PG credential isolation):
 * `buildForeignProcessEnv` filters out admin-PG-shaped environment variables
 * (DATABASE_URL, PG* keys) so foreign sessions cannot inherit a live connection
 * string via env resolver fallbacks. The filtered vars are passed via extras
 * to ensure the spawned process sees the deny-all env posture.
 */
export async function launchForeignSession(spec: ForeignLaunchSpec): Promise<{ sessionId: string }> {
  const harness = ephemeralForeignHarnessSlug(spec.offer.offerId);
  
  // P-105 §3.2: build PG-filtered environment for the foreign session.
  // This is pure logic — no privilege needed, safe to run on any host.
  const filteredEnv = buildForeignProcessEnv(process.env);
  
  // Convert the filtered environment object to the extras array format (KEY=VALUE strings).
  // Only include variables that are explicitly set (not undefined).
  const pgEnvExtras = Object.entries(filteredEnv)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  
  const res = await spawnAgentInHarness({
    workspaceId: spec.workspace.workspaceId,
    harness,
    role: spec.sessionRole,
    fleet: { slug: spec.workspace.fleetSlug, role: spec.sessionRole },
    turnTrigger: 'p2p-foreign-offer',
    parentRole: 'p2p:offer-executor',
    // P-105: pass the filtered environment + presence label as extras.
    // The filtered env ensures admin-PG keys are stripped from the spawned process.
    extras: [
      `PAPERCUSP_FOREIGN_PRESENCE_LABEL=${spec.presenceLabel}`,
      ...pgEnvExtras,
    ],
  });
  if (!res.ok || !res.spawnId) {
    throw new Error(
      `launchForeignSession: spawnAgentInHarness refused for offer ${spec.offer.offerId} ` +
        `(harness=${harness}): ${res.error ?? 'no spawnId returned'}`,
    );
  }
  return { sessionId: res.spawnId };
}

/** Convenience composer for the ports this module owns. */
export function foreignSessionExecutorDeps(): Pick<OfferExecutorDeps, 'applyCapabilityEnvelope' | 'launchSession'> {
  return {
    applyCapabilityEnvelope: applyCapabilityEnvelopeForForeignSession,
    launchSession: launchForeignSession,
  };
}
