/**
 * Harness-scoped testing surface — the harness Tests tab's backend.
 *
 * Phase C / P-024 of harness-tests-tab-and-tester-promotion-2026-05-26.
 * Mirrors /api/admin/testing/* but scoped to a harness's phase worktree:
 *
 *   GET  /api/harness/:slug/testing/domain-detail?domainId=…&phase=…
 *   GET  /api/harness/:slug/testing/file-status?domainId=…&phase=…
 *   GET  /api/harness/:slug/testing/health-strip?domainId=…&phase=…
 *   POST /api/harness/:slug/testing/run         (body: { runner })
 *   GET  /api/harness/:slug/testing/domains            — the harness's domains + tier labels
 *
 * The harness's test DOMAINS are harness-owned data, declared in the harness's
 * own contract surface at `<worktree>/.papercusp/testing-domains.json`
 * (`{ domains: TestDomain[], tierLabels?: Record<string,string> }`). A harness
 * that declares none falls back to the generic `harnessTestingRegistry`
 * (Built-in generalized + Acceptance). This keeps the operator from hard-wiring
 * a per-harness registry: the papercup dogfood harness ships its own
 * `.papercusp/testing-domains.json` (generated from the operator's adminRegistry),
 * the same place a harness's test data naturally lives.
 *
 * Built-in (generalized) domains are glob-walked against the worktree
 * (`expandGlobs(phasePath(...), globs)`, reused from the admin path).
 * The Acceptance (project) domain's files come from `.papercusp/tests.json`.
 *
 * NOT gated by FLAGS.HARNESS_PHASES (unlike the legacy /harness/:slug/tests
 * routes): that flag gates the staging/testing/production PHASE system, which
 * is a separate concern from surfacing a harness's tests. The Tests tab works
 * regardless of the flag. (The flag itself is unchanged — still off by default,
 * still gating PhaseTabs et al.)
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { type ProjectEntry } from '../../../harness-registry';
import { type Phase, phasePhaseLabel, phasePath } from '../../../harness-phases';
import { expandGlobs } from '../../../testing-domain-glob';
import { harnessTestingRegistry, HARNESS_TESTING_TIER_LABELS, ACCEPTANCE_DOMAIN_ID } from '../../../harness-testing-registry';
import { type TestDomain, type ChipStatus, type FileStatusEntry } from '../../../testing-domains';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { computePlanItemTestStatus } from '../../../harness-test-rollup';

interface HarnessTestRow {
  id: string;
  summary: string;
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
}

function readHarnessTests(project: ProjectEntry, phase: Phase): HarnessTestRow[] {
  const raw = safeRead(join(phasePath(project, phase), '.papercusp', 'tests.json'));
  if (!raw) return [];
  try {
    return (JSON.parse(raw).tests ?? []) as HarnessTestRow[];
  } catch {
    return [];
  }
}

/**
 * Load the harness's declared test domains from its own contract surface
 * (`<worktree>/.papercusp/testing-domains.json`), falling back to the generic
 * generalized+Acceptance registry. Harness-owned data, not operator-hardwired.
 */
function loadHarnessDomains(root: string): { domains: TestDomain[]; tierLabels: Record<string, string> } {
  const raw = safeRead(join(root, '.papercusp', 'testing-domains.json'));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { domains?: unknown; tierLabels?: unknown };
      if (Array.isArray(parsed.domains) && parsed.domains.length > 0) {
        return {
          domains: parsed.domains as TestDomain[],
          tierLabels:
            (parsed.tierLabels as Record<string, string> | undefined) ?? HARNESS_TESTING_TIER_LABELS,
        };
      }
    } catch {
      /* malformed → fall back */
    }
  }
  return { domains: harnessTestingRegistry, tierLabels: HARNESS_TESTING_TIER_LABELS };
}

function findDomain(id: string, root: string): TestDomain | undefined {
  return loadHarnessDomains(root).domains.find((d) => d.id === id);
}

