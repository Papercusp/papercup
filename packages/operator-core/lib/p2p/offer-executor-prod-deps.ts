/**
 * p2p/offer-executor-prod-deps.ts — WI-1937 production implementation of
 * ONE of the two REQUIRED-with-no-default `OfferExecutorDeps` ports
 * offer-executor.ts leaves for the caller to inject: `applyCapabilityEnvelope`.
 * `launchSession` is DELIBERATELY NOT implemented here yet — see the doc
 * comment below; a real architectural gap blocks it, not an ordering choice.
 *
 * Split out from offer-executor.ts itself (which stays pure/host-agnostic and
 * unit-tests against hand-rolled stubs) so the actual envelope wiring lives
 * next to what it wires INTO (capability-envelope/policy.ts) rather than
 * inside the pure execution engine.
 *
 * Sequencing note (leader decision, WI-1937, msg mre4g13q 2026-07-09): this
 * module intentionally does NOT edit capability-envelope/policy.ts — it only
 * READS the exported `ROLE_ENVELOPES` map. `applyCapabilityEnvelope` below is
 * a FAIL-CLOSED GUARD: until a genuine deny-all entry lands on
 * `ROLE_ENVELOPES['foreign-session']` (step 7 of the WI-1937 plan), this
 * throws on every call — so even once `launchSession` is eventually wired,
 * landing THIS module alone does not make the spawn leg live; it stays inert
 * until step 7 explicitly arms it. That is by design, not an oversight:
 * "OWNER-GATED... wire ONLY after..." holds all the way through this module.
 */
import { ROLE_ENVELOPES, matchesAny } from '../capability-envelope/policy';
import type { OfferExecutorDeps } from './offer-executor';

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
 * D-001 `launchSession` — INTENTIONALLY NOT IMPLEMENTED YET.
 *
 * `spawnAgentInHarness` (fleet/operator-spawn.ts) — the ONE production spawn
 * chokepoint every other agent in this codebase goes through — resolves its
 * process cwd EXCLUSIVELY via `resolveProject(harnessSlug, workspaceId)`
 * against `harness_shared` project registry rows (`lib/harness-core.ts`).
 * There is NO parameter, extras key, or override path that lets a caller
 * spawn a real agent process cwd'd into an ARBITRARY filesystem path — and a
 * foreign-work clone (`ForeignLaunchSpec.clonePath`, produced by
 * `provisionForeignClone`, foreign-clone.ts) is exactly that: a standalone git
 * clone the offer-executor pipeline creates on the fly, which
 * `foreign-clone.ts` confirms (grepped, no `harness_registry` / `resolveProject`
 * touch anywhere in it) is NEVER registered as a harness project.
 *
 * Wiring `launchSession` to `spawnAgentInHarness` today, with no harness
 * override, would spawn the foreign session into whatever the DEFAULT/explicit
 * local harness resolves to — silently running claimed peer work inside the
 * WRONG repository (this host's own tree, not the sandboxed foreign clone).
 * That is a correctness *and* security bug worse than refusing to wire it at
 * all, so this is left unimplemented on purpose rather than shipped wrong.
 *
 * Two ways to close this gap (need an owner/leader call, not a unilateral
 * pick — this changes the shared spawn chokepoint's contract):
 *   (A) extend `OperatorSpawnInput` / `spawnAgentInHarness` with an explicit
 *       project-path override for exactly this case (audited, still routed
 *       through the same admission/nursery/lock-domain machinery — the
 *       resolution step alone gets a second source), or
 *   (B) have `provisionForeignClone` register an EPHEMERAL `harness_registry`
 *       row for the clone (cleaned up when the ForeignWorkspace is reaped),
 *       so `resolveProject` finds it with zero core-spawn-path changes.
 * Flagged to the fleet leader (WI-1937) rather than decided here.
 */

/** Convenience composer for the ports this module owns. `launchSession` is
 *  DELIBERATELY OMITTED (see the doc comment above `applyCapabilityEnvelope`'s
 *  sibling export) — a caller assembling `OfferExecutorDeps` must supply it
 *  explicitly once the clonePath↔harness-registry gap above is resolved,
 *  rather than silently inheriting a wrong default from this module. */
export function foreignSessionExecutorDeps(): Pick<OfferExecutorDeps, 'applyCapabilityEnvelope'> {
  return {
    applyCapabilityEnvelope: applyCapabilityEnvelopeForForeignSession,
  };
}
