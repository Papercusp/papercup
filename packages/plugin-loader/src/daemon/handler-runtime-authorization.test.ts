/** Real dual signatures + host admission effects. Development proof only;
 * keys/authors are test-owned and do not establish production build provenance.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTauriUpdateAuthorization, type TauriUpdateAuthorization, type TauriUpdateCandidate,
  type TauriUpdateTrust } from '@papercusp/tauri-release-kit/signature';
import { handlerRuntimeConfigurationDigest, handlerRuntimeDigest, handlerTrustedRuntimeDigest,
  createCurrentHandlerRuntimeApproval, createHandlerRuntimeCandidate, openHandlerRuntime, prepareApprovedHandlerRuntime, withHandlerRuntimeAuthorization,
  type HandlerRuntimeFile, type HandlerRuntimeApproval } from './handler-runtime';
import { startDaemonPlugin } from './supervisor';

// Relocate ONLY the fixed root and owner metadata for this unprivileged fixture.
// Production exposes no path/uid override. openat, flock, bytes and all modes
// remain real kernel operations, shared with an independent flock process.
const protectedFixture = vi.hoisted(() => ({ root: '', badOwner: false }));
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => real.openSync(
      args[0] === '/' && protectedFixture.root ? protectedFixture.root : args[0], args[1], args[2]),
    fstatSync(fd: number, options?: { bigint?: boolean }) {
      const stat = options?.bigint ? real.fstatSync(fd, { bigint: true }) : real.fstatSync(fd);
      if (protectedFixture.root && real.readlinkSync(`/proc/self/fd/${fd}`).startsWith(protectedFixture.root)) {
        Object.defineProperty(stat, 'uid', { value: typeof stat.uid === 'bigint'
          ? BigInt(protectedFixture.badOwner ? 1 : 0) : protectedFixture.badOwner ? 1 : 0 });
      }
      return stat;
    },
  };
});

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const key = (id: string) => {
    const pair = generateKeyPairSync('ed25519');
    const raw = (pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
    const keyId = Buffer.from(digest(id), 'hex').subarray(0, 8);
    return { id, epoch: 1, principalId: id, revoked: false,
      publicKey: Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64'),
      sign(payload: string) {
        const signature = sign(null, createHash('blake2b512').update(payload).digest(), pair.privateKey);
        const comment = 'timestamp:1 file:handler-runtime';
        const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), pair.privateKey).toString('base64');
        return Buffer.from(`untrusted comment: runtime\n${Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global}\n`).toString('base64');
      } };
  };
  const signer = key('release'), reviewer = key('independent-reviewer');
  const files: HandlerRuntimeFile[] = ['/runtime/node', '/runtime/bootstrap.cjs', '/handler/entry.cjs', '/lib/libfixture.so']
    .map(path => ({ path, contents: Buffer.from(path), executable: path === '/runtime/node', sha256: digest(path) }));
  const inventory = { files, sha256: handlerRuntimeDigest(files), bootstrapSha256: files[1]!.sha256 };
  const expected: TauriUpdateCandidate = { artifactSha256: handlerTrustedRuntimeDigest(files),
    policySha256: inventory.bootstrapSha256, configurationSha256: handlerRuntimeConfigurationDigest(),
    sourceRevision: 'a'.repeat(40), version: '1.0.0', product: 'papercusp-handler-runtime',
    platform: process.arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64', authorIds: ['author-a', 'author-b'], rollbackCounter: 3 };
  const trust: TauriUpdateTrust = { rootEpoch: 2, minRollbackCounter: 3, minIssuedAt: 1000,
    maxMetadataAgeMs: 2000, signers: [signer], approvers: [reviewer] };
  const metadata: TauriUpdateAuthorization = { ...expected, schema: 'tauri-update-authorization-v2',
    signerId: signer.id, signerEpoch: 1, approverId: reviewer.id, approverEpoch: 1,
    rootEpoch: 2, issuedAt: 1000, expiresAt: 3000 };
  const envelope = (record = metadata) => {
    const payload = encodeTauriUpdateAuthorization(record);
    return { payload, signature: signer.sign(payload), approvalSignature: reviewer.sign(payload) };
  };
  let held = false;
  let now = 2000;
  const approval: HandlerRuntimeApproval = { envelope: envelope(), async withCurrentTrust(use) {
    held = true;
    try { return await use({ trust, expected, now }); } finally { held = false; }
  } };
  return { files, inventory, expected, trust, metadata, signer, reviewer, envelope, approval,
    held: () => held, time: (time: number) => { now = time; } };
}

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('protected native runtime trust adapter', () => {
  let f: ReturnType<typeof fixture>;
  let directory: string;
  let policy: string;
  const writePolicy = () => {
    writeFileSync(policy, JSON.stringify({ version: 1, update_channel: 'stable', updateAuthorization: f.trust }), { mode: 0o644 });
    chmodSync(policy, 0o644);
  };
  const exclusive = () => spawnSync('/usr/bin/flock', ['-xn', directory, '/bin/true']).status;
  const runtime = () => prepareApprovedHandlerRuntime(f.inventory, createCurrentHandlerRuntimeApproval(f.envelope(), f.expected));
  beforeEach(() => {
    protectedFixture.root = mkdtempSync(join(tmpdir(), 'handler-current-trust-'));
    directory = join(protectedFixture.root, 'etc/papercusp');
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    policy = join(directory, 'managed-policy.json');
    f = fixture(); writePolicy();
    vi.spyOn(Date, 'now').mockReturnValue(2000);
  });
  afterEach(() => {
    vi.restoreAllMocks(); protectedFixture.badOwner = false;
    rmSync(protectedFixture.root, { recursive: true, force: true }); protectedFixture.root = '';
  });

  it('holds the actual shared native lock through async readiness, permits other readers and releases after success', async () => {
    const prepared = runtime();
    let ready!: () => void;
    const barrier = new Promise<void>(resolve => { ready = resolve; });
    let entered!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const pending = withHandlerRuntimeAuthorization(prepared, async () => {
      entered(); await barrier;
      expect(exclusive()).toBe(1);
      return 'READY';
    });
    try {
      // A refusal must fail this test immediately, never strand the readiness
      // waiter on an effect that was correctly never entered.
      await Promise.race([admission, pending]);
      expect(exclusive()).toBe(1);
      expect(spawnSync('/usr/bin/flock', ['-sn', directory, '/bin/true']).status).toBe(0);
    } finally { ready(); }
    expect(await pending).toBe('READY');
    expect(exclusive()).toBe(0);
    expect(() => openHandlerRuntime(prepared)).toThrow(/current protected trust lease/);
  }, 10_000);

  it('refuses admission while an independent native activator holds the exclusive directory lock', async () => {
    const holder = spawn('/usr/bin/flock', ['-xn', directory, '/bin/sh', '-c', 'printf READY; cat >/dev/null'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(holder, 'close');
    try {
      expect((await once(holder.stdout, 'data'))[0].toString()).toBe('READY');
      const effect = vi.fn(async () => 'UNSAFE');
      await expect(withHandlerRuntimeAuthorization(runtime(), effect)).rejects.toThrow(/busy or unavailable/);
      expect(effect).not.toHaveBeenCalled();
    } finally { holder.stdin.end(); await closed; }
    expect(exclusive()).toBe(0);
  });

  it.each([false, true])('releases the actual lock after an admission failure (async=%s)', async deferred => {
    await expect(withHandlerRuntimeAuthorization(runtime(), async () => {
      if (deferred) await Promise.resolve();
      expect(exclusive()).toBe(1); throw new Error('readiness failed');
    })).rejects.toThrow('readiness failed');
    expect(exclusive()).toBe(0);
  });

  it('reloads CURRENT protected revocation on the next admission without rebuilding the runtime', async () => {
    const prepared = runtime();
    await expect(withHandlerRuntimeAuthorization(prepared, async () => 'READY')).resolves.toBe('READY');
    f.reviewer.revoked = true; writePolicy();
    const effect = vi.fn(async () => 'UNSAFE');
    await expect(withHandlerRuntimeAuthorization(prepared, effect)).rejects.toThrow(/revoked/);
    expect(effect).not.toHaveBeenCalled(); expect(exclusive()).toBe(0);
  });

  it.each(['missing', 'malformed', 'writable', 'symlink', 'ancestor', 'owner', 'oversize'] as const)(
    'refuses %s protected policy before the admission effect and releases descriptors', async defect => {
      if (defect === 'missing') rmSync(policy);
      if (defect === 'malformed') writeFileSync(policy, '{');
      if (defect === 'writable') chmodSync(policy, 0o666);
      if (defect === 'symlink') {
        const donor = join(protectedFixture.root, 'donor'); writeFileSync(donor, readFileSync(policy));
        rmSync(policy); symlinkSync(donor, policy);
      }
      if (defect === 'ancestor') chmodSync(join(protectedFixture.root, 'etc'), 0o777);
      if (defect === 'owner') protectedFixture.badOwner = true;
      if (defect === 'oversize') writeFileSync(policy, 'x'.repeat(16_385));
      const effect = vi.fn(async () => 'UNSAFE');
      await expect(withHandlerRuntimeAuthorization(runtime(), effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled(); expect(exclusive()).toBe(0);
    });
});

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('approved handler runtime admission', () => {
  it('derives reviewed runtime inputs from bytes and snapshots every source author independently of the envelope', async () => {
    const f = fixture();
    const identity = { sourceRevision: f.expected.sourceRevision, version: f.expected.version,
      authorIds: [...f.expected.authorIds], rollbackCounter: f.expected.rollbackCounter };
    const candidate = createHandlerRuntimeCandidate(f.inventory, identity);
    expect(candidate).toEqual(f.expected);
    identity.authorIds.pop(); identity.sourceRevision = 'b'.repeat(40);
    expect(candidate.authorIds).toEqual(['author-a', 'author-b']);
    expect(candidate.sourceRevision).toBe('a'.repeat(40));
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.authorIds)).toBe(true);
    f.approval.withCurrentTrust = async use => use({ trust: f.trust, expected: candidate, now: 2000 });
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    await expect(withHandlerRuntimeAuthorization(runtime, async () => 'READY')).resolves.toBe('READY');
    f.reviewer.principalId = 'author-b';
    const effect = vi.fn(async () => 'UNSAFE');
    await expect(withHandlerRuntimeAuthorization(runtime, effect)).rejects.toThrow(/independent/);
    expect(effect).not.toHaveBeenCalled();
    f.files[0]!.contents.fill(0);
    expect(() => createHandlerRuntimeCandidate(f.inventory, identity)).toThrow(/file digest mismatch/);
  });

  it('refuses empty authors and candidate-selected digests before producing a host candidate', () => {
    const f = fixture();
    const identity = { sourceRevision: f.expected.sourceRevision, version: f.expected.version,
      authorIds: [] as string[], rollbackCounter: f.expected.rollbackCounter };
    expect(() => createHandlerRuntimeCandidate(f.inventory, identity)).toThrow(/exact candidate/);
    identity.authorIds = ['author-a', 'author-b'];
    const getter = vi.fn(() => identity.authorIds);
    const accessor = { ...identity };
    Object.defineProperty(accessor, 'authorIds', { get: getter });
    expect(() => createHandlerRuntimeCandidate(f.inventory, accessor)).toThrow(/protected handler build identity/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createHandlerRuntimeCandidate(f.inventory,
      { ...identity, artifactSha256: 'f'.repeat(64) } as typeof identity)).toThrow(/protected handler build identity/);
  });

  it('holds current independent trust through the asynchronous admission effect and refuses opening after release', async () => {
    const f = fixture();
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    await expect(withHandlerRuntimeAuthorization(runtime, async () => {
      expect(f.held()).toBe(true);
      await Promise.resolve(); expect(f.held()).toBe(true);
      return 'READY';
    })).resolves.toBe('READY');
    expect(f.held()).toBe(false);
    expect(() => openHandlerRuntime(runtime)).toThrow(/current protected trust lease/);
  });

  it('snapshots trusted files and envelope before caller mutation; handler bytes have a separate installation identity', async () => {
    const f = fixture();
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    const oldTrusted = handlerTrustedRuntimeDigest(f.files), oldAll = handlerRuntimeDigest(f.files);
    f.files[2]!.contents = Buffer.from('different untrusted handler'); f.files[2]!.sha256 = digest(f.files[2]!.contents);
    expect(handlerTrustedRuntimeDigest(f.files)).toBe(oldTrusted);
    expect(handlerRuntimeDigest(f.files)).not.toBe(oldAll);
    f.files[0]!.contents.fill(0); f.files.length = 0;
    f.approval.envelope.payload = 'changed';
    await expect(withHandlerRuntimeAuthorization(runtime, async () => 'ORIGINAL')).resolves.toBe('ORIGINAL');
  });

  it.each(['artifactSha256', 'policySha256', 'configurationSha256', 'product', 'platform'] as const)
    ('refuses a correctly signed %s substitution before any admission effect', async field => {
      const f = fixture();
      const wrong = { ...f.metadata, [field]: field.endsWith('Sha256') ? 'f'.repeat(64) : 'other' };
      Object.assign(f.expected, { [field]: wrong[field] });
      f.approval.envelope = f.envelope(wrong);
      const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
      const effect = vi.fn(async () => 'UNSAFE');
      await expect(withHandlerRuntimeAuthorization(runtime, effect)).rejects.toThrow(/inputs differ/);
      expect(effect).not.toHaveBeenCalled();
    });

  it.each(['revoke-reviewer', 'revoke-release', 'expire', 'rollback', 'root', 'author'] as const)
    ('rechecks %s after an initial admission, rather than caching approval', async change => {
      const f = fixture();
      const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
      const effect = vi.fn(async () => 'READY');
      await withHandlerRuntimeAuthorization(runtime, effect);
      if (change === 'revoke-reviewer') f.reviewer.revoked = true;
      if (change === 'revoke-release') f.signer.revoked = true;
      if (change === 'expire') f.time(3000);
      if (change === 'rollback') f.trust.minRollbackCounter = 4;
      if (change === 'root') f.trust.rootEpoch = 3;
      if (change === 'author') f.expected.authorIds = ['different-author'];
      await expect(withHandlerRuntimeAuthorization(runtime, effect)).rejects.toThrow(/approval refused/);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(f.held()).toBe(false);
    });

  it('refuses reviewer/author overlap and tampered independent approval without an effect', async () => {
    const f = fixture();
    f.reviewer.principalId = 'author-b';
    const effect = vi.fn(async () => 'UNSAFE');
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    await expect(withHandlerRuntimeAuthorization(runtime, effect)).rejects.toThrow(/independent/);
    f.reviewer.principalId = 'independent-reviewer';
    f.approval.envelope.approvalSignature = f.signer.sign(f.approval.envelope.payload);
    const tampered = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    await expect(withHandlerRuntimeAuthorization(tampered, effect)).rejects.toThrow(/approval signature/);
    expect(effect).not.toHaveBeenCalled();
  });

  it('supervisor refuses revoked authority before spawn, with no startup or raw fallback', async () => {
    const f = fixture();
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    f.reviewer.revoked = true;
    const log = vi.fn(); const audit = vi.fn();
    await expect(startDaemonPlugin({ pluginName: 'approved-fixture', sandbox: 'handler', handlerRuntime: runtime,
      cmd: [], cwd: '/', healthIntervalMs: 0, onLog: log, onAudit: audit })).rejects.toThrow(/admission refused.*revoked/);
    expect(log).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });

  it('keeps real restricted startup inside current trust and refuses a revoked restart', async () => {
    const f = fixture();
    const require = createRequire(import.meta.url);
    const { buildAuthenticatedHandlerRuntime, handlerBuildInputCandidate } = await import('./handler-runtime-build');
    const files = new Map<string, HandlerRuntimeFile>();
    const add = (path: string, contents: Buffer, executable = false) => files.set(path, { path, contents, executable, sha256: digest(contents) });
    // TEST FIXTURE ONLY: production consumes the approved complete packaged
    // inventory and must never run a candidate or ldd to discover dependencies.
    const libraries = (file: string) => {
      const text = execFileSync('/usr/bin/ldd', [file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      for (const path of new Set(text.match(/\/[^\s()]+/g) ?? [])) add(path, readFileSync(path), true);
    };
    add('/runtime/node', readFileSync(process.execPath), true); libraries(process.execPath);
    const koffi = dirname(require.resolve('koffi'));
    for (const path of ['package.json', 'index.cjs', 'src/koffi/index.cjs', 'src/koffi/src/static.cjs']) {
      add('/runtime/node_modules/koffi/' + path, readFileSync(join(koffi, path)));
    }
    const native = join(dirname(require.resolve('@koromix/koffi-linux-' + process.arch)), 'linux_' + process.arch, 'koffi.node');
    add('/runtime/node_modules/koffi/build/koffi/linux_' + process.arch + '/koffi.node', readFileSync(native), true); libraries(native);
    const seccomp = '/lib/' + (process.arch === 'x64' ? 'x86_64' : 'aarch64') + '-linux-gnu/libseccomp.so.2';
    add(seccomp, readFileSync(seccomp), true); libraries(seccomp);
    add('/handler/entry.cjs', Buffer.from(`
      console.error('APPROVED_HANDLER_STARTED');
      exports.requests = { 'fixture.echo': input => input, 'fixture.exit': () => {
        setTimeout(() => process.exit(2),20); return true;
      }};
    `));
    // Exercise the real native adapter through supervisor readiness/restart,
    // with only the protected filesystem root/uid relocated for this fixture.
    const policyRoot = mkdtempSync(join(tmpdir(), 'handler-ready-trust-'));
    protectedFixture.root = policyRoot;
    const policyDirectory = join(policyRoot, 'etc/papercusp');
    mkdirSync(policyDirectory, { recursive: true, mode: 0o755 });
    const writeCurrent = () => writeFileSync(join(policyDirectory, 'managed-policy.json'),
      JSON.stringify({ version: 1, update_channel: 'stable', updateAuthorization: f.trust }), { mode: 0o644 });
    writeCurrent();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2000);
    const held = () => spawnSync('/usr/bin/flock', ['-xn', policyDirectory, '/bin/true']).status === 1;
    const startupLeases: boolean[] = [];
    let refused!: (line: string) => void;
    const refusal = new Promise<string>(resolve => { refused = resolve; });
    let handle: Awaited<ReturnType<typeof startDaemonPlugin>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entryPoint = '/src/handler-bootstrap.ts';
      const identity = { sourceRevision: f.expected.sourceRevision, version: f.expected.version, rollbackCounter: f.expected.rollbackCounter };
      const attest = (file: HandlerRuntimeFile) => {
        const expected = handlerBuildInputCandidate(file, entryPoint, identity, [f.signer.principalId]);
        const payload = encodeTauriUpdateAuthorization({ ...f.metadata, ...expected });
        return { ...file, authorizations: [{ payload, signature: f.signer.sign(payload), approvalSignature: f.reviewer.sign(payload) }] };
      };
      const built = await buildAuthenticatedHandlerRuntime({ entryPoint, identity,
        sources: ['handler-bootstrap.ts', 'handler-seccomp.ts', 'jsonrpc-bridge.ts'].map(name => {
          const contents = readFileSync(new URL('./' + name, import.meta.url));
          return attest({ path: '/src/' + name, contents, sha256: digest(contents), executable: false });
        }),
        assets: [...files.values()].filter(file => !file.path.startsWith('/handler/')).map(attest),
        handlerFiles: [files.get('/handler/entry.cjs')!] });
      f.inventory = built.inventory;
      Object.assign(f.expected, built.candidate); Object.assign(f.metadata, f.expected);
      expect(held()).toBe(false);
      const runtime = prepareApprovedHandlerRuntime(f.inventory, createCurrentHandlerRuntimeApproval(f.envelope(), f.expected));
      handle = await startDaemonPlugin({ pluginName: 'approved-real-fixture', sandbox: 'handler', handlerRuntime: runtime,
        cmd: [], cwd: '/', healthIntervalMs: 0, restart: { policy: 'on-failure', maxRestarts: 1, backoffMs: 1 },
        onLog(line) {
          if (line === 'APPROVED_HANDLER_STARTED') startupLeases.push(held());
          if (line.includes('respawn refused:')) refused(line);
        } });
      expect(await handle.request('fixture.echo', 'READY')).toBe('READY');
      expect(startupLeases).toEqual([true]); expect(held()).toBe(false);
      f.reviewer.revoked = true; writeCurrent();
      expect(await handle.request('fixture.exit')).toBe(true);
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('revoked restart was not refused')), 5000); });
      expect(await Promise.race([refusal, deadline])).toMatch(/admission refused.*revoked/);
      expect(startupLeases).toEqual([true]);
      await expect(handle.request('fixture.echo', 'UNSAFE')).rejects.toThrow(/not running/);
    } finally {
      if (timer) clearTimeout(timer);
      await handle?.shutdown(); clock.mockRestore();
      rmSync(policyRoot, { recursive: true, force: true }); protectedFixture.root = '';
    }
  }, 30_000);
});
