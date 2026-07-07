import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  extractDevSourceTree,
  hasPapercupMarkers,
  escapingLinkIgnore,
} from './dev-source-extract';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'devsrc-'));
}
async function writeMarkers(root: string): Promise<void> {
  await mkdir(join(root, 'apps', 'operator'), { recursive: true });
  await mkdir(join(root, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
  await writeFile(join(root, 'libs', 'papercusp', 'package.json'), '{}');
}

const makeDecompress = () => new PassThrough();
// a fake tar-extract sink that writes the markers on successful completion
const makeFakeExtractSuccess = (targetDir: string) => () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
    final(cb) {
      writeMarkers(targetDir).then(() => cb(), cb);
    },
  });
const makeFakeExtractFail = () => () =>
  new Writable({
    write(_c, _e, cb) {
      cb(new Error('boom'));
    },
  });

describe('extractDevSourceTree', () => {
  it('no-ops when archivePath is undefined', async () => {
    const t = await tmp();
    expect(
      await extractDevSourceTree({ archivePath: undefined, targetDir: join(t, 'out') }),
    ).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('no-ops when the archive file is absent', async () => {
    const t = await tmp();
    expect(
      await extractDevSourceTree({
        archivePath: join(t, 'nope.tar.zst'),
        targetDir: join(t, 'out'),
      }),
    ).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('reuses an already-extracted tree (idempotent) without re-extracting', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x');
    const target = join(t, 'out');
    await writeMarkers(target);
    const makeExtract = vi.fn(makeFakeExtractSuccess(target));
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract,
    });
    expect(r).toBe(target);
    expect(makeExtract).not.toHaveBeenCalled();
    await rm(t, { recursive: true, force: true });
  });

  it('extracts + returns the root when the archive is present and markers are absent', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: makeFakeExtractSuccess(target),
    });
    expect(r).toBe(target);
    expect(hasPapercupMarkers(target)).toBe(true);
    await rm(t, { recursive: true, force: true });
  });

  it('returns null (non-fatal) when the extraction stream fails', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: makeFakeExtractFail(),
    });
    expect(r).toBeNull();
    await rm(t, { recursive: true, force: true });
  });

  it('returns null when extraction completes but the markers are missing (half-extracted)', async () => {
    const t = await tmp();
    const archive = join(t, 'source.tar.zst');
    await writeFile(archive, 'x'.repeat(1000));
    const target = join(t, 'out');
    const noMarkerSink = () =>
      new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
    const r = await extractDevSourceTree({
      archivePath: archive,
      targetDir: target,
      makeDecompress,
      makeExtract: noMarkerSink,
    });
    expect(r).toBeNull();
    await rm(t, { recursive: true, force: true });
  });
});

describe('escapingLinkIgnore', () => {
  const root = '/x/dev-source';
  const nm = join(root, 'node_modules');

  it('keeps a non-link entry (file/directory)', () => {
    const ig = escapingLinkIgnore(root);
    expect(ig(join(root, 'apps/operator/index.ts'), { type: 'file' })).toBe(false);
    expect(ig(join(root, 'apps'), { type: 'directory' })).toBe(false);
    // a header without a type (defensive) is also kept
    expect(ig(join(root, 'x'), {})).toBe(false);
    expect(ig(join(root, 'x'))).toBe(false);
  });

  it('keeps an in-tree relative symlink (npm workspace / .bin link)', () => {
    const ig = escapingLinkIgnore(root);
    // node_modules/.bin/tsx -> ../tsx/dist/cli.mjs  (stays inside root)
    expect(
      ig(join(nm, '.bin/tsx'), { type: 'symlink', linkname: '../tsx/dist/cli.mjs' }),
    ).toBe(false);
    // node_modules/@papercusp/foo -> ../../packages/foo (still inside root)
    expect(
      ig(join(nm, '@papercusp/foo'), { type: 'symlink', linkname: '../../packages/foo' }),
    ).toBe(false);
  });

  it('skips an out-of-tree relative symlink (the storewolf-libs class) and reports it', () => {
    const skips: Array<[string, string]> = [];
    const ig = escapingLinkIgnore(root, (n, l) => skips.push([n, l]));
    const name = join(nm, 'storewolf-libs');
    // ../../Storewolf-Libs from node_modules escapes above root
    expect(ig(name, { type: 'symlink', linkname: '../../Storewolf-Libs' })).toBe(true);
    expect(skips).toEqual([[name, '../../Storewolf-Libs']]);
  });

  it('skips a symlink with an absolute out-of-tree target', () => {
    const ig = escapingLinkIgnore(root);
    expect(
      ig(join(nm, 'weird'), { type: 'symlink', linkname: '/home/dev/Elsewhere' }),
    ).toBe(true);
  });

  it('skips an out-of-tree hardlink but keeps an in-tree one', () => {
    const ig = escapingLinkIgnore(root);
    // hardlink target is joined from the extraction root
    expect(ig(join(root, 'a'), { type: 'link', linkname: 'libs/papercusp/x' })).toBe(false);
    expect(ig(join(root, 'a'), { type: 'link', linkname: '../outside/x' })).toBe(true);
  });
});
