/** Host-owned runtime custody for the supervisor's mandatory handler profile.
 * Inventory/authorship approval belongs to the trusted installer, never to a
 * handler manifest. This module verifies and snapshots that input; it does not
 * discover dependencies or certify the inventory's completeness/authorship.
 */
import { createHash } from 'node:crypto';
import { closeSync } from 'node:fs';
import { buildHandlerBwrapArgs } from './bwrap-args';
import { createHandlerBootstrapFilter, createHandlerReadonlyFile } from './handler-seccomp';

export interface HandlerRuntimeFile {
  path: string;
  contents: Uint8Array;
  sha256: string;
  executable: boolean;
}

export interface HandlerRuntimeInventory {
  files: ReadonlyArray<HandlerRuntimeFile>;
  /** Digest of the sorted path/digest/mode inventory selected by the host. */
  sha256: string;
  /** Trusted installer pin for the built handler-bootstrap.ts bundle. */
  bootstrapSha256: string;
}

export interface PreparedHandlerRuntime { readonly sha256: string }
const snapshots = new WeakMap<PreparedHandlerRuntime, ReadonlyArray<HandlerRuntimeFile>>();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Packaging helper; this digest binds bytes through each file's digest. */
export function handlerRuntimeDigest(files: ReadonlyArray<Omit<HandlerRuntimeFile, 'contents'>>): string {
  return sha256(JSON.stringify(files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** No paths are opened and no handler code is evaluated in the host. */
export function prepareHandlerRuntime(inventory: HandlerRuntimeInventory): PreparedHandlerRuntime {
  if (!inventory || !Array.isArray(inventory.files) || !inventory.files.length || inventory.files.length > 1023
    || !/^[a-f0-9]{64}$/.test(inventory.sha256) || !/^[a-f0-9]{64}$/.test(inventory.bootstrapSha256)) {
    throw new Error('invalid host handler inventory');
  }
  let size = 0;
  const files = inventory.files.map(file => {
    if (!(file.contents instanceof Uint8Array) || file.contents.byteLength > 256 * 1024 * 1024
      || (size += file.contents.byteLength) > 512 * 1024 * 1024) throw new Error('handler inventory size exceeded');
    const contents = Buffer.from(file.contents);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || sha256(contents) !== file.sha256) throw new Error('handler inventory file digest mismatch');
    if (file.path === '/runtime/identity.json') throw new Error('reserved handler runtime identity file');
    return { path: file.path, contents, sha256: file.sha256, executable: file.executable };
  });
  // Reuse the exact mount-profile validation, with synthetic CHILD fds only.
  buildHandlerBwrapArgs({ bootstrapFilterFd: 3, files: files.map((file, i) => ({ ...file, fd: i + 4 })) });
  if (handlerRuntimeDigest(files) !== inventory.sha256
    || files.find(file => file.path === '/runtime/bootstrap.cjs')?.sha256 !== inventory.bootstrapSha256) {
    throw new Error('handler inventory or trusted bootstrap identity mismatch');
  }
  const runtime = Object.freeze({ sha256: inventory.sha256 });
  snapshots.set(runtime, files);
  return runtime;
}

/** Fresh sealed objects on every spawn. Only genuine host-prepared tokens work. */
export function openHandlerRuntime(runtime: PreparedHandlerRuntime) {
  const files = snapshots.get(runtime);
  if (!files) throw new Error('handler runtime was not prepared by this host');
  const descriptors: number[] = [];
  const close = () => { for (const fd of descriptors.splice(0)) closeSync(fd); };
  try {
    descriptors.push(createHandlerBootstrapFilter());
    const identity = Buffer.from(JSON.stringify({ sha256: runtime.sha256 }));
    const mounted = [...files, { path: '/runtime/identity.json', contents: identity, sha256: sha256(identity), executable: false }]
      .map(file => {
        descriptors.push(createHandlerReadonlyFile(file.contents, file.sha256));
        return { path: file.path, fd: descriptors.length + 2, executable: file.executable };
      });
    const built = buildHandlerBwrapArgs({ files: mounted, bootstrapFilterFd: 3 });
    return { ...built, descriptors, close };
  } catch (error) { close(); throw error; }
}
