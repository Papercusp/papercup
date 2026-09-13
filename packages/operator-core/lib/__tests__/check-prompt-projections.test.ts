/**
 * Exact-byte prompt projection guard tests — EI-21618443971639284.
 *
 * These controls prove the guard is falsifiable: a clean fixture passes, one
 * changed byte fails even when the file length is unchanged, and missing
 * source/projection files fail closed. The CLI control also exercises the same
 * entrypoint that affected-tests runs.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  CANONICAL_PROMPT_PATH,
  GENERATED_PROMPT_PATHS,
  PROMPT_PROJECTION_GROUPS,
  PROMPT_PROJECTIONS_MARKER,
  compareAllPromptProjections,
  comparePromptProjections,
} from '../../../../scripts/check-prompt-projections.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-prompt-projections.mjs');

function writeFixture(root: string, relativePath: string, content: Uint8Array): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function seedFixture(root: string, source: Uint8Array = Buffer.from([0x73, 0x75, 0x0a])): void {
  writeFixture(root, CANONICAL_PROMPT_PATH, source);
  for (const path of GENERATED_PROMPT_PATHS) writeFixture(root, path, source);
}

function seedAllProjectionGroups(root: string): void {
  PROMPT_PROJECTION_GROUPS.forEach((group, index) => {
    const source = Buffer.from(`source-${index}\n`);
    writeFixture(root, group.sourcePath, source);
    for (const path of group.projectionPaths) writeFixture(root, path, source);
  });
}

function withFixture(test: (root: string) => void): void {
  const root = mkdtempSync(join('/tmp', 'prompt-projections-'));
  try {
    test(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('comparePromptProjections', () => {
  it('passes when every committed projection has exactly the canonical bytes', () => {
    withFixture((root) => {
      seedFixture(root);
      const result = comparePromptProjections({ root });
      expect(result.ok).toBe(true);
      expect(result.mismatches).toEqual([]);
      expect(result.source.bytes).toBe(3);
      expect(result.projections).toHaveLength(GENERATED_PROMPT_PATHS.length);
    });
  });

  it('fails when one byte differs even if the projection length is unchanged', () => {
    withFixture((root) => {
      const source = Buffer.from([0x73, 0x75, 0x0a]);
      seedFixture(root, source);
      writeFixture(root, GENERATED_PROMPT_PATHS[0], Buffer.from([0x73, 0x58, 0x0a]));
      const result = comparePromptProjections({ root });
      expect(result.ok).toBe(false);
      expect(result.mismatches).toEqual([
        { path: GENERATED_PROMPT_PATHS[0], reason: 'content-differs' },
      ]);
      expect(result.source.bytes).toBe(result.projections[0].bytes);
      expect(result.source.sha256).not.toBe(result.projections[0].sha256);
    });
  });

  it('fails closed when a committed projection is missing', () => {
    withFixture((root) => {
      seedFixture(root);
      rmSync(join(root, GENERATED_PROMPT_PATHS[0]));
      const result = comparePromptProjections({ root });
      expect(result.ok).toBe(false);
      expect(result.mismatches).toContainEqual({
        path: GENERATED_PROMPT_PATHS[0],
        reason: 'missing-projection',
      });
    });
  });

  it('fails closed when the canonical source is missing', () => {
    withFixture((root) => {
      for (const path of GENERATED_PROMPT_PATHS) writeFixture(root, path, Buffer.from('stale'));
      const result = comparePromptProjections({ root });
      expect(result.ok).toBe(false);
      expect(result.mismatches).toContainEqual({
        path: CANONICAL_PROMPT_PATH,
        reason: 'missing-source',
      });
    });
  });
});

describe('check-prompt-projections CLI', () => {
  it('returns a failing verdict without modifying a stale projection by default', () => {
    withFixture((root) => {
      seedFixture(root);
      const stale = Buffer.from([0x73, 0x58, 0x0a]);
      writeFixture(root, GENERATED_PROMPT_PATHS[0], stale);
      const result = spawnSync(process.execPath, [SCRIPT, '--root', root], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      expect(output).toContain(PROMPT_PROJECTIONS_MARKER);
      expect(output).toContain(GENERATED_PROMPT_PATHS[0]);
      expect(output).toContain('content-differs');
      expect(readFileSync(join(root, GENERATED_PROMPT_PATHS[0]))).toEqual(stale);
    });
  });

  it('--write atomically refreshes every stale maintained projection and rechecks green', () => {
    withFixture((root) => {
      seedAllProjectionGroups(root);
      for (const group of PROMPT_PROJECTION_GROUPS) {
        writeFixture(root, group.projectionPaths[0], Buffer.from('stale\n'));
      }

      const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--write'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect((result.stdout ?? '') + (result.stderr ?? '')).toContain('2 refreshed');
      expect(compareAllPromptProjections({ root }).ok).toBe(true);
      for (const group of PROMPT_PROJECTION_GROUPS) {
        const source = readFileSync(join(root, group.sourcePath));
        for (const path of group.projectionPaths) {
          const target = join(root, path);
          expect(readFileSync(target)).toEqual(source);
          expect(
            readdirSync(dirname(target)).filter((name) => name.includes('.prompt-projection-')),
          ).toEqual([]);
        }
      }
    });
  });

  it('--write refuses before changing any target when a maintained source is missing', () => {
    withFixture((root) => {
      seedAllProjectionGroups(root);
      const firstTarget = PROMPT_PROJECTION_GROUPS[0].projectionPaths[0];
      const stale = Buffer.from('keep-stale\n');
      writeFixture(root, firstTarget, stale);
      unlinkSync(join(root, PROMPT_PROJECTION_GROUPS[1].sourcePath));

      const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--write'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect((result.stdout ?? '') + (result.stderr ?? '')).toContain('refused to write');
      expect(readFileSync(join(root, firstTarget))).toEqual(stale);
    });
  });
});
