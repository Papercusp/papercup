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
import { parseSystemctlShowOutput, resolveUnitName } from './systemd-service-probe';

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
