__vite_ssr_exportName__("identityUsageStatement", () => { try { return identityUsageStatement } catch {} });
__vite_ssr_exportName__("sumMoney", () => { try { return sumMoney } catch {} });
__vite_ssr_exportName__("commerceCatalogDashboard", () => { try { return commerceCatalogDashboard } catch {} });
__vite_ssr_exportName__("checkoutDashboard", () => { try { return checkoutDashboard } catch {} });
__vite_ssr_exportName__("refundDashboard", () => { try { return refundDashboard } catch {} });
__vite_ssr_exportName__("supportDashboard", () => { try { return supportDashboard } catch {} });
__vite_ssr_exportName__("auditExport", () => { try { return auditExport } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/commerce-accounts.ts", {"importedNames":["authorizeSeatIntent","membershipOf","payoutReadiness","principalEntitles","resolveBuyerPrincipal","seatUsage","seatsForOffer"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/authority/authority-rpc-envelope.ts", {"importedNames":["canonicalJson"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/revenue-settlement.ts", {"importedNames":["quoteRevenueAllocations"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/identity-per-use-offer.ts", {"importedNames":["quoteIdentityInferenceTurn","verifyIdentityPerUseOffer"]});




function identityUsageStatement(receipts, principalId) {
  const byKey = /* @__PURE__ */ new Map();
  const conflicts = /* @__PURE__ */ new Set();
  const issues = [];
  for (const receipt of receipts) {
    if (receipt.payer !== principalId && receipt.seller !== principalId || !receipt.releaseRef.startsWith("identity-release:")) continue;
    const key = (0,__vite_ssr_import_1__.canonicalJson)([receipt.channelId, receipt.usageNonce]);
    const prior = byKey.get(key);
    if (prior && (0,__vite_ssr_import_1__.canonicalJson)(prior) !== (0,__vite_ssr_import_1__.canonicalJson)(receipt)) conflicts.add(key);
    else byKey.set(key, receipt);
  };
  const micros = (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
  const lines = [];
  let markupMicros = 0n;
  let reservedReceipts = 0;
  for (const [key, receipt] of [...byKey].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const issue = (reason) => issues.push({ channelId: receipt.channelId, usageNonce: receipt.usageNonce, reason });
    if (conflicts.has(key)) {
      issue("conflicting-receipt");
      continue;
    };
    if (receipt.state === "reserved") {
      reservedReceipts += 1;
      continue;
    };
    const inference = receipt.identityInference;
    const billed = micros(inference?.billedInferenceMicros), ceiling = micros(inference?.ceilingMicros);
    const prior = micros(inference?.priorRemainderNumerator), remainder = micros(inference?.remainderNumerator);
    const amount = micros(receipt.amountMicros), quantity = micros(receipt.meterQuantity);
    const price = micros(receipt.unitPriceMicros), reserved = micros(receipt.reservedMicros);
    if (receipt.state !== "settled" || !receipt.channelId.trim() || !receipt.usageNonce.trim() || !receipt.offerId.trim() || !receipt.payer.trim() || !receipt.seller.trim() || !receipt.voucherSignature?.trim() || !receipt.receiptSignature?.trim() || !Number.isSafeInteger(receipt.reservedAtMs) || receipt.reservedAtMs < 0 || !Number.isSafeInteger(receipt.settledAtMs) || receipt.settledAtMs < receipt.reservedAtMs || billed === null || ceiling === null || prior === null || remainder === null || amount === null || quantity === null || price === null || reserved === null || price > BigInt(Number.MAX_SAFE_INTEGER)) {
      issue("incomplete-identity-receipt");
      continue;
    };
    const offer = {
      skuRef: receipt.releaseRef,
      meterUnit: receipt.meterUnit,
      unitPriceMicros: Number(price),
      priceVersion: receipt.priceVersion,
      splitManifestHash: receipt.splitManifestHash
    };
    const verified = (0,__vite_ssr_import_3__.verifyIdentityPerUseOffer)(offer);
    const quote = (0,__vite_ssr_import_3__.quoteIdentityInferenceTurn)({
      offer,
      billedInferenceMicros: billed,
      inferenceCeilingMicros: ceiling,
      priorRemainderNumerator: prior
    });
    if (!verified.ok || !quote.ok || quote.amountMicros !== amount || quote.remainderNumerator !== remainder || quote.reservationQuantity !== quantity || quote.reservedMarkupMicros !== reserved) {
      issue("identity-quote-mismatch");
      continue;
    };
    const allocation = (0,__vite_ssr_import_2__.quoteRevenueAllocations)({ distributableMicros: amount, splitManifest: verified.manifest });
    if (!allocation.ok) {
      issue(allocation.code);
      continue;
    };
    lines.push({
      channelId: receipt.channelId,
      usageNonce: receipt.usageNonce,
      offerId: receipt.offerId,
      releaseRef: receipt.releaseRef,
      payer: receipt.payer,
      seller: receipt.seller,
      priceVersion: receipt.priceVersion,
      splitManifestHash: receipt.splitManifestHash,
      billedInferenceMicros: billed.toString(),
      markupMicros: amount.toString(),
      allocationQuote: {
        creatorMicros: allocation.allocationsMicros.creator.toString(),
        daoMicros: allocation.allocationsMicros.dao.toString(),
        componentMicros: allocation.allocationsMicros.component.toString(),
        componentAuthorsMicros: allocation.componentAllocationsMicros === void 0 ? null : Object.fromEntries(Object.entries(allocation.componentAllocationsMicros).map(([author, value]) => [author, value.toString()]))
      }
    });
    markupMicros += amount;
  };
  return {
    basis: "hosted-settled-usage",
    currency: "USD",
    chainFinality: "not-measured",
    allocationBasis: "per-receipt-quote",
    lines,
    markupMicros: markupMicros.toString(),
    reservedReceipts,
    complete: issues.length === 0,
    issues,
    costPerAcceptedOutcomeMicros: null,
    outcomeEvidence: "unavailable"
  };
};
function sumMoney(amounts, currency) {
  let totalMinor = 0;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      return {
        ok: false,
        code: "currency-mismatch",
        detail: `cannot aggregate ${amount.currency} into a ${currency} total`
      };
    };
    totalMinor += amount.amountMinor;
  };
  return { ok: true, total: { amountMinor: totalMinor, currency } };
};
function commerceCatalogDashboard(ledger) {
  return sortedById(ledger.offers.values(), (offer) => offer.offerId).map((offer) => {
    const product = ledger.products.get(offer.productId);
    return {
      offerId: offer.offerId,
      productId: offer.productId,
      productTitle: product?.title ?? null,
      skuRef: product?.skuRef ?? null,
      creatorId: product?.creatorId ?? null,
      pricingModel: offer.pricingModel,
      price: offer.price,
      perUse: offer.perUse ?? null,
      active: offer.active,
      productActive: product?.active ?? null
    };
  });
};
const SETTLED_ORDER_STATES = /* @__PURE__ */ new Set([
  "paid",
  "partially-refunded",
  "refunded"
]);
function checkoutDashboard(input) {
  const { buyerId, ledger, orgs, seatPolicies, installations, currency } = input;
  const principal = (0,__vite_ssr_import_0__.resolveBuyerPrincipal)(buyerId, orgs);
  const entitlementByOrder = /* @__PURE__ */ new Map();
  for (const ent of ledger.entitlements.values()) {
    if (ent.buyerId === buyerId) entitlementByOrder.set(ent.orderId, ent);
  };
  const lines = [];
  for (const order of sortedById(ledger.orders.values(), (o) => o.orderId)) {
    if (order.buyerId !== buyerId) continue;
    const product = ledger.products.get(order.productId);
    const offer = ledger.offers.get(order.offerId);
    const ent = entitlementByOrder.get(order.orderId) ?? null;
    lines.push({
      orderId: order.orderId,
      orderState: order.state,
      productId: order.productId,
      productTitle: product?.title ?? null,
      offerId: order.offerId,
      pricingModel: offer?.pricingModel ?? null,
      perUse: offer?.perUse ?? null,
      amount: order.amount,
      refundedMinor: order.refundedMinor,
      entitlementId: ent?.entitlementId ?? null,
      entitlementState: ent?.state ?? null,
      seats: ent ? (0,__vite_ssr_import_0__.seatUsage)(ent.entitlementId, (0,__vite_ssr_import_0__.seatsForOffer)(order.offerId, seatPolicies), installations) : null,
      createdAtMs: order.createdAtMs
    });
  };
  const settled = lines.filter((l) => SETTLED_ORDER_STATES.has(l.orderState));
  const gross = sumMoney(
    settled.map((l) => l.amount),
    currency
  );
  if (!gross.ok) {
    return {
      buyerId,
      principal,
      lines,
      currency,
      grossMinor: 0,
      refundedMinor: 0,
      netMinor: 0,
      currencyMismatch: gross.detail
    };
  };
  const refundedMinor = settled.reduce((sum, l) => sum + l.refundedMinor, 0);
  return {
    buyerId,
    principal,
    lines,
    currency,
    grossMinor: gross.total.amountMinor,
    refundedMinor,
    netMinor: gross.total.amountMinor - refundedMinor,
    currencyMismatch: null
  };
};
const REFUND_INTENT_PROBES = ["install", "update", "repair"];
function survivingIntents(entitlement, installation) {
  return REFUND_INTENT_PROBES.filter(
    (intent) => (0,__vite_ssr_import_0__.authorizeSeatIntent)(installation, entitlement, intent).ok
  );
}
function refundDashboard(input) {
  const { ledger, installations, buyerId } = input;
  const refundsByOrder = /* @__PURE__ */ new Map();
  for (const refund of sortedById(ledger.refunds.values(), (r) => r.refundId)) {
    const bucket = refundsByOrder.get(refund.orderId);
    if (bucket) bucket.push(refund);
    else refundsByOrder.set(refund.orderId, [refund]);
  };
  const entitlementByOrder = /* @__PURE__ */ new Map();
  for (const ent of ledger.entitlements.values()) entitlementByOrder.set(ent.orderId, ent);
  const positions = [];
  for (const order of sortedById(ledger.orders.values(), (o) => o.orderId)) {
    if (buyerId !== void 0 && order.buyerId !== buyerId) continue;
    const refunds = refundsByOrder.get(order.orderId) ?? [];
    const pendingMinor = refunds.filter((r) => r.state === "pending").reduce((sum, r) => sum + r.amount.amountMinor, 0);
    const ent = entitlementByOrder.get(order.orderId) ?? null;
    const held = ent ? installations.filter((i) => i.entitlementId === ent.entitlementId && i.state === "active") : [];
    const surviving = ent && held.length > 0 ? survivingIntents({ ...ent, state: "revoked" }, held[0]) : [];
    positions.push({
      orderId: order.orderId,
      orderState: order.state,
      orderAmountMinor: order.amount.amountMinor,
      currency: order.amount.currency,
      settledMinor: order.refundedMinor,
      pendingMinor,
      refundableMinor: Math.max(0, order.amount.amountMinor - order.refundedMinor - pendingMinor),
      refunds,
      entitlementId: ent?.entitlementId ?? null,
      entitlementState: ent?.state ?? null,
      activeInstallations: held.length,
      intentsSurvivingRevocation: surviving
    });
  };
  return positions;
};
function supportDashboard(input) {
  const { userId, buyerId, intent, ledger, orgs, seatPolicies, installations } = input;
  const principal = (0,__vite_ssr_import_0__.resolveBuyerPrincipal)(buyerId, orgs);
  const orgRole = principal.kind === "organization" ? (0,__vite_ssr_import_0__.membershipOf)(principal.org, userId)?.role ?? null : null;
  const entitled = (0,__vite_ssr_import_0__.principalEntitles)(principal, userId);
  const findings = [];
  for (const ent of sortedById(ledger.entitlements.values(), (e) => e.entitlementId)) {
    if (ent.buyerId !== buyerId) continue;
    const order = ledger.orders.get(ent.orderId);
    const granted = order ? (0,__vite_ssr_import_0__.seatsForOffer)(order.offerId, seatPolicies) : 1;
    const seats = (0,__vite_ssr_import_0__.seatUsage)(ent.entitlementId, granted, installations);
    const mine = installations.find((i) => i.entitlementId === ent.entitlementId && i.holderId === userId) ?? null;
    let blocked = null;
    if (!entitled) {
      blocked = {
        code: "not-entitled",
        detail: principal.kind === "organization" ? `'${userId}' is not a member of org '${principal.org.orgId}'` : `'${userId}' is not the individual buyer '${buyerId}'`
      };
    } else if (mine) {
      const verdict = (0,__vite_ssr_import_0__.authorizeSeatIntent)(mine, ent, intent);
      if (!verdict.ok) blocked = { code: verdict.code, detail: verdict.detail };
    } else if (seats.available < 1) {
      blocked = {
        code: "no-seats-available",
        detail: `entitlement ${ent.entitlementId} has ${seats.used}/${seats.granted} seats in use`
      };
    };
    findings.push({
      entitlementId: ent.entitlementId,
      orderId: ent.orderId,
      productId: ent.productId,
      entitlementState: ent.state,
      seats,
      installationId: mine?.installationId ?? null,
      installationState: mine?.state ?? null,
      blocked
    });
  };
  if (findings.length === 0) {
    return {
      userId,
      buyerId,
      intent,
      principal,
      orgRole,
      entitled,
      findings: [],
      anyPermitted: false
    };
  };
  return {
    userId,
    buyerId,
    intent,
    principal,
    orgRole,
    entitled,
    findings,
    anyPermitted: findings.some((f) => f.blocked === null)
  };
};
function auditExport(input) {
  const { ledger, installations, orgs, creatorProfiles } = input;
  const payouts = sortedById(ledger.payouts.values(), (p) => p.payoutId).map((p) => {
    const readiness = (0,__vite_ssr_import_0__.payoutReadiness)(p.creatorId, creatorProfiles);
    return {
      payoutId: p.payoutId,
      creatorId: p.creatorId,
      amountMinor: p.amount.amountMinor,
      currency: p.amount.currency,
      state: p.state,
      payoutReady: readiness.ok,
      payoutBlockCode: readiness.ok ? null : readiness.code
    };
  });
  const rejectionCodes = [...new Set(ledger.rejected.map((r) => r.code))].sort();
  return {
    schema: "cupboard.audit.v1",
    products: sortedById(ledger.products.values(), (p) => p.productId),
    offers: sortedById(ledger.offers.values(), (o) => o.offerId),
    orders: sortedById(ledger.orders.values(), (o) => o.orderId),
    entitlements: sortedById(ledger.entitlements.values(), (e) => e.entitlementId),
    refunds: sortedById(ledger.refunds.values(), (r) => r.refundId),
    payouts,
    installations: [...installations].sort(
      (a, b) => a.installationId < b.installationId ? -1 : a.installationId > b.installationId ? 1 : 0
    ),
    organizations: [...orgs.values()].map((o) => ({ orgId: o.orgId, memberCount: o.memberships.length })).sort((a, b) => a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0),
    integrity: {
      appliedCount: ledger.applied.length,
      duplicateCount: ledger.duplicates.length,
      rejectedCount: ledger.rejected.length,
      rejections: [...ledger.rejected],
      rejectionCodes
    }
  };
};
function sortedById(values, key) {
  return [...values].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFFLFFBQVEsRUFBRSxRQUFRLEtBQUssRUFBRSxRQUFRLEVBQUUsUUFBUSxJQUFJLENBQUU7QUFBQSxJQUN0RSxXQUFXO0FBQUEsTUFDVCxjQUFjLE9BQU8sUUFBUTtBQUFBLE1BQzdCLGdCQUFnQixPQUFPLFdBQVc7QUFBQSxNQUNsQyxlQUFlLE9BQU8sU0FBUztBQUFBLE1BQy9CLFlBQVksQ0FBQyxHQUFHLE9BQU8sUUFBUTtBQUFBLE1BQy9CO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRjtBQUlBLFNBQVMsV0FBYyxRQUFxQixLQUFnQztBQUMxRSxTQUFPLENBQUMsR0FBRyxNQUFNLEVBQUUsS0FBSyxDQUFDLEdBQUcsTUFBTTtBQUNoQyxVQUFNLEtBQUssSUFBSSxDQUFDO0FBQ2hCLFVBQU0sS0FBSyxJQUFJLENBQUM7QUFDaEIsV0FBTyxLQUFLLEtBQUssS0FBSyxLQUFLLEtBQUssSUFBSTtBQUFBLEVBQ3RDLENBQUM7QUFDSCIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiY29tbWVyY2UtZGFzaGJvYXJkcy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENoZWNrb3V0LCByZWZ1bmQsIHN1cHBvcnQgYW5kIGF1ZGl0L2V4cG9ydCBkYXNoYm9hcmRzIChQLTAxMSkuXG4gKlxuICogRXZlcnkgZnVuY3Rpb24gaGVyZSBpcyBhIFBVUkUgUFJPSkVDVElPTiBvdmVyIHN0YXRlIHR3byBvdGhlciBtb2R1bGVzIG93bjpcbiAqIFAtMDEwJ3MgYExlZGdlclN0YXRlYCAoYC4vY29tbWVyY2UtbGVkZ2VyYCkgYW5kIFAtMDExJ3MgaWRlbnRpdHkvY29uc3VtcHRpb25cbiAqIGxheWVyIChgLi9jb21tZXJjZS1hY2NvdW50c2ApLiBOb3RoaW5nIGluIHRoaXMgZmlsZSBtdXRhdGVzIGVpdGhlciwgcGVyZm9ybXNcbiAqIEkvTywgb3IgcmVhZHMgYSBjbG9jayDigJQgYSBkYXNoYm9hcmQgdGhhdCBjb3VsZCBjaGFuZ2Ugd2hhdCBpdCByZXBvcnRzIGlzIG5vdFxuICogYSBkYXNoYm9hcmQuIFRoYXQgaXMgd2hhdCBtYWtlcyBhbiBhdWRpdCBleHBvcnQgcmVwcm9kdWNpYmxlOiB0aGUgc2FtZSBpbnB1dHNcbiAqIG11c3QgcmVuZGVyIHRoZSBzYW1lIGJ5dGVzLCBmb3JldmVyLlxuICpcbiAqIFRocmVlIHJhaWxzIGFyZSBkZWxpYmVyYXRlIGFuZCBhcmUgZ3VhcmRlZCBieSB0ZXN0cywgYmVjYXVzZSBlYWNoIG9uZSBpcyBhXG4gKiBwbGFjZSB3aGVyZSB0aGUgb2J2aW91cyBpbXBsZW1lbnRhdGlvbiBpcyBxdWlldGx5IHdyb25nOlxuICpcbiAqICAxLiBNT05FWSBORVZFUiBTSUxFTlRMWSBBR0dSRUdBVEVTIEFDUk9TUyBDVVJSRU5DSUVTLiBgc3VtTW9uZXlgIHJlZnVzZXMgYVxuICogICAgIG1peGVkIHNldCByYXRoZXIgdGhhbiBhZGRpbmcgbWlub3IgdW5pdHMgb2YgZGlmZmVyZW50IGRlbm9taW5hdGlvbnMuIEFcbiAqICAgICBkYXNoYm9hcmQgc3VtbWluZyAxMDAgSlBZIGludG8gMTAwIFVTRCBwcm9kdWNlcyBhIG51bWJlciB0aGF0IGxvb2tzIGxpa2VcbiAqICAgICBtb25leSBhbmQgaXMgbm90LCBhbmQgbm8gZG93bnN0cmVhbSByZWFkZXIgY2FuIGRldGVjdCBpdC5cbiAqXG4gKiAgMi4gUkVGVU5EQUJJTElUWSBTVUJUUkFDVFMgUkVGVU5EUyBUSEFUIEFSRSBTVElMTCBQRU5ESU5HLiBQLTAxMCdzXG4gKiAgICAgYE9yZGVyLnJlZnVuZGVkTWlub3JgIG9ubHkgYWR2YW5jZXMgb24gYHJlZnVuZC5zdWNjZWVkZWRgLCB3aGljaCBpc1xuICogICAgIGNvcnJlY3QgZm9yIHRoZSBsZWRnZXIg4oCUIG1vbmV5IGhhcyBub3QgbW92ZWQgeWV0IOKAlCBhbmQgY2F0YXN0cm9waGljIGZvciBhXG4gKiAgICAgZGFzaGJvYXJkOiB0d28gb3BlcmF0b3JzIHJlYWRpbmcgXCJyZWZ1bmRhYmxlXCIgd2hpbGUgb25lIHJlZnVuZCBpcyBpblxuICogICAgIGZsaWdodCB3b3VsZCBlYWNoIGlzc3VlIHRoZSByZW1haW5kZXIsIGFuZCB0aGUgcmVkdWNlcidzXG4gKiAgICAgYHJlZnVuZC1leGNlZWRzLW9yZGVyYCByZWplY3Rpb24gaXMgdGhlIG9ubHkgdGhpbmcgc3RhbmRpbmcgYmV0d2VlbiB0aGF0XG4gKiAgICAgYW5kIGEgZG91YmxlIHBheW91dC4gYHJlZnVuZFBvc2l0aW9uYCByZXBvcnRzIHRoZSBDT05TRVJWQVRJVkUgZmlndXJlLlxuICpcbiAqICAzLiBUSEUgQVVESVQgRVhQT1JUIENBTk5PVCBPTUlUIFJFSkVDVElPTlMgT1IgRFVQTElDQVRFUy4gQW4gZXhwb3J0IHRoYXRcbiAqICAgICBzaG93cyBvbmx5IHRoZSBldmVudHMgdGhhdCBhcHBsaWVkIGRlc2NyaWJlcyBhIGxlZGdlciB0aGF0IG5ldmVyIGhhZCBhXG4gKiAgICAgcHJvYmxlbSwgd2hpY2ggaXMgcHJlY2lzZWx5IHRoZSBsZWRnZXIgYW4gYXVkaXRvciBpcyBsb29raW5nIGZvci4gVGhlXG4gKiAgICAgcmVqZWN0ZWQgYW5kIGR1cGxpY2F0ZSBzZXRzIHRyYXZlbCBXSVRIIHRoZSBhY2NlcHRlZCBvbmUuXG4gKlxuICogVGhlIHN1cHBvcnQgZGFzaGJvYXJkIGRlbGVnYXRlcyBpdHMgXCJtYXkgdGhpcyBwcm9jZWVkP1wiIHZlcmRpY3QgdG9cbiAqIGBhdXRob3JpemVTZWF0SW50ZW50YCByYXRoZXIgdGhhbiByZS1kZXJpdmluZyB0aGUgcnVsZS4gUmUtZGVyaXZpbmcgaXQgd291bGRcbiAqIGZvcmsgRC0wNDIncyB5YW5rIHNlbWFudGljcyBhIHNlY29uZCB0aW1lIOKAlCB0aGUgZXhhY3QgZHJpZnQgYGNvbW1lcmNlLWFjY291bnRzYFxuICogd2FzIHdyaXR0ZW4gdG8gcHJldmVudC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7XG4gIEVudGl0bGVtZW50LFxuICBMZWRnZXJSZWplY3Rpb24sXG4gIExlZGdlclN0YXRlLFxuICBNb25leSxcbiAgT2ZmZXIsXG4gIE9yZGVyLFxuICBPcmRlclN0YXRlLFxuICBQZXJVc2VPZmZlclRlcm1zLFxuICBQYXlvdXQsXG4gIFByb2R1Y3QsXG4gIFJlZnVuZCxcbn0gZnJvbSAnLi9jb21tZXJjZS1sZWRnZXInO1xuaW1wb3J0IHtcbiAgYXV0aG9yaXplU2VhdEludGVudCxcbiAgbWVtYmVyc2hpcE9mLFxuICBwYXlvdXRSZWFkaW5lc3MsXG4gIHByaW5jaXBhbEVudGl0bGVzLFxuICByZXNvbHZlQnV5ZXJQcmluY2lwYWwsXG4gIHNlYXRVc2FnZSxcbiAgc2VhdHNGb3JPZmZlcixcbiAgdHlwZSBCdXllclByaW5jaXBhbCxcbiAgdHlwZSBDcmVhdG9yUHJvZmlsZSxcbiAgdHlwZSBJbnN0YWxsYXRpb24sXG4gIHR5cGUgT3JnYW5pemF0aW9uLFxuICB0eXBlIE9yZ1JvbGUsXG4gIHR5cGUgUGF5b3V0UmVhZGluZXNzLFxuICB0eXBlIFNlYXRQb2xpY3ksXG4gIHR5cGUgU2VhdFVzYWdlLFxufSBmcm9tICcuL2NvbW1lcmNlLWFjY291bnRzJztcbmltcG9ydCB7IHR5cGUgRGVsaXZlcnlJbnRlbnQgfSBmcm9tICcuLi9wMnAvYXJ0aWZhY3QtZGlzdHJpYnV0aW9uJztcbmltcG9ydCB7IGNhbm9uaWNhbEpzb24gfSBmcm9tICcuLi9hdXRob3JpdHkvYXV0aG9yaXR5LXJwYy1lbnZlbG9wZSc7XG5pbXBvcnQgeyBxdW90ZVJldmVudWVBbGxvY2F0aW9ucyB9IGZyb20gJy4uL3AycC9yZXZlbnVlLXNldHRsZW1lbnQnO1xuaW1wb3J0IHsgcXVvdGVJZGVudGl0eUluZmVyZW5jZVR1cm4sIHZlcmlmeUlkZW50aXR5UGVyVXNlT2ZmZXIgfSBmcm9tICcuL2lkZW50aXR5LXBlci11c2Utb2ZmZXInO1xuaW1wb3J0IHR5cGUgeyBVc2FnZVJlY2VpcHRXaXJlIH0gZnJvbSAnLi9tZXRlcmVkLWludm9jYXRpb24tZG9vci1pbyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSWRlbnRpdHlVc2FnZVN0YXRlbWVudExpbmUge1xuICByZWFkb25seSBjaGFubmVsSWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgdXNhZ2VOb25jZTogc3RyaW5nO1xuICByZWFkb25seSBvZmZlcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlbGVhc2VSZWY6IHN0cmluZztcbiAgcmVhZG9ubHkgcGF5ZXI6IHN0cmluZztcbiAgcmVhZG9ubHkgc2VsbGVyOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaWNlVmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzcGxpdE1hbmlmZXN0SGFzaDogc3RyaW5nO1xuICAvKiogQllPQyBiYXNlLCBkaXNwbGF5ZWQgcGVyIGlkZW50aXR5OyBuZXZlciBhZGRlZCB0byBDdXBib2FyZCBjaGFyZ2VzLiAqL1xuICByZWFkb25seSBiaWxsZWRJbmZlcmVuY2VNaWNyb3M6IHN0cmluZztcbiAgcmVhZG9ubHkgbWFya3VwTWljcm9zOiBzdHJpbmc7XG4gIC8qKiBQZXItcmVjZWlwdCBhcml0aG1ldGljIHF1b3RlOyBiYXRjaCByb3VuZGluZyBhbmQgcGF5b3V0IGFyZSBzZXBhcmF0ZS4gKi9cbiAgcmVhZG9ubHkgYWxsb2NhdGlvblF1b3RlOiB7XG4gICAgcmVhZG9ubHkgY3JlYXRvck1pY3Jvczogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGRhb01pY3Jvczogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGNvbXBvbmVudE1pY3Jvczogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGNvbXBvbmVudEF1dGhvcnNNaWNyb3M6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHwgbnVsbDtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJZGVudGl0eVVzYWdlU3RhdGVtZW50IHtcbiAgcmVhZG9ubHkgYmFzaXM6ICdob3N0ZWQtc2V0dGxlZC11c2FnZSc7XG4gIHJlYWRvbmx5IGN1cnJlbmN5OiAnVVNEJztcbiAgcmVhZG9ubHkgY2hhaW5GaW5hbGl0eTogJ25vdC1tZWFzdXJlZCc7XG4gIHJlYWRvbmx5IGFsbG9jYXRpb25CYXNpczogJ3Blci1yZWNlaXB0LXF1b3RlJztcbiAgcmVhZG9ubHkgbGluZXM6IHJlYWRvbmx5IElkZW50aXR5VXNhZ2VTdGF0ZW1lbnRMaW5lW107XG4gIHJlYWRvbmx5IG1hcmt1cE1pY3Jvczogc3RyaW5nO1xuICByZWFkb25seSByZXNlcnZlZFJlY2VpcHRzOiBudW1iZXI7XG4gIHJlYWRvbmx5IGNvbXBsZXRlOiBib29sZWFuO1xuICByZWFkb25seSBpc3N1ZXM6IHJlYWRvbmx5IHsgcmVhZG9ubHkgY2hhbm5lbElkOiBzdHJpbmc7IHJlYWRvbmx5IHVzYWdlTm9uY2U6IHN0cmluZzsgcmVhZG9ubHkgcmVhc29uOiBzdHJpbmcgfVtdO1xuICByZWFkb25seSBjb3N0UGVyQWNjZXB0ZWRPdXRjb21lTWljcm9zOiBudWxsO1xuICByZWFkb25seSBvdXRjb21lRXZpZGVuY2U6ICd1bmF2YWlsYWJsZSc7XG59XG5cbi8qKlxuICogUHJvamVjdCBvbmx5IHRoZSBjYWxsZXIncyBkdXJhYmxlIHJlY2VpcHQgc25hcHNob3QuIFNldHRsZWQgdXNhZ2UgaXMgYVxuICogbW9uZXRhcnkgY2xhaW0sIG5vdCBjaGFpbiBmaW5hbGl0eTsgaW5mZXJlbmNlIGlzIGEgQllPQyBiYXNlLCBub3QgYSBzZWNvbmRcbiAqIGNoYXJnZS4gUmUtcXVvdGUgcmVjb3JkZWQgdGVybXMsIG5ldmVyIHRvZGF5J3MgbXV0YWJsZSBvZmZlciBjYXRhbG9nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaWRlbnRpdHlVc2FnZVN0YXRlbWVudChyZWNlaXB0czogcmVhZG9ubHkgVXNhZ2VSZWNlaXB0V2lyZVtdLCBwcmluY2lwYWxJZDogc3RyaW5nKTogSWRlbnRpdHlVc2FnZVN0YXRlbWVudCB7XG4gIGNvbnN0IGJ5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIFVzYWdlUmVjZWlwdFdpcmU+KCk7XG4gIGNvbnN0IGNvbmZsaWN0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBpc3N1ZXM6IHsgY2hhbm5lbElkOiBzdHJpbmc7IHVzYWdlTm9uY2U6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdID0gW107XG4gIGZvciAoY29uc3QgcmVjZWlwdCBvZiByZWNlaXB0cykge1xuICAgIGlmICgocmVjZWlwdC5wYXllciAhPT0gcHJpbmNpcGFsSWQgJiYgcmVjZWlwdC5zZWxsZXIgIT09IHByaW5jaXBhbElkKSB8fFxuICAgICAgICAhcmVjZWlwdC5yZWxlYXNlUmVmLnN0YXJ0c1dpdGgoJ2lkZW50aXR5LXJlbGVhc2U6JykpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGtleSA9IGNhbm9uaWNhbEpzb24oW3JlY2VpcHQuY2hhbm5lbElkLCByZWNlaXB0LnVzYWdlTm9uY2VdKTtcbiAgICBjb25zdCBwcmlvciA9IGJ5S2V5LmdldChrZXkpO1xuICAgIGlmIChwcmlvciAmJiBjYW5vbmljYWxKc29uKHByaW9yKSAhPT0gY2Fub25pY2FsSnNvbihyZWNlaXB0KSkgY29uZmxpY3RzLmFkZChrZXkpO1xuICAgIGVsc2UgYnlLZXkuc2V0KGtleSwgcmVjZWlwdCk7XG4gIH1cbiAgY29uc3QgbWljcm9zID0gKHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogYmlnaW50IHwgbnVsbCA9PlxuICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgL14oMHxbMS05XVswLTldKikkLy50ZXN0KHZhbHVlKSA/IEJpZ0ludCh2YWx1ZSkgOiBudWxsO1xuICBjb25zdCBsaW5lczogSWRlbnRpdHlVc2FnZVN0YXRlbWVudExpbmVbXSA9IFtdO1xuICBsZXQgbWFya3VwTWljcm9zID0gMG47XG4gIGxldCByZXNlcnZlZFJlY2VpcHRzID0gMDtcbiAgZm9yIChjb25zdCBba2V5LCByZWNlaXB0XSBvZiBbLi4uYnlLZXldLnNvcnQoKFthXSwgW2JdKSA9PiBhIDwgYiA/IC0xIDogYSA+IGIgPyAxIDogMCkpIHtcbiAgICBjb25zdCBpc3N1ZSA9IChyZWFzb246IHN0cmluZykgPT4gaXNzdWVzLnB1c2goeyBjaGFubmVsSWQ6IHJlY2VpcHQuY2hhbm5lbElkLCB1c2FnZU5vbmNlOiByZWNlaXB0LnVzYWdlTm9uY2UsIHJlYXNvbiB9KTtcbiAgICBpZiAoY29uZmxpY3RzLmhhcyhrZXkpKSB7IGlzc3VlKCdjb25mbGljdGluZy1yZWNlaXB0Jyk7IGNvbnRpbnVlOyB9XG4gICAgaWYgKHJlY2VpcHQuc3RhdGUgPT09ICdyZXNlcnZlZCcpIHsgcmVzZXJ2ZWRSZWNlaXB0cyArPSAxOyBjb250aW51ZTsgfVxuICAgIGNvbnN0IGluZmVyZW5jZSA9IHJlY2VpcHQuaWRlbnRpdHlJbmZlcmVuY2U7XG4gICAgY29uc3QgYmlsbGVkID0gbWljcm9zKGluZmVyZW5jZT8uYmlsbGVkSW5mZXJlbmNlTWljcm9zKSwgY2VpbGluZyA9IG1pY3JvcyhpbmZlcmVuY2U/LmNlaWxpbmdNaWNyb3MpO1xuICAgIGNvbnN0IHByaW9yID0gbWljcm9zKGluZmVyZW5jZT8ucHJpb3JSZW1haW5kZXJOdW1lcmF0b3IpLCByZW1haW5kZXIgPSBtaWNyb3MoaW5mZXJlbmNlPy5yZW1haW5kZXJOdW1lcmF0b3IpO1xuICAgIGNvbnN0IGFtb3VudCA9IG1pY3JvcyhyZWNlaXB0LmFtb3VudE1pY3JvcyksIHF1YW50aXR5ID0gbWljcm9zKHJlY2VpcHQubWV0ZXJRdWFudGl0eSk7XG4gICAgY29uc3QgcHJpY2UgPSBtaWNyb3MocmVjZWlwdC51bml0UHJpY2VNaWNyb3MpLCByZXNlcnZlZCA9IG1pY3JvcyhyZWNlaXB0LnJlc2VydmVkTWljcm9zKTtcbiAgICBpZiAocmVjZWlwdC5zdGF0ZSAhPT0gJ3NldHRsZWQnIHx8ICFyZWNlaXB0LmNoYW5uZWxJZC50cmltKCkgfHwgIXJlY2VpcHQudXNhZ2VOb25jZS50cmltKCkgfHxcbiAgICAgICAgIXJlY2VpcHQub2ZmZXJJZC50cmltKCkgfHwgIXJlY2VpcHQucGF5ZXIudHJpbSgpIHx8ICFyZWNlaXB0LnNlbGxlci50cmltKCkgfHxcbiAgICAgICAgIXJlY2VpcHQudm91Y2hlclNpZ25hdHVyZT8udHJpbSgpIHx8ICFyZWNlaXB0LnJlY2VpcHRTaWduYXR1cmU/LnRyaW0oKSB8fFxuICAgICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIocmVjZWlwdC5yZXNlcnZlZEF0TXMpIHx8IHJlY2VpcHQucmVzZXJ2ZWRBdE1zIDwgMCB8fFxuICAgICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIocmVjZWlwdC5zZXR0bGVkQXRNcykgfHwgcmVjZWlwdC5zZXR0bGVkQXRNcyEgPCByZWNlaXB0LnJlc2VydmVkQXRNcyB8fFxuICAgICAgICBiaWxsZWQgPT09IG51bGwgfHwgY2VpbGluZyA9PT0gbnVsbCB8fCBwcmlvciA9PT0gbnVsbCB8fCByZW1haW5kZXIgPT09IG51bGwgfHxcbiAgICAgICAgYW1vdW50ID09PSBudWxsIHx8IHF1YW50aXR5ID09PSBudWxsIHx8IHByaWNlID09PSBudWxsIHx8IHJlc2VydmVkID09PSBudWxsIHx8XG4gICAgICAgIHByaWNlID4gQmlnSW50KE51bWJlci5NQVhfU0FGRV9JTlRFR0VSKSkgeyBpc3N1ZSgnaW5jb21wbGV0ZS1pZGVudGl0eS1yZWNlaXB0Jyk7IGNvbnRpbnVlOyB9XG4gICAgY29uc3Qgb2ZmZXIgPSB7IHNrdVJlZjogcmVjZWlwdC5yZWxlYXNlUmVmLCBtZXRlclVuaXQ6IHJlY2VpcHQubWV0ZXJVbml0LCB1bml0UHJpY2VNaWNyb3M6IE51bWJlcihwcmljZSksXG4gICAgICBwcmljZVZlcnNpb246IHJlY2VpcHQucHJpY2VWZXJzaW9uLCBzcGxpdE1hbmlmZXN0SGFzaDogcmVjZWlwdC5zcGxpdE1hbmlmZXN0SGFzaCB9O1xuICAgIGNvbnN0IHZlcmlmaWVkID0gdmVyaWZ5SWRlbnRpdHlQZXJVc2VPZmZlcihvZmZlcik7XG4gICAgY29uc3QgcXVvdGUgPSBxdW90ZUlkZW50aXR5SW5mZXJlbmNlVHVybih7IG9mZmVyLCBiaWxsZWRJbmZlcmVuY2VNaWNyb3M6IGJpbGxlZCxcbiAgICAgIGluZmVyZW5jZUNlaWxpbmdNaWNyb3M6IGNlaWxpbmcsIHByaW9yUmVtYWluZGVyTnVtZXJhdG9yOiBwcmlvciB9KTtcbiAgICBpZiAoIXZlcmlmaWVkLm9rIHx8ICFxdW90ZS5vayB8fCBxdW90ZS5hbW91bnRNaWNyb3MgIT09IGFtb3VudCB8fCBxdW90ZS5yZW1haW5kZXJOdW1lcmF0b3IgIT09IHJlbWFpbmRlciB8fFxuICAgICAgICBxdW90ZS5yZXNlcnZhdGlvblF1YW50aXR5ICE9PSBxdWFudGl0eSB8fCBxdW90ZS5yZXNlcnZlZE1hcmt1cE1pY3JvcyAhPT0gcmVzZXJ2ZWQpIHtcbiAgICAgIGlzc3VlKCdpZGVudGl0eS1xdW90ZS1taXNtYXRjaCcpOyBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgYWxsb2NhdGlvbiA9IHF1b3RlUmV2ZW51ZUFsbG9jYXRpb25zKHsgZGlzdHJpYnV0YWJsZU1pY3JvczogYW1vdW50LCBzcGxpdE1hbmlmZXN0OiB2ZXJpZmllZC5tYW5pZmVzdCB9KTtcbiAgICBpZiAoIWFsbG9jYXRpb24ub2spIHsgaXNzdWUoYWxsb2NhdGlvbi5jb2RlKTsgY29udGludWU7IH1cbiAgICBsaW5lcy5wdXNoKHsgY2hhbm5lbElkOiByZWNlaXB0LmNoYW5uZWxJZCwgdXNhZ2VOb25jZTogcmVjZWlwdC51c2FnZU5vbmNlLCBvZmZlcklkOiByZWNlaXB0Lm9mZmVySWQsXG4gICAgICByZWxlYXNlUmVmOiByZWNlaXB0LnJlbGVhc2VSZWYsIHBheWVyOiByZWNlaXB0LnBheWVyLCBzZWxsZXI6IHJlY2VpcHQuc2VsbGVyLFxuICAgICAgcHJpY2VWZXJzaW9uOiByZWNlaXB0LnByaWNlVmVyc2lvbiwgc3BsaXRNYW5pZmVzdEhhc2g6IHJlY2VpcHQuc3BsaXRNYW5pZmVzdEhhc2gsXG4gICAgICBiaWxsZWRJbmZlcmVuY2VNaWNyb3M6IGJpbGxlZC50b1N0cmluZygpLCBtYXJrdXBNaWNyb3M6IGFtb3VudC50b1N0cmluZygpLCBhbGxvY2F0aW9uUXVvdGU6IHtcbiAgICAgICAgY3JlYXRvck1pY3JvczogYWxsb2NhdGlvbi5hbGxvY2F0aW9uc01pY3Jvcy5jcmVhdG9yLnRvU3RyaW5nKCksIGRhb01pY3JvczogYWxsb2NhdGlvbi5hbGxvY2F0aW9uc01pY3Jvcy5kYW8udG9TdHJpbmcoKSxcbiAgICAgICAgY29tcG9uZW50TWljcm9zOiBhbGxvY2F0aW9uLmFsbG9jYXRpb25zTWljcm9zLmNvbXBvbmVudC50b1N0cmluZygpLFxuICAgICAgICBjb21wb25lbnRBdXRob3JzTWljcm9zOiBhbGxvY2F0aW9uLmNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zID09PSB1bmRlZmluZWQgPyBudWxsIDpcbiAgICAgICAgICBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYWxsb2NhdGlvbi5jb21wb25lbnRBbGxvY2F0aW9uc01pY3JvcykubWFwKChbYXV0aG9yLCB2YWx1ZV0pID0+IFthdXRob3IsIHZhbHVlLnRvU3RyaW5nKCldKSksXG4gICAgICB9IH0pO1xuICAgIG1hcmt1cE1pY3JvcyArPSBhbW91bnQ7XG4gIH1cbiAgcmV0dXJuIHsgYmFzaXM6ICdob3N0ZWQtc2V0dGxlZC11c2FnZScsIGN1cnJlbmN5OiAnVVNEJywgY2hhaW5GaW5hbGl0eTogJ25vdC1tZWFzdXJlZCcsXG4gICAgYWxsb2NhdGlvbkJhc2lzOiAncGVyLXJlY2VpcHQtcXVvdGUnLCBsaW5lcywgbWFya3VwTWljcm9zOiBtYXJrdXBNaWNyb3MudG9TdHJpbmcoKSwgcmVzZXJ2ZWRSZWNlaXB0cyxcbiAgICBjb21wbGV0ZTogaXNzdWVzLmxlbmd0aCA9PT0gMCwgaXNzdWVzLCBjb3N0UGVyQWNjZXB0ZWRPdXRjb21lTWljcm9zOiBudWxsLCBvdXRjb21lRXZpZGVuY2U6ICd1bmF2YWlsYWJsZScgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBNb25leSBhZ2dyZWdhdGlvbiDigJQgcmVmdXNlcyB0byBtaXggY3VycmVuY2llc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCB0eXBlIE1vbmV5U3VtID1cbiAgfCB7IHJlYWRvbmx5IG9rOiB0cnVlOyByZWFkb25seSB0b3RhbDogTW9uZXkgfVxuICB8IHsgcmVhZG9ubHkgb2s6IGZhbHNlOyByZWFkb25seSBjb2RlOiAnY3VycmVuY3ktbWlzbWF0Y2gnOyByZWFkb25seSBkZXRhaWw6IHN0cmluZyB9O1xuXG4vKipcbiAqIFN1bSBgYW1vdW50c2AsIHJlZnVzaW5nIGEgbWl4ZWQtY3VycmVuY3kgc2V0LiBgY3VycmVuY3lgIGZpeGVzIHRoZSBleHBlY3RlZFxuICogZGVub21pbmF0aW9uIHNvIGFuIEVNUFRZIHNldCBzdGlsbCB5aWVsZHMgYSB3ZWxsLXR5cGVkIHplcm8gaW5zdGVhZCBvZiBhblxuICogdW50eXBlZCBvbmUg4oCUIGEgZGFzaGJvYXJkIHJlcG9ydGluZyBgMGAgd2l0aCBubyBjdXJyZW5jeSBpcyBhIGJ1ZyB3YWl0aW5nIHRvXG4gKiBiZSBmb3JtYXR0ZWQgYXMgZG9sbGFycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bU1vbmV5KGFtb3VudHM6IHJlYWRvbmx5IE1vbmV5W10sIGN1cnJlbmN5OiBzdHJpbmcpOiBNb25leVN1bSB7XG4gIGxldCB0b3RhbE1pbm9yID0gMDtcbiAgZm9yIChjb25zdCBhbW91bnQgb2YgYW1vdW50cykge1xuICAgIGlmIChhbW91bnQuY3VycmVuY3kgIT09IGN1cnJlbmN5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGNvZGU6ICdjdXJyZW5jeS1taXNtYXRjaCcsXG4gICAgICAgIGRldGFpbDogYGNhbm5vdCBhZ2dyZWdhdGUgJHthbW91bnQuY3VycmVuY3l9IGludG8gYSAke2N1cnJlbmN5fSB0b3RhbGAsXG4gICAgICB9O1xuICAgIH1cbiAgICB0b3RhbE1pbm9yICs9IGFtb3VudC5hbW91bnRNaW5vcjtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdG90YWw6IHsgYW1vdW50TWlub3I6IHRvdGFsTWlub3IsIGN1cnJlbmN5IH0gfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBPZmZlciBjYXRhbG9nIGRhc2hib2FyZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWVyY2VDYXRhbG9nTGluZSB7XG4gIHJlYWRvbmx5IG9mZmVySWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJvZHVjdElkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByb2R1Y3RUaXRsZTogc3RyaW5nIHwgbnVsbDtcbiAgcmVhZG9ubHkgc2t1UmVmOiBzdHJpbmcgfCBudWxsO1xuICByZWFkb25seSBjcmVhdG9ySWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IHByaWNpbmdNb2RlbDogT2ZmZXJbJ3ByaWNpbmdNb2RlbCddO1xuICByZWFkb25seSBwcmljZTogTW9uZXk7XG4gIHJlYWRvbmx5IHBlclVzZTogUGVyVXNlT2ZmZXJUZXJtcyB8IG51bGw7XG4gIHJlYWRvbmx5IGFjdGl2ZTogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcHJvZHVjdEFjdGl2ZTogYm9vbGVhbiB8IG51bGw7XG59XG5cbi8qKiBFeGFjdCBvZmZlciB0ZXJtcyB2aXNpYmxlIHRvIGJ1eWVycyBiZWZvcmUgdGhleSBjaG9vc2UgYSBwYXltZW50IHJhaWwuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWVyY2VDYXRhbG9nRGFzaGJvYXJkKFxuICBsZWRnZXI6IExlZGdlclN0YXRlLFxuKTogcmVhZG9ubHkgQ29tbWVyY2VDYXRhbG9nTGluZVtdIHtcbiAgcmV0dXJuIHNvcnRlZEJ5SWQobGVkZ2VyLm9mZmVycy52YWx1ZXMoKSwgKG9mZmVyKSA9PiBvZmZlci5vZmZlcklkKS5tYXAoKG9mZmVyKSA9PiB7XG4gICAgY29uc3QgcHJvZHVjdCA9IGxlZGdlci5wcm9kdWN0cy5nZXQob2ZmZXIucHJvZHVjdElkKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2ZmZXJJZDogb2ZmZXIub2ZmZXJJZCxcbiAgICAgIHByb2R1Y3RJZDogb2ZmZXIucHJvZHVjdElkLFxuICAgICAgcHJvZHVjdFRpdGxlOiBwcm9kdWN0Py50aXRsZSA/PyBudWxsLFxuICAgICAgc2t1UmVmOiBwcm9kdWN0Py5za3VSZWYgPz8gbnVsbCxcbiAgICAgIGNyZWF0b3JJZDogcHJvZHVjdD8uY3JlYXRvcklkID8/IG51bGwsXG4gICAgICBwcmljaW5nTW9kZWw6IG9mZmVyLnByaWNpbmdNb2RlbCxcbiAgICAgIHByaWNlOiBvZmZlci5wcmljZSxcbiAgICAgIHBlclVzZTogb2ZmZXIucGVyVXNlID8/IG51bGwsXG4gICAgICBhY3RpdmU6IG9mZmVyLmFjdGl2ZSxcbiAgICAgIHByb2R1Y3RBY3RpdmU6IHByb2R1Y3Q/LmFjdGl2ZSA/PyBudWxsLFxuICAgIH07XG4gIH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENoZWNrb3V0IGRhc2hib2FyZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tvdXRMaW5lIHtcbiAgcmVhZG9ubHkgb3JkZXJJZDogc3RyaW5nO1xuICByZWFkb25seSBvcmRlclN0YXRlOiBPcmRlclN0YXRlO1xuICByZWFkb25seSBwcm9kdWN0SWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJvZHVjdFRpdGxlOiBzdHJpbmcgfCBudWxsO1xuICByZWFkb25seSBvZmZlcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByaWNpbmdNb2RlbDogT2ZmZXJbJ3ByaWNpbmdNb2RlbCddIHwgbnVsbDtcbiAgcmVhZG9ubHkgcGVyVXNlOiBQZXJVc2VPZmZlclRlcm1zIHwgbnVsbDtcbiAgcmVhZG9ubHkgYW1vdW50OiBNb25leTtcbiAgcmVhZG9ubHkgcmVmdW5kZWRNaW5vcjogbnVtYmVyO1xuICAvKiogTnVsbCB3aGVuIHRoZSBvcmRlciBuZXZlciByZWFjaGVkIGBwYWlkYCDigJQgdGhlcmUgaXMgbm90aGluZyB0byBlbnRpdGxlLiAqL1xuICByZWFkb25seSBlbnRpdGxlbWVudElkOiBzdHJpbmcgfCBudWxsO1xuICByZWFkb25seSBlbnRpdGxlbWVudFN0YXRlOiBFbnRpdGxlbWVudFsnc3RhdGUnXSB8IG51bGw7XG4gIC8qKiBOdWxsIHdoZW4gdGhlcmUgaXMgbm8gZW50aXRsZW1lbnQgdG8gc2VhdCBhZ2FpbnN0LiAqL1xuICByZWFkb25seSBzZWF0czogU2VhdFVzYWdlIHwgbnVsbDtcbiAgcmVhZG9ubHkgY3JlYXRlZEF0TXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGVja291dERhc2hib2FyZCB7XG4gIHJlYWRvbmx5IGJ1eWVySWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJpbmNpcGFsOiBCdXllclByaW5jaXBhbDtcbiAgcmVhZG9ubHkgbGluZXM6IHJlYWRvbmx5IENoZWNrb3V0TGluZVtdO1xuICByZWFkb25seSBjdXJyZW5jeTogc3RyaW5nO1xuICAvKiogR3Jvc3Mgb2YgZXZlcnkgb3JkZXIgaW4gYSBzZXR0bGVkIHN0YXRlLCBiZWZvcmUgcmVmdW5kcy4gKi9cbiAgcmVhZG9ubHkgZ3Jvc3NNaW5vcjogbnVtYmVyO1xuICAvKiogUmVmdW5kcyB0aGUgbGVkZ2VyIGhhcyBhY3R1YWxseSBzZXR0bGVkLiAqL1xuICByZWFkb25seSByZWZ1bmRlZE1pbm9yOiBudW1iZXI7XG4gIHJlYWRvbmx5IG5ldE1pbm9yOiBudW1iZXI7XG4gIC8qKiBTZXQgd2hlbiB0aGUgYnV5ZXIncyBvcmRlcnMgc3BhbiBjdXJyZW5jaWVzOyB0aGUgdG90YWxzIGFyZSB0aGVuIHplcm8uICovXG4gIHJlYWRvbmx5IGN1cnJlbmN5TWlzbWF0Y2g6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tvdXREYXNoYm9hcmRJbnB1dCB7XG4gIHJlYWRvbmx5IGJ1eWVySWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgbGVkZ2VyOiBMZWRnZXJTdGF0ZTtcbiAgcmVhZG9ubHkgb3JnczogUmVhZG9ubHlNYXA8c3RyaW5nLCBPcmdhbml6YXRpb24+O1xuICByZWFkb25seSBzZWF0UG9saWNpZXM6IFJlYWRvbmx5TWFwPHN0cmluZywgU2VhdFBvbGljeT47XG4gIHJlYWRvbmx5IGluc3RhbGxhdGlvbnM6IHJlYWRvbmx5IEluc3RhbGxhdGlvbltdO1xuICAvKiogRGVub21pbmF0aW9uIHRoZSB0b3RhbHMgYXJlIHJlcG9ydGVkIGluLiAqL1xuICByZWFkb25seSBjdXJyZW5jeTogc3RyaW5nO1xufVxuXG4vKiogT3JkZXJzIHdob3NlIG1vbmV5IGlzIHJlYWw6IGV2ZXJ5dGhpbmcgZXhjZXB0IGEgZmFpbGVkIG9yIGNhbmNlbGVkIGF0dGVtcHQuICovXG5jb25zdCBTRVRUTEVEX09SREVSX1NUQVRFUzogUmVhZG9ubHlTZXQ8T3JkZXJTdGF0ZT4gPSBuZXcgU2V0PE9yZGVyU3RhdGU+KFtcbiAgJ3BhaWQnLFxuICAncGFydGlhbGx5LXJlZnVuZGVkJyxcbiAgJ3JlZnVuZGVkJyxcbl0pO1xuXG4vKipcbiAqIFdoYXQgb25lIGJ1eWVyIGJvdWdodCwgYW5kIHdoYXQgZWFjaCBwdXJjaGFzZSBjdXJyZW50bHkgZW50aXRsZXMgdGhlbSB0by5cbiAqXG4gKiBBIFJFVk9LRUQgZW50aXRsZW1lbnQgaXMgcmVwb3J0ZWQsIG5vdCBmaWx0ZXJlZCBvdXQuIEhpZGluZyBpdCBwcm9kdWNlcyB0aGVcbiAqIHNpbmdsZSBtb3N0IGNvbW1vbiBzdXBwb3J0IHRpY2tldCBpbiBhIGNvbW1lcmNlIHN5c3RlbSDigJQgXCJJIHBhaWQgZm9yIHRoaXMgYW5kXG4gKiBpdCB2YW5pc2hlZFwiIOKAlCB3aGVyZSB0aGUgaG9uZXN0IGFuc3dlciBpcyB0aGF0IGEgcmVmdW5kIHJldm9rZWQgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja291dERhc2hib2FyZChpbnB1dDogQ2hlY2tvdXREYXNoYm9hcmRJbnB1dCk6IENoZWNrb3V0RGFzaGJvYXJkIHtcbiAgY29uc3QgeyBidXllcklkLCBsZWRnZXIsIG9yZ3MsIHNlYXRQb2xpY2llcywgaW5zdGFsbGF0aW9ucywgY3VycmVuY3kgfSA9IGlucHV0O1xuICBjb25zdCBwcmluY2lwYWwgPSByZXNvbHZlQnV5ZXJQcmluY2lwYWwoYnV5ZXJJZCwgb3Jncyk7XG5cbiAgY29uc3QgZW50aXRsZW1lbnRCeU9yZGVyID0gbmV3IE1hcDxzdHJpbmcsIEVudGl0bGVtZW50PigpO1xuICBmb3IgKGNvbnN0IGVudCBvZiBsZWRnZXIuZW50aXRsZW1lbnRzLnZhbHVlcygpKSB7XG4gICAgaWYgKGVudC5idXllcklkID09PSBidXllcklkKSBlbnRpdGxlbWVudEJ5T3JkZXIuc2V0KGVudC5vcmRlcklkLCBlbnQpO1xuICB9XG5cbiAgY29uc3QgbGluZXM6IENoZWNrb3V0TGluZVtdID0gW107XG4gIGZvciAoY29uc3Qgb3JkZXIgb2Ygc29ydGVkQnlJZChsZWRnZXIub3JkZXJzLnZhbHVlcygpLCAobykgPT4gby5vcmRlcklkKSkge1xuICAgIGlmIChvcmRlci5idXllcklkICE9PSBidXllcklkKSBjb250aW51ZTtcbiAgICBjb25zdCBwcm9kdWN0OiBQcm9kdWN0IHwgdW5kZWZpbmVkID0gbGVkZ2VyLnByb2R1Y3RzLmdldChvcmRlci5wcm9kdWN0SWQpO1xuICAgIGNvbnN0IG9mZmVyOiBPZmZlciB8IHVuZGVmaW5lZCA9IGxlZGdlci5vZmZlcnMuZ2V0KG9yZGVyLm9mZmVySWQpO1xuICAgIGNvbnN0IGVudCA9IGVudGl0bGVtZW50QnlPcmRlci5nZXQob3JkZXIub3JkZXJJZCkgPz8gbnVsbDtcbiAgICBsaW5lcy5wdXNoKHtcbiAgICAgIG9yZGVySWQ6IG9yZGVyLm9yZGVySWQsXG4gICAgICBvcmRlclN0YXRlOiBvcmRlci5zdGF0ZSxcbiAgICAgIHByb2R1Y3RJZDogb3JkZXIucHJvZHVjdElkLFxuICAgICAgcHJvZHVjdFRpdGxlOiBwcm9kdWN0Py50aXRsZSA/PyBudWxsLFxuICAgICAgb2ZmZXJJZDogb3JkZXIub2ZmZXJJZCxcbiAgICAgIHByaWNpbmdNb2RlbDogb2ZmZXI/LnByaWNpbmdNb2RlbCA/PyBudWxsLFxuICAgICAgcGVyVXNlOiBvZmZlcj8ucGVyVXNlID8/IG51bGwsXG4gICAgICBhbW91bnQ6IG9yZGVyLmFtb3VudCxcbiAgICAgIHJlZnVuZGVkTWlub3I6IG9yZGVyLnJlZnVuZGVkTWlub3IsXG4gICAgICBlbnRpdGxlbWVudElkOiBlbnQ/LmVudGl0bGVtZW50SWQgPz8gbnVsbCxcbiAgICAgIGVudGl0bGVtZW50U3RhdGU6IGVudD8uc3RhdGUgPz8gbnVsbCxcbiAgICAgIHNlYXRzOiBlbnQgPyBzZWF0VXNhZ2UoZW50LmVudGl0bGVtZW50SWQsIHNlYXRzRm9yT2ZmZXIob3JkZXIub2ZmZXJJZCwgc2VhdFBvbGljaWVzKSwgaW5zdGFsbGF0aW9ucykgOiBudWxsLFxuICAgICAgY3JlYXRlZEF0TXM6IG9yZGVyLmNyZWF0ZWRBdE1zLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3Qgc2V0dGxlZCA9IGxpbmVzLmZpbHRlcigobCkgPT4gU0VUVExFRF9PUkRFUl9TVEFURVMuaGFzKGwub3JkZXJTdGF0ZSkpO1xuICBjb25zdCBncm9zcyA9IHN1bU1vbmV5KFxuICAgIHNldHRsZWQubWFwKChsKSA9PiBsLmFtb3VudCksXG4gICAgY3VycmVuY3ksXG4gICk7XG4gIGlmICghZ3Jvc3Mub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgYnV5ZXJJZCxcbiAgICAgIHByaW5jaXBhbCxcbiAgICAgIGxpbmVzLFxuICAgICAgY3VycmVuY3ksXG4gICAgICBncm9zc01pbm9yOiAwLFxuICAgICAgcmVmdW5kZWRNaW5vcjogMCxcbiAgICAgIG5ldE1pbm9yOiAwLFxuICAgICAgY3VycmVuY3lNaXNtYXRjaDogZ3Jvc3MuZGV0YWlsLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVmdW5kZWRNaW5vciA9IHNldHRsZWQucmVkdWNlKChzdW0sIGwpID0+IHN1bSArIGwucmVmdW5kZWRNaW5vciwgMCk7XG4gIHJldHVybiB7XG4gICAgYnV5ZXJJZCxcbiAgICBwcmluY2lwYWwsXG4gICAgbGluZXMsXG4gICAgY3VycmVuY3ksXG4gICAgZ3Jvc3NNaW5vcjogZ3Jvc3MudG90YWwuYW1vdW50TWlub3IsXG4gICAgcmVmdW5kZWRNaW5vcixcbiAgICBuZXRNaW5vcjogZ3Jvc3MudG90YWwuYW1vdW50TWlub3IgLSByZWZ1bmRlZE1pbm9yLFxuICAgIGN1cnJlbmN5TWlzbWF0Y2g6IG51bGwsXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVmdW5kIGRhc2hib2FyZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVmdW5kUG9zaXRpb24ge1xuICByZWFkb25seSBvcmRlcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG9yZGVyU3RhdGU6IE9yZGVyU3RhdGU7XG4gIHJlYWRvbmx5IG9yZGVyQW1vdW50TWlub3I6IG51bWJlcjtcbiAgcmVhZG9ubHkgY3VycmVuY3k6IHN0cmluZztcbiAgLyoqIFJlZnVuZHMgdGhlIGxlZGdlciBoYXMgc2V0dGxlZCAoYE9yZGVyLnJlZnVuZGVkTWlub3JgKS4gKi9cbiAgcmVhZG9ubHkgc2V0dGxlZE1pbm9yOiBudW1iZXI7XG4gIC8qKiBSZXF1ZXN0ZWQgYnV0IG5vdCB5ZXQgc3VjY2VlZGVkIG9yIGZhaWxlZCDigJQgbW9uZXkgdGhhdCBtYXkgc3RpbGwgbGVhdmUuICovXG4gIHJlYWRvbmx5IHBlbmRpbmdNaW5vcjogbnVtYmVyO1xuICAvKipcbiAgICogYGFtb3VudCAtIHNldHRsZWQgLSBwZW5kaW5nYC4gQ29uc2VydmF0aXZlIEJZIERFU0lHTjogaXNzdWluZyB0aGlzIG11Y2ggaXNcbiAgICogc2FmZSBldmVuIGlmIGV2ZXJ5IGluLWZsaWdodCByZWZ1bmQgc3VjY2VlZHMuXG4gICAqL1xuICByZWFkb25seSByZWZ1bmRhYmxlTWlub3I6IG51bWJlcjtcbiAgcmVhZG9ubHkgcmVmdW5kczogcmVhZG9ubHkgUmVmdW5kW107XG4gIHJlYWRvbmx5IGVudGl0bGVtZW50SWQ6IHN0cmluZyB8IG51bGw7XG4gIHJlYWRvbmx5IGVudGl0bGVtZW50U3RhdGU6IEVudGl0bGVtZW50WydzdGF0ZSddIHwgbnVsbDtcbiAgLyoqXG4gICAqIEluc3RhbGxhdGlvbnMgdGhhdCBrZWVwIHJ1bm5pbmcgaWYgdGhpcyBvcmRlciBpcyBmdWxseSByZWZ1bmRlZC4gUmV2b2NhdGlvblxuICAgKiByZWZ1c2VzIGBpbnN0YWxsYC9gdXBkYXRlYCBhbmQgc3RpbGwgcGVybWl0cyBgcmVwYWlyYCAoRC0wNDIpLCBzbyBhIHJlZnVuZFxuICAgKiBpcyBub3QgYSBraWxsIHN3aXRjaCBhbmQgdGhlIGRhc2hib2FyZCBtdXN0IG5vdCBpbXBseSB0aGF0IGl0IGlzLlxuICAgKi9cbiAgcmVhZG9ubHkgYWN0aXZlSW5zdGFsbGF0aW9uczogbnVtYmVyO1xuICByZWFkb25seSBpbnRlbnRzU3Vydml2aW5nUmV2b2NhdGlvbjogcmVhZG9ubHkgRGVsaXZlcnlJbnRlbnRbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWZ1bmREYXNoYm9hcmRJbnB1dCB7XG4gIHJlYWRvbmx5IGxlZGdlcjogTGVkZ2VyU3RhdGU7XG4gIHJlYWRvbmx5IGluc3RhbGxhdGlvbnM6IHJlYWRvbmx5IEluc3RhbGxhdGlvbltdO1xuICAvKiogUmVzdHJpY3QgdG8gb25lIGJ1eWVyOyBvbWl0IGZvciB0aGUgd2hvbGUgbGVkZ2VyLiAqL1xuICByZWFkb25seSBidXllcklkPzogc3RyaW5nO1xufVxuXG5jb25zdCBSRUZVTkRfSU5URU5UX1BST0JFUzogcmVhZG9ubHkgRGVsaXZlcnlJbnRlbnRbXSA9IFsnaW5zdGFsbCcsICd1cGRhdGUnLCAncmVwYWlyJ107XG5cbmZ1bmN0aW9uIHN1cnZpdmluZ0ludGVudHMoZW50aXRsZW1lbnQ6IEVudGl0bGVtZW50LCBpbnN0YWxsYXRpb246IEluc3RhbGxhdGlvbik6IERlbGl2ZXJ5SW50ZW50W10ge1xuICAvLyBBc2sgdGhlIHNoYXJlZCBydWxlIHJhdGhlciB0aGFuIHJlc3RhdGluZyBpdCDigJQgc2VlIHRoZSBtb2R1bGUgaGVhZGVyLlxuICByZXR1cm4gUkVGVU5EX0lOVEVOVF9QUk9CRVMuZmlsdGVyKFxuICAgIChpbnRlbnQpID0+IGF1dGhvcml6ZVNlYXRJbnRlbnQoaW5zdGFsbGF0aW9uLCBlbnRpdGxlbWVudCwgaW50ZW50KS5vayxcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgcmVmdW5kIHBvc2l0aW9uIG9mIGV2ZXJ5IG9yZGVyLCB3aXRoIHRoZSBibGFzdCByYWRpdXMgb2YgcmV2b2tpbmcgaXQuXG4gKlxuICogYHBlbmRpbmdNaW5vcmAgaXMgdGhlIHJhaWw6IGBPcmRlci5yZWZ1bmRlZE1pbm9yYCBhbG9uZSB3b3VsZCByZXBvcnQgdGhlIGZ1bGxcbiAqIHJlbWFpbmRlciBhcyByZWZ1bmRhYmxlIHdoaWxlIGEgcmVmdW5kIGlzIGFscmVhZHkgaW4gZmxpZ2h0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmdW5kRGFzaGJvYXJkKGlucHV0OiBSZWZ1bmREYXNoYm9hcmRJbnB1dCk6IHJlYWRvbmx5IFJlZnVuZFBvc2l0aW9uW10ge1xuICBjb25zdCB7IGxlZGdlciwgaW5zdGFsbGF0aW9ucywgYnV5ZXJJZCB9ID0gaW5wdXQ7XG5cbiAgY29uc3QgcmVmdW5kc0J5T3JkZXIgPSBuZXcgTWFwPHN0cmluZywgUmVmdW5kW10+KCk7XG4gIGZvciAoY29uc3QgcmVmdW5kIG9mIHNvcnRlZEJ5SWQobGVkZ2VyLnJlZnVuZHMudmFsdWVzKCksIChyKSA9PiByLnJlZnVuZElkKSkge1xuICAgIGNvbnN0IGJ1Y2tldCA9IHJlZnVuZHNCeU9yZGVyLmdldChyZWZ1bmQub3JkZXJJZCk7XG4gICAgaWYgKGJ1Y2tldCkgYnVja2V0LnB1c2gocmVmdW5kKTtcbiAgICBlbHNlIHJlZnVuZHNCeU9yZGVyLnNldChyZWZ1bmQub3JkZXJJZCwgW3JlZnVuZF0pO1xuICB9XG5cbiAgY29uc3QgZW50aXRsZW1lbnRCeU9yZGVyID0gbmV3IE1hcDxzdHJpbmcsIEVudGl0bGVtZW50PigpO1xuICBmb3IgKGNvbnN0IGVudCBvZiBsZWRnZXIuZW50aXRsZW1lbnRzLnZhbHVlcygpKSBlbnRpdGxlbWVudEJ5T3JkZXIuc2V0KGVudC5vcmRlcklkLCBlbnQpO1xuXG4gIGNvbnN0IHBvc2l0aW9uczogUmVmdW5kUG9zaXRpb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IG9yZGVyIG9mIHNvcnRlZEJ5SWQobGVkZ2VyLm9yZGVycy52YWx1ZXMoKSwgKG8pID0+IG8ub3JkZXJJZCkpIHtcbiAgICBpZiAoYnV5ZXJJZCAhPT0gdW5kZWZpbmVkICYmIG9yZGVyLmJ1eWVySWQgIT09IGJ1eWVySWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJlZnVuZHMgPSByZWZ1bmRzQnlPcmRlci5nZXQob3JkZXIub3JkZXJJZCkgPz8gW107XG4gICAgY29uc3QgcGVuZGluZ01pbm9yID0gcmVmdW5kc1xuICAgICAgLmZpbHRlcigocikgPT4gci5zdGF0ZSA9PT0gJ3BlbmRpbmcnKVxuICAgICAgLnJlZHVjZSgoc3VtLCByKSA9PiBzdW0gKyByLmFtb3VudC5hbW91bnRNaW5vciwgMCk7XG4gICAgY29uc3QgZW50ID0gZW50aXRsZW1lbnRCeU9yZGVyLmdldChvcmRlci5vcmRlcklkKSA/PyBudWxsO1xuXG4gICAgY29uc3QgaGVsZCA9IGVudFxuICAgICAgPyBpbnN0YWxsYXRpb25zLmZpbHRlcigoaSkgPT4gaS5lbnRpdGxlbWVudElkID09PSBlbnQuZW50aXRsZW1lbnRJZCAmJiBpLnN0YXRlID09PSAnYWN0aXZlJylcbiAgICAgIDogW107XG4gICAgLy8gRXZlcnkgYWN0aXZlIGluc3RhbGxhdGlvbiByZXNvbHZlcyBpZGVudGljYWxseSB1bmRlciB0aGUgc2hhcmVkIHJ1bGUsIHNvXG4gICAgLy8gb25lIHByb2JlIGRlc2NyaWJlcyB0aGVtIGFsbDsgYW4gZW1wdHkgc2V0IHN1cnZpdmVzIG5vdGhpbmcuXG4gICAgY29uc3Qgc3Vydml2aW5nID0gZW50ICYmIGhlbGQubGVuZ3RoID4gMCA/IHN1cnZpdmluZ0ludGVudHMoeyAuLi5lbnQsIHN0YXRlOiAncmV2b2tlZCcgfSwgaGVsZFswXSkgOiBbXTtcblxuICAgIHBvc2l0aW9ucy5wdXNoKHtcbiAgICAgIG9yZGVySWQ6IG9yZGVyLm9yZGVySWQsXG4gICAgICBvcmRlclN0YXRlOiBvcmRlci5zdGF0ZSxcbiAgICAgIG9yZGVyQW1vdW50TWlub3I6IG9yZGVyLmFtb3VudC5hbW91bnRNaW5vcixcbiAgICAgIGN1cnJlbmN5OiBvcmRlci5hbW91bnQuY3VycmVuY3ksXG4gICAgICBzZXR0bGVkTWlub3I6IG9yZGVyLnJlZnVuZGVkTWlub3IsXG4gICAgICBwZW5kaW5nTWlub3IsXG4gICAgICByZWZ1bmRhYmxlTWlub3I6IE1hdGgubWF4KDAsIG9yZGVyLmFtb3VudC5hbW91bnRNaW5vciAtIG9yZGVyLnJlZnVuZGVkTWlub3IgLSBwZW5kaW5nTWlub3IpLFxuICAgICAgcmVmdW5kcyxcbiAgICAgIGVudGl0bGVtZW50SWQ6IGVudD8uZW50aXRsZW1lbnRJZCA/PyBudWxsLFxuICAgICAgZW50aXRsZW1lbnRTdGF0ZTogZW50Py5zdGF0ZSA/PyBudWxsLFxuICAgICAgYWN0aXZlSW5zdGFsbGF0aW9uczogaGVsZC5sZW5ndGgsXG4gICAgICBpbnRlbnRzU3Vydml2aW5nUmV2b2NhdGlvbjogc3Vydml2aW5nLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBwb3NpdGlvbnM7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gU3VwcG9ydCBkYXNoYm9hcmRcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgdHlwZSBTdXBwb3J0QmxvY2tDb2RlID1cbiAgfCAnbm8tZW50aXRsZW1lbnQnXG4gIHwgJ25vdC1lbnRpdGxlZCdcbiAgfCAnZW50aXRsZW1lbnQtcmV2b2tlZCdcbiAgfCAnaW5zdGFsbGF0aW9uLXJlbGVhc2VkJ1xuICB8ICduby1zZWF0cy1hdmFpbGFibGUnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN1cHBvcnRGaW5kaW5nIHtcbiAgcmVhZG9ubHkgZW50aXRsZW1lbnRJZDogc3RyaW5nO1xuICByZWFkb25seSBvcmRlcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByb2R1Y3RJZDogc3RyaW5nO1xuICByZWFkb25seSBlbnRpdGxlbWVudFN0YXRlOiBFbnRpdGxlbWVudFsnc3RhdGUnXTtcbiAgcmVhZG9ubHkgc2VhdHM6IFNlYXRVc2FnZTtcbiAgLyoqIFRoaXMgdXNlcidzIGluc3RhbGxhdGlvbiBhZ2FpbnN0IHRoZSBlbnRpdGxlbWVudCwgaWYgYW55LiAqL1xuICByZWFkb25seSBpbnN0YWxsYXRpb25JZDogc3RyaW5nIHwgbnVsbDtcbiAgcmVhZG9ubHkgaW5zdGFsbGF0aW9uU3RhdGU6IEluc3RhbGxhdGlvblsnc3RhdGUnXSB8IG51bGw7XG4gIC8qKiBOdWxsIHdoZW4gbm90aGluZyBibG9ja3MgdGhlIHJlcXVlc3RlZCBpbnRlbnQuICovXG4gIHJlYWRvbmx5IGJsb2NrZWQ6IHsgcmVhZG9ubHkgY29kZTogU3VwcG9ydEJsb2NrQ29kZTsgcmVhZG9ubHkgZGV0YWlsOiBzdHJpbmcgfSB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3VwcG9ydERhc2hib2FyZCB7XG4gIHJlYWRvbmx5IHVzZXJJZDogc3RyaW5nO1xuICByZWFkb25seSBidXllcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGludGVudDogRGVsaXZlcnlJbnRlbnQ7XG4gIHJlYWRvbmx5IHByaW5jaXBhbDogQnV5ZXJQcmluY2lwYWw7XG4gIC8qKiBUaGUgdXNlcidzIHJvbGUgaW4gdGhlIGJ1eWluZyBvcmc7IG51bGwgZm9yIGFuIGluZGl2aWR1YWwgYnV5ZXIuICovXG4gIHJlYWRvbmx5IG9yZ1JvbGU6IE9yZ1JvbGUgfCBudWxsO1xuICByZWFkb25seSBlbnRpdGxlZDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZmluZGluZ3M6IHJlYWRvbmx5IFN1cHBvcnRGaW5kaW5nW107XG4gIC8qKiBUcnVlIHdoZW4gYXQgbGVhc3Qgb25lIGZpbmRpbmcgcGVybWl0cyBgaW50ZW50YC4gKi9cbiAgcmVhZG9ubHkgYW55UGVybWl0dGVkOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cHBvcnREYXNoYm9hcmRJbnB1dCB7XG4gIHJlYWRvbmx5IHVzZXJJZDogc3RyaW5nO1xuICByZWFkb25seSBidXllcklkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGludGVudDogRGVsaXZlcnlJbnRlbnQ7XG4gIHJlYWRvbmx5IGxlZGdlcjogTGVkZ2VyU3RhdGU7XG4gIHJlYWRvbmx5IG9yZ3M6IFJlYWRvbmx5TWFwPHN0cmluZywgT3JnYW5pemF0aW9uPjtcbiAgcmVhZG9ubHkgc2VhdFBvbGljaWVzOiBSZWFkb25seU1hcDxzdHJpbmcsIFNlYXRQb2xpY3k+O1xuICByZWFkb25seSBpbnN0YWxsYXRpb25zOiByZWFkb25seSBJbnN0YWxsYXRpb25bXTtcbn1cblxuLyoqXG4gKiBcIldoeSBjYW4ndCB0aGlzIHVzZXIgaW5zdGFsbD9cIiwgYW5zd2VyZWQgcGVyIGVudGl0bGVtZW50LlxuICpcbiAqIFRoZSByZWZ1c2FsIE9SREVSIG1hdGNoZXMgYGFsbG9jYXRlU2VhdGAgZGVsaWJlcmF0ZWx5OiBlbnRpdGxlbWVudCBleGlzdGVuY2UsXG4gKiB0aGVuIG1lbWJlcnNoaXAsIHRoZW4gc2VhdCBzdGF0ZSwgdGhlbiBjYXBhY2l0eS4gUmVwb3J0aW5nIFwibm8gc2VhdHNcbiAqIGF2YWlsYWJsZVwiIHRvIHNvbWVvbmUgd2hvIHdhcyBuZXZlciBlbnRpdGxlZCBzZW5kcyBhbiBhZG1pbiB0byBidXkgc2VhdHMgdGhhdFxuICogd291bGQgbm90IGhlbHAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdXBwb3J0RGFzaGJvYXJkKGlucHV0OiBTdXBwb3J0RGFzaGJvYXJkSW5wdXQpOiBTdXBwb3J0RGFzaGJvYXJkIHtcbiAgY29uc3QgeyB1c2VySWQsIGJ1eWVySWQsIGludGVudCwgbGVkZ2VyLCBvcmdzLCBzZWF0UG9saWNpZXMsIGluc3RhbGxhdGlvbnMgfSA9IGlucHV0O1xuICBjb25zdCBwcmluY2lwYWwgPSByZXNvbHZlQnV5ZXJQcmluY2lwYWwoYnV5ZXJJZCwgb3Jncyk7XG4gIGNvbnN0IG9yZ1JvbGUgPVxuICAgIHByaW5jaXBhbC5raW5kID09PSAnb3JnYW5pemF0aW9uJyA/IChtZW1iZXJzaGlwT2YocHJpbmNpcGFsLm9yZywgdXNlcklkKT8ucm9sZSA/PyBudWxsKSA6IG51bGw7XG4gIGNvbnN0IGVudGl0bGVkID0gcHJpbmNpcGFsRW50aXRsZXMocHJpbmNpcGFsLCB1c2VySWQpO1xuXG4gIGNvbnN0IGZpbmRpbmdzOiBTdXBwb3J0RmluZGluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZW50IG9mIHNvcnRlZEJ5SWQobGVkZ2VyLmVudGl0bGVtZW50cy52YWx1ZXMoKSwgKGUpID0+IGUuZW50aXRsZW1lbnRJZCkpIHtcbiAgICBpZiAoZW50LmJ1eWVySWQgIT09IGJ1eWVySWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG9yZGVyID0gbGVkZ2VyLm9yZGVycy5nZXQoZW50Lm9yZGVySWQpO1xuICAgIGNvbnN0IGdyYW50ZWQgPSBvcmRlciA/IHNlYXRzRm9yT2ZmZXIob3JkZXIub2ZmZXJJZCwgc2VhdFBvbGljaWVzKSA6IDE7XG4gICAgY29uc3Qgc2VhdHMgPSBzZWF0VXNhZ2UoZW50LmVudGl0bGVtZW50SWQsIGdyYW50ZWQsIGluc3RhbGxhdGlvbnMpO1xuICAgIGNvbnN0IG1pbmUgPVxuICAgICAgaW5zdGFsbGF0aW9ucy5maW5kKChpKSA9PiBpLmVudGl0bGVtZW50SWQgPT09IGVudC5lbnRpdGxlbWVudElkICYmIGkuaG9sZGVySWQgPT09IHVzZXJJZCkgPz8gbnVsbDtcblxuICAgIGxldCBibG9ja2VkOiBTdXBwb3J0RmluZGluZ1snYmxvY2tlZCddID0gbnVsbDtcbiAgICBpZiAoIWVudGl0bGVkKSB7XG4gICAgICBibG9ja2VkID0ge1xuICAgICAgICBjb2RlOiAnbm90LWVudGl0bGVkJyxcbiAgICAgICAgZGV0YWlsOlxuICAgICAgICAgIHByaW5jaXBhbC5raW5kID09PSAnb3JnYW5pemF0aW9uJ1xuICAgICAgICAgICAgPyBgJyR7dXNlcklkfScgaXMgbm90IGEgbWVtYmVyIG9mIG9yZyAnJHtwcmluY2lwYWwub3JnLm9yZ0lkfSdgXG4gICAgICAgICAgICA6IGAnJHt1c2VySWR9JyBpcyBub3QgdGhlIGluZGl2aWR1YWwgYnV5ZXIgJyR7YnV5ZXJJZH0nYCxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChtaW5lKSB7XG4gICAgICBjb25zdCB2ZXJkaWN0ID0gYXV0aG9yaXplU2VhdEludGVudChtaW5lLCBlbnQsIGludGVudCk7XG4gICAgICBpZiAoIXZlcmRpY3Qub2spIGJsb2NrZWQgPSB7IGNvZGU6IHZlcmRpY3QuY29kZSwgZGV0YWlsOiB2ZXJkaWN0LmRldGFpbCB9O1xuICAgIH0gZWxzZSBpZiAoc2VhdHMuYXZhaWxhYmxlIDwgMSkge1xuICAgICAgYmxvY2tlZCA9IHtcbiAgICAgICAgY29kZTogJ25vLXNlYXRzLWF2YWlsYWJsZScsXG4gICAgICAgIGRldGFpbDogYGVudGl0bGVtZW50ICR7ZW50LmVudGl0bGVtZW50SWR9IGhhcyAke3NlYXRzLnVzZWR9LyR7c2VhdHMuZ3JhbnRlZH0gc2VhdHMgaW4gdXNlYCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgZmluZGluZ3MucHVzaCh7XG4gICAgICBlbnRpdGxlbWVudElkOiBlbnQuZW50aXRsZW1lbnRJZCxcbiAgICAgIG9yZGVySWQ6IGVudC5vcmRlcklkLFxuICAgICAgcHJvZHVjdElkOiBlbnQucHJvZHVjdElkLFxuICAgICAgZW50aXRsZW1lbnRTdGF0ZTogZW50LnN0YXRlLFxuICAgICAgc2VhdHMsXG4gICAgICBpbnN0YWxsYXRpb25JZDogbWluZT8uaW5zdGFsbGF0aW9uSWQgPz8gbnVsbCxcbiAgICAgIGluc3RhbGxhdGlvblN0YXRlOiBtaW5lPy5zdGF0ZSA/PyBudWxsLFxuICAgICAgYmxvY2tlZCxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChmaW5kaW5ncy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgdXNlcklkLFxuICAgICAgYnV5ZXJJZCxcbiAgICAgIGludGVudCxcbiAgICAgIHByaW5jaXBhbCxcbiAgICAgIG9yZ1JvbGUsXG4gICAgICBlbnRpdGxlZCxcbiAgICAgIGZpbmRpbmdzOiBbXSxcbiAgICAgIGFueVBlcm1pdHRlZDogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHVzZXJJZCxcbiAgICBidXllcklkLFxuICAgIGludGVudCxcbiAgICBwcmluY2lwYWwsXG4gICAgb3JnUm9sZSxcbiAgICBlbnRpdGxlZCxcbiAgICBmaW5kaW5ncyxcbiAgICBhbnlQZXJtaXR0ZWQ6IGZpbmRpbmdzLnNvbWUoKGYpID0+IGYuYmxvY2tlZCA9PT0gbnVsbCksXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQXVkaXQgLyBleHBvcnQgZGFzaGJvYXJkXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBBdWRpdEludGVncml0eSB7XG4gIHJlYWRvbmx5IGFwcGxpZWRDb3VudDogbnVtYmVyO1xuICByZWFkb25seSBkdXBsaWNhdGVDb3VudDogbnVtYmVyO1xuICByZWFkb25seSByZWplY3RlZENvdW50OiBudW1iZXI7XG4gIC8qKiBFdmVyeSByZWplY3Rpb24sIGluIGZvbGQgb3JkZXIuIE5ldmVyIGVsaWRlZCDigJQgc2VlIHRoZSBtb2R1bGUgaGVhZGVyLiAqL1xuICByZWFkb25seSByZWplY3Rpb25zOiByZWFkb25seSBMZWRnZXJSZWplY3Rpb25bXTtcbiAgLyoqIFJlamVjdGlvbiBjb2RlcyBwcmVzZW50LCBzb3J0ZWQsIGZvciBhIG9uZS1nbGFuY2UgdHJpYWdlLiAqL1xuICByZWFkb25seSByZWplY3Rpb25Db2RlczogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXVkaXRQYXlvdXRSb3cge1xuICByZWFkb25seSBwYXlvdXRJZDogc3RyaW5nO1xuICByZWFkb25seSBjcmVhdG9ySWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgYW1vdW50TWlub3I6IG51bWJlcjtcbiAgcmVhZG9ubHkgY3VycmVuY3k6IHN0cmluZztcbiAgcmVhZG9ubHkgc3RhdGU6IFBheW91dFsnc3RhdGUnXTtcbiAgLyoqIFdoZXRoZXIgdGhlIGNyZWF0b3IgY291bGQgYWN0dWFsbHkgYmUgcGFpZCBhdCBleHBvcnQgdGltZS4gKi9cbiAgcmVhZG9ubHkgcGF5b3V0UmVhZHk6IGJvb2xlYW47XG4gIHJlYWRvbmx5IHBheW91dEJsb2NrQ29kZTogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBdWRpdEV4cG9ydCB7XG4gIHJlYWRvbmx5IHNjaGVtYTogJ2N1cGJvYXJkLmF1ZGl0LnYxJztcbiAgcmVhZG9ubHkgcHJvZHVjdHM6IHJlYWRvbmx5IFByb2R1Y3RbXTtcbiAgcmVhZG9ubHkgb2ZmZXJzOiByZWFkb25seSBPZmZlcltdO1xuICByZWFkb25seSBvcmRlcnM6IHJlYWRvbmx5IE9yZGVyW107XG4gIHJlYWRvbmx5IGVudGl0bGVtZW50czogcmVhZG9ubHkgRW50aXRsZW1lbnRbXTtcbiAgcmVhZG9ubHkgcmVmdW5kczogcmVhZG9ubHkgUmVmdW5kW107XG4gIHJlYWRvbmx5IHBheW91dHM6IHJlYWRvbmx5IEF1ZGl0UGF5b3V0Um93W107XG4gIHJlYWRvbmx5IGluc3RhbGxhdGlvbnM6IHJlYWRvbmx5IEluc3RhbGxhdGlvbltdO1xuICByZWFkb25seSBvcmdhbml6YXRpb25zOiByZWFkb25seSB7IHJlYWRvbmx5IG9yZ0lkOiBzdHJpbmc7IHJlYWRvbmx5IG1lbWJlckNvdW50OiBudW1iZXIgfVtdO1xuICByZWFkb25seSBpbnRlZ3JpdHk6IEF1ZGl0SW50ZWdyaXR5O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEF1ZGl0RXhwb3J0SW5wdXQge1xuICByZWFkb25seSBsZWRnZXI6IExlZGdlclN0YXRlO1xuICByZWFkb25seSBpbnN0YWxsYXRpb25zOiByZWFkb25seSBJbnN0YWxsYXRpb25bXTtcbiAgcmVhZG9ubHkgb3JnczogUmVhZG9ubHlNYXA8c3RyaW5nLCBPcmdhbml6YXRpb24+O1xuICByZWFkb25seSBjcmVhdG9yUHJvZmlsZXM6IFJlYWRvbmx5TWFwPHN0cmluZywgQ3JlYXRvclByb2ZpbGU+O1xufVxuXG4vKipcbiAqIEEgZGV0ZXJtaW5pc3RpYywgcmVwcm9kdWNpYmxlIGV4cG9ydCBvZiBsZWRnZXIgKyBhY2NvdW50cyBzdGF0ZS5cbiAqXG4gKiBFdmVyeSBjb2xsZWN0aW9uIGlzIHNvcnRlZCBieSBpdHMgb3duIGlkLCBzbyB0aGUgc2FtZSBzdGF0ZSBleHBvcnRzIHRoZSBzYW1lXG4gKiBieXRlcyByZWdhcmRsZXNzIG9mIGluc2VydGlvbiBvcmRlciDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0cyB0d28gZXhwb3J0c1xuICogdGFrZW4gZnJvbSBkaWZmZXJlbnQgcmVwbGljYXMgYmUgY29tcGFyZWQgZGlyZWN0bHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhdWRpdEV4cG9ydChpbnB1dDogQXVkaXRFeHBvcnRJbnB1dCk6IEF1ZGl0RXhwb3J0IHtcbiAgY29uc3QgeyBsZWRnZXIsIGluc3RhbGxhdGlvbnMsIG9yZ3MsIGNyZWF0b3JQcm9maWxlcyB9ID0gaW5wdXQ7XG5cbiAgY29uc3QgcGF5b3V0czogQXVkaXRQYXlvdXRSb3dbXSA9IHNvcnRlZEJ5SWQobGVkZ2VyLnBheW91dHMudmFsdWVzKCksIChwKSA9PiBwLnBheW91dElkKS5tYXAoKHApID0+IHtcbiAgICBjb25zdCByZWFkaW5lc3M6IFBheW91dFJlYWRpbmVzcyA9IHBheW91dFJlYWRpbmVzcyhwLmNyZWF0b3JJZCwgY3JlYXRvclByb2ZpbGVzKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF5b3V0SWQ6IHAucGF5b3V0SWQsXG4gICAgICBjcmVhdG9ySWQ6IHAuY3JlYXRvcklkLFxuICAgICAgYW1vdW50TWlub3I6IHAuYW1vdW50LmFtb3VudE1pbm9yLFxuICAgICAgY3VycmVuY3k6IHAuYW1vdW50LmN1cnJlbmN5LFxuICAgICAgc3RhdGU6IHAuc3RhdGUsXG4gICAgICBwYXlvdXRSZWFkeTogcmVhZGluZXNzLm9rLFxuICAgICAgcGF5b3V0QmxvY2tDb2RlOiByZWFkaW5lc3Mub2sgPyBudWxsIDogcmVhZGluZXNzLmNvZGUsXG4gICAgfTtcbiAgfSk7XG5cbiAgY29uc3QgcmVqZWN0aW9uQ29kZXMgPSBbLi4ubmV3IFNldChsZWRnZXIucmVqZWN0ZWQubWFwKChyKSA9PiByLmNvZGUpKV0uc29ydCgpO1xuXG4gIHJldHVybiB7XG4gICAgc2NoZW1hOiAnY3VwYm9hcmQuYXVkaXQudjEnLFxuICAgIHByb2R1Y3RzOiBzb3J0ZWRCeUlkKGxlZGdlci5wcm9kdWN0cy52YWx1ZXMoKSwgKHApID0+IHAucHJvZHVjdElkKSxcbiAgICBvZmZlcnM6IHNvcnRlZEJ5SWQobGVkZ2VyLm9mZmVycy52YWx1ZXMoKSwgKG8pID0+IG8ub2ZmZXJJZCksXG4gICAgb3JkZXJzOiBzb3J0ZWRCeUlkKGxlZGdlci5vcmRlcnMudmFsdWVzKCksIChvKSA9PiBvLm9yZGVySWQpLFxuICAgIGVudGl0bGVtZW50czogc29ydGVkQnlJZChsZWRnZXIuZW50aXRsZW1lbnRzLnZhbHVlcygpLCAoZSkgPT4gZS5lbnRpdGxlbWVudElkKSxcbiAgICByZWZ1bmRzOiBzb3J0ZWRCeUlkKGxlZGdlci5yZWZ1bmRzLnZhbHVlcygpLCAocikgPT4gci5yZWZ1bmRJZCksXG4gICAgcGF5b3V0cyxcbiAgICBpbnN0YWxsYXRpb25zOiBbLi4uaW5zdGFsbGF0aW9uc10uc29ydCgoYSwgYikgPT5cbiAgICAgIGEuaW5zdGFsbGF0aW9uSWQgPCBiLmluc3RhbGxhdGlvbklkID8gLTEgOiBhLmluc3RhbGxhdGlvbklkID4gYi5pbnN0YWxsYXRpb25JZCA/IDEgOiAwLFxuICAgICksXG4gICAgb3JnYW5pemF0aW9uczogWy4uLm9yZ3MudmFsdWVzKCldXG4gICAgICAubWFwKChvKSA9PiAoeyBvcmdJZDogby5vcmdJZCwgbWVtYmVyQ291bnQ6IG8ubWVtYmVyc2hpcHMubGVuZ3RoIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IChhLm9yZ0lkIDwgYi5vcmdJZCA/IC0xIDogYS5vcmdJZCA+IGIub3JnSWQgPyAxIDogMCkpLFxuICAgIGludGVncml0eToge1xuICAgICAgYXBwbGllZENvdW50OiBsZWRnZXIuYXBwbGllZC5sZW5ndGgsXG4gICAgICBkdXBsaWNhdGVDb3VudDogbGVkZ2VyLmR1cGxpY2F0ZXMubGVuZ3RoLFxuICAgICAgcmVqZWN0ZWRDb3VudDogbGVkZ2VyLnJlamVjdGVkLmxlbmd0aCxcbiAgICAgIHJlamVjdGlvbnM6IFsuLi5sZWRnZXIucmVqZWN0ZWRdLFxuICAgICAgcmVqZWN0aW9uQ29kZXMsXG4gICAgfSxcbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHNvcnRlZEJ5SWQ8VD4odmFsdWVzOiBJdGVyYWJsZTxUPiwga2V5OiAodmFsdWU6IFQpID0+IHN0cmluZyk6IFRbXSB7XG4gIHJldHVybiBbLi4udmFsdWVzXS5zb3J0KChhLCBiKSA9PiB7XG4gICAgY29uc3Qga2EgPSBrZXkoYSk7XG4gICAgY29uc3Qga2IgPSBrZXkoYik7XG4gICAgcmV0dXJuIGthIDwga2IgPyAtMSA6IGthID4ga2IgPyAxIDogMDtcbiAgfSk7XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL2NvbW1lcmNlLWRhc2hib2FyZHMudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvY29tbWVyY2UtZGFzaGJvYXJkcy50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL2NvbW1lcmNlLWRhc2hib2FyZHMudHMiLFtdXQ==