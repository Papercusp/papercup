'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("declareMeter", () => { try { return declareMeter } catch {} });
__vite_ssr_exportName__("quoteMicros", () => { try { return quoteMicros } catch {} });
__vite_ssr_exportName__("buildUsageVoucher", () => { try { return buildUsageVoucher } catch {} });
__vite_ssr_exportName__("usageReceiptSigningBytes", () => { try { return usageReceiptSigningBytes } catch {} });
__vite_ssr_exportName__("sellerReceiptAuthoritySigningBytes", () => { try { return sellerReceiptAuthoritySigningBytes } catch {} });
__vite_ssr_exportName__("verifySellerReceiptAuthority", () => { try { return verifySellerReceiptAuthority } catch {} });
__vite_ssr_exportName__("verifyUsageReceiptSignature", () => { try { return verifyUsageReceiptSignature } catch {} });
__vite_ssr_exportName__("usageReceiptDigest", () => { try { return usageReceiptDigest } catch {} });
__vite_ssr_exportName__("openMeteredInvocation", () => { try { return openMeteredInvocation } catch {} });
__vite_ssr_exportName__("acceptMeteredVoucher", () => { try { return acceptMeteredVoucher } catch {} });
__vite_ssr_exportName__("closeMeteredInvocation", () => { try { return closeMeteredInvocation } catch {} });
__vite_ssr_exportName__("LocalMeteredTurnRefusedError", () => { try { return LocalMeteredTurnRefusedError } catch {} });
__vite_ssr_exportName__("LocalMeteredTurn", () => { try { return LocalMeteredTurn } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/authority/authority-rpc-envelope.ts", {"importedNames":["canonicalJson"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/identity/ed25519.ts", {"importedNames":["verifyEd25519"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/microcharge.ts", {"importedNames":["paymentVoucherDigest","paymentVoucherSigningBytes","reserveMicrocharge","settleMicrocharge","unsignedVoucher"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/metering-ledger.ts", {"importedNames":["recordContribution","recordSpend"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/identity-per-use-offer.ts", {"importedNames":["quoteIdentityInferenceTurn"]});






const SPLIT_MANIFEST_HASH = /^sha256:[0-9a-f]{64}$/i;
const refuse = (code, detail) => ({ ok: false, code, detail });
function declareMeter(terms) {
  const { meterUnit, priceVersion, splitManifestHash } = terms;
  if (!meterUnit.trim()) return refuse("invalid-meter", "meterUnit is required");
  if (!priceVersion.trim()) return refuse("invalid-meter", "priceVersion is required");
  if (!SPLIT_MANIFEST_HASH.test(splitManifestHash)) {
    return refuse("invalid-meter", "splitManifestHash must be sha256:<64 hex>");
  };
  const raw = terms.unitPriceMicros;
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) {
    return refuse("invalid-meter", "unitPriceMicros must be a safe integer");
  };
  const unitPriceMicros = BigInt(raw);
  if (unitPriceMicros <= 0n) {
    return refuse("invalid-meter", "unitPriceMicros must be positive — a zero-price item is a free offer, not a metered one");
  };
  return { ok: true, meter: { meterUnit, unitPriceMicros, priceVersion, splitManifestHash } };
};
function quoteMicros(meter, quantity) {
  return meter.unitPriceMicros * quantity;
};
function buildUsageVoucher(channel, meter, unit) {
  return {
    channelId: channel.channelId,
    payer: unit.payer,
    seller: unit.seller,
    releaseRef: unit.releaseRef,
    usageNonce: unit.usageNonce,
    meterQuantity: unit.quantity,
    pricePerUnitMicros: meter.unitPriceMicros,
    priceVersion: meter.priceVersion,
    splitManifestHash: meter.splitManifestHash,
    expiresAtMs: unit.expiresAtMs,
    cumulativeClaimMicros: channel.lastCumulativeMicros + quoteMicros(meter, unit.quantity)
  };
};
function receiptJson(receipt) {
  return {
    amountMicros: receipt.amountMicros.toString(),
    channelId: receipt.channelId,
    meterQuantity: receipt.meterQuantity.toString(),
    occurredAtMs: receipt.occurredAtMs,
    usageNonce: receipt.usageNonce,
    voucherDigest: receipt.voucherDigest
  };
}
function usageReceiptSigningBytes(receipt) {
  return Buffer.from((0,__vite_ssr_import_1__.canonicalJson)(receiptJson(receipt)), "utf8");
};
function sellerReceiptAuthoritySigningBytes(binding) {
  return Buffer.from((0,__vite_ssr_import_1__.canonicalJson)({
    schema: "papercusp.seller-receipt-authority/v1",
    seller: binding.seller,
    offerId: binding.offerId,
    productId: binding.productId,
    skuRef: binding.skuRef,
    pubkeyBase64: binding.pubkeyBase64
  }), "utf8");
};
function verifySignature(bytes, pubkeyBase64, signature) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pubkeyBase64) || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  try {
    return (0,__vite_ssr_import_2__.verifyEd25519)(bytes, pubkeyBase64, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
function verifySellerReceiptAuthority(binding, authority) {
  if (!authority || typeof authority.pubkeyBase64 !== "string" || typeof authority.proof !== "string") return false;
  return verifySignature(
    sellerReceiptAuthoritySigningBytes({ ...binding, pubkeyBase64: authority.pubkeyBase64 }),
    authority.pubkeyBase64,
    authority.proof
  );
};
function verifyUsageReceiptSignature(receipt, pubkeyBase64) {
  return verifySignature(usageReceiptSigningBytes(receipt), pubkeyBase64, receipt.signature);
};
function usageReceiptDigest(receipt) {
  return (0,__vite_ssr_import_0__.createHash)("sha256").update(usageReceiptSigningBytes(receipt)).digest("hex");
};
function validateUnit(unit) {
  if (!unit.payer.trim()) return refuse("invalid-unit", "payer is required");
  if (!unit.seller.trim()) return refuse("invalid-unit", "seller is required");
  if (!unit.releaseRef.trim()) return refuse("invalid-unit", "releaseRef is required");
  if (!unit.usageNonce.trim()) return refuse("invalid-unit", "usageNonce is required");
  if (unit.quantity <= 0n) return refuse("invalid-unit", "quantity must be positive");
  if (unit.quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    return refuse("invalid-unit", "quantity exceeds the safe-integer range the metering ledger records in");
  };
  if (!Number.isFinite(unit.expiresAtMs)) return refuse("invalid-unit", "expiresAtMs must be finite");
  return null;
}
function openMeteredInvocation(input) {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const unsigned = buildUsageVoucher(input.channel, input.meter, input.unit);
  const signature = input.signVoucher((0,__vite_ssr_import_3__.paymentVoucherSigningBytes)(unsigned));
  if (typeof signature !== "string" || !signature.trim()) {
    return refuse("unsigned-voucher", "the payer signer returned no signature for the cumulative voucher");
  };
  const voucher = { ...unsigned, signature };
  const reserved = (0,__vite_ssr_import_3__.reserveMicrocharge)(input.channel, voucher, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher, reservedMicros: reserved.deltaMicros };
};
function acceptMeteredVoucher(input) {
  const invalid = validateUnit(input.unit);
  if (invalid) return invalid;
  const expected = buildUsageVoucher(input.channel, input.meter, input.unit);
  const v = input.voucher;
  if (v.channelId !== expected.channelId) return refuse("channel-mismatch", "voucher channel does not match the local payment channel");
  if (v.payer !== expected.payer) return refuse("terms-mismatch", "voucher payer does not match the billed unit");
  if (v.seller !== expected.seller) return refuse("terms-mismatch", "voucher seller does not match the billed unit");
  if (v.releaseRef !== expected.releaseRef) return refuse("terms-mismatch", "voucher releaseRef does not match the billed unit");
  if (v.usageNonce !== expected.usageNonce) return refuse("terms-mismatch", "voucher usageNonce does not match the billed unit");
  if (v.meterQuantity !== expected.meterQuantity) return refuse("terms-mismatch", "voucher meterQuantity does not match the billed unit");
  if (v.pricePerUnitMicros !== expected.pricePerUnitMicros) return refuse("terms-mismatch", "voucher price does not match the declared meter");
  if (v.priceVersion !== expected.priceVersion) return refuse("terms-mismatch", "voucher priceVersion does not match the declared meter");
  if (v.splitManifestHash !== expected.splitManifestHash) return refuse("terms-mismatch", "voucher splitManifestHash does not match the declared meter");
  if (!v.signature.trim()) return refuse("unsigned-voucher", "the cumulative voucher carries no payer signature");
  let authenticated = false;
  try {
    authenticated = input.verifySignature?.(v) === true;
  } catch {
  };
  if (!authenticated) return refuse("invalid-voucher", "the payer signature failed verification");
  const reserved = (0,__vite_ssr_import_3__.reserveMicrocharge)(input.channel, v, input.nowMs);
  if (!reserved.ok) return refuse(reserved.code, reserved.detail);
  return { ok: true, channel: reserved.channel, voucher: v, reservedMicros: reserved.deltaMicros };
};
function closeMeteredInvocation(input) {
  const served = input.actualQuantity ?? input.voucher.meterQuantity;
  if (served < 0n) return refuse("invalid-unit", "actualQuantity must be non-negative");
  if (served > input.voucher.meterQuantity) {
    return refuse("actual-exceeds-reservation", `served ${served} exceeds the reserved quantity ${input.voucher.meterQuantity}`);
  };
  if (!Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) return refuse("invalid-unit", "occurredAtMs must be a non-negative safe integer");
  let amountMicros = input.voucher.pricePerUnitMicros * served;
  if (input.identityInference) {
    const exact = input.identityInference;
    const offer = exact.offer;
    const q = (0,__vite_ssr_import_5__.quoteIdentityInferenceTurn)(exact);
    if (!q.ok) return refuse("terms-mismatch", q.detail);
    if (input.actualQuantity !== void 0 || input.metering || offer.skuRef !== input.voucher.releaseRef || BigInt(offer.unitPriceMicros) !== input.voucher.pricePerUnitMicros || offer.priceVersion !== input.voucher.priceVersion || offer.splitManifestHash !== input.voucher.splitManifestHash) {
      return refuse("terms-mismatch", "exact identity cost must bind the reserved identity offer without a quantity override");
    };
    if (q.reservationQuantity !== input.voucher.meterQuantity) {
      return refuse("terms-mismatch", "identity inference ceiling differs from the signed reservation");
    };
    amountMicros = q.amountMicros;
  } else if (input.voucher.releaseRef.startsWith("identity-release:")) {
    return refuse("terms-mismatch", "identity releases require exact billed inference settlement");
  };
  const unsignedReceipt = {
    channelId: input.channel.channelId,
    usageNonce: input.voucher.usageNonce,
    meterQuantity: served,
    amountMicros,
    voucherDigest: (0,__vite_ssr_import_3__.paymentVoucherDigest)((0,__vite_ssr_import_3__.unsignedVoucher)(input.voucher)),
    occurredAtMs: input.occurredAtMs
  };
  const receiptSignature = input.signReceipt(usageReceiptSigningBytes(unsignedReceipt));
  if (typeof receiptSignature !== "string" || !receiptSignature.trim()) {
    return refuse("unsigned-receipt", "the seller signer returned no signature for the usage receipt");
  };
  const settled = (0,__vite_ssr_import_3__.settleMicrocharge)({
    channel: input.channel,
    voucher: input.voucher,
    actualAmountMicros: amountMicros,
    actualMeterQuantity: served,
    occurredAtMs: input.occurredAtMs,
    receiptSignature
  });
  if (!settled.ok) return refuse(settled.code, settled.detail);
  if (!input.metering) {
    return { ok: true, channel: settled.channel, receipt: settled.receipt, amountMicros, contributionCredited: 0 };
  };
  const amount = Number(served);
  const spend = (0,__vite_ssr_import_4__.recordSpend)(input.metering.ledger, {
    hostRef: input.metering.served.hostRef,
    fleetSlug: input.metering.served.fleetSlug,
    axis: input.metering.served.axis,
    amount,
    unit: input.metering.served.unit
  });
  if (!spend.ok) return refuse("metering-refused", `${spend.code}: metering ledger refused the served units`);
  let ledger = spend.ledger;
  let contributionCredited = 0;
  if (input.metering.served.attestedUserId) {
    const contribution = (0,__vite_ssr_import_4__.recordContribution)(ledger, {
      attestedUserId: input.metering.served.attestedUserId,
      axis: input.metering.served.axis,
      amount,
      unit: input.metering.served.unit,
      perUserCap: input.metering.served.perUserContributionCap ?? null
    });
    if (!contribution.ok) return refuse("metering-refused", `${contribution.code}: metering ledger refused the contribution credit`);
    ledger = contribution.ledger;
    contributionCredited = contribution.credited;
  };
  return {
    ok: true,
    channel: settled.channel,
    receipt: settled.receipt,
    amountMicros,
    metering: ledger,
    contributionCredited
  };
};
class LocalMeteredTurnRefusedError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.name = "LocalMeteredTurnRefusedError";
  }
};
class LocalMeteredTurn {
  constructor(deps) {
    this.deps = deps;
    this.state = structuredClone(deps.state);
    const s = this.state;
    const declared = declareMeter(s.meter);
    if (!s.turnId.trim() || !s.payer.trim() || !s.seller.trim() || !s.releaseRef.trim() || !declared.ok || !Number.isFinite(s.expiresAtMs) || s.ceilingMicros <= 0n || s.reservedMicros < 0n || s.reservedMicros > s.ceilingMicros || s.channel.escrowMicros < 0n || s.channel.committedMicros < 0n || s.channel.lastCumulativeMicros < 0n || Object.values(s.channel.reservations).some((amount) => amount < 0n) || s.channel.committedMicros + Object.values(s.channel.reservations).reduce((sum, amount) => sum + amount, 0n) > s.channel.escrowMicros) {
      throw new LocalMeteredTurnRefusedError("invalid-turn", "a local meter needs a bound funded turn and valid ceiling");
    };
    let reserved = 0n;
    for (const [nonce, entry] of Object.entries(s.units)) {
      const v = entry.voucher;
      const amount = quoteMicros(s.meter, v.meterQuantity);
      if (v.usageNonce !== nonce || v.channelId !== s.channel.channelId || v.payer !== s.payer || v.seller !== s.seller || v.releaseRef !== s.releaseRef || v.priceVersion !== s.meter.priceVersion || v.splitManifestHash !== s.meter.splitManifestHash || v.pricePerUnitMicros !== s.meter.unitPriceMicros || v.meterQuantity <= 0n || !v.signature.trim() || entry.completedAtMs !== null && !Number.isFinite(entry.completedAtMs) || (entry.receipt ? !(nonce in s.channel.receipts) || entry.receipt.usageNonce !== nonce || entry.receipt.channelId !== v.channelId || entry.receipt.amountMicros !== amount || entry.receipt.voucherDigest !== (0,__vite_ssr_import_3__.paymentVoucherDigest)((0,__vite_ssr_import_3__.unsignedVoucher)(v)) || !entry.receipt.signature.trim() || entry.completedAtMs === null : s.channel.reservations[nonce] !== amount)) {
        throw new LocalMeteredTurnRefusedError("invalid-turn", "local turn snapshot disagrees with its bound vouchers/channel");
      };
      reserved += amount;
    };
    if (reserved !== s.reservedMicros) {
      throw new LocalMeteredTurnRefusedError("invalid-turn", "local turn reservation total disagrees with its units");
    }
  }
  state;
  tail = Promise.resolve();
  persistenceFailed = false;
  snapshot() {
    return structuredClone(this.state);
  }
  /** Stop new calls before closing or revoking a host admission. Calls already
   * entered must finish; their durable holds cannot be treated as unused funds. */
  stopAdmission() {
    return this.serialize(async () => {
      if (this.state.admissionClosed) return;
      this.state = { ...this.state, admissionClosed: true };
      await this.persist();
    });
  }
  serialize(operation) {
    const next = this.tail.then(() => {
      if (this.persistenceFailed) {
        throw new LocalMeteredTurnRefusedError("storage-unavailable", "read authoritative local state before resuming this turn");
      };
      return operation();
    });
    this.tail = next.then(() => void 0, () => void 0);
    return next;
  }
  async persist() {
    try {
      await this.deps.persist(this.snapshot());
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
  }
  async invoke(unit, execute) {
    await this.serialize(async () => {
      const s = this.state;
      if (s.admissionClosed) {
        throw new LocalMeteredTurnRefusedError("turn-admission-closed", "the host has closed or revoked this funded turn");
      };
      if (unit.payer !== s.payer || unit.releaseRef !== s.releaseRef) {
        throw new LocalMeteredTurnRefusedError("binding-mismatch", "target payer and installed release must match the funded turn");
      };
      const nowMs = this.deps.nowMs();
      if (!Number.isFinite(nowMs) || nowMs > s.expiresAtMs) {
        throw new LocalMeteredTurnRefusedError("expired", "the funded turn has expired");
      };
      if (s.reservedMicros + quoteMicros(s.meter, unit.quantity) > s.ceilingMicros) {
        throw new LocalMeteredTurnRefusedError("cap-exhausted", "this invocation exceeds the funded per-turn ceiling");
      };
      const bound = { ...unit, seller: s.seller, expiresAtMs: s.expiresAtMs };
      let bytes;
      const probe = openMeteredInvocation({
        channel: s.channel,
        meter: s.meter,
        unit: bound,
        nowMs,
        signVoucher: (value) => {
          bytes = value;
          return "signing-probe";
        }
      });
      if (!probe.ok) throw new LocalMeteredTurnRefusedError(probe.code, probe.detail);
      const signature = await this.deps.signVoucher(bytes);
      const signedAtMs = this.deps.nowMs();
      const opened = openMeteredInvocation({
        channel: s.channel,
        meter: s.meter,
        unit: bound,
        nowMs: signedAtMs,
        signVoucher: () => signature
      });
      if (!opened.ok) throw new LocalMeteredTurnRefusedError(opened.code, opened.detail);
      this.state = {
        ...s,
        channel: opened.channel,
        reservedMicros: s.reservedMicros + opened.reservedMicros,
        units: { ...s.units, [unit.usageNonce]: { voucher: opened.voucher, completedAtMs: null, receipt: null } }
      };
      await this.persist();
    });
    try {
      return await execute();
    } finally {
      await this.serialize(async () => {
        const entry = this.state.units[unit.usageNonce];
        const completedAtMs = this.deps.nowMs();
        if (!Number.isFinite(completedAtMs)) {
          throw new LocalMeteredTurnRefusedError("invalid-unit", "completion time must be finite");
        };
        this.state = { ...this.state, units: {
          ...this.state.units,
          [unit.usageNonce]: { ...entry, completedAtMs }
        } };
        await this.persist();
        await this.settle(unit.usageNonce);
      });
    }
  }
  /** Recover a completed call's settlement; never re-enter its handler. */
  retrySettlement(usageNonce) {
    return this.serialize(() => this.settle(usageNonce));
  }
  async settle(usageNonce) {
    const s = this.state;
    const entry = s.units[usageNonce];
    if (!entry || entry.completedAtMs === null) {
      throw new LocalMeteredTurnRefusedError("unknown-reservation", "only a recorded completed invocation may settle");
    };
    if (entry.receipt) return structuredClone(entry.receipt);
    let bytes;
    const probe = closeMeteredInvocation({
      channel: s.channel,
      voucher: entry.voucher,
      occurredAtMs: entry.completedAtMs,
      signReceipt: (value) => {
        bytes = value;
        return "signing-probe";
      }
    });
    if (!probe.ok) throw new LocalMeteredTurnRefusedError(probe.code, probe.detail);
    const signature = await this.deps.signReceipt(bytes, entry.voucher);
    const closed = closeMeteredInvocation({
      channel: s.channel,
      voucher: entry.voucher,
      occurredAtMs: entry.completedAtMs,
      signReceipt: () => signature
    });
    if (!closed.ok) throw new LocalMeteredTurnRefusedError(closed.code, closed.detail);
    this.state = {
      ...s,
      channel: closed.channel,
      units: { ...s.units, [usageNonce]: { ...entry, receipt: closed.receipt } }
    };
    await this.persist();
    return structuredClone(closed.receipt);
  }
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LE9BQU87QUFDbkUsVUFBTSxTQUFTLHVCQUF1QjtBQUFBLE1BQUUsU0FBUyxFQUFFO0FBQUEsTUFBUyxTQUFTLE1BQU07QUFBQSxNQUN6RSxjQUFjLE1BQU07QUFBQSxNQUFlLGFBQWEsTUFBTTtBQUFBLElBQVUsQ0FBQztBQUNuRSxRQUFJLENBQUMsT0FBTyxHQUFJLE9BQU0sSUFBSSw2QkFBNkIsT0FBTyxNQUFNLE9BQU8sTUFBTTtBQUNqRixTQUFLLFFBQVE7QUFBQSxNQUFFLEdBQUc7QUFBQSxNQUFHLFNBQVMsT0FBTztBQUFBLE1BQ25DLE9BQU8sRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLFVBQVUsR0FBRyxFQUFFLEdBQUcsT0FBTyxTQUFTLE9BQU8sUUFBUSxFQUFFO0FBQUEsSUFBRTtBQUM3RSxVQUFNLEtBQUssUUFBUTtBQUNuQixXQUFPLGdCQUFnQixPQUFPLE9BQU87QUFBQSxFQUN2QztBQUNGIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJtZXRlcmVkLWludm9jYXRpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBNZXRlcmluZyBpbnRlcmNlcHRpb24gb24gZXZlcnkgYmlsbGFibGUgdW5pdCAoc2hhcmVkLXBvdCBEQU8gcGxhbiBQLTAzMSkuXG4gKlxuICogUC0wMjAgKGBtaWNyb2NoYXJnZS50c2ApIG93bnMgdGhlIEFSSVRITUVUSUMgYW5kIHRoZSByZWZ1c2FsIHNlbWFudGljcyDigJRcbiAqIGR1cGxpY2F0ZSBub25jZSwgY3VtdWxhdGl2ZSByZWdyZXNzaW9uLCBjYXAgZXhoYXVzdGlvbiwgZXhwaXJ5LCBhbmQgdGhlXG4gKiBzZXR0bGUtc2lkZSByZXNlcnZhdGlvbiBjZWlsaW5nLiBUaGlzIG1vZHVsZSBvd25zIHRoZSBJTlRFUkNFUFRJT046IGl0IHR1cm5zXG4gKiBhIHBlci11c2Ugb2ZmZXIncyBwdWJsaXNoZWQgdGVybXMgKFAtMDI4IGBQZXJVc2VPZmZlclRlcm1zYCkgcGx1cyBPTkVcbiAqIGJpbGxhYmxlIHVuaXQgaW50byB0aGUgY3VtdWxhdGl2ZSB2b3VjaGVyIHRoYXQgaXMgcmVzZXJ2ZWQgQkVGT1JFIGV4ZWN1dGlvblxuICogYW5kIHRoZSBgU2lnbmVkVXNhZ2VSZWNlaXB0YCB0aGF0IGlzIHNldHRsZWQgQUZURVIgaXQsIHRoZW4gcmVjb3JkcyB0aGVcbiAqIHNlcnZlZCB1bml0cyBvbiB0aGUgUC0yMDUgbWV0ZXJpbmcgbGVkZ2VyLlxuICpcbiAqIEV2ZXJ5IGZpZWxkIFAtMDMxIHJlcXVpcmVzIGEgdm91Y2hlciB0byBiaW5kIOKAlCBwYXllciwgc2VsbGVyL2hvc3QsIHJlbGVhc2UsXG4gKiBub25jZSwgcXVhbnRpdHksIHByaWNlIHZlcnNpb24sIHNwbGl0LW1hbmlmZXN0IGhhc2gg4oCUIGlzIGFcbiAqIGBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXJgIGZpZWxkLCBzbyB0aGUgYmluZGluZyBpcyBTVFJVQ1RVUkFMOiBhIGNhbGxlclxuICogY2Fubm90IGZvcmdldCBvbmUgYW5kIHN0aWxsIHByb2R1Y2UgYSB2b3VjaGVyLlxuICpcbiAqIFB1cmUgYnkgY29uc3RydWN0aW9uOiBubyBJTywgbm8gY2xvY2ssIG5vIHNpZ25pbmcga2V5LiBUaGUgY2FsbGVyIGluamVjdHNcbiAqIGBub3dNc2AgYW5kIHRoZSB0d28gc2lnbmVycywgc28gdGhlIHNhbWUgY29yZSBydW5zIGF0IHRoZSBob3N0ZWQgV29ya2VyIGRvb3IsXG4gKiBpbiB0aGUgQllPQyBob25vciBwYXRoIChgYnlvYy1leGVjdXRpb24udHNgLCBQLTAxNyksIGFuZCBpbiB0ZXN0cy5cbiAqL1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGNhbm9uaWNhbEpzb24gfSBmcm9tICcuLi9hdXRob3JpdHkvYXV0aG9yaXR5LXJwYy1lbnZlbG9wZSc7XG5pbXBvcnQgeyB2ZXJpZnlFZDI1NTE5IH0gZnJvbSAnLi4vaWRlbnRpdHkvZWQyNTUxOSc7XG5pbXBvcnQge1xuICBwYXltZW50Vm91Y2hlckRpZ2VzdCxcbiAgcGF5bWVudFZvdWNoZXJTaWduaW5nQnl0ZXMsXG4gIHJlc2VydmVNaWNyb2NoYXJnZSxcbiAgc2V0dGxlTWljcm9jaGFyZ2UsXG4gIHVuc2lnbmVkVm91Y2hlcixcbiAgdHlwZSBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXIsXG4gIHR5cGUgTWljcm9jaGFyZ2VDaGFubmVsLFxuICB0eXBlIE1pY3JvY2hhcmdlUmVmdXNhbENvZGUsXG4gIHR5cGUgU2lnbmVkVXNhZ2VSZWNlaXB0LFxufSBmcm9tICcuL21pY3JvY2hhcmdlJztcbmltcG9ydCB7IHJlY29yZENvbnRyaWJ1dGlvbiwgcmVjb3JkU3BlbmQsIHR5cGUgTWV0ZXJpbmdMZWRnZXIgfSBmcm9tICcuL21ldGVyaW5nLWxlZGdlcic7XG5pbXBvcnQgdHlwZSB7IEJ1ZGdldEF4aXMsIEJ1ZGdldFVuaXQgfSBmcm9tICcuL29mZmVyLWJ1ZGdldCc7XG5pbXBvcnQgeyBxdW90ZUlkZW50aXR5SW5mZXJlbmNlVHVybiwgdHlwZSBJZGVudGl0eVBlclVzZU9mZmVyVGVybXMgfSBmcm9tICcuLi9jdXBib2FyZC9pZGVudGl0eS1wZXItdXNlLW9mZmVyJztcblxuLyoqIEEgYHNoYTI1Njo8NjQgaGV4PmAgc3BsaXQtbWFuaWZlc3QgaGFzaCwgZXhhY3RseSBhcyBgY3VwYm9hcmQ6cHVibGlzaC1vZmZlcmAgYWNjZXB0cyBpdC4gKi9cbmNvbnN0IFNQTElUX01BTklGRVNUX0hBU0ggPSAvXnNoYTI1NjpbMC05YS1mXXs2NH0kL2k7XG5cbi8qKlxuICogVGhlIGRlY2xhcmVkIG1ldGVyIGZvciBhIHBlci11c2UgaXRlbTogdGhlIHByaWNlIHRlcm1zIGV2ZXJ5IHZvdWNoZXIgZm9yIGl0XG4gKiBpcyBzaWduZWQgYWdhaW5zdC4gQW1vdW50cyBhcmUgYmlnaW50IG1pY3JvLXVuaXRzIHNvIGEgdGlueSBwZXItY2FsbCBjaGFyZ2VcbiAqIG5ldmVyIHBhc3NlcyB0aHJvdWdoIGZsb2F0aW5nIHBvaW50LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIE1ldGVyRGVjbGFyYXRpb24ge1xuICByZWFkb25seSBtZXRlclVuaXQ6IHN0cmluZztcbiAgcmVhZG9ubHkgdW5pdFByaWNlTWljcm9zOiBiaWdpbnQ7XG4gIHJlYWRvbmx5IHByaWNlVmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSBzcGxpdE1hbmlmZXN0SGFzaDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFRoZSBwdWJsaXNoZWQgc2hhcGUgb2YgdGhlIHRlcm1zLCBhcyB0aGUgRDEvSlNPTiBib3VuZGFyeSBjYXJyaWVzIHRoZW1cbiAqIChgUGVyVXNlT2ZmZXJUZXJtcy51bml0UHJpY2VNaWNyb3NgIGlzIGEgc2FmZSBpbnRlZ2VyIHRoZXJlKS4gQWNjZXB0aW5nIHRoZVxuICogYmlnaW50IGZvcm0gdG9vIGxldHMgYW4gaW4tcHJvY2VzcyBjYWxsZXIgc2tpcCB0aGUgcm91bmQgdHJpcC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQZXJVc2VUZXJtc0lucHV0IHtcbiAgcmVhZG9ubHkgdW5pdFByaWNlTWljcm9zOiBudW1iZXIgfCBiaWdpbnQ7XG4gIHJlYWRvbmx5IG1ldGVyVW5pdDogc3RyaW5nO1xuICByZWFkb25seSBwcmljZVZlcnNpb246IHN0cmluZztcbiAgcmVhZG9ubHkgc3BsaXRNYW5pZmVzdEhhc2g6IHN0cmluZztcbn1cblxuLyoqIE9uZSBiaWxsYWJsZSB1bml0IG9mIHdvcmssIG5hbWVkIGJlZm9yZSBpdCBpcyBleGVjdXRlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQmlsbGFibGVVbml0IHtcbiAgcmVhZG9ubHkgcGF5ZXI6IHN0cmluZztcbiAgLyoqIFRoZSBzZWxsZXIgb2YgdGhlIGl0ZW0sIHdoaWNoIG9uIHRoZSBob25vciBwYXRoIGlzIGFsc28gdGhlIHNlcnZpbmcgaG9zdC4gKi9cbiAgcmVhZG9ubHkgc2VsbGVyOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlbGVhc2VSZWY6IHN0cmluZztcbiAgcmVhZG9ubHkgdXNhZ2VOb25jZTogc3RyaW5nO1xuICByZWFkb25seSBxdWFudGl0eTogYmlnaW50O1xuICByZWFkb25seSBleHBpcmVzQXRNczogbnVtYmVyO1xufVxuXG4vKipcbiAqIFdoZXJlIHRoZSBzZXJ2ZWQgdW5pdHMgbGFuZCBvbiB0aGUgUC0yMDUgbWV0ZXJpbmcgbGVkZ2VyLiBgYXhpc2AvYHVuaXRgIGFyZVxuICogdGhlIGxlZGdlcidzIG93biB2b2NhYnVsYXJ5OyBgbWV0ZXJVbml0YCBvbiB0aGUgZGVjbGFyYXRpb24gaXMgdGhlIHNlbGxlcidzXG4gKiBkaXNwbGF5IG5hbWUgZm9yIHRoZSBzYW1lIHRoaW5nIGFuZCBpcyBOT1QgaW50ZXJjaGFuZ2VhYmxlIHdpdGggaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2VydmVkVW5pdHNCaW5kaW5nIHtcbiAgcmVhZG9ubHkgaG9zdFJlZjogc3RyaW5nO1xuICByZWFkb25seSBmbGVldFNsdWc6IHN0cmluZztcbiAgcmVhZG9ubHkgYXhpczogQnVkZ2V0QXhpcztcbiAgcmVhZG9ubHkgdW5pdDogQnVkZ2V0VW5pdDtcbiAgLyoqIE0yMjogY3JlZGl0IHRoZSBzZXJ2ZWQgdW5pdHMgdG8gYW4gYXR0ZXN0ZWQgdXNlciB3aGVuIG9uZSBpcyBrbm93bi4gKi9cbiAgcmVhZG9ubHkgYXR0ZXN0ZWRVc2VySWQ/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHBlclVzZXJDb250cmlidXRpb25DYXA/OiBudW1iZXIgfCBudWxsO1xufVxuXG5leHBvcnQgdHlwZSBNZXRlcmVkUmVmdXNhbENvZGUgPVxuICB8IE1pY3JvY2hhcmdlUmVmdXNhbENvZGVcbiAgfCAnaW52YWxpZC1tZXRlcidcbiAgfCAnaW52YWxpZC11bml0J1xuICB8ICd1bnNpZ25lZC12b3VjaGVyJ1xuICB8ICd1bnNpZ25lZC1yZWNlaXB0J1xuICB8ICd0ZXJtcy1taXNtYXRjaCdcbiAgfCAnbWV0ZXJpbmctcmVmdXNlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWV0ZXJlZFJlZnVzYWwge1xuICByZWFkb25seSBvazogZmFsc2U7XG4gIHJlYWRvbmx5IGNvZGU6IE1ldGVyZWRSZWZ1c2FsQ29kZTtcbiAgcmVhZG9ubHkgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmNvbnN0IHJlZnVzZSA9IChjb2RlOiBNZXRlcmVkUmVmdXNhbENvZGUsIGRldGFpbDogc3RyaW5nKTogTWV0ZXJlZFJlZnVzYWwgPT4gKHsgb2s6IGZhbHNlLCBjb2RlLCBkZXRhaWwgfSk7XG5cbmV4cG9ydCB0eXBlIE1ldGVyRGVjbGFyYXRpb25SZXN1bHQgPSB7IHJlYWRvbmx5IG9rOiB0cnVlOyByZWFkb25seSBtZXRlcjogTWV0ZXJEZWNsYXJhdGlvbiB9IHwgTWV0ZXJlZFJlZnVzYWw7XG5cbi8qKlxuICogVmFsaWRhdGUgcHVibGlzaGVkIHBlci11c2UgdGVybXMgaW50byBhIGRlY2xhcmVkIG1ldGVyLlxuICpcbiAqIFRoaXMgaXMgdGhlIFwiZGVjbGFyZSBhIG1ldGVyXCIgaGFsZiBvZiBQLTAzMSdzIGludGVyY2VwdGlvbiBwb2ludDogYSBkb29yIHRoYXRcbiAqIGNhbm5vdCBwcm9kdWNlIGEgYE1ldGVyRGVjbGFyYXRpb25gIG11c3QgcmVmdXNlIHRoZSBpbnZvY2F0aW9uIHJhdGhlciB0aGFuXG4gKiBleGVjdXRlIGFuIHVucHJpY2VkIGJpbGxhYmxlIHVuaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNsYXJlTWV0ZXIodGVybXM6IFBlclVzZVRlcm1zSW5wdXQpOiBNZXRlckRlY2xhcmF0aW9uUmVzdWx0IHtcbiAgY29uc3QgeyBtZXRlclVuaXQsIHByaWNlVmVyc2lvbiwgc3BsaXRNYW5pZmVzdEhhc2ggfSA9IHRlcm1zO1xuICBpZiAoIW1ldGVyVW5pdC50cmltKCkpIHJldHVybiByZWZ1c2UoJ2ludmFsaWQtbWV0ZXInLCAnbWV0ZXJVbml0IGlzIHJlcXVpcmVkJyk7XG4gIGlmICghcHJpY2VWZXJzaW9uLnRyaW0oKSkgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC1tZXRlcicsICdwcmljZVZlcnNpb24gaXMgcmVxdWlyZWQnKTtcbiAgaWYgKCFTUExJVF9NQU5JRkVTVF9IQVNILnRlc3Qoc3BsaXRNYW5pZmVzdEhhc2gpKSB7XG4gICAgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC1tZXRlcicsICdzcGxpdE1hbmlmZXN0SGFzaCBtdXN0IGJlIHNoYTI1Njo8NjQgaGV4PicpO1xuICB9XG4gIGNvbnN0IHJhdyA9IHRlcm1zLnVuaXRQcmljZU1pY3JvcztcbiAgaWYgKHR5cGVvZiByYXcgPT09ICdudW1iZXInICYmICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyYXcpKSB7XG4gICAgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC1tZXRlcicsICd1bml0UHJpY2VNaWNyb3MgbXVzdCBiZSBhIHNhZmUgaW50ZWdlcicpO1xuICB9XG4gIGNvbnN0IHVuaXRQcmljZU1pY3JvcyA9IEJpZ0ludChyYXcpO1xuICBpZiAodW5pdFByaWNlTWljcm9zIDw9IDBuKSB7XG4gICAgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC1tZXRlcicsICd1bml0UHJpY2VNaWNyb3MgbXVzdCBiZSBwb3NpdGl2ZSDigJQgYSB6ZXJvLXByaWNlIGl0ZW0gaXMgYSBmcmVlIG9mZmVyLCBub3QgYSBtZXRlcmVkIG9uZScpO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCBtZXRlcjogeyBtZXRlclVuaXQsIHVuaXRQcmljZU1pY3JvcywgcHJpY2VWZXJzaW9uLCBzcGxpdE1hbmlmZXN0SGFzaCB9IH07XG59XG5cbi8qKiBUaGUgbWljcm8tdW5pdCBwcmljZSBvZiBgcXVhbnRpdHlgIHVuaXRzIHVuZGVyIHRoaXMgbWV0ZXIuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVNaWNyb3MobWV0ZXI6IE1ldGVyRGVjbGFyYXRpb24sIHF1YW50aXR5OiBiaWdpbnQpOiBiaWdpbnQge1xuICByZXR1cm4gbWV0ZXIudW5pdFByaWNlTWljcm9zICogcXVhbnRpdHk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHVuc2lnbmVkIGN1bXVsYXRpdmUgdm91Y2hlciBmb3Igb25lIGJpbGxhYmxlIHVuaXQuXG4gKlxuICogVGhlIGNsYWltIGlzIENVTVVMQVRJVkUg4oCUIHRoZSBjaGFubmVsJ3MgbGFzdCBjbGFpbSBwbHVzIHRoaXMgdW5pdCdzIHByaWNlIOKAlFxuICogd2hpY2ggaXMgd2hhdCBtYWtlcyBhIHJlcGxheWVkIG9yIHJlb3JkZXJlZCB2b3VjaGVyIGRldGVjdGFibGUgYnlcbiAqIGByZXNlcnZlTWljcm9jaGFyZ2VgJ3MgbW9ub3RvbmljaXR5IGNoZWNrIHJhdGhlciB0aGFuIGJ5IGNvbnZlbnRpb24gaGVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkVXNhZ2VWb3VjaGVyKFxuICBjaGFubmVsOiBNaWNyb2NoYXJnZUNoYW5uZWwsXG4gIG1ldGVyOiBNZXRlckRlY2xhcmF0aW9uLFxuICB1bml0OiBCaWxsYWJsZVVuaXQsXG4pOiBPbWl0PEN1bXVsYXRpdmVQYXltZW50Vm91Y2hlciwgJ3NpZ25hdHVyZSc+IHtcbiAgcmV0dXJuIHtcbiAgICBjaGFubmVsSWQ6IGNoYW5uZWwuY2hhbm5lbElkLFxuICAgIHBheWVyOiB1bml0LnBheWVyLFxuICAgIHNlbGxlcjogdW5pdC5zZWxsZXIsXG4gICAgcmVsZWFzZVJlZjogdW5pdC5yZWxlYXNlUmVmLFxuICAgIHVzYWdlTm9uY2U6IHVuaXQudXNhZ2VOb25jZSxcbiAgICBtZXRlclF1YW50aXR5OiB1bml0LnF1YW50aXR5LFxuICAgIHByaWNlUGVyVW5pdE1pY3JvczogbWV0ZXIudW5pdFByaWNlTWljcm9zLFxuICAgIHByaWNlVmVyc2lvbjogbWV0ZXIucHJpY2VWZXJzaW9uLFxuICAgIHNwbGl0TWFuaWZlc3RIYXNoOiBtZXRlci5zcGxpdE1hbmlmZXN0SGFzaCxcbiAgICBleHBpcmVzQXRNczogdW5pdC5leHBpcmVzQXRNcyxcbiAgICBjdW11bGF0aXZlQ2xhaW1NaWNyb3M6IGNoYW5uZWwubGFzdEN1bXVsYXRpdmVNaWNyb3MgKyBxdW90ZU1pY3JvcyhtZXRlciwgdW5pdC5xdWFudGl0eSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlY2VpcHRKc29uKHJlY2VpcHQ6IE9taXQ8U2lnbmVkVXNhZ2VSZWNlaXB0LCAnc2lnbmF0dXJlJz4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB7XG4gICAgYW1vdW50TWljcm9zOiByZWNlaXB0LmFtb3VudE1pY3Jvcy50b1N0cmluZygpLFxuICAgIGNoYW5uZWxJZDogcmVjZWlwdC5jaGFubmVsSWQsXG4gICAgbWV0ZXJRdWFudGl0eTogcmVjZWlwdC5tZXRlclF1YW50aXR5LnRvU3RyaW5nKCksXG4gICAgb2NjdXJyZWRBdE1zOiByZWNlaXB0Lm9jY3VycmVkQXRNcyxcbiAgICB1c2FnZU5vbmNlOiByZWNlaXB0LnVzYWdlTm9uY2UsXG4gICAgdm91Y2hlckRpZ2VzdDogcmVjZWlwdC52b3VjaGVyRGlnZXN0LFxuICB9O1xufVxuXG4vKiogQ2Fub25pY2FsIHNpZ25pbmcgYnl0ZXMgZm9yIGEgdXNhZ2UgcmVjZWlwdCwgbWlycm9yaW5nIHRoZSB2b3VjaGVyJ3Mgb3duIHNjaGVtZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1c2FnZVJlY2VpcHRTaWduaW5nQnl0ZXMocmVjZWlwdDogT21pdDxTaWduZWRVc2FnZVJlY2VpcHQsICdzaWduYXR1cmUnPik6IEJ1ZmZlciB7XG4gIHJldHVybiBCdWZmZXIuZnJvbShjYW5vbmljYWxKc29uKHJlY2VpcHRKc29uKHJlY2VpcHQpKSwgJ3V0ZjgnKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZWxsZXJSZWNlaXB0QXV0aG9yaXR5IHtcbiAgcmVhZG9ubHkgcHVia2V5QmFzZTY0OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHByb29mOiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgYXV0aGVudGljYXRlZCBwdWJsaXNoZXIgcHJvdmVzIHBvc3Nlc3Npb24gZm9yIHRoaXMgZXhhY3Qgb2ZmZXIuICovXG5leHBvcnQgZnVuY3Rpb24gc2VsbGVyUmVjZWlwdEF1dGhvcml0eVNpZ25pbmdCeXRlcyhiaW5kaW5nOiB7XG4gIHNlbGxlcjogc3RyaW5nOyBvZmZlcklkOiBzdHJpbmc7IHByb2R1Y3RJZDogc3RyaW5nOyBza3VSZWY6IHN0cmluZzsgcHVia2V5QmFzZTY0OiBzdHJpbmc7XG59KTogQnVmZmVyIHtcbiAgcmV0dXJuIEJ1ZmZlci5mcm9tKGNhbm9uaWNhbEpzb24oeyBzY2hlbWE6ICdwYXBlcmN1c3Auc2VsbGVyLXJlY2VpcHQtYXV0aG9yaXR5L3YxJywgc2VsbGVyOiBiaW5kaW5nLnNlbGxlcixcbiAgICBvZmZlcklkOiBiaW5kaW5nLm9mZmVySWQsIHByb2R1Y3RJZDogYmluZGluZy5wcm9kdWN0SWQsIHNrdVJlZjogYmluZGluZy5za3VSZWYsXG4gICAgcHVia2V5QmFzZTY0OiBiaW5kaW5nLnB1YmtleUJhc2U2NCB9KSwgJ3V0ZjgnKTtcbn1cblxuZnVuY3Rpb24gdmVyaWZ5U2lnbmF0dXJlKGJ5dGVzOiBCdWZmZXIsIHB1YmtleUJhc2U2NDogc3RyaW5nLCBzaWduYXR1cmU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIS9eW0EtWmEtejAtOSsvXXs0M309JC8udGVzdChwdWJrZXlCYXNlNjQpIHx8ICEvXltBLVphLXowLTkrL117ODZ9PT0kLy50ZXN0KHNpZ25hdHVyZSkpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHsgcmV0dXJuIHZlcmlmeUVkMjU1MTkoYnl0ZXMsIHB1YmtleUJhc2U2NCwgQnVmZmVyLmZyb20oc2lnbmF0dXJlLCAnYmFzZTY0JykpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZnlTZWxsZXJSZWNlaXB0QXV0aG9yaXR5KGJpbmRpbmc6IHtcbiAgc2VsbGVyOiBzdHJpbmc7IG9mZmVySWQ6IHN0cmluZzsgcHJvZHVjdElkOiBzdHJpbmc7IHNrdVJlZjogc3RyaW5nO1xufSwgYXV0aG9yaXR5OiBTZWxsZXJSZWNlaXB0QXV0aG9yaXR5KTogYm9vbGVhbiB7XG4gIGlmICghYXV0aG9yaXR5IHx8IHR5cGVvZiBhdXRob3JpdHkucHVia2V5QmFzZTY0ICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgYXV0aG9yaXR5LnByb29mICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdmVyaWZ5U2lnbmF0dXJlKHNlbGxlclJlY2VpcHRBdXRob3JpdHlTaWduaW5nQnl0ZXMoeyAuLi5iaW5kaW5nLCBwdWJrZXlCYXNlNjQ6IGF1dGhvcml0eS5wdWJrZXlCYXNlNjQgfSksXG4gICAgYXV0aG9yaXR5LnB1YmtleUJhc2U2NCwgYXV0aG9yaXR5LnByb29mKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZlcmlmeVVzYWdlUmVjZWlwdFNpZ25hdHVyZShyZWNlaXB0OiBTaWduZWRVc2FnZVJlY2VpcHQsIHB1YmtleUJhc2U2NDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiB2ZXJpZnlTaWduYXR1cmUodXNhZ2VSZWNlaXB0U2lnbmluZ0J5dGVzKHJlY2VpcHQpLCBwdWJrZXlCYXNlNjQsIHJlY2VpcHQuc2lnbmF0dXJlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVzYWdlUmVjZWlwdERpZ2VzdChyZWNlaXB0OiBPbWl0PFNpZ25lZFVzYWdlUmVjZWlwdCwgJ3NpZ25hdHVyZSc+KTogc3RyaW5nIHtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZSh1c2FnZVJlY2VpcHRTaWduaW5nQnl0ZXMocmVjZWlwdCkpLmRpZ2VzdCgnaGV4Jyk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT3Blbk1ldGVyZWRJbnZvY2F0aW9uSW5wdXQge1xuICByZWFkb25seSBjaGFubmVsOiBNaWNyb2NoYXJnZUNoYW5uZWw7XG4gIHJlYWRvbmx5IG1ldGVyOiBNZXRlckRlY2xhcmF0aW9uO1xuICByZWFkb25seSB1bml0OiBCaWxsYWJsZVVuaXQ7XG4gIHJlYWRvbmx5IG5vd01zOiBudW1iZXI7XG4gIC8qKiBSZXR1cm5zIHRoZSBwYXllcidzIHNpZ25hdHVyZSBvdmVyIHRoZSB2b3VjaGVyJ3MgY2Fub25pY2FsIGJ5dGVzLiAqL1xuICByZWFkb25seSBzaWduVm91Y2hlcjogKGJ5dGVzOiBCdWZmZXIpID0+IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgT3Blbk1ldGVyZWRJbnZvY2F0aW9uUmVzdWx0ID1cbiAgfCB7XG4gICAgICByZWFkb25seSBvazogdHJ1ZTtcbiAgICAgIHJlYWRvbmx5IGNoYW5uZWw6IE1pY3JvY2hhcmdlQ2hhbm5lbDtcbiAgICAgIHJlYWRvbmx5IHZvdWNoZXI6IEN1bXVsYXRpdmVQYXltZW50Vm91Y2hlcjtcbiAgICAgIHJlYWRvbmx5IHJlc2VydmVkTWljcm9zOiBiaWdpbnQ7XG4gICAgfVxuICB8IE1ldGVyZWRSZWZ1c2FsO1xuXG5mdW5jdGlvbiB2YWxpZGF0ZVVuaXQodW5pdDogQmlsbGFibGVVbml0KTogTWV0ZXJlZFJlZnVzYWwgfCBudWxsIHtcbiAgaWYgKCF1bml0LnBheWVyLnRyaW0oKSkgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ3BheWVyIGlzIHJlcXVpcmVkJyk7XG4gIGlmICghdW5pdC5zZWxsZXIudHJpbSgpKSByZXR1cm4gcmVmdXNlKCdpbnZhbGlkLXVuaXQnLCAnc2VsbGVyIGlzIHJlcXVpcmVkJyk7XG4gIGlmICghdW5pdC5yZWxlYXNlUmVmLnRyaW0oKSkgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ3JlbGVhc2VSZWYgaXMgcmVxdWlyZWQnKTtcbiAgaWYgKCF1bml0LnVzYWdlTm9uY2UudHJpbSgpKSByZXR1cm4gcmVmdXNlKCdpbnZhbGlkLXVuaXQnLCAndXNhZ2VOb25jZSBpcyByZXF1aXJlZCcpO1xuICBpZiAodW5pdC5xdWFudGl0eSA8PSAwbikgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ3F1YW50aXR5IG11c3QgYmUgcG9zaXRpdmUnKTtcbiAgaWYgKHVuaXQucXVhbnRpdHkgPiBCaWdJbnQoTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVIpKSB7XG4gICAgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ3F1YW50aXR5IGV4Y2VlZHMgdGhlIHNhZmUtaW50ZWdlciByYW5nZSB0aGUgbWV0ZXJpbmcgbGVkZ2VyIHJlY29yZHMgaW4nKTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh1bml0LmV4cGlyZXNBdE1zKSkgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ2V4cGlyZXNBdE1zIG11c3QgYmUgZmluaXRlJyk7XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIElOVEVSQ0VQVElPTiBQT0lOVCDigJQgY2FsbCB0aGlzIEJFRk9SRSBleGVjdXRpbmcgdGhlIGJpbGxhYmxlIHVuaXQuXG4gKlxuICogUmVzZXJ2aW5nIGZpcnN0IGlzIHRoZSB3aG9sZSBwb2ludDogYSB1bml0IHRoYXQgd291bGQgZXhoYXVzdCB0aGUgY2FwIG9yXG4gKiByZXBsYXkgYSBub25jZSBpcyByZWZ1c2VkIHdoaWxlIHJlZnVzaW5nIGlzIHN0aWxsIGZyZWUsIGluc3RlYWQgb2YgYmVpbmdcbiAqIGRpc2NvdmVyZWQgYWZ0ZXIgdGhlIHNlbGxlciBoYXMgYWxyZWFkeSBwYWlkIHRvIHNlcnZlIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gb3Blbk1ldGVyZWRJbnZvY2F0aW9uKGlucHV0OiBPcGVuTWV0ZXJlZEludm9jYXRpb25JbnB1dCk6IE9wZW5NZXRlcmVkSW52b2NhdGlvblJlc3VsdCB7XG4gIGNvbnN0IGludmFsaWQgPSB2YWxpZGF0ZVVuaXQoaW5wdXQudW5pdCk7XG4gIGlmIChpbnZhbGlkKSByZXR1cm4gaW52YWxpZDtcbiAgY29uc3QgdW5zaWduZWQgPSBidWlsZFVzYWdlVm91Y2hlcihpbnB1dC5jaGFubmVsLCBpbnB1dC5tZXRlciwgaW5wdXQudW5pdCk7XG4gIGNvbnN0IHNpZ25hdHVyZSA9IGlucHV0LnNpZ25Wb3VjaGVyKHBheW1lbnRWb3VjaGVyU2lnbmluZ0J5dGVzKHVuc2lnbmVkKSk7XG4gIGlmICh0eXBlb2Ygc2lnbmF0dXJlICE9PSAnc3RyaW5nJyB8fCAhc2lnbmF0dXJlLnRyaW0oKSkge1xuICAgIHJldHVybiByZWZ1c2UoJ3Vuc2lnbmVkLXZvdWNoZXInLCAndGhlIHBheWVyIHNpZ25lciByZXR1cm5lZCBubyBzaWduYXR1cmUgZm9yIHRoZSBjdW11bGF0aXZlIHZvdWNoZXInKTtcbiAgfVxuICBjb25zdCB2b3VjaGVyOiBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXIgPSB7IC4uLnVuc2lnbmVkLCBzaWduYXR1cmUgfTtcbiAgY29uc3QgcmVzZXJ2ZWQgPSByZXNlcnZlTWljcm9jaGFyZ2UoaW5wdXQuY2hhbm5lbCwgdm91Y2hlciwgaW5wdXQubm93TXMpO1xuICBpZiAoIXJlc2VydmVkLm9rKSByZXR1cm4gcmVmdXNlKHJlc2VydmVkLmNvZGUsIHJlc2VydmVkLmRldGFpbCk7XG4gIHJldHVybiB7IG9rOiB0cnVlLCBjaGFubmVsOiByZXNlcnZlZC5jaGFubmVsLCB2b3VjaGVyLCByZXNlcnZlZE1pY3JvczogcmVzZXJ2ZWQuZGVsdGFNaWNyb3MgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBY2NlcHRNZXRlcmVkVm91Y2hlcklucHV0IHtcbiAgcmVhZG9ubHkgY2hhbm5lbDogTWljcm9jaGFyZ2VDaGFubmVsO1xuICByZWFkb25seSBtZXRlcjogTWV0ZXJEZWNsYXJhdGlvbjtcbiAgcmVhZG9ubHkgdW5pdDogQmlsbGFibGVVbml0O1xuICAvKiogVGhlIHZvdWNoZXIgYXMgdGhlIFBBWUVSIHNpZ25lZCBpdCwgYXJyaXZpbmcgb3ZlciB0aGUgd2lyZS4gKi9cbiAgcmVhZG9ubHkgdm91Y2hlcjogQ3VtdWxhdGl2ZVBheW1lbnRWb3VjaGVyO1xuICByZWFkb25seSBub3dNczogbnVtYmVyO1xuICAvKiogVHJ1c3RlZCBob3N0IGNyeXB0b2dyYXBoaWMgdmVyaWZpZXIuIE9taXNzaW9uIG9yIGEgdmVyaWZpZXIgZXJyb3IgcmVmdXNlcyBhZG1pc3Npb24uICovXG4gIHJlYWRvbmx5IHZlcmlmeVNpZ25hdHVyZT86ICh2b3VjaGVyOiBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXIpID0+IGJvb2xlYW47XG59XG5cbi8qKlxuICogSU5URVJDRVBUSU9OIFBPSU5UIGZvciBhIHZvdWNoZXIgdGhlIGNhbGxlciBkaWQgTk9UIGJ1aWxkLlxuICpcbiAqIEEgaG9zdGVkIGRvb3IgbmV2ZXIgaG9sZHMgdGhlIHBheWVyJ3Mgc2lnbmluZyBrZXksIHNvIGl0IHJlY2VpdmVzIGEgc2lnbmVkXG4gKiB2b3VjaGVyIGluc3RlYWQgb2YgcHJvZHVjaW5nIG9uZS4gVGhhdCBtYWtlcyB0aGUgdm91Y2hlciBBVFRBQ0tFUi1DT05UUk9MTEVEOlxuICogaXRzIGN1bXVsYXRpdmUgY2xhaW0sIGl0cyBwcmljZSB0ZXJtcyBhbmQgaXRzIHF1YW50aXR5IGFyZSBhbGwgYXNzZXJ0aW9uc1xuICogdW50aWwgY2hlY2tlZCBoZXJlLiBFdmVyeSBvbmUgb2YgdGhlbSBpcyByZS1kZXJpdmVkIGZyb20gdGhlIERFQ0xBUkVEIG1ldGVyXG4gKiBhbmQgdGhlIG5hbWVkIHVuaXQsIGFuZCB0aGUgY3VtdWxhdGl2ZSBjbGFpbSBpcyB0aGVuIGhhbmRlZCB0b1xuICogYHJlc2VydmVNaWNyb2NoYXJnZWAsIHdob3NlIG1vbm90b25pY2l0eSBndWFyZCBpcyB3aGF0IHJlZnVzZXMgYSBSRVBMQVlFRCBvclxuICogUkVHUkVTU0VEIGNsYWltIGZyb20gYSBzdGFsZSAob3IgbWFsaWNpb3VzKSBjbGllbnQgdmlldyBvZiB0aGUgY2hhbm5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFjY2VwdE1ldGVyZWRWb3VjaGVyKGlucHV0OiBBY2NlcHRNZXRlcmVkVm91Y2hlcklucHV0KTogT3Blbk1ldGVyZWRJbnZvY2F0aW9uUmVzdWx0IHtcbiAgY29uc3QgaW52YWxpZCA9IHZhbGlkYXRlVW5pdChpbnB1dC51bml0KTtcbiAgaWYgKGludmFsaWQpIHJldHVybiBpbnZhbGlkO1xuICBjb25zdCBleHBlY3RlZCA9IGJ1aWxkVXNhZ2VWb3VjaGVyKGlucHV0LmNoYW5uZWwsIGlucHV0Lm1ldGVyLCBpbnB1dC51bml0KTtcbiAgY29uc3QgdiA9IGlucHV0LnZvdWNoZXI7XG4gIGlmICh2LmNoYW5uZWxJZCAhPT0gZXhwZWN0ZWQuY2hhbm5lbElkKSByZXR1cm4gcmVmdXNlKCdjaGFubmVsLW1pc21hdGNoJywgJ3ZvdWNoZXIgY2hhbm5lbCBkb2VzIG5vdCBtYXRjaCB0aGUgbG9jYWwgcGF5bWVudCBjaGFubmVsJyk7XG4gIGlmICh2LnBheWVyICE9PSBleHBlY3RlZC5wYXllcikgcmV0dXJuIHJlZnVzZSgndGVybXMtbWlzbWF0Y2gnLCAndm91Y2hlciBwYXllciBkb2VzIG5vdCBtYXRjaCB0aGUgYmlsbGVkIHVuaXQnKTtcbiAgaWYgKHYuc2VsbGVyICE9PSBleHBlY3RlZC5zZWxsZXIpIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ3ZvdWNoZXIgc2VsbGVyIGRvZXMgbm90IG1hdGNoIHRoZSBiaWxsZWQgdW5pdCcpO1xuICBpZiAodi5yZWxlYXNlUmVmICE9PSBleHBlY3RlZC5yZWxlYXNlUmVmKSByZXR1cm4gcmVmdXNlKCd0ZXJtcy1taXNtYXRjaCcsICd2b3VjaGVyIHJlbGVhc2VSZWYgZG9lcyBub3QgbWF0Y2ggdGhlIGJpbGxlZCB1bml0Jyk7XG4gIGlmICh2LnVzYWdlTm9uY2UgIT09IGV4cGVjdGVkLnVzYWdlTm9uY2UpIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ3ZvdWNoZXIgdXNhZ2VOb25jZSBkb2VzIG5vdCBtYXRjaCB0aGUgYmlsbGVkIHVuaXQnKTtcbiAgaWYgKHYubWV0ZXJRdWFudGl0eSAhPT0gZXhwZWN0ZWQubWV0ZXJRdWFudGl0eSkgcmV0dXJuIHJlZnVzZSgndGVybXMtbWlzbWF0Y2gnLCAndm91Y2hlciBtZXRlclF1YW50aXR5IGRvZXMgbm90IG1hdGNoIHRoZSBiaWxsZWQgdW5pdCcpO1xuICBpZiAodi5wcmljZVBlclVuaXRNaWNyb3MgIT09IGV4cGVjdGVkLnByaWNlUGVyVW5pdE1pY3JvcykgcmV0dXJuIHJlZnVzZSgndGVybXMtbWlzbWF0Y2gnLCAndm91Y2hlciBwcmljZSBkb2VzIG5vdCBtYXRjaCB0aGUgZGVjbGFyZWQgbWV0ZXInKTtcbiAgaWYgKHYucHJpY2VWZXJzaW9uICE9PSBleHBlY3RlZC5wcmljZVZlcnNpb24pIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ3ZvdWNoZXIgcHJpY2VWZXJzaW9uIGRvZXMgbm90IG1hdGNoIHRoZSBkZWNsYXJlZCBtZXRlcicpO1xuICBpZiAodi5zcGxpdE1hbmlmZXN0SGFzaCAhPT0gZXhwZWN0ZWQuc3BsaXRNYW5pZmVzdEhhc2gpIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ3ZvdWNoZXIgc3BsaXRNYW5pZmVzdEhhc2ggZG9lcyBub3QgbWF0Y2ggdGhlIGRlY2xhcmVkIG1ldGVyJyk7XG4gIGlmICghdi5zaWduYXR1cmUudHJpbSgpKSByZXR1cm4gcmVmdXNlKCd1bnNpZ25lZC12b3VjaGVyJywgJ3RoZSBjdW11bGF0aXZlIHZvdWNoZXIgY2FycmllcyBubyBwYXllciBzaWduYXR1cmUnKTtcbiAgbGV0IGF1dGhlbnRpY2F0ZWQgPSBmYWxzZTtcbiAgdHJ5IHsgYXV0aGVudGljYXRlZCA9IGlucHV0LnZlcmlmeVNpZ25hdHVyZT8uKHYpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogdmVyaWZpZXIgZmFpbHVyZSByZWZ1c2VzIHBheW1lbnQgKi8gfVxuICBpZiAoIWF1dGhlbnRpY2F0ZWQpIHJldHVybiByZWZ1c2UoJ2ludmFsaWQtdm91Y2hlcicsICd0aGUgcGF5ZXIgc2lnbmF0dXJlIGZhaWxlZCB2ZXJpZmljYXRpb24nKTtcbiAgY29uc3QgcmVzZXJ2ZWQgPSByZXNlcnZlTWljcm9jaGFyZ2UoaW5wdXQuY2hhbm5lbCwgdiwgaW5wdXQubm93TXMpO1xuICBpZiAoIXJlc2VydmVkLm9rKSByZXR1cm4gcmVmdXNlKHJlc2VydmVkLmNvZGUsIHJlc2VydmVkLmRldGFpbCk7XG4gIHJldHVybiB7IG9rOiB0cnVlLCBjaGFubmVsOiByZXNlcnZlZC5jaGFubmVsLCB2b3VjaGVyOiB2LCByZXNlcnZlZE1pY3JvczogcmVzZXJ2ZWQuZGVsdGFNaWNyb3MgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDbG9zZU1ldGVyZWRJbnZvY2F0aW9uSW5wdXQge1xuICByZWFkb25seSBjaGFubmVsOiBNaWNyb2NoYXJnZUNoYW5uZWw7XG4gIHJlYWRvbmx5IHZvdWNoZXI6IEN1bXVsYXRpdmVQYXltZW50Vm91Y2hlcjtcbiAgLyoqIFVuaXRzIGFjdHVhbGx5IHNlcnZlZDsgZGVmYXVsdHMgdG8gdGhlIHJlc2VydmVkIHF1YW50aXR5LiBOZXZlciBtb3JlLiAqL1xuICByZWFkb25seSBhY3R1YWxRdWFudGl0eT86IGJpZ2ludDtcbiAgLyoqIEV4YWN0IGJpbGxlZC1jb3N0IHNldHRsZW1lbnQuIE9mZmVyIGFuZCBwcmlvciByZW1haW5kZXIgY29tZSBmcm9tIGR1cmFibGUgYXV0aG9yaXR5LiAqL1xuICByZWFkb25seSBpZGVudGl0eUluZmVyZW5jZT86IHtcbiAgICByZWFkb25seSBvZmZlcjogSWRlbnRpdHlQZXJVc2VPZmZlclRlcm1zO1xuICAgIHJlYWRvbmx5IGJpbGxlZEluZmVyZW5jZU1pY3JvczogYmlnaW50O1xuICAgIHJlYWRvbmx5IGluZmVyZW5jZUNlaWxpbmdNaWNyb3M6IGJpZ2ludDtcbiAgICByZWFkb25seSBwcmlvclJlbWFpbmRlck51bWVyYXRvcjogYmlnaW50O1xuICB9O1xuICByZWFkb25seSBvY2N1cnJlZEF0TXM6IG51bWJlcjtcbiAgLyoqIFJldHVybnMgdGhlIHNlbGxlci9ob3N0IHNpZ25hdHVyZSBvdmVyIHRoZSByZWNlaXB0J3MgY2Fub25pY2FsIGJ5dGVzLiAqL1xuICByZWFkb25seSBzaWduUmVjZWlwdDogKGJ5dGVzOiBCdWZmZXIpID0+IHN0cmluZztcbiAgLyoqIFJlY29yZCB0aGUgc2VydmVkIHVuaXRzIG9uIHRoZSBQLTIwNSBsZWRnZXIgYXMgcGFydCBvZiB0aGUgc2FtZSBzZXR0bGVtZW50LiAqL1xuICByZWFkb25seSBtZXRlcmluZz86IHtcbiAgICByZWFkb25seSBsZWRnZXI6IE1ldGVyaW5nTGVkZ2VyO1xuICAgIHJlYWRvbmx5IHNlcnZlZDogU2VydmVkVW5pdHNCaW5kaW5nO1xuICB9O1xufVxuXG5leHBvcnQgdHlwZSBDbG9zZU1ldGVyZWRJbnZvY2F0aW9uUmVzdWx0ID1cbiAgfCB7XG4gICAgICByZWFkb25seSBvazogdHJ1ZTtcbiAgICAgIHJlYWRvbmx5IGNoYW5uZWw6IE1pY3JvY2hhcmdlQ2hhbm5lbDtcbiAgICAgIHJlYWRvbmx5IHJlY2VpcHQ6IFNpZ25lZFVzYWdlUmVjZWlwdDtcbiAgICAgIHJlYWRvbmx5IGFtb3VudE1pY3JvczogYmlnaW50O1xuICAgICAgLyoqIFByZXNlbnQgb25seSB3aGVuIGBtZXRlcmluZ2Agd2FzIHN1cHBsaWVkLiAqL1xuICAgICAgcmVhZG9ubHkgbWV0ZXJpbmc/OiBNZXRlcmluZ0xlZGdlcjtcbiAgICAgIHJlYWRvbmx5IGNvbnRyaWJ1dGlvbkNyZWRpdGVkOiBudW1iZXI7XG4gICAgfVxuICB8IE1ldGVyZWRSZWZ1c2FsO1xuXG4vKipcbiAqIElOVEVSQ0VQVElPTiBQT0lOVCDigJQgY2FsbCB0aGlzIEFGVEVSIHRoZSBiaWxsYWJsZSB1bml0IGhhcyBiZWVuIGV4ZWN1dGVkLlxuICpcbiAqIFNldHRsaW5nIHdpdGggdGhlIEFDVFVBTCBxdWFudGl0eSByZWxlYXNlcyB0aGUgdW51c2VkIHBhcnQgb2YgdGhlIHJlc2VydmF0aW9uXG4gKiBiYWNrIHRvIHRoZSBjaGFubmVsLCBzbyBhIHVuaXQgdGhhdCByZXNlcnZlZCB0ZW4gYW5kIHNlcnZlZCB0aHJlZSBkb2VzIG5vdFxuICogc3RyYW5kIHRoZSBvdGhlciBzZXZlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlTWV0ZXJlZEludm9jYXRpb24oaW5wdXQ6IENsb3NlTWV0ZXJlZEludm9jYXRpb25JbnB1dCk6IENsb3NlTWV0ZXJlZEludm9jYXRpb25SZXN1bHQge1xuICBjb25zdCBzZXJ2ZWQgPSBpbnB1dC5hY3R1YWxRdWFudGl0eSA/PyBpbnB1dC52b3VjaGVyLm1ldGVyUXVhbnRpdHk7XG4gIC8vIEEgZnVuZGVkIHR1cm4gY2FuIGNsb3NlIHdpdGhvdXQgZW50ZXJpbmcgYW55IHRvb2wgaGFuZGxlci4gSXRzIG9yaWdpbmFsXG4gIC8vIHBvc2l0aXZlIHZvdWNoZXIgc3RpbGwgYmluZHMgdGhlIHJlbGVhc2VkIGhvbGQgYW5kIHRoZSBzaWduZWQgemVybyByZWNlaXB0LlxuICBpZiAoc2VydmVkIDwgMG4pIHJldHVybiByZWZ1c2UoJ2ludmFsaWQtdW5pdCcsICdhY3R1YWxRdWFudGl0eSBtdXN0IGJlIG5vbi1uZWdhdGl2ZScpO1xuICBpZiAoc2VydmVkID4gaW5wdXQudm91Y2hlci5tZXRlclF1YW50aXR5KSB7XG4gICAgcmV0dXJuIHJlZnVzZSgnYWN0dWFsLWV4Y2VlZHMtcmVzZXJ2YXRpb24nLCBgc2VydmVkICR7c2VydmVkfSBleGNlZWRzIHRoZSByZXNlcnZlZCBxdWFudGl0eSAke2lucHV0LnZvdWNoZXIubWV0ZXJRdWFudGl0eX1gKTtcbiAgfVxuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlucHV0Lm9jY3VycmVkQXRNcykgfHwgaW5wdXQub2NjdXJyZWRBdE1zIDwgMCkgcmV0dXJuIHJlZnVzZSgnaW52YWxpZC11bml0JywgJ29jY3VycmVkQXRNcyBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIHNhZmUgaW50ZWdlcicpO1xuICBsZXQgYW1vdW50TWljcm9zID0gaW5wdXQudm91Y2hlci5wcmljZVBlclVuaXRNaWNyb3MgKiBzZXJ2ZWQ7XG4gIGlmIChpbnB1dC5pZGVudGl0eUluZmVyZW5jZSkge1xuICAgIGNvbnN0IGV4YWN0ID0gaW5wdXQuaWRlbnRpdHlJbmZlcmVuY2U7XG4gICAgY29uc3Qgb2ZmZXIgPSBleGFjdC5vZmZlcjtcbiAgICBjb25zdCBxID0gcXVvdGVJZGVudGl0eUluZmVyZW5jZVR1cm4oZXhhY3QpO1xuICAgIGlmICghcS5vaykgcmV0dXJuIHJlZnVzZSgndGVybXMtbWlzbWF0Y2gnLCBxLmRldGFpbCk7XG4gICAgaWYgKGlucHV0LmFjdHVhbFF1YW50aXR5ICE9PSB1bmRlZmluZWQgfHwgaW5wdXQubWV0ZXJpbmcgfHxcbiAgICAgICAgb2ZmZXIuc2t1UmVmICE9PSBpbnB1dC52b3VjaGVyLnJlbGVhc2VSZWYgfHxcbiAgICAgICAgQmlnSW50KG9mZmVyLnVuaXRQcmljZU1pY3JvcykgIT09IGlucHV0LnZvdWNoZXIucHJpY2VQZXJVbml0TWljcm9zIHx8XG4gICAgICAgIG9mZmVyLnByaWNlVmVyc2lvbiAhPT0gaW5wdXQudm91Y2hlci5wcmljZVZlcnNpb24gfHwgb2ZmZXIuc3BsaXRNYW5pZmVzdEhhc2ggIT09IGlucHV0LnZvdWNoZXIuc3BsaXRNYW5pZmVzdEhhc2gpIHtcbiAgICAgIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ2V4YWN0IGlkZW50aXR5IGNvc3QgbXVzdCBiaW5kIHRoZSByZXNlcnZlZCBpZGVudGl0eSBvZmZlciB3aXRob3V0IGEgcXVhbnRpdHkgb3ZlcnJpZGUnKTtcbiAgICB9XG4gICAgaWYgKHEucmVzZXJ2YXRpb25RdWFudGl0eSAhPT0gaW5wdXQudm91Y2hlci5tZXRlclF1YW50aXR5KSB7XG4gICAgICByZXR1cm4gcmVmdXNlKCd0ZXJtcy1taXNtYXRjaCcsICdpZGVudGl0eSBpbmZlcmVuY2UgY2VpbGluZyBkaWZmZXJzIGZyb20gdGhlIHNpZ25lZCByZXNlcnZhdGlvbicpO1xuICAgIH1cbiAgICBhbW91bnRNaWNyb3MgPSBxLmFtb3VudE1pY3JvcztcbiAgfSBlbHNlIGlmIChpbnB1dC52b3VjaGVyLnJlbGVhc2VSZWYuc3RhcnRzV2l0aCgnaWRlbnRpdHktcmVsZWFzZTonKSkge1xuICAgIHJldHVybiByZWZ1c2UoJ3Rlcm1zLW1pc21hdGNoJywgJ2lkZW50aXR5IHJlbGVhc2VzIHJlcXVpcmUgZXhhY3QgYmlsbGVkIGluZmVyZW5jZSBzZXR0bGVtZW50Jyk7XG4gIH1cbiAgY29uc3QgdW5zaWduZWRSZWNlaXB0OiBPbWl0PFNpZ25lZFVzYWdlUmVjZWlwdCwgJ3NpZ25hdHVyZSc+ID0ge1xuICAgIGNoYW5uZWxJZDogaW5wdXQuY2hhbm5lbC5jaGFubmVsSWQsXG4gICAgdXNhZ2VOb25jZTogaW5wdXQudm91Y2hlci51c2FnZU5vbmNlLFxuICAgIG1ldGVyUXVhbnRpdHk6IHNlcnZlZCxcbiAgICBhbW91bnRNaWNyb3MsXG4gICAgdm91Y2hlckRpZ2VzdDogcGF5bWVudFZvdWNoZXJEaWdlc3QodW5zaWduZWRWb3VjaGVyKGlucHV0LnZvdWNoZXIpKSxcbiAgICBvY2N1cnJlZEF0TXM6IGlucHV0Lm9jY3VycmVkQXRNcyxcbiAgfTtcbiAgY29uc3QgcmVjZWlwdFNpZ25hdHVyZSA9IGlucHV0LnNpZ25SZWNlaXB0KHVzYWdlUmVjZWlwdFNpZ25pbmdCeXRlcyh1bnNpZ25lZFJlY2VpcHQpKTtcbiAgaWYgKHR5cGVvZiByZWNlaXB0U2lnbmF0dXJlICE9PSAnc3RyaW5nJyB8fCAhcmVjZWlwdFNpZ25hdHVyZS50cmltKCkpIHtcbiAgICByZXR1cm4gcmVmdXNlKCd1bnNpZ25lZC1yZWNlaXB0JywgJ3RoZSBzZWxsZXIgc2lnbmVyIHJldHVybmVkIG5vIHNpZ25hdHVyZSBmb3IgdGhlIHVzYWdlIHJlY2VpcHQnKTtcbiAgfVxuXG4gIGNvbnN0IHNldHRsZWQgPSBzZXR0bGVNaWNyb2NoYXJnZSh7XG4gICAgY2hhbm5lbDogaW5wdXQuY2hhbm5lbCxcbiAgICB2b3VjaGVyOiBpbnB1dC52b3VjaGVyLFxuICAgIGFjdHVhbEFtb3VudE1pY3JvczogYW1vdW50TWljcm9zLFxuICAgIGFjdHVhbE1ldGVyUXVhbnRpdHk6IHNlcnZlZCxcbiAgICBvY2N1cnJlZEF0TXM6IGlucHV0Lm9jY3VycmVkQXRNcyxcbiAgICByZWNlaXB0U2lnbmF0dXJlLFxuICB9KTtcbiAgaWYgKCFzZXR0bGVkLm9rKSByZXR1cm4gcmVmdXNlKHNldHRsZWQuY29kZSwgc2V0dGxlZC5kZXRhaWwpO1xuXG4gIGlmICghaW5wdXQubWV0ZXJpbmcpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgY2hhbm5lbDogc2V0dGxlZC5jaGFubmVsLCByZWNlaXB0OiBzZXR0bGVkLnJlY2VpcHQsIGFtb3VudE1pY3JvcywgY29udHJpYnV0aW9uQ3JlZGl0ZWQ6IDAgfTtcbiAgfVxuXG4gIC8vIFRoZSBzZXJ2ZWQgUVVBTlRJVFkgKG5vdCB0aGUgbW9uZXkpIGlzIHdoYXQgdGhlIG1ldGVyaW5nIGxlZGdlciBjb3VudHMg4oCUXG4gIC8vIGl0IGlzIGEgY2FwYWNpdHkgbGVkZ2VyLCBhbmQgYHNlcnZlZGAncyB1bml0IGlzIHRoZSBiaW5kaW5nJ3MgQnVkZ2V0VW5pdC5cbiAgY29uc3QgYW1vdW50ID0gTnVtYmVyKHNlcnZlZCk7XG4gIGNvbnN0IHNwZW5kID0gcmVjb3JkU3BlbmQoaW5wdXQubWV0ZXJpbmcubGVkZ2VyLCB7XG4gICAgaG9zdFJlZjogaW5wdXQubWV0ZXJpbmcuc2VydmVkLmhvc3RSZWYsXG4gICAgZmxlZXRTbHVnOiBpbnB1dC5tZXRlcmluZy5zZXJ2ZWQuZmxlZXRTbHVnLFxuICAgIGF4aXM6IGlucHV0Lm1ldGVyaW5nLnNlcnZlZC5heGlzLFxuICAgIGFtb3VudCxcbiAgICB1bml0OiBpbnB1dC5tZXRlcmluZy5zZXJ2ZWQudW5pdCxcbiAgfSk7XG4gIGlmICghc3BlbmQub2spIHJldHVybiByZWZ1c2UoJ21ldGVyaW5nLXJlZnVzZWQnLCBgJHtzcGVuZC5jb2RlfTogbWV0ZXJpbmcgbGVkZ2VyIHJlZnVzZWQgdGhlIHNlcnZlZCB1bml0c2ApO1xuICBsZXQgbGVkZ2VyID0gc3BlbmQubGVkZ2VyO1xuICBsZXQgY29udHJpYnV0aW9uQ3JlZGl0ZWQgPSAwO1xuICBpZiAoaW5wdXQubWV0ZXJpbmcuc2VydmVkLmF0dGVzdGVkVXNlcklkKSB7XG4gICAgY29uc3QgY29udHJpYnV0aW9uID0gcmVjb3JkQ29udHJpYnV0aW9uKGxlZGdlciwge1xuICAgICAgYXR0ZXN0ZWRVc2VySWQ6IGlucHV0Lm1ldGVyaW5nLnNlcnZlZC5hdHRlc3RlZFVzZXJJZCxcbiAgICAgIGF4aXM6IGlucHV0Lm1ldGVyaW5nLnNlcnZlZC5heGlzLFxuICAgICAgYW1vdW50LFxuICAgICAgdW5pdDogaW5wdXQubWV0ZXJpbmcuc2VydmVkLnVuaXQsXG4gICAgICBwZXJVc2VyQ2FwOiBpbnB1dC5tZXRlcmluZy5zZXJ2ZWQucGVyVXNlckNvbnRyaWJ1dGlvbkNhcCA/PyBudWxsLFxuICAgIH0pO1xuICAgIGlmICghY29udHJpYnV0aW9uLm9rKSByZXR1cm4gcmVmdXNlKCdtZXRlcmluZy1yZWZ1c2VkJywgYCR7Y29udHJpYnV0aW9uLmNvZGV9OiBtZXRlcmluZyBsZWRnZXIgcmVmdXNlZCB0aGUgY29udHJpYnV0aW9uIGNyZWRpdGApO1xuICAgIGxlZGdlciA9IGNvbnRyaWJ1dGlvbi5sZWRnZXI7XG4gICAgY29udHJpYnV0aW9uQ3JlZGl0ZWQgPSBjb250cmlidXRpb24uY3JlZGl0ZWQ7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBjaGFubmVsOiBzZXR0bGVkLmNoYW5uZWwsXG4gICAgcmVjZWlwdDogc2V0dGxlZC5yZWNlaXB0LFxuICAgIGFtb3VudE1pY3JvcyxcbiAgICBtZXRlcmluZzogbGVkZ2VyLFxuICAgIGNvbnRyaWJ1dGlvbkNyZWRpdGVkLFxuICB9O1xufVxuXG4vKiogTG9jYWwgc3RhdGUgb2YgT05FIGhvc3QtYXV0aG9yaXplZCBmdW5kZWQgdHVybiwgaW5jbHVkaW5nIGl0cyBzZXR0bGVtZW50IG91dGJveC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxNZXRlcmVkVHVyblN0YXRlIHtcbiAgcmVhZG9ubHkgdHVybklkOiBzdHJpbmc7XG4gIC8qKiBEdXJhYmxlIGhvc3QgY2xvc3VyZS9yZXZvY2F0aW9uLiBPbWl0dGVkIG9ubHkgaW4gbGVnYWN5IG9wZW4gc25hcHNob3RzLiAqL1xuICByZWFkb25seSBhZG1pc3Npb25DbG9zZWQ/OiBib29sZWFuO1xuICByZWFkb25seSBwYXllcjogc3RyaW5nO1xuICByZWFkb25seSBzZWxsZXI6IHN0cmluZztcbiAgcmVhZG9ubHkgcmVsZWFzZVJlZjogc3RyaW5nO1xuICByZWFkb25seSBtZXRlcjogTWV0ZXJEZWNsYXJhdGlvbjtcbiAgcmVhZG9ubHkgY2VpbGluZ01pY3JvczogYmlnaW50O1xuICByZWFkb25seSBleHBpcmVzQXRNczogbnVtYmVyO1xuICByZWFkb25seSByZXNlcnZlZE1pY3JvczogYmlnaW50O1xuICByZWFkb25seSBjaGFubmVsOiBNaWNyb2NoYXJnZUNoYW5uZWw7XG4gIHJlYWRvbmx5IHVuaXRzOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB7XG4gICAgcmVhZG9ubHkgdm91Y2hlcjogQ3VtdWxhdGl2ZVBheW1lbnRWb3VjaGVyO1xuICAgIHJlYWRvbmx5IGNvbXBsZXRlZEF0TXM6IG51bWJlciB8IG51bGw7XG4gICAgcmVhZG9ubHkgcmVjZWlwdDogU2lnbmVkVXNhZ2VSZWNlaXB0IHwgbnVsbDtcbiAgfT4+O1xufVxuXG5leHBvcnQgY2xhc3MgTG9jYWxNZXRlcmVkVHVyblJlZnVzZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocmVhZG9ubHkgY29kZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZykge1xuICAgIHN1cGVyKGRldGFpbCk7XG4gICAgdGhpcy5uYW1lID0gJ0xvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3InO1xuICB9XG59XG5cbi8qKlxuICogQ2hhcmdlcyBsb2NhbCB0b29sIGNhbGxzIGluc2lkZSBhbiBhbHJlYWR5IGZ1bmRlZCB0dXJuIChELTAxMC9ELTAzNykuXG4gKiBUaGUgaG9zdCBzdXBwbGllcyB0aGUgYXV0aGVudGljYXRlZCBjaGFubmVsLCBleGFjdCBpbnN0YWxsZWQgb2ZmZXIsIGFuZFxuICogY2VpbGluZyBBRlRFUiByZXNlcnZpbmcgZnVuZGluZyBvbmNlIHBlciB0dXJuLiBUaGlzIGNsYXNzIGRvZXMgbm8gaG9zdGVkIElPXG4gKiBhbmQgZG9lcyBub3QgaXRzZWxmIHByb3ZlIGZ1bmRpbmcgb3IgZW50aXRsZW1lbnQuIGBwZXJzaXN0YCBtdXN0IHdyaXRlIHRvIHRoZVxuICogbG9jYWwgZHVyYWJsZSBzdG9yZTsgc2lnbmVycyBhbmQgc3RhdGUgbmV2ZXIgY29tZSBmcm9tIHRvb2wgYXJndW1lbnRzLlxuICpcbiAqIE9ubHkgc3RhdGUgdHJhbnNpdGlvbnMgYXJlIHNlcmlhbGl6ZWQuIEhhbmRsZXJzIHJ1biBjb25jdXJyZW50bHksIHdoaWxlXG4gKiBhc3luYyBzaWduZXJzIGNhbm5vdCByYWNlIHR3byByZXNlcnZhdGlvbnMgYWdhaW5zdCB0aGUgc2FtZSBjaGFubmVsIHNuYXBzaG90LlxuICogRXZlcnkgZW50ZXJlZCBoYW5kbGVyIGlzIG9uZSBzZXJ2ZWQgaW52b2NhdGlvbiwgaW5jbHVkaW5nIGEgdGhyb3duIGhhbmRsZXIuXG4gKi9cbmV4cG9ydCBjbGFzcyBMb2NhbE1ldGVyZWRUdXJuIHtcbiAgcHJpdmF0ZSBzdGF0ZTogTG9jYWxNZXRlcmVkVHVyblN0YXRlO1xuICBwcml2YXRlIHRhaWw6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgcHJpdmF0ZSBwZXJzaXN0ZW5jZUZhaWxlZCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgZGVwczoge1xuICAgIHN0YXRlOiBMb2NhbE1ldGVyZWRUdXJuU3RhdGU7XG4gICAgbm93TXM6ICgpID0+IG51bWJlcjtcbiAgICBzaWduVm91Y2hlcjogKGJ5dGVzOiBCdWZmZXIpID0+IFByb21pc2U8c3RyaW5nPiB8IHN0cmluZztcbiAgICBzaWduUmVjZWlwdDogKGJ5dGVzOiBCdWZmZXIsIHZvdWNoZXI/OiBDdW11bGF0aXZlUGF5bWVudFZvdWNoZXIpID0+IFByb21pc2U8c3RyaW5nPiB8IHN0cmluZztcbiAgICBwZXJzaXN0OiAoc3RhdGU6IExvY2FsTWV0ZXJlZFR1cm5TdGF0ZSkgPT4gUHJvbWlzZTx2b2lkPjtcbiAgfSkge1xuICAgIHRoaXMuc3RhdGUgPSBzdHJ1Y3R1cmVkQ2xvbmUoZGVwcy5zdGF0ZSk7XG4gICAgY29uc3QgcyA9IHRoaXMuc3RhdGU7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBkZWNsYXJlTWV0ZXIocy5tZXRlcik7XG4gICAgaWYgKCFzLnR1cm5JZC50cmltKCkgfHwgIXMucGF5ZXIudHJpbSgpIHx8ICFzLnNlbGxlci50cmltKCkgfHwgIXMucmVsZWFzZVJlZi50cmltKCkgfHxcbiAgICAgICAgIWRlY2xhcmVkLm9rIHx8ICFOdW1iZXIuaXNGaW5pdGUocy5leHBpcmVzQXRNcykgfHwgcy5jZWlsaW5nTWljcm9zIDw9IDBuIHx8XG4gICAgICAgIHMucmVzZXJ2ZWRNaWNyb3MgPCAwbiB8fCBzLnJlc2VydmVkTWljcm9zID4gcy5jZWlsaW5nTWljcm9zIHx8XG4gICAgICAgIHMuY2hhbm5lbC5lc2Nyb3dNaWNyb3MgPCAwbiB8fCBzLmNoYW5uZWwuY29tbWl0dGVkTWljcm9zIDwgMG4gfHwgcy5jaGFubmVsLmxhc3RDdW11bGF0aXZlTWljcm9zIDwgMG4gfHxcbiAgICAgICAgT2JqZWN0LnZhbHVlcyhzLmNoYW5uZWwucmVzZXJ2YXRpb25zKS5zb21lKChhbW91bnQpID0+IGFtb3VudCA8IDBuKSB8fFxuICAgICAgICBzLmNoYW5uZWwuY29tbWl0dGVkTWljcm9zICsgT2JqZWN0LnZhbHVlcyhzLmNoYW5uZWwucmVzZXJ2YXRpb25zKS5yZWR1Y2UoKHN1bSwgYW1vdW50KSA9PiBzdW0gKyBhbW91bnQsIDBuKSA+XG4gICAgICAgICAgcy5jaGFubmVsLmVzY3Jvd01pY3Jvcykge1xuICAgICAgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IoJ2ludmFsaWQtdHVybicsICdhIGxvY2FsIG1ldGVyIG5lZWRzIGEgYm91bmQgZnVuZGVkIHR1cm4gYW5kIHZhbGlkIGNlaWxpbmcnKTtcbiAgICB9XG4gICAgbGV0IHJlc2VydmVkID0gMG47XG4gICAgZm9yIChjb25zdCBbbm9uY2UsIGVudHJ5XSBvZiBPYmplY3QuZW50cmllcyhzLnVuaXRzKSkge1xuICAgICAgY29uc3QgdiA9IGVudHJ5LnZvdWNoZXI7XG4gICAgICBjb25zdCBhbW91bnQgPSBxdW90ZU1pY3JvcyhzLm1ldGVyLCB2Lm1ldGVyUXVhbnRpdHkpO1xuICAgICAgaWYgKHYudXNhZ2VOb25jZSAhPT0gbm9uY2UgfHwgdi5jaGFubmVsSWQgIT09IHMuY2hhbm5lbC5jaGFubmVsSWQgfHwgdi5wYXllciAhPT0gcy5wYXllciB8fFxuICAgICAgICAgIHYuc2VsbGVyICE9PSBzLnNlbGxlciB8fCB2LnJlbGVhc2VSZWYgIT09IHMucmVsZWFzZVJlZiB8fCB2LnByaWNlVmVyc2lvbiAhPT0gcy5tZXRlci5wcmljZVZlcnNpb24gfHxcbiAgICAgICAgICB2LnNwbGl0TWFuaWZlc3RIYXNoICE9PSBzLm1ldGVyLnNwbGl0TWFuaWZlc3RIYXNoIHx8IHYucHJpY2VQZXJVbml0TWljcm9zICE9PSBzLm1ldGVyLnVuaXRQcmljZU1pY3JvcyB8fFxuICAgICAgICAgIHYubWV0ZXJRdWFudGl0eSA8PSAwbiB8fCAhdi5zaWduYXR1cmUudHJpbSgpIHx8XG4gICAgICAgICAgKGVudHJ5LmNvbXBsZXRlZEF0TXMgIT09IG51bGwgJiYgIU51bWJlci5pc0Zpbml0ZShlbnRyeS5jb21wbGV0ZWRBdE1zKSkgfHxcbiAgICAgICAgICAoZW50cnkucmVjZWlwdFxuICAgICAgICAgICAgPyAhKG5vbmNlIGluIHMuY2hhbm5lbC5yZWNlaXB0cykgfHwgZW50cnkucmVjZWlwdC51c2FnZU5vbmNlICE9PSBub25jZSB8fFxuICAgICAgICAgICAgICBlbnRyeS5yZWNlaXB0LmNoYW5uZWxJZCAhPT0gdi5jaGFubmVsSWQgfHwgZW50cnkucmVjZWlwdC5hbW91bnRNaWNyb3MgIT09IGFtb3VudCB8fFxuICAgICAgICAgICAgICBlbnRyeS5yZWNlaXB0LnZvdWNoZXJEaWdlc3QgIT09IHBheW1lbnRWb3VjaGVyRGlnZXN0KHVuc2lnbmVkVm91Y2hlcih2KSkgfHxcbiAgICAgICAgICAgICAgIWVudHJ5LnJlY2VpcHQuc2lnbmF0dXJlLnRyaW0oKSB8fCBlbnRyeS5jb21wbGV0ZWRBdE1zID09PSBudWxsXG4gICAgICAgICAgICA6IHMuY2hhbm5lbC5yZXNlcnZhdGlvbnNbbm9uY2VdICE9PSBhbW91bnQpKSB7XG4gICAgICAgIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKCdpbnZhbGlkLXR1cm4nLCAnbG9jYWwgdHVybiBzbmFwc2hvdCBkaXNhZ3JlZXMgd2l0aCBpdHMgYm91bmQgdm91Y2hlcnMvY2hhbm5lbCcpO1xuICAgICAgfVxuICAgICAgcmVzZXJ2ZWQgKz0gYW1vdW50O1xuICAgIH1cbiAgICBpZiAocmVzZXJ2ZWQgIT09IHMucmVzZXJ2ZWRNaWNyb3MpIHtcbiAgICAgIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKCdpbnZhbGlkLXR1cm4nLCAnbG9jYWwgdHVybiByZXNlcnZhdGlvbiB0b3RhbCBkaXNhZ3JlZXMgd2l0aCBpdHMgdW5pdHMnKTtcbiAgICB9XG4gIH1cblxuICBzbmFwc2hvdCgpOiBMb2NhbE1ldGVyZWRUdXJuU3RhdGUgeyByZXR1cm4gc3RydWN0dXJlZENsb25lKHRoaXMuc3RhdGUpOyB9XG5cbiAgLyoqIFN0b3AgbmV3IGNhbGxzIGJlZm9yZSBjbG9zaW5nIG9yIHJldm9raW5nIGEgaG9zdCBhZG1pc3Npb24uIENhbGxzIGFscmVhZHlcbiAgICogZW50ZXJlZCBtdXN0IGZpbmlzaDsgdGhlaXIgZHVyYWJsZSBob2xkcyBjYW5ub3QgYmUgdHJlYXRlZCBhcyB1bnVzZWQgZnVuZHMuICovXG4gIHN0b3BBZG1pc3Npb24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMuc2VyaWFsaXplKGFzeW5jICgpID0+IHtcbiAgICAgIGlmICh0aGlzLnN0YXRlLmFkbWlzc2lvbkNsb3NlZCkgcmV0dXJuO1xuICAgICAgdGhpcy5zdGF0ZSA9IHsgLi4udGhpcy5zdGF0ZSwgYWRtaXNzaW9uQ2xvc2VkOiB0cnVlIH07XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QoKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgc2VyaWFsaXplPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICAgIGNvbnN0IG5leHQgPSB0aGlzLnRhaWwudGhlbigoKSA9PiB7XG4gICAgICBpZiAodGhpcy5wZXJzaXN0ZW5jZUZhaWxlZCkge1xuICAgICAgICB0aHJvdyBuZXcgTG9jYWxNZXRlcmVkVHVyblJlZnVzZWRFcnJvcignc3RvcmFnZS11bmF2YWlsYWJsZScsICdyZWFkIGF1dGhvcml0YXRpdmUgbG9jYWwgc3RhdGUgYmVmb3JlIHJlc3VtaW5nIHRoaXMgdHVybicpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9wZXJhdGlvbigpO1xuICAgIH0pO1xuICAgIHRoaXMudGFpbCA9IG5leHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XG4gICAgcmV0dXJuIG5leHQ7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBlcnNpc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHsgYXdhaXQgdGhpcy5kZXBzLnBlcnNpc3QodGhpcy5zbmFwc2hvdCgpKTsgfVxuICAgIGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gVGhlIHdyaXRlIG91dGNvbWUgbWF5IGJlIHVua25vd24uIEtlZXAgdGhlIHJlc2VydmF0aW9uLCBzdG9wIGFkbWlzc2lvbixcbiAgICAgIC8vIGFuZCByZXF1aXJlIGEgZHVyYWJsZSByZWFkIGluc3RlYWQgb2YgcmV0cnlpbmcgYSBwb3NzaWJseSBjb21taXR0ZWQgd3JpdGUuXG4gICAgICB0aGlzLnBlcnNpc3RlbmNlRmFpbGVkID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGludm9rZTxUPih1bml0OiBQaWNrPEJpbGxhYmxlVW5pdCwgJ3BheWVyJyB8ICdyZWxlYXNlUmVmJyB8ICd1c2FnZU5vbmNlJyB8ICdxdWFudGl0eSc+LFxuICAgIGV4ZWN1dGU6ICgpID0+IFByb21pc2U8VD4gfCBUKTogUHJvbWlzZTxUPiB7XG4gICAgYXdhaXQgdGhpcy5zZXJpYWxpemUoYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcyA9IHRoaXMuc3RhdGU7XG4gICAgICBpZiAocy5hZG1pc3Npb25DbG9zZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IoJ3R1cm4tYWRtaXNzaW9uLWNsb3NlZCcsICd0aGUgaG9zdCBoYXMgY2xvc2VkIG9yIHJldm9rZWQgdGhpcyBmdW5kZWQgdHVybicpO1xuICAgICAgfVxuICAgICAgaWYgKHVuaXQucGF5ZXIgIT09IHMucGF5ZXIgfHwgdW5pdC5yZWxlYXNlUmVmICE9PSBzLnJlbGVhc2VSZWYpIHtcbiAgICAgICAgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IoJ2JpbmRpbmctbWlzbWF0Y2gnLCAndGFyZ2V0IHBheWVyIGFuZCBpbnN0YWxsZWQgcmVsZWFzZSBtdXN0IG1hdGNoIHRoZSBmdW5kZWQgdHVybicpO1xuICAgICAgfVxuICAgICAgY29uc3Qgbm93TXMgPSB0aGlzLmRlcHMubm93TXMoKTtcbiAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG5vd01zKSB8fCBub3dNcyA+IHMuZXhwaXJlc0F0TXMpIHtcbiAgICAgICAgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IoJ2V4cGlyZWQnLCAndGhlIGZ1bmRlZCB0dXJuIGhhcyBleHBpcmVkJyk7XG4gICAgICB9XG4gICAgICBpZiAocy5yZXNlcnZlZE1pY3JvcyArIHF1b3RlTWljcm9zKHMubWV0ZXIsIHVuaXQucXVhbnRpdHkpID4gcy5jZWlsaW5nTWljcm9zKSB7XG4gICAgICAgIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKCdjYXAtZXhoYXVzdGVkJywgJ3RoaXMgaW52b2NhdGlvbiBleGNlZWRzIHRoZSBmdW5kZWQgcGVyLXR1cm4gY2VpbGluZycpO1xuICAgICAgfVxuICAgICAgY29uc3QgYm91bmQ6IEJpbGxhYmxlVW5pdCA9IHsgLi4udW5pdCwgc2VsbGVyOiBzLnNlbGxlciwgZXhwaXJlc0F0TXM6IHMuZXhwaXJlc0F0TXMgfTtcbiAgICAgIC8vIENhcHR1cmUgY2Fub25pY2FsIHNpZ25pbmcgYnl0ZXMgd2l0aCB0aGUgcHVyZSBjb3JlIGJlZm9yZSBhc3luYyBzaWduaW5nLlxuICAgICAgbGV0IGJ5dGVzOiBCdWZmZXIgfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBwcm9iZSA9IG9wZW5NZXRlcmVkSW52b2NhdGlvbih7IGNoYW5uZWw6IHMuY2hhbm5lbCwgbWV0ZXI6IHMubWV0ZXIsIHVuaXQ6IGJvdW5kLCBub3dNcyxcbiAgICAgICAgc2lnblZvdWNoZXI6ICh2YWx1ZSkgPT4geyBieXRlcyA9IHZhbHVlOyByZXR1cm4gJ3NpZ25pbmctcHJvYmUnOyB9IH0pO1xuICAgICAgaWYgKCFwcm9iZS5vaykgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IocHJvYmUuY29kZSwgcHJvYmUuZGV0YWlsKTtcbiAgICAgIGNvbnN0IHNpZ25hdHVyZSA9IGF3YWl0IHRoaXMuZGVwcy5zaWduVm91Y2hlcihieXRlcyEpO1xuICAgICAgY29uc3Qgc2lnbmVkQXRNcyA9IHRoaXMuZGVwcy5ub3dNcygpO1xuICAgICAgY29uc3Qgb3BlbmVkID0gb3Blbk1ldGVyZWRJbnZvY2F0aW9uKHsgY2hhbm5lbDogcy5jaGFubmVsLCBtZXRlcjogcy5tZXRlciwgdW5pdDogYm91bmQsIG5vd01zOiBzaWduZWRBdE1zLFxuICAgICAgICBzaWduVm91Y2hlcjogKCkgPT4gc2lnbmF0dXJlIH0pO1xuICAgICAgaWYgKCFvcGVuZWQub2spIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKG9wZW5lZC5jb2RlLCBvcGVuZWQuZGV0YWlsKTtcbiAgICAgIHRoaXMuc3RhdGUgPSB7IC4uLnMsIGNoYW5uZWw6IG9wZW5lZC5jaGFubmVsLCByZXNlcnZlZE1pY3Jvczogcy5yZXNlcnZlZE1pY3JvcyArIG9wZW5lZC5yZXNlcnZlZE1pY3JvcyxcbiAgICAgICAgdW5pdHM6IHsgLi4ucy51bml0cywgW3VuaXQudXNhZ2VOb25jZV06IHsgdm91Y2hlcjogb3BlbmVkLnZvdWNoZXIsIGNvbXBsZXRlZEF0TXM6IG51bGwsIHJlY2VpcHQ6IG51bGwgfSB9IH07XG4gICAgICBhd2FpdCB0aGlzLnBlcnNpc3QoKTtcbiAgICB9KTtcbiAgICB0cnkgeyByZXR1cm4gYXdhaXQgZXhlY3V0ZSgpOyB9XG4gICAgZmluYWxseSB7XG4gICAgICBhd2FpdCB0aGlzLnNlcmlhbGl6ZShhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gdGhpcy5zdGF0ZS51bml0c1t1bml0LnVzYWdlTm9uY2VdITtcbiAgICAgICAgY29uc3QgY29tcGxldGVkQXRNcyA9IHRoaXMuZGVwcy5ub3dNcygpO1xuICAgICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjb21wbGV0ZWRBdE1zKSkge1xuICAgICAgICAgIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKCdpbnZhbGlkLXVuaXQnLCAnY29tcGxldGlvbiB0aW1lIG11c3QgYmUgZmluaXRlJyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5zdGF0ZSA9IHsgLi4udGhpcy5zdGF0ZSwgdW5pdHM6IHsgLi4udGhpcy5zdGF0ZS51bml0cyxcbiAgICAgICAgICBbdW5pdC51c2FnZU5vbmNlXTogeyAuLi5lbnRyeSwgY29tcGxldGVkQXRNcyB9IH0gfTtcbiAgICAgICAgYXdhaXQgdGhpcy5wZXJzaXN0KCk7XG4gICAgICAgIGF3YWl0IHRoaXMuc2V0dGxlKHVuaXQudXNhZ2VOb25jZSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvKiogUmVjb3ZlciBhIGNvbXBsZXRlZCBjYWxsJ3Mgc2V0dGxlbWVudDsgbmV2ZXIgcmUtZW50ZXIgaXRzIGhhbmRsZXIuICovXG4gIHJldHJ5U2V0dGxlbWVudCh1c2FnZU5vbmNlOiBzdHJpbmcpOiBQcm9taXNlPFNpZ25lZFVzYWdlUmVjZWlwdD4ge1xuICAgIHJldHVybiB0aGlzLnNlcmlhbGl6ZSgoKSA9PiB0aGlzLnNldHRsZSh1c2FnZU5vbmNlKSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNldHRsZSh1c2FnZU5vbmNlOiBzdHJpbmcpOiBQcm9taXNlPFNpZ25lZFVzYWdlUmVjZWlwdD4ge1xuICAgIGNvbnN0IHMgPSB0aGlzLnN0YXRlO1xuICAgIGNvbnN0IGVudHJ5ID0gcy51bml0c1t1c2FnZU5vbmNlXTtcbiAgICBpZiAoIWVudHJ5IHx8IGVudHJ5LmNvbXBsZXRlZEF0TXMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKCd1bmtub3duLXJlc2VydmF0aW9uJywgJ29ubHkgYSByZWNvcmRlZCBjb21wbGV0ZWQgaW52b2NhdGlvbiBtYXkgc2V0dGxlJyk7XG4gICAgfVxuICAgIGlmIChlbnRyeS5yZWNlaXB0KSByZXR1cm4gc3RydWN0dXJlZENsb25lKGVudHJ5LnJlY2VpcHQpO1xuICAgIGxldCBieXRlczogQnVmZmVyIHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHByb2JlID0gY2xvc2VNZXRlcmVkSW52b2NhdGlvbih7IGNoYW5uZWw6IHMuY2hhbm5lbCwgdm91Y2hlcjogZW50cnkudm91Y2hlcixcbiAgICAgIG9jY3VycmVkQXRNczogZW50cnkuY29tcGxldGVkQXRNcywgc2lnblJlY2VpcHQ6ICh2YWx1ZSkgPT4geyBieXRlcyA9IHZhbHVlOyByZXR1cm4gJ3NpZ25pbmctcHJvYmUnOyB9IH0pO1xuICAgIGlmICghcHJvYmUub2spIHRocm93IG5ldyBMb2NhbE1ldGVyZWRUdXJuUmVmdXNlZEVycm9yKHByb2JlLmNvZGUsIHByb2JlLmRldGFpbCk7XG4gICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgdGhpcy5kZXBzLnNpZ25SZWNlaXB0KGJ5dGVzISwgZW50cnkudm91Y2hlcik7XG4gICAgY29uc3QgY2xvc2VkID0gY2xvc2VNZXRlcmVkSW52b2NhdGlvbih7IGNoYW5uZWw6IHMuY2hhbm5lbCwgdm91Y2hlcjogZW50cnkudm91Y2hlcixcbiAgICAgIG9jY3VycmVkQXRNczogZW50cnkuY29tcGxldGVkQXRNcywgc2lnblJlY2VpcHQ6ICgpID0+IHNpZ25hdHVyZSB9KTtcbiAgICBpZiAoIWNsb3NlZC5vaykgdGhyb3cgbmV3IExvY2FsTWV0ZXJlZFR1cm5SZWZ1c2VkRXJyb3IoY2xvc2VkLmNvZGUsIGNsb3NlZC5kZXRhaWwpO1xuICAgIHRoaXMuc3RhdGUgPSB7IC4uLnMsIGNoYW5uZWw6IGNsb3NlZC5jaGFubmVsLFxuICAgICAgdW5pdHM6IHsgLi4ucy51bml0cywgW3VzYWdlTm9uY2VdOiB7IC4uLmVudHJ5LCByZWNlaXB0OiBjbG9zZWQucmVjZWlwdCB9IH0gfTtcbiAgICBhd2FpdCB0aGlzLnBlcnNpc3QoKTtcbiAgICByZXR1cm4gc3RydWN0dXJlZENsb25lKGNsb3NlZC5yZWNlaXB0KTtcbiAgfVxufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9wMnAvbWV0ZXJlZC1pbnZvY2F0aW9uLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvcDJwL21ldGVyZWQtaW52b2NhdGlvbi50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL3BhY2thZ2VzL29wZXJhdG9yLWNvcmUvbGliL3AycC9tZXRlcmVkLWludm9jYXRpb24udHMiLFtdXQ==
}}