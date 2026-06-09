/**
 * cross-hive-transport — the signed wire layer for the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-003/P-004). Sits OVER the boundary logic
 * (cross-hive-boundary.ts admit+translate) and UNDER the federation transport.
 *
 *   send:    construct + Ed25519-sign an envelope addressed to a peer Hive (by pubkey),
 *            hand it to the transport; on failure it stays in the store-and-forward
 *            OUTBOX for retry (peer Hives go offline).
 *   receive: verify the sender Hive's signature against the claimed `fromHivePubkey`,
 *            then DISPATCH — a request (ask / work-request) goes through the boundary
 *            (load grants → admit → translate into B's substrate); a reply
 *            (answer / decline) is correlated back to the originating ask.
 *
 * The actual point-to-point hyperdht delivery is the federation layer
 * ([[shared-hive-federation-2026-06-08]], whose Hive-pubkey topic transport is
 * P-011-proven across machines); it is injected here as a `CrossHiveTransport` PORT, so
 * this whole layer is unit-testable in-process. Signing is also a PORT (`CrossHiveSigner`
 * = `signWithHiveKey` in production) since the private key is keychain-held.
 */
import { verifyEd25519 } from './identity/ed25519';
import {
  routeCrossHiveEnvelope,
  type CrossHiveEnvelope,
  type CrossHiveGrant,
  type CrossHiveBoundaryPorts,
  type CrossHiveRouteResult,
} from './cross-hive-boundary';

/** Request kinds carried inbound through the boundary (grant-gated). */
export type CrossHiveRequestKind = 'ask' | 'work-request';
/** Reply kinds flowing back to the originating Hive (correlated, not grant-gated). */
export type CrossHiveReplyKind = 'answer' | 'decline';
export type CrossHiveWireKind = CrossHiveRequestKind | CrossHiveReplyKind;

const REQUEST_KINDS: readonly CrossHiveWireKind[] = ['ask', 'work-request'];
export function isRequestKind(k: CrossHiveWireKind): k is CrossHiveRequestKind {
  return REQUEST_KINDS.includes(k);
}

/** The unsigned body of a directed Hive→Hive envelope. */
export interface CrossHiveEnvelopeBody {
  /** Stable envelope id (for outbox dedup + reply correlation). */
  id: string;
  fromHivePubkey: string;
  toHivePubkey: string;
  kind: CrossHiveWireKind;
  subject: string;
  body: string;
  /** For a reply: the `id` of the request it answers. */
  correlationId?: string;
}

/** A signed wire envelope (body + base64 Ed25519 sig by the sending Hive's key). */
export interface CrossHiveWireEnvelope extends CrossHiveEnvelopeBody {
  sig: string;
}

/**
 * Deterministic signing bytes — JSON of the body fields in a FIXED order (sig excluded),
 * mirroring hiveAnnounceSigningBytes. Optional fields are included only when present so
 * the bytes are stable across versions. Sender + receiver must produce identical bytes.
 */
