/**
 * Recurrence guard for WI-38233 — AUTHORISED_PRODUCT_STRINGS must accept the two
 * product strings that legitimately embed the owner's handle WITHOUT becoming a
 * hole in the identity gate.
 *
 * WHY THE ACCEPTANCE EXISTS (measured on the 0.0.16 cut, not hypothesised): the
 * handle entered KNOWN_SENSITIVE_IDENTITIES 43 minutes AFTER 0.0.15 shipped, so
 * 0.0.16 was the first cut to be judged by it and it red 5 files on 7 hits. Four
 * of those hits were INCIDENTAL (a UI placeholder, a test workspace name in a
 * prose string) and were fixed at SOURCE — that is the default and must stay the
 * default. The remaining two ship on purpose: the Cupboard worker host (the handle
 * is the Cloudflare account subdomain, so it is in a hostname the app must resolve
 * — scrubbing it hides nothing and breaks the client) and the hive-invite team
 * allowlist (scrubbing it breaks invites).
 *
 * WHAT THIS GUARD ACTUALLY PINS — an acceptance is one bad refactor away from
 * being an exclude, and the gate's own remedy text forbids excludes. The rule is
 * ARITHMETIC: count every occurrence of a literal, count how many sit inside an
 * authorised string, accept ONLY on equality. So the load-bearing case here is not
 * "the authorised file passes" — it is `authorised + ONE bare occurrence STILL
 * FAILS`. If that ever flips, an authorised string becomes a whitewash token: drop
 * it anywhere in a file and every other leak in that file goes quiet.
 *
 * It also pins a bug this change introduced and caught before shipping: the first
 * implementation counted literals as PLAIN SUBSTRINGS while the scan matches the
 * low-entropy one on a WORD BOUNDARY. On the real serve.mjs that low-entropy
 * literal occurs 15x as a substring (inside ordinary English words) and 0x as a
 * word-boundary match, so the arithmetic saw 15 phantom unaccounted occurrences
 * and the acceptance was unreachable for any real bundle. `_count_literal` must
 * mirror `grep_l`'s text/binary + word-boundary asymmetry exactly.
 *
 * WHY EVERY LITERAL IS DERIVED AT RUNTIME, NEVER HARDCODED: `check-no-identity-
 * literals` scans superproject source for these values, so writing one into this
 * file would red the green-checkpoint the tick it landed — the guard would break
 * the gate it guards. Reading them out of the gate also means a newly-added
 * authorised string is covered automatically instead of drifting.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
/**
 * Overridable SO THAT THIS GUARD CAN BE PROVEN FALSIFIABLE without mutating the
 * shared tree — point it at a copy of the gate whose acceptance is widened to a
 * plain `if any authorised string is present` and the whitewash assertion below
 * must FAIL. A tree-mutating probe is not an option: git-sync sweeps the whole
 * tree on a timer and would commit the mutant even if nothing went wrong.
 */
const GATE =
  process.env.PAPERCUSP_IDENTITY_GATE_PATH ??
  path.join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

function gateSource(): string {
  return readFileSync(GATE, 'utf8');
}

function have(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
}

