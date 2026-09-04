/**
 * P-014 end-to-end against the REAL pinned binary.
 *
 * The unit suite proves the argv can never carry an apply flag and that the
 * line base is converted. That is necessary and not sufficient: it proves what
 * we ASK for, not what ast-grep DOES. This suite proves the two claims that are
 * only true of the real process —
 *
 *   1. the pinned binary parses structure rather than text (it must match a
 *      call split across lines, and must NOT match the same characters inside a
 *      string or a comment — the property that makes this leg worth having);
 *   2. a rewrite PREVIEW leaves the file byte-identical.
 *
 * Skips (rather than fails) when the binary is not provisioned, since
 * provisioning is environmental — but it asserts the SKIP REASON is a genuine
 * absence, never an impostor `sg` quietly satisfying the check.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  astGrepFacade,
  astGrepIdentity,
  resolveAstGrepBin,
} from './ast-grep-facade.ts';
import { isTrustworthyEmpty } from './contracts.ts';
import { runAstGrepFacadeLeg } from './code-intel-bench.ts';

const provisioned = resolveAstGrepBin() !== null;
const maybe = provisioned ? describe : describe.skip;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let dir: string;
let file: string;

/**
 * A fixture chosen so a TEXT search and a STRUCTURAL search give different
 * answers. `foo(` appears five times; only three are real calls.
 */
const FIXTURE = [
  'const a = foo(1);',
  'const b = foo(',
  '  2,',
  ');',
  'const c = bar(3);',
  'const s = "foo(9)";        // a string, not a call',
  '// const d = foo(4);       <- a comment, not a call',
  '',
].join('\n');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'astgrep-it-'));
  file = join(dir, 'probe.ts');
  writeFileSync(file, FIXTURE, 'utf8');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('provisioning', () => {
  it('reports a real identity, or a genuine absence — never an impostor', async () => {
    const id = await astGrepIdentity();
    if (provisioned) {
      expect(id.ok).toBe(true);
      if (!id.ok) return;
      expect(id.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(id.identity.bin).toContain('.papercusp/vendor/ast-grep');
    } else {
      expect(id.ok).toBe(false);
      if (id.ok) return;
      // The absence must be reported as NOT PROVISIONED, and must not have been
      // satisfied by /usr/bin/sg.
      expect(id.reason).toContain('not provisioned');
    }
  });
});

maybe('structural search against the real pinned binary', () => {
  it('matches a call SPLIT ACROSS LINES, which a line-oriented text search cannot', async () => {
    const answer = await astGrepFacade('search', {
      pattern: 'foo($X)',
      language: 'ts',
      paths: [file],
      rootPath: dir,
    });
    expect(answer.error).toBeNull();
    expect(answer.backend).toBe('ast-grep');
    // Lines 1 and 2 (one-indexed): the single-line call and the wrapped one.
    expect(answer.sites.map((s) => s.line1)).toEqual([1, 2]);
  });

  it('does NOT match the same characters inside a string or a comment', async () => {
    const answer = await astGrepFacade('search', {
      pattern: 'foo($X)',
      language: 'ts',
      paths: [file],
      rootPath: dir,
    });
    const lines = answer.sites.map((s) => s.line1);
    expect(lines).not.toContain(6); // the string  "foo(9)"
    expect(lines).not.toContain(7); // the commented-out call
  });

  it('CONTROL: a plain text scan DOES hit the string and the comment', () => {
    // The instrument that makes the assertion above meaningful — if a naive
    // text match also skipped these, the structural claim would be untested.
    const hits = FIXTURE.split('\n')
      .map((l, i) => (l.includes('foo(') ? i + 1 : null))
      .filter((n): n is number => n !== null);
    expect(hits).toContain(6);
    expect(hits).toContain(7);
  });

  it('an empty match set from a healthy run is a TRUSTWORTHY empty', async () => {
    const answer = await astGrepFacade('search', {
      pattern: 'thisIdentifierAppearsNowhere($X)',
      language: 'ts',
      paths: [file],
      rootPath: dir,
    });
    expect(answer.error).toBeNull();
    expect(answer.sites).toEqual([]);
    expect(isTrustworthyEmpty(answer)).toBe(true);
  });

  it('reports paths relative to the root, not as absolute temp paths', async () => {
    const answer = await astGrepFacade('search', {
      pattern: 'bar($X)',
      language: 'ts',
      paths: [file],
      rootPath: dir,
    });
    expect(answer.sites.map((s) => s.path)).toEqual(['probe.ts']);
  });
});

maybe('rewrite PREVIEW leaves the file byte-identical', () => {
  it('reports what each site would become and writes nothing', async () => {
    const before = readFileSync(file, 'utf8');
    const answer = await astGrepFacade('rewrite_preview', {
      pattern: 'foo($X)',
      language: 'ts',
      rewrite: 'baz($X)',
      paths: [file],
      rootPath: dir,
    });
    expect(answer.error).toBeNull();
    expect(answer.sites.length).toBeGreaterThan(0);
    // MEASURED 2026-08-21 at ast-grep 0.45.1, and NOT what I first expected:
    // the wrapped `foo(\n  2,\n)` previews as a single-line `baz(2)`. A rewrite
    // is rendered from the TEMPLATE with the captured metavariables substituted
    // in, so it does NOT preserve the matched site's original formatting — a
    // codemod REFLOWS what it touches. Worth pinning as a test rather than
    // discovering it in a 500-file diff review.
    expect(answer.sites.map((s) => s.detail)).toEqual(['baz(1)', 'baz(2)']);
    // THE PROPERTY.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE);
  });

  it('refuses a rewrite_preview with no rewrite, rather than silently searching', async () => {
    const answer = await astGrepFacade('rewrite_preview', {
      pattern: 'foo($X)',
      language: 'ts',
      paths: [file],
      rootPath: dir,
    });
    expect(answer.error).toContain('requires');
    expect(answer.sites).toEqual([]);
    // A refusal must never read as "no matches".
    expect(isTrustworthyEmpty(answer)).toBe(true);
  });
});

maybe('ast-grep acceptance bench leg', () => {
  it('grades a real repository structural call and a byte-identical rewrite preview', async () => {
    const report = await runAstGrepFacadeLeg({ repoRoot: REPO_ROOT });

    expect(report.search.error).toBeNull();
    expect(report.searchGrade.correct).toBe(true);
    expect(report.preview.error).toBeNull();
    expect(report.previewGrade.correct).toBe(true);
    expect(report.sourceByteIdentical).toBe(true);
    expect(report.correct).toBe(true);
  }, 120_000);
});
