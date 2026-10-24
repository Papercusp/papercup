'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("resolveTreasuryConfig", () => { try { return resolveTreasuryConfig } catch {} });
__vite_ssr_exportName__("treasuryRoute", () => { try { return treasuryRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/treasury-controls.ts", {"importedNames":["buildTreasuryTransferEvent","planTreasuryRouting","validateSafeDeployment"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/revenue-settlement.ts", {"importedNames":["REVENUE_SHARES","reconcileSettlement"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/commerce-events.ts", {"importedNames":["commerceEventSigningBytes"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","isCupboardOperator","resolveGithubBearer"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/settlement-batch-store.ts", {"importedNames":["getSettlementBatch","retainedBatchUsageNonces"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/src/usage-receipt-store.ts", {"importedNames":["listChannelUsageReceipts"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/src/wallet-binding-store.ts", {"importedNames":["getWalletBinding"]});
const __vite_ssr_import_8__ = await __vite_ssr_import__("/src/commerce-event-log-store.ts", {"importedNames":["appendCommerceEvent","nextCommerceEventSequence"]});
const __vite_ssr_import_9__ = await __vite_ssr_import__("/src/treasury-store.ts", {"importedNames":["getSafeDeployment","getTreasuryTransferForShare","listBatchTreasuryTransfers","listSafeDeployments","recordSafeDeployment","recordTreasuryTransfer","reserveTreasuryTransfer"]});
const __vite_ssr_import_10__ = await __vite_ssr_import__("/src/treasury-adapter.ts", {"importedNames":["createViemSafeTreasuryAdapter"]});
const __vite_ssr_import_11__ = await __vite_ssr_import__("/src/routes/settlements.ts", {"importedNames":["resolveSplitConfig","resolveUsageSplitManifest"]});
const __vite_ssr_import_12__ = await __vite_ssr_import__("/src/transfer-gate-store.ts", {"importedNames":["transferGateVerdict"]});













const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TREASURY_ELIGIBLE_SHARES = ["dao", "reserve", "tax", "operating"];
async function authenticate(request) {
  try {
    const user = await (0,__vite_ssr_import_4__.resolveGithubBearer)(request);
    return { ok: true, principalId: `gh:${user.id}`, userId: user.id };
  } catch (error) {
    if (error instanceof __vite_ssr_import_4__.AuthError) return { ok: false, reason: error.reason };
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
function required(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function parseList(value) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function resolveTreasuryConfig(env, adapter) {
  const safeAddress = required(env.TREASURY_SAFE_ADDRESS);
  const owners = parseList(env.TREASURY_SAFE_OWNERS);
  const thresholdRaw = required(env.TREASURY_SAFE_THRESHOLD);
  const maxRaw = required(env.TREASURY_SETTLEMENT_MAX_MICROS);
  const daoTreasury = required(env.DAO_TREASURY_ADDRESS);
  const missing = [
    safeAddress ? null : "TREASURY_SAFE_ADDRESS",
    owners.length > 0 ? null : "TREASURY_SAFE_OWNERS",
    thresholdRaw ? null : "TREASURY_SAFE_THRESHOLD",
    maxRaw ? null : "TREASURY_SETTLEMENT_MAX_MICROS",
    daoTreasury ? null : "DAO_TREASURY_ADDRESS",
    required(env.PAYMENT_CHANNEL_STABLECOIN) ? null : "PAYMENT_CHANNEL_STABLECOIN"
  ].filter((name) => name !== null);
  if (missing.length > 0) {
    return { ok: false, code: "not-configured", detail: `treasury policy is unavailable; missing ${missing.join(", ")}` };
  };
  const threshold = Number(thresholdRaw);
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    return { ok: false, code: "invalid-config", detail: `TREASURY_SAFE_THRESHOLD must be a positive integer, got '${thresholdRaw}'` };
  };
  let maxAmountMicros;
  try {
    maxAmountMicros = BigInt(maxRaw);
  } catch {
    return { ok: false, code: "invalid-config", detail: `TREASURY_SETTLEMENT_MAX_MICROS must be an integer, got '${maxRaw}'` };
  };
  if (maxAmountMicros <= 0n) {
    return { ok: false, code: "invalid-config", detail: "TREASURY_SETTLEMENT_MAX_MICROS must be positive" };
  };
  const configuredShares = parseList(env.TREASURY_ROUTED_SHARES);
  const routedShares = [];
  for (const entry of configuredShares.length > 0 ? configuredShares : ["dao"]) {
    if (!__vite_ssr_import_2__.REVENUE_SHARES.includes(entry)) {
      return { ok: false, code: "invalid-config", detail: `TREASURY_ROUTED_SHARES contains unknown share '${entry}'` };
    };
    if (!TREASURY_ELIGIBLE_SHARES.includes(entry)) {
      return {
        ok: false,
        code: "invalid-config",
        detail: `TREASURY_ROUTED_SHARES may not route payee share '${entry}' into the DAO Safe`
      };
    };
    routedShares.push(entry);
  };
  const token = required(env.PAYMENT_CHANNEL_STABLECOIN);
  if (!ADDRESS.test(token)) {
    return { ok: false, code: "invalid-config", detail: "PAYMENT_CHANNEL_STABLECOIN must be an EVM address" };
  };
  if (!ADDRESS.test(daoTreasury)) {
    return { ok: false, code: "invalid-config", detail: "DAO_TREASURY_ADDRESS must be an EVM address" };
  };
  const role = {
    enabled: true,
    maxAmountMicros,
    allowedRecipients: [daoTreasury],
    allowedTokens: [token]
  };
  const disabled = { ...role, enabled: false };
  const config = {
    chainId: adapter.chainId,
    safeAddress,
    owners,
    threshold,
    automationSigner: adapter.automationSigner,
    roles: {
      settlement: role,
      "host-payout": disabled,
      "reserve-transfer": disabled,
      "emergency-pause": disabled
    }
  };
  return {
    ok: true,
    config,
    routedShares,
    // Defaults to REFUSE. Only the exact string 'true' opens the mainnet gate.
    mainnetCapitalApproved: required(env.TREASURY_MAINNET_CAPITAL_APPROVED) === "true"
  };
};
function receiptFromBatch(batch) {
  const allocationsMicros = {};
  for (const share of __vite_ssr_import_2__.REVENUE_SHARES) allocationsMicros[share] = BigInt(batch.allocationsMicros[share]);
  return {
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
  };
}
function deploymentJson(deployment) {
  return {
    chainId: deployment.chainId,
    safeAddress: deployment.safeAddress,
    rolesModuleAddress: deployment.rolesModuleAddress,
    rolesVersion: deployment.rolesVersion,
    deploymentTransactionHash: deployment.deploymentTxHash,
    network: deployment.network,
    owners: [...deployment.owners],
    threshold: deployment.threshold,
    automationSigner: deployment.automationSigner,
    deployedAtMs: deployment.deployedAtMs,
    recordedAtMs: deployment.recordedAtMs,
    recordedBy: deployment.recordedBy
  };
}
function adapterFor(env, injected) {
  return injected ? { ok: true, adapter: injected } : (0,__vite_ssr_import_10__.createViemSafeTreasuryAdapter)(env);
}
function treasuryStream(channelId) {
  return `treasury:${channelId}`;
}
function treasuryRoute(options = {}) {
  const route = new __vite_ssr_import_0__.Hono();
  route.post("/commerce/treasury/safe-deployments", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    if (!(0,__vite_ssr_import_4__.isCupboardOperator)(auth.userId, c.env)) return c.json({ error: "forbidden" }, 403);
    const body = await jsonObject(c.req.raw);
    if (!body) return c.json({ error: "invalid_request" }, 400);
    const chainId = Number(body.chainId);
    const network = body.network;
    if (network !== "testnet" && network !== "mainnet") {
      return c.json({ error: "invalid_request", detail: "network must be testnet or mainnet" }, 400);
    };
    const owners = Array.isArray(body.owners) ? body.owners.filter((o) => typeof o === "string") : [];
    const threshold = Number(body.threshold);
    const deployment = {
      chainId,
      safeAddress: typeof body.safeAddress === "string" ? body.safeAddress : "",
      rolesModuleAddress: typeof body.rolesModuleAddress === "string" ? body.rolesModuleAddress : "",
      rolesVersion: "v2",
      deploymentTxHash: typeof body.deploymentTransactionHash === "string" ? body.deploymentTransactionHash : "",
      network,
      deployedAtMs: Number(body.deployedAtMs)
    };
    const valid = (0,__vite_ssr_import_1__.validateSafeDeployment)(deployment);
    if (!valid.ok) return c.json({ error: valid.code, detail: valid.detail }, 400);
    const automationSigner = typeof body.automationSigner === "string" ? body.automationSigner : "";
    if (!ADDRESS.test(automationSigner)) {
      return c.json({ error: "invalid_request", detail: "automationSigner must be an EVM address" }, 400);
    };
    if (owners.length === 0 || !owners.every((o) => ADDRESS.test(o))) {
      return c.json({ error: "invalid_request", detail: "owners must be a non-empty list of EVM addresses" }, 400);
    };
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
      return c.json({ error: "invalid_request", detail: "threshold must be within the owner count" }, 400);
    };
    if (owners.some((o) => o.toLowerCase() === automationSigner.toLowerCase())) {
      return c.json(
        {
          error: "invalid_request",
          detail: "automationSigner must not be a Safe owner; owner threshold control stays separate from automated roles"
        },
        400
      );
    };
    const stored = await (0,__vite_ssr_import_9__.recordSafeDeployment)(c.env.DB, {
      deployment,
      owners,
      threshold,
      automationSigner,
      recordedBy: auth.principalId,
      nowMs: Date.now()
    });
    return c.json({ deployment: deploymentJson(stored) }, 201);
  });
  route.get("/commerce/treasury/safe-deployments", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const deployments = await (0,__vite_ssr_import_9__.listSafeDeployments)(c.env.DB);
    return c.json({ deployments: deployments.map(deploymentJson) }, 200);
  });
  route.post("/commerce/payment-channels/:channelId/settlements/:batchId/treasury", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    const batchId = c.req.param("batchId");
    const scope = c.req.query("scope") ?? "treasury";
    if (scope !== "treasury" && scope !== "components") return c.json({ error: "invalid_payout_scope" }, 400);
    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const adapter = availability.adapter;
    const policy = resolveTreasuryConfig(c.env, adapter);
    if (!policy.ok) return c.json({ error: policy.code, detail: policy.detail }, 503);
    const split = (0,__vite_ssr_import_11__.resolveSplitConfig)(c.env);
    if (!split.ok) return c.json({ error: split.code, detail: split.detail }, 503);
    const batch = await (0,__vite_ssr_import_5__.getSettlementBatch)(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: "batch_not_found" }, 404);
    };
    if (batch.state !== "final") {
      return c.json(
        { error: "batch_not_final", state: batch.state, detail: "treasury routing requires a settlement that has reached finality" },
        409
      );
    };
    const nonces = new Set(await (0,__vite_ssr_import_5__.retainedBatchUsageNonces)(c.env.DB, batchId));
    const receipts = (await (0,__vite_ssr_import_6__.listChannelUsageReceipts)(c.env.DB, channelId)).filter((receipt) => nonces.has(receipt.usageNonce));
    if (receipts.length !== batch.voucherDigests.length || nonces.size !== receipts.length || receipts.some((receipt) => !batch.voucherDigests.includes(receipt.voucherDigest))) {
      return c.json({ error: "retained_vouchers_mismatch" }, 409);
    };
    const receiptSplit = (0,__vite_ssr_import_11__.resolveUsageSplitManifest)(receipts, split.manifest);
    if (!receiptSplit.ok) return c.json({ error: "reconciliation_failed", detail: receiptSplit.detail }, 409);
    const reconciled = (0,__vite_ssr_import_2__.reconcileSettlement)({
      receipt: receiptFromBatch(batch),
      splitManifest: receiptSplit.manifest
    });
    if (!reconciled.ok) {
      return c.json({ error: "reconciliation_failed", code: reconciled.code, detail: reconciled.detail }, 409);
    };
    const deployment = await (0,__vite_ssr_import_9__.getSafeDeployment)(c.env.DB, policy.config.chainId, policy.config.safeAddress);
    if (!deployment) {
      return c.json(
        {
          error: "safe_deployment_unrecorded",
          detail: `no recorded Safe deployment for chain ${policy.config.chainId} at ${policy.config.safeAddress}`
        },
        409
      );
    };
    let routingConfig = policy.config;
    const componentPayees = {};
    if (scope === "components") {
      const recipients = parseList(c.env.TREASURY_COMPONENT_RECIPIENTS);
      if (recipients.length === 0 || recipients.some((recipient) => !ADDRESS.test(recipient))) {
        return c.json({ error: "component_policy_unconfigured", detail: "component payout needs an owner-configured recipient allowlist" }, 503);
      };
      for (const [author, amount] of Object.entries(reconciled.reconciliation.componentAllocationsMicros ?? {})) {
        if (amount === 0n) continue;
        const binding = await (0,__vite_ssr_import_7__.getWalletBinding)(c.env.DB, author);
        if (!binding || binding.chainId !== routingConfig.chainId) {
          return c.json({ error: "component_wallet_unverified", payeeId: author }, 409);
        };
        componentPayees[author] = binding;
      };
      routingConfig = { ...routingConfig, roles: {
        ...routingConfig.roles,
        settlement: { ...routingConfig.roles.settlement, allowedRecipients: recipients }
      } };
    };
    const plan = (0,__vite_ssr_import_1__.planTreasuryRouting)({
      config: routingConfig,
      deployment,
      reconciliation: reconciled.reconciliation,
      token: policy.config.roles.settlement.allowedTokens[0],
      role: "settlement",
      routedShares: scope === "components" ? ["component"] : policy.routedShares,
      componentPayees,
      mainnetCapitalApproved: policy.mainnetCapitalApproved
    });
    if (!plan.ok) return c.json({ error: "routing_refused", code: plan.code, detail: plan.detail }, 409);
    const nowMs = Date.now();
    const gate = await (0,__vite_ssr_import_12__.transferGateVerdict)(c.env.DB, c.env.RECONCILIATION_GATE_WORKSPACE, nowMs);
    if (!gate.open) {
      return c.json({ error: "transfers_paused", code: gate.code, detail: gate.detail }, 409);
    };
    const routed = [];
    const alreadyRouted = [];
    const unprovenTransfers = [];
    for (const transfer of plan.transfers) {
      const transferKey = transfer.payeeId ?? transfer.share;
      const existing = await (0,__vite_ssr_import_9__.getTreasuryTransferForShare)(c.env.DB, transfer.settlementReceiptHash, transfer.share, transfer.payeeId);
      if (existing) {
        if (existing.submissionState === "pending") {
          return c.json({
            error: "treasury_transfer_pending",
            payeeId: transfer.payeeId,
            transferId: existing.transferId,
            detail: "submission is reserved; reconcile its chain outcome before retrying"
          }, 409);
        };
        alreadyRouted.push(transferKey);
        routed.push(existing);
        continue;
      };
      const transferRecord = {
        transferId: `tt-${transfer.settlementReceiptHash.slice(0, 32)}-${transfer.share}${transfer.payeeId !== void 0 ? `-${encodeURIComponent(transfer.payeeId)}` : ""}`,
        batchId: batch.batchId,
        channelId,
        principalId: auth.principalId,
        settlementId: reconciled.reconciliation.settlementId,
        receiptHash: transfer.settlementReceiptHash,
        splitManifestHash: reconciled.reconciliation.splitManifestHash,
        share: transfer.share,
        payeeId: transfer.payeeId,
        role: transfer.role,
        chainId: deployment.chainId,
        safeAddress: deployment.safeAddress,
        rolesModuleAddress: deployment.rolesModuleAddress,
        token: transfer.token,
        recipient: transfer.recipient,
        amountMicros: transfer.amountMicros,
        safeTxHash: transfer.safeTxHash,
        nowMs
      };
      if (!await (0,__vite_ssr_import_9__.reserveTreasuryTransfer)(c.env.DB, transferRecord)) {
        return c.json({
          error: "treasury_transfer_pending",
          payeeId: transfer.payeeId,
          transferId: transferRecord.transferId
        }, 409);
      };
      let receipt;
      try {
        receipt = await adapter.submitTransfer({
          share: transfer.share,
          token: transfer.token,
          recipient: transfer.recipient,
          amountMicros: transfer.amountMicros,
          safeTxHash: transfer.safeTxHash
        });
      } catch (error) {
        return c.json(
          {
            error: "treasury_transfer_failed",
            share: transfer.share,
            detail: error instanceof Error ? error.message : String(error),
            routed: routed.map((entry) => entry.transferId)
          },
          502
        );
      };
      const proof = await recordTreasuryProof(c.env.DB, adapter, {
        streamId: treasuryStream(channelId),
        channelId,
        payer: batch.principalId,
        transfer,
        reconciliation: reconciled.reconciliation,
        deployment,
        transaction: receipt,
        nowMs
      }).catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
      if (!proof.ok) unprovenTransfers.push(transferKey);
      const stored = await (0,__vite_ssr_import_9__.recordTreasuryTransfer)(c.env.DB, {
        ...transferRecord,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        proofEventId: proof.ok ? proof.event.eventId : null
      });
      if (!stored.ok) alreadyRouted.push(transferKey);
      routed.push(stored.transfer);
    };
    return c.json(
      {
        batchId: batch.batchId,
        settlementId: reconciled.reconciliation.settlementId,
        receiptHash: reconciled.reconciliation.receiptHash,
        splitManifestHash: reconciled.reconciliation.splitManifestHash,
        network: deployment.network,
        safeAddress: deployment.safeAddress,
        transfers: routed.map(transferJson),
        alreadyRouted,
        // Non-empty means the money moved but its receipt is not on the event
        // log. Surfaced, never hidden behind the 200.
        unprovenTransfers
      },
      200
    );
  });
  route.get("/commerce/payment-channels/:channelId/settlements/:batchId/treasury", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const batch = await (0,__vite_ssr_import_5__.getSettlementBatch)(c.env.DB, c.req.param("batchId"));
    if (!batch || batch.channelId !== c.req.param("channelId") || batch.principalId !== auth.principalId) {
      return c.json({ error: "batch_not_found" }, 404);
    };
    const transfers = await (0,__vite_ssr_import_9__.listBatchTreasuryTransfers)(c.env.DB, batch.batchId);
    return c.json({ batchId: batch.batchId, transfers: transfers.map(transferJson) }, 200);
  });
  return route;
};
function transferJson(transfer) {
  return {
    transferId: transfer.transferId,
    share: transfer.share,
    ...transfer.payeeId !== void 0 ? { payeeId: transfer.payeeId } : {},
    submissionState: transfer.submissionState,
    role: transfer.role,
    token: transfer.token,
    recipient: transfer.recipient,
    amountMicros: transfer.amountMicros,
    chainId: transfer.chainId,
    safeAddress: transfer.safeAddress,
    rolesModuleAddress: transfer.rolesModuleAddress,
    safeTxHash: transfer.safeTxHash,
    transactionHash: transfer.transactionHash,
    blockNumber: transfer.blockNumber,
    proofEventId: transfer.proofEventId,
    receiptHash: transfer.receiptHash,
    createdAtMs: transfer.createdAtMs
  };
}
async function recordTreasuryProof(db, adapter, input) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sequence = await (0,__vite_ssr_import_8__.nextCommerceEventSequence)(db, input.streamId);
    const transferEvent = (0,__vite_ssr_import_1__.buildTreasuryTransferEvent)({
      streamId: input.streamId,
      issuer: adapter.automationSigner,
      sequence,
      occurredAtMs: input.nowMs,
      transfer: input.transfer,
      reconciliation: input.reconciliation,
      deployment: input.deployment,
      transaction: input.transaction
    });
    const unsigned = { ...transferEvent, payload: {
      ...transferEvent.payload,
      channelId: input.channelId,
      payer: input.payer,
      payoutStatus: "submitted"
    } };
    const signature = await adapter.signTreasuryProof((0,__vite_ssr_import_3__.commerceEventSigningBytes)(unsigned));
    const appended = await (0,__vite_ssr_import_8__.appendCommerceEvent)(db, { ...unsigned, signature }, input.nowMs);
    if (appended.ok) return { ok: true, event: appended.event.event };
    if (appended.code !== "sequence-conflict") return { ok: false, detail: appended.detail };
  };
  return { ok: false, detail: "treasury receipt could not be sequenced onto the commerce event log" };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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O0FBQUEsTUFBTyxjQUFjO0FBQUEsSUFBWSxFQUFFO0FBQzlFLFVBQU0sWUFBWSxNQUFNLFFBQVEscUJBQWtCLGlEQUEwQixRQUFRLENBQUM7QUFDckYsVUFBTSxXQUFXLFNBQU0sMkNBQW9CLElBQUksRUFBRSxHQUFHLFVBQVUsVUFBVSxHQUFHLE1BQU0sS0FBSztBQUN0RixRQUFJLFNBQVMsR0FBSSxRQUFPLEVBQUUsSUFBSSxNQUFNLE9BQU8sU0FBUyxNQUFNLE1BQU07QUFDaEUsUUFBSSxTQUFTLFNBQVMsb0JBQXFCLFFBQU8sRUFBRSxJQUFJLE9BQU8sUUFBUSxTQUFTLE9BQU87QUFBQSxFQUN6RjtBQUNBLFNBQU8sRUFBRSxJQUFJLE9BQU8sUUFBUSxzRUFBc0U7QUFDcEciLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInRyZWFzdXJ5LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXV0aGVudGljYXRlZCBwcm9kdWN0aW9uIGRvb3IgZm9yIFAtMDM0IERBTyB0cmVhc3VyeSByb3V0aW5nIChhY2NlcHRhbmNlXG4gKiBsaW5lIDEzKS5cbiAqXG4gKiBQLTAzMyBSRUNPUkRFRCBhIHNldHRsZW1lbnQncyBhbGxvY2F0aW9uczsgdGhpcyBST1VURVMgdGhlbS4gVGhlIGNoYWluIG9mXG4gKiByZWZ1c2FscyBiZXR3ZWVuIHRoZSB0d28gaXMgdGhlIHdob2xlIGl0ZW06XG4gKlxuICogICAxLiB0aGUgYmF0Y2ggbXVzdCBiZSBGSU5BTCwgbm90IG1lcmVseSBjbGFpbWVkIOKAlCBhIHJlb3JnIGNhbiBzdGlsbCBkcm9wIGFcbiAqICAgICAgY2xhaW0sIGFuZCB1bmxpa2UgYW4gdW53b3VuZCBjbGFpbSB0aGVyZSBpcyBubyB1bmRvaW5nIGEgdHJhbnNmZXIgdGhhdFxuICogICAgICBoYXMgYWxyZWFkeSBsZWZ0IHRoZSBTYWZlO1xuICogICAyLiB0aGUgcmVjb3JkZWQgYWxsb2NhdGlvbnMgbXVzdCBSRUNPTkNJTEUgYWdhaW5zdCB0aGUgZGVwbG95bWVudCdzXG4gKiAgICAgIGltbXV0YWJsZSBzcGxpdCBtYW5pZmVzdCwgc2hhcmUgYnkgc2hhcmUg4oCUIHRoZSBudW1iZXJzIHNhdCBpbiBhIEQxIHJvd1xuICogICAgICBiZXR3ZWVuIGNsYWltIGFuZCByb3V0aW5nLCBhbmQgcm91dGluZyBvbiB0aGUgcm93IGFsb25lIHdvdWxkIHRydXN0IGFcbiAqICAgICAgdmFsdWUgbm90aGluZyByZS1jaGVja2VkO1xuICogICAzLiBhIFNhZmUgKyBab2RpYWMgUm9sZXMgdjIgREVQTE9ZTUVOVCBtdXN0IGJlIHJlY29yZGVkIGZvciB0aGUgY29uZmlndXJlZFxuICogICAgICAoY2hhaW4sIGFkZHJlc3MpIOKAlCBhIGNvbmZpZ3VyZWQgYWRkcmVzcyBpcyBub3QgZXZpZGVuY2UgYSBTYWZlIGV4aXN0c1xuICogICAgICB0aGVyZSwgYW5kIGZ1bmRzIHNlbnQgdG8gYSB0eXBvIGFyZSB1bnJlY292ZXJhYmxlO1xuICogICA0LiBgcG9saWN5QXBwcm92ZWRgIGlzIGRlcml2ZWQgSEVSRSBmcm9tIHRob3NlIGZhY3RzIGFuZCBpcyBuZXZlciByZWFkIGZyb21cbiAqICAgICAgdGhlIHJlcXVlc3QgYm9keSDigJQgYSBjYWxsZXIgdGhhdCBjb3VsZCBhc3NlcnQgaXRzIG93biBhcHByb3ZhbCB3b3VsZFxuICogICAgICBtYWtlIHRoZSBQLTAyMyBwb2xpY3kgY2hlY2sgZGVjb3JhdGl2ZTtcbiAqICAgNS4gbWFpbm5ldCBjYXBpdGFsIGFkZGl0aW9uYWxseSByZXF1aXJlcyB0aGUgb3duZXIncyBleHBsaWNpdCBhcHByb3ZhbC5cbiAqXG4gKiBPd25lci1nYXRlZCBieSBkZXNpZ24gKGFjY2VwdGFuY2UgbGluZSAxMyk6IHRoZSBTYWZlIHNpZ25lcnMsIHRoZSBhdXRvbWF0aW9uXG4gKiBrZXksIGFuZCBtYWlubmV0IGNhcGl0YWwuIE1pc3NpbmcgY3JlZGVudGlhbHMgYW5zd2VyIDUwMyByYXRoZXIgdGhhblxuICogYXR0ZW1wdGluZyBhIHRyYW5zZmVyIHRoYXQgY2Fubm90IGJlIHNpZ25lZC5cbiAqL1xuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHtcbiAgYnVpbGRUcmVhc3VyeVRyYW5zZmVyRXZlbnQsXG4gIHBsYW5UcmVhc3VyeVJvdXRpbmcsXG4gIHZhbGlkYXRlU2FmZURlcGxveW1lbnQsXG4gIHR5cGUgU2FmZURlcGxveW1lbnRSZWNvcmQsXG4gIHR5cGUgU2FmZVRyZWFzdXJ5Q29uZmlnLFxuICB0eXBlIFRyZWFzdXJ5TmV0d29yayxcbn0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvdHJlYXN1cnktY29udHJvbHMudHMnO1xuaW1wb3J0IHtcbiAgUkVWRU5VRV9TSEFSRVMsXG4gIHJlY29uY2lsZVNldHRsZW1lbnQsXG4gIHR5cGUgUmV2ZW51ZVNoYXJlLFxuICB0eXBlIFNldHRsZW1lbnRSZWNlaXB0LFxufSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL3AycC9yZXZlbnVlLXNldHRsZW1lbnQudHMnO1xuaW1wb3J0IHtcbiAgY29tbWVyY2VFdmVudFNpZ25pbmdCeXRlcyxcbiAgdHlwZSBDb21tZXJjZUV2ZW50LFxufSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL3AycC9jb21tZXJjZS1ldmVudHMudHMnO1xuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuLi9lbnYudHMnO1xuaW1wb3J0IHsgQXV0aEVycm9yLCBpc0N1cGJvYXJkT3BlcmF0b3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7IGdldFNldHRsZW1lbnRCYXRjaCwgcmV0YWluZWRCYXRjaFVzYWdlTm9uY2VzLCB0eXBlIFN0b3JlZFNldHRsZW1lbnRCYXRjaCB9IGZyb20gJy4uL3NldHRsZW1lbnQtYmF0Y2gtc3RvcmUudHMnO1xuaW1wb3J0IHsgbGlzdENoYW5uZWxVc2FnZVJlY2VpcHRzIH0gZnJvbSAnLi4vdXNhZ2UtcmVjZWlwdC1zdG9yZS50cyc7XG5pbXBvcnQgeyBnZXRXYWxsZXRCaW5kaW5nIH0gZnJvbSAnLi4vd2FsbGV0LWJpbmRpbmctc3RvcmUudHMnO1xuaW1wb3J0IHtcbiAgYXBwZW5kQ29tbWVyY2VFdmVudCxcbiAgbmV4dENvbW1lcmNlRXZlbnRTZXF1ZW5jZSxcbn0gZnJvbSAnLi4vY29tbWVyY2UtZXZlbnQtbG9nLXN0b3JlLnRzJztcbmltcG9ydCB7XG4gIGdldFNhZmVEZXBsb3ltZW50LFxuICBnZXRUcmVhc3VyeVRyYW5zZmVyRm9yU2hhcmUsXG4gIGxpc3RCYXRjaFRyZWFzdXJ5VHJhbnNmZXJzLFxuICBsaXN0U2FmZURlcGxveW1lbnRzLFxuICByZWNvcmRTYWZlRGVwbG95bWVudCxcbiAgcmVjb3JkVHJlYXN1cnlUcmFuc2ZlcixcbiAgcmVzZXJ2ZVRyZWFzdXJ5VHJhbnNmZXIsXG4gIHR5cGUgU3RvcmVkU2FmZURlcGxveW1lbnQsXG59IGZyb20gJy4uL3RyZWFzdXJ5LXN0b3JlLnRzJztcbmltcG9ydCB7XG4gIGNyZWF0ZVZpZW1TYWZlVHJlYXN1cnlBZGFwdGVyLFxuICB0eXBlIFNhZmVUcmVhc3VyeUFkYXB0ZXIsXG59IGZyb20gJy4uL3RyZWFzdXJ5LWFkYXB0ZXIudHMnO1xuaW1wb3J0IHsgcmVzb2x2ZVNwbGl0Q29uZmlnLCByZXNvbHZlVXNhZ2VTcGxpdE1hbmlmZXN0IH0gZnJvbSAnLi9zZXR0bGVtZW50cy50cyc7XG5pbXBvcnQgeyB0cmFuc2ZlckdhdGVWZXJkaWN0IH0gZnJvbSAnLi4vdHJhbnNmZXItZ2F0ZS1zdG9yZS50cyc7XG5cbmNvbnN0IEFERFJFU1MgPSAvXjB4WzAtOWEtZkEtRl17NDB9JC87XG5cbi8qKlxuICogU2hhcmVzIHRoYXQgbWF5IGJlIHJvdXRlZCBpbnRvIHRoZSBEQU8gU2FmZS5cbiAqXG4gKiBgY3JlYXRvcmAsIGBob3N0YCBhbmQgYGNvbXBvbmVudGAgYXJlIFBBWUVFIHNoYXJlcyDigJQgbW9uZXkgb3dlZCBvdXR3YXJkIHRvIGFcbiAqIHBlcnNvbiDigJQgc28gdGhleSBhcmUgcmVmdXNlZCBoZXJlIHJhdGhlciB0aGFuIHF1aWV0bHkgc3dlcHQgaW50byB0aGVcbiAqIHRyZWFzdXJ5LiBUaGVpciBwYXlvdXQgcmFpbCBpcyBhIHNlcGFyYXRlIGNvbmNlcm4gd2l0aCBhIHNlcGFyYXRlIHJvbGUuXG4gKi9cbmNvbnN0IFRSRUFTVVJZX0VMSUdJQkxFX1NIQVJFUzogcmVhZG9ubHkgUmV2ZW51ZVNoYXJlW10gPSBbJ2RhbycsICdyZXNlcnZlJywgJ3RheCcsICdvcGVyYXRpbmcnXTtcblxuYXN5bmMgZnVuY3Rpb24gYXV0aGVudGljYXRlKFxuICByZXF1ZXN0OiBSZXF1ZXN0LFxuKTogUHJvbWlzZTx7IG9rOiB0cnVlOyBwcmluY2lwYWxJZDogc3RyaW5nOyB1c2VySWQ6IG51bWJlciB9IHwgeyBvazogZmFsc2U7IHJlYXNvbjogQXV0aEVycm9yWydyZWFzb24nXSB9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIocmVxdWVzdCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHByaW5jaXBhbElkOiBgZ2g6JHt1c2VyLmlkfWAsIHVzZXJJZDogdXNlci5pZCB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEF1dGhFcnJvcikgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IGVycm9yLnJlYXNvbiB9O1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGpzb25PYmplY3QocmVxdWVzdDogUmVxdWVzdCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdmFsdWU6IHVua25vd24gPSBhd2FpdCByZXF1ZXN0Lmpzb24oKTtcbiAgICByZXR1cm4gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSlcbiAgICAgID8gKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlZCh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRyaW0oKSA/IHZhbHVlLnRyaW0oKSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIHBhcnNlTGlzdCh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogcmVhZG9ubHkgc3RyaW5nW10ge1xuICByZXR1cm4gKHZhbHVlID8/ICcnKVxuICAgIC5zcGxpdCgnLCcpXG4gICAgLm1hcCgoZW50cnkpID0+IGVudHJ5LnRyaW0oKSlcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkubGVuZ3RoID4gMCk7XG59XG5cbmV4cG9ydCB0eXBlIFRyZWFzdXJ5Q29uZmlnUmVzb2x1dGlvbiA9XG4gIHwge1xuICAgICAgcmVhZG9ubHkgb2s6IHRydWU7XG4gICAgICByZWFkb25seSBjb25maWc6IFNhZmVUcmVhc3VyeUNvbmZpZztcbiAgICAgIHJlYWRvbmx5IHJvdXRlZFNoYXJlczogcmVhZG9ubHkgUmV2ZW51ZVNoYXJlW107XG4gICAgICByZWFkb25seSBtYWlubmV0Q2FwaXRhbEFwcHJvdmVkOiBib29sZWFuO1xuICAgIH1cbiAgfCB7IHJlYWRvbmx5IG9rOiBmYWxzZTsgcmVhZG9ubHkgY29kZTogJ25vdC1jb25maWd1cmVkJyB8ICdpbnZhbGlkLWNvbmZpZyc7IHJlYWRvbmx5IGRldGFpbDogc3RyaW5nIH07XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZGVwbG95bWVudCdzIFNhZmUgdHJlYXN1cnkgcG9saWN5LlxuICpcbiAqIFRoZSBhdXRvbWF0aW9uIHNpZ25lciBjb21lcyBmcm9tIHRoZSBBREFQVEVSICh0aGUgYWRkcmVzcyBkZXJpdmVkIGZyb20gdGhlXG4gKiBzaWduaW5nIGtleSksIG5ldmVyIGZyb20gYSB2YXI6IGEgY29uZmlndXJlZCBzaWduZXIgYWRkcmVzcyB0aGF0IGRpc2FncmVlZFxuICogd2l0aCB0aGUga2V5IGFjdHVhbGx5IHNpZ25pbmcgd291bGQgbWFrZSB0aGUgb3duZXItc2VwYXJhdGlvbiBjaGVjayBhc3NlcnRcbiAqIHNvbWV0aGluZyBhYm91dCBhIHNpZ25lciB0aGF0IGlzIG5vdCB0aGUgb25lIHNwZW5kaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRyZWFzdXJ5Q29uZmlnKGVudjogRW52LCBhZGFwdGVyOiBTYWZlVHJlYXN1cnlBZGFwdGVyKTogVHJlYXN1cnlDb25maWdSZXNvbHV0aW9uIHtcbiAgY29uc3Qgc2FmZUFkZHJlc3MgPSByZXF1aXJlZChlbnYuVFJFQVNVUllfU0FGRV9BRERSRVNTKTtcbiAgY29uc3Qgb3duZXJzID0gcGFyc2VMaXN0KGVudi5UUkVBU1VSWV9TQUZFX09XTkVSUyk7XG4gIGNvbnN0IHRocmVzaG9sZFJhdyA9IHJlcXVpcmVkKGVudi5UUkVBU1VSWV9TQUZFX1RIUkVTSE9MRCk7XG4gIGNvbnN0IG1heFJhdyA9IHJlcXVpcmVkKGVudi5UUkVBU1VSWV9TRVRUTEVNRU5UX01BWF9NSUNST1MpO1xuICBjb25zdCBkYW9UcmVhc3VyeSA9IHJlcXVpcmVkKGVudi5EQU9fVFJFQVNVUllfQUREUkVTUyk7XG5cbiAgY29uc3QgbWlzc2luZyA9IFtcbiAgICBzYWZlQWRkcmVzcyA/IG51bGwgOiAnVFJFQVNVUllfU0FGRV9BRERSRVNTJyxcbiAgICBvd25lcnMubGVuZ3RoID4gMCA/IG51bGwgOiAnVFJFQVNVUllfU0FGRV9PV05FUlMnLFxuICAgIHRocmVzaG9sZFJhdyA/IG51bGwgOiAnVFJFQVNVUllfU0FGRV9USFJFU0hPTEQnLFxuICAgIG1heFJhdyA/IG51bGwgOiAnVFJFQVNVUllfU0VUVExFTUVOVF9NQVhfTUlDUk9TJyxcbiAgICBkYW9UcmVhc3VyeSA/IG51bGwgOiAnREFPX1RSRUFTVVJZX0FERFJFU1MnLFxuICAgIHJlcXVpcmVkKGVudi5QQVlNRU5UX0NIQU5ORUxfU1RBQkxFQ09JTikgPyBudWxsIDogJ1BBWU1FTlRfQ0hBTk5FTF9TVEFCTEVDT0lOJyxcbiAgXS5maWx0ZXIoKG5hbWUpOiBuYW1lIGlzIHN0cmluZyA9PiBuYW1lICE9PSBudWxsKTtcbiAgaWYgKG1pc3NpbmcubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ25vdC1jb25maWd1cmVkJywgZGV0YWlsOiBgdHJlYXN1cnkgcG9saWN5IGlzIHVuYXZhaWxhYmxlOyBtaXNzaW5nICR7bWlzc2luZy5qb2luKCcsICcpfWAgfTtcbiAgfVxuXG4gIGNvbnN0IHRocmVzaG9sZCA9IE51bWJlcih0aHJlc2hvbGRSYXcpO1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHRocmVzaG9sZCkgfHwgdGhyZXNob2xkIDwgMSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiBgVFJFQVNVUllfU0FGRV9USFJFU0hPTEQgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXIsIGdvdCAnJHt0aHJlc2hvbGRSYXd9J2AgfTtcbiAgfVxuICAvLyBBIFNFVCBidXQgdW5wYXJzZWFibGUgY2FwIGlzIGFuIGVycm9yLCBuZXZlciBhIHNpbGVudCBmYWxsYmFjazogZGVmYXVsdGluZ1xuICAvLyBhIHBlci10cmFuc2ZlciBzcGVuZGluZyBjYXAgdGhlIG9wZXJhdG9yIG1lYW50IHRvIHNldCBpcyBleGFjdGx5IHRoZVxuICAvLyBmYWlsdXJlIGEgY2FwIGV4aXN0cyB0byBwcmV2ZW50LlxuICBsZXQgbWF4QW1vdW50TWljcm9zOiBiaWdpbnQ7XG4gIHRyeSB7XG4gICAgbWF4QW1vdW50TWljcm9zID0gQmlnSW50KG1heFJhdyBhcyBzdHJpbmcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdpbnZhbGlkLWNvbmZpZycsIGRldGFpbDogYFRSRUFTVVJZX1NFVFRMRU1FTlRfTUFYX01JQ1JPUyBtdXN0IGJlIGFuIGludGVnZXIsIGdvdCAnJHttYXhSYXd9J2AgfTtcbiAgfVxuICBpZiAobWF4QW1vdW50TWljcm9zIDw9IDBuKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1jb25maWcnLCBkZXRhaWw6ICdUUkVBU1VSWV9TRVRUTEVNRU5UX01BWF9NSUNST1MgbXVzdCBiZSBwb3NpdGl2ZScgfTtcbiAgfVxuXG4gIGNvbnN0IGNvbmZpZ3VyZWRTaGFyZXMgPSBwYXJzZUxpc3QoZW52LlRSRUFTVVJZX1JPVVRFRF9TSEFSRVMpO1xuICBjb25zdCByb3V0ZWRTaGFyZXM6IFJldmVudWVTaGFyZVtdID0gW107XG4gIGZvciAoY29uc3QgZW50cnkgb2YgY29uZmlndXJlZFNoYXJlcy5sZW5ndGggPiAwID8gY29uZmlndXJlZFNoYXJlcyA6IFsnZGFvJ10pIHtcbiAgICBpZiAoIVJFVkVOVUVfU0hBUkVTLmluY2x1ZGVzKGVudHJ5IGFzIFJldmVudWVTaGFyZSkpIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiBgVFJFQVNVUllfUk9VVEVEX1NIQVJFUyBjb250YWlucyB1bmtub3duIHNoYXJlICcke2VudHJ5fSdgIH07XG4gICAgfVxuICAgIGlmICghVFJFQVNVUllfRUxJR0lCTEVfU0hBUkVTLmluY2x1ZGVzKGVudHJ5IGFzIFJldmVudWVTaGFyZSkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgY29kZTogJ2ludmFsaWQtY29uZmlnJyxcbiAgICAgICAgZGV0YWlsOiBgVFJFQVNVUllfUk9VVEVEX1NIQVJFUyBtYXkgbm90IHJvdXRlIHBheWVlIHNoYXJlICcke2VudHJ5fScgaW50byB0aGUgREFPIFNhZmVgLFxuICAgICAgfTtcbiAgICB9XG4gICAgcm91dGVkU2hhcmVzLnB1c2goZW50cnkgYXMgUmV2ZW51ZVNoYXJlKTtcbiAgfVxuXG4gIGNvbnN0IHRva2VuID0gcmVxdWlyZWQoZW52LlBBWU1FTlRfQ0hBTk5FTF9TVEFCTEVDT0lOKSBhcyBzdHJpbmc7XG4gIGlmICghQUREUkVTUy50ZXN0KHRva2VuKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ2ludmFsaWQtY29uZmlnJywgZGV0YWlsOiAnUEFZTUVOVF9DSEFOTkVMX1NUQUJMRUNPSU4gbXVzdCBiZSBhbiBFVk0gYWRkcmVzcycgfTtcbiAgfVxuICBpZiAoIUFERFJFU1MudGVzdChkYW9UcmVhc3VyeSBhcyBzdHJpbmcpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1jb25maWcnLCBkZXRhaWw6ICdEQU9fVFJFQVNVUllfQUREUkVTUyBtdXN0IGJlIGFuIEVWTSBhZGRyZXNzJyB9O1xuICB9XG5cbiAgY29uc3Qgcm9sZSA9IHtcbiAgICBlbmFibGVkOiB0cnVlLFxuICAgIG1heEFtb3VudE1pY3JvcyxcbiAgICBhbGxvd2VkUmVjaXBpZW50czogW2Rhb1RyZWFzdXJ5IGFzIHN0cmluZ10sXG4gICAgYWxsb3dlZFRva2VuczogW3Rva2VuXSxcbiAgfTtcbiAgLy8gT25seSB0aGUgYHNldHRsZW1lbnRgIHJvbGUgaXMgZW5hYmxlZCBmb3IgYXV0b21hdGlvbi4gVGhlIHBheW91dCwgcmVzZXJ2ZVxuICAvLyBhbmQgcGF1c2Ugcm9sZXMgZXhpc3QgaW4gdGhlIGNvbmZpZyBzbyB0aGVpciBib3VuZHMgYXJlIGV4cGxpY2l0LCBhbmQgYXJlXG4gIC8vIGRpc2FibGVkIHNvIHRoaXMgZG9vciBjYW5ub3QgcmVhY2ggdGhlbS5cbiAgY29uc3QgZGlzYWJsZWQgPSB7IC4uLnJvbGUsIGVuYWJsZWQ6IGZhbHNlIH07XG4gIGNvbnN0IGNvbmZpZzogU2FmZVRyZWFzdXJ5Q29uZmlnID0ge1xuICAgIGNoYWluSWQ6IGFkYXB0ZXIuY2hhaW5JZCxcbiAgICBzYWZlQWRkcmVzczogc2FmZUFkZHJlc3MgYXMgc3RyaW5nLFxuICAgIG93bmVycyxcbiAgICB0aHJlc2hvbGQsXG4gICAgYXV0b21hdGlvblNpZ25lcjogYWRhcHRlci5hdXRvbWF0aW9uU2lnbmVyLFxuICAgIHJvbGVzOiB7XG4gICAgICBzZXR0bGVtZW50OiByb2xlLFxuICAgICAgJ2hvc3QtcGF5b3V0JzogZGlzYWJsZWQsXG4gICAgICAncmVzZXJ2ZS10cmFuc2Zlcic6IGRpc2FibGVkLFxuICAgICAgJ2VtZXJnZW5jeS1wYXVzZSc6IGRpc2FibGVkLFxuICAgIH0sXG4gIH07XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgY29uZmlnLFxuICAgIHJvdXRlZFNoYXJlcyxcbiAgICAvLyBEZWZhdWx0cyB0byBSRUZVU0UuIE9ubHkgdGhlIGV4YWN0IHN0cmluZyAndHJ1ZScgb3BlbnMgdGhlIG1haW5uZXQgZ2F0ZS5cbiAgICBtYWlubmV0Q2FwaXRhbEFwcHJvdmVkOiByZXF1aXJlZChlbnYuVFJFQVNVUllfTUFJTk5FVF9DQVBJVEFMX0FQUFJPVkVEKSA9PT0gJ3RydWUnLFxuICB9O1xufVxuXG4vKipcbiAqIFJlYnVpbGQgdGhlIHNldHRsZW1lbnQgcmVjZWlwdCBmcm9tIGl0cyBkdXJhYmxlIHJvdywgZm9yIHJlLXJlY29uY2lsaWF0aW9uLlxuICpcbiAqIGByZWNlaXB0SGFzaGAgaXMgY2FycmllZCB0aHJvdWdoIGZyb20gdGhlIHJvdyByYXRoZXIgdGhhbiByZWNvbXB1dGVkIGhlcmUgb25cbiAqIHB1cnBvc2U6IGByZWNvbmNpbGVTZXR0bGVtZW50YCByZWNvbXB1dGVzIGl0IGFuZCBjb21wYXJlcywgc28gcmVjb21wdXRpbmcgaXRcbiAqIG9uIHRoZSB3YXkgSU4gd291bGQgbWFrZSB0aGF0IGNvbXBhcmlzb24gY29tcGFyZSBhIHZhbHVlIHdpdGggaXRzZWxmIGFuZFxuICogYWx3YXlzIGFncmVlLlxuICovXG5mdW5jdGlvbiByZWNlaXB0RnJvbUJhdGNoKGJhdGNoOiBTdG9yZWRTZXR0bGVtZW50QmF0Y2gpOiBTZXR0bGVtZW50UmVjZWlwdCB7XG4gIGNvbnN0IGFsbG9jYXRpb25zTWljcm9zID0ge30gYXMgUmVjb3JkPFJldmVudWVTaGFyZSwgYmlnaW50PjtcbiAgZm9yIChjb25zdCBzaGFyZSBvZiBSRVZFTlVFX1NIQVJFUykgYWxsb2NhdGlvbnNNaWNyb3Nbc2hhcmVdID0gQmlnSW50KGJhdGNoLmFsbG9jYXRpb25zTWljcm9zW3NoYXJlXSk7XG4gIHJldHVybiB7XG4gICAgc2V0dGxlbWVudElkOiBiYXRjaC5zZXR0bGVtZW50SWQsXG4gICAgY3VycmVuY3k6ICdzdGFibGVjb2luLW1pY3JvcycsXG4gICAgZ3Jvc3NNaWNyb3M6IEJpZ0ludChiYXRjaC5jbGFpbU1pY3JvcyksXG4gICAgcHJvdmlkZXJDb3N0TWljcm9zOiBCaWdJbnQoYmF0Y2gucHJvdmlkZXJDb3N0TWljcm9zKSxcbiAgICBkaXN0cmlidXRhYmxlTWljcm9zOiBCaWdJbnQoYmF0Y2guZGlzdHJpYnV0YWJsZU1pY3JvcyksXG4gICAgYWxsb2NhdGlvbnNNaWNyb3MsXG4gICAgLi4uKGJhdGNoLmNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zICE9PSB1bmRlZmluZWQgPyB7XG4gICAgICBjb21wb25lbnRBbGxvY2F0aW9uc01pY3JvczogT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGJhdGNoLmNvbXBvbmVudEFsbG9jYXRpb25zTWljcm9zKVxuICAgICAgICAubWFwKChbYXV0aG9yLCBhbW91bnRdKSA9PiBbYXV0aG9yLCBCaWdJbnQoYW1vdW50KV0pKSxcbiAgICB9IDoge30pLFxuICAgIGRhb1RyZWFzdXJ5OiBiYXRjaC5kYW9UcmVhc3VyeSxcbiAgICBzcGxpdE1hbmlmZXN0SGFzaDogYmF0Y2guc3BsaXRNYW5pZmVzdEhhc2gsXG4gICAgcmVjZWlwdEhhc2g6IGJhdGNoLnJlY2VpcHRIYXNoLFxuICB9O1xufVxuXG5mdW5jdGlvbiBkZXBsb3ltZW50SnNvbihkZXBsb3ltZW50OiBTdG9yZWRTYWZlRGVwbG95bWVudCkge1xuICByZXR1cm4ge1xuICAgIGNoYWluSWQ6IGRlcGxveW1lbnQuY2hhaW5JZCxcbiAgICBzYWZlQWRkcmVzczogZGVwbG95bWVudC5zYWZlQWRkcmVzcyxcbiAgICByb2xlc01vZHVsZUFkZHJlc3M6IGRlcGxveW1lbnQucm9sZXNNb2R1bGVBZGRyZXNzLFxuICAgIHJvbGVzVmVyc2lvbjogZGVwbG95bWVudC5yb2xlc1ZlcnNpb24sXG4gICAgZGVwbG95bWVudFRyYW5zYWN0aW9uSGFzaDogZGVwbG95bWVudC5kZXBsb3ltZW50VHhIYXNoLFxuICAgIG5ldHdvcms6IGRlcGxveW1lbnQubmV0d29yayxcbiAgICBvd25lcnM6IFsuLi5kZXBsb3ltZW50Lm93bmVyc10sXG4gICAgdGhyZXNob2xkOiBkZXBsb3ltZW50LnRocmVzaG9sZCxcbiAgICBhdXRvbWF0aW9uU2lnbmVyOiBkZXBsb3ltZW50LmF1dG9tYXRpb25TaWduZXIsXG4gICAgZGVwbG95ZWRBdE1zOiBkZXBsb3ltZW50LmRlcGxveWVkQXRNcyxcbiAgICByZWNvcmRlZEF0TXM6IGRlcGxveW1lbnQucmVjb3JkZWRBdE1zLFxuICAgIHJlY29yZGVkQnk6IGRlcGxveW1lbnQucmVjb3JkZWRCeSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYWRhcHRlckZvcihlbnY6IEVudiwgaW5qZWN0ZWQ6IFNhZmVUcmVhc3VyeUFkYXB0ZXIgfCB1bmRlZmluZWQpIHtcbiAgcmV0dXJuIGluamVjdGVkID8geyBvazogdHJ1ZSBhcyBjb25zdCwgYWRhcHRlcjogaW5qZWN0ZWQgfSA6IGNyZWF0ZVZpZW1TYWZlVHJlYXN1cnlBZGFwdGVyKGVudik7XG59XG5cbmZ1bmN0aW9uIHRyZWFzdXJ5U3RyZWFtKGNoYW5uZWxJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGB0cmVhc3VyeToke2NoYW5uZWxJZH1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJlYXN1cnlSb3V0ZShcbiAgb3B0aW9uczogeyBhZGFwdGVyPzogU2FmZVRyZWFzdXJ5QWRhcHRlciB9ID0ge30sXG4pOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IHJvdXRlID0gbmV3IEhvbm88eyBCaW5kaW5nczogRW52IH0+KCk7XG5cbiAgLyoqXG4gICAqIFJlY29yZCBhbiBvYnNlcnZlZCBTYWZlICsgWm9kaWFjIFJvbGVzIHYyIGRlcGxveW1lbnQuXG4gICAqXG4gICAqIE9wZXJhdG9yLWdhdGVkLCBub3QgbWVyZWx5IGF1dGhlbnRpY2F0ZWQ6IHRoaXMgaXMgdGhlIHJlY29yZCBldmVyeSByb3V0aW5nXG4gICAqIGRlY2lzaW9uIHJlc3RzIG9uLCBzbyB3cml0aW5nIGl0IGlzIGFuIG9wZXJhdG9yIGFjdGlvbiBhdHRyaWJ1dGVkIHRvIGFcbiAgICogR2l0SHViIGlkLiBUaGUgcGlsb3QgcmVjb3JkcyBhIFRFU1RORVQgZGVwbG95bWVudDsgYSBtYWlubmV0IHJlY29yZCBpc1xuICAgKiBhY2NlcHRlZCBoZXJlIChzbyB0aGUgZmFjdCBpcyBhdWRpdGFibGUpIGJ1dCByb3V0aW5nIGFnYWluc3QgaXQgc3RpbGxcbiAgICogcmVxdWlyZXMgdGhlIG93bmVyJ3MgYXBwcm92YWwgZ2F0ZS5cbiAgICovXG4gIHJvdXRlLnBvc3QoJy9jb21tZXJjZS90cmVhc3VyeS9zYWZlLWRlcGxveW1lbnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgLy8gQW4gZW1wdHkgQ1VQQk9BUkRfT1BFUkFUT1JfR0lUSFVCX0lEUyBtZWFucyBubyBvcGVyYXRvcnMsIHNvIHRoaXNcbiAgICAvLyBlbmRwb2ludCA0MDNzIGJ5IGRlZmF1bHQgcmF0aGVyIHRoYW4gYWNjZXB0aW5nIGEgZGVwbG95bWVudCByZWNvcmQgZnJvbVxuICAgIC8vIGFueSBhdXRoZW50aWNhdGVkIGNhbGxlci5cbiAgICBpZiAoIWlzQ3VwYm9hcmRPcGVyYXRvcihhdXRoLnVzZXJJZCwgYy5lbnYpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdmb3JiaWRkZW4nIH0sIDQwMyk7XG5cbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGlmICghYm9keSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyB9LCA0MDApO1xuICAgIGNvbnN0IGNoYWluSWQgPSBOdW1iZXIoYm9keS5jaGFpbklkKTtcbiAgICBjb25zdCBuZXR3b3JrID0gYm9keS5uZXR3b3JrO1xuICAgIGlmIChuZXR3b3JrICE9PSAndGVzdG5ldCcgJiYgbmV0d29yayAhPT0gJ21haW5uZXQnKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnLCBkZXRhaWw6ICduZXR3b3JrIG11c3QgYmUgdGVzdG5ldCBvciBtYWlubmV0JyB9LCA0MDApO1xuICAgIH1cbiAgICBjb25zdCBvd25lcnMgPSBBcnJheS5pc0FycmF5KGJvZHkub3duZXJzKSA/IGJvZHkub3duZXJzLmZpbHRlcigobyk6IG8gaXMgc3RyaW5nID0+IHR5cGVvZiBvID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICBjb25zdCB0aHJlc2hvbGQgPSBOdW1iZXIoYm9keS50aHJlc2hvbGQpO1xuICAgIGNvbnN0IGRlcGxveW1lbnQ6IFNhZmVEZXBsb3ltZW50UmVjb3JkID0ge1xuICAgICAgY2hhaW5JZCxcbiAgICAgIHNhZmVBZGRyZXNzOiB0eXBlb2YgYm9keS5zYWZlQWRkcmVzcyA9PT0gJ3N0cmluZycgPyBib2R5LnNhZmVBZGRyZXNzIDogJycsXG4gICAgICByb2xlc01vZHVsZUFkZHJlc3M6IHR5cGVvZiBib2R5LnJvbGVzTW9kdWxlQWRkcmVzcyA9PT0gJ3N0cmluZycgPyBib2R5LnJvbGVzTW9kdWxlQWRkcmVzcyA6ICcnLFxuICAgICAgcm9sZXNWZXJzaW9uOiAndjInLFxuICAgICAgZGVwbG95bWVudFR4SGFzaDogdHlwZW9mIGJvZHkuZGVwbG95bWVudFRyYW5zYWN0aW9uSGFzaCA9PT0gJ3N0cmluZycgPyBib2R5LmRlcGxveW1lbnRUcmFuc2FjdGlvbkhhc2ggOiAnJyxcbiAgICAgIG5ldHdvcms6IG5ldHdvcmsgYXMgVHJlYXN1cnlOZXR3b3JrLFxuICAgICAgZGVwbG95ZWRBdE1zOiBOdW1iZXIoYm9keS5kZXBsb3llZEF0TXMpLFxuICAgIH07XG4gICAgY29uc3QgdmFsaWQgPSB2YWxpZGF0ZVNhZmVEZXBsb3ltZW50KGRlcGxveW1lbnQpO1xuICAgIGlmICghdmFsaWQub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogdmFsaWQuY29kZSwgZGV0YWlsOiB2YWxpZC5kZXRhaWwgfSwgNDAwKTtcbiAgICBjb25zdCBhdXRvbWF0aW9uU2lnbmVyID0gdHlwZW9mIGJvZHkuYXV0b21hdGlvblNpZ25lciA9PT0gJ3N0cmluZycgPyBib2R5LmF1dG9tYXRpb25TaWduZXIgOiAnJztcbiAgICBpZiAoIUFERFJFU1MudGVzdChhdXRvbWF0aW9uU2lnbmVyKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JywgZGV0YWlsOiAnYXV0b21hdGlvblNpZ25lciBtdXN0IGJlIGFuIEVWTSBhZGRyZXNzJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAob3duZXJzLmxlbmd0aCA9PT0gMCB8fCAhb3duZXJzLmV2ZXJ5KChvKSA9PiBBRERSRVNTLnRlc3QobykpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnLCBkZXRhaWw6ICdvd25lcnMgbXVzdCBiZSBhIG5vbi1lbXB0eSBsaXN0IG9mIEVWTSBhZGRyZXNzZXMnIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodGhyZXNob2xkKSB8fCB0aHJlc2hvbGQgPCAxIHx8IHRocmVzaG9sZCA+IG93bmVycy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfcmVxdWVzdCcsIGRldGFpbDogJ3RocmVzaG9sZCBtdXN0IGJlIHdpdGhpbiB0aGUgb3duZXIgY291bnQnIH0sIDQwMCk7XG4gICAgfVxuICAgIC8vIFRoZSBzZXBhcmF0aW9uIGludmFyaWFudCwgcmVmdXNlZCBhdCBSRUNPUkQgdGltZSBhcyB3ZWxsIGFzIGF0IHJvdXRpbmdcbiAgICAvLyB0aW1lOiBhIGRlcGxveW1lbnQgd2hvc2UgYXV0b21hdGlvbiBrZXkgaXMgYW4gb3duZXIgaXMgbm90IGEgZGVwbG95bWVudFxuICAgIC8vIHRoaXMgc3lzdGVtIHdpbGwgZXZlciByb3V0ZSB0aHJvdWdoLCBzbyByZWNvcmRpbmcgaXQgd291bGQgb25seSBwcmVzZXJ2ZVxuICAgIC8vIGEgc3RhdGUgdGhlIHJ1bnRpbWUgcmVqZWN0cy5cbiAgICBpZiAob3duZXJzLnNvbWUoKG8pID0+IG8udG9Mb3dlckNhc2UoKSA9PT0gYXV0b21hdGlvblNpZ25lci50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyxcbiAgICAgICAgICBkZXRhaWw6ICdhdXRvbWF0aW9uU2lnbmVyIG11c3Qgbm90IGJlIGEgU2FmZSBvd25lcjsgb3duZXIgdGhyZXNob2xkIGNvbnRyb2wgc3RheXMgc2VwYXJhdGUgZnJvbSBhdXRvbWF0ZWQgcm9sZXMnLFxuICAgICAgICB9LFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHJlY29yZFNhZmVEZXBsb3ltZW50KGMuZW52LkRCLCB7XG4gICAgICBkZXBsb3ltZW50LFxuICAgICAgb3duZXJzLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgYXV0b21hdGlvblNpZ25lcixcbiAgICAgIHJlY29yZGVkQnk6IGF1dGgucHJpbmNpcGFsSWQsXG4gICAgICBub3dNczogRGF0ZS5ub3coKSxcbiAgICB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgZGVwbG95bWVudDogZGVwbG95bWVudEpzb24oc3RvcmVkKSB9LCAyMDEpO1xuICB9KTtcblxuICByb3V0ZS5nZXQoJy9jb21tZXJjZS90cmVhc3VyeS9zYWZlLWRlcGxveW1lbnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgY29uc3QgZGVwbG95bWVudHMgPSBhd2FpdCBsaXN0U2FmZURlcGxveW1lbnRzKGMuZW52LkRCKTtcbiAgICByZXR1cm4gYy5qc29uKHsgZGVwbG95bWVudHM6IGRlcGxveW1lbnRzLm1hcChkZXBsb3ltZW50SnNvbikgfSwgMjAwKTtcbiAgfSk7XG5cbiAgLyoqIFJvdXRlIGEgRklOQUwgYmF0Y2gncyByZWNvbmNpbGVkIHRyZWFzdXJ5IHNoYXJlcyBpbnRvIHRoZSBTYWZlLiAqL1xuICByb3V0ZS5wb3N0KCcvY29tbWVyY2UvcGF5bWVudC1jaGFubmVscy86Y2hhbm5lbElkL3NldHRsZW1lbnRzLzpiYXRjaElkL3RyZWFzdXJ5JywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgY29uc3QgY2hhbm5lbElkID0gYy5yZXEucGFyYW0oJ2NoYW5uZWxJZCcpO1xuICAgIGNvbnN0IGJhdGNoSWQgPSBjLnJlcS5wYXJhbSgnYmF0Y2hJZCcpO1xuICAgIGNvbnN0IHNjb3BlID0gYy5yZXEucXVlcnkoJ3Njb3BlJykgPz8gJ3RyZWFzdXJ5JztcbiAgICBpZiAoc2NvcGUgIT09ICd0cmVhc3VyeScgJiYgc2NvcGUgIT09ICdjb21wb25lbnRzJykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9wYXlvdXRfc2NvcGUnIH0sIDQwMCk7XG5cbiAgICBjb25zdCBhdmFpbGFiaWxpdHkgPSBhZGFwdGVyRm9yKGMuZW52LCBvcHRpb25zLmFkYXB0ZXIpO1xuICAgIGlmICghYXZhaWxhYmlsaXR5Lm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGF2YWlsYWJpbGl0eS5jb2RlLCBkZXRhaWw6IGF2YWlsYWJpbGl0eS5kZXRhaWwgfSwgNTAzKTtcbiAgICBjb25zdCBhZGFwdGVyID0gYXZhaWxhYmlsaXR5LmFkYXB0ZXI7XG4gICAgY29uc3QgcG9saWN5ID0gcmVzb2x2ZVRyZWFzdXJ5Q29uZmlnKGMuZW52LCBhZGFwdGVyKTtcbiAgICBpZiAoIXBvbGljeS5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiBwb2xpY3kuY29kZSwgZGV0YWlsOiBwb2xpY3kuZGV0YWlsIH0sIDUwMyk7XG4gICAgY29uc3Qgc3BsaXQgPSByZXNvbHZlU3BsaXRDb25maWcoYy5lbnYpO1xuICAgIGlmICghc3BsaXQub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogc3BsaXQuY29kZSwgZGV0YWlsOiBzcGxpdC5kZXRhaWwgfSwgNTAzKTtcblxuICAgIGNvbnN0IGJhdGNoID0gYXdhaXQgZ2V0U2V0dGxlbWVudEJhdGNoKGMuZW52LkRCLCBiYXRjaElkKTtcbiAgICBpZiAoIWJhdGNoIHx8IGJhdGNoLmNoYW5uZWxJZCAhPT0gY2hhbm5lbElkIHx8IGJhdGNoLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdiYXRjaF9ub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgfVxuICAgIC8vIEFjY2VwdGFuY2UgbGluZSAxNCwgY2FycmllZCBmb3J3YXJkOiBhIENMQUlNIGlzIG5vdCBtb25leSByZWNlaXZlZC4gQVxuICAgIC8vIHJlb3JnIGNhbiBzdGlsbCBkcm9wIGl0LCBhbmQgYSB0cmFuc2ZlciBvdXQgb2YgdGhlIFNhZmUgY2Fubm90IGJlIHVud291bmRcbiAgICAvLyB0aGUgd2F5IGFuIHVud291bmQgY2xhaW0gY2FuLlxuICAgIGlmIChiYXRjaC5zdGF0ZSAhPT0gJ2ZpbmFsJykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogJ2JhdGNoX25vdF9maW5hbCcsIHN0YXRlOiBiYXRjaC5zdGF0ZSwgZGV0YWlsOiAndHJlYXN1cnkgcm91dGluZyByZXF1aXJlcyBhIHNldHRsZW1lbnQgdGhhdCBoYXMgcmVhY2hlZCBmaW5hbGl0eScgfSxcbiAgICAgICAgNDA5LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBub25jZXMgPSBuZXcgU2V0KGF3YWl0IHJldGFpbmVkQmF0Y2hVc2FnZU5vbmNlcyhjLmVudi5EQiwgYmF0Y2hJZCkpO1xuICAgIGNvbnN0IHJlY2VpcHRzID0gKGF3YWl0IGxpc3RDaGFubmVsVXNhZ2VSZWNlaXB0cyhjLmVudi5EQiwgY2hhbm5lbElkKSkuZmlsdGVyKChyZWNlaXB0KSA9PiBub25jZXMuaGFzKHJlY2VpcHQudXNhZ2VOb25jZSkpO1xuICAgIGlmIChyZWNlaXB0cy5sZW5ndGggIT09IGJhdGNoLnZvdWNoZXJEaWdlc3RzLmxlbmd0aCB8fCBub25jZXMuc2l6ZSAhPT0gcmVjZWlwdHMubGVuZ3RoIHx8XG4gICAgICAgIHJlY2VpcHRzLnNvbWUoKHJlY2VpcHQpID0+ICFiYXRjaC52b3VjaGVyRGlnZXN0cy5pbmNsdWRlcyhyZWNlaXB0LnZvdWNoZXJEaWdlc3QpKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncmV0YWluZWRfdm91Y2hlcnNfbWlzbWF0Y2gnIH0sIDQwOSk7XG4gICAgfVxuICAgIGNvbnN0IHJlY2VpcHRTcGxpdCA9IHJlc29sdmVVc2FnZVNwbGl0TWFuaWZlc3QocmVjZWlwdHMsIHNwbGl0Lm1hbmlmZXN0KTtcbiAgICBpZiAoIXJlY2VpcHRTcGxpdC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncmVjb25jaWxpYXRpb25fZmFpbGVkJywgZGV0YWlsOiByZWNlaXB0U3BsaXQuZGV0YWlsIH0sIDQwOSk7XG4gICAgY29uc3QgcmVjb25jaWxlZCA9IHJlY29uY2lsZVNldHRsZW1lbnQoe1xuICAgICAgcmVjZWlwdDogcmVjZWlwdEZyb21CYXRjaChiYXRjaCksXG4gICAgICBzcGxpdE1hbmlmZXN0OiByZWNlaXB0U3BsaXQubWFuaWZlc3QsXG4gICAgfSk7XG4gICAgaWYgKCFyZWNvbmNpbGVkLm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdyZWNvbmNpbGlhdGlvbl9mYWlsZWQnLCBjb2RlOiByZWNvbmNpbGVkLmNvZGUsIGRldGFpbDogcmVjb25jaWxlZC5kZXRhaWwgfSwgNDA5KTtcbiAgICB9XG5cbiAgICBjb25zdCBkZXBsb3ltZW50ID0gYXdhaXQgZ2V0U2FmZURlcGxveW1lbnQoYy5lbnYuREIsIHBvbGljeS5jb25maWcuY2hhaW5JZCwgcG9saWN5LmNvbmZpZy5zYWZlQWRkcmVzcyk7XG4gICAgaWYgKCFkZXBsb3ltZW50KSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6ICdzYWZlX2RlcGxveW1lbnRfdW5yZWNvcmRlZCcsXG4gICAgICAgICAgZGV0YWlsOiBgbm8gcmVjb3JkZWQgU2FmZSBkZXBsb3ltZW50IGZvciBjaGFpbiAke3BvbGljeS5jb25maWcuY2hhaW5JZH0gYXQgJHtwb2xpY3kuY29uZmlnLnNhZmVBZGRyZXNzfWAsXG4gICAgICAgIH0sXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgbGV0IHJvdXRpbmdDb25maWcgPSBwb2xpY3kuY29uZmlnO1xuICAgIGNvbnN0IGNvbXBvbmVudFBheWVlczogUmVjb3JkPHN0cmluZywgeyB3YWxsZXRBZGRyZXNzOiBzdHJpbmc7IGNoYWluSWQ6IG51bWJlciB9PiA9IHt9O1xuICAgIGlmIChzY29wZSA9PT0gJ2NvbXBvbmVudHMnKSB7XG4gICAgICBjb25zdCByZWNpcGllbnRzID0gcGFyc2VMaXN0KGMuZW52LlRSRUFTVVJZX0NPTVBPTkVOVF9SRUNJUElFTlRTKTtcbiAgICAgIGlmIChyZWNpcGllbnRzLmxlbmd0aCA9PT0gMCB8fCByZWNpcGllbnRzLnNvbWUoKHJlY2lwaWVudCkgPT4gIUFERFJFU1MudGVzdChyZWNpcGllbnQpKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdjb21wb25lbnRfcG9saWN5X3VuY29uZmlndXJlZCcsIGRldGFpbDogJ2NvbXBvbmVudCBwYXlvdXQgbmVlZHMgYW4gb3duZXItY29uZmlndXJlZCByZWNpcGllbnQgYWxsb3dsaXN0JyB9LCA1MDMpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBbYXV0aG9yLCBhbW91bnRdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29uY2lsZWQucmVjb25jaWxpYXRpb24uY29tcG9uZW50QWxsb2NhdGlvbnNNaWNyb3MgPz8ge30pKSB7XG4gICAgICAgIGlmIChhbW91bnQgPT09IDBuKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgYmluZGluZyA9IGF3YWl0IGdldFdhbGxldEJpbmRpbmcoYy5lbnYuREIsIGF1dGhvcik7XG4gICAgICAgIGlmICghYmluZGluZyB8fCBiaW5kaW5nLmNoYWluSWQgIT09IHJvdXRpbmdDb25maWcuY2hhaW5JZCkge1xuICAgICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NvbXBvbmVudF93YWxsZXRfdW52ZXJpZmllZCcsIHBheWVlSWQ6IGF1dGhvciB9LCA0MDkpO1xuICAgICAgICB9XG4gICAgICAgIGNvbXBvbmVudFBheWVlc1thdXRob3JdID0gYmluZGluZztcbiAgICAgIH1cbiAgICAgIHJvdXRpbmdDb25maWcgPSB7IC4uLnJvdXRpbmdDb25maWcsIHJvbGVzOiB7IC4uLnJvdXRpbmdDb25maWcucm9sZXMsXG4gICAgICAgIHNldHRsZW1lbnQ6IHsgLi4ucm91dGluZ0NvbmZpZy5yb2xlcy5zZXR0bGVtZW50LCBhbGxvd2VkUmVjaXBpZW50czogcmVjaXBpZW50cyB9IH0gfTtcbiAgICB9XG4gICAgY29uc3QgcGxhbiA9IHBsYW5UcmVhc3VyeVJvdXRpbmcoe1xuICAgICAgY29uZmlnOiByb3V0aW5nQ29uZmlnLFxuICAgICAgZGVwbG95bWVudCxcbiAgICAgIHJlY29uY2lsaWF0aW9uOiByZWNvbmNpbGVkLnJlY29uY2lsaWF0aW9uLFxuICAgICAgdG9rZW46IHBvbGljeS5jb25maWcucm9sZXMuc2V0dGxlbWVudC5hbGxvd2VkVG9rZW5zWzBdISxcbiAgICAgIHJvbGU6ICdzZXR0bGVtZW50JyxcbiAgICAgIHJvdXRlZFNoYXJlczogc2NvcGUgPT09ICdjb21wb25lbnRzJyA/IFsnY29tcG9uZW50J10gOiBwb2xpY3kucm91dGVkU2hhcmVzLFxuICAgICAgY29tcG9uZW50UGF5ZWVzLFxuICAgICAgbWFpbm5ldENhcGl0YWxBcHByb3ZlZDogcG9saWN5Lm1haW5uZXRDYXBpdGFsQXBwcm92ZWQsXG4gICAgfSk7XG4gICAgaWYgKCFwbGFuLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdyb3V0aW5nX3JlZnVzZWQnLCBjb2RlOiBwbGFuLmNvZGUsIGRldGFpbDogcGxhbi5kZXRhaWwgfSwgNDA5KTtcblxuICAgIGNvbnN0IG5vd01zID0gRGF0ZS5ub3coKTtcbiAgICAvLyBQLTA0MyAvIEQtMDI1IMKnNDogdGhlIGxhc3QgcHJlY29uZGl0aW9uIGJlZm9yZSBtb25leSBsZWF2ZXMgdGhlIFNhZmUuIFRoZVxuICAgIC8vIG9wZXJhdG9yJ3MgcmVjb25jaWxpYXRpb24gcnVuIHB1c2hlcyB0aGlzIGdhdGU7IGEgYnJlYWssIGEgcnVuIHRoYXQgbmV2ZXJcbiAgICAvLyByZWFkIHRoZSB0cmVhc3VyeSwgYSBnYXRlIG9sZGVyIHRoYW4gdGhlIG1heCBhZ2UsIG9yIG5vIGdhdGUgYXQgYWxsIGtlZXBzXG4gICAgLy8gREFPIHRyYW5zZmVycyBwYXVzZWQuIENoZWNrZWQgYWZ0ZXIgZXZlcnkgZGV0ZXJtaW5pc3RpYyByZWZ1c2FsIGFib3ZlIHNvXG4gICAgLy8gdGhvc2Uga2VlcCB0aGVpciBvd24gY29kZXMsIGFuZCBiZWZvcmUgdGhlIGZpcnN0IHRyYW5zZmVyIGlzIHN1Ym1pdHRlZC5cbiAgICBjb25zdCBnYXRlID0gYXdhaXQgdHJhbnNmZXJHYXRlVmVyZGljdChjLmVudi5EQiwgYy5lbnYuUkVDT05DSUxJQVRJT05fR0FURV9XT1JLU1BBQ0UsIG5vd01zKTtcbiAgICBpZiAoIWdhdGUub3Blbikge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndHJhbnNmZXJzX3BhdXNlZCcsIGNvZGU6IGdhdGUuY29kZSwgZGV0YWlsOiBnYXRlLmRldGFpbCB9LCA0MDkpO1xuICAgIH1cbiAgICBjb25zdCByb3V0ZWQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgbGlzdEJhdGNoVHJlYXN1cnlUcmFuc2ZlcnM+PltudW1iZXJdW10gPSBbXTtcbiAgICBjb25zdCBhbHJlYWR5Um91dGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHVucHJvdmVuVHJhbnNmZXJzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgZm9yIChjb25zdCB0cmFuc2ZlciBvZiBwbGFuLnRyYW5zZmVycykge1xuICAgICAgLy8gUmUtcmVhZCBiZWZvcmUgc3VibWl0dGluZy4gVGhlIHVuaXF1ZSBpbmRleCBzdG9wcyBhIGRvdWJsZSBSRUNPUkQ7IG9ubHlcbiAgICAgIC8vIHRoaXMgY2hlY2sgc3RvcHMgYSBkb3VibGUgU1VCTUlTU0lPTiwgYW5kIGEgZHVwbGljYXRlIHRyYW5zZmVyIGlzIG1vbmV5XG4gICAgICAvLyB0aGF0IGhhcyBhbHJlYWR5IGxlZnQgdGhlIFNhZmUgYnkgdGhlIHRpbWUgdGhlIGluZGV4IHJlZnVzZXMgdGhlIHJvdy5cbiAgICAgIGNvbnN0IHRyYW5zZmVyS2V5ID0gdHJhbnNmZXIucGF5ZWVJZCA/PyB0cmFuc2Zlci5zaGFyZTtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZ2V0VHJlYXN1cnlUcmFuc2ZlckZvclNoYXJlKGMuZW52LkRCLCB0cmFuc2Zlci5zZXR0bGVtZW50UmVjZWlwdEhhc2gsIHRyYW5zZmVyLnNoYXJlLCB0cmFuc2Zlci5wYXllZUlkKTtcbiAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICBpZiAoZXhpc3Rpbmcuc3VibWlzc2lvblN0YXRlID09PSAncGVuZGluZycpIHtcbiAgICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd0cmVhc3VyeV90cmFuc2Zlcl9wZW5kaW5nJywgcGF5ZWVJZDogdHJhbnNmZXIucGF5ZWVJZCxcbiAgICAgICAgICAgIHRyYW5zZmVySWQ6IGV4aXN0aW5nLnRyYW5zZmVySWQsIGRldGFpbDogJ3N1Ym1pc3Npb24gaXMgcmVzZXJ2ZWQ7IHJlY29uY2lsZSBpdHMgY2hhaW4gb3V0Y29tZSBiZWZvcmUgcmV0cnlpbmcnIH0sIDQwOSk7XG4gICAgICAgIH1cbiAgICAgICAgYWxyZWFkeVJvdXRlZC5wdXNoKHRyYW5zZmVyS2V5KTtcbiAgICAgICAgcm91dGVkLnB1c2goZXhpc3RpbmcpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgdHJhbnNmZXJSZWNvcmQgPSB7XG4gICAgICAgIHRyYW5zZmVySWQ6IGB0dC0ke3RyYW5zZmVyLnNldHRsZW1lbnRSZWNlaXB0SGFzaC5zbGljZSgwLCAzMil9LSR7dHJhbnNmZXIuc2hhcmV9JHt0cmFuc2Zlci5wYXllZUlkICE9PSB1bmRlZmluZWQgPyBgLSR7ZW5jb2RlVVJJQ29tcG9uZW50KHRyYW5zZmVyLnBheWVlSWQpfWAgOiAnJ31gLFxuICAgICAgICBiYXRjaElkOiBiYXRjaC5iYXRjaElkLCBjaGFubmVsSWQsIHByaW5jaXBhbElkOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICBzZXR0bGVtZW50SWQ6IHJlY29uY2lsZWQucmVjb25jaWxpYXRpb24uc2V0dGxlbWVudElkLFxuICAgICAgICByZWNlaXB0SGFzaDogdHJhbnNmZXIuc2V0dGxlbWVudFJlY2VpcHRIYXNoLFxuICAgICAgICBzcGxpdE1hbmlmZXN0SGFzaDogcmVjb25jaWxlZC5yZWNvbmNpbGlhdGlvbi5zcGxpdE1hbmlmZXN0SGFzaCxcbiAgICAgICAgc2hhcmU6IHRyYW5zZmVyLnNoYXJlLCBwYXllZUlkOiB0cmFuc2Zlci5wYXllZUlkLCByb2xlOiB0cmFuc2Zlci5yb2xlLFxuICAgICAgICBjaGFpbklkOiBkZXBsb3ltZW50LmNoYWluSWQsIHNhZmVBZGRyZXNzOiBkZXBsb3ltZW50LnNhZmVBZGRyZXNzLFxuICAgICAgICByb2xlc01vZHVsZUFkZHJlc3M6IGRlcGxveW1lbnQucm9sZXNNb2R1bGVBZGRyZXNzLCB0b2tlbjogdHJhbnNmZXIudG9rZW4sXG4gICAgICAgIHJlY2lwaWVudDogdHJhbnNmZXIucmVjaXBpZW50LCBhbW91bnRNaWNyb3M6IHRyYW5zZmVyLmFtb3VudE1pY3JvcyxcbiAgICAgICAgc2FmZVR4SGFzaDogdHJhbnNmZXIuc2FmZVR4SGFzaCwgbm93TXMsXG4gICAgICB9O1xuICAgICAgLy8gVGhlIGNvbmRpdGlvbmFsIGluc2VydCBlbGVjdHMgZXhhY3RseSBvbmUgc2VuZGVyIGFjcm9zcyBjb25jdXJyZW50XG4gICAgICAvLyByZXF1ZXN0cyBhbmQgV29ya2VyIGluc3RhbmNlcy4gUmVzZXJ2YXRpb25zIHN1cnZpdmUgdW5rbm93biBvdXRjb21lcy5cbiAgICAgIGlmICghYXdhaXQgcmVzZXJ2ZVRyZWFzdXJ5VHJhbnNmZXIoYy5lbnYuREIsIHRyYW5zZmVyUmVjb3JkKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd0cmVhc3VyeV90cmFuc2Zlcl9wZW5kaW5nJywgcGF5ZWVJZDogdHJhbnNmZXIucGF5ZWVJZCxcbiAgICAgICAgICB0cmFuc2ZlcklkOiB0cmFuc2ZlclJlY29yZC50cmFuc2ZlcklkIH0sIDQwOSk7XG4gICAgICB9XG5cbiAgICAgIGxldCByZWNlaXB0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVjZWlwdCA9IGF3YWl0IGFkYXB0ZXIuc3VibWl0VHJhbnNmZXIoe1xuICAgICAgICAgIHNoYXJlOiB0cmFuc2Zlci5zaGFyZSxcbiAgICAgICAgICB0b2tlbjogdHJhbnNmZXIudG9rZW4sXG4gICAgICAgICAgcmVjaXBpZW50OiB0cmFuc2Zlci5yZWNpcGllbnQsXG4gICAgICAgICAgYW1vdW50TWljcm9zOiB0cmFuc2Zlci5hbW91bnRNaWNyb3MsXG4gICAgICAgICAgc2FmZVR4SGFzaDogdHJhbnNmZXIuc2FmZVR4SGFzaCxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVycm9yOiAndHJlYXN1cnlfdHJhbnNmZXJfZmFpbGVkJyxcbiAgICAgICAgICAgIHNoYXJlOiB0cmFuc2Zlci5zaGFyZSxcbiAgICAgICAgICAgIGRldGFpbDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuICAgICAgICAgICAgcm91dGVkOiByb3V0ZWQubWFwKChlbnRyeSkgPT4gZW50cnkudHJhbnNmZXJJZCksXG4gICAgICAgICAgfSxcbiAgICAgICAgICA1MDIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIFRoZSBmdW5kcyBoYXZlIG1vdmVkLiBUaGUgYXVkaXRhYmxlIHJlY2VpcHQgaXMgd3JpdHRlbiBuZXh0LCBhbmQgYVxuICAgICAgLy8gcHJvb2YgdGhhdCBjYW5ub3QgYmUgc2VxdWVuY2VkIGlzIFJFUE9SVEVEIHJhdGhlciB0aGFuIHN3YWxsb3dlZCDigJRcbiAgICAgIC8vIG5ldmVyIHRyZWF0ZWQgYXMgYSByZWFzb24gdG8gcHJldGVuZCB0aGUgdHJhbnNmZXIgZGlkIG5vdCBoYXBwZW4uXG4gICAgICBjb25zdCBwcm9vZiA9IGF3YWl0IHJlY29yZFRyZWFzdXJ5UHJvb2YoYy5lbnYuREIsIGFkYXB0ZXIsIHtcbiAgICAgICAgc3RyZWFtSWQ6IHRyZWFzdXJ5U3RyZWFtKGNoYW5uZWxJZCksXG4gICAgICAgIGNoYW5uZWxJZCxcbiAgICAgICAgcGF5ZXI6IGJhdGNoLnByaW5jaXBhbElkLFxuICAgICAgICB0cmFuc2ZlcixcbiAgICAgICAgcmVjb25jaWxpYXRpb246IHJlY29uY2lsZWQucmVjb25jaWxpYXRpb24sXG4gICAgICAgIGRlcGxveW1lbnQsXG4gICAgICAgIHRyYW5zYWN0aW9uOiByZWNlaXB0LFxuICAgICAgICBub3dNcyxcbiAgICAgIH0pLmNhdGNoKChlcnJvcjogdW5rbm93bikgPT4gKHsgb2s6IGZhbHNlIGFzIGNvbnN0LCBkZXRhaWw6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSB9KSk7XG4gICAgICBpZiAoIXByb29mLm9rKSB1bnByb3ZlblRyYW5zZmVycy5wdXNoKHRyYW5zZmVyS2V5KTtcblxuICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgcmVjb3JkVHJlYXN1cnlUcmFuc2ZlcihjLmVudi5EQiwge1xuICAgICAgICAuLi50cmFuc2ZlclJlY29yZCxcbiAgICAgICAgdHJhbnNhY3Rpb25IYXNoOiByZWNlaXB0LnRyYW5zYWN0aW9uSGFzaCxcbiAgICAgICAgYmxvY2tOdW1iZXI6IHJlY2VpcHQuYmxvY2tOdW1iZXIsXG4gICAgICAgIHByb29mRXZlbnRJZDogcHJvb2Yub2sgPyBwcm9vZi5ldmVudC5ldmVudElkIDogbnVsbCxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFzdG9yZWQub2spIGFscmVhZHlSb3V0ZWQucHVzaCh0cmFuc2ZlcktleSk7XG4gICAgICByb3V0ZWQucHVzaChzdG9yZWQudHJhbnNmZXIpO1xuICAgIH1cblxuICAgIHJldHVybiBjLmpzb24oXG4gICAgICB7XG4gICAgICAgIGJhdGNoSWQ6IGJhdGNoLmJhdGNoSWQsXG4gICAgICAgIHNldHRsZW1lbnRJZDogcmVjb25jaWxlZC5yZWNvbmNpbGlhdGlvbi5zZXR0bGVtZW50SWQsXG4gICAgICAgIHJlY2VpcHRIYXNoOiByZWNvbmNpbGVkLnJlY29uY2lsaWF0aW9uLnJlY2VpcHRIYXNoLFxuICAgICAgICBzcGxpdE1hbmlmZXN0SGFzaDogcmVjb25jaWxlZC5yZWNvbmNpbGlhdGlvbi5zcGxpdE1hbmlmZXN0SGFzaCxcbiAgICAgICAgbmV0d29yazogZGVwbG95bWVudC5uZXR3b3JrLFxuICAgICAgICBzYWZlQWRkcmVzczogZGVwbG95bWVudC5zYWZlQWRkcmVzcyxcbiAgICAgICAgdHJhbnNmZXJzOiByb3V0ZWQubWFwKHRyYW5zZmVySnNvbiksXG4gICAgICAgIGFscmVhZHlSb3V0ZWQsXG4gICAgICAgIC8vIE5vbi1lbXB0eSBtZWFucyB0aGUgbW9uZXkgbW92ZWQgYnV0IGl0cyByZWNlaXB0IGlzIG5vdCBvbiB0aGUgZXZlbnRcbiAgICAgICAgLy8gbG9nLiBTdXJmYWNlZCwgbmV2ZXIgaGlkZGVuIGJlaGluZCB0aGUgMjAwLlxuICAgICAgICB1bnByb3ZlblRyYW5zZmVycyxcbiAgICAgIH0sXG4gICAgICAyMDAsXG4gICAgKTtcbiAgfSk7XG5cbiAgcm91dGUuZ2V0KCcvY29tbWVyY2UvcGF5bWVudC1jaGFubmVscy86Y2hhbm5lbElkL3NldHRsZW1lbnRzLzpiYXRjaElkL3RyZWFzdXJ5JywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG4gICAgY29uc3QgYmF0Y2ggPSBhd2FpdCBnZXRTZXR0bGVtZW50QmF0Y2goYy5lbnYuREIsIGMucmVxLnBhcmFtKCdiYXRjaElkJykpO1xuICAgIGlmICghYmF0Y2ggfHwgYmF0Y2guY2hhbm5lbElkICE9PSBjLnJlcS5wYXJhbSgnY2hhbm5lbElkJykgfHwgYmF0Y2gucHJpbmNpcGFsSWQgIT09IGF1dGgucHJpbmNpcGFsSWQpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2JhdGNoX25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgdHJhbnNmZXJzID0gYXdhaXQgbGlzdEJhdGNoVHJlYXN1cnlUcmFuc2ZlcnMoYy5lbnYuREIsIGJhdGNoLmJhdGNoSWQpO1xuICAgIHJldHVybiBjLmpzb24oeyBiYXRjaElkOiBiYXRjaC5iYXRjaElkLCB0cmFuc2ZlcnM6IHRyYW5zZmVycy5tYXAodHJhbnNmZXJKc29uKSB9LCAyMDApO1xuICB9KTtcblxuICByZXR1cm4gcm91dGU7XG59XG5cbmZ1bmN0aW9uIHRyYW5zZmVySnNvbih0cmFuc2ZlcjogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBsaXN0QmF0Y2hUcmVhc3VyeVRyYW5zZmVycz4+W251bWJlcl0pIHtcbiAgcmV0dXJuIHtcbiAgICB0cmFuc2ZlcklkOiB0cmFuc2Zlci50cmFuc2ZlcklkLFxuICAgIHNoYXJlOiB0cmFuc2Zlci5zaGFyZSxcbiAgICAuLi4odHJhbnNmZXIucGF5ZWVJZCAhPT0gdW5kZWZpbmVkID8geyBwYXllZUlkOiB0cmFuc2Zlci5wYXllZUlkIH0gOiB7fSksXG4gICAgc3VibWlzc2lvblN0YXRlOiB0cmFuc2Zlci5zdWJtaXNzaW9uU3RhdGUsXG4gICAgcm9sZTogdHJhbnNmZXIucm9sZSxcbiAgICB0b2tlbjogdHJhbnNmZXIudG9rZW4sXG4gICAgcmVjaXBpZW50OiB0cmFuc2Zlci5yZWNpcGllbnQsXG4gICAgYW1vdW50TWljcm9zOiB0cmFuc2Zlci5hbW91bnRNaWNyb3MsXG4gICAgY2hhaW5JZDogdHJhbnNmZXIuY2hhaW5JZCxcbiAgICBzYWZlQWRkcmVzczogdHJhbnNmZXIuc2FmZUFkZHJlc3MsXG4gICAgcm9sZXNNb2R1bGVBZGRyZXNzOiB0cmFuc2Zlci5yb2xlc01vZHVsZUFkZHJlc3MsXG4gICAgc2FmZVR4SGFzaDogdHJhbnNmZXIuc2FmZVR4SGFzaCxcbiAgICB0cmFuc2FjdGlvbkhhc2g6IHRyYW5zZmVyLnRyYW5zYWN0aW9uSGFzaCxcbiAgICBibG9ja051bWJlcjogdHJhbnNmZXIuYmxvY2tOdW1iZXIsXG4gICAgcHJvb2ZFdmVudElkOiB0cmFuc2Zlci5wcm9vZkV2ZW50SWQsXG4gICAgcmVjZWlwdEhhc2g6IHRyYW5zZmVyLnJlY2VpcHRIYXNoLFxuICAgIGNyZWF0ZWRBdE1zOiB0cmFuc2Zlci5jcmVhdGVkQXRNcyxcbiAgfTtcbn1cblxuLyoqXG4gKiBBcHBlbmQgdGhlIHNpZ25lZCBgcmV2ZW51ZS1zcGxpdGAgdHJlYXN1cnkgcmVjZWlwdCB0byB0aGUgUC0wMTYgbG9nLlxuICpcbiAqIEEgc2VxdWVuY2UgY29sbGlzaW9uIGlzIHJldHJpZWQgb25jZSBhZ2FpbnN0IGEgZnJlc2hseSByZWFkIHdhdGVybWFyaywgdGhlXG4gKiBzYW1lIHdheSBgcmVjb3JkU2V0dGxlbWVudFByb29mYCBoYW5kbGVzIGl0OiB0d28gY29uY3VycmVudCBhcHBlbmRzIG9uIG9uZVxuICogc3RyZWFtIGlzIGFuIG9yZGluYXJ5IHJhY2UsIG5vdCBhIGZhaWx1cmUgb2YgdGhlIHRyYW5zZmVyLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWNvcmRUcmVhc3VyeVByb29mKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgYWRhcHRlcjogU2FmZVRyZWFzdXJ5QWRhcHRlcixcbiAgaW5wdXQ6IHtcbiAgICByZWFkb25seSBzdHJlYW1JZDogc3RyaW5nO1xuICAgIHJlYWRvbmx5IGNoYW5uZWxJZDogc3RyaW5nO1xuICAgIHJlYWRvbmx5IHBheWVyOiBzdHJpbmc7XG4gICAgcmVhZG9ubHkgdHJhbnNmZXI6IFBhcmFtZXRlcnM8dHlwZW9mIGJ1aWxkVHJlYXN1cnlUcmFuc2ZlckV2ZW50PlswXVsndHJhbnNmZXInXTtcbiAgICByZWFkb25seSByZWNvbmNpbGlhdGlvbjogUGFyYW1ldGVyczx0eXBlb2YgYnVpbGRUcmVhc3VyeVRyYW5zZmVyRXZlbnQ+WzBdWydyZWNvbmNpbGlhdGlvbiddO1xuICAgIHJlYWRvbmx5IGRlcGxveW1lbnQ6IFNhZmVEZXBsb3ltZW50UmVjb3JkO1xuICAgIHJlYWRvbmx5IHRyYW5zYWN0aW9uOiB7IHJlYWRvbmx5IHRyYW5zYWN0aW9uSGFzaDogc3RyaW5nOyByZWFkb25seSBibG9ja051bWJlcjogYmlnaW50IH07XG4gICAgcmVhZG9ubHkgbm93TXM6IG51bWJlcjtcbiAgfSxcbik6IFByb21pc2U8eyBvazogdHJ1ZTsgZXZlbnQ6IENvbW1lcmNlRXZlbnQgfSB8IHsgb2s6IGZhbHNlOyBkZXRhaWw6IHN0cmluZyB9PiB7XG4gIGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDwgMjsgYXR0ZW1wdCArPSAxKSB7XG4gICAgY29uc3Qgc2VxdWVuY2UgPSBhd2FpdCBuZXh0Q29tbWVyY2VFdmVudFNlcXVlbmNlKGRiLCBpbnB1dC5zdHJlYW1JZCk7XG4gICAgY29uc3QgdHJhbnNmZXJFdmVudCA9IGJ1aWxkVHJlYXN1cnlUcmFuc2ZlckV2ZW50KHtcbiAgICAgIHN0cmVhbUlkOiBpbnB1dC5zdHJlYW1JZCxcbiAgICAgIGlzc3VlcjogYWRhcHRlci5hdXRvbWF0aW9uU2lnbmVyLFxuICAgICAgc2VxdWVuY2UsXG4gICAgICBvY2N1cnJlZEF0TXM6IGlucHV0Lm5vd01zLFxuICAgICAgdHJhbnNmZXI6IGlucHV0LnRyYW5zZmVyLFxuICAgICAgcmVjb25jaWxpYXRpb246IGlucHV0LnJlY29uY2lsaWF0aW9uLFxuICAgICAgZGVwbG95bWVudDogaW5wdXQuZGVwbG95bWVudCxcbiAgICAgIHRyYW5zYWN0aW9uOiBpbnB1dC50cmFuc2FjdGlvbixcbiAgICB9KTtcbiAgICBjb25zdCB1bnNpZ25lZCA9IHsgLi4udHJhbnNmZXJFdmVudCwgcGF5bG9hZDogeyAuLi50cmFuc2ZlckV2ZW50LnBheWxvYWQsXG4gICAgICBjaGFubmVsSWQ6IGlucHV0LmNoYW5uZWxJZCwgcGF5ZXI6IGlucHV0LnBheWVyLCBwYXlvdXRTdGF0dXM6ICdzdWJtaXR0ZWQnIH0gfTtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCBhZGFwdGVyLnNpZ25UcmVhc3VyeVByb29mKGNvbW1lcmNlRXZlbnRTaWduaW5nQnl0ZXModW5zaWduZWQpKTtcbiAgICBjb25zdCBhcHBlbmRlZCA9IGF3YWl0IGFwcGVuZENvbW1lcmNlRXZlbnQoZGIsIHsgLi4udW5zaWduZWQsIHNpZ25hdHVyZSB9LCBpbnB1dC5ub3dNcyk7XG4gICAgaWYgKGFwcGVuZGVkLm9rKSByZXR1cm4geyBvazogdHJ1ZSwgZXZlbnQ6IGFwcGVuZGVkLmV2ZW50LmV2ZW50IH07XG4gICAgaWYgKGFwcGVuZGVkLmNvZGUgIT09ICdzZXF1ZW5jZS1jb25mbGljdCcpIHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiBhcHBlbmRlZC5kZXRhaWwgfTtcbiAgfVxuICByZXR1cm4geyBvazogZmFsc2UsIGRldGFpbDogJ3RyZWFzdXJ5IHJlY2VpcHQgY291bGQgbm90IGJlIHNlcXVlbmNlZCBvbnRvIHRoZSBjb21tZXJjZSBldmVudCBsb2cnIH07XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL3RyZWFzdXJ5LnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy90cmVhc3VyeS50cyIsIi9zcmMvcm91dGVzL3RyZWFzdXJ5LnRzIixbXV0=
}}