import { describe, expect, it } from 'vitest';
import {
  classifyScope,
  isConsoleWindowScope,
  isVerifierScope,
  isTerminalWindowScope,
  EXEMPT_REASON_LABEL,
  type ExemptReason,
} from './scope-class';
import { ALLOWLIST } from '../../../../scripts/check-no-unenrolled-detached-spawn.mjs';

const OUR_SLICE = '/user.slice/user-1000.slice/user@1000.service/papercusp.slice';
const APP_SLICE = '/user.slice/user-1000.slice/user@1000.service/app.slice';
const TERM_SLICE = `${APP_SLICE}/app-org.gnome.Terminal.slice`;

describe('classifyScope', () => {
  it('calls anything inside our slice owned, whatever the cgroup is named', () => {
    // `owned` must short-circuit: a process in our slice that happens to sit in a
    // `.service` leaf is still ours, and no exemption may take it away from us.
    expect(classifyScope(`${OUR_SLICE}/papercusp-bash.slice/pc-abc.scope`, true)).toEqual({
      scope: 'owned',
      exemptReason: null,
    });
    expect(classifyScope(`${OUR_SLICE}/something.service`, true).scope).toBe('owned');
  });

  it('exempts the owner’s terminal windows — the population that caused the false alarm', () => {
    // 157 vte scopes + 49 in the terminal server, measured live on this box.
    const vte = `${TERM_SLICE}/vte-spawn-d30b170a-4c58-4460-ad25-1073627f3ab8.scope`;
    expect(classifyScope(vte, false)).toEqual({ scope: 'exempt', exemptReason: 'human-terminal' });
    expect(classifyScope(`${TERM_SLICE}/gnome-terminal-server.service`, false)).toEqual({
      scope: 'exempt',
      exemptReason: 'human-terminal',
    });
  });

  it('prefers human-terminal over systemd-unit when a cgroup satisfies both', () => {
    // gnome-terminal-server.service is BOTH a .service and under the terminal
    // slice. Reason order is not cosmetic: "systemd unit" would hide the fact that
    // these processes belong to a window the owner opened.
    const both = `${TERM_SLICE}/gnome-terminal-server.service`;
    expect(classifyScope(both, false).exemptReason).toBe('human-terminal');
  });

  it('exempts systemd units — a different accountant, not an escape', () => {
    for (const unit of [
      'papercup-bg-host.service',
      'papercup-mcp-proxy.service',
      'papercup-inference-gateway.service',
      'papercup-green-checkpoint-manual-1fxzuva.service',
      // Exact auto-generated shape used by `systemd-run --user --scope` when no
      // --unit is supplied. The release checkpoint runs this way and was otherwise
      // shown as an escape even while the authoritative cgroup summary was clean.
      'run-rc174537f041445b2abda49f2c7c51e09.scope',
    ]) {
      expect(classifyScope(`${APP_SLICE}/${unit}`, false)).toEqual({
        scope: 'exempt',
        exemptReason: 'systemd-unit',
      });
    }
  });

  it('calls an unenrolled headless member UNACCOUNTED — this is the real gap', () => {
    // buildHeadlessSpawnCommand falls back to `papercup-headless-*` when it is
    // handed no taskScope, i.e. exactly the P-009 residue. A named application
    // scope is NOT systemd-run's auto-generated transient unit, which is why the
    // rule discriminates on the complete structural shape rather than `.scope`.
    const headless = `${APP_SLICE}/papercup-headless-bug-drain-member-2-10-781613-1785608783953.scope`;
    expect(classifyScope(headless, false)).toEqual({ scope: 'unaccounted', exemptReason: null });
  });

  it('does not let a papercup-* NAME buy an exemption', () => {
    // The whole point of discriminating structurally: a name list would have
    // exempted this alongside papercup-bg-host.service and hidden the gap.
    expect(classifyScope(`${APP_SLICE}/papercup-anything.scope`, false).scope).toBe('unaccounted');
    expect(classifyScope(`${APP_SLICE}/run-not-a-systemd-generated-unit.scope`, false).scope).toBe(
      'unaccounted',
    );
  });

  it('recognizes only the verifier-owned systemd scope family', () => {
    for (const unit of [
      'papercup-tauri-verify-90-3416089-openbox.scope',
      'papercup-tauri-verify-90-3416089-xvfb.scope',
      'papercup-tauri-verify-90-3416089-tauri-1.scope',
    ]) {
      expect(isVerifierScope(`${APP_SLICE}/${unit}`)).toBe(true);
      expect(classifyScope(`${APP_SLICE}/${unit}`, false)).toEqual({
        scope: 'exempt',
        exemptReason: 'systemd-unit',
      });
    }

    for (const unit of [
      'papercup-tauri-verify-90-3416089-shell.scope',
      'papercup-tauri-verify-90-openbox.scope',
      'papercup-tauri-verify-90-3416089-tauri.scope',
    ]) {
      expect(isVerifierScope(`${APP_SLICE}/${unit}`)).toBe(false);
      expect(classifyScope(`${APP_SLICE}/${unit}`, false).scope).toBe('unaccounted');
    }
  });

  it('never returns an exemptReason without exempt, or exempt without a reason', () => {
    const cases: [string, boolean][] = [
      [`${OUR_SLICE}/pc-a.scope`, true],
      [`${TERM_SLICE}/vte-spawn-1111-2222.scope`, false],
      [`${APP_SLICE}/x.service`, false],
      [`${APP_SLICE}/x.scope`, false],
      ['', false],
    ];
    for (const [path, owned] of cases) {
      const r = classifyScope(path, owned);
      expect(r.scope === 'exempt').toBe(r.exemptReason !== null);
    }
  });

  it('degrades an unrecognisable cgroup to unaccounted, not exempt', () => {
    // Over-reporting is the safe direction for an alarm: a shape we cannot explain
    // must not be quietly filed as "by design".
    expect(classifyScope('', false).scope).toBe('unaccounted');
    expect(classifyScope('/', false).scope).toBe('unaccounted');
  });

  it('withdraws the terminal exemption once the window is CLOSED', () => {
    // P-009. The scope outlives the window, so `vte-spawn-*` alone stopped being
    // evidence that a human is watching: 17 such scopes were holding 123 processes
    // on this box with nobody at the keyboard.
    const vte = `${TERM_SLICE}/vte-spawn-d30b170a-4c58-4460-ad25-1073627f3ab8.scope`;
    expect(classifyScope(vte, false, { terminalWindowAlive: true })).toEqual({
      scope: 'exempt',
      exemptReason: 'human-terminal',
    });
    // P-008/D-018: a closed window is its OWN class, not bare `unaccounted`. The
    // distinction is load-bearing for the pane — a human DID own this lifetime,
    // so it must not read as a chokepoint bypass, and must not read as exempt
    // either now that the owner is gone.
    expect(classifyScope(vte, false, { terminalWindowAlive: false })).toEqual({
      scope: 'abandoned-window',
      exemptReason: null,
    });
  });

  it('treats every not-a-positive-false as still exempt — unknown must never kill', () => {
    // The one asymmetry the reaper this feeds will depend on. `false` is the ONLY
    // value that withdraws the exemption; not-probed and could-not-tell do not.
    const vte = `${TERM_SLICE}/vte-spawn-1111-2222.scope`;
    for (const opts of [undefined, {}, { terminalWindowAlive: null }, { terminalWindowAlive: true }]) {
      expect(classifyScope(vte, false, opts).scope, JSON.stringify(opts)).toBe('exempt');
    }
  });

  it('never lets window liveness override ownership or reach a non-window cgroup', () => {
    // A dead window cannot take a process out of OUR slice, and the flag must not
    // leak onto the terminal application's own units — only a window has a window.
    expect(classifyScope(`${OUR_SLICE}/pc-a.scope`, true, { terminalWindowAlive: false }).scope).toBe(
      'owned',
    );
    expect(
      classifyScope(`${TERM_SLICE}/gnome-terminal-server.service`, false, {
        terminalWindowAlive: false,
      }),
    ).toEqual({ scope: 'exempt', exemptReason: 'human-terminal' });
  });

  it('isTerminalWindowScope names windows only, and accepts a bare leaf', () => {
    // The scan uses this to decide when a probe is worth doing; it is exported so
    // the vte naming rule has exactly one definition to keep in step.
    expect(isTerminalWindowScope('vte-spawn-d30b170a-4c58-4460-ad25-1073627f3ab8.scope')).toBe(true);
    expect(isTerminalWindowScope(`${TERM_SLICE}/vte-spawn-1111-2222.scope`)).toBe(true);
    expect(isTerminalWindowScope(`${TERM_SLICE}/gnome-terminal-server.service`)).toBe(false);
    expect(isTerminalWindowScope(`${APP_SLICE}/papercup-anything.scope`)).toBe(false);
    expect(isTerminalWindowScope('')).toBe(false);
  });

  it('gives every reason a human label, so the pane never invents one', () => {
    const reasons: ExemptReason[] = ['human-terminal', 'systemd-unit'];
    for (const r of reasons) {
      expect(EXEMPT_REASON_LABEL[r].label.length).toBeGreaterThan(0);
      expect(EXEMPT_REASON_LABEL[r].why.length).toBeGreaterThan(0);
    }
  });
});

