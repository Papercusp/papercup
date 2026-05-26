/**
 * plans:promote — promote a plan into a harness as new SPEC.md
 * criteria + (separately) features.
 *
 * agent-coordination-architecture-v2 §11.
 *
 *   - **Preview** (default, `apply: false`): computes the new SPEC.md
 *     body (current + new [SC-NNN]-tagged criteria with provenance) and
 *     the per-feature covers mapping. Returns the JSON for the caller
 *     to inspect — useful for dry-runs / agent-driven proposal review.
 *   - **Apply** (`apply: true`): in addition to preview, fetches the
 *     current SPEC from `/api/harness/<slug>/spec` (capturing its
 *     `version`), `PUT`s the new spec with `expected_version` for OCC
 *     (one rebase-retry on 409), `POST`s the features to
 *     `/features/import` so the server allocates F-AUTO-* ids, and —
 *     unless `mark_items: false` — marks each plan item listed in
 *     `from_items` as `done` via `withPlanLock` + `flipStatusInBody`.
 *   - **plan_event**: always emits a `kind=promoted` event so the
 *     history viewer surfaces it. The `after` payload differs between
 *     preview and apply.
 *
 * Reads the plan via `parsePlan` to validate the slug exists and to
 * surface item IDs back in the preview / apply summary.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { findUnknownFromItems, type PromoteFeatureInput } from '../promote';
import { emitPlanEventForCaller } from '../plan-events';
import { readPlanBySlug } from '../../plans/source';
import { withPlanLock, bumpUpdatedDate } from '../../plans/with-plan-lock';
import { flipStatusInBody } from '../../plans/set-status';
import { extractAssertions } from '../../plans/val-assertions';
import { ensureHarnessPlanAssertionsTable } from '../../ensure-schema';
import { getOrgPg } from '@restart/db-org';

const PROMOTED_FENCE = '<!-- plan-pipeline: do not edit this block manually -->';

/**
 * Marker for the auto-generated promote-status line inside `## Now`.
 * Lives at the end of the Now block, BELOW user-authored `**State:**`
 * and `**Next:**` lines. Idempotently replaced on each promote so
 * re-promoting accumulates correctly instead of appending duplicates.
 */
const PROMOTE_STATUS_MARKER = '<!-- plan-pipeline-status -->';

/**
 * Append (or replace) an auto-generated status line inside the `## Now`
 * block summarising how many features the plan has promoted and where
 * they are. Preserves user-authored `**State:**` / `**Next:**` content
 * verbatim — only the marker-delimited line is touched.
 *
 * The status line format:
 *   <!-- plan-pipeline-status -->
 *   **Promote-status:** N features in <harnessSlug>: <inflight> in-flight · <passed> passed
 *
 * If the plan has no `## Now` block, returns the body unchanged
 * (promote write-back has no preferred state/next to author).
 */
export function upsertPromoteStatusLine(
  body: string,
  harnessSlug: string,
  counts: { total: number; inflight: number; passed: number },
): string {
  const block =
    `${PROMOTE_STATUS_MARKER}\n` +
    `**Promote-status:** ${counts.total} feature(s) in \`${harnessSlug}\`: ` +
    `${counts.inflight} in-flight · ${counts.passed} passed`;

  // Strip any prior marker line + its content (idempotent re-promote).
  const stripRe = new RegExp(
    `\\n?${PROMOTE_STATUS_MARKER}\\n[^\\n]*(\\n[^\\n]*)?`,
    'g',
  );
  const stripped = body.replace(stripRe, '');

  // Find the end of the ## Now block (next ## heading or EOF).
  const nowMatch = /^## (?:\d+(?:\.\d+)?\.\s+)?Now\b/m.exec(stripped);
  if (!nowMatch) return stripped;
  const afterNow = nowMatch.index + nowMatch[0].length;
  const tail = stripped.slice(afterNow);
  const nextSection = /^## /m.exec(tail);
  const insertAt = nextSection ? afterNow + nextSection.index : stripped.length;

  // Ensure exactly one blank line before the marker, one after.
  const before = stripped.slice(0, insertAt).replace(/\n*$/, '');
  const after = stripped.slice(insertAt).replace(/^\n*/, '');
  return `${before}\n\n${block}\n\n${after}`;
}

