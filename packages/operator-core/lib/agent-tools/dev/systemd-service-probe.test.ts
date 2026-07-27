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
import { describe, expect, it } from 'vitest';
import {
  parseMultiUnitShowOutput,
  parseSystemctlShowOutput,
  probeUnitStates,
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
    for (const suffix of ['socket', 'target', 'mount', 'path', 'slice']) {
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
