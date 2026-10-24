'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("LISTING_KINDS", () => { try { return LISTING_KINDS } catch {} });
__vite_ssr_exportName__("isListingKind", () => { try { return isListingKind } catch {} });
__vite_ssr_exportName__("normalizeListingKind", () => { try { return normalizeListingKind } catch {} });
__vite_ssr_exportName__("REVIEW_POLICY_KINDS", () => { try { return REVIEW_POLICY_KINDS } catch {} });
__vite_ssr_exportName__("publishReviewStatus", () => { try { return publishReviewStatus } catch {} });
__vite_ssr_exportName__("LISTING_VISIBILITIES", () => { try { return LISTING_VISIBILITIES } catch {} });
__vite_ssr_exportName__("isListingVisibility", () => { try { return isListingVisibility } catch {} });
__vite_ssr_exportName__("PRICING_MODELS", () => { try { return PRICING_MODELS } catch {} });
__vite_ssr_exportName__("isPricingModel", () => { try { return isPricingModel } catch {} });
__vite_ssr_exportName__("insertHarness", () => { try { return insertHarness } catch {} });
__vite_ssr_exportName__("setReviewStatus", () => { try { return setReviewStatus } catch {} });
__vite_ssr_exportName__("getPreviouslyApprovedVersion", () => { try { return getPreviouslyApprovedVersion } catch {} });
__vite_ssr_exportName__("listVersionsSupersededByApproval", () => { try { return listVersionsSupersededByApproval } catch {} });
__vite_ssr_exportName__("approveListingVersion", () => { try { return approveListingVersion } catch {} });
__vite_ssr_exportName__("listPendingReview", () => { try { return listPendingReview } catch {} });
__vite_ssr_exportName__("getHarnessById", () => { try { return getHarnessById } catch {} });
__vite_ssr_exportName__("getHarnessByGithubRepoId", () => { try { return getHarnessByGithubRepoId } catch {} });
__vite_ssr_exportName__("getHarnessesByGithubRepoIds", () => { try { return getHarnessesByGithubRepoIds } catch {} });
__vite_ssr_exportName__("listActiveListingsByGithubRepoId", () => { try { return listActiveListingsByGithubRepoId } catch {} });
__vite_ssr_exportName__("setListingDrift", () => { try { return setListingDrift } catch {} });
__vite_ssr_exportName__("encodeListingCursor", () => { try { return encodeListingCursor } catch {} });
__vite_ssr_exportName__("parseListingCursor", () => { try { return parseListingCursor } catch {} });
__vite_ssr_exportName__("listHarnesses", () => { try { return listHarnesses } catch {} });
__vite_ssr_exportName__("listPublisherListings", () => { try { return listPublisherListings } catch {} });
__vite_ssr_exportName__("listPublicHarnessesPage", () => { try { return listPublicHarnessesPage } catch {} });
__vite_ssr_exportName__("summarizePublicHarnesses", () => { try { return summarizePublicHarnesses } catch {} });
__vite_ssr_exportName__("getActiveListingByRefs", () => { try { return getActiveListingByRefs } catch {} });
__vite_ssr_exportName__("markHarnessUnlisted", () => { try { return markHarnessUnlisted } catch {} });
__vite_ssr_exportName__("supersedeHarnessListing", () => { try { return supersedeHarnessListing } catch {} });
__vite_ssr_exportName__("updateHarnessStats", () => { try { return updateHarnessStats } catch {} });
__vite_ssr_exportName__("clearHarnessAttestation", () => { try { return clearHarnessAttestation } catch {} });
__vite_ssr_exportName__("setHarnessClaim", () => { try { return setHarnessClaim } catch {} });
__vite_ssr_exportName__("insertReport", () => { try { return insertReport } catch {} });
__vite_ssr_exportName__("listReports", () => { try { return listReports } catch {} });
__vite_ssr_exportName__("getReportById", () => { try { return getReportById } catch {} });
__vite_ssr_exportName__("resolveReport", () => { try { return resolveReport } catch {} });
__vite_ssr_exportName__("audit", () => { try { return audit } catch {} });
__vite_ssr_exportName__("insertCreatorDraft", () => { try { return insertCreatorDraft } catch {} });
__vite_ssr_exportName__("getCreatorDraft", () => { try { return getCreatorDraft } catch {} });
__vite_ssr_exportName__("listCreatorDrafts", () => { try { return listCreatorDrafts } catch {} });
__vite_ssr_exportName__("setCreatorDraftArtifact", () => { try { return setCreatorDraftArtifact } catch {} });
__vite_ssr_exportName__("setCreatorDraftState", () => { try { return setCreatorDraftState } catch {} });
__vite_ssr_exportName__("listBannedPubkeySet", () => { try { return listBannedPubkeySet } catch {} });
__vite_ssr_exportName__("listBannedPubkeys", () => { try { return listBannedPubkeys } catch {} });
__vite_ssr_exportName__("banPublisherPubkey", () => { try { return banPublisherPubkey } catch {} });
__vite_ssr_exportName__("unbanPublisherPubkey", () => { try { return unbanPublisherPubkey } catch {} });
__vite_ssr_exportName__("clientIp", () => { try { return clientIp } catch {} });
__vite_ssr_exportName__("ipHash", () => { try { return ipHash } catch {} });
const LISTING_KINDS = [
  "harness",
  "blueprint",
  "plugin",
  "pack",
  "knowledge-pack",
  "template",
  "app",
  "rubric",
  "plan",
  "recipe",
  "goal",
  // migration 024 / cupboard-themes-2026-09-05: inert semantic-token package;
  // install makes it locally selectable through the existing theme runtime.
  "theme",
  // migration 029 / identities-v1-2026-08-30 P-027, D-010: a DATATYPE PACKAGE —
  // the schema + lifecycle a workspace installs so `work_items` and the surfaces
  // over it accept a new item kind. It had grown a SECOND storefront of its own
  // (`datatypes:publish` marking its own pending queue, `datatypes:catalog`
  // browsing it); this folds publish+browse back into the one Cupboard surface,
  // with `datatype_registry` kept as the resolution layer it always was.
  "datatype",
  // migration 030 / identities-v1-2026-08-30 P-028, D-011 / D-054: an installable
  // BEHAVIOUR — "when X, fire Y" — beside `recipe`, which it closely resembles.
  // What makes it portable is that a standalone rule fires a capability CLASS,
  // not a tool id (D-004): the installing pot's own provider binding decides
  // which tool actually runs, so one listing ships across pots with different
  // providers. Resolves into the SAME reaction registry as every built-in and
  // plugin rule — no second engine, no second condition language.
  "rule",
  // migration 031 / identities-v1-2026-08-30 P-029, D-010 / D-011: an EVENT-KEY
  // DECLARATION — a versioned key family plus its payload schema and discovery
  // metadata. The PROVIDER half of an axis whose consumer half already exists:
  // `requires_events` (migration 013) has been able to depend on a family since
  // the Cupboard's first release, and an unresolvable required family is a HARD
  // install failure — but nothing could ever PUBLISH one, so the only families
  // that ever resolved were first-party. This closes that half.
  //
  // An event listing fires nothing; `rule` is what fires. What it does do is
  // make a family RESOLVABLE, which is why it is review-gated rather than inert
  // (see REVIEW_POLICY_KINDS below).
  "event"
];
function isListingKind(v) {
  return typeof v === "string" && LISTING_KINDS.includes(v);
};
function normalizeListingKind(v) {
  if (v === "tool-pack") return "pack";
  if (v === "learning-pack") return "knowledge-pack";
  return isListingKind(v) ? v : null;
};
const REVIEW_POLICY_KINDS = [
  "knowledge-pack",
  "blueprint",
  "app",
  "rubric",
  "plan",
  "recipe",
  // migration 016 / work-on-everything-goal-2026-08-23 P-006: a goal package is
  // duties prose an agent EXECUTES (a kickoff brief + launch defaults) — the same
  // fail-closed reasoning as `plan`, in the list from the moment the kind exists.
  "goal",
  // migration 029 / identities-v1-2026-08-30 P-027: a datatype package installs a
  // SCHEMA + LIFECYCLE that governs how `work_items` of that kind behave — it lands
  // in the execution path of every surface over them, so it is actuating, not inert.
  // It is also a PRESERVED semantic, not a new one: the parallel `datatypes:publish`
  // surface this consolidation retires already marked its own listings pending for
  // operator moderation (D-010). Omitting it here would have made folding that
  // surface into the Cupboard a silent downgrade from moderated to auto-approved.
  "datatype",
  // migration 030 / identities-v1-2026-08-30 P-028, D-011 / D-054: a rule is the
  // most actuating kind in this list. `recipe` and `goal` are orchestration a
  // person or agent still chooses to RUN; a rule is "when X, fire Y" — it fires
  // BY ITSELF on a matching event, in the installing pot, under the capability
  // its fired CLASS declares. Auto-approving it would let any publisher put
  // self-firing behaviour into every installing pot with no operator ever
  // looking at it. The criterion this list already applies — actuating publishes
  // pending, inert publishes approved (`theme` is the inert case) — puts `rule`
  // on the pending side a fortiori, so it is in the list from the moment the
  // kind exists rather than being tightened later.
  "rule",
  // migration 031 / identities-v1-2026-08-30 P-029, D-010: an event listing
  // FIRES nothing, so the actuating/inert criterion above does not by itself
  // put it here — `theme` is inert and publishes approved. Two things do.
  //
  // (1) The SAME preserved-semantic reasoning as `datatype` directly above.
  //     The event-key space today is first-party curated (EVENT_CATALOG);
  //     making it third-party-publishable while auto-approving it would be a
  //     silent downgrade from curated to unmoderated, which is exactly the
  //     downgrade `datatype` was added here to avoid.
  // (2) A published key can SQUAT or shadow a first-party family, and an
  //     installed squat changes what every `requires_events` dep and every
  //     rule `on` in that pot resolves to. That is namespace capture, not
  //     execution — but its blast radius is the same.
  //
  // Pending is also the recoverable direction: an over-moderated kind can be
  // loosened, whereas an auto-approved squat is already published and public
  // before anyone looks. When P-029's event-key registry lands a STRUCTURAL
  // namespace guard (publisher-scoped prefixes — the derived-truth answer,
  // since no operator can eyeball a squat without knowing the whole key
  // space), revisit this entry; do not loosen it before that guard exists.
  "event"
];
function publishReviewStatus(kind, declares) {
  if (REVIEW_POLICY_KINDS.includes(kind)) return "pending";
  return declares.itemTypes + declares.planTypes > 0 ? "pending" : "approved";
};
const LISTING_VISIBILITIES = ["public", "unlisted", "private"];
function isListingVisibility(v) {
  return typeof v === "string" && LISTING_VISIBILITIES.includes(v);
};
const PRICING_MODELS = ["free", "one-time", "subscription", "per-use"];
function isPricingModel(v) {
  return typeof v === "string" && PRICING_MODELS.includes(v);
};
async function insertHarness(db, h) {
  await db.prepare(
    `INSERT INTO harnesses
         (id, listing_kind, project_ref, listing_ref,
          github_repository_id, github_owner, github_name, github_url,
          title, description, topic_hex,
          publisher_github_user_id, publisher_github_login, publisher_permission,
          publisher_device_pubkey, publisher_attestation_gist_id,
          provides_tools, uses_tools, provides_events, requires_events, requires_rubrics,
          provides_item_types, provides_plan_types, requires_plan_type,
          hive_pubkey, hive_title, blueprint_kind,
          review_status,
          delivery_type, latest_json_url, release_repo, icon_url, platforms,
          visibility, tenant_id, sku_ref, pricing_model,
          price_amount_micros, price_currency,
          compatibility_json, required_permissions,
          release_version, release_content_hash, release_manifest_digest,
          release_signature, release_manifest, identity_surface, release_published_at,
          pinned_commit_sha, pinned_tree_digest, pinned_at,
          authority_unresolved, authority_unresolved_cause,
          verified_by,
          claim_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?)`
  ).bind(
    h.id,
    h.listing_kind ?? "harness",
    h.project_ref ?? null,
    h.listing_ref ?? null,
    h.github_repository_id,
    h.github_owner,
    h.github_name,
    h.github_url,
    h.title,
    h.description,
    h.topic_hex,
    h.publisher_github_user_id,
    h.publisher_github_login,
    h.publisher_permission ?? null,
    h.publisher_device_pubkey ?? null,
    h.publisher_attestation_gist_id ?? null,
    h.provides_tools ?? null,
    h.uses_tools ?? null,
    h.provides_events ?? null,
    h.requires_events ?? null,
    h.requires_rubrics ?? null,
    h.provides_item_types ?? null,
    h.provides_plan_types ?? null,
    h.requires_plan_type ?? null,
    h.hive_pubkey ?? null,
    h.hive_title ?? null,
    h.blueprint_kind ?? null,
    h.review_status ?? "approved",
    h.delivery_type ?? null,
    h.latest_json_url ?? null,
    h.release_repo ?? null,
    h.icon_url ?? null,
    h.platforms ?? null,
    h.visibility ?? "public",
    h.tenant_id ?? null,
    h.sku_ref ?? null,
    h.pricing_model ?? null,
    h.price_amount_micros ?? null,
    h.price_currency ?? null,
    h.compatibility_json ?? null,
    h.required_permissions ?? null,
    h.release_version ?? null,
    h.release_content_hash ?? null,
    h.release_manifest_digest ?? null,
    h.release_signature ?? null,
    h.release_manifest ?? null,
    h.identity_surface ?? null,
    h.release_published_at ?? null,
    h.pinned_commit_sha ?? null,
    h.pinned_tree_digest ?? null,
    h.pinned_at ?? null,
    h.authority_unresolved ?? null,
    h.authority_unresolved_cause ?? null,
    h.verified_by ?? "worker",
    h.created_at,
    h.created_at
  ).run();
};
async function setReviewStatus(db, id, status, reason, now) {
  await db.prepare(
    `UPDATE harnesses
          SET review_status = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
        WHERE id = ?`
  ).bind(status, now, reason, now, id).run();
};
async function getPreviouslyApprovedVersion(db, identity, excludeId) {
  const row = await db.prepare(
    `SELECT * FROM harnesses
        WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
          AND review_status = 'approved' AND unlisted_at IS NULL AND id != ?
        ORDER BY COALESCE(approved_at, reviewed_at, created_at) DESC
        LIMIT 1`
  ).bind(identity.github_repository_id, identity.listing_kind, identity.listing_ref, excludeId).first();
  return row ?? null;
};
async function listVersionsSupersededByApproval(db, row) {
  const res = await db.prepare(
    `SELECT * FROM harnesses
        WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
          AND id != ? AND unlisted_at IS NULL
          AND (review_status = 'approved' OR (review_status = 'pending' AND created_at <= ?))
        ORDER BY created_at ASC`
  ).bind(row.github_repository_id, row.listing_kind, row.listing_ref, row.id, row.created_at).all();
  return res.results ?? [];
};
async function approveListingVersion(db, input) {
  const { id, now, approved } = input;
  const statements = [
    db.prepare(
      `UPDATE harnesses
            SET review_status = 'approved', reviewed_at = ?, review_reason = ?, updated_at = ?,
                approved_commit_sha = ?, approved_tree_digest = ?, approved_at = ?,
                drift = 0,
                pinned_commit_sha = COALESCE(?, pinned_commit_sha),
                pinned_tree_digest = COALESCE(?, pinned_tree_digest),
                pinned_at = COALESCE(?, pinned_at),
                authority_unresolved = COALESCE(?, authority_unresolved),
                authority_unresolved_cause = CASE WHEN ? = 1 THEN ? ELSE authority_unresolved_cause END
          WHERE id = ? AND review_status = 'pending' AND unlisted_at IS NULL`
    ).bind(
      now,
      input.reason,
      now,
      approved?.commitSha ?? null,
      approved?.treeDigest ?? null,
      approved ? now : null,
      input.repinned ? approved?.commitSha ?? null : null,
      input.repinned ? approved?.treeDigest ?? null : null,
      input.repinned ? now : null,
      // P-007: the Worker's verdict for the re-pinned bytes. The cause is replaced (possibly by
      // NULL = resolved) only when a verdict accompanies the re-pin; otherwise both are kept.
      input.repinned && input.authority ? input.authority.unresolved ? 1 : 0 : null,
      input.repinned && input.authority ? 1 : 0,
      input.repinned && input.authority ? input.authority.cause : null,
      id
    )
  ];
  if (input.retire) {
    statements.push(
      db.prepare(
        `UPDATE harnesses
              SET superseded_by = ?, claim_status = 'superseded', unlisted_at = ?,
                  unlisted_reason = 'superseded_by_approved_version', updated_at = ?
            WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
              AND id != ? AND unlisted_at IS NULL
              AND (review_status = 'approved' OR (review_status = 'pending' AND created_at <= ?))
              AND EXISTS (SELECT 1 FROM harnesses n
                           WHERE n.id = ? AND n.review_status = 'approved' AND n.unlisted_at IS NULL)`
      ).bind(
        id,
        now,
        now,
        input.retire.github_repository_id,
        input.retire.listing_kind,
        input.retire.listing_ref,
        id,
        input.retire.created_at,
        id
      )
    );
  };
  if (input.audit) {
    statements.push(
      db.prepare(
        `INSERT INTO audit (ts, kind, detail)
           SELECT ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM harnesses a
                           WHERE a.id = ? AND a.review_status = 'approved' AND a.reviewed_at = ?)`
      ).bind(now, input.audit.kind, JSON.stringify(input.audit.detail), id, now)
    );
  };
  await db.batch(statements);
};
async function listPendingReview(db, limit = 100) {
  const res = await db.prepare(
    `SELECT * FROM harnesses
        WHERE review_status = 'pending' AND unlisted_at IS NULL
        ORDER BY created_at ASC LIMIT ?`
  ).bind(Math.min(Math.max(limit, 1), 200)).all();
  return res.results ?? [];
};
async function getHarnessById(db, id) {
  const row = await db.prepare("SELECT * FROM harnesses WHERE id = ?").bind(id).first();
  return row ?? null;
};
async function getHarnessByGithubRepoId(db, github_repository_id) {
  const row = await db.prepare(
    `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = 'harness'
         ORDER BY (unlisted_at IS NULL) DESC
         LIMIT 1`
  ).bind(github_repository_id).first();
  return row ?? null;
};
async function getHarnessesByGithubRepoIds(db, github_repository_ids) {
  if (github_repository_ids.length === 0) return [];
  const placeholders = github_repository_ids.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT * FROM harnesses
       WHERE github_repository_id IN (${placeholders})
         AND listing_kind = 'harness' AND unlisted_at IS NULL`
  );
  const bound = stmt.bind(
    ...github_repository_ids
  );
  const res = await bound.all();
  return res.results ?? [];
};
async function listActiveListingsByGithubRepoId(db, github_repository_id, kinds) {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT * FROM harnesses
       WHERE github_repository_id = ? AND unlisted_at IS NULL
         AND listing_kind IN (${placeholders})
       ORDER BY listing_kind ASC, listing_ref ASC`
  );
  const bound = stmt.bind(
    github_repository_id,
    ...kinds
  );
  const res = await bound.all();
  return res.results ?? [];
};
async function setListingDrift(db, id, drift) {
  await db.prepare("UPDATE harnesses SET drift = ? WHERE id = ?").bind(drift ? 1 : 0, id).run();
};
const LISTING_CURSOR_PREFIX = "v1:";
function encodeListingCursor(row) {
  const activity = row.last_activity_at == null ? "null" : String(row.last_activity_at);
  return `${LISTING_CURSOR_PREFIX}${activity}:${encodeURIComponent(row.id)}`;
};
function parseListingCursor(raw) {
  if (/^-?\d+$/.test(raw)) {
    const legacy = Number(raw);
    return Number.isSafeInteger(legacy) ? legacy : null;
  };
  if (!raw.startsWith(LISTING_CURSOR_PREFIX)) return null;
  const separator = raw.indexOf(":", LISTING_CURSOR_PREFIX.length);
  if (separator < 0) return null;
  const activityRaw = raw.slice(LISTING_CURSOR_PREFIX.length, separator);
  const encodedId = raw.slice(separator + 1);
  if (!encodedId) return null;
  const last_activity_at = activityRaw === "null" ? null : Number(activityRaw);
  if (last_activity_at !== null && !Number.isSafeInteger(last_activity_at)) return null;
  try {
    const id = decodeURIComponent(encodedId);
    return id ? { last_activity_at, id } : null;
  } catch {
    return null;
  }
};
function compileHarnessListPredicate(opts, config) {
  const where = [
    "h.unlisted_at IS NULL",
    `h.review_status = 'approved'`
  ];
  const binds = [];
  if (config.excludeBanned) {
    where.push(
      "NOT EXISTS (SELECT 1 FROM banned_publisher_pubkeys banned WHERE banned.pubkey = h.publisher_device_pubkey)"
    );
  };
  if (config.includeKind && opts.kind) {
    where.push("h.listing_kind = ?");
    binds.push(opts.kind);
  };
  if (config.includeKind && opts.blueprint_kind) {
    where.push(`h.listing_kind = 'blueprint' AND h.blueprint_kind = ?`);
    binds.push(opts.blueprint_kind);
  };
  if (opts.project_ref) {
    where.push("h.project_ref = ?");
    binds.push(opts.project_ref);
  };
  if (config.includeCursor && opts.cursor != null) {
    if (typeof opts.cursor === "number") {
      where.push("(h.last_activity_at IS NULL OR h.last_activity_at < ?)");
      binds.push(opts.cursor);
    } else if (opts.cursor.last_activity_at == null) {
      where.push("(h.last_activity_at IS NULL AND h.id > ?)");
      binds.push(opts.cursor.id);
    } else {
      where.push(
        "(h.last_activity_at < ? OR h.last_activity_at IS NULL OR (h.last_activity_at = ? AND h.id > ?))"
      );
      binds.push(opts.cursor.last_activity_at, opts.cursor.last_activity_at, opts.cursor.id);
    }
  };
  if (opts.search) {
    where.push(
      "(h.title LIKE ? OR h.description LIKE ? OR h.github_owner LIKE ? OR h.github_name LIKE ?)"
    );
    const q = `%${opts.search}%`;
    binds.push(q, q, q, q);
  };
  if (opts.claim_status) {
    where.push("h.claim_status = ?");
    binds.push(opts.claim_status);
  };
  appendCatalogPredicate(where, binds, opts, "h.");
  return { sql: where.join(" AND "), binds };
}
function appendCatalogPredicate(where, binds, opts, prefix) {
  if (opts.visibility) {
    where.push(`${prefix}visibility = ?`);
    binds.push(opts.visibility);
  };
  if (opts.tenant_ref) {
    where.push(`${prefix}tenant_id = ?`);
    binds.push(opts.tenant_ref);
  };
  if (opts.pricing_model) {
    where.push(`${prefix}pricing_model = ?`);
    binds.push(opts.pricing_model);
  };
  if (opts.paid === true) {
    where.push(`(${prefix}sku_ref IS NOT NULL AND ${prefix}pricing_model IS NOT NULL AND ${prefix}pricing_model != 'free')`);
  } else if (opts.paid === false) {
    where.push(`(${prefix}sku_ref IS NULL OR ${prefix}pricing_model IS NULL OR ${prefix}pricing_model = 'free')`);
  };
  if (opts.runtime) {
    where.push(`json_extract(${prefix}compatibility_json, '$.runtime') = ?`);
    binds.push(opts.runtime);
  };
  if (opts.platform) {
    where.push(
      `(${prefix}compatibility_json IS NOT NULL AND json_valid(${prefix}compatibility_json) AND EXISTS (SELECT 1 FROM json_each(${prefix}compatibility_json, '$.platforms') WHERE json_each.value = ?))`
    );
    binds.push(opts.platform);
  };
  if (opts.permission) {
    where.push(
      `(${prefix}required_permissions IS NOT NULL AND json_valid(${prefix}required_permissions) AND EXISTS (SELECT 1 FROM json_each(${prefix}required_permissions) WHERE json_each.value = ?))`
    );
    binds.push(opts.permission);
  };
  for (const [column, id] of [
    ["provides_item_types", opts.provides_item_type],
    ["provides_plan_types", opts.provides_plan_type]
  ]) {
    if (!id) continue;
    where.push(
      `(${prefix}${column} IS NOT NULL AND json_valid(${prefix}${column}) AND EXISTS (SELECT 1 FROM json_each(${prefix}${column}) WHERE json_extract(json_each.value, '$.id') = ?))`
    );
    binds.push(id);
  };
  if (opts.tenant_scope) {
    where.push(`(${prefix}visibility = 'public' OR ${prefix}tenant_id = ?)`);
    binds.push(opts.tenant_scope);
  } else {
    where.push(`${prefix}visibility = 'public'`);
  };
  if (!opts.include_withdrawn) {
    where.push(`${prefix}yanked_at IS NULL`);
    where.push(`${prefix}revoked_at IS NULL`);
  }
}
async function listHarnesses(db, opts) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = ["unlisted_at IS NULL", `review_status = 'approved'`];
  const binds = [];
  if (opts.kind) {
    where.push("listing_kind = ?");
    binds.push(opts.kind);
  };
  if (opts.blueprint_kind) {
    where.push(`listing_kind = 'blueprint' AND blueprint_kind = ?`);
    binds.push(opts.blueprint_kind);
  };
  if (opts.project_ref) {
    where.push("project_ref = ?");
    binds.push(opts.project_ref);
  };
  if (opts.cursor != null) {
    where.push("(last_activity_at IS NULL OR last_activity_at < ?)");
    binds.push(opts.cursor);
  };
  if (opts.search) {
    where.push("(title LIKE ? OR description LIKE ? OR github_owner LIKE ? OR github_name LIKE ?)");
    const q = `%${opts.search}%`;
    binds.push(q, q, q, q);
  };
  if (opts.claim_status) {
    where.push("claim_status = ?");
    binds.push(opts.claim_status);
  };
  const sql = `SELECT * FROM harnesses WHERE ${where.join(" AND ")} ORDER BY last_activity_at DESC NULLS LAST, id ASC LIMIT ?`;
  binds.push(limit);
  const stmt = db.prepare(sql);
  const bound = stmt.bind(...binds);
  const res = await bound.all();
  return res.results ?? [];
};
async function listPublisherListings(db, opts) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 201);
  const result = await db.prepare(
    `SELECT * FROM harnesses
         WHERE publisher_github_user_id = ?
         ORDER BY updated_at DESC, id ASC
         LIMIT ? OFFSET ?`
  ).bind(opts.publisherId, limit, opts.offset ?? 0).all();
  return result.results ?? [];
};
async function listPublicHarnessesPage(db, opts) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const predicate = compileHarnessListPredicate(opts, {
    includeKind: true,
    includeCursor: true,
    excludeBanned: true
  });
  const binds = [...predicate.binds, limit + 1];
  const stmt = db.prepare(
    `SELECT h.* FROM harnesses h WHERE ${predicate.sql} ORDER BY h.last_activity_at DESC NULLS LAST, h.id ASC LIMIT ?`
  );
  const bound = stmt.bind(
    ...binds
  );
  const res = await bound.all();
  const fetched = res.results ?? [];
  const results = fetched.slice(0, limit);
  const next_cursor = fetched.length > limit && results.length > 0 ? encodeListingCursor(results[results.length - 1]) : null;
  return { results, next_cursor };
};
async function summarizePublicHarnesses(db, opts) {
  const population = compileHarnessListPredicate(opts, {
    includeKind: false,
    includeCursor: false,
    excludeBanned: true
  });
  const matchedWhere = opts.kind ? "WHERE listing_kind = ?" : "";
  const binds = [...population.binds, ...opts.kind ? [opts.kind] : []];
  const stmt = db.prepare(
    `WITH population AS (
       SELECT h.listing_kind
       FROM harnesses h
       WHERE ${population.sql}
     )
     SELECT 'total' AS metric, NULL AS value, COUNT(*) AS n
     FROM population ${matchedWhere}
     UNION ALL
     SELECT 'kind' AS metric, listing_kind AS value, COUNT(*) AS n
     FROM population
     GROUP BY listing_kind`
  );
  const bound = stmt.bind(
    ...binds
  );
  const res = await bound.all();
  const kind_facets = Object.fromEntries(LISTING_KINDS.map((kind) => [kind, 0]));
  let total = 0;
  for (const row of res.results ?? []) {
    if (row.metric === "total") total = Number(row.n) || 0;
    else if (row.value && isListingKind(row.value)) kind_facets[row.value] = Number(row.n) || 0;
  };
  return { total, kind_facets };
};
async function getActiveListingByRefs(db, github_repository_id, listing_kind, listing_ref, pinned_commit_sha) {
  const pinPredicate = pinned_commit_sha === void 0 ? "" : pinned_commit_sha === null ? "AND pinned_commit_sha IS NULL" : "AND pinned_commit_sha = ?";
  const binds = [github_repository_id, listing_kind, listing_ref];
  if (pinned_commit_sha != null) binds.push(pinned_commit_sha);
  const row = await db.prepare(
    `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
           AND unlisted_at IS NULL
           ${pinPredicate}
         LIMIT 1`
  ).bind(...binds).first();
  return row ?? null;
};
async function markHarnessUnlisted(db, id, reason, now_ms) {
  await db.prepare(`UPDATE harnesses SET unlisted_at = ?, unlisted_reason = ?, updated_at = ? WHERE id = ?`).bind(now_ms, reason, now_ms, id).run();
};
async function supersedeHarnessListing(db, oldId, successorId, reason, now_ms) {
  await db.prepare(
    `UPDATE harnesses
          SET superseded_by = ?, claim_status = 'superseded', unlisted_at = ?,
              unlisted_reason = ?, updated_at = ?
        WHERE id = ? AND unlisted_at IS NULL`
  ).bind(successorId, now_ms, reason, now_ms, oldId).run();
};
async function updateHarnessStats(db, id, stats, now_ms) {
  await db.prepare(
    `UPDATE harnesses
         SET stars = ?,
             contributor_count = ?,
             last_activity_at = ?,
             languages = ?,
             stats_refreshed_at = ?,
             updated_at = ?
       WHERE id = ?`
  ).bind(
    stats.stars,
    stats.contributor_count,
    stats.last_activity_at,
    stats.languages,
    now_ms,
    now_ms,
    id
  ).run();
};
async function clearHarnessAttestation(db, id, now_ms) {
  await db.prepare(
    `UPDATE harnesses
         SET publisher_device_pubkey = NULL,
             publisher_attestation_gist_id = NULL,
             updated_at = ?
       WHERE id = ?`
  ).bind(now_ms, id).run();
};
async function setHarnessClaim(db, id, claim, now_ms) {
  await db.prepare(
    `UPDATE harnesses
         SET claim_status = 'claimed',
             claimant_github_user_id = ?,
             claimant_github_login = ?,
             updated_at = ?
       WHERE id = ?`
  ).bind(claim.user_id, claim.login, now_ms, id).run();
};
async function insertReport(db, r) {
  await db.prepare(
    `INSERT INTO reports
         (id, harness_id, reporter_github_user_id, reporter_github_login,
          reason, ip_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(r.id, r.harness_id, r.reporter_github_user_id, r.reporter_github_login, r.reason, r.ip_hash, r.created_at).run();
};
async function listReports(db, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filterStatus = opts.status && opts.status !== "all";
  const sql = `SELECT r.*,
            h.title AS harness_title,
            h.github_url AS harness_github_url,
            h.unlisted_at AS harness_unlisted_at
       FROM reports r
       LEFT JOIN harnesses h ON h.id = r.harness_id` + (filterStatus ? ` WHERE r.status = ?` : ``) + ` ORDER BY r.created_at ASC LIMIT ?`;
  const binds = filterStatus ? [opts.status, limit] : [limit];
  const stmt = db.prepare(sql);
  const bound = stmt.bind(...binds);
  const res = await bound.all();
  return res.results ?? [];
};
async function getReportById(db, id) {
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first();
  return row ?? null;
};
async function resolveReport(db, id, opts) {
  const res = await db.prepare(
    `UPDATE reports
          SET status = ?, resolved_at = ?, resolved_by_operator_note = ?
        WHERE id = ? AND status = 'pending'`
  ).bind(opts.status, opts.now_ms, opts.note, id).run();
  return res.meta?.changes ?? 0;
};
async function audit(db, ts, kind, detail = {}) {
  await db.prepare("INSERT INTO audit (ts, kind, detail) VALUES (?, ?, ?)").bind(ts, kind, JSON.stringify(detail)).run();
};
async function insertCreatorDraft(db, draft) {
  await db.prepare(
    `INSERT INTO creator_drafts
       (id, owner_github_user_id, owner_github_login, listing_kind, listing_ref,
        title, description, manifest_json, provenance_json, state,
        upload_token_hash, upload_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
  ).bind(
    draft.id,
    draft.owner_github_user_id,
    draft.owner_github_login,
    draft.listing_kind,
    draft.listing_ref,
    draft.title,
    draft.description,
    draft.manifest_json,
    draft.provenance_json,
    draft.upload_token_hash,
    draft.upload_expires_at,
    draft.created_at,
    draft.created_at
  ).run();
};
async function getCreatorDraft(db, id) {
  const row = await db.prepare("SELECT * FROM creator_drafts WHERE id = ?").bind(id).first();
  return row ?? null;
};
async function listCreatorDrafts(db, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 201);
  const where = [];
  const binds = [];
  if (opts.ownerId != null) {
    where.push("owner_github_user_id = ?");
    binds.push(opts.ownerId);
  };
  if (opts.state) {
    where.push("state = ?");
    binds.push(opts.state);
  };
  const sql = `SELECT * FROM creator_drafts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`;
  binds.push(limit);
  binds.push(opts.offset ?? 0);
  const stmt = db.prepare(sql);
  const bound = stmt.bind(...binds);
  const result = await bound.all();
  return result.results ?? [];
};
async function setCreatorDraftArtifact(db, id, artifact) {
  const result = await db.prepare(
    `UPDATE creator_drafts
          SET artifact_key = ?, artifact_content_hash = ?, artifact_size_bytes = ?,
              artifact_content_type = ?, upload_token_hash = NULL, upload_expires_at = NULL,
              updated_at = ?
        WHERE id = ? AND state = 'draft'`
  ).bind(artifact.key, artifact.contentHash, artifact.sizeBytes, artifact.contentType, artifact.now, id).run();
  return result.meta?.changes ?? 0;
};
async function setCreatorDraftState(db, id, from, to, now, extra = {}) {
  const result = await db.prepare(
    `UPDATE creator_drafts
          SET state = ?, reviewed_at = COALESCE(?, reviewed_at),
              reviewed_by_github_user_id = COALESCE(?, reviewed_by_github_user_id),
              review_reason = COALESCE(?, review_reason),
              published_listing_id = COALESCE(?, published_listing_id), updated_at = ?
        WHERE id = ? AND state = ?`
  ).bind(
    to,
    extra.reviewedBy == null ? null : now,
    extra.reviewedBy ?? null,
    extra.reviewReason ?? null,
    extra.publishedListingId ?? null,
    now,
    id,
    from
  ).run();
  return result.meta?.changes ?? 0;
};
async function listBannedPubkeySet(db) {
  const res = await db.prepare("SELECT pubkey FROM banned_publisher_pubkeys").all();
  return new Set((res.results ?? []).map((r) => r.pubkey));
};
async function listBannedPubkeys(db) {
  const res = await db.prepare("SELECT * FROM banned_publisher_pubkeys ORDER BY added_at DESC").all();
  return res.results ?? [];
};
async function banPublisherPubkey(db, pubkey, reason, operatorUserId, now_ms) {
  await db.prepare(
    `INSERT INTO banned_publisher_pubkeys (pubkey, reason, added_at, added_by_operator_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = ?, updated_at = ?`
  ).bind(pubkey, reason, now_ms, operatorUserId, now_ms, reason, now_ms).run();
};
async function unbanPublisherPubkey(db, pubkey) {
  await db.prepare("DELETE FROM banned_publisher_pubkeys WHERE pubkey = ?").bind(pubkey).run();
};
function clientIp(req) {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
};
async function ipHash(ip, pepper) {
  if (!ip) return "";
  const enc = new TextEncoder();
  const buf = enc.encode(`${ip}:${pepper}`);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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LEVBQUUsRUFDUCxNQUFNLEdBQUcsRUFBRTtBQUNoQiIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiZGIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDdXBib2FyZCBEMSBoZWxwZXJzIOKAlCB0eXBlZCByb3cgc2hhcGVzICsgaW5zZXJ0L3VwZGF0ZS9zZWxlY3QgcHJpbWl0aXZlcy5cbiAqXG4gKiBUYWJsZSByb3cgdHlwZXMgYXJlIGdlbmVyYXRlZCBmcm9tIHRoZSBmdWxseSBhcHBsaWVkIG1pZ3JhdGlvbiBzZXQuIEhlbHBlcnNcbiAqIGFyZSB0aGluIHdyYXBwZXJzIGFyb3VuZCBwcmVwYXJlZCBzdGF0ZW1lbnRzOyBubyBPUk0sIG5vIHJ1bnRpbWUgYWJzdHJhY3Rpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuL2Vudi50cyc7XG5pbXBvcnQgdHlwZSB7XG4gIEJhbm5lZFB1Ymxpc2hlclB1YmtleXNSb3csXG4gIEhhcm5lc3Nlc1JvdyxcbiAgUmVwb3J0c1Jvdyxcbn0gZnJvbSAnLi9kYi1yb3ctdHlwZXMuZ2VuZXJhdGVkLnRzJztcblxuLyoqIFRoZSBzdG9yZWZyb250IGxpc3Rpbmcga2luZHMgKG1pZ3JhdGlvbnMgMDA0ICsgMDA2ICsgMDA4IC8gRC0wMDUpLiBUaGVcbiAqICBgc25hcHNob3RgIGtpbmQgd2FzIHJldGlyZWQgKHJldGlyZS1zbmFwc2hvdHMtaW5zdGFuY2Utc3BlYy0yMDI2LTA2LTA5IEQtMDA1KTtcbiAqICB0aGUgRDEgYHRhcmJhbGxfKmAgY29sdW1ucyAobWlncmF0aW9uIDAwNSkgcmVtYWluIHZlc3RpZ2lhbC9udWxsYWJsZS5cbiAqICBNaWdyYXRpb24gMDA4IChsZWFybmluZy1wYWNrcy0yMDI2LTA2LTExIEQtMDA1KSByZW5hbWVkIHRoZSBydW50aW1lLWxlc3NcbiAqICBjb2RlLXRvb2wgcGFjayBgcGFja2Ag4oaSIGB0b29sLXBhY2tgIGFuZCBhZGRlZCBgbGVhcm5pbmctcGFja2AuIE1pZ3JhdGlvbiAwMTBcbiAqICAoY3VwYm9hcmQtcHVibGljLXJlbGVhc2UtMjAyNi0wNy0xMiBQLTAwMykgcmVuYW1lcyBpdCBCQUNLIHRvIHRoZSBjYW5vbmljYWxcbiAqICBgcGFja2AgKHBhY2tzIGFyZSB0aGUgdW1icmVsbGEgdGhhdCBhbHNvIGNhcnJ5IGV2ZW50IGRlcHMpLCBzbyBgdG9vbC1wYWNrYFxuICogIGJlY29tZXMgdGhlIGludGVyaW0gd2lyZSBhbGlhczsgYm90aCBgdG9vbC1wYWNrYCBhbmQgdGhlIHByZS0wMDggYHBhY2tgIHN0YXlcbiAqICBhY2NlcHRlZCBvbiB0aGUgd2lyZSBhbmQgbm9ybWFsaXplIHRvIGBwYWNrYCB2aWEgbm9ybWFsaXplTGlzdGluZ0tpbmQuXG4gKiAgTWlncmF0aW9uIDAxMSAoY3VwYm9hcmQtcHVibGljLXJlbGVhc2UtMjAyNi0wNy0xMiBQLTAwMSkgcmVuYW1lc1xuICogIGBsZWFybmluZy1wYWNrYCDihpIgYGtub3dsZWRnZS1wYWNrYDsgdGhlIG9sZCBgbGVhcm5pbmctcGFja2Agd2lyZSB2YWx1ZSBzdGF5c1xuICogIGFjY2VwdGVkIGFuZCBub3JtYWxpemVzIGZvcndhcmQsIHNhbWUgcGF0dGVybi5cbiAqICBgdGVtcGxhdGVgIChhcHAtdGVtcGxhdGVzLTIwMjYtMDctMDQ7IHN0YW5kYXJkLXBhdGggcHVibGlzaCB3aXJlZCBpblxuICogIGN1cGJvYXJkLWZ1bGwtZG9nZm9vZC0yMDI2LTA3LTEwIFAtMDAzKTogYSBmaXJzdC1wYXJ0eSBhcHAtdGVtcGxhdGUgbGlzdGluZyxcbiAqICBHaXRIdWItcmVwby1iYWNrZWQgcGVyIGBsaXN0aW5nX3JlZmAgbGlrZSBhIGJsdWVwcmludC4gUHJldmlvdXNseSB0aGUgMTFcbiAqICBvZmZpY2lhbCB0ZW1wbGF0ZSByb3dzIHdlcmUgc2VlZGVkIGRpcmVjdGx5IChieXBhc3NpbmcgUE9TVCAvbGlzdGluZ3MpOyBpdCBpc1xuICogIG5vdyBhY2NlcHRlZCBvbiB0aGUgcHVibGlzaCBwYXRoIHNvIHRlbXBsYXRlcyBsaXN0IFwiYXMgYXV0aG9yZWQgYnkgcGFwZXJjdXNwXCJcbiAqICB2aWEgdGhlIHN0YW5kYXJkIGZsb3cuXG4gKiAgYGFwcGAgKG1pZ3JhdGlvbiAwMTQgLyBjdXBib2FyZC1hcHAtZGlzdHJpYnV0aW9uLTIwMjYtMDctMTQgUC0wMDEsIEQtMDAxXG4gKiAgW293bmVyIDIwMjYtMDctMTRdKTogYSB3aG9sZSBkaXN0cmlidXRhYmxlIGFwcGxpY2F0aW9uLiBBIFNUQU5EQUxPTkUgYXBwXG4gKiAgKGUuZy4gT2Rkc21pdGgsIGEgVGF1cmkgZGVza3RvcCBhcHAgYnVpbHQgb24gdGhlIHBhcGVyY3VzcCBwbGF0Zm9ybSkgaXMgYVxuICogIHNlcGFyYXRlIGRvd25sb2FkYWJsZSBwcm9kdWN0IOKAlCBcImluc3RhbGxcIiBET1dOTE9BRFMgaXRzIHBsYXRmb3JtIGluc3RhbGxlclxuICogIGZyb20gdGhlIGFwcCdzIG93biBHaXRIdWIgcmVsZWFzZSAodGhlIEN1cGJvYXJkIG5ldmVyIHJlLWhvc3RzIHRoZSBiaW5hcnkpOyBhXG4gKiAgQlVORExFIGFwcCBpcyBhIHBhcGVyY3VzcC1uYXRpdmUgY29tcG9zaXRpb24gaW5zdGFsbGVkIGludG8gdGhlIHdvcmtzcGFjZVxuICogIChQaGFzZSAyKS4gVGhlIGBkZWxpdmVyeV90eXBlYCBjb2x1bW4gZGlzY3JpbWluYXRlcyB0aGUgdHdvLlxuICpcbiAqICBgcnVicmljYCAvIGBwbGFuYCAvIGByZWNpcGVgIChtaWdyYXRpb24gMDE1IC8gY3VwYm9hcmQtcGxhbi1ydWJyaWMtcmVjaXBlLXNoYXJpbmdcbiAqICAtMjAyNi0wOC0yMSBQLTAwMiwgRC0wMDEgW293bmVyIDIwMjYtMDgtMjFdKTogdGhlIHRocmVlIHJldXNhYmxlIEpVREdNRU5UL1BST0NFRFVSRVxuICogIHVuaXRzLiBBIGBydWJyaWNgIGlzIGEgc2VsZi1kZXNjcmliaW5nIHJ1YnJpYyBkaXIgKHJ1YnJpYy5qc29uICsgbGlzdGluZy5qc29uICtcbiAqICBvcHRpb25hbCBNRVRIT0QubWQpIGluc3RhbGxlZCBpbnRvIHRoZSBsYXllcmVkIHJ1YnJpYyBzdG9yZSdzIHVzZXIgbGF5ZXIuIEEgYHBsYW5gXG4gKiAgaXMgYSBwbGFuIFRFTVBMQVRFIOKAlCBnb2FsICsgaXRlbSBEQUcgKyBkZWNpc2lvbnMgKyBzY2hlZHVsZSB3aXRoIGxpdmUgc3RhdGUgc3RyaXBwZWRcbiAqICBhdCBwdWJsaXNoIOKAlCBhbmQgbWF5IGRlY2xhcmUgYHJlcXVpcmVzX3J1YnJpY3NgLiBBIGByZWNpcGVgIGlzIGEgY2FwdHVyZWQgbXVsdGktc3RlcFxuICogIHRvb2wgb3JjaGVzdHJhdGlvbi4gQWxsIHRocmVlIGluc3RhbGwuXG4gKlxuICogIGBnb2FsYCAobWlncmF0aW9uIDAxNiAvIHdvcmstb24tZXZlcnl0aGluZy1nb2FsLTIwMjYtMDgtMjMgUC0wMDYsIEQtMDAyXG4gKiAgW293bmVyIDIwMjYtMDgtMjNdKTogYSBHT0FMIFBBQ0tBR0Ug4oCUIHRpdGxlICsgZHV0aWVzIGJvZHkva2lja29mZiBicmllZiArIHN0YW5kaW5nXG4gKiAgZmxhZyArIHRyaXB3aXJlL2J1ZGdldC13aW5kb3cvbGF1bmNoLXNldHRpbmcgZGVmYXVsdHMgKyBpbnB1dC9vdXRwdXQgc2NoZW1hcywgYXMgYVxuICogIHNlbGYtZGVzY3JpYmluZyBkaXIgKGdvYWwuanNvbiArIGxpc3RpbmcuanNvbikuIEluc3RhbGxpbmcgbGFuZHMgYW4gSU5BQ1RJVkUgZ29hbFxuICogIHN0dWIgKG5vIGFnZW50LCBubyBzcGVuZCksIE5PLUNMT0JCRVI7IHN0YXJ0aW5nIGl0IGlzIGEgc2VwYXJhdGUgZGVsaWJlcmF0ZSBhY3QuXG4gKiAgTWF5IGRlY2xhcmUgYHJlcXVpcmVzX3J1YnJpY3NgLCBzYW1lIGFzIGBwbGFuYC4gKi9cbmV4cG9ydCBjb25zdCBMSVNUSU5HX0tJTkRTID0gW1xuICAnaGFybmVzcycsXG4gICdibHVlcHJpbnQnLFxuICAncGx1Z2luJyxcbiAgJ3BhY2snLFxuICAna25vd2xlZGdlLXBhY2snLFxuICAndGVtcGxhdGUnLFxuICAnYXBwJyxcbiAgJ3J1YnJpYycsXG4gICdwbGFuJyxcbiAgJ3JlY2lwZScsXG4gICdnb2FsJyxcbiAgLy8gbWlncmF0aW9uIDAyNCAvIGN1cGJvYXJkLXRoZW1lcy0yMDI2LTA5LTA1OiBpbmVydCBzZW1hbnRpYy10b2tlbiBwYWNrYWdlO1xuICAvLyBpbnN0YWxsIG1ha2VzIGl0IGxvY2FsbHkgc2VsZWN0YWJsZSB0aHJvdWdoIHRoZSBleGlzdGluZyB0aGVtZSBydW50aW1lLlxuICAndGhlbWUnLFxuICAvLyBtaWdyYXRpb24gMDI5IC8gaWRlbnRpdGllcy12MS0yMDI2LTA4LTMwIFAtMDI3LCBELTAxMDogYSBEQVRBVFlQRSBQQUNLQUdFIOKAlFxuICAvLyB0aGUgc2NoZW1hICsgbGlmZWN5Y2xlIGEgd29ya3NwYWNlIGluc3RhbGxzIHNvIGB3b3JrX2l0ZW1zYCBhbmQgdGhlIHN1cmZhY2VzXG4gIC8vIG92ZXIgaXQgYWNjZXB0IGEgbmV3IGl0ZW0ga2luZC4gSXQgaGFkIGdyb3duIGEgU0VDT05EIHN0b3JlZnJvbnQgb2YgaXRzIG93blxuICAvLyAoYGRhdGF0eXBlczpwdWJsaXNoYCBtYXJraW5nIGl0cyBvd24gcGVuZGluZyBxdWV1ZSwgYGRhdGF0eXBlczpjYXRhbG9nYFxuICAvLyBicm93c2luZyBpdCk7IHRoaXMgZm9sZHMgcHVibGlzaCticm93c2UgYmFjayBpbnRvIHRoZSBvbmUgQ3VwYm9hcmQgc3VyZmFjZSxcbiAgLy8gd2l0aCBgZGF0YXR5cGVfcmVnaXN0cnlgIGtlcHQgYXMgdGhlIHJlc29sdXRpb24gbGF5ZXIgaXQgYWx3YXlzIHdhcy5cbiAgJ2RhdGF0eXBlJyxcbiAgLy8gbWlncmF0aW9uIDAzMCAvIGlkZW50aXRpZXMtdjEtMjAyNi0wOC0zMCBQLTAyOCwgRC0wMTEgLyBELTA1NDogYW4gaW5zdGFsbGFibGVcbiAgLy8gQkVIQVZJT1VSIOKAlCBcIndoZW4gWCwgZmlyZSBZXCIg4oCUIGJlc2lkZSBgcmVjaXBlYCwgd2hpY2ggaXQgY2xvc2VseSByZXNlbWJsZXMuXG4gIC8vIFdoYXQgbWFrZXMgaXQgcG9ydGFibGUgaXMgdGhhdCBhIHN0YW5kYWxvbmUgcnVsZSBmaXJlcyBhIGNhcGFiaWxpdHkgQ0xBU1MsXG4gIC8vIG5vdCBhIHRvb2wgaWQgKEQtMDA0KTogdGhlIGluc3RhbGxpbmcgcG90J3Mgb3duIHByb3ZpZGVyIGJpbmRpbmcgZGVjaWRlc1xuICAvLyB3aGljaCB0b29sIGFjdHVhbGx5IHJ1bnMsIHNvIG9uZSBsaXN0aW5nIHNoaXBzIGFjcm9zcyBwb3RzIHdpdGggZGlmZmVyZW50XG4gIC8vIHByb3ZpZGVycy4gUmVzb2x2ZXMgaW50byB0aGUgU0FNRSByZWFjdGlvbiByZWdpc3RyeSBhcyBldmVyeSBidWlsdC1pbiBhbmRcbiAgLy8gcGx1Z2luIHJ1bGUg4oCUIG5vIHNlY29uZCBlbmdpbmUsIG5vIHNlY29uZCBjb25kaXRpb24gbGFuZ3VhZ2UuXG4gICdydWxlJyxcbiAgLy8gbWlncmF0aW9uIDAzMSAvIGlkZW50aXRpZXMtdjEtMjAyNi0wOC0zMCBQLTAyOSwgRC0wMTAgLyBELTAxMTogYW4gRVZFTlQtS0VZXG4gIC8vIERFQ0xBUkFUSU9OIOKAlCBhIHZlcnNpb25lZCBrZXkgZmFtaWx5IHBsdXMgaXRzIHBheWxvYWQgc2NoZW1hIGFuZCBkaXNjb3ZlcnlcbiAgLy8gbWV0YWRhdGEuIFRoZSBQUk9WSURFUiBoYWxmIG9mIGFuIGF4aXMgd2hvc2UgY29uc3VtZXIgaGFsZiBhbHJlYWR5IGV4aXN0czpcbiAgLy8gYHJlcXVpcmVzX2V2ZW50c2AgKG1pZ3JhdGlvbiAwMTMpIGhhcyBiZWVuIGFibGUgdG8gZGVwZW5kIG9uIGEgZmFtaWx5IHNpbmNlXG4gIC8vIHRoZSBDdXBib2FyZCdzIGZpcnN0IHJlbGVhc2UsIGFuZCBhbiB1bnJlc29sdmFibGUgcmVxdWlyZWQgZmFtaWx5IGlzIGEgSEFSRFxuICAvLyBpbnN0YWxsIGZhaWx1cmUg4oCUIGJ1dCBub3RoaW5nIGNvdWxkIGV2ZXIgUFVCTElTSCBvbmUsIHNvIHRoZSBvbmx5IGZhbWlsaWVzXG4gIC8vIHRoYXQgZXZlciByZXNvbHZlZCB3ZXJlIGZpcnN0LXBhcnR5LiBUaGlzIGNsb3NlcyB0aGF0IGhhbGYuXG4gIC8vXG4gIC8vIEFuIGV2ZW50IGxpc3RpbmcgZmlyZXMgbm90aGluZzsgYHJ1bGVgIGlzIHdoYXQgZmlyZXMuIFdoYXQgaXQgZG9lcyBkbyBpc1xuICAvLyBtYWtlIGEgZmFtaWx5IFJFU09MVkFCTEUsIHdoaWNoIGlzIHdoeSBpdCBpcyByZXZpZXctZ2F0ZWQgcmF0aGVyIHRoYW4gaW5lcnRcbiAgLy8gKHNlZSBSRVZJRVdfUE9MSUNZX0tJTkRTIGJlbG93KS5cbiAgJ2V2ZW50Jyxcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBMaXN0aW5nS2luZCA9ICh0eXBlb2YgTElTVElOR19LSU5EUylbbnVtYmVyXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzTGlzdGluZ0tpbmQodjogdW5rbm93bik6IHYgaXMgTGlzdGluZ0tpbmQge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIChMSVNUSU5HX0tJTkRTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2KTtcbn1cblxuLyoqIFdpcmUtY29tcGF0OiBub3JtYWxpemUgbGVnYWN5IGxpc3Rpbmcta2luZCB2YWx1ZXMgdG8gdGhlaXIgY2Fub25pY2FsIGZvcm0uXG4gKlxuICogIC0gJ3Rvb2wtcGFjaycgICAgIOKGkiAncGFjaycgICAgICAgICAgICAoaW50ZXJpbSBhbGlhcyBmcm9tIG1pZ3JhdGlvbiAwMDg7IGNhbm9uaWNhbGl6ZWQgYnkgMDEwIC8gUC0wMDMpXG4gKiAgLSAnbGVhcm5pbmctcGFjaycg4oaSICdrbm93bGVkZ2UtcGFjaycgIChyZW5hbWVkIGJ5IG1pZ3JhdGlvbiAwMTEgLyBQLTAwMSlcbiAqXG4gKiAgQSBwcmUtMDA4IGxpdGVyYWwgJ3BhY2snIGFscmVhZHkgSVMgY2Fub25pY2FsIGFuZCBwYXNzZXMgdGhyb3VnaCBpc0xpc3RpbmdLaW5kLlxuICpcbiAqICBUaGlzIGlzIGEgVFJVRSBCT1VOREFSWSAoa25vd2xlZGdlLXBhY2tzLTIwMjYtMDctMTEgRC0wMDEpOiB0aGUgcmVuYW1lIGlzIEhBUkRcbiAqICBpbnRlcm5hbGx5IHdpdGggbm8gYWxpYXNlcywgYnV0IGFuIGFscmVhZHktcHVibGlzaGVkIGxpc3Rpbmcgcm93IGFuZCBhbnkgY2xpZW50XG4gKiAgYnVpbHQgYWdhaW5zdCB0aGUgb2xkIEFQSSBzdGlsbCBzcGVhayAnbGVhcm5pbmctcGFjaycgb24gdGhlIHdpcmUsIHNvIGl0IG11c3RcbiAqICBrZWVwIHBhcnNpbmcuIEl0IG5vcm1hbGl6ZXMgRk9SV0FSRCDigJQgbm90aGluZyBkb3duc3RyZWFtIGV2ZXIgc2VlcyB0aGUgb2xkIHZhbHVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUxpc3RpbmdLaW5kKHY6IHVua25vd24pOiBMaXN0aW5nS2luZCB8IG51bGwge1xuICBpZiAodiA9PT0gJ3Rvb2wtcGFjaycpIHJldHVybiAncGFjayc7XG4gIGlmICh2ID09PSAnbGVhcm5pbmctcGFjaycpIHJldHVybiAna25vd2xlZGdlLXBhY2snO1xuICByZXR1cm4gaXNMaXN0aW5nS2luZCh2KSA/IHYgOiBudWxsO1xufVxuXG4vKipcbiAqIFByZS1wdWJsaWNhdGlvbiByZXZpZXcgcG9saWN5IChrbm93bGVkZ2UtcGFja3MgRC0wMDcpOiB0aGUgSU5TVFJVQ1RJT04tXG4gKiBDQVJSWUlORyBraW5kcyDigJQgY29udGVudCBpbmplY3RlZCBpbnRvIGFnZW50IGNvbnRleHQgKGtub3dsZWRnZSBwYWNrcykgb3JcbiAqIHJ1biBhcyBhZ2VudCByb2xlcyAoYmx1ZXByaW50cykg4oCUIGxhbmQgYHBlbmRpbmdgIGF0IHB1Ymxpc2ggYW5kIGdvIHB1YmxpY1xuICogb25seSBvbiBvcGVyYXRvciBhcHByb3ZhbC4gQ29kZSBraW5kcyBrZWVwIGluc3RhbGwtY29uc2VudCArIHJlYWN0aXZlXG4gKiBtb2RlcmF0aW9uLlxuICpcbiAqIGBhcHBgIChjdXBib2FyZC1hcHAtZGlzdHJpYnV0aW9uLTIwMjYtMDctMTQgUC0wMDEsIEQtMDAxKTogYW4gYXBwIGRpc3RyaWJ1dGVzIGFcbiAqIHJ1bm5hYmxlIEVYRUNVVEFCTEUgKGEgc3RhbmRhbG9uZSBpbnN0YWxsZXIpIOKAlCB0aGUgaGlnaGVzdC10cnVzdCB0aGluZyB0aGVcbiAqIEN1cGJvYXJkIGNhcnJpZXMg4oCUIHNvIGl0IGlzIGZhaWwtY2xvc2VkIGhlcmU6IGFuIGFwcCBwdWJsaXNoZXMgYHBlbmRpbmdgIGFuZCBpc1xuICogcHVibGljbHkgaW52aXNpYmxlIHVudGlsIHJldmlld2VkLiBUaGlzIGlzIHRoZSBzYWZlIGRlZmF1bHQgdGhlIG1vbWVudCB0aGUga2luZFxuICogZXhpc3RzLCBzbyB0aGUgZXZlbnR1YWwgcHVibGlzaCBwYXRoIChQLTAwMykgY2FuIG5ldmVyIG1ha2UgYW4gYXBwIHB1YmxpY1xuICogd2l0aG91dCByZXZpZXcuIFRoZSBtb2RlcmF0aW9uICpmbG93KiArIHdobyByZXZpZXdzIGlzIFAtMDA2IC8gdGhlIG9wZW4gUC0wMTJcbiAqIG93bmVyIHdhbGwgb24gY3VwYm9hcmQtcHVibGljLXJlbGVhc2UtMjAyNi0wNy0xMiAod2hpY2ggdGhpcyBraW5kIGVzY2FsYXRlcykuXG4gKlxuICogYHJ1YnJpY2AgLyBgcGxhbmAgLyBgcmVjaXBlYCAobWlncmF0aW9uIDAxNSAvIGN1cGJvYXJkLXBsYW4tcnVicmljLXJlY2lwZS1zaGFyaW5nXG4gKiBELTAwMik6IGFsbCB0aHJlZSBhcmUgZmFpbC1jbG9zZWQgZm9yIHRoZSBTQU1FIHJlYXNvbiBrbm93bGVkZ2UtcGFjayBhbmQgYmx1ZXByaW50XG4gKiBhcmUg4oCUIGVhY2ggaXMgaW5zdHJ1Y3Rpb24tY2FycnlpbmcgY29udGVudCB0aGF0IGxhbmRzIGluIGFuIGFnZW50J3MgY29udGV4dCBvclxuICogZXhlY3V0aW9uIHBhdGgsIG5vdCBpbmVydCBkYXRhOlxuICogICAtIGEgYHJ1YnJpY2Agc3VwcGxpZXMgdGhlIGNyaXRlcmlhICsgTUVUSE9ELm1kIHJ1bmJvb2sgYnkgd2hpY2ggd29yayBpcyBHUkFERUQsXG4gKiAgICAgc28gYSBob3N0aWxlIG9uZSBzaWxlbnRseSBjb3JydXB0cyBldmVyeSBhY2NlcHRhbmNlIHZlcmRpY3QgaXQgdG91Y2hlcztcbiAqICAgLSBhIGBwbGFuYCBpcyBhIGdvYWwgKyBpdGVtIERBRyBhZ2VudHMgRVhFQ1VURSDigJQgdGhlIG1vc3QgZGlyZWN0bHkgYWN0dWF0aW5nXG4gKiAgICAgY29udGVudCB0aGUgQ3VwYm9hcmQgY2FycmllcyBzaG9ydCBvZiBhbiBhcHA7XG4gKiAgIC0gYSBgcmVjaXBlYCBpcyBhIHJ1bm5hYmxlIG11bHRpLXN0ZXAgdG9vbCBvcmNoZXN0cmF0aW9uLlxuICogQmVpbmcgaW4gdGhpcyBsaXN0IGZyb20gdGhlIG1vbWVudCB0aGUga2luZHMgZXhpc3QgbWVhbnMgbm8gcHVibGlzaCBwYXRoIGJ1aWx0XG4gKiBsYXRlciBjYW4gbWFrZSBvbmUgb2YgdGhlbSBwdWJsaWMgd2l0aG91dCByZXZpZXcuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVZJRVdfUE9MSUNZX0tJTkRTOiByZWFkb25seSBMaXN0aW5nS2luZFtdID0gW1xuICAna25vd2xlZGdlLXBhY2snLFxuICAnYmx1ZXByaW50JyxcbiAgJ2FwcCcsXG4gICdydWJyaWMnLFxuICAncGxhbicsXG4gICdyZWNpcGUnLFxuICAvLyBtaWdyYXRpb24gMDE2IC8gd29yay1vbi1ldmVyeXRoaW5nLWdvYWwtMjAyNi0wOC0yMyBQLTAwNjogYSBnb2FsIHBhY2thZ2UgaXNcbiAgLy8gZHV0aWVzIHByb3NlIGFuIGFnZW50IEVYRUNVVEVTIChhIGtpY2tvZmYgYnJpZWYgKyBsYXVuY2ggZGVmYXVsdHMpIOKAlCB0aGUgc2FtZVxuICAvLyBmYWlsLWNsb3NlZCByZWFzb25pbmcgYXMgYHBsYW5gLCBpbiB0aGUgbGlzdCBmcm9tIHRoZSBtb21lbnQgdGhlIGtpbmQgZXhpc3RzLlxuICAnZ29hbCcsXG4gIC8vIG1pZ3JhdGlvbiAwMjkgLyBpZGVudGl0aWVzLXYxLTIwMjYtMDgtMzAgUC0wMjc6IGEgZGF0YXR5cGUgcGFja2FnZSBpbnN0YWxscyBhXG4gIC8vIFNDSEVNQSArIExJRkVDWUNMRSB0aGF0IGdvdmVybnMgaG93IGB3b3JrX2l0ZW1zYCBvZiB0aGF0IGtpbmQgYmVoYXZlIOKAlCBpdCBsYW5kc1xuICAvLyBpbiB0aGUgZXhlY3V0aW9uIHBhdGggb2YgZXZlcnkgc3VyZmFjZSBvdmVyIHRoZW0sIHNvIGl0IGlzIGFjdHVhdGluZywgbm90IGluZXJ0LlxuICAvLyBJdCBpcyBhbHNvIGEgUFJFU0VSVkVEIHNlbWFudGljLCBub3QgYSBuZXcgb25lOiB0aGUgcGFyYWxsZWwgYGRhdGF0eXBlczpwdWJsaXNoYFxuICAvLyBzdXJmYWNlIHRoaXMgY29uc29saWRhdGlvbiByZXRpcmVzIGFscmVhZHkgbWFya2VkIGl0cyBvd24gbGlzdGluZ3MgcGVuZGluZyBmb3JcbiAgLy8gb3BlcmF0b3IgbW9kZXJhdGlvbiAoRC0wMTApLiBPbWl0dGluZyBpdCBoZXJlIHdvdWxkIGhhdmUgbWFkZSBmb2xkaW5nIHRoYXRcbiAgLy8gc3VyZmFjZSBpbnRvIHRoZSBDdXBib2FyZCBhIHNpbGVudCBkb3duZ3JhZGUgZnJvbSBtb2RlcmF0ZWQgdG8gYXV0by1hcHByb3ZlZC5cbiAgJ2RhdGF0eXBlJyxcbiAgLy8gbWlncmF0aW9uIDAzMCAvIGlkZW50aXRpZXMtdjEtMjAyNi0wOC0zMCBQLTAyOCwgRC0wMTEgLyBELTA1NDogYSBydWxlIGlzIHRoZVxuICAvLyBtb3N0IGFjdHVhdGluZyBraW5kIGluIHRoaXMgbGlzdC4gYHJlY2lwZWAgYW5kIGBnb2FsYCBhcmUgb3JjaGVzdHJhdGlvbiBhXG4gIC8vIHBlcnNvbiBvciBhZ2VudCBzdGlsbCBjaG9vc2VzIHRvIFJVTjsgYSBydWxlIGlzIFwid2hlbiBYLCBmaXJlIFlcIiDigJQgaXQgZmlyZXNcbiAgLy8gQlkgSVRTRUxGIG9uIGEgbWF0Y2hpbmcgZXZlbnQsIGluIHRoZSBpbnN0YWxsaW5nIHBvdCwgdW5kZXIgdGhlIGNhcGFiaWxpdHlcbiAgLy8gaXRzIGZpcmVkIENMQVNTIGRlY2xhcmVzLiBBdXRvLWFwcHJvdmluZyBpdCB3b3VsZCBsZXQgYW55IHB1Ymxpc2hlciBwdXRcbiAgLy8gc2VsZi1maXJpbmcgYmVoYXZpb3VyIGludG8gZXZlcnkgaW5zdGFsbGluZyBwb3Qgd2l0aCBubyBvcGVyYXRvciBldmVyXG4gIC8vIGxvb2tpbmcgYXQgaXQuIFRoZSBjcml0ZXJpb24gdGhpcyBsaXN0IGFscmVhZHkgYXBwbGllcyDigJQgYWN0dWF0aW5nIHB1Ymxpc2hlc1xuICAvLyBwZW5kaW5nLCBpbmVydCBwdWJsaXNoZXMgYXBwcm92ZWQgKGB0aGVtZWAgaXMgdGhlIGluZXJ0IGNhc2UpIOKAlCBwdXRzIGBydWxlYFxuICAvLyBvbiB0aGUgcGVuZGluZyBzaWRlIGEgZm9ydGlvcmksIHNvIGl0IGlzIGluIHRoZSBsaXN0IGZyb20gdGhlIG1vbWVudCB0aGVcbiAgLy8ga2luZCBleGlzdHMgcmF0aGVyIHRoYW4gYmVpbmcgdGlnaHRlbmVkIGxhdGVyLlxuICAncnVsZScsXG4gIC8vIG1pZ3JhdGlvbiAwMzEgLyBpZGVudGl0aWVzLXYxLTIwMjYtMDgtMzAgUC0wMjksIEQtMDEwOiBhbiBldmVudCBsaXN0aW5nXG4gIC8vIEZJUkVTIG5vdGhpbmcsIHNvIHRoZSBhY3R1YXRpbmcvaW5lcnQgY3JpdGVyaW9uIGFib3ZlIGRvZXMgbm90IGJ5IGl0c2VsZlxuICAvLyBwdXQgaXQgaGVyZSDigJQgYHRoZW1lYCBpcyBpbmVydCBhbmQgcHVibGlzaGVzIGFwcHJvdmVkLiBUd28gdGhpbmdzIGRvLlxuICAvL1xuICAvLyAoMSkgVGhlIFNBTUUgcHJlc2VydmVkLXNlbWFudGljIHJlYXNvbmluZyBhcyBgZGF0YXR5cGVgIGRpcmVjdGx5IGFib3ZlLlxuICAvLyAgICAgVGhlIGV2ZW50LWtleSBzcGFjZSB0b2RheSBpcyBmaXJzdC1wYXJ0eSBjdXJhdGVkIChFVkVOVF9DQVRBTE9HKTtcbiAgLy8gICAgIG1ha2luZyBpdCB0aGlyZC1wYXJ0eS1wdWJsaXNoYWJsZSB3aGlsZSBhdXRvLWFwcHJvdmluZyBpdCB3b3VsZCBiZSBhXG4gIC8vICAgICBzaWxlbnQgZG93bmdyYWRlIGZyb20gY3VyYXRlZCB0byB1bm1vZGVyYXRlZCwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAgLy8gICAgIGRvd25ncmFkZSBgZGF0YXR5cGVgIHdhcyBhZGRlZCBoZXJlIHRvIGF2b2lkLlxuICAvLyAoMikgQSBwdWJsaXNoZWQga2V5IGNhbiBTUVVBVCBvciBzaGFkb3cgYSBmaXJzdC1wYXJ0eSBmYW1pbHksIGFuZCBhblxuICAvLyAgICAgaW5zdGFsbGVkIHNxdWF0IGNoYW5nZXMgd2hhdCBldmVyeSBgcmVxdWlyZXNfZXZlbnRzYCBkZXAgYW5kIGV2ZXJ5XG4gIC8vICAgICBydWxlIGBvbmAgaW4gdGhhdCBwb3QgcmVzb2x2ZXMgdG8uIFRoYXQgaXMgbmFtZXNwYWNlIGNhcHR1cmUsIG5vdFxuICAvLyAgICAgZXhlY3V0aW9uIOKAlCBidXQgaXRzIGJsYXN0IHJhZGl1cyBpcyB0aGUgc2FtZS5cbiAgLy9cbiAgLy8gUGVuZGluZyBpcyBhbHNvIHRoZSByZWNvdmVyYWJsZSBkaXJlY3Rpb246IGFuIG92ZXItbW9kZXJhdGVkIGtpbmQgY2FuIGJlXG4gIC8vIGxvb3NlbmVkLCB3aGVyZWFzIGFuIGF1dG8tYXBwcm92ZWQgc3F1YXQgaXMgYWxyZWFkeSBwdWJsaXNoZWQgYW5kIHB1YmxpY1xuICAvLyBiZWZvcmUgYW55b25lIGxvb2tzLiBXaGVuIFAtMDI5J3MgZXZlbnQta2V5IHJlZ2lzdHJ5IGxhbmRzIGEgU1RSVUNUVVJBTFxuICAvLyBuYW1lc3BhY2UgZ3VhcmQgKHB1Ymxpc2hlci1zY29wZWQgcHJlZml4ZXMg4oCUIHRoZSBkZXJpdmVkLXRydXRoIGFuc3dlcixcbiAgLy8gc2luY2Ugbm8gb3BlcmF0b3IgY2FuIGV5ZWJhbGwgYSBzcXVhdCB3aXRob3V0IGtub3dpbmcgdGhlIHdob2xlIGtleVxuICAvLyBzcGFjZSksIHJldmlzaXQgdGhpcyBlbnRyeTsgZG8gbm90IGxvb3NlbiBpdCBiZWZvcmUgdGhhdCBndWFyZCBleGlzdHMuXG4gICdldmVudCcsXG5dO1xuXG4vKipcbiAqIFRoZSByZXZpZXcgc3RhdHVzIGEgcHVibGlzaCBsYW5kcyBpbiAocHJlLXB1YmxpY2F0aW9uIHJldmlldywga25vd2xlZGdlLXBhY2tzIEQtMDA3KS4gQ29udGVudC1hd2FyZVxuICogc2luY2UgcGxhbi1pdGVtLXR5cGVzLXJlZ2lzdHJ5LWN1cGJvYXJkLTIwMjYtMTAtMjAgUC0wMDYgKEQtMDA4KTogYSBSRVZJRVdfUE9MSUNZX0tJTkRTIGtpbmQgYWx3YXlzXG4gKiBsYW5kcyBwZW5kaW5nLCBhbmQgc28gZG9lcyBBTlkgbGlzdGluZyB0aGF0IGRlY2xhcmVzIGFuIGl0ZW0gdHlwZSBvciBhIHBsYW4gdHlwZS4gQSB0eXBlIGRlZmluaXRpb25cbiAqIGRlY2lkZXMgd2hpY2ggY2hlY2tzIGV2ZXJ5IHBsYW4gaXRlbSBvZiB0aGF0IHR5cGUgaXMgaGVsZCB0bywgc28gaXQgYWN0dWF0ZXMgZXZlbiBpbnNpZGUgYW5cbiAqIG90aGVyd2lzZSB0b29sLW9ubHkgYHBhY2tgLiBBIHBhY2sgdGhhdCBkZWNsYXJlcyBubyB0eXBlcyBrZWVwcyB0b2RheSdzIHBlci1raW5kIHBvbGljeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB1Ymxpc2hSZXZpZXdTdGF0dXMoXG4gIGtpbmQ6IExpc3RpbmdLaW5kLFxuICBkZWNsYXJlczogeyBpdGVtVHlwZXM6IG51bWJlcjsgcGxhblR5cGVzOiBudW1iZXIgfSxcbik6ICdwZW5kaW5nJyB8ICdhcHByb3ZlZCcge1xuICBpZiAoUkVWSUVXX1BPTElDWV9LSU5EUy5pbmNsdWRlcyhraW5kKSkgcmV0dXJuICdwZW5kaW5nJztcbiAgcmV0dXJuIGRlY2xhcmVzLml0ZW1UeXBlcyArIGRlY2xhcmVzLnBsYW5UeXBlcyA+IDAgPyAncGVuZGluZycgOiAnYXBwcm92ZWQnO1xufVxuXG5leHBvcnQgdHlwZSBSZXZpZXdTdGF0dXMgPSAncGVuZGluZycgfCAnYXBwcm92ZWQnIHwgJ3JlamVjdGVkJztcblxuLyoqXG4gKiBDYXRhbG9nIHZpc2liaWxpdHkgKG1pZ3JhdGlvbiAwMTggLyBzaGFyZWQtcG90LWRhby1jdXBib2FyZC12MS0yMDI2LTA5LTA0IFAtMDA4KS5cbiAqXG4gKiAgIHB1YmxpYyAgIOKAlCBsaXN0ZWQgaW4gdGhlIGdsb2JhbCBjYXRhbG9nLiBFdmVyeSBwcmUtMDE4IHJvdyBkZWZhdWx0cyBoZXJlLCBzb1xuICogICAgICAgICAgICAgIHRoZSBtaWdyYXRpb24gcHJlc2VydmVzIGV4aXN0aW5nIGJyb3dzZSBiZWhhdmlvciBleGFjdGx5LlxuICogICB1bmxpc3RlZCDigJQgcmVhY2hhYmxlIGJ5IGRpcmVjdCBpZC9saXN0aW5nX3JlZiwgbmV2ZXIgcmV0dXJuZWQgYnkgYnJvd3NlLlxuICogICBwcml2YXRlICDigJQgdmlzaWJsZSBvbmx5IGluc2lkZSB0aGUgb3duaW5nIHRlbmFudCAoYHRlbmFudF9pZGApLlxuICpcbiAqIFJlYWQgcGF0aHMgYXJlIEZBSUwtQ0xPU0VEOiB0aGUgYnJvd3NlIHByZWRpY2F0ZSBhZG1pdHMgb25seSBgcHVibGljYCB1bmxlc3MgYVxuICogY2FsbGVyIHN1cHBsaWVzIGEgYHRlbmFudF9zY29wZWAsIHNvIGEgbmV3IHZpc2liaWxpdHkgdmFsdWUgY2FuIG5ldmVyIGxlYWsgYnlcbiAqIGJlaW5nIGZvcmdvdHRlbiBpbiBhIGZpbHRlci5cbiAqL1xuZXhwb3J0IGNvbnN0IExJU1RJTkdfVklTSUJJTElUSUVTID0gWydwdWJsaWMnLCAndW5saXN0ZWQnLCAncHJpdmF0ZSddIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgTGlzdGluZ1Zpc2liaWxpdHkgPSAodHlwZW9mIExJU1RJTkdfVklTSUJJTElUSUVTKVtudW1iZXJdO1xuXG5leHBvcnQgZnVuY3Rpb24gaXNMaXN0aW5nVmlzaWJpbGl0eSh2OiB1bmtub3duKTogdiBpcyBMaXN0aW5nVmlzaWJpbGl0eSB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgKExJU1RJTkdfVklTSUJJTElUSUVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2KTtcbn1cblxuLyoqXG4gKiBQcm92aWRlci1uZXV0cmFsIHByaWNpbmcgbW9kZWwgKG1pZ3JhdGlvbiAwMTggLyBQLTAwOCwgRC0wMjUgKyBELTAyOCkuXG4gKlxuICogRGVsaWJlcmF0ZWx5IE5PVCBhIHBheW1lbnQtcHJvdmlkZXIgY29uY2VwdDogdGhlIGNhdGFsb2cgc3RvcmVzIHdoYXQgdGhlIHVuaXRcbiAqIENPU1RTIGFuZCBob3cgaXQgaXMgY2hhcmdlZCwgbmV2ZXIgd2hpY2ggYWRhcHRlciBjb2xsZWN0cyBpdC4gQSBzZXR0bGVtZW50XG4gKiBhZGFwdGVyIG1hcHMgYHNrdV9yZWZgIG9udG8gaXRzIG93biBwcm9kdWN0OyBub3RoaW5nIGhlcmUgbWF5IG5hbWUgU3RyaXBlLCBhXG4gKiBnYXRld2F5IFVSTCwgb3IgYSBibG9iIHByb3ZpZGVyLlxuICovXG5leHBvcnQgY29uc3QgUFJJQ0lOR19NT0RFTFMgPSBbJ2ZyZWUnLCAnb25lLXRpbWUnLCAnc3Vic2NyaXB0aW9uJywgJ3Blci11c2UnXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFByaWNpbmdNb2RlbCA9ICh0eXBlb2YgUFJJQ0lOR19NT0RFTFMpW251bWJlcl07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1ByaWNpbmdNb2RlbCh2OiB1bmtub3duKTogdiBpcyBQcmljaW5nTW9kZWwge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIChQUklDSU5HX01PREVMUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXModik7XG59XG5cbmV4cG9ydCB0eXBlIEhhcm5lc3NSb3cgPSBPbWl0PFxuICBIYXJuZXNzZXNSb3csXG4gICdsaXN0aW5nX2tpbmQnIHwgJ2NsYWltX3N0YXR1cycgfCAncmV2aWV3X3N0YXR1cycgfCAnZGVsaXZlcnlfdHlwZScgfCAndmlzaWJpbGl0eScgfCAncHJpY2luZ19tb2RlbCdcbj4gJiB7XG4gIC8vIENhdGFsb2cgYXhlcyAobWlncmF0aW9uIDAxOCAvIFAtMDA4KS4gYHZpc2liaWxpdHlgIGlzIE5PVCBOVUxMIHdpdGggYVxuICAvLyAncHVibGljJyBkZWZhdWx0IHNvIGV2ZXJ5IHByZS0wMTggcm93IHJlYWRzIGFzIHB1YmxpYzsgdGhlIHJlc3QgYXJlIG51bGwgb25cbiAgLy8gYSByb3cgdGhhdCBoYXMgbm90IGRlY2xhcmVkIHRoYXQgYXhpcy5cbiAgdmlzaWJpbGl0eTogTGlzdGluZ1Zpc2liaWxpdHk7XG4gIC8qKiBPd25pbmcgc2hhcmVkIHBvdC4gTlVMTCA9IHRoZSBnbG9iYWwgcHVibGljIGNhdGFsb2cuICovXG4gIHRlbmFudF9pZDogc3RyaW5nIHwgbnVsbDtcbiAgcHJpY2luZ19tb2RlbDogUHJpY2luZ01vZGVsIHwgbnVsbDtcbiAgLyoqIFN0b3JlZnJvbnQga2luZCAobWlncmF0aW9uIDAwNCkuIERlZmF1bHQgJ2hhcm5lc3MnIGZvciBwcmUtMDA0IHJvd3MuICovXG4gIGxpc3Rpbmdfa2luZDogTGlzdGluZ0tpbmQ7XG4gIGNsYWltX3N0YXR1czogJ3VuY2xhaW1lZCcgfCAnY2xhaW1lZCcgfCAnc3RhbGUnIHwgJ3N1cGVyc2VkZWQnO1xuICAvLyBQcmUtcHVibGljYXRpb24gcmV2aWV3IChtaWdyYXRpb24gMDA4IC8ga25vd2xlZGdlLXBhY2tzIEQtMDA3KS4gUG9saWN5XG4gIC8vIGtpbmRzIHB1Ymxpc2ggJ3BlbmRpbmcnOyBldmVyeXRoaW5nIGVsc2UgKGFuZCBldmVyeSBwcmUtMDA4IHJvdykgaXNcbiAgLy8gJ2FwcHJvdmVkJy4gcmV2aWV3ZWRfYXQvcmV2aWV3X3JlYXNvbiBjYXJyeSB0aGUgb3BlcmF0b3IgZGVjaXNpb24uXG4gIHJldmlld19zdGF0dXM6IFJldmlld1N0YXR1cztcbiAgcmV2aWV3ZWRfYXQ6IG51bWJlciB8IG51bGw7XG4gIHJldmlld19yZWFzb246IHN0cmluZyB8IG51bGw7XG4gIC8vIEFwcCBkaXN0cmlidXRpb24gKG1pZ3JhdGlvbiAwMTQgLyBjdXBib2FyZC1hcHAtZGlzdHJpYnV0aW9uLTIwMjYtMDctMTQgUC0wMDEpLlxuICAvLyBBbGwgYXBwLW9ubHk7IE5VTEwgb24gZXZlcnkgb3RoZXIga2luZCBhbmQgZXZlcnkgcHJlLTAxNCByb3cuXG4gIC8vIGRlbGl2ZXJ5X3R5cGUgZGlzY3JpbWluYXRlcyB0aGUgYXBwIG1vZGVsOiAnc3RhbmRhbG9uZScgKGEgc2VwYXJhdGVcbiAgLy8gZG93bmxvYWRhYmxlIHByb2R1Y3Qg4oCUIFwiaW5zdGFsbFwiIGlzIGEgZG93bmxvYWQtbGluayBoYW5kb2ZmKSB8ICdidW5kbGUnIChhXG4gIC8vIHBhcGVyY3VzcC1uYXRpdmUgY29tcG9zaXRpb24sIFBoYXNlIDIpLiBOVUxMIOKHkiB0cmVhdGVkIGFzICdzdGFuZGFsb25lJy5cbiAgZGVsaXZlcnlfdHlwZTogJ3N0YW5kYWxvbmUnIHwgJ2J1bmRsZScgfCBudWxsO1xufTtcblxuZXhwb3J0IHR5cGUgUmVwb3J0Um93ID0gT21pdDxSZXBvcnRzUm93LCAnc3RhdHVzJz4gJiB7XG4gIHN0YXR1czogJ3BlbmRpbmcnIHwgJ3Jlc29sdmVkX3VubGlzdCcgfCAncmVzb2x2ZWRfZGlzbWlzcyc7XG59O1xuXG5leHBvcnQgaW50ZXJmYWNlIE5ld0hhcm5lc3NJbnB1dCB7XG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBTdG9yZWZyb250IGtpbmQgKG1pZ3JhdGlvbiAwMDQpLiBEZWZhdWx0cyB0byAnaGFybmVzcycgd2hlbiBvbWl0dGVkLiAqL1xuICBsaXN0aW5nX2tpbmQ/OiBMaXN0aW5nS2luZDtcbiAgLyoqIFBhcGVyY3VwYWkgcHJvamVjdCByZW1vdGUgaWQgKEQtMDA4KS4gKi9cbiAgcHJvamVjdF9yZWY/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogV2l0aGluLXByb2plY3QgZGlzY3JpbWluYXRvciAoYmx1ZXByaW50IHN0cmVhbSAvIHNuYXBzaG90IGlkIC8gcGx1Z2luIHNsdWcpLiAqL1xuICBsaXN0aW5nX3JlZj86IHN0cmluZyB8IG51bGw7XG4gIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBudW1iZXI7XG4gIGdpdGh1Yl9vd25lcjogc3RyaW5nO1xuICBnaXRodWJfbmFtZTogc3RyaW5nO1xuICBnaXRodWJfdXJsOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmcgfCBudWxsO1xuICAvKiogUmVxdWlyZWQgb25seSBmb3Iga2luZD0naGFybmVzcyc7IG51bGwgZm9yIHRoZSBmb3JrL2luc3RhbGwga2luZHMuICovXG4gIHRvcGljX2hleDogc3RyaW5nIHwgbnVsbDtcbiAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkOiBudW1iZXI7XG4gIHB1Ymxpc2hlcl9naXRodWJfbG9naW46IHN0cmluZztcbiAgcHVibGlzaGVyX3Blcm1pc3Npb24/OiBzdHJpbmcgfCBudWxsO1xuICBwdWJsaXNoZXJfZGV2aWNlX3B1YmtleT86IHN0cmluZyB8IG51bGw7XG4gIHB1Ymxpc2hlcl9hdHRlc3RhdGlvbl9naXN0X2lkPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFBhY2sgbW9kZWwgKG1pZ3JhdGlvbiAwMDYpOiBKU09OIHN0cmluZ1tdIG9mIHByb3ZpZGVkIHRvb2wgbmFtZXM7IHBsdWdpbnxwYWNrIG9ubHkuICovXG4gIHByb3ZpZGVzX3Rvb2xzPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRvb2wgYXhpcywgY29uc3VtZXIgaGFsZiAobWlncmF0aW9uIDAzMyAvIFdJLTEwMDAxNzQ3KTogSlNPTiBzdHJpbmdbXSBvZiB0b29sIG5hbWVzIHRoZSB1bml0IE9SQ0hFU1RSQVRFUyBidXQgZG9lcyBub3QgcHJvdmlkZTsgb3JjaGVzdHJhdGluZyBraW5kcyBvbmx5LiAqL1xuICB1c2VzX3Rvb2xzPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIEV2ZW50IGF4aXMgKG1pZ3JhdGlvbiAwMTIgLyBELTAwMyk6IEpTT04gYXJyYXkgb2YgcHJvdmlkZWQgZXZlbnQgZmFtaWxpZXM7IHBsdWdpbnxwYWNrIG9ubHkuICovXG4gIHByb3ZpZGVzX2V2ZW50cz86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBFdmVudCBheGlzIChtaWdyYXRpb24gMDEzIC8gRC0wMDMpOiBKU09OIGFycmF5IG9mIFJFUVVJUkVEIGV2ZW50IGZhbWlsaWVzOyBwbHVnaW58cGFjayBvbmx5LiAqL1xuICByZXF1aXJlc19ldmVudHM/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogUnVicmljIGF4aXMgKG1pZ3JhdGlvbiAwMTUgLyBELTAwMSk6IEpTT04gYXJyYXkgb2YgUkVRVUlSRUQgcnVicmljc1xuICAgKiAgKHsgcnVicmljUmVmLCBvcHRpb25hbD8gfSk7IHByaW1hcmlseSBgcGxhbmAsIGtpbmQtYWdub3N0aWMuIE9taXQg4oeSIG5vbmUuICovXG4gIHJlcXVpcmVzX3J1YnJpY3M/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogVHlwZSBwYWNrcyAobWlncmF0aW9uIDA0OSAvIHBsYW4taXRlbS10eXBlcy1yZWdpc3RyeS1jdXBib2FyZC0yMDI2LTEwLTIwIFAtMDA2KTogSlNPTlxuICAgKiAgW3sgaWQsIHJldmlzaW9uIH1dIG9mIGl0ZW0gdHlwZXMgLyBwbGFuIHR5cGVzIHRoZSBtYW5pZmVzdCBjYXJyaWVzOyBwbHVnaW58cGFjayBvbmx5LiAqL1xuICBwcm92aWRlc19pdGVtX3R5cGVzPzogc3RyaW5nIHwgbnVsbDtcbiAgcHJvdmlkZXNfcGxhbl90eXBlcz86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUeXBlIHBhY2tzIChtaWdyYXRpb24gMDQ5KTogSlNPTiB7IGlkLCBtaW5SZXZpc2lvbj8sIG1heFJldmlzaW9uPyB9IG9mIHRoZSBwbGFuIHR5cGUgYVxuICAgKiAgcGxhbiB0ZW1wbGF0ZSByZXF1aXJlczsgcGxhbiBvbmx5LiAqL1xuICByZXF1aXJlc19wbGFuX3R5cGU/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogUmVwb+KGkkhpdmUgYmluZGluZyAobWlncmF0aW9uIDAwNyk6IG93bmluZyBIaXZlJ3MgcmF3LTMyLWJ5dGUtYmFzZTY0IEVkMjU1MTkgcHVia2V5LiAqL1xuICBoaXZlX3B1YmtleT86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBEZW5vcm1hbGl6ZWQgSGl2ZSBkaXNwbGF5IHRpdGxlIChkaXJlY3RvcnkgYW5ub3VuY2Ugc3RheXMgYXV0aG9yaXRhdGl2ZSkuICovXG4gIGhpdmVfdGl0bGU/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogYmx1ZXByaW50LnlhbWwgYGtpbmRgICgnaGl2ZSd8J2hhcm5lc3MnKSBmb3IgYSBsaXN0aW5nX2tpbmQ9J2JsdWVwcmludCcgcHVibGlzaDtcbiAgICogIG51bGwgb3RoZXJ3aXNlIChtaWdyYXRpb24gMDA5IC8gUC0wMTgpLiAqL1xuICBibHVlcHJpbnRfa2luZD86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBQcmUtcHVibGljYXRpb24gcmV2aWV3IChtaWdyYXRpb24gMDA4KTogcG9saWN5IGtpbmRzIHB1Ymxpc2ggJ3BlbmRpbmcnLiAqL1xuICByZXZpZXdfc3RhdHVzPzogUmV2aWV3U3RhdHVzO1xuICAvLyBBcHAgZGlzdHJpYnV0aW9uIChtaWdyYXRpb24gMDE0IC8gY3VwYm9hcmQtYXBwLWRpc3RyaWJ1dGlvbi0yMDI2LTA3LTE0IFAtMDAzKS5cbiAgLy8gQWxsIGFwcC1vbmx5OyBudWxsIG9uIGV2ZXJ5IG90aGVyIGtpbmQuIFNlZSBIYXJuZXNzUm93IGZvciBjb2x1bW4gc2VtYW50aWNzLlxuICAvKiogJ3N0YW5kYWxvbmUnIHwgJ2J1bmRsZSc7IG51bGwg4oeSIHRyZWF0ZWQgYXMgc3RhbmRhbG9uZS4gYXBwIG9ubHkuICovXG4gIGRlbGl2ZXJ5X3R5cGU/OiAnc3RhbmRhbG9uZScgfCAnYnVuZGxlJyB8IG51bGw7XG4gIC8qKiBTVEFOREFMT05FOiBzaWduZWQgbGF0ZXN0Lmpzb24gdXBkYXRlci1tYW5pZmVzdCBVUkwgdGhlIGRvd25sb2FkIGZsb3cgcmVhZHMuICovXG4gIGxhdGVzdF9qc29uX3VybD86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBTVEFOREFMT05FOiBgPG93bmVyPi88cmVwbz5gIGhvc3RpbmcgdGhlIHJlbGVhc2UgaW5zdGFsbGVycywgaWYgZGlzdGluY3QuICovXG4gIHJlbGVhc2VfcmVwbz86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBBcHAgaWNvbiBVUkwgZm9yIHRoZSBzdG9yZWZyb250IGNhcmQvZGV0YWlsLiAqL1xuICBpY29uX3VybD86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBEZW5vcm1hbGl6ZWQgSlNPTiBzdHJpbmdbXSBvZiBPUyBrZXlzIHByZXNlbnQgaW4gbGF0ZXN0Lmpzb24uICovXG4gIHBsYXRmb3Jtcz86IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIENhdGFsb2cgYXhlcyAobWlncmF0aW9uIDAxOCAvIHNoYXJlZC1wb3QtZGFvLWN1cGJvYXJkLXYxIFAtMDA4KSDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIHB1YmxpYyAoZGVmYXVsdCkgfCB1bmxpc3RlZCB8IHByaXZhdGUuIE9taXQg4oeSICdwdWJsaWMnLiAqL1xuICB2aXNpYmlsaXR5PzogTGlzdGluZ1Zpc2liaWxpdHk7XG4gIC8qKiBPd25pbmcgc2hhcmVkIHBvdDsgbnVsbC9vbWl0dGVkIOKHkiB0aGUgZ2xvYmFsIHB1YmxpYyBjYXRhbG9nLiAqL1xuICB0ZW5hbnRfaWQ/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogT3BhcXVlIHByb3ZpZGVyLW5ldXRyYWwgU0tVIGlkZW50aWZpZXIgYSBzZXR0bGVtZW50IGFkYXB0ZXIgcmVzb2x2ZXMuICovXG4gIHNrdV9yZWY/OiBzdHJpbmcgfCBudWxsO1xuICBwcmljaW5nX21vZGVsPzogUHJpY2luZ01vZGVsIHwgbnVsbDtcbiAgLyoqIE1pbm9yIHVuaXRzIMOXIDFlNiwgc28gcGVyLXVzZSBtaWNyb2NoYXJnZXMgYW5kIHN0YWJsZWNvaW4gYW1vdW50cyBzdGF5IGV4YWN0LiAqL1xuICBwcmljZV9hbW91bnRfbWljcm9zPzogbnVtYmVyIHwgbnVsbDtcbiAgLyoqIElTTy00MjE3IGNvZGUgb3Igc3RhYmxlY29pbiBzeW1ib2wgKCdVU0QnLCAnVVNEQycpLiAqL1xuICBwcmljZV9jdXJyZW5jeT86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBKU09OIHsgcnVudGltZT8sIHBsYXRmb3Jtcz86IHN0cmluZ1tdLCBhcmNoaXRlY3R1cmVzPzogc3RyaW5nW10gfSDigJQgbWlycm9yc1xuICAgKiAgdGhlIFAtMDA2IHJlbGVhc2UgbWFuaWZlc3QncyBgY29tcGF0aWJpbGl0eWAuICovXG4gIGNvbXBhdGliaWxpdHlfanNvbj86IHN0cmluZyB8IG51bGw7XG4gIC8qKiBKU09OIHN0cmluZ1tdIG9mIHBlcm1pc3Npb25zIHRoZSB1bml0IHJlcXVlc3RzIGF0IGluc3RhbGwgdGltZS4gKi9cbiAgcmVxdWlyZWRfcGVybWlzc2lvbnM/OiBzdHJpbmcgfCBudWxsO1xuICAvLyBJbW11dGFibGUgcmVsZWFzZSBpZGVudGl0eS4gQ29udGVudCBpZGVudGl0eSBvbmx5IOKAlCBuZXZlciBhIHJldHJpZXZhbCBVUkwsXG4gIC8vIHNvIHRoZSBsYXRlciBQMlAgc3RvcmFnZSBtaWdyYXRpb24gKEQtMDI0KSBjaGFuZ2VzIG5vIGNvbHVtbiBoZXJlLlxuICByZWxlYXNlX3ZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlX2NvbnRlbnRfaGFzaD86IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VfbWFuaWZlc3RfZGlnZXN0Pzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZV9zaWduYXR1cmU/OiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogVGhlIEZVTEwgc2lnbmVkIHJlbGVhc2UgbWFuaWZlc3QgYXMgY2Fub25pY2FsIEpTT04gKG1pZ3JhdGlvbiAwMzIpLlxuICAgKiBUaGUgc2lnbmF0dXJlIGlzIG92ZXIgbGlzdGluZ01hbmlmZXN0U2lnbmluZ0J5dGVzKG1hbmlmZXN0KSwgd2hvc2VcbiAgICogbGljZW5zZS9wdWJsaXNoZXIvcmV2aWV3U3RhdHVzIGZpZWxkcyBhcmUgcHVibGlzaGVyLXN1cHBsaWVkIGFuZCBOT1RcbiAgICogZGVyaXZhYmxlIGZyb20gYSBjbG9uZSDigJQgc28gYW4gaW5zdGFsbGVyIGNhbm5vdCByZWNvbnN0cnVjdCB0aGUgc2lnbmVkXG4gICAqIGJ5dGVzIGZyb20gdGhlIHBpbnMgYWxvbmUuIENhcnJ5aW5nIHRoZSB3aG9sZSBtYW5pZmVzdCBpcyB3aGF0IG1ha2VzIHRoZVxuICAgKiBpbnN0YWxsLXRpbWUgc2lnbmF0dXJlIGNoZWNrIHJlYWNoYWJsZSAoaWRlbnRpdGllcy12MS0yMDI2LTA4LTMwIEQtMDc0KS5cbiAgICovXG4gIHJlbGVhc2VfbWFuaWZlc3Q/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogQW4gaWRlbnRpdHkgbGlzdGluZydzIGRlY2xhcmVkIHN1cmZhY2UgYXMgY2Fub25pY2FsIEpTT04gKG1pZ3JhdGlvbiAwMzUgL1xuICAgKiAgcG9ydGFibGUtaWRlbnRpdHktcGFja2FnZXMgUC0wMTYpOyBudWxsIG9uIGV2ZXJ5IG90aGVyIGxpc3RpbmcuIFRoZSBpbnN0YWxsZXJcbiAgICogIHJlY29tcHV0ZXMgaXQgZnJvbSB0aGUgdmVyaWZpZWQgY2xvbmUsIHNvIHRoZSBXb3JrZXIgb25seSBib3VuZHMgYW5kIHdlbGwtZm9ybXMgaXQuICovXG4gIGlkZW50aXR5X3N1cmZhY2U/OiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlX3B1Ymxpc2hlZF9hdD86IG51bWJlciB8IG51bGw7XG4gIC8vIENvbnRlbnQgcGluIChtaWdyYXRpb24gMDI4IC8gY3VwYm9hcmQtcmVsZWFzZS1waXBlbGluZS1jb250ZW50LXRydXN0IFAtMDAxKS5cbiAgLy8gU2V0IGJ5IHRoZSBXb3JrZXIgZm9yIHNlbGYtZGVzY3JpYmluZyBraW5kcyBmcm9tIHdoYXQgSVQgZmV0Y2hlZCAoRC0wMDMpO1xuICAvLyBudWxsIG9uIGNvZGUga2luZHMuIEJvdGgtb3ItbmVpdGhlci5cbiAgcGlubmVkX2NvbW1pdF9zaGE/OiBzdHJpbmcgfCBudWxsO1xuICBwaW5uZWRfdHJlZV9kaWdlc3Q/OiBzdHJpbmcgfCBudWxsO1xuICBwaW5uZWRfYXQ/OiBudW1iZXIgfCBudWxsO1xuICAvLyBXb3JrZXItY29tcHV0ZWQgcmVjaXBlIGF1dGhvcml0eSAobWlncmF0aW9uIDAzOSAvIFAtMDA3KS4gUmVjaXBlIGtpbmQgb25seTtcbiAgLy8gbnVsbCBvbiBldmVyeSBvdGhlciBraW5kLiAxID0gY291bGQgbm90IHByb3ZlIHRoZSBzY3JpcHQncyBlZmZlY3RzIHN0YXRpY2FsbHlcbiAgLy8gKHRoZSBXb3JrZXIgbmV2ZXIgd3JpdGVzIDAgb24gYSBmYWlsdXJlIHBhdGgpLlxuICBhdXRob3JpdHlfdW5yZXNvbHZlZD86IG51bWJlciB8IG51bGw7XG4gIGF1dGhvcml0eV91bnJlc29sdmVkX2NhdXNlPzogc3RyaW5nIHwgbnVsbDtcbiAgLy8gT3B0aW9uYWwgcHJvdmVuYW5jZSBiYWRnZSAobWlncmF0aW9uIDA0MSAvIFAtMDEwKS4gJ2F0dGVzdGF0aW9uJyBPTkxZIHdoZW4gYVxuICAvLyBTaWdzdG9yZSBidWlsZCBhdHRlc3RhdGlvbiBmcm9tIHRoZSByZXVzYWJsZSBjdXBib2FyZC1hY3Rpb25zIHdvcmtmbG93IHdhc1xuICAvLyB2ZXJpZmllZCBhZ2FpbnN0IHRoZSBXb3JrZXIncyBvd24gcGluOyAnd29ya2VyJyAodGhlIGRlZmF1bHQpIG90aGVyd2lzZS5cbiAgLy8gQSBsYWJlbCBvbiBhIHJvdyB0aGUgV29ya2VyIGFscmVhZHkgcGlubmVkIGFuZCBzY2FubmVkIOKAlCBuZXZlciBhIHN1YnN0aXR1dGUuXG4gIHZlcmlmaWVkX2J5PzogJ3dvcmtlcicgfCAnYXR0ZXN0YXRpb24nO1xuICBjcmVhdGVkX2F0OiBudW1iZXI7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbnNlcnRIYXJuZXNzKGRiOiBEMURhdGFiYXNlLCBoOiBOZXdIYXJuZXNzSW5wdXQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyBoYXJuZXNzZXNcbiAgICAgICAgIChpZCwgbGlzdGluZ19raW5kLCBwcm9qZWN0X3JlZiwgbGlzdGluZ19yZWYsXG4gICAgICAgICAgZ2l0aHViX3JlcG9zaXRvcnlfaWQsIGdpdGh1Yl9vd25lciwgZ2l0aHViX25hbWUsIGdpdGh1Yl91cmwsXG4gICAgICAgICAgdGl0bGUsIGRlc2NyaXB0aW9uLCB0b3BpY19oZXgsXG4gICAgICAgICAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkLCBwdWJsaXNoZXJfZ2l0aHViX2xvZ2luLCBwdWJsaXNoZXJfcGVybWlzc2lvbixcbiAgICAgICAgICBwdWJsaXNoZXJfZGV2aWNlX3B1YmtleSwgcHVibGlzaGVyX2F0dGVzdGF0aW9uX2dpc3RfaWQsXG4gICAgICAgICAgcHJvdmlkZXNfdG9vbHMsIHVzZXNfdG9vbHMsIHByb3ZpZGVzX2V2ZW50cywgcmVxdWlyZXNfZXZlbnRzLCByZXF1aXJlc19ydWJyaWNzLFxuICAgICAgICAgIHByb3ZpZGVzX2l0ZW1fdHlwZXMsIHByb3ZpZGVzX3BsYW5fdHlwZXMsIHJlcXVpcmVzX3BsYW5fdHlwZSxcbiAgICAgICAgICBoaXZlX3B1YmtleSwgaGl2ZV90aXRsZSwgYmx1ZXByaW50X2tpbmQsXG4gICAgICAgICAgcmV2aWV3X3N0YXR1cyxcbiAgICAgICAgICBkZWxpdmVyeV90eXBlLCBsYXRlc3RfanNvbl91cmwsIHJlbGVhc2VfcmVwbywgaWNvbl91cmwsIHBsYXRmb3JtcyxcbiAgICAgICAgICB2aXNpYmlsaXR5LCB0ZW5hbnRfaWQsIHNrdV9yZWYsIHByaWNpbmdfbW9kZWwsXG4gICAgICAgICAgcHJpY2VfYW1vdW50X21pY3JvcywgcHJpY2VfY3VycmVuY3ksXG4gICAgICAgICAgY29tcGF0aWJpbGl0eV9qc29uLCByZXF1aXJlZF9wZXJtaXNzaW9ucyxcbiAgICAgICAgICByZWxlYXNlX3ZlcnNpb24sIHJlbGVhc2VfY29udGVudF9oYXNoLCByZWxlYXNlX21hbmlmZXN0X2RpZ2VzdCxcbiAgICAgICAgICByZWxlYXNlX3NpZ25hdHVyZSwgcmVsZWFzZV9tYW5pZmVzdCwgaWRlbnRpdHlfc3VyZmFjZSwgcmVsZWFzZV9wdWJsaXNoZWRfYXQsXG4gICAgICAgICAgcGlubmVkX2NvbW1pdF9zaGEsIHBpbm5lZF90cmVlX2RpZ2VzdCwgcGlubmVkX2F0LFxuICAgICAgICAgIGF1dGhvcml0eV91bnJlc29sdmVkLCBhdXRob3JpdHlfdW5yZXNvbHZlZF9jYXVzZSxcbiAgICAgICAgICB2ZXJpZmllZF9ieSxcbiAgICAgICAgICBjbGFpbV9zdGF0dXMsXG4gICAgICAgICAgY3JlYXRlZF9hdCwgdXBkYXRlZF9hdClcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sID8sICd1bmNsYWltZWQnLCA/LCA/KWAsXG4gICAgKVxuICAgIC5iaW5kKFxuICAgICAgaC5pZCxcbiAgICAgIGgubGlzdGluZ19raW5kID8/ICdoYXJuZXNzJyxcbiAgICAgIGgucHJvamVjdF9yZWYgPz8gbnVsbCxcbiAgICAgIGgubGlzdGluZ19yZWYgPz8gbnVsbCxcbiAgICAgIGguZ2l0aHViX3JlcG9zaXRvcnlfaWQsXG4gICAgICBoLmdpdGh1Yl9vd25lcixcbiAgICAgIGguZ2l0aHViX25hbWUsXG4gICAgICBoLmdpdGh1Yl91cmwsXG4gICAgICBoLnRpdGxlLFxuICAgICAgaC5kZXNjcmlwdGlvbixcbiAgICAgIGgudG9waWNfaGV4LFxuICAgICAgaC5wdWJsaXNoZXJfZ2l0aHViX3VzZXJfaWQsXG4gICAgICBoLnB1Ymxpc2hlcl9naXRodWJfbG9naW4sXG4gICAgICBoLnB1Ymxpc2hlcl9wZXJtaXNzaW9uID8/IG51bGwsXG4gICAgICBoLnB1Ymxpc2hlcl9kZXZpY2VfcHVia2V5ID8/IG51bGwsXG4gICAgICBoLnB1Ymxpc2hlcl9hdHRlc3RhdGlvbl9naXN0X2lkID8/IG51bGwsXG4gICAgICBoLnByb3ZpZGVzX3Rvb2xzID8/IG51bGwsXG4gICAgICBoLnVzZXNfdG9vbHMgPz8gbnVsbCxcbiAgICAgIGgucHJvdmlkZXNfZXZlbnRzID8/IG51bGwsXG4gICAgICBoLnJlcXVpcmVzX2V2ZW50cyA/PyBudWxsLFxuICAgICAgaC5yZXF1aXJlc19ydWJyaWNzID8/IG51bGwsXG4gICAgICBoLnByb3ZpZGVzX2l0ZW1fdHlwZXMgPz8gbnVsbCxcbiAgICAgIGgucHJvdmlkZXNfcGxhbl90eXBlcyA/PyBudWxsLFxuICAgICAgaC5yZXF1aXJlc19wbGFuX3R5cGUgPz8gbnVsbCxcbiAgICAgIGguaGl2ZV9wdWJrZXkgPz8gbnVsbCxcbiAgICAgIGguaGl2ZV90aXRsZSA/PyBudWxsLFxuICAgICAgaC5ibHVlcHJpbnRfa2luZCA/PyBudWxsLFxuICAgICAgaC5yZXZpZXdfc3RhdHVzID8/ICdhcHByb3ZlZCcsXG4gICAgICBoLmRlbGl2ZXJ5X3R5cGUgPz8gbnVsbCxcbiAgICAgIGgubGF0ZXN0X2pzb25fdXJsID8/IG51bGwsXG4gICAgICBoLnJlbGVhc2VfcmVwbyA/PyBudWxsLFxuICAgICAgaC5pY29uX3VybCA/PyBudWxsLFxuICAgICAgaC5wbGF0Zm9ybXMgPz8gbnVsbCxcbiAgICAgIGgudmlzaWJpbGl0eSA/PyAncHVibGljJyxcbiAgICAgIGgudGVuYW50X2lkID8/IG51bGwsXG4gICAgICBoLnNrdV9yZWYgPz8gbnVsbCxcbiAgICAgIGgucHJpY2luZ19tb2RlbCA/PyBudWxsLFxuICAgICAgaC5wcmljZV9hbW91bnRfbWljcm9zID8/IG51bGwsXG4gICAgICBoLnByaWNlX2N1cnJlbmN5ID8/IG51bGwsXG4gICAgICBoLmNvbXBhdGliaWxpdHlfanNvbiA/PyBudWxsLFxuICAgICAgaC5yZXF1aXJlZF9wZXJtaXNzaW9ucyA/PyBudWxsLFxuICAgICAgaC5yZWxlYXNlX3ZlcnNpb24gPz8gbnVsbCxcbiAgICAgIGgucmVsZWFzZV9jb250ZW50X2hhc2ggPz8gbnVsbCxcbiAgICAgIGgucmVsZWFzZV9tYW5pZmVzdF9kaWdlc3QgPz8gbnVsbCxcbiAgICAgIGgucmVsZWFzZV9zaWduYXR1cmUgPz8gbnVsbCxcbiAgICAgIGgucmVsZWFzZV9tYW5pZmVzdCA/PyBudWxsLFxuICAgICAgaC5pZGVudGl0eV9zdXJmYWNlID8/IG51bGwsXG4gICAgICBoLnJlbGVhc2VfcHVibGlzaGVkX2F0ID8/IG51bGwsXG4gICAgICBoLnBpbm5lZF9jb21taXRfc2hhID8/IG51bGwsXG4gICAgICBoLnBpbm5lZF90cmVlX2RpZ2VzdCA/PyBudWxsLFxuICAgICAgaC5waW5uZWRfYXQgPz8gbnVsbCxcbiAgICAgIGguYXV0aG9yaXR5X3VucmVzb2x2ZWQgPz8gbnVsbCxcbiAgICAgIGguYXV0aG9yaXR5X3VucmVzb2x2ZWRfY2F1c2UgPz8gbnVsbCxcbiAgICAgIGgudmVyaWZpZWRfYnkgPz8gJ3dvcmtlcicsXG4gICAgICBoLmNyZWF0ZWRfYXQsXG4gICAgICBoLmNyZWF0ZWRfYXQsXG4gICAgKVxuICAgIC5ydW4oKTtcbn1cblxuLyoqIE9wZXJhdG9yIGRlY2lzaW9uIG9uIGEgcGVuZGluZyBsaXN0aW5nIChrbm93bGVkZ2UtcGFja3MgUC0wMTkvUC0wMjApLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFJldmlld1N0YXR1cyhcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGlkOiBzdHJpbmcsXG4gIHN0YXR1czogRXhjbHVkZTxSZXZpZXdTdGF0dXMsICdwZW5kaW5nJz4sXG4gIHJlYXNvbjogc3RyaW5nIHwgbnVsbCxcbiAgbm93OiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBVUERBVEUgaGFybmVzc2VzXG4gICAgICAgICAgU0VUIHJldmlld19zdGF0dXMgPSA/LCByZXZpZXdlZF9hdCA9ID8sIHJldmlld19yZWFzb24gPSA/LCB1cGRhdGVkX2F0ID0gP1xuICAgICAgICBXSEVSRSBpZCA9ID9gLFxuICAgIClcbiAgICAuYmluZChzdGF0dXMsIG5vdywgcmVhc29uLCBub3csIGlkKVxuICAgIC5ydW4oKTtcbn1cblxuLyoqIEEgdmVyc2lvbiBvZiBvbmUgKHJlcG8sIGtpbmQsIGxpc3RpbmdfcmVmKSBpZGVudGl0eSAoUC0wMDgpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBMaXN0aW5nVmVyc2lvbklkZW50aXR5IHtcbiAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ6IG51bWJlcjtcbiAgbGlzdGluZ19raW5kOiBMaXN0aW5nS2luZDtcbiAgbGlzdGluZ19yZWY6IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgYWN0aXZlIGFwcHJvdmVkIHZlcnNpb24gb2YgYW4gaWRlbnRpdHkgb3RoZXIgdGhhbiBgZXhjbHVkZUlkYCDigJQgdGhlXG4gKiBiYXNlbGluZSBhbiBvcGVyYXRvcidzIHJldmlldyBkaWZmIGlzIHRha2VuIGFnYWluc3QgKFwidGhlIHByZXZpb3VzbHkgYXBwcm92ZWRcbiAqIFNIQVwiKS4gTnVsbCB3aGVuIG5vdGhpbmcgaXMgYXBwcm92ZWQgeWV0ICh0aGUgZmlyc3QtZXZlciB2ZXJzaW9uKSBvciB0aGUgb25seVxuICogYXBwcm92ZWQgcm93IHdhcyB0YWtlbiBkb3duLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UHJldmlvdXNseUFwcHJvdmVkVmVyc2lvbihcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGlkZW50aXR5OiBMaXN0aW5nVmVyc2lvbklkZW50aXR5LFxuICBleGNsdWRlSWQ6IHN0cmluZyxcbik6IFByb21pc2U8SGFybmVzc1JvdyB8IG51bGw+IHtcbiAgY29uc3Qgcm93ID0gYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgKiBGUk9NIGhhcm5lc3Nlc1xuICAgICAgICBXSEVSRSBnaXRodWJfcmVwb3NpdG9yeV9pZCA9ID8gQU5EIGxpc3Rpbmdfa2luZCA9ID8gQU5EIGxpc3RpbmdfcmVmID0gP1xuICAgICAgICAgIEFORCByZXZpZXdfc3RhdHVzID0gJ2FwcHJvdmVkJyBBTkQgdW5saXN0ZWRfYXQgSVMgTlVMTCBBTkQgaWQgIT0gP1xuICAgICAgICBPUkRFUiBCWSBDT0FMRVNDRShhcHByb3ZlZF9hdCwgcmV2aWV3ZWRfYXQsIGNyZWF0ZWRfYXQpIERFU0NcbiAgICAgICAgTElNSVQgMWAsXG4gICAgKVxuICAgIC5iaW5kKGlkZW50aXR5LmdpdGh1Yl9yZXBvc2l0b3J5X2lkLCBpZGVudGl0eS5saXN0aW5nX2tpbmQsIGlkZW50aXR5Lmxpc3RpbmdfcmVmLCBleGNsdWRlSWQpXG4gICAgLmZpcnN0PEhhcm5lc3NSb3c+KCk7XG4gIHJldHVybiByb3cgPz8gbnVsbDtcbn1cblxuLyoqXG4gKiBUaGUgcm93cyBhcHByb3ZpbmcgYHJvd2AgbWFrZXMgb2Jzb2xldGU6IHRoZSBwcmV2aW91c2x5IGFwcHJvdmVkIHZlcnNpb24ocykgb2ZcbiAqIHRoZSBzYW1lIGlkZW50aXR5LCBhbmQgYW55IHBlbmRpbmcgdmVyc2lvbiBwdWJsaXNoZWQgQkVGT1JFIGl0LiBBIHBlbmRpbmdcbiAqIHZlcnNpb24gcHVibGlzaGVkIEFGVEVSIGl0IGlzIGEgbmV3ZXIgY2FuZGlkYXRlIGFuZCBzdGF5cyBpbiB0aGUgcXVldWUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0VmVyc2lvbnNTdXBlcnNlZGVkQnlBcHByb3ZhbChcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIHJvdzogUGljazxIYXJuZXNzUm93LCAnaWQnIHwgJ2dpdGh1Yl9yZXBvc2l0b3J5X2lkJyB8ICdsaXN0aW5nX2tpbmQnIHwgJ2xpc3RpbmdfcmVmJyB8ICdjcmVhdGVkX2F0Jz4sXG4pOiBQcm9taXNlPEhhcm5lc3NSb3dbXT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCAqIEZST00gaGFybmVzc2VzXG4gICAgICAgIFdIRVJFIGdpdGh1Yl9yZXBvc2l0b3J5X2lkID0gPyBBTkQgbGlzdGluZ19raW5kID0gPyBBTkQgbGlzdGluZ19yZWYgPSA/XG4gICAgICAgICAgQU5EIGlkICE9ID8gQU5EIHVubGlzdGVkX2F0IElTIE5VTExcbiAgICAgICAgICBBTkQgKHJldmlld19zdGF0dXMgPSAnYXBwcm92ZWQnIE9SIChyZXZpZXdfc3RhdHVzID0gJ3BlbmRpbmcnIEFORCBjcmVhdGVkX2F0IDw9ID8pKVxuICAgICAgICBPUkRFUiBCWSBjcmVhdGVkX2F0IEFTQ2AsXG4gICAgKVxuICAgIC5iaW5kKHJvdy5naXRodWJfcmVwb3NpdG9yeV9pZCwgcm93Lmxpc3Rpbmdfa2luZCwgcm93Lmxpc3RpbmdfcmVmLCByb3cuaWQsIHJvdy5jcmVhdGVkX2F0KVxuICAgIC5hbGw8SGFybmVzc1Jvdz4oKTtcbiAgcmV0dXJuIHJlcy5yZXN1bHRzID8/IFtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmVMaXN0aW5nVmVyc2lvbklucHV0IHtcbiAgaWQ6IHN0cmluZztcbiAgcmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICBub3c6IG51bWJlcjtcbiAgLyoqIFRoZSBjb21taXQgKyBjYW5vbmljYWwgdHJlZSBkaWdlc3QgdGhlIG9wZXJhdG9yIHJldmlld2VkIChzZWxmLWRlc2NyaWJpbmdcbiAgICogIGtpbmRzKTsgbnVsbCBmb3IgYSBraW5kIHRoYXQgY2FycmllcyBubyBwaW4uIFdoZW4gaXQgZGlmZmVycyBmcm9tIHRoZSByb3cnc1xuICAgKiAgc3RvcmVkIHBpbiB0aGUgcm93IGlzIFJFLVBJTk5FRCB0byBpdCDigJQgYHBpbm5lZF8qYCBhbmQgYGFwcHJvdmVkXypgIGVuZCB1cFxuICAgKiAgZXF1YWwsIHNvIHdoYXQgaXMgc2VydmVkIGlzIGV4YWN0bHkgd2hhdCB3YXMgcmV2aWV3ZWQuICovXG4gIGFwcHJvdmVkOiB7IGNvbW1pdFNoYTogc3RyaW5nOyB0cmVlRGlnZXN0OiBzdHJpbmcgfSB8IG51bGw7XG4gIC8qKiBUcnVlIHdoZW4gYGFwcHJvdmVkYCByZXBsYWNlcyBhIGRpZmZlcmVudCBzdG9yZWQgcGluIChhIGRyaWZ0ZWQgcm93KS4gKi9cbiAgcmVwaW5uZWQ6IGJvb2xlYW47XG4gIC8qKiBUaGUgV29ya2VyJ3MgYXV0aG9yaXR5IHZlcmRpY3QgZm9yIHRoZSBSRS1QSU5ORUQgYnl0ZXMgKHJlY2lwZSBraW5kLCBQLTAwNykuIEFwcGxpZWRcbiAgICogIG9ubHkgd2hlbiBgcmVwaW5uZWRgOyBudWxsIGxlYXZlcyB0aGUgc3RvcmVkIHZlcmRpY3QgdW50b3VjaGVkLiAqL1xuICBhdXRob3JpdHk/OiB7IHVucmVzb2x2ZWQ6IGJvb2xlYW47IGNhdXNlOiBzdHJpbmcgfCBudWxsIH0gfCBudWxsO1xuICAvKiogVGhlIGlkZW50aXR5IHdob3NlIG9sZGVyIHZlcnNpb25zIHRoaXMgYXBwcm92YWwgcmV0aXJlczsgbnVsbCA9IHJldGlyZSBub25lLiAqL1xuICByZXRpcmU6IFBpY2s8SGFybmVzc1JvdywgJ2dpdGh1Yl9yZXBvc2l0b3J5X2lkJyB8ICdsaXN0aW5nX2tpbmQnIHwgJ2xpc3RpbmdfcmVmJyB8ICdjcmVhdGVkX2F0Jz4gfCBudWxsO1xuICAvKiogVGhlIGFkbWluLWRlY2lzaW9uIGF1ZGl0IHJvdywgd3JpdHRlbiBpbiB0aGUgU0FNRSBhdG9taWMgYmF0Y2ggYXMgdGhlIGFwcHJvdmFsIChXSS0xMDAwNDY0MykuXG4gICAqICBEMSBoYXMgbm8gdHJhbnNhY3Rpb24gc3Bhbm5pbmcgdHdvIHNlcGFyYXRlIGNhbGxzLCBzbyBhIFdvcmtlciBmYWlsdXJlIGJldHdlZW4gYW4gYXBwcm92ZVxuICAgKiAgYGJhdGNoYCBhbmQgYSBmb2xsb3dpbmcgYGF1ZGl0KClgIGxlZnQgYW4gYXBwcm92YWwgd2l0aCBubyBhdWRpdCBlbnRyeS4gVGhlIGluc2VydCBpcyBndWFyZGVkXG4gICAqICBvbiB0aGUgYXBwcm92YWwgaGF2aW5nIGxhbmRlZCwgc28gYSBsb3N0IHJhY2UgcmVjb3JkcyBubyBwaGFudG9tIFwiYXBwcm92ZWRcIiBkZWNpc2lvbi4gKi9cbiAgYXVkaXQ/OiB7IGtpbmQ6IHN0cmluZzsgZGV0YWlsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9IHwgbnVsbDtcbn1cblxuLyoqXG4gKiBBcHByb3ZlIGEgcGVuZGluZyBsaXN0aW5nIEFORCBtYWtlIGl0IHRoZSBzaW5nbGUgc2VydmVkIHZlcnNpb24gb2YgaXRzXG4gKiBpZGVudGl0eSwgaW4gT05FIGF0b21pYyBiYXRjaCAoUC0wMDggLyBXSS0xMDAwNDYyNSkuIFRoZSByZXRpcmUgc3RhdGVtZW50IGlzXG4gKiBndWFyZGVkIGJ5IGBFWElTVFMgKHRoZSBuZXcgcm93IGlzIGFwcHJvdmVkKWAsIHNvIGEgbG9zdCByYWNlIG9uIHRoZSBmaXJzdFxuICogc3RhdGVtZW50IGNhbiBuZXZlciB1bmxpc3QgdGhlIHByZXZpb3VzbHkgYXBwcm92ZWQgcm93IHdpdGhvdXQgYSBzdWNjZXNzb3IuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhcHByb3ZlTGlzdGluZ1ZlcnNpb24oZGI6IEQxRGF0YWJhc2UsIGlucHV0OiBBcHByb3ZlTGlzdGluZ1ZlcnNpb25JbnB1dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IGlkLCBub3csIGFwcHJvdmVkIH0gPSBpbnB1dDtcbiAgY29uc3Qgc3RhdGVtZW50czogRDFQcmVwYXJlZFN0YXRlbWVudFtdID0gW1xuICAgIGRiXG4gICAgICAucHJlcGFyZShcbiAgICAgICAgYFVQREFURSBoYXJuZXNzZXNcbiAgICAgICAgICAgIFNFVCByZXZpZXdfc3RhdHVzID0gJ2FwcHJvdmVkJywgcmV2aWV3ZWRfYXQgPSA/LCByZXZpZXdfcmVhc29uID0gPywgdXBkYXRlZF9hdCA9ID8sXG4gICAgICAgICAgICAgICAgYXBwcm92ZWRfY29tbWl0X3NoYSA9ID8sIGFwcHJvdmVkX3RyZWVfZGlnZXN0ID0gPywgYXBwcm92ZWRfYXQgPSA/LFxuICAgICAgICAgICAgICAgIGRyaWZ0ID0gMCxcbiAgICAgICAgICAgICAgICBwaW5uZWRfY29tbWl0X3NoYSA9IENPQUxFU0NFKD8sIHBpbm5lZF9jb21taXRfc2hhKSxcbiAgICAgICAgICAgICAgICBwaW5uZWRfdHJlZV9kaWdlc3QgPSBDT0FMRVNDRSg/LCBwaW5uZWRfdHJlZV9kaWdlc3QpLFxuICAgICAgICAgICAgICAgIHBpbm5lZF9hdCA9IENPQUxFU0NFKD8sIHBpbm5lZF9hdCksXG4gICAgICAgICAgICAgICAgYXV0aG9yaXR5X3VucmVzb2x2ZWQgPSBDT0FMRVNDRSg/LCBhdXRob3JpdHlfdW5yZXNvbHZlZCksXG4gICAgICAgICAgICAgICAgYXV0aG9yaXR5X3VucmVzb2x2ZWRfY2F1c2UgPSBDQVNFIFdIRU4gPyA9IDEgVEhFTiA/IEVMU0UgYXV0aG9yaXR5X3VucmVzb2x2ZWRfY2F1c2UgRU5EXG4gICAgICAgICAgV0hFUkUgaWQgPSA/IEFORCByZXZpZXdfc3RhdHVzID0gJ3BlbmRpbmcnIEFORCB1bmxpc3RlZF9hdCBJUyBOVUxMYCxcbiAgICAgIClcbiAgICAgIC5iaW5kKFxuICAgICAgICBub3csXG4gICAgICAgIGlucHV0LnJlYXNvbixcbiAgICAgICAgbm93LFxuICAgICAgICBhcHByb3ZlZD8uY29tbWl0U2hhID8/IG51bGwsXG4gICAgICAgIGFwcHJvdmVkPy50cmVlRGlnZXN0ID8/IG51bGwsXG4gICAgICAgIGFwcHJvdmVkID8gbm93IDogbnVsbCxcbiAgICAgICAgaW5wdXQucmVwaW5uZWQgPyAoYXBwcm92ZWQ/LmNvbW1pdFNoYSA/PyBudWxsKSA6IG51bGwsXG4gICAgICAgIGlucHV0LnJlcGlubmVkID8gKGFwcHJvdmVkPy50cmVlRGlnZXN0ID8/IG51bGwpIDogbnVsbCxcbiAgICAgICAgaW5wdXQucmVwaW5uZWQgPyBub3cgOiBudWxsLFxuICAgICAgICAvLyBQLTAwNzogdGhlIFdvcmtlcidzIHZlcmRpY3QgZm9yIHRoZSByZS1waW5uZWQgYnl0ZXMuIFRoZSBjYXVzZSBpcyByZXBsYWNlZCAocG9zc2libHkgYnlcbiAgICAgICAgLy8gTlVMTCA9IHJlc29sdmVkKSBvbmx5IHdoZW4gYSB2ZXJkaWN0IGFjY29tcGFuaWVzIHRoZSByZS1waW47IG90aGVyd2lzZSBib3RoIGFyZSBrZXB0LlxuICAgICAgICBpbnB1dC5yZXBpbm5lZCAmJiBpbnB1dC5hdXRob3JpdHkgPyAoaW5wdXQuYXV0aG9yaXR5LnVucmVzb2x2ZWQgPyAxIDogMCkgOiBudWxsLFxuICAgICAgICBpbnB1dC5yZXBpbm5lZCAmJiBpbnB1dC5hdXRob3JpdHkgPyAxIDogMCxcbiAgICAgICAgaW5wdXQucmVwaW5uZWQgJiYgaW5wdXQuYXV0aG9yaXR5ID8gaW5wdXQuYXV0aG9yaXR5LmNhdXNlIDogbnVsbCxcbiAgICAgICAgaWQsXG4gICAgICApLFxuICBdO1xuICBpZiAoaW5wdXQucmV0aXJlKSB7XG4gICAgc3RhdGVtZW50cy5wdXNoKFxuICAgICAgZGJcbiAgICAgICAgLnByZXBhcmUoXG4gICAgICAgICAgYFVQREFURSBoYXJuZXNzZXNcbiAgICAgICAgICAgICAgU0VUIHN1cGVyc2VkZWRfYnkgPSA/LCBjbGFpbV9zdGF0dXMgPSAnc3VwZXJzZWRlZCcsIHVubGlzdGVkX2F0ID0gPyxcbiAgICAgICAgICAgICAgICAgIHVubGlzdGVkX3JlYXNvbiA9ICdzdXBlcnNlZGVkX2J5X2FwcHJvdmVkX3ZlcnNpb24nLCB1cGRhdGVkX2F0ID0gP1xuICAgICAgICAgICAgV0hFUkUgZ2l0aHViX3JlcG9zaXRvcnlfaWQgPSA/IEFORCBsaXN0aW5nX2tpbmQgPSA/IEFORCBsaXN0aW5nX3JlZiA9ID9cbiAgICAgICAgICAgICAgQU5EIGlkICE9ID8gQU5EIHVubGlzdGVkX2F0IElTIE5VTExcbiAgICAgICAgICAgICAgQU5EIChyZXZpZXdfc3RhdHVzID0gJ2FwcHJvdmVkJyBPUiAocmV2aWV3X3N0YXR1cyA9ICdwZW5kaW5nJyBBTkQgY3JlYXRlZF9hdCA8PSA/KSlcbiAgICAgICAgICAgICAgQU5EIEVYSVNUUyAoU0VMRUNUIDEgRlJPTSBoYXJuZXNzZXMgblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgV0hFUkUgbi5pZCA9ID8gQU5EIG4ucmV2aWV3X3N0YXR1cyA9ICdhcHByb3ZlZCcgQU5EIG4udW5saXN0ZWRfYXQgSVMgTlVMTClgLFxuICAgICAgICApXG4gICAgICAgIC5iaW5kKFxuICAgICAgICAgIGlkLFxuICAgICAgICAgIG5vdyxcbiAgICAgICAgICBub3csXG4gICAgICAgICAgaW5wdXQucmV0aXJlLmdpdGh1Yl9yZXBvc2l0b3J5X2lkLFxuICAgICAgICAgIGlucHV0LnJldGlyZS5saXN0aW5nX2tpbmQsXG4gICAgICAgICAgaW5wdXQucmV0aXJlLmxpc3RpbmdfcmVmLFxuICAgICAgICAgIGlkLFxuICAgICAgICAgIGlucHV0LnJldGlyZS5jcmVhdGVkX2F0LFxuICAgICAgICAgIGlkLFxuICAgICAgICApLFxuICAgICk7XG4gIH1cbiAgaWYgKGlucHV0LmF1ZGl0KSB7XG4gICAgLy8gU2FtZSBiYXRjaCA9IHNhbWUgdHJhbnNhY3Rpb246IHRoZSBhcHByb3ZhbCBhbmQgaXRzIGF1ZGl0IHJvdyBjb21taXQgb3Igcm9sbCBiYWNrIHRvZ2V0aGVyLlxuICAgIC8vIEd1YXJkZWQgb24gVEhJUyBhcHByb3ZhbCBoYXZpbmcgbGFuZGVkIChyZXZpZXdlZF9hdCA9IG5vdyBvbiBhbiBhcHByb3ZlZCByb3cpLCBzbyBhIGxvc3RcbiAgICAvLyByYWNlIG9uIHRoZSBhcHByb3ZlIFVQREFURSByZWNvcmRzIG5vIHBoYW50b20gXCJhcHByb3ZlZFwiIGRlY2lzaW9uLlxuICAgIHN0YXRlbWVudHMucHVzaChcbiAgICAgIGRiXG4gICAgICAgIC5wcmVwYXJlKFxuICAgICAgICAgIGBJTlNFUlQgSU5UTyBhdWRpdCAodHMsIGtpbmQsIGRldGFpbClcbiAgICAgICAgICAgU0VMRUNUID8sID8sID9cbiAgICAgICAgICAgIFdIRVJFIEVYSVNUUyAoU0VMRUNUIDEgRlJPTSBoYXJuZXNzZXMgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgV0hFUkUgYS5pZCA9ID8gQU5EIGEucmV2aWV3X3N0YXR1cyA9ICdhcHByb3ZlZCcgQU5EIGEucmV2aWV3ZWRfYXQgPSA/KWAsXG4gICAgICAgIClcbiAgICAgICAgLmJpbmQobm93LCBpbnB1dC5hdWRpdC5raW5kLCBKU09OLnN0cmluZ2lmeShpbnB1dC5hdWRpdC5kZXRhaWwpLCBpZCwgbm93KSxcbiAgICApO1xuICB9XG4gIGF3YWl0IGRiLmJhdGNoKHN0YXRlbWVudHMpO1xufVxuXG4vKiogVGhlIG9wZXJhdG9yJ3MgcGVuZGluZy1yZXZpZXcgcXVldWUsIG9sZGVzdCBmaXJzdC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0UGVuZGluZ1JldmlldyhkYjogRDFEYXRhYmFzZSwgbGltaXQgPSAxMDApOiBQcm9taXNlPEhhcm5lc3NSb3dbXT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCAqIEZST00gaGFybmVzc2VzXG4gICAgICAgIFdIRVJFIHJldmlld19zdGF0dXMgPSAncGVuZGluZycgQU5EIHVubGlzdGVkX2F0IElTIE5VTExcbiAgICAgICAgT1JERVIgQlkgY3JlYXRlZF9hdCBBU0MgTElNSVQgP2AsXG4gICAgKVxuICAgIC5iaW5kKE1hdGgubWluKE1hdGgubWF4KGxpbWl0LCAxKSwgMjAwKSlcbiAgICAuYWxsPEhhcm5lc3NSb3c+KCk7XG4gIHJldHVybiByZXMucmVzdWx0cyA/PyBbXTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEhhcm5lc3NCeUlkKGRiOiBEMURhdGFiYXNlLCBpZDogc3RyaW5nKTogUHJvbWlzZTxIYXJuZXNzUm93IHwgbnVsbD4ge1xuICBjb25zdCByb3cgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIGhhcm5lc3NlcyBXSEVSRSBpZCA9ID8nKVxuICAgIC5iaW5kKGlkKVxuICAgIC5maXJzdDxIYXJuZXNzUm93PigpO1xuICByZXR1cm4gcm93ID8/IG51bGw7XG59XG5cbi8qKlxuICogTG9vayB1cCB0aGUgc2hhcmVkLUhBUk5FU1MgbGlzdGluZyBib3VuZCB0byBhIHJlcG8uIFNjb3BlZCB0b1xuICogbGlzdGluZ19raW5kPSdoYXJuZXNzJyBiZWNhdXNlLCBwb3N0LW1pZ3JhdGlvbi0wMDQsIHRoZSBzYW1lIHByb2plY3QtcmVtb3RlXG4gKiByZXBvIGlkIGNhbiBob3N0IE4gbm9uLWhhcm5lc3MgbGlzdGluZ3MgKGJsdWVwcmludHMvc25hcHNob3RzL3BsdWdpbnMpIOKAlCBidXRcbiAqIHRoZSBcIm9uZSBzaGFyZWQtaGFybmVzcyBwZXIgcmVwb1wiIDE6MSBpbnZhcmlhbnQgKGJpbmRpbmcgbG9va3VwICsgaGFybmVzc1xuICogcHVibGlzaCBkZWR1cCkgc3RpbGwgaG9sZHMuIEFuIGFjdGl2ZSAobGlzdGVkKSByb3cgd2lucyBvdmVyIGFuIHVubGlzdGVkIG9uZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEhhcm5lc3NCeUdpdGh1YlJlcG9JZChcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBudW1iZXIsXG4pOiBQcm9taXNlPEhhcm5lc3NSb3cgfCBudWxsPiB7XG4gIGNvbnN0IHJvdyA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgU0VMRUNUICogRlJPTSBoYXJuZXNzZXNcbiAgICAgICAgIFdIRVJFIGdpdGh1Yl9yZXBvc2l0b3J5X2lkID0gPyBBTkQgbGlzdGluZ19raW5kID0gJ2hhcm5lc3MnXG4gICAgICAgICBPUkRFUiBCWSAodW5saXN0ZWRfYXQgSVMgTlVMTCkgREVTQ1xuICAgICAgICAgTElNSVQgMWAsXG4gICAgKVxuICAgIC5iaW5kKGdpdGh1Yl9yZXBvc2l0b3J5X2lkKVxuICAgIC5maXJzdDxIYXJuZXNzUm93PigpO1xuICByZXR1cm4gcm93ID8/IG51bGw7XG59XG5cbi8qKlxuICogQmF0Y2ggcmVwb+KGkmxpc3RpbmcgbG9va3VwIChjb21iLWhpdmUtbmF0aXZlLXNoYXJpbmcgUC0wMTEpOiB0aGUgYWN0aXZlXG4gKiBoYXJuZXNzLWtpbmQgbGlzdGluZ3MgZm9yIGEgU0VUIG9mIEdpdEh1YiByZXBvIGlkcywgZm9yIHRoZSBzZWFyY2ggcGFuZWwnc1xuICogXCJoaXZlIGV4aXN0c1wiIGJhZGdlcyAoUC0wMTApLiBPbmUgcXVlcnkgb3ZlciB0aGUgZXhpc3RpbmcgcmVwby1pZCBpbmRleCxcbiAqIG1pcnJvcmluZyBnZXRIYXJuZXNzQnlHaXRodWJSZXBvSWQncyBoYXJuZXNzLWtpbmQgKyBhY3RpdmUtcm93IHNjb3Bpbmcg4oCUXG4gKiBiYXRjaGVkLiBUaGUgY2FsbGVyIHZhbGlkYXRlcyArIGNhcHMgdGhlIGlkIHNldC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEhhcm5lc3Nlc0J5R2l0aHViUmVwb0lkcyhcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGdpdGh1Yl9yZXBvc2l0b3J5X2lkczogbnVtYmVyW10sXG4pOiBQcm9taXNlPEhhcm5lc3NSb3dbXT4ge1xuICBpZiAoZ2l0aHViX3JlcG9zaXRvcnlfaWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICBjb25zdCBwbGFjZWhvbGRlcnMgPSBnaXRodWJfcmVwb3NpdG9yeV9pZHMubWFwKCgpID0+ICc/Jykuam9pbignLCcpO1xuICBjb25zdCBzdG10ID0gZGIucHJlcGFyZShcbiAgICBgU0VMRUNUICogRlJPTSBoYXJuZXNzZXNcbiAgICAgICBXSEVSRSBnaXRodWJfcmVwb3NpdG9yeV9pZCBJTiAoJHtwbGFjZWhvbGRlcnN9KVxuICAgICAgICAgQU5EIGxpc3Rpbmdfa2luZCA9ICdoYXJuZXNzJyBBTkQgdW5saXN0ZWRfYXQgSVMgTlVMTGAsXG4gICk7XG4gIC8vIC5iaW5kIGlzIHZhcmlhZGljIOKAlCBzcHJlYWQgdGhlIGlkcyBpbiBvbmUgY2FsbCAoc2FtZSBjYXN0IGFzIGxpc3RIYXJuZXNzZXMpLlxuICBjb25zdCBib3VuZCA9IChzdG10IGFzIHVua25vd24gYXMgeyBiaW5kOiAoLi4udnM6IHVua25vd25bXSkgPT4gRDFQcmVwYXJlZFN0YXRlbWVudCB9KS5iaW5kKFxuICAgIC4uLmdpdGh1Yl9yZXBvc2l0b3J5X2lkcyxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgYm91bmQuYWxsPEhhcm5lc3NSb3c+KCk7XG4gIHJldHVybiByZXMucmVzdWx0cyA/PyBbXTtcbn1cblxuLyoqXG4gKiBFdmVyeSBBQ1RJVkUgKG5vdCB1bmxpc3RlZCkgbGlzdGluZyBvZiB0aGUgZ2l2ZW4ga2luZHMgdGhhdCBhIEdpdEh1YiByZXBvXG4gKiBob2xkcyAoY3VwYm9hcmQtcmVsZWFzZS1waXBlbGluZS1jb250ZW50LXRydXN0LTIwMjYtMDktMTYgUC0wMDYpLiBBIHJlcG8gY2FuXG4gKiBob3N0IHNldmVyYWwg4oCUIG9uZSBwZXIgYChsaXN0aW5nX2tpbmQsIGxpc3RpbmdfcmVmKWAg4oCUIHNvIHRoZSBwdXNoIHdlYmhvb2tcbiAqIHdhbGtzIGFsbCBvZiB0aGVtLiBUaGUgY2FsbGVyIHBhc3NlcyB0aGUga2luZHMgKHRoZSBzZWxmLWRlc2NyaWJpbmcgc2V0IGZyb21cbiAqIGBjb250ZW50LXBpbi50c2ApIHJhdGhlciB0aGFuIHRoaXMgbW9kdWxlIGltcG9ydGluZyBpdCwgd2hpY2ggd291bGQgY2xvc2UgYW5cbiAqIGltcG9ydCBjeWNsZSAoYGNvbnRlbnQtcGluLnRzYCBhbHJlYWR5IGltcG9ydHMgdHlwZXMgZnJvbSBoZXJlKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RBY3RpdmVMaXN0aW5nc0J5R2l0aHViUmVwb0lkKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgZ2l0aHViX3JlcG9zaXRvcnlfaWQ6IG51bWJlcixcbiAga2luZHM6IHJlYWRvbmx5IExpc3RpbmdLaW5kW10sXG4pOiBQcm9taXNlPEhhcm5lc3NSb3dbXT4ge1xuICBpZiAoa2luZHMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IHBsYWNlaG9sZGVycyA9IGtpbmRzLm1hcCgoKSA9PiAnPycpLmpvaW4oJywnKTtcbiAgY29uc3Qgc3RtdCA9IGRiLnByZXBhcmUoXG4gICAgYFNFTEVDVCAqIEZST00gaGFybmVzc2VzXG4gICAgICAgV0hFUkUgZ2l0aHViX3JlcG9zaXRvcnlfaWQgPSA/IEFORCB1bmxpc3RlZF9hdCBJUyBOVUxMXG4gICAgICAgICBBTkQgbGlzdGluZ19raW5kIElOICgke3BsYWNlaG9sZGVyc30pXG4gICAgICAgT1JERVIgQlkgbGlzdGluZ19raW5kIEFTQywgbGlzdGluZ19yZWYgQVNDYCxcbiAgKTtcbiAgY29uc3QgYm91bmQgPSAoc3RtdCBhcyB1bmtub3duIGFzIHsgYmluZDogKC4uLnZzOiB1bmtub3duW10pID0+IEQxUHJlcGFyZWRTdGF0ZW1lbnQgfSkuYmluZChcbiAgICBnaXRodWJfcmVwb3NpdG9yeV9pZCxcbiAgICAuLi5raW5kcyxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgYm91bmQuYWxsPEhhcm5lc3NSb3c+KCk7XG4gIHJldHVybiByZXMucmVzdWx0cyA/PyBbXTtcbn1cblxuLyoqXG4gKiBSZWNvcmQgd2hldGhlciBhIGxpc3RpbmcncyByZXBvIGhlYWQgaGFzIG1vdmVkIHBhc3QgdGhlIGNvbW1pdCByZXZpZXcgcGlubmVkLlxuICogVGhpcyBpcyB0aGUgT05MWSBsaXN0aW5nIHdyaXRlIHRoZSBHaXRIdWIgcHVzaCB3ZWJob29rIHBlcmZvcm1zLCBhbmQgaXRcbiAqIGRlbGliZXJhdGVseSB0b3VjaGVzIGBkcmlmdGAgYWxvbmU6IHRoZSBgcGlubmVkXypgIGNvbHVtbnMgYXJlIHRoZSByZXZpZXdlZFxuICogaWRlbnRpdHkgYW5kIG1vdmUgb25seSB0aHJvdWdoIHRoZSBhZG1pbiBhcHByb3ZlIHBhdGggKFAtMDA4KSwgc28gYSBwdXNoIGNhblxuICogZmxhZyBhIG5ld2VyIHVudmVyaWZpZWQgdmVyc2lvbiBidXQgY2FuIG5ldmVyIGFkdmFuY2Ugd2hhdCBpbnN0YWxsIHNlcnZlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldExpc3RpbmdEcmlmdChkYjogRDFEYXRhYmFzZSwgaWQ6IHN0cmluZywgZHJpZnQ6IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGIucHJlcGFyZSgnVVBEQVRFIGhhcm5lc3NlcyBTRVQgZHJpZnQgPSA/IFdIRVJFIGlkID0gPycpLmJpbmQoZHJpZnQgPyAxIDogMCwgaWQpLnJ1bigpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExpc3RPcHRzIHtcbiAgbGltaXQ/OiBudW1iZXI7XG4gIGN1cnNvcj86IG51bWJlciB8IG51bGw7ICAgICAgICAgIC8vIGxlZ2FjeS9pbnRlcm5hbCB0aW1lc3RhbXAgcGFnaW5hdGlvblxuICBzZWFyY2g/OiBzdHJpbmc7XG4gIGNsYWltX3N0YXR1cz86ICd1bmNsYWltZWQnIHwgJ2NsYWltZWQnO1xuICAvKiogRmlsdGVyIHRvIG9uZSBzdG9yZWZyb250IGtpbmQgKG1pZ3JhdGlvbiAwMDQpLiBPbWl0IGZvciBhbGwga2luZHMuICovXG4gIGtpbmQ/OiBMaXN0aW5nS2luZDtcbiAgLyoqIE5hcnJvdyBibHVlcHJpbnQgbGlzdGluZ3MgdG8gb25lIGZhY2V0IOKAlCAnaGl2ZScgfCAnaGFybmVzcycgfCAnaWRlbnRpdHknXG4gICAqICAobWlncmF0aW9ucyAwMDkvMDM1KS4gUm93cyBvZiBvdGhlciBraW5kcyBuZXZlciBtYXRjaC4gKi9cbiAgYmx1ZXByaW50X2tpbmQ/OiBzdHJpbmc7XG4gIC8qKiBGaWx0ZXIgdG8gb25lIHByb2plY3QgcmVtb3RlIChELTAwOCBwcm9qZWN0IHJvbGx1cCkuICovXG4gIHByb2plY3RfcmVmPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENhdGFsb2ctYXhpcyBmaWx0ZXJzIChtaWdyYXRpb24gMDE4IC8gUC0wMDgpLlxuICpcbiAqIERlbGliZXJhdGVseSBvbiB0aGUgUFVCTElDIG9wdHMgb25seSwgbm90IG9uIGBMaXN0T3B0c2AuIGBsaXN0SGFybmVzc2VzYCBpcyB0aGVcbiAqIGluZGV4ZXIncyBpbnRlcm5hbCBzd2VlcCBhbmQgbXVzdCBzZWUgZXZlcnkgcm93IHJlZ2FyZGxlc3Mgb2YgdmlzaWJpbGl0eSDigJQgaWZcbiAqIHRoZXNlIGxpdmVkIG9uIHRoZSBzaGFyZWQgYmFzZSwgcGFzc2luZyBgdmlzaWJpbGl0eWAgdG8gaXQgd291bGQgc2lsZW50bHkgZG9cbiAqIG5vdGhpbmcsIHdoaWNoIGlzIHRoZSBxdWlldGVzdCBraW5kIG9mIGZpbHRlciBidWcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2F0YWxvZ0ZpbHRlck9wdHMge1xuICAvKiogTkFSUk9XIHRvIG9uZSB2aXNpYmlsaXR5IFdJVEhJTiB3aGF0IHRoZSBjYWxsZXIgbWF5IGFscmVhZHkgc2VlLiBUaGlzIGNhblxuICAgKiAgb25seSBldmVyIHJlbW92ZSByb3dzIOKAlCBpdCBuZXZlciB3aWRlbnMgdGhlIGZhaWwtY2xvc2VkIHNjb3BlIGJlbG93LiAqL1xuICB2aXNpYmlsaXR5PzogTGlzdGluZ1Zpc2liaWxpdHk7XG4gIC8qKlxuICAgKiBXSURFTklORyB0ZW5hbnQgc2NvcGU6IGFkZGl0aW9uYWxseSBhZG1pdCByb3dzIG93bmVkIGJ5IHRoaXMgdGVuYW50LFxuICAgKiB3aGF0ZXZlciB0aGVpciB2aXNpYmlsaXR5LiBUaGlzIGlzIHRoZSBPTkxZIHRoaW5nIHRoYXQgZXhwb3NlcyBhblxuICAgKiBgdW5saXN0ZWRgL2Bwcml2YXRlYCByb3csIHNvIGEgY2FsbGVyIG11c3QgaGF2ZSBhdXRob3JpemVkIHRoZSB0ZW5hbnRcbiAgICogYmVmb3JlIHBhc3NpbmcgaXQuIFRoZSBwdWJsaWMgSFRUUCByb3V0ZSBuZXZlciBzZXRzIGl0IOKAlCBzZWUgdGhlXG4gICAqIGB0ZW5hbnRfcmVmYCBuYXJyb3dpbmcgZmlsdGVyIGZvciB0aGUgdW50cnVzdGVkIHF1ZXJ5LXBhcmFtIHBhdGguXG4gICAqL1xuICB0ZW5hbnRfc2NvcGU/OiBzdHJpbmc7XG4gIC8qKiBOQVJST1dJTkcgZmlsdGVyIHRvIG9uZSB0ZW5hbnQncyByb3dzLCB3aXRoaW4gdGhlIGNhbGxlcidzIGV4aXN0aW5nIHNjb3BlLlxuICAgKiAgU2FmZSB0byBkcml2ZSBmcm9tIGFuIHVudHJ1c3RlZCBxdWVyeSBwYXJhbTogaXQgY2Fubm90IHJldmVhbCBhIHJvdyB0aGVcbiAgICogIHNjb3BlIGRpZCBub3QgYWxyZWFkeSBhZG1pdC4gKi9cbiAgdGVuYW50X3JlZj86IHN0cmluZztcbiAgcHJpY2luZ19tb2RlbD86IFByaWNpbmdNb2RlbDtcbiAgLyoqIHRydWUg4oeSIG9ubHkgcHJpY2VkIHJvd3M7IGZhbHNlIOKHkiBvbmx5IGZyZWUvdW5wcmljZWQgcm93cy4gKi9cbiAgcGFpZD86IGJvb2xlYW47XG4gIC8qKiBNYXRjaCBvbmUgZW50cnkgb2YgYGNvbXBhdGliaWxpdHlfanNvbi5wbGF0Zm9ybXNgLiAqL1xuICBwbGF0Zm9ybT86IHN0cmluZztcbiAgLyoqIE1hdGNoIGBjb21wYXRpYmlsaXR5X2pzb24ucnVudGltZWAgZXhhY3RseS4gKi9cbiAgcnVudGltZT86IHN0cmluZztcbiAgLyoqIE1hdGNoIG9uZSBlbnRyeSBvZiBgcmVxdWlyZWRfcGVybWlzc2lvbnNgLiAqL1xuICBwZXJtaXNzaW9uPzogc3RyaW5nO1xuICAvKiogTWF0Y2ggYSBsaXN0aW5nIHRoYXQgZGVjbGFyZXMgdGhpcyBpdGVtIHR5cGUgaW4gYHByb3ZpZGVzX2l0ZW1fdHlwZXNgIChtaWdyYXRpb24gMDQ5KS4gKi9cbiAgcHJvdmlkZXNfaXRlbV90eXBlPzogc3RyaW5nO1xuICAvKiogTWF0Y2ggYSBsaXN0aW5nIHRoYXQgZGVjbGFyZXMgdGhpcyBwbGFuIHR5cGUgaW4gYHByb3ZpZGVzX3BsYW5fdHlwZXNgIChtaWdyYXRpb24gMDQ5KS4gKi9cbiAgcHJvdmlkZXNfcGxhbl90eXBlPzogc3RyaW5nO1xuICAvKiogSW5jbHVkZSB5YW5rZWQvcmV2b2tlZCByZWxlYXNlcyAoZGVmYXVsdDogZXhjbHVkZWQgZnJvbSBicm93c2UpLiAqL1xuICBpbmNsdWRlX3dpdGhkcmF3bj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHVibGljTGlzdE9wdHMgZXh0ZW5kcyBPbWl0PExpc3RPcHRzLCAnY3Vyc29yJz4sIENhdGFsb2dGaWx0ZXJPcHRzIHtcbiAgY3Vyc29yPzogbnVtYmVyIHwgTGlzdGluZ0N1cnNvciB8IG51bGw7XG59XG5cbi8qKlxuICogT3BhcXVlIHB1YmxpYy1saXN0IGN1cnNvci4gYGxhc3RfYWN0aXZpdHlfYXRgIGFsb25lIGlzIG5vdCB1bmlxdWUsIHNvIHRoZSBpZFxuICogaXMgcGFydCBvZiB0aGUga2V5c2V0IGJvdW5kYXJ5IGV2ZW4gdGhvdWdoIG9sZGVyIGNsaWVudHMgc2VudCBhIGJhcmUgbnVtZXJpY1xuICogdGltZXN0YW1wLiBUaGUgcm91dGUgc3RpbGwgYWNjZXB0cyB0aGF0IGxlZ2FjeSB0aW1lc3RhbXAgZm9ybS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBMaXN0aW5nQ3Vyc29yIHtcbiAgbGFzdF9hY3Rpdml0eV9hdDogbnVtYmVyIHwgbnVsbDtcbiAgaWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIYXJuZXNzTGlzdFBhZ2Uge1xuICByZXN1bHRzOiBIYXJuZXNzUm93W107XG4gIG5leHRfY3Vyc29yOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhhcm5lc3NMaXN0U3VtbWFyeSB7XG4gIHRvdGFsOiBudW1iZXI7XG4gIGtpbmRfZmFjZXRzOiBSZWNvcmQ8TGlzdGluZ0tpbmQsIG51bWJlcj47XG59XG5cbmNvbnN0IExJU1RJTkdfQ1VSU09SX1BSRUZJWCA9ICd2MTonO1xuXG5leHBvcnQgZnVuY3Rpb24gZW5jb2RlTGlzdGluZ0N1cnNvcihyb3c6IFBpY2s8SGFybmVzc1JvdywgJ2xhc3RfYWN0aXZpdHlfYXQnIHwgJ2lkJz4pOiBzdHJpbmcge1xuICBjb25zdCBhY3Rpdml0eSA9IHJvdy5sYXN0X2FjdGl2aXR5X2F0ID09IG51bGwgPyAnbnVsbCcgOiBTdHJpbmcocm93Lmxhc3RfYWN0aXZpdHlfYXQpO1xuICByZXR1cm4gYCR7TElTVElOR19DVVJTT1JfUFJFRklYfSR7YWN0aXZpdHl9OiR7ZW5jb2RlVVJJQ29tcG9uZW50KHJvdy5pZCl9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTGlzdGluZ0N1cnNvcihyYXc6IHN0cmluZyk6IG51bWJlciB8IExpc3RpbmdDdXJzb3IgfCBudWxsIHtcbiAgaWYgKC9eLT9cXGQrJC8udGVzdChyYXcpKSB7XG4gICAgY29uc3QgbGVnYWN5ID0gTnVtYmVyKHJhdyk7XG4gICAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKGxlZ2FjeSkgPyBsZWdhY3kgOiBudWxsO1xuICB9XG4gIGlmICghcmF3LnN0YXJ0c1dpdGgoTElTVElOR19DVVJTT1JfUFJFRklYKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHNlcGFyYXRvciA9IHJhdy5pbmRleE9mKCc6JywgTElTVElOR19DVVJTT1JfUFJFRklYLmxlbmd0aCk7XG4gIGlmIChzZXBhcmF0b3IgPCAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYWN0aXZpdHlSYXcgPSByYXcuc2xpY2UoTElTVElOR19DVVJTT1JfUFJFRklYLmxlbmd0aCwgc2VwYXJhdG9yKTtcbiAgY29uc3QgZW5jb2RlZElkID0gcmF3LnNsaWNlKHNlcGFyYXRvciArIDEpO1xuICBpZiAoIWVuY29kZWRJZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGxhc3RfYWN0aXZpdHlfYXQgPSBhY3Rpdml0eVJhdyA9PT0gJ251bGwnID8gbnVsbCA6IE51bWJlcihhY3Rpdml0eVJhdyk7XG4gIGlmIChsYXN0X2FjdGl2aXR5X2F0ICE9PSBudWxsICYmICFOdW1iZXIuaXNTYWZlSW50ZWdlcihsYXN0X2FjdGl2aXR5X2F0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgaWQgPSBkZWNvZGVVUklDb21wb25lbnQoZW5jb2RlZElkKTtcbiAgICByZXR1cm4gaWQgPyB7IGxhc3RfYWN0aXZpdHlfYXQsIGlkIH0gOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5pbnRlcmZhY2UgTGlzdFByZWRpY2F0ZU9wdGlvbnMge1xuICBpbmNsdWRlS2luZDogYm9vbGVhbjtcbiAgaW5jbHVkZUN1cnNvcjogYm9vbGVhbjtcbiAgZXhjbHVkZUJhbm5lZDogYm9vbGVhbjtcbn1cblxuLyoqIENvbXBpbGUgdGhlIG9uZSBub3JtYWxpemVkIHB1YmxpYy1saXN0IHByZWRpY2F0ZSB1c2VkIGJ5IHJvd3MgKyBzdW1tYXJ5LiAqL1xuZnVuY3Rpb24gY29tcGlsZUhhcm5lc3NMaXN0UHJlZGljYXRlKFxuICBvcHRzOiBQdWJsaWNMaXN0T3B0cyxcbiAgY29uZmlnOiBMaXN0UHJlZGljYXRlT3B0aW9ucyxcbik6IHsgc3FsOiBzdHJpbmc7IGJpbmRzOiB1bmtub3duW10gfSB7XG4gIGNvbnN0IHdoZXJlOiBzdHJpbmdbXSA9IFtcbiAgICAnaC51bmxpc3RlZF9hdCBJUyBOVUxMJyxcbiAgICBgaC5yZXZpZXdfc3RhdHVzID0gJ2FwcHJvdmVkJ2AsXG4gIF07XG4gIGNvbnN0IGJpbmRzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKGNvbmZpZy5leGNsdWRlQmFubmVkKSB7XG4gICAgd2hlcmUucHVzaChcbiAgICAgICdOT1QgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIGJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cyBiYW5uZWQgV0hFUkUgYmFubmVkLnB1YmtleSA9IGgucHVibGlzaGVyX2RldmljZV9wdWJrZXkpJyxcbiAgICApO1xuICB9XG4gIGlmIChjb25maWcuaW5jbHVkZUtpbmQgJiYgb3B0cy5raW5kKSB7XG4gICAgd2hlcmUucHVzaCgnaC5saXN0aW5nX2tpbmQgPSA/Jyk7XG4gICAgYmluZHMucHVzaChvcHRzLmtpbmQpO1xuICB9XG4gIGlmIChjb25maWcuaW5jbHVkZUtpbmQgJiYgb3B0cy5ibHVlcHJpbnRfa2luZCkge1xuICAgIHdoZXJlLnB1c2goYGgubGlzdGluZ19raW5kID0gJ2JsdWVwcmludCcgQU5EIGguYmx1ZXByaW50X2tpbmQgPSA/YCk7XG4gICAgYmluZHMucHVzaChvcHRzLmJsdWVwcmludF9raW5kKTtcbiAgfVxuICBpZiAob3B0cy5wcm9qZWN0X3JlZikge1xuICAgIHdoZXJlLnB1c2goJ2gucHJvamVjdF9yZWYgPSA/Jyk7XG4gICAgYmluZHMucHVzaChvcHRzLnByb2plY3RfcmVmKTtcbiAgfVxuICBpZiAoY29uZmlnLmluY2x1ZGVDdXJzb3IgJiYgb3B0cy5jdXJzb3IgIT0gbnVsbCkge1xuICAgIGlmICh0eXBlb2Ygb3B0cy5jdXJzb3IgPT09ICdudW1iZXInKSB7XG4gICAgICAvLyBCYWNrLWNvbXBhdCBmb3IgZGVwbG95ZWQgY2xpZW50cyB0aGF0IHVzZWQgdGhlIG9sZCB0aW1lc3RhbXAtb25seSBjdXJzb3IuXG4gICAgICB3aGVyZS5wdXNoKCcoaC5sYXN0X2FjdGl2aXR5X2F0IElTIE5VTEwgT1IgaC5sYXN0X2FjdGl2aXR5X2F0IDwgPyknKTtcbiAgICAgIGJpbmRzLnB1c2gob3B0cy5jdXJzb3IpO1xuICAgIH0gZWxzZSBpZiAob3B0cy5jdXJzb3IubGFzdF9hY3Rpdml0eV9hdCA9PSBudWxsKSB7XG4gICAgICB3aGVyZS5wdXNoKCcoaC5sYXN0X2FjdGl2aXR5X2F0IElTIE5VTEwgQU5EIGguaWQgPiA/KScpO1xuICAgICAgYmluZHMucHVzaChvcHRzLmN1cnNvci5pZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHdoZXJlLnB1c2goXG4gICAgICAgICcoaC5sYXN0X2FjdGl2aXR5X2F0IDwgPyBPUiBoLmxhc3RfYWN0aXZpdHlfYXQgSVMgTlVMTCBPUiAoaC5sYXN0X2FjdGl2aXR5X2F0ID0gPyBBTkQgaC5pZCA+ID8pKScsXG4gICAgICApO1xuICAgICAgYmluZHMucHVzaChvcHRzLmN1cnNvci5sYXN0X2FjdGl2aXR5X2F0LCBvcHRzLmN1cnNvci5sYXN0X2FjdGl2aXR5X2F0LCBvcHRzLmN1cnNvci5pZCk7XG4gICAgfVxuICB9XG4gIGlmIChvcHRzLnNlYXJjaCkge1xuICAgIHdoZXJlLnB1c2goXG4gICAgICAnKGgudGl0bGUgTElLRSA/IE9SIGguZGVzY3JpcHRpb24gTElLRSA/IE9SIGguZ2l0aHViX293bmVyIExJS0UgPyBPUiBoLmdpdGh1Yl9uYW1lIExJS0UgPyknLFxuICAgICk7XG4gICAgY29uc3QgcSA9IGAlJHtvcHRzLnNlYXJjaH0lYDtcbiAgICBiaW5kcy5wdXNoKHEsIHEsIHEsIHEpO1xuICB9XG4gIGlmIChvcHRzLmNsYWltX3N0YXR1cykge1xuICAgIHdoZXJlLnB1c2goJ2guY2xhaW1fc3RhdHVzID0gPycpO1xuICAgIGJpbmRzLnB1c2gob3B0cy5jbGFpbV9zdGF0dXMpO1xuICB9XG4gIC8vIOKUgOKUgCBDYXRhbG9nIGZpbHRlcnMgKG1pZ3JhdGlvbiAwMTggLyBQLTAwOCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8vIEFwcGVuZGVkIEFGVEVSIGV2ZXJ5IHByZS0wMTggY2xhdXNlIG9uIHB1cnBvc2U6IHRoZSBiaW5kIGxpc3QgaXMgY29uc3VtZWRcbiAgLy8gcG9zaXRpb25hbGx5IChieSBEMSBhbmQgYnkgdGhlIHRlc3QgZmFrZSksIHNvIGFkZGluZyBoZXJlIGNhbm5vdCByZW51bWJlciBhblxuICAvLyBleGlzdGluZyBmaWx0ZXIncyBiaW5kcy5cbiAgYXBwZW5kQ2F0YWxvZ1ByZWRpY2F0ZSh3aGVyZSwgYmluZHMsIG9wdHMsICdoLicpO1xuICByZXR1cm4geyBzcWw6IHdoZXJlLmpvaW4oJyBBTkQgJyksIGJpbmRzIH07XG59XG5cbi8qKlxuICogVGhlIGNhdGFsb2ctYXhpcyBoYWxmIG9mIHRoZSBsaXN0IHByZWRpY2F0ZSAobWlncmF0aW9uIDAxOCAvIFAtMDA4KSwgc2hhcmVkIGJ5XG4gKiB0aGUgcHVibGljIGJyb3dzZSBwYWdlIGFuZCB0aGUgY29tcGFuaW9uIHN1bW1hcnkgQ1RFIHNvIHRoZSByb3dzIGFuZCB0aGUgZmFjZXRcbiAqIGNvdW50cyBjYW4gbmV2ZXIgZGlzYWdyZWUgYWJvdXQgd2hvIG1heSBzZWUgd2hhdC5cbiAqXG4gKiBURU5BTlQgSVNPTEFUSU9OIGlzIGVuZm9yY2VkIGhlcmUgYW5kIGlzIEZBSUwtQ0xPU0VEOiB0aGUgYmFzZSBydWxlIGFkbWl0cyBvbmx5XG4gKiBgdmlzaWJpbGl0eSA9ICdwdWJsaWMnYCwgYW5kIHRoZSBPTkxZIHdpZGVuaW5nIGlzIGFuIGV4cGxpY2l0IGB0ZW5hbnRfc2NvcGVgXG4gKiB0aGUgY2FsbGVyIGhhZCB0byBhdXRob3JpemUuIEV2ZXJ5IG90aGVyIGZpbHRlciBjYW4gb25seSByZW1vdmUgcm93cy4gVGhhdFxuICogYXN5bW1ldHJ5IGlzIHRoZSBwcm9wZXJ0eSB3b3J0aCB0ZXN0aW5nIOKAlCBhIG5hcnJvd2luZyBmaWx0ZXIgdGhhdCBhY2NpZGVudGFsbHlcbiAqIHdpZGVuZWQgd291bGQgbGVhayBhbm90aGVyIHRlbmFudCdzIHByaXZhdGUgY2F0YWxvZy5cbiAqL1xuZnVuY3Rpb24gYXBwZW5kQ2F0YWxvZ1ByZWRpY2F0ZShcbiAgd2hlcmU6IHN0cmluZ1tdLFxuICBiaW5kczogdW5rbm93bltdLFxuICBvcHRzOiBQdWJsaWNMaXN0T3B0cyxcbiAgcHJlZml4OiAnJyB8ICdoLicsXG4pOiB2b2lkIHtcbiAgaWYgKG9wdHMudmlzaWJpbGl0eSkge1xuICAgIHdoZXJlLnB1c2goYCR7cHJlZml4fXZpc2liaWxpdHkgPSA/YCk7XG4gICAgYmluZHMucHVzaChvcHRzLnZpc2liaWxpdHkpO1xuICB9XG4gIGlmIChvcHRzLnRlbmFudF9yZWYpIHtcbiAgICB3aGVyZS5wdXNoKGAke3ByZWZpeH10ZW5hbnRfaWQgPSA/YCk7XG4gICAgYmluZHMucHVzaChvcHRzLnRlbmFudF9yZWYpO1xuICB9XG4gIGlmIChvcHRzLnByaWNpbmdfbW9kZWwpIHtcbiAgICB3aGVyZS5wdXNoKGAke3ByZWZpeH1wcmljaW5nX21vZGVsID0gP2ApO1xuICAgIGJpbmRzLnB1c2gob3B0cy5wcmljaW5nX21vZGVsKTtcbiAgfVxuICBpZiAob3B0cy5wYWlkID09PSB0cnVlKSB7XG4gICAgd2hlcmUucHVzaChgKCR7cHJlZml4fXNrdV9yZWYgSVMgTk9UIE5VTEwgQU5EICR7cHJlZml4fXByaWNpbmdfbW9kZWwgSVMgTk9UIE5VTEwgQU5EICR7cHJlZml4fXByaWNpbmdfbW9kZWwgIT0gJ2ZyZWUnKWApO1xuICB9IGVsc2UgaWYgKG9wdHMucGFpZCA9PT0gZmFsc2UpIHtcbiAgICB3aGVyZS5wdXNoKGAoJHtwcmVmaXh9c2t1X3JlZiBJUyBOVUxMIE9SICR7cHJlZml4fXByaWNpbmdfbW9kZWwgSVMgTlVMTCBPUiAke3ByZWZpeH1wcmljaW5nX21vZGVsID0gJ2ZyZWUnKWApO1xuICB9XG4gIGlmIChvcHRzLnJ1bnRpbWUpIHtcbiAgICB3aGVyZS5wdXNoKGBqc29uX2V4dHJhY3QoJHtwcmVmaXh9Y29tcGF0aWJpbGl0eV9qc29uLCAnJC5ydW50aW1lJykgPSA/YCk7XG4gICAgYmluZHMucHVzaChvcHRzLnJ1bnRpbWUpO1xuICB9XG4gIGlmIChvcHRzLnBsYXRmb3JtKSB7XG4gICAgLy8ganNvbl92YWxpZCBndWFyZHMgYSBtYWxmb3JtZWQgb3IgTlVMTCBjb2x1bW46IGpzb25fZWFjaCBvdmVyIG9uZSB3b3VsZFxuICAgIC8vIHJhaXNlLCB0dXJuaW5nIGEgYmFkIHJvdyBpbnRvIGEgNTAwIGZvciB0aGUgd2hvbGUgcGFnZS5cbiAgICB3aGVyZS5wdXNoKFxuICAgICAgYCgke3ByZWZpeH1jb21wYXRpYmlsaXR5X2pzb24gSVMgTk9UIE5VTEwgQU5EIGpzb25fdmFsaWQoJHtwcmVmaXh9Y29tcGF0aWJpbGl0eV9qc29uKWAgK1xuICAgICAgICBgIEFORCBFWElTVFMgKFNFTEVDVCAxIEZST00ganNvbl9lYWNoKCR7cHJlZml4fWNvbXBhdGliaWxpdHlfanNvbiwgJyQucGxhdGZvcm1zJykgV0hFUkUganNvbl9lYWNoLnZhbHVlID0gPykpYCxcbiAgICApO1xuICAgIGJpbmRzLnB1c2gob3B0cy5wbGF0Zm9ybSk7XG4gIH1cbiAgaWYgKG9wdHMucGVybWlzc2lvbikge1xuICAgIHdoZXJlLnB1c2goXG4gICAgICBgKCR7cHJlZml4fXJlcXVpcmVkX3Blcm1pc3Npb25zIElTIE5PVCBOVUxMIEFORCBqc29uX3ZhbGlkKCR7cHJlZml4fXJlcXVpcmVkX3Blcm1pc3Npb25zKWAgK1xuICAgICAgICBgIEFORCBFWElTVFMgKFNFTEVDVCAxIEZST00ganNvbl9lYWNoKCR7cHJlZml4fXJlcXVpcmVkX3Blcm1pc3Npb25zKSBXSEVSRSBqc29uX2VhY2gudmFsdWUgPSA/KSlgLFxuICAgICk7XG4gICAgYmluZHMucHVzaChvcHRzLnBlcm1pc3Npb24pO1xuICB9XG4gIC8vIFR5cGUgcGFja3MgKG1pZ3JhdGlvbiAwNDkpOiB0aGUgaW5zdGFsbGVyJ3MgcHJvdmlkZXIgbG9va3VwIGZvciBvbmUgZGVjbGFyZWQgdHlwZSBpZC5cbiAgZm9yIChjb25zdCBbY29sdW1uLCBpZF0gb2YgW1xuICAgIFsncHJvdmlkZXNfaXRlbV90eXBlcycsIG9wdHMucHJvdmlkZXNfaXRlbV90eXBlXSxcbiAgICBbJ3Byb3ZpZGVzX3BsYW5fdHlwZXMnLCBvcHRzLnByb3ZpZGVzX3BsYW5fdHlwZV0sXG4gIF0gYXMgY29uc3QpIHtcbiAgICBpZiAoIWlkKSBjb250aW51ZTtcbiAgICB3aGVyZS5wdXNoKFxuICAgICAgYCgke3ByZWZpeH0ke2NvbHVtbn0gSVMgTk9UIE5VTEwgQU5EIGpzb25fdmFsaWQoJHtwcmVmaXh9JHtjb2x1bW59KWAgK1xuICAgICAgICBgIEFORCBFWElTVFMgKFNFTEVDVCAxIEZST00ganNvbl9lYWNoKCR7cHJlZml4fSR7Y29sdW1ufSkgV0hFUkUganNvbl9leHRyYWN0KGpzb25fZWFjaC52YWx1ZSwgJyQuaWQnKSA9ID8pKWAsXG4gICAgKTtcbiAgICBiaW5kcy5wdXNoKGlkKTtcbiAgfVxuICAvLyBUaGUgZmFpbC1jbG9zZWQgdmlzaWJpbGl0eSBzY29wZS4gS2VlcCB0aGlzIExBU1Qgc28gdGhlIHdpZGVuaW5nIGJpbmQgaXMgdGhlXG4gIC8vIGZpbmFsIGNhdGFsb2cgYmluZCBpbiBldmVyeSBxdWVyeSBzaGFwZS5cbiAgaWYgKG9wdHMudGVuYW50X3Njb3BlKSB7XG4gICAgd2hlcmUucHVzaChgKCR7cHJlZml4fXZpc2liaWxpdHkgPSAncHVibGljJyBPUiAke3ByZWZpeH10ZW5hbnRfaWQgPSA/KWApO1xuICAgIGJpbmRzLnB1c2gob3B0cy50ZW5hbnRfc2NvcGUpO1xuICB9IGVsc2Uge1xuICAgIHdoZXJlLnB1c2goYCR7cHJlZml4fXZpc2liaWxpdHkgPSAncHVibGljJ2ApO1xuICB9XG4gIGlmICghb3B0cy5pbmNsdWRlX3dpdGhkcmF3bikge1xuICAgIHdoZXJlLnB1c2goYCR7cHJlZml4fXlhbmtlZF9hdCBJUyBOVUxMYCk7XG4gICAgd2hlcmUucHVzaChgJHtwcmVmaXh9cmV2b2tlZF9hdCBJUyBOVUxMYCk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RIYXJuZXNzZXMoZGI6IEQxRGF0YWJhc2UsIG9wdHM6IExpc3RPcHRzKTogUHJvbWlzZTxIYXJuZXNzUm93W10+IHtcbiAgY29uc3QgbGltaXQgPSBNYXRoLm1pbihNYXRoLm1heChvcHRzLmxpbWl0ID8/IDMwLCAxKSwgMTAwKTtcbiAgLy8gU3RhdGljIFNRTCBhdm9pZHMgRDEncyBwcmVwYXJlZC1zdGF0ZW1lbnQgc3RyaW5nIGNvbmNhdCB0YXg7IHdlIGZpbHRlclxuICAvLyB1bmxpc3RlZCBhbHdheXMg4oCUIGFuZCBub24tYXBwcm92ZWQgYWx3YXlzIChrbm93bGVkZ2UtcGFja3MgRC0wMDc6IHBlbmRpbmcvXG4gIC8vIHJlamVjdGVkIHBvbGljeS1raW5kIGxpc3RpbmdzIGFyZSBpbnZpc2libGUgdG8gcHVibGljIGJyb3dzZTsgdGhlXG4gIC8vIHB1Ymxpc2hlciByZWFkcyB0aGVpciBvd24gdmlhIEdFVCAvOmlkIHdpdGggYXV0aCwgb3BlcmF0b3JzIHZpYSAvYWRtaW4pLlxuICBjb25zdCB3aGVyZTogc3RyaW5nW10gPSBbJ3VubGlzdGVkX2F0IElTIE5VTEwnLCBgcmV2aWV3X3N0YXR1cyA9ICdhcHByb3ZlZCdgXTtcbiAgY29uc3QgYmluZHM6IHVua25vd25bXSA9IFtdO1xuICBpZiAob3B0cy5raW5kKSB7XG4gICAgd2hlcmUucHVzaCgnbGlzdGluZ19raW5kID0gPycpO1xuICAgIGJpbmRzLnB1c2gob3B0cy5raW5kKTtcbiAgfVxuICBpZiAob3B0cy5ibHVlcHJpbnRfa2luZCkge1xuICAgIHdoZXJlLnB1c2goYGxpc3Rpbmdfa2luZCA9ICdibHVlcHJpbnQnIEFORCBibHVlcHJpbnRfa2luZCA9ID9gKTtcbiAgICBiaW5kcy5wdXNoKG9wdHMuYmx1ZXByaW50X2tpbmQpO1xuICB9XG4gIGlmIChvcHRzLnByb2plY3RfcmVmKSB7XG4gICAgd2hlcmUucHVzaCgncHJvamVjdF9yZWYgPSA/Jyk7XG4gICAgYmluZHMucHVzaChvcHRzLnByb2plY3RfcmVmKTtcbiAgfVxuICBpZiAob3B0cy5jdXJzb3IgIT0gbnVsbCkge1xuICAgIHdoZXJlLnB1c2goJyhsYXN0X2FjdGl2aXR5X2F0IElTIE5VTEwgT1IgbGFzdF9hY3Rpdml0eV9hdCA8ID8pJyk7XG4gICAgYmluZHMucHVzaChvcHRzLmN1cnNvcik7XG4gIH1cbiAgaWYgKG9wdHMuc2VhcmNoKSB7XG4gICAgd2hlcmUucHVzaCgnKHRpdGxlIExJS0UgPyBPUiBkZXNjcmlwdGlvbiBMSUtFID8gT1IgZ2l0aHViX293bmVyIExJS0UgPyBPUiBnaXRodWJfbmFtZSBMSUtFID8pJyk7XG4gICAgY29uc3QgcSA9IGAlJHtvcHRzLnNlYXJjaH0lYDtcbiAgICBiaW5kcy5wdXNoKHEsIHEsIHEsIHEpO1xuICB9XG4gIGlmIChvcHRzLmNsYWltX3N0YXR1cykge1xuICAgIHdoZXJlLnB1c2goJ2NsYWltX3N0YXR1cyA9ID8nKTtcbiAgICBiaW5kcy5wdXNoKG9wdHMuY2xhaW1fc3RhdHVzKTtcbiAgfVxuICBjb25zdCBzcWwgPSBgU0VMRUNUICogRlJPTSBoYXJuZXNzZXMgV0hFUkUgJHt3aGVyZS5qb2luKCcgQU5EICcpfSBPUkRFUiBCWSBsYXN0X2FjdGl2aXR5X2F0IERFU0MgTlVMTFMgTEFTVCwgaWQgQVNDIExJTUlUID9gO1xuICBiaW5kcy5wdXNoKGxpbWl0KTtcbiAgY29uc3Qgc3RtdCA9IGRiLnByZXBhcmUoc3FsKTtcbiAgLy8gLmJpbmQgaXMgdmFyaWFkaWMsIHNwcmVhZCB0aGUgYmluZHMgaW4gb25lIGNhbGxcbiAgY29uc3QgYm91bmQgPSAoc3RtdCBhcyB1bmtub3duIGFzIHsgYmluZDogKC4uLnZzOiB1bmtub3duW10pID0+IEQxUHJlcGFyZWRTdGF0ZW1lbnQgfSkuYmluZCguLi5iaW5kcyk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGJvdW5kLmFsbDxIYXJuZXNzUm93PigpO1xuICByZXR1cm4gcmVzLnJlc3VsdHMgPz8gW107XG59XG5cbi8qKlxuICogQXV0aGVudGljYXRlZCBwdWJsaXNoZXIgdmlldy4gVW5saWtlIHRoZSBwdWJsaWMgY2F0YWxvZywgdGhpcyBkZWxpYmVyYXRlbHlcbiAqIGluY2x1ZGVzIGV2ZXJ5IHJldmlldyBzdGF0ZSBhbmQgdW5saXN0ZWQgcm93LCBidXQgc2NvcGVzIHRoZSByZXN1bHQgdG8gb25lXG4gKiBHaXRIdWIgcHVibGlzaGVyIGlkIHNvIGFub3RoZXIgY3JlYXRvcidzIHBlbmRpbmcgd29yayBjYW5ub3QgbGVhay5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RQdWJsaXNoZXJMaXN0aW5ncyhcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIG9wdHM6IHsgcHVibGlzaGVySWQ6IG51bWJlcjsgbGltaXQ/OiBudW1iZXI7IG9mZnNldD86IG51bWJlciB9LFxuKTogUHJvbWlzZTxIYXJuZXNzUm93W10+IHtcbiAgY29uc3QgbGltaXQgPSBNYXRoLm1pbihNYXRoLm1heChvcHRzLmxpbWl0ID8/IDEwMCwgMSksIDIwMSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgU0VMRUNUICogRlJPTSBoYXJuZXNzZXNcbiAgICAgICAgIFdIRVJFIHB1Ymxpc2hlcl9naXRodWJfdXNlcl9pZCA9ID9cbiAgICAgICAgIE9SREVSIEJZIHVwZGF0ZWRfYXQgREVTQywgaWQgQVNDXG4gICAgICAgICBMSU1JVCA/IE9GRlNFVCA/YCxcbiAgICApXG4gICAgLmJpbmQob3B0cy5wdWJsaXNoZXJJZCwgbGltaXQsIG9wdHMub2Zmc2V0ID8/IDApXG4gICAgLmFsbDxIYXJuZXNzUm93PigpO1xuICByZXR1cm4gcmVzdWx0LnJlc3VsdHMgPz8gW107XG59XG5cbi8qKlxuICogUHVibGljIGJyb3dzZSBwYWdlLiBCYW5uZWQgcHVibGlzaGVycyBhcmUgZXhjbHVkZWQgYmVmb3JlIExJTUlULCBhbmQgb25lXG4gKiBleHRyYSByb3cgaXMgcHJvYmVkIHNvIG5leHRfY3Vyc29yIG1lYW5zIHRoZXJlIGlzIGFjdHVhbGx5IGFub3RoZXIgcGFnZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RQdWJsaWNIYXJuZXNzZXNQYWdlKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgb3B0czogUHVibGljTGlzdE9wdHMsXG4pOiBQcm9taXNlPEhhcm5lc3NMaXN0UGFnZT4ge1xuICBjb25zdCBsaW1pdCA9IE1hdGgubWluKE1hdGgubWF4KG9wdHMubGltaXQgPz8gMzAsIDEpLCAxMDApO1xuICBjb25zdCBwcmVkaWNhdGUgPSBjb21waWxlSGFybmVzc0xpc3RQcmVkaWNhdGUob3B0cywge1xuICAgIGluY2x1ZGVLaW5kOiB0cnVlLFxuICAgIGluY2x1ZGVDdXJzb3I6IHRydWUsXG4gICAgZXhjbHVkZUJhbm5lZDogdHJ1ZSxcbiAgfSk7XG4gIGNvbnN0IGJpbmRzID0gWy4uLnByZWRpY2F0ZS5iaW5kcywgbGltaXQgKyAxXTtcbiAgY29uc3Qgc3RtdCA9IGRiLnByZXBhcmUoXG4gICAgYFNFTEVDVCBoLiogRlJPTSBoYXJuZXNzZXMgaCBXSEVSRSAke3ByZWRpY2F0ZS5zcWx9IE9SREVSIEJZIGgubGFzdF9hY3Rpdml0eV9hdCBERVNDIE5VTExTIExBU1QsIGguaWQgQVNDIExJTUlUID9gLFxuICApO1xuICBjb25zdCBib3VuZCA9IChzdG10IGFzIHVua25vd24gYXMgeyBiaW5kOiAoLi4udnM6IHVua25vd25bXSkgPT4gRDFQcmVwYXJlZFN0YXRlbWVudCB9KS5iaW5kKFxuICAgIC4uLmJpbmRzLFxuICApO1xuICBjb25zdCByZXMgPSBhd2FpdCBib3VuZC5hbGw8SGFybmVzc1Jvdz4oKTtcbiAgY29uc3QgZmV0Y2hlZCA9IHJlcy5yZXN1bHRzID8/IFtdO1xuICBjb25zdCByZXN1bHRzID0gZmV0Y2hlZC5zbGljZSgwLCBsaW1pdCk7XG4gIGNvbnN0IG5leHRfY3Vyc29yID1cbiAgICBmZXRjaGVkLmxlbmd0aCA+IGxpbWl0ICYmIHJlc3VsdHMubGVuZ3RoID4gMFxuICAgICAgPyBlbmNvZGVMaXN0aW5nQ3Vyc29yKHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXSlcbiAgICAgIDogbnVsbDtcbiAgcmV0dXJuIHsgcmVzdWx0cywgbmV4dF9jdXJzb3IgfTtcbn1cblxuLyoqXG4gKiBPbmUgY29tcGFuaW9uLXN1bW1hcnkgcXVlcnk6IHRvdGFsIGhvbm9ycyB0aGUgc2VsZWN0ZWQga2luZCwgd2hpbGUga2luZFxuICogZmFjZXRzIGFwcGx5IGV2ZXJ5IG90aGVyIGFjdGl2ZSBmaWx0ZXIgYW5kIGRlbGliZXJhdGVseSBvbWl0IGtpbmQgc28gZWFjaFxuICogY291bnQgcHJlZGljdHMgdGhlIHJlc3VsdCBvZiBkcmlsbGluZyBpbnRvIHRoYXQgb3B0aW9uLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3VtbWFyaXplUHVibGljSGFybmVzc2VzKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgb3B0czogUHVibGljTGlzdE9wdHMsXG4pOiBQcm9taXNlPEhhcm5lc3NMaXN0U3VtbWFyeT4ge1xuICBjb25zdCBwb3B1bGF0aW9uID0gY29tcGlsZUhhcm5lc3NMaXN0UHJlZGljYXRlKG9wdHMsIHtcbiAgICBpbmNsdWRlS2luZDogZmFsc2UsXG4gICAgaW5jbHVkZUN1cnNvcjogZmFsc2UsXG4gICAgZXhjbHVkZUJhbm5lZDogdHJ1ZSxcbiAgfSk7XG4gIGNvbnN0IG1hdGNoZWRXaGVyZSA9IG9wdHMua2luZCA/ICdXSEVSRSBsaXN0aW5nX2tpbmQgPSA/JyA6ICcnO1xuICBjb25zdCBiaW5kcyA9IFsuLi5wb3B1bGF0aW9uLmJpbmRzLCAuLi4ob3B0cy5raW5kID8gW29wdHMua2luZF0gOiBbXSldO1xuICBjb25zdCBzdG10ID0gZGIucHJlcGFyZShcbiAgICBgV0lUSCBwb3B1bGF0aW9uIEFTIChcbiAgICAgICBTRUxFQ1QgaC5saXN0aW5nX2tpbmRcbiAgICAgICBGUk9NIGhhcm5lc3NlcyBoXG4gICAgICAgV0hFUkUgJHtwb3B1bGF0aW9uLnNxbH1cbiAgICAgKVxuICAgICBTRUxFQ1QgJ3RvdGFsJyBBUyBtZXRyaWMsIE5VTEwgQVMgdmFsdWUsIENPVU5UKCopIEFTIG5cbiAgICAgRlJPTSBwb3B1bGF0aW9uICR7bWF0Y2hlZFdoZXJlfVxuICAgICBVTklPTiBBTExcbiAgICAgU0VMRUNUICdraW5kJyBBUyBtZXRyaWMsIGxpc3Rpbmdfa2luZCBBUyB2YWx1ZSwgQ09VTlQoKikgQVMgblxuICAgICBGUk9NIHBvcHVsYXRpb25cbiAgICAgR1JPVVAgQlkgbGlzdGluZ19raW5kYCxcbiAgKTtcbiAgY29uc3QgYm91bmQgPSAoc3RtdCBhcyB1bmtub3duIGFzIHsgYmluZDogKC4uLnZzOiB1bmtub3duW10pID0+IEQxUHJlcGFyZWRTdGF0ZW1lbnQgfSkuYmluZChcbiAgICAuLi5iaW5kcyxcbiAgKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgYm91bmQuYWxsPHsgbWV0cmljOiAndG90YWwnIHwgJ2tpbmQnOyB2YWx1ZTogTGlzdGluZ0tpbmQgfCBudWxsOyBuOiBudW1iZXIgfT4oKTtcbiAgY29uc3Qga2luZF9mYWNldHMgPSBPYmplY3QuZnJvbUVudHJpZXMoTElTVElOR19LSU5EUy5tYXAoKGtpbmQpID0+IFtraW5kLCAwXSkpIGFzIFJlY29yZDxcbiAgICBMaXN0aW5nS2luZCxcbiAgICBudW1iZXJcbiAgPjtcbiAgbGV0IHRvdGFsID0gMDtcbiAgZm9yIChjb25zdCByb3cgb2YgcmVzLnJlc3VsdHMgPz8gW10pIHtcbiAgICBpZiAocm93Lm1ldHJpYyA9PT0gJ3RvdGFsJykgdG90YWwgPSBOdW1iZXIocm93Lm4pIHx8IDA7XG4gICAgZWxzZSBpZiAocm93LnZhbHVlICYmIGlzTGlzdGluZ0tpbmQocm93LnZhbHVlKSkga2luZF9mYWNldHNbcm93LnZhbHVlXSA9IE51bWJlcihyb3cubikgfHwgMDtcbiAgfVxuICByZXR1cm4geyB0b3RhbCwga2luZF9mYWNldHMgfTtcbn1cblxuLyoqXG4gKiBEZWR1cCBsb29rdXAgZm9yIGEgbm9uLWhhcm5lc3MgbGlzdGluZzogdGhlIGFjdGl2ZSByb3cgbWF0Y2hpbmdcbiAqIChyZXBvLCBraW5kLCBsaXN0aW5nX3JlZikg4oCUIHRoZSB1bmlxdWVuZXNzIGtleSBvZlxuICogYGhhcm5lc3Nlc19hY3RpdmVfbGlzdGluZ191bmlxdWVgLiAoSGFybmVzcy1raW5kIGRlZHVwIGtlZXBzIHVzaW5nXG4gKiBnZXRIYXJuZXNzQnlHaXRodWJSZXBvSWQsIHdoaWNoIG1hdGNoZXMgdGhlIDE6MSBoYXJuZXNzLXJlcG8gaW5kZXguKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWN0aXZlTGlzdGluZ0J5UmVmcyhcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIGdpdGh1Yl9yZXBvc2l0b3J5X2lkOiBudW1iZXIsXG4gIGxpc3Rpbmdfa2luZDogTGlzdGluZ0tpbmQsXG4gIGxpc3RpbmdfcmVmOiBzdHJpbmcsXG4gIHBpbm5lZF9jb21taXRfc2hhPzogc3RyaW5nIHwgbnVsbCxcbik6IFByb21pc2U8SGFybmVzc1JvdyB8IG51bGw+IHtcbiAgY29uc3QgcGluUHJlZGljYXRlID0gcGlubmVkX2NvbW1pdF9zaGEgPT09IHVuZGVmaW5lZFxuICAgID8gJydcbiAgICA6IHBpbm5lZF9jb21taXRfc2hhID09PSBudWxsXG4gICAgICA/ICdBTkQgcGlubmVkX2NvbW1pdF9zaGEgSVMgTlVMTCdcbiAgICAgIDogJ0FORCBwaW5uZWRfY29tbWl0X3NoYSA9ID8nO1xuICBjb25zdCBiaW5kczogdW5rbm93bltdID0gW2dpdGh1Yl9yZXBvc2l0b3J5X2lkLCBsaXN0aW5nX2tpbmQsIGxpc3RpbmdfcmVmXTtcbiAgaWYgKHBpbm5lZF9jb21taXRfc2hhICE9IG51bGwpIGJpbmRzLnB1c2gocGlubmVkX2NvbW1pdF9zaGEpO1xuICBjb25zdCByb3cgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCAqIEZST00gaGFybmVzc2VzXG4gICAgICAgICBXSEVSRSBnaXRodWJfcmVwb3NpdG9yeV9pZCA9ID8gQU5EIGxpc3Rpbmdfa2luZCA9ID8gQU5EIGxpc3RpbmdfcmVmID0gP1xuICAgICAgICAgICBBTkQgdW5saXN0ZWRfYXQgSVMgTlVMTFxuICAgICAgICAgICAke3BpblByZWRpY2F0ZX1cbiAgICAgICAgIExJTUlUIDFgLFxuICAgIClcbiAgICAuYmluZCguLi5iaW5kcylcbiAgICAuZmlyc3Q8SGFybmVzc1Jvdz4oKTtcbiAgcmV0dXJuIHJvdyA/PyBudWxsO1xufVxuXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXJrSGFybmVzc1VubGlzdGVkKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgaWQ6IHN0cmluZyxcbiAgcmVhc29uOiBzdHJpbmcsXG4gIG5vd19tczogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGRiXG4gICAgLnByZXBhcmUoYFVQREFURSBoYXJuZXNzZXMgU0VUIHVubGlzdGVkX2F0ID0gPywgdW5saXN0ZWRfcmVhc29uID0gPywgdXBkYXRlZF9hdCA9ID8gV0hFUkUgaWQgPSA/YClcbiAgICAuYmluZChub3dfbXMsIHJlYXNvbiwgbm93X21zLCBpZClcbiAgICAucnVuKCk7XG59XG5cbi8qKiBSZXRpcmUgdGhlIHByaW9yIGFjdGl2ZSB2ZXJzaW9uIGJlZm9yZSBpbnNlcnRpbmcgYSBjaGFuZ2VkIHBpbm5lZCB2ZXJzaW9uLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN1cGVyc2VkZUhhcm5lc3NMaXN0aW5nKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgb2xkSWQ6IHN0cmluZyxcbiAgc3VjY2Vzc29ySWQ6IHN0cmluZyxcbiAgcmVhc29uOiBzdHJpbmcsXG4gIG5vd19tczogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIGhhcm5lc3Nlc1xuICAgICAgICAgIFNFVCBzdXBlcnNlZGVkX2J5ID0gPywgY2xhaW1fc3RhdHVzID0gJ3N1cGVyc2VkZWQnLCB1bmxpc3RlZF9hdCA9ID8sXG4gICAgICAgICAgICAgIHVubGlzdGVkX3JlYXNvbiA9ID8sIHVwZGF0ZWRfYXQgPSA/XG4gICAgICAgIFdIRVJFIGlkID0gPyBBTkQgdW5saXN0ZWRfYXQgSVMgTlVMTGAsXG4gICAgKVxuICAgIC5iaW5kKHN1Y2Nlc3NvcklkLCBub3dfbXMsIHJlYXNvbiwgbm93X21zLCBvbGRJZClcbiAgICAucnVuKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB1cGRhdGVIYXJuZXNzU3RhdHMoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBpZDogc3RyaW5nLFxuICBzdGF0czoge1xuICAgIHN0YXJzOiBudW1iZXI7XG4gICAgY29udHJpYnV0b3JfY291bnQ6IG51bWJlcjtcbiAgICBsYXN0X2FjdGl2aXR5X2F0OiBudW1iZXIgfCBudWxsO1xuICAgIGxhbmd1YWdlczogc3RyaW5nIHwgbnVsbDtcbiAgfSxcbiAgbm93X21zOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBVUERBVEUgaGFybmVzc2VzXG4gICAgICAgICBTRVQgc3RhcnMgPSA/LFxuICAgICAgICAgICAgIGNvbnRyaWJ1dG9yX2NvdW50ID0gPyxcbiAgICAgICAgICAgICBsYXN0X2FjdGl2aXR5X2F0ID0gPyxcbiAgICAgICAgICAgICBsYW5ndWFnZXMgPSA/LFxuICAgICAgICAgICAgIHN0YXRzX3JlZnJlc2hlZF9hdCA9ID8sXG4gICAgICAgICAgICAgdXBkYXRlZF9hdCA9ID9cbiAgICAgICBXSEVSRSBpZCA9ID9gLFxuICAgIClcbiAgICAuYmluZChcbiAgICAgIHN0YXRzLnN0YXJzLFxuICAgICAgc3RhdHMuY29udHJpYnV0b3JfY291bnQsXG4gICAgICBzdGF0cy5sYXN0X2FjdGl2aXR5X2F0LFxuICAgICAgc3RhdHMubGFuZ3VhZ2VzLFxuICAgICAgbm93X21zLFxuICAgICAgbm93X21zLFxuICAgICAgaWQsXG4gICAgKVxuICAgIC5ydW4oKTtcbn1cblxuLyoqXG4gKiBDbGVhciBhIGxpc3RpbmcncyBjaGFubmVsLTIgYXR0ZXN0YXRpb24gKGl0ZW0gMSkuIENhbGxlZCBieSB0aGUgaW5kZXhlclxuICogd2hlbiB0aGUgYXR0ZXN0YXRpb24gZ2lzdCBpcyBkZWxldGVkIChyZXZvY2F0aW9uKSBvciBubyBsb25nZXIgYmluZHMgdGhlXG4gKiBzdG9yZWQgZGV2aWNlIHB1YmtleSB0byB0aGUgcHVibGlzaGVyIChpbnZhbGlkKS4gTGVhdmVzIHRoZSBsaXN0aW5nIHVwIOKAlFxuICogaXQganVzdCBsb3NlcyBpdHMgdmVyaWZpZWQtcHVibGlzaGVyIHNpZ25hbC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFySGFybmVzc0F0dGVzdGF0aW9uKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgaWQ6IHN0cmluZyxcbiAgbm93X21zOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBVUERBVEUgaGFybmVzc2VzXG4gICAgICAgICBTRVQgcHVibGlzaGVyX2RldmljZV9wdWJrZXkgPSBOVUxMLFxuICAgICAgICAgICAgIHB1Ymxpc2hlcl9hdHRlc3RhdGlvbl9naXN0X2lkID0gTlVMTCxcbiAgICAgICAgICAgICB1cGRhdGVkX2F0ID0gP1xuICAgICAgIFdIRVJFIGlkID0gP2AsXG4gICAgKVxuICAgIC5iaW5kKG5vd19tcywgaWQpXG4gICAgLnJ1bigpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0SGFybmVzc0NsYWltKFxuICBkYjogRDFEYXRhYmFzZSxcbiAgaWQ6IHN0cmluZyxcbiAgY2xhaW06IHsgdXNlcl9pZDogbnVtYmVyOyBsb2dpbjogc3RyaW5nIH0sXG4gIG5vd19tczogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIGhhcm5lc3Nlc1xuICAgICAgICAgU0VUIGNsYWltX3N0YXR1cyA9ICdjbGFpbWVkJyxcbiAgICAgICAgICAgICBjbGFpbWFudF9naXRodWJfdXNlcl9pZCA9ID8sXG4gICAgICAgICAgICAgY2xhaW1hbnRfZ2l0aHViX2xvZ2luID0gPyxcbiAgICAgICAgICAgICB1cGRhdGVkX2F0ID0gP1xuICAgICAgIFdIRVJFIGlkID0gP2AsXG4gICAgKVxuICAgIC5iaW5kKGNsYWltLnVzZXJfaWQsIGNsYWltLmxvZ2luLCBub3dfbXMsIGlkKVxuICAgIC5ydW4oKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGluc2VydFJlcG9ydChkYjogRDFEYXRhYmFzZSwgcjogT21pdDxSZXBvcnRSb3csICdzdGF0dXMnIHwgJ3Jlc29sdmVkX2F0JyB8ICdyZXNvbHZlZF9ieV9vcGVyYXRvcl9ub3RlJz4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyByZXBvcnRzXG4gICAgICAgICAoaWQsIGhhcm5lc3NfaWQsIHJlcG9ydGVyX2dpdGh1Yl91c2VyX2lkLCByZXBvcnRlcl9naXRodWJfbG9naW4sXG4gICAgICAgICAgcmVhc29uLCBpcF9oYXNoLCBzdGF0dXMsIGNyZWF0ZWRfYXQpXG4gICAgICAgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCAncGVuZGluZycsID8pYCxcbiAgICApXG4gICAgLmJpbmQoci5pZCwgci5oYXJuZXNzX2lkLCByLnJlcG9ydGVyX2dpdGh1Yl91c2VyX2lkLCByLnJlcG9ydGVyX2dpdGh1Yl9sb2dpbiwgci5yZWFzb24sIHIuaXBfaGFzaCwgci5jcmVhdGVkX2F0KVxuICAgIC5ydW4oKTtcbn1cblxuLyoqIEEgcmVwb3J0IGpvaW5lZCB3aXRoIGEgdGhpbiBzdW1tYXJ5IG9mIGl0cyB0YXJnZXQgaGFybmVzcywgZm9yIHRoZVxuICogIG9wZXJhdG9yIG1vZGVyYXRpb24gbGlzdCAoYXZvaWRzIGFuIE4rMSBmZXRjaCBwZXIgcmVwb3J0KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVwb3J0V2l0aEhhcm5lc3MgZXh0ZW5kcyBSZXBvcnRSb3cge1xuICBoYXJuZXNzX3RpdGxlOiBzdHJpbmcgfCBudWxsO1xuICBoYXJuZXNzX2dpdGh1Yl91cmw6IHN0cmluZyB8IG51bGw7XG4gIGhhcm5lc3NfdW5saXN0ZWRfYXQ6IG51bWJlciB8IG51bGw7XG59XG5cbi8qKlxuICogTGlzdCByZXBvcnRzIGZvciB0aGUgb3BlcmF0b3IgbW9kZXJhdGlvbiBzdXJmYWNlLCBuZXdlc3QtcGVuZGluZy1maXJzdC5cbiAqIGBzdGF0dXNgIGZpbHRlcnMgdG8gb25lIGxpZmVjeWNsZSBzdGF0ZTsgb21pdCAob3IgcGFzcyAnYWxsJykgZm9yIGV2ZXJ5XG4gKiByZXBvcnQuIEpvaW5lZCB3aXRoIHRoZSBoYXJuZXNzIHNvIHRoZSBvcGVyYXRvciBzZWVzIHdoYXQncyBiZWluZyByZXBvcnRlZFxuICogd2l0aG91dCBhIHNlY29uZCByb3VuZC10cmlwLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdFJlcG9ydHMoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBvcHRzOiB7IHN0YXR1cz86IFJlcG9ydFJvd1snc3RhdHVzJ10gfCAnYWxsJzsgbGltaXQ/OiBudW1iZXIgfSA9IHt9LFxuKTogUHJvbWlzZTxSZXBvcnRXaXRoSGFybmVzc1tdPiB7XG4gIGNvbnN0IGxpbWl0ID0gTWF0aC5taW4oTWF0aC5tYXgob3B0cy5saW1pdCA/PyA1MCwgMSksIDIwMCk7XG4gIGNvbnN0IGZpbHRlclN0YXR1cyA9IG9wdHMuc3RhdHVzICYmIG9wdHMuc3RhdHVzICE9PSAnYWxsJztcbiAgY29uc3Qgc3FsID1cbiAgICBgU0VMRUNUIHIuKixcbiAgICAgICAgICAgIGgudGl0bGUgQVMgaGFybmVzc190aXRsZSxcbiAgICAgICAgICAgIGguZ2l0aHViX3VybCBBUyBoYXJuZXNzX2dpdGh1Yl91cmwsXG4gICAgICAgICAgICBoLnVubGlzdGVkX2F0IEFTIGhhcm5lc3NfdW5saXN0ZWRfYXRcbiAgICAgICBGUk9NIHJlcG9ydHMgclxuICAgICAgIExFRlQgSk9JTiBoYXJuZXNzZXMgaCBPTiBoLmlkID0gci5oYXJuZXNzX2lkYCArXG4gICAgKGZpbHRlclN0YXR1cyA/IGAgV0hFUkUgci5zdGF0dXMgPSA/YCA6IGBgKSArXG4gICAgYCBPUkRFUiBCWSByLmNyZWF0ZWRfYXQgQVNDIExJTUlUID9gO1xuICBjb25zdCBiaW5kczogdW5rbm93bltdID0gZmlsdGVyU3RhdHVzID8gW29wdHMuc3RhdHVzLCBsaW1pdF0gOiBbbGltaXRdO1xuICBjb25zdCBzdG10ID0gZGIucHJlcGFyZShzcWwpO1xuICBjb25zdCBib3VuZCA9IChzdG10IGFzIHVua25vd24gYXMgeyBiaW5kOiAoLi4udnM6IHVua25vd25bXSkgPT4gRDFQcmVwYXJlZFN0YXRlbWVudCB9KS5iaW5kKC4uLmJpbmRzKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgYm91bmQuYWxsPFJlcG9ydFdpdGhIYXJuZXNzPigpO1xuICByZXR1cm4gcmVzLnJlc3VsdHMgPz8gW107XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRSZXBvcnRCeUlkKGRiOiBEMURhdGFiYXNlLCBpZDogc3RyaW5nKTogUHJvbWlzZTxSZXBvcnRSb3cgfCBudWxsPiB7XG4gIGNvbnN0IHJvdyA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoJ1NFTEVDVCAqIEZST00gcmVwb3J0cyBXSEVSRSBpZCA9ID8nKVxuICAgIC5iaW5kKGlkKVxuICAgIC5maXJzdDxSZXBvcnRSb3c+KCk7XG4gIHJldHVybiByb3cgPz8gbnVsbDtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGEgcGVuZGluZyByZXBvcnQuIElkZW1wb3RlbmN5IGd1YXJkOiB0aGUgV0hFUkUgcGlucyBgc3RhdHVzID1cbiAqICdwZW5kaW5nJ2AsIHNvIHJlc29sdmluZyBhbiBhbHJlYWR5LXJlc29sdmVkIHJlcG9ydCBjaGFuZ2VzIDAgcm93cyDigJQgdGhlXG4gKiBjYWxsZXIgdHJlYXRzIGBjaGFuZ2VzID09PSAwYCBhcyBcImFscmVhZHkgaGFuZGxlZCAvIG5vdCBmb3VuZFwiLiBSZXR1cm5zIHRoZVxuICogbnVtYmVyIG9mIHJvd3MgY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVSZXBvcnQoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBpZDogc3RyaW5nLFxuICBvcHRzOiB7IHN0YXR1czogJ3Jlc29sdmVkX3VubGlzdCcgfCAncmVzb2x2ZWRfZGlzbWlzcyc7IG5vdGU6IHN0cmluZyB8IG51bGw7IG5vd19tczogbnVtYmVyIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKFxuICAgICAgYFVQREFURSByZXBvcnRzXG4gICAgICAgICAgU0VUIHN0YXR1cyA9ID8sIHJlc29sdmVkX2F0ID0gPywgcmVzb2x2ZWRfYnlfb3BlcmF0b3Jfbm90ZSA9ID9cbiAgICAgICAgV0hFUkUgaWQgPSA/IEFORCBzdGF0dXMgPSAncGVuZGluZydgLFxuICAgIClcbiAgICAuYmluZChvcHRzLnN0YXR1cywgb3B0cy5ub3dfbXMsIG9wdHMubm90ZSwgaWQpXG4gICAgLnJ1bigpO1xuICByZXR1cm4gKHJlcyBhcyB7IG1ldGE/OiB7IGNoYW5nZXM/OiBudW1iZXIgfSB9KS5tZXRhPy5jaGFuZ2VzID8/IDA7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdWRpdChcbiAgZGI6IEQxRGF0YWJhc2UsXG4gIHRzOiBudW1iZXIsXG4gIGtpbmQ6IHN0cmluZyxcbiAgZGV0YWlsOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGRiXG4gICAgLnByZXBhcmUoJ0lOU0VSVCBJTlRPIGF1ZGl0ICh0cywga2luZCwgZGV0YWlsKSBWQUxVRVMgKD8sID8sID8pJylcbiAgICAuYmluZCh0cywga2luZCwgSlNPTi5zdHJpbmdpZnkoZGV0YWlsKSlcbiAgICAucnVuKCk7XG59XG5cbi8vIOKUgOKUgCBBdXRoZW50aWNhdGVkIGNyZWF0b3IgZHJhZnRzIChQLTAwNykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIENyZWF0b3JEcmFmdFN0YXRlID1cbiAgfCAnZHJhZnQnXG4gIHwgJ3N1Ym1pdHRlZCdcbiAgfCAnYXBwcm92ZWQnXG4gIHwgJ3JlamVjdGVkJ1xuICB8ICdwdWJsaXNoZWQnXG4gIHwgJ3lhbmtlZCdcbiAgfCAncmV2b2tlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3JlYXRvckRyYWZ0Um93IHtcbiAgaWQ6IHN0cmluZztcbiAgb3duZXJfZ2l0aHViX3VzZXJfaWQ6IG51bWJlcjtcbiAgb3duZXJfZ2l0aHViX2xvZ2luOiBzdHJpbmc7XG4gIGxpc3Rpbmdfa2luZDogTGlzdGluZ0tpbmQ7XG4gIGxpc3RpbmdfcmVmOiBzdHJpbmcgfCBudWxsO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nIHwgbnVsbDtcbiAgbWFuaWZlc3RfanNvbjogc3RyaW5nO1xuICBwcm92ZW5hbmNlX2pzb246IHN0cmluZztcbiAgc3RhdGU6IENyZWF0b3JEcmFmdFN0YXRlO1xuICBhcnRpZmFjdF9rZXk6IHN0cmluZyB8IG51bGw7XG4gIGFydGlmYWN0X2NvbnRlbnRfaGFzaDogc3RyaW5nIHwgbnVsbDtcbiAgYXJ0aWZhY3Rfc2l6ZV9ieXRlczogbnVtYmVyIHwgbnVsbDtcbiAgYXJ0aWZhY3RfY29udGVudF90eXBlOiBzdHJpbmcgfCBudWxsO1xuICB1cGxvYWRfdG9rZW5faGFzaDogc3RyaW5nIHwgbnVsbDtcbiAgdXBsb2FkX2V4cGlyZXNfYXQ6IG51bWJlciB8IG51bGw7XG4gIHJldmlld2VkX2F0OiBudW1iZXIgfCBudWxsO1xuICByZXZpZXdlZF9ieV9naXRodWJfdXNlcl9pZDogbnVtYmVyIHwgbnVsbDtcbiAgcmV2aWV3X3JlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgcHVibGlzaGVkX2xpc3RpbmdfaWQ6IHN0cmluZyB8IG51bGw7XG4gIGNyZWF0ZWRfYXQ6IG51bWJlcjtcbiAgdXBkYXRlZF9hdDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE5ld0NyZWF0b3JEcmFmdElucHV0IHtcbiAgaWQ6IHN0cmluZztcbiAgb3duZXJfZ2l0aHViX3VzZXJfaWQ6IG51bWJlcjtcbiAgb3duZXJfZ2l0aHViX2xvZ2luOiBzdHJpbmc7XG4gIGxpc3Rpbmdfa2luZDogTGlzdGluZ0tpbmQ7XG4gIGxpc3RpbmdfcmVmOiBzdHJpbmcgfCBudWxsO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nIHwgbnVsbDtcbiAgbWFuaWZlc3RfanNvbjogc3RyaW5nO1xuICBwcm92ZW5hbmNlX2pzb246IHN0cmluZztcbiAgdXBsb2FkX3Rva2VuX2hhc2g6IHN0cmluZztcbiAgdXBsb2FkX2V4cGlyZXNfYXQ6IG51bWJlcjtcbiAgY3JlYXRlZF9hdDogbnVtYmVyO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5zZXJ0Q3JlYXRvckRyYWZ0KGRiOiBEMURhdGFiYXNlLCBkcmFmdDogTmV3Q3JlYXRvckRyYWZ0SW5wdXQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyBjcmVhdG9yX2RyYWZ0c1xuICAgICAgIChpZCwgb3duZXJfZ2l0aHViX3VzZXJfaWQsIG93bmVyX2dpdGh1Yl9sb2dpbiwgbGlzdGluZ19raW5kLCBsaXN0aW5nX3JlZixcbiAgICAgICAgdGl0bGUsIGRlc2NyaXB0aW9uLCBtYW5pZmVzdF9qc29uLCBwcm92ZW5hbmNlX2pzb24sIHN0YXRlLFxuICAgICAgICB1cGxvYWRfdG9rZW5faGFzaCwgdXBsb2FkX2V4cGlyZXNfYXQsIGNyZWF0ZWRfYXQsIHVwZGF0ZWRfYXQpXG4gICAgICAgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCA/LCAnZHJhZnQnLCA/LCA/LCA/LCA/KWAsXG4gICAgKVxuICAgIC5iaW5kKFxuICAgICAgZHJhZnQuaWQsXG4gICAgICBkcmFmdC5vd25lcl9naXRodWJfdXNlcl9pZCxcbiAgICAgIGRyYWZ0Lm93bmVyX2dpdGh1Yl9sb2dpbixcbiAgICAgIGRyYWZ0Lmxpc3Rpbmdfa2luZCxcbiAgICAgIGRyYWZ0Lmxpc3RpbmdfcmVmLFxuICAgICAgZHJhZnQudGl0bGUsXG4gICAgICBkcmFmdC5kZXNjcmlwdGlvbixcbiAgICAgIGRyYWZ0Lm1hbmlmZXN0X2pzb24sXG4gICAgICBkcmFmdC5wcm92ZW5hbmNlX2pzb24sXG4gICAgICBkcmFmdC51cGxvYWRfdG9rZW5faGFzaCxcbiAgICAgIGRyYWZ0LnVwbG9hZF9leHBpcmVzX2F0LFxuICAgICAgZHJhZnQuY3JlYXRlZF9hdCxcbiAgICAgIGRyYWZ0LmNyZWF0ZWRfYXQsXG4gICAgKVxuICAgIC5ydW4oKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldENyZWF0b3JEcmFmdChkYjogRDFEYXRhYmFzZSwgaWQ6IHN0cmluZyk6IFByb21pc2U8Q3JlYXRvckRyYWZ0Um93IHwgbnVsbD4ge1xuICBjb25zdCByb3cgPSBhd2FpdCBkYi5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIGNyZWF0b3JfZHJhZnRzIFdIRVJFIGlkID0gPycpLmJpbmQoaWQpLmZpcnN0PENyZWF0b3JEcmFmdFJvdz4oKTtcbiAgcmV0dXJuIHJvdyA/PyBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdENyZWF0b3JEcmFmdHMoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBvcHRzOiB7IG93bmVySWQ/OiBudW1iZXI7IHN0YXRlPzogQ3JlYXRvckRyYWZ0U3RhdGU7IGxpbWl0PzogbnVtYmVyOyBvZmZzZXQ/OiBudW1iZXIgfSA9IHt9LFxuKTogUHJvbWlzZTxDcmVhdG9yRHJhZnRSb3dbXT4ge1xuICBjb25zdCBsaW1pdCA9IE1hdGgubWluKE1hdGgubWF4KG9wdHMubGltaXQgPz8gMTAwLCAxKSwgMjAxKTtcbiAgY29uc3Qgd2hlcmU6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGJpbmRzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKG9wdHMub3duZXJJZCAhPSBudWxsKSB7XG4gICAgd2hlcmUucHVzaCgnb3duZXJfZ2l0aHViX3VzZXJfaWQgPSA/Jyk7XG4gICAgYmluZHMucHVzaChvcHRzLm93bmVySWQpO1xuICB9XG4gIGlmIChvcHRzLnN0YXRlKSB7XG4gICAgd2hlcmUucHVzaCgnc3RhdGUgPSA/Jyk7XG4gICAgYmluZHMucHVzaChvcHRzLnN0YXRlKTtcbiAgfVxuICBjb25zdCBzcWwgPSBgU0VMRUNUICogRlJPTSBjcmVhdG9yX2RyYWZ0cyR7d2hlcmUubGVuZ3RoID8gYCBXSEVSRSAke3doZXJlLmpvaW4oJyBBTkQgJyl9YCA6ICcnfSBPUkRFUiBCWSB1cGRhdGVkX2F0IERFU0MsIGlkIEFTQyBMSU1JVCA/IE9GRlNFVCA/YDtcbiAgYmluZHMucHVzaChsaW1pdCk7XG4gIGJpbmRzLnB1c2gob3B0cy5vZmZzZXQgPz8gMCk7XG4gIGNvbnN0IHN0bXQgPSBkYi5wcmVwYXJlKHNxbCk7XG4gIGNvbnN0IGJvdW5kID0gKHN0bXQgYXMgdW5rbm93biBhcyB7IGJpbmQ6ICguLi52YWx1ZXM6IHVua25vd25bXSkgPT4gRDFQcmVwYXJlZFN0YXRlbWVudCB9KS5iaW5kKC4uLmJpbmRzKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYm91bmQuYWxsPENyZWF0b3JEcmFmdFJvdz4oKTtcbiAgcmV0dXJuIHJlc3VsdC5yZXN1bHRzID8/IFtdO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0Q3JlYXRvckRyYWZ0QXJ0aWZhY3QoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBpZDogc3RyaW5nLFxuICBhcnRpZmFjdDoge1xuICAgIGtleTogc3RyaW5nO1xuICAgIGNvbnRlbnRIYXNoOiBzdHJpbmc7XG4gICAgc2l6ZUJ5dGVzOiBudW1iZXI7XG4gICAgY29udGVudFR5cGU6IHN0cmluZztcbiAgICBub3c6IG51bWJlcjtcbiAgfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIGNyZWF0b3JfZHJhZnRzXG4gICAgICAgICAgU0VUIGFydGlmYWN0X2tleSA9ID8sIGFydGlmYWN0X2NvbnRlbnRfaGFzaCA9ID8sIGFydGlmYWN0X3NpemVfYnl0ZXMgPSA/LFxuICAgICAgICAgICAgICBhcnRpZmFjdF9jb250ZW50X3R5cGUgPSA/LCB1cGxvYWRfdG9rZW5faGFzaCA9IE5VTEwsIHVwbG9hZF9leHBpcmVzX2F0ID0gTlVMTCxcbiAgICAgICAgICAgICAgdXBkYXRlZF9hdCA9ID9cbiAgICAgICAgV0hFUkUgaWQgPSA/IEFORCBzdGF0ZSA9ICdkcmFmdCdgLFxuICAgIClcbiAgICAuYmluZChhcnRpZmFjdC5rZXksIGFydGlmYWN0LmNvbnRlbnRIYXNoLCBhcnRpZmFjdC5zaXplQnl0ZXMsIGFydGlmYWN0LmNvbnRlbnRUeXBlLCBhcnRpZmFjdC5ub3csIGlkKVxuICAgIC5ydW4oKTtcbiAgcmV0dXJuIChyZXN1bHQgYXMgeyBtZXRhPzogeyBjaGFuZ2VzPzogbnVtYmVyIH0gfSkubWV0YT8uY2hhbmdlcyA/PyAwO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0Q3JlYXRvckRyYWZ0U3RhdGUoXG4gIGRiOiBEMURhdGFiYXNlLFxuICBpZDogc3RyaW5nLFxuICBmcm9tOiBDcmVhdG9yRHJhZnRTdGF0ZSxcbiAgdG86IENyZWF0b3JEcmFmdFN0YXRlLFxuICBub3c6IG51bWJlcixcbiAgZXh0cmE6IHtcbiAgICByZXZpZXdlZEJ5PzogbnVtYmVyIHwgbnVsbDtcbiAgICByZXZpZXdSZWFzb24/OiBzdHJpbmcgfCBudWxsO1xuICAgIHB1Ymxpc2hlZExpc3RpbmdJZD86IHN0cmluZyB8IG51bGw7XG4gIH0gPSB7fSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIGNyZWF0b3JfZHJhZnRzXG4gICAgICAgICAgU0VUIHN0YXRlID0gPywgcmV2aWV3ZWRfYXQgPSBDT0FMRVNDRSg/LCByZXZpZXdlZF9hdCksXG4gICAgICAgICAgICAgIHJldmlld2VkX2J5X2dpdGh1Yl91c2VyX2lkID0gQ09BTEVTQ0UoPywgcmV2aWV3ZWRfYnlfZ2l0aHViX3VzZXJfaWQpLFxuICAgICAgICAgICAgICByZXZpZXdfcmVhc29uID0gQ09BTEVTQ0UoPywgcmV2aWV3X3JlYXNvbiksXG4gICAgICAgICAgICAgIHB1Ymxpc2hlZF9saXN0aW5nX2lkID0gQ09BTEVTQ0UoPywgcHVibGlzaGVkX2xpc3RpbmdfaWQpLCB1cGRhdGVkX2F0ID0gP1xuICAgICAgICBXSEVSRSBpZCA9ID8gQU5EIHN0YXRlID0gP2AsXG4gICAgKVxuICAgIC5iaW5kKFxuICAgICAgdG8sXG4gICAgICBleHRyYS5yZXZpZXdlZEJ5ID09IG51bGwgPyBudWxsIDogbm93LFxuICAgICAgZXh0cmEucmV2aWV3ZWRCeSA/PyBudWxsLFxuICAgICAgZXh0cmEucmV2aWV3UmVhc29uID8/IG51bGwsXG4gICAgICBleHRyYS5wdWJsaXNoZWRMaXN0aW5nSWQgPz8gbnVsbCxcbiAgICAgIG5vdyxcbiAgICAgIGlkLFxuICAgICAgZnJvbSxcbiAgICApXG4gICAgLnJ1bigpO1xuICByZXR1cm4gKHJlc3VsdCBhcyB7IG1ldGE/OiB7IGNoYW5nZXM/OiBudW1iZXIgfSB9KS5tZXRhPy5jaGFuZ2VzID8/IDA7XG59XG5cbi8vIOKUgOKUgCBDaGFubmVsLTIgcHVibGlzaGVyIGJhbi1saXN0IChpdGVtIDEpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBCYW5uZWRQdWJrZXlSb3cgPSBCYW5uZWRQdWJsaXNoZXJQdWJrZXlzUm93O1xuXG4vKiogU2V0IG9mIGJhbm5lZCBwdWJsaXNoZXIgZGV2aWNlIHB1YmtleXMsIGZvciBmaWx0ZXJpbmcgcHVibGljIGxpc3RpbmdzLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RCYW5uZWRQdWJrZXlTZXQoZGI6IEQxRGF0YWJhc2UpOiBQcm9taXNlPFNldDxzdHJpbmc+PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGRiXG4gICAgLnByZXBhcmUoJ1NFTEVDVCBwdWJrZXkgRlJPTSBiYW5uZWRfcHVibGlzaGVyX3B1YmtleXMnKVxuICAgIC5hbGw8eyBwdWJrZXk6IHN0cmluZyB9PigpO1xuICByZXR1cm4gbmV3IFNldCgocmVzLnJlc3VsdHMgPz8gW10pLm1hcCgocikgPT4gci5wdWJrZXkpKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RCYW5uZWRQdWJrZXlzKGRiOiBEMURhdGFiYXNlKTogUHJvbWlzZTxCYW5uZWRQdWJrZXlSb3dbXT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBkYlxuICAgIC5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIGJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cyBPUkRFUiBCWSBhZGRlZF9hdCBERVNDJylcbiAgICAuYWxsPEJhbm5lZFB1YmtleVJvdz4oKTtcbiAgcmV0dXJuIHJlcy5yZXN1bHRzID8/IFtdO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYmFuUHVibGlzaGVyUHVia2V5KFxuICBkYjogRDFEYXRhYmFzZSxcbiAgcHVia2V5OiBzdHJpbmcsXG4gIHJlYXNvbjogc3RyaW5nLFxuICBvcGVyYXRvclVzZXJJZDogbnVtYmVyIHwgbnVsbCxcbiAgbm93X21zOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgZGJcbiAgICAucHJlcGFyZShcbiAgICAgIGBJTlNFUlQgSU5UTyBiYW5uZWRfcHVibGlzaGVyX3B1YmtleXMgKHB1YmtleSwgcmVhc29uLCBhZGRlZF9hdCwgYWRkZWRfYnlfb3BlcmF0b3JfdXNlcl9pZCwgdXBkYXRlZF9hdClcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8pXG4gICAgICAgT04gQ09ORkxJQ1QocHVia2V5KSBETyBVUERBVEUgU0VUIHJlYXNvbiA9ID8sIHVwZGF0ZWRfYXQgPSA/YCxcbiAgICApXG4gICAgLmJpbmQocHVia2V5LCByZWFzb24sIG5vd19tcywgb3BlcmF0b3JVc2VySWQsIG5vd19tcywgcmVhc29uLCBub3dfbXMpXG4gICAgLnJ1bigpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdW5iYW5QdWJsaXNoZXJQdWJrZXkoZGI6IEQxRGF0YWJhc2UsIHB1YmtleTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGRiLnByZXBhcmUoJ0RFTEVURSBGUk9NIGJhbm5lZF9wdWJsaXNoZXJfcHVia2V5cyBXSEVSRSBwdWJrZXkgPSA/JykuYmluZChwdWJrZXkpLnJ1bigpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xpZW50SXAocmVxOiBSZXF1ZXN0KTogc3RyaW5nIHtcbiAgLy8gQ2xvdWRmbGFyZSBXb3JrZXJzIGF0dGFjaGVzIHRoZSBvcmlnaW5hdGluZyBJUCBoZXJlLlxuICByZXR1cm4gcmVxLmhlYWRlcnMuZ2V0KCdjZi1jb25uZWN0aW5nLWlwJykgPz8gcmVxLmhlYWRlcnMuZ2V0KCd4LWZvcndhcmRlZC1mb3InKT8uc3BsaXQoJywnKVswXT8udHJpbSgpID8/ICcnO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaXBIYXNoKGlwOiBzdHJpbmcsIHBlcHBlcjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKCFpcCkgcmV0dXJuICcnO1xuICBjb25zdCBlbmMgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgY29uc3QgYnVmID0gZW5jLmVuY29kZShgJHtpcH06JHtwZXBwZXJ9YCk7XG4gIGNvbnN0IGhhc2ggPSBhd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsIGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKG5ldyBVaW50OEFycmF5KGhhc2gpKVxuICAgIC5tYXAoKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsICcwJykpXG4gICAgLmpvaW4oJycpXG4gICAgLnNsaWNlKDAsIDMyKTtcbn1cbiJdLCJmaWxlIjoiL3NyYy9kYi50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL2RiLnRzIiwiL3NyYy9kYi50cyIsW11d
}}