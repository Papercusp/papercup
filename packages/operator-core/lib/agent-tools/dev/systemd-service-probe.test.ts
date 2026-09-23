/**
 * systemd-service-probe.test.ts — pure-helper coverage for EI-18700974567040702.
 *
 * `probeServiceStart` itself shells out via a promisified `child_process.execFile`
 * (Node's `execFile` carries a bespoke `util.promisify.custom` implementation that
 * returns `{ stdout, stderr }` rather than the single-value generic-callback shape —
 * a plain `vi.mock('node:child_process', ...)` would need to replicate that exactly
 * to survive `promisify()`, which is fragile and tests the mock more than the code).
 * The two things that actually needed a regression test — the `.timer` unit-name
 * mangling bug, and the KEY=VALUE parse that must tell "absent" from "empty" apart —
 * are both PURE and exported for exactly this reason. Full async behavior was also
 * manually verified against the REAL systemd on this box (see the doc comment on
 * `resolveUnitName` below for the exact commands + output that found the bug).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSidecarFallbackStats, resetSidecarFallbackStatsForTest } from '../../fleet/git-via-sidecar';
import {
  type ServiceStartInfo,
  execProbeCommand,
  parseMultiUnitShowOutput,
  parseSystemctlShowOutput,
  probeSystemdDaemonReloadNeed,
  probeServiceStart,
  probeUnitStates,
  resolveServiceStartMs,
  resolveUnitName,
  unitStateFromProps,
} from './systemd-service-probe';

describe('resolveUnitName (EI-18700974567040702: the .timer mangling bug)', () => {
  it('passes a bare service unit through unchanged (no suffix to add)', () => {
    expect(resolveUnitName('papercup-bg-host.service')).toBe('papercup-bg-host.service');
  });

  it('appends .service to a bare name with no recognized unit-type suffix', () => {
    expect(resolveUnitName('papercup-bg-host')).toBe('papercup-bg-host.service');
  });

  // THE bug: the old rule was "append .service unless it already ends in .service",
  // which mangled a real registry entry (papercup-live-federation-gate.timer) into a
  // unit that does not exist. Verified against the real system on this box:
  //   $ systemctl --user show -p MainPID --value papercup-live-federation-gate.timer.service
  //   0            # <- silently "successful", MainPID 0, for a unit that was never real
  //   $ systemctl --user show -p MainPID -p ActiveState --value papercup-live-federation-gate.timer
  //   active       # <- the REAL timer, one line only — no MainPID line at all
  it('does NOT mangle a .timer unit into <name>.timer.service', () => {
    expect(resolveUnitName('papercup-live-federation-gate.timer')).toBe('papercup-live-federation-gate.timer');
  });

  it('leaves every other recognized systemd unit-type suffix untouched too', () => {
    for (const suffix of ['socket', 'device', 'mount', 'automount', 'swap', 'target', 'path', 'slice', 'scope']) {
      expect(resolveUnitName(`some-unit.${suffix}`)).toBe(`some-unit.${suffix}`);
    }
  });
});

describe('parseSystemctlShowOutput (EI-18700974567040702)', () => {
  it('parses multiple KEY=VALUE lines into a map', () => {
    const props = parseSystemctlShowOutput('MainPID=4164177\nActiveState=active\n');
    expect(props.get('MainPID')).toBe('4164177');
    expect(props.get('ActiveState')).toBe('active');
  });

  // The exact real-system shape that motivated the fix: a `.timer` unit's `systemctl
  // show -p MainPID -p ActiveState` OMITS the MainPID line entirely rather than
  // printing it empty — verified live: `systemctl --user show -p MainPID -p ActiveState
  // papercup-live-federation-gate.timer` → just `ActiveState=active`, one line.
  it('a property OMITTED from the output (e.g. MainPID on a .timer) is absent, not an empty string', () => {
    const props = parseSystemctlShowOutput('ActiveState=active\n');
    expect(props.has('MainPID')).toBe(false);
    expect(props.get('MainPID')).toBeUndefined();
    expect(props.get('ActiveState')).toBe('active');
  });

  it('a value that is itself empty (systemd DOES emit KEY= for some properties) parses as an empty string, not absent', () => {
    const props = parseSystemctlShowOutput('MainPID=\nActiveState=active\n');
    expect(props.has('MainPID')).toBe(true);
    expect(props.get('MainPID')).toBe('');
  });

  it('ignores lines with no `=` (defensive — real systemctl output never has one, but stay honest)', () => {
    const props = parseSystemctlShowOutput('not-a-key-value-line\nActiveState=active\n');
    expect(props.get('ActiveState')).toBe('active');
    expect(props.size).toBe(1);
  });

  it('empty input parses to an empty map', () => {
    expect(parseSystemctlShowOutput('').size).toBe(0);
  });
});

describe('probeSystemdDaemonReloadNeed', () => {
  it('reads systemd NeedDaemonReload for the requested unit', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const need = await probeSystemdDaemonReloadNeed('papercup-staging-api', async (command, args) => {
      calls.push({ command, args });
      return { stdout: 'NeedDaemonReload=yes\n' };
    });

    expect(calls).toEqual([
      {
        command: 'systemctl',
        args: ['--user', 'show', '-p', 'NeedDaemonReload', 'papercup-staging-api.service'],
      },
    ]);
    expect(need).toBe('needed');
  });

  it('skips a global reload when systemd says the unit definition is current', async () => {
    await expect(
      probeSystemdDaemonReloadNeed('papercup-staging-api.service', async () => ({ stdout: 'NeedDaemonReload=no\n' })),
    ).resolves.toBe('not-needed');
  });

  it('returns unknown, never a false no-reload reading, when the property is absent or the probe fails', async () => {
    await expect(
      probeSystemdDaemonReloadNeed('papercup-staging-api.service', async () => ({ stdout: 'LoadState=loaded\n' })),
    ).resolves.toBe('unknown');
    await expect(
      probeSystemdDaemonReloadNeed('papercup-staging-api.service', async () => {
        throw new Error('systemctl unavailable');
      }),
    ).resolves.toBe('unknown');
  });
});

describe('probeServiceStart LoadState guard (EI-210532)', () => {
  it('requests LoadState and preserves not-found as known:false', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const info = await probeServiceStart('papercup-oddsmith-sidecar', async (command, args) => {
      calls.push({ command, args });
      return {
        stdout:
          'Id=papercup-oddsmith-sidecar.service\n' +
          'LoadState=not-found\n' +
          'ActiveState=inactive\n' +
          'MainPID=0\n' +
          'NRestarts=0\n',
      };
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('systemctl');
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', 'LoadState']));
    expect(info).toMatchObject({
      ok: true,
      activeState: 'inactive',
      loadState: 'not-found',
      known: false,
      mainPid: 0,
    });
  });

  it('preserves UnitFileState so a disabled timer is distinguishable from an enabled stopped timer', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const info = await probeServiceStart('papercup-live-federation-gate.timer', async (command, args) => {
      calls.push({ command, args });
      return {
        stdout:
          'Id=papercup-live-federation-gate.timer\n' +
          'LoadState=loaded\n' +
          'UnitFileState=disabled\n' +
          'ActiveState=inactive\n',
      };
    });

    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', 'UnitFileState']));
    expect(info).toMatchObject({
      ok: true,
      activeState: 'inactive',
      loadState: 'loaded',
      known: true,
      unitFileState: 'disabled',
    });
  });

  it('preserves Result=start-limit-hit so callers can clear systemd\'s restart latch', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const info = await probeServiceStart('papercup-staging-api.service', async (command, args) => {
      calls.push({ command, args });
      return {
        stdout:
          'Id=papercup-staging-api.service\n' +
          'LoadState=loaded\n' +
          'ActiveState=failed\n' +
          'Result=start-limit-hit\n' +
          'MainPID=0\n' +
          'NRestarts=6\n',
      };
    });

    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', 'Result']));
    expect(info).toMatchObject({
      ok: true,
      activeState: 'failed',
      loadState: 'loaded',
      known: true,
      mainPid: 0,
      nRestarts: 6,
      result: 'start-limit-hit',
    });
  });
});

/**
 * probeUnitStates — the P-014 (WI-6244) arbitrary-unit query.
 *
 * The exec seam is INJECTED here (unlike `probeServiceStart`, whose promisified
 * `execFile` shape makes a module mock fragile), so the whole async path is
 * covered without touching systemd. Every fixture below is REAL output captured
 * from this box while live-verifying the widening — see the P-014 notes on
 * `bash-substitution/pairs/service.ts`.
 */
