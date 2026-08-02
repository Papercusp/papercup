/**
 * prose-corpus-redaction.test.ts — the prose corpus cannot be generated with an identity leak
 * in it, and the redactor cannot drift from the guards that police it (WI-6992).
 *
 * ## WHY THIS SUITE EXISTS
 *
 * `prose-corpus-snapshot.ts` harvests LIVE workspace prose — whole doc pages, whole session
 * transcripts, whole plans — into a 2.94 MB fixture that is COMMITTED SOURCE and therefore
 * packed into the release bundle. That prose legitimately contains real names, home paths and
 * this box's git identity, and the generator had no redaction whatsoever.
 *
 * On 2026-08-02 the v1 snapshot landed carrying 26 named provenance tags, 113 bare box-identity
 * literals and 24 hardcoded home paths. All three WI-4776-class identity lints failed as
 * post-suite legs, the green-checkpoint went red, and `main` was frozen for the entire fleet for
 * ~6.8h — with every test passing. The artifact was scrubbed by hand, which fixes exactly one
 * file and leaves the trap armed for the next regeneration. This suite is the durable half.
 *
 * ## READ BEFORE "TIDYING" THE FIXTURES
 *
 * This file is tracked source, so it is scanned by the very lints it exercises. A fixture
 * written as a LITERAL leak would fail the gate and freeze `main` — this suite would become the
 * outage it exists to prevent. So:
 *
 *   - the person-name lives in `NAME`, assembled by concatenation, and every fixture
 *     interpolates it; `[owner:${NAME}` does not match the matcher (the character after the
 *     colon is `$`, not a letter) while the string the code receives at runtime is a real leak;
 *   - the identity literals are SYNTHETIC and passed in explicitly, never resolved from this
 *     box — `redactIdentityLeaks` takes an `entries` parameter for exactly this reason;
 *   - the home paths are assembled the same way, never spelled out.
 *
 * Inlining any of them re-arms the trap. `Quillon` is fictional and deliberately NOT in
 * PLACEHOLDER_NAMES so it must be DETECTED; `Jane` IS a placeholder so it must be IGNORED.
 * Never substitute a real contributor's name for either.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  GENERIC_USERS,
  IDENTITY_REDACTIONS,
  findBoxIdentityPaths,
  findIdentityLiterals,
  findOwnerNameLeaks,
  redactIdentityLeaks,
} from '../../../../../scripts/lib/identity-leak-patterns.mjs';
import { redactProseCorpusFixture, type ProseCorpusFixture } from './prose-corpus';

/** Fictional, and deliberately not a PLACEHOLDER_NAME — see the header. */
const NAME = `Quill${'on'}`;
/** Synthetic box identity. Never this box's own — this file ships. */
const ENTRIES: [string, string][] = [
  ['build-user-name', `quillon${'-office'}`],
  ['build-hostname', `quillon-desktop-42${'.local'}`],
  ['build-git-email', `quillon${'@'}example.org`],
  ['build-git-name', `Qu${'i'}`],
];
const HOME = `/ho${'me'}`;
const USER = ENTRIES[0][1];

/** Every leak shape the three matchers know how to find. */
const LEAKS: ReadonlyArray<readonly [string, string]> = [
  ['bracket provenance tag', `[owner:${NAME} 2026-07-14] do the thing`],
  ['bracket tag, lower-case', `[owner:${NAME.toLowerCase()} 2026-07-14]`],
  ['parenthetical mandate', `OWNER MANDATE (${NAME}, 2026-07-25, verbatim): "ship it"`],
  ['parenthetical, no comma', `OWNER RULE (${NAME} 2026-07-25)`],
  ['hardcoded home path', `see ${HOME}/${USER}/ws/repo/file.ts for detail`],
  ['slash-munged home path', `/tmp/x/-ho${'me'}-${USER}-ws-repo/abc/tasks/t.output`],
  ['bare box literals', `built by ${ENTRIES[3][1]} on ${ENTRIES[1][1]}, mail ${ENTRIES[2][1]}`],
  ['home path ending a sentence', `it lives under ${HOME}/${USER}.`],
];

const leakCount = (s: string): number =>
  findOwnerNameLeaks(s).length +
  findBoxIdentityPaths(s).length +
  findIdentityLiterals(s, ENTRIES).length;

describe('redactIdentityLeaks — the inverse of the three gate matchers', () => {
  it.each(LEAKS.map(([label, text]) => ({ label, text })))(
    'leaves no detectable leak: $label',
    ({ text }) => {
      // The fixture must actually BE a leak, or the assertion below proves nothing.
      expect(leakCount(text)).toBeGreaterThan(0);
      expect(leakCount(redactIdentityLeaks(text, ENTRIES))).toBe(0);
    },
  );

  it('does not over-redact: placeholders, session ids and bare dates survive untouched', () => {
    // Each of these names NOBODY, so rewriting them would corrupt prose for no safety gain.
    const safe = [
      `[owner:Jane 2026-07-13]`,
      `${HOME}/jdoe/x`,
      `[owner 2026-07-13]`,
      `[owner:2026-07-13]`,
      `[peer:su-b0fbf1 2026-07-13]`,
      `[self-imposed] and [inferred]`,
      `OWNER RULE (see the docs)`,
    ].join(' — ');
    expect(redactIdentityLeaks(safe, ENTRIES)).toBe(safe);
  });

  it('is idempotent — re-scrubbing scrubbed text changes nothing', () => {
    for (const [, text] of LEAKS) {
      const once = redactIdentityLeaks(text, ENTRIES);
      expect(redactIdentityLeaks(once, ENTRIES)).toBe(once);
    }
  });

  it('preserves surrounding prose rather than deleting the line', () => {
    const out = redactIdentityLeaks(`[owner:${NAME} 2026-07-14] do the thing`, ENTRIES);
    expect(out).toContain('do the thing');
    expect(out).toContain('2026-07-14');
    expect(out).not.toContain(NAME);
  });
});

