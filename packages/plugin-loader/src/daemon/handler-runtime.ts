/** Host-owned runtime custody for the supervisor's mandatory handler profile.
 * Inventory/authorship approval belongs to the trusted installer, never to a
 * handler manifest. This module verifies and snapshots that input; it does not
 * discover dependencies or certify the inventory's completeness/authorship.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import koffi from 'koffi';
import { parseTauriUpdateCandidate, parseTauriUpdateEnvelope, verifyTauriUpdateAuthorization,
  type TauriUpdateCandidate, type TauriUpdateEnvelope, type TauriUpdateTrust } from '@papercusp/tauri-release-kit/signature';
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
/** The installer owns this transaction, including protected CURRENT trust and
 * exact build/author inputs. It must hold its serialization through `use`.
 * Neither this port nor its keys/candidate may come from a handler manifest.
 */
export interface HandlerRuntimeApproval {
  envelope: TauriUpdateEnvelope;
  withCurrentTrust<T>(use: (state: { trust: TauriUpdateTrust; expected: TauriUpdateCandidate; now: number }) => Promise<T>): Promise<T>;
}

/** Host installer adapter, never manifest input. The candidate still requires
 * independently authenticated, complete build provenance. Koffi holds the SAME
 * native directory flock as update_authorization.rs through the awaited use;
 * no helper process, cached trust, new policy location or approval store.
 */
export function createCurrentHandlerRuntimeApproval(envelope: TauriUpdateEnvelope,
  expected: TauriUpdateCandidate): HandlerRuntimeApproval {
  const pinnedEnvelope = parseTauriUpdateEnvelope(envelope);
  const pinnedCandidate = parseTauriUpdateCandidate(expected);
  return Object.freeze({ envelope: pinnedEnvelope, async withCurrentTrust<T>(
    use: (state: { trust: TauriUpdateTrust; expected: TauriUpdateCandidate; now: number }) => Promise<T>,
  ): Promise<T> {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
      throw new Error('unsupported protected handler runtime trust platform');
    }
    const invalid = () => new Error('protected administrator handler runtime trust is absent, invalid or unreadable');
    const libc = koffi.load('libc.so.6');
    const openat = libc.func('openat', 'int', ['int', 'str', 'int']);
    const flock = libc.func('flock', 'int', ['int', 'int']);
    // Linux O_CLOEXEC: do not pass the authority lease to the handler/children.
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
    const descriptors: number[] = [];
    const directory = (fd: number) => {
      const stat = fstatSync(fd);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw invalid();
      return fd;
    };
    const child = (parent: number, name: string, isDirectory: boolean) => {
      const fd: number = openat(parent, name, flags | (isDirectory ? constants.O_DIRECTORY : 0));
      if (fd < 0) throw invalid();
      descriptors.push(fd);
      return isDirectory ? directory(fd) : fd;
    };
    try {
      descriptors.push(openSync('/', flags | constants.O_DIRECTORY));
      let parent = directory(descriptors[0]!);
      for (const name of ['etc', 'papercusp']) parent = child(parent, name, true);
      // LOCK_SH | LOCK_NB. Activators use LOCK_EX on this exact directory inode.
      if (flock(parent, 1 | 4) !== 0) throw new Error('protected update trust is busy or unavailable');
      const fd = child(parent, 'managed-policy.json', false);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.uid !== 0n || (before.mode & 0o022n)
        || before.nlink !== 1n || before.size < 1n || before.size > 16_384n) throw invalid();
      const bytes = Buffer.alloc(16_385);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (BigInt(size) !== before.size || !(['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
        .every(field => before[field] === after[field])) throw invalid();
      const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value
        && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length
        && fields.every(field => Object.hasOwn(value, field));
      const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
      const label = (value: unknown) => typeof value === 'string' && value.length > 0
        && value.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(value);
      if (!exact(policy, ['version', 'update_channel', 'updateAuthorization']) || policy.version !== 1
        || !['alpha', 'beta', 'stable'].includes(policy.update_channel as string)) throw invalid();
      const trust = policy.updateAuthorization;
      const integers = ['rootEpoch', 'minRollbackCounter', 'minIssuedAt', 'maxMetadataAgeMs'];
      if (!exact(trust, [...integers, 'signers', 'approvers']) || integers.some(field => !integer(trust[field]))
        || trust.maxMetadataAgeMs === 0) throw invalid();
      for (const role of ['signers', 'approvers']) {
        const keys = trust[role];
        if (!Array.isArray(keys) || !keys.length || keys.length > 64 || keys.some(key =>
          !exact(key, ['id', 'epoch', 'principalId', 'publicKey', 'revoked']) || !label(key.id)
          || !label(key.principalId) || !integer(key.epoch) || typeof key.revoked !== 'boolean'
          || typeof key.publicKey !== 'string' || !key.publicKey.length || key.publicKey.length > 4096)) throw invalid();
        for (const key of keys) Object.freeze(key);
        Object.freeze(keys);
      }
      return await use({ trust: Object.freeze(trust) as unknown as TauriUpdateTrust,
        expected: pinnedCandidate, now: Date.now() });
    } finally {
      // Closing the actual locked descriptor AFTER promise settlement releases
      // the kernel lease on both success and rejection, including sync throws.
      for (const fd of descriptors.reverse()) closeSync(fd);
    }
  } });
}
/** Host producer input, authenticated against its complete source closure by
 * the protected installer. Neither a manifest nor signed envelope supplies it.
 */
