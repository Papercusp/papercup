import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotInstalledHandlerFiles } from './handler-installation';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync),
    opendirSync: vi.fn(actual.opendirSync), readSync: vi.fn(actual.readSync) };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'handler-guest-snapshot-')); roots.push(root);
  const put = (path: string, text: string) => {
    const file = join(root, path); fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
  };
  put('papercusp.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  put('dist/index.cjs', 'throw new Error("MUST_NOT_EXECUTE");');
  return { root, put, read: () => snapshotInstalledHandlerFiles(root, 'dist/index.cjs', { name: 'fixture', version: '1.0.0' }) };
}

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('installed guest snapshot', () => {
  it('pins real entry, transitive dependencies and package data without executing them', () => {
    const f = fixture();
    f.put('node_modules/dependency/index.cjs', 'module.exports = require("./nested.cjs");');
    f.put('node_modules/dependency/nested.cjs', 'throw new Error("DEPENDENCY_MUST_NOT_EXECUTE");');
    const files = f.read();
    expect(files.map(file => file.path)).toEqual(['/handler/dist/index.cjs', '/handler/entry.cjs',
      '/handler/node_modules/dependency/index.cjs', '/handler/node_modules/dependency/nested.cjs', '/handler/papercusp.json']);
    expect(Buffer.from(files.find(file => file.path === '/handler/entry.cjs')!.contents).toString())
      .toBe('module.exports = require("./dist/index.cjs");\n');
    for (const file of files) expect(file.sha256).toBe(createHash('sha256').update(file.contents).digest('hex'));
    const pinned = Buffer.from(files[0]!.contents);
    f.put('dist/index.cjs', 'changed after snapshot');
    expect(files[0]!.contents).toEqual(pinned);
  });

  it.each(['root-link', 'ancestor-link', 'file-link', 'directory-link', 'hardlink', 'fifo', 'entry-missing',
    'reserved-entry', 'manifest-missing', 'manifest-version', 'manifest-name', 'manifest-invalid', 'manifest-oversize', 'oversize', 'population', 'depth'] as const)
    ('refuses %s without importing a module', axis => {
      const f = fixture(); let read = f.read;
      if (axis === 'root-link' || axis === 'ancestor-link') {
        const parent = fs.mkdtempSync(join(tmpdir(), 'handler-guest-link-')); roots.push(parent);
        fs.symlinkSync(f.root, join(parent, 'linked'));
        if (axis === 'ancestor-link') {
          f.put('nested/papercusp.json', '{"name":"fixture","version":"1.0.0"}');
          f.put('nested/dist/index.cjs', 'throw new Error("MUST_NOT_EXECUTE");');
        }
        read = () => snapshotInstalledHandlerFiles(join(parent, 'linked', ...(axis === 'ancestor-link' ? ['nested'] : [])),
          'dist/index.cjs', { name: 'fixture', version: '1.0.0' });
      }
      if (axis === 'file-link') fs.symlinkSync('/etc/passwd', join(f.root, 'linked'));
      if (axis === 'directory-link') {
        f.put('safe/value', 'within budget'); fs.symlinkSync(join(f.root, 'safe'), join(f.root, 'linked'));
      }
      if (axis === 'hardlink') fs.linkSync(join(f.root, 'dist/index.cjs'), join(f.root, 'linked'));
      if (axis === 'fifo') execFileSync('mkfifo', [join(f.root, 'pipe')]);
      if (axis === 'entry-missing') fs.unlinkSync(join(f.root, 'dist/index.cjs'));
      if (axis === 'reserved-entry') f.put('entry.cjs', 'substituted wrapper');
      if (axis === 'manifest-missing') fs.unlinkSync(join(f.root, 'papercusp.json'));
      if (axis === 'manifest-version') f.put('papercusp.json', '{"name":"fixture","version":"2.0.0"}');
      if (axis === 'manifest-name') f.put('papercusp.json', '{"name":"other","version":"1.0.0"}');
      if (axis === 'manifest-invalid') f.put('papercusp.json', '{');
      if (axis === 'manifest-oversize') {
        fs.truncateSync(join(f.root, 'papercusp.json'), 1024 * 1024 + 1);
        const alloc = vi.spyOn(Buffer, 'alloc');
        expect(() => read()).toThrow();
        expect(alloc.mock.calls.every(([size]) => size < 1024 * 1024)).toBe(true); return;
      }
      if (axis === 'oversize') {
        const path = f.put('large', ''); fs.truncateSync(path, 256 * 1024 * 1024 + 1);
        const alloc = vi.spyOn(Buffer, 'alloc');
        expect(() => read()).toThrow();
        expect(alloc.mock.calls.every(([size]) => size < 1024 * 1024)).toBe(true); return;
      }
      if (axis === 'population') for (let i = 0; i < 1024; i++) f.put(`empty-${i}`, '');
      if (axis === 'depth') f.put(`${Array(34).fill('nested').join('/')}/file`, '');
      expect(() => read()).toThrow();
    });

  it.each(['../dist/index.cjs', '/dist/index.cjs', 'dist/../dist/index.cjs', 'dist\\index.cjs', 'dist/index.cjs\n'])
    ('refuses a noncanonical entry path %j', entry => {
      const f = fixture();
      expect(() => snapshotInstalledHandlerFiles(f.root, entry, { name: 'fixture', version: '1.0.0' })).toThrow();
    });

  it('detects changes on the opened file and releases the root descriptor on refusal', async () => {
    const f = fixture(), { readSync: read } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const open = vi.mocked(fs.openSync), close = vi.mocked(fs.closeSync);
    open.mockClear(); close.mockClear();
    let changed = false;
    vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(read, fs, args) as number;
      if (!changed) { changed = true; f.put('dist/index.cjs', 'concurrent mutation'); f.put('new-member', ''); }
      return count;
    });
    expect(f.read).toThrow(/changing installed handler/);
    expect(close).toHaveBeenCalledWith(open.mock.results[0]!.value);
    expect(f.read).not.toThrow();
  });

  it('refuses an earlier file changed after its read without a directory membership change', async () => {
    const f = fixture(), { opendirSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    let first: fs.Dir | undefined;
    vi.mocked(fs.opendirSync).mockImplementation((...args: Parameters<typeof fs.opendirSync>) => {
      const directory = Reflect.apply(opendirSync, fs, args) as fs.Dir;
      if (!first) {
        first = directory;
        const close = directory.closeSync.bind(directory);
        directory.closeSync = () => { close(); f.put('dist/index.cjs', 'content-only concurrent change'); };
      }
      return directory;
    });
    expect(f.read).toThrow(/changing installed handler/);
  });
});
