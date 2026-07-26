/**
 * Corpus fixture hygiene (WI-6042 / WI-4776 class).
 *
 * The fixtures under `fixtures/` are a VERBATIM extract of real commands run on
 * a developer's box, committed to tracked source — which means they ship to
 * users inside the release bundle's `sidecar/source.tar.zst`. A raw extract is
 * therefore full of exactly the thing that must never be committed: absolute
 * paths into somebody's home directory.
 *
 * This already bit us. `git-read.passthrough.sample.json` shipped one
 * `/home/<owner>/.papercusp/pot-git/…` atom while its three siblings had been
 * hand-sanitised to `/home/dev`, and the green-checkpoint gate held `main` red
 * on `lint:no-box-identity` until it was found. The repo-wide lint is the right
 * backstop but the WRONG place to learn it: it runs late, over the whole tree,
 * and a red gate blocks the entire fleet's deploys.
 *
 * So this test is the near latch — it fails in this package, in seconds, the
 * moment a fixture regains an identity, and it covers the munged form
 * (`-home-<user>-…`) that `scrubIdentity` deliberately declines to rewrite.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FIXTURE_DIR, scrubIdentity } from './corpus';

/** Mirrors `HOME_PATH` in `scripts/check-no-box-identity.mjs` — an absolute path
 *  into a home directory, in the ordinary slash form. */
const HOME_PATH = /\/(home|Users)\/([A-Za-z0-9._-]+)(?=[/'"`\s\\)\]:,;]|$)/g;

/** Mirrors `MUNGED_HOME` — the same path with slashes flattened to dashes, the
 *  shape Claude uses to name a session/project dir. A slash-based regex cannot
 *  see it, which is how this class has escaped review before. */
const MUNGED_HOME = /(^|["'`/\s])-(home|Users)-([A-Za-z0-9._]+)(?=-)/g;

/** Kept deliberately tight: a name is allowed here only if it names NOBODY.
 *  This is not a place to silence a real identity to make the suite pass — the
 *  fix for a hit is to scrub the fixture, never to widen this set. */
const ANONYMOUS = new Set([
  'dev', 'linuxbrew', 'runner', 'user', 'ubuntu', 'root', 'node', 'builder',
  'vscode', 'codespace', 'shared', 'ci', 'agent', 'pcusp', 'papercusp', 'test',
]);

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.sample.json'));

describe('committed fixtures carry no box identity (WI-4776 class)', () => {
  it('finds fixtures to check', () => {
    // Guards the guard: a bad glob silently checking zero files would pass
    // forever while leaks sailed through.
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)('%s names no person', (file) => {
    const src = readFileSync(join(FIXTURE_DIR, file), 'utf8');

    const leaks: string[] = [];
    for (const m of src.matchAll(HOME_PATH)) {
      const user = m[2].replace(/\.+$/, '');
      if (user && !ANONYMOUS.has(user)) leaks.push(`${m[0]}  (user "${user}")`);
    }
    for (const m of src.matchAll(MUNGED_HOME)) {
      if (!ANONYMOUS.has(m[3])) leaks.push(`${m[0]}  (munged user "${m[3]}")`);
    }

    expect(
      leaks,
      `${file} contains a home path naming a real user. The corpus is a verbatim\n` +
        `extract, so this is expected in the RAW data and must be scrubbed before it is\n` +
        `committed — rewrite the user segment to "/home/dev" (see scrubIdentity in\n` +
        `corpus.ts). Do NOT widen the ANONYMOUS set to make this pass.\n\n` +
        leaks.join('\n'),
    ).toEqual([]);
  });
});

// The inputs below use the canonical John-Doe identities (`jdoe`, `bob`) rather
// than this box's real user: a scrubber test must contain realistic-looking home
// paths — they are its INPUT — and writing the true username here would leak the
// very identity the scrubber exists to remove, tripping `lint:no-box-identity`
// on the file that guards against it. These names are in that lint's sanctioned
// fake set and name no one; they are NOT in `GENERIC_HOME_USERS`, so the scrubber
// still treats them as personal and rewrites them, which is what we assert.
describe('scrubIdentity', () => {
  it('rewrites a personal home path, preserving the rest of the command', () => {
    expect(
      scrubIdentity("git --git-dir=/home/jdoe/.papercusp/pot-git/x.git for-each-ref 'refs/hive/*'"),
    ).toBe("git --git-dir=/home/dev/.papercusp/pot-git/x.git for-each-ref 'refs/hive/*'");
  });

  it('rewrites the macOS /Users form too', () => {
    expect(scrubIdentity('cat /Users/jdoe/src/a.ts')).toBe('cat /Users/dev/src/a.ts');
  });

  it('rewrites every occurrence in one command', () => {
    expect(scrubIdentity('cp /home/bob/x /home/bob/y')).toBe('cp /home/dev/x /home/dev/y');
  });

  it('leaves an already-anonymous home dir alone', () => {
    // Rewriting these would churn fixtures without removing any identity — and
    // /home/linuxbrew is a real shared install path whose meaning would be lost.
    expect(scrubIdentity('ls /home/dev/x')).toBe('ls /home/dev/x');
    expect(scrubIdentity('ls /home/linuxbrew/.linuxbrew/bin')).toBe('ls /home/linuxbrew/.linuxbrew/bin');
  });

  it('does not swallow sentence punctuation after a home path', () => {
    // A home dir never ends in a dot, so a trailing dot is prose, not the name.
    expect(scrubIdentity('lives under /home/jdoe.')).toBe('lives under /home/dev.');
  });

  it('leaves a command with no home path byte-identical', () => {
    const atom = 'git diff --stat 5421cd2ade 5e0af0a147';
    expect(scrubIdentity(atom)).toBe(atom);
  });

  it('scrubs the atom shape that reddened the gate', () => {
    const raw =
      'git --git-dir=/home/jdoe/.papercusp/pot-git/papercusp/gh-1223568103.git ' +
      "for-each-ref 'refs/hive/*' 'refs/namespaces/*/refs/heads/staging' " +
      "--format='%(refname) %(objectname:short=12)' 2>/dev/null";
    const scrubbed = scrubIdentity(raw);
    expect(scrubbed).not.toMatch(/jdoe/);
    // The command's SHAPE is what the verdict is derived from, so the scrub must
    // not disturb the verb, its flags, or the argument structure.
    expect(scrubbed.startsWith('git --git-dir=/home/dev/.papercusp/')).toBe(true);
    expect(scrubbed.endsWith("--format='%(refname) %(objectname:short=12)' 2>/dev/null")).toBe(true);
  });
});