export type HandlerRuntimeBuildIdentity = Pick<TauriUpdateCandidate,
  'sourceRevision' | 'version' | 'authorIds' | 'rollbackCounter'>;
const approvals = new WeakMap<PreparedHandlerRuntime, HandlerRuntimeApproval>();
const activeLeases = new WeakMap<PreparedHandlerRuntime, number>();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Packaging helper; this digest binds bytes through each file's digest. */
export function handlerRuntimeDigest(files: ReadonlyArray<Omit<HandlerRuntimeFile, 'contents'>>): string {
  return sha256(JSON.stringify(files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Sign the complete trusted runtime, separately from installation-owned
 * untrusted handler bytes. Every mounted file outside /handler is covered.
 * Completeness/authenticated authors must be established by the build producer;
 * a matching digest alone cannot establish either property.
 */
export function handlerTrustedRuntimeDigest(files: ReadonlyArray<Omit<HandlerRuntimeFile, 'contents'>>): string {
  return handlerRuntimeDigest(files.filter(file => !file.path.startsWith('/handler/')));
}

export function handlerRuntimeConfigurationDigest(): string {
  return sha256(JSON.stringify({ product: 'papercusp-handler-runtime', profile: 'linux-handler-process-v1',
    inventory: 'handler-runtime-files-v1', platform: process.platform, arch: process.arch }));
}

/** Uses the existing dual-signature release protocol; no handler-selected root,
 * new signature format or approval store. Checks CURRENT authority at admission,
 * not merely at preparation. The whole file inventory is copied synchronously.
 */
export function prepareApprovedHandlerRuntime(inventory: HandlerRuntimeInventory, approval: HandlerRuntimeApproval): PreparedHandlerRuntime {
  const envelope = parseTauriUpdateEnvelope(approval.envelope);
  if (typeof approval.withCurrentTrust !== 'function') throw new Error('protected handler runtime trust transaction required');
  const runtime = prepareHandlerRuntime(inventory);
  approvals.set(runtime, { envelope, withCurrentTrust: approval.withCurrentTrust.bind(approval) });
  return runtime;
}

/** Derive candidate digests from the exact snapshotted runtime bytes. This
 * prepares the protected producer's comparison input; it cannot authenticate
 * source authors, discover a missing dependency or authorize a handler spawn.
 */
export function createHandlerRuntimeCandidate(inventory: HandlerRuntimeInventory,
  identity: HandlerRuntimeBuildIdentity): Readonly<TauriUpdateCandidate> {
  const fields = ['sourceRevision', 'version', 'authorIds', 'rollbackCounter'] as const;
  if (!identity || ![Object.prototype, null].includes(Object.getPrototypeOf(identity))
    || Reflect.ownKeys(identity).length !== fields.length
    || !fields.every(field => Object.hasOwn(identity, field)
      && 'value' in Object.getOwnPropertyDescriptor(identity, field)!)) {
    throw new Error('exact protected handler build identity required');
  }
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('unsupported approved handler runtime platform');
  }
  const runtime = prepareHandlerRuntime(inventory);
  const files = snapshots.get(runtime)!;
  return parseTauriUpdateCandidate({
    artifactSha256: handlerTrustedRuntimeDigest(files),
    policySha256: files.find(file => file.path === '/runtime/bootstrap.cjs')!.sha256,
    configurationSha256: handlerRuntimeConfigurationDigest(),
    sourceRevision: identity.sourceRevision, version: identity.version,
    authorIds: identity.authorIds, rollbackCounter: identity.rollbackCounter,
    product: 'papercusp-handler-runtime',
    platform: process.arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64',
  });
}

/** The supervisor wraps spawn AND exact readiness in the installer's lease.
 * Low-level prepareHandlerRuntime remains a host-only component/testing seam;
 * ordinary production routing must require prepareApprovedHandlerRuntime.
 */
export async function withHandlerRuntimeAuthorization<T>(runtime: PreparedHandlerRuntime, effect: () => Promise<T>): Promise<T> {
  const files = snapshots.get(runtime);
  if (!files) throw new Error('handler runtime was not prepared by this host');
  const approval = approvals.get(runtime);
  if (!approval) return effect();
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('unsupported approved handler runtime platform');
  let called = false;
  const result = await approval.withCurrentTrust(async ({ trust, expected, now }) => {
    if (called) throw new Error('handler runtime trust transaction reused');
    called = true;
    const platform = process.arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64';
    if (expected?.artifactSha256 !== handlerTrustedRuntimeDigest(files)
      || expected.policySha256 !== files.find(file => file.path === '/runtime/bootstrap.cjs')!.sha256
      || expected.configurationSha256 !== handlerRuntimeConfigurationDigest()
      || expected.product !== 'papercusp-handler-runtime' || expected.platform !== platform) {
      throw new Error('approved handler runtime inputs differ from mounted runtime');
    }
    const verified = await verifyTauriUpdateAuthorization(trust, approval.envelope, expected, now);
    if (!verified.valid) throw new Error(`handler runtime approval refused: ${verified.reason ?? verified.error}`);
    activeLeases.set(runtime, (activeLeases.get(runtime) ?? 0) + 1);
    try { return await effect(); }
    finally {
      const count = activeLeases.get(runtime)! - 1;
      if (count) activeLeases.set(runtime, count); else activeLeases.delete(runtime);
    }
  });
  if (!called) throw new Error('handler runtime trust transaction did not authorize admission');
  return result;
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
  if (approvals.has(runtime) && !activeLeases.has(runtime)) throw new Error('handler runtime requires a current protected trust lease');
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
