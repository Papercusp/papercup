const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["describe","expect","it"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/p2p/artifact-package.ts", {"importedNames":["buildArtifactPackage"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/cupboard/artifact-store.ts", {"importedNames":["cupboardArtifactKey"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/routes/index.ts", {"importedNames":["buildApi"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/routes/self-describing-artifacts.ts", {"importedNames":["MAX_SELF_DESCRIBING_ARTIFACT_BYTES","SELF_DESCRIBING_ORIGIN"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/__tests__/fake-d1.ts", {"importedNames":["makeEnv","stubGithub"]});






const BYTES = Buffer.from(JSON.stringify({ files: [{ path: "recipe.json", body: "clean" }] }));
const ROOT = (0,__vite_ssr_import_1__.buildArtifactPackage)(BYTES).rootHash;
const HEX = ROOT.slice("sha256:".length);
async function put(api, env, hex, body, auth = true) {
  return api.request(
    `/artifacts/sha256/${hex}`,
    { method: "PUT", headers: auth ? { Authorization: "Bearer pub" } : {}, body: new Uint8Array(body) },
    env
  );
}
(0,__vite_ssr_import_0__.describe)("self-describing artifact origin route (P-011)", () => {
  (0,__vite_ssr_import_0__.it)("stores bytes whose Merkle root equals the address, and serves them back byte-identical", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env, r2 } = (0,__vite_ssr_import_5__.makeEnv)();
    (0,__vite_ssr_import_5__.stubGithub)({ user: { id: 1, login: "alice" } });
    const res = await put(api, env, HEX, BYTES);
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(201);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toMatchObject({ ok: true, existed: false, content_hash: ROOT, size_bytes: BYTES.length });
    const head = await r2.head((0,__vite_ssr_import_2__.cupboardArtifactKey)(ROOT));
    (0,__vite_ssr_import_0__.expect)(head?.customMetadata?.origin).toBe((0,__vite_ssr_import_4__.SELF_DESCRIBING_ORIGIN));
    const got = await api.request(`/artifacts/sha256/${HEX}`, {}, env);
    (0,__vite_ssr_import_0__.expect)(got.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(Buffer.from(await got.arrayBuffer()).equals(BYTES)).toBe(true);
    (0,__vite_ssr_import_0__.expect)(got.headers.get("cache-control")).toContain("immutable");
  });
  (0,__vite_ssr_import_0__.it)("refuses content-address-mismatch when the bytes do not hold the claimed address, and stores nothing", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env, r2 } = (0,__vite_ssr_import_5__.makeEnv)();
    (0,__vite_ssr_import_5__.stubGithub)({ user: { id: 1, login: "alice" } });
    const tampered = Buffer.from(JSON.stringify({ files: [{ path: "recipe.json", body: "DIRTY" }] }));
    const res = await put(api, env, HEX, tampered);
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(422);
    (0,__vite_ssr_import_0__.expect)(await res.json()).toMatchObject({ error: "content-address-mismatch", expected: ROOT });
    (0,__vite_ssr_import_0__.expect)(await r2.head((0,__vite_ssr_import_2__.cupboardArtifactKey)(ROOT))).toBeNull();
  });
  (0,__vite_ssr_import_0__.it)("is idempotent: a replay of the same address is a no-op that reports existed", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env } = (0,__vite_ssr_import_5__.makeEnv)();
    (0,__vite_ssr_import_5__.stubGithub)({ user: { id: 1, login: "alice" } });
    (0,__vite_ssr_import_0__.expect)((await put(api, env, HEX, BYTES)).status).toBe(201);
    const replay = await put(api, env, HEX, BYTES);
    (0,__vite_ssr_import_0__.expect)(replay.status).toBe(200);
    (0,__vite_ssr_import_0__.expect)(await replay.json()).toMatchObject({ ok: true, existed: true });
  });
  (0,__vite_ssr_import_0__.it)("requires a GitHub bearer to upload", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env, r2 } = (0,__vite_ssr_import_5__.makeEnv)();
    const res = await put(api, env, HEX, BYTES, false);
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(401);
    (0,__vite_ssr_import_0__.expect)(await r2.head((0,__vite_ssr_import_2__.cupboardArtifactKey)(ROOT))).toBeNull();
  });
  (0,__vite_ssr_import_0__.it)("rejects a malformed address and an oversize body before touching R2", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env, r2 } = (0,__vite_ssr_import_5__.makeEnv)();
    (0,__vite_ssr_import_5__.stubGithub)({ user: { id: 1, login: "alice" } });
    (0,__vite_ssr_import_0__.expect)((await put(api, env, "not-a-hash", BYTES)).status).toBe(400);
    const huge = Buffer.alloc(__vite_ssr_import_4__.MAX_SELF_DESCRIBING_ARTIFACT_BYTES + 1, 7);
    const res = await put(api, env, HEX, huge);
    (0,__vite_ssr_import_0__.expect)(res.status).toBe(413);
    (0,__vite_ssr_import_0__.expect)(await r2.head((0,__vite_ssr_import_2__.cupboardArtifactKey)(ROOT))).toBeNull();
  });
  (0,__vite_ssr_import_0__.it)("is NOT a read door onto an object this route did not write (creator-draft key space)", async () => {
    const api = (0,__vite_ssr_import_3__.buildApi)();
    const { env, r2 } = (0,__vite_ssr_import_5__.makeEnv)();
    await r2.put((0,__vite_ssr_import_2__.cupboardArtifactKey)(ROOT), BYTES, { customMetadata: { draftId: "d1" } });
    (0,__vite_ssr_import_0__.expect)((await api.request(`/artifacts/sha256/${HEX}`, {}, env)).status).toBe(404);
    (0,__vite_ssr_import_5__.stubGithub)({ user: { id: 1, login: "alice" } });
    (0,__vite_ssr_import_0__.expect)((await put(api, env, HEX, BYTES)).status).toBe(409);
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFJLDJDQUFvQixJQUFJLEdBQUcsT0FBTyxFQUFFLGdCQUFnQixFQUFFLFNBQVMsS0FBSyxFQUFFLENBQUM7QUFDcEYsc0NBQVEsTUFBTSxJQUFJLFFBQVEscUJBQXFCLEdBQUcsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLE1BQU0sRUFBRSxLQUFLLEdBQUc7QUFDaEYseUNBQVcsRUFBRSxNQUFNLEVBQUUsSUFBSSxHQUFHLE9BQU8sUUFBUSxFQUFFLENBQUM7QUFFOUMsc0NBQVEsTUFBTSxJQUFJLEtBQUssS0FBSyxLQUFLLEtBQUssR0FBRyxNQUFNLEVBQUUsS0FBSyxHQUFHO0FBQUEsRUFDM0QsQ0FBQztBQUNILENBQUMiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbInNlbGYtZGVzY3JpYmluZy1hcnRpZmFjdHMudGVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGN1cGJvYXJkLXJlbGVhc2UtcGlwZWxpbmUtY29udGVudC10cnVzdCBQLTAxMSDigJQgdGhlIFIyIE9SSUdJTiByb3V0ZSBmb3Igc2VsZi1kZXNjcmliaW5nXG4gKiByZWxlYXNlIGJ5dGVzLiBUaGUgYWRkcmVzcyBpcyB0aGUgdmVyaWZpY2F0aW9uOiBhIFBVVCBpcyBhY2NlcHRlZCBvbmx5IGlmIHRoZSBieXRlcydcbiAqIE1lcmtsZSByb290ICh0aGUgU0FNRSBidWlsZEFydGlmYWN0UGFja2FnZSB0aGUgcHVibGlzaGVyIGFuZCBpbnN0YWxsZXIgdXNlKSBlcXVhbHMgdGhlXG4gKiBhZGRyZXNzIGluIHRoZSBVUkwuXG4gKi9cbmltcG9ydCB7IGRlc2NyaWJlLCBleHBlY3QsIGl0IH0gZnJvbSAndml0ZXN0JztcbmltcG9ydCB7IGJ1aWxkQXJ0aWZhY3RQYWNrYWdlIH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9wMnAvYXJ0aWZhY3QtcGFja2FnZS50cyc7XG5pbXBvcnQgeyBjdXBib2FyZEFydGlmYWN0S2V5IH0gZnJvbSAnQHBhcGVyY3VzcC9vcGVyYXRvci1jb3JlL2xpYi9jdXBib2FyZC9hcnRpZmFjdC1zdG9yZS50cyc7XG5pbXBvcnQgeyBidWlsZEFwaSB9IGZyb20gJy4uL3JvdXRlcy9pbmRleC50cyc7XG5pbXBvcnQgeyBNQVhfU0VMRl9ERVNDUklCSU5HX0FSVElGQUNUX0JZVEVTLCBTRUxGX0RFU0NSSUJJTkdfT1JJR0lOIH0gZnJvbSAnLi4vcm91dGVzL3NlbGYtZGVzY3JpYmluZy1hcnRpZmFjdHMudHMnO1xuaW1wb3J0IHsgbWFrZUVudiwgc3R1YkdpdGh1YiB9IGZyb20gJy4vZmFrZS1kMS50cyc7XG5cbmNvbnN0IEJZVEVTID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoeyBmaWxlczogW3sgcGF0aDogJ3JlY2lwZS5qc29uJywgYm9keTogJ2NsZWFuJyB9XSB9KSk7XG5jb25zdCBST09UID0gYnVpbGRBcnRpZmFjdFBhY2thZ2UoQllURVMpLnJvb3RIYXNoO1xuY29uc3QgSEVYID0gUk9PVC5zbGljZSgnc2hhMjU2OicubGVuZ3RoKTtcblxuYXN5bmMgZnVuY3Rpb24gcHV0KGFwaTogUmV0dXJuVHlwZTx0eXBlb2YgYnVpbGRBcGk+LCBlbnY6IFJldHVyblR5cGU8dHlwZW9mIG1ha2VFbnY+WydlbnYnXSwgaGV4OiBzdHJpbmcsIGJvZHk6IEJ1ZmZlciwgYXV0aCA9IHRydWUpIHtcbiAgcmV0dXJuIGFwaS5yZXF1ZXN0KFxuICAgIGAvYXJ0aWZhY3RzL3NoYTI1Ni8ke2hleH1gLFxuICAgIHsgbWV0aG9kOiAnUFVUJywgaGVhZGVyczogYXV0aCA/IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciBwdWInIH0gOiB7fSwgYm9keTogbmV3IFVpbnQ4QXJyYXkoYm9keSkgfSxcbiAgICBlbnYsXG4gICk7XG59XG5cbmRlc2NyaWJlKCdzZWxmLWRlc2NyaWJpbmcgYXJ0aWZhY3Qgb3JpZ2luIHJvdXRlIChQLTAxMSknLCAoKSA9PiB7XG4gIGl0KCdzdG9yZXMgYnl0ZXMgd2hvc2UgTWVya2xlIHJvb3QgZXF1YWxzIHRoZSBhZGRyZXNzLCBhbmQgc2VydmVzIHRoZW0gYmFjayBieXRlLWlkZW50aWNhbCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBhcGkgPSBidWlsZEFwaSgpO1xuICAgIGNvbnN0IHsgZW52LCByMiB9ID0gbWFrZUVudigpO1xuICAgIHN0dWJHaXRodWIoeyB1c2VyOiB7IGlkOiAxLCBsb2dpbjogJ2FsaWNlJyB9IH0pO1xuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgcHV0KGFwaSwgZW52LCBIRVgsIEJZVEVTKTtcbiAgICBleHBlY3QocmVzLnN0YXR1cykudG9CZSgyMDEpO1xuICAgIGV4cGVjdChhd2FpdCByZXMuanNvbigpKS50b01hdGNoT2JqZWN0KHsgb2s6IHRydWUsIGV4aXN0ZWQ6IGZhbHNlLCBjb250ZW50X2hhc2g6IFJPT1QsIHNpemVfYnl0ZXM6IEJZVEVTLmxlbmd0aCB9KTtcbiAgICBjb25zdCBoZWFkID0gYXdhaXQgcjIuaGVhZChjdXBib2FyZEFydGlmYWN0S2V5KFJPT1QpKTtcbiAgICBleHBlY3QoaGVhZD8uY3VzdG9tTWV0YWRhdGE/Lm9yaWdpbikudG9CZShTRUxGX0RFU0NSSUJJTkdfT1JJR0lOKTtcblxuICAgIGNvbnN0IGdvdCA9IGF3YWl0IGFwaS5yZXF1ZXN0KGAvYXJ0aWZhY3RzL3NoYTI1Ni8ke0hFWH1gLCB7fSwgZW52KTtcbiAgICBleHBlY3QoZ290LnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChCdWZmZXIuZnJvbShhd2FpdCBnb3QuYXJyYXlCdWZmZXIoKSkuZXF1YWxzKEJZVEVTKSkudG9CZSh0cnVlKTtcbiAgICAvLyBUb2tlbmxlc3MgYnkgZGVzaWduOiBhIHB1YmxpYyBsaXN0aW5nJ3MgaW5zdGFsbCBjYXJyaWVzIG5vIGNyZWRlbnRpYWwuXG4gICAgZXhwZWN0KGdvdC5oZWFkZXJzLmdldCgnY2FjaGUtY29udHJvbCcpKS50b0NvbnRhaW4oJ2ltbXV0YWJsZScpO1xuICB9KTtcblxuICBpdCgncmVmdXNlcyBjb250ZW50LWFkZHJlc3MtbWlzbWF0Y2ggd2hlbiB0aGUgYnl0ZXMgZG8gbm90IGhvbGQgdGhlIGNsYWltZWQgYWRkcmVzcywgYW5kIHN0b3JlcyBub3RoaW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGFwaSA9IGJ1aWxkQXBpKCk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBtYWtlRW52KCk7XG4gICAgc3R1YkdpdGh1Yih7IHVzZXI6IHsgaWQ6IDEsIGxvZ2luOiAnYWxpY2UnIH0gfSk7XG5cbiAgICBjb25zdCB0YW1wZXJlZCA9IEJ1ZmZlci5mcm9tKEpTT04uc3RyaW5naWZ5KHsgZmlsZXM6IFt7IHBhdGg6ICdyZWNpcGUuanNvbicsIGJvZHk6ICdESVJUWScgfV0gfSkpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHB1dChhcGksIGVudiwgSEVYLCB0YW1wZXJlZCk7XG4gICAgZXhwZWN0KHJlcy5zdGF0dXMpLnRvQmUoNDIyKTtcbiAgICBleHBlY3QoYXdhaXQgcmVzLmpzb24oKSkudG9NYXRjaE9iamVjdCh7IGVycm9yOiAnY29udGVudC1hZGRyZXNzLW1pc21hdGNoJywgZXhwZWN0ZWQ6IFJPT1QgfSk7XG4gICAgZXhwZWN0KGF3YWl0IHIyLmhlYWQoY3VwYm9hcmRBcnRpZmFjdEtleShST09UKSkpLnRvQmVOdWxsKCk7XG4gIH0pO1xuXG4gIGl0KCdpcyBpZGVtcG90ZW50OiBhIHJlcGxheSBvZiB0aGUgc2FtZSBhZGRyZXNzIGlzIGEgbm8tb3AgdGhhdCByZXBvcnRzIGV4aXN0ZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYXBpID0gYnVpbGRBcGkoKTtcbiAgICBjb25zdCB7IGVudiB9ID0gbWFrZUVudigpO1xuICAgIHN0dWJHaXRodWIoeyB1c2VyOiB7IGlkOiAxLCBsb2dpbjogJ2FsaWNlJyB9IH0pO1xuICAgIGV4cGVjdCgoYXdhaXQgcHV0KGFwaSwgZW52LCBIRVgsIEJZVEVTKSkuc3RhdHVzKS50b0JlKDIwMSk7XG4gICAgY29uc3QgcmVwbGF5ID0gYXdhaXQgcHV0KGFwaSwgZW52LCBIRVgsIEJZVEVTKTtcbiAgICBleHBlY3QocmVwbGF5LnN0YXR1cykudG9CZSgyMDApO1xuICAgIGV4cGVjdChhd2FpdCByZXBsYXkuanNvbigpKS50b01hdGNoT2JqZWN0KHsgb2s6IHRydWUsIGV4aXN0ZWQ6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGl0KCdyZXF1aXJlcyBhIEdpdEh1YiBiZWFyZXIgdG8gdXBsb2FkJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGFwaSA9IGJ1aWxkQXBpKCk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBtYWtlRW52KCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgcHV0KGFwaSwgZW52LCBIRVgsIEJZVEVTLCBmYWxzZSk7XG4gICAgZXhwZWN0KHJlcy5zdGF0dXMpLnRvQmUoNDAxKTtcbiAgICBleHBlY3QoYXdhaXQgcjIuaGVhZChjdXBib2FyZEFydGlmYWN0S2V5KFJPT1QpKSkudG9CZU51bGwoKTtcbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgYSBtYWxmb3JtZWQgYWRkcmVzcyBhbmQgYW4gb3ZlcnNpemUgYm9keSBiZWZvcmUgdG91Y2hpbmcgUjInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYXBpID0gYnVpbGRBcGkoKTtcbiAgICBjb25zdCB7IGVudiwgcjIgfSA9IG1ha2VFbnYoKTtcbiAgICBzdHViR2l0aHViKHsgdXNlcjogeyBpZDogMSwgbG9naW46ICdhbGljZScgfSB9KTtcbiAgICBleHBlY3QoKGF3YWl0IHB1dChhcGksIGVudiwgJ25vdC1hLWhhc2gnLCBCWVRFUykpLnN0YXR1cykudG9CZSg0MDApO1xuICAgIGNvbnN0IGh1Z2UgPSBCdWZmZXIuYWxsb2MoTUFYX1NFTEZfREVTQ1JJQklOR19BUlRJRkFDVF9CWVRFUyArIDEsIDcpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IHB1dChhcGksIGVudiwgSEVYLCBodWdlKTtcbiAgICBleHBlY3QocmVzLnN0YXR1cykudG9CZSg0MTMpO1xuICAgIGV4cGVjdChhd2FpdCByMi5oZWFkKGN1cGJvYXJkQXJ0aWZhY3RLZXkoUk9PVCkpKS50b0JlTnVsbCgpO1xuICB9KTtcblxuICBpdCgnaXMgTk9UIGEgcmVhZCBkb29yIG9udG8gYW4gb2JqZWN0IHRoaXMgcm91dGUgZGlkIG5vdCB3cml0ZSAoY3JlYXRvci1kcmFmdCBrZXkgc3BhY2UpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGFwaSA9IGJ1aWxkQXBpKCk7XG4gICAgY29uc3QgeyBlbnYsIHIyIH0gPSBtYWtlRW52KCk7XG4gICAgLy8gQSBwcml2YXRlIGNyZWF0b3ItZHJhZnQgYXJ0aWZhY3QgbGl2ZXMgYXQgdGhlIHNhbWUga2V5IHNoYXBlLCBhZGRyZXNzZWQgYnkgYSBmbGF0IGRpZ2VzdC5cbiAgICBhd2FpdCByMi5wdXQoY3VwYm9hcmRBcnRpZmFjdEtleShST09UKSwgQllURVMsIHsgY3VzdG9tTWV0YWRhdGE6IHsgZHJhZnRJZDogJ2QxJyB9IH0pO1xuICAgIGV4cGVjdCgoYXdhaXQgYXBpLnJlcXVlc3QoYC9hcnRpZmFjdHMvc2hhMjU2LyR7SEVYfWAsIHt9LCBlbnYpKS5zdGF0dXMpLnRvQmUoNDA0KTtcbiAgICBzdHViR2l0aHViKHsgdXNlcjogeyBpZDogMSwgbG9naW46ICdhbGljZScgfSB9KTtcbiAgICAvLyAuLi5hbmQgYSBwdWJsaXNoZXIgY2Fubm90IGNsYWltIGFuIG9jY3VwaWVkIGtleSBlaXRoZXIuXG4gICAgZXhwZWN0KChhd2FpdCBwdXQoYXBpLCBlbnYsIEhFWCwgQllURVMpKS5zdGF0dXMpLnRvQmUoNDA5KTtcbiAgfSk7XG59KTtcbiJdLCJmaWxlIjoiL3NyYy9fX3Rlc3RzX18vc2VsZi1kZXNjcmliaW5nLWFydGlmYWN0cy50ZXN0LnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL19fdGVzdHNfXy9zZWxmLWRlc2NyaWJpbmctYXJ0aWZhY3RzLnRlc3QudHMiLCIvc3JjL19fdGVzdHNfXy9zZWxmLWRlc2NyaWJpbmctYXJ0aWZhY3RzLnRlc3QudHMiLFtdXQ==