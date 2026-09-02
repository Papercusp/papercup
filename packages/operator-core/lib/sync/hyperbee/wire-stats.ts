/**
 * wire-stats.ts — read the UDX wire counters off a Hyperswarm connection socket.
 *
 * Extracted from swarm.ts (which re-exports everything here, so its callers are
 * unchanged) so that LEAF consumers — topic-gossip.ts's severed-link liveness
 * predicate (P-203 / EI-22137294505377834) — can read a socket's inbound counters
 * without importing the whole swarm module graph (Corestore, pot-git serve/dial
 * wiring, resource profiles…). This file imports nothing.
 */

/**
 * EI-18682571591024156 — the UDX wire counters for one connection: the ONLY
 * evidence that the data path actually came up.
 *
 * The Noise handshake completes as a DHT RPC, so `secret-stream` attaches an
 * ALREADY-FINISHED session to a UDX stream that has carried ZERO bytes. A
 * connection that will send ~4.9KB, receive nothing, retransmit 10× and die on
 * RTO exhaustion 13s later is therefore indistinguishable at `connection` time
 * from one that works. `bytesReceived > 0` is what tells them apart.
 *
 * Same explicit-presence rule as swarm.ts's `PeerConnectionPath`: a
 * `bytesReceived: 0` synthesised for an unreadable stream would read as
 * "measured zero" — the exact confusion that makes this bug class expensive.
 */
export interface PeerWireStats {
  /** True only when the underlying raw stream exposed real counters. */
  present: boolean;
  bytesReceived?: number;
  bytesTransmitted?: number;
  packetsReceived?: number;
  rtoCount?: number;
  retransmits?: number;
}

/**
 * Read the UDX wire counters off a connection socket's raw stream (see
 * {@link PeerWireStats}). Never throws; `{ present: false }` when unreadable.
 */
export function readWireStats(socket: unknown): PeerWireStats {
  const raw = (socket as { rawStream?: Record<string, unknown> } | null | undefined)?.rawStream;
  if (!raw || typeof raw !== 'object') return { present: false };
  // Explicit per-field reads (no dynamic key write): a finite number is a real
  // reading and flips `present`; anything else stays ABSENT rather than 0.
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const bytesReceived = num(raw.bytesReceived);
  const bytesTransmitted = num(raw.bytesTransmitted);
  const packetsReceived = num(raw.packetsReceived);
  const rtoCount = num(raw.rtoCount);
  const retransmits = num(raw.retransmits);
  const present =
    bytesReceived !== undefined ||
    bytesTransmitted !== undefined ||
    packetsReceived !== undefined ||
    rtoCount !== undefined ||
    retransmits !== undefined;
  const out: PeerWireStats = { present };
  if (bytesReceived !== undefined) out.bytesReceived = bytesReceived;
  if (bytesTransmitted !== undefined) out.bytesTransmitted = bytesTransmitted;
  if (packetsReceived !== undefined) out.packetsReceived = packetsReceived;
  if (rtoCount !== undefined) out.rtoCount = rtoCount;
  if (retransmits !== undefined) out.retransmits = retransmits;
  return out;
}

/**
 * EI-18682571591024156 — has this connection DEMONSTRATED a working data path?
 *
 * `true` only on positive evidence (bytes actually received from the peer);
 * `false` on positive evidence of the opposite (readable counters, zero bytes
 * received); `null` when unknowable. Three states on purpose: collapsing
 * "unknown" into `false` would alarm on every test fake, and collapsing it into
 * `true` would re-create the overclaiming signal this fixes.
 */
export function dataPathProven(stats: PeerWireStats): boolean | null {
  if (!stats.present || stats.bytesReceived === undefined) return null;
  return stats.bytesReceived > 0;
}
