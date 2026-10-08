/** P-017 trusted host orchestration over the existing hosted door and SQL CAS.
 * Call only from an authenticated native lifecycle with host-owned bindings and
 * a COMPLETE usage population. Tool arguments cannot supply these capabilities.
 */
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { SuCodexTurnAdmission, SuCodexTurnLifecycle } from '../su-session-usage';
import { usageReceiptSigningBytes } from '../p2p/metered-invocation';
import { FundedIdentityTurnStore, type FundedIdentityTurn, type FundedIdentityTurnBinding } from './funded-turn-store';
import { quoteIdentityInferenceTurn } from './identity-per-use-offer';
import { readChannelUsage, readHostedToolChannel, reserveMeteredUnit, settleMeteredUnit,
  type MeteredTransportDeps, type MeteredByteSigner } from './metered-invocation-door-io';

type Result = { readonly ok: true; readonly turn: FundedIdentityTurn } |
  { readonly ok: false; readonly code: string; readonly detail: string };
const fail = (code: string, detail: string): Result => ({ ok: false, code, detail });
const bindingBytes = (b: FundedIdentityTurnBinding): string =>
  canonicalJson({ ...b, inferenceCeilingMicros: String(b.inferenceCeilingMicros) });

export interface FundedIdentityTurnHostDeps {
  readonly store: FundedIdentityTurnStore;
  readonly payerTransport: MeteredTransportDeps;
  readonly sellerTransport: MeteredTransportDeps;
  readonly signVoucher: MeteredByteSigner;
  readonly signReceipt: MeteredByteSigner;
  readonly nowMs?: () => number;
  /** Trusted billing-reader seam; production uses the store's canonical reader. */
  readonly readUsage?: Parameters<FundedIdentityTurnStore['stageSettlement']>[3]['readUsage'];
}

export class FundedIdentityTurnHost {
  constructor(private readonly deps: FundedIdentityTurnHostDeps) {}

  /** Compose only at the authenticated native host. Resolvers must read the
   * current worn identity/funding and the COMPLETE native billed population;
   * neither may come from command arguments or an ingested-subset query. */
  nativeLifecycle(deps: {
    resolveAdmission: (context: Parameters<SuCodexTurnLifecycle['admit']>[0]) => Promise<
      { kind: 'unpriced' } | { kind: 'funded'; binding: FundedIdentityTurnBinding }>;
    resolveClosedPopulation: (input: { binding: FundedIdentityTurnBinding;
      status: string; completedAtMs: number }) => Promise<readonly string[]>;
    recordFailure: (input: { turnId: string; workspaceId: string } & Parameters<SuCodexTurnAdmission['reconcile']>[0]) => Promise<void>;
  }): SuCodexTurnLifecycle {
    return { admit: async (context) => {
      const resolved = await deps.resolveAdmission({ ...context });
      if (resolved.kind === 'unpriced') return { ok: true, bindNativeTurn: async () => {},
        complete: async () => {}, reconcile: async () => {} };
      const b = structuredClone(resolved.binding);
      if (b.workspaceId !== context.workspaceId || b.ownerId !== context.ownerId ||
          b.nativeSessionId !== context.nativeSessionId || b.admissionId !== context.ownerTurnId || b.nativeTurnId !== null) {
        return { ok: false, code: 'native-admission-binding-mismatch',
          message: 'The trusted funding binding does not match this exact host admission', retryable: false };
      }
      const admitted = await this.admit(b);
      if (!admitted.ok) return { ok: false, code: admitted.code, message: admitted.detail, retryable: false };
      const turnId = admitted.turn.turnId;
      return { ok: true,
        bindNativeTurn: async (nativeTurnId) => {
          const turn = await this.deps.store.read(b.workspaceId, turnId);
          if (!turn) throw new Error('The admitted monetary turn is unavailable');
          const bound = await this.deps.store.bindNativeTurn(b.workspaceId, turnId, turn.revision, nativeTurnId);
          if (!bound.ok) throw new Error(bound.code + ': ' + bound.detail);
        },
        complete: async ({ nativeTurnId, status, completedAtMs }) => {
          const turn = await this.deps.store.read(b.workspaceId, turnId);
          if (!turn || turn.binding.nativeTurnId !== nativeTurnId ||
              bindingBytes({ ...turn.binding, nativeTurnId: null }) !== bindingBytes(b)) {
            throw new Error('Native completion does not match the immutable monetary admission');
          }
          const original = structuredClone(turn.binding);
          const keys = await deps.resolveClosedPopulation({ binding: structuredClone(original), status, completedAtMs });
          const settled = await this.complete({ binding: original, turnId, usageEventKeys: keys, closedAtMs: completedAtMs });
          if (!settled.ok) throw new Error(settled.code + ': ' + settled.detail);
        },
        // The running/closed/outbox row already retains the monetary hold.
        // Record the failure through the host's durable recovery surface; no
        // failed native acknowledgement is evidence of zero billable usage.
        reconcile: async (failure) => deps.recordFailure({ turnId, workspaceId: b.workspaceId, ...failure }),
      };
    } };
  }