function chipFromStatus(s: HarnessTestRow['status']): ChipStatus {
  return s === 'passing' ? 'pass' : s === 'failing' ? 'fail' : 'skip';
}

/** Resolve (project, phase, worktree root) from the request, or a 404 Response. */
async function resolveCtx(
  slug: string,
  phaseParam: string | null,
): Promise<{ project: ProjectEntry; phase: Phase; root: string } | Response> {
  const phase = phasePhaseLabel(phaseParam ?? undefined);
  const project = await resolvePhasedProject(slug, phase);
  if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
  return { project, phase, root: phasePath(project, phase) };
}

const domainDetail = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/domain-detail',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId') ?? '';

    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, phase, root } = resolved;

    const domain = findDomain(domainId, root);
    if (!domain) return Response.json({ error: 'unknown_domain', domainId }, { status: 404 });

    let sections;
    if (domainId === ACCEPTANCE_DOMAIN_ID) {
      // Acceptance "files" are the VAL-covering tests; dedupe by path.
      const seen = new Set<string>();
      const files = readHarnessTests(project, phase)
        .filter((t) => (seen.has(t.file) ? false : (seen.add(t.file), true)))
        .map((t) => ({ path: t.file, sizeBytes: 0, mtimeMs: (t.lastRunTs || 0) * 1000 }));
      sections = domain.sections.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        files,
        runners: [],
      }));
    } else {
      sections = await Promise.all(
        domain.sections.map(async (s) => ({
          id: s.id,
          label: s.label,
          description: s.description,
          files: s.globs?.length ? await expandGlobs(root, s.globs) : [],
          runners: s.runners ?? [],
        })),
      );
    }
    const totalFiles = sections.reduce((n, s) => n + s.files.length, 0);
    return Response.json({
      id: domain.id,
      label: domain.label,
      description: domain.description,
      tier: domain.tier,
      sections,
      totalFiles,
    });
  },
});

const listDomains = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/domains',
  auth: 'public',
  async handler(req, ctx) {
    const resolved = await resolveCtx(ctx.params.slug as string, new URL(req.url).searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { domains, tierLabels } = loadHarnessDomains(resolved.root);
    return Response.json({ domains, tierLabels });
  },
});

const fileStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/file-status',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId') ?? '';
    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, phase } = resolved;

    const statuses: Record<string, FileStatusEntry> = {};
    // Only the Acceptance domain has persisted per-file status (tests.json).
    // Built-in (generalized) files glob-walk the worktree but the harness
    // doesn't track their run status — they render as "none" chips.
    if (domainId === ACCEPTANCE_DOMAIN_ID) {
      for (const t of readHarnessTests(project, phase)) {
        if (t.status === 'not_run') continue;
        statuses[t.file] = {
          status: chipFromStatus(t.status),
          durationMs: t.durationMs || null,
          finishedAt: t.lastRunTs ? new Date(t.lastRunTs * 1000).toISOString() : null,
          source: 'local',
          branch: null,
          stale: false,
        };
      }
    }
    return Response.json({ domainId, branch: null, commit: null, statuses });
  },
});

const healthStrip = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/health-strip',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    // Minimal strip for now — per-file run history isn't tracked in the
    // harness yet (the tester writes pass/fail, not a flake series).
    return Response.json({
      domainId: url.searchParams.get('domainId') ?? '',
      branch: null,
      lastSuiteDurationMs: null,
      lastFailureFinishedAt: null,
      flakyFileCount: 0,
      totalFilesTracked: 0,
    });
  },
});

