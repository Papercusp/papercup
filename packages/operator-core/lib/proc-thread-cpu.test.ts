import { describe, it, expect } from 'vitest';
import {
  parseProcStat,
  parseProcDirectoryFd,
  parseCpuPressureSomeAvg60,
  classifyThreadCpu,
  isConfirmedHostIoWait,
  isLikelySyncSubprocessBlock,
  isConfirmedCpuStarvation,
  USER_HZ,
} from './proc-thread-cpu';

/**
 * Post-')' tokens are [0]=state … [11]=utime [12]=stime, so this line carries
 * utime=500, stime=200 => 700 ticks.
 */
const STAT = '4242 (node) S 1 4242 4242 0 -1 4194560 12345 0 0 0 500 200 0 0 20 0 11 0 999';

describe('parseProcStat', () => {
  it('reads state and summed CPU ticks', () => {
    expect(parseProcStat(STAT)).toEqual({ state: 'S', ticks: 700 });
  });

  it('survives a comm containing spaces AND parentheses', () => {
    // The whole reason for splitting on the LAST ')' rather than whitespace: a
    // naive split mis-indexes every field after comm and silently returns a
    // plausible-looking wrong number.
    const nasty = '4242 (node (worker) thing) R 1 4242 4242 0 -1 4194560 1 0 0 0 900 100 0 0 20 0 11 0 999';
    expect(parseProcStat(nasty)).toEqual({ state: 'R', ticks: 1000 });
  });

  it('returns null (never a zero) on unparseable input', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('no parens here')).toBeNull();
    expect(parseProcStat('4242 (node) S 1 2 3')).toBeNull(); // too few fields
    expect(parseProcStat('4242 (node) S 1 4242 4242 0 -1 4194560 1 0 0 0 xx yy 0 0 20 0')).toBeNull();
  });
});

describe('parseProcDirectoryFd', () => {
  it('extracts getdents64 arg0 from the measured iterate_dir shape', () => {
    expect(
      parseProcDirectoryFd(
        '217 0x19 0x7f10a4001000 0x8000 0x0 0x0 0x0 0x7ffd01 0x7f10ff',
        'iterate_dir',
      ),
    ).toBe(25);
  });

  it('accepts the decimal argument rendering used by some kernels', () => {
    expect(parseProcDirectoryFd('217 7 4096 32768 0 0 0 0 0', 'iterate_dir')).toBe(7);
  });

  it.each([
    ['', 'iterate_dir'],
    ['running', 'iterate_dir'],
    ['217 nope 0x1', 'iterate_dir'],
    ['217 -1 0x1', 'iterate_dir'],
    ['217 0x19 0x1', 'ep_poll'],
    ['217 0x19 0x1', null],
  ])('returns null instead of inventing a directory fd (%s, %s)', (raw, wchan) => {
    expect(parseProcDirectoryFd(raw, wchan)).toBeNull();
  });
});

describe('parseCpuPressureSomeAvg60', () => {
  it('parses the kernel CPU PSI some avg60 percentage', () => {
    expect(
      parseCpuPressureSomeAvg60(
        'some avg10=96.00 avg60=85.25 avg300=42.00 total=12345\n',
      ),
    ).toBe(85.25);
  });

  it.each([
    '',
    'full avg10=0.00 avg60=0.00 avg300=0.00 total=0',
    'some avg10=1.00 avg300=2.00 total=3',
    'some avg10=1.00 avg60=NaN avg300=2.00 total=3',
    'some avg10=1.00 avg60=101.00 avg300=2.00 total=3',
  ])('returns null for unknown or invalid pressure (%s)', (raw) => {
    expect(parseCpuPressureSomeAvg60(raw)).toBeNull();
  });
});

