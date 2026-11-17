/** Test-only custody for the separately qualified D-004 dependency edition. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync, type BigIntStats } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCliEntry } from '../lib/util/cli-entry';
import { nativeProofFingerprint, type NativeProofInput, type NativeProofRun } from '../lib/testing-run-store';
// @ts-ignore -- reuse the maintained strict resolver, never a custom installer.
import { metadataRepairInputLayout, resolveMetadataRepairLock } from '../../../scripts/npm-install-safe.mjs';
import { auditTree } from '../../../apps/operator/bin/release/dependency-lock-tree-audit.mjs';
// @ts-ignore -- the maintained native exact-byte archive, shared with historical proof custody.
import { createNativeArtifactPersister, readNativeArtifactBytes } from '../../../scripts/lib/budgeted-task-scheduler.mjs';

export const repairedBaselineEdition = 'source-frozen-dependency-repaired-v1';
// Independently read from 729986dd35171f1e0cb11bd1505295917f2d946f:
// apps/operator/scripts/ptool.mjs (267752 bytes). This fifteenth original is
// outside the fourteen-source fixture; a coherently rekeyed replacement must
// not become historical source merely by matching its own admitted input.
export const originalBaselinePtoolSha256 = '56a99c90f284345ef8520163894424419a7941d88392700c2e444dfe3410b430';
export const baselineRepairFailureArtifacts = [
  'phases/prepare/dependency-lock-rejected.json',
  'phases/prepare/dependency-repair-failure.json',
] as const;
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type FrozenSource = { path: string; sha256: string; content: string };

// A chunk bounds one IO operation, never the source population or retained truth.
// The harness retains the small sealed locator; its existing 16/64 MiB limits
// therefore do not discard large installed-tree manifests or request originals.
export const baselinePacketChunkBytes = 8 * 1024 * 1024 - 1;
type BaselineChunk = { ref: string; sha256: string; byteLength: number };
type BaselineBlob = { sha256: string; byteLength: number;
  parts: Array<{ offset: number; artifact: BaselineChunk }> };
export type BaselinePacketManifest = { schemaVersion: 1; fingerprint: string;
  files: Array<{ path: string; blob: BaselineBlob }>; producerCensus?: BaselineProducerCensus };
type BaselinePacketLocator = { schemaVersion: 1; archiveRoot: string; manifest: BaselineBlob };
const packetPath = (path: string) => typeof path === 'string' && path.length > 0
  && !/[\x00-\x1f\\]/.test(path) && !path.startsWith('/')
  && path.split('/').every(part => part && part !== '.' && part !== '..');

const producerIdentity = (stat: BigIntStats) => Object.fromEntries(
  (['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const).map(key => [key, String(stat[key])]));
export type BaselineProducerCensus = Array<{ path: string; kind: 'file' | 'directory' | 'dependency-binding';
  identity: Record<string, string>; target?: string; resolved?: string }>;

/** ALL nested producer entries, including empty directories. Only explicitly
 * pinned builder dependency links have a separate disposition; unknown links,
 * special files, redirected ancestors and an unstable census refuse capture. */
export function captureBaselineProducers(runRoot: string, dependencyBindings: Record<string, string> = {}) {
  assert.equal(realpathSync(runRoot), resolve(runRoot), 'baseline_producer_root_redirected');
  for (const [path, target] of Object.entries(dependencyBindings))
    assert.ok(packetPath(path) && path.startsWith('phases/') && resolve(target) === target,
      'baseline_producer_binding_invalid');
  const census: BaselineProducerCensus = [];
  const visit = (path: string) => {
    assert.ok(packetPath(path), 'baseline_producer_path');
    const file = join(runRoot, path), before = lstatSync(file, { bigint: true });
    const identity = producerIdentity(before);
    if (before.isSymbolicLink()) {
      const target = readlinkSync(file), resolved = realpathSync(file);
      assert.equal(resolved, dependencyBindings[path], 'baseline_producer_unexpected_link:' + path);
      assert.equal(realpathSync(dirname(file)), resolve(dirname(file)), 'baseline_producer_redirected');
      census.push({ path, kind: 'dependency-binding', identity, target, resolved });
    } else {
      assert.equal(realpathSync(file), resolve(file), 'baseline_producer_redirected');
      assert.ok(before.isFile() || before.isDirectory(), 'baseline_producer_special:' + path);
      census.push({ path, kind: before.isFile() ? 'file' : 'directory', identity });
      if (before.isDirectory()) {
        const names = readdirSync(file).sort();
        for (const name of names) visit(path + '/' + name);
        assert.deepEqual(readdirSync(file).sort(), names, 'baseline_producer_population_changed');
      }
    }
    assert.deepEqual(producerIdentity(lstatSync(file, { bigint: true })), identity,
      'baseline_producer_changed:' + path);
  };
  for (const phase of ['prepare', 'execute']) {
    const path = 'phases/' + phase;
    if (lstatSync(join(runRoot, path), { throwIfNoEntry: false })) visit(path);
  }
  return census.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function retainBaselineProducerPacket(runRoot: string, archiveRoot: string,
  fingerprint: string, dependencyBindings: Record<string, string> = {}) {
  const census = captureBaselineProducers(runRoot, dependencyBindings);
  const seal = retainBaselinePacket(runRoot, archiveRoot, fingerprint,
    census.filter(entry => entry.kind === 'file').map(entry => entry.path), census);
  assert.deepEqual(captureBaselineProducers(runRoot, dependencyBindings), census,
    'baseline_producer_census_changed');
  return seal;
}

export const baselineClientEntryPaths = {
  'mcp-http': 'packages/operator-core/lib/agent-mcp-client.ts',
  'ptool-http': 'apps/operator/scripts/ptool.mjs',
} as const;

/** Retain the exact current MCP and frozen ptool entry originals, not just
 * digests. Both are independently pinned by the reviewed launch tuple. */
export function retainBaselineClientOriginals(evidenceDir: string, sources: Record<keyof typeof baselineClientEntryPaths,
  { root: string; expectedSha256: string }>) {
  const directory = join(evidenceDir, 'client-entrypoints');
  mkdirSync(directory);
  assert.equal(realpathSync(directory), resolve(directory), 'baseline_client_original_redirected');
  return Object.fromEntries(Object.entries(baselineClientEntryPaths).map(([adapter, path]) => {
    const selected = sources[adapter as keyof typeof sources], file = join(selected.root, path);
    assert.equal(realpathSync(dirname(file)), resolve(dirname(file)), 'baseline_client_source_redirected');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile(), 'baseline_client_original_type');
      bytes = readFileSync(fd);
      assert.deepEqual(producerIdentity(fstatSync(fd, { bigint: true })), producerIdentity(before),
        'baseline_client_original_changed');
      assert.deepEqual(producerIdentity(lstatSync(file, { bigint: true })), producerIdentity(before),
        'baseline_client_original_changed');
      assert.equal(BigInt(bytes.length), before.size, 'baseline_client_original_incomplete');
    } finally { closeSync(fd); }
    assert.equal(digest(bytes), selected.expectedSha256, 'baseline_client_entry_changed');
    const originalRef = 'client-entrypoints/' + adapter + '.source';
    writeFileSync(join(evidenceDir, originalRef), bytes, { flag: 'wx', mode: 0o600 });
    assert.ok(readFileSync(join(evidenceDir, originalRef)).equals(bytes), 'baseline_client_original_readback');
    return [adapter, { path, sha256: digest(bytes), originalRef }];
  })) as Record<keyof typeof baselineClientEntryPaths, { path: string; sha256: string; originalRef: string }>;
}

