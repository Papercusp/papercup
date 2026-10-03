import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectGovernorSource } from '../../../../scripts/check-resource-governor-enforcement.mjs';
import { buildR11SystemdRunArgs, buildR11TargetQuery, buildR11TimerSpecs, evaluateR11Snapshots, scheduleR11Timers, selectR11StageRows, type R11Snapshot } from './r11-window-snapshot';

const at = '2026-10-03T03:00:00.000Z';
const snapshot = (stage: R11Snapshot['stage'], offsetMs: number, rows: Array<{ key: string; stale: boolean }>): R11Snapshot => ({
  stage, capturedAt: new Date(Date.parse(at) + offsetMs).toISOString(), mode: 'gemma', profileId: 'gemma',
  targets: [{ table: 's.t', embedCol: 'embedding', keyCols: ['id'], predicateHash: 'p',
    rows: rows.map((row) => ({ ...row, recency: null })) }],
});
const cut = (24 * 60 - 10) * 60_000;
const end = 24 * 60 * 60_000;

describe('R-11 admitted timer commands', () => {
  const specs = buildR11TimerSpecs(snapshot('T0', 0, []));
  const paths = { t0: '/evidence/t0.json.gz', cut: '/evidence/cut.json.gz', t1: '/evidence/t1.json.gz' };
  const runtime = { repoRoot: '/repo', tsx: '/repo/node_modules/.bin/tsx', script: '/repo/scripts/r11-window-snapshot.mts' };
  const success = { status: 0, signal: null, stdout: '', stderr: '', actualDemand: {} };
  const active = (index: number) => ({ ...success, stdout: `ActiveState=active\nUnit=${specs[index]!.unit}.service\n` });

  it('awaits the admitted start and verification for each timer', async () => {
    const execute = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(active(0))
      .mockResolvedValueOnce(success).mockResolvedValueOnce(active(1));
    const timers = await scheduleR11Timers(specs, paths, runtime, false, execute);
    expect(timers.map(({ show }) => show)).toEqual([active(0).stdout, active(1).stdout]);
    expect(execute.mock.calls.map(([command]) => command)).toEqual(['systemd-run', 'systemctl', 'systemd-run', 'systemctl']);
    expect(execute).toHaveBeenNthCalledWith(1, 'systemd-run', buildR11SystemdRunArgs(specs[0], paths, runtime),
      new Uint8Array(), { namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
    expect(execute.mock.calls[1]![1]).toContain(`${specs[0].unit}.timer`);
  });

  it('starts no process for a dry run', async () => {
    const execute = vi.fn();
    expect(await scheduleR11Timers(specs, paths, runtime, true, execute)).toEqual(
      specs.map((spec) => ({ ...spec, command: buildR11SystemdRunArgs(spec, paths, runtime) })),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not continue after admission refuses the first start', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('admission refused'));
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow('admission refused');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops every successfully started timer after bad verification, preserving the first error', async () => {
    const execute = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(active(0))
      .mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, stdout: 'ActiveState=failed' })
      .mockRejectedValueOnce(new Error('stop refused')).mockResolvedValueOnce(success);
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow(`Timer ${specs[1].unit} was not armed`);
    expect(execute.mock.calls.slice(4).map(([command, args]) => ({ command, args }))).toEqual(
      specs.map((spec) => ({ command: 'systemctl', args: ['--user', 'stop', `${spec.unit}.timer`] })),
    );
  });

  it.each([
    { ...success, status: 1, stderr: 'start failed' },
    { ...success, status: null, signal: 'SIGTERM' as const },
    { ...success, error: { code: 'ENOENT' } },
  ])('refuses unsuccessful process outcomes without arming the next timer', async (failure) => {
    const execute = vi.fn().mockResolvedValue(failure);
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow('systemd-run failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the canonical CLI free of unadmitted starts and detects a reintroduced start', () => {
    const source = readFileSync(new URL('../../../../scripts/r11-window-snapshot.mts', import.meta.url), 'utf8');
    expect(source).toContain('await scheduleR11Timers(');
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(inspectGovernorSource(source + "\nexecFileSync('systemd-run', []);"))
      .toContain('resource-start-outside-admission');
  });
});

describe('R-11 prospective snapshot', () => {
  it('uses shared sweep predicates and binds mode, exact profile and recipe', () => {
    const target = { table: 's.t', embedCol: 'embedding', bodySql: "coalesce(body, '')", keyCols: ['id'], recipeVersion: 2 };
    const query = buildR11TargetQuery(target, new Set(['id', 'embedding', 'body', 'embedding_mode', 'embedding_profile', 'embedding_recipe']),
      'gemma', { profileId: 'gemma-embeddinggemma-300m-768@v1', targetDims: 768, distanceMetric: 'cosine' });
    expect(query.query).toContain("length(coalesce(body, '')) > 0");
    expect(query.query).toContain('embedding_profile');
    expect(query.query).toContain('embedding_recipe');
    expect(query.params).toContain(2);
  });

  it('checks T0 and in-window eligible cohorts at the frozen T1', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }, { key: '[3]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }, { key: '[2]', stale: false }, { key: '[3]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('healthy');
    t1.targets[0]!.rows[2]!.stale = true;
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('failed');
  });

  it('keeps only newly eligible keys at Tcut and the frozen cohorts at T1', () => {
    const t0 = [{ key: '[1]', stale: true, recency: null }, { key: '[2]', stale: false, recency: null }];
    const now = [...t0, { key: '[3]', stale: true, recency: null }];
    const newKeys = selectR11StageRows('Tcut', now, t0);
    expect(newKeys.map((row) => row.key)).toEqual(['[3]']);
    expect(selectR11StageRows('T1', now, t0, newKeys).map((row) => row.key)).toEqual(['[1]', '[3]']);
  });

  it('keeps all-zero T0 and late captures inconclusive', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: false }, { key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    t0.targets[0]!.rows[0]!.stale = true;
    t1.capturedAt = new Date(Date.parse(at) + end + 61_000).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('freezes two UTC timer deadlines from the T0 database timestamp', () => {
    const t0 = snapshot('T0', 529, [{ key: '[1]', stale: true }]);
    expect(buildR11TimerSpecs(t0)).toEqual([
      { stage: 'Tcut', unit: `r11-p008-tcut-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 02:50:00 UTC' },
      { stage: 'T1', unit: `r11-p008-t1-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 03:00:00 UTC' },
    ]);
    expect(() => buildR11TimerSpecs(snapshot('Tcut', 0, []))).toThrow('T0 snapshot');
    t0.capturedAt = 'not-a-timestamp';
    expect(() => buildR11TimerSpecs(t0)).toThrow('invalid database timestamp');
  });

  it('passes frozen T0 and Tcut files to the correct one-shot user timers', () => {
    const [cutTimer, endTimer] = buildR11TimerSpecs(snapshot('T0', 0, []));
    const paths = { t0: '/evidence/t0.json.gz', cut: '/evidence/cut.json.gz', t1: '/evidence/t1.json.gz' };
    const runtime = { repoRoot: '/repo', tsx: '/repo/node_modules/.bin/tsx', script: '/repo/scripts/r11-window-snapshot.mts' };
    const common = (unit: string, at: string) => ['--user', `--unit=${unit}`, `--on-calendar=${at}`,
      '--timer-property=AccuracySec=1s', '--working-directory=/repo', '/usr/bin/bash', '-c',
      'set -a; . ./apps/operator/.env.local; set +a; exec "$@"', 'r11-capture', runtime.tsx, runtime.script];
    expect(buildR11SystemdRunArgs(cutTimer, paths, runtime)).toEqual([
      ...common(cutTimer.unit, cutTimer.at), 'Tcut', paths.cut, paths.t0,
    ]);
    expect(buildR11SystemdRunArgs(endTimer, paths, runtime)).toEqual([
      ...common(endTimer.unit, endTimer.at), 'T1', paths.t1, paths.t0, paths.cut,
    ]);
  });

  it('rejects malformed, early and out-of-order cutoff captures', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, []);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }]);
    for (const malformed of ['not-a-timestamp', '', '2026-99-99']) {
      tcut.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
      t1.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      t1.capturedAt = new Date(Date.parse(at) + end).toISOString();
    }
    tcut.capturedAt = new Date(Date.parse(at) - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
    t1.capturedAt = new Date(Date.parse(at) + cut - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('does not pass clause 1 if all originally stale rows leave the eligible set', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('does not let a passing target hide another target whose stale cohort disappeared', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, []);
    const t1 = snapshot('T1', end, []);
    t0.targets.push({ ...snapshot('T0', 0, [{ key: '[2]', stale: true }]).targets[0]!, table: 's.other' });
    tcut.targets.push({ ...snapshot('Tcut', cut, []).targets[0]!, table: 's.other' });
    t1.targets.push({ ...snapshot('T1', end, [{ key: '[2]', stale: false }]).targets[0]!, table: 's.other' });

    const result = evaluateR11Snapshots(t0, tcut, t1);
    expect(result.verdict).toBe('inconclusive');
    expect(result.targets.map(({ table, passed }) => ({ table, passed }))).toEqual([
      { table: 's.t', passed: false }, { table: 's.other', passed: true },
    ]);
  });
});
