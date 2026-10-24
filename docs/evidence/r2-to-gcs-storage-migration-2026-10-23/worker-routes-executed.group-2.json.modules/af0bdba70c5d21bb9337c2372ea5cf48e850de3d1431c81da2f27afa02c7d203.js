__vite_ssr_exportName__("publishFinalizeRoute", () => { try { return publishFinalizeRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["audit","clientIp","getDeployment","getProject","listDeploymentFiles","setDeploymentStatus"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/jwt-middleware.ts", {"importedNames":["jwtMiddleware"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/cf-pages.ts", {"importedNames":["createDeployment"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/r2-archive.ts", {"importedNames":["archivePath","writeManifest"]});





function publishFinalizeRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.post(
    "/publish/finalize",
    (0,__vite_ssr_import_2__.jwtMiddleware)({ audience: "publish" }),
    async (c) => {
      const tenantId = c.get("tenantId");
      const env = c.env;
      const body = await c.req.json().catch(() => ({}));
      if (!body.deploymentId) return c.json({ error: "deploymentId required" }, 400);
      const dep = await (0,__vite_ssr_import_1__.getDeployment)(env.DB, body.deploymentId);
      if (!dep) return c.json({ error: "unknown deployment" }, 404);
      if (dep.tenant_id !== tenantId) return c.json({ error: "forbidden" }, 403);
      const project = await (0,__vite_ssr_import_1__.getProject)(env.DB, tenantId, dep.harness_slug);
      if (!project) return c.json({ error: "project lookup failed" }, 500);
      const files = await (0,__vite_ssr_import_1__.listDeploymentFiles)(env.DB, dep.id);
      const incomplete = files.filter((f) => f.uploaded !== 1);
      if (incomplete.length > 0) {
        return c.json(
          { error: "uploads incomplete", missingCount: incomplete.length },
          409
        );
      };
      const cfManifest = {};
      for (const f of files) {
        cfManifest[f.path] = { hash: f.sha256, size: f.bytes };
      };
      let cfDeployment;
      try {
        cfDeployment = await (0,__vite_ssr_import_3__.createDeployment)(env, project.cf_project_name, cfManifest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await (0,__vite_ssr_import_1__.setDeploymentStatus)(env.DB, dep.id, "failed", { failure_reason: msg });
        await (0,__vite_ssr_import_1__.audit)(env.DB, Date.now(), "cf_error", {
          tenantId,
          harnessSlug: dep.harness_slug,
          deploymentId: dep.id,
          ip: (0,__vite_ssr_import_1__.clientIp)(c.req.raw)
        });
        return c.json({ error: "cloudflare deployment failed", detail: msg }, 502);
      };
      const archiveKey = (0,__vite_ssr_import_4__.archivePath)(env, tenantId, dep.id);
      await (0,__vite_ssr_import_1__.setDeploymentStatus)(env.DB, dep.id, "building", {
        cf_deployment_id: cfDeployment.id,
        archive_path: archiveKey
      });
      c.executionCtx.waitUntil(
        (0,__vite_ssr_import_4__.writeManifest)(
          env,
          tenantId,
          dep.id,
          JSON.stringify({
            schemaVersion: 1,
            kind: "publish",
            id: dep.id,
            tenant_id: tenantId,
            harness_slug: dep.harness_slug,
            manifest_sha: dep.manifest_sha,
            files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
            created_at: dep.created_at,
            cf_project_name: project.cf_project_name,
            cf_deployment_id: cfDeployment.id
          })
        )
      );
      await (0,__vite_ssr_import_1__.audit)(env.DB, Date.now(), "finalized", {
        tenantId,
        harnessSlug: dep.harness_slug,
        deploymentId: dep.id,
        ip: (0,__vite_ssr_import_1__.clientIp)(c.req.raw),
        bytesTotal: dep.bytes_total
      });
      return c.json({
        vanityUrl: dep.vanity_url,
        status: "building"
      });
    }
  );
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QVEsT0FBTyxFQUFFLE1BQU0sRUFBRTtBQUFBLFlBQzVFLFlBQVksSUFBSTtBQUFBLFlBQ2hCLGlCQUFpQixRQUFRO0FBQUEsWUFDekIsa0JBQWtCLGFBQWE7QUFBQSxVQUNqQyxDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFFQSxlQUFNLDZCQUFNLElBQUksSUFBSSxLQUFLLElBQUksR0FBRyxhQUFhO0FBQUEsUUFDM0M7QUFBQSxRQUNBLGFBQWEsSUFBSTtBQUFBLFFBQ2pCLGNBQWMsSUFBSTtBQUFBLFFBQ2xCLE9BQUksZ0NBQVMsRUFBRSxJQUFJLEdBQUc7QUFBQSxRQUN0QixZQUFZLElBQUk7QUFBQSxNQUNsQixDQUFDO0FBRUQsYUFBTyxFQUFFLEtBQUs7QUFBQSxRQUNaLFdBQVcsSUFBSTtBQUFBLFFBQ2YsUUFBUTtBQUFBLE1BQ1YsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUNUIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJwdWJsaXNoLWZpbmFsaXplLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUE9TVCAvcHVibGlzaC9maW5hbGl6ZSB7IGRlcGxveW1lbnRJZCB9IOKAlCBKV1QnZCwgYXVkaWVuY2U9cHVibGlzaC5cbiAqXG4gKiAxLiBBbGwgZGVwbG95bWVudF9maWxlcyByb3dzIG11c3QgYmUgdXBsb2FkZWQ9MS5cbiAqIDIuIEJ1aWxkIENGIGRlcGxveW1lbnQgbWFuaWZlc3QgeyBwYXRoOiB7IGhhc2gsIHNpemUgfSB9IGZyb20gcm93cy5cbiAqIDMuIENhbGwgQ0YgUGFnZXMgL2RlcGxveW1lbnRzIOKGkiBnZXQgY2ZfZGVwbG95bWVudF9pZC5cbiAqIDQuIFVwZGF0ZSBkZXBsb3ltZW50cy5zdGF0dXM9J2J1aWxkaW5nJywgY2ZfZGVwbG95bWVudF9pZD0uLi5cbiAqIDUuIEFzeW5jOiB3cml0ZSBtYW5pZmVzdC5qc29uIHRvIFIyIGFyY2hpdmUuXG4gKi9cblxuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuLi9lbnYudHMnO1xuaW1wb3J0IHtcbiAgYXVkaXQsXG4gIGNsaWVudElwLFxuICBnZXREZXBsb3ltZW50LFxuICBnZXRQcm9qZWN0LFxuICBsaXN0RGVwbG95bWVudEZpbGVzLFxuICBzZXREZXBsb3ltZW50U3RhdHVzLFxufSBmcm9tICcuLi9kYi50cyc7XG5pbXBvcnQgeyBqd3RNaWRkbGV3YXJlLCB0eXBlIEp3dEN0eFZhcnMgfSBmcm9tICcuLi9qd3QtbWlkZGxld2FyZS50cyc7XG5pbXBvcnQgeyBjcmVhdGVEZXBsb3ltZW50IH0gZnJvbSAnLi4vY2YtcGFnZXMudHMnO1xuaW1wb3J0IHsgYXJjaGl2ZVBhdGgsIHdyaXRlTWFuaWZlc3QgfSBmcm9tICcuLi9yMi1hcmNoaXZlLnRzJztcblxuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hGaW5hbGl6ZVJvdXRlKCk6IEhvbm88eyBCaW5kaW5nczogRW52OyBWYXJpYWJsZXM6IEp3dEN0eFZhcnMgfT4ge1xuICBjb25zdCBhcHAgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnY7IFZhcmlhYmxlczogSnd0Q3R4VmFycyB9PigpO1xuXG4gIGFwcC5wb3N0KFxuICAgICcvcHVibGlzaC9maW5hbGl6ZScsXG4gICAgand0TWlkZGxld2FyZSh7IGF1ZGllbmNlOiAncHVibGlzaCcgfSksXG4gICAgYXN5bmMgKGMpID0+IHtcbiAgICAgIGNvbnN0IHRlbmFudElkID0gYy5nZXQoJ3RlbmFudElkJyk7XG4gICAgICBjb25zdCBlbnYgPSBjLmVudjtcbiAgICAgIGNvbnN0IGJvZHkgPSAoYXdhaXQgYy5yZXEuanNvbigpLmNhdGNoKCgpID0+ICh7fSkpKSBhcyB7IGRlcGxveW1lbnRJZD86IHN0cmluZyB9O1xuICAgICAgaWYgKCFib2R5LmRlcGxveW1lbnRJZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZGVwbG95bWVudElkIHJlcXVpcmVkJyB9LCA0MDApO1xuXG4gICAgICBjb25zdCBkZXAgPSBhd2FpdCBnZXREZXBsb3ltZW50KGVudi5EQiwgYm9keS5kZXBsb3ltZW50SWQpO1xuICAgICAgaWYgKCFkZXApIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Vua25vd24gZGVwbG95bWVudCcgfSwgNDA0KTtcbiAgICAgIGlmIChkZXAudGVuYW50X2lkICE9PSB0ZW5hbnRJZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZm9yYmlkZGVuJyB9LCA0MDMpO1xuXG4gICAgICBjb25zdCBwcm9qZWN0ID0gYXdhaXQgZ2V0UHJvamVjdChlbnYuREIsIHRlbmFudElkLCBkZXAuaGFybmVzc19zbHVnKTtcbiAgICAgIGlmICghcHJvamVjdCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAncHJvamVjdCBsb29rdXAgZmFpbGVkJyB9LCA1MDApO1xuXG4gICAgICBjb25zdCBmaWxlcyA9IGF3YWl0IGxpc3REZXBsb3ltZW50RmlsZXMoZW52LkRCLCBkZXAuaWQpO1xuICAgICAgY29uc3QgaW5jb21wbGV0ZSA9IGZpbGVzLmZpbHRlcigoZikgPT4gZi51cGxvYWRlZCAhPT0gMSk7XG4gICAgICBpZiAoaW5jb21wbGV0ZS5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oXG4gICAgICAgICAgeyBlcnJvcjogJ3VwbG9hZHMgaW5jb21wbGV0ZScsIG1pc3NpbmdDb3VudDogaW5jb21wbGV0ZS5sZW5ndGggfSxcbiAgICAgICAgICA0MDksXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNmTWFuaWZlc3Q6IFJlY29yZDxzdHJpbmcsIHsgaGFzaDogc3RyaW5nOyBzaXplOiBudW1iZXIgfT4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgICAgICBjZk1hbmlmZXN0W2YucGF0aF0gPSB7IGhhc2g6IGYuc2hhMjU2LCBzaXplOiBmLmJ5dGVzIH07XG4gICAgICB9XG5cbiAgICAgIGxldCBjZkRlcGxveW1lbnQ7XG4gICAgICB0cnkge1xuICAgICAgICBjZkRlcGxveW1lbnQgPSBhd2FpdCBjcmVhdGVEZXBsb3ltZW50KGVudiwgcHJvamVjdC5jZl9wcm9qZWN0X25hbWUsIGNmTWFuaWZlc3QpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zdCBtc2cgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgICAgIGF3YWl0IHNldERlcGxveW1lbnRTdGF0dXMoZW52LkRCLCBkZXAuaWQsICdmYWlsZWQnLCB7IGZhaWx1cmVfcmVhc29uOiBtc2cgfSk7XG4gICAgICAgIGF3YWl0IGF1ZGl0KGVudi5EQiwgRGF0ZS5ub3coKSwgJ2NmX2Vycm9yJywge1xuICAgICAgICAgIHRlbmFudElkLFxuICAgICAgICAgIGhhcm5lc3NTbHVnOiBkZXAuaGFybmVzc19zbHVnLFxuICAgICAgICAgIGRlcGxveW1lbnRJZDogZGVwLmlkLFxuICAgICAgICAgIGlwOiBjbGllbnRJcChjLnJlcS5yYXcpLFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnY2xvdWRmbGFyZSBkZXBsb3ltZW50IGZhaWxlZCcsIGRldGFpbDogbXNnIH0sIDUwMik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGFyY2hpdmVLZXkgPSBhcmNoaXZlUGF0aChlbnYsIHRlbmFudElkLCBkZXAuaWQpO1xuICAgICAgYXdhaXQgc2V0RGVwbG95bWVudFN0YXR1cyhlbnYuREIsIGRlcC5pZCwgJ2J1aWxkaW5nJywge1xuICAgICAgICBjZl9kZXBsb3ltZW50X2lkOiBjZkRlcGxveW1lbnQuaWQsXG4gICAgICAgIGFyY2hpdmVfcGF0aDogYXJjaGl2ZUtleSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBGaXJlLWFuZC1mb3JnZXQgYXJjaGl2ZSB3cml0ZSAod2FpdFVudGlsIGtlZXBzIGl0IGFsaXZlIHBhc3QgcmVzcG9uc2UpLlxuICAgICAgYy5leGVjdXRpb25DdHgud2FpdFVudGlsKFxuICAgICAgICB3cml0ZU1hbmlmZXN0KFxuICAgICAgICAgIGVudixcbiAgICAgICAgICB0ZW5hbnRJZCxcbiAgICAgICAgICBkZXAuaWQsXG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICAgICAgICAgIGtpbmQ6ICdwdWJsaXNoJyxcbiAgICAgICAgICAgIGlkOiBkZXAuaWQsXG4gICAgICAgICAgICB0ZW5hbnRfaWQ6IHRlbmFudElkLFxuICAgICAgICAgICAgaGFybmVzc19zbHVnOiBkZXAuaGFybmVzc19zbHVnLFxuICAgICAgICAgICAgbWFuaWZlc3Rfc2hhOiBkZXAubWFuaWZlc3Rfc2hhLFxuICAgICAgICAgICAgZmlsZXM6IGZpbGVzLm1hcCgoZikgPT4gKHsgcGF0aDogZi5wYXRoLCBzaGEyNTY6IGYuc2hhMjU2LCBieXRlczogZi5ieXRlcyB9KSksXG4gICAgICAgICAgICBjcmVhdGVkX2F0OiBkZXAuY3JlYXRlZF9hdCxcbiAgICAgICAgICAgIGNmX3Byb2plY3RfbmFtZTogcHJvamVjdC5jZl9wcm9qZWN0X25hbWUsXG4gICAgICAgICAgICBjZl9kZXBsb3ltZW50X2lkOiBjZkRlcGxveW1lbnQuaWQsXG4gICAgICAgICAgfSksXG4gICAgICAgICksXG4gICAgICApO1xuXG4gICAgICBhd2FpdCBhdWRpdChlbnYuREIsIERhdGUubm93KCksICdmaW5hbGl6ZWQnLCB7XG4gICAgICAgIHRlbmFudElkLFxuICAgICAgICBoYXJuZXNzU2x1ZzogZGVwLmhhcm5lc3Nfc2x1ZyxcbiAgICAgICAgZGVwbG95bWVudElkOiBkZXAuaWQsXG4gICAgICAgIGlwOiBjbGllbnRJcChjLnJlcS5yYXcpLFxuICAgICAgICBieXRlc1RvdGFsOiBkZXAuYnl0ZXNfdG90YWwsXG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIGMuanNvbih7XG4gICAgICAgIHZhbml0eVVybDogZGVwLnZhbml0eV91cmwsXG4gICAgICAgIHN0YXR1czogJ2J1aWxkaW5nJyxcbiAgICAgIH0pO1xuICAgIH0sXG4gICk7XG5cbiAgcmV0dXJuIGFwcDtcbn1cbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvcHVibGlzaC1maW5hbGl6ZS50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9wYXBlcmN1c3AtcHVibGlzaC9zcmMvcm91dGVzL3B1Ymxpc2gtZmluYWxpemUudHMiLCIvc3JjL3JvdXRlcy9wdWJsaXNoLWZpbmFsaXplLnRzIixbXV0=