const run = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/run',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { root } = resolved;

    const body = (await req.json().catch(() => ({}))) as {
      runner?: { kind?: string; filePath?: string; filePaths?: string[] };
    };
    const runner = body.runner ?? {};
    const requested =
      runner.kind === 'vitest-multi' ? runner.filePaths ?? [] : runner.filePath ? [runner.filePath] : [];
    // Path-safety: repo-relative POSIX, no traversal.
    const files = requested.filter((f) => /^[A-Za-z0-9_./*-]+$/.test(f) && !f.includes('..'));
    if (files.length === 0) {
      return Response.json({ error: 'no runnable files in request' }, { status: 400 });
    }

    // Synchronous run in the worktree (the harness has no async run daemon;
    // matches the existing /harness/:slug/tests/:id/run route). Vitest only —
    // the panel's per-file Run always requests vitest; playwright/pytest
    // acceptance tests run via the orchestrator's tester loop, not here.
    const started = Date.now();
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync('npx', ['vitest', 'run', ...files], {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      output = String(err.stdout ?? '') + String(err.stderr ?? '');
      exitCode = err.status ?? 1;
    }
    return Response.json({
      runId: `h-${started}`,
      status: exitCode === 0 ? 'pass' : 'fail',
      exitCode,
      output: output.slice(-8000),
      finishedAt: Date.now(),
    });
  },
});

// ── Assertions (VALs) — the Acceptance tab's data (P-062 / P-063) ──────────
// harness_plan_assertions is keyed by (workspace, harness_slug), not phase.

interface AssertionListRow {
  val_id: string;
  plan_slug: string;
  item_id: string;
  verify_text: string;
  status: string;
  requires_test: boolean;
}

const listAssertions = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/assertions',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const planSlug = new URL(req.url).searchParams.get('plan');
    try {
      const { sql } = getOrgPg();
      const ws = activeWorkspaceId();
      const rows = planSlug
        ? await sql<AssertionListRow[]>`
            SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND plan_slug = ${planSlug}
             ORDER BY val_id`
        : await sql<AssertionListRow[]>`
            SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug}
             ORDER BY val_id`;
      return Response.json({ assertions: rows });
    } catch {
      // Table absent / PG unreachable — empty is a valid "no assertions yet".
      return Response.json({ assertions: [] });
    }
  },
});

const patchAssertion = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/assertions/:valId',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const valId = ctx.params.valId as string;
    const body = (await req.json().catch(() => ({}))) as { requires_test?: unknown };
    if (typeof body.requires_test !== 'boolean') {
      return Response.json({ error: 'requires_test (boolean) required' }, { status: 400 });
    }
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const rows = await sql<{ val_id: string; requires_test: boolean }[]>`
      UPDATE harness_shared.harness_plan_assertions
         SET requires_test = ${body.requires_test}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND val_id = ${valId}
       RETURNING val_id, requires_test`;
    if (rows.length === 0) return Response.json({ error: 'assertion_not_found' }, { status: 404 });
    return Response.json({ ok: true, val_id: rows[0].val_id, requires_test: rows[0].requires_test });
  },
});

// ── Plan↔test rollup (P-082) ───────────────────────────────────────────────
// Per-plan-item test coverage, joined from harness_plan_assertions ⋈
// harness_tests through the VAL. Mirrors plans-central's feature-status badge
// but for tests; consumed by the Plans-tab coverage badge (P-083).

const planItemsTestStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/plan-items-test-status',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const planSlug = new URL(req.url).searchParams.get('plan');
    try {
      const { sql } = getOrgPg();
      const ws = activeWorkspaceId();
      const assertions = planSlug
        ? await sql<{ val_id: string; item_id: string; requires_test: boolean }[]>`
            SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND plan_slug = ${planSlug}`
        : await sql<{ val_id: string; item_id: string; requires_test: boolean }[]>`
            SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
      const testRows = await sql<{ status: string; payload: { coversVALs?: unknown } }[]>`
        SELECT status, payload FROM harness_shared.harness_tests
         WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
      const tests = testRows.map((r) => ({
        status: r.status,
        coversVALs: Array.isArray(r.payload?.coversVALs)
          ? (r.payload.coversVALs as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
      }));
      const byItem = computePlanItemTestStatus(assertions, tests);
      return Response.json({ items: Object.values(byItem) });
    } catch {
      // Table/PG absent — empty is a valid "no coverage data".
      return Response.json({ items: [] });
    }
  },
});

export default [domainDetail, listDomains, fileStatus, healthStrip, run, listAssertions, patchAssertion, planItemsTestStatus];
