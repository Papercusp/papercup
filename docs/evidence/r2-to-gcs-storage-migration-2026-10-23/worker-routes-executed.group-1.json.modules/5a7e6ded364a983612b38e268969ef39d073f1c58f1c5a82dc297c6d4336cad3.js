__vite_ssr_exportName__("paymentChannelsRoute", () => { try { return paymentChannelsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/payment-channel.ts", {"importedNames":["createPaymentChannel"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/channel-funding.ts", {"importedNames":["verifyPaymentChannelPayerBinding"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/wallet-binding-store.ts", {"importedNames":["getWalletBinding"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/prepaid-credit-store.ts", {"importedNames":["appendPrepaidCreditEvent","loadPrepaidCreditState"]});
const __vite_ssr_import_6__ = await __vite_ssr_import__("/src/payment-channel-adapter.ts", {"importedNames":["createViemPaymentChannelAdapter"]});
const __vite_ssr_import_7__ = await __vite_ssr_import__("/src/payment-channel-store.ts", {"importedNames":["beginPaymentChannelClose","createPaymentChannelOpening","getPaymentChannel","markPaymentChannelClosed","markPaymentChannelCloseRetryable","markPaymentChannelFailed","markPaymentChannelOpen","recordPaymentChannelCloseReceipt"]});








function principalId(user) {
  return `gh:${user.id}`;
}
async function authenticate(request) {
  try {
    return { ok: true, principalId: principalId(await (0,__vite_ssr_import_3__.resolveGithubBearer)(request)) };
  } catch (error) {
    if (error instanceof __vite_ssr_import_3__.AuthError) return { ok: false, reason: error.reason };
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
function channelJson(channel) {
  return {
    channelId: channel.channelId,
    principalId: channel.principalId,
    payerPubkeyBase64: channel.payerPubkeyBase64,
    rail: channel.rail,
    chainId: channel.chainId,
    stablecoinAddress: channel.stablecoinAddress,
    settlementContractAddress: channel.settlementContractAddress,
    fundingSource: channel.fundingSource,
    escrowMicros: channel.escrowMicros,
    committedMicros: channel.committedMicros,
    refundedMicros: channel.refundedMicros,
    state: channel.state,
    openReceipt: channel.openReceipt ? {
      transactionHash: channel.openReceipt.transactionHash,
      blockNumber: channel.openReceipt.blockNumber.toString()
    } : null,
    closeReceipt: channel.closeReceipt ? {
      transactionHash: channel.closeReceipt.transactionHash,
      blockNumber: channel.closeReceipt.blockNumber.toString()
    } : null,
    failureCode: channel.failureCode,
    createdAtMs: channel.createdAtMs,
    updatedAtMs: channel.updatedAtMs,
    closedAtMs: channel.closedAtMs
  };
}
function adapterFor(env, injected) {
  return injected ? { ok: true, adapter: injected } : (0,__vite_ssr_import_6__.createViemPaymentChannelAdapter)(env);
}
async function releasePrepaidReservation(db, principal, reservationId) {
  const result = await (0,__vite_ssr_import_5__.appendPrepaidCreditEvent)(db, {
    creditEventId: `credit:release:${reservationId}`,
    kind: "credit.released",
    principalId: principal,
    payload: { reservationId }
  });
  if (!result.ok && result.code !== "invalid-transition") {
    throw new Error(`prepaid reservation compensation failed: ${result.code}`);
  }
}
function paymentChannelsRoute(options = {}) {
  const route = new __vite_ssr_import_0__.Hono();
  route.post("/commerce/payment-channels", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const body = await jsonObject(c.req.raw);
    if (!body || !validId(body.channelId) || !Number.isSafeInteger(body.escrowMicros) || Number(body.escrowMicros) <= 0 || body.fundingSource !== "bound-wallet" && body.fundingSource !== "prepaid-credit") {
      return c.json(
        {
          error: "invalid_request",
          detail: "channelId, a positive safe-integer escrowMicros, and fundingSource bound-wallet|prepaid-credit are required"
        },
        400
      );
    };
    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) {
      return c.json(
        { error: availability.code, detail: availability.detail },
        503
      );
    };
    const adapter = availability.adapter;
    const channelId = body.channelId;
    const escrowMicros = Number(body.escrowMicros);
    let fundingSource;
    let refundAddress = adapter.signerAddress;
    if (body.fundingSource === "bound-wallet") {
      const binding = await (0,__vite_ssr_import_4__.getWalletBinding)(c.env.DB, auth.principalId);
      if (!binding) return c.json({ error: "wallet_not_bound" }, 409);
      if (binding.chainId !== adapter.chainId) {
        return c.json(
          {
            error: "wallet_chain_mismatch",
            expectedChainId: adapter.chainId,
            boundChainId: binding.chainId
          },
          409
        );
      };
      if (binding.walletAddress.toLowerCase() !== adapter.signerAddress.toLowerCase()) {
        return c.json(
          {
            error: "wallet_signer_mismatch",
            detail: "the configured rail signer is not the authenticated principal’s bound wallet"
          },
          503
        );
      };
      refundAddress = binding.walletAddress;
      fundingSource = {
        kind: "bound-wallet",
        walletAddress: binding.walletAddress
      };
    } else {
      fundingSource = {
        kind: "prepaid-credit",
        reservationId: `payment-channel:${channelId}`
      };
    };
    if (typeof body.payerPubkeyBase64 !== "string" || typeof body.payerKeyProof !== "string" || !(0,__vite_ssr_import_2__.verifyPaymentChannelPayerBinding)({
      channelId,
      payer: auth.principalId,
      payerPubkeyBase64: body.payerPubkeyBase64,
      chainId: adapter.chainId,
      stablecoinAddress: adapter.stablecoinAddress,
      settlementContractAddress: adapter.settlementContractAddress,
      escrowMicros: String(escrowMicros),
      fundingSource
    }, body.payerKeyProof)) {
      return c.json({ error: "invalid_payer_key", detail: "a payer key and proof binding this authenticated channel opening are required" }, 422);
    };
    const opening = await (0,__vite_ssr_import_7__.createPaymentChannelOpening)(c.env.DB, {
      channelId,
      principalId: auth.principalId,
      payerPubkeyBase64: body.payerPubkeyBase64,
      payerKeyProof: body.payerKeyProof,
      adapter,
      fundingSource,
      escrowMicros,
      nowMs: Date.now()
    });
    if (!opening.ok) return c.json({ error: opening.code }, 409);
    if (opening.channel.state === "open" || opening.channel.state === "closing" || opening.channel.state === "closed") {
      return c.json({ replayed: true, channel: channelJson(opening.channel) }, 200);
    };
    if (opening.channel.state === "failed") {
      return c.json(
        {
          error: "channel_open_failed",
          failureCode: opening.channel.failureCode
        },
        409
      );
    };
    if (fundingSource.kind === "prepaid-credit") {
      const reserve = await (0,__vite_ssr_import_5__.appendPrepaidCreditEvent)(c.env.DB, {
        creditEventId: `credit:reserve:${fundingSource.reservationId}`,
        kind: "credit.reserved",
        principalId: auth.principalId,
        payload: {
          reservationId: fundingSource.reservationId,
          channelId,
          amountMicros: escrowMicros
        }
      });
      if (!reserve.ok) {
        await (0,__vite_ssr_import_7__.markPaymentChannelFailed)(
          c.env.DB,
          channelId,
          `prepaid-${reserve.code}`
        );
        const status = reserve.code === "negative-balance" ? 409 : 422;
        return c.json({ error: reserve.code, detail: reserve.detail }, status);
      }
    };
    const channel = (0,__vite_ssr_import_1__.createPaymentChannel)(
      channelId,
      adapter.rail,
      BigInt(escrowMicros)
    );
    try {
      const receipt = await adapter.openChannel({
        principalId: auth.principalId,
        channel,
        fundingSource,
        refundAddress
      });
      const opened = await (0,__vite_ssr_import_7__.markPaymentChannelOpen)(c.env.DB, channelId, receipt);
      return c.json(
        { replayed: !opening.created, channel: channelJson(opened) },
        opening.created ? 201 : 200
      );
    } catch {
      if (fundingSource.kind === "prepaid-credit") {
        await releasePrepaidReservation(
          c.env.DB,
          auth.principalId,
          fundingSource.reservationId
        );
      };
      await (0,__vite_ssr_import_7__.markPaymentChannelFailed)(c.env.DB, channelId, "rail-open-failed");
      return c.json({ error: "rail_open_failed" }, 502);
    }
  });
  route.get("/commerce/payment-channels/:channelId", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    if (!validId(channelId)) return c.json({ error: "invalid_request" }, 400);
    const channel = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: "channel_not_found" }, 404);
    };
    return c.json({ channel: channelJson(channel) });
  });
  route.post("/commerce/payment-channels/:channelId/close", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const channelId = c.req.param("channelId");
    const body = await jsonObject(c.req.raw);
    if (!validId(channelId) || !body || !Number.isSafeInteger(body.committedMicros) || Number(body.committedMicros) < 0) {
      return c.json(
        {
          error: "invalid_request",
          detail: "a non-negative safe-integer committedMicros is required"
        },
        400
      );
    };
    const availability = adapterFor(c.env, options.adapter);
    if (!availability.ok) {
      return c.json(
        { error: availability.code, detail: availability.detail },
        503
      );
    };
    const adapter = availability.adapter;
    let stored = await (0,__vite_ssr_import_7__.getPaymentChannel)(c.env.DB, channelId);
    if (!stored || stored.principalId !== auth.principalId) {
      return c.json({ error: "channel_not_found" }, 404);
    };
    const committedMicros = Number(body.committedMicros);
    if (committedMicros > stored.escrowMicros) {
      return c.json({ error: "committed_exceeds_escrow" }, 422);
    };
    if (stored.state === "closed") {
      return stored.committedMicros === committedMicros ? c.json({ replayed: true, channel: channelJson(stored) }, 200) : c.json({ error: "close_terms_conflict" }, 409);
    };
    if (stored.state !== "open" && stored.state !== "closing") {
      return c.json({ error: `channel_${stored.state}` }, 409);
    };
    if (stored.state === "closing" && stored.committedMicros !== committedMicros) {
      return c.json({ error: "close_terms_conflict" }, 409);
    };
    const refundedMicros = stored.escrowMicros - committedMicros;
    if (stored.state === "open") {
      stored = await (0,__vite_ssr_import_7__.beginPaymentChannelClose)(
        c.env.DB,
        channelId,
        committedMicros,
        refundedMicros
      );
    };
    const channel = (0,__vite_ssr_import_1__.createPaymentChannel)(
      stored.channelId,
      stored.rail,
      BigInt(stored.escrowMicros)
    );
    if (!stored.closeReceipt) {
      try {
        const closeReceipt = await adapter.closeChannel({
          principalId: auth.principalId,
          channel,
          fundingSource: stored.fundingSource,
          committedMicros: BigInt(committedMicros),
          refundAddress: stored.fundingSource.kind === "bound-wallet" ? stored.fundingSource.walletAddress : adapter.signerAddress
        });
        stored = await (0,__vite_ssr_import_7__.recordPaymentChannelCloseReceipt)(c.env.DB, channelId, {
          committedMicros,
          refundedMicros,
          receipt: closeReceipt
        });
      } catch {
        await (0,__vite_ssr_import_7__.markPaymentChannelCloseRetryable)(
          c.env.DB,
          channelId,
          "rail-close-failed"
        );
        return c.json({ error: "rail_close_failed" }, 502);
      }
    };
    if (stored.fundingSource.kind === "prepaid-credit") {
      const settle = await (0,__vite_ssr_import_5__.appendPrepaidCreditEvent)(c.env.DB, {
        creditEventId: `credit:settle:${stored.fundingSource.reservationId}`,
        kind: "credit.settled",
        principalId: auth.principalId,
        payload: {
          reservationId: stored.fundingSource.reservationId,
          committedMicros
        }
      });
      if (!settle.ok) {
        return c.json(
          {
            error: "prepaid_settlement_pending",
            detail: settle.detail
          },
          500
        );
      }
    };
    const closed = await (0,__vite_ssr_import_7__.markPaymentChannelClosed)(c.env.DB, channelId);
    return c.json({ replayed: false, channel: channelJson(closed) }, 200);
  });
  return route;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFBLE1BQ25EO0FBQUEsSUFDRjtBQUVBLFFBQUksT0FBTyxjQUFjLFNBQVMsa0JBQWtCO0FBQ2xELFlBQU0sU0FBUyxTQUFNLGdEQUF5QixFQUFFLElBQUksSUFBSTtBQUFBLFFBQ3RELGVBQWUsaUJBQWlCLE9BQU8sY0FBYyxhQUFhO0FBQUEsUUFDbEUsTUFBTTtBQUFBLFFBQ04sYUFBYSxLQUFLO0FBQUEsUUFDbEIsU0FBUztBQUFBLFVBQ1AsZUFBZSxPQUFPLGNBQWM7QUFBQSxVQUNwQztBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFDRCxVQUFJLENBQUMsT0FBTyxJQUFJO0FBQ2QsZUFBTyxFQUFFO0FBQUEsVUFDUDtBQUFBLFlBQ0UsT0FBTztBQUFBLFlBQ1AsUUFBUSxPQUFPO0FBQUEsVUFDakI7QUFBQSxVQUNBO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxTQUFTLFNBQU0sZ0RBQXlCLEVBQUUsSUFBSSxJQUFJLFNBQVM7QUFDakUsV0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLE9BQU8sU0FBUyxZQUFZLE1BQU0sRUFBRSxHQUFHLEdBQUc7QUFBQSxFQUN0RSxDQUFDO0FBRUQsU0FBTztBQUNUIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJwYXltZW50LWNoYW5uZWxzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXV0aGVudGljYXRlZCBwcm9kdWN0aW9uIGRvb3IgZm9yIGJ1eWVyLXNpZGUgUC0wMzIgcGF5bWVudC1jaGFubmVsIGZ1bmRpbmcuXG4gKlxuICogVGhlIHJvdXRlIGJpbmRzIHRoZSBleGlzdGluZyBQLTAyMSBjaGFubmVsIHN0YXRlIG1hY2hpbmUgdG8gYSByZWFsIEVWTSByYWlsLlxuICogR2l0SHViIGJlYXJlciBpZGVudGl0eSBzZWxlY3RzIHRoZSB3YWxsZXQgYmluZGluZyAvIHByZXBhaWQgYmFsYW5jZTsgY2FsbGVyc1xuICogY2Fubm90IHByb3ZpZGUgYSBwcmluY2lwYWwsIHNpZ25lciwgY29udHJhY3QsIGNoYWluLCBvciB0b2tlbiBhZGRyZXNzLlxuICovXG5pbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQgeyBjcmVhdGVQYXltZW50Q2hhbm5lbCB9IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL3BheW1lbnQtY2hhbm5lbC50cyc7XG5pbXBvcnQgeyB2ZXJpZnlQYXltZW50Q2hhbm5lbFBheWVyQmluZGluZyB9IGZyb20gJ0BwYXBlcmN1c3Avb3BlcmF0b3ItY29yZS9saWIvcDJwL2NoYW5uZWwtZnVuZGluZy50cyc7XG5pbXBvcnQgdHlwZSB7XG4gIFBheW1lbnRDaGFubmVsRnVuZGluZ0FkYXB0ZXIsXG4gIFBheW1lbnRDaGFubmVsRnVuZGluZ1NvdXJjZSxcbn0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvY2hhbm5lbC1mdW5kaW5nLnRzJztcbmltcG9ydCB0eXBlIHsgRW52IH0gZnJvbSAnLi4vZW52LnRzJztcbmltcG9ydCB7IEF1dGhFcnJvciwgcmVzb2x2ZUdpdGh1YkJlYXJlciB9IGZyb20gJy4uL2F1dGgudHMnO1xuaW1wb3J0IHsgZ2V0V2FsbGV0QmluZGluZyB9IGZyb20gJy4uL3dhbGxldC1iaW5kaW5nLXN0b3JlLnRzJztcbmltcG9ydCB7XG4gIGFwcGVuZFByZXBhaWRDcmVkaXRFdmVudCxcbiAgbG9hZFByZXBhaWRDcmVkaXRTdGF0ZSxcbn0gZnJvbSAnLi4vcHJlcGFpZC1jcmVkaXQtc3RvcmUudHMnO1xuaW1wb3J0IHsgY3JlYXRlVmllbVBheW1lbnRDaGFubmVsQWRhcHRlciB9IGZyb20gJy4uL3BheW1lbnQtY2hhbm5lbC1hZGFwdGVyLnRzJztcbmltcG9ydCB7XG4gIGJlZ2luUGF5bWVudENoYW5uZWxDbG9zZSxcbiAgY3JlYXRlUGF5bWVudENoYW5uZWxPcGVuaW5nLFxuICBnZXRQYXltZW50Q2hhbm5lbCxcbiAgbWFya1BheW1lbnRDaGFubmVsQ2xvc2VkLFxuICBtYXJrUGF5bWVudENoYW5uZWxDbG9zZVJldHJ5YWJsZSxcbiAgbWFya1BheW1lbnRDaGFubmVsRmFpbGVkLFxuICBtYXJrUGF5bWVudENoYW5uZWxPcGVuLFxuICByZWNvcmRQYXltZW50Q2hhbm5lbENsb3NlUmVjZWlwdCxcbiAgdHlwZSBTdG9yZWRQYXltZW50Q2hhbm5lbCxcbn0gZnJvbSAnLi4vcGF5bWVudC1jaGFubmVsLXN0b3JlLnRzJztcblxuZnVuY3Rpb24gcHJpbmNpcGFsSWQodXNlcjogeyBpZDogbnVtYmVyIH0pOiBzdHJpbmcge1xuICByZXR1cm4gYGdoOiR7dXNlci5pZH1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhdXRoZW50aWNhdGUocmVxdWVzdDogUmVxdWVzdCk6IFByb21pc2U8XG4gIHwgeyBvazogdHJ1ZTsgcHJpbmNpcGFsSWQ6IHN0cmluZyB9XG4gIHwgeyBvazogZmFsc2U7IHJlYXNvbjogQXV0aEVycm9yWydyZWFzb24nXSB9XG4+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgcHJpbmNpcGFsSWQ6IHByaW5jaXBhbElkKGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIocmVxdWVzdCkpIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgQXV0aEVycm9yKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogZXJyb3IucmVhc29uIH07XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24ganNvbk9iamVjdChyZXF1ZXN0OiBSZXF1ZXN0KTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB2YWx1ZTogdW5rbm93biA9IGF3YWl0IHJlcXVlc3QuanNvbigpO1xuICAgIHJldHVybiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHZhbHVlKVxuICAgICAgPyAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgICA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkSWQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiZcbiAgICAvXltBLVphLXowLTldW0EtWmEtejAtOS5fOi1dezAsMTk5fSQvLnRlc3QodmFsdWUpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNoYW5uZWxKc29uKGNoYW5uZWw6IFN0b3JlZFBheW1lbnRDaGFubmVsKSB7XG4gIHJldHVybiB7XG4gICAgY2hhbm5lbElkOiBjaGFubmVsLmNoYW5uZWxJZCxcbiAgICBwcmluY2lwYWxJZDogY2hhbm5lbC5wcmluY2lwYWxJZCxcbiAgICBwYXllclB1YmtleUJhc2U2NDogY2hhbm5lbC5wYXllclB1YmtleUJhc2U2NCxcbiAgICByYWlsOiBjaGFubmVsLnJhaWwsXG4gICAgY2hhaW5JZDogY2hhbm5lbC5jaGFpbklkLFxuICAgIHN0YWJsZWNvaW5BZGRyZXNzOiBjaGFubmVsLnN0YWJsZWNvaW5BZGRyZXNzLFxuICAgIHNldHRsZW1lbnRDb250cmFjdEFkZHJlc3M6IGNoYW5uZWwuc2V0dGxlbWVudENvbnRyYWN0QWRkcmVzcyxcbiAgICBmdW5kaW5nU291cmNlOiBjaGFubmVsLmZ1bmRpbmdTb3VyY2UsXG4gICAgZXNjcm93TWljcm9zOiBjaGFubmVsLmVzY3Jvd01pY3JvcyxcbiAgICBjb21taXR0ZWRNaWNyb3M6IGNoYW5uZWwuY29tbWl0dGVkTWljcm9zLFxuICAgIHJlZnVuZGVkTWljcm9zOiBjaGFubmVsLnJlZnVuZGVkTWljcm9zLFxuICAgIHN0YXRlOiBjaGFubmVsLnN0YXRlLFxuICAgIG9wZW5SZWNlaXB0OiBjaGFubmVsLm9wZW5SZWNlaXB0XG4gICAgICA/IHtcbiAgICAgICAgICB0cmFuc2FjdGlvbkhhc2g6IGNoYW5uZWwub3BlblJlY2VpcHQudHJhbnNhY3Rpb25IYXNoLFxuICAgICAgICAgIGJsb2NrTnVtYmVyOiBjaGFubmVsLm9wZW5SZWNlaXB0LmJsb2NrTnVtYmVyLnRvU3RyaW5nKCksXG4gICAgICAgIH1cbiAgICAgIDogbnVsbCxcbiAgICBjbG9zZVJlY2VpcHQ6IGNoYW5uZWwuY2xvc2VSZWNlaXB0XG4gICAgICA/IHtcbiAgICAgICAgICB0cmFuc2FjdGlvbkhhc2g6IGNoYW5uZWwuY2xvc2VSZWNlaXB0LnRyYW5zYWN0aW9uSGFzaCxcbiAgICAgICAgICBibG9ja051bWJlcjogY2hhbm5lbC5jbG9zZVJlY2VpcHQuYmxvY2tOdW1iZXIudG9TdHJpbmcoKSxcbiAgICAgICAgfVxuICAgICAgOiBudWxsLFxuICAgIGZhaWx1cmVDb2RlOiBjaGFubmVsLmZhaWx1cmVDb2RlLFxuICAgIGNyZWF0ZWRBdE1zOiBjaGFubmVsLmNyZWF0ZWRBdE1zLFxuICAgIHVwZGF0ZWRBdE1zOiBjaGFubmVsLnVwZGF0ZWRBdE1zLFxuICAgIGNsb3NlZEF0TXM6IGNoYW5uZWwuY2xvc2VkQXRNcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYWRhcHRlckZvcihcbiAgZW52OiBFbnYsXG4gIGluamVjdGVkOiBQYXltZW50Q2hhbm5lbEZ1bmRpbmdBZGFwdGVyIHwgdW5kZWZpbmVkLFxuKSB7XG4gIHJldHVybiBpbmplY3RlZFxuICAgID8geyBvazogdHJ1ZSBhcyBjb25zdCwgYWRhcHRlcjogaW5qZWN0ZWQgfVxuICAgIDogY3JlYXRlVmllbVBheW1lbnRDaGFubmVsQWRhcHRlcihlbnYpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWxlYXNlUHJlcGFpZFJlc2VydmF0aW9uKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgcHJpbmNpcGFsOiBzdHJpbmcsXG4gIHJlc2VydmF0aW9uSWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcHBlbmRQcmVwYWlkQ3JlZGl0RXZlbnQoZGIsIHtcbiAgICBjcmVkaXRFdmVudElkOiBgY3JlZGl0OnJlbGVhc2U6JHtyZXNlcnZhdGlvbklkfWAsXG4gICAga2luZDogJ2NyZWRpdC5yZWxlYXNlZCcsXG4gICAgcHJpbmNpcGFsSWQ6IHByaW5jaXBhbCxcbiAgICBwYXlsb2FkOiB7IHJlc2VydmF0aW9uSWQgfSxcbiAgfSk7XG4gIGlmICghcmVzdWx0Lm9rICYmIHJlc3VsdC5jb2RlICE9PSAnaW52YWxpZC10cmFuc2l0aW9uJykge1xuICAgIHRocm93IG5ldyBFcnJvcihgcHJlcGFpZCByZXNlcnZhdGlvbiBjb21wZW5zYXRpb24gZmFpbGVkOiAke3Jlc3VsdC5jb2RlfWApO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXltZW50Q2hhbm5lbHNSb3V0ZShcbiAgb3B0aW9uczogeyBhZGFwdGVyPzogUGF5bWVudENoYW5uZWxGdW5kaW5nQWRhcHRlciB9ID0ge30sXG4pOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IHJvdXRlID0gbmV3IEhvbm88eyBCaW5kaW5nczogRW52IH0+KCk7XG5cbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL3BheW1lbnQtY2hhbm5lbHMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGF1dGggPSBhd2FpdCBhdXRoZW50aWNhdGUoYy5yZXEucmF3KTtcbiAgICBpZiAoIWF1dGgub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3VuYXV0aG9yaXplZCcsIHJlYXNvbjogYXV0aC5yZWFzb24gfSwgNDAxKTtcblxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBqc29uT2JqZWN0KGMucmVxLnJhdyk7XG4gICAgaWYgKFxuICAgICAgIWJvZHkgfHxcbiAgICAgICF2YWxpZElkKGJvZHkuY2hhbm5lbElkKSB8fFxuICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGJvZHkuZXNjcm93TWljcm9zKSB8fFxuICAgICAgTnVtYmVyKGJvZHkuZXNjcm93TWljcm9zKSA8PSAwIHx8XG4gICAgICAoYm9keS5mdW5kaW5nU291cmNlICE9PSAnYm91bmQtd2FsbGV0JyAmJlxuICAgICAgICBib2R5LmZ1bmRpbmdTb3VyY2UgIT09ICdwcmVwYWlkLWNyZWRpdCcpXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7XG4gICAgICAgICAgZXJyb3I6ICdpbnZhbGlkX3JlcXVlc3QnLFxuICAgICAgICAgIGRldGFpbDpcbiAgICAgICAgICAgICdjaGFubmVsSWQsIGEgcG9zaXRpdmUgc2FmZS1pbnRlZ2VyIGVzY3Jvd01pY3JvcywgYW5kIGZ1bmRpbmdTb3VyY2UgYm91bmQtd2FsbGV0fHByZXBhaWQtY3JlZGl0IGFyZSByZXF1aXJlZCcsXG4gICAgICAgIH0sXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgYXZhaWxhYmlsaXR5ID0gYWRhcHRlckZvcihjLmVudiwgb3B0aW9ucy5hZGFwdGVyKTtcbiAgICBpZiAoIWF2YWlsYWJpbGl0eS5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogYXZhaWxhYmlsaXR5LmNvZGUsIGRldGFpbDogYXZhaWxhYmlsaXR5LmRldGFpbCB9LFxuICAgICAgICA1MDMsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBhZGFwdGVyID0gYXZhaWxhYmlsaXR5LmFkYXB0ZXI7XG4gICAgY29uc3QgY2hhbm5lbElkID0gYm9keS5jaGFubmVsSWQ7XG4gICAgY29uc3QgZXNjcm93TWljcm9zID0gTnVtYmVyKGJvZHkuZXNjcm93TWljcm9zKTtcbiAgICBsZXQgZnVuZGluZ1NvdXJjZTogUGF5bWVudENoYW5uZWxGdW5kaW5nU291cmNlO1xuICAgIGxldCByZWZ1bmRBZGRyZXNzID0gYWRhcHRlci5zaWduZXJBZGRyZXNzO1xuXG4gICAgaWYgKGJvZHkuZnVuZGluZ1NvdXJjZSA9PT0gJ2JvdW5kLXdhbGxldCcpIHtcbiAgICAgIGNvbnN0IGJpbmRpbmcgPSBhd2FpdCBnZXRXYWxsZXRCaW5kaW5nKGMuZW52LkRCLCBhdXRoLnByaW5jaXBhbElkKTtcbiAgICAgIGlmICghYmluZGluZykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnd2FsbGV0X25vdF9ib3VuZCcgfSwgNDA5KTtcbiAgICAgIGlmIChiaW5kaW5nLmNoYWluSWQgIT09IGFkYXB0ZXIuY2hhaW5JZCkge1xuICAgICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVycm9yOiAnd2FsbGV0X2NoYWluX21pc21hdGNoJyxcbiAgICAgICAgICAgIGV4cGVjdGVkQ2hhaW5JZDogYWRhcHRlci5jaGFpbklkLFxuICAgICAgICAgICAgYm91bmRDaGFpbklkOiBiaW5kaW5nLmNoYWluSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICA0MDksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoXG4gICAgICAgIGJpbmRpbmcud2FsbGV0QWRkcmVzcy50b0xvd2VyQ2FzZSgpICE9PVxuICAgICAgICBhZGFwdGVyLnNpZ25lckFkZHJlc3MudG9Mb3dlckNhc2UoKVxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgICAge1xuICAgICAgICAgICAgZXJyb3I6ICd3YWxsZXRfc2lnbmVyX21pc21hdGNoJyxcbiAgICAgICAgICAgIGRldGFpbDpcbiAgICAgICAgICAgICAgJ3RoZSBjb25maWd1cmVkIHJhaWwgc2lnbmVyIGlzIG5vdCB0aGUgYXV0aGVudGljYXRlZCBwcmluY2lwYWzigJlzIGJvdW5kIHdhbGxldCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICA1MDMsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZWZ1bmRBZGRyZXNzID0gYmluZGluZy53YWxsZXRBZGRyZXNzO1xuICAgICAgZnVuZGluZ1NvdXJjZSA9IHtcbiAgICAgICAga2luZDogJ2JvdW5kLXdhbGxldCcsXG4gICAgICAgIHdhbGxldEFkZHJlc3M6IGJpbmRpbmcud2FsbGV0QWRkcmVzcyxcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZ1bmRpbmdTb3VyY2UgPSB7XG4gICAgICAgIGtpbmQ6ICdwcmVwYWlkLWNyZWRpdCcsXG4gICAgICAgIHJlc2VydmF0aW9uSWQ6IGBwYXltZW50LWNoYW5uZWw6JHtjaGFubmVsSWR9YCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBib2R5LnBheWVyUHVia2V5QmFzZTY0ICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgYm9keS5wYXllcktleVByb29mICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICAhdmVyaWZ5UGF5bWVudENoYW5uZWxQYXllckJpbmRpbmcoeyBjaGFubmVsSWQsIHBheWVyOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICAgIHBheWVyUHVia2V5QmFzZTY0OiBib2R5LnBheWVyUHVia2V5QmFzZTY0LCBjaGFpbklkOiBhZGFwdGVyLmNoYWluSWQsXG4gICAgICAgICAgc3RhYmxlY29pbkFkZHJlc3M6IGFkYXB0ZXIuc3RhYmxlY29pbkFkZHJlc3MsXG4gICAgICAgICAgc2V0dGxlbWVudENvbnRyYWN0QWRkcmVzczogYWRhcHRlci5zZXR0bGVtZW50Q29udHJhY3RBZGRyZXNzLFxuICAgICAgICAgIGVzY3Jvd01pY3JvczogU3RyaW5nKGVzY3Jvd01pY3JvcyksIGZ1bmRpbmdTb3VyY2UgfSwgYm9keS5wYXllcktleVByb29mKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9wYXllcl9rZXknLCBkZXRhaWw6ICdhIHBheWVyIGtleSBhbmQgcHJvb2YgYmluZGluZyB0aGlzIGF1dGhlbnRpY2F0ZWQgY2hhbm5lbCBvcGVuaW5nIGFyZSByZXF1aXJlZCcgfSwgNDIyKTtcbiAgICB9XG5cbiAgICBjb25zdCBvcGVuaW5nID0gYXdhaXQgY3JlYXRlUGF5bWVudENoYW5uZWxPcGVuaW5nKGMuZW52LkRCLCB7XG4gICAgICBjaGFubmVsSWQsXG4gICAgICBwcmluY2lwYWxJZDogYXV0aC5wcmluY2lwYWxJZCxcbiAgICAgIHBheWVyUHVia2V5QmFzZTY0OiBib2R5LnBheWVyUHVia2V5QmFzZTY0LFxuICAgICAgcGF5ZXJLZXlQcm9vZjogYm9keS5wYXllcktleVByb29mLFxuICAgICAgYWRhcHRlcixcbiAgICAgIGZ1bmRpbmdTb3VyY2UsXG4gICAgICBlc2Nyb3dNaWNyb3MsXG4gICAgICBub3dNczogRGF0ZS5ub3coKSxcbiAgICB9KTtcbiAgICBpZiAoIW9wZW5pbmcub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogb3BlbmluZy5jb2RlIH0sIDQwOSk7XG4gICAgaWYgKFxuICAgICAgb3BlbmluZy5jaGFubmVsLnN0YXRlID09PSAnb3BlbicgfHxcbiAgICAgIG9wZW5pbmcuY2hhbm5lbC5zdGF0ZSA9PT0gJ2Nsb3NpbmcnIHx8XG4gICAgICBvcGVuaW5nLmNoYW5uZWwuc3RhdGUgPT09ICdjbG9zZWQnXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgcmVwbGF5ZWQ6IHRydWUsIGNoYW5uZWw6IGNoYW5uZWxKc29uKG9wZW5pbmcuY2hhbm5lbCkgfSwgMjAwKTtcbiAgICB9XG4gICAgaWYgKG9wZW5pbmcuY2hhbm5lbC5zdGF0ZSA9PT0gJ2ZhaWxlZCcpIHtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHtcbiAgICAgICAgICBlcnJvcjogJ2NoYW5uZWxfb3Blbl9mYWlsZWQnLFxuICAgICAgICAgIGZhaWx1cmVDb2RlOiBvcGVuaW5nLmNoYW5uZWwuZmFpbHVyZUNvZGUsXG4gICAgICAgIH0sXG4gICAgICAgIDQwOSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKGZ1bmRpbmdTb3VyY2Uua2luZCA9PT0gJ3ByZXBhaWQtY3JlZGl0Jykge1xuICAgICAgY29uc3QgcmVzZXJ2ZSA9IGF3YWl0IGFwcGVuZFByZXBhaWRDcmVkaXRFdmVudChjLmVudi5EQiwge1xuICAgICAgICBjcmVkaXRFdmVudElkOiBgY3JlZGl0OnJlc2VydmU6JHtmdW5kaW5nU291cmNlLnJlc2VydmF0aW9uSWR9YCxcbiAgICAgICAga2luZDogJ2NyZWRpdC5yZXNlcnZlZCcsXG4gICAgICAgIHByaW5jaXBhbElkOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICBwYXlsb2FkOiB7XG4gICAgICAgICAgcmVzZXJ2YXRpb25JZDogZnVuZGluZ1NvdXJjZS5yZXNlcnZhdGlvbklkLFxuICAgICAgICAgIGNoYW5uZWxJZCxcbiAgICAgICAgICBhbW91bnRNaWNyb3M6IGVzY3Jvd01pY3JvcyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFyZXNlcnZlLm9rKSB7XG4gICAgICAgIGF3YWl0IG1hcmtQYXltZW50Q2hhbm5lbEZhaWxlZChcbiAgICAgICAgICBjLmVudi5EQixcbiAgICAgICAgICBjaGFubmVsSWQsXG4gICAgICAgICAgYHByZXBhaWQtJHtyZXNlcnZlLmNvZGV9YCxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3Qgc3RhdHVzID0gcmVzZXJ2ZS5jb2RlID09PSAnbmVnYXRpdmUtYmFsYW5jZScgPyA0MDkgOiA0MjI7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogcmVzZXJ2ZS5jb2RlLCBkZXRhaWw6IHJlc2VydmUuZGV0YWlsIH0sIHN0YXR1cyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgY2hhbm5lbCA9IGNyZWF0ZVBheW1lbnRDaGFubmVsKFxuICAgICAgY2hhbm5lbElkLFxuICAgICAgYWRhcHRlci5yYWlsLFxuICAgICAgQmlnSW50KGVzY3Jvd01pY3JvcyksXG4gICAgKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IGFkYXB0ZXIub3BlbkNoYW5uZWwoe1xuICAgICAgICBwcmluY2lwYWxJZDogYXV0aC5wcmluY2lwYWxJZCxcbiAgICAgICAgY2hhbm5lbCxcbiAgICAgICAgZnVuZGluZ1NvdXJjZSxcbiAgICAgICAgcmVmdW5kQWRkcmVzcyxcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgbWFya1BheW1lbnRDaGFubmVsT3BlbihjLmVudi5EQiwgY2hhbm5lbElkLCByZWNlaXB0KTtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHsgcmVwbGF5ZWQ6ICFvcGVuaW5nLmNyZWF0ZWQsIGNoYW5uZWw6IGNoYW5uZWxKc29uKG9wZW5lZCkgfSxcbiAgICAgICAgb3BlbmluZy5jcmVhdGVkID8gMjAxIDogMjAwLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGlmIChmdW5kaW5nU291cmNlLmtpbmQgPT09ICdwcmVwYWlkLWNyZWRpdCcpIHtcbiAgICAgICAgYXdhaXQgcmVsZWFzZVByZXBhaWRSZXNlcnZhdGlvbihcbiAgICAgICAgICBjLmVudi5EQixcbiAgICAgICAgICBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICAgIGZ1bmRpbmdTb3VyY2UucmVzZXJ2YXRpb25JZCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IG1hcmtQYXltZW50Q2hhbm5lbEZhaWxlZChjLmVudi5EQiwgY2hhbm5lbElkLCAncmFpbC1vcGVuLWZhaWxlZCcpO1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncmFpbF9vcGVuX2ZhaWxlZCcgfSwgNTAyKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJvdXRlLmdldCgnL2NvbW1lcmNlL3BheW1lbnQtY2hhbm5lbHMvOmNoYW5uZWxJZCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGMucmVxLnBhcmFtKCdjaGFubmVsSWQnKTtcbiAgICBpZiAoIXZhbGlkSWQoY2hhbm5lbElkKSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyB9LCA0MDApO1xuICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCBnZXRQYXltZW50Q2hhbm5lbChjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICBpZiAoIWNoYW5uZWwgfHwgY2hhbm5lbC5wcmluY2lwYWxJZCAhPT0gYXV0aC5wcmluY2lwYWxJZCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnY2hhbm5lbF9ub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oeyBjaGFubmVsOiBjaGFubmVsSnNvbihjaGFubmVsKSB9KTtcbiAgfSk7XG5cbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL3BheW1lbnQtY2hhbm5lbHMvOmNoYW5uZWxJZC9jbG9zZScsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuICAgIGNvbnN0IGNoYW5uZWxJZCA9IGMucmVxLnBhcmFtKCdjaGFubmVsSWQnKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGlmIChcbiAgICAgICF2YWxpZElkKGNoYW5uZWxJZCkgfHxcbiAgICAgICFib2R5IHx8XG4gICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoYm9keS5jb21taXR0ZWRNaWNyb3MpIHx8XG4gICAgICBOdW1iZXIoYm9keS5jb21taXR0ZWRNaWNyb3MpIDwgMFxuICAgICkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAge1xuICAgICAgICAgIGVycm9yOiAnaW52YWxpZF9yZXF1ZXN0JyxcbiAgICAgICAgICBkZXRhaWw6ICdhIG5vbi1uZWdhdGl2ZSBzYWZlLWludGVnZXIgY29tbWl0dGVkTWljcm9zIGlzIHJlcXVpcmVkJyxcbiAgICAgICAgfSxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBhdmFpbGFiaWxpdHkgPSBhZGFwdGVyRm9yKGMuZW52LCBvcHRpb25zLmFkYXB0ZXIpO1xuICAgIGlmICghYXZhaWxhYmlsaXR5Lm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiBhdmFpbGFiaWxpdHkuY29kZSwgZGV0YWlsOiBhdmFpbGFiaWxpdHkuZGV0YWlsIH0sXG4gICAgICAgIDUwMyxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGFkYXB0ZXIgPSBhdmFpbGFiaWxpdHkuYWRhcHRlcjtcbiAgICBsZXQgc3RvcmVkID0gYXdhaXQgZ2V0UGF5bWVudENoYW5uZWwoYy5lbnYuREIsIGNoYW5uZWxJZCk7XG4gICAgaWYgKCFzdG9yZWQgfHwgc3RvcmVkLnByaW5jaXBhbElkICE9PSBhdXRoLnByaW5jaXBhbElkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdjaGFubmVsX25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICB9XG4gICAgY29uc3QgY29tbWl0dGVkTWljcm9zID0gTnVtYmVyKGJvZHkuY29tbWl0dGVkTWljcm9zKTtcbiAgICBpZiAoY29tbWl0dGVkTWljcm9zID4gc3RvcmVkLmVzY3Jvd01pY3Jvcykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnY29tbWl0dGVkX2V4Y2VlZHNfZXNjcm93JyB9LCA0MjIpO1xuICAgIH1cbiAgICBpZiAoc3RvcmVkLnN0YXRlID09PSAnY2xvc2VkJykge1xuICAgICAgcmV0dXJuIHN0b3JlZC5jb21taXR0ZWRNaWNyb3MgPT09IGNvbW1pdHRlZE1pY3Jvc1xuICAgICAgICA/IGMuanNvbih7IHJlcGxheWVkOiB0cnVlLCBjaGFubmVsOiBjaGFubmVsSnNvbihzdG9yZWQpIH0sIDIwMClcbiAgICAgICAgOiBjLmpzb24oeyBlcnJvcjogJ2Nsb3NlX3Rlcm1zX2NvbmZsaWN0JyB9LCA0MDkpO1xuICAgIH1cbiAgICBpZiAoc3RvcmVkLnN0YXRlICE9PSAnb3BlbicgJiYgc3RvcmVkLnN0YXRlICE9PSAnY2xvc2luZycpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogYGNoYW5uZWxfJHtzdG9yZWQuc3RhdGV9YCB9LCA0MDkpO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICBzdG9yZWQuc3RhdGUgPT09ICdjbG9zaW5nJyAmJlxuICAgICAgc3RvcmVkLmNvbW1pdHRlZE1pY3JvcyAhPT0gY29tbWl0dGVkTWljcm9zXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdjbG9zZV90ZXJtc19jb25mbGljdCcgfSwgNDA5KTtcbiAgICB9XG5cbiAgICBjb25zdCByZWZ1bmRlZE1pY3JvcyA9IHN0b3JlZC5lc2Nyb3dNaWNyb3MgLSBjb21taXR0ZWRNaWNyb3M7XG4gICAgaWYgKHN0b3JlZC5zdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICBzdG9yZWQgPSBhd2FpdCBiZWdpblBheW1lbnRDaGFubmVsQ2xvc2UoXG4gICAgICAgIGMuZW52LkRCLFxuICAgICAgICBjaGFubmVsSWQsXG4gICAgICAgIGNvbW1pdHRlZE1pY3JvcyxcbiAgICAgICAgcmVmdW5kZWRNaWNyb3MsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBjaGFubmVsID0gY3JlYXRlUGF5bWVudENoYW5uZWwoXG4gICAgICBzdG9yZWQuY2hhbm5lbElkLFxuICAgICAgc3RvcmVkLnJhaWwsXG4gICAgICBCaWdJbnQoc3RvcmVkLmVzY3Jvd01pY3JvcyksXG4gICAgKTtcblxuICAgIGlmICghc3RvcmVkLmNsb3NlUmVjZWlwdCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY2xvc2VSZWNlaXB0ID0gYXdhaXQgYWRhcHRlci5jbG9zZUNoYW5uZWwoe1xuICAgICAgICAgIHByaW5jaXBhbElkOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICAgIGNoYW5uZWwsXG4gICAgICAgICAgZnVuZGluZ1NvdXJjZTogc3RvcmVkLmZ1bmRpbmdTb3VyY2UsXG4gICAgICAgICAgY29tbWl0dGVkTWljcm9zOiBCaWdJbnQoY29tbWl0dGVkTWljcm9zKSxcbiAgICAgICAgICByZWZ1bmRBZGRyZXNzOlxuICAgICAgICAgICAgc3RvcmVkLmZ1bmRpbmdTb3VyY2Uua2luZCA9PT0gJ2JvdW5kLXdhbGxldCdcbiAgICAgICAgICAgICAgPyBzdG9yZWQuZnVuZGluZ1NvdXJjZS53YWxsZXRBZGRyZXNzXG4gICAgICAgICAgICAgIDogYWRhcHRlci5zaWduZXJBZGRyZXNzLFxuICAgICAgICB9KTtcbiAgICAgICAgc3RvcmVkID0gYXdhaXQgcmVjb3JkUGF5bWVudENoYW5uZWxDbG9zZVJlY2VpcHQoYy5lbnYuREIsIGNoYW5uZWxJZCwge1xuICAgICAgICAgIGNvbW1pdHRlZE1pY3JvcyxcbiAgICAgICAgICByZWZ1bmRlZE1pY3JvcyxcbiAgICAgICAgICByZWNlaXB0OiBjbG9zZVJlY2VpcHQsXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGF3YWl0IG1hcmtQYXltZW50Q2hhbm5lbENsb3NlUmV0cnlhYmxlKFxuICAgICAgICAgIGMuZW52LkRCLFxuICAgICAgICAgIGNoYW5uZWxJZCxcbiAgICAgICAgICAncmFpbC1jbG9zZS1mYWlsZWQnLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdyYWlsX2Nsb3NlX2ZhaWxlZCcgfSwgNTAyKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc3RvcmVkLmZ1bmRpbmdTb3VyY2Uua2luZCA9PT0gJ3ByZXBhaWQtY3JlZGl0Jykge1xuICAgICAgY29uc3Qgc2V0dGxlID0gYXdhaXQgYXBwZW5kUHJlcGFpZENyZWRpdEV2ZW50KGMuZW52LkRCLCB7XG4gICAgICAgIGNyZWRpdEV2ZW50SWQ6IGBjcmVkaXQ6c2V0dGxlOiR7c3RvcmVkLmZ1bmRpbmdTb3VyY2UucmVzZXJ2YXRpb25JZH1gLFxuICAgICAgICBraW5kOiAnY3JlZGl0LnNldHRsZWQnLFxuICAgICAgICBwcmluY2lwYWxJZDogYXV0aC5wcmluY2lwYWxJZCxcbiAgICAgICAgcGF5bG9hZDoge1xuICAgICAgICAgIHJlc2VydmF0aW9uSWQ6IHN0b3JlZC5mdW5kaW5nU291cmNlLnJlc2VydmF0aW9uSWQsXG4gICAgICAgICAgY29tbWl0dGVkTWljcm9zLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBpZiAoIXNldHRsZS5vaykge1xuICAgICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGVycm9yOiAncHJlcGFpZF9zZXR0bGVtZW50X3BlbmRpbmcnLFxuICAgICAgICAgICAgZGV0YWlsOiBzZXR0bGUuZGV0YWlsLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgNTAwLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IG1hcmtQYXltZW50Q2hhbm5lbENsb3NlZChjLmVudi5EQiwgY2hhbm5lbElkKTtcbiAgICByZXR1cm4gYy5qc29uKHsgcmVwbGF5ZWQ6IGZhbHNlLCBjaGFubmVsOiBjaGFubmVsSnNvbihjbG9zZWQpIH0sIDIwMCk7XG4gIH0pO1xuXG4gIHJldHVybiByb3V0ZTtcbn1cbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvcGF5bWVudC1jaGFubmVscy50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9wYXltZW50LWNoYW5uZWxzLnRzIiwiL3NyYy9yb3V0ZXMvcGF5bWVudC1jaGFubmVscy50cyIsW11d