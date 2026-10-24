'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("makeListingRow", () => { try { return makeListingRow } catch {} });
__vite_ssr_exportName__("mapInsertBindsByName", () => { try { return mapInsertBindsByName } catch {} });
__vite_ssr_exportName__("FakeStore", () => { try { return FakeStore } catch {} });
__vite_ssr_exportName__("makeDb", () => { try { return makeDb } catch {} });
__vite_ssr_exportName__("FakeKV", () => { try { return FakeKV } catch {} });
__vite_ssr_exportName__("FakeR2", () => { try { return FakeR2 } catch {} });
__vite_ssr_exportName__("makeEnv", () => { try { return makeEnv } catch {} });
__vite_ssr_exportName__("STUB_HEAD_SHA", () => { try { return STUB_HEAD_SHA } catch {} });
__vite_ssr_exportName__("stubTreeFor", () => { try { return stubTreeFor } catch {} });
__vite_ssr_exportName__("stubGithub", () => { try { return stubGithub } catch {} });
class FakeStmt {
  constructor(sql, store, binds = []) {
    this.sql = sql;
    this.store = store;
    this.binds = binds;
  }
  bind(...values) {
    return new FakeStmt(this.sql, this.store, values);
  }
  async run() {
    const changes = this.store.execute(this.sql, this.binds);
    return { success: true, meta: { changes } };
  }
  async first() {
    const rows = this.store.query(this.sql, this.binds);
    return rows[0] ?? null;
  }
  async all() {
    const rows = this.store.query(this.sql, this.binds);
    return { results: rows, success: true };
  }
}
function makeListingRow(over = {}) {
  return {
    id: "seed",
    listing_kind: "harness",
    project_ref: null,
    listing_ref: null,
    github_repository_id: 1,
    github_owner: "a",
    github_name: "b",
    github_url: "https://github.com/a/b",
    title: "T",
    description: null,
    topic_hex: "a".repeat(64),
    publisher_github_user_id: 1,
    publisher_github_login: "alice",
    publisher_permission: null,
    publisher_device_pubkey: null,
    publisher_attestation_gist_id: null,
    provides_tools: null,
    uses_tools: null,
    // migration 033 (tool axis — consumer half, WI-10001747)
    provides_events: null,
    // migration 012 (event dependency axis — provider half)
    requires_events: null,
    // migration 013 (event dependency axis — consumer half)
    requires_rubrics: null,
    // migration 015 (rubric dependency axis — consumer half)
    provides_item_types: null,
    // migration 049 (type packs)
    provides_plan_types: null,
    // migration 049 (type packs)
    requires_plan_type: null,
    // migration 049 (type packs)
    hive_pubkey: null,
    hive_title: null,
    blueprint_kind: null,
    claim_status: "unclaimed",
    claimant_github_user_id: null,
    claimant_github_login: null,
    superseded_by: null,
    stars: 0,
    contributor_count: 0,
    last_activity_at: null,
    languages: null,
    stats_refreshed_at: null,
    created_at: 1,
    updated_at: 1,
    unlisted_at: null,
    unlisted_reason: null,
    // migration 008 (knowledge-packs): pre-publication review fields.
    review_status: "approved",
    reviewed_at: null,
    review_reason: null,
    // migration 014 (cupboard-app-distribution): app-only distribution columns.
    delivery_type: null,
    latest_json_url: null,
    release_repo: null,
    icon_url: null,
    platforms: null,
    // migration 018 (shared-pot-dao-cupboard-v1 P-008): catalog axes.
    // `visibility` mirrors the column's NOT NULL DEFAULT 'public', so a row a
    // test does not opt into stays browsable exactly as it did pre-018.
    visibility: "public",
    tenant_id: null,
    sku_ref: null,
    pricing_model: null,
    price_amount_micros: null,
    price_currency: null,
    compatibility_json: null,
    required_permissions: null,
    release_version: null,
    release_content_hash: null,
    release_manifest_digest: null,
    release_signature: null,
    identity_surface: null,
    release_published_at: null,
    pinned_commit_sha: null,
    pinned_tree_digest: null,
    pinned_at: null,
    approved_commit_sha: null,
    approved_tree_digest: null,
    approved_at: null,
    authority_unresolved: null,
    authority_unresolved_cause: null,
    // migration 041 (P-010): the optional provenance badge; 'worker' is the NOT NULL default.
    verified_by: "worker",
    drift: 0,
    yanked_at: null,
    yanked_reason: null,
    revoked_at: null,
    revoked_reason: null,
    ...over
  };
};
function mapInsertBindsByName(sql, binds) {
  const match = /INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*$/i.exec(sql.trim());
  if (!match) throw new Error(`fake-d1: unparseable INSERT statement: ${sql.slice(0, 120)}`);
  const columns = match[1].split(",").map((c) => c.trim()).filter(Boolean);
  const values = match[2].split(",").map((v) => v.trim()).filter(Boolean);
  if (columns.length !== values.length) {
    throw new Error(
      `fake-d1: INSERT column/value arity mismatch (${columns.length} columns, ${values.length} values)`
    );
  };
  const row = {};
  let bindIndex = 0;
  for (let i = 0; i < columns.length; i += 1) {
    const value = values[i];
    if (value === "?") {
      if (bindIndex >= binds.length) {
        throw new Error(`fake-d1: INSERT needs more binds than supplied (${binds.length})`);
      };
      row[columns[i]] = binds[bindIndex++];
    } else if (/^'.*'$/.test(value)) {
      row[columns[i]] = value.slice(1, -1);
    } else if (/^NULL$/i.test(value)) {
      row[columns[i]] = null;
    } else {
      row[columns[i]] = Number.isNaN(Number(value)) ? value : Number(value);
    }
  };
  if (bindIndex !== binds.length) {
    throw new Error(
      `fake-d1: INSERT consumed ${bindIndex} of ${binds.length} binds — placeholder/bind mismatch`
    );
  };
  return row;
};
function applyCatalogPredicate(upper, binds, startIndex, rows) {
  let i = startIndex;
  let out = rows;
  if (upper.includes("H.VISIBILITY = ?")) {
    const visibility = binds[i++];
    out = out.filter((r) => r.visibility === visibility);
  };
  if (upper.includes("AND H.TENANT_ID = ?")) {
    const tenant = binds[i++];
    out = out.filter((r) => r.tenant_id === tenant);
  };
  if (upper.includes("H.PRICING_MODEL = ?")) {
    const pricing = binds[i++];
    out = out.filter((r) => r.pricing_model === pricing);
  };
  const priced = (r) => r.sku_ref != null && r.pricing_model != null && r.pricing_model !== "free";
  if (upper.includes("H.PRICING_MODEL != 'FREE'")) out = out.filter(priced);
  else if (upper.includes("H.PRICING_MODEL = 'FREE'")) out = out.filter((r) => !priced(r));
  if (upper.includes("JSON_EXTRACT(H.COMPATIBILITY_JSON")) {
    const runtime = binds[i++];
    out = out.filter((r) => parseJsonField(r.compatibility_json)?.runtime === runtime);
  };
  if (upper.includes("JSON_EACH(H.COMPATIBILITY_JSON, '$.PLATFORMS')")) {
    const platform = binds[i++];
    out = out.filter((r) => {
      const platforms = parseJsonField(r.compatibility_json)?.platforms;
      return Array.isArray(platforms) && platforms.includes(platform);
    });
  };
  if (upper.includes("JSON_EACH(H.REQUIRED_PERMISSIONS)")) {
    const permission = binds[i++];
    out = out.filter((r) => {
      const perms = parseJsonField(r.required_permissions);
      return Array.isArray(perms) && perms.includes(permission);
    });
  };
  if (upper.includes("OR H.TENANT_ID = ?")) {
    const scope = binds[i++];
    out = out.filter((r) => r.visibility === "public" || r.tenant_id === scope);
  } else if (upper.includes("H.VISIBILITY = 'PUBLIC'")) {
    out = out.filter((r) => r.visibility === "public");
  };
  if (upper.includes("H.YANKED_AT IS NULL")) out = out.filter((r) => r.yanked_at == null);
  if (upper.includes("H.REVOKED_AT IS NULL")) out = out.filter((r) => r.revoked_at == null);
  return { rows: out, index: i };
}
function parseJsonField(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
class FakeStore {
  tables = {
    harnesses: [],
    creator_drafts: [],
    reports: [],
    publish_rate_limit: [],
    indexer_runs: [],
    audit: [],
    banned_publisher_pubkeys: []
  };
  execute(sql, binds) {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("INSERT INTO CREATOR_DRAFTS")) {
      const [
        id,
        owner_github_user_id,
        owner_github_login,
        listing_kind,
        listing_ref,
        title,
        description,
        manifest_json,
        provenance_json,
        upload_token_hash,
        upload_expires_at,
        created_at,
        updated_at
      ] = binds;
      this.tables.creator_drafts.push({
        id,
        owner_github_user_id,
        owner_github_login,
        listing_kind,
        listing_ref,
        title,
        description,
        manifest_json,
        provenance_json,
        state: "draft",
        artifact_key: null,
        artifact_content_hash: null,
        artifact_size_bytes: null,
        artifact_content_type: null,
        upload_token_hash,
        upload_expires_at,
        reviewed_at: null,
        reviewed_by_github_user_id: null,
        review_reason: null,
        published_listing_id: null,
        created_at,
        updated_at
      });
      return 1;
    };
    if (upper.startsWith("UPDATE CREATOR_DRAFTS") && upper.includes("SET ARTIFACT_KEY")) {
      const [artifact_key, artifact_hash, artifact_size, artifact_type, updated_at, id] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id && r.state === "draft");
      if (!row) return 0;
      Object.assign(row, {
        artifact_key,
        artifact_content_hash: artifact_hash,
        artifact_size_bytes: artifact_size,
        artifact_content_type: artifact_type,
        upload_token_hash: null,
        upload_expires_at: null,
        updated_at
      });
      return 1;
    };
    if (upper.startsWith("UPDATE CREATOR_DRAFTS") && upper.includes("SET STATE")) {
      const [state, reviewed_at, reviewed_by, review_reason, published_listing_id, updated_at, id, from] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id && r.state === from);
      if (!row) return 0;
      row.state = state;
      if (reviewed_at != null) row.reviewed_at = reviewed_at;
      if (reviewed_by != null) row.reviewed_by_github_user_id = reviewed_by;
      if (review_reason != null) row.review_reason = review_reason;
      if (published_listing_id != null) row.published_listing_id = published_listing_id;
      row.updated_at = updated_at;
      return 1;
    };
    if (upper.startsWith("INSERT INTO HARNESSES")) {
      const written = mapInsertBindsByName(sql, binds);
      this.tables.harnesses.push(
        makeListingRow({
          ...written,
          // Column defaults the INSERT leaves to the schema.
          listing_kind: written.listing_kind ?? "harness",
          review_status: written.review_status ?? "approved",
          visibility: written.visibility ?? "public"
        })
      );
      return 1;
    };
    if (upper.startsWith("UPDATE HARNESSES") && upper.includes("SET REVIEW_STATUS")) {
      const [review_status, reviewed_at, review_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.review_status = review_status;
        row.reviewed_at = reviewed_at;
        row.review_reason = review_reason;
        row.updated_at = updated_at;
        return 1;
      };
      return 0;
    };
    if (upper.startsWith("UPDATE HARNESSES") && upper.includes("CLAIM_STATUS = 'SUPERSEDED'")) {
      const [successor, unlisted_at, reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id && r.unlisted_at == null);
      if (!row) return 0;
      Object.assign(row, {
        superseded_by: successor,
        claim_status: "superseded",
        unlisted_at,
        unlisted_reason: reason,
        updated_at
      });
      return 1;
    };
    if (upper.startsWith("UPDATE HARNESSES") && upper.includes("SET UNLISTED_AT")) {
      const [unlisted_at, unlisted_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.unlisted_at = unlisted_at;
        row.unlisted_reason = unlisted_reason;
        row.updated_at = updated_at;
        return 1;
      };
      return 0;
    };
    if (upper.includes("CLAIM_STATUS = 'CLAIMED'")) {
      const [claimant_user_id, claimant_login, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.claim_status = "claimed";
        row.claimant_github_user_id = claimant_user_id;
        row.claimant_github_login = claimant_login;
        row.updated_at = updated_at;
        return 1;
      };
      return 0;
    };
    if (upper.startsWith("UPDATE HARNESSES") && upper.includes("SET STARS")) {
      const [stars, contributor_count, last_activity_at, languages, refreshed, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.stars = stars;
        row.contributor_count = contributor_count;
        row.last_activity_at = last_activity_at;
        row.languages = languages;
        row.stats_refreshed_at = refreshed;
        row.updated_at = updated_at;
        return 1;
      };
      return 0;
    };
    if (upper.startsWith("UPDATE HARNESSES") && upper.includes("PUBLISHER_DEVICE_PUBKEY = NULL")) {
      const [updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.publisher_device_pubkey = null;
        row.publisher_attestation_gist_id = null;
        row.updated_at = updated_at;
        return 1;
      };
      return 0;
    };
    if (upper.startsWith("INSERT INTO REPORTS")) {
      const [id, harness_id, reporter_user_id, reporter_login, reason, ip_hash, created_at] = binds;
      this.tables.reports.push({
        id,
        harness_id,
        reporter_github_user_id: reporter_user_id,
        reporter_github_login: reporter_login,
        reason,
        ip_hash,
        status: "pending",
        resolved_at: null,
        resolved_by_operator_note: null,
        created_at
      });
      return 1;
    };
    if (upper.startsWith("UPDATE REPORTS")) {
      const [status, resolved_at, note, id] = binds;
      const row = this.tables.reports.find((r) => r.id === id && r.status === "pending");
      if (row) {
        row.status = status;
        row.resolved_at = resolved_at;
        row.resolved_by_operator_note = note;
        return 1;
      };
      return 0;
    };
    if (upper.startsWith("INSERT INTO PUBLISH_RATE_LIMIT")) {
      const [user_id, window_start] = binds;
      const existing = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start
      );
      if (existing) {
        existing.count = existing.count + 1;
      } else {
        this.tables.publish_rate_limit.push({ github_user_id: user_id, window_start, count: 1 });
      };
      return 1;
    };
    if (upper.startsWith("INSERT INTO AUDIT")) {
      const [ts, kind, detail] = binds;
      this.tables.audit.push({ ts, kind, detail });
      return 1;
    };
    if (upper.startsWith("INSERT INTO BANNED_PUBLISHER_PUBKEYS")) {
      const [pubkey, reason, added_at, op_id, updated_at] = binds;
      const existing = this.tables.banned_publisher_pubkeys.find((r) => r.pubkey === pubkey);
      if (existing) {
        existing.reason = reason;
        existing.updated_at = updated_at;
      } else {
        this.tables.banned_publisher_pubkeys.push({
          pubkey,
          reason,
          added_at,
          added_by_operator_user_id: op_id ?? null,
          updated_at
        });
      };
      return 1;
    };
    if (upper.startsWith("DELETE FROM BANNED_PUBLISHER_PUBKEYS")) {
      const [pubkey] = binds;
      const before = this.tables.banned_publisher_pubkeys.length;
      this.tables.banned_publisher_pubkeys = this.tables.banned_publisher_pubkeys.filter(
        (r) => r.pubkey !== pubkey
      );
      return before - this.tables.banned_publisher_pubkeys.length;
    };
    return 0;
  }
  query(sql, binds) {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("SELECT * FROM CREATOR_DRAFTS WHERE ID =")) {
      const [id] = binds;
      const row = this.tables.creator_drafts.find((r) => r.id === id);
      return row ? [row] : [];
    };
    if (upper.startsWith("SELECT * FROM CREATOR_DRAFTS")) {
      let i = 0;
      const owner = upper.includes("OWNER_GITHUB_USER_ID = ?") ? binds[i++] : void 0;
      const state = upper.includes("STATE = ?") ? binds[i++] : void 0;
      const hasOffset = upper.includes("OFFSET ?");
      const limit = binds[binds.length - (hasOffset ? 2 : 1)];
      const offset = hasOffset ? binds[binds.length - 1] : 0;
      return this.tables.creator_drafts.filter((r) => owner == null || r.owner_github_user_id === owner).filter((r) => state == null || r.state === state).sort((a, b) => b.updated_at - a.updated_at || String(a.id).localeCompare(String(b.id))).slice(offset, offset + limit);
    };
    if (upper.startsWith("SELECT * FROM HARNESSES WHERE ID =")) {
      const [id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      return row ? [row] : [];
    };
    if (upper.startsWith("SELECT * FROM HARNESSES") && upper.includes("PUBLISHER_GITHUB_USER_ID = ?")) {
      const [publisherId] = binds;
      const limit = binds[1];
      const offset = binds[2];
      return this.tables.harnesses.filter((r) => r.publisher_github_user_id === publisherId).sort((a, b) => b.updated_at - a.updated_at || String(a.id).localeCompare(String(b.id))).slice(offset, offset + limit);
    };
    if (upper.includes("AND LISTING_REF =")) {
      const [repoId, kind, ref, pin] = binds;
      const row = this.tables.harnesses.find(
        (r) => r.github_repository_id === repoId && r.listing_kind === kind && r.listing_ref === ref && r.unlisted_at == null && (!upper.includes("PINNED_COMMIT_SHA") || (upper.includes("PINNED_COMMIT_SHA IS NULL") ? r.pinned_commit_sha == null : r.pinned_commit_sha === pin))
      );
      return row ? [row] : [];
    };
    if (upper.startsWith("SELECT * FROM HARNESSES") && upper.includes("LISTING_KIND = 'HARNESS'")) {
      const [repoId] = binds;
      const matches = this.tables.harnesses.filter((r) => r.github_repository_id === repoId && r.listing_kind === "harness").sort((a, b) => (a.unlisted_at == null ? 0 : 1) - (b.unlisted_at == null ? 0 : 1));
      return matches.length ? [matches[0]] : [];
    };
    if (upper.includes("REVIEW_STATUS = 'PENDING'")) {
      const limit = binds[binds.length - 1];
      return this.tables.harnesses.filter((r) => r.review_status === "pending" && r.unlisted_at == null).sort((a, b) => a.created_at - b.created_at).slice(0, limit);
    };
    if (upper.startsWith("WITH POPULATION AS")) {
      let i = 0;
      const hasProject = upper.includes("H.PROJECT_REF = ?");
      const project = hasProject ? binds[i++] : void 0;
      const hasSearch = upper.includes("H.TITLE LIKE ?");
      const search = hasSearch ? String(binds[i++] ?? "").replaceAll("%", "").toLowerCase() : "";
      if (hasSearch) i += 3;
      const hasClaim = upper.includes("H.CLAIM_STATUS = ?");
      const claim = hasClaim ? binds[i++] : void 0;
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      if (upper.includes("REVIEW_STATUS = 'APPROVED'")) {
        rows = rows.filter((r) => r.review_status === "approved");
      };
      if (upper.includes("NOT EXISTS (SELECT 1 FROM BANNED_PUBLISHER_PUBKEYS")) {
        const banned = new Set(this.tables.banned_publisher_pubkeys.map((r) => r.pubkey));
        rows = rows.filter((r) => !r.publisher_device_pubkey || !banned.has(r.publisher_device_pubkey));
      };
      if (hasProject) rows = rows.filter((r) => r.project_ref === project);
      if (hasClaim) rows = rows.filter((r) => r.claim_status === claim);
      if (hasSearch) {
        rows = rows.filter(
          (r) => [r.title, r.description, r.github_owner, r.github_name].some((value) => String(value ?? "").toLowerCase().includes(search))
        );
      };
      ({ rows, index: i } = applyCatalogPredicate(upper, binds, i, rows));
      const hasMatchedKind = upper.includes("FROM POPULATION WHERE LISTING_KIND = ?");
      const matchedKind = hasMatchedKind ? binds[i] : void 0;
      const total = hasMatchedKind ? rows.filter((r) => r.listing_kind === matchedKind).length : rows.length;
      const counts = /* @__PURE__ */ new Map();
      for (const row of rows) counts.set(row.listing_kind, (counts.get(row.listing_kind) ?? 0) + 1);
      return [
        { metric: "total", value: null, n: total },
        ...[...counts.entries()].map(([value, n]) => ({ metric: "kind", value, n }))
      ];
    };
    if ((upper.startsWith("SELECT H.* FROM HARNESSES H WHERE") || upper.startsWith("SELECT * FROM HARNESSES WHERE")) && upper.includes("UNLISTED_AT IS NULL")) {
      let i = 0;
      const hasKind = upper.includes("H.LISTING_KIND = ?") || upper.includes(" LISTING_KIND = ?");
      const kind = hasKind ? binds[i++] : void 0;
      const hasBlueprintKind = upper.includes("BLUEPRINT_KIND = ?");
      const blueprintKind = hasBlueprintKind ? binds[i++] : void 0;
      const hasProject = upper.includes("H.PROJECT_REF = ?") || upper.includes(" PROJECT_REF = ?");
      const project = hasProject ? binds[i++] : void 0;
      const compositeCursor = upper.includes("H.LAST_ACTIVITY_AT = ? AND H.ID > ?");
      const nullCursor = upper.includes("H.LAST_ACTIVITY_AT IS NULL AND H.ID > ?");
      const legacyCursor = !compositeCursor && !nullCursor && upper.includes("LAST_ACTIVITY_AT < ?");
      let cursorActivity;
      let cursorId;
      if (compositeCursor) {
        cursorActivity = binds[i++];
        i++;
        cursorId = binds[i++];
      } else if (nullCursor) {
        cursorActivity = null;
        cursorId = binds[i++];
      } else if (legacyCursor) {
        cursorActivity = binds[i++];
      };
      const hasSearch = upper.includes("TITLE LIKE ?");
      const search = hasSearch ? String(binds[i++] ?? "").replaceAll("%", "").toLowerCase() : "";
      if (hasSearch) i += 3;
      const hasClaim = upper.includes("CLAIM_STATUS = ?");
      const claim = hasClaim ? binds[i++] : void 0;
      const limit = binds[binds.length - 1];
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      if (upper.includes("REVIEW_STATUS = 'APPROVED'")) {
        rows = rows.filter((r) => r.review_status === "approved");
      };
      if (upper.includes("NOT EXISTS (SELECT 1 FROM BANNED_PUBLISHER_PUBKEYS")) {
        const banned = new Set(this.tables.banned_publisher_pubkeys.map((r) => r.pubkey));
        rows = rows.filter((r) => !r.publisher_device_pubkey || !banned.has(r.publisher_device_pubkey));
      };
      if (hasKind) rows = rows.filter((r) => r.listing_kind === kind);
      if (hasBlueprintKind) {
        rows = rows.filter((r) => r.listing_kind === "blueprint" && r.blueprint_kind === blueprintKind);
      };
      if (hasProject) rows = rows.filter((r) => r.project_ref === project);
      if (hasClaim) rows = rows.filter((r) => r.claim_status === claim);
      if (hasSearch) {
        rows = rows.filter(
          (r) => [r.title, r.description, r.github_owner, r.github_name].some((value) => String(value ?? "").toLowerCase().includes(search))
        );
      };
      ({ rows, index: i } = applyCatalogPredicate(upper, binds, i, rows));
      if (cursorActivity !== void 0) {
        rows = rows.filter((r) => {
          const activity = r.last_activity_at;
          if (legacyCursor) return activity == null || activity < cursorActivity;
          if (cursorActivity == null) return activity == null && String(r.id) > String(cursorId);
          return activity == null || activity < cursorActivity || activity === cursorActivity && String(r.id) > String(cursorId);
        });
      };
      rows.sort((a, b) => {
        const aActivity = a.last_activity_at;
        const bActivity = b.last_activity_at;
        if (aActivity == null && bActivity != null) return 1;
        if (aActivity != null && bActivity == null) return -1;
        if (aActivity != null && bActivity != null && aActivity !== bActivity) return bActivity - aActivity;
        return String(a.id).localeCompare(String(b.id));
      });
      return rows.slice(0, limit);
    };
    if (upper.startsWith("SELECT COUNT FROM PUBLISH_RATE_LIMIT")) {
      const [user_id, window_start] = binds;
      const row = this.tables.publish_rate_limit.find(
        (r) => r.github_user_id === user_id && r.window_start === window_start
      );
      return row ? [{ count: row.count }] : [];
    };
    if (upper.startsWith("SELECT PUBKEY FROM BANNED_PUBLISHER_PUBKEYS")) {
      return this.tables.banned_publisher_pubkeys.map((r) => ({ pubkey: r.pubkey }));
    };
    if (upper.startsWith("SELECT * FROM BANNED_PUBLISHER_PUBKEYS")) {
      return [...this.tables.banned_publisher_pubkeys];
    };
    if (upper.startsWith("SELECT * FROM REPORTS WHERE ID =")) {
      const [id] = binds;
      const row = this.tables.reports.find((r) => r.id === id);
      return row ? [row] : [];
    };
    if (upper.includes("FROM REPORTS")) {
      const filterStatus = upper.includes("WHERE R.STATUS = ?");
      let rows = [...this.tables.reports];
      if (filterStatus) rows = rows.filter((r) => r.status === binds[0]);
      return rows.map((r) => ({
        ...r,
        harness_title: this.tables.harnesses.find((h) => h.id === r.harness_id)?.title ?? null,
        harness_github_url: this.tables.harnesses.find((h) => h.id === r.harness_id)?.github_url ?? null,
        harness_unlisted_at: this.tables.harnesses.find((h) => h.id === r.harness_id)?.unlisted_at ?? null
      }));
    };
    return [];
  }
};
function makeDb() {
  const store = new FakeStore();
  const db = {
    prepare(sql) {
      return new FakeStmt(sql, store);
    }
  };
  return { db, store };
};
class FakeKV {
  data = /* @__PURE__ */ new Map();
  async get(key) {
    return this.data.get(key) ?? null;
  }
  async put(key, value, _opts) {
    this.data.set(key, value);
  }
  async delete(key) {
    this.data.delete(key);
  }
};
async function fakeR2Bytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  };
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}
class FakeR2 {
  data = /* @__PURE__ */ new Map();
  httpMetadata = /* @__PURE__ */ new Map();
  customMetadata = /* @__PURE__ */ new Map();
  etags = /* @__PURE__ */ new Map();
  multipartUploads = /* @__PURE__ */ new Map();
  multipartPartUploadCalls = 0;
  nextMultipartUploadId = null;
  nextMultipartCompleteReturnOmitsCustomMetadata = false;
  nextMultipartUpload = 1;
  object(key, withBody) {
    const v = this.data.get(key);
    if (!v) return null;
    const etag = this.etags.get(key) ?? `fake-${v.byteLength}`;
    const httpMetadata = this.httpMetadata.get(key);
    const customMetadata = this.customMetadata.get(key);
    const base = {
      key,
      version: "1",
      size: v.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: /* @__PURE__ */ new Date(0),
      httpMetadata,
      customMetadata,
      storageClass: "Standard",
      writeHttpMetadata(headers) {
        if (httpMetadata?.contentType) headers.set("content-type", httpMetadata.contentType);
        if (httpMetadata?.cacheControl) headers.set("cache-control", httpMetadata.cacheControl);
        if (httpMetadata?.contentDisposition) headers.set("content-disposition", httpMetadata.contentDisposition);
      }
    };
    if (!withBody) return base;
    const copy = new Uint8Array(v);
    return {
      ...base,
      body: new Response(copy).body,
      bodyUsed: false,
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
      },
      async bytes() {
        return new Uint8Array(copy);
      },
      async text() {
        return new TextDecoder().decode(copy);
      },
      async json() {
        return JSON.parse(new TextDecoder().decode(copy));
      },
      async blob() {
        return new Blob([copy]);
      }
    };
  }
  async head(key) {
    return this.object(key, false);
  }
  async put(key, value, opts = {}) {
    if (opts.onlyIf?.etagDoesNotMatch === "*" && this.data.has(key)) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.data.set(key, new Uint8Array(bytes));
    const httpMetadata = opts.httpMetadata instanceof Headers ? { contentType: opts.httpMetadata.get("content-type") ?? void 0 } : opts.httpMetadata;
    if (httpMetadata) this.httpMetadata.set(key, httpMetadata);
    else this.httpMetadata.delete(key);
    if (opts.customMetadata) this.customMetadata.set(key, { ...opts.customMetadata });
    else this.customMetadata.delete(key);
    this.etags.set(key, `fake-${this.etags.size + 1}-${bytes.byteLength}`);
    return this.object(key, false);
  }
  async get(key) {
    return this.object(key, true);
  }
  multipartHandle(key, uploadId) {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value) => {
        this.multipartPartUploadCalls += 1;
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error("uploadPart: The specified multipart upload does not exist. (10024)");
        };
        const bytes = await fakeR2Bytes(value);
        let hash = 2166136261;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        const etag = `fake-part-${partNumber}-${bytes.byteLength}-${hash.toString(16)}`;
        record.parts.set(partNumber, { bytes: new Uint8Array(bytes), etag });
        return { partNumber, etag };
      },
      abort: async () => {
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error("abort: The specified multipart upload does not exist. (10024)");
        };
        this.multipartUploads.delete(uploadId);
      },
      complete: async (uploadedParts) => {
        const record = this.multipartUploads.get(uploadId);
        if (!record || record.key !== key) {
          throw new Error("complete: The specified multipart upload does not exist. (10024)");
        };
        const selected = [];
        for (const part of uploadedParts) {
          const stored = record.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error("complete: One or more specified parts could not be found. (10025)");
          };
          selected.push(stored);
        };
        if (selected.length > 1) {
          const regularSize = selected[0].bytes.byteLength;
          if (regularSize < 5 * 1024 * 1024) {
            throw new Error("complete: A multipart part is below the minimum size. (10011)");
          };
          if (selected.slice(0, -1).some((part) => part.bytes.byteLength !== regularSize)) {
            throw new Error("complete: All non-trailing parts must have the same size. (10048)");
          };
          if (selected.at(-1).bytes.byteLength > regularSize) {
            throw new Error("complete: The final part exceeds the regular part size. (10048)");
          }
        };
        const totalBytes = selected.reduce((sum, part) => sum + part.bytes.byteLength, 0);
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of selected) {
          combined.set(part.bytes, offset);
          offset += part.bytes.byteLength;
        };
        this.data.set(key, combined);
        const httpMetadata = record.options.httpMetadata instanceof Headers ? { contentType: record.options.httpMetadata.get("content-type") ?? void 0 } : record.options.httpMetadata;
        if (httpMetadata) this.httpMetadata.set(key, httpMetadata);
        else this.httpMetadata.delete(key);
        if (record.options.customMetadata) {
          this.customMetadata.set(key, { ...record.options.customMetadata });
        } else {
          this.customMetadata.delete(key);
        };
        this.etags.set(key, `fake-multipart-${uploadedParts.length}-${totalBytes}`);
        this.multipartUploads.delete(uploadId);
        const completed = this.object(key, false);
        if (this.nextMultipartCompleteReturnOmitsCustomMetadata) {
          this.nextMultipartCompleteReturnOmitsCustomMetadata = false;
          return { ...completed, customMetadata: void 0 };
        };
        return completed;
      }
    };
  }
  async createMultipartUpload(key, options = {}) {
    const uploadId = this.nextMultipartUploadId ?? `fake-mpu-${this.nextMultipartUpload++}`;
    this.nextMultipartUploadId = null;
    this.multipartUploads.set(uploadId, { key, options, parts: /* @__PURE__ */ new Map() });
    return this.multipartHandle(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    return this.multipartHandle(key, uploadId);
  }
  async delete(key) {
    this.data.delete(key);
    this.httpMetadata.delete(key);
    this.customMetadata.delete(key);
    this.etags.delete(key);
  }
};
function makeEnv(overrides = {}) {
  const { db, store } = makeDb();
  const r2 = new FakeR2();
  const env = {
    DB: db,
    COUNTERS: new FakeKV(),
    ARTIFACTS: r2,
    GITHUB_CLIENT_ID: "test",
    GITHUB_CLIENT_SECRET: "test",
    IP_HASH_PEPPER: "test-pepper",
    ENVIRONMENT: "test",
    CUPBOARD_HOST: "cupboard.test",
    CUPBOARD_OPERATOR_GITHUB_IDS: "",
    RATE_PER_USER_PUBLISH_HOURLY: "5",
    RATE_PER_USER_REPORT_HOURLY: "10",
    RATE_PER_IP_LIST_PER_MINUTE: "60",
    INDEXER_BATCH_SIZE: "100",
    ...overrides
  };
  return { env, store, r2 };
};
const STUB_HEAD_SHA = "a".repeat(40);
function stubTreeFor(listingRef, manifest = "listing.json") {
  return [
    { path: `${listingRef}/listing.json`, sha: "1".repeat(40), size: 120 },
    { path: `${listingRef}/${manifest === "listing.json" ? "README.md" : manifest}`, sha: "2".repeat(40), size: 64 }
  ];
};
function stubGithub(stub) {
  globalThis.fetch = (async (url, init) => {
    const u = url.toString();
    if (u.endsWith("/user")) {
      if (stub.user && "error" in stub.user) return new Response("", { status: stub.user.error });
      if (stub.user) return new Response(JSON.stringify(stub.user), { status: 200 });
      return new Response("", { status: 401 });
    };
    if (u.includes("/git/ref/heads/")) {
      if (stub.head && "error" in stub.head) return new Response("", { status: stub.head.error });
      if (stub.head) return new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: stub.head.sha } }), { status: 200 });
      return new Response("head not stubbed", { status: 500 });
    };
    if (u.includes("/git/trees/")) {
      if (stub.tree && "error" in stub.tree) return new Response("", { status: stub.tree.error });
      if (stub.tree) {
        const body = {
          sha: stub.head && !("error" in stub.head) ? stub.head.sha : STUB_HEAD_SHA,
          truncated: stub.tree.truncated === true,
          tree: stub.tree.entries.map((e) => ({
            path: e.path,
            mode: e.type === "tree" ? "040000" : e.type === "commit" ? "160000" : "100644",
            type: e.type ?? "blob",
            sha: e.sha,
            ...e.type == null || e.type === "blob" ? { size: e.size ?? 0 } : {}
          }))
        };
        return new Response(JSON.stringify(body), { status: 200 });
      };
      return new Response("tree not stubbed", { status: 500 });
    };
    if (u.includes("/git/blobs/")) {
      const sha = u.slice(u.lastIndexOf("/") + 1);
      const configured = stub.blobs?.[sha];
      if (configured && "error" in configured) return new Response("", { status: configured.error });
      if (configured) return new Response(JSON.stringify({ encoding: "base64", content: configured.content }), { status: 200 });
      return new Response(JSON.stringify({ encoding: "base64", content: btoa("{}") }), { status: 200 });
    };
    if (u.includes("/repos/")) {
      if (stub.repo && "error" in stub.repo) return new Response("", { status: stub.repo.error });
      if (stub.repo) return new Response(JSON.stringify(stub.repo), { status: 200 });
      return new Response("", { status: 404 });
    };
    void init;
    return new Response("not stubbed", { status: 500 });
  });
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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N0IsWUFBTSxNQUFNLEVBQUUsTUFBTSxFQUFFLFlBQVksR0FBRyxJQUFJLENBQUM7QUFDMUMsWUFBTSxhQUFhLEtBQUssUUFBUSxHQUFHO0FBQ25DLFVBQUksY0FBYyxXQUFXLFdBQVksUUFBTyxJQUFJLFNBQVMsSUFBSSxFQUFFLFFBQVEsV0FBVyxNQUFNLENBQUM7QUFDN0YsVUFBSSxXQUFZLFFBQU8sSUFBSSxTQUFTLEtBQUssVUFBVSxFQUFFLFVBQVUsVUFBVSxTQUFTLFdBQVcsUUFBUSxDQUFDLEdBQUcsRUFBRSxRQUFRLElBQUksQ0FBQztBQUd4SCxhQUFPLElBQUksU0FBUyxLQUFLLFVBQVUsRUFBRSxVQUFVLFVBQVUsU0FBUyxLQUFLLElBQUksRUFBRSxDQUFDLEdBQUcsRUFBRSxRQUFRLElBQUksQ0FBQztBQUFBLElBQ2xHO0FBQ0EsUUFBSSxFQUFFLFNBQVMsU0FBUyxHQUFHO0FBQ3pCLFVBQUksS0FBSyxRQUFRLFdBQVcsS0FBSyxLQUFNLFFBQU8sSUFBSSxTQUFTLElBQUksRUFBRSxRQUFRLEtBQUssS0FBSyxNQUFNLENBQUM7QUFDMUYsVUFBSSxLQUFLLEtBQU0sUUFBTyxJQUFJLFNBQVMsS0FBSyxVQUFVLEtBQUssSUFBSSxHQUFHLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFDN0UsYUFBTyxJQUFJLFNBQVMsSUFBSSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsSUFDekM7QUFDQSxTQUFLO0FBQ0wsV0FBTyxJQUFJLFNBQVMsZUFBZSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsRUFDcEQ7QUFDRiIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiZmFrZS1kMS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNoYXJlZCBpbi1tZW1vcnkgRDEgKyBLViArIEdpdEh1Yi1mZXRjaCBmYWtlcyBmb3IgdGhlIEN1cGJvYXJkIHdvcmtlciB0ZXN0cy5cbiAqXG4gKiBUaGUgc3RvcmUgaW50ZXJwcmV0cyB0aGUgZXhhY3QgU1FMIHRoZSBkYi50cyBoZWxwZXJzIGVtaXQg4oCUIGl0IGlzIG5vdCBhIHJlYWxcbiAqIFNRTCBlbmdpbmUsIGl0IHBhdHRlcm4tbWF0Y2hlcyB0aGUga25vd24gc3RhdGVtZW50cyBhbmQgY29uc3VtZXMgdGhlaXIgYmluZHNcbiAqIHBvc2l0aW9uYWxseS4gS2VlcCBpdCBpbiBzeW5jIHdpdGggZGIudHMgd2hlbiBzdGF0ZW1lbnRzIGNoYW5nZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEVudiB9IGZyb20gJy4uL2Vudi50cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUm93IHtcbiAgW2tleTogc3RyaW5nXTogdW5rbm93bjtcbn1cblxuY2xhc3MgRmFrZVN0bXQge1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHNxbDogc3RyaW5nLFxuICAgIHByaXZhdGUgc3RvcmU6IEZha2VTdG9yZSxcbiAgICBwcml2YXRlIGJpbmRzOiB1bmtub3duW10gPSBbXSxcbiAgKSB7fVxuICBiaW5kKC4uLnZhbHVlczogdW5rbm93bltdKTogRmFrZVN0bXQge1xuICAgIHJldHVybiBuZXcgRmFrZVN0bXQodGhpcy5zcWwsIHRoaXMuc3RvcmUsIHZhbHVlcyk7XG4gIH1cbiAgYXN5bmMgcnVuKCk6IFByb21pc2U8eyBzdWNjZXNzOiB0cnVlOyBtZXRhOiB7IGNoYW5nZXM6IG51bWJlciB9IH0+IHtcbiAgICBjb25zdCBjaGFuZ2VzID0gdGhpcy5zdG9yZS5leGVjdXRlKHRoaXMuc3FsLCB0aGlzLmJpbmRzKTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBtZXRhOiB7IGNoYW5nZXMgfSB9O1xuICB9XG4gIGFzeW5jIGZpcnN0PFQgPSBSb3c+KCk6IFByb21pc2U8VCB8IG51bGw+IHtcbiAgICBjb25zdCByb3dzID0gdGhpcy5zdG9yZS5xdWVyeSh0aGlzLnNxbCwgdGhpcy5iaW5kcyk7XG4gICAgcmV0dXJuIChyb3dzWzBdIGFzIFQpID8/IG51bGw7XG4gIH1cbiAgYXN5bmMgYWxsPFQgPSBSb3c+KCk6IFByb21pc2U8eyByZXN1bHRzOiBUW107IHN1Y2Nlc3M6IHRydWUgfT4ge1xuICAgIGNvbnN0IHJvd3MgPSB0aGlzLnN0b3JlLnF1ZXJ5KHRoaXMuc3FsLCB0aGlzLmJpbmRzKTtcbiAgICByZXR1cm4geyByZXN1bHRzOiByb3dzIGFzIFRbXSwgc3VjY2VzczogdHJ1ZSB9O1xuICB9XG59XG5cbi8qKiBBIGZ1bGx5LWRlZmF1bHRlZCBoYXJuZXNzL2xpc3Rpbmcgcm93OyBvdmVycmlkZSB3aGF0IGEgdGVzdCBjYXJlcyBhYm91dC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYWtlTGlzdGluZ1JvdyhvdmVyOiBQYXJ0aWFsPFJvdz4gPSB7fSk6IFJvdyB7XG4gIHJldHVybiB7XG4gICAgaWQ6ICdzZWVkJyxcbiAgICBsaXN0aW5nX2tpbmQ6ICdoYXJuZXNzJyxcbiAgICBwcm9qZWN0X3JlZjogbnVsbCxcbiAgICBsaXN0aW5nX3JlZjogbnVsbCxcbiAgICBnaXRodWJfcmVwb3NpdG9yeV9pZDogMSxcbiAgICBnaXRodWJfb3duZXI6ICdhJyxcbiAgICBnaXRodWJfbmFtZTogJ2InLFxuICAgIGdpdGh1Yl91cmw6ICdodHRwczovL2dpdGh1Yi5jb20vYS9iJyxcbiAgICB0aXRsZTogJ1QnLFxuICAgIGRlc2NyaXB0aW9uOiBudWxsLFxuICAgIHRvcGljX2hleDogJ2EnLnJlcGVhdCg2NCksXG4gICAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkOiAxLFxuICAgIHB1Ymxpc2hlcl9naXRodWJfbG9naW46ICdhbGljZScsXG4gICAgcHVibGlzaGVyX3Blcm1pc3Npb246IG51bGwsXG4gICAgcHVibGlzaGVyX2RldmljZV9wdWJrZXk6IG51bGwsXG4gICAgcHVibGlzaGVyX2F0dGVzdGF0aW9uX2dpc3RfaWQ6IG51bGwsXG4gICAgcHJvdmlkZXNfdG9vbHM6IG51bGwsXG4gICAgdXNlc190b29sczogbnVsbCwgICAgICAgIC8vIG1pZ3JhdGlvbiAwMzMgKHRvb2wgYXhpcyDigJQgY29uc3VtZXIgaGFsZiwgV0ktMTAwMDE3NDcpXG4gICAgcHJvdmlkZXNfZXZlbnRzOiBudWxsLCAgIC8vIG1pZ3JhdGlvbiAwMTIgKGV2ZW50IGRlcGVuZGVuY3kgYXhpcyDigJQgcHJvdmlkZXIgaGFsZilcbiAgICByZXF1aXJlc19ldmVudHM6IG51bGwsICAgLy8gbWlncmF0aW9uIDAxMyAoZXZlbnQgZGVwZW5kZW5jeSBheGlzIOKAlCBjb25zdW1lciBoYWxmKVxuICAgIHJlcXVpcmVzX3J1YnJpY3M6IG51bGwsICAvLyBtaWdyYXRpb24gMDE1IChydWJyaWMgZGVwZW5kZW5jeSBheGlzIOKAlCBjb25zdW1lciBoYWxmKVxuICAgIHByb3ZpZGVzX2l0ZW1fdHlwZXM6IG51bGwsICAvLyBtaWdyYXRpb24gMDQ5ICh0eXBlIHBhY2tzKVxuICAgIHByb3ZpZGVzX3BsYW5fdHlwZXM6IG51bGwsICAvLyBtaWdyYXRpb24gMDQ5ICh0eXBlIHBhY2tzKVxuICAgIHJlcXVpcmVzX3BsYW5fdHlwZTogbnVsbCwgICAvLyBtaWdyYXRpb24gMDQ5ICh0eXBlIHBhY2tzKVxuICAgIGhpdmVfcHVia2V5OiBudWxsLFxuICAgIGhpdmVfdGl0bGU6IG51bGwsXG4gICAgYmx1ZXByaW50X2tpbmQ6IG51bGwsXG4gICAgY2xhaW1fc3RhdHVzOiAndW5jbGFpbWVkJyxcbiAgICBjbGFpbWFudF9naXRodWJfdXNlcl9pZDogbnVsbCxcbiAgICBjbGFpbWFudF9naXRodWJfbG9naW46IG51bGwsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICBzdGFyczogMCxcbiAgICBjb250cmlidXRvcl9jb3VudDogMCxcbiAgICBsYXN0X2FjdGl2aXR5X2F0OiBudWxsLFxuICAgIGxhbmd1YWdlczogbnVsbCxcbiAgICBzdGF0c19yZWZyZXNoZWRfYXQ6IG51bGwsXG4gICAgY3JlYXRlZF9hdDogMSxcbiAgICB1cGRhdGVkX2F0OiAxLFxuICAgIHVubGlzdGVkX2F0OiBudWxsLFxuICAgIHVubGlzdGVkX3JlYXNvbjogbnVsbCxcbiAgICAvLyBtaWdyYXRpb24gMDA4IChrbm93bGVkZ2UtcGFja3MpOiBwcmUtcHVibGljYXRpb24gcmV2aWV3IGZpZWxkcy5cbiAgICByZXZpZXdfc3RhdHVzOiAnYXBwcm92ZWQnLFxuICAgIHJldmlld2VkX2F0OiBudWxsLFxuICAgIHJldmlld19yZWFzb246IG51bGwsXG4gICAgLy8gbWlncmF0aW9uIDAxNCAoY3VwYm9hcmQtYXBwLWRpc3RyaWJ1dGlvbik6IGFwcC1vbmx5IGRpc3RyaWJ1dGlvbiBjb2x1bW5zLlxuICAgIGRlbGl2ZXJ5X3R5cGU6IG51bGwsXG4gICAgbGF0ZXN0X2pzb25fdXJsOiBudWxsLFxuICAgIHJlbGVhc2VfcmVwbzogbnVsbCxcbiAgICBpY29uX3VybDogbnVsbCxcbiAgICBwbGF0Zm9ybXM6IG51bGwsXG4gICAgLy8gbWlncmF0aW9uIDAxOCAoc2hhcmVkLXBvdC1kYW8tY3VwYm9hcmQtdjEgUC0wMDgpOiBjYXRhbG9nIGF4ZXMuXG4gICAgLy8gYHZpc2liaWxpdHlgIG1pcnJvcnMgdGhlIGNvbHVtbidzIE5PVCBOVUxMIERFRkFVTFQgJ3B1YmxpYycsIHNvIGEgcm93IGFcbiAgICAvLyB0ZXN0IGRvZXMgbm90IG9wdCBpbnRvIHN0YXlzIGJyb3dzYWJsZSBleGFjdGx5IGFzIGl0IGRpZCBwcmUtMDE4LlxuICAgIHZpc2liaWxpdHk6ICdwdWJsaWMnLFxuICAgIHRlbmFudF9pZDogbnVsbCxcbiAgICBza3VfcmVmOiBudWxsLFxuICAgIHByaWNpbmdfbW9kZWw6IG51bGwsXG4gICAgcHJpY2VfYW1vdW50X21pY3JvczogbnVsbCxcbiAgICBwcmljZV9jdXJyZW5jeTogbnVsbCxcbiAgICBjb21wYXRpYmlsaXR5X2pzb246IG51bGwsXG4gICAgcmVxdWlyZWRfcGVybWlzc2lvbnM6IG51bGwsXG4gICAgcmVsZWFzZV92ZXJzaW9uOiBudWxsLFxuICAgIHJlbGVhc2VfY29udGVudF9oYXNoOiBudWxsLFxuICAgIHJlbGVhc2VfbWFuaWZlc3RfZGlnZXN0OiBudWxsLFxuICAgIHJlbGVhc2Vfc2lnbmF0dXJlOiBudWxsLFxuICAgIGlkZW50aXR5X3N1cmZhY2U6IG51bGwsXG4gICAgcmVsZWFzZV9wdWJsaXNoZWRfYXQ6IG51bGwsXG4gICAgcGlubmVkX2NvbW1pdF9zaGE6IG51bGwsXG4gICAgcGlubmVkX3RyZWVfZGlnZXN0OiBudWxsLFxuICAgIHBpbm5lZF9hdDogbnVsbCxcbiAgICBhcHByb3ZlZF9jb21taXRfc2hhOiBudWxsLFxuICAgIGFwcHJvdmVkX3RyZWVfZGlnZXN0OiBudWxsLFxuICAgIGFwcHJvdmVkX2F0OiBudWxsLFxuICAgIGF1dGhvcml0eV91bnJlc29sdmVkOiBudWxsLFxuICAgIGF1dGhvcml0eV91bnJlc29sdmVkX2NhdXNlOiBudWxsLFxuICAgIC8vIG1pZ3JhdGlvbiAwNDEgKFAtMDEwKTogdGhlIG9wdGlvbmFsIHByb3ZlbmFuY2UgYmFkZ2U7ICd3b3JrZXInIGlzIHRoZSBOT1QgTlVMTCBkZWZhdWx0LlxuICAgIHZlcmlmaWVkX2J5OiAnd29ya2VyJyxcbiAgICBkcmlmdDogMCxcbiAgICB5YW5rZWRfYXQ6IG51bGwsXG4gICAgeWFua2VkX3JlYXNvbjogbnVsbCxcbiAgICByZXZva2VkX2F0OiBudWxsLFxuICAgIHJldm9rZWRfcmVhc29uOiBudWxsLFxuICAgIC4uLm92ZXIsXG4gIH07XG59XG5cbi8qKlxuICogTWFwIGFuIGBJTlNFUlQgSU5UTyA8dGFibGU+IChjb2xz4oCmKSBWQUxVRVMgKOKApilgIHN0YXRlbWVudCdzIGJpbmRzIG9udG8gdGhlaXJcbiAqIENPTFVNTiBOQU1FUywgYnkgcmVhZGluZyB0aGUgY29sdW1uIGxpc3Qgb3V0IG9mIHRoZSBTUUwgaXRzZWxmLlxuICpcbiAqIFRoaXMgcmVwbGFjZXMgdGhlIHBvc2l0aW9uYWwgZGVzdHJ1Y3R1cmUgdGhpcyBmaWxlIHVzZWQgZnJvbSBtaWdyYXRpb24gMDA0IHRvXG4gKiAwMTcg4oCUIHRoZSBjb3VwbGluZyBgaW5zZXJ0LWJpbmQtYWxpZ25tZW50LnRlc3QudHNgIHdhcyB3cml0dGVuIHRvIGd1YXJkIGFmdGVyXG4gKiBtaWdyYXRpb24gMDE1IHNoaWZ0ZWQgZXZlcnkgZmllbGQgcGFzdCBwb3NpdGlvbiAyMCBhbmQgc2lsZW50bHkgZGlzYWJsZWQgdGhlXG4gKiBwdWJsaXNoIHJldmlldyBnYXRlIGluIGV2ZXJ5IHRlc3QgdGhhdCBleGVyY2lzZWQgaXQuIEFuIGFyaXR5IGd1YXJkIGNhdGNoZXMgYVxuICogbWlkLWxpc3QgSU5TRVJUSU9OIGJ1dCBub3QgYSBzYW1lLWFyaXR5IHJlb3JkZXIgb3IgcmVuYW1lLCBhbmQgaXQgb25seSBmaXJlc1xuICogb25jZSB0aGUgZGFtYWdlIGlzIGFscmVhZHkgd3JpdHRlbi4gUmVhZGluZyB0aGUgbmFtZXMgZnJvbSB0aGUgc3RhdGVtZW50XG4gKiByZW1vdmVzIHRoZSBjb3VwbGluZyBpbnN0ZWFkIG9mIHBvbGljaW5nIGl0OiBkYi50cyBjYW4gYWRkLCByZW9yZGVyLCBvciByZW5hbWVcbiAqIGEgY29sdW1uIGFuZCB0aGlzIGZha2UgZm9sbG93cyBhdXRvbWF0aWNhbGx5IChQLTAwOCAvIHRoZSBmb2xsb3ctdXAgZmlsZWQgaW5cbiAqIHRoYXQgdGVzdCdzIG93biBoZWFkZXIpLlxuICpcbiAqIFRoZSBWQUxVRVMgdHVwbGUgbWF5IGNvbnRhaW4gbGl0ZXJhbHMgYXMgd2VsbCBhcyBwbGFjZWhvbGRlcnMgKGluc2VydEhhcm5lc3NcbiAqIHdyaXRlcyBgJ3VuY2xhaW1lZCdgIGlubGluZSBmb3IgY2xhaW1fc3RhdHVzKSwgc28gdGhlIHdhbGsgY29uc3VtZXMgYSBiaW5kXG4gKiBvbmx5IGZvciBhIGA/YCBhbmQgdGFrZXMgdGhlIGxpdGVyYWwgb3RoZXJ3aXNlIOKAlCB3aGljaCBpcyB3aHkgYSBuYWl2ZVxuICogYGNvbHVtbnNbaV0gPSBiaW5kc1tpXWAgemlwIHdvdWxkIGJlIHdyb25nIGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXBJbnNlcnRCaW5kc0J5TmFtZShzcWw6IHN0cmluZywgYmluZHM6IHVua25vd25bXSk6IFJvdyB7XG4gIGNvbnN0IG1hdGNoID0gL0lOU0VSVFxccytJTlRPXFxzK1xcdytcXHMqXFwoKFteKV0qKVxcKVxccypWQUxVRVNcXHMqXFwoKFtcXHNcXFNdKj8pXFwpXFxzKiQvaS5leGVjKHNxbC50cmltKCkpO1xuICBpZiAoIW1hdGNoKSB0aHJvdyBuZXcgRXJyb3IoYGZha2UtZDE6IHVucGFyc2VhYmxlIElOU0VSVCBzdGF0ZW1lbnQ6ICR7c3FsLnNsaWNlKDAsIDEyMCl9YCk7XG4gIGNvbnN0IGNvbHVtbnMgPSBtYXRjaFsxXS5zcGxpdCgnLCcpLm1hcCgoYykgPT4gYy50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcbiAgY29uc3QgdmFsdWVzID0gbWF0Y2hbMl0uc3BsaXQoJywnKS5tYXAoKHYpID0+IHYudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG4gIGlmIChjb2x1bW5zLmxlbmd0aCAhPT0gdmFsdWVzLmxlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBmYWtlLWQxOiBJTlNFUlQgY29sdW1uL3ZhbHVlIGFyaXR5IG1pc21hdGNoICgke2NvbHVtbnMubGVuZ3RofSBjb2x1bW5zLCAke3ZhbHVlcy5sZW5ndGh9IHZhbHVlcylgLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgcm93OiBSb3cgPSB7fTtcbiAgbGV0IGJpbmRJbmRleCA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY29sdW1ucy5sZW5ndGg7IGkgKz0gMSkge1xuICAgIGNvbnN0IHZhbHVlID0gdmFsdWVzW2ldO1xuICAgIGlmICh2YWx1ZSA9PT0gJz8nKSB7XG4gICAgICBpZiAoYmluZEluZGV4ID49IGJpbmRzLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGZha2UtZDE6IElOU0VSVCBuZWVkcyBtb3JlIGJpbmRzIHRoYW4gc3VwcGxpZWQgKCR7YmluZHMubGVuZ3RofSlgKTtcbiAgICAgIH1cbiAgICAgIHJvd1tjb2x1bW5zW2ldXSA9IGJpbmRzW2JpbmRJbmRleCsrXTtcbiAgICB9IGVsc2UgaWYgKC9eJy4qJyQvLnRlc3QodmFsdWUpKSB7XG4gICAgICByb3dbY29sdW1uc1tpXV0gPSB2YWx1ZS5zbGljZSgxLCAtMSk7XG4gICAgfSBlbHNlIGlmICgvXk5VTEwkL2kudGVzdCh2YWx1ZSkpIHtcbiAgICAgIHJvd1tjb2x1bW5zW2ldXSA9IG51bGw7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJvd1tjb2x1bW5zW2ldXSA9IE51bWJlci5pc05hTihOdW1iZXIodmFsdWUpKSA/IHZhbHVlIDogTnVtYmVyKHZhbHVlKTtcbiAgICB9XG4gIH1cbiAgaWYgKGJpbmRJbmRleCAhPT0gYmluZHMubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGZha2UtZDE6IElOU0VSVCBjb25zdW1lZCAke2JpbmRJbmRleH0gb2YgJHtiaW5kcy5sZW5ndGh9IGJpbmRzIOKAlCBwbGFjZWhvbGRlci9iaW5kIG1pc21hdGNoYCxcbiAgICApO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbi8qKlxuICogQXBwbHkgdGhlIG1pZ3JhdGlvbi0wMTggY2F0YWxvZyBoYWxmIG9mIHRoZSBwdWJsaWMgbGlzdCBwcmVkaWNhdGVcbiAqIChgYXBwZW5kQ2F0YWxvZ1ByZWRpY2F0ZWAgaW4gZGIudHMpLCBjb25zdW1pbmcgaXRzIGJpbmRzIGluIHRoZSBTQU1FIG9yZGVyLlxuICpcbiAqIFJldHVybnMgdGhlIGZpbHRlcmVkIHJvd3MgYW5kIHRoZSBhZHZhbmNlZCBiaW5kIGluZGV4LCBiZWNhdXNlIHRoZSBzdW1tYXJ5IENURVxuICogcmVhZHMgb25lIG1vcmUgYmluZCAodGhlIG1hdGNoZWQga2luZCkgYWZ0ZXIgdGhpcyBibG9jay5cbiAqXG4gKiDimqAgVGhlIG5hcnJvd2luZyBgdGVuYW50X3JlZmAgYW5kIHRoZSB3aWRlbmluZyBgdGVuYW50X3Njb3BlYCBib3RoIGVtaXRcbiAqIGBoLnRlbmFudF9pZCA9ID9gLCBzbyB0aGV5IGFyZSB0b2xkIGFwYXJ0IGJ5IHRoZSBPUEVSQVRPUiB0aGF0IHByZWNlZGVzIHRoZW0g4oCUXG4gKiBgQU5EIGgudGVuYW50X2lkID0gP2AgZm9yIHRoZSBmaWx0ZXIsIGBPUiBoLnRlbmFudF9pZCA9ID9gIGluc2lkZSB0aGVcbiAqIHZpc2liaWxpdHktc2NvcGUgZGlzanVuY3Rpb24uIENvbmZ1c2luZyB0aGUgdHdvIGhlcmUgd291bGQgbWFrZSB0aGUgZmFrZSBhZ3JlZVxuICogd2l0aCBhIHRlbmFudCBsZWFrIGluc3RlYWQgb2YgY2F0Y2hpbmcgb25lLlxuICovXG5mdW5jdGlvbiBhcHBseUNhdGFsb2dQcmVkaWNhdGUoXG4gIHVwcGVyOiBzdHJpbmcsXG4gIGJpbmRzOiB1bmtub3duW10sXG4gIHN0YXJ0SW5kZXg6IG51bWJlcixcbiAgcm93czogUm93W10sXG4pOiB7IHJvd3M6IFJvd1tdOyBpbmRleDogbnVtYmVyIH0ge1xuICBsZXQgaSA9IHN0YXJ0SW5kZXg7XG4gIGxldCBvdXQgPSByb3dzO1xuICBpZiAodXBwZXIuaW5jbHVkZXMoJ0guVklTSUJJTElUWSA9ID8nKSkge1xuICAgIGNvbnN0IHZpc2liaWxpdHkgPSBiaW5kc1tpKytdO1xuICAgIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHIudmlzaWJpbGl0eSA9PT0gdmlzaWJpbGl0eSk7XG4gIH1cbiAgaWYgKHVwcGVyLmluY2x1ZGVzKCdBTkQgSC5URU5BTlRfSUQgPSA/JykpIHtcbiAgICBjb25zdCB0ZW5hbnQgPSBiaW5kc1tpKytdO1xuICAgIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHIudGVuYW50X2lkID09PSB0ZW5hbnQpO1xuICB9XG4gIGlmICh1cHBlci5pbmNsdWRlcygnSC5QUklDSU5HX01PREVMID0gPycpKSB7XG4gICAgY29uc3QgcHJpY2luZyA9IGJpbmRzW2krK107XG4gICAgb3V0ID0gb3V0LmZpbHRlcigocikgPT4gci5wcmljaW5nX21vZGVsID09PSBwcmljaW5nKTtcbiAgfVxuICBjb25zdCBwcmljZWQgPSAocjogUm93KSA9PlxuICAgIHIuc2t1X3JlZiAhPSBudWxsICYmIHIucHJpY2luZ19tb2RlbCAhPSBudWxsICYmIHIucHJpY2luZ19tb2RlbCAhPT0gJ2ZyZWUnO1xuICBpZiAodXBwZXIuaW5jbHVkZXMoXCJILlBSSUNJTkdfTU9ERUwgIT0gJ0ZSRUUnXCIpKSBvdXQgPSBvdXQuZmlsdGVyKHByaWNlZCk7XG4gIGVsc2UgaWYgKHVwcGVyLmluY2x1ZGVzKFwiSC5QUklDSU5HX01PREVMID0gJ0ZSRUUnXCIpKSBvdXQgPSBvdXQuZmlsdGVyKChyKSA9PiAhcHJpY2VkKHIpKTtcbiAgaWYgKHVwcGVyLmluY2x1ZGVzKCdKU09OX0VYVFJBQ1QoSC5DT01QQVRJQklMSVRZX0pTT04nKSkge1xuICAgIGNvbnN0IHJ1bnRpbWUgPSBiaW5kc1tpKytdO1xuICAgIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHBhcnNlSnNvbkZpZWxkKHIuY29tcGF0aWJpbGl0eV9qc29uKT8ucnVudGltZSA9PT0gcnVudGltZSk7XG4gIH1cbiAgaWYgKHVwcGVyLmluY2x1ZGVzKFwiSlNPTl9FQUNIKEguQ09NUEFUSUJJTElUWV9KU09OLCAnJC5QTEFURk9STVMnKVwiKSkge1xuICAgIGNvbnN0IHBsYXRmb3JtID0gYmluZHNbaSsrXTtcbiAgICBvdXQgPSBvdXQuZmlsdGVyKChyKSA9PiB7XG4gICAgICBjb25zdCBwbGF0Zm9ybXMgPSBwYXJzZUpzb25GaWVsZChyLmNvbXBhdGliaWxpdHlfanNvbik/LnBsYXRmb3JtcztcbiAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBsYXRmb3JtcykgJiYgcGxhdGZvcm1zLmluY2x1ZGVzKHBsYXRmb3JtKTtcbiAgICB9KTtcbiAgfVxuICBpZiAodXBwZXIuaW5jbHVkZXMoJ0pTT05fRUFDSChILlJFUVVJUkVEX1BFUk1JU1NJT05TKScpKSB7XG4gICAgY29uc3QgcGVybWlzc2lvbiA9IGJpbmRzW2krK107XG4gICAgb3V0ID0gb3V0LmZpbHRlcigocikgPT4ge1xuICAgICAgY29uc3QgcGVybXMgPSBwYXJzZUpzb25GaWVsZChyLnJlcXVpcmVkX3Blcm1pc3Npb25zKTtcbiAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBlcm1zKSAmJiBwZXJtcy5pbmNsdWRlcyhwZXJtaXNzaW9uKTtcbiAgICB9KTtcbiAgfVxuICBpZiAodXBwZXIuaW5jbHVkZXMoJ09SIEguVEVOQU5UX0lEID0gPycpKSB7XG4gICAgY29uc3Qgc2NvcGUgPSBiaW5kc1tpKytdO1xuICAgIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHIudmlzaWJpbGl0eSA9PT0gJ3B1YmxpYycgfHwgci50ZW5hbnRfaWQgPT09IHNjb3BlKTtcbiAgfSBlbHNlIGlmICh1cHBlci5pbmNsdWRlcyhcIkguVklTSUJJTElUWSA9ICdQVUJMSUMnXCIpKSB7XG4gICAgb3V0ID0gb3V0LmZpbHRlcigocikgPT4gci52aXNpYmlsaXR5ID09PSAncHVibGljJyk7XG4gIH1cbiAgaWYgKHVwcGVyLmluY2x1ZGVzKCdILllBTktFRF9BVCBJUyBOVUxMJykpIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHIueWFua2VkX2F0ID09IG51bGwpO1xuICBpZiAodXBwZXIuaW5jbHVkZXMoJ0guUkVWT0tFRF9BVCBJUyBOVUxMJykpIG91dCA9IG91dC5maWx0ZXIoKHIpID0+IHIucmV2b2tlZF9hdCA9PSBudWxsKTtcbiAgcmV0dXJuIHsgcm93czogb3V0LCBpbmRleDogaSB9O1xufVxuXG4vKiogVG9sZXJhbnQgSlNPTiBjb2x1bW4gcmVhZDogYSBtYWxmb3JtZWQgdmFsdWUgZmlsdGVycyBsaWtlIGFuIGFic2VudCBvbmUsXG4gKiAgbWF0Y2hpbmcgdGhlIGBqc29uX3ZhbGlkKClgIGd1YXJkIHRoZSByZWFsIHByZWRpY2F0ZSBjYXJyaWVzLiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbmZ1bmN0aW9uIHBhcnNlSnNvbkZpZWxkKHJhdzogdW5rbm93bik6IGFueSB7XG4gIGlmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcgPT09ICcnKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRmFrZVN0b3JlIHtcbiAgdGFibGVzOiBSZWNvcmQ8c3RyaW5nLCBSb3dbXT4gPSB7XG4gICAgaGFybmVzc2VzOiBbXSxcbiAgICBjcmVhdG9yX2RyYWZ0czogW10sXG4gICAgcmVwb3J0czogW10sXG4gICAgcHVibGlzaF9yYXRlX2xpbWl0OiBbXSxcbiAgICBpbmRleGVyX3J1bnM6IFtdLFxuICAgIGF1ZGl0OiBbXSxcbiAgICBiYW5uZWRfcHVibGlzaGVyX3B1YmtleXM6IFtdLFxuICB9O1xuXG4gIGV4ZWN1dGUoc3FsOiBzdHJpbmcsIGJpbmRzOiB1bmtub3duW10pOiBudW1iZXIge1xuICAgIGNvbnN0IHVwcGVyID0gc3FsLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICh1cHBlci5zdGFydHNXaXRoKCdJTlNFUlQgSU5UTyBDUkVBVE9SX0RSQUZUUycpKSB7XG4gICAgICBjb25zdCBbXG4gICAgICAgIGlkLCBvd25lcl9naXRodWJfdXNlcl9pZCwgb3duZXJfZ2l0aHViX2xvZ2luLCBsaXN0aW5nX2tpbmQsIGxpc3RpbmdfcmVmLFxuICAgICAgICB0aXRsZSwgZGVzY3JpcHRpb24sIG1hbmlmZXN0X2pzb24sIHByb3ZlbmFuY2VfanNvbiwgdXBsb2FkX3Rva2VuX2hhc2gsXG4gICAgICAgIHVwbG9hZF9leHBpcmVzX2F0LCBjcmVhdGVkX2F0LCB1cGRhdGVkX2F0LFxuICAgICAgXSA9IGJpbmRzO1xuICAgICAgdGhpcy50YWJsZXMuY3JlYXRvcl9kcmFmdHMucHVzaCh7XG4gICAgICAgIGlkLCBvd25lcl9naXRodWJfdXNlcl9pZCwgb3duZXJfZ2l0aHViX2xvZ2luLCBsaXN0aW5nX2tpbmQsIGxpc3RpbmdfcmVmLFxuICAgICAgICB0aXRsZSwgZGVzY3JpcHRpb24sIG1hbmlmZXN0X2pzb24sIHByb3ZlbmFuY2VfanNvbiwgc3RhdGU6ICdkcmFmdCcsXG4gICAgICAgIGFydGlmYWN0X2tleTogbnVsbCwgYXJ0aWZhY3RfY29udGVudF9oYXNoOiBudWxsLCBhcnRpZmFjdF9zaXplX2J5dGVzOiBudWxsLFxuICAgICAgICBhcnRpZmFjdF9jb250ZW50X3R5cGU6IG51bGwsIHVwbG9hZF90b2tlbl9oYXNoLCB1cGxvYWRfZXhwaXJlc19hdCxcbiAgICAgICAgcmV2aWV3ZWRfYXQ6IG51bGwsIHJldmlld2VkX2J5X2dpdGh1Yl91c2VyX2lkOiBudWxsLCByZXZpZXdfcmVhc29uOiBudWxsLFxuICAgICAgICBwdWJsaXNoZWRfbGlzdGluZ19pZDogbnVsbCwgY3JlYXRlZF9hdCwgdXBkYXRlZF9hdCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIGlmICh1cHBlci5zdGFydHNXaXRoKCdVUERBVEUgQ1JFQVRPUl9EUkFGVFMnKSAmJiB1cHBlci5pbmNsdWRlcygnU0VUIEFSVElGQUNUX0tFWScpKSB7XG4gICAgICBjb25zdCBbYXJ0aWZhY3Rfa2V5LCBhcnRpZmFjdF9oYXNoLCBhcnRpZmFjdF9zaXplLCBhcnRpZmFjdF90eXBlLCB1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmNyZWF0b3JfZHJhZnRzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkICYmIHIuc3RhdGUgPT09ICdkcmFmdCcpO1xuICAgICAgaWYgKCFyb3cpIHJldHVybiAwO1xuICAgICAgT2JqZWN0LmFzc2lnbihyb3csIHtcbiAgICAgICAgYXJ0aWZhY3Rfa2V5LFxuICAgICAgICBhcnRpZmFjdF9jb250ZW50X2hhc2g6IGFydGlmYWN0X2hhc2gsXG4gICAgICAgIGFydGlmYWN0X3NpemVfYnl0ZXM6IGFydGlmYWN0X3NpemUsXG4gICAgICAgIGFydGlmYWN0X2NvbnRlbnRfdHlwZTogYXJ0aWZhY3RfdHlwZSxcbiAgICAgICAgdXBsb2FkX3Rva2VuX2hhc2g6IG51bGwsXG4gICAgICAgIHVwbG9hZF9leHBpcmVzX2F0OiBudWxsLFxuICAgICAgICB1cGRhdGVkX2F0LFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1VQREFURSBDUkVBVE9SX0RSQUZUUycpICYmIHVwcGVyLmluY2x1ZGVzKCdTRVQgU1RBVEUnKSkge1xuICAgICAgY29uc3QgW3N0YXRlLCByZXZpZXdlZF9hdCwgcmV2aWV3ZWRfYnksIHJldmlld19yZWFzb24sIHB1Ymxpc2hlZF9saXN0aW5nX2lkLCB1cGRhdGVkX2F0LCBpZCwgZnJvbV0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmNyZWF0b3JfZHJhZnRzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkICYmIHIuc3RhdGUgPT09IGZyb20pO1xuICAgICAgaWYgKCFyb3cpIHJldHVybiAwO1xuICAgICAgcm93LnN0YXRlID0gc3RhdGU7XG4gICAgICBpZiAocmV2aWV3ZWRfYXQgIT0gbnVsbCkgcm93LnJldmlld2VkX2F0ID0gcmV2aWV3ZWRfYXQ7XG4gICAgICBpZiAocmV2aWV3ZWRfYnkgIT0gbnVsbCkgcm93LnJldmlld2VkX2J5X2dpdGh1Yl91c2VyX2lkID0gcmV2aWV3ZWRfYnk7XG4gICAgICBpZiAocmV2aWV3X3JlYXNvbiAhPSBudWxsKSByb3cucmV2aWV3X3JlYXNvbiA9IHJldmlld19yZWFzb247XG4gICAgICBpZiAocHVibGlzaGVkX2xpc3RpbmdfaWQgIT0gbnVsbCkgcm93LnB1Ymxpc2hlZF9saXN0aW5nX2lkID0gcHVibGlzaGVkX2xpc3RpbmdfaWQ7XG4gICAgICByb3cudXBkYXRlZF9hdCA9IHVwZGF0ZWRfYXQ7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ0lOU0VSVCBJTlRPIEhBUk5FU1NFUycpKSB7XG4gICAgICAvLyBCWSBOQU1FLCBub3QgYnkgcG9zaXRpb246IHRoZSBjb2x1bW4gbGlzdCBpcyByZWFkIG91dCBvZiB0aGUgc3RhdGVtZW50XG4gICAgICAvLyBpdHNlbGYgKHNlZSBtYXBJbnNlcnRCaW5kc0J5TmFtZSkuIGRiLnRzIG1heSBhZGQsIHJlb3JkZXIsIG9yIHJlbmFtZSBhXG4gICAgICAvLyBjb2x1bW4gaW4gaW5zZXJ0SGFybmVzcygpIGFuZCB0aGlzIGZha2UgZm9sbG93cyDigJQgdGhlIHNpbGVudCBmaWVsZC1zaGlmdFxuICAgICAgLy8gY2xhc3MgdGhhdCBtaWdyYXRpb24gMDE1IGhpdCBpcyBzdHJ1Y3R1cmFsbHkgZ29uZSwgbm90IG1lcmVseSBndWFyZGVkLlxuICAgICAgY29uc3Qgd3JpdHRlbiA9IG1hcEluc2VydEJpbmRzQnlOYW1lKHNxbCwgYmluZHMpO1xuICAgICAgdGhpcy50YWJsZXMuaGFybmVzc2VzLnB1c2goXG4gICAgICAgIG1ha2VMaXN0aW5nUm93KHtcbiAgICAgICAgICAuLi53cml0dGVuLFxuICAgICAgICAgIC8vIENvbHVtbiBkZWZhdWx0cyB0aGUgSU5TRVJUIGxlYXZlcyB0byB0aGUgc2NoZW1hLlxuICAgICAgICAgIGxpc3Rpbmdfa2luZDogd3JpdHRlbi5saXN0aW5nX2tpbmQgPz8gJ2hhcm5lc3MnLFxuICAgICAgICAgIHJldmlld19zdGF0dXM6IHdyaXR0ZW4ucmV2aWV3X3N0YXR1cyA/PyAnYXBwcm92ZWQnLFxuICAgICAgICAgIHZpc2liaWxpdHk6IHdyaXR0ZW4udmlzaWJpbGl0eSA/PyAncHVibGljJyxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIC8vIHNldFJldmlld1N0YXR1cyAobWlncmF0aW9uIDAwOCAvIGtub3dsZWRnZS1wYWNrcyBQLTAxOSkuXG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1VQREFURSBIQVJORVNTRVMnKSAmJiB1cHBlci5pbmNsdWRlcygnU0VUIFJFVklFV19TVEFUVVMnKSkge1xuICAgICAgY29uc3QgW3Jldmlld19zdGF0dXMsIHJldmlld2VkX2F0LCByZXZpZXdfcmVhc29uLCB1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICBpZiAocm93KSB7XG4gICAgICAgIHJvdy5yZXZpZXdfc3RhdHVzID0gcmV2aWV3X3N0YXR1cztcbiAgICAgICAgcm93LnJldmlld2VkX2F0ID0gcmV2aWV3ZWRfYXQ7XG4gICAgICAgIHJvdy5yZXZpZXdfcmVhc29uID0gcmV2aWV3X3JlYXNvbjtcbiAgICAgICAgcm93LnVwZGF0ZWRfYXQgPSB1cGRhdGVkX2F0O1xuICAgICAgICByZXR1cm4gMTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnVVBEQVRFIEhBUk5FU1NFUycpICYmIHVwcGVyLmluY2x1ZGVzKFwiQ0xBSU1fU1RBVFVTID0gJ1NVUEVSU0VERUQnXCIpKSB7XG4gICAgICBjb25zdCBbc3VjY2Vzc29yLCB1bmxpc3RlZF9hdCwgcmVhc29uLCB1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCAmJiByLnVubGlzdGVkX2F0ID09IG51bGwpO1xuICAgICAgaWYgKCFyb3cpIHJldHVybiAwO1xuICAgICAgT2JqZWN0LmFzc2lnbihyb3csIHtcbiAgICAgICAgc3VwZXJzZWRlZF9ieTogc3VjY2Vzc29yLFxuICAgICAgICBjbGFpbV9zdGF0dXM6ICdzdXBlcnNlZGVkJyxcbiAgICAgICAgdW5saXN0ZWRfYXQsXG4gICAgICAgIHVubGlzdGVkX3JlYXNvbjogcmVhc29uLFxuICAgICAgICB1cGRhdGVkX2F0LFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1VQREFURSBIQVJORVNTRVMnKSAmJiB1cHBlci5pbmNsdWRlcygnU0VUIFVOTElTVEVEX0FUJykpIHtcbiAgICAgIGNvbnN0IFt1bmxpc3RlZF9hdCwgdW5saXN0ZWRfcmVhc29uLCB1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICBpZiAocm93KSB7XG4gICAgICAgIHJvdy51bmxpc3RlZF9hdCA9IHVubGlzdGVkX2F0O1xuICAgICAgICByb3cudW5saXN0ZWRfcmVhc29uID0gdW5saXN0ZWRfcmVhc29uO1xuICAgICAgICByb3cudXBkYXRlZF9hdCA9IHVwZGF0ZWRfYXQ7XG4gICAgICAgIHJldHVybiAxO1xuICAgICAgfVxuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmICh1cHBlci5pbmNsdWRlcyhcIkNMQUlNX1NUQVRVUyA9ICdDTEFJTUVEJ1wiKSkge1xuICAgICAgY29uc3QgW2NsYWltYW50X3VzZXJfaWQsIGNsYWltYW50X2xvZ2luLCB1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICBpZiAocm93KSB7XG4gICAgICAgIHJvdy5jbGFpbV9zdGF0dXMgPSAnY2xhaW1lZCc7XG4gICAgICAgIHJvdy5jbGFpbWFudF9naXRodWJfdXNlcl9pZCA9IGNsYWltYW50X3VzZXJfaWQ7XG4gICAgICAgIHJvdy5jbGFpbWFudF9naXRodWJfbG9naW4gPSBjbGFpbWFudF9sb2dpbjtcbiAgICAgICAgcm93LnVwZGF0ZWRfYXQgPSB1cGRhdGVkX2F0O1xuICAgICAgICByZXR1cm4gMTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnVVBEQVRFIEhBUk5FU1NFUycpICYmIHVwcGVyLmluY2x1ZGVzKCdTRVQgU1RBUlMnKSkge1xuICAgICAgY29uc3QgW3N0YXJzLCBjb250cmlidXRvcl9jb3VudCwgbGFzdF9hY3Rpdml0eV9hdCwgbGFuZ3VhZ2VzLCByZWZyZXNoZWQsIHVwZGF0ZWRfYXQsIGlkXSA9IGJpbmRzO1xuICAgICAgY29uc3Qgcm93ID0gdGhpcy50YWJsZXMuaGFybmVzc2VzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkKTtcbiAgICAgIGlmIChyb3cpIHtcbiAgICAgICAgcm93LnN0YXJzID0gc3RhcnM7XG4gICAgICAgIHJvdy5jb250cmlidXRvcl9jb3VudCA9IGNvbnRyaWJ1dG9yX2NvdW50O1xuICAgICAgICByb3cubGFzdF9hY3Rpdml0eV9hdCA9IGxhc3RfYWN0aXZpdHlfYXQ7XG4gICAgICAgIHJvdy5sYW5ndWFnZXMgPSBsYW5ndWFnZXM7XG4gICAgICAgIHJvdy5zdGF0c19yZWZyZXNoZWRfYXQgPSByZWZyZXNoZWQ7XG4gICAgICAgIHJvdy51cGRhdGVkX2F0ID0gdXBkYXRlZF9hdDtcbiAgICAgICAgcmV0dXJuIDE7XG4gICAgICB9XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1VQREFURSBIQVJORVNTRVMnKSAmJiB1cHBlci5pbmNsdWRlcygnUFVCTElTSEVSX0RFVklDRV9QVUJLRVkgPSBOVUxMJykpIHtcbiAgICAgIGNvbnN0IFt1cGRhdGVkX2F0LCBpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICBpZiAocm93KSB7XG4gICAgICAgIHJvdy5wdWJsaXNoZXJfZGV2aWNlX3B1YmtleSA9IG51bGw7XG4gICAgICAgIHJvdy5wdWJsaXNoZXJfYXR0ZXN0YXRpb25fZ2lzdF9pZCA9IG51bGw7XG4gICAgICAgIHJvdy51cGRhdGVkX2F0ID0gdXBkYXRlZF9hdDtcbiAgICAgICAgcmV0dXJuIDE7XG4gICAgICB9XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ0lOU0VSVCBJTlRPIFJFUE9SVFMnKSkge1xuICAgICAgY29uc3QgW2lkLCBoYXJuZXNzX2lkLCByZXBvcnRlcl91c2VyX2lkLCByZXBvcnRlcl9sb2dpbiwgcmVhc29uLCBpcF9oYXNoLCBjcmVhdGVkX2F0XSA9IGJpbmRzO1xuICAgICAgdGhpcy50YWJsZXMucmVwb3J0cy5wdXNoKHtcbiAgICAgICAgaWQsIGhhcm5lc3NfaWQsIHJlcG9ydGVyX2dpdGh1Yl91c2VyX2lkOiByZXBvcnRlcl91c2VyX2lkLFxuICAgICAgICByZXBvcnRlcl9naXRodWJfbG9naW46IHJlcG9ydGVyX2xvZ2luLCByZWFzb24sIGlwX2hhc2gsXG4gICAgICAgIHN0YXR1czogJ3BlbmRpbmcnLCByZXNvbHZlZF9hdDogbnVsbCxcbiAgICAgICAgcmVzb2x2ZWRfYnlfb3BlcmF0b3Jfbm90ZTogbnVsbCwgY3JlYXRlZF9hdCxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIGlmICh1cHBlci5zdGFydHNXaXRoKCdVUERBVEUgUkVQT1JUUycpKSB7XG4gICAgICBjb25zdCBbc3RhdHVzLCByZXNvbHZlZF9hdCwgbm90ZSwgaWRdID0gYmluZHM7XG4gICAgICBjb25zdCByb3cgPSB0aGlzLnRhYmxlcy5yZXBvcnRzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkICYmIHIuc3RhdHVzID09PSAncGVuZGluZycpO1xuICAgICAgaWYgKHJvdykge1xuICAgICAgICByb3cuc3RhdHVzID0gc3RhdHVzO1xuICAgICAgICByb3cucmVzb2x2ZWRfYXQgPSByZXNvbHZlZF9hdDtcbiAgICAgICAgcm93LnJlc29sdmVkX2J5X29wZXJhdG9yX25vdGUgPSBub3RlO1xuICAgICAgICByZXR1cm4gMTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnSU5TRVJUIElOVE8gUFVCTElTSF9SQVRFX0xJTUlUJykpIHtcbiAgICAgIGNvbnN0IFt1c2VyX2lkLCB3aW5kb3dfc3RhcnRdID0gYmluZHM7XG4gICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMudGFibGVzLnB1Ymxpc2hfcmF0ZV9saW1pdC5maW5kKFxuICAgICAgICAocikgPT4gci5naXRodWJfdXNlcl9pZCA9PT0gdXNlcl9pZCAmJiByLndpbmRvd19zdGFydCA9PT0gd2luZG93X3N0YXJ0LFxuICAgICAgKTtcbiAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICBleGlzdGluZy5jb3VudCA9IChleGlzdGluZy5jb3VudCBhcyBudW1iZXIpICsgMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMudGFibGVzLnB1Ymxpc2hfcmF0ZV9saW1pdC5wdXNoKHsgZ2l0aHViX3VzZXJfaWQ6IHVzZXJfaWQsIHdpbmRvd19zdGFydCwgY291bnQ6IDEgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ0lOU0VSVCBJTlRPIEFVRElUJykpIHtcbiAgICAgIGNvbnN0IFt0cywga2luZCwgZGV0YWlsXSA9IGJpbmRzO1xuICAgICAgdGhpcy50YWJsZXMuYXVkaXQucHVzaCh7IHRzLCBraW5kLCBkZXRhaWwgfSk7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ0lOU0VSVCBJTlRPIEJBTk5FRF9QVUJMSVNIRVJfUFVCS0VZUycpKSB7XG4gICAgICBjb25zdCBbcHVia2V5LCByZWFzb24sIGFkZGVkX2F0LCBvcF9pZCwgdXBkYXRlZF9hdF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy50YWJsZXMuYmFubmVkX3B1Ymxpc2hlcl9wdWJrZXlzLmZpbmQoKHIpID0+IHIucHVia2V5ID09PSBwdWJrZXkpO1xuICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgIGV4aXN0aW5nLnJlYXNvbiA9IHJlYXNvbjtcbiAgICAgICAgZXhpc3RpbmcudXBkYXRlZF9hdCA9IHVwZGF0ZWRfYXQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLnRhYmxlcy5iYW5uZWRfcHVibGlzaGVyX3B1YmtleXMucHVzaCh7XG4gICAgICAgICAgcHVia2V5LCByZWFzb24sIGFkZGVkX2F0LCBhZGRlZF9ieV9vcGVyYXRvcl91c2VyX2lkOiBvcF9pZCA/PyBudWxsLCB1cGRhdGVkX2F0LFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiAxO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnREVMRVRFIEZST00gQkFOTkVEX1BVQkxJU0hFUl9QVUJLRVlTJykpIHtcbiAgICAgIGNvbnN0IFtwdWJrZXldID0gYmluZHM7XG4gICAgICBjb25zdCBiZWZvcmUgPSB0aGlzLnRhYmxlcy5iYW5uZWRfcHVibGlzaGVyX3B1YmtleXMubGVuZ3RoO1xuICAgICAgdGhpcy50YWJsZXMuYmFubmVkX3B1Ymxpc2hlcl9wdWJrZXlzID0gdGhpcy50YWJsZXMuYmFubmVkX3B1Ymxpc2hlcl9wdWJrZXlzLmZpbHRlcihcbiAgICAgICAgKHIpID0+IHIucHVia2V5ICE9PSBwdWJrZXksXG4gICAgICApO1xuICAgICAgcmV0dXJuIGJlZm9yZSAtIHRoaXMudGFibGVzLmJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cy5sZW5ndGg7XG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG5cbiAgcXVlcnkoc3FsOiBzdHJpbmcsIGJpbmRzOiB1bmtub3duW10pOiBSb3dbXSB7XG4gICAgY29uc3QgdXBwZXIgPSBzcWwudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1NFTEVDVCAqIEZST00gQ1JFQVRPUl9EUkFGVFMgV0hFUkUgSUQgPScpKSB7XG4gICAgICBjb25zdCBbaWRdID0gYmluZHM7XG4gICAgICBjb25zdCByb3cgPSB0aGlzLnRhYmxlcy5jcmVhdG9yX2RyYWZ0cy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICByZXR1cm4gcm93ID8gW3Jvd10gOiBbXTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1NFTEVDVCAqIEZST00gQ1JFQVRPUl9EUkFGVFMnKSkge1xuICAgICAgbGV0IGkgPSAwO1xuICAgICAgY29uc3Qgb3duZXIgPSB1cHBlci5pbmNsdWRlcygnT1dORVJfR0lUSFVCX1VTRVJfSUQgPSA/JykgPyBiaW5kc1tpKytdIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3Qgc3RhdGUgPSB1cHBlci5pbmNsdWRlcygnU1RBVEUgPSA/JykgPyBiaW5kc1tpKytdIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgaGFzT2Zmc2V0ID0gdXBwZXIuaW5jbHVkZXMoJ09GRlNFVCA/Jyk7XG4gICAgICBjb25zdCBsaW1pdCA9IGJpbmRzW2JpbmRzLmxlbmd0aCAtIChoYXNPZmZzZXQgPyAyIDogMSldIGFzIG51bWJlcjtcbiAgICAgIGNvbnN0IG9mZnNldCA9IGhhc09mZnNldCA/IGJpbmRzW2JpbmRzLmxlbmd0aCAtIDFdIGFzIG51bWJlciA6IDA7XG4gICAgICByZXR1cm4gdGhpcy50YWJsZXMuY3JlYXRvcl9kcmFmdHNcbiAgICAgICAgLmZpbHRlcigocikgPT4gb3duZXIgPT0gbnVsbCB8fCByLm93bmVyX2dpdGh1Yl91c2VyX2lkID09PSBvd25lcilcbiAgICAgICAgLmZpbHRlcigocikgPT4gc3RhdGUgPT0gbnVsbCB8fCByLnN0YXRlID09PSBzdGF0ZSlcbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IChiLnVwZGF0ZWRfYXQgYXMgbnVtYmVyKSAtIChhLnVwZGF0ZWRfYXQgYXMgbnVtYmVyKSB8fCBTdHJpbmcoYS5pZCkubG9jYWxlQ29tcGFyZShTdHJpbmcoYi5pZCkpKVxuICAgICAgICAuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyBsaW1pdCk7XG4gICAgfVxuICAgIGlmICh1cHBlci5zdGFydHNXaXRoKCdTRUxFQ1QgKiBGUk9NIEhBUk5FU1NFUyBXSEVSRSBJRCA9JykpIHtcbiAgICAgIGNvbnN0IFtpZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICByZXR1cm4gcm93ID8gW3Jvd10gOiBbXTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1NFTEVDVCAqIEZST00gSEFSTkVTU0VTJykgJiYgdXBwZXIuaW5jbHVkZXMoJ1BVQkxJU0hFUl9HSVRIVUJfVVNFUl9JRCA9ID8nKSkge1xuICAgICAgY29uc3QgW3B1Ymxpc2hlcklkXSA9IGJpbmRzO1xuICAgICAgY29uc3QgbGltaXQgPSBiaW5kc1sxXSBhcyBudW1iZXI7XG4gICAgICBjb25zdCBvZmZzZXQgPSBiaW5kc1syXSBhcyBudW1iZXI7XG4gICAgICByZXR1cm4gdGhpcy50YWJsZXMuaGFybmVzc2VzXG4gICAgICAgIC5maWx0ZXIoKHIpID0+IHIucHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkID09PSBwdWJsaXNoZXJJZClcbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IChiLnVwZGF0ZWRfYXQgYXMgbnVtYmVyKSAtIChhLnVwZGF0ZWRfYXQgYXMgbnVtYmVyKSB8fCBTdHJpbmcoYS5pZCkubG9jYWxlQ29tcGFyZShTdHJpbmcoYi5pZCkpKVxuICAgICAgICAuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyBsaW1pdCk7XG4gICAgfVxuICAgIC8vIGdldEFjdGl2ZUxpc3RpbmdCeVJlZnM6IHJlcG8gKyBraW5kICsgbGlzdGluZ19yZWYgKG11c3QgcHJlY2VkZSB0aGVcbiAgICAvLyBoYXJuZXNzLXJlcG8gYnJhbmNoIHNpbmNlIGJvdGggc3RhcnQgd2l0aCBHSVRIVUJfUkVQT1NJVE9SWV9JRCkuXG4gICAgaWYgKHVwcGVyLmluY2x1ZGVzKCdBTkQgTElTVElOR19SRUYgPScpKSB7XG4gICAgICBjb25zdCBbcmVwb0lkLCBraW5kLCByZWYsIHBpbl0gPSBiaW5kcztcbiAgICAgIGNvbnN0IHJvdyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maW5kKFxuICAgICAgICAocikgPT5cbiAgICAgICAgICByLmdpdGh1Yl9yZXBvc2l0b3J5X2lkID09PSByZXBvSWQgJiZcbiAgICAgICAgICByLmxpc3Rpbmdfa2luZCA9PT0ga2luZCAmJlxuICAgICAgICAgIHIubGlzdGluZ19yZWYgPT09IHJlZiAmJlxuICAgICAgICAgIHIudW5saXN0ZWRfYXQgPT0gbnVsbCAmJlxuICAgICAgICAgICghdXBwZXIuaW5jbHVkZXMoJ1BJTk5FRF9DT01NSVRfU0hBJykgfHxcbiAgICAgICAgICAgICh1cHBlci5pbmNsdWRlcygnUElOTkVEX0NPTU1JVF9TSEEgSVMgTlVMTCcpID8gci5waW5uZWRfY29tbWl0X3NoYSA9PSBudWxsIDogci5waW5uZWRfY29tbWl0X3NoYSA9PT0gcGluKSksXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJvdyA/IFtyb3ddIDogW107XG4gICAgfVxuICAgIC8vIGdldEhhcm5lc3NCeUdpdGh1YlJlcG9JZDogcmVwbywga2luZD0naGFybmVzcycsIGFjdGl2ZS1maXJzdC5cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnU0VMRUNUICogRlJPTSBIQVJORVNTRVMnKSAmJiB1cHBlci5pbmNsdWRlcyhcIkxJU1RJTkdfS0lORCA9ICdIQVJORVNTJ1wiKSkge1xuICAgICAgY29uc3QgW3JlcG9JZF0gPSBiaW5kcztcbiAgICAgIGNvbnN0IG1hdGNoZXMgPSB0aGlzLnRhYmxlcy5oYXJuZXNzZXNcbiAgICAgICAgLmZpbHRlcigocikgPT4gci5naXRodWJfcmVwb3NpdG9yeV9pZCA9PT0gcmVwb0lkICYmIHIubGlzdGluZ19raW5kID09PSAnaGFybmVzcycpXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiAoYS51bmxpc3RlZF9hdCA9PSBudWxsID8gMCA6IDEpIC0gKGIudW5saXN0ZWRfYXQgPT0gbnVsbCA/IDAgOiAxKSk7XG4gICAgICByZXR1cm4gbWF0Y2hlcy5sZW5ndGggPyBbbWF0Y2hlc1swXV0gOiBbXTtcbiAgICB9XG4gICAgLy8gbGlzdFBlbmRpbmdSZXZpZXcgKG1pZ3JhdGlvbiAwMDgpOiB0aGUgb3BlcmF0b3IncyBwZW5kaW5nIHF1ZXVlLiBNdXN0XG4gICAgLy8gcHJlY2VkZSB0aGUgZ2VuZXJpYyBsaXN0IG1hdGNoZXIgKGJvdGggaGl0IFVOTElTVEVEX0FUIElTIE5VTEwpLlxuICAgIGlmICh1cHBlci5pbmNsdWRlcyhcIlJFVklFV19TVEFUVVMgPSAnUEVORElORydcIikpIHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gYmluZHNbYmluZHMubGVuZ3RoIC0gMV0gYXMgbnVtYmVyO1xuICAgICAgcmV0dXJuIHRoaXMudGFibGVzLmhhcm5lc3Nlc1xuICAgICAgICAuZmlsdGVyKChyKSA9PiByLnJldmlld19zdGF0dXMgPT09ICdwZW5kaW5nJyAmJiByLnVubGlzdGVkX2F0ID09IG51bGwpXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiAoYS5jcmVhdGVkX2F0IGFzIG51bWJlcikgLSAoYi5jcmVhdGVkX2F0IGFzIG51bWJlcikpXG4gICAgICAgIC5zbGljZSgwLCBsaW1pdCk7XG4gICAgfVxuICAgIC8vIHN1bW1hcml6ZVB1YmxpY0hhcm5lc3Nlczogb25lIENURSBzdXBwbGllcyBleGFjdCBtYXRjaGVkIHRvdGFsICsga2luZCBmYWNldHMuXG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1dJVEggUE9QVUxBVElPTiBBUycpKSB7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBjb25zdCBoYXNQcm9qZWN0ID0gdXBwZXIuaW5jbHVkZXMoJ0guUFJPSkVDVF9SRUYgPSA/Jyk7XG4gICAgICBjb25zdCBwcm9qZWN0ID0gaGFzUHJvamVjdCA/IGJpbmRzW2krK10gOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBoYXNTZWFyY2ggPSB1cHBlci5pbmNsdWRlcygnSC5USVRMRSBMSUtFID8nKTtcbiAgICAgIGNvbnN0IHNlYXJjaCA9IGhhc1NlYXJjaCA/IFN0cmluZyhiaW5kc1tpKytdID8/ICcnKS5yZXBsYWNlQWxsKCclJywgJycpLnRvTG93ZXJDYXNlKCkgOiAnJztcbiAgICAgIGlmIChoYXNTZWFyY2gpIGkgKz0gMztcbiAgICAgIGNvbnN0IGhhc0NsYWltID0gdXBwZXIuaW5jbHVkZXMoJ0guQ0xBSU1fU1RBVFVTID0gPycpO1xuICAgICAgY29uc3QgY2xhaW0gPSBoYXNDbGFpbSA/IGJpbmRzW2krK10gOiB1bmRlZmluZWQ7XG4gICAgICBsZXQgcm93cyA9IHRoaXMudGFibGVzLmhhcm5lc3Nlcy5maWx0ZXIoKHIpID0+IHIudW5saXN0ZWRfYXQgPT0gbnVsbCk7XG4gICAgICBpZiAodXBwZXIuaW5jbHVkZXMoXCJSRVZJRVdfU1RBVFVTID0gJ0FQUFJPVkVEJ1wiKSkge1xuICAgICAgICByb3dzID0gcm93cy5maWx0ZXIoKHIpID0+IHIucmV2aWV3X3N0YXR1cyA9PT0gJ2FwcHJvdmVkJyk7XG4gICAgICB9XG4gICAgICBpZiAodXBwZXIuaW5jbHVkZXMoJ05PVCBFWElTVFMgKFNFTEVDVCAxIEZST00gQkFOTkVEX1BVQkxJU0hFUl9QVUJLRVlTJykpIHtcbiAgICAgICAgY29uc3QgYmFubmVkID0gbmV3IFNldCh0aGlzLnRhYmxlcy5iYW5uZWRfcHVibGlzaGVyX3B1YmtleXMubWFwKChyKSA9PiByLnB1YmtleSkpO1xuICAgICAgICByb3dzID0gcm93cy5maWx0ZXIoKHIpID0+ICFyLnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5IHx8ICFiYW5uZWQuaGFzKHIucHVibGlzaGVyX2RldmljZV9wdWJrZXkpKTtcbiAgICAgIH1cbiAgICAgIGlmIChoYXNQcm9qZWN0KSByb3dzID0gcm93cy5maWx0ZXIoKHIpID0+IHIucHJvamVjdF9yZWYgPT09IHByb2plY3QpO1xuICAgICAgaWYgKGhhc0NsYWltKSByb3dzID0gcm93cy5maWx0ZXIoKHIpID0+IHIuY2xhaW1fc3RhdHVzID09PSBjbGFpbSk7XG4gICAgICBpZiAoaGFzU2VhcmNoKSB7XG4gICAgICAgIHJvd3MgPSByb3dzLmZpbHRlcigocikgPT5cbiAgICAgICAgICBbci50aXRsZSwgci5kZXNjcmlwdGlvbiwgci5naXRodWJfb3duZXIsIHIuZ2l0aHViX25hbWVdXG4gICAgICAgICAgICAuc29tZSgodmFsdWUpID0+IFN0cmluZyh2YWx1ZSA/PyAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpKSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIENhdGFsb2cgZmlsdGVycyBiaW5kIEFGVEVSIGNsYWltIGFuZCBCRUZPUkUgdGhlIG1hdGNoZWQta2luZCBiaW5kLlxuICAgICAgKHsgcm93cywgaW5kZXg6IGkgfSA9IGFwcGx5Q2F0YWxvZ1ByZWRpY2F0ZSh1cHBlciwgYmluZHMsIGksIHJvd3MpKTtcbiAgICAgIGNvbnN0IGhhc01hdGNoZWRLaW5kID0gdXBwZXIuaW5jbHVkZXMoJ0ZST00gUE9QVUxBVElPTiBXSEVSRSBMSVNUSU5HX0tJTkQgPSA/Jyk7XG4gICAgICBjb25zdCBtYXRjaGVkS2luZCA9IGhhc01hdGNoZWRLaW5kID8gYmluZHNbaV0gOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCB0b3RhbCA9IGhhc01hdGNoZWRLaW5kXG4gICAgICAgID8gcm93cy5maWx0ZXIoKHIpID0+IHIubGlzdGluZ19raW5kID09PSBtYXRjaGVkS2luZCkubGVuZ3RoXG4gICAgICAgIDogcm93cy5sZW5ndGg7XG4gICAgICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHVua25vd24sIG51bWJlcj4oKTtcbiAgICAgIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIGNvdW50cy5zZXQocm93Lmxpc3Rpbmdfa2luZCwgKGNvdW50cy5nZXQocm93Lmxpc3Rpbmdfa2luZCkgPz8gMCkgKyAxKTtcbiAgICAgIHJldHVybiBbXG4gICAgICAgIHsgbWV0cmljOiAndG90YWwnLCB2YWx1ZTogbnVsbCwgbjogdG90YWwgfSxcbiAgICAgICAgLi4uWy4uLmNvdW50cy5lbnRyaWVzKCldLm1hcCgoW3ZhbHVlLCBuXSkgPT4gKHsgbWV0cmljOiAna2luZCcsIHZhbHVlLCBuIH0pKSxcbiAgICAgIF07XG4gICAgfVxuICAgIC8vIGxpc3RIYXJuZXNzZXMvbGlzdFB1YmxpY0hhcm5lc3Nlc1BhZ2U6IG5vcm1hbGl6ZWQgcHJlZGljYXRlLCBzdGFibGUgb3JkZXIsXG4gICAgLy8gb3B0aW9uYWwgY29tcG9zaXRlIGtleXNldCBjdXJzb3IsIGFuZCBhbiBvcHRpb25hbCBwcmUtTElNSVQgcHVibGlzaGVyIGJhbi5cbiAgICBpZiAoXG4gICAgICAodXBwZXIuc3RhcnRzV2l0aCgnU0VMRUNUIEguKiBGUk9NIEhBUk5FU1NFUyBIIFdIRVJFJykgfHxcbiAgICAgICAgdXBwZXIuc3RhcnRzV2l0aCgnU0VMRUNUICogRlJPTSBIQVJORVNTRVMgV0hFUkUnKSkgJiZcbiAgICAgIHVwcGVyLmluY2x1ZGVzKCdVTkxJU1RFRF9BVCBJUyBOVUxMJylcbiAgICApIHtcbiAgICAgIGxldCBpID0gMDtcbiAgICAgIGNvbnN0IGhhc0tpbmQgPSB1cHBlci5pbmNsdWRlcygnSC5MSVNUSU5HX0tJTkQgPSA/JykgfHwgdXBwZXIuaW5jbHVkZXMoJyBMSVNUSU5HX0tJTkQgPSA/Jyk7XG4gICAgICBjb25zdCBraW5kID0gaGFzS2luZCA/IGJpbmRzW2krK10gOiB1bmRlZmluZWQ7XG4gICAgICAvLyBUaGUgYmx1ZXByaW50IGZhY2V0IChtaWdyYXRpb25zIDAwOS8wMzUpIGJpbmRzIHJpZ2h0IGFmdGVyIHRoZSBraW5kLlxuICAgICAgY29uc3QgaGFzQmx1ZXByaW50S2luZCA9IHVwcGVyLmluY2x1ZGVzKCdCTFVFUFJJTlRfS0lORCA9ID8nKTtcbiAgICAgIGNvbnN0IGJsdWVwcmludEtpbmQgPSBoYXNCbHVlcHJpbnRLaW5kID8gYmluZHNbaSsrXSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGhhc1Byb2plY3QgPSB1cHBlci5pbmNsdWRlcygnSC5QUk9KRUNUX1JFRiA9ID8nKSB8fCB1cHBlci5pbmNsdWRlcygnIFBST0pFQ1RfUkVGID0gPycpO1xuICAgICAgY29uc3QgcHJvamVjdCA9IGhhc1Byb2plY3QgPyBiaW5kc1tpKytdIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY29tcG9zaXRlQ3Vyc29yID0gdXBwZXIuaW5jbHVkZXMoJ0guTEFTVF9BQ1RJVklUWV9BVCA9ID8gQU5EIEguSUQgPiA/Jyk7XG4gICAgICBjb25zdCBudWxsQ3Vyc29yID0gdXBwZXIuaW5jbHVkZXMoJ0guTEFTVF9BQ1RJVklUWV9BVCBJUyBOVUxMIEFORCBILklEID4gPycpO1xuICAgICAgY29uc3QgbGVnYWN5Q3Vyc29yID0gIWNvbXBvc2l0ZUN1cnNvciAmJiAhbnVsbEN1cnNvciAmJiB1cHBlci5pbmNsdWRlcygnTEFTVF9BQ1RJVklUWV9BVCA8ID8nKTtcbiAgICAgIGxldCBjdXJzb3JBY3Rpdml0eTogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZDtcbiAgICAgIGxldCBjdXJzb3JJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKGNvbXBvc2l0ZUN1cnNvcikge1xuICAgICAgICBjdXJzb3JBY3Rpdml0eSA9IGJpbmRzW2krK10gYXMgbnVtYmVyO1xuICAgICAgICBpKys7IC8vIHJlcGVhdGVkIGFjdGl2aXR5IGJpbmRcbiAgICAgICAgY3Vyc29ySWQgPSBiaW5kc1tpKytdIGFzIHN0cmluZztcbiAgICAgIH0gZWxzZSBpZiAobnVsbEN1cnNvcikge1xuICAgICAgICBjdXJzb3JBY3Rpdml0eSA9IG51bGw7XG4gICAgICAgIGN1cnNvcklkID0gYmluZHNbaSsrXSBhcyBzdHJpbmc7XG4gICAgICB9IGVsc2UgaWYgKGxlZ2FjeUN1cnNvcikge1xuICAgICAgICBjdXJzb3JBY3Rpdml0eSA9IGJpbmRzW2krK10gYXMgbnVtYmVyO1xuICAgICAgfVxuICAgICAgY29uc3QgaGFzU2VhcmNoID0gdXBwZXIuaW5jbHVkZXMoJ1RJVExFIExJS0UgPycpO1xuICAgICAgY29uc3Qgc2VhcmNoID0gaGFzU2VhcmNoID8gU3RyaW5nKGJpbmRzW2krK10gPz8gJycpLnJlcGxhY2VBbGwoJyUnLCAnJykudG9Mb3dlckNhc2UoKSA6ICcnO1xuICAgICAgaWYgKGhhc1NlYXJjaCkgaSArPSAzO1xuICAgICAgY29uc3QgaGFzQ2xhaW0gPSB1cHBlci5pbmNsdWRlcygnQ0xBSU1fU1RBVFVTID0gPycpO1xuICAgICAgY29uc3QgY2xhaW0gPSBoYXNDbGFpbSA/IGJpbmRzW2krK10gOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBsaW1pdCA9IGJpbmRzW2JpbmRzLmxlbmd0aCAtIDFdIGFzIG51bWJlcjtcbiAgICAgIGxldCByb3dzID0gdGhpcy50YWJsZXMuaGFybmVzc2VzLmZpbHRlcigocikgPT4gci51bmxpc3RlZF9hdCA9PSBudWxsKTtcbiAgICAgIGlmICh1cHBlci5pbmNsdWRlcyhcIlJFVklFV19TVEFUVVMgPSAnQVBQUk9WRUQnXCIpKSB7XG4gICAgICAgIHJvd3MgPSByb3dzLmZpbHRlcigocikgPT4gci5yZXZpZXdfc3RhdHVzID09PSAnYXBwcm92ZWQnKTtcbiAgICAgIH1cbiAgICAgIGlmICh1cHBlci5pbmNsdWRlcygnTk9UIEVYSVNUUyAoU0VMRUNUIDEgRlJPTSBCQU5ORURfUFVCTElTSEVSX1BVQktFWVMnKSkge1xuICAgICAgICBjb25zdCBiYW5uZWQgPSBuZXcgU2V0KHRoaXMudGFibGVzLmJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cy5tYXAoKHIpID0+IHIucHVia2V5KSk7XG4gICAgICAgIHJvd3MgPSByb3dzLmZpbHRlcigocikgPT4gIXIucHVibGlzaGVyX2RldmljZV9wdWJrZXkgfHwgIWJhbm5lZC5oYXMoci5wdWJsaXNoZXJfZGV2aWNlX3B1YmtleSkpO1xuICAgICAgfVxuICAgICAgaWYgKGhhc0tpbmQpIHJvd3MgPSByb3dzLmZpbHRlcigocikgPT4gci5saXN0aW5nX2tpbmQgPT09IGtpbmQpO1xuICAgICAgaWYgKGhhc0JsdWVwcmludEtpbmQpIHtcbiAgICAgICAgcm93cyA9IHJvd3MuZmlsdGVyKChyKSA9PiByLmxpc3Rpbmdfa2luZCA9PT0gJ2JsdWVwcmludCcgJiYgci5ibHVlcHJpbnRfa2luZCA9PT0gYmx1ZXByaW50S2luZCk7XG4gICAgICB9XG4gICAgICBpZiAoaGFzUHJvamVjdCkgcm93cyA9IHJvd3MuZmlsdGVyKChyKSA9PiByLnByb2plY3RfcmVmID09PSBwcm9qZWN0KTtcbiAgICAgIGlmIChoYXNDbGFpbSkgcm93cyA9IHJvd3MuZmlsdGVyKChyKSA9PiByLmNsYWltX3N0YXR1cyA9PT0gY2xhaW0pO1xuICAgICAgaWYgKGhhc1NlYXJjaCkge1xuICAgICAgICByb3dzID0gcm93cy5maWx0ZXIoKHIpID0+XG4gICAgICAgICAgW3IudGl0bGUsIHIuZGVzY3JpcHRpb24sIHIuZ2l0aHViX293bmVyLCByLmdpdGh1Yl9uYW1lXVxuICAgICAgICAgICAgLnNvbWUoKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUgPz8gJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBDYXRhbG9nIGZpbHRlcnMgKG1pZ3JhdGlvbiAwMTgpIGJpbmQgYWZ0ZXIgY2xhaW07IHJvdy1maWx0ZXIgb3JkZXIgaXNcbiAgICAgIC8vIGlycmVsZXZhbnQsIGJ1dCB0aGUgYmluZCBpbmRleCBtdXN0IGFkdmFuY2UgaW4gdGhlIGVtaXR0ZWQgb3JkZXIuXG4gICAgICAoeyByb3dzLCBpbmRleDogaSB9ID0gYXBwbHlDYXRhbG9nUHJlZGljYXRlKHVwcGVyLCBiaW5kcywgaSwgcm93cykpO1xuICAgICAgaWYgKGN1cnNvckFjdGl2aXR5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcm93cyA9IHJvd3MuZmlsdGVyKChyKSA9PiB7XG4gICAgICAgICAgY29uc3QgYWN0aXZpdHkgPSByLmxhc3RfYWN0aXZpdHlfYXQgYXMgbnVtYmVyIHwgbnVsbDtcbiAgICAgICAgICBpZiAobGVnYWN5Q3Vyc29yKSByZXR1cm4gYWN0aXZpdHkgPT0gbnVsbCB8fCBhY3Rpdml0eSA8IChjdXJzb3JBY3Rpdml0eSBhcyBudW1iZXIpO1xuICAgICAgICAgIGlmIChjdXJzb3JBY3Rpdml0eSA9PSBudWxsKSByZXR1cm4gYWN0aXZpdHkgPT0gbnVsbCAmJiBTdHJpbmcoci5pZCkgPiBTdHJpbmcoY3Vyc29ySWQpO1xuICAgICAgICAgIHJldHVybiBhY3Rpdml0eSA9PSBudWxsIHx8IGFjdGl2aXR5IDwgY3Vyc29yQWN0aXZpdHkgfHxcbiAgICAgICAgICAgIChhY3Rpdml0eSA9PT0gY3Vyc29yQWN0aXZpdHkgJiYgU3RyaW5nKHIuaWQpID4gU3RyaW5nKGN1cnNvcklkKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcm93cy5zb3J0KChhLCBiKSA9PiB7XG4gICAgICAgIGNvbnN0IGFBY3Rpdml0eSA9IGEubGFzdF9hY3Rpdml0eV9hdCBhcyBudW1iZXIgfCBudWxsO1xuICAgICAgICBjb25zdCBiQWN0aXZpdHkgPSBiLmxhc3RfYWN0aXZpdHlfYXQgYXMgbnVtYmVyIHwgbnVsbDtcbiAgICAgICAgaWYgKGFBY3Rpdml0eSA9PSBudWxsICYmIGJBY3Rpdml0eSAhPSBudWxsKSByZXR1cm4gMTtcbiAgICAgICAgaWYgKGFBY3Rpdml0eSAhPSBudWxsICYmIGJBY3Rpdml0eSA9PSBudWxsKSByZXR1cm4gLTE7XG4gICAgICAgIGlmIChhQWN0aXZpdHkgIT0gbnVsbCAmJiBiQWN0aXZpdHkgIT0gbnVsbCAmJiBhQWN0aXZpdHkgIT09IGJBY3Rpdml0eSkgcmV0dXJuIGJBY3Rpdml0eSAtIGFBY3Rpdml0eTtcbiAgICAgICAgcmV0dXJuIFN0cmluZyhhLmlkKS5sb2NhbGVDb21wYXJlKFN0cmluZyhiLmlkKSk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiByb3dzLnNsaWNlKDAsIGxpbWl0KTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1NFTEVDVCBDT1VOVCBGUk9NIFBVQkxJU0hfUkFURV9MSU1JVCcpKSB7XG4gICAgICBjb25zdCBbdXNlcl9pZCwgd2luZG93X3N0YXJ0XSA9IGJpbmRzO1xuICAgICAgY29uc3Qgcm93ID0gdGhpcy50YWJsZXMucHVibGlzaF9yYXRlX2xpbWl0LmZpbmQoXG4gICAgICAgIChyKSA9PiByLmdpdGh1Yl91c2VyX2lkID09PSB1c2VyX2lkICYmIHIud2luZG93X3N0YXJ0ID09PSB3aW5kb3dfc3RhcnQsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJvdyA/IFt7IGNvdW50OiByb3cuY291bnQgfV0gOiBbXTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLnN0YXJ0c1dpdGgoJ1NFTEVDVCBQVUJLRVkgRlJPTSBCQU5ORURfUFVCTElTSEVSX1BVQktFWVMnKSkge1xuICAgICAgcmV0dXJuIHRoaXMudGFibGVzLmJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cy5tYXAoKHIpID0+ICh7IHB1YmtleTogci5wdWJrZXkgfSkpO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnU0VMRUNUICogRlJPTSBCQU5ORURfUFVCTElTSEVSX1BVQktFWVMnKSkge1xuICAgICAgcmV0dXJuIFsuLi50aGlzLnRhYmxlcy5iYW5uZWRfcHVibGlzaGVyX3B1YmtleXNdO1xuICAgIH1cbiAgICBpZiAodXBwZXIuc3RhcnRzV2l0aCgnU0VMRUNUICogRlJPTSBSRVBPUlRTIFdIRVJFIElEID0nKSkge1xuICAgICAgY29uc3QgW2lkXSA9IGJpbmRzO1xuICAgICAgY29uc3Qgcm93ID0gdGhpcy50YWJsZXMucmVwb3J0cy5maW5kKChyKSA9PiByLmlkID09PSBpZCk7XG4gICAgICByZXR1cm4gcm93ID8gW3Jvd10gOiBbXTtcbiAgICB9XG4gICAgaWYgKHVwcGVyLmluY2x1ZGVzKCdGUk9NIFJFUE9SVFMnKSkge1xuICAgICAgLy8gbGlzdFJlcG9ydHMgam9pbiDigJQgcmV0dXJuIHJlcG9ydHMgKG9wdGlvbmFsbHkgZmlsdGVyZWQgYnkgc3RhdHVzKS5cbiAgICAgIGNvbnN0IGZpbHRlclN0YXR1cyA9IHVwcGVyLmluY2x1ZGVzKCdXSEVSRSBSLlNUQVRVUyA9ID8nKTtcbiAgICAgIGxldCByb3dzID0gWy4uLnRoaXMudGFibGVzLnJlcG9ydHNdO1xuICAgICAgaWYgKGZpbHRlclN0YXR1cykgcm93cyA9IHJvd3MuZmlsdGVyKChyKSA9PiByLnN0YXR1cyA9PT0gYmluZHNbMF0pO1xuICAgICAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiAoe1xuICAgICAgICAuLi5yLFxuICAgICAgICBoYXJuZXNzX3RpdGxlOiB0aGlzLnRhYmxlcy5oYXJuZXNzZXMuZmluZCgoaCkgPT4gaC5pZCA9PT0gci5oYXJuZXNzX2lkKT8udGl0bGUgPz8gbnVsbCxcbiAgICAgICAgaGFybmVzc19naXRodWJfdXJsOiB0aGlzLnRhYmxlcy5oYXJuZXNzZXMuZmluZCgoaCkgPT4gaC5pZCA9PT0gci5oYXJuZXNzX2lkKT8uZ2l0aHViX3VybCA/PyBudWxsLFxuICAgICAgICBoYXJuZXNzX3VubGlzdGVkX2F0OiB0aGlzLnRhYmxlcy5oYXJuZXNzZXMuZmluZCgoaCkgPT4gaC5pZCA9PT0gci5oYXJuZXNzX2lkKT8udW5saXN0ZWRfYXQgPz8gbnVsbCxcbiAgICAgIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYWtlRGIoKTogeyBkYjogRDFEYXRhYmFzZTsgc3RvcmU6IEZha2VTdG9yZSB9IHtcbiAgY29uc3Qgc3RvcmUgPSBuZXcgRmFrZVN0b3JlKCk7XG4gIGNvbnN0IGRiID0ge1xuICAgIHByZXBhcmUoc3FsOiBzdHJpbmcpIHtcbiAgICAgIHJldHVybiBuZXcgRmFrZVN0bXQoc3FsLCBzdG9yZSkgYXMgdW5rbm93biBhcyBEMVByZXBhcmVkU3RhdGVtZW50O1xuICAgIH0sXG4gIH0gYXMgdW5rbm93biBhcyBEMURhdGFiYXNlO1xuICByZXR1cm4geyBkYiwgc3RvcmUgfTtcbn1cblxuZXhwb3J0IGNsYXNzIEZha2VLViB7XG4gIGRhdGEgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBhc3luYyBnZXQoa2V5OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHsgcmV0dXJuIHRoaXMuZGF0YS5nZXQoa2V5KSA/PyBudWxsOyB9XG4gIGFzeW5jIHB1dChrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZywgX29wdHM/OiB1bmtub3duKTogUHJvbWlzZTx2b2lkPiB7IHRoaXMuZGF0YS5zZXQoa2V5LCB2YWx1ZSk7IH1cbiAgYXN5bmMgZGVsZXRlKGtleTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7IHRoaXMuZGF0YS5kZWxldGUoa2V5KTsgfVxufVxuXG5pbnRlcmZhY2UgRmFrZU11bHRpcGFydFJlY29yZCB7XG4gIGtleTogc3RyaW5nO1xuICBvcHRpb25zOiBSMk11bHRpcGFydE9wdGlvbnM7XG4gIHBhcnRzOiBNYXA8bnVtYmVyLCB7IGJ5dGVzOiBVaW50OEFycmF5OyBldGFnOiBzdHJpbmcgfT47XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZha2VSMkJ5dGVzKFxuICB2YWx1ZTogUmVhZGFibGVTdHJlYW0gfCBBcnJheUJ1ZmZlciB8IEFycmF5QnVmZmVyVmlldyB8IHN0cmluZyB8IEJsb2IsXG4pOiBQcm9taXNlPFVpbnQ4QXJyYXk+IHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHJldHVybiBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmFsdWUpO1xuICBpZiAodmFsdWUgaW5zdGFuY2VvZiBBcnJheUJ1ZmZlcikgcmV0dXJuIG5ldyBVaW50OEFycmF5KHZhbHVlLnNsaWNlKDApKTtcbiAgaWYgKEFycmF5QnVmZmVyLmlzVmlldyh2YWx1ZSkpIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodmFsdWUuYnVmZmVyLnNsaWNlKHZhbHVlLmJ5dGVPZmZzZXQsIHZhbHVlLmJ5dGVPZmZzZXQgKyB2YWx1ZS5ieXRlTGVuZ3RoKSk7XG4gIH1cbiAgaWYgKHZhbHVlIGluc3RhbmNlb2YgQmxvYikgcmV0dXJuIG5ldyBVaW50OEFycmF5KGF3YWl0IHZhbHVlLmFycmF5QnVmZmVyKCkpO1xuICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgbmV3IFJlc3BvbnNlKHZhbHVlKS5hcnJheUJ1ZmZlcigpKTtcbn1cblxuLyoqXG4gKiBJbi1tZW1vcnkgUjIgZmFrZSBmb3IgdGhlIHNuYXBzaG90IHRhcmJhbGwgYmxvYiBzdG9yZSAobWlncmF0aW9uIDAwNSkuIENvdmVyc1xuICogdGhlIHN1YnNldCB0aGUgYmxvYnMvbGlzdGluZ3Mgcm91dGVzIHVzZTogaGVhZC9wdXQvZ2V0L2RlbGV0ZS4gYGdldGAgcmV0dXJucyBhXG4gKiBzdHJlYW1hYmxlIGJvZHkgKyBhIG5vLW9wIHdyaXRlSHR0cE1ldGFkYXRhLCBtYXRjaGluZyB0aGUgUjJPYmplY3RCb2R5IHNoYXBlXG4gKiB0aGUgR0VUIHJvdXRlIGNvbnN1bWVzLlxuICovXG5leHBvcnQgY2xhc3MgRmFrZVIyIHtcbiAgZGF0YSA9IG5ldyBNYXA8c3RyaW5nLCBVaW50OEFycmF5PigpO1xuICBodHRwTWV0YWRhdGEgPSBuZXcgTWFwPHN0cmluZywgUjJIVFRQTWV0YWRhdGE+KCk7XG4gIGN1c3RvbU1ldGFkYXRhID0gbmV3IE1hcDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+KCk7XG4gIGV0YWdzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgbXVsdGlwYXJ0VXBsb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlTXVsdGlwYXJ0UmVjb3JkPigpO1xuICBtdWx0aXBhcnRQYXJ0VXBsb2FkQ2FsbHMgPSAwO1xuICBuZXh0TXVsdGlwYXJ0VXBsb2FkSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBuZXh0TXVsdGlwYXJ0Q29tcGxldGVSZXR1cm5PbWl0c0N1c3RvbU1ldGFkYXRhID0gZmFsc2U7XG4gIHByaXZhdGUgbmV4dE11bHRpcGFydFVwbG9hZCA9IDE7XG5cbiAgcHJpdmF0ZSBvYmplY3Qoa2V5OiBzdHJpbmcsIHdpdGhCb2R5OiBib29sZWFuKSB7XG4gICAgY29uc3QgdiA9IHRoaXMuZGF0YS5nZXQoa2V5KTtcbiAgICBpZiAoIXYpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGV0YWcgPSB0aGlzLmV0YWdzLmdldChrZXkpID8/IGBmYWtlLSR7di5ieXRlTGVuZ3RofWA7XG4gICAgY29uc3QgaHR0cE1ldGFkYXRhID0gdGhpcy5odHRwTWV0YWRhdGEuZ2V0KGtleSk7XG4gICAgY29uc3QgY3VzdG9tTWV0YWRhdGEgPSB0aGlzLmN1c3RvbU1ldGFkYXRhLmdldChrZXkpO1xuICAgIGNvbnN0IGJhc2UgPSB7XG4gICAgICBrZXksXG4gICAgICB2ZXJzaW9uOiAnMScsXG4gICAgICBzaXplOiB2LmJ5dGVMZW5ndGgsXG4gICAgICBldGFnLFxuICAgICAgaHR0cEV0YWc6IGBcIiR7ZXRhZ31cImAsXG4gICAgICBjaGVja3N1bXM6IHsgdG9KU09OOiAoKSA9PiAoe30pIH0sXG4gICAgICB1cGxvYWRlZDogbmV3IERhdGUoMCksXG4gICAgICBodHRwTWV0YWRhdGEsXG4gICAgICBjdXN0b21NZXRhZGF0YSxcbiAgICAgIHN0b3JhZ2VDbGFzczogJ1N0YW5kYXJkJyxcbiAgICAgIHdyaXRlSHR0cE1ldGFkYXRhKGhlYWRlcnM6IEhlYWRlcnMpIHtcbiAgICAgICAgaWYgKGh0dHBNZXRhZGF0YT8uY29udGVudFR5cGUpIGhlYWRlcnMuc2V0KCdjb250ZW50LXR5cGUnLCBodHRwTWV0YWRhdGEuY29udGVudFR5cGUpO1xuICAgICAgICBpZiAoaHR0cE1ldGFkYXRhPy5jYWNoZUNvbnRyb2wpIGhlYWRlcnMuc2V0KCdjYWNoZS1jb250cm9sJywgaHR0cE1ldGFkYXRhLmNhY2hlQ29udHJvbCk7XG4gICAgICAgIGlmIChodHRwTWV0YWRhdGE/LmNvbnRlbnREaXNwb3NpdGlvbikgaGVhZGVycy5zZXQoJ2NvbnRlbnQtZGlzcG9zaXRpb24nLCBodHRwTWV0YWRhdGEuY29udGVudERpc3Bvc2l0aW9uKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICBpZiAoIXdpdGhCb2R5KSByZXR1cm4gYmFzZTtcbiAgICBjb25zdCBjb3B5ID0gbmV3IFVpbnQ4QXJyYXkodik7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICBib2R5OiBuZXcgUmVzcG9uc2UoY29weSkuYm9keSBhcyBSZWFkYWJsZVN0cmVhbTxVaW50OEFycmF5PixcbiAgICAgIGJvZHlVc2VkOiBmYWxzZSxcbiAgICAgIGFzeW5jIGFycmF5QnVmZmVyKCkge1xuICAgICAgICByZXR1cm4gY29weS5idWZmZXIuc2xpY2UoY29weS5ieXRlT2Zmc2V0LCBjb3B5LmJ5dGVPZmZzZXQgKyBjb3B5LmJ5dGVMZW5ndGgpIGFzIEFycmF5QnVmZmVyO1xuICAgICAgfSxcbiAgICAgIGFzeW5jIGJ5dGVzKCkgeyByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoY29weSk7IH0sXG4gICAgICBhc3luYyB0ZXh0KCkgeyByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGNvcHkpOyB9LFxuICAgICAgYXN5bmMganNvbjxUPigpIHsgcmV0dXJuIEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGNvcHkpKSBhcyBUOyB9LFxuICAgICAgYXN5bmMgYmxvYigpIHsgcmV0dXJuIG5ldyBCbG9iKFtjb3B5XSk7IH0sXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGhlYWQoa2V5OiBzdHJpbmcpOiBQcm9taXNlPFJldHVyblR5cGU8RmFrZVIyWydvYmplY3QnXT4+IHtcbiAgICByZXR1cm4gdGhpcy5vYmplY3Qoa2V5LCBmYWxzZSk7XG4gIH1cblxuICBhc3luYyBwdXQoXG4gICAga2V5OiBzdHJpbmcsXG4gICAgdmFsdWU6IEFycmF5QnVmZmVyIHwgVWludDhBcnJheSB8IHN0cmluZyxcbiAgICBvcHRzOiB7XG4gICAgICBvbmx5SWY/OiB7IGV0YWdEb2VzTm90TWF0Y2g/OiBzdHJpbmcgfTtcbiAgICAgIGh0dHBNZXRhZGF0YT86IFIySFRUUE1ldGFkYXRhIHwgSGVhZGVycztcbiAgICAgIGN1c3RvbU1ldGFkYXRhPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICB9ID0ge30sXG4gICk6IFByb21pc2U8UmV0dXJuVHlwZTxGYWtlUjJbJ29iamVjdCddPj4ge1xuICAgIGlmIChvcHRzLm9ubHlJZj8uZXRhZ0RvZXNOb3RNYXRjaCA9PT0gJyonICYmIHRoaXMuZGF0YS5oYXMoa2V5KSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgYnl0ZXMgPVxuICAgICAgdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJ1xuICAgICAgICA/IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YWx1ZSlcbiAgICAgICAgOiB2YWx1ZSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXlcbiAgICAgICAgICA/IHZhbHVlXG4gICAgICAgICAgOiBuZXcgVWludDhBcnJheSh2YWx1ZSk7XG4gICAgdGhpcy5kYXRhLnNldChrZXksIG5ldyBVaW50OEFycmF5KGJ5dGVzKSk7XG4gICAgY29uc3QgaHR0cE1ldGFkYXRhID0gb3B0cy5odHRwTWV0YWRhdGEgaW5zdGFuY2VvZiBIZWFkZXJzXG4gICAgICA/IHsgY29udGVudFR5cGU6IG9wdHMuaHR0cE1ldGFkYXRhLmdldCgnY29udGVudC10eXBlJykgPz8gdW5kZWZpbmVkIH1cbiAgICAgIDogb3B0cy5odHRwTWV0YWRhdGE7XG4gICAgaWYgKGh0dHBNZXRhZGF0YSkgdGhpcy5odHRwTWV0YWRhdGEuc2V0KGtleSwgaHR0cE1ldGFkYXRhKTtcbiAgICBlbHNlIHRoaXMuaHR0cE1ldGFkYXRhLmRlbGV0ZShrZXkpO1xuICAgIGlmIChvcHRzLmN1c3RvbU1ldGFkYXRhKSB0aGlzLmN1c3RvbU1ldGFkYXRhLnNldChrZXksIHsgLi4ub3B0cy5jdXN0b21NZXRhZGF0YSB9KTtcbiAgICBlbHNlIHRoaXMuY3VzdG9tTWV0YWRhdGEuZGVsZXRlKGtleSk7XG4gICAgdGhpcy5ldGFncy5zZXQoa2V5LCBgZmFrZS0ke3RoaXMuZXRhZ3Muc2l6ZSArIDF9LSR7Ynl0ZXMuYnl0ZUxlbmd0aH1gKTtcbiAgICByZXR1cm4gdGhpcy5vYmplY3Qoa2V5LCBmYWxzZSk7XG4gIH1cblxuICBhc3luYyBnZXQoa2V5OiBzdHJpbmcpOiBQcm9taXNlPFJldHVyblR5cGU8RmFrZVIyWydvYmplY3QnXT4+IHtcbiAgICByZXR1cm4gdGhpcy5vYmplY3Qoa2V5LCB0cnVlKTtcbiAgfVxuXG4gIHByaXZhdGUgbXVsdGlwYXJ0SGFuZGxlKGtleTogc3RyaW5nLCB1cGxvYWRJZDogc3RyaW5nKTogUjJNdWx0aXBhcnRVcGxvYWQge1xuICAgIHJldHVybiB7XG4gICAgICBrZXksXG4gICAgICB1cGxvYWRJZCxcbiAgICAgIHVwbG9hZFBhcnQ6IGFzeW5jIChwYXJ0TnVtYmVyLCB2YWx1ZSkgPT4ge1xuICAgICAgICB0aGlzLm11bHRpcGFydFBhcnRVcGxvYWRDYWxscyArPSAxO1xuICAgICAgICBjb25zdCByZWNvcmQgPSB0aGlzLm11bHRpcGFydFVwbG9hZHMuZ2V0KHVwbG9hZElkKTtcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLmtleSAhPT0ga2V5KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd1cGxvYWRQYXJ0OiBUaGUgc3BlY2lmaWVkIG11bHRpcGFydCB1cGxvYWQgZG9lcyBub3QgZXhpc3QuICgxMDAyNCknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBieXRlcyA9IGF3YWl0IGZha2VSMkJ5dGVzKHZhbHVlKTtcbiAgICAgICAgbGV0IGhhc2ggPSAyMTY2MTM2MjYxO1xuICAgICAgICBmb3IgKGNvbnN0IGJ5dGUgb2YgYnl0ZXMpIGhhc2ggPSBNYXRoLmltdWwoaGFzaCBeIGJ5dGUsIDE2Nzc3NjE5KSA+Pj4gMDtcbiAgICAgICAgY29uc3QgZXRhZyA9IGBmYWtlLXBhcnQtJHtwYXJ0TnVtYmVyfS0ke2J5dGVzLmJ5dGVMZW5ndGh9LSR7aGFzaC50b1N0cmluZygxNil9YDtcbiAgICAgICAgcmVjb3JkLnBhcnRzLnNldChwYXJ0TnVtYmVyLCB7IGJ5dGVzOiBuZXcgVWludDhBcnJheShieXRlcyksIGV0YWcgfSk7XG4gICAgICAgIHJldHVybiB7IHBhcnROdW1iZXIsIGV0YWcgfTtcbiAgICAgIH0sXG4gICAgICBhYm9ydDogYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCByZWNvcmQgPSB0aGlzLm11bHRpcGFydFVwbG9hZHMuZ2V0KHVwbG9hZElkKTtcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLmtleSAhPT0ga2V5KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdhYm9ydDogVGhlIHNwZWNpZmllZCBtdWx0aXBhcnQgdXBsb2FkIGRvZXMgbm90IGV4aXN0LiAoMTAwMjQpJyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5tdWx0aXBhcnRVcGxvYWRzLmRlbGV0ZSh1cGxvYWRJZCk7XG4gICAgICB9LFxuICAgICAgY29tcGxldGU6IGFzeW5jICh1cGxvYWRlZFBhcnRzKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHRoaXMubXVsdGlwYXJ0VXBsb2Fkcy5nZXQodXBsb2FkSWQpO1xuICAgICAgICBpZiAoIXJlY29yZCB8fCByZWNvcmQua2V5ICE9PSBrZXkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NvbXBsZXRlOiBUaGUgc3BlY2lmaWVkIG11bHRpcGFydCB1cGxvYWQgZG9lcyBub3QgZXhpc3QuICgxMDAyNCknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzZWxlY3RlZDogQXJyYXk8eyBieXRlczogVWludDhBcnJheTsgZXRhZzogc3RyaW5nIH0+ID0gW107XG4gICAgICAgIGZvciAoY29uc3QgcGFydCBvZiB1cGxvYWRlZFBhcnRzKSB7XG4gICAgICAgICAgY29uc3Qgc3RvcmVkID0gcmVjb3JkLnBhcnRzLmdldChwYXJ0LnBhcnROdW1iZXIpO1xuICAgICAgICAgIGlmICghc3RvcmVkIHx8IHN0b3JlZC5ldGFnICE9PSBwYXJ0LmV0YWcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignY29tcGxldGU6IE9uZSBvciBtb3JlIHNwZWNpZmllZCBwYXJ0cyBjb3VsZCBub3QgYmUgZm91bmQuICgxMDAyNSknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgc2VsZWN0ZWQucHVzaChzdG9yZWQpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzZWxlY3RlZC5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgY29uc3QgcmVndWxhclNpemUgPSBzZWxlY3RlZFswXS5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgICAgICAgIGlmIChyZWd1bGFyU2l6ZSA8IDUgKiAxMDI0ICogMTAyNCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdjb21wbGV0ZTogQSBtdWx0aXBhcnQgcGFydCBpcyBiZWxvdyB0aGUgbWluaW11bSBzaXplLiAoMTAwMTEpJyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChzZWxlY3RlZC5zbGljZSgwLCAtMSkuc29tZSgocGFydCkgPT4gcGFydC5ieXRlcy5ieXRlTGVuZ3RoICE9PSByZWd1bGFyU2l6ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignY29tcGxldGU6IEFsbCBub24tdHJhaWxpbmcgcGFydHMgbXVzdCBoYXZlIHRoZSBzYW1lIHNpemUuICgxMDA0OCknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHNlbGVjdGVkLmF0KC0xKSEuYnl0ZXMuYnl0ZUxlbmd0aCA+IHJlZ3VsYXJTaXplKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NvbXBsZXRlOiBUaGUgZmluYWwgcGFydCBleGNlZWRzIHRoZSByZWd1bGFyIHBhcnQgc2l6ZS4gKDEwMDQ4KScpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0b3RhbEJ5dGVzID0gc2VsZWN0ZWQucmVkdWNlKChzdW0sIHBhcnQpID0+IHN1bSArIHBhcnQuYnl0ZXMuYnl0ZUxlbmd0aCwgMCk7XG4gICAgICAgIGNvbnN0IGNvbWJpbmVkID0gbmV3IFVpbnQ4QXJyYXkodG90YWxCeXRlcyk7XG4gICAgICAgIGxldCBvZmZzZXQgPSAwO1xuICAgICAgICBmb3IgKGNvbnN0IHBhcnQgb2Ygc2VsZWN0ZWQpIHtcbiAgICAgICAgICBjb21iaW5lZC5zZXQocGFydC5ieXRlcywgb2Zmc2V0KTtcbiAgICAgICAgICBvZmZzZXQgKz0gcGFydC5ieXRlcy5ieXRlTGVuZ3RoO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZGF0YS5zZXQoa2V5LCBjb21iaW5lZCk7XG4gICAgICAgIGNvbnN0IGh0dHBNZXRhZGF0YSA9IHJlY29yZC5vcHRpb25zLmh0dHBNZXRhZGF0YSBpbnN0YW5jZW9mIEhlYWRlcnNcbiAgICAgICAgICA/IHsgY29udGVudFR5cGU6IHJlY29yZC5vcHRpb25zLmh0dHBNZXRhZGF0YS5nZXQoJ2NvbnRlbnQtdHlwZScpID8/IHVuZGVmaW5lZCB9XG4gICAgICAgICAgOiByZWNvcmQub3B0aW9ucy5odHRwTWV0YWRhdGE7XG4gICAgICAgIGlmIChodHRwTWV0YWRhdGEpIHRoaXMuaHR0cE1ldGFkYXRhLnNldChrZXksIGh0dHBNZXRhZGF0YSk7XG4gICAgICAgIGVsc2UgdGhpcy5odHRwTWV0YWRhdGEuZGVsZXRlKGtleSk7XG4gICAgICAgIGlmIChyZWNvcmQub3B0aW9ucy5jdXN0b21NZXRhZGF0YSkge1xuICAgICAgICAgIHRoaXMuY3VzdG9tTWV0YWRhdGEuc2V0KGtleSwgeyAuLi5yZWNvcmQub3B0aW9ucy5jdXN0b21NZXRhZGF0YSB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmN1c3RvbU1ldGFkYXRhLmRlbGV0ZShrZXkpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZXRhZ3Muc2V0KGtleSwgYGZha2UtbXVsdGlwYXJ0LSR7dXBsb2FkZWRQYXJ0cy5sZW5ndGh9LSR7dG90YWxCeXRlc31gKTtcbiAgICAgICAgdGhpcy5tdWx0aXBhcnRVcGxvYWRzLmRlbGV0ZSh1cGxvYWRJZCk7XG4gICAgICAgIGNvbnN0IGNvbXBsZXRlZCA9IHRoaXMub2JqZWN0KGtleSwgZmFsc2UpITtcbiAgICAgICAgaWYgKHRoaXMubmV4dE11bHRpcGFydENvbXBsZXRlUmV0dXJuT21pdHNDdXN0b21NZXRhZGF0YSkge1xuICAgICAgICAgIHRoaXMubmV4dE11bHRpcGFydENvbXBsZXRlUmV0dXJuT21pdHNDdXN0b21NZXRhZGF0YSA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiB7IC4uLmNvbXBsZXRlZCwgY3VzdG9tTWV0YWRhdGE6IHVuZGVmaW5lZCB9IGFzIHVua25vd24gYXMgUjJPYmplY3Q7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvbXBsZXRlZCBhcyB1bmtub3duIGFzIFIyT2JqZWN0O1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgY3JlYXRlTXVsdGlwYXJ0VXBsb2FkKFxuICAgIGtleTogc3RyaW5nLFxuICAgIG9wdGlvbnM6IFIyTXVsdGlwYXJ0T3B0aW9ucyA9IHt9LFxuICApOiBQcm9taXNlPFIyTXVsdGlwYXJ0VXBsb2FkPiB7XG4gICAgY29uc3QgdXBsb2FkSWQgPSB0aGlzLm5leHRNdWx0aXBhcnRVcGxvYWRJZCA/PyBgZmFrZS1tcHUtJHt0aGlzLm5leHRNdWx0aXBhcnRVcGxvYWQrK31gO1xuICAgIHRoaXMubmV4dE11bHRpcGFydFVwbG9hZElkID0gbnVsbDtcbiAgICB0aGlzLm11bHRpcGFydFVwbG9hZHMuc2V0KHVwbG9hZElkLCB7IGtleSwgb3B0aW9ucywgcGFydHM6IG5ldyBNYXAoKSB9KTtcbiAgICByZXR1cm4gdGhpcy5tdWx0aXBhcnRIYW5kbGUoa2V5LCB1cGxvYWRJZCk7XG4gIH1cblxuICByZXN1bWVNdWx0aXBhcnRVcGxvYWQoa2V5OiBzdHJpbmcsIHVwbG9hZElkOiBzdHJpbmcpOiBSMk11bHRpcGFydFVwbG9hZCB7XG4gICAgcmV0dXJuIHRoaXMubXVsdGlwYXJ0SGFuZGxlKGtleSwgdXBsb2FkSWQpO1xuICB9XG5cbiAgYXN5bmMgZGVsZXRlKGtleTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5kYXRhLmRlbGV0ZShrZXkpO1xuICAgIHRoaXMuaHR0cE1ldGFkYXRhLmRlbGV0ZShrZXkpO1xuICAgIHRoaXMuY3VzdG9tTWV0YWRhdGEuZGVsZXRlKGtleSk7XG4gICAgdGhpcy5ldGFncy5kZWxldGUoa2V5KTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFrZUVudihvdmVycmlkZXM6IFBhcnRpYWw8RW52PiA9IHt9KTogeyBlbnY6IEVudjsgc3RvcmU6IEZha2VTdG9yZTsgcjI6IEZha2VSMiB9IHtcbiAgY29uc3QgeyBkYiwgc3RvcmUgfSA9IG1ha2VEYigpO1xuICBjb25zdCByMiA9IG5ldyBGYWtlUjIoKTtcbiAgY29uc3QgZW52ID0ge1xuICAgIERCOiBkYixcbiAgICBDT1VOVEVSUzogbmV3IEZha2VLVigpIGFzIHVua25vd24gYXMgS1ZOYW1lc3BhY2UsXG4gICAgQVJUSUZBQ1RTOiByMiBhcyB1bmtub3duIGFzIEVudlsnQVJUSUZBQ1RTJ10sXG4gICAgR0lUSFVCX0NMSUVOVF9JRDogJ3Rlc3QnLFxuICAgIEdJVEhVQl9DTElFTlRfU0VDUkVUOiAndGVzdCcsXG4gICAgSVBfSEFTSF9QRVBQRVI6ICd0ZXN0LXBlcHBlcicsXG4gICAgRU5WSVJPTk1FTlQ6ICd0ZXN0JyxcbiAgICBDVVBCT0FSRF9IT1NUOiAnY3VwYm9hcmQudGVzdCcsXG4gICAgQ1VQQk9BUkRfT1BFUkFUT1JfR0lUSFVCX0lEUzogJycsXG4gICAgUkFURV9QRVJfVVNFUl9QVUJMSVNIX0hPVVJMWTogJzUnLFxuICAgIFJBVEVfUEVSX1VTRVJfUkVQT1JUX0hPVVJMWTogJzEwJyxcbiAgICBSQVRFX1BFUl9JUF9MSVNUX1BFUl9NSU5VVEU6ICc2MCcsXG4gICAgSU5ERVhFUl9CQVRDSF9TSVpFOiAnMTAwJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH0gYXMgRW52O1xuICByZXR1cm4geyBlbnYsIHN0b3JlLCByMiB9O1xufVxuXG4vKiogQSBibG9iIGluIHRoZSBzdHViYmVkIHJlY3Vyc2l2ZSB0cmVlIChQLTAwMSBjb250ZW50IHBpbikuIGB0eXBlYCBkZWZhdWx0c1xuICogIHRvICdibG9iJzsgcGFzcyAndHJlZScvJ2NvbW1pdCcgdG8gZXhlcmNpc2UgdGhlIG5vbi1ibG9iIGZpbHRlci4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2hTdHViVHJlZUVudHJ5IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzaGE6IHN0cmluZztcbiAgc2l6ZT86IG51bWJlcjtcbiAgdHlwZT86ICdibG9iJyB8ICd0cmVlJyB8ICdjb21taXQnO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEdoU3R1YiB7XG4gIHVzZXI/OiB7IGlkOiBudW1iZXI7IGxvZ2luOiBzdHJpbmcgfSB8IHsgZXJyb3I6IG51bWJlciB9O1xuICByZXBvPzpcbiAgICB8IHsgaWQ6IG51bWJlcjsgcHJpdmF0ZTogYm9vbGVhbjsgcGVybWlzc2lvbnM/OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPjsgZGVmYXVsdF9icmFuY2g/OiBzdHJpbmcgfVxuICAgIHwgeyBlcnJvcjogbnVtYmVyIH07XG4gIC8qKiBgR0VUIGdpdC9yZWYvaGVhZHMvPGRlZmF1bHRfYnJhbmNoPmAg4oCUIHRoZSBoZWFkIHRoZSBXb3JrZXIgcGlucyAoUC0wMDEpLlxuICAgKiAgT25seSBhIFNFTEYtREVTQ1JJQklORyBwdWJsaXNoIGNhbGxzIGl0OyBhIGNvZGUga2luZCBtdXN0IHBhc3Mgd2l0aG91dCBvbmUuICovXG4gIGhlYWQ/OiB7IHNoYTogc3RyaW5nIH0gfCB7IGVycm9yOiBudW1iZXIgfTtcbiAgLyoqIGBHRVQgZ2l0L3RyZWVzLzxzaGE+P3JlY3Vyc2l2ZT0xYCDigJQgdGhlIHRyZWUgdGhlIFdvcmtlciBkaWdlc3RzIChQLTAwMSkuICovXG4gIHRyZWU/OiB7IGVudHJpZXM6IEdoU3R1YlRyZWVFbnRyeVtdOyB0cnVuY2F0ZWQ/OiBib29sZWFuIH0gfCB7IGVycm9yOiBudW1iZXIgfTtcbiAgLyoqIGBHRVQgZ2l0L2Jsb2JzLzxzaGE+YCDigJQgYnl0ZXMgc2Nhbm5lZCBieSBQLTAwMy4gKi9cbiAgYmxvYnM/OiBSZWNvcmQ8c3RyaW5nLCB7IGNvbnRlbnQ6IHN0cmluZyB9IHwgeyBlcnJvcjogbnVtYmVyIH0+O1xufVxuXG4vKiogQSB3ZWxsLWZvcm1lZCA0MC1oZXggaGVhZCBzaGEgZm9yIHN0dWJzIOKAlCBgJ2EnLnJlcGVhdCg0MClgIGFuZCBmcmllbmRzLiAqL1xuZXhwb3J0IGNvbnN0IFNUVUJfSEVBRF9TSEEgPSAnYScucmVwZWF0KDQwKTtcblxuLyoqIFRyZWUgZW50cmllcyB0aGF0IHNhdGlzZnkgdGhlIFAtMDAxIHBpbiBmb3IgYDxsaXN0aW5nUmVmPi9gOiBvbmUgbGlzdGluZy5qc29uXG4gKiAgcGx1cyBvbmUgbWFuaWZlc3QsIGRldGVybWluaXN0aWMgYmxvYiBzaGFzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0dWJUcmVlRm9yKGxpc3RpbmdSZWY6IHN0cmluZywgbWFuaWZlc3QgPSAnbGlzdGluZy5qc29uJyk6IEdoU3R1YlRyZWVFbnRyeVtdIHtcbiAgcmV0dXJuIFtcbiAgICB7IHBhdGg6IGAke2xpc3RpbmdSZWZ9L2xpc3RpbmcuanNvbmAsIHNoYTogJzEnLnJlcGVhdCg0MCksIHNpemU6IDEyMCB9LFxuICAgIHsgcGF0aDogYCR7bGlzdGluZ1JlZn0vJHttYW5pZmVzdCA9PT0gJ2xpc3RpbmcuanNvbicgPyAnUkVBRE1FLm1kJyA6IG1hbmlmZXN0fWAsIHNoYTogJzInLnJlcGVhdCg0MCksIHNpemU6IDY0IH0sXG4gIF07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdHViR2l0aHViKHN0dWI6IEdoU3R1Yik6IHZvaWQge1xuICBnbG9iYWxUaGlzLmZldGNoID0gKGFzeW5jICh1cmw6IHN0cmluZyB8IFVSTCwgaW5pdD86IFJlcXVlc3RJbml0KSA9PiB7XG4gICAgY29uc3QgdSA9IHVybC50b1N0cmluZygpO1xuICAgIGlmICh1LmVuZHNXaXRoKCcvdXNlcicpKSB7XG4gICAgICBpZiAoc3R1Yi51c2VyICYmICdlcnJvcicgaW4gc3R1Yi51c2VyKSByZXR1cm4gbmV3IFJlc3BvbnNlKCcnLCB7IHN0YXR1czogc3R1Yi51c2VyLmVycm9yIH0pO1xuICAgICAgaWYgKHN0dWIudXNlcikgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeShzdHViLnVzZXIpLCB7IHN0YXR1czogMjAwIH0pO1xuICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IDQwMSB9KTtcbiAgICB9XG4gICAgLy8gQ29udGVudC1waW4gY2FsbHMgKFAtMDAxKSDigJQgbWF0Y2hlZCBCRUZPUkUgdGhlIGdlbmVyaWMgJy9yZXBvcy8nIGJyYW5jaFxuICAgIC8vIGJlY2F1c2UgdGhlaXIgVVJMcyBjb250YWluIGl0IHRvby5cbiAgICBpZiAodS5pbmNsdWRlcygnL2dpdC9yZWYvaGVhZHMvJykpIHtcbiAgICAgIGlmIChzdHViLmhlYWQgJiYgJ2Vycm9yJyBpbiBzdHViLmhlYWQpIHJldHVybiBuZXcgUmVzcG9uc2UoJycsIHsgc3RhdHVzOiBzdHViLmhlYWQuZXJyb3IgfSk7XG4gICAgICBpZiAoc3R1Yi5oZWFkKSByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgcmVmOiAncmVmcy9oZWFkcy9tYWluJywgb2JqZWN0OiB7IHR5cGU6ICdjb21taXQnLCBzaGE6IHN0dWIuaGVhZC5zaGEgfSB9KSwgeyBzdGF0dXM6IDIwMCB9KTtcbiAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ2hlYWQgbm90IHN0dWJiZWQnLCB7IHN0YXR1czogNTAwIH0pO1xuICAgIH1cbiAgICBpZiAodS5pbmNsdWRlcygnL2dpdC90cmVlcy8nKSkge1xuICAgICAgaWYgKHN0dWIudHJlZSAmJiAnZXJyb3InIGluIHN0dWIudHJlZSkgcmV0dXJuIG5ldyBSZXNwb25zZSgnJywgeyBzdGF0dXM6IHN0dWIudHJlZS5lcnJvciB9KTtcbiAgICAgIGlmIChzdHViLnRyZWUpIHtcbiAgICAgICAgY29uc3QgYm9keSA9IHtcbiAgICAgICAgICBzaGE6IHN0dWIuaGVhZCAmJiAhKCdlcnJvcicgaW4gc3R1Yi5oZWFkKSA/IHN0dWIuaGVhZC5zaGEgOiBTVFVCX0hFQURfU0hBLFxuICAgICAgICAgIHRydW5jYXRlZDogc3R1Yi50cmVlLnRydW5jYXRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgICB0cmVlOiBzdHViLnRyZWUuZW50cmllcy5tYXAoKGUpID0+ICh7XG4gICAgICAgICAgICBwYXRoOiBlLnBhdGgsXG4gICAgICAgICAgICBtb2RlOiBlLnR5cGUgPT09ICd0cmVlJyA/ICcwNDAwMDAnIDogZS50eXBlID09PSAnY29tbWl0JyA/ICcxNjAwMDAnIDogJzEwMDY0NCcsXG4gICAgICAgICAgICB0eXBlOiBlLnR5cGUgPz8gJ2Jsb2InLFxuICAgICAgICAgICAgc2hhOiBlLnNoYSxcbiAgICAgICAgICAgIC4uLihlLnR5cGUgPT0gbnVsbCB8fCBlLnR5cGUgPT09ICdibG9iJyA/IHsgc2l6ZTogZS5zaXplID8/IDAgfSA6IHt9KSxcbiAgICAgICAgICB9KSksXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkoYm9keSksIHsgc3RhdHVzOiAyMDAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd0cmVlIG5vdCBzdHViYmVkJywgeyBzdGF0dXM6IDUwMCB9KTtcbiAgICB9XG4gICAgaWYgKHUuaW5jbHVkZXMoJy9naXQvYmxvYnMvJykpIHtcbiAgICAgIGNvbnN0IHNoYSA9IHUuc2xpY2UodS5sYXN0SW5kZXhPZignLycpICsgMSk7XG4gICAgICBjb25zdCBjb25maWd1cmVkID0gc3R1Yi5ibG9icz8uW3NoYV07XG4gICAgICBpZiAoY29uZmlndXJlZCAmJiAnZXJyb3InIGluIGNvbmZpZ3VyZWQpIHJldHVybiBuZXcgUmVzcG9uc2UoJycsIHsgc3RhdHVzOiBjb25maWd1cmVkLmVycm9yIH0pO1xuICAgICAgaWYgKGNvbmZpZ3VyZWQpIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkoeyBlbmNvZGluZzogJ2Jhc2U2NCcsIGNvbnRlbnQ6IGNvbmZpZ3VyZWQuY29udGVudCB9KSwgeyBzdGF0dXM6IDIwMCB9KTtcbiAgICAgIC8vIEV4aXN0aW5nIFAtMDAxIHRlc3RzIHByZWRhdGUgUC0wMDMgYW5kIG9ubHkgY2FyZSBhYm91dCB0cmVlIGRpZ2VzdGluZztcbiAgICAgIC8vIGFuIGVtcHR5IEpTT04gb2JqZWN0IGlzIGEgZGV0ZXJtaW5pc3RpYyBjbGVhbiBibG9iIGZvciB0aG9zZSBmaXh0dXJlcy5cbiAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkoeyBlbmNvZGluZzogJ2Jhc2U2NCcsIGNvbnRlbnQ6IGJ0b2EoJ3t9JykgfSksIHsgc3RhdHVzOiAyMDAgfSk7XG4gICAgfVxuICAgIGlmICh1LmluY2x1ZGVzKCcvcmVwb3MvJykpIHtcbiAgICAgIGlmIChzdHViLnJlcG8gJiYgJ2Vycm9yJyBpbiBzdHViLnJlcG8pIHJldHVybiBuZXcgUmVzcG9uc2UoJycsIHsgc3RhdHVzOiBzdHViLnJlcG8uZXJyb3IgfSk7XG4gICAgICBpZiAoc3R1Yi5yZXBvKSByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHN0dWIucmVwbyksIHsgc3RhdHVzOiAyMDAgfSk7XG4gICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCcnLCB7IHN0YXR1czogNDA0IH0pO1xuICAgIH1cbiAgICB2b2lkIGluaXQ7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZSgnbm90IHN0dWJiZWQnLCB7IHN0YXR1czogNTAwIH0pO1xuICB9KSBhcyB0eXBlb2YgZmV0Y2g7XG59XG4iXSwiZmlsZSI6Ii9zcmMvX190ZXN0c19fL2Zha2UtZDEudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL19fdGVzdHNfXy9mYWtlLWQxLnRzIiwiL3NyYy9fX3Rlc3RzX18vZmFrZS1kMS50cyIsW11d
}}