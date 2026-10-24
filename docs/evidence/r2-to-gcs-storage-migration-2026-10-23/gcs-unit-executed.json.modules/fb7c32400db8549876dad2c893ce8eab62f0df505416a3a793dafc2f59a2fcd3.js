const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/dist/index.js", {"importedNames":["describe","it","expect"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/content-address.ts", {"importedNames":["contentAddressing","sha256Hex"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/blob-store.ts", {"importedNames":["putContentAddressed","getContentAddressed","gcIfUnreferenced","memoryBlobStore"]});



const enc = new TextEncoder();
const SCHEME = (0,__vite_ssr_import_1__.contentAddressing)({ prefix: "snapshots", ext: ".tar.gz" });
const MAX = 100 * 1024 * 1024;
const BYTES = enc.encode("fake .tar.gz bytes — artifact state");
const bodyOf = (u8) => async () => u8.slice().buffer;
(0,__vite_ssr_import_0__.describe)("putContentAddressed", () => {
  (0,__vite_ssr_import_0__.it)("stores a content-addressed blob and is idempotent", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(BYTES);
    const r1 = await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    (0,__vite_ssr_import_0__.expect)(r1).toEqual({ ok: true, key: SCHEME.key(sha), bytes: BYTES.byteLength, deduped: false });
    (0,__vite_ssr_import_0__.expect)(store.data.has(SCHEME.key(sha))).toBe(true);
    let called = false;
    const r2 = await (0,__vite_ssr_import_2__.putContentAddressed)(store, {
      hash: sha,
      scheme: SCHEME,
      maxBytes: MAX,
      readBody: async () => {
        called = true;
        return BYTES.slice().buffer;
      }
    });
    (0,__vite_ssr_import_0__.expect)(r2).toEqual({ ok: true, key: SCHEME.key(sha), bytes: BYTES.byteLength, deduped: true });
    (0,__vite_ssr_import_0__.expect)(called).toBe(false);
  });
  (0,__vite_ssr_import_0__.it)("rejects a body whose sha256 does not match the key", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const wrong = "a".repeat(64);
    const r = await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: wrong, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    (0,__vite_ssr_import_0__.expect)(r.ok).toBe(false);
    if (!r.ok) {
      (0,__vite_ssr_import_0__.expect)(r.status).toBe(400);
      (0,__vite_ssr_import_0__.expect)(r.error).toBe("sha_mismatch");
      (0,__vite_ssr_import_0__.expect)(r.detail).toEqual({ expected: wrong, actual: await (0,__vite_ssr_import_1__.sha256Hex)(BYTES) });
    };
    (0,__vite_ssr_import_0__.expect)(store.data.size).toBe(0);
  });
  (0,__vite_ssr_import_0__.it)("rejects a non-hex hash before touching the store", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    let read = false;
    const r = await (0,__vite_ssr_import_2__.putContentAddressed)(store, {
      hash: "not-a-sha",
      scheme: SCHEME,
      maxBytes: MAX,
      readBody: async () => {
        read = true;
        return BYTES.slice().buffer;
      }
    });
    (0,__vite_ssr_import_0__.expect)(r).toEqual({ ok: false, status: 400, error: "invalid_sha" });
    (0,__vite_ssr_import_0__.expect)(read).toBe(false);
  });
  (0,__vite_ssr_import_0__.it)("rejects declared oversize before buffering, and actual oversize after", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(BYTES);
    let read = false;
    const declared = await (0,__vite_ssr_import_2__.putContentAddressed)(store, {
      hash: sha,
      scheme: SCHEME,
      maxBytes: 4,
      declaredLength: 9999,
      readBody: async () => {
        read = true;
        return BYTES.slice().buffer;
      }
    });
    (0,__vite_ssr_import_0__.expect)(declared).toEqual({ ok: false, status: 413, error: "too_large", detail: { max_bytes: 4 } });
    (0,__vite_ssr_import_0__.expect)(read).toBe(false);
    const actual = await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: 4 });
    (0,__vite_ssr_import_0__.expect)(actual).toEqual({ ok: false, status: 413, error: "too_large", detail: { max_bytes: 4 } });
  });
  (0,__vite_ssr_import_0__.it)("rejects an empty body", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const empty = new Uint8Array(0);
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(empty);
    const r = await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(empty), maxBytes: MAX });
    (0,__vite_ssr_import_0__.expect)(r).toEqual({ ok: false, status: 400, error: "empty_body" });
  });
});
(0,__vite_ssr_import_0__.describe)("getContentAddressed", () => {
  (0,__vite_ssr_import_0__.it)("is visibility-gated: 404 until referenced, then returns the backend object", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(BYTES);
    await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    const gated = await (0,__vite_ssr_import_2__.getContentAddressed)(store, { hash: sha, scheme: SCHEME, isReferenced: () => false });
    (0,__vite_ssr_import_0__.expect)(gated).toEqual({ ok: false, status: 404, error: "not_found" });
    const ok = await (0,__vite_ssr_import_2__.getContentAddressed)(store, { hash: sha, scheme: SCHEME, isReferenced: (k) => k === SCHEME.key(sha) });
    (0,__vite_ssr_import_0__.expect)(ok.ok).toBe(true);
    if (ok.ok) (0,__vite_ssr_import_0__.expect)(new Uint8Array(ok.object.body)).toEqual(BYTES);
  });
  (0,__vite_ssr_import_0__.it)("404s when the gate passes but no bytes are stored, and 400s a bad hash", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(BYTES);
    (0,__vite_ssr_import_0__.expect)(await (0,__vite_ssr_import_2__.getContentAddressed)(store, { hash: sha, scheme: SCHEME, isReferenced: () => true })).toEqual({ ok: false, status: 404, error: "not_found" });
    (0,__vite_ssr_import_0__.expect)(await (0,__vite_ssr_import_2__.getContentAddressed)(store, { hash: "nope", scheme: SCHEME })).toEqual({ ok: false, status: 400, error: "invalid_sha" });
  });
});
(0,__vite_ssr_import_0__.describe)("gcIfUnreferenced", () => {
  (0,__vite_ssr_import_0__.it)("deletes the blob iff no live reference remains", async () => {
    const store = (0,__vite_ssr_import_2__.memoryBlobStore)();
    const sha = await (0,__vite_ssr_import_1__.sha256Hex)(BYTES);
    const key = SCHEME.key(sha);
    await (0,__vite_ssr_import_2__.putContentAddressed)(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    (0,__vite_ssr_import_0__.expect)(await (0,__vite_ssr_import_2__.gcIfUnreferenced)(store, key, () => true)).toBe(false);
    (0,__vite_ssr_import_0__.expect)(store.data.has(key)).toBe(true);
    (0,__vite_ssr_import_0__.expect)(await (0,__vite_ssr_import_2__.gcIfUnreferenced)(store, key, () => false)).toBe(true);
    (0,__vite_ssr_import_0__.expect)(store.data.has(key)).toBe(false);
  });
});
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LFVBQU0sTUFBTSxPQUFPLElBQUksR0FBRztBQUMxQixhQUFNLDJDQUFvQixPQUFPLEVBQUUsTUFBTSxLQUFLLFFBQVEsUUFBUSxVQUFVLE9BQU8sS0FBSyxHQUFHLFVBQVUsSUFBSSxDQUFDO0FBR3RHLHFDQUFPLFNBQU0sd0NBQWlCLE9BQU8sS0FBSyxNQUFNLElBQUksQ0FBQyxFQUFFLEtBQUssS0FBSztBQUNqRSxxQ0FBTyxNQUFNLEtBQUssSUFBSSxHQUFHLENBQUMsRUFBRSxLQUFLLElBQUk7QUFHckMscUNBQU8sU0FBTSx3Q0FBaUIsT0FBTyxLQUFLLE1BQU0sS0FBSyxDQUFDLEVBQUUsS0FBSyxJQUFJO0FBQ2pFLHFDQUFPLE1BQU0sS0FBSyxJQUFJLEdBQUcsQ0FBQyxFQUFFLEtBQUssS0FBSztBQUFBLEVBQ3hDLENBQUM7QUFDSCxDQUFDIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJibG9iLXN0b3JlLnRlc3QudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBleHBlY3QgfSBmcm9tICd2aXRlc3QnO1xuaW1wb3J0IHsgY29udGVudEFkZHJlc3NpbmcsIHNoYTI1NkhleCB9IGZyb20gJy4vY29udGVudC1hZGRyZXNzLnRzJztcbmltcG9ydCB7XG4gIHB1dENvbnRlbnRBZGRyZXNzZWQsXG4gIGdldENvbnRlbnRBZGRyZXNzZWQsXG4gIGdjSWZVbnJlZmVyZW5jZWQsXG4gIG1lbW9yeUJsb2JTdG9yZSxcbn0gZnJvbSAnLi9ibG9iLXN0b3JlLnRzJztcblxuY29uc3QgZW5jID0gbmV3IFRleHRFbmNvZGVyKCk7XG5jb25zdCBTQ0hFTUUgPSBjb250ZW50QWRkcmVzc2luZyh7IHByZWZpeDogJ3NuYXBzaG90cycsIGV4dDogJy50YXIuZ3onIH0pO1xuY29uc3QgTUFYID0gMTAwICogMTAyNCAqIDEwMjQ7XG5cbmNvbnN0IEJZVEVTID0gZW5jLmVuY29kZSgnZmFrZSAudGFyLmd6IGJ5dGVzIOKAlCBhcnRpZmFjdCBzdGF0ZScpO1xuY29uc3QgYm9keU9mID0gKHU4OiBVaW50OEFycmF5KSA9PiBhc3luYyAoKSA9PiB1OC5zbGljZSgpLmJ1ZmZlcjtcblxuZGVzY3JpYmUoJ3B1dENvbnRlbnRBZGRyZXNzZWQnLCAoKSA9PiB7XG4gIGl0KCdzdG9yZXMgYSBjb250ZW50LWFkZHJlc3NlZCBibG9iIGFuZCBpcyBpZGVtcG90ZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3Qgc2hhID0gYXdhaXQgc2hhMjU2SGV4KEJZVEVTKTtcbiAgICBjb25zdCByMSA9IGF3YWl0IHB1dENvbnRlbnRBZGRyZXNzZWQoc3RvcmUsIHsgaGFzaDogc2hhLCBzY2hlbWU6IFNDSEVNRSwgcmVhZEJvZHk6IGJvZHlPZihCWVRFUyksIG1heEJ5dGVzOiBNQVggfSk7XG4gICAgZXhwZWN0KHIxKS50b0VxdWFsKHsgb2s6IHRydWUsIGtleTogU0NIRU1FLmtleShzaGEpLCBieXRlczogQllURVMuYnl0ZUxlbmd0aCwgZGVkdXBlZDogZmFsc2UgfSk7XG4gICAgZXhwZWN0KHN0b3JlLmRhdGEuaGFzKFNDSEVNRS5rZXkoc2hhKSkpLnRvQmUodHJ1ZSk7XG5cbiAgICAvLyBSZS1QVVQgaWRlbnRpY2FsIGNvbnRlbnQg4oeSIGRlZHVwZWQsIG5vIHJlLXdyaXRlIChyZWFkQm9keSBuZXZlciBjYWxsZWQpLlxuICAgIGxldCBjYWxsZWQgPSBmYWxzZTtcbiAgICBjb25zdCByMiA9IGF3YWl0IHB1dENvbnRlbnRBZGRyZXNzZWQoc3RvcmUsIHtcbiAgICAgIGhhc2g6IHNoYSwgc2NoZW1lOiBTQ0hFTUUsIG1heEJ5dGVzOiBNQVgsXG4gICAgICByZWFkQm9keTogYXN5bmMgKCkgPT4geyBjYWxsZWQgPSB0cnVlOyByZXR1cm4gQllURVMuc2xpY2UoKS5idWZmZXI7IH0sXG4gICAgfSk7XG4gICAgZXhwZWN0KHIyKS50b0VxdWFsKHsgb2s6IHRydWUsIGtleTogU0NIRU1FLmtleShzaGEpLCBieXRlczogQllURVMuYnl0ZUxlbmd0aCwgZGVkdXBlZDogdHJ1ZSB9KTtcbiAgICBleHBlY3QoY2FsbGVkKS50b0JlKGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgYSBib2R5IHdob3NlIHNoYTI1NiBkb2VzIG5vdCBtYXRjaCB0aGUga2V5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3Qgd3JvbmcgPSAnYScucmVwZWF0KDY0KTtcbiAgICBjb25zdCByID0gYXdhaXQgcHV0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiB3cm9uZywgc2NoZW1lOiBTQ0hFTUUsIHJlYWRCb2R5OiBib2R5T2YoQllURVMpLCBtYXhCeXRlczogTUFYIH0pO1xuICAgIGV4cGVjdChyLm9rKS50b0JlKGZhbHNlKTtcbiAgICBpZiAoIXIub2spIHtcbiAgICAgIGV4cGVjdChyLnN0YXR1cykudG9CZSg0MDApO1xuICAgICAgZXhwZWN0KHIuZXJyb3IpLnRvQmUoJ3NoYV9taXNtYXRjaCcpO1xuICAgICAgZXhwZWN0KHIuZGV0YWlsKS50b0VxdWFsKHsgZXhwZWN0ZWQ6IHdyb25nLCBhY3R1YWw6IGF3YWl0IHNoYTI1NkhleChCWVRFUykgfSk7XG4gICAgfVxuICAgIGV4cGVjdChzdG9yZS5kYXRhLnNpemUpLnRvQmUoMCk7XG4gIH0pO1xuXG4gIGl0KCdyZWplY3RzIGEgbm9uLWhleCBoYXNoIGJlZm9yZSB0b3VjaGluZyB0aGUgc3RvcmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgc3RvcmUgPSBtZW1vcnlCbG9iU3RvcmUoKTtcbiAgICBsZXQgcmVhZCA9IGZhbHNlO1xuICAgIGNvbnN0IHIgPSBhd2FpdCBwdXRDb250ZW50QWRkcmVzc2VkKHN0b3JlLCB7XG4gICAgICBoYXNoOiAnbm90LWEtc2hhJywgc2NoZW1lOiBTQ0hFTUUsIG1heEJ5dGVzOiBNQVgsXG4gICAgICByZWFkQm9keTogYXN5bmMgKCkgPT4geyByZWFkID0gdHJ1ZTsgcmV0dXJuIEJZVEVTLnNsaWNlKCkuYnVmZmVyOyB9LFxuICAgIH0pO1xuICAgIGV4cGVjdChyKS50b0VxdWFsKHsgb2s6IGZhbHNlLCBzdGF0dXM6IDQwMCwgZXJyb3I6ICdpbnZhbGlkX3NoYScgfSk7XG4gICAgZXhwZWN0KHJlYWQpLnRvQmUoZmFsc2UpO1xuICB9KTtcblxuICBpdCgncmVqZWN0cyBkZWNsYXJlZCBvdmVyc2l6ZSBiZWZvcmUgYnVmZmVyaW5nLCBhbmQgYWN0dWFsIG92ZXJzaXplIGFmdGVyJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3Qgc2hhID0gYXdhaXQgc2hhMjU2SGV4KEJZVEVTKTtcblxuICAgIGxldCByZWFkID0gZmFsc2U7XG4gICAgY29uc3QgZGVjbGFyZWQgPSBhd2FpdCBwdXRDb250ZW50QWRkcmVzc2VkKHN0b3JlLCB7XG4gICAgICBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCBtYXhCeXRlczogNCwgZGVjbGFyZWRMZW5ndGg6IDk5OTksXG4gICAgICByZWFkQm9keTogYXN5bmMgKCkgPT4geyByZWFkID0gdHJ1ZTsgcmV0dXJuIEJZVEVTLnNsaWNlKCkuYnVmZmVyOyB9LFxuICAgIH0pO1xuICAgIGV4cGVjdChkZWNsYXJlZCkudG9FcXVhbCh7IG9rOiBmYWxzZSwgc3RhdHVzOiA0MTMsIGVycm9yOiAndG9vX2xhcmdlJywgZGV0YWlsOiB7IG1heF9ieXRlczogNCB9IH0pO1xuICAgIGV4cGVjdChyZWFkKS50b0JlKGZhbHNlKTsgLy8gZWFybHkgcmVqZWN0IOKAlCBuZXZlciBidWZmZXJlZFxuXG4gICAgY29uc3QgYWN0dWFsID0gYXdhaXQgcHV0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCByZWFkQm9keTogYm9keU9mKEJZVEVTKSwgbWF4Qnl0ZXM6IDQgfSk7XG4gICAgZXhwZWN0KGFjdHVhbCkudG9FcXVhbCh7IG9rOiBmYWxzZSwgc3RhdHVzOiA0MTMsIGVycm9yOiAndG9vX2xhcmdlJywgZGV0YWlsOiB7IG1heF9ieXRlczogNCB9IH0pO1xuICB9KTtcblxuICBpdCgncmVqZWN0cyBhbiBlbXB0eSBib2R5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3QgZW1wdHkgPSBuZXcgVWludDhBcnJheSgwKTtcbiAgICBjb25zdCBzaGEgPSBhd2FpdCBzaGEyNTZIZXgoZW1wdHkpO1xuICAgIGNvbnN0IHIgPSBhd2FpdCBwdXRDb250ZW50QWRkcmVzc2VkKHN0b3JlLCB7IGhhc2g6IHNoYSwgc2NoZW1lOiBTQ0hFTUUsIHJlYWRCb2R5OiBib2R5T2YoZW1wdHkpLCBtYXhCeXRlczogTUFYIH0pO1xuICAgIGV4cGVjdChyKS50b0VxdWFsKHsgb2s6IGZhbHNlLCBzdGF0dXM6IDQwMCwgZXJyb3I6ICdlbXB0eV9ib2R5JyB9KTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ2dldENvbnRlbnRBZGRyZXNzZWQnLCAoKSA9PiB7XG4gIGl0KCdpcyB2aXNpYmlsaXR5LWdhdGVkOiA0MDQgdW50aWwgcmVmZXJlbmNlZCwgdGhlbiByZXR1cm5zIHRoZSBiYWNrZW5kIG9iamVjdCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdG9yZSA9IG1lbW9yeUJsb2JTdG9yZSgpO1xuICAgIGNvbnN0IHNoYSA9IGF3YWl0IHNoYTI1NkhleChCWVRFUyk7XG4gICAgYXdhaXQgcHV0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCByZWFkQm9keTogYm9keU9mKEJZVEVTKSwgbWF4Qnl0ZXM6IE1BWCB9KTtcblxuICAgIGNvbnN0IGdhdGVkID0gYXdhaXQgZ2V0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCBpc1JlZmVyZW5jZWQ6ICgpID0+IGZhbHNlIH0pO1xuICAgIGV4cGVjdChnYXRlZCkudG9FcXVhbCh7IG9rOiBmYWxzZSwgc3RhdHVzOiA0MDQsIGVycm9yOiAnbm90X2ZvdW5kJyB9KTtcblxuICAgIGNvbnN0IG9rID0gYXdhaXQgZ2V0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCBpc1JlZmVyZW5jZWQ6IChrKSA9PiBrID09PSBTQ0hFTUUua2V5KHNoYSkgfSk7XG4gICAgZXhwZWN0KG9rLm9rKS50b0JlKHRydWUpO1xuICAgIGlmIChvay5vaykgZXhwZWN0KG5ldyBVaW50OEFycmF5KG9rLm9iamVjdC5ib2R5KSkudG9FcXVhbChCWVRFUyk7XG4gIH0pO1xuXG4gIGl0KCc0MDRzIHdoZW4gdGhlIGdhdGUgcGFzc2VzIGJ1dCBubyBieXRlcyBhcmUgc3RvcmVkLCBhbmQgNDAwcyBhIGJhZCBoYXNoJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3Qgc2hhID0gYXdhaXQgc2hhMjU2SGV4KEJZVEVTKTtcbiAgICBleHBlY3QoYXdhaXQgZ2V0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCBpc1JlZmVyZW5jZWQ6ICgpID0+IHRydWUgfSkpXG4gICAgICAudG9FcXVhbCh7IG9rOiBmYWxzZSwgc3RhdHVzOiA0MDQsIGVycm9yOiAnbm90X2ZvdW5kJyB9KTtcbiAgICBleHBlY3QoYXdhaXQgZ2V0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiAnbm9wZScsIHNjaGVtZTogU0NIRU1FIH0pKVxuICAgICAgLnRvRXF1YWwoeyBvazogZmFsc2UsIHN0YXR1czogNDAwLCBlcnJvcjogJ2ludmFsaWRfc2hhJyB9KTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ2djSWZVbnJlZmVyZW5jZWQnLCAoKSA9PiB7XG4gIGl0KCdkZWxldGVzIHRoZSBibG9iIGlmZiBubyBsaXZlIHJlZmVyZW5jZSByZW1haW5zJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHN0b3JlID0gbWVtb3J5QmxvYlN0b3JlKCk7XG4gICAgY29uc3Qgc2hhID0gYXdhaXQgc2hhMjU2SGV4KEJZVEVTKTtcbiAgICBjb25zdCBrZXkgPSBTQ0hFTUUua2V5KHNoYSk7XG4gICAgYXdhaXQgcHV0Q29udGVudEFkZHJlc3NlZChzdG9yZSwgeyBoYXNoOiBzaGEsIHNjaGVtZTogU0NIRU1FLCByZWFkQm9keTogYm9keU9mKEJZVEVTKSwgbWF4Qnl0ZXM6IE1BWCB9KTtcblxuICAgIC8vIFN0aWxsIHJlZmVyZW5jZWQg4oeSIGtlcHQuXG4gICAgZXhwZWN0KGF3YWl0IGdjSWZVbnJlZmVyZW5jZWQoc3RvcmUsIGtleSwgKCkgPT4gdHJ1ZSkpLnRvQmUoZmFsc2UpO1xuICAgIGV4cGVjdChzdG9yZS5kYXRhLmhhcyhrZXkpKS50b0JlKHRydWUpO1xuXG4gICAgLy8gTm8gbG9uZ2VyIHJlZmVyZW5jZWQg4oeSIGNvbGxlY3RlZC5cbiAgICBleHBlY3QoYXdhaXQgZ2NJZlVucmVmZXJlbmNlZChzdG9yZSwga2V5LCAoKSA9PiBmYWxzZSkpLnRvQmUodHJ1ZSk7XG4gICAgZXhwZWN0KHN0b3JlLmRhdGEuaGFzKGtleSkpLnRvQmUoZmFsc2UpO1xuICB9KTtcbn0pO1xuIl0sImZpbGUiOiIvc3JjL2Jsb2Itc3RvcmUudGVzdC50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2FydGlmYWN0LXJlZ2lzdHJ5L3NyYy9ibG9iLXN0b3JlLnRlc3QudHMiLCIvc3JjL2Jsb2Itc3RvcmUudGVzdC50cyIsW11d