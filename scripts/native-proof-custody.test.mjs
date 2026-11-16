import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Permanent coverage on the existing scripts/*.test.mjs Node route. The
// scheduler transitively imports TypeScript, so use the normal install guard.
const subjectUrl = new URL('./lib/budgeted-task-scheduler.mjs', import.meta.url).href;
const { retainNativeProofPacket, retainNativeProofPacketAsync, verifyNativeProofPacket, preflightNativeProofCustody,
  createNativeArtifactPersister, readNativeProofInventoryPage } = await import(subjectUrl);
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


function inventoryFixture(count, permutation = 'forward') {
  const producer = join(root, 'inventory-' + count + '-' + permutation);
  mkdirSync(producer);
  const out = join(producer, 'out.json');
  mkdirSync(out + '.modules'); mkdirSync(out + '.native-processes');
  writeFileSync(out, JSON.stringify({ rows: [], diagnostics: [], nativeRun: { files: [] } }));
  const names = Array.from({ length: count - 1 }, (_, index) => 'event-' + String(index).padStart(8, '0') + '.json');
  names.push('zz-decisive-shell.json');
  const order = permutation === 'reverse' ? [...names].reverse() :
    permutation === 'interleaved' ? names.filter((_, i) => i % 2).concat(names.filter((_, i) => !(i % 2))) : names;
  const contents = new Map(names.map((name, index) => [name, Buffer.from(JSON.stringify({
    index, event: index === count - 1 ? 'shell-spawn-start' : 'ordinary', argv: ['exact', '☃', String(index)],
  }))]));
  for (const name of order) writeFileSync(join(out + '.native-processes', name), contents.get(name));
  const expected = [{ id: 'inventory', attempt: 'primary', selected: ['fixture.test.ts'], runner: 'vitest', armed: true,
    processSources: { preload: '0', workspace: null, root: null }, out, auxiliary: [] }];
  return { producer, out, names, contents, contract: {
    identity: { workspace: 'fixture', harness: 'papercusp', runId: 'inventory-' + count + '-' + permutation }, expected,
  }, input: { identity: { workspace: 'fixture', harness: 'papercusp', runId: 'inventory-' + count + '-' + permutation },
    expected, observations: [{ id: 'inventory', out }] } };
}
function consumeInventory(archive, result, fixture) {
  const family = result.manifest.groups[0].families.find(row => row.family === 'C');
  const seen = [], digest = createHash('sha256');
  let cursor = null;
  for (const entry of family.entries) {
    const page = readNativeProofInventoryPage(archive, entry.artifact);
    assert.equal(page.after, cursor);
    assert.equal(page.total, fixture.names.length);
    assert.ok(page.records.length <= result.manifest.limits.families.C.objects);
    assert.ok(entry.artifact.byteLength + 1 <= result.manifest.limits.families.C.bytes);
    for (const record of page.records) {
      const name = record.original.slice((fixture.out + '.native-processes/').length);
      assert.equal(record.original, join(fixture.out + '.native-processes', name));
      assert.deepEqual(record.bytes, fixture.contents.get(name));
      seen.push(name); digest.update(name); digest.update(record.bytes);
    }
    assert.equal(page.omittedCount, fixture.names.length - seen.length);
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, fixture.names);
  assert.equal(cursor, null);
  assert.equal(family.inventory.total, fixture.names.length);
  assert.equal(family.inventory.completed, fixture.names.length);
  assert.equal(family.inventory.omittedCount, 0);
  assert.equal(family.inventory.nextCursor, null);
  assert.equal(JSON.parse(fixture.contents.get(seen.at(-1))).event, 'shell-spawn-start');
  return digest.digest('hex');
}

test('retains identical inventory accounting and locator when completed pages resume', () => {
  const fixture = inventoryFixture(2051, 'idempotent'), archive = join(root, 'packet-idempotent');
  const first = retainNativeProofPacket(archive, fixture.input);
  const resumed = retainNativeProofPacket(archive, fixture.input);
  assert.equal(first.status, 'complete');
  assert.deepEqual(resumed.locator, first.locator);
  assert.deepEqual(resumed.manifest.bytesReadByFamily, first.manifest.bytesReadByFamily);
  assert.deepEqual(resumed.manifest.segments, first.manifest.segments);
  rmSync(fixture.producer, { recursive: true });
  assert.equal(verifyNativeProofPacket(archive, resumed.locator, fixture.contract).status, 'complete');
  consumeInventory(archive, resumed, fixture);
});

for (const count of [2047, 2048, 2049]) for (const permutation of ['forward', 'reverse', 'interleaved']) {
  test('native inventory boundary ' + count + ' creation order ' + permutation, () => {
    const fixture = inventoryFixture(count, permutation), archive = join(root, 'packet-' + count + '-' + permutation);
    const result = retainNativeProofPacket(archive, fixture.input);
    assert.equal(result.status, 'complete', JSON.stringify(result.manifest.gaps));
    assert.equal(result.manifest.schemaVersion, 'native-proof-custody-v4');
    assert.equal(result.manifest.limits.families.C.objects, 2048);
    assert.equal(result.manifest.limits.objects, 16384);
    rmSync(fixture.producer, { recursive: true });
    assert.equal(verifyNativeProofPacket(archive, result.locator, fixture.contract).status, 'complete');
    consumeInventory(archive, result, fixture);
  });
}

test('recovers a missing report only from the same run and contract, preserving predecessor bytes', () => {
  const fixture = inventoryFixture(2050, 'retained-report'), original = join(root, 'retained-report-original');
  const report = join(fixture.producer, 'report.json'), reportBytes = Buffer.from('{"tests":235,"passed":235,"skipped":0}');
  writeFileSync(report, reportBytes);
  fixture.contract.expected[0].auxiliary.push({ role: 'report', state: 'produced', path: report });
  const saved = retainNativeProofPacket(original, fixture.input);
  assert.equal(saved.status, 'complete');
  const oldPin = saved.manifest.groups[0].auxiliary[0].artifact;
  const originalBytes = readFileSync(join(original, 'objects', oldPin.ref));
  rmSync(report);
  const retainedAuxiliary = { directory: original, locator: saved.locator };
  assert.throws(() => retainNativeProofPacket(join(root, 'foreign-report-contract'), {
    ...fixture.input, identity: { ...fixture.input.identity, runId: 'different' },
    predecessor: saved.locator, retainedAuxiliary,
  }), /custody identity or expected population mismatch/);
  assert.throws(() => retainNativeProofPacket(join(root, 'unbound-report-predecessor'), {
    ...fixture.input, retainedAuxiliary,
  }), /custody predecessor recovery binding/);
  const archive = join(root, 'retained-report-recovered');
  const result = retainNativeProofPacket(archive, { ...fixture.input, predecessor: saved.locator, retainedAuxiliary });
  assert.equal(result.status, 'complete', JSON.stringify(result.manifest.gaps));
  assert.deepEqual(result.manifest.predecessor, saved.locator);
  assert.equal(result.manifest.groups[0].auxiliary[0].artifact.sha256, oldPin.sha256);
  assert.deepEqual(readFileSync(join(archive, 'objects', oldPin.ref)), reportBytes);
  assert.deepEqual(readFileSync(join(original, 'objects', oldPin.ref)), originalBytes);
  rmSync(fixture.producer, { recursive: true });
  assert.equal(verifyNativeProofPacket(archive, result.locator, fixture.contract).status, 'complete');
  consumeInventory(archive, result, fixture);
});

for (const count of [16383, 16384, 16385]) test('native records cross the former global boundary ' + count, () => {
  const fixture = inventoryFixture(count), archive = join(root, 'global-packet-' + count);
  const result = retainNativeProofPacket(archive, fixture.input);
  assert.equal(result.status, 'complete', JSON.stringify(result.manifest.gaps));
  assert.ok(result.manifest.objectsRead < result.manifest.limits.objects);
  assert.equal(result.manifest.groups[0].families.find(row => row.family === 'C').entries.length, Math.ceil(count / 2048));
  rmSync(fixture.producer, { recursive: true });
  consumeInventory(archive, result, fixture);
});

test('durable inventory advances across four crashes and consumes late evidence from retained bytes in a fresh process', () => {
  const fixture = inventoryFixture(2048 * 9 + 3, 'interleaved'), archive = join(root, 'restart-inventory');
  const script = 'const {retainNativeProofPacket}=await import(process.argv[1]);' +
    'const [archive,input]=JSON.parse(process.argv[2]);' +
    'retainNativeProofPacket(archive,{...input,onProgress:p=>{' +
    'if(p.phase==="inventory-page"&&!p.resumed){console.log(JSON.stringify(p));process.exit(86)}}});';
  for (let restart = 0; restart < 4; restart++) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, subjectUrl,
      JSON.stringify([archive, fixture.input])], { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(child.status, 86, child.stderr);
    const progress = JSON.parse(child.stdout);
    assert.equal(progress.completed, (restart + 1) * 2048);
    assert.equal(progress.omittedCount, fixture.names.length - progress.completed);
    assert.equal(progress.nextCursor, fixture.names[progress.completed - 1]);
    const journals = readdirSync(archive).filter(name => name.endsWith('.inventory-progress.json'));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(readFileSync(join(archive, journals[0])));
    assert.equal(journal.pages.length, restart + 1);
    assert.equal(readNativeProofInventoryPage(archive, journal.pages.at(-1)).nextCursor, progress.nextCursor);
  }
  const progress = [];
  const result = retainNativeProofPacket(archive, { ...fixture.input, onProgress: record => progress.push(record) });
  assert.equal(result.status, 'complete', JSON.stringify(result.manifest.gaps));
  assert.equal(progress.filter(row => row.phase === 'inventory-page' && row.resumed).length, 4);
  const digest = consumeInventory(archive, result, fixture);
  rmSync(fixture.producer, { recursive: true });
  const consumer = 'import{createHash}from"node:crypto";' +
    'const {verifyNativeProofPacket,readNativeProofInventoryPage}=await import(process.argv[1]);' +
    'const [archive,locator,contract]=JSON.parse(process.argv[2]);' +
    'const result=verifyNativeProofPacket(archive,locator,contract);' +
    'const family=result.manifest.groups[0].families.find(r=>r.family==="C");' +
    'const digest=createHash("sha256");let count=0,last,cursor=null;' +
    'for(const entry of family.entries){const p=readNativeProofInventoryPage(archive,entry.artifact);' +
    'if(p.after!==cursor)throw Error("cursor");for(const r of p.records){count++;' +
    'digest.update(r.original.slice((contract.expected[0].out+".native-processes/").length));digest.update(r.bytes);' +
    'last=JSON.parse(r.bytes)}cursor=p.nextCursor}' +
    'console.log(JSON.stringify({status:result.status,count,last,cursor,digest:digest.digest("hex")}));';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', consumer, subjectUrl,
    JSON.stringify([archive, result.locator, fixture.contract])], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.count, fixture.names.length);
  assert.equal(recovered.cursor, null);
  assert.equal(recovered.last.event, 'shell-spawn-start');
  assert.equal(recovered.digest, digest);
  for (const fault of ['missing-page', 'census', 'encoding']) {
    const manifest = structuredClone(result.manifest), family = manifest.groups[0].families.find(row => row.family === 'C');
    if (fault === 'missing-page') family.entries.pop();
    if (fault === 'census') family.inventory.total--;
    if (fault === 'encoding') manifest.schemaVersion = 'native-proof-custody-v3';
    const manifestPin = createNativeArtifactPersister(join(archive, 'objects'))
      .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    const locator = { ...result.locator, manifest: manifestPin,
      inventoryHash: hash({ groups: manifest.groups, gaps: manifest.gaps, segments: manifest.segments }) };
    assert.throws(() => verifyNativeProofPacket(archive, locator, fixture.contract), /custody .*inventory/);
  }
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
  manifest.schemaVersion = 'native-proof-custody-v3';
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

test('marks family B not-produced when failed setup reported no module results', () => {
  const subject = join(root, 'precollection-no-module-results');
  mkdirSync(subject, { recursive: true });
  const subjectOut = join(subject, 'out.json');
  mkdirSync(subjectOut + '.native-processes', { recursive: true });
  writeFileSync(subjectOut, JSON.stringify({
    nativeRun: {
      terminalHook: 'onTestRunEnd',
      reason: 'failed',
      reportedModulePaths: [],
      modulePopulationMatched: true,
      files: [],
      gaps: ['no-module-results'],
    },
  }));
  const subjectGroup = {
    id: 'group-no-module-results',
    attempt: 'primary',
    selected: ['setup.test.ts'],
    runner: 'vitest',
    armed: true,
    processSources: { preload: null, workspace: null, root: null },
    out: subjectOut,
    auxiliary: [],
  };
  const identity = { workspace: 'fixture', harness: 'papercusp', runId: 'precollection-no-module-results' };
  const packetDirectory = join(subject, 'packet');
  const retained = retainNativeProofPacket(packetDirectory, {
    identity,
    expected: [subjectGroup],
    observations: [{ id: subjectGroup.id, out: subjectOut, captureComplete: true }],
  });
  const group = retained.manifest.groups[0];
  assert.equal(retained.status, 'complete');
  assert.deepEqual(group.families.find(row => row.family === 'B'), {
    family: 'B', state: 'not-produced', producer: subjectGroup.id, reason: 'no-module-results', entries: [],
  });
  assert.deepEqual(group.referenceArtifacts, []);
  assert.deepEqual(group.referenceGaps, []);
  assert.equal(retained.manifest.gaps.some(gap => gap.startsWith(subjectGroup.id + ':B:')), false);
  assert.equal(verifyNativeProofPacket(packetDirectory, retained.locator, { identity, expected: [subjectGroup] }).status, 'complete');

  const referencedSubject = join(root, 'precollection-with-reference');
  mkdirSync(referencedSubject, { recursive: true });
  const referencedOut = join(referencedSubject, 'out.json');
  mkdirSync(referencedOut + '.native-processes', { recursive: true });
  const referencedBytes = Buffer.from('module source referenced by A');
  const referencedSha = createHash('sha256').update(referencedBytes).digest('hex');
  writeFileSync(referencedOut, JSON.stringify({
    rows: [{ moduleEvaluations: {
      schemaVersion: 'vitest-evaluator-inputs-v1',
      scope: 'vitest-inlined-evaluator-inputs',
      basis: 'before-evaluator-call',
      entries: [{ codeRef: join(referencedOut + '.modules', referencedSha + '.js'),
        sha256: referencedSha, byteLength: referencedBytes.length }],
      vmInputs: [],
    } }],
    nativeRun: {
      terminalHook: 'onTestRunEnd',
      reason: 'failed',
      reportedModulePaths: [],
      modulePopulationMatched: true,
      files: [],
      gaps: ['no-module-results'],
    },
  }));
  const referencedGroup = { ...subjectGroup, id: 'group-no-module-results-with-reference', out: referencedOut };
  const referencedIdentity = { ...identity, runId: 'precollection-with-reference' };
  const referencedPacket = retainNativeProofPacket(join(referencedSubject, 'packet'), {
    identity: referencedIdentity,
    expected: [referencedGroup],
    observations: [{ id: referencedGroup.id, out: referencedOut, captureComplete: true }],
  });
  const referencedFamily = referencedPacket.manifest.groups[0].families.find(row => row.family === 'B');
  assert.equal(referencedFamily.state, 'unavailable');
  assert.equal(referencedFamily.reason, 'ENOENT');
  assert.ok(referencedPacket.manifest.gaps.includes(referencedGroup.id + ':B:ENOENT'));
});
