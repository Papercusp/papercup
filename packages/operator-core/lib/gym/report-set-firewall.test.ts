/**
 * CI guard for the gym↔report-set firewall (P-012 / D-005).
 *
 * The load-bearing assertion is "optimize-on and report-on are strictly disjoint": if this
 * suite goes red, the gym is about to tune on a benchmark we publish scores on. Pure tests
 * (no PG, no network).
 */
import { describe, it, expect } from 'vitest';
import {
  REPORT_ON_SUITES,
  GYM_OPTIMIZE_ON_SETS,
  BENCH_SET_REGISTRY,
  ReportSetFirewallError,
  assertReportSetFirewall,
  assertGymMayOptimizeOn,
  assertGymTaskNotContaminated,
  assertGymCorpusDisjoint,
  reportSetTaskIntersection,
  taskFingerprint,
  isReportOnSet,
  isOptimizeOnSet,
  reportOnSetIds,
  optimizeOnSetIds,
  type BenchSet,
} from './report-set-firewall';

describe('gym↔report-set firewall — set-level disjointness (P-012)', () => {
  it('the live registry passes the static firewall', () => {
    expect(() => assertReportSetFirewall()).not.toThrow();
  });

  it('FAILS if a report-on suite is also declared a gym optimize-on source (the core guard)', () => {
    const doctored: BenchSet[] = [
      ...BENCH_SET_REGISTRY,
      // someone "adds SWE-bench Pro to the gym's training corpus" — the exact regression we fence
      {
        id: 'swe-bench-pro',
        usage: 'optimize-on',
        title: 'SWE-bench Pro as gym training data',
        rationale: 'illegal — reported on',
      },
    ];
    expect(() => assertReportSetFirewall(doctored)).toThrow(ReportSetFirewallError);
    expect(() => assertReportSetFirewall(doctored)).toThrow(/swe-bench-pro/);
  });

  it('the optimize-on and report-on id collections do not intersect', () => {
    const reportOn = reportOnSetIds();
    const optimizeOn = optimizeOnSetIds();
    const overlap = [...optimizeOn].filter((id) => reportOn.has(id));
    expect(overlap).toEqual([]);
  });

  it('every REPORT_ON_SUITES entry is usage=report-on and every GYM_OPTIMIZE_ON_SETS entry is usage=optimize-on', () => {
    expect(REPORT_ON_SUITES.every((s) => s.usage === 'report-on')).toBe(true);
    expect(GYM_OPTIMIZE_ON_SETS.every((s) => s.usage === 'optimize-on')).toBe(true);
  });

  it('flags duplicate (id, usage) registry entries', () => {
    const dup: BenchSet[] = [...BENCH_SET_REGISTRY, { ...REPORT_ON_SUITES[0] }];
    expect(() => assertReportSetFirewall(dup)).toThrow(/duplicate/);
  });

  it('REPORT_ON_SUITES IS the run_result.suite vocabulary — changing it is a deliberate, test-visible act (P-010/P-011 lock-step)', () => {
    // If you add/remove a published benchmark, update this expectation in the SAME change so
    // the firewall and the results schema can never silently drift apart.
    expect([...reportOnSetIds()].sort()).toEqual(
      [
        'agentsnet',
        'frontier-swe',
        'harness-bench',
        'metr-hcast',
        'roadmapbench',
        'swe-bench-live',
        'swe-bench-pro',
        'swe-evo',
        'swarmbench',
        'swe-lancer',
        'swe-rebench',
        'terminal-bench',
      ].sort(),
    );
  });
});

describe('classifiers', () => {
  it('isReportOnSet / isOptimizeOnSet', () => {
    expect(isReportOnSet('swe-bench-pro')).toBe(true);
    expect(isReportOnSet('gym-synthetic')).toBe(false);
    expect(isOptimizeOnSet('gym-synthetic')).toBe(true);
    expect(isOptimizeOnSet('swe-bench-pro')).toBe(false);
    expect(isReportOnSet('totally-unknown')).toBe(false);
    expect(isOptimizeOnSet('totally-unknown')).toBe(false);
  });
});

