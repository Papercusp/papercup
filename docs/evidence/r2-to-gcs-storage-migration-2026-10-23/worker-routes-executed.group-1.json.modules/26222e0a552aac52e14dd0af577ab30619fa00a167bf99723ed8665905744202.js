'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("requireOperator", () => { try { return requireOperator } catch {} });
__vite_ssr_exportName__("adminRoute", () => { try { return adminRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","extractBearer","isCupboardOperator","resolveGithubBearer"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/content-pin.ts", {"importedNames":["COMMIT_SHA_RE","diffListingContent","isSelfDescribingKind","pinListingContent","pinRefusalToHttp"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["approveListingVersion","audit","banPublisherPubkey","getActiveListingByRefs","getHarnessById","getPreviouslyApprovedVersion","listVersionsSupersededByApproval","getReportById","listBannedPubkeys","listPendingReview","listReports","markHarnessUnlisted","resolveReport","setReviewStatus","unbanPublisherPubkey"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/src/ledger-chain-store.ts", {"importedNames":["LEDGER_STREAM_IDS","exportLedgerStream","isLedgerStreamId","verifyLedgerStream","witnessLedgerStream"]});





const HEX64 = /^[0-9a-f]{64}$/;
function parseExpectedHead(url) {
  const seqRaw = url.searchParams.get("headSeq");
  const hash = url.searchParams.get("headHash");
  if (seqRaw == null && hash == null) return null;
  const seq = Number(seqRaw);
  if (seqRaw == null || hash == null || !Number.isSafeInteger(seq) || seq < 0 || !HEX64.test(hash)) return "invalid";
  return { seq, entryHash: hash };
}
async function requireOperator(c) {
  let user;
  try {
    user = await (0,__vite_ssr_import_1__.resolveGithubBearer)(c.req.raw);
  } catch (e) {
    if (e instanceof __vite_ssr_import_1__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
    throw e;
  };
  if (!(0,__vite_ssr_import_1__.isCupboardOperator)(user.id, c.env)) {
    return c.json({ error: "forbidden", reason: "not_an_operator" }, 403);
  };
  return user;
};
function adminRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.get("/admin/reports", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const raw = new URL(c.req.url).searchParams.get("status") ?? "pending";
    const status = raw === "pending" || raw === "resolved_unlist" || raw === "resolved_dismiss" || raw === "all" ? raw : "pending";
    const reports = await (0,__vite_ssr_import_3__.listReports)(c.env.DB, { status });
    return c.json({ reports, status });
  });
  app.post("/admin/reports/:id/resolve", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param("id");
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (body.action !== "unlist" && body.action !== "dismiss") {
      return c.json({ error: "invalid_field", field: "action" }, 400);
    };
    if (body.note != null && (typeof body.note !== "string" || body.note.length > 1e3)) {
      return c.json({ error: "invalid_field", field: "note" }, 400);
    };
    const report = await (0,__vite_ssr_import_3__.getReportById)(c.env.DB, id);
    if (!report) return c.json({ error: "not_found" }, 404);
    if (report.status !== "pending") {
      return c.json({ error: "already_resolved", status: report.status }, 409);
    };
    const now = Date.now();
    const resolvedStatus = body.action === "unlist" ? "resolved_unlist" : "resolved_dismiss";
    const changes = await (0,__vite_ssr_import_3__.resolveReport)(c.env.DB, id, {
      status: resolvedStatus,
      note: body.note?.trim() || null,
      now_ms: now
    });
    if (changes === 0) return c.json({ error: "already_resolved" }, 409);
    let harness_unlisted = false;
    if (body.action === "unlist") {
      const harness = await (0,__vite_ssr_import_3__.getHarnessById)(c.env.DB, report.harness_id);
      if (harness && !harness.unlisted_at) {
        await (0,__vite_ssr_import_3__.markHarnessUnlisted)(c.env.DB, report.harness_id, `report:${id}`, now);
        harness_unlisted = true;
      }
    };
    await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "report_resolved", {
      report_id: id,
      harness_id: report.harness_id,
      action: body.action,
      operator_github_user_id: op.id,
      harness_unlisted
    });
    return c.json({ ok: true, status: resolvedStatus, harness_unlisted });
  });
  app.get("/admin/pending", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const pending = await (0,__vite_ssr_import_3__.listPendingReview)(c.env.DB);
    return c.json({ pending });
  });
  app.post("/admin/listings/:id/review", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param("id");
    let body = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (body.decision !== "approve" && body.decision !== "reject") {
      return c.json({ error: "invalid_field", field: "decision" }, 400);
    };
    if (body.reason != null && (typeof body.reason !== "string" || body.reason.length > 1e3)) {
      return c.json({ error: "invalid_field", field: "reason" }, 400);
    };
    if (body.reviewed_commit_sha != null && (typeof body.reviewed_commit_sha !== "string" || !__vite_ssr_import_2__.COMMIT_SHA_RE.test(body.reviewed_commit_sha))) {
      return c.json({ error: "invalid_field", field: "reviewed_commit_sha" }, 400);
    };
    const row = await (0,__vite_ssr_import_3__.getHarnessById)(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: "not_found" }, 404);
    if (row.review_status !== "pending") {
      return c.json({ error: "not_pending", review_status: row.review_status }, 409);
    };
    if (body.decision === "approve" && (0,__vite_ssr_import_2__.isSelfDescribingKind)(row.listing_kind) && (row.pinned_commit_sha == null || row.pinned_tree_digest == null)) {
      return c.json({
        error: "content_pin_required",
        listing_kind: row.listing_kind,
        reason: "republish_required_before_approval"
      }, 409);
    };
    const now = Date.now();
    const reason = body.reason?.trim() || null;
    if (body.decision === "reject") {
      await (0,__vite_ssr_import_3__.setReviewStatus)(c.env.DB, id, "rejected", reason, now);
      await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "review_decided", {
        id,
        listing_kind: row.listing_kind,
        decision: "rejected",
        operator_github_user_id: op.id,
        publisher_github_user_id: row.publisher_github_user_id
      });
      return c.json({ ok: true, id, review_status: "rejected" });
    };
    let approved = null;
    let repinned = false;
    let repinAuthority = null;
    if ((0,__vite_ssr_import_2__.isSelfDescribingKind)(row.listing_kind)) {
      approved = { commitSha: row.pinned_commit_sha, treeDigest: row.pinned_tree_digest };
      const reviewed = body.reviewed_commit_sha;
      if (reviewed != null && reviewed !== row.pinned_commit_sha) {
        const clash = await (0,__vite_ssr_import_3__.getActiveListingByRefs)(
          c.env.DB,
          row.github_repository_id,
          row.listing_kind,
          row.listing_ref,
          reviewed
        );
        if (clash && clash.id !== id) {
          return c.json({ error: "version_exists", existing_id: clash.id, commit_sha: reviewed }, 409);
        };
        const repin = await (0,__vite_ssr_import_2__.pinListingContent)({
          token: (0,__vite_ssr_import_1__.extractBearer)(c.req.raw),
          owner: row.github_owner,
          name: row.github_name,
          defaultBranch: "",
          listingRef: row.listing_ref,
          commitSha: reviewed,
          kind: row.listing_kind
        });
        if (!repin.ok) {
          const refusal = (0,__vite_ssr_import_2__.pinRefusalToHttp)(repin);
          return c.json(refusal.body, refusal.status);
        };
        approved = { commitSha: repin.commitSha, treeDigest: repin.treeDigest };
        repinAuthority = repin.recipeAuthority ?? null;
        repinned = true;
      }
    };
    const superseded = approved ? await (0,__vite_ssr_import_3__.listVersionsSupersededByApproval)(c.env.DB, row) : [];
    await (0,__vite_ssr_import_3__.approveListingVersion)(c.env.DB, {
      id,
      reason,
      now,
      approved,
      repinned,
      authority: repinAuthority,
      retire: approved ? row : null,
      // WI-10004643: the audit row rides in the approval's own atomic batch (D1 has no
      // transaction across two calls), so a Worker failure can't leave an approval unaudited.
      audit: {
        kind: "review_decided",
        detail: {
          id,
          listing_kind: row.listing_kind,
          decision: "approved",
          operator_github_user_id: op.id,
          publisher_github_user_id: row.publisher_github_user_id,
          approved_commit_sha: approved?.commitSha ?? null,
          repinned,
          from_pinned_commit_sha: repinned ? row.pinned_commit_sha : null,
          retired_ids: superseded.map((v) => v.id)
        }
      }
    });
    return c.json({
      ok: true,
      id,
      review_status: "approved",
      approved_commit_sha: approved?.commitSha ?? null,
      repinned,
      retired_ids: superseded.map((v) => v.id)
    });
  });
  app.get("/admin/listings/:id/review-diff", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param("id");
    const row = await (0,__vite_ssr_import_3__.getHarnessById)(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: "not_found" }, 404);
    if (row.review_status !== "pending") {
      return c.json({ error: "not_pending", review_status: row.review_status }, 409);
    };
    if (!(0,__vite_ssr_import_2__.isSelfDescribingKind)(row.listing_kind) || row.listing_ref == null) {
      return c.json({ error: "not_self_describing", listing_kind: row.listing_kind }, 409);
    };
    if (row.pinned_commit_sha == null) {
      return c.json({ error: "content_pin_required", reason: "republish_required_before_review" }, 409);
    };
    const previous = await (0,__vite_ssr_import_3__.getPreviouslyApprovedVersion)(
      c.env.DB,
      {
        github_repository_id: row.github_repository_id,
        listing_kind: row.listing_kind,
        listing_ref: row.listing_ref
      },
      id
    );
    const diff = await (0,__vite_ssr_import_2__.diffListingContent)({
      token: (0,__vite_ssr_import_1__.extractBearer)(c.req.raw),
      owner: row.github_owner,
      name: row.github_name,
      listingRef: row.listing_ref,
      toCommitSha: row.pinned_commit_sha,
      fromCommitSha: previous?.approved_commit_sha ?? previous?.pinned_commit_sha ?? null
    });
    if (!diff.ok) {
      const refusal = (0,__vite_ssr_import_2__.pinRefusalToHttp)(diff);
      return c.json(refusal.body, refusal.status);
    };
    return c.json({
      id,
      listing_kind: row.listing_kind,
      listing_ref: row.listing_ref,
      first_version: diff.fromCommitSha == null,
      from_commit_sha: diff.fromCommitSha,
      from_listing_id: previous?.id ?? null,
      to_commit_sha: diff.toCommitSha,
      files: diff.files,
      unchanged_count: diff.unchangedCount
    });
  });
  app.post("/admin/harnesses/:id/unlist", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const id = c.req.param("id");
    let body = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (body.reason != null && (typeof body.reason !== "string" || body.reason.length > 1e3)) {
      return c.json({ error: "invalid_field", field: "reason" }, 400);
    };
    const harness = await (0,__vite_ssr_import_3__.getHarnessById)(c.env.DB, id);
    if (!harness) return c.json({ error: "not_found" }, 404);
    if (harness.unlisted_at) return c.json({ ok: true, already_unlisted: true });
    const now = Date.now();
    await (0,__vite_ssr_import_3__.markHarnessUnlisted)(c.env.DB, id, "by_operator", now);
    await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "operator_unlisted", {
      harness_id: id,
      operator_github_user_id: op.id,
      reason: body.reason?.trim() || null
    });
    return c.json({ ok: true });
  });
  app.get("/admin/banned-pubkeys", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const banned = await (0,__vite_ssr_import_3__.listBannedPubkeys)(c.env.DB);
    return c.json({ banned });
  });
  app.post("/admin/banned-pubkeys", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (typeof body.pubkey !== "string" || !body.pubkey || body.pubkey.length > 200) {
      return c.json({ error: "invalid_field", field: "pubkey" }, 400);
    };
    if (body.reason != null && (typeof body.reason !== "string" || body.reason.length > 1e3)) {
      return c.json({ error: "invalid_field", field: "reason" }, 400);
    };
    const now = Date.now();
    await (0,__vite_ssr_import_3__.banPublisherPubkey)(c.env.DB, body.pubkey, body.reason?.trim() || "unspecified", op.id, now);
    await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "publisher_pubkey_banned", {
      pubkey: body.pubkey,
      operator_github_user_id: op.id,
      reason: body.reason?.trim() || null
    });
    return c.json({ ok: true });
  });
  app.post("/admin/banned-pubkeys/remove", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    };
    if (typeof body.pubkey !== "string" || !body.pubkey) {
      return c.json({ error: "invalid_field", field: "pubkey" }, 400);
    };
    const now = Date.now();
    await (0,__vite_ssr_import_3__.unbanPublisherPubkey)(c.env.DB, body.pubkey);
    await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "publisher_pubkey_unbanned", {
      pubkey: body.pubkey,
      operator_github_user_id: op.id
    });
    return c.json({ ok: true });
  });
  app.get("/admin/ledger-chain", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streams = [];
    for (const streamId of __vite_ssr_import_4__.LEDGER_STREAM_IDS) streams.push(await (0,__vite_ssr_import_4__.verifyLedgerStream)(c.env.DB, streamId));
    return c.json({ ok: streams.every((s) => s.ok), streams });
  });
  app.get("/admin/ledger-chain/:stream/verify", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param("stream");
    if (!(0,__vite_ssr_import_4__.isLedgerStreamId)(streamId)) return c.json({ error: "unknown_stream", streams: __vite_ssr_import_4__.LEDGER_STREAM_IDS }, 404);
    const expectedHead = parseExpectedHead(new URL(c.req.url));
    if (expectedHead === "invalid") return c.json({ error: "invalid_field", field: "headSeq/headHash" }, 400);
    const report = await (0,__vite_ssr_import_4__.verifyLedgerStream)(c.env.DB, streamId, { expectedHead });
    return c.json(report);
  });
  app.get("/admin/ledger-chain/:stream/export", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param("stream");
    if (!(0,__vite_ssr_import_4__.isLedgerStreamId)(streamId)) return c.json({ error: "unknown_stream", streams: __vite_ssr_import_4__.LEDGER_STREAM_IDS }, 404);
    const body = await (0,__vite_ssr_import_4__.exportLedgerStream)(c.env.DB, streamId);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="${streamId}.chain.jsonl"`
      }
    });
  });
  app.post("/admin/ledger-chain/:stream/witness", async (c) => {
    const op = await requireOperator(c);
    if (op instanceof Response) return op;
    const streamId = c.req.param("stream");
    if (!(0,__vite_ssr_import_4__.isLedgerStreamId)(streamId)) return c.json({ error: "unknown_stream", streams: __vite_ssr_import_4__.LEDGER_STREAM_IDS }, 404);
    const now = Date.now();
    const result = await (0,__vite_ssr_import_4__.witnessLedgerStream)(c.env.DB, streamId, now);
    await (0,__vite_ssr_import_3__.audit)(c.env.DB, now, "ledger_chain_witnessed", {
      stream_id: streamId,
      appended: result.appended,
      operator_github_user_id: op.id
    });
    return c.json({ ok: true, ...result });
  });
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTs7QUFxQkE7QUFHQTtBQUNBO0FBT0E7QUFpQkE7Ozs7OztBQVFBLE1BQU0sUUFBUTtBQUdkLFNBQVMsa0JBQWtCLEtBQWlFO0FBQzFGLFFBQU0sU0FBUyxJQUFJLGFBQWEsSUFBSSxTQUFTO0FBQzdDLFFBQU0sT0FBTyxJQUFJLGFBQWEsSUFBSSxVQUFVO0FBQzVDLE1BQUksVUFBVSxRQUFRLFFBQVEsS0FBTSxRQUFPO0FBQzNDLFFBQU0sTUFBTSxPQUFPLE1BQU07QUFDekIsTUFBSSxVQUFVLFFBQVEsUUFBUSxRQUFRLENBQUMsT0FBTyxjQUFjLEdBQUcsS0FBSyxNQUFNLEtBQUssQ0FBQyxNQUFNLEtBQUssSUFBSSxFQUFHLFFBQU87QUFDekcsU0FBTyxFQUFFLEtBQUssV0FBVyxLQUFLO0FBQ2hDO0FBZ0JBLGVBQXNCLGdCQUNwQixHQUNtRDtBQUNuRCxNQUFJO0FBQ0osTUFBSTtBQUNGLFdBQU8sU0FBTSwyQ0FBb0IsRUFBRSxJQUFJLEdBQUc7QUFBQSxFQUM1QyxTQUFTLEdBQUc7QUFDVixRQUFJLGFBQWEsZ0NBQVcsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8sR0FBRyxHQUFHO0FBQ2xGLFVBQU07QUFBQSxFQUNSO0FBQ0EsTUFBSSxJQUFDLDBDQUFtQixLQUFLLElBQUksRUFBRSxHQUFHLEdBQUc7QUFDdkMsV0FBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGFBQWEsUUFBUSxrQkFBa0IsR0FBRyxHQUFHO0FBQUEsRUFDdEU7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLGFBQXNDO0FBQ3BELFFBQU0sTUFBTSxJQUFJLDJCQUF3QjtBQUd4QyxNQUFJLElBQUksa0JBQWtCLE9BQU8sTUFBTTtBQUNyQyxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sTUFBTSxJQUFJLElBQUksRUFBRSxJQUFJLEdBQUcsRUFBRSxhQUFhLElBQUksUUFBUSxLQUFLO0FBQzdELFVBQU0sU0FDSixRQUFRLGFBQWEsUUFBUSxxQkFBcUIsUUFBUSxzQkFBc0IsUUFBUSxRQUNwRixNQUNBO0FBQ04sVUFBTSxVQUFVLFNBQU0sbUNBQVksRUFBRSxJQUFJLElBQUksRUFBRSxPQUFPLENBQUM7QUFDdEQsV0FBTyxFQUFFLEtBQUssRUFBRSxTQUFTLE9BQU8sQ0FBQztBQUFBLEVBQ25DLENBQUM7QUFHRCxNQUFJLEtBQUssOEJBQThCLE9BQU8sTUFBTTtBQUNsRCxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sS0FBSyxFQUFFLElBQUksTUFBTSxJQUFJO0FBRTNCLFFBQUk7QUFDSixRQUFJO0FBQ0YsYUFBUSxNQUFNLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDM0IsUUFBUTtBQUNOLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxlQUFlLEdBQUcsR0FBRztBQUFBLElBQzlDO0FBQ0EsUUFBSSxLQUFLLFdBQVcsWUFBWSxLQUFLLFdBQVcsV0FBVztBQUN6RCxhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8saUJBQWlCLE9BQU8sU0FBUyxHQUFHLEdBQUc7QUFBQSxJQUNoRTtBQUNBLFFBQUksS0FBSyxRQUFRLFNBQVMsT0FBTyxLQUFLLFNBQVMsWUFBWSxLQUFLLEtBQUssU0FBUyxNQUFPO0FBQ25GLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxpQkFBaUIsT0FBTyxPQUFPLEdBQUcsR0FBRztBQUFBLElBQzlEO0FBRUEsVUFBTSxTQUFTLFNBQU0scUNBQWMsRUFBRSxJQUFJLElBQUksRUFBRTtBQUMvQyxRQUFJLENBQUMsT0FBUSxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sWUFBWSxHQUFHLEdBQUc7QUFDdEQsUUFBSSxPQUFPLFdBQVcsV0FBVztBQUMvQixhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sb0JBQW9CLFFBQVEsT0FBTyxPQUFPLEdBQUcsR0FBRztBQUFBLElBQ3pFO0FBRUEsVUFBTSxNQUFNLEtBQUssSUFBSTtBQUNyQixVQUFNLGlCQUFpQixLQUFLLFdBQVcsV0FBVyxvQkFBb0I7QUFDdEUsVUFBTSxVQUFVLFNBQU0scUNBQWMsRUFBRSxJQUFJLElBQUksSUFBSTtBQUFBLE1BQ2hELFFBQVE7QUFBQSxNQUNSLE1BQU0sS0FBSyxNQUFNLEtBQUssS0FBSztBQUFBLE1BQzNCLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFHRCxRQUFJLFlBQVksRUFBRyxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sbUJBQW1CLEdBQUcsR0FBRztBQUVuRSxRQUFJLG1CQUFtQjtBQUN2QixRQUFJLEtBQUssV0FBVyxVQUFVO0FBQzVCLFlBQU0sVUFBVSxTQUFNLHNDQUFlLEVBQUUsSUFBSSxJQUFJLE9BQU8sVUFBVTtBQUNoRSxVQUFJLFdBQVcsQ0FBQyxRQUFRLGFBQWE7QUFDbkMsaUJBQU0sMkNBQW9CLEVBQUUsSUFBSSxJQUFJLE9BQU8sWUFBWSxVQUFVLEVBQUUsSUFBSSxHQUFHO0FBQzFFLDJCQUFtQjtBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUNBLGFBQU0sNkJBQU0sRUFBRSxJQUFJLElBQUksS0FBSyxtQkFBbUI7QUFBQSxNQUM1QyxXQUFXO0FBQUEsTUFDWCxZQUFZLE9BQU87QUFBQSxNQUNuQixRQUFRLEtBQUs7QUFBQSxNQUNiLHlCQUF5QixHQUFHO0FBQUEsTUFDNUI7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksTUFBTSxRQUFRLGdCQUFnQixpQkFBaUIsQ0FBQztBQUFBLEVBQ3RFLENBQUM7QUFLRCxNQUFJLElBQUksa0JBQWtCLE9BQU8sTUFBTTtBQUNyQyxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sVUFBVSxTQUFNLHlDQUFrQixFQUFFLElBQUksRUFBRTtBQUNoRCxXQUFPLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQztBQUFBLEVBQzNCLENBQUM7QUFLRCxNQUFJLEtBQUssOEJBQThCLE9BQU8sTUFBTTtBQUNsRCxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sS0FBSyxFQUFFLElBQUksTUFBTSxJQUFJO0FBRTNCLFFBQUksT0FBNkUsQ0FBQztBQUNsRixRQUFJO0FBQ0YsYUFBUSxNQUFNLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDM0IsUUFBUTtBQUNOLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxlQUFlLEdBQUcsR0FBRztBQUFBLElBQzlDO0FBQ0EsUUFBSSxLQUFLLGFBQWEsYUFBYSxLQUFLLGFBQWEsVUFBVTtBQUM3RCxhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8saUJBQWlCLE9BQU8sV0FBVyxHQUFHLEdBQUc7QUFBQSxJQUNsRTtBQUNBLFFBQUksS0FBSyxVQUFVLFNBQVMsT0FBTyxLQUFLLFdBQVcsWUFBWSxLQUFLLE9BQU8sU0FBUyxNQUFPO0FBQ3pGLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxpQkFBaUIsT0FBTyxTQUFTLEdBQUcsR0FBRztBQUFBLElBQ2hFO0FBSUEsUUFDRSxLQUFLLHVCQUF1QixTQUMzQixPQUFPLEtBQUssd0JBQXdCLFlBQVksQ0FBQyxvQ0FBYyxLQUFLLEtBQUssbUJBQW1CLElBQzdGO0FBQ0EsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGlCQUFpQixPQUFPLHNCQUFzQixHQUFHLEdBQUc7QUFBQSxJQUM3RTtBQUVBLFVBQU0sTUFBTSxTQUFNLHNDQUFlLEVBQUUsSUFBSSxJQUFJLEVBQUU7QUFDN0MsUUFBSSxDQUFDLE9BQU8sSUFBSSxZQUFhLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxZQUFZLEdBQUcsR0FBRztBQUN0RSxRQUFJLElBQUksa0JBQWtCLFdBQVc7QUFDbkMsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGVBQWUsZUFBZSxJQUFJLGNBQWMsR0FBRyxHQUFHO0FBQUEsSUFDL0U7QUFNQSxRQUNFLEtBQUssYUFBYSxnQkFDbEIsNENBQXFCLElBQUksWUFBWSxNQUNwQyxJQUFJLHFCQUFxQixRQUFRLElBQUksc0JBQXNCLE9BQzVEO0FBQ0EsYUFBTyxFQUFFLEtBQUs7QUFBQSxRQUNaLE9BQU87QUFBQSxRQUNQLGNBQWMsSUFBSTtBQUFBLFFBQ2xCLFFBQVE7QUFBQSxNQUNWLEdBQUcsR0FBRztBQUFBLElBQ1I7QUFFQSxVQUFNLE1BQU0sS0FBSyxJQUFJO0FBQ3JCLFVBQU0sU0FBUyxLQUFLLFFBQVEsS0FBSyxLQUFLO0FBQ3RDLFFBQUksS0FBSyxhQUFhLFVBQVU7QUFDOUIsZUFBTSx1Q0FBZ0IsRUFBRSxJQUFJLElBQUksSUFBSSxZQUFZLFFBQVEsR0FBRztBQUMzRCxlQUFNLDZCQUFNLEVBQUUsSUFBSSxJQUFJLEtBQUssa0JBQWtCO0FBQUEsUUFDM0M7QUFBQSxRQUNBLGNBQWMsSUFBSTtBQUFBLFFBQ2xCLFVBQVU7QUFBQSxRQUNWLHlCQUF5QixHQUFHO0FBQUEsUUFDNUIsMEJBQTBCLElBQUk7QUFBQSxNQUNoQyxDQUFDO0FBQ0QsYUFBTyxFQUFFLEtBQUssRUFBRSxJQUFJLE1BQU0sSUFBSSxlQUFlLFdBQVcsQ0FBQztBQUFBLElBQzNEO0FBSUEsUUFBSSxXQUE2RDtBQUNqRSxRQUFJLFdBQVc7QUFDZixRQUFJLGlCQUF1RTtBQUMzRSxXQUFJLDRDQUFxQixJQUFJLFlBQVksR0FBRztBQUUxQyxpQkFBVyxFQUFFLFdBQVcsSUFBSSxtQkFBNkIsWUFBWSxJQUFJLG1CQUE2QjtBQUN0RyxZQUFNLFdBQVcsS0FBSztBQUN0QixVQUFJLFlBQVksUUFBUSxhQUFhLElBQUksbUJBQW1CO0FBSTFELGNBQU0sUUFBUSxTQUFNO0FBQUEsVUFDbEIsRUFBRSxJQUFJO0FBQUEsVUFDTixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsVUFDSjtBQUFBLFFBQ0Y7QUFDQSxZQUFJLFNBQVMsTUFBTSxPQUFPLElBQUk7QUFDNUIsaUJBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxrQkFBa0IsYUFBYSxNQUFNLElBQUksWUFBWSxTQUFTLEdBQUcsR0FBRztBQUFBLFFBQzdGO0FBQ0EsY0FBTSxRQUFRLFNBQU0seUNBQWtCO0FBQUEsVUFDcEMsVUFBTyxxQ0FBYyxFQUFFLElBQUksR0FBRztBQUFBLFVBQzlCLE9BQU8sSUFBSTtBQUFBLFVBQ1gsTUFBTSxJQUFJO0FBQUEsVUFDVixlQUFlO0FBQUEsVUFDZixZQUFZLElBQUk7QUFBQSxVQUNoQixXQUFXO0FBQUEsVUFDWCxNQUFNLElBQUk7QUFBQSxRQUNaLENBQUM7QUFDRCxZQUFJLENBQUMsTUFBTSxJQUFJO0FBQ2IsZ0JBQU0sYUFBVSx3Q0FBaUIsS0FBSztBQUN0QyxpQkFBTyxFQUFFLEtBQUssUUFBUSxNQUFNLFFBQVEsTUFBTTtBQUFBLFFBQzVDO0FBQ0EsbUJBQVcsRUFBRSxXQUFXLE1BQU0sV0FBVyxZQUFZLE1BQU0sV0FBVztBQUd0RSx5QkFBaUIsTUFBTSxtQkFBbUI7QUFDMUMsbUJBQVc7QUFBQSxNQUNiO0FBQUEsSUFDRjtBQUNBLFVBQU0sYUFBYSxXQUFXLFNBQU0sd0RBQWlDLEVBQUUsSUFBSSxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQ3ZGLGFBQU0sNkNBQXNCLEVBQUUsSUFBSSxJQUFJO0FBQUEsTUFDcEM7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxXQUFXO0FBQUEsTUFDWCxRQUFRLFdBQVcsTUFBTTtBQUFBO0FBQUE7QUFBQSxNQUd6QixPQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsUUFDTixRQUFRO0FBQUEsVUFDTjtBQUFBLFVBQ0EsY0FBYyxJQUFJO0FBQUEsVUFDbEIsVUFBVTtBQUFBLFVBQ1YseUJBQXlCLEdBQUc7QUFBQSxVQUM1QiwwQkFBMEIsSUFBSTtBQUFBLFVBQzlCLHFCQUFxQixVQUFVLGFBQWE7QUFBQSxVQUM1QztBQUFBLFVBQ0Esd0JBQXdCLFdBQVcsSUFBSSxvQkFBb0I7QUFBQSxVQUMzRCxhQUFhLFdBQVcsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBQUEsUUFDekM7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQ0QsV0FBTyxFQUFFLEtBQUs7QUFBQSxNQUNaLElBQUk7QUFBQSxNQUNKO0FBQUEsTUFDQSxlQUFlO0FBQUEsTUFDZixxQkFBcUIsVUFBVSxhQUFhO0FBQUEsTUFDNUM7QUFBQSxNQUNBLGFBQWEsV0FBVyxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFBQSxJQUN6QyxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBT0QsTUFBSSxJQUFJLG1DQUFtQyxPQUFPLE1BQU07QUFDdEQsVUFBTSxLQUFLLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEMsUUFBSSxjQUFjLFNBQVUsUUFBTztBQUNuQyxVQUFNLEtBQUssRUFBRSxJQUFJLE1BQU0sSUFBSTtBQUMzQixVQUFNLE1BQU0sU0FBTSxzQ0FBZSxFQUFFLElBQUksSUFBSSxFQUFFO0FBQzdDLFFBQUksQ0FBQyxPQUFPLElBQUksWUFBYSxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sWUFBWSxHQUFHLEdBQUc7QUFDdEUsUUFBSSxJQUFJLGtCQUFrQixXQUFXO0FBQ25DLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxlQUFlLGVBQWUsSUFBSSxjQUFjLEdBQUcsR0FBRztBQUFBLElBQy9FO0FBQ0EsUUFBSSxJQUFDLDRDQUFxQixJQUFJLFlBQVksS0FBSyxJQUFJLGVBQWUsTUFBTTtBQUN0RSxhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sdUJBQXVCLGNBQWMsSUFBSSxhQUFhLEdBQUcsR0FBRztBQUFBLElBQ3JGO0FBQ0EsUUFBSSxJQUFJLHFCQUFxQixNQUFNO0FBQ2pDLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyx3QkFBd0IsUUFBUSxtQ0FBbUMsR0FBRyxHQUFHO0FBQUEsSUFDbEc7QUFDQSxVQUFNLFdBQVcsU0FBTTtBQUFBLE1BQ3JCLEVBQUUsSUFBSTtBQUFBLE1BQ047QUFBQSxRQUNFLHNCQUFzQixJQUFJO0FBQUEsUUFDMUIsY0FBYyxJQUFJO0FBQUEsUUFDbEIsYUFBYSxJQUFJO0FBQUEsTUFDbkI7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLFVBQU0sT0FBTyxTQUFNLDBDQUFtQjtBQUFBLE1BQ3BDLFVBQU8scUNBQWMsRUFBRSxJQUFJLEdBQUc7QUFBQSxNQUM5QixPQUFPLElBQUk7QUFBQSxNQUNYLE1BQU0sSUFBSTtBQUFBLE1BQ1YsWUFBWSxJQUFJO0FBQUEsTUFDaEIsYUFBYSxJQUFJO0FBQUEsTUFDakIsZUFBZSxVQUFVLHVCQUF1QixVQUFVLHFCQUFxQjtBQUFBLElBQ2pGLENBQUM7QUFDRCxRQUFJLENBQUMsS0FBSyxJQUFJO0FBQ1osWUFBTSxhQUFVLHdDQUFpQixJQUFJO0FBQ3JDLGFBQU8sRUFBRSxLQUFLLFFBQVEsTUFBTSxRQUFRLE1BQU07QUFBQSxJQUM1QztBQUNBLFdBQU8sRUFBRSxLQUFLO0FBQUEsTUFDWjtBQUFBLE1BQ0EsY0FBYyxJQUFJO0FBQUEsTUFDbEIsYUFBYSxJQUFJO0FBQUEsTUFDakIsZUFBZSxLQUFLLGlCQUFpQjtBQUFBLE1BQ3JDLGlCQUFpQixLQUFLO0FBQUEsTUFDdEIsaUJBQWlCLFVBQVUsTUFBTTtBQUFBLE1BQ2pDLGVBQWUsS0FBSztBQUFBLE1BQ3BCLE9BQU8sS0FBSztBQUFBLE1BQ1osaUJBQWlCLEtBQUs7QUFBQSxJQUN4QixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBR0QsTUFBSSxLQUFLLCtCQUErQixPQUFPLE1BQU07QUFDbkQsVUFBTSxLQUFLLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEMsUUFBSSxjQUFjLFNBQVUsUUFBTztBQUNuQyxVQUFNLEtBQUssRUFBRSxJQUFJLE1BQU0sSUFBSTtBQUUzQixRQUFJLE9BQW1CLENBQUM7QUFDeEIsUUFBSTtBQUNGLFlBQU0sTUFBTSxNQUFNLEVBQUUsSUFBSSxLQUFLO0FBQzdCLFVBQUksSUFBSyxRQUFPLEtBQUssTUFBTSxHQUFHO0FBQUEsSUFDaEMsUUFBUTtBQUNOLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxlQUFlLEdBQUcsR0FBRztBQUFBLElBQzlDO0FBQ0EsUUFBSSxLQUFLLFVBQVUsU0FBUyxPQUFPLEtBQUssV0FBVyxZQUFZLEtBQUssT0FBTyxTQUFTLE1BQU87QUFDekYsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGlCQUFpQixPQUFPLFNBQVMsR0FBRyxHQUFHO0FBQUEsSUFDaEU7QUFFQSxVQUFNLFVBQVUsU0FBTSxzQ0FBZSxFQUFFLElBQUksSUFBSSxFQUFFO0FBQ2pELFFBQUksQ0FBQyxRQUFTLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxZQUFZLEdBQUcsR0FBRztBQUN2RCxRQUFJLFFBQVEsWUFBYSxRQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksTUFBTSxrQkFBa0IsS0FBSyxDQUFDO0FBRTNFLFVBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsYUFBTSwyQ0FBb0IsRUFBRSxJQUFJLElBQUksSUFBSSxlQUFlLEdBQUc7QUFDMUQsYUFBTSw2QkFBTSxFQUFFLElBQUksSUFBSSxLQUFLLHFCQUFxQjtBQUFBLE1BQzlDLFlBQVk7QUFBQSxNQUNaLHlCQUF5QixHQUFHO0FBQUEsTUFDNUIsUUFBUSxLQUFLLFFBQVEsS0FBSyxLQUFLO0FBQUEsSUFDakMsQ0FBQztBQUNELFdBQU8sRUFBRSxLQUFLLEVBQUUsSUFBSSxLQUFLLENBQUM7QUFBQSxFQUM1QixDQUFDO0FBSUQsTUFBSSxJQUFJLHlCQUF5QixPQUFPLE1BQU07QUFDNUMsVUFBTSxLQUFLLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEMsUUFBSSxjQUFjLFNBQVUsUUFBTztBQUNuQyxVQUFNLFNBQVMsU0FBTSx5Q0FBa0IsRUFBRSxJQUFJLEVBQUU7QUFDL0MsV0FBTyxFQUFFLEtBQUssRUFBRSxPQUFPLENBQUM7QUFBQSxFQUMxQixDQUFDO0FBTUQsTUFBSSxLQUFLLHlCQUF5QixPQUFPLE1BQU07QUFDN0MsVUFBTSxLQUFLLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEMsUUFBSSxjQUFjLFNBQVUsUUFBTztBQUNuQyxRQUFJO0FBQ0osUUFBSTtBQUNGLGFBQVEsTUFBTSxFQUFFLElBQUksS0FBSztBQUFBLElBQzNCLFFBQVE7QUFDTixhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sZUFBZSxHQUFHLEdBQUc7QUFBQSxJQUM5QztBQUNBLFFBQUksT0FBTyxLQUFLLFdBQVcsWUFBWSxDQUFDLEtBQUssVUFBVSxLQUFLLE9BQU8sU0FBUyxLQUFLO0FBQy9FLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxpQkFBaUIsT0FBTyxTQUFTLEdBQUcsR0FBRztBQUFBLElBQ2hFO0FBQ0EsUUFBSSxLQUFLLFVBQVUsU0FBUyxPQUFPLEtBQUssV0FBVyxZQUFZLEtBQUssT0FBTyxTQUFTLE1BQU87QUFDekYsYUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGlCQUFpQixPQUFPLFNBQVMsR0FBRyxHQUFHO0FBQUEsSUFDaEU7QUFDQSxVQUFNLE1BQU0sS0FBSyxJQUFJO0FBQ3JCLGFBQU0sMENBQW1CLEVBQUUsSUFBSSxJQUFJLEtBQUssUUFBUSxLQUFLLFFBQVEsS0FBSyxLQUFLLGVBQWUsR0FBRyxJQUFJLEdBQUc7QUFDaEcsYUFBTSw2QkFBTSxFQUFFLElBQUksSUFBSSxLQUFLLDJCQUEyQjtBQUFBLE1BQ3BELFFBQVEsS0FBSztBQUFBLE1BQ2IseUJBQXlCLEdBQUc7QUFBQSxNQUM1QixRQUFRLEtBQUssUUFBUSxLQUFLLEtBQUs7QUFBQSxJQUNqQyxDQUFDO0FBQ0QsV0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLEVBQzVCLENBQUM7QUFHRCxNQUFJLEtBQUssZ0NBQWdDLE9BQU8sTUFBTTtBQUNwRCxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFFBQUk7QUFDSixRQUFJO0FBQ0YsYUFBUSxNQUFNLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDM0IsUUFBUTtBQUNOLGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxlQUFlLEdBQUcsR0FBRztBQUFBLElBQzlDO0FBQ0EsUUFBSSxPQUFPLEtBQUssV0FBVyxZQUFZLENBQUMsS0FBSyxRQUFRO0FBQ25ELGFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxpQkFBaUIsT0FBTyxTQUFTLEdBQUcsR0FBRztBQUFBLElBQ2hFO0FBQ0EsVUFBTSxNQUFNLEtBQUssSUFBSTtBQUNyQixhQUFNLDRDQUFxQixFQUFFLElBQUksSUFBSSxLQUFLLE1BQU07QUFDaEQsYUFBTSw2QkFBTSxFQUFFLElBQUksSUFBSSxLQUFLLDZCQUE2QjtBQUFBLE1BQ3RELFFBQVEsS0FBSztBQUFBLE1BQ2IseUJBQXlCLEdBQUc7QUFBQSxJQUM5QixDQUFDO0FBQ0QsV0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLEVBQzVCLENBQUM7QUFXRCxNQUFJLElBQUksdUJBQXVCLE9BQU8sTUFBTTtBQUMxQyxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sVUFBVSxDQUFDO0FBQ2pCLGVBQVcsWUFBWSx3Q0FBbUIsU0FBUSxLQUFLLFNBQU0sMENBQW1CLEVBQUUsSUFBSSxJQUFJLFFBQVEsQ0FBQztBQUNuRyxXQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksUUFBUSxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQUUsR0FBRyxRQUFRLENBQUM7QUFBQSxFQUMzRCxDQUFDO0FBRUQsTUFBSSxJQUFJLHNDQUFzQyxPQUFPLE1BQU07QUFDekQsVUFBTSxLQUFLLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEMsUUFBSSxjQUFjLFNBQVUsUUFBTztBQUNuQyxVQUFNLFdBQVcsRUFBRSxJQUFJLE1BQU0sUUFBUTtBQUNyQyxRQUFJLElBQUMsd0NBQWlCLFFBQVEsRUFBRyxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sa0JBQWtCLFNBQVMsd0NBQWtCLEdBQUcsR0FBRztBQUMzRyxVQUFNLGVBQWUsa0JBQWtCLElBQUksSUFBSSxFQUFFLElBQUksR0FBRyxDQUFDO0FBQ3pELFFBQUksaUJBQWlCLFVBQVcsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGlCQUFpQixPQUFPLG1CQUFtQixHQUFHLEdBQUc7QUFDeEcsVUFBTSxTQUFTLFNBQU0sMENBQW1CLEVBQUUsSUFBSSxJQUFJLFVBQVUsRUFBRSxhQUFhLENBQUM7QUFDNUUsV0FBTyxFQUFFLEtBQUssTUFBTTtBQUFBLEVBQ3RCLENBQUM7QUFFRCxNQUFJLElBQUksc0NBQXNDLE9BQU8sTUFBTTtBQUN6RCxVQUFNLEtBQUssTUFBTSxnQkFBZ0IsQ0FBQztBQUNsQyxRQUFJLGNBQWMsU0FBVSxRQUFPO0FBQ25DLFVBQU0sV0FBVyxFQUFFLElBQUksTUFBTSxRQUFRO0FBQ3JDLFFBQUksSUFBQyx3Q0FBaUIsUUFBUSxFQUFHLFFBQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxrQkFBa0IsU0FBUyx3Q0FBa0IsR0FBRyxHQUFHO0FBQzNHLFVBQU0sT0FBTyxTQUFNLDBDQUFtQixFQUFFLElBQUksSUFBSSxRQUFRO0FBQ3hELFdBQU8sSUFBSSxTQUFTLE1BQU07QUFBQSxNQUN4QixRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsUUFDUCxnQkFBZ0I7QUFBQSxRQUNoQix1QkFBdUIseUJBQXlCLFFBQVE7QUFBQSxNQUMxRDtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELE1BQUksS0FBSyx1Q0FBdUMsT0FBTyxNQUFNO0FBQzNELFVBQU0sS0FBSyxNQUFNLGdCQUFnQixDQUFDO0FBQ2xDLFFBQUksY0FBYyxTQUFVLFFBQU87QUFDbkMsVUFBTSxXQUFXLEVBQUUsSUFBSSxNQUFNLFFBQVE7QUFDckMsUUFBSSxJQUFDLHdDQUFpQixRQUFRLEVBQUcsUUFBTyxFQUFFLEtBQUssRUFBRSxPQUFPLGtCQUFrQixTQUFTLHdDQUFrQixHQUFHLEdBQUc7QUFDM0csVUFBTSxNQUFNLEtBQUssSUFBSTtBQUNyQixVQUFNLFNBQVMsU0FBTSwyQ0FBb0IsRUFBRSxJQUFJLElBQUksVUFBVSxHQUFHO0FBQ2hFLGFBQU0sNkJBQU0sRUFBRSxJQUFJLElBQUksS0FBSywwQkFBMEI7QUFBQSxNQUNuRCxXQUFXO0FBQUEsTUFDWCxVQUFVLE9BQU87QUFBQSxNQUNqQix5QkFBeUIsR0FBRztBQUFBLElBQzlCLENBQUM7QUFDRCxXQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksTUFBTSxHQUFHLE9BQU8sQ0FBQztBQUFBLEVBQ3ZDLENBQUM7QUFFRCxTQUFPO0FBQ1QiLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOltdLCJzb3VyY2VzIjpbImFkbWluLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogL2FkbWluLyog4oCUIEN1cGJvYXJkIG9wZXJhdG9yIG1vZGVyYXRpb24gc3VyZmFjZSAoUC0wNTFhLTMgKyBELTAyMyBcIm1vZGVyYXRpb24gdjFcIikuXG4gKlxuICogVGhlIHB1YmxpYyBzdXJmYWNlIGxldHMgYW55b25lIEZJTEUgYSByZXBvcnQgKGBQT1NUIC9yZXBvcnRzYCksIGJ1dCB1bnRpbFxuICogbm93IG5vdGhpbmcgY291bGQgcmV2aWV3IG9yIGFjdCBvbiB0aGVtIOKAlCByZXBvcnRzIGxhbmRlZCBpbiBEMSBhbmQgc2F0IHRoZXJlLlxuICogVGhpcyBjbG9zZXMgdGhhdCBsb29wOlxuICpcbiAqICAgR0VUICAvYWRtaW4vcmVwb3J0c1s/c3RhdHVzPXBlbmRpbmd8cmVzb2x2ZWRfdW5saXN0fHJlc29sdmVkX2Rpc21pc3N8YWxsXVxuICogICAgICAgIOKAlCBsaXN0IHJlcG9ydHMgKGpvaW5lZCB3aXRoIHRoZSByZXBvcnRlZCBoYXJuZXNzKSwgbmV3ZXN0LXBlbmRpbmctZmlyc3QuXG4gKiAgIFBPU1QgL2FkbWluL3JlcG9ydHMvOmlkL3Jlc29sdmUgICB7IGFjdGlvbjogJ3VubGlzdCcgfCAnZGlzbWlzcycsIG5vdGU/IH1cbiAqICAgICAgICDigJQgcmVzb2x2ZSBhIHBlbmRpbmcgcmVwb3J0LiAndW5saXN0JyBhbHNvIHRha2VzIHRoZSBoYXJuZXNzIGRvd25cbiAqICAgICAgICAgICh1bmxpc3RlZF9yZWFzb24gPSB0aGUgcmVwb3J0IGlkLCBmb3IgdHJhY2VhYmlsaXR5KS5cbiAqICAgUE9TVCAvYWRtaW4vaGFybmVzc2VzLzppZC91bmxpc3QgIHsgcmVhc29uPyB9XG4gKiAgICAgICAg4oCUIHByb2FjdGl2ZSBvcGVyYXRvciB0YWtlZG93biwgaW5kZXBlbmRlbnQgb2YgYW55IHJlcG9ydC5cbiAqXG4gKiBBdXRoOiBhIG5vcm1hbCBHaXRIdWIgYmVhcmVyICh2YWxpZGF0ZWQgdmlhIGByZXNvbHZlR2l0aHViQmVhcmVyYCkgd2hvc2VcbiAqIHJlc29sdmVkIHVzZXIgaWQgaXMgaW4gdGhlIGBDVVBCT0FSRF9PUEVSQVRPUl9HSVRIVUJfSURTYCBhbGxvd2xpc3QuIEVtcHR5XG4gKiBhbGxvd2xpc3Qg4oeSIG5vIG9wZXJhdG9ycyDih5IgZXZlcnkgZW5kcG9pbnQgNDAzcy4gRXZlcnkgYWN0aW9uIHdyaXRlcyBhbiBhdWRpdFxuICogcm93IGF0dHJpYnV0ZWQgdG8gdGhlIG9wZXJhdG9yJ3MgR2l0SHViIGlkLlxuICovXG5cbmltcG9ydCB7IEhvbm8gfSBmcm9tICdob25vJztcbmltcG9ydCB0eXBlIHsgQ29udGV4dCB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuLi9lbnYudHMnO1xuaW1wb3J0IHsgQXV0aEVycm9yLCBleHRyYWN0QmVhcmVyLCBpc0N1cGJvYXJkT3BlcmF0b3IsIHJlc29sdmVHaXRodWJCZWFyZXIgfSBmcm9tICcuLi9hdXRoLnRzJztcbmltcG9ydCB7XG4gIENPTU1JVF9TSEFfUkUsXG4gIGRpZmZMaXN0aW5nQ29udGVudCxcbiAgaXNTZWxmRGVzY3JpYmluZ0tpbmQsXG4gIHBpbkxpc3RpbmdDb250ZW50LFxuICBwaW5SZWZ1c2FsVG9IdHRwLFxufSBmcm9tICcuLi9jb250ZW50LXBpbi50cyc7XG5pbXBvcnQge1xuICBhcHByb3ZlTGlzdGluZ1ZlcnNpb24sXG4gIGF1ZGl0LFxuICBiYW5QdWJsaXNoZXJQdWJrZXksXG4gIGdldEFjdGl2ZUxpc3RpbmdCeVJlZnMsXG4gIGdldEhhcm5lc3NCeUlkLFxuICBnZXRQcmV2aW91c2x5QXBwcm92ZWRWZXJzaW9uLFxuICBsaXN0VmVyc2lvbnNTdXBlcnNlZGVkQnlBcHByb3ZhbCxcbiAgZ2V0UmVwb3J0QnlJZCxcbiAgbGlzdEJhbm5lZFB1YmtleXMsXG4gIGxpc3RQZW5kaW5nUmV2aWV3LFxuICBsaXN0UmVwb3J0cyxcbiAgbWFya0hhcm5lc3NVbmxpc3RlZCxcbiAgcmVzb2x2ZVJlcG9ydCxcbiAgc2V0UmV2aWV3U3RhdHVzLFxuICB1bmJhblB1Ymxpc2hlclB1YmtleSxcbn0gZnJvbSAnLi4vZGIudHMnO1xuaW1wb3J0IHtcbiAgTEVER0VSX1NUUkVBTV9JRFMsXG4gIGV4cG9ydExlZGdlclN0cmVhbSxcbiAgaXNMZWRnZXJTdHJlYW1JZCxcbiAgdmVyaWZ5TGVkZ2VyU3RyZWFtLFxuICB3aXRuZXNzTGVkZ2VyU3RyZWFtLFxufSBmcm9tICcuLi9sZWRnZXItY2hhaW4tc3RvcmUudHMnO1xuXG5jb25zdCBIRVg2NCA9IC9eWzAtOWEtZl17NjR9JC87XG5cbi8qKiBQYXJzZSB0aGUgb3B0aW9uYWwgYD9oZWFkU2VxPSZoZWFkSGFzaD1gIHBpbiBhIHZlcmlmaWVyIHNhdmVkIGZyb20gYW4gZWFybGllciBleHBvcnQuICovXG5mdW5jdGlvbiBwYXJzZUV4cGVjdGVkSGVhZCh1cmw6IFVSTCk6IHsgc2VxOiBudW1iZXI7IGVudHJ5SGFzaDogc3RyaW5nIH0gfCBudWxsIHwgJ2ludmFsaWQnIHtcbiAgY29uc3Qgc2VxUmF3ID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2hlYWRTZXEnKTtcbiAgY29uc3QgaGFzaCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdoZWFkSGFzaCcpO1xuICBpZiAoc2VxUmF3ID09IG51bGwgJiYgaGFzaCA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc2VxID0gTnVtYmVyKHNlcVJhdyk7XG4gIGlmIChzZXFSYXcgPT0gbnVsbCB8fCBoYXNoID09IG51bGwgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHNlcSkgfHwgc2VxIDwgMCB8fCAhSEVYNjQudGVzdChoYXNoKSkgcmV0dXJuICdpbnZhbGlkJztcbiAgcmV0dXJuIHsgc2VxLCBlbnRyeUhhc2g6IGhhc2ggfTtcbn1cblxuaW50ZXJmYWNlIFJlc29sdmVCb2R5IHtcbiAgYWN0aW9uOiAndW5saXN0JyB8ICdkaXNtaXNzJztcbiAgbm90ZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFVubGlzdEJvZHkge1xuICByZWFzb24/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgY2FsbGVyIHRvIGFuIG9wZXJhdG9yLCBvciByZXR1cm4gYSBSZXNwb25zZSB0byBzaG9ydC1jaXJjdWl0XG4gKiB3aXRoICg0MDEgdW5hdXRoZW50aWNhdGVkIC8gNDAzIG5vdC1hbi1vcGVyYXRvcikuIE9uIHN1Y2Nlc3MgcmV0dXJucyB0aGVcbiAqIG9wZXJhdG9yJ3MgR2l0SHViIGlkZW50aXR5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVxdWlyZU9wZXJhdG9yKFxuICBjOiBDb250ZXh0PHsgQmluZGluZ3M6IEVudiB9Pixcbik6IFByb21pc2U8eyBpZDogbnVtYmVyOyBsb2dpbjogc3RyaW5nIH0gfCBSZXNwb25zZT4ge1xuICBsZXQgdXNlcjogeyBpZDogbnVtYmVyOyBsb2dpbjogc3RyaW5nIH07XG4gIHRyeSB7XG4gICAgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgQXV0aEVycm9yKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhdXRoJywgcmVhc29uOiBlLnJlYXNvbiB9LCA0MDEpO1xuICAgIHRocm93IGU7XG4gIH1cbiAgaWYgKCFpc0N1cGJvYXJkT3BlcmF0b3IodXNlci5pZCwgYy5lbnYpKSB7XG4gICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnZm9yYmlkZGVuJywgcmVhc29uOiAnbm90X2FuX29wZXJhdG9yJyB9LCA0MDMpO1xuICB9XG4gIHJldHVybiB1c2VyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRtaW5Sb3V0ZSgpOiBIb25vPHsgQmluZGluZ3M6IEVudiB9PiB7XG4gIGNvbnN0IGFwcCA9IG5ldyBIb25vPHsgQmluZGluZ3M6IEVudiB9PigpO1xuXG4gIC8vIEdFVCAvYWRtaW4vcmVwb3J0cyDigJQgbGlzdCByZXBvcnRzIGZvciBtb2RlcmF0aW9uLlxuICBhcHAuZ2V0KCcvYWRtaW4vcmVwb3J0cycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCByYXcgPSBuZXcgVVJMKGMucmVxLnVybCkuc2VhcmNoUGFyYW1zLmdldCgnc3RhdHVzJykgPz8gJ3BlbmRpbmcnO1xuICAgIGNvbnN0IHN0YXR1cyA9XG4gICAgICByYXcgPT09ICdwZW5kaW5nJyB8fCByYXcgPT09ICdyZXNvbHZlZF91bmxpc3QnIHx8IHJhdyA9PT0gJ3Jlc29sdmVkX2Rpc21pc3MnIHx8IHJhdyA9PT0gJ2FsbCdcbiAgICAgICAgPyByYXdcbiAgICAgICAgOiAncGVuZGluZyc7XG4gICAgY29uc3QgcmVwb3J0cyA9IGF3YWl0IGxpc3RSZXBvcnRzKGMuZW52LkRCLCB7IHN0YXR1cyB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgcmVwb3J0cywgc3RhdHVzIH0pO1xuICB9KTtcblxuICAvLyBQT1NUIC9hZG1pbi9yZXBvcnRzLzppZC9yZXNvbHZlIOKAlCByZXNvbHZlIGEgcGVuZGluZyByZXBvcnQuXG4gIGFwcC5wb3N0KCcvYWRtaW4vcmVwb3J0cy86aWQvcmVzb2x2ZScsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuXG4gICAgbGV0IGJvZHk6IFJlc29sdmVCb2R5O1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gKGF3YWl0IGMucmVxLmpzb24oKSkgYXMgUmVzb2x2ZUJvZHk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2pzb24nIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmIChib2R5LmFjdGlvbiAhPT0gJ3VubGlzdCcgJiYgYm9keS5hY3Rpb24gIT09ICdkaXNtaXNzJykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnYWN0aW9uJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5ub3RlICE9IG51bGwgJiYgKHR5cGVvZiBib2R5Lm5vdGUgIT09ICdzdHJpbmcnIHx8IGJvZHkubm90ZS5sZW5ndGggPiAxMDAwKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnbm90ZScgfSwgNDAwKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXBvcnQgPSBhd2FpdCBnZXRSZXBvcnRCeUlkKGMuZW52LkRCLCBpZCk7XG4gICAgaWYgKCFyZXBvcnQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICBpZiAocmVwb3J0LnN0YXR1cyAhPT0gJ3BlbmRpbmcnKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhbHJlYWR5X3Jlc29sdmVkJywgc3RhdHVzOiByZXBvcnQuc3RhdHVzIH0sIDQwOSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCByZXNvbHZlZFN0YXR1cyA9IGJvZHkuYWN0aW9uID09PSAndW5saXN0JyA/ICdyZXNvbHZlZF91bmxpc3QnIDogJ3Jlc29sdmVkX2Rpc21pc3MnO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBhd2FpdCByZXNvbHZlUmVwb3J0KGMuZW52LkRCLCBpZCwge1xuICAgICAgc3RhdHVzOiByZXNvbHZlZFN0YXR1cyxcbiAgICAgIG5vdGU6IGJvZHkubm90ZT8udHJpbSgpIHx8IG51bGwsXG4gICAgICBub3dfbXM6IG5vdyxcbiAgICB9KTtcbiAgICAvLyBBIGNvbmN1cnJlbnQgcmVzb2x2ZSB3b24gdGhlIHJhY2UgKHN0YXR1cyBmbGlwcGVkIGJldHdlZW4gb3VyIHJlYWQgYW5kXG4gICAgLy8gdGhlIGd1YXJkZWQgVVBEQVRFKSDigJQgdHJlYXQgYXMgYWxyZWFkeS1yZXNvbHZlZCByYXRoZXIgdGhhbiBkb3VibGUtYWN0aW5nLlxuICAgIGlmIChjaGFuZ2VzID09PSAwKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdhbHJlYWR5X3Jlc29sdmVkJyB9LCA0MDkpO1xuXG4gICAgbGV0IGhhcm5lc3NfdW5saXN0ZWQgPSBmYWxzZTtcbiAgICBpZiAoYm9keS5hY3Rpb24gPT09ICd1bmxpc3QnKSB7XG4gICAgICBjb25zdCBoYXJuZXNzID0gYXdhaXQgZ2V0SGFybmVzc0J5SWQoYy5lbnYuREIsIHJlcG9ydC5oYXJuZXNzX2lkKTtcbiAgICAgIGlmIChoYXJuZXNzICYmICFoYXJuZXNzLnVubGlzdGVkX2F0KSB7XG4gICAgICAgIGF3YWl0IG1hcmtIYXJuZXNzVW5saXN0ZWQoYy5lbnYuREIsIHJlcG9ydC5oYXJuZXNzX2lkLCBgcmVwb3J0OiR7aWR9YCwgbm93KTtcbiAgICAgICAgaGFybmVzc191bmxpc3RlZCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdyZXBvcnRfcmVzb2x2ZWQnLCB7XG4gICAgICByZXBvcnRfaWQ6IGlkLFxuICAgICAgaGFybmVzc19pZDogcmVwb3J0Lmhhcm5lc3NfaWQsXG4gICAgICBhY3Rpb246IGJvZHkuYWN0aW9uLFxuICAgICAgb3BlcmF0b3JfZ2l0aHViX3VzZXJfaWQ6IG9wLmlkLFxuICAgICAgaGFybmVzc191bmxpc3RlZCxcbiAgICB9KTtcbiAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIHN0YXR1czogcmVzb2x2ZWRTdGF0dXMsIGhhcm5lc3NfdW5saXN0ZWQgfSk7XG4gIH0pO1xuXG4gIC8vIEdFVCAvYWRtaW4vcGVuZGluZyDigJQgdGhlIHByZS1wdWJsaWNhdGlvbiByZXZpZXcgcXVldWVcbiAgLy8gKGxlYXJuaW5nLXBhY2tzLTIwMjYtMDYtMTEgUC0wMTkvUC0wMjAsIEQtMDA3KTogcG9saWN5LWtpbmQgbGlzdGluZ3NcbiAgLy8gKGtub3dsZWRnZS1wYWNrLCBibHVlcHJpbnQpIGF3YWl0aW5nIGFuIG9wZXJhdG9yIGRlY2lzaW9uLCBvbGRlc3QgZmlyc3QuXG4gIGFwcC5nZXQoJy9hZG1pbi9wZW5kaW5nJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgICBpZiAob3AgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBsaXN0UGVuZGluZ1JldmlldyhjLmVudi5EQik7XG4gICAgcmV0dXJuIGMuanNvbih7IHBlbmRpbmcgfSk7XG4gIH0pO1xuXG4gIC8vIFBPU1QgL2FkbWluL2xpc3RpbmdzLzppZC9yZXZpZXcg4oCUIGFwcHJvdmUgb3IgcmVqZWN0IGEgcGVuZGluZyBsaXN0aW5nLlxuICAvLyBUaGUgZGVjaXNpb24gKCsgcmVhc29uKSBsYW5kcyBvbiB0aGUgcm93OyB0aGUgc3VibWl0dGVyIHJlYWRzIGl0IGZyb21cbiAgLy8gdGhlaXIgb3duIEdFVCAvOmlkIHZpZXc7IGFwcHJvdmFsIG1ha2VzIHRoZSBsaXN0aW5nIHB1YmxpY2x5IHZpc2libGUuXG4gIGFwcC5wb3N0KCcvYWRtaW4vbGlzdGluZ3MvOmlkL3JldmlldycsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuXG4gICAgbGV0IGJvZHk6IHsgZGVjaXNpb24/OiBzdHJpbmc7IHJlYXNvbj86IHN0cmluZzsgcmV2aWV3ZWRfY29tbWl0X3NoYT86IHN0cmluZyB9ID0ge307XG4gICAgdHJ5IHtcbiAgICAgIGJvZHkgPSAoYXdhaXQgYy5yZXEuanNvbigpKSBhcyB0eXBlb2YgYm9keTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfanNvbicgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKGJvZHkuZGVjaXNpb24gIT09ICdhcHByb3ZlJyAmJiBib2R5LmRlY2lzaW9uICE9PSAncmVqZWN0Jykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAnZGVjaXNpb24nIH0sIDQwMCk7XG4gICAgfVxuICAgIGlmIChib2R5LnJlYXNvbiAhPSBudWxsICYmICh0eXBlb2YgYm9keS5yZWFzb24gIT09ICdzdHJpbmcnIHx8IGJvZHkucmVhc29uLmxlbmd0aCA+IDEwMDApKSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdyZWFzb24nIH0sIDQwMCk7XG4gICAgfVxuICAgIC8vIFAtMDA4OiB0aGUgY29tbWl0IHRoZSBvcGVyYXRvciBhY3R1YWxseSByZXZpZXdlZC4gQWJzZW50IOKHkiB0aGUgcm93J3Mgb3duXG4gICAgLy8gcGluICh3aGF0IHRoZSByZXZpZXctZGlmZiBzaG93ZWQpLiBQcmVzZW50IGFuZCBkaWZmZXJlbnQg4oeSIHRoZSByb3cgaGFkXG4gICAgLy8gRFJJRlRFRCBhbmQgaXMgcmUtcGlubmVkIHRvIHRoaXMgU0hBIGJlZm9yZSBpdCBpcyBhcHByb3ZlZC5cbiAgICBpZiAoXG4gICAgICBib2R5LnJldmlld2VkX2NvbW1pdF9zaGEgIT0gbnVsbCAmJlxuICAgICAgKHR5cGVvZiBib2R5LnJldmlld2VkX2NvbW1pdF9zaGEgIT09ICdzdHJpbmcnIHx8ICFDT01NSVRfU0hBX1JFLnRlc3QoYm9keS5yZXZpZXdlZF9jb21taXRfc2hhKSlcbiAgICApIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ3Jldmlld2VkX2NvbW1pdF9zaGEnIH0sIDQwMCk7XG4gICAgfVxuXG4gICAgY29uc3Qgcm93ID0gYXdhaXQgZ2V0SGFybmVzc0J5SWQoYy5lbnYuREIsIGlkKTtcbiAgICBpZiAoIXJvdyB8fCByb3cudW5saXN0ZWRfYXQpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9mb3VuZCcgfSwgNDA0KTtcbiAgICBpZiAocm93LnJldmlld19zdGF0dXMgIT09ICdwZW5kaW5nJykge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X3BlbmRpbmcnLCByZXZpZXdfc3RhdHVzOiByb3cucmV2aWV3X3N0YXR1cyB9LCA0MDkpO1xuICAgIH1cbiAgICAvLyBQLTAwMS9ELTAwNTogYSBzZWxmLWRlc2NyaWJpbmcgbGlzdGluZyBtdXN0IGhhdmUgYW4gaW1tdXRhYmxlIGNvbnRlbnRcbiAgICAvLyBwaW4gYmVmb3JlIG1vZGVyYXRpb24gY2FuIG1ha2UgaXQgcHVibGljLiAgUm93cyBjcmVhdGVkIGJlZm9yZSBtaWdyYXRpb25cbiAgICAvLyAwMjggbGVnaXRpbWF0ZWx5IGhhdmUgTlVMTCBwaW5zLCBidXQgYXBwcm92aW5nIG9uZSB3b3VsZCBieXBhc3MgdGhlXG4gICAgLy8gdHJ1c3QgZ2F0ZTsgdGhlIHB1Ymxpc2hlciBtdXN0IHJlLXB1Ymxpc2ggaXQgc28gdGhlIFdvcmtlciBjYW4gcGluIHRoZVxuICAgIC8vIGV4YWN0IGJ5dGVzIHRoYXQgbW9kZXJhdGlvbiB3aWxsIGV4cG9zZS5cbiAgICBpZiAoXG4gICAgICBib2R5LmRlY2lzaW9uID09PSAnYXBwcm92ZScgJiZcbiAgICAgIGlzU2VsZkRlc2NyaWJpbmdLaW5kKHJvdy5saXN0aW5nX2tpbmQpICYmXG4gICAgICAocm93LnBpbm5lZF9jb21taXRfc2hhID09IG51bGwgfHwgcm93LnBpbm5lZF90cmVlX2RpZ2VzdCA9PSBudWxsKVxuICAgICkge1xuICAgICAgcmV0dXJuIGMuanNvbih7XG4gICAgICAgIGVycm9yOiAnY29udGVudF9waW5fcmVxdWlyZWQnLFxuICAgICAgICBsaXN0aW5nX2tpbmQ6IHJvdy5saXN0aW5nX2tpbmQsXG4gICAgICAgIHJlYXNvbjogJ3JlcHVibGlzaF9yZXF1aXJlZF9iZWZvcmVfYXBwcm92YWwnLFxuICAgICAgfSwgNDA5KTtcbiAgICB9XG5cbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHJlYXNvbiA9IGJvZHkucmVhc29uPy50cmltKCkgfHwgbnVsbDtcbiAgICBpZiAoYm9keS5kZWNpc2lvbiA9PT0gJ3JlamVjdCcpIHtcbiAgICAgIGF3YWl0IHNldFJldmlld1N0YXR1cyhjLmVudi5EQiwgaWQsICdyZWplY3RlZCcsIHJlYXNvbiwgbm93KTtcbiAgICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdyZXZpZXdfZGVjaWRlZCcsIHtcbiAgICAgICAgaWQsXG4gICAgICAgIGxpc3Rpbmdfa2luZDogcm93Lmxpc3Rpbmdfa2luZCxcbiAgICAgICAgZGVjaXNpb246ICdyZWplY3RlZCcsXG4gICAgICAgIG9wZXJhdG9yX2dpdGh1Yl91c2VyX2lkOiBvcC5pZCxcbiAgICAgICAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkOiByb3cucHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGlkLCByZXZpZXdfc3RhdHVzOiAncmVqZWN0ZWQnIH0pO1xuICAgIH1cblxuICAgIC8vIEFwcHJvdmUgKFAtMDA4KTogcmVjb3JkIFdISUNIIGNvbW1pdCB3YXMgcmV2aWV3ZWQsIHJlLXBpbiBhIGRyaWZ0ZWQgcm93IHRvXG4gICAgLy8gaXQsIGFuZCBtYWtlIHRoaXMgdGhlIHNpbmdsZSBzZXJ2ZWQgdmVyc2lvbiBvZiBpdHMgaWRlbnRpdHkuXG4gICAgbGV0IGFwcHJvdmVkOiB7IGNvbW1pdFNoYTogc3RyaW5nOyB0cmVlRGlnZXN0OiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuICAgIGxldCByZXBpbm5lZCA9IGZhbHNlO1xuICAgIGxldCByZXBpbkF1dGhvcml0eTogeyB1bnJlc29sdmVkOiBib29sZWFuOyBjYXVzZTogc3RyaW5nIHwgbnVsbCB9IHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGlzU2VsZkRlc2NyaWJpbmdLaW5kKHJvdy5saXN0aW5nX2tpbmQpKSB7XG4gICAgICAvLyBOb24tbnVsbDogdGhlIGNvbnRlbnRfcGluX3JlcXVpcmVkIGd1YXJkIGFib3ZlIHJlZnVzZWQgYSBOVUxMIHBpbi5cbiAgICAgIGFwcHJvdmVkID0geyBjb21taXRTaGE6IHJvdy5waW5uZWRfY29tbWl0X3NoYSBhcyBzdHJpbmcsIHRyZWVEaWdlc3Q6IHJvdy5waW5uZWRfdHJlZV9kaWdlc3QgYXMgc3RyaW5nIH07XG4gICAgICBjb25zdCByZXZpZXdlZCA9IGJvZHkucmV2aWV3ZWRfY29tbWl0X3NoYTtcbiAgICAgIGlmIChyZXZpZXdlZCAhPSBudWxsICYmIHJldmlld2VkICE9PSByb3cucGlubmVkX2NvbW1pdF9zaGEpIHtcbiAgICAgICAgLy8gVGhlIHJldmlld2VyIHJlYWQgYSBkaWZmZXJlbnQgY29tbWl0IHRoYW4gdGhlIHJvdydzIHBpbjogcmUtZmV0Y2ggK1xuICAgICAgICAvLyByZS1zY2FuIGA8cmVmPi9gIEFUIFRIQVQgU0hBIChuZXZlciB0aGUgZGVmYXVsdC1icmFuY2ggaGVhZCDigJQgdGhlIHBvaW50XG4gICAgICAgIC8vIGlzIHRvIHNlcnZlIGV4YWN0bHkgd2hhdCB3YXMgcmV2aWV3ZWQpLCB0aGVuIHBpbiBpdC5cbiAgICAgICAgY29uc3QgY2xhc2ggPSBhd2FpdCBnZXRBY3RpdmVMaXN0aW5nQnlSZWZzKFxuICAgICAgICAgIGMuZW52LkRCLFxuICAgICAgICAgIHJvdy5naXRodWJfcmVwb3NpdG9yeV9pZCxcbiAgICAgICAgICByb3cubGlzdGluZ19raW5kLFxuICAgICAgICAgIHJvdy5saXN0aW5nX3JlZiBhcyBzdHJpbmcsXG4gICAgICAgICAgcmV2aWV3ZWQsXG4gICAgICAgICk7XG4gICAgICAgIGlmIChjbGFzaCAmJiBjbGFzaC5pZCAhPT0gaWQpIHtcbiAgICAgICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd2ZXJzaW9uX2V4aXN0cycsIGV4aXN0aW5nX2lkOiBjbGFzaC5pZCwgY29tbWl0X3NoYTogcmV2aWV3ZWQgfSwgNDA5KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXBpbiA9IGF3YWl0IHBpbkxpc3RpbmdDb250ZW50KHtcbiAgICAgICAgICB0b2tlbjogZXh0cmFjdEJlYXJlcihjLnJlcS5yYXcpLFxuICAgICAgICAgIG93bmVyOiByb3cuZ2l0aHViX293bmVyLFxuICAgICAgICAgIG5hbWU6IHJvdy5naXRodWJfbmFtZSxcbiAgICAgICAgICBkZWZhdWx0QnJhbmNoOiAnJyxcbiAgICAgICAgICBsaXN0aW5nUmVmOiByb3cubGlzdGluZ19yZWYgYXMgc3RyaW5nLFxuICAgICAgICAgIGNvbW1pdFNoYTogcmV2aWV3ZWQsXG4gICAgICAgICAga2luZDogcm93Lmxpc3Rpbmdfa2luZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVwaW4ub2spIHtcbiAgICAgICAgICBjb25zdCByZWZ1c2FsID0gcGluUmVmdXNhbFRvSHR0cChyZXBpbik7XG4gICAgICAgICAgcmV0dXJuIGMuanNvbihyZWZ1c2FsLmJvZHksIHJlZnVzYWwuc3RhdHVzKTtcbiAgICAgICAgfVxuICAgICAgICBhcHByb3ZlZCA9IHsgY29tbWl0U2hhOiByZXBpbi5jb21taXRTaGEsIHRyZWVEaWdlc3Q6IHJlcGluLnRyZWVEaWdlc3QgfTtcbiAgICAgICAgLy8gUC0wMDc6IGEgcmUtcGluIHJlcGxhY2VzIHRoZSBwaW5uZWQgYnl0ZXMsIHNvIHRoZSBXb3JrZXIncyBhdXRob3JpdHkgdmVyZGljdCBtdXN0IGJlXG4gICAgICAgIC8vIHRoZSBvbmUgY29tcHV0ZWQgZnJvbSBUSE9TRSBieXRlcywgbm90IHRoZSBzdXBlcnNlZGVkIGNvbW1pdCdzLlxuICAgICAgICByZXBpbkF1dGhvcml0eSA9IHJlcGluLnJlY2lwZUF1dGhvcml0eSA/PyBudWxsO1xuICAgICAgICByZXBpbm5lZCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHN1cGVyc2VkZWQgPSBhcHByb3ZlZCA/IGF3YWl0IGxpc3RWZXJzaW9uc1N1cGVyc2VkZWRCeUFwcHJvdmFsKGMuZW52LkRCLCByb3cpIDogW107XG4gICAgYXdhaXQgYXBwcm92ZUxpc3RpbmdWZXJzaW9uKGMuZW52LkRCLCB7XG4gICAgICBpZCxcbiAgICAgIHJlYXNvbixcbiAgICAgIG5vdyxcbiAgICAgIGFwcHJvdmVkLFxuICAgICAgcmVwaW5uZWQsXG4gICAgICBhdXRob3JpdHk6IHJlcGluQXV0aG9yaXR5LFxuICAgICAgcmV0aXJlOiBhcHByb3ZlZCA/IHJvdyA6IG51bGwsXG4gICAgICAvLyBXSS0xMDAwNDY0MzogdGhlIGF1ZGl0IHJvdyByaWRlcyBpbiB0aGUgYXBwcm92YWwncyBvd24gYXRvbWljIGJhdGNoIChEMSBoYXMgbm9cbiAgICAgIC8vIHRyYW5zYWN0aW9uIGFjcm9zcyB0d28gY2FsbHMpLCBzbyBhIFdvcmtlciBmYWlsdXJlIGNhbid0IGxlYXZlIGFuIGFwcHJvdmFsIHVuYXVkaXRlZC5cbiAgICAgIGF1ZGl0OiB7XG4gICAgICAgIGtpbmQ6ICdyZXZpZXdfZGVjaWRlZCcsXG4gICAgICAgIGRldGFpbDoge1xuICAgICAgICAgIGlkLFxuICAgICAgICAgIGxpc3Rpbmdfa2luZDogcm93Lmxpc3Rpbmdfa2luZCxcbiAgICAgICAgICBkZWNpc2lvbjogJ2FwcHJvdmVkJyxcbiAgICAgICAgICBvcGVyYXRvcl9naXRodWJfdXNlcl9pZDogb3AuaWQsXG4gICAgICAgICAgcHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkOiByb3cucHVibGlzaGVyX2dpdGh1Yl91c2VyX2lkLFxuICAgICAgICAgIGFwcHJvdmVkX2NvbW1pdF9zaGE6IGFwcHJvdmVkPy5jb21taXRTaGEgPz8gbnVsbCxcbiAgICAgICAgICByZXBpbm5lZCxcbiAgICAgICAgICBmcm9tX3Bpbm5lZF9jb21taXRfc2hhOiByZXBpbm5lZCA/IHJvdy5waW5uZWRfY29tbWl0X3NoYSA6IG51bGwsXG4gICAgICAgICAgcmV0aXJlZF9pZHM6IHN1cGVyc2VkZWQubWFwKCh2KSA9PiB2LmlkKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGlkLFxuICAgICAgcmV2aWV3X3N0YXR1czogJ2FwcHJvdmVkJyxcbiAgICAgIGFwcHJvdmVkX2NvbW1pdF9zaGE6IGFwcHJvdmVkPy5jb21taXRTaGEgPz8gbnVsbCxcbiAgICAgIHJlcGlubmVkLFxuICAgICAgcmV0aXJlZF9pZHM6IHN1cGVyc2VkZWQubWFwKCh2KSA9PiB2LmlkKSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gR0VUIC9hZG1pbi9saXN0aW5ncy86aWQvcmV2aWV3LWRpZmYg4oCUIHdoYXQgYW4gYXBwcm92YWwgd291bGQgY2hhbmdlIChQLTAwOCkuXG4gIC8vIEZpbGUtbGV2ZWwgZGlmZiBvZiBgPGxpc3RpbmdfcmVmPi9gIGJldHdlZW4gdGhlIHByZXZpb3VzbHkgYXBwcm92ZWQgY29tbWl0IG9mXG4gIC8vIHRoaXMgKHJlcG8sIGtpbmQsIHJlZikgYW5kIHRoZSBwZW5kaW5nIHJvdydzIHBpbi4gQmxvYiBzaGFzIGFyZSBjb250ZW50XG4gIC8vIGFkZHJlc3Nlcywgc28gYWRkZWQgLyByZW1vdmVkIC8gbW9kaWZpZWQgaXMgZXhhY3Qgd2l0aG91dCBtb3ZpbmcgYW55IGJ5dGVzLlxuICAvLyBUaGUgZmlyc3QtZXZlciB2ZXJzaW9uIGRpZmZzIGFnYWluc3Qgbm90aGluZyAoZXZlcnkgZmlsZSBgYWRkZWRgKS5cbiAgYXBwLmdldCgnL2FkbWluL2xpc3RpbmdzLzppZC9yZXZpZXctZGlmZicsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuICAgIGNvbnN0IHJvdyA9IGF3YWl0IGdldEhhcm5lc3NCeUlkKGMuZW52LkRCLCBpZCk7XG4gICAgaWYgKCFyb3cgfHwgcm93LnVubGlzdGVkX2F0KSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdub3RfZm91bmQnIH0sIDQwNCk7XG4gICAgaWYgKHJvdy5yZXZpZXdfc3RhdHVzICE9PSAncGVuZGluZycpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ25vdF9wZW5kaW5nJywgcmV2aWV3X3N0YXR1czogcm93LnJldmlld19zdGF0dXMgfSwgNDA5KTtcbiAgICB9XG4gICAgaWYgKCFpc1NlbGZEZXNjcmliaW5nS2luZChyb3cubGlzdGluZ19raW5kKSB8fCByb3cubGlzdGluZ19yZWYgPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X3NlbGZfZGVzY3JpYmluZycsIGxpc3Rpbmdfa2luZDogcm93Lmxpc3Rpbmdfa2luZCB9LCA0MDkpO1xuICAgIH1cbiAgICBpZiAocm93LnBpbm5lZF9jb21taXRfc2hhID09IG51bGwpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2NvbnRlbnRfcGluX3JlcXVpcmVkJywgcmVhc29uOiAncmVwdWJsaXNoX3JlcXVpcmVkX2JlZm9yZV9yZXZpZXcnIH0sIDQwOSk7XG4gICAgfVxuICAgIGNvbnN0IHByZXZpb3VzID0gYXdhaXQgZ2V0UHJldmlvdXNseUFwcHJvdmVkVmVyc2lvbihcbiAgICAgIGMuZW52LkRCLFxuICAgICAge1xuICAgICAgICBnaXRodWJfcmVwb3NpdG9yeV9pZDogcm93LmdpdGh1Yl9yZXBvc2l0b3J5X2lkLFxuICAgICAgICBsaXN0aW5nX2tpbmQ6IHJvdy5saXN0aW5nX2tpbmQsXG4gICAgICAgIGxpc3RpbmdfcmVmOiByb3cubGlzdGluZ19yZWYsXG4gICAgICB9LFxuICAgICAgaWQsXG4gICAgKTtcbiAgICBjb25zdCBkaWZmID0gYXdhaXQgZGlmZkxpc3RpbmdDb250ZW50KHtcbiAgICAgIHRva2VuOiBleHRyYWN0QmVhcmVyKGMucmVxLnJhdyksXG4gICAgICBvd25lcjogcm93LmdpdGh1Yl9vd25lcixcbiAgICAgIG5hbWU6IHJvdy5naXRodWJfbmFtZSxcbiAgICAgIGxpc3RpbmdSZWY6IHJvdy5saXN0aW5nX3JlZixcbiAgICAgIHRvQ29tbWl0U2hhOiByb3cucGlubmVkX2NvbW1pdF9zaGEsXG4gICAgICBmcm9tQ29tbWl0U2hhOiBwcmV2aW91cz8uYXBwcm92ZWRfY29tbWl0X3NoYSA/PyBwcmV2aW91cz8ucGlubmVkX2NvbW1pdF9zaGEgPz8gbnVsbCxcbiAgICB9KTtcbiAgICBpZiAoIWRpZmYub2spIHtcbiAgICAgIGNvbnN0IHJlZnVzYWwgPSBwaW5SZWZ1c2FsVG9IdHRwKGRpZmYpO1xuICAgICAgcmV0dXJuIGMuanNvbihyZWZ1c2FsLmJvZHksIHJlZnVzYWwuc3RhdHVzKTtcbiAgICB9XG4gICAgcmV0dXJuIGMuanNvbih7XG4gICAgICBpZCxcbiAgICAgIGxpc3Rpbmdfa2luZDogcm93Lmxpc3Rpbmdfa2luZCxcbiAgICAgIGxpc3RpbmdfcmVmOiByb3cubGlzdGluZ19yZWYsXG4gICAgICBmaXJzdF92ZXJzaW9uOiBkaWZmLmZyb21Db21taXRTaGEgPT0gbnVsbCxcbiAgICAgIGZyb21fY29tbWl0X3NoYTogZGlmZi5mcm9tQ29tbWl0U2hhLFxuICAgICAgZnJvbV9saXN0aW5nX2lkOiBwcmV2aW91cz8uaWQgPz8gbnVsbCxcbiAgICAgIHRvX2NvbW1pdF9zaGE6IGRpZmYudG9Db21taXRTaGEsXG4gICAgICBmaWxlczogZGlmZi5maWxlcyxcbiAgICAgIHVuY2hhbmdlZF9jb3VudDogZGlmZi51bmNoYW5nZWRDb3VudCxcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gUE9TVCAvYWRtaW4vaGFybmVzc2VzLzppZC91bmxpc3Qg4oCUIHByb2FjdGl2ZSBvcGVyYXRvciB0YWtlZG93bi5cbiAgYXBwLnBvc3QoJy9hZG1pbi9oYXJuZXNzZXMvOmlkL3VubGlzdCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBpZCA9IGMucmVxLnBhcmFtKCdpZCcpO1xuXG4gICAgbGV0IGJvZHk6IFVubGlzdEJvZHkgPSB7fTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gYXdhaXQgYy5yZXEudGV4dCgpO1xuICAgICAgaWYgKHJhdykgYm9keSA9IEpTT04ucGFyc2UocmF3KSBhcyBVbmxpc3RCb2R5O1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9qc29uJyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5yZWFzb24gIT0gbnVsbCAmJiAodHlwZW9mIGJvZHkucmVhc29uICE9PSAnc3RyaW5nJyB8fCBib2R5LnJlYXNvbi5sZW5ndGggPiAxMDAwKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncmVhc29uJyB9LCA0MDApO1xuICAgIH1cblxuICAgIGNvbnN0IGhhcm5lc3MgPSBhd2FpdCBnZXRIYXJuZXNzQnlJZChjLmVudi5EQiwgaWQpO1xuICAgIGlmICghaGFybmVzcykgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnbm90X2ZvdW5kJyB9LCA0MDQpO1xuICAgIGlmIChoYXJuZXNzLnVubGlzdGVkX2F0KSByZXR1cm4gYy5qc29uKHsgb2s6IHRydWUsIGFscmVhZHlfdW5saXN0ZWQ6IHRydWUgfSk7XG5cbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGF3YWl0IG1hcmtIYXJuZXNzVW5saXN0ZWQoYy5lbnYuREIsIGlkLCAnYnlfb3BlcmF0b3InLCBub3cpO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdvcGVyYXRvcl91bmxpc3RlZCcsIHtcbiAgICAgIGhhcm5lc3NfaWQ6IGlkLFxuICAgICAgb3BlcmF0b3JfZ2l0aHViX3VzZXJfaWQ6IG9wLmlkLFxuICAgICAgcmVhc29uOiBib2R5LnJlYXNvbj8udHJpbSgpIHx8IG51bGwsXG4gICAgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlIH0pO1xuICB9KTtcblxuICAvLyBHRVQgL2FkbWluL2Jhbm5lZC1wdWJrZXlzIOKAlCBsaXN0IG9wZXJhdG9yLWJhbm5lZCBwdWJsaXNoZXIgZGV2aWNlIHB1YmtleXNcbiAgLy8gKGNoYW5uZWwtMiBiYW4tbGlzdCwgaXRlbSAxKS5cbiAgYXBwLmdldCgnL2FkbWluL2Jhbm5lZC1wdWJrZXlzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgICBpZiAob3AgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wO1xuICAgIGNvbnN0IGJhbm5lZCA9IGF3YWl0IGxpc3RCYW5uZWRQdWJrZXlzKGMuZW52LkRCKTtcbiAgICByZXR1cm4gYy5qc29uKHsgYmFubmVkIH0pO1xuICB9KTtcblxuICAvLyBQT1NUIC9hZG1pbi9iYW5uZWQtcHVia2V5cyB7IHB1YmtleSwgcmVhc29uIH0g4oCUIGJhbiBhIHB1Ymxpc2hlciBkZXZpY2VcbiAgLy8gcHVia2V5LiBJZGVtcG90ZW50IHVwc2VydC4gTGlzdGluZ3Mgd2l0aCB0aGlzIHB1YmtleSBhcmUgdGhlbiBmaWx0ZXJlZFxuICAvLyBmcm9tIHB1YmxpYyByZWFkcy4gKHB1YmtleSBpcyBpbiB0aGUgYm9keSwgbm90IHRoZSBwYXRoLCBiZWNhdXNlIGJhc2U2NFxuICAvLyBjb250YWlucyAnLycgYW5kICcrJy4pXG4gIGFwcC5wb3N0KCcvYWRtaW4vYmFubmVkLXB1YmtleXMnLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IG9wID0gYXdhaXQgcmVxdWlyZU9wZXJhdG9yKGMpO1xuICAgIGlmIChvcCBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3A7XG4gICAgbGV0IGJvZHk6IHsgcHVia2V5Pzogc3RyaW5nOyByZWFzb24/OiBzdHJpbmcgfTtcbiAgICB0cnkge1xuICAgICAgYm9keSA9IChhd2FpdCBjLnJlcS5qc29uKCkpIGFzIHsgcHVia2V5Pzogc3RyaW5nOyByZWFzb24/OiBzdHJpbmcgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfanNvbicgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LnB1YmtleSAhPT0gJ3N0cmluZycgfHwgIWJvZHkucHVia2V5IHx8IGJvZHkucHVia2V5Lmxlbmd0aCA+IDIwMCkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncHVia2V5JyB9LCA0MDApO1xuICAgIH1cbiAgICBpZiAoYm9keS5yZWFzb24gIT0gbnVsbCAmJiAodHlwZW9mIGJvZHkucmVhc29uICE9PSAnc3RyaW5nJyB8fCBib2R5LnJlYXNvbi5sZW5ndGggPiAxMDAwKSkge1xuICAgICAgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnaW52YWxpZF9maWVsZCcsIGZpZWxkOiAncmVhc29uJyB9LCA0MDApO1xuICAgIH1cbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGF3YWl0IGJhblB1Ymxpc2hlclB1YmtleShjLmVudi5EQiwgYm9keS5wdWJrZXksIGJvZHkucmVhc29uPy50cmltKCkgfHwgJ3Vuc3BlY2lmaWVkJywgb3AuaWQsIG5vdyk7XG4gICAgYXdhaXQgYXVkaXQoYy5lbnYuREIsIG5vdywgJ3B1Ymxpc2hlcl9wdWJrZXlfYmFubmVkJywge1xuICAgICAgcHVia2V5OiBib2R5LnB1YmtleSxcbiAgICAgIG9wZXJhdG9yX2dpdGh1Yl91c2VyX2lkOiBvcC5pZCxcbiAgICAgIHJlYXNvbjogYm9keS5yZWFzb24/LnRyaW0oKSB8fCBudWxsLFxuICAgIH0pO1xuICAgIHJldHVybiBjLmpzb24oeyBvazogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgLy8gUE9TVCAvYWRtaW4vYmFubmVkLXB1YmtleXMvcmVtb3ZlIHsgcHVia2V5IH0g4oCUIGxpZnQgYSBiYW4uXG4gIGFwcC5wb3N0KCcvYWRtaW4vYmFubmVkLXB1YmtleXMvcmVtb3ZlJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgICBpZiAob3AgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wO1xuICAgIGxldCBib2R5OiB7IHB1YmtleT86IHN0cmluZyB9O1xuICAgIHRyeSB7XG4gICAgICBib2R5ID0gKGF3YWl0IGMucmVxLmpzb24oKSkgYXMgeyBwdWJrZXk/OiBzdHJpbmcgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfanNvbicgfSwgNDAwKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBib2R5LnB1YmtleSAhPT0gJ3N0cmluZycgfHwgIWJvZHkucHVia2V5KSB7XG4gICAgICByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdwdWJrZXknIH0sIDQwMCk7XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgYXdhaXQgdW5iYW5QdWJsaXNoZXJQdWJrZXkoYy5lbnYuREIsIGJvZHkucHVia2V5KTtcbiAgICBhd2FpdCBhdWRpdChjLmVudi5EQiwgbm93LCAncHVibGlzaGVyX3B1YmtleV91bmJhbm5lZCcsIHtcbiAgICAgIHB1YmtleTogYm9keS5wdWJrZXksXG4gICAgICBvcGVyYXRvcl9naXRodWJfdXNlcl9pZDogb3AuaWQsXG4gICAgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlIH0pO1xuICB9KTtcblxuICAvLyDilIDilIAgSGFzaC1jaGFpbmVkIGxlZGdlcnMgKGFnZW50LWVjb25vbXktZmx5d2hlZWwgUC0wNDApIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvLyBHRVQgIC9hZG1pbi9sZWRnZXItY2hhaW4gICAgICAgICAgICAgICAgICAgICAgIOKAlCB2ZXJpZnkgZXZlcnkgc3RyZWFtLlxuICAvLyBHRVQgIC9hZG1pbi9sZWRnZXItY2hhaW4vOnN0cmVhbS92ZXJpZnkgICAgICAgIOKAlCByZWNvbXB1dGUgb25lIGNoYWluIGFuZFxuICAvLyAgICAgIHJlcG9ydCB0aGUgZmlyc3QgYnJlYWs7IGA/aGVhZFNlcT0maGVhZEhhc2g9YCBhZGRpdGlvbmFsbHkgY2hlY2tzIHRoZVxuICAvLyAgICAgIGNoYWluIHN0aWxsIGVuZHMgYXQgYSBoZWFkIHRoZSBjYWxsZXIgc2F2ZWQgZWFybGllciAodHJ1bmNhdGlvbikuXG4gIC8vIEdFVCAgL2FkbWluL2xlZGdlci1jaGFpbi86c3RyZWFtL2V4cG9ydCAgICAgICAg4oCUIHRoZSBzdGFibGUgSlNPTkwgZXhwb3J0XG4gIC8vICAgICAgKEBwYXBlcmN1c3AvaGFzaC1jaGFpbiBmb3JtYXQpLCB2ZXJpZmlhYmxlIG9mZmxpbmUuXG4gIC8vIFBPU1QgL2FkbWluL2xlZGdlci1jaGFpbi86c3RyZWFtL3dpdG5lc3MgICAgICAg4oCUIGNoYWluIHJvd3MgYSBmYWlsZWRcbiAgLy8gICAgICBhZnRlci1hcHBlbmQgd2l0bmVzcyBwYXNzIGxlZnQgdW5jaGFpbmVkLlxuICBhcHAuZ2V0KCcvYWRtaW4vbGVkZ2VyLWNoYWluJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgICBpZiAob3AgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wO1xuICAgIGNvbnN0IHN0cmVhbXMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHN0cmVhbUlkIG9mIExFREdFUl9TVFJFQU1fSURTKSBzdHJlYW1zLnB1c2goYXdhaXQgdmVyaWZ5TGVkZ2VyU3RyZWFtKGMuZW52LkRCLCBzdHJlYW1JZCkpO1xuICAgIHJldHVybiBjLmpzb24oeyBvazogc3RyZWFtcy5ldmVyeSgocykgPT4gcy5vayksIHN0cmVhbXMgfSk7XG4gIH0pO1xuXG4gIGFwcC5nZXQoJy9hZG1pbi9sZWRnZXItY2hhaW4vOnN0cmVhbS92ZXJpZnknLCBhc3luYyAoYykgPT4ge1xuICAgIGNvbnN0IG9wID0gYXdhaXQgcmVxdWlyZU9wZXJhdG9yKGMpO1xuICAgIGlmIChvcCBpbnN0YW5jZW9mIFJlc3BvbnNlKSByZXR1cm4gb3A7XG4gICAgY29uc3Qgc3RyZWFtSWQgPSBjLnJlcS5wYXJhbSgnc3RyZWFtJyk7XG4gICAgaWYgKCFpc0xlZGdlclN0cmVhbUlkKHN0cmVhbUlkKSkgcmV0dXJuIGMuanNvbih7IGVycm9yOiAndW5rbm93bl9zdHJlYW0nLCBzdHJlYW1zOiBMRURHRVJfU1RSRUFNX0lEUyB9LCA0MDQpO1xuICAgIGNvbnN0IGV4cGVjdGVkSGVhZCA9IHBhcnNlRXhwZWN0ZWRIZWFkKG5ldyBVUkwoYy5yZXEudXJsKSk7XG4gICAgaWYgKGV4cGVjdGVkSGVhZCA9PT0gJ2ludmFsaWQnKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICdpbnZhbGlkX2ZpZWxkJywgZmllbGQ6ICdoZWFkU2VxL2hlYWRIYXNoJyB9LCA0MDApO1xuICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHZlcmlmeUxlZGdlclN0cmVhbShjLmVudi5EQiwgc3RyZWFtSWQsIHsgZXhwZWN0ZWRIZWFkIH0pO1xuICAgIHJldHVybiBjLmpzb24ocmVwb3J0KTtcbiAgfSk7XG5cbiAgYXBwLmdldCgnL2FkbWluL2xlZGdlci1jaGFpbi86c3RyZWFtL2V4cG9ydCcsIGFzeW5jIChjKSA9PiB7XG4gICAgY29uc3Qgb3AgPSBhd2FpdCByZXF1aXJlT3BlcmF0b3IoYyk7XG4gICAgaWYgKG9wIGluc3RhbmNlb2YgUmVzcG9uc2UpIHJldHVybiBvcDtcbiAgICBjb25zdCBzdHJlYW1JZCA9IGMucmVxLnBhcmFtKCdzdHJlYW0nKTtcbiAgICBpZiAoIWlzTGVkZ2VyU3RyZWFtSWQoc3RyZWFtSWQpKSByZXR1cm4gYy5qc29uKHsgZXJyb3I6ICd1bmtub3duX3N0cmVhbScsIHN0cmVhbXM6IExFREdFUl9TVFJFQU1fSURTIH0sIDQwNCk7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IGV4cG9ydExlZGdlclN0cmVhbShjLmVudi5EQiwgc3RyZWFtSWQpO1xuICAgIHJldHVybiBuZXcgUmVzcG9uc2UoYm9keSwge1xuICAgICAgc3RhdHVzOiAyMDAsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24veC1uZGpzb247IGNoYXJzZXQ9dXRmLTgnLFxuICAgICAgICAnY29udGVudC1kaXNwb3NpdGlvbic6IGBhdHRhY2htZW50OyBmaWxlbmFtZT1cIiR7c3RyZWFtSWR9LmNoYWluLmpzb25sXCJgLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXBwLnBvc3QoJy9hZG1pbi9sZWRnZXItY2hhaW4vOnN0cmVhbS93aXRuZXNzJywgYXN5bmMgKGMpID0+IHtcbiAgICBjb25zdCBvcCA9IGF3YWl0IHJlcXVpcmVPcGVyYXRvcihjKTtcbiAgICBpZiAob3AgaW5zdGFuY2VvZiBSZXNwb25zZSkgcmV0dXJuIG9wO1xuICAgIGNvbnN0IHN0cmVhbUlkID0gYy5yZXEucGFyYW0oJ3N0cmVhbScpO1xuICAgIGlmICghaXNMZWRnZXJTdHJlYW1JZChzdHJlYW1JZCkpIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ3Vua25vd25fc3RyZWFtJywgc3RyZWFtczogTEVER0VSX1NUUkVBTV9JRFMgfSwgNDA0KTtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdpdG5lc3NMZWRnZXJTdHJlYW0oYy5lbnYuREIsIHN0cmVhbUlkLCBub3cpO1xuICAgIGF3YWl0IGF1ZGl0KGMuZW52LkRCLCBub3csICdsZWRnZXJfY2hhaW5fd2l0bmVzc2VkJywge1xuICAgICAgc3RyZWFtX2lkOiBzdHJlYW1JZCxcbiAgICAgIGFwcGVuZGVkOiByZXN1bHQuYXBwZW5kZWQsXG4gICAgICBvcGVyYXRvcl9naXRodWJfdXNlcl9pZDogb3AuaWQsXG4gICAgfSk7XG4gICAgcmV0dXJuIGMuanNvbih7IG9rOiB0cnVlLCAuLi5yZXN1bHQgfSk7XG4gIH0pO1xuXG4gIHJldHVybiBhcHA7XG59XG4iXSwiZmlsZSI6Ii9zcmMvcm91dGVzL2FkbWluLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9hZG1pbi50cyIsIi9zcmMvcm91dGVzL2FkbWluLnRzIixbXV0=
}}