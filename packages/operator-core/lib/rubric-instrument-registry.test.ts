/**
 * test-rubric-unification-2026-10-12 P-005 (R-5, plan D-006): the rubric instrument registry —
 * parsers, the seed set (pinned to the performance audit's own keys), the argv evaluator, and
 * the authoring audit that refuses new/changed unregistered bindings and grandfathers carried ones.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOLDER_BEHAVIOR_INSTRUMENT_KEYS } from './goal-holder-behavior-metrics';
import { GOAL_MODE_INSTRUMENT_KEYS } from './goal-mode-computed-instruments';
import { GATE_REUSE_AUDIT_INSTRUMENT_KEY } from './release/gate-fire-ledger';
import {
  auditInstrumentBindings,
  getRegisteredInstrument,
  instrumentRegistry,
  isManualInstrumentKey,
  parseCgroupUsageUsec,
  parseDfPercent,
  parseLoadavg1,
  parseOldestDockerAgeSec,
  parsePsiAvg10,
  platformComputedInstrumentKeys,
  registeredInstrumentKeys,
  runInstrument,
  unregisteredInstrumentRefusal,
} from './rubric-instrument-registry';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const AUDIT_EVIDENCE = join(REPO_ROOT, 'docs/audits/application-performance-reliability-audit-2026-10-01-evidence.json');

const PSI_SAMPLE = [
  'some avg10=12.50 avg60=8.25 avg300=3.00 total=123456789',
  'full avg10=1.75 avg60=0.50 avg300=0.10 total=2345678',
].join('\n');

describe('instrument parsers read the real output formats', () => {
  it('reads PSI avg10 for the some and full lines, null for a missing line', () => {
    expect(parsePsiAvg10(PSI_SAMPLE, 'some')).toBe(12.5);
    expect(parsePsiAvg10(PSI_SAMPLE, 'full')).toBe(1.75);
    // /proc/pressure/cpu on older kernels carries only the `some` line.
    expect(parsePsiAvg10(PSI_SAMPLE.split('\n')[0], 'full')).toBeNull();
    // avg100=… must not satisfy avg10=.
    expect(parsePsiAvg10('some avg100=9.00 avg60=1.00', 'some')).toBeNull();
  });

  it('reads cgroup usage_usec, df pcent, and the 1-minute loadavg', () => {
    expect(parseCgroupUsageUsec('usage_usec 987654321\nuser_usec 1\nsystem_usec 2\n')).toBe(987654321);
    expect(parseCgroupUsageUsec('user_usec 1\n')).toBeNull();
    expect(parseDfPercent('Use%\n 42%\n')).toBe(42);
    expect(parseDfPercent('Use%\n')).toBeNull();
    expect(parseLoadavg1('3.21 2.10 1.05 4/1234 56789\n')).toBe(3.21);
    expect(parseLoadavg1('')).toBeNull();
  });

  it('reads the oldest docker container age; 0 for none; null on an unknown format', () => {
    const now = Date.parse('2026-10-12T22:00:00-04:00');
    const stdout = ['2026-10-12 21:00:00 -0400 EDT', '2026-10-12 20:00:00 -0400 EDT'].join('\n');
    expect(parseOldestDockerAgeSec(stdout, { now })).toBe(7200);
    expect(parseOldestDockerAgeSec('\n', { now })).toBe(0);
    expect(parseOldestDockerAgeSec('About an hour ago', { now })).toBeNull();
  });
});

describe('the registry seed set', () => {
  it('registers every host instrument key the performance audit recorded, verbatim (derived, not hand-copied)', () => {
    const audit = readFileSync(AUDIT_EVIDENCE, 'utf8');
    const auditKeys = new Set(
      [...audit.matchAll(/"key":\s*"(host:[^"]+)"/g)].map((m) => m[1].replace(/:(start|end)$/, '')),
    );
    // Positive control: the census must actually find keys, or the pin is vacuous.
    expect(auditKeys.size).toBeGreaterThanOrEqual(3);
    for (const key of auditKeys) expect(getRegisteredInstrument(key), key).not.toBeNull();
  });

  it('seeds runnable command instruments for PSI, cgroup CPU delta, df and docker age', () => {
    for (const key of [
      'host:psi-cpu-some-avg10-pct',
      'host:psi-cpu-full-avg10-pct',
      'host:psi-io-some-avg10-pct',
      'host:psi-memory-full-avg10-pct',
      'host:cgroup-cpu-delta-cores',
      'host:df-root-used-pct',
      'host:docker-test-container-max-age-s',
    ]) {
      const instrument = getRegisteredInstrument(key);
      expect(instrument?.evaluator, key).toBe('command');
      if (instrument?.evaluator === 'command') {
        expect(instrument.argv.length, key).toBeGreaterThan(0);
        expect(instrument.unit, key).toBeTruthy();
      }
    }
  });

  it('registers exactly the keys scorecards resolves as platform-computed', () => {
    const expected = [
      'woe.goal-mode-base-scorecard',
      GATE_REUSE_AUDIT_INSTRUMENT_KEY,
      ...Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS),
      ...Object.values(GOAL_MODE_INSTRUMENT_KEYS),
    ];
    expect(platformComputedInstrumentKeys().sort()).toEqual([...expected].sort());
    for (const key of expected) expect(instrumentRegistry().get(key)?.evaluator, key).toBe('platform');
  });

  it("never registers the manual key, and treats 'none' case-insensitively as manual", () => {
    expect(registeredInstrumentKeys()).not.toContain('none');
    expect(isManualInstrumentKey('none')).toBe(true);
    expect(isManualInstrumentKey(' NONE ')).toBe(true);
    expect(isManualInstrumentKey('host:df-root-used-pct')).toBe(false);
  });
});

describe('runInstrument', () => {
  it('runs the registered argv without a shell and parses one value', async () => {
    const calls: Array<readonly string[]> = [];
    const reading = await runInstrument('host:psi-cpu-some-avg10-pct', {
      exec: async (argv) => {
        calls.push(argv);
        return PSI_SAMPLE;
      },
      now: () => Date.parse('2026-10-13T00:00:00Z'),
    });
    expect(calls).toEqual([['cat', '/proc/pressure/cpu']]);
    expect(reading).toMatchObject({ key: 'host:psi-cpu-some-avg10-pct', unit: '%', value: 12.5 });
    expect(reading.measuredAt).toBe('2026-10-13T00:00:00.000Z');
    expect(reading.error).toBeUndefined();
  });

  it('computes a two-sample instrument as a rate, never a single lifetime counter', async () => {
    const samples = ['usage_usec 1000000\n', 'usage_usec 5000000\n'];
    const times = [0, 2000];
    const slept: number[] = [];
    const reading = await runInstrument('host:cgroup-cpu-delta-cores', {
      exec: async () => samples.shift() as string,
      now: () => times.shift() ?? 2000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([2000]);
    // 4,000,000 µs of CPU over 2,000 ms of wall = 2 cores.
    expect(reading.value).toBe(2);
    expect(reading.unit).toBe('cores');
  });

  it('reports an unparseable or failed command as value null with an error, never 0', async () => {
    const unparsed = await runInstrument('host:df-root-used-pct', { exec: async () => 'garbage' });
    expect(unparsed.value).toBeNull();
    expect(unparsed.error).toMatch(/did not parse/);
    const failed = await runInstrument('host:df-root-used-pct', {
      exec: async () => {
        throw new Error('spawn df ENOENT');
      },
    });
    expect(failed.value).toBeNull();
    expect(failed.error).toMatch(/ENOENT/);
  });

  it('refuses to run an unregistered key or a platform-computed key', async () => {
    await expect(runInstrument('testing:run')).rejects.toThrow(/unregistered instrument 'testing:run'/);
    await expect(runInstrument(GATE_REUSE_AUDIT_INSTRUMENT_KEY)).rejects.toThrow(/platform-computed/);
  });

  it.skipIf(!existsSync('/proc/pressure/cpu'))('measures real host CPU pressure through the default executor', async () => {
    const reading = await runInstrument('host:psi-cpu-some-avg10-pct');
    expect(reading.error).toBeUndefined();
    expect(reading.value).not.toBeNull();
    expect(reading.value as number).toBeGreaterThanOrEqual(0);
    expect(reading.value as number).toBeLessThanOrEqual(100);
  });
});

describe('auditInstrumentBindings (the authoring guard)', () => {
  const manual = { key: 'm', check: { kind: 'instrument' as const, instrumentKey: 'NONE' } };
  const registered = { key: 'r', check: { kind: 'instrument' as const, instrumentKey: 'host:df-root-used-pct' } };
  const unbound = { key: 'u', model: 'Prose only.' };

  it('accepts manual, registered and unbound criteria on a new rubric', () => {
    expect(auditInstrumentBindings({ prior: [], next: [manual, registered, unbound] })).toEqual({
      refused: [],
      grandfathered: [],
    });
  });

  it('refuses a NEW unregistered binding in every binding form', () => {
    const audit = auditInstrumentBindings({
      prior: [],
      next: [
        { key: 'a', check: { kind: 'instrument', instrumentKey: 'parked-agent-census' } },
        { key: 'b', instrumentKey: 'testing:run' },
        { key: 'c', model: 'Rates the thing. [instrumentKey: reaper-vitest]' },
      ],
    });
    expect(audit.refused).toEqual([
      { criterion: 'a', instrumentKey: 'parked-agent-census', priorInstrumentKey: null },
      { criterion: 'b', instrumentKey: 'testing:run', priorInstrumentKey: null },
      { criterion: 'c', instrumentKey: 'reaper-vitest', priorInstrumentKey: null },
    ]);
  });

  it('grandfathers a carried unchanged legacy key and refuses a changed one', () => {
    const audit = auditInstrumentBindings({
      prior: [
        { key: 'carried', instrumentKey: 'pot-throughput-ticks' },
        { key: 'changed', instrumentKey: 'legacy-a' },
      ],
      next: [
        // Same key moved from the legacy field into the structured check: still carried.
        { key: 'carried', check: { kind: 'instrument', instrumentKey: 'pot-throughput-ticks' } },
        { key: 'changed', instrumentKey: 'legacy-b' },
      ],
    });
    expect(audit.grandfathered).toEqual([{ criterion: 'carried', instrumentKey: 'pot-throughput-ticks' }]);
    expect(audit.refused).toEqual([{ criterion: 'changed', instrumentKey: 'legacy-b', priorInstrumentKey: 'legacy-a' }]);
  });

  it('a legacy key moved onto a DIFFERENT criterion is not carried', () => {
    const audit = auditInstrumentBindings({
      prior: [{ key: 'old', instrumentKey: 'legacy-a' }],
      next: [{ key: 'new', instrumentKey: 'legacy-a' }],
    });
    expect(audit.refused).toEqual([{ criterion: 'new', instrumentKey: 'legacy-a', priorInstrumentKey: null }]);
  });

  it('renders a refusal naming each binding and the registered keys, or null when nothing is refused', () => {
    expect(unregisteredInstrumentRefusal({ refused: [], grandfathered: [] })).toBeNull();
    const refusal = unregisteredInstrumentRefusal({
      refused: [{ criterion: 'b', instrumentKey: 'testing:run', priorInstrumentKey: null }],
      grandfathered: [],
    });
    expect(refusal).toMatchObject({ ok: false, code: 'unregistered_instrument' });
    expect(refusal?.error).toContain("b → 'testing:run'");
    expect(refusal?.registeredKeys).toContain('host:psi-cpu-some-avg10-pct');
    expect(refusal?.next).toContain("instrumentKey:'none'");
  });
});