describe('assertGymMayOptimizeOn — fail-closed source gate', () => {
  it('accepts declared gym optimize-on sources', () => {
    expect(() => assertGymMayOptimizeOn('gym-synthetic')).not.toThrow();
    expect(() => assertGymMayOptimizeOn('gym-real-anchor')).not.toThrow();
  });

  it('throws on a report-on set', () => {
    expect(() => assertGymMayOptimizeOn('swe-bench-pro')).toThrow(/REPORT-ON/);
    expect(() => assertGymMayOptimizeOn('terminal-bench')).toThrow(ReportSetFirewallError);
  });

  it('throws fail-closed on an undeclared source', () => {
    expect(() => assertGymMayOptimizeOn('mystery-corpus')).toThrow(/undeclared/);
  });
});

describe('assertGymTaskNotContaminated — the ingestion choke-point guard', () => {
  it('admits a clean synthetic task (no source tag, substrate repo, model generatedBy)', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 'synthetic-001',
        repoUrl: 'file:///home/x/papercup',
        repoCommit: 'abc123',
        generatedBy: 'claude-opus-4-8',
      }),
    ).not.toThrow();
  });

  it('admits a real-feature-replay task', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 'real-papercup-F-301',
        repoUrl: 'file:///home/x/papercup',
        repoCommit: 'deadbeef',
        generatedBy: 'real-feature-replay',
        sourceSet: 'gym-real-anchor',
      }),
    ).not.toThrow();
  });

  it('REFUSES a task whose declared sourceSet is a report-on suite', () => {
    expect(() =>
      assertGymTaskNotContaminated({ taskId: 't1', sourceSet: 'swe-bench-pro' }),
    ).toThrow(ReportSetFirewallError);
  });

  it('REFUSES a task with an undeclared sourceSet (fail-closed)', () => {
    expect(() =>
      assertGymTaskNotContaminated({ taskId: 't2', sourceSet: 'some-new-source' }),
    ).toThrow(/undeclared/);
  });

  it('REFUSES a task whose generatedBy names a report-on suite (the wired external-bench→gym vector)', () => {
    expect(() =>
      assertGymTaskNotContaminated({
        taskId: 't3',
        repoUrl: 'https://github.com/astropy/astropy',
        repoCommit: 'cafe01',
        generatedBy: 'swe-bench-pro',
      }),
    ).toThrow(/report-on/);
  });

  it('REFUSES a task whose repo@commit is in a supplied report-on manifest; admits one that is not', () => {
    const manifest = new Set([
      taskFingerprint('https://github.com/astropy/astropy', 'CAFE01'),
      taskFingerprint('git@github.com:django/django.git', 'beef02'),
    ]);
    expect(() =>
      assertGymTaskNotContaminated(
        { taskId: 't4', repoUrl: 'https://github.com/astropy/astropy', repoCommit: 'cafe01' },
        { reportOnFingerprints: manifest },
      ),
    ).toThrow(/report-on benchmark set/);
    expect(() =>
      assertGymTaskNotContaminated(
        { taskId: 't5', repoUrl: 'file:///home/x/papercup', repoCommit: 'abc123' },
        { reportOnFingerprints: manifest },
      ),
    ).not.toThrow();
  });
});

describe('taskFingerprint — normalization', () => {
  it('collapses https / scp-ssh / .git / trailing-slash variants of the same repo+commit', () => {
    const a = taskFingerprint('https://github.com/astropy/astropy', 'ABC123');
    const b = taskFingerprint('git@github.com:astropy/astropy.git', 'abc123');
    const c = taskFingerprint('ssh://github.com/astropy/astropy/', 'abc123');
    const d = taskFingerprint('git+https://github.com/astropy/astropy', 'abc123');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });

  it('distinguishes different commits and different repos', () => {
    const base = taskFingerprint('https://github.com/astropy/astropy', 'abc123');
    expect(taskFingerprint('https://github.com/astropy/astropy', 'def456')).not.toEqual(base);
    expect(taskFingerprint('https://github.com/django/django', 'abc123')).not.toEqual(base);
  });
});

describe('task-level disjointness (Layer 2)', () => {
  it('reportSetTaskIntersection returns the shared fingerprints', () => {
    const optimizeOn = ['host/x@1', 'host/y@2', 'host/z@3'];
    const reportOn = ['host/y@2', 'host/q@9'];
    expect(reportSetTaskIntersection(optimizeOn, reportOn).sort()).toEqual(['host/y@2']);
  });

  it('assertGymCorpusDisjoint throws on overlap, passes when clean', () => {
    expect(() => assertGymCorpusDisjoint(['host/a@1'], ['host/b@2'])).not.toThrow();
    expect(() => assertGymCorpusDisjoint(['host/a@1', 'host/b@2'], ['host/b@2'])).toThrow(
      ReportSetFirewallError,
    );
  });
});
