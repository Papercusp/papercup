__vite_ssr_exportName__("draftResponse", () => { try { return draftResponse } catch {} });
__vite_ssr_exportName__("creatorDraftsRoute", () => { try { return creatorDraftsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["audit","getCreatorDraft","insertCreatorDraft","listCreatorDrafts","markHarnessUnlisted","setCreatorDraftArtifact","setCreatorDraftState","insertHarness","normalizeListingKind"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","isCupboardOperator","resolveGithubBearer"]});



const HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const CONTENT_TYPE_RE = /^[^\s/]+\/[A-Za-z0-9.+-]+(?:\s*;.*)?$/;
const MAX_DRAFT_BYTES = 512 * 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1e3;
function uuidv4() {
  return crypto.randomUUID();
}
function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value) {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest("SHA-256", input));
}
function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function jsonBody(c) {
  return c.req.json().catch(() => ({}));
}
function error(c, field, reason, status = 400) {
  return c.json({ error: "invalid_field", field, reason }, status);
}
function authError(c, e) {
  if (e instanceof __vite_ssr_import_2__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
  return null;
}
function draftResponse(draft, uploadUrl) {
  return {
    id: draft.id,
    state: draft.state,
    listing_kind: draft.listing_kind,
    listing_ref: draft.listing_ref,
    title: draft.title,
    description: draft.description,
    artifact: draft.artifact_content_hash ? {
      content_hash: draft.artifact_content_hash,
      size_bytes: draft.artifact_size_bytes,
      content_type: draft.artifact_content_type,
      storage_key: draft.artifact_key
    } : null,
    review: draft.reviewed_at ? { reviewed_at: draft.reviewed_at, reviewed_by: draft.reviewed_by_github_user_id, reason: draft.review_reason } : null,
    published_listing_id: draft.published_listing_id,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    ...uploadUrl ? { upload_url: uploadUrl, upload_expires_at: draft.upload_expires_at } : {}
  };
};
function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "manifest", reason: "object_required" };
  const value = raw;
  const kind = (0,__vite_ssr_import_1__.normalizeListingKind)(value.listing_kind);
  if (!kind) return { ok: false, field: "listing_kind", reason: "unknown_kind" };
  const listingRef = value.listing_ref == null ? null : value.listing_ref;
  if (kind !== "harness" && (typeof listingRef !== "string" || !REF_RE.test(listingRef))) {
    return { ok: false, field: "listing_ref", reason: "required_safe_ref" };
  };
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title || title.length > 200) return { ok: false, field: "title", reason: "non_empty_max_200" };
  const description = value.description == null ? null : value.description;
  if (description != null && (typeof description !== "string" || description.length > 1e3)) {
    return { ok: false, field: "description", reason: "string_max_1000" };
  };
  if (!Number.isSafeInteger(value.github_repository_id) || value.github_repository_id <= 0) {
    return { ok: false, field: "github_repository_id", reason: "positive_integer_required" };
  };
  for (const field of ["github_owner", "github_name", "github_url"]) {
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 500) {
      return { ok: false, field, reason: "non_empty_string_required" };
    }
  };
  const artifact = value.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { ok: false, field: "artifact", reason: "object_required" };
  };
  const a = artifact;
  if (typeof a.content_hash !== "string" || !HASH_RE.test(a.content_hash)) {
    return { ok: false, field: "artifact.content_hash", reason: "sha256_hash_required" };
  };
  if (!Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0 || a.size_bytes > MAX_DRAFT_BYTES) {
    return { ok: false, field: "artifact.size_bytes", reason: `positive_integer_max_${MAX_DRAFT_BYTES}` };
  };
  if (typeof a.content_type !== "string" || !CONTENT_TYPE_RE.test(a.content_type)) {
    return { ok: false, field: "artifact.content_type", reason: "mime_type_required" };
  };
  if (value.blueprint_kind === "identity") {
    return { ok: false, field: "blueprint_kind", reason: "identity_requires_direct_publish" };
  };
  return {
    ok: true,
    manifest: {
      ...value,
      listing_kind: kind,
      listing_ref: listingRef,
      title,
      description,
      github_repository_id: value.github_repository_id,
      github_owner: value.github_owner,
      github_name: value.github_name,
      github_url: value.github_url,
      artifact: {
        content_hash: a.content_hash.toLowerCase(),
        size_bytes: a.size_bytes,
        content_type: a.content_type
      }
    }
  };
}
async function requireUser(c) {
  try {
    return await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw);
  } catch (e) {
    return authError(c, e) ?? Promise.reject(e);
  }
}
async function ownerOrOperator(c, draft) {
  const user = await requireUser(c);
  if (user instanceof Response) return user;
  if (user.id === draft.owner_github_user_id || (0,__vite_ssr_import_2__.isCupboardOperator)(user.id, c.env)) return user;
  return c.json({ error: "forbidden" }, 403);
}
function creatorDraftsRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.post("/creator-drafts", async (c) => {
    const user = await requireUser(c);
    if (user instanceof Response) return user;
    const body = await jsonBody(c);
    const parsed = validateManifest(body.manifest ?? body);
    if (!parsed.ok) return error(c, parsed.field, parsed.reason);
    const manifest = parsed.manifest;
    const now = Date.now();
    const id = uuidv4();
    const uploadToken = token();
    const expires = now + UPLOAD_TTL_MS;
    const manifestJson = JSON.stringify(manifest);
    await (0,__vite_ssr_import_1__.insertCreatorDraft)(c.env.DB, {
      id,
      owner_github_user_id: user.id,
      owner_github_login: user.login,
      listing_kind: manifest.listing_kind,
      listing_ref: manifest.listing_ref ?? null,
      title: manifest.title,
      description: manifest.description ?? null,
      manifest_json: manifestJson,
      provenance_json: JSON.stringify({
        pipeline: "creator-draft-v1",
        owner_github_user_id: user.id,
        owner_github_login: user.login,
        manifest_sha256: await sha256(manifestJson),
        created_at: now
      }),
      upload_token_hash: await sha256(uploadToken),
      upload_expires_at: expires,
      created_at: now
    });
    const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, id);
    if (!draft) return c.json({ error: "draft_create_failed" }, 500);
    const uploadUrl = `${new URL(c.req.url).origin}/creator-drafts/${encodeURIComponent(id)}/artifact?token=${uploadToken}`;
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "creator_draft_created", { id, owner_github_user_id: user.id, listing_kind: manifest.listing_kind });
    return c.json(draftResponse(draft, uploadUrl), 201);
  });
  app.get("/creator-drafts/:id", async (c) => {
    const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, c.req.param("id"));
    if (!draft) return c.json({ error: "not_found" }, 404);
    const auth = await ownerOrOperator(c, draft);
    if (auth instanceof Response) return auth;
    return c.json(draftResponse(draft));
  });
  app.put("/creator-drafts/:id/artifact", async (c) => {
    const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, c.req.param("id"));
    if (!draft) return c.json({ error: "not_found" }, 404);
    if (draft.state !== "draft") return c.json({ error: "draft_not_uploadable", state: draft.state }, 409);
    const supplied = c.req.header("x-upload-token") ?? new URL(c.req.url).searchParams.get("token") ?? "";
    if (!supplied || !draft.upload_token_hash || draft.upload_expires_at == null || Date.now() >= draft.upload_expires_at) {
      return c.json({ error: "upload_token_expired" }, 410);
    };
    if (await sha256(supplied) !== draft.upload_token_hash) return c.json({ error: "upload_token_invalid" }, 403);
    const manifest = JSON.parse(draft.manifest_json);
    const key = `artifacts/cupboard/sha256/${manifest.artifact.content_hash.slice("sha256:".length)}`;
    if (await c.env.ARTIFACTS.head(key)) return c.json({ error: "artifact_exists" }, 409);
    const declaredLength = c.req.header("content-length");
    if (declaredLength != null && Number(declaredLength) !== manifest.artifact.size_bytes) {
      return c.json({ error: "artifact_size_mismatch", expected: manifest.artifact.size_bytes }, 400);
    };
    const bytes = await c.req.raw.arrayBuffer();
    if (bytes.byteLength !== manifest.artifact.size_bytes) {
      return c.json({ error: "artifact_size_mismatch", expected: manifest.artifact.size_bytes, actual: bytes.byteLength }, 400);
    };
    const actualHash = `sha256:${await sha256(bytes)}`;
    if (actualHash !== manifest.artifact.content_hash) {
      return c.json({ error: "artifact_hash_mismatch", expected: manifest.artifact.content_hash, actual: actualHash }, 400);
    };
    await c.env.ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: manifest.artifact.content_type },
      customMetadata: { draftId: draft.id, contentHash: actualHash, ownerGithubUserId: String(draft.owner_github_user_id) }
    });
    const changes = await (0,__vite_ssr_import_1__.setCreatorDraftArtifact)(c.env.DB, draft.id, {
      key,
      contentHash: actualHash,
      sizeBytes: bytes.byteLength,
      contentType: manifest.artifact.content_type,
      now: Date.now()
    });
    if (changes !== 1) return c.json({ error: "draft_upload_race" }, 409);
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, Date.now(), "creator_draft_artifact_uploaded", { id: draft.id, artifact_key: key, content_hash: actualHash });
    return c.json({ ok: true, id: draft.id, artifact: { storage_key: key, content_hash: actualHash, size_bytes: bytes.byteLength } });
  });
  app.post("/creator-drafts/:id/submit", async (c) => {
    const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, c.req.param("id"));
    if (!draft) return c.json({ error: "not_found" }, 404);
    const user = await ownerOrOperator(c, draft);
    if (user instanceof Response) return user;
    if (draft.state !== "draft") return c.json({ error: "invalid_state", state: draft.state }, 409);
    if (!draft.artifact_key || !draft.artifact_content_hash || draft.artifact_size_bytes == null) {
      return c.json({ error: "artifact_required" }, 409);
    };
    const stored = await c.env.ARTIFACTS.head(draft.artifact_key);
    if (!stored || stored.size !== draft.artifact_size_bytes) return c.json({ error: "artifact_missing_or_changed" }, 409);
    const changes = await (0,__vite_ssr_import_1__.setCreatorDraftState)(c.env.DB, draft.id, "draft", "submitted", Date.now());
    if (changes !== 1) return c.json({ error: "state_changed" }, 409);
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, Date.now(), "creator_draft_submitted", { id: draft.id, submitted_by_github_user_id: user.id });
    return c.json({ ok: true, id: draft.id, state: "submitted" });
  });
  for (const action of ["yank", "revoke"]) {
    app.post(`/creator-drafts/:id/${action}`, async (c) => {
      const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, c.req.param("id"));
      if (!draft) return c.json({ error: "not_found" }, 404);
      const user = await ownerOrOperator(c, draft);
      if (user instanceof Response) return user;
      if (!draft.published_listing_id) return c.json({ error: "not_published" }, 409);
      if (action === "yank" && draft.state === "yanked") return c.json({ ok: true, already_yanked: true });
      if (action === "revoke" && draft.state === "revoked") return c.json({ ok: true, already_revoked: true });
      if (draft.state !== "published" && !(action === "revoke" && draft.state === "yanked")) {
        return c.json({ error: "invalid_state", state: draft.state }, 409);
      };
      const now = Date.now();
      await (0,__vite_ssr_import_1__.markHarnessUnlisted)(c.env.DB, draft.published_listing_id, `creator_draft:${draft.id}:${action}`, now);
      const from = draft.state;
      const to = action === "yank" ? "yanked" : "revoked";
      const changes = await (0,__vite_ssr_import_1__.setCreatorDraftState)(c.env.DB, draft.id, from, to, now);
      if (changes !== 1) return c.json({ error: "state_changed" }, 409);
      await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, `creator_draft_${action}ed`, { id: draft.id, listing_id: draft.published_listing_id, by_github_user_id: user.id });
      return c.json({ ok: true, id: draft.id, state: to });
    });
  };
  app.get("/admin/creator-drafts", async (c) => {
    const op = await requireOperatorForDraft(c);
    if (op instanceof Response) return op;
    const raw = new URL(c.req.url).searchParams.get("state");
    const state = raw === "draft" || raw === "submitted" || raw === "approved" || raw === "rejected" || raw === "published" || raw === "yanked" || raw === "revoked" ? raw : "submitted";
    const drafts = await (0,__vite_ssr_import_1__.listCreatorDrafts)(c.env.DB, { state });
    return c.json({ state, drafts: drafts.map((d) => draftResponse(d)) });
  });
  app.post("/admin/creator-drafts/:id/review", async (c) => {
    const op = await requireOperatorForDraft(c);
    if (op instanceof Response) return op;
    const draft = await (0,__vite_ssr_import_1__.getCreatorDraft)(c.env.DB, c.req.param("id"));
    if (!draft) return c.json({ error: "not_found" }, 404);
    if (draft.state !== "submitted") return c.json({ error: "not_submitted", state: draft.state }, 409);
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (body.decision !== "approve" && body.decision !== "reject") return error(c, "decision", "approve_or_reject");
    if (body.reason != null && (typeof body.reason !== "string" || body.reason.length > 1e3)) return error(c, "reason", "string_max_1000");
    const now = Date.now();
    if (body.decision === "reject") {
      const changes2 = await (0,__vite_ssr_import_1__.setCreatorDraftState)(c.env.DB, draft.id, "submitted", "rejected", now, { reviewedBy: op.id, reviewReason: body.reason?.trim() || null });
      if (changes2 !== 1) return c.json({ error: "state_changed" }, 409);
      await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "creator_draft_review_rejected", { id: draft.id, operator_github_user_id: op.id });
      return c.json({ ok: true, id: draft.id, state: "rejected" });
    };
    const manifest = JSON.parse(draft.manifest_json);
    if (!draft.artifact_content_hash || !draft.artifact_key || draft.artifact_size_bytes == null) return c.json({ error: "artifact_required" }, 409);
    const listingId = uuidv4();
    try {
      await (0,__vite_ssr_import_1__.insertHarness)(c.env.DB, {
        id: listingId,
        listing_kind: manifest.listing_kind,
        project_ref: manifest.project_ref ?? null,
        listing_ref: manifest.listing_kind === "harness" ? null : manifest.listing_ref ?? null,
        github_repository_id: manifest.github_repository_id,
        github_owner: manifest.github_owner,
        github_name: manifest.github_name,
        github_url: manifest.github_url,
        title: manifest.title,
        description: manifest.description ?? null,
        topic_hex: manifest.topic_hex ?? null,
        publisher_github_user_id: draft.owner_github_user_id,
        publisher_github_login: draft.owner_github_login,
        provides_tools: Array.isArray(manifest.provides_tools) ? JSON.stringify(manifest.provides_tools) : null,
        uses_tools: Array.isArray(manifest.uses_tools) ? JSON.stringify(manifest.uses_tools) : null,
        provides_events: Array.isArray(manifest.provides_events) ? JSON.stringify(manifest.provides_events) : null,
        requires_events: Array.isArray(manifest.requires_events) ? JSON.stringify(manifest.requires_events) : null,
        requires_rubrics: Array.isArray(manifest.requires_rubrics) ? JSON.stringify(manifest.requires_rubrics) : null,
        hive_pubkey: manifest.hive_pubkey ?? null,
        hive_title: manifest.hive_title ?? null,
        blueprint_kind: manifest.blueprint_kind ?? null,
        review_status: "approved",
        delivery_type: manifest.delivery_type ?? null,
        latest_json_url: manifest.latest_json_url ?? null,
        release_repo: manifest.release_repo ?? null,
        icon_url: manifest.icon_url ?? null,
        platforms: Array.isArray(manifest.platforms) ? JSON.stringify(manifest.platforms) : null,
        created_at: now
      });
    } catch {
      return c.json({ error: "listing_publish_conflict" }, 409);
    };
    const changes = await (0,__vite_ssr_import_1__.setCreatorDraftState)(c.env.DB, draft.id, "submitted", "published", now, { reviewedBy: op.id, reviewReason: body.reason?.trim() || null, publishedListingId: listingId });
    if (changes !== 1) return c.json({ error: "state_changed_after_publish", listing_id: listingId }, 409);
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "creator_draft_published", { id: draft.id, listing_id: listingId, operator_github_user_id: op.id, review_status: "approved" });
    return c.json({ ok: true, id: draft.id, state: "published", listing_id: listingId, review_status: "approved" });
  });
  return app;
};
async function requireOperatorForDraft(c) {
  try {
    const user = await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw);
    if (!(0,__vite_ssr_import_2__.isCupboardOperator)(user.id, c.env)) return c.json({ error: "forbidden", reason: "not_an_operator" }, 403);
    return user;
  } catch (e) {
    return authError(c, e) ?? Promise.reject(e);
  }
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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UTtBQUNOLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTywyQkFBMkIsR0FBRyxHQUFHO0FBQUEsSUFDMUQ7QUFDQSxVQUFNLFVBQVUsU0FBTSw0Q0FBcUIsRUFBRSxJQUFJLElBQUksTUFBTSxJQUFJLGFBQWEsYUFBYSxLQUFLLEVBQUUsWUFBWSxHQUFHLElBQUksY0FBZSxLQUFLLFFBQStCLEtBQUssS0FBSyxNQUFNLG9CQUFvQixVQUFVLENBQUM7QUFDck4sUUFBSSxZQUFZLEVBQUcsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLCtCQUErQixZQUFZLFVBQVUsR0FBRyxHQUFHO0FBQ3JHLGFBQU0sNkJBQU0sRUFBRSxJQUFJLElBQUksS0FBSywyQkFBMkIsRUFBRSxJQUFJLE1BQU0sSUFBSSxZQUFZLFdBQVcseUJBQXlCLEdBQUcsSUFBSSxlQUFlLFdBQVcsQ0FBQztBQUN4SixXQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksTUFBTSxJQUFJLE1BQU0sSUFBSSxPQUFPLGFBQWEsWUFBWSxXQUFXLGVBQWUsV0FBVyxDQUFDO0FBQUEsRUFDaEgsQ0FBQztBQUVELFNBQU87QUFDVDtBQUVBLGVBQWUsd0JBQXdCLEdBQWtGO0FBQ3ZILE1BQUk7QUFDRixVQUFNLE9BQU8sU0FBTSwyQ0FBb0IsRUFBRSxJQUFJLEdBQUc7QUFDaEQsUUFBSSxJQUFDLDBDQUFtQixLQUFLLElBQUksRUFBRSxHQUFHLEVBQUcsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGFBQWEsUUFBUSxrQkFBa0IsR0FBRyxHQUFHO0FBQzdHLFdBQU87QUFBQSxFQUNULFNBQVMsR0FBRztBQUNWLFdBQU8sVUFBVSxHQUFHLENBQUMsS0FBSyxRQUFRLE9BQU8sQ0FBQztBQUFBLEVBQzVDO0FBQ0YiLCJuYW1lcyI6WyJjaGFuZ2VzIl0sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbImNyZWF0b3ItZHJhZnRzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKiBBdXRoZW50aWNhdGVkIGNyZWF0b3IgYXJ0aWZhY3QgZHJhZnRzIChzaGFyZWQtcG90IERBTyBwbGFuIFAtMDA3KS5cbiAqXG4gKiBBIGRyYWZ0IGlzIHRoZSBwcml2YXRlLCByZXZpZXdhYmxlIGJvdW5kYXJ5IGJldHdlZW4gYW4gYXV0aGVudGljYXRlZCBjcmVhdG9yXG4gKiBhbmQgdGhlIHB1YmxpYyBsaXN0aW5nIHRhYmxlLiBUaGUgdXBsb2FkIFVSTCBpcyBhIHNob3J0LWxpdmVkIGNhcGFiaWxpdHk6IGl0XG4gKiBpcyBiYWNrZWQgYnkgYSBvbmUtdGltZSB0b2tlbiBoYXNoIGluIEQxLCB3cml0ZXMgdG8gdGhlIGV4aXN0aW5nIFIyIGJ1Y2tldCxcbiAqIGFuZCBpcyBjb25zdW1lZCBhZnRlciBhIGhhc2gvc2l6ZSBjaGVjay4gVGhpcyBrZWVwcyB0aGUgaG9zdGVkIFIyIHBhdGggdG9kYXlcbiAqIHdoaWxlIHByZXNlcnZpbmcgdGhlIHByb3ZpZGVyLW5ldXRyYWwgQXJ0aWZhY3RTdG9yZSBzZWFtIGZvciBhIGxhdGVyIG1vdmUuXG4gKi9cblxuaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0IH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQge1xuICBhdWRpdCxcbiAgZ2V0Q3JlYXRvckRyYWZ0LFxuICBpbnNlcnRDcmVhdG9yRHJhZnQsXG4gIGxpc3RDcmVhdG9yRHJhZnRzLFxuICBtYXJrSGFybmVzc1VubGlzdGVkLFxuICBzZXRDcmVhdG9yRHJhZnRBcnRpZmFjdCxcbiAgc2V0Q3JlYXRvckRyYWZ0U3RhdGUsXG4gIGluc2VydEhhcm5lc3MsXG4gIG5vcm1hbGl6ZUxpc3RpbmdLaW5kLFxuICB0eXBlIENyZWF0b3JEcmFmdFJvdyxcbiAgdHlwZSBMaXN0aW5nS2luZCxcbn0gZnJvbSAnLi4vZGIudHMnO1xuaW1wb3J0IHsgQXV0aEVycm9yLCBpc0N1cGJvYXJkT3BlcmF0b3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcblxuY29uc3QgSEFTSF9SRSA9IC9ec2hhMjU2OlswLTlhLWZdezY0fSQvaTtcbmNvbnN0IFJFRl9SRSA9IC9eW0EtWmEtejAtOS5fLy1dezEsMjAwfSQvO1xuY29uc3QgQ09OVEVOVF9UWVBFX1JFID0gL15bXlxccy9dK1xcL1tBLVphLXowLTkuKy1dKyg/Olxccyo7LiopPyQvO1xuY29uc3QgTUFYX0RSQUZUX0JZVEVTID0gNTEyICogMTAyNCAqIDEwMjQ7XG5jb25zdCBVUExPQURfVFRMX01TID0gMTUgKiA2MCAqIDEwMDA7XG5cbmludGVyZmFjZSBEcmFmdE1hbmlmZXN0IHtcbiAgbGlzdGluZ19raW5kOiBMaXN0aW5nS2luZDtcbiAgbGlzdGluZ19yZWY/OiBzdHJpbmcgfCBudWxsO1xuICBnaXRodWJfcmVwb3NpdG9yeV9pZDogbnVtYmVyO1xuICBnaXRodWJfb3duZXI6IHN0cmluZztcbiAgZ2l0aHViX25hbWU6IHN0cmluZztcbiAgZ2l0aHViX3VybDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZyB8IG51bGw7XG4gIHRvcGljX2hleD86IHN0cmluZyB8IG51bGw7XG4gIHByb2plY3RfcmVmPzogc3RyaW5nIHwgbnVsbDtcbiAgYmx1ZXByaW50X2tpbmQ/OiBzdHJpbmcgfCBudWxsO1xuICBwcm92aWRlc190b29scz86IHVua25vd247XG4gIC8vIFRoZSBDT05TVU1QVElPTiBoYWxmIG9mIHRoZSB0b29sIGF4aXMgKG1pZ3JhdGlvbiAwMzMgLyBXSS0xMDAwMTc0NykuIEl0IGlzXG4gIC8vIGRlY2xhcmVkIGFuZCBtYXBwZWQgYmVzaWRlIGBwcm92aWRlc190b29sc2AgZGVsaWJlcmF0ZWx5OiB0aGlzIHJvdXRlIGlzIHRoZVxuICAvLyBTRUNPTkQgcHVibGlzaCBwYXRoIGludG8gYGhhcm5lc3Nlc2AsIGFuZCB0aGUgb3JpZ2luYWwgZGVmZWN0IHdhcyBleGFjdGx5IGFcbiAgLy8gZmllbGQgb25lIHBhdGggY2FycmllZCBhbmQgdGhlIG90aGVyIHNpbGVudGx5IGRyb3BwZWQuXG4gIHVzZXNfdG9vbHM/OiB1bmtub3duO1xuICBwcm92aWRlc19ldmVudHM/OiB1bmtub3duO1xuICByZXF1aXJlc19ldmVudHM/OiB1bmtub3duO1xuICByZXF1aXJlc19ydWJyaWNzPzogdW5rbm93bjtcbiAgaGl2ZV9wdWJrZXk/OiBzdHJpbmcgfCBudWxsO1xuICBoaXZlX3RpdGxlPzogc3RyaW5nIHwgbnVsbDtcbiAgZGVsaXZlcnlfdHlwZT86ICdzdGFuZGFsb25lJyB8ICdidW5kbGUnIHwgbnVsbDtcbiAgbGF0ZXN0X2pzb25fdXJsPzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZV9yZXBvPzogc3RyaW5nIHwgbnVsbDtcbiAgaWNvbl91cmw/OiBzdHJpbmcgfCBudWxsO1xuICBwbGF0Zm9ybXM/OiB1bmtub3duO1xuICBhcnRpZmFjdDoge1xuICAgIGNvbnRlbnRfaGFzaDogc3RyaW5nO1xuICAgIHNpemVfYnl0ZXM6IG51bWJlcjtcbiAgICBjb250ZW50X3R5cGU6IHN0cmluZztcbiAgfTtcbn1cblxuaW50ZXJmYWNlIENyZWF0ZURyYWZ0Qm9keSB7XG4gIG1hbmlmZXN0PzogdW5rbm93bjtcbiAgbGlzdGluZ19raW5kPzogdW5rbm93bjtcbiAgbGlzdGluZ19yZWY/OiB1bmtub3duO1xuICB0aXRsZT86IHVua25vd247XG4gIGRlc2NyaXB0aW9uPzogdW5rbm93bjtcbiAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ/OiB1bmtub3duO1xuICBnaXRodWJfb3duZXI/OiB1bmtub3duO1xuICBnaXRodWJfbmFtZT86IHVua25vd247XG4gIGdpdGh1Yl91cmw/OiB1bmtub3duO1xuICBhcnRpZmFjdD86IHVua25vd247XG59XG5cbmZ1bmN0aW9uIHV1aWR2NCgpOiBzdHJpbmcge1xuICByZXR1cm4gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbn1cblxuZnVuY3Rpb24gaGV4KGJ5dGVzOiBBcnJheUJ1ZmZlcik6IHN0cmluZyB7XG4gIHJldHVybiBBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGJ5dGVzKSwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsICcwJykpLmpvaW4oJycpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzaGEyNTYodmFsdWU6IHN0cmluZyB8IEFycmF5QnVmZmVyKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgaW5wdXQgPSB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHZhbHVlKSA6IHZhbHVlO1xuICByZXR1cm4gaGV4KGF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KCdTSEEtMjU2JywgaW5wdXQpKTtcbn1cblxuZnVuY3Rpb24gdG9rZW4oKTogc3RyaW5nIHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheSgzMik7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnl0ZXMpO1xuICByZXR1cm4gQXJyYXkuZnJvbShieXRlcywgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsICcwJykpLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBqc29uQm9keShjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9Pik6IFByb21pc2U8Q3JlYXRlRHJhZnRCb2R5PiB7XG4gIHJldHVybiBjLnJlcS5qc29uPENyZWF0ZURyYWZ0Qm9keT4oKS5jYXRjaCgoKSA9PiAoe30pKTtcbn1cblxuZnVuY3Rpb24gZXJyb3IoYzogQ29udGV4dDx7IEJpbmRpbmdzOiBFbnYgfT4sIGZpZWxkOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nLCBzdGF0dXMgPSA0MDApOiBSZXNwb25zZSB7XG4gIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZCwgcmVhc29uIH0sIHN0YXR1cyBhcyA0MDApO1xufVxuXG5mdW5jdGlvbiBhdXRoRXJyb3IoYzogQ29udGV4dDx7IEJpbmRpbmdzOiBFbnYgfT4sIGU6IHVua25vd24pOiBSZXNwb25zZSB8IG51bGwge1xuICBpZiAoZSBpbnN0YW5jZW9mIEF1dGhFcnJvcikgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXV0aCcsIHJlYXNvbjogZS5yZWFzb24gfSwgNDAxKTtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkcmFmdFJlc3BvbnNlKGRyYWZ0OiBDcmVhdG9yRHJhZnRSb3csIHVwbG9hZFVybD86IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHtcbiAgICBpZDogZHJhZnQuaWQsXG4gICAgc3RhdGU6IGRyYWZ0LnN0YXRlLFxuICAgIGxpc3Rpbmdfa2luZDogZHJhZnQubGlzdGluZ19raW5kLFxuICAgIGxpc3RpbmdfcmVmOiBkcmFmdC5saXN0aW5nX3JlZixcbiAgICB0aXRsZTogZHJhZnQudGl0bGUsXG4gICAgZGVzY3JpcHRpb246IGRyYWZ0LmRlc2NyaXB0aW9uLFxuICAgIGFydGlmYWN0OiBkcmFmdC5hcnRpZmFjdF9jb250ZW50X2hhc2hcbiAgICAgID8ge1xuICAgICAgICAgIGNvbnRlbnRfaGFzaDogZHJhZnQuYXJ0aWZhY3RfY29udGVudF9oYXNoLFxuICAgICAgICAgIHNpemVfYnl0ZXM6IGRyYWZ0LmFydGlmYWN0X3NpemVfYnl0ZXMsXG4gICAgICAgICAgY29udGVudF90eXBlOiBkcmFmdC5hcnRpZmFjdF9jb250ZW50X3R5cGUsXG4gICAgICAgICAgc3RvcmFnZV9rZXk6IGRyYWZ0LmFydGlmYWN0X2tleSxcbiAgICAgICAgfVxuICAgICAgOiBudWxsLFxuICAgIHJldmlldzogZHJhZnQucmV2aWV3ZWRfYXRcbiAgICAgID8geyByZXZpZXdlZF9hdDogZHJhZnQucmV2aWV3ZWRfYXQsIHJldmlld2VkX2J5OiBkcmFmdC5yZXZpZXdlZF9ieV9naXRodWJfdXNlcl9pZCwgcmVhc29uOiBkcmFmdC5yZXZpZXdfcmVhc29uIH1cbiAgICAgIDogbnVsbCxcbiAgICBwdWJsaXNoZWRfbGlzdGluZ19pZDogZHJhZnQucHVibGlzaGVkX2xpc3RpbmdfaWQsXG4gICAgY3JlYXRlZF9hdDogZHJhZnQuY3JlYXRlZF9hdCxcbiAgICB1cGRhdGVkX2F0OiBkcmFmdC51cGRhdGVkX2F0LFxuICAgIC4uLih1cGxvYWRVcmwgPyB7IHVwbG9hZF91cmw6IHVwbG9hZFVybCwgdXBsb2FkX2V4cGlyZXNfYXQ6IGRyYWZ0LnVwbG9hZF9leHBpcmVzX2F0IH0gOiB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlTWFuaWZlc3QocmF3OiB1bmtub3duKTogeyBvazogdHJ1ZTsgbWFuaWZlc3Q6IERyYWZ0TWFuaWZlc3QgfSB8IHsgb2s6IGZhbHNlOyBmaWVsZDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9IHtcbiAgaWYgKCFyYXcgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyYXcpKSByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnbWFuaWZlc3QnLCByZWFzb246ICdvYmplY3RfcmVxdWlyZWQnIH07XG4gIGNvbnN0IHZhbHVlID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCBraW5kID0gbm9ybWFsaXplTGlzdGluZ0tpbmQodmFsdWUubGlzdGluZ19raW5kKTtcbiAgaWYgKCFraW5kKSByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnbGlzdGluZ19raW5kJywgcmVhc29uOiAndW5rbm93bl9raW5kJyB9O1xuICBjb25zdCBsaXN0aW5nUmVmID0gdmFsdWUubGlzdGluZ19yZWYgPT0gbnVsbCA/IG51bGwgOiB2YWx1ZS5saXN0aW5nX3JlZjtcbiAgaWYgKGtpbmQgIT09ICdoYXJuZXNzJyAmJiAodHlwZW9mIGxpc3RpbmdSZWYgIT09ICdzdHJpbmcnIHx8ICFSRUZfUkUudGVzdChsaXN0aW5nUmVmKSkpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnbGlzdGluZ19yZWYnLCByZWFzb246ICdyZXF1aXJlZF9zYWZlX3JlZicgfTtcbiAgfVxuICBjb25zdCB0aXRsZSA9IHR5cGVvZiB2YWx1ZS50aXRsZSA9PT0gJ3N0cmluZycgPyB2YWx1ZS50aXRsZS50cmltKCkgOiAnJztcbiAgaWYgKCF0aXRsZSB8fCB0aXRsZS5sZW5ndGggPiAyMDApIHJldHVybiB7IG9rOiBmYWxzZSwgZmllbGQ6ICd0aXRsZScsIHJlYXNvbjogJ25vbl9lbXB0eV9tYXhfMjAwJyB9O1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IHZhbHVlLmRlc2NyaXB0aW9uID09IG51bGwgPyBudWxsIDogdmFsdWUuZGVzY3JpcHRpb247XG4gIGlmIChkZXNjcmlwdGlvbiAhPSBudWxsICYmICh0eXBlb2YgZGVzY3JpcHRpb24gIT09ICdzdHJpbmcnIHx8IGRlc2NyaXB0aW9uLmxlbmd0aCA+IDEwMDApKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBmaWVsZDogJ2Rlc2NyaXB0aW9uJywgcmVhc29uOiAnc3RyaW5nX21heF8xMDAwJyB9O1xuICB9XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUuZ2l0aHViX3JlcG9zaXRvcnlfaWQpIHx8ICh2YWx1ZS5naXRodWJfcmVwb3NpdG9yeV9pZCBhcyBudW1iZXIpIDw9IDApIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnZ2l0aHViX3JlcG9zaXRvcnlfaWQnLCByZWFzb246ICdwb3NpdGl2ZV9pbnRlZ2VyX3JlcXVpcmVkJyB9O1xuICB9XG4gIGZvciAoY29uc3QgZmllbGQgb2YgWydnaXRodWJfb3duZXInLCAnZ2l0aHViX25hbWUnLCAnZ2l0aHViX3VybCddIGFzIGNvbnN0KSB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZVtmaWVsZF0gIT09ICdzdHJpbmcnIHx8ICF2YWx1ZVtmaWVsZF0udHJpbSgpIHx8IHZhbHVlW2ZpZWxkXS5sZW5ndGggPiA1MDApIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZmllbGQsIHJlYXNvbjogJ25vbl9lbXB0eV9zdHJpbmdfcmVxdWlyZWQnIH07XG4gICAgfVxuICB9XG4gIGNvbnN0IGFydGlmYWN0ID0gdmFsdWUuYXJ0aWZhY3Q7XG4gIGlmICghYXJ0aWZhY3QgfHwgdHlwZW9mIGFydGlmYWN0ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGFydGlmYWN0KSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZmllbGQ6ICdhcnRpZmFjdCcsIHJlYXNvbjogJ29iamVjdF9yZXF1aXJlZCcgfTtcbiAgfVxuICBjb25zdCBhID0gYXJ0aWZhY3QgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICh0eXBlb2YgYS5jb250ZW50X2hhc2ggIT09ICdzdHJpbmcnIHx8ICFIQVNIX1JFLnRlc3QoYS5jb250ZW50X2hhc2gpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBmaWVsZDogJ2FydGlmYWN0LmNvbnRlbnRfaGFzaCcsIHJlYXNvbjogJ3NoYTI1Nl9oYXNoX3JlcXVpcmVkJyB9O1xuICB9XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoYS5zaXplX2J5dGVzKSB8fCAoYS5zaXplX2J5dGVzIGFzIG51bWJlcikgPD0gMCB8fCAoYS5zaXplX2J5dGVzIGFzIG51bWJlcikgPiBNQVhfRFJBRlRfQllURVMpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnYXJ0aWZhY3Quc2l6ZV9ieXRlcycsIHJlYXNvbjogYHBvc2l0aXZlX2ludGVnZXJfbWF4XyR7TUFYX0RSQUZUX0JZVEVTfWAgfTtcbiAgfVxuICBpZiAodHlwZW9mIGEuY29udGVudF90eXBlICE9PSAnc3RyaW5nJyB8fCAhQ09OVEVOVF9UWVBFX1JFLnRlc3QoYS5jb250ZW50X3R5cGUpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBmaWVsZDogJ2FydGlmYWN0LmNvbnRlbnRfdHlwZScsIHJlYXNvbjogJ21pbWVfdHlwZV9yZXF1aXJlZCcgfTtcbiAgfVxuICAvLyBBbiBpZGVudGl0eSBsaXN0aW5nJ3MgZGVjbGFyZWQgc3VyZmFjZSAobWlncmF0aW9uIDAzNSkgaXMgZGVyaXZlZCBmcm9tIGl0c1xuICAvLyBzaWduZWQgcmVsZWFzZSBjbG9zdXJlIGF0IGRpcmVjdCBwdWJsaXNoLiBBIGRyYWZ0IHVwbG9hZHMgYW4gYXJ0aWZhY3Qgd2l0aFxuICAvLyBubyBzaWduZWQgY2xvc3VyZSwgc28gaXQgY2Fubm90IHB1Ymxpc2ggb25lOiB0aGUgaW5zdGFsbCBnYXRlIHdvdWxkIHJlZnVzZVxuICAvLyB0aGUgbGlzdGluZyBhcyBzdXJmYWNlLW1pc3NpbmcgYW55d2F5LlxuICBpZiAodmFsdWUuYmx1ZXByaW50X2tpbmQgPT09ICdpZGVudGl0eScpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGZpZWxkOiAnYmx1ZXByaW50X2tpbmQnLCByZWFzb246ICdpZGVudGl0eV9yZXF1aXJlc19kaXJlY3RfcHVibGlzaCcgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIG1hbmlmZXN0OiB7XG4gICAgICAuLi4odmFsdWUgYXMgT21pdDxEcmFmdE1hbmlmZXN0LCAnbGlzdGluZ19raW5kJyB8ICdsaXN0aW5nX3JlZicgfCAndGl0bGUnIHwgJ2Rlc2NyaXB0aW9uJyB8ICdhcnRpZmFjdCc+KSxcbiAgICAgIGxpc3Rpbmdfa2luZDoga2luZCxcbiAgICAgIGxpc3RpbmdfcmVmOiBsaXN0aW5nUmVmIGFzIHN0cmluZyB8IG51bGwsXG4gICAgICB0aXRsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBkZXNjcmlwdGlvbiBhcyBzdHJpbmcgfCBudWxsLFxuICAgICAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ6IHZhbHVlLmdpdGh1Yl9yZXBvc2l0b3J5X2lkIGFzIG51bWJlcixcbiAgICAgIGdpdGh1Yl9vd25lcjogdmFsdWUuZ2l0aHViX293bmVyIGFzIHN0cmluZyxcbiAgICAgIGdpdGh1Yl9uYW1lOiB2YWx1ZS5naXRodWJfbmFtZSBhcyBzdHJpbmcsXG4gICAgICBnaXRodWJfdXJsOiB2YWx1ZS5naXRodWJfdXJsIGFzIHN0cmluZyxcbiAgICAgIGFydGlmYWN0OiB7XG4gICAgICAgIGNvbnRlbnRfaGFzaDogKGEuY29udGVudF9oYXNoIGFzIHN0cmluZykudG9Mb3dlckNhc2UoKSxcbiAgICAgICAgc2l6ZV9ieXRlczogYS5zaXplX2J5dGVzIGFzIG51bWJlcixcbiAgICAgICAgY29udGVudF90eXBlOiBhLmNvbnRlbnRfdHlwZSBhcyBzdHJpbmcsXG4gICAgICB9LFxuICAgIH0sXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVVc2VyKGM6IENvbnRleHQ8eyBCaW5kaW5nczogRW52IH0+KTogUHJvbWlzZTx7IGlkOiBudW1iZXI7IGxvZ2luOiBzdHJpbmcgfSB8IFJlc3BvbnNlPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBhdXRoRXJyb3IoYywgZSkgPz8gUHJvbWlzZS5yZWplY3QoZSk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gb3duZXJPck9wZXJhdG9yKFxuICBjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9PixcbiAgZHJhZnQ6IENyZWF0b3JEcmFmdFJvdyxcbik6IFByb21pc2U8eyBpZDogbnVtYmVyOyBsb2dpbjogc3RyaW5nIH0gfCBSZXNwb25zZT4ge1xuICBjb25zdCB1c2VyID0gYXdhaXQgcmVxdWlyZVVzZXIoYyk7XG4gIGlmICh1c2VyIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiB1c2VyO1xuICBpZiAodXNlci5pZCA9PT0gZHJhZnQub3duZXJfZ2l0aHViX3VzZXJfaWQgfHwgaXNDdXBib2FyZE9wZXJhdG9yKHVzZXIuaWQsIGMuZW52KSkgcmV0dXJuIHVzZXI7XG4gIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ZvcmJpZGRlbicgfSwgNDAzKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0b3JEcmFmdHNSb3V0ZSgpOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBIb25vPHsgQmluZGluZ3M6IEVudiB9PigpO1xuXG4gIC8vIENyZWF0ZSBhIHByaXZhdGUgY3JlYXRvciBkcmFmdCBhbmQgbWludCBhIG9uZS10aW1lLCBleHBpcmluZyB1cGxvYWQgVVJMLlxuICBhcHAucG9zdCgnL2NyZWF0b3ItZHJhZnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCB1c2VyID0gYXdhaXQgcmVxdWlyZVVzZXIoYyk7XG4gICAgaWYgKHVzZXIgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIHVzZXI7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGpzb25Cb2R5KGMpO1xuICAgIGNvbnN0IHBhcnNlZCA9IHZhbGlkYXRlTWFuaWZlc3QoYm9keS5tYW5pZmVzdCA/PyBib2R5KTtcbiAgICBpZiAoIXBhcnNlZC5vaykgcmV0dXJuIGVycm9yKGMsIHBhcnNlZC5maWVsZCwgcGFyc2VkLnJlYXNvbik7XG4gICAgY29uc3QgbWFuaWZlc3QgPSBwYXJzZWQubWFuaWZlc3Q7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBpZCA9IHV1aWR2NCgpO1xuICAgIGNvbnN0IHVwbG9hZFRva2VuID0gdG9rZW4oKTtcbiAgICBjb25zdCBleHBpcmVzID0gbm93ICsgVVBMT0FEX1RUTF9NUztcbiAgICBjb25zdCBtYW5pZmVzdEpzb24gPSBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCk7XG4gICAgYXdhaXQgaW5zZXJ0Q3JlYXRvckRyYWZ0KGMuZW52LkRCLCB7XG4gICAgICBpZCxcbiAgICAgIG93bmVyX2dpdGh1Yl91c2VyX2lkOiB1c2VyLmlkLFxuICAgICAgb3duZXJfZ2l0aHViX2xvZ2luOiB1c2VyLmxvZ2luLFxuICAgICAgbGlzdGluZ19raW5kOiBtYW5pZmVzdC5saXN0aW5nX2tpbmQsXG4gICAgICBsaXN0aW5nX3JlZjogbWFuaWZlc3QubGlzdGluZ19yZWYgPz8gbnVsbCxcbiAgICAgIHRpdGxlOiBtYW5pZmVzdC50aXRsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBtYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyBudWxsLFxuICAgICAgbWFuaWZlc3RfanNvbjogbWFuaWZlc3RKc29uLFxuICAgICAgcHJvdmVuYW5jZV9qc29uOiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBpcGVsaW5lOiAnY3JlYXRvci1kcmFmdC12MScsXG4gICAgICAgIG93bmVyX2dpdGh1Yl91c2VyX2lkOiB1c2VyLmlkLFxuICAgICAgICBvd25lcl9naXRodWJfbG9naW46IHVzZXIubG9naW4sXG4gICAgICAgIG1hbmlmZXN0X3NoYTI1NjogYXdhaXQgc2hhMjU2KG1hbmlmZXN0SnNvbiksXG4gICAgICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICAgIH0pLFxuICAgICAgdXBsb2FkX3Rva2VuX2hhc2g6IGF3YWl0IHNoYTI1Nih1cGxvYWRUb2tlbiksXG4gICAgICB1cGxvYWRfZXhwaXJlc19hdDogZXhwaXJlcyxcbiAgICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICB9KTtcbiAgICBjb25zdCBkcmFmdCA9IGF3YWl0IGdldENyZWF0b3JEcmFmdChjLmVudi5EQiwgaWQpO1xuICAgIGlmICghZHJhZnQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2RyYWZ0X2NyZWF0ZV9mYWlsZWQnIH0sIDUwMCk7XG4gICAgY29uc3QgdXBsb2FkVXJsID0gYCR7bmV3IFVSTChjLnJlcS51cmwpLm9yaWdpbn0vY3JlYXRvci1kcmFmdHMvJHtlbmNvZGVVUklDb21wb25lbnQoaWQpfS9hcnRpZmFjdD90b2tlbj0ke3VwbG9hZFRva2VufWA7XG4gICAgYXdhaXQgYXVkaXQoYy5lbnYuREIsIG5vdywgJ2NyZWF0b3JfZHJhZnRfY3JlYXRlZCcsIHsgaWQsIG93bmVyX2dpdGh1Yl91c2VyX2lkOiB1c2VyLmlkLCBsaXN0aW5nX2tpbmQ6IG1hbmlmZXN0Lmxpc3Rpbmdfa2luZCB9KTtcbiAgICByZXR1cm4gYy5qc29uKGRyYWZ0UmVzcG9uc2UoZHJhZnQsIHVwbG9hZFVybCksIDIwMSk7XG4gIH0pO1xuXG4gIC8vIEdFVCBhIGRyYWZ0OiB0aGUgb3duZXIgc2VlcyBwcml2YXRlIG1ldGFkYXRhOyBvcGVyYXRvcnMgbWF5IGluc3BlY3QgaXQuXG4gIGFwcC5nZXQoJy9jcmVhdG9yLWRyYWZ0cy86aWQnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGRyYWZ0ID0gYXdhaXQgZ2V0Q3JlYXRvckRyYWZ0KGMuZW52LkRCLCBjLnJlcS5wYXJhbSgnaWQnKSk7XG4gICAgaWYgKCFkcmFmdCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIGNvbnN0IGF1dGggPSBhd2FpdCBvd25lck9yT3BlcmF0b3IoYywgZHJhZnQpO1xuICAgIGlmIChhdXRoIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBhdXRoO1xuICAgIHJldHVybiBjLmpzb24oZHJhZnRSZXNwb25zZShkcmFmdCkpO1xuICB9KTtcblxuICAvLyBVcGxvYWQgYnl0ZXMgdG8gdGhlIGV4aXN0aW5nIFIyIGJ1Y2tldC4gVGhlIGNhcGFiaWxpdHkgaXMgc2luZ2xlLXVzZSBhbmRcbiAgLy8gdGhlIG9iamVjdCBpcyBjcmVhdGUtb25seSBieSBjb252ZW50aW9uOiBhIHNlY29uZCB1cGxvYWQgY2Fubm90IG92ZXJ3cml0ZVxuICAvLyBhIGNvbnRlbnQtYWRkcmVzc2VkIGFydGlmYWN0IG9yIHNpbGVudGx5IGNoYW5nZSBhIHN1Ym1pdHRlZCBkcmFmdC5cbiAgYXBwLnB1dCgnL2NyZWF0b3ItZHJhZnRzLzppZC9hcnRpZmFjdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgZHJhZnQgPSBhd2FpdCBnZXRDcmVhdG9yRHJhZnQoYy5lbnYuREIsIGMucmVxLnBhcmFtKCdpZCcpKTtcbiAgICBpZiAoIWRyYWZ0KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgaWYgKGRyYWZ0LnN0YXRlICE9PSAnZHJhZnQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdkcmFmdF9ub3RfdXBsb2FkYWJsZScsIHN0YXRlOiBkcmFmdC5zdGF0ZSB9LCA0MDkpO1xuICAgIGNvbnN0IHN1cHBsaWVkID0gYy5yZXEuaGVhZGVyKCd4LXVwbG9hZC10b2tlbicpID8/IG5ldyBVUkwoYy5yZXEudXJsKS5zZWFyY2hQYXJhbXMuZ2V0KCd0b2tlbicpID8/ICcnO1xuICAgIGlmICghc3VwcGxpZWQgfHwgIWRyYWZ0LnVwbG9hZF90b2tlbl9oYXNoIHx8IGRyYWZ0LnVwbG9hZF9leHBpcmVzX2F0ID09IG51bGwgfHwgRGF0ZS5ub3coKSA+PSBkcmFmdC51cGxvYWRfZXhwaXJlc19hdCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndXBsb2FkX3Rva2VuX2V4cGlyZWQnIH0sIDQxMCk7XG4gICAgfVxuICAgIGlmICgoYXdhaXQgc2hhMjU2KHN1cHBsaWVkKSkgIT09IGRyYWZ0LnVwbG9hZF90b2tlbl9oYXNoKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1cGxvYWRfdG9rZW5faW52YWxpZCcgfSwgNDAzKTtcbiAgICBjb25zdCBtYW5pZmVzdCA9IEpTT04ucGFyc2UoZHJhZnQubWFuaWZlc3RfanNvbikgYXMgRHJhZnRNYW5pZmVzdDtcbiAgICBjb25zdCBrZXkgPSBgYXJ0aWZhY3RzL2N1cGJvYXJkL3NoYTI1Ni8ke21hbmlmZXN0LmFydGlmYWN0LmNvbnRlbnRfaGFzaC5zbGljZSgnc2hhMjU2OicubGVuZ3RoKX1gO1xuICAgIGlmIChhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChrZXkpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF9leGlzdHMnIH0sIDQwOSk7XG4gICAgY29uc3QgZGVjbGFyZWRMZW5ndGggPSBjLnJlcS5oZWFkZXIoJ2NvbnRlbnQtbGVuZ3RoJyk7XG4gICAgaWYgKGRlY2xhcmVkTGVuZ3RoICE9IG51bGwgJiYgTnVtYmVyKGRlY2xhcmVkTGVuZ3RoKSAhPT0gbWFuaWZlc3QuYXJ0aWZhY3Quc2l6ZV9ieXRlcykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXJ0aWZhY3Rfc2l6ZV9taXNtYXRjaCcsIGV4cGVjdGVkOiBtYW5pZmVzdC5hcnRpZmFjdC5zaXplX2J5dGVzIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IGJ5dGVzID0gYXdhaXQgYy5yZXEucmF3LmFycmF5QnVmZmVyKCk7XG4gICAgaWYgKGJ5dGVzLmJ5dGVMZW5ndGggIT09IG1hbmlmZXN0LmFydGlmYWN0LnNpemVfYnl0ZXMpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2FydGlmYWN0X3NpemVfbWlzbWF0Y2gnLCBleHBlY3RlZDogbWFuaWZlc3QuYXJ0aWZhY3Quc2l6ZV9ieXRlcywgYWN0dWFsOiBieXRlcy5ieXRlTGVuZ3RoIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IGFjdHVhbEhhc2ggPSBgc2hhMjU2OiR7YXdhaXQgc2hhMjU2KGJ5dGVzKX1gO1xuICAgIGlmIChhY3R1YWxIYXNoICE9PSBtYW5pZmVzdC5hcnRpZmFjdC5jb250ZW50X2hhc2gpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2FydGlmYWN0X2hhc2hfbWlzbWF0Y2gnLCBleHBlY3RlZDogbWFuaWZlc3QuYXJ0aWZhY3QuY29udGVudF9oYXNoLCBhY3R1YWw6IGFjdHVhbEhhc2ggfSwgNDAwKTtcbiAgICB9XG4gICAgYXdhaXQgYy5lbnYuQVJUSUZBQ1RTLnB1dChrZXksIGJ5dGVzLCB7XG4gICAgICBodHRwTWV0YWRhdGE6IHsgY29udGVudFR5cGU6IG1hbmlmZXN0LmFydGlmYWN0LmNvbnRlbnRfdHlwZSB9LFxuICAgICAgY3VzdG9tTWV0YWRhdGE6IHsgZHJhZnRJZDogZHJhZnQuaWQsIGNvbnRlbnRIYXNoOiBhY3R1YWxIYXNoLCBvd25lckdpdGh1YlVzZXJJZDogU3RyaW5nKGRyYWZ0Lm93bmVyX2dpdGh1Yl91c2VyX2lkKSB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBhd2FpdCBzZXRDcmVhdG9yRHJhZnRBcnRpZmFjdChjLmVudi5EQiwgZHJhZnQuaWQsIHtcbiAgICAgIGtleSxcbiAgICAgIGNvbnRlbnRIYXNoOiBhY3R1YWxIYXNoLFxuICAgICAgc2l6ZUJ5dGVzOiBieXRlcy5ieXRlTGVuZ3RoLFxuICAgICAgY29udGVudFR5cGU6IG1hbmlmZXN0LmFydGlmYWN0LmNvbnRlbnRfdHlwZSxcbiAgICAgIG5vdzogRGF0ZS5ub3coKSxcbiAgICB9KTtcbiAgICBpZiAoY2hhbmdlcyAhPT0gMSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZHJhZnRfdXBsb2FkX3JhY2UnIH0sIDQwOSk7XG4gICAgYXdhaXQgYXVkaXQoYy5lbnYuREIsIERhdGUubm93KCksICdjcmVhdG9yX2RyYWZ0X2FydGlmYWN0X3VwbG9hZGVkJywgeyBpZDogZHJhZnQuaWQsIGFydGlmYWN0X2tleToga2V5LCBjb250ZW50X2hhc2g6IGFjdHVhbEhhc2ggfSk7XG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBpZDogZHJhZnQuaWQsIGFydGlmYWN0OiB7IHN0b3JhZ2Vfa2V5OiBrZXksIGNvbnRlbnRfaGFzaDogYWN0dWFsSGFzaCwgc2l6ZV9ieXRlczogYnl0ZXMuYnl0ZUxlbmd0aCB9IH0pO1xuICB9KTtcblxuICAvLyBTdWJtaXQgZm9yIG1haW50YWluZXIgcmV2aWV3IGFmdGVyIHRoZSBhcnRpZmFjdCBpcyBwcmVzZW50IGFuZCByZWNoZWNrZWQuXG4gIGFwcC5wb3N0KCcvY3JlYXRvci1kcmFmdHMvOmlkL3N1Ym1pdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgZHJhZnQgPSBhd2FpdCBnZXRDcmVhdG9yRHJhZnQoYy5lbnYuREIsIGMucmVxLnBhcmFtKCdpZCcpKTtcbiAgICBpZiAoIWRyYWZ0KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgY29uc3QgdXNlciA9IGF3YWl0IG93bmVyT3JPcGVyYXRvcihjLCBkcmFmdCk7XG4gICAgaWYgKHVzZXIgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIHVzZXI7XG4gICAgaWYgKGRyYWZ0LnN0YXRlICE9PSAnZHJhZnQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX3N0YXRlJywgc3RhdGU6IGRyYWZ0LnN0YXRlIH0sIDQwOSk7XG4gICAgaWYgKCFkcmFmdC5hcnRpZmFjdF9rZXkgfHwgIWRyYWZ0LmFydGlmYWN0X2NvbnRlbnRfaGFzaCB8fCBkcmFmdC5hcnRpZmFjdF9zaXplX2J5dGVzID09IG51bGwpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2FydGlmYWN0X3JlcXVpcmVkJyB9LCA0MDkpO1xuICAgIH1cbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBjLmVudi5BUlRJRkFDVFMuaGVhZChkcmFmdC5hcnRpZmFjdF9rZXkpO1xuICAgIGlmICghc3RvcmVkIHx8IHN0b3JlZC5zaXplICE9PSBkcmFmdC5hcnRpZmFjdF9zaXplX2J5dGVzKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF9taXNzaW5nX29yX2NoYW5nZWQnIH0sIDQwOSk7XG4gICAgY29uc3QgY2hhbmdlcyA9IGF3YWl0IHNldENyZWF0b3JEcmFmdFN0YXRlKGMuZW52LkRCLCBkcmFmdC5pZCwgJ2RyYWZ0JywgJ3N1Ym1pdHRlZCcsIERhdGUubm93KCkpO1xuICAgIGlmIChjaGFuZ2VzICE9PSAxKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdzdGF0ZV9jaGFuZ2VkJyB9LCA0MDkpO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBEYXRlLm5vdygpLCAnY3JlYXRvcl9kcmFmdF9zdWJtaXR0ZWQnLCB7IGlkOiBkcmFmdC5pZCwgc3VibWl0dGVkX2J5X2dpdGh1Yl91c2VyX2lkOiB1c2VyLmlkIH0pO1xuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSwgaWQ6IGRyYWZ0LmlkLCBzdGF0ZTogJ3N1Ym1pdHRlZCcgfSk7XG4gIH0pO1xuXG4gIC8vIE93bmVyL21haW50YWluZXIgeWFuayBvciByZXZva2UgYSBwdWJsaXNoZWQgZHJhZnQuIEJvdGggdHJhbnNpdGlvbnMgdW5saXN0XG4gIC8vIHRoZSBwdWJsaWMgcm93OyByZXZva2UgaXMgcGVybWFuZW50IGFuZCBpcyByZXRhaW5lZCBpbiB0aGUgYXVkaXQgdHJhaWwuXG4gIGZvciAoY29uc3QgYWN0aW9uIG9mIFsneWFuaycsICdyZXZva2UnXSBhcyBjb25zdCkge1xuICAgIGFwcC5wb3N0KGAvY3JlYXRvci1kcmFmdHMvOmlkLyR7YWN0aW9ufWAsIGFzeW5jIChjKSA9PiB7XG4gICAgICBjb25zdCBkcmFmdCA9IGF3YWl0IGdldENyZWF0b3JEcmFmdChjLmVudi5EQiwgYy5yZXEucGFyYW0oJ2lkJykpO1xuICAgICAgaWYgKCFkcmFmdCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgICAgY29uc3QgdXNlciA9IGF3YWl0IG93bmVyT3JPcGVyYXRvcihjLCBkcmFmdCk7XG4gICAgICBpZiAodXNlciBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gdXNlcjtcbiAgICAgIGlmICghZHJhZnQucHVibGlzaGVkX2xpc3RpbmdfaWQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9wdWJsaXNoZWQnIH0sIDQwOSk7XG4gICAgICBpZiAoYWN0aW9uID09PSAneWFuaycgJiYgZHJhZnQuc3RhdGUgPT09ICd5YW5rZWQnKSByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGFscmVhZHlfeWFua2VkOiB0cnVlIH0pO1xuICAgICAgaWYgKGFjdGlvbiA9PT0gJ3Jldm9rZScgJiYgZHJhZnQuc3RhdGUgPT09ICdyZXZva2VkJykgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBhbHJlYWR5X3Jldm9rZWQ6IHRydWUgfSk7XG4gICAgICBpZiAoZHJhZnQuc3RhdGUgIT09ICdwdWJsaXNoZWQnICYmICEoYWN0aW9uID09PSAncmV2b2tlJyAmJiBkcmFmdC5zdGF0ZSA9PT0gJ3lhbmtlZCcpKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfc3RhdGUnLCBzdGF0ZTogZHJhZnQuc3RhdGUgfSwgNDA5KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICBhd2FpdCBtYXJrSGFybmVzc1VubGlzdGVkKGMuZW52LkRCLCBkcmFmdC5wdWJsaXNoZWRfbGlzdGluZ19pZCwgYGNyZWF0b3JfZHJhZnQ6JHtkcmFmdC5pZH06JHthY3Rpb259YCwgbm93KTtcbiAgICAgIGNvbnN0IGZyb20gPSBkcmFmdC5zdGF0ZTtcbiAgICAgIGNvbnN0IHRvID0gYWN0aW9uID09PSAneWFuaycgPyAneWFua2VkJyA6ICdyZXZva2VkJztcbiAgICAgIGNvbnN0IGNoYW5nZXMgPSBhd2FpdCBzZXRDcmVhdG9yRHJhZnRTdGF0ZShjLmVudi5EQiwgZHJhZnQuaWQsIGZyb20sIHRvLCBub3cpO1xuICAgICAgaWYgKGNoYW5nZXMgIT09IDEpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3N0YXRlX2NoYW5nZWQnIH0sIDQwOSk7XG4gICAgICBhd2FpdCBhdWRpdChjLmVudi5EQiwgbm93LCBgY3JlYXRvcl9kcmFmdF8ke2FjdGlvbn1lZGAsIHsgaWQ6IGRyYWZ0LmlkLCBsaXN0aW5nX2lkOiBkcmFmdC5wdWJsaXNoZWRfbGlzdGluZ19pZCwgYnlfZ2l0aHViX3VzZXJfaWQ6IHVzZXIuaWQgfSk7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkOiBkcmFmdC5pZCwgc3RhdGU6IHRvIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gTWFpbnRhaW5lciBxdWV1ZSBhbmQgcmV2aWV3IGVuZHBvaW50LiBBcHByb3ZhbCBwdWJsaXNoZXMgdGhyb3VnaCB0aGUgc2FtZVxuICAvLyBhdXRob3JpdGF0aXZlIGluc2VydEhhcm5lc3MgcHJpbWl0aXZlIGFzIG5vcm1hbCBsaXN0aW5ncy5cbiAgYXBwLmdldCgnL2FkbWluL2NyZWF0b3ItZHJhZnRzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvckZvckRyYWZ0KGMpO1xuICAgIGlmIChvcCBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3A7XG4gICAgY29uc3QgcmF3ID0gbmV3IFVSTChjLnJlcS51cmwpLnNlYXJjaFBhcmFtcy5nZXQoJ3N0YXRlJyk7XG4gICAgY29uc3Qgc3RhdGUgPSByYXcgPT09ICdkcmFmdCcgfHwgcmF3ID09PSAnc3VibWl0dGVkJyB8fCByYXcgPT09ICdhcHByb3ZlZCcgfHwgcmF3ID09PSAncmVqZWN0ZWQnIHx8IHJhdyA9PT0gJ3B1Ymxpc2hlZCcgfHwgcmF3ID09PSAneWFua2VkJyB8fCByYXcgPT09ICdyZXZva2VkJ1xuICAgICAgPyByYXdcbiAgICAgIDogJ3N1Ym1pdHRlZCc7XG4gICAgY29uc3QgZHJhZnRzID0gYXdhaXQgbGlzdENyZWF0b3JEcmFmdHMoYy5lbnYuREIsIHsgc3RhdGUgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7IHN0YXRlLCBkcmFmdHM6IGRyYWZ0cy5tYXAoKGQpID0+IGRyYWZ0UmVzcG9uc2UoZCkpIH0pO1xuICB9KTtcblxuICBhcHAucG9zdCgnL2FkbWluL2NyZWF0b3ItZHJhZnRzLzppZC9yZXZpZXcnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IG9wID0gYXdhaXQgcmVxdWlyZU9wZXJhdG9yRm9yRHJhZnQoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBkcmFmdCA9IGF3YWl0IGdldENyZWF0b3JEcmFmdChjLmVudi5EQiwgYy5yZXEucGFyYW0oJ2lkJykpO1xuICAgIGlmICghZHJhZnQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICBpZiAoZHJhZnQuc3RhdGUgIT09ICdzdWJtaXR0ZWQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdub3Rfc3VibWl0dGVkJywgc3RhdGU6IGRyYWZ0LnN0YXRlIH0sIDQwOSk7XG4gICAgbGV0IGJvZHk6IHsgZGVjaXNpb24/OiB1bmtub3duOyByZWFzb24/OiB1bmtub3duIH0gPSB7fTtcbiAgICB0cnkgeyBib2R5ID0gYXdhaXQgYy5yZXEuanNvbigpOyB9IGNhdGNoIHsgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9qc29uJyB9LCA0MDApOyB9XG4gICAgaWYgKGJvZHkuZGVjaXNpb24gIT09ICdhcHByb3ZlJyAmJiBib2R5LmRlY2lzaW9uICE9PSAncmVqZWN0JykgcmV0dXJuIGVycm9yKGMsICdkZWNpc2lvbicsICdhcHByb3ZlX29yX3JlamVjdCcpO1xuICAgIGlmIChib2R5LnJlYXNvbiAhPSBudWxsICYmICh0eXBlb2YgYm9keS5yZWFzb24gIT09ICdzdHJpbmcnIHx8IGJvZHkucmVhc29uLmxlbmd0aCA+IDEwMDApKSByZXR1cm4gZXJyb3IoYywgJ3JlYXNvbicsICdzdHJpbmdfbWF4XzEwMDAnKTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGlmIChib2R5LmRlY2lzaW9uID09PSAncmVqZWN0Jykge1xuICAgICAgY29uc3QgY2hhbmdlcyA9IGF3YWl0IHNldENyZWF0b3JEcmFmdFN0YXRlKGMuZW52LkRCLCBkcmFmdC5pZCwgJ3N1Ym1pdHRlZCcsICdyZWplY3RlZCcsIG5vdywgeyByZXZpZXdlZEJ5OiBvcC5pZCwgcmV2aWV3UmVhc29uOiAoYm9keS5yZWFzb24gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKT8udHJpbSgpIHx8IG51bGwgfSk7XG4gICAgICBpZiAoY2hhbmdlcyAhPT0gMSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnc3RhdGVfY2hhbmdlZCcgfSwgNDA5KTtcbiAgICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdjcmVhdG9yX2RyYWZ0X3Jldmlld19yZWplY3RlZCcsIHsgaWQ6IGRyYWZ0LmlkLCBvcGVyYXRvcl9naXRodWJfdXNlcl9pZDogb3AuaWQgfSk7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkOiBkcmFmdC5pZCwgc3RhdGU6ICdyZWplY3RlZCcgfSk7XG4gICAgfVxuICAgIGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShkcmFmdC5tYW5pZmVzdF9qc29uKSBhcyBEcmFmdE1hbmlmZXN0O1xuICAgIGlmICghZHJhZnQuYXJ0aWZhY3RfY29udGVudF9oYXNoIHx8ICFkcmFmdC5hcnRpZmFjdF9rZXkgfHwgZHJhZnQuYXJ0aWZhY3Rfc2l6ZV9ieXRlcyA9PSBudWxsKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhcnRpZmFjdF9yZXF1aXJlZCcgfSwgNDA5KTtcbiAgICBjb25zdCBsaXN0aW5nSWQgPSB1dWlkdjQoKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgaW5zZXJ0SGFybmVzcyhjLmVudi5EQiwge1xuICAgICAgICBpZDogbGlzdGluZ0lkLFxuICAgICAgICBsaXN0aW5nX2tpbmQ6IG1hbmlmZXN0Lmxpc3Rpbmdfa2luZCxcbiAgICAgICAgcHJvamVjdF9yZWY6IG1hbmlmZXN0LnByb2plY3RfcmVmID8/IG51bGwsXG4gICAgICAgIGxpc3RpbmdfcmVmOiBtYW5pZmVzdC5saXN0aW5nX2tpbmQgPT09ICdoYXJuZXNzJyA/IG51bGwgOiAobWFuaWZlc3QubGlzdGluZ19yZWYgPz8gbnVsbCksXG4gICAgICAgIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBtYW5pZmVzdC5naXRodWJfcmVwb3NpdG9yeV9pZCxcbiAgICAgICAgZ2l0aHViX293bmVyOiBtYW5pZmVzdC5naXRodWJfb3duZXIsXG4gICAgICAgIGdpdGh1Yl9uYW1lOiBtYW5pZmVzdC5naXRodWJfbmFtZSxcbiAgICAgICAgZ2l0aHViX3VybDogbWFuaWZlc3QuZ2l0aHViX3VybCxcbiAgICAgICAgdGl0bGU6IG1hbmlmZXN0LnRpdGxlLFxuICAgICAgICBkZXNjcmlwdGlvbjogbWFuaWZlc3QuZGVzY3JpcHRpb24gPz8gbnVsbCxcbiAgICAgICAgdG9waWNfaGV4OiBtYW5pZmVzdC50b3BpY19oZXggPz8gbnVsbCxcbiAgICAgICAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkOiBkcmFmdC5vd25lcl9naXRodWJfdXNlcl9pZCxcbiAgICAgICAgcHVibGlzaGVyX2dpdGh1Yl9sb2dpbjogZHJhZnQub3duZXJfZ2l0aHViX2xvZ2luLFxuICAgICAgICBwcm92aWRlc190b29sczogQXJyYXkuaXNBcnJheShtYW5pZmVzdC5wcm92aWRlc190b29scykgPyBKU09OLnN0cmluZ2lmeShtYW5pZmVzdC5wcm92aWRlc190b29scykgOiBudWxsLFxuICAgICAgICB1c2VzX3Rvb2xzOiBBcnJheS5pc0FycmF5KG1hbmlmZXN0LnVzZXNfdG9vbHMpID8gSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QudXNlc190b29scykgOiBudWxsLFxuICAgICAgICBwcm92aWRlc19ldmVudHM6IEFycmF5LmlzQXJyYXkobWFuaWZlc3QucHJvdmlkZXNfZXZlbnRzKSA/IEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LnByb3ZpZGVzX2V2ZW50cykgOiBudWxsLFxuICAgICAgICByZXF1aXJlc19ldmVudHM6IEFycmF5LmlzQXJyYXkobWFuaWZlc3QucmVxdWlyZXNfZXZlbnRzKSA/IEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LnJlcXVpcmVzX2V2ZW50cykgOiBudWxsLFxuICAgICAgICByZXF1aXJlc19ydWJyaWNzOiBBcnJheS5pc0FycmF5KG1hbmlmZXN0LnJlcXVpcmVzX3J1YnJpY3MpID8gSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QucmVxdWlyZXNfcnVicmljcykgOiBudWxsLFxuICAgICAgICBoaXZlX3B1YmtleTogbWFuaWZlc3QuaGl2ZV9wdWJrZXkgPz8gbnVsbCxcbiAgICAgICAgaGl2ZV90aXRsZTogbWFuaWZlc3QuaGl2ZV90aXRsZSA/PyBudWxsLFxuICAgICAgICBibHVlcHJpbnRfa2luZDogbWFuaWZlc3QuYmx1ZXByaW50X2tpbmQgPz8gbnVsbCxcbiAgICAgICAgcmV2aWV3X3N0YXR1czogJ2FwcHJvdmVkJyxcbiAgICAgICAgZGVsaXZlcnlfdHlwZTogbWFuaWZlc3QuZGVsaXZlcnlfdHlwZSA/PyBudWxsLFxuICAgICAgICBsYXRlc3RfanNvbl91cmw6IG1hbmlmZXN0LmxhdGVzdF9qc29uX3VybCA/PyBudWxsLFxuICAgICAgICByZWxlYXNlX3JlcG86IG1hbmlmZXN0LnJlbGVhc2VfcmVwbyA/PyBudWxsLFxuICAgICAgICBpY29uX3VybDogbWFuaWZlc3QuaWNvbl91cmwgPz8gbnVsbCxcbiAgICAgICAgcGxhdGZvcm1zOiBBcnJheS5pc0FycmF5KG1hbmlmZXN0LnBsYXRmb3JtcykgPyBKU09OLnN0cmluZ2lmeShtYW5pZmVzdC5wbGF0Zm9ybXMpIDogbnVsbCxcbiAgICAgICAgY3JlYXRlZF9hdDogbm93LFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdsaXN0aW5nX3B1Ymxpc2hfY29uZmxpY3QnIH0sIDQwOSk7XG4gICAgfVxuICAgIGNvbnN0IGNoYW5nZXMgPSBhd2FpdCBzZXRDcmVhdG9yRHJhZnRTdGF0ZShjLmVudi5EQiwgZHJhZnQuaWQsICdzdWJtaXR0ZWQnLCAncHVibGlzaGVkJywgbm93LCB7IHJldmlld2VkQnk6IG9wLmlkLCByZXZpZXdSZWFzb246IChib2R5LnJlYXNvbiBhcyBzdHJpbmcgfCB1bmRlZmluZWQpPy50cmltKCkgfHwgbnVsbCwgcHVibGlzaGVkTGlzdGluZ0lkOiBsaXN0aW5nSWQgfSk7XG4gICAgaWYgKGNoYW5nZXMgIT09IDEpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3N0YXRlX2NoYW5nZWRfYWZ0ZXJfcHVibGlzaCcsIGxpc3RpbmdfaWQ6IGxpc3RpbmdJZCB9LCA0MDkpO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdjcmVhdG9yX2RyYWZ0X3B1Ymxpc2hlZCcsIHsgaWQ6IGRyYWZ0LmlkLCBsaXN0aW5nX2lkOiBsaXN0aW5nSWQsIG9wZXJhdG9yX2dpdGh1Yl91c2VyX2lkOiBvcC5pZCwgcmV2aWV3X3N0YXR1czogJ2FwcHJvdmVkJyB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkOiBkcmFmdC5pZCwgc3RhdGU6ICdwdWJsaXNoZWQnLCBsaXN0aW5nX2lkOiBsaXN0aW5nSWQsIHJldmlld19zdGF0dXM6ICdhcHByb3ZlZCcgfSk7XG4gIH0pO1xuXG4gIHJldHVybiBhcHA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVPcGVyYXRvckZvckRyYWZ0KGM6IENvbnRleHQ8eyBCaW5kaW5nczogRW52IH0+KTogUHJvbWlzZTx7IGlkOiBudW1iZXI7IGxvZ2luOiBzdHJpbmcgfSB8IFJlc3BvbnNlPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KTtcbiAgICBpZiAoIWlzQ3VwYm9hcmRPcGVyYXRvcih1c2VyLmlkLCBjLmVudikpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ZvcmJpZGRlbicsIHJlYXNvbjogJ25vdF9hbl9vcGVyYXRvcicgfSwgNDAzKTtcbiAgICByZXR1cm4gdXNlcjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBhdXRoRXJyb3IoYywgZSkgPz8gUHJvbWlzZS5yZWplY3QoZSk7XG4gIH1cbn1cbiJdLCJmaWxlIjoiL3NyYy9yb3V0ZXMvY3JlYXRvci1kcmFmdHMudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9jcmVhdG9yLWRyYWZ0cy50cyIsIi9zcmMvcm91dGVzL2NyZWF0b3ItZHJhZnRzLnRzIixbXV0=