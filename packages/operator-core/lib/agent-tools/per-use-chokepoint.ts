/** P-007 shared target-bound admission. Hosted verification and funding belong
 * to the authenticated turn host; this dispatch path does no hosted IO. */
import type { DispatchProjectedDeps } from '@papercusp/agent-mcp';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { readInstalledPluginProvenance } from '../cupboard/install-plugin-core';
import { bindInstalledPerUseOffer, readHostedPerUseOffers, readHostedToolEntitlements,
  type HostedPerUseOffer, type MeteredTransportDeps } from '../cupboard/metered-invocation-door-io';
import { readInstalledPluginCommerceProvenance } from '../cupboard/install-io';
import type { FundedToolTurnHost } from '../cupboard/funded-turn-host';
import type { FundedToolTurnBinding, FundedToolTurnResult } from '../cupboard/funded-tool-turn-store';
import type { InstalledPluginProvenance } from '../cupboard/types';
import { declareMeter, LocalMeteredTurnRefusedError, type LocalMeteredTurn } from '../p2p/metered-invocation';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];

/** Host-owned capability from once-per-turn authenticated admission. The host
 * must verify the installed provenance, entitlement and funding, retain durable
 * local CAS/outbox state, and withdraw admission on revocation. Never build this
 * from invocation arguments or treat a LocalMeteredTurn as funding evidence. */
export interface AdmittedPerUseToolTurn {
  readonly kind: 'per-use';
  readonly workspaceId: string;
  readonly principalId: string;
  readonly payer: string;
  readonly provenance: InstalledPluginProvenance;
  readonly offer: HostedPerUseOffer;
  readonly entitled: boolean;
  readonly turn: LocalMeteredTurn;
}

export interface VerifiedFreeToolAdmission {
  readonly kind: 'free';
  readonly workspaceId: string;
  readonly principalId: string;
  readonly provenance: InstalledPluginProvenance;
}

/** Host-only installation composition. Keep the installed loader outside the
 * leaf monetary host: the Worker also compiles that host and must not pull in
 * operator runtime, plugin loaders or UI types. No invocation args grant this
 * capability. The native/app lifecycle owns all resolvers and withdraws the
 * returned local lease on revocation with turn.stopAdmission(). */
export async function admitInstalledPerUseToolTurn(input: {
  host: Pick<FundedToolTurnHost, 'admit' | 'localTurn'>;
  payerTransport: MeteredTransportDeps;
  context: Pick<FundedToolTurnBinding, 'workspaceId' | 'ownerId' | 'principalId' | 'executionId' | 'admissionId'>;
  installation: Parameters<typeof readInstalledPluginCommerceProvenance>[0];
  /** Omitted: use the hosted bearer principal. A host may select an authorized
   * organization; invocation arguments cannot provide this resolver. */
  resolvePayer?: () => Promise<string>;
  resolveFunding: (offer: HostedPerUseOffer) => Promise<Pick<FundedToolTurnBinding, 'channelId' | 'quantityCeiling' | 'expiresAtMs'>>;
  readProvenance?: typeof readInstalledPluginCommerceProvenance;
}): Promise<{ ok: true; admission: AdmittedPerUseToolTurn; turnId: string } | Extract<FundedToolTurnResult, { ok: false }>> {
  const context = structuredClone(input.context), installation = structuredClone(input.installation);
  const loaded = await (input.readProvenance ?? readInstalledPluginCommerceProvenance)(installation);
  if (!loaded) return { ok: false, code: 'installation-binding-required', detail: 'exact installed commerce provenance is required' };
  const provenance = structuredClone(loaded), requestedPayer = await input.resolvePayer?.();
  const catalog = await readHostedPerUseOffers(input.payerTransport);
  if (!catalog.ok) return catalog;
  const bound = bindInstalledPerUseOffer(provenance, catalog.offers);
  if (!bound.ok) return bound;
  const entitlement = await readHostedToolEntitlements(requestedPayer, input.payerTransport);
  if (!entitlement.ok) return entitlement;
  if (!entitlement.productIds.includes(bound.offer.productId)) return { ok: false, code: 'tool-entitlement-required', detail: 'authenticated buyer has no active entitlement' };
  const payer = entitlement.payer;
  const funding = await input.resolveFunding(structuredClone(bound.offer));
  const binding: FundedToolTurnBinding = { ...context, kind: 'tool', payer, seller: bound.offer.creatorId,
    channelId: funding.channelId, quantityCeiling: funding.quantityCeiling, expiresAtMs: funding.expiresAtMs,
    offer: bound.offer, provenanceHash: createHash('sha256').update(canonicalJson(provenance)).digest('hex') };
  const admitted = await input.host.admit(binding);
  if (!admitted.ok) return admitted;
  return { ok: true, turnId: admitted.turn.turnId, admission: { kind: 'per-use', ...context, payer,
    provenance, offer: bound.offer, entitled: true, turn: input.host.localTurn(admitted.turn) } };
}

