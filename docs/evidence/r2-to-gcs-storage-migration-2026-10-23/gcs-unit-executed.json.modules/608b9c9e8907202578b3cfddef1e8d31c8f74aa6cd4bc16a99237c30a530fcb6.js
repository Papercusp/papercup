'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["describe","expect","it"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/gcs-object-store.ts", {"importedNames":["gcsObjectStore","GcsStorageError"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/content-address.ts", {"importedNames":["sha256Hex"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/object-store.ts", {"importedNames":["objectStoreAsBlobStore"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/blob-store.ts", {"importedNames":["putContentAddressed"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/content-address.ts", {"importedNames":["contentAddressing"]});






const enc = new TextEncoder();
function provider() {
  const objects = /* @__PURE__ */ new Map();
  const uploads = /* @__PURE__ */ new Map();
  const requests = [];
  let generation = 100;
  let denied = false;
  let loseResponse = false;
  let vanishBeforeMedia = false;
  let beforeUploadCommit;
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  const describeObject = (key, o) => ({ name: key, size: String(o.bytes.length), generation: o.generation, updated: "2026-10-24T00:00:00Z", ...o.metadata });
  function seed(key, body, metadata = {}) {
    const object = { bytes: typeof body === "string" ? enc.encode(body) : body, metadata, generation: String(++generation) };
    objects.set(key, object);
    return object;
  }
  const fetchImpl = (async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    requests.push({ url, method, init });
    (0,__vite_ssr_import_0__.expect)(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    if (denied) return json({ error: "denied" }, 403);
    const id = url.searchParams.get("upload_id");
    if (id && method === "PUT") {
      const upload = uploads.get(id);
      beforeUploadCommit?.();
      beforeUploadCommit = void 0;
      const existing = objects.get(upload.key);
      if (upload.condition === "0" ? Boolean(existing) : upload.condition && existing?.generation !== upload.condition) return json({}, 412);
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const o2 = seed(upload.key, bytes, upload.metadata);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after provider commit");
      };
      return json(describeObject(upload.key, o2));
    };
    if (url.searchParams.get("uploadType") === "resumable") {
      const key2 = url.searchParams.get("name");
      const uploadId = String(uploads.size + 1);
      uploads.set(uploadId, { key: key2, metadata: JSON.parse(String(init.body)), condition: url.searchParams.get("ifGenerationMatch") });
      return new Response(null, { status: 200, headers: { location: `https://storage.googleapis.com/upload/storage/v1/b/test-bucket/o?upload_id=${uploadId}` } });
    };
    const marker = "/storage/v1/b/test-bucket/o";
    const compose = url.pathname.endsWith("/compose");
    const key = decodeURIComponent(url.pathname.slice(marker.length + 1, compose ? -8 : void 0));
    if (compose && method === "POST") {
      if (objects.has(key) && url.searchParams.get("ifGenerationMatch") === "0") return json({}, 412);
      const b = JSON.parse(String(init.body));
      const sources = b.sourceObjects.map((s) => {
        const o2 = objects.get(s.name);
        return o2?.generation === s.generation ? o2 : null;
      });
      if (sources.some((x) => !x)) return json({}, 404);
      (0,__vite_ssr_import_0__.expect)(sources.length).toBeLessThanOrEqual(32);
      const bytes = new Uint8Array(sources.reduce((n, x) => n + x.bytes.length, 0));
      let offset = 0;
      for (const o2 of sources) {
        bytes.set(o2.bytes, offset);
        offset += o2.bytes.length;
      };
      const result = seed(key, bytes, b.destination);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after provider commit");
      };
      return json(describeObject(key, result));
    };
    if (url.pathname === marker && method === "GET") {
      const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const limit = Number(url.searchParams.get("maxResults"));
      return json({
        items: keys.slice(offset, offset + limit).map((k) => describeObject(k, objects.get(k))),
        ...offset + limit < keys.length ? { nextPageToken: String(offset + limit) } : {}
      });
    };
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    };
    const o = objects.get(key);
    if (!o) return json({}, 404);
    if (url.searchParams.get("alt") === "media") {
      if (vanishBeforeMedia || url.searchParams.get("generation") !== o.generation) return json({}, 404);
      return new Response(new Uint8Array(o.bytes).buffer);
    };
    return json(describeObject(key, o));
  });
  const store = (0,__vite_ssr_import_1__.gcsObjectStore)({ bucket: "test-bucket", accessToken: async () => "test-token", fetchImpl });
  return {
    store,
    objects,
    requests,
    seed,
    setDenied: () => {
      denied = true;
    },
    loseNextCommitResponse: () => {
      loseResponse = true;
    },
    vanishBeforeMedia: () => {
      vanishBeforeMedia = true;
    },
    beforeUploadCommit: (f) => {
      beforeUploadCommit = f;
    }
  };
}
(0,__vite_ssr_import_0__.describe)("private GCS object storage port", () => {
  (0,__vite_ssr_import_0__.it)("preserves exact bytes, custom/HTTP metadata and generation-pinned reads", async () => {
    const p = provider();
    const bytes = enc.encode("private creator bytes");
    const object = await p.store.put("tenant/private.bin", bytes, {
      sha256: await (0,__vite_ssr_import_2__.sha256Hex)(bytes),
      customMetadata: { visibility: "private", tenant: "one" },
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private" }
    });
    const read = await p.store.get("tenant/private.bin");
    (0,__vite_ssr_import_0__.expect)(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    (0,__vite_ssr_import_0__.expect)(read.customMetadata).toEqual({ visibility: "private", tenant: "one" });
    const headers = new Headers();
    read.writeHttpMetadata(headers);
    (0,__vite_ssr_import_0__.expect)(headers.get("cache-control")).toBe("private");
    (0,__vite_ssr_import_0__.expect)(p.requests.find((x) => x.url.searchParams.get("alt") === "media").url.searchParams.get("generation")).toBe(object.version);
  });
  (0,__vite_ssr_import_0__.it)("retains the existing hash-verifying BlobStore seam", async () => {
    const p = provider();
    const bytes = enc.encode("registry artifact");
    const hash = await (0,__vite_ssr_import_2__.sha256Hex)(bytes);
    const result = await (0,__vite_ssr_import_4__.putContentAddressed)((0,__vite_ssr_import_3__.objectStoreAsBlobStore)(p.store), {
      hash,
      scheme: (0,__vite_ssr_import_5__.contentAddressing)({ prefix: "registry", ext: ".tgz" }),
      readBody: async () => bytes.buffer,
      maxBytes: 100
    });
    (0,__vite_ssr_import_0__.expect)(result).toMatchObject({ ok: true, deduped: false });
    (0,__vite_ssr_import_0__.expect)(p.objects.get(`registry/${hash}.tgz`).bytes).toEqual(bytes);
  });
  (0,__vite_ssr_import_0__.it)("refuses a wrong SHA256 before sending bytes to the provider", async () => {
    const p = provider();
    await (0,__vite_ssr_import_0__.expect)(p.store.put("bad", "wrong", { sha256: "0".repeat(64) })).rejects.toThrow("sha_mismatch");
    (0,__vite_ssr_import_0__.expect)(p.requests).toHaveLength(0);
  });
  (0,__vite_ssr_import_0__.it)("fences a create-only race at commit and preserves occupied bytes", async () => {
    const p = provider();
    p.beforeUploadCommit(() => {
      p.seed("occupied", "first-writer");
    });
    (0,__vite_ssr_import_0__.expect)(await p.store.put("occupied", "second-writer", { onlyIf: { etagDoesNotMatch: "*" } })).toBeNull();
    (0,__vite_ssr_import_0__.expect)(await (await p.store.get("occupied")).text()).toBe("first-writer");
  });
  (0,__vite_ssr_import_0__.it)("fences stale conditional updates by generation", async () => {
    const p = provider();
    const first = await p.store.put("state", "one");
    await p.store.put("state", "two");
    (0,__vite_ssr_import_0__.expect)(await p.store.put("state", "stale", { onlyIf: { etagMatches: first.httpEtag } })).toBeNull();
    (0,__vite_ssr_import_0__.expect)(await (await p.store.get("state")).text()).toBe("two");
  });
  (0,__vite_ssr_import_0__.it)("does not turn permission or pinned-generation failures into absence", async () => {
    const denied = provider();
    denied.setDenied();
    await (0,__vite_ssr_import_0__.expect)(denied.store.head("private")).rejects.toMatchObject({ code: 403 });
    await (0,__vite_ssr_import_0__.expect)(denied.store.get("private")).rejects.toBeInstanceOf((0,__vite_ssr_import_1__.GcsStorageError));
    const raced = provider();
    raced.seed("private", "x");
    raced.vanishBeforeMedia();
    await (0,__vite_ssr_import_0__.expect)(raced.store.get("private")).rejects.toMatchObject({ code: 404 });
  });
  (0,__vite_ssr_import_0__.it)("streams request bytes and paginates a tenant prefix without listing siblings", async () => {
    const p = provider();
    const stream = new ReadableStream({ start(c) {
      c.enqueue(enc.encode("streamed"));
      c.close();
    } });
    await p.store.put("tenant/a", stream);
    await p.store.put("tenant/b", "two");
    await p.store.put("other/a", "hidden");
    (0,__vite_ssr_import_0__.expect)(p.requests.find((x) => x.method === "PUT").init.body).toBe(stream);
    const one = await p.store.list({ prefix: "tenant/", limit: 1 });
    const two = await p.store.list({ prefix: "tenant/", limit: 1, cursor: one.cursor });
    (0,__vite_ssr_import_0__.expect)(one.objects.map((x) => x.key)).toEqual(["tenant/a"]);
    (0,__vite_ssr_import_0__.expect)(one.truncated).toBe(true);
    (0,__vite_ssr_import_0__.expect)(two.objects.map((x) => x.key)).toEqual(["tenant/b"]);
    (0,__vite_ssr_import_0__.expect)(two.truncated).toBe(false);
  });
});
(0,__vite_ssr_import_0__.describe)("GCS multipart generation and retry integrity", () => {
  (0,__vite_ssr_import_0__.it)("resumes the same upload and preserves exact ordered bytes and metadata", async () => {
    const p = provider();
    const upload = await p.store.createMultipartUpload("bundle", { customMetadata: { sha256: "admitted", visibility: "private" } });
    const first = await upload.uploadPart(1, "abc");
    const resumed = p.store.resumeMultipartUpload("bundle", upload.uploadId);
    const second = await resumed.uploadPart(2, "def");
    await resumed.complete([first, second]);
    (0,__vite_ssr_import_0__.expect)(await (await p.store.get("bundle")).text()).toBe("abcdef");
    (0,__vite_ssr_import_0__.expect)((await p.store.head("bundle")).customMetadata.visibility).toBe("private");
    (0,__vite_ssr_import_0__.expect)((await p.store.head("bundle")).customMetadata.gcsUploadId).toBe(upload.uploadId);
  });
  (0,__vite_ssr_import_0__.it)("reconciles a lost completion response without composing or replacing again", async () => {
    const p = provider();
    const upload = await p.store.createMultipartUpload("bundle");
    const part = await upload.uploadPart(1, "signed bytes");
    p.loseNextCommitResponse();
    await (0,__vite_ssr_import_0__.expect)(upload.complete([part])).rejects.toThrow("response lost");
    const generation = p.objects.get("bundle").generation;
    (0,__vite_ssr_import_0__.expect)((await p.store.resumeMultipartUpload("bundle", upload.uploadId).complete([part])).version).toBe(generation);
    (0,__vite_ssr_import_0__.expect)(p.requests.filter((x) => x.url.pathname.endsWith("/compose"))).toHaveLength(1);
  });
  (0,__vite_ssr_import_0__.it)("refuses replacement of an occupied destination and mismatched tenant sessions", async () => {
    const p = provider();
    const upload = await p.store.createMultipartUpload("tenant/bundle");
    const part = await upload.uploadPart(1, "new");
    p.seed("tenant/bundle", "retained");
    await (0,__vite_ssr_import_0__.expect)(upload.complete([part])).rejects.toMatchObject({ code: 412 });
    (0,__vite_ssr_import_0__.expect)(await (await p.store.get("tenant/bundle")).text()).toBe("retained");
    await (0,__vite_ssr_import_0__.expect)(p.store.resumeMultipartUpload("other/bundle", upload.uploadId).uploadPart(2, "x")).rejects.toThrow("does not match");
  });
  (0,__vite_ssr_import_0__.it)("rejects stale part generations and reordered/duplicate receipts", async () => {
    const p = provider();
    const upload = await p.store.createMultipartUpload("bundle");
    const first = await upload.uploadPart(1, "old");
    await upload.uploadPart(1, "different");
    await (0,__vite_ssr_import_0__.expect)(upload.complete([first])).rejects.toMatchObject({ code: 404 });
    await (0,__vite_ssr_import_0__.expect)(upload.complete([first, first])).rejects.toThrow("invalid multipart receipts");
    (0,__vite_ssr_import_0__.expect)(await p.store.head("bundle")).toBeNull();
  });
  (0,__vite_ssr_import_0__.it)("composes more than 32 parts in bounded generation-pinned stages", async () => {
    const p = provider();
    const upload = await p.store.createMultipartUpload("bundle");
    const parts = [];
    for (let n = 1; n <= 65; n++) parts.push(await upload.uploadPart(n, String(n) + ","));
    await upload.complete(parts);
    (0,__vite_ssr_import_0__.expect)(await (await p.store.get("bundle")).text()).toBe(Array.from({ length: 65 }, (_, i) => `${i + 1},`).join(""));
    (0,__vite_ssr_import_0__.expect)(p.requests.filter((x) => x.url.pathname.endsWith("/compose"))).toHaveLength(4);
  });
  (0,__vite_ssr_import_0__.it)("aborts only that session, preserving published and unrelated tenant objects", async () => {
    const p = provider();
    p.seed("other/object", "private");
    const upload = await p.store.createMultipartUpload("bundle");
    const part = await upload.uploadPart(1, "published");
    await upload.complete([part]);
    await upload.abort();
    (0,__vite_ssr_import_0__.expect)([...p.objects.keys()].sort()).toEqual(["bundle", "other/object"]);
    await (0,__vite_ssr_import_0__.expect)(upload.uploadPart(2, "late")).rejects.toThrow("session missing");
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QSxFQUNwRixDQUFDO0FBRUQsK0JBQUcsK0VBQStFLFlBQVk7QUFDNUYsVUFBTSxJQUFJLFNBQVM7QUFBRyxNQUFFLEtBQUssZ0JBQWdCLFNBQVM7QUFBRyxVQUFNLFNBQVMsTUFBTSxFQUFFLE1BQU0sc0JBQXNCLFFBQVE7QUFDcEgsVUFBTSxPQUFPLE1BQU0sT0FBTyxXQUFXLEdBQUcsV0FBVztBQUFHLFVBQU0sT0FBTyxTQUFTLENBQUMsSUFBSSxDQUFDO0FBQUcsVUFBTSxPQUFPLE1BQU07QUFDeEcscUNBQU8sQ0FBQyxHQUFHLEVBQUUsUUFBUSxLQUFLLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxRQUFRLENBQUMsVUFBVSxjQUFjLENBQUM7QUFDdkUsYUFBTSw4QkFBTyxPQUFPLFdBQVcsR0FBRyxNQUFNLENBQUMsRUFBRSxRQUFRLFFBQVEsaUJBQWlCO0FBQUEsRUFDOUUsQ0FBQztBQUNILENBQUMiLCJuYW1lcyI6WyJvIiwia2V5Il0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbImdjcy1vYmplY3Qtc3RvcmUudGVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBkZXNjcmliZSwgZXhwZWN0LCBpdCB9IGZyb20gJ3ZpdGVzdCc7XG5pbXBvcnQgeyBnY3NPYmplY3RTdG9yZSwgR2NzU3RvcmFnZUVycm9yIH0gZnJvbSAnLi9nY3Mtb2JqZWN0LXN0b3JlLmpzJztcbmltcG9ydCB7IHNoYTI1NkhleCB9IGZyb20gJy4vY29udGVudC1hZGRyZXNzLmpzJztcbmltcG9ydCB7IG9iamVjdFN0b3JlQXNCbG9iU3RvcmUgfSBmcm9tICcuL29iamVjdC1zdG9yZS5qcyc7XG5pbXBvcnQgeyBwdXRDb250ZW50QWRkcmVzc2VkIH0gZnJvbSAnLi9ibG9iLXN0b3JlLmpzJztcbmltcG9ydCB7IGNvbnRlbnRBZGRyZXNzaW5nIH0gZnJvbSAnLi9jb250ZW50LWFkZHJlc3MuanMnO1xuXG5jb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcbmZ1bmN0aW9uIHByb3ZpZGVyKCkge1xuICB0eXBlIFN0b3JlZCA9IHsgYnl0ZXM6IFVpbnQ4QXJyYXk7IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgZ2VuZXJhdGlvbjogc3RyaW5nIH07XG4gIGNvbnN0IG9iamVjdHMgPSBuZXcgTWFwPHN0cmluZywgU3RvcmVkPigpO1xuICBjb25zdCB1cGxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIHsga2V5OiBzdHJpbmc7IG1ldGFkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgY29uZGl0aW9uOiBzdHJpbmcgfCBudWxsIH0+KCk7XG4gIGNvbnN0IHJlcXVlc3RzOiB7IHVybDogVVJMOyBtZXRob2Q6IHN0cmluZzsgaW5pdDogUmVxdWVzdEluaXQgfVtdID0gW107XG4gIGxldCBnZW5lcmF0aW9uID0gMTAwO1xuICBsZXQgZGVuaWVkID0gZmFsc2U7XG4gIGxldCBsb3NlUmVzcG9uc2UgPSBmYWxzZTtcbiAgbGV0IHZhbmlzaEJlZm9yZU1lZGlhID0gZmFsc2U7XG4gIGxldCBiZWZvcmVVcGxvYWRDb21taXQ6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgY29uc3QganNvbiA9ICh4OiB1bmtub3duLCBzdGF0dXMgPSAyMDApID0+IG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh4KSwgeyBzdGF0dXMsIGhlYWRlcnM6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9IH0pO1xuICBjb25zdCBkZXNjcmliZU9iamVjdCA9IChrZXk6IHN0cmluZywgbzogU3RvcmVkKSA9PiAoeyBuYW1lOiBrZXksIHNpemU6IFN0cmluZyhvLmJ5dGVzLmxlbmd0aCksIGdlbmVyYXRpb246IG8uZ2VuZXJhdGlvbiwgdXBkYXRlZDogJzIwMjYtMTAtMjRUMDA6MDA6MDBaJywgLi4uby5tZXRhZGF0YSB9KTtcbiAgZnVuY3Rpb24gc2VlZChrZXk6IHN0cmluZywgYm9keTogc3RyaW5nIHwgVWludDhBcnJheSwgbWV0YWRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pIHtcbiAgICBjb25zdCBvYmplY3QgPSB7IGJ5dGVzOiB0eXBlb2YgYm9keSA9PT0gJ3N0cmluZycgPyBlbmMuZW5jb2RlKGJvZHkpIDogYm9keSwgbWV0YWRhdGEsIGdlbmVyYXRpb246IFN0cmluZygrK2dlbmVyYXRpb24pIH07XG4gICAgb2JqZWN0cy5zZXQoa2V5LCBvYmplY3QpOyByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGNvbnN0IGZldGNoSW1wbCA9IChhc3luYyAoaW5wdXQ6IFJlcXVlc3RJbmZvIHwgVVJMLCBpbml0OiBSZXF1ZXN0SW5pdCA9IHt9KSA9PiB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChTdHJpbmcoaW5wdXQpKTtcbiAgICBjb25zdCBtZXRob2QgPSBpbml0Lm1ldGhvZCA/PyAnR0VUJztcbiAgICByZXF1ZXN0cy5wdXNoKHsgdXJsLCBtZXRob2QsIGluaXQgfSk7XG4gICAgZXhwZWN0KG5ldyBIZWFkZXJzKGluaXQuaGVhZGVycykuZ2V0KCdhdXRob3JpemF0aW9uJykpLnRvQmUoJ0JlYXJlciB0ZXN0LXRva2VuJyk7XG4gICAgaWYgKGRlbmllZCkgcmV0dXJuIGpzb24oeyBlcnJvcjogJ2RlbmllZCcgfSwgNDAzKTtcbiAgICBjb25zdCBpZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCd1cGxvYWRfaWQnKTtcbiAgICBpZiAoaWQgJiYgbWV0aG9kID09PSAnUFVUJykge1xuICAgICAgY29uc3QgdXBsb2FkID0gdXBsb2Fkcy5nZXQoaWQpITtcbiAgICAgIGJlZm9yZVVwbG9hZENvbW1pdD8uKCk7IGJlZm9yZVVwbG9hZENvbW1pdCA9IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gb2JqZWN0cy5nZXQodXBsb2FkLmtleSk7XG4gICAgICBpZiAodXBsb2FkLmNvbmRpdGlvbiA9PT0gJzAnID8gQm9vbGVhbihleGlzdGluZykgOiB1cGxvYWQuY29uZGl0aW9uICYmIGV4aXN0aW5nPy5nZW5lcmF0aW9uICE9PSB1cGxvYWQuY29uZGl0aW9uKSByZXR1cm4ganNvbih7fSwgNDEyKTtcbiAgICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgbmV3IFJlc3BvbnNlKGluaXQuYm9keSkuYXJyYXlCdWZmZXIoKSk7XG4gICAgICBjb25zdCBvID0gc2VlZCh1cGxvYWQua2V5LCBieXRlcywgdXBsb2FkLm1ldGFkYXRhKTtcbiAgICAgIGlmIChsb3NlUmVzcG9uc2UpIHsgbG9zZVJlc3BvbnNlID0gZmFsc2U7IHRocm93IG5ldyBFcnJvcigncmVzcG9uc2UgbG9zdCBhZnRlciBwcm92aWRlciBjb21taXQnKTsgfVxuICAgICAgcmV0dXJuIGpzb24oZGVzY3JpYmVPYmplY3QodXBsb2FkLmtleSwgbykpO1xuICAgIH1cbiAgICBpZiAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3VwbG9hZFR5cGUnKSA9PT0gJ3Jlc3VtYWJsZScpIHtcbiAgICAgIGNvbnN0IGtleSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCduYW1lJykhO1xuICAgICAgY29uc3QgdXBsb2FkSWQgPSBTdHJpbmcodXBsb2Fkcy5zaXplICsgMSk7XG4gICAgICB1cGxvYWRzLnNldCh1cGxvYWRJZCwgeyBrZXksIG1ldGFkYXRhOiBKU09OLnBhcnNlKFN0cmluZyhpbml0LmJvZHkpKSwgY29uZGl0aW9uOiB1cmwuc2VhcmNoUGFyYW1zLmdldCgnaWZHZW5lcmF0aW9uTWF0Y2gnKSB9KTtcbiAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UobnVsbCwgeyBzdGF0dXM6IDIwMCwgaGVhZGVyczogeyBsb2NhdGlvbjogYGh0dHBzOi8vc3RvcmFnZS5nb29nbGVhcGlzLmNvbS91cGxvYWQvc3RvcmFnZS92MS9iL3Rlc3QtYnVja2V0L28/dXBsb2FkX2lkPSR7dXBsb2FkSWR9YCB9IH0pO1xuICAgIH1cbiAgICBjb25zdCBtYXJrZXIgPSAnL3N0b3JhZ2UvdjEvYi90ZXN0LWJ1Y2tldC9vJztcbiAgICBjb25zdCBjb21wb3NlID0gdXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvY29tcG9zZScpO1xuICAgIGNvbnN0IGtleSA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UobWFya2VyLmxlbmd0aCArIDEsIGNvbXBvc2UgPyAtOCA6IHVuZGVmaW5lZCkpO1xuICAgIGlmIChjb21wb3NlICYmIG1ldGhvZCA9PT0gJ1BPU1QnKSB7XG4gICAgICBpZiAob2JqZWN0cy5oYXMoa2V5KSAmJiB1cmwuc2VhcmNoUGFyYW1zLmdldCgnaWZHZW5lcmF0aW9uTWF0Y2gnKSA9PT0gJzAnKSByZXR1cm4ganNvbih7fSwgNDEyKTtcbiAgICAgIGNvbnN0IGIgPSBKU09OLnBhcnNlKFN0cmluZyhpbml0LmJvZHkpKTtcbiAgICAgIGNvbnN0IHNvdXJjZXMgPSBiLnNvdXJjZU9iamVjdHMubWFwKChzOiB7IG5hbWU6IHN0cmluZzsgZ2VuZXJhdGlvbjogc3RyaW5nIH0pID0+IHtcbiAgICAgICAgY29uc3QgbyA9IG9iamVjdHMuZ2V0KHMubmFtZSk7IHJldHVybiBvPy5nZW5lcmF0aW9uID09PSBzLmdlbmVyYXRpb24gPyBvIDogbnVsbDtcbiAgICAgIH0pO1xuICAgICAgaWYgKHNvdXJjZXMuc29tZSgoeDogU3RvcmVkIHwgbnVsbCkgPT4gIXgpKSByZXR1cm4ganNvbih7fSwgNDA0KTtcbiAgICAgIGV4cGVjdChzb3VyY2VzLmxlbmd0aCkudG9CZUxlc3NUaGFuT3JFcXVhbCgzMik7XG4gICAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KHNvdXJjZXMucmVkdWNlKChuOiBudW1iZXIsIHg6IFN0b3JlZCkgPT4gbiArIHguYnl0ZXMubGVuZ3RoLCAwKSk7XG4gICAgICBsZXQgb2Zmc2V0ID0gMDsgZm9yIChjb25zdCBvIG9mIHNvdXJjZXMgYXMgU3RvcmVkW10pIHsgYnl0ZXMuc2V0KG8uYnl0ZXMsIG9mZnNldCk7IG9mZnNldCArPSBvLmJ5dGVzLmxlbmd0aDsgfVxuICAgICAgY29uc3QgcmVzdWx0ID0gc2VlZChrZXksIGJ5dGVzLCBiLmRlc3RpbmF0aW9uKTtcbiAgICAgIGlmIChsb3NlUmVzcG9uc2UpIHsgbG9zZVJlc3BvbnNlID0gZmFsc2U7IHRocm93IG5ldyBFcnJvcigncmVzcG9uc2UgbG9zdCBhZnRlciBwcm92aWRlciBjb21taXQnKTsgfVxuICAgICAgcmV0dXJuIGpzb24oZGVzY3JpYmVPYmplY3Qoa2V5LCByZXN1bHQpKTtcbiAgICB9XG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gbWFya2VyICYmIG1ldGhvZCA9PT0gJ0dFVCcpIHtcbiAgICAgIGNvbnN0IGtleXMgPSBbLi4ub2JqZWN0cy5rZXlzKCldLmZpbHRlcihrID0+IGsuc3RhcnRzV2l0aCh1cmwuc2VhcmNoUGFyYW1zLmdldCgncHJlZml4JykgPz8gJycpKS5zb3J0KCk7XG4gICAgICBjb25zdCBvZmZzZXQgPSBOdW1iZXIodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhZ2VUb2tlbicpID8/IDApO1xuICAgICAgY29uc3QgbGltaXQgPSBOdW1iZXIodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ21heFJlc3VsdHMnKSk7XG4gICAgICByZXR1cm4ganNvbih7IGl0ZW1zOiBrZXlzLnNsaWNlKG9mZnNldCwgb2Zmc2V0ICsgbGltaXQpLm1hcChrID0+IGRlc2NyaWJlT2JqZWN0KGssIG9iamVjdHMuZ2V0KGspISkpLFxuICAgICAgICAuLi4ob2Zmc2V0ICsgbGltaXQgPCBrZXlzLmxlbmd0aCA/IHsgbmV4dFBhZ2VUb2tlbjogU3RyaW5nKG9mZnNldCArIGxpbWl0KSB9IDoge30pIH0pO1xuICAgIH1cbiAgICBpZiAobWV0aG9kID09PSAnREVMRVRFJykgeyBvYmplY3RzLmRlbGV0ZShrZXkpOyByZXR1cm4gbmV3IFJlc3BvbnNlKG51bGwsIHsgc3RhdHVzOiAyMDQgfSk7IH1cbiAgICBjb25zdCBvID0gb2JqZWN0cy5nZXQoa2V5KTtcbiAgICBpZiAoIW8pIHJldHVybiBqc29uKHt9LCA0MDQpO1xuICAgIGlmICh1cmwuc2VhcmNoUGFyYW1zLmdldCgnYWx0JykgPT09ICdtZWRpYScpIHtcbiAgICAgIGlmICh2YW5pc2hCZWZvcmVNZWRpYSB8fCB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZ2VuZXJhdGlvbicpICE9PSBvLmdlbmVyYXRpb24pIHJldHVybiBqc29uKHt9LCA0MDQpO1xuICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShuZXcgVWludDhBcnJheShvLmJ5dGVzKS5idWZmZXIpO1xuICAgIH1cbiAgICByZXR1cm4ganNvbihkZXNjcmliZU9iamVjdChrZXksIG8pKTtcbiAgfSkgYXMgdHlwZW9mIGZldGNoO1xuICBjb25zdCBzdG9yZSA9IGdjc09iamVjdFN0b3JlKHsgYnVja2V0OiAndGVzdC1idWNrZXQnLCBhY2Nlc3NUb2tlbjogYXN5bmMgKCkgPT4gJ3Rlc3QtdG9rZW4nLCBmZXRjaEltcGwgfSk7XG4gIHJldHVybiB7IHN0b3JlLCBvYmplY3RzLCByZXF1ZXN0cywgc2VlZCwgc2V0RGVuaWVkOiAoKSA9PiB7IGRlbmllZCA9IHRydWU7IH0sXG4gICAgbG9zZU5leHRDb21taXRSZXNwb25zZTogKCkgPT4geyBsb3NlUmVzcG9uc2UgPSB0cnVlOyB9LCB2YW5pc2hCZWZvcmVNZWRpYTogKCkgPT4geyB2YW5pc2hCZWZvcmVNZWRpYSA9IHRydWU7IH0sXG4gICAgYmVmb3JlVXBsb2FkQ29tbWl0OiAoZjogKCkgPT4gdm9pZCkgPT4geyBiZWZvcmVVcGxvYWRDb21taXQgPSBmOyB9IH07XG59XG5cbmRlc2NyaWJlKCdwcml2YXRlIEdDUyBvYmplY3Qgc3RvcmFnZSBwb3J0JywgKCkgPT4ge1xuICBpdCgncHJlc2VydmVzIGV4YWN0IGJ5dGVzLCBjdXN0b20vSFRUUCBtZXRhZGF0YSBhbmQgZ2VuZXJhdGlvbi1waW5uZWQgcmVhZHMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcCA9IHByb3ZpZGVyKCk7XG4gICAgY29uc3QgYnl0ZXMgPSBlbmMuZW5jb2RlKCdwcml2YXRlIGNyZWF0b3IgYnl0ZXMnKTtcbiAgICBjb25zdCBvYmplY3QgPSBhd2FpdCBwLnN0b3JlLnB1dCgndGVuYW50L3ByaXZhdGUuYmluJywgYnl0ZXMsIHtcbiAgICAgIHNoYTI1NjogYXdhaXQgc2hhMjU2SGV4KGJ5dGVzKSwgY3VzdG9tTWV0YWRhdGE6IHsgdmlzaWJpbGl0eTogJ3ByaXZhdGUnLCB0ZW5hbnQ6ICdvbmUnIH0sXG4gICAgICBodHRwTWV0YWRhdGE6IHsgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nLCBjYWNoZUNvbnRyb2w6ICdwcml2YXRlJyB9LFxuICAgIH0pO1xuICAgIGNvbnN0IHJlYWQgPSBhd2FpdCBwLnN0b3JlLmdldCgndGVuYW50L3ByaXZhdGUuYmluJyk7XG4gICAgZXhwZWN0KG5ldyBVaW50OEFycmF5KGF3YWl0IHJlYWQhLmFycmF5QnVmZmVyKCkpKS50b0VxdWFsKGJ5dGVzKTtcbiAgICBleHBlY3QocmVhZCEuY3VzdG9tTWV0YWRhdGEpLnRvRXF1YWwoeyB2aXNpYmlsaXR5OiAncHJpdmF0ZScsIHRlbmFudDogJ29uZScgfSk7XG4gICAgY29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKCk7IHJlYWQhLndyaXRlSHR0cE1ldGFkYXRhKGhlYWRlcnMpO1xuICAgIGV4cGVjdChoZWFkZXJzLmdldCgnY2FjaGUtY29udHJvbCcpKS50b0JlKCdwcml2YXRlJyk7XG4gICAgZXhwZWN0KHAucmVxdWVzdHMuZmluZCh4ID0+IHgudXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2FsdCcpID09PSAnbWVkaWEnKSEudXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2dlbmVyYXRpb24nKSkudG9CZShvYmplY3QhLnZlcnNpb24pO1xuICB9KTtcblxuICBpdCgncmV0YWlucyB0aGUgZXhpc3RpbmcgaGFzaC12ZXJpZnlpbmcgQmxvYlN0b3JlIHNlYW0nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcCA9IHByb3ZpZGVyKCk7IGNvbnN0IGJ5dGVzID0gZW5jLmVuY29kZSgncmVnaXN0cnkgYXJ0aWZhY3QnKTsgY29uc3QgaGFzaCA9IGF3YWl0IHNoYTI1NkhleChieXRlcyk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcHV0Q29udGVudEFkZHJlc3NlZChvYmplY3RTdG9yZUFzQmxvYlN0b3JlKHAuc3RvcmUpLCB7XG4gICAgICBoYXNoLCBzY2hlbWU6IGNvbnRlbnRBZGRyZXNzaW5nKHsgcHJlZml4OiAncmVnaXN0cnknLCBleHQ6ICcudGd6JyB9KSwgcmVhZEJvZHk6IGFzeW5jICgpID0+IGJ5dGVzLmJ1ZmZlciwgbWF4Qnl0ZXM6IDEwMCxcbiAgICB9KTtcbiAgICBleHBlY3QocmVzdWx0KS50b01hdGNoT2JqZWN0KHsgb2s6IHRydWUsIGRlZHVwZWQ6IGZhbHNlIH0pO1xuICAgIGV4cGVjdChwLm9iamVjdHMuZ2V0KGByZWdpc3RyeS8ke2hhc2h9LnRnemApIS5ieXRlcykudG9FcXVhbChieXRlcyk7XG4gIH0pO1xuXG4gIGl0KCdyZWZ1c2VzIGEgd3JvbmcgU0hBMjU2IGJlZm9yZSBzZW5kaW5nIGJ5dGVzIHRvIHRoZSBwcm92aWRlcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTtcbiAgICBhd2FpdCBleHBlY3QocC5zdG9yZS5wdXQoJ2JhZCcsICd3cm9uZycsIHsgc2hhMjU2OiAnMCcucmVwZWF0KDY0KSB9KSkucmVqZWN0cy50b1Rocm93KCdzaGFfbWlzbWF0Y2gnKTtcbiAgICBleHBlY3QocC5yZXF1ZXN0cykudG9IYXZlTGVuZ3RoKDApO1xuICB9KTtcblxuICBpdCgnZmVuY2VzIGEgY3JlYXRlLW9ubHkgcmFjZSBhdCBjb21taXQgYW5kIHByZXNlcnZlcyBvY2N1cGllZCBieXRlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTtcbiAgICBwLmJlZm9yZVVwbG9hZENvbW1pdCgoKSA9PiB7IHAuc2VlZCgnb2NjdXBpZWQnLCAnZmlyc3Qtd3JpdGVyJyk7IH0pO1xuICAgIGV4cGVjdChhd2FpdCBwLnN0b3JlLnB1dCgnb2NjdXBpZWQnLCAnc2Vjb25kLXdyaXRlcicsIHsgb25seUlmOiB7IGV0YWdEb2VzTm90TWF0Y2g6ICcqJyB9IH0pKS50b0JlTnVsbCgpO1xuICAgIGV4cGVjdChhd2FpdCAoYXdhaXQgcC5zdG9yZS5nZXQoJ29jY3VwaWVkJykpIS50ZXh0KCkpLnRvQmUoJ2ZpcnN0LXdyaXRlcicpO1xuICB9KTtcblxuICBpdCgnZmVuY2VzIHN0YWxlIGNvbmRpdGlvbmFsIHVwZGF0ZXMgYnkgZ2VuZXJhdGlvbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTsgY29uc3QgZmlyc3QgPSBhd2FpdCBwLnN0b3JlLnB1dCgnc3RhdGUnLCAnb25lJyk7XG4gICAgYXdhaXQgcC5zdG9yZS5wdXQoJ3N0YXRlJywgJ3R3bycpO1xuICAgIGV4cGVjdChhd2FpdCBwLnN0b3JlLnB1dCgnc3RhdGUnLCAnc3RhbGUnLCB7IG9ubHlJZjogeyBldGFnTWF0Y2hlczogZmlyc3QhLmh0dHBFdGFnIH0gfSkpLnRvQmVOdWxsKCk7XG4gICAgZXhwZWN0KGF3YWl0IChhd2FpdCBwLnN0b3JlLmdldCgnc3RhdGUnKSkhLnRleHQoKSkudG9CZSgndHdvJyk7XG4gIH0pO1xuXG4gIGl0KCdkb2VzIG5vdCB0dXJuIHBlcm1pc3Npb24gb3IgcGlubmVkLWdlbmVyYXRpb24gZmFpbHVyZXMgaW50byBhYnNlbmNlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRlbmllZCA9IHByb3ZpZGVyKCk7IGRlbmllZC5zZXREZW5pZWQoKTtcbiAgICBhd2FpdCBleHBlY3QoZGVuaWVkLnN0b3JlLmhlYWQoJ3ByaXZhdGUnKSkucmVqZWN0cy50b01hdGNoT2JqZWN0KHsgY29kZTogNDAzIH0pO1xuICAgIGF3YWl0IGV4cGVjdChkZW5pZWQuc3RvcmUuZ2V0KCdwcml2YXRlJykpLnJlamVjdHMudG9CZUluc3RhbmNlT2YoR2NzU3RvcmFnZUVycm9yKTtcbiAgICBjb25zdCByYWNlZCA9IHByb3ZpZGVyKCk7IHJhY2VkLnNlZWQoJ3ByaXZhdGUnLCAneCcpOyByYWNlZC52YW5pc2hCZWZvcmVNZWRpYSgpO1xuICAgIGF3YWl0IGV4cGVjdChyYWNlZC5zdG9yZS5nZXQoJ3ByaXZhdGUnKSkucmVqZWN0cy50b01hdGNoT2JqZWN0KHsgY29kZTogNDA0IH0pO1xuICB9KTtcblxuICBpdCgnc3RyZWFtcyByZXF1ZXN0IGJ5dGVzIGFuZCBwYWdpbmF0ZXMgYSB0ZW5hbnQgcHJlZml4IHdpdGhvdXQgbGlzdGluZyBzaWJsaW5ncycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTtcbiAgICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW08VWludDhBcnJheT4oeyBzdGFydChjKSB7IGMuZW5xdWV1ZShlbmMuZW5jb2RlKCdzdHJlYW1lZCcpKTsgYy5jbG9zZSgpOyB9IH0pO1xuICAgIGF3YWl0IHAuc3RvcmUucHV0KCd0ZW5hbnQvYScsIHN0cmVhbSk7IGF3YWl0IHAuc3RvcmUucHV0KCd0ZW5hbnQvYicsICd0d28nKTsgYXdhaXQgcC5zdG9yZS5wdXQoJ290aGVyL2EnLCAnaGlkZGVuJyk7XG4gICAgZXhwZWN0KHAucmVxdWVzdHMuZmluZCh4ID0+IHgubWV0aG9kID09PSAnUFVUJykhLmluaXQuYm9keSkudG9CZShzdHJlYW0pO1xuICAgIGNvbnN0IG9uZSA9IGF3YWl0IHAuc3RvcmUubGlzdCh7IHByZWZpeDogJ3RlbmFudC8nLCBsaW1pdDogMSB9KTtcbiAgICBjb25zdCB0d28gPSBhd2FpdCBwLnN0b3JlLmxpc3QoeyBwcmVmaXg6ICd0ZW5hbnQvJywgbGltaXQ6IDEsIGN1cnNvcjogb25lLmN1cnNvciB9KTtcbiAgICBleHBlY3Qob25lLm9iamVjdHMubWFwKHggPT4geC5rZXkpKS50b0VxdWFsKFsndGVuYW50L2EnXSk7IGV4cGVjdChvbmUudHJ1bmNhdGVkKS50b0JlKHRydWUpO1xuICAgIGV4cGVjdCh0d28ub2JqZWN0cy5tYXAoeCA9PiB4LmtleSkpLnRvRXF1YWwoWyd0ZW5hbnQvYiddKTsgZXhwZWN0KHR3by50cnVuY2F0ZWQpLnRvQmUoZmFsc2UpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZSgnR0NTIG11bHRpcGFydCBnZW5lcmF0aW9uIGFuZCByZXRyeSBpbnRlZ3JpdHknLCAoKSA9PiB7XG4gIGl0KCdyZXN1bWVzIHRoZSBzYW1lIHVwbG9hZCBhbmQgcHJlc2VydmVzIGV4YWN0IG9yZGVyZWQgYnl0ZXMgYW5kIG1ldGFkYXRhJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHAgPSBwcm92aWRlcigpOyBjb25zdCB1cGxvYWQgPSBhd2FpdCBwLnN0b3JlLmNyZWF0ZU11bHRpcGFydFVwbG9hZCgnYnVuZGxlJywgeyBjdXN0b21NZXRhZGF0YTogeyBzaGEyNTY6ICdhZG1pdHRlZCcsIHZpc2liaWxpdHk6ICdwcml2YXRlJyB9IH0pO1xuICAgIGNvbnN0IGZpcnN0ID0gYXdhaXQgdXBsb2FkLnVwbG9hZFBhcnQoMSwgJ2FiYycpO1xuICAgIGNvbnN0IHJlc3VtZWQgPSBwLnN0b3JlLnJlc3VtZU11bHRpcGFydFVwbG9hZCgnYnVuZGxlJywgdXBsb2FkLnVwbG9hZElkKTtcbiAgICBjb25zdCBzZWNvbmQgPSBhd2FpdCByZXN1bWVkLnVwbG9hZFBhcnQoMiwgJ2RlZicpO1xuICAgIGF3YWl0IHJlc3VtZWQuY29tcGxldGUoW2ZpcnN0LCBzZWNvbmRdKTtcbiAgICBleHBlY3QoYXdhaXQgKGF3YWl0IHAuc3RvcmUuZ2V0KCdidW5kbGUnKSkhLnRleHQoKSkudG9CZSgnYWJjZGVmJyk7XG4gICAgZXhwZWN0KChhd2FpdCBwLnN0b3JlLmhlYWQoJ2J1bmRsZScpKSEuY3VzdG9tTWV0YWRhdGEudmlzaWJpbGl0eSkudG9CZSgncHJpdmF0ZScpO1xuICAgIGV4cGVjdCgoYXdhaXQgcC5zdG9yZS5oZWFkKCdidW5kbGUnKSkhLmN1c3RvbU1ldGFkYXRhLmdjc1VwbG9hZElkKS50b0JlKHVwbG9hZC51cGxvYWRJZCk7XG4gIH0pO1xuXG4gIGl0KCdyZWNvbmNpbGVzIGEgbG9zdCBjb21wbGV0aW9uIHJlc3BvbnNlIHdpdGhvdXQgY29tcG9zaW5nIG9yIHJlcGxhY2luZyBhZ2FpbicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTsgY29uc3QgdXBsb2FkID0gYXdhaXQgcC5zdG9yZS5jcmVhdGVNdWx0aXBhcnRVcGxvYWQoJ2J1bmRsZScpOyBjb25zdCBwYXJ0ID0gYXdhaXQgdXBsb2FkLnVwbG9hZFBhcnQoMSwgJ3NpZ25lZCBieXRlcycpO1xuICAgIHAubG9zZU5leHRDb21taXRSZXNwb25zZSgpOyBhd2FpdCBleHBlY3QodXBsb2FkLmNvbXBsZXRlKFtwYXJ0XSkpLnJlamVjdHMudG9UaHJvdygncmVzcG9uc2UgbG9zdCcpO1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBwLm9iamVjdHMuZ2V0KCdidW5kbGUnKSEuZ2VuZXJhdGlvbjtcbiAgICBleHBlY3QoKGF3YWl0IHAuc3RvcmUucmVzdW1lTXVsdGlwYXJ0VXBsb2FkKCdidW5kbGUnLCB1cGxvYWQudXBsb2FkSWQpLmNvbXBsZXRlKFtwYXJ0XSkpLnZlcnNpb24pLnRvQmUoZ2VuZXJhdGlvbik7XG4gICAgZXhwZWN0KHAucmVxdWVzdHMuZmlsdGVyKHggPT4geC51cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9jb21wb3NlJykpKS50b0hhdmVMZW5ndGgoMSk7XG4gIH0pO1xuXG4gIGl0KCdyZWZ1c2VzIHJlcGxhY2VtZW50IG9mIGFuIG9jY3VwaWVkIGRlc3RpbmF0aW9uIGFuZCBtaXNtYXRjaGVkIHRlbmFudCBzZXNzaW9ucycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTsgY29uc3QgdXBsb2FkID0gYXdhaXQgcC5zdG9yZS5jcmVhdGVNdWx0aXBhcnRVcGxvYWQoJ3RlbmFudC9idW5kbGUnKTsgY29uc3QgcGFydCA9IGF3YWl0IHVwbG9hZC51cGxvYWRQYXJ0KDEsICduZXcnKTtcbiAgICBwLnNlZWQoJ3RlbmFudC9idW5kbGUnLCAncmV0YWluZWQnKTtcbiAgICBhd2FpdCBleHBlY3QodXBsb2FkLmNvbXBsZXRlKFtwYXJ0XSkpLnJlamVjdHMudG9NYXRjaE9iamVjdCh7IGNvZGU6IDQxMiB9KTtcbiAgICBleHBlY3QoYXdhaXQgKGF3YWl0IHAuc3RvcmUuZ2V0KCd0ZW5hbnQvYnVuZGxlJykpIS50ZXh0KCkpLnRvQmUoJ3JldGFpbmVkJyk7XG4gICAgYXdhaXQgZXhwZWN0KHAuc3RvcmUucmVzdW1lTXVsdGlwYXJ0VXBsb2FkKCdvdGhlci9idW5kbGUnLCB1cGxvYWQudXBsb2FkSWQpLnVwbG9hZFBhcnQoMiwgJ3gnKSkucmVqZWN0cy50b1Rocm93KCdkb2VzIG5vdCBtYXRjaCcpO1xuICB9KTtcblxuICBpdCgncmVqZWN0cyBzdGFsZSBwYXJ0IGdlbmVyYXRpb25zIGFuZCByZW9yZGVyZWQvZHVwbGljYXRlIHJlY2VpcHRzJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHAgPSBwcm92aWRlcigpOyBjb25zdCB1cGxvYWQgPSBhd2FpdCBwLnN0b3JlLmNyZWF0ZU11bHRpcGFydFVwbG9hZCgnYnVuZGxlJyk7IGNvbnN0IGZpcnN0ID0gYXdhaXQgdXBsb2FkLnVwbG9hZFBhcnQoMSwgJ29sZCcpO1xuICAgIGF3YWl0IHVwbG9hZC51cGxvYWRQYXJ0KDEsICdkaWZmZXJlbnQnKTtcbiAgICBhd2FpdCBleHBlY3QodXBsb2FkLmNvbXBsZXRlKFtmaXJzdF0pKS5yZWplY3RzLnRvTWF0Y2hPYmplY3QoeyBjb2RlOiA0MDQgfSk7XG4gICAgYXdhaXQgZXhwZWN0KHVwbG9hZC5jb21wbGV0ZShbZmlyc3QsIGZpcnN0XSkpLnJlamVjdHMudG9UaHJvdygnaW52YWxpZCBtdWx0aXBhcnQgcmVjZWlwdHMnKTtcbiAgICBleHBlY3QoYXdhaXQgcC5zdG9yZS5oZWFkKCdidW5kbGUnKSkudG9CZU51bGwoKTtcbiAgfSk7XG5cbiAgaXQoJ2NvbXBvc2VzIG1vcmUgdGhhbiAzMiBwYXJ0cyBpbiBib3VuZGVkIGdlbmVyYXRpb24tcGlubmVkIHN0YWdlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTsgY29uc3QgdXBsb2FkID0gYXdhaXQgcC5zdG9yZS5jcmVhdGVNdWx0aXBhcnRVcGxvYWQoJ2J1bmRsZScpOyBjb25zdCBwYXJ0cyA9IFtdO1xuICAgIGZvciAobGV0IG4gPSAxOyBuIDw9IDY1OyBuKyspIHBhcnRzLnB1c2goYXdhaXQgdXBsb2FkLnVwbG9hZFBhcnQobiwgU3RyaW5nKG4pICsgJywnKSk7XG4gICAgYXdhaXQgdXBsb2FkLmNvbXBsZXRlKHBhcnRzKTtcbiAgICBleHBlY3QoYXdhaXQgKGF3YWl0IHAuc3RvcmUuZ2V0KCdidW5kbGUnKSkhLnRleHQoKSkudG9CZShBcnJheS5mcm9tKHsgbGVuZ3RoOiA2NSB9LCAoXywgaSkgPT4gYCR7aSArIDF9LGApLmpvaW4oJycpKTtcbiAgICBleHBlY3QocC5yZXF1ZXN0cy5maWx0ZXIoeCA9PiB4LnVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2NvbXBvc2UnKSkpLnRvSGF2ZUxlbmd0aCg0KTtcbiAgfSk7XG5cbiAgaXQoJ2Fib3J0cyBvbmx5IHRoYXQgc2Vzc2lvbiwgcHJlc2VydmluZyBwdWJsaXNoZWQgYW5kIHVucmVsYXRlZCB0ZW5hbnQgb2JqZWN0cycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwID0gcHJvdmlkZXIoKTsgcC5zZWVkKCdvdGhlci9vYmplY3QnLCAncHJpdmF0ZScpOyBjb25zdCB1cGxvYWQgPSBhd2FpdCBwLnN0b3JlLmNyZWF0ZU11bHRpcGFydFVwbG9hZCgnYnVuZGxlJyk7XG4gICAgY29uc3QgcGFydCA9IGF3YWl0IHVwbG9hZC51cGxvYWRQYXJ0KDEsICdwdWJsaXNoZWQnKTsgYXdhaXQgdXBsb2FkLmNvbXBsZXRlKFtwYXJ0XSk7IGF3YWl0IHVwbG9hZC5hYm9ydCgpO1xuICAgIGV4cGVjdChbLi4ucC5vYmplY3RzLmtleXMoKV0uc29ydCgpKS50b0VxdWFsKFsnYnVuZGxlJywgJ290aGVyL29iamVjdCddKTtcbiAgICBhd2FpdCBleHBlY3QodXBsb2FkLnVwbG9hZFBhcnQoMiwgJ2xhdGUnKSkucmVqZWN0cy50b1Rocm93KCdzZXNzaW9uIG1pc3NpbmcnKTtcbiAgfSk7XG59KTtcbiJdLCJmaWxlIjoiL3NyYy9nY3Mtb2JqZWN0LXN0b3JlLnRlc3QudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2FydGlmYWN0LXJlZ2lzdHJ5L3NyYy9nY3Mtb2JqZWN0LXN0b3JlLnRlc3QudHMiLCIvc3JjL2djcy1vYmplY3Qtc3RvcmUudGVzdC50cyIsW11d
}}