describe('correspondence with the build-time spawn guard', () => {
  it('keeps the allowlist entries this classifier claims to mirror', () => {
    // These two authorities CANNOT be derived from each other — the guard keys on
    // source paths, this file on cgroups (see scope-class.ts). So the honest thing
    // to assert is that the entries cited in its docs still exist. If one is
    // renamed or removed, this fails and the citation gets re-checked by a human
    // rather than silently becoming fiction.
    for (const cited of [
      'packages/operator-core/lib/console-spawn.ts',
      'packages/operator-core/lib/terminal-spawn.ts',
      'packages/operator-core/lib/agent-tools/dev/restart.ts',
      'packages/operator-core/lib/harness/routines/release-actions.ts',
    ]) {
      expect(ALLOWLIST.has(cited), `${cited} is cited by scope-class.ts`).toBe(true);
    }
  });

  /**
   * EI-20106565311448967. The test above asserts the citation EXISTS; it cannot
   * assert the runtime rule FIRES for the processes that allowlist entry produces.
   * It passed for as long as `console-spawn.ts` was allowlisted and its scopes were
   * still being counted as escapes — the gap is reachability, not correspondence.
   */
  it('has a reachable runtime rule for the console scopes the allowlist exempts', () => {
    expect(ALLOWLIST.has('packages/operator-core/lib/console-spawn.ts')).toBe(true);
    // The literal shape `buildScopedSpawnArgv(..., 'papercup-console', ...)` mints.
    expect(isConsoleWindowScope('papercup-console-gnome-terminal-665488-1786388175428.scope')).toBe(true);
  });
});

