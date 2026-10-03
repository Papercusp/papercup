/** Independent raw-row acceptance for a bounded P-011 current-build baseline.
 * No sampler import, inventory total, reduction headline or owner label is an oracle.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';

const root = resolve(__dirname, '../../..');
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const check = (value: unknown, reason: string) => { if (!value) throw Error('P011 baseline: ' + reason); };
const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const nonnegative = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const time = (x: string | number) => typeof x === 'number' ? x : Date.parse(x);
const identity = (x: any) => [x.pid, x.startTicks, x.executableSha256].join(':');

function auditBaseline(r: any) {
  check(r.schemaVersion === 1 && r.plane === 'live-current-build-operator-api' &&
    r.incomplete === false && !r.error, 'complete current-build run');
  check(Number.isInteger(r.pid) && r.pid > 0 && Number.isInteger(r.counterPid) && r.counterPid > 0,
    'target PIDs');
  check(/^[a-f0-9]{7,40}$/.test(r.buildSha) && r.healthBefore.sha === r.buildSha &&
    r.healthAfter.sha === r.buildSha, 'loaded health build');
  check(sha(r.bundle.diskSha256) && r.bundle.diskSha256After === r.bundle.diskSha256 &&
    sha(r.counterBundle.diskSha256) && r.counterBundle.diskSha256After === r.counterBundle.diskSha256,
    'disk artifact fence');
  check(r.bundle.argvEntry.endsWith('/hono-host.mjs') && r.bundle.path === r.bundle.argvEntry,
    'main exact entry');
  const sibling = r.counterPid !== r.pid;
  const entry = sibling ? join(dirname(r.bundle.argvEntry), 'spawner-sidecar.mjs') : r.bundle.argvEntry;
  check(r.counterBundle.argvEntry === entry && r.counterBundle.path === entry, 'counter exact entry');
  if (sibling) {
    const a = r.counterBundle.loadedBuild, b = r.counterBundle.loadedBuildAfter;
    check(a?.status === 'known' && b?.status === 'known' && a.pid === r.counterPid && b.pid === r.counterPid &&
      typeof a.buildInfo?.sha === 'string' && /^[a-f0-9]{7,40}$/.test(a.buildInfo.sha) &&
      JSON.stringify(a.buildInfo) === JSON.stringify(b.buildInfo) &&
      typeof a.serverGeneration === 'string' && a.serverGeneration.length > 0 &&
      a.serverGeneration === b.serverGeneration && typeof a.connectionId === 'string' &&
      a.connectionId.length > 0 && a.connectionId === b.connectionId, 'loaded sibling socket fence');
    check(nonnegative(r.counterBundle.socketBefore?.dev) && positive(r.counterBundle.socketBefore?.ino) &&
      JSON.stringify(r.counterBundle.socketBefore) === JSON.stringify(r.counterBundle.socketAfter), 'socket inode fence');
  }
  check(r.limits.windows === 3 && r.limits.idleMs === 2000 && r.limits.requestsPerWindow === 8 &&
    r.limits.concurrency === 2 && r.limits.descendantsPerSample === 64, 'fixed workload bounds');
  const phases = Array.from({ length: 3 }, (_, w) =>
    ['idle-' + w + '-start', 'idle-' + w + '-end', 'ordinary-' + w + '-end']).flat();
  check(r.samples.length === 9 && r.samples.map((s: any) => s.label).join(',') === phases.join(','), 'sample population');
  check(r.requests.length === 24 && r.windows.length === 3, 'request/window population');
  check(r.operations.length === 0 && r.cleanup.processIdentityPreserved === true &&
    r.cleanup.counterIdentityPreserved === true && !r.cleanup.error &&
    (r.inspector.openedByProbe ? r.cleanup.inspector.closed === true :
      r.cleanup.inspector.preservedPreexisting === true), 'unforced cleanup');
  let priorAt = time(r.startedAt), priorAllocation = 0;
  const mainIdentity = identity(r.samples[0].os), counterIdentity = identity(r.samples[0].counterOs);
  const data: any[] = [];
  for (const s of r.samples) {
    check(positive(time(s.at)) && time(s.at) > priorAt, 'sample ordering');
    priorAt = time(s.at);
    check(s.os.pid === r.pid && s.counterOs.pid === r.counterPid && s.pid === r.counterPid &&
      identity(s.os) === mainIdentity && identity(s.counterOs) === counterIdentity, 'stable sample identity');
    const rows = [s.os, ...s.descendants];
    check(s.descendants.length <= 64 && new Set(rows.map((x: any) => x.pid)).size === rows.length,
      'bounded unique census');
    const byPid = new Map<number, any>(rows.map((x: any) => [x.pid, x]));
    for (const row of rows) {
      check(Number.isInteger(row.pid) && row.pid > 0 && /^\d+$/.test(row.startTicks) &&
        sha(row.executableSha256) && positive(row.pssBytes) && positive(row.rssBytes) &&
        row.pssBytes <= row.rssBytes && nonnegative(row.anonymousBytes) &&
        sha(row.command.sha256), 'raw process measurement');
      if (row.pid === r.pid) continue;
      const seen = new Set([row.pid]); let parent = row.parentPid;
      while (parent !== r.pid) {
        check(!seen.has(parent) && byPid.has(parent), 'descendant ancestry');
        seen.add(parent); parent = byPid.get(parent).parentPid;
      }
    }
    check(s.os.command.script === r.bundle.argvEntry && s.counterOs.command.script === entry &&
      byPid.has(r.counterPid) && identity(byPid.get(r.counterPid)) === counterIdentity &&
      byPid.get(r.counterPid).pssBytes === s.counterOs.pssBytes &&
      s.counterOs.executableSha256 === s.os.executableSha256, 'counter raw-row correspondence');
    check(positive(s.memory.heapUsed) && positive(s.memory.heapTotal) && s.memory.heapUsed <= s.memory.heapTotal &&
      nonnegative(s.memory.external) && nonnegative(s.memory.arrayBuffers) &&
      s.memory.arrayBuffers <= s.memory.external && positive(s.heap.total_allocated_bytes) &&
      s.heap.total_allocated_bytes >= priorAllocation, 'V8 allocation measurement');
    priorAllocation = s.heap.total_allocated_bytes;
    check(s.heapSpaces.length > 0 && s.heapSpaces.every((x: any) => typeof x.space_name === 'string' &&
      nonnegative(x.space_used_size)) && nonnegative(s.heapCode.code_and_metadata_size), 'V8 component measurement');
    const f = s.hostFacts;
    check(f.cluster.isPrimary === true && f.cluster.isWorker === false &&
      f.backgroundWorkersOverride === 'disabled' && f.sidecarFlags.spawner === sibling &&
      ['substrate', 'gateway', 'embed', 'resourceHealth'].every(key => f.sidecarFlags[key] === false), 'raw runtime role');
    data.push({ label: s.label, pssBytes: s.counterOs.pssBytes, allocatedBytes: s.heap.total_allocated_bytes,
      observedPssBytes: rows.reduce((sum, x) => sum + x.pssBytes, 0),
      checkedProcesses: rows.length, notChecked: s.inventory.notChecked });
  }
  check(time(r.endedAt) >= priorAt, 'end fence');
  for (let w = 0; w < 3; w++) {
    const [a, b, c] = r.samples.slice(w * 3, w * 3 + 3), window = r.windows[w];
    check(window.window === w && time(b.at) - time(a.at) >= 2000 &&
      time(window.startedAt) >= time(b.at) && time(window.endedAt) >= time(c.at), 'idle/ordinary window timing');
    const requests = r.requests.filter((q: any) => q.window === w);
    check(requests.length === 8 && new Set(requests.map((q: any) => q.pair + ':' + q.index)).size === 8 &&
      requests.every((q: any) => Number.isInteger(q.pair) && q.pair >= 0 && q.pair < 4 &&
        (q.index === 0 || q.index === 1) && q.status === 200 && Number.isInteger(q.rows) &&
        q.rows >= 0 && q.rows <= 32 && positive(q.responseBytes) && sha(q.responseSha256) &&
        nonnegative(q.elapsedMs)), 'ordinary request coverage');
  }
  return { target: sibling ? 'maintained-spawner' : 'main', mainIdentity, counterIdentity, buildSha: r.buildSha,
    samples: data, windows: Array.from({ length: 3 }, (_, w) => ({ window: w,
      idlePssDeltaBytes: data[w * 3 + 1].pssBytes - data[w * 3].pssBytes,
      ordinaryPssDeltaBytes: data[w * 3 + 2].pssBytes - data[w * 3 + 1].pssBytes,
      idleAllocatedBytes: data[w * 3 + 1].allocatedBytes - data[w * 3].allocatedBytes,
      ordinaryAllocatedBytes: data[w * 3 + 2].allocatedBytes - data[w * 3 + 1].allocatedBytes })),
    allocationOwner: 'unknown', requestAssignment: 'unknown', physicalSavings: 'unmeasured',
    definition: 'Serial bounded raw PSS and cumulative V8 allocation observations; ambient workload uncontrolled.' };
}

// Join the CDP singleton IDs to the native graph from the SAME captured input.
// Direct parents are incoming edges, not dominators; neither parent nor class
// retained sizes may be summed to infer physical/native ownership.
const exactOwners = [
  '@papercusp/memory:host', '@papercusp/memory.local-embedder-worker',
  '@papercusp/operator-core.harnessCoreCaches', '@papercusp/operator-core.operatorCache',
  '@papercusp/operator-core.snapshot-fold-slots', '@papercusp/lexicon:host',
  '@papercusp/operator-core.repoCitationTrackingCache',
  '@papercusp/operator-core.agentsAcrossWorkspaceCache',
  '@papercusp/operator-core.midTurnMemoryAdmission',
];

function auditExactOwners(r: any) {
  const requireOwner = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 exact owner: ' + reason);
  };
  const natural = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
  const id = (x: unknown) => natural(x) && Number(x) > 0;
  const snapshot = r.heapSnapshot, graph = r.heapRetainers, binding = r.heapOwnerBinding;
  requireOwner(r.schemaVersion === 1 && r.mode === 'retainers' &&
    r.plane === 'isolated-current-build-operator-api' && r.incomplete === false &&
    r.runner?.status === 0 && r.runner.signal === null && !r.error, 'complete private run');
  requireOwner(id(r.pid) && [snapshot?.pid, graph?.pid, binding?.pid, r.inspector?.pid]
    .every(pid => pid === r.pid), 'PID correspondence');
  requireOwner(/^[a-f0-9]{7,40}$/.test(r.buildSha) && sha(r.bundleHash), 'recorded artifact identity');
  requireOwner(Array.isArray(r.samples) && r.samples.length > 1, 'process samples');
  let processIdentity = '';
  for (const sample of r.samples) {
    const rows = sample.processes?.filter((row: any) => row.pid === r.pid);
    requireOwner(sample.pid === r.pid && rows?.length === 1, 'unique sampled main');
    const row = rows[0];
    requireOwner(/^\d+$/.test(row.startTicks) && sha(row.executableSha256) &&
      positive(row.pssBytes) && positive(row.rssBytes) && row.pssBytes <= row.rssBytes, 'raw process identity');
    if (!processIdentity) processIdentity = identity(row);
    requireOwner(identity(row) === processIdentity, 'process reuse');
  }
  requireOwner(sha(snapshot.sha256) && id(snapshot.bytes) &&
    graph.native?.inputSha256 === snapshot.sha256 && graph.native.inputBytes === snapshot.bytes,
  'snapshot input correspondence');
  requireOwner(sha(graph.native.executableSha256) &&
    graph.native.executableSha256 === r.nativeAdapterPreflight?.sha256 &&
    r.nativeAdapterPreflight.version === 'papercusp-heap-retainers 0.1.0' &&
    graph.native.status === 0 && graph.native.signal === null &&
    graph.native.errorCode === null && graph.native.stderrBytes === 0 &&
    graph.upstreamRevision === '05edd8131a77790ab0e7bce2eedf5770d6bb83ae', 'native execution receipt');
  const census = snapshot.census;
  requireOwner(id(census?.nodeCount) && id(census.totalSelfSizeBytes) &&
    natural(graph.rootIndex) && graph.rootIndex < census.nodeCount, 'snapshot census bounds');
  const roots = binding.roots, nodes = graph.requestedNodes, limits = graph.limits;
  requireOwner(Array.isArray(roots) && roots.length === exactOwners.length &&
    new Set(roots.map((x: any) => x.owner)).size === exactOwners.length &&
    exactOwners.every(owner => roots.some((x: any) => x.owner === owner)), 'exact owner population');
  requireOwner(roots.every((x: any) => x.status === 'found' && id(x.id)) &&
    new Set(roots.map((x: any) => x.id)).size === roots.length, 'unique captured owner IDs');
  requireOwner(Array.isArray(nodes) && nodes.length === roots.length &&
    new Set(nodes.map((x: any) => x.id)).size === roots.length &&
    Array.isArray(limits?.objectIds) && limits.objectIds.length === roots.length &&
    roots.every((x: any, i: number) => limits.objectIds[i] === x.id), 'requested ID population');
  requireOwner(limits.retainerDepth === 1 && id(limits.maxRetainers) && limits.maxRetainers <= 100,
    'bounded direct parents');
  const nodeIndexes = new Set<number>();
  const validNode = (n: any) => n && id(n.id) && natural(n.index) && n.index < census.nodeCount &&
    natural(n.selfSizeBytes) && natural(n.retainedSizeBytes) &&
    n.retainedSizeBytes >= n.selfSizeBytes && n.retainedSizeBytes <= census.totalSelfSizeBytes;
  const owners = roots.map((owner: any) => {
    const requested = nodes.find((x: any) => x.id === owner.id), n = requested?.node;
    requireOwner(requested?.status === 'found' && n?.id === owner.id && validNode(n) &&
      !nodeIndexes.has(n.index), 'exact graph node join');
    nodeIndexes.add(n.index);
    requireOwner(Array.isArray(n.retainers) && natural(n.retainerCount) &&
      n.retainerCount >= n.retainers.length && n.retainers.length <= limits.maxRetainers &&
      typeof n.retainersTruncated === 'boolean' &&
      n.retainersTruncated === (n.retainerCount > n.retainers.length), 'retainer coverage');
    requireOwner(new Set(n.retainers.map((p: any) => p.index)).size === n.retainers.length &&
      n.retainers.every((p: any) => validNode(p) && p.index !== n.index &&
        p.index !== graph.rootIndex && p.retainsIndex === n.index &&
        ['Context', 'Property', 'Internal', 'Hidden', 'Element'].includes(p.edgeType)), 'essential incoming edges');
    return { owner: owner.owner, id: n.id, index: n.index, selfSizeBytes: n.selfSizeBytes,
      dominatorRetainedV8Bytes: n.retainedSizeBytes, observedDirectParentIndexes: n.retainers.map((p: any) => p.index),
      directParentsNotChecked: n.retainerCount - n.retainers.length };
  });
  requireOwner(r.hostReaped === true && r.snapshotRemoved === true &&
    r.postSnapshotRowsPreserved === true &&
    r.profilerOperations?.includes('v8.writeHeapSnapshot (forced GC/synchronous pause)') &&
    r.profilerOperations.includes('HeapProfiler.enable (object IDs)') &&
    r.profilerOperations.includes('HeapProfiler.disable (object IDs)'), 'qualified intervention and cleanup');
  return { processIdentity, recordedBuildSha: r.buildSha, snapshotSha256: snapshot.sha256, owners,
    scope: 'Historical private snapshot; no new runtime measurement.',
    definition: 'Per-node dominator-owned V8 self_size; incoming parents are not dominators. Never sum overlapping retained sizes.',
    nativePhysicalOwnership: 'unknown', productionSavings: 'unmeasured', loadedBuildIdentity: 'unknown' };
}

function ownerFixture(): any {
  const process = { pid: 7, startTicks: '10', executableSha256: 'a'.repeat(64), pssBytes: 100, rssBytes: 200 };
  const roots = exactOwners.map((owner, i) => ({ owner, status: 'found', id: 10 + i }));
  return { schemaVersion: 1, mode: 'retainers', plane: 'isolated-current-build-operator-api',
    incomplete: false, runner: { status: 0, signal: null }, pid: 7, buildSha: '12345678', bundleHash: 'b'.repeat(64),
    inspector: { pid: 7 }, samples: [0, 1].map(() => ({ pid: 7, processes: [structuredClone(process)] })),
    heapSnapshot: { pid: 7, bytes: 1000, sha256: 'c'.repeat(64), census: { nodeCount: 32, totalSelfSizeBytes: 1024 } },
    heapOwnerBinding: { pid: 7, roots },
    nativeAdapterPreflight: { sha256: 'd'.repeat(64), version: 'papercusp-heap-retainers 0.1.0' },
    heapRetainers: { pid: 7, rootIndex: 0, upstreamRevision: '05edd8131a77790ab0e7bce2eedf5770d6bb83ae',
      native: { executableSha256: 'd'.repeat(64), inputSha256: 'c'.repeat(64), inputBytes: 1000,
        status: 0, signal: null, errorCode: null, stderrBytes: 0 },
      limits: { objectIds: roots.map(x => x.id), retainerDepth: 1, maxRetainers: 32 },
      requestedNodes: roots.map((x, i) => ({ id: x.id, status: 'found', node: {
        id: x.id, index: i + 1, selfSizeBytes: 8, retainedSizeBytes: 16, retainerCount: 1,
        retainersTruncated: false, retainers: [{ id: 99, index: 20, selfSizeBytes: 64,
          retainedSizeBytes: 400, retainsIndex: i + 1, edgeType: 'Context' }] } })) },
    hostReaped: true, snapshotRemoved: true, postSnapshotRowsPreserved: true,
    profilerOperations: ['v8.writeHeapSnapshot (forced GC/synchronous pause)',
      'HeapProfiler.enable (object IDs)', 'HeapProfiler.disable (object IDs)'] };
}

// A tracked, deterministic fixture independently constructed from the reader contract.
function fixture(sibling = false): any {
  const main = { pid: 7, startTicks: '10', parentPid: 1, executableSha256: 'a'.repeat(64),
    pssBytes: 100, rssBytes: 200, anonymousBytes: 80,
    command: { sha256: 'b'.repeat(64), script: '/runtime/hono-host.mjs' } };
  const child = { ...structuredClone(main), pid: 8, startTicks: '11', parentPid: 7,
    command: { sha256: 'c'.repeat(64), script: '/runtime/spawner-sidecar.mjs' } };
  const loaded = { status: 'known', pid: 8, buildInfo: { sha: '12345678', version: '1' },
    serverGeneration: 'server', connectionId: 'connection' };
  const r: any = { schemaVersion: 1, plane: 'live-current-build-operator-api', incomplete: false,
    pid: 7, counterPid: sibling ? 8 : 7, buildSha: '12345678', startedAt: 1, endedAt: 10000,
    healthBefore: { sha: '12345678' }, healthAfter: { sha: '12345678' },
    bundle: { path: main.command.script, argvEntry: main.command.script,
      diskSha256: 'd'.repeat(64), diskSha256After: 'd'.repeat(64) },
    counterBundle: { path: sibling ? child.command.script : main.command.script,
      argvEntry: sibling ? child.command.script : main.command.script,
      diskSha256: 'e'.repeat(64), diskSha256After: 'e'.repeat(64),
      loadedBuild: loaded, loadedBuildAfter: structuredClone(loaded),
      socketBefore: { dev: 1, ino: 2 }, socketAfter: { dev: 1, ino: 2 } },
    limits: { windows: 3, idleMs: 2000, requestsPerWindow: 8, concurrency: 2, descendantsPerSample: 64 },
    operations: [], inspector: { openedByProbe: true },
    cleanup: { processIdentityPreserved: true, counterIdentityPreserved: true, inspector: { closed: true } },
    samples: [], windows: [], requests: [] };
  for (let w = 0; w < 3; w++) {
    for (let p = 0; p < 3; p++) r.samples.push({ label: ['idle-' + w + '-start', 'idle-' + w + '-end', 'ordinary-' + w + '-end'][p],
      at: 100 + w * 3000 + [0, 2000, 2500][p], pid: r.counterPid,
      os: structuredClone(main), counterOs: structuredClone(sibling ? child : main),
      descendants: sibling ? [structuredClone(child)] : [], inventory: { notChecked: [] },
      memory: { heapUsed: 50, heapTotal: 100, external: 10, arrayBuffers: 2 },
      heap: { total_allocated_bytes: 1000 + w * 300 + p * 100 },
      heapSpaces: [{ space_name: 'old_space', space_used_size: 50 }], heapCode: { code_and_metadata_size: 5 },
      hostFacts: { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'disabled',
        sidecarFlags: { spawner: sibling, substrate: false, gateway: false, embed: false, resourceHealth: false } } });
    r.windows.push({ window: w, startedAt: 2200 + w * 3000, endedAt: 2700 + w * 3000 });
    for (let pair = 0; pair < 4; pair++) for (let index = 0; index < 2; index++) r.requests.push({ window: w, pair, index,
      status: 200, rows: 32, responseBytes: 100, responseSha256: 'f'.repeat(64), elapsedMs: 1 });
  }
  return r;
}

describe('independent P011 baseline raw evidence', () => {
  it.each([false, true])('derives bounded resources from raw rows (sibling=%s)', sibling => {
    const result = auditBaseline(fixture(sibling));
    expect(result.samples).toHaveLength(9);
    expect(result.samples[0].observedPssBytes).toBe(sibling ? 200 : 100);
    expect(result.windows[0].ordinaryAllocatedBytes).toBe(100);
    expect(result.physicalSavings).toBe('unmeasured');
  });
  const corruptions: [string, (r: any) => void][] = [
    ['incomplete', r => { r.incomplete = true; }],
    ['health generation', r => { r.healthAfter.sha = 'ffffffff'; }],
    ['counter artifact', r => { r.counterBundle.diskSha256After = 'f'.repeat(64); }],
    ['sibling generation', r => { r.counterBundle.loadedBuildAfter.serverGeneration = 'replaced'; }],
    ['connection replaced', r => { r.counterBundle.loadedBuildAfter.connectionId = 'reconnected'; }],
    ['socket replaced', r => { r.counterBundle.socketAfter.ino++; }],
    ['PID reuse', r => { r.samples[1].counterOs.startTicks = '99'; }],
    ['ancestry', r => { r.samples[1].descendants[0].parentPid = 99; }],
    ['PSS missing', r => { delete r.samples[1].os.pssBytes; }],
    ['RSS substituted', r => { r.samples[1].os.pssBytes = r.samples[1].os.rssBytes + 1; }],
    ['allocation decreases', r => { r.samples[1].heap.total_allocated_bytes = 1; }],
    ['sample missing', r => { r.samples.pop(); }],
    ['short idle', r => { r.samples[1].at = 2000; }],
    ['ordinary missing', r => { r.requests.pop(); }],
    ['duplicate request', r => { r.requests[1] = structuredClone(r.requests[0]); }],
    ['failed HTTP', r => { r.requests[0].status = 500; }],
    ['forced operation', r => { r.operations.push('gc'); }],
    ['cleanup failure', r => { r.cleanup.inspector.closed = false; }],
    ['wrong runtime role', r => { r.samples[0].hostFacts.sidecarFlags.spawner = false; }],
  ];
  it.each(corruptions)('rejects corrupted %s evidence', (_name, corrupt) => {
    const r = fixture(true); corrupt(r); expect(() => auditBaseline(r)).toThrow('P011 baseline:');
  });
  it('ignores forged inventory totals and reduction headlines', () => {
    const r = fixture(true), before = auditBaseline(r);
    r.reductionPercent = 99;
    for (const s of r.samples) { s.inventory.observedPssBytes = 1; s.configuredHostRole = { allocationOwner: 'proven' }; }
    expect(auditBaseline(r)).toEqual(before);
  });
  it.runIf(Boolean(process.env.PAPERCUSP_P011_BASELINE_ORACLE_INPUTS))('audits fresh frozen main and sibling reports', () => {
    const paths: string[] = JSON.parse(process.env.PAPERCUSP_P011_BASELINE_ORACLE_INPUTS!);
    expect(paths).toHaveLength(2);
    const proofs = paths.map(path => {
      const bytes = readFileSync(resolve(root, path));
      return { path, sha256: digest(bytes), bytes: bytes.length, result: auditBaseline(JSON.parse(bytes.toString())) };
    });
    expect(proofs.map(x => x.result.target)).toEqual(['main', 'maintained-spawner']);
    expect(proofs[0].result.mainIdentity).toBe(proofs[1].result.mainIdentity);
    expect(proofs[0].result.buildSha).toBe(proofs[1].result.buildSha);
    const destination = process.env.PAPERCUSP_P011_BASELINE_ORACLE_REPORT;
    if (!destination) throw Error('Canonical oracle report required');
    writeFileSync(resolve(root, destination), serializeIdentitySafeJson({ schemaVersion: 'p011-baseline-independent-v1',
      proofs, independentOf: 'No emitter import or headline totals; raw OS/V8 rows, HTTP records and identity fences.',
      physicalSavings: 'unmeasured', allocationOwner: 'unknown', requestAssignment: 'unknown' }));
  });
});

describe('P011 independent exact singleton retained-owner evidence', () => {
  it('joins numeric object IDs rather than constructor labels or array position', () => {
    const r = ownerFixture(), before = auditExactOwners(r);
    r.heapRetainers.requestedNodes.reverse();
    expect(auditExactOwners(r)).toEqual(before);
    expect(before.owners).toHaveLength(9);
    expect(before.nativePhysicalOwnership).toBe('unknown');
    expect(before.loadedBuildIdentity).toBe('unknown');
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['foreign plane', r => { r.plane = 'live-current-build-operator-api'; }],
    ['binding PID', r => { r.heapOwnerBinding.pid++; }],
    ['snapshot PID', r => { r.heapSnapshot.pid++; }],
    ['graph PID', r => { r.heapRetainers.pid++; }],
    ['process reuse', r => { r.samples[1].processes[0].startTicks = '11'; }],
    ['duplicate sampled PID', r => { r.samples[0].processes.push(r.samples[0].processes[0]); }],
    ['RSS without PSS', r => { delete r.samples[0].processes[0].pssBytes; }],
    ['snapshot hash', r => { r.heapRetainers.native.inputSha256 = 'e'.repeat(64); }],
    ['snapshot bytes', r => { r.heapRetainers.native.inputBytes++; }],
    ['adapter bytes', r => { r.nativeAdapterPreflight.sha256 = 'e'.repeat(64); }],
    ['native failure', r => { r.heapRetainers.native.status = 1; }],
    ['unknown upstream', r => { r.heapRetainers.upstreamRevision = 'unknown'; }],
    ['missing owner', r => { r.heapOwnerBinding.roots.pop(); }],
    ['duplicate owner name', r => { r.heapOwnerBinding.roots[1].owner = r.heapOwnerBinding.roots[0].owner; }],
    ['missing captured ID', r => { r.heapOwnerBinding.roots[0].status = 'not-in-snapshot'; }],
    ['duplicate captured ID', r => { r.heapOwnerBinding.roots[1].id = r.heapOwnerBinding.roots[0].id; }],
    ['wrong requested IDs', r => { r.heapRetainers.limits.objectIds[0]++; }],
    ['missing requested node', r => { r.heapRetainers.requestedNodes.pop(); }],
    ['duplicate requested node', r => { r.heapRetainers.requestedNodes[1] = r.heapRetainers.requestedNodes[0]; }],
    ['constructor-only join', r => { r.heapRetainers.requestedNodes[0].node.id++; }],
    ['duplicate graph index', r => { r.heapRetainers.requestedNodes[1].node.index = 1; }],
    ['out-of-range index', r => { r.heapRetainers.requestedNodes[0].node.index = 32; }],
    ['unsafe bytes', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['retained below self', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = 1; }],
    ['retained above snapshot', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = 2048; }],
    ['wrong incoming target', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].retainsIndex++; }],
    ['weak edge', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].edgeType = 'Weak'; }],
    ['root parent', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].index = 0; }],
    ['duplicate incoming parent', r => { const n = r.heapRetainers.requestedNodes[0].node; n.retainers.push(n.retainers[0]); n.retainerCount++; }],
    ['hidden truncated parents', r => { r.heapRetainers.requestedNodes[0].node.retainerCount++; }],
    ['snapshot left behind', r => { r.snapshotRemoved = false; }],
    ['useful rows changed', r => { r.postSnapshotRowsPreserved = false; }],
    ['profiler intervention omitted', r => { r.profilerOperations = []; }],
  ];
  it.each(corruptions)('rejects corrupted %s evidence', (_name, corrupt) => {
    const r = ownerFixture(); corrupt(r);
    expect(() => auditExactOwners(r)).toThrow('P011 exact owner:');
  });
  it('does not sum shared parents or trust retained/native total headlines', () => {
    const r = ownerFixture(), before = auditExactOwners(r);
    r.nativeBytes = 999999; r.heapRetainers.retainedSizeBytes = 999999;
    r.heapRetainers.groups = [{ class: 'Object', retainedSizeBytes: 999999 }];
    expect(auditExactOwners(r)).toEqual(before);
    expect(before).not.toHaveProperty('totalRetainedBytes');
    expect(before.owners.every((x: any) => x.observedDirectParentIndexes[0] === 20)).toBe(true);
  });
  it('preserves an explicitly bounded incomplete direct-parent census', () => {
    const r = ownerFixture(), n = r.heapRetainers.requestedNodes[0].node;
    n.retainerCount = 2; n.retainersTruncated = true;
    expect(auditExactOwners(r).owners[0].directParentsNotChecked).toBe(1);
  });
  it('audits the tracked historical exact-owner artifact without replaying its producer', () => {
    const path = 'docs/evidence/papercusp-oct1-p011-exact-owner-retainers-r1-2026-10-02.json';
    const bytes = readFileSync(resolve(root, path));
    expect(digest(bytes)).toBe('283cd13234d20676fc29a85bf883c21b607f099da449c404ca3c1ece7f4bd235');
    const result = auditExactOwners(JSON.parse(bytes.toString()));
    expect(result.owners.map((x: any) => x.owner)).toEqual(exactOwners);
    expect(result.owners.find((x: any) => x.owner.endsWith('.operatorCache'))?.dominatorRetainedV8Bytes).toBe(1328);
    const destination = process.env.PAPERCUSP_P011_OWNER_ORACLE_REPORT;
    if (destination) writeFileSync(resolve(root, destination), serializeIdentitySafeJson({
      schemaVersion: 'p011-exact-owner-independent-v1',
      proof: { path, sha256: digest(bytes), bytes: bytes.length, result },
      independentOf: 'No producer import, constructor-label join or class/parent aggregate retained total.',
      limitations: ['Saved private snapshot forced GC and pause; no new live acceptance.',
        'Exact singleton IDs identify graph nodes, not historical PostgreSQL initiating calls.',
        'Dominator-owned V8 bytes do not establish native physical allocation or production savings.'],
    }));
  });
});
