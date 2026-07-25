/**
 * check-conflict-markers-guard.test.ts — the committed-conflict-marker guard's
 * detector (EI-1836).
 *
 * The guard (`scripts/check-conflict-markers.mjs`) runs green over the real tracked
 * tree in CI, proving the no-FALSE-POSITIVE direction on the live corpus. This locks
 * the two things a clean-tree run can't prove:
 *   1. it FLAGS each git conflict BRACKET at line start (<<<, >>>, ||| diff3) — the
 *      2026-06-20 globals.css break that froze the whole fleet deploy + the WI-280
 *      witness on a cryptic CssSyntaxError;
 *   2. it does NOT false-positive on the shapes that look marker-ish but are valid —
 *      a bare `=======` separator (a 7-wide markdown setext underline is exactly
 *      that, so it is DELIBERATELY excluded; the brackets already catch every
 *      conflict), a too-short bracket run, a mid-line bracket, or normal code.
 *
 * Markers are built with `.repeat(7)` so this test's own source carries no
 * line-start bracket run — keeping the guard green on the test file itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only. Single-line
// so the @ts-ignore covers the module-specifier line (TS7016 anchors there on a multiline import).
import { findConflictMarker, CONFLICT_MARKER_ERE, isDirectCliInvocation, walkFallback } from '../../../../scripts/check-conflict-markers.mjs';

const B = (c: string) => c.repeat(7); // a 7-char bracket run, without a literal marker here

describe('check-conflict-markers guard detector (EI-1836)', () => {
  it('FLAGS a <<< start marker (with the right line)', () => {
    const hit = findConflictMarker('f.css', `selector {}\n${B('<')} Updated upstream\ncolor: red;`);
    expect(hit).not.toBeNull();
    expect(hit.line).toBe(2);
    expect(hit.marker).toBe(B('<'));
  });

  it('FLAGS a >>> end marker', () => {
    expect(findConflictMarker('f.ts', `${B('>')} Stashed changes`)).toMatchObject({ line: 1 });
  });

  it('FLAGS a ||| diff3 base marker', () => {
    expect(findConflictMarker('f.ts', `a\nb\n${B('|')} base`)).toMatchObject({ line: 3 });
  });

  it('FLAGS a bare bracket run with no label (EOL)', () => {
    expect(findConflictMarker('f.ts', B('<'))).toMatchObject({ line: 1 });
  });

  it('does NOT flag a lone ======= separator (DELIBERATE exclusion — FP-prone)', () => {
    // A 7-wide markdown setext underline / ASCII divider is exactly `=======`; the
    // brackets above already catch every real conflict, so flagging it adds only FPs.
    expect(findConflictMarker('f.md', `Heading\n${B('=')}\nbody`)).toBeNull();
  });

  it('does NOT flag a too-short bracket run (6 < 7)', () => {
    expect(findConflictMarker('f.ts', `${'<'.repeat(6)} HEAD`)).toBeNull();
  });

  it('does NOT flag a mid-line bracket run', () => {
    expect(findConflictMarker('f.ts', `see ${B('<')} HEAD in a comment`)).toBeNull();
  });

  it('does NOT flag normal code / markdown (--- rule, >> shift, ## heading)', () => {
    expect(findConflictMarker('f.ts', '---\nconst x = a >> b;\n## Heading\n>>> not seven')).toBeNull();
  });

  it('returns the FIRST marker when several are present', () => {
    expect(findConflictMarker('f.ts', `x\n${B('<')} HEAD\ny\n${B('>')} branch`)).toMatchObject({ line: 2 });
  });

  it('the exported ERE compiles to a JS regex that agrees with the detector (single source of truth)', () => {
    // The CLI scan feeds git grep this ERE; the detector builds its RegExp from the
    // same string. Pin that they agree so the fast pre-filter can never diverge from
    // the precise check.
    const re = new RegExp(CONFLICT_MARKER_ERE);
    expect(re.test(`${B('<')} HEAD`)).toBe(true);
    expect(re.test(`${B('>')}`)).toBe(true);
    expect(re.test(B('='))).toBe(false); // separator excluded
    expect(re.test(`${'<'.repeat(6)} HEAD`)).toBe(false);
  });

  describe('isDirectCliInvocation (WI-5702)', () => {
    // The self-invocation guard decides whether `main()` (which runs `git grep`
    // over the tree) fires on import. It must fire ONLY for a genuine
    // `node .../check-conflict-markers.mjs` CLI run, and MUST NOT be fooled by
    // `import.meta.url` — which the desktop sidecar's esbuild single-file bundle
    // rewrites to the OUTPUT file's own URL for every inlined module, including
    // this one (imported transitively via content-lint/conflict-markers.ts). A
    // bundled `serve.mjs` boot crashed the sidecar on exactly this false-fire:
    // `git grep` ran against the installed (non-git) package dir and threw
    // "fatal: not a git repository", aborting Postgres startup mid-boot.

    it('MATCHES a direct CLI path', () => {
      expect(isDirectCliInvocation('/repo/scripts/check-conflict-markers.mjs')).toBe(true);
      expect(isDirectCliInvocation('scripts/check-conflict-markers.mjs')).toBe(true);
    });

    it('does NOT match the bundled desktop sidecar entry (the WI-5702 false-fire)', () => {
      // This is the exact process.argv[1] a packaged sidecar boots with — this
      // module's code is inlined into that same file, but must never self-run.
      expect(
        isDirectCliInvocation('/usr/lib/Papercusp Server/sidecar/serve.mjs'),
      ).toBe(false);
    });

    it('does NOT match an unrelated or missing entry path', () => {
      expect(isDirectCliInvocation('/repo/node_modules/.bin/vitest')).toBe(false);
      expect(isDirectCliInvocation(undefined)).toBe(false);
      expect(isDirectCliInvocation('')).toBe(false);
    });
  });

  describe('walkFallback (WI-5769 — no-.git VM build trees)', () => {
    // mac-vm-verify-build.sh / release-local.sh rsync a HEAD snapshot to the build
    // VM with `--exclude '.git'` BY DESIGN, so `git grep` always fails there with
    // "not a git repository" — not because anything is actually wrong. Before this
    // fix that fataled the whole sidecar build on every such snapshot build. This
    // exercises the real filesystem walk the fallback uses instead of `git grep`,
    // against a genuine temp directory (no `.git` present), proving it still finds
    // a committed marker while skipping vendor/build dirs and binary extensions —
    // the exact shape of tree a VM build sees.
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('finds a marker in an ordinary tracked-shaped file', () => {
      dir = mkdtempSync(join(tmpdir(), 'ccm-fallback-'));
      const B = (c: string) => c.repeat(7);
      writeFileSync(join(dir, 'clean.ts'), 'const x = 1;\n');
      writeFileSync(join(dir, 'broken.css'), `selector {}\n${B('<')} Updated upstream\ncolor: red;`);

      const out: string[] = [];
      walkFallback(dir, out);

      expect(out).toContain(join(dir, 'broken.css'));
      expect(out).toContain(join(dir, 'clean.ts'));
    });

    it('skips excluded vendor/build directories (node_modules, .git, target, dist, ...)', () => {
      dir = mkdtempSync(join(tmpdir(), 'ccm-fallback-'));
      const B = (c: string) => c.repeat(7);
      for (const excludedDir of ['node_modules', '.git', 'target', 'dist', 'build', '.next']) {
        const sub = join(dir, excludedDir);
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'hidden.ts'), `${B('>')} should never be seen`);
      }
      writeFileSync(join(dir, 'visible.ts'), 'const y = 2;\n');

      const out: string[] = [];
      walkFallback(dir, out);

      expect(out).toEqual([join(dir, 'visible.ts')]);
    });

    it('skips binary-ish extensions (png, dylib, wasm, ...) even inside included dirs', () => {
      dir = mkdtempSync(join(tmpdir(), 'ccm-fallback-'));
      writeFileSync(join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(dir, 'lib.dylib'), Buffer.from([0x00, 0x01]));
      writeFileSync(join(dir, 'source.ts'), 'const z = 3;\n');

      const out: string[] = [];
      walkFallback(dir, out);

      expect(out).toEqual([join(dir, 'source.ts')]);
    });

    it('does not follow symlinks (avoids cycles / escaping the snapshot root)', () => {
      dir = mkdtempSync(join(tmpdir(), 'ccm-fallback-'));
      const real = mkdtempSync(join(tmpdir(), 'ccm-fallback-target-'));
      writeFileSync(join(real, 'outside.ts'), 'const outside = true;\n');
      writeFileSync(join(dir, 'inside.ts'), 'const inside = true;\n');
      symlinkSync(real, join(dir, 'link-to-outside'));

      const out: string[] = [];
      walkFallback(dir, out);

      expect(out).toEqual([join(dir, 'inside.ts')]);
      rmSync(real, { recursive: true, force: true });
    });

    it('recurses into ordinary nested directories and finds a marker several levels deep', () => {
      dir = mkdtempSync(join(tmpdir(), 'ccm-fallback-'));
      const B = (c: string) => c.repeat(7);
      const nested = join(dir, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'deep.ts'), `x\n${B('|')} base\ny`);

      const out: string[] = [];
      walkFallback(dir, out);

      expect(out).toContain(join(nested, 'deep.ts'));
      // and the detector itself confirms the marker is actually flagged
      const hit = findConflictMarker('deep.ts', `x\n${B('|')} base\ny`);
      expect(hit).toMatchObject({ line: 2 });
    });
  });
});