describe('parseMultiUnitShowOutput (the blank-line framing)', () => {
  it('splits one block per unit and keeps them in order', () => {
    const blocks = parseMultiUnitShowOutput(
      'Id=a.service\nLoadState=loaded\n\nId=b.service\nLoadState=not-found\n',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].get('Id')).toBe('a.service');
    expect(blocks[1].get('LoadState')).toBe('not-found');
  });

  it('tolerates trailing whitespace between blocks (never emits an empty block)', () => {
    expect(parseMultiUnitShowOutput('Id=a.service\n\n   \n\nId=b.service\n')).toHaveLength(2);
  });

  it('empty output yields no blocks — never one phantom unit', () => {
    expect(parseMultiUnitShowOutput('')).toHaveLength(0);
  });
});

describe('unitStateFromProps', () => {
  /**
   * THE defect this whole capability exists to kill. Real captured output:
   * `systemctl --user show papercup-green-checkpoint.service` reports
   * LoadState=not-found AND ActiveState=inactive — byte-identical in
   * ActiveState to a real service that is simply stopped.
   */
  it('a not-found unit is known:false and NEVER active, despite ActiveState=inactive', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput(
        'Id=papercup-green-checkpoint.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n',
      ),
      'user',
      'papercup-green-checkpoint.service',
    );
    expect(s.known).toBe(false);
    expect(s.active).toBe(false);
    // The raw systemd read is PRESERVED — the point is that `known` disambiguates
    // it, not that the reading is hidden.
    expect(s.activeState).toBe('inactive');
  });

  it('a loaded, running unit is known + active', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput('Id=papercup-dev-api.service\nLoadState=loaded\nActiveState=active\nSubState=running\n'),
      'user',
      'x',
    );
    expect(s).toMatchObject({
      unit: 'papercup-dev-api.service',
      known: true,
      active: true,
      failed: false,
      subState: 'running',
    });
  });

  /** A timer-driven oneshot: inactive is its HEALTHY state, and it IS known. */
  it('a loaded-but-inactive oneshot is known:true, active:false — not the same as unknown', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput('Id=papercusp-db-backup.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n'),
      'user',
      'x',
    );
    expect(s.known).toBe(true);
    expect(s.active).toBe(false);
  });

  it('reports failed separately from active', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput('Id=x.service\nLoadState=loaded\nActiveState=failed\nSubState=failed\n'),
      'system',
      'x',
    );
    expect(s.failed).toBe(true);
    expect(s.active).toBe(false);
  });

  /**
   * EI-20093902925801178. systemd's own NRestarts is the only restart signal in
   * this payload that no sampling interval can miss — the reconciler's
   * `restartsLast10m` is written in `papercup-bg-host` and read in the operator
   * process, where it is always 0. These are REAL captured values: during the
   * 2026-08-10 crash-loop `papercup-staging-api` showed NRestarts=4 while the
   * health tool reported `restartsLast10m: 0, flapState: 'ok'`.
   */
  it('parses systemd NRestarts into nRestarts', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput(
        'Id=papercup-staging-api.service\nLoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=4\n',
      ),
      'user',
      'x',
    );
    expect(s.nRestarts).toBe(4);
  });

  /**
   * THE regression that matters, and the reason the field is optional rather
   * than defaulted: a unit TYPE with no main process (a `.timer`) omits the
   * property entirely. Defaulting an omitted counter to 0 would recreate the
   * exact bug this field was added to kill — absent evidence reading as evidence
   * of absence, i.e. "no data" wearing the shape of "zero restarts".
   */
  it('an ABSENT NRestarts leaves nRestarts undefined — never 0', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput(
        'Id=papercup-live-federation-gate.timer\nLoadState=loaded\nActiveState=active\nSubState=waiting\n',
      ),
      'user',
      'x',
    );
    expect(s.nRestarts).toBeUndefined();
    expect(s).not.toHaveProperty('nRestarts');
  });

  it('a zero NRestarts is preserved as 0 — a measured zero is NOT the same as absent', () => {
    const s = unitStateFromProps(
      parseSystemctlShowOutput('Id=x.service\nLoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\n'),
      'user',
      'x',
    );
    expect(s.nRestarts).toBe(0);
  });

  it('a malformed NRestarts is undefined rather than NaN or a coerced number', () => {
    for (const raw of ['', 'not-a-number', '-1', '2.5']) {
      const s = unitStateFromProps(
        parseSystemctlShowOutput(
          `Id=x.service\nLoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=${raw}\n`,
        ),
        'user',
        'x',
      );
      expect(s.nRestarts, `NRestarts=${JSON.stringify(raw)} must not produce a number`).toBeUndefined();
    }
  });
});

