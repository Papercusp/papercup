/**
 * plans:get — full parsed structure for one plan.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns frontmatter, ## Now, items (with both storedStatus AND
 * effectiveStatus), decisions, and (mode=full) the prose body. Resolves
 * both docs/plans/ and docs/plans/archive/ — archived doesn't make a plan
 * unreachable.
 *
 * Payload diet (token-usage-reduction-audit-2026-06-09 P-008): plans:get was
 * the #3 tool-result payload fleet-wide (mean 13.9KB/call). `full` no longer
 * returns `raw` next to `prose` (the same document twice — frontmatter is
 * already structured in the base; exact raw bytes live behind plans:export),
 * and `sections` strips per-item `rawLine` (duplicates text/status/phase;
 * same precedent as plans:items). `full` keeps rawLine for surgical edits.
 */

import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import { withWorkspace } from "@papercusp/db-org";
import { readPlanBySlug } from "./source";
import { ctxToPlanSourceOpts, resolveEffectiveHarnessSlug } from "./_ctx-opts";
import { harnessArg, harnessScopedCtx } from "../_harness-scope";
import { resolveEffectiveStatus } from "./effective-status";
import { hashPlanContent } from "./content-hash";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-registry";
import {
  computePlanItemTestStatus,
  type PlanItemTestStatus,
} from "../../harness-test-rollup";
import { overlayIssueBlocksForPlan } from "../../issue-blocks-merge";
import { planItemProvenanceFromRow } from "../../plan-item-provenance";
import { boundRowField } from "../_bound-output";
import { bulkContent, mergeIds, runBulk } from "../_bulk";
import { cachedRead, type CachedReadCtx } from "../../cache";
import { shapePlansGet } from "./get-shape";
import { decoratePlanNowBlock } from "./liveness-decoration";
import { getAcceptanceRubricForPlan } from "../../rubrics";
import { getLatestPlanAudit } from "../../plan-audits";

/**
 * SWR backstop for plans:get (cache-expensive-tool-reads-round2-2026-06-23 P-001).
 * Mirrors plans:list: the plan tables
 * (harness_plans/plan_revisions/plan_runs/plan_audits) are
 * trigger-covered, so any plan write auto-invalidates the entry via the cache-ECA;
 * this short soft TTL only bounds staleness for the un-triggered DECORATIONS the
 * per-slug read folds in (issue-block overlay via coord_links, linkedFeatures via
 * harness_features_consolidated, planItemTests via harness_plan_assertions/tests).
 * The read is PURE + non-principal-scoped (depends only on workspace+harness+slug+mode).
 */
const PLANS_GET_SOFT_TTL_MS = 45_000;

// + overwatch (overwatch-role-2026-06-15 B-01): the system-health supervisor reads full
// plans to ground its nudges (read-only — its cap is plans:read, never plans:write).
// + worker/cup (EI-939): a pipeline worker or generic Hive worker told to "mark plan
// progress" on a checkbox-style roadmap plan had no read path at all — plans:set-status
// only flips the structured `- **P-NNN** \`status\`` line format, and plans:set-content
// needs the current version/contentHash from plans:get for its CAS, so a bee blind to
// this tool risked clobbering a peer's plan edit or hand-copying an untracked docs/plans
// mirror that lags PG. Read-only (capability: plans:read) — never grants a write path.
const ALL_ROLES = [...SU_ROLES, "promote", "kettle", "worker", "cup"] as const;

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Plan slug (filename without .md). Resolves both docs/plans/ and docs/plans/archive/.",
      ),
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Plan slugs to fetch in one call. Equivalent to calling this tool once per slug.",
      ),
    mode: z
      .enum(["meta", "sections", "full"])
      .optional()
      .describe(
        "How much to return. 'meta' = frontmatter + ## Now + counts + a section index (headings only). 'sections' (DEFAULT) = meta + structured items/decisions (items WITHOUT rawLine; long decision bodies are EXCERPTED to keep the default read bounded — each carries body_truncated + body_full_chars, and decisionBodiesTruncated flags when any were cut — use mode:'full' for complete bodies), still WITHOUT the markdown body. 'full' = everything incl. the whole markdown body as `prose`, per-item rawLine, and full decision bodies (a big blueprint can be 90KB+ — only when you actually need the prose; exact raw file bytes live behind plans:export).",
      ),
    heading: z
      .string()
      .optional()
      .describe(
        "Return only the body of the section whose heading matches (case-insensitive), plus identity + the CAS baseline (contentHash/version) so you can edit what you just read — read one part of a long plan without pulling the whole body (like docs:get's heading-narrowing). Deliberately NOT the ## Now block, promotePolicy, or frontmatter.raw: EI-19478970139996135 measured those at 73% of a heading read, shipping the same prose three times over. `sectionIndex` comes back ONLY when the heading MISSES, which is when you need it to find the one you meant. Overrides mode.",
      ),
    includeRaw: z
      .boolean()
      .optional()
      .describe(
        "Also return the EXACT raw markdown file bytes as `raw` (full mode only). Off by default — the payload diet (P-008) drops `raw` because it duplicates `prose`+structured frontmatter, doubling agent tool-output. The plans admin UI sets this because it round-trips the whole document through plans:set-content (whose CAS hashes the raw bytes) and reconstructing raw from prose+frontmatter would not byte-match. Agents that just need the body should use `prose`; for a standalone dump use plans:export.",
      ),
  })
  .refine((v) => !!v.slug || !!v.slugs?.length, {
    message: "Provide slug or slugs.",
  });

