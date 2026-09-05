/**
 * WI-7329 — per-process memory pressure, and its integration into the health probe.
 *
 * The behaviour under test is a DIAGNOSTIC that rides on a failing health probe,
 * so the tests are weighted toward the two ways such a thing goes wrong: it
 * fabricates a verdict from a measurement it never took, or it perturbs the probe
 * it is attached to. Both are asserted directly.
 */
import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import {
  parseProcStatusMemory,
  parseProcStatMajorFaults,
  parsePsiMemoryFullAvg10,
  readProcessMemoryPressure,
  describeMemoryPressure,
  PSI_MEM_FULL_SEVERE_AVG10,
  type ProcessMemoryPressure,
} from './process-memory-pressure';
import { probeEndpoint } from './service-health';
import type { ListeningSocket } from './listening-sockets';

/**
 * Captured VERBATIM from this host so the fixtures cannot drift into a format
 * the kernel does not actually emit (note the tab after the colon, then a
 * variable run of spaces for right-alignment).
 */
const REAL_STATUS = 'VmPeak:\t 1266060 kB\nVmSize:\t 1266060 kB\nVmRSS:\t    7612 kB\nVmSwap:\t       0 kB\n';
const REAL_PSI =
  'some avg10=64.53 avg60=31.41 avg300=18.30 total=34520663414\nfull avg10=58.58 avg60=26.79 avg300=13.55 total=26331147630\n';

/** `<pid> (<comm>) <state> ...` — majflt is field 12. */
const statLine = (comm: string, majflt: number) =>
  `1234 (${comm}) S 1 1234 1 0 -1 4194304 95 0 ${majflt} 0 0 20 0 25 0 12345`;

describe('parseProcStatusMemory', () => {
  it('reads VmRSS and VmSwap from the real kernel format', () => {
    expect(parseProcStatusMemory(REAL_STATUS)).toEqual({ vmRssKb: 7612, vmSwapKb: 0 });
  });

  it('reads the measured incident shape — 9.5GB swapped against 4.2GB resident', () => {
    const incident = 'VmRSS:\t 4200000 kB\nVmSwap:\t 9476472 kB\n';
    expect(parseProcStatusMemory(incident)).toEqual({ vmRssKb: 4200000, vmSwapKb: 9476472 });
  });

  it('returns null per-field rather than 0 when a line is absent', () => {
    // A kernel without swap enabled omits VmSwap entirely. Reporting 0 there
    // would assert "nothing is swapped out" from a measurement never taken.
    expect(parseProcStatusMemory('VmRSS:\t 100 kB\n')).toEqual({ vmRssKb: 100, vmSwapKb: null });
    expect(parseProcStatusMemory('')).toEqual({ vmRssKb: null, vmSwapKb: null });
    expect(parseProcStatusMemory('garbage')).toEqual({ vmRssKb: null, vmSwapKb: null });
  });

  it('does not match a DIFFERENT field that merely starts the same way', () => {
    // VmRSS must not be satisfied by VmRSSAnon/VmSize etc.
    expect(parseProcStatusMemory('VmSize:\t 999 kB\n').vmRssKb).toBeNull();
  });
});

describe('parseProcStatMajorFaults', () => {
  /**
   * The deliberately-WRONG implementation, kept permanently as a control.
   *
   * Splitting the whole line on whitespace and taking index 11 is the obvious
   * reading of "majflt is field 12", and it is correct for every ordinary
   * process — which is exactly why the bug it causes is invisible. `comm` is
   * unescaped, so a name containing a space shifts every later field and this
   * returns a plausible but unrelated counter.
   */
  const naive = (raw: string): number | null => {
    const v = Number(raw.trim().split(/\s+/)[11]);
    return Number.isFinite(v) ? v : null;
  };

  it('reads majflt from a real /proc/<pid>/stat line', () => {
    expect(parseProcStatMajorFaults(statLine('node', 777))).toBe(777);
  });

  it('CALIBRATION: on an ordinary comm the naive control agrees — so the trap case below is meaningful', () => {
    // Without this the trap assertion could pass simply because `naive` is
    // broken for every input, which would prove nothing about the trap itself.
    const ordinary = statLine('node', 777);
    expect(naive(ordinary)).toBe(777);
    expect(parseProcStatMajorFaults(ordinary)).toBe(777);
  });

  it('TRAP: a comm containing spaces and parens shifts the naive parse but not this one', () => {
    const tricky = statLine('my weird) proc', 777);
    expect(parseProcStatMajorFaults(tricky)).toBe(777);
    // The control returns a plausible WRONG number rather than failing loudly —
    // the whole reason the last-`)` parse is used instead.
    expect(naive(tricky)).not.toBe(777);
  });

  it('handles the real captured line from this host', () => {
    expect(parseProcStatMajorFaults('3714362 (cut) R 3714005 3714362 3714005 0 -1 4194304 95 0 0 0 0')).toBe(0);
  });

  it('returns null on unparseable input rather than throwing or guessing', () => {
    expect(parseProcStatMajorFaults('')).toBeNull();
    expect(parseProcStatMajorFaults('no parens here')).toBeNull();
    expect(parseProcStatMajorFaults('1234 (node)')).toBeNull(); // truncated mid-read
  });
});

