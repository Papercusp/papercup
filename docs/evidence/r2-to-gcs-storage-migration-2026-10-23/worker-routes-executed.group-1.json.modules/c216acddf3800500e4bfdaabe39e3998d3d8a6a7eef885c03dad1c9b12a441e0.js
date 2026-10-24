__vite_ssr_exportName__("resolveSplitConfig", () => { try { return resolveSplitConfig } catch {} });
__vite_ssr_exportName__("resolveUsageSplitManifest", () => { try { return resolveUsageSplitManifest } catch {} });
__vite_ssr_exportName__("settlementsRoute", () => { try { return settlementsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/evm-settlement.ts", {"importedNames":["assessClaimFinality","buildSettlementProofEvent","isSettlementFrozen","planBatchSettlement","unwindReorgedClaim"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/commerce-events.ts", {"importedNames":["commerceEventSigningBytes"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/microcharge.ts", {"importedNames":["paymentVoucherDigest","unsignedVoucher","verifyPaymentVoucherSignature"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/identity-per-use-offer.ts", {"importedNames":["isIdentityReleaseSkuRef","verifyIdentityPerUseOffer"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/revenue-settlement.ts", {"importedNames":["REVENUE_SHARES","revenueSplitManifest","validateRevenueSplit"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/src/payment-channel-store.ts", {"importedNames":["getPaymentChannel"]});
const __vite_ssr_import_8__ = await __vite_ssr_import__("/src/usage-receipt-store.ts", {"importedNames":["listChannelUsageReceipts"]});
const __vite_ssr_import_9__ = await __vite_ssr_import__("/src/settlement-facilitator.ts", {"importedNames":["createViemSettlementFacilitator"]});
const __vite_ssr_import_10__ = await __vite_ssr_import__("/src/commerce-event-log-store.ts", {"importedNames":["appendCommerceEvent","nextCommerceEventSequence"]});
const __vite_ssr_import_11__ = await __vite_ssr_import__("/src/settlement-batch-store.ts", {"importedNames":["claimedUsageNonces","getSettlementBatch","getLiveSettlementBatchByRequestHash","settlementClaimAttempts","listChannelSettlementBatches","markSettlementDisputed","markSettlementDisputeDismissed","markSettlementFinal","markSettlementRefunded","paymentChannelStateFromBatches","recordSettlementClaim","recordSettlementConfirmations","unwindReorgedBatch"]});












const MAX_BATCH_SIZE = 200;
function principalId(user) {
  return `gh:${user.id}`;
}
async function authenticate(request) {
  try {
    return { ok: true, principalId: principalId(await (0,__vite_ssr_import_6__.resolveGithubBearer)(request)) };
  } catch (error) {
    if (error instanceof __vite_ssr_import_6__.AuthError) return { ok: false, reason: error.reason };
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
function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function resolveSplitConfig(env) {
  const raw = typeof env.REVENUE_SPLIT_MANIFEST === "string" ? env.REVENUE_SPLIT_MANIFEST.trim() : "";
  const daoTreasury = typeof env.DAO_TREASURY_ADDRESS === "string" ? env.DAO_TREASURY_ADDRESS.trim() : "";
  const missing = [raw ? null : "REVENUE_SPLIT_MANIFEST", daoTreasury ? null : "DAO_TREASURY_ADDRESS"].filter(
    (name) => name !== null
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: "not-configured",
      detail: `settlement accounting is unavailable; missing ${missing.join(", ")}`
    };
  };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid-config", detail: "REVENUE_SPLIT_MANIFEST is not valid JSON" };
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "invalid-config", detail: "REVENUE_SPLIT_MANIFEST must be a JSON object" };
  };
  const source = parsed;
  if (typeof source.version !== "string" || !source.version.trim()) {
    return { ok: false, code: "invalid-config", detail: "REVENUE_SPLIT_MANIFEST needs a non-empty version" };
  };
  if (!source.sharesBps || typeof source.sharesBps !== "object" || Array.isArray(source.sharesBps)) {
    return { ok: false, code: "invalid-config", detail: "REVENUE_SPLIT_MANIFEST needs a sharesBps object" };
  };
  const shareSource = source.sharesBps;
  const sharesBps = {};
  for (const share of __vite_ssr_import_5__.REVENUE_SHARES) {
    const value = shareSource[share] ?? 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1e4) {
      return {
        ok: false,
        code: "invalid-config",
        detail: `REVENUE_SPLIT_MANIFEST share '${share}' must be an integer basis-point value`
      };
    };
    sharesBps[share] = value;
  };
  if (source.componentDependencies !== void 0 && !Array.isArray(source.componentDependencies)) {
    return { ok: false, code: "invalid-config", detail: "componentDependencies must be an array of exact author pins" };
  };
  const manifest = (0,__vite_ssr_import_5__.revenueSplitManifest)({
    version: source.version,
    sharesBps,
    ...source.componentDependencies !== void 0 ? {
      componentDependencies: source.componentDependencies
    } : {}
  });
  const checked = (0,__vite_ssr_import_5__.validateRevenueSplit)(manifest);
  if (!checked.ok) return { ok: false, code: "invalid-config", detail: checked.detail };
  return {
    ok: true,
    manifest,
    daoTreasury
  };
};
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
function resolveUsageSplitManifest(receipts, fallback) {
  let manifest;
  for (const receipt of receipts) {
    if ((0,__vite_ssr_import_3__.paymentVoucherDigest)((0,__vite_ssr_import_3__.unsignedVoucher)(voucherFromReceipt(receipt))) !== receipt.voucherDigest) {
      return { ok: false, detail: `usage receipt ${receipt.usageNonce} no longer matches its signed voucher digest` };
    };
    let selected = fallback;
    if ((0,__vite_ssr_import_4__.isIdentityReleaseSkuRef)(receipt.releaseRef)) {
      const verified = (0,__vite_ssr_import_4__.verifyIdentityPerUseOffer)({
        skuRef: receipt.releaseRef,
        meterUnit: receipt.meterUnit,
        unitPriceMicros: receipt.unitPriceMicros,
        priceVersion: receipt.priceVersion,
        splitManifestHash: receipt.splitManifestHash
      });
      if (!verified.ok) return { ok: false, detail: verified.detail };
      selected = verified.manifest;
    };
    if (receipt.splitManifestHash !== selected.manifestHash || manifest && manifest.manifestHash !== selected.manifestHash) {
      return { ok: false, detail: `usage receipt ${receipt.usageNonce} needs a different exact split manifest` };
    };
    manifest = selected;
  };
  return manifest ? { ok: true, manifest } : { ok: false, detail: "batch has no retained signed usage receipts" };
};
function batchJson(batch) {
  return {
    batchId: batch.batchId,
    channelId: batch.channelId,
    requestHash: batch.requestHash,
    chainId: batch.chainId,
    claimMicros: batch.claimMicros,
    cumulativeClaimMicros: batch.cumulativeClaimMicros,
    voucherDigests: [...batch.voucherDigests],
    settlementId: batch.settlementId,
    splitManifestHash: batch.splitManifestHash,
    allocationsMicros: batch.allocationsMicros,
    ...batch.componentAllocationsMicros !== void 0 ? { componentAllocationsMicros: batch.componentAllocationsMicros } : {},
    providerCostMicros: batch.providerCostMicros,
    distributableMicros: batch.distributableMicros,
    daoTreasury: batch.daoTreasury,
    receiptHash: batch.receiptHash,
    state: batch.state,
    // Acceptance line 14: a claim is reported as a claim.
    final: batch.state === "final",
    confirmations: batch.confirmations,
    requiredConfirmations: batch.requiredConfirmations,
    claimTransactionHash: batch.claimReceipt.transactionHash,
    claimBlockNumber: batch.claimReceipt.blockNumber.toString(),
    claimBlockHash: batch.claimReceipt.blockHash,
    refundTransactionHash: batch.refundTransactionHash,
    freezeReason: batch.freezeReason,
    createdAtMs: batch.createdAtMs,
    updatedAtMs: batch.updatedAtMs,
    finalizedAtMs: batch.finalizedAtMs
  };
}
function facilitatorFor(env, injected) {
  return injected ? { ok: true, facilitator: injected } : (0,__vite_ssr_import_9__.createViemSettlementFacilitator)(env);
}
async function recordSettlementProof(db, facilitator, input) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sequence = await (0,__vite_ssr_import_10__.nextCommerceEventSequence)(db, input.streamId);
    const unsigned = (0,__vite_ssr_import_1__.buildSettlementProofEvent)({
      streamId: input.streamId,
      issuer: facilitator.signerAddress,
      sequence,
      occurredAtMs: input.nowMs,
      plan: input.plan,
      finality: input.finality,
      confirmations: input.confirmations,
      chainId: facilitator.chainId,
      transaction: input.transaction
    });
    const signature = await facilitator.signSettlementProof((0,__vite_ssr_import_2__.commerceEventSigningBytes)(unsigned));
    const event = { ...unsigned, signature };
    const appended = await (0,__vite_ssr_import_10__.appendCommerceEvent)(db, event, input.nowMs);
    if (appended.ok) return { ok: true, event: appended.event.event };
    if (appended.code !== "sequence-conflict") return { ok: false, detail: appended.detail };
  };
  return { ok: false, detail: "settlement proof could not be sequenced onto the commerce event log" };
}
function settlementStream(channelId) {
  return `settlement:${channelId}`;
}
function settlementsRoute(options = {}) {
  const route = new __vite_ssr_import_0__.Hono();
  route.post("/commerce/payment-channels/:channelId/settlements", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    if (!validId(channelId)) return c.json({ error: "invalid_request" }, 400);
    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const facilitator = availability.facilitator;
    const split = resolveSplitConfig(c.env);
    if (!split.ok) return c.json({ error: split.code, detail: split.detail }, 503);
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: "channel_not_found" }, 404);
    };
    if (channel.state !== "open") return c.json({ error: `channel_${channel.state}` }, 409);
    const batches = await (0,__vite_ssr_import_11__.listChannelSettlementBatches)(c.env.DB, channelId);
    const freeze = (0,__vite_ssr_import_1__.isSettlementFrozen)(batches);
    if (freeze.frozen) {
      return c.json({ error: "settlement_frozen", reason: freeze.reason, detail: freeze.detail }, 409);
    };
    const consumed = await (0,__vite_ssr_import_11__.claimedUsageNonces)(c.env.DB, channelId);
    let pending = (await (0,__vite_ssr_import_8__.listChannelUsageReceipts)(c.env.DB, channelId)).filter((receipt2) => receipt2.state === "settled" && (receipt2.amountMicros ?? 0) > 0 && !consumed.has(receipt2.usageNonce)).slice().sort((a, b) => a.cumulativeClaimMicros - b.cumulativeClaimMicros).slice(0, MAX_BATCH_SIZE);
    if (pending.length === 0) return c.json({ error: "no_settled_usage" }, 409);
    const boundary = pending.findIndex((receipt2) => receipt2.splitManifestHash !== pending[0].splitManifestHash);
    if (boundary > 0) pending = pending.slice(0, boundary);
    const receiptSplit = resolveUsageSplitManifest(pending, split.manifest);
    if (!receiptSplit.ok) {
      return c.json(
        {
          error: "split_manifest_mismatch",
          detail: receiptSplit.detail
        },
        409
      );
    };
    const config = {
      chainId: facilitator.chainId,
      settlementContract: facilitator.settlementContract,
      stablecoin: facilitator.stablecoin,
      maxBatchSize: MAX_BATCH_SIZE
    };
    const nowMs = Date.now();
    const planned = (0,__vite_ssr_import_1__.planBatchSettlement)({
      config,
      channel: (0,__vite_ssr_import_11__.paymentChannelStateFromBatches)({
        channelId,
        escrowMicros: channel.escrowMicros,
        batches
      }),
      vouchers: pending.map(voucherFromReceipt),
      verifySignature: (voucher) => (0,__vite_ssr_import_3__.verifyPaymentVoucherSignature)(voucher, {
        channelId: channel.channelId,
        payer: channel.principalId,
        pubkeyBase64: channel.payerPubkeyBase64 ?? ""
      }),
      nowMs,
      settlementId: `settlement:${channelId}:${pending[pending.length - 1].cumulativeClaimMicros}`,
      splitManifest: receiptSplit.manifest,
      daoTreasury: split.daoTreasury
    });
    if (!planned.ok) {
      const status = planned.code === "escrow-exhausted" || planned.code === "duplicate-claim" ? 409 : 422;
      return c.json({ error: planned.code, detail: planned.detail }, status);
    };
    const existing = await (0,__vite_ssr_import_11__.getLiveSettlementBatchByRequestHash)(
      c.env.DB,
      channelId,
      planned.plan.request.requestHash
    );
    if (existing) return c.json({ replayed: true, batch: batchJson(existing) }, 200);
    const attempt = await (0,__vite_ssr_import_11__.settlementClaimAttempts)(c.env.DB, channelId, planned.plan.request.requestHash);
    let receipt;
    try {
      receipt = await facilitator.submitBatchClaim(planned.plan.request);
    } catch (error) {
      return c.json(
        { error: "rail_claim_failed", detail: error instanceof Error ? error.message : String(error) },
        502
      );
    };
    const recorded = await (0,__vite_ssr_import_11__.recordSettlementClaim)(c.env.DB, {
      // The attempt ordinal keeps a post-reorg re-claim of the same voucher set
      // a DISTINCT row, so the void batch and its replacement both stay
      // auditable instead of one overwriting the other.
      batchId: `batch:${channelId}:${planned.plan.request.requestHash.slice(0, 32)}:${attempt}`,
      channelId,
      principalId: auth.principalId,
      plan: planned.plan,
      receipt,
      requiredConfirmations: facilitator.requiredConfirmations,
      // The block a transaction is mined into is its first confirmation. It is
      // still only a CLAIM: `final` requires the configured depth.
      confirmations: 1,
      usageNonces: pending.map((entry) => entry.usageNonce),
      nowMs
    });
    if (!recorded.ok) {
      return c.json({ error: "voucher_already_claimed", detail: recorded.detail }, 409);
    };
    const proof = await recordSettlementProof(c.env.DB, facilitator, {
      streamId: settlementStream(channelId),
      plan: planned.plan,
      finality: "claimed",
      confirmations: recorded.batch.confirmations,
      transaction: recorded.batch.claimReceipt,
      nowMs
    });
    if (!proof.ok) {
      return c.json(
        { error: "settlement_proof_unrecorded", detail: proof.detail, batch: batchJson(recorded.batch) },
        500
      );
    };
    return c.json(
      { replayed: !recorded.created, batch: batchJson(recorded.batch), proofEventId: proof.event.eventId },
      recorded.created ? 201 : 200
    );
  });
  route.get("/commerce/payment-channels/:channelId/settlements", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    if (!validId(channelId)) return c.json({ error: "invalid_request" }, 400);
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: "channel_not_found" }, 404);
    };
    const batches = await (0,__vite_ssr_import_11__.listChannelSettlementBatches)(c.env.DB, channelId);
    return c.json({
      batches: batches.map(batchJson),
      freeze: (0,__vite_ssr_import_1__.isSettlementFrozen)(batches)
    });
  });
  route.post("/commerce/payment-channels/:channelId/settlements/:batchId/finality", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    const batchId = c.req.param("batchId");
    if (!validId(channelId)) return c.json({ error: "invalid_request" }, 400);
    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const facilitator = availability.facilitator;
    const batch = await (0,__vite_ssr_import_11__.getSettlementBatch)(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: "batch_not_found" }, 404);
    };
    if (batch.state === "final") {
      return c.json({ verdict: { state: "final", final: true, confirmations: batch.confirmations }, batch: batchJson(batch) }, 200);
    };
    if (batch.state !== "claimed") return c.json({ error: `batch_${batch.state}` }, 409);
    let observation;
    try {
      observation = await facilitator.observeTransaction(batch.claimReceipt.transactionHash);
    } catch (error) {
      return c.json(
        { error: "rail_observation_failed", detail: error instanceof Error ? error.message : String(error) },
        502
      );
    };
    const verdict = (0,__vite_ssr_import_1__.assessClaimFinality)({
      claim: batch.claimReceipt,
      observation,
      requiredConfirmations: batch.requiredConfirmations
    });
    const nowMs = Date.now();
    if (verdict.state === "reorged") {
      const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
      if (!channel) return c.json({ error: "channel_not_found" }, 404);
      const unwound = (0,__vite_ssr_import_1__.unwindReorgedClaim)({
        channel: (0,__vite_ssr_import_11__.paymentChannelStateFromBatches)({
          channelId,
          escrowMicros: channel.escrowMicros,
          batches: await (0,__vite_ssr_import_11__.listChannelSettlementBatches)(c.env.DB, channelId)
        }),
        claimMicros: BigInt(batch.claimMicros),
        voucherDigests: batch.voucherDigests,
        priorCumulativeMicros: BigInt(batch.priorCumulativeMicros)
      });
      if (!unwound.ok) {
        const frozen = await (0,__vite_ssr_import_11__.unwindReorgedBatch)(c.env.DB, batchId, `reorg-${verdict.reason}`, nowMs);
        return c.json(
          { error: "reorg_unwind_failed", detail: unwound.detail, verdict, batch: batchJson(frozen) },
          500
        );
      };
      const recovered = await (0,__vite_ssr_import_11__.unwindReorgedBatch)(c.env.DB, batchId, `reorg-${verdict.reason}`, nowMs);
      return c.json({ verdict, recovered: recovered.recovered, batch: batchJson(recovered) }, 200);
    };
    if (verdict.state === "final") {
      const finalized = await (0,__vite_ssr_import_11__.markSettlementFinal)(c.env.DB, batchId, verdict.confirmations, nowMs);
      const proof = await recordSettlementProof(c.env.DB, facilitator, {
        streamId: settlementStream(channelId),
        plan: planFromBatch(finalized),
        finality: "final",
        confirmations: verdict.confirmations,
        transaction: finalized.claimReceipt,
        nowMs
      });
      if (!proof.ok) {
        return c.json(
          { error: "settlement_proof_unrecorded", detail: proof.detail, verdict, batch: batchJson(finalized) },
          500
        );
      };
      return c.json({ verdict, batch: batchJson(finalized), proofEventId: proof.event.eventId }, 200);
    };
    const updated = await (0,__vite_ssr_import_11__.recordSettlementConfirmations)(c.env.DB, batchId, verdict.confirmations, nowMs);
    return c.json({ verdict, batch: batchJson(updated) }, 200);
  });
  route.post("/commerce/payment-channels/:channelId/settlements/:batchId/dispute", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    const batchId = c.req.param("batchId");
    const body = await jsonObject(c.req.raw);
    const action = body?.action;
    const outcome = body?.outcome;
    if (!validId(channelId) || action !== "open" && action !== "resolve" || action === "resolve" && outcome !== "refund" && outcome !== "dismiss") {
      return c.json(
        {
          error: "invalid_request",
          detail: "action must be 'open' or 'resolve'; resolve requires outcome 'refund' or 'dismiss'"
        },
        400
      );
    };
    const batch = await (0,__vite_ssr_import_11__.getSettlementBatch)(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: "batch_not_found" }, 404);
    };
    const nowMs = Date.now();
    if (action === "open") {
      if (batch.state !== "claimed" && batch.state !== "final") {
        return c.json({ error: `batch_${batch.state}` }, 409);
      };
      const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : "disputed";
      const disputed = await (0,__vite_ssr_import_11__.markSettlementDisputed)(c.env.DB, batchId, reason, nowMs);
      return c.json({ batch: batchJson(disputed) }, 200);
    };
    if (batch.state !== "disputed") return c.json({ error: `batch_${batch.state}` }, 409);
    if (outcome === "dismiss") {
      const dismissed = await (0,__vite_ssr_import_11__.markSettlementDisputeDismissed)(c.env.DB, batchId, nowMs);
      return c.json({ batch: batchJson(dismissed) }, 200);
    };
    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!channel) return c.json({ error: "channel_not_found" }, 404);
    const refundAddress = channel.fundingSource.kind === "bound-wallet" ? channel.fundingSource.walletAddress : availability.facilitator.signerAddress;
    let refund;
    try {
      refund = await availability.facilitator.submitRefund({
        channelId,
        amountMicros: BigInt(batch.claimMicros),
        refundAddress
      });
    } catch (error) {
      return c.json(
        { error: "rail_refund_failed", detail: error instanceof Error ? error.message : String(error) },
        502
      );
    };
    const refunded = await (0,__vite_ssr_import_11__.markSettlementRefunded)(c.env.DB, batchId, refund, nowMs);
    return c.json({ batch: batchJson(refunded) }, 200);
  });
  return route;
};
function planFromBatch(batch) {
  const allocationsMicros = {};
  for (const share of __vite_ssr_import_5__.REVENUE_SHARES) {
    allocationsMicros[share] = BigInt(batch.allocationsMicros[share]);
  };
  const channel = {
    channelId: batch.channelId,
    rail: "evm-x402",
    escrowMicros: 0n,
    settledMicros: BigInt(batch.claimMicros),
    lastCumulativeMicros: BigInt(batch.cumulativeClaimMicros),
    claimedVoucherDigests: batch.voucherDigests
  };
  return {
    channel,
    priorChannel: { ...channel, settledMicros: 0n, lastCumulativeMicros: BigInt(batch.priorCumulativeMicros), claimedVoucherDigests: [] },
    claimMicros: BigInt(batch.claimMicros),
    cumulativeClaimMicros: BigInt(batch.cumulativeClaimMicros),
    voucherDigests: batch.voucherDigests,
    request: {
      chainId: batch.chainId,
      to: batch.settlementContractAddress,
      stablecoin: batch.stablecoinAddress,
      channelId: batch.channelId,
      amountMicros: BigInt(batch.claimMicros),
      voucherDigests: batch.voucherDigests,
      calldata: "0x",
      requestHash: batch.requestHash
    },
    receipt: {
      settlementId: batch.settlementId,
      currency: "stablecoin-micros",
      grossMicros: BigInt(batch.claimMicros),
      providerCostMicros: BigInt(batch.providerCostMicros),
      distributableMicros: BigInt(batch.distributableMicros),
      allocationsMicros,
      ...batch.componentAllocationsMicros !== void 0 ? {
        componentAllocationsMicros: Object.fromEntries(Object.entries(batch.componentAllocationsMicros).map(([author, amount]) => [author, BigInt(amount)]))
      } : {},
      daoTreasury: batch.daoTreasury,
      splitManifestHash: batch.splitManifestHash,
      receiptHash: batch.receiptHash
    }
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QVEsTUFBTSxNQUFNLENBQUMsUUFBUSxPQUFPLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFBQSxNQUN4RCxJQUFJLENBQUM7QUFBQSxNQUNMLGFBQWEsTUFBTTtBQUFBLE1BQ25CLG1CQUFtQixNQUFNO0FBQUEsTUFDekIsYUFBYSxNQUFNO0FBQUEsSUFDckI7QUFBQSxFQUNGO0FBQ0YiLCJuYW1lcyI6WyJyZWNlaXB0Il0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInNldHRsZW1lbnRzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXV0aGVudGljYXRlZCBwcm9kdWN0aW9uIGRvb3IgZm9yIFAtMDMzIGJhdGNoIHNldHRsZW1lbnQgZXhlY3V0aW9uLlxuICpcbiAqIFRoZSByb3V0ZSBiaW5kcyB0aGUgUC0wMjEgdm91Y2hlciBiYXRjaCBtYWNoaW5lLCB0aGUgUC0wMTggcmV2ZW51ZSBzcGxpdCwgYW5kXG4gKiB0aGUgUC0wMjIgRVZNIHJlcXVlc3QgYnVpbGRlciB0byBhIHNlbGYtaG9zdGVkIGZhY2lsaXRhdG9yIHRoYXQgYWN0dWFsbHlcbiAqIHN1Ym1pdHMgdGhlIGNsYWltIG9uIHRoZSBwaWxvdCBMMi4gR2l0SHViIGJlYXJlciBpZGVudGl0eSBzZWxlY3RzIHRoZSBjaGFubmVsO1xuICogY2FsbGVycyBjYW5ub3QgcHJvdmlkZSBhIHByaW5jaXBhbCwgc2lnbmVyLCBjb250cmFjdCwgY2hhaW4sIHRva2VuIGFkZHJlc3MsXG4gKiBzcGxpdCwgb3IgdHJlYXN1cnkg4oCUIGV2ZXJ5IG9uZSBvZiB0aG9zZSBjb21lcyBmcm9tIHRoZSBkZXBsb3ltZW50LlxuICpcbiAqIEFDQ0VQVEFOQ0UgTElORSAxNCBydW5zIHRocm91Z2ggdGhlIHdob2xlIGZpbGU6IGBQT1NUIC4uLi9zZXR0bGVtZW50c2AgcmV0dXJuc1xuICogYSBDTEFJTSAoYGZpbmFsOiBmYWxzZWApLCBhbmQgb25seSBgUE9TVCAuLi4vc2V0dGxlbWVudHMvOmJhdGNoSWQvZmluYWxpdHlgXG4gKiBjYW4gcHJvbW90ZSBpdCB0byBgZmluYWxgIGFmdGVyIG9ic2VydmluZyB0aGUgcmVxdWlyZWQgY29uZmlybWF0aW9uIGRlcHRoIOKAlFxuICogb3IgZGlzY292ZXIgYSByZW9yZyBhbmQgdW53aW5kIGl0IHNvIHRoZSB2b3VjaGVycyBiZWNvbWUgY2xhaW1hYmxlIGFnYWluLlxuICovXG5pbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQge1xuICBhc3Nlc3NDbGFpbUZpbmFsaXR5LFxuICBidWlsZFNldHRsZW1lbnRQcm9vZkV2ZW50LFxuICBpc1NldHRsZW1lbnRGcm96ZW4sXG4gIHBsYW5CYXRjaFNldHRsZW1lbnQsXG4gIHVud2luZFJlb3JnZWRDbGFpbSxcbiAgdHlwZSBCYXRjaFNldHRsZW1lbnRQbGFuLFxuICB0eXBlIEV2bVNldHRsZW1lbnRDb25maWcsXG4gIHR5cGUgRXZtU2V0dGxlbWVudEZhY2lsaXRhdG9yLFxufSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL3AycC9ldm0tc2V0dGxlbWVudC50cyc7XG5pbXBvcnQge1xuICBjb21tZXJjZUV2ZW50U2lnbmluZ0J5dGVzLFxuICB0eXBlIENvbW1lcmNlRXZlbnQsXG59IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL2NvbW1lcmNlLWV2ZW50cy50cyc7XG5pbXBvcnQgdHlwZSB7IEN1bXVsYXRpdmVQYXltZW50Vm91Y2hlciB9IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL21pY3JvY2hhcmdlLnRzJztcbmltcG9ydCB7IHBheW1lbnRWb3VjaGVyRGlnZXN0LCB1bnNpZ25lZFZvdWNoZXIsIHZlcmlmeVBheW1lbnRWb3VjaGVyU2lnbmF0dXJlIH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvbWljcm9jaGFyZ2UudHMnO1xuaW1wb3J0IHsgaXNJZGVudGl0eVJlbGVhc2VTa3VSZWYsIHZlcmlmeUlkZW50aXR5UGVyVXNlT2ZmZXIgfSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL2lkZW50aXR5LXBlci11c2Utb2ZmZXIudHMnO1xuaW1wb3J0IHtcbiAgUkVWRU5VRV9TSEFSRVMsXG4gIHJldmVudWVTcGxpdE1hbmlmZXN0LFxuICB2YWxpZGF0ZVJldmVudWVTcGxpdCxcbiAgdHlwZSBDb21wb25lbnRSZXZlbnVlRGVwZW5kZW5jeSxcbiAgdHlwZSBSZXZlbnVlU2hhcmUsXG4gIHR5cGUgUmV2ZW51ZVNwbGl0TWFuaWZlc3QsXG59IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL3JldmVudWUtc2V0dGxlbWVudC50cyc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQgeyBBdXRoRXJyb3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7IGdldFBheW1lbnRDaGFubmVsIH0gZnJvbSAnLi4vcGF5bWVudC1jaGFubmVsLXN0b3JlLnRzJztcbmltcG9ydCB7IGxpc3RDaGFubmVsVXNhZ2VSZWNlaXB0cywgdHlwZSBTdG9yZWRVc2FnZVJlY2VpcHQgfSBmcm9tICcuLi91c2FnZS1yZWNlaXB0LXN0b3JlLnRzJztcbmltcG9ydCB7IGNyZWF0ZVZpZW1TZXR0bGVtZW50RmFjaWxpdGF0b3IgfSBmcm9tICcuLi9zZXR0bGVtZW50LWZhY2lsaXRhdG9yLnRzJztcbmltcG9ydCB7XG4gIGFwcGVuZENvbW1lcmNlRXZlbnQsXG4gIG5leHRDb21tZXJjZUV2ZW50U2VxdWVuY2UsXG59IGZyb20gJy4uL2NvbW1lcmNlLWV2ZW50LWxvZy1zdG9yZS50cyc7XG5pbXBvcnQge1xuICBjbGFpbWVkVXNhZ2VOb25jZXMsXG4gIGdldFNldHRsZW1lbnRCYXRjaCxcbiAgZ2V0TGl2ZVNldHRsZW1lbnRCYXRjaEJ5UmVxdWVzdEhhc2gsXG4gIHNldHRsZW1lbnRDbGFpbUF0dGVtcHRzLFxuICBsaXN0Q2hhbm5lbFNldHRsZW1lbnRCYXRjaGVzLFxuICBtYXJrU2V0dGxlbWVudERpc3B1dGVkLFxuICBtYXJrU2V0dGxlbWVudERpc3B1dGVEaXNtaXNzZWQsXG4gIG1hcmtTZXR0bGVtZW50RmluYWwsXG4gIG1hcmtTZXR0bGVtZW50UmVmdW5kZWQsXG4gIHBheW1lbnRDaGFubmVsU3RhdGVGcm9tQmF0Y2hlcyxcbiAgcmVjb3JkU2V0dGxlbWVudENsYWltLFxuICByZWNvcmRTZXR0bGVtZW50Q29uZmlybWF0aW9ucyxcbiAgdW53aW5kUmVvcmdlZEJhdGNoLFxuICB0eXBlIFN0b3JlZFNldHRsZW1lbnRCYXRjaCxcbn0gZnJvbSAnLi4vc2V0dGxlbWVudC1iYXRjaC1zdG9yZS50cyc7XG5cbi8qKiBMYXJnZXN0IHZvdWNoZXIgYmF0Y2ggYSBzaW5nbGUgY2xhaW0gbWF5IGNhcnJ5IG9uIHRoZSBwaWxvdCByYWlsLiAqL1xuY29uc3QgTUFYX0JBVENIX1NJWkUgPSAyMDA7XG5cbmZ1bmN0aW9uIHByaW5jaXBhbElkKHVzZXI6IHsgaWQ6IG51bWJlciB9KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBnaDoke3VzZXIuaWR9YDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0aGVudGljYXRlKFxuICByZXF1ZXN0OiBSZXF1ZXN0LFxuKTogUHJvbWlzZTx7IG9rOiB0cnVlOyBwcmluY2lwYWxJZDogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgcmVhc29uOiBBdXRoRXJyb3JbJ3JlYXNvbiddIH0+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgcHJpbmNpcGFsSWQ6IHByaW5jaXBhbElkKGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIocmVxdWVzdCkpIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgQXV0aEVycm9yKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogZXJyb3IucmVhc29uIH07XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24ganNvbk9iamVjdChyZXF1ZXN0OiBSZXF1ZXN0KTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB2YWx1ZTogdW5rbm93biA9IGF3YWl0IHJlcXVlc3QuanNvbigpO1xuICAgIHJldHVybiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHZhbHVlKVxuICAgICAgPyAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgICA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkSWQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiAvXltBLVphLXowLTldW0EtWmEtejAtOS5fOi1dezAsMTk5fSQvLnRlc3QodmFsdWUpO1xufVxuXG5leHBvcnQgdHlwZSBTcGxpdENvbmZpZ1Jlc3VsdCA9XG4gIHwgeyByZWFkb25seSBvazogdHJ1ZTsgcmVhZG9ubHkgbWFuaWZlc3Q6IFJldmVudWVTcGxpdE1hbmlmZXN0OyByZWFkb25seSBkYW9UcmVhc3VyeTogc3RyaW5nIH1cbiAgfCB7IHJlYWRvbmx5IG9rOiBmYWxzZTsgcmVhZG9ubHkgY29kZTogJ25vdC1jb25maWd1cmVkJyB8ICdpbnZhbGlkLWNvbmZpZyc7IHJlYWRvbmx5IGRldGFpbDogc3RyaW5nIH07XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVwbG95bWVudCdzIHJldmVudWUgc3BsaXQgYW5kIHRyZWFzdXJ5LlxuICpcbiAqIFRoZSBtYW5pZmVzdCBIQVNIIGlzIGRlcml2ZWQgZnJvbSB0aGUgc2hhcmVzLCBuZXZlciBjb25maWd1cmVkIGJlc2lkZSB0aGVtIOKAlFxuICogYSBoYW5kLXdyaXR0ZW4gaGFzaCBjb3VsZCBkaXNhZ3JlZSB3aXRoIGl0cyBvd24gYm9keSwgYW5kIHRoYXQgaGFzaCBpcyB3aGF0XG4gKiB0aGUgcGF5ZXIgc2lnbmVkIGludG8gZXZlcnkgdm91Y2hlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTcGxpdENvbmZpZyhlbnY6IEVudik6IFNwbGl0Q29uZmlnUmVzdWx0IHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGVudi5SRVZFTlVFX1NQTElUX01BTklGRVNUID09PSAnc3RyaW5nJyA/IGVudi5SRVZFTlVFX1NQTElUX01BTklGRVNULnRyaW0oKSA6ICcnO1xuICBjb25zdCBkYW9UcmVhc3VyeSA9XG4gICAgdHlwZW9mIGVudi5EQU9fVFJFQVNVUllfQUREUkVTUyA9PT0gJ3N0cmluZycgPyBlbnYuREFPX1RSRUFTVVJZX0FERFJFU1MudHJpbSgpIDogJyc7XG4gIGNvbnN0IG1pc3NpbmcgPSBbcmF3ID8gbnVsbCA6ICdSRVZFTlVFX1NQTElUX01BTklGRVNUJywgZGFvVHJlYXN1cnkgPyBudWxsIDogJ0RBT19UUkVBU1VSWV9BRERSRVNTJ10uZmlsdGVyKFxuICAgIChuYW1lKTogbmFtZSBpcyBzdHJpbmcgPT4gbmFtZSAhPT0gbnVsbCxcbiAgKTtcbiAgaWYgKG1pc3NpbmcubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBjb2RlOiAnbm90LWNvbmZpZ3VyZWQnLFxuICAgICAgZGV0YWlsOiBgc2V0dGxlbWVudCBhY2NvdW50aW5nIGlzIHVuYXZhaWxhYmxlOyBtaXNzaW5nICR7bWlzc2luZy5qb2luKCcsICcpfWAsXG4gICAgfTtcbiAgfVxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1jb25maWcnLCBkZXRhaWw6ICdSRVZFTlVFX1NQTElUX01BTklGRVNUIGlzIG5vdCB2YWxpZCBKU09OJyB9O1xuICB9XG4gIGlmICghcGFyc2VkIHx8IHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiAnUkVWRU5VRV9TUExJVF9NQU5JRkVTVCBtdXN0IGJlIGEgSlNPTiBvYmplY3QnIH07XG4gIH1cbiAgY29uc3Qgc291cmNlID0gcGFyc2VkIGFzIHsgdmVyc2lvbj86IHVua25vd247IHNoYXJlc0Jwcz86IHVua25vd247IGNvbXBvbmVudERlcGVuZGVuY2llcz86IHVua25vd24gfTtcbiAgaWYgKHR5cGVvZiBzb3VyY2UudmVyc2lvbiAhPT0gJ3N0cmluZycgfHwgIXNvdXJjZS52ZXJzaW9uLnRyaW0oKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiAnUkVWRU5VRV9TUExJVF9NQU5JRkVTVCBuZWVkcyBhIG5vbi1lbXB0eSB2ZXJzaW9uJyB9O1xuICB9XG4gIGlmICghc291cmNlLnNoYXJlc0JwcyB8fCB0eXBlb2Ygc291cmNlLnNoYXJlc0JwcyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShzb3VyY2Uuc2hhcmVzQnBzKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiAnUkVWRU5VRV9TUExJVF9NQU5JRkVTVCBuZWVkcyBhIHNoYXJlc0JwcyBvYmplY3QnIH07XG4gIH1cbiAgY29uc3Qgc2hhcmVTb3VyY2UgPSBzb3VyY2Uuc2hhcmVzQnBzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCBzaGFyZXNCcHMgPSB7fSBhcyBSZWNvcmQ8UmV2ZW51ZVNoYXJlLCBudW1iZXI+O1xuICBmb3IgKGNvbnN0IHNoYXJlIG9mIFJFVkVOVUVfU0hBUkVTKSB7XG4gICAgY29uc3QgdmFsdWUgPSBzaGFyZVNvdXJjZVtzaGFyZV0gPz8gMDtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMCB8fCB2YWx1ZSA+IDEwXzAwMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBjb2RlOiAnaW52YWxpZC1jb25maWcnLFxuICAgICAgICBkZXRhaWw6IGBSRVZFTlVFX1NQTElUX01BTklGRVNUIHNoYXJlICcke3NoYXJlfScgbXVzdCBiZSBhbiBpbnRlZ2VyIGJhc2lzLXBvaW50IHZhbHVlYCxcbiAgICAgIH07XG4gICAgfVxuICAgIHNoYXJlc0Jwc1tzaGFyZV0gPSB2YWx1ZTtcbiAgfVxuICBpZiAoc291cmNlLmNvbXBvbmVudERlcGVuZGVuY2llcyAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHNvdXJjZS5jb21wb25lbnREZXBlbmRlbmNpZXMpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1jb25maWcnLCBkZXRhaWw6ICdjb21wb25lbnREZXBlbmRlbmNpZXMgbXVzdCBiZSBhbiBhcnJheSBvZiBleGFjdCBhdXRob3IgcGlucycgfTtcbiAgfVxuICBjb25zdCBtYW5pZmVzdCA9IHJldmVudWVTcGxpdE1hbmlmZXN0KHsgdmVyc2lvbjogc291cmNlLnZlcnNpb24sIHNoYXJlc0JwcyxcbiAgICAuLi4oc291cmNlLmNvbXBvbmVudERlcGVuZGVuY2llcyAhPT0gdW5kZWZpbmVkID8ge1xuICAgICAgY29tcG9uZW50RGVwZW5kZW5jaWVzOiBzb3VyY2UuY29tcG9uZW50RGVwZW5kZW5jaWVzIGFzIENvbXBvbmVudFJldmVudWVEZXBlbmRlbmN5W10sXG4gICAgfSA6IHt9KSB9KTtcbiAgY29uc3QgY2hlY2tlZCA9IHZhbGlkYXRlUmV2ZW51ZVNwbGl0KG1hbmlmZXN0KTtcbiAgaWYgKCFjaGVja2VkLm9rKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdpbnZhbGlkLWNvbmZpZycsIGRldGFpbDogY2hlY2tlZC5kZXRhaWwgfTtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBtYW5pZmVzdCxcbiAgICBkYW9UcmVhc3VyeSxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZWJ1aWxkIHRoZSBleGFjdCB2b3VjaGVyIHRoZSBwYXllciBzaWduZWQgZnJvbSBpdHMgZHVyYWJsZSByZWNlaXB0IHJvdy5cbiAqXG4gKiBFdmVyeSBmaWVsZCB0aGF0IGdvZXMgaW50byBgcGF5bWVudFZvdWNoZXJTaWduaW5nQnl0ZXNgIGlzIHN0b3JlZCAobWlnIDAyNSksXG4gKiBzbyB0aGUgZGlnZXN0IGlzIHJlLWRlcml2ZWQgZnJvbSB0aGUgcmVjb3JkIHJhdGhlciB0aGFuIHRydXN0ZWQgZnJvbSBhXG4gKiBjbGllbnQtc3VwcGxpZWQgdmFsdWUuXG4gKi9cbmZ1bmN0aW9uIHZvdWNoZXJGcm9tUmVjZWlwdChyZWNlaXB0OiBTdG9yZWRVc2FnZVJlY2VpcHQpOiBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXIge1xuICByZXR1cm4ge1xuICAgIGNoYW5uZWxJZDogcmVjZWlwdC5jaGFubmVsSWQsXG4gICAgcGF5ZXI6IHJlY2VpcHQucGF5ZXIsXG4gICAgc2VsbGVyOiByZWNlaXB0LnNlbGxlcixcbiAgICByZWxlYXNlUmVmOiByZWNlaXB0LnJlbGVhc2VSZWYsXG4gICAgdXNhZ2VOb25jZTogcmVjZWlwdC51c2FnZU5vbmNlLFxuICAgIG1ldGVyUXVhbnRpdHk6IEJpZ0ludChyZWNlaXB0LnJlc2VydmVkTWV0ZXJRdWFudGl0eSksXG4gICAgcHJpY2VQZXJVbml0TWljcm9zOiBCaWdJbnQocmVjZWlwdC51bml0UHJpY2VNaWNyb3MpLFxuICAgIHByaWNlVmVyc2lvbjogcmVjZWlwdC5wcmljZVZlcnNpb24sXG4gICAgc3BsaXRNYW5pZmVzdEhhc2g6IHJlY2VpcHQuc3BsaXRNYW5pZmVzdEhhc2gsXG4gICAgZXhwaXJlc0F0TXM6IHJlY2VpcHQuZXhwaXJlc0F0TXMsXG4gICAgY3VtdWxhdGl2ZUNsYWltTWljcm9zOiBCaWdJbnQocmVjZWlwdC5jdW11bGF0aXZlQ2xhaW1NaWNyb3MpLFxuICAgIHNpZ25hdHVyZTogcmVjZWlwdC52b3VjaGVyU2lnbmF0dXJlLFxuICB9O1xufVxuXG4vKiogUmV1c2UgdGhlIGV4YWN0IHNpZ25lZCBwcmljZSB0ZXJtczsgYSBkZXBsb3ltZW50IGNhbm5vdCByZXBsYWNlIGFuIGlkZW50aXR5J3MgcGlucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVXNhZ2VTcGxpdE1hbmlmZXN0KFxuICByZWNlaXB0czogcmVhZG9ubHkgU3RvcmVkVXNhZ2VSZWNlaXB0W10sIGZhbGxiYWNrOiBSZXZlbnVlU3BsaXRNYW5pZmVzdCxcbik6IHsgb2s6IHRydWU7IG1hbmlmZXN0OiBSZXZlbnVlU3BsaXRNYW5pZmVzdCB9IHwgeyBvazogZmFsc2U7IGRldGFpbDogc3RyaW5nIH0ge1xuICBsZXQgbWFuaWZlc3Q6IFJldmVudWVTcGxpdE1hbmlmZXN0IHwgdW5kZWZpbmVkO1xuICBmb3IgKGNvbnN0IHJlY2VpcHQgb2YgcmVjZWlwdHMpIHtcbiAgICBpZiAocGF5bWVudFZvdWNoZXJEaWdlc3QodW5zaWduZWRWb3VjaGVyKHZvdWNoZXJGcm9tUmVjZWlwdChyZWNlaXB0KSkpICE9PSByZWNlaXB0LnZvdWNoZXJEaWdlc3QpIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiBgdXNhZ2UgcmVjZWlwdCAke3JlY2VpcHQudXNhZ2VOb25jZX0gbm8gbG9uZ2VyIG1hdGNoZXMgaXRzIHNpZ25lZCB2b3VjaGVyIGRpZ2VzdGAgfTtcbiAgICB9XG4gICAgbGV0IHNlbGVjdGVkID0gZmFsbGJhY2s7XG4gICAgaWYgKGlzSWRlbnRpdHlSZWxlYXNlU2t1UmVmKHJlY2VpcHQucmVsZWFzZVJlZikpIHtcbiAgICAgIGNvbnN0IHZlcmlmaWVkID0gdmVyaWZ5SWRlbnRpdHlQZXJVc2VPZmZlcih7IHNrdVJlZjogcmVjZWlwdC5yZWxlYXNlUmVmLCBtZXRlclVuaXQ6IHJlY2VpcHQubWV0ZXJVbml0LFxuICAgICAgICB1bml0UHJpY2VNaWNyb3M6IHJlY2VpcHQudW5pdFByaWNlTWljcm9zLCBwcmljZVZlcnNpb246IHJlY2VpcHQucHJpY2VWZXJzaW9uLCBzcGxpdE1hbmlmZXN0SGFzaDogcmVjZWlwdC5zcGxpdE1hbmlmZXN0SGFzaCB9KTtcbiAgICAgIGlmICghdmVyaWZpZWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiB2ZXJpZmllZC5kZXRhaWwgfTtcbiAgICAgIHNlbGVjdGVkID0gdmVyaWZpZWQubWFuaWZlc3Q7XG4gICAgfVxuICAgIGlmIChyZWNlaXB0LnNwbGl0TWFuaWZlc3RIYXNoICE9PSBzZWxlY3RlZC5tYW5pZmVzdEhhc2ggfHxcbiAgICAgICAgKG1hbmlmZXN0ICYmIG1hbmlmZXN0Lm1hbmlmZXN0SGFzaCAhPT0gc2VsZWN0ZWQubWFuaWZlc3RIYXNoKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBkZXRhaWw6IGB1c2FnZSByZWNlaXB0ICR7cmVjZWlwdC51c2FnZU5vbmNlfSBuZWVkcyBhIGRpZmZlcmVudCBleGFjdCBzcGxpdCBtYW5pZmVzdGAgfTtcbiAgICB9XG4gICAgbWFuaWZlc3QgPSBzZWxlY3RlZDtcbiAgfVxuICByZXR1cm4gbWFuaWZlc3QgPyB7IG9rOiB0cnVlLCBtYW5pZmVzdCB9IDogeyBvazogZmFsc2UsIGRldGFpbDogJ2JhdGNoIGhhcyBubyByZXRhaW5lZCBzaWduZWQgdXNhZ2UgcmVjZWlwdHMnIH07XG59XG5cbmZ1bmN0aW9uIGJhdGNoSnNvbihiYXRjaDogU3RvcmVkU2V0dGxlbWVudEJhdGNoKSB7XG4gIHJldHVybiB7XG4gICAgYmF0Y2hJZDogYmF0Y2guYmF0Y2hJZCxcbiAgICBjaGFubmVsSWQ6IGJhdGNoLmNoYW5uZWxJZCxcbiAgICByZXF1ZXN0SGFzaDogYmF0Y2gucmVxdWVzdEhhc2gsXG4gICAgY2hhaW5JZDogYmF0Y2guY2hhaW5JZCxcbiAgICBjbGFpbU1pY3JvczogYmF0Y2guY2xhaW1NaWNyb3MsXG4gICAgY3VtdWxhdGl2ZUNsYWltTWljcm9zOiBiYXRjaC5jdW11bGF0aXZlQ2xhaW1NaWNyb3MsXG4gICAgdm91Y2hlckRpZ2VzdHM6IFsuLi5iYXRjaC52b3VjaGVyRGlnZXN0c10sXG4gICAgc2V0dGxlbWVudElkOiBiYXRjaC5zZXR0bGVtZW50SWQsXG4gICAgc3BsaXRNYW5pZmVzdEhhc2g6IGJhdGNoLnNwbGl0TWFuaWZlc3RIYXNoLFxuICAgIGFsbG9jYXRpb25zTWljcm9zOiBiYXRjaC5hbGxvY2F0aW9uc01pY3JvcyxcbiAgICAuLi4oYmF0Y2guY29tcG9uZW50QWxsb2NhdGlvbnNNaWNyb3MgIT09IHVuZGVmaW5lZCA/IHsgY29tcG9uZW50QWxsb2NhdGlvbnNNaWNyb3M6IGJhdGNoLmNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zIH0gOiB7fSksXG4gICAgcHJvdmlkZXJDb3N0TWljcm9zOiBiYXRjaC5wcm92aWRlckNvc3RNaWNyb3MsXG4gICAgZGlzdHJpYnV0YWJsZU1pY3JvczogYmF0Y2guZGlzdHJpYnV0YWJsZU1pY3JvcyxcbiAgICBkYW9UcmVhc3VyeTogYmF0Y2guZGFvVHJlYXN1cnksXG4gICAgcmVjZWlwdEhhc2g6IGJhdGNoLnJlY2VpcHRIYXNoLFxuICAgIHN0YXRlOiBiYXRjaC5zdGF0ZSxcbiAgICAvLyBBY2NlcHRhbmNlIGxpbmUgMTQ6IGEgY2xhaW0gaXMgcmVwb3J0ZWQgYXMgYSBjbGFpbS5cbiAgICBmaW5hbDogYmF0Y2guc3RhdGUgPT09ICdmaW5hbCcsXG4gICAgY29uZmlybWF0aW9uczogYmF0Y2guY29uZmlybWF0aW9ucyxcbiAgICByZXF1aXJlZENvbmZpcm1hdGlvbnM6IGJhdGNoLnJlcXVpcmVkQ29uZmlybWF0aW9ucyxcbiAgICBjbGFpbVRyYW5zYWN0aW9uSGFzaDogYmF0Y2guY2xhaW1SZWNlaXB0LnRyYW5zYWN0aW9uSGFzaCxcbiAgICBjbGFpbUJsb2NrTnVtYmVyOiBiYXRjaC5jbGFpbVJlY2VpcHQuYmxvY2tOdW1iZXIudG9TdHJpbmcoKSxcbiAgICBjbGFpbUJsb2NrSGFzaDogYmF0Y2guY2xhaW1SZWNlaXB0LmJsb2NrSGFzaCxcbiAgICByZWZ1bmRUcmFuc2FjdGlvbkhhc2g6IGJhdGNoLnJlZnVuZFRyYW5zYWN0aW9uSGFzaCxcbiAgICBmcmVlemVSZWFzb246IGJhdGNoLmZyZWV6ZVJlYXNvbixcbiAgICBjcmVhdGVkQXRNczogYmF0Y2guY3JlYXRlZEF0TXMsXG4gICAgdXBkYXRlZEF0TXM6IGJhdGNoLnVwZGF0ZWRBdE1zLFxuICAgIGZpbmFsaXplZEF0TXM6IGJhdGNoLmZpbmFsaXplZEF0TXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGZhY2lsaXRhdG9yRm9yKGVudjogRW52LCBpbmplY3RlZDogRXZtU2V0dGxlbWVudEZhY2lsaXRhdG9yIHwgdW5kZWZpbmVkKSB7XG4gIHJldHVybiBpbmplY3RlZCA/IHsgb2s6IHRydWUgYXMgY29uc3QsIGZhY2lsaXRhdG9yOiBpbmplY3RlZCB9IDogY3JlYXRlVmllbVNldHRsZW1lbnRGYWNpbGl0YXRvcihlbnYpO1xufVxuXG4vKipcbiAqIEFwcGVuZCBhIHNpZ25lZCBgc2V0dGxlbWVudC1wcm9vZmAgdG8gdGhlIFAtMDE2IGxvZy5cbiAqXG4gKiBBIHNlcXVlbmNlIGNvbGxpc2lvbiBpcyByZXRyaWVkIG9uY2UgYWdhaW5zdCBhIGZyZXNobHkgcmVhZCB3YXRlcm1hcms6IHR3b1xuICogY29uY3VycmVudCBwcm9vZnMgb24gdGhlIHNhbWUgY2hhbm5lbCBzdHJlYW0gaXMgYW4gb3JkaW5hcnkgcmFjZSwgbm90IGFcbiAqIGZhaWx1cmUgb2YgdGhlIHNldHRsZW1lbnQgaXRzZWxmLiBUaGUgY2xhaW0gaXMgYWxyZWFkeSBvbiBjaGFpbiBieSB0aGlzXG4gKiBwb2ludCwgc28gYSBwcm9vZiB0aGF0IGNhbm5vdCBiZSByZWNvcmRlZCBpcyByZXBvcnRlZCB0byB0aGUgY2FsbGVyIHJhdGhlclxuICogdGhhbiBzd2FsbG93ZWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlY29yZFNldHRsZW1lbnRQcm9vZihcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGZhY2lsaXRhdG9yOiBFdm1TZXR0bGVtZW50RmFjaWxpdGF0b3IsXG4gIGlucHV0OiB7XG4gICAgcmVhZG9ubHkgc3RyZWFtSWQ6IHN0cmluZztcbiAgICByZWFkb25seSBwbGFuOiBCYXRjaFNldHRsZW1lbnRQbGFuO1xuICAgIHJlYWRvbmx5IGZpbmFsaXR5OiAnY2xhaW1lZCcgfCAnZmluYWwnO1xuICAgIHJlYWRvbmx5IGNvbmZpcm1hdGlvbnM6IG51bWJlcjtcbiAgICByZWFkb25seSB0cmFuc2FjdGlvbjogU3RvcmVkU2V0dGxlbWVudEJhdGNoWydjbGFpbVJlY2VpcHQnXTtcbiAgICByZWFkb25seSBub3dNczogbnVtYmVyO1xuICB9LFxuKTogUHJvbWlzZTx7IG9rOiB0cnVlOyBldmVudDogQ29tbWVyY2VFdmVudCB9IHwgeyBvazogZmFsc2U7IGRldGFpbDogc3RyaW5nIH0+IHtcbiAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAyOyBhdHRlbXB0ICs9IDEpIHtcbiAgICBjb25zdCBzZXF1ZW5jZSA9IGF3YWl0IG5leHRDb21tZXJjZUV2ZW50U2VxdWVuY2UoZGIsIGlucHV0LnN0cmVhbUlkKTtcbiAgICBjb25zdCB1bnNpZ25lZCA9IGJ1aWxkU2V0dGxlbWVudFByb29mRXZlbnQoe1xuICAgICAgc3RyZWFtSWQ6IGlucHV0LnN0cmVhbUlkLFxuICAgICAgaXNzdWVyOiBmYWNpbGl0YXRvci5zaWduZXJBZGRyZXNzLFxuICAgICAgc2VxdWVuY2UsXG4gICAgICBvY2N1cnJlZEF0TXM6IGlucHV0Lm5vd01zLFxuICAgICAgcGxhbjogaW5wdXQucGxhbixcbiAgICAgIGZpbmFsaXR5OiBpbnB1dC5maW5hbGl0eSxcbiAgICAgIGNvbmZpcm1hdGlvbnM6IGlucHV0LmNvbmZpcm1hdGlvbnMsXG4gICAgICBjaGFpbklkOiBmYWNpbGl0YXRvci5jaGFpbklkLFxuICAgICAgdHJhbnNhY3Rpb246IGlucHV0LnRyYW5zYWN0aW9uLFxuICAgIH0pO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IGZhY2lsaXRhdG9yLnNpZ25TZXR0bGVtZW50UHJvb2YoY29tbWVyY2VFdmVudFNpZ25pbmdCeXRlcyh1bnNpZ25lZCkpO1xuICAgIGNvbnN0IGV2ZW50OiBDb21tZXJjZUV2ZW50ID0geyAuLi51bnNpZ25lZCwgc2lnbmF0dXJlIH07XG4gICAgY29uc3QgYXBwZW5kZWQgPSBhd2FpdCBhcHBlbmRDb21tZXJjZUV2ZW50KGRiLCBldmVudCwgaW5wdXQubm93TXMpO1xuICAgIGlmIChhcHBlbmRlZC5vaykgcmV0dXJuIHsgb2s6IHRydWUsIGV2ZW50OiBhcHBlbmRlZC5ldmVudC5ldmVudCB9O1xuICAgIGlmIChhcHBlbmRlZC5jb2RlICE9PSAnc2VxdWVuY2UtY29uZmxpY3QnKSByZXR1cm4geyBvazogZmFsc2UsIGRldGFpbDogYXBwZW5kZWQuZGV0YWlsIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IGZhbHNlLCBkZXRhaWw6ICdzZXR0bGVtZW50IHByb29mIGNvdWxkIG5vdCBiZSBzZXF1ZW5jZWQgb250byB0aGUgY29tbWVyY2UgZXZlbnQgbG9nJyB9O1xufVxuXG5mdW5jdGlvbiBzZXR0bGVtZW50U3RyZWFtKGNoYW5uZWxJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBzZXR0bGVtZW50OiR7Y2hhbm5lbElkfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXR0bGVtZW50c1JvdXRlKFxuICBvcHRpb25zOiB7IGZhY2lsaXRhdG9yPzogRXZtU2V0dGxlbWVudEZhY2lsaXRhdG9yIH0gPSB7fSxcbik6IEhvbm88eyBCaW5kaW5nczogRW52IH0+IHtcbiAgY29uc3Qgcm91dGUgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4oKTtcblxuICByb3V0ZS5wb3N0KCcvY29tbWVyY2UvcGF5bWVudC1jaGFubmVscy86Y2hhbm5lbElkL3NldHRsZW1lbnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgY29uc3QgY2hhbm5lbElkID0gYy5yZXEucGFyYW0oJ2NoYW5uZWxJZCcpO1xuICAgIGlmICghdmFsaWRJZChjaGFubmVsSWQpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnIH0sIDQwMCk7XG5cbiAgICBjb25zdCBhdmFpbGFiaWxpdHkgPSBmYWNpbGl0YXRvckZvcihjLmVudiwgb3B0aW9ucy5mYWNpbGl0YXRvcik7XG4gICAgaWYgKCFhdmFpbGFiaWxpdHkub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogYXZhaWxhYmlsaXR5LmNvZGUsIGRldGFpbDogYXZhaWxhYmlsaXR5LmRldGFpbCB9LCA1MDMpO1xuICAgIGNvbnN0IGZhY2lsaXRhdG9yID0gYXZhaWxhYmlsaXR5LmZhY2lsaXRhdG9yO1xuICAgIGNvbnN0IHNwbGl0ID0gcmVzb2x2ZVNwbGl0Q29uZmlnKGMuZW52KTtcbiAgICBpZiAoIXNwbGl0Lm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHNwbGl0LmNvZGUsIGRldGFpbDogc3BsaXQuZGV0YWlsIH0sIDUwMyk7XG5cbiAgICBjb25zdCBjaGFubmVsID0gYXdhaXQgZ2V0UGF5bWVudENoYW5uZWwoYy5lbnYuREIsIGNoYW5uZWxJZCk7XG4gICAgaWYgKCFjaGFubmVsIHx8IGNoYW5uZWwucHJpbmNpcGFsSWQgIT09IGF1dGgucHJpbmNpcGFsSWQpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NoYW5uZWxfbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIH1cbiAgICBpZiAoY2hhbm5lbC5zdGF0ZSAhPT0gJ29wZW4nKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGBjaGFubmVsXyR7Y2hhbm5lbC5zdGF0ZX1gIH0sIDQwOSk7XG5cbiAgICBjb25zdCBiYXRjaGVzID0gYXdhaXQgbGlzdENoYW5uZWxTZXR0bGVtZW50QmF0Y2hlcyhjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBjb25zdCBmcmVlemUgPSBpc1NldHRsZW1lbnRGcm96ZW4oYmF0Y2hlcyk7XG4gICAgaWYgKGZyZWV6ZS5mcm96ZW4pIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3NldHRsZW1lbnRfZnJvemVuJywgcmVhc29uOiBmcmVlemUucmVhc29uLCBkZXRhaWw6IGZyZWV6ZS5kZXRhaWwgfSwgNDA5KTtcbiAgICB9XG5cbiAgICBjb25zdCBjb25zdW1lZCA9IGF3YWl0IGNsYWltZWRVc2FnZU5vbmNlcyhjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBsZXQgcGVuZGluZyA9IChhd2FpdCBsaXN0Q2hhbm5lbFVzYWdlUmVjZWlwdHMoYy5lbnYuREIsIGNoYW5uZWxJZCkpXG4gICAgICAvLyBBIHNpZ25lZCB1bnVzZWQtdHVybiBjbG9zdXJlIHJlbGVhc2VzIGVzY3JvdyBhbmQgcmV0YWlucyBoaXN0b3J5LCBidXRcbiAgICAgIC8vIGNhcnJpZXMgbm8gcHJvY2VlZHMgZm9yIGFuIG9uLWNoYWluIHBheW1lbnQgY2xhaW0uXG4gICAgICAuZmlsdGVyKChyZWNlaXB0KSA9PiByZWNlaXB0LnN0YXRlID09PSAnc2V0dGxlZCcgJiYgKHJlY2VpcHQuYW1vdW50TWljcm9zID8/IDApID4gMCAmJiAhY29uc3VtZWQuaGFzKHJlY2VpcHQudXNhZ2VOb25jZSkpXG4gICAgICAuc2xpY2UoKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGEuY3VtdWxhdGl2ZUNsYWltTWljcm9zIC0gYi5jdW11bGF0aXZlQ2xhaW1NaWNyb3MpXG4gICAgICAuc2xpY2UoMCwgTUFYX0JBVENIX1NJWkUpO1xuICAgIGlmIChwZW5kaW5nLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm9fc2V0dGxlZF91c2FnZScgfSwgNDA5KTtcblxuICAgIC8vIFByZXNlcnZlIGNocm9ub2xvZ2ljYWwgY2xhaW0gYm91bmRhcmllcyB3aGlsZSBzZXR0bGluZyBvbmUgZXhhY3Qgc3BsaXRcbiAgICAvLyBhdCBhIHRpbWUuIFRoZSBuZXh0IGNhbGwgY2FuIGNsYWltIHRoZSBuZXh0IGhvbW9nZW5lb3VzIHByZWZpeC5cbiAgICBjb25zdCBib3VuZGFyeSA9IHBlbmRpbmcuZmluZEluZGV4KChyZWNlaXB0KSA9PiByZWNlaXB0LnNwbGl0TWFuaWZlc3RIYXNoICE9PSBwZW5kaW5nWzBdIS5zcGxpdE1hbmlmZXN0SGFzaCk7XG4gICAgaWYgKGJvdW5kYXJ5ID4gMCkgcGVuZGluZyA9IHBlbmRpbmcuc2xpY2UoMCwgYm91bmRhcnkpO1xuXG4gICAgLy8gVGhlIHNwbGl0IHRoZSBwYXllciBzaWduZWQgaW50byB0aGUgdm91Y2hlciBnb3Zlcm5zLiBBIGRlcGxveW1lbnQgd2hvc2VcbiAgICAvLyBjb25maWd1cmVkIHNwbGl0IGhhcyBtb3ZlZCBvbiBjYW5ub3QgcmV0cm9hY3RpdmVseSByZS1jdXQgYSBidXllcidzXG4gICAgLy8gcHVyY2hhc2UsIHNvIHRoZSBtaXNtYXRjaCBpcyBhIHJlZnVzYWwsIG5vdCBhIHJlLWNvbXB1dGF0aW9uLlxuICAgIGNvbnN0IHJlY2VpcHRTcGxpdCA9IHJlc29sdmVVc2FnZVNwbGl0TWFuaWZlc3QocGVuZGluZywgc3BsaXQubWFuaWZlc3QpO1xuICAgIGlmICghcmVjZWlwdFNwbGl0Lm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6ICdzcGxpdF9tYW5pZmVzdF9taXNtYXRjaCcsXG4gICAgICAgICAgZGV0YWlsOiByZWNlaXB0U3BsaXQuZGV0YWlsLFxuICAgICAgICB9LFxuICAgICAgICA0MDksXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbmZpZzogRXZtU2V0dGxlbWVudENvbmZpZyA9IHtcbiAgICAgIGNoYWluSWQ6IGZhY2lsaXRhdG9yLmNoYWluSWQsXG4gICAgICBzZXR0bGVtZW50Q29udHJhY3Q6IGZhY2lsaXRhdG9yLnNldHRsZW1lbnRDb250cmFjdCxcbiAgICAgIHN0YWJsZWNvaW46IGZhY2lsaXRhdG9yLnN0YWJsZWNvaW4sXG4gICAgICBtYXhCYXRjaFNpemU6IE1BWF9CQVRDSF9TSVpFLFxuICAgIH07XG4gICAgY29uc3Qgbm93TXMgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHBsYW5uZWQgPSBwbGFuQmF0Y2hTZXR0bGVtZW50KHtcbiAgICAgIGNvbmZpZyxcbiAgICAgIGNoYW5uZWw6IHBheW1lbnRDaGFubmVsU3RhdGVGcm9tQmF0Y2hlcyh7XG4gICAgICAgIGNoYW5uZWxJZCxcbiAgICAgICAgZXNjcm93TWljcm9zOiBjaGFubmVsLmVzY3Jvd01pY3JvcyxcbiAgICAgICAgYmF0Y2hlcyxcbiAgICAgIH0pLFxuICAgICAgdm91Y2hlcnM6IHBlbmRpbmcubWFwKHZvdWNoZXJGcm9tUmVjZWlwdCksXG4gICAgICB2ZXJpZnlTaWduYXR1cmU6ICh2b3VjaGVyKSA9PiB2ZXJpZnlQYXltZW50Vm91Y2hlclNpZ25hdHVyZSh2b3VjaGVyLCB7XG4gICAgICAgIGNoYW5uZWxJZDogY2hhbm5lbC5jaGFubmVsSWQsIHBheWVyOiBjaGFubmVsLnByaW5jaXBhbElkLFxuICAgICAgICBwdWJrZXlCYXNlNjQ6IGNoYW5uZWwucGF5ZXJQdWJrZXlCYXNlNjQgPz8gJycsXG4gICAgICB9KSxcbiAgICAgIG5vd01zLFxuICAgICAgc2V0dGxlbWVudElkOiBgc2V0dGxlbWVudDoke2NoYW5uZWxJZH06JHtwZW5kaW5nW3BlbmRpbmcubGVuZ3RoIC0gMV0hLmN1bXVsYXRpdmVDbGFpbU1pY3Jvc31gLFxuICAgICAgc3BsaXRNYW5pZmVzdDogcmVjZWlwdFNwbGl0Lm1hbmlmZXN0LFxuICAgICAgZGFvVHJlYXN1cnk6IHNwbGl0LmRhb1RyZWFzdXJ5LFxuICAgIH0pO1xuICAgIGlmICghcGxhbm5lZC5vaykge1xuICAgICAgY29uc3Qgc3RhdHVzID0gcGxhbm5lZC5jb2RlID09PSAnZXNjcm93LWV4aGF1c3RlZCcgfHwgcGxhbm5lZC5jb2RlID09PSAnZHVwbGljYXRlLWNsYWltJyA/IDQwOSA6IDQyMjtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogcGxhbm5lZC5jb2RlLCBkZXRhaWw6IHBsYW5uZWQuZGV0YWlsIH0sIHN0YXR1cyk7XG4gICAgfVxuXG4gICAgLy8gT25seSBhIExJVkUgYmF0Y2ggaXMgYSByZXBsYXkuIEEgcmVvcmdlZCBvciByZWZ1bmRlZCBvbmUgaXMgdm9pZCwgYW5kIHRoZVxuICAgIC8vIHJlLWNsYWltIG9mIGl0cyByZWxlYXNlZCB2b3VjaGVycyByZXByb2R1Y2VzIHRoZSBzYW1lIHJlcXVlc3QgaGFzaC5cbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGdldExpdmVTZXR0bGVtZW50QmF0Y2hCeVJlcXVlc3RIYXNoKFxuICAgICAgYy5lbnYuREIsXG4gICAgICBjaGFubmVsSWQsXG4gICAgICBwbGFubmVkLnBsYW4ucmVxdWVzdC5yZXF1ZXN0SGFzaCxcbiAgICApO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuIGMuanNvbih7IHJlcGxheWVkOiB0cnVlLCBiYXRjaDogYmF0Y2hKc29uKGV4aXN0aW5nKSB9LCAyMDApO1xuICAgIGNvbnN0IGF0dGVtcHQgPSBhd2FpdCBzZXR0bGVtZW50Q2xhaW1BdHRlbXB0cyhjLmVudi5EQiwgY2hhbm5lbElkLCBwbGFubmVkLnBsYW4ucmVxdWVzdC5yZXF1ZXN0SGFzaCk7XG5cbiAgICBsZXQgcmVjZWlwdDtcbiAgICB0cnkge1xuICAgICAgcmVjZWlwdCA9IGF3YWl0IGZhY2lsaXRhdG9yLnN1Ym1pdEJhdGNoQ2xhaW0ocGxhbm5lZC5wbGFuLnJlcXVlc3QpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiAncmFpbF9jbGFpbV9mYWlsZWQnLCBkZXRhaWw6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSB9LFxuICAgICAgICA1MDIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHJlY29yZGVkID0gYXdhaXQgcmVjb3JkU2V0dGxlbWVudENsYWltKGMuZW52LkRCLCB7XG4gICAgICAvLyBUaGUgYXR0ZW1wdCBvcmRpbmFsIGtlZXBzIGEgcG9zdC1yZW9yZyByZS1jbGFpbSBvZiB0aGUgc2FtZSB2b3VjaGVyIHNldFxuICAgICAgLy8gYSBESVNUSU5DVCByb3csIHNvIHRoZSB2b2lkIGJhdGNoIGFuZCBpdHMgcmVwbGFjZW1lbnQgYm90aCBzdGF5XG4gICAgICAvLyBhdWRpdGFibGUgaW5zdGVhZCBvZiBvbmUgb3ZlcndyaXRpbmcgdGhlIG90aGVyLlxuICAgICAgYmF0Y2hJZDogYGJhdGNoOiR7Y2hhbm5lbElkfToke3BsYW5uZWQucGxhbi5yZXF1ZXN0LnJlcXVlc3RIYXNoLnNsaWNlKDAsIDMyKX06JHthdHRlbXB0fWAsXG4gICAgICBjaGFubmVsSWQsXG4gICAgICBwcmluY2lwYWxJZDogYXV0aC5wcmluY2lwYWxJZCxcbiAgICAgIHBsYW46IHBsYW5uZWQucGxhbixcbiAgICAgIHJlY2VpcHQsXG4gICAgICByZXF1aXJlZENvbmZpcm1hdGlvbnM6IGZhY2lsaXRhdG9yLnJlcXVpcmVkQ29uZmlybWF0aW9ucyxcbiAgICAgIC8vIFRoZSBibG9jayBhIHRyYW5zYWN0aW9uIGlzIG1pbmVkIGludG8gaXMgaXRzIGZpcnN0IGNvbmZpcm1hdGlvbi4gSXQgaXNcbiAgICAgIC8vIHN0aWxsIG9ubHkgYSBDTEFJTTogYGZpbmFsYCByZXF1aXJlcyB0aGUgY29uZmlndXJlZCBkZXB0aC5cbiAgICAgIGNvbmZpcm1hdGlvbnM6IDEsXG4gICAgICB1c2FnZU5vbmNlczogcGVuZGluZy5tYXAoKGVudHJ5KSA9PiBlbnRyeS51c2FnZU5vbmNlKSxcbiAgICAgIG5vd01zLFxuICAgIH0pO1xuICAgIGlmICghcmVjb3JkZWQub2spIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3ZvdWNoZXJfYWxyZWFkeV9jbGFpbWVkJywgZGV0YWlsOiByZWNvcmRlZC5kZXRhaWwgfSwgNDA5KTtcbiAgICB9XG5cbiAgICBjb25zdCBwcm9vZiA9IGF3YWl0IHJlY29yZFNldHRsZW1lbnRQcm9vZihjLmVudi5EQiwgZmFjaWxpdGF0b3IsIHtcbiAgICAgIHN0cmVhbUlkOiBzZXR0bGVtZW50U3RyZWFtKGNoYW5uZWxJZCksXG4gICAgICBwbGFuOiBwbGFubmVkLnBsYW4sXG4gICAgICBmaW5hbGl0eTogJ2NsYWltZWQnLFxuICAgICAgY29uZmlybWF0aW9uczogcmVjb3JkZWQuYmF0Y2guY29uZmlybWF0aW9ucyxcbiAgICAgIHRyYW5zYWN0aW9uOiByZWNvcmRlZC5iYXRjaC5jbGFpbVJlY2VpcHQsXG4gICAgICBub3dNcyxcbiAgICB9KTtcbiAgICBpZiAoIXByb29mLm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiAnc2V0dGxlbWVudF9wcm9vZl91bnJlY29yZGVkJywgZGV0YWlsOiBwcm9vZi5kZXRhaWwsIGJhdGNoOiBiYXRjaEpzb24ocmVjb3JkZWQuYmF0Y2gpIH0sXG4gICAgICAgIDUwMCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGMuanNvbihcbiAgICAgIHsgcmVwbGF5ZWQ6ICFyZWNvcmRlZC5jcmVhdGVkLCBiYXRjaDogYmF0Y2hKc29uKHJlY29yZGVkLmJhdGNoKSwgcHJvb2ZFdmVudElkOiBwcm9vZi5ldmVudC5ldmVudElkIH0sXG4gICAgICByZWNvcmRlZC5jcmVhdGVkID8gMjAxIDogMjAwLFxuICAgICk7XG4gIH0pO1xuXG4gIHJvdXRlLmdldCgnL2NvbW1lcmNlL3BheW1lbnQtY2hhbm5lbHMvOmNoYW5uZWxJZC9zZXR0bGVtZW50cycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGMucmVxLnBhcmFtKCdjaGFubmVsSWQnKTtcbiAgICBpZiAoIXZhbGlkSWQoY2hhbm5lbElkKSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyB9LCA0MDApO1xuICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBnZXRQYXltZW50Q2hhbm5lbChjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBpZiAoIWNoYW5uZWwgfHwgY2hhbm5lbC5wcmluY2lwYWxJZCAhPT0gYXV0aC5wcmluY2lwYWxJZCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnY2hhbm5lbF9ub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IGJhdGNoZXMgPSBhd2FpdCBsaXN0Q2hhbm5lbFNldHRsZW1lbnRCYXRjaGVzKGMuZW52LkRCLCBjaGFubmVsSWQpO1xuICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgYmF0Y2hlczogYmF0Y2hlcy5tYXAoYmF0Y2hKc29uKSxcbiAgICAgIGZyZWV6ZTogaXNTZXR0bGVtZW50RnJvemVuKGJhdGNoZXMpLFxuICAgIH0pO1xuICB9KTtcblxuICAvKipcbiAgICogUmUtb2JzZXJ2ZSBhIGNsYWltIGFnYWluc3QgdGhlIGNoYWluLlxuICAgKlxuICAgKiBUaGlzIGlzIHRoZSBPTkxZIHRyYW5zaXRpb24gdGhhdCBjYW4gcmVwb3J0IGZpbmFsaXR5LCBhbmQgaXQgaXMgYWxzbyB0aGVcbiAgICogb25seSBwbGFjZSBhIHJlb3JnIGlzIGRldGVjdGVkLiBCb3RoIHJlYWRpbmdzIGNvbWUgZnJvbSBvbmUgb2JzZXJ2YXRpb24sIHNvXG4gICAqIGEgY2FsbGVyIGNhbm5vdCBnZXQgXCJmaW5hbFwiIGZyb20gb25lIGVuZHBvaW50IHdoaWxlIGFub3RoZXIgc3RpbGwgaG9sZHMgYVxuICAgKiBkcm9wcGVkIHRyYW5zYWN0aW9uLlxuICAgKi9cbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL3BheW1lbnQtY2hhbm5lbHMvOmNoYW5uZWxJZC9zZXR0bGVtZW50cy86YmF0Y2hJZC9maW5hbGl0eScsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGMucmVxLnBhcmFtKCdjaGFubmVsSWQnKTtcbiAgICBjb25zdCBiYXRjaElkID0gYy5yZXEucGFyYW0oJ2JhdGNoSWQnKTtcbiAgICBpZiAoIXZhbGlkSWQoY2hhbm5lbElkKSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyB9LCA0MDApO1xuXG4gICAgY29uc3QgYXZhaWxhYmlsaXR5ID0gZmFjaWxpdGF0b3JGb3IoYy5lbnYsIG9wdGlvbnMuZmFjaWxpdGF0b3IpO1xuICAgIGlmICghYXZhaWxhYmlsaXR5Lm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGF2YWlsYWJpbGl0eS5jb2RlLCBkZXRhaWw6IGF2YWlsYWJpbGl0eS5kZXRhaWwgfSwgNTAzKTtcbiAgICBjb25zdCBmYWNpbGl0YXRvciA9IGF2YWlsYWJpbGl0eS5mYWNpbGl0YXRvcjtcblxuICAgIGNvbnN0IGJhdGNoID0gYXdhaXQgZ2V0U2V0dGxlbWVudEJhdGNoKGMuZW52LkRCLCBiYXRjaElkKTtcbiAgICBpZiAoIWJhdGNoIHx8IGJhdGNoLmNoYW5uZWxJZCAhPT0gY2hhbm5lbElkIHx8IGJhdGNoLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdiYXRjaF9ub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgfVxuICAgIGlmIChiYXRjaC5zdGF0ZSA9PT0gJ2ZpbmFsJykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IHZlcmRpY3Q6IHsgc3RhdGU6ICdmaW5hbCcsIGZpbmFsOiB0cnVlLCBjb25maXJtYXRpb25zOiBiYXRjaC5jb25maXJtYXRpb25zIH0sIGJhdGNoOiBiYXRjaEpzb24oYmF0Y2gpIH0sIDIwMCk7XG4gICAgfVxuICAgIGlmIChiYXRjaC5zdGF0ZSAhPT0gJ2NsYWltZWQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGBiYXRjaF8ke2JhdGNoLnN0YXRlfWAgfSwgNDA5KTtcblxuICAgIGxldCBvYnNlcnZhdGlvbjtcbiAgICB0cnkge1xuICAgICAgb2JzZXJ2YXRpb24gPSBhd2FpdCBmYWNpbGl0YXRvci5vYnNlcnZlVHJhbnNhY3Rpb24oYmF0Y2guY2xhaW1SZWNlaXB0LnRyYW5zYWN0aW9uSGFzaCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHsgZXJyb3I6ICdyYWlsX29ic2VydmF0aW9uX2ZhaWxlZCcsIGRldGFpbDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpIH0sXG4gICAgICAgIDUwMixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdmVyZGljdCA9IGFzc2Vzc0NsYWltRmluYWxpdHkoe1xuICAgICAgY2xhaW06IGJhdGNoLmNsYWltUmVjZWlwdCxcbiAgICAgIG9ic2VydmF0aW9uLFxuICAgICAgcmVxdWlyZWRDb25maXJtYXRpb25zOiBiYXRjaC5yZXF1aXJlZENvbmZpcm1hdGlvbnMsXG4gICAgfSk7XG4gICAgY29uc3Qgbm93TXMgPSBEYXRlLm5vdygpO1xuXG4gICAgaWYgKHZlcmRpY3Quc3RhdGUgPT09ICdyZW9yZ2VkJykge1xuICAgICAgY29uc3QgY2hhbm5lbCA9IGF3YWl0IGdldFBheW1lbnRDaGFubmVsKGMuZW52LkRCLCBjaGFubmVsSWQpO1xuICAgICAgaWYgKCFjaGFubmVsKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdjaGFubmVsX25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICAgIC8vIFByb3ZlIHRoZSB1bndpbmQgaXMgYXJpdGhtZXRpY2FsbHkgc291bmQgYWdhaW5zdCB0aGUgbGl2ZSBjaGFubmVsXG4gICAgICAvLyBCRUZPUkUgbXV0YXRpbmcgYW55dGhpbmc6IGEgbWlzbWF0Y2ggbWVhbnMgb3VyIHZpZXcgb2YgdGhlIGNoYW5uZWwgYW5kXG4gICAgICAvLyB0aGlzIGJhdGNoIGRpc2FncmVlLCBhbmQgZ3Vlc3NpbmcgdGhlcmUgd291bGQgc3RyYW5kIHZvdWNoZXJzLlxuICAgICAgY29uc3QgdW53b3VuZCA9IHVud2luZFJlb3JnZWRDbGFpbSh7XG4gICAgICAgIGNoYW5uZWw6IHBheW1lbnRDaGFubmVsU3RhdGVGcm9tQmF0Y2hlcyh7XG4gICAgICAgICAgY2hhbm5lbElkLFxuICAgICAgICAgIGVzY3Jvd01pY3JvczogY2hhbm5lbC5lc2Nyb3dNaWNyb3MsXG4gICAgICAgICAgYmF0Y2hlczogYXdhaXQgbGlzdENoYW5uZWxTZXR0bGVtZW50QmF0Y2hlcyhjLmVudi5EQiwgY2hhbm5lbElkKSxcbiAgICAgICAgfSksXG4gICAgICAgIGNsYWltTWljcm9zOiBCaWdJbnQoYmF0Y2guY2xhaW1NaWNyb3MpLFxuICAgICAgICB2b3VjaGVyRGlnZXN0czogYmF0Y2gudm91Y2hlckRpZ2VzdHMsXG4gICAgICAgIHByaW9yQ3VtdWxhdGl2ZU1pY3JvczogQmlnSW50KGJhdGNoLnByaW9yQ3VtdWxhdGl2ZU1pY3JvcyksXG4gICAgICB9KTtcbiAgICAgIGlmICghdW53b3VuZC5vaykge1xuICAgICAgICBjb25zdCBmcm96ZW4gPSBhd2FpdCB1bndpbmRSZW9yZ2VkQmF0Y2goYy5lbnYuREIsIGJhdGNoSWQsIGByZW9yZy0ke3ZlcmRpY3QucmVhc29ufWAsIG5vd01zKTtcbiAgICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgICB7IGVycm9yOiAncmVvcmdfdW53aW5kX2ZhaWxlZCcsIGRldGFpbDogdW53b3VuZC5kZXRhaWwsIHZlcmRpY3QsIGJhdGNoOiBiYXRjaEpzb24oZnJvemVuKSB9LFxuICAgICAgICAgIDUwMCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHVud2luZFJlb3JnZWRCYXRjaChjLmVudi5EQiwgYmF0Y2hJZCwgYHJlb3JnLSR7dmVyZGljdC5yZWFzb259YCwgbm93TXMpO1xuICAgICAgcmV0dXJuIGMuanNvbih7IHZlcmRpY3QsIHJlY292ZXJlZDogcmVjb3ZlcmVkLnJlY292ZXJlZCwgYmF0Y2g6IGJhdGNoSnNvbihyZWNvdmVyZWQpIH0sIDIwMCk7XG4gICAgfVxuXG4gICAgaWYgKHZlcmRpY3Quc3RhdGUgPT09ICdmaW5hbCcpIHtcbiAgICAgIGNvbnN0IGZpbmFsaXplZCA9IGF3YWl0IG1hcmtTZXR0bGVtZW50RmluYWwoYy5lbnYuREIsIGJhdGNoSWQsIHZlcmRpY3QuY29uZmlybWF0aW9ucywgbm93TXMpO1xuICAgICAgY29uc3QgcHJvb2YgPSBhd2FpdCByZWNvcmRTZXR0bGVtZW50UHJvb2YoYy5lbnYuREIsIGZhY2lsaXRhdG9yLCB7XG4gICAgICAgIHN0cmVhbUlkOiBzZXR0bGVtZW50U3RyZWFtKGNoYW5uZWxJZCksXG4gICAgICAgIHBsYW46IHBsYW5Gcm9tQmF0Y2goZmluYWxpemVkKSxcbiAgICAgICAgZmluYWxpdHk6ICdmaW5hbCcsXG4gICAgICAgIGNvbmZpcm1hdGlvbnM6IHZlcmRpY3QuY29uZmlybWF0aW9ucyxcbiAgICAgICAgdHJhbnNhY3Rpb246IGZpbmFsaXplZC5jbGFpbVJlY2VpcHQsXG4gICAgICAgIG5vd01zLFxuICAgICAgfSk7XG4gICAgICBpZiAoIXByb29mLm9rKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgICAgeyBlcnJvcjogJ3NldHRsZW1lbnRfcHJvb2ZfdW5yZWNvcmRlZCcsIGRldGFpbDogcHJvb2YuZGV0YWlsLCB2ZXJkaWN0LCBiYXRjaDogYmF0Y2hKc29uKGZpbmFsaXplZCkgfSxcbiAgICAgICAgICA1MDAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYy5qc29uKHsgdmVyZGljdCwgYmF0Y2g6IGJhdGNoSnNvbihmaW5hbGl6ZWQpLCBwcm9vZkV2ZW50SWQ6IHByb29mLmV2ZW50LmV2ZW50SWQgfSwgMjAwKTtcbiAgICB9XG5cbiAgICBjb25zdCB1cGRhdGVkID0gYXdhaXQgcmVjb3JkU2V0dGxlbWVudENvbmZpcm1hdGlvbnMoYy5lbnYuREIsIGJhdGNoSWQsIHZlcmRpY3QuY29uZmlybWF0aW9ucywgbm93TXMpO1xuICAgIHJldHVybiBjLmpzb24oeyB2ZXJkaWN0LCBiYXRjaDogYmF0Y2hKc29uKHVwZGF0ZWQpIH0sIDIwMCk7XG4gIH0pO1xuXG4gIC8qKlxuICAgKiBPcGVuIG9yIHJlc29sdmUgYSBkaXNwdXRlLlxuICAgKlxuICAgKiBPcGVuaW5nIGZyZWV6ZXMgdGhlIGNoYW5uZWw6IG5vIGZ1cnRoZXIgYmF0Y2ggbWF5IGNsYWltIHdoaWxlIHRoZSBvcmRlcmluZ1xuICAgKiBvZiBhbiBleGlzdGluZyBvbmUgaXMgY29udGVzdGVkLiBSZXNvbHZpbmcgZWl0aGVyIGRpc21pc3NlcyB0aGUgZGlzcHV0ZVxuICAgKiAodGhlIGNsYWltIHN0YW5kcykgb3IgcmVmdW5kcyBpdCBvbiBjaGFpbiwgd2hpY2gg4oCUIGV4YWN0bHkgbGlrZSBhIHJlb3JnIOKAlFxuICAgKiByZWxlYXNlcyB0aGUgdm91Y2hlcnMgc28gdGhleSBjYW4gYmUgY2xhaW1lZCBhZ2Fpbi5cbiAgICovXG4gIHJvdXRlLnBvc3QoJy9jb21tZXJjZS9wYXltZW50LWNoYW5uZWxzLzpjaGFubmVsSWQvc2V0dGxlbWVudHMvOmJhdGNoSWQvZGlzcHV0ZScsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGMucmVxLnBhcmFtKCdjaGFubmVsSWQnKTtcbiAgICBjb25zdCBiYXRjaElkID0gYy5yZXEucGFyYW0oJ2JhdGNoSWQnKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGNvbnN0IGFjdGlvbiA9IGJvZHk/LmFjdGlvbjtcbiAgICBjb25zdCBvdXRjb21lID0gYm9keT8ub3V0Y29tZTtcbiAgICBpZiAoXG4gICAgICAhdmFsaWRJZChjaGFubmVsSWQpIHx8XG4gICAgICAoYWN0aW9uICE9PSAnb3BlbicgJiYgYWN0aW9uICE9PSAncmVzb2x2ZScpIHx8XG4gICAgICAoYWN0aW9uID09PSAncmVzb2x2ZScgJiYgb3V0Y29tZSAhPT0gJ3JlZnVuZCcgJiYgb3V0Y29tZSAhPT0gJ2Rpc21pc3MnKVxuICAgICkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyxcbiAgICAgICAgICBkZXRhaWw6IFwiYWN0aW9uIG11c3QgYmUgJ29wZW4nIG9yICdyZXNvbHZlJzsgcmVzb2x2ZSByZXF1aXJlcyBvdXRjb21lICdyZWZ1bmQnIG9yICdkaXNtaXNzJ1wiLFxuICAgICAgICB9LFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGJhdGNoID0gYXdhaXQgZ2V0U2V0dGxlbWVudEJhdGNoKGMuZW52LkRCLCBiYXRjaElkKTtcbiAgICBpZiAoIWJhdGNoIHx8IGJhdGNoLmNoYW5uZWxJZCAhPT0gY2hhbm5lbElkIHx8IGJhdGNoLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdiYXRjaF9ub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgfVxuICAgIGNvbnN0IG5vd01zID0gRGF0ZS5ub3coKTtcblxuICAgIGlmIChhY3Rpb24gPT09ICdvcGVuJykge1xuICAgICAgaWYgKGJhdGNoLnN0YXRlICE9PSAnY2xhaW1lZCcgJiYgYmF0Y2guc3RhdGUgIT09ICdmaW5hbCcpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBgYmF0Y2hfJHtiYXRjaC5zdGF0ZX1gIH0sIDQwOSk7XG4gICAgICB9XG4gICAgICBjb25zdCByZWFzb24gPSB0eXBlb2YgYm9keT8ucmVhc29uID09PSAnc3RyaW5nJyAmJiBib2R5LnJlYXNvbi50cmltKCkgPyBib2R5LnJlYXNvbi50cmltKCkuc2xpY2UoMCwgNTAwKSA6ICdkaXNwdXRlZCc7XG4gICAgICBjb25zdCBkaXNwdXRlZCA9IGF3YWl0IG1hcmtTZXR0bGVtZW50RGlzcHV0ZWQoYy5lbnYuREIsIGJhdGNoSWQsIHJlYXNvbiwgbm93TXMpO1xuICAgICAgcmV0dXJuIGMuanNvbih7IGJhdGNoOiBiYXRjaEpzb24oZGlzcHV0ZWQpIH0sIDIwMCk7XG4gICAgfVxuXG4gICAgaWYgKGJhdGNoLnN0YXRlICE9PSAnZGlzcHV0ZWQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGBiYXRjaF8ke2JhdGNoLnN0YXRlfWAgfSwgNDA5KTtcbiAgICBpZiAob3V0Y29tZSA9PT0gJ2Rpc21pc3MnKSB7XG4gICAgICBjb25zdCBkaXNtaXNzZWQgPSBhd2FpdCBtYXJrU2V0dGxlbWVudERpc3B1dGVEaXNtaXNzZWQoYy5lbnYuREIsIGJhdGNoSWQsIG5vd01zKTtcbiAgICAgIHJldHVybiBjLmpzb24oeyBiYXRjaDogYmF0Y2hKc29uKGRpc21pc3NlZCkgfSwgMjAwKTtcbiAgICB9XG5cbiAgICBjb25zdCBhdmFpbGFiaWxpdHkgPSBmYWNpbGl0YXRvckZvcihjLmVudiwgb3B0aW9ucy5mYWNpbGl0YXRvcik7XG4gICAgaWYgKCFhdmFpbGFiaWxpdHkub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogYXZhaWxhYmlsaXR5LmNvZGUsIGRldGFpbDogYXZhaWxhYmlsaXR5LmRldGFpbCB9LCA1MDMpO1xuICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBnZXRQYXltZW50Q2hhbm5lbChjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBpZiAoIWNoYW5uZWwpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NoYW5uZWxfbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIGNvbnN0IHJlZnVuZEFkZHJlc3MgPVxuICAgICAgY2hhbm5lbC5mdW5kaW5nU291cmNlLmtpbmQgPT09ICdib3VuZC13YWxsZXQnXG4gICAgICAgID8gY2hhbm5lbC5mdW5kaW5nU291cmNlLndhbGxldEFkZHJlc3NcbiAgICAgICAgOiBhdmFpbGFiaWxpdHkuZmFjaWxpdGF0b3Iuc2lnbmVyQWRkcmVzcztcblxuICAgIGxldCByZWZ1bmQ7XG4gICAgdHJ5IHtcbiAgICAgIHJlZnVuZCA9IGF3YWl0IGF2YWlsYWJpbGl0eS5mYWNpbGl0YXRvci5zdWJtaXRSZWZ1bmQoe1xuICAgICAgICBjaGFubmVsSWQsXG4gICAgICAgIGFtb3VudE1pY3JvczogQmlnSW50KGJhdGNoLmNsYWltTWljcm9zKSxcbiAgICAgICAgcmVmdW5kQWRkcmVzcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiAncmFpbF9yZWZ1bmRfZmFpbGVkJywgZGV0YWlsOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikgfSxcbiAgICAgICAgNTAyLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmVmdW5kZWQgPSBhd2FpdCBtYXJrU2V0dGxlbWVudFJlZnVuZGVkKGMuZW52LkRCLCBiYXRjaElkLCByZWZ1bmQsIG5vd01zKTtcbiAgICByZXR1cm4gYy5qc29uKHsgYmF0Y2g6IGJhdGNoSnNvbihyZWZ1bmRlZCkgfSwgMjAwKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHJvdXRlO1xufVxuXG4vKipcbiAqIFJlYnVpbGQgdGhlIHBsYW4gc2hhcGUgYSBzZXR0bGVtZW50IHByb29mIG5lZWRzIGZyb20gdGhlIHN0b3JlZCBiYXRjaC5cbiAqXG4gKiBUaGUgZmluYWxpdHkgcHJvb2YgcmVzdGF0ZXMgdGhlIFNBTUUgY2xhaW0gdGhlIGJhdGNoIGFscmVhZHkgcmVjb3JkZWQsIHNvIGl0XG4gKiBpcyByZWNvbnN0cnVjdGVkIGZyb20gdGhlIGR1cmFibGUgcm93IHJhdGhlciB0aGFuIHJlLXBsYW5uZWQ6IHJlLXJ1bm5pbmdcbiAqIGBwbGFuQmF0Y2hTZXR0bGVtZW50YCBoZXJlIHdvdWxkIHJlLXJlYWQgdm91Y2hlcnMgd2hvc2Ugc3RhdGUgaGFzIHNpbmNlIG1vdmVkXG4gKiBhbmQgY291bGQgcHJvZHVjZSBhIGRpZmZlcmVudCByZXF1ZXN0IGhhc2ggZm9yIHRoZSBzYW1lIG9uLWNoYWluIGNsYWltLlxuICovXG5mdW5jdGlvbiBwbGFuRnJvbUJhdGNoKGJhdGNoOiBTdG9yZWRTZXR0bGVtZW50QmF0Y2gpOiBCYXRjaFNldHRsZW1lbnRQbGFuIHtcbiAgY29uc3QgYWxsb2NhdGlvbnNNaWNyb3MgPSB7fSBhcyBSZWNvcmQ8UmV2ZW51ZVNoYXJlLCBiaWdpbnQ+O1xuICBmb3IgKGNvbnN0IHNoYXJlIG9mIFJFVkVOVUVfU0hBUkVTKSB7XG4gICAgYWxsb2NhdGlvbnNNaWNyb3Nbc2hhcmVdID0gQmlnSW50KGJhdGNoLmFsbG9jYXRpb25zTWljcm9zW3NoYXJlXSk7XG4gIH1cbiAgY29uc3QgY2hhbm5lbCA9IHtcbiAgICBjaGFubmVsSWQ6IGJhdGNoLmNoYW5uZWxJZCxcbiAgICByYWlsOiAnZXZtLXg0MDInIGFzIGNvbnN0LFxuICAgIGVzY3Jvd01pY3JvczogMG4sXG4gICAgc2V0dGxlZE1pY3JvczogQmlnSW50KGJhdGNoLmNsYWltTWljcm9zKSxcbiAgICBsYXN0Q3VtdWxhdGl2ZU1pY3JvczogQmlnSW50KGJhdGNoLmN1bXVsYXRpdmVDbGFpbU1pY3JvcyksXG4gICAgY2xhaW1lZFZvdWNoZXJEaWdlc3RzOiBiYXRjaC52b3VjaGVyRGlnZXN0cyxcbiAgfTtcbiAgcmV0dXJuIHtcbiAgICBjaGFubmVsLFxuICAgIHByaW9yQ2hhbm5lbDogeyAuLi5jaGFubmVsLCBzZXR0bGVkTWljcm9zOiAwbiwgbGFzdEN1bXVsYXRpdmVNaWNyb3M6IEJpZ0ludChiYXRjaC5wcmlvckN1bXVsYXRpdmVNaWNyb3MpLCBjbGFpbWVkVm91Y2hlckRpZ2VzdHM6IFtdIH0sXG4gICAgY2xhaW1NaWNyb3M6IEJpZ0ludChiYXRjaC5jbGFpbU1pY3JvcyksXG4gICAgY3VtdWxhdGl2ZUNsYWltTWljcm9zOiBCaWdJbnQoYmF0Y2guY3VtdWxhdGl2ZUNsYWltTWljcm9zKSxcbiAgICB2b3VjaGVyRGlnZXN0czogYmF0Y2gudm91Y2hlckRpZ2VzdHMsXG4gICAgcmVxdWVzdDoge1xuICAgICAgY2hhaW5JZDogYmF0Y2guY2hhaW5JZCxcbiAgICAgIHRvOiBiYXRjaC5zZXR0bGVtZW50Q29udHJhY3RBZGRyZXNzLFxuICAgICAgc3RhYmxlY29pbjogYmF0Y2guc3RhYmxlY29pbkFkZHJlc3MsXG4gICAgICBjaGFubmVsSWQ6IGJhdGNoLmNoYW5uZWxJZCxcbiAgICAgIGFtb3VudE1pY3JvczogQmlnSW50KGJhdGNoLmNsYWltTWljcm9zKSxcbiAgICAgIHZvdWNoZXJEaWdlc3RzOiBiYXRjaC52b3VjaGVyRGlnZXN0cyxcbiAgICAgIGNhbGxkYXRhOiAnMHgnLFxuICAgICAgcmVxdWVzdEhhc2g6IGJhdGNoLnJlcXVlc3RIYXNoLFxuICAgIH0sXG4gICAgcmVjZWlwdDoge1xuICAgICAgc2V0dGxlbWVudElkOiBiYXRjaC5zZXR0bGVtZW50SWQsXG4gICAgICBjdXJyZW5jeTogJ3N0YWJsZWNvaW4tbWljcm9zJyxcbiAgICAgIGdyb3NzTWljcm9zOiBCaWdJbnQoYmF0Y2guY2xhaW1NaWNyb3MpLFxuICAgICAgcHJvdmlkZXJDb3N0TWljcm9zOiBCaWdJbnQoYmF0Y2gucHJvdmlkZXJDb3N0TWljcm9zKSxcbiAgICAgIGRpc3RyaWJ1dGFibGVNaWNyb3M6IEJpZ0ludChiYXRjaC5kaXN0cmlidXRhYmxlTWljcm9zKSxcbiAgICAgIGFsbG9jYXRpb25zTWljcm9zLFxuICAgICAgLi4uKGJhdGNoLmNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zICE9PSB1bmRlZmluZWQgPyB7XG4gICAgICAgIGNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zOiBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYmF0Y2guY29tcG9uZW50QWxsb2NhdGlvbnNNaWNyb3MpXG4gICAgICAgICAgLm1hcCgoW2F1dGhvciwgYW1vdW50XSkgPT4gW2F1dGhvciwgQmlnSW50KGFtb3VudCldKSksXG4gICAgICB9IDoge30pLFxuICAgICAgZGFvVHJlYXN1cnk6IGJhdGNoLmRhb1RyZWFzdXJ5LFxuICAgICAgc3BsaXRNYW5pZmVzdEhhc2g6IGJhdGNoLnNwbGl0TWFuaWZlc3RIYXNoLFxuICAgICAgcmVjZWlwdEhhc2g6IGJhdGNoLnJlY2VpcHRIYXNoLFxuICAgIH0sXG4gIH07XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL3NldHRsZW1lbnRzLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9zZXR0bGVtZW50cy50cyIsIi9zcmMvcm91dGVzL3NldHRsZW1lbnRzLnRzIixbXV0=