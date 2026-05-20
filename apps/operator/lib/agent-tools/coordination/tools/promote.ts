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
import { buildSpecMutation, type PromoteFeatureInput } from '../promote';
import { emitPlanEventForCaller } from '../plan-events';
import { readPlanBySlug } from '../../plans/source';
import { withPlanLock, bumpUpdatedDate } from '../../plans/with-plan-lock';
import { flipStatusInBody } from '../../plans/set-status';

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

interface SpecGetResponse {
  spec?: string | null;
  version?: number;
  error?: string;
}

interface SpecPutResponse {
  ok?: boolean;
  written?: string[];
  version?: number;
  error?: string;
  current?: number;
}

interface FeaturesImportResponse {
  ok?: boolean;
  inserted?: number;
  updated?: number;
  total?: number;
  ids?: string[];
  error?: string;
}

async function fetchCurrentSpec(harnessSlug: string): Promise<{ spec: string; version: number }> {
  const r = await fetch(`${operatorBase()}/api/harness/${encodeURIComponent(harnessSlug)}/spec`);
  if (!r.ok) {
    throw new Error(`fetch_spec_failed:${r.status}`);
  }
  const j = (await r.json()) as SpecGetResponse;
  return { spec: j.spec ?? '', version: typeof j.version === 'number' ? j.version : 0 };
}

async function putSpec(
  harnessSlug: string,
  spec: string,
  expectedVersion: number,
): Promise<{ ok: true; version: number } | { ok: false; conflict: number }> {
  const r = await fetch(`${operatorBase()}/api/harness/${encodeURIComponent(harnessSlug)}/spec`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec, expected_version: expectedVersion }),
  });
  if (r.status === 409) {
    const j = (await r.json()) as SpecPutResponse;
    return { ok: false, conflict: j.current ?? 0 };
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`put_spec_failed:${r.status}:${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as SpecPutResponse;
  return { ok: true, version: j.version ?? expectedVersion + 1 };
}

async function postFeaturesImport(
  harnessSlug: string,
  features: Array<{
    title: string;
    summary?: string;
    metadata: Record<string, unknown>;
  }>,
): Promise<{ ids: string[]; inserted: number; updated: number }> {
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
  };
}

export default defineTool({
  name: 'plans:promote',
  description:
    "Promote a `plans:*` plan into a harness. Preview computes the SPEC.md mutation (new [SC-NNN]-tagged criteria with provenance) + per-feature covers mapping. Apply additionally PUTs the new spec with optimistic concurrency, POSTs features to /features/import (server allocates F-AUTO-*), and marks the plan's from_items as done. Always emits a `plan_event` of kind=promoted.",
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

    const features: PromoteFeatureInput[] = args.features.map((f) => ({
      title: f.title,
      body: f.body,
      acceptance: f.acceptance,
      from_items: f.from_items,
    }));

    // Resolve the spec we're building the mutation against.
    let currentSpec = args.current_spec ?? '';
    let currentVersion = 0;
    if (args.apply) {
      const fetched = await fetchCurrentSpec(args.harness_slug);
      currentSpec = fetched.spec;
      currentVersion = fetched.version;
    }

    let mutation = buildSpecMutation({
      currentSpec,
      planSlug: args.slug,
      authorOwnerId: identity.ownerId,
      features,
      featureIds: args.feature_ids,
    });

    // Preview path: emit history event + return.
    if (!args.apply) {
      await emitPlanEventForCaller(ctx, {
        planSlug: args.slug,
        event: 'promoted',
        after: {
          harness_slug: args.harness_slug,
          feature_count: args.features.length,
          sc_ids: mutation.criteria.map((c) => c.id),
          mode: 'preview',
        },
        detail: `previewed promote to ${args.harness_slug}: ${args.features.length} feature(s), ${mutation.criteria.length} criteria`,
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
                new_spec: mutation.newSpec,
                added_criteria: mutation.criteria,
                per_feature_covers: mutation.perFeatureCovers,
              },
              apply_hint: {
                spec_put_endpoint: `/api/harness/${args.harness_slug}/spec`,
                features_import_endpoint: `/api/harness/${args.harness_slug}/features/import`,
                note: 'Re-call with apply=true to write spec + import features + mark plan items.',
              },
            }),
          },
        ],
      };
    }

    // Apply path: PUT spec with OCC + retry-on-409 once.
    let put = await putSpec(args.harness_slug, mutation.newSpec, currentVersion);
    if (!put.ok) {
      // Rebase: re-fetch, rebuild mutation, retry once.
      const refetched = await fetchCurrentSpec(args.harness_slug);
      currentSpec = refetched.spec;
      currentVersion = refetched.version;
      mutation = buildSpecMutation({
        currentSpec,
        planSlug: args.slug,
        authorOwnerId: identity.ownerId,
        features,
        featureIds: args.feature_ids,
      });
      put = await putSpec(args.harness_slug, mutation.newSpec, currentVersion);
      if (!put.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'spec_version_conflict',
                detail: 'Spec moved concurrently twice; aborting.',
                conflict_version: put.conflict,
              }),
            },
          ],
          isError: true,
        };
      }
    }
    const newSpecVersion = put.version;

    // POST features to /features/import. Server allocates F-AUTO-* ids.
    // metadata.source_plan + metadata.covers carry provenance forward.
    const importPayload = args.features.map((f, idx) => {
      const cov = mutation.perFeatureCovers[idx] ?? [];
      const metadata: Record<string, unknown> = {
        source_plan: args.slug,
        covers: cov,
      };
      if (f.from_items && f.from_items.length > 0) {
        metadata.from_plan_items = f.from_items;
      }
      const out: { title: string; summary?: string; metadata: Record<string, unknown>; id?: string } = {
        title: f.title,
        metadata,
      };
      if (f.body) out.summary = f.body;
      if (args.feature_ids && args.feature_ids[idx]) {
        out.id = args.feature_ids[idx];
      }
      return out;
    });
    const importRes = await postFeaturesImport(args.harness_slug, importPayload);

    // Mark plan items as done via withPlanLock + flipStatusInBody.
    const allFromItems = new Set<string>();
    for (const f of args.features) {
      for (const id of f.from_items ?? []) allFromItems.add(id);
    }
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

    await emitPlanEventForCaller(ctx, {
      planSlug: args.slug,
      event: 'promoted',
      after: {
        harness_slug: args.harness_slug,
        feature_count: args.features.length,
        sc_ids: mutation.criteria.map((c) => c.id),
        spec_version: newSpecVersion,
        feature_ids: importRes.ids,
        marked_items: markedItems,
        mode: 'apply',
      },
      detail: `applied promote to ${args.harness_slug}: ${args.features.length} feature(s) → ids [${importRes.ids.join(', ')}], ${mutation.criteria.length} criteria, ${markedItems.length} item(s) marked done`,
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
              spec_version: newSpecVersion,
              added_criteria: mutation.criteria,
              per_feature_covers: mutation.perFeatureCovers,
              feature_ids: importRes.ids,
              features_inserted: importRes.inserted,
              features_updated: importRes.updated,
              marked_items: markedItems,
              skipped_items: skippedItems,
            },
          }),
        },
      ],
    };
  },
});
