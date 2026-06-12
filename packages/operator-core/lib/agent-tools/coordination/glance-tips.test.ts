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

  it('staged wakes under auto → the release tip (not the wake-mode tip)', () => {
    const tips = evaluateTips(ctx({ stagedTotal: 1 }));
    expect(tips.map((t) => t.id)).toEqual(['staged-wakes-under-auto']);
    expect(tips[0].text).toContain('1 staged wake ');
    expect(tips[0].command).toBe('/mcp__papercusp-su__tool:coord:wake-queue action=release_all');
    expect(tips[0].invoke).toEqual({ tool: 'coord:wake-queue', args: { action: 'release_all' } });
  });

  it('governor pause → tip for every audience including bees', () => {
    const paused = { governorPausedKeys: ['anthropic:opus'] };
    expect(evaluateTips(ctx({ ...paused, audience: 'bee' })).map((t) => t.id)).toEqual([
      'governor-paused',
    ]);
    expect(evaluateTips(ctx(paused))[0].text).toContain('anthropic:opus');
    expect(evaluateTips(ctx(paused))[0].command).toBeNull();
    expect(evaluateTips(ctx(paused))[0].invoke).toBeNull();
  });

  it('bees never see the wake-mode/staged-wake tips (audience scoping)', () => {
    const tips = evaluateTips(ctx({ audience: 'bee', wakeDefault: 'manual', stagedTotal: 5 }));
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
