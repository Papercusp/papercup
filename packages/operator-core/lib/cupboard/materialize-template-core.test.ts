/**
 * Coverage for the app-template materialize core (WI-3198) — the DI'd write half
 * behind templates:new-app. Hermetic: `cloneRepo` and `createHarness` are mocked
 * (no real git, network, or harness dispatcher), the overlay runs against real
 * temp dirs. Exercises: url/ref validation, subdir location + path-escape guard,
 * overlay MERGE semantics (excludes .git, preserves harness:create's blueprint.yaml),
 * and clone-dir cleanup on both success and failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeTemplateCore,
  cloneSourceAcquire,
  localSourceAcquire,
  locateTemplateDir,
  overlayTemplateFiles,
  MaterializeTemplateError,
  type CloneSourceDeps,
} from './materialize-template-core';

const REF = 'papercusp-webapp';
const URL = 'https://github.com/Papercusp/templates';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mtc-test-'));
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

/** A `cloneRepo` that lays down a realistic mirror clone at `dest`: a `.git`, an
 *  unrelated sibling template, and our `<ref>/` with app files. */
function fakeClone(): CloneSourceDeps['cloneRepo'] {
  return async (_url, dest) => {
    mkdirSync(join(dest, '.git'), { recursive: true });
    writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(dest, 'other-template'), { recursive: true });
    writeFileSync(join(dest, 'other-template', 'GUIDE.md'), '# not this one\n');
    const t = join(dest, REF);
    mkdirSync(join(t, 'src'), { recursive: true });
    writeFileSync(join(t, 'GUIDE.md'), '# Build the webapp\n');
    writeFileSync(join(t, 'package.json'), '{"name":"webapp"}\n');
    writeFileSync(join(t, 'src', 'index.ts'), 'export const x = 1;\n');
  };
}

/** A `createHarness` that mimics harness:create: makes the dir + writes a coding
 *  blueprint.yaml + a .git, then returns {slug, path}. */
function fakeCreateHarness(slug: string) {
  return async () => {
    const path = join(scratch, 'harnesses', slug);
    mkdirSync(join(path, '.papercusp'), { recursive: true });
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.papercusp', 'blueprint.yaml'), 'id: coding\n');
    return { slug, path };
  };
}

