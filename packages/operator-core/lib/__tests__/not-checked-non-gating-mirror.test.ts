/**
 * PIN for the mirror in `scripts/lib/not-checked-non-gating.mjs` (WI-10000288).
 *
 * WHY A PIN IS OWED HERE
 *   That module lists which repo-wide invariant guards have declared `notCheckedIsNonGating`
 *   — a SECOND copy of a truth `REPO_WIDE_INVARIANT_GUARDS` (scripts/affected-tests.mjs)
 *   already owns. Per the repo's derived-truth ladder a mirror is acceptable only at the PIN
 *   rung: with a build-time divergence check. The registry cannot simply be imported — it is
 *   a bare `const`, not an export, and affected-tests.mjs does real work at module scope
 *   (resolves ROOT, memoizes changed-path derivations, builds the task list), which a
 *   long-lived operator process must not execute to read one flag. So the copy is justified
 *   and this file is the other half of the bargain.
 *
 *   The failure it prevents is not hypothetical: green-checkpoint's `runGateAtRef` and
 *   `measureRepairTickLegs` judge a registered not-checked guard as non-gating using THIS
 *   list. A guard added to the registry but missing here is re-entered into the repair
 *   signature every tick and can never be retired by any fix to the subject — the shape that
 *   held the frozen candidate red for 119+ hours.
 *
 * WHY IT IS PARSED, NOT RESTATED
 *   A hand-written expected list here would be a THIRD copy, and would drift in lockstep with
 *   the second. The registry text is parsed instead, so the assertion is against the live
 *   declaration. The parse is therefore load-bearing, and the positive controls below exist
 *   because the dangerous failure is a parser that silently finds NOTHING: an empty parsed
 *   set compared against an empty mirror would pass while checking nothing at all.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-ignore -- plain .mjs policy module, no type declarations; keep immediately above the module specifier.
import { NOT_CHECKED_NON_GATING_SCRIPTS } from '../../../../scripts/lib/not-checked-non-gating.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The registry source. Overridable ONLY so this pin's falsifiability can be proved against a
 * mutated COPY outside the tree — the repo's tier-2 mutation-probe recipe — instead of the
 * cp/mutate/restore shape, which git-sync can commit mid-probe. Defaults to the real file, so
 * the gate and every hand-run check the real thing.
 */
const AFFECTED_TESTS =
  process.env.PAPERCUSP_NOT_CHECKED_MIRROR_REGISTRY_PATH ??
  path.join(REPO_ROOT, 'scripts/affected-tests.mjs');

/** The registry's declaring identifier. Named once so a rename fails LOUDLY below. */
const REGISTRY_IDENT = 'REPO_WIDE_INVARIANT_GUARDS';

/**
 * Slice the `REPO_WIDE_INVARIANT_GUARDS = [ ... ]` array literal out of the source, by
 * bracket depth rather than by line number (the line numbers move constantly).
 */
function readRegistryBody(source: string): string {
  const declaration = new RegExp(`${REGISTRY_IDENT}\\s*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`${REGISTRY_IDENT} array literal not found in ${AFFECTED_TESTS}`);
  const open = source.indexOf('[', declaration.index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${REGISTRY_IDENT} array literal is unterminated`);
}

/** Split the array body into its top-level `{ ... }` entries, by brace depth. */
function splitEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        entries.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

/**
 * Drop whole-line `//` comments. Both the flag test and the name extraction run on the
 * stripped text, so a COMMENTED-OUT declaration is correctly not a declaration — and the
 * independent count below is not thrown off by prose that merely mentions the flag (there are
 * two such comments elsewhere in this file, which is what caught the first version of this
 * control: a whole-file count read 9 where the registry declares 7).
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const DECLARES_FLAG = /\bnotCheckedIsNonGating\s*:\s*true\b/;

/** Every `script:` / `scripts: [...]` name declared by one entry. */
function scriptNamesOf(entry: string): string[] {
  const names: string[] = [];
  const single = /\bscript\s*:\s*["'`]([^"'`]+)["'`]/g;
  for (let m = single.exec(entry); m; m = single.exec(entry)) names.push(m[1]);
  const plural = /\bscripts\s*:\s*\[([^\]]*)\]/g;
  for (let m = plural.exec(entry); m; m = plural.exec(entry)) {
    const inner = /["'`]([^"'`]+)["'`]/g;
    for (let n = inner.exec(m[1]); n; n = inner.exec(m[1])) names.push(n[1]);
  }
  return names;
}

const source = readFileSync(AFFECTED_TESTS, 'utf8');
const registryBody = readRegistryBody(source);
const entries = splitEntries(registryBody);

/** Declarations inside the registry body, counted WITHOUT the entry splitter (see control). */
const bodyFlagCount = (
  stripLineComments(registryBody).match(/\bnotCheckedIsNonGating\s*:\s*true\b/g) ?? []
).length;

const declared = new Set<string>();
let declaringEntries = 0;
for (const raw of entries) {
  const entry = stripLineComments(raw);
  if (!DECLARES_FLAG.test(entry)) continue;
  declaringEntries += 1;
  const names = scriptNamesOf(entry);
  if (names.length === 0) {
    throw new Error(
      `a ${REGISTRY_IDENT} entry declares notCheckedIsNonGating: true but no script name could be ` +
        `parsed from it — the mirror cannot be checked against it:\n${entry.slice(0, 400)}`,
    );
  }
  for (const name of names) declared.add(name);
}

describe('not-checked-non-gating mirror is pinned to REPO_WIDE_INVARIANT_GUARDS', () => {
  // ── Positive controls. The dangerous failure mode of a parsing pin is a parser that finds
  // NOTHING, because set-equality against an equally-empty mirror then passes while checking
  // nothing. These make a broken parse fail as a broken parse.
  it('parsed the registry at all (guards against a silently-empty parse)', () => {
    expect(entries.length).toBeGreaterThan(50);
    expect(declared.size).toBeGreaterThan(0);
  });

  it('found as many declaring entries as the registry body contains', () => {
    // Counted independently of the entry SPLITTER — straight off the bracket-walk body — so a
    // brace walk that mis-segments entries disagrees here even when both numbers are non-zero.
    // Scoped to the registry body on purpose: this file also DISCUSSES the flag in prose, and
    // a whole-file count reads 9 against the 7 actually declared.
    expect(bodyFlagCount).toBeGreaterThan(0);
    expect(declaringEntries).toBe(bodyFlagCount);
  });

  // ── The pin itself, asserted in BOTH directions so either kind of drift fails.
  it('contains every script the registry declares non-gating (add one ⇒ update the mirror)', () => {
    const missingFromMirror = [...declared].filter((s) => !NOT_CHECKED_NON_GATING_SCRIPTS.has(s));
    expect(missingFromMirror).toEqual([]);
  });

  it('contains nothing the registry does not declare (remove one ⇒ update the mirror)', () => {
    const staleInMirror = [...NOT_CHECKED_NON_GATING_SCRIPTS].filter((s) => !declared.has(s));
    expect(staleInMirror).toEqual([]);
  });

  it('is exactly the registry set', () => {
    expect([...NOT_CHECKED_NON_GATING_SCRIPTS].sort()).toEqual([...declared].sort());
  });
});
