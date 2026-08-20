/**
 * Unit test for the always-on CSS animation guard (WI-6542).
 *
 * The guard is only worth having if it is non-vacuous in BOTH directions, so this
 * covers both: it must stay GREEN on the real tree at its recorded baseline (no
 * false positive that would make people disable it), and it must go RED on
 * synthetic re-introductions of the class (no false negative — the failure mode
 * that let 107 declarations accumulate unnoticed in the first place).
 *
 * Proving the red direction with SYNTHETIC css strings rather than by dirtying
 * globals.css is deliberate: this tree is edited concurrently by the whole fleet
 * and git-sync commits it every few minutes, so a deliberately-broken file would
 * become a real commit.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  findOffenders,
  findOffendersInCss,
  isGatedSelector,
  isInfiniteAnimationDeclaration,
  isUngatedInfiniteAnimation,
  readBaseline,
} from '../../../../scripts/check-no-ungated-infinite-animation.mjs';

describe('isInfiniteAnimationDeclaration', () => {
  it('matches the shorthand and the longhand iteration count', () => {
    expect(isInfiniteAnimationDeclaration('animation: pcFoo 4s linear infinite;')).toBe(true);
    expect(isInfiniteAnimationDeclaration('animation-iteration-count: infinite;')).toBe(true);
  });

  it('ignores finite and non-animation declarations', () => {
    expect(isInfiniteAnimationDeclaration('animation: pcFoo 900ms ease-out 1;')).toBe(false);
    expect(isInfiniteAnimationDeclaration('transition: opacity 200ms linear;')).toBe(false);
    // the word alone, with no animation property, is just prose
    expect(isInfiniteAnimationDeclaration('/* runs infinite */')).toBe(false);
  });
});

describe('isGatedSelector', () => {
  it.each([
    '.pc-card:hover::after',
    '.pc-step__progress[data-status="loading"] .pc-step__progress-dot',
    '.pc-template-editor-file.is-dirty .pc-template-editor-dirty-dot',
    '.oracle-fab.has-unread .oracle-fab-badge',
    '.operator-empty-state--scanning .operator-empty-state__icon',
    '.chat-turn--streaming .chat-turn__body::after',
    '.pc-skeleton',
    '.operator-delegates__spinner',
    '.chat-panel__spin',
    '.pc-route-transition__grid',
  ])('treats %s as gated or transient', (selector) => {
    expect(isGatedSelector(selector)).toBe(true);
  });

  it.each([
    '.pc-settings-shell::before',
    '.pc-support-shell .pc-support-faq::before',
    '.hud-telemetry-marquee__track',
    '.operator-panel__body::before',
  ])('treats %s as always-on', (selector) => {
    expect(isGatedSelector(selector)).toBe(false);
  });
});

describe('isUngatedInfiniteAnimation', () => {
  it('flags an always-on decorative loop', () => {
    expect(isUngatedInfiniteAnimation('.pc-settings-shell::before', 'animation: pcDrift 12s linear infinite;')).toBe(true);
  });

  it('does not flag the same loop once it is gated behind a state', () => {
    expect(
      isUngatedInfiniteAnimation('.pc-settings-shell.is-syncing::before', 'animation: pcDrift 12s linear infinite;'),
    ).toBe(false);
  });

  it('does not flag a one-shot animation on an ungated selector', () => {
    expect(isUngatedInfiniteAnimation('.pc-settings-shell::before', 'animation: pcDrift 12s linear 1;')).toBe(false);
  });
});

describe('findOffendersInCss', () => {
  it('attributes a declaration to its enclosing rule', () => {
    const css = `
.pc-thing::before {
  content: "";
  animation: pcThingDrift 9s linear infinite;
}
`;
    const found = findOffendersInCss(css);
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe('.pc-thing::before');
  });

  it('recovers the selector of a single-line rule', () => {
    const found = findOffendersInCss('.pc-dot { background: red; animation: pcBlink 1.2s infinite; }\n');
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe('.pc-dot');
  });

  it('never reports a @keyframes stop as an offender', () => {
    const css = `
@keyframes pcDrift {
  from { background-position: 0 0; }
  to { background-position: 120px 0; }
}
`;
    expect(findOffendersInCss(css)).toHaveLength(0);
  });

  it('honours a gate on an ANCESTOR selector, not just the leaf', () => {
    const css = `
.pc-shell:hover {
  .pc-inner::after {
    animation: pcSheen 2s linear infinite;
  }
}
`;
    expect(findOffendersInCss(css)).toHaveLength(0);
  });

  it('is quiet on a stylesheet with no always-on animation', () => {
    expect(findOffendersInCss('.a { color: red; }\n.b:hover { animation: x 1s infinite; }\n')).toHaveLength(0);
  });
});

describe('the real tree', () => {
  it('contains no ungated infinite animation outside the recorded baseline', () => {
    const baseline = readBaseline();
    const added = findOffenders().filter((o) => !baseline.has(o.selector));
    expect(
      added.map((o) => `${o.file}:${o.line} ${o.selector}`),
      'new always-on CSS animation(s) — drop the loop and keep the resting look, or gate it behind the state that should drive it (WI-6542)',
    ).toEqual([]);
  });

  it('has a baseline that only shrinks — every entry still corresponds to real source', () => {
    // A baseline entry whose selector no longer exists means the class was fixed;
    // that is good, and the entry should be deleted so the ratchet keeps its teeth.
    const offenders = new Set(findOffenders().map((o) => o.selector));
    const stale = [...readBaseline()].filter((sel) => !offenders.has(sel));
    expect(stale, `baseline entries that are now fixed — delete them from scripts/no-ungated-infinite-animation.baseline.json`).toEqual([]);
  });

  it('proves the guard is non-vacuous: the baseline is a real, non-empty set', () => {
    expect(readBaseline().size).toBeGreaterThan(0);
  });

  it('has the animations this item removed actually gone from globals.css', () => {
    const css = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');
    for (const name of [
      'pcSettingsMatrixSweep',
      'pcSettingsCommandGrid',
      'pcSettingsCommandSweep',
      'pcSupportGridDrift',
      'pcSupportSignalSweep',
      'pcVoiceSpectrumDrift',
      'pcVoicePanelSweep',
      'pcVoiceMeterPulse',
      'pcSetupGridDrift',
      'pcSetupCodeSweep',
      'pcRuntimeBusDrift',
      'pcRuntimeStatusSweep',
      'op-chat-empty-float',
    ]) {
      expect(css, `${name} must no longer be APPLIED (its @keyframes may remain)`).not.toMatch(
        new RegExp(`animation:[^;}]*\\b${name}\\b`),
      );
    }
  });
});
