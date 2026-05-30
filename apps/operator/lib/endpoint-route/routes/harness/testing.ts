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
 *
 * No `domains` list route: the SPA's nav comes from the registry prop
 * (harnessTestingRegistry), same as /admin/testing's hardcoded TABS.
 *
 * Built-in (generalized) domains are glob-walked against the worktree
 * (`expandGlobs(phasePath(...), globs)`, reused from the admin path).
 * The Acceptance (project) domain's files come from `.harness/tests.json`.
 *
 * Gated by FLAGS.HARNESS_PHASES, like the sibling /harness/:slug/tests routes.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { resolvePhasedProject, safeRead } from '@/lib/harness-core';
import { type ProjectEntry } from '@/lib/harness-registry';
import { type Phase, phasePhaseLabel, phasePath } from '@/lib/harness-phases';
import { expandGlobs } from '@/lib/testing-domain-glob';
import { harnessTestingRegistry, ACCEPTANCE_DOMAIN_ID } from '@/lib/harness-testing-registry';
import { type TestDomain, type ChipStatus, type FileStatusEntry } from '@/lib/testing-domains';

async function phasesEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.HARNESS_PHASES, 'system');
}

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
  const raw = safeRead(join(phasePath(project, phase), '.harness', 'tests.json'));
  if (!raw) return [];
  try {
    return (JSON.parse(raw).tests ?? []) as HarnessTestRow[];
  } catch {
    return [];
  }
}

function findDomain(id: string): TestDomain | undefined {
  return harnessTestingRegistry.find((d) => d.id === id);
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
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId') ?? '';
    const domain = findDomain(domainId);
    if (!domain) return Response.json({ error: 'unknown_domain', domainId }, { status: 404 });

    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, phase, root } = resolved;

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

const fileStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/file-status',
  auth: 'public',
  async handler(req, ctx) {
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
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
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
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
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
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

export default [domainDetail, fileStatus, healthStrip, run];
