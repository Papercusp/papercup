/**
 * cross-hive-boundary — the mediated Hive→Hive boundary (hive-coordination-model
 * D-004/D-005). A Hive-A agent addresses **Hive B** (never a B agent); the envelope
 * lands at B's boundary, which ADMITS it per B's owner-set capability grants and
 * TRANSLATES it into a B-side object routed by B's ORDINARY substrate — an `ask`
 * becomes a conversation; a `work-request` becomes a work_item in B's backlog. There is
 * NO special cross-Hive router: once admitted+translated it is just normal B work, and
 * the Queen steers its priority. The mediation IS the sovereignty boundary — A cannot
 * commandeer B's agents, read B's coordination, or jump B's priorities.
 *
 * THIS module is the boundary LOGIC (admission + translation), composing B's existing
 * surfaces (conversations / work_items). The TRANSPORT that DELIVERS an envelope from A
 * to B (dial Hive B by pubkey over hyperdht) is the federation layer
 * ([[shared-hive-federation-2026-06-08]]); it hands a received envelope to
 * `routeCrossHiveEnvelope`. Grant PERSISTENCE + the live cross-machine/cross-Hive E2E
 * are tracked in [[cross-hive-boundary-2026-06-08]]. Pure admission ⇒ unit-testable
 * without PG; routing is decoupled via ports.
 */
import { createWorkItem } from './work-items';
import { openConversation } from './agent-tools/coordination/conversations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The kinds a cross-Hive envelope may carry (D-004's MVP: ask / work-request). */
export type CrossHiveKind = 'ask' | 'work-request';

/** A directed Hive→Hive message — the boundary's unit. Addressed by Hive pubkey. */
export interface CrossHiveEnvelope {
  /** Sending Hive's pubkey (from the discovery directory). */
  fromHivePubkey: string;
  /** Receiving Hive's pubkey — an envelope not addressed to THIS Hive is rejected. */
  toHivePubkey: string;
  kind: CrossHiveKind;
  subject: string;
  body: string;
  /**
   * Ed25519 signature by the sending Hive's key. The boundary checks PRESENCE; full
   * cryptographic verification against the sender's directory pubkey is the transport
   * layer's responsibility before it hands the envelope here.
   */
  sig: string;
}

/**
 * An owner-set capability grant: which peer-Hive may send which kinds INTO this Hive.
 * Trust is per-peer-Hive + revocable (the Hive-granularity analog of contributor
 * admission). The absence of a grant is a hard reject — admission is allow-list, not
 * deny-list.
 */
export interface CrossHiveGrant {
  peerHivePubkey: string;
  allowedKinds: readonly CrossHiveKind[];
}

export interface CrossHiveAdmission {
  admitted: boolean;
  reason: string;
}

export interface AdmitOpts {
  /** THIS Hive's pubkey. */
  selfHivePubkey: string;
  /** The owner-set capability grants for inbound peer-Hives. */
  grants: readonly CrossHiveGrant[];
}

/**
 * Decide whether an inbound cross-Hive envelope is admitted. Pure. Rejects when: not
 * addressed to this Hive, unsigned, no grant for the sending Hive, or the grant does
 * not cover the envelope's kind.
 */
export function admitCrossHiveEnvelope(env: CrossHiveEnvelope, opts: AdmitOpts): CrossHiveAdmission {
  if (env.toHivePubkey !== opts.selfHivePubkey) {
    return { admitted: false, reason: 'envelope not addressed to this Hive' };
  }
  if (!env.sig || env.sig.length === 0) {
    return { admitted: false, reason: 'unsigned envelope' };
  }
  const grant = opts.grants.find((g) => g.peerHivePubkey === env.fromHivePubkey);
  if (!grant) {
    return { admitted: false, reason: `no capability grant for Hive ${env.fromHivePubkey}` };
  }
  if (!grant.allowedKinds.includes(env.kind)) {
    return { admitted: false, reason: `Hive ${env.fromHivePubkey} is not granted '${env.kind}'` };
  }
  return { admitted: true, reason: 'admitted by capability grant' };
}

/** A pending OUTBOUND request — which peer Hive we want to send which kind to. */
export interface OutboundCrossHiveRequest {
  /** The peer Hive we are sending to (its directory pubkey). */
  toHivePubkey: string;
  kind: CrossHiveKind;
}

