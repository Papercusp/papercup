/**
 * cross-hive-ask-send — the front-door SEND composition behind `hive:ask` and
 * `hive:request_work` (hive-network-surface-2026-06-11 P-003, brief B-04).
 *
 * One initiating-side pipeline, shared by both tools (they differ only by
 * `kind`): outbound-grant check → resolve THIS Hive's live boundary → sign + send
 * the request envelope (store-and-forward, durable) → record the outbound ask in
 * the C-1 ledger. The returned `correlationId` is the join key the asking Queen
 * awaits — a later answer/decline from the peer comes back through the boot-wired
 * boundary (B-03), which transitions the ledger row and emits
 * `cross-hive:answered:<correlationId>` / `cross-hive:declined:<correlationId>`
 * (contract C-4). So the Queen's loop is: send → `events:await` the answered key.
 *
 * Every collaborator is an injected PORT so this is unit-testable without a swarm,
 * PG, or the grants store, and so the not-yet-landed pieces (B-02 store, B-05
 * outbound enforcement) swap in by changing only the production deps factory.
 */
import { randomUUID } from 'node:crypto';
import type { CrossHiveBoundaryWiring } from './cross-hive-wiring';
import type { CrossHiveRequestKind } from './cross-hive-transport';
import type { CrossHiveAsksStore } from './cross-hive-asks-store-port';

/** Decide whether THIS Hive may send `kind` to `peerPubkey` (outbound grant — B-05). */
export type CheckOutboundGrant = (
  workspaceId: string,
  hiveSlug: string,
  peerPubkey: string,
  kind: CrossHiveRequestKind,
) => Promise<{ allowed: boolean; reason: string }>;

export interface SendCrossHiveAskDeps {
  /** Resolve this Hive's live, boot-wired boundary (the registry getter). */
  resolveBoundary: (
    workspaceId: string,
    hiveSlug: string,
  ) => CrossHiveBoundaryWiring | undefined | Promise<CrossHiveBoundaryWiring | undefined>;
  /** Outbound admission policy (B-05). Default: stub-allow until B-05 lands. */
  checkOutboundGrant: CheckOutboundGrant;
  /** The C-1 ledger store (B-02). */
  store: CrossHiveAsksStore;
  /** Correlation / envelope id generator (injected for deterministic tests). */
  newId?: () => string;
}

export interface SendCrossHiveAskInput {
  workspaceId: string;
  /** THIS (asking) Hive's home slug — grants, signer and boundary are scoped to it. */
  hiveSlug: string;
  /** The target peer Hive's pubkey (from `discovery:hives`). */
  peerPubkey: string;
  kind: CrossHiveRequestKind;
  subject: string;
  body: string;
}

export type SendCrossHiveAskResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      correlationId: string;
      kind: CrossHiveRequestKind;
      peerPubkey: string;
      /** `sent` = delivered now; `queued` = peer offline, durable outbox will retry. */
      state: 'sent' | 'queued';
      delivered: boolean;
      /** The event key to `events:await` for the peer's answer (contract C-4). */
      answeredEvent: string;
      /** The event key emitted if the peer declines (contract C-4). */
      declinedEvent: string;
    };

/**
 * Compose one outbound cross-Hive request. Order matches the plan: grant → send →
 * ledger enqueue. The signed envelope's id IS the correlation id, so the peer's
 * reply (whose `correlationId` echoes it) correlates back to this ledger row.
 */
export async function sendCrossHiveAsk(
  input: SendCrossHiveAskInput,
  deps: SendCrossHiveAskDeps,
): Promise<SendCrossHiveAskResult> {
  const { workspaceId, hiveSlug, peerPubkey, kind, subject, body } = input;

  // 1. Outbound admission: default-deny to peers this Hive hasn't been granted
  //    outbound (B-05). The stub default allows; B-05 swaps in real enforcement.
  const grant = await deps.checkOutboundGrant(workspaceId, hiveSlug, peerPubkey, kind);
  if (!grant.allowed) {
    return { ok: false, reason: grant.reason };
  }

  // 2. Resolve the live boundary. A dark/unpublished/pre-boot Hive has none — we
  //    never construct a duplicate transport, so this is a hard, clear failure.
  const boundary = await deps.resolveBoundary(workspaceId, hiveSlug);
  if (!boundary) {
    return {
      ok: false,
      reason: `cross-Hive boundary for '${hiveSlug}' is not live — publish the Hive (only directory-published Hives wire a boundary) and ensure the operator has booted`,
    };
  }

  // 3. Sign + send (durable store-and-forward). The envelope id is the correlation id.
  const correlationId = (deps.newId ?? randomUUID)();
  const sendResult = await boundary.send(peerPubkey, { id: correlationId, kind, subject, body });
  const state: 'sent' | 'queued' = sendResult.delivered ? 'sent' : 'queued';

  // 4. Record the outbound ask in the C-1 ledger (durable asking-side record).
  await deps.store.insertCrossHiveAsk(workspaceId, hiveSlug, {
    id: correlationId,
    peerPubkey,
    direction: 'out',
    kind,
    subject,
    body,
    correlationId,
    state,
  });

  return {
    ok: true,
    correlationId,
    kind,
    peerPubkey,
    state,
    delivered: sendResult.delivered,
    answeredEvent: `cross-hive:answered:${correlationId}`,
    declinedEvent: `cross-hive:declined:${correlationId}`,
  };
}

/**
 * The interim outbound-grant check: ALLOW everything, with a reason noting that
 * real enforcement is pending brief B-05. Swapped for B-05's direction-aware
 * `cross-hive-grants` enforcement in the production deps factory once it lands.
 */
export const stubAllowOutboundGrant: CheckOutboundGrant = async () => ({
  allowed: true,
  reason: 'outbound grant enforcement pending brief B-05 (stub-allow)',
});
