__vite_ssr_exportName__("STRIPE_PROVIDER", () => { try { return STRIPE_PROVIDER } catch {} });
__vite_ssr_exportName__("STRIPE_SIGNATURE_HEADER", () => { try { return STRIPE_SIGNATURE_HEADER } catch {} });
__vite_ssr_exportName__("STRIPE_DEFAULT_TOLERANCE_SEC", () => { try { return STRIPE_DEFAULT_TOLERANCE_SEC } catch {} });
__vite_ssr_exportName__("parseStripeSignatureHeader", () => { try { return parseStripeSignatureHeader } catch {} });
__vite_ssr_exportName__("computeStripeSignature", () => { try { return computeStripeSignature } catch {} });
__vite_ssr_exportName__("createStripeAdapter", () => { try { return createStripeAdapter } catch {} });
__vite_ssr_exportName__("buildStripeCheckoutSessionParams", () => { try { return buildStripeCheckoutSessionParams } catch {} });
__vite_ssr_exportName__("STRIPE_CHECKOUT_SESSIONS_URL", () => { try { return STRIPE_CHECKOUT_SESSIONS_URL } catch {} });
__vite_ssr_exportName__("encodeStripeFormParams", () => { try { return encodeStripeFormParams } catch {} });
__vite_ssr_exportName__("postStripeForm", () => { try { return postStripeForm } catch {} });
__vite_ssr_exportName__("createStripeCheckoutSession", () => { try { return createStripeCheckoutSession } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHmac","timingSafeEqual"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/webhook-inbox.ts", {"importedNames":["headerLookup"]});


const STRIPE_PROVIDER = "stripe";
const STRIPE_SIGNATURE_HEADER = "stripe-signature";
const STRIPE_DEFAULT_TOLERANCE_SEC = 300;
function parseStripeSignatureHeader(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      timestamp = n;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  };
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
};
function computeStripeSignature(secret, timestamp, rawBody) {
  return (0,__vite_ssr_import_0__.createHmac)("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
};
function verifyStripeSignature(options, request) {
  if (!options.webhookSecret) return { ok: false, code: "missing-secret", detail: "stripe webhook secret is not configured" };
  const header = (0,__vite_ssr_import_1__.headerLookup)(request.headers, STRIPE_SIGNATURE_HEADER);
  if (!header) return { ok: false, code: "missing-signature", detail: `${STRIPE_SIGNATURE_HEADER} header is absent` };
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return { ok: false, code: "malformed-signature", detail: `${STRIPE_SIGNATURE_HEADER} header lacks t= or a v1= signature` };
  const expected = Buffer.from(computeStripeSignature(options.webhookSecret, parsed.timestamp, request.rawBody), "hex");
  const matched = parsed.signatures.some((s2) => {
    const candidate = Buffer.from(s2, "hex");
    return candidate.length === expected.length && (0,__vite_ssr_import_0__.timingSafeEqual)(candidate, expected);
  });
  if (!matched) return { ok: false, code: "bad-signature", detail: "no v1 signature matches the endpoint secret" };
  const tolerance = options.toleranceSec ?? STRIPE_DEFAULT_TOLERANCE_SEC;
  if (Math.abs(Math.floor(request.nowMs / 1e3) - parsed.timestamp) > tolerance) return { ok: false, code: "stale-timestamp", detail: `signature timestamp is outside the ${tolerance}s tolerance` };
  return { ok: true };
}
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const s = (o, key) => typeof o[key] === "string" && o[key].trim() ? o[key] : null;
const metadata = (o) => isObj(o.metadata) ? o.metadata : {};
function money(o, amountKey) {
  const amount = o[amountKey];
  const currency = o.currency;
  if (!Number.isSafeInteger(amount) || amount < 0 || typeof currency !== "string" || !/^[a-z]{3}$/i.test(currency)) return null;
  return { amountMinor: amount, currency: currency.toUpperCase() };
}
function orderRef(o) {
  return s(metadata(o), "orderId") ?? s(o, "client_reference_id");
}
function normalizeStripeEvent(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: "malformed-body", detail: "body is not JSON", providerEventId: null };
  };
  if (!isObj(parsed)) return { ok: false, code: "malformed-body", detail: "event must be an object", providerEventId: null };
  const evt = parsed;
  const id = typeof evt.id === "string" && evt.id.trim() ? evt.id : null;
  const type = typeof evt.type === "string" ? evt.type : null;
  const created = typeof evt.created === "number" && Number.isFinite(evt.created) && evt.created >= 0 ? evt.created : null;
  const object = evt.data && isObj(evt.data.object) ? evt.data.object : null;
  if (!id || !type || created === null || !object) return { ok: false, code: "malformed-body", detail: "event needs id, type, created and data.object", providerEventId: id };
  const occurredAtMs = created * 1e3;
  const source = { provider: STRIPE_PROVIDER, providerEventId: id };
  const events = [];
  const emit = (kind, payload) => {
    events.push({ ledgerEventId: `stripe:${id}:${events.length}`, kind, occurredAtMs, source, payload });
  };
  const missingOrder = () => ({ ok: false, code: "missing-order-ref", detail: `${type} carries no metadata.orderId / client_reference_id`, providerEventId: id });
  const invalidAmount = () => ({ ok: false, code: "invalid-amount", detail: `${type} amount/currency is not an integer minor-unit amount`, providerEventId: id });
  switch (type) {
    case "checkout.session.completed": {
      if (object.payment_status !== "paid") break;
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, "amount_total");
      if (!amount) return invalidAmount();
      emit("order.paid", { orderId, amount, providerRef: s(object, "payment_intent") ?? s(object, "id") });
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, "amount_total");
      if (!amount) return invalidAmount();
      emit("order.paid", { orderId, amount, providerRef: s(object, "payment_intent") ?? s(object, "id") });
      break;
    }
    case "checkout.session.async_payment_failed":
    case "payment_intent.payment_failed": {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      emit("order.failed", { orderId, providerRef: s(object, "id") });
      break;
    }
    case "checkout.session.expired": {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      emit("order.canceled", { orderId, providerRef: s(object, "id") });
      break;
    }
    case "charge.refunded": {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const refundsList = isObj(object.refunds) && Array.isArray(object.refunds.data) ? object.refunds.data : null;
      if (refundsList && refundsList.length) {
        for (const r of refundsList) {
          if (!isObj(r)) continue;
          if (r.status !== "succeeded") continue;
          const refundId = s(r, "id");
          const amount = money(r, "amount");
          if (!refundId || !amount) return invalidAmount();
          emit("refund.succeeded", { refundId, orderId, amount, providerRef: refundId });
        }
      } else {
        const amount = money(object, "amount_refunded");
        const chargeId = s(object, "id");
        if (!amount || !chargeId) return invalidAmount();
        emit("refund.succeeded", { refundId: `${chargeId}:refund`, orderId, amount, providerRef: chargeId });
      };
      break;
    }
    case "charge.refund.updated":
    case "refund.updated":
    case "refund.failed": {
      const refundId = s(object, "id");
      if (!refundId) return { ok: false, code: "malformed-body", detail: `${type} refund object has no id`, providerEventId: id };
      const orderId = orderRef(object);
      const status = object.status;
      if (status === "failed" || status === "canceled") emit("refund.failed", { refundId, ...orderId ? { orderId } : {} });
      else if (status === "succeeded") {
        if (!orderId) return missingOrder();
        const amount = money(object, "amount");
        if (!amount) return invalidAmount();
        emit("refund.succeeded", { refundId, orderId, amount, providerRef: refundId });
      };
      break;
    }
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const disputeId = s(object, "id");
      if (!disputeId) {
        return {
          ok: false,
          code: "malformed-body",
          detail: `${type} dispute object has no id`,
          providerEventId: id
        };
      };
      const status = s(object, "status");
      const reverses = type === "charge.dispute.created" || type === "charge.dispute.funds_withdrawn" || status === "lost";
      if (!reverses) break;
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, "amount");
      if (!amount) return invalidAmount();
      emit("refund.succeeded", {
        refundId: `dispute:${disputeId}`,
        orderId,
        amount,
        providerRef: disputeId,
        reversalReason: "chargeback"
      });
      break;
    }
    case "payout.created":
    case "payout.paid":
    case "payout.failed": {
      const payoutId = s(object, "id");
      const creatorId = s(metadata(object), "creatorId") ?? s(object, "destination");
      const amount = money(object, "amount");
      if (!payoutId) return { ok: false, code: "malformed-body", detail: `${type} payout object has no id`, providerEventId: id };
      if (!amount) return invalidAmount();
      if (type === "payout.created") {
        if (!creatorId) return { ok: false, code: "missing-order-ref", detail: "payout.created carries no metadata.creatorId / destination", providerEventId: id };
        emit("payout.created", { payoutId, creatorId, amount, providerRef: payoutId });
      } else emit(type === "payout.paid" ? "payout.paid" : "payout.failed", { payoutId, providerRef: payoutId });
      break;
    }
    default:
      break;
  };
  return { ok: true, webhook: { providerEventId: id, providerEventType: type, occurredAtMs, events } };
}
function createStripeAdapter(options) {
  return {
    provider: STRIPE_PROVIDER,
    verifySignature: (request) => verifyStripeSignature(options, request),
    normalize: (rawBody) => normalizeStripeEvent(rawBody)
  };
};
function buildStripeCheckoutSessionParams(input) {
  const { order, offer, product } = input;
  if (offer.pricingModel === "free" || offer.pricingModel === "per-use") return { ok: false, code: "unsupported-pricing-model", detail: `${offer.pricingModel} offers do not go through Checkout` };
  if (order.amount.amountMinor !== offer.price.amountMinor || order.amount.currency !== offer.price.currency) return { ok: false, code: "amount-mismatch", detail: "order amount differs from the offer price" };
  if (order.amount.amountMinor === 0) return { ok: false, code: "zero-amount", detail: "Checkout requires a positive amount" };
  const purchaseMetadata = {
    orderId: order.orderId,
    offerId: offer.offerId,
    productId: product.productId,
    buyerId: order.buyerId,
    skuRef: product.skuRef
  };
  const priceData = {
    currency: order.amount.currency.toLowerCase(),
    unit_amount: order.amount.amountMinor,
    product_data: { name: product.title, metadata: { skuRef: product.skuRef, productId: product.productId } }
  };
  if (offer.pricingModel === "subscription") priceData.recurring = { interval: "month" };
  return {
    ok: true,
    params: {
      mode: offer.pricingModel === "subscription" ? "subscription" : "payment",
      client_reference_id: order.orderId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: [{ quantity: 1, price_data: priceData }],
      // Stripe enables Managed Payments by default on new accounts, and under it
      // EVERY line item must carry a product tax code — which an ad-hoc
      // `price_data` product cannot have, so the account default alone made every
      // Checkout Session here a hard 400 ("the product tax code is missing").
      // Measured against the live test-mode account 2026-09-06 (P-038).
      //
      // Disabling it is the CORRECT answer, not merely the smaller one: under
      // Managed Payments Stripe becomes merchant of record and owns settlement,
      // which is precisely what this system does NOT want — the DAO's own split
      // manifest and settlement batches (P-033/P-034) distribute the proceeds, and
      // that only works on a direct charge into our own balance. Setting some tax
      // code instead would have silently handed payouts to a different rail.
      managed_payments: { enabled: false },
      metadata: purchaseMetadata,
      // Charges/disputes are downstream of the PaymentIntent, not the Checkout
      // Session. Copy the complete purchase identity so a chargeback can still
      // resolve the principal and top-up SKU without an address inference.
      payment_intent_data: offer.pricingModel === "one-time" ? { metadata: purchaseMetadata } : void 0
    }
  };
};
const STRIPE_CHECKOUT_SESSIONS_URL = "https://api.stripe.com/v1/checkout/sessions";
function encodeStripeFormParams(params) {
  const out = new URLSearchParams();
  const walk = (prefix, value) => {
    if (value === void 0 || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
      return;
    };
    if (typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(`${prefix}[${key}]`, inner);
      return;
    };
    out.append(prefix, String(value));
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out;
};
async function postStripeForm(input) {
  const headers = {
    authorization: `Bearer ${input.secretKey}`,
    "content-type": "application/x-www-form-urlencoded"
  };
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
  let response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers,
      body: encodeStripeFormParams(input.params).toString()
    });
  } catch (err) {
    return { ok: false, code: "provider-error", status: null, detail: err instanceof Error ? err.message : String(err) };
  };
  const text = await response.text();
  if (!response.ok) {
    let detail = `stripe responded ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error?.message === "string") detail = parsed.error.message;
    } catch {
    };
    return { ok: false, code: "provider-error", status: response.status, detail };
  };
  let parsedBody;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed-response", status: response.status, detail: "stripe response was not JSON" };
  };
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody : {};
  return { ok: true, status: response.status, body };
};
async function createStripeCheckoutSession(input) {
  const posted = await postStripeForm({ ...input, url: STRIPE_CHECKOUT_SESSIONS_URL });
  if (!posted.ok) return posted;
  const response = { status: posted.status };
  const parsed = posted.body;
  if (typeof parsed.id !== "string" || !parsed.id) {
    return { ok: false, code: "malformed-response", status: response.status, detail: "stripe response carried no session id" };
  };
  if (typeof parsed.url !== "string" || !parsed.url) {
    return { ok: false, code: "malformed-response", status: response.status, detail: "stripe response carried no checkout url" };
  };
  return { ok: true, sessionId: parsed.id, url: parsed.url };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFNLFNBQVMsTUFBTSxlQUFlLEVBQUUsR0FBRyxPQUFPLEtBQUssNkJBQTZCLENBQUM7QUFDbkYsTUFBSSxDQUFDLE9BQU8sR0FBSSxRQUFPO0FBQ3ZCLFFBQU0sV0FBVyxFQUFFLFFBQVEsT0FBTyxPQUFPO0FBQ3pDLFFBQU0sU0FBUyxPQUFPO0FBQ3RCLE1BQUksT0FBTyxPQUFPLE9BQU8sWUFBWSxDQUFDLE9BQU8sSUFBSTtBQUMvQyxXQUFPLEVBQUUsSUFBSSxPQUFPLE1BQU0sc0JBQXNCLFFBQVEsU0FBUyxRQUFRLFFBQVEsd0NBQXdDO0FBQUEsRUFDM0g7QUFDQSxNQUFJLE9BQU8sT0FBTyxRQUFRLFlBQVksQ0FBQyxPQUFPLEtBQUs7QUFDakQsV0FBTyxFQUFFLElBQUksT0FBTyxNQUFNLHNCQUFzQixRQUFRLFNBQVMsUUFBUSxRQUFRLDBDQUEwQztBQUFBLEVBQzdIO0FBQ0EsU0FBTyxFQUFFLElBQUksTUFBTSxXQUFXLE9BQU8sSUFBSSxLQUFLLE9BQU8sSUFBSTtBQUMzRCIsIm5hbWVzIjpbInMiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsic3RyaXBlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU3RyaXBlIOKAlCB0aGUgZmlyc3QgYFBheW1lbnRQcm92aWRlckFkYXB0ZXJgIChQLTAxMCkuXG4gKlxuICogRGVsaWJlcmF0ZWx5IFNESy1mcmVlOiB3ZWJob29rIHNpZ25hdHVyZSB2ZXJpZmljYXRpb24gaXMgU3RyaXBlJ3MgZG9jdW1lbnRlZFxuICogc2NoZW1lIChITUFDLVNIQTI1NiBvdmVyIGAke3R9LiR7cmF3Qm9keX1gIHdpdGggdGhlIGVuZHBvaW50IHNlY3JldCwgYHYxPWBcbiAqIHNpZ25hdHVyZXMgaW4gdGhlIGBTdHJpcGUtU2lnbmF0dXJlYCBoZWFkZXIsIGEgdGltZXN0YW1wIHRvbGVyYW5jZSksIGFuZCBldmVudFxuICogbm9ybWFsaXphdGlvbiByZWFkcyB0aGUgZG9jdW1lbnRlZCBldmVudC9vYmplY3Qgc2hhcGVzLiBOb3RoaW5nIG91dHNpZGUgdGhpc1xuICogZmlsZSBrbm93cyBhIFN0cmlwZSBmaWVsZCBuYW1lOyB0aGUgbGVkZ2VyIHNlZXMgcHJvdmlkZXItbmV1dHJhbCBldmVudHMgd2hvc2VcbiAqIGBzb3VyY2UucHJvdmlkZXJgIGlzIGAnc3RyaXBlJ2AuXG4gKlxuICogT3JkZXIgaWRlbnRpdHkgY3Jvc3NlcyB0aGUgcHJvdmlkZXIgYm91bmRhcnkgdGhyb3VnaCBDaGVja291dCBTZXNzaW9uXG4gKiBgY2xpZW50X3JlZmVyZW5jZV9pZGAgLyBgbWV0YWRhdGEub3JkZXJJZGAgKHNldCBieSBgYnVpbGRTdHJpcGVDaGVja291dFNlc3Npb25QYXJhbXNgKVxuICogYW5kIGlzIHByb3BhZ2F0ZWQgYnkgU3RyaXBlIG9udG8gdGhlIFBheW1lbnRJbnRlbnQvQ2hhcmdlIG1ldGFkYXRhLlxuICovXG5pbXBvcnQgeyBjcmVhdGVIbWFjLCB0aW1pbmdTYWZlRXF1YWwgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgdHlwZSB7IExlZGdlckV2ZW50LCBNb25leSwgT2ZmZXIsIE9yZGVyLCBQcm9kdWN0IH0gZnJvbSAnLi4vY29tbWVyY2UtbGVkZ2VyJztcbmltcG9ydCB7IGhlYWRlckxvb2t1cCwgdHlwZSBOb3JtYWxpemVWZXJkaWN0LCB0eXBlIFBheW1lbnRQcm92aWRlckFkYXB0ZXIsIHR5cGUgU2lnbmF0dXJlVmVyZGljdCwgdHlwZSBXZWJob29rUmVxdWVzdCB9IGZyb20gJy4uL3dlYmhvb2staW5ib3gnO1xuXG5leHBvcnQgY29uc3QgU1RSSVBFX1BST1ZJREVSID0gJ3N0cmlwZSc7XG5leHBvcnQgY29uc3QgU1RSSVBFX1NJR05BVFVSRV9IRUFERVIgPSAnc3RyaXBlLXNpZ25hdHVyZSc7XG5leHBvcnQgY29uc3QgU1RSSVBFX0RFRkFVTFRfVE9MRVJBTkNFX1NFQyA9IDMwMDtcblxuZXhwb3J0IGludGVyZmFjZSBTdHJpcGVBZGFwdGVyT3B0aW9ucyB7XG4gIC8qKiBUaGUgZW5kcG9pbnQncyBzaWduaW5nIHNlY3JldCAoYHdoc2VjX+KApmApLiBOZXZlciBhIHRyZWUgZmlsZSDigJQgaW5qZWN0ZWQgY29uZmlnLiAqL1xuICByZWFkb25seSB3ZWJob29rU2VjcmV0OiBzdHJpbmc7XG4gIC8qKiBNYXggfG5vdyDiiJIgdHwgYWNjZXB0ZWQsIGluIHNlY29uZHMgKFN0cmlwZSdzIG93biBkZWZhdWx0IGlzIDMwMCkuICovXG4gIHJlYWRvbmx5IHRvbGVyYW5jZVNlYz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3RyaXBlU2lnbmF0dXJlSGVhZGVyKGhlYWRlcjogc3RyaW5nKTogeyB0aW1lc3RhbXA6IG51bWJlcjsgc2lnbmF0dXJlczogc3RyaW5nW10gfSB8IG51bGwge1xuICBsZXQgdGltZXN0YW1wOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2lnbmF0dXJlczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBwYXJ0IG9mIGhlYWRlci5zcGxpdCgnLCcpKSB7XG4gICAgY29uc3QgZXEgPSBwYXJ0LmluZGV4T2YoJz0nKTtcbiAgICBpZiAoZXEgPD0gMCkgY29udGludWU7XG4gICAgY29uc3Qga2V5ID0gcGFydC5zbGljZSgwLCBlcSkudHJpbSgpO1xuICAgIGNvbnN0IHZhbHVlID0gcGFydC5zbGljZShlcSArIDEpLnRyaW0oKTtcbiAgICBpZiAoa2V5ID09PSAndCcpIHtcbiAgICAgIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihuKSB8fCBuIDwgMCkgcmV0dXJuIG51bGw7XG4gICAgICB0aW1lc3RhbXAgPSBuO1xuICAgIH0gZWxzZSBpZiAoa2V5ID09PSAndjEnICYmIC9eWzAtOWEtZl17NjR9JC9pLnRlc3QodmFsdWUpKSBzaWduYXR1cmVzLnB1c2godmFsdWUudG9Mb3dlckNhc2UoKSk7XG4gIH1cbiAgaWYgKHRpbWVzdGFtcCA9PT0gbnVsbCB8fCBzaWduYXR1cmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHRpbWVzdGFtcCwgc2lnbmF0dXJlcyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZVN0cmlwZVNpZ25hdHVyZShzZWNyZXQ6IHN0cmluZywgdGltZXN0YW1wOiBudW1iZXIsIHJhd0JvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIbWFjKCdzaGEyNTYnLCBzZWNyZXQpLnVwZGF0ZShgJHt0aW1lc3RhbXB9LiR7cmF3Qm9keX1gLCAndXRmOCcpLmRpZ2VzdCgnaGV4Jyk7XG59XG5cbmZ1bmN0aW9uIHZlcmlmeVN0cmlwZVNpZ25hdHVyZShvcHRpb25zOiBTdHJpcGVBZGFwdGVyT3B0aW9ucywgcmVxdWVzdDogV2ViaG9va1JlcXVlc3QpOiBTaWduYXR1cmVWZXJkaWN0IHtcbiAgaWYgKCFvcHRpb25zLndlYmhvb2tTZWNyZXQpIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21pc3Npbmctc2VjcmV0JywgZGV0YWlsOiAnc3RyaXBlIHdlYmhvb2sgc2VjcmV0IGlzIG5vdCBjb25maWd1cmVkJyB9O1xuICBjb25zdCBoZWFkZXIgPSBoZWFkZXJMb29rdXAocmVxdWVzdC5oZWFkZXJzLCBTVFJJUEVfU0lHTkFUVVJFX0hFQURFUik7XG4gIGlmICghaGVhZGVyKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdtaXNzaW5nLXNpZ25hdHVyZScsIGRldGFpbDogYCR7U1RSSVBFX1NJR05BVFVSRV9IRUFERVJ9IGhlYWRlciBpcyBhYnNlbnRgIH07XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlU3RyaXBlU2lnbmF0dXJlSGVhZGVyKGhlYWRlcik7XG4gIGlmICghcGFyc2VkKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdtYWxmb3JtZWQtc2lnbmF0dXJlJywgZGV0YWlsOiBgJHtTVFJJUEVfU0lHTkFUVVJFX0hFQURFUn0gaGVhZGVyIGxhY2tzIHQ9IG9yIGEgdjE9IHNpZ25hdHVyZWAgfTtcbiAgY29uc3QgZXhwZWN0ZWQgPSBCdWZmZXIuZnJvbShjb21wdXRlU3RyaXBlU2lnbmF0dXJlKG9wdGlvbnMud2ViaG9va1NlY3JldCwgcGFyc2VkLnRpbWVzdGFtcCwgcmVxdWVzdC5yYXdCb2R5KSwgJ2hleCcpO1xuICBjb25zdCBtYXRjaGVkID0gcGFyc2VkLnNpZ25hdHVyZXMuc29tZSgocykgPT4ge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IEJ1ZmZlci5mcm9tKHMsICdoZXgnKTtcbiAgICByZXR1cm4gY2FuZGlkYXRlLmxlbmd0aCA9PT0gZXhwZWN0ZWQubGVuZ3RoICYmIHRpbWluZ1NhZmVFcXVhbChjYW5kaWRhdGUsIGV4cGVjdGVkKTtcbiAgfSk7XG4gIGlmICghbWF0Y2hlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnYmFkLXNpZ25hdHVyZScsIGRldGFpbDogJ25vIHYxIHNpZ25hdHVyZSBtYXRjaGVzIHRoZSBlbmRwb2ludCBzZWNyZXQnIH07XG4gIGNvbnN0IHRvbGVyYW5jZSA9IG9wdGlvbnMudG9sZXJhbmNlU2VjID8/IFNUUklQRV9ERUZBVUxUX1RPTEVSQU5DRV9TRUM7XG4gIGlmIChNYXRoLmFicyhNYXRoLmZsb29yKHJlcXVlc3Qubm93TXMgLyAxMDAwKSAtIHBhcnNlZC50aW1lc3RhbXApID4gdG9sZXJhbmNlKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdzdGFsZS10aW1lc3RhbXAnLCBkZXRhaWw6IGBzaWduYXR1cmUgdGltZXN0YW1wIGlzIG91dHNpZGUgdGhlICR7dG9sZXJhbmNlfXMgdG9sZXJhbmNlYCB9O1xuICByZXR1cm4geyBvazogdHJ1ZSB9O1xufVxuXG5pbnRlcmZhY2UgU3RyaXBlRXZlbnRTaGFwZSB7XG4gIGlkPzogdW5rbm93bjtcbiAgdHlwZT86IHVua25vd247XG4gIGNyZWF0ZWQ/OiB1bmtub3duO1xuICBkYXRhPzogeyBvYmplY3Q/OiB1bmtub3duIH07XG59XG5cbnR5cGUgT2JqID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5jb25zdCBpc09iaiA9ICh2OiB1bmtub3duKTogdiBpcyBPYmogPT4gISF2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheSh2KTtcbmNvbnN0IHMgPSAobzogT2JqLCBrZXk6IHN0cmluZyk6IHN0cmluZyB8IG51bGwgPT4gKHR5cGVvZiBvW2tleV0gPT09ICdzdHJpbmcnICYmIChvW2tleV0gYXMgc3RyaW5nKS50cmltKCkgPyAob1trZXldIGFzIHN0cmluZykgOiBudWxsKTtcbmNvbnN0IG1ldGFkYXRhID0gKG86IE9iaik6IE9iaiA9PiAoaXNPYmooby5tZXRhZGF0YSkgPyBvLm1ldGFkYXRhIDoge30pO1xuXG5mdW5jdGlvbiBtb25leShvOiBPYmosIGFtb3VudEtleTogc3RyaW5nKTogTW9uZXkgfCBudWxsIHtcbiAgY29uc3QgYW1vdW50ID0gb1thbW91bnRLZXldO1xuICBjb25zdCBjdXJyZW5jeSA9IG8uY3VycmVuY3k7XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoYW1vdW50KSB8fCAoYW1vdW50IGFzIG51bWJlcikgPCAwIHx8IHR5cGVvZiBjdXJyZW5jeSAhPT0gJ3N0cmluZycgfHwgIS9eW2Etel17M30kL2kudGVzdChjdXJyZW5jeSkpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhbW91bnRNaW5vcjogYW1vdW50IGFzIG51bWJlciwgY3VycmVuY3k6IGN1cnJlbmN5LnRvVXBwZXJDYXNlKCkgfTtcbn1cblxuZnVuY3Rpb24gb3JkZXJSZWYobzogT2JqKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzKG1ldGFkYXRhKG8pLCAnb3JkZXJJZCcpID8/IHMobywgJ2NsaWVudF9yZWZlcmVuY2VfaWQnKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RyaXBlRXZlbnQocmF3Qm9keTogc3RyaW5nKTogTm9ybWFsaXplVmVyZGljdCB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShyYXdCb2R5KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnbWFsZm9ybWVkLWJvZHknLCBkZXRhaWw6ICdib2R5IGlzIG5vdCBKU09OJywgcHJvdmlkZXJFdmVudElkOiBudWxsIH07XG4gIH1cbiAgaWYgKCFpc09iaihwYXJzZWQpKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdtYWxmb3JtZWQtYm9keScsIGRldGFpbDogJ2V2ZW50IG11c3QgYmUgYW4gb2JqZWN0JywgcHJvdmlkZXJFdmVudElkOiBudWxsIH07XG4gIGNvbnN0IGV2dCA9IHBhcnNlZCBhcyBTdHJpcGVFdmVudFNoYXBlO1xuICBjb25zdCBpZCA9IHR5cGVvZiBldnQuaWQgPT09ICdzdHJpbmcnICYmIGV2dC5pZC50cmltKCkgPyBldnQuaWQgOiBudWxsO1xuICBjb25zdCB0eXBlID0gdHlwZW9mIGV2dC50eXBlID09PSAnc3RyaW5nJyA/IGV2dC50eXBlIDogbnVsbDtcbiAgY29uc3QgY3JlYXRlZCA9IHR5cGVvZiBldnQuY3JlYXRlZCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGV2dC5jcmVhdGVkKSAmJiBldnQuY3JlYXRlZCA+PSAwID8gZXZ0LmNyZWF0ZWQgOiBudWxsO1xuICBjb25zdCBvYmplY3QgPSBldnQuZGF0YSAmJiBpc09iaihldnQuZGF0YS5vYmplY3QpID8gZXZ0LmRhdGEub2JqZWN0IDogbnVsbDtcbiAgaWYgKCFpZCB8fCAhdHlwZSB8fCBjcmVhdGVkID09PSBudWxsIHx8ICFvYmplY3QpIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21hbGZvcm1lZC1ib2R5JywgZGV0YWlsOiAnZXZlbnQgbmVlZHMgaWQsIHR5cGUsIGNyZWF0ZWQgYW5kIGRhdGEub2JqZWN0JywgcHJvdmlkZXJFdmVudElkOiBpZCB9O1xuICBjb25zdCBvY2N1cnJlZEF0TXMgPSBjcmVhdGVkICogMTAwMDtcbiAgY29uc3Qgc291cmNlID0geyBwcm92aWRlcjogU1RSSVBFX1BST1ZJREVSLCBwcm92aWRlckV2ZW50SWQ6IGlkIH0gYXMgY29uc3Q7XG4gIGNvbnN0IGV2ZW50czogTGVkZ2VyRXZlbnRbXSA9IFtdO1xuICBjb25zdCBlbWl0ID0gKGtpbmQ6IExlZGdlckV2ZW50WydraW5kJ10sIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgZXZlbnRzLnB1c2goeyBsZWRnZXJFdmVudElkOiBgc3RyaXBlOiR7aWR9OiR7ZXZlbnRzLmxlbmd0aH1gLCBraW5kLCBvY2N1cnJlZEF0TXMsIHNvdXJjZSwgcGF5bG9hZCB9KTtcbiAgfTtcbiAgY29uc3QgbWlzc2luZ09yZGVyID0gKCk6IE5vcm1hbGl6ZVZlcmRpY3QgPT4gKHsgb2s6IGZhbHNlLCBjb2RlOiAnbWlzc2luZy1vcmRlci1yZWYnLCBkZXRhaWw6IGAke3R5cGV9IGNhcnJpZXMgbm8gbWV0YWRhdGEub3JkZXJJZCAvIGNsaWVudF9yZWZlcmVuY2VfaWRgLCBwcm92aWRlckV2ZW50SWQ6IGlkIH0pO1xuICBjb25zdCBpbnZhbGlkQW1vdW50ID0gKCk6IE5vcm1hbGl6ZVZlcmRpY3QgPT4gKHsgb2s6IGZhbHNlLCBjb2RlOiAnaW52YWxpZC1hbW91bnQnLCBkZXRhaWw6IGAke3R5cGV9IGFtb3VudC9jdXJyZW5jeSBpcyBub3QgYW4gaW50ZWdlciBtaW5vci11bml0IGFtb3VudGAsIHByb3ZpZGVyRXZlbnRJZDogaWQgfSk7XG5cbiAgc3dpdGNoICh0eXBlKSB7XG4gICAgY2FzZSAnY2hlY2tvdXQuc2Vzc2lvbi5jb21wbGV0ZWQnOiB7XG4gICAgICBpZiAob2JqZWN0LnBheW1lbnRfc3RhdHVzICE9PSAncGFpZCcpIGJyZWFrOyAvLyBhc3luYyBwYXltZW50IG1ldGhvZHMgY29tcGxldGUgbGF0ZXIgdmlhIGNoZWNrb3V0LnNlc3Npb24uYXN5bmNfcGF5bWVudF9zdWNjZWVkZWRcbiAgICAgIGNvbnN0IG9yZGVySWQgPSBvcmRlclJlZihvYmplY3QpO1xuICAgICAgaWYgKCFvcmRlcklkKSByZXR1cm4gbWlzc2luZ09yZGVyKCk7XG4gICAgICBjb25zdCBhbW91bnQgPSBtb25leShvYmplY3QsICdhbW91bnRfdG90YWwnKTtcbiAgICAgIGlmICghYW1vdW50KSByZXR1cm4gaW52YWxpZEFtb3VudCgpO1xuICAgICAgZW1pdCgnb3JkZXIucGFpZCcsIHsgb3JkZXJJZCwgYW1vdW50LCBwcm92aWRlclJlZjogcyhvYmplY3QsICdwYXltZW50X2ludGVudCcpID8/IHMob2JqZWN0LCAnaWQnKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlICdjaGVja291dC5zZXNzaW9uLmFzeW5jX3BheW1lbnRfc3VjY2VlZGVkJzoge1xuICAgICAgY29uc3Qgb3JkZXJJZCA9IG9yZGVyUmVmKG9iamVjdCk7XG4gICAgICBpZiAoIW9yZGVySWQpIHJldHVybiBtaXNzaW5nT3JkZXIoKTtcbiAgICAgIGNvbnN0IGFtb3VudCA9IG1vbmV5KG9iamVjdCwgJ2Ftb3VudF90b3RhbCcpO1xuICAgICAgaWYgKCFhbW91bnQpIHJldHVybiBpbnZhbGlkQW1vdW50KCk7XG4gICAgICBlbWl0KCdvcmRlci5wYWlkJywgeyBvcmRlcklkLCBhbW91bnQsIHByb3ZpZGVyUmVmOiBzKG9iamVjdCwgJ3BheW1lbnRfaW50ZW50JykgPz8gcyhvYmplY3QsICdpZCcpIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgJ2NoZWNrb3V0LnNlc3Npb24uYXN5bmNfcGF5bWVudF9mYWlsZWQnOlxuICAgIGNhc2UgJ3BheW1lbnRfaW50ZW50LnBheW1lbnRfZmFpbGVkJzoge1xuICAgICAgY29uc3Qgb3JkZXJJZCA9IG9yZGVyUmVmKG9iamVjdCk7XG4gICAgICBpZiAoIW9yZGVySWQpIHJldHVybiBtaXNzaW5nT3JkZXIoKTtcbiAgICAgIGVtaXQoJ29yZGVyLmZhaWxlZCcsIHsgb3JkZXJJZCwgcHJvdmlkZXJSZWY6IHMob2JqZWN0LCAnaWQnKSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlICdjaGVja291dC5zZXNzaW9uLmV4cGlyZWQnOiB7XG4gICAgICBjb25zdCBvcmRlcklkID0gb3JkZXJSZWYob2JqZWN0KTtcbiAgICAgIGlmICghb3JkZXJJZCkgcmV0dXJuIG1pc3NpbmdPcmRlcigpO1xuICAgICAgZW1pdCgnb3JkZXIuY2FuY2VsZWQnLCB7IG9yZGVySWQsIHByb3ZpZGVyUmVmOiBzKG9iamVjdCwgJ2lkJykgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSAnY2hhcmdlLnJlZnVuZGVkJzoge1xuICAgICAgY29uc3Qgb3JkZXJJZCA9IG9yZGVyUmVmKG9iamVjdCk7XG4gICAgICBpZiAoIW9yZGVySWQpIHJldHVybiBtaXNzaW5nT3JkZXIoKTtcbiAgICAgIGNvbnN0IHJlZnVuZHNMaXN0ID0gaXNPYmoob2JqZWN0LnJlZnVuZHMpICYmIEFycmF5LmlzQXJyYXkob2JqZWN0LnJlZnVuZHMuZGF0YSkgPyAob2JqZWN0LnJlZnVuZHMuZGF0YSBhcyB1bmtub3duW10pIDogbnVsbDtcbiAgICAgIGlmIChyZWZ1bmRzTGlzdCAmJiByZWZ1bmRzTGlzdC5sZW5ndGgpIHtcbiAgICAgICAgZm9yIChjb25zdCByIG9mIHJlZnVuZHNMaXN0KSB7XG4gICAgICAgICAgaWYgKCFpc09iaihyKSkgY29udGludWU7XG4gICAgICAgICAgaWYgKHIuc3RhdHVzICE9PSAnc3VjY2VlZGVkJykgY29udGludWU7XG4gICAgICAgICAgY29uc3QgcmVmdW5kSWQgPSBzKHIsICdpZCcpO1xuICAgICAgICAgIGNvbnN0IGFtb3VudCA9IG1vbmV5KHIsICdhbW91bnQnKTtcbiAgICAgICAgICBpZiAoIXJlZnVuZElkIHx8ICFhbW91bnQpIHJldHVybiBpbnZhbGlkQW1vdW50KCk7XG4gICAgICAgICAgZW1pdCgncmVmdW5kLnN1Y2NlZWRlZCcsIHsgcmVmdW5kSWQsIG9yZGVySWQsIGFtb3VudCwgcHJvdmlkZXJSZWY6IHJlZnVuZElkIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBhbW91bnQgPSBtb25leShvYmplY3QsICdhbW91bnRfcmVmdW5kZWQnKTtcbiAgICAgICAgY29uc3QgY2hhcmdlSWQgPSBzKG9iamVjdCwgJ2lkJyk7XG4gICAgICAgIGlmICghYW1vdW50IHx8ICFjaGFyZ2VJZCkgcmV0dXJuIGludmFsaWRBbW91bnQoKTtcbiAgICAgICAgZW1pdCgncmVmdW5kLnN1Y2NlZWRlZCcsIHsgcmVmdW5kSWQ6IGAke2NoYXJnZUlkfTpyZWZ1bmRgLCBvcmRlcklkLCBhbW91bnQsIHByb3ZpZGVyUmVmOiBjaGFyZ2VJZCB9KTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlICdjaGFyZ2UucmVmdW5kLnVwZGF0ZWQnOlxuICAgIGNhc2UgJ3JlZnVuZC51cGRhdGVkJzpcbiAgICBjYXNlICdyZWZ1bmQuZmFpbGVkJzoge1xuICAgICAgY29uc3QgcmVmdW5kSWQgPSBzKG9iamVjdCwgJ2lkJyk7XG4gICAgICBpZiAoIXJlZnVuZElkKSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdtYWxmb3JtZWQtYm9keScsIGRldGFpbDogYCR7dHlwZX0gcmVmdW5kIG9iamVjdCBoYXMgbm8gaWRgLCBwcm92aWRlckV2ZW50SWQ6IGlkIH07XG4gICAgICBjb25zdCBvcmRlcklkID0gb3JkZXJSZWYob2JqZWN0KTtcbiAgICAgIGNvbnN0IHN0YXR1cyA9IG9iamVjdC5zdGF0dXM7XG4gICAgICBpZiAoc3RhdHVzID09PSAnZmFpbGVkJyB8fCBzdGF0dXMgPT09ICdjYW5jZWxlZCcpIGVtaXQoJ3JlZnVuZC5mYWlsZWQnLCB7IHJlZnVuZElkLCAuLi4ob3JkZXJJZCA/IHsgb3JkZXJJZCB9IDoge30pIH0pO1xuICAgICAgZWxzZSBpZiAoc3RhdHVzID09PSAnc3VjY2VlZGVkJykge1xuICAgICAgICBpZiAoIW9yZGVySWQpIHJldHVybiBtaXNzaW5nT3JkZXIoKTtcbiAgICAgICAgY29uc3QgYW1vdW50ID0gbW9uZXkob2JqZWN0LCAnYW1vdW50Jyk7XG4gICAgICAgIGlmICghYW1vdW50KSByZXR1cm4gaW52YWxpZEFtb3VudCgpO1xuICAgICAgICBlbWl0KCdyZWZ1bmQuc3VjY2VlZGVkJywgeyByZWZ1bmRJZCwgb3JkZXJJZCwgYW1vdW50LCBwcm92aWRlclJlZjogcmVmdW5kSWQgfSk7XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSAnY2hhcmdlLmRpc3B1dGUuY3JlYXRlZCc6XG4gICAgY2FzZSAnY2hhcmdlLmRpc3B1dGUuZnVuZHNfd2l0aGRyYXduJzpcbiAgICBjYXNlICdjaGFyZ2UuZGlzcHV0ZS51cGRhdGVkJzpcbiAgICBjYXNlICdjaGFyZ2UuZGlzcHV0ZS5jbG9zZWQnOiB7XG4gICAgICBjb25zdCBkaXNwdXRlSWQgPSBzKG9iamVjdCwgJ2lkJyk7XG4gICAgICBpZiAoIWRpc3B1dGVJZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBjb2RlOiAnbWFsZm9ybWVkLWJvZHknLFxuICAgICAgICAgIGRldGFpbDogYCR7dHlwZX0gZGlzcHV0ZSBvYmplY3QgaGFzIG5vIGlkYCxcbiAgICAgICAgICBwcm92aWRlckV2ZW50SWQ6IGlkLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgLy8gT25seSBhIGZ1bmRzLXdpdGhkcmF3bi9vcGVuL2xvc3QgZGlzcHV0ZSByZXZlcnNlcyBjcmVkaXRzLiBBIHdvbiBvclxuICAgICAgLy8gd2FybmluZy1uZWVkcy1yZXNwb25zZSB1cGRhdGUgaXMgYXV0aGVudGljYXRlZCBhbmQgcmVjb3JkZWQgYnkgdGhlXG4gICAgICAvLyB3ZWJob29rIGluYm94LCBidXQgZG9lcyBub3QgbW92ZSBtb25leS5cbiAgICAgIGNvbnN0IHN0YXR1cyA9IHMob2JqZWN0LCAnc3RhdHVzJyk7XG4gICAgICBjb25zdCByZXZlcnNlcyA9XG4gICAgICAgIHR5cGUgPT09ICdjaGFyZ2UuZGlzcHV0ZS5jcmVhdGVkJyB8fFxuICAgICAgICB0eXBlID09PSAnY2hhcmdlLmRpc3B1dGUuZnVuZHNfd2l0aGRyYXduJyB8fFxuICAgICAgICBzdGF0dXMgPT09ICdsb3N0JztcbiAgICAgIGlmICghcmV2ZXJzZXMpIGJyZWFrO1xuICAgICAgY29uc3Qgb3JkZXJJZCA9IG9yZGVyUmVmKG9iamVjdCk7XG4gICAgICBpZiAoIW9yZGVySWQpIHJldHVybiBtaXNzaW5nT3JkZXIoKTtcbiAgICAgIGNvbnN0IGFtb3VudCA9IG1vbmV5KG9iamVjdCwgJ2Ftb3VudCcpO1xuICAgICAgaWYgKCFhbW91bnQpIHJldHVybiBpbnZhbGlkQW1vdW50KCk7XG4gICAgICBlbWl0KCdyZWZ1bmQuc3VjY2VlZGVkJywge1xuICAgICAgICByZWZ1bmRJZDogYGRpc3B1dGU6JHtkaXNwdXRlSWR9YCxcbiAgICAgICAgb3JkZXJJZCxcbiAgICAgICAgYW1vdW50LFxuICAgICAgICBwcm92aWRlclJlZjogZGlzcHV0ZUlkLFxuICAgICAgICByZXZlcnNhbFJlYXNvbjogJ2NoYXJnZWJhY2snLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSAncGF5b3V0LmNyZWF0ZWQnOlxuICAgIGNhc2UgJ3BheW91dC5wYWlkJzpcbiAgICBjYXNlICdwYXlvdXQuZmFpbGVkJzoge1xuICAgICAgY29uc3QgcGF5b3V0SWQgPSBzKG9iamVjdCwgJ2lkJyk7XG4gICAgICBjb25zdCBjcmVhdG9ySWQgPSBzKG1ldGFkYXRhKG9iamVjdCksICdjcmVhdG9ySWQnKSA/PyBzKG9iamVjdCwgJ2Rlc3RpbmF0aW9uJyk7XG4gICAgICBjb25zdCBhbW91bnQgPSBtb25leShvYmplY3QsICdhbW91bnQnKTtcbiAgICAgIGlmICghcGF5b3V0SWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21hbGZvcm1lZC1ib2R5JywgZGV0YWlsOiBgJHt0eXBlfSBwYXlvdXQgb2JqZWN0IGhhcyBubyBpZGAsIHByb3ZpZGVyRXZlbnRJZDogaWQgfTtcbiAgICAgIGlmICghYW1vdW50KSByZXR1cm4gaW52YWxpZEFtb3VudCgpO1xuICAgICAgaWYgKHR5cGUgPT09ICdwYXlvdXQuY3JlYXRlZCcpIHtcbiAgICAgICAgaWYgKCFjcmVhdG9ySWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21pc3Npbmctb3JkZXItcmVmJywgZGV0YWlsOiAncGF5b3V0LmNyZWF0ZWQgY2FycmllcyBubyBtZXRhZGF0YS5jcmVhdG9ySWQgLyBkZXN0aW5hdGlvbicsIHByb3ZpZGVyRXZlbnRJZDogaWQgfTtcbiAgICAgICAgZW1pdCgncGF5b3V0LmNyZWF0ZWQnLCB7IHBheW91dElkLCBjcmVhdG9ySWQsIGFtb3VudCwgcHJvdmlkZXJSZWY6IHBheW91dElkIH0pO1xuICAgICAgfSBlbHNlIGVtaXQodHlwZSA9PT0gJ3BheW91dC5wYWlkJyA/ICdwYXlvdXQucGFpZCcgOiAncGF5b3V0LmZhaWxlZCcsIHsgcGF5b3V0SWQsIHByb3ZpZGVyUmVmOiBwYXlvdXRJZCB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgYnJlYWs7IC8vIGF1dGhlbnRpY2F0ZWQgYnV0IGlycmVsZXZhbnQg4oaSIGlnbm9yZWQgYnkgdGhlIGluYm94XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHdlYmhvb2s6IHsgcHJvdmlkZXJFdmVudElkOiBpZCwgcHJvdmlkZXJFdmVudFR5cGU6IHR5cGUsIG9jY3VycmVkQXRNcywgZXZlbnRzIH0gfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN0cmlwZUFkYXB0ZXIob3B0aW9uczogU3RyaXBlQWRhcHRlck9wdGlvbnMpOiBQYXltZW50UHJvdmlkZXJBZGFwdGVyIHtcbiAgcmV0dXJuIHtcbiAgICBwcm92aWRlcjogU1RSSVBFX1BST1ZJREVSLFxuICAgIHZlcmlmeVNpZ25hdHVyZTogKHJlcXVlc3QpID0+IHZlcmlmeVN0cmlwZVNpZ25hdHVyZShvcHRpb25zLCByZXF1ZXN0KSxcbiAgICBub3JtYWxpemU6IChyYXdCb2R5KSA9PiBub3JtYWxpemVTdHJpcGVFdmVudChyYXdCb2R5KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXItbmV1dHJhbCBvcmRlciDihpIgU3RyaXBlIENoZWNrb3V0IFNlc3Npb24gcmVxdWVzdC4gQSBwdXJlIG9iamVjdCB0aGVcbiAqIGNhbGxlciBwb3N0cyB0byBgL3YxL2NoZWNrb3V0L3Nlc3Npb25zYDsgdGhlIG9yZGVyIGlkIHJpZGVzIGluXG4gKiBgY2xpZW50X3JlZmVyZW5jZV9pZGAgKyBtZXRhZGF0YSBzbyBldmVyeSBsYXRlciB3ZWJob29rIGNhbiBiZSBtYXBwZWQgYmFjay5cbiAqL1xuZXhwb3J0IHR5cGUgU3RyaXBlQ2hlY2tvdXRCdWlsZCA9XG4gIHwgeyBvazogdHJ1ZTsgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9XG4gIHwgeyBvazogZmFsc2U7IGNvZGU6ICd1bnN1cHBvcnRlZC1wcmljaW5nLW1vZGVsJyB8ICdhbW91bnQtbWlzbWF0Y2gnIHwgJ3plcm8tYW1vdW50JzsgZGV0YWlsOiBzdHJpbmcgfTtcblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU3RyaXBlQ2hlY2tvdXRTZXNzaW9uUGFyYW1zKGlucHV0OiB7IG9yZGVyOiBPcmRlcjsgb2ZmZXI6IE9mZmVyOyBwcm9kdWN0OiBQcm9kdWN0OyBzdWNjZXNzVXJsOiBzdHJpbmc7IGNhbmNlbFVybDogc3RyaW5nIH0pOiBTdHJpcGVDaGVja291dEJ1aWxkIHtcbiAgY29uc3QgeyBvcmRlciwgb2ZmZXIsIHByb2R1Y3QgfSA9IGlucHV0O1xuICBpZiAob2ZmZXIucHJpY2luZ01vZGVsID09PSAnZnJlZScgfHwgb2ZmZXIucHJpY2luZ01vZGVsID09PSAncGVyLXVzZScpIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ3Vuc3VwcG9ydGVkLXByaWNpbmctbW9kZWwnLCBkZXRhaWw6IGAke29mZmVyLnByaWNpbmdNb2RlbH0gb2ZmZXJzIGRvIG5vdCBnbyB0aHJvdWdoIENoZWNrb3V0YCB9O1xuICBpZiAob3JkZXIuYW1vdW50LmFtb3VudE1pbm9yICE9PSBvZmZlci5wcmljZS5hbW91bnRNaW5vciB8fCBvcmRlci5hbW91bnQuY3VycmVuY3kgIT09IG9mZmVyLnByaWNlLmN1cnJlbmN5KSByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdhbW91bnQtbWlzbWF0Y2gnLCBkZXRhaWw6ICdvcmRlciBhbW91bnQgZGlmZmVycyBmcm9tIHRoZSBvZmZlciBwcmljZScgfTtcbiAgaWYgKG9yZGVyLmFtb3VudC5hbW91bnRNaW5vciA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnemVyby1hbW91bnQnLCBkZXRhaWw6ICdDaGVja291dCByZXF1aXJlcyBhIHBvc2l0aXZlIGFtb3VudCcgfTtcbiAgY29uc3QgcHVyY2hhc2VNZXRhZGF0YSA9IHtcbiAgICBvcmRlcklkOiBvcmRlci5vcmRlcklkLFxuICAgIG9mZmVySWQ6IG9mZmVyLm9mZmVySWQsXG4gICAgcHJvZHVjdElkOiBwcm9kdWN0LnByb2R1Y3RJZCxcbiAgICBidXllcklkOiBvcmRlci5idXllcklkLFxuICAgIHNrdVJlZjogcHJvZHVjdC5za3VSZWYsXG4gIH07XG4gIGNvbnN0IHByaWNlRGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgY3VycmVuY3k6IG9yZGVyLmFtb3VudC5jdXJyZW5jeS50b0xvd2VyQ2FzZSgpLFxuICAgIHVuaXRfYW1vdW50OiBvcmRlci5hbW91bnQuYW1vdW50TWlub3IsXG4gICAgcHJvZHVjdF9kYXRhOiB7IG5hbWU6IHByb2R1Y3QudGl0bGUsIG1ldGFkYXRhOiB7IHNrdVJlZjogcHJvZHVjdC5za3VSZWYsIHByb2R1Y3RJZDogcHJvZHVjdC5wcm9kdWN0SWQgfSB9LFxuICB9O1xuICBpZiAob2ZmZXIucHJpY2luZ01vZGVsID09PSAnc3Vic2NyaXB0aW9uJykgcHJpY2VEYXRhLnJlY3VycmluZyA9IHsgaW50ZXJ2YWw6ICdtb250aCcgfTtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBwYXJhbXM6IHtcbiAgICAgIG1vZGU6IG9mZmVyLnByaWNpbmdNb2RlbCA9PT0gJ3N1YnNjcmlwdGlvbicgPyAnc3Vic2NyaXB0aW9uJyA6ICdwYXltZW50JyxcbiAgICAgIGNsaWVudF9yZWZlcmVuY2VfaWQ6IG9yZGVyLm9yZGVySWQsXG4gICAgICBzdWNjZXNzX3VybDogaW5wdXQuc3VjY2Vzc1VybCxcbiAgICAgIGNhbmNlbF91cmw6IGlucHV0LmNhbmNlbFVybCxcbiAgICAgIGxpbmVfaXRlbXM6IFt7IHF1YW50aXR5OiAxLCBwcmljZV9kYXRhOiBwcmljZURhdGEgfV0sXG4gICAgICAvLyBTdHJpcGUgZW5hYmxlcyBNYW5hZ2VkIFBheW1lbnRzIGJ5IGRlZmF1bHQgb24gbmV3IGFjY291bnRzLCBhbmQgdW5kZXIgaXRcbiAgICAgIC8vIEVWRVJZIGxpbmUgaXRlbSBtdXN0IGNhcnJ5IGEgcHJvZHVjdCB0YXggY29kZSDigJQgd2hpY2ggYW4gYWQtaG9jXG4gICAgICAvLyBgcHJpY2VfZGF0YWAgcHJvZHVjdCBjYW5ub3QgaGF2ZSwgc28gdGhlIGFjY291bnQgZGVmYXVsdCBhbG9uZSBtYWRlIGV2ZXJ5XG4gICAgICAvLyBDaGVja291dCBTZXNzaW9uIGhlcmUgYSBoYXJkIDQwMCAoXCJ0aGUgcHJvZHVjdCB0YXggY29kZSBpcyBtaXNzaW5nXCIpLlxuICAgICAgLy8gTWVhc3VyZWQgYWdhaW5zdCB0aGUgbGl2ZSB0ZXN0LW1vZGUgYWNjb3VudCAyMDI2LTA5LTA2IChQLTAzOCkuXG4gICAgICAvL1xuICAgICAgLy8gRGlzYWJsaW5nIGl0IGlzIHRoZSBDT1JSRUNUIGFuc3dlciwgbm90IG1lcmVseSB0aGUgc21hbGxlciBvbmU6IHVuZGVyXG4gICAgICAvLyBNYW5hZ2VkIFBheW1lbnRzIFN0cmlwZSBiZWNvbWVzIG1lcmNoYW50IG9mIHJlY29yZCBhbmQgb3ducyBzZXR0bGVtZW50LFxuICAgICAgLy8gd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgdGhpcyBzeXN0ZW0gZG9lcyBOT1Qgd2FudCDigJQgdGhlIERBTydzIG93biBzcGxpdFxuICAgICAgLy8gbWFuaWZlc3QgYW5kIHNldHRsZW1lbnQgYmF0Y2hlcyAoUC0wMzMvUC0wMzQpIGRpc3RyaWJ1dGUgdGhlIHByb2NlZWRzLCBhbmRcbiAgICAgIC8vIHRoYXQgb25seSB3b3JrcyBvbiBhIGRpcmVjdCBjaGFyZ2UgaW50byBvdXIgb3duIGJhbGFuY2UuIFNldHRpbmcgc29tZSB0YXhcbiAgICAgIC8vIGNvZGUgaW5zdGVhZCB3b3VsZCBoYXZlIHNpbGVudGx5IGhhbmRlZCBwYXlvdXRzIHRvIGEgZGlmZmVyZW50IHJhaWwuXG4gICAgICBtYW5hZ2VkX3BheW1lbnRzOiB7IGVuYWJsZWQ6IGZhbHNlIH0sXG4gICAgICBtZXRhZGF0YTogcHVyY2hhc2VNZXRhZGF0YSxcbiAgICAgIC8vIENoYXJnZXMvZGlzcHV0ZXMgYXJlIGRvd25zdHJlYW0gb2YgdGhlIFBheW1lbnRJbnRlbnQsIG5vdCB0aGUgQ2hlY2tvdXRcbiAgICAgIC8vIFNlc3Npb24uIENvcHkgdGhlIGNvbXBsZXRlIHB1cmNoYXNlIGlkZW50aXR5IHNvIGEgY2hhcmdlYmFjayBjYW4gc3RpbGxcbiAgICAgIC8vIHJlc29sdmUgdGhlIHByaW5jaXBhbCBhbmQgdG9wLXVwIFNLVSB3aXRob3V0IGFuIGFkZHJlc3MgaW5mZXJlbmNlLlxuICAgICAgcGF5bWVudF9pbnRlbnRfZGF0YTogb2ZmZXIucHJpY2luZ01vZGVsID09PSAnb25lLXRpbWUnID8geyBtZXRhZGF0YTogcHVyY2hhc2VNZXRhZGF0YSB9IDogdW5kZWZpbmVkLFxuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBjb25zdCBTVFJJUEVfQ0hFQ0tPVVRfU0VTU0lPTlNfVVJMID0gJ2h0dHBzOi8vYXBpLnN0cmlwZS5jb20vdjEvY2hlY2tvdXQvc2Vzc2lvbnMnO1xuXG4vKipcbiAqIEZsYXR0ZW4gYSBDaGVja291dCBwYXJhbXMgb2JqZWN0IGludG8gU3RyaXBlJ3MgZm9ybSBlbmNvZGluZy5cbiAqXG4gKiBTdHJpcGUncyBSRVNUIEFQSSBpcyBgYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkYCwgTk9UIEpTT04g4oCUIG5lc3RlZFxuICogc3RydWN0dXJlcyB0cmF2ZWwgYXMgYnJhY2tldCBwYXRocyAoYGxpbmVfaXRlbXNbMF1bcHJpY2VfZGF0YV1bY3VycmVuY3ldYCkuXG4gKiBQb3N0aW5nIGBKU09OLnN0cmluZ2lmeShwYXJhbXMpYCBpcyBhY2NlcHRlZCBieSB0aGUgdHJhbnNwb3J0IGFuZCB0aGVuXG4gKiByZWplY3RlZCBhcyBhIG1hbGZvcm1lZCByZXF1ZXN0LCB3aGljaCBpcyB3aHkgdGhpcyBsaXZlcyBiZXNpZGUgdGhlIGJ1aWxkZXJcbiAqIHJhdGhlciB0aGFuIGJlaW5nIGltcHJvdmlzZWQgYXQgdGhlIGNhbGwgc2l0ZS5cbiAqXG4gKiBgdW5kZWZpbmVkYCBhbmQgYG51bGxgIG1lbWJlcnMgYXJlIERST1BQRUQsIG5vdCBlbmNvZGVkIGFzIHRoZSBzdHJpbmdzXG4gKiBcInVuZGVmaW5lZFwiL1wibnVsbFwiOiBgYnVpbGRTdHJpcGVDaGVja291dFNlc3Npb25QYXJhbXNgIGxlYXZlc1xuICogYHBheW1lbnRfaW50ZW50X2RhdGFgIHVuZGVmaW5lZCBmb3Igbm9uLW9uZS10aW1lIG9mZmVycywgYW5kIHNlbmRpbmcgdGhhdFxuICogbGl0ZXJhbCB3b3VsZCBiZSBhIFN0cmlwZSA0MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmNvZGVTdHJpcGVGb3JtUGFyYW1zKHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBVUkxTZWFyY2hQYXJhbXMge1xuICBjb25zdCBvdXQgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGNvbnN0IHdhbGsgPSAocHJlZml4OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybjtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIHZhbHVlLmZvckVhY2goKGVudHJ5LCBpbmRleCkgPT4gd2FsayhgJHtwcmVmaXh9WyR7aW5kZXh9XWAsIGVudHJ5KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIGlubmVyXSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHdhbGsoYCR7cHJlZml4fVske2tleX1dYCwgaW5uZXIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBvdXQuYXBwZW5kKHByZWZpeCwgU3RyaW5nKHZhbHVlKSk7XG4gIH07XG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHBhcmFtcykpIHdhbGsoa2V5LCB2YWx1ZSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCB0eXBlIFN0cmlwZUNoZWNrb3V0U2Vzc2lvblJlc3VsdCA9XG4gIHwgeyBvazogdHJ1ZTsgc2Vzc2lvbklkOiBzdHJpbmc7IHVybDogc3RyaW5nIH1cbiAgfCB7IG9rOiBmYWxzZTsgY29kZTogJ3Byb3ZpZGVyLWVycm9yJyB8ICdtYWxmb3JtZWQtcmVzcG9uc2UnOyBzdGF0dXM6IG51bWJlciB8IG51bGw7IGRldGFpbDogc3RyaW5nIH07XG5cbmV4cG9ydCB0eXBlIFN0cmlwZUZvcm1Qb3N0UmVzdWx0ID1cbiAgfCB7IG9rOiB0cnVlOyBzdGF0dXM6IG51bWJlcjsgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfVxuICB8IHsgb2s6IGZhbHNlOyBjb2RlOiAncHJvdmlkZXItZXJyb3InIHwgJ21hbGZvcm1lZC1yZXNwb25zZSc7IHN0YXR1czogbnVtYmVyIHwgbnVsbDsgZGV0YWlsOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBQT1NUIGEgcGFyYW1zIG9iamVjdCB0byBhbnkgU3RyaXBlIFJFU1QgZW5kcG9pbnQgKGZvcm0tZW5jb2RlZCkgYW5kIHJldHVybiB0aGVcbiAqIHBhcnNlZCBKU09OIGJvZHkuIFRoZSBzaW5nbGUgU3RyaXBlIEhUVFAgc2VhbTogQ2hlY2tvdXQgU2Vzc2lvbnMgYmVsb3cgYW5kIHRoZVxuICogaG9zdGVkIHN1YnNjcmlwdGlvbiBiaWxsaW5nIGNsaWVudCAoYGF1dGgvaG9zdGVkL2JpbGxpbmcvc3RyaXBlLWJpbGxpbmctY2xpZW50LnRzYDpcbiAqIGN1c3RvbWVycywgc3Vic2NyaXB0aW9uIENoZWNrb3V0LCBjdXN0b21lci1wb3J0YWwgc2Vzc2lvbnMpIGJvdGggZ28gdGhyb3VnaCBpdC5cbiAqXG4gKiBgZmV0Y2hJbXBsYCBpcyBpbmplY3RlZCBzbyBhIGNhbGxlciBjYW4gZXhlcmNpc2UgdGhpcyB3aXRob3V0IG5ldHdvcmsgYWNjZXNzLFxuICogYW5kIHRoZSBzZWNyZXQga2V5IGlzIGEgcGFyYW1ldGVyIHJhdGhlciB0aGFuIGEgbW9kdWxlLXNjb3BlIGdsb2JhbCwgc28gYVxuICogZGVwbG95bWVudCB0aGF0IGhhcyBub3QgY29uZmlndXJlZCBvbmUgY2Fubm90IHBvc3QgdW5hdXRoZW50aWNhdGVkIGJ5IGRlZmF1bHQuXG4gKlxuICogYGlkZW1wb3RlbmN5S2V5YCBpcyBmb3J3YXJkZWQgYXMgU3RyaXBlJ3Mgb3duIGBJZGVtcG90ZW5jeS1LZXlgIGhlYWRlcjogYVxuICogcmV0cnkg4oCUIG91cnMgb3IgYSBjbGllbnQgcmVwbGF5IOKAlCBtdXN0IG5vdCBjcmVhdGUgYSBTRUNPTkQgQ2hlY2tvdXQgU2Vzc2lvblxuICogYW5kIHRoZXJlZm9yZSBhIHNlY29uZCBjaGFyZ2UuIExlZGdlci1zaWRlIGlkZW1wb3RlbmN5IGNhbm5vdCBjb3ZlciB0aGVcbiAqIHdpbmRvdyBiZXR3ZWVuIHRoZSBTdHJpcGUgY2FsbCBhbmQgdGhlIGxlZGdlciBhcHBlbmQ7IG9ubHkgdGhlIHByb3ZpZGVyIGNhbixcbiAqIHdoaWNoIGlzIHdoYXQgdGhpcyBoZWFkZXIgaXMgZm9yLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcG9zdFN0cmlwZUZvcm0oaW5wdXQ6IHtcbiAgdXJsOiBzdHJpbmc7XG4gIHNlY3JldEtleTogc3RyaW5nO1xuICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBmZXRjaEltcGw6IHR5cGVvZiBmZXRjaDtcbiAgaWRlbXBvdGVuY3lLZXk/OiBzdHJpbmc7XG59KTogUHJvbWlzZTxTdHJpcGVGb3JtUG9zdFJlc3VsdD4ge1xuICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIGF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtpbnB1dC5zZWNyZXRLZXl9YCxcbiAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZCcsXG4gIH07XG4gIGlmIChpbnB1dC5pZGVtcG90ZW5jeUtleSkgaGVhZGVyc1snaWRlbXBvdGVuY3kta2V5J10gPSBpbnB1dC5pZGVtcG90ZW5jeUtleTtcblxuICBsZXQgcmVzcG9uc2U6IFJlc3BvbnNlO1xuICB0cnkge1xuICAgIHJlc3BvbnNlID0gYXdhaXQgaW5wdXQuZmV0Y2hJbXBsKGlucHV0LnVybCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogZW5jb2RlU3RyaXBlRm9ybVBhcmFtcyhpbnB1dC5wYXJhbXMpLnRvU3RyaW5nKCksXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ3Byb3ZpZGVyLWVycm9yJywgc3RhdHVzOiBudWxsLCBkZXRhaWw6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9O1xuICB9XG5cbiAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIC8vIFN1cmZhY2UgU3RyaXBlJ3Mgb3duIG1lc3NhZ2Ugd2hlbiBpdCBzZW50IG9uZSwgbmV2ZXIgdGhlIHJhdyBib2R5LCB3aGljaFxuICAgIC8vIGVjaG9lcyB0aGUgcmVxdWVzdCAoaW5jbHVkaW5nIHBhcmFtcyB3ZSB3b3VsZCByYXRoZXIgbm90IHJlLWVtaXQpLlxuICAgIGxldCBkZXRhaWwgPSBgc3RyaXBlIHJlc3BvbmRlZCAke3Jlc3BvbnNlLnN0YXR1c31gO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpIGFzIHsgZXJyb3I/OiB7IG1lc3NhZ2U/OiB1bmtub3duIH0gfTtcbiAgICAgIGlmICh0eXBlb2YgcGFyc2VkPy5lcnJvcj8ubWVzc2FnZSA9PT0gJ3N0cmluZycpIGRldGFpbCA9IHBhcnNlZC5lcnJvci5tZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogbm9uLUpTT04gZXJyb3IgYm9keSDigJQga2VlcCB0aGUgc3RhdHVzLW9ubHkgZGV0YWlsICovXG4gICAgfVxuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ3Byb3ZpZGVyLWVycm9yJywgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGRldGFpbCB9O1xuICB9XG5cbiAgbGV0IHBhcnNlZEJvZHk6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkQm9keSA9IEpTT04ucGFyc2UodGV4dCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21hbGZvcm1lZC1yZXNwb25zZScsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBkZXRhaWw6ICdzdHJpcGUgcmVzcG9uc2Ugd2FzIG5vdCBKU09OJyB9O1xuICB9XG4gIGNvbnN0IGJvZHkgPSBwYXJzZWRCb2R5ICYmIHR5cGVvZiBwYXJzZWRCb2R5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWRCb2R5KSA/IChwYXJzZWRCb2R5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA6IHt9O1xuICByZXR1cm4geyBvazogdHJ1ZSwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGJvZHkgfTtcbn1cblxuLyoqIFBPU1QgYSBidWlsdCBDaGVja291dCBwYXJhbXMgb2JqZWN0IHRvIFN0cmlwZSBhbmQgcmV0dXJuIHRoZSBzZXNzaW9uIGhhbmRsZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjcmVhdGVTdHJpcGVDaGVja291dFNlc3Npb24oaW5wdXQ6IHtcbiAgc2VjcmV0S2V5OiBzdHJpbmc7XG4gIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGZldGNoSW1wbDogdHlwZW9mIGZldGNoO1xuICBpZGVtcG90ZW5jeUtleT86IHN0cmluZztcbn0pOiBQcm9taXNlPFN0cmlwZUNoZWNrb3V0U2Vzc2lvblJlc3VsdD4ge1xuICBjb25zdCBwb3N0ZWQgPSBhd2FpdCBwb3N0U3RyaXBlRm9ybSh7IC4uLmlucHV0LCB1cmw6IFNUUklQRV9DSEVDS09VVF9TRVNTSU9OU19VUkwgfSk7XG4gIGlmICghcG9zdGVkLm9rKSByZXR1cm4gcG9zdGVkO1xuICBjb25zdCByZXNwb25zZSA9IHsgc3RhdHVzOiBwb3N0ZWQuc3RhdHVzIH07XG4gIGNvbnN0IHBhcnNlZCA9IHBvc3RlZC5ib2R5IGFzIHsgaWQ/OiB1bmtub3duOyB1cmw/OiB1bmtub3duIH07XG4gIGlmICh0eXBlb2YgcGFyc2VkLmlkICE9PSAnc3RyaW5nJyB8fCAhcGFyc2VkLmlkKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb2RlOiAnbWFsZm9ybWVkLXJlc3BvbnNlJywgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGRldGFpbDogJ3N0cmlwZSByZXNwb25zZSBjYXJyaWVkIG5vIHNlc3Npb24gaWQnIH07XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQudXJsICE9PSAnc3RyaW5nJyB8fCAhcGFyc2VkLnVybCkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29kZTogJ21hbGZvcm1lZC1yZXNwb25zZScsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBkZXRhaWw6ICdzdHJpcGUgcmVzcG9uc2UgY2FycmllZCBubyBjaGVja291dCB1cmwnIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHNlc3Npb25JZDogcGFyc2VkLmlkLCB1cmw6IHBhcnNlZC51cmwgfTtcbn1cbiJdLCJmaWxlIjoiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvcGF5bWVudC1hZGFwdGVycy9zdHJpcGUudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvcGFja2FnZXMvb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvcGF5bWVudC1hZGFwdGVycy9zdHJpcGUudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9wYWNrYWdlcy9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9wYXltZW50LWFkYXB0ZXJzL3N0cmlwZS50cyIsW11d