describe('parsePsiMemoryFullAvg10', () => {
  it('reads the FULL line, never the some line', () => {
    // The load-bearing assertion. `some` is much higher on any busy box (64.53
    // vs 58.58 in this real capture), so reading the wrong line would
    // manufacture severe-pressure verdicts out of ordinary load — a silent
    // wrong answer, not an error.
    expect(parsePsiMemoryFullAvg10(REAL_PSI)).toBe(58.58);
    expect(parsePsiMemoryFullAvg10(REAL_PSI)).not.toBe(64.53);
  });

  it('reads the measured incident value', () => {
    expect(parsePsiMemoryFullAvg10('some avg10=40.00 avg60=1 avg300=1 total=1\nfull avg10=15.51 avg60=1 avg300=1 total=1\n')).toBe(15.51);
  });

  it('returns null when the full line is absent (older kernels expose only some)', () => {
    expect(parsePsiMemoryFullAvg10('some avg10=1.00 avg60=1 avg300=1 total=1\n')).toBeNull();
    expect(parsePsiMemoryFullAvg10('')).toBeNull();
  });
});

describe('readProcessMemoryPressure', () => {
  /** A fake /proc where majflt advances between the two stat reads. */
  const fakeProc = (opts: {
    status?: string | null;
    majflt?: number[];
    psi?: string | null;
  }) => {
    const seq = [...(opts.majflt ?? [0, 0])];
    return async (path: string): Promise<string> => {
      if (path.endsWith('/status')) {
        if (opts.status === null) throw new Error('ENOENT');
        return opts.status ?? REAL_STATUS;
      }
      if (path.endsWith('/stat')) {
        const next = seq.shift();
        if (next === undefined) throw new Error('ESRCH');
        return statLine('node', next);
      }
      if (path === '/proc/pressure/memory') {
        if (opts.psi === null) throw new Error('ENOENT');
        return opts.psi ?? REAL_PSI;
      }
      throw new Error(`unexpected read ${path}`);
    };
  };
  const noSleep = async () => {};

  it('computes a major-fault DELTA across the sample window', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [1000, 1005] }),
      sleep: noSleep,
    });
    expect(p?.majorFaultDelta).toBe(5);
    expect(p?.majorFaults).toBe(1005); // the LATER cumulative sample
  });

  it('flags swapDominant + thrashing on the measured incident shape', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({
        status: 'VmRSS:\t 4200000 kB\nVmSwap:\t 9476472 kB\n',
        majflt: [1000, 1003],
        psi: 'some avg10=40.00 avg60=1 avg300=1 total=1\nfull avg10=15.51 avg60=1 avg300=1 total=1\n',
      }),
      sleep: noSleep,
    });
    expect(p?.swapDominant).toBe(true);
    expect(p?.thrashing).toBe(true);
    expect(p?.systemPsiMemFullAvg10).toBe(15.51);
  });

  it('CONTROL: a healthy process is neither swapDominant nor thrashing', async () => {
    // Without this pair the verdicts could be "true whenever a probe failed".
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [7, 7] }), // REAL_STATUS has VmSwap 0
      sleep: noSleep,
    });
    expect(p?.swapDominant).toBe(false);
    expect(p?.thrashing).toBe(false);
    expect(p?.majorFaultDelta).toBe(0);
  });

  it('does NOT call swap-with-no-faulting "thrashing" — idle swap costs nothing', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({
        status: 'VmRSS:\t 100 kB\nVmSwap:\t 900 kB\n',
        majflt: [500, 500], // paged out long ago, nobody has touched it since
      }),
      sleep: noSleep,
    });
    expect(p?.swapDominant).toBe(true);
    expect(p?.thrashing).toBe(false);
  });

  it('does NOT call faults-without-swap "thrashing" — that is ordinary demand paging', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [0, 40] }), // REAL_STATUS: VmSwap 0
      sleep: noSleep,
    });
    expect(p?.thrashing).toBe(false);
  });

  it('is FAIL-SOFT: an unreadable /proc/<pid>/status yields null, never a fabricated sample', async () => {
    await expect(
      readProcessMemoryPressure(1234, { readFile: fakeProc({ status: null }), sleep: noSleep }),
    ).resolves.toBeNull();
  });

  it('degrades to nulls — not to false-looking zeros — when only PART of /proc is readable', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [], psi: null }), // stat unreadable, psi unreadable
      sleep: noSleep,
    });
    expect(p).not.toBeNull();
    expect(p?.majorFaults).toBeNull();
    expect(p?.majorFaultDelta).toBeNull();
    expect(p?.systemPsiMemFullAvg10).toBeNull();
    // The verdicts must not become true off a measurement that never happened.
    expect(p?.thrashing).toBe(false);
  });

  it('survives the process EXITING mid-window (second stat read fails)', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [1000] }), // only one sample available
      sleep: noSleep,
    });
    expect(p?.majorFaults).toBe(1000);
    expect(p?.majorFaultDelta).toBeNull(); // undetermined, NOT 0
    expect(p?.thrashing).toBe(false);
  });

  it('clamps a negative delta (recycled pid) to 0 rather than reporting nonsense', async () => {
    const p = await readProcessMemoryPressure(1234, {
      readFile: fakeProc({ majflt: [9000, 3] }),
      sleep: noSleep,
    });
    expect(p?.majorFaultDelta).toBe(0);
  });

  it('rejects a nonsense pid without touching /proc', async () => {
    const boom = async () => {
      throw new Error('should not be read');
    };
    await expect(readProcessMemoryPressure(0, { readFile: boom })).resolves.toBeNull();
    await expect(readProcessMemoryPressure(-1, { readFile: boom })).resolves.toBeNull();
  });
});