describe('redactProseCorpusFixture', () => {
  const fixtureWith = (entries: ProseCorpusFixture['entries']): ProseCorpusFixture => ({
    version: 'vtest',
    snapshotAt: '2026-08-02T00:00:00.000Z',
    count: entries.length,
    bySurface: { doc: entries.length },
    clustersBySurface: { doc: entries.length },
    seed: 'test',
    note: 'a corpus note',
    entries,
  });

  it('scrubs text and description, and preserves every key', () => {
    const fx = fixtureWith([
      {
        key: 'doc:page#anchor',
        text: `[owner:${NAME} 2026-07-14] body`,
        kind: 'doc',
        description: `written on ${ENTRIES[1][1]}`,
        metadata: { surface: 'doc_sections', cluster: 'c' },
      },
    ] as unknown as ProseCorpusFixture['entries']);

    const out = redactProseCorpusFixture(fx);
    expect(out.entries[0].key).toBe('doc:page#anchor');
    expect(out.entries[0].text).not.toContain(NAME);
    expect(out.entries[0].description).not.toContain(ENTRIES[1][1]);
    // The corpus is a benchmark: the entry count and order must survive scrubbing.
    expect(out.entries).toHaveLength(1);
  });

  it('THROWS on a leak in a KEY rather than silently rewriting it', () => {
    // The gold set binds to keys ("regenerate BOTH together, never in place"), so a quiet
    // rewrite here would surface much later as an unrelated retrieval-scoring failure.
    const fx = fixtureWith([
      {
        key: `doc:${HOME}/${USER}/notes#a`,
        text: 'clean body',
        kind: 'doc',
        metadata: { surface: 'doc_sections', cluster: 'c' },
      },
    ] as unknown as ProseCorpusFixture['entries']);

    expect(() => redactProseCorpusFixture(fx)).toThrow(/entry KEY\(s\) carry an identity leak/);
  });
});

describe('drift: the release scrubber and the guards must agree', () => {
  /**
   * THE BUG THIS PINS. `REDACTION_BY_KEY` in audit-release-bundle.py maps this box's user name
   * to `builduser` — but `builduser` was missing from GENERIC_USERS, so applying the release
   * scrubber's OWN sanctioned output to a tracked file made check-no-box-identity red. That is
   * what turned the 2026-08-02 fix into three passes: the first scrub used the sanctioned
   * vocabulary and the guard rejected it.
   *
   * The module header says the two halves "MUST agree or it's a false-green"; this is the same
   * drift in the false-RED direction, and it costs the fleet just as much.
   */
  const auditPy = fileURLToPath(
    new URL('../../../../../papercusp-desktop/bin/audit-release-bundle.py', import.meta.url),
  );

  it('every username-shaped REDACTION_BY_KEY value is accepted by the box-identity matcher', () => {
    if (!existsSync(auditPy)) return; // submodule not checked out — nothing to compare against
    const src = readFileSync(auditPy, 'utf8');
    const block = /REDACTION_BY_KEY\s*=\s*\{([\s\S]*?)\}/.exec(src);
    expect(block, 'REDACTION_BY_KEY not found in audit-release-bundle.py').toBeTruthy();

    const values = [...block![1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);

    // A value that is a bare username token (no '/', no '@') can land in a `/home/<user>/`
    // position, so the matcher must treat it as naming nobody.
    for (const v of values.filter((x) => !x.includes('/') && !x.includes('@'))) {
      expect(
        GENERIC_USERS.has(v),
        `release scrubber emits "${v}" but GENERIC_USERS does not accept it — a file scrubbed ` +
          `with the sanctioned vocabulary would red check-no-box-identity`,
      ).toBe(true);
    }
  });

  it('our own redaction vocabulary is a subset of the scrubber’s', () => {
    if (!existsSync(auditPy)) return;
    const src = readFileSync(auditPy, 'utf8');
    const block = /REDACTION_BY_KEY\s*=\s*\{([\s\S]*?)\}/.exec(src);
    const pairs = new Map(
      [...block![1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    for (const [key, value] of Object.entries(IDENTITY_REDACTIONS)) {
      if (!pairs.has(key)) continue; // the audit does not police this key — nothing to agree on
      expect(pairs.get(key), `IDENTITY_REDACTIONS['${key}'] disagrees with REDACTION_BY_KEY`).toBe(
        value,
      );
    }
  });
});
