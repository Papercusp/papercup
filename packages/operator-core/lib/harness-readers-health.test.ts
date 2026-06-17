/**
 * harness-readers-health.test.ts — unit coverage for getHealth.
 *
 * getHealth is a large surface that mixes PG (parseFeatures) with real
 * filesystem reads under `<project.path>/.papercusp`: run.log decision parsing
 * (ghostRate), checkpoint-*.md without a .granted sibling (pendingCheckpoints),
 * escalation.md / smoke-failure.md presence, and the newest logs/*.out|.jsonl
 * mtime (recent_activity / lastRunAgeSeconds).
 *
 * Strategy: point getHealth at a real temp harness dir (the fs reads are the
 * thing under test), pass opts.project to skip resolveProject, and mock ONLY
 * parseFeatures from harness-core (it is PG-backed) while keeping the real fs
 * helpers (harnessDir / tailFile / isProjectAlive). isProjectAlive scans /proc
 * for a run.sh cwd and is false for a temp dir, so `alive` is false here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock parseFeatures (PG-backed) but keep every real fs helper from the module.
// Also stub resolveProject so the no-opts.project 404 path is deterministic
// without a real registry (the opts.project path short-circuits it anyway).
const featuresState: { features: Array<{ status: string }> } = { features: [] };
vi.mock('./harness-core', async (orig) => {
  const actual = await orig<typeof import('./harness-core')>();
  return {
    ...actual,
    parseFeatures: vi.fn(async () => featuresState.features),
    resolveProject: vi.fn(async () => null),
  };
});

import { getHealth } from './harness-readers';

let root: string;
/** project.path; harnessDir(project) === <path>/.papercusp */
let papercuspDir: string;
const project = () => ({ slug: 'fix', path: root, harness_kind: 'coding' } as never);

function checkOf(checks: Array<{ name: string; ok: boolean; detail?: string }>, name: string) {
  return checks.find((c) => c.name === name)!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'health-'));
  papercuspDir = join(root, '.papercusp');
  mkdirSync(papercuspDir, { recursive: true });
  featuresState.features = [];
});

afterEach(() => {
  vi.clearAllMocks();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('getHealth — features counts', () => {
  it('returns ok:false 404 when the project does not resolve', async () => {
    // resolveProject is mocked to null, so omitting opts.project → 404.
    const res = await getHealth('definitely-not-a-real-slug-xyz', { project: undefined });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.error).toBe('unknown project');
  });

  it('tallies feature statuses (passed/failing/inProgress[+validating]/blocked)', async () => {
    featuresState.features = [
      { status: 'passed' },
      { status: 'passed' },
      { status: 'failing' },
      { status: 'in_progress' },
      { status: 'validating' },
      { status: 'blocked' },
    ];
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.features).toEqual({ total: 6, passed: 2, failing: 1, inProgress: 2, blocked: 1 });
    expect(checkOf(res.data.checks, 'features_present').ok).toBe(true);
    // 1 failing + 2 inProgress → not_stuck ok (inProgress > 0)
    expect(checkOf(res.data.checks, 'not_stuck').ok).toBe(true);
  });

  it('not_stuck is false when there are failing features and none in progress', async () => {
    featuresState.features = [{ status: 'failing' }];
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(checkOf(res.data.checks, 'not_stuck').ok).toBe(false);
  });
});

describe('getHealth — ghostRate (run.log ORCH decision parsing)', () => {
  it('computes ghostRate from mixed known/unknown ORCH decisions', async () => {
    // 5 decisions: 2 known (NEXT_WORKER, DONE), 3 unknown (ghosts).
    const runLog = [
      '[2026-06-16T00:00:00Z] ORCH decision: NEXT_WORKER',
      '[2026-06-16T00:00:01Z] ORCH decision: DONE',
      '[2026-06-16T00:00:02Z] ORCH decision: WAFFLE',
      '[2026-06-16T00:00:03Z] ORCH decision: SOMETHING_ELSE',
      '[2026-06-16T00:00:04Z] ORCH decision: ???',
      'some unrelated log line without a decision',
    ].join('\n');
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    writeFileSync(join(papercuspDir, 'logs', 'run.log'), runLog);

    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ghostRate).toBeCloseTo(3 / 5, 5);
    const low = checkOf(res.data.checks, 'low_ghost_rate');
    expect(low.ok).toBe(false); // 0.6 >= 0.1
    expect(low.detail).toBe('3/5 parser ghosts');
  });

  it('ghostRate is 0 when there are no decision lines', async () => {
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    writeFileSync(join(papercuspDir, 'logs', 'run.log'), 'no decisions here\njust noise\n');
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ghostRate).toBe(0);
    expect(checkOf(res.data.checks, 'low_ghost_rate').ok).toBe(true);
  });

  it('all-known decisions → ghostRate 0 and low_ghost_rate ok', async () => {
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    writeFileSync(
      join(papercuspDir, 'logs', 'run.log'),
      [
        '[t] ORCH decision: NEXT_WORKER',
        '[t] ORCH decision: NEXT_VALIDATOR',
        '[t] ORCH decision: NEXT_ARCHITECT',
        '[t] ORCH decision: ESCALATE',
        '[t] ORCH decision: CONVERTED',
        '[t] ORCH decision: DONE',
      ].join('\n'),
    );
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ghostRate).toBe(0);
  });
});

