import { describe, expect, it } from 'vitest';
import { createDevWatchIgnore } from './dev-watch-ignore';

const VITE_ROOT = '/repo/apps/operator-vite';
const OPERATOR_ROOT = '/repo/apps/operator';

const ignore = createDevWatchIgnore({ viteRoot: VITE_ROOT, operatorRoot: OPERATOR_ROOT });

describe('createDevWatchIgnore', () => {
  describe('build output (dist/)', () => {
    it('ignores the dist root itself, so chokidar never walks into it', () => {
      // Matching only `dist/**` would still cost a full walk of the tree below
      // it — the root must match for the walk to be skipped.
      expect(ignore(`${VITE_ROOT}/dist`)).toBe(true);
    });

    it('ignores files and nested dirs under dist/', () => {
      expect(ignore(`${VITE_ROOT}/dist/assets/index-a1b2c3.js`)).toBe(true);
      expect(ignore(`${VITE_ROOT}/dist/internal/docs/agent-insights/foo.html`)).toBe(true);
    });

    it('does not ignore a sibling whose name merely starts with "dist"', () => {
      expect(ignore(`${VITE_ROOT}/dist-notes/readme.md`)).toBe(false);
      expect(ignore(`${VITE_ROOT}/distribution.ts`)).toBe(false);
    });

    it('does not ignore a dist/ belonging to some other package', () => {
      // Only THIS root's build output is dead weight to this dev server.
      expect(ignore('/repo/packages/operator-core/dist/index.js')).toBe(false);
    });
  });

  describe('built docs site under publicDir', () => {
    it('ignores the docs root and everything beneath it', () => {
      expect(ignore(`${OPERATOR_ROOT}/public/internal/docs`)).toBe(true);
      expect(ignore(`${OPERATOR_ROOT}/public/internal/docs/index.html`)).toBe(true);
    });

    it('ignores pagefind shards, the single largest category', () => {
      expect(
        ignore(`${OPERATOR_ROOT}/public/internal/docs/pagefind/fragment/en_1a2b3c.pf_fragment`),
      ).toBe(true);
    });

    it('does not ignore a sibling caught only by a loose prefix', () => {
      // Guards the strict `docs/` match — a bare startsWith('…/docs') would
      // swallow this.
      expect(ignore(`${OPERATOR_ROOT}/public/internal/docs-authoring/draft.md`)).toBe(false);
    });

    it('keeps watching the rest of publicDir', () => {
      expect(ignore(`${OPERATOR_ROOT}/public/wordmark.svg`)).toBe(false);
    });
  });

  describe('docs-swap leftovers (`*.old.<pid>`)', () => {
    it('ignores a leftover tree under publicDir', () => {
      expect(ignore(`${OPERATOR_ROOT}/public/internal/docs.old.160411`)).toBe(true);
      expect(ignore(`${OPERATOR_ROOT}/public/internal/docs.old.160411/foo/bar.md`)).toBe(true);
    });

    it('ignores a leftover that got copied into dist as well', () => {
      expect(ignore(`${VITE_ROOT}/dist/internal/docs.old.160411/x.html`)).toBe(true);
    });

    it('ignores a leftover anywhere, not just the two known sites', () => {
      // The producing swap is generic (`mv DEST DEST.old.$$`), so the rule is too.
      expect(ignore('/repo/somewhere/else/assets.old.98765/thing.js')).toBe(true);
    });

    it('requires a numeric pid suffix, so real filenames are not swallowed', () => {
      expect(ignore('/repo/apps/operator/lib/thing.old.ts')).toBe(false);
      expect(ignore('/repo/apps/operator/lib/migration.old.backup/x.ts')).toBe(false);
    });
  });

  describe('source files — the watches we actually want', () => {
    it.each([
      `${OPERATOR_ROOT}/app/routes/index.tsx`,
      `${VITE_ROOT}/src/main.tsx`,
      `${VITE_ROOT}/vite.config.ts`,
      '/repo/packages/operator-core/lib/sync-resolver/index.ts',
      '/repo/libs/flags/src/types.ts',
    ])('keeps watching %s', (p) => {
      expect(ignore(p)).toBe(false);
    });
  });

  it('normalises Windows separators', () => {
    const winIgnore = createDevWatchIgnore({
      viteRoot: 'C:/repo/apps/operator-vite',
      operatorRoot: 'C:/repo/apps/operator',
    });
    expect(winIgnore('C:\\repo\\apps\\operator-vite\\dist\\assets\\x.js')).toBe(true);
    expect(winIgnore('C:\\repo\\apps\\operator-vite\\src\\main.tsx')).toBe(false);
  });
});
