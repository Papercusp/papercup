'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("commerceRoute", () => { try { return commerceRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/metered-invocation.ts", {"importedNames":["verifySellerReceiptAuthority"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/webhook-inbox.ts", {"importedNames":["ingestWebhook"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/payment-adapters/stripe.ts", {"importedNames":["buildStripeCheckoutSessionParams","createStripeAdapter","createStripeCheckoutSession","STRIPE_PROVIDER"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/commerce-ledger.ts", {"importedNames":["PRICING_MODELS","reduceLedger"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/microcharge.ts", {"importedNames":["createMicrochargeChannel"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/commerce-door-gate.ts", {"importedNames":["authorizeOrgActor"]});
const __vite_ssr_import_8__ = await __vite_ssr_import__("/src/commerce-store.ts", {"importedNames":["appendLedgerEvents","d1WebhookInboxStore","getCommerceOffer","listActiveEntitlements","listCommerceOffers","loadLedgerEvents","loadOrganizations","projectLedger"]});









const SIGNATURE_REFUSALS = /* @__PURE__ */ new Set([
  "missing-secret",
  "missing-signature",
  "malformed-signature",
  "bad-signature",
  "stale-timestamp"
]);
function resolveAdapter(provider, env) {
  if (provider !== __vite_ssr_import_3__.STRIPE_PROVIDER) return { error: "unknown" };
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== "string" || !secret) return { error: "unconfigured" };
  return { adapter: (0,__vite_ssr_import_3__.createStripeAdapter)({ webhookSecret: secret }) };
}
function parseCheckoutRequest(raw) {
  if (typeof raw !== "object" || raw === null)
    return {
      ok: false,
      code: "invalid_request",
      detail: "body must be a JSON object"
    };
  const body = raw;
  const required = [
    "buyerOrgId",
    "offerId",
    "successUrl",
    "cancelUrl",
    "idempotencyKey"
  ];
  for (const field of required) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim())
      return {
        ok: false,
        code: "invalid_request",
        detail: `${field} must be a non-empty string`
      };
  };
  const quantity = body.quantity === void 0 ? 1 : body.quantity;
  if (quantity !== 1)
    return {
      ok: false,
      code: "unsupported_quantity",
      detail: "only quantity 1 is supported by the current Checkout builder"
    };
  const maxSpendMicros = body.maxSpendMicros;
  if (maxSpendMicros !== void 0 && (!Number.isSafeInteger(maxSpendMicros) || maxSpendMicros <= 0)) {
    return {
      ok: false,
      code: "invalid_max_spend",
      detail: "maxSpendMicros must be a positive safe integer"
    };
  };
  return {
    ok: true,
    value: {
      buyerOrgId: String(body.buyerOrgId),
      offerId: String(body.offerId),
      successUrl: String(body.successUrl),
      cancelUrl: String(body.cancelUrl),
      idempotencyKey: String(body.idempotencyKey),
      quantity: 1,
      ...maxSpendMicros !== void 0 ? { maxSpendMicros } : {}
    }
  };
}
function parsePublishOfferRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "body must be a JSON object" };
  };
  const body = raw;
  for (const field of ["productId", "offerId", "skuRef", "title"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return { ok: false, detail: `${field} must be a non-empty string` };
    }
  };
  if (!__vite_ssr_import_5__.PRICING_MODELS.includes(body.pricingModel)) {
    return { ok: false, detail: "pricingModel is not supported" };
  };
  if (!body.price || typeof body.price !== "object" || Array.isArray(body.price)) {
    return { ok: false, detail: "price must be an object" };
  };
  if (body.active !== void 0 && typeof body.active !== "boolean") {
    return { ok: false, detail: "active must be a boolean" };
  };
  return {
    ok: true,
    value: {
      productId: String(body.productId),
      offerId: String(body.offerId),
      skuRef: String(body.skuRef),
      title: String(body.title),
      pricingModel: body.pricingModel,
      price: body.price,
      ...body.perUse !== void 0 ? { perUse: body.perUse } : {},
      ...body.receiptAuthority !== void 0 ? { receiptAuthority: body.receiptAuthority } : {},
      ...body.active !== void 0 ? { active: body.active } : {}
    }
  };
}
async function deriveOrderId(input) {
  const material = `${input.buyerOrgId}
${input.offerId}
${input.idempotencyKey}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ord_${hex.slice(0, 32)}`;
}
async function contentId(prefix, payload) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex.slice(0, 32)}`;
}
const BUILD_REFUSAL_CODES = {
  "unsupported-pricing-model": "unsupported_pricing_model",
  "amount-mismatch": "amount_mismatch",
  "zero-amount": "zero_amount"
};
function principalId(user) {
  return `gh:${user.id}`;
}
async function authorizeBuyer(buyerId, actingUserId, loadOrgs, db) {
  if (buyerId === actingUserId) return { ok: true };
  const verdict = (0,__vite_ssr_import_7__.authorizeOrgActor)(buyerId, actingUserId, await loadOrgs(db));
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    code: verdict.code === "actor-not-in-org" ? "not_org_member" : "org_membership_unknown",
    detail: verdict.detail
  };
}
function commerceRoute(options = {}) {
  const route = new __vite_ssr_import_0__.Hono();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const loadOrgs = options.loadOrgs ?? __vite_ssr_import_8__.loadOrganizations;
  route.get("/commerce/offers", async (c) => {
    const pricing = c.req.query("pricing");
    if (pricing !== void 0 && !__vite_ssr_import_5__.PRICING_MODELS.includes(pricing)) {
      return c.json({ error: "invalid_pricing_model" }, 400);
    };
    return c.json({
      offers: await (0,__vite_ssr_import_8__.listCommerceOffers)(c.env.DB, pricing)
    });
  });
  route.get("/commerce/offers/:offerId", async (c) => {
    const offer = await (0,__vite_ssr_import_8__.getCommerceOffer)(c.env.DB, c.req.param("offerId"));
    return offer ? c.json({ offer }) : c.json({ error: "unknown_offer" }, 404);
  });
  route.post("/commerce/offers", async (c) => {
    let actingUserId;
    try {
      actingUserId = principalId(await (0,__vite_ssr_import_4__.resolveGithubBearer)(c.req.raw));
    } catch (err) {
      if (err instanceof __vite_ssr_import_4__.AuthError) {
        return c.json({ error: "unauthorized", reason: err.reason }, 401);
      };
      throw err;
    };
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_request", detail: "body was not valid JSON" },
        400
      );
    };
    const parsed = parsePublishOfferRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: "invalid_request", detail: parsed.detail }, 400);
    };
    const request = parsed.value;
    if (request.receiptAuthority !== void 0 && (request.pricingModel !== "per-use" || !request.receiptAuthority || !(0,__vite_ssr_import_1__.verifySellerReceiptAuthority)({
      seller: actingUserId,
      offerId: request.offerId,
      productId: request.productId,
      skuRef: request.skuRef
    }, request.receiptAuthority))) {
      return c.json({ error: "invalid_seller_authority", detail: "the publisher must prove possession of the exact offer receipt key" }, 422);
    };
    const events = await (0,__vite_ssr_import_8__.loadLedgerEvents)(c.env.DB);
    const state = (0,__vite_ssr_import_5__.reduceLedger)(events);
    const existingProduct = state.products.get(request.productId);
    if (existingProduct && existingProduct.creatorId !== actingUserId) {
      return c.json(
        {
          error: "product_not_owned",
          detail: `product ${request.productId} belongs to ${existingProduct.creatorId}`
        },
        403
      );
    };
    const existingOffer = state.offers.get(request.offerId);
    if (existingOffer) {
      const owner = state.products.get(existingOffer.productId)?.creatorId;
      if (owner !== actingUserId) {
        return c.json(
          {
            error: "offer_not_owned",
            detail: `offer ${request.offerId} belongs to ${owner ?? "an unknown creator"}`
          },
          403
        );
      }
    };
    const now = Date.now();
    const productPayload = {
      productId: request.productId,
      skuRef: request.skuRef,
      creatorId: actingUserId,
      title: request.title,
      active: request.active !== false
    };
    const offerPayload = {
      offerId: request.offerId,
      productId: request.productId,
      pricingModel: request.pricingModel,
      price: request.price,
      ...request.perUse !== void 0 ? { perUse: request.perUse } : {},
      ...request.receiptAuthority ? { receiptAuthority: request.receiptAuthority } : {},
      active: request.active !== false
    };
    const candidate = [
      {
        ledgerEventId: await contentId("evt:product-defined", productPayload),
        kind: "product.defined",
        occurredAtMs: now,
        source: { provider: "operator", providerEventId: null },
        payload: productPayload
      },
      {
        ledgerEventId: await contentId("evt:offer-defined", offerPayload),
        kind: "offer.defined",
        occurredAtMs: now + 1,
        source: { provider: "operator", providerEventId: null },
        payload: offerPayload
      }
    ].map((event) => {
      const prior = events.find((stored) => stored.ledgerEventId === event.ledgerEventId);
      return { ...event, occurredAtMs: prior?.occurredAtMs ?? event.occurredAtMs };
    });
    const candidateIds = new Set(candidate.map((event) => event.ledgerEventId));
    const projected = (0,__vite_ssr_import_5__.reduceLedger)([...events, ...candidate]);
    const rejection = projected.rejected.find(
      (row) => candidateIds.has(row.ledgerEventId)
    );
    if (rejection) {
      return c.json(
        {
          error: "invalid_offer",
          code: rejection.code,
          detail: rejection.detail
        },
        422
      );
    };
    const existingIds = new Set(events.map((event) => event.ledgerEventId));
    const replayed = candidate.every(
      (event) => existingIds.has(event.ledgerEventId)
    );
    await (0,__vite_ssr_import_8__.appendLedgerEvents)(c.env.DB, candidate);
    await (0,__vite_ssr_import_8__.projectLedger)(c.env.DB);
    const offer = await (0,__vite_ssr_import_8__.getCommerceOffer)(c.env.DB, request.offerId);
    const product = projected.products.get(request.productId);
    if (!offer || !product) {
      return c.json(
        {
          error: "projection_failed",
          detail: "offer did not appear in the D1 projection"
        },
        500
      );
    };
    return c.json({ replayed, product, offer }, replayed ? 200 : 201);
  });
  route.post("/commerce/checkout-sessions", async (c) => {
    let actingUserId;
    try {
      actingUserId = principalId(await (0,__vite_ssr_import_4__.resolveGithubBearer)(c.req.raw));
    } catch (err) {
      if (err instanceof __vite_ssr_import_4__.AuthError) return c.json({ error: "unauthorized", reason: err.reason }, 401);
      throw err;
    };
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", detail: "body was not valid JSON" }, 400);
    };
    const parsed = parseCheckoutRequest(rawBody);
    if (!parsed.ok) {
      return c.json(
        { error: parsed.code, detail: parsed.detail },
        parsed.code === "unsupported_quantity" || parsed.code === "invalid_max_spend" ? 422 : 400
      );
    };
    const request = parsed.value;
    const authorized = await authorizeBuyer(request.buyerOrgId, actingUserId, loadOrgs, c.env.DB);
    if (!authorized.ok) {
      return c.json({ error: authorized.code, detail: authorized.detail }, 403);
    };
    const events = await (0,__vite_ssr_import_8__.loadLedgerEvents)(c.env.DB);
    const state = (0,__vite_ssr_import_5__.reduceLedger)(events);
    const orderId = await deriveOrderId(request);
    const offer = state.offers.get(request.offerId);
    if (!offer)
      return c.json(
        {
          error: "unknown_offer",
          detail: `offer ${request.offerId} is not defined in the ledger`
        },
        404
      );
    if (!offer.active)
      return c.json(
        {
          error: "inactive_offer",
          detail: `offer ${request.offerId} is inactive`
        },
        422
      );
    const product = state.products.get(offer.productId);
    if (!product)
      return c.json(
        {
          error: "unknown_product",
          detail: `product ${offer.productId} is not defined in the ledger`
        },
        404
      );
    if (offer.pricingModel === "per-use") {
      if (!offer.perUse) {
        return c.json(
          {
            error: "invalid_offer",
            detail: "per-use terms are missing from the ledger offer"
          },
          500
        );
      };
      const maxSpendMicros = request.maxSpendMicros;
      if (!Number.isSafeInteger(maxSpendMicros) || maxSpendMicros <= 0) {
        return c.json(
          {
            error: "max_spend_required",
            detail: "per-use checkout requires maxSpendMicros"
          },
          422
        );
      };
      if (maxSpendMicros < offer.perUse.unitPriceMicros) {
        return c.json(
          {
            error: "max_spend_below_unit_price",
            detail: `maxSpendMicros must cover at least one ${offer.perUse.meterUnit}`
          },
          422
        );
      };
      const channel = (0,__vite_ssr_import_6__.createMicrochargeChannel)(
        `ch_${orderId.slice("ord_".length)}`,
        BigInt(maxSpendMicros)
      );
      return c.json({
        checkoutKind: "microcharge-preflight",
        rail: "p2p-microcharge",
        preflightId: `pre_${orderId.slice("ord_".length)}`,
        channel: {
          channelId: channel.channelId,
          payer: request.buyerOrgId,
          seller: product.creatorId,
          releaseRef: product.skuRef,
          escrowMicros: channel.escrowMicros.toString(),
          committedMicros: channel.committedMicros.toString()
        },
        terms: {
          ...offer.perUse,
          currency: offer.price.currency
        }
      });
    };
    if (offer.pricingModel === "free") {
      return c.json(
        {
          error: "unsupported_pricing_model",
          detail: "free offers do not go through Checkout"
        },
        422
      );
    };
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (typeof secretKey !== "string" || !secretKey) {
      return c.json(
        {
          error: "provider_not_configured",
          detail: "STRIPE_SECRET_KEY is not configured in this deployment"
        },
        503
      );
    };
    const existingOrder = state.orders.get(orderId);
    if (existingOrder) {
      const origin = events.find((e) => e.kind === "order.created" && e.payload.orderId === orderId);
      const url = origin ? origin.payload.checkoutUrl : void 0;
      return c.json(
        { orderId, providerSessionId: existingOrder.providerRef, url: typeof url === "string" ? url : null, replayed: true },
        200
      );
    };
    const now = Date.now();
    const order = {
      orderId,
      offerId: offer.offerId,
      productId: offer.productId,
      buyerId: request.buyerOrgId,
      amount: offer.price,
      state: "pending",
      provider: __vite_ssr_import_3__.STRIPE_PROVIDER,
      providerRef: null,
      refundedMinor: 0,
      createdAtMs: now,
      updatedAtMs: now
    };
    const built = (0,__vite_ssr_import_3__.buildStripeCheckoutSessionParams)({
      order,
      offer,
      product,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl
    });
    if (!built.ok) {
      return c.json({ error: BUILD_REFUSAL_CODES[built.code] ?? "invalid_request", detail: built.detail }, 422);
    };
    const session = await (0,__vite_ssr_import_3__.createStripeCheckoutSession)({
      secretKey,
      params: built.params,
      fetchImpl,
      // Stripe's own idempotency covers the window our ledger cannot: between
      // the provider call and the append below. Scoped to the derived order id
      // so it is per-order, not per-client-string.
      idempotencyKey: orderId
    });
    if (!session.ok) {
      return c.json({ error: "provider_error", detail: session.detail }, 502);
    };
    const event = {
      ledgerEventId: `evt:order-created:${orderId}`,
      kind: "order.created",
      occurredAtMs: now,
      source: { provider: __vite_ssr_import_3__.STRIPE_PROVIDER, providerEventId: null },
      payload: {
        orderId,
        offerId: offer.offerId,
        buyerId: request.buyerOrgId,
        amount: offer.price,
        providerRef: session.sessionId,
        checkoutUrl: session.url
      }
    };
    await (0,__vite_ssr_import_8__.appendLedgerEvents)(c.env.DB, [event]);
    await (0,__vite_ssr_import_8__.projectLedger)(c.env.DB);
    return c.json({ orderId, providerSessionId: session.sessionId, url: session.url }, 201);
  });
  route.post("/commerce/webhooks/:provider", async (c) => {
    const provider = c.req.param("provider");
    const resolved = resolveAdapter(provider, c.env);
    if ("error" in resolved) {
      return resolved.error === "unknown" ? c.json({ error: "unknown_provider", provider }, 404) : c.json({ error: "provider_not_configured", provider }, 503);
    };
    const rawBody = await c.req.text();
    const headers = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const store = (0,__vite_ssr_import_8__.d1WebhookInboxStore)(c.env.DB);
    const result = await (0,__vite_ssr_import_2__.ingestWebhook)({
      adapter: resolved.adapter,
      store,
      request: { rawBody, headers, nowMs: Date.now() }
    });
    if (result.outcome === "rejected") {
      const status = SIGNATURE_REFUSALS.has(result.code) ? 401 : 400;
      return c.json({ error: result.code, detail: result.detail, provider_event_id: result.providerEventId }, status);
    };
    if (result.outcome === "duplicate") {
      return c.json({ outcome: "duplicate", provider_event_id: result.providerEventId }, 200);
    };
    if (result.outcome === "ignored") {
      return c.json({ outcome: "ignored", provider_event_id: result.providerEventId }, 202);
    };
    await (0,__vite_ssr_import_8__.appendLedgerEvents)(c.env.DB, result.events);
    await (0,__vite_ssr_import_8__.projectLedger)(c.env.DB);
    return c.json(
      {
        outcome: "accepted",
        provider_event_id: result.providerEventId,
        ledger_event_ids: result.events.map((e) => e.ledgerEventId)
      },
      200
    );
  });
  route.get("/commerce/entitlements", async (c) => {
    let actingUserId;
    try {
      actingUserId = principalId(await (0,__vite_ssr_import_4__.resolveGithubBearer)(c.req.raw));
    } catch (err) {
      if (err instanceof __vite_ssr_import_4__.AuthError) return c.json({ error: "unauthorized", reason: err.reason }, 401);
      throw err;
    };
    const buyer = c.req.query("buyer") ?? actingUserId;
    if (!buyer) return c.json({ error: "buyer_required" }, 400);
    const authorized = await authorizeBuyer(buyer, actingUserId, loadOrgs, c.env.DB);
    if (!authorized.ok) {
      return c.json({ error: authorized.code, detail: authorized.detail }, 403);
    };
    const entitlements = await (0,__vite_ssr_import_8__.listActiveEntitlements)(c.env.DB, buyer);
    return c.json({ buyer, entitlements });
  });
  return route;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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ZUFBZSxTQUFNLDhDQUF1QixFQUFFLElBQUksSUFBSSxLQUFLO0FBQ2pFLFdBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxhQUFhLENBQUM7QUFBQSxFQUN2QyxDQUFDO0FBRUQsU0FBTztBQUNUIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJjb21tZXJjZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbW1lcmNlIHdlYmhvb2sgaW50YWtlICsgZW50aXRsZW1lbnQgcmVhZCAoc2hhcmVkLXBvdCBEQU8gcGxhbiBQLTAxMDsgRC0wMjUpLlxuICpcbiAqIFRoZSBXb3JrZXIgaXMgYSBUUkFOU1BPUlQgaGVyZSwgbm90IGEgZGVjaXNpb24tbWFrZXIuIEl0IGhhbmRzIHRoZSByYXcgYm9keSBhbmRcbiAqIGhlYWRlcnMgdG8gdGhlIHNoYXJlZCBgaW5nZXN0V2ViaG9va2AsIHdoaWNoIHZlcmlmaWVzIHRoZSBzaWduYXR1cmUgQkVGT1JFXG4gKiBwYXJzaW5nLCBub3JtYWxpemVzIHRocm91Z2ggYSBgUGF5bWVudFByb3ZpZGVyQWRhcHRlcmAsIGFuZCBlbmZvcmNlc1xuICogaWRlbXBvdGVuY3k7IHRoZSBXb3JrZXIgb25seSBjaG9vc2VzIHRoZSBhZGFwdGVyLCBzdXBwbGllcyB0aGUgRDEgc3RvcmUsIGFuZFxuICogbWFwcyB0aGUgcmVzdWx0IHRvIGEgc3RhdHVzIGNvZGUuIE5vIFN0cmlwZSBmaWVsZCBuYW1lIGFuZCBubyBsZWRnZXIgcnVsZVxuICogYXBwZWFycyBpbiB0aGlzIGZpbGUuXG4gKlxuICogRmFpbC1jbG9zZWQ6IGFuIHVuY29uZmlndXJlZCBwcm92aWRlciBzZWNyZXQgaXMgYSA1MDMgKHdlIGNhbm5vdCBhdXRoZW50aWNhdGUsXG4gKiBzbyB3ZSBtdXN0IG5vdCBhY2NlcHQpLCBhbmQgZXZlcnkgc2lnbmF0dXJlIHJlZnVzYWwgaXMgYSA0MDEgdGhhdCBpcyBuZXZlclxuICogcmVjb3JkZWQg4oCUIGFuIHVuYXV0aGVudGljYXRlZCByZXF1ZXN0IG11c3Qgbm90IGJlIGFibGUgdG8gZmlsbCB0aGUgaW5ib3guXG4gKi9cblxuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHsgdmVyaWZ5U2VsbGVyUmVjZWlwdEF1dGhvcml0eSwgdHlwZSBTZWxsZXJSZWNlaXB0QXV0aG9yaXR5IH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvbWV0ZXJlZC1pbnZvY2F0aW9uJztcbmltcG9ydCB0eXBlIHsgRW52IH0gZnJvbSAnLi4vZW52LnRzJztcbmltcG9ydCB7IGluZ2VzdFdlYmhvb2sgfSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL3dlYmhvb2staW5ib3gnO1xuaW1wb3J0IHR5cGUgeyBQYXltZW50UHJvdmlkZXJBZGFwdGVyIH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC93ZWJob29rLWluYm94JztcbmltcG9ydCB7XG4gIGJ1aWxkU3RyaXBlQ2hlY2tvdXRTZXNzaW9uUGFyYW1zLFxuICBjcmVhdGVTdHJpcGVBZGFwdGVyLFxuICBjcmVhdGVTdHJpcGVDaGVja291dFNlc3Npb24sXG4gIFNUUklQRV9QUk9WSURFUixcbn0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9wYXltZW50LWFkYXB0ZXJzL3N0cmlwZSc7XG5pbXBvcnQgeyBBdXRoRXJyb3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7XG4gIFBSSUNJTkdfTU9ERUxTLFxuICByZWR1Y2VMZWRnZXIsXG4gIHR5cGUgTGVkZ2VyRXZlbnQsXG4gIHR5cGUgTW9uZXksXG4gIHR5cGUgT3JkZXIsXG4gIHR5cGUgUGVyVXNlT2ZmZXJUZXJtcyxcbiAgdHlwZSBQcmljaW5nTW9kZWwsXG59IGZyb20gXCJAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL2NvbW1lcmNlLWxlZGdlclwiO1xuaW1wb3J0IHsgY3JlYXRlTWljcm9jaGFyZ2VDaGFubmVsIH0gZnJvbSBcIkBwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL21pY3JvY2hhcmdlXCI7XG5pbXBvcnQgeyBhdXRob3JpemVPcmdBY3RvciB9IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvY3VwYm9hcmQvY29tbWVyY2UtZG9vci1nYXRlJztcbmltcG9ydCB0eXBlIHsgT3JnYW5pemF0aW9uIH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9jb21tZXJjZS1hY2NvdW50cyc7XG5pbXBvcnQge1xuICBhcHBlbmRMZWRnZXJFdmVudHMsXG4gIGQxV2ViaG9va0luYm94U3RvcmUsXG4gIGdldENvbW1lcmNlT2ZmZXIsXG4gIGxpc3RBY3RpdmVFbnRpdGxlbWVudHMsXG4gIGxpc3RDb21tZXJjZU9mZmVycyxcbiAgbG9hZExlZGdlckV2ZW50cyxcbiAgbG9hZE9yZ2FuaXphdGlvbnMsXG4gIHByb2plY3RMZWRnZXIsXG59IGZyb20gXCIuLi9jb21tZXJjZS1zdG9yZS50c1wiO1xuXG4vKiogU2lnbmF0dXJlIHJlZnVzYWxzIOKAlCB0aGUgcmVxdWVzdCBuZXZlciBwcm92ZWQgd2hvIGl0IHdhcy4gKi9cbmNvbnN0IFNJR05BVFVSRV9SRUZVU0FMUyA9IG5ldyBTZXQoW1xuICAnbWlzc2luZy1zZWNyZXQnLFxuICAnbWlzc2luZy1zaWduYXR1cmUnLFxuICAnbWFsZm9ybWVkLXNpZ25hdHVyZScsXG4gICdiYWQtc2lnbmF0dXJlJyxcbiAgJ3N0YWxlLXRpbWVzdGFtcCcsXG5dKTtcblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBhZGFwdGVyIGZvciBhIHByb3ZpZGVyIHNsdWcuIFNlY3JldHMgY29tZSBmcm9tIHRoZSBlbnZpcm9ubWVudCxcbiAqIG5ldmVyIGEgdHJlZSBmaWxlLiBBbiB1bmtub3duIHByb3ZpZGVyIGFuZCBhbiB1bmNvbmZpZ3VyZWQgb25lIGFyZSBESUZGRVJFTlRcbiAqIGFuc3dlcnM6IDQwNCBtZWFucyBcIndlIGRvIG5vdCBzcGVhayB0aGF0IHByb3ZpZGVyXCIsIDUwMyBtZWFucyBcIndlIGRvLCBidXQgdGhpc1xuICogZGVwbG95bWVudCBjYW5ub3QgYXV0aGVudGljYXRlIGl0IHlldFwiLlxuICovXG5mdW5jdGlvbiByZXNvbHZlQWRhcHRlcihwcm92aWRlcjogc3RyaW5nLCBlbnY6IEVudik6IHsgYWRhcHRlcjogUGF5bWVudFByb3ZpZGVyQWRhcHRlciB9IHwgeyBlcnJvcjogJ3Vua25vd24nIHwgJ3VuY29uZmlndXJlZCcgfSB7XG4gIGlmIChwcm92aWRlciAhPT0gU1RSSVBFX1BST1ZJREVSKSByZXR1cm4geyBlcnJvcjogJ3Vua25vd24nIH07XG4gIGNvbnN0IHNlY3JldCA9IGVudi5TVFJJUEVfV0VCSE9PS19TRUNSRVQ7XG4gIGlmICh0eXBlb2Ygc2VjcmV0ICE9PSAnc3RyaW5nJyB8fCAhc2VjcmV0KSByZXR1cm4geyBlcnJvcjogJ3VuY29uZmlndXJlZCcgfTtcbiAgcmV0dXJuIHsgYWRhcHRlcjogY3JlYXRlU3RyaXBlQWRhcHRlcih7IHdlYmhvb2tTZWNyZXQ6IHNlY3JldCB9KSB9O1xufVxuXG4vKiogRmllbGRzIGEgY2hlY2tvdXQtc2Vzc2lvbiByZXF1ZXN0IG11c3QgY2FycnksIGFmdGVyIHBhcnNpbmcuICovXG5pbnRlcmZhY2UgQ2hlY2tvdXRSZXF1ZXN0IHtcbiAgYnV5ZXJPcmdJZDogc3RyaW5nO1xuICBvZmZlcklkOiBzdHJpbmc7XG4gIHN1Y2Nlc3NVcmw6IHN0cmluZztcbiAgY2FuY2VsVXJsOiBzdHJpbmc7XG4gIGlkZW1wb3RlbmN5S2V5OiBzdHJpbmc7XG4gIHF1YW50aXR5OiBudW1iZXI7XG4gIG1heFNwZW5kTWljcm9zPzogbnVtYmVyO1xufVxuXG50eXBlIENoZWNrb3V0UGFyc2UgPSB7IG9rOiB0cnVlOyB2YWx1ZTogQ2hlY2tvdXRSZXF1ZXN0IH0gfCB7IG9rOiBmYWxzZTsgY29kZTogc3RyaW5nOyBkZXRhaWw6IHN0cmluZyB9O1xuXG5mdW5jdGlvbiBwYXJzZUNoZWNrb3V0UmVxdWVzdChyYXc6IHVua25vd24pOiBDaGVja291dFBhcnNlIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwib2JqZWN0XCIgfHwgcmF3ID09PSBudWxsKVxuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBjb2RlOiBcImludmFsaWRfcmVxdWVzdFwiLFxuICAgICAgZGV0YWlsOiBcImJvZHkgbXVzdCBiZSBhIEpTT04gb2JqZWN0XCIsXG4gICAgfTtcbiAgY29uc3QgYm9keSA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgcmVxdWlyZWQgPSBbXG4gICAgXCJidXllck9yZ0lkXCIsXG4gICAgXCJvZmZlcklkXCIsXG4gICAgXCJzdWNjZXNzVXJsXCIsXG4gICAgXCJjYW5jZWxVcmxcIixcbiAgICBcImlkZW1wb3RlbmN5S2V5XCIsXG4gIF0gYXMgY29uc3Q7XG4gIGZvciAoY29uc3QgZmllbGQgb2YgcmVxdWlyZWQpIHtcbiAgICBjb25zdCB2YWx1ZSA9IGJvZHlbZmllbGRdO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIXZhbHVlLnRyaW0oKSlcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgY29kZTogXCJpbnZhbGlkX3JlcXVlc3RcIixcbiAgICAgICAgZGV0YWlsOiBgJHtmaWVsZH0gbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgLFxuICAgICAgfTtcbiAgfVxuICAvLyBPbmx5IHF1YW50aXR5IDEgaXMgZXhwcmVzc2libGU6IGBidWlsZFN0cmlwZUNoZWNrb3V0U2Vzc2lvblBhcmFtc2AgaGFyZC1jb2Rlc1xuICAvLyBgbGluZV9pdGVtc1swXS5xdWFudGl0eSA9IDFgIGFuZCByZWZ1c2VzIHVubGVzcyB0aGUgb3JkZXIgYW1vdW50IGVxdWFscyB0aGVcbiAgLy8gb2ZmZXIgcHJpY2UgZXhhY3RseSwgc28gYSBxdWFudGl0eT4xIG9yZGVyIGNhbm5vdCBiZSBidWlsdCB3aXRob3V0IGNoYW5naW5nXG4gIC8vIHRoYXQgc2hhcmVkIGJ1aWxkZXIuIFJlZnVzaW5nIGxvdWRseSBiZWF0cyBzaWxlbnRseSBjaGFyZ2luZyBmb3Igb25lIHNlYXQuXG4gIGNvbnN0IHF1YW50aXR5ID0gYm9keS5xdWFudGl0eSA9PT0gdW5kZWZpbmVkID8gMSA6IGJvZHkucXVhbnRpdHk7XG4gIGlmIChxdWFudGl0eSAhPT0gMSlcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgY29kZTogXCJ1bnN1cHBvcnRlZF9xdWFudGl0eVwiLFxuICAgICAgZGV0YWlsOiBcIm9ubHkgcXVhbnRpdHkgMSBpcyBzdXBwb3J0ZWQgYnkgdGhlIGN1cnJlbnQgQ2hlY2tvdXQgYnVpbGRlclwiLFxuICAgIH07XG4gIGNvbnN0IG1heFNwZW5kTWljcm9zID0gYm9keS5tYXhTcGVuZE1pY3JvcztcbiAgaWYgKFxuICAgIG1heFNwZW5kTWljcm9zICE9PSB1bmRlZmluZWQgJiZcbiAgICAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1heFNwZW5kTWljcm9zKSB8fCAobWF4U3BlbmRNaWNyb3MgYXMgbnVtYmVyKSA8PSAwKVxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgY29kZTogXCJpbnZhbGlkX21heF9zcGVuZFwiLFxuICAgICAgZGV0YWlsOiBcIm1heFNwZW5kTWljcm9zIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXJcIixcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIGJ1eWVyT3JnSWQ6IFN0cmluZyhib2R5LmJ1eWVyT3JnSWQpLFxuICAgICAgb2ZmZXJJZDogU3RyaW5nKGJvZHkub2ZmZXJJZCksXG4gICAgICBzdWNjZXNzVXJsOiBTdHJpbmcoYm9keS5zdWNjZXNzVXJsKSxcbiAgICAgIGNhbmNlbFVybDogU3RyaW5nKGJvZHkuY2FuY2VsVXJsKSxcbiAgICAgIGlkZW1wb3RlbmN5S2V5OiBTdHJpbmcoYm9keS5pZGVtcG90ZW5jeUtleSksXG4gICAgICBxdWFudGl0eTogMSxcbiAgICAgIC4uLihtYXhTcGVuZE1pY3JvcyAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBtYXhTcGVuZE1pY3JvczogbWF4U3BlbmRNaWNyb3MgYXMgbnVtYmVyIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSxcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFB1Ymxpc2hPZmZlclJlcXVlc3Qge1xuICBwcm9kdWN0SWQ6IHN0cmluZztcbiAgb2ZmZXJJZDogc3RyaW5nO1xuICBza3VSZWY6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgcHJpY2luZ01vZGVsOiBQcmljaW5nTW9kZWw7XG4gIHByaWNlOiBNb25leTtcbiAgcGVyVXNlPzogUGVyVXNlT2ZmZXJUZXJtcztcbiAgcmVjZWlwdEF1dGhvcml0eT86IFNlbGxlclJlY2VpcHRBdXRob3JpdHk7XG4gIGFjdGl2ZT86IGJvb2xlYW47XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHVibGlzaE9mZmVyUmVxdWVzdChcbiAgcmF3OiB1bmtub3duLFxuKTogeyBvazogdHJ1ZTsgdmFsdWU6IFB1Ymxpc2hPZmZlclJlcXVlc3QgfSB8IHsgb2s6IGZhbHNlOyBkZXRhaWw6IHN0cmluZyB9IHtcbiAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGRldGFpbDogXCJib2R5IG11c3QgYmUgYSBKU09OIG9iamVjdFwiIH07XG4gIH1cbiAgY29uc3QgYm9keSA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgZm9yIChjb25zdCBmaWVsZCBvZiBbXCJwcm9kdWN0SWRcIiwgXCJvZmZlcklkXCIsIFwic2t1UmVmXCIsIFwidGl0bGVcIl0gYXMgY29uc3QpIHtcbiAgICBpZiAodHlwZW9mIGJvZHlbZmllbGRdICE9PSBcInN0cmluZ1wiIHx8ICEoYm9keVtmaWVsZF0gYXMgc3RyaW5nKS50cmltKCkpIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiBgJHtmaWVsZH0gbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgIH07XG4gICAgfVxuICB9XG4gIGlmICghUFJJQ0lOR19NT0RFTFMuaW5jbHVkZXMoYm9keS5wcmljaW5nTW9kZWwgYXMgUHJpY2luZ01vZGVsKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZGV0YWlsOiBcInByaWNpbmdNb2RlbCBpcyBub3Qgc3VwcG9ydGVkXCIgfTtcbiAgfVxuICBpZiAoXG4gICAgIWJvZHkucHJpY2UgfHxcbiAgICB0eXBlb2YgYm9keS5wcmljZSAhPT0gXCJvYmplY3RcIiB8fFxuICAgIEFycmF5LmlzQXJyYXkoYm9keS5wcmljZSlcbiAgKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBkZXRhaWw6IFwicHJpY2UgbXVzdCBiZSBhbiBvYmplY3RcIiB9O1xuICB9XG4gIGlmIChib2R5LmFjdGl2ZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBib2R5LmFjdGl2ZSAhPT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGRldGFpbDogXCJhY3RpdmUgbXVzdCBiZSBhIGJvb2xlYW5cIiB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIHByb2R1Y3RJZDogU3RyaW5nKGJvZHkucHJvZHVjdElkKSxcbiAgICAgIG9mZmVySWQ6IFN0cmluZyhib2R5Lm9mZmVySWQpLFxuICAgICAgc2t1UmVmOiBTdHJpbmcoYm9keS5za3VSZWYpLFxuICAgICAgdGl0bGU6IFN0cmluZyhib2R5LnRpdGxlKSxcbiAgICAgIHByaWNpbmdNb2RlbDogYm9keS5wcmljaW5nTW9kZWwgYXMgUHJpY2luZ01vZGVsLFxuICAgICAgcHJpY2U6IGJvZHkucHJpY2UgYXMgTW9uZXksXG4gICAgICAuLi4oYm9keS5wZXJVc2UgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgcGVyVXNlOiBib2R5LnBlclVzZSBhcyBQZXJVc2VPZmZlclRlcm1zIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4oYm9keS5yZWNlaXB0QXV0aG9yaXR5ICE9PSB1bmRlZmluZWQgPyB7IHJlY2VpcHRBdXRob3JpdHk6IGJvZHkucmVjZWlwdEF1dGhvcml0eSBhcyBTZWxsZXJSZWNlaXB0QXV0aG9yaXR5IH0gOiB7fSksXG4gICAgICAuLi4oYm9keS5hY3RpdmUgIT09IHVuZGVmaW5lZCA/IHsgYWN0aXZlOiBib2R5LmFjdGl2ZSB9IDoge30pLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogVGhlIG9yZGVyIGlkIElTIHRoZSBpZGVtcG90ZW5jeSByZWNvcmQuXG4gKlxuICogRGVyaXZpbmcgaXQgZnJvbSAoYnV5ZXIsIG9mZmVyLCBpZGVtcG90ZW5jeUtleSkgbWFrZXMgYSByZXBsYXkgcmVzb2x2ZSB0byB0aGVcbiAqIFNBTUUgb3JkZXIgd2l0aG91dCBhIHNlcGFyYXRlIGtleSB0YWJsZSwgYW5kIOKAlCB0aGUgcGFydCB0aGF0IG1hdHRlcnMg4oCUIGJpbmRzXG4gKiB0aGUga2V5IHRvIGl0cyBidXllcjogdHdvIGNhbGxlcnMgd2hvIGhhcHBlbiB0byBwaWNrIHRoZSBzYW1lIGlkZW1wb3RlbmN5S2V5XG4gKiBnZXQgZGlmZmVyZW50IG9yZGVycyBpbnN0ZWFkIG9mIG9uZSByZWFkaW5nIHRoZSBvdGhlcidzLiBXZWIgQ3J5cHRvIHJhdGhlclxuICogdGhhbiBgbm9kZTpjcnlwdG9gIHNvIHRoaXMgaXMgaWRlbnRpY2FsIHVuZGVyIHdvcmtlcmQgYW5kIE5vZGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlcml2ZU9yZGVySWQoaW5wdXQ6IENoZWNrb3V0UmVxdWVzdCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG1hdGVyaWFsID0gYCR7aW5wdXQuYnV5ZXJPcmdJZH1cXG4ke2lucHV0Lm9mZmVySWR9XFxuJHtpbnB1dC5pZGVtcG90ZW5jeUtleX1gO1xuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsIG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShtYXRlcmlhbCkpO1xuICBjb25zdCBoZXggPSBBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGRpZ2VzdCkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgJzAnKSlcbiAgICAuam9pbignJyk7XG4gIHJldHVybiBgb3JkXyR7aGV4LnNsaWNlKDAsIDMyKX1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb250ZW50SWQocHJlZml4OiBzdHJpbmcsIHBheWxvYWQ6IHVua25vd24pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBkaWdlc3QgPSBhd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdChcbiAgICBcIlNIQS0yNTZcIixcbiAgICBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpLFxuICApO1xuICBjb25zdCBoZXggPSBBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGRpZ2VzdCkpXG4gICAgLm1hcCgoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKVxuICAgIC5qb2luKFwiXCIpO1xuICByZXR1cm4gYCR7cHJlZml4fToke2hleC5zbGljZSgwLCAzMil9YDtcbn1cblxuLyoqIFRoZSA0MjIgY29kZXMgdGhlIHB1cmUgYnVpbGRlciBjYW4gcmVmdXNlIHdpdGgsIG1hcHBlZCB0byB0aGUgd2lyZSBjb250cmFjdC4gKi9cbmNvbnN0IEJVSUxEX1JFRlVTQUxfQ09ERVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICd1bnN1cHBvcnRlZC1wcmljaW5nLW1vZGVsJzogJ3Vuc3VwcG9ydGVkX3ByaWNpbmdfbW9kZWwnLFxuICAnYW1vdW50LW1pc21hdGNoJzogJ2Ftb3VudF9taXNtYXRjaCcsXG4gICd6ZXJvLWFtb3VudCc6ICd6ZXJvX2Ftb3VudCcsXG59O1xuXG4vKipcbiAqIFRoZSBhY3RpbmcgcHJpbmNpcGFsLCBhcyBvbmUgY2Fub25pY2FsIHN0cmluZy5cbiAqXG4gKiBUaGUgV29ya2VyJ3Mgb25seSBpZGVudGl0eSBpcyBhIEdpdEh1YiBiZWFyZXIsIHNvIHRoaXMgaXMgdGhlIE9ORSBwbGFjZSB0aGVcbiAqIGB7IGlkLCBsb2dpbiB9YCBpdCB5aWVsZHMgaXMgdHVybmVkIGludG8gdGhlIGB1c2VySWRgIHNoYXBlIFAtMDExIG1lbWJlcnNoaXBzXG4gKiBhcmUga2V5ZWQgYnkuIE51bWVyaWMgaWQgcmF0aGVyIHRoYW4gbG9naW4gYmVjYXVzZSBhIGxvZ2luIGNhbiBiZSByZW5hbWVkIGFuZFxuICogdGhlIGlkIGNhbm5vdCDigJQgYSByZW5hbWVkIGxvZ2luIHdvdWxkIHNpbGVudGx5IHN0b3AgbWF0Y2hpbmcgYSBtZW1iZXJzaGlwIGFuZFxuICogcmVhZCBhcyBcIm5vdCBhIG1lbWJlclwiIHJhdGhlciB0aGFuIGFzIGEgc3RhbGUgcmVjb3JkLlxuICpcbiAqIOKaoCBUaGlzIHN0cmluZyBtdXN0IGJlIElERU5USUNBTCB0byB0aGUgb25lIGFuIG9yZyB3cml0ZXIgcmVjb3JkcyBpblxuICogYE9yZ01lbWJlcnNoaXAudXNlcklkYCwgYmVjYXVzZSBtZW1iZXJzaGlwIGlzIG1hdGNoZWQgYnkgc3RyaW5nIGVxdWFsaXR5OiBhXG4gKiB3cml0ZXIgcmVjb3JkaW5nIGBtaWFgIHdoaWxlIHRoaXMgYXV0aGVudGljYXRlcyBgZ2g6MTIzNGAgd291bGQgbm90IGVycm9yLCBpdFxuICogd291bGQgZmluZCBubyBtZW1iZXJzaGlwIGFuZCByZWZ1c2UgZXZlcnkgbGVnaXRpbWF0ZSBtZW1iZXIgYXMgYSBzdHJhbmdlci5cbiAqIFRoZSBmb3JtIGlzIHRoZXJlZm9yZSBwaW5uZWQgYXMgc2hhcmVkIGNvZGUsIG5vdCBjb252ZW50aW9uIOKAlCBgVVNFUl9JRF9GT1JNYFxuICogLyBgaXNDYW5vbmljYWxVc2VySWRgIGluIGBjb21tZXJjZS1kb29yLWdhdGUtaW9gIChhZ3JlZWQgd2l0aCBzdS00M2UwM2JiYyxcbiAqIFdJLTIxNDYzOTEpIOKAlCBhbmQgYXNzZXJ0ZWQgYWdhaW5zdCB0aGF0IHByZWRpY2F0ZSBiZWxvdyBzbyB0aGUgdHdvIGhhbHZlc1xuICogY2Fubm90IGRyaWZ0IGFwYXJ0IHNpbGVudGx5LlxuICovXG5mdW5jdGlvbiBwcmluY2lwYWxJZCh1c2VyOiB7IGlkOiBudW1iZXIgfSk6IHN0cmluZyB7XG4gIHJldHVybiBgZ2g6JHt1c2VyLmlkfWA7XG59XG5cbi8qKlxuICogTWF5IGBhY3RpbmdVc2VySWRgIGFjdCBhcyBgYnV5ZXJJZGA/IFRoZSBPTkUgY29weSBvZiB0aGF0IHJ1bGUgaW4gdGhlIFdvcmtlci5cbiAqXG4gKiBUd28gZG9vcnMgYXNrIGl0IOKAlCBjaGVja291dCAoc3BlbmQgdGhpcyBidXllcidzIG1vbmV5LCBXSS0yMTQ2MzkxKSBhbmQgdGhlXG4gKiBlbnRpdGxlbWVudHMgcmVhZCAoc2VlIHdoYXQgdGhpcyBidXllciBvd25zLCBXSS0yMTQ2NDEyKSDigJQgYW5kIHRoZXkgbXVzdFxuICogYW5zd2VyIGlkZW50aWNhbGx5LiBBIGJ1eWVyIHdobyBtYXkgbm90IG9wZW4gYW4gb3JkZXIgbXVzdCBub3QgYmUgcmVhZGFibGVcbiAqIGVpdGhlciwgYW5kIHRoZSByZXZlcnNlIHdvdWxkIGJlIHdvcnNlOiBhIGRvb3IgdGhhdCByZWZ1c2VzIGEgcHVyY2hhc2Ugd2hpbGVcbiAqIGEgc2libGluZyBkb29yIGhhbmRzIGJhY2sgdGhlIHB1cmNoYXNlIGhpc3RvcnkgaXMgYW4gYXV0aG9yaXphdGlvbiBib3VuZGFyeVxuICogd2l0aCBhIHdpbmRvdyBjdXQgaW4gaXQuXG4gKlxuICogVHdvLCBhbmQgb25seSB0d28sIHdheXMgdG8gcGFzczpcbiAqICAgMS4gU0VMRiDigJQgdGhlIGJ1eWVyIG5hbWVkIElTIHRoZSBhdXRoZW50aWNhdGVkIHByaW5jaXBhbC4gRXhwbGljaXQgc3RyaW5nXG4gKiAgICAgIGVxdWFsaXR5IGFnYWluc3QgdGhlIGlkIHdlIGp1c3QgYXV0aGVudGljYXRlZCwgc28gaXQgaXMgdW5zcG9vZmFibGU6IGFcbiAqICAgICAgY2FsbGVyIGNhbiBvbmx5IGV2ZXIgbmFtZSB0aGVtc2VsdmVzLlxuICogICAyLiBPUkcg4oCUIGBhdXRob3JpemVPcmdBY3RvcmAgKEQtMDQ1IMKnM2QpIGNvbmZpcm1zIHRoZSBvcmcgZXhpc3RzIEFORCB0aGVcbiAqICAgICAgYWN0b3IgaXMgYSBtZW1iZXIuIFRoYXQgcnVsZSBzdGF5cyBpbiB0aGUgc2hhcmVkIGdhdGU7IHRoaXMgZnVuY3Rpb25cbiAqICAgICAgY29tcG9zZXMgaXQgd2l0aCB0aGUgc2VsZiBjYXNlIHJhdGhlciB0aGFuIHJlc3RhdGluZyBpdCwgc28gdGhlcmUgaXNcbiAqICAgICAgc3RpbGwgZXhhY3RseSBvbmUgbWVtYmVyc2hpcCBydWxlIGluIHRoZSB0cmVlLlxuICpcbiAqIFdlIGRlbGliZXJhdGVseSBkbyBOT1QgcmVhY2ggY2FzZSAyIHRocm91Z2ggYHJlc29sdmVCdXllclByaW5jaXBhbGAnc1xuICogaW5kaXZpZHVhbCBmYWxsYmFjay4gVGhhdCByZXNvbHZlciBuZXZlciBmYWlscyDigJQgYW4gaWQgbWF0Y2hpbmcgbm9cbiAqIG9yZ2FuaXphdGlvbiBjb21lcyBiYWNrIGFzIGFuIElORElWSURVQUwgYnV5ZXIgd2l0aCB0aGF0IGlkIOKAlCBzbyBsZWFuaW5nIG9uXG4gKiBpdCB3b3VsZCBtYWtlIFwib3JnIHRoYXQgZG9lcyBub3QgZXhpc3RcIiBhbmQgXCJwZXJzb25cIiBpbmRpc3Rpbmd1aXNoYWJsZSBhdCBhXG4gKiBkb29yIGRlY2lkaW5nIHdobyBtYXkgc2VlIG9yIHNwZW5kLlxuICovXG5hc3luYyBmdW5jdGlvbiBhdXRob3JpemVCdXllcihcbiAgYnV5ZXJJZDogc3RyaW5nLFxuICBhY3RpbmdVc2VySWQ6IHN0cmluZyxcbiAgbG9hZE9yZ3M6IChkYjogRDFEYXRhYmFzZSkgPT4gUHJvbWlzZTxSZWFkb25seU1hcDxzdHJpbmcsIE9yZ2FuaXphdGlvbj4+LFxuICBkYjogRDFEYXRhYmFzZSxcbik6IFByb21pc2U8eyBvazogdHJ1ZSB9IHwgeyBvazogZmFsc2U7IGNvZGU6IHN0cmluZzsgZGV0YWlsOiBzdHJpbmcgfT4ge1xuICBpZiAoYnV5ZXJJZCA9PT0gYWN0aW5nVXNlcklkKSByZXR1cm4geyBvazogdHJ1ZSB9O1xuICBjb25zdCB2ZXJkaWN0ID0gYXV0aG9yaXplT3JnQWN0b3IoYnV5ZXJJZCwgYWN0aW5nVXNlcklkLCBhd2FpdCBsb2FkT3JncyhkYikpO1xuICBpZiAodmVyZGljdC5vaykgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgLy8gVGhlIGdhdGUncyB2b2NhYnVsYXJ5LCBtYXBwZWQgdG8gdGhlIHdpcmUgY29udHJhY3QuIGB1bmtub3duLW9yZ2AgaXNcbiAgLy8gcmVwb3J0ZWQgYXMgYSBtZW1iZXJzaGlwIHF1ZXN0aW9uIHJhdGhlciB0aGFuIGEgNDA0OiB0ZWxsaW5nIGFuXG4gIC8vIHVuYXV0aG9yaXplZCBjYWxsZXIgd2hpY2ggaWRzIGV4aXN0IHdvdWxkIG1ha2UgZWl0aGVyIGRvb3IgYW5cbiAgLy8gZW51bWVyYXRpb24gb3JhY2xlIOKAlCBhIHJlZnVzYWwgbXVzdCBub3QgZGlzdGluZ3Vpc2ggXCJubyBzdWNoIGJ1eWVyXCJcbiAgLy8gZnJvbSBcIm5vdCB5b3VyIGJ1eWVyXCIuXG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGNvZGU6IHZlcmRpY3QuY29kZSA9PT0gJ2FjdG9yLW5vdC1pbi1vcmcnID8gJ25vdF9vcmdfbWVtYmVyJyA6ICdvcmdfbWVtYmVyc2hpcF91bmtub3duJyxcbiAgICBkZXRhaWw6IHZlcmRpY3QuZGV0YWlsLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tbWVyY2VSb3V0ZShcbiAgb3B0aW9uczoge1xuICAgIGZldGNoSW1wbD86IHR5cGVvZiBmZXRjaDtcbiAgICBsb2FkT3Jncz86IChkYjogRDFEYXRhYmFzZSkgPT4gUHJvbWlzZTxSZWFkb25seU1hcDxzdHJpbmcsIE9yZ2FuaXphdGlvbj4+O1xuICB9ID0ge30sXG4pOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IHJvdXRlID0gbmV3IEhvbm88eyBCaW5kaW5nczogRW52IH0+KCk7XG4gIC8vIEluamVjdGVkIHNvIHRoZSBjaGVja291dCBwYXRoIGlzIGV4ZXJjaXNhYmxlIHdpdGhvdXQgbmV0d29yayBhY2Nlc3M7IHRoZVxuICAvLyBkZWZhdWx0IGlzIHRoZSBydW50aW1lJ3Mgb3duIGZldGNoLCBib3VuZCBzbyB3b3JrZXJkIGRvZXMgbm90IHNlZSBhblxuICAvLyBpbGxlZ2FsLWludm9jYXRpb24gcmVjZWl2ZXIuXG4gIGNvbnN0IGZldGNoSW1wbDogdHlwZW9mIGZldGNoID0gb3B0aW9ucy5mZXRjaEltcGwgPz8gKChpbnB1dCwgaW5pdCkgPT4gZmV0Y2goaW5wdXQsIGluaXQpKTtcbiAgLy8gSW5qZWN0ZWQgZm9yIHRoZSBzYW1lIHJlYXNvbjogcHJvZHVjdGlvbiBoYXMgbm8gb3JnIHdyaXRlciB5ZXQsIHNvIHRoZVxuICAvLyBNRU1CRVItcGVybWl0dGVkIHBhdGggaXMgb25seSByZWFjaGFibGUgaW4gYSB0ZXN0IHVudGlsIG9uZSBsYW5kcy4gV2l0aG91dFxuICAvLyB0aGlzIHNlYW0gdGhlIG9yZyBicmFuY2ggb2YgdGhlIGdhdGUgd291bGQgYmUgdW5leGVyY2lzYWJsZSwgYW5kIGFuXG4gIC8vIHVuZXhlcmNpc2VkIGF1dGhvcml6YXRpb24gYnJhbmNoIGlzIHRoZSBvbmUgdGhhdCByb3RzLlxuICBjb25zdCBsb2FkT3JncyA9IG9wdGlvbnMubG9hZE9yZ3MgPz8gbG9hZE9yZ2FuaXphdGlvbnM7XG5cbiAgcm91dGUuZ2V0KFwiL2NvbW1lcmNlL29mZmVyc1wiLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IHByaWNpbmcgPSBjLnJlcS5xdWVyeShcInByaWNpbmdcIik7XG4gICAgaWYgKFxuICAgICAgcHJpY2luZyAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAhUFJJQ0lOR19NT0RFTFMuaW5jbHVkZXMocHJpY2luZyBhcyBQcmljaW5nTW9kZWwpXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IFwiaW52YWxpZF9wcmljaW5nX21vZGVsXCIgfSwgNDAwKTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7XG4gICAgICBvZmZlcnM6IGF3YWl0IGxpc3RDb21tZXJjZU9mZmVycyhjLmVudi5EQiwgcHJpY2luZyksXG4gICAgfSk7XG4gIH0pO1xuXG4gIHJvdXRlLmdldChcIi9jb21tZXJjZS9vZmZlcnMvOm9mZmVySWRcIiwgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvZmZlciA9IGF3YWl0IGdldENvbW1lcmNlT2ZmZXIoYy5lbnYuREIsIGMucmVxLnBhcmFtKFwib2ZmZXJJZFwiKSk7XG4gICAgcmV0dXJuIG9mZmVyID8gYy5qc29uKHsgb2ZmZXIgfSkgOiBjLmpzb24oeyBlcnJvcjogXCJ1bmtub3duX29mZmVyXCIgfSwgNDA0KTtcbiAgfSk7XG5cbiAgcm91dGUucG9zdChcIi9jb21tZXJjZS9vZmZlcnNcIiwgYXN5bmMgKGMpID0+IHtcbiAgICBsZXQgYWN0aW5nVXNlcklkOiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGFjdGluZ1VzZXJJZCA9IHByaW5jaXBhbElkKGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoZXJyIGluc3RhbmNlb2YgQXV0aEVycm9yKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogXCJ1bmF1dGhvcml6ZWRcIiwgcmVhc29uOiBlcnIucmVhc29uIH0sIDQwMSk7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuXG4gICAgbGV0IHJhd0JvZHk6IHVua25vd247XG4gICAgdHJ5IHtcbiAgICAgIHJhd0JvZHkgPSBhd2FpdCBjLnJlcS5qc29uKCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiBcImludmFsaWRfcmVxdWVzdFwiLCBkZXRhaWw6IFwiYm9keSB3YXMgbm90IHZhbGlkIEpTT05cIiB9LFxuICAgICAgICA0MDAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVB1Ymxpc2hPZmZlclJlcXVlc3QocmF3Qm9keSk7XG4gICAgaWYgKCFwYXJzZWQub2spIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogXCJpbnZhbGlkX3JlcXVlc3RcIiwgZGV0YWlsOiBwYXJzZWQuZGV0YWlsIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3QgPSBwYXJzZWQudmFsdWU7XG4gICAgaWYgKHJlcXVlc3QucmVjZWlwdEF1dGhvcml0eSAhPT0gdW5kZWZpbmVkICYmIChyZXF1ZXN0LnByaWNpbmdNb2RlbCAhPT0gJ3Blci11c2UnIHx8ICFyZXF1ZXN0LnJlY2VpcHRBdXRob3JpdHkgfHxcbiAgICAgICAgIXZlcmlmeVNlbGxlclJlY2VpcHRBdXRob3JpdHkoeyBzZWxsZXI6IGFjdGluZ1VzZXJJZCwgb2ZmZXJJZDogcmVxdWVzdC5vZmZlcklkLFxuICAgICAgICAgIHByb2R1Y3RJZDogcmVxdWVzdC5wcm9kdWN0SWQsIHNrdVJlZjogcmVxdWVzdC5za3VSZWYgfSwgcmVxdWVzdC5yZWNlaXB0QXV0aG9yaXR5KSkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfc2VsbGVyX2F1dGhvcml0eScsIGRldGFpbDogJ3RoZSBwdWJsaXNoZXIgbXVzdCBwcm92ZSBwb3NzZXNzaW9uIG9mIHRoZSBleGFjdCBvZmZlciByZWNlaXB0IGtleScgfSwgNDIyKTtcbiAgICB9XG4gICAgY29uc3QgZXZlbnRzID0gYXdhaXQgbG9hZExlZGdlckV2ZW50cyhjLmVudi5EQik7XG4gICAgY29uc3Qgc3RhdGUgPSByZWR1Y2VMZWRnZXIoZXZlbnRzKTtcbiAgICBjb25zdCBleGlzdGluZ1Byb2R1Y3QgPSBzdGF0ZS5wcm9kdWN0cy5nZXQocmVxdWVzdC5wcm9kdWN0SWQpO1xuICAgIGlmIChleGlzdGluZ1Byb2R1Y3QgJiYgZXhpc3RpbmdQcm9kdWN0LmNyZWF0b3JJZCAhPT0gYWN0aW5nVXNlcklkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6IFwicHJvZHVjdF9ub3Rfb3duZWRcIixcbiAgICAgICAgICBkZXRhaWw6IGBwcm9kdWN0ICR7cmVxdWVzdC5wcm9kdWN0SWR9IGJlbG9uZ3MgdG8gJHtleGlzdGluZ1Byb2R1Y3QuY3JlYXRvcklkfWAsXG4gICAgICAgIH0sXG4gICAgICAgIDQwMyxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGV4aXN0aW5nT2ZmZXIgPSBzdGF0ZS5vZmZlcnMuZ2V0KHJlcXVlc3Qub2ZmZXJJZCk7XG4gICAgaWYgKGV4aXN0aW5nT2ZmZXIpIHtcbiAgICAgIGNvbnN0IG93bmVyID0gc3RhdGUucHJvZHVjdHMuZ2V0KGV4aXN0aW5nT2ZmZXIucHJvZHVjdElkKT8uY3JlYXRvcklkO1xuICAgICAgaWYgKG93bmVyICE9PSBhY3RpbmdVc2VySWQpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlcnJvcjogXCJvZmZlcl9ub3Rfb3duZWRcIixcbiAgICAgICAgICAgIGRldGFpbDogYG9mZmVyICR7cmVxdWVzdC5vZmZlcklkfSBiZWxvbmdzIHRvICR7b3duZXIgPz8gXCJhbiB1bmtub3duIGNyZWF0b3JcIn1gLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgNDAzLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgcHJvZHVjdFBheWxvYWQgPSB7XG4gICAgICBwcm9kdWN0SWQ6IHJlcXVlc3QucHJvZHVjdElkLFxuICAgICAgc2t1UmVmOiByZXF1ZXN0LnNrdVJlZixcbiAgICAgIGNyZWF0b3JJZDogYWN0aW5nVXNlcklkLFxuICAgICAgdGl0bGU6IHJlcXVlc3QudGl0bGUsXG4gICAgICBhY3RpdmU6IHJlcXVlc3QuYWN0aXZlICE9PSBmYWxzZSxcbiAgICB9O1xuICAgIGNvbnN0IG9mZmVyUGF5bG9hZCA9IHtcbiAgICAgIG9mZmVySWQ6IHJlcXVlc3Qub2ZmZXJJZCxcbiAgICAgIHByb2R1Y3RJZDogcmVxdWVzdC5wcm9kdWN0SWQsXG4gICAgICBwcmljaW5nTW9kZWw6IHJlcXVlc3QucHJpY2luZ01vZGVsLFxuICAgICAgcHJpY2U6IHJlcXVlc3QucHJpY2UsXG4gICAgICAuLi4ocmVxdWVzdC5wZXJVc2UgIT09IHVuZGVmaW5lZCA/IHsgcGVyVXNlOiByZXF1ZXN0LnBlclVzZSB9IDoge30pLFxuICAgICAgLi4uKHJlcXVlc3QucmVjZWlwdEF1dGhvcml0eSA/IHsgcmVjZWlwdEF1dGhvcml0eTogcmVxdWVzdC5yZWNlaXB0QXV0aG9yaXR5IH0gOiB7fSksXG4gICAgICBhY3RpdmU6IHJlcXVlc3QuYWN0aXZlICE9PSBmYWxzZSxcbiAgICB9O1xuICAgIGNvbnN0IGNhbmRpZGF0ZTogTGVkZ2VyRXZlbnRbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgbGVkZ2VyRXZlbnRJZDogYXdhaXQgY29udGVudElkKFwiZXZ0OnByb2R1Y3QtZGVmaW5lZFwiLCBwcm9kdWN0UGF5bG9hZCksXG4gICAgICAgIGtpbmQ6IFwicHJvZHVjdC5kZWZpbmVkXCIsXG4gICAgICAgIG9jY3VycmVkQXRNczogbm93LFxuICAgICAgICBzb3VyY2U6IHsgcHJvdmlkZXI6IFwib3BlcmF0b3JcIiwgcHJvdmlkZXJFdmVudElkOiBudWxsIH0sXG4gICAgICAgIHBheWxvYWQ6IHByb2R1Y3RQYXlsb2FkLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgbGVkZ2VyRXZlbnRJZDogYXdhaXQgY29udGVudElkKFwiZXZ0Om9mZmVyLWRlZmluZWRcIiwgb2ZmZXJQYXlsb2FkKSxcbiAgICAgICAga2luZDogXCJvZmZlci5kZWZpbmVkXCIsXG4gICAgICAgIG9jY3VycmVkQXRNczogbm93ICsgMSxcbiAgICAgICAgc291cmNlOiB7IHByb3ZpZGVyOiBcIm9wZXJhdG9yXCIsIHByb3ZpZGVyRXZlbnRJZDogbnVsbCB9LFxuICAgICAgICBwYXlsb2FkOiBvZmZlclBheWxvYWQsXG4gICAgICB9LFxuICAgIF0ubWFwKChldmVudCkgPT4ge1xuICAgICAgLy8gQW4gZXZlbnQgaWQgZGVyaXZlcyBmcm9tIHRoZSBjb250ZW50LCB3aGlsZSB0aGUgcmVkdWNlciBkaWdlc3RzIGl0c1xuICAgICAgLy8gdGltZXN0YW1wIHRvby4gQW4gZXhhY3QgcmV0cnkgbXVzdCByZXRhaW4gdGhlIG9yaWdpbmFsIHNpZ25lZCBmYWN0J3NcbiAgICAgIC8vIHRpbWUuIEV2ZXJ5IG90aGVyIGZpZWxkIHN0aWxsIHJlYWNoZXMgZHVwbGljYXRlLWNvbmZsaWN0IHZhbGlkYXRpb24uXG4gICAgICBjb25zdCBwcmlvciA9IGV2ZW50cy5maW5kKChzdG9yZWQpID0+IHN0b3JlZC5sZWRnZXJFdmVudElkID09PSBldmVudC5sZWRnZXJFdmVudElkKTtcbiAgICAgIHJldHVybiB7IC4uLmV2ZW50LCBvY2N1cnJlZEF0TXM6IHByaW9yPy5vY2N1cnJlZEF0TXMgPz8gZXZlbnQub2NjdXJyZWRBdE1zIH0gYXMgTGVkZ2VyRXZlbnQ7XG4gICAgfSk7XG4gICAgY29uc3QgY2FuZGlkYXRlSWRzID0gbmV3IFNldChjYW5kaWRhdGUubWFwKChldmVudCkgPT4gZXZlbnQubGVkZ2VyRXZlbnRJZCkpO1xuICAgIGNvbnN0IHByb2plY3RlZCA9IHJlZHVjZUxlZGdlcihbLi4uZXZlbnRzLCAuLi5jYW5kaWRhdGVdKTtcbiAgICBjb25zdCByZWplY3Rpb24gPSBwcm9qZWN0ZWQucmVqZWN0ZWQuZmluZCgocm93KSA9PlxuICAgICAgY2FuZGlkYXRlSWRzLmhhcyhyb3cubGVkZ2VyRXZlbnRJZCksXG4gICAgKTtcbiAgICBpZiAocmVqZWN0aW9uKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6IFwiaW52YWxpZF9vZmZlclwiLFxuICAgICAgICAgIGNvZGU6IHJlamVjdGlvbi5jb2RlLFxuICAgICAgICAgIGRldGFpbDogcmVqZWN0aW9uLmRldGFpbCxcbiAgICAgICAgfSxcbiAgICAgICAgNDIyLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZXhpc3RpbmdJZHMgPSBuZXcgU2V0KGV2ZW50cy5tYXAoKGV2ZW50KSA9PiBldmVudC5sZWRnZXJFdmVudElkKSk7XG4gICAgY29uc3QgcmVwbGF5ZWQgPSBjYW5kaWRhdGUuZXZlcnkoKGV2ZW50KSA9PlxuICAgICAgZXhpc3RpbmdJZHMuaGFzKGV2ZW50LmxlZGdlckV2ZW50SWQpLFxuICAgICk7XG4gICAgYXdhaXQgYXBwZW5kTGVkZ2VyRXZlbnRzKGMuZW52LkRCLCBjYW5kaWRhdGUpO1xuICAgIGF3YWl0IHByb2plY3RMZWRnZXIoYy5lbnYuREIpO1xuICAgIGNvbnN0IG9mZmVyID0gYXdhaXQgZ2V0Q29tbWVyY2VPZmZlcihjLmVudi5EQiwgcmVxdWVzdC5vZmZlcklkKTtcbiAgICBjb25zdCBwcm9kdWN0ID0gcHJvamVjdGVkLnByb2R1Y3RzLmdldChyZXF1ZXN0LnByb2R1Y3RJZCk7XG4gICAgaWYgKCFvZmZlciB8fCAhcHJvZHVjdCkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiBcInByb2plY3Rpb25fZmFpbGVkXCIsXG4gICAgICAgICAgZGV0YWlsOiBcIm9mZmVyIGRpZCBub3QgYXBwZWFyIGluIHRoZSBEMSBwcm9qZWN0aW9uXCIsXG4gICAgICAgIH0sXG4gICAgICAgIDUwMCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oeyByZXBsYXllZCwgcHJvZHVjdCwgb2ZmZXIgfSwgcmVwbGF5ZWQgPyAyMDAgOiAyMDEpO1xuICB9KTtcblxuICByb3V0ZS5wb3N0KCcvY29tbWVyY2UvY2hlY2tvdXQtc2Vzc2lvbnMnLCBhc3luYyAoYykgPT4ge1xuICAgIC8vIEF1dGhlbnRpY2F0ZSBGSVJTVDogdGhpcyBlbmRwb2ludCBvcGVucyByZWFsIG9yZGVycyBhbmQgcmVhbCBDaGVja291dFxuICAgIC8vIFNlc3Npb25zLCBzbyBhbiBhbm9ueW1vdXMgY2FsbGVyIG11c3Qgbm90IGV2ZW4gbGVhcm4gd2hldGhlciB0aGlzXG4gICAgLy8gZGVwbG95bWVudCBoYXMgU3RyaXBlIGNvbmZpZ3VyZWQuXG4gICAgLy9cbiAgICAvLyBUaGlzIGVzdGFibGlzaGVzIFdITyBpcyBjYWxsaW5nOyB3aGV0aGVyIHRoZXkgbWF5IGFjdCBmb3IgYGJ1eWVyT3JnSWRgXG4gICAgLy8gaXMgYSBTRVBBUkFURSBxdWVzdGlvbiwgYW5zd2VyZWQgYmVsb3cgb25jZSB0aGUgYm9keSBoYXMgYmVlbiBwYXJzZWRcbiAgICAvLyAoV0ktMjE0NjM5MSDigJQgdGhhdCBjaGVjayB1c2VkIHRvIGJlIG1pc3NpbmcgZW50aXJlbHkpLlxuICAgIGxldCBhY3RpbmdVc2VySWQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgYWN0aW5nVXNlcklkID0gcHJpbmNpcGFsSWQoYXdhaXQgcmVzb2x2ZUdpdGh1YkJlYXJlcihjLnJlcS5yYXcpKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3VuYXV0aG9yaXplZCcsIHJlYXNvbjogZXJyLnJlYXNvbiB9LCA0MDEpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cblxuICAgIGxldCByYXdCb2R5OiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICByYXdCb2R5ID0gYXdhaXQgYy5yZXEuanNvbigpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JywgZGV0YWlsOiAnYm9keSB3YXMgbm90IHZhbGlkIEpTT04nIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlQ2hlY2tvdXRSZXF1ZXN0KHJhd0JvZHkpO1xuICAgIGlmICghcGFyc2VkLm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiBwYXJzZWQuY29kZSwgZGV0YWlsOiBwYXJzZWQuZGV0YWlsIH0sXG4gICAgICAgIHBhcnNlZC5jb2RlID09PSBcInVuc3VwcG9ydGVkX3F1YW50aXR5XCIgfHxcbiAgICAgICAgICBwYXJzZWQuY29kZSA9PT0gXCJpbnZhbGlkX21heF9zcGVuZFwiXG4gICAgICAgICAgPyA0MjJcbiAgICAgICAgICA6IDQwMCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3QgPSBwYXJzZWQudmFsdWU7XG5cbiAgICAvLyBBVVRIT1JJWkFUSU9OIChXSS0yMTQ2MzkxKS4gVGhlIHJ1bGUgaXRzZWxmIGlzIGBhdXRob3JpemVCdXllcmAgYWJvdmUsXG4gICAgLy8gc2hhcmVkIHdpdGggdGhlIGVudGl0bGVtZW50cyByZWFkLiBXaGF0IGlzIHNwZWNpZmljIHRvIFRISVMgZG9vciBpcyB0aGVcbiAgICAvLyBPUkRFUklORzogaXQgcnVucyBCRUZPUkUgdGhlIGlkZW1wb3RlbnQtcmVwbGF5IGJyYW5jaCBvbiBwdXJwb3NlLCBiZWNhdXNlXG4gICAgLy8gcmVwbGF5IHJldHVybnMgdGhlIG9yaWdpbmFsIG9yZGVyJ3MgQ2hlY2tvdXQgVVJMLCBzbyBydW5uaW5nIHRoaXMgY2hlY2tcbiAgICAvLyBhZnRlcndhcmRzIHdvdWxkIGxldCBhIG5vbi1tZW1iZXIgcmVwbGF5IGEgbWVtYmVyJ3Mga2V5IGFuZCByZWFkIGJhY2sgYVxuICAgIC8vIGxpdmUgcGF5bWVudCBoYW5kbGUgd2l0aCBhIDIwMC4gQW4gYXV0aG9yaXphdGlvbiBjaGVjayB0aGF0IHNpdHMgYmVoaW5kIGFcbiAgICAvLyBjYWNoZSBpcyBub3QgYW4gYXV0aG9yaXphdGlvbiBjaGVjay5cbiAgICBjb25zdCBhdXRob3JpemVkID0gYXdhaXQgYXV0aG9yaXplQnV5ZXIocmVxdWVzdC5idXllck9yZ0lkLCBhY3RpbmdVc2VySWQsIGxvYWRPcmdzLCBjLmVudi5EQik7XG4gICAgaWYgKCFhdXRob3JpemVkLm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGF1dGhvcml6ZWQuY29kZSwgZGV0YWlsOiBhdXRob3JpemVkLmRldGFpbCB9LCA0MDMpO1xuICAgIH1cblxuICAgIGNvbnN0IGV2ZW50cyA9IGF3YWl0IGxvYWRMZWRnZXJFdmVudHMoYy5lbnYuREIpO1xuICAgIGNvbnN0IHN0YXRlID0gcmVkdWNlTGVkZ2VyKGV2ZW50cyk7XG4gICAgY29uc3Qgb3JkZXJJZCA9IGF3YWl0IGRlcml2ZU9yZGVySWQocmVxdWVzdCk7XG5cbiAgICBjb25zdCBvZmZlciA9IHN0YXRlLm9mZmVycy5nZXQocmVxdWVzdC5vZmZlcklkKTtcbiAgICBpZiAoIW9mZmVyKVxuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiBcInVua25vd25fb2ZmZXJcIixcbiAgICAgICAgICBkZXRhaWw6IGBvZmZlciAke3JlcXVlc3Qub2ZmZXJJZH0gaXMgbm90IGRlZmluZWQgaW4gdGhlIGxlZGdlcmAsXG4gICAgICAgIH0sXG4gICAgICAgIDQwNCxcbiAgICAgICk7XG4gICAgaWYgKCFvZmZlci5hY3RpdmUpXG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6IFwiaW5hY3RpdmVfb2ZmZXJcIixcbiAgICAgICAgICBkZXRhaWw6IGBvZmZlciAke3JlcXVlc3Qub2ZmZXJJZH0gaXMgaW5hY3RpdmVgLFxuICAgICAgICB9LFxuICAgICAgICA0MjIsXG4gICAgICApO1xuICAgIGNvbnN0IHByb2R1Y3QgPSBzdGF0ZS5wcm9kdWN0cy5nZXQob2ZmZXIucHJvZHVjdElkKTtcbiAgICBpZiAoIXByb2R1Y3QpXG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6IFwidW5rbm93bl9wcm9kdWN0XCIsXG4gICAgICAgICAgZGV0YWlsOiBgcHJvZHVjdCAke29mZmVyLnByb2R1Y3RJZH0gaXMgbm90IGRlZmluZWQgaW4gdGhlIGxlZGdlcmAsXG4gICAgICAgIH0sXG4gICAgICAgIDQwNCxcbiAgICAgICk7XG5cbiAgICBpZiAob2ZmZXIucHJpY2luZ01vZGVsID09PSBcInBlci11c2VcIikge1xuICAgICAgaWYgKCFvZmZlci5wZXJVc2UpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlcnJvcjogXCJpbnZhbGlkX29mZmVyXCIsXG4gICAgICAgICAgICBkZXRhaWw6IFwicGVyLXVzZSB0ZXJtcyBhcmUgbWlzc2luZyBmcm9tIHRoZSBsZWRnZXIgb2ZmZXJcIixcbiAgICAgICAgICB9LFxuICAgICAgICAgIDUwMCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG1heFNwZW5kTWljcm9zID0gcmVxdWVzdC5tYXhTcGVuZE1pY3JvcztcbiAgICAgIGlmIChcbiAgICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1heFNwZW5kTWljcm9zKSB8fFxuICAgICAgICAobWF4U3BlbmRNaWNyb3MgYXMgbnVtYmVyKSA8PSAwXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBlcnJvcjogXCJtYXhfc3BlbmRfcmVxdWlyZWRcIixcbiAgICAgICAgICAgIGRldGFpbDogXCJwZXItdXNlIGNoZWNrb3V0IHJlcXVpcmVzIG1heFNwZW5kTWljcm9zXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgICA0MjIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoKG1heFNwZW5kTWljcm9zIGFzIG51bWJlcikgPCBvZmZlci5wZXJVc2UudW5pdFByaWNlTWljcm9zKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgICAge1xuICAgICAgICAgICAgZXJyb3I6IFwibWF4X3NwZW5kX2JlbG93X3VuaXRfcHJpY2VcIixcbiAgICAgICAgICAgIGRldGFpbDogYG1heFNwZW5kTWljcm9zIG11c3QgY292ZXIgYXQgbGVhc3Qgb25lICR7b2ZmZXIucGVyVXNlLm1ldGVyVW5pdH1gLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgNDIyLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgY2hhbm5lbCA9IGNyZWF0ZU1pY3JvY2hhcmdlQ2hhbm5lbChcbiAgICAgICAgYGNoXyR7b3JkZXJJZC5zbGljZShcIm9yZF9cIi5sZW5ndGgpfWAsXG4gICAgICAgIEJpZ0ludChtYXhTcGVuZE1pY3JvcyBhcyBudW1iZXIpLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgICBjaGVja291dEtpbmQ6IFwibWljcm9jaGFyZ2UtcHJlZmxpZ2h0XCIsXG4gICAgICAgIHJhaWw6IFwicDJwLW1pY3JvY2hhcmdlXCIsXG4gICAgICAgIHByZWZsaWdodElkOiBgcHJlXyR7b3JkZXJJZC5zbGljZShcIm9yZF9cIi5sZW5ndGgpfWAsXG4gICAgICAgIGNoYW5uZWw6IHtcbiAgICAgICAgICBjaGFubmVsSWQ6IGNoYW5uZWwuY2hhbm5lbElkLFxuICAgICAgICAgIHBheWVyOiByZXF1ZXN0LmJ1eWVyT3JnSWQsXG4gICAgICAgICAgc2VsbGVyOiBwcm9kdWN0LmNyZWF0b3JJZCxcbiAgICAgICAgICByZWxlYXNlUmVmOiBwcm9kdWN0LnNrdVJlZixcbiAgICAgICAgICBlc2Nyb3dNaWNyb3M6IGNoYW5uZWwuZXNjcm93TWljcm9zLnRvU3RyaW5nKCksXG4gICAgICAgICAgY29tbWl0dGVkTWljcm9zOiBjaGFubmVsLmNvbW1pdHRlZE1pY3Jvcy50b1N0cmluZygpLFxuICAgICAgICB9LFxuICAgICAgICB0ZXJtczoge1xuICAgICAgICAgIC4uLm9mZmVyLnBlclVzZSxcbiAgICAgICAgICBjdXJyZW5jeTogb2ZmZXIucHJpY2UuY3VycmVuY3ksXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAob2ZmZXIucHJpY2luZ01vZGVsID09PSBcImZyZWVcIikge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiBcInVuc3VwcG9ydGVkX3ByaWNpbmdfbW9kZWxcIixcbiAgICAgICAgICBkZXRhaWw6IFwiZnJlZSBvZmZlcnMgZG8gbm90IGdvIHRocm91Z2ggQ2hlY2tvdXRcIixcbiAgICAgICAgfSxcbiAgICAgICAgNDIyLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBGYWlsIENMT1NFRCBmb3IgcHJvdmlkZXItYmFja2VkIHByaWNpbmcgb25seS4gQSBwZXItdXNlIG9mZmVyIG5ldmVyXG4gICAgLy8gdG91Y2hlcyBTdHJpcGUgYW5kIHRoZXJlZm9yZSBtdXN0IG5vdCBiZSBoZWxkIGhvc3RhZ2UgYnkgaXRzIHNlY3JldC5cbiAgICBjb25zdCBzZWNyZXRLZXkgPSBjLmVudi5TVFJJUEVfU0VDUkVUX0tFWTtcbiAgICBpZiAodHlwZW9mIHNlY3JldEtleSAhPT0gXCJzdHJpbmdcIiB8fCAhc2VjcmV0S2V5KSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6IFwicHJvdmlkZXJfbm90X2NvbmZpZ3VyZWRcIixcbiAgICAgICAgICBkZXRhaWw6IFwiU1RSSVBFX1NFQ1JFVF9LRVkgaXMgbm90IGNvbmZpZ3VyZWQgaW4gdGhpcyBkZXBsb3ltZW50XCIsXG4gICAgICAgIH0sXG4gICAgICAgIDUwMyxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gSWRlbXBvdGVudCByZXBsYXk6IHRoZSBvcmRlciBhbHJlYWR5IGV4aXN0cywgc28gcmV0dXJuIHRoZSBPUklHSU5BTFxuICAgIC8vIGhhbmRsZSByYXRoZXIgdGhhbiBvcGVuaW5nIGEgc2Vjb25kIENoZWNrb3V0IFNlc3Npb24uIFRoZSBwcm92aWRlciByZWZcbiAgICAvLyBsaXZlcyBvbiB0aGUgb3JkZXI7IHRoZSBVUkwgaXMgbm90IHJlZHVjZXIgc3RhdGUsIHNvIGl0IGlzIHJlYWQgYmFjayBmcm9tXG4gICAgLy8gdGhlIG9yaWdpbmF0aW5nIGV2ZW50J3MgcGF5bG9hZC5cbiAgICBjb25zdCBleGlzdGluZ09yZGVyID0gc3RhdGUub3JkZXJzLmdldChvcmRlcklkKTtcbiAgICBpZiAoZXhpc3RpbmdPcmRlcikge1xuICAgICAgY29uc3Qgb3JpZ2luID0gZXZlbnRzLmZpbmQoKGUpID0+IGUua2luZCA9PT0gJ29yZGVyLmNyZWF0ZWQnICYmIChlLnBheWxvYWQgYXMgeyBvcmRlcklkPzogdW5rbm93biB9KS5vcmRlcklkID09PSBvcmRlcklkKTtcbiAgICAgIGNvbnN0IHVybCA9IG9yaWdpbiA/IChvcmlnaW4ucGF5bG9hZCBhcyB7IGNoZWNrb3V0VXJsPzogdW5rbm93biB9KS5jaGVja291dFVybCA6IHVuZGVmaW5lZDtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHsgb3JkZXJJZCwgcHJvdmlkZXJTZXNzaW9uSWQ6IGV4aXN0aW5nT3JkZXIucHJvdmlkZXJSZWYsIHVybDogdHlwZW9mIHVybCA9PT0gJ3N0cmluZycgPyB1cmwgOiBudWxsLCByZXBsYXllZDogdHJ1ZSB9LFxuICAgICAgICAyMDAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3Qgb3JkZXI6IE9yZGVyID0ge1xuICAgICAgb3JkZXJJZCxcbiAgICAgIG9mZmVySWQ6IG9mZmVyLm9mZmVySWQsXG4gICAgICBwcm9kdWN0SWQ6IG9mZmVyLnByb2R1Y3RJZCxcbiAgICAgIGJ1eWVySWQ6IHJlcXVlc3QuYnV5ZXJPcmdJZCxcbiAgICAgIGFtb3VudDogb2ZmZXIucHJpY2UsXG4gICAgICBzdGF0ZTogJ3BlbmRpbmcnLFxuICAgICAgcHJvdmlkZXI6IFNUUklQRV9QUk9WSURFUixcbiAgICAgIHByb3ZpZGVyUmVmOiBudWxsLFxuICAgICAgcmVmdW5kZWRNaW5vcjogMCxcbiAgICAgIGNyZWF0ZWRBdE1zOiBub3csXG4gICAgICB1cGRhdGVkQXRNczogbm93LFxuICAgIH07XG5cbiAgICBjb25zdCBidWlsdCA9IGJ1aWxkU3RyaXBlQ2hlY2tvdXRTZXNzaW9uUGFyYW1zKHtcbiAgICAgIG9yZGVyLFxuICAgICAgb2ZmZXIsXG4gICAgICBwcm9kdWN0LFxuICAgICAgc3VjY2Vzc1VybDogcmVxdWVzdC5zdWNjZXNzVXJsLFxuICAgICAgY2FuY2VsVXJsOiByZXF1ZXN0LmNhbmNlbFVybCxcbiAgICB9KTtcbiAgICBpZiAoIWJ1aWx0Lm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IEJVSUxEX1JFRlVTQUxfQ09ERVNbYnVpbHQuY29kZV0gPz8gJ2ludmFsaWRfcmVxdWVzdCcsIGRldGFpbDogYnVpbHQuZGV0YWlsIH0sIDQyMik7XG4gICAgfVxuXG4gICAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVN0cmlwZUNoZWNrb3V0U2Vzc2lvbih7XG4gICAgICBzZWNyZXRLZXksXG4gICAgICBwYXJhbXM6IGJ1aWx0LnBhcmFtcyxcbiAgICAgIGZldGNoSW1wbCxcbiAgICAgIC8vIFN0cmlwZSdzIG93biBpZGVtcG90ZW5jeSBjb3ZlcnMgdGhlIHdpbmRvdyBvdXIgbGVkZ2VyIGNhbm5vdDogYmV0d2VlblxuICAgICAgLy8gdGhlIHByb3ZpZGVyIGNhbGwgYW5kIHRoZSBhcHBlbmQgYmVsb3cuIFNjb3BlZCB0byB0aGUgZGVyaXZlZCBvcmRlciBpZFxuICAgICAgLy8gc28gaXQgaXMgcGVyLW9yZGVyLCBub3QgcGVyLWNsaWVudC1zdHJpbmcuXG4gICAgICBpZGVtcG90ZW5jeUtleTogb3JkZXJJZCxcbiAgICB9KTtcbiAgICBpZiAoIXNlc3Npb24ub2spIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Byb3ZpZGVyX2Vycm9yJywgZGV0YWlsOiBzZXNzaW9uLmRldGFpbCB9LCA1MDIpO1xuICAgIH1cblxuICAgIC8vIFJlY29yZGVkIG9ubHkgQUZURVIgdGhlIHByb3ZpZGVyIGNvbmZpcm1lZCDigJQgYSBsZWRnZXIgb3JkZXIuY3JlYXRlZCB3aG9zZVxuICAgIC8vIHNlc3Npb24gZG9lcyBub3QgZXhpc3Qgd291bGQgYmUgYW4gb3JkZXIgbm90aGluZyBjYW4gZXZlciBwYXkuXG4gICAgY29uc3QgZXZlbnQ6IExlZGdlckV2ZW50ID0ge1xuICAgICAgbGVkZ2VyRXZlbnRJZDogYGV2dDpvcmRlci1jcmVhdGVkOiR7b3JkZXJJZH1gLFxuICAgICAga2luZDogJ29yZGVyLmNyZWF0ZWQnLFxuICAgICAgb2NjdXJyZWRBdE1zOiBub3csXG4gICAgICBzb3VyY2U6IHsgcHJvdmlkZXI6IFNUUklQRV9QUk9WSURFUiwgcHJvdmlkZXJFdmVudElkOiBudWxsIH0sXG4gICAgICBwYXlsb2FkOiB7XG4gICAgICAgIG9yZGVySWQsXG4gICAgICAgIG9mZmVySWQ6IG9mZmVyLm9mZmVySWQsXG4gICAgICAgIGJ1eWVySWQ6IHJlcXVlc3QuYnV5ZXJPcmdJZCxcbiAgICAgICAgYW1vdW50OiBvZmZlci5wcmljZSxcbiAgICAgICAgcHJvdmlkZXJSZWY6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgICBjaGVja291dFVybDogc2Vzc2lvbi51cmwsXG4gICAgICB9LFxuICAgIH07XG4gICAgYXdhaXQgYXBwZW5kTGVkZ2VyRXZlbnRzKGMuZW52LkRCLCBbZXZlbnRdKTtcbiAgICBhd2FpdCBwcm9qZWN0TGVkZ2VyKGMuZW52LkRCKTtcblxuICAgIHJldHVybiBjLmpzb24oeyBvcmRlcklkLCBwcm92aWRlclNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsIHVybDogc2Vzc2lvbi51cmwgfSwgMjAxKTtcbiAgfSk7XG5cbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL3dlYmhvb2tzLzpwcm92aWRlcicsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgcHJvdmlkZXIgPSBjLnJlcS5wYXJhbSgncHJvdmlkZXInKTtcbiAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVBZGFwdGVyKHByb3ZpZGVyLCBjLmVudik7XG4gICAgaWYgKCdlcnJvcicgaW4gcmVzb2x2ZWQpIHtcbiAgICAgIHJldHVybiByZXNvbHZlZC5lcnJvciA9PT0gJ3Vua25vd24nXG4gICAgICAgID8gYy5qc29uKHsgZXJyb3I6ICd1bmtub3duX3Byb3ZpZGVyJywgcHJvdmlkZXIgfSwgNDA0KVxuICAgICAgICA6IGMuanNvbih7IGVycm9yOiAncHJvdmlkZXJfbm90X2NvbmZpZ3VyZWQnLCBwcm92aWRlciB9LCA1MDMpO1xuICAgIH1cblxuICAgIC8vIFRoZSBzaWduYXR1cmUgY292ZXJzIHRoZSBFWEFDVCBieXRlcyBzZW50IOKAlCByZWFkIHRoZSByYXcgYm9keSwgbmV2ZXIgYVxuICAgIC8vIHJlLXNlcmlhbGl6ZWQgSlNPTiByb3VuZC10cmlwLCB3aGljaCB3b3VsZCBjaGFuZ2UgdGhlbSBhbmQgbmV2ZXIgdmVyaWZ5LlxuICAgIGNvbnN0IHJhd0JvZHkgPSBhd2FpdCBjLnJlcS50ZXh0KCk7XG4gICAgY29uc3QgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGMucmVxLnJhdy5oZWFkZXJzLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgIGhlYWRlcnNba2V5XSA9IHZhbHVlO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RvcmUgPSBkMVdlYmhvb2tJbmJveFN0b3JlKGMuZW52LkRCKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbmdlc3RXZWJob29rKHtcbiAgICAgIGFkYXB0ZXI6IHJlc29sdmVkLmFkYXB0ZXIsXG4gICAgICBzdG9yZSxcbiAgICAgIHJlcXVlc3Q6IHsgcmF3Qm9keSwgaGVhZGVycywgbm93TXM6IERhdGUubm93KCkgfSxcbiAgICB9KTtcblxuICAgIGlmIChyZXN1bHQub3V0Y29tZSA9PT0gJ3JlamVjdGVkJykge1xuICAgICAgY29uc3Qgc3RhdHVzID0gU0lHTkFUVVJFX1JFRlVTQUxTLmhhcyhyZXN1bHQuY29kZSkgPyA0MDEgOiA0MDA7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHJlc3VsdC5jb2RlLCBkZXRhaWw6IHJlc3VsdC5kZXRhaWwsIHByb3ZpZGVyX2V2ZW50X2lkOiByZXN1bHQucHJvdmlkZXJFdmVudElkIH0sIHN0YXR1cyk7XG4gICAgfVxuICAgIGlmIChyZXN1bHQub3V0Y29tZSA9PT0gJ2R1cGxpY2F0ZScpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBvdXRjb21lOiAnZHVwbGljYXRlJywgcHJvdmlkZXJfZXZlbnRfaWQ6IHJlc3VsdC5wcm92aWRlckV2ZW50SWQgfSwgMjAwKTtcbiAgICB9XG4gICAgaWYgKHJlc3VsdC5vdXRjb21lID09PSAnaWdub3JlZCcpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBvdXRjb21lOiAnaWdub3JlZCcsIHByb3ZpZGVyX2V2ZW50X2lkOiByZXN1bHQucHJvdmlkZXJFdmVudElkIH0sIDIwMik7XG4gICAgfVxuXG4gICAgYXdhaXQgYXBwZW5kTGVkZ2VyRXZlbnRzKGMuZW52LkRCLCByZXN1bHQuZXZlbnRzKTtcbiAgICBhd2FpdCBwcm9qZWN0TGVkZ2VyKGMuZW52LkRCKTtcbiAgICByZXR1cm4gYy5qc29uKFxuICAgICAge1xuICAgICAgICBvdXRjb21lOiAnYWNjZXB0ZWQnLFxuICAgICAgICBwcm92aWRlcl9ldmVudF9pZDogcmVzdWx0LnByb3ZpZGVyRXZlbnRJZCxcbiAgICAgICAgbGVkZ2VyX2V2ZW50X2lkczogcmVzdWx0LmV2ZW50cy5tYXAoKGUpID0+IGUubGVkZ2VyRXZlbnRJZCksXG4gICAgICB9LFxuICAgICAgMjAwLFxuICAgICk7XG4gIH0pO1xuXG4gIHJvdXRlLmdldCgnL2NvbW1lcmNlL2VudGl0bGVtZW50cycsIGFzeW5jIChjKSA9PiB7XG4gICAgLy8gV0ktMjE0NjQxMi4gVGhpcyByb3V0ZSB1c2VkIHRvIHRha2UgYSBgYnV5ZXJgIHF1ZXJ5IHBhcmFtIGFuZCBhbnN3ZXIgaXQsXG4gICAgLy8gZnVsbCBzdG9wIOKAlCBzbyBhbnlvbmUgd2hvIGNvdWxkIHJlYWNoIHRoZSBXb3JrZXIgY291bGQgcmVhZCBhbnkgYnV5ZXInc1xuICAgIC8vIHB1cmNoYXNlIGhpc3RvcnkgYnkgZ3Vlc3NpbmcgYW4gaWQsIHdpdGggbm8gYmVhcmVyIGF0IGFsbC4gRW50aXRsZW1lbnRzXG4gICAgLy8gYXJlIHdoYXQgc29tZW9uZSBwYWlkIGZvcjsgdGhlIHJlYWQgc2lkZSBvZiBhIGNvbW1lcmNlIGJvdW5kYXJ5IG5lZWRzIHRoZVxuICAgIC8vIHNhbWUgZG9vciBhcyB0aGUgd3JpdGUgc2lkZSwgYW5kIGl0IGhhZCBub25lLlxuICAgIC8vXG4gICAgLy8gQXV0aGVudGljYXRlIEZJUlNULCBiZWZvcmUgZXZlbiB2YWxpZGF0aW5nIGBidXllcmA6IGFuIGFub255bW91cyBjYWxsZXJcbiAgICAvLyBzaG91bGQgbGVhcm4gbm90aGluZyBmcm9tIHRoaXMgZW5kcG9pbnQsIGluY2x1ZGluZyB3aGV0aGVyIHRoZWlyIGd1ZXNzXG4gICAgLy8gd2FzIHdlbGwtZm9ybWVkLlxuICAgIGxldCBhY3RpbmdVc2VySWQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgYWN0aW5nVXNlcklkID0gcHJpbmNpcGFsSWQoYXdhaXQgcmVzb2x2ZUdpdGh1YkJlYXJlcihjLnJlcS5yYXcpKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3VuYXV0aG9yaXplZCcsIHJlYXNvbjogZXJyLnJlYXNvbiB9LCA0MDEpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cblxuICAgIC8vIEEgdHVybiBob3N0IGRpc2NvdmVycyBpdHMgcGF5ZXIgZnJvbSB0aGlzIGF1dGhlbnRpY2F0ZWQgc2VsZiByZWFkLiBBblxuICAgIC8vIGV4cGxpY2l0IG9yZ2FuaXphdGlvbiBzdGlsbCBnb2VzIHRocm91Z2ggdGhlIHNhbWUgbWVtYmVyc2hpcCBjaGVjay5cbiAgICBjb25zdCBidXllciA9IGMucmVxLnF1ZXJ5KCdidXllcicpID8/IGFjdGluZ1VzZXJJZDtcbiAgICBpZiAoIWJ1eWVyKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdidXllcl9yZXF1aXJlZCcgfSwgNDAwKTtcblxuICAgIC8vIFNhbWUgcnVsZSBhcyBjaGVja291dCwgc2FtZSBzaW5nbGUgY29weSBvZiBpdDogeW91IG1heSByZWFkIHlvdXJzZWxmLCBvclxuICAgIC8vIGFuIG9yZ2FuaXphdGlvbiB5b3UgYmVsb25nIHRvLiBBIGNhbGxlciBhc2tpbmcgYWZ0ZXIgYSBidXllciB0aGF0IGlzXG4gICAgLy8gbmVpdGhlciBnZXRzIHRoZSBTQU1FIDQwMyB3aGV0aGVyIG9yIG5vdCB0aGF0IGJ1eWVyIGV4aXN0cy5cbiAgICBjb25zdCBhdXRob3JpemVkID0gYXdhaXQgYXV0aG9yaXplQnV5ZXIoYnV5ZXIsIGFjdGluZ1VzZXJJZCwgbG9hZE9yZ3MsIGMuZW52LkRCKTtcbiAgICBpZiAoIWF1dGhvcml6ZWQub2spIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogYXV0aG9yaXplZC5jb2RlLCBkZXRhaWw6IGF1dGhvcml6ZWQuZGV0YWlsIH0sIDQwMyk7XG4gICAgfVxuXG4gICAgY29uc3QgZW50aXRsZW1lbnRzID0gYXdhaXQgbGlzdEFjdGl2ZUVudGl0bGVtZW50cyhjLmVudi5EQiwgYnV5ZXIpO1xuICAgIHJldHVybiBjLmpzb24oeyBidXllciwgZW50aXRsZW1lbnRzIH0pO1xuICB9KTtcblxuICByZXR1cm4gcm91dGU7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL2NvbW1lcmNlLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9jb21tZXJjZS50cyIsIi9zcmMvcm91dGVzL2NvbW1lcmNlLnRzIixbXV0=
}}