/**
 * CROSS-LANGUAGE guard for the turn-origin envelope grammar.
 *
 * The TypeScript sites now import `./envelope-grammar`, so `tsc` polices them.
 * Two sites are unreachable by any import and are what this file exists for:
 *
 *   • `apps/operator/scripts/psu-launcher.mjs`   — outside the TS package graph
 *   • `apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh`
 *                                                — a PYTHON `re.compile` in a shell hook
 *
 * The mechanism these replaced was a comment in each copy reading "change them
 * together" — i.e. human memory, which is exactly what failed one layer up for
 * the machine-surface catalogue (D-004).
 *
 * WHAT IS ASSERTED, and why it is behavioural rather than a string compare:
 * a string compare would fail on a harmless capture-group difference and pass on
 * a genuine dialect error, so each foreign pattern is EXECUTED against a shared
 * corpus and must produce the canonical accept/reject vector. `test 6` proves
 * the corpus can actually fail — without it, "every pattern agrees" is
 * indistinguishable from "the corpus discriminates nothing".
 *
 * The python site is additionally run through REAL python3: it is the only site
 * on a genuinely different regex engine, and re-running it in JS would assume
 * away the very thing under test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OWNER_CHAT_TURN_ORIGIN } from '../agent-tools/coordination/owner-chat-turn';
import {
  ENVELOPE_NONCE_CLASS,
  ENVELOPE_ORIGIN_CLASS,
  ENVELOPE_PATTERN_SOURCE,
  ENVELOPE_RE,
  ENVELOPE_STRIP_RE,
  envelopePatternSql,
  formatEnvelope,
} from './envelope-grammar';

// ── repo root ────────────────────────────────────────────────────────────────
function repoRoot(): string {
  let dir = resolve(__dirname);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('could not locate repo root from ' + __dirname);
}
const ROOT = repoRoot();

const LAUNCHER = join(ROOT, 'apps/operator/scripts/psu-launcher.mjs');
const HOOK = join(ROOT, 'apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh');
const PTY_HOST = join(ROOT, 'apps/operator/scripts/psu-pty-host.mjs');

/**
 * The shared corpus. Every copy of the grammar, in every language, must agree
 * on ALL of these. The rejects are the load-bearing half: each is a shape that
 * a plausible mis-typing would wrongly accept.
 */
const ACCEPT: readonly string[] = [
  '⟦turn-origin:wake-pump nonce:acc293aaced4a1d8⟧hello',
  '⟦turn-origin:loop-fire nonce:3e5488f31f95e81d⟧\nbody text',
  '  \n\t⟦turn-origin:self-compaction nonce:bae71371185ab21e⟧padded — TUIs pad',
  '⟦turn-origin:coord-inject:owner nonce:0123456789abcdef⟧colon in origin',
  '⟦turn-origin:a.b_c@d-e nonce:abcdef01⟧every legal origin char, min-length nonce',
  `⟦turn-origin:x nonce:${'a'.repeat(64)}⟧max-length nonce`,
];

const REJECT: readonly string[] = [
  // The single most important reject: mid-text is QUOTED CONTENT, not provenance.
  'the agent said: ⟦turn-origin:wake-pump nonce:acc293aaced4a1d8⟧',
  'x⟦turn-origin:wake-pump nonce:acc293aaced4a1d8⟧',
  // Nonce must be lowercase hex, 8..64.
  '⟦turn-origin:wake-pump nonce:ACC293AACED4A1D8⟧uppercase hex',
  '⟦turn-origin:wake-pump nonce:abcdef0⟧seven chars',
  `⟦turn-origin:wake-pump nonce:${'a'.repeat(65)}⟧sixty-five chars`,
  '⟦turn-origin:wake-pump nonce:acc293aaced4a1dz⟧non-hex char',
  // Structure.
  '⟦turn-origin:wake-pump⟧no nonce',
  '⟦turn-origin: nonce:acc293aaced4a1d8⟧empty origin',
  '⟦turn-source:wake-pump nonce:acc293aaced4a1d8⟧wrong tag',
  '⟦turn-origin:wake-pump  nonce:acc293aaced4a1d8⟧double space',
  '[[turn-origin:wake-pump nonce:acc293aaced4a1d8]]ascii brackets',
  '⟦turn-origin:wake-pump nonce:acc293aaced4a1d8 unterminated',
  '',
  'an ordinary owner turn with no envelope at all',
];

/** The accept/reject verdict vector a conforming pattern must produce. */
function vectorFor(test: (s: string) => boolean): boolean[] {
  return [...ACCEPT, ...REJECT].map(test);
}
const CANONICAL_VECTOR = vectorFor((s) => ENVELOPE_RE.test(s));

