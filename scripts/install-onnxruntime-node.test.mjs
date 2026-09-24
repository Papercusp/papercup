import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCudaProviderAssets,
  CUDA_PROVIDER_FILES,
  installCudaProvider,
  inspectCudaProvider,
  isOfflineSafeInstall,
  providerFilePaths,
  resolveTargetPlatform,
  withNetworkAttemptTimeout,
  NETWORK_ATTEMPT_TIMEOUT_MS,
} from './install-onnxruntime-node.mjs';

// memory-reduction-2026-09-24 P-008: the upstream CUDA download died on Node's
// 250 ms happy-eyeballs attempt timeout while the host itself was reachable,
// silently leaving every model on CPU. The installer child must get a longer one.
test('withNetworkAttemptTimeout adds a long attempt timeout and keeps caller options', () => {
  const flag = `--network-family-autoselection-attempt-timeout=${NETWORK_ATTEMPT_TIMEOUT_MS}`;
  assert.ok(NETWORK_ATTEMPT_TIMEOUT_MS >= 2000);
  assert.equal(withNetworkAttemptTimeout(undefined), flag);
  assert.equal(withNetworkAttemptTimeout(''), flag);
  assert.equal(withNetworkAttemptTimeout('--max-old-space-size=4096'), `--max-old-space-size=4096 ${flag}`);
  const explicit = '--network-family-autoselection-attempt-timeout=900';
  assert.equal(withNetworkAttemptTimeout(explicit), explicit);
});

test('installCudaProvider passes the attempt timeout to the upstream installer child', () => {
  const root = mkdtempSync(join(tmpdir(), 'ort-attempt-'));
  const packageRoot = join(root, 'node_modules', 'onnxruntime-node');
  mkdirSync(join(packageRoot, 'script'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-node', version: '1.24.3' }));
  let childEnv = null;
  try {
    installCudaProvider({
      repoRoot: root,
      env: { NODE_OPTIONS: '--trace-warnings' },
      host: { platform: 'linux', arch: 'x64' },
      resolvePackageRoot: () => packageRoot,
      fileExists: () => false,
      run: (_cmd, _args, opts) => {
        childEnv = opts.env;
        return { status: 0 };
      },
    });
  } catch {
    // The fake child produces no provider files, so the post-install asset check throws.
  }
  assert.ok(childEnv, 'the upstream installer child was spawned');
  assert.match(childEnv.NODE_OPTIONS, /--trace-warnings/);
  assert.match(childEnv.NODE_OPTIONS, /--network-family-autoselection-attempt-timeout=\d+/);
});

function fakeOrtPackage() {
  const packageRoot = mkdtempSync(join(tmpdir(), 'papercusp-ort-'));
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ binary: { napi_versions: [6] } }),
  );
  mkdirSync(join(packageRoot, 'script'), { recursive: true });
  writeFileSync(join(packageRoot, 'script', 'install.js'), '');
  return packageRoot;
}

test('resolveTargetPlatform honors npm_config_os and npm_config_cpu', () => {
  assert.deepEqual(
    resolveTargetPlatform(
      { npm_config_os: 'darwin', npm_config_cpu: 'arm64' },
      { platform: 'linux', arch: 'x64' },
    ),
    { os: 'darwin', cpu: 'arm64' },
  );
  assert.deepEqual(
    resolveTargetPlatform({}, { platform: 'linux', arch: 'amd64' }),
    { os: 'linux', cpu: 'x64' },
  );
});

test('offline-safe and skip settings prevent provider installation', () => {
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'skip' }), true);
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'offline-safe' }), true);
  assert.equal(isOfflineSafeInstall({ ONNXRUNTIME_NODE_INSTALL: 'cuda12' }), false);
});

test('providerFilePaths names the CUDA and shared provider payload', () => {
  const packageRoot = fakeOrtPackage();
  assert.deepEqual(
    providerFilePaths({
      packageRoot,
      target: { os: 'linux', cpu: 'x64' },
    }),
    CUDA_PROVIDER_FILES.map((file) =>
      join(packageRoot, 'bin', 'napi-v6', 'linux', 'x64', file),
    ),
  );
});

test('installCudaProvider runs ORT cuda12 install and verifies all provider files', () => {
  const packageRoot = fakeOrtPackage();
  const env = { npm_config_os: 'linux', npm_config_cpu: 'x64' };
  let call;
  const result = installCudaProvider({
    env,
    host: { platform: 'linux', arch: 'x64' },
    resolvePackageRoot: () => packageRoot,
    run: (...args) => {
      call = args;
      for (const file of providerFilePaths({ packageRoot, target: { os: 'linux', cpu: 'x64' } })) {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'provider');
      }
      return { status: 0 };
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(call[0], process.execPath);
  assert.equal(call[1][0], join(packageRoot, 'script', 'install.js'));
  assert.equal(call[2].env.ONNXRUNTIME_NODE_INSTALL, 'cuda12');
  assert.deepEqual(inspectCudaProvider({ env, resolvePackageRoot: () => packageRoot }).missing, []);
});

test('installCudaProvider skips non-linux/x64 cross-targets without running a native installer', () => {
  let invoked = false;
  const result = installCudaProvider({
    env: { npm_config_os: 'darwin', npm_config_cpu: 'arm64' },
    host: { platform: 'linux', arch: 'x64' },
    run: () => {
      invoked = true;
      return { status: 0 };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'target-not-linux-x64');
  assert.equal(invoked, false);
});

test('assertCudaProviderAssets is inert unless CUDA reranking is requested', () => {
  const packageRoot = fakeOrtPackage();
  assert.deepEqual(
    assertCudaProviderAssets({
      env: { PAPERCUSP_RERANK_DEVICE: 'cpu' },
      resolvePackageRoot: () => packageRoot,
    }),
    { requested: false, ok: true },
  );
  assert.throws(
    () =>
      assertCudaProviderAssets({
        env: { PAPERCUSP_RERANK_DEVICE: 'cuda' },
        resolvePackageRoot: () => packageRoot,
      }),
    /requests CUDA, but onnxruntime-node/,
  );
});
