/**
 * glance-tips.test.ts — the pure tips engine: audience scoping, rule
 * conditions, display-priority ordering, and fault isolation.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIP_RULES,
  evaluateTips,
  type GlanceTipContext,
  type TipRule,
} from './glance-tips';

const ctx = (over: Partial<GlanceTipContext> = {}): GlanceTipContext => ({
  audience: 'user',
  wakeDefault: 'auto',
  stagedTotal: 0,
  selfOwnerId: 'su-caller',
  selfStagedCount: 0,
  beesRunning: 0,
  governorPausedKeys: [],
  state: {},
  ...over,
});

describe('evaluateTips — default rules', () => {
  it('quiet state → no tips', () => {
    expect(evaluateTips(ctx())).toEqual([]);
  });

  it('manual wake mode → the wake-mode tip with the slash command, staged count included', () => {
    const tips = evaluateTips(ctx({ wakeDefault: 'manual', stagedTotal: 2 }));
    expect(tips.map((t) => t.id)).toEqual(['wake-mode-manual']);
    expect(tips[0].text).toContain('2 staged wakes');
    expect(tips[0].command).toBe('/mcp__papercusp-su__tool:coord:wake-mode mode=auto');
    expect(tips[0].invoke).toEqual({ tool: 'coord:wake-mode', args: { mode: 'auto' } });
  });

  it('manual wake mode with nothing staged still tips (the gate itself is the news)', () => {
    const tips = evaluateTips(ctx({ wakeDefault: 'manual' }));
    expect(tips.map((t) => t.id)).toEqual(['wake-mode-manual']);
    expect(tips[0].text).not.toContain('staged');
  });

  it('staged wakes under auto, ALL the caller\'s own → the release tip quotes the caller\'s own count (release_all is per-agent, EI-7696)', () => {
    const tips = evaluateTips(ctx({ stagedTotal: 1, selfOwnerId: 'su-caller', selfStagedCount: 1 }));
    expect(tips.map((t) => t.id)).toEqual(['staged-wakes-under-auto']);
    expect(tips[0].text).toContain('1 staged wake ');
    expect(tips[0].text).toContain('of yours');
    expect(tips[0].command).toBe('/mcp__papercusp-su__tool:coord:wake-queue action=release_all agent=su-caller');
    expect(tips[0].invoke).toEqual({
      tool: 'coord:wake-queue',
      args: { action: 'release_all', agent: 'su-caller' },
    });
  });

  it('staged wakes under auto with NO resolvable caller → text-only, never the guaranteed-to-fail bare command', () => {
    const tips = evaluateTips(ctx({ stagedTotal: 1, selfOwnerId: null }));
    expect(tips.map((t) => t.id)).toEqual(['staged-wakes-under-auto']);
    expect(tips[0].text).toContain('1 staged wake ');
    expect(tips[0].command).toBeNull();
    expect(tips[0].invoke).toBeNull();
  });

  it('EI-13229: fleet-wide staged wakes exist but NONE are the caller\'s own → text says so, no command promising a release that would release 0', () => {
    const tips = evaluateTips(ctx({ stagedTotal: 7, selfOwnerId: 'su-caller', selfStagedCount: 0 }));
    expect(tips.map((t) => t.id)).toEqual(['staged-wakes-under-auto']);
    // Must quote the FLEET total (7) here, since that's the number being
    // described — but must NOT offer a release_all command/invoke, since
    // running it for `su-caller` would release 0 (the mismatch this bug
    // report was filed over: a tip said "7 staged wakes", release_all found
    // and released none).
    expect(tips[0].text).toContain('7 staged wakes');
    expect(tips[0].text).toContain('none are yours');
    expect(tips[0].command).toBeNull();
    expect(tips[0].invoke).toBeNull();
  });

  it('EI-13229: the caller\'s own count (not the fleet total) is what a self-scoped release tip must quote', () => {
    // Fleet has 7 staged fleet-wide, but this caller only has 2 of their own —
    // the tip must quote 2 (what release_all will actually drain for them),
    // never 7.
    const tips = evaluateTips(ctx({ stagedTotal: 7, selfOwnerId: 'su-caller', selfStagedCount: 2 }));
    expect(tips[0].text).toContain('2 staged wakes');
    expect(tips[0].text).not.toContain('7');
    expect(tips[0].invoke).toEqual({
      tool: 'coord:wake-queue',
      args: { action: 'release_all', agent: 'su-caller' },
    });
  });

  it('governor pause → tip for every audience including bees', () => {
    const paused = { governorPausedKeys: ['anthropic:opus'] };
    expect(evaluateTips(ctx({ ...paused, audience: 'cup' })).map((t) => t.id)).toEqual([
      'governor-paused',
    ]);
    expect(evaluateTips(ctx(paused))[0].text).toContain('anthropic:opus');
    expect(evaluateTips(ctx(paused))[0].command).toBeNull();
    expect(evaluateTips(ctx(paused))[0].invoke).toBeNull();
  });

  it('bees never see the wake-mode/staged-wake tips (audience scoping)', () => {
    const tips = evaluateTips(ctx({ audience: 'cup', wakeDefault: 'manual', stagedTotal: 5 }));
    expect(tips).toEqual([]);
  });

  it('multiple firing rules keep DEFAULT_TIP_RULES order (display priority)', () => {
    const tips = evaluateTips(
      ctx({ wakeDefault: 'manual', stagedTotal: 3, governorPausedKeys: ['anthropic:haiku'] }),
    );
    expect(tips.map((t) => t.id)).toEqual(['wake-mode-manual', 'governor-paused']);
  });
});

describe('evaluateTips — engine behavior', () => {
  it('a throwing rule is skipped, the rest still render (fault isolation)', () => {
    const rules: TipRule[] = [
      {
        id: 'boom',
        audiences: ['user'],
        when: () => {
          throw new Error('broken rule');
        },
        render: () => ({ text: 'never' }),
      },
      ...DEFAULT_TIP_RULES,
    ];
    const tips = evaluateTips(ctx({ wakeDefault: 'manual' }), rules);
    expect(tips.map((t) => t.id)).toEqual(['wake-mode-manual']);
  });

  it('rules can match on caller-supplied state pairs', () => {
    const rules: TipRule[] = [
      {
        id: 'custom-state',
        audiences: ['su'],
        when: (c) => c.state.view === 'fleet-tab',
        render: () => ({ text: 'fleet tab tip' }),
      },
    ];
    expect(evaluateTips(ctx({ audience: 'su', state: { view: 'fleet-tab' } }), rules)).toHaveLength(1);
    expect(evaluateTips(ctx({ audience: 'su' }), rules)).toEqual([]);
  });
});
