/** Real dual signatures + host admission effects. Development proof only;
 * keys/authors are test-owned and do not establish production build provenance.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { encodeTauriUpdateAuthorization, type TauriUpdateAuthorization, type TauriUpdateCandidate,
  type TauriUpdateTrust } from '@papercusp/tauri-release-kit/signature';
import { handlerRuntimeConfigurationDigest, handlerRuntimeDigest, handlerTrustedRuntimeDigest,
  createHandlerRuntimeCandidate, openHandlerRuntime, prepareApprovedHandlerRuntime, withHandlerRuntimeAuthorization,
  type HandlerRuntimeFile, type HandlerRuntimeApproval } from './handler-runtime';
import { startDaemonPlugin } from './supervisor';

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
    const { build } = await import('@papercusp/host-esbuild');
    const built = await build({ entryPoints: [fileURLToPath(new URL('./handler-bootstrap.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'cjs', write: false, external: ['koffi'] });
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
    add('/runtime/bootstrap.cjs', Buffer.from(built.outputFiles![0]!.contents));
    add('/handler/entry.cjs', Buffer.from(`
      console.error('APPROVED_HANDLER_STARTED');
      exports.requests = { 'fixture.echo': input => input, 'fixture.exit': () => {
        setTimeout(() => process.exit(2),20); return true;
      }};
    `));
    f.inventory.files = [...files.values()];
    f.inventory.sha256 = handlerRuntimeDigest(f.inventory.files);
    f.inventory.bootstrapSha256 = files.get('/runtime/bootstrap.cjs')!.sha256;
    Object.assign(f.expected, { artifactSha256: handlerTrustedRuntimeDigest(f.inventory.files), policySha256: f.inventory.bootstrapSha256 });
    Object.assign(f.metadata, f.expected); f.approval.envelope = f.envelope();
    const runtime = prepareApprovedHandlerRuntime(f.inventory, f.approval);
    const startupLeases: boolean[] = [];
    let refused!: (line: string) => void;
    const refusal = new Promise<string>(resolve => { refused = resolve; });
    const handle = await startDaemonPlugin({ pluginName: 'approved-real-fixture', sandbox: 'handler', handlerRuntime: runtime,
      cmd: [], cwd: '/', healthIntervalMs: 0, restart: { policy: 'on-failure', maxRestarts: 1, backoffMs: 1 },
      onLog(line) {
        if (line === 'APPROVED_HANDLER_STARTED') startupLeases.push(f.held());
        if (line.includes('respawn refused:')) refused(line);
      } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await handle.request('fixture.echo', 'READY')).toBe('READY');
      expect(startupLeases).toEqual([true]); expect(f.held()).toBe(false);
      f.reviewer.revoked = true;
      expect(await handle.request('fixture.exit')).toBe(true);
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('revoked restart was not refused')), 5000); });
      expect(await Promise.race([refusal, deadline])).toMatch(/admission refused.*revoked/);
      expect(startupLeases).toEqual([true]);
      await expect(handle.request('fixture.echo', 'UNSAFE')).rejects.toThrow(/not running/);
    } finally { if (timer) clearTimeout(timer); await handle.shutdown(); }
  }, 30_000);
});
