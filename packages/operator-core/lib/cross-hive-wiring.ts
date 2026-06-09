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
  InMemoryCrossHiveOutbox,
  type CrossHiveTransport,
  type CrossHiveOutbox,
  type CrossHiveSigner,
  type CrossHiveRequestKind,
  type CrossHiveReplyKind,
  type SendResult,
} from './cross-hive-transport';
import {
  makeLiveBoundaryPorts,
  type CrossHiveBoundaryPorts,
  type CrossHiveGrant,
} from './cross-hive-boundary';
import { loadCrossHiveGrants } from './cross-hive-grants';
import { PgCrossHiveOutbox } from './cross-hive-outbox-pg';
import { signWithHiveKey } from './identity/hive-keypair';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** An inbound reply (answer/decline) surfaced to the originator for correlation. */
export interface CrossHiveInboundReply {
  replyKind: CrossHiveReplyKind;
  correlationId: string | null;
  subject: string;
  body: string;
}

export interface CrossHiveBoundaryWiring {
  /** This Hive's pubkey (the dial address peers use to reach us). */
  readonly selfHivePubkey: string;
  /** Send a request (ask | work-request) to a peer Hive — signed + store-and-forward. */
  send(
    toHivePubkey: string,
    msg: { kind: CrossHiveRequestKind; subject: string; body: string; id?: string },
  ): Promise<SendResult>;
  /** Reply (answer | decline) to a peer Hive, correlated to its originating request. */
  reply(
    toHivePubkey: string,
    msg: { kind: CrossHiveReplyKind; subject: string; body: string; correlationId: string; id?: string },
  ): Promise<SendResult>;
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
  /** Durable outbox. Default: PgCrossHiveOutbox(ws, hiveSlug) (or in-memory if PG unavailable). */
  outbox?: CrossHiveOutbox;
  /** Injected transport (tests). Default: makeSwarmCrossHiveTransport over `swarm`. */
  transport?: CrossHiveTransport;
  /** Surface an inbound reply (answer/decline) to the originator. */
  onReply?: (reply: CrossHiveInboundReply) => void;
  /** Optional test PG client threaded to grants + outbox. */
  sql?: Sql;
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

  // Inbound: verify → admit (per loaded grants) → translate; surface replies.
  transport.subscribe(async (env) => {
    const res = await receiveCrossHive(env, {
      selfHivePubkey: deps.hivePubkey,
      loadGrants,
      requestPorts,
    });
    if (res && 'kind' in res && res.kind === 'reply') {
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
  ): Promise<SendResult> => {
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