/** The authorised product strings, read from the gate itself (values, at runtime). */
function authorisedStrings(): string[] {
  const block = gateSource().match(/AUTHORISED_PRODUCT_STRINGS\s*=\s*\(([\s\S]*?)\n\)/)?.[1];
  if (!block) throw new Error('AUTHORISED_PRODUCT_STRINGS not found — gate structure changed');
  return [...block.matchAll(/^\s*(?:"([^"]+)"|'([^']+)')\s*,/gm)].map((m) => m[1] ?? m[2]);
}

/**
 * The gate's own literal table: `literal<TAB>redaction<TAB>isLowEntropy`.
 * Using the gate as the source means the fixtures below are built from exactly
 * the values it will hunt on THIS box.
 */
function identityRows(): { literal: string; low: boolean }[] {
  const run = spawnSync('python3', [GATE, '--identity-literals'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`--identity-literals failed: ${run.stderr}`);
  return run.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.split('\t'))
    .map(([literal, , flag]) => ({ literal, low: flag === '1' }));
}

/** A high-entropy literal that appears inside an authorised string. */
function authorisedPair(): { authorised: string; literal: string } {
  const rows = identityRows().filter((r) => !r.low);
  for (const authorised of authorisedStrings()) {
    const hit = rows.find((r) => authorised.includes(r.literal));
    if (hit) return { authorised, literal: hit.literal };
  }
  throw new Error('no authorised string contains a hunted literal — acceptance is vacuous');
}

function scan(files: Record<string, string>): { status: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pc-authorised-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), body);
    }
    const run = spawnSync('python3', [GATE, '--scan-dir', dir], { encoding: 'utf8' });
    return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release identity gate: authorised product strings (WI-38233)', () => {
  it('declares a non-empty AUTHORISED_PRODUCT_STRINGS', () => {
    // An empty tuple is not merely inert: it means the acceptance was deleted and
    // the next cut reds on the two strings that legitimately ship.
    expect(authorisedStrings().length).toBeGreaterThan(0);
  });

  it('every authorised string actually contains a hunted identity literal', () => {
    // An entry that contains no hunted literal accepts nothing and is dead weight
    // — usually the fingerprint of a value that was scrubbed at source instead.
    if (!have('python3')) return;
    const rows = identityRows().map((r) => r.literal);
    for (const s of authorisedStrings()) {
      expect(rows.some((lit) => s.includes(lit)), `authorised string matches no literal: ${s}`).toBe(
        true,
      );
    }
  });

  it('ACCEPTS a file whose only identity hits are authorised strings', () => {
    if (!have('python3')) {
      console.warn('[authorised-strings guard] SKIPPED: python3 unavailable');
      return;
    }
    const { authorised } = authorisedPair();
    const { status, out } = scan({ 'clean.js': `const a = ${JSON.stringify(authorised)};\n` });
    expect(out).toMatch(/ACCEPTED \d+ file\(s\) whose ONLY identity hits are authorised/);
    expect(out).not.toMatch(/MUST NOT SHIP/);
    expect(status).toBe(0);
  });

  it('STILL FAILS when one bare occurrence sits beside an authorised string', () => {
    // ⚠ THE LOAD-BEARING ASSERTION. If this flips, an authorised string becomes a
    // whitewash token — paste it into any file and that file's real leaks go quiet.
    if (!have('python3')) {
      console.warn('[authorised-strings guard] SKIPPED: python3 unavailable');
      return;
    }
    const { authorised, literal } = authorisedPair();
    const { status, out } = scan({
      'leaky.js': `const a = ${JSON.stringify(authorised)};\nconst b = "hello ${literal} world";\n`,
    });
    expect(out).toMatch(/MUST NOT SHIP/);
    expect(out).toMatch(/leaky\.js/);
    expect(status).toBe(1);
  });

  it('still FAILS a bare leak with no authorised string present', () => {
    // The non-vacuity control: proves the fixture harness can produce a red at all,
    // so the green above is evidence rather than an artefact of a broken scan.
    if (!have('python3')) return;
    const { literal } = authorisedPair();
    const { status, out } = scan({ 'bare.js': `const b = "contact ${literal}";\n` });
    expect(out).toMatch(/MUST NOT SHIP/);
    expect(status).toBe(1);
  });

  it('counts the low-entropy literal on a WORD BOUNDARY, as the scan matches it', () => {
    // Pins the substring-vs-word-boundary bug described in the header: the literal
    // embedded inside a longer alphanumeric token is NOT a hit, so a file carrying
    // only that plus an authorised string must still be ACCEPTED. Counting it as a
    // plain substring makes the acceptance unreachable for any real bundle.
    if (!have('python3')) return;
    const low = identityRows().find((r) => r.low);
    if (!low) {
      console.warn('[authorised-strings guard] SKIPPED: no low-entropy literal on this box');
      return;
    }
    const { authorised } = authorisedPair();
    const embedded = `${low.literal}ailable`; // e.g. a word merely STARTING with it
    const { status, out } = scan({
      'wordy.js': `const a = ${JSON.stringify(authorised)};\nconst w = "${embedded}";\n`,
    });
    expect(out).not.toMatch(/MUST NOT SHIP/);
    expect(status).toBe(0);
  });
});