interface PlanSection {
  heading: string;
  level: number;
  chars: number;
}

// WI-274: bound decision bodies in plans:get `sections` mode so a decision-heavy
// plan can't overflow the agent tool-output cap (the round-4 plan hit 56KB on one
// line → spilled to a file). `full` mode keeps complete bodies. Per-decision cap =
// min(CAP, floor(BUDGET / n)) — the same budget-aware bound coord:inbox uses
// (EI-1752): total decision text stays bounded at ANY plan size, while normal plans
// keep most decisions in full (only the few long ones are excerpted).
export const DECISION_BODY_CAP = 1000;
export const DECISIONS_TOTAL_BUDGET = 15_000;

// EI-1597: a thin semantic wrapper over the shared budget-aware bound — single
// source of truth for the per-field excerpt (was an inlined copy of the loop).
export function boundDecisionBodies<T extends { body: string }>(
  decisions: T[],
): T[] {
  return boundRowField(
    decisions,
    "body",
    DECISION_BODY_CAP,
    DECISIONS_TOTAL_BUDGET,
  );
}

/** Split a plan's markdown body into level-1/2 sections, tracking fenced code
 *  blocks so headings inside ``` aren't treated as section breaks. Powers the
 *  section index (mode meta/sections) + the `heading` narrowing without pulling
 *  the full prose. */
