/**
 * cross-hive-wiring — the production composition of the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-006). Wires the four pieces this plan built
 * into one live boundary for a Hive:
 *
 *   transport (cross-hive-swarm-transport, dials peer Hives by pubkey over the
 *     real Hyperswarm)
 *   ↓ receive
 *   receiveCrossHive (verify sig → load THIS Hive's grants → admit → translate)
 *     · loadGrants = loadCrossHiveGrants(ws, hiveSlug)  ← the P-002 grant store
 *     · requestPorts = makeLiveBoundaryPorts(...)        ← ask→conversation / work-request→work_item
 *     · replies (answer/decline) persist to the C-1 ask ledger + fire the C-4
 *       event `cross-hive:answered|declined:<correlationId>` (+ coord notify to
 *       the asking owner) — hive-network-surface-2026-06-11 P-002 / brief B-03
 *   ↑ send
 *   sendCrossHive + a durable PG outbox (PgCrossHiveOutbox) ← store-and-forward
 *
 * This is the call-site that finally binds the boundary's `loadGrants` PORT to the
 * persisted owner-set grants (the seam P-002 left for "the live wiring"), and the
 * transport's inbound listener to `receiveCrossHive`. Everything is injectable so
 * the composition is testable with a fake transport / fake ports / a test PG
 * client; production supplies the real swarm, the Hive signer, and PG.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import { makeSwarmCrossHiveTransport } from './cross-hive-swarm-transport';
import {
  receiveCrossHive,
  sendCrossHive,
  flushCrossHiveOutbox,
  signCrossHiveEnvelope,
  isRequestKind,
  crossHiveReplyEventKey,
  InMemoryCrossHiveOutbox,
  type CrossHiveAskLedger,
  type CrossHiveTransport,
  type CrossHiveOutbox,
  type CrossHiveSigner,
  type CrossHiveRequestKind,
  type CrossHiveReplyKind,
  type CrossHiveWireEnvelope,
  type SendResult,
} from './cross-hive-transport';
import { emitAwaitedEvent, type EmitAwaitedEventOpts } from './events/await/engine';
import {
  makeLiveBoundaryPorts,
  admitOutboundCrossHive,
  type CrossHiveBoundaryPorts,
  type CrossHiveGrant,
} from './cross-hive-boundary';
import { loadCrossHiveGrants, loadOutboundCrossHiveGrants } from './cross-hive-grants';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import { PgCrossHiveAsks } from './cross-hive-asks-pg';
import { signWithHiveKey } from './identity/hive-keypair';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** An inbound reply (answer/decline) surfaced to the originator for correlation. */
export interface CrossHiveInboundReply {
  replyKind: CrossHiveReplyKind;
  correlationId: string | null;
  subject: string;
  body: string;
}

/**
 * The result of a send attempt. Extends {@link SendResult} with the default-deny
 * outcome: an outbound REQUEST to a peer this Hive has no `out` grant for is `denied`
 * (never enqueued, signed, or transmitted) rather than delivered/queued.
 */
export interface CrossHiveSendOutcome extends SendResult {
  /** True when the egress grant check rejected the request before any send. */
  denied?: boolean;
  /** Human-readable reason (set when denied). */
  reason?: string;
}

export interface CrossHiveBoundaryWiring {
  /** This Hive's pubkey (the dial address peers use to reach us). */
  readonly selfHivePubkey: string;
  /**
   * Send a request (ask | work-request) to a peer Hive — signed + store-and-forward.
   * Default-deny: rejected with `{ denied: true }` unless the owner granted this Hive an
   * `out` capability for the destination + kind (admitOutboundCrossHive).
   */
  send(
    toHivePubkey: string,
    msg: { kind: CrossHiveRequestKind; subject: string; body: string; id?: string },
  ): Promise<CrossHiveSendOutcome>;
  /** Reply (answer | decline) to a peer Hive, correlated to its originating request. */
  reply(
    toHivePubkey: string,
    msg: { kind: CrossHiveReplyKind; subject: string; body: string; correlationId: string; id?: string },
  ): Promise<CrossHiveSendOutcome>;
  /** Retry the durable outbox (peer was offline). */
  flushOutbox(): Promise<{ delivered: number; pending: number }>;
  /** Tear down the transport. */
  close(): Promise<void>;
}

