import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Permanent coverage on the existing scripts/*.test.mjs Node route. The
// scheduler transitively imports TypeScript, so use the normal install guard.
const subjectUrl = new URL('./lib/budgeted-task-scheduler.mjs', import.meta.url).href;
const { retainNativeProofPacket, retainNativeProofPacketAsync, verifyNativeProofPacket, preflightNativeProofCustody,
  createNativeArtifactPersister } = await import(subjectUrl);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'native-custody-capsules-'));
after(() => rmSync(root, { recursive: true, force: true }));
const out = join(root, 'producer', 'out.json'), directory = join(root, 'packet');
mkdirSync(join(root, 'producer'));
for (const suffix of ['.modules', '.native-processes']) mkdirSync(out + suffix);
const bytes = Buffer.from('export const exact = "☃";');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const pin = { codeRef: join(out + '.modules', sha256 + '.js'), sha256, byteLength: bytes.length };
writeFileSync(pin.codeRef, bytes);
const evaluation = { schemaVersion: 'vitest-evaluator-inputs-v1', scope: 'vitest-inlined-evaluator-inputs',
  basis: 'before-evaluator-call', entries: Array.from({ length: 512 }, (_, index) => ({ ...pin, index })),
  vmInputs: Array.from({ length: 512 }, (_, index) => ({ ...pin, index, vm: true })) };
const rows = Array.from({ length: 24 }, () => ({ moduleEvaluations: evaluation }));
writeFileSync(out, JSON.stringify({ rows, diagnostics: rows,
  nativeRun: { files: rows.map(row => ({ proof: { inputs: row } })) } }));
const expected = [{ id: 'group-0', attempt: 'primary', selected: ['test.ts'], runner: 'vitest', armed: true,
  processSources: { preload: '0', workspace: null, root: null }, out, auxiliary: [] }];
const contract = { identity: { workspace: 'fixture', harness: 'papercusp', runId: 'capsules' }, expected };
const saved = retainNativeProofPacket(directory, { ...contract, observations: [{ id: 'group-0', out }] });
rmSync(join(root, 'producer'), { recursive: true });

test('retains all 73728 occurrences in a fresh process with only retained bytes', () => {
  assert.equal(saved.status, 'complete');
  const group = saved.manifest.groups[0], capsules = group.referenceCapsules;
  assert.deepEqual(group.references, []);
  assert.deepEqual(group.referenceArtifacts, [pin]);
  assert.deepEqual(group.referenceGaps, []);
  assert.deepEqual(capsules.vectors, [{ sha256: hash({ entries: evaluation.entries, vmInputs: evaluation.vmInputs }),
    entries: evaluation.entries, vmInputs: evaluation.vmInputs }]);
  assert.deepEqual(capsules.locations, ['/rows', '/diagnostics', '/nativeRun/files'].flatMap(prefix =>
    Array.from({ length: 24 }, (_, index) => ({ location: `${prefix}/${index}`, capsule: capsules.vectors[0].sha256 }))));
  assert.equal(capsules.locations.length * (evaluation.entries.length + evaluation.vmInputs.length), 73728);
  assert.equal(saved.manifest.limits.referenceOccurrences, 65536);
  assert.equal(saved.manifest.limits.objectBytes, 16 * 1024 * 1024);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { verifyNativeProofPacket } = await import(process.argv[1]);' +
    'const r=verifyNativeProofPacket(...JSON.parse(process.argv[2]));' +
    'console.log(JSON.stringify({status:r.status,verdicts:r.manifest.verdicts}));', subjectUrl,
    JSON.stringify([directory, saved.locator, contract])], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 'complete', verdicts: saved.manifest.verdicts });
  assert.equal(saved.manifest.verdicts.nativeProof, 'unqualified');
  assert.equal(saved.manifest.verdicts.acceptance, 'unmeasured');
});

for (const fault of ['location', 'duplicate', 'role', 'order', 'pin-field', 'digest', 'vector', 'encoding']) {
  test(`rejects independently resealed capsule ${fault} changes`, () => {
    assert.equal(saved.status, 'complete');
    const manifest = structuredClone(saved.manifest), group = manifest.groups[0], capsules = group.referenceCapsules;
    if (fault === 'location') capsules.locations.pop();
    if (fault === 'duplicate') capsules.locations[1] = capsules.locations[0];
    if (fault === 'role') capsules.vectors[0].vmInputs = [];
    if (fault === 'order') capsules.vectors[0].entries.reverse();
    if (fault === 'pin-field') capsules.vectors[0].entries[0].index = -1;
    if (fault === 'digest') capsules.vectors[0].sha256 = '0'.repeat(64);
    if (fault === 'vector') capsules.vectors.pop();
    if (fault === 'encoding') delete group.referenceCapsules;
    const manifestPin = createNativeArtifactPersister(join(directory, 'objects'))
      .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    const inventoryHash = hash({ groups: manifest.groups, gaps: manifest.gaps, segments: manifest.segments });
    assert.throws(() => verifyNativeProofPacket(directory, { ...saved.locator, manifest: manifestPin, inventoryHash }, contract),
      /custody reference/);
  });
}

test('reads historical flat overflow as partial without promoting or rejecting its history', () => {
  assert.equal(saved.status, 'complete');
  const manifest = structuredClone(saved.manifest), group = manifest.groups[0], capsules = group.referenceCapsules;
  group.references = capsules.locations.flatMap(({ location }) => ['entries', 'vmInputs'].flatMap(role =>
    evaluation[role].map((pin, index) => ({ location: `${location}/${role}/${index}`, ...pin })))).slice(0, 65536);
  delete group.referenceCapsules;
  group.referenceGaps = ['evaluator-occurrence-limit'];
  manifest.gaps = ['group-0:A:evaluator-occurrence-limit'];
  manifest.verdicts.custody = 'partial';
  const store = createNativeArtifactPersister(join(directory, 'objects')), bytes = Buffer.from(JSON.stringify(manifest));
  let manifestPin;
  if (bytes.length <= 16 * 1024 * 1024) manifestPin = store.persist(bytes, 'native-proof.json');
  else {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024)
      parts.push({ offset, artifact: store.persist(bytes.subarray(offset, offset + 8 * 1024 * 1024), 'native-metadata-chunk') });
    manifestPin = store.persist(Buffer.from(JSON.stringify({ schemaVersion: 'native-proof-index-v1', byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), parts })), 'native-proof.json');
  }
  const inventoryHash = hash({ groups: manifest.groups, gaps: manifest.gaps, segments: manifest.segments });
  assert.equal(verifyNativeProofPacket(directory, { ...saved.locator, manifest: manifestPin, inventoryHash }, contract).status, 'partial');
});

test('accounts 17100 archive references as nine unique objects while preserving occurrences and byte charges', () => {
  const occurrenceCount = 17100;
  const paths = Array.from({ length: 9 }, (_, index) => {
    const path = join(root, 'unique-source-' + index + '.bin');
    writeFileSync(path, Buffer.alloc(64, index + 1));
    return path;
  });
  const auxiliary = Array.from({ length: occurrenceCount }, (_, index) => ({
    role: 'repeated-source', state: 'produced', path: paths[index % paths.length],
  }));
  const expected = [{ id: 'unique-archive', attempt: 'primary', selected: ['custody'], runner: 'node',
    armed: false, out: null, auxiliary }];
  const identity = { workspace: 'fixture', harness: 'papercusp', runId: 'unique-archive' };
  const archive = join(root, 'unique-archive');
  const retained = retainNativeProofPacket(archive, { identity, expected,
    observations: [{ id: 'unique-archive', out: null }] });
  assert.equal(retained.status, 'complete');
  const manifest = retained.manifest, group = manifest.groups[0];
  assert.equal(manifest.archiveObjectAccounting, 'unique-family-artifact-ref-v1');
  assert.equal(manifest.objectsRead, 9);
  assert.equal(manifest.objectsReadByFamily.auxiliary, 9);
  assert.equal(manifest.bytesReadByFamily.auxiliary, occurrenceCount * 64);
  assert.equal(group.auxiliary.length, occurrenceCount);
  assert.equal(new Set(group.auxiliary.map(row => row.artifact.ref)).size, 9);
  assert.equal(manifest.segments.length, 2);
  const entries = manifest.segments.flatMap(segment =>
    JSON.parse(readFileSync(join(archive, 'objects', segment.artifact.ref), 'utf8')).entries);
  assert.equal(entries.length, occurrenceCount);
  assert.equal(new Set(entries.map(row => row.family + '\0' + row.artifact.ref)).size, 9);
  assert.equal(verifyNativeProofPacket(archive, retained.locator, { identity, expected }).status, 'complete');
});

test('markerless v3 keeps occurrence-based object accounting', () => {
  const source = join(root, 'markerless-repeat.bin'), archive = join(root, 'markerless-v3');
  writeFileSync(source, Buffer.alloc(64, 42));
  const expected = [{ id: 'markerless', attempt: 'primary', selected: ['custody'], runner: 'node',
    armed: false, out: null, auxiliary: [
      { role: 'repeated-source', state: 'produced', path: source },
      { role: 'repeated-source', state: 'produced', path: source },
    ] }];
  const identity = { workspace: 'fixture', harness: 'papercusp', runId: 'markerless-v3' };
  const retained = retainNativeProofPacket(archive, { identity, expected,
    observations: [{ id: 'markerless', out: null }] });
  const manifest = structuredClone(retained.manifest);
  assert.equal(manifest.objectsRead, 1);
  delete manifest.archiveObjectAccounting;
  manifest.objectsRead = 2;
  manifest.objectsReadByFamily.auxiliary = 2;
  manifest.segments[0].objectsRead = 2;
  manifest.segments[0].objectsReadByFamily.auxiliary = 2;
  const manifestPin = createNativeArtifactPersister(join(archive, 'objects'))
    .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
  const locator = { ...retained.locator, manifest: manifestPin,
    inventoryHash: hash({ groups: manifest.groups, gaps: manifest.gaps, segments: manifest.segments }) };
  const verified = verifyNativeProofPacket(archive, locator, { identity, expected });
  assert.equal(verified.status, 'complete');
  assert.equal(verified.manifest.objectsRead, 2);
  assert.equal(verified.manifest.bytesReadByFamily.auxiliary, 128);
});

test('preflights known population capacity and labels runtime capacity unknown', () => {
  assert.deepEqual(preflightNativeProofCustody(expected), { groups: 1, minimumObjects: 1,
    dynamicCapacity: 'unknown-until-capture' });
  assert.throws(() => preflightNativeProofCustody(Array(4097).fill(expected[0])), /custody expected population/);
  assert.throws(() => preflightNativeProofCustody([{ ...expected[0], selected: Array(4097).fill('test.ts') }]), /custody selected/);
  const large = Array.from({ length: 3277 }, (_, index) => ({ ...expected[0], id: `group-${index}`,
    processSources: undefined, auxiliary: Array(3).fill({ role: 'stream', state: 'produced' }) }));
  assert.throws(() => preflightNativeProofCustody(large), /custody minimum archive object capacity/);
});

test('reseals the original retained packet without reading retired producers or changing its verdicts', async () => {
  const result = await retainNativeProofPacketAsync(directory, { ...contract, retainedLocator: saved.locator });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.locator, saved.locator);
  assert.deepEqual(result.manifest, saved.manifest);
  assert.equal(result.manifest.verdicts.nativeProof, 'unqualified');
  assert.equal(result.manifest.verdicts.acceptance, 'unmeasured');
  await assert.rejects(retainNativeProofPacketAsync(directory, {
    ...contract, identity: { ...contract.identity, runId: 'foreign' }, retainedLocator: saved.locator,
  }), /custody identity or expected population mismatch/);
});

for (const operation of ['sync', 'close']) test(`deadline operation attribution: blocked ${operation} retains immutable phase evidence`, async t => {
  const probe = await open(join(directory, 'objects', saved.locator.manifest.ref));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const operationEntered = new Promise(resolve => { entered = resolve; });
  const syncing = [], closing = [];
  t.mock.method(prototype, 'sync', function () {
    // close is an own bound method on each FileHandle, unlike sync.
    const originalClose = this.close;
    t.mock.method(this, 'close', function () {
      const done = (async () => {
        if (operation === 'close') { entered(); await blocked; }
        return originalClose.call(this);
      })();
      closing.push(done);
      return done;
    });
    const done = (async () => {
      if (operation === 'sync') { entered(); await blocked; }
      return originalSync.call(this);
    })();
    syncing.push(done);
    return done;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const progress = [];
  const pending = retainNativeProofPacketAsync(directory, { ...contract, retainedLocator: saved.locator,
    deadlineAtMs: Date.now() + 100, onProgress: record => progress.push(record) });
  let error;
  try {
    await operationEntered;
    t.mock.timers.tick(101);
    await assert.rejects(pending, failure => {
      error = failure;
      assert.equal(failure.code, 'NATIVE_PROOF_SYNC_DEADLINE');
      assert.equal(failure.phase, 'object');
      assert.equal(failure.operation, operation);
      assert.match(failure.message, new RegExp(`operation=${operation}$`));
      assert.ok(failure.operationElapsedMs >= 0);
      assert.equal(typeof failure.operationTimingsMs.open, 'number');
      assert.equal(failure.operationTimingsMs[operation], null);
      if (operation === 'close') assert.equal(typeof failure.operationTimingsMs.sync, 'number');
      return true;
    });
    const frozen = JSON.stringify(error.operationTimingsMs);
    const deadline = progress.find(record => record.phase === 'sync-deadline');
    assert.equal(deadline.syncPhase, 'object');
    assert.equal(deadline.operation, operation);
    assert.deepEqual(deadline.operationTimingsMs, error.operationTimingsMs);
    assert.equal(progress.some(record => record.phase === 'sync-complete'), false);
    release();
    await Promise.all(syncing);
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(closing);
    assert.equal(JSON.stringify(error.operationTimingsMs), frozen);
  } finally {
    release();
    await pending.catch(() => {});
    await Promise.all(syncing);
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(closing);
  }
});

for (const mode of ['fresh', 'retained']) test(`bounds interrupted ${mode}-packet sync and identifies the pending operation`, async t => {
  const probe = await open(join(directory, 'objects', saved.locator.manifest.ref));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.mock.method(prototype, 'sync', () => blocked);
  const progress = [];
  const target = mode === 'fresh' ? join(root, 'deadline-fresh') : directory;
  const pending = retainNativeProofPacketAsync(target, { ...contract,
    ...(mode === 'retained' ? { retainedLocator: saved.locator } : {}),
    deadlineAtMs: Date.now() + 30, onProgress: record => progress.push(record) });
  try {
    const outcome = await Promise.race([
      pending.then(() => ({ status: 'resolved' }), error => ({ status: 'rejected', error })),
      new Promise(resolve => setTimeout(() => resolve({ status: 'unbounded' }), 500)),
    ]);
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.error.code, 'NATIVE_PROOF_SYNC_DEADLINE');
    assert.equal(outcome.error.phase, 'object');
    assert.match(outcome.error.path, /\/objects\//);
    assert.equal(progress.some(record => record.phase === 'sync-complete'), false);
    if (mode === 'fresh') {
      const locator = JSON.parse(readFileSync(join(target, 'pending-locator.json'), 'utf8'));
      assert.deepEqual(locator.identity, contract.identity);
      // Missing retired producers stay missing; an interrupted sync preserves
      // the exact partial inventory rather than inventing a complete packet.
      assert.equal(verifyNativeProofPacket(target, locator, contract).status, 'partial');
    }
  } finally {
    release();
    await pending.catch(() => {});
  }
});
