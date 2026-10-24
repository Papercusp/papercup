__vite_ssr_exportName__("reportsRoute", () => { try { return reportsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["audit","clientIp","getHarnessById","insertReport","ipHash"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/ratelimit.ts", {"importedNames":["checkUserReportHourly","RateLimitError"]});




function uuidv4() {
  return crypto.randomUUID();
}
function reportsRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.post("/reports", async (c) => {
    let user;
    try {
      user = await (0,__vite_ssr_import_1__.resolveGithubBearer)(c.req.raw);
    } catch (e) {
      if (e instanceof __vite_ssr_import_1__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
      throw e;
    };
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (typeof body.harness_id !== "string" || !body.harness_id) {
      return c.json({ error: "invalid_field", field: "harness_id" }, 400);
    };
    if (typeof body.reason !== "string" || !body.reason.trim()) {
      return c.json({ error: "invalid_field", field: "reason" }, 400);
    };
    if (body.reason.length > 1e3) {
      return c.json({ error: "reason_too_long", max: 1e3 }, 400);
    };
    try {
      await (0,__vite_ssr_import_3__.checkUserReportHourly)(c.env, user.id);
    } catch (e) {
      if (e instanceof __vite_ssr_import_3__.RateLimitError) return c.json({ error: "rate_limited" }, 429);
      throw e;
    };
    const harness = await (0,__vite_ssr_import_2__.getHarnessById)(c.env.DB, body.harness_id);
    if (!harness) return c.json({ error: "harness_not_found" }, 404);
    const now = Date.now();
    const ip = (0,__vite_ssr_import_2__.clientIp)(c.req.raw);
    const ip_hash_value = ip ? await (0,__vite_ssr_import_2__.ipHash)(ip, c.env.IP_HASH_PEPPER) : "";
    const id = uuidv4();
    await (0,__vite_ssr_import_2__.insertReport)(c.env.DB, {
      id,
      harness_id: body.harness_id,
      reporter_github_user_id: user.id,
      reporter_github_login: user.login,
      reason: body.reason.trim(),
      ip_hash: ip_hash_value || null,
      created_at: now
    });
    await (0,__vite_ssr_import_2__.audit)(c.env.DB, now, "reported", {
      id,
      harness_id: body.harness_id,
      reporter_user_id: user.id
    });
    return c.json({ ok: true, id });
  });
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTtBQVlBO0FBRUE7QUFDQTtBQU9BOzs7OztBQU9BLFNBQVMsU0FBaUI7QUFDeEIsU0FBUSxPQUF3QyxXQUFXO0FBQzdEO0FBRU8sU0FBUyxlQUF3QztBQUN0RCxRQUFNLE1BQU0sSUFBSSwyQkFBd0I7QUFFeEMsTUFBSSxLQUFLLFlBQVksT0FBTyxNQUFNO0FBQ2hDLFFBQUk7QUFDSixRQUFJO0FBQ0YsYUFBTyxTQUFNLDJDQUFvQixFQUFFLElBQUksR0FBRztBQUFBLElBQzVDLFNBQVMsR0FBRztBQUNWLFVBQUksYUFBYSxnQ0FBVyxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxHQUFHLEdBQUc7QUFDbEYsWUFBTTtBQUFBLElBQ1I7QUFFQSxRQUFJO0FBQ0osUUFBSTtBQUNGLGFBQVEsTUFBTSxFQUFFLElBQUksS0FBSztBQUFBLElBQzNCLFFBQVE7QUFDTixhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sZUFBZSxHQUFHLEdBQUc7QUFBQSxJQUM5QztBQUNBLFFBQUksT0FBTyxLQUFLLGVBQWUsWUFBWSxDQUFDLEtBQUssWUFBWTtBQUMzRCxhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8saUJBQWlCLE9BQU8sYUFBYSxHQUFHLEdBQUc7QUFBQSxJQUNwRTtBQUNBLFFBQUksT0FBTyxLQUFLLFdBQVcsWUFBWSxDQUFDLEtBQUssT0FBTyxLQUFLLEdBQUc7QUFDMUQsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGlCQUFpQixPQUFPLFNBQVMsR0FBRyxHQUFHO0FBQUEsSUFDaEU7QUFDQSxRQUFJLEtBQUssT0FBTyxTQUFTLEtBQU07QUFDN0IsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLG1CQUFtQixLQUFLLElBQUssR0FBRyxHQUFHO0FBQUEsSUFDNUQ7QUFFQSxRQUFJO0FBQ0YsZUFBTSw2Q0FBc0IsRUFBRSxLQUFLLEtBQUssRUFBRTtBQUFBLElBQzVDLFNBQVMsR0FBRztBQUNWLFVBQUksYUFBYSxxQ0FBZ0IsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGVBQWUsR0FBRyxHQUFHO0FBQzdFLFlBQU07QUFBQSxJQUNSO0FBRUEsVUFBTSxVQUFVLFNBQU0sc0NBQWUsRUFBRSxJQUFJLElBQUksS0FBSyxVQUFVO0FBQzlELFFBQUksQ0FBQyxRQUFTLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxvQkFBb0IsR0FBRyxHQUFHO0FBRS9ELFVBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsVUFBTSxRQUFLLGdDQUFTLEVBQUUsSUFBSSxHQUFHO0FBQzdCLFVBQU0sZ0JBQWdCLEtBQUssU0FBTSw4QkFBTyxJQUFJLEVBQUUsSUFBSSxjQUFjLElBQUk7QUFDcEUsVUFBTSxLQUFLLE9BQU87QUFFbEIsYUFBTSxvQ0FBYSxFQUFFLElBQUksSUFBSTtBQUFBLE1BQzNCO0FBQUEsTUFDQSxZQUFZLEtBQUs7QUFBQSxNQUNqQix5QkFBeUIsS0FBSztBQUFBLE1BQzlCLHVCQUF1QixLQUFLO0FBQUEsTUFDNUIsUUFBUSxLQUFLLE9BQU8sS0FBSztBQUFBLE1BQ3pCLFNBQVMsaUJBQWlCO0FBQUEsTUFDMUIsWUFBWTtBQUFBLElBQ2QsQ0FBQztBQUNELGFBQU0sNkJBQU0sRUFBRSxJQUFJLElBQUksS0FBSyxZQUFZO0FBQUEsTUFDckM7QUFBQSxNQUNBLFlBQVksS0FBSztBQUFBLE1BQ2pCLGtCQUFrQixLQUFLO0FBQUEsSUFDekIsQ0FBQztBQUNELFdBQU8sRUFBRSxLQUFLLEVBQUUsSUFBSSxNQUFNLEdBQUcsQ0FBQztBQUFBLEVBQ2hDLENBQUM7QUFFRCxTQUFPO0FBQ1QiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInJlcG9ydHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQT1NUIC9yZXBvcnRzIOKAlCBmaWxlIGFuIGFidXNlIHJlcG9ydCBhZ2FpbnN0IGEgQ3VwYm9hcmQgbGlzdGluZy5cbiAqXG4gKiB2NSDCpzEwLjMgKyBhZGRlbmR1bSAxOiBHaXRIdWItYXV0aGVkOyByZXBvcnRlciBpZGVudGl0eSByZWNvcmRlZC5cbiAqIFBlci11c2VyIHJhdGUgbGltaXQgMTAvaHIuIFN0b3JlcyBoYXNoZWQgcmVwb3J0ZXIgSVAgZm9yIGRlZHVwZS5cbiAqXG4gKiBPcGVyYXRvciByZXZpZXcvcmVzb2x1dGlvbiBpcyB0aGUgL2FkbWluIG1vZGVyYXRpb24gc3VyZmFjZVxuICogKHJvdXRlcy9hZG1pbi50cyk6IEdFVCAvYWRtaW4vcmVwb3J0cyArIFBPU1QgL2FkbWluL3JlcG9ydHMvOmlkL3Jlc29sdmUuXG4gKiBUaGlzIGVuZHBvaW50IGp1c3QgbGFuZHMgcGVuZGluZyByb3dzOyBhbiBvcGVyYXRvciB0cmlhZ2VzIHRoZW0gdGhlcmUuXG4gKiAoQSBkZXNrdG9wLW9wZXJhdG9yIG1vZGVyYXRpb24gVUkgb24gdG9wIG9mIC9hZG1pbiBpcyB0aGUgcmVtYWluaW5nIHBpZWNlLilcbiAqL1xuXG5pbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQgeyBBdXRoRXJyb3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7XG4gIGF1ZGl0LFxuICBjbGllbnRJcCxcbiAgZ2V0SGFybmVzc0J5SWQsXG4gIGluc2VydFJlcG9ydCxcbiAgaXBIYXNoLFxufSBmcm9tICcuLi9kYi50cyc7XG5pbXBvcnQgeyBjaGVja1VzZXJSZXBvcnRIb3VybHksIFJhdGVMaW1pdEVycm9yIH0gZnJvbSAnLi4vcmF0ZWxpbWl0LnRzJztcblxuaW50ZXJmYWNlIFJlcG9ydEJvZHkge1xuICBoYXJuZXNzX2lkOiBzdHJpbmc7XG4gIHJlYXNvbjogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiB1dWlkdjQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChjcnlwdG8gYXMgeyByYW5kb21VVUlEOiAoKSA9PiBzdHJpbmcgfSkucmFuZG9tVVVJRCgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0c1JvdXRlKCk6IEhvbm88eyBCaW5kaW5nczogRW52IH0+IHtcbiAgY29uc3QgYXBwID0gbmV3IEhvbm88eyBCaW5kaW5nczogRW52IH0+KCk7XG5cbiAgYXBwLnBvc3QoJy9yZXBvcnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBsZXQgdXNlcjtcbiAgICB0cnkge1xuICAgICAgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIEF1dGhFcnJvcikgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXV0aCcsIHJlYXNvbjogZS5yZWFzb24gfSwgNDAxKTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuXG4gICAgbGV0IGJvZHk6IFJlcG9ydEJvZHk7XG4gICAgdHJ5IHtcbiAgICAgIGJvZHkgPSAoYXdhaXQgYy5yZXEuanNvbigpKSBhcyBSZXBvcnRCb2R5O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9qc29uJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkuaGFybmVzc19pZCAhPT0gJ3N0cmluZycgfHwgIWJvZHkuaGFybmVzc19pZCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnaGFybmVzc19pZCcgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LnJlYXNvbiAhPT0gJ3N0cmluZycgfHwgIWJvZHkucmVhc29uLnRyaW0oKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncmVhc29uJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5yZWFzb24ubGVuZ3RoID4gMTAwMCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncmVhc29uX3Rvb19sb25nJywgbWF4OiAxMDAwIH0sIDQwMCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNoZWNrVXNlclJlcG9ydEhvdXJseShjLmVudiwgdXNlci5pZCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSYXRlTGltaXRFcnJvcikgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncmF0ZV9saW1pdGVkJyB9LCA0MjkpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG5cbiAgICBjb25zdCBoYXJuZXNzID0gYXdhaXQgZ2V0SGFybmVzc0J5SWQoYy5lbnYuREIsIGJvZHkuaGFybmVzc19pZCk7XG4gICAgaWYgKCFoYXJuZXNzKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdoYXJuZXNzX25vdF9mb3VuZCcgfSwgNDA0KTtcblxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgaXAgPSBjbGllbnRJcChjLnJlcS5yYXcpO1xuICAgIGNvbnN0IGlwX2hhc2hfdmFsdWUgPSBpcCA/IGF3YWl0IGlwSGFzaChpcCwgYy5lbnYuSVBfSEFTSF9QRVBQRVIpIDogJyc7XG4gICAgY29uc3QgaWQgPSB1dWlkdjQoKTtcblxuICAgIGF3YWl0IGluc2VydFJlcG9ydChjLmVudi5EQiwge1xuICAgICAgaWQsXG4gICAgICBoYXJuZXNzX2lkOiBib2R5Lmhhcm5lc3NfaWQsXG4gICAgICByZXBvcnRlcl9naXRodWJfdXNlcl9pZDogdXNlci5pZCxcbiAgICAgIHJlcG9ydGVyX2dpdGh1Yl9sb2dpbjogdXNlci5sb2dpbixcbiAgICAgIHJlYXNvbjogYm9keS5yZWFzb24udHJpbSgpLFxuICAgICAgaXBfaGFzaDogaXBfaGFzaF92YWx1ZSB8fCBudWxsLFxuICAgICAgY3JlYXRlZF9hdDogbm93LFxuICAgIH0pO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdyZXBvcnRlZCcsIHtcbiAgICAgIGlkLFxuICAgICAgaGFybmVzc19pZDogYm9keS5oYXJuZXNzX2lkLFxuICAgICAgcmVwb3J0ZXJfdXNlcl9pZDogdXNlci5pZCxcbiAgICB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkIH0pO1xuICB9KTtcblxuICByZXR1cm4gYXBwO1xufVxuIl0sImZpbGUiOiIvc3JjL3JvdXRlcy9yZXBvcnRzLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9yZXBvcnRzLnRzIiwiL3NyYy9yb3V0ZXMvcmVwb3J0cy50cyIsW11d