/** Extend the existing native content-addressed persister; no second registry.
 * Every complete source is streamed, including empty files. Incomplete reads or
 * changing/redirected inputs reject the packet; no prefix can become a seal. */
export function retainBaselinePacket(runRoot: string, archiveRoot: string,
  fingerprint: string, paths: readonly string[], producerCensus?: BaselineProducerCensus): Buffer {
  assert.match(fingerprint, /^[a-f0-9]{64}$/, 'baseline_packet_fingerprint');
  assert.equal(realpathSync(runRoot), resolve(runRoot), 'baseline_packet_redirected_source');
  assert.equal(new Set(paths).size, paths.length, 'baseline_packet_duplicate_path');
  const store = createNativeArtifactPersister(archiveRoot);
  const retain = (consume: (save: (bytes: Buffer) => void) => void): BaselineBlob => {
    const hash = createHash('sha256');
    const blob: BaselineBlob = { sha256: '', byteLength: 0, parts: [] };
    consume(bytes => {
      assert.ok(bytes.length > 0 && bytes.length <= baselinePacketChunkBytes, 'baseline_packet_chunk_size');
      blob.parts.push({ offset: blob.byteLength, artifact: store.persist(bytes, 'baseline-chunk') });
      hash.update(bytes); blob.byteLength += bytes.length;
      assert.ok(Number.isSafeInteger(blob.byteLength), 'baseline_packet_size');
    });
    blob.sha256 = hash.digest('hex');
    return blob;
  };
  const files = [...paths].sort().map(path => {
    assert.ok(packetPath(path), 'baseline_packet_path');
    const file = join(runRoot, path), directory = realpathSync(dirname(file));
    assert.ok(directory === resolve(dirname(file)) && (directory === resolve(runRoot)
      || directory.startsWith(resolve(runRoot) + '/')),
      'baseline_packet_redirected_source');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile() && before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'baseline_packet_source_type');
      const blob = retain(save => {
        const buffer = Buffer.alloc(baselinePacketChunkBytes);
        let offset = 0;
        while (offset < Number(before.size)) {
          const length = Math.min(buffer.length, Number(before.size) - offset);
          let read = 0;
          while (read < length) {
            const count = readSync(fd, buffer, read, length - read, null);
            assert.ok(count > 0, 'baseline_packet_incomplete_source'); read += count;
          }
          save(buffer.subarray(0, length)); offset += length;
        }
      });
      const after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const) {
        assert.equal(after[key], before[key], 'baseline_packet_source_changed');
        assert.equal(current[key], before[key], 'baseline_packet_source_changed');
      }
      assert.ok(current.isFile() && realpathSync(dirname(file)) === directory, 'baseline_packet_source_changed');
      return { path, blob };
    } finally { closeSync(fd); }
  });
  const manifest: BaselinePacketManifest = { schemaVersion: 1, fingerprint, files,
    ...(producerCensus ? { producerCensus } : {}) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const locator: BaselinePacketLocator = { schemaVersion: 1, archiveRoot: store.root,
    manifest: retain(save => {
      for (let offset = 0; offset < bytes.length; offset += baselinePacketChunkBytes)
        save(bytes.subarray(offset, offset + baselinePacketChunkBytes));
    }) };
  const seal = Buffer.from(JSON.stringify(locator));
  readBaselinePacket(seal, digest(seal), fingerprint);
  return seal;
}

/** Read the independent seal digest first, then verify EVERY original. A
 * successor needs only these seal bytes and the existing archive, not the
 * disposable clone, original evidence directory or a process-local registry. */
export function readBaselinePacket(seal: Buffer, sealSha256: string, fingerprint: string) {
  assert.equal(digest(seal), sealSha256, 'baseline_packet_seal_changed');
  const locator: BaselinePacketLocator = JSON.parse(seal.toString());
  assert.equal(locator.schemaVersion, 1, 'baseline_packet_schema');
  assert.equal(realpathSync(locator.archiveRoot), resolve(locator.archiveRoot), 'baseline_packet_redirected_archive');
  const read = (blob: BaselineBlob): Buffer => {
    assert.ok(Number.isSafeInteger(blob.byteLength) && blob.byteLength >= 0, 'baseline_packet_blob_size');
    assert.match(blob.sha256, /^[a-f0-9]{64}$/, 'baseline_packet_blob_hash');
    const chunks: Buffer[] = [];
    let offset = 0;
    for (const part of blob.parts) {
      const pin = part.artifact;
      assert.equal(part.offset, offset, 'baseline_packet_part_order');
      assert.ok(Number.isSafeInteger(pin.byteLength) && pin.byteLength > 0
        && pin.byteLength <= baselinePacketChunkBytes, 'baseline_packet_chunk_size');
      assert.match(pin.sha256, /^[a-f0-9]{64}$/, 'baseline_packet_chunk_hash');
      assert.equal(pin.ref, pin.sha256 + '.baseline-chunk', 'baseline_packet_chunk_ref');
      const bytes = readNativeArtifactBytes(join(locator.archiveRoot, pin.ref), pin.byteLength, baselinePacketChunkBytes + 1);
      assert.equal(digest(bytes), pin.sha256, 'baseline_packet_chunk_changed');
      chunks.push(bytes); offset += bytes.length;
      assert.ok(Number.isSafeInteger(offset) && offset <= blob.byteLength, 'baseline_packet_blob_size');
    }
    assert.equal(offset, blob.byteLength, 'baseline_packet_incomplete_blob');
    const bytes = Buffer.concat(chunks);
    assert.equal(digest(bytes), blob.sha256, 'baseline_packet_blob_changed');
    return bytes;
  };
  const manifest: BaselinePacketManifest = JSON.parse(read(locator.manifest).toString());
  assert.equal(manifest.schemaVersion, 1, 'baseline_packet_manifest_schema');
  assert.equal(manifest.fingerprint, fingerprint, 'baseline_packet_edition');
  const files = new Map<string, BaselineBlob>();
  for (const file of manifest.files) {
    assert.ok(packetPath(file.path) && !files.has(file.path), 'baseline_packet_path');
    read(file.blob); files.set(file.path, file.blob);
  }
  if (manifest.producerCensus) {
    assert.equal(new Set(manifest.producerCensus.map(entry => entry.path)).size,
      manifest.producerCensus.length, 'baseline_producer_duplicate');
    for (const entry of manifest.producerCensus) {
      assert.ok(packetPath(entry.path) && ['file', 'directory', 'dependency-binding'].includes(entry.kind),
        'baseline_producer_entry');
      if (entry.kind === 'dependency-binding')
        assert.ok(entry.target && entry.resolved && resolve(entry.resolved) === entry.resolved,
          'baseline_producer_binding_invalid');
    }
    assert.deepEqual(manifest.producerCensus.filter(entry => entry.kind === 'file').map(entry => entry.path).sort(),
      [...files.keys()].sort(), 'baseline_producer_incomplete');
  }
  return { manifest, read: (path: string) => {
    const blob = files.get(path);
    assert.ok(blob, 'baseline_packet_missing_original:' + path);
    return read(blob);
  } };
}