  /** An uncertain reserve never authorizes inference. A hosted read can resolve it. */
  async admit(input: FundedIdentityTurnBinding): Promise<Result> {
    const b = structuredClone(input), d = this.deps;
    const active = await d.store.readActive(b);
    if (!active.ok) return active;
    if (active.turn?.state === 'closed' || active.turn?.state === 'settlement-pending') {
      // Drive restart recovery before preparing another admission. Recovery
      // uses the old row, not the next session's identity/channel/closure.
      const recovered = await this.reconcileCompletion(b.workspaceId, active.turn.turnId);
      if (!recovered.ok) return recovered;
    }
    const prepared = await d.store.prepare(b);
    if (!prepared.ok) return prepared;
    let turn = prepared.turn;
    if (turn.state !== 'prepared' && turn.state !== 'funded') {
      return fail('turn-already-entered', 'native turn history forbids running inference again');
    }
    const channel = await readHostedToolChannel(b.channelId, b.payer, d.payerTransport);
    if (!channel.ok) return channel;
    if (turn.state === 'prepared') {
      const q = quoteIdentityInferenceTurn({ offer: b.offer, billedInferenceMicros: 0n,
        inferenceCeilingMicros: b.inferenceCeilingMicros });
      if (!q.ok) return q;
      // Deterministic nonce lets read-back recover a POST whose response was lost.
      const reserved = await reserveMeteredUnit({ channelId: b.channelId, offerId: b.offerId, terms: b.offer,
        payer: b.payer, seller: b.seller, releaseRef: b.offer.skuRef, usageNonce: turn.turnId,
        quantity: q.reservationQuantity, identityInferenceCeilingMicros: b.inferenceCeilingMicros,
        expiresAtMs: b.expiresAtMs, nowMs: (d.nowMs ?? Date.now)(), signVoucher: d.signVoucher }, d.payerTransport);
      // Even a 201 is re-read: the same contract handles duplicate and uncertain POSTs.
      const confirmed = await this.reconcileFunding(b.workspaceId, turn.turnId);
      if (!confirmed.ok && confirmed.code === 'funding-not-confirmed' && !reserved.ok) return reserved;
      if (!confirmed.ok) return confirmed;
      turn = confirmed.turn;
    } else {
      // Crash after funding but before entry: revalidate both reservation and origin.
      const confirmed = await this.reconcileFunding(b.workspaceId, turn.turnId);
      if (!confirmed.ok) return confirmed;
      turn = confirmed.turn;
    }
    return d.store.enter(b.workspaceId, turn.turnId, turn.revision, b, (d.nowMs ?? Date.now)());
  }

  /** Resolve a lost reservation acknowledgement without reserving again or
   * electing inference. Recovery uses the durable binding, never today's worn
   * identity. A missing/unreadable receipt retains the unresolved monetary hold. */
  async reconcileFunding(workspaceId: string, turnId: string): Promise<Result> {
    const d = this.deps, turn = await d.store.read(workspaceId, turnId);
    if (!turn) return fail('unknown-turn', 'no durable native admission exists');
    if (turn.state !== 'prepared' && turn.state !== 'funded') {
      return fail('invalid-turn-state', 'funding recovery requires an unentered native admission');
    }
    const b = turn.binding;
    const current = await readChannelUsage(b.channelId, d.payerTransport, b.offerId);
    if (!current.ok) return current;
    if (current.usage.channelId !== b.channelId || !Array.isArray(current.usage.receipts)) {
      return fail('invalid-hosted-usage', 'hosted channel history is unreadable');
    }
    const receipt = current.usage.receipts.find((r) => r.usageNonce === turnId);
    if (!receipt) return fail('funding-not-confirmed', 'hosted reservation is not confirmed; the admission remains held');
    if (!current.usage.identityMarkupOrigin) return fail('funding-origin-missing', 'hosted payer/offer origin is required');
    return d.store.confirmFunding(workspaceId, turnId, turn.revision, receipt, current.usage.identityMarkupOrigin);
  }

