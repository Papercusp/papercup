/**
 * nuqs key-collision lint (hud-open-destinations-and-true-counts-2026-07-27).
 *
 * Two `useQueryState` hooks in one component may share a key ONLY if they agree
 * on the shape of the value. When they disagree on ARITY — one `parseAsArrayOf`,
 * one scalar — the writes silently fight and the symptom appears nowhere near
 * the cause.
 *
 * The bug this was written for: `HudView` bound `hudplan` twice — once at the
 * top as the plan FILTER axis (`parseAsArrayOf(parseAsString)`) and once 330
 * lines down as the open-plan-popup slug (`parseAsString`). Clicking a plan card
 * wrote the slug; the ARRAY hook read it straight back as a filter; the board
 * emptied to zero cards and no popup ever opened. That is strictly worse than
 * the unwired card the owner originally reported, and every unit test passed —
 * because each hook is correct in isolation. Only the PAIR is wrong, so only a
 * whole-file check can see it.
 *
 * Scope note: a key bound twice with two SCALAR parsers (e.g. `parseAsStringEnum`
 * alongside `parseAsString`) is deliberately NOT failed here. Both still read a
 * scalar, so the values stay round-trippable; two such pairs exist today and
 * flagging them would make this lint noise that someone eventually deletes. The
 * arity split is the class that actually destroys state.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps/operator/app', 'apps/operator-vite/src'];

/** Repo root: this file sits at apps/operator/app/_lints/. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|_retired|\.next|dist/.test(p)) out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Every `useQueryState('key', <parser…>)` binding in one file. The parser text
 *  is captured loosely — we only ever ask "is it an array parser", never parse it. */
function bindings(src: string): { key: string; parser: string }[] {
  const re = /useQueryStates?\(\s*\n?\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*([\s\S]{0,80}?)(?:\)|,\s*\n\s*\))/g;
  return [...src.matchAll(re)].map((m) => ({
    key: m[1]!,
    parser: m[2]!.replace(/\s+/g, ' ').trim(),
  }));
}

const isArrayParser = (parser: string) => /parseAsArrayOf/.test(parser);

describe('nuqs key collisions', () => {
  const files = ROOTS.flatMap((r) => sourceFiles(join(REPO_ROOT, r)));

  it('finds source files to lint (guards against a silently-empty scan)', () => {
    // A path change that made this lint scan nothing would otherwise "pass".
    expect(files.length).toBeGreaterThan(50);
  });

  it('never binds one nuqs key to both an array parser and a scalar parser', () => {
    const violations: string[] = [];

    for (const file of files) {
      const byKey = new Map<string, Set<boolean>>();
      for (const b of bindings(readFileSync(file, 'utf8'))) {
        const set = byKey.get(b.key) ?? new Set<boolean>();
        set.add(isArrayParser(b.parser));
        byKey.set(b.key, set);
      }
      for (const [key, arities] of byKey) {
        if (arities.size > 1) {
          violations.push(`${file.slice(REPO_ROOT.length + 1)} — '${key}' is bound as BOTH an array and a scalar`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('HudView binds every nuqs key exactly once', () => {
    // HudView is the component the collision actually shipped in, and it has no
    // legitimate reason to read one key from two hooks: it owns every one of its
    // params. Exact-uniqueness is the stronger, cheaper invariant here.
    const src = readFileSync(join(REPO_ROOT, 'apps/operator/app/adv/hud/HudView.tsx'), 'utf8');
    const counts = new Map<string, number>();
    for (const b of bindings(src)) counts.set(b.key, (counts.get(b.key) ?? 0) + 1);

    expect([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
    // The board params are load-bearing; a rename should have to admit it here.
    expect([...counts.keys()].sort()).toContain('hudplan'); // the FILTER axis
    // The plan POPUP key (`hudplanpop`) is deliberately GONE (P-007 / D-005 on
    // plan-visibility-revamp-2026-08-23): a plan click opens the option-C
    // dashboard takeover, so HudView writes PLAN_DASHBOARD_PARAM instead —
    // bound via the imported constant, which the literal-key extractor above
    // cannot see, so it is asserted textually here.
    expect(src).not.toMatch(/hudplanpop/);
    expect(src).toContain('PLAN_DASHBOARD_PARAM');
  });
});