export function splitSections(md: string): Array<PlanSection & { body: string }> {
  const lines = md.split("\n");
  const out: Array<PlanSection & { body: string }> = [];
  let cur: (PlanSection & { body: string }) | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur) {
      cur.body = buf.join("\n").trim();
      cur.chars = cur.body.length;
      out.push(cur);
    }
  };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (cur) buf.push(line);
      continue;
    }
    const m = !inFence ? /^(#{1,2})\s+(.*)$/.exec(line) : null;
    if (m) {
      flush();
      buf = [];
      cur = {
        heading: (m[2] ?? "").trim(),
        level: (m[1] ?? "").length,
        chars: 0,
        body: "",
      };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Split ONE section body into its level-3 (`###`) subsections, tracking fenced
 *  code blocks so `###` lines inside ``` aren't treated as subsection breaks.
 *  Prose before the first `###` is not a subsection and is dropped.
 *
 *  Only used by the `heading` LOOKUP fallback below — deliberately NOT folded
 *  into splitSections(), so the section index, `counts.sections` and every
 *  existing payload stay byte-identical. */
function splitSubsections(
  body: string,
): Array<PlanSection & { body: string }> {
  const out: Array<PlanSection & { body: string }> = [];
  let cur: (PlanSection & { body: string }) | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur) {
      cur.body = buf.join("\n").trim();
      cur.chars = cur.body.length;
      out.push(cur);
    }
  };
  for (const line of body.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (cur) buf.push(line);
      continue;
    }
    const m = !inFence ? /^###\s+(.*)$/.exec(line) : null;
    if (m) {
      flush();
      buf = [];
      cur = { heading: (m[1] ?? "").trim(), level: 3, chars: 0, body: "" };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Resolve `heading` to a section — level 1/2 first, then level-3 subsections.
 *
 * EI-19459526252132133: decisions are `### D-NNN` subsections of `## Decisions`,
 * and splitSections indexes levels 1-2 only, so ONE decision was unreachable by
 * any read. `plans:add-decision`, `plans:ratify-decision` and
 * `plans:set-decision-body` all address a decision BY ID, so the store could be
 * written by id and not read back by id — the whole `## Decisions` section was
 * the smallest readable unit, and on a mature plan that section is exactly what
 * overflows the result door (measured: 16 decisions cut mid-D-002; a 30-decision
 * plan yielded D-001..D-004 while counts said 30). The truncation is honest
 * about WHAT it dropped (./shape-clip) but there was no call that recovers it.
 *
 * The fallback runs only when the level-1/2 lookup MISSES, so an existing call
 * can never change meaning: a plan with a `## Decisions` section still resolves
 * to that section, never to a subsection that happens to share the substring.
 */
export function findSection(
  sections: Array<PlanSection & { body: string }>,
  heading: string,
): (PlanSection & { body: string }) | null {
  const want = heading.trim().toLowerCase();
  const match = (list: Array<PlanSection & { body: string }>) =>
    list.find((s) => s.heading.toLowerCase() === want) ??
    list.find((s) => s.heading.toLowerCase().includes(want)) ??
    null;

  const top = match(sections);
  if (top) return top;

  // Flattened in section order so an ambiguous substring resolves to the first
  // match by document position — the same rule the level-1/2 lookup uses.
  return match(sections.flatMap((s) => splitSubsections(s.body)));
}

/**
 * Fields the `heading` narrowing drops from the meta envelope, because a caller
 * asking for ONE section demonstrably did not ask for them.
 *
 * EI-19478970139996135: `heading` used to spread the whole meta `base`, so a
 * heading read shipped the entire `## Now`, the parsed+raw frontmatter, the
 * promote policy and the full sectionIndex wrapped around the one section
 * requested. Measured on semantic-search-fingerprint-coverage-2026-08-03
 * (heading:'Now'): 7538 chars, of which the requested body was 2041 — a 73%
 * envelope shipping the same content THREE times (now.state + now.next ≈
 * now.raw ≈ section.body). Three of three heading reads blew the ~1500-token
 * result door and spilled to scratch.
 *
 * The perverse part, and the reason this is a real bug rather than a diet: the
 * `heading` form exists to AVOID a big read, so it is reached for exactly when a
 * plan is large — and a large plan has a large `## Now`, so the fixed envelope
 * was heaviest precisely in the case the feature exists to serve.
 */
const HEADING_DROPPED_FIELDS = new Set(["now", "promotePolicy"]);

/**
 * Build the `heading`-narrowed payload from the meta base. Shared by the legacy
 * and non-legacy branches so the two cannot drift (the legacy base simply
 * carries none of the dropped fields, making those rules no-ops there).
 *
 * `sectionIndex` is kept ONLY on a MISS: it is how a caller finds the heading
 * they actually meant, so it earns its ~750 chars when the lookup failed and is
 * dead weight when it succeeded.
 */
export function narrowHeadingPayload(
  base: Record<string, unknown>,
  heading: string,
  sec: (PlanSection & { body: string }) | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (HEADING_DROPPED_FIELDS.has(key)) continue;
    if (key === "sectionIndex" && sec) continue;
    if (key === "frontmatter" && value && typeof value === "object") {
      // `raw` duplicates the parsed fields sitting beside it (measured 250 chars
      // of pure duplication). Filtered by key rather than destructured so this
      // holds whatever the parser adds later.
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "raw"),
      );
      continue;
    }
    out[key] = value;
  }
  out.heading = heading;
  out.section = sec
    ? { heading: sec.heading, level: sec.level, body: sec.body }
    : null;
  return out;
}