  /** Idempotent completion cannot change the exact population or closure time. */
  async complete(input: { readonly binding: FundedIdentityTurnBinding; readonly turnId: string;
    readonly usageEventKeys: readonly string[]; readonly closedAtMs: number }): Promise<Result> {
    const b = structuredClone(input.binding), keys = [...input.usageEventKeys].sort(), d = this.deps;
    const closedAtMs = input.closedAtMs;
    let turn = await d.store.read(b.workspaceId, input.turnId);
    if (!turn) return fail('unknown-turn', 'no admitted native turn exists');
    if (bindingBytes(b) !== bindingBytes(turn.binding)) return fail('turn-binding-changed', 'completion must retain the original admission binding');
    if (turn.state === 'running') {
      const closed = await d.store.close(b.workspaceId, turn.turnId, turn.revision, keys, closedAtMs);
      if (!closed.ok) return closed;
      turn = closed.turn;
    }
    if (turn.closedAtMs !== closedAtMs || canonicalJson(turn.usageEventKeys) !== canonicalJson(keys)) {
      return fail('turn-closure-changed', 'a completion retry must preserve the exact closed usage population and time');
    }
    if (turn.state === 'closed') {
      const staged = await d.store.stageSettlement(b.workspaceId, turn.turnId, turn.revision,
        { signReceipt: d.signReceipt, readUsage: d.readUsage });
      if (!staged.ok) return staged;
      turn = staged.turn;
    }
    return this.settlePending(b.workspaceId, turn.turnId);
  }

  /** Restart recovery reads the original closed population and timestamp from
   * the ledger. Uncertain native delivery/completion remains held; recovery
   * cannot authorize another inference or infer a zero-cost completion. */
  async reconcileCompletion(workspaceId: string, turnId: string): Promise<Result> {
    const turn = await this.deps.store.read(workspaceId, turnId);
    if (!turn) return fail('unknown-turn', 'no durable native admission exists');
    if (turn.state === 'settlement-pending' || turn.state === 'settled') {
      return this.settlePending(workspaceId, turnId);
    }
    if (turn.state !== 'closed' || turn.closedAtMs === null || !turn.usageEventKeys) {
      return fail('native-completion-unconfirmed', 'only a durable closed population or signed outbox can reconcile completion; the hold remains');
    }
    return this.complete({ binding: turn.binding, turnId,
      usageEventKeys: turn.usageEventKeys, closedAtMs: turn.closedAtMs });
  }

  /** Restart-safe outbox flush; never re-signs or substitutes a fresh timestamp. */
  async settlePending(workspaceId: string, turnId: string): Promise<Result> {
    const d = this.deps, turn = await d.store.read(workspaceId, turnId);
    if (!turn) return fail('unknown-turn', 'no durable native turn exists');
    if (turn.state === 'settled') return { ok: true, turn };
    if (turn.state !== 'settlement-pending' || !turn.settlementOutbox) {
      return fail('invalid-turn-state', 'a signed durable outbox is required');
    }
    const outbox = turn.settlementOutbox, r = outbox.receipt;
    const expectedBytes = usageReceiptSigningBytes({ ...r,
      meterQuantity: BigInt(r.meterQuantity), amountMicros: BigInt(r.amountMicros) });
    const settled = await settleMeteredUnit({ channelId: turn.binding.channelId, usageNonce: turnId,
      occurredAtMs: r.occurredAtMs,
      identityInference: { billedInferenceMicros: BigInt(outbox.billedInferenceMicros),
        priorRemainderNumerator: BigInt(outbox.priorRemainderNumerator) },
      signReceipt: (bytes) => {
        if (!bytes.equals(expectedBytes)) throw new Error('hosted reservation differs from the durable signed outbox');
        return r.signature;
      } }, d.sellerTransport);
    // Both lost responses and already-settled refusals resolve through the same exact ack.
    const current = await readChannelUsage(turn.binding.channelId, d.sellerTransport);
    if (!current.ok) return current;
    if (current.usage.channelId !== turn.binding.channelId || !Array.isArray(current.usage.receipts)) {
      return fail('invalid-hosted-usage', 'hosted settlement history is unreadable');
    }
    const receipt = current.usage.receipts.find((x) => x.usageNonce === turnId);
    if (!receipt || receipt.state !== 'settled') {
      return settled.ok ? fail('settlement-not-confirmed', 'hosted settlement disappeared') : settled;
    }
    return d.store.acknowledgeSettlement(workspaceId, turnId, turn.revision, receipt);
  }
}
