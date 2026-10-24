'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("meteredUsageRoute", () => { try { return meteredUsageRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/metered-invocation.ts", {"importedNames":["acceptMeteredVoucher","closeMeteredInvocation","declareMeter","verifySellerReceiptAuthority","verifyUsageReceiptSignature"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/microcharge.ts", {"importedNames":["paymentVoucherDigest","unsignedVoucher","verifyPaymentVoucherSignature"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/identity-per-use-offer.ts", {"importedNames":["quoteIdentityInferenceTurn"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/commerce-dashboards.ts", {"importedNames":["identityUsageStatement"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/src/commerce-store.ts", {"importedNames":["getCommerceOffer"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/src/payment-channel-store.ts", {"importedNames":["getPaymentChannel"]});
const __vite_ssr_import_8__ = await __vite_ssr_import__("/src/usage-receipt-store.ts", {"importedNames":["getUsageReceipt","listChannelUsageReceipts","listPrincipalUsageReceipts","loadMicrochargeChannel","reserveUsageReceipt","readIdentityMarkupRemainder","settleUsageReceipt"]});









async function authenticate(request) {
  try {
    const user = await (0,__vite_ssr_import_5__.resolveGithubBearer)(request);
    return { ok: true, principalId: `gh:${user.id}` };
  } catch (error) {
    if (error instanceof __vite_ssr_import_5__.AuthError) return { ok: false, reason: error.reason };
    throw error;
  }
}
async function jsonObject(request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function statusFor(code) {
  if (code === "cap-exhausted") return 402;
  if (code === "duplicate-nonce" || code === "cumulative-regression") return 409;
  return 422;
}
function bigintFrom(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function voucherFromReceipt(receipt) {
  return {
    channelId: receipt.channelId,
    payer: receipt.payer,
    seller: receipt.seller,
    releaseRef: receipt.releaseRef,
    usageNonce: receipt.usageNonce,
    meterQuantity: BigInt(receipt.reservedMeterQuantity),
    pricePerUnitMicros: BigInt(receipt.unitPriceMicros),
    priceVersion: receipt.priceVersion,
    splitManifestHash: receipt.splitManifestHash,
    expiresAtMs: receipt.expiresAtMs,
    cumulativeClaimMicros: BigInt(receipt.cumulativeClaimMicros),
    signature: receipt.voucherSignature
  };
}
function receiptJson(receipt) {
  return {
    channelId: receipt.channelId,
    usageNonce: receipt.usageNonce,
    offerId: receipt.offerId,
    payer: receipt.payer,
    seller: receipt.seller,
    releaseRef: receipt.releaseRef,
    meterUnit: receipt.meterUnit,
    meterQuantity: String(receipt.meterQuantity),
    unitPriceMicros: String(receipt.unitPriceMicros),
    priceVersion: receipt.priceVersion,
    splitManifestHash: receipt.splitManifestHash,
    reservedMicros: String(receipt.reservedMicros),
    amountMicros: receipt.amountMicros == null ? null : String(receipt.amountMicros),
    cumulativeClaimMicros: String(receipt.cumulativeClaimMicros),
    // Both are exposed so the SELLER can re-derive the exact bytes the payer
    // signed and settle against them. The voucher signature is the payer's
    // payment instrument, not a secret: a seller that cannot present it cannot
    // claim the money. The read is already restricted to the funding principal
    // and the sellers named on the channel's own receipts.
    expiresAtMs: receipt.expiresAtMs,
    voucherDigest: receipt.voucherDigest,
    voucherSignature: receipt.voucherSignature,
    receiptSignature: receipt.receiptSignature,
    sellerPubkeyBase64: receipt.sellerPubkeyBase64 ?? null,
    state: receipt.state,
    reservedAtMs: receipt.reservedAtMs,
    settledAtMs: receipt.settledAtMs,
    ...receipt.identityInference ? { identityInference: {
      ceilingMicros: String(receipt.identityInference.ceilingMicros),
      billedInferenceMicros: receipt.identityInference.billedInferenceMicros === null ? null : String(receipt.identityInference.billedInferenceMicros),
      priorRemainderNumerator: receipt.identityInference.priorRemainderNumerator === null ? null : String(receipt.identityInference.priorRemainderNumerator),
      remainderNumerator: receipt.identityInference.remainderNumerator === null ? null : String(receipt.identityInference.remainderNumerator)
    } } : {}
  };
}
function meteredUsageRoute() {
  const route = new __vite_ssr_import_0__.Hono();
  route.get("/commerce/metered-invocations", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const limitText = c.req.query("limit") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 200) {
      return c.json({ error: "invalid_usage_limit", detail: "limit must be an integer from 1 to 200" }, 400);
    };
    const cursor = c.req.query("cursor");
    let after;
    if (cursor !== void 0) {
      try {
        if (cursor.length > 2e3) throw new Error("oversized cursor");
        const parsed = JSON.parse(cursor);
        if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((value) => typeof value === "string" && value.length > 0 && value.length <= 300 && value.trim() === value)) {
          throw new Error("invalid cursor");
        };
        after = { channelId: parsed[0], usageNonce: parsed[1] };
      } catch {
        return c.json({ error: "invalid_usage_cursor" }, 400);
      }
    };
    const page = await (0,__vite_ssr_import_8__.listPrincipalUsageReceipts)(c.env.DB, auth.principalId, Number(limitText), after);
    const receipts = page.receipts.map(receiptJson);
    return c.json({
      receipts,
      identityStatement: (0,__vite_ssr_import_4__.identityUsageStatement)(receipts, auth.principalId),
      nextCursor: page.next ? JSON.stringify([page.next.channelId, page.next.usageNonce]) : null,
      coverage: {
        scope: "authenticated-principal",
        population: "live-page",
        totals: "page",
        hasMore: page.next !== null
      }
    });
  });
  route.post("/commerce/metered-invocations", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const body = await jsonObject(c.req.raw);
    const wire = body?.voucher;
    if (!body || !nonEmpty(body.channelId) || !nonEmpty(body.offerId) || !wire || typeof wire !== "object" || Array.isArray(wire)) {
      return c.json({ error: "invalid_request", detail: "channelId, offerId and a signed voucher object are required" }, 400);
    };
    const v = wire;
    const meterQuantity = bigintFrom(v.meterQuantity);
    const pricePerUnitMicros = bigintFrom(v.pricePerUnitMicros);
    const cumulativeClaimMicros = bigintFrom(v.cumulativeClaimMicros);
    if (!nonEmpty(v.payer) || !nonEmpty(v.seller) || !nonEmpty(v.releaseRef) || !nonEmpty(v.usageNonce) || !nonEmpty(v.priceVersion) || !nonEmpty(v.splitManifestHash) || !nonEmpty(v.signature) || meterQuantity == null || pricePerUnitMicros == null || cumulativeClaimMicros == null || !Number.isSafeInteger(v.expiresAtMs)) {
      return c.json(
        {
          error: "invalid_voucher",
          detail: "the voucher must carry payer, seller, releaseRef, usageNonce, meterQuantity, pricePerUnitMicros, priceVersion, splitManifestHash, expiresAtMs, cumulativeClaimMicros and signature"
        },
        400
      );
    };
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, body.channelId);
    if (!channel) return c.json({ error: "unknown_channel", detail: `payment channel ${body.channelId} does not exist` }, 404);
    if (channel.principalId !== auth.principalId) {
      return c.json({ error: "forbidden", detail: "only the funding principal can meter against this channel" }, 403);
    };
    if (channel.state !== "open") {
      return c.json({ error: "channel_not_open", detail: `payment channel is '${channel.state}'` }, 409);
    };
    const offer = await (0,__vite_ssr_import_6__.getCommerceOffer)(c.env.DB, body.offerId);
    if (!offer) return c.json({ error: "unknown_offer", detail: `offer ${body.offerId} is not in the catalog` }, 404);
    if (!offer.active || !offer.productActive) return c.json({ error: "inactive_offer", detail: `offer ${body.offerId} is inactive` }, 422);
    if (offer.pricingModel !== "per-use" || !offer.perUse) {
      return c.json({ error: "not_metered", detail: `offer ${body.offerId} is not a per-use offer` }, 422);
    };
    const declared = (0,__vite_ssr_import_1__.declareMeter)(offer.perUse);
    if (!declared.ok) return c.json({ error: declared.code, detail: declared.detail }, 422);
    const identityCeiling = bigintFrom(body.identityInferenceCeilingMicros);
    const isIdentity = offer.skuRef.startsWith("identity-release:");
    if (isIdentity) {
      const q = (0,__vite_ssr_import_3__.quoteIdentityInferenceTurn)({
        offer: { skuRef: offer.skuRef, ...offer.perUse },
        billedInferenceMicros: 0n,
        inferenceCeilingMicros: identityCeiling ?? 0n
      });
      if (!q.ok || q.reservationQuantity !== meterQuantity) {
        return c.json({ error: "identity-ceiling-mismatch", detail: "identity reserve requires its exact positive inference ceiling and matching block quantity" }, 422);
      }
    } else if (body.identityInferenceCeilingMicros !== void 0) {
      return c.json({ error: "identity-ceiling-mismatch", detail: "only identity offers accept inference ceilings" }, 422);
    };
    const unit = {
      payer: channel.principalId,
      seller: offer.creatorId,
      releaseRef: offer.skuRef,
      usageNonce: v.usageNonce,
      quantity: meterQuantity,
      expiresAtMs: Number(v.expiresAtMs)
    };
    const voucher = {
      channelId: body.channelId,
      payer: v.payer,
      seller: v.seller,
      releaseRef: v.releaseRef,
      usageNonce: v.usageNonce,
      meterQuantity,
      pricePerUnitMicros,
      priceVersion: v.priceVersion,
      splitManifestHash: v.splitManifestHash,
      expiresAtMs: Number(v.expiresAtMs),
      cumulativeClaimMicros,
      signature: v.signature
    };
    const durable = await (0,__vite_ssr_import_8__.loadMicrochargeChannel)(c.env.DB, channel);
    const accepted = (0,__vite_ssr_import_1__.acceptMeteredVoucher)({
      channel: durable,
      meter: declared.meter,
      unit,
      voucher,
      nowMs: Date.now(),
      verifySignature: (candidate) => (0,__vite_ssr_import_2__.verifyPaymentVoucherSignature)(candidate, {
        channelId: channel.channelId,
        payer: channel.principalId,
        pubkeyBase64: channel.payerPubkeyBase64 ?? ""
      })
    });
    if (!accepted.ok) return c.json({ error: accepted.code, detail: accepted.detail }, statusFor(accepted.code));
    if (!offer.receiptAuthority || !(0,__vite_ssr_import_1__.verifySellerReceiptAuthority)({
      seller: offer.creatorId,
      offerId: offer.offerId,
      productId: offer.productId,
      skuRef: offer.skuRef
    }, offer.receiptAuthority)) {
      return c.json({ error: "seller-authority-required", detail: "publish an authenticated seller receipt key before reserving usage" }, 422);
    };
    const stored = await (0,__vite_ssr_import_8__.reserveUsageReceipt)(c.env.DB, {
      channelId: channel.channelId,
      usageNonce: voucher.usageNonce,
      principalId: auth.principalId,
      offerId: offer.offerId,
      payer: voucher.payer,
      seller: voucher.seller,
      releaseRef: voucher.releaseRef,
      meterUnit: declared.meter.meterUnit,
      meterQuantity: voucher.meterQuantity,
      unitPriceMicros: voucher.pricePerUnitMicros,
      priceVersion: voucher.priceVersion,
      splitManifestHash: voucher.splitManifestHash,
      reservedMicros: accepted.reservedMicros,
      cumulativeClaimMicros: voucher.cumulativeClaimMicros,
      expiresAtMs: voucher.expiresAtMs,
      voucherDigest: (0,__vite_ssr_import_2__.paymentVoucherDigest)((0,__vite_ssr_import_2__.unsignedVoucher)(voucher)),
      voucherSignature: voucher.signature,
      sellerPubkeyBase64: offer.receiptAuthority.pubkeyBase64,
      nowMs: Date.now(),
      ...isIdentity ? { identityInferenceCeilingMicros: identityCeiling } : {}
    });
    if (!stored.ok) {
      return c.json({ error: stored.code, detail: "the durable usage ledger refused admission" }, stored.code === "cap-exhausted" ? 402 : 409);
    };
    return c.json({ reserved: true, receipt: receiptJson(stored.receipt) }, 201);
  });
  route.post("/commerce/metered-invocations/:usageNonce/settle", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const usageNonce = c.req.param("usageNonce");
    const body = await jsonObject(c.req.raw);
    if (!body || !nonEmpty(body.channelId) || !nonEmpty(body.receiptSignature)) {
      return c.json({ error: "invalid_request", detail: "channelId and receiptSignature are required" }, 400);
    };
    const actualQuantity = body.actualQuantity === void 0 ? null : bigintFrom(body.actualQuantity);
    if (body.actualQuantity !== void 0 && actualQuantity == null) {
      return c.json({ error: "invalid_request", detail: "actualQuantity must be an integer" }, 400);
    };
    const reserved = await (0,__vite_ssr_import_8__.getUsageReceipt)(c.env.DB, body.channelId, usageNonce);
    if (!reserved) {
      return c.json({ error: "unknown-reservation", detail: `no reservation for usage nonce '${usageNonce}'` }, 404);
    };
    if (reserved.seller !== auth.principalId) {
      return c.json({ error: "forbidden", detail: "only the seller named on the reservation can settle it" }, 403);
    };
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, body.channelId);
    if (!channel) return c.json({ error: "unknown_channel", detail: `payment channel ${body.channelId} does not exist` }, 404);
    const occurredAtMs = body.occurredAtMs === void 0 && !reserved.identityInference ? Date.now() : body.occurredAtMs;
    if (typeof occurredAtMs !== "number" || !Number.isSafeInteger(occurredAtMs) || occurredAtMs < reserved.reservedAtMs || occurredAtMs > Date.now()) {
      return c.json({ error: "invalid_request", detail: "a signed completion timestamp between admission and now is required" }, 400);
    };
    let identityInference;
    let exact;
    if (reserved.releaseRef.startsWith("identity-release:")) {
      const billed = bigintFrom(body.billedInferenceMicros), prior = bigintFrom(body.priorRemainderNumerator);
      if (!reserved.identityInference || billed === null || prior === null || actualQuantity != null) {
        return c.json({ error: "identity-settlement-mismatch", detail: "exact billed cost and prior remainder are required for an admitted identity turn" }, 422);
      };
      const authoritativePrior = reserved.state === "settled" ? BigInt(reserved.identityInference.priorRemainderNumerator) : await (0,__vite_ssr_import_8__.readIdentityMarkupRemainder)(c.env.DB, reserved.payer, reserved.offerId);
      if (prior !== authoritativePrior) return c.json({ error: "identity-remainder-mismatch", detail: "prior remainder differs from hosted history" }, 409);
      identityInference = {
        offer: {
          skuRef: reserved.releaseRef,
          meterUnit: reserved.meterUnit,
          unitPriceMicros: reserved.unitPriceMicros,
          priceVersion: reserved.priceVersion,
          splitManifestHash: reserved.splitManifestHash
        },
        billedInferenceMicros: billed,
        inferenceCeilingMicros: BigInt(reserved.identityInference.ceilingMicros),
        priorRemainderNumerator: prior
      };
      const q = (0,__vite_ssr_import_3__.quoteIdentityInferenceTurn)(identityInference);
      if (!q.ok) return c.json({ error: q.code, detail: q.detail }, 422);
      exact = { billedInferenceMicros: billed, priorRemainderNumerator: prior, remainderNumerator: q.remainderNumerator };
    } else if (body.billedInferenceMicros !== void 0 || body.priorRemainderNumerator !== void 0) {
      return c.json({ error: "identity-settlement-mismatch", detail: "ordinary units cannot override their published price" }, 422);
    };
    const durable = await (0,__vite_ssr_import_8__.loadMicrochargeChannel)(c.env.DB, channel);
    const closureChannel = reserved.state === "settled" ? {
      ...durable,
      reservations: { ...durable.reservations, [usageNonce]: BigInt(reserved.reservedMicros) }
    } : durable;
    const closed = (0,__vite_ssr_import_1__.closeMeteredInvocation)({
      channel: closureChannel,
      voucher: voucherFromReceipt(reserved),
      ...actualQuantity != null ? { actualQuantity } : {},
      occurredAtMs,
      ...identityInference ? { identityInference } : {},
      signReceipt: () => body.receiptSignature
    });
    if (!closed.ok) return c.json({ error: closed.code, detail: closed.detail }, statusFor(closed.code));
    if (!reserved.sellerPubkeyBase64 || !(0,__vite_ssr_import_1__.verifyUsageReceiptSignature)(closed.receipt, reserved.sellerPubkeyBase64)) {
      return c.json({ error: "invalid-receipt-signature", detail: "the original seller key must sign the exact usage receipt" }, 422);
    };
    const persisted = await (0,__vite_ssr_import_8__.settleUsageReceipt)(c.env.DB, {
      channelId: channel.channelId,
      usageNonce,
      amountMicros: closed.amountMicros,
      meterQuantity: closed.receipt.meterQuantity,
      receiptSignature: closed.receipt.signature,
      nowMs: occurredAtMs,
      ...exact ? { identityInference: exact } : {}
    });
    if (!persisted.ok) {
      return c.json(
        { error: persisted.code, detail: persisted.detail },
        persisted.code === "cap-exhausted" ? 402 : persisted.code === "already-settled" ? 409 : persisted.code === "unknown-reservation" ? 404 : 422
      );
    };
    return c.json({ settled: true, receipt: receiptJson(persisted.receipt) });
  });
  route.get("/commerce/payment-channels/:channelId/usage", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!channel) return c.json({ error: "unknown_channel", detail: `payment channel ${channelId} does not exist` }, 404);
    const receipts = await (0,__vite_ssr_import_8__.listChannelUsageReceipts)(c.env.DB, channelId);
    const isSeller = receipts.some((r) => r.seller === auth.principalId);
    if (channel.principalId !== auth.principalId && !isSeller) {
      return c.json({ error: "forbidden", detail: "only the funding principal or a named seller can read this usage" }, 403);
    };
    const visible = channel.principalId === auth.principalId ? receipts : receipts.filter((r) => r.seller === auth.principalId);
    const identityOfferId = c.req.query("identityOfferId");
    let identityMarkupOrigin;
    if (identityOfferId !== void 0) {
      const offered = await (0,__vite_ssr_import_6__.getCommerceOffer)(c.env.DB, identityOfferId);
      if (!offered || !offered.perUse || !offered.skuRef.startsWith("identity-release:")) {
        return c.json({ error: "unknown_identity_offer" }, 404);
      };
      if (!offered.active || !offered.productActive) return c.json({ error: "inactive_offer" }, 422);
      if (channel.principalId !== auth.principalId && !visible.some((r) => r.offerId === identityOfferId)) {
        return c.json({ error: "forbidden" }, 403);
      };
      const offer = { skuRef: offered.skuRef, ...offered.perUse };
      const valid = (0,__vite_ssr_import_3__.quoteIdentityInferenceTurn)({ offer, billedInferenceMicros: 0n, inferenceCeilingMicros: 1n });
      if (!valid.ok) return c.json({ error: valid.code }, 422);
      try {
        identityMarkupOrigin = {
          offerId: identityOfferId,
          payer: channel.principalId,
          seller: offered.creatorId,
          offer,
          remainderNumerator: String(await (0,__vite_ssr_import_8__.readIdentityMarkupRemainder)(c.env.DB, channel.principalId, identityOfferId))
        };
      } catch {
        return c.json({ error: "identity-history-unverifiable" }, 422);
      }
    };
    const renderedReceipts = visible.map(receiptJson);
    return c.json({
      channelId,
      escrowMicros: String(channel.escrowMicros),
      committedMicros: String(channel.committedMicros),
      receipts: renderedReceipts,
      identityStatement: (0,__vite_ssr_import_4__.identityUsageStatement)(renderedReceipts, auth.principalId),
      ...identityMarkupOrigin ? { identityMarkupOrigin } : {}
    });
  });
  return route;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFRLEVBQUUsUUFBUSxRQUFRLFFBQVEsR0FBRyxRQUFRLE9BQU87QUFDMUQsWUFBTSxXQUFRLGtEQUEyQixFQUFFLE9BQU8sdUJBQXVCLElBQUksd0JBQXdCLEdBQUcsQ0FBQztBQUN6RyxVQUFJLENBQUMsTUFBTSxHQUFJLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxNQUFNLEtBQUssR0FBRyxHQUFHO0FBQ3ZELFVBQUk7QUFDRiwrQkFBdUI7QUFBQSxVQUFFLFNBQVM7QUFBQSxVQUFpQixPQUFPLFFBQVE7QUFBQSxVQUFhLFFBQVEsUUFBUTtBQUFBLFVBQzdGO0FBQUEsVUFBTyxvQkFBb0IsT0FBTyxTQUFNLG1EQUE0QixFQUFFLElBQUksSUFBSSxRQUFRLGFBQWEsZUFBZSxDQUFDO0FBQUEsUUFBRTtBQUFBLE1BQ3pILFFBQVE7QUFDTixlQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sZ0NBQWdDLEdBQUcsR0FBRztBQUFBLE1BQy9EO0FBQUEsSUFDRjtBQUNBLFVBQU0sbUJBQW1CLFFBQVEsSUFBSSxXQUFXO0FBQ2hELFdBQU8sRUFBRSxLQUFLO0FBQUEsTUFDWjtBQUFBLE1BQ0EsY0FBYyxPQUFPLFFBQVEsWUFBWTtBQUFBLE1BQ3pDLGlCQUFpQixPQUFPLFFBQVEsZUFBZTtBQUFBLE1BQy9DLFVBQVU7QUFBQSxNQUNWLHNCQUFtQiw4Q0FBdUIsa0JBQWtCLEtBQUssV0FBVztBQUFBLE1BQzVFLEdBQUksdUJBQXVCLEVBQUUscUJBQXFCLElBQUksQ0FBQztBQUFBLElBQ3pELENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxTQUFPO0FBQ1QiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbIm1ldGVyZWQtdXNhZ2UudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBIb3N0ZWQgcHJvZHVjdGlvbiBkb29yIGZvciB0aGUgUC0wMzEgbWV0ZXJpbmcgaW50ZXJjZXB0aW9uLlxuICpcbiAqIEV2ZXJ5IGJpbGxhYmxlIHVuaXQgb2YgYSBwZXItdXNlIEN1cGJvYXJkIGl0ZW0gcGFzc2VzIHRocm91Z2ggaGVyZSBUV0lDRTpcbiAqIG9uY2UgdG8gUkVTRVJWRSB0aGUgcGF5ZXIncyBjdW11bGF0aXZlIHZvdWNoZXIgYmVmb3JlIHRoZSBzZWxsZXIgZXhlY3V0ZXMgaXQsXG4gKiBvbmNlIHRvIFNFVFRMRSB0aGUgdW5pdHMgYWN0dWFsbHkgc2VydmVkIGludG8gYSBzaWduZWQgdXNhZ2UgcmVjZWlwdC4gVGhlXG4gKiBkZWNpc2lvbiBpdHNlbGYgaXMgYHAycC9tZXRlcmVkLWludm9jYXRpb24udHNgIChwdXJlKTsgdGhpcyByb3V0ZSBzdXBwbGllc1xuICogaWRlbnRpdHksIHRoZSBsZWRnZXIncyBkZWNsYXJlZCB0ZXJtcywgYW5kIHRoZSBkdXJhYmxlIGNoYW5uZWwgc3RhdGUsIHRoZW5cbiAqIHBlcnNpc3RzIHRoZSBvdXRjb21lLlxuICpcbiAqIEQtMDU1OiBjb21tZXJjZSBmYWN0cyBpbiB2MSBsaXZlIGJlaGluZCB0aGlzIFdvcmtlciBwbHVzIHRoZSBjaGFpbiwgc28gdGhlXG4gKiBzaWduZWQgdm91Y2hlciBhbmQgdGhlIHNpZ25lZCByZWNlaXB0IGFyZSBTVE9SRUQgaGVyZSDigJQgdGhlIFdvcmtlciBob2xkcyBub1xuICogc2lnbmluZyBrZXkgYW5kIGNhbiB0aGVyZWZvcmUgc3RvcmUgdGhlc2UgZmFjdHMgd2l0aG91dCBiZWluZyBhYmxlIHRvIGZvcmdlXG4gKiB0aGVtLlxuICpcbiAqIEZhaWwgY2xvc2VkIG9uIGlkZW50aXR5OiB0aGUgYnV5ZXIgdGhhdCBmdW5kZWQgdGhlIGNoYW5uZWwgaXMgdGhlIG9ubHkgcGFydHlcbiAqIHRoYXQgY2FuIHJlc2VydmUgYWdhaW5zdCBpdCwgYW5kIHRoZSBzZWxsZXIgbmFtZWQgb24gdGhlIHJlc2VydmF0aW9uIGlzIHRoZVxuICogb25seSBwYXJ0eSB0aGF0IGNhbiBzZXR0bGUgaXQuIE5laXRoZXIgaXMgdGFrZW4gZnJvbSB0aGUgcmVxdWVzdCBib2R5LlxuICovXG5pbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQgdHlwZSB7IENvbnRlbnRmdWxTdGF0dXNDb2RlIH0gZnJvbSAnaG9uby91dGlscy9odHRwLXN0YXR1cyc7XG5pbXBvcnQge1xuICBhY2NlcHRNZXRlcmVkVm91Y2hlcixcbiAgY2xvc2VNZXRlcmVkSW52b2NhdGlvbixcbiAgZGVjbGFyZU1ldGVyLFxuICB2ZXJpZnlTZWxsZXJSZWNlaXB0QXV0aG9yaXR5LFxuICB2ZXJpZnlVc2FnZVJlY2VpcHRTaWduYXR1cmUsXG4gIHR5cGUgQmlsbGFibGVVbml0LFxuICB0eXBlIE1ldGVyZWRSZWZ1c2FsQ29kZSxcbn0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvbWV0ZXJlZC1pbnZvY2F0aW9uLnRzJztcbmltcG9ydCB0eXBlIHsgQ3VtdWxhdGl2ZVBheW1lbnRWb3VjaGVyIH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvbWljcm9jaGFyZ2UudHMnO1xuaW1wb3J0IHsgcGF5bWVudFZvdWNoZXJEaWdlc3QsIHVuc2lnbmVkVm91Y2hlciwgdmVyaWZ5UGF5bWVudFZvdWNoZXJTaWduYXR1cmUgfSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL3AycC9taWNyb2NoYXJnZS50cyc7XG5pbXBvcnQgeyBxdW90ZUlkZW50aXR5SW5mZXJlbmNlVHVybiB9IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvaWRlbnRpdHktcGVyLXVzZS1vZmZlcic7XG5pbXBvcnQgeyBpZGVudGl0eVVzYWdlU3RhdGVtZW50IH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9jb21tZXJjZS1kYXNoYm9hcmRzJztcbmltcG9ydCB0eXBlIHsgRW52IH0gZnJvbSAnLi4vZW52LnRzJztcbmltcG9ydCB7IEF1dGhFcnJvciwgcmVzb2x2ZUdpdGh1YkJlYXJlciB9IGZyb20gJy4uL2F1dGgudHMnO1xuaW1wb3J0IHsgZ2V0Q29tbWVyY2VPZmZlciB9IGZyb20gJy4uL2NvbW1lcmNlLXN0b3JlLnRzJztcbmltcG9ydCB7IGdldFBheW1lbnRDaGFubmVsIH0gZnJvbSAnLi4vcGF5bWVudC1jaGFubmVsLXN0b3JlLnRzJztcbmltcG9ydCB7XG4gIGdldFVzYWdlUmVjZWlwdCxcbiAgbGlzdENoYW5uZWxVc2FnZVJlY2VpcHRzLFxuICBsaXN0UHJpbmNpcGFsVXNhZ2VSZWNlaXB0cyxcbiAgbG9hZE1pY3JvY2hhcmdlQ2hhbm5lbCxcbiAgcmVzZXJ2ZVVzYWdlUmVjZWlwdCxcbiAgcmVhZElkZW50aXR5TWFya3VwUmVtYWluZGVyLFxuICBzZXR0bGVVc2FnZVJlY2VpcHQsXG4gIHR5cGUgU3RvcmVkVXNhZ2VSZWNlaXB0LFxufSBmcm9tICcuLi91c2FnZS1yZWNlaXB0LXN0b3JlLnRzJztcblxuLyoqXG4gKiBIb25vIG93bnMgdGhpcyB0eXBlOyBkZXJpdmluZyBpdCBmcm9tIHRoZSByb3V0ZXIncyBvd24gb3ZlcmxvYWRzIHJlc29sdmVkIHRvXG4gKiBgbmV2ZXJgIGFuZCBtYWRlIGV2ZXJ5IHJlZnVzYWwgc3RhdHVzIGJlbG93IHVuYXNzaWduYWJsZS5cbiAqL1xudHlwZSBSZWZ1c2FsU3RhdHVzQ29kZSA9IEV4dHJhY3Q8Q29udGVudGZ1bFN0YXR1c0NvZGUsIDQwMCB8IDQwMSB8IDQwMiB8IDQwMyB8IDQwNCB8IDQwOSB8IDQyMj47XG5cbmFzeW5jIGZ1bmN0aW9uIGF1dGhlbnRpY2F0ZShcbiAgcmVxdWVzdDogUmVxdWVzdCxcbik6IFByb21pc2U8eyBvazogdHJ1ZTsgcHJpbmNpcGFsSWQ6IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IHJlYXNvbjogQXV0aEVycm9yWydyZWFzb24nXSB9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIocmVxdWVzdCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHByaW5jaXBhbElkOiBgZ2g6JHt1c2VyLmlkfWAgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBlcnJvci5yZWFzb24gfTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBqc29uT2JqZWN0KHJlcXVlc3Q6IFJlcXVlc3QpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHZhbHVlOiB1bmtub3duID0gYXdhaXQgcmVxdWVzdC5qc29uKCk7XG4gICAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpID8gKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogTWFwIGFuIGludGVyY2VwdGlvbiByZWZ1c2FsIHRvIGEgc3RhdHVzLlxuICpcbiAqIGBjYXAtZXhoYXVzdGVkYCBpcyA0MDIgcmF0aGVyIHRoYW4gNDA5IG9uIHB1cnBvc2U6IGl0IGlzIHRoZSBvbmUgcmVmdXNhbCBhXG4gKiBidXllciBjbGVhcnMgYnkgZnVuZGluZyB0aGUgY2hhbm5lbCwgbm90IGJ5IHJldHJ5aW5nIGRpZmZlcmVudGx5LlxuICovXG5mdW5jdGlvbiBzdGF0dXNGb3IoY29kZTogTWV0ZXJlZFJlZnVzYWxDb2RlKTogUmVmdXNhbFN0YXR1c0NvZGUge1xuICBpZiAoY29kZSA9PT0gJ2NhcC1leGhhdXN0ZWQnKSByZXR1cm4gNDAyO1xuICBpZiAoY29kZSA9PT0gJ2R1cGxpY2F0ZS1ub25jZScgfHwgY29kZSA9PT0gJ2N1bXVsYXRpdmUtcmVncmVzc2lvbicpIHJldHVybiA0MDk7XG4gIHJldHVybiA0MjI7XG59XG5cbi8qKiBBbW91bnRzIGNyb3NzIHRoZSBKU09OIGJvdW5kYXJ5IGFzIGRlY2ltYWwgU1RSSU5HUzogbWljcm9zIGNhbiBleGNlZWQgMl41My4gKi9cbmZ1bmN0aW9uIGJpZ2ludEZyb20odmFsdWU6IHVua25vd24pOiBiaWdpbnQgfCBudWxsIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2JpZ2ludCcpIHJldHVybiB2YWx1ZTtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZSkgPyBCaWdJbnQodmFsdWUpIDogbnVsbDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgL14tP1xcZCskLy50ZXN0KHZhbHVlLnRyaW0oKSkpIHJldHVybiBCaWdJbnQodmFsdWUudHJpbSgpKTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vbkVtcHR5KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUudHJpbSgpLmxlbmd0aCA+IDA7XG59XG5cbi8qKlxuICogUmVidWlsZCB0aGUgZXhhY3Qgdm91Y2hlciB0aGUgcGF5ZXIgc2lnbmVkIGZyb20gaXRzIHBlcnNpc3RlZCByZXNlcnZhdGlvbi5cbiAqXG4gKiBgZXhwaXJlc0F0TXNgIGlzIHJlYWQgYmFjayBmcm9tIHRoZSByb3cgcmF0aGVyIHRoYW4gc3Vic3RpdHV0ZWQsIGJlY2F1c2UgaXQgaXNcbiAqIG9uZSBvZiB0aGUgY2Fub25pY2FsIGZpZWxkcyBgcGF5bWVudFZvdWNoZXJEaWdlc3RgIGhhc2hlczogZmFicmljYXRlIGl0IGhlcmVcbiAqIGFuZCB0aGUgc2V0dGxlZCByZWNlaXB0IGJpbmRzIHRvIGEgdm91Y2hlciB0aGUgcGF5ZXIgbmV2ZXIgc2lnbmVkLCB3aGlsZSBzdGlsbFxuICogbG9va2luZyBwZXJmZWN0bHkgd2VsbC1mb3JtZWQuIEV4cGlyeSBpcyBub3QgcmUtY2hlY2tlZCBhdCBzZXR0bGVtZW50IOKAlCB0aGVcbiAqIHVuaXQgd2FzIGFscmVhZHkgYWRtaXR0ZWQg4oCUIHNvIHRoZSBzdG9yZWQgdmFsdWUgaXMgdXNlZCBmb3IgdGhlIERJR0VTVCwgbm90IGFzXG4gKiBhIHNlY29uZCBkZWFkbGluZS5cbiAqL1xuZnVuY3Rpb24gdm91Y2hlckZyb21SZWNlaXB0KHJlY2VpcHQ6IFN0b3JlZFVzYWdlUmVjZWlwdCk6IEN1bXVsYXRpdmVQYXltZW50Vm91Y2hlciB7XG4gIHJldHVybiB7XG4gICAgY2hhbm5lbElkOiByZWNlaXB0LmNoYW5uZWxJZCxcbiAgICBwYXllcjogcmVjZWlwdC5wYXllcixcbiAgICBzZWxsZXI6IHJlY2VpcHQuc2VsbGVyLFxuICAgIHJlbGVhc2VSZWY6IHJlY2VpcHQucmVsZWFzZVJlZixcbiAgICB1c2FnZU5vbmNlOiByZWNlaXB0LnVzYWdlTm9uY2UsXG4gICAgbWV0ZXJRdWFudGl0eTogQmlnSW50KHJlY2VpcHQucmVzZXJ2ZWRNZXRlclF1YW50aXR5KSxcbiAgICBwcmljZVBlclVuaXRNaWNyb3M6IEJpZ0ludChyZWNlaXB0LnVuaXRQcmljZU1pY3JvcyksXG4gICAgcHJpY2VWZXJzaW9uOiByZWNlaXB0LnByaWNlVmVyc2lvbixcbiAgICBzcGxpdE1hbmlmZXN0SGFzaDogcmVjZWlwdC5zcGxpdE1hbmlmZXN0SGFzaCxcbiAgICBleHBpcmVzQXRNczogcmVjZWlwdC5leHBpcmVzQXRNcyxcbiAgICBjdW11bGF0aXZlQ2xhaW1NaWNyb3M6IEJpZ0ludChyZWNlaXB0LmN1bXVsYXRpdmVDbGFpbU1pY3JvcyksXG4gICAgc2lnbmF0dXJlOiByZWNlaXB0LnZvdWNoZXJTaWduYXR1cmUsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlY2VpcHRKc29uKHJlY2VpcHQ6IFN0b3JlZFVzYWdlUmVjZWlwdCkge1xuICByZXR1cm4ge1xuICAgIGNoYW5uZWxJZDogcmVjZWlwdC5jaGFubmVsSWQsXG4gICAgdXNhZ2VOb25jZTogcmVjZWlwdC51c2FnZU5vbmNlLFxuICAgIG9mZmVySWQ6IHJlY2VpcHQub2ZmZXJJZCxcbiAgICBwYXllcjogcmVjZWlwdC5wYXllcixcbiAgICBzZWxsZXI6IHJlY2VpcHQuc2VsbGVyLFxuICAgIHJlbGVhc2VSZWY6IHJlY2VpcHQucmVsZWFzZVJlZixcbiAgICBtZXRlclVuaXQ6IHJlY2VpcHQubWV0ZXJVbml0LFxuICAgIG1ldGVyUXVhbnRpdHk6IFN0cmluZyhyZWNlaXB0Lm1ldGVyUXVhbnRpdHkpLFxuICAgIHVuaXRQcmljZU1pY3JvczogU3RyaW5nKHJlY2VpcHQudW5pdFByaWNlTWljcm9zKSxcbiAgICBwcmljZVZlcnNpb246IHJlY2VpcHQucHJpY2VWZXJzaW9uLFxuICAgIHNwbGl0TWFuaWZlc3RIYXNoOiByZWNlaXB0LnNwbGl0TWFuaWZlc3RIYXNoLFxuICAgIHJlc2VydmVkTWljcm9zOiBTdHJpbmcocmVjZWlwdC5yZXNlcnZlZE1pY3JvcyksXG4gICAgYW1vdW50TWljcm9zOiByZWNlaXB0LmFtb3VudE1pY3JvcyA9PSBudWxsID8gbnVsbCA6IFN0cmluZyhyZWNlaXB0LmFtb3VudE1pY3JvcyksXG4gICAgY3VtdWxhdGl2ZUNsYWltTWljcm9zOiBTdHJpbmcocmVjZWlwdC5jdW11bGF0aXZlQ2xhaW1NaWNyb3MpLFxuICAgIC8vIEJvdGggYXJlIGV4cG9zZWQgc28gdGhlIFNFTExFUiBjYW4gcmUtZGVyaXZlIHRoZSBleGFjdCBieXRlcyB0aGUgcGF5ZXJcbiAgICAvLyBzaWduZWQgYW5kIHNldHRsZSBhZ2FpbnN0IHRoZW0uIFRoZSB2b3VjaGVyIHNpZ25hdHVyZSBpcyB0aGUgcGF5ZXInc1xuICAgIC8vIHBheW1lbnQgaW5zdHJ1bWVudCwgbm90IGEgc2VjcmV0OiBhIHNlbGxlciB0aGF0IGNhbm5vdCBwcmVzZW50IGl0IGNhbm5vdFxuICAgIC8vIGNsYWltIHRoZSBtb25leS4gVGhlIHJlYWQgaXMgYWxyZWFkeSByZXN0cmljdGVkIHRvIHRoZSBmdW5kaW5nIHByaW5jaXBhbFxuICAgIC8vIGFuZCB0aGUgc2VsbGVycyBuYW1lZCBvbiB0aGUgY2hhbm5lbCdzIG93biByZWNlaXB0cy5cbiAgICBleHBpcmVzQXRNczogcmVjZWlwdC5leHBpcmVzQXRNcyxcbiAgICB2b3VjaGVyRGlnZXN0OiByZWNlaXB0LnZvdWNoZXJEaWdlc3QsXG4gICAgdm91Y2hlclNpZ25hdHVyZTogcmVjZWlwdC52b3VjaGVyU2lnbmF0dXJlLFxuICAgIHJlY2VpcHRTaWduYXR1cmU6IHJlY2VpcHQucmVjZWlwdFNpZ25hdHVyZSxcbiAgICBzZWxsZXJQdWJrZXlCYXNlNjQ6IHJlY2VpcHQuc2VsbGVyUHVia2V5QmFzZTY0ID8/IG51bGwsXG4gICAgc3RhdGU6IHJlY2VpcHQuc3RhdGUsXG4gICAgcmVzZXJ2ZWRBdE1zOiByZWNlaXB0LnJlc2VydmVkQXRNcyxcbiAgICBzZXR0bGVkQXRNczogcmVjZWlwdC5zZXR0bGVkQXRNcyxcbiAgICAuLi4ocmVjZWlwdC5pZGVudGl0eUluZmVyZW5jZSA/IHsgaWRlbnRpdHlJbmZlcmVuY2U6IHtcbiAgICAgIGNlaWxpbmdNaWNyb3M6IFN0cmluZyhyZWNlaXB0LmlkZW50aXR5SW5mZXJlbmNlLmNlaWxpbmdNaWNyb3MpLFxuICAgICAgYmlsbGVkSW5mZXJlbmNlTWljcm9zOiByZWNlaXB0LmlkZW50aXR5SW5mZXJlbmNlLmJpbGxlZEluZmVyZW5jZU1pY3JvcyA9PT0gbnVsbCA/IG51bGwgOiBTdHJpbmcocmVjZWlwdC5pZGVudGl0eUluZmVyZW5jZS5iaWxsZWRJbmZlcmVuY2VNaWNyb3MpLFxuICAgICAgcHJpb3JSZW1haW5kZXJOdW1lcmF0b3I6IHJlY2VpcHQuaWRlbnRpdHlJbmZlcmVuY2UucHJpb3JSZW1haW5kZXJOdW1lcmF0b3IgPT09IG51bGwgPyBudWxsIDogU3RyaW5nKHJlY2VpcHQuaWRlbnRpdHlJbmZlcmVuY2UucHJpb3JSZW1haW5kZXJOdW1lcmF0b3IpLFxuICAgICAgcmVtYWluZGVyTnVtZXJhdG9yOiByZWNlaXB0LmlkZW50aXR5SW5mZXJlbmNlLnJlbWFpbmRlck51bWVyYXRvciA9PT0gbnVsbCA/IG51bGwgOiBTdHJpbmcocmVjZWlwdC5pZGVudGl0eUluZmVyZW5jZS5yZW1haW5kZXJOdW1lcmF0b3IpLFxuICAgIH0gfSA6IHt9KSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1ldGVyZWRVc2FnZVJvdXRlKCk6IEhvbm88eyBCaW5kaW5nczogRW52IH0+IHtcbiAgY29uc3Qgcm91dGUgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4oKTtcblxuICAvLyBTdGF0ZW1lbnQgc291cmNlIGFjcm9zcyBjaGFubmVscy4gQ2FsbGVyIGFyZ3VtZW50cyBuZXZlciBzZWxlY3QgYSBwYXJ0eS5cbiAgcm91dGUuZ2V0KCcvY29tbWVyY2UvbWV0ZXJlZC1pbnZvY2F0aW9ucycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGxpbWl0VGV4dCA9IGMucmVxLnF1ZXJ5KCdsaW1pdCcpID8/ICcxMDAnO1xuICAgIGlmICghL15bMS05XVswLTldezAsMn0kLy50ZXN0KGxpbWl0VGV4dCkgfHwgTnVtYmVyKGxpbWl0VGV4dCkgPiAyMDApIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfdXNhZ2VfbGltaXQnLCBkZXRhaWw6ICdsaW1pdCBtdXN0IGJlIGFuIGludGVnZXIgZnJvbSAxIHRvIDIwMCcgfSwgNDAwKTtcbiAgICB9XG4gICAgY29uc3QgY3Vyc29yID0gYy5yZXEucXVlcnkoJ2N1cnNvcicpO1xuICAgIGxldCBhZnRlcjogeyBjaGFubmVsSWQ6IHN0cmluZzsgdXNhZ2VOb25jZTogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gICAgaWYgKGN1cnNvciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoY3Vyc29yLmxlbmd0aCA+IDIwMDApIHRocm93IG5ldyBFcnJvcignb3ZlcnNpemVkIGN1cnNvcicpO1xuICAgICAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGN1cnNvcik7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpIHx8IHBhcnNlZC5sZW5ndGggIT09IDIgfHwgIXBhcnNlZC5ldmVyeSh2YWx1ZSA9PlxuICAgICAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCAmJiB2YWx1ZS5sZW5ndGggPD0gMzAwICYmIHZhbHVlLnRyaW0oKSA9PT0gdmFsdWUpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIGN1cnNvcicpO1xuICAgICAgICB9XG4gICAgICAgIGFmdGVyID0geyBjaGFubmVsSWQ6IHBhcnNlZFswXSwgdXNhZ2VOb25jZTogcGFyc2VkWzFdIH07XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF91c2FnZV9jdXJzb3InIH0sIDQwMCk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHBhZ2UgPSBhd2FpdCBsaXN0UHJpbmNpcGFsVXNhZ2VSZWNlaXB0cyhjLmVudi5EQiwgYXV0aC5wcmluY2lwYWxJZCwgTnVtYmVyKGxpbWl0VGV4dCksIGFmdGVyKTtcbiAgICBjb25zdCByZWNlaXB0cyA9IHBhZ2UucmVjZWlwdHMubWFwKHJlY2VpcHRKc29uKTtcbiAgICByZXR1cm4gYy5qc29uKHsgcmVjZWlwdHMsIGlkZW50aXR5U3RhdGVtZW50OiBpZGVudGl0eVVzYWdlU3RhdGVtZW50KHJlY2VpcHRzLCBhdXRoLnByaW5jaXBhbElkKSxcbiAgICAgIG5leHRDdXJzb3I6IHBhZ2UubmV4dCA/IEpTT04uc3RyaW5naWZ5KFtwYWdlLm5leHQuY2hhbm5lbElkLCBwYWdlLm5leHQudXNhZ2VOb25jZV0pIDogbnVsbCxcbiAgICAgIGNvdmVyYWdlOiB7IHNjb3BlOiAnYXV0aGVudGljYXRlZC1wcmluY2lwYWwnLCBwb3B1bGF0aW9uOiAnbGl2ZS1wYWdlJyxcbiAgICAgICAgdG90YWxzOiAncGFnZScsIGhhc01vcmU6IHBhZ2UubmV4dCAhPT0gbnVsbCB9IH0pO1xuICB9KTtcblxuICAvLyDilIDilIAgUkVTRVJWRSwgYmVmb3JlIHRoZSBzZWxsZXIgZXhlY3V0ZXMgdGhlIHVuaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIHJvdXRlLnBvc3QoJy9jb21tZXJjZS9tZXRlcmVkLWludm9jYXRpb25zJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG5cbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGNvbnN0IHdpcmUgPSBib2R5Py52b3VjaGVyO1xuICAgIGlmICghYm9keSB8fCAhbm9uRW1wdHkoYm9keS5jaGFubmVsSWQpIHx8ICFub25FbXB0eShib2R5Lm9mZmVySWQpIHx8ICF3aXJlIHx8IHR5cGVvZiB3aXJlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHdpcmUpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnLCBkZXRhaWw6ICdjaGFubmVsSWQsIG9mZmVySWQgYW5kIGEgc2lnbmVkIHZvdWNoZXIgb2JqZWN0IGFyZSByZXF1aXJlZCcgfSwgNDAwKTtcbiAgICB9XG4gICAgY29uc3QgdiA9IHdpcmUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3QgbWV0ZXJRdWFudGl0eSA9IGJpZ2ludEZyb20odi5tZXRlclF1YW50aXR5KTtcbiAgICBjb25zdCBwcmljZVBlclVuaXRNaWNyb3MgPSBiaWdpbnRGcm9tKHYucHJpY2VQZXJVbml0TWljcm9zKTtcbiAgICBjb25zdCBjdW11bGF0aXZlQ2xhaW1NaWNyb3MgPSBiaWdpbnRGcm9tKHYuY3VtdWxhdGl2ZUNsYWltTWljcm9zKTtcbiAgICBpZiAoXG4gICAgICAhbm9uRW1wdHkodi5wYXllcikgfHxcbiAgICAgICFub25FbXB0eSh2LnNlbGxlcikgfHxcbiAgICAgICFub25FbXB0eSh2LnJlbGVhc2VSZWYpIHx8XG4gICAgICAhbm9uRW1wdHkodi51c2FnZU5vbmNlKSB8fFxuICAgICAgIW5vbkVtcHR5KHYucHJpY2VWZXJzaW9uKSB8fFxuICAgICAgIW5vbkVtcHR5KHYuc3BsaXRNYW5pZmVzdEhhc2gpIHx8XG4gICAgICAhbm9uRW1wdHkodi5zaWduYXR1cmUpIHx8XG4gICAgICBtZXRlclF1YW50aXR5ID09IG51bGwgfHxcbiAgICAgIHByaWNlUGVyVW5pdE1pY3JvcyA9PSBudWxsIHx8XG4gICAgICBjdW11bGF0aXZlQ2xhaW1NaWNyb3MgPT0gbnVsbCB8fFxuICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHYuZXhwaXJlc0F0TXMpXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6ICdpbnZhbGlkX3ZvdWNoZXInLFxuICAgICAgICAgIGRldGFpbDpcbiAgICAgICAgICAgICd0aGUgdm91Y2hlciBtdXN0IGNhcnJ5IHBheWVyLCBzZWxsZXIsIHJlbGVhc2VSZWYsIHVzYWdlTm9uY2UsIG1ldGVyUXVhbnRpdHksIHByaWNlUGVyVW5pdE1pY3JvcywgcHJpY2VWZXJzaW9uLCBzcGxpdE1hbmlmZXN0SGFzaCwgZXhwaXJlc0F0TXMsIGN1bXVsYXRpdmVDbGFpbU1pY3JvcyBhbmQgc2lnbmF0dXJlJyxcbiAgICAgICAgfSxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFubmVsID0gYXdhaXQgZ2V0UGF5bWVudENoYW5uZWwoYy5lbnYuREIsIGJvZHkuY2hhbm5lbElkKTtcbiAgICBpZiAoIWNoYW5uZWwpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Vua25vd25fY2hhbm5lbCcsIGRldGFpbDogYHBheW1lbnQgY2hhbm5lbCAke2JvZHkuY2hhbm5lbElkfSBkb2VzIG5vdCBleGlzdGAgfSwgNDA0KTtcbiAgICAvLyBUaGUgZXNjcm93IGZ1bmRlciBpcyB0aGUgcGF5ZXIuIFJlYWRpbmcgaXQgZnJvbSB0aGUgcm93IHJhdGhlciB0aGFuIHRoZVxuICAgIC8vIGJvZHkgaXMgd2hhdCBzdG9wcyBvbmUgYnV5ZXIgbWV0ZXJpbmcgYWdhaW5zdCBhbm90aGVyJ3MgZXNjcm93LlxuICAgIGlmIChjaGFubmVsLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmb3JiaWRkZW4nLCBkZXRhaWw6ICdvbmx5IHRoZSBmdW5kaW5nIHByaW5jaXBhbCBjYW4gbWV0ZXIgYWdhaW5zdCB0aGlzIGNoYW5uZWwnIH0sIDQwMyk7XG4gICAgfVxuICAgIGlmIChjaGFubmVsLnN0YXRlICE9PSAnb3BlbicpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NoYW5uZWxfbm90X29wZW4nLCBkZXRhaWw6IGBwYXltZW50IGNoYW5uZWwgaXMgJyR7Y2hhbm5lbC5zdGF0ZX0nYCB9LCA0MDkpO1xuICAgIH1cblxuICAgIGNvbnN0IG9mZmVyID0gYXdhaXQgZ2V0Q29tbWVyY2VPZmZlcihjLmVudi5EQiwgYm9keS5vZmZlcklkKTtcbiAgICBpZiAoIW9mZmVyKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmtub3duX29mZmVyJywgZGV0YWlsOiBgb2ZmZXIgJHtib2R5Lm9mZmVySWR9IGlzIG5vdCBpbiB0aGUgY2F0YWxvZ2AgfSwgNDA0KTtcbiAgICBpZiAoIW9mZmVyLmFjdGl2ZSB8fCAhb2ZmZXIucHJvZHVjdEFjdGl2ZSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW5hY3RpdmVfb2ZmZXInLCBkZXRhaWw6IGBvZmZlciAke2JvZHkub2ZmZXJJZH0gaXMgaW5hY3RpdmVgIH0sIDQyMik7XG4gICAgaWYgKG9mZmVyLnByaWNpbmdNb2RlbCAhPT0gJ3Blci11c2UnIHx8ICFvZmZlci5wZXJVc2UpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9tZXRlcmVkJywgZGV0YWlsOiBgb2ZmZXIgJHtib2R5Lm9mZmVySWR9IGlzIG5vdCBhIHBlci11c2Ugb2ZmZXJgIH0sIDQyMik7XG4gICAgfVxuICAgIGNvbnN0IGRlY2xhcmVkID0gZGVjbGFyZU1ldGVyKG9mZmVyLnBlclVzZSk7XG4gICAgaWYgKCFkZWNsYXJlZC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiBkZWNsYXJlZC5jb2RlLCBkZXRhaWw6IGRlY2xhcmVkLmRldGFpbCB9LCA0MjIpO1xuICAgIGNvbnN0IGlkZW50aXR5Q2VpbGluZyA9IGJpZ2ludEZyb20oYm9keS5pZGVudGl0eUluZmVyZW5jZUNlaWxpbmdNaWNyb3MpO1xuICAgIGNvbnN0IGlzSWRlbnRpdHkgPSBvZmZlci5za3VSZWYuc3RhcnRzV2l0aCgnaWRlbnRpdHktcmVsZWFzZTonKTtcbiAgICBpZiAoaXNJZGVudGl0eSkge1xuICAgICAgY29uc3QgcSA9IHF1b3RlSWRlbnRpdHlJbmZlcmVuY2VUdXJuKHsgb2ZmZXI6IHsgc2t1UmVmOiBvZmZlci5za3VSZWYsIC4uLm9mZmVyLnBlclVzZSB9LFxuICAgICAgICBiaWxsZWRJbmZlcmVuY2VNaWNyb3M6IDBuLCBpbmZlcmVuY2VDZWlsaW5nTWljcm9zOiBpZGVudGl0eUNlaWxpbmcgPz8gMG4gfSk7XG4gICAgICBpZiAoIXEub2sgfHwgcS5yZXNlcnZhdGlvblF1YW50aXR5ICE9PSBtZXRlclF1YW50aXR5KSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2lkZW50aXR5LWNlaWxpbmctbWlzbWF0Y2gnLCBkZXRhaWw6ICdpZGVudGl0eSByZXNlcnZlIHJlcXVpcmVzIGl0cyBleGFjdCBwb3NpdGl2ZSBpbmZlcmVuY2UgY2VpbGluZyBhbmQgbWF0Y2hpbmcgYmxvY2sgcXVhbnRpdHknIH0sIDQyMik7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChib2R5LmlkZW50aXR5SW5mZXJlbmNlQ2VpbGluZ01pY3JvcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpZGVudGl0eS1jZWlsaW5nLW1pc21hdGNoJywgZGV0YWlsOiAnb25seSBpZGVudGl0eSBvZmZlcnMgYWNjZXB0IGluZmVyZW5jZSBjZWlsaW5ncycgfSwgNDIyKTtcbiAgICB9XG5cbiAgICBjb25zdCB1bml0OiBCaWxsYWJsZVVuaXQgPSB7XG4gICAgICBwYXllcjogY2hhbm5lbC5wcmluY2lwYWxJZCxcbiAgICAgIHNlbGxlcjogb2ZmZXIuY3JlYXRvcklkLFxuICAgICAgcmVsZWFzZVJlZjogb2ZmZXIuc2t1UmVmLFxuICAgICAgdXNhZ2VOb25jZTogdi51c2FnZU5vbmNlLFxuICAgICAgcXVhbnRpdHk6IG1ldGVyUXVhbnRpdHksXG4gICAgICBleHBpcmVzQXRNczogTnVtYmVyKHYuZXhwaXJlc0F0TXMpLFxuICAgIH07XG4gICAgY29uc3Qgdm91Y2hlcjogQ3VtdWxhdGl2ZVBheW1lbnRWb3VjaGVyID0ge1xuICAgICAgY2hhbm5lbElkOiBib2R5LmNoYW5uZWxJZCxcbiAgICAgIHBheWVyOiB2LnBheWVyLFxuICAgICAgc2VsbGVyOiB2LnNlbGxlcixcbiAgICAgIHJlbGVhc2VSZWY6IHYucmVsZWFzZVJlZixcbiAgICAgIHVzYWdlTm9uY2U6IHYudXNhZ2VOb25jZSxcbiAgICAgIG1ldGVyUXVhbnRpdHksXG4gICAgICBwcmljZVBlclVuaXRNaWNyb3MsXG4gICAgICBwcmljZVZlcnNpb246IHYucHJpY2VWZXJzaW9uLFxuICAgICAgc3BsaXRNYW5pZmVzdEhhc2g6IHYuc3BsaXRNYW5pZmVzdEhhc2gsXG4gICAgICBleHBpcmVzQXRNczogTnVtYmVyKHYuZXhwaXJlc0F0TXMpLFxuICAgICAgY3VtdWxhdGl2ZUNsYWltTWljcm9zLFxuICAgICAgc2lnbmF0dXJlOiB2LnNpZ25hdHVyZSxcbiAgICB9O1xuXG4gICAgY29uc3QgZHVyYWJsZSA9IGF3YWl0IGxvYWRNaWNyb2NoYXJnZUNoYW5uZWwoYy5lbnYuREIsIGNoYW5uZWwpO1xuICAgIGNvbnN0IGFjY2VwdGVkID0gYWNjZXB0TWV0ZXJlZFZvdWNoZXIoe1xuICAgICAgY2hhbm5lbDogZHVyYWJsZSxcbiAgICAgIG1ldGVyOiBkZWNsYXJlZC5tZXRlcixcbiAgICAgIHVuaXQsXG4gICAgICB2b3VjaGVyLFxuICAgICAgbm93TXM6IERhdGUubm93KCksXG4gICAgICB2ZXJpZnlTaWduYXR1cmU6IChjYW5kaWRhdGUpID0+IHZlcmlmeVBheW1lbnRWb3VjaGVyU2lnbmF0dXJlKGNhbmRpZGF0ZSwge1xuICAgICAgICBjaGFubmVsSWQ6IGNoYW5uZWwuY2hhbm5lbElkLFxuICAgICAgICBwYXllcjogY2hhbm5lbC5wcmluY2lwYWxJZCxcbiAgICAgICAgcHVia2V5QmFzZTY0OiBjaGFubmVsLnBheWVyUHVia2V5QmFzZTY0ID8/ICcnLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgaWYgKCFhY2NlcHRlZC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiBhY2NlcHRlZC5jb2RlLCBkZXRhaWw6IGFjY2VwdGVkLmRldGFpbCB9LCBzdGF0dXNGb3IoYWNjZXB0ZWQuY29kZSkpO1xuICAgIGlmICghb2ZmZXIucmVjZWlwdEF1dGhvcml0eSB8fCAhdmVyaWZ5U2VsbGVyUmVjZWlwdEF1dGhvcml0eSh7IHNlbGxlcjogb2ZmZXIuY3JlYXRvcklkLFxuICAgICAgICBvZmZlcklkOiBvZmZlci5vZmZlcklkLCBwcm9kdWN0SWQ6IG9mZmVyLnByb2R1Y3RJZCwgc2t1UmVmOiBvZmZlci5za3VSZWYgfSwgb2ZmZXIucmVjZWlwdEF1dGhvcml0eSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3NlbGxlci1hdXRob3JpdHktcmVxdWlyZWQnLCBkZXRhaWw6ICdwdWJsaXNoIGFuIGF1dGhlbnRpY2F0ZWQgc2VsbGVyIHJlY2VpcHQga2V5IGJlZm9yZSByZXNlcnZpbmcgdXNhZ2UnIH0sIDQyMik7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgcmVzZXJ2ZVVzYWdlUmVjZWlwdChjLmVudi5EQiwge1xuICAgICAgY2hhbm5lbElkOiBjaGFubmVsLmNoYW5uZWxJZCxcbiAgICAgIHVzYWdlTm9uY2U6IHZvdWNoZXIudXNhZ2VOb25jZSxcbiAgICAgIHByaW5jaXBhbElkOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgb2ZmZXJJZDogb2ZmZXIub2ZmZXJJZCxcbiAgICAgIHBheWVyOiB2b3VjaGVyLnBheWVyLFxuICAgICAgc2VsbGVyOiB2b3VjaGVyLnNlbGxlcixcbiAgICAgIHJlbGVhc2VSZWY6IHZvdWNoZXIucmVsZWFzZVJlZixcbiAgICAgIG1ldGVyVW5pdDogZGVjbGFyZWQubWV0ZXIubWV0ZXJVbml0LFxuICAgICAgbWV0ZXJRdWFudGl0eTogdm91Y2hlci5tZXRlclF1YW50aXR5LFxuICAgICAgdW5pdFByaWNlTWljcm9zOiB2b3VjaGVyLnByaWNlUGVyVW5pdE1pY3JvcyxcbiAgICAgIHByaWNlVmVyc2lvbjogdm91Y2hlci5wcmljZVZlcnNpb24sXG4gICAgICBzcGxpdE1hbmlmZXN0SGFzaDogdm91Y2hlci5zcGxpdE1hbmlmZXN0SGFzaCxcbiAgICAgIHJlc2VydmVkTWljcm9zOiBhY2NlcHRlZC5yZXNlcnZlZE1pY3JvcyxcbiAgICAgIGN1bXVsYXRpdmVDbGFpbU1pY3Jvczogdm91Y2hlci5jdW11bGF0aXZlQ2xhaW1NaWNyb3MsXG4gICAgICBleHBpcmVzQXRNczogdm91Y2hlci5leHBpcmVzQXRNcyxcbiAgICAgIHZvdWNoZXJEaWdlc3Q6IHBheW1lbnRWb3VjaGVyRGlnZXN0KHVuc2lnbmVkVm91Y2hlcih2b3VjaGVyKSksXG4gICAgICB2b3VjaGVyU2lnbmF0dXJlOiB2b3VjaGVyLnNpZ25hdHVyZSxcbiAgICAgIHNlbGxlclB1YmtleUJhc2U2NDogb2ZmZXIucmVjZWlwdEF1dGhvcml0eS5wdWJrZXlCYXNlNjQsXG4gICAgICBub3dNczogRGF0ZS5ub3coKSxcbiAgICAgIC4uLihpc0lkZW50aXR5ID8geyBpZGVudGl0eUluZmVyZW5jZUNlaWxpbmdNaWNyb3M6IGlkZW50aXR5Q2VpbGluZyEgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAoIXN0b3JlZC5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBzdG9yZWQuY29kZSwgZGV0YWlsOiAndGhlIGR1cmFibGUgdXNhZ2UgbGVkZ2VyIHJlZnVzZWQgYWRtaXNzaW9uJyB9LCBzdG9yZWQuY29kZSA9PT0gJ2NhcC1leGhhdXN0ZWQnID8gNDAyIDogNDA5KTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7IHJlc2VydmVkOiB0cnVlLCByZWNlaXB0OiByZWNlaXB0SnNvbihzdG9yZWQucmVjZWlwdCkgfSwgMjAxKTtcbiAgfSk7XG5cbiAgLy8g4pSA4pSAIFNFVFRMRSwgYWZ0ZXIgdGhlIHNlbGxlciBleGVjdXRlZCB0aGUgdW5pdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL21ldGVyZWQtaW52b2NhdGlvbnMvOnVzYWdlTm9uY2Uvc2V0dGxlJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG5cbiAgICBjb25zdCB1c2FnZU5vbmNlID0gYy5yZXEucGFyYW0oJ3VzYWdlTm9uY2UnKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGlmICghYm9keSB8fCAhbm9uRW1wdHkoYm9keS5jaGFubmVsSWQpIHx8ICFub25FbXB0eShib2R5LnJlY2VpcHRTaWduYXR1cmUpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnLCBkZXRhaWw6ICdjaGFubmVsSWQgYW5kIHJlY2VpcHRTaWduYXR1cmUgYXJlIHJlcXVpcmVkJyB9LCA0MDApO1xuICAgIH1cbiAgICBjb25zdCBhY3R1YWxRdWFudGl0eSA9IGJvZHkuYWN0dWFsUXVhbnRpdHkgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBiaWdpbnRGcm9tKGJvZHkuYWN0dWFsUXVhbnRpdHkpO1xuICAgIGlmIChib2R5LmFjdHVhbFF1YW50aXR5ICE9PSB1bmRlZmluZWQgJiYgYWN0dWFsUXVhbnRpdHkgPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JywgZGV0YWlsOiAnYWN0dWFsUXVhbnRpdHkgbXVzdCBiZSBhbiBpbnRlZ2VyJyB9LCA0MDApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc2VydmVkID0gYXdhaXQgZ2V0VXNhZ2VSZWNlaXB0KGMuZW52LkRCLCBib2R5LmNoYW5uZWxJZCwgdXNhZ2VOb25jZSk7XG4gICAgaWYgKCFyZXNlcnZlZCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5rbm93bi1yZXNlcnZhdGlvbicsIGRldGFpbDogYG5vIHJlc2VydmF0aW9uIGZvciB1c2FnZSBub25jZSAnJHt1c2FnZU5vbmNlfSdgIH0sIDQwNCk7XG4gICAgfVxuICAgIC8vIFRoZSBTRUxMRVIgcmVwb3J0cyB3aGF0IGl0IHNlcnZlZCBhbmQgc2lnbnMgdGhlIHJlY2VpcHQgZm9yIGl0LiBBIGJ1eWVyXG4gICAgLy8gY2Fubm90IHNldHRsZSBpdHMgb3duIHVzYWdlLCBhbmQgYSB0aGlyZCBwYXJ0eSBjYW5ub3Qgc2V0dGxlIGF0IGFsbC5cbiAgICBpZiAocmVzZXJ2ZWQuc2VsbGVyICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmb3JiaWRkZW4nLCBkZXRhaWw6ICdvbmx5IHRoZSBzZWxsZXIgbmFtZWQgb24gdGhlIHJlc2VydmF0aW9uIGNhbiBzZXR0bGUgaXQnIH0sIDQwMyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2hhbm5lbCA9IGF3YWl0IGdldFBheW1lbnRDaGFubmVsKGMuZW52LkRCLCBib2R5LmNoYW5uZWxJZCk7XG4gICAgaWYgKCFjaGFubmVsKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmtub3duX2NoYW5uZWwnLCBkZXRhaWw6IGBwYXltZW50IGNoYW5uZWwgJHtib2R5LmNoYW5uZWxJZH0gZG9lcyBub3QgZXhpc3RgIH0sIDQwNCk7XG5cbiAgICBjb25zdCBvY2N1cnJlZEF0TXMgPSBib2R5Lm9jY3VycmVkQXRNcyA9PT0gdW5kZWZpbmVkICYmICFyZXNlcnZlZC5pZGVudGl0eUluZmVyZW5jZSA/IERhdGUubm93KCkgOiBib2R5Lm9jY3VycmVkQXRNcztcbiAgICBpZiAodHlwZW9mIG9jY3VycmVkQXRNcyAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9jY3VycmVkQXRNcykgfHwgb2NjdXJyZWRBdE1zIDwgcmVzZXJ2ZWQucmVzZXJ2ZWRBdE1zIHx8IG9jY3VycmVkQXRNcyA+IERhdGUubm93KCkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfcmVxdWVzdCcsIGRldGFpbDogJ2Egc2lnbmVkIGNvbXBsZXRpb24gdGltZXN0YW1wIGJldHdlZW4gYWRtaXNzaW9uIGFuZCBub3cgaXMgcmVxdWlyZWQnIH0sIDQwMCk7XG4gICAgfVxuICAgIGxldCBpZGVudGl0eUluZmVyZW5jZTtcbiAgICBsZXQgZXhhY3Q7XG4gICAgaWYgKHJlc2VydmVkLnJlbGVhc2VSZWYuc3RhcnRzV2l0aCgnaWRlbnRpdHktcmVsZWFzZTonKSkge1xuICAgICAgY29uc3QgYmlsbGVkID0gYmlnaW50RnJvbShib2R5LmJpbGxlZEluZmVyZW5jZU1pY3JvcyksIHByaW9yID0gYmlnaW50RnJvbShib2R5LnByaW9yUmVtYWluZGVyTnVtZXJhdG9yKTtcbiAgICAgIGlmICghcmVzZXJ2ZWQuaWRlbnRpdHlJbmZlcmVuY2UgfHwgYmlsbGVkID09PSBudWxsIHx8IHByaW9yID09PSBudWxsIHx8IGFjdHVhbFF1YW50aXR5ICE9IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaWRlbnRpdHktc2V0dGxlbWVudC1taXNtYXRjaCcsIGRldGFpbDogJ2V4YWN0IGJpbGxlZCBjb3N0IGFuZCBwcmlvciByZW1haW5kZXIgYXJlIHJlcXVpcmVkIGZvciBhbiBhZG1pdHRlZCBpZGVudGl0eSB0dXJuJyB9LCA0MjIpO1xuICAgICAgfVxuICAgICAgLy8gUmVwbGF5cyBxdW90ZSB3aXRoIHRoZWlyIHN0b3JlZCBwcmlvcjsgbmV3IHNldHRsZW1lbnRzIHVzZSBob3N0ZWQgaGlzdG9yeS5cbiAgICAgIGNvbnN0IGF1dGhvcml0YXRpdmVQcmlvciA9IHJlc2VydmVkLnN0YXRlID09PSAnc2V0dGxlZCcgPyBCaWdJbnQocmVzZXJ2ZWQuaWRlbnRpdHlJbmZlcmVuY2UucHJpb3JSZW1haW5kZXJOdW1lcmF0b3IhKSA6XG4gICAgICAgIGF3YWl0IHJlYWRJZGVudGl0eU1hcmt1cFJlbWFpbmRlcihjLmVudi5EQiwgcmVzZXJ2ZWQucGF5ZXIsIHJlc2VydmVkLm9mZmVySWQpO1xuICAgICAgaWYgKHByaW9yICE9PSBhdXRob3JpdGF0aXZlUHJpb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2lkZW50aXR5LXJlbWFpbmRlci1taXNtYXRjaCcsIGRldGFpbDogJ3ByaW9yIHJlbWFpbmRlciBkaWZmZXJzIGZyb20gaG9zdGVkIGhpc3RvcnknIH0sIDQwOSk7XG4gICAgICBpZGVudGl0eUluZmVyZW5jZSA9IHsgb2ZmZXI6IHsgc2t1UmVmOiByZXNlcnZlZC5yZWxlYXNlUmVmLCBtZXRlclVuaXQ6IHJlc2VydmVkLm1ldGVyVW5pdCxcbiAgICAgICAgdW5pdFByaWNlTWljcm9zOiByZXNlcnZlZC51bml0UHJpY2VNaWNyb3MsIHByaWNlVmVyc2lvbjogcmVzZXJ2ZWQucHJpY2VWZXJzaW9uLCBzcGxpdE1hbmlmZXN0SGFzaDogcmVzZXJ2ZWQuc3BsaXRNYW5pZmVzdEhhc2ggfSxcbiAgICAgICAgYmlsbGVkSW5mZXJlbmNlTWljcm9zOiBiaWxsZWQsIGluZmVyZW5jZUNlaWxpbmdNaWNyb3M6IEJpZ0ludChyZXNlcnZlZC5pZGVudGl0eUluZmVyZW5jZS5jZWlsaW5nTWljcm9zKSwgcHJpb3JSZW1haW5kZXJOdW1lcmF0b3I6IHByaW9yIH07XG4gICAgICBjb25zdCBxID0gcXVvdGVJZGVudGl0eUluZmVyZW5jZVR1cm4oaWRlbnRpdHlJbmZlcmVuY2UpO1xuICAgICAgaWYgKCFxLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHEuY29kZSwgZGV0YWlsOiBxLmRldGFpbCB9LCA0MjIpO1xuICAgICAgZXhhY3QgPSB7IGJpbGxlZEluZmVyZW5jZU1pY3JvczogYmlsbGVkLCBwcmlvclJlbWFpbmRlck51bWVyYXRvcjogcHJpb3IsIHJlbWFpbmRlck51bWVyYXRvcjogcS5yZW1haW5kZXJOdW1lcmF0b3IgfTtcbiAgICB9IGVsc2UgaWYgKGJvZHkuYmlsbGVkSW5mZXJlbmNlTWljcm9zICE9PSB1bmRlZmluZWQgfHwgYm9keS5wcmlvclJlbWFpbmRlck51bWVyYXRvciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpZGVudGl0eS1zZXR0bGVtZW50LW1pc21hdGNoJywgZGV0YWlsOiAnb3JkaW5hcnkgdW5pdHMgY2Fubm90IG92ZXJyaWRlIHRoZWlyIHB1Ymxpc2hlZCBwcmljZScgfSwgNDIyKTtcbiAgICB9XG4gICAgY29uc3QgZHVyYWJsZSA9IGF3YWl0IGxvYWRNaWNyb2NoYXJnZUNoYW5uZWwoYy5lbnYuREIsIGNoYW5uZWwpO1xuICAgIC8vIEFuIGlkZW50aWNhbCByZXRyeSBpcyBjaGVja2VkIGFnYWluc3QgdGhlIHN0b3JlZCByZWNlaXB0LCB1c2luZyB0aGUgc2FtZVxuICAgIC8vIHB1cmUgY2xvc3VyZSwgcmF0aGVyIHRoYW4gc2lnbmluZyBhIG5ldyB0aW1lc3RhbXAgYWZ0ZXIgYSB0cmFuc3BvcnQgbG9zcy5cbiAgICBjb25zdCBjbG9zdXJlQ2hhbm5lbCA9IHJlc2VydmVkLnN0YXRlID09PSAnc2V0dGxlZCcgPyB7IC4uLmR1cmFibGUsXG4gICAgICByZXNlcnZhdGlvbnM6IHsgLi4uZHVyYWJsZS5yZXNlcnZhdGlvbnMsIFt1c2FnZU5vbmNlXTogQmlnSW50KHJlc2VydmVkLnJlc2VydmVkTWljcm9zKSB9IH0gOiBkdXJhYmxlO1xuICAgIGNvbnN0IGNsb3NlZCA9IGNsb3NlTWV0ZXJlZEludm9jYXRpb24oe1xuICAgICAgY2hhbm5lbDogY2xvc3VyZUNoYW5uZWwsXG4gICAgICB2b3VjaGVyOiB2b3VjaGVyRnJvbVJlY2VpcHQocmVzZXJ2ZWQpLFxuICAgICAgLi4uKGFjdHVhbFF1YW50aXR5ICE9IG51bGwgPyB7IGFjdHVhbFF1YW50aXR5IH0gOiB7fSksXG4gICAgICBvY2N1cnJlZEF0TXMsXG4gICAgICAuLi4oaWRlbnRpdHlJbmZlcmVuY2UgPyB7IGlkZW50aXR5SW5mZXJlbmNlIH0gOiB7fSksXG4gICAgICBzaWduUmVjZWlwdDogKCkgPT4gYm9keS5yZWNlaXB0U2lnbmF0dXJlIGFzIHN0cmluZyxcbiAgICB9KTtcbiAgICBpZiAoIWNsb3NlZC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiBjbG9zZWQuY29kZSwgZGV0YWlsOiBjbG9zZWQuZGV0YWlsIH0sIHN0YXR1c0ZvcihjbG9zZWQuY29kZSkpO1xuICAgIGlmICghcmVzZXJ2ZWQuc2VsbGVyUHVia2V5QmFzZTY0IHx8ICF2ZXJpZnlVc2FnZVJlY2VpcHRTaWduYXR1cmUoY2xvc2VkLnJlY2VpcHQsIHJlc2VydmVkLnNlbGxlclB1YmtleUJhc2U2NCkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWQtcmVjZWlwdC1zaWduYXR1cmUnLCBkZXRhaWw6ICd0aGUgb3JpZ2luYWwgc2VsbGVyIGtleSBtdXN0IHNpZ24gdGhlIGV4YWN0IHVzYWdlIHJlY2VpcHQnIH0sIDQyMik7XG4gICAgfVxuXG4gICAgY29uc3QgcGVyc2lzdGVkID0gYXdhaXQgc2V0dGxlVXNhZ2VSZWNlaXB0KGMuZW52LkRCLCB7XG4gICAgICBjaGFubmVsSWQ6IGNoYW5uZWwuY2hhbm5lbElkLFxuICAgICAgdXNhZ2VOb25jZSxcbiAgICAgIGFtb3VudE1pY3JvczogY2xvc2VkLmFtb3VudE1pY3JvcyxcbiAgICAgIG1ldGVyUXVhbnRpdHk6IGNsb3NlZC5yZWNlaXB0Lm1ldGVyUXVhbnRpdHksXG4gICAgICByZWNlaXB0U2lnbmF0dXJlOiBjbG9zZWQucmVjZWlwdC5zaWduYXR1cmUsXG4gICAgICBub3dNczogb2NjdXJyZWRBdE1zLFxuICAgICAgLi4uKGV4YWN0ID8geyBpZGVudGl0eUluZmVyZW5jZTogZXhhY3QgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAoIXBlcnNpc3RlZC5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogcGVyc2lzdGVkLmNvZGUsIGRldGFpbDogcGVyc2lzdGVkLmRldGFpbCB9LFxuICAgICAgICBwZXJzaXN0ZWQuY29kZSA9PT0gJ2NhcC1leGhhdXN0ZWQnID8gNDAyIDogcGVyc2lzdGVkLmNvZGUgPT09ICdhbHJlYWR5LXNldHRsZWQnID8gNDA5IDpcbiAgICAgICAgICBwZXJzaXN0ZWQuY29kZSA9PT0gJ3Vua25vd24tcmVzZXJ2YXRpb24nID8gNDA0IDogNDIyLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7IHNldHRsZWQ6IHRydWUsIHJlY2VpcHQ6IHJlY2VpcHRKc29uKHBlcnNpc3RlZC5yZWNlaXB0KSB9KTtcbiAgfSk7XG5cbiAgLy8g4pSA4pSAIFJFQUQsIGZvciB0aGUgYnV5ZXIgdGhhdCBmdW5kZWQgdGhlIGNoYW5uZWwgYW5kIHRoZSBzZWxsZXIgaXQgcGF5cyDilIDilIDilIBcbiAgcm91dGUuZ2V0KCcvY29tbWVyY2UvcGF5bWVudC1jaGFubmVscy86Y2hhbm5lbElkL3VzYWdlJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgY29uc3QgY2hhbm5lbElkID0gYy5yZXEucGFyYW0oJ2NoYW5uZWxJZCcpO1xuICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBnZXRQYXltZW50Q2hhbm5lbChjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBpZiAoIWNoYW5uZWwpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Vua25vd25fY2hhbm5lbCcsIGRldGFpbDogYHBheW1lbnQgY2hhbm5lbCAke2NoYW5uZWxJZH0gZG9lcyBub3QgZXhpc3RgIH0sIDQwNCk7XG4gICAgY29uc3QgcmVjZWlwdHMgPSBhd2FpdCBsaXN0Q2hhbm5lbFVzYWdlUmVjZWlwdHMoYy5lbnYuREIsIGNoYW5uZWxJZCk7XG4gICAgY29uc3QgaXNTZWxsZXIgPSByZWNlaXB0cy5zb21lKChyKSA9PiByLnNlbGxlciA9PT0gYXV0aC5wcmluY2lwYWxJZCk7XG4gICAgaWYgKGNoYW5uZWwucHJpbmNpcGFsSWQgIT09IGF1dGgucHJpbmNpcGFsSWQgJiYgIWlzU2VsbGVyKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmb3JiaWRkZW4nLCBkZXRhaWw6ICdvbmx5IHRoZSBmdW5kaW5nIHByaW5jaXBhbCBvciBhIG5hbWVkIHNlbGxlciBjYW4gcmVhZCB0aGlzIHVzYWdlJyB9LCA0MDMpO1xuICAgIH1cbiAgICBjb25zdCB2aXNpYmxlID0gY2hhbm5lbC5wcmluY2lwYWxJZCA9PT0gYXV0aC5wcmluY2lwYWxJZCA/IHJlY2VpcHRzIDogcmVjZWlwdHMuZmlsdGVyKChyKSA9PiByLnNlbGxlciA9PT0gYXV0aC5wcmluY2lwYWxJZCk7XG4gICAgY29uc3QgaWRlbnRpdHlPZmZlcklkID0gYy5yZXEucXVlcnkoJ2lkZW50aXR5T2ZmZXJJZCcpO1xuICAgIGxldCBpZGVudGl0eU1hcmt1cE9yaWdpbjtcbiAgICBpZiAoaWRlbnRpdHlPZmZlcklkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IG9mZmVyZWQgPSBhd2FpdCBnZXRDb21tZXJjZU9mZmVyKGMuZW52LkRCLCBpZGVudGl0eU9mZmVySWQpO1xuICAgICAgaWYgKCFvZmZlcmVkIHx8ICFvZmZlcmVkLnBlclVzZSB8fCAhb2ZmZXJlZC5za3VSZWYuc3RhcnRzV2l0aCgnaWRlbnRpdHktcmVsZWFzZTonKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmtub3duX2lkZW50aXR5X29mZmVyJyB9LCA0MDQpO1xuICAgICAgfVxuICAgICAgaWYgKCFvZmZlcmVkLmFjdGl2ZSB8fCAhb2ZmZXJlZC5wcm9kdWN0QWN0aXZlKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbmFjdGl2ZV9vZmZlcicgfSwgNDIyKTtcbiAgICAgIGlmIChjaGFubmVsLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkICYmICF2aXNpYmxlLnNvbWUoKHIpID0+IHIub2ZmZXJJZCA9PT0gaWRlbnRpdHlPZmZlcklkKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmb3JiaWRkZW4nIH0sIDQwMyk7XG4gICAgICB9XG4gICAgICBjb25zdCBvZmZlciA9IHsgc2t1UmVmOiBvZmZlcmVkLnNrdVJlZiwgLi4ub2ZmZXJlZC5wZXJVc2UgfTtcbiAgICAgIGNvbnN0IHZhbGlkID0gcXVvdGVJZGVudGl0eUluZmVyZW5jZVR1cm4oeyBvZmZlciwgYmlsbGVkSW5mZXJlbmNlTWljcm9zOiAwbiwgaW5mZXJlbmNlQ2VpbGluZ01pY3JvczogMW4gfSk7XG4gICAgICBpZiAoIXZhbGlkLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHZhbGlkLmNvZGUgfSwgNDIyKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlkZW50aXR5TWFya3VwT3JpZ2luID0geyBvZmZlcklkOiBpZGVudGl0eU9mZmVySWQsIHBheWVyOiBjaGFubmVsLnByaW5jaXBhbElkLCBzZWxsZXI6IG9mZmVyZWQuY3JlYXRvcklkLFxuICAgICAgICAgIG9mZmVyLCByZW1haW5kZXJOdW1lcmF0b3I6IFN0cmluZyhhd2FpdCByZWFkSWRlbnRpdHlNYXJrdXBSZW1haW5kZXIoYy5lbnYuREIsIGNoYW5uZWwucHJpbmNpcGFsSWQsIGlkZW50aXR5T2ZmZXJJZCkpIH07XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaWRlbnRpdHktaGlzdG9yeS11bnZlcmlmaWFibGUnIH0sIDQyMik7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHJlbmRlcmVkUmVjZWlwdHMgPSB2aXNpYmxlLm1hcChyZWNlaXB0SnNvbik7XG4gICAgcmV0dXJuIGMuanNvbih7XG4gICAgICBjaGFubmVsSWQsXG4gICAgICBlc2Nyb3dNaWNyb3M6IFN0cmluZyhjaGFubmVsLmVzY3Jvd01pY3JvcyksXG4gICAgICBjb21taXR0ZWRNaWNyb3M6IFN0cmluZyhjaGFubmVsLmNvbW1pdHRlZE1pY3JvcyksXG4gICAgICByZWNlaXB0czogcmVuZGVyZWRSZWNlaXB0cyxcbiAgICAgIGlkZW50aXR5U3RhdGVtZW50OiBpZGVudGl0eVVzYWdlU3RhdGVtZW50KHJlbmRlcmVkUmVjZWlwdHMsIGF1dGgucHJpbmNpcGFsSWQpLFxuICAgICAgLi4uKGlkZW50aXR5TWFya3VwT3JpZ2luID8geyBpZGVudGl0eU1hcmt1cE9yaWdpbiB9IDoge30pLFxuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4gcm91dGU7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL21ldGVyZWQtdXNhZ2UudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9tZXRlcmVkLXVzYWdlLnRzIiwiL3NyYy9yb3V0ZXMvbWV0ZXJlZC11c2FnZS50cyIsW11d
}}