/** Grade the complete retained originals against the ORIGINAL ledger input.
 * This is deliberately separate from retention: a failed run can keep every
 * byte without obtaining a qualifying receipt. No live clone is consulted. */
export function qualifyBaselinePacket(packet: ReturnType<typeof readBaselinePacket>,
  run: NativeProofRun, runRoot: string) {
  const { input, fingerprint } = nativeProofFingerprint(run.input);
  assert.equal(run.fingerprint, fingerprint, 'baseline_qualifier_edition');
  assert.equal(run.runId, 'native-proof-' + fingerprint, 'baseline_qualifier_run');
  assert.equal(run.admission.reviewedFingerprint, fingerprint, 'baseline_qualifier_review');
  assert.ok(run.admission.reviewRef && Object.values(run.admission.preflightRefs).every(Boolean),
    'baseline_qualifier_admission');
  assert.equal(packet.manifest.fingerprint, fingerprint, 'baseline_qualifier_packet');
  assert.ok(packet.manifest.producerCensus, 'baseline_qualifier_census');
  const read = (path: string) => packet.read('phases/' + path);
  const json = (path: string) => JSON.parse(read(path).toString());
  const initial: NativeProofRun = json('prepare/native-proof-intent.json');
  assert.deepEqual(initial.input, run.input, 'baseline_qualifier_original_intent');
  assert.deepEqual(initial.admission, run.admission, 'baseline_qualifier_original_admission');
  assert.equal(initial.runId, run.runId, 'baseline_qualifier_original_run');
  assert.equal(initial.fingerprint, fingerprint, 'baseline_qualifier_original_edition');
  const order = ['reserved', 'started', 'installed', 'built', 'runtime', 'trace'];
  assert.ok(run.events.length === 6 || run.events.length === 8, 'baseline_qualifier_incomplete_ledger');
  for (const [index, kind] of order.entries()) {
    const event = run.events[index];
    assert.equal(event.kind, kind, 'baseline_qualifier_order');
    assert.equal(event.fingerprint, fingerprint, 'baseline_qualifier_event_edition');
  }
  assert.deepEqual(initial.events, run.events.slice(0, 2), 'baseline_qualifier_original_start');
  const observe = (kind: string, path: string) => {
    const event = run.events[order.indexOf(kind)];
    assert.equal(event.receiptRef, join(runRoot, 'phases', path), 'baseline_qualifier_receipt_path:' + kind);
    assert.equal(event.receiptSha256, digest(read(path)), 'baseline_qualifier_receipt_bytes:' + kind);
    return json(path);
  };
  const fixtureBytes = read('prepare/baseline-fixture.json');
  assert.equal(digest(fixtureBytes), input.original.fixtureSha256, 'baseline_qualifier_fixture');
  // Independent historical pins; internally re-hashing a replacement is insufficient.
  assert.equal(input.original.sourceSha, '729986dd35171f1e0cb11bd1505295917f2d946f', 'baseline_qualifier_original_source');
  assert.equal(input.original.fixtureSha256, '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea',
    'baseline_qualifier_original_fixture');
  const fixture = JSON.parse(fixtureBytes.toString());
  assert.equal(fixture.sourceSha, input.original.sourceSha, 'baseline_qualifier_source');
  assert.equal(fixture.originalCapture.sha256, input.original.captureSha256, 'baseline_qualifier_capture');
  assert.equal(input.original.dependenciesReconstructed, false, 'baseline_qualifier_historical_dependencies');
  const frozen = fixture.files.map((file: FrozenSource) => {
    assert.equal(digest(file.content), file.sha256, 'baseline_qualifier_frozen_source');
    return { path: file.path, sha256: file.sha256 };
  });
  assert.equal(new Set(frozen.map((file: FrozenSource) => file.path)).size, frozen.length, 'baseline_qualifier_frozen_population');
  const entries = json('execute/baseline-client-entrypoints.json');
  assert.deepEqual(Object.keys(entries).sort(), Object.keys(baselineClientEntryPaths).sort(), 'baseline_qualifier_clients');
  assert.equal(input.original.sourceDigests[baselineClientEntryPaths['ptool-http']], originalBaselinePtoolSha256,
    'baseline_qualifier_historical_ptool');
  for (const adapter of Object.keys(baselineClientEntryPaths) as Array<keyof typeof baselineClientEntryPaths>) {
    const entry = entries[adapter], path = baselineClientEntryPaths[adapter];
    assert.equal(entry.path, path, 'baseline_qualifier_entry_path');
    assert.equal(entry.originalRef, 'client-entrypoints/' + adapter + '.source', 'baseline_qualifier_entry_original');
    assert.equal(entry.sha256, adapter === 'ptool-http' ? input.original.sourceDigests[path]
      : input.prerequisiteSources[path], 'baseline_qualifier_entry_pin');
    assert.equal(digest(read('execute/' + entry.originalRef)), entry.sha256, 'baseline_qualifier_entry_bytes');
  }
  const frozenDigests: Record<string, string> = { ...Object.fromEntries(frozen.map((file: FrozenSource) => [file.path, file.sha256])),
    [baselineClientEntryPaths['ptool-http']]: entries['ptool-http'].sha256 };
  assert.deepEqual(input.original.sourceDigests, frozenDigests, 'baseline_qualifier_frozen_population');
  const source = json('prepare/baseline-source.json');
  assert.equal(source.sourceSha, input.original.sourceSha, 'baseline_qualifier_source');
  assert.equal(source.fixtureSha256, input.original.fixtureSha256, 'baseline_qualifier_fixture');
  assert.deepEqual(source.files, frozen, 'baseline_qualifier_source_inventory');
  assert.deepEqual(source.originalCapture, fixture.originalCapture, 'baseline_qualifier_capture');
  assert.deepEqual(source.originalLoadedRuntime, fixture.loadedRuntime, 'baseline_qualifier_capture_runtime');
  const selected = json('prepare/dependency-repair-inputs.json');
  const snapshot = new Map<string, Buffer | null>();
  for (const row of selected.inputs) {
    assert.ok(packetPath(row.path) && !snapshot.has(row.path), 'baseline_qualifier_selected_population');
    const bytes = row.base64 === null ? null : Buffer.from(row.base64, 'base64');
    assert.equal(bytes?.toString('base64') ?? null, row.base64, 'baseline_qualifier_selected_encoding');
    assert.equal(bytes === null ? null : digest(bytes), row.sha256, 'baseline_qualifier_selected_bytes');
    snapshot.set(row.path, bytes);
  }
  const originalLock = read('prepare/dependency-lock-original.json');
  assert.ok(originalLock.equals(snapshot.get('package-lock.json')!), 'baseline_qualifier_original_lock');
  const repaired = read('prepare/dependency-lock-repaired.json'), delta = read('prepare/dependency-repair-delta.json');
  const graph = assertBaselinePlannedRepair(input, snapshot, repaired, delta);
  assert.ok(graph.equals(read('prepare/dependency-candidate-graph.json')), 'baseline_qualifier_graph');
  assert.deepEqual(JSON.parse(delta.toString()), baselineLockDelta(originalLock, repaired), 'baseline_qualifier_delta');
  const edition = json('prepare/dependency-edition.json');
  const installed = observe('installed', 'prepare/dependency-installed.json');
  const built = observe('built', 'prepare/dependency-edition-after-build.json');
  const runtime = observe('runtime', 'execute/baseline-runtime.json');
  const trace = observe('trace', 'execute/client-traces.json');
  for (const row of [source, edition, built, runtime]) {
    assert.equal(row.edition, repairedBaselineEdition, 'baseline_qualifier_repaired_edition');
    assert.equal(row.originalDependenciesReconstructed, false, 'baseline_qualifier_historical_dependencies');
  }
  for (const row of [edition, built]) {
    assert.equal(row.originalSourceSha, input.original.sourceSha, 'baseline_qualifier_source');
    assert.equal(row.originalLockSha256, digest(originalLock), 'baseline_qualifier_original_lock');
    assert.equal(row.repairedLockSha256, input.plannedRepair.lockSha256, 'baseline_qualifier_repaired_lock');
    assert.deepEqual(row.changedInputs, ['package-lock.json'], 'baseline_qualifier_changed_inputs');
    assert.deepEqual(row.beforeSources, frozen, 'baseline_qualifier_frozen_before');
    assert.deepEqual(row.afterSources, frozen, 'baseline_qualifier_frozen_after');
  }
  assert.deepEqual(installed.afterInstallSources, frozen, 'baseline_qualifier_installed_sources');
  assert.deepEqual(built.afterInstallSources, frozen, 'baseline_qualifier_installed_sources');
  assert.deepEqual(built.afterBuildSources, frozen, 'baseline_qualifier_built_sources');
  for (const [boundary, changed] of [[selected.beforeProductBoundary, []], [edition.beforeProductBoundary, []],
    [edition.afterProductBoundary, ['package-lock.json']], [installed.afterInstallProductBoundary, ['package-lock.json']],
    [built.afterBuildProductBoundary, ['package-lock.json']]] as const) {
    assert.equal(boundary.sourceSha, input.original.sourceSha, 'baseline_qualifier_product_source');
    assert.deepEqual(boundary.changedPaths, changed, 'baseline_qualifier_product_boundary');
    assert.equal(boundary.tree, selected.beforeProductBoundary.tree, 'baseline_qualifier_product_tree');
    assert.equal(boundary.submodules, selected.beforeProductBoundary.submodules, 'baseline_qualifier_product_submodules');
  }
  assert.equal(installed.sourceSha, input.original.sourceSha, 'baseline_qualifier_install_source');
  assert.equal(installed.repairedLockSha256, input.plannedRepair.lockSha256, 'baseline_qualifier_install_lock');
  assert.equal(installed.installLogSha256, digest(read('prepare/dependency-install.log')), 'baseline_qualifier_install_log');
  const treeBytes = read('prepare/dependency-installed-tree.json'), tree = JSON.parse(treeBytes.toString());
  const { sha256: treeSha256, ...treeManifest } = tree;
  assert.equal(digest(JSON.stringify(treeManifest)), treeSha256, 'baseline_qualifier_tree_manifest');
  assert.deepEqual(tree.audit.defects, [], 'baseline_qualifier_tree_audit');
  assert.equal(installed.installedTreeManifestSha256, digest(treeBytes), 'baseline_qualifier_tree_bytes');
  for (const row of [installed, built]) assert.equal(row.installedTreeSha256, treeSha256, 'baseline_qualifier_installed_tree');
  const custodyBytes = read('execute/baseline-runtime-custody-before.json');
  assert.ok(custodyBytes.equals(read('execute/baseline-runtime-custody-after.json')), 'baseline_qualifier_runtime_custody');
  assert.deepEqual(JSON.parse(custodyBytes.toString()), { installedTreeSha256: treeSha256,
    installedTreeManifestSha256: digest(treeBytes), toolchain: input.toolchain }, 'baseline_qualifier_toolchain');
  for (const row of [runtime, trace]) {
    assert.equal(row.sourceSha, input.original.sourceSha, 'baseline_qualifier_runtime_source');
    assert.equal(row.bundleSha256, digest(read('prepare/hono-host.mjs')), 'baseline_qualifier_bundle');
    assert.equal(row.custodyBeforeSha256, digest(custodyBytes), 'baseline_qualifier_runtime_custody');
  }
  assert.equal(trace.custodyAfterSha256, digest(custodyBytes), 'baseline_qualifier_runtime_custody');
  assert.equal(trace.fixtureSha256, input.original.fixtureSha256, 'baseline_qualifier_trace_fixture');
  assert.deepEqual(trace.entryPoints, entries, 'baseline_qualifier_trace_entries');
  assert.equal(runtime.repairedLockSha256, input.plannedRepair.lockSha256, 'baseline_qualifier_runtime_lock');
  assert.ok(typeof runtime.health.sha === 'string' && runtime.health.sha.length >= 7
    && input.original.sourceSha.startsWith(runtime.health.sha), 'baseline_qualifier_served_source');
  const build = json('prepare/operator-api-preflight.json');
  assert.equal(built.rebuiltBundleSha256, runtime.bundleSha256, 'baseline_qualifier_build');
  assert.equal(build.sha256, runtime.bundleSha256, 'baseline_qualifier_build');
  assert.equal(build.path, join(runRoot, 'phases/prepare/hono-host.mjs'), 'baseline_qualifier_build_path');
  assert.equal(built.receiptSha256, digest(read('prepare/operator-api-preflight.json')), 'baseline_qualifier_build_receipt');
  assert.deepEqual(run.childLaunch, { fingerprint,
    entryPoint: 'packages/operator-core/test/task-artifacts-baseline-http-fixture.ts',
    entryPointSha256: input.prerequisiteSources['packages/operator-core/test/task-artifacts-baseline-http-fixture.ts'],
    state: 'started' }, 'baseline_qualifier_native_child');
  const wire = read('execute/wire-requests.ndjson').toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(read('execute/wire-errors.ndjson').length, 0, 'baseline_qualifier_wire_errors');
  const calls = wire.filter(row => row.method === 'tools/call'), logicalIds = new Set<string>();
  const scenarios = { 'budget.save': ['artifacts:save', 'artifacts:load'],
    'budget.append': ['artifacts:save', 'artifacts:append', 'artifacts:append', 'artifacts:load'],
    'budget.read': ['artifacts:load'] };
  const measured: string[] = [];
  for (const adapter of Object.keys(baselineClientEntryPaths)) for (const [scenario, methods] of Object.entries(scenarios)) {
    const matches = trace.traces.filter((row: { adapter: string; scenario: string }) => row.adapter === adapter && row.scenario === scenario);
    assert.equal(matches.length, 1, 'baseline_qualifier_trace_population');
    const row = matches[0]; measured.push(adapter + ':' + scenario);
    assert.equal(row.count, methods.length, 'baseline_qualifier_trace_count');
    assert.equal(row.requests.length, methods.length, 'baseline_qualifier_trace_count');
    assert.deepEqual(row.helperWakes, [], 'baseline_qualifier_unmeasured_helpers');
    for (const [index, request] of row.requests.entries()) {
      assert.ok(typeof request.id === 'string' && packetPath(request.id) && !logicalIds.has(request.id), 'baseline_qualifier_request_id');
      logicalIds.add(request.id);
      assert.equal(request.method, methods[index], 'baseline_qualifier_handler');
      assert.equal(request.order, index, 'baseline_qualifier_request_order');
      assert.ok(!request.failed && request.retry === false && request.page === false && request.fallback === false,
        'baseline_qualifier_request_incomplete');
      assert.equal(request.entryPointSha256, entries[adapter].sha256, 'baseline_qualifier_request_entry');
      const handlerPath = 'packages/agent-mcp/src/tools/artifacts/' + request.method.split(':')[1] + '.ts';
      assert.deepEqual(request.handlerSource, { path: handlerPath, sha256: input.original.sourceDigests[handlerPath] },
        'baseline_qualifier_handler_source');
      const original = json('execute/' + request.id + '.json');
      assert.deepEqual(original.request, request, 'baseline_qualifier_request_original');
      assert.equal(digest(JSON.stringify(original.args)), request.argsSha256, 'baseline_qualifier_args');
      assert.equal(digest(JSON.stringify(original.result)), request.resultSha256, 'baseline_qualifier_result');
      assert.equal(original.result.ok, true, 'baseline_qualifier_failed_result');
      const observed = calls.filter(call => call.logicalId === request.id);
      assert.equal(observed.length, 1, 'baseline_qualifier_transport_missing_or_replayed');
      const call = observed[0];
      assert.equal(call.transport, 'http', 'baseline_qualifier_transport');
      assert.equal(call.endpointPath, '/api/mcp', 'baseline_qualifier_transport_route');
      assert.equal(call.tool, request.method, 'baseline_qualifier_transport_handler');
      assert.equal(call.argsSha256, request.argsSha256, 'baseline_qualifier_transport_args');
      assert.ok(typeof call.id === 'string' || typeof call.id === 'number', 'baseline_qualifier_transport_id');
      assert.deepEqual(request.wireRequests, [{ id: call.id, method: call.tool, argsSha256: call.argsSha256 }],
        'baseline_qualifier_transport_original');
      if (adapter === 'ptool-http') read('execute/' + request.id + '.stderr.log');
      if (index === methods.length - 1)
        assert.equal(digest(original.result.results[0].content), row.outcomeSha256, 'baseline_qualifier_outcome');
    }
  }
  assert.equal(trace.traces.length, measured.length, 'baseline_qualifier_trace_population');
  assert.equal(calls.length, logicalIds.size, 'baseline_qualifier_unattributed_transport');
  assert.deepEqual([...input.method.clientMatrix].sort(), measured.sort(), 'baseline_qualifier_reviewed_matrix');
  // Six text traces are a prerequisite baseline, never full feature acceptance.
  assert.equal(trace.completedMatrix, false, 'baseline_qualifier_matrix_scope');
  return { schemaVersion: 1, runId: run.runId, fingerprint, reviewedInput: input,
    admission: run.admission, events: run.events.slice(0, 6), childLaunch: run.childLaunch,
    installedTreeSha256: treeSha256, bundleSha256: runtime.bundleSha256, measured };
}