describe('describeMemoryPressure', () => {
  const sample = (over: Partial<ProcessMemoryPressure> = {}): ProcessMemoryPressure => ({
    pid: 3129329,
    vmRssKb: 4200000,
    vmSwapKb: 9476472,
    majorFaults: 1003,
    majorFaultDelta: 3,
    sampleWindowMs: 500,
    systemPsiMemFullAvg10: 15.51,
    swapDominant: true,
    thrashing: true,
    ...over,
  });

  it('stays SILENT on a healthy sample', () => {
    // Appending "memory looks fine" to every failed probe would bury the signal
    // in exactly the case it exists to catch.
    expect(
      describeMemoryPressure(
        sample({ vmSwapKb: 0, swapDominant: false, thrashing: false, systemPsiMemFullAvg10: 0.1, majorFaultDelta: 0 }),
      ),
    ).toBeNull();
  });

  it('stays silent when there was no sample at all', () => {
    expect(describeMemoryPressure(null)).toBeNull();
  });

  it('names the swap/RSS inversion, the fault rate and the box-wide PSI', () => {
    const note = describeMemoryPressure(sample()) ?? '';
    expect(note).toContain('3129329');
    expect(note).toContain('MORE of it is in swap than in RAM');
    expect(note).toContain('3 major page fault');
    expect(note).toContain('15.51');
  });

  it('CORRECTS the "blocked event loop = code bug" reading — the point of the whole item', () => {
    // The wedge note this rides beside tells the reader to "find what is
    // blocking the loop". When the loop is stalled on major faults that sends
    // them hunting blameless application code, which is the several-minute
    // misdiagnosis WI-7329 exists to prevent.
    const note = describeMemoryPressure(sample()) ?? '';
    expect(note).toContain('not necessarily a code bug');
    expect(note).toMatch(/restart/i); // warns the restart will look like a fix
  });

  it('speaks up on severe box-wide PSI even when THIS process looks clean', () => {
    const note = describeMemoryPressure(
      sample({
        vmSwapKb: 0,
        swapDominant: false,
        thrashing: false,
        majorFaultDelta: 0,
        systemPsiMemFullAvg10: PSI_MEM_FULL_SEVERE_AVG10 + 1,
      }),
    );
    expect(note).toContain('severe memory pressure');
  });
});

