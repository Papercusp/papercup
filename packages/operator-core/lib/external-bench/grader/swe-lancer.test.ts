/**
 * Unit coverage for the SWE-Lancer IC-SWE grader (swe-lancer.ts) — the pure
 * report→verdict mapping (both report shapes: a keyed per-instance map AND a
 * `{ resolved: [...] }` list), the injectable-deps grade pipeline (no Docker /
 * no Playwright images), and the no-silent-fail invariant.
 *
 * RESOLVED iff the IC-SWE task's E2E suite passed. A submission the eval
 * produced no verdict for → `graderError` (infra failure), never a silent fail.
 */
import { describe, expect, it } from 'vitest';
import { makeSweLancerGrader, parseSweLancerReport } from './swe-lancer';
import type { GraderFs, ProcExec } from './swe-bench-pro';
import type { ArmSubmission } from '../types';

const VERSION = 'swelancer@deadbeef / diamond images 2026-06';

const diffSub = (instanceId: string, prefix = 'seed0', patch = `diff-${instanceId}`): Extract<ArmSubmission, { modality: 'diff' }> => ({
  modality: 'diff',
  instanceId,
  patch,
  prefix,
});

// ── Pure report → verdict mapping ────────────────────────────────────────────

describe('parseSweLancerReport', () => {
  it('keyed-map: a per-instance entry with resolved:true → resolved', () => {
    const [r] = parseSweLancerReport({ i1: { resolved: true } }, [diffSub('i1')], VERSION);
    expect(r).toMatchObject({ instanceId: 'i1', resolved: true, graderFamily: 'swe-lancer', graderVersion: VERSION });
    expect(r.graderError).toBeUndefined();
  });

  it('prefers the `${instanceId}__${prefix}` key over the bare instanceId', () => {
    const report = { 'i1__seedA': { resolved: true }, i1: { resolved: false } };
    const [r] = parseSweLancerReport(report, [diffSub('i1', 'seedA')], VERSION);
    expect(r.resolved).toBe(true); // the seed-specific entry wins
  });

  it('an entry carrying `error` → graderError (infra failure, not a silent fail)', () => {
    const [r] = parseSweLancerReport({ i1: { error: 'playwright image missing' } }, [diffSub('i1')], VERSION);
    expect(r.resolved).toBe(false);
    expect(r.graderError).toBe('playwright image missing');
    expect(r.rawGraderOutput).toEqual({ error: 'playwright image missing' });
  });

  it('keyed-map with NO entry for a submission → graderError (no verdict produced)', () => {
    const [r] = parseSweLancerReport({ other: { resolved: true } }, [diffSub('ghost')], VERSION);
    expect(r.resolved).toBe(false);
    expect(r.graderError).toMatch(/no grader report entry/);
  });

  it('list shape { resolved: [...] }: in the list → resolved, NOT in the list → false WITHOUT a graderError', () => {
    const report = { resolved: ['i1'] };
    const [a, b] = parseSweLancerReport(report, [diffSub('i1'), diffSub('i2')], VERSION);
    expect(a).toMatchObject({ instanceId: 'i1', resolved: true });
    expect(a.graderError).toBeUndefined();
    // The list shape is a definitive verdict for ALL — absence means "not resolved", not "no verdict".
    expect(b).toMatchObject({ instanceId: 'i2', resolved: false });
    expect(b.graderError).toBeUndefined();
  });

  it('a boolean entry.resolved takes precedence over a list', () => {
    const report = { resolved: ['i1'], i1: { resolved: false } };
    const [r] = parseSweLancerReport(report, [diffSub('i1')], VERSION);
    expect(r.resolved).toBe(false); // the per-instance boolean wins
  });
});

// ── Injectable-deps grade pipeline ───────────────────────────────────────────

interface ExecCall { cmd: string; args: string[]; opts?: { cwd?: string } }
function fakeExec(result: { code: number; stderr?: string }): ProcExec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const fn = (async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ cmd, args, opts });
    return { stdout: '', stderr: result.stderr ?? '', code: result.code };
  }) as ProcExec & { calls: ExecCall[] };
  fn.calls = calls;
  return fn;
}

function fakeFs(reportJson?: string): GraderFs & { written: Record<string, string>; removed: string[] } {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  const fs = {
    written,
    removed,
    mkdtemp: async (prefix: string) => `${prefix}scratch`,
    writeFile: async (path: string, data: string) => { written[path] = data; },
    readFile: async () => {
      if (reportJson === undefined) throw new Error('ENOENT report.json');
      return reportJson;
    },
    rm: async (path: string) => { removed.push(path); },
  };
  return fs as GraderFs & { written: Record<string, string>; removed: string[] };
}

const cfg = (over: Partial<Parameters<typeof makeSweLancerGrader>[0]> = {}) => ({
  swelancerDir: '/swelancer',
  version: VERSION,
  buildEvalCommand: (ctx: { predsPath: string; outDir: string; split: string }) => ({
    cmd: 'uv',
    args: ['run', 'python', '-m', 'swelancer.eval', `--predictions=${ctx.predsPath}`, `--split=${ctx.split}`],
  }),
  ...over,
});

describe('makeSweLancerGrader', () => {
  it('returns [] (no exec) with no diff submissions', async () => {
    const exec = fakeExec({ code: 0 });
    const grader = makeSweLancerGrader(cfg(), { exec, fs: fakeFs('{}') });
    expect(await grader.grade([{ modality: 'qa', instanceId: 'q', answer: 'x', prefix: 's' } as ArmSubmission], [])).toEqual([]);
    expect(exec.calls).toHaveLength(0);
  });

  it('writes predictions with `patch` (NOT model_patch), defaults split=diamond, parses the report, cleans up', async () => {
    const exec = fakeExec({ code: 0 });
    const fs = fakeFs(JSON.stringify({ i1: { resolved: true }, i2: { resolved: false } }));
    let seenSplit = '';
    const grader = makeSweLancerGrader(
      cfg({ buildEvalCommand: (ctx) => { seenSplit = ctx.split; return { cmd: 'uv', args: [`--predictions=${ctx.predsPath}`] }; } }),
      { exec, fs },
    );
    const out = await grader.grade([diffSub('i1'), diffSub('i2')], []);
    const preds = JSON.parse(Object.values(fs.written)[0]) as Array<Record<string, unknown>>;
    expect(preds[0]).toEqual({ instance_id: 'i1', patch: 'diff-i1', prefix: 'seed0' });
    expect(preds[0]).not.toHaveProperty('model_patch');
    expect(seenSplit).toBe('diamond');
    expect(out.map((r) => [r.instanceId, r.resolved])).toEqual([['i1', true], ['i2', false]]);
    expect(fs.removed).toHaveLength(1);
  });

  it('a missing report.json becomes a per-instance graderError (NEVER a silent pass) with the eval exit code', async () => {
    const exec = fakeExec({ code: 9, stderr: 'docker run failed' });
    const grader = makeSweLancerGrader(cfg(), { exec, fs: fakeFs(/* no report */) });
    const out = await grader.grade([diffSub('i1')], []);
    expect(out).toHaveLength(1);
    expect(out[0].resolved).toBe(false);
    expect(out[0].graderError).toMatch(/could not read SWE-Lancer report\.json/);
    expect(out[0].graderError).toMatch(/eval exit 9/);
    expect(out[0].graderError).toMatch(/docker run failed/);
  });
});