/** Immutable seal in the existing content-addressed archive. Ledger receipts
 * authenticate this exact file; a fresh consumer regrades all packet originals. */
export function sealBaselineQualification(packetSeal: Buffer, run: NativeProofRun, runRoot: string) {
  const packetSha256 = digest(packetSeal);
  const packet = readBaselinePacket(packetSeal, packetSha256, run.fingerprint);
  const qualification = qualifyBaselinePacket(packet, run, runRoot);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, runRoot,
    packetSeal: packetSeal.toString('base64'), packetSha256, qualification }));
  const locator: BaselinePacketLocator = JSON.parse(packetSeal.toString());
  const stored = createNativeArtifactPersister(locator.archiveRoot).persist(bytes, 'baseline-qualification');
  return { path: join(locator.archiveRoot, stored.ref), sha256: stored.sha256, bytes };
}

export function readBaselineQualification(run: NativeProofRun) {
  assert.equal(run.events.length, 8, 'baseline_qualification_readback_missing');
  const sealed = run.events[6], readback = run.events[7];
  assert.equal(sealed.kind, 'sealed', 'baseline_qualification_seal_order');
  assert.equal(readback.kind, 'readback', 'baseline_qualification_readback_order');
  assert.equal(sealed.fingerprint, run.fingerprint, 'baseline_qualification_seal_edition');
  assert.equal(readback.fingerprint, run.fingerprint, 'baseline_qualification_readback_edition');
  assert.equal(readback.receiptRef, sealed.receiptRef, 'baseline_qualification_readback_path');
  assert.equal(readback.receiptSha256, sealed.receiptSha256, 'baseline_qualification_readback_digest');
  assert.match(sealed.receiptSha256!, /^[a-f0-9]{64}$/, 'baseline_qualification_seal_digest');
  const path = sealed.receiptRef!;
  assert.equal(realpathSync(path), resolve(path), 'baseline_qualification_redirected');
  const bytes = readNativeArtifactBytes(path, lstatSync(path).size, Number.MAX_SAFE_INTEGER);
  assert.equal(digest(bytes), sealed.receiptSha256, 'baseline_qualification_seal_changed');
  const seal = JSON.parse(bytes.toString());
  assert.equal(seal.schemaVersion, 1, 'baseline_qualification_schema');
  const packetSeal = Buffer.from(seal.packetSeal, 'base64');
  assert.equal(packetSeal.toString('base64'), seal.packetSeal, 'baseline_qualification_packet_encoding');
  const packet = readBaselinePacket(packetSeal, seal.packetSha256, run.fingerprint);
  const actual = qualifyBaselinePacket(packet, run, seal.runRoot);
  assert.deepEqual(seal.qualification, actual, 'baseline_qualification_tuple_changed');
  return actual;
}

