__vite_ssr_exportName__("PREPAID_CREDIT_PRODUCT_ID", () => { try { return PREPAID_CREDIT_PRODUCT_ID } catch {} });
__vite_ssr_exportName__("PREPAID_CREDIT_OFFER_ID", () => { try { return PREPAID_CREDIT_OFFER_ID } catch {} });
__vite_ssr_exportName__("PREPAID_CREDIT_SKU_REF", () => { try { return PREPAID_CREDIT_SKU_REF } catch {} });
__vite_ssr_exportName__("PREPAID_CREDIT_TOP_UP", () => { try { return PREPAID_CREDIT_TOP_UP } catch {} });
__vite_ssr_exportName__("CREDIT_MICROS_PER_USD_MINOR", () => { try { return CREDIT_MICROS_PER_USD_MINOR } catch {} });
__vite_ssr_exportName__("prepaidCreditCatalogEvents", () => { try { return prepaidCreditCatalogEvents } catch {} });
__vite_ssr_exportName__("PREPAID_CREDIT_EVENT_KINDS", () => { try { return PREPAID_CREDIT_EVENT_KINDS } catch {} });
__vite_ssr_exportName__("reducePrepaidCredits", () => { try { return reducePrepaidCredits } catch {} });
__vite_ssr_exportName__("serializePrepaidCreditState", () => { try { return serializePrepaidCreditState } catch {} });
__vite_ssr_exportName__("microchargeChannelForCreditReservation", () => { try { return microchargeChannelForCreditReservation } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/authority/authority-rpc-envelope.ts", {"importedNames":["canonicalJson"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/microcharge.ts", {"importedNames":["createMicrochargeChannel"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/commerce-ledger.ts", {"importedNames":["reduceLedger","validateLedgerEvent"]});




const PREPAID_CREDIT_PRODUCT_ID = "papercusp-prepaid-byoc-credits";
const PREPAID_CREDIT_OFFER_ID = "papercusp-prepaid-byoc-credits-usd-10";
const PREPAID_CREDIT_SKU_REF = "papercusp:byoc-credits:usd-10";
const PREPAID_CREDIT_TOP_UP = { amountMinor: 1e3, currency: "USD" };
const CREDIT_MICROS_PER_USD_MINOR = 1e4;
function prepaidCreditCatalogEvents(occurredAtMs = 0) {
  return [
    {
      ledgerEventId: "catalog:prepaid-credit:0-product",
      kind: "product.defined",
      occurredAtMs,
      source: { provider: "operator", providerEventId: null },
      payload: {
        productId: PREPAID_CREDIT_PRODUCT_ID,
        skuRef: PREPAID_CREDIT_SKU_REF,
        creatorId: "papercusp-dao",
        title: "Papercusp prepaid BYOC credits"
      }
    },
    {
      ledgerEventId: "catalog:prepaid-credit:1-offer",
      kind: "offer.defined",
      occurredAtMs,
      source: { provider: "operator", providerEventId: null },
      payload: {
        offerId: PREPAID_CREDIT_OFFER_ID,
        productId: PREPAID_CREDIT_PRODUCT_ID,
        pricingModel: "one-time",
        price: PREPAID_CREDIT_TOP_UP
      }
    }
  ];
};
const PREPAID_CREDIT_EVENT_KINDS = [
  "credit.reserved",
  "credit.settled",
  "credit.released"
];
function isSafeMicros(value, allowZero = false) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}
function stringField(payload, key) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}
function emptyState() {
  return {
    balances: /* @__PURE__ */ new Map(),
    reservations: /* @__PURE__ */ new Map(),
    applied: [],
    duplicates: [],
    rejected: []
  };
}
function balanceFor(state, principalId, occurredAtMs) {
  return state.balances.get(principalId) ?? {
    principalId,
    availableMicros: 0,
    reservedMicros: 0,
    spentMicros: 0,
    debtMicros: 0,
    grantedMicros: 0,
    reversedMicros: 0,
    updatedAtMs: occurredAtMs
  };
}
function setBalance(state, balance) {
  state.balances.set(balance.principalId, balance);
}
function moneyToCreditMicros(money) {
  if (money.currency !== "USD") return null;
  const amount = money.amountMinor * CREDIT_MICROS_PER_USD_MINOR;
  return Number.isSafeInteger(amount) ? amount : null;
}
function derivedOperations(commerceEvents) {
  const commerce = (0,__vite_ssr_import_3__.reduceLedger)(commerceEvents);
  const applied = new Set(commerce.applied);
  const paidAt = /* @__PURE__ */ new Map();
  const refundedAt = /* @__PURE__ */ new Map();
  for (const raw of commerceEvents) {
    const verdict = (0,__vite_ssr_import_3__.validateLedgerEvent)(raw);
    if (!verdict.ok || !applied.has(verdict.event.ledgerEventId)) continue;
    const event = verdict.event;
    if (event.source.provider !== "stripe" || !event.source.providerEventId) continue;
    if (event.kind === "order.paid") {
      const orderId = stringField(event.payload, "orderId");
      if (orderId && !paidAt.has(orderId)) paidAt.set(orderId, event.occurredAtMs);
    } else if (event.kind === "refund.succeeded") {
      const refundId = stringField(event.payload, "refundId");
      if (refundId && !refundedAt.has(refundId)) refundedAt.set(refundId, event.occurredAtMs);
    }
  };
  const operations = [];
  for (const [orderId, occurredAtMs] of paidAt) {
    const order = commerce.orders.get(orderId);
    if (!order || order.offerId !== PREPAID_CREDIT_OFFER_ID) continue;
    const amountMicros = moneyToCreditMicros(order.amount);
    if (amountMicros == null) continue;
    operations.push({
      id: `stripe-topup:${orderId}`,
      kind: "grant",
      occurredAtMs,
      principalId: order.buyerId,
      amountMicros
    });
  };
  for (const [refundId, occurredAtMs] of refundedAt) {
    const refund = commerce.refunds.get(refundId);
    const order = refund ? commerce.orders.get(refund.orderId) : null;
    if (!refund || !order || order.offerId !== PREPAID_CREDIT_OFFER_ID) continue;
    const amountMicros = moneyToCreditMicros(refund.amount);
    if (amountMicros == null) continue;
    operations.push({
      id: `stripe-reversal:${refundId}`,
      kind: "reverse",
      occurredAtMs,
      principalId: order.buyerId,
      amountMicros
    });
  };
  return operations;
}
function validateManualEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw;
  if (typeof event.creditEventId !== "string" || !event.creditEventId.trim()) return null;
  if (!PREPAID_CREDIT_EVENT_KINDS.includes(event.kind)) return null;
  if (!Number.isFinite(event.occurredAtMs) || event.occurredAtMs < 0) return null;
  if (typeof event.principalId !== "string" || !event.principalId.trim()) return null;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  return event;
}
function eventDigest(event) {
  return (0,__vite_ssr_import_0__.createHash)("sha256").update((0,__vite_ssr_import_1__.canonicalJson)(event)).digest("hex");
}
function applyDerived(state, operation) {
  const current = balanceFor(state, operation.principalId, operation.occurredAtMs);
  if (operation.kind === "grant") {
    const debtPaid = Math.min(current.debtMicros, operation.amountMicros);
    setBalance(state, {
      ...current,
      availableMicros: current.availableMicros + operation.amountMicros - debtPaid,
      debtMicros: current.debtMicros - debtPaid,
      grantedMicros: current.grantedMicros + operation.amountMicros,
      updatedAtMs: operation.occurredAtMs
    });
    return { ok: true };
  };
  const fromAvailable = Math.min(current.availableMicros, operation.amountMicros);
  setBalance(state, {
    ...current,
    availableMicros: current.availableMicros - fromAvailable,
    debtMicros: current.debtMicros + operation.amountMicros - fromAvailable,
    reversedMicros: current.reversedMicros + operation.amountMicros,
    updatedAtMs: operation.occurredAtMs
  });
  return { ok: true };
}
function applyManual(state, event) {
  const payload = event.payload;
  const reservationId = stringField(payload, "reservationId");
  if (!reservationId) {
    return { ok: false, code: "invalid-event", detail: `${event.kind} needs reservationId` };
  };
  if (event.kind === "credit.reserved") {
    const channelId = stringField(payload, "channelId");
    const amountMicros = payload.amountMicros;
    if (!channelId || !isSafeMicros(amountMicros)) {
      return {
        ok: false,
        code: "invalid-event",
        detail: "credit.reserved needs channelId and a positive safe-integer amountMicros"
      };
    };
    const existing = state.reservations.get(reservationId);
    if (existing) {
      return existing.principalId === event.principalId && existing.channelId === channelId && existing.reservedMicros === amountMicros ? { ok: true } : {
        ok: false,
        code: "reservation-conflict",
        detail: `reservation ${reservationId} already has different terms`
      };
    };
    const balance2 = balanceFor(state, event.principalId, event.occurredAtMs);
    if (balance2.debtMicros > 0 || balance2.availableMicros < amountMicros) {
      return {
        ok: false,
        code: "negative-balance",
        detail: `principal ${event.principalId} has ${balance2.availableMicros} available and ${balance2.debtMicros} debt; cannot reserve ${amountMicros}`
      };
    };
    setBalance(state, {
      ...balance2,
      availableMicros: balance2.availableMicros - amountMicros,
      reservedMicros: balance2.reservedMicros + amountMicros,
      updatedAtMs: event.occurredAtMs
    });
    state.reservations.set(reservationId, {
      reservationId,
      principalId: event.principalId,
      channelId,
      reservedMicros: amountMicros,
      committedMicros: 0,
      state: "open",
      createdAtMs: event.occurredAtMs,
      updatedAtMs: event.occurredAtMs
    });
    return { ok: true };
  };
  const reservation = state.reservations.get(reservationId);
  if (!reservation) {
    return {
      ok: false,
      code: "unknown-reservation",
      detail: `reservation ${reservationId} is not known`
    };
  };
  if (reservation.principalId !== event.principalId) {
    return {
      ok: false,
      code: "reservation-conflict",
      detail: `reservation ${reservationId} belongs to another principal`
    };
  };
  const balance = balanceFor(state, event.principalId, event.occurredAtMs);
  if (event.kind === "credit.released") {
    if (reservation.state === "released") return { ok: true };
    if (reservation.state !== "open") {
      return {
        ok: false,
        code: "invalid-transition",
        detail: `reservation ${reservationId} cannot move ${reservation.state} -> released`
      };
    };
    setBalance(state, {
      ...balance,
      availableMicros: balance.availableMicros + reservation.reservedMicros,
      reservedMicros: balance.reservedMicros - reservation.reservedMicros,
      updatedAtMs: event.occurredAtMs
    });
    state.reservations.set(reservationId, {
      ...reservation,
      state: "released",
      updatedAtMs: event.occurredAtMs
    });
    return { ok: true };
  };
  const committedMicros = payload.committedMicros;
  if (!isSafeMicros(committedMicros, true)) {
    return {
      ok: false,
      code: "invalid-event",
      detail: "credit.settled needs a non-negative safe-integer committedMicros"
    };
  };
  if (reservation.state === "settled") {
    return reservation.committedMicros === committedMicros ? { ok: true } : {
      ok: false,
      code: "invalid-transition",
      detail: `reservation ${reservationId} was already settled for ${reservation.committedMicros}`
    };
  };
  if (reservation.state !== "open") {
    return {
      ok: false,
      code: "invalid-transition",
      detail: `reservation ${reservationId} cannot move ${reservation.state} -> settled`
    };
  };
  if (committedMicros > reservation.reservedMicros) {
    return {
      ok: false,
      code: "amount-exceeds-reservation",
      detail: `committed ${committedMicros} exceeds reserved ${reservation.reservedMicros}`
    };
  };
  const releasedMicros = reservation.reservedMicros - committedMicros;
  setBalance(state, {
    ...balance,
    availableMicros: balance.availableMicros + releasedMicros,
    reservedMicros: balance.reservedMicros - reservation.reservedMicros,
    spentMicros: balance.spentMicros + committedMicros,
    updatedAtMs: event.occurredAtMs
  });
  state.reservations.set(reservationId, {
    ...reservation,
    committedMicros,
    state: "settled",
    updatedAtMs: event.occurredAtMs
  });
  return { ok: true };
}
function reducePrepaidCredits(commerceEvents, creditEvents = []) {
  const state = emptyState();
  const operations = derivedOperations(commerceEvents);
  const seenManual = /* @__PURE__ */ new Map();
  for (const raw of creditEvents) {
    const event = validateManualEvent(raw);
    if (!event) {
      const partial = raw && typeof raw === "object" ? raw : {};
      state.rejected.push({
        eventId: typeof partial.creditEventId === "string" ? partial.creditEventId : "",
        kind: typeof partial.kind === "string" ? partial.kind : "",
        code: "invalid-event",
        detail: "credit event needs id, supported kind, timestamp, principalId and payload"
      });
      continue;
    };
    const digest = eventDigest(event);
    const prior = seenManual.get(event.creditEventId);
    if (prior !== void 0) {
      if (prior === digest) state.duplicates.push(event.creditEventId);
      else {
        state.rejected.push({
          eventId: event.creditEventId,
          kind: event.kind,
          code: "duplicate-conflict",
          detail: "a different credit fact already carries this creditEventId"
        });
      };
      continue;
    };
    seenManual.set(event.creditEventId, digest);
    operations.push({
      id: event.creditEventId,
      kind: "manual",
      occurredAtMs: event.occurredAtMs,
      principalId: event.principalId,
      event
    });
  };
  operations.sort(
    (a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id)
  );
  for (const operation of operations) {
    const result = operation.kind === "manual" ? applyManual(state, operation.event) : applyDerived(state, operation);
    if (result.ok) state.applied.push(operation.id);
    else {
      state.rejected.push({
        eventId: operation.id,
        kind: operation.kind === "manual" ? operation.event.kind : operation.kind,
        code: result.code,
        detail: result.detail
      });
    }
  };
  return state;
};
function serializePrepaidCreditState(state) {
  return {
    balances: [...state.balances.values()].sort(
      (a, b) => a.principalId.localeCompare(b.principalId)
    ),
    reservations: [...state.reservations.values()].sort(
      (a, b) => a.reservationId.localeCompare(b.reservationId)
    )
  };
};
function microchargeChannelForCreditReservation(state, reservationId) {
  const reservation = state.reservations.get(reservationId);
  if (!reservation) {
    return {
      ok: false,
      code: "unknown-reservation",
      detail: `reservation ${reservationId} is not known`
    };
  };
  if (reservation.state !== "open") {
    return {
      ok: false,
      code: "reservation-not-open",
      detail: `reservation ${reservationId} is ${reservation.state}`
    };
  };
  return {
    ok: true,
    channel: (0,__vite_ssr_import_2__.createMicrochargeChannel)(
      reservation.channelId,
      BigInt(reservation.reservedMicros)
    )
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFLLENBQUMsR0FBRyxNQUN0RCxFQUFFLGNBQWMsY0FBYyxFQUFFLGFBQWE7QUFBQSxJQUMvQztBQUFBLEVBQ0Y7QUFDRjtBQUdPLFNBQVMsdUNBQ2QsT0FDQSxlQUNpSTtBQUNqSSxRQUFNLGNBQWMsTUFBTSxhQUFhLElBQUksYUFBYTtBQUN4RCxNQUFJLENBQUMsYUFBYTtBQUNoQixXQUFPO0FBQUEsTUFDTCxJQUFJO0FBQUEsTUFDSixNQUFNO0FBQUEsTUFDTixRQUFRLGVBQWUsYUFBYTtBQUFBLElBQ3RDO0FBQUEsRUFDRjtBQUNBLE1BQUksWUFBWSxVQUFVLFFBQVE7QUFDaEMsV0FBTztBQUFBLE1BQ0wsSUFBSTtBQUFBLE1BQ0osTUFBTTtBQUFBLE1BQ04sUUFBUSxlQUFlLGFBQWEsT0FBTyxZQUFZLEtBQUs7QUFBQSxJQUM5RDtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQUEsSUFDTCxJQUFJO0FBQUEsSUFDSixZQUFTO0FBQUEsTUFDUCxZQUFZO0FBQUEsTUFDWixPQUFPLFlBQVksY0FBYztBQUFBLElBQ25DO0FBQUEsRUFDRjtBQUNGIiwibmFtZXMiOlsiYmFsYW5jZSJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJwcmVwYWlkLWNyZWRpdHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdHJpcGUtZnVuZGVkIHByZXBhaWQgQllPQyBjcmVkaXRzIChzaGFyZWQtcG90IERBTyBwbGFuIFAtMDMwKS5cbiAqXG4gKiBUaGUgY29tbWVyY2UgbGVkZ2VyIHJlbWFpbnMgdGhlIG1vbmV5IGF1dGhvcml0eS4gVGhpcyByZWR1Y2VyIGRlcml2ZXMgZXhhY3RseVxuICogb25lIGNyZWRpdCBncmFudCBmcm9tIGVhY2ggdmVyaWZpZWQsIHBhaWQgdG9wLXVwIG9yZGVyIGFuZCBvbmUgcmV2ZXJzYWwgZnJvbVxuICogZWFjaCB2ZXJpZmllZCByZWZ1bmQvY2hhcmdlYmFjaywgdGhlbiBmb2xkcyBleHBsaWNpdCByZXNlcnZlL3NldHRsZS9yZWxlYXNlXG4gKiBldmVudHMgdXNlZCB0byBmdW5kIHRoZSBleGlzdGluZyBtaWNyb2NoYXJnZSByYWlsLlxuICpcbiAqIEEgcmV2ZXJzYWwgY2FuIGFycml2ZSBhZnRlciBjcmVkaXRzIHdlcmUgc3BlbnQuIFJhdGhlciB0aGFuIG1hbnVmYWN0dXJlIGFcbiAqIG5lZ2F0aXZlIHNwZW5kYWJsZSBiYWxhbmNlLCB0aGUgcmVkdWNlciByZWNvcmRzIHRoZSBzaG9ydGZhbGwgYXMgZGVidCBhbmRcbiAqIHJlZnVzZXMgbmV3IHJlc2VydmF0aW9ucyB1bnRpbCBsYXRlciBncmFudHMgcmVwYXkgaXQuXG4gKi9cbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBjYW5vbmljYWxKc29uIH0gZnJvbSAnLi4vYXV0aG9yaXR5L2F1dGhvcml0eS1ycGMtZW52ZWxvcGUnO1xuaW1wb3J0IHsgY3JlYXRlTWljcm9jaGFyZ2VDaGFubmVsLCB0eXBlIE1pY3JvY2hhcmdlQ2hhbm5lbCB9IGZyb20gJy4uL3AycC9taWNyb2NoYXJnZSc7XG5pbXBvcnQge1xuICByZWR1Y2VMZWRnZXIsXG4gIHZhbGlkYXRlTGVkZ2VyRXZlbnQsXG4gIHR5cGUgTGVkZ2VyRXZlbnQsXG4gIHR5cGUgTW9uZXksXG59IGZyb20gJy4vY29tbWVyY2UtbGVkZ2VyJztcblxuZXhwb3J0IGNvbnN0IFBSRVBBSURfQ1JFRElUX1BST0RVQ1RfSUQgPSAncGFwZXJjdXNwLXByZXBhaWQtYnlvYy1jcmVkaXRzJztcbmV4cG9ydCBjb25zdCBQUkVQQUlEX0NSRURJVF9PRkZFUl9JRCA9ICdwYXBlcmN1c3AtcHJlcGFpZC1ieW9jLWNyZWRpdHMtdXNkLTEwJztcbmV4cG9ydCBjb25zdCBQUkVQQUlEX0NSRURJVF9TS1VfUkVGID0gJ3BhcGVyY3VzcDpieW9jLWNyZWRpdHM6dXNkLTEwJztcbmV4cG9ydCBjb25zdCBQUkVQQUlEX0NSRURJVF9UT1BfVVA6IE1vbmV5ID0geyBhbW91bnRNaW5vcjogMV8wMDAsIGN1cnJlbmN5OiAnVVNEJyB9O1xuZXhwb3J0IGNvbnN0IENSRURJVF9NSUNST1NfUEVSX1VTRF9NSU5PUiA9IDEwXzAwMDtcblxuLyoqIElkZW1wb3RlbnQgY2F0YWxvZyBmYWN0cyB0aGUgQ2hlY2tvdXQgZG9vciBjYW4gYXBwZW5kIGJlZm9yZSByZWFkaW5nIG9mZmVycy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmVwYWlkQ3JlZGl0Q2F0YWxvZ0V2ZW50cyhvY2N1cnJlZEF0TXMgPSAwKTogTGVkZ2VyRXZlbnRbXSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgbGVkZ2VyRXZlbnRJZDogJ2NhdGFsb2c6cHJlcGFpZC1jcmVkaXQ6MC1wcm9kdWN0JyxcbiAgICAgIGtpbmQ6ICdwcm9kdWN0LmRlZmluZWQnLFxuICAgICAgb2NjdXJyZWRBdE1zLFxuICAgICAgc291cmNlOiB7IHByb3ZpZGVyOiAnb3BlcmF0b3InLCBwcm92aWRlckV2ZW50SWQ6IG51bGwgfSxcbiAgICAgIHBheWxvYWQ6IHtcbiAgICAgICAgcHJvZHVjdElkOiBQUkVQQUlEX0NSRURJVF9QUk9EVUNUX0lELFxuICAgICAgICBza3VSZWY6IFBSRVBBSURfQ1JFRElUX1NLVV9SRUYsXG4gICAgICAgIGNyZWF0b3JJZDogJ3BhcGVyY3VzcC1kYW8nLFxuICAgICAgICB0aXRsZTogJ1BhcGVyY3VzcCBwcmVwYWlkIEJZT0MgY3JlZGl0cycsXG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbGVkZ2VyRXZlbnRJZDogJ2NhdGFsb2c6cHJlcGFpZC1jcmVkaXQ6MS1vZmZlcicsXG4gICAgICBraW5kOiAnb2ZmZXIuZGVmaW5lZCcsXG4gICAgICBvY2N1cnJlZEF0TXMsXG4gICAgICBzb3VyY2U6IHsgcHJvdmlkZXI6ICdvcGVyYXRvcicsIHByb3ZpZGVyRXZlbnRJZDogbnVsbCB9LFxuICAgICAgcGF5bG9hZDoge1xuICAgICAgICBvZmZlcklkOiBQUkVQQUlEX0NSRURJVF9PRkZFUl9JRCxcbiAgICAgICAgcHJvZHVjdElkOiBQUkVQQUlEX0NSRURJVF9QUk9EVUNUX0lELFxuICAgICAgICBwcmljaW5nTW9kZWw6ICdvbmUtdGltZScsXG4gICAgICAgIHByaWNlOiBQUkVQQUlEX0NSRURJVF9UT1BfVVAsXG4gICAgICB9LFxuICAgIH0sXG4gIF07XG59XG5cbmV4cG9ydCBjb25zdCBQUkVQQUlEX0NSRURJVF9FVkVOVF9LSU5EUyA9IFtcbiAgJ2NyZWRpdC5yZXNlcnZlZCcsXG4gICdjcmVkaXQuc2V0dGxlZCcsXG4gICdjcmVkaXQucmVsZWFzZWQnLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFByZXBhaWRDcmVkaXRFdmVudEtpbmQgPSAodHlwZW9mIFBSRVBBSURfQ1JFRElUX0VWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgaW50ZXJmYWNlIFByZXBhaWRDcmVkaXRFdmVudCB7XG4gIHJlYWRvbmx5IGNyZWRpdEV2ZW50SWQ6IHN0cmluZztcbiAgcmVhZG9ubHkga2luZDogUHJlcGFpZENyZWRpdEV2ZW50S2luZDtcbiAgcmVhZG9ubHkgb2NjdXJyZWRBdE1zOiBudW1iZXI7XG4gIHJlYWRvbmx5IHByaW5jaXBhbElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHBheWxvYWQ6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcmVwYWlkQ3JlZGl0QmFsYW5jZSB7XG4gIHJlYWRvbmx5IHByaW5jaXBhbElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGF2YWlsYWJsZU1pY3JvczogbnVtYmVyO1xuICByZWFkb25seSByZXNlcnZlZE1pY3JvczogbnVtYmVyO1xuICByZWFkb25seSBzcGVudE1pY3JvczogbnVtYmVyO1xuICByZWFkb25seSBkZWJ0TWljcm9zOiBudW1iZXI7XG4gIHJlYWRvbmx5IGdyYW50ZWRNaWNyb3M6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmV2ZXJzZWRNaWNyb3M6IG51bWJlcjtcbiAgcmVhZG9ubHkgdXBkYXRlZEF0TXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IHR5cGUgQ3JlZGl0UmVzZXJ2YXRpb25TdGF0ZSA9ICdvcGVuJyB8ICdzZXR0bGVkJyB8ICdyZWxlYXNlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJlcGFpZENyZWRpdFJlc2VydmF0aW9uIHtcbiAgcmVhZG9ubHkgcmVzZXJ2YXRpb25JZDogc3RyaW5nO1xuICByZWFkb25seSBwcmluY2lwYWxJZDogc3RyaW5nO1xuICByZWFkb25seSBjaGFubmVsSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVzZXJ2ZWRNaWNyb3M6IG51bWJlcjtcbiAgcmVhZG9ubHkgY29tbWl0dGVkTWljcm9zOiBudW1iZXI7XG4gIHJlYWRvbmx5IHN0YXRlOiBDcmVkaXRSZXNlcnZhdGlvblN0YXRlO1xuICByZWFkb25seSBjcmVhdGVkQXRNczogbnVtYmVyO1xuICByZWFkb25seSB1cGRhdGVkQXRNczogbnVtYmVyO1xufVxuXG5leHBvcnQgdHlwZSBQcmVwYWlkQ3JlZGl0UmVqZWN0aW9uQ29kZSA9XG4gIHwgJ2ludmFsaWQtZXZlbnQnXG4gIHwgJ2R1cGxpY2F0ZS1jb25mbGljdCdcbiAgfCAndW5zdXBwb3J0ZWQtY3VycmVuY3knXG4gIHwgJ25lZ2F0aXZlLWJhbGFuY2UnXG4gIHwgJ3Vua25vd24tcmVzZXJ2YXRpb24nXG4gIHwgJ3Jlc2VydmF0aW9uLWNvbmZsaWN0J1xuICB8ICdpbnZhbGlkLXRyYW5zaXRpb24nXG4gIHwgJ2Ftb3VudC1leGNlZWRzLXJlc2VydmF0aW9uJztcblxuZXhwb3J0IGludGVyZmFjZSBQcmVwYWlkQ3JlZGl0UmVqZWN0aW9uIHtcbiAgcmVhZG9ubHkgZXZlbnRJZDogc3RyaW5nO1xuICByZWFkb25seSBraW5kOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGU6IFByZXBhaWRDcmVkaXRSZWplY3Rpb25Db2RlO1xuICByZWFkb25seSBkZXRhaWw6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcmVwYWlkQ3JlZGl0TGVkZ2VyU3RhdGUge1xuICByZWFkb25seSBiYWxhbmNlczogTWFwPHN0cmluZywgUHJlcGFpZENyZWRpdEJhbGFuY2U+O1xuICByZWFkb25seSByZXNlcnZhdGlvbnM6IE1hcDxzdHJpbmcsIFByZXBhaWRDcmVkaXRSZXNlcnZhdGlvbj47XG4gIHJlYWRvbmx5IGFwcGxpZWQ6IHN0cmluZ1tdO1xuICByZWFkb25seSBkdXBsaWNhdGVzOiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgcmVqZWN0ZWQ6IFByZXBhaWRDcmVkaXRSZWplY3Rpb25bXTtcbn1cblxudHlwZSBDcmVkaXRPcGVyYXRpb24gPVxuICB8IHtcbiAgICAgIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gICAgICByZWFkb25seSBraW5kOiAnZ3JhbnQnIHwgJ3JldmVyc2UnO1xuICAgICAgcmVhZG9ubHkgb2NjdXJyZWRBdE1zOiBudW1iZXI7XG4gICAgICByZWFkb25seSBwcmluY2lwYWxJZDogc3RyaW5nO1xuICAgICAgcmVhZG9ubHkgYW1vdW50TWljcm9zOiBudW1iZXI7XG4gICAgfVxuICB8IHtcbiAgICAgIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gICAgICByZWFkb25seSBraW5kOiAnbWFudWFsJztcbiAgICAgIHJlYWRvbmx5IG9jY3VycmVkQXRNczogbnVtYmVyO1xuICAgICAgcmVhZG9ubHkgcHJpbmNpcGFsSWQ6IHN0cmluZztcbiAgICAgIHJlYWRvbmx5IGV2ZW50OiBQcmVwYWlkQ3JlZGl0RXZlbnQ7XG4gICAgfTtcblxudHlwZSBBcHBseVJlc3VsdCA9XG4gIHwgeyBvazogdHJ1ZSB9XG4gIHwgeyBvazogZmFsc2U7IGNvZGU6IFByZXBhaWRDcmVkaXRSZWplY3Rpb25Db2RlOyBkZXRhaWw6IHN0cmluZyB9O1xuXG5mdW5jdGlvbiBpc1NhZmVNaWNyb3ModmFsdWU6IHVua25vd24sIGFsbG93WmVybyA9IGZhbHNlKTogdmFsdWUgaXMgbnVtYmVyIHtcbiAgcmV0dXJuIChcbiAgICBOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZSkgJiZcbiAgICAoYWxsb3daZXJvID8gKHZhbHVlIGFzIG51bWJlcikgPj0gMCA6ICh2YWx1ZSBhcyBudW1iZXIpID4gMClcbiAgKTtcbn1cblxuZnVuY3Rpb24gc3RyaW5nRmllbGQocGF5bG9hZDogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+LCBrZXk6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCB2YWx1ZSA9IHBheWxvYWRba2V5XTtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpID8gdmFsdWUgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBlbXB0eVN0YXRlKCk6IFByZXBhaWRDcmVkaXRMZWRnZXJTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgYmFsYW5jZXM6IG5ldyBNYXAoKSxcbiAgICByZXNlcnZhdGlvbnM6IG5ldyBNYXAoKSxcbiAgICBhcHBsaWVkOiBbXSxcbiAgICBkdXBsaWNhdGVzOiBbXSxcbiAgICByZWplY3RlZDogW10sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGJhbGFuY2VGb3IoXG4gIHN0YXRlOiBQcmVwYWlkQ3JlZGl0TGVkZ2VyU3RhdGUsXG4gIHByaW5jaXBhbElkOiBzdHJpbmcsXG4gIG9jY3VycmVkQXRNczogbnVtYmVyLFxuKTogUHJlcGFpZENyZWRpdEJhbGFuY2Uge1xuICByZXR1cm4gKFxuICAgIHN0YXRlLmJhbGFuY2VzLmdldChwcmluY2lwYWxJZCkgPz8ge1xuICAgICAgcHJpbmNpcGFsSWQsXG4gICAgICBhdmFpbGFibGVNaWNyb3M6IDAsXG4gICAgICByZXNlcnZlZE1pY3JvczogMCxcbiAgICAgIHNwZW50TWljcm9zOiAwLFxuICAgICAgZGVidE1pY3JvczogMCxcbiAgICAgIGdyYW50ZWRNaWNyb3M6IDAsXG4gICAgICByZXZlcnNlZE1pY3JvczogMCxcbiAgICAgIHVwZGF0ZWRBdE1zOiBvY2N1cnJlZEF0TXMsXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiBzZXRCYWxhbmNlKFxuICBzdGF0ZTogUHJlcGFpZENyZWRpdExlZGdlclN0YXRlLFxuICBiYWxhbmNlOiBQcmVwYWlkQ3JlZGl0QmFsYW5jZSxcbik6IHZvaWQge1xuICBzdGF0ZS5iYWxhbmNlcy5zZXQoYmFsYW5jZS5wcmluY2lwYWxJZCwgYmFsYW5jZSk7XG59XG5cbmZ1bmN0aW9uIG1vbmV5VG9DcmVkaXRNaWNyb3MobW9uZXk6IE1vbmV5KTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmIChtb25leS5jdXJyZW5jeSAhPT0gJ1VTRCcpIHJldHVybiBudWxsO1xuICBjb25zdCBhbW91bnQgPSBtb25leS5hbW91bnRNaW5vciAqIENSRURJVF9NSUNST1NfUEVSX1VTRF9NSU5PUjtcbiAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKGFtb3VudCkgPyBhbW91bnQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBkZXJpdmVkT3BlcmF0aW9ucyhjb21tZXJjZUV2ZW50czogcmVhZG9ubHkgdW5rbm93bltdKTogQ3JlZGl0T3BlcmF0aW9uW10ge1xuICBjb25zdCBjb21tZXJjZSA9IHJlZHVjZUxlZGdlcihjb21tZXJjZUV2ZW50cyk7XG4gIGNvbnN0IGFwcGxpZWQgPSBuZXcgU2V0KGNvbW1lcmNlLmFwcGxpZWQpO1xuICBjb25zdCBwYWlkQXQgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCByZWZ1bmRlZEF0ID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcblxuICBmb3IgKGNvbnN0IHJhdyBvZiBjb21tZXJjZUV2ZW50cykge1xuICAgIGNvbnN0IHZlcmRpY3QgPSB2YWxpZGF0ZUxlZGdlckV2ZW50KHJhdyk7XG4gICAgaWYgKCF2ZXJkaWN0Lm9rIHx8ICFhcHBsaWVkLmhhcyh2ZXJkaWN0LmV2ZW50LmxlZGdlckV2ZW50SWQpKSBjb250aW51ZTtcbiAgICBjb25zdCBldmVudCA9IHZlcmRpY3QuZXZlbnQ7XG4gICAgaWYgKGV2ZW50LnNvdXJjZS5wcm92aWRlciAhPT0gJ3N0cmlwZScgfHwgIWV2ZW50LnNvdXJjZS5wcm92aWRlckV2ZW50SWQpIGNvbnRpbnVlO1xuICAgIGlmIChldmVudC5raW5kID09PSAnb3JkZXIucGFpZCcpIHtcbiAgICAgIGNvbnN0IG9yZGVySWQgPSBzdHJpbmdGaWVsZChldmVudC5wYXlsb2FkLCAnb3JkZXJJZCcpO1xuICAgICAgaWYgKG9yZGVySWQgJiYgIXBhaWRBdC5oYXMob3JkZXJJZCkpIHBhaWRBdC5zZXQob3JkZXJJZCwgZXZlbnQub2NjdXJyZWRBdE1zKTtcbiAgICB9IGVsc2UgaWYgKGV2ZW50LmtpbmQgPT09ICdyZWZ1bmQuc3VjY2VlZGVkJykge1xuICAgICAgY29uc3QgcmVmdW5kSWQgPSBzdHJpbmdGaWVsZChldmVudC5wYXlsb2FkLCAncmVmdW5kSWQnKTtcbiAgICAgIGlmIChyZWZ1bmRJZCAmJiAhcmVmdW5kZWRBdC5oYXMocmVmdW5kSWQpKSByZWZ1bmRlZEF0LnNldChyZWZ1bmRJZCwgZXZlbnQub2NjdXJyZWRBdE1zKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBvcGVyYXRpb25zOiBDcmVkaXRPcGVyYXRpb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IFtvcmRlcklkLCBvY2N1cnJlZEF0TXNdIG9mIHBhaWRBdCkge1xuICAgIGNvbnN0IG9yZGVyID0gY29tbWVyY2Uub3JkZXJzLmdldChvcmRlcklkKTtcbiAgICBpZiAoIW9yZGVyIHx8IG9yZGVyLm9mZmVySWQgIT09IFBSRVBBSURfQ1JFRElUX09GRkVSX0lEKSBjb250aW51ZTtcbiAgICBjb25zdCBhbW91bnRNaWNyb3MgPSBtb25leVRvQ3JlZGl0TWljcm9zKG9yZGVyLmFtb3VudCk7XG4gICAgaWYgKGFtb3VudE1pY3JvcyA9PSBudWxsKSBjb250aW51ZTtcbiAgICBvcGVyYXRpb25zLnB1c2goe1xuICAgICAgaWQ6IGBzdHJpcGUtdG9wdXA6JHtvcmRlcklkfWAsXG4gICAgICBraW5kOiAnZ3JhbnQnLFxuICAgICAgb2NjdXJyZWRBdE1zLFxuICAgICAgcHJpbmNpcGFsSWQ6IG9yZGVyLmJ1eWVySWQsXG4gICAgICBhbW91bnRNaWNyb3MsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IFtyZWZ1bmRJZCwgb2NjdXJyZWRBdE1zXSBvZiByZWZ1bmRlZEF0KSB7XG4gICAgY29uc3QgcmVmdW5kID0gY29tbWVyY2UucmVmdW5kcy5nZXQocmVmdW5kSWQpO1xuICAgIGNvbnN0IG9yZGVyID0gcmVmdW5kID8gY29tbWVyY2Uub3JkZXJzLmdldChyZWZ1bmQub3JkZXJJZCkgOiBudWxsO1xuICAgIGlmICghcmVmdW5kIHx8ICFvcmRlciB8fCBvcmRlci5vZmZlcklkICE9PSBQUkVQQUlEX0NSRURJVF9PRkZFUl9JRCkgY29udGludWU7XG4gICAgY29uc3QgYW1vdW50TWljcm9zID0gbW9uZXlUb0NyZWRpdE1pY3JvcyhyZWZ1bmQuYW1vdW50KTtcbiAgICBpZiAoYW1vdW50TWljcm9zID09IG51bGwpIGNvbnRpbnVlO1xuICAgIG9wZXJhdGlvbnMucHVzaCh7XG4gICAgICBpZDogYHN0cmlwZS1yZXZlcnNhbDoke3JlZnVuZElkfWAsXG4gICAgICBraW5kOiAncmV2ZXJzZScsXG4gICAgICBvY2N1cnJlZEF0TXMsXG4gICAgICBwcmluY2lwYWxJZDogb3JkZXIuYnV5ZXJJZCxcbiAgICAgIGFtb3VudE1pY3JvcyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3BlcmF0aW9ucztcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVNYW51YWxFdmVudChyYXc6IHVua25vd24pOiBQcmVwYWlkQ3JlZGl0RXZlbnQgfCBudWxsIHtcbiAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyYXcpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZXZlbnQgPSByYXcgYXMgUGFydGlhbDxQcmVwYWlkQ3JlZGl0RXZlbnQ+O1xuICBpZiAodHlwZW9mIGV2ZW50LmNyZWRpdEV2ZW50SWQgIT09ICdzdHJpbmcnIHx8ICFldmVudC5jcmVkaXRFdmVudElkLnRyaW0oKSkgcmV0dXJuIG51bGw7XG4gIGlmICghUFJFUEFJRF9DUkVESVRfRVZFTlRfS0lORFMuaW5jbHVkZXMoZXZlbnQua2luZCBhcyBQcmVwYWlkQ3JlZGl0RXZlbnRLaW5kKSkgcmV0dXJuIG51bGw7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGV2ZW50Lm9jY3VycmVkQXRNcykgfHwgKGV2ZW50Lm9jY3VycmVkQXRNcyBhcyBudW1iZXIpIDwgMCkgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgZXZlbnQucHJpbmNpcGFsSWQgIT09ICdzdHJpbmcnIHx8ICFldmVudC5wcmluY2lwYWxJZC50cmltKCkpIHJldHVybiBudWxsO1xuICBpZiAoIWV2ZW50LnBheWxvYWQgfHwgdHlwZW9mIGV2ZW50LnBheWxvYWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoZXZlbnQucGF5bG9hZCkpIHJldHVybiBudWxsO1xuICByZXR1cm4gZXZlbnQgYXMgUHJlcGFpZENyZWRpdEV2ZW50O1xufVxuXG5mdW5jdGlvbiBldmVudERpZ2VzdChldmVudDogUHJlcGFpZENyZWRpdEV2ZW50KTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShjYW5vbmljYWxKc29uKGV2ZW50KSkuZGlnZXN0KCdoZXgnKTtcbn1cblxuZnVuY3Rpb24gYXBwbHlEZXJpdmVkKFxuICBzdGF0ZTogUHJlcGFpZENyZWRpdExlZGdlclN0YXRlLFxuICBvcGVyYXRpb246IEV4dHJhY3Q8Q3JlZGl0T3BlcmF0aW9uLCB7IGtpbmQ6ICdncmFudCcgfCAncmV2ZXJzZScgfT4sXG4pOiBBcHBseVJlc3VsdCB7XG4gIGNvbnN0IGN1cnJlbnQgPSBiYWxhbmNlRm9yKHN0YXRlLCBvcGVyYXRpb24ucHJpbmNpcGFsSWQsIG9wZXJhdGlvbi5vY2N1cnJlZEF0TXMpO1xuICBpZiAob3BlcmF0aW9uLmtpbmQgPT09ICdncmFudCcpIHtcbiAgICBjb25zdCBkZWJ0UGFpZCA9IE1hdGgubWluKGN1cnJlbnQuZGVidE1pY3Jvcywgb3BlcmF0aW9uLmFtb3VudE1pY3Jvcyk7XG4gICAgc2V0QmFsYW5jZShzdGF0ZSwge1xuICAgICAgLi4uY3VycmVudCxcbiAgICAgIGF2YWlsYWJsZU1pY3JvczogY3VycmVudC5hdmFpbGFibGVNaWNyb3MgKyBvcGVyYXRpb24uYW1vdW50TWljcm9zIC0gZGVidFBhaWQsXG4gICAgICBkZWJ0TWljcm9zOiBjdXJyZW50LmRlYnRNaWNyb3MgLSBkZWJ0UGFpZCxcbiAgICAgIGdyYW50ZWRNaWNyb3M6IGN1cnJlbnQuZ3JhbnRlZE1pY3JvcyArIG9wZXJhdGlvbi5hbW91bnRNaWNyb3MsXG4gICAgICB1cGRhdGVkQXRNczogb3BlcmF0aW9uLm9jY3VycmVkQXRNcyxcbiAgICB9KTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICB9XG5cbiAgY29uc3QgZnJvbUF2YWlsYWJsZSA9IE1hdGgubWluKGN1cnJlbnQuYXZhaWxhYmxlTWljcm9zLCBvcGVyYXRpb24uYW1vdW50TWljcm9zKTtcbiAgc2V0QmFsYW5jZShzdGF0ZSwge1xuICAgIC4uLmN1cnJlbnQsXG4gICAgYXZhaWxhYmxlTWljcm9zOiBjdXJyZW50LmF2YWlsYWJsZU1pY3JvcyAtIGZyb21BdmFpbGFibGUsXG4gICAgZGVidE1pY3JvczogY3VycmVudC5kZWJ0TWljcm9zICsgb3BlcmF0aW9uLmFtb3VudE1pY3JvcyAtIGZyb21BdmFpbGFibGUsXG4gICAgcmV2ZXJzZWRNaWNyb3M6IGN1cnJlbnQucmV2ZXJzZWRNaWNyb3MgKyBvcGVyYXRpb24uYW1vdW50TWljcm9zLFxuICAgIHVwZGF0ZWRBdE1zOiBvcGVyYXRpb24ub2NjdXJyZWRBdE1zLFxuICB9KTtcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gYXBwbHlNYW51YWwoXG4gIHN0YXRlOiBQcmVwYWlkQ3JlZGl0TGVkZ2VyU3RhdGUsXG4gIGV2ZW50OiBQcmVwYWlkQ3JlZGl0RXZlbnQsXG4pOiBBcHBseVJlc3VsdCB7XG4gIGNvbnN0IHBheWxvYWQgPSBldmVudC5wYXlsb2FkO1xuICBjb25zdCByZXNlcnZhdGlvbklkID0gc3RyaW5nRmllbGQocGF5bG9hZCwgJ3Jlc2VydmF0aW9uSWQnKTtcbiAgaWYgKCFyZXNlcnZhdGlvbklkKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1ldmVudCcsIGRldGFpbDogYCR7ZXZlbnQua2luZH0gbmVlZHMgcmVzZXJ2YXRpb25JZGAgfTtcbiAgfVxuXG4gIGlmIChldmVudC5raW5kID09PSAnY3JlZGl0LnJlc2VydmVkJykge1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IHN0cmluZ0ZpZWxkKHBheWxvYWQsICdjaGFubmVsSWQnKTtcbiAgICBjb25zdCBhbW91bnRNaWNyb3MgPSBwYXlsb2FkLmFtb3VudE1pY3JvcztcbiAgICBpZiAoIWNoYW5uZWxJZCB8fCAhaXNTYWZlTWljcm9zKGFtb3VudE1pY3JvcykpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgY29kZTogJ2ludmFsaWQtZXZlbnQnLFxuICAgICAgICBkZXRhaWw6ICdjcmVkaXQucmVzZXJ2ZWQgbmVlZHMgY2hhbm5lbElkIGFuZCBhIHBvc2l0aXZlIHNhZmUtaW50ZWdlciBhbW91bnRNaWNyb3MnLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgZXhpc3RpbmcgPSBzdGF0ZS5yZXNlcnZhdGlvbnMuZ2V0KHJlc2VydmF0aW9uSWQpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgcmV0dXJuIGV4aXN0aW5nLnByaW5jaXBhbElkID09PSBldmVudC5wcmluY2lwYWxJZCAmJlxuICAgICAgICBleGlzdGluZy5jaGFubmVsSWQgPT09IGNoYW5uZWxJZCAmJlxuICAgICAgICBleGlzdGluZy5yZXNlcnZlZE1pY3JvcyA9PT0gYW1vdW50TWljcm9zXG4gICAgICAgID8geyBvazogdHJ1ZSB9XG4gICAgICAgIDoge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgY29kZTogJ3Jlc2VydmF0aW9uLWNvbmZsaWN0JyxcbiAgICAgICAgICAgIGRldGFpbDogYHJlc2VydmF0aW9uICR7cmVzZXJ2YXRpb25JZH0gYWxyZWFkeSBoYXMgZGlmZmVyZW50IHRlcm1zYCxcbiAgICAgICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBiYWxhbmNlID0gYmFsYW5jZUZvcihzdGF0ZSwgZXZlbnQucHJpbmNpcGFsSWQsIGV2ZW50Lm9jY3VycmVkQXRNcyk7XG4gICAgaWYgKGJhbGFuY2UuZGVidE1pY3JvcyA+IDAgfHwgYmFsYW5jZS5hdmFpbGFibGVNaWNyb3MgPCBhbW91bnRNaWNyb3MpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgY29kZTogJ25lZ2F0aXZlLWJhbGFuY2UnLFxuICAgICAgICBkZXRhaWw6IGBwcmluY2lwYWwgJHtldmVudC5wcmluY2lwYWxJZH0gaGFzICR7YmFsYW5jZS5hdmFpbGFibGVNaWNyb3N9IGF2YWlsYWJsZSBhbmQgJHtiYWxhbmNlLmRlYnRNaWNyb3N9IGRlYnQ7IGNhbm5vdCByZXNlcnZlICR7YW1vdW50TWljcm9zfWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBzZXRCYWxhbmNlKHN0YXRlLCB7XG4gICAgICAuLi5iYWxhbmNlLFxuICAgICAgYXZhaWxhYmxlTWljcm9zOiBiYWxhbmNlLmF2YWlsYWJsZU1pY3JvcyAtIGFtb3VudE1pY3JvcyxcbiAgICAgIHJlc2VydmVkTWljcm9zOiBiYWxhbmNlLnJlc2VydmVkTWljcm9zICsgYW1vdW50TWljcm9zLFxuICAgICAgdXBkYXRlZEF0TXM6IGV2ZW50Lm9jY3VycmVkQXRNcyxcbiAgICB9KTtcbiAgICBzdGF0ZS5yZXNlcnZhdGlvbnMuc2V0KHJlc2VydmF0aW9uSWQsIHtcbiAgICAgIHJlc2VydmF0aW9uSWQsXG4gICAgICBwcmluY2lwYWxJZDogZXZlbnQucHJpbmNpcGFsSWQsXG4gICAgICBjaGFubmVsSWQsXG4gICAgICByZXNlcnZlZE1pY3JvczogYW1vdW50TWljcm9zLFxuICAgICAgY29tbWl0dGVkTWljcm9zOiAwLFxuICAgICAgc3RhdGU6ICdvcGVuJyxcbiAgICAgIGNyZWF0ZWRBdE1zOiBldmVudC5vY2N1cnJlZEF0TXMsXG4gICAgICB1cGRhdGVkQXRNczogZXZlbnQub2NjdXJyZWRBdE1zLFxuICAgIH0pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gIH1cblxuICBjb25zdCByZXNlcnZhdGlvbiA9IHN0YXRlLnJlc2VydmF0aW9ucy5nZXQocmVzZXJ2YXRpb25JZCk7XG4gIGlmICghcmVzZXJ2YXRpb24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgY29kZTogJ3Vua25vd24tcmVzZXJ2YXRpb24nLFxuICAgICAgZGV0YWlsOiBgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfSBpcyBub3Qga25vd25gLFxuICAgIH07XG4gIH1cbiAgaWYgKHJlc2VydmF0aW9uLnByaW5jaXBhbElkICE9PSBldmVudC5wcmluY2lwYWxJZCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBjb2RlOiAncmVzZXJ2YXRpb24tY29uZmxpY3QnLFxuICAgICAgZGV0YWlsOiBgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfSBiZWxvbmdzIHRvIGFub3RoZXIgcHJpbmNpcGFsYCxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGJhbGFuY2UgPSBiYWxhbmNlRm9yKHN0YXRlLCBldmVudC5wcmluY2lwYWxJZCwgZXZlbnQub2NjdXJyZWRBdE1zKTtcblxuICBpZiAoZXZlbnQua2luZCA9PT0gJ2NyZWRpdC5yZWxlYXNlZCcpIHtcbiAgICBpZiAocmVzZXJ2YXRpb24uc3RhdGUgPT09ICdyZWxlYXNlZCcpIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgaWYgKHJlc2VydmF0aW9uLnN0YXRlICE9PSAnb3BlbicpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgY29kZTogJ2ludmFsaWQtdHJhbnNpdGlvbicsXG4gICAgICAgIGRldGFpbDogYHJlc2VydmF0aW9uICR7cmVzZXJ2YXRpb25JZH0gY2Fubm90IG1vdmUgJHtyZXNlcnZhdGlvbi5zdGF0ZX0gLT4gcmVsZWFzZWRgLFxuICAgICAgfTtcbiAgICB9XG4gICAgc2V0QmFsYW5jZShzdGF0ZSwge1xuICAgICAgLi4uYmFsYW5jZSxcbiAgICAgIGF2YWlsYWJsZU1pY3JvczogYmFsYW5jZS5hdmFpbGFibGVNaWNyb3MgKyByZXNlcnZhdGlvbi5yZXNlcnZlZE1pY3JvcyxcbiAgICAgIHJlc2VydmVkTWljcm9zOiBiYWxhbmNlLnJlc2VydmVkTWljcm9zIC0gcmVzZXJ2YXRpb24ucmVzZXJ2ZWRNaWNyb3MsXG4gICAgICB1cGRhdGVkQXRNczogZXZlbnQub2NjdXJyZWRBdE1zLFxuICAgIH0pO1xuICAgIHN0YXRlLnJlc2VydmF0aW9ucy5zZXQocmVzZXJ2YXRpb25JZCwge1xuICAgICAgLi4ucmVzZXJ2YXRpb24sXG4gICAgICBzdGF0ZTogJ3JlbGVhc2VkJyxcbiAgICAgIHVwZGF0ZWRBdE1zOiBldmVudC5vY2N1cnJlZEF0TXMsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgfVxuXG4gIGNvbnN0IGNvbW1pdHRlZE1pY3JvcyA9IHBheWxvYWQuY29tbWl0dGVkTWljcm9zO1xuICBpZiAoIWlzU2FmZU1pY3Jvcyhjb21taXR0ZWRNaWNyb3MsIHRydWUpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGNvZGU6ICdpbnZhbGlkLWV2ZW50JyxcbiAgICAgIGRldGFpbDogJ2NyZWRpdC5zZXR0bGVkIG5lZWRzIGEgbm9uLW5lZ2F0aXZlIHNhZmUtaW50ZWdlciBjb21taXR0ZWRNaWNyb3MnLFxuICAgIH07XG4gIH1cbiAgaWYgKHJlc2VydmF0aW9uLnN0YXRlID09PSAnc2V0dGxlZCcpIHtcbiAgICByZXR1cm4gcmVzZXJ2YXRpb24uY29tbWl0dGVkTWljcm9zID09PSBjb21taXR0ZWRNaWNyb3NcbiAgICAgID8geyBvazogdHJ1ZSB9XG4gICAgICA6IHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgY29kZTogJ2ludmFsaWQtdHJhbnNpdGlvbicsXG4gICAgICAgICAgZGV0YWlsOiBgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfSB3YXMgYWxyZWFkeSBzZXR0bGVkIGZvciAke3Jlc2VydmF0aW9uLmNvbW1pdHRlZE1pY3Jvc31gLFxuICAgICAgICB9O1xuICB9XG4gIGlmIChyZXNlcnZhdGlvbi5zdGF0ZSAhPT0gJ29wZW4nKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGNvZGU6ICdpbnZhbGlkLXRyYW5zaXRpb24nLFxuICAgICAgZGV0YWlsOiBgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfSBjYW5ub3QgbW92ZSAke3Jlc2VydmF0aW9uLnN0YXRlfSAtPiBzZXR0bGVkYCxcbiAgICB9O1xuICB9XG4gIGlmIChjb21taXR0ZWRNaWNyb3MgPiByZXNlcnZhdGlvbi5yZXNlcnZlZE1pY3Jvcykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBjb2RlOiAnYW1vdW50LWV4Y2VlZHMtcmVzZXJ2YXRpb24nLFxuICAgICAgZGV0YWlsOiBgY29tbWl0dGVkICR7Y29tbWl0dGVkTWljcm9zfSBleGNlZWRzIHJlc2VydmVkICR7cmVzZXJ2YXRpb24ucmVzZXJ2ZWRNaWNyb3N9YCxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHJlbGVhc2VkTWljcm9zID0gcmVzZXJ2YXRpb24ucmVzZXJ2ZWRNaWNyb3MgLSBjb21taXR0ZWRNaWNyb3M7XG4gIHNldEJhbGFuY2Uoc3RhdGUsIHtcbiAgICAuLi5iYWxhbmNlLFxuICAgIGF2YWlsYWJsZU1pY3JvczogYmFsYW5jZS5hdmFpbGFibGVNaWNyb3MgKyByZWxlYXNlZE1pY3JvcyxcbiAgICByZXNlcnZlZE1pY3JvczogYmFsYW5jZS5yZXNlcnZlZE1pY3JvcyAtIHJlc2VydmF0aW9uLnJlc2VydmVkTWljcm9zLFxuICAgIHNwZW50TWljcm9zOiBiYWxhbmNlLnNwZW50TWljcm9zICsgY29tbWl0dGVkTWljcm9zLFxuICAgIHVwZGF0ZWRBdE1zOiBldmVudC5vY2N1cnJlZEF0TXMsXG4gIH0pO1xuICBzdGF0ZS5yZXNlcnZhdGlvbnMuc2V0KHJlc2VydmF0aW9uSWQsIHtcbiAgICAuLi5yZXNlcnZhdGlvbixcbiAgICBjb21taXR0ZWRNaWNyb3MsXG4gICAgc3RhdGU6ICdzZXR0bGVkJyxcbiAgICB1cGRhdGVkQXRNczogZXZlbnQub2NjdXJyZWRBdE1zLFxuICB9KTtcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuLyoqXG4gKiBGb2xkIHZlcmlmaWVkIGNvbW1lcmNlIGZhY3RzIHBsdXMgZXhwbGljaXQgbWljcm9jaGFyZ2UgcmVzZXJ2YXRpb24gZXZlbnRzLlxuICpcbiAqIE9yZGVyaW5nIGlzIGRldGVybWluaXN0aWMgYW5kIGluZGVwZW5kZW50IG9mIGlucHV0IG9yZGVyLiBTZW1hbnRpYyBncmFudCBpZHNcbiAqIGFyZSBvcmRlci1iYXNlZCBhbmQgcmV2ZXJzYWwgaWRzIGFyZSByZWZ1bmQvZGlzcHV0ZS1iYXNlZCwgc28gYSBwcm92aWRlciByZXRyeVxuICogdW5kZXIgYSBzZWNvbmQgd2ViaG9vayBldmVudCBpZCBzdGlsbCBjYW5ub3QgbWludCBvciByZXZlcnNlIHR3aWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkdWNlUHJlcGFpZENyZWRpdHMoXG4gIGNvbW1lcmNlRXZlbnRzOiByZWFkb25seSB1bmtub3duW10sXG4gIGNyZWRpdEV2ZW50czogcmVhZG9ubHkgdW5rbm93bltdID0gW10sXG4pOiBQcmVwYWlkQ3JlZGl0TGVkZ2VyU3RhdGUge1xuICBjb25zdCBzdGF0ZSA9IGVtcHR5U3RhdGUoKTtcbiAgY29uc3Qgb3BlcmF0aW9ucyA9IGRlcml2ZWRPcGVyYXRpb25zKGNvbW1lcmNlRXZlbnRzKTtcbiAgY29uc3Qgc2Vlbk1hbnVhbCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCByYXcgb2YgY3JlZGl0RXZlbnRzKSB7XG4gICAgY29uc3QgZXZlbnQgPSB2YWxpZGF0ZU1hbnVhbEV2ZW50KHJhdyk7XG4gICAgaWYgKCFldmVudCkge1xuICAgICAgY29uc3QgcGFydGlhbCA9IHJhdyAmJiB0eXBlb2YgcmF3ID09PSAnb2JqZWN0JyA/IChyYXcgYXMgUGFydGlhbDxQcmVwYWlkQ3JlZGl0RXZlbnQ+KSA6IHt9O1xuICAgICAgc3RhdGUucmVqZWN0ZWQucHVzaCh7XG4gICAgICAgIGV2ZW50SWQ6IHR5cGVvZiBwYXJ0aWFsLmNyZWRpdEV2ZW50SWQgPT09ICdzdHJpbmcnID8gcGFydGlhbC5jcmVkaXRFdmVudElkIDogJycsXG4gICAgICAgIGtpbmQ6IHR5cGVvZiBwYXJ0aWFsLmtpbmQgPT09ICdzdHJpbmcnID8gcGFydGlhbC5raW5kIDogJycsXG4gICAgICAgIGNvZGU6ICdpbnZhbGlkLWV2ZW50JyxcbiAgICAgICAgZGV0YWlsOiAnY3JlZGl0IGV2ZW50IG5lZWRzIGlkLCBzdXBwb3J0ZWQga2luZCwgdGltZXN0YW1wLCBwcmluY2lwYWxJZCBhbmQgcGF5bG9hZCcsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBkaWdlc3QgPSBldmVudERpZ2VzdChldmVudCk7XG4gICAgY29uc3QgcHJpb3IgPSBzZWVuTWFudWFsLmdldChldmVudC5jcmVkaXRFdmVudElkKTtcbiAgICBpZiAocHJpb3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHByaW9yID09PSBkaWdlc3QpIHN0YXRlLmR1cGxpY2F0ZXMucHVzaChldmVudC5jcmVkaXRFdmVudElkKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBzdGF0ZS5yZWplY3RlZC5wdXNoKHtcbiAgICAgICAgICBldmVudElkOiBldmVudC5jcmVkaXRFdmVudElkLFxuICAgICAgICAgIGtpbmQ6IGV2ZW50LmtpbmQsXG4gICAgICAgICAgY29kZTogJ2R1cGxpY2F0ZS1jb25mbGljdCcsXG4gICAgICAgICAgZGV0YWlsOiAnYSBkaWZmZXJlbnQgY3JlZGl0IGZhY3QgYWxyZWFkeSBjYXJyaWVzIHRoaXMgY3JlZGl0RXZlbnRJZCcsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW5NYW51YWwuc2V0KGV2ZW50LmNyZWRpdEV2ZW50SWQsIGRpZ2VzdCk7XG4gICAgb3BlcmF0aW9ucy5wdXNoKHtcbiAgICAgIGlkOiBldmVudC5jcmVkaXRFdmVudElkLFxuICAgICAga2luZDogJ21hbnVhbCcsXG4gICAgICBvY2N1cnJlZEF0TXM6IGV2ZW50Lm9jY3VycmVkQXRNcyxcbiAgICAgIHByaW5jaXBhbElkOiBldmVudC5wcmluY2lwYWxJZCxcbiAgICAgIGV2ZW50LFxuICAgIH0pO1xuICB9XG5cbiAgb3BlcmF0aW9ucy5zb3J0KFxuICAgIChhLCBiKSA9PlxuICAgICAgYS5vY2N1cnJlZEF0TXMgLSBiLm9jY3VycmVkQXRNcyB8fFxuICAgICAgYS5pZC5sb2NhbGVDb21wYXJlKGIuaWQpLFxuICApO1xuICBmb3IgKGNvbnN0IG9wZXJhdGlvbiBvZiBvcGVyYXRpb25zKSB7XG4gICAgY29uc3QgcmVzdWx0ID1cbiAgICAgIG9wZXJhdGlvbi5raW5kID09PSAnbWFudWFsJ1xuICAgICAgICA/IGFwcGx5TWFudWFsKHN0YXRlLCBvcGVyYXRpb24uZXZlbnQpXG4gICAgICAgIDogYXBwbHlEZXJpdmVkKHN0YXRlLCBvcGVyYXRpb24pO1xuICAgIGlmIChyZXN1bHQub2spIHN0YXRlLmFwcGxpZWQucHVzaChvcGVyYXRpb24uaWQpO1xuICAgIGVsc2Uge1xuICAgICAgc3RhdGUucmVqZWN0ZWQucHVzaCh7XG4gICAgICAgIGV2ZW50SWQ6IG9wZXJhdGlvbi5pZCxcbiAgICAgICAga2luZDogb3BlcmF0aW9uLmtpbmQgPT09ICdtYW51YWwnID8gb3BlcmF0aW9uLmV2ZW50LmtpbmQgOiBvcGVyYXRpb24ua2luZCxcbiAgICAgICAgY29kZTogcmVzdWx0LmNvZGUsXG4gICAgICAgIGRldGFpbDogcmVzdWx0LmRldGFpbCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RhdGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpemVQcmVwYWlkQ3JlZGl0U3RhdGUoc3RhdGU6IFByZXBhaWRDcmVkaXRMZWRnZXJTdGF0ZSk6IHtcbiAgYmFsYW5jZXM6IFByZXBhaWRDcmVkaXRCYWxhbmNlW107XG4gIHJlc2VydmF0aW9uczogUHJlcGFpZENyZWRpdFJlc2VydmF0aW9uW107XG59IHtcbiAgcmV0dXJuIHtcbiAgICBiYWxhbmNlczogWy4uLnN0YXRlLmJhbGFuY2VzLnZhbHVlcygpXS5zb3J0KChhLCBiKSA9PlxuICAgICAgYS5wcmluY2lwYWxJZC5sb2NhbGVDb21wYXJlKGIucHJpbmNpcGFsSWQpLFxuICAgICksXG4gICAgcmVzZXJ2YXRpb25zOiBbLi4uc3RhdGUucmVzZXJ2YXRpb25zLnZhbHVlcygpXS5zb3J0KChhLCBiKSA9PlxuICAgICAgYS5yZXNlcnZhdGlvbklkLmxvY2FsZUNvbXBhcmUoYi5yZXNlcnZhdGlvbklkKSxcbiAgICApLFxuICB9O1xufVxuXG4vKiogVHVybiBhbiBPUEVOIGNyZWRpdCByZXNlcnZhdGlvbiBpbnRvIHRoZSBlc2Nyb3cgb2JqZWN0IHRoZSBQLTAyMCByYWlsIHVzZXMuICovXG5leHBvcnQgZnVuY3Rpb24gbWljcm9jaGFyZ2VDaGFubmVsRm9yQ3JlZGl0UmVzZXJ2YXRpb24oXG4gIHN0YXRlOiBQcmVwYWlkQ3JlZGl0TGVkZ2VyU3RhdGUsXG4gIHJlc2VydmF0aW9uSWQ6IHN0cmluZyxcbik6IHsgb2s6IHRydWU7IGNoYW5uZWw6IE1pY3JvY2hhcmdlQ2hhbm5lbCB9IHwgeyBvazogZmFsc2U7IGNvZGU6ICd1bmtub3duLXJlc2VydmF0aW9uJyB8ICdyZXNlcnZhdGlvbi1ub3Qtb3Blbic7IGRldGFpbDogc3RyaW5nIH0ge1xuICBjb25zdCByZXNlcnZhdGlvbiA9IHN0YXRlLnJlc2VydmF0aW9ucy5nZXQocmVzZXJ2YXRpb25JZCk7XG4gIGlmICghcmVzZXJ2YXRpb24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgY29kZTogJ3Vua25vd24tcmVzZXJ2YXRpb24nLFxuICAgICAgZGV0YWlsOiBgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfSBpcyBub3Qga25vd25gLFxuICAgIH07XG4gIH1cbiAgaWYgKHJlc2VydmF0aW9uLnN0YXRlICE9PSAnb3BlbicpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgY29kZTogJ3Jlc2VydmF0aW9uLW5vdC1vcGVuJyxcbiAgICAgIGRldGFpbDogYHJlc2VydmF0aW9uICR7cmVzZXJ2YXRpb25JZH0gaXMgJHtyZXNlcnZhdGlvbi5zdGF0ZX1gLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBjaGFubmVsOiBjcmVhdGVNaWNyb2NoYXJnZUNoYW5uZWwoXG4gICAgICByZXNlcnZhdGlvbi5jaGFubmVsSWQsXG4gICAgICBCaWdJbnQocmVzZXJ2YXRpb24ucmVzZXJ2ZWRNaWNyb3MpLFxuICAgICksXG4gIH07XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL3ByZXBhaWQtY3JlZGl0cy50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvcHJlcGFpZC1jcmVkaXRzLnRzIiwiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvcHJlcGFpZC1jcmVkaXRzLnRzIixbXV0=