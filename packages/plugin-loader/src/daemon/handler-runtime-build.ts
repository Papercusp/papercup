/** Protected build producer, reusing the existing release authorization protocol
 * and native administrator trust lease. No provenance database or new key store.
 *
 * Each input's complete author set is certified by its authors AND an independent
 * approver: each listed author must sign the same exact bytes/path/build identity.
 * Removing a coauthor receipt cannot shrink the signed author set. Signer principal
 * identities come from CURRENT protected keys, never git text or caller labels.
 * Upstream native binaries need the same reviewed attestations; this producer does
 * not execute candidates/ldd to discover their dependencies or claim source history
 * can be inferred from a binary. Enrolling upstream authorities is an admin action.
 */
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { build, version as compilerVersion, type Loader } from '@papercusp/host-esbuild';
import { parseTauriUpdateEnvelope, parseTauriUpdateCandidate, verifyTauriUpdateAuthorization,
  type TauriUpdateCandidate, type TauriUpdateEnvelope, type TauriUpdateTrust } from '@papercusp/tauri-release-kit/signature';
import { createHandlerRuntimeCandidate, handlerRuntimeConfigurationDigest, handlerRuntimeDigest,
  withCurrentHandlerRuntimeTrust, type HandlerRuntimeBuildIdentity, type HandlerRuntimeFile } from './handler-runtime';

export interface HandlerBuildInput extends HandlerRuntimeFile {
  /** One existing dual-signed authorization per authenticated source author. */
  authorizations: readonly TauriUpdateEnvelope[];
}
export type HandlerBuildIdentity = Omit<HandlerRuntimeBuildIdentity, 'authorIds'>;
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const loaders: Record<string, Loader> = { '.ts': 'ts', '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.json': 'json' };

/** Exact fields to be signed using encodeTauriUpdateAuthorization. Path and mode
 * are bound as policy; the fixed compiler profile/entry point are configuration.
 * Author principals supplied here are NOT authenticated until the build verifies
 * every receipt against current administrator keys.
 */