type InstalledEntry = { path: string; mode: number } & (
  { kind: 'directory' } | { kind: 'file'; bytes: number; sha256: string }
  | { kind: 'link'; target: string; resolved: string });

/** Reuse the publisher's tree census and strict lock/runtime audit. Unlike its
 * metadata fingerprint, this receipt hashes ALL reachable file bytes, including
 * hidden files, native addons and workspace/link targets. There is no prefix or
 * page limit: a failed census/read rejects the entire observation. */
export async function captureBaselineInstalledTree(root: string,
  helperRoot = resolve(import.meta.dirname, '../../..')) {
  root = await realpath(root);
  const census = () => new Promise<string>((done, reject) => {
    const child = spawn('bash', ['-euo', 'pipefail', '-c',
      'source "$1"; dependency_generation_enumerate_node_modules "$2"', 'baseline-installed-tree',
      join(helperRoot, 'apps/operator/bin/release/dependency-generation.sh'), root],
    { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(180_000),
      env: { ...process.env, DEPENDENCY_GENERATION_SCOPE_MODE: 'full' } });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done(Buffer.concat(output).toString())
      : reject(new Error('baseline_installed_census_failed:' + code + ':' + signal + ':' + Buffer.concat(errors))));
  });
  const inside = (path: string) => {
    const rel = relative(root, path);
    assert.ok(rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/')
      && !/[\x00-\x1f\\]/.test(rel), 'baseline_installed_path:' + path);
    return rel;
  };
  const treePaths = async () => (await census()).split('\n').filter(Boolean).map(path => inside(path)).sort();
  const trees = await treePaths();
  assert.ok(trees.includes('node_modules') && new Set(trees).size === trees.length,
    'baseline_installed_census_incomplete');
  const { inputPaths } = metadataRepairInputLayout(root);
  const lockfiles = inputPaths.filter((path: string) => /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path)
    && existsSync(join(root, path)));
  const audit = auditTree({ treeRoot: root, lockRoot: root, lockfiles, installedTrees: trees });
  assert.deepEqual(audit.defects, [], 'baseline_installed_lock_audit:' + JSON.stringify(audit));
  const entries = new Map<string, InstalledEntry>();
  const same = (a: BigIntStats, b: BigIntStats) =>
    (['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key]);
  const visit = async (path: string): Promise<void> => {
    if (entries.has(path)) return;
    const file = join(root, path), before = await lstat(file, { bigint: true });
    const mode = Number(before.mode & 0o7777n);
    if (before.isSymbolicLink()) {
      const target = await readlink(file), resolved = inside(await realpath(file));
      entries.set(path, { path, mode, kind: 'link', target, resolved });
      await visit(resolved);
      assert.equal(await readlink(file), target, 'baseline_installed_link_changed:' + path);
    } else if (before.isDirectory()) {
      entries.set(path, { path, mode, kind: 'directory' });
      const names = (await readdir(file)).sort();
      for (const name of names) await visit(path + '/' + name);
      assert.deepEqual((await readdir(file)).sort(), names, 'baseline_installed_population_changed:' + path);
    } else {
      assert.ok(before.isFile(), 'baseline_installed_type:' + path);
      assert.ok(before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'baseline_installed_file_size:' + path);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(file)) hash.update(bytes);
      entries.set(path, { path, mode, kind: 'file', bytes: Number(before.size), sha256: hash.digest('hex') });
    }
    assert.ok(same(before, await lstat(file, { bigint: true })), 'baseline_installed_changed_during_read:' + path);
  };
  for (const tree of trees) {
    assert.ok(!(await lstat(join(root, tree))).isSymbolicLink(), 'baseline_installed_linked_root:' + tree);
    await visit(tree);
  }
  assert.deepEqual(await treePaths(), trees, 'baseline_installed_tree_population_changed');
  const manifest = { schemaVersion: 1, trees, audit,
    entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...manifest, sha256: digest(JSON.stringify(manifest)) };
}

