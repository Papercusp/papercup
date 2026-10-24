const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["afterEach","beforeEach","describe","expect","it","vi"]});
const h = __vite_ssr_import_0__.vi.hoisted(() => ({
  setDeploymentStatus: __vite_ssr_import_0__.vi.fn(async () => {
  }),
  deletePrefix: __vite_ssr_import_0__.vi.fn(async () => {
  })
}));
__vite_ssr_import_0__.vi.mock("../db.ts", () => ({ setDeploymentStatus: h.setDeploymentStatus }));
__vite_ssr_import_0__.vi.mock("../r2-archive.ts", () => ({ deletePrefix: h.deletePrefix }));
__vite_ssr_import_0__.vi.mock("../cf-pages.ts", () => ({ deleteDeployment: __vite_ssr_import_0__.vi.fn(), getProject: __vite_ssr_import_0__.vi.fn() }));
const __vi_import_0__ = await __vite_ssr_dynamic_import__("/src/routes/admin.ts");


class FakeDb {
  selectRows = [];
  runs = [];
  lastAllBinds = [];
  prepare(sql) {
    const self = this;
    let binds = [];
    const stmt = {
      bind(...v) {
        binds = v;
        return stmt;
      },
      async all() {
        self.lastAllBinds = binds;
        return { results: self.selectRows, success: true };
      },
      async run() {
        self.runs.push({ sql, binds });
        return { success: true, meta: { changes: 1 } };
      }
    };
    return stmt;
  }
}
function makeEnv(db) {
  return { DB: db };
}
const post = (db, path) => __vi_import_0__.adminRoute().request(path, { method: "POST" }, makeEnv(db));
(0,__vite_ssr_import_0__.beforeEach)(() => __vite_ssr_import_0__.vi.clearAllMocks());
(0,__vite_ssr_import_0__.afterEach)(() => __vite_ssr_import_0__.vi.clearAllMocks());
(0,__vite_ssr_import_0__.describe)("POST /admin/gc/abandoned-uploads", () => {
  (0,__vite_ssr_import_0__.it)("flips each stale uploading deployment to failed and reports the count", async () => {
    const db = new FakeDb();
    db.selectRows = [
      { id: "d1", tenant_id: "t1", harness_slug: "a" },
      { id: "d2", tenant_id: "t2", harness_slug: "b" }
    ];
    const res = await post(db, "/admin/gc/abandoned-uploads");
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toEqual({ killed: 2 });
    (0,__vite_ssr_import_0__.expect)(h.setDeploymentStatus).toHaveBeenCalledTimes(2);
    (0,__vite_ssr_import_0__.expect)(h.setDeploymentStatus).toHaveBeenCalledWith(
      __vite_ssr_import_0__.expect.anything(),
      "d1",
      "failed",
      __vite_ssr_import_0__.expect.objectContaining({ failure_reason: "abandoned (gc)" })
    );
    (0,__vite_ssr_import_0__.expect)(db.lastAllBinds[0]).toBeLessThan(Date.now());
  });
  (0,__vite_ssr_import_0__.it)("reports killed:0 and never writes when nothing is stale", async () => {
    const db = new FakeDb();
    db.selectRows = [];
    const res = await post(db, "/admin/gc/abandoned-uploads");
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toEqual({ killed: 0 });
    (0,__vite_ssr_import_0__.expect)(h.setDeploymentStatus).not.toHaveBeenCalled();
  });
});
(0,__vite_ssr_import_0__.describe)("POST /admin/gc/expired-archives", () => {
  (0,__vite_ssr_import_0__.it)("deletes the R2 prefix + nulls archive_path for each expired deployment", async () => {
    const db = new FakeDb();
    db.selectRows = [
      { id: "d1", tenant_id: "t1", tier: "free" },
      { id: "d2", tenant_id: "t2", tier: "paid" }
    ];
    const res = await post(db, "/admin/gc/expired-archives");
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toEqual({ purged: 2 });
    (0,__vite_ssr_import_0__.expect)(h.deletePrefix).toHaveBeenCalledTimes(2);
    (0,__vite_ssr_import_0__.expect)(h.deletePrefix).toHaveBeenCalledWith(__vite_ssr_import_0__.expect.anything(), "t1", "d1");
    const updates = db.runs.filter((r) => /archive_path\s*=\s*NULL/i.test(r.sql));
    (0,__vite_ssr_import_0__.expect)(updates).toHaveLength(2);
    (0,__vite_ssr_import_0__.expect)(updates[0]?.binds).toEqual(["d1"]);
  });
  (0,__vite_ssr_import_0__.it)("reports purged:0 when no archives are expired", async () => {
    const db = new FakeDb();
    db.selectRows = [];
    const res = await post(db, "/admin/gc/expired-archives");
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toEqual({ purged: 0 });
    (0,__vite_ssr_import_0__.expect)(h.deletePrefix).not.toHaveBeenCalled();
  });
});
(0,__vite_ssr_import_0__.describe)("POST /admin/gc/jti", () => {
  (0,__vite_ssr_import_0__.it)("deletes expired jti rows and returns ok", async () => {
    const db = new FakeDb();
    const res = await post(db, "/admin/gc/jti");
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toEqual({ ok: true });
    const del = db.runs.find((r) => /DELETE FROM jti_used/i.test(r.sql));
    (0,__vite_ssr_import_0__.expect)(del).toBeTruthy();
    const cutoff = del.binds[0];
    (0,__vite_ssr_import_0__.expect)(cutoff).toBeLessThanOrEqual(Math.ceil(Date.now() / 1e3));
    (0,__vite_ssr_import_0__.expect)(cutoff).toBeGreaterThan(1e9);
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBWUE7QUFFQSxNQUFNLElBQUkseUJBQUcsUUFBUSxPQUFPO0FBQUEsRUFDMUIscUJBQXFCLHlCQUFHLEdBQUcsWUFBWTtBQUFBLEVBQUMsQ0FBQztBQUFBLEVBQ3pDLGNBQWMseUJBQUcsR0FBRyxZQUFZO0FBQUEsRUFBQyxDQUFDO0FBQ3BDLEVBQUU7QUFFRix5QkFBRyxLQUFLLFlBQVksT0FBTyxFQUFFLHFCQUFxQixFQUFFLG9CQUFvQixFQUFFO0FBQzFFLHlCQUFHLEtBQUssb0JBQW9CLE9BQU8sRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFO0FBRXBFLHlCQUFHLEtBQUssa0JBQWtCLE9BQU8sRUFBRSxrQkFBa0IseUJBQUcsR0FBRyxHQUFHLFlBQVkseUJBQUcsR0FBRyxFQUFFLEVBQUU7QUFFcEY7OztBQUtBLE1BQU0sT0FBTztBQUFBLEVBQ1gsYUFBb0IsQ0FBQztBQUFBLEVBQ3JCLE9BQWlELENBQUM7QUFBQSxFQUNsRCxlQUEwQixDQUFDO0FBQUEsRUFFM0IsUUFBUSxLQUFhO0FBQ25CLFVBQU0sT0FBTztBQUNiLFFBQUksUUFBbUIsQ0FBQztBQUN4QixVQUFNLE9BQU87QUFBQSxNQUNYLFFBQVEsR0FBYztBQUNwQixnQkFBUTtBQUNSLGVBQU87QUFBQSxNQUNUO0FBQUEsTUFDQSxNQUFNLE1BQWU7QUFDbkIsYUFBSyxlQUFlO0FBQ3BCLGVBQU8sRUFBRSxTQUFTLEtBQUssWUFBOEIsU0FBUyxLQUFjO0FBQUEsTUFDOUU7QUFBQSxNQUNBLE1BQU0sTUFBTTtBQUNWLGFBQUssS0FBSyxLQUFLLEVBQUUsS0FBSyxNQUFNLENBQUM7QUFDN0IsZUFBTyxFQUFFLFNBQVMsTUFBZSxNQUFNLEVBQUUsU0FBUyxFQUFFLEVBQUU7QUFBQSxNQUN4RDtBQUFBLElBQ0Y7QUFDQSxXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsU0FBUyxRQUFRLElBQVk7QUFFM0IsU0FBTyxFQUFFLElBQUksR0FBRztBQUNsQjtBQUVBLE1BQU0sT0FBTyxDQUFDLElBQVksU0FDeEIsMkJBQVcsRUFBRSxRQUFRLE1BQU0sRUFBRSxRQUFRLE9BQU8sR0FBRyxRQUFRLEVBQUUsQ0FBQztHQUU1RCxrQ0FBVyxNQUFNLHlCQUFHLGNBQWMsQ0FBQztHQUNuQyxpQ0FBVSxNQUFNLHlCQUFHLGNBQWMsQ0FBQztHQUVsQyxnQ0FBUyxvQ0FBb0MsTUFBTTtBQUNqRCwrQkFBRyx5RUFBeUUsWUFBWTtBQUN0RixVQUFNLEtBQUssSUFBSSxPQUFPO0FBQ3RCLE9BQUcsYUFBYTtBQUFBLE1BQ2QsRUFBRSxJQUFJLE1BQU0sV0FBVyxNQUFNLGNBQWMsSUFBSTtBQUFBLE1BQy9DLEVBQUUsSUFBSSxNQUFNLFdBQVcsTUFBTSxjQUFjLElBQUk7QUFBQSxJQUNqRDtBQUNBLFVBQU0sTUFBTSxNQUFNLEtBQUssSUFBSSw2QkFBNkI7QUFDeEQscUNBQU8sSUFBSSxNQUFNLEVBQUUsS0FBSyxHQUFHO0FBQzNCLHFDQUFPLE1BQU0sSUFBSSxLQUFLLENBQUMsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFDOUMscUNBQU8sRUFBRSxtQkFBbUIsRUFBRSxzQkFBc0IsQ0FBQztBQUNyRCxxQ0FBTyxFQUFFLG1CQUFtQixFQUFFO0FBQUEsTUFDNUIsNkJBQU8sU0FBUztBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0EsNkJBQU8saUJBQWlCLEVBQUUsZ0JBQWdCLGlCQUFpQixDQUFDO0FBQUEsSUFDOUQ7QUFFQSxxQ0FBTyxHQUFHLGFBQWEsQ0FBQyxDQUFDLEVBQUUsYUFBYSxLQUFLLElBQUksQ0FBQztBQUFBLEVBQ3BELENBQUM7QUFFRCwrQkFBRywyREFBMkQsWUFBWTtBQUN4RSxVQUFNLEtBQUssSUFBSSxPQUFPO0FBQ3RCLE9BQUcsYUFBYSxDQUFDO0FBQ2pCLFVBQU0sTUFBTSxNQUFNLEtBQUssSUFBSSw2QkFBNkI7QUFDeEQscUNBQU8sSUFBSSxNQUFNLEVBQUUsS0FBSyxHQUFHO0FBQzNCLHFDQUFPLE1BQU0sSUFBSSxLQUFLLENBQUMsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFDOUMscUNBQU8sRUFBRSxtQkFBbUIsRUFBRSxJQUFJLGlCQUFpQjtBQUFBLEVBQ3JELENBQUM7QUFDSCxDQUFDO0dBRUQsZ0NBQVMsbUNBQW1DLE1BQU07QUFDaEQsK0JBQUcsMEVBQTBFLFlBQVk7QUFDdkYsVUFBTSxLQUFLLElBQUksT0FBTztBQUN0QixPQUFHLGFBQWE7QUFBQSxNQUNkLEVBQUUsSUFBSSxNQUFNLFdBQVcsTUFBTSxNQUFNLE9BQU87QUFBQSxNQUMxQyxFQUFFLElBQUksTUFBTSxXQUFXLE1BQU0sTUFBTSxPQUFPO0FBQUEsSUFDNUM7QUFDQSxVQUFNLE1BQU0sTUFBTSxLQUFLLElBQUksNEJBQTRCO0FBQ3ZELHFDQUFPLElBQUksTUFBTSxFQUFFLEtBQUssR0FBRztBQUMzQixxQ0FBTyxNQUFNLElBQUksS0FBSyxDQUFDLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxDQUFDO0FBQzlDLHFDQUFPLEVBQUUsWUFBWSxFQUFFLHNCQUFzQixDQUFDO0FBQzlDLHFDQUFPLEVBQUUsWUFBWSxFQUFFLHFCQUFxQiw2QkFBTyxTQUFTLEdBQUcsTUFBTSxJQUFJO0FBRXpFLFVBQU0sVUFBVSxHQUFHLEtBQUssT0FBTyxDQUFDLE1BQU0sMkJBQTJCLEtBQUssRUFBRSxHQUFHLENBQUM7QUFDNUUscUNBQU8sT0FBTyxFQUFFLGFBQWEsQ0FBQztBQUM5QixxQ0FBTyxRQUFRLENBQUMsR0FBRyxLQUFLLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQztBQUFBLEVBQzFDLENBQUM7QUFFRCwrQkFBRyxpREFBaUQsWUFBWTtBQUM5RCxVQUFNLEtBQUssSUFBSSxPQUFPO0FBQ3RCLE9BQUcsYUFBYSxDQUFDO0FBQ2pCLFVBQU0sTUFBTSxNQUFNLEtBQUssSUFBSSw0QkFBNEI7QUFDdkQscUNBQU8sSUFBSSxNQUFNLEVBQUUsS0FBSyxHQUFHO0FBQzNCLHFDQUFPLE1BQU0sSUFBSSxLQUFLLENBQUMsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFDOUMscUNBQU8sRUFBRSxZQUFZLEVBQUUsSUFBSSxpQkFBaUI7QUFBQSxFQUM5QyxDQUFDO0FBQ0gsQ0FBQztHQUVELGdDQUFTLHNCQUFzQixNQUFNO0FBQ25DLCtCQUFHLDJDQUEyQyxZQUFZO0FBQ3hELFVBQU0sS0FBSyxJQUFJLE9BQU87QUFDdEIsVUFBTSxNQUFNLE1BQU0sS0FBSyxJQUFJLGVBQWU7QUFDMUMscUNBQU8sSUFBSSxNQUFNLEVBQUUsS0FBSyxHQUFHO0FBQzNCLHFDQUFPLE1BQU0sSUFBSSxLQUFLLENBQUMsRUFBRSxRQUFRLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFDN0MsVUFBTSxNQUFNLEdBQUcsS0FBSyxLQUFLLENBQUMsTUFBTSx3QkFBd0IsS0FBSyxFQUFFLEdBQUcsQ0FBQztBQUNuRSxxQ0FBTyxHQUFHLEVBQUUsV0FBVztBQUV2QixVQUFNLFNBQVMsSUFBSyxNQUFNLENBQUM7QUFDM0IscUNBQU8sTUFBTSxFQUFFLG9CQUFvQixLQUFLLEtBQUssS0FBSyxJQUFJLElBQUksR0FBSSxDQUFDO0FBQy9ELHFDQUFPLE1BQU0sRUFBRSxnQkFBZ0IsR0FBYTtBQUFBLEVBQzlDLENBQUM7QUFDSCxDQUFDIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJhZG1pbi50ZXN0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogYWRtaW4udGVzdC50cyDigJQgYWRtaW4gLyBjcm9uIEdDIGVuZHBvaW50cyAocHVibGlzaCBzZXJ2aWNlKS5cbiAqXG4gKiBUaHJlZSBzY2hlZHVsZWQtdHJpZ2dlciBlbmRwb2ludHMsIGVhY2ggZHJpdmVuIGFnYWluc3QgYSBzbWFsbCBmYWtlIEQxIHRoYXRcbiAqIHVuZGVyc3RhbmRzIGV4YWN0bHkgdGhlIFNRTCB0aGUgcm91dGUgZW1pdHM6XG4gKiAgIFBPU1QgL2FkbWluL2djL2FiYW5kb25lZC11cGxvYWRzIOKAlCBmbGlwcyBkZXBsb3ltZW50cyBzdHVjayAndXBsb2FkaW5nJyA+IDFoXG4gKiAgICAgdG8gJ2ZhaWxlZCcgKGZhaWx1cmVfcmVhc29uICdhYmFuZG9uZWQgKGdjKScpLCByZXR1cm5zIHsga2lsbGVkIH0uXG4gKiAgIFBPU1QgL2FkbWluL2djL2V4cGlyZWQtYXJjaGl2ZXMg4oCUIGRlbGV0ZXMgUjIgcHJlZml4ZXMgKyBudWxscyBhcmNoaXZlX3BhdGhcbiAqICAgICBmb3IgZnJlZSAoPjMwZCkgLyBwYWlkICg+MXkpIGRlcGxveW1lbnRzIHBhc3QgVFRMLCByZXR1cm5zIHsgcHVyZ2VkIH0uXG4gKiAgIFBPU1QgL2FkbWluL2djL2p0aSDigJQgREVMRVRFcyBleHBpcmVkIGp0aSByb3dzLCByZXR1cm5zIHsgb2s6IHRydWUgfS5cbiAqIHNldERlcGxveW1lbnRTdGF0dXMgYW5kIGRlbGV0ZVByZWZpeCBhcmUgbW9ja2VkOyB0aGUgcmVzdCBpcyB0aGUgcmVhbCBoYW5kbGVyLlxuICovXG5pbXBvcnQgeyBhZnRlckVhY2gsIGJlZm9yZUVhY2gsIGRlc2NyaWJlLCBleHBlY3QsIGl0LCB2aSB9IGZyb20gJ3ZpdGVzdCc7XG5cbmNvbnN0IGggPSB2aS5ob2lzdGVkKCgpID0+ICh7XG4gIHNldERlcGxveW1lbnRTdGF0dXM6IHZpLmZuKGFzeW5jICgpID0+IHt9KSxcbiAgZGVsZXRlUHJlZml4OiB2aS5mbihhc3luYyAoKSA9PiB7fSksXG59KSk7XG5cbnZpLm1vY2soJy4uL2RiLnRzJywgKCkgPT4gKHsgc2V0RGVwbG95bWVudFN0YXR1czogaC5zZXREZXBsb3ltZW50U3RhdHVzIH0pKTtcbnZpLm1vY2soJy4uL3IyLWFyY2hpdmUudHMnLCAoKSA9PiAoeyBkZWxldGVQcmVmaXg6IGguZGVsZXRlUHJlZml4IH0pKTtcbi8vIGNmLXBhZ2VzIGlzIGltcG9ydGVkIGJ5IGFkbWluLnRzIGJ1dCBpdHMgZXhwb3J0cyBhcmUgdW51c2VkIGJ5IHRoZSBoYW5kbGVycy5cbnZpLm1vY2soJy4uL2NmLXBhZ2VzLnRzJywgKCkgPT4gKHsgZGVsZXRlRGVwbG95bWVudDogdmkuZm4oKSwgZ2V0UHJvamVjdDogdmkuZm4oKSB9KSk7XG5cbmltcG9ydCB7IGFkbWluUm91dGUgfSBmcm9tICcuL2FkbWluLnRzJztcblxudHlwZSBSb3cgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuLy8gRmFrZSBEMSB0aGF0IHJvdXRlcyB0aGUgcm91dGUncyB0aHJlZSBxdWVyaWVzIGJ5IHRoZWlyIGxlYWRpbmcga2V5d29yZC5cbmNsYXNzIEZha2VEYiB7XG4gIHNlbGVjdFJvd3M6IFJvd1tdID0gW107XG4gIHJ1bnM6IEFycmF5PHsgc3FsOiBzdHJpbmc7IGJpbmRzOiB1bmtub3duW10gfT4gPSBbXTtcbiAgbGFzdEFsbEJpbmRzOiB1bmtub3duW10gPSBbXTtcblxuICBwcmVwYXJlKHNxbDogc3RyaW5nKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgbGV0IGJpbmRzOiB1bmtub3duW10gPSBbXTtcbiAgICBjb25zdCBzdG10ID0ge1xuICAgICAgYmluZCguLi52OiB1bmtub3duW10pIHtcbiAgICAgICAgYmluZHMgPSB2O1xuICAgICAgICByZXR1cm4gc3RtdDtcbiAgICAgIH0sXG4gICAgICBhc3luYyBhbGw8VCA9IFJvdz4oKSB7XG4gICAgICAgIHNlbGYubGFzdEFsbEJpbmRzID0gYmluZHM7XG4gICAgICAgIHJldHVybiB7IHJlc3VsdHM6IHNlbGYuc2VsZWN0Um93cyBhcyB1bmtub3duIGFzIFRbXSwgc3VjY2VzczogdHJ1ZSBhcyBjb25zdCB9O1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHJ1bigpIHtcbiAgICAgICAgc2VsZi5ydW5zLnB1c2goeyBzcWwsIGJpbmRzIH0pO1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIGFzIGNvbnN0LCBtZXRhOiB7IGNoYW5nZXM6IDEgfSB9O1xuICAgICAgfSxcbiAgICB9O1xuICAgIHJldHVybiBzdG10O1xuICB9XG59XG5cbmZ1bmN0aW9uIG1ha2VFbnYoZGI6IEZha2VEYikge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICByZXR1cm4geyBEQjogZGIgfSBhcyBhbnk7XG59XG5cbmNvbnN0IHBvc3QgPSAoZGI6IEZha2VEYiwgcGF0aDogc3RyaW5nKSA9PlxuICBhZG1pblJvdXRlKCkucmVxdWVzdChwYXRoLCB7IG1ldGhvZDogJ1BPU1QnIH0sIG1ha2VFbnYoZGIpKTtcblxuYmVmb3JlRWFjaCgoKSA9PiB2aS5jbGVhckFsbE1vY2tzKCkpO1xuYWZ0ZXJFYWNoKCgpID0+IHZpLmNsZWFyQWxsTW9ja3MoKSk7XG5cbmRlc2NyaWJlKCdQT1NUIC9hZG1pbi9nYy9hYmFuZG9uZWQtdXBsb2FkcycsICgpID0+IHtcbiAgaXQoJ2ZsaXBzIGVhY2ggc3RhbGUgdXBsb2FkaW5nIGRlcGxveW1lbnQgdG8gZmFpbGVkIGFuZCByZXBvcnRzIHRoZSBjb3VudCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkYiA9IG5ldyBGYWtlRGIoKTtcbiAgICBkYi5zZWxlY3RSb3dzID0gW1xuICAgICAgeyBpZDogJ2QxJywgdGVuYW50X2lkOiAndDEnLCBoYXJuZXNzX3NsdWc6ICdhJyB9LFxuICAgICAgeyBpZDogJ2QyJywgdGVuYW50X2lkOiAndDInLCBoYXJuZXNzX3NsdWc6ICdiJyB9LFxuICAgIF07XG4gICAgY29uc3QgcmVzID0gYXdhaXQgcG9zdChkYiwgJy9hZG1pbi9nYy9hYmFuZG9uZWQtdXBsb2FkcycpO1xuICAgIGV4cGVjdChyZXMuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlcy5qc29uKCkpLnRvRXF1YWwoeyBraWxsZWQ6IDIgfSk7XG4gICAgZXhwZWN0KGguc2V0RGVwbG95bWVudFN0YXR1cykudG9IYXZlQmVlbkNhbGxlZFRpbWVzKDIpO1xuICAgIGV4cGVjdChoLnNldERlcGxveW1lbnRTdGF0dXMpLnRvSGF2ZUJlZW5DYWxsZWRXaXRoKFxuICAgICAgZXhwZWN0LmFueXRoaW5nKCksXG4gICAgICAnZDEnLFxuICAgICAgJ2ZhaWxlZCcsXG4gICAgICBleHBlY3Qub2JqZWN0Q29udGFpbmluZyh7IGZhaWx1cmVfcmVhc29uOiAnYWJhbmRvbmVkIChnYyknIH0pLFxuICAgICk7XG4gICAgLy8gVGhlIGN1dG9mZiBiaW5kIGlzIH4xaCBhZ28uXG4gICAgZXhwZWN0KGRiLmxhc3RBbGxCaW5kc1swXSkudG9CZUxlc3NUaGFuKERhdGUubm93KCkpO1xuICB9KTtcblxuICBpdCgncmVwb3J0cyBraWxsZWQ6MCBhbmQgbmV2ZXIgd3JpdGVzIHdoZW4gbm90aGluZyBpcyBzdGFsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkYiA9IG5ldyBGYWtlRGIoKTtcbiAgICBkYi5zZWxlY3RSb3dzID0gW107XG4gICAgY29uc3QgcmVzID0gYXdhaXQgcG9zdChkYiwgJy9hZG1pbi9nYy9hYmFuZG9uZWQtdXBsb2FkcycpO1xuICAgIGV4cGVjdChyZXMuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlcy5qc29uKCkpLnRvRXF1YWwoeyBraWxsZWQ6IDAgfSk7XG4gICAgZXhwZWN0KGguc2V0RGVwbG95bWVudFN0YXR1cykubm90LnRvSGF2ZUJlZW5DYWxsZWQoKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1BPU1QgL2FkbWluL2djL2V4cGlyZWQtYXJjaGl2ZXMnLCAoKSA9PiB7XG4gIGl0KCdkZWxldGVzIHRoZSBSMiBwcmVmaXggKyBudWxscyBhcmNoaXZlX3BhdGggZm9yIGVhY2ggZXhwaXJlZCBkZXBsb3ltZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRiID0gbmV3IEZha2VEYigpO1xuICAgIGRiLnNlbGVjdFJvd3MgPSBbXG4gICAgICB7IGlkOiAnZDEnLCB0ZW5hbnRfaWQ6ICd0MScsIHRpZXI6ICdmcmVlJyB9LFxuICAgICAgeyBpZDogJ2QyJywgdGVuYW50X2lkOiAndDInLCB0aWVyOiAncGFpZCcgfSxcbiAgICBdO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHBvc3QoZGIsICcvYWRtaW4vZ2MvZXhwaXJlZC1hcmNoaXZlcycpO1xuICAgIGV4cGVjdChyZXMuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlcy5qc29uKCkpLnRvRXF1YWwoeyBwdXJnZWQ6IDIgfSk7XG4gICAgZXhwZWN0KGguZGVsZXRlUHJlZml4KS50b0hhdmVCZWVuQ2FsbGVkVGltZXMoMik7XG4gICAgZXhwZWN0KGguZGVsZXRlUHJlZml4KS50b0hhdmVCZWVuQ2FsbGVkV2l0aChleHBlY3QuYW55dGhpbmcoKSwgJ3QxJywgJ2QxJyk7XG4gICAgLy8gT25lIFVQREFURSAuLi4gU0VUIGFyY2hpdmVfcGF0aCA9IE5VTEwgcGVyIHB1cmdlZCByb3cuXG4gICAgY29uc3QgdXBkYXRlcyA9IGRiLnJ1bnMuZmlsdGVyKChyKSA9PiAvYXJjaGl2ZV9wYXRoXFxzKj1cXHMqTlVMTC9pLnRlc3Qoci5zcWwpKTtcbiAgICBleHBlY3QodXBkYXRlcykudG9IYXZlTGVuZ3RoKDIpO1xuICAgIGV4cGVjdCh1cGRhdGVzWzBdPy5iaW5kcykudG9FcXVhbChbJ2QxJ10pO1xuICB9KTtcblxuICBpdCgncmVwb3J0cyBwdXJnZWQ6MCB3aGVuIG5vIGFyY2hpdmVzIGFyZSBleHBpcmVkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRiID0gbmV3IEZha2VEYigpO1xuICAgIGRiLnNlbGVjdFJvd3MgPSBbXTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBwb3N0KGRiLCAnL2FkbWluL2djL2V4cGlyZWQtYXJjaGl2ZXMnKTtcbiAgICBleHBlY3QocmVzLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChhd2FpdCByZXMuanNvbigpKS50b0VxdWFsKHsgcHVyZ2VkOiAwIH0pO1xuICAgIGV4cGVjdChoLmRlbGV0ZVByZWZpeCkubm90LnRvSGF2ZUJlZW5DYWxsZWQoKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ1BPU1QgL2FkbWluL2djL2p0aScsICgpID0+IHtcbiAgaXQoJ2RlbGV0ZXMgZXhwaXJlZCBqdGkgcm93cyBhbmQgcmV0dXJucyBvaycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkYiA9IG5ldyBGYWtlRGIoKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBwb3N0KGRiLCAnL2FkbWluL2djL2p0aScpO1xuICAgIGV4cGVjdChyZXMuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgZXhwZWN0KGF3YWl0IHJlcy5qc29uKCkpLnRvRXF1YWwoeyBvazogdHJ1ZSB9KTtcbiAgICBjb25zdCBkZWwgPSBkYi5ydW5zLmZpbmQoKHIpID0+IC9ERUxFVEUgRlJPTSBqdGlfdXNlZC9pLnRlc3Qoci5zcWwpKTtcbiAgICBleHBlY3QoZGVsKS50b0JlVHJ1dGh5KCk7XG4gICAgLy8gQmluZCBpcyBhbiBlcG9jaC1zZWNvbmRzIGN1dG9mZiAofiBub3cvMTAwMCksIG5vdCBtaWxsaXMuXG4gICAgY29uc3QgY3V0b2ZmID0gZGVsIS5iaW5kc1swXSBhcyBudW1iZXI7XG4gICAgZXhwZWN0KGN1dG9mZikudG9CZUxlc3NUaGFuT3JFcXVhbChNYXRoLmNlaWwoRGF0ZS5ub3coKSAvIDEwMDApKTtcbiAgICBleHBlY3QoY3V0b2ZmKS50b0JlR3JlYXRlclRoYW4oMV8wMDBfMDAwXzAwMCk7XG4gIH0pO1xufSk7XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL2FkbWluLnRlc3QudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9wYXBlcmN1c3AtcHVibGlzaC9zcmMvcm91dGVzL2FkbWluLnRlc3QudHMiLCIvc3JjL3JvdXRlcy9hZG1pbi50ZXN0LnRzIixbXV0=