'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("GcsStorageError", () => { try { return GcsStorageError } catch {} });
__vite_ssr_exportName__("gcsObjectStore", () => { try { return gcsObjectStore } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/artifact-registry/src/content-address.ts", {"importedNames":["sha256Hex"]});

const UPLOADS = "__artifact_uploads/";
const HTTP_FIELDS = ["contentType", "cacheControl", "contentDisposition", "contentEncoding", "contentLanguage"];
const HTTP_HEADERS = ["content-type", "cache-control", "content-disposition", "content-encoding", "content-language"];
class GcsStorageError extends Error {
  constructor(code, operation) {
    super(`GCS ${operation} failed (HTTP ${code})`);
    this.code = code;
    this.name = "GcsStorageError";
  }
};
function gcsObjectStore(config) {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) throw new Error("invalid GCS bucket");
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o`;
  const objectUrl = (key) => `${base}/${encodeURIComponent(key)}`;
  const uploadBase = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o`;
  async function request(url, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await config.accessToken()}`);
    return fetchImpl(url, { ...init, headers });
  }
  async function readMetadata(key) {
    const r = await request(objectUrl(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new GcsStorageError(r.status, "metadata read");
    return r.json();
  }
  function metadata(x) {
    const size = Number(x.size);
    if (!Number.isSafeInteger(size) || size < 0 || !/^\d+$/.test(x.generation)) throw new Error("invalid GCS object metadata");
    const httpMetadata = {};
    HTTP_FIELDS.forEach((k) => {
      if (x[k] !== void 0) httpMetadata[k] = x[k];
    });
    return {
      key: x.name,
      size,
      version: x.generation,
      etag: x.generation,
      httpEtag: `"${x.generation}"`,
      uploaded: new Date(x.updated ?? 0),
      customMetadata: x.metadata ?? {},
      httpMetadata,
      writeHttpMetadata(headers) {
        HTTP_FIELDS.forEach((k, i) => {
          if (httpMetadata[k] !== void 0) headers.set(HTTP_HEADERS[i], httpMetadata[k]);
        });
      }
    };
  }
  function uploadMetadata(options) {
    return { ...Object.fromEntries(HTTP_FIELDS.filter((k) => options.httpMetadata?.[k] !== void 0).map((k) => [k, options.httpMetadata[k]])), metadata: options.customMetadata ?? {} };
  }
  async function generationCondition(key, options) {
    const condition = options.onlyIf;
    if (!condition || Object.keys(condition).length === 0) return void 0;
    if (condition.etagDoesNotMatch === "*" && condition.etagMatches === void 0) return "0";
    if (condition.etagMatches !== void 0 && condition.etagDoesNotMatch === void 0) {
      const expected = condition.etagMatches.replace(/^"|"$/g, "");
      if (!/^\d+$/.test(expected)) throw new Error("invalid generation condition");
      const current = await readMetadata(key);
      return current?.generation === expected ? expected : null;
    };
    throw new Error("unsupported object precondition");
  }
  const store = {
    async head(key) {
      const x = await readMetadata(key);
      return x ? metadata(x) : null;
    },
    async get(key) {
      const x = await readMetadata(key);
      if (!x) return null;
      const url = new URL(objectUrl(key));
      url.searchParams.set("alt", "media");
      url.searchParams.set("generation", x.generation);
      const r = await request(url.href);
      if (!r.ok || !r.body) throw new GcsStorageError(r.status, "generation-pinned read");
      return { ...metadata(x), body: r.body, arrayBuffer: () => r.arrayBuffer(), text: () => r.text(), json: () => r.json() };
    },
    async put(key, body, options = {}) {
      if (options.sha256) {
        if (body instanceof ReadableStream) throw new Error("stream SHA256 must be verified by the upload protocol");
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Blob ? await body.arrayBuffer() : body;
        if (await (0,__vite_ssr_import_0__.sha256Hex)(bytes) !== options.sha256) throw new Error("sha_mismatch");
      };
      const condition = await generationCondition(key, options);
      if (condition === null) return null;
      const url = new URL(uploadBase);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("name", key);
      if (condition !== void 0) url.searchParams.set("ifGenerationMatch", condition);
      const begin = await request(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(uploadMetadata(options))
      });
      if (begin.status === 412) return null;
      if (!begin.ok) throw new GcsStorageError(begin.status, "upload initiation");
      const location = begin.headers.get("location");
      const destination = location ? new URL(location) : null;
      if (!destination || destination.origin !== "https://storage.googleapis.com" || !destination.pathname.startsWith("/upload/")) {
        throw new Error("invalid GCS upload destination");
      };
      const init = { method: "PUT", body };
      if (body instanceof ReadableStream) init.duplex = "half";
      const done = await request(destination.href, init);
      if (done.status === 412) return null;
      if (!done.ok) throw new GcsStorageError(done.status, "upload");
      return metadata(await done.json());
    },
    async delete(key) {
      const r = await request(objectUrl(key), { method: "DELETE" });
      if (r.status !== 404 && !r.ok) throw new GcsStorageError(r.status, "delete");
    },
    async list(options = {}) {
      const url = new URL(base);
      if (options.prefix !== void 0) url.searchParams.set("prefix", options.prefix);
      if (options.cursor !== void 0) url.searchParams.set("pageToken", options.cursor);
      url.searchParams.set("maxResults", String(Math.min(1e3, Math.max(1, options.limit ?? 1e3))));
      const r = await request(url.href);
      if (!r.ok) throw new GcsStorageError(r.status, "list");
      const page = await r.json();
      return { objects: (page.items ?? []).map(metadata), truncated: Boolean(page.nextPageToken), cursor: page.nextPageToken };
    },
    async createMultipartUpload(key, options = {}) {
      const uploadId = crypto.randomUUID();
      const session = await store.put(`${UPLOADS}${uploadId}/session`, JSON.stringify({ key, options }), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" }
      });
      if (!session) throw new Error("multipart session collision");
      return store.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error("invalid GCS multipart upload id");
      const prefix = `${UPLOADS}${uploadId}/`;
      async function session() {
        const object = await store.get(`${prefix}session`);
        if (!object || object.size > 64 * 1024) throw new Error("multipart session missing");
        const s = await object.json();
        if (s.key !== key || !s.options || typeof s.options !== "object") throw new Error("multipart session does not match destination");
        return s;
      }
      async function compose(destination, sources, options) {
        const url = new URL(`${objectUrl(destination)}/compose`);
        url.searchParams.set("ifGenerationMatch", "0");
        const r = await request(url.href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceObjects: sources, destination: uploadMetadata(options) })
        });
        if (r.status !== 412 && !r.ok) throw new GcsStorageError(r.status, "compose");
        if (r.status !== 412) return metadata(await r.json());
        const existing = await store.head(destination);
        if (!existing || existing.customMetadata.gcsUploadId !== uploadId || existing.customMetadata.gcsPartsHash !== options.customMetadata?.gcsPartsHash) {
          throw new GcsStorageError(412, "create-only compose");
        };
        return existing;
      }
      const upload = {
        key,
        uploadId,
        async uploadPart(partNumber, body) {
          await session();
          if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 1e4) throw new Error("invalid part number");
          const object = await store.put(`${prefix}part-${partNumber}`, body);
          if (!object) throw new Error("part upload failed");
          return { partNumber, etag: object.version };
        },
        async complete(parts) {
          const s = await session();
          if (!parts.length || parts.some((p, i) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > 1e4 || !/^\d+$/.test(p.etag) || i > 0 && parts[i - 1].partNumber >= p.partNumber)) throw new Error("invalid multipart receipts");
          const hash = await (0,__vite_ssr_import_0__.sha256Hex)(new TextEncoder().encode(JSON.stringify(parts)));
          const options = { ...s.options, customMetadata: { ...s.options.customMetadata, gcsUploadId: uploadId, gcsPartsHash: hash } };
          const existing = await store.head(key);
          if (existing) {
            if (existing.customMetadata.gcsUploadId === uploadId && existing.customMetadata.gcsPartsHash === hash) return existing;
            throw new GcsStorageError(412, "create-only multipart destination");
          };
          let sources = parts.map((p) => ({ name: `${prefix}part-${p.partNumber}`, generation: p.etag }));
          let level = 0;
          while (sources.length > 32) {
            const next = [];
            for (let i = 0; i < sources.length; i += 32) {
              const name = `${prefix}compose-${hash}-${level}-${i / 32}`;
              const object = await compose(name, sources.slice(i, i + 32), options);
              next.push({ name, generation: object.version });
            };
            sources = next;
            level++;
          };
          return compose(key, sources, options);
        },
        async abort() {
          await session();
          let cursor;
          do {
            const page = await store.list({ prefix, cursor });
            for (const object of page.objects) if (object.key !== `${prefix}session`) await store.delete(object.key);
            cursor = page.cursor;
          } while (cursor);
          await store.delete(`${prefix}session`);
        }
      };
      return upload;
    }
  };
  return store;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUNBLE1BQU0sUUFBUTtBQUNaLGdCQUFNLFFBQVE7QUFDZCxjQUFJO0FBQ0osYUFBRztBQUNELGtCQUFNLE9BQU8sTUFBTSxNQUFNLEtBQUssRUFBRSxRQUFRLE9BQU8sQ0FBQztBQUNoRCx1QkFBVyxVQUFVLEtBQUssUUFBUyxLQUFJLE9BQU8sUUFBUSxHQUFHLE1BQU0sVUFBVyxPQUFNLE1BQU0sT0FBTyxPQUFPLEdBQUc7QUFDdkcscUJBQVMsS0FBSztBQUFBLFVBQ2hCLFNBQVM7QUFDVCxnQkFBTSxNQUFNLE9BQU8sR0FBRyxNQUFNLFNBQVM7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1QiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbImdjcy1vYmplY3Qtc3RvcmUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgc2hhMjU2SGV4IH0gZnJvbSAnLi9jb250ZW50LWFkZHJlc3MuanMnO1xuaW1wb3J0IHR5cGUge1xuICBNdWx0aXBhcnRVcGxvYWQsIE9iamVjdEJvZHksIE9iamVjdElucHV0LCBPYmplY3RNZXRhZGF0YSwgT2JqZWN0UHV0T3B0aW9ucywgT2JqZWN0U3RvcmUsIFVwbG9hZGVkUGFydCxcbn0gZnJvbSAnLi9vYmplY3Qtc3RvcmUuanMnO1xuXG50eXBlIEdjc09iamVjdCA9IHtcbiAgbmFtZTogc3RyaW5nOyBzaXplOiBzdHJpbmc7IGdlbmVyYXRpb246IHN0cmluZzsgdXBkYXRlZD86IHN0cmluZztcbiAgbWV0YWRhdGE/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjb250ZW50VHlwZT86IHN0cmluZzsgY2FjaGVDb250cm9sPzogc3RyaW5nO1xuICBjb250ZW50RGlzcG9zaXRpb24/OiBzdHJpbmc7IGNvbnRlbnRFbmNvZGluZz86IHN0cmluZzsgY29udGVudExhbmd1YWdlPzogc3RyaW5nO1xufTtcbnR5cGUgU2Vzc2lvbiA9IHsga2V5OiBzdHJpbmc7IG9wdGlvbnM6IE9iamVjdFB1dE9wdGlvbnMgfTtcbmNvbnN0IFVQTE9BRFMgPSAnX19hcnRpZmFjdF91cGxvYWRzLyc7XG5jb25zdCBIVFRQX0ZJRUxEUyA9IFsnY29udGVudFR5cGUnLCAnY2FjaGVDb250cm9sJywgJ2NvbnRlbnREaXNwb3NpdGlvbicsICdjb250ZW50RW5jb2RpbmcnLCAnY29udGVudExhbmd1YWdlJ10gYXMgY29uc3Q7XG5jb25zdCBIVFRQX0hFQURFUlMgPSBbJ2NvbnRlbnQtdHlwZScsICdjYWNoZS1jb250cm9sJywgJ2NvbnRlbnQtZGlzcG9zaXRpb24nLCAnY29udGVudC1lbmNvZGluZycsICdjb250ZW50LWxhbmd1YWdlJ107XG5cbmV4cG9ydCBjbGFzcyBHY3NTdG9yYWdlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyByZWFkb25seSBjb2RlOiBudW1iZXIsIG9wZXJhdGlvbjogc3RyaW5nKSB7XG4gICAgLy8gUHJvdmlkZXIgYm9kaWVzIGNhbiBjb250YWluIGNyZWRlbnRpYWxzIG9yIHByaXZhdGUgb2JqZWN0IHBhdGhzLiBEbyBub3QgZWNobyB0aGVtLlxuICAgIHN1cGVyKGBHQ1MgJHtvcGVyYXRpb259IGZhaWxlZCAoSFRUUCAke2NvZGV9KWApO1xuICAgIHRoaXMubmFtZSA9ICdHY3NTdG9yYWdlRXJyb3InO1xuICB9XG59XG5cbi8qKiBQcml2YXRlIEdDUyBKU09OIEFQSSBiYWNrZW5kLiBBdXRoZW50aWNhdGlvbiBpcyBpbmplY3RlZDsgdGhpcyBhZGFwdGVyIG93bnMgYnl0ZXMgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnY3NPYmplY3RTdG9yZShjb25maWc6IHtcbiAgYnVja2V0OiBzdHJpbmc7XG4gIGFjY2Vzc1Rva2VuOiAoKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIGZldGNoSW1wbD86IHR5cGVvZiBmZXRjaDtcbn0pOiBPYmplY3RTdG9yZSB7XG4gIGlmICghL15bYS16MC05XVthLXowLTkuXy1dezEsMjIwfVthLXowLTldJC8udGVzdChjb25maWcuYnVja2V0KSkgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIEdDUyBidWNrZXQnKTtcbiAgY29uc3QgZmV0Y2hJbXBsID0gY29uZmlnLmZldGNoSW1wbCA/PyBmZXRjaDtcbiAgY29uc3QgYmFzZSA9IGBodHRwczovL3N0b3JhZ2UuZ29vZ2xlYXBpcy5jb20vc3RvcmFnZS92MS9iLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGNvbmZpZy5idWNrZXQpfS9vYDtcbiAgY29uc3Qgb2JqZWN0VXJsID0gKGtleTogc3RyaW5nKSA9PiBgJHtiYXNlfS8ke2VuY29kZVVSSUNvbXBvbmVudChrZXkpfWA7XG4gIGNvbnN0IHVwbG9hZEJhc2UgPSBgaHR0cHM6Ly9zdG9yYWdlLmdvb2dsZWFwaXMuY29tL3VwbG9hZC9zdG9yYWdlL3YxL2IvJHtlbmNvZGVVUklDb21wb25lbnQoY29uZmlnLmJ1Y2tldCl9L29gO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHJlcXVlc3QodXJsOiBzdHJpbmcsIGluaXQ6IFJlcXVlc3RJbml0ID0ge30pOiBQcm9taXNlPFJlc3BvbnNlPiB7XG4gICAgY29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKGluaXQuaGVhZGVycyk7XG4gICAgaGVhZGVycy5zZXQoJ2F1dGhvcml6YXRpb24nLCBgQmVhcmVyICR7YXdhaXQgY29uZmlnLmFjY2Vzc1Rva2VuKCl9YCk7XG4gICAgcmV0dXJuIGZldGNoSW1wbCh1cmwsIHsgLi4uaW5pdCwgaGVhZGVycyB9KTtcbiAgfVxuICBhc3luYyBmdW5jdGlvbiByZWFkTWV0YWRhdGEoa2V5OiBzdHJpbmcpOiBQcm9taXNlPEdjc09iamVjdCB8IG51bGw+IHtcbiAgICBjb25zdCByID0gYXdhaXQgcmVxdWVzdChvYmplY3RVcmwoa2V5KSk7XG4gICAgaWYgKHIuc3RhdHVzID09PSA0MDQpIHJldHVybiBudWxsO1xuICAgIGlmICghci5vaykgdGhyb3cgbmV3IEdjc1N0b3JhZ2VFcnJvcihyLnN0YXR1cywgJ21ldGFkYXRhIHJlYWQnKTtcbiAgICByZXR1cm4gci5qc29uKCkgYXMgUHJvbWlzZTxHY3NPYmplY3Q+O1xuICB9XG4gIGZ1bmN0aW9uIG1ldGFkYXRhKHg6IEdjc09iamVjdCk6IE9iamVjdE1ldGFkYXRhIHtcbiAgICBjb25zdCBzaXplID0gTnVtYmVyKHguc2l6ZSk7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihzaXplKSB8fCBzaXplIDwgMCB8fCAhL15cXGQrJC8udGVzdCh4LmdlbmVyYXRpb24pKSB0aHJvdyBuZXcgRXJyb3IoJ2ludmFsaWQgR0NTIG9iamVjdCBtZXRhZGF0YScpO1xuICAgIGNvbnN0IGh0dHBNZXRhZGF0YTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIEhUVFBfRklFTERTLmZvckVhY2goayA9PiB7IGlmICh4W2tdICE9PSB1bmRlZmluZWQpIGh0dHBNZXRhZGF0YVtrXSA9IHhba10hOyB9KTtcbiAgICByZXR1cm4ge1xuICAgICAga2V5OiB4Lm5hbWUsIHNpemUsIHZlcnNpb246IHguZ2VuZXJhdGlvbiwgZXRhZzogeC5nZW5lcmF0aW9uLCBodHRwRXRhZzogYFwiJHt4LmdlbmVyYXRpb259XCJgLFxuICAgICAgdXBsb2FkZWQ6IG5ldyBEYXRlKHgudXBkYXRlZCA/PyAwKSwgY3VzdG9tTWV0YWRhdGE6IHgubWV0YWRhdGEgPz8ge30sIGh0dHBNZXRhZGF0YSxcbiAgICAgIHdyaXRlSHR0cE1ldGFkYXRhKGhlYWRlcnMpIHtcbiAgICAgICAgSFRUUF9GSUVMRFMuZm9yRWFjaCgoaywgaSkgPT4geyBpZiAoaHR0cE1ldGFkYXRhW2tdICE9PSB1bmRlZmluZWQpIGhlYWRlcnMuc2V0KEhUVFBfSEVBREVSU1tpXSEsIGh0dHBNZXRhZGF0YVtrXSEpOyB9KTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuICBmdW5jdGlvbiB1cGxvYWRNZXRhZGF0YShvcHRpb25zOiBPYmplY3RQdXRPcHRpb25zKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7IC4uLk9iamVjdC5mcm9tRW50cmllcyhIVFRQX0ZJRUxEUy5maWx0ZXIoayA9PiBvcHRpb25zLmh0dHBNZXRhZGF0YT8uW2tdICE9PSB1bmRlZmluZWQpXG4gICAgICAubWFwKGsgPT4gW2ssIG9wdGlvbnMuaHR0cE1ldGFkYXRhIVtrXV0pKSwgbWV0YWRhdGE6IG9wdGlvbnMuY3VzdG9tTWV0YWRhdGEgPz8ge30gfTtcbiAgfVxuICBhc3luYyBmdW5jdGlvbiBnZW5lcmF0aW9uQ29uZGl0aW9uKGtleTogc3RyaW5nLCBvcHRpb25zOiBPYmplY3RQdXRPcHRpb25zKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkPiB7XG4gICAgY29uc3QgY29uZGl0aW9uID0gb3B0aW9ucy5vbmx5SWY7XG4gICAgaWYgKCFjb25kaXRpb24gfHwgT2JqZWN0LmtleXMoY29uZGl0aW9uKS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKGNvbmRpdGlvbi5ldGFnRG9lc05vdE1hdGNoID09PSAnKicgJiYgY29uZGl0aW9uLmV0YWdNYXRjaGVzID09PSB1bmRlZmluZWQpIHJldHVybiAnMCc7XG4gICAgaWYgKGNvbmRpdGlvbi5ldGFnTWF0Y2hlcyAhPT0gdW5kZWZpbmVkICYmIGNvbmRpdGlvbi5ldGFnRG9lc05vdE1hdGNoID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGV4cGVjdGVkID0gY29uZGl0aW9uLmV0YWdNYXRjaGVzLnJlcGxhY2UoL15cInxcIiQvZywgJycpO1xuICAgICAgaWYgKCEvXlxcZCskLy50ZXN0KGV4cGVjdGVkKSkgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIGdlbmVyYXRpb24gY29uZGl0aW9uJyk7XG4gICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgcmVhZE1ldGFkYXRhKGtleSk7XG4gICAgICByZXR1cm4gY3VycmVudD8uZ2VuZXJhdGlvbiA9PT0gZXhwZWN0ZWQgPyBleHBlY3RlZCA6IG51bGw7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcigndW5zdXBwb3J0ZWQgb2JqZWN0IHByZWNvbmRpdGlvbicpO1xuICB9XG5cbiAgY29uc3Qgc3RvcmU6IE9iamVjdFN0b3JlID0ge1xuICAgIGFzeW5jIGhlYWQoa2V5KSB7IGNvbnN0IHggPSBhd2FpdCByZWFkTWV0YWRhdGEoa2V5KTsgcmV0dXJuIHggPyBtZXRhZGF0YSh4KSA6IG51bGw7IH0sXG4gICAgYXN5bmMgZ2V0KGtleSk6IFByb21pc2U8T2JqZWN0Qm9keSB8IG51bGw+IHtcbiAgICAgIGNvbnN0IHggPSBhd2FpdCByZWFkTWV0YWRhdGEoa2V5KTtcbiAgICAgIGlmICgheCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKG9iamVjdFVybChrZXkpKTtcbiAgICAgIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdhbHQnLCAnbWVkaWEnKTtcbiAgICAgIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdnZW5lcmF0aW9uJywgeC5nZW5lcmF0aW9uKTtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCByZXF1ZXN0KHVybC5ocmVmKTtcbiAgICAgIC8vIEEgZ2VuZXJhdGlvbiBkaXNhcHBlYXJpbmcgYmV0d2VlbiBtZXRhZGF0YSBhbmQgYnl0ZXMgaXMgYW4gZXJyb3IsIG5vdCBhYnNlbmNlLlxuICAgICAgaWYgKCFyLm9rIHx8ICFyLmJvZHkpIHRocm93IG5ldyBHY3NTdG9yYWdlRXJyb3Ioci5zdGF0dXMsICdnZW5lcmF0aW9uLXBpbm5lZCByZWFkJyk7XG4gICAgICByZXR1cm4geyAuLi5tZXRhZGF0YSh4KSwgYm9keTogci5ib2R5LCBhcnJheUJ1ZmZlcjogKCkgPT4gci5hcnJheUJ1ZmZlcigpLCB0ZXh0OiAoKSA9PiByLnRleHQoKSwganNvbjogPFQ+KCkgPT4gci5qc29uKCkgYXMgUHJvbWlzZTxUPiB9O1xuICAgIH0sXG4gICAgYXN5bmMgcHV0KGtleSwgYm9keSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgICBpZiAob3B0aW9ucy5zaGEyNTYpIHtcbiAgICAgICAgaWYgKGJvZHkgaW5zdGFuY2VvZiBSZWFkYWJsZVN0cmVhbSkgdGhyb3cgbmV3IEVycm9yKCdzdHJlYW0gU0hBMjU2IG11c3QgYmUgdmVyaWZpZWQgYnkgdGhlIHVwbG9hZCBwcm90b2NvbCcpO1xuICAgICAgICBjb25zdCBieXRlcyA9IHR5cGVvZiBib2R5ID09PSAnc3RyaW5nJyA/IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShib2R5KSA6IGJvZHkgaW5zdGFuY2VvZiBCbG9iID8gYXdhaXQgYm9keS5hcnJheUJ1ZmZlcigpIDogYm9keTtcbiAgICAgICAgaWYgKGF3YWl0IHNoYTI1NkhleChieXRlcykgIT09IG9wdGlvbnMuc2hhMjU2KSB0aHJvdyBuZXcgRXJyb3IoJ3NoYV9taXNtYXRjaCcpO1xuICAgICAgfVxuICAgICAgY29uc3QgY29uZGl0aW9uID0gYXdhaXQgZ2VuZXJhdGlvbkNvbmRpdGlvbihrZXksIG9wdGlvbnMpO1xuICAgICAgaWYgKGNvbmRpdGlvbiA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHVwbG9hZEJhc2UpO1xuICAgICAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ3VwbG9hZFR5cGUnLCAncmVzdW1hYmxlJyk7IHVybC5zZWFyY2hQYXJhbXMuc2V0KCduYW1lJywga2V5KTtcbiAgICAgIGlmIChjb25kaXRpb24gIT09IHVuZGVmaW5lZCkgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2lmR2VuZXJhdGlvbk1hdGNoJywgY29uZGl0aW9uKTtcbiAgICAgIGNvbnN0IGJlZ2luID0gYXdhaXQgcmVxdWVzdCh1cmwuaHJlZiwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJywgaGVhZGVyczogeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHVwbG9hZE1ldGFkYXRhKG9wdGlvbnMpKSxcbiAgICAgIH0pO1xuICAgICAgaWYgKGJlZ2luLnN0YXR1cyA9PT0gNDEyKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghYmVnaW4ub2spIHRocm93IG5ldyBHY3NTdG9yYWdlRXJyb3IoYmVnaW4uc3RhdHVzLCAndXBsb2FkIGluaXRpYXRpb24nKTtcbiAgICAgIGNvbnN0IGxvY2F0aW9uID0gYmVnaW4uaGVhZGVycy5nZXQoJ2xvY2F0aW9uJyk7XG4gICAgICBjb25zdCBkZXN0aW5hdGlvbiA9IGxvY2F0aW9uID8gbmV3IFVSTChsb2NhdGlvbikgOiBudWxsO1xuICAgICAgaWYgKCFkZXN0aW5hdGlvbiB8fCBkZXN0aW5hdGlvbi5vcmlnaW4gIT09ICdodHRwczovL3N0b3JhZ2UuZ29vZ2xlYXBpcy5jb20nIHx8ICFkZXN0aW5hdGlvbi5wYXRobmFtZS5zdGFydHNXaXRoKCcvdXBsb2FkLycpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignaW52YWxpZCBHQ1MgdXBsb2FkIGRlc3RpbmF0aW9uJyk7XG4gICAgICB9XG4gICAgICBjb25zdCBpbml0OiBSZXF1ZXN0SW5pdCAmIHsgZHVwbGV4PzogJ2hhbGYnIH0gPSB7IG1ldGhvZDogJ1BVVCcsIGJvZHk6IGJvZHkgYXMgQm9keUluaXQgfTtcbiAgICAgIGlmIChib2R5IGluc3RhbmNlb2YgUmVhZGFibGVTdHJlYW0pIGluaXQuZHVwbGV4ID0gJ2hhbGYnO1xuICAgICAgY29uc3QgZG9uZSA9IGF3YWl0IHJlcXVlc3QoZGVzdGluYXRpb24uaHJlZiwgaW5pdCk7XG4gICAgICBpZiAoZG9uZS5zdGF0dXMgPT09IDQxMikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIWRvbmUub2spIHRocm93IG5ldyBHY3NTdG9yYWdlRXJyb3IoZG9uZS5zdGF0dXMsICd1cGxvYWQnKTtcbiAgICAgIHJldHVybiBtZXRhZGF0YShhd2FpdCBkb25lLmpzb24oKSBhcyBHY3NPYmplY3QpO1xuICAgIH0sXG4gICAgYXN5bmMgZGVsZXRlKGtleSkge1xuICAgICAgY29uc3QgciA9IGF3YWl0IHJlcXVlc3Qob2JqZWN0VXJsKGtleSksIHsgbWV0aG9kOiAnREVMRVRFJyB9KTtcbiAgICAgIGlmIChyLnN0YXR1cyAhPT0gNDA0ICYmICFyLm9rKSB0aHJvdyBuZXcgR2NzU3RvcmFnZUVycm9yKHIuc3RhdHVzLCAnZGVsZXRlJyk7XG4gICAgfSxcbiAgICBhc3luYyBsaXN0KG9wdGlvbnMgPSB7fSkge1xuICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChiYXNlKTtcbiAgICAgIGlmIChvcHRpb25zLnByZWZpeCAhPT0gdW5kZWZpbmVkKSB1cmwuc2VhcmNoUGFyYW1zLnNldCgncHJlZml4Jywgb3B0aW9ucy5wcmVmaXgpO1xuICAgICAgaWYgKG9wdGlvbnMuY3Vyc29yICE9PSB1bmRlZmluZWQpIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdwYWdlVG9rZW4nLCBvcHRpb25zLmN1cnNvcik7XG4gICAgICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnbWF4UmVzdWx0cycsIFN0cmluZyhNYXRoLm1pbigxMDAwLCBNYXRoLm1heCgxLCBvcHRpb25zLmxpbWl0ID8/IDEwMDApKSkpO1xuICAgICAgY29uc3QgciA9IGF3YWl0IHJlcXVlc3QodXJsLmhyZWYpO1xuICAgICAgaWYgKCFyLm9rKSB0aHJvdyBuZXcgR2NzU3RvcmFnZUVycm9yKHIuc3RhdHVzLCAnbGlzdCcpO1xuICAgICAgY29uc3QgcGFnZSA9IGF3YWl0IHIuanNvbigpIGFzIHsgaXRlbXM/OiBHY3NPYmplY3RbXTsgbmV4dFBhZ2VUb2tlbj86IHN0cmluZyB9O1xuICAgICAgcmV0dXJuIHsgb2JqZWN0czogKHBhZ2UuaXRlbXMgPz8gW10pLm1hcChtZXRhZGF0YSksIHRydW5jYXRlZDogQm9vbGVhbihwYWdlLm5leHRQYWdlVG9rZW4pLCBjdXJzb3I6IHBhZ2UubmV4dFBhZ2VUb2tlbiB9O1xuICAgIH0sXG4gICAgYXN5bmMgY3JlYXRlTXVsdGlwYXJ0VXBsb2FkKGtleSwgb3B0aW9ucyA9IHt9KSB7XG4gICAgICBjb25zdCB1cGxvYWRJZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgICBjb25zdCBzZXNzaW9uID0gYXdhaXQgc3RvcmUucHV0KGAke1VQTE9BRFN9JHt1cGxvYWRJZH0vc2Vzc2lvbmAsIEpTT04uc3RyaW5naWZ5KHsga2V5LCBvcHRpb25zIH0pLCB7XG4gICAgICAgIG9ubHlJZjogeyBldGFnRG9lc05vdE1hdGNoOiAnKicgfSwgaHR0cE1ldGFkYXRhOiB7IGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoJ211bHRpcGFydCBzZXNzaW9uIGNvbGxpc2lvbicpO1xuICAgICAgcmV0dXJuIHN0b3JlLnJlc3VtZU11bHRpcGFydFVwbG9hZChrZXksIHVwbG9hZElkKTtcbiAgICB9LFxuICAgIHJlc3VtZU11bHRpcGFydFVwbG9hZChrZXksIHVwbG9hZElkKSB7XG4gICAgICBpZiAoIS9eWzAtOWEtZi1dezM2fSQvLnRlc3QodXBsb2FkSWQpKSB0aHJvdyBuZXcgRXJyb3IoJ2ludmFsaWQgR0NTIG11bHRpcGFydCB1cGxvYWQgaWQnKTtcbiAgICAgIGNvbnN0IHByZWZpeCA9IGAke1VQTE9BRFN9JHt1cGxvYWRJZH0vYDtcbiAgICAgIGFzeW5jIGZ1bmN0aW9uIHNlc3Npb24oKTogUHJvbWlzZTxTZXNzaW9uPiB7XG4gICAgICAgIGNvbnN0IG9iamVjdCA9IGF3YWl0IHN0b3JlLmdldChgJHtwcmVmaXh9c2Vzc2lvbmApO1xuICAgICAgICBpZiAoIW9iamVjdCB8fCBvYmplY3Quc2l6ZSA+IDY0ICogMTAyNCkgdGhyb3cgbmV3IEVycm9yKCdtdWx0aXBhcnQgc2Vzc2lvbiBtaXNzaW5nJyk7XG4gICAgICAgIGNvbnN0IHMgPSBhd2FpdCBvYmplY3QuanNvbjxTZXNzaW9uPigpO1xuICAgICAgICBpZiAocy5rZXkgIT09IGtleSB8fCAhcy5vcHRpb25zIHx8IHR5cGVvZiBzLm9wdGlvbnMgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ211bHRpcGFydCBzZXNzaW9uIGRvZXMgbm90IG1hdGNoIGRlc3RpbmF0aW9uJyk7XG4gICAgICAgIHJldHVybiBzO1xuICAgICAgfVxuICAgICAgYXN5bmMgZnVuY3Rpb24gY29tcG9zZShkZXN0aW5hdGlvbjogc3RyaW5nLCBzb3VyY2VzOiB7IG5hbWU6IHN0cmluZzsgZ2VuZXJhdGlvbjogc3RyaW5nIH1bXSwgb3B0aW9uczogT2JqZWN0UHV0T3B0aW9ucykge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGAke29iamVjdFVybChkZXN0aW5hdGlvbil9L2NvbXBvc2VgKTtcbiAgICAgICAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2lmR2VuZXJhdGlvbk1hdGNoJywgJzAnKTtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IHJlcXVlc3QodXJsLmhyZWYsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJywgaGVhZGVyczogeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzb3VyY2VPYmplY3RzOiBzb3VyY2VzLCBkZXN0aW5hdGlvbjogdXBsb2FkTWV0YWRhdGEob3B0aW9ucykgfSksXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoci5zdGF0dXMgIT09IDQxMiAmJiAhci5vaykgdGhyb3cgbmV3IEdjc1N0b3JhZ2VFcnJvcihyLnN0YXR1cywgJ2NvbXBvc2UnKTtcbiAgICAgICAgaWYgKHIuc3RhdHVzICE9PSA0MTIpIHJldHVybiBtZXRhZGF0YShhd2FpdCByLmpzb24oKSBhcyBHY3NPYmplY3QpO1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHN0b3JlLmhlYWQoZGVzdGluYXRpb24pO1xuICAgICAgICBpZiAoIWV4aXN0aW5nIHx8IGV4aXN0aW5nLmN1c3RvbU1ldGFkYXRhLmdjc1VwbG9hZElkICE9PSB1cGxvYWRJZCB8fFxuICAgICAgICAgIGV4aXN0aW5nLmN1c3RvbU1ldGFkYXRhLmdjc1BhcnRzSGFzaCAhPT0gb3B0aW9ucy5jdXN0b21NZXRhZGF0YT8uZ2NzUGFydHNIYXNoKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEdjc1N0b3JhZ2VFcnJvcig0MTIsICdjcmVhdGUtb25seSBjb21wb3NlJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGV4aXN0aW5nO1xuICAgICAgfVxuICAgICAgY29uc3QgdXBsb2FkOiBNdWx0aXBhcnRVcGxvYWQgPSB7XG4gICAgICAgIGtleSwgdXBsb2FkSWQsXG4gICAgICAgIGFzeW5jIHVwbG9hZFBhcnQocGFydE51bWJlciwgYm9keSkge1xuICAgICAgICAgIGF3YWl0IHNlc3Npb24oKTtcbiAgICAgICAgICBpZiAoIU51bWJlci5pc0ludGVnZXIocGFydE51bWJlcikgfHwgcGFydE51bWJlciA8IDEgfHwgcGFydE51bWJlciA+IDEwMDAwKSB0aHJvdyBuZXcgRXJyb3IoJ2ludmFsaWQgcGFydCBudW1iZXInKTtcbiAgICAgICAgICBjb25zdCBvYmplY3QgPSBhd2FpdCBzdG9yZS5wdXQoYCR7cHJlZml4fXBhcnQtJHtwYXJ0TnVtYmVyfWAsIGJvZHkpO1xuICAgICAgICAgIGlmICghb2JqZWN0KSB0aHJvdyBuZXcgRXJyb3IoJ3BhcnQgdXBsb2FkIGZhaWxlZCcpO1xuICAgICAgICAgIHJldHVybiB7IHBhcnROdW1iZXIsIGV0YWc6IG9iamVjdC52ZXJzaW9uIH07XG4gICAgICAgIH0sXG4gICAgICAgIGFzeW5jIGNvbXBsZXRlKHBhcnRzOiBVcGxvYWRlZFBhcnRbXSkge1xuICAgICAgICAgIGNvbnN0IHMgPSBhd2FpdCBzZXNzaW9uKCk7XG4gICAgICAgICAgaWYgKCFwYXJ0cy5sZW5ndGggfHwgcGFydHMuc29tZSgocCwgaSkgPT4gIU51bWJlci5pc0ludGVnZXIocC5wYXJ0TnVtYmVyKSB8fCBwLnBhcnROdW1iZXIgPCAxIHx8IHAucGFydE51bWJlciA+IDEwMDAwIHx8XG4gICAgICAgICAgICAhL15cXGQrJC8udGVzdChwLmV0YWcpIHx8IChpID4gMCAmJiBwYXJ0c1tpIC0gMV0hLnBhcnROdW1iZXIgPj0gcC5wYXJ0TnVtYmVyKSkpIHRocm93IG5ldyBFcnJvcignaW52YWxpZCBtdWx0aXBhcnQgcmVjZWlwdHMnKTtcbiAgICAgICAgICBjb25zdCBoYXNoID0gYXdhaXQgc2hhMjU2SGV4KG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShKU09OLnN0cmluZ2lmeShwYXJ0cykpKTtcbiAgICAgICAgICBjb25zdCBvcHRpb25zID0geyAuLi5zLm9wdGlvbnMsIGN1c3RvbU1ldGFkYXRhOiB7IC4uLnMub3B0aW9ucy5jdXN0b21NZXRhZGF0YSwgZ2NzVXBsb2FkSWQ6IHVwbG9hZElkLCBnY3NQYXJ0c0hhc2g6IGhhc2ggfSB9O1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgc3RvcmUuaGVhZChrZXkpO1xuICAgICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nLmN1c3RvbU1ldGFkYXRhLmdjc1VwbG9hZElkID09PSB1cGxvYWRJZCAmJiBleGlzdGluZy5jdXN0b21NZXRhZGF0YS5nY3NQYXJ0c0hhc2ggPT09IGhhc2gpIHJldHVybiBleGlzdGluZztcbiAgICAgICAgICAgIHRocm93IG5ldyBHY3NTdG9yYWdlRXJyb3IoNDEyLCAnY3JlYXRlLW9ubHkgbXVsdGlwYXJ0IGRlc3RpbmF0aW9uJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGxldCBzb3VyY2VzID0gcGFydHMubWFwKHAgPT4gKHsgbmFtZTogYCR7cHJlZml4fXBhcnQtJHtwLnBhcnROdW1iZXJ9YCwgZ2VuZXJhdGlvbjogcC5ldGFnIH0pKTtcbiAgICAgICAgICBsZXQgbGV2ZWwgPSAwO1xuICAgICAgICAgIHdoaWxlIChzb3VyY2VzLmxlbmd0aCA+IDMyKSB7XG4gICAgICAgICAgICBjb25zdCBuZXh0OiB0eXBlb2Ygc291cmNlcyA9IFtdO1xuICAgICAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3VyY2VzLmxlbmd0aDsgaSArPSAzMikge1xuICAgICAgICAgICAgICBjb25zdCBuYW1lID0gYCR7cHJlZml4fWNvbXBvc2UtJHtoYXNofS0ke2xldmVsfS0ke2kgLyAzMn1gO1xuICAgICAgICAgICAgICBjb25zdCBvYmplY3QgPSBhd2FpdCBjb21wb3NlKG5hbWUsIHNvdXJjZXMuc2xpY2UoaSwgaSArIDMyKSwgb3B0aW9ucyk7XG4gICAgICAgICAgICAgIG5leHQucHVzaCh7IG5hbWUsIGdlbmVyYXRpb246IG9iamVjdC52ZXJzaW9uIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc291cmNlcyA9IG5leHQ7IGxldmVsKys7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIE9yaWdpbmFscy9wYXJ0cyByZW1haW4gdW50aWwgZXhwbGljaXQgYWJvcnQvR0MgYWZ0ZXIgaW5kZXBlbmRlbnQgYnl0ZSB2ZXJpZmljYXRpb24uXG4gICAgICAgICAgcmV0dXJuIGNvbXBvc2Uoa2V5LCBzb3VyY2VzLCBvcHRpb25zKTtcbiAgICAgICAgfSxcbiAgICAgICAgYXN5bmMgYWJvcnQoKSB7XG4gICAgICAgICAgYXdhaXQgc2Vzc2lvbigpO1xuICAgICAgICAgIGxldCBjdXJzb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgICBkbyB7XG4gICAgICAgICAgICBjb25zdCBwYWdlID0gYXdhaXQgc3RvcmUubGlzdCh7IHByZWZpeCwgY3Vyc29yIH0pO1xuICAgICAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2YgcGFnZS5vYmplY3RzKSBpZiAob2JqZWN0LmtleSAhPT0gYCR7cHJlZml4fXNlc3Npb25gKSBhd2FpdCBzdG9yZS5kZWxldGUob2JqZWN0LmtleSk7XG4gICAgICAgICAgICBjdXJzb3IgPSBwYWdlLmN1cnNvcjtcbiAgICAgICAgICB9IHdoaWxlIChjdXJzb3IpO1xuICAgICAgICAgIGF3YWl0IHN0b3JlLmRlbGV0ZShgJHtwcmVmaXh9c2Vzc2lvbmApO1xuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIHJldHVybiB1cGxvYWQ7XG4gICAgfSxcbiAgfTtcbiAgcmV0dXJuIHN0b3JlO1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvYXJ0aWZhY3QtcmVnaXN0cnkvc3JjL2djcy1vYmplY3Qtc3RvcmUudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2FydGlmYWN0LXJlZ2lzdHJ5L3NyYy9nY3Mtb2JqZWN0LXN0b3JlLnRzIiwiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2FydGlmYWN0LXJlZ2lzdHJ5L3NyYy9nY3Mtb2JqZWN0LXN0b3JlLnRzIixbXV0=
}}