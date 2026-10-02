/**
 * WI-10005713 — the raw test router's restricted-write preflight (scripts/lib/restricted-hold-preflight.mjs).
 * The census and reach walk are restricted-hold-fence.ts (tested there); this suite pins the PROCESS
 * contract: the router fails CLOSED on every result that is not an explicit, exit-coded admit, and
 * skips only the two documented duplicate-check cases.
 *
 * Lives in operator-core (like test-file-router.test.ts) so the gate's test:lane-pure selects it;
 * a test beside the module under scripts/lib runs only under the root config, which no gate task runs.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_HOLD_PREFLIGHT_CLI,
  RESTRICTED_HOLD_PREFLIGHT_DONE,
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  formatRestrictedHoldRefusal,
  interpretRestrictedHoldPreflight,
  restrictedHoldPreflightSkipReason,
  runRestrictedHoldPreflight,
} from '../../../../scripts/lib/restricted-hold-preflight.mjs';

const line = (payload: unknown) => `${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify(payload)}\n`;
const UNRESTRICTED_ENV = { PATH: '/usr/bin' };

describe('interpretRestrictedHoldPreflight — fail closed', () => {
  it('admits only an explicit admit verdict with the admit exit code', () => {
    expect(interpretRestrictedHoldPreflight({ status: 0, stdout: line({ verdict: 'admit' }) })).toEqual({ verdict: 'admit' });
  });

  it('passes a refusal through verbatim', () => {
    const refusal = { verdict: 'refuse', error: 'restricted_write_held', hint: 'tests/x.test.ts is itself a held restricted write' };
    expect(interpretRestrictedHoldPreflight({ status: RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse, stdout: line(refusal) })).toEqual(refusal);
  });

  it.each([
    ['no verdict line', { status: 0, stdout: 'some unrelated output\n' }],
    ['an empty stdout', { status: 0, stdout: '' }],
    ['an unparseable verdict', { status: 0, stdout: `${RESTRICTED_HOLD_PREFLIGHT_MARKER} {not json\n` }],
    ['an admit verdict with a non-admit exit', { status: 1, stdout: line({ verdict: 'admit' }) }],
    ['an unknown verdict', { status: 0, stdout: line({ verdict: 'maybe' }) }],
    ['a refusal missing its hint', { status: 3, stdout: line({ verdict: 'refuse', error: 'restricted_write_held' }) }],
    ['a kill signal', { status: null, signal: 'SIGTERM', stdout: '' }],
    ['a spawn error', { status: null, error: new Error('spawnSync node ETIMEDOUT'), stdout: '' }],
  ])('refuses as restricted_hold_state_unknown on %s', (_label, result) => {
    const verdict = interpretRestrictedHoldPreflight(result);
    expect(verdict.verdict).toBe('refuse');
    expect(verdict).toMatchObject({ error: 'restricted_hold_state_unknown' });
  });

  it('reads the LAST verdict line, so earlier noise cannot pose as the verdict', () => {
    const stdout = line({ verdict: 'admit' }) + line({ verdict: 'refuse', error: 'restricted_write_held', hint: 'held' });
    expect(interpretRestrictedHoldPreflight({ status: 3, stdout }).verdict).toBe('refuse');
  });
});

describe('restrictedHoldPreflightSkipReason', () => {
  it('skips only when testing:run already admitted the files, or when nested inside vitest', () => {
    expect(restrictedHoldPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_DONE })).toBe('testing-run');
    expect(restrictedHoldPreflightSkipReason({ VITEST: 'true' })).toBe('nested-in-vitest');
    expect(restrictedHoldPreflightSkipReason(UNRESTRICTED_ENV)).toBeNull();
  });

  it('does not treat an arbitrary value of the marker as a testing:run admission', () => {
    expect(restrictedHoldPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: '1' })).toBeNull();
  });
});

describe('runRestrictedHoldPreflight', () => {
  it('spawns the operator-core CLI under tsx with the root and files, and interprets its verdict', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: line({ verdict: 'admit' }), stderr: '' }));
    const verdict = runRestrictedHoldPreflight({
      repoRoot: '/repo',
      files: ['/repo/a.test.ts', '/repo/b.test.ts'],
      env: UNRESTRICTED_ENV,
      spawn: spawn as never,
    });
    expect(verdict).toEqual({ verdict: 'admit' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: unknown }];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI, '/repo', '/repo/a.test.ts', '/repo/b.test.ts']);
    expect(options).toMatchObject({ cwd: '/repo', env: UNRESTRICTED_ENV });
  });

  it('never spawns when skipping, and says why', () => {
    const spawn = vi.fn();
    expect(
      runRestrictedHoldPreflight({ repoRoot: '/repo', files: [], env: { VITEST: 'true' }, spawn: spawn as never }),
    ).toEqual({ verdict: 'skipped', reason: 'nested-in-vitest' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves the CLI to a real file in this repo, independent of the checked root', () => {
    expect(existsSync(RESTRICTED_HOLD_PREFLIGHT_CLI)).toBe(true);
  });
});

it('formats a refusal as one greppable line that says nothing was measured', () => {
  expect(formatRestrictedHoldRefusal({ error: 'restricted_write_held', hint: 'x is held' })).toBe(
    'TEST_FILE_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none x is held',
  );
});
