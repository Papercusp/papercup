/**
 * promote-apply.integration.test.ts — the plans:promote HANDLER's APPLY path
 * (apply:true) against the baseline-schema PG.
 *
 * HE-02 / P-010 gap #3 (hive-run-evaluation-2026-06-13 — close the Class-1
 * deterministic gaps the HE-01 audit found). The audit's finding: "plans:promote
 * APPLY path — real wave features minted + inter-wave blocked_by edges — only
 * apply:false PREVIEW is tested (it asserts nothing is created)." This drives the
 * real tool handler end-to-end in apply mode and pins the apply-specific behavior
 * the preview test cannot reach:
 *   - the IMPORT PAYLOAD promote builds carries the realized wave structure: per-
 *     feature `wave` stamps + the inter-wave `blocked_by` edges (applyInterWaveEdges
 *     turns a wave-level `blocked_by` into feature-level edges by title) + the
 *     `claims` extracted from the plan's inline VAL-* assertions;
 *   - VAL-* assertions are upserted into harness_plan_assertions (real PG);
 *   - the from_items plan items are flipped to `done` (real PG plan content);
 *   - the `## Promoted` block + the `draft → active` frontmatter flip are written
 *     back to the plan (real PG plan content).
 *
 * SCOPE (deliberate, not a silent narrowing): the ACTUAL persistence of the minted
 * rows into harness_features_consolidated + the blocked_by → coord_links edges is
 * the `/features/import` ROUTE's responsibility, exercised against real PG by
 * features-provenance-workspace.integration.test.ts (updateFeatureProvenance) and
 * the route's own resolveBlockedByRefs/cycle logic. promote.ts only POSTs the
 * payload there via loopbackFetch — so this test points INTERNAL_API_BASE at an
 * in-test server that CAPTURES that payload (and returns allocated ids), keeping
 * the import route (its own concern) out of promote's test while still proving
 * promote SENDS exactly what the mint consumes.
 *
 * Same fixture as the other plans tool-suite integration tests: the baseline-schema
 * DB via setupPlanPgFixture() (inject('baselineSchemaDsn')).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type postgres from 'postgres';
import promoteTool from '../tools/promote';
import {
  setupPlanPgFixture,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';
// plans:promote resolves a papercup-harness plan at the papercup-primary workspace
// (PAPERCUSP_WORKSPACE_ID, flipped from 'default' on 2026-06-16 — WI-148 part-B /
// migration 295). Seed + verify there, not the fixture's generic 'default', or the
// tool's readPlanBySlug looks in the wrong workspace → plan_not_found.
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

// plans:promote reads the plan at the operator-home scope (no harness arg on the
// tool → resolvePlanScope returns operatorHomeHarnessSlug() / PAPERCUSP_WORKSPACE_ID).
// Seed under that home slug — 'papercusp' post papercup→papercusp migration
// (LEGACY_DEFAULT_HOME_HARNESS flipped 2026-06-20) — not the stale 'papercup'
// literal, or the tool's readPlanBySlug looks in the wrong harness → plan_not_found.
const PARENT_HARNESS = operatorHomeHarnessSlug();
const RUN = Math.random().toString(36).slice(2, 8);
const SLUG = `zzz-promote-apply-${RUN}-2026-06-13`;
const TARGET = `zzz-promote-apply-target-${RUN}`;

function planContent(): string {
  return `---
title: Promote Apply Test
slug: ${SLUG}
created: 2026-06-13
updated: 2026-06-13
status: draft
---

# Promote Apply Test

## Now

**State:** Test fixture.

**Next:** Drive the apply path.

## Phase 1

- **P-001** \`todo\` Foundation work.
  - **[VAL-foundation-001]**
    - **Verify:** \`npm run build\` passes
    - **Evidence:** \`tests/build.test.ts\`
    - **Status:** \`todo\`
- **P-002** \`todo\` Builds on the foundation.

## Promote

\`\`\`yaml
target_harness: ${TARGET}
waves:
  - id: w1
    features:
      - title: "Foundation feature"
        from_items: [P-001]
  - id: w2
    blocked_by: w1
    features:
      - title: "Dependent feature"
        from_items: [P-002]
\`\`\`
`;
}

interface CapturedImport {
  features: Array<{
    title: string;
    wave?: string;
    blocked_by?: string[];
    claims?: string[];
    source_plan_slug?: string;
    source_plan_item_ids?: string[];
  }>;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;
let server: Server;
let prevApiBase: string | undefined;
const captured: CapturedImport[] = [];
// The single apply is the ACT (run once in beforeAll); each test asserts a facet
// of its outcome — re-running promote would hit already-done items (marked: []).
let applyData: any;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: 'default',
    principal: { kind: 'agent', slug: 'agent-promote-apply-test', workspaceId: 'default' },
  } as never;
}

async function runPromote(args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const res = (await promoteTool.handler(args as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: Boolean(res.isError) };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, SLUG, planContent());

  // In-test stand-in for the /features/import route: capture the payload promote
  // POSTs and return deterministic allocated ids. The real mint + coord_links
  // edges are the route's own integration concern (see the header note).
  server = createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').includes('/features/import')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let parsed: CapturedImport = { features: [] };
        try {
          parsed = JSON.parse(body) as CapturedImport;
        } catch {
          /* leave empty */
        }
        captured.push(parsed);
        const ids = parsed.features.map((_f, i) => `F-PROMO-${i}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ids, inserted: ids.length, updated: 0 }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  prevApiBase = process.env.INTERNAL_API_BASE;
  process.env.INTERNAL_API_BASE = `http://127.0.0.1:${port}`;

  // The ACT: one apply over both waves. Tests below assert facets of this outcome.
  // mark_items is passed explicitly: calling .handler() directly bypasses the zod
  // schema's `.default(true)` (defaults are applied by the dispatch layer, not the
  // raw handler), so an omitted mark_items would read as undefined → no mark step.
  const r = await runPromote({ slug: SLUG, all_waves: true, apply: true, mark_items: true });
  applyData = r.data;
  expect(r.isError).toBe(false);
}, 120_000);

