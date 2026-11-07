/** Snapshot installation-owned guest bytes; never import or execute them here.
 * Extends the sealed runtime inventory, without an archive format or new store.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { posix } from 'node:path';
import koffi from 'koffi';
import type { HandlerRuntimeFile } from './handler-runtime';

export function snapshotInstalledHandlerFiles(directory: string, entryPoint: string,
  installation: { name: string; version: string }): HandlerRuntimeFile[] {
  if (typeof entryPoint !== 'string') throw new Error('installed handler entry required');
  return snapshotInstalledFiles(directory, entryPoint, installation);
}

/** Inventory custody also covers manifest-only plugins. This captures package
 * bytes without generating an executable entry or granting runtime approval.
 * Keep handler admission on snapshotInstalledHandlerFiles, with a real entry.
 */
export function snapshotInstalledPluginFiles(directory: string,
  installation: { name: string; version: string }): HandlerRuntimeFile[] {
  return snapshotInstalledFiles(directory, null, installation);
}

function snapshotInstalledFiles(directory: string, entryPoint: string | null,
  installation: { name: string; version: string }): HandlerRuntimeFile[] {
  const fail = () => new Error('invalid or changing installed handler snapshot');
  const relative = (path: string) => path.length > 0 && path.length <= 2048
    && !path.startsWith('/') && !path.endsWith('/') && path === posix.normalize(path)
    && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split('/').some(part => part === '.' || part === '..');
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
    || typeof directory !== 'string' || !directory.startsWith('/') || directory === '/'
    || directory !== posix.normalize(directory) || !relative(directory.slice(1))
    || (entryPoint !== null && (!relative(entryPoint) || !/\.(?:cjs|js|mjs|ts)$/.test(entryPoint)))
    || !installation || typeof installation.name !== 'string' || typeof installation.version !== 'string') throw fail();
  // Pin caller data before any IO. Paths originate in the host loader, never
  // in tool arguments. Each path component is opened beneath its actual fd.
  const expected = { name: installation.name, version: installation.version };
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
  const libc = koffi.load('libc.so.6');
  const openat = libc.func('openat', 'int', ['int', 'str', 'int']);
  const descriptors: number[] = [];
  const heldNodes: Array<{ fd: number; stat: ReturnType<typeof stat> }> = [];
  function stat(fd: number) { return fstatSync(fd, { bigint: true }); }
  const same = (before: ReturnType<typeof stat>, after: ReturnType<typeof stat>) =>
    (['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
      .every(field => before[field] === after[field]);
  const child = (parent: number, name: string, isDirectory = false) => {
    const fd: number = openat(parent, name, flags | (isDirectory ? constants.O_DIRECTORY : 0));
    if (fd < 0) throw fail();
    return fd;
  };
  const files: HandlerRuntimeFile[] = [];
  // Reserve one file for the entry adapter. Count directories too, so empty
  // trees and deep/broad populations cannot evade the traversal budget.
  let nodes = 0, total = 0;
  const walk = (fd: number, path: string, depth: number) => {
    if (depth > 32) throw fail();
    const before = stat(fd);
    if (!before.isDirectory()) throw fail();
    heldNodes.push({ fd, stat: before });
    // Incremental enumeration avoids allocating an unbounded readdir array.
    // /proc refers only to our held directory descriptor, not a guest path.
    const entries = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 32 });
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        const local = path ? `${path}/${entry.name}` : entry.name;
        if (++nodes > 1022 || !relative(local)) throw fail();
        const opened = child(fd, entry.name);
        descriptors.push(opened);
        {
          const before = stat(opened);
          if (before.isDirectory()) {
            walk(opened, local, depth + 1);
            continue;
          }
          // Check size and aggregate BEFORE allocating or reading. O_NONBLOCK
          // also ensures an attacker-controlled FIFO never stalls admission.
          if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n * 1024n
            || (local === 'papercusp.json' && before.size > 1024n * 1024n)
            || (total += Number(before.size)) > 512 * 1024 * 1024) throw fail();
          const contents = Buffer.alloc(Number(before.size) + 1);
          let size = 0;
          while (size < contents.length) {
            const count = readSync(opened, contents, size, contents.length - size, null);
            if (!count) break;
            size += count;
          }
          if (BigInt(size) !== before.size || !same(before, stat(opened))) throw fail();
          heldNodes.push({ fd: opened, stat: before });
          const bytes = contents.subarray(0, size);
          files.push({ path: `/handler/${local}`, contents: bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'), executable: !!(before.mode & 0o111n) });
        }
      }
    } finally { entries.closeSync(); }
  };
  try {
    descriptors.push(openSync('/', flags | constants.O_DIRECTORY));
    let root = descriptors[0]!;
    for (const name of directory.slice(1).split('/')) {
      root = child(root, name, true); descriptors.push(root);
    }
    walk(root, '', 0);
    // Revalidate earlier files too: a later read can race a content-only write
    // that does not change its parent directory. Keep fds until this check.
    if (heldNodes.some(({ fd, stat: before }) => !same(before, stat(fd)))) throw fail();
    const manifest = files.find(file => file.path === '/handler/papercusp.json');
    if (!manifest || manifest.contents.byteLength > 1024 * 1024) throw fail();
    const metadata: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.contents));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || (metadata as Record<string, unknown>).name !== expected.name
      || (metadata as Record<string, unknown>).version !== expected.version
      || (entryPoint !== null && !files.some(file => file.path === `/handler/${entryPoint}`))) throw fail();
    if (entryPoint !== null && entryPoint !== 'entry.cjs') {
      if (files.some(file => file.path === '/handler/entry.cjs')) throw fail();
      // Keep the original entry location: relative dependency resolution and
      // package scope must not change when the entry is nested in dist/.
      const contents = Buffer.from(`module.exports = require(${JSON.stringify(`./${entryPoint}`)});\n`);
      if (total + contents.length > 512 * 1024 * 1024) throw fail();
      files.push({ path: '/handler/entry.cjs', contents, executable: false,
        sha256: createHash('sha256').update(contents).digest('hex') });
    }
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