describe('classifyThreadCpu', () => {
  const base = { elapsedMs: 1000, userHz: USER_HZ };

  it('calls a full core of CPU across the window SPINNING', () => {
    // 100 ticks @ 100Hz = 1000ms of CPU over a 1000ms window = 1.0 cores.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 100 });
    expect(v.kind).toBe('spinning');
    expect(v.cpuMs).toBe(1000);
    expect(v.cores).toBeCloseTo(1.0, 5);
    expect(v.suspectWrongSubject).toBe(false);
  });

  it('calls a thread that burned no CPU PARKED', () => {
    const v = classifyThreadCpu({ ...base, baselineTicks: 700, currentTicks: 700 });
    expect(v.kind).toBe('parked');
    expect(v.cpuMs).toBe(0);
    expect(v.cores).toBe(0);
  });

  it('calls an in-between reading PARTIAL rather than forcing a verdict', () => {
    // 20 ticks = 200ms over 1000ms = 0.2 cores: above parked, below spinning.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 20 });
    expect(v.kind).toBe('partial');
  });

  it('is UNKNOWN — not parked — when either sample is missing', () => {
    // The distinction this whole module exists for: an unreadable sample must
    // never render as 0 CPU, because 0 reads as "idle" and sends the next
    // investigation at the wrong subsystem.
    for (const opts of [
      { ...base, baselineTicks: null, currentTicks: 100 },
      { ...base, baselineTicks: 0, currentTicks: null },
      { ...base, baselineTicks: null, currentTicks: null },
    ]) {
      const v = classifyThreadCpu(opts);
      expect(v.kind).toBe('unknown');
      expect(v.cpuMs).toBeNull();
      expect(v.cores).toBeNull();
    }
  });

  it('is UNKNOWN when the window is zero/negative or the clock rate is bogus', () => {
    expect(classifyThreadCpu({ ...base, elapsedMs: 0, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
    expect(classifyThreadCpu({ ...base, elapsedMs: -5, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
    expect(classifyThreadCpu({ ...base, userHz: 0, baselineTicks: 0, currentTicks: 100 }).kind)
      .toBe('unknown');
  });

  it('is UNKNOWN when the counter went BACKWARDS (the thread was replaced)', () => {
    // A restarted process re-uses the pid with a fresh counter; differencing
    // across that boundary is not a measurement of anything.
    const v = classifyThreadCpu({ ...base, baselineTicks: 900, currentTicks: 100 });
    expect(v.kind).toBe('unknown');
    expect(v.cpuMs).toBeNull();
  });

  it('flags a reading that exceeds one thread as the WRONG SUBJECT', () => {
    // >1.5 cores is impossible for a single thread, so the sample almost
    // certainly came from the process-wide stat file (all threads summed).
    // Surfaced rather than swallowed: the number is not noise, it is about
    // something else, and silently reporting it is how "the main thread is
    // busy" gets concluded about a parked main thread with busy children.
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 400 });
    expect(v.suspectWrongSubject).toBe(true);
    expect(v.cores).toBeCloseTo(4.0, 5);
  });

  it('does not flag wrong-subject for a legitimately saturated single thread', () => {
    const v = classifyThreadCpu({ ...base, baselineTicks: 0, currentTicks: 100 });
    expect(v.suspectWrongSubject).toBe(false);
  });
});

describe('isConfirmedHostIoWait', () => {
  it('recognizes the recorded rq_qos_wait false-kill diagnostic', () => {
    expect(
      isConfirmedHostIoWait({
        state: 'D',
        cpuMs: 0,
        cores: 0,
        wchan: 'rq_qos_wait',
      }),
    ).toBe(true);
  });

  it('recognizes other storage wait channels from the incident evidence', () => {
    for (const wchan of ['io_schedule', 'io_schedule_timeout', 'wait_on_buffer', 'jbd2_log_wait_commit']) {
      expect(isConfirmedHostIoWait({ state: 'D', cpuMs: 0, cores: 0, wchan })).toBe(true);
    }
  });

  it('does not suppress the recorded spinning/futex wedge', () => {
    expect(
      isConfirmedHostIoWait({
        state: 'R',
        cpuMs: 910,
        cores: 0.91,
        wchan: 'futex_do_wait',
      }),
    ).toBe(false);
  });

  it.each([
    { state: 'D', cpuMs: 1, cores: 0, wchan: 'rq_qos_wait' },
    { state: 'S', cpuMs: 0, cores: 0, wchan: 'rq_qos_wait' },
    { state: 'D', cpuMs: 0, cores: 0, wchan: 'futex_do_wait' },
    { state: 'D', cpuMs: null, cores: null, wchan: 'rq_qos_wait' },
    { state: 'D', cpuMs: 0, cores: 0, wchan: null },
  ])('requires all host-I/O discriminator fields (%o)', (activity) => {
    expect(isConfirmedHostIoWait(activity)).toBe(false);
  });
});

describe('isLikelySyncSubprocessBlock', () => {
  /**
   * The exact field values the sentinel printed on the 2026-09-03 12:41:29
   * papercusp-bg-host kill. CALIBRATION CASE: if this ever stops being true the
   * suite below is passing vacuously, because every other case here is a
   * negative and negatives alone cannot tell a working predicate from one that
   * always returns false.
   */
  const MEASURED_BG_HOST_KILL = {
    state: 'S',
    cpuMs: 0,
    cores: 0,
    wchan: 'ep_poll',
  } as const;

  it('recognises the measured bg-host signature that twice read as "healthy idle"', () => {
    expect(isLikelySyncSubprocessBlock(MEASURED_BG_HOST_KILL)).toBe(true);
  });

  it.each(['ep_poll', 'do_epoll_wait', 'do_sys_poll', 'do_select', 'poll_schedule_timeout'])(
    'recognises loop-poll wait channel %s',
    (wchan) => {
      expect(isLikelySyncSubprocessBlock({ state: 'S', cpuMs: 0, cores: 0, wchan })).toBe(true);
    },
  );

  it.each([
    // Burning CPU: a synchronous JS loop / GC, not a subprocess wait.
    { state: 'S', cpuMs: 4200, cores: 0.9, wchan: 'ep_poll' },
    // D-state block I/O: the OTHER predicate's domain, and the only one that
    // may suppress a kill. These two must never both claim the same sample.
    { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
    // Runnable — not parked at all.
    { state: 'R', cpuMs: 0, cores: 0, wchan: 'ep_poll' },
    // Parked, but not in a loop poll: futex waits are a different failure.
    { state: 'S', cpuMs: 0, cores: 0, wchan: 'futex_wait_queue_me' },
    // Unreadable wchan is UNKNOWN, never a positive claim.
    { state: 'S', cpuMs: 0, cores: 0, wchan: null },
    // Unmeasured CPU must not be treated as zero.
    { state: 'S', cpuMs: null, cores: null, wchan: 'ep_poll' },
  ])('requires all sync-subprocess discriminator fields (%o)', (activity) => {
    expect(isLikelySyncSubprocessBlock(activity)).toBe(false);
  });

  it('never claims the same sample as the host-I/O-wait suppressor', () => {
    const samples = [
      MEASURED_BG_HOST_KILL,
      { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
      { state: 'D', cpuMs: 0, cores: 0, wchan: 'ep_poll' },
      { state: 'S', cpuMs: 0, cores: 0, wchan: 'io_schedule' },
    ];
    for (const s of samples) {
      expect(isLikelySyncSubprocessBlock(s) && isConfirmedHostIoWait(s)).toBe(false);
    }
  });

  /**
   * FALSIFIABILITY CONTROL. The tempting reading of the incident was "0 CPU
   * means the host is idle" — a predicate keyed on cpuMs alone. Run it beside
   * the shipped one to prove the `state`/`wchan` discriminators are
   * load-bearing rather than decoration: the naive one cannot tell a
   * block-I/O stall from a synchronous-subprocess block, which is exactly the
   * conflation that would misroute the next investigation.
   */
  it('is stricter than a naive cpu-only predicate (discriminators are load-bearing)', () => {
    const naiveCpuOnly = (a: { cpuMs: number | null }) => a.cpuMs === 0;
    const hostIoWait = { state: 'D', cpuMs: 0, cores: 0, wchan: 'io_schedule' };

    // The naive predicate cannot separate them; the shipped one does.
    expect(naiveCpuOnly(hostIoWait)).toBe(true);
    expect(naiveCpuOnly(MEASURED_BG_HOST_KILL)).toBe(true);
    expect(isLikelySyncSubprocessBlock(hostIoWait)).toBe(false);
    expect(isLikelySyncSubprocessBlock(MEASURED_BG_HOST_KILL)).toBe(true);
  });
});

describe('isConfirmedCpuStarvation', () => {
  const measuredStarvation = {
    cpuKind: 'spinning' as const,
    state: 'R',
    cpuMs: 15_800,
    cores: 0.99,
    wchan: null,
    cpuPsiSome60: 85,
  };

  it('recognizes the measured high-CPU host-starvation signature', () => {
    expect(isConfirmedCpuStarvation(measuredStarvation)).toBe(true);
  });

  it.each([
    { ...measuredStarvation, cpuPsiSome60: 84.99 },
    { ...measuredStarvation, cpuPsiSome60: null },
    { ...measuredStarvation, cpuKind: 'partial' as const },
    { ...measuredStarvation, state: 'S' },
    { ...measuredStarvation, cores: 1.51 },
  ])('requires every conservative discriminator (%o)', (activity) => {
    expect(isConfirmedCpuStarvation(activity)).toBe(false);
  });

  it('keeps an idle-host synchronous spin killable', () => {
    expect(
      isConfirmedCpuStarvation({
        ...measuredStarvation,
        cpuPsiSome60: 0.5,
      }),
    ).toBe(false);
  });
});