// ── extraction ───────────────────────────────────────────────────────────────
function read(path: string): string {
  expect(existsSync(path), `expected source site to exist: ${path}`).toBe(true);
  return readFileSync(path, 'utf8');
}

/** `const KICKOFF_ENVELOPE_RE = /…/;` → the pattern source. */
function extractJsLiteral(src: string, constName: string, file: string): string {
  const m = new RegExp(`${constName}\\s*=\\s*/(.+?)/[gimsuy]*\\s*;`).exec(src);
  expect(
    m,
    `${file}: could not find \`${constName} = /…/\`. If that site was renamed or ` +
      `deleted, UPDATE THIS GUARD — do not delete the assertion, or the copy it ` +
      `polices becomes unpoliced silently.`,
  ).not.toBeNull();
  return m![1];
}

/** `ENVELOPE_RE = re.compile(r'…')` → the pattern source. */
function extractPythonLiteral(src: string, file: string): string {
  const m = /ENVELOPE_RE\s*=\s*re\.compile\(\s*r'(.+?)'\s*\)/.exec(src);
  expect(
    m,
    `${file}: could not find \`ENVELOPE_RE = re.compile(r'…')\`. If the hook was ` +
      `restructured, UPDATE THIS GUARD rather than removing it.`,
  ).not.toBeNull();
  return m![1];
}

/** Strip capture-group parens so a capturing and non-capturing copy compare equal. */
function ungrouped(patternSource: string): string {
  return patternSource.replace(/\((\?:)?/g, '').replace(/\)/g, '');
}