describe('getHealth — pendingCheckpoints (checkpoint-*.md without .granted)', () => {
  it('counts checkpoint-*.md files lacking a .granted sibling', async () => {
    writeFileSync(join(papercuspDir, 'checkpoint-a.md'), 'a');
    writeFileSync(join(papercuspDir, 'checkpoint-b.md'), 'b');
    // checkpoint-b is granted → not pending
    writeFileSync(join(papercuspDir, 'checkpoint-b.md.granted'), 'ok');
    // a non-checkpoint md is ignored
    writeFileSync(join(papercuspDir, 'notes.md'), 'x');

    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cp = checkOf(res.data.checks, 'no_pending_checkpoints');
    expect(cp.ok).toBe(false);
    expect(cp.detail).toBe('1 awaiting grant');
  });

  it('no_pending_checkpoints is ok when every checkpoint has a .granted sibling', async () => {
    writeFileSync(join(papercuspDir, 'checkpoint-x.md'), 'x');
    writeFileSync(join(papercuspDir, 'checkpoint-x.md.granted'), 'g');
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(checkOf(res.data.checks, 'no_pending_checkpoints').ok).toBe(true);
  });
});

describe('getHealth — escalation + smoke + recent_activity', () => {
  it('flags escalated when escalation.md exists', async () => {
    writeFileSync(join(papercuspDir, 'escalation.md'), 'help');
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.escalated).toBe(true);
    expect(checkOf(res.data.checks, 'not_escalated').ok).toBe(false);
    expect(checkOf(res.data.checks, 'not_escalated').detail).toBe('see escalation.md');
  });

  it('smoke_test_clean is false when smoke-failure.md exists', async () => {
    writeFileSync(join(papercuspDir, 'smoke-failure.md'), 'boom');
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(checkOf(res.data.checks, 'smoke_test_clean').ok).toBe(false);
  });

  it('recent_activity: fresh logs/*.out mtime → ok and a small lastRunAgeSeconds', async () => {
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    writeFileSync(join(papercuspDir, 'logs', 'worker.out'), 'output');
    // mtime = now (fresh)
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.lastRunAgeSeconds).not.toBeNull();
    expect(res.data.lastRunAgeSeconds!).toBeLessThan(600);
    expect(checkOf(res.data.checks, 'recent_activity').ok).toBe(true);
  });

  it('recent_activity: stale logs/*.jsonl mtime → not ok and lastRunAgeSeconds >= 600', async () => {
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    const f = join(papercuspDir, 'logs', 'run.jsonl');
    writeFileSync(f, 'old');
    // backdate mtime to ~2h ago
    const old = Date.now() / 1000 - 7200;
    utimesSync(f, old, old);
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.lastRunAgeSeconds!).toBeGreaterThanOrEqual(600);
    expect(checkOf(res.data.checks, 'recent_activity').ok).toBe(false);
  });

  it('recent_activity: no logs at all → lastRunAgeSeconds null, "no runs", not ok', async () => {
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.lastRunAgeSeconds).toBeNull();
    const ra = checkOf(res.data.checks, 'recent_activity');
    expect(ra.ok).toBe(false);
    expect(ra.detail).toBe('no runs');
  });

  it('only *.out / *.jsonl count toward lastRun; a plain *.log is ignored', async () => {
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    // run.log is fresh but NOT a counted extension
    writeFileSync(join(papercuspDir, 'logs', 'run.log'), 'fresh but ignored');
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No .out/.jsonl present → no run recorded.
    expect(res.data.lastRunAgeSeconds).toBeNull();
  });
});

describe('getHealth — overall ok', () => {
  it('overall ok:true only when every check passes (healthy fixture)', async () => {
    featuresState.features = [{ status: 'passed' }];
    mkdirSync(join(papercuspDir, 'logs'), { recursive: true });
    writeFileSync(join(papercuspDir, 'logs', 'worker.out'), 'ok'); // fresh → recent_activity ok
    writeFileSync(
      join(papercuspDir, 'logs', 'run.log'),
      '[t] ORCH decision: DONE\n', // all-known → low ghost rate
    );
    const res = await getHealth('fix', { project: project() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.ok).toBe(true);
    expect(res.data.checks.every((c) => c.ok)).toBe(true);
  });
});