afterAll(async () => {
  if (prevApiBase === undefined) delete process.env.INTERNAL_API_BASE;
  else process.env.INTERNAL_API_BASE = prevApiBase;
  await new Promise<void>((r) => server?.close(() => r()));
  await admin`DELETE FROM harness_shared.harness_plans WHERE plan_slug = ${SLUG}`.catch(() => {});
  await admin`DELETE FROM harness_shared.harness_plan_assertions WHERE plan_slug = ${SLUG}`.catch(() => {});
  await admin`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${TARGET}`.catch(() => {});
  await fx.dispose();
});

describe('plans:promote APPLY path (apply:true, all_waves)', () => {
  it('builds an import payload with wave stamps, inter-wave blocked_by edges, and VAL claims', async () => {
    expect(applyData.ok).toBe(true);
    expect(applyData.mode).toBe('apply');
    expect(applyData.applied.feature_ids).toEqual(['F-PROMO-0', 'F-PROMO-1']);

    // The handler POSTed exactly one import with both waves' features.
    expect(captured).toHaveLength(1);
    const feats = captured[0].features;
    expect(feats).toHaveLength(2);

    const foundation = feats.find((f) => f.title === 'Foundation feature')!;
    const dependent = feats.find((f) => f.title === 'Dependent feature')!;
    expect(foundation).toBeDefined();
    expect(dependent).toBeDefined();

    // Per-feature wave stamps (consolidated.wave drives the deterministic drain).
    expect(foundation.wave).toBe('w1');
    expect(dependent.wave).toBe('w2');

    // Inter-wave ordering: wave w2 `blocked_by: w1` → each w2 feature is
    // blocked_by the w1 features' titles (applyInterWaveEdges). w1 has none.
    expect(dependent.blocked_by).toEqual(['Foundation feature']);
    expect(foundation.blocked_by ?? []).toEqual([]);

    // VAL-* claims threaded from the plan item the feature covers.
    expect(foundation.claims).toEqual(['VAL-foundation-001']);
    expect(dependent.claims ?? []).toEqual([]);

    // Provenance carried through.
    expect(foundation.source_plan_slug).toBe(SLUG);
    expect(foundation.source_plan_item_ids).toEqual(['P-001']);
    expect(dependent.source_plan_item_ids).toEqual(['P-002']);
  });

  it('upserts the inline VAL-* assertion into harness_plan_assertions (real PG)', async () => {
    const rows = await admin<{ val_id: string; item_id: string; verify_text: string; harness_slug: string }[]>`
      SELECT val_id, item_id, verify_text, harness_slug
        FROM harness_shared.harness_plan_assertions
       WHERE plan_slug = ${SLUG}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].val_id).toBe('VAL-foundation-001');
    expect(rows[0].item_id).toBe('P-001');
    expect(rows[0].harness_slug).toBe(TARGET);
    expect(rows[0].verify_text).toContain('npm run build');
  });

  it('marks the covered plan items done and writes back the ## Promoted block + draft→active (real PG)', async () => {
    // marked_items reported on the (single) apply result.
    expect((applyData.applied.marked_items as string[]).sort()).toEqual(['P-001', 'P-002']);

    const [row] = await admin<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS} AND plan_slug = ${SLUG}
    `;
    const body = row.content;
    // Items flipped to done.
    expect(body).toMatch(/- \*\*P-001\*\* `done`/);
    expect(body).toMatch(/- \*\*P-002\*\* `done`/);
    // ## Promoted block stamped with the allocated ids.
    expect(body).toContain('## Promoted');
    expect(body).toContain('F-PROMO-0');
    expect(body).toContain('F-PROMO-1');
    // Draft → active on promote.
    expect(body).toMatch(/^status: active$/m);
    expect(body).not.toMatch(/^status: draft$/m);
  });
});
