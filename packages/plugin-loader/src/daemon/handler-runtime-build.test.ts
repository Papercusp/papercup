/** Real compiler/signatures; CURRENT trust is injected solely for this unit
 * suite. Native protected-root/lease tests live in handler-runtime-authorization.
 * Fixture authorities do not qualify production source history or shipment.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTauriUpdateAuthorization, type TauriUpdateEnvelope, type TauriUpdateTrust } from '@papercusp/tauri-release-kit/signature';
import { buildAuthenticatedHandlerRuntime, handlerBuildInputCandidate, prepareInstalledHandlerRuntime, type HandlerBuildInput } from './handler-runtime-build';
import { handlerRuntimeDigest, requireApprovedHandlerRuntime } from './handler-runtime';

const current = vi.hoisted(() => ({ trust: null as TauriUpdateTrust | null, held: false, before: null as (() => void) | null }));
vi.mock('./handler-runtime', async importOriginal => ({ ...await importOriginal<typeof import('./handler-runtime')>(),
  async withCurrentHandlerRuntimeTrust<T>(use: (state: { trust: TauriUpdateTrust; now: number }) => Promise<T>) {
    if (!current.trust) throw new Error('protected trust unavailable');
    current.before?.(); current.held = true;
    try { return await use({ trust: current.trust, now: 2000 }); } finally { current.held = false; }
  },
}));
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function key(id: string) {
  const pair = generateKeyPairSync('ed25519');
  const raw = (pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  const keyId = Buffer.from(digest(id), 'hex').subarray(0, 8);
  return { id, epoch: 1, principalId: id, revoked: false,
    publicKey: Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64'),
    sign(payload: string) {
      const signature = sign(null, createHash('blake2b512').update(payload).digest(), pair.privateKey);
      const comment = 'timestamp:1 file:source-input';
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), pair.privateKey).toString('base64');
      return Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global}\n`).toString('base64');
    } };
}
function fixture() {
  const authors = [key('author-a'), key('author-b')], reviewer = key('reviewer');
  current.trust = { rootEpoch: 2, minRollbackCounter: 3, minIssuedAt: 1000, maxMetadataAgeMs: 2000,
    signers: authors, approvers: [reviewer] };
  const identity = { sourceRevision: 'a'.repeat(40), version: '1.0.0', rollbackCounter: 3 };
  const entryPoint = '/src/entry.ts';
  const input = (path: string, text: string | Buffer, executable = false, cohort = authors): HandlerBuildInput => {
    const contents = Buffer.from(text);
    const file = { path, contents, sha256: digest(contents), executable };
    const candidate = handlerBuildInputCandidate(file, entryPoint, identity, cohort.map(key => key.principalId).sort());
    return { ...file, authorizations: cohort.map(author => {
      const payload = encodeTauriUpdateAuthorization({ ...candidate, schema: 'tauri-update-authorization-v2',
        signerId: author.id, signerEpoch: 1, approverId: reviewer.id, approverEpoch: 1,
        rootEpoch: 2, issuedAt: 1000, expiresAt: 3000 });
      return { payload, signature: author.sign(payload), approvalSignature: reviewer.sign(payload) };
    }) };
  };
  const options = { identity, entryPoint,
    sources: [input(entryPoint, 'import { value } from "./nested"; console.log("MUST_NOT_EXECUTE"); export const answer = value;'),
      input('/src/nested.ts', 'export const value: number = 42;', false, [authors[1]!])],
    assets: [input('/runtime/node', 'reviewed node binary', true)],
    handlerFiles: [{ path: '/handler/entry.cjs', contents: Buffer.from('untrusted-handler'), sha256: digest('untrusted-handler'), executable: false }] };
  return { authors, reviewer, identity, options, input };
}
afterEach(() => { current.trust = null; current.before = null; current.held = false; vi.restoreAllMocks(); });

describe.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('authenticated handler build producer', () => {
  async function installed() {
    const f = fixture();
    const produced = await buildAuthenticatedHandlerRuntime(f.options);
    const directory = mkdtempSync(join(tmpdir(), 'handler-installed-'));
    const files = produced.inventory.files.filter(file => !file.path.startsWith('/handler/'));
    for (const file of [...files, ...f.options.sources]) {
      const target = join(directory, file.path.slice(1));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.contents);
    }
    const payload = encodeTauriUpdateAuthorization({ ...produced.candidate, schema: 'tauri-update-authorization-v2',
      signerId: f.authors[0]!.id, signerEpoch: 1, approverId: f.reviewer.id, approverEpoch: 1,
      rootEpoch: 2, issuedAt: 1000, expiresAt: 3000 });
    const manifest = { schema: 'handler-runtime-files-v1', platform: 'linux', arch: process.arch,
      sha256: handlerRuntimeDigest(files), bootstrapSha256: produced.inventory.bootstrapSha256,
      files: files.map(({ path, sha256, executable }) => ({ path, sha256, executable })),
      build: { entryPoint: f.options.entryPoint, identity: f.identity,
        sources: f.options.sources.map(({ contents: _, ...source }) => source),
        assets: f.options.assets.map(({ path, authorizations }) => ({ path, authorizations })),
        authorization: { payload, signature: f.authors[0]!.sign(payload), approvalSignature: f.reviewer.sign(payload) } } };
    const save = () => writeFileSync(join(directory, 'inventory.json'), JSON.stringify(manifest));
    save();
    return { ...f, directory, manifest, save, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  }

  it('issues an approved installed runtime only from actual source signatures and matching compiled bytes', async () => {
    const f = await installed();
    try {
      const runtime = await prepareInstalledHandlerRuntime(f.directory, f.options.handlerFiles);
      expect(() => requireApprovedHandlerRuntime(runtime)).not.toThrow();
      expect(current.held).toBe(false);
    } finally { f.dispose(); }
  });

  it.each(['unsigned', 'missing-author', 'revoked-author', 'revoked-reviewer', 'forged-build', 'staged-bootstrap',
    'asset-bytes', 'source-bytes', 'symlink-file', 'symlink-directory', 'traversal', 'duplicate-assets', 'extra-field'] as const)
    ('refuses %s installed inventory before issuing a runtime', async change => {
      const f = await installed();
      try {
        if (change === 'unsigned') delete (f.manifest as Partial<typeof f.manifest>).build;
        if (change === 'missing-author') f.manifest.build.sources[0]!.authorizations = f.manifest.build.sources[0]!.authorizations.slice(0, 1);
        if (change === 'revoked-author') f.authors[0]!.revoked = true;
        if (change === 'revoked-reviewer') f.reviewer.revoked = true;
        if (change === 'forged-build') f.manifest.build.authorization.approvalSignature = f.authors[0]!.sign(f.manifest.build.authorization.payload);
        if (change === 'staged-bootstrap') {
          const bytes = Buffer.from('different bootstrap');
          writeFileSync(join(f.directory, 'runtime/bootstrap.cjs'), bytes);
          f.manifest.files.find(file => file.path === '/runtime/bootstrap.cjs')!.sha256 = digest(bytes);
          f.manifest.bootstrapSha256 = digest(bytes); f.manifest.sha256 = handlerRuntimeDigest(f.manifest.files);
        }
        if (change === 'asset-bytes') writeFileSync(join(f.directory, 'runtime/node'), 'changed asset');
        if (change === 'source-bytes') writeFileSync(join(f.directory, 'src/entry.ts'), 'changed source');
        if (change === 'symlink-file') {
          const target = join(f.directory, 'runtime/node'); rmSync(target);
          symlinkSync(join(f.directory, 'src/entry.ts'), target);
        }
        if (change === 'symlink-directory') {
          const target = join(f.directory, 'runtime'); rmSync(target, { recursive: true });
          symlinkSync(join(f.directory, 'src'), target);
        }
        if (change === 'traversal') f.manifest.files[0]!.path = '/runtime/../../etc/passwd';
        if (change === 'duplicate-assets') f.manifest.build.assets[0]!.path = '/runtime/not-in-inventory';
        if (change === 'extra-field') Object.assign(f.manifest.build.identity, { authorIds: ['forged-author'] });
        f.save();
        await expect(prepareInstalledHandlerRuntime(f.directory, f.options.handlerFiles)).rejects.toThrow();
        expect(current.held).toBe(false);
      } finally { f.dispose(); }
    });

  it('pins installed and handler bytes before asynchronous trust admission', async () => {
    const f = await installed();
    try {
      current.before = () => {
        writeFileSync(join(f.directory, 'runtime/node'), 'concurrent replacement');
        f.options.handlerFiles[0]!.contents.fill(0);
      };
      const runtime = await prepareInstalledHandlerRuntime(f.directory, f.options.handlerFiles);
      expect(() => requireApprovedHandlerRuntime(runtime)).not.toThrow();
    } finally { f.dispose(); }
  });

  it('compiles the real imported closure without executing it and derives every author from protected key principals', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'log');
    const result = await buildAuthenticatedHandlerRuntime(f.options);
    expect(log).not.toHaveBeenCalled();
    expect(result.candidate.authorIds).toEqual(['author-a', 'author-b']);
    expect(result.sourcePins).toEqual(f.options.sources.map(({ path, sha256 }) => ({ path, sha256 })));
    expect(Buffer.from(result.inventory.files.find(file => file.path === '/runtime/bootstrap.cjs')!.contents).toString()).toContain('42');
    expect(result.candidate.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(current.held).toBe(false);
  });

  it('builds the actual maintained bootstrap and all its static transitive imports using reviewed fixture bytes', async () => {
    const f = fixture();
    const names = ['handler-bootstrap.ts', 'handler-seccomp.ts', 'jsonrpc-bridge.ts'];
    f.options.sources = names.map(name => f.input('/src/' + (name === 'handler-bootstrap.ts' ? 'entry.ts' : name),
      readFileSync(new URL('./' + name, import.meta.url))));
    const result = await buildAuthenticatedHandlerRuntime(f.options);
    expect(result.sourcePins).toHaveLength(3);
    expect(Buffer.from(result.inventory.files.find(file => file.path === '/runtime/bootstrap.cjs')!.contents).toString()).toContain('papercup.handlerInitialize');
  });

  it('snapshots source, asset, handler bytes, identity and signatures before awaiting protected trust', async () => {
    const f = fixture();
    current.before = () => {
      f.options.sources[1]!.contents.fill(0); f.options.assets[0]!.contents.fill(0);
      f.options.handlerFiles[0]!.contents.fill(0); f.options.identity.version = 'evil';
      (f.options.sources[0]!.authorizations as TauriUpdateEnvelope[]).splice(0);
    };
    const result = await buildAuthenticatedHandlerRuntime(f.options);
    expect(result.candidate.version).toBe('1.0.0');
    expect(Buffer.from(result.inventory.files.find(file => file.path === '/runtime/node')!.contents).toString()).toBe('reviewed node binary');
    expect(Buffer.from(result.inventory.files.find(file => file.path === '/handler/entry.cjs')!.contents).toString()).toBe('untrusted-handler');
  });

  it.each(['source', 'asset'] as const)('refuses a missing coauthor signature on a %s instead of shrinking the author set', async kind => {
    const f = fixture(), file = kind === 'source' ? f.options.sources[0]! : f.options.assets[0]!;
    file.authorizations = file.authorizations.slice(0, 1);
    await expect(buildAuthenticatedHandlerRuntime(f.options)).rejects.toThrow(/authorIds/);
    expect(current.held).toBe(false);
  });

  it.each(['missing', 'revoked-author', 'revoked-reviewer', 'self-review', 'signature', 'root', 'expired', 'rollback'] as const)
    ('refuses %s authority before producing a runtime', async change => {
      const f = fixture();
      if (change === 'missing') current.trust = null;
      if (change === 'revoked-author') f.authors[1]!.revoked = true;
      if (change === 'revoked-reviewer') f.reviewer.revoked = true;
      if (change === 'self-review') f.reviewer.principalId = 'author-b';
      if (change === 'signature') (f.options.sources[0]!.authorizations[0]!).approvalSignature = f.authors[0]!.sign(f.options.sources[0]!.authorizations[0]!.payload);
      if (change === 'root') current.trust!.rootEpoch++;
      if (change === 'expired') current.trust!.minIssuedAt = 2001;
      if (change === 'rollback') current.trust!.minRollbackCounter++;
      await expect(buildAuthenticatedHandlerRuntime(f.options)).rejects.toThrow();
      expect(current.held).toBe(false);
    });

  it.each(['omitted', 'extra', 'dynamic', 'dynamic-import', 'eval', 'ambient'] as const)('refuses %s compiler closure without reading ambient source', async change => {
    const f = fixture();
    if (change === 'omitted') f.options.sources.pop();
    if (change === 'extra') f.options.sources.push(f.input('/src/extra.ts', 'export const ignored = 1;'));
    if (change === 'dynamic') f.options.sources = [f.input('/src/entry.ts', 'const name = process.argv[2]; require(name);')];
    if (change === 'dynamic-import') f.options.sources = [f.input('/src/entry.ts', 'const name = process.argv[2]; import(name);')];
    if (change === 'eval') f.options.sources = [f.input('/src/entry.ts', 'eval(process.argv[2]);')];
    if (change === 'ambient') f.options.sources = [f.input('/src/entry.ts', 'import "file:///etc/passwd";')];
    await expect(buildAuthenticatedHandlerRuntime(f.options)).rejects.toThrow();
    expect(current.held).toBe(false);
  });

  it.each(['missing-receipts', 'duplicate-author', 'principal-substitution', 'duplicate-path', 'handler-asset'] as const)
    ('refuses %s provenance instead of accepting caller authority', async change => {
      const f = fixture();
      if (change === 'missing-receipts') f.options.sources[0]!.authorizations = [];
      if (change === 'duplicate-author') f.options.sources[0]!.authorizations = Array(2).fill(f.options.sources[0]!.authorizations[0]);
      if (change === 'principal-substitution') f.authors[0]!.principalId = 'claimed-new-author';
      if (change === 'duplicate-path') f.options.sources.push(f.options.sources[0]!);
      if (change === 'handler-asset') f.options.handlerFiles[0]!.path = '/runtime/node';
      await expect(buildAuthenticatedHandlerRuntime(f.options)).rejects.toThrow();
    });

  it.each(['path', 'mode', 'bytes', 'revision', 'version', 'entry'] as const)('binds signed input %s to the actual build', async change => {
    const f = fixture();
    if (change === 'path') f.options.assets[0]!.path = '/runtime/other';
    if (change === 'mode') f.options.assets[0]!.executable = false;
    if (change === 'bytes') { f.options.sources[1]!.contents = Buffer.from('export const value = 7;'); f.options.sources[1]!.sha256 = digest(f.options.sources[1]!.contents); }
    if (change === 'revision') f.options.identity.sourceRevision = 'b'.repeat(40);
    if (change === 'version') f.options.identity.version = '2.0.0';
    if (change === 'entry') f.options.entryPoint = '/src/nested.ts';
    await expect(buildAuthenticatedHandlerRuntime(f.options)).rejects.toThrow();
  });
});