export interface WireCrossHiveBoundaryDeps {
  workspaceId: string;
  /** This Hive's home slug (grants + outbox + signer are scoped to it). */
  hiveSlug: string;
  /** This Hive's Ed25519 identity pubkey (base64) — the dial address. */
  hivePubkey: string;
  /** The shared process swarm (getSharedSwarm()). Required unless `transport` is injected. */
  swarm?: HyperswarmLike;
  /** Sign bytes with the Hive key. Default: `b => signWithHiveKey(ws, hiveSlug, b)`. */
  signer?: CrossHiveSigner;
  /** Translate an admitted request into a B-side object. Default: makeLiveBoundaryPorts. */
  requestPorts?: CrossHiveBoundaryPorts;
  /** Identity for the default live ports (required if requestPorts is not injected + you want live routing). */
  identity?: AgentIdentity;
  /** The harness an admitted work-request/conversation lands in (default ports). */
  harness?: string;
  /** Load THIS Hive's admission grants. Default: loadCrossHiveGrants(ws, hiveSlug). */
  loadGrants?: () => Promise<readonly CrossHiveGrant[]>;
  /**
   * Load THIS Hive's OUTBOUND egress grants (the send-path default-deny policy).
   * Default: loadOutboundCrossHiveGrants(ws, hiveSlug).
   */
  loadOutboundGrants?: () => Promise<readonly CrossHiveGrant[]>;
  /** Durable outbox. Default: PgCrossHiveOutbox(ws, hiveSlug) (or in-memory if PG unavailable). */
  outbox?: CrossHiveOutbox;
  /** Injected transport (tests). Default: makeSwarmCrossHiveTransport over `swarm`. */
  transport?: CrossHiveTransport;
  /**
   * TEST-ONLY observer for inbound replies. The PRODUCTION reply path is durable:
   * persist to the C-1 ask ledger → emit the C-4 event (cross-hive:answered|declined:
   * <correlationId>) → coord notify/wake the asking owner. Do not build product
   * behavior on this callback.
   */
  onReply?: (reply: CrossHiveInboundReply) => void;
  /**
   * The C-1 ask ledger an inbound answer/decline persists into (hive-network-surface
   * P-002). Default: pgCrossHiveAskLedger over `cross_hive_asks` (migration 231).
   * The C-4 event fires ONLY on a real ledger transition — payload = the row — so a
   * forged correlationId from a non-asked peer can never wake the Queen.
   */
  askLedger?: CrossHiveAskLedger;
  /** Event emit port (production: emitAwaitedEvent). Tests inject a recorder. */
  emitEvent?: (opts: EmitAwaitedEventOpts) => Promise<unknown>;
  /** Optional test PG client threaded to grants + outbox. */
  sql?: Sql;
}

/**
 * Adapt the PG ask store (PgCrossHiveAsks, brief B-02) to the receive side's
 * CrossHiveAskLedger port, adding the PEER GUARD the port requires: only the asked
 * peer may settle an OUT ask. The store's recordReply matches by correlation_id
 * alone; peer_pubkey + direction are immutable columns, so the pre-check + transition
 * is race-safe — a signed reply from a third-party Hive lands `not-found` and never
 * transitions the row or wakes the asking Queen.
 */
