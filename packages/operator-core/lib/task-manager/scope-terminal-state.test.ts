import { describe, it, expect, vi } from 'vitest';
import { checkScopesReleased, type ExecFileFn } from './scope-terminal-state';

/** Build an ExecFileFn that returns one ActiveState line per unit, in order. */
function fakeExec(statesByUnit: Record<string, string>): ExecFileFn {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    // args = ['--user', 'show', '-p', 'ActiveState', '--value', ...units]
    const units = args.slice(5);
    const stdout = units.map((u) => statesByUnit[u] ?? '').join('\n') + '\n';
    return { stdout, stderr: '' };
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
});
