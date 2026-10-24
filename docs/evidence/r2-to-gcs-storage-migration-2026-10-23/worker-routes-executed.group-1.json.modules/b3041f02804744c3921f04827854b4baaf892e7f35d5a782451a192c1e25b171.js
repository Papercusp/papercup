'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("prepaidCreditsRoute", () => { try { return prepaidCreditsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/prepaid-credits.ts", {"importedNames":["microchargeChannelForCreditReservation"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/prepaid-credit-store.ts", {"importedNames":["appendPrepaidCreditEvent","loadPrepaidCreditState"]});




function principalId(user) {
  return `gh:${user.id}`;
}
async function authenticate(request) {
  try {
    return { ok: true, principalId: principalId(await (0,__vite_ssr_import_2__.resolveGithubBearer)(request)) };
  } catch (error) {
    if (error instanceof __vite_ssr_import_2__.AuthError) return { ok: false, reason: error.reason };
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
function balanceJson(principal, balance) {
  return balance ?? {
    principalId: principal,
    availableMicros: 0,
    reservedMicros: 0,
    spentMicros: 0,
    debtMicros: 0,
    grantedMicros: 0,
    reversedMicros: 0,
    updatedAtMs: 0
  };
}
function reservationJson(reservation) {
  return {
    reservationId: reservation.reservationId,
    channelId: reservation.channelId,
    reservedMicros: reservation.reservedMicros,
    committedMicros: reservation.committedMicros,
    state: reservation.state,
    createdAtMs: reservation.createdAtMs,
    updatedAtMs: reservation.updatedAtMs
  };
}
function rejectionStatus(code) {
  if (code === "unknown-reservation") return 404;
  if (code === "negative-balance" || code === "duplicate-conflict" || code === "reservation-conflict" || code === "invalid-transition") {
    return 409;
  };
  return 422;
}
function prepaidCreditsRoute() {
  const route = new __vite_ssr_import_0__.Hono();
  route.get("/commerce/prepaid-credits/balance", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const state = await (0,__vite_ssr_import_3__.loadPrepaidCreditState)(c.env.DB);
    return c.json({
      principalId: auth.principalId,
      balance: balanceJson(auth.principalId, state.balances.get(auth.principalId))
    });
  });
  route.post("/commerce/prepaid-credits/reservations", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const body = await jsonObject(c.req.raw);
    if (!body || !validId(body.reservationId) || !validId(body.channelId) || !Number.isSafeInteger(body.amountMicros) || Number(body.amountMicros) <= 0) {
      return c.json(
        {
          error: "invalid_request",
          detail: "reservationId, channelId and a positive safe-integer amountMicros are required"
        },
        400
      );
    };
    const result = await (0,__vite_ssr_import_3__.appendPrepaidCreditEvent)(c.env.DB, {
      creditEventId: `credit:reserve:${body.reservationId}`,
      kind: "credit.reserved",
      principalId: auth.principalId,
      payload: {
        reservationId: body.reservationId,
        channelId: body.channelId,
        amountMicros: Number(body.amountMicros)
      }
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code)
      );
    };
    const reservation = result.state.reservations.get(body.reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${body.reservationId}`
      );
    };
    const channel = (0,__vite_ssr_import_1__.microchargeChannelForCreditReservation)(
      result.state,
      reservation.reservationId
    );
    if (!channel.ok) {
      throw new Error(channel.detail);
    };
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId)
        ),
        reservation: reservationJson(reservation),
        channel: {
          channelId: channel.channel.channelId,
          escrowMicros: channel.channel.escrowMicros.toString(),
          committedMicros: channel.channel.committedMicros.toString(),
          lastCumulativeMicros: channel.channel.lastCumulativeMicros.toString()
        }
      },
      result.replayed ? 200 : 201
    );
  });
  route.post("/commerce/prepaid-credits/reservations/:reservationId/settle", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const reservationId = c.req.param("reservationId");
    const body = await jsonObject(c.req.raw);
    if (!validId(reservationId) || !body || !Number.isSafeInteger(body.committedMicros) || Number(body.committedMicros) < 0) {
      return c.json(
        {
          error: "invalid_request",
          detail: "reservationId and a non-negative safe-integer committedMicros are required"
        },
        400
      );
    };
    const result = await (0,__vite_ssr_import_3__.appendPrepaidCreditEvent)(c.env.DB, {
      creditEventId: `credit:settle:${reservationId}`,
      kind: "credit.settled",
      principalId: auth.principalId,
      payload: {
        reservationId,
        committedMicros: Number(body.committedMicros)
      }
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code)
      );
    };
    const reservation = result.state.reservations.get(reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${reservationId}`
      );
    };
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId)
        ),
        reservation: reservationJson(reservation)
      },
      result.replayed ? 200 : 201
    );
  });
  route.post("/commerce/prepaid-credits/reservations/:reservationId/release", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    const reservationId = c.req.param("reservationId");
    if (!validId(reservationId)) {
      return c.json(
        { error: "invalid_request", detail: "reservationId is invalid" },
        400
      );
    };
    const result = await (0,__vite_ssr_import_3__.appendPrepaidCreditEvent)(c.env.DB, {
      creditEventId: `credit:release:${reservationId}`,
      kind: "credit.released",
      principalId: auth.principalId,
      payload: { reservationId }
    });
    if (!result.ok) {
      return c.json(
        { error: result.code, detail: result.detail },
        rejectionStatus(result.code)
      );
    };
    const reservation = result.state.reservations.get(reservationId);
    if (!reservation) {
      throw new Error(
        `accepted prepaid credit event did not project reservation ${reservationId}`
      );
    };
    return c.json(
      {
        replayed: result.replayed,
        balance: balanceJson(
          auth.principalId,
          result.state.balances.get(auth.principalId)
        ),
        reservation: reservationJson(reservation)
      },
      result.replayed ? 200 : 201
    );
  });
  return route;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LFFBQzVDLGdCQUFnQixPQUFPLElBQUk7QUFBQSxNQUM3QjtBQUFBLElBQ0Y7QUFDQSxVQUFNLGNBQWMsT0FBTyxNQUFNLGFBQWEsSUFBSSxhQUFhO0FBQy9ELFFBQUksQ0FBQyxhQUFhO0FBQ2hCLFlBQU0sSUFBSTtBQUFBLFFBQ1IsNkRBQTZELGFBQWE7QUFBQSxNQUM1RTtBQUFBLElBQ0Y7QUFDQSxXQUFPLEVBQUU7QUFBQSxNQUNQO0FBQUEsUUFDRSxVQUFVLE9BQU87QUFBQSxRQUNqQixTQUFTO0FBQUEsVUFDUCxLQUFLO0FBQUEsVUFDTCxPQUFPLE1BQU0sU0FBUyxJQUFJLEtBQUssV0FBVztBQUFBLFFBQzVDO0FBQUEsUUFDQSxhQUFhLGdCQUFnQixXQUFXO0FBQUEsTUFDMUM7QUFBQSxNQUNBLE9BQU8sV0FBVyxNQUFNO0FBQUEsSUFDMUI7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPO0FBQ1QiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInByZXBhaWQtY3JlZGl0cy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEF1dGhlbnRpY2F0ZWQgV29ya2VyIGRvb3IgZm9yIFN0cmlwZS1mdW5kZWQgcHJlcGFpZCBCWU9DIGNyZWRpdHMuXG4gKlxuICogUHJpbmNpcGFsIGlkZW50aXR5IGFsd2F5cyBjb21lcyBmcm9tIHRoZSBHaXRIdWIgYmVhcmVyLiBDYWxsZXJzIGNhbiByZXNlcnZlXG4gKiB0aGVpciBiYWxhbmNlIGludG8gYSBtaWNyb2NoYXJnZSBjaGFubmVsLCB0aGVuIHNldHRsZSBvciByZWxlYXNlIHRoYXQgZXhhY3RcbiAqIHJlc2VydmF0aW9uOyBubyByb3V0ZSBhY2NlcHRzIGEgY2FsbGVyLXN1cHBsaWVkIHByaW5jaXBhbCBpZC5cbiAqL1xuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHtcbiAgbWljcm9jaGFyZ2VDaGFubmVsRm9yQ3JlZGl0UmVzZXJ2YXRpb24sXG4gIHR5cGUgUHJlcGFpZENyZWRpdEJhbGFuY2UsXG4gIHR5cGUgUHJlcGFpZENyZWRpdFJlamVjdGlvbkNvZGUsXG4gIHR5cGUgUHJlcGFpZENyZWRpdFJlc2VydmF0aW9uLFxufSBmcm9tICdAcGFwZXJjdXNwL29wZXJhdG9yLWNvcmUvbGliL2N1cGJvYXJkL3ByZXBhaWQtY3JlZGl0cy50cyc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQgeyBBdXRoRXJyb3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7XG4gIGFwcGVuZFByZXBhaWRDcmVkaXRFdmVudCxcbiAgbG9hZFByZXBhaWRDcmVkaXRTdGF0ZSxcbn0gZnJvbSAnLi4vcHJlcGFpZC1jcmVkaXQtc3RvcmUudHMnO1xuXG5mdW5jdGlvbiBwcmluY2lwYWxJZCh1c2VyOiB7IGlkOiBudW1iZXIgfSk6IHN0cmluZyB7XG4gIHJldHVybiBgZ2g6JHt1c2VyLmlkfWA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF1dGhlbnRpY2F0ZShyZXF1ZXN0OiBSZXF1ZXN0KTogUHJvbWlzZTxcbiAgfCB7IG9rOiB0cnVlOyBwcmluY2lwYWxJZDogc3RyaW5nIH1cbiAgfCB7IG9rOiBmYWxzZTsgcmVhc29uOiBBdXRoRXJyb3JbJ3JlYXNvbiddIH1cbj4ge1xuICB0cnkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBwcmluY2lwYWxJZDogcHJpbmNpcGFsSWQoYXdhaXQgcmVzb2x2ZUdpdGh1YkJlYXJlcihyZXF1ZXN0KSkgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBlcnJvci5yZWFzb24gfTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBqc29uT2JqZWN0KHJlcXVlc3Q6IFJlcXVlc3QpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHZhbHVlOiB1bmtub3duID0gYXdhaXQgcmVxdWVzdC5qc29uKCk7XG4gICAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpXG4gICAgICA/ICh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilcbiAgICAgIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRJZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJlxuICAgIC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll86LV17MCwxOTl9JC8udGVzdCh2YWx1ZSlcbiAgKTtcbn1cblxuZnVuY3Rpb24gYmFsYW5jZUpzb24oXG4gIHByaW5jaXBhbDogc3RyaW5nLFxuICBiYWxhbmNlOiBQcmVwYWlkQ3JlZGl0QmFsYW5jZSB8IHVuZGVmaW5lZCxcbikge1xuICByZXR1cm4gKFxuICAgIGJhbGFuY2UgPz8ge1xuICAgICAgcHJpbmNpcGFsSWQ6IHByaW5jaXBhbCxcbiAgICAgIGF2YWlsYWJsZU1pY3JvczogMCxcbiAgICAgIHJlc2VydmVkTWljcm9zOiAwLFxuICAgICAgc3BlbnRNaWNyb3M6IDAsXG4gICAgICBkZWJ0TWljcm9zOiAwLFxuICAgICAgZ3JhbnRlZE1pY3JvczogMCxcbiAgICAgIHJldmVyc2VkTWljcm9zOiAwLFxuICAgICAgdXBkYXRlZEF0TXM6IDAsXG4gICAgfVxuICApO1xufVxuXG5mdW5jdGlvbiByZXNlcnZhdGlvbkpzb24ocmVzZXJ2YXRpb246IFByZXBhaWRDcmVkaXRSZXNlcnZhdGlvbikge1xuICByZXR1cm4ge1xuICAgIHJlc2VydmF0aW9uSWQ6IHJlc2VydmF0aW9uLnJlc2VydmF0aW9uSWQsXG4gICAgY2hhbm5lbElkOiByZXNlcnZhdGlvbi5jaGFubmVsSWQsXG4gICAgcmVzZXJ2ZWRNaWNyb3M6IHJlc2VydmF0aW9uLnJlc2VydmVkTWljcm9zLFxuICAgIGNvbW1pdHRlZE1pY3JvczogcmVzZXJ2YXRpb24uY29tbWl0dGVkTWljcm9zLFxuICAgIHN0YXRlOiByZXNlcnZhdGlvbi5zdGF0ZSxcbiAgICBjcmVhdGVkQXRNczogcmVzZXJ2YXRpb24uY3JlYXRlZEF0TXMsXG4gICAgdXBkYXRlZEF0TXM6IHJlc2VydmF0aW9uLnVwZGF0ZWRBdE1zLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZWplY3Rpb25TdGF0dXMoXG4gIGNvZGU6IFByZXBhaWRDcmVkaXRSZWplY3Rpb25Db2RlLFxuKTogNDA0IHwgNDA5IHwgNDIyIHtcbiAgaWYgKGNvZGUgPT09ICd1bmtub3duLXJlc2VydmF0aW9uJykgcmV0dXJuIDQwNDtcbiAgaWYgKFxuICAgIGNvZGUgPT09ICduZWdhdGl2ZS1iYWxhbmNlJyB8fFxuICAgIGNvZGUgPT09ICdkdXBsaWNhdGUtY29uZmxpY3QnIHx8XG4gICAgY29kZSA9PT0gJ3Jlc2VydmF0aW9uLWNvbmZsaWN0JyB8fFxuICAgIGNvZGUgPT09ICdpbnZhbGlkLXRyYW5zaXRpb24nXG4gICkge1xuICAgIHJldHVybiA0MDk7XG4gIH1cbiAgcmV0dXJuIDQyMjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhaWRDcmVkaXRzUm91dGUoKTogSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4ge1xuICBjb25zdCByb3V0ZSA9IG5ldyBIb25vPHsgQmluZGluZ3M6IEVudiB9PigpO1xuXG4gIHJvdXRlLmdldCgnL2NvbW1lcmNlL3ByZXBhaWQtY3JlZGl0cy9iYWxhbmNlJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG5cbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGxvYWRQcmVwYWlkQ3JlZGl0U3RhdGUoYy5lbnYuREIpO1xuICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgcHJpbmNpcGFsSWQ6IGF1dGgucHJpbmNpcGFsSWQsXG4gICAgICBiYWxhbmNlOiBiYWxhbmNlSnNvbihhdXRoLnByaW5jaXBhbElkLCBzdGF0ZS5iYWxhbmNlcy5nZXQoYXV0aC5wcmluY2lwYWxJZCkpLFxuICAgIH0pO1xuICB9KTtcblxuICByb3V0ZS5wb3N0KCcvY29tbWVyY2UvcHJlcGFpZC1jcmVkaXRzL3Jlc2VydmF0aW9ucycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IGF1dGhlbnRpY2F0ZShjLnJlcS5yYXcpO1xuICAgIGlmICghYXV0aC5vaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5hdXRob3JpemVkJywgcmVhc29uOiBhdXRoLnJlYXNvbiB9LCA0MDEpO1xuXG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGpzb25PYmplY3QoYy5yZXEucmF3KTtcbiAgICBpZiAoXG4gICAgICAhYm9keSB8fFxuICAgICAgIXZhbGlkSWQoYm9keS5yZXNlcnZhdGlvbklkKSB8fFxuICAgICAgIXZhbGlkSWQoYm9keS5jaGFubmVsSWQpIHx8XG4gICAgICAhTnVtYmVyLmlzU2FmZUludGVnZXIoYm9keS5hbW91bnRNaWNyb3MpIHx8XG4gICAgICBOdW1iZXIoYm9keS5hbW91bnRNaWNyb3MpIDw9IDBcbiAgICApIHtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHtcbiAgICAgICAgICBlcnJvcjogJ2ludmFsaWRfcmVxdWVzdCcsXG4gICAgICAgICAgZGV0YWlsOlxuICAgICAgICAgICAgJ3Jlc2VydmF0aW9uSWQsIGNoYW5uZWxJZCBhbmQgYSBwb3NpdGl2ZSBzYWZlLWludGVnZXIgYW1vdW50TWljcm9zIGFyZSByZXF1aXJlZCcsXG4gICAgICAgIH0sXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYXBwZW5kUHJlcGFpZENyZWRpdEV2ZW50KGMuZW52LkRCLCB7XG4gICAgICBjcmVkaXRFdmVudElkOiBgY3JlZGl0OnJlc2VydmU6JHtib2R5LnJlc2VydmF0aW9uSWR9YCxcbiAgICAgIGtpbmQ6ICdjcmVkaXQucmVzZXJ2ZWQnLFxuICAgICAgcHJpbmNpcGFsSWQ6IGF1dGgucHJpbmNpcGFsSWQsXG4gICAgICBwYXlsb2FkOiB7XG4gICAgICAgIHJlc2VydmF0aW9uSWQ6IGJvZHkucmVzZXJ2YXRpb25JZCxcbiAgICAgICAgY2hhbm5lbElkOiBib2R5LmNoYW5uZWxJZCxcbiAgICAgICAgYW1vdW50TWljcm9zOiBOdW1iZXIoYm9keS5hbW91bnRNaWNyb3MpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogcmVzdWx0LmNvZGUsIGRldGFpbDogcmVzdWx0LmRldGFpbCB9LFxuICAgICAgICByZWplY3Rpb25TdGF0dXMocmVzdWx0LmNvZGUpLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXNlcnZhdGlvbiA9IHJlc3VsdC5zdGF0ZS5yZXNlcnZhdGlvbnMuZ2V0KGJvZHkucmVzZXJ2YXRpb25JZCk7XG4gICAgaWYgKCFyZXNlcnZhdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgYWNjZXB0ZWQgcHJlcGFpZCBjcmVkaXQgZXZlbnQgZGlkIG5vdCBwcm9qZWN0IHJlc2VydmF0aW9uICR7Ym9keS5yZXNlcnZhdGlvbklkfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBjaGFubmVsID0gbWljcm9jaGFyZ2VDaGFubmVsRm9yQ3JlZGl0UmVzZXJ2YXRpb24oXG4gICAgICByZXN1bHQuc3RhdGUsXG4gICAgICByZXNlcnZhdGlvbi5yZXNlcnZhdGlvbklkLFxuICAgICk7XG4gICAgaWYgKCFjaGFubmVsLm9rKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoY2hhbm5lbC5kZXRhaWwpO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKFxuICAgICAge1xuICAgICAgICByZXBsYXllZDogcmVzdWx0LnJlcGxheWVkLFxuICAgICAgICBiYWxhbmNlOiBiYWxhbmNlSnNvbihcbiAgICAgICAgICBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICAgIHJlc3VsdC5zdGF0ZS5iYWxhbmNlcy5nZXQoYXV0aC5wcmluY2lwYWxJZCksXG4gICAgICAgICksXG4gICAgICAgIHJlc2VydmF0aW9uOiByZXNlcnZhdGlvbkpzb24ocmVzZXJ2YXRpb24pLFxuICAgICAgICBjaGFubmVsOiB7XG4gICAgICAgICAgY2hhbm5lbElkOiBjaGFubmVsLmNoYW5uZWwuY2hhbm5lbElkLFxuICAgICAgICAgIGVzY3Jvd01pY3JvczogY2hhbm5lbC5jaGFubmVsLmVzY3Jvd01pY3Jvcy50b1N0cmluZygpLFxuICAgICAgICAgIGNvbW1pdHRlZE1pY3JvczogY2hhbm5lbC5jaGFubmVsLmNvbW1pdHRlZE1pY3Jvcy50b1N0cmluZygpLFxuICAgICAgICAgIGxhc3RDdW11bGF0aXZlTWljcm9zOiBjaGFubmVsLmNoYW5uZWwubGFzdEN1bXVsYXRpdmVNaWNyb3MudG9TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICByZXN1bHQucmVwbGF5ZWQgPyAyMDAgOiAyMDEsXG4gICAgKTtcbiAgfSk7XG5cbiAgcm91dGUucG9zdCgnL2NvbW1lcmNlL3ByZXBhaWQtY3JlZGl0cy9yZXNlcnZhdGlvbnMvOnJlc2VydmF0aW9uSWQvc2V0dGxlJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBhdXRoID0gYXdhaXQgYXV0aGVudGljYXRlKGMucmVxLnJhdyk7XG4gICAgaWYgKCFhdXRoLm9rKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmF1dGhvcml6ZWQnLCByZWFzb246IGF1dGgucmVhc29uIH0sIDQwMSk7XG5cbiAgICBjb25zdCByZXNlcnZhdGlvbklkID0gYy5yZXEucGFyYW0oJ3Jlc2VydmF0aW9uSWQnKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQganNvbk9iamVjdChjLnJlcS5yYXcpO1xuICAgIGlmIChcbiAgICAgICF2YWxpZElkKHJlc2VydmF0aW9uSWQpIHx8XG4gICAgICAhYm9keSB8fFxuICAgICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGJvZHkuY29tbWl0dGVkTWljcm9zKSB8fFxuICAgICAgTnVtYmVyKGJvZHkuY29tbWl0dGVkTWljcm9zKSA8IDBcbiAgICApIHtcbiAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgIHtcbiAgICAgICAgICBlcnJvcjogJ2ludmFsaWRfcmVxdWVzdCcsXG4gICAgICAgICAgZGV0YWlsOlxuICAgICAgICAgICAgJ3Jlc2VydmF0aW9uSWQgYW5kIGEgbm9uLW5lZ2F0aXZlIHNhZmUtaW50ZWdlciBjb21taXR0ZWRNaWNyb3MgYXJlIHJlcXVpcmVkJyxcbiAgICAgICAgfSxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcHBlbmRQcmVwYWlkQ3JlZGl0RXZlbnQoYy5lbnYuREIsIHtcbiAgICAgIGNyZWRpdEV2ZW50SWQ6IGBjcmVkaXQ6c2V0dGxlOiR7cmVzZXJ2YXRpb25JZH1gLFxuICAgICAga2luZDogJ2NyZWRpdC5zZXR0bGVkJyxcbiAgICAgIHByaW5jaXBhbElkOiBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgcGF5bG9hZDoge1xuICAgICAgICByZXNlcnZhdGlvbklkLFxuICAgICAgICBjb21taXR0ZWRNaWNyb3M6IE51bWJlcihib2R5LmNvbW1pdHRlZE1pY3JvcyksXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgICByZXR1cm4gYy5qc29uKFxuICAgICAgICB7IGVycm9yOiByZXN1bHQuY29kZSwgZGV0YWlsOiByZXN1bHQuZGV0YWlsIH0sXG4gICAgICAgIHJlamVjdGlvblN0YXR1cyhyZXN1bHQuY29kZSksXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCByZXNlcnZhdGlvbiA9IHJlc3VsdC5zdGF0ZS5yZXNlcnZhdGlvbnMuZ2V0KHJlc2VydmF0aW9uSWQpO1xuICAgIGlmICghcmVzZXJ2YXRpb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYGFjY2VwdGVkIHByZXBhaWQgY3JlZGl0IGV2ZW50IGRpZCBub3QgcHJvamVjdCByZXNlcnZhdGlvbiAke3Jlc2VydmF0aW9uSWR9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBjLmpzb24oXG4gICAgICB7XG4gICAgICAgIHJlcGxheWVkOiByZXN1bHQucmVwbGF5ZWQsXG4gICAgICAgIGJhbGFuY2U6IGJhbGFuY2VKc29uKFxuICAgICAgICAgIGF1dGgucHJpbmNpcGFsSWQsXG4gICAgICAgICAgcmVzdWx0LnN0YXRlLmJhbGFuY2VzLmdldChhdXRoLnByaW5jaXBhbElkKSxcbiAgICAgICAgKSxcbiAgICAgICAgcmVzZXJ2YXRpb246IHJlc2VydmF0aW9uSnNvbihyZXNlcnZhdGlvbiksXG4gICAgICB9LFxuICAgICAgcmVzdWx0LnJlcGxheWVkID8gMjAwIDogMjAxLFxuICAgICk7XG4gIH0pO1xuXG4gIHJvdXRlLnBvc3QoJy9jb21tZXJjZS9wcmVwYWlkLWNyZWRpdHMvcmVzZXJ2YXRpb25zLzpyZXNlcnZhdGlvbklkL3JlbGVhc2UnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGF1dGggPSBhd2FpdCBhdXRoZW50aWNhdGUoYy5yZXEucmF3KTtcbiAgICBpZiAoIWF1dGgub2spIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3VuYXV0aG9yaXplZCcsIHJlYXNvbjogYXV0aC5yZWFzb24gfSwgNDAxKTtcblxuICAgIGNvbnN0IHJlc2VydmF0aW9uSWQgPSBjLnJlcS5wYXJhbSgncmVzZXJ2YXRpb25JZCcpO1xuICAgIGlmICghdmFsaWRJZChyZXNlcnZhdGlvbklkKSkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogJ2ludmFsaWRfcmVxdWVzdCcsIGRldGFpbDogJ3Jlc2VydmF0aW9uSWQgaXMgaW52YWxpZCcgfSxcbiAgICAgICAgNDAwLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhcHBlbmRQcmVwYWlkQ3JlZGl0RXZlbnQoYy5lbnYuREIsIHtcbiAgICAgIGNyZWRpdEV2ZW50SWQ6IGBjcmVkaXQ6cmVsZWFzZToke3Jlc2VydmF0aW9uSWR9YCxcbiAgICAgIGtpbmQ6ICdjcmVkaXQucmVsZWFzZWQnLFxuICAgICAgcHJpbmNpcGFsSWQ6IGF1dGgucHJpbmNpcGFsSWQsXG4gICAgICBwYXlsb2FkOiB7IHJlc2VydmF0aW9uSWQgfSxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogcmVzdWx0LmNvZGUsIGRldGFpbDogcmVzdWx0LmRldGFpbCB9LFxuICAgICAgICByZWplY3Rpb25TdGF0dXMocmVzdWx0LmNvZGUpLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmVzZXJ2YXRpb24gPSByZXN1bHQuc3RhdGUucmVzZXJ2YXRpb25zLmdldChyZXNlcnZhdGlvbklkKTtcbiAgICBpZiAoIXJlc2VydmF0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBhY2NlcHRlZCBwcmVwYWlkIGNyZWRpdCBldmVudCBkaWQgbm90IHByb2plY3QgcmVzZXJ2YXRpb24gJHtyZXNlcnZhdGlvbklkfWAsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKFxuICAgICAge1xuICAgICAgICByZXBsYXllZDogcmVzdWx0LnJlcGxheWVkLFxuICAgICAgICBiYWxhbmNlOiBiYWxhbmNlSnNvbihcbiAgICAgICAgICBhdXRoLnByaW5jaXBhbElkLFxuICAgICAgICAgIHJlc3VsdC5zdGF0ZS5iYWxhbmNlcy5nZXQoYXV0aC5wcmluY2lwYWxJZCksXG4gICAgICAgICksXG4gICAgICAgIHJlc2VydmF0aW9uOiByZXNlcnZhdGlvbkpzb24ocmVzZXJ2YXRpb24pLFxuICAgICAgfSxcbiAgICAgIHJlc3VsdC5yZXBsYXllZCA/IDIwMCA6IDIwMSxcbiAgICApO1xuICB9KTtcblxuICByZXR1cm4gcm91dGU7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL3ByZXBhaWQtY3JlZGl0cy50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9wcmVwYWlkLWNyZWRpdHMudHMiLCIvc3JjL3JvdXRlcy9wcmVwYWlkLWNyZWRpdHMudHMiLFtdXQ==
}}