export function pgCrossHiveAskLedger(workspaceId: string, hiveSlug: string, sql?: Sql): CrossHiveAskLedger {
  const store = new PgCrossHiveAsks(workspaceId, hiveSlug, sql);
  return {
    async recordReply(input) {
      const existing = await store.getByCorrelationId(input.correlationId);
      if (!existing || existing.direction !== 'out' || existing.peerPubkey !== input.peerPubkey) {
        return { outcome: 'not-found' };
      }
      const res = await store.recordReply({
        correlationId: input.correlationId,
        replyKind: input.replyKind,
        replyBody: input.replyBody,
      });
      if (res.outcome === 'applied') return { outcome: 'transitioned', row: res.ask };
      if (res.outcome === 'not-found') return { outcome: 'not-found' };
      // 'duplicate' (same reply redelivered) and 'conflict' (terminal in another
      // state) both mean the row is already settled — no re-emit.
      return { outcome: 'already-settled', row: res.ask };
    },
  };
}

/**
 * Compose the live cross-Hive boundary for a Hive. Subscribes the transport to
 * `receiveCrossHive` (verify → grant-driven admit → translate) and returns a
 * send/reply API backed by the durable outbox.
 */
export function wireCrossHiveBoundary(deps: WireCrossHiveBoundaryDeps): CrossHiveBoundaryWiring {
  const transport =
    deps.transport ??
    (() => {
      if (!deps.swarm) throw new Error('wireCrossHiveBoundary: swarm (or transport) is required');
      return makeSwarmCrossHiveTransport({ swarm: deps.swarm, selfHivePubkey: deps.hivePubkey });
    })();

  const signer: CrossHiveSigner =
    deps.signer ?? ((bytes) => signWithHiveKey(deps.workspaceId, deps.hiveSlug, bytes));

  const loadGrants =
    deps.loadGrants ?? (() => loadCrossHiveGrants(deps.workspaceId, deps.hiveSlug, deps.sql));

  const loadOutboundGrants =
    deps.loadOutboundGrants ?? (() => loadOutboundCrossHiveGrants(deps.workspaceId, deps.hiveSlug, deps.sql));

  const requestPorts: CrossHiveBoundaryPorts =
    deps.requestPorts ??
    (() => {
      if (!deps.identity) {
        throw new Error('wireCrossHiveBoundary: identity (or requestPorts) is required for live routing');
      }
      return makeLiveBoundaryPorts({ identity: deps.identity, ...(deps.harness ? { harness: deps.harness } : {}) });
    })();

  const outbox: CrossHiveOutbox =
    deps.outbox ??
    (deps.sql || deps.workspaceId
      ? new PgCrossHiveOutbox(deps.workspaceId, deps.hiveSlug, deps.sql)
      : new InMemoryCrossHiveOutbox());

  const askLedger = deps.askLedger ?? pgCrossHiveAskLedger(deps.workspaceId, deps.hiveSlug, deps.sql);
  const emitEvent = deps.emitEvent ?? emitAwaitedEvent;

  /**
   * The durable reply path (hive-network-surface P-002, brief B-03): persist the
   * answer/decline onto the originating OUT ask (C-1 transition), then fire the C-4
   * event — waking any events:await-ing Queen (durable, survives her restart) and
   * coord-notifying the asking owner when the row names one. Every failure is
   * contained: a ledger/emit error must never poison the transport's inbound loop,
   * and the ledger row (when written) stays the durable truth a `hive:asks` list
   * recovers from even if the emit is lost.
   */
  const persistAndEmitReply = async (
    env: CrossHiveWireEnvelope,
    res: { replyKind: CrossHiveReplyKind; correlationId: string | null; subject: string; body: string },
  ): Promise<void> => {
    if (!res.correlationId) {
      console.warn(`[cross-hive] reply from ${env.fromHivePubkey.slice(0, 8)}… has no correlationId — not persistable`);
      return;
    }
    let result;
    try {
      result = await askLedger.recordReply({
        correlationId: res.correlationId,
        replyKind: res.replyKind,
        replyBody: res.body,
        peerPubkey: env.fromHivePubkey,
      });
    } catch (e) {
      console.warn(`[cross-hive] ask-ledger recordReply failed for ${res.correlationId}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (result.outcome !== 'transitioned') {
      // 'already-settled' = a dup delivery (the outbox redelivers after a crash mid-send)
      // — the first arrival already emitted. 'not-found' = unsolicited / wrong peer / no
      // ledger yet — emitting would let a forged correlationId wake the asking Queen.
      return;
    }
    // An answered/declined row changes the board's ask counts + the dossier ask
    // log — push both (lazy fire-and-forget; a missing SSE bus is a no-op).
    void import('./sync-sse')
      .then((m) => {
        void m.notifySyncInvalidate('network.board').catch(() => {});
        void m.notifySyncInvalidate('network.hive.asks').catch(() => {});
      })
      .catch(() => {});
    try {
      await emitEvent({
        key: crossHiveReplyEventKey(res.replyKind, res.correlationId),
        payload: result.row,
        summary: `cross-hive ${res.replyKind} from ${env.fromHivePubkey.slice(0, 8)}… — ${res.subject}`,
        ...(result.row.askedBy ? { to: [result.row.askedBy] } : {}),
        source: `cross-hive:${deps.hiveSlug}`,
        workspaceId: deps.workspaceId,
      });
    } catch (e) {
      console.warn(`[cross-hive] C-4 emit failed for ${res.correlationId} (row persisted — hive:asks remains the truth): ${e instanceof Error ? e.message : e}`);
    }
  };

  // Inbound: verify → admit (per loaded grants) → translate; replies persist to the
  // ask ledger + fire the C-4 event (onReply is a test-only observer).
  transport.subscribe(async (env) => {
    const res = await receiveCrossHive(env, {
      selfHivePubkey: deps.hivePubkey,
      loadGrants,
      requestPorts,
    });
    if (res && 'kind' in res && res.kind === 'reply') {
      await persistAndEmitReply(env, res);
      deps.onReply?.({
        replyKind: res.replyKind,
        correlationId: res.correlationId,
        subject: res.subject,
        body: res.body,
      });
    }
  });

  const buildAndSend = async (
    toHivePubkey: string,
    body: {
      id: string;
      kind: CrossHiveRequestKind | CrossHiveReplyKind;
      subject: string;
      body: string;
      correlationId?: string;
    },
  ): Promise<CrossHiveSendOutcome> => {
    // Egress default-deny: an outbound REQUEST needs an `out` grant for the destination
    // Hive + kind. Replies (answer/decline) ride the originating request's correlation
    // and are never grant-gated. Denial happens BEFORE any enqueue/sign/send.
    if (isRequestKind(body.kind)) {
      const admission = admitOutboundCrossHive(
        { toHivePubkey, kind: body.kind },
        { grants: await loadOutboundGrants() },
      );
      if (!admission.admitted) {
        return { delivered: false, queued: false, denied: true, reason: admission.reason };
      }
    }
    const wire = await signCrossHiveEnvelope(
      {
        id: body.id,
        fromHivePubkey: deps.hivePubkey,
        toHivePubkey,
        kind: body.kind,
        subject: body.subject,
        body: body.body,
        ...(body.correlationId ? { correlationId: body.correlationId } : {}),
      },
      signer,
    );
    return sendCrossHive(wire, { transport, outbox });
  };

  return {
    selfHivePubkey: deps.hivePubkey,
    send(toHivePubkey, msg) {
      return buildAndSend(toHivePubkey, {
        id: msg.id ?? randomUUID(),
        kind: msg.kind,
        subject: msg.subject,
        body: msg.body,
      });
    },
    reply(toHivePubkey, msg) {
      return buildAndSend(toHivePubkey, {
        id: msg.id ?? randomUUID(),
        kind: msg.kind,
        subject: msg.subject,
        body: msg.body,
        correlationId: msg.correlationId,
      });
    },
    flushOutbox() {
      return flushCrossHiveOutbox({ transport, outbox });
    },
    async close() {
      const closable = transport as { close?: () => Promise<void> };
      if (typeof closable.close === 'function') await closable.close();
    },
  };
}
