/**
 * Unit tests for collectTuiPanes — the capability-gated resolver behind
 * plugins:tui_panes (revive-plugin-system-2026-06-04 D-002). Pure function:
 * no PG, no live host. Exercises the two-tier capability gate (manifest ∩
 * user-granted), the compute:exec gate on command[0], and entry filtering.
 */
import { describe, it, expect } from 'vitest';
import { collectTuiPanes } from './tui_panes';

const NO_GRANTS = () => undefined;

function lp(name: string, caps: string[], ui: unknown[], path = `/plugins/${name}`) {
  return { plugin: { name, capabilities: caps, ui }, path } as Parameters<typeof collectTuiPanes>[0][number];
}

describe('collectTuiPanes', () => {
  it('surfaces a tui-pane the plugin is fully capable for (manifest-only)', () => {
    const panes = collectTuiPanes(
      [
        lp('demo', ['ui:tui-pane', 'compute:exec:sh'], [
          { type: 'tui-pane', slug: 'logs', label: 'Logs', icon: 'log', command: ['sh', 'render.sh'] },
        ]),
      ],
      NO_GRANTS,
    );
    expect(panes).toEqual([
      { pluginName: 'demo', slug: 'logs', label: 'Logs', icon: 'log', command: ['sh', 'render.sh'], cwd: '/plugins/demo' },
    ]);
  });

  it('omits the icon field when absent', () => {
    const panes = collectTuiPanes(
      [lp('demo', ['ui:tui-pane', 'compute:exec:sh'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['sh'] }])],
      NO_GRANTS,
    );
    expect(panes[0]).not.toHaveProperty('icon');
  });

  it('excludes a plugin that lacks ui:tui-pane', () => {
    const panes = collectTuiPanes(
      [lp('demo', ['compute:exec:sh'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['sh'] }])],
      NO_GRANTS,
    );
    expect(panes).toEqual([]);
  });

  it('excludes a pane whose command binary lacks compute:exec', () => {
    const panes = collectTuiPanes(
      [lp('demo', ['ui:tui-pane'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['ffmpeg'] }])],
      NO_GRANTS,
    );
    expect(panes).toEqual([]);
  });

  it('ignores react/iframe entries (only tui-pane surfaces here)', () => {
    const panes = collectTuiPanes(
      [
        lp('demo', ['ui:tui-pane', 'ui:harness-route', 'compute:exec:sh'], [
          { type: 'react', slug: 'r', label: 'React' },
          { type: 'iframe', slug: 'i', label: 'Iframe', iframeEntry: 'x.html' },
          { type: 'tui-pane', slug: 't', label: 'Tui', command: ['sh'] },
        ]),
      ],
      NO_GRANTS,
    );
    expect(panes.map((p) => p.slug)).toEqual(['t']);
  });

  it('skips malformed tui-pane entries (missing/empty command)', () => {
    const panes = collectTuiPanes(
      [
        lp('demo', ['ui:tui-pane', 'compute:exec:sh'], [
          { type: 'tui-pane', slug: 'nocmd', label: 'NoCmd' },
          { type: 'tui-pane', slug: 'empty', label: 'Empty', command: [] },
          { type: 'tui-pane', slug: 'ok', label: 'Ok', command: ['sh'] },
        ]),
      ],
      NO_GRANTS,
    );
    expect(panes.map((p) => p.slug)).toEqual(['ok']);
  });

  it('honors a wildcard compute:exec cap for the pane binary', () => {
    const panes = collectTuiPanes(
      [lp('demo', ['ui:tui-pane', 'compute:exec:py-*'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['py-render'] }])],
      NO_GRANTS,
    );
    expect(panes.map((p) => p.slug)).toEqual(['s']);
  });

  it('enforces tier-2 grants: a granted set missing compute:exec excludes the pane', () => {
    const grantedFor = () => ['ui:tui-pane']; // granted ui but NOT the exec cap
    const panes = collectTuiPanes(
      [lp('demo', ['ui:tui-pane', 'compute:exec:sh'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['sh'] }])],
      grantedFor,
    );
    expect(panes).toEqual([]);
  });

  it('enforces tier-2 grants: a complete granted set surfaces the pane', () => {
    const grantedFor = () => ['ui:tui-pane', 'compute:exec:sh'];
    const panes = collectTuiPanes(
      [lp('demo', ['ui:tui-pane', 'compute:exec:sh'], [{ type: 'tui-pane', slug: 's', label: 'L', command: ['sh'] }])],
      grantedFor,
    );
    expect(panes.map((p) => p.slug)).toEqual(['s']);
  });

  it('collects panes across multiple plugins', () => {
    const panes = collectTuiPanes(
      [
        lp('a', ['ui:tui-pane', 'compute:exec:sh'], [{ type: 'tui-pane', slug: 'a1', label: 'A1', command: ['sh'] }]),
        lp('b', [], [{ type: 'tui-pane', slug: 'b1', label: 'B1', command: ['sh'] }]), // not capable
        lp('c', ['ui:tui-pane', 'compute:exec:less'], [{ type: 'tui-pane', slug: 'c1', label: 'C1', command: ['less', 'README'] }]),
      ],
      NO_GRANTS,
    );
    expect(panes.map((p) => `${p.pluginName}:${p.slug}`)).toEqual(['a:a1', 'c:c1']);
  });
});
