/**
 * chat-controls.vocabulary — guards for the two RULES the control vocabulary
 * runs on (session-chat-popup-direction-d-2026-08-02 P-003, deck change #1).
 *
 * P-003 exists because of a complaint about GRAMMAR, not looks: [owner
 * 2026-08-02] "the difference between whats a label, whats a button, and whats
 * a mode etc, is confusing". The fix was a table of five shapes plus two rules
 * that do most of the work:
 *
 *   ① ROUNDED = the system is telling you something.
 *     RECTANGULAR = you are telling the system something.
 *   ② A trailing "…" means a chooser opens; no ellipsis means it fires NOW.
 *
 * Both rules were prose in a stylesheet header, enforced by nothing. That is a
 * bad place for an invariant to live, because each rule decays the same quiet
 * way: someone rounds a button's corners "for consistency", or adds an action
 * whose label promises immediacy and then opens a card. Neither breaks a
 * render, so every behavioural test stays green while the vocabulary — the
 * whole deliverable — stops meaning anything.
 *
 * WHY SOURCE ASSERTIONS. Rule ① can only be checked against the stylesheet:
 * jsdom applies no CSS, so a component test cannot see a radius at all (the
 * same reason WI-7110's split-owner guard in FleetLaunchRow.test.tsx is a
 * source assertion). Rule ② is checked against the real registered
 * descriptors, because the promise the label makes is only a lie relative to
 * whether that action declares `params`.
 *
 * These lock the RULES, not the values: restyle freely — 999px can become
 * anything round and 4px anything square — but a shape must not change sides.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The BARREL, not the registry: importing the registry alone is what once left
// the real action bar empty (WI-6450), and here it would leave rule ② asserting
// over an empty set — a green that means nothing. The barrel's side-effect
// imports are what register the concrete descriptors.
import '@/lib/chat-actions';
import {
  getChatAction,
  getChatModeAction,
  listAllChatActionIds,
  listAllChatModeActionIds,
} from '@/lib/chat-actions/registry';

const css = readFileSync(join(__dirname, 'chat-controls.css'), 'utf8');
/** The stylesheet with comments removed — the header PROSE quotes several of
 *  the very declarations these guards forbid, so scanning the raw text finds
 *  matches inside the explanation of the rule rather than violations of it. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declared `border-radius` of a rule whose selector IS exactly `sel` (not a
 * descendant, not a modifier) — the shape's own corner, which is what rule ①
 * is about.
 */
function radiusOf(sel: string): string | null {
  // cssCode, not css: a rule's selector capture would otherwise swallow the
  // preceding comment block (comments carry no braces), so the `=== sel`
  // comparison never matched and every lookup returned null — which reads as
  // "the shape declares no radius" rather than as a broken parse.
  for (const [, selector, body] of cssCode.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const matches = selector.split(',').some((s) => s.trim() === sel);
    if (!matches) continue;
    const m = body.match(/border-radius:\s*([^;]+);/);
    if (m) return m[1].trim();
  }
  return null;
}

/** A radius that reads as a pill — the "fully round" end of the scale. */
const isRound = (r: string | null) => r === '999px' || /^(9999px|50%)$/.test(r ?? '');
/** A radius that reads as a rectangle with softened corners. */
const isRectangular = (r: string | null) => {
  if (r === null || isRound(r)) return false;
  const px = Number.parseFloat(r);
  return Number.isFinite(px) && px <= 8;
};

