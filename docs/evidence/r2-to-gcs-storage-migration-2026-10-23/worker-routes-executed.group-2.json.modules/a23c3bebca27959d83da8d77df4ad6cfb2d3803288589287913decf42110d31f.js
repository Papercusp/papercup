__vite_ssr_exportName__("adminRoute", () => { try { return adminRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["setDeploymentStatus"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/r2-archive.ts", {"importedNames":["deletePrefix"]});



function adminRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.post("/admin/gc/abandoned-uploads", async (c) => {
    const cutoff = Date.now() - 60 * 60 * 1e3;
    const stale = await c.env.DB.prepare(
      "SELECT id, tenant_id, harness_slug FROM deployments WHERE status = 'uploading' AND created_at < ?"
    ).bind(cutoff).all();
    let killed = 0;
    for (const r of stale.results ?? []) {
      await (0,__vite_ssr_import_1__.setDeploymentStatus)(c.env.DB, r.id, "failed", {
        failure_reason: "abandoned (gc)"
      });
      killed++;
    };
    return c.json({ killed });
  });
  app.post("/admin/gc/expired-archives", async (c) => {
    const now = Date.now();
    const freeCutoff = now - 30 * 24 * 60 * 60 * 1e3;
    const paidCutoff = now - 365 * 24 * 60 * 60 * 1e3;
    const expired = await c.env.DB.prepare(
      `SELECT d.id, d.tenant_id, t.tier
         FROM deployments d JOIN tenants t ON d.tenant_id = t.id
         WHERE d.archive_path IS NOT NULL
           AND ((t.tier = 'free' AND d.created_at < ?)
             OR (t.tier = 'paid' AND d.created_at < ?))`
    ).bind(freeCutoff, paidCutoff).all();
    let purged = 0;
    for (const r of expired.results ?? []) {
      await (0,__vite_ssr_import_2__.deletePrefix)(c.env, r.tenant_id, r.id);
      await c.env.DB.prepare("UPDATE deployments SET archive_path = NULL WHERE id = ?").bind(r.id).run();
      purged++;
    };
    return c.json({ purged });
  });
  app.post("/admin/gc/jti", async (c) => {
    const now = Math.floor(Date.now() / 1e3);
    await c.env.DB.prepare("DELETE FROM jti_used WHERE exp < ?").bind(now).run();
    return c.json({ ok: true });
  });
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTtBQUtBO0FBRUE7QUFDQTs7OztBQUdPLFNBQVMsYUFBc0M7QUFDcEQsUUFBTSxNQUFNLElBQUksMkJBQXdCO0FBSXhDLE1BQUksS0FBSywrQkFBK0IsT0FBTyxNQUFNO0FBQ25ELFVBQU0sU0FBUyxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUs7QUFDdEMsVUFBTSxRQUFRLE1BQU0sRUFBRSxJQUFJLEdBQ3ZCO0FBQUEsTUFDQztBQUFBLElBQ0YsRUFDQyxLQUFLLE1BQU0sRUFDWCxJQUE2RDtBQUNoRSxRQUFJLFNBQVM7QUFDYixlQUFXLEtBQUssTUFBTSxXQUFXLENBQUMsR0FBRztBQUNuQyxlQUFNLDJDQUFvQixFQUFFLElBQUksSUFBSSxFQUFFLElBQUksVUFBVTtBQUFBLFFBQ2xELGdCQUFnQjtBQUFBLE1BQ2xCLENBQUM7QUFDRDtBQUFBLElBQ0Y7QUFDQSxXQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sQ0FBQztBQUFBLEVBQzFCLENBQUM7QUFHRCxNQUFJLEtBQUssOEJBQThCLE9BQU8sTUFBTTtBQUNsRCxVQUFNLE1BQU0sS0FBSyxJQUFJO0FBQ3JCLFVBQU0sYUFBYSxNQUFNLEtBQUssS0FBSyxLQUFLLEtBQUs7QUFDN0MsVUFBTSxhQUFhLE1BQU0sTUFBTSxLQUFLLEtBQUssS0FBSztBQUM5QyxVQUFNLFVBQVUsTUFBTSxFQUFFLElBQUksR0FDekI7QUFBQSxNQUNDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtGLEVBQ0MsS0FBSyxZQUFZLFVBQVUsRUFDM0IsSUFBcUQ7QUFDeEQsUUFBSSxTQUFTO0FBQ2IsZUFBVyxLQUFLLFFBQVEsV0FBVyxDQUFDLEdBQUc7QUFDckMsZUFBTSxvQ0FBYSxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUUsRUFBRTtBQUMzQyxZQUFNLEVBQUUsSUFBSSxHQUNULFFBQVEseURBQXlELEVBQ2pFLEtBQUssRUFBRSxFQUFFLEVBQ1QsSUFBSTtBQUNQO0FBQUEsSUFDRjtBQUNBLFdBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxDQUFDO0FBQUEsRUFDMUIsQ0FBQztBQUdELE1BQUksS0FBSyxpQkFBaUIsT0FBTyxNQUFNO0FBQ3JDLFVBQU0sTUFBTSxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksR0FBSTtBQUN4QyxVQUFNLEVBQUUsSUFBSSxHQUFHLFFBQVEsb0NBQW9DLEVBQUUsS0FBSyxHQUFHLEVBQUUsSUFBSTtBQUMzRSxXQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksS0FBSyxDQUFDO0FBQUEsRUFDNUIsQ0FBQztBQUVELFNBQU87QUFDVCIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiYWRtaW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBZG1pbiAvIGNyb24gZW5kcG9pbnRzLiBIaXQgYnkgc2NoZWR1bGVkIHRyaWdnZXIgb25seSDigJQgbm90IGV4cG9zZWRcbiAqIHB1YmxpY2x5IChyb3V0ZSByZWFjaGFibGUsIGJ1dCBkb2VzIG5vIHdvcmsgd2l0aG91dCBpbnRlcm5hbCB0b2tlbikuXG4gKi9cblxuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuLi9lbnYudHMnO1xuaW1wb3J0IHsgc2V0RGVwbG95bWVudFN0YXR1cyB9IGZyb20gJy4uL2RiLnRzJztcbmltcG9ydCB7IGRlbGV0ZVByZWZpeCB9IGZyb20gJy4uL3IyLWFyY2hpdmUudHMnO1xuaW1wb3J0IHsgZGVsZXRlRGVwbG95bWVudCwgZ2V0UHJvamVjdCB9IGZyb20gJy4uL2NmLXBhZ2VzLnRzJztcblxuZXhwb3J0IGZ1bmN0aW9uIGFkbWluUm91dGUoKTogSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4ge1xuICBjb25zdCBhcHAgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4oKTtcblxuICAvLyBEZXBsb3ltZW50cyBzdHVjayBpbiAndXBsb2FkaW5nJyBmb3IgPiAxIGhvdXI6IGFiYW5kb24gdGhlbSwgZGVsZXRlIENGXG4gIC8vIHVwbG9hZCB0b2tlbnMgKENGIGF1dG8tZXhwaXJlcyB0aG9zZSksIEdDIHRoZSBEMSByb3cuXG4gIGFwcC5wb3N0KCcvYWRtaW4vZ2MvYWJhbmRvbmVkLXVwbG9hZHMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGN1dG9mZiA9IERhdGUubm93KCkgLSA2MCAqIDYwICogMTAwMDtcbiAgICBjb25zdCBzdGFsZSA9IGF3YWl0IGMuZW52LkRCXG4gICAgICAucHJlcGFyZShcbiAgICAgICAgXCJTRUxFQ1QgaWQsIHRlbmFudF9pZCwgaGFybmVzc19zbHVnIEZST00gZGVwbG95bWVudHMgV0hFUkUgc3RhdHVzID0gJ3VwbG9hZGluZycgQU5EIGNyZWF0ZWRfYXQgPCA/XCIsXG4gICAgICApXG4gICAgICAuYmluZChjdXRvZmYpXG4gICAgICAuYWxsPHsgaWQ6IHN0cmluZzsgdGVuYW50X2lkOiBzdHJpbmc7IGhhcm5lc3Nfc2x1Zzogc3RyaW5nIH0+KCk7XG4gICAgbGV0IGtpbGxlZCA9IDA7XG4gICAgZm9yIChjb25zdCByIG9mIHN0YWxlLnJlc3VsdHMgPz8gW10pIHtcbiAgICAgIGF3YWl0IHNldERlcGxveW1lbnRTdGF0dXMoYy5lbnYuREIsIHIuaWQsICdmYWlsZWQnLCB7XG4gICAgICAgIGZhaWx1cmVfcmVhc29uOiAnYWJhbmRvbmVkIChnYyknLFxuICAgICAgfSk7XG4gICAgICBraWxsZWQrKztcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7IGtpbGxlZCB9KTtcbiAgfSk7XG5cbiAgLy8gUjIgYXJjaGl2ZSBleHBpcnkg4oCUIGZyZWUgMzBkLCBwYWlkIDF5LiBEZWxldGVzIHByZWZpeGVzIHBhc3QgVFRMLlxuICBhcHAucG9zdCgnL2FkbWluL2djL2V4cGlyZWQtYXJjaGl2ZXMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgZnJlZUN1dG9mZiA9IG5vdyAtIDMwICogMjQgKiA2MCAqIDYwICogMTAwMDtcbiAgICBjb25zdCBwYWlkQ3V0b2ZmID0gbm93IC0gMzY1ICogMjQgKiA2MCAqIDYwICogMTAwMDtcbiAgICBjb25zdCBleHBpcmVkID0gYXdhaXQgYy5lbnYuREJcbiAgICAgIC5wcmVwYXJlKFxuICAgICAgICBgU0VMRUNUIGQuaWQsIGQudGVuYW50X2lkLCB0LnRpZXJcbiAgICAgICAgIEZST00gZGVwbG95bWVudHMgZCBKT0lOIHRlbmFudHMgdCBPTiBkLnRlbmFudF9pZCA9IHQuaWRcbiAgICAgICAgIFdIRVJFIGQuYXJjaGl2ZV9wYXRoIElTIE5PVCBOVUxMXG4gICAgICAgICAgIEFORCAoKHQudGllciA9ICdmcmVlJyBBTkQgZC5jcmVhdGVkX2F0IDwgPylcbiAgICAgICAgICAgICBPUiAodC50aWVyID0gJ3BhaWQnIEFORCBkLmNyZWF0ZWRfYXQgPCA/KSlgLFxuICAgICAgKVxuICAgICAgLmJpbmQoZnJlZUN1dG9mZiwgcGFpZEN1dG9mZilcbiAgICAgIC5hbGw8eyBpZDogc3RyaW5nOyB0ZW5hbnRfaWQ6IHN0cmluZzsgdGllcjogc3RyaW5nIH0+KCk7XG4gICAgbGV0IHB1cmdlZCA9IDA7XG4gICAgZm9yIChjb25zdCByIG9mIGV4cGlyZWQucmVzdWx0cyA/PyBbXSkge1xuICAgICAgYXdhaXQgZGVsZXRlUHJlZml4KGMuZW52LCByLnRlbmFudF9pZCwgci5pZCk7XG4gICAgICBhd2FpdCBjLmVudi5EQlxuICAgICAgICAucHJlcGFyZSgnVVBEQVRFIGRlcGxveW1lbnRzIFNFVCBhcmNoaXZlX3BhdGggPSBOVUxMIFdIRVJFIGlkID0gPycpXG4gICAgICAgIC5iaW5kKHIuaWQpXG4gICAgICAgIC5ydW4oKTtcbiAgICAgIHB1cmdlZCsrO1xuICAgIH1cbiAgICByZXR1cm4gYy5qc29uKHsgcHVyZ2VkIH0pO1xuICB9KTtcblxuICAvLyBTdGFsZSBqdGkgcm93c1xuICBhcHAucG9zdCgnL2FkbWluL2djL2p0aScsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgbm93ID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCk7XG4gICAgYXdhaXQgYy5lbnYuREIucHJlcGFyZSgnREVMRVRFIEZST00ganRpX3VzZWQgV0hFUkUgZXhwIDwgPycpLmJpbmQobm93KS5ydW4oKTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHJldHVybiBhcHA7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL2FkbWluLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9wYXBlcmN1c3AtcHVibGlzaC9zcmMvcm91dGVzL2FkbWluLnRzIiwiL3NyYy9yb3V0ZXMvYWRtaW4udHMiLFtdXQ==