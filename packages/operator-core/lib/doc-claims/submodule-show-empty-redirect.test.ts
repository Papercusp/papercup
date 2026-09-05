/**
 * Pins CLAUDE.md's `git show <ref>:<submodule path> > file` caveat (EI-21215681517579616).
 *
 * The trap: the SHELL creates the redirect before git runs, so a failing extraction
 * still leaves a ZERO-BYTE file. A positive control built from that file — "the stale
 * string should still be present in the committed version, proving my grep works" —
 * then returns 0, which is the exact reading that means "already gone / pattern wrong".
 * It is the false-zero family, and it defeats the one check meant to catch a broken
 * instrument.
 *
 * Sibling of `submodule-blob-containment.test.ts` — same P-004 family, same structure,
 * and the FIXTURE CONTROLS are load-bearing for the same reason: once the live
 * assertions go green they stop being evidence that the detector works at all.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The load-bearing halves of the caveat: the WARNING and the REMEDY command. */
const CLAIM_MARKER = 'ZERO-BYTE file behind';
const REMEDY_MARKER = 'git -C libs/papercusp show';

const git = (args: readonly string[], cwd: string = ROOT) =>
  spawnSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    // WI-41180: a sync spawn blocks the pure lane's shared worker event loop, so vitest
    // cannot time it out on its own.
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });

type Doc = { path: string; text: string };
type Verdict = { docsMissingClaim: string[]; docsMissingRemedy: string[] };

/** Pure judge, so the fixture controls below can drive it without touching disk. */
const judgeCaveat = (docs: readonly Doc[]): Verdict => ({
  docsMissingClaim: docs.filter((d) => !d.text.includes(CLAIM_MARKER)).map((d) => d.path),
  docsMissingRemedy: docs.filter((d) => !d.text.includes(REMEDY_MARKER)).map((d) => d.path),
});

const GOOD_DOC_BODY = `> ⛔ **\`git show\` leaves a ${CLAIM_MARKER}, so a control reports 0.**\n> \`${REMEDY_MARKER} "HEAD:x" > /tmp/before || exit 1\``;

/** Submodule paths that are genuinely mode 160000 at HEAD. */
const gitlinkSubmodules = (): string[] =>
  (git(['ls-files', '--stage']).stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.split('\t')[1] ?? '')
    .filter(Boolean);

/** A real committed file inside `sub`, derived rather than hardcoded so a moved file cannot rot this test. */
const firstBlobIn = (sub: string): string | null => {
  const out = git(['ls-tree', '-r', '--name-only', 'HEAD'], join(ROOT, sub)).stdout ?? '';
  return out.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? null;
};

describe('CLAUDE.md submodule `git show` empty-redirect caveat', () => {
  describe('fixture controls — prove the detector can actually fail', () => {
    it('catches the claim being dropped while the premises still hold', () => {
      const v = judgeCaveat([{ path: 'CLAUDE.md', text: 'some other prose entirely' }]);
      expect(v.docsMissingClaim).toEqual(['CLAUDE.md']);
    });

    it('catches a doc that keeps the WARNING but loses the REMEDY command', () => {
      const v = judgeCaveat([{ path: 'CLAUDE.md', text: `> ${CLAIM_MARKER} and nothing else` }]);
      expect(v.docsMissingRemedy).toEqual(['CLAUDE.md']);
      expect(v.docsMissingClaim).toEqual([]);
    });

    it('catches the caveat surviving in ONE projection but not its twin', () => {
      const v = judgeCaveat([
        { path: 'CLAUDE.md', text: GOOD_DOC_BODY },
        { path: 'AGENTS.md', text: 'twin lost the caveat' },
      ]);
      expect(v.docsMissingClaim).toEqual(['AGENTS.md']);
    });

    it('a healthy pair flags nothing', () => {
      const v = judgeCaveat([
        { path: 'CLAUDE.md', text: GOOD_DOC_BODY },
        { path: 'AGENTS.md', text: GOOD_DOC_BODY },
      ]);
      expect(v).toEqual({ docsMissingClaim: [], docsMissingRemedy: [] });
    });
  });

  describe('live: the premises still hold, and both projections still carry the caveat', () => {
    it('both CLAUDE.md and AGENTS.md carry the warning AND the remedy', () => {
      const docs = ['CLAUDE.md', 'AGENTS.md'].map((p) => ({
        path: p,
        text: readFileSync(join(ROOT, p), 'utf8'),
      }));
      expect(judgeCaveat(docs)).toEqual({ docsMissingClaim: [], docsMissingRemedy: [] });
    });

    it('the premise still holds: a superproject `git show` of a submodule path fails AND emits nothing', () => {
      const subs = gitlinkSubmodules();
      // If this repo ever stops using submodules the caveat is moot — fail loudly
      // rather than passing vacuously against an empty population.
      expect(subs.length, 'no gitlink submodules — caveat premise vanished').toBeGreaterThan(0);

      const sub = subs.find((s) => firstBlobIn(s));
      expect(sub, 'no submodule with a committed file to probe').toBeTruthy();
      const rel = firstBlobIn(sub as string) as string;

      const bad = git(['show', `HEAD:${sub}/${rel}`]);
      expect(bad.status, 'superproject show of a submodule path should FAIL').not.toBe(0);
      expect(bad.stdout ?? '').toBe('');
    });

    it('the trap itself: a failing extraction still leaves a zero-byte file behind', () => {
      const subs = gitlinkSubmodules();
      const sub = subs.find((s) => firstBlobIn(s)) as string;
      const rel = firstBlobIn(sub) as string;
      const dir = mkdtempSync(join(tmpdir(), 'submodule-show-trap-'));
      const out = join(dir, 'before.txt');

      // The documented shape, verbatim: redirect WITHOUT an exit-status check.
      spawnSync('sh', ['-c', `git show "HEAD:${sub}/${rel}" > "${out}" 2>/dev/null`], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });

      expect(existsSync(out), 'the shell creates the redirect even when git fails').toBe(true);
      expect(statSync(out).size, 'that file is empty — a grep -c on it returns 0').toBe(0);
    });

    it('the documented REMEDY works: extracting inside the submodule yields real content', () => {
      const subs = gitlinkSubmodules();
      const sub = subs.find((s) => firstBlobIn(s)) as string;
      const rel = firstBlobIn(sub) as string;

      const good = git(['show', `HEAD:${rel}`], join(ROOT, sub));
      expect(good.status, 'in-submodule show with a submodule-relative path should succeed').toBe(0);
      expect((good.stdout ?? '').length).toBeGreaterThan(0);
    });
  });
});