export function upsertPromotedBlock(body: string, newRows: string[]): string {
  if (newRows.length === 0) return body;
  const headerMatch = /^## Promoted\b/m.exec(body);

  if (headerMatch) {
    const start = headerMatch.index;
    const afterHeader = start + headerMatch[0].length;
    const nextSectionRel = /^## /m.exec(body.slice(afterHeader));
    const blockEnd = nextSectionRel ? afterHeader + nextSectionRel.index : body.length;
    const blockContent = body.slice(start, blockEnd);

    const existingIds = new Set<string>();
    for (const m of blockContent.matchAll(/^\- \[[ x]\] (F-[A-Z0-9-]+)/gm)) {
      existingIds.add(m[1]);
    }
    const deduped = newRows.filter((r) => {
      const m = /^\- \[[ x]\] (F-[A-Z0-9-]+)/.exec(r);
      return m ? !existingIds.has(m[1]) : true;
    });
    if (deduped.length === 0) return body;

    const insert = deduped.join('\n') + '\n';
    return body.slice(0, blockEnd) + insert + body.slice(blockEnd);
  }

  const block = `\n## Promoted\n\n${PROMOTED_FENCE}\n${newRows.join('\n')}\n`;
  const nowMatch = /^## Now\b/m.exec(body);
  if (nowMatch) {
    const afterNow = nowMatch.index + nowMatch[0].length;
    const nextSectionRel = /^## /m.exec(body.slice(afterNow));
    const ins = nextSectionRel ? afterNow + nextSectionRel.index : body.length;
    return body.slice(0, ins) + block + body.slice(ins);
  }
  return body + block;
}

const FEATURE_INPUT = z.object({
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  acceptance: z.array(z.string().min(1)).optional(),
  from_items: z
    .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
    .optional(),
});

/** Resolve the operator's own base URL (in-process http for now). */
function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

interface FeaturesImportResponse {
  ok?: boolean;
  inserted?: number;
  updated?: number;
  total?: number;
  ids?: string[];
  error?: string;
  // R23: provenance back-channel observability (from R8 + F2 features.ts work).
  // When a feature carries source_plan_slug the import handler back-writes to
  // consolidated; per-feature errors are surfaced so plans:promote can echo
  // them in its response.
  provenanceWritten?: number;
  provenanceFailed?: number;
  provenanceErrors?: Array<{ feature_id: string; error: string }>;
}