describe('locateTemplateDir', () => {
  it('returns the <clone>/<ref> subdir when present', () => {
    const clone = join(scratch, 'clone');
    mkdirSync(join(clone, REF), { recursive: true });
    expect(locateTemplateDir(clone, REF)).toBe(join(clone, REF));
  });

  it('throws 422 when the ref subdir is absent', () => {
    const clone = join(scratch, 'clone');
    mkdirSync(clone, { recursive: true });
    expect(() => locateTemplateDir(clone, REF)).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });

  it('throws 400 on an unsafe ref (charset)', () => {
    const clone = join(scratch, 'clone');
    mkdirSync(clone, { recursive: true });
    expect(() => locateTemplateDir(clone, 'a/b')).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('throws 400 on a path-escaping ref that slips the charset gate ("..")', () => {
    const clone = join(scratch, 'clone');
    mkdirSync(clone, { recursive: true });
    // ".." matches SAFE_REF_RE but assertInside must still reject it.
    expect(() => locateTemplateDir(clone, '..')).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('overlayTemplateFiles', () => {
  it('merges the template onto an existing dir, excluding .git and preserving blueprint.yaml', async () => {
    const src = join(scratch, 'src');
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, '.git', 'config'), 'junk');
    mkdirSync(join(src, '.papercusp'), { recursive: true });
    writeFileSync(join(src, '.papercusp', 'blueprint.yaml'), 'id: FROM-TEMPLATE\n');
    writeFileSync(join(src, '.papercusp', 'config.json'), '{"from":"template"}');
    mkdirSync(join(src, 'src'), { recursive: true });
    writeFileSync(join(src, 'src', 'index.ts'), 'ts');
    writeFileSync(join(src, 'GUIDE.md'), 'guide');

    const target = join(scratch, 'target');
    mkdirSync(join(target, '.papercusp'), { recursive: true });
    writeFileSync(join(target, '.papercusp', 'blueprint.yaml'), 'id: coding\n');

    const copied = await overlayTemplateFiles(src, target);

    // .git excluded from the top-level report + not copied.
    expect(copied).not.toContain('.git');
    expect(copied).toEqual(expect.arrayContaining(['GUIDE.md', 'src', '.papercusp']));
    expect(existsSync(join(target, '.git'))).toBe(false);
    // template app files landed.
    expect(readFileSync(join(target, 'src', 'index.ts'), 'utf8')).toBe('ts');
    expect(readFileSync(join(target, 'GUIDE.md'), 'utf8')).toBe('guide');
    // harness identity preserved (NOT clobbered by the template's blueprint.yaml).
    expect(readFileSync(join(target, '.papercusp', 'blueprint.yaml'), 'utf8')).toBe('id: coding\n');
    // but other .papercusp files DO overlay.
    expect(readFileSync(join(target, '.papercusp', 'config.json'), 'utf8')).toBe('{"from":"template"}');
  });
});

describe('materializeTemplateCore', () => {
  // The remote (clone) source-acquire — validates url+ref, clones into scratch, locates <clone>/<ref>.
  const cloneAcquire = (clone = fakeClone(), url = URL, ref = REF) =>
    cloneSourceAcquire({ githubUrl: url, ref, cloneRepo: clone, tmpDir: () => scratch });

  it('clones, creates the harness, overlays the template, and cleans the clone dir', async () => {
    const r = await materializeTemplateCore({
      ref: REF,
      acquireSourceDir: cloneAcquire(),
      createHarness: fakeCreateHarness('my-app'),
    });
    expect(r.slug).toBe('my-app');
    expect(r.filesCopied).toEqual(expect.arrayContaining(['GUIDE.md', 'package.json', 'src']));
    // The template files (only the <ref>/ subtree) landed, not the sibling template.
    expect(readFileSync(join(r.path, 'package.json'), 'utf8')).toBe('{"name":"webapp"}\n');
    expect(existsSync(join(r.path, 'src', 'index.ts'))).toBe(true);
    // harness:create's blueprint.yaml survived.
    expect(readFileSync(join(r.path, '.papercusp', 'blueprint.yaml'), 'utf8')).toBe('id: coding\n');
    // clone scratch dir cleaned up (no cupboard-template-* left behind).
    const leftovers = (await fs.readdir(scratch)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);
  });

  it('materializes from an ON-DISK local dir with no clone and no scratch (localSourceAcquire)', async () => {
    // Lay down a local template dir (the v1 bundled-store shape).
    const localDir = join(scratch, 'local', REF);
    mkdirSync(join(localDir, 'src'), { recursive: true });
    writeFileSync(join(localDir, 'GUIDE.md'), '# local build\n');
    writeFileSync(join(localDir, 'package.json'), '{"name":"local-webapp"}\n');
    writeFileSync(join(localDir, 'src', 'index.ts'), 'export const y = 2;\n');

    const r = await materializeTemplateCore({
      ref: REF,
      acquireSourceDir: localSourceAcquire(localDir),
      createHarness: fakeCreateHarness('local-app'),
    });
    expect(r.slug).toBe('local-app');
    expect(r.filesCopied).toEqual(expect.arrayContaining(['GUIDE.md', 'package.json', 'src']));
    expect(readFileSync(join(r.path, 'package.json'), 'utf8')).toBe('{"name":"local-webapp"}\n');
    expect(readFileSync(join(r.path, '.papercusp', 'blueprint.yaml'), 'utf8')).toBe('id: coding\n');
    // The source dir is UNTOUCHED (local acquire has a noop cleanup — never deletes it).
    expect(existsSync(localDir)).toBe(true);
    // No clone scratch was created.
    const leftovers = (await fs.readdir(scratch)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);
  });

  it('rejects a non-github url before cloning', async () => {
    let cloned = false;
    await expect(
      materializeTemplateCore({
        ref: REF,
        acquireSourceDir: cloneSourceAcquire({
          githubUrl: 'https://gitlab.com/x/y',
          ref: REF,
          cloneRepo: async () => {
            cloned = true;
          },
          tmpDir: () => scratch,
        }),
        createHarness: fakeCreateHarness('x'),
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 400 }));
    expect(cloned).toBe(false);
  });

  it('does NOT create the harness when the ref subdir is missing (422), and cleans up', async () => {
    let created = false;
    const clone: CloneSourceDeps['cloneRepo'] = async (_u, dest) => {
      mkdirSync(dest, { recursive: true }); // clone with NO <ref>/ subdir
    };
    await expect(
      materializeTemplateCore({
        ref: REF,
        acquireSourceDir: cloneAcquire(clone),
        createHarness: async () => {
          created = true;
          return { slug: 'x', path: join(scratch, 'x') };
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 422 }));
    expect(created).toBe(false);
    const leftovers = (await fs.readdir(scratch)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);
  });

  it('propagates a createHarness failure and still cleans the clone dir', async () => {
    await expect(
      materializeTemplateCore({
        ref: REF,
        acquireSourceDir: cloneAcquire(),
        createHarness: async () => {
          throw new MaterializeTemplateError('harness:create failed: slug already exists', 422);
        },
      }),
    ).rejects.toThrow(/slug already exists/);
    const leftovers = (await fs.readdir(scratch)).filter((n) => n.startsWith('cupboard-template-'));
    expect(leftovers).toEqual([]);
  });
});