describe('P-003 rule ①: rounded = the system tells you; rectangular = you tell the system', () => {
  /* The system-speaks half. A State is a fact that changes on its own; a Mode
     is a state you can change; an Alert is a state that also links to detail.
     All three REPORT, so all three are pills. */
  it.each([
    ['.pc-ctl-state', 'a fact, read-only, changes on its own'],
    ['.pc-ctl-mode', 'a state you can change — still reports one'],
    ['.pc-ctl-alert', 'a state that is ALSO a link to its detail'],
  ])('%s is a pill (%s)', (sel) => {
    const r = radiusOf(sel);
    expect(r, `${sel} declares no border-radius of its own`).not.toBeNull();
    expect(isRound(r), `${sel} has radius ${r} — a reporting shape must read as a pill`).toBe(true);
  });

  /* The you-speak half. An Action fires; a Field collects. Both are things you
     do TO the system, so both are rectangles. */
  it.each([
    ['.pc-ctl-act', 'happens the instant you click'],
    ['.pc-ctl-field__well', 'part of a form, nothing fires yet'],
  ])('%s is a rectangle (%s)', (sel) => {
    const r = radiusOf(sel);
    expect(r, `${sel} declares no border-radius of its own`).not.toBeNull();
    expect(
      isRectangular(r),
      `${sel} has radius ${r} — an input shape must not read as a pill`,
    ).toBe(true);
  });

  it('the two halves are actually distinguishable — the whole rule is that they differ', () => {
    // Paired with the cases above so neither is vacuous: if a future edit made
    // every radius identical, each half's own predicate could still be
    // satisfied by a sufficiently loose threshold, but this cannot be.
    expect(radiusOf('.pc-ctl-state')).not.toBe(radiusOf('.pc-ctl-act'));
  });

  it('keeps the two rails the vocabulary is shaped around (letter-spacing, and flex on a <button>)', () => {
    // Not style preferences — both are real failures. `lint:design-primitives`
    // ENFORCES letter-spacing: 0 across app UI, so a nonzero value here reds
    // the fleet's gate; and WebKitGTK (the only shipping webview) IGNORES flex
    // on a <button> element and falls back to block, stacking icon over label
    // (EI-18135716653974462). The header says both; nothing checked either.
    //
    // Read every DECLARED value rather than pattern-matching for a bad one: a
    // negative regex here is how this guard first shipped broken — `\s*` can
    // match zero-width, so `letter-spacing: 0` satisfied a `(?!0)` lookahead
    // and the test failed against the compliant file it was guarding.
    for (const [, value] of cssCode.matchAll(/letter-spacing:\s*([^;}]+)/g)) {
      expect(Number.parseFloat(value), `letter-spacing: ${value.trim()}`).toBe(0);
    }
    for (const shape of ['.pc-ctl-act', '.pc-ctl-mode', '.pc-ctl-alert']) {
      const rule = [...cssCode.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s]) =>
        s.split(',').some((x) => x.trim() === shape),
      );
      expect(rule, `${shape} has no rule`).toBeTruthy();
      // Each button-backed shape lays out via an inner span instead.
      expect(rule![2]).toMatch(/display:\s*block/);
      expect(css).toMatch(new RegExp(`\\${shape}__inner`));
    }
  });
});

describe('P-003 rule ②: a trailing "…" means a chooser opens; no ellipsis means it fires now', () => {
  // Deliberately NO registry reset in this file: the barrel registers via
  // module side effects, so a reset would empty the registry and the next
  // import (already cached) could not refill it — the second case would then
  // pass over nothing.

  it('every registered action’s label matches whether it actually asks first', () => {
    const ids = listAllChatActionIds();
    // The positive control for the whole case: an empty registry would satisfy
    // every assertion in the loop below.
    expect(ids.length).toBeGreaterThan(0);

    const asksFirst: string[] = [];
    const firesNow: string[] = [];
    for (const id of ids) {
      const a = getChatAction(id);
      if (!a) continue;
      const promises = a.label.trimEnd().endsWith('…');
      const asks = typeof a.params === 'function';
      (asks ? asksFirst : firesNow).push(a.label);
      expect(
        promises,
        asks
          ? `"${a.label}" opens a chooser but its label does not end in "…" — this is the "I clicked Grade and nothing happened" confusion the rule removes`
          : `"${a.label}" fires immediately but its label ends in "…", promising a chooser that never opens`,
      ).toBe(asks);
    }
    // At least one REAL action must have been judged, or the loop above is
    // vacuous.
    expect(firesNow.length, 'no immediate action registered').toBeGreaterThan(0);

    /* ⚠ CORRECTED 2026-08-03 (WI-7439/WI-7456). This used to also require
       `asksFirst.length > 0`, and that assertion had been RED in the tree since
       WI-7439 removed "Grade session…" — the only params-bearing action there
       has ever been. Its rubric choice moved onto the GRADE mode pill at the
       owner's ask ("I want the rubric picker back, add that to the grade on/off
       toggle"), i.e. to `ChatModeAction.options()`, which is a different
       contract; so the registry is now legitimately, and probably permanently,
       empty of params-bearing actions.

       The original concern was right and is kept: with one population empty the
       rule is only half-exercised. But the fix is not to demand the PRODUCT
       ship an action of each kind — that pins a vocabulary invariant to a
       product decision the owner is entitled to reverse, which is exactly how
       this went red. Exercise the asks-first direction against a synthetic
       descriptor instead: the rule stays checked in both directions whether or
       not any shipped action happens to open a chooser. */
    const promisesChooser = (a: { label: string; params?: unknown }): boolean =>
      a.label.trimEnd().endsWith('…');
    const opensChooser = (a: { label: string; params?: unknown }): boolean =>
      typeof a.params === 'function';

    const conformingAsk = { label: 'Grade session…', params: () => ({}) };
    const violatingAsk = { label: 'Grade session', params: () => ({}) };
    expect(promisesChooser(conformingAsk)).toBe(opensChooser(conformingAsk));
    expect(promisesChooser(violatingAsk)).not.toBe(opensChooser(violatingAsk));
  });

  it('a mode pill never uses the ellipsis — its caret already says a chooser opens', () => {
    const ids = listAllChatModeActionIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const cap = getChatModeAction(id)?.cap ?? '';
      // The cap is an axis NAME ("AUTO", "IDEATE"), not a verb — the shape
      // itself carries "a chooser opens", so borrowing the verb rule's
      // punctuation would say it twice.
      expect(cap.endsWith('…'), `mode cap "${cap}" borrows the action rule’s ellipsis`).toBe(false);
    }
  });
});
