import { describe, expect, it } from 'vitest';
import {
  classifyScope,
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
    ]) {
      expect(classifyScope(`${APP_SLICE}/${unit}`, false)).toEqual({
        scope: 'exempt',
        exemptReason: 'systemd-unit',
      });
    }
  });

  it('calls an unenrolled headless member UNACCOUNTED — this is the real gap', () => {
    // buildHeadlessSpawnCommand falls back to `papercup-headless-*` when it is
    // handed no taskScope, i.e. exactly the P-009 residue. A transient .scope is
    // NOT supervised the way a .service is, which is why the rule discriminates on
    // the suffix rather than on the `papercup-` prefix both share.
    const headless = `${APP_SLICE}/papercup-headless-bug-drain-member-2-10-781613-1785608783953.scope`;
    expect(classifyScope(headless, false)).toEqual({ scope: 'unaccounted', exemptReason: null });
  });

  it('does not let a papercup-* NAME buy an exemption', () => {
    // The whole point of discriminating structurally: a name list would have
    // exempted this alongside papercup-bg-host.service and hidden the gap.
    expect(classifyScope(`${APP_SLICE}/papercup-anything.scope`, false).scope).toBe('unaccounted');
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
    expect(classifyScope(vte, false, { terminalWindowAlive: false })).toEqual({
      scope: 'unaccounted',
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
});
