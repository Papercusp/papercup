import { describe, expect, it } from 'vitest';
import { distribution, gradePairedBenchmark, runPairedBenchmark, type BenchmarkArm, type Trial } from './_paired-operation-benchmark';

describe('P-013 paired benchmark protocol', () => {
  it('interleaves matched arms at both concurrencies and keeps unknown counters unknown', async () => {
    const calls: string[] = [];
    const arm = (name: string): BenchmarkArm => {
      const run: BenchmarkArm['run'] = async (mode) => {
        calls.push(`${name}:${mode}`);
        return { ingress: 1, accepted: 2, dispatched: 3, terminal: 4, businessEvent: 5,
          dbRoundTrips: name === 'control' ? 2 : undefined };
      };
      return {
        warmup: async () => { calls.push(`${name}:warmup`); },
        coldStart: async () => {
          calls.push(`${name}:cold-boundary`);
          return { run: () => run('cold'), close: async () => { calls.push(`${name}:cold-close`); } };
        },
        run,
      };
    };
    const trials = await runPairedBenchmark({ control: arm('control'), candidate: arm('candidate') }, {
      warmups: 2, repetitions: 2, warmSamples: 3, coldSamples: 2, concurrencies: [1, 8],
    });
    expect(trials).toHaveLength(16);
    expect(trials.map((trial) => [trial.concurrency, trial.repetition, trial.mode, trial.arm])).toEqual(
      [1, 8].flatMap((concurrency) => [0, 1].flatMap((repetition) =>
        (['warm', 'cold'] as const).flatMap((mode) =>
          (repetition === 0 ? ['control', 'candidate'] : ['candidate', 'control'])
            .map((name) => [concurrency, repetition, mode, name])))),
    );
    expect(calls.filter((call) => call.endsWith(':warmup'))).toHaveLength(8);
    expect(calls.filter((call) => call.endsWith(':cold-boundary'))).toHaveLength(16);
    expect(calls.filter((call) => call.endsWith(':cold-close'))).toHaveLength(16);
    expect(trials.filter((trial) => trial.mode === 'warm').every((trial) => trial.samples === 3)).toBe(true);
    expect(trials.filter((trial) => trial.mode === 'cold').every((trial) => trial.samples === 2)).toBe(true);
    expect(trials[0]?.phasesMs.total).toMatchObject({ count: 3, p50: 4, p95: 4, p99: 4 });
    expect(trials.find((trial) => trial.arm === 'candidate')?.persistence)
      .toEqual({ dbRoundTrips: null, dbBytes: null, durableSteps: null });
    expect(trials[0]?.persistence.dbRoundTrips).toBe(6);
  });

  it('keeps the interleaved arm order when single repetitions run as separate processes', async () => {
    const arm: BenchmarkArm = {
      warmup: async () => {},
      run: async () => ({ ingress: 1, accepted: 2, dispatched: 3, terminal: 4, businessEvent: 5 }),
    };
    const protocol = { warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1,
      concurrencies: [1] as const, modes: ['warm'] as const };
    const perRep = await Promise.all([0, 1, 2].map((repetitionOffset) =>
      runPairedBenchmark({ control: arm, candidate: arm }, { ...protocol, repetitionOffset })));
    expect(perRep.map((trials) => trials.map((trial) => [trial.repetition, trial.arm]))).toEqual([
      [[0, 'control'], [0, 'candidate']],
      [[1, 'candidate'], [1, 'control']],
      [[2, 'control'], [2, 'candidate']],
    ]);
    await expect(runPairedBenchmark({ control: arm, candidate: arm }, { ...protocol, repetitionOffset: -1 }))
      .rejects.toThrow('repetitionOffset');
  });

  it('rejects invalid distributions and phase order instead of reporting plausible numbers', async () => {
    expect(() => distribution([])).toThrow('nonempty');
    expect(() => distribution([1, Number.NaN])).toThrow('finite');
    await expect(runPairedBenchmark({
      control: { warmup: async () => {}, run: async () => ({ ingress: 2, accepted: 1, dispatched: 3, terminal: 4, businessEvent: 5 }) },
      candidate: { warmup: async () => {}, run: async () => ({ ingress: 1, accepted: 2, dispatched: 3, terminal: 4, businessEvent: 5 }) },
    }, { warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1, 8] }))
      .rejects.toThrow('monotonic');
  });

  it('keeps a warm-only instrumentation pilot out of the cold cohort and full grade', async () => {
    const arm: BenchmarkArm = {
      warmup: async () => {},
      run: async () => ({ ingress: 1, accepted: 2, dispatched: 3, terminal: 4, businessEvent: 5 }),
    };
    const trials = await runPairedBenchmark({ control: arm, candidate: arm }, {
      warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1], modes: ['warm'],
    });
    expect(trials.map((trial) => trial.mode)).toEqual(['warm', 'warm']);
    expect(() => gradePairedBenchmark('A', trials)).toThrow('incomplete');
    await expect(runPairedBenchmark({ control: arm, candidate: arm }, {
      warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1],
    })).rejects.toThrow('fresh-runtime boundary');
  });

  it('closes a cold runtime when the request fails', async () => {
    const calls: string[] = [];
    const failing: BenchmarkArm = {
      warmup: async () => {},
      run: async () => ({ ingress: 1, accepted: 2, dispatched: 3, terminal: 4, businessEvent: 5 }),
      coldStart: async () => ({
        run: async () => { throw new Error('cold request failed'); },
        close: async () => { calls.push('closed'); },
      }),
    };
    await expect(runPairedBenchmark({ control: failing, candidate: failing }, {
      warmups: 0, repetitions: 1, warmSamples: 1, coldSamples: 1, concurrencies: [1], modes: ['cold'],
    })).rejects.toThrow('cold request failed');
    expect(calls).toEqual(['closed']);
  });

  it('uses the frozen A and D ceilings and rejects incomplete cohorts', () => {
    const trial = (arm: 'control' | 'candidate', mode: 'warm' | 'cold', concurrency: 1 | 8,
      repetition: number): Trial => ({
      arm, mode, concurrency, repetition, samples: mode === 'warm' ? 200 : 50,
      wallMs: 1000, throughputPerSec: arm === 'control' ? 100 : 70,
      phasesMs: Object.fromEntries(['ingressToAccepted', 'acceptedToDispatch', 'dispatchToTerminal',
        'terminalToBusinessEvent', 'total'].map((phase) => [phase,
        { count: mode === 'warm' ? 200 : 50, p50: arm === 'control' ? 100 : 160,
          p95: arm === 'control' ? 100 : 160, p99: arm === 'control' ? 100 : 160 }])) as Trial['phasesMs'],
      persistence: { dbRoundTrips: null, dbBytes: null, durableSteps: null },
    });
    const trials = ([1, 8] as const).flatMap((concurrency) =>
      Array.from({ length: 5 }, (_, repetition) =>
        (['warm', 'cold'] as const).flatMap((mode) =>
          (['control', 'candidate'] as const).map((arm) => trial(arm, mode, concurrency, repetition))))).flat();
    const a = gradePairedBenchmark('A', trials);
    expect(a.find((check) => check.metric === 'warmP50' && check.concurrency === 1))
      .toMatchObject({ limit: 130, passed: false });
    expect(a.find((check) => check.metric === 'throughput8'))
      .toMatchObject({ limit: 80, passed: false });
    const d = gradePairedBenchmark('D', trials);
    expect(d.find((check) => check.metric === 'warmP50' && check.concurrency === 1))
      .toMatchObject({ limit: 200, passed: true });
    expect(d.find((check) => check.metric === 'throughput8'))
      .toMatchObject({ limit: 65, passed: true });
    expect(() => gradePairedBenchmark('A', trials.slice(1))).toThrow('incomplete');
  });
});
