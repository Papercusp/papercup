/**
 * Per-phase tests tab:
 *
 *   GET  /api/harness/:slug/tests              — list tests for the resolved phase
 *   POST /api/harness/:slug/tests/:id/run      — execute a test via playwright/vitest/pytest; update status
 *
 * V1 ship-state gate: both routes return 404 when FLAGS.HARNESS_PHASES is
 * off — the tests tab is phase-coupled per the harness-phases plan.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 34). Helpers `readTests` / `writeTests` / interface `TestItem`
 * were inlined here (they had no other callers).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { type ProjectEntry } from '../../../harness-registry';
import { type Phase, phasePhaseLabel, phasePath } from '../../../harness-phases';
import { defineTool } from '@papercusp/agent-mcp';

interface TestItem {
  id: string;
  summary: string;
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
  phase: Phase;
  kind?: 'contract' | 'edge';
}

function readTests(project: ProjectEntry, phase: Phase): TestItem[] {
  const p = phasePath(project, phase);
  const f = join(p, '.papercusp', 'tests.json');
  const raw = safeRead(f);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed.tests ?? [];
  } catch { return []; }
}

async function writeTests(project: ProjectEntry, phase: Phase, tests: TestItem[]): Promise<void> {
  const p = phasePath(project, phase);
  const dir = join(p, '.papercusp');
  await mkdir(dir, { recursive: true });
  const f = join(dir, 'tests.json');
  const tmp = `${f}.tmp.${Date.now()}`;
  await writeFile(tmp, JSON.stringify({ tests }, null, 2), 'utf8');
  await rename(tmp, f);
}

async function phasesEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.HARNESS_PHASES, 'system');
}

const listTests = defineTool({
  method: 'GET',
  path: '/harness/:slug/tests',
  auth: 'public',
  async handler(req, ctx) {
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
    const url = new URL(req.url);
    const phase = phasePhaseLabel(url.searchParams.get('phase') ?? undefined);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    return Response.json({ tests: readTests(project, phase), phase });
  },
});

const runTest = defineTool({
  method: 'POST',
  path: '/harness/:slug/tests/:id/run',
  auth: 'public',
  async handler(req, ctx) {
    if (!(await phasesEnabled())) return new Response('Not Found', { status: 404 });
    const url = new URL(req.url);
    const phase = phasePhaseLabel(url.searchParams.get('phase') ?? undefined);
    const project = await resolvePhasedProject(ctx.params.slug as string, phase);
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const id = (ctx.params.id as string).replace(/[^A-Za-z0-9_.-]/g, '');
    const tests = readTests(project, phase);
    const t = tests.find((x) => x.id === id);
    if (!t) return Response.json({ error: 'test not found' }, { status: 404 });

    const wtPath = phasePath(project, phase);
    const started = Date.now();
    let ok = false;
    let output = '';
    try {
      const cmd =
        t.framework === 'playwright' ? ['npx', ['playwright', 'test', t.file]]
        : t.framework === 'vitest'   ? ['npx', ['vitest', 'run', t.file]]
        :                              ['pytest', [t.file]];
      const [bin, args] = cmd as [string, string[]];
      output = execFileSync(bin, args, { cwd: wtPath, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
      ok = true;
    } catch (e: any) {
      output = String(e?.stdout ?? '') + String(e?.stderr ?? '');
      ok = false;
    }
    const durationMs = Date.now() - started;
    t.status = ok ? 'passing' : 'failing';
    t.lastRunTs = Math.floor(Date.now() / 1000);
    t.durationMs = durationMs;
    await writeTests(project, phase, tests);

    return Response.json({ ok, test: t, output: output.slice(-4000) });
  },
});

export default [listTests, runTest];