/**
 * The integration point. A real socket that completes the TCP handshake and then
 * never answers — the only shape that reaches the failure path, because a CLOSED
 * port is refused at preflight and short-circuits before the fetch.
 */
describe('probeEndpoint memory-pressure leg', () => {
  async function silentListener(): Promise<{ port: number; close: () => Promise<void> }> {
    const open = new Set<net.Socket>();
    const srv = net.createServer((s) => {
      open.add(s);
      s.on('close', () => open.delete(s));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      port,
      close: async () => {
        for (const s of open) s.destroy();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      },
    };
  }

  const wedgedTable = (pid: number | null) => async () => ({
    sockets: [
      {
        port: 0,
        address: '127.0.0.1',
        family: 'ipv4' as const,
        pid,
        pids: pid === null ? [] : [pid],
        listeners: 1,
        command: 'node',
        ownerVisible: true,
        reserved: true,
        acceptQueue: { pending: 97, backlog: 511 },
      } as ListeningSocket,
    ],
  });

  const thrashing: ProcessMemoryPressure = {
    pid: 47585,
    vmRssKb: 4200000,
    vmSwapKb: 9476472,
    majorFaults: 1003,
    majorFaultDelta: 3,
    sampleWindowMs: 500,
    systemPsiMemFullAvg10: 15.51,
    swapDominant: true,
    thrashing: true,
  };

  it('attaches the sample and the corrective note to a WEDGED probe', async () => {
    const l = await silentListener();
    try {
      const res = await probeEndpoint(
        { name: 'test', url: `http://127.0.0.1:${l.port}/api/health`, timeoutMs: 150 },
        150,
        wedgedTable(47585),
        async () => thrashing,
      );
      expect(res.up).toBe(false);
      expect(res.wedged).toBe(true);
      expect(res.memoryPressure).toEqual(thrashing);
      // Both explanations survive: the accept queue is still the wedge
      // evidence, the memory note adds WHY the loop stalled.
      expect(res.note).toContain('WEDGED, not down');
      expect(res.note).toContain('not necessarily a code bug');
    } finally {
      await l.close();
    }
  });

  it('does NOT sample when no listener pid is readable — an ordinary outage pays nothing', async () => {
    const l = await silentListener();
    let sampled = 0;
    try {
      const res = await probeEndpoint(
        { name: 'test', url: `http://127.0.0.1:${l.port}/api/health`, timeoutMs: 150 },
        150,
        wedgedTable(null),
        async () => {
          sampled += 1;
          return thrashing;
        },
      );
      expect(sampled).toBe(0);
      expect(res.memoryPressure).toBeUndefined();
      expect(res.note).not.toContain('not necessarily a code bug');
    } finally {
      await l.close();
    }
  });

  it('is FAIL-SOFT: a throwing sampler must not break the probe it rides on', async () => {
    const l = await silentListener();
    try {
      // The diagnostic breaking the health probe would be the same class of
      // defect as the bug it diagnoses.
      const res = await probeEndpoint(
        { name: 'test', url: `http://127.0.0.1:${l.port}/api/health`, timeoutMs: 150 },
        150,
        wedgedTable(47585),
        async () => {
          throw new Error('/proc exploded');
        },
      ).catch((e: unknown) => e);
      expect(res).not.toBeInstanceOf(Error);
      expect((res as { up: boolean }).up).toBe(false);
    } finally {
      await l.close();
    }
  });

  it('never lets the diagnostic inflate the reported failure latency', async () => {
    const l = await silentListener();
    try {
      const res = await probeEndpoint(
        { name: 'test', url: `http://127.0.0.1:${l.port}/api/health`, timeoutMs: 120 },
        120,
        wedgedTable(47585),
        // A deliberately SLOW sampler. If latencyMs were captured after the
        // diagnostics, this 400ms would be folded into the reported latency and
        // a diagnostic would have corrupted the measurement it is attached to.
        async () => {
          await new Promise((r) => setTimeout(r, 400));
          return thrashing;
        },
      );
      expect(res.memoryPressure).toEqual(thrashing);
      expect(res.latencyMs).toBeLessThan(400);
    } finally {
      await l.close();
    }
  });
});
