__vite_ssr_exportName__("derivePublisherPermission", () => { try { return derivePublisherPermission } catch {} });
__vite_ssr_exportName__("listingsRoute", () => { try { return listingsRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["audit","clientIp","getActiveListingByRefs","getHarnessById","getHarnessByGithubRepoId","insertHarness","isListingKind","isListingVisibility","isPricingModel","listBannedPubkeySet","listPublicHarnessesPage","markHarnessUnlisted","normalizeListingKind","parseListingCursor","publishReviewStatus","setHarnessClaim","supersedeHarnessListing","summarizePublicHarnesses"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","extractBearer","resolveGithubBearer","checkRepoPermission"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/ratelimit.ts", {"importedNames":["checkAndRecordUserPublishHourly","checkIpListPerMinute","RateLimitError"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/content-pin.ts", {"importedNames":["isSelfDescribingKind","pinListingContent"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/src/attestation.ts", {"importedNames":["resolveVerifiedBy"]});






const PROVIDES_TOOLS_MAX_ENTRIES = 200;
const TYPE_DECLARATIONS_MAX = 100;
const TYPE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const PROVIDES_TOOLS_MAX_NAME_LEN = 128;
const USES_TOOLS_KINDS = ["recipe", "plan", "goal"];
const PROVIDES_EVENTS_MAX_ENTRIES = 200;
const PROVIDES_EVENTS_MAX_FAMILY_LEN = 128;
const PROVIDES_EVENTS_MAX_TEMPLATE_LEN = 256;
const PROVIDES_EVENTS_MAX_DESCRIBE_LEN = 300;
const REQUIRES_EVENTS_MAX_ENTRIES = 200;
const REQUIRES_EVENTS_MAX_FAMILY_LEN = 128;
const REQUIRES_RUBRICS_MAX_ENTRIES = 200;
const REQUIRES_RUBRICS_MAX_REF_LEN = 200;
const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;
const HIVE_PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const HIVE_TITLE_MAX = 200;
const LISTING_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PROJECT_REF_MAX = 300;
const APP_URL_MAX = 500;
const HTTPS_URL_RE = /^https:\/\/[^\s]{1,494}$/;
const RELEASE_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const APP_PLATFORMS_MAX_ENTRIES = 20;
const APP_PLATFORM_KEY_MAX_LEN = 64;
function uuidv4() {
  return crypto.randomUUID();
}
function derivePublisherPermission(perms) {
  if (!perms) return "none";
  if (perms.admin) return "admin";
  if (perms.maintain) return "maintain";
  if (perms.push) return "write";
  if (perms.triage) return "triage";
  if (perms.pull) return "read";
  return "none";
};
function registerListingEndpoints(app, base, opts = {}) {
  const { fixedKind } = opts;
  app.get(base, async (c) => {
    const ip = (0,__vite_ssr_import_1__.clientIp)(c.req.raw);
    try {
      await (0,__vite_ssr_import_3__.checkIpListPerMinute)(c.env, ip);
    } catch (e) {
      if (e instanceof __vite_ssr_import_3__.RateLimitError) return c.json({ error: "rate_limited" }, 429);
      throw e;
    };
    const url = new URL(c.req.url);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = cursorRaw == null ? null : (0,__vite_ssr_import_1__.parseListingCursor)(cursorRaw);
    if (cursorRaw != null && cursor == null) {
      return c.json({ error: "invalid_field", field: "cursor" }, 400);
    };
    const search = url.searchParams.get("q") ?? void 0;
    const claim_status_raw = url.searchParams.get("claim");
    const claim_status = claim_status_raw === "claimed" ? "claimed" : claim_status_raw === "unclaimed" ? "unclaimed" : void 0;
    let kind = fixedKind;
    if (!kind) {
      const kindRaw = url.searchParams.get("kind");
      if (kindRaw != null && kindRaw !== "" && kindRaw !== "all") {
        const normalized = (0,__vite_ssr_import_1__.normalizeListingKind)(kindRaw);
        if (!normalized) return c.json({ error: "invalid_field", field: "kind" }, 400);
        kind = normalized;
      }
    };
    const project_ref = url.searchParams.get("project") ?? void 0;
    const visibilityRaw = url.searchParams.get("visibility");
    let visibility;
    if (visibilityRaw != null && visibilityRaw !== "" && visibilityRaw !== "all") {
      if (!(0,__vite_ssr_import_1__.isListingVisibility)(visibilityRaw)) {
        return c.json({ error: "invalid_field", field: "visibility" }, 400);
      };
      visibility = visibilityRaw;
    };
    const pricingRaw = url.searchParams.get("pricing");
    let pricing_model;
    if (pricingRaw != null && pricingRaw !== "" && pricingRaw !== "all") {
      if (!(0,__vite_ssr_import_1__.isPricingModel)(pricingRaw)) {
        return c.json({ error: "invalid_field", field: "pricing" }, 400);
      };
      pricing_model = pricingRaw;
    };
    const paidRaw = url.searchParams.get("paid");
    let paid;
    if (paidRaw != null && paidRaw !== "") {
      if (paidRaw !== "1" && paidRaw !== "0" && paidRaw !== "true" && paidRaw !== "false") {
        return c.json({ error: "invalid_field", field: "paid" }, 400);
      };
      paid = paidRaw === "1" || paidRaw === "true";
    };
    const blueprintKindRaw = url.searchParams.get("blueprint_kind");
    let blueprint_kind;
    if (blueprintKindRaw != null && blueprintKindRaw !== "" && blueprintKindRaw !== "all") {
      if (blueprintKindRaw !== "hive" && blueprintKindRaw !== "harness" && blueprintKindRaw !== "identity") {
        return c.json({ error: "invalid_field", field: "blueprint_kind" }, 400);
      };
      blueprint_kind = blueprintKindRaw;
    };
    const filters = {
      limit,
      cursor,
      search,
      claim_status,
      kind,
      blueprint_kind,
      project_ref,
      visibility,
      tenant_ref: url.searchParams.get("tenant") ?? void 0,
      pricing_model,
      paid,
      platform: url.searchParams.get("platform") ?? void 0,
      runtime: url.searchParams.get("runtime") ?? void 0,
      permission: url.searchParams.get("permission") ?? void 0,
      provides_item_type: url.searchParams.get("provides_item_type") ?? void 0,
      provides_plan_type: url.searchParams.get("provides_plan_type") ?? void 0
    };
    const [{ results, next_cursor }, { total, kind_facets }] = await Promise.all([
      (0,__vite_ssr_import_1__.listPublicHarnessesPage)(c.env.DB, filters),
      (0,__vite_ssr_import_1__.summarizePublicHarnesses)(c.env.DB, filters)
    ]);
    return c.json({ results, next_cursor, total, kind_facets });
  });
  app.get(`${base}/:id`, async (c) => {
    const id = c.req.param("id");
    const row = await (0,__vite_ssr_import_1__.getHarnessById)(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: "not_found" }, 404);
    if (fixedKind && row.listing_kind !== fixedKind) return c.json({ error: "not_found" }, 404);
    if (row.publisher_device_pubkey) {
      const banned = await (0,__vite_ssr_import_1__.listBannedPubkeySet)(c.env.DB);
      if (banned.has(row.publisher_device_pubkey)) return c.json({ error: "not_found" }, 404);
    };
    if (row.review_status !== "approved") {
      let viewerId = null;
      try {
        viewerId = (await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw)).id;
      } catch {
      };
      if (viewerId !== row.publisher_github_user_id) return c.json({ error: "not_found" }, 404);
    };
    return c.json(row);
  });
  app.post(base, async (c) => {
    let user;
    try {
      user = await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw);
    } catch (e) {
      if (e instanceof __vite_ssr_import_2__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
      throw e;
    };
    const now = Date.now();
    try {
      await (0,__vite_ssr_import_3__.checkAndRecordUserPublishHourly)(c.env, user.id, now);
    } catch (e) {
      if (e instanceof __vite_ssr_import_3__.RateLimitError) {
        await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "publish_rate_limited", { user_id: user.id });
        return c.json({ error: "rate_limited", bucket: e.bucket }, 429);
      };
      throw e;
    };
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    let kind;
    if (fixedKind) {
      kind = fixedKind;
    } else if (body.listing_kind == null) {
      kind = "harness";
    } else {
      const normalized = (0,__vite_ssr_import_1__.normalizeListingKind)(body.listing_kind);
      if (!normalized) return c.json({ error: "invalid_field", field: "listing_kind" }, 400);
      kind = normalized;
    };
    if (typeof body.github_repository_id !== "number" || body.github_repository_id <= 0) {
      return c.json({ error: "invalid_field", field: "github_repository_id" }, 400);
    };
    if (typeof body.github_owner !== "string" || !body.github_owner) {
      return c.json({ error: "invalid_field", field: "github_owner" }, 400);
    };
    if (typeof body.github_name !== "string" || !body.github_name) {
      return c.json({ error: "invalid_field", field: "github_name" }, 400);
    };
    if (typeof body.github_url !== "string" || !/^https:\/\/github\.com\//.test(body.github_url)) {
      return c.json({ error: "invalid_field", field: "github_url" }, 400);
    };
    if (body.description != null && (typeof body.description !== "string" || body.description.length > 280)) {
      return c.json({ error: "invalid_field", field: "description" }, 400);
    };
    if (body.title != null && (typeof body.title !== "string" || body.title.length > 200)) {
      return c.json({ error: "invalid_field", field: "title" }, 400);
    };
    if (kind === "harness") {
      if (typeof body.topic_hex !== "string" || !TOPIC_HEX_RE.test(body.topic_hex)) {
        return c.json({ error: "invalid_field", field: "topic_hex" }, 400);
      }
    } else {
      if (body.topic_hex != null && (typeof body.topic_hex !== "string" || !TOPIC_HEX_RE.test(body.topic_hex))) {
        return c.json({ error: "invalid_field", field: "topic_hex" }, 400);
      };
      if (typeof body.listing_ref !== "string" || !LISTING_REF_RE.test(body.listing_ref)) {
        return c.json({ error: "invalid_field", field: "listing_ref" }, 400);
      }
    };
    if (body.project_ref != null && (typeof body.project_ref !== "string" || body.project_ref.length < 1 || body.project_ref.length > PROJECT_REF_MAX)) {
      return c.json({ error: "invalid_field", field: "project_ref" }, 400);
    };
    let providesToolsJson = null;
    if (body.provides_tools != null) {
      if (kind !== "plugin" && kind !== "pack") {
        return c.json({ error: "invalid_field", field: "provides_tools", reason: "plugin_or_pack_kind_only" }, 400);
      };
      const pt = body.provides_tools;
      if (!Array.isArray(pt) || pt.length === 0 || pt.length > PROVIDES_TOOLS_MAX_ENTRIES) {
        return c.json({ error: "invalid_field", field: "provides_tools", reason: "array_1_to_200" }, 400);
      };
      if (!pt.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= PROVIDES_TOOLS_MAX_NAME_LEN)) {
        return c.json({ error: "invalid_field", field: "provides_tools", reason: "non_empty_strings_max_128" }, 400);
      };
      providesToolsJson = JSON.stringify(pt);
    };
    let providesItemTypesJson = null;
    let providesPlanTypesJson = null;
    const declaredTypes = { itemTypes: 0, planTypes: 0 };
    for (const field of ["provides_item_types", "provides_plan_types"]) {
      const declared = body[field];
      if (declared == null) continue;
      const bad = (reason) => c.json({ error: "invalid_field", field, reason }, 400);
      if (kind !== "plugin" && kind !== "pack") return bad("plugin_or_pack_kind_only");
      if (!Array.isArray(declared) || declared.length === 0 || declared.length > TYPE_DECLARATIONS_MAX) {
        return bad("array_1_to_100");
      };
      const seen = /* @__PURE__ */ new Set();
      const clean = [];
      for (const entry of declared) {
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return bad("entries_must_be_objects");
        const { id: id2, revision, ...rest } = entry;
        if (Object.keys(rest).length > 0) return bad("entries_are_id_and_revision_only");
        if (typeof id2 !== "string" || !TYPE_ID_RE.test(id2) || id2.startsWith("papercusp/")) return bad("id_namespaced_slug");
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
          return bad("revision_positive_integer");
        };
        if (seen.has(id2)) return bad("duplicate_id");
        seen.add(id2);
        clean.push({ id: id2, revision });
      };
      if (field === "provides_item_types") {
        providesItemTypesJson = JSON.stringify(clean);
        declaredTypes.itemTypes = clean.length;
      } else {
        providesPlanTypesJson = JSON.stringify(clean);
        declaredTypes.planTypes = clean.length;
      }
    };
    let requiresPlanTypeJson = null;
    if (body.requires_plan_type != null) {
      const bad = (reason) => c.json({ error: "invalid_field", field: "requires_plan_type", reason }, 400);
      if (kind !== "plan") return bad("plan_kind_only");
      const required = body.requires_plan_type;
      if (typeof required !== "object" || Array.isArray(required)) return bad("must_be_object");
      const { id: id2, minRevision, maxRevision, ...rest } = required;
      if (Object.keys(rest).length > 0) return bad("id_and_revision_range_only");
      if (typeof id2 !== "string" || !TYPE_ID_RE.test(id2)) return bad("id_namespaced_slug");
      const isRevision = (v) => v === void 0 || typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
      if (!isRevision(minRevision) || !isRevision(maxRevision)) return bad("revision_positive_integer");
      if (minRevision === void 0 && maxRevision === void 0) return bad("revision_or_range_required");
      if (minRevision !== void 0 && maxRevision !== void 0 && minRevision > maxRevision) {
        return bad("min_exceeds_max");
      };
      requiresPlanTypeJson = JSON.stringify({
        id: id2,
        ...minRevision !== void 0 ? { minRevision } : {},
        ...maxRevision !== void 0 ? { maxRevision } : {}
      });
    };
    let usesToolsJson = null;
    if (body.uses_tools != null) {
      if (!USES_TOOLS_KINDS.includes(kind)) {
        return c.json({ error: "invalid_field", field: "uses_tools", reason: "orchestrating_kind_only" }, 400);
      };
      const ut = body.uses_tools;
      if (!Array.isArray(ut) || ut.length === 0 || ut.length > PROVIDES_TOOLS_MAX_ENTRIES) {
        return c.json({ error: "invalid_field", field: "uses_tools", reason: "array_1_to_200" }, 400);
      };
      if (!ut.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= PROVIDES_TOOLS_MAX_NAME_LEN)) {
        return c.json({ error: "invalid_field", field: "uses_tools", reason: "non_empty_strings_max_128" }, 400);
      };
      usesToolsJson = JSON.stringify(ut);
    };
    let providesEventsJson = null;
    if (body.provides_events != null) {
      const bad = (reason) => c.json({ error: "invalid_field", field: "provides_events", reason }, 400);
      if (kind !== "plugin" && kind !== "pack") return bad("plugin_or_pack_kind_only");
      const pe = body.provides_events;
      if (!Array.isArray(pe) || pe.length === 0 || pe.length > PROVIDES_EVENTS_MAX_ENTRIES) {
        return bad("array_1_to_200");
      };
      const families = /* @__PURE__ */ new Set();
      const clean = [];
      for (const raw of pe) {
        if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return bad("entries_must_be_objects");
        const { family, keyTemplate, describe } = raw;
        if (typeof family !== "string" || family.trim().length === 0 || family.length > PROVIDES_EVENTS_MAX_FAMILY_LEN) {
          return bad("family_non_empty_string_max_128");
        };
        if (typeof keyTemplate !== "string" || keyTemplate.trim().length === 0 || keyTemplate.length > PROVIDES_EVENTS_MAX_TEMPLATE_LEN) {
          return bad("key_template_non_empty_string_max_256");
        };
        if (families.has(family)) return bad("duplicate_family");
        families.add(family);
        if (describe != null && (typeof describe !== "string" || describe.length > PROVIDES_EVENTS_MAX_DESCRIBE_LEN)) {
          return bad("describe_string_max_300");
        };
        clean.push({ family, keyTemplate, ...typeof describe === "string" ? { describe } : {} });
      };
      providesEventsJson = JSON.stringify(clean);
    };
    let requiresEventsJson = null;
    if (body.requires_events != null) {
      const bad = (reason) => c.json({ error: "invalid_field", field: "requires_events", reason }, 400);
      if (kind !== "plugin" && kind !== "pack") return bad("plugin_or_pack_kind_only");
      const re = body.requires_events;
      if (!Array.isArray(re) || re.length === 0 || re.length > REQUIRES_EVENTS_MAX_ENTRIES) {
        return bad("array_1_to_200");
      };
      const families = /* @__PURE__ */ new Set();
      const clean = [];
      for (const raw of re) {
        if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return bad("entries_must_be_objects");
        const { family, optional } = raw;
        if (typeof family !== "string" || family.trim().length === 0 || family.length > REQUIRES_EVENTS_MAX_FAMILY_LEN) {
          return bad("family_non_empty_string_max_128");
        };
        if (optional != null && typeof optional !== "boolean") return bad("optional_must_be_boolean");
        if (families.has(family)) return bad("duplicate_family");
        families.add(family);
        clean.push({ family, ...optional === true ? { optional: true } : {} });
      };
      requiresEventsJson = JSON.stringify(clean);
    };
    let requiresRubricsJson = null;
    if (body.requires_rubrics != null) {
      const bad = (reason) => c.json({ error: "invalid_field", field: "requires_rubrics", reason }, 400);
      if (kind !== "plan" && kind !== "goal") return bad("plan_or_goal_kind_only");
      const rr = body.requires_rubrics;
      if (!Array.isArray(rr) || rr.length === 0 || rr.length > REQUIRES_RUBRICS_MAX_ENTRIES) {
        return bad("array_1_to_200");
      };
      const refs = /* @__PURE__ */ new Set();
      const clean = [];
      for (const raw of rr) {
        if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return bad("entries_must_be_objects");
        const { rubricRef, optional } = raw;
        if (typeof rubricRef !== "string" || rubricRef.trim().length === 0 || rubricRef.length > REQUIRES_RUBRICS_MAX_REF_LEN) {
          return bad("rubricRef_non_empty_string_max_200");
        };
        if (optional != null && typeof optional !== "boolean") return bad("optional_must_be_boolean");
        if (refs.has(rubricRef)) return bad("duplicate_rubric_ref");
        refs.add(rubricRef);
        clean.push({ rubricRef, ...optional === true ? { optional: true } : {} });
      };
      requiresRubricsJson = JSON.stringify(clean);
    };
    const anyAppField = body.delivery_type != null || body.latest_json_url != null || body.release_repo != null || body.icon_url != null || body.platforms != null;
    let deliveryType = null;
    let latestJsonUrl = null;
    let releaseRepo = null;
    let iconUrl = null;
    let platformsJson = null;
    if (anyAppField && kind !== "app") {
      return c.json({ error: "invalid_field", field: "app_fields", reason: "app_kind_only" }, 400);
    };
    if (kind === "app") {
      const badApp = (field, reason) => c.json({ error: "invalid_field", field, reason }, 400);
      if (body.delivery_type != null) {
        if (body.delivery_type !== "standalone" && body.delivery_type !== "bundle") {
          return badApp("delivery_type", "standalone_or_bundle");
        };
        deliveryType = body.delivery_type;
      };
      const effectiveDelivery = deliveryType ?? "standalone";
      if (body.latest_json_url != null) {
        if (typeof body.latest_json_url !== "string" || body.latest_json_url.length > APP_URL_MAX || !HTTPS_URL_RE.test(body.latest_json_url)) {
          return badApp("latest_json_url", "https_url_max_500");
        };
        latestJsonUrl = body.latest_json_url;
      };
      if (effectiveDelivery === "standalone" && latestJsonUrl == null) {
        return badApp("latest_json_url", "required_for_standalone_app");
      };
      if (body.release_repo != null) {
        if (typeof body.release_repo !== "string" || !RELEASE_REPO_RE.test(body.release_repo)) {
          return badApp("release_repo", "owner_slash_repo");
        };
        releaseRepo = body.release_repo;
      };
      if (body.icon_url != null) {
        if (typeof body.icon_url !== "string" || body.icon_url.length > APP_URL_MAX || !HTTPS_URL_RE.test(body.icon_url)) {
          return badApp("icon_url", "https_url_max_500");
        };
        iconUrl = body.icon_url;
      };
      if (body.platforms != null) {
        const p = body.platforms;
        if (!Array.isArray(p) || p.length === 0 || p.length > APP_PLATFORMS_MAX_ENTRIES) {
          return badApp("platforms", "array_1_to_20");
        };
        if (!p.every(
          (k) => typeof k === "string" && k.trim().length > 0 && k.length <= APP_PLATFORM_KEY_MAX_LEN
        )) {
          return badApp("platforms", "non_empty_strings_max_64");
        };
        platformsJson = JSON.stringify(p);
      }
    };
    if (body.hive_pubkey != null && (typeof body.hive_pubkey !== "string" || !HIVE_PUBKEY_RE.test(body.hive_pubkey))) {
      return c.json({ error: "invalid_field", field: "hive_pubkey" }, 400);
    };
    if (body.hive_title != null) {
      if (typeof body.hive_title !== "string" || body.hive_title.length < 1 || body.hive_title.length > HIVE_TITLE_MAX) {
        return c.json({ error: "invalid_field", field: "hive_title" }, 400);
      };
      if (body.hive_pubkey == null) {
        return c.json({ error: "invalid_field", field: "hive_title", reason: "requires_hive_pubkey" }, 400);
      }
    };
    const hasGist = body.attestation_gist_id != null;
    const hasPubkey = body.publisher_device_pubkey != null;
    if (hasGist !== hasPubkey) {
      return c.json(
        { error: "invalid_field", field: "attestation_gist_id|publisher_device_pubkey", reason: "both_or_neither" },
        400
      );
    };
    if (hasGist && (typeof body.attestation_gist_id !== "string" || body.attestation_gist_id.length > 100 || !/^[A-Za-z0-9]+$/.test(body.attestation_gist_id))) {
      return c.json({ error: "invalid_field", field: "attestation_gist_id" }, 400);
    };
    if (hasPubkey && (typeof body.publisher_device_pubkey !== "string" || body.publisher_device_pubkey.length < 1 || body.publisher_device_pubkey.length > 200)) {
      return c.json({ error: "invalid_field", field: "publisher_device_pubkey" }, 400);
    };
    const ghCheck = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(body.github_owner)}/${encodeURIComponent(body.github_name)}`,
      {
        headers: {
          Authorization: `Bearer ${(0,__vite_ssr_import_2__.extractBearer)(c.req.raw)}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "papercusp-cupboard"
        }
      }
    );
    if (!ghCheck.ok) {
      return c.json({ error: "github_repo_unreachable", status: ghCheck.status }, 400);
    };
    const repoMeta = await ghCheck.json();
    if (repoMeta.private) {
      return c.json({ error: "private_repo_rejected" }, 400);
    };
    if (repoMeta.id !== body.github_repository_id) {
      return c.json({ error: "repository_id_mismatch", expected: repoMeta.id }, 400);
    };
    const publisher_permission = derivePublisherPermission(repoMeta.permissions);
    let pin = null;
    if ((0,__vite_ssr_import_4__.isSelfDescribingKind)(kind) || declaredTypes.itemTypes + declaredTypes.planTypes > 0) {
      if (typeof repoMeta.default_branch !== "string" || repoMeta.default_branch === "") {
        return c.json({ error: "github_repo_unreachable", reason: "no_default_branch" }, 400);
      };
      const pinned = await (0,__vite_ssr_import_4__.pinListingContent)({
        token: (0,__vite_ssr_import_2__.extractBearer)(c.req.raw),
        owner: body.github_owner,
        name: body.github_name,
        defaultBranch: repoMeta.default_branch,
        listingRef: body.listing_ref,
        kind
      });
      if (!pinned.ok) {
        if (pinned.code === "github_tree_unreachable") {
          return c.json({ error: pinned.code, step: pinned.step, status: pinned.status }, 400);
        };
        if (pinned.code === "github_blob_unreachable") {
          return c.json({ error: pinned.code, path: pinned.path, status: pinned.status }, 400);
        };
        if (pinned.code === "identity_leak") {
          return c.json({ error: pinned.code, commitSha: pinned.commitSha, hits: pinned.hits }, 422);
        };
        const { ok: _ok, code, ...detail } = pinned;
        return c.json({ error: code, ...detail }, 422);
      };
      pin = pinned;
    };
    const existing = kind === "harness" ? await (0,__vite_ssr_import_1__.getHarnessByGithubRepoId)(c.env.DB, body.github_repository_id) : await (0,__vite_ssr_import_1__.getActiveListingByRefs)(c.env.DB, body.github_repository_id, kind, body.listing_ref, pin?.commitSha);
    const priorVersion = kind !== "harness" && pin != null && existing == null ? await (0,__vite_ssr_import_1__.getActiveListingByRefs)(c.env.DB, body.github_repository_id, kind, body.listing_ref) : existing;
    if (existing && !existing.unlisted_at) {
      await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "publish_dedup", {
        listing_kind: kind,
        github_repository_id: body.github_repository_id,
        listing_ref: existing.listing_ref,
        existing_id: existing.id,
        user_id: user.id
      });
      return c.json({ ok: true, id: existing.id, harness: existing, listing: existing, dedup: true });
    };
    const review_status = (0,__vite_ssr_import_1__.publishReviewStatus)(kind, declaredTypes);
    const badCatalog = (field, reason) => c.json({ error: "invalid_field", field, reason }, 400);
    const CATALOG_STR_MAX = 200;
    const optionalStr = (v, max = CATALOG_STR_MAX) => v == null ? null : typeof v === "string" && v.trim() !== "" && v.length <= max ? v : false;
    let visibilityOut = "public";
    if (body.visibility != null) {
      if (!(0,__vite_ssr_import_1__.isListingVisibility)(body.visibility)) return badCatalog("visibility", "public_unlisted_or_private");
      visibilityOut = body.visibility;
    };
    const tenantId = optionalStr(body.tenant_id);
    if (tenantId === false) return badCatalog("tenant_id", "non_empty_string_max_200");
    if (visibilityOut === "private" && tenantId == null) {
      return badCatalog("tenant_id", "required_for_private_visibility");
    };
    const skuRef = optionalStr(body.sku_ref);
    if (skuRef === false) return badCatalog("sku_ref", "non_empty_string_max_200");
    let pricingModel = null;
    if (body.pricing_model != null) {
      if (!(0,__vite_ssr_import_1__.isPricingModel)(body.pricing_model)) return badCatalog("pricing_model", "free_one_time_subscription_or_per_use");
      pricingModel = body.pricing_model;
    };
    let priceAmountMicros = null;
    if (body.price_amount_micros != null) {
      if (!Number.isSafeInteger(body.price_amount_micros) || body.price_amount_micros < 0) {
        return badCatalog("price_amount_micros", "non_negative_integer");
      };
      priceAmountMicros = body.price_amount_micros;
    };
    const priceCurrency = optionalStr(body.price_currency, 16);
    if (priceCurrency === false) return badCatalog("price_currency", "non_empty_string_max_16");
    if (pricingModel != null && pricingModel !== "free") {
      if (skuRef == null) return badCatalog("sku_ref", "required_for_priced_listing");
      if (priceAmountMicros == null) return badCatalog("price_amount_micros", "required_for_priced_listing");
      if (priceCurrency == null) return badCatalog("price_currency", "required_for_priced_listing");
    };
    let compatibilityJson = null;
    if (body.compatibility != null) {
      const compat = body.compatibility;
      if (typeof compat !== "object" || Array.isArray(compat)) return badCatalog("compatibility", "must_be_object");
      const { runtime, platforms, architectures } = compat;
      if (runtime != null && (typeof runtime !== "string" || runtime.trim() === "" || runtime.length > CATALOG_STR_MAX)) {
        return badCatalog("compatibility.runtime", "non_empty_string_max_200");
      };
      const strArray = (v) => Array.isArray(v) && v.length <= 64 && v.every((e) => typeof e === "string" && e.trim() !== "" && e.length <= CATALOG_STR_MAX) ? v : null;
      let platformList;
      if (platforms != null) {
        const parsed = strArray(platforms);
        if (!parsed) return badCatalog("compatibility.platforms", "string_array_max_64");
        platformList = parsed;
      };
      let archList;
      if (architectures != null) {
        const parsed = strArray(architectures);
        if (!parsed) return badCatalog("compatibility.architectures", "string_array_max_64");
        archList = parsed;
      };
      compatibilityJson = JSON.stringify({
        ...typeof runtime === "string" ? { runtime } : {},
        ...platformList ? { platforms: platformList } : {},
        ...archList ? { architectures: archList } : {}
      });
    };
    let requiredPermissionsJson = null;
    if (body.required_permissions != null) {
      const perms = body.required_permissions;
      if (!Array.isArray(perms) || perms.length === 0 || perms.length > 200 || !perms.every((p) => typeof p === "string" && p.trim() !== "" && p.length <= CATALOG_STR_MAX)) {
        return badCatalog("required_permissions", "non_empty_string_array_max_200");
      };
      if (new Set(perms).size !== perms.length) {
        return badCatalog("required_permissions", "duplicate_permission");
      };
      requiredPermissionsJson = JSON.stringify(perms);
    };
    const releaseVersion = optionalStr(body.release_version, 100);
    if (releaseVersion === false) return badCatalog("release_version", "non_empty_string_max_100");
    const releaseSignature = optionalStr(body.release_signature, 1e3);
    if (releaseSignature === false) return badCatalog("release_signature", "non_empty_string_max_1000");
    const releaseManifestDigest = optionalStr(body.release_manifest_digest, 128);
    if (releaseManifestDigest === false) return badCatalog("release_manifest_digest", "non_empty_string_max_128");
    const releaseManifest = optionalStr(body.release_manifest, 16e3);
    if (releaseManifest === false) return badCatalog("release_manifest", "non_empty_string_max_16000");
    if (releaseManifest != null) {
      let parsed;
      try {
        parsed = JSON.parse(releaseManifest);
      } catch {
        return badCatalog("release_manifest", "json_object");
      };
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return badCatalog("release_manifest", "json_object");
      }
    };
    const isIdentityListing = kind === "blueprint" && body.blueprint_kind === "identity";
    const identitySurface = optionalStr(body.identity_surface, 16e3);
    if (identitySurface === false) return badCatalog("identity_surface", "non_empty_string_max_16000");
    if (identitySurface != null && !isIdentityListing) {
      return badCatalog("identity_surface", "blueprint_identity_only");
    };
    if (isIdentityListing && identitySurface == null) {
      return badCatalog("identity_surface", "required_with_identity_blueprint_kind");
    };
    if (identitySurface != null) {
      let parsed;
      try {
        parsed = JSON.parse(identitySurface);
      } catch {
        return badCatalog("identity_surface", "json_object");
      };
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return badCatalog("identity_surface", "json_object");
      }
    };
    let releaseContentHash = null;
    if (body.release_content_hash != null) {
      if (typeof body.release_content_hash !== "string" || !CONTENT_HASH_RE.test(body.release_content_hash)) {
        return badCatalog("release_content_hash", "sha256_colon_64_hex");
      };
      releaseContentHash = body.release_content_hash.toLowerCase();
    };
    if (releaseVersion != null && releaseContentHash == null) {
      return badCatalog("release_content_hash", "required_with_release_version");
    };
    if (releaseContentHash != null && releaseVersion == null) {
      return badCatalog("release_version", "required_with_release_content_hash");
    };
    const id = uuidv4();
    await (0,__vite_ssr_import_1__.insertHarness)(c.env.DB, {
      id,
      listing_kind: kind,
      review_status,
      project_ref: body.project_ref ?? null,
      listing_ref: kind === "harness" ? null : body.listing_ref ?? null,
      github_repository_id: body.github_repository_id,
      github_owner: body.github_owner,
      github_name: body.github_name,
      github_url: body.github_url,
      title: body.title ?? body.github_name,
      description: body.description ?? null,
      topic_hex: body.topic_hex ?? null,
      publisher_github_user_id: user.id,
      publisher_github_login: user.login,
      publisher_permission,
      publisher_device_pubkey: body.publisher_device_pubkey ?? null,
      publisher_attestation_gist_id: body.attestation_gist_id ?? null,
      provides_tools: providesToolsJson,
      uses_tools: usesToolsJson,
      provides_events: providesEventsJson,
      requires_events: requiresEventsJson,
      requires_rubrics: requiresRubricsJson,
      provides_item_types: providesItemTypesJson,
      provides_plan_types: providesPlanTypesJson,
      requires_plan_type: requiresPlanTypeJson,
      hive_pubkey: body.hive_pubkey ?? null,
      hive_title: body.hive_title ?? null,
      // P-018: the blueprint.yaml `kind` for a blueprint listing (the Hives-tab
      // discriminator), or the identity facet (P-016). Only meaningful for
      // kind='blueprint'; lenient — an absent/bad value ⇒ null (treated as a
      // harness-blueprint), never blocks a publish.
      blueprint_kind: kind === "blueprint" && (body.blueprint_kind === "hive" || body.blueprint_kind === "harness" || body.blueprint_kind === "identity") ? body.blueprint_kind : null,
      identity_surface: identitySurface,
      // App distribution (migration 014). App-only — null on every other kind
      // (the validation above rejects an app field on a non-app publish).
      delivery_type: deliveryType,
      latest_json_url: latestJsonUrl,
      release_repo: releaseRepo,
      icon_url: iconUrl,
      platforms: platformsJson,
      // Catalog axes (migration 018 / P-008). Kind-agnostic.
      visibility: visibilityOut,
      tenant_id: tenantId,
      sku_ref: skuRef,
      pricing_model: pricingModel,
      price_amount_micros: priceAmountMicros,
      price_currency: priceCurrency,
      compatibility_json: compatibilityJson,
      required_permissions: requiredPermissionsJson,
      release_version: releaseVersion,
      release_content_hash: releaseContentHash,
      release_manifest_digest: releaseManifestDigest,
      release_signature: releaseSignature,
      release_manifest: releaseManifest,
      release_published_at: releaseVersion != null ? now : null,
      // Content pin (P-001): self-describing kinds only; null on code kinds.
      pinned_commit_sha: pin?.commitSha ?? null,
      pinned_tree_digest: pin?.treeDigest ?? null,
      pinned_at: pin ? now : null,
      // P-007: the Worker's OWN authority verdict for a recipe (never the publisher's manifest
      // claim); null on every other kind.
      authority_unresolved: pin?.recipeAuthority ? pin.recipeAuthority.unresolved ? 1 : 0 : null,
      authority_unresolved_cause: pin?.recipeAuthority?.cause ?? null,
      // P-010 (R-6): the optional provenance badge. Asked ONLY after the Worker has pinned
      // and scanned the bytes above, and only for a pinned (self-describing) listing — the
      // attestation binds the `<ref>/` tree digest the Worker computed, never the client's
      // claim. Any failure (no attestation, bad bundle, GitHub down) stores 'worker'; an
      // attestation is never a precondition for publishing.
      verified_by: pin ? await (0,__vite_ssr_import_5__.resolveVerifiedBy)({
        repo: `${body.github_owner}/${body.github_name}`,
        treeDigest: pin.treeDigest,
        commitSha: pin.commitSha,
        token: (0,__vite_ssr_import_2__.extractBearer)(c.req.raw)
      }) : "worker",
      created_at: now
    });
    if (priorVersion && pin != null && review_status === "approved" && priorVersion.pinned_commit_sha !== pin.commitSha) {
      await (0,__vite_ssr_import_1__.supersedeHarnessListing)(c.env.DB, priorVersion.id, id, "superseded_by_new_content_pin", now);
    };
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "published", {
      id,
      listing_kind: kind,
      github_repository_id: body.github_repository_id,
      listing_ref: kind === "harness" ? null : body.listing_ref,
      publisher_github_user_id: user.id,
      review_status
    });
    const listing = await (0,__vite_ssr_import_1__.getHarnessById)(c.env.DB, id);
    return c.json({
      ok: true,
      id,
      harness: listing,
      listing,
      review_status,
      ...review_status === "pending" ? { pending_review: true, hint: "This listing kind requires operator approval before it is publicly visible. You will see it as pending; everyone else sees it once approved." } : {}
    });
  });
  app.delete(`${base}/:id`, async (c) => {
    let user;
    try {
      user = await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw);
    } catch (e) {
      if (e instanceof __vite_ssr_import_2__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
      throw e;
    };
    const id = c.req.param("id");
    const row = await (0,__vite_ssr_import_1__.getHarnessById)(c.env.DB, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.unlisted_at) return c.json({ ok: true, already_unlisted: true });
    const isPublisher = row.publisher_github_user_id === user.id;
    const isClaimant = row.claimant_github_user_id === user.id;
    if (!isPublisher && !isClaimant) return c.json({ error: "forbidden" }, 403);
    const now = Date.now();
    await (0,__vite_ssr_import_1__.markHarnessUnlisted)(c.env.DB, id, "by_publisher", now);
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "unlisted", { id, listing_kind: row.listing_kind, by_user_id: user.id });
    return c.json({ ok: true });
  });
  app.post(`${base}/:id/claim`, async (c) => {
    let user;
    try {
      user = await (0,__vite_ssr_import_2__.resolveGithubBearer)(c.req.raw);
    } catch (e) {
      if (e instanceof __vite_ssr_import_2__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
      throw e;
    };
    const id = c.req.param("id");
    const row = await (0,__vite_ssr_import_1__.getHarnessById)(c.env.DB, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.unlisted_at) return c.json({ error: "unlisted" }, 410);
    if (row.claim_status === "claimed") {
      return c.json({ error: "already_claimed", claimant_github_user_id: row.claimant_github_user_id }, 409);
    };
    const perm = await (0,__vite_ssr_import_2__.checkRepoPermission)(
      (0,__vite_ssr_import_2__.extractBearer)(c.req.raw),
      row.github_owner,
      row.github_name,
      "maintain"
    );
    if (!perm.has_permission) {
      return c.json({ error: "insufficient_permission", required: "maintain" }, 403);
    };
    const now = Date.now();
    await (0,__vite_ssr_import_1__.setHarnessClaim)(c.env.DB, id, { user_id: user.id, login: user.login }, now);
    await (0,__vite_ssr_import_1__.audit)(c.env.DB, now, "claimed", { id, listing_kind: row.listing_kind, user_id: user.id, permission: perm.permission });
    const updated = await (0,__vite_ssr_import_1__.getHarnessById)(c.env.DB, id);
    return c.json({ ok: true, harness: updated, listing: updated });
  });
}
function listingsRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  registerListingEndpoints(app, "/listings");
  registerListingEndpoints(app, "/harnesses", { fixedKind: "harness" });
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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RUFBRSxLQUFLLEVBQUUsT0FBTyxtQkFBbUIseUJBQXlCLElBQUksd0JBQXdCLEdBQUcsR0FBRztBQUFBLElBQ3ZHO0FBQ0EsVUFBTSxPQUFPLFNBQU07QUFBQSxTQUNqQixxQ0FBYyxFQUFFLElBQUksR0FBRztBQUFBLE1BQ3ZCLElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxNQUNKO0FBQUEsSUFDRjtBQUNBLFFBQUksQ0FBQyxLQUFLLGdCQUFnQjtBQUN4QixhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sMkJBQTJCLFVBQVUsV0FBVyxHQUFHLEdBQUc7QUFBQSxJQUMvRTtBQUNBLFVBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsYUFBTSx1Q0FBZ0IsRUFBRSxJQUFJLElBQUksSUFBSSxFQUFFLFNBQVMsS0FBSyxJQUFJLE9BQU8sS0FBSyxNQUFNLEdBQUcsR0FBRztBQUNoRixhQUFNLDZCQUFNLEVBQUUsSUFBSSxJQUFJLEtBQUssV0FBVyxFQUFFLElBQUksY0FBYyxJQUFJLGNBQWMsU0FBUyxLQUFLLElBQUksWUFBWSxLQUFLLFdBQVcsQ0FBQztBQUMzSCxVQUFNLFVBQVUsU0FBTSxzQ0FBZSxFQUFFLElBQUksSUFBSSxFQUFFO0FBQ2pELFdBQU8sRUFBRSxLQUFLLEVBQUUsSUFBSSxNQUFNLFNBQVMsU0FBUyxTQUFTLFFBQVEsQ0FBQztBQUFBLEVBQ2hFLENBQUM7QUFDSDtBQU1PLFNBQVMsZ0JBQXlDO0FBQ3ZELFFBQU0sTUFBTSxJQUFJLDJCQUF3QjtBQUN4QywyQkFBeUIsS0FBSyxXQUFXO0FBQ3pDLDJCQUF5QixLQUFLLGNBQWMsRUFBRSxXQUFXLFVBQVUsQ0FBQztBQUNwRSxTQUFPO0FBQ1QiLCJuYW1lcyI6WyJpZCJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJsaXN0aW5ncy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIC9saXN0aW5ncyDigJQgdGhlIGdlbmVyYWxpemVkIHN0b3JlZnJvbnQgc3VyZmFjZSAobWlncmF0aW9uIDAwNCAvIEQtMDA1KS5cbiAqXG4gKiBPTkUgc3RvcmVmcm9udCwgZml2ZSBsaXN0aW5nIGtpbmRzOlxuICogICBoYXJuZXNzICAg4oaSIGpvaW4gICAgIChzaGFyZWQtaGFybmVzcyB2aWEgdGhlIEh5cGVyY29yZSB0b3BpY19oZXgpXG4gKiAgIGJsdWVwcmludCDihpIgZm9yayAgICAgKGEgYmx1ZXByaW50IHN0cmVhbSB3aXRoaW4gYSBwcm9qZWN0KVxuICogICBzbmFwc2hvdCAg4oaSIGZvcmsgICAgIChhIGNhcHR1cmVkIHNuYXBzaG90KVxuICogICBwbHVnaW4gICAg4oaSIGluc3RhbGwgIChhIGRpc3RyaWJ1dGFibGUgcGx1Z2luIOKAlCBhIHBhY2sgV0lUSCBhIHJ1bnRpbWUpXG4gKiAgIHBhY2sgICAgICDihpIgaW5zdGFsbCAgKGEgcnVudGltZS1sZXNzIGNvZGUtdG9vbCBwYWNrOyBtaWdyYXRpb24gMDA2LFxuICogICAgICAgICAgICAgICAgICAgICAgICAgdG9vbC1kaXN0cmlidXRpb24tZ3JhbnVsYXJpdHkgRC0wMDEvRC0wMDQpXG4gKlxuICogUHJvamVjdC1jZW50cmljIDE6TiAoRC0wMDgpOiBsaXN0aW5ncyBrZXkgb24gdGhlIHBhcGVyY3VwYWkgcHJvamVjdCByZW1vdGVcbiAqIChgcHJvamVjdF9yZWZgKSBhbmQgYSBwcm9qZWN0IGhvc3RzIE4gbm9uLWhhcm5lc3MgbGlzdGluZ3MsIGRpc2NyaW1pbmF0ZWQgYnlcbiAqIGBsaXN0aW5nX3JlZmAuIEdpdEh1Yi1yZXBvLWJhY2tlZCBpZGVudGl0eSBzdGF5cyBmb3IgdjEsIHNvIGV2ZXJ5IGtpbmQgc3RpbGxcbiAqIGNhcnJpZXMgdGhlIHByb2plY3QgcmVtb3RlJ3MgZ2l0aHViIHJlcG8gZmllbGRzICsgdGhlIHB1Ymxpc2hlci1jb2xsYWJvcmF0b3JcbiAqIHRydXN0IHNpZ25hbC5cbiAqXG4gKiBFbmRwb2ludHMgKHJlZ2lzdGVyZWQgdW5kZXIgQk9USCAvbGlzdGluZ3MgYW5kIC9oYXJuZXNzZXMpOlxuICogICBHRVQgICAgL2xpc3RpbmdzICAgICAgICAgICAg4oCUIGxpc3QgKHB1YmxpYywgcGFnaW5hdGVkLCA/a2luZD0gLyA/cHJvamVjdD0gZmlsdGVycylcbiAqICAgR0VUICAgIC9saXN0aW5ncy86aWQgICAgICAgIOKAlCBzaW5nbGUgbGlzdGluZyBkZXRhaWxcbiAqICAgUE9TVCAgIC9saXN0aW5ncyAgICAgICAgICAgIOKAlCBwdWJsaXNoIChHaXRIdWIgYXV0aCArIDUvaHIgY2FwOyBib2R5Lmxpc3Rpbmdfa2luZClcbiAqICAgREVMRVRFIC9saXN0aW5ncy86aWQgICAgICAgIOKAlCB1bmxpc3QgKHB1Ymxpc2hlciBvciBjbGFpbWFudClcbiAqICAgUE9TVCAgIC9saXN0aW5ncy86aWQvY2xhaW0gIOKAlCBjbGFpbSBieSBtYWludGFpbi9hZG1pbiBwZXJtXG4gKlxuICogL2hhcm5lc3NlcyogaXMgdGhlIHNhbWUgc3VyZmFjZSBwaW5uZWQgdG8ga2luZD0naGFybmVzcycg4oCUIHRoZSBiYWNrLWNvbXBhdFxuICogdmlldyB0aGUgZGVwbG95ZWQgZGVza3RvcCBjbGllbnQgKyBvcGVyYXRvciBwcm94eSB1c2UgdG9kYXkuIE9uY2UgdGhlXG4gKiBvcGVyYXRvciBwcm94eSBpcyBjdXQgb3ZlciB0byAvbGlzdGluZ3M/a2luZD1oYXJuZXNzLCAvaGFybmVzc2VzIGNhbiBiZVxuICogZHJvcHBlZCAoaXQgY2FycmllcyBubyBiZWhhdmlvciB0aGUgZ2VuZXJhbGl6ZWQgc3VyZmFjZSBkb2Vzbid0KS5cbiAqL1xuXG5pbXBvcnQgeyBIb25vIH0gZnJvbSAnaG9ubyc7XG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5pbXBvcnQge1xuICBhdWRpdCxcbiAgY2xpZW50SXAsXG4gIGdldEFjdGl2ZUxpc3RpbmdCeVJlZnMsXG4gIGdldEhhcm5lc3NCeUlkLFxuICBnZXRIYXJuZXNzQnlHaXRodWJSZXBvSWQsXG4gIGluc2VydEhhcm5lc3MsXG4gIGlzTGlzdGluZ0tpbmQsXG4gIGlzTGlzdGluZ1Zpc2liaWxpdHksXG4gIGlzUHJpY2luZ01vZGVsLFxuICBsaXN0QmFubmVkUHVia2V5U2V0LFxuICBsaXN0UHVibGljSGFybmVzc2VzUGFnZSxcbiAgbWFya0hhcm5lc3NVbmxpc3RlZCxcbiAgbm9ybWFsaXplTGlzdGluZ0tpbmQsXG4gIHBhcnNlTGlzdGluZ0N1cnNvcixcbiAgcHVibGlzaFJldmlld1N0YXR1cyxcbiAgc2V0SGFybmVzc0NsYWltLFxuICBzdXBlcnNlZGVIYXJuZXNzTGlzdGluZyxcbiAgc3VtbWFyaXplUHVibGljSGFybmVzc2VzLFxuICB0eXBlIExpc3RpbmdLaW5kLFxuICB0eXBlIExpc3RpbmdWaXNpYmlsaXR5LFxuICB0eXBlIFByaWNpbmdNb2RlbCxcbiAgdHlwZSBQdWJsaWNMaXN0T3B0cyxcbn0gZnJvbSAnLi4vZGIudHMnO1xuaW1wb3J0IHtcbiAgQXV0aEVycm9yLFxuICBleHRyYWN0QmVhcmVyLFxuICByZXNvbHZlR2l0aHViQmVhcmVyLFxuICBjaGVja1JlcG9QZXJtaXNzaW9uLFxufSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7IGNoZWNrQW5kUmVjb3JkVXNlclB1Ymxpc2hIb3VybHksIGNoZWNrSXBMaXN0UGVyTWludXRlLCBSYXRlTGltaXRFcnJvciB9IGZyb20gJy4uL3JhdGVsaW1pdC50cyc7XG5pbXBvcnQgeyBpc1NlbGZEZXNjcmliaW5nS2luZCwgcGluTGlzdGluZ0NvbnRlbnQsIHR5cGUgQ29udGVudFBpbiB9IGZyb20gJy4uL2NvbnRlbnQtcGluLnRzJztcbmltcG9ydCB7IHJlc29sdmVWZXJpZmllZEJ5IH0gZnJvbSAnLi4vYXR0ZXN0YXRpb24udHMnO1xuXG5pbnRlcmZhY2UgUHVibGlzaEJvZHkge1xuICBsaXN0aW5nX2tpbmQ/OiBzdHJpbmc7ICAgICAgICAgICAgIC8vIG1pZ3JhdGlvbiAwMDQ7IGRlZmF1bHRzIHRvICdoYXJuZXNzJ1xuICBibHVlcHJpbnRfa2luZD86IHN0cmluZzsgICAgICAgICAgIC8vIG1pZ3JhdGlvbiAwMDkgLyBQLTAxODogYmx1ZXByaW50LnlhbWwga2luZCAoJ2hpdmUnfCdoYXJuZXNzJyksIGJsdWVwcmludCBsaXN0aW5ncyBvbmx5XG4gIHByb2plY3RfcmVmPzogc3RyaW5nOyAgICAgICAgICAgICAgLy8gcGFwZXJjdXBhaSBwcm9qZWN0IHJlbW90ZSAoRC0wMDgpXG4gIGxpc3RpbmdfcmVmPzogc3RyaW5nOyAgICAgICAgICAgICAgLy8gd2l0aGluLXByb2plY3QgZGlzY3JpbWluYXRvcjsgUkVRVUlSRUQgZm9yIG5vbi1oYXJuZXNzIGtpbmRzXG4gIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBudW1iZXI7XG4gIGdpdGh1Yl9vd25lcjogc3RyaW5nO1xuICBnaXRodWJfbmFtZTogc3RyaW5nO1xuICBnaXRodWJfdXJsOiBzdHJpbmc7XG4gIHRpdGxlPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgdG9waWNfaGV4Pzogc3RyaW5nOyAgICAgICAgICAgICAgICAvLyAzMi1ieXRlIGhleCBIeXBlcmNvcmUgdG9waWM7IFJFUVVJUkVEIGZvciBraW5kPSdoYXJuZXNzJ1xuICBhdHRlc3RhdGlvbl9naXN0X2lkPzogc3RyaW5nOyAgICAgIC8vIGNoYW5uZWwtMiAoaXRlbSAxKTogZ2lzdCBiaW5kaW5nIGRldmljZSBwdWJrZXkg4oaUIGxvZ2luXG4gIHB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5Pzogc3RyaW5nOyAgLy8gY2hhbm5lbC0yIChpdGVtIDEpOiBkZXZpY2UgRWQyNTUxOSBwdWJrZXkgKGJhc2U2NClcbiAgLy8gUGFjayBtb2RlbCAobWlncmF0aW9uIDAwNikuIE1DUCB0b29sIG5hbWVzIHRoZSB1bml0IHJlZ2lzdGVycyB3aGVuXG4gIC8vIGluc3RhbGxlZDsga2luZHMgcGx1Z2lufHBhY2sgb25seS4gU3RvcmVkIGFzIGEgSlNPTiBURVhUIGNvbHVtbiBhbmRcbiAgLy8gcmV0dXJuZWQgdmVyYmF0aW0gb24gR0VUICh0aGUgb3BlcmF0b3IncyByZXNvbHZlciBwYXJzZXMgaXQpLlxuICBwcm92aWRlc190b29scz86IHVua25vd247ICAgICAgICAgIC8vIGV4cGVjdGVkOiBzdHJpbmdbXVxuICAvLyBUb29sIGF4aXMsIGNvbnN1bWVyIGhhbGYgKG1pZ3JhdGlvbiAwMzMgLyBXSS0xMDAwMTc0NykuIE1DUCB0b29sIG5hbWVzIHRoZVxuICAvLyB1bml0IE9SQ0hFU1RSQVRFUyBidXQgZG9lcyBub3QgcHJvdmlkZTsgb3JjaGVzdHJhdGluZyBraW5kcyAocmVjaXBlfHBsYW58Z29hbClcbiAgLy8gb25seS4gU2FtZSBib3VuZGVkIHNoYXBlIGFuZCBzdG9yYWdlIHBvc3R1cmUgYXMgcHJvdmlkZXNfdG9vbHMg4oCUIGJ1dCBub3RoaW5nXG4gIC8vIHJlc29sdmVzIGEgcHJvdmlkZXIgZnJvbSBpdCwgYmVjYXVzZSB0aGUgdW5pdCByZWdpc3RlcnMgbm9uZSBvZiB0aGVzZS5cbiAgdXNlc190b29scz86IHVua25vd247ICAgICAgICAgICAgICAvLyBleHBlY3RlZDogc3RyaW5nW11cbiAgLy8gRXZlbnQgYXhpcyAobWlncmF0aW9uIDAxMiAvIEQtMDAzIC8gUC0wMDcpLiBUaGUgYXdhaXRhYmxlIGV2ZW50LWtleSBGQU1JTElFU1xuICAvLyB0aGUgdW5pdCByZWdpc3RlcnMgd2hlbiBpbnN0YWxsZWQ7IGtpbmRzIHBsdWdpbnxwYWNrIG9ubHkuIFN0b3JlZCBhcyBhIEpTT05cbiAgLy8gVEVYVCBjb2x1bW4gYW5kIHJldHVybmVkIHZlcmJhdGltIG9uIEdFVCAodGhlIG9wZXJhdG9yJ3MgcmVzb2x2ZXIgcGFyc2VzIGl0KS5cbiAgcHJvdmlkZXNfZXZlbnRzPzogdW5rbm93bjsgICAgICAgICAvLyBleHBlY3RlZDogQXJyYXk8eyBmYW1pbHksIGtleVRlbXBsYXRlLCBkZXNjcmliZT8gfT5cbiAgLy8gRXZlbnQgYXhpcywgY29uc3VtZXIgaGFsZiAobWlncmF0aW9uIDAxMyAvIEQtMDAzIC8gUC0wMDgpLiBUaGUgZXZlbnQta2V5XG4gIC8vIEZBTUlMSUVTIHRoZSB1bml0IFJFUVVJUkVTOyBraW5kcyBwbHVnaW58cGFjayBvbmx5LiBTYW1lIHN0b3JhZ2UgcG9zdHVyZS5cbiAgcmVxdWlyZXNfZXZlbnRzPzogdW5rbm93bjsgICAgICAgICAvLyBleHBlY3RlZDogQXJyYXk8eyBmYW1pbHksIG9wdGlvbmFsPyB9PlxuICByZXF1aXJlc19ydWJyaWNzPzogdW5rbm93bjsgICAgICAgIC8vIGV4cGVjdGVkOiBBcnJheTx7IHJ1YnJpY1JlZiwgb3B0aW9uYWw/IH0+IChtaWdyYXRpb24gMDE1KVxuICAvLyBUeXBlIHBhY2tzIChtaWdyYXRpb24gMDQ5IC8gcGxhbi1pdGVtLXR5cGVzLXJlZ2lzdHJ5LWN1cGJvYXJkLTIwMjYtMTAtMjAgUC0wMDYsIEQtMDA4KTpcbiAgLy8gdGhlIGl0ZW0gdHlwZXMgLyBwbGFuIHR5cGVzIGEgcGx1Z2lufHBhY2sgbWFuaWZlc3QgY2FycmllcywgYW5kIHRoZSBwbGFuIHR5cGUgYSBwbGFuXG4gIC8vIHRlbXBsYXRlIHJlcXVpcmVzLiBBIGxpc3RpbmcgZGVjbGFyaW5nIGFueSB0eXBlIGxhbmRzIFBFTkRJTkcgcmV2aWV3LlxuICBwcm92aWRlc19pdGVtX3R5cGVzPzogdW5rbm93bjsgICAgIC8vIGV4cGVjdGVkOiBBcnJheTx7IGlkLCByZXZpc2lvbiB9PlxuICBwcm92aWRlc19wbGFuX3R5cGVzPzogdW5rbm93bjsgICAgIC8vIGV4cGVjdGVkOiBBcnJheTx7IGlkLCByZXZpc2lvbiB9PlxuICByZXF1aXJlc19wbGFuX3R5cGU/OiB1bmtub3duOyAgICAgIC8vIGV4cGVjdGVkOiB7IGlkLCBtaW5SZXZpc2lvbj8sIG1heFJldmlzaW9uPyB9XG4gIC8vIFJlcG/ihpJIaXZlIGJpbmRpbmcgKG1pZ3JhdGlvbiAwMDcgLyBoaXZlLWZyb20tZ2l0aHViLXVybCBELTAwNCBIWUJSSUQpOlxuICAvLyBvd25pbmcgSGl2ZSdzIHJhdy0zMi1ieXRlLWJhc2U2NCBFZDI1NTE5IHB1YmtleSArIGRlbm9ybWFsaXplZCB0aXRsZS5cbiAgaGl2ZV9wdWJrZXk/OiB1bmtub3duOyAgICAgICAgICAgICAvLyBleHBlY3RlZDogNDQtY2hhciBiYXNlNjQgKDMyIGJ5dGVzKVxuICBoaXZlX3RpdGxlPzogdW5rbm93bjsgICAgICAgICAgICAgIC8vIGV4cGVjdGVkOiBzdHJpbmcg4omkMjAwOyByZXF1aXJlcyBoaXZlX3B1YmtleVxuICAvLyBBcHAgZGlzdHJpYnV0aW9uIChtaWdyYXRpb24gMDE0IC8gY3VwYm9hcmQtYXBwLWRpc3RyaWJ1dGlvbi0yMDI2LTA3LTE0IFAtMDAzKS5cbiAgLy8gQUxMIGFwcC1vbmx5IOKAlCB0aGUgd29ya2VyIDQwMHMgdGhlbSBvbiBhbnkgbm9uLWFwcCBraW5kLiBBIFNUQU5EQUxPTkUgYXBwJ3NcbiAgLy8gXCJpbnN0YWxsXCIgaXMgYSBkb3dubG9hZC1saW5rIGhhbmRvZmY6IHRoZSBDdXBib2FyZCBzdG9yZXMgbGF0ZXN0X2pzb25fdXJsIGFuZFxuICAvLyBuZXZlciByZS1ob3N0cyB0aGUgYmluYXJ5LiBkZWxpdmVyeV90eXBlIGRpc2NyaW1pbmF0ZXMgc3RhbmRhbG9uZXxidW5kbGUuXG4gIGRlbGl2ZXJ5X3R5cGU/OiB1bmtub3duOyAgICAgICAgICAgLy8gZXhwZWN0ZWQ6ICdzdGFuZGFsb25lJyB8ICdidW5kbGUnXG4gIGxhdGVzdF9qc29uX3VybD86IHVua25vd247ICAgICAgICAgLy8gZXhwZWN0ZWQ6IGh0dHBzIFVSTDsgUkVRVUlSRUQgZm9yIGEgc3RhbmRhbG9uZSBhcHBcbiAgcmVsZWFzZV9yZXBvPzogdW5rbm93bjsgICAgICAgICAgICAvLyBleHBlY3RlZDogJzxvd25lcj4vPHJlcG8+J1xuICBpY29uX3VybD86IHVua25vd247ICAgICAgICAgICAgICAgIC8vIGV4cGVjdGVkOiBodHRwcyBVUkxcbiAgcGxhdGZvcm1zPzogdW5rbm93bjsgICAgICAgICAgICAgICAvLyBleHBlY3RlZDogc3RyaW5nW10gb2YgT1Mga2V5cyBwcmVzZW50IGluIGxhdGVzdC5qc29uXG4gIC8vIOKUgOKUgCBDYXRhbG9nIGF4ZXMgKG1pZ3JhdGlvbiAwMTggLyBzaGFyZWQtcG90LWRhby1jdXBib2FyZC12MSBQLTAwOCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vIEtpbmQtYWdub3N0aWMsIHVubGlrZSB0aGUgYXBwX2ZpZWxkcyBibG9jayBhYm92ZTogYW55IGtpbmQgY2FuIGJlIHByaXZhdGUsXG4gIC8vIHByaWNlZCwgY29tcGF0aWJpbGl0eS1zY29wZWQsIHBlcm1pc3Npb24tZGVjbGFyaW5nLCBvciByZWxlYXNlLXBpbm5lZC5cbiAgdmlzaWJpbGl0eT86IHVua25vd247ICAgICAgICAgICAgICAvLyBleHBlY3RlZDogJ3B1YmxpYycgfCAndW5saXN0ZWQnIHwgJ3ByaXZhdGUnXG4gIHRlbmFudF9pZD86IHVua25vd247ICAgICAgICAgICAgICAgLy8gZXhwZWN0ZWQ6IHN0cmluZyDigJQgb3duaW5nIHNoYXJlZCBwb3RcbiAgc2t1X3JlZj86IHVua25vd247ICAgICAgICAgICAgICAgICAvLyBleHBlY3RlZDogc3RyaW5nIOKAlCBwcm92aWRlci1uZXV0cmFsIFNLVSBpZFxuICBwcmljaW5nX21vZGVsPzogdW5rbm93bjsgICAgICAgICAgIC8vIGV4cGVjdGVkOiAnZnJlZSd8J29uZS10aW1lJ3wnc3Vic2NyaXB0aW9uJ3wncGVyLXVzZSdcbiAgcHJpY2VfYW1vdW50X21pY3Jvcz86IHVua25vd247ICAgICAvLyBleHBlY3RlZDogbm9uLW5lZ2F0aXZlIGludGVnZXIsIG1pbm9yIHVuaXRzIMOXIDFlNlxuICBwcmljZV9jdXJyZW5jeT86IHVua25vd247ICAgICAgICAgIC8vIGV4cGVjdGVkOiBzdHJpbmcg4oCUIElTTy00MjE3IG9yIHN0YWJsZWNvaW4gc3ltYm9sXG4gIGNvbXBhdGliaWxpdHk/OiB1bmtub3duOyAgICAgICAgICAgLy8gZXhwZWN0ZWQ6IHsgcnVudGltZT8sIHBsYXRmb3Jtcz86IHN0cmluZ1tdLCBhcmNoaXRlY3R1cmVzPzogc3RyaW5nW10gfVxuICByZXF1aXJlZF9wZXJtaXNzaW9ucz86IHVua25vd247ICAgIC8vIGV4cGVjdGVkOiBzdHJpbmdbXVxuICByZWxlYXNlX3ZlcnNpb24/OiB1bmtub3duOyAgICAgICAgIC8vIGV4cGVjdGVkOiBzdHJpbmdcbiAgcmVsZWFzZV9jb250ZW50X2hhc2g/OiB1bmtub3duOyAgICAvLyBleHBlY3RlZDogJ3NoYTI1Njo8NjQgaGV4PidcbiAgcmVsZWFzZV9tYW5pZmVzdF9kaWdlc3Q/OiB1bmtub3duOyAvLyBleHBlY3RlZDogc3RyaW5nIOKAlCBsaXN0aW5nTWFuaWZlc3REaWdlc3QoKVxuICByZWxlYXNlX3NpZ25hdHVyZT86IHVua25vd247ICAgICAgIC8vIGV4cGVjdGVkOiBzdHJpbmdcbiAgcmVsZWFzZV9tYW5pZmVzdD86IHVua25vd247ICAgICAgICAvLyBleHBlY3RlZDogc3RyaW5nIOKAlCBjYW5vbmljYWwgSlNPTiBvZiB0aGUgc2lnbmVkIEN1cGJvYXJkUmVsZWFzZU1hbmlmZXN0XG4gIGlkZW50aXR5X3N1cmZhY2U/OiB1bmtub3duOyAgICAgICAgLy8gZXhwZWN0ZWQ6IHN0cmluZyDigJQgY2Fub25pY2FsIEpTT04gSWRlbnRpdHlMaXN0aW5nU3VyZmFjZTsgYmx1ZXByaW50X2tpbmQgJ2lkZW50aXR5JyBvbmx5XG59XG5cbi8qKiBwcm92aWRlc190b29scyBjYXBzIChtaWdyYXRpb24gMDA2KTogYm91bmRlZCBzbyBhIGxpc3RpbmcgY2FuJ3Qgc211Z2dsZSBhIHBheWxvYWQuICovXG5jb25zdCBQUk9WSURFU19UT09MU19NQVhfRU5UUklFUyA9IDIwMDtcbi8qKiBUeXBlLXBhY2sgZGVjbGFyYXRpb24gY2FwcyAobWlncmF0aW9uIDA0OSk6IHRoZSByZWdpc3RyeSdzIHR5cGUtaWQgZ3JhbW1hciwgYm91bmRlZCBjb3VudC4gKi9cbmNvbnN0IFRZUEVfREVDTEFSQVRJT05TX01BWCA9IDEwMDtcbmNvbnN0IFRZUEVfSURfUkUgPSAvXlthLXowLTldW2EtejAtOS1dKlxcL1thLXowLTldW2EtejAtOS1dKiQvO1xuY29uc3QgUFJPVklERVNfVE9PTFNfTUFYX05BTUVfTEVOID0gMTI4O1xuXG4vKipcbiAqIEtpbmRzIHRoYXQgbWF5IGRlY2xhcmUgYHVzZXNfdG9vbHNgIChtaWdyYXRpb24gMDMzIC8gV0ktMTAwMDE3NDcpOiB0aGUgdW5pdHNcbiAqIHRoYXQgT1JDSEVTVFJBVEUgdG9vbHMgcmF0aGVyIHRoYW4gcmVnaXN0ZXIgdGhlbS4gRGVsaWJlcmF0ZWx5IGRpc2pvaW50IGZyb21cbiAqIHRoZSBwbHVnaW58cGFjayBnYXRlIG9uIGBwcm92aWRlc190b29sc2Ag4oCUIGEgdW5pdCB0aGF0IHByb3ZpZGVzIHRvb2xzIGlzXG4gKiByZXNvbHZlZCBhcyB0aGVpciBwcm92aWRlciBhdCBpbnN0YWxsOyBhIHVuaXQgdGhhdCBtZXJlbHkgdXNlcyB0aGVtIGlzIG5vdC5cbiAqL1xuY29uc3QgVVNFU19UT09MU19LSU5EUyA9IFsncmVjaXBlJywgJ3BsYW4nLCAnZ29hbCddIGFzIGNvbnN0O1xuXG4vKiogcHJvdmlkZXNfZXZlbnRzIGNhcHMgKG1pZ3JhdGlvbiAwMTIpOiBzYW1lIHBvc3R1cmUg4oCUIGEgZGVjbGFyYXRpb24sIG5vdCBhIHBheWxvYWQuICovXG5jb25zdCBQUk9WSURFU19FVkVOVFNfTUFYX0VOVFJJRVMgPSAyMDA7XG5jb25zdCBQUk9WSURFU19FVkVOVFNfTUFYX0ZBTUlMWV9MRU4gPSAxMjg7XG5jb25zdCBQUk9WSURFU19FVkVOVFNfTUFYX1RFTVBMQVRFX0xFTiA9IDI1NjtcbmNvbnN0IFBST1ZJREVTX0VWRU5UU19NQVhfREVTQ1JJQkVfTEVOID0gMzAwO1xuXG4vKiogcmVxdWlyZXNfZXZlbnRzIGNhcHMgKG1pZ3JhdGlvbiAwMTMpOiBhIGRlY2xhcmF0aW9uLCBub3QgYSBwYXlsb2FkLiAqL1xuY29uc3QgUkVRVUlSRVNfRVZFTlRTX01BWF9FTlRSSUVTID0gMjAwO1xuY29uc3QgUkVRVUlSRVNfRVZFTlRTX01BWF9GQU1JTFlfTEVOID0gMTI4O1xuXG4vKiogcmVxdWlyZXNfcnVicmljcyBjYXBzIChtaWdyYXRpb24gMDE1KTogc2FtZSBwb3N0dXJlLiBUaGUgcmVmIGNhcCBtYXRjaGVzXG4gKiAgTElTVElOR19SRUZfUkUncyAyMDAsIHNpbmNlIGEgcnVicmljUmVmIGlzIG1hdGNoZWQgYWdhaW5zdCBhIHJ1YnJpYyBsaXN0aW5nJ3NcbiAqICBsaXN0aW5nX3JlZiDigJQgYSBsb25nZXIgb25lIGNvdWxkIG5ldmVyIHJlc29sdmUuICovXG5jb25zdCBSRVFVSVJFU19SVUJSSUNTX01BWF9FTlRSSUVTID0gMjAwO1xuY29uc3QgUkVRVUlSRVNfUlVCUklDU19NQVhfUkVGX0xFTiA9IDIwMDtcblxuY29uc3QgVE9QSUNfSEVYX1JFID0gL15bMC05YS1mXXs2NH0kLztcbi8vIFN0YW5kYXJkIGJhc2U2NCBvZiBleGFjdGx5IDMyIHJhdyBieXRlcyAoYW4gRWQyNTUxOSBwdWJrZXkpOiA0MyBjaGFycyArICc9Jy5cbi8vIFNhbWUgZW5jb2RpbmcgYXMgdGhlIGhpdmUgZGlyZWN0b3J5IGFubm91bmNlJ3MgaGl2ZV9wdWJrZXkgKG1pZ3JhdGlvbiAwMDcpLlxuY29uc3QgSElWRV9QVUJLRVlfUkUgPSAvXltBLVphLXowLTkrL117NDN9PSQvO1xuY29uc3QgSElWRV9USVRMRV9NQVggPSAyMDA7XG4vLyBTbHVnLWlzaDogYmx1ZXByaW50IHN0cmVhbSBuYW1lIC8gc25hcHNob3QgaWQgLyBwbHVnaW4gc2x1Zy4gUGVybWl0cyBwYXRoLXlcbi8vIHJlZnMgKGEvYikgYW5kIGRvdHRlZCB2ZXJzaW9uczsgYm91bmRlZCBsZW5ndGguXG5jb25zdCBMSVNUSU5HX1JFRl9SRSA9IC9eW0EtWmEtejAtOS5fLy1dezEsMjAwfSQvO1xuY29uc3QgUFJPSkVDVF9SRUZfTUFYID0gMzAwO1xuXG4vLyBBcHAgZGlzdHJpYnV0aW9uIChtaWdyYXRpb24gMDE0KS4gQW4gaHR0cHMgaW5zdGFsbGVyLWhhbmRvZmYgdXJsIG11c3Qgbm90IGJlXG4vLyBkb3duZ3JhZGVhYmxlOyBhIHJlbGVhc2VfcmVwbyBpcyBhIGJhcmUgYDxvd25lcj4vPHJlcG8+YDsgcGxhdGZvcm1zIGlzIGEgc21hbGxcbi8vIGRlbm9ybWFsaXplZCBzZXQgb2YgT1Mga2V5cyAoYSBoaW50LCBub3QgYSBwYXlsb2FkKS5cbmNvbnN0IEFQUF9VUkxfTUFYID0gNTAwO1xuY29uc3QgSFRUUFNfVVJMX1JFID0gL15odHRwczpcXC9cXC9bXlxcc117MSw0OTR9JC87XG5jb25zdCBSRUxFQVNFX1JFUE9fUkUgPSAvXltBLVphLXowLTkuXy1dezEsMTAwfVxcL1tBLVphLXowLTkuXy1dezEsMTAwfSQvO1xuLyoqIEltbXV0YWJsZS1yZWxlYXNlIGNvbnRlbnQgaWRlbnRpdHkgKG1pZ3JhdGlvbiAwMTggLyBQLTAwOCkg4oCUIHRoZSBTQU1FIHNoYXBlXG4gKiAgYHZhbGlkYXRlTGlzdGluZ01hbmlmZXN0YCBlbmZvcmNlcyBvbiBgY29udGVudEhhc2hgLCBzbyBhIGxpc3Rpbmcgcm93IGFuZCB0aGVcbiAqICBzaWduZWQgbWFuaWZlc3QgaXQgcG9pbnRzIGF0IGNhbm5vdCBkaXNhZ3JlZSBhYm91dCB3aGF0IGEgY29udGVudCBoYXNoIGlzLiAqL1xuY29uc3QgQ09OVEVOVF9IQVNIX1JFID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC9pO1xuY29uc3QgQVBQX1BMQVRGT1JNU19NQVhfRU5UUklFUyA9IDIwO1xuY29uc3QgQVBQX1BMQVRGT1JNX0tFWV9NQVhfTEVOID0gNjQ7XG5cbmZ1bmN0aW9uIHV1aWR2NCgpOiBzdHJpbmcge1xuICAvLyBjcnlwdG8ucmFuZG9tVVVJRCBpcyBhdmFpbGFibGUgaW4gV29ya2VycyArIE5vZGUgMTkrICsgYnJvd3NlclxuICByZXR1cm4gKGNyeXB0byBhcyB7IHJhbmRvbVVVSUQ6ICgpID0+IHN0cmluZyB9KS5yYW5kb21VVUlEKCk7XG59XG5cbi8qKlxuICogRGVyaXZlIGEgc2luZ2xlIHBlcm1pc3Npb24gbGV2ZWwgZnJvbSBHaXRIdWIncyByZXBvIGBwZXJtaXNzaW9uc2BcbiAqIG9iamVjdCAoYm9vbGVhbnMpLCByZXR1cm5lZCBieSBHRVQgL3JlcG9zLzpvd25lci86cmVwbyB3aGVuIGZldGNoZWRcbiAqIHdpdGggYSB1c2VyIHRva2VuLiBIaWdoZXN0IGFwcGxpY2FibGUgd2lucy4gRm9yIGEgUFVCTElDIHJlcG8gYVxuICogbm9uLWNvbGxhYm9yYXRvciBzdGlsbCBnZXRzIGBwdWxsOiB0cnVlYCDih5IgJ3JlYWQnOyBhbiBhY3R1YWxcbiAqIGNvbGxhYm9yYXRvciBnZXRzIHB1c2gvbWFpbnRhaW4vYWRtaW4uIFNvICdyZWFkJy8nbm9uZScg4oeSIG5vdCBhXG4gKiBjb2xsYWJvcmF0b3IuIEl0ZW0gMiBvZiB0aGUgY3VwYm9hcmQtcHJvdmlzaW9uYWwtbGlzdGluZy10cnVzdCBtZW1vLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlUHVibGlzaGVyUGVybWlzc2lvbihcbiAgcGVybXM6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+IHwgdW5kZWZpbmVkIHwgbnVsbCxcbik6ICdhZG1pbicgfCAnbWFpbnRhaW4nIHwgJ3dyaXRlJyB8ICd0cmlhZ2UnIHwgJ3JlYWQnIHwgJ25vbmUnIHtcbiAgaWYgKCFwZXJtcykgcmV0dXJuICdub25lJztcbiAgaWYgKHBlcm1zLmFkbWluKSByZXR1cm4gJ2FkbWluJztcbiAgaWYgKHBlcm1zLm1haW50YWluKSByZXR1cm4gJ21haW50YWluJztcbiAgaWYgKHBlcm1zLnB1c2gpIHJldHVybiAnd3JpdGUnO1xuICBpZiAocGVybXMudHJpYWdlKSByZXR1cm4gJ3RyaWFnZSc7XG4gIGlmIChwZXJtcy5wdWxsKSByZXR1cm4gJ3JlYWQnO1xuICByZXR1cm4gJ25vbmUnO1xufVxuXG5pbnRlcmZhY2UgTW91bnRPcHRzIHtcbiAgLyoqIFdoZW4gc2V0LCB0aGUgbW91bnQgc2VydmVzIGV4YWN0bHkgdGhpcyBraW5kICh0aGUgL2hhcm5lc3NlcyBiYWNrLWNvbXBhdCB2aWV3KS4gKi9cbiAgZml4ZWRLaW5kPzogTGlzdGluZ0tpbmQ7XG59XG5cbi8qKiBSZWdpc3RlciB0aGUgZml2ZSBsaXN0aW5nIGVuZHBvaW50cyB1bmRlciBgYmFzZWAsIGtpbmQtcGlubmVkIG9yIGtpbmQtYXdhcmUuICovXG5mdW5jdGlvbiByZWdpc3Rlckxpc3RpbmdFbmRwb2ludHMoXG4gIGFwcDogSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4sXG4gIGJhc2U6IHN0cmluZyxcbiAgb3B0czogTW91bnRPcHRzID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3QgeyBmaXhlZEtpbmQgfSA9IG9wdHM7XG5cbiAgLy8gR0VUIGJhc2Ug4oCUIHB1YmxpYyBsaXN0aW5nLlxuICBhcHAuZ2V0KGJhc2UsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3QgaXAgPSBjbGllbnRJcChjLnJlcS5yYXcpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjaGVja0lwTGlzdFBlck1pbnV0ZShjLmVudiwgaXApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlIGluc3RhbmNlb2YgUmF0ZUxpbWl0RXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3JhdGVfbGltaXRlZCcgfSwgNDI5KTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoYy5yZXEudXJsKTtcbiAgICBjb25zdCByYXdMaW1pdCA9IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldCgnbGltaXQnKSA/PyAnMzAnLCAxMCk7XG4gICAgY29uc3QgbGltaXQgPSBOdW1iZXIuaXNGaW5pdGUocmF3TGltaXQpID8gTWF0aC5taW4oTWF0aC5tYXgocmF3TGltaXQsIDEpLCAxMDApIDogMzA7XG4gICAgY29uc3QgY3Vyc29yUmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2N1cnNvcicpO1xuICAgIGNvbnN0IGN1cnNvciA9IGN1cnNvclJhdyA9PSBudWxsID8gbnVsbCA6IHBhcnNlTGlzdGluZ0N1cnNvcihjdXJzb3JSYXcpO1xuICAgIGlmIChjdXJzb3JSYXcgIT0gbnVsbCAmJiBjdXJzb3IgPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnY3Vyc29yJyB9LCA0MDApO1xuICAgIH1cbiAgICBjb25zdCBzZWFyY2ggPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncScpID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjbGFpbV9zdGF0dXNfcmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2NsYWltJyk7XG4gICAgY29uc3QgY2xhaW1fc3RhdHVzOiBQdWJsaWNMaXN0T3B0c1snY2xhaW1fc3RhdHVzJ10gPVxuICAgICAgY2xhaW1fc3RhdHVzX3JhdyA9PT0gJ2NsYWltZWQnXG4gICAgICAgID8gJ2NsYWltZWQnXG4gICAgICAgIDogY2xhaW1fc3RhdHVzX3JhdyA9PT0gJ3VuY2xhaW1lZCdcbiAgICAgICAgICA/ICd1bmNsYWltZWQnXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgLy8gS2luZDogcGlubmVkIG9uIC9oYXJuZXNzZXM7IGZyb20gP2tpbmQ9IG9uIC9saXN0aW5ncyAob21pdCDih5IgYWxsIGtpbmRzKS5cbiAgICBsZXQga2luZDogTGlzdGluZ0tpbmQgfCB1bmRlZmluZWQgPSBmaXhlZEtpbmQ7XG4gICAgaWYgKCFraW5kKSB7XG4gICAgICBjb25zdCBraW5kUmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2tpbmQnKTtcbiAgICAgIGlmIChraW5kUmF3ICE9IG51bGwgJiYga2luZFJhdyAhPT0gJycgJiYga2luZFJhdyAhPT0gJ2FsbCcpIHtcbiAgICAgICAgLy8gbm9ybWFsaXplTGlzdGluZ0tpbmQgbWFwcyB0aGUgaW50ZXJpbSAndG9vbC1wYWNrJyArIHByZS0wMDggJ3BhY2snXG4gICAgICAgIC8vIHdpcmUgYWxpYXNlcyB0byB0aGUgY2Fub25pY2FsICdwYWNrJyAobWlncmF0aW9uIDAxMCAvIFAtMDAzKS5cbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUxpc3RpbmdLaW5kKGtpbmRSYXcpO1xuICAgICAgICBpZiAoIW5vcm1hbGl6ZWQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2tpbmQnIH0sIDQwMCk7XG4gICAgICAgIGtpbmQgPSBub3JtYWxpemVkO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBwcm9qZWN0X3JlZiA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwcm9qZWN0JykgPz8gdW5kZWZpbmVkO1xuXG4gICAgLy8g4pSA4pSAIENhdGFsb2cgZmlsdGVycyAobWlncmF0aW9uIDAxOCAvIHNoYXJlZC1wb3QtZGFvLWN1cGJvYXJkLXYxIFAtMDA4KSDilIDilIDilIBcbiAgICAvLyBFdmVyeSBvbmUgb2YgdGhlc2UgTkFSUk9XUy4gYHRlbmFudF9zY29wZWAg4oCUIHRoZSBvbmx5IHdpZGVuaW5nIG9wdGlvbiwgdGhlXG4gICAgLy8gb25lIHRoYXQgY2FuIHN1cmZhY2UgYW4gdW5saXN0ZWQvcHJpdmF0ZSByb3cg4oCUIGlzIGRlbGliZXJhdGVseSBOT1RcbiAgICAvLyByZWFjaGFibGUgZnJvbSBhIHF1ZXJ5IHBhcmFtOiB0aGlzIGVuZHBvaW50IGlzIHVuYXV0aGVudGljYXRlZCwgc28gYVxuICAgIC8vIGA/dGVuYW50PWAgdGhhdCB3aWRlbmVkIHdvdWxkIGhhbmQgYW55IGNhbGxlciBhbm90aGVyIHBvdCdzIHByaXZhdGVcbiAgICAvLyBjYXRhbG9nLiBgP3RlbmFudD1gIG1hcHMgdG8gdGhlIG5hcnJvd2luZyBgdGVuYW50X3JlZmAgaW5zdGVhZC5cbiAgICBjb25zdCB2aXNpYmlsaXR5UmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3Zpc2liaWxpdHknKTtcbiAgICBsZXQgdmlzaWJpbGl0eTogTGlzdGluZ1Zpc2liaWxpdHkgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHZpc2liaWxpdHlSYXcgIT0gbnVsbCAmJiB2aXNpYmlsaXR5UmF3ICE9PSAnJyAmJiB2aXNpYmlsaXR5UmF3ICE9PSAnYWxsJykge1xuICAgICAgaWYgKCFpc0xpc3RpbmdWaXNpYmlsaXR5KHZpc2liaWxpdHlSYXcpKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3Zpc2liaWxpdHknIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICB2aXNpYmlsaXR5ID0gdmlzaWJpbGl0eVJhdztcbiAgICB9XG4gICAgY29uc3QgcHJpY2luZ1JhdyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwcmljaW5nJyk7XG4gICAgbGV0IHByaWNpbmdfbW9kZWw6IFByaWNpbmdNb2RlbCB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJpY2luZ1JhdyAhPSBudWxsICYmIHByaWNpbmdSYXcgIT09ICcnICYmIHByaWNpbmdSYXcgIT09ICdhbGwnKSB7XG4gICAgICBpZiAoIWlzUHJpY2luZ01vZGVsKHByaWNpbmdSYXcpKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3ByaWNpbmcnIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICBwcmljaW5nX21vZGVsID0gcHJpY2luZ1JhdztcbiAgICB9XG4gICAgY29uc3QgcGFpZFJhdyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYWlkJyk7XG4gICAgbGV0IHBhaWQ6IGJvb2xlYW4gfCB1bmRlZmluZWQ7XG4gICAgaWYgKHBhaWRSYXcgIT0gbnVsbCAmJiBwYWlkUmF3ICE9PSAnJykge1xuICAgICAgaWYgKHBhaWRSYXcgIT09ICcxJyAmJiBwYWlkUmF3ICE9PSAnMCcgJiYgcGFpZFJhdyAhPT0gJ3RydWUnICYmIHBhaWRSYXcgIT09ICdmYWxzZScpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncGFpZCcgfSwgNDAwKTtcbiAgICAgIH1cbiAgICAgIHBhaWQgPSBwYWlkUmF3ID09PSAnMScgfHwgcGFpZFJhdyA9PT0gJ3RydWUnO1xuICAgIH1cbiAgICAvLyBCbHVlcHJpbnQgZmFjZXQgKG1pZ3JhdGlvbnMgMDA5LzAzNSk6ID9ibHVlcHJpbnRfa2luZD1pZGVudGl0eSBsaXN0cyBpZGVudGl0aWVzLlxuICAgIGNvbnN0IGJsdWVwcmludEtpbmRSYXcgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnYmx1ZXByaW50X2tpbmQnKTtcbiAgICBsZXQgYmx1ZXByaW50X2tpbmQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBpZiAoYmx1ZXByaW50S2luZFJhdyAhPSBudWxsICYmIGJsdWVwcmludEtpbmRSYXcgIT09ICcnICYmIGJsdWVwcmludEtpbmRSYXcgIT09ICdhbGwnKSB7XG4gICAgICBpZiAoYmx1ZXByaW50S2luZFJhdyAhPT0gJ2hpdmUnICYmIGJsdWVwcmludEtpbmRSYXcgIT09ICdoYXJuZXNzJyAmJiBibHVlcHJpbnRLaW5kUmF3ICE9PSAnaWRlbnRpdHknKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2JsdWVwcmludF9raW5kJyB9LCA0MDApO1xuICAgICAgfVxuICAgICAgYmx1ZXByaW50X2tpbmQgPSBibHVlcHJpbnRLaW5kUmF3O1xuICAgIH1cbiAgICBjb25zdCBmaWx0ZXJzID0ge1xuICAgICAgbGltaXQsXG4gICAgICBjdXJzb3IsXG4gICAgICBzZWFyY2gsXG4gICAgICBjbGFpbV9zdGF0dXMsXG4gICAgICBraW5kLFxuICAgICAgYmx1ZXByaW50X2tpbmQsXG4gICAgICBwcm9qZWN0X3JlZixcbiAgICAgIHZpc2liaWxpdHksXG4gICAgICB0ZW5hbnRfcmVmOiB1cmwuc2VhcmNoUGFyYW1zLmdldCgndGVuYW50JykgPz8gdW5kZWZpbmVkLFxuICAgICAgcHJpY2luZ19tb2RlbCxcbiAgICAgIHBhaWQsXG4gICAgICBwbGF0Zm9ybTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BsYXRmb3JtJykgPz8gdW5kZWZpbmVkLFxuICAgICAgcnVudGltZTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3J1bnRpbWUnKSA/PyB1bmRlZmluZWQsXG4gICAgICBwZXJtaXNzaW9uOiB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGVybWlzc2lvbicpID8/IHVuZGVmaW5lZCxcbiAgICAgIHByb3ZpZGVzX2l0ZW1fdHlwZTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3Byb3ZpZGVzX2l0ZW1fdHlwZScpID8/IHVuZGVmaW5lZCxcbiAgICAgIHByb3ZpZGVzX3BsYW5fdHlwZTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3Byb3ZpZGVzX3BsYW5fdHlwZScpID8/IHVuZGVmaW5lZCxcbiAgICB9O1xuICAgIGNvbnN0IFt7IHJlc3VsdHMsIG5leHRfY3Vyc29yIH0sIHsgdG90YWwsIGtpbmRfZmFjZXRzIH1dID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgbGlzdFB1YmxpY0hhcm5lc3Nlc1BhZ2UoYy5lbnYuREIsIGZpbHRlcnMpLFxuICAgICAgc3VtbWFyaXplUHVibGljSGFybmVzc2VzKGMuZW52LkRCLCBmaWx0ZXJzKSxcbiAgICBdKTtcbiAgICByZXR1cm4gYy5qc29uKHsgcmVzdWx0cywgbmV4dF9jdXJzb3IsIHRvdGFsLCBraW5kX2ZhY2V0cyB9KTtcbiAgfSk7XG5cbiAgLy8gR0VUIGJhc2UvOmlkIOKAlCBzaW5nbGUgbGlzdGluZy5cbiAgYXBwLmdldChgJHtiYXNlfS86aWRgLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IGlkID0gYy5yZXEucGFyYW0oJ2lkJyk7XG4gICAgY29uc3Qgcm93ID0gYXdhaXQgZ2V0SGFybmVzc0J5SWQoYy5lbnYuREIsIGlkKTtcbiAgICBpZiAoIXJvdyB8fCByb3cudW5saXN0ZWRfYXQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICAvLyBPbiB0aGUga2luZC1waW5uZWQgbW91bnQsIGEgcm93IG9mIGFub3RoZXIga2luZCBpcyBub3QgZm91bmQgaGVyZS5cbiAgICBpZiAoZml4ZWRLaW5kICYmIHJvdy5saXN0aW5nX2tpbmQgIT09IGZpeGVkS2luZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIGlmIChyb3cucHVibGlzaGVyX2RldmljZV9wdWJrZXkpIHtcbiAgICAgIGNvbnN0IGJhbm5lZCA9IGF3YWl0IGxpc3RCYW5uZWRQdWJrZXlTZXQoYy5lbnYuREIpO1xuICAgICAgaWYgKGJhbm5lZC5oYXMocm93LnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5KSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIH1cbiAgICAvLyBQcmUtcHVibGljYXRpb24gcmV2aWV3IChrbm93bGVkZ2UtcGFja3MgRC0wMDcpOiBhIHBlbmRpbmcvcmVqZWN0ZWRcbiAgICAvLyBsaXN0aW5nIGlzIHB1YmxpY2x5IGludmlzaWJsZSDigJQgb25seSBpdHMgUFVCTElTSEVSIHJlYWRzIGl0ICh0aGVcbiAgICAvLyBcInBlbmRpbmcgYXBwcm92YWxcIiBzdGF0ZSArIGEgcmVqZWN0aW9uJ3MgcmVhc29uKTsgb3BlcmF0b3JzIHVzZSAvYWRtaW4uXG4gICAgaWYgKHJvdy5yZXZpZXdfc3RhdHVzICE9PSAnYXBwcm92ZWQnKSB7XG4gICAgICBsZXQgdmlld2VySWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdmlld2VySWQgPSAoYXdhaXQgcmVzb2x2ZUdpdGh1YkJlYXJlcihjLnJlcS5yYXcpKS5pZDtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiB1bmF1dGhlbnRpY2F0ZWQgdmlld2VyICovXG4gICAgICB9XG4gICAgICBpZiAodmlld2VySWQgIT09IHJvdy5wdWJsaXNoZXJfZ2l0aHViX3VzZXJfaWQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbihyb3cpO1xuICB9KTtcblxuICAvLyBQT1NUIGJhc2Ug4oCUIHB1Ymxpc2guXG4gIGFwcC5wb3N0KGJhc2UsIGFzeW5jIChjKSA9PiB7XG4gICAgbGV0IHVzZXI7XG4gICAgdHJ5IHtcbiAgICAgIHVzZXIgPSBhd2FpdCByZXNvbHZlR2l0aHViQmVhcmVyKGMucmVxLnJhdyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2F1dGgnLCByZWFzb246IGUucmVhc29uIH0sIDQwMSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNoZWNrQW5kUmVjb3JkVXNlclB1Ymxpc2hIb3VybHkoYy5lbnYsIHVzZXIuaWQsIG5vdyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBSYXRlTGltaXRFcnJvcikge1xuICAgICAgICBhd2FpdCBhdWRpdChjLmVudi5EQiwgbm93LCAncHVibGlzaF9yYXRlX2xpbWl0ZWQnLCB7IHVzZXJfaWQ6IHVzZXIuaWQgfSk7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3JhdGVfbGltaXRlZCcsIGJ1Y2tldDogZS5idWNrZXQgfSwgNDI5KTtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfVxuXG4gICAgbGV0IGJvZHk6IFB1Ymxpc2hCb2R5O1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gKGF3YWl0IGMucmVxLmpzb24oKSkgYXMgUHVibGlzaEJvZHk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2pzb24nIH0sIDQwMCk7XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSB0aGUga2luZDogcGlubmVkIG9uIC9oYXJuZXNzZXM7IGZyb20gYm9keSBvbiAvbGlzdGluZ3MgKGRlZmF1bHRcbiAgICAvLyBoYXJuZXNzKS4gbm9ybWFsaXplTGlzdGluZ0tpbmQgbWFwcyB0aGUgaW50ZXJpbSAndG9vbC1wYWNrJyArIHByZS0wMDhcbiAgICAvLyAncGFjaycgd2lyZSBhbGlhc2VzIHRvIHRoZSBjYW5vbmljYWwgJ3BhY2snIChtaWdyYXRpb24gMDEwIC8gUC0wMDMpLlxuICAgIGxldCBraW5kOiBMaXN0aW5nS2luZDtcbiAgICBpZiAoZml4ZWRLaW5kKSB7XG4gICAgICBraW5kID0gZml4ZWRLaW5kO1xuICAgIH0gZWxzZSBpZiAoYm9keS5saXN0aW5nX2tpbmQgPT0gbnVsbCkge1xuICAgICAga2luZCA9ICdoYXJuZXNzJztcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUxpc3RpbmdLaW5kKGJvZHkubGlzdGluZ19raW5kKTtcbiAgICAgIGlmICghbm9ybWFsaXplZCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnbGlzdGluZ19raW5kJyB9LCA0MDApO1xuICAgICAga2luZCA9IG5vcm1hbGl6ZWQ7XG4gICAgfVxuXG4gICAgLy8gQ29tbW9uIGZpZWxkIHZhbGlkYXRpb24gKGV2ZXJ5IGtpbmQgaXMgcHJvamVjdC1yZW1vdGUtYmFja2VkIGluIHYxKS5cbiAgICBpZiAodHlwZW9mIGJvZHkuZ2l0aHViX3JlcG9zaXRvcnlfaWQgIT09ICdudW1iZXInIHx8IGJvZHkuZ2l0aHViX3JlcG9zaXRvcnlfaWQgPD0gMCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnZ2l0aHViX3JlcG9zaXRvcnlfaWQnIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgYm9keS5naXRodWJfb3duZXIgIT09ICdzdHJpbmcnIHx8ICFib2R5LmdpdGh1Yl9vd25lcikge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnZ2l0aHViX293bmVyJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGJvZHkuZ2l0aHViX25hbWUgIT09ICdzdHJpbmcnIHx8ICFib2R5LmdpdGh1Yl9uYW1lKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdnaXRodWJfbmFtZScgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LmdpdGh1Yl91cmwgIT09ICdzdHJpbmcnIHx8ICEvXmh0dHBzOlxcL1xcL2dpdGh1YlxcLmNvbVxcLy8udGVzdChib2R5LmdpdGh1Yl91cmwpKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdnaXRodWJfdXJsJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5kZXNjcmlwdGlvbiAhPSBudWxsICYmICh0eXBlb2YgYm9keS5kZXNjcmlwdGlvbiAhPT0gJ3N0cmluZycgfHwgYm9keS5kZXNjcmlwdGlvbi5sZW5ndGggPiAyODApKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdkZXNjcmlwdGlvbicgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKGJvZHkudGl0bGUgIT0gbnVsbCAmJiAodHlwZW9mIGJvZHkudGl0bGUgIT09ICdzdHJpbmcnIHx8IGJvZHkudGl0bGUubGVuZ3RoID4gMjAwKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAndGl0bGUnIH0sIDQwMCk7XG4gICAgfVxuXG4gICAgLy8gS2luZC1zcGVjaWZpYyBzaGFwZS5cbiAgICAvLyAgaGFybmVzcyAgIOKGkiB0b3BpY19oZXggUkVRVUlSRUQgKHRoZSBIeXBlcmNvcmUgam9pbiB0b3BpYykuXG4gICAgLy8gIG5vbi1oYXJuZXNzIOKGkiB0b3BpY19oZXggb3B0aW9uYWw7IGxpc3RpbmdfcmVmIFJFUVVJUkVEICh0aGUgd2l0aGluLXByb2plY3RcbiAgICAvLyAgICAgICAgICAgICAgIGRpc2NyaW1pbmF0b3IpOyBwcm9qZWN0X3JlZiBvcHRpb25hbC5cbiAgICBpZiAoa2luZCA9PT0gJ2hhcm5lc3MnKSB7XG4gICAgICBpZiAodHlwZW9mIGJvZHkudG9waWNfaGV4ICE9PSAnc3RyaW5nJyB8fCAhVE9QSUNfSEVYX1JFLnRlc3QoYm9keS50b3BpY19oZXgpKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3RvcGljX2hleCcgfSwgNDAwKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGJvZHkudG9waWNfaGV4ICE9IG51bGwgJiYgKHR5cGVvZiBib2R5LnRvcGljX2hleCAhPT0gJ3N0cmluZycgfHwgIVRPUElDX0hFWF9SRS50ZXN0KGJvZHkudG9waWNfaGV4KSkpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAndG9waWNfaGV4JyB9LCA0MDApO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBib2R5Lmxpc3RpbmdfcmVmICE9PSAnc3RyaW5nJyB8fCAhTElTVElOR19SRUZfUkUudGVzdChib2R5Lmxpc3RpbmdfcmVmKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdsaXN0aW5nX3JlZicgfSwgNDAwKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKFxuICAgICAgYm9keS5wcm9qZWN0X3JlZiAhPSBudWxsICYmXG4gICAgICAodHlwZW9mIGJvZHkucHJvamVjdF9yZWYgIT09ICdzdHJpbmcnIHx8IGJvZHkucHJvamVjdF9yZWYubGVuZ3RoIDwgMSB8fCBib2R5LnByb2plY3RfcmVmLmxlbmd0aCA+IFBST0pFQ1RfUkVGX01BWClcbiAgICApIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3Byb2plY3RfcmVmJyB9LCA0MDApO1xuICAgIH1cblxuICAgIC8vIHByb3ZpZGVzX3Rvb2xzIChtaWdyYXRpb24gMDA2KSDigJQgcGFjay1tb2RlbCB0b29sIG1ldGFkYXRhLiBPbmx5IHRoZVxuICAgIC8vIGluc3RhbGxhYmxlIGtpbmRzIChwbHVnaW58cGFjaykgcmVnaXN0ZXIgdG9vbHM7IGEgYm91bmRlZCBhcnJheSBvZlxuICAgIC8vIG5vbi1lbXB0eSB0b29sLW5hbWUgc3RyaW5ncywgc3RvcmVkIGFzIEpTT04gVEVYVC5cbiAgICBsZXQgcHJvdmlkZXNUb29sc0pzb246IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChib2R5LnByb3ZpZGVzX3Rvb2xzICE9IG51bGwpIHtcbiAgICAgIGlmIChraW5kICE9PSAncGx1Z2luJyAmJiBraW5kICE9PSAncGFjaycpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncHJvdmlkZXNfdG9vbHMnLCByZWFzb246ICdwbHVnaW5fb3JfcGFja19raW5kX29ubHknIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICBjb25zdCBwdCA9IGJvZHkucHJvdmlkZXNfdG9vbHM7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkocHQpIHx8IHB0Lmxlbmd0aCA9PT0gMCB8fCBwdC5sZW5ndGggPiBQUk9WSURFU19UT09MU19NQVhfRU5UUklFUykge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdwcm92aWRlc190b29scycsIHJlYXNvbjogJ2FycmF5XzFfdG9fMjAwJyB9LCA0MDApO1xuICAgICAgfVxuICAgICAgaWYgKCFwdC5ldmVyeSgodCkgPT4gdHlwZW9mIHQgPT09ICdzdHJpbmcnICYmIHQudHJpbSgpLmxlbmd0aCA+IDAgJiYgdC5sZW5ndGggPD0gUFJPVklERVNfVE9PTFNfTUFYX05BTUVfTEVOKSkge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdwcm92aWRlc190b29scycsIHJlYXNvbjogJ25vbl9lbXB0eV9zdHJpbmdzX21heF8xMjgnIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICBwcm92aWRlc1Rvb2xzSnNvbiA9IEpTT04uc3RyaW5naWZ5KHB0KTtcbiAgICB9XG5cbiAgICAvLyBwcm92aWRlc19pdGVtX3R5cGVzIC8gcHJvdmlkZXNfcGxhbl90eXBlcyAvIHJlcXVpcmVzX3BsYW5fdHlwZSAobWlncmF0aW9uIDA0OSAvXG4gICAgLy8gcGxhbi1pdGVtLXR5cGVzLXJlZ2lzdHJ5LWN1cGJvYXJkLTIwMjYtMTAtMjAgUC0wMDYsIEQtMDA4KS4gRGVjbGFyYXRpb25zLCBub3QgcGF5bG9hZHM6XG4gICAgLy8gYm91bmRlZCwgZ3JhbW1hci1jaGVja2VkIGFuZCBzdG9yZWQgYXMgSlNPTiBURVhULiBUaGUgaW5zdGFsbGVyIHJlc29sdmVzIGEgcmVmZXJlbmNlZCB0eXBlXG4gICAgLy8gdG8gdGhlIGFwcHJvdmVkIGxpc3RpbmcgdGhhdCBkZWNsYXJlcyBpdCBhbmQgcmVmdXNlcyBhIG1hbmlmZXN0IGNhcnJ5aW5nIHVuZGVjbGFyZWQgdHlwZXMsXG4gICAgLy8gYW5kIGFueSBkZWNsYXJlZCB0eXBlIHNlbmRzIHRoZSBwdWJsaXNoIHRvIHJldmlldyAocHVibGlzaFJldmlld1N0YXR1cyBiZWxvdykuXG4gICAgbGV0IHByb3ZpZGVzSXRlbVR5cGVzSnNvbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IHByb3ZpZGVzUGxhblR5cGVzSnNvbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgY29uc3QgZGVjbGFyZWRUeXBlcyA9IHsgaXRlbVR5cGVzOiAwLCBwbGFuVHlwZXM6IDAgfTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFsncHJvdmlkZXNfaXRlbV90eXBlcycsICdwcm92aWRlc19wbGFuX3R5cGVzJ10gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IGRlY2xhcmVkID0gYm9keVtmaWVsZF07XG4gICAgICBpZiAoZGVjbGFyZWQgPT0gbnVsbCkgY29udGludWU7XG4gICAgICBjb25zdCBiYWQgPSAocmVhc29uOiBzdHJpbmcpID0+IGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkLCByZWFzb24gfSwgNDAwKTtcbiAgICAgIGlmIChraW5kICE9PSAncGx1Z2luJyAmJiBraW5kICE9PSAncGFjaycpIHJldHVybiBiYWQoJ3BsdWdpbl9vcl9wYWNrX2tpbmRfb25seScpO1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRlY2xhcmVkKSB8fCBkZWNsYXJlZC5sZW5ndGggPT09IDAgfHwgZGVjbGFyZWQubGVuZ3RoID4gVFlQRV9ERUNMQVJBVElPTlNfTUFYKSB7XG4gICAgICAgIHJldHVybiBiYWQoJ2FycmF5XzFfdG9fMTAwJyk7XG4gICAgICB9XG4gICAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICBjb25zdCBjbGVhbjogQXJyYXk8eyBpZDogc3RyaW5nOyByZXZpc2lvbjogbnVtYmVyIH0+ID0gW107XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGRlY2xhcmVkKSB7XG4gICAgICAgIGlmIChlbnRyeSA9PSBudWxsIHx8IHR5cGVvZiBlbnRyeSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShlbnRyeSkpIHJldHVybiBiYWQoJ2VudHJpZXNfbXVzdF9iZV9vYmplY3RzJyk7XG4gICAgICAgIGNvbnN0IHsgaWQsIHJldmlzaW9uLCAuLi5yZXN0IH0gPSBlbnRyeSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKHJlc3QpLmxlbmd0aCA+IDApIHJldHVybiBiYWQoJ2VudHJpZXNfYXJlX2lkX2FuZF9yZXZpc2lvbl9vbmx5Jyk7XG4gICAgICAgIGlmICh0eXBlb2YgaWQgIT09ICdzdHJpbmcnIHx8ICFUWVBFX0lEX1JFLnRlc3QoaWQpIHx8IGlkLnN0YXJ0c1dpdGgoJ3BhcGVyY3VzcC8nKSkgcmV0dXJuIGJhZCgnaWRfbmFtZXNwYWNlZF9zbHVnJyk7XG4gICAgICAgIGlmICh0eXBlb2YgcmV2aXNpb24gIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyZXZpc2lvbikgfHwgcmV2aXNpb24gPCAxKSB7XG4gICAgICAgICAgcmV0dXJuIGJhZCgncmV2aXNpb25fcG9zaXRpdmVfaW50ZWdlcicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzZWVuLmhhcyhpZCkpIHJldHVybiBiYWQoJ2R1cGxpY2F0ZV9pZCcpO1xuICAgICAgICBzZWVuLmFkZChpZCk7XG4gICAgICAgIGNsZWFuLnB1c2goeyBpZCwgcmV2aXNpb24gfSk7XG4gICAgICB9XG4gICAgICBpZiAoZmllbGQgPT09ICdwcm92aWRlc19pdGVtX3R5cGVzJykge1xuICAgICAgICBwcm92aWRlc0l0ZW1UeXBlc0pzb24gPSBKU09OLnN0cmluZ2lmeShjbGVhbik7XG4gICAgICAgIGRlY2xhcmVkVHlwZXMuaXRlbVR5cGVzID0gY2xlYW4ubGVuZ3RoO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvdmlkZXNQbGFuVHlwZXNKc29uID0gSlNPTi5zdHJpbmdpZnkoY2xlYW4pO1xuICAgICAgICBkZWNsYXJlZFR5cGVzLnBsYW5UeXBlcyA9IGNsZWFuLmxlbmd0aDtcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IHJlcXVpcmVzUGxhblR5cGVKc29uOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoYm9keS5yZXF1aXJlc19wbGFuX3R5cGUgIT0gbnVsbCkge1xuICAgICAgY29uc3QgYmFkID0gKHJlYXNvbjogc3RyaW5nKSA9PiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3JlcXVpcmVzX3BsYW5fdHlwZScsIHJlYXNvbiB9LCA0MDApO1xuICAgICAgaWYgKGtpbmQgIT09ICdwbGFuJykgcmV0dXJuIGJhZCgncGxhbl9raW5kX29ubHknKTtcbiAgICAgIGNvbnN0IHJlcXVpcmVkID0gYm9keS5yZXF1aXJlc19wbGFuX3R5cGU7XG4gICAgICBpZiAodHlwZW9mIHJlcXVpcmVkICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHJlcXVpcmVkKSkgcmV0dXJuIGJhZCgnbXVzdF9iZV9vYmplY3QnKTtcbiAgICAgIGNvbnN0IHsgaWQsIG1pblJldmlzaW9uLCBtYXhSZXZpc2lvbiwgLi4ucmVzdCB9ID0gcmVxdWlyZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBpZiAoT2JqZWN0LmtleXMocmVzdCkubGVuZ3RoID4gMCkgcmV0dXJuIGJhZCgnaWRfYW5kX3JldmlzaW9uX3JhbmdlX29ubHknKTtcbiAgICAgIGlmICh0eXBlb2YgaWQgIT09ICdzdHJpbmcnIHx8ICFUWVBFX0lEX1JFLnRlc3QoaWQpKSByZXR1cm4gYmFkKCdpZF9uYW1lc3BhY2VkX3NsdWcnKTtcbiAgICAgIGNvbnN0IGlzUmV2aXNpb24gPSAodjogdW5rbm93bikgPT4gdiA9PT0gdW5kZWZpbmVkIHx8ICh0eXBlb2YgdiA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIodikgJiYgdiA+PSAxKTtcbiAgICAgIGlmICghaXNSZXZpc2lvbihtaW5SZXZpc2lvbikgfHwgIWlzUmV2aXNpb24obWF4UmV2aXNpb24pKSByZXR1cm4gYmFkKCdyZXZpc2lvbl9wb3NpdGl2ZV9pbnRlZ2VyJyk7XG4gICAgICBpZiAobWluUmV2aXNpb24gPT09IHVuZGVmaW5lZCAmJiBtYXhSZXZpc2lvbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4gYmFkKCdyZXZpc2lvbl9vcl9yYW5nZV9yZXF1aXJlZCcpO1xuICAgICAgaWYgKG1pblJldmlzaW9uICE9PSB1bmRlZmluZWQgJiYgbWF4UmV2aXNpb24gIT09IHVuZGVmaW5lZCAmJiAobWluUmV2aXNpb24gYXMgbnVtYmVyKSA+IChtYXhSZXZpc2lvbiBhcyBudW1iZXIpKSB7XG4gICAgICAgIHJldHVybiBiYWQoJ21pbl9leGNlZWRzX21heCcpO1xuICAgICAgfVxuICAgICAgcmVxdWlyZXNQbGFuVHlwZUpzb24gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGlkLFxuICAgICAgICAuLi4obWluUmV2aXNpb24gIT09IHVuZGVmaW5lZCA/IHsgbWluUmV2aXNpb24gfSA6IHt9KSxcbiAgICAgICAgLi4uKG1heFJldmlzaW9uICE9PSB1bmRlZmluZWQgPyB7IG1heFJldmlzaW9uIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyB1c2VzX3Rvb2xzIChtaWdyYXRpb24gMDMzIC8gV0ktMTAwMDE3NDcpIOKAlCB0aGUgQ09OU1VNRVIgaGFsZiBvZiB0aGUgdG9vbFxuICAgIC8vIGF4aXMuIEEgcmVjaXBlL3BsYW4vZ29hbCBPUkNIRVNUUkFURVMgdG9vbHMgaXQgZG9lcyBub3QgcHJvdmlkZSwgc28gaXRcbiAgICAvLyBkZWNsYXJlcyB0aGVtIGhlcmUgcmF0aGVyIHRoYW4gaW4gcHJvdmlkZXNfdG9vbHMsIHdob3NlIHBsdWdpbnxwYWNrIGdhdGVcbiAgICAvLyBhYm92ZSBpcyBkZWxpYmVyYXRlbHkgbGVmdCBhbG9uZTogb3ZlcmxvYWRpbmcgb25lIGNvbHVtbiBieSBraW5kIHdvdWxkXG4gICAgLy8gbGV0IGEgZnV0dXJlIGluc3RhbGxlciB0cnkgdG8gUkVTT0xWRSB0b29scyB0aGUgdW5pdCBuZXZlciBwcm92aWRlZC5cbiAgICAvLyBTYW1lIGJvdW5kZWQgc2hhcGUgKEpTT04gVEVYVCwgMS4uMjAwIG5vbi1lbXB0eSBuYW1lcywgZWFjaCDiiaQxMjggY2hhcnMpLlxuICAgIGxldCB1c2VzVG9vbHNKc29uOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoYm9keS51c2VzX3Rvb2xzICE9IG51bGwpIHtcbiAgICAgIGlmICghVVNFU19UT09MU19LSU5EUy5pbmNsdWRlcyhraW5kIGFzICh0eXBlb2YgVVNFU19UT09MU19LSU5EUylbbnVtYmVyXSkpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAndXNlc190b29scycsIHJlYXNvbjogJ29yY2hlc3RyYXRpbmdfa2luZF9vbmx5JyB9LCA0MDApO1xuICAgICAgfVxuICAgICAgY29uc3QgdXQgPSBib2R5LnVzZXNfdG9vbHM7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkodXQpIHx8IHV0Lmxlbmd0aCA9PT0gMCB8fCB1dC5sZW5ndGggPiBQUk9WSURFU19UT09MU19NQVhfRU5UUklFUykge1xuICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICd1c2VzX3Rvb2xzJywgcmVhc29uOiAnYXJyYXlfMV90b18yMDAnIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICBpZiAoIXV0LmV2ZXJ5KCh0KSA9PiB0eXBlb2YgdCA9PT0gJ3N0cmluZycgJiYgdC50cmltKCkubGVuZ3RoID4gMCAmJiB0Lmxlbmd0aCA8PSBQUk9WSURFU19UT09MU19NQVhfTkFNRV9MRU4pKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3VzZXNfdG9vbHMnLCByZWFzb246ICdub25fZW1wdHlfc3RyaW5nc19tYXhfMTI4JyB9LCA0MDApO1xuICAgICAgfVxuICAgICAgdXNlc1Rvb2xzSnNvbiA9IEpTT04uc3RyaW5naWZ5KHV0KTtcbiAgICB9XG5cbiAgICAvLyBwcm92aWRlc19ldmVudHMgKG1pZ3JhdGlvbiAwMTIgLyBELTAwMykg4oCUIHRoZSBldmVudCBoYWxmIG9mIHRoZSBwYWNrXG4gICAgLy8gbW9kZWwncyBkZXBlbmRlbmN5IGF4aXMuIFNhbWUgcG9zdHVyZSBhcyBwcm92aWRlc190b29sczogaW5zdGFsbGFibGVcbiAgICAvLyBraW5kcyBvbmx5LCBib3VuZGVkLCBzdG9yZWQgYXMgSlNPTiBURVhULlxuICAgIC8vXG4gICAgLy8gVmFsaWRhdGVkIFNUUlVDVFVSQUxMWSwgbm90IGp1c3QgYXMgc3RyaW5ncywgYmVjYXVzZSBhIG1hbGZvcm1lZCBmYW1pbHlcbiAgICAvLyBoZXJlIGlzIG5vdCBpbmVydDogdGhlIG9wZXJhdG9yIHJlc29sdmVzIGFuIGF3YWl0ZXIncyBrZXkgdGVtcGxhdGUgQllcbiAgICAvLyBGQU1JTFkgSUQsIHNvIGEgZGVjbGFyYXRpb24gbWlzc2luZyBpdHMga2V5VGVtcGxhdGUgKG9yIGNhcnJ5aW5nIGFcbiAgICAvLyBkdXBsaWNhdGUgZmFtaWx5KSB3b3VsZCByZXNvbHZlIHRvIGEga2V5IG5vdGhpbmcgZW1pdHMgYW5kIHBhcmsgdGhlXG4gICAgLy8gYXdhaXRpbmcgYWdlbnQgZm9yZXZlci4gUmVqZWN0aW5nIGl0IGF0IHB1Ymxpc2ggaXMgdGhlIGNoZWFwIHBsYWNlIHRvXG4gICAgLy8gY2F0Y2ggdGhhdCDigJQgdGhlIGFsdGVybmF0aXZlIGlzIGFuIGFnZW50IGhhbmdpbmcgaW4gc2lsZW5jZSwgZGF5cyBsYXRlcixcbiAgICAvLyBvbiBzb21lb25lIGVsc2UncyBob3N0LlxuICAgIGxldCBwcm92aWRlc0V2ZW50c0pzb246IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChib2R5LnByb3ZpZGVzX2V2ZW50cyAhPSBudWxsKSB7XG4gICAgICBjb25zdCBiYWQgPSAocmVhc29uOiBzdHJpbmcpID0+XG4gICAgICAgIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncHJvdmlkZXNfZXZlbnRzJywgcmVhc29uIH0sIDQwMCk7XG4gICAgICBpZiAoa2luZCAhPT0gJ3BsdWdpbicgJiYga2luZCAhPT0gJ3BhY2snKSByZXR1cm4gYmFkKCdwbHVnaW5fb3JfcGFja19raW5kX29ubHknKTtcbiAgICAgIGNvbnN0IHBlID0gYm9keS5wcm92aWRlc19ldmVudHM7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkocGUpIHx8IHBlLmxlbmd0aCA9PT0gMCB8fCBwZS5sZW5ndGggPiBQUk9WSURFU19FVkVOVFNfTUFYX0VOVFJJRVMpIHtcbiAgICAgICAgcmV0dXJuIGJhZCgnYXJyYXlfMV90b18yMDAnKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZhbWlsaWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICBjb25zdCBjbGVhbjogQXJyYXk8eyBmYW1pbHk6IHN0cmluZzsga2V5VGVtcGxhdGU6IHN0cmluZzsgZGVzY3JpYmU/OiBzdHJpbmcgfT4gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgcmF3IG9mIHBlKSB7XG4gICAgICAgIGlmIChyYXcgPT0gbnVsbCB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiBiYWQoJ2VudHJpZXNfbXVzdF9iZV9vYmplY3RzJyk7XG4gICAgICAgIGNvbnN0IHsgZmFtaWx5LCBrZXlUZW1wbGF0ZSwgZGVzY3JpYmUgfSA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgaWYgKHR5cGVvZiBmYW1pbHkgIT09ICdzdHJpbmcnIHx8IGZhbWlseS50cmltKCkubGVuZ3RoID09PSAwIHx8IGZhbWlseS5sZW5ndGggPiBQUk9WSURFU19FVkVOVFNfTUFYX0ZBTUlMWV9MRU4pIHtcbiAgICAgICAgICByZXR1cm4gYmFkKCdmYW1pbHlfbm9uX2VtcHR5X3N0cmluZ19tYXhfMTI4Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBrZXlUZW1wbGF0ZSAhPT0gJ3N0cmluZycgfHxcbiAgICAgICAgICBrZXlUZW1wbGF0ZS50cmltKCkubGVuZ3RoID09PSAwIHx8XG4gICAgICAgICAga2V5VGVtcGxhdGUubGVuZ3RoID4gUFJPVklERVNfRVZFTlRTX01BWF9URU1QTEFURV9MRU5cbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIGJhZCgna2V5X3RlbXBsYXRlX25vbl9lbXB0eV9zdHJpbmdfbWF4XzI1NicpO1xuICAgICAgICB9XG4gICAgICAgIC8vIEEgZHVwbGljYXRlIGZhbWlseSBpZCBtYWtlcyBcIndobyBwcm92aWRlcyBYP1wiIGFtYmlndW91cyB3aXRoaW4gYSBzaW5nbGVcbiAgICAgICAgLy8gdW5pdCDigJQgcmVqZWN0IHJhdGhlciB0aGFuIHNpbGVudGx5IHBpY2tpbmcgb25lLlxuICAgICAgICBpZiAoZmFtaWxpZXMuaGFzKGZhbWlseSkpIHJldHVybiBiYWQoJ2R1cGxpY2F0ZV9mYW1pbHknKTtcbiAgICAgICAgZmFtaWxpZXMuYWRkKGZhbWlseSk7XG4gICAgICAgIGlmIChkZXNjcmliZSAhPSBudWxsICYmICh0eXBlb2YgZGVzY3JpYmUgIT09ICdzdHJpbmcnIHx8IGRlc2NyaWJlLmxlbmd0aCA+IFBST1ZJREVTX0VWRU5UU19NQVhfREVTQ1JJQkVfTEVOKSkge1xuICAgICAgICAgIHJldHVybiBiYWQoJ2Rlc2NyaWJlX3N0cmluZ19tYXhfMzAwJyk7XG4gICAgICAgIH1cbiAgICAgICAgY2xlYW4ucHVzaCh7IGZhbWlseSwga2V5VGVtcGxhdGUsIC4uLih0eXBlb2YgZGVzY3JpYmUgPT09ICdzdHJpbmcnID8geyBkZXNjcmliZSB9IDoge30pIH0pO1xuICAgICAgfVxuICAgICAgcHJvdmlkZXNFdmVudHNKc29uID0gSlNPTi5zdHJpbmdpZnkoY2xlYW4pO1xuICAgIH1cblxuICAgIC8vIHJlcXVpcmVzX2V2ZW50cyAobWlncmF0aW9uIDAxMyAvIEQtMDAzIC8gUC0wMDgpIOKAlCB0aGUgQ09OU1VNRVIgaGFsZi4gU2FtZVxuICAgIC8vIHBvc3R1cmUgYWdhaW46IGluc3RhbGxhYmxlIGtpbmRzIG9ubHksIGJvdW5kZWQsIEpTT04gVEVYVCwgc3RydWN0dXJhbC5cbiAgICAvL1xuICAgIC8vIE5vdGUgd2hhdCBpcyBOT1QgdmFsaWRhdGVkIGhlcmU6IHdoZXRoZXIgYW55dGhpbmcgYWN0dWFsbHkgUFJPVklERVMgdGhlXG4gICAgLy8gcmVxdWlyZWQgZmFtaWx5LiBUaGF0IGlzIGRlbGliZXJhdGVseSBub3QgdGhlIEN1cGJvYXJkJ3MgcXVlc3Rpb24g4oCUIGl0IGhhc1xuICAgIC8vIG5vIGhvc3QgY2F0YWxvZyBhbmQgbm8gaWRlYSB3aGF0IHRoZSBpbnN0YWxsaW5nIGJveCBhbHJlYWR5IGhhcy4gVGhlXG4gICAgLy8gc3RvcmVmcm9udCBzdG9yZXMgdGhlIERFQ0xBUkFUSU9OOyB0aGUgb3BlcmF0b3IncyByZXNvbHZlciBhbnN3ZXJzXG4gICAgLy8gYXZhaWxhYmlsaXR5IGFnYWluc3QgdGhlIGxvY2FsIGNhdGFsb2cgYXQgaW5zdGFsbCB0aW1lLiBUcnlpbmcgdG8gZW5mb3JjZVxuICAgIC8vIHJlc29sdmFiaWxpdHkgYXQgcHVibGlzaCB3b3VsZCByZWplY3QgYSBwZXJmZWN0bHkgZ29vZCB1bml0IHdob3NlIHByb3ZpZGVyXG4gICAgLy8gc2ltcGx5IGhhc24ndCBiZWVuIHB1Ymxpc2hlZCB5ZXQsIGFuZCB3b3VsZCBzdGlsbCBiZSB3cm9uZyBieSB0aGUgdGltZVxuICAgIC8vIGFueW9uZSBpbnN0YWxsZWQgaXQuXG4gICAgbGV0IHJlcXVpcmVzRXZlbnRzSnNvbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGJvZHkucmVxdWlyZXNfZXZlbnRzICE9IG51bGwpIHtcbiAgICAgIGNvbnN0IGJhZCA9IChyZWFzb246IHN0cmluZykgPT5cbiAgICAgICAgYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdyZXF1aXJlc19ldmVudHMnLCByZWFzb24gfSwgNDAwKTtcbiAgICAgIGlmIChraW5kICE9PSAncGx1Z2luJyAmJiBraW5kICE9PSAncGFjaycpIHJldHVybiBiYWQoJ3BsdWdpbl9vcl9wYWNrX2tpbmRfb25seScpO1xuICAgICAgY29uc3QgcmUgPSBib2R5LnJlcXVpcmVzX2V2ZW50cztcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShyZSkgfHwgcmUubGVuZ3RoID09PSAwIHx8IHJlLmxlbmd0aCA+IFJFUVVJUkVTX0VWRU5UU19NQVhfRU5UUklFUykge1xuICAgICAgICByZXR1cm4gYmFkKCdhcnJheV8xX3RvXzIwMCcpO1xuICAgICAgfVxuICAgICAgY29uc3QgZmFtaWxpZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgIGNvbnN0IGNsZWFuOiBBcnJheTx7IGZhbWlseTogc3RyaW5nOyBvcHRpb25hbD86IGJvb2xlYW4gfT4gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgcmF3IG9mIHJlKSB7XG4gICAgICAgIGlmIChyYXcgPT0gbnVsbCB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHJhdykpIHJldHVybiBiYWQoJ2VudHJpZXNfbXVzdF9iZV9vYmplY3RzJyk7XG4gICAgICAgIGNvbnN0IHsgZmFtaWx5LCBvcHRpb25hbCB9ID0gcmF3IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIGZhbWlseSAhPT0gJ3N0cmluZycgfHxcbiAgICAgICAgICBmYW1pbHkudHJpbSgpLmxlbmd0aCA9PT0gMCB8fFxuICAgICAgICAgIGZhbWlseS5sZW5ndGggPiBSRVFVSVJFU19FVkVOVFNfTUFYX0ZBTUlMWV9MRU5cbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIGJhZCgnZmFtaWx5X25vbl9lbXB0eV9zdHJpbmdfbWF4XzEyOCcpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChvcHRpb25hbCAhPSBudWxsICYmIHR5cGVvZiBvcHRpb25hbCAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4gYmFkKCdvcHRpb25hbF9tdXN0X2JlX2Jvb2xlYW4nKTtcbiAgICAgICAgLy8gQSBkdXBsaWNhdGUgZmFtaWx5IHdpdGggQ09ORkxJQ1RJTkcgb3B0aW9uYWxpdHkgaXMgYW1iaWd1b3VzIGluIHRoZSBvbmVcbiAgICAgICAgLy8gd2F5IHRoYXQgbWF0dGVycyDigJQgaXMgdGhpcyBkZXAgaGFyZCBvciBzb2Z0PyDigJQgc28gcmVqZWN0IHJhdGhlciB0aGFuXG4gICAgICAgIC8vIHBpY2suIChUaGUgb3BlcmF0b3IncyBwYXJzZXIgcmVzb2x2ZXMgZHVwZXMgUkVRVUlSRUQtV0lOUyB3aGVuIHJlYWRpbmdcbiAgICAgICAgLy8gYW4gYWxyZWFkeS1zdG9yZWQgZGVjbGFyYXRpb247IHRoYXQncyBhIHNhZmUgcmVhZCBvZiBsZWdhY3kgZGF0YSwgbm90IGFcbiAgICAgICAgLy8gbGljZW5jZSB0byBwdWJsaXNoIGEgc2VsZi1jb250cmFkaWN0aW5nIG9uZS4pXG4gICAgICAgIGlmIChmYW1pbGllcy5oYXMoZmFtaWx5KSkgcmV0dXJuIGJhZCgnZHVwbGljYXRlX2ZhbWlseScpO1xuICAgICAgICBmYW1pbGllcy5hZGQoZmFtaWx5KTtcbiAgICAgICAgY2xlYW4ucHVzaCh7IGZhbWlseSwgLi4uKG9wdGlvbmFsID09PSB0cnVlID8geyBvcHRpb25hbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgfVxuICAgICAgcmVxdWlyZXNFdmVudHNKc29uID0gSlNPTi5zdHJpbmdpZnkoY2xlYW4pO1xuICAgIH1cblxuICAgIC8vIHJlcXVpcmVzX3J1YnJpY3MgKG1pZ3JhdGlvbiAwMTUgLyBjdXBib2FyZC1wbGFuLXJ1YnJpYy1yZWNpcGUtc2hhcmluZyBELTAwMSlcbiAgICAvLyDigJQgdGhlIHJ1YnJpYyBheGlzJ3MgY29uc3VtZXIgaGFsZiwgc3RydWN0dXJhbGx5IHRoZSBzYW1lIGRlY2xhcmF0aW9uIGFzXG4gICAgLy8gcmVxdWlyZXNfZXZlbnRzIGFib3ZlIGFuZCB2YWxpZGF0ZWQgdGhlIHNhbWUgd2F5LlxuICAgIC8vXG4gICAgLy8gVHdvIGRlbGliZXJhdGUgZGlmZmVyZW5jZXMgZnJvbSByZXF1aXJlc19ldmVudHM6XG4gICAgLy8gICAxLiBLSU5EIFNDT1BFIGlzICdwbGFuJyArICdnb2FsJyAod2lkZW5lZCBieSBtaWdyYXRpb24gMDE2IC9cbiAgICAvLyAgICAgIHdvcmstb24tZXZlcnl0aGluZy1nb2FsLTIwMjYtMDgtMjMgUC0wMDYg4oCUIGJvdGgga2luZHMnIGluc3RhbGxlcnMgcnVuXG4gICAgLy8gICAgICB0aGUgU0FNRSBvcGVyYXRvci1zaWRlIHJ1YnJpYy1yZXF1aXJlbWVudHMgcmVzb2x2ZXIpLiBUaGUgQ09MVU1OIGlzXG4gICAgLy8gICAgICBraW5kLWFnbm9zdGljIG9uIHB1cnBvc2UgKHNvIGEgZnV0dXJlIGtpbmQgbmVlZHMgbm8gdGFibGUgcmVidWlsZCksXG4gICAgLy8gICAgICBidXQgYWNjZXB0aW5nIHRoZSBmaWVsZCBmcm9tIGEga2luZCB3aXRoIG5vIGluc3RhbGwtdGltZSByZXNvbHZlclxuICAgIC8vICAgICAgd291bGQgc3RvcmUgYSBkZWNsYXJhdGlvbiBub3RoaW5nIGV2ZXIgcmVhZHMg4oCUIGEgc2lsZW50IG5vLW9wIGlzXG4gICAgLy8gICAgICB3b3JzZSB0aGFuIGEgNDAwLiBXaWRlbmluZyB0aGlzIGNoZWNrIGlzIHRoZSBvbmx5IGNoYW5nZSBuZWVkZWQgdG9cbiAgICAvLyAgICAgIGFkbWl0IGFub3RoZXIga2luZC5cbiAgICAvLyAgIDIuIFRoZXJlIGlzIG5vIHByb3ZpZGVzX3J1YnJpY3MgY291bnRlcnBhcnQgdG8gY3Jvc3MtY2hlY2sgKEQtMDAyKTogYVxuICAgIC8vICAgICAga2luZD0ncnVicmljJyByb3cgcHJvdmlkZXMgZXhhY3RseSB0aGUgcnVicmljIG5hbWVkIGJ5IGl0cyBsaXN0aW5nX3JlZi5cbiAgICAvL1xuICAgIC8vIEFzIHdpdGggcmVxdWlyZXNfZXZlbnRzLCByZXNvbHZhYmlsaXR5IGlzIE5PVCB2YWxpZGF0ZWQgaGVyZTogdGhlIEN1cGJvYXJkXG4gICAgLy8gaGFzIG5vIGlkZWEgd2hpY2ggcnVicmljcyB0aGUgaW5zdGFsbGluZyB3b3Jrc3BhY2UgYWxyZWFkeSBob2xkcyAoaXRzIGJ1bmRsZWRcbiAgICAvLyBmaXJzdC1wYXJ0eSBzZXQgYWxvbmUgbWF5IHNhdGlzZnkgdGhlIHdob2xlIGRlY2xhcmF0aW9uKS4gVGhlIHN0b3JlZnJvbnRcbiAgICAvLyBzdG9yZXMgdGhlIERFQ0xBUkFUSU9OOyB0aGUgb3BlcmF0b3IgcmVzb2x2ZXMgaXQgYXQgaW5zdGFsbCB0aW1lLlxuICAgIGxldCByZXF1aXJlc1J1YnJpY3NKc29uOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoYm9keS5yZXF1aXJlc19ydWJyaWNzICE9IG51bGwpIHtcbiAgICAgIGNvbnN0IGJhZCA9IChyZWFzb246IHN0cmluZykgPT5cbiAgICAgICAgYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdyZXF1aXJlc19ydWJyaWNzJywgcmVhc29uIH0sIDQwMCk7XG4gICAgICBpZiAoa2luZCAhPT0gJ3BsYW4nICYmIGtpbmQgIT09ICdnb2FsJykgcmV0dXJuIGJhZCgncGxhbl9vcl9nb2FsX2tpbmRfb25seScpO1xuICAgICAgY29uc3QgcnIgPSBib2R5LnJlcXVpcmVzX3J1YnJpY3M7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkocnIpIHx8IHJyLmxlbmd0aCA9PT0gMCB8fCByci5sZW5ndGggPiBSRVFVSVJFU19SVUJSSUNTX01BWF9FTlRSSUVTKSB7XG4gICAgICAgIHJldHVybiBiYWQoJ2FycmF5XzFfdG9fMjAwJyk7XG4gICAgICB9XG4gICAgICBjb25zdCByZWZzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICBjb25zdCBjbGVhbjogQXJyYXk8eyBydWJyaWNSZWY6IHN0cmluZzsgb3B0aW9uYWw/OiBib29sZWFuIH0+ID0gW107XG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiBycikge1xuICAgICAgICBpZiAocmF3ID09IG51bGwgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShyYXcpKSByZXR1cm4gYmFkKCdlbnRyaWVzX211c3RfYmVfb2JqZWN0cycpO1xuICAgICAgICBjb25zdCB7IHJ1YnJpY1JlZiwgb3B0aW9uYWwgfSA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBydWJyaWNSZWYgIT09ICdzdHJpbmcnIHx8XG4gICAgICAgICAgcnVicmljUmVmLnRyaW0oKS5sZW5ndGggPT09IDAgfHxcbiAgICAgICAgICBydWJyaWNSZWYubGVuZ3RoID4gUkVRVUlSRVNfUlVCUklDU19NQVhfUkVGX0xFTlxuICAgICAgICApIHtcbiAgICAgICAgICByZXR1cm4gYmFkKCdydWJyaWNSZWZfbm9uX2VtcHR5X3N0cmluZ19tYXhfMjAwJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdGlvbmFsICE9IG51bGwgJiYgdHlwZW9mIG9wdGlvbmFsICE9PSAnYm9vbGVhbicpIHJldHVybiBiYWQoJ29wdGlvbmFsX211c3RfYmVfYm9vbGVhbicpO1xuICAgICAgICAvLyBTYW1lIHJlYXNvbmluZyBhcyBkdXBsaWNhdGVfZmFtaWx5IGFib3ZlOiBhIGR1cGxpY2F0ZSByZWYgd2l0aFxuICAgICAgICAvLyBDT05GTElDVElORyBvcHRpb25hbGl0eSBpcyBhbWJpZ3VvdXMgaW4gdGhlIG9uZSB3YXkgdGhhdCBtYXR0ZXJzLlxuICAgICAgICBpZiAocmVmcy5oYXMocnVicmljUmVmKSkgcmV0dXJuIGJhZCgnZHVwbGljYXRlX3J1YnJpY19yZWYnKTtcbiAgICAgICAgcmVmcy5hZGQocnVicmljUmVmKTtcbiAgICAgICAgY2xlYW4ucHVzaCh7IHJ1YnJpY1JlZiwgLi4uKG9wdGlvbmFsID09PSB0cnVlID8geyBvcHRpb25hbDogdHJ1ZSB9IDoge30pIH0pO1xuICAgICAgfVxuICAgICAgcmVxdWlyZXNSdWJyaWNzSnNvbiA9IEpTT04uc3RyaW5naWZ5KGNsZWFuKTtcbiAgICB9XG5cbiAgICAvLyBBcHAgZGlzdHJpYnV0aW9uIGZpZWxkcyAobWlncmF0aW9uIDAxNCAvIGN1cGJvYXJkLWFwcC1kaXN0cmlidXRpb24gUC0wMDMpLlxuICAgIC8vIEFMTCBhcHAtb25seTogYSBub24tYXBwIGxpc3RpbmcgY2FycnlpbmcgYW55IG9mIHRoZW0gaXMgYSBjbGllbnQgYnVnLCBzb1xuICAgIC8vIHJlamVjdCByYXRoZXIgdGhhbiBzaWxlbnRseSBkcm9wIChzYW1lIHBvc3R1cmUgYXMgcHJvdmlkZXNfdG9vbHMnc1xuICAgIC8vIHBsdWdpbl9vcl9wYWNrX2tpbmRfb25seSkuIEZvciBhIFNUQU5EQUxPTkUgYXBwLCBsYXRlc3RfanNvbl91cmwgaXNcbiAgICAvLyBSRVFVSVJFRCDigJQgaXQgaXMgdGhlIGRvd25sb2FkIGhhbmRvZmYgdGFyZ2V0OyBhIHN0YW5kYWxvbmUgYXBwIHJvdyB3aXRob3V0XG4gICAgLy8gaXQgaXMgYm9ybiB1bi1kb3dubG9hZGFibGUuIFRoZSBDdXBib2FyZCBzaGFwZS12YWxpZGF0ZXMgdGhlIHVybCBidXQgbmV2ZXJcbiAgICAvLyBGRVRDSEVTIGl0ICh0aGF0IGlzIHRoZSBwdWJsaXNoIHRvb2wncyBhc3NlcnRBcHBNYW5pZmVzdFJlc29sdmVzIGdhdGUsXG4gICAgLy8gY2xpZW50LXNpZGUpOyB0aGUgc3RvcmVmcm9udCBzdG9yZXMgdGhlIHB1Ymxpc2hlcidzIGNsYWltIGxpa2UgdG9waWNfaGV4LlxuICAgIGNvbnN0IGFueUFwcEZpZWxkID1cbiAgICAgIGJvZHkuZGVsaXZlcnlfdHlwZSAhPSBudWxsIHx8XG4gICAgICBib2R5LmxhdGVzdF9qc29uX3VybCAhPSBudWxsIHx8XG4gICAgICBib2R5LnJlbGVhc2VfcmVwbyAhPSBudWxsIHx8XG4gICAgICBib2R5Lmljb25fdXJsICE9IG51bGwgfHxcbiAgICAgIGJvZHkucGxhdGZvcm1zICE9IG51bGw7XG4gICAgbGV0IGRlbGl2ZXJ5VHlwZTogJ3N0YW5kYWxvbmUnIHwgJ2J1bmRsZScgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgbGF0ZXN0SnNvblVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IHJlbGVhc2VSZXBvOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgaWNvblVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IHBsYXRmb3Jtc0pzb246IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChhbnlBcHBGaWVsZCAmJiBraW5kICE9PSAnYXBwJykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnYXBwX2ZpZWxkcycsIHJlYXNvbjogJ2FwcF9raW5kX29ubHknIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmIChraW5kID09PSAnYXBwJykge1xuICAgICAgY29uc3QgYmFkQXBwID0gKGZpZWxkOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nKSA9PlxuICAgICAgICBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZCwgcmVhc29uIH0sIDQwMCk7XG4gICAgICBpZiAoYm9keS5kZWxpdmVyeV90eXBlICE9IG51bGwpIHtcbiAgICAgICAgaWYgKGJvZHkuZGVsaXZlcnlfdHlwZSAhPT0gJ3N0YW5kYWxvbmUnICYmIGJvZHkuZGVsaXZlcnlfdHlwZSAhPT0gJ2J1bmRsZScpIHtcbiAgICAgICAgICByZXR1cm4gYmFkQXBwKCdkZWxpdmVyeV90eXBlJywgJ3N0YW5kYWxvbmVfb3JfYnVuZGxlJyk7XG4gICAgICAgIH1cbiAgICAgICAgZGVsaXZlcnlUeXBlID0gYm9keS5kZWxpdmVyeV90eXBlO1xuICAgICAgfVxuICAgICAgLy8gTlVMTCBkZWxpdmVyeV90eXBlIOKHkiBzdGFuZGFsb25lICh0aGUgc2FmZSBkb3dubG9hZC1oYW5kb2ZmIGRlZmF1bHQpLlxuICAgICAgY29uc3QgZWZmZWN0aXZlRGVsaXZlcnkgPSBkZWxpdmVyeVR5cGUgPz8gJ3N0YW5kYWxvbmUnO1xuICAgICAgaWYgKGJvZHkubGF0ZXN0X2pzb25fdXJsICE9IG51bGwpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBib2R5LmxhdGVzdF9qc29uX3VybCAhPT0gJ3N0cmluZycgfHxcbiAgICAgICAgICBib2R5LmxhdGVzdF9qc29uX3VybC5sZW5ndGggPiBBUFBfVVJMX01BWCB8fFxuICAgICAgICAgICFIVFRQU19VUkxfUkUudGVzdChib2R5LmxhdGVzdF9qc29uX3VybClcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIGJhZEFwcCgnbGF0ZXN0X2pzb25fdXJsJywgJ2h0dHBzX3VybF9tYXhfNTAwJyk7XG4gICAgICAgIH1cbiAgICAgICAgbGF0ZXN0SnNvblVybCA9IGJvZHkubGF0ZXN0X2pzb25fdXJsO1xuICAgICAgfVxuICAgICAgaWYgKGVmZmVjdGl2ZURlbGl2ZXJ5ID09PSAnc3RhbmRhbG9uZScgJiYgbGF0ZXN0SnNvblVybCA9PSBudWxsKSB7XG4gICAgICAgIC8vIEEgc3RhbmRhbG9uZSBhcHAgSVMgaXRzIGxhdGVzdC5qc29uIGhhbmRvZmYg4oCUIHJlZnVzZSBhIGRlYWQgbGlzdGluZy5cbiAgICAgICAgcmV0dXJuIGJhZEFwcCgnbGF0ZXN0X2pzb25fdXJsJywgJ3JlcXVpcmVkX2Zvcl9zdGFuZGFsb25lX2FwcCcpO1xuICAgICAgfVxuICAgICAgaWYgKGJvZHkucmVsZWFzZV9yZXBvICE9IG51bGwpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBib2R5LnJlbGVhc2VfcmVwbyAhPT0gJ3N0cmluZycgfHwgIVJFTEVBU0VfUkVQT19SRS50ZXN0KGJvZHkucmVsZWFzZV9yZXBvKSkge1xuICAgICAgICAgIHJldHVybiBiYWRBcHAoJ3JlbGVhc2VfcmVwbycsICdvd25lcl9zbGFzaF9yZXBvJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmVsZWFzZVJlcG8gPSBib2R5LnJlbGVhc2VfcmVwbztcbiAgICAgIH1cbiAgICAgIGlmIChib2R5Lmljb25fdXJsICE9IG51bGwpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBib2R5Lmljb25fdXJsICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICAgIGJvZHkuaWNvbl91cmwubGVuZ3RoID4gQVBQX1VSTF9NQVggfHxcbiAgICAgICAgICAhSFRUUFNfVVJMX1JFLnRlc3QoYm9keS5pY29uX3VybClcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIGJhZEFwcCgnaWNvbl91cmwnLCAnaHR0cHNfdXJsX21heF81MDAnKTtcbiAgICAgICAgfVxuICAgICAgICBpY29uVXJsID0gYm9keS5pY29uX3VybDtcbiAgICAgIH1cbiAgICAgIGlmIChib2R5LnBsYXRmb3JtcyAhPSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHAgPSBib2R5LnBsYXRmb3JtcztcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHApIHx8IHAubGVuZ3RoID09PSAwIHx8IHAubGVuZ3RoID4gQVBQX1BMQVRGT1JNU19NQVhfRU5UUklFUykge1xuICAgICAgICAgIHJldHVybiBiYWRBcHAoJ3BsYXRmb3JtcycsICdhcnJheV8xX3RvXzIwJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICFwLmV2ZXJ5KFxuICAgICAgICAgICAgKGspID0+IHR5cGVvZiBrID09PSAnc3RyaW5nJyAmJiBrLnRyaW0oKS5sZW5ndGggPiAwICYmIGsubGVuZ3RoIDw9IEFQUF9QTEFURk9STV9LRVlfTUFYX0xFTixcbiAgICAgICAgICApXG4gICAgICAgICkge1xuICAgICAgICAgIHJldHVybiBiYWRBcHAoJ3BsYXRmb3JtcycsICdub25fZW1wdHlfc3RyaW5nc19tYXhfNjQnKTtcbiAgICAgICAgfVxuICAgICAgICBwbGF0Zm9ybXNKc29uID0gSlNPTi5zdHJpbmdpZnkocCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmVwb+KGkkhpdmUgYmluZGluZyBmaWVsZHMgKG1pZ3JhdGlvbiAwMDcgLyBoaXZlLWZyb20tZ2l0aHViLXVybCBELTAwNFxuICAgIC8vIEhZQlJJRCkuIFNoYXBlLXZhbGlkYXRlZCBvbmx5IOKAlCB0aGUgc2lnbmVkIGRpcmVjdG9yeSBhbm5vdW5jZSBpcyB0aGVcbiAgICAvLyBjb250ZW50IGF1dGhvcml0eTsgdGhlIEN1cGJvYXJkIHN0b3JlcyB0aGUgcHVibGlzaGVyJ3MgY2xhaW0gbGlrZSBhbnlcbiAgICAvLyBvdGhlciBwdWJsaXNoLWJvZHkgZmllbGQgKHNhbWUgdHJ1c3QgcG9zdHVyZSBhcyB0b3BpY19oZXgvcHJvamVjdF9yZWYpLlxuICAgIC8vIGhpdmVfdGl0bGUgaXMgZGlzcGxheSBzdWdhciBmb3IgdGhlIHB1YmtleSDigJQgbWVhbmluZ2xlc3Mgd2l0aG91dCBpdC5cbiAgICBpZiAoXG4gICAgICBib2R5LmhpdmVfcHVia2V5ICE9IG51bGwgJiZcbiAgICAgICh0eXBlb2YgYm9keS5oaXZlX3B1YmtleSAhPT0gJ3N0cmluZycgfHwgIUhJVkVfUFVCS0VZX1JFLnRlc3QoYm9keS5oaXZlX3B1YmtleSkpXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdoaXZlX3B1YmtleScgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKGJvZHkuaGl2ZV90aXRsZSAhPSBudWxsKSB7XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBib2R5LmhpdmVfdGl0bGUgIT09ICdzdHJpbmcnIHx8XG4gICAgICAgIGJvZHkuaGl2ZV90aXRsZS5sZW5ndGggPCAxIHx8XG4gICAgICAgIGJvZHkuaGl2ZV90aXRsZS5sZW5ndGggPiBISVZFX1RJVExFX01BWFxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2hpdmVfdGl0bGUnIH0sIDQwMCk7XG4gICAgICB9XG4gICAgICBpZiAoYm9keS5oaXZlX3B1YmtleSA9PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2hpdmVfdGl0bGUnLCByZWFzb246ICdyZXF1aXJlc19oaXZlX3B1YmtleScgfSwgNDAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGFubmVsLTIgYXR0ZXN0YXRpb24gKGl0ZW0gMSkg4oCUIG9wdGlvbmFsLCBidXQgYm90aC1vci1uZWl0aGVyLlxuICAgIGNvbnN0IGhhc0dpc3QgPSBib2R5LmF0dGVzdGF0aW9uX2dpc3RfaWQgIT0gbnVsbDtcbiAgICBjb25zdCBoYXNQdWJrZXkgPSBib2R5LnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5ICE9IG51bGw7XG4gICAgaWYgKGhhc0dpc3QgIT09IGhhc1B1YmtleSkge1xuICAgICAgcmV0dXJuIGMuanNvbihcbiAgICAgICAgeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2F0dGVzdGF0aW9uX2dpc3RfaWR8cHVibGlzaGVyX2RldmljZV9wdWJrZXknLCByZWFzb246ICdib3RoX29yX25laXRoZXInIH0sXG4gICAgICAgIDQwMCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGhhc0dpc3QgJiZcbiAgICAgICh0eXBlb2YgYm9keS5hdHRlc3RhdGlvbl9naXN0X2lkICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICBib2R5LmF0dGVzdGF0aW9uX2dpc3RfaWQubGVuZ3RoID4gMTAwIHx8XG4gICAgICAgICEvXltBLVphLXowLTldKyQvLnRlc3QoYm9keS5hdHRlc3RhdGlvbl9naXN0X2lkKSlcbiAgICApIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2F0dGVzdGF0aW9uX2dpc3RfaWQnIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGhhc1B1YmtleSAmJlxuICAgICAgKHR5cGVvZiBib2R5LnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5ICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICBib2R5LnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5Lmxlbmd0aCA8IDEgfHxcbiAgICAgICAgYm9keS5wdWJsaXNoZXJfZGV2aWNlX3B1YmtleS5sZW5ndGggPiAyMDApXG4gICAgKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdwdWJsaXNoZXJfZGV2aWNlX3B1YmtleScgfSwgNDAwKTtcbiAgICB9XG5cbiAgICAvLyBSZWplY3QgaWYgdGhlIEdpdEh1YiByZXBvIGlzIHByaXZhdGUuIENoZWNrIHZpYSBhdXRoZWQgR2l0SHViIEFQSVxuICAgIC8vIOKAlCB3ZSBhbHJlYWR5IGhhdmUgdGhlIHB1Ymxpc2hlcidzIHRva2VuLCBhbmQgdGhleSBtdXN0IGhhdmUgYXRcbiAgICAvLyBsZWFzdCByZWFkIHBlcm0gb24gYSByZXBvIHRoZXkncmUgcHVibGlzaGluZy5cbiAgICBjb25zdCBnaENoZWNrID0gYXdhaXQgZmV0Y2goXG4gICAgICBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke2VuY29kZVVSSUNvbXBvbmVudChib2R5LmdpdGh1Yl9vd25lcil9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KGJvZHkuZ2l0aHViX25hbWUpfWAsXG4gICAgICB7XG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7ZXh0cmFjdEJlYXJlcihjLnJlcS5yYXcpfWAsXG4gICAgICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vdm5kLmdpdGh1Yitqc29uJyxcbiAgICAgICAgICAnVXNlci1BZ2VudCc6ICdwYXBlcmN1c3AtY3VwYm9hcmQnLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICApO1xuICAgIGlmICghZ2hDaGVjay5vaykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZ2l0aHViX3JlcG9fdW5yZWFjaGFibGUnLCBzdGF0dXM6IGdoQ2hlY2suc3RhdHVzIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IHJlcG9NZXRhID0gKGF3YWl0IGdoQ2hlY2suanNvbigpKSBhcyB7XG4gICAgICBpZD86IG51bWJlcjtcbiAgICAgIHByaXZhdGU/OiBib29sZWFuO1xuICAgICAgcGVybWlzc2lvbnM/OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPjtcbiAgICAgIGRlZmF1bHRfYnJhbmNoPzogc3RyaW5nO1xuICAgIH07XG4gICAgaWYgKHJlcG9NZXRhLnByaXZhdGUpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3ByaXZhdGVfcmVwb19yZWplY3RlZCcgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKHJlcG9NZXRhLmlkICE9PSBib2R5LmdpdGh1Yl9yZXBvc2l0b3J5X2lkKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdyZXBvc2l0b3J5X2lkX21pc21hdGNoJywgZXhwZWN0ZWQ6IHJlcG9NZXRhLmlkIH0sIDQwMCk7XG4gICAgfVxuICAgIC8vIFB1Ymxpc2hlci1wZXJtaXNzaW9uIHNpZ25hbCAoaXRlbSAyKTogc2FtZSB0cnVzdCBzaWduYWwgZm9yIGV2ZXJ5IGtpbmQuXG4gICAgY29uc3QgcHVibGlzaGVyX3Blcm1pc3Npb24gPSBkZXJpdmVQdWJsaXNoZXJQZXJtaXNzaW9uKHJlcG9NZXRhLnBlcm1pc3Npb25zKTtcblxuICAgIC8vIENvbnRlbnQgcGluIGJlZm9yZSBkZWR1cDogYSBuZXcgZGVmYXVsdC1icmFuY2ggU0hBIGlzIGEgbmV3IGxpc3RpbmdcbiAgICAvLyB2ZXJzaW9uLCB3aGlsZSBhbiBleGFjdCBTSEEgcmVtYWlucyBhbiBpZGVtcG90ZW50IHJldHJ5IChQLTAwNCkuXG4gICAgbGV0IHBpbjogQ29udGVudFBpbiB8IG51bGwgPSBudWxsO1xuICAgIC8vIEEgbGlzdGluZyB0aGF0IGRlY2xhcmVzIGl0ZW0gdHlwZXMgb3IgcGxhbiB0eXBlcyBpcyBwaW5uZWQgdG9vIChtaWdyYXRpb24gMDQ5LFxuICAgIC8vIHBsYW4taXRlbS10eXBlcy1yZWdpc3RyeS1jdXBib2FyZC0yMDI2LTEwLTIwIFAtMDA2LCBELTAwOCk6IGl0cyBkZWZpbml0aW9ucyBhcmVcbiAgICAvLyBkZWNsYXJhdGl2ZSBmaWxlcyB1bmRlciA8bGlzdGluZ19yZWY+LywgYW5kIHRoZSBpbnN0YWxsZXIgb25seSBhY2NlcHRzIGEgdHlwZSBwYWNrXG4gICAgLy8gd2hvc2UgY29udGVudCBpdCBjYW4gdmVyaWZ5IGFnYWluc3QgdGhpcyBwaW4uXG4gICAgaWYgKGlzU2VsZkRlc2NyaWJpbmdLaW5kKGtpbmQpIHx8IGRlY2xhcmVkVHlwZXMuaXRlbVR5cGVzICsgZGVjbGFyZWRUeXBlcy5wbGFuVHlwZXMgPiAwKSB7XG4gICAgICBpZiAodHlwZW9mIHJlcG9NZXRhLmRlZmF1bHRfYnJhbmNoICE9PSAnc3RyaW5nJyB8fCByZXBvTWV0YS5kZWZhdWx0X2JyYW5jaCA9PT0gJycpIHtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZ2l0aHViX3JlcG9fdW5yZWFjaGFibGUnLCByZWFzb246ICdub19kZWZhdWx0X2JyYW5jaCcgfSwgNDAwKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBpbm5lZCA9IGF3YWl0IHBpbkxpc3RpbmdDb250ZW50KHtcbiAgICAgICAgdG9rZW46IGV4dHJhY3RCZWFyZXIoYy5yZXEucmF3KSxcbiAgICAgICAgb3duZXI6IGJvZHkuZ2l0aHViX293bmVyLFxuICAgICAgICBuYW1lOiBib2R5LmdpdGh1Yl9uYW1lLFxuICAgICAgICBkZWZhdWx0QnJhbmNoOiByZXBvTWV0YS5kZWZhdWx0X2JyYW5jaCxcbiAgICAgICAgbGlzdGluZ1JlZjogYm9keS5saXN0aW5nX3JlZiBhcyBzdHJpbmcsXG4gICAgICAgIGtpbmQsXG4gICAgICB9KTtcbiAgICAgIGlmICghcGlubmVkLm9rKSB7XG4gICAgICAgIGlmIChwaW5uZWQuY29kZSA9PT0gJ2dpdGh1Yl90cmVlX3VucmVhY2hhYmxlJykge1xuICAgICAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogcGlubmVkLmNvZGUsIHN0ZXA6IHBpbm5lZC5zdGVwLCBzdGF0dXM6IHBpbm5lZC5zdGF0dXMgfSwgNDAwKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGlubmVkLmNvZGUgPT09ICdnaXRodWJfYmxvYl91bnJlYWNoYWJsZScpIHtcbiAgICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHBpbm5lZC5jb2RlLCBwYXRoOiBwaW5uZWQucGF0aCwgc3RhdHVzOiBwaW5uZWQuc3RhdHVzIH0sIDQwMCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBpbm5lZC5jb2RlID09PSAnaWRlbnRpdHlfbGVhaycpIHtcbiAgICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6IHBpbm5lZC5jb2RlLCBjb21taXRTaGE6IHBpbm5lZC5jb21taXRTaGEsIGhpdHM6IHBpbm5lZC5oaXRzIH0sIDQyMik7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgeyBvazogX29rLCBjb2RlLCAuLi5kZXRhaWwgfSA9IHBpbm5lZDtcbiAgICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiBjb2RlLCAuLi5kZXRhaWwgfSwgNDIyKTtcbiAgICAgIH1cbiAgICAgIHBpbiA9IHBpbm5lZDtcbiAgICB9XG5cbiAgICAvLyBEZWR1cC4gSGFybmVzcyDihpIgb25lIGFjdGl2ZSBsaXN0aW5nIHBlciByZXBvLiBOb24taGFybmVzcyDihpIgb25lIGFjdGl2ZVxuICAgIC8vIGxpc3RpbmcgcGVyIChyZXBvLCBraW5kLCBsaXN0aW5nX3JlZikuIEEgZGVkdXAgaGl0IHJldHVybnMgdGhlIGV4aXN0aW5nXG4gICAgLy8gbGlzdGluZyByYXRoZXIgdGhhbiBtaW50aW5nIGEgc2Vjb25kLlxuICAgIGNvbnN0IGV4aXN0aW5nID1cbiAgICAgIGtpbmQgPT09ICdoYXJuZXNzJ1xuICAgICAgICA/IGF3YWl0IGdldEhhcm5lc3NCeUdpdGh1YlJlcG9JZChjLmVudi5EQiwgYm9keS5naXRodWJfcmVwb3NpdG9yeV9pZClcbiAgICAgICAgOiBhd2FpdCBnZXRBY3RpdmVMaXN0aW5nQnlSZWZzKGMuZW52LkRCLCBib2R5LmdpdGh1Yl9yZXBvc2l0b3J5X2lkLCBraW5kLCBib2R5Lmxpc3RpbmdfcmVmIGFzIHN0cmluZywgcGluPy5jb21taXRTaGEpO1xuICAgIGNvbnN0IHByaW9yVmVyc2lvbiA9XG4gICAgICBraW5kICE9PSAnaGFybmVzcycgJiYgcGluICE9IG51bGwgJiYgZXhpc3RpbmcgPT0gbnVsbFxuICAgICAgICA/IGF3YWl0IGdldEFjdGl2ZUxpc3RpbmdCeVJlZnMoYy5lbnYuREIsIGJvZHkuZ2l0aHViX3JlcG9zaXRvcnlfaWQsIGtpbmQsIGJvZHkubGlzdGluZ19yZWYgYXMgc3RyaW5nKVxuICAgICAgICA6IGV4aXN0aW5nO1xuICAgIGlmIChleGlzdGluZyAmJiAhZXhpc3RpbmcudW5saXN0ZWRfYXQpIHtcbiAgICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdwdWJsaXNoX2RlZHVwJywge1xuICAgICAgICBsaXN0aW5nX2tpbmQ6IGtpbmQsXG4gICAgICAgIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBib2R5LmdpdGh1Yl9yZXBvc2l0b3J5X2lkLFxuICAgICAgICBsaXN0aW5nX3JlZjogZXhpc3RpbmcubGlzdGluZ19yZWYsXG4gICAgICAgIGV4aXN0aW5nX2lkOiBleGlzdGluZy5pZCxcbiAgICAgICAgdXNlcl9pZDogdXNlci5pZCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCBpZDogZXhpc3RpbmcuaWQsIGhhcm5lc3M6IGV4aXN0aW5nLCBsaXN0aW5nOiBleGlzdGluZywgZGVkdXA6IHRydWUgfSk7XG4gICAgfVxuXG4gICAgLy8gUHJlLXB1YmxpY2F0aW9uIHJldmlldyAoa25vd2xlZGdlLXBhY2tzIEQtMDA3KTogaW5zdHJ1Y3Rpb24tY2FycnlpbmdcbiAgICAvLyBraW5kcyBsYW5kIFBFTkRJTkcg4oCUIGludmlzaWJsZSB0byBwdWJsaWMgYnJvd3NlIHVudGlsIGFuIG9wZXJhdG9yXG4gICAgLy8gYXBwcm92ZXMuIFRoZSByZXNwb25zZSBjYXJyaWVzIHJldmlld19zdGF0dXMgc28gdGhlIHB1Ymxpc2hlcidzIGNsaWVudFxuICAgIC8vIGNhbiBzYXkgXCJwZW5kaW5nIGFwcHJvdmFsXCIgaW5zdGVhZCBvZiBcImxpdmVcIi5cbiAgICAvLyBDb250ZW50LWF3YXJlIHNpbmNlIG1pZ3JhdGlvbiAwNDk6IGEgbGlzdGluZyB0aGF0IGRlY2xhcmVzIGl0ZW0gdHlwZXMgb3IgcGxhbiB0eXBlc1xuICAgIC8vIGxhbmRzIHBlbmRpbmcgd2hhdGV2ZXIgaXRzIGtpbmQgKHBsYW4taXRlbS10eXBlcy1yZWdpc3RyeS1jdXBib2FyZC0yMDI2LTEwLTIwIFAtMDA2KS5cbiAgICBjb25zdCByZXZpZXdfc3RhdHVzID0gcHVibGlzaFJldmlld1N0YXR1cyhraW5kLCBkZWNsYXJlZFR5cGVzKTtcblxuICAgIC8vIOKUgOKUgCBDYXRhbG9nIGZpZWxkcyAobWlncmF0aW9uIDAxOCAvIHNoYXJlZC1wb3QtZGFvLWN1cGJvYXJkLXYxIFAtMDA4KSDilIDilIDilIDilIBcbiAgICAvLyBLaW5kLWFnbm9zdGljOiBldmVyeSBraW5kIGNhbiBiZSBwcml2YXRlLCBwcmljZWQsIGNvbXBhdGliaWxpdHktc2NvcGVkLFxuICAgIC8vIHBlcm1pc3Npb24tZGVjbGFyaW5nLCBhbmQgcGlubmVkIHRvIGFuIGltbXV0YWJsZSByZWxlYXNlLlxuICAgIGNvbnN0IGJhZENhdGFsb2cgPSAoZmllbGQ6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpID0+XG4gICAgICBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZCwgcmVhc29uIH0sIDQwMCk7XG4gICAgY29uc3QgQ0FUQUxPR19TVFJfTUFYID0gMjAwO1xuICAgIGNvbnN0IG9wdGlvbmFsU3RyID0gKHY6IHVua25vd24sIG1heCA9IENBVEFMT0dfU1RSX01BWCk6IHN0cmluZyB8IG51bGwgfCBmYWxzZSA9PlxuICAgICAgdiA9PSBudWxsID8gbnVsbCA6IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2LnRyaW0oKSAhPT0gJycgJiYgdi5sZW5ndGggPD0gbWF4ID8gdiA6IGZhbHNlO1xuXG4gICAgbGV0IHZpc2liaWxpdHlPdXQ6IExpc3RpbmdWaXNpYmlsaXR5ID0gJ3B1YmxpYyc7XG4gICAgaWYgKGJvZHkudmlzaWJpbGl0eSAhPSBudWxsKSB7XG4gICAgICBpZiAoIWlzTGlzdGluZ1Zpc2liaWxpdHkoYm9keS52aXNpYmlsaXR5KSkgcmV0dXJuIGJhZENhdGFsb2coJ3Zpc2liaWxpdHknLCAncHVibGljX3VubGlzdGVkX29yX3ByaXZhdGUnKTtcbiAgICAgIHZpc2liaWxpdHlPdXQgPSBib2R5LnZpc2liaWxpdHk7XG4gICAgfVxuICAgIGNvbnN0IHRlbmFudElkID0gb3B0aW9uYWxTdHIoYm9keS50ZW5hbnRfaWQpO1xuICAgIGlmICh0ZW5hbnRJZCA9PT0gZmFsc2UpIHJldHVybiBiYWRDYXRhbG9nKCd0ZW5hbnRfaWQnLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMjAwJyk7XG4gICAgLy8gRmFpbC1jbG9zZWQ6IGEgcHJpdmF0ZSBsaXN0aW5nIHdpdGggbm8gb3duaW5nIHRlbmFudCB3b3VsZCBiZSBpbnZpc2libGUgdG9cbiAgICAvLyBldmVyeW9uZSBpbmNsdWRpbmcgaXRzIHB1Ymxpc2hlciwgc28gcmVmdXNlIHRoZSByb3cgcmF0aGVyIHRoYW4gc3RvcmUgb25lXG4gICAgLy8gdGhhdCBjYW4gbmV2ZXIgYmUgcmVhZCBiYWNrLlxuICAgIGlmICh2aXNpYmlsaXR5T3V0ID09PSAncHJpdmF0ZScgJiYgdGVuYW50SWQgPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ3RlbmFudF9pZCcsICdyZXF1aXJlZF9mb3JfcHJpdmF0ZV92aXNpYmlsaXR5Jyk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2t1UmVmID0gb3B0aW9uYWxTdHIoYm9keS5za3VfcmVmKTtcbiAgICBpZiAoc2t1UmVmID09PSBmYWxzZSkgcmV0dXJuIGJhZENhdGFsb2coJ3NrdV9yZWYnLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMjAwJyk7XG4gICAgbGV0IHByaWNpbmdNb2RlbDogUHJpY2luZ01vZGVsIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGJvZHkucHJpY2luZ19tb2RlbCAhPSBudWxsKSB7XG4gICAgICBpZiAoIWlzUHJpY2luZ01vZGVsKGJvZHkucHJpY2luZ19tb2RlbCkpIHJldHVybiBiYWRDYXRhbG9nKCdwcmljaW5nX21vZGVsJywgJ2ZyZWVfb25lX3RpbWVfc3Vic2NyaXB0aW9uX29yX3Blcl91c2UnKTtcbiAgICAgIHByaWNpbmdNb2RlbCA9IGJvZHkucHJpY2luZ19tb2RlbDtcbiAgICB9XG4gICAgbGV0IHByaWNlQW1vdW50TWljcm9zOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoYm9keS5wcmljZV9hbW91bnRfbWljcm9zICE9IG51bGwpIHtcbiAgICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoYm9keS5wcmljZV9hbW91bnRfbWljcm9zKSB8fCAoYm9keS5wcmljZV9hbW91bnRfbWljcm9zIGFzIG51bWJlcikgPCAwKSB7XG4gICAgICAgIHJldHVybiBiYWRDYXRhbG9nKCdwcmljZV9hbW91bnRfbWljcm9zJywgJ25vbl9uZWdhdGl2ZV9pbnRlZ2VyJyk7XG4gICAgICB9XG4gICAgICBwcmljZUFtb3VudE1pY3JvcyA9IGJvZHkucHJpY2VfYW1vdW50X21pY3JvcyBhcyBudW1iZXI7XG4gICAgfVxuICAgIGNvbnN0IHByaWNlQ3VycmVuY3kgPSBvcHRpb25hbFN0cihib2R5LnByaWNlX2N1cnJlbmN5LCAxNik7XG4gICAgaWYgKHByaWNlQ3VycmVuY3kgPT09IGZhbHNlKSByZXR1cm4gYmFkQ2F0YWxvZygncHJpY2VfY3VycmVuY3knLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMTYnKTtcbiAgICAvLyBBIHByaWNlZCBsaXN0aW5nIG11c3QgYmUgQ09NUExFVEU6IGEgc2V0dGxlbWVudCBhZGFwdGVyIHJlc29sdmVzIHNrdV9yZWZcbiAgICAvLyBhbmQgY2hhcmdlcyBhbW91bnQrY3VycmVuY3ksIHNvIGEgaGFsZi1kZWNsYXJlZCBwcmljZSBpcyBhbiB1bmNoYXJnZWFibGVcbiAgICAvLyBsaXN0aW5nIHRoYXQgb25seSBmYWlscyBhdCBwdXJjaGFzZSB0aW1lLlxuICAgIGlmIChwcmljaW5nTW9kZWwgIT0gbnVsbCAmJiBwcmljaW5nTW9kZWwgIT09ICdmcmVlJykge1xuICAgICAgaWYgKHNrdVJlZiA9PSBudWxsKSByZXR1cm4gYmFkQ2F0YWxvZygnc2t1X3JlZicsICdyZXF1aXJlZF9mb3JfcHJpY2VkX2xpc3RpbmcnKTtcbiAgICAgIGlmIChwcmljZUFtb3VudE1pY3JvcyA9PSBudWxsKSByZXR1cm4gYmFkQ2F0YWxvZygncHJpY2VfYW1vdW50X21pY3JvcycsICdyZXF1aXJlZF9mb3JfcHJpY2VkX2xpc3RpbmcnKTtcbiAgICAgIGlmIChwcmljZUN1cnJlbmN5ID09IG51bGwpIHJldHVybiBiYWRDYXRhbG9nKCdwcmljZV9jdXJyZW5jeScsICdyZXF1aXJlZF9mb3JfcHJpY2VkX2xpc3RpbmcnKTtcbiAgICB9XG5cbiAgICBsZXQgY29tcGF0aWJpbGl0eUpzb246IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChib2R5LmNvbXBhdGliaWxpdHkgIT0gbnVsbCkge1xuICAgICAgY29uc3QgY29tcGF0ID0gYm9keS5jb21wYXRpYmlsaXR5O1xuICAgICAgaWYgKHR5cGVvZiBjb21wYXQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoY29tcGF0KSkgcmV0dXJuIGJhZENhdGFsb2coJ2NvbXBhdGliaWxpdHknLCAnbXVzdF9iZV9vYmplY3QnKTtcbiAgICAgIGNvbnN0IHsgcnVudGltZSwgcGxhdGZvcm1zLCBhcmNoaXRlY3R1cmVzIH0gPSBjb21wYXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBpZiAocnVudGltZSAhPSBudWxsICYmICh0eXBlb2YgcnVudGltZSAhPT0gJ3N0cmluZycgfHwgcnVudGltZS50cmltKCkgPT09ICcnIHx8IHJ1bnRpbWUubGVuZ3RoID4gQ0FUQUxPR19TVFJfTUFYKSkge1xuICAgICAgICByZXR1cm4gYmFkQ2F0YWxvZygnY29tcGF0aWJpbGl0eS5ydW50aW1lJywgJ25vbl9lbXB0eV9zdHJpbmdfbWF4XzIwMCcpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3RyQXJyYXkgPSAodjogdW5rbm93bik6IHN0cmluZ1tdIHwgbnVsbCA9PlxuICAgICAgICBBcnJheS5pc0FycmF5KHYpICYmIHYubGVuZ3RoIDw9IDY0ICYmXG4gICAgICAgIHYuZXZlcnkoKGUpID0+IHR5cGVvZiBlID09PSAnc3RyaW5nJyAmJiBlLnRyaW0oKSAhPT0gJycgJiYgZS5sZW5ndGggPD0gQ0FUQUxPR19TVFJfTUFYKVxuICAgICAgICAgID8gKHYgYXMgc3RyaW5nW10pXG4gICAgICAgICAgOiBudWxsO1xuICAgICAgbGV0IHBsYXRmb3JtTGlzdDogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAocGxhdGZvcm1zICE9IG51bGwpIHtcbiAgICAgICAgY29uc3QgcGFyc2VkID0gc3RyQXJyYXkocGxhdGZvcm1zKTtcbiAgICAgICAgaWYgKCFwYXJzZWQpIHJldHVybiBiYWRDYXRhbG9nKCdjb21wYXRpYmlsaXR5LnBsYXRmb3JtcycsICdzdHJpbmdfYXJyYXlfbWF4XzY0Jyk7XG4gICAgICAgIHBsYXRmb3JtTGlzdCA9IHBhcnNlZDtcbiAgICAgIH1cbiAgICAgIGxldCBhcmNoTGlzdDogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoYXJjaGl0ZWN0dXJlcyAhPSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHN0ckFycmF5KGFyY2hpdGVjdHVyZXMpO1xuICAgICAgICBpZiAoIXBhcnNlZCkgcmV0dXJuIGJhZENhdGFsb2coJ2NvbXBhdGliaWxpdHkuYXJjaGl0ZWN0dXJlcycsICdzdHJpbmdfYXJyYXlfbWF4XzY0Jyk7XG4gICAgICAgIGFyY2hMaXN0ID0gcGFyc2VkO1xuICAgICAgfVxuICAgICAgY29tcGF0aWJpbGl0eUpzb24gPSBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIC4uLih0eXBlb2YgcnVudGltZSA9PT0gJ3N0cmluZycgPyB7IHJ1bnRpbWUgfSA6IHt9KSxcbiAgICAgICAgLi4uKHBsYXRmb3JtTGlzdCA/IHsgcGxhdGZvcm1zOiBwbGF0Zm9ybUxpc3QgfSA6IHt9KSxcbiAgICAgICAgLi4uKGFyY2hMaXN0ID8geyBhcmNoaXRlY3R1cmVzOiBhcmNoTGlzdCB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgbGV0IHJlcXVpcmVkUGVybWlzc2lvbnNKc29uOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoYm9keS5yZXF1aXJlZF9wZXJtaXNzaW9ucyAhPSBudWxsKSB7XG4gICAgICBjb25zdCBwZXJtcyA9IGJvZHkucmVxdWlyZWRfcGVybWlzc2lvbnM7XG4gICAgICBpZiAoXG4gICAgICAgICFBcnJheS5pc0FycmF5KHBlcm1zKSB8fCBwZXJtcy5sZW5ndGggPT09IDAgfHwgcGVybXMubGVuZ3RoID4gMjAwIHx8XG4gICAgICAgICFwZXJtcy5ldmVyeSgocCkgPT4gdHlwZW9mIHAgPT09ICdzdHJpbmcnICYmIHAudHJpbSgpICE9PSAnJyAmJiBwLmxlbmd0aCA8PSBDQVRBTE9HX1NUUl9NQVgpXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ3JlcXVpcmVkX3Blcm1pc3Npb25zJywgJ25vbl9lbXB0eV9zdHJpbmdfYXJyYXlfbWF4XzIwMCcpO1xuICAgICAgfVxuICAgICAgaWYgKG5ldyBTZXQocGVybXMgYXMgc3RyaW5nW10pLnNpemUgIT09IHBlcm1zLmxlbmd0aCkge1xuICAgICAgICByZXR1cm4gYmFkQ2F0YWxvZygncmVxdWlyZWRfcGVybWlzc2lvbnMnLCAnZHVwbGljYXRlX3Blcm1pc3Npb24nKTtcbiAgICAgIH1cbiAgICAgIHJlcXVpcmVkUGVybWlzc2lvbnNKc29uID0gSlNPTi5zdHJpbmdpZnkocGVybXMpO1xuICAgIH1cblxuICAgIC8vIEltbXV0YWJsZSByZWxlYXNlIGlkZW50aXR5LiBDT05URU5UIGlkZW50aXR5IG9ubHkg4oCUIG5vIHJldHJpZXZhbCBVUkwsIHNvIGFcbiAgICAvLyBsYXRlciBzdG9yYWdlLXByb3ZpZGVyIG1pZ3JhdGlvbiAoRC0wMjQpIHRvdWNoZXMgbm8gZmllbGQgaGVyZS5cbiAgICBjb25zdCByZWxlYXNlVmVyc2lvbiA9IG9wdGlvbmFsU3RyKGJvZHkucmVsZWFzZV92ZXJzaW9uLCAxMDApO1xuICAgIGlmIChyZWxlYXNlVmVyc2lvbiA9PT0gZmFsc2UpIHJldHVybiBiYWRDYXRhbG9nKCdyZWxlYXNlX3ZlcnNpb24nLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMTAwJyk7XG4gICAgY29uc3QgcmVsZWFzZVNpZ25hdHVyZSA9IG9wdGlvbmFsU3RyKGJvZHkucmVsZWFzZV9zaWduYXR1cmUsIDEwMDApO1xuICAgIGlmIChyZWxlYXNlU2lnbmF0dXJlID09PSBmYWxzZSkgcmV0dXJuIGJhZENhdGFsb2coJ3JlbGVhc2Vfc2lnbmF0dXJlJywgJ25vbl9lbXB0eV9zdHJpbmdfbWF4XzEwMDAnKTtcbiAgICBjb25zdCByZWxlYXNlTWFuaWZlc3REaWdlc3QgPSBvcHRpb25hbFN0cihib2R5LnJlbGVhc2VfbWFuaWZlc3RfZGlnZXN0LCAxMjgpO1xuICAgIGlmIChyZWxlYXNlTWFuaWZlc3REaWdlc3QgPT09IGZhbHNlKSByZXR1cm4gYmFkQ2F0YWxvZygncmVsZWFzZV9tYW5pZmVzdF9kaWdlc3QnLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMTI4Jyk7XG4gICAgLy8gVGhlIEZVTEwgc2lnbmVkIG1hbmlmZXN0IChtaWdyYXRpb24gMDMyKS4gVGhlIHBpbnMgYWJvdmUgY2FuIHByb3ZlIHRoZVxuICAgIC8vIENMT1NVUkUgaXMgdW50YW1wZXJlZCwgYnV0IG9ubHkgdGhlc2UgYnl0ZXMgbGV0IGFuIGluc3RhbGxlciByZWNvbXB1dGVcbiAgICAvLyBsaXN0aW5nTWFuaWZlc3RTaWduaW5nQnl0ZXMoKSBhbmQgY2hlY2sgdGhlIHB1Ymxpc2hlciBzaWduYXR1cmUg4oCUIHdpdGhvdXRcbiAgICAvLyB0aGVtIHRoZSBpbnN0YWxsLXNpZGUgdmVyaWZpZXIgaXMgdW5yZWFjaGFibGUgKGlkZW50aXRpZXMtdjEgRC0wNzEvRC0wNzQpLlxuICAgIC8vIFN0b3JlZCBvcGFxdWVseTogdGhpcyBXb3JrZXIgZGVsaWJlcmF0ZWx5IGRvZXMgbm90IGltcG9ydCBvcGVyYXRvci1jb3JlJ3NcbiAgICAvLyBtYW5pZmVzdCB2YWxpZGF0b3IsIHNvIGl0IGJvdW5kcyBhbmQgd2VsbC1mb3JtcyB0aGUgdmFsdWUgYW5kIGxlYXZlcyB0aGVcbiAgICAvLyBTRU1BTlRJQyBjaGVjayB0byB0aGUgaW5zdGFsbGVyLCB3aGljaCBpcyB0aGUgc2lkZSB0aGF0IG11c3Qgbm90IGJlIGZvb2xlZC5cbiAgICBjb25zdCByZWxlYXNlTWFuaWZlc3QgPSBvcHRpb25hbFN0cihib2R5LnJlbGVhc2VfbWFuaWZlc3QsIDE2MDAwKTtcbiAgICBpZiAocmVsZWFzZU1hbmlmZXN0ID09PSBmYWxzZSkgcmV0dXJuIGJhZENhdGFsb2coJ3JlbGVhc2VfbWFuaWZlc3QnLCAnbm9uX2VtcHR5X3N0cmluZ19tYXhfMTYwMDAnKTtcbiAgICBpZiAocmVsZWFzZU1hbmlmZXN0ICE9IG51bGwpIHtcbiAgICAgIGxldCBwYXJzZWQ6IHVua25vd247XG4gICAgICB0cnkge1xuICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHJlbGVhc2VNYW5pZmVzdCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ3JlbGVhc2VfbWFuaWZlc3QnLCAnanNvbl9vYmplY3QnKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgcGFyc2VkICE9PSAnb2JqZWN0JyB8fCBwYXJzZWQgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheShwYXJzZWQpKSB7XG4gICAgICAgIHJldHVybiBiYWRDYXRhbG9nKCdyZWxlYXNlX21hbmlmZXN0JywgJ2pzb25fb2JqZWN0Jyk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIEFuIGlkZW50aXR5IGxpc3RpbmcncyBkZWNsYXJlZCBzdXJmYWNlIChtaWdyYXRpb24gMDM1IC8gcG9ydGFibGUtaWRlbnRpdHktXG4gICAgLy8gcGFja2FnZXMgUC0wMTYpOiB3aGF0IHRoZSBzdG9yZWZyb250IHByZXZpZXdzIGJlZm9yZSBpbnN0YWxsLiBUaGUgcHVibGlzaGVyXG4gICAgLy8gZGVyaXZlcyBpdCBmcm9tIHRoZSBjbG9zdXJlIGl0IHNpZ25zIGFuZCB0aGUgaW5zdGFsbGVyIHJlY29tcHV0ZXMgaXQgZnJvbSB0aGVcbiAgICAvLyB2ZXJpZmllZCBjbG9uZSwgc28g4oCUIGxpa2UgcmVsZWFzZV9tYW5pZmVzdCDigJQgaXQgaXMgYm91bmRlZCBhbmQgd2VsbC1mb3JtZWRcbiAgICAvLyBoZXJlIGFuZCBjaGVja2VkIHNlbWFudGljYWxseSBieSB0aGUgc2lkZSB0aGF0IG11c3Qgbm90IGJlIGZvb2xlZC4gUmVxdWlyZWRcbiAgICAvLyBvbiwgYW5kIGV4Y2x1c2l2ZSB0bywgdGhlIGlkZW50aXR5IGZhY2V0OiBhIHByZXZpZXcgdGhhdCBpcyBhYnNlbnQgd291bGRcbiAgICAvLyBkZXNjcmliZSBsZXNzIHRoYW4gd2hhdCBpbnN0YWxscy5cbiAgICBjb25zdCBpc0lkZW50aXR5TGlzdGluZyA9IGtpbmQgPT09ICdibHVlcHJpbnQnICYmIGJvZHkuYmx1ZXByaW50X2tpbmQgPT09ICdpZGVudGl0eSc7XG4gICAgY29uc3QgaWRlbnRpdHlTdXJmYWNlID0gb3B0aW9uYWxTdHIoYm9keS5pZGVudGl0eV9zdXJmYWNlLCAxNjAwMCk7XG4gICAgaWYgKGlkZW50aXR5U3VyZmFjZSA9PT0gZmFsc2UpIHJldHVybiBiYWRDYXRhbG9nKCdpZGVudGl0eV9zdXJmYWNlJywgJ25vbl9lbXB0eV9zdHJpbmdfbWF4XzE2MDAwJyk7XG4gICAgaWYgKGlkZW50aXR5U3VyZmFjZSAhPSBudWxsICYmICFpc0lkZW50aXR5TGlzdGluZykge1xuICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ2lkZW50aXR5X3N1cmZhY2UnLCAnYmx1ZXByaW50X2lkZW50aXR5X29ubHknKTtcbiAgICB9XG4gICAgaWYgKGlzSWRlbnRpdHlMaXN0aW5nICYmIGlkZW50aXR5U3VyZmFjZSA9PSBudWxsKSB7XG4gICAgICByZXR1cm4gYmFkQ2F0YWxvZygnaWRlbnRpdHlfc3VyZmFjZScsICdyZXF1aXJlZF93aXRoX2lkZW50aXR5X2JsdWVwcmludF9raW5kJyk7XG4gICAgfVxuICAgIGlmIChpZGVudGl0eVN1cmZhY2UgIT0gbnVsbCkge1xuICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoaWRlbnRpdHlTdXJmYWNlKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gYmFkQ2F0YWxvZygnaWRlbnRpdHlfc3VyZmFjZScsICdqc29uX29iamVjdCcpO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IHBhcnNlZCA9PT0gbnVsbCB8fCBBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ2lkZW50aXR5X3N1cmZhY2UnLCAnanNvbl9vYmplY3QnKTtcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IHJlbGVhc2VDb250ZW50SGFzaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGJvZHkucmVsZWFzZV9jb250ZW50X2hhc2ggIT0gbnVsbCkge1xuICAgICAgaWYgKHR5cGVvZiBib2R5LnJlbGVhc2VfY29udGVudF9oYXNoICE9PSAnc3RyaW5nJyB8fCAhQ09OVEVOVF9IQVNIX1JFLnRlc3QoYm9keS5yZWxlYXNlX2NvbnRlbnRfaGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIGJhZENhdGFsb2coJ3JlbGVhc2VfY29udGVudF9oYXNoJywgJ3NoYTI1Nl9jb2xvbl82NF9oZXgnKTtcbiAgICAgIH1cbiAgICAgIHJlbGVhc2VDb250ZW50SGFzaCA9IGJvZHkucmVsZWFzZV9jb250ZW50X2hhc2gudG9Mb3dlckNhc2UoKTtcbiAgICB9XG4gICAgLy8gQSB2ZXJzaW9uIG5hbWVzIGEgcmVsZWFzZTsgYSByZWxlYXNlIHdpdGhvdXQgY29udGVudCBpZGVudGl0eSBjYW5ub3QgYmVcbiAgICAvLyB2ZXJpZmllZCBvbiBkZWxpdmVyeSwgd2hpY2ggaXMgdGhlIHdob2xlIHBvaW50IG9mIHBpbm5pbmcgb25lLlxuICAgIGlmIChyZWxlYXNlVmVyc2lvbiAhPSBudWxsICYmIHJlbGVhc2VDb250ZW50SGFzaCA9PSBudWxsKSB7XG4gICAgICByZXR1cm4gYmFkQ2F0YWxvZygncmVsZWFzZV9jb250ZW50X2hhc2gnLCAncmVxdWlyZWRfd2l0aF9yZWxlYXNlX3ZlcnNpb24nKTtcbiAgICB9XG4gICAgaWYgKHJlbGVhc2VDb250ZW50SGFzaCAhPSBudWxsICYmIHJlbGVhc2VWZXJzaW9uID09IG51bGwpIHtcbiAgICAgIHJldHVybiBiYWRDYXRhbG9nKCdyZWxlYXNlX3ZlcnNpb24nLCAncmVxdWlyZWRfd2l0aF9yZWxlYXNlX2NvbnRlbnRfaGFzaCcpO1xuICAgIH1cblxuICAgIC8vIOKUgOKUgCBDb250ZW50IHBpbiAoY3VwYm9hcmQtcmVsZWFzZS1waXBlbGluZS1jb250ZW50LXRydXN0IFAtMDAxOyBELTAwMykg4pSA4pSAXG4gICAgLy8gQSBzZWxmLWRlc2NyaWJpbmcga2luZCBpbnN0YWxscyBmcm9tIGA8bGlzdGluZ19yZWY+L2Agb2YgdGhlIHJlcG8uIFRoZVxuICAgIC8vIFdvcmtlciByZXNvbHZlcyB0aGUgZGVmYXVsdC1icmFuY2ggaGVhZCBhbmQgZGlnZXN0cyB0aGF0IGRpcmVjdG9yeSBOT1csXG4gICAgLy8gd2l0aCB0aGUgcHVibGlzaGVyJ3Mgb3duIHRva2VuLCBzbyB3aGF0IHRoZSBpbnN0YWxsZXIgKFAtMDAyKSB2ZXJpZmllcyBpc1xuICAgIC8vIHdoYXQgdGhlIFdvcmtlciBzYXcg4oCUIG5ldmVyIHdoYXQgdGhlIGNsaWVudCByZXBvcnRlZC4gQ29kZSBraW5kcyBwaW5cbiAgICAvLyB0aHJvdWdoIHRoZSByZWxlYXNlIGdhdGUgaW5zdGVhZCAoUGhhc2UgNCkgYW5kIGFyZSB1bnRvdWNoZWQgaGVyZS5cbiAgICBjb25zdCBpZCA9IHV1aWR2NCgpO1xuICAgIGF3YWl0IGluc2VydEhhcm5lc3MoYy5lbnYuREIsIHtcbiAgICAgIGlkLFxuICAgICAgbGlzdGluZ19raW5kOiBraW5kLFxuICAgICAgcmV2aWV3X3N0YXR1cyxcbiAgICAgIHByb2plY3RfcmVmOiBib2R5LnByb2plY3RfcmVmID8/IG51bGwsXG4gICAgICBsaXN0aW5nX3JlZjoga2luZCA9PT0gJ2hhcm5lc3MnID8gbnVsbCA6IChib2R5Lmxpc3RpbmdfcmVmID8/IG51bGwpLFxuICAgICAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ6IGJvZHkuZ2l0aHViX3JlcG9zaXRvcnlfaWQsXG4gICAgICBnaXRodWJfb3duZXI6IGJvZHkuZ2l0aHViX293bmVyLFxuICAgICAgZ2l0aHViX25hbWU6IGJvZHkuZ2l0aHViX25hbWUsXG4gICAgICBnaXRodWJfdXJsOiBib2R5LmdpdGh1Yl91cmwsXG4gICAgICB0aXRsZTogYm9keS50aXRsZSA/PyBib2R5LmdpdGh1Yl9uYW1lLFxuICAgICAgZGVzY3JpcHRpb246IGJvZHkuZGVzY3JpcHRpb24gPz8gbnVsbCxcbiAgICAgIHRvcGljX2hleDogYm9keS50b3BpY19oZXggPz8gbnVsbCxcbiAgICAgIHB1Ymxpc2hlcl9naXRodWJfdXNlcl9pZDogdXNlci5pZCxcbiAgICAgIHB1Ymxpc2hlcl9naXRodWJfbG9naW46IHVzZXIubG9naW4sXG4gICAgICBwdWJsaXNoZXJfcGVybWlzc2lvbixcbiAgICAgIHB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5OiBib2R5LnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5ID8/IG51bGwsXG4gICAgICBwdWJsaXNoZXJfYXR0ZXN0YXRpb25fZ2lzdF9pZDogYm9keS5hdHRlc3RhdGlvbl9naXN0X2lkID8/IG51bGwsXG4gICAgICBwcm92aWRlc190b29sczogcHJvdmlkZXNUb29sc0pzb24sXG4gICAgICB1c2VzX3Rvb2xzOiB1c2VzVG9vbHNKc29uLFxuICAgICAgcHJvdmlkZXNfZXZlbnRzOiBwcm92aWRlc0V2ZW50c0pzb24sXG4gICAgICByZXF1aXJlc19ldmVudHM6IHJlcXVpcmVzRXZlbnRzSnNvbixcbiAgICAgIHJlcXVpcmVzX3J1YnJpY3M6IHJlcXVpcmVzUnVicmljc0pzb24sXG4gICAgICBwcm92aWRlc19pdGVtX3R5cGVzOiBwcm92aWRlc0l0ZW1UeXBlc0pzb24sXG4gICAgICBwcm92aWRlc19wbGFuX3R5cGVzOiBwcm92aWRlc1BsYW5UeXBlc0pzb24sXG4gICAgICByZXF1aXJlc19wbGFuX3R5cGU6IHJlcXVpcmVzUGxhblR5cGVKc29uLFxuICAgICAgaGl2ZV9wdWJrZXk6IChib2R5LmhpdmVfcHVia2V5IGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gbnVsbCxcbiAgICAgIGhpdmVfdGl0bGU6IChib2R5LmhpdmVfdGl0bGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyBudWxsLFxuICAgICAgLy8gUC0wMTg6IHRoZSBibHVlcHJpbnQueWFtbCBga2luZGAgZm9yIGEgYmx1ZXByaW50IGxpc3RpbmcgKHRoZSBIaXZlcy10YWJcbiAgICAgIC8vIGRpc2NyaW1pbmF0b3IpLCBvciB0aGUgaWRlbnRpdHkgZmFjZXQgKFAtMDE2KS4gT25seSBtZWFuaW5nZnVsIGZvclxuICAgICAgLy8ga2luZD0nYmx1ZXByaW50JzsgbGVuaWVudCDigJQgYW4gYWJzZW50L2JhZCB2YWx1ZSDih5IgbnVsbCAodHJlYXRlZCBhcyBhXG4gICAgICAvLyBoYXJuZXNzLWJsdWVwcmludCksIG5ldmVyIGJsb2NrcyBhIHB1Ymxpc2guXG4gICAgICBibHVlcHJpbnRfa2luZDpcbiAgICAgICAga2luZCA9PT0gJ2JsdWVwcmludCcgJiZcbiAgICAgICAgKGJvZHkuYmx1ZXByaW50X2tpbmQgPT09ICdoaXZlJyB8fCBib2R5LmJsdWVwcmludF9raW5kID09PSAnaGFybmVzcycgfHwgYm9keS5ibHVlcHJpbnRfa2luZCA9PT0gJ2lkZW50aXR5JylcbiAgICAgICAgICA/IGJvZHkuYmx1ZXByaW50X2tpbmRcbiAgICAgICAgICA6IG51bGwsXG4gICAgICBpZGVudGl0eV9zdXJmYWNlOiBpZGVudGl0eVN1cmZhY2UsXG4gICAgICAvLyBBcHAgZGlzdHJpYnV0aW9uIChtaWdyYXRpb24gMDE0KS4gQXBwLW9ubHkg4oCUIG51bGwgb24gZXZlcnkgb3RoZXIga2luZFxuICAgICAgLy8gKHRoZSB2YWxpZGF0aW9uIGFib3ZlIHJlamVjdHMgYW4gYXBwIGZpZWxkIG9uIGEgbm9uLWFwcCBwdWJsaXNoKS5cbiAgICAgIGRlbGl2ZXJ5X3R5cGU6IGRlbGl2ZXJ5VHlwZSxcbiAgICAgIGxhdGVzdF9qc29uX3VybDogbGF0ZXN0SnNvblVybCxcbiAgICAgIHJlbGVhc2VfcmVwbzogcmVsZWFzZVJlcG8sXG4gICAgICBpY29uX3VybDogaWNvblVybCxcbiAgICAgIHBsYXRmb3JtczogcGxhdGZvcm1zSnNvbixcbiAgICAgIC8vIENhdGFsb2cgYXhlcyAobWlncmF0aW9uIDAxOCAvIFAtMDA4KS4gS2luZC1hZ25vc3RpYy5cbiAgICAgIHZpc2liaWxpdHk6IHZpc2liaWxpdHlPdXQsXG4gICAgICB0ZW5hbnRfaWQ6IHRlbmFudElkLFxuICAgICAgc2t1X3JlZjogc2t1UmVmLFxuICAgICAgcHJpY2luZ19tb2RlbDogcHJpY2luZ01vZGVsLFxuICAgICAgcHJpY2VfYW1vdW50X21pY3JvczogcHJpY2VBbW91bnRNaWNyb3MsXG4gICAgICBwcmljZV9jdXJyZW5jeTogcHJpY2VDdXJyZW5jeSxcbiAgICAgIGNvbXBhdGliaWxpdHlfanNvbjogY29tcGF0aWJpbGl0eUpzb24sXG4gICAgICByZXF1aXJlZF9wZXJtaXNzaW9uczogcmVxdWlyZWRQZXJtaXNzaW9uc0pzb24sXG4gICAgICByZWxlYXNlX3ZlcnNpb246IHJlbGVhc2VWZXJzaW9uLFxuICAgICAgcmVsZWFzZV9jb250ZW50X2hhc2g6IHJlbGVhc2VDb250ZW50SGFzaCxcbiAgICAgIHJlbGVhc2VfbWFuaWZlc3RfZGlnZXN0OiByZWxlYXNlTWFuaWZlc3REaWdlc3QsXG4gICAgICByZWxlYXNlX3NpZ25hdHVyZTogcmVsZWFzZVNpZ25hdHVyZSxcbiAgICAgIHJlbGVhc2VfbWFuaWZlc3Q6IHJlbGVhc2VNYW5pZmVzdCxcbiAgICAgIHJlbGVhc2VfcHVibGlzaGVkX2F0OiByZWxlYXNlVmVyc2lvbiAhPSBudWxsID8gbm93IDogbnVsbCxcbiAgICAgIC8vIENvbnRlbnQgcGluIChQLTAwMSk6IHNlbGYtZGVzY3JpYmluZyBraW5kcyBvbmx5OyBudWxsIG9uIGNvZGUga2luZHMuXG4gICAgICBwaW5uZWRfY29tbWl0X3NoYTogcGluPy5jb21taXRTaGEgPz8gbnVsbCxcbiAgICAgIHBpbm5lZF90cmVlX2RpZ2VzdDogcGluPy50cmVlRGlnZXN0ID8/IG51bGwsXG4gICAgICBwaW5uZWRfYXQ6IHBpbiA/IG5vdyA6IG51bGwsXG4gICAgICAvLyBQLTAwNzogdGhlIFdvcmtlcidzIE9XTiBhdXRob3JpdHkgdmVyZGljdCBmb3IgYSByZWNpcGUgKG5ldmVyIHRoZSBwdWJsaXNoZXIncyBtYW5pZmVzdFxuICAgICAgLy8gY2xhaW0pOyBudWxsIG9uIGV2ZXJ5IG90aGVyIGtpbmQuXG4gICAgICBhdXRob3JpdHlfdW5yZXNvbHZlZDogcGluPy5yZWNpcGVBdXRob3JpdHkgPyAocGluLnJlY2lwZUF1dGhvcml0eS51bnJlc29sdmVkID8gMSA6IDApIDogbnVsbCxcbiAgICAgIGF1dGhvcml0eV91bnJlc29sdmVkX2NhdXNlOiBwaW4/LnJlY2lwZUF1dGhvcml0eT8uY2F1c2UgPz8gbnVsbCxcbiAgICAgIC8vIFAtMDEwIChSLTYpOiB0aGUgb3B0aW9uYWwgcHJvdmVuYW5jZSBiYWRnZS4gQXNrZWQgT05MWSBhZnRlciB0aGUgV29ya2VyIGhhcyBwaW5uZWRcbiAgICAgIC8vIGFuZCBzY2FubmVkIHRoZSBieXRlcyBhYm92ZSwgYW5kIG9ubHkgZm9yIGEgcGlubmVkIChzZWxmLWRlc2NyaWJpbmcpIGxpc3Rpbmcg4oCUIHRoZVxuICAgICAgLy8gYXR0ZXN0YXRpb24gYmluZHMgdGhlIGA8cmVmPi9gIHRyZWUgZGlnZXN0IHRoZSBXb3JrZXIgY29tcHV0ZWQsIG5ldmVyIHRoZSBjbGllbnQnc1xuICAgICAgLy8gY2xhaW0uIEFueSBmYWlsdXJlIChubyBhdHRlc3RhdGlvbiwgYmFkIGJ1bmRsZSwgR2l0SHViIGRvd24pIHN0b3JlcyAnd29ya2VyJzsgYW5cbiAgICAgIC8vIGF0dGVzdGF0aW9uIGlzIG5ldmVyIGEgcHJlY29uZGl0aW9uIGZvciBwdWJsaXNoaW5nLlxuICAgICAgdmVyaWZpZWRfYnk6IHBpblxuICAgICAgICA/IGF3YWl0IHJlc29sdmVWZXJpZmllZEJ5KHtcbiAgICAgICAgICAgIHJlcG86IGAke2JvZHkuZ2l0aHViX293bmVyfS8ke2JvZHkuZ2l0aHViX25hbWV9YCxcbiAgICAgICAgICAgIHRyZWVEaWdlc3Q6IHBpbi50cmVlRGlnZXN0LFxuICAgICAgICAgICAgY29tbWl0U2hhOiBwaW4uY29tbWl0U2hhLFxuICAgICAgICAgICAgdG9rZW46IGV4dHJhY3RCZWFyZXIoYy5yZXEucmF3KSxcbiAgICAgICAgICB9KVxuICAgICAgICA6ICd3b3JrZXInLFxuICAgICAgY3JlYXRlZF9hdDogbm93LFxuICAgIH0pO1xuICAgIC8vIFNQRUMtUC0wMDRAMjogYSBuZXcgU0hBIGlzIGEgbmV3IFZFUlNJT04sIGFuZCB0aGUgcHJldmlvdXNseSBhcHByb3ZlZCBvbmVcbiAgICAvLyBrZWVwcyBiZWluZyBzZXJ2ZWQgdG8gaW5zdGFsbGVycyB3aGlsZSB0aGUgbmV3IG9uZSBpcyBgcGVuZGluZ2AgcmV2aWV3LlxuICAgIC8vIFRoZSBwcmlvciByb3cgaXMgcmV0aXJlZCBvbmx5IGF0IHRoZSBtb21lbnQgdGhlIG5ldyB2ZXJzaW9uIGJlY29tZXMgdGhlXG4gICAgLy8gc2VydmVkIG9uZSDigJQgaGVyZSBmb3IgYSBraW5kIHRoYXQgcHVibGlzaGVzIGBhcHByb3ZlZGAgKG5vIHJldmlldyBwb2xpY3kpLFxuICAgIC8vIGFuZCBhdCB0aGUgcmV2aWV3IGFwcHJvdmFsIGZvciB0aGUgcmVzdCAoUC0wMDgpLiBTdXBlcnNlZGluZyBhdCBwdWJsaXNoXG4gICAgLy8gZm9yIGEgcGVuZGluZyB2ZXJzaW9uIHdvdWxkIHVubGlzdCB0aGUgb25seSBpbnN0YWxsYWJsZSBjb3B5ICh0aGVcbiAgICAvLyBhdmFpbGFiaWxpdHkgaG9sZSB0aGlzIGd1YXJkIGV4aXN0cyB0byBwcmV2ZW50KS5cbiAgICBpZiAocHJpb3JWZXJzaW9uICYmIHBpbiAhPSBudWxsICYmIHJldmlld19zdGF0dXMgPT09ICdhcHByb3ZlZCcgJiYgcHJpb3JWZXJzaW9uLnBpbm5lZF9jb21taXRfc2hhICE9PSBwaW4uY29tbWl0U2hhKSB7XG4gICAgICBhd2FpdCBzdXBlcnNlZGVIYXJuZXNzTGlzdGluZyhjLmVudi5EQiwgcHJpb3JWZXJzaW9uLmlkLCBpZCwgJ3N1cGVyc2VkZWRfYnlfbmV3X2NvbnRlbnRfcGluJywgbm93KTtcbiAgICB9XG4gICAgYXdhaXQgYXVkaXQoYy5lbnYuREIsIG5vdywgJ3B1Ymxpc2hlZCcsIHtcbiAgICAgIGlkLFxuICAgICAgbGlzdGluZ19raW5kOiBraW5kLFxuICAgICAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ6IGJvZHkuZ2l0aHViX3JlcG9zaXRvcnlfaWQsXG4gICAgICBsaXN0aW5nX3JlZjoga2luZCA9PT0gJ2hhcm5lc3MnID8gbnVsbCA6IGJvZHkubGlzdGluZ19yZWYsXG4gICAgICBwdWJsaXNoZXJfZ2l0aHViX3VzZXJfaWQ6IHVzZXIuaWQsXG4gICAgICByZXZpZXdfc3RhdHVzLFxuICAgIH0pO1xuICAgIGNvbnN0IGxpc3RpbmcgPSBhd2FpdCBnZXRIYXJuZXNzQnlJZChjLmVudi5EQiwgaWQpO1xuICAgIHJldHVybiBjLmpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICBpZCxcbiAgICAgIGhhcm5lc3M6IGxpc3RpbmcsXG4gICAgICBsaXN0aW5nLFxuICAgICAgcmV2aWV3X3N0YXR1cyxcbiAgICAgIC4uLihyZXZpZXdfc3RhdHVzID09PSAncGVuZGluZydcbiAgICAgICAgPyB7IHBlbmRpbmdfcmV2aWV3OiB0cnVlLCBoaW50OiAnVGhpcyBsaXN0aW5nIGtpbmQgcmVxdWlyZXMgb3BlcmF0b3IgYXBwcm92YWwgYmVmb3JlIGl0IGlzIHB1YmxpY2x5IHZpc2libGUuIFlvdSB3aWxsIHNlZSBpdCBhcyBwZW5kaW5nOyBldmVyeW9uZSBlbHNlIHNlZXMgaXQgb25jZSBhcHByb3ZlZC4nIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIERFTEVURSBiYXNlLzppZCDigJQgdW5saXN0IChwdWJsaXNoZXIgb3IgY2xhaW1hbnQpLlxuICBhcHAuZGVsZXRlKGAke2Jhc2V9LzppZGAsIGFzeW5jIChjKSA9PiB7XG4gICAgbGV0IHVzZXI7XG4gICAgdHJ5IHtcbiAgICAgIHVzZXIgPSBhd2FpdCByZXNvbHZlR2l0aHViQmVhcmVyKGMucmVxLnJhdyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2F1dGgnLCByZWFzb246IGUucmVhc29uIH0sIDQwMSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuICAgIGNvbnN0IHJvdyA9IGF3YWl0IGdldEhhcm5lc3NCeUlkKGMuZW52LkRCLCBpZCk7XG4gICAgaWYgKCFyb3cpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICBpZiAocm93LnVubGlzdGVkX2F0KSByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGFscmVhZHlfdW5saXN0ZWQ6IHRydWUgfSk7XG4gICAgY29uc3QgaXNQdWJsaXNoZXIgPSByb3cucHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkID09PSB1c2VyLmlkO1xuICAgIGNvbnN0IGlzQ2xhaW1hbnQgPSByb3cuY2xhaW1hbnRfZ2l0aHViX3VzZXJfaWQgPT09IHVzZXIuaWQ7XG4gICAgaWYgKCFpc1B1Ymxpc2hlciAmJiAhaXNDbGFpbWFudCkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZm9yYmlkZGVuJyB9LCA0MDMpO1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgYXdhaXQgbWFya0hhcm5lc3NVbmxpc3RlZChjLmVudi5EQiwgaWQsICdieV9wdWJsaXNoZXInLCBub3cpO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICd1bmxpc3RlZCcsIHsgaWQsIGxpc3Rpbmdfa2luZDogcm93Lmxpc3Rpbmdfa2luZCwgYnlfdXNlcl9pZDogdXNlci5pZCB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUgfSk7XG4gIH0pO1xuXG4gIC8vIFBPU1QgYmFzZS86aWQvY2xhaW0g4oCUIGNsYWltIGJ5IG1haW50YWluL2FkbWluIHBlcm0uXG4gIGFwcC5wb3N0KGAke2Jhc2V9LzppZC9jbGFpbWAsIGFzeW5jIChjKSA9PiB7XG4gICAgbGV0IHVzZXI7XG4gICAgdHJ5IHtcbiAgICAgIHVzZXIgPSBhd2FpdCByZXNvbHZlR2l0aHViQmVhcmVyKGMucmVxLnJhdyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBBdXRoRXJyb3IpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2F1dGgnLCByZWFzb246IGUucmVhc29uIH0sIDQwMSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuICAgIGNvbnN0IHJvdyA9IGF3YWl0IGdldEhhcm5lc3NCeUlkKGMuZW52LkRCLCBpZCk7XG4gICAgaWYgKCFyb3cpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICBpZiAocm93LnVubGlzdGVkX2F0KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmxpc3RlZCcgfSwgNDEwKTtcbiAgICBpZiAocm93LmNsYWltX3N0YXR1cyA9PT0gJ2NsYWltZWQnKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhbHJlYWR5X2NsYWltZWQnLCBjbGFpbWFudF9naXRodWJfdXNlcl9pZDogcm93LmNsYWltYW50X2dpdGh1Yl91c2VyX2lkIH0sIDQwOSk7XG4gICAgfVxuICAgIGNvbnN0IHBlcm0gPSBhd2FpdCBjaGVja1JlcG9QZXJtaXNzaW9uKFxuICAgICAgZXh0cmFjdEJlYXJlcihjLnJlcS5yYXcpLFxuICAgICAgcm93LmdpdGh1Yl9vd25lcixcbiAgICAgIHJvdy5naXRodWJfbmFtZSxcbiAgICAgICdtYWludGFpbicsXG4gICAgKTtcbiAgICBpZiAoIXBlcm0uaGFzX3Blcm1pc3Npb24pIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2luc3VmZmljaWVudF9wZXJtaXNzaW9uJywgcmVxdWlyZWQ6ICdtYWludGFpbicgfSwgNDAzKTtcbiAgICB9XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBhd2FpdCBzZXRIYXJuZXNzQ2xhaW0oYy5lbnYuREIsIGlkLCB7IHVzZXJfaWQ6IHVzZXIuaWQsIGxvZ2luOiB1c2VyLmxvZ2luIH0sIG5vdyk7XG4gICAgYXdhaXQgYXVkaXQoYy5lbnYuREIsIG5vdywgJ2NsYWltZWQnLCB7IGlkLCBsaXN0aW5nX2tpbmQ6IHJvdy5saXN0aW5nX2tpbmQsIHVzZXJfaWQ6IHVzZXIuaWQsIHBlcm1pc3Npb246IHBlcm0ucGVybWlzc2lvbiB9KTtcbiAgICBjb25zdCB1cGRhdGVkID0gYXdhaXQgZ2V0SGFybmVzc0J5SWQoYy5lbnYuREIsIGlkKTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGhhcm5lc3M6IHVwZGF0ZWQsIGxpc3Rpbmc6IHVwZGF0ZWQgfSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIFRoZSBnZW5lcmFsaXplZCBzdG9yZWZyb250IHJvdXRlLiBSZWdpc3RlcnMgdGhlIGtpbmQtYXdhcmUgL2xpc3RpbmdzIHN1cmZhY2VcbiAqIEFORCB0aGUga2luZD0naGFybmVzcycgL2hhcm5lc3NlcyBiYWNrLWNvbXBhdCB2aWV3IChzYW1lIGhhbmRsZXJzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3RpbmdzUm91dGUoKTogSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4ge1xuICBjb25zdCBhcHAgPSBuZXcgSG9ubzx7IEJpbmRpbmdzOiBFbnYgfT4oKTtcbiAgcmVnaXN0ZXJMaXN0aW5nRW5kcG9pbnRzKGFwcCwgJy9saXN0aW5ncycpO1xuICByZWdpc3Rlckxpc3RpbmdFbmRwb2ludHMoYXBwLCAnL2hhcm5lc3NlcycsIHsgZml4ZWRLaW5kOiAnaGFybmVzcycgfSk7XG4gIHJldHVybiBhcHA7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL2xpc3RpbmdzLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9saXN0aW5ncy50cyIsIi9zcmMvcm91dGVzL2xpc3RpbmdzLnRzIixbXV0=