export default defineTool({
  name: "plans:get",
  description:
    "Fetch the full parsed structure of one plan by slug: frontmatter, ## Now (state + next), items with effectiveStatus, decisions. Resolves archived plans too. ALWAYS pass `harness` on an operator/superuser-scoped call: use the plan's concrete harness slug (for example, 'papercusp' for Papercusp's own plans). `harness: 'all'` is only valid in an unscoped (--all-workspaces) session. Omitting it throws harness_required; a harness-scoped session supplies it automatically.",
  guidance: {
    when: "You have a slug from plans:list and need the plan contents. Pass `harness` on THIS call as the plan's concrete project slug (for example, `harness: 'papercusp'` for Papercusp plans) unless your session is already scoped to a harness. `harness: 'all'` is only valid in an unscoped (--all-workspaces) session; omitting harness at operator/superuser scope fails with harness_required.",
    notWhen:
      "You don't know the slug — call plans:list first. Item-only queries across plans should use plans:items.",
    chaining:
      "plans:list → plans:get { slug, harness } → optionally plans:items for cross-plan picks.",
  },
  capability: "plans:read",
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...ALL_ROLES],
  modality: ["text"],
  args: argsSchema,
  // Freshness negotiation (agent-tool-delta-client-rollout-2026-06-23, P-002): plans:get
  // returns a single plan's full detail (content + items + decisions) — a COMPOSITE object,
  // NOT a keyed-row collection, so it opts into not_modified-ONLY (no semantic row-delta,
  // which would silently miss the non-collection fields). The framework's content-hash
  // revision suppresses the body when the plan for these args is byte-identical to the last
  // read — an 18KB unchanged plan re-read returns `not_modified` instead of replaying it.
  // NOT dormant (WI-3153, corrected 2026-08-04): the MCP transport's delta proxy
  // sends `_meta.delta` and reconstructs before the model sees anything. In-process
  // callers set no cursor, so `negotiateDelta` returns full (reason:'no_request').
  delta: {
    scope: (_args, ctx) => (ctx as { workspaceId?: string }).workspaceId ?? "",
    schemaVersion: "plans-get-v1",
    maxDeltaAge: 5 * 60_000,
  },
  // context-trimming-tiers P-012: trimmed/standard sessions get a projected
  // envelope (prose/items/decisions capped with loud pointers — see get-shape.ts).
  // The cache stores the UNSHAPED result (shaping runs post-handler in defineTool
  // dispatch), so one cached read serves every tier; the UI (HTTP transport, no
  // ctx_tier) always reads full.
  shape: {
    standard: (data) => shapePlansGet(data, "standard"),
    trimmed: (data) => shapePlansGet(data, "trimmed"),
  },
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) =>
        cachedRead(
          ctx as CachedReadCtx,
          {
            tool: "plans:get",
            // Folds EVERY output-determining dimension: slug + resolved harness +
            // mode + heading + includeRaw. workspace scope is added by cachedRead
            // from ctx. includeRaw MUST be here — else a slim agent-cached entry
            // (no `raw`) would be served to a UI caller that asked for raw, and
            // the editor would break intermittently on cache state.
            key: {
              slug,
              harness: opts.harnessSlug,
              mode: args.mode ?? "sections",
              heading: args.heading ?? null,
              includeRaw: args.includeRaw ?? false,
            },
            tags: ["harness_plans", "plan_revisions", "plan_runs", "plan_audits"],
            softTtlMs: PLANS_GET_SOFT_TTL_MS,
          },
          async () => {
            const result = await readPlanBySlug(slug, opts);
            if (!result)
              return { ok: false as const, slug, error: "not_found" };

            const { parsed, archived, row } = result;
            ctxAny.metadata?.({ slug, archived, legacy: parsed.isLegacy });

            if (parsed.isLegacy) {
              const sections = splitSections(parsed.prose);
              const legacyBase = {
                slug: parsed.slug,
                harness: row.harnessSlug,
                archived,
                legacy: true as const,
                contentHash: hashPlanContent(parsed.raw),
                // version is the optimistic-CAS baseline (plans-pg-canonical D-005);
                // contentHash kept for callers that still pass expectedHash.
                version: row.version,
                filename: parsed.filename,
                sectionIndex: sections.map((s) => ({
                  heading: s.heading,
                  level: s.level,
                  chars: s.chars,
                })),
                counts: { sections: sections.length },
              };
              let payload: Record<string, unknown> = legacyBase;
              if (args.heading) {
                payload = narrowHeadingPayload(
                  legacyBase,
                  args.heading,
                  findSection(sections, args.heading),
                );
              } else if ((args.mode ?? "sections") === "full") {
                // Legacy plans are prose-only — full includes the body; meta/sections omit it.
                // (Raw is byte-identical to prose for a legacy plan; only surfaced when the
                // caller opts in via includeRaw — see the non-legacy branch below.)
                payload = {
                  ...legacyBase,
                  prose: parsed.prose,
                  ...(args.includeRaw ? { raw: parsed.raw } : {}),
                };
              }
              return { ok: true as const, ...payload };
            }

            const resolved = resolveEffectiveStatus(parsed);

            // engineer-issues D-005: overlay OPEN issue blocks (coord_links rel='blocks',
            // dst=plan_item) onto effectiveStatus AFTER the pure resolver — an item blocked
            // by an open engineer-issue resolves to `blocked` + carries which EI(s) block it
            // (the closing of the issue unblocks every target atomically). The pure
            // @papercusp/plan-parser resolver is unchanged; the merge lives only here.
            const { items: resolvedItems, blockingIssues } =
              await overlayIssueBlocksForPlan(slug, resolved.items);

            // P-006: Build a map of plan-item-id → { featureId, status } so the UI
            // can show live feature status badges next to each P-NNN item.
            const harnessSlug = resolveEffectiveHarnessSlug(sctx);
            let linkedFeatures: Record<
              string,
              { featureId: string; status: string; harnessSlug: string }
            > = {};
            try {
              const rows = await withWorkspace(
                DEFAULT_WORKSPACE_ID,
                async (tx) => {
                  return tx<
                    {
                      feature_id: string;
                      status: string;
                      source_plan_slug: string | null;
                      source_plan_item_ids: string[] | null;
                      stamped_plan_slug: string | null;
                      stamped_item_id: string | null;
                      harness_slug: string;
                    }[]
                  >`
              SELECT feature_id, status, source_plan_slug, source_plan_item_ids,
                     payload -> 'plan_item' ->> 'plan_slug' AS stamped_plan_slug,
                     payload -> 'plan_item' ->> 'item_id'   AS stamped_item_id,
                     harness_slug
                FROM harness_shared.harness_features_consolidated
               WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
                 AND (source_plan_slug = ${slug}
                      OR payload -> 'plan_item' ->> 'plan_slug' = ${slug})
            `;
                },
              );
              for (const row of rows) {
                // EI-19435123521651527: `source_plan_item_ids` is effectively unwritten
                // (1 row workspace-wide vs 1,239 carrying the `payload.plan_item` stamp),
                // so the old `WHERE source_plan_item_ids IS NOT NULL` predicate matched
                // nothing and this badge map was always empty. Resolve via the shared
                // precedence rule instead.
                for (const itemId of planItemProvenanceFromRow(row).itemIds) {
                  linkedFeatures[itemId] = {
                    featureId: row.feature_id,
                    status: row.status,
                    harnessSlug: row.harness_slug,
                  };
                }
              }
            } catch {
              // Non-fatal — UI degrades to no badges.
            }

            // P-083: per-plan-item test coverage (the plan↔test rollup, through the
            // VAL). Mirrors linkedFeatures — computed server-side, decorated client-
            // side by decoratePlanItemTestBadges. Skips the tests query when the plan
            // has no inline-VAL assertions. Non-fatal.
            let planItemTests: Record<string, PlanItemTestStatus> = {};
            try {
              planItemTests = await withWorkspace(
                DEFAULT_WORKSPACE_ID,
                async (tx) => {
                  const assertions = await tx<
                    {
                      val_id: string;
                      item_id: string;
                      requires_test: boolean;
                    }[]
                  >`
              SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
               WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug} AND plan_slug = ${slug}
            `;
                  if (assertions.length === 0) return {};
                  const testRows = await tx<
                    { status: string; payload: { coversVALs?: unknown } }[]
                  >`
              SELECT status, payload FROM harness_shared.harness_tests
               WHERE workspace_id = ${DEFAULT_WORKSPACE_ID} AND harness_slug = ${harnessSlug}
            `;
                  return computePlanItemTestStatus(
                    assertions,
                    testRows.map((r) => ({
                      status: r.status,
                      coversVALs: Array.isArray(r.payload?.coversVALs)
                        ? (r.payload.coversVALs as unknown[]).filter(
                            (v): v is string => typeof v === "string",
                          )
                        : [],
                    })),
                  );
                },
              );
            } catch {
              // Non-fatal — UI degrades to no coverage badges.
            }

            const sections = splitSections(parsed.prose);
            // WI-1442 fix (a): read-time liveness decoration — annotate any
            // su-* agent-id mention in the ## Now prose with its CURRENT
            // coord:presence session state, so a stale "actively worked by
            // su-X" claim self-discloses instead of silently outliving the
            // agent it names. Best-effort; never mutates the stored plan.
            const decoratedNow = await decoratePlanNowBlock(parsed.now);
            // `meta`: frontmatter + ## Now + counts + section index. Never the body.
            const base = {
              // WI-7259 (sibling of WI-7246): a scheduled-run snapshot copies its
              // parent plan's body verbatim, frontmatter included — so
              // `parsed.frontmatter.slug` reads the PARENT's slug for every
              // snapshot. `row.planSlug` is the column this row was looked up
              // BY, so it is always the slug actually requested.
              slug: row.planSlug,
              harness: row.harnessSlug,
              archived,
              legacy: false as const,
              frontmatter: parsed.frontmatter,
              now: decoratedNow,
              contentHash: hashPlanContent(parsed.raw),
              version: row.version,
              // v2 P-001: the structured promote-policy ({ policy, warnings }) read from the row column —
              // agents read it here instead of parsing the `## Promote` markdown. null until mig-331 repopulate.
              promotePolicy: row.promotePolicy,
              // WI-40139 / D-005: permanent, bounded proof that this plan has
              // ever been shipped through an explicit code-truth waiver.
              forcedPast: row.forcedPast,
              sectionIndex: sections.map((s) => ({
                heading: s.heading,
                level: s.level,
                chars: s.chars,
              })),
              counts: {
                items: resolved.items.length,
                decisions: parsed.decisions.length,
                sections: sections.length,
              },
            };

            // `heading`: the requested section plus IDENTITY/CAS fields only —
            // deliberately NOT the full `base` meta envelope (overrides mode).
            // Rationale + the measurement live on narrowHeadingPayload above.
            if (args.heading) {
              return {
                ok: true as const,
                ...narrowHeadingPayload(
                  base,
                  args.heading,
                  findSection(sections, args.heading),
                ),
              };
            }

            const mode = args.mode ?? "sections";
            if (mode === "meta") {
              return { ok: true as const, ...base };
            }

            // `sections` (default): structured items/decisions + links — still WITHOUT
            // the prose blob (the 90KB overflow) and WITHOUT per-item rawLine (it
            // duplicates text/status/phase — P-008 payload diet). `full` adds both back.
            // WI-274: in `sections` (the default) excerpt long decision bodies so a
            // decision-heavy plan can't overflow the agent tool-output cap. `full` keeps
            // complete bodies (alongside the prose blob).
            const boundedDecisions =
              mode === "full"
                ? parsed.decisions
                : boundDecisionBodies(parsed.decisions);
            const decisionBodiesTruncated =
              mode !== "full" &&
              boundedDecisions.some((d) => "body_truncated" in d);
            // acceptance-rubrics-on-every-plan-2026-08-11 P-003: surface the plan's
            // acceptance rubric (its definition-of-done) so completion state is
            // discoverable from the plan itself. Absent = not yet authored (it is
            // authored POST-implementation, D-007; the ship gate names the recipe).
            const [acceptanceRubric, latestAudit] = await Promise.all([
              getAcceptanceRubricForPlan(row.planSlug)
                .then((r) =>
                  r
                    ? {
                        rubricId: r.rubricId,
                        status: r.status,
                        criteriaCount: r.criteria.length,
                        ...(r.classRef ? { classRef: r.classRef } : {}),
                      }
                    : null,
                )
                .catch(() => null),
              // plan-completion-audit-and-acceptance-verdict-2026-08-13 P-003:
              // make the recorded code-truth audit discoverable from the same plan
              // read as its definition-of-done rubric. The stored item entries carry
              // their own auditedSha/auditedAt/blobSha provenance (D-006/D-007).
              getLatestPlanAudit(row.planSlug, {
                workspaceId: row.workspaceId,
                harnessSlug: row.harnessSlug,
              }),
            ]);
            const structured = {
              ...base,
              ...(acceptanceRubric ? { acceptanceRubric } : {}),
              ...(latestAudit ? { latestAudit } : {}),
              items:
                mode === "full"
                  ? resolvedItems
                  : resolvedItems.map(({ rawLine: _rawLine, ...rest }) => rest),
              decisions: boundedDecisions,
              ...(decisionBodiesTruncated
                ? {
                    decisionBodiesTruncated: true as const,
                    decisionBodiesHint:
                      'Some decision bodies are excerpted (see each decision\'s body_truncated/body_full_chars). Use mode:"full" for complete bodies.',
                  }
                : {}),
              missingRefs: resolved.missingRefs,
              cycleMembers: resolved.cycleMembers,
              linkedFeatures,
              planItemTests,
              blockingIssues,
            };
            const payload =
              mode === "full"
                ? {
                    ...structured,
                    prose: parsed.prose,
                    // Opt-in EXACT raw bytes (P-008 drops these by default to keep
                    // agent payloads slim). The plans admin UI sets includeRaw so its
                    // Edit mode round-trips the whole document through set-content,
                    // whose CAS hashes the raw bytes — prose+frontmatter reconstructed
                    // would not byte-match.
                    ...(args.includeRaw ? { raw: parsed.raw } : {}),
                  }
                : structured;
            return { ok: true as const, ...payload };
          },
        ),
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