describe('turn-origin envelope grammar — one definition across four languages', () => {
  it('1. the canonical corpus is non-degenerate (accepts all ACCEPT, rejects all REJECT)', () => {
    for (const s of ACCEPT) expect(ENVELOPE_RE.test(s), `should ACCEPT: ${JSON.stringify(s)}`).toBe(true);
    for (const s of REJECT) expect(ENVELOPE_RE.test(s), `should REJECT: ${JSON.stringify(s)}`).toBe(false);
  });

  it('2. the canonical matcher captures origin and nonce, and round-trips formatEnvelope', () => {
    const m = ENVELOPE_RE.exec(formatEnvelope('coord-inject:owner', 'acc293aaced4a1d8') + '\nbody');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('coord-inject:owner');
    expect(m![2]).toBe('acc293aaced4a1d8');
  });

  it('3. psu-launcher.mjs (JS, outside the TS package graph) agrees with the canonical grammar', () => {
    const src = read(LAUNCHER);
    const literal = extractJsLiteral(src, 'KICKOFF_ENVELOPE_RE', 'psu-launcher.mjs');

    // Text agreement (modulo capture groups) …
    expect(ungrouped(literal)).toBe(ungrouped(ENVELOPE_PATTERN_SOURCE));
    // … and, more importantly, behavioural agreement.
    const re = new RegExp(literal);
    expect(vectorFor((s) => re.test(s))).toEqual(CANONICAL_VECTOR);
  });

  it('4. the python-in-shell hook agrees — run through REAL python3, not re-simulated in JS', () => {
    const src = read(HOOK);
    const literal = extractPythonLiteral(src, 'userpromptsubmit-provenance.sh');
    expect(ungrouped(literal)).toBe(ungrouped(ENVELOPE_PATTERN_SOURCE));

    const program = [
      'import json,re,sys',
      'payload = json.loads(sys.stdin.read())',
      'rx = re.compile(payload["pattern"])',
      'print(json.dumps([bool(rx.match(s)) for s in payload["cases"]]))',
    ].join('\n');

    let out: string;
    try {
      out = execFileSync('python3', ['-c', program], {
        input: JSON.stringify({ pattern: literal, cases: [...ACCEPT, ...REJECT] }),
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      // Fail CLOSED. python3 is a hard dependency of the hook under test, so an
      // absent interpreter means this site is unverified — never a silent skip.
      throw new Error(
        `could not execute the hook's python pattern through python3, so the ` +
          `cross-language half of this guard did not run: ${String(err)}`,
      );
    }
    expect(JSON.parse(out) as boolean[]).toEqual(CANONICAL_VECTOR);
  });

  it('5a. the SQL copies in adv-agent-detail.ts equal the canonical POSIX rendering', () => {
    // This site stays LITERAL rather than importing: interpolating into the
    // tagged template would bind the pattern as a PARAMETER, which hides the
    // ordering rule from that query's own unit test (its fake tag captures only
    // the SQL text) and risks "could not determine data type of parameter" on an
    // untyped text-tilde comparison (WI-37757). So it is policed here instead —
    // the same treatment as the .mjs and python sites, for the same reason:
    // the site cannot import, but it must not drift silently either.
    const src = read(join(ROOT, 'packages/operator-core/lib/adv-agent-detail.ts'));
    const literals = [...src.matchAll(/text ~ '([^']*turn-origin[^']*)'/g)].map((m) => m[1]);

    expect(
      literals,
      'adv-agent-detail.ts no longer contains the envelope ordering patterns. If ' +
        'that query was removed, delete this assertion; if it moved, repoint it.',
    ).toHaveLength(2);
    expect(literals[0]).toBe(envelopePatternSql(OWNER_CHAT_TURN_ORIGIN));
    expect(literals[1]).toBe(envelopePatternSql());
  });

  it('5b. the Postgres POSIX dialect differs from JS in exactly the intended way', () => {
    const sql = envelopePatternSql();
    // POSIX has no \s. A JS pattern pasted into SQL matches nothing while looking
    // correct — a silent always-false branch — so assert the dialect explicitly.
    expect(sql).toContain('[[:space:]]');
    expect(sql).not.toContain('\\s');
    expect(sql).toContain(ENVELOPE_ORIGIN_CLASS);
    expect(sql).toContain(ENVELOPE_NONCE_CLASS);
    // A pinned origin narrows only the origin.
    expect(envelopePatternSql('coord-inject:owner')).toContain('turn-origin:coord-inject:owner ');
    expect(envelopePatternSql('coord-inject:owner')).not.toContain(ENVELOPE_ORIGIN_CLASS);
  });

  it('6. CALIBRATION — a deliberately-wrong pattern FAILS the corpus (so tests 3–4 mean something)', () => {
    const controls: Array<[string, string]> = [
      ['unanchored (accepts quoted content as provenance)', ENVELOPE_PATTERN_SOURCE.replace(/^\^/, '')],
      ['case-insensitive nonce', ENVELOPE_PATTERN_SOURCE.replace('a-f0-9', 'a-fA-F0-9')],
      ['origin class missing the colon', ENVELOPE_PATTERN_SOURCE.replace('[A-Za-z0-9:._@-]', '[A-Za-z0-9._@-]')],
      ['nonce lower bound dropped', ENVELOPE_PATTERN_SOURCE.replace('{8,64}', '{1,64}')],
    ];
    for (const [why, mutated] of controls) {
      const re = new RegExp(mutated);
      expect(vectorFor((s) => re.test(s)), `control should NOT match canonical: ${why}`).not.toEqual(
        CANONICAL_VECTOR,
      );
    }
  });

  it('7. PRODUCERS emit what the consumers accept (the .mjs producers are also un-importable)', () => {
    // A producer/consumer split is the same drift, one step earlier: a launcher
    // that emits an envelope the classifier does not recognise silently
    // downgrades machine turns to owner-typed.
    const producerLiterals: Array<[string, string]> = [
      ['psu-launcher.mjs', read(LAUNCHER)],
      ['psu-pty-host.mjs', read(PTY_HOST)],
    ];
    for (const [file, src] of producerLiterals) {
      const matches = [...src.matchAll(/`⟦turn-origin:([A-Za-z0-9:._@-]+) nonce:\$\{(\w+)\}⟧/g)];
      expect(matches.length, `${file}: expected at least one envelope producer literal`).toBeGreaterThan(0);
      for (const m of matches) {
        const emitted = `⟦turn-origin:${m[1]} nonce:acc293aaced4a1d8⟧\npayload`;
        const parsed = ENVELOPE_RE.exec(emitted);
        expect(parsed, `${file}: emits an envelope the canonical grammar rejects: ${emitted}`).not.toBeNull();
        expect(parsed![1]).toBe(m[1]);
      }
    }
  });

  it('9. DIFFERENTIAL — the swap is byte-equivalent to the patterns it replaced', () => {
    // This refactor touches the OWNER-VISIBILITY surface, where hiding a machine
    // row too few is recoverable but hiding the owner's own words is not. The
    // claim being made is "no behaviour change", and the right instrument for
    // that claim is not a live drive — it is a DIFFERENTIAL against the exact
    // patterns that were deleted. They are pinned here verbatim, as history.
    //
    // The one real hazard the swap introduces is CAPTURE ARITY: the strip site's
    // old pattern was non-capturing and the canonical one captures twice. That is
    // inert only because the two call sites are `.replace(re, '')` (no $n
    // backreferences) and `.match(re)?.[1]` (group 1 is still the origin) —
    // asserted below rather than assumed.
    const OLD_ENVELOPE_RE = /^\s*⟦turn-origin:([A-Za-z0-9:._@-]+) nonce:([a-f0-9]{8,64})⟧/;
    const OLD_STRIP_RE = /^\s*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧[ \t]*\r?\n?/;
    const OLD_CAPTURE_RE = /^\s*⟦turn-origin:([A-Za-z0-9:._@-]+) nonce:[a-f0-9]{8,64}⟧/;

    const corpus = [
      ...ACCEPT,
      ...REJECT,
      // Shapes that actually occur on this surface, including the over-hiding
      // direction: an OWNER turn whose body merely mentions the plumbing.
      '⟦turn-origin:coord-inject:owner nonce:abcdef12⟧\nI asked for this title.',
      '⟦turn-origin:loop-fire nonce:abcdef12⟧   \r\nAUTO mode wake instructions',
      '⟦turn-origin:wake-pump nonce:abcdef12⟧\t \nbody after tabs',
      'put yourself on auto mode and continue where you left off',
      'why does ⟦turn-origin:…⟧ show up in my chat?',
      '  Stop hook feedback: retry the command',
    ];

    for (const s of corpus) {
      // Strip site: identical output, including the trailing-newline consumption.
      expect(s.replace(ENVELOPE_STRIP_RE, ''), `strip differs for ${JSON.stringify(s)}`).toBe(
        s.replace(OLD_STRIP_RE, ''),
      );
      // Capture site: identical extracted origin (group 1), including undefined.
      expect(s.match(ENVELOPE_RE)?.[1], `origin differs for ${JSON.stringify(s)}`).toBe(
        s.match(OLD_CAPTURE_RE)?.[1],
      );
      // Classifier site: identical origin AND nonce.
      expect([s.match(ENVELOPE_RE)?.[1], s.match(ENVELOPE_RE)?.[2]]).toEqual([
        s.match(OLD_ENVELOPE_RE)?.[1],
        s.match(OLD_ENVELOPE_RE)?.[2],
      ]);
    }

    // The differential must be able to FAIL, or the loop above proves nothing.
    const mutant = /^\s*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧/; // drops the trailing run
    expect(ACCEPT.some((s) => s.replace(mutant, '') !== s.replace(OLD_STRIP_RE, ''))).toBe(true);
  });

  it('8. RECURRENCE GUARD — no NEW hand-typed copy of the grammar has appeared', () => {
    // The nonce class is a near-unique signature of a re-typed grammar. Exactly
    // these files may contain it: the canonical leaf, and the sites no import
    // can reach. One more means someone re-typed it again.
    //
    // EVERY non-leaf entry here is also covered by a BEHAVIOURAL assertion above
    // (tests 3, 4, 5a) — that pairing is the point. An allowlist entry on its own
    // would just be the "change them together" comment this guard replaced,
    // re-expressed as code.
    const allowed = new Set([
      'packages/operator-core/lib/turn-provenance/envelope-grammar.ts', // canonical
      'apps/operator/scripts/psu-launcher.mjs', // → test 3
      'apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh', // → test 4
      'packages/operator-core/lib/adv-agent-detail.ts', // → test 5a (POSIX/SQL literals)
      'packages/operator-core/lib/turn-provenance/envelope-grammar-cross-language.test.ts',
    ]);

    // `--untracked` is load-bearing: plain `git grep` searches only TRACKED
    // files, so a brand-new hand-typed copy would be invisible to this guard for
    // as long as it took the background git-sync to commit it — precisely the
    // window in which a fresh copy is most likely to be introduced. (Caught by
    // this test's own allowlist-rot assertion below, on this very file.)
    // Ignored paths stay excluded, which is what keeps built sidecar bundles out.
    const found = execFileSync(
      'git',
      ['grep', '--untracked', '-l', '--', 'a-f0-9\\]{8,64}'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // Built sidecar bundles are gitignored artifacts; belt-and-braces if that changes.
      .filter((p) => !p.includes('src-tauri/sidecar') && !p.includes('src-tauri/env-sidecars'));

    const unexpected = found.filter((p) => !allowed.has(p));
    expect(
      unexpected,
      `a new hand-typed copy of the envelope grammar appeared in: ` +
        `${unexpected.join(', ')}. Import ` +
        `\`envelope-grammar\` instead. If the site genuinely cannot import ` +
        `(a non-TS language), add it to BOTH this allowlist AND a behavioural ` +
        `assertion above — an allowlist entry on its own re-creates the ` +
        `"change them together" comment this guard replaced.`,
    ).toEqual([]);

    // And the allowlist must not rot: every entry must still exist and still match.
    for (const p of allowed) {
      if (p.endsWith('-cross-language.test.ts')) continue;
      expect(found, `allowlisted site no longer contains the grammar: ${p}`).toContain(p);
    }
  });
});