async function postFeaturesImport(
  harnessSlug: string,
  features: Array<{
    title: string;
    summary?: string;
    metadata: Record<string, unknown>;
    id?: string;
    claims?: string[];
    source_plan_slug?: string;
    source_plan_item_ids?: string[];
  }>,
): Promise<{
  ids: string[];
  inserted: number;
  updated: number;
  provenanceWritten?: number;
  provenanceFailed?: number;
  provenanceErrors?: Array<{ feature_id: string; error: string }>;
}> {
  const r = await fetch(
    `${operatorBase()}/api/harness/${encodeURIComponent(harnessSlug)}/features/import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`features_import_failed:${r.status}:${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as FeaturesImportResponse;
  return {
    ids: j.ids ?? [],
    inserted: j.inserted ?? 0,
    updated: j.updated ?? 0,
    ...(j.provenanceWritten != null && { provenanceWritten: j.provenanceWritten }),
    ...(j.provenanceFailed != null && { provenanceFailed: j.provenanceFailed }),
    ...(j.provenanceErrors && j.provenanceErrors.length > 0 && { provenanceErrors: j.provenanceErrors }),
  };
}

export default defineTool({
  name: 'plans:promote',
  profile: 'engineer',
  description:
    "Promote a `plans:*` plan into a harness. Preview computes the per-feature covers mapping and lists assertions that would be extracted. Apply POSTs features to /features/import (server allocates F-AUTO-*), stores inline VAL-* assertions to harness_plan_assertions, and marks the plan's from_items as done. Always emits a `plan_event` of kind=promoted.",
  guidance: {
    when: 'A plan is ready to enter the harness — you and the human (and any expert agents) have settled the feature list and acceptance criteria.',
    notWhen:
      'Routine plan edits — plans:set-now / plans:add-item already cover those. Mid-debate — promote only once the design is settled.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  roles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).describe('Plan slug to promote.'),
    harness_slug: z
      .string()
      .min(1)
      .describe('Target harness slug. SPEC.md lives at that harness root.'),
    current_spec: z
      .string()
      .optional()
      .describe(
        'Optional: current contents of the target harness SPEC.md. When omitted and apply=false, the preview is computed against an empty spec. When apply=true, the tool fetches the live spec (and version) itself.',
      ),
    features: z.array(FEATURE_INPUT).min(1).max(40),
    feature_ids: z
      .array(z.string().regex(/^F-[A-Za-z0-9-]+$/))
      .optional()
      .describe(
        'Optional caller-allocated F-NNN ids per feature. With apply=true and omitted ids, the server allocates F-AUTO-* and returns them.',
      ),
    apply: z
      .boolean()
      .optional()
      .default(false)
      .describe('When true, write SPEC + import features + mark plan items. When false (default), preview-only.'),
    mark_items: z
      .boolean()
      .optional()
      .default(true)
      .describe('Apply-only: when true (default) flip each from_items item to status=done.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    // Validate the plan exists.
    const planFile = await readPlanBySlug(args.slug);
    if (!planFile) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'plan_not_found',
              detail: `no plan with slug ${args.slug}`,
            }),
          },
        ],
        isError: true,
      };
    }
    const planTitle =
      (planFile.parsed.frontmatter as { title?: string } | null)?.title ?? args.slug;

    // Validate every from_items P-NNN against the plan's actual items
    // (audit B2). A typo'd id would otherwise be silently dropped during
    // the mark step — the caller would believe it covered an item that
    // does not exist. Fail fast, in both preview and apply mode.
    const unknownItems = findUnknownFromItems(
      args.features,
      (planFile.parsed.items as Array<{ id: string }>).map((i) => i.id),
    );
    if (unknownItems.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'unknown_plan_items',
              detail: `from_items references item id(s) not present in plan ${args.slug}: ${unknownItems.join(', ')}`,
              unknown_items: unknownItems,
            }),
          },
        ],
        isError: true,
      };
    }

    const features: PromoteFeatureInput[] = args.features.map((f) => ({
      title: f.title,
      body: f.body,
      acceptance: f.acceptance,
      from_items: f.from_items,
    }));

    // Preview path: emit plan event + return per-feature covers + assertion preview.
    if (!args.apply) {
      const previewItemIds = new Set<string>();
      for (const f of args.features) {
        for (const id of f.from_items ?? []) previewItemIds.add(id);
      }
      const previewAssertions = previewItemIds.size > 0
        ? extractAssertions(planFile.parsed.raw, previewItemIds)
        : [];

      await emitPlanEventForCaller(ctx, {
        planSlug: args.slug,
        event: 'promoted',
        after: {
          harness_slug: args.harness_slug,
          feature_count: args.features.length,
          assertion_count: previewAssertions.length,
          mode: 'preview',
        },
        detail: `previewed promote to ${args.harness_slug}: ${args.features.length} feature(s), ${previewAssertions.length} assertion(s)`,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'preview',
              plan_title: planTitle,
              preview: {
                feature_count: args.features.length,
                assertion_count: previewAssertions.length,
                assertions: previewAssertions.map((a) => ({ val_id: a.valId, item_id: a.itemId, verify: a.verifyText })),
              },
              apply_hint: {
                features_import_endpoint: `/api/harness/${args.harness_slug}/features/import`,
                note: 'Re-call with apply=true to import features + store assertions + mark plan items.',
              },
            }),
          },
        ],
      };
    }

    // Extract inline VAL-* assertions before building the import payload so
    // claims can be included in the SQLite INSERT (the import endpoint only
    // sets claims on INSERT, not UPDATE, so they must arrive with the row).
    const allItemIds = new Set<string>();
    for (const f of args.features) {
      for (const id of f.from_items ?? []) allItemIds.add(id);
    }
    // assertions keyed by item_id for O(1) lookup during payload construction.
    const assertionsByItem = new Map<string, string[]>();
    const allAssertions = allItemIds.size > 0
      ? extractAssertions(planFile.parsed.raw, allItemIds)
      : [];
    for (const a of allAssertions) {
      const arr = assertionsByItem.get(a.itemId) ?? [];
      arr.push(a.valId);
      assertionsByItem.set(a.itemId, arr);
    }

    // POST features to /features/import. Server allocates F-AUTO-* ids.
    // metadata.source_plan + metadata.covers carry provenance forward.
    // claims is populated from extracted VAL-* assertions for this feature's items.
    const importPayload = args.features.map((f, idx) => {
      const metadata: Record<string, unknown> = {
        source_plan: args.slug,
      };
      if (f.from_items && f.from_items.length > 0) {
        metadata.from_plan_items = f.from_items;
      }
      const featureClaims = (f.from_items ?? []).flatMap(
        (id) => assertionsByItem.get(id) ?? [],
      );
      const out: {
        title: string;
        summary?: string;
        metadata: Record<string, unknown>;
        id?: string;
        claims?: string[];
        source_plan_slug: string;
        source_plan_item_ids: string[];
      } = {
        title: f.title,
        metadata,
        source_plan_slug: args.slug,
        source_plan_item_ids: f.from_items ?? [],
        ...(featureClaims.length > 0 && { claims: featureClaims }),
      };
      if (f.body) out.summary = f.body;
      if (args.feature_ids && args.feature_ids[idx]) {
        out.id = args.feature_ids[idx];
      }
      return out;
    });
    const importRes = await postFeaturesImport(args.harness_slug, importPayload);

    // Store assertions in harness_plan_assertions (PG). Best-effort — features
    // are already imported with their claims, so assertion lookup failures
    // don't break validation, just degrade the /assertion/:valId endpoint.
    let assertionsWritten = 0;
    const assertionErrors: string[] = [];
    if (allAssertions.length > 0) {
      try {
        await ensureHarnessPlanAssertionsTable();
        const { sql } = getOrgPg();
        const workspaceId = ctx.workspaceId ?? '';
        for (const a of allAssertions) {
          try {
            await sql`
              INSERT INTO harness_shared.harness_plan_assertions
                (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, evidence_text, status)
              VALUES
                (${workspaceId}, ${args.harness_slug}, ${a.valId}, ${args.slug}, ${a.itemId},
                 ${a.verifyText}, ${a.evidenceText}, ${a.status})
              ON CONFLICT (workspace_id, harness_slug, val_id) DO UPDATE SET
                plan_slug     = EXCLUDED.plan_slug,
                item_id       = EXCLUDED.item_id,
                verify_text   = EXCLUDED.verify_text,
                evidence_text = EXCLUDED.evidence_text,
                updated_at    = now()
            `;
            assertionsWritten++;
          } catch (e) {
            assertionErrors.push(`${a.valId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        assertionErrors.push(e instanceof Error ? e.message : String(e));
        ctx.log?.(`[plans:promote] assertion PG store failed: ${assertionErrors[assertionErrors.length - 1]}`);
      }
    }

    // Mark plan items as done via withPlanLock + flipStatusInBody.
    const allFromItems = allItemIds;
    const markedItems: string[] = [];
    const skippedItems: Array<{ id: string; reason: string }> = [];
    if (args.mark_items && allFromItems.size > 0) {
      const result = await withPlanLock(
        ctx as never,
        {
          slug: args.slug,
          intent: `plans:promote → mark ${allFromItems.size} item(s) as done`,
        },
        async (current) => {
          if (current === null) {
            return { newBody: null, value: { ok: false as const, code: 'not_found' as const } };
          }
          let body = current;
          for (const itemId of allFromItems) {
            const { newBody, found } = flipStatusInBody(body, itemId, 'done');
            if (found) {
              body = newBody;
              markedItems.push(itemId);
            } else {
              skippedItems.push({ id: itemId, reason: 'item_not_found' });
            }
          }
          if (markedItems.length === 0) {
            return { newBody: null, value: { ok: true as const, marked: 0 } };
          }
          return { newBody: bumpUpdatedDate(body), value: { ok: true as const, marked: markedItems.length } };
        },
      );
      if (result.kind === 'busy') {
        // Plan was locked. Record but don't fail the overall apply — spec + features
        // already landed. Caller can retry the mark step manually.
        for (const id of allFromItems) {
          if (!markedItems.includes(id)) {
            skippedItems.push({ id, reason: 'plan_locked' });
          }
        }
      }
    }

    // Query consolidated for THIS plan's full feature set, post-import.
    // Used to refresh the ## Now promote-status line with live counts.
    // Best-effort: failure here is non-fatal — the ## Promoted block
    // write proceeds regardless.
    let statusCounts: { total: number; inflight: number; passed: number } | null = null;
    try {
      const { sql } = getOrgPg();
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated
         WHERE source_plan_slug = ${args.slug}
           AND harness_slug     = ${args.harness_slug}
      `;
      let passed = 0;
      let inflight = 0;
      for (const r of rows) {
        if (r.status === 'passed') passed++;
        else inflight++;
      }
      statusCounts = { total: rows.length, inflight, passed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log?.(`[plans:promote] status-count query failed (status line skipped): ${msg}`);
    }

    // Write-back: stamp ## Promoted block + refresh ## Now promote-status line.
    // Item-level idempotent: parse existing block, append only new feature IDs.
    // Status line is marker-delimited so re-promote replaces in place.
    //
    // R2-B: also flip `status: draft` → `status: active` in the frontmatter.
    // A promote turns a "proposal" (draft) into an "active work plan"; the
    // ProposalsPanel filters drafts only, so this is what makes the card
    // disappear from the panel after Accept. Idempotent: a plan that's
    // already `active`/`shipped`/`superseded` is left alone.
    await withPlanLock<null>(
      ctx as never,
      { slug: args.slug, intent: 'plans:promote → write ## Promoted block + Now status + activate' },
      async (current): Promise<{ newBody: string | null; value: null }> => {
        if (current === null) return { newBody: null, value: null };
        const featureRows = importRes.ids.map((fid, idx) => {
          const feat = args.features[idx];
          const itemRef = feat?.from_items?.[0] ? ` <!-- ${feat.from_items[0]} -->` : '';
          return `- [ ] ${fid} — ${feat?.title ?? fid}${itemRef}`;
        });
        let newBody = upsertPromotedBlock(current, featureRows);
        if (statusCounts) {
          newBody = upsertPromoteStatusLine(newBody, args.harness_slug, statusCounts);
        }
        // Promote-on-draft: flip status to active. Only the literal
        // `status: draft` line in frontmatter is rewritten — does not
        // touch any draft-shaped text in the body.
        newBody = newBody.replace(/^(status:\s*)draft\b/m, '$1active');
        return { newBody: bumpUpdatedDate(newBody), value: null };
      },
    );

    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'promoted',
      after: {
        harness_slug: args.harness_slug,
        feature_count: args.features.length,
        feature_ids: importRes.ids,
        marked_items: markedItems,
        mode: 'apply',
      },
      detail: `applied promote to ${args.harness_slug}: ${args.features.length} feature(s) → ids [${importRes.ids.join(', ')}], ${markedItems.length} item(s) marked done`,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            mode: 'apply',
            plan_title: planTitle,
            applied: {
              feature_ids: importRes.ids,
              features_inserted: importRes.inserted,
              features_updated: importRes.updated,
              marked_items: markedItems,
              skipped_items: skippedItems,
              assertions_written: assertionsWritten,
              ...(assertionErrors.length > 0 && { assertion_errors: assertionErrors }),
              ...(importRes.provenanceFailed != null && importRes.provenanceFailed > 0 && {
                provenance_failed: importRes.provenanceFailed,
                provenance_errors: importRes.provenanceErrors ?? [],
              }),
            },
          }),
        },
      ],
    };
  },
});