export function crossHiveSigningBytes(body: CrossHiveEnvelopeBody): Buffer {
  const ordered: Record<string, unknown> = {
    id: body.id,
    fromHivePubkey: body.fromHivePubkey,
    toHivePubkey: body.toHivePubkey,
    kind: body.kind,
    subject: body.subject,
    body: body.body,
  };
  if (typeof body.correlationId === 'string') ordered.correlationId = body.correlationId;
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

/** Signs the canonical bytes. Production: `(b) => signWithHiveKey(ws, hiveSlug, b)`. */
export type CrossHiveSigner = (bytes: Buffer) => Promise<Buffer>;

/** Sign a body into a wire envelope. */
export async function signCrossHiveEnvelope(
  body: CrossHiveEnvelopeBody,
  signer: CrossHiveSigner,
): Promise<CrossHiveWireEnvelope> {
  const sig = await signer(crossHiveSigningBytes(body));
  return { ...body, sig: sig.toString('base64') };
}

/** Verify a wire envelope's signature against its claimed sending Hive pubkey. Never throws. */
export function verifyCrossHiveEnvelope(env: CrossHiveWireEnvelope): boolean {
  if (!env || typeof env.sig !== 'string' || env.sig.length === 0) return false;
  return verifyEd25519(crossHiveSigningBytes(env), env.fromHivePubkey, Buffer.from(env.sig, 'base64'));
}

/* ── Transport + store-and-forward ─────────────────────────────────────────────── */

/** The point-to-point delivery PORT (production: hyperdht dial-by-Hive-pubkey). */
export interface CrossHiveTransport {
  /** Deliver an envelope to the peer Hive. Rejects if the peer is unreachable. */
  send(toHivePubkey: string, env: CrossHiveWireEnvelope): Promise<void>;
  /** Register the inbound handler (the federation layer calls it per received envelope). */
  subscribe(handler: (env: CrossHiveWireEnvelope) => Promise<void>): void;
}

/** Store-and-forward outbox PORT — survives a peer being offline (production: a PG table). */
export interface CrossHiveOutbox {
  enqueue(env: CrossHiveWireEnvelope): Promise<void>;
  pending(): Promise<CrossHiveWireEnvelope[]>;
  markDelivered(id: string): Promise<void>;
}

/** A simple in-process outbox — the unit-test + single-process default. */
export class InMemoryCrossHiveOutbox implements CrossHiveOutbox {
  private readonly q = new Map<string, CrossHiveWireEnvelope>();
  async enqueue(env: CrossHiveWireEnvelope): Promise<void> {
    this.q.set(env.id, env);
  }
  async pending(): Promise<CrossHiveWireEnvelope[]> {
    return [...this.q.values()];
  }
  async markDelivered(id: string): Promise<void> {
    this.q.delete(id);
  }
}

export interface SendResult {
  delivered: boolean;
  /** Queued in the outbox for retry (peer unreachable). */
  queued: boolean;
}

/**
 * Send an envelope with store-and-forward: enqueue, attempt delivery, mark delivered on
 * success; on failure it stays queued for a later `flushCrossHiveOutbox`. Always durable
 * first (enqueue before send) so a crash mid-send never loses the message.
 */
export async function sendCrossHive(
  env: CrossHiveWireEnvelope,
  deps: { transport: CrossHiveTransport; outbox: CrossHiveOutbox },
): Promise<SendResult> {
  await deps.outbox.enqueue(env);
  try {
    await deps.transport.send(env.toHivePubkey, env);
    await deps.outbox.markDelivered(env.id);
    return { delivered: true, queued: false };
  } catch {
    return { delivered: false, queued: true };
  }
}

/** Retry every queued envelope. Returns how many delivered + how many remain pending. */
export async function flushCrossHiveOutbox(deps: {
  transport: CrossHiveTransport;
  outbox: CrossHiveOutbox;
}): Promise<{ delivered: number; pending: number }> {
  let delivered = 0;
  for (const env of await deps.outbox.pending()) {
    try {
      await deps.transport.send(env.toHivePubkey, env);
      await deps.outbox.markDelivered(env.id);
      delivered += 1;
    } catch {
      /* still unreachable — leave it queued */
    }
  }
  return { delivered, pending: (await deps.outbox.pending()).length };
}

/* ── Receive ───────────────────────────────────────────────────────────────────── */

export type CrossHiveReceiveResult =
  | { ok: false; reason: string }
  | { kind: 'request'; route: CrossHiveRouteResult }
  | { kind: 'reply'; replyKind: CrossHiveReplyKind; correlationId: string | null; subject: string; body: string };

export interface ReceiveDeps {
  /** THIS Hive's pubkey — an envelope not addressed to us is rejected. */
  selfHivePubkey: string;
  /** Load this Hive's admission grants (production: `loadCrossHiveGrants(ws, hiveSlug)`). */
  loadGrants: () => Promise<readonly CrossHiveGrant[]>;
  /** Translate an admitted REQUEST into a B-side object (boundary ports). */
  requestPorts: CrossHiveBoundaryPorts;
}

/**
 * Handle one received wire envelope: verify the sender's signature, then dispatch. A
 * request (ask / work-request) goes through the boundary (admit via this Hive's grants →
 * translate). A reply (answer / decline) is surfaced for the originator to correlate to
 * its pending ask. A bad signature or an envelope not addressed to us is rejected before
 * any side effect.
 */
export async function receiveCrossHive(
  env: CrossHiveWireEnvelope,
  deps: ReceiveDeps,
): Promise<CrossHiveReceiveResult> {
  if (env.toHivePubkey !== deps.selfHivePubkey) {
    return { ok: false, reason: 'envelope not addressed to this Hive' };
  }
  if (!verifyCrossHiveEnvelope(env)) {
    return { ok: false, reason: 'signature verification failed' };
  }
  if (isRequestKind(env.kind)) {
    const grants = await deps.loadGrants();
    const request: CrossHiveEnvelope = {
      fromHivePubkey: env.fromHivePubkey,
      toHivePubkey: env.toHivePubkey,
      kind: env.kind,
      subject: env.subject,
      body: env.body,
      sig: env.sig,
    };
    const route = await routeCrossHiveEnvelope(
      request,
      { selfHivePubkey: deps.selfHivePubkey, grants },
      deps.requestPorts,
    );
    return { kind: 'request', route };
  }
  return {
    kind: 'reply',
    replyKind: env.kind,
    correlationId: env.correlationId ?? null,
    subject: env.subject,
    body: env.body,
  };
}
