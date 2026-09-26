import { describe, it, expect, vi } from 'vitest';
import {
  checkScopesReleased,
  inspectTaskUnitTerminals,
  parseActiveStateValues,
  parseTaskUnitTerminalSnapshots,
  resetFailedTaskUnit,
  scanStaleFailedTaskUnitTerminals,
  type ExecFileFn,
} from './scope-terminal-state';

/**
 * Build an ExecFileFn returning systemd's REAL output shape.
 *
 * ⚠ WI-38163 — this helper previously joined with '\n' (one line per unit), which
 * systemd does NOT emit for multiple operands: it separates per-unit blocks with a
 * BLANK line, so N units produce 2N-1 lines. Every multi-unit test therefore passed
 * against a fiction while the production guard bailed out on every real call, and
 * D-018's stranded/ended_unobserved split never fired for 2+ candidates.
 *
 * Captured verbatim from this box (systemd --user):
 *   $ systemctl --user show -p ActiveState --value pc-fakeaaa.scope pc-fakebbb.scope
 *   inactive
 *   <blank>
 *   inactive
 */
function fakeExec(statesByUnit: Record<string, string>): ExecFileFn {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    // args = ['--user', 'show', '-p', 'ActiveState', '--value', ...units]
    const units = args.slice(5);
    const stdout = units.map((u) => statesByUnit[u] ?? '').join('\n\n') + '\n';
    return { stdout, stderr: '' };
  });
}

/** The one-line-per-unit shape — what a single operand really returns, and what a
 *  future systemd could emit for several. Still accepted by design. */
function fakeExecUnseparated(statesByUnit: Record<string, string>): ExecFileFn {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    const units = args.slice(5);
    return { stdout: units.map((u) => statesByUnit[u] ?? '').join('\n') + '\n', stderr: '' };
  });
}