describe('probeUnitStates', () => {
  const stub =
    (byScope: Partial<Record<'user' | 'system', string>>) =>
    async (args: string[]): Promise<string> => {
      const scope = args[0] === '--user' ? 'user' : 'system';
      const out = byScope[scope];
      if (out === undefined) throw new Error('no such manager');
      return out;
    };

  it('appends .service to bare names before asking systemd', async () => {
    const seen: string[][] = [];
    await probeUnitStates(['papercup-dev-api'], 'user', async (args) => {
      seen.push(args);
      return 'Id=papercup-dev-api.service\nLoadState=loaded\nActiveState=active\n';
    });
    expect(seen[0]).toContain('papercup-dev-api.service');
    expect(seen[0][0]).toBe('--user');
  });

  it('does NOT mangle a .timer (the EI-18700974567040702 class, re-guarded here)', async () => {
    const seen: string[][] = [];
    await probeUnitStates(['papercup-live-federation-gate.timer'], 'user', async (args) => {
      seen.push(args);
      return 'Id=papercup-live-federation-gate.timer\nLoadState=loaded\nActiveState=active\n';
    });
    expect(seen[0]).toContain('papercup-live-federation-gate.timer');
    expect(seen[0].join(' ')).not.toContain('.timer.service');
  });

  it('issues ONE exec for a whole unit list (the multi-unit shape agents actually write)', async () => {
    let calls = 0;
    const r = await probeUnitStates(['papercup-dev-api', 'papercup-staging-api'], 'user', async () => {
      calls += 1;
      return 'Id=papercup-dev-api.service\nLoadState=loaded\nActiveState=active\n\nId=papercup-staging-api.service\nLoadState=loaded\nActiveState=active\n';
    });
    expect(calls).toBe(1);
    expect(r.states).toHaveLength(2);
    expect(r.unitsUnknown).toEqual([]);
  });

  it('reports a unit no scope has heard of in unitsUnknown', async () => {
    const r = await probeUnitStates(
      ['papercup-auto-deploy'],
      'user',
      async () => 'Id=papercup-auto-deploy.service\nLoadState=not-found\nActiveState=inactive\n',
    );
    expect(r.unitsUnknown).toEqual(['papercup-auto-deploy.service']);
  });

  /**
   * scope:'all' is WHY `unitsUnknown` is computed across scopes rather than per
   * scope: `auditd` is not-found under --user and loaded under --system (verified
   * live). Calling it unknown because ONE manager missed it would recreate
   * exactly the confusion the field exists to remove.
   */
  it('scope:"all" queries both managers, and unknown means unknown EVERYWHERE', async () => {
    const r = await probeUnitStates(
      ['auditd'],
      'all',
      stub({
        user: 'Id=auditd.service\nLoadState=not-found\nActiveState=inactive\n',
        system: 'Id=auditd.service\nLoadState=loaded\nActiveState=active\n',
      }),
    );
    expect(r.states.map((s) => s.scope)).toEqual(['user', 'system']);
    expect(r.unitsUnknown).toEqual([]);
    expect(r.states.find((s) => s.scope === 'system')?.active).toBe(true);
  });

  it('records a manager it could not reach instead of inventing states for it', async () => {
    const r = await probeUnitStates(
      ['auditd'],
      'all',
      stub({ system: 'Id=auditd.service\nLoadState=loaded\nActiveState=active\n' }),
    );
    expect(r.scopesUnavailable).toEqual(['user']);
    expect(r.states).toHaveLength(1);
    // Still found in the manager that DID answer, so not unknown.
    expect(r.unitsUnknown).toEqual([]);
  });
});

