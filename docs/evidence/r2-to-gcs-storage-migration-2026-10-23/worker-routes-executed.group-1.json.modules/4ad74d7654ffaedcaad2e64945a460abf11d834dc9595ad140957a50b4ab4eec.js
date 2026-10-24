'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["describe","expect","it"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/routes/index.ts", {"importedNames":["buildApi"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/__tests__/fake-d1.ts", {"importedNames":["makeEnv","stubGithub"]});



async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function manifest(contentHash, size) {
  return {
    listing_kind: "plugin",
    listing_ref: "creator-demo",
    github_repository_id: 7,
    github_owner: "alice",
    github_name: "creator-demo",
    github_url: "https://github.com/alice/creator-demo",
    title: "Creator demo",
    description: "A signed creator artifact",
    artifact: { content_hash: contentHash, size_bytes: size, content_type: "application/octet-stream" }
  };
}
(0,__vite_ssr_import_0__.describe)("authenticated creator draft lifecycle (P-007)", () => {
  (0,__vite_ssr_import_0__.it)("mints a one-use upload URL, validates bytes, reviews, publishes, and yanks", async () => {
    const api = (0,__vite_ssr_import_1__.buildApi)();
    const { env, store } = (0,__vite_ssr_import_2__.makeEnv)({ CUPBOARD_OPERATOR_GITHUB_IDS: "2" });
    const bytes = new TextEncoder().encode("creator artifact");
    const contentHash = await sha256(bytes);
    (0,__vite_ssr_import_2__.stubGithub)({ user: { id: 1, login: "alice" } });
    const create = await api.request("/creator-drafts", {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: manifest(contentHash, bytes.byteLength) })
    }, env);
    (0,__vite_ssr_import_0__.expect)(create.status).toBe(201);
    const created = await create.json();
    (0,__vite_ssr_import_0__.expect)(created.state).toBe("draft");
    (0,__vite_ssr_import_0__.expect)(created.upload_url).toContain(`/creator-drafts/${created.id}/artifact?token=`);
    const upload = await api.request(created.upload_url, { method: "PUT", body: bytes }, env);
    (0,__vite_ssr_import_0__.expect)(upload.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)((await upload.json()).artifact.content_hash).toBe(contentHash);
    const replay = await api.request(created.upload_url, { method: "PUT", body: bytes }, env);
    (0,__vite_ssr_import_0__.expect)(replay.status).toBe(410);
    const submit = await api.request(`/creator-drafts/${created.id}/submit`, {
      method: "POST",
      headers: { Authorization: "Bearer owner" }
    }, env);
    (0,__vite_ssr_import_0__.expect)(submit.status).toBe(200);
    (0,__vite_ssr_import_2__.stubGithub)({ user: { id: 2, login: "maintainer" } });
    const queue = await api.request("/admin/creator-drafts?state=submitted", {
      headers: { Authorization: "Bearer maintainer" }
    }, env);
    (0,__vite_ssr_import_0__.expect)(queue.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)((await queue.json()).drafts).toHaveLength(1);
    const review = await api.request(`/admin/creator-drafts/${created.id}/review`, {
      method: "POST",
      headers: { Authorization: "Bearer maintainer", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" })
    }, env);
    (0,__vite_ssr_import_0__.expect)(review.status).toBe(200);
    const reviewed = await review.json();
    (0,__vite_ssr_import_0__.expect)(reviewed.state).toBe("published");
    (0,__vite_ssr_import_0__.expect)(store.tables.harnesses).toHaveLength(1);
    (0,__vite_ssr_import_2__.stubGithub)({ user: { id: 1, login: "alice" } });
    const yank = await api.request(`/creator-drafts/${created.id}/yank`, {
      method: "POST",
      headers: { Authorization: "Bearer owner" }
    }, env);
    (0,__vite_ssr_import_0__.expect)(yank.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(store.tables.harnesses[0].unlisted_at).not.toBeNull();
    (0,__vite_ssr_import_0__.expect)(store.tables.harnesses[0].unlisted_reason).toContain("creator_draft:");
  });
  (0,__vite_ssr_import_0__.it)("refuses a payload whose digest or size differs from the declared artifact", async () => {
    const api = (0,__vite_ssr_import_1__.buildApi)();
    const { env } = (0,__vite_ssr_import_2__.makeEnv)();
    const bytes = new TextEncoder().encode("good bytes");
    const declared = new TextEncoder().encode("different bytes");
    (0,__vite_ssr_import_2__.stubGithub)({ user: { id: 1, login: "alice" } });
    const create = await api.request("/creator-drafts", {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: manifest(await sha256(bytes), bytes.byteLength) })
    }, env);
    const body = await create.json();
    const upload = await api.request(body.upload_url, { method: "PUT", body: declared }, env);
    (0,__vite_ssr_import_0__.expect)(upload.status).toBe(400);
    (0,__vite_ssr_import_0__.expect)((await upload.json()).error).toBe("artifact_size_mismatch");
  });
  (0,__vite_ssr_import_0__.it)("refuses an identity blueprint: its declared surface needs a signed closure a draft lacks", async () => {
    const api = (0,__vite_ssr_import_1__.buildApi)();
    const { env, store } = (0,__vite_ssr_import_2__.makeEnv)();
    (0,__vite_ssr_import_2__.stubGithub)({ user: { id: 1, login: "alice" } });
    const create = await api.request("/creator-drafts", {
      method: "POST",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: { ...manifest(`sha256:${"a".repeat(64)}`, 1), listing_kind: "blueprint", blueprint_kind: "identity" }
      })
    }, env);
    (0,__vite_ssr_import_0__.expect)(create.status).toBe(400);
    (0,__vite_ssr_import_0__.expect)(await create.json()).toMatchObject({
      field: "blueprint_kind",
      reason: "identity_requires_direct_publish"
    });
    (0,__vite_ssr_import_0__.expect)(store.tables.creator_drafts ?? []).toHaveLength(0);
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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T0FBTyxrQkFBa0IsQ0FBQyxDQUFDLEVBQUUsYUFBYSxDQUFDO0FBQUEsRUFDMUQsQ0FBQztBQUNILENBQUMiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbImNyZWF0b3ItZHJhZnRzLnRlc3QudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZGVzY3JpYmUsIGV4cGVjdCwgaXQgfSBmcm9tICd2aXRlc3QnO1xuaW1wb3J0IHsgYnVpbGRBcGkgfSBmcm9tICcuLi9yb3V0ZXMvaW5kZXgudHMnO1xuaW1wb3J0IHsgbWFrZUVudiwgc3R1YkdpdGh1YiB9IGZyb20gJy4vZmFrZS1kMS50cyc7XG5cbmFzeW5jIGZ1bmN0aW9uIHNoYTI1NihieXRlczogVWludDhBcnJheSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGRpZ2VzdCA9IGF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KCdTSEEtMjU2JywgbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpKTtcbiAgcmV0dXJuIGBzaGEyNTY6JHtBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGRpZ2VzdCksIChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKX1gO1xufVxuXG5mdW5jdGlvbiBtYW5pZmVzdChjb250ZW50SGFzaDogc3RyaW5nLCBzaXplOiBudW1iZXIpIHtcbiAgcmV0dXJuIHtcbiAgICBsaXN0aW5nX2tpbmQ6ICdwbHVnaW4nLFxuICAgIGxpc3RpbmdfcmVmOiAnY3JlYXRvci1kZW1vJyxcbiAgICBnaXRodWJfcmVwb3NpdG9yeV9pZDogNyxcbiAgICBnaXRodWJfb3duZXI6ICdhbGljZScsXG4gICAgZ2l0aHViX25hbWU6ICdjcmVhdG9yLWRlbW8nLFxuICAgIGdpdGh1Yl91cmw6ICdodHRwczovL2dpdGh1Yi5jb20vYWxpY2UvY3JlYXRvci1kZW1vJyxcbiAgICB0aXRsZTogJ0NyZWF0b3IgZGVtbycsXG4gICAgZGVzY3JpcHRpb246ICdBIHNpZ25lZCBjcmVhdG9yIGFydGlmYWN0JyxcbiAgICBhcnRpZmFjdDogeyBjb250ZW50X2hhc2g6IGNvbnRlbnRIYXNoLCBzaXplX2J5dGVzOiBzaXplLCBjb250ZW50X3R5cGU6ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nIH0sXG4gIH07XG59XG5cbmRlc2NyaWJlKCdhdXRoZW50aWNhdGVkIGNyZWF0b3IgZHJhZnQgbGlmZWN5Y2xlIChQLTAwNyknLCAoKSA9PiB7XG4gIGl0KCdtaW50cyBhIG9uZS11c2UgdXBsb2FkIFVSTCwgdmFsaWRhdGVzIGJ5dGVzLCByZXZpZXdzLCBwdWJsaXNoZXMsIGFuZCB5YW5rcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBhcGkgPSBidWlsZEFwaSgpO1xuICAgIGNvbnN0IHsgZW52LCBzdG9yZSB9ID0gbWFrZUVudih7IENVUEJPQVJEX09QRVJBVE9SX0dJVEhVQl9JRFM6ICcyJyB9KTtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSgnY3JlYXRvciBhcnRpZmFjdCcpO1xuICAgIGNvbnN0IGNvbnRlbnRIYXNoID0gYXdhaXQgc2hhMjU2KGJ5dGVzKTtcbiAgICBzdHViR2l0aHViKHsgdXNlcjogeyBpZDogMSwgbG9naW46ICdhbGljZScgfSB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZSA9IGF3YWl0IGFwaS5yZXF1ZXN0KCcvY3JlYXRvci1kcmFmdHMnLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciBvd25lcicsICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbWFuaWZlc3Q6IG1hbmlmZXN0KGNvbnRlbnRIYXNoLCBieXRlcy5ieXRlTGVuZ3RoKSB9KSxcbiAgICB9LCBlbnYpO1xuICAgIGV4cGVjdChjcmVhdGUuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IGNyZWF0ZS5qc29uKCkgYXMgeyBpZDogc3RyaW5nOyBzdGF0ZTogc3RyaW5nOyB1cGxvYWRfdXJsOiBzdHJpbmcgfTtcbiAgICBleHBlY3QoY3JlYXRlZC5zdGF0ZSkudG9CZSgnZHJhZnQnKTtcbiAgICBleHBlY3QoY3JlYXRlZC51cGxvYWRfdXJsKS50b0NvbnRhaW4oYC9jcmVhdG9yLWRyYWZ0cy8ke2NyZWF0ZWQuaWR9L2FydGlmYWN0P3Rva2VuPWApO1xuXG4gICAgY29uc3QgdXBsb2FkID0gYXdhaXQgYXBpLnJlcXVlc3QoY3JlYXRlZC51cGxvYWRfdXJsLCB7IG1ldGhvZDogJ1BVVCcsIGJvZHk6IGJ5dGVzIH0sIGVudik7XG4gICAgZXhwZWN0KHVwbG9hZC5zdGF0dXMpLnRvQmUoMjAwKTtcbiAgICBleHBlY3QoKGF3YWl0IHVwbG9hZC5qc29uKCkgYXMgeyBhcnRpZmFjdDogeyBjb250ZW50X2hhc2g6IHN0cmluZyB9IH0pLmFydGlmYWN0LmNvbnRlbnRfaGFzaCkudG9CZShjb250ZW50SGFzaCk7XG4gICAgY29uc3QgcmVwbGF5ID0gYXdhaXQgYXBpLnJlcXVlc3QoY3JlYXRlZC51cGxvYWRfdXJsLCB7IG1ldGhvZDogJ1BVVCcsIGJvZHk6IGJ5dGVzIH0sIGVudik7XG4gICAgZXhwZWN0KHJlcGxheS5zdGF0dXMpLnRvQmUoNDEwKTtcblxuICAgIGNvbnN0IHN1Ym1pdCA9IGF3YWl0IGFwaS5yZXF1ZXN0KGAvY3JlYXRvci1kcmFmdHMvJHtjcmVhdGVkLmlkfS9zdWJtaXRgLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJywgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyIG93bmVyJyB9LFxuICAgIH0sIGVudik7XG4gICAgZXhwZWN0KHN1Ym1pdC5zdGF0dXMpLnRvQmUoMjAwKTtcblxuICAgIHN0dWJHaXRodWIoeyB1c2VyOiB7IGlkOiAyLCBsb2dpbjogJ21haW50YWluZXInIH0gfSk7XG4gICAgY29uc3QgcXVldWUgPSBhd2FpdCBhcGkucmVxdWVzdCgnL2FkbWluL2NyZWF0b3ItZHJhZnRzP3N0YXRlPXN1Ym1pdHRlZCcsIHtcbiAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciBtYWludGFpbmVyJyB9LFxuICAgIH0sIGVudik7XG4gICAgZXhwZWN0KHF1ZXVlLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdCgoYXdhaXQgcXVldWUuanNvbigpIGFzIHsgZHJhZnRzOiB1bmtub3duW10gfSkuZHJhZnRzKS50b0hhdmVMZW5ndGgoMSk7XG5cbiAgICBjb25zdCByZXZpZXcgPSBhd2FpdCBhcGkucmVxdWVzdChgL2FkbWluL2NyZWF0b3ItZHJhZnRzLyR7Y3JlYXRlZC5pZH0vcmV2aWV3YCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgbWFpbnRhaW5lcicsICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZGVjaXNpb246ICdhcHByb3ZlJyB9KSxcbiAgICB9LCBlbnYpO1xuICAgIGV4cGVjdChyZXZpZXcuc3RhdHVzKS50b0JlKDIwMCk7XG4gICAgY29uc3QgcmV2aWV3ZWQgPSBhd2FpdCByZXZpZXcuanNvbigpIGFzIHsgbGlzdGluZ19pZDogc3RyaW5nOyBzdGF0ZTogc3RyaW5nIH07XG4gICAgZXhwZWN0KHJldmlld2VkLnN0YXRlKS50b0JlKCdwdWJsaXNoZWQnKTtcbiAgICBleHBlY3Qoc3RvcmUudGFibGVzLmhhcm5lc3NlcykudG9IYXZlTGVuZ3RoKDEpO1xuXG4gICAgc3R1YkdpdGh1Yih7IHVzZXI6IHsgaWQ6IDEsIGxvZ2luOiAnYWxpY2UnIH0gfSk7XG4gICAgY29uc3QgeWFuayA9IGF3YWl0IGFwaS5yZXF1ZXN0KGAvY3JlYXRvci1kcmFmdHMvJHtjcmVhdGVkLmlkfS95YW5rYCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciBvd25lcicgfSxcbiAgICB9LCBlbnYpO1xuICAgIGV4cGVjdCh5YW5rLnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChzdG9yZS50YWJsZXMuaGFybmVzc2VzWzBdLnVubGlzdGVkX2F0KS5ub3QudG9CZU51bGwoKTtcbiAgICBleHBlY3Qoc3RvcmUudGFibGVzLmhhcm5lc3Nlc1swXS51bmxpc3RlZF9yZWFzb24pLnRvQ29udGFpbignY3JlYXRvcl9kcmFmdDonKTtcbiAgfSk7XG5cbiAgaXQoJ3JlZnVzZXMgYSBwYXlsb2FkIHdob3NlIGRpZ2VzdCBvciBzaXplIGRpZmZlcnMgZnJvbSB0aGUgZGVjbGFyZWQgYXJ0aWZhY3QnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYXBpID0gYnVpbGRBcGkoKTtcbiAgICBjb25zdCB7IGVudiB9ID0gbWFrZUVudigpO1xuICAgIGNvbnN0IGJ5dGVzID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKCdnb29kIGJ5dGVzJyk7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoJ2RpZmZlcmVudCBieXRlcycpO1xuICAgIHN0dWJHaXRodWIoeyB1c2VyOiB7IGlkOiAxLCBsb2dpbjogJ2FsaWNlJyB9IH0pO1xuICAgIGNvbnN0IGNyZWF0ZSA9IGF3YWl0IGFwaS5yZXF1ZXN0KCcvY3JlYXRvci1kcmFmdHMnLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciBvd25lcicsICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbWFuaWZlc3Q6IG1hbmlmZXN0KGF3YWl0IHNoYTI1NihieXRlcyksIGJ5dGVzLmJ5dGVMZW5ndGgpIH0pLFxuICAgIH0sIGVudik7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGNyZWF0ZS5qc29uKCkgYXMgeyB1cGxvYWRfdXJsOiBzdHJpbmcgfTtcbiAgICBjb25zdCB1cGxvYWQgPSBhd2FpdCBhcGkucmVxdWVzdChib2R5LnVwbG9hZF91cmwsIHsgbWV0aG9kOiAnUFVUJywgYm9keTogZGVjbGFyZWQgfSwgZW52KTtcbiAgICBleHBlY3QodXBsb2FkLnN0YXR1cykudG9CZSg0MDApO1xuICAgIGV4cGVjdCgoYXdhaXQgdXBsb2FkLmpzb24oKSBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IpLnRvQmUoJ2FydGlmYWN0X3NpemVfbWlzbWF0Y2gnKTtcbiAgfSk7XG5cbiAgaXQoJ3JlZnVzZXMgYW4gaWRlbnRpdHkgYmx1ZXByaW50OiBpdHMgZGVjbGFyZWQgc3VyZmFjZSBuZWVkcyBhIHNpZ25lZCBjbG9zdXJlIGEgZHJhZnQgbGFja3MnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYXBpID0gYnVpbGRBcGkoKTtcbiAgICBjb25zdCB7IGVudiwgc3RvcmUgfSA9IG1ha2VFbnYoKTtcbiAgICBzdHViR2l0aHViKHsgdXNlcjogeyBpZDogMSwgbG9naW46ICdhbGljZScgfSB9KTtcbiAgICBjb25zdCBjcmVhdGUgPSBhd2FpdCBhcGkucmVxdWVzdCgnL2NyZWF0b3ItZHJhZnRzJywge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgb3duZXInLCAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1hbmlmZXN0OiB7IC4uLm1hbmlmZXN0KGBzaGEyNTY6JHsnYScucmVwZWF0KDY0KX1gLCAxKSwgbGlzdGluZ19raW5kOiAnYmx1ZXByaW50JywgYmx1ZXByaW50X2tpbmQ6ICdpZGVudGl0eScgfSxcbiAgICAgIH0pLFxuICAgIH0sIGVudik7XG4gICAgZXhwZWN0KGNyZWF0ZS5zdGF0dXMpLnRvQmUoNDAwKTtcbiAgICBleHBlY3QoYXdhaXQgY3JlYXRlLmpzb24oKSkudG9NYXRjaE9iamVjdCh7XG4gICAgICBmaWVsZDogJ2JsdWVwcmludF9raW5kJyxcbiAgICAgIHJlYXNvbjogJ2lkZW50aXR5X3JlcXVpcmVzX2RpcmVjdF9wdWJsaXNoJyxcbiAgICB9KTtcbiAgICBleHBlY3Qoc3RvcmUudGFibGVzLmNyZWF0b3JfZHJhZnRzID8/IFtdKS50b0hhdmVMZW5ndGgoMCk7XG4gIH0pO1xufSk7XG4iXSwiZmlsZSI6Ii9zcmMvX190ZXN0c19fL2NyZWF0b3ItZHJhZnRzLnRlc3QudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL19fdGVzdHNfXy9jcmVhdG9yLWRyYWZ0cy50ZXN0LnRzIiwiL3NyYy9fX3Rlc3RzX18vY3JlYXRvci1kcmFmdHMudGVzdC50cyIsW11d
}}