export function handlerBuildInputCandidate(input: Omit<HandlerBuildInput, 'authorizations'>,
  entryPoint: string, identity: HandlerBuildIdentity, authorIds: readonly string[]): TauriUpdateCandidate {
  return parseTauriUpdateCandidate({ artifactSha256: input.sha256,
    policySha256: digest(JSON.stringify({ path: input.path, executable: input.executable })),
    configurationSha256: digest(JSON.stringify({ profile: 'handler-snapshot-build-v1', entryPoint,
      runtime: handlerRuntimeConfigurationDigest(), compiler: 'esbuild-0.25.0', format: 'cjs', target: 'node22' })),
    sourceRevision: identity.sourceRevision, version: identity.version, rollbackCounter: identity.rollbackCounter,
    product: 'papercusp-handler-input', platform: process.arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64', authorIds });
}

async function authenticate(input: HandlerBuildInput, entry: string, identity: HandlerBuildIdentity,
  trust: TauriUpdateTrust, now: number): Promise<readonly string[]> {
  const principals = input.authorizations.map(envelope => {
    const metadata = JSON.parse(envelope.payload);
    const matches = trust.signers.filter(key => key.id === metadata.signerId && key.epoch === metadata.signerEpoch);
    if (matches.length !== 1 || matches[0]!.revoked !== false) throw new Error('input author key absent, ambiguous or revoked');
    return matches[0]!.principalId;
  }).sort();
  if (principals.some((id, i) => i > 0 && id === principals[i - 1])) throw new Error('duplicate input author principal');
  const expected = handlerBuildInputCandidate(input, entry, identity, principals);
  for (const envelope of input.authorizations) {
    const verified = await verifyTauriUpdateAuthorization(trust, envelope, expected, now);
    if (!verified.valid) throw new Error(`handler build input refused: ${verified.reason ?? verified.error}`);
  }
  return expected.authorIds;
}

/** Compile ONLY authenticated snapshotted bytes. There is no filesystem fallback,
 * caller compiler plugin, caller metafile, ambient NODE_OPTIONS, or execution of
 * candidate code. Native/runtime assets are explicit reviewed build inputs.
 * Handler files are untrusted and excluded from the trusted build identity.
 */
export async function buildAuthenticatedHandlerRuntime(options: {
  entryPoint: string;
  identity: HandlerBuildIdentity;
  sources: readonly HandlerBuildInput[];
  assets: readonly HandlerBuildInput[];
  handlerFiles: readonly HandlerRuntimeFile[];
}) {
  const { entryPoint } = options;
  const identity: HandlerBuildIdentity = { sourceRevision: options.identity.sourceRevision,
    version: options.identity.version, rollbackCounter: options.identity.rollbackCounter };
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('unsupported handler build platform');
  if (compilerVersion !== '0.25.0') throw new Error('reviewed handler build compiler differs');
  const canonical = (path: string) => typeof path === 'string' && path.startsWith('/')
    && path === posix.normalize(path) && !/[\x00-\x20\x7f\\]/.test(path) && !path.endsWith('/');
  if (!canonical(entryPoint) || !entryPoint.startsWith('/src/')) throw new Error('invalid handler build entry point');
  if (!Array.isArray(options.sources) || !options.sources.length || !Array.isArray(options.assets)
    || !options.assets.length || !Array.isArray(options.handlerFiles)
    || options.sources.length + options.assets.length + options.handlerFiles.length > 1023) throw new Error('invalid handler build population');
  let total = 0;
  const snapshot = (file: HandlerRuntimeFile): HandlerRuntimeFile => {
    if (!canonical(file.path) || typeof file.executable !== 'boolean' || !(file.contents instanceof Uint8Array)
      || file.contents.byteLength > 256 * 1024 * 1024 || (total += file.contents.byteLength) > 512 * 1024 * 1024) {
      throw new Error('invalid handler build input');
    }
    const contents = Buffer.from(file.contents);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || digest(contents) !== file.sha256) throw new Error('handler build input digest mismatch');
    return { path: file.path, executable: file.executable, sha256: file.sha256, contents };
  };
  const pin = (input: HandlerBuildInput): HandlerBuildInput => {
    if (!Array.isArray(input.authorizations) || !input.authorizations.length || input.authorizations.length > 64) {
      throw new Error('complete authenticated input authors required');
    }
    return { ...snapshot(input), authorizations: input.authorizations.map(parseTauriUpdateEnvelope) };
  };
  // Synchronous copy BEFORE the first asynchronous trust/signature/compiler step.
  const sources = options.sources.map(pin), assets = options.assets.map(pin), handlers = options.handlerFiles.map(snapshot);
  const paths = [...sources, ...assets, ...handlers].map(file => file.path);
  if (new Set(paths).size !== paths.length || sources.some(file => !file.path.startsWith('/src/') || file.executable)
    || assets.some(file => file.path.startsWith('/src/') || file.path.startsWith('/handler/') || file.path === '/runtime/bootstrap.cjs')
    || handlers.some(file => !file.path.startsWith('/handler/'))) throw new Error('invalid or duplicate handler input path');
  const sourceMap = new Map(sources.map(file => [file.path, file]));
  if (!sourceMap.has(entryPoint)) throw new Error('handler build entry is absent');
  return withCurrentHandlerRuntimeTrust(async ({ trust, now }) => {
    const authors = new Set<string>();
    for (const input of [...sources, ...assets]) {
      for (const id of await authenticate(input, entryPoint, identity, trust, now)) authors.add(id);
    }
    const used = new Set<string>();
    const result = await build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      absWorkingDir: '/', tsconfigRaw: { compilerOptions: {} },
      write: false, metafile: true, logLevel: 'silent', sourcemap: false, charset: 'utf8',
      logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error', 'indirect-require': 'error', 'direct-eval': 'error' },
      plugins: [{ name: 'authenticated-handler-snapshot', setup(compiler) {
        compiler.onResolve({ filter: /.*/ }, args => {
          const name = args.path.replace(/^node:/, '');
          if (builtins.has(name)) return { path: `node:${name}`, external: true };
          if (args.path === 'koffi') return { path: 'koffi', external: true };
          const path = args.kind === 'entry-point' ? args.path
            : args.path.startsWith('.') ? posix.resolve(posix.dirname(args.importer), args.path) : '';
          const matches = [path, ...['.ts', '.js', '.cjs', '.mjs', '.json'].map(ext => path + ext),
            posix.join(path, 'index.ts'), posix.join(path, 'index.js')].filter(candidate => sourceMap.has(candidate));
          if (new Set(matches).size !== 1) return { errors: [{ text: `missing or ambiguous authenticated import: ${args.path}` }] };
          return { path: matches[0], namespace: 'handler-snapshot' };
        });
        compiler.onLoad({ filter: /.*/, namespace: 'handler-snapshot' }, args => {
          const input = sourceMap.get(args.path)!;
          const loader = loaders[posix.extname(args.path)];
          if (!loader) return { errors: [{ text: 'unsupported authenticated source loader' }] };
          used.add(args.path);
          return { contents: input.contents, loader };
        });
      } }],
    });
    if (used.size !== sources.length || sources.some(source => !used.has(source.path))
      || !result.metafile || Object.keys(result.metafile.inputs).length !== sources.length
      || result.outputFiles?.length !== 1) throw new Error('authenticated source closure differs from compiler inputs');
    const contents = Buffer.from(result.outputFiles[0]!.contents);
    const bootstrap = { path: '/runtime/bootstrap.cjs', executable: false, sha256: digest(contents), contents };
    const files = [...assets, bootstrap, ...handlers].map(({ path, contents, sha256, executable }) => ({ path, contents, sha256, executable }));
    const inventory = { files, sha256: handlerRuntimeDigest(files), bootstrapSha256: bootstrap.sha256 };
    const candidate = createHandlerRuntimeCandidate(inventory, { ...identity, authorIds: [...authors].sort() });
    return { inventory, candidate, sourcePins: sources.map(({ path, sha256 }) => ({ path, sha256 })) };
  });
}
