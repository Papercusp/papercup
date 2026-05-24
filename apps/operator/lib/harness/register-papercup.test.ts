import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPapercupRoot } from './register-papercup';

describe('detectPapercupRoot', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'detect-papercup-'));
  });

  afterEach(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('detects a directory with both markers', async () => {
    const root = join(work, 'fake-papercup');
    await mkdir(join(root, 'apps', 'operator'), { recursive: true });
    await mkdir(join(root, 'libs', 'papercusp'), { recursive: true });
    await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
    await writeFile(join(root, 'libs', 'papercusp', 'package.json'), '{}');

    expect(detectPapercupRoot(root)).toBe(root);
  });

  it('walks up from a nested cwd to find the root', async () => {
    const root = join(work, 'papercup-2');
    const nested = join(root, 'apps', 'operator', 'lib', 'harness');
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, 'libs', 'papercusp'), { recursive: true });
    await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
    await writeFile(join(root, 'libs', 'papercusp', 'package.json'), '{}');

    expect(detectPapercupRoot(nested)).toBe(root);
  });

  it('returns null when only one marker is present', async () => {
    const root = join(work, 'fake-other');
    await mkdir(join(root, 'apps', 'operator'), { recursive: true });
    await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
    // No libs/papercusp/package.json — should NOT match.
    expect(detectPapercupRoot(root)).toBe(null);
  });

  it('returns null when neither marker is present', async () => {
    expect(detectPapercupRoot(work)).toBe(null);
  });

  it('detects the real papercup repo from this test file location', () => {
    // The test itself runs from inside apps/operator, so detection
    // should find the real papercup root.
    const found = detectPapercupRoot();
    expect(found).not.toBe(null);
    expect(found).toMatch(/papercup$/);
  });
});
