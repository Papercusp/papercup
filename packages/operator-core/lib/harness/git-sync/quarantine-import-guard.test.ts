/**
 * The git-sync QUARANTINE-IMPORT guard (EI-19932544083689229 remedy #1 — ATOMICITY).
 *
 * Pure + seam-injected (readText only — no real repo, no git subprocess). Pins the
 * load-bearing behavior: a dirty file that imports an ALREADY-QUARANTINED path is
 * itself quarantined (so `commitOneRepo` excludes it too), a chain of dirty importers
 * is caught to a fixed point, an unrelated dirty file is left alone, and a read
 * failure is skipped (fail open) rather than blocking the commit.
 */
import { describe, it, expect } from 'vitest';
import { detectQuarantineImporters } from './quarantine-import-guard';

describe('detectQuarantineImporters', () => {
  it('EI-19932544083689229: quarantines a dirty *.test.ts sibling that imports an already-quarantined source', async () => {
    const files: Record<string, string> = {
      'lib/cup-spawn-health-watchdog.test.ts':
        `import { evaluateCupSpawnHealth } from './cup-spawn-health-watchdog';\n` +
        `it('works', () => { evaluateCupSpawnHealth(); });\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/cup-spawn-health-watchdog.ts', 'lib/cup-spawn-health-watchdog.test.ts'],
      alreadyQuarantined: ['lib/cup-spawn-health-watchdog.ts'], // content-guard already excluded the NUL-byte source
    });
    expect(offenders).toEqual([
      {
        file: 'lib/cup-spawn-health-watchdog.test.ts',
        detectorKey: 'quarantined-importer',
        error: expect.stringContaining('lib/cup-spawn-health-watchdog.ts'),
        fixerRole: 'content-fixer',
      },
    ]);
  });

  it('does not quarantine an importer when the excluded dependency still resolves from HEAD', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => `import './tracked-source';\n`,
      dirtyFiles: ['lib/tracked-source.ts', 'lib/importer.test.ts'],
      alreadyQuarantined: ['lib/tracked-source.ts'],
      isResolvableAtHead: async (path) => path === 'lib/tracked-source.ts',
    });
    expect(offenders).toEqual([]);
  });

  it('catches a CHAIN of dirty importers to a fixed point (C imports B imports quarantined A)', async () => {
    const files: Record<string, string> = {
      'lib/b.ts': `export { x } from './a';\n`,
      'lib/c.ts': `import { x } from './b';\nexport const y = x;\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/a.ts', 'lib/b.ts', 'lib/c.ts'],
      alreadyQuarantined: ['lib/a.ts'],
    });
    const flaggedFiles = offenders.map((o) => o.file).sort();
    expect(flaggedFiles).toEqual(['lib/b.ts', 'lib/c.ts']);
  });

  it('does NOT flag a dirty file that does not import anything quarantined (no false positive)', async () => {
    const files: Record<string, string> = {
      'lib/unrelated.ts': `import { z } from './other-clean-module';\nexport const w = z;\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/unrelated.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('returns [] immediately when nothing is quarantined yet (the common case — no wasted reads)', async () => {
    let reads = 0;
    const offenders = await detectQuarantineImporters({
      readText: async () => {
        reads++;
        return 'irrelevant';
      },
      dirtyFiles: ['lib/a.ts', 'lib/b.ts'],
      alreadyQuarantined: [],
    });
    expect(offenders).toEqual([]);
    expect(reads).toBe(0);
  });

  it('never flags the already-quarantined file itself, or a same-named file elsewhere that does not actually import it', async () => {
    const files: Record<string, string> = {
      'other/dir/unrelated.ts': `import { x } from './a-different-module';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'other/dir/unrelated.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('a deletion in the dirty set (readText -> null) is skipped, not flagged (fail open on gone/unreadable files)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => null, // every candidate reads as gone/unreadable
      dirtyFiles: ['lib/deleted-thing.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('a readText THROW is skipped (fail open — a guard bug must never block the commit)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => {
        throw new Error('EACCES');
      },
      dirtyFiles: ['lib/maybe-importer.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
      log: () => {},
    });
    expect(offenders).toEqual([]);
  });

  it('ignores a non-relative (bare/aliased) specifier — out of scope, matches deletion-import-guard', async () => {
    const files: Record<string, string> = {
      'lib/importer.ts': `import { x } from '@papercusp/quarantined';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/importer.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('resolves a directory-style import against a quarantined index file', async () => {
    const files: Record<string, string> = {
      'lib/consumer.ts': `import { thing } from '../feature';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['feature/index.ts', 'lib/consumer.ts'],
      alreadyQuarantined: ['feature/index.ts'],
    });
    expect(offenders).toEqual([
      {
        file: 'lib/consumer.ts',
        detectorKey: 'quarantined-importer',
        error: expect.stringContaining('feature/index.ts'),
        fixerRole: 'content-fixer',
      },
    ]);
  });

  it('does not re-scan a *.d.ts sibling (type-only — cannot break at runtime)', async () => {
    const files: Record<string, string> = {
      'lib/types.d.ts': `import type { X } from './quarantined';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/types.d.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });
});