describe('isConsoleWindowScope', () => {
  it('matches a console scope by leaf, bare or in a full path', () => {
    expect(isConsoleWindowScope('papercup-console-verify-0014-platforms-69344-1786368816770.scope')).toBe(true);
    expect(
      isConsoleWindowScope(`${OUR_SLICE}/papercusp-agent.slice/papercup-console-Windows-VM-SPICE-5931.scope`),
    ).toBe(true);
  });

  /**
   * The load-bearing negative. `papercup-headless-*` is the SAME builder one argument
   * apart, and it is the genuine un-enrolled gap the residue census exists to raise —
   * sweeping it in here would delete the signal instead of fixing the false alarm.
   */
  it('does NOT match papercup-headless, our own pc- scopes, or a lookalike', () => {
    expect(isConsoleWindowScope(`${OUR_SLICE}/papercup-headless-some-job-1786388175428.scope`)).toBe(false);
    expect(isConsoleWindowScope(`${OUR_SLICE}/pc-aaa111.scope`)).toBe(false);
    // Right prefix, not a scope unit — must not match a slice or a stray directory.
    expect(isConsoleWindowScope(`${OUR_SLICE}/papercup-console-something.slice`)).toBe(false);
    expect(isConsoleWindowScope('')).toBe(false);
  });

  /**
   * A console scope lives INSIDE our slice, so `classifyScope` still calls it `owned`
   * — deliberately. The console is not an exception to ownership; the residue split
   * is where it stops being an escape. Pinned so a later refactor cannot quietly
   * weaken the `owned` short-circuit in the name of this fix.
   */
  it('does not make a console scope stop being owned', () => {
    const consolePath = `${OUR_SLICE}/papercup-console-gnome-terminal-665488.scope`;
    expect(classifyScope(consolePath, true)).toEqual({ scope: 'owned', exemptReason: null });
  });
});