const refuse = (code: string, detail: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: JSON.stringify({ error: code, detail }) }],
});

export function createInstalledPerUseChokepoint(deps: {
  readProvenance?: typeof readInstalledPluginProvenance;
  /** Process-local lookup of ALREADY admitted authority, never hosted per-call IO. */
  resolveAdmittedTurn?: (request: Request) => AdmittedPerUseToolTurn | VerifiedFreeToolAdmission | null;
} = {}): NonNullable<DispatchProjectedDeps['aroundInvoke']> {
  return async (request) => {
    const installation = request.tool.pluginInstallation;
    if (!installation) return request.invoke();
    let provenance: InstalledPluginProvenance | null;
    try {
      provenance = await (deps.readProvenance ?? readInstalledPluginProvenance)({
        name: request.tool.pluginName, version: installation.version, path: installation.path,
      });
    } catch (error) {
      return refuse('installation_provenance_invalid', error instanceof Error ? error.message : String(error));
    }
    if (!provenance) return request.invoke();

    const principal = request.ctx.principal;
    if (!principal || !['trusted', 'verified'].includes(principal.trust ?? '') ||
        !principal.slug || !principal.workspaceId || principal.workspaceId === '*' ||
        (request.ctx.workspaceId !== undefined && request.ctx.workspaceId !== principal.workspaceId)) {
      return refuse('authenticated_tool_payer_required', 'Paid tools need the authenticated target principal in its workspace');
    }
    const admitted = deps.resolveAdmittedTurn?.(request);
    if (!admitted) return refuse(provenance.listing.priceModel === 'per-use'
      ? 'funded_tool_turn_required' : 'verified_tool_admission_required',
    'The host has not verified this installation and admitted its target');
    if (admitted.workspaceId !== principal.workspaceId || admitted.principalId !== principal.slug ||
        canonicalJson(admitted.provenance) !== canonicalJson(provenance)) {
      return refuse('tool_turn_binding_mismatch', 'Admission differs from this target principal or loaded installation');
    }
    // A locally edited receipt saying "free" cannot bypass hosted admission.
    if (admitted.kind === 'free') {
      return provenance.listing.priceModel === 'free' ? request.invoke()
        : refuse('tool_turn_binding_mismatch', 'Free admission differs from the installed pricing');
    }
    if (!admitted.entitled) return refuse('tool_entitlement_required', 'The admitted buyer has no active entitlement');
    const bound = bindInstalledPerUseOffer(provenance, [admitted.offer]);
    if (!bound.ok) return refuse(bound.code, bound.detail);
    const declared = declareMeter(bound.offer.terms);
    if (!declared.ok) return refuse(declared.code, declared.detail);
    if (declared.meter.meterUnit !== 'tool-call') {
      return refuse('unsupported_tool_meter', 'An invocation charge requires a published tool-call meter');
    }
    const state = admitted.turn.snapshot();
    if (!admitted.payer.trim() || state.payer !== admitted.payer ||
        state.seller !== bound.offer.creatorId || state.releaseRef !== bound.offer.skuRef ||
        canonicalJson({ ...state.meter, unitPriceMicros: String(state.meter.unitPriceMicros) }) !==
          canonicalJson({ ...declared.meter, unitPriceMicros: String(declared.meter.unitPriceMicros) }) ||
        !request.callId.trim()) {
      return refuse('tool_turn_binding_mismatch', 'The funded meter differs from the exact installed offer');
    }
    try {
      return await admitted.turn.invoke({ payer: state.payer, releaseRef: state.releaseRef,
        usageNonce: request.callId, quantity: 1n }, request.invoke);
    } catch (error) {
      if (error instanceof LocalMeteredTurnRefusedError) return refuse(error.code, error.message);
      throw error;
    }
  };
}

// Until the authenticated native/app host supplies an admission provider, a
// Cupboard installation is refused. Tool arguments cannot supply that provider.
export const installedPerUseChokepoint = createInstalledPerUseChokepoint();