describe('resolveServiceStartMs (WI-10550: measured start beats a late-biased derivation)', () => {
  const NOW = 1_785_801_699_270;

  it('prefers the MEASURED /proc start over the etimes derivation when both are present', () => {
    const info: ServiceStartInfo = { ok: true, mainPid: 42, activeState: 'active', secondsSinceStart: 60, startedAtMs: 1_700_000_000_000 };
    expect(resolveServiceStartMs(info, NOW)).toEqual({ pid: 42, startedAtMs: 1_700_000_000_000 });
  });

  it('falls back to the etimes derivation when /proc could not answer', () => {
    const info: ServiceStartInfo = { ok: true, mainPid: 42, activeState: 'active', secondsSinceStart: 60 };
    expect(resolveServiceStartMs(info, NOW)).toEqual({ pid: 42, startedAtMs: NOW - 60_000 });
  });

  /**
   * THE POINT OF THE CHANGE, not merely a branch: the fallback's error has a
   * DIRECTION. Both of its error sources understate elapsed — `ps -o etimes=`
   * truncates to whole seconds, and `nowMs` is read after the probe's
   * subprocesses return — so the derived start lands LATER than the truth, and
   * they add rather than cancel.
   *
   * Modelled with real measurements from this host: a process that truly started
   * 60.8s ago reports etimes=60 (truncated), and nowMs is sampled 0.7s after the
   * sample instant. The derived start is then ~1.5s LATER than the truth. Where
   * that feeds `startedAtMs > codeAsOfMs`, a code change landing in that window
   * is wrongly reported as ALREADY RUNNING.
   */
  it('the derivation lands LATE, and the measured value is what removes the false-YES window', () => {
    const trueStart = NOW - 60_800; // truly 60.8s ago
    const codeChangedAt = trueStart + 700; // code changed 0.7s AFTER the process started

    const derivedOnly: ServiceStartInfo = { ok: true, mainPid: 42, activeState: 'active', secondsSinceStart: 60 };
    const derived = resolveServiceStartMs(derivedOnly, NOW + 700)!.startedAtMs!;
    expect(derived).toBeGreaterThan(trueStart); // biased LATE, never early
    // ...and late enough to answer the detector's question WRONGLY:
    expect(derived > codeChangedAt).toBe(true); // "already running your code" — FALSE

    const measured = resolveServiceStartMs({ ...derivedOnly, startedAtMs: trueStart }, NOW + 700)!.startedAtMs!;
    expect(measured).toBe(trueStart);
    expect(measured > codeChangedAt).toBe(false); // correct: the code is NEWER than the process
  });

  it('degrades to UNKNOWN rather than a fabricated timestamp when neither source is available', () => {
    // a .timer: no MainPID concept at all, so nothing to measure
    expect(resolveServiceStartMs({ ok: true, activeState: 'active' }, NOW)).toBeNull();
    // MainPID 0: down, determinate, but no start to report
    expect(resolveServiceStartMs({ ok: true, mainPid: 0, activeState: 'inactive' }, NOW)).toBeNull();
    // probe failed outright
    expect(resolveServiceStartMs({ ok: false }, NOW)).toBeNull();
  });
});

