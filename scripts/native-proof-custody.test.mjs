import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Permanent coverage on the existing scripts/*.test.mjs Node route. The
// scheduler transitively imports TypeScript, so use the normal install guard.
const subjectUrl = new URL('./lib/budgeted-task-scheduler.mjs', import.meta.url).href;
const { retainNativeProofPacket, verifyNativeProofPacket, preflightNativeProofCustody,
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

test('preflights known population capacity and labels runtime capacity unknown', () => {
  assert.deepEqual(preflightNativeProofCustody(expected), { groups: 1, minimumObjects: 1,
    dynamicCapacity: 'unknown-until-capture' });
  assert.throws(() => preflightNativeProofCustody(Array(4097).fill(expected[0])), /custody expected population/);
  assert.throws(() => preflightNativeProofCustody([{ ...expected[0], selected: Array(4097).fill('test.ts') }]), /custody selected/);
  const large = Array.from({ length: 3277 }, (_, index) => ({ ...expected[0], id: `group-${index}`,
    processSources: undefined, auxiliary: Array(3).fill({ role: 'stream', state: 'produced' }) }));
  assert.throws(() => preflightNativeProofCustody(large), /custody minimum archive object capacity/);
});
