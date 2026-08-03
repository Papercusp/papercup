/**
 * Unit tests for the PURE surface of condition-bridge.ts (P-003 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * The write paths need Postgres and belong to P-008's integration suite. What is
 * testable here without a database is the part most likely to rot: the opt-in
 * catalog and the terminal-status derivation.
 */
import { describe, it, expect } from 'vitest';
import {
  isActionableConditionKey,
  isTerminalStatus,
  resolveConditionHarness,
  ACTIONABLE_CONDITION_PREFIXES,
  ACTIONABLE_CONDITIONS,
} from './condition-bridge';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

describe('isActionableConditionKey', () => {
  it('admits the real condition keys emitted by the live watchdogs', () => {
    // Every one of these was read off a `conditionKey:` template in the source,
    // not invented: green-stall-watchdog.ts and single-primary-check.ts.
    for (const key of [
      'green-stall:papercusp',
      'main-behind-staging:papercusp',
      'release-trigger-freeze:papercusp',
      'release-trigger-fire-stale:papercusp',
      'single-primary:no-primary',
      'single-primary:split-brain-primary',
      'single-primary:no-dedicated-primary',
    ]) {
      expect(isActionableConditionKey(key)).toBe(true);
    }
  });

  it('rejects keys that are not opted in, so a transient condition mints nothing', () => {
    // A condition that flaps within a tick would otherwise mint and immediately
    // close an item on every flap — strictly worse than the duplicate filing
    // this plan exists to fix.
    for (const key of ['scorecard-emission-wedge', 'embed-space-desync', 'kettle-invalid-model-config']) {
      expect(isActionableConditionKey(key)).toBe(false);
    }
  });

  it('rejects empty / whitespace keys rather than matching a bare prefix', () => {
    expect(isActionableConditionKey('')).toBe(false);
    expect(isActionableConditionKey('   ')).toBe(false);
  });

  it('matches on prefix, so a new harness slug needs no catalog edit', () => {
    expect(isActionableConditionKey('green-stall:some-brand-new-harness')).toBe(true);
  });

  it('does not match a prefix appearing mid-key', () => {
    // Guards against a sloppy `includes()` — a key merely MENTIONING a condition
    // is not that condition.
    expect(isActionableConditionKey('mirror-of-green-stall:papercusp')).toBe(false);
  });

  it('every catalog entry is a namespaced prefix, not a bare key', () => {
    // conditionKeys are `<family>:<subject>`; a prefix without the colon would
    // match far more than intended.
    for (const p of ACTIONABLE_CONDITION_PREFIXES) expect(p.endsWith(':')).toBe(true);
  });
});

describe('isTerminalStatus derives from the shared SSOT', () => {
  it('treats every canonical terminal status as settled', () => {
    for (const s of ANY_FAMILY_TERMINAL_STATES) expect(isTerminalStatus(s)).toBe(true);
  });

  it('does not treat live states as settled', () => {
    for (const s of ['open', 'todo', 'wip', 'blocked', 'needs-human']) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it('treats null/undefined as NOT settled — unknown means possibly still live', () => {
    // Conservative on purpose: reporting an unknown row as a live owner costs a
    // duplicate at worst, while treating it as settled would release a key out
    // from under a real owner.
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it('does not re-list the terminal words (drift guard)', async () => {
    // EI-18653071581558556: hand-copied terminal unions drift. A stale copy
    // missing done/dropped scored 15 of 17 finished units as stranded (~88%
    // phantoms). This module must import the set, never spell it.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/ANY_FAMILY_TERMINAL_STATES/);
    // The literal terminal words must not appear as a quoted list in code.
    expect(code).not.toMatch(/'passed'\s*,\s*'deprecated'/);
    expect(code).not.toMatch(/'resolved'\s*,\s*'closed'/);
    // ...and openness must never be re-derived from closed_ts (D-010).
    expect(code).not.toMatch(/closed_ts/);
  });

  // REGRESSION GUARD for the work-item leak. `releaseConditionOwner` defaults
  // settle:false so a caller can keep an item open for a post-mortem. For the
  // RECONCILER those are not separable: release-without-settle leaves one
  // permanently-open work-item per condition EPISODE, which is the duplicate
  // filing this plan exists to eliminate, reintroduced through the exit path.
  // Measured flapper in the actionable set: main-behind-staging:papercusp
  // resolved 15:45Z and re-opened 18:30Z on 2026-08-02 alone.
  it('reconcileConditions SETTLES the owning item on resolve, not just releases the key', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./condition-bridge.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function reconcileConditions'));
    const release = body.slice(body.indexOf('releaseConditionOwner('));
    expect(release.slice(0, 400)).toMatch(/settle:\s*true/);
  });
});

describe('resolveConditionHarness', () => {
  it('reads the harness from the suffix for slug-suffixed families', () => {
    expect(resolveConditionHarness('green-stall:oddsmith', 'papercusp')).toBe('oddsmith');
    expect(resolveConditionHarness('main-behind-staging:papercusp', 'x')).toBe('papercusp');
  });

  // REGRESSION GUARD: `single-primary:${verdict.key}` is a VERDICT suffix.
  // Parsing it as a slug files the item into harness 'no-primary', which
  // createWorkItem accepts without validation and nothing ever surfaces.
  it('does NOT treat a verdict suffix as a harness', () => {
    expect(resolveConditionHarness('single-primary:no-primary', 'papercusp')).toBe('papercusp');
  });

  it('fails CLOSED — null when no harness can be established', () => {
    expect(resolveConditionHarness('single-primary:no-primary', null)).toBeNull();
    expect(resolveConditionHarness('single-primary:no-primary', '  ')).toBeNull();
  });

  it('returns null for a key that is not opted in at all', () => {
    expect(resolveConditionHarness('infra-liveness:panel:bees', 'papercusp')).toBeNull();
  });

  it('every catalog entry declares how its harness is derived', () => {
    for (const c of ACTIONABLE_CONDITIONS) {
      expect(c.prefix.endsWith(':')).toBe(true);
      expect(['suffix', 'ambient']).toContain(c.harnessFrom);
    }
  });
});