export async function assertBaselineInstalledTree(root: string,
  expected: Awaited<ReturnType<typeof captureBaselineInstalledTree>>, helperRoot?: string) {
  const actual = await captureBaselineInstalledTree(root, helperRoot);
  assert.deepEqual(actual, expected, 'baseline_installed_tree_changed');
}

/** Same selected CLI as the maintained metadata resolver and guarded ci. */
export function captureBaselineToolchain(): NativeProofInput['toolchain'] {
  const cli = realpathSync(join(dirname(process.execPath), 'npm'));
  const npmSha256 = digest(readFileSync(cli));
  const npmVersion = execFileSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  }).trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, 'baseline_npm_version_invalid');
  assert.equal(digest(readFileSync(cli)), npmSha256, 'baseline_npm_changed_during_read');
  return { npmSha256, npmVersion, nodeVersion: process.version, nativeAbi: process.versions.modules };
}

export function assertBaselineToolchain(expected: NativeProofInput['toolchain']) {
  const actual = captureBaselineToolchain();
  assert.deepEqual(actual, expected, 'baseline_reviewed_toolchain_changed');
  return actual;
}

/** The fresh runtime child follows the original ledger's receipts, never a new
 * filesystem assertion of what was installed/built. Reuse before start and after
 * stop; a substituted receipt, manifest, tree or toolchain rejects the run. */
