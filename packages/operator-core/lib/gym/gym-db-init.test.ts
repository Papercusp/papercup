/**
 * Regression: gym migration-dir resolution must be depth-independent (EI-8689).
 *
 * `MAIN_SQL_DIR` used a fixed `../../../..` relative path calibrated for the
 * SOURCE layout (`packages/operator-core/lib/gym`, four levels below the repo
 * root). When operator-core is BUNDLED into `apps/operator/dist-host/…`, the
 * bundle's `import.meta.url` sits only THREE levels below the repo root, so
 * up-four overshot to `<workspace>/libs/papercusp/libs/db/sql` — which does not
 * exist — and every gym-cycle autoloop fire died with `ENOENT: scandir` (14
 * consecutive reds on gymloopharness). `resolveMainSqlDir` walks up to the real
 * marker instead, so it resolves correctly from both depths.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MAIN_SQL_DIR, resolveMainSqlDir } from './gym-db-init';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR_REL = join('libs', 'papercusp', 'libs', 'db', 'sql');

describe('resolveMainSqlDir', () => {
  it('MAIN_SQL_DIR points at a real migration tree with the baseline', () => {
    expect(existsSync(MAIN_SQL_DIR)).toBe(true);
    expect(MAIN_SQL_DIR.endsWith(SQL_DIR_REL)).toBe(true);
    expect(existsSync(join(MAIN_SQL_DIR, '000-baseline.sql'))).toBe(true);
  });

  it('resolves from the source depth (packages/operator-core/lib/gym)', () => {
    // HERE is the real source dir; the resolver must find the marker above it.
    const resolved = resolveMainSqlDir(HERE);
    expect(existsSync(resolved)).toBe(true);
    expect(resolved.endsWith(SQL_DIR_REL)).toBe(true);
  });

  it('resolves the SAME dir from the BUNDLED depth (apps/operator/dist-host) — EI-8689', () => {
    // Derive the real repo root from the source-depth resolution, then simulate
    // the bundled module location, which is one level SHALLOWER than the source.
    const fromSource = resolveMainSqlDir(HERE);
    const repoRoot = fromSource.slice(0, -SQL_DIR_REL.length - 1); // strip "/<rel>"
    const bundleDir = join(repoRoot, 'apps', 'operator', 'dist-host');

    const fromBundle = resolveMainSqlDir(bundleDir);

    // Depth-independent: bundle and source resolve to the identical real tree.
    expect(fromBundle).toBe(fromSource);
    expect(existsSync(fromBundle)).toBe(true);

    // And it must NOT be the old up-four overshoot into the workspace parent,
    // which was the ENOENT path that wedged the gym autoloop.
    const overshoot = join(bundleDir, '..', '..', '..', '..', SQL_DIR_REL);
    expect(fromBundle).not.toBe(overshoot);
  });

  it('falls back to a deterministic source-relative path when no marker exists', () => {
    // A location with no migration tree above it → the legacy up-four path,
    // so the ENOENT message stays deterministic rather than mis-walked.
    const orphan = '/tmp/no-such-repo-root-eiei/a/b/c/d';
    const resolved = resolveMainSqlDir(orphan);
    expect(resolved).toBe(join(orphan, '..', '..', '..', '..', SQL_DIR_REL));
  });
});