describe('checkScopesReleased', () => {
  it('returns empty immediately for an empty unit list — never calls execFn', async () => {
    const exec = vi.fn();
    const released = await checkScopesReleased([], exec as unknown as ExecFileFn);
    expect(released.size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it('an active scope is NOT released', async () => {
    const exec = fakeExec({ 'pc-aaa.scope': 'active' });
    const released = await checkScopesReleased(['pc-aaa.scope'], exec);
    expect(released.has('pc-aaa.scope')).toBe(false);
  });

  it('activating/reloading/deactivating are all still "alive" — not released', async () => {
    const exec = fakeExec({
      'pc-a.scope': 'activating',
      'pc-b.scope': 'reloading',
      'pc-c.scope': 'deactivating',
    });
    const released = await checkScopesReleased(['pc-a.scope', 'pc-b.scope', 'pc-c.scope'], exec);
    expect(released.size).toBe(0);
  });

  it('inactive means released', async () => {
    const exec = fakeExec({ 'pc-bbb.scope': 'inactive' });
    const released = await checkScopesReleased(['pc-bbb.scope'], exec);
    expect(released.has('pc-bbb.scope')).toBe(true);
  });

  it('failed means released too — a crashed scope still emptied its cgroup', async () => {
    const exec = fakeExec({ 'pc-ccc.scope': 'failed' });
    const released = await checkScopesReleased(['pc-ccc.scope'], exec);
    expect(released.has('pc-ccc.scope')).toBe(true);
  });

  it('a garbage-collected unit (systemd reports empty/unknown) counts as NOT confirmed', async () => {
    // An empty ActiveState value (systemd printed a blank line for an unrecognized
    // unit on some versions) must not be treated as "confirmed released" — the
    // guard explicitly requires state.length > 0 before adding it.
    const exec = fakeExec({ 'pc-ddd.scope': '' });
    const released = await checkScopesReleased(['pc-ddd.scope'], exec);
    expect(released.has('pc-ddd.scope')).toBe(false);
  });

  it('batches multiple units in one call, matching state to unit by position', async () => {
    const exec = fakeExec({
      'pc-live.scope': 'active',
      'pc-dead1.scope': 'inactive',
      'pc-dead2.scope': 'failed',
    });
    const released = await checkScopesReleased(['pc-live.scope', 'pc-dead1.scope', 'pc-dead2.scope'], exec);
    expect(released).toEqual(new Set(['pc-dead1.scope', 'pc-dead2.scope']));
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('fails soft to an empty set when the line count does not match the unit count', async () => {
    // A systemd whose output shape changed must degrade to "nothing confirmed",
    // never to a misaligned unit<->state pairing that could mislabel a LIVE scope
    // as released.
    const exec = vi.fn(async () => ({ stdout: 'inactive\n', stderr: '' })); // 1 line, 2 units requested
    const released = await checkScopesReleased(['pc-a.scope', 'pc-b.scope'], exec as unknown as ExecFileFn);
    expect(released.size).toBe(0);
  });

  it('fails soft to an empty set when execFn throws (no systemctl / no bus / timeout)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('spawn systemctl ENOENT');
    });
    const released = await checkScopesReleased(['pc-a.scope'], exec as unknown as ExecFileFn);
    expect(released.size).toBe(0);
  });

  it('never fabricates a release for a scope it was not asked about', async () => {
    const exec = fakeExec({ 'pc-a.scope': 'inactive', 'pc-b.scope': 'inactive' });
    const released = await checkScopesReleased(['pc-a.scope'], exec);
    expect(released.has('pc-b.scope')).toBe(false);
  });

  // ── WI-38163: the blank-line separator regression ────────────────────────────
  //
  // These pin the ACTUAL systemd output shape. Against the pre-fix implementation
  // (which asserted one line per unit and bailed on a count mismatch) every one of
  // them fails with an empty set — which is exactly what shipped, and why ~74% of
  // routine sidecar shutdowns were filed as escapes.

  it('WI-38163: a real blank-line-separated batch still resolves every unit', async () => {
    // Verbatim shape: 'active\n\ninactive\n\nfailed\n' — 5 lines for 3 units.
    const exec = fakeExec({
      'pc-live.scope': 'active',
      'pc-dead1.scope': 'inactive',
      'pc-dead2.scope': 'failed',
    });
    const released = await checkScopesReleased(['pc-live.scope', 'pc-dead1.scope', 'pc-dead2.scope'], exec);
    expect(released).toEqual(new Set(['pc-dead1.scope', 'pc-dead2.scope']));
  });

  it('WI-38163: the one-line-per-unit shape is still accepted', async () => {
    const exec = fakeExecUnseparated({ 'pc-a.scope': 'active', 'pc-b.scope': 'inactive' });
    const released = await checkScopesReleased(['pc-a.scope', 'pc-b.scope'], exec);
    expect(released).toEqual(new Set(['pc-b.scope']));
  });
});

describe('parseActiveStateValues (WI-38163)', () => {
  it('parses the blank-separated shape systemd actually emits: N units -> 2N-1 lines', () => {
    expect(parseActiveStateValues('active\n\ninactive\n\nfailed\n', 3)).toEqual(['active', 'inactive', 'failed']);
    expect(parseActiveStateValues('inactive\n\ninactive\n', 2)).toEqual(['inactive', 'inactive']);
  });

  it('parses the one-line-per-unit shape, including the N=1 case', () => {
    expect(parseActiveStateValues('active\n', 1)).toEqual(['active']);
    expect(parseActiveStateValues('active\ninactive\n', 2)).toEqual(['active', 'inactive']);
  });

  it('preserves ORDER — the unit<->state pairing is positional', () => {
    expect(parseActiveStateValues('a\n\nb\n\nc\n\nd\n', 4)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns null (fail soft) when the shape is unrecognised', () => {
    expect(parseActiveStateValues('inactive\n', 2)).toBeNull(); // too few
    expect(parseActiveStateValues('a\nb\nc\nd\n', 3)).toBeNull(); // 4 lines, neither N nor 2N-1
    expect(parseActiveStateValues('', 1)).toBeNull(); // no output at all
    expect(parseActiveStateValues('a\n', 0)).toBeNull(); // no units requested
  });

  it('returns null when an expected separator slot is NOT blank', () => {
    // 2N-1 lines but the odd slot carries a value — the length coincidence must not
    // be enough to claim alignment, or a real state would be silently dropped.
    expect(parseActiveStateValues('active\nnot-a-separator\ninactive\n', 2)).toBeNull();
  });

  it('an empty ActiveState value survives parsing and is rejected downstream, not here', () => {
    // Parsing keeps the blank; checkScopesReleased is what refuses to treat a blank
    // as "confirmed released" (state.length > 0). Keeping that split means an
    // unknown unit cannot silently shift its NEIGHBOURS' states by one position.
    expect(parseActiveStateValues('\n\ninactive\n', 2)).toEqual(['', 'inactive']);
  });

  // ── Falsifiability control ───────────────────────────────────────────────────
  //
  // The repo's tier-1 pattern: keep the deliberately-wrong implementation HERE, as a
  // permanent control, instead of mutating the shared tree to prove the guard can
  // fail (a mutation probe races git-sync's whole-tree sweep and has committed a
  // mutant before). This is verbatim the pre-WI-38163 parse.
  const BUGGY_LEGACY_PARSE = (stdout: string, unitCount: number): string[] | null => {
    const lines = stdout.split('\n');
    const values = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return values.length !== unitCount ? null : values;
  };

  it('CONTROL: the pre-fix parse returns null on the shape systemd really emits', () => {
    // This is the whole bug, pinned. 2 units -> 3 lines -> the old count check
    // rejects it -> empty released set -> every candidate strands.
    expect(BUGGY_LEGACY_PARSE('inactive\n\ninactive\n', 2)).toBeNull();
    expect(BUGGY_LEGACY_PARSE('active\n\ninactive\n\nfailed\n', 3)).toBeNull();

    // ...while the current parse handles exactly those inputs. If this pair ever
    // agrees, the fix has been reverted.
    expect(parseActiveStateValues('inactive\n\ninactive\n', 2)).not.toBeNull();
    expect(parseActiveStateValues('active\n\ninactive\n\nfailed\n', 3)).not.toBeNull();
  });

  it('CONTROL: both parses agree on N=1, which is why the bug hid for so long', () => {
    // A single operand emits no separator, so the old code was correct for N=1 —
    // and a tick with exactly one candidate is what produced the 258 rows that DID
    // get classified `ended_unobserved`.
    expect(BUGGY_LEGACY_PARSE('inactive\n', 1)).toEqual(['inactive']);
    expect(parseActiveStateValues('inactive\n', 1)).toEqual(['inactive']);
  });
});

describe('stale failed task-unit discovery (EI-24354227978007755)', () => {
  const terminalBlock = (unit: string, inactiveAtUsec: number, activeState = 'failed') =>
    [
      'Result=exit-code',
      'ExecMainCode=1',
      'ExecMainStatus=3',
      'ControlGroup=',
      'MemoryPeak=4096',
      'MemoryMax=infinity',
      `Id=${unit}`,
      'LoadState=loaded',
      `ActiveState=${activeState}`,
      `InactiveEnterTimestampMonotonic=${inactiveAtUsec}`,
      `InvocationID=invocation-${unit}`,
    ].join('\n');

  function failedUnitExec(input: {
    units: string[];
    inactiveAtUsec: Record<string, number>;
    activeState?: Record<string, string>;
  }): ExecFileFn {
    return vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('list-units')) {
        return {
          // A command/description may itself mention a unit-looking token. Only
          // list-units' first column is the unit identity.
          stdout:
            input.units.map((unit) => `${unit} loaded failed failed sample pc-9999look.service`).join('\n') +
            '\n',
          stderr: '',
        };
      }
      const units = args.slice(4);
      return {
        stdout:
          units
            .map((unit) => terminalBlock(unit, input.inactiveAtUsec[unit] ?? 0, input.activeState?.[unit] ?? 'failed'))
            .join('\n\n') + '\n',
        stderr: '',
      };
    });
  }

  it('returns only old loaded failures and preserves their terminal evidence', async () => {
    const nowUsec = 10_000_000_000;
    const old = 'pc-0000old1.service';
    const young = 'pc-0000young.service';
    const recovered = 'pc-0000live1.service';
    const exec = failedUnitExec({
      units: [young, 'not-ours.service', recovered, old],
      inactiveAtUsec: {
        [old]: nowUsec - 2 * 60 * 60 * 1_000_000,
        [young]: nowUsec - 30 * 60 * 1_000_000,
        [recovered]: nowUsec - 2 * 60 * 60 * 1_000_000,
      },
      activeState: { [recovered]: 'inactive' },
    });

    const out = await scanStaleFailedTaskUnitTerminals({
      execFn: exec,
      minAgeMs: 60 * 60_000,
      nowMonotonicUsec: () => nowUsec,
      now: () => new Date('2026-09-26T20:00:00.000Z'),
    });

    expect(out).toMatchObject({ listed: 3, inspected: 3, truncated: false, nextCursor: 0 });
    expect(out.terminals).toEqual([
      expect.objectContaining({
        scopeUnit: old,
        capturedAt: '2026-09-26T20:00:00.000Z',
        activeState: 'failed',
        serviceResult: 'exit-code',
        execMainStatus: 3,
      }),
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('rotates a bounded property window so one uncollectable prefix cannot starve the tail', async () => {
    const units = ['pc-0000aaaa.service', 'pc-0000bbbb.service', 'pc-0000cccc.service'];
    const nowUsec = 20_000_000_000;
    const exec = failedUnitExec({
      units,
      inactiveAtUsec: Object.fromEntries(units.map((unit) => [unit, nowUsec - 2 * 60 * 60 * 1_000_000])),
    });

    const out = await scanStaleFailedTaskUnitTerminals({
      execFn: exec,
      limit: 2,
      cursor: 1,
      nowMonotonicUsec: () => nowUsec,
    });

    expect(out.terminals.map((terminal) => terminal.scopeUnit)).toEqual(units.slice(1));
    expect(out).toMatchObject({ listed: 3, inspected: 2, truncated: true, nextCursor: 0 });
  });

  it('fails closed when either systemctl read fails', async () => {
    const exec = vi.fn(async () => {
      throw new Error('user manager unavailable');
    });
    await expect(scanStaleFailedTaskUnitTerminals({ execFn: exec as unknown as ExecFileFn })).resolves.toEqual({
      terminals: [],
      listed: 0,
      inspected: 0,
      truncated: false,
      nextCursor: 0,
    });
  });
});

describe('P-012 terminal provenance', () => {
  const OOM_SHOW = [
    'Result=oom-kill',
    'ExecMainCode=2',
    'ExecMainStatus=9',
    'ControlGroup=',
    'MemoryPeak=33554432',
    'MemoryMax=33554432',
    'Id=pc-oom123.service',
    'LoadState=loaded',
    'ActiveState=failed',
    'InvocationID=19c08745790c46f9a337d563da055385',
  ].join('\n');

  it('parses a failed unit by Id and preserves its disappearing terminal facts', () => {
    const captured = parseTaskUnitTerminalSnapshots(
      `${OOM_SHOW}\n\nResult=success\nId=pc-gone123.scope\nLoadState=not-found\nActiveState=inactive\n`,
      ['pc-gone123.scope', 'pc-oom123.service'],
      '2026-08-24T16:00:00.000Z',
    );

    expect(captured.get('pc-oom123.service')).toEqual({
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit: 'pc-oom123.service',
      cgroupPath: null,
      invocationId: '19c08745790c46f9a337d563da055385',
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'oom-kill',
      execMainCode: 2,
      execMainStatus: 9,
      memoryMaxBytes: 33_554_432,
      peakMemoryBytes: 33_554_432,
      peakMemorySource: 'systemd',
    });
    // An unknown/collected unit may say Result=success and zero exit fields, but
    // those are defaults, not historical verdicts. Keep the release fact and
    // suppress every fabricated terminal field, not just Result.
    expect(captured.get('pc-gone123.scope')).toEqual({
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit: 'pc-gone123.scope',
      cgroupPath: null,
      invocationId: null,
      loadState: 'not-found',
      activeState: 'inactive',
      serviceResult: null,
      execMainCode: null,
      execMainStatus: null,
      memoryMaxBytes: null,
      peakMemoryBytes: null,
      peakMemorySource: 'unknown',
    });
  });

  it('reads all properties in one systemctl call and fails soft on command errors', async () => {
    // Declared with the real ExecFileFn parameter list so `exec.mock.calls[0][1]`
    // (the systemctl argv this test asserts on) is a typed tuple element rather
    // than an index into an empty tuple.
    const exec = vi.fn(async (_file: string, _args: readonly string[]) => ({
      stdout: `${OOM_SHOW}\n`,
      stderr: '',
    }));
    const captured = await inspectTaskUnitTerminals(
      ['pc-oom123.service'],
      exec as unknown as ExecFileFn,
      () => new Date('2026-08-24T16:00:00.000Z'),
    );
    expect(captured.get('pc-oom123.service')?.serviceResult).toBe('oom-kill');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['show', expect.stringMatching(/^--property=.*Result.*MemoryPeak/), 'pc-oom123.service']),
    );

    const broken = vi.fn(async () => {
      throw new Error('no user bus');
    });
    expect((await inspectTaskUnitTerminals(['pc-oom123.service'], broken as unknown as ExecFileFn)).size).toBe(0);
  });

  it('resets only a loaded failed task unit, after the caller has persisted it', async () => {
    const terminal = parseTaskUnitTerminalSnapshots(`${OOM_SHOW}\n`, ['pc-oom123.service']).get('pc-oom123.service')!;
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect(await resetFailedTaskUnit(terminal, exec as unknown as ExecFileFn)).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'reset-failed', 'pc-oom123.service'],
      expect.objectContaining({ timeout: 10_000 }),
    );

    expect(await resetFailedTaskUnit({ ...terminal, activeState: 'inactive' }, exec as unknown as ExecFileFn)).toBe(
      false,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