export interface OutboundAdmitOpts {
  /** This Hive's owner-set OUTBOUND grants — which peer-Hives we may send which kinds TO. */
  grants: readonly CrossHiveGrant[];
}

/**
 * Decide whether an OUTBOUND cross-Hive request is permitted to leave this Hive. The
 * egress twin of {@link admitCrossHiveEnvelope}: default-deny, allow-list. Rejects when
 * there is no outbound grant for the destination Hive, or the grant does not cover the
 * request's kind. Pure — the send path loads `grants` via `loadOutboundCrossHiveGrants`.
 */
export function admitOutboundCrossHive(
  req: OutboundCrossHiveRequest,
  opts: OutboundAdmitOpts,
): CrossHiveAdmission {
  const grant = opts.grants.find((g) => g.peerHivePubkey === req.toHivePubkey);
  if (!grant) {
    return {
      admitted: false,
      reason: `no outbound grant for Hive ${req.toHivePubkey} — the owner must grant it first`,
    };
  }
  if (!grant.allowedKinds.includes(req.kind)) {
    return { admitted: false, reason: `Hive ${req.toHivePubkey} is not granted outbound '${req.kind}'` };
  }
  return { admitted: true, reason: 'admitted by outbound capability grant' };
}

/**
 * Ports that translate an ADMITTED envelope into a B-side object via B's ORDINARY
 * substrate. Injected so the boundary logic is testable without PG and so the
 * translation reuses (never forks) B's normal conversation/work-item surfaces.
 */
export interface CrossHiveBoundaryPorts {
  /** ask → a B-side conversation. Returns the created object's ref. */
  openAsk(env: CrossHiveEnvelope): Promise<{ ref: string }>;
  /** work-request → a B-side work_item in B's backlog. Returns the created object's ref. */
  createWorkRequest(env: CrossHiveEnvelope): Promise<{ ref: string }>;
}

export interface CrossHiveRouteResult {
  admitted: boolean;
  reason: string;
  /** What B-side object the admitted envelope became (when admitted). */
  action?: 'conversation' | 'work_item';
  ref?: string;
}

/**
 * Admit an inbound cross-Hive envelope and, if admitted, translate it into a B-side
 * object via B's ordinary substrate (the ports). A rejected envelope touches no port.
 */
export async function routeCrossHiveEnvelope(
  env: CrossHiveEnvelope,
  opts: AdmitOpts,
  ports: CrossHiveBoundaryPorts,
): Promise<CrossHiveRouteResult> {
  const adm = admitCrossHiveEnvelope(env, opts);
  if (!adm.admitted) return { admitted: false, reason: adm.reason };
  if (env.kind === 'ask') {
    const { ref } = await ports.openAsk(env);
    return { admitted: true, reason: adm.reason, action: 'conversation', ref };
  }
  const { ref } = await ports.createWorkRequest(env);
  return { admitted: true, reason: adm.reason, action: 'work_item', ref };
}

/** A short, human-readable tag for the sending Hive (envelopes carry full pubkeys). */
function peerTag(pubkey: string): string {
  return pubkey.slice(0, 8);
}

/**
 * Live ports: translate via B's REAL substrate. An `ask` opens a conversation (B's
 * agents route it via topics/subscriptions); a `work-request` mints a `change`
 * work_item in B's backlog (B's Queen triages/prioritizes it like any other work).
 */
export function makeLiveBoundaryPorts(opts: { identity: AgentIdentity; harness?: string }): CrossHiveBoundaryPorts {
  return {
    async openAsk(env) {
      const res = await openConversation(opts.identity, {
        kind: 'question',
        title: `[cross-Hive ask · ${peerTag(env.fromHivePubkey)}] ${env.subject}`,
        body: env.body,
        ...(opts.harness ? { harness_slug: opts.harness } : {}),
      });
      return { ref: res.conversation.id };
    },
    async createWorkRequest(env) {
      const wi = await createWorkItem({
        kind: 'change',
        title: `[cross-Hive request · ${peerTag(env.fromHivePubkey)}] ${env.subject}`,
        summary: env.body,
        ...(opts.harness ? { harness: opts.harness } : {}),
        createdBy: `hive:${peerTag(env.fromHivePubkey)}`,
      });
      return { ref: wi.id };
    },
  };
}
