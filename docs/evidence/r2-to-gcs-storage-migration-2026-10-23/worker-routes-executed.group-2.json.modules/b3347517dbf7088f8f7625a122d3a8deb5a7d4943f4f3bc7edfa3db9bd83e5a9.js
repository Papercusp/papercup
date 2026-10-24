__vite_ssr_exportName__("publishFileRoute", () => { try { return publishFileRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp-publish-auth/src/index.ts", {"importedNames":["verifyFileToken","fileSha256Hex","b64uDecode"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["getDeployment","getProject","markFileUploaded"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/cf-pages.ts", {"importedNames":["uploadFile"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/r2-archive.ts", {"importedNames":["writeFile"]});





function publishFileRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.put("/publish/file/:depId/:sha256", async (c) => {
    const depId = c.req.param("depId");
    const sha = c.req.param("sha256");
    const token = c.req.query("token") ?? "";
    const ok = await (0,__vite_ssr_import_1__.verifyFileToken)((0,__vite_ssr_import_1__.b64uDecode)(c.env.JWT_SECRET), token, {
      deploymentId: depId,
      sha256: sha
    });
    if (!ok) return c.json({ error: "invalid or expired upload token" }, 401);
    const dep = await (0,__vite_ssr_import_2__.getDeployment)(c.env.DB, depId);
    if (!dep) return c.json({ error: "unknown deployment" }, 404);
    const project = await (0,__vite_ssr_import_2__.getProject)(c.env.DB, dep.tenant_id, dep.harness_slug);
    if (!project) return c.json({ error: "project lookup failed" }, 500);
    const perFileCap = parseInt(c.env.PER_FILE_BYTES_CAP, 10);
    const declared = parseInt(c.req.header("content-length") ?? "0", 10);
    if (declared > perFileCap) {
      return c.json({ error: `file exceeds ${perFileCap} byte cap` }, 413);
    };
    const buf = new Uint8Array(await c.req.raw.arrayBuffer());
    if (buf.byteLength > perFileCap) {
      return c.json({ error: `file exceeds ${perFileCap} byte cap` }, 413);
    };
    const computed = await (0,__vite_ssr_import_1__.fileSha256Hex)(buf);
    if (computed !== sha) {
      return c.json({ error: `sha256 mismatch (got ${computed})` }, 400);
    };
    await Promise.all([
      (0,__vite_ssr_import_3__.uploadFile)(c.env, project.cf_project_name, streamFromBytes(buf), sha, buf.byteLength),
      (0,__vite_ssr_import_4__.writeFile)(c.env, dep.tenant_id, dep.id, sha, buf)
    ]);
    await (0,__vite_ssr_import_2__.markFileUploaded)(c.env.DB, depId, sha);
    return c.json({ ok: true });
  });
  return app;
};
function streamFromBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTtBQVFBO0FBQ0E7QUFNQTtBQUNBO0FBQ0E7Ozs7OztBQUVPLFNBQVMsbUJBQTRDO0FBQzFELFFBQU0sTUFBTSxJQUFJLDJCQUF3QjtBQUV4QyxNQUFJLElBQUksZ0NBQWdDLE9BQU8sTUFBTTtBQUNuRCxVQUFNLFFBQVEsRUFBRSxJQUFJLE1BQU0sT0FBTztBQUNqQyxVQUFNLE1BQU0sRUFBRSxJQUFJLE1BQU0sUUFBUTtBQUNoQyxVQUFNLFFBQVEsRUFBRSxJQUFJLE1BQU0sT0FBTyxLQUFLO0FBRXRDLFVBQU0sS0FBSyxTQUFNLDBDQUFnQixrQ0FBVyxFQUFFLElBQUksVUFBVSxHQUFHLE9BQU87QUFBQSxNQUNwRSxjQUFjO0FBQUEsTUFDZCxRQUFRO0FBQUEsSUFDVixDQUFDO0FBQ0QsUUFBSSxDQUFDLEdBQUksUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGtDQUFrQyxHQUFHLEdBQUc7QUFFeEUsVUFBTSxNQUFNLFNBQU0scUNBQWMsRUFBRSxJQUFJLElBQUksS0FBSztBQUMvQyxRQUFJLENBQUMsSUFBSyxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8scUJBQXFCLEdBQUcsR0FBRztBQUM1RCxVQUFNLFVBQVUsU0FBTSxrQ0FBVyxFQUFFLElBQUksSUFBSSxJQUFJLFdBQVcsSUFBSSxZQUFZO0FBQzFFLFFBQUksQ0FBQyxRQUFTLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyx3QkFBd0IsR0FBRyxHQUFHO0FBRW5FLFVBQU0sYUFBYSxTQUFTLEVBQUUsSUFBSSxvQkFBb0IsRUFBRTtBQUN4RCxVQUFNLFdBQVcsU0FBUyxFQUFFLElBQUksT0FBTyxnQkFBZ0IsS0FBSyxLQUFLLEVBQUU7QUFDbkUsUUFBSSxXQUFXLFlBQVk7QUFDekIsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGdCQUFnQixVQUFVLFlBQVksR0FBRyxHQUFHO0FBQUEsSUFDckU7QUFFQSxVQUFNLE1BQU0sSUFBSSxXQUFXLE1BQU0sRUFBRSxJQUFJLElBQUksWUFBWSxDQUFDO0FBQ3hELFFBQUksSUFBSSxhQUFhLFlBQVk7QUFDL0IsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGdCQUFnQixVQUFVLFlBQVksR0FBRyxHQUFHO0FBQUEsSUFDckU7QUFFQSxVQUFNLFdBQVcsU0FBTSxxQ0FBYyxHQUFHO0FBQ3hDLFFBQUksYUFBYSxLQUFLO0FBQ3BCLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyx3QkFBd0IsUUFBUSxJQUFJLEdBQUcsR0FBRztBQUFBLElBQ25FO0FBRUEsVUFBTSxRQUFRLElBQUk7QUFBQSxTQUNoQixrQ0FBVyxFQUFFLEtBQUssUUFBUSxpQkFBaUIsZ0JBQWdCLEdBQUcsR0FBRyxLQUFLLElBQUksVUFBVTtBQUFBLFNBQ3BGLGlDQUFVLEVBQUUsS0FBSyxJQUFJLFdBQVcsSUFBSSxJQUFJLEtBQUssR0FBRztBQUFBLElBQ2xELENBQUM7QUFDRCxhQUFNLHdDQUFpQixFQUFFLElBQUksSUFBSSxPQUFPLEdBQUc7QUFDM0MsV0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLEVBQzVCLENBQUM7QUFFRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGdCQUFnQixPQUErQztBQUN0RSxTQUFPLElBQUksZUFBZTtBQUFBLElBQ3hCLE1BQU0sWUFBWTtBQUNoQixpQkFBVyxRQUFRLEtBQUs7QUFDeEIsaUJBQVcsTUFBTTtBQUFBLElBQ25CO0FBQUEsRUFDRixDQUFDO0FBQ0giLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInB1Ymxpc2gtZmlsZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBVVCAvcHVibGlzaC9maWxlLzpkZXBJZC86c2hhMjU2P3Rva2VuPTwuLi4+XG4gKlxuICogQnVmZmVycyB0aGUgZmlsZSBib2R5ICjiiaQyNU1CIHBlciDCpzE1LjUgY2FwLCB3ZWxsIHVuZGVyIFdvcmtlciAxMjhNQlxuICogbWVtb3J5IGxpbWl0KSwgdmVyaWZpZXMgc2hhMjU2LCB0aGVuIGZhbnMgb3V0IHRvIENGIFBhZ2VzICsgUjIgYXJjaGl2ZVxuICogaW4gcGFyYWxsZWwuXG4gKi9cblxuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHtcbiAgdmVyaWZ5RmlsZVRva2VuLFxuICBmaWxlU2hhMjU2SGV4LFxuICBiNjR1RGVjb2RlLFxufSBmcm9tICdAcGFwZXJjdXNwL3B1Ymxpc2gtYXV0aCc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQgeyBnZXREZXBsb3ltZW50LCBnZXRQcm9qZWN0LCBtYXJrRmlsZVVwbG9hZGVkIH0gZnJvbSAnLi4vZGIudHMnO1xuaW1wb3J0IHsgdXBsb2FkRmlsZSB9IGZyb20gJy4uL2NmLXBhZ2VzLnRzJztcbmltcG9ydCB7IHdyaXRlRmlsZSB9IGZyb20gJy4uL3IyLWFyY2hpdmUudHMnO1xuXG5leHBvcnQgZnVuY3Rpb24gcHVibGlzaEZpbGVSb3V0ZSgpOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBIb25vPHsgQmluZGluZ3M6IEVudiB9PigpO1xuXG4gIGFwcC5wdXQoJy9wdWJsaXNoL2ZpbGUvOmRlcElkLzpzaGEyNTYnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGRlcElkID0gYy5yZXEucGFyYW0oJ2RlcElkJykhO1xuICAgIGNvbnN0IHNoYSA9IGMucmVxLnBhcmFtKCdzaGEyNTYnKSE7XG4gICAgY29uc3QgdG9rZW4gPSBjLnJlcS5xdWVyeSgndG9rZW4nKSA/PyAnJztcblxuICAgIGNvbnN0IG9rID0gYXdhaXQgdmVyaWZ5RmlsZVRva2VuKGI2NHVEZWNvZGUoYy5lbnYuSldUX1NFQ1JFVCksIHRva2VuLCB7XG4gICAgICBkZXBsb3ltZW50SWQ6IGRlcElkLFxuICAgICAgc2hhMjU2OiBzaGEsXG4gICAgfSk7XG4gICAgaWYgKCFvaykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZCBvciBleHBpcmVkIHVwbG9hZCB0b2tlbicgfSwgNDAxKTtcblxuICAgIGNvbnN0IGRlcCA9IGF3YWl0IGdldERlcGxveW1lbnQoYy5lbnYuREIsIGRlcElkKTtcbiAgICBpZiAoIWRlcCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5rbm93biBkZXBsb3ltZW50JyB9LCA0MDQpO1xuICAgIGNvbnN0IHByb2plY3QgPSBhd2FpdCBnZXRQcm9qZWN0KGMuZW52LkRCLCBkZXAudGVuYW50X2lkLCBkZXAuaGFybmVzc19zbHVnKTtcbiAgICBpZiAoIXByb2plY3QpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Byb2plY3QgbG9va3VwIGZhaWxlZCcgfSwgNTAwKTtcblxuICAgIGNvbnN0IHBlckZpbGVDYXAgPSBwYXJzZUludChjLmVudi5QRVJfRklMRV9CWVRFU19DQVAsIDEwKTtcbiAgICBjb25zdCBkZWNsYXJlZCA9IHBhcnNlSW50KGMucmVxLmhlYWRlcignY29udGVudC1sZW5ndGgnKSA/PyAnMCcsIDEwKTtcbiAgICBpZiAoZGVjbGFyZWQgPiBwZXJGaWxlQ2FwKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IGBmaWxlIGV4Y2VlZHMgJHtwZXJGaWxlQ2FwfSBieXRlIGNhcGAgfSwgNDEzKTtcbiAgICB9XG5cbiAgICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShhd2FpdCBjLnJlcS5yYXcuYXJyYXlCdWZmZXIoKSk7XG4gICAgaWYgKGJ1Zi5ieXRlTGVuZ3RoID4gcGVyRmlsZUNhcCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBgZmlsZSBleGNlZWRzICR7cGVyRmlsZUNhcH0gYnl0ZSBjYXBgIH0sIDQxMyk7XG4gICAgfVxuXG4gICAgY29uc3QgY29tcHV0ZWQgPSBhd2FpdCBmaWxlU2hhMjU2SGV4KGJ1Zik7XG4gICAgaWYgKGNvbXB1dGVkICE9PSBzaGEpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogYHNoYTI1NiBtaXNtYXRjaCAoZ290ICR7Y29tcHV0ZWR9KWAgfSwgNDAwKTtcbiAgICB9XG5cbiAgICBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICB1cGxvYWRGaWxlKGMuZW52LCBwcm9qZWN0LmNmX3Byb2plY3RfbmFtZSwgc3RyZWFtRnJvbUJ5dGVzKGJ1ZiksIHNoYSwgYnVmLmJ5dGVMZW5ndGgpLFxuICAgICAgd3JpdGVGaWxlKGMuZW52LCBkZXAudGVuYW50X2lkLCBkZXAuaWQsIHNoYSwgYnVmKSxcbiAgICBdKTtcbiAgICBhd2FpdCBtYXJrRmlsZVVwbG9hZGVkKGMuZW52LkRCLCBkZXBJZCwgc2hhKTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHJldHVybiBhcHA7XG59XG5cbmZ1bmN0aW9uIHN0cmVhbUZyb21CeXRlcyhieXRlczogVWludDhBcnJheSk6IFJlYWRhYmxlU3RyZWFtPFVpbnQ4QXJyYXk+IHtcbiAgcmV0dXJuIG5ldyBSZWFkYWJsZVN0cmVhbSh7XG4gICAgc3RhcnQoY29udHJvbGxlcikge1xuICAgICAgY29udHJvbGxlci5lbnF1ZXVlKGJ5dGVzKTtcbiAgICAgIGNvbnRyb2xsZXIuY2xvc2UoKTtcbiAgICB9LFxuICB9KTtcbn1cbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvcHVibGlzaC1maWxlLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9wYXBlcmN1c3AtcHVibGlzaC9zcmMvcm91dGVzL3B1Ymxpc2gtZmlsZS50cyIsIi9zcmMvcm91dGVzL3B1Ymxpc2gtZmlsZS50cyIsW11d