// WI-10002709: the probe's systemctl/ps spawns run on the request operator's hot
// path; a local execFile from a ~2 GB :3070 worker blocks the loop ~240 ms per fork.
// On a sidecar host they go through the spawner sidecar, with execFile semantics
// preserved and a local fallback that never changes the probe's answer.
describe('execProbeCommand (WI-10002709: sidecar-first, execFile semantics)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetSidecarFallbackStatsForTest();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    resetSidecarFallbackStatsForTest();
  });

  const neverLocal = async (): Promise<{ stdout: string }> => {
    throw new Error('local spawn must not run');
  };

  it('routes through the sidecar when enabled and returns its stdout, without a local fork', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 0, stdout: 'MainPID=42\n', stderr: '' }));
    const out = await execProbeCommand('systemctl', ['--user', 'show'], 3000, {
      sidecarEnabled: () => true,
      viaSidecar,
      local: neverLocal,
    });
    expect(out).toEqual({ stdout: 'MainPID=42\n' });
    expect(viaSidecar).toHaveBeenCalledWith('systemctl', ['--user', 'show'], { timeoutMs: 3000 });
    expect(getSidecarFallbackStats().total).toBe(0);
  });

  it('rejects on a non-zero exit through the sidecar, exactly as execFile would (no local retry)', async () => {
    const local = vi.fn(async () => ({ stdout: 'should not be used' }));
    await expect(
      execProbeCommand('ps', ['-o', 'etimes=', '-p', '999999'], 3000, {
        sidecarEnabled: () => true,
        viaSidecar: async () => ({ code: 1, stdout: '', stderr: '' }),
        local,
      }),
    ).rejects.toThrow(/exited 1/);
    expect(local).not.toHaveBeenCalled();
  });

  it('falls back to a local spawn when the sidecar transport fails, and counts the fallback', async () => {
    const local = vi.fn(async () => ({ stdout: 'local-out' }));
    const out = await execProbeCommand('systemctl', ['--user', 'show'], 3000, {
      sidecarEnabled: () => true,
      viaSidecar: async () => {
        throw new Error('ECONNREFUSED');
      },
      local,
    });
    expect(out).toEqual({ stdout: 'local-out' });
    expect(local).toHaveBeenCalledWith('systemctl', ['--user', 'show'], { timeout: 3000 });
    expect(getSidecarFallbackStats().bySubsystem['systemd-service-probe']?.count).toBe(1);
  });

  it("falls back on the sidecar's OWN fault (admission failure) instead of reporting it as the child's answer", async () => {
    const local = vi.fn(async () => ({ stdout: 'local-out' }));
    const out = await execProbeCommand('systemctl', ['--user', 'show'], 3000, {
      sidecarEnabled: () => true,
      viaSidecar: async () => ({ code: -1, stdout: '', stderr: 'spawner sidecar admission failed: denied' }),
      local,
    });
    expect(out).toEqual({ stdout: 'local-out' });
    expect(getSidecarFallbackStats().bySubsystem['systemd-service-probe']?.lastReason).toMatch(/admission failed/);
  });

  it('uses the local spawn directly when the sidecar is not enabled (desktop / CLI / tests)', async () => {
    const viaSidecar = vi.fn(async () => ({ code: 0, stdout: 'x', stderr: '' }));
    const local = vi.fn(async () => ({ stdout: 'local-out' }));
    const out = await execProbeCommand('systemctl', ['--user', 'show'], 5000, {
      sidecarEnabled: () => false,
      viaSidecar,
      local,
    });
    expect(out).toEqual({ stdout: 'local-out' });
    expect(viaSidecar).not.toHaveBeenCalled();
    expect(getSidecarFallbackStats().total).toBe(0);
  });
});
