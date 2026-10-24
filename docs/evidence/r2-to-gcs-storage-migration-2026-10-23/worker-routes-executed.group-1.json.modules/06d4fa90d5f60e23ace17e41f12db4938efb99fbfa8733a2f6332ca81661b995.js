__vite_ssr_exportName__("bridgeCommerceEventsToLedger", () => { try { return bridgeCommerceEventsToLedger } catch {} });
__vite_ssr_exportName__("perUseRollup", () => { try { return perUseRollup } catch {} });
__vite_ssr_exportName__("perUseDashboard", () => { try { return perUseDashboard } catch {} });
__vite_ssr_exportName__("mergeEntitlementProjections", () => { try { return mergeEntitlementProjections } catch {} });
__vite_ssr_exportName__("bridgeFromCommerceEntitlements", () => { try { return bridgeFromCommerceEntitlements } catch {} });
const LEDGER_PROVIDER = "p2p";
const SEQUENCE_PAD = 16;
function ledgerEventId(event, suffix) {
  return `p2p:${event.streamId}:${String(event.sequence).padStart(SEQUENCE_PAD, "0")}:${suffix}`;
}
function readString(payload, field) {
  const value = payload[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function readMoney(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const money = value;
  if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) return null;
  if (typeof money.currency !== "string" || !/^[A-Z]{3}$/.test(money.currency)) return null;
  return { amountMinor: money.amountMinor, currency: money.currency };
}
function readMicros(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) return null;
    return BigInt(value.trim());
  };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  };
  return null;
}
function source(event) {
  return { provider: LEDGER_PROVIDER, providerEventId: event.eventId };
}
function bridgeCommerceEventsToLedger(accepted) {
  const ledgerEvents = [];
  const unbridged = [];
  const deferredToRollup = [];
  for (const event of accepted) {
    const p = event.payload;
    const at = event.occurredAtMs;
    switch (event.kind) {
      case "offer": {
        const productId = readString(p, "productId");
        const offerId = readString(p, "offerId");
        const skuRef = readString(p, "skuRef");
        const creatorId = readString(p, "creatorId");
        const title = readString(p, "title");
        const pricingModel = readString(p, "pricingModel");
        const price = readMoney(p.price);
        if (!productId || !offerId || !skuRef || !creatorId || !title || !pricingModel) {
          unbridged.push({
            eventId: event.eventId,
            reason: "offer event needs productId, offerId, skuRef, creatorId, title and pricingModel to define a ledger product and offer"
          });
          continue;
        };
        if (!price) {
          unbridged.push({
            eventId: event.eventId,
            reason: "offer event price must be integer minor units + an ISO-4217 currency"
          });
          continue;
        };
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, "1-product"),
          kind: "product.defined",
          occurredAtMs: at,
          source: source(event),
          payload: { productId, skuRef, creatorId, title, active: p.active !== false }
        });
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, "2-offer"),
          kind: "offer.defined",
          occurredAtMs: at,
          source: source(event),
          payload: {
            offerId,
            productId,
            pricingModel,
            price,
            active: p.active !== false,
            // Passed through UNVALIDATED on purpose: `perUseTerms` in the ledger
            // is the single authority on what a per-use offer must carry, and a
            // second shape check here could accept terms the ledger rejects (or
            // the reverse) without either side reporting a disagreement.
            ...p.perUse != null ? { perUse: p.perUse } : {}
          }
        });
        continue;
      }
      case "order": {
        const orderId = readString(p, "orderId");
        const offerId = readString(p, "offerId");
        const buyerId = readString(p, "buyerId");
        if (!orderId || !offerId || !buyerId) {
          unbridged.push({
            eventId: event.eventId,
            reason: "order event needs orderId, offerId and buyerId"
          });
          continue;
        };
        const amount = readMoney(p.amount);
        const providerRef = readString(p, "providerRef");
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, "1-order-created"),
          kind: "order.created",
          occurredAtMs: at,
          source: source(event),
          payload: {
            orderId,
            offerId,
            buyerId,
            ...amount ? { amount } : {},
            ...providerRef ? { providerRef } : {}
          }
        });
        const paid = p.paid === true || readString(p, "state") === "paid";
        if (paid) {
          ledgerEvents.push({
            ledgerEventId: ledgerEventId(event, "2-order-paid"),
            kind: "order.paid",
            occurredAtMs: at,
            source: source(event),
            payload: {
              orderId,
              ...amount ? { amount } : {},
              ...providerRef ? { providerRef } : {}
            }
          });
        };
        continue;
      }
      case "refund": {
        const refundId = readString(p, "refundId");
        const orderId = readString(p, "orderId");
        const amount = readMoney(p.amount);
        if (!refundId || !orderId) {
          unbridged.push({
            eventId: event.eventId,
            reason: "refund event needs refundId and orderId"
          });
          continue;
        };
        if (!amount) {
          unbridged.push({
            eventId: event.eventId,
            reason: "refund event amount must be integer minor units + an ISO-4217 currency"
          });
          continue;
        };
        const state = readString(p, "state") ?? "succeeded";
        if (state !== "pending" && state !== "succeeded") {
          unbridged.push({
            eventId: event.eventId,
            reason: `refund event state '${state}' is neither 'pending' nor 'succeeded'`
          });
          continue;
        };
        const providerRef = readString(p, "providerRef");
        const base = {
          refundId,
          orderId,
          amount,
          ...providerRef ? { providerRef } : {}
        };
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, "1-refund-requested"),
          kind: "refund.requested",
          occurredAtMs: at,
          source: source(event),
          payload: base
        });
        if (state === "succeeded") {
          ledgerEvents.push({
            ledgerEventId: ledgerEventId(event, "2-refund-succeeded"),
            kind: "refund.succeeded",
            occurredAtMs: at,
            source: source(event),
            payload: base
          });
        };
        continue;
      }
      case "reversal": {
        const entitlementId = readString(p, "entitlementId");
        if (!entitlementId) {
          unbridged.push({
            eventId: event.eventId,
            reason: "reversal event needs entitlementId to revoke a ledger entitlement"
          });
          continue;
        };
        ledgerEvents.push({
          ledgerEventId: ledgerEventId(event, "1-entitlement-revoked"),
          kind: "entitlement.revoked",
          occurredAtMs: at,
          source: source(event),
          payload: { entitlementId, reason: readString(p, "reason") ?? "reversal" }
        });
        continue;
      }
      case "entitlement":
      case "usage-receipt":
      case "settlement-proof":
      case "revenue-split":
        deferredToRollup.push(event.eventId);
        continue;
      default:
        unbridged.push({
          eventId: event.eventId,
          reason: `unsupported commerce event kind '${String(event.kind)}'`
        });
    }
  };
  return { ledgerEvents, deferredToRollup, unbridged };
};
function accumulatorFor(channels, channelId) {
  const existing = channels.get(channelId);
  if (existing) return existing;
  const created = {
    channelId,
    releaseRef: null,
    payer: null,
    seller: null,
    claimedMicros: 0n,
    receipts: 0,
    settledMicros: 0n,
    pendingSettlementMicros: 0n,
    reversedMicros: 0n,
    lastEventAtMs: 0
  };
  channels.set(channelId, created);
  return created;
}
function perUseRollup(accepted) {
  const channels = /* @__PURE__ */ new Map();
  const unusable = [];
  const settledRequestHashes = /* @__PURE__ */ new Set();
  const payoutKeys = /* @__PURE__ */ new Set();
  for (const event of accepted) {
    if (event.kind === "revenue-split" && (event.payload.payoutStatus === void 0 || event.payload.share !== "dao" && event.payload.share !== "component")) continue;
    if (event.kind !== "usage-receipt" && event.kind !== "settlement-proof" && event.kind !== "revenue-split" && event.kind !== "reversal") {
      continue;
    };
    const p = event.payload;
    const channelId = readString(p, "channelId");
    if (!channelId) {
      if (event.kind !== "reversal") {
        unusable.push({
          eventId: event.eventId,
          reason: `${event.kind} event needs channelId to be attributed to a per-use position`
        });
      };
      continue;
    };
    const channel = accumulatorFor(channels, channelId);
    if (event.occurredAtMs > channel.lastEventAtMs) channel.lastEventAtMs = event.occurredAtMs;
    channel.releaseRef = channel.releaseRef ?? readString(p, "releaseRef");
    channel.payer = channel.payer ?? readString(p, "payer");
    channel.seller = channel.seller ?? readString(p, "seller");
    if (event.kind === "revenue-split") {
      const amount = readMicros(p.amountMicros);
      const share = readString(p, "share");
      const payeeId = readString(p, "payeeId");
      const receiptHash = readString(p, "receiptHash");
      const transactionHash = readString(p, "transactionHash");
      const recipient = readString(p, "recipient");
      if (p.payoutStatus !== "submitted" || !receiptHash || !readString(p, "safeTxHash") || !transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash) || !recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || amount === null || amount <= 0n || share !== "dao" && share !== "component" || share === "component" && !payeeId) {
        unusable.push({ eventId: event.eventId, reason: "payout statement needs a successful submission receipt, exact micros and component payee identity" });
        continue;
      };
      const key = JSON.stringify([receiptHash, share, payeeId ?? ""]);
      if (payoutKeys.has(key)) continue;
      payoutKeys.add(key);
      channel.submittedPayouts ??= { daoMicros: 0n, componentAuthorsMicros: /* @__PURE__ */ new Map() };
      if (share === "dao") channel.submittedPayouts.daoMicros += amount;
      else channel.submittedPayouts.componentAuthorsMicros.set(
        payeeId,
        (channel.submittedPayouts.componentAuthorsMicros.get(payeeId) ?? 0n) + amount
      );
      continue;
    };
    if (event.kind === "usage-receipt") {
      const micros2 = readMicros(p.amountMicros);
      if (micros2 === null) {
        unusable.push({
          eventId: event.eventId,
          reason: "usage-receipt needs amountMicros as a non-negative integer (decimal string)"
        });
        continue;
      };
      channel.claimedMicros += micros2;
      channel.receipts += 1;
      continue;
    };
    if (event.kind === "settlement-proof") {
      const micros2 = readMicros(p.claimMicros);
      if (micros2 === null) {
        unusable.push({
          eventId: event.eventId,
          reason: "settlement-proof needs claimMicros as a non-negative integer (decimal string)"
        });
        continue;
      };
      const isFinal = p.final === true || readString(p, "finality") === "final";
      const requestHash = readString(p, "requestHash");
      if (isFinal) {
        settledRequestHashes.add(requestHash ?? event.eventId);
        channel.settledMicros += micros2;
        if (Object.hasOwn(p, "componentAllocationsMicros")) {
          const authors = p.componentAllocationsMicros;
          const shares = p.allocationsMicros;
          const validObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
          const entries = validObject(authors) ? Object.entries(authors) : [];
          const component = validObject(shares) ? readMicros(shares.component) : null;
          const dao = validObject(shares) ? readMicros(shares.dao) : null;
          const parsed = entries.map(([author, amount]) => [author, readMicros(amount)]);
          if (!validObject(authors) || component === null || dao === null || parsed.some(([author, amount]) => !author.trim() || amount === null) || parsed.reduce((sum, [, amount]) => sum + (amount ?? 0n), 0n) !== component) {
            unusable.push({ eventId: event.eventId, reason: "settlement component author allocations must be integer micros summing to the component share, with a DAO share" });
          } else {
            const allocation = channel.settledAllocations ??= { daoMicros: 0n, componentAuthorsMicros: /* @__PURE__ */ new Map() };
            allocation.daoMicros += dao;
            for (const [author, amount] of parsed) {
              allocation.componentAuthorsMicros.set(author, (allocation.componentAuthorsMicros.get(author) ?? 0n) + amount);
            }
          }
        }
      } else if (!settledRequestHashes.has(requestHash ?? event.eventId)) {
        channel.pendingSettlementMicros += micros2;
      };
      continue;
    };
    const micros = readMicros(p.amountMicros) ?? readMicros(p.reversedMicros);
    if (micros === null) {
      unusable.push({
        eventId: event.eventId,
        reason: "reversal names a channel but carries no amountMicros/reversedMicros, so its per-use effect cannot be measured"
      });
      continue;
    };
    channel.reversedMicros += micros;
  };
  for (const channel of channels.values()) {
    if (channel.settledMicros > 0n && channel.pendingSettlementMicros > 0n) {
      const corrected = channel.pendingSettlementMicros - channel.settledMicros;
      channel.pendingSettlementMicros = corrected > 0n ? corrected : 0n;
    }
  };
  const ordered = [...channels.values()].sort((a, b) => a.channelId.localeCompare(b.channelId));
  const totals = { claimed: 0n, settled: 0n, pending: 0n, reversed: 0n, net: 0n };
  const lines = ordered.map((channel) => {
    const net = channel.settledMicros > channel.reversedMicros ? channel.settledMicros - channel.reversedMicros : 0n;
    totals.claimed += channel.claimedMicros;
    totals.settled += channel.settledMicros;
    totals.pending += channel.pendingSettlementMicros;
    totals.reversed += channel.reversedMicros;
    totals.net += net;
    return {
      channelId: channel.channelId,
      releaseRef: channel.releaseRef,
      payer: channel.payer,
      seller: channel.seller,
      claimedMicros: channel.claimedMicros.toString(),
      receipts: channel.receipts,
      settledMicros: channel.settledMicros.toString(),
      pendingSettlementMicros: channel.pendingSettlementMicros.toString(),
      reversedMicros: channel.reversedMicros.toString(),
      netSettledMicros: net.toString(),
      ...channel.settledAllocations ? { settledAllocations: {
        daoMicros: channel.settledAllocations.daoMicros.toString(),
        componentAuthorsMicros: Object.fromEntries([...channel.settledAllocations.componentAuthorsMicros].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([author, amount]) => [author, amount.toString()]))
      } } : {},
      ...channel.submittedPayouts ? { submittedPayouts: {
        daoMicros: channel.submittedPayouts.daoMicros.toString(),
        componentAuthorsMicros: Object.fromEntries([...channel.submittedPayouts.componentAuthorsMicros].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([author, amount]) => [author, amount.toString()]))
      } } : {},
      lastEventAtMs: channel.lastEventAtMs
    };
  });
  return {
    channels: lines,
    totals: {
      claimedMicros: totals.claimed.toString(),
      settledMicros: totals.settled.toString(),
      pendingSettlementMicros: totals.pending.toString(),
      reversedMicros: totals.reversed.toString(),
      netSettledMicros: totals.net.toString()
    },
    unusable
  };
};
function perUseDashboard(rollup, orgId) {
  if (!rollup) {
    return {
      channels: [],
      totals: {
        claimedMicros: "0",
        settledMicros: "0",
        pendingSettlementMicros: "0",
        reversedMicros: "0",
        netSettledMicros: "0"
      },
      excludedChannels: 0,
      unusable: []
    };
  };
  const visible = rollup.channels.filter(
    (channel) => channel.payer === orgId || channel.seller === orgId
  );
  const totals = { claimed: 0n, settled: 0n, pending: 0n, reversed: 0n, net: 0n };
  for (const channel of visible) {
    totals.claimed += BigInt(channel.claimedMicros);
    totals.settled += BigInt(channel.settledMicros);
    totals.pending += BigInt(channel.pendingSettlementMicros);
    totals.reversed += BigInt(channel.reversedMicros);
    totals.net += BigInt(channel.netSettledMicros);
  };
  return {
    channels: visible,
    totals: {
      claimedMicros: totals.claimed.toString(),
      settledMicros: totals.settled.toString(),
      pendingSettlementMicros: totals.pending.toString(),
      reversedMicros: totals.reversed.toString(),
      netSettledMicros: totals.net.toString()
    },
    excludedChannels: rollup.channels.length - visible.length,
    unusable: rollup.unusable
  };
};
function grantKeyOf(grant) {
  return `${grant.subject}
${grant.releaseRef}`;
}
function mergeEntitlementProjections(...projections) {
  const grants = /* @__PURE__ */ new Map();
  const unusable = [];
  const seenIssues = /* @__PURE__ */ new Set();
  for (const projection of projections) {
    for (const issue of projection.unusable) {
      const key = `${issue.eventId}
${issue.reason}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      unusable.push(issue);
    };
    for (const grant of projection.grants.values()) {
      const key = grantKeyOf(grant);
      const existing = grants.get(key);
      if (!existing) {
        grants.set(key, grant);
        continue;
      };
      const revokedAtMs = existing.revokedAtMs != null && grant.revokedAtMs != null ? Math.min(existing.revokedAtMs, grant.revokedAtMs) : existing.revokedAtMs ?? grant.revokedAtMs;
      const revokedReason = revokedAtMs == null ? null : revokedAtMs === existing.revokedAtMs ? existing.revokedReason ?? grant.revokedReason : grant.revokedReason ?? existing.revokedReason;
      grants.set(key, { ...existing, ...grant, revokedAtMs, revokedReason });
    }
  };
  return { grants, unusable };
};
function bridgeFromCommerceEntitlements(accepted) {
  const releaseByProduct = /* @__PURE__ */ new Map();
  const subjectByBuyer = /* @__PURE__ */ new Map();
  for (const event of accepted) {
    if (event.kind !== "entitlement") continue;
    const productId = readString(event.payload, "productId");
    const releaseRef = readString(event.payload, "releaseRef");
    const buyerId = readString(event.payload, "buyerId");
    const subject = readString(event.payload, "subject");
    if (productId && releaseRef) releaseByProduct.set(productId, releaseRef);
    if (buyerId && subject) subjectByBuyer.set(buyerId, subject);
  };
  return {
    releaseRefForProduct: (productId) => releaseByProduct.get(productId) ?? null,
    subjectForBuyer: (buyerId) => subjectByBuyer.get(buyerId) ?? null
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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VyxNQUFNLFNBQVMsU0FBUztBQUduRCxRQUFJLGFBQWEsV0FBWSxrQkFBaUIsSUFBSSxXQUFXLFVBQVU7QUFDdkUsUUFBSSxXQUFXLFFBQVMsZ0JBQWUsSUFBSSxTQUFTLE9BQU87QUFBQSxFQUM3RDtBQUVBLFNBQU87QUFBQSxJQUNMLHNCQUFzQixDQUFDLGNBQWMsaUJBQWlCLElBQUksU0FBUyxLQUFLO0FBQUEsSUFDeEUsaUJBQWlCLENBQUMsWUFBWSxlQUFlLElBQUksT0FBTyxLQUFLO0FBQUEsRUFDL0Q7QUFDRiIsIm5hbWVzIjpbIm1pY3JvcyJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJsZWRnZXItcDJwLWJyaWRnZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBsZWRnZXIg4oaUIFAyUCBjb21tZXJjZSBicmlkZ2UgKFAtMDM1LCBELTA0OCkuXG4gKlxuICogUC0wMTYgcHVibGlzaGVzIFNJR05FRCBjb21tZXJjZSBldmVudHMgb24gdGhlIFAyUCByYWlsOyBQLTAxMCBrZWVwcyB0aGVcbiAqIGF1dGhvcml0YXRpdmUgbGVkZ2VyIHRoZSBhY2NvdW50IGFuZCBkYXNoYm9hcmQgcHJvamVjdGlvbnMgZm9sZC4gQmVmb3JlIHRoaXNcbiAqIG1vZHVsZSB0aGUgdHdvIG5ldmVyIG1ldDogYGxvYWRDb21tZXJjZUxlZGdlckV2ZW50c2AgcmV0dXJuZWQgYW4gZW1wdHkgZm9sZFxuICogdW5jb25kaXRpb25hbGx5LCBzbyBhIHBlci11c2UgcHVyY2hhc2Ugc2V0dGxlZCBvbiB0aGUgUDJQIHJhaWwgZ3JhbnRlZCBub1xuICogbGVkZ2VyIGVudGl0bGVtZW50LCBhcHBlYXJlZCBpbiBubyBkYXNoYm9hcmQsIGFuZCBpdHMgcmV2ZXJzYWwgcHJvcGFnYXRlZFxuICogbm93aGVyZS5cbiAqXG4gKiBXSFkgVEhFIEJSSURHRSBTUExJVFMgSVRTIE9VVFBVVCBJTiBUV09cbiAqXG4gKiBQZXItdXNlIG1vbmV5IGlzIGBiaWdpbnRgIE1JQ1JPUyAoMWUtNiBvZiBhIGN1cnJlbmN5IHVuaXQg4oCUIHNlZVxuICogYG1pY3JvY2hhcmdlLkN1bXVsYXRpdmVQYXltZW50Vm91Y2hlcmApLCBhbmQgdGhlIGxlZGdlcidzIGBNb25leWAgaXMgYW5cbiAqIGludGVnZXIgY291bnQgb2YgTUlOT1IgdW5pdHMgKGNlbnRzKS4gQSBzaW5nbGUgdXNhZ2UgcmVjZWlwdCBpcyByb3V0aW5lbHlcbiAqIHdvcnRoIGEgZnJhY3Rpb24gb2Ygb25lIGNlbnQsIHNvIHByb2plY3RpbmcgcmVjZWlwdHMgaW50byBsZWRnZXIgb3JkZXJzIHdvdWxkXG4gKiBmbG9vciBtb3N0IG9mIHRoZW0gdG8gemVybyBhbmQgc2lsZW50bHkgZGVzdHJveSByZXZlbnVlIOKAlCB0aGUgZmFpbHVyZSB3b3VsZFxuICogc2hvdyB1cCBhcyBhIGRhc2hib2FyZCB0aGF0IHVuZGVyLXJlcG9ydHMsIHdoaWNoIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYVxuICogcXVpZXQgcGVyaW9kLiBTbyBlYWNoIGZhY3QgZ29lcyB0byB0aGUgc3RvcmUgdGhhdCBjYW4gcmVwcmVzZW50IGl0IEVYQUNUTFk6XG4gKlxuICogICAtIGBicmlkZ2VDb21tZXJjZUV2ZW50c1RvTGVkZ2VyYCBtYXBzIG9ubHkgdGhlIGtpbmRzIHRoZSBsZWRnZXIgbW9kZWxzXG4gKiAgICAgZXhhY3RseSBpbiBtaW5vciB1bml0cyDigJQgb2ZmZXJzLCBvcmRlcnMsIHJlZnVuZHMsIHJldmVyc2Fscy5cbiAqICAgLSBgcGVyVXNlUm9sbHVwYCBrZWVwcyB1c2FnZSBhbmQgc2V0dGxlbWVudCBpbiBtaWNyb3MsIGFzIGRlY2ltYWwgc3RyaW5nc1xuICogICAgIGF0IHRoZSBib3VuZGFyeSAodGhlIHNhbWUgY29udmVudGlvbiBgYnVpbGRTZXR0bGVtZW50UHJvb2ZFdmVudGAgdXNlcyksXG4gKiAgICAgYW5kIG5ldmVyIHJvdW5kcy5cbiAqXG4gKiBBIGB1c2FnZS1yZWNlaXB0YCBpcyBhIENMQUlNIGFuZCBhIGBzZXR0bGVtZW50LXByb29mYCB3aXRoIGBmaW5hbDogdHJ1ZWAgaXNcbiAqIEZJTkFMSVRZOyB0aGUgcm9sbHVwIHJlcG9ydHMgdGhlbSBzZXBhcmF0ZWx5IGJlY2F1c2UgYWNjZXB0YW5jZSBsaW5lIDE0IHR1cm5zXG4gKiBvbiBleGFjdGx5IHRoYXQgZGlzdGluY3Rpb24sIGFuZCBELTA1NSBwdXRzIGZpbmFsaXR5IG9uIGNoYWluIHJhdGhlciB0aGFuIG9uXG4gKiB0aGUgaGl2ZSBsb2cuXG4gKlxuICogSURFTVBPVEVOQ1kuIEV2ZXJ5IGVtaXR0ZWQgbGVkZ2VyIGV2ZW50IGlkIGlzIGRlcml2ZWQgZnJvbSB0aGUgY29tbWVyY2VcbiAqIGV2ZW50J3Mgb3duIGAoc3RyZWFtSWQsIHNlcXVlbmNlKWAg4oCUIG5ldmVyIGZyb20gaXRzIHBvc2l0aW9uIGluIHRoZSBiYXRjaCDigJRcbiAqIHNvIHJlLWJyaWRnaW5nIGEgbGFyZ2VyIGJhdGNoIHByb2R1Y2VzIGJ5dGUtaWRlbnRpY2FsIGV2ZW50cyBmb3IgdGhlIGZhY3RzIGl0XG4gKiBhbHJlYWR5IGNhcnJpZWQsIGFuZCBgcmVkdWNlTGVkZ2VyYCByZXBvcnRzIHRoZW0gYXMgZHVwbGljYXRlcyByYXRoZXIgdGhhblxuICogcmVqZWN0aW5nIHRoZW0uIFRoZSB6ZXJvLXBhZGRlZCBzZXF1ZW5jZSBhbHNvIG1ha2VzIHRoZSBpZHMgc29ydCBpbiBjYXVzYWxcbiAqIG9yZGVyIHdpdGhpbiBhIHN0cmVhbSwgd2hpY2ggaXMgd2hhdCBrZWVwcyBhIGBwcm9kdWN0LmRlZmluZWRgIGFoZWFkIG9mIHRoZVxuICogYG9mZmVyLmRlZmluZWRgIGl0IGlzIGEgcHJlY29uZGl0aW9uIGZvciB3aGVuIGJvdGggY2Fycnkgb25lIHRpbWVzdGFtcC5cbiAqL1xuaW1wb3J0IHR5cGUgeyBDb21tZXJjZUV2ZW50IH0gZnJvbSAnLi4vcDJwL2NvbW1lcmNlLWV2ZW50cyc7XG5cbmltcG9ydCB0eXBlIHsgRW50aXRsZW1lbnQsIExlZGdlckV2ZW50LCBNb25leSB9IGZyb20gJy4vY29tbWVyY2UtbGVkZ2VyJztcbmltcG9ydCB0eXBlIHsgRW50aXRsZW1lbnRHcmFudCwgRW50aXRsZW1lbnRQcm9qZWN0aW9uIH0gZnJvbSAnLi9lbnRpdGxlZC1kZWxpdmVyeSc7XG5cbi8qKiBBIGNvbW1lcmNlIGZhY3QgdGhpcyBicmlkZ2UgY291bGQgbm90IGNhcnJ5IGFjcm9zcywgYW5kIHdoeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQnJpZGdlSXNzdWUge1xuICByZWFkb25seSBldmVudElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlYXNvbjogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1lcmNlTGVkZ2VyQnJpZGdlUmVzdWx0IHtcbiAgLyoqXG4gICAqIExlZGdlciBldmVudHMgaW4gZW1pc3Npb24gb3JkZXIuIEZlZWQgdGhlbSB0byBgcmVkdWNlTGVkZ2VyYCBBTE9OR1NJREUgYW55XG4gICAqIGxvY2FsbHktc291cmNlZCBldmVudHM7IHRoZSByZWR1Y2VyIG93bnMgb3JkZXJpbmcsIGlkZW1wb3RlbmN5IGFuZCBldmVyeVxuICAgKiB0cmFuc2l0aW9uIHJ1bGUsIGFuZCB0aGlzIG1vZHVsZSBkZWxpYmVyYXRlbHkgcmUtaW1wbGVtZW50cyBub25lIG9mIGl0LlxuICAgKi9cbiAgcmVhZG9ubHkgbGVkZ2VyRXZlbnRzOiByZWFkb25seSBMZWRnZXJFdmVudFtdO1xuICAvKiogS2luZHMgdGhlIGxlZGdlciBjYW5ub3QgcmVwcmVzZW50IGV4YWN0bHkg4oCUIHNlZSBgcGVyVXNlUm9sbHVwYC4gKi9cbiAgcmVhZG9ubHkgZGVmZXJyZWRUb1JvbGx1cDogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlYWRvbmx5IHVuYnJpZGdlZDogcmVhZG9ubHkgQnJpZGdlSXNzdWVbXTtcbn1cblxuY29uc3QgTEVER0VSX1BST1ZJREVSID0gJ3AycCc7XG5cbi8qKiBXaWRlc3QgemVyby1wYWQgdGhhdCBrZWVwcyBhIHNhZmUtaW50ZWdlciBzZXF1ZW5jZSBsZXhpY29ncmFwaGljYWxseSBvcmRlcmVkLiAqL1xuY29uc3QgU0VRVUVOQ0VfUEFEID0gMTY7XG5cbmZ1bmN0aW9uIGxlZGdlckV2ZW50SWQoZXZlbnQ6IENvbW1lcmNlRXZlbnQsIHN1ZmZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBwMnA6JHtldmVudC5zdHJlYW1JZH06JHtTdHJpbmcoZXZlbnQuc2VxdWVuY2UpLnBhZFN0YXJ0KFNFUVVFTkNFX1BBRCwgJzAnKX06JHtzdWZmaXh9YDtcbn1cblxuZnVuY3Rpb24gcmVhZFN0cmluZyhwYXlsb2FkOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4sIGZpZWxkOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgdmFsdWUgPSBwYXlsb2FkW2ZpZWxkXTtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlYWRNb25leSh2YWx1ZTogdW5rbm93bik6IE1vbmV5IHwgbnVsbCB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1vbmV5ID0gdmFsdWUgYXMgUGFydGlhbDxNb25leT47XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIobW9uZXkuYW1vdW50TWlub3IpIHx8IChtb25leS5hbW91bnRNaW5vciBhcyBudW1iZXIpIDwgMCkgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgbW9uZXkuY3VycmVuY3kgIT09ICdzdHJpbmcnIHx8ICEvXltBLVpdezN9JC8udGVzdChtb25leS5jdXJyZW5jeSkpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhbW91bnRNaW5vcjogbW9uZXkuYW1vdW50TWlub3IgYXMgbnVtYmVyLCBjdXJyZW5jeTogbW9uZXkuY3VycmVuY3kgfTtcbn1cblxuLyoqXG4gKiBSZWFkIGEgbWljcm9zIGFtb3VudCB0aGF0IGNyb3NzZWQgYSBKU09OIGJvdW5kYXJ5LlxuICpcbiAqIE1pY3JvcyBhcmUgZW1pdHRlZCBhcyBERUNJTUFMIFNUUklOR1MgKGBiaWdpbnQudG9TdHJpbmcoKWApIGJlY2F1c2UgYVxuICogY3VtdWxhdGl2ZSBjbGFpbSBjYW4gZXhjZWVkIGBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUmAg4oCUIGFjY2VwdGluZyBhIGBudW1iZXJgXG4gKiBoZXJlIHdvdWxkIGxldCBhIGxhcmdlIGNoYW5uZWwncyB0b3RhbCBsb3NlIGl0cyBsb3cgZGlnaXRzIGJlZm9yZSB0aGUgYnJpZGdlXG4gKiBldmVyIHNhdyBpdC4gQSBzYWZlIGludGVnZXIgaXMgc3RpbGwgYWNjZXB0ZWQsIGJlY2F1c2UgYSBzbWFsbCBoYW5kLWJ1aWx0XG4gKiBmYWN0IGlzIGxlZ2l0aW1hdGVseSBhIG51bWJlciwgYnV0IGEgbm9uLWludGVncmFsIG9yIHVuc2FmZSBvbmUgaXMgcmVmdXNlZFxuICogcmF0aGVyIHRoYW4gY29lcmNlZC5cbiAqL1xuZnVuY3Rpb24gcmVhZE1pY3Jvcyh2YWx1ZTogdW5rbm93bik6IGJpZ2ludCB8IG51bGwge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnYmlnaW50JykgcmV0dXJuIHZhbHVlID49IDBuID8gdmFsdWUgOiBudWxsO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgIGlmICghL15cXGQrJC8udGVzdCh2YWx1ZS50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gQmlnSW50KHZhbHVlLnRyaW0oKSk7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDApIHJldHVybiBudWxsO1xuICAgIHJldHVybiBCaWdJbnQodmFsdWUpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBzb3VyY2UoZXZlbnQ6IENvbW1lcmNlRXZlbnQpOiBMZWRnZXJFdmVudFsnc291cmNlJ10ge1xuICByZXR1cm4geyBwcm92aWRlcjogTEVER0VSX1BST1ZJREVSLCBwcm92aWRlckV2ZW50SWQ6IGV2ZW50LmV2ZW50SWQgfTtcbn1cblxuLyoqXG4gKiBQcm9qZWN0IGFjY2VwdGVkIFAtMDE2IGNvbW1lcmNlIGV2ZW50cyBpbnRvIFAtMDEwIGxlZGdlciBldmVudHMuXG4gKlxuICogSU5QVVQgTVVTVCBCRSBgcmVkdWNlQ29tbWVyY2VFdmVudHMoLi4uKS5hY2NlcHRlZGAuIFRoYXQgcmVkdWNlciBvd25zXG4gKiBzaWduYXR1cmUtc2hhcGUgdmFsaWRhdGlvbiwgaWRlbXBvdGVuY3kgYW5kIGNvbmZsaWN0IHF1YXJhbnRpbmU7IHRha2luZyByYXdcbiAqIGV2ZW50cyBoZXJlIHdvdWxkIG9wZW4gYSBzZWNvbmQsIGxlc3MgY2FyZWZ1bCBkb29yIGludG8gdGhlIGxlZGdlciDigJQgdGhlXG4gKiBleGFjdCBoYXphcmQgYHByb2plY3RFbnRpdGxlbWVudHNgIGRvY3VtZW50cyBvbiB0aGUgZGVsaXZlcnkgc2lkZS5cbiAqXG4gKiBLaW5kcyBhcmUgbWFwcGVkIG9ubHkgd2hlcmUgdGhlIGxlZGdlcidzIG93biByZWR1Y2VyIGNhbiBjaGVjayB0aGUgZmFjdDpcbiAqXG4gKiAgIG9mZmVyICAgICDihpIgYHByb2R1Y3QuZGVmaW5lZGAgKyBgb2ZmZXIuZGVmaW5lZGAgKHRoZSBsZWRnZXIgYWxyZWFkeSBjYXJyaWVzXG4gKiAgICAgICAgICAgICAgIGBQZXJVc2VPZmZlclRlcm1zYCwgc28gcGVyLXVzZSBwcmljaW5nIHN1cnZpdmVzIHRoZSBjcm9zc2luZylcbiAqICAgb3JkZXIgICAgIOKGkiBgb3JkZXIuY3JlYXRlZGAsIHBsdXMgYG9yZGVyLnBhaWRgIHdoZW4gdGhlIGZhY3Qgc2F5cyBpdCBpcyBwYWlkXG4gKiAgIHJlZnVuZCAgICDihpIgYHJlZnVuZC5yZXF1ZXN0ZWRgIGFuZC9vciBgcmVmdW5kLnN1Y2NlZWRlZGBcbiAqICAgcmV2ZXJzYWwgIOKGkiBgZW50aXRsZW1lbnQucmV2b2tlZGBcbiAqXG4gKiBBbiBgZW50aXRsZW1lbnRgIGV2ZW50IGVtaXRzIE5PVEhJTkcgaGVyZSBvbiBwdXJwb3NlOiB0aGUgbGVkZ2VyIG1pbnRzXG4gKiBgZW50OjxvcmRlcklkPmAgaXRzZWxmIHdoZW4gYW4gb3JkZXIgaXMgcGFpZCwgc28gYnJpZGdpbmcgb25lIHdvdWxkIGdyYW50IHRoZVxuICogc2FtZSBlbnRpdGxlbWVudCB0d2ljZSB1bmRlciB0d28gaWRzIGFuZCBsZWF2ZSBhIHJldm9jYXRpb24gYWJsZSB0byByZWFjaFxuICogb25seSBvbmUgb2YgdGhlbS4gRW50aXRsZW1lbnQgZXZlbnRzIHJlYWNoIGRlbGl2ZXJ5IHRocm91Z2hcbiAqIGBwcm9qZWN0RW50aXRsZW1lbnRzYCwgYW5kIHRoZSB0d28gdmlld3MgYXJlIGNvbWJpbmVkIGJ5XG4gKiBgbWVyZ2VFbnRpdGxlbWVudFByb2plY3Rpb25zYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJyaWRnZUNvbW1lcmNlRXZlbnRzVG9MZWRnZXIoXG4gIGFjY2VwdGVkOiByZWFkb25seSBDb21tZXJjZUV2ZW50W10sXG4pOiBDb21tZXJjZUxlZGdlckJyaWRnZVJlc3VsdCB7XG4gIGNvbnN0IGxlZGdlckV2ZW50czogTGVkZ2VyRXZlbnRbXSA9IFtdO1xuICBjb25zdCB1bmJyaWRnZWQ6IEJyaWRnZUlzc3VlW10gPSBbXTtcbiAgY29uc3QgZGVmZXJyZWRUb1JvbGx1cDogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IGV2ZW50IG9mIGFjY2VwdGVkKSB7XG4gICAgY29uc3QgcCA9IGV2ZW50LnBheWxvYWQ7XG4gICAgY29uc3QgYXQgPSBldmVudC5vY2N1cnJlZEF0TXM7XG5cbiAgICBzd2l0Y2ggKGV2ZW50LmtpbmQpIHtcbiAgICAgIGNhc2UgJ29mZmVyJzoge1xuICAgICAgICBjb25zdCBwcm9kdWN0SWQgPSByZWFkU3RyaW5nKHAsICdwcm9kdWN0SWQnKTtcbiAgICAgICAgY29uc3Qgb2ZmZXJJZCA9IHJlYWRTdHJpbmcocCwgJ29mZmVySWQnKTtcbiAgICAgICAgY29uc3Qgc2t1UmVmID0gcmVhZFN0cmluZyhwLCAnc2t1UmVmJyk7XG4gICAgICAgIGNvbnN0IGNyZWF0b3JJZCA9IHJlYWRTdHJpbmcocCwgJ2NyZWF0b3JJZCcpO1xuICAgICAgICBjb25zdCB0aXRsZSA9IHJlYWRTdHJpbmcocCwgJ3RpdGxlJyk7XG4gICAgICAgIGNvbnN0IHByaWNpbmdNb2RlbCA9IHJlYWRTdHJpbmcocCwgJ3ByaWNpbmdNb2RlbCcpO1xuICAgICAgICBjb25zdCBwcmljZSA9IHJlYWRNb25leShwLnByaWNlKTtcbiAgICAgICAgaWYgKCFwcm9kdWN0SWQgfHwgIW9mZmVySWQgfHwgIXNrdVJlZiB8fCAhY3JlYXRvcklkIHx8ICF0aXRsZSB8fCAhcHJpY2luZ01vZGVsKSB7XG4gICAgICAgICAgdW5icmlkZ2VkLnB1c2goe1xuICAgICAgICAgICAgZXZlbnRJZDogZXZlbnQuZXZlbnRJZCxcbiAgICAgICAgICAgIHJlYXNvbjpcbiAgICAgICAgICAgICAgJ29mZmVyIGV2ZW50IG5lZWRzIHByb2R1Y3RJZCwgb2ZmZXJJZCwgc2t1UmVmLCBjcmVhdG9ySWQsIHRpdGxlIGFuZCBwcmljaW5nTW9kZWwgdG8gZGVmaW5lIGEgbGVkZ2VyIHByb2R1Y3QgYW5kIG9mZmVyJyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXByaWNlKSB7XG4gICAgICAgICAgdW5icmlkZ2VkLnB1c2goe1xuICAgICAgICAgICAgZXZlbnRJZDogZXZlbnQuZXZlbnRJZCxcbiAgICAgICAgICAgIHJlYXNvbjogJ29mZmVyIGV2ZW50IHByaWNlIG11c3QgYmUgaW50ZWdlciBtaW5vciB1bml0cyArIGFuIElTTy00MjE3IGN1cnJlbmN5JyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBsZWRnZXJFdmVudHMucHVzaCh7XG4gICAgICAgICAgbGVkZ2VyRXZlbnRJZDogbGVkZ2VyRXZlbnRJZChldmVudCwgJzEtcHJvZHVjdCcpLFxuICAgICAgICAgIGtpbmQ6ICdwcm9kdWN0LmRlZmluZWQnLFxuICAgICAgICAgIG9jY3VycmVkQXRNczogYXQsXG4gICAgICAgICAgc291cmNlOiBzb3VyY2UoZXZlbnQpLFxuICAgICAgICAgIHBheWxvYWQ6IHsgcHJvZHVjdElkLCBza3VSZWYsIGNyZWF0b3JJZCwgdGl0bGUsIGFjdGl2ZTogcC5hY3RpdmUgIT09IGZhbHNlIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBsZWRnZXJFdmVudHMucHVzaCh7XG4gICAgICAgICAgbGVkZ2VyRXZlbnRJZDogbGVkZ2VyRXZlbnRJZChldmVudCwgJzItb2ZmZXInKSxcbiAgICAgICAgICBraW5kOiAnb2ZmZXIuZGVmaW5lZCcsXG4gICAgICAgICAgb2NjdXJyZWRBdE1zOiBhdCxcbiAgICAgICAgICBzb3VyY2U6IHNvdXJjZShldmVudCksXG4gICAgICAgICAgcGF5bG9hZDoge1xuICAgICAgICAgICAgb2ZmZXJJZCxcbiAgICAgICAgICAgIHByb2R1Y3RJZCxcbiAgICAgICAgICAgIHByaWNpbmdNb2RlbCxcbiAgICAgICAgICAgIHByaWNlLFxuICAgICAgICAgICAgYWN0aXZlOiBwLmFjdGl2ZSAhPT0gZmFsc2UsXG4gICAgICAgICAgICAvLyBQYXNzZWQgdGhyb3VnaCBVTlZBTElEQVRFRCBvbiBwdXJwb3NlOiBgcGVyVXNlVGVybXNgIGluIHRoZSBsZWRnZXJcbiAgICAgICAgICAgIC8vIGlzIHRoZSBzaW5nbGUgYXV0aG9yaXR5IG9uIHdoYXQgYSBwZXItdXNlIG9mZmVyIG11c3QgY2FycnksIGFuZCBhXG4gICAgICAgICAgICAvLyBzZWNvbmQgc2hhcGUgY2hlY2sgaGVyZSBjb3VsZCBhY2NlcHQgdGVybXMgdGhlIGxlZGdlciByZWplY3RzIChvclxuICAgICAgICAgICAgLy8gdGhlIHJldmVyc2UpIHdpdGhvdXQgZWl0aGVyIHNpZGUgcmVwb3J0aW5nIGEgZGlzYWdyZWVtZW50LlxuICAgICAgICAgICAgLi4uKHAucGVyVXNlICE9IG51bGwgPyB7IHBlclVzZTogcC5wZXJVc2UgfSA6IHt9KSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgJ29yZGVyJzoge1xuICAgICAgICBjb25zdCBvcmRlcklkID0gcmVhZFN0cmluZyhwLCAnb3JkZXJJZCcpO1xuICAgICAgICBjb25zdCBvZmZlcklkID0gcmVhZFN0cmluZyhwLCAnb2ZmZXJJZCcpO1xuICAgICAgICBjb25zdCBidXllcklkID0gcmVhZFN0cmluZyhwLCAnYnV5ZXJJZCcpO1xuICAgICAgICBpZiAoIW9yZGVySWQgfHwgIW9mZmVySWQgfHwgIWJ1eWVySWQpIHtcbiAgICAgICAgICB1bmJyaWRnZWQucHVzaCh7XG4gICAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgICAgcmVhc29uOiAnb3JkZXIgZXZlbnQgbmVlZHMgb3JkZXJJZCwgb2ZmZXJJZCBhbmQgYnV5ZXJJZCcsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYW1vdW50ID0gcmVhZE1vbmV5KHAuYW1vdW50KTtcbiAgICAgICAgY29uc3QgcHJvdmlkZXJSZWYgPSByZWFkU3RyaW5nKHAsICdwcm92aWRlclJlZicpO1xuICAgICAgICBsZWRnZXJFdmVudHMucHVzaCh7XG4gICAgICAgICAgbGVkZ2VyRXZlbnRJZDogbGVkZ2VyRXZlbnRJZChldmVudCwgJzEtb3JkZXItY3JlYXRlZCcpLFxuICAgICAgICAgIGtpbmQ6ICdvcmRlci5jcmVhdGVkJyxcbiAgICAgICAgICBvY2N1cnJlZEF0TXM6IGF0LFxuICAgICAgICAgIHNvdXJjZTogc291cmNlKGV2ZW50KSxcbiAgICAgICAgICBwYXlsb2FkOiB7XG4gICAgICAgICAgICBvcmRlcklkLFxuICAgICAgICAgICAgb2ZmZXJJZCxcbiAgICAgICAgICAgIGJ1eWVySWQsXG4gICAgICAgICAgICAuLi4oYW1vdW50ID8geyBhbW91bnQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm92aWRlclJlZiA/IHsgcHJvdmlkZXJSZWYgfSA6IHt9KSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgICAgLy8gQSBQMlAgb3JkZXIgYW5ub3VuY2VzIGl0cyBvd24gc2V0dGxlbWVudCByYXRoZXIgdGhhbiB3YWl0aW5nIGZvciBhXG4gICAgICAgIC8vIHByb3ZpZGVyIHdlYmhvb2ssIHNvIGBwYWlkYCAob3IgYHN0YXRlOiAncGFpZCdgKSBpcyB3aGF0IG1pbnRzIHRoZVxuICAgICAgICAvLyBlbnRpdGxlbWVudC4gQW55dGhpbmcgZWxzZSBzdGF5cyBQRU5ESU5HOiBpbmZlcnJpbmcgcGF5bWVudCBmcm9tIHRoZVxuICAgICAgICAvLyBtZXJlIGV4aXN0ZW5jZSBvZiBhbiBvcmRlciBpcyBob3cgYW4gdW5wYWlkIGJ1eWVyIGdldHMgdGhlIGJ5dGVzLlxuICAgICAgICBjb25zdCBwYWlkID0gcC5wYWlkID09PSB0cnVlIHx8IHJlYWRTdHJpbmcocCwgJ3N0YXRlJykgPT09ICdwYWlkJztcbiAgICAgICAgaWYgKHBhaWQpIHtcbiAgICAgICAgICBsZWRnZXJFdmVudHMucHVzaCh7XG4gICAgICAgICAgICBsZWRnZXJFdmVudElkOiBsZWRnZXJFdmVudElkKGV2ZW50LCAnMi1vcmRlci1wYWlkJyksXG4gICAgICAgICAgICBraW5kOiAnb3JkZXIucGFpZCcsXG4gICAgICAgICAgICBvY2N1cnJlZEF0TXM6IGF0LFxuICAgICAgICAgICAgc291cmNlOiBzb3VyY2UoZXZlbnQpLFxuICAgICAgICAgICAgcGF5bG9hZDoge1xuICAgICAgICAgICAgICBvcmRlcklkLFxuICAgICAgICAgICAgICAuLi4oYW1vdW50ID8geyBhbW91bnQgfSA6IHt9KSxcbiAgICAgICAgICAgICAgLi4uKHByb3ZpZGVyUmVmID8geyBwcm92aWRlclJlZiB9IDoge30pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY2FzZSAncmVmdW5kJzoge1xuICAgICAgICBjb25zdCByZWZ1bmRJZCA9IHJlYWRTdHJpbmcocCwgJ3JlZnVuZElkJyk7XG4gICAgICAgIGNvbnN0IG9yZGVySWQgPSByZWFkU3RyaW5nKHAsICdvcmRlcklkJyk7XG4gICAgICAgIGNvbnN0IGFtb3VudCA9IHJlYWRNb25leShwLmFtb3VudCk7XG4gICAgICAgIGlmICghcmVmdW5kSWQgfHwgIW9yZGVySWQpIHtcbiAgICAgICAgICB1bmJyaWRnZWQucHVzaCh7XG4gICAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgICAgcmVhc29uOiAncmVmdW5kIGV2ZW50IG5lZWRzIHJlZnVuZElkIGFuZCBvcmRlcklkJyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWFtb3VudCkge1xuICAgICAgICAgIHVuYnJpZGdlZC5wdXNoKHtcbiAgICAgICAgICAgIGV2ZW50SWQ6IGV2ZW50LmV2ZW50SWQsXG4gICAgICAgICAgICByZWFzb246ICdyZWZ1bmQgZXZlbnQgYW1vdW50IG11c3QgYmUgaW50ZWdlciBtaW5vciB1bml0cyArIGFuIElTTy00MjE3IGN1cnJlbmN5JyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGF0ZSA9IHJlYWRTdHJpbmcocCwgJ3N0YXRlJykgPz8gJ3N1Y2NlZWRlZCc7XG4gICAgICAgIGlmIChzdGF0ZSAhPT0gJ3BlbmRpbmcnICYmIHN0YXRlICE9PSAnc3VjY2VlZGVkJykge1xuICAgICAgICAgIHVuYnJpZGdlZC5wdXNoKHtcbiAgICAgICAgICAgIGV2ZW50SWQ6IGV2ZW50LmV2ZW50SWQsXG4gICAgICAgICAgICByZWFzb246IGByZWZ1bmQgZXZlbnQgc3RhdGUgJyR7c3RhdGV9JyBpcyBuZWl0aGVyICdwZW5kaW5nJyBub3IgJ3N1Y2NlZWRlZCdgLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHByb3ZpZGVyUmVmID0gcmVhZFN0cmluZyhwLCAncHJvdmlkZXJSZWYnKTtcbiAgICAgICAgY29uc3QgYmFzZSA9IHtcbiAgICAgICAgICByZWZ1bmRJZCxcbiAgICAgICAgICBvcmRlcklkLFxuICAgICAgICAgIGFtb3VudCxcbiAgICAgICAgICAuLi4ocHJvdmlkZXJSZWYgPyB7IHByb3ZpZGVyUmVmIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICAgIGxlZGdlckV2ZW50cy5wdXNoKHtcbiAgICAgICAgICBsZWRnZXJFdmVudElkOiBsZWRnZXJFdmVudElkKGV2ZW50LCAnMS1yZWZ1bmQtcmVxdWVzdGVkJyksXG4gICAgICAgICAga2luZDogJ3JlZnVuZC5yZXF1ZXN0ZWQnLFxuICAgICAgICAgIG9jY3VycmVkQXRNczogYXQsXG4gICAgICAgICAgc291cmNlOiBzb3VyY2UoZXZlbnQpLFxuICAgICAgICAgIHBheWxvYWQ6IGJhc2UsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc3RhdGUgPT09ICdzdWNjZWVkZWQnKSB7XG4gICAgICAgICAgbGVkZ2VyRXZlbnRzLnB1c2goe1xuICAgICAgICAgICAgbGVkZ2VyRXZlbnRJZDogbGVkZ2VyRXZlbnRJZChldmVudCwgJzItcmVmdW5kLXN1Y2NlZWRlZCcpLFxuICAgICAgICAgICAga2luZDogJ3JlZnVuZC5zdWNjZWVkZWQnLFxuICAgICAgICAgICAgb2NjdXJyZWRBdE1zOiBhdCxcbiAgICAgICAgICAgIHNvdXJjZTogc291cmNlKGV2ZW50KSxcbiAgICAgICAgICAgIHBheWxvYWQ6IGJhc2UsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgJ3JldmVyc2FsJzoge1xuICAgICAgICBjb25zdCBlbnRpdGxlbWVudElkID0gcmVhZFN0cmluZyhwLCAnZW50aXRsZW1lbnRJZCcpO1xuICAgICAgICBpZiAoIWVudGl0bGVtZW50SWQpIHtcbiAgICAgICAgICB1bmJyaWRnZWQucHVzaCh7XG4gICAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgICAgcmVhc29uOiAncmV2ZXJzYWwgZXZlbnQgbmVlZHMgZW50aXRsZW1lbnRJZCB0byByZXZva2UgYSBsZWRnZXIgZW50aXRsZW1lbnQnLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGxlZGdlckV2ZW50cy5wdXNoKHtcbiAgICAgICAgICBsZWRnZXJFdmVudElkOiBsZWRnZXJFdmVudElkKGV2ZW50LCAnMS1lbnRpdGxlbWVudC1yZXZva2VkJyksXG4gICAgICAgICAga2luZDogJ2VudGl0bGVtZW50LnJldm9rZWQnLFxuICAgICAgICAgIG9jY3VycmVkQXRNczogYXQsXG4gICAgICAgICAgc291cmNlOiBzb3VyY2UoZXZlbnQpLFxuICAgICAgICAgIHBheWxvYWQ6IHsgZW50aXRsZW1lbnRJZCwgcmVhc29uOiByZWFkU3RyaW5nKHAsICdyZWFzb24nKSA/PyAncmV2ZXJzYWwnIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY2FzZSAnZW50aXRsZW1lbnQnOlxuICAgICAgY2FzZSAndXNhZ2UtcmVjZWlwdCc6XG4gICAgICBjYXNlICdzZXR0bGVtZW50LXByb29mJzpcbiAgICAgIGNhc2UgJ3JldmVudWUtc3BsaXQnOlxuICAgICAgICBkZWZlcnJlZFRvUm9sbHVwLnB1c2goZXZlbnQuZXZlbnRJZCk7XG4gICAgICAgIGNvbnRpbnVlO1xuXG4gICAgICBkZWZhdWx0OlxuICAgICAgICB1bmJyaWRnZWQucHVzaCh7XG4gICAgICAgICAgZXZlbnRJZDogZXZlbnQuZXZlbnRJZCxcbiAgICAgICAgICByZWFzb246IGB1bnN1cHBvcnRlZCBjb21tZXJjZSBldmVudCBraW5kICcke1N0cmluZyhldmVudC5raW5kKX0nYCxcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgbGVkZ2VyRXZlbnRzLCBkZWZlcnJlZFRvUm9sbHVwLCB1bmJyaWRnZWQgfTtcbn1cblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBQZXItdXNlIHJvbGx1cCDigJQgbWljcm9zLCBuZXZlciByb3VuZGVkXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiBPbmUgcGVyLXVzZSBjaGFubmVsJ3MgcG9zaXRpb24uXG4gKlxuICogRXZlcnkgbWljcm9zIGZpZWxkIGlzIGEgREVDSU1BTCBTVFJJTkcgb2YgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgbWF0Y2hpbmdcbiAqIGBidWlsZFNldHRsZW1lbnRQcm9vZkV2ZW50YCdzIHBheWxvYWQgY29udmVudGlvbi4gSXQgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhXG4gKiBgbnVtYmVyYDogYSBjdW11bGF0aXZlIGNsYWltIGNhbiBleGNlZWQgYE51bWJlci5NQVhfU0FGRV9JTlRFR0VSYCwgYW5kIGl0IGlzXG4gKiBkZWxpYmVyYXRlbHkgbm90IGEgYGJpZ2ludGAsIGJlY2F1c2UgdGhpcyB2YWx1ZSBjcm9zc2VzIHRoZSBhZ2VudC10b29sIEpTT05cbiAqIGJvdW5kYXJ5IHdoZXJlIGBiaWdpbnRgIGRvZXMgbm90IHNlcmlhbGl6ZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQZXJVc2VDaGFubmVsUG9zaXRpb24ge1xuICByZWFkb25seSBjaGFubmVsSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVsZWFzZVJlZjogc3RyaW5nIHwgbnVsbDtcbiAgcmVhZG9ubHkgcGF5ZXI6IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IHNlbGxlcjogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFN1bW1lZCBgdXNhZ2UtcmVjZWlwdGAgYW1vdW50cyDigJQgbW9uZXkgQ0xBSU1FRCwgbm90IG1vbmV5IHJlY2VpdmVkLiAqL1xuICByZWFkb25seSBjbGFpbWVkTWljcm9zOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlY2VpcHRzOiBudW1iZXI7XG4gIC8qKiBTdW1tZWQgYHNldHRsZW1lbnQtcHJvb2ZgIGFtb3VudHMgd2l0aCBgZmluYWw6IHRydWVgIOKAlCBtb25leSBSRUNFSVZFRC4gKi9cbiAgcmVhZG9ubHkgc2V0dGxlZE1pY3Jvczogc3RyaW5nO1xuICAvKiogQ2xhaW1lZCBvbiBjaGFpbiBidXQgbm90IHlldCBmaW5hbCAoYGZpbmFsaXR5OiAnY2xhaW1lZCdgKS4gKi9cbiAgcmVhZG9ubHkgcGVuZGluZ1NldHRsZW1lbnRNaWNyb3M6IHN0cmluZztcbiAgLyoqIFN1bW1lZCBgcmV2ZXJzYWxgIGFtb3VudHMgbmFtaW5nIHRoaXMgY2hhbm5lbC4gKi9cbiAgcmVhZG9ubHkgcmV2ZXJzZWRNaWNyb3M6IHN0cmluZztcbiAgLyoqIGBzZXR0bGVkTWljcm9zIC0gcmV2ZXJzZWRNaWNyb3NgLCBmbG9vcmVkIGF0IHplcm8uICovXG4gIHJlYWRvbmx5IG5ldFNldHRsZWRNaWNyb3M6IHN0cmluZztcbiAgLyoqIFNoYXJlcyBvZiBmaW5hbCBzZXR0bGVtZW50IHByb2NlZWRzLCBub3QgcHJvb2YgdGhhdCBhIHBheWVlIHdhcyBwYWlkLiAqL1xuICByZWFkb25seSBzZXR0bGVkQWxsb2NhdGlvbnM/OiB7XG4gICAgcmVhZG9ubHkgZGFvTWljcm9zOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgY29tcG9uZW50QXV0aG9yc01pY3JvczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG4gIH07XG4gIC8qKiBTdWNjZXNzZnVsIGNoYWluIHN1Ym1pc3Npb24gcmVjZWlwdHM7IHRoaXMgZG9lcyBub3QgYXNzZXJ0IHBheW91dCBmaW5hbGl0eS4gKi9cbiAgcmVhZG9ubHkgc3VibWl0dGVkUGF5b3V0cz86IHtcbiAgICByZWFkb25seSBkYW9NaWNyb3M6IHN0cmluZztcbiAgICByZWFkb25seSBjb21wb25lbnRBdXRob3JzTWljcm9zOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PjtcbiAgfTtcbiAgcmVhZG9ubHkgbGFzdEV2ZW50QXRNczogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFBlclVzZVJvbGx1cCB7XG4gIHJlYWRvbmx5IGNoYW5uZWxzOiByZWFkb25seSBQZXJVc2VDaGFubmVsUG9zaXRpb25bXTtcbiAgcmVhZG9ubHkgdG90YWxzOiB7XG4gICAgcmVhZG9ubHkgY2xhaW1lZE1pY3Jvczogc3RyaW5nO1xuICAgIHJlYWRvbmx5IHNldHRsZWRNaWNyb3M6IHN0cmluZztcbiAgICByZWFkb25seSBwZW5kaW5nU2V0dGxlbWVudE1pY3Jvczogc3RyaW5nO1xuICAgIHJlYWRvbmx5IHJldmVyc2VkTWljcm9zOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgbmV0U2V0dGxlZE1pY3Jvczogc3RyaW5nO1xuICB9O1xuICByZWFkb25seSB1bnVzYWJsZTogcmVhZG9ubHkgQnJpZGdlSXNzdWVbXTtcbn1cblxuaW50ZXJmYWNlIENoYW5uZWxBY2N1bXVsYXRvciB7XG4gIGNoYW5uZWxJZDogc3RyaW5nO1xuICByZWxlYXNlUmVmOiBzdHJpbmcgfCBudWxsO1xuICBwYXllcjogc3RyaW5nIHwgbnVsbDtcbiAgc2VsbGVyOiBzdHJpbmcgfCBudWxsO1xuICBjbGFpbWVkTWljcm9zOiBiaWdpbnQ7XG4gIHJlY2VpcHRzOiBudW1iZXI7XG4gIHNldHRsZWRNaWNyb3M6IGJpZ2ludDtcbiAgcGVuZGluZ1NldHRsZW1lbnRNaWNyb3M6IGJpZ2ludDtcbiAgcmV2ZXJzZWRNaWNyb3M6IGJpZ2ludDtcbiAgc2V0dGxlZEFsbG9jYXRpb25zPzogeyBkYW9NaWNyb3M6IGJpZ2ludDsgY29tcG9uZW50QXV0aG9yc01pY3JvczogTWFwPHN0cmluZywgYmlnaW50PiB9O1xuICBzdWJtaXR0ZWRQYXlvdXRzPzogeyBkYW9NaWNyb3M6IGJpZ2ludDsgY29tcG9uZW50QXV0aG9yc01pY3JvczogTWFwPHN0cmluZywgYmlnaW50PiB9O1xuICBsYXN0RXZlbnRBdE1zOiBudW1iZXI7XG59XG5cbmZ1bmN0aW9uIGFjY3VtdWxhdG9yRm9yKFxuICBjaGFubmVsczogTWFwPHN0cmluZywgQ2hhbm5lbEFjY3VtdWxhdG9yPixcbiAgY2hhbm5lbElkOiBzdHJpbmcsXG4pOiBDaGFubmVsQWNjdW11bGF0b3Ige1xuICBjb25zdCBleGlzdGluZyA9IGNoYW5uZWxzLmdldChjaGFubmVsSWQpO1xuICBpZiAoZXhpc3RpbmcpIHJldHVybiBleGlzdGluZztcbiAgY29uc3QgY3JlYXRlZDogQ2hhbm5lbEFjY3VtdWxhdG9yID0ge1xuICAgIGNoYW5uZWxJZCxcbiAgICByZWxlYXNlUmVmOiBudWxsLFxuICAgIHBheWVyOiBudWxsLFxuICAgIHNlbGxlcjogbnVsbCxcbiAgICBjbGFpbWVkTWljcm9zOiAwbixcbiAgICByZWNlaXB0czogMCxcbiAgICBzZXR0bGVkTWljcm9zOiAwbixcbiAgICBwZW5kaW5nU2V0dGxlbWVudE1pY3JvczogMG4sXG4gICAgcmV2ZXJzZWRNaWNyb3M6IDBuLFxuICAgIGxhc3RFdmVudEF0TXM6IDAsXG4gIH07XG4gIGNoYW5uZWxzLnNldChjaGFubmVsSWQsIGNyZWF0ZWQpO1xuICByZXR1cm4gY3JlYXRlZDtcbn1cblxuLyoqXG4gKiBGb2xkIHBlci11c2UgdXNhZ2UsIHNldHRsZW1lbnQgYW5kIHJldmVyc2FsIGZhY3RzIGludG8gYSBwZXItY2hhbm5lbCB2aWV3LlxuICpcbiAqIFRoaXMgaXMgd2hhdCBtYWtlcyBwZXItdXNlIHJldmVudWUgYW5kIHJldmVyc2FscyB2aXNpYmxlIHRvIGEgZGFzaGJvYXJkXG4gKiBXSVRIT1VUIHJvdW5kaW5nIGEgc3ViLWNlbnQgcmVjZWlwdCB0byB6ZXJvLiBgY2xhaW1lZE1pY3Jvc2AgYW5kXG4gKiBgc2V0dGxlZE1pY3Jvc2AgYXJlIHJlcG9ydGVkIHNlcGFyYXRlbHkgYW5kIG5ldmVyIHN1bW1lZCB0b2dldGhlciwgYmVjYXVzZSBhXG4gKiBjdW11bGF0aXZlIHZvdWNoZXIncyBjbGFpbSBpcyBhIHByb21pc2UgdGhlIHNlbGxlciBob2xkcyBhbmQgYSBzZXR0bGVtZW50XG4gKiBwcm9vZiBpcyBtb25leSB0aGF0IGFjdHVhbGx5IG1vdmVkIOKAlCBjb25mbGF0aW5nIHRoZW0gaXMgcHJlY2lzZWx5IHRoZVxuICogXCJwYXltZW50IGNsYWltIHZzIHBheW1lbnQgZmluYWxpdHlcIiBlcnJvciBhY2NlcHRhbmNlIGxpbmUgMTQgZm9yYmlkcy5cbiAqXG4gKiBBIHNldHRsZW1lbnQgcHJvb2YncyBgY2xhaW1NaWNyb3NgIGlzIHRoZSBhbW91bnQgVEhJUyBiYXRjaCBzZXR0bGVzIChhXG4gKiBgY3VtdWxhdGl2ZUNsYWltTWljcm9zYCBpcyB0aGUgcnVubmluZyB0b3RhbCB0aGUgY2hhbm5lbCBoYXMgZXZlciBjbGFpbWVkLCBzb1xuICogc3VtbWluZyB0aGF0IGFjcm9zcyBwcm9vZnMgd291bGQgbXVsdGlwbHktY291bnQgZXZlcnkgZWFybGllciB1bml0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBlclVzZVJvbGx1cChhY2NlcHRlZDogcmVhZG9ubHkgQ29tbWVyY2VFdmVudFtdKTogUGVyVXNlUm9sbHVwIHtcbiAgY29uc3QgY2hhbm5lbHMgPSBuZXcgTWFwPHN0cmluZywgQ2hhbm5lbEFjY3VtdWxhdG9yPigpO1xuICBjb25zdCB1bnVzYWJsZTogQnJpZGdlSXNzdWVbXSA9IFtdO1xuICBjb25zdCBzZXR0bGVkUmVxdWVzdEhhc2hlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBwYXlvdXRLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBldmVudCBvZiBhY2NlcHRlZCkge1xuICAgIC8vIFRoZSByZXZlbnVlLXNwbGl0IGtpbmQgYWxzbyBjYXJyaWVzIGFsbG9jYXRpb25zIGFuZCB0cmVhc3VyeSByZXNlcnZlXG4gICAgLy8gbW92ZW1lbnRzLiBPbmx5IGV4cGxpY2l0IERBTy9jb21wb25lbnQgcGF5b3V0IHJlY2VpcHRzIGJlbG9uZyBoZXJlLlxuICAgIGlmIChldmVudC5raW5kID09PSAncmV2ZW51ZS1zcGxpdCcgJiYgKGV2ZW50LnBheWxvYWQucGF5b3V0U3RhdHVzID09PSB1bmRlZmluZWQgfHxcbiAgICAgICAgKGV2ZW50LnBheWxvYWQuc2hhcmUgIT09ICdkYW8nICYmIGV2ZW50LnBheWxvYWQuc2hhcmUgIT09ICdjb21wb25lbnQnKSkpIGNvbnRpbnVlO1xuICAgIGlmIChcbiAgICAgIGV2ZW50LmtpbmQgIT09ICd1c2FnZS1yZWNlaXB0JyAmJlxuICAgICAgZXZlbnQua2luZCAhPT0gJ3NldHRsZW1lbnQtcHJvb2YnICYmXG4gICAgICBldmVudC5raW5kICE9PSAncmV2ZW51ZS1zcGxpdCcgJiZcbiAgICAgIGV2ZW50LmtpbmQgIT09ICdyZXZlcnNhbCdcbiAgICApIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBwID0gZXZlbnQucGF5bG9hZDtcbiAgICBjb25zdCBjaGFubmVsSWQgPSByZWFkU3RyaW5nKHAsICdjaGFubmVsSWQnKTtcbiAgICBpZiAoIWNoYW5uZWxJZCkge1xuICAgICAgLy8gQSByZXZlcnNhbCB0aGF0IG5hbWVzIG5vIGNoYW5uZWwgaXMgc3RpbGwgYSByZWFsIGxlZGdlciBmYWN0IChpdFxuICAgICAgLy8gcmV2b2tlcyBhbiBlbnRpdGxlbWVudCk7IGl0IHNpbXBseSBjYW5ub3QgYmUgYXR0cmlidXRlZCB0byBhIHBlci11c2VcbiAgICAgIC8vIHBvc2l0aW9uLCBzbyBpdCBpcyByZXBvcnRlZCBoZXJlIHJhdGhlciB0aGFuIGRyb3BwZWQuXG4gICAgICBpZiAoZXZlbnQua2luZCAhPT0gJ3JldmVyc2FsJykge1xuICAgICAgICB1bnVzYWJsZS5wdXNoKHtcbiAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgIHJlYXNvbjogYCR7ZXZlbnQua2luZH0gZXZlbnQgbmVlZHMgY2hhbm5lbElkIHRvIGJlIGF0dHJpYnV0ZWQgdG8gYSBwZXItdXNlIHBvc2l0aW9uYCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFubmVsID0gYWNjdW11bGF0b3JGb3IoY2hhbm5lbHMsIGNoYW5uZWxJZCk7XG4gICAgaWYgKGV2ZW50Lm9jY3VycmVkQXRNcyA+IGNoYW5uZWwubGFzdEV2ZW50QXRNcykgY2hhbm5lbC5sYXN0RXZlbnRBdE1zID0gZXZlbnQub2NjdXJyZWRBdE1zO1xuICAgIGNoYW5uZWwucmVsZWFzZVJlZiA9IGNoYW5uZWwucmVsZWFzZVJlZiA/PyByZWFkU3RyaW5nKHAsICdyZWxlYXNlUmVmJyk7XG4gICAgY2hhbm5lbC5wYXllciA9IGNoYW5uZWwucGF5ZXIgPz8gcmVhZFN0cmluZyhwLCAncGF5ZXInKTtcbiAgICBjaGFubmVsLnNlbGxlciA9IGNoYW5uZWwuc2VsbGVyID8/IHJlYWRTdHJpbmcocCwgJ3NlbGxlcicpO1xuXG4gICAgaWYgKGV2ZW50LmtpbmQgPT09ICdyZXZlbnVlLXNwbGl0Jykge1xuICAgICAgY29uc3QgYW1vdW50ID0gcmVhZE1pY3JvcyhwLmFtb3VudE1pY3Jvcyk7XG4gICAgICBjb25zdCBzaGFyZSA9IHJlYWRTdHJpbmcocCwgJ3NoYXJlJyk7XG4gICAgICBjb25zdCBwYXllZUlkID0gcmVhZFN0cmluZyhwLCAncGF5ZWVJZCcpO1xuICAgICAgY29uc3QgcmVjZWlwdEhhc2ggPSByZWFkU3RyaW5nKHAsICdyZWNlaXB0SGFzaCcpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb25IYXNoID0gcmVhZFN0cmluZyhwLCAndHJhbnNhY3Rpb25IYXNoJyk7XG4gICAgICBjb25zdCByZWNpcGllbnQgPSByZWFkU3RyaW5nKHAsICdyZWNpcGllbnQnKTtcbiAgICAgIGlmIChwLnBheW91dFN0YXR1cyAhPT0gJ3N1Ym1pdHRlZCcgfHwgIXJlY2VpcHRIYXNoIHx8ICFyZWFkU3RyaW5nKHAsICdzYWZlVHhIYXNoJykgfHxcbiAgICAgICAgICAhdHJhbnNhY3Rpb25IYXNoIHx8ICEvXjB4WzAtOWEtZkEtRl17NjR9JC8udGVzdCh0cmFuc2FjdGlvbkhhc2gpIHx8XG4gICAgICAgICAgIXJlY2lwaWVudCB8fCAhL14weFswLTlhLWZBLUZdezQwfSQvLnRlc3QocmVjaXBpZW50KSB8fCBhbW91bnQgPT09IG51bGwgfHwgYW1vdW50IDw9IDBuIHx8XG4gICAgICAgICAgKHNoYXJlICE9PSAnZGFvJyAmJiBzaGFyZSAhPT0gJ2NvbXBvbmVudCcpIHx8IChzaGFyZSA9PT0gJ2NvbXBvbmVudCcgJiYgIXBheWVlSWQpKSB7XG4gICAgICAgIHVudXNhYmxlLnB1c2goeyBldmVudElkOiBldmVudC5ldmVudElkLCByZWFzb246ICdwYXlvdXQgc3RhdGVtZW50IG5lZWRzIGEgc3VjY2Vzc2Z1bCBzdWJtaXNzaW9uIHJlY2VpcHQsIGV4YWN0IG1pY3JvcyBhbmQgY29tcG9uZW50IHBheWVlIGlkZW50aXR5JyB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBrZXkgPSBKU09OLnN0cmluZ2lmeShbcmVjZWlwdEhhc2gsIHNoYXJlLCBwYXllZUlkID8/ICcnXSk7XG4gICAgICBpZiAocGF5b3V0S2V5cy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICBwYXlvdXRLZXlzLmFkZChrZXkpO1xuICAgICAgY2hhbm5lbC5zdWJtaXR0ZWRQYXlvdXRzID8/PSB7IGRhb01pY3JvczogMG4sIGNvbXBvbmVudEF1dGhvcnNNaWNyb3M6IG5ldyBNYXAoKSB9O1xuICAgICAgaWYgKHNoYXJlID09PSAnZGFvJykgY2hhbm5lbC5zdWJtaXR0ZWRQYXlvdXRzLmRhb01pY3JvcyArPSBhbW91bnQ7XG4gICAgICBlbHNlIGNoYW5uZWwuc3VibWl0dGVkUGF5b3V0cy5jb21wb25lbnRBdXRob3JzTWljcm9zLnNldChwYXllZUlkISxcbiAgICAgICAgKGNoYW5uZWwuc3VibWl0dGVkUGF5b3V0cy5jb21wb25lbnRBdXRob3JzTWljcm9zLmdldChwYXllZUlkISkgPz8gMG4pICsgYW1vdW50KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChldmVudC5raW5kID09PSAndXNhZ2UtcmVjZWlwdCcpIHtcbiAgICAgIGNvbnN0IG1pY3JvcyA9IHJlYWRNaWNyb3MocC5hbW91bnRNaWNyb3MpO1xuICAgICAgaWYgKG1pY3JvcyA9PT0gbnVsbCkge1xuICAgICAgICB1bnVzYWJsZS5wdXNoKHtcbiAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgIHJlYXNvbjogJ3VzYWdlLXJlY2VpcHQgbmVlZHMgYW1vdW50TWljcm9zIGFzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIgKGRlY2ltYWwgc3RyaW5nKScsXG4gICAgICAgIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNoYW5uZWwuY2xhaW1lZE1pY3JvcyArPSBtaWNyb3M7XG4gICAgICBjaGFubmVsLnJlY2VpcHRzICs9IDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoZXZlbnQua2luZCA9PT0gJ3NldHRsZW1lbnQtcHJvb2YnKSB7XG4gICAgICBjb25zdCBtaWNyb3MgPSByZWFkTWljcm9zKHAuY2xhaW1NaWNyb3MpO1xuICAgICAgaWYgKG1pY3JvcyA9PT0gbnVsbCkge1xuICAgICAgICB1bnVzYWJsZS5wdXNoKHtcbiAgICAgICAgICBldmVudElkOiBldmVudC5ldmVudElkLFxuICAgICAgICAgIHJlYXNvbjogJ3NldHRsZW1lbnQtcHJvb2YgbmVlZHMgY2xhaW1NaWNyb3MgYXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciAoZGVjaW1hbCBzdHJpbmcpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgaXNGaW5hbCA9IHAuZmluYWwgPT09IHRydWUgfHwgcmVhZFN0cmluZyhwLCAnZmluYWxpdHknKSA9PT0gJ2ZpbmFsJztcbiAgICAgIGNvbnN0IHJlcXVlc3RIYXNoID0gcmVhZFN0cmluZyhwLCAncmVxdWVzdEhhc2gnKTtcbiAgICAgIGlmIChpc0ZpbmFsKSB7XG4gICAgICAgIC8vIFRoZSBgY2xhaW1lZGAgYW5kIGBmaW5hbGAgcHJvb2ZzIG9mIE9ORSBiYXRjaCBhcmUgdHdvIGRpc3RpbmN0IGV2ZW50c1xuICAgICAgICAvLyBieSBjb25zdHJ1Y3Rpb24gKGBidWlsZFNldHRsZW1lbnRQcm9vZkV2ZW50YCBkZXJpdmVzIGVhY2ggaWQgZnJvbSB0aGVcbiAgICAgICAgLy8gZmluYWxpdHkpLiBDb3VudGluZyB0aGUgZmluYWwgb25lIG1vdmVzIHRoZSBiYXRjaCBvdXQgb2YgcGVuZGluZ1xuICAgICAgICAvLyByYXRoZXIgdGhhbiBhZGRpbmcgdG8gaXQg4oCUIGtleWVkIG9uIHJlcXVlc3RIYXNoIHNvIGFuIG91dC1vZi1vcmRlclxuICAgICAgICAvLyBhcnJpdmFsIG9mIHRoZSBjbGFpbWVkIHByb29mIGNhbm5vdCByZXN1cnJlY3QgdGhlIHBlbmRpbmcgYW1vdW50LlxuICAgICAgICBzZXR0bGVkUmVxdWVzdEhhc2hlcy5hZGQocmVxdWVzdEhhc2ggPz8gZXZlbnQuZXZlbnRJZCk7XG4gICAgICAgIGNoYW5uZWwuc2V0dGxlZE1pY3JvcyArPSBtaWNyb3M7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKHAsICdjb21wb25lbnRBbGxvY2F0aW9uc01pY3JvcycpKSB7XG4gICAgICAgICAgY29uc3QgYXV0aG9ycyA9IHAuY29tcG9uZW50QWxsb2NhdGlvbnNNaWNyb3M7XG4gICAgICAgICAgY29uc3Qgc2hhcmVzID0gcC5hbGxvY2F0aW9uc01pY3JvcztcbiAgICAgICAgICBjb25zdCB2YWxpZE9iamVjdCA9ICh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gICAgICAgICAgICB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbiAgICAgICAgICBjb25zdCBlbnRyaWVzID0gdmFsaWRPYmplY3QoYXV0aG9ycykgPyBPYmplY3QuZW50cmllcyhhdXRob3JzKSA6IFtdO1xuICAgICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IHZhbGlkT2JqZWN0KHNoYXJlcykgPyByZWFkTWljcm9zKHNoYXJlcy5jb21wb25lbnQpIDogbnVsbDtcbiAgICAgICAgICBjb25zdCBkYW8gPSB2YWxpZE9iamVjdChzaGFyZXMpID8gcmVhZE1pY3JvcyhzaGFyZXMuZGFvKSA6IG51bGw7XG4gICAgICAgICAgY29uc3QgcGFyc2VkID0gZW50cmllcy5tYXAoKFthdXRob3IsIGFtb3VudF0pID0+IFthdXRob3IsIHJlYWRNaWNyb3MoYW1vdW50KV0gYXMgY29uc3QpO1xuICAgICAgICAgIGlmICghdmFsaWRPYmplY3QoYXV0aG9ycykgfHwgY29tcG9uZW50ID09PSBudWxsIHx8IGRhbyA9PT0gbnVsbCB8fFxuICAgICAgICAgICAgICBwYXJzZWQuc29tZSgoW2F1dGhvciwgYW1vdW50XSkgPT4gIWF1dGhvci50cmltKCkgfHwgYW1vdW50ID09PSBudWxsKSB8fFxuICAgICAgICAgICAgICBwYXJzZWQucmVkdWNlKChzdW0sIFssIGFtb3VudF0pID0+IHN1bSArIChhbW91bnQgPz8gMG4pLCAwbikgIT09IGNvbXBvbmVudCkge1xuICAgICAgICAgICAgdW51c2FibGUucHVzaCh7IGV2ZW50SWQ6IGV2ZW50LmV2ZW50SWQsIHJlYXNvbjogJ3NldHRsZW1lbnQgY29tcG9uZW50IGF1dGhvciBhbGxvY2F0aW9ucyBtdXN0IGJlIGludGVnZXIgbWljcm9zIHN1bW1pbmcgdG8gdGhlIGNvbXBvbmVudCBzaGFyZSwgd2l0aCBhIERBTyBzaGFyZScgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IGFsbG9jYXRpb24gPSBjaGFubmVsLnNldHRsZWRBbGxvY2F0aW9ucyA/Pz0geyBkYW9NaWNyb3M6IDBuLCBjb21wb25lbnRBdXRob3JzTWljcm9zOiBuZXcgTWFwKCkgfTtcbiAgICAgICAgICAgIGFsbG9jYXRpb24uZGFvTWljcm9zICs9IGRhbztcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2F1dGhvciwgYW1vdW50XSBvZiBwYXJzZWQpIHtcbiAgICAgICAgICAgICAgYWxsb2NhdGlvbi5jb21wb25lbnRBdXRob3JzTWljcm9zLnNldChhdXRob3IsIChhbGxvY2F0aW9uLmNvbXBvbmVudEF1dGhvcnNNaWNyb3MuZ2V0KGF1dGhvcikgPz8gMG4pICsgYW1vdW50ISk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKCFzZXR0bGVkUmVxdWVzdEhhc2hlcy5oYXMocmVxdWVzdEhhc2ggPz8gZXZlbnQuZXZlbnRJZCkpIHtcbiAgICAgICAgY2hhbm5lbC5wZW5kaW5nU2V0dGxlbWVudE1pY3JvcyArPSBtaWNyb3M7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyByZXZlcnNhbFxuICAgIGNvbnN0IG1pY3JvcyA9IHJlYWRNaWNyb3MocC5hbW91bnRNaWNyb3MpID8/IHJlYWRNaWNyb3MocC5yZXZlcnNlZE1pY3Jvcyk7XG4gICAgaWYgKG1pY3JvcyA9PT0gbnVsbCkge1xuICAgICAgdW51c2FibGUucHVzaCh7XG4gICAgICAgIGV2ZW50SWQ6IGV2ZW50LmV2ZW50SWQsXG4gICAgICAgIHJlYXNvbjpcbiAgICAgICAgICAncmV2ZXJzYWwgbmFtZXMgYSBjaGFubmVsIGJ1dCBjYXJyaWVzIG5vIGFtb3VudE1pY3Jvcy9yZXZlcnNlZE1pY3Jvcywgc28gaXRzIHBlci11c2UgZWZmZWN0IGNhbm5vdCBiZSBtZWFzdXJlZCcsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjaGFubmVsLnJldmVyc2VkTWljcm9zICs9IG1pY3JvcztcbiAgfVxuXG4gIC8vIEEgYGZpbmFsYCBwcm9vZiBjYW4gYXJyaXZlIGJlZm9yZSB0aGUgYGNsYWltZWRgIG9uZSBpdCBzdXBlcnNlZGVzLCBzbyB0aGVcbiAgLy8gcGVuZGluZyBjb2x1bW4gaXMgY29ycmVjdGVkIGFmdGVyIHRoZSBmb2xkIHJhdGhlciB0aGFuIGR1cmluZyBpdC5cbiAgZm9yIChjb25zdCBjaGFubmVsIG9mIGNoYW5uZWxzLnZhbHVlcygpKSB7XG4gICAgaWYgKGNoYW5uZWwuc2V0dGxlZE1pY3JvcyA+IDBuICYmIGNoYW5uZWwucGVuZGluZ1NldHRsZW1lbnRNaWNyb3MgPiAwbikge1xuICAgICAgY29uc3QgY29ycmVjdGVkID0gY2hhbm5lbC5wZW5kaW5nU2V0dGxlbWVudE1pY3JvcyAtIGNoYW5uZWwuc2V0dGxlZE1pY3JvcztcbiAgICAgIGNoYW5uZWwucGVuZGluZ1NldHRsZW1lbnRNaWNyb3MgPSBjb3JyZWN0ZWQgPiAwbiA/IGNvcnJlY3RlZCA6IDBuO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG9yZGVyZWQgPSBbLi4uY2hhbm5lbHMudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IGEuY2hhbm5lbElkLmxvY2FsZUNvbXBhcmUoYi5jaGFubmVsSWQpKTtcbiAgY29uc3QgdG90YWxzID0geyBjbGFpbWVkOiAwbiwgc2V0dGxlZDogMG4sIHBlbmRpbmc6IDBuLCByZXZlcnNlZDogMG4sIG5ldDogMG4gfTtcbiAgY29uc3QgbGluZXMgPSBvcmRlcmVkLm1hcCgoY2hhbm5lbCkgPT4ge1xuICAgIGNvbnN0IG5ldCA9XG4gICAgICBjaGFubmVsLnNldHRsZWRNaWNyb3MgPiBjaGFubmVsLnJldmVyc2VkTWljcm9zXG4gICAgICAgID8gY2hhbm5lbC5zZXR0bGVkTWljcm9zIC0gY2hhbm5lbC5yZXZlcnNlZE1pY3Jvc1xuICAgICAgICA6IDBuO1xuICAgIHRvdGFscy5jbGFpbWVkICs9IGNoYW5uZWwuY2xhaW1lZE1pY3JvcztcbiAgICB0b3RhbHMuc2V0dGxlZCArPSBjaGFubmVsLnNldHRsZWRNaWNyb3M7XG4gICAgdG90YWxzLnBlbmRpbmcgKz0gY2hhbm5lbC5wZW5kaW5nU2V0dGxlbWVudE1pY3JvcztcbiAgICB0b3RhbHMucmV2ZXJzZWQgKz0gY2hhbm5lbC5yZXZlcnNlZE1pY3JvcztcbiAgICB0b3RhbHMubmV0ICs9IG5ldDtcbiAgICByZXR1cm4ge1xuICAgICAgY2hhbm5lbElkOiBjaGFubmVsLmNoYW5uZWxJZCxcbiAgICAgIHJlbGVhc2VSZWY6IGNoYW5uZWwucmVsZWFzZVJlZixcbiAgICAgIHBheWVyOiBjaGFubmVsLnBheWVyLFxuICAgICAgc2VsbGVyOiBjaGFubmVsLnNlbGxlcixcbiAgICAgIGNsYWltZWRNaWNyb3M6IGNoYW5uZWwuY2xhaW1lZE1pY3Jvcy50b1N0cmluZygpLFxuICAgICAgcmVjZWlwdHM6IGNoYW5uZWwucmVjZWlwdHMsXG4gICAgICBzZXR0bGVkTWljcm9zOiBjaGFubmVsLnNldHRsZWRNaWNyb3MudG9TdHJpbmcoKSxcbiAgICAgIHBlbmRpbmdTZXR0bGVtZW50TWljcm9zOiBjaGFubmVsLnBlbmRpbmdTZXR0bGVtZW50TWljcm9zLnRvU3RyaW5nKCksXG4gICAgICByZXZlcnNlZE1pY3JvczogY2hhbm5lbC5yZXZlcnNlZE1pY3Jvcy50b1N0cmluZygpLFxuICAgICAgbmV0U2V0dGxlZE1pY3JvczogbmV0LnRvU3RyaW5nKCksXG4gICAgICAuLi4oY2hhbm5lbC5zZXR0bGVkQWxsb2NhdGlvbnMgPyB7IHNldHRsZWRBbGxvY2F0aW9uczoge1xuICAgICAgICBkYW9NaWNyb3M6IGNoYW5uZWwuc2V0dGxlZEFsbG9jYXRpb25zLmRhb01pY3Jvcy50b1N0cmluZygpLFxuICAgICAgICBjb21wb25lbnRBdXRob3JzTWljcm9zOiBPYmplY3QuZnJvbUVudHJpZXMoWy4uLmNoYW5uZWwuc2V0dGxlZEFsbG9jYXRpb25zLmNvbXBvbmVudEF1dGhvcnNNaWNyb3NdXG4gICAgICAgICAgLnNvcnQoKFthXSwgW2JdKSA9PiBhIDwgYiA/IC0xIDogYSA+IGIgPyAxIDogMClcbiAgICAgICAgICAubWFwKChbYXV0aG9yLCBhbW91bnRdKSA9PiBbYXV0aG9yLCBhbW91bnQudG9TdHJpbmcoKV0pKSxcbiAgICAgIH0gfSA6IHt9KSxcbiAgICAgIC4uLihjaGFubmVsLnN1Ym1pdHRlZFBheW91dHMgPyB7IHN1Ym1pdHRlZFBheW91dHM6IHtcbiAgICAgICAgZGFvTWljcm9zOiBjaGFubmVsLnN1Ym1pdHRlZFBheW91dHMuZGFvTWljcm9zLnRvU3RyaW5nKCksXG4gICAgICAgIGNvbXBvbmVudEF1dGhvcnNNaWNyb3M6IE9iamVjdC5mcm9tRW50cmllcyhbLi4uY2hhbm5lbC5zdWJtaXR0ZWRQYXlvdXRzLmNvbXBvbmVudEF1dGhvcnNNaWNyb3NdXG4gICAgICAgICAgLnNvcnQoKFthXSwgW2JdKSA9PiBhIDwgYiA/IC0xIDogYSA+IGIgPyAxIDogMClcbiAgICAgICAgICAubWFwKChbYXV0aG9yLCBhbW91bnRdKSA9PiBbYXV0aG9yLCBhbW91bnQudG9TdHJpbmcoKV0pKSxcbiAgICAgIH0gfSA6IHt9KSxcbiAgICAgIGxhc3RFdmVudEF0TXM6IGNoYW5uZWwubGFzdEV2ZW50QXRNcyxcbiAgICB9IHNhdGlzZmllcyBQZXJVc2VDaGFubmVsUG9zaXRpb247XG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAgY2hhbm5lbHM6IGxpbmVzLFxuICAgIHRvdGFsczoge1xuICAgICAgY2xhaW1lZE1pY3JvczogdG90YWxzLmNsYWltZWQudG9TdHJpbmcoKSxcbiAgICAgIHNldHRsZWRNaWNyb3M6IHRvdGFscy5zZXR0bGVkLnRvU3RyaW5nKCksXG4gICAgICBwZW5kaW5nU2V0dGxlbWVudE1pY3JvczogdG90YWxzLnBlbmRpbmcudG9TdHJpbmcoKSxcbiAgICAgIHJldmVyc2VkTWljcm9zOiB0b3RhbHMucmV2ZXJzZWQudG9TdHJpbmcoKSxcbiAgICAgIG5ldFNldHRsZWRNaWNyb3M6IHRvdGFscy5uZXQudG9TdHJpbmcoKSxcbiAgICB9LFxuICAgIHVudXNhYmxlLFxuICB9O1xufVxuXG4vKipcbiAqIE9uZSBvcmdhbml6YXRpb24ncyB2aWV3IG9mIHRoZSBwZXItdXNlIHJvbGx1cC5cbiAqXG4gKiBgZXhjbHVkZWRDaGFubmVsc2AgaXMgbm90IGRlY29yYXRpb246IHdpdGhvdXQgaXQgYW4gb3JnIHRoYXQgaXMgcGFydHkgdG8gbm9cbiAqIGNoYW5uZWwgYW5kIGFuIG9yZyB3aG9zZSBjaGFubmVscyB3ZXJlIGFsbCBmaWx0ZXJlZCBvdXQgcmVuZGVyIGlkZW50aWNhbGx5LFxuICogYW5kIFwieW91IGhhdmUgbm8gcGVyLXVzZSByZXZlbnVlXCIgd291bGQgYmUgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBcInRoaXMgdmlld1xuICogaXMgc2NvcGVkIGFuZCB5b3UgYXJlIG5vdCBzZWVpbmcgZXZlcnl0aGluZ1wiLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBlclVzZURhc2hib2FyZCB7XG4gIHJlYWRvbmx5IGNoYW5uZWxzOiByZWFkb25seSBQZXJVc2VDaGFubmVsUG9zaXRpb25bXTtcbiAgcmVhZG9ubHkgdG90YWxzOiBQZXJVc2VSb2xsdXBbJ3RvdGFscyddO1xuICAvKiogQ2hhbm5lbHMgcHJlc2VudCBpbiB0aGUgcm9sbHVwIHRoYXQgdGhpcyBvcmcgaXMgbm90IGEgcGFydHkgdG8uICovXG4gIHJlYWRvbmx5IGV4Y2x1ZGVkQ2hhbm5lbHM6IG51bWJlcjtcbiAgLyoqIEZhY3RzIHRoZSByb2xsdXAgY291bGQgbm90IGF0dHJpYnV0ZSDigJQgY2FycmllZCB0aHJvdWdoLCBuZXZlciBoaWRkZW4uICovXG4gIHJlYWRvbmx5IHVudXNhYmxlOiByZWFkb25seSBCcmlkZ2VJc3N1ZVtdO1xufVxuXG4vKipcbiAqIFNjb3BlIGEgcGVyLXVzZSByb2xsdXAgdG8gb25lIG9yZ2FuaXphdGlvbi5cbiAqXG4gKiBBIGNoYW5uZWwgaXMgdmlzaWJsZSB3aGVuIHRoZSBvcmcgaXMgaXRzIFBBWUVSIG9yIGl0cyBTRUxMRVIuIEFueXRoaW5nIGVsc2VcbiAqIGlzIGFub3RoZXIgcGFydHkncyBtb25leTogdGhlIGRhc2hib2FyZHMgZG9vciBpcyBhbiBhdXRob3JpemF0aW9uIGJvdW5kYXJ5LFxuICogYW5kIGEgcmVhZCBzdXJmYWNlIHRoYXQgc2hvd3MgYSBzdHJhbmdlcidzIHJldmVudWUgaXMgYSBsZWFrIHdoZXRoZXIgb3Igbm90XG4gKiBhbnlvbmUgbWVhbnQgaXQgYXMgb25lLiBUb3RhbHMgYXJlIHJlY29tcHV0ZWQgb3ZlciB0aGUgdmlzaWJsZSBjaGFubmVsc1xuICogcmF0aGVyIHRoYW4gY29waWVkIGZyb20gdGhlIHJvbGx1cCwgYmVjYXVzZSBhIHRvdGFsIHRoYXQgc2lsZW50bHkgaW5jbHVkZXNcbiAqIHJvd3MgdGhlIGNhbGxlciBjYW5ub3Qgc2VlIGlzIHdvcnNlIHRoYW4gbm8gdG90YWwgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGVyVXNlRGFzaGJvYXJkKFxuICByb2xsdXA6IFBlclVzZVJvbGx1cCB8IG51bGwsXG4gIG9yZ0lkOiBzdHJpbmcsXG4pOiBQZXJVc2VEYXNoYm9hcmQge1xuICBpZiAoIXJvbGx1cCkge1xuICAgIHJldHVybiB7XG4gICAgICBjaGFubmVsczogW10sXG4gICAgICB0b3RhbHM6IHtcbiAgICAgICAgY2xhaW1lZE1pY3JvczogJzAnLFxuICAgICAgICBzZXR0bGVkTWljcm9zOiAnMCcsXG4gICAgICAgIHBlbmRpbmdTZXR0bGVtZW50TWljcm9zOiAnMCcsXG4gICAgICAgIHJldmVyc2VkTWljcm9zOiAnMCcsXG4gICAgICAgIG5ldFNldHRsZWRNaWNyb3M6ICcwJyxcbiAgICAgIH0sXG4gICAgICBleGNsdWRlZENoYW5uZWxzOiAwLFxuICAgICAgdW51c2FibGU6IFtdLFxuICAgIH07XG4gIH1cbiAgY29uc3QgdmlzaWJsZSA9IHJvbGx1cC5jaGFubmVscy5maWx0ZXIoXG4gICAgKGNoYW5uZWwpID0+IGNoYW5uZWwucGF5ZXIgPT09IG9yZ0lkIHx8IGNoYW5uZWwuc2VsbGVyID09PSBvcmdJZCxcbiAgKTtcbiAgY29uc3QgdG90YWxzID0geyBjbGFpbWVkOiAwbiwgc2V0dGxlZDogMG4sIHBlbmRpbmc6IDBuLCByZXZlcnNlZDogMG4sIG5ldDogMG4gfTtcbiAgZm9yIChjb25zdCBjaGFubmVsIG9mIHZpc2libGUpIHtcbiAgICB0b3RhbHMuY2xhaW1lZCArPSBCaWdJbnQoY2hhbm5lbC5jbGFpbWVkTWljcm9zKTtcbiAgICB0b3RhbHMuc2V0dGxlZCArPSBCaWdJbnQoY2hhbm5lbC5zZXR0bGVkTWljcm9zKTtcbiAgICB0b3RhbHMucGVuZGluZyArPSBCaWdJbnQoY2hhbm5lbC5wZW5kaW5nU2V0dGxlbWVudE1pY3Jvcyk7XG4gICAgdG90YWxzLnJldmVyc2VkICs9IEJpZ0ludChjaGFubmVsLnJldmVyc2VkTWljcm9zKTtcbiAgICB0b3RhbHMubmV0ICs9IEJpZ0ludChjaGFubmVsLm5ldFNldHRsZWRNaWNyb3MpO1xuICB9XG4gIHJldHVybiB7XG4gICAgY2hhbm5lbHM6IHZpc2libGUsXG4gICAgdG90YWxzOiB7XG4gICAgICBjbGFpbWVkTWljcm9zOiB0b3RhbHMuY2xhaW1lZC50b1N0cmluZygpLFxuICAgICAgc2V0dGxlZE1pY3JvczogdG90YWxzLnNldHRsZWQudG9TdHJpbmcoKSxcbiAgICAgIHBlbmRpbmdTZXR0bGVtZW50TWljcm9zOiB0b3RhbHMucGVuZGluZy50b1N0cmluZygpLFxuICAgICAgcmV2ZXJzZWRNaWNyb3M6IHRvdGFscy5yZXZlcnNlZC50b1N0cmluZygpLFxuICAgICAgbmV0U2V0dGxlZE1pY3JvczogdG90YWxzLm5ldC50b1N0cmluZygpLFxuICAgIH0sXG4gICAgZXhjbHVkZWRDaGFubmVsczogcm9sbHVwLmNoYW5uZWxzLmxlbmd0aCAtIHZpc2libGUubGVuZ3RoLFxuICAgIHVudXNhYmxlOiByb2xsdXAudW51c2FibGUsXG4gIH07XG59XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gQ29tYmluaW5nIHRoZSB0d28gZW50aXRsZW1lbnQgdmlld3Ncbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5mdW5jdGlvbiBncmFudEtleU9mKGdyYW50OiBFbnRpdGxlbWVudEdyYW50KTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke2dyYW50LnN1YmplY3R9XFxuJHtncmFudC5yZWxlYXNlUmVmfWA7XG59XG5cbi8qKlxuICogQ29tYmluZSBlbnRpdGxlbWVudCBwcm9qZWN0aW9ucyBmcm9tIHNldmVyYWwgc291cmNlcyBpbnRvIHRoZSBvbmUgdmlldyBhXG4gKiBkZWxpdmVyeSBnYXRlIHJlYWRzLlxuICpcbiAqIFJFVk9DQVRJT04gSVMgVEVSTUlOQUwgQUNST1NTIFNPVVJDRVMuIElmIGFueSBwcm9qZWN0aW9uIHNheXMgYSBncmFudCBpc1xuICogcmV2b2tlZCwgdGhlIG1lcmdlZCBncmFudCBpcyByZXZva2VkIOKAlCB3aXRoIHRoZSBFQVJMSUVTVCByZXZvY2F0aW9uIHRpbWUsXG4gKiBiZWNhdXNlIGEgYnV5ZXIgd2hvc2UgcmVmdW5kIHNldHRsZWQgb24gdGhlIFAyUCByYWlsIG11c3Qgbm90IGtlZXAgZGVsaXZlcnlcbiAqIG1lcmVseSBiZWNhdXNlIHRoZSBsZWRnZXIncyBvd24gdmlldyBvZiB0aGF0IGdyYW50IGhhcyBub3QgY2F1Z2h0IHVwLiBUaGVcbiAqIGFzeW1tZXRyeSBpcyBkZWxpYmVyYXRlOiBhIGZhbHNlIHJldm9jYXRpb24gY29zdHMgYSBzdXBwb3J0IHRpY2tldCwgd2hpbGUgYVxuICogZmFsc2UgZ3JhbnQgaGFuZHMgb3ZlciBieXRlcyB0aGF0IHdlcmUgcGFpZCBmb3IgYW5kIHRoZW4gcmVmdW5kZWQuXG4gKlxuICogTGF0ZXIgc291cmNlcyB3aW4gb24gdGhlIG5vbi1yZXZvY2F0aW9uIGZpZWxkcywgc28gY2FsbGVycyBzaG91bGQgcGFzcyB0aGVcbiAqIG1vcmUgYXV0aG9yaXRhdGl2ZSBwcm9qZWN0aW9uIGxhc3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUVudGl0bGVtZW50UHJvamVjdGlvbnMoXG4gIC4uLnByb2plY3Rpb25zOiByZWFkb25seSBFbnRpdGxlbWVudFByb2plY3Rpb25bXVxuKTogRW50aXRsZW1lbnRQcm9qZWN0aW9uIHtcbiAgY29uc3QgZ3JhbnRzID0gbmV3IE1hcDxzdHJpbmcsIEVudGl0bGVtZW50R3JhbnQ+KCk7XG4gIGNvbnN0IHVudXNhYmxlOiBCcmlkZ2VJc3N1ZVtdID0gW107XG4gIGNvbnN0IHNlZW5Jc3N1ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHByb2plY3Rpb24gb2YgcHJvamVjdGlvbnMpIHtcbiAgICBmb3IgKGNvbnN0IGlzc3VlIG9mIHByb2plY3Rpb24udW51c2FibGUpIHtcbiAgICAgIGNvbnN0IGtleSA9IGAke2lzc3VlLmV2ZW50SWR9XFxuJHtpc3N1ZS5yZWFzb259YDtcbiAgICAgIGlmIChzZWVuSXNzdWVzLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgIHNlZW5Jc3N1ZXMuYWRkKGtleSk7XG4gICAgICB1bnVzYWJsZS5wdXNoKGlzc3VlKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBncmFudCBvZiBwcm9qZWN0aW9uLmdyYW50cy52YWx1ZXMoKSkge1xuICAgICAgY29uc3Qga2V5ID0gZ3JhbnRLZXlPZihncmFudCk7XG4gICAgICBjb25zdCBleGlzdGluZyA9IGdyYW50cy5nZXQoa2V5KTtcbiAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgZ3JhbnRzLnNldChrZXksIGdyYW50KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZXZva2VkQXRNcyA9XG4gICAgICAgIGV4aXN0aW5nLnJldm9rZWRBdE1zICE9IG51bGwgJiYgZ3JhbnQucmV2b2tlZEF0TXMgIT0gbnVsbFxuICAgICAgICAgID8gTWF0aC5taW4oZXhpc3RpbmcucmV2b2tlZEF0TXMsIGdyYW50LnJldm9rZWRBdE1zKVxuICAgICAgICAgIDogKGV4aXN0aW5nLnJldm9rZWRBdE1zID8/IGdyYW50LnJldm9rZWRBdE1zKTtcbiAgICAgIGNvbnN0IHJldm9rZWRSZWFzb24gPVxuICAgICAgICByZXZva2VkQXRNcyA9PSBudWxsXG4gICAgICAgICAgPyBudWxsXG4gICAgICAgICAgOiByZXZva2VkQXRNcyA9PT0gZXhpc3RpbmcucmV2b2tlZEF0TXNcbiAgICAgICAgICAgID8gKGV4aXN0aW5nLnJldm9rZWRSZWFzb24gPz8gZ3JhbnQucmV2b2tlZFJlYXNvbilcbiAgICAgICAgICAgIDogKGdyYW50LnJldm9rZWRSZWFzb24gPz8gZXhpc3RpbmcucmV2b2tlZFJlYXNvbik7XG4gICAgICBncmFudHMuc2V0KGtleSwgeyAuLi5leGlzdGluZywgLi4uZ3JhbnQsIHJldm9rZWRBdE1zLCByZXZva2VkUmVhc29uIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGdyYW50cywgdW51c2FibGUgfTtcbn1cblxuLyoqXG4gKiBUaGUgdHdvIHByb2R1Y3QgZGVjaXNpb25zIEQtMDQ4IGxlYXZlcyBleHBsaWNpdCwgcmVzb2x2ZWQgZnJvbSB0aGUgUC0wMTZcbiAqIGBlbnRpdGxlbWVudGAgZXZlbnRzIHRoYXQgYWxyZWFkeSBjYXJyeSB0aGVtLlxuICpcbiAqIEEgbGVkZ2VyIGBFbnRpdGxlbWVudGAgbmFtZXMgYSBjYXRhbG9nIHByb2R1Y3QgYW5kIGEgYnV5ZXI7IGRlbGl2ZXJ5IG5lZWRzIGFuXG4gKiBpbW11dGFibGUgcmVsZWFzZSByZWYgYW5kIGFuIGluc3RhbGwgc3ViamVjdC4gUmF0aGVyIHRoYW4gZ3Vlc3MgYSBjb252ZW50aW9uXG4gKiAoYHByb2R1Y3RJZCA9PT0gcmVsZWFzZVJlZmAgaXMgdGhlIHRlbXB0aW5nIG9uZSwgYW5kIGl0IHNpbGVudGx5IHNoaXBzIHRoZVxuICogd3JvbmcgYnl0ZXMgd2hlbiBhIGxpc3RpbmcgaGFzIG1vcmUgdGhhbiBvbmUgcmVsZWFzZSksIHRoaXMgYnVpbGRzIHRoZVxuICogbWFwcGluZyBmcm9tIHRoZSBzaWduZWQgUDJQIGVudGl0bGVtZW50IGZhY3RzIHRoYXQgc3RhdGUgYm90aCBzaWRlcyDigJQgdGhlXG4gKiBzZWxsZXIgU0FJRCB3aGljaCByZWxlYXNlIHRoaXMgb3JkZXIgZW50aXRsZXMsIHNvIG5vdGhpbmcgaGFzIHRvIGJlIGluZmVycmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnJpZGdlRnJvbUNvbW1lcmNlRW50aXRsZW1lbnRzKGFjY2VwdGVkOiByZWFkb25seSBDb21tZXJjZUV2ZW50W10pOiB7XG4gIHJlYWRvbmx5IHJlbGVhc2VSZWZGb3JQcm9kdWN0OiAocHJvZHVjdElkOiBzdHJpbmcsIGVudGl0bGVtZW50OiBFbnRpdGxlbWVudCkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgcmVhZG9ubHkgc3ViamVjdEZvckJ1eWVyOiAoYnV5ZXJJZDogc3RyaW5nLCBlbnRpdGxlbWVudDogRW50aXRsZW1lbnQpID0+IHN0cmluZyB8IG51bGw7XG59IHtcbiAgY29uc3QgcmVsZWFzZUJ5UHJvZHVjdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGNvbnN0IHN1YmplY3RCeUJ1eWVyID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IGV2ZW50IG9mIGFjY2VwdGVkKSB7XG4gICAgaWYgKGV2ZW50LmtpbmQgIT09ICdlbnRpdGxlbWVudCcpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHByb2R1Y3RJZCA9IHJlYWRTdHJpbmcoZXZlbnQucGF5bG9hZCwgJ3Byb2R1Y3RJZCcpO1xuICAgIGNvbnN0IHJlbGVhc2VSZWYgPSByZWFkU3RyaW5nKGV2ZW50LnBheWxvYWQsICdyZWxlYXNlUmVmJyk7XG4gICAgY29uc3QgYnV5ZXJJZCA9IHJlYWRTdHJpbmcoZXZlbnQucGF5bG9hZCwgJ2J1eWVySWQnKTtcbiAgICBjb25zdCBzdWJqZWN0ID0gcmVhZFN0cmluZyhldmVudC5wYXlsb2FkLCAnc3ViamVjdCcpO1xuICAgIC8vIExhc3Qgd3JpdGVyIHdpbnMgd2l0aGluIGEgZGV0ZXJtaW5pc3RpY2FsbHktb3JkZXJlZCBhY2NlcHRlZCBsaXN0LCBzbyBhXG4gICAgLy8gcmUtaXNzdWVkIGVudGl0bGVtZW50IG5hbWluZyBhIE5FV0VSIHJlbGVhc2UgbW92ZXMgdGhlIG1hcHBpbmcgZm9yd2FyZC5cbiAgICBpZiAocHJvZHVjdElkICYmIHJlbGVhc2VSZWYpIHJlbGVhc2VCeVByb2R1Y3Quc2V0KHByb2R1Y3RJZCwgcmVsZWFzZVJlZik7XG4gICAgaWYgKGJ1eWVySWQgJiYgc3ViamVjdCkgc3ViamVjdEJ5QnV5ZXIuc2V0KGJ1eWVySWQsIHN1YmplY3QpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICByZWxlYXNlUmVmRm9yUHJvZHVjdDogKHByb2R1Y3RJZCkgPT4gcmVsZWFzZUJ5UHJvZHVjdC5nZXQocHJvZHVjdElkKSA/PyBudWxsLFxuICAgIHN1YmplY3RGb3JCdXllcjogKGJ1eWVySWQpID0+IHN1YmplY3RCeUJ1eWVyLmdldChidXllcklkKSA/PyBudWxsLFxuICB9O1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9sZWRnZXItcDJwLWJyaWRnZS50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvbGVkZ2VyLXAycC1icmlkZ2UudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9sZWRnZXItcDJwLWJyaWRnZS50cyIsW11d