export async function assertBaselineRuntimeCustody(root: string, preparedDir: string,
  intent: { input: Pick<NativeProofInput, 'toolchain'>; fingerprint: string; events: NativeProofRun['events'] },
  helperRoot?: string) {
  const receipt = (kind: 'installed' | 'built', name: string) => {
    const events = intent.events.filter(event => event.kind === kind);
    assert.equal(events.length, 1, 'baseline_runtime_receipt_missing:' + kind);
    const event = events[0], path = join(preparedDir, name);
    assert.equal(event.fingerprint, intent.fingerprint, 'baseline_runtime_receipt_edition:' + kind);
    assert.equal(resolve(event.receiptRef!), resolve(path), 'baseline_runtime_receipt_path:' + kind);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'baseline_runtime_receipt_type:' + kind);
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), event.receiptSha256, 'baseline_runtime_receipt_changed:' + kind);
    return JSON.parse(bytes.toString());
  };
  const installed = receipt('installed', 'dependency-installed.json');
  const built = receipt('built', 'dependency-edition-after-build.json');
  const manifestPath = join(preparedDir, 'dependency-installed-tree.json');
  assert.ok(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink(), 'baseline_runtime_manifest_type');
  const manifestBytes = readFileSync(manifestPath), manifestSha256 = digest(manifestBytes);
  assert.equal(manifestSha256, installed.installedTreeManifestSha256, 'baseline_runtime_manifest_changed');
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.sha256, installed.installedTreeSha256, 'baseline_runtime_installed_tree_identity');
  assert.equal(manifest.sha256, built.installedTreeSha256, 'baseline_runtime_built_tree_identity');
  const toolchain = assertBaselineToolchain(intent.input.toolchain);
  await assertBaselineInstalledTree(root, manifest, helperRoot);
  return { installedTreeSha256: manifest.sha256 as string,
    installedTreeManifestSha256: manifestSha256, toolchain };
}

export function assertFrozenBaselineSources(root: string, files: FrozenSource[]) {
  return files.map(file => {
    const path = resolve(root, file.path);
    assert.ok(path.startsWith(resolve(root) + '/'), 'baseline_source_path');
    assert.equal(digest(file.content), file.sha256, 'baseline_fixture_source_changed:' + file.path);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'baseline_source_type:' + file.path);
    const sha256 = digest(readFileSync(path));
    assert.equal(sha256, file.sha256, 'baseline_source_changed:' + file.path);
    return { path: file.path, sha256 };
  });
}

/** Absence is an input too; only the explicitly resolved lock may differ. */
export function assertBaselineRepairInputs(root: string, snapshot: Map<string, Buffer | null>,
  output?: { path: string; bytes: Buffer }) {
  assert.ok(!output || snapshot.has(output.path), 'baseline_repair_output_not_selected');
  assert.deepEqual(metadataRepairInputLayout(root).inputPaths, [...snapshot.keys()].sort(),
    'baseline_repair_input_population_changed');
  for (const [path, before] of snapshot) {
    const absolute = join(root, path);
    const expected = output?.path === path ? output.bytes : before;
    const actual = existsSync(absolute) ? readFileSync(absolute) : null;
    assert.ok(actual === null || (lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink()),
      'baseline_repair_input_type:' + path);
    assert.ok(expected === null ? actual === null : actual !== null && actual.equals(expected),
      'baseline_repair_input_changed:' + path);
  }
}

/** The complete original product tree may differ only by the declared lock. */
export function baselineProductBoundary(root: string, expectedChangedPaths: string[]) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const changedPaths = [...new Set([
    ...git(['diff', '--name-only', '-z', '--ignore-submodules=none', 'HEAD', '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z', '--']).split('\0'),
  ].filter(Boolean))].sort();
  assert.deepEqual(changedPaths, [...expectedChangedPaths].sort(), 'baseline_product_tree_changed');
  // Submodule dirtiness is reported as its path above; its commit identities
  // also stay in the immutable parent tree and are recorded explicitly here.
  return { sourceSha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    changedPaths, submodules: git(['submodule', 'status', '--recursive']) };
}

/** Keep complete changed package records, including removed entries and integrity. */
export function baselineLockDelta(beforeBytes: Buffer, afterBytes: Buffer) {
  const before = JSON.parse(beforeBytes.toString());
  const after = JSON.parse(afterBytes.toString());
  assert.ok(before.packages && after.packages, 'baseline_repair_lock_graph');
  const keys = [...new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])].sort();
  const packages = keys.filter(path => !isDeepStrictEqual(before.packages[path], after.packages[path]))
    .map(path => ({ path, before: before.packages[path] ?? null, after: after.packages[path] ?? null }));
  const { packages: _beforePackages, ...metadataBefore } = before;
  const { packages: _afterPackages, ...metadataAfter } = after;
  return { metadataBefore, metadataAfter, packages };
}

/** Match the full selected population (including absence) and deterministic
 * repair plan before ci/build. Observed outputs cannot mint another edition. */
export function assertBaselinePlannedRepair(input: Pick<NativeProofInput, 'selectedInputs' | 'plannedRepair'>,
  snapshot: Map<string, Buffer | null>, repaired: Buffer, delta: Buffer) {
  const selected = Object.fromEntries([...snapshot].map(([path, bytes]) =>
    [path, bytes === null ? null : digest(bytes)]));
  assert.deepEqual(selected, input.selectedInputs, 'baseline_prelaunch_selected_inputs_changed');
  const graph = JSON.parse(repaired.toString()).packages;
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph), 'baseline_prelaunch_graph_missing');
  const candidateGraph = Buffer.from(JSON.stringify(graph));
  assert.deepEqual({ lockSha256: digest(repaired), packageDeltaSha256: digest(delta),
    candidateGraphSha256: digest(candidateGraph) }, input.plannedRepair, 'baseline_prelaunch_repair_changed');
  return candidateGraph;
}

/** Retain rejected bytes as evidence only; never apply them to the source. */
export function retainBaselineRepairFailure(evidenceDir: string, error: unknown) {
  const failure = (error as { metadataRepairFailure?: {
    schemaVersion: number; stage: string;
    candidate: { path: string | null; bytes: Buffer | null; sha256: string | null;
      size: number | null; omission: string | null };
    resolution: { exitCode: number } | null;
    receipt: unknown;
  } })?.metadataRepairFailure;
  if (!failure) return;
  const { bytes, ...candidate } = failure.candidate;
  if (bytes !== null) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024, 'baseline_repair_failure_size');
    assert.equal(digest(bytes), candidate.sha256, 'baseline_repair_failure_digest');
    writeFileSync(join(evidenceDir, 'dependency-lock-rejected.json'), bytes, { flag: 'wx' });
  }
  writeFileSync(join(evidenceDir, 'dependency-repair-failure.json'), JSON.stringify({
    schemaVersion: failure.schemaVersion, stage: failure.stage,
    resolution: failure.resolution,
    candidate: { ...candidate, evidenceFile: bytes === null ? null : 'dependency-lock-rejected.json' },
    receipt: failure.receipt,
  }), { flag: 'wx' });
}

async function main() {
  const argument = (name: string) => {
    const value = process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
    assert.ok(value, 'Missing ' + name);
    return value;
  };
  const sourceRoot = argument('source-root');
  const evidenceDir = argument('evidence-dir');
  const fixtureBytes = readFileSync(argument('fixture-path'));
  assert.equal(digest(fixtureBytes), argument('fixture-sha'));
  const fixture = JSON.parse(fixtureBytes.toString());
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(), fixture.sourceSha);
  assert.equal(fixture.files.length, 14);
  const beforeSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
  const beforeProductBoundary = baselineProductBoundary(sourceRoot, []);
  const { inputPaths } = metadataRepairInputLayout(sourceRoot);
  const beforeInputs = new Map<string, Buffer | null>(inputPaths.map((path: string) => [path,
    existsSync(join(sourceRoot, path)) ? readFileSync(join(sourceRoot, path)) : null]));
  // Retain selected bytes before the resolver starts, including on refusal.
  writeFileSync(join(evidenceDir, 'dependency-repair-inputs.json'), JSON.stringify({
    edition: repairedBaselineEdition, originalSourceSha: fixture.sourceSha,
    beforeSources, beforeProductBoundary, inputs: [...beforeInputs].map(([path, bytes]) => ({ path,
      sha256: bytes === null ? null : digest(bytes), base64: bytes?.toString('base64') ?? null })),
  }), { flag: 'wx' });
  const result = await resolveMetadataRepairLock({ repoRoot: sourceRoot }).catch((error: unknown) => {
    retainBaselineRepairFailure(evidenceDir, error);
    throw error;
  });
  assert.deepEqual([...result.snapshot.keys()], [...beforeInputs.keys()]);
  for (const [path, bytes] of result.snapshot as Map<string, Buffer | null>)
    assert.deepEqual(bytes, beforeInputs.get(path), 'baseline_repair_selected_input_changed:' + path);
  assertBaselineRepairInputs(sourceRoot, beforeInputs);
  assert.deepEqual(assertFrozenBaselineSources(sourceRoot, fixture.files), beforeSources);
  assert.ok('output' in result.receipt, 'baseline_repair_output_receipt_missing');
  const output = result.receipt.output;
  assert.ok(output && typeof output === 'object' && 'path' in output && 'sha256' in output,
    'baseline_repair_output_receipt_invalid');
  assert.equal(output.path, 'package-lock.json');
  assert.equal(result.receipt.cleanup.removed, true);
  const originalLock = beforeInputs.get('package-lock.json');
  assert.ok(originalLock);
  const repairedLock: Buffer = result.bytes;
  assert.equal(digest(repairedLock), output.sha256);
  const delta = baselineLockDelta(originalLock, repairedLock);
  assert.ok(delta.packages.length > 0, 'baseline_repair_missing_delta');
  writeFileSync(join(evidenceDir, 'dependency-lock-original.json'), originalLock, { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-lock-repaired.json'), repairedLock, { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-repair-delta.json'), JSON.stringify(delta), { flag: 'wx' });
  writeFileSync(join(evidenceDir, 'dependency-repair-receipt.json'), JSON.stringify(result.receipt), { flag: 'wx' });
  // Only this exclusively owned disposable clone is changed. No publication or
  // original Git object is mutated, and the ordinary guarded installer follows.
  writeFileSync(join(sourceRoot, 'package-lock.json'), repairedLock);
  assertBaselineRepairInputs(sourceRoot, beforeInputs, { path: 'package-lock.json', bytes: repairedLock });
  const afterSources = assertFrozenBaselineSources(sourceRoot, fixture.files);
  const afterProductBoundary = baselineProductBoundary(sourceRoot, ['package-lock.json']);
  writeFileSync(join(evidenceDir, 'dependency-edition.json'), JSON.stringify({
    edition: repairedBaselineEdition, originalSourceSha: fixture.sourceSha,
    originalDependenciesReconstructed: false, originalLockSha256: digest(originalLock),
    repairedLockSha256: digest(repairedLock), beforeSources, afterSources,
    beforeProductBoundary, afterProductBoundary,
    changedInputs: ['package-lock.json'], resolverReceipt: 'dependency-repair-receipt.json',
    selectedInputs: 'dependency-repair-inputs.json', fullDelta: 'dependency-repair-delta.json',
    acceptance: 'Unexecuted compatibility edition; independent review and actual client traces still required',
  }), { flag: 'wx' });
}

if (isCliEntry(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
