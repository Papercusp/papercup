/**
 * The census du walk survives the caller that started it (WI-6554700010009855): real du,
 * real processes, real files. A caller that stops waiting stands in for a bg-host restart
 * mid-walk; the next caller must ADOPT the still-running walk rather than start a second
 * one, and a walk killed mid-run must be relaunched rather than read as a result.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runDuTree } from './disk-consumer-census';
import { devToMajorMinor } from './usage';
import {
  DetachedWalkAbandoned,
  readWalkState,
  readUsageOutputEvidence,
  readCensusEndpointReceipt,
  censusEndpointReceiptSchema,
  writeCensusEndpointEnvelope,
  readCensusEndpointEnvelope,
  censusEndpointEnvelopeNote,
  pruneCensusWalks,
  runDetachedDuWalk,
  runDetachedDuUsage,
  TIMEOUT_EXIT_STATUS,
  walkAttemptFiles,
  walkProcessAlive,
  usageAttemptFiles,
  type WalkLauncher,
  type CensusEndpointRequest,
  type CensusEndpointCandidate,
} from './disk-census-detached-walk';

const linux = process.platform === 'linux';
let base: string;
let tree: string;
const floorBytes = 1;
const maxDepth = 2;

/** stdio ignored, so the walk holds no pipe to this process and keeps running after we stop waiting. */
function countingLauncher(): { launch: WalkLauncher; launches: number[] } {
  const launches: number[] = [];
  const launch: WalkLauncher = async (cmd, args, meta) => {
    launches.push(meta.attempt);
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    if (child.pid == null) throw new Error('no pid');
    return { pid: child.pid, taskId: null, confined: true };
  };
  return { launch, launches };
}

/** du that waits `seconds` before walking, so a test can act mid-walk. */
const slowDu = (seconds: number) => (duArgs: string[]): [string, string[]] => [
  'sh',
  ['-c', `sleep ${seconds}; exec du "$@"`, 'slow-du', ...duArgs],
];

async function waitUntil(pred: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'census-walk-int-'));
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(base, 'pins'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(base, 'mutexes'));
  tree = join(base, 'tree');
  for (const [rel, kb] of [
    ['a/one.bin', 64],
    ['a/b/two.bin', 128],
    ['c/three.bin', 32],
  ] as const) {
    const path = join(tree, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(kb * 1024, 7));
  }
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.skipIf(!linux)('detached census walk (real du, real processes)', () => {
  function endpointRequest(): CensusEndpointRequest {
    return { parentRunId: randomUUID(), host: hostname(), device: base,
      majorMinor: devToMajorMinor(lstatSync(base).dev), producerBuildSha: 'a'.repeat(40) };
  }

  it.each([65535, 65536, 65537])('preserves the full population when the embedded envelope would be %i bytes', async target => {
    const dir = join(base, `envelope-boundary-${target}`), parentRunId = randomUUID();
    let length = target, envelope!: Awaited<ReturnType<typeof writeCensusEndpointEnvelope>>, expected = 0;
    for (let i = 0; i < 4; i++) {
      envelope = await writeCensusEndpointEnvelope([{ consumer: tree,
        endpoint: { status: 'unknown', reason: 'x'.repeat(length) } }], { dir, parentRunId });
      const population = JSON.parse(readFileSync(envelope.source.path, 'utf8'));
      expected = Buffer.byteLength(censusEndpointEnvelopeNote({ ...envelope, embedded: 1, omitted: 0, records: population.rows }));
      if (expected === target) break;
      length += target - expected;
    }
    expect(expected).toBe(target);
    expect(envelope.embedded).toBe(target <= 65536 ? 1 : 0);
    expect(envelope.omitted).toBe(target <= 65536 ? 0 : 1);
    expect(Buffer.byteLength(censusEndpointEnvelopeNote(envelope))).toBeLessThanOrEqual(65536);
    const recovered = await readCensusEndpointEnvelope(censusEndpointEnvelopeNote(envelope));
    expect(recovered.status).toBe('verified');
    if (recovered.status !== 'verified') throw new Error(JSON.stringify(recovered));
    expect(recovered.rows).toHaveLength(1); expect(recovered.pages).toBeGreaterThan(1);
    expect(recovered.rows[0]!.candidate.endpoint).toEqual({ status: 'unknown', reason: 'x'.repeat(length) });
  });

  it('rejects an oversized identity intact and returns its complete source and explicit disposition', async () => {
    const consumer = '/' + 'a'.repeat(70000);
    const envelope = await writeCensusEndpointEnvelope([{ consumer, endpoint: { status: 'unknown', reason: 'unmeasured' } }],
      { dir: join(base, 'envelope-oversized'), parentRunId: randomUUID() });
    expect(envelope).toMatchObject({ total: 1, embedded: 0, omitted: 1, rejected: 1 });
    const recovered = await readCensusEndpointEnvelope(censusEndpointEnvelopeNote(envelope));
    expect(recovered.status).toBe('verified');
    if (recovered.status !== 'verified') throw new Error(JSON.stringify(recovered));
    expect(recovered.rows[0]).toMatchObject({ disposition: 'record-over-budget', candidate: { consumer } });
  });

  it('pins a complete population through the existing prune lifecycle for the replay retention window', async () => {
    const root = join(base, 'envelope-prune'), dir = join(root, 'slot'), now = Date.now();
    const envelope = await writeCensusEndpointEnvelope([{ consumer: tree, endpoint: { status: 'unknown', reason: 'unmeasured' } }],
      { dir, parentRunId: randomUUID(), now });
    await pruneCensusWalks({ root, now: now + 3 * 86400_000, keepMs: 0 });
    expect((await readCensusEndpointEnvelope(censusEndpointEnvelopeNote(envelope))).status).toBe('verified');
    await pruneCensusWalks({ root, now: now + 31 * 86400_000, keepMs: 0 });
    expect((await readCensusEndpointEnvelope(censusEndpointEnvelopeNote(envelope))).status).toBe('unknown');
  });

  it('recovers a decisive late endpoint through many pages and preserves ordering across permutations and fresh processes', async () => {
    const request = endpointRequest(), { launch } = countingLauncher();
    const run = await runDetachedDuUsage([tree], { dir: join(base, 'envelope-certified'), launch, pollMs: 25, endpoint: request });
    if (run.endpoint?.status !== 'certified') throw new Error(JSON.stringify(run));
    const unknown: CensusEndpointCandidate[] = Array.from({ length: 101 }, (_, i) => ({
      consumer: join(base, `a-candidate-${String(i).padStart(3, '0')}`), endpoint: { status: 'unknown', reason: 'x'.repeat(2000) } }));
    const full = [...unknown, { consumer: tree, endpoint: run.endpoint }];
    let firstRows: unknown;
    for (const candidates of [full, [...full].reverse()]) {
      const envelope = await writeCensusEndpointEnvelope(candidates, { dir: join(base, randomUUID()), parentRunId: request.parentRunId });
      expect(envelope.total).toBe(102); expect(envelope.omitted).toBeGreaterThan(0);
      expect(envelope.records.some(row => row.candidate.consumer === tree)).toBe(false);
      const note = `du walked unprivileged (sudo -n unavailable); ${censusEndpointEnvelopeNote(envelope)}`;
      const recovered = await readCensusEndpointEnvelope(note);
      if (recovered.status !== 'verified') throw new Error(JSON.stringify(recovered));
      expect(recovered.pages).toBeGreaterThan(40);
      expect(recovered.rows.at(-1)?.candidate.endpoint.status).toBe('certified');
      if (firstRows) expect(recovered.rows).toEqual(firstRows); else firstRows = recovered.rows;
      const script = join(base, 'envelope-recovery.mts');
      writeFileSync(script, `import { readCensusEndpointEnvelope } from ${JSON.stringify(new URL('./disk-census-detached-walk.ts', import.meta.url).href)};
const result = await readCensusEndpointEnvelope(process.argv[2]);
console.log(JSON.stringify(result.status === 'verified' ? { status: result.status, rows: result.rows.length, last: result.rows.at(-1).candidate.consumer } : result));`);
      expect(JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', script, note], { encoding: 'utf8' })))
        .toEqual({ status: 'verified', rows: 102, last: tree });
      rmSync(envelope.source.path);
      const missing = await readCensusEndpointEnvelope(note);
      expect(missing).toMatchObject({ status: 'unknown', resync: 'request-new-census-population' });
    }
  }, 30_000);

  it('refuses changed, malformed, duplicate and legacy envelopes instead of trusting an embedded prefix', async () => {
    const envelope = await writeCensusEndpointEnvelope([{ consumer: tree, endpoint: { status: 'unknown', reason: 'unmeasured' } }],
      { dir: join(base, 'envelope-damage'), parentRunId: randomUUID() });
    const note = censusEndpointEnvelopeNote(envelope), bytes = readFileSync(envelope.source.path);
    const changed = Buffer.from(bytes); changed[changed.length - 2] = 32; writeFileSync(envelope.source.path, changed);
    for (const bad of [note, null, 'legacy; failure-coverage:bogus', note + '; ' + note,
      note.replace('census-endpoints:', 'census-endpoints:%xx')])
      expect(await readCensusEndpointEnvelope(bad)).toMatchObject({ status: 'unknown', resync: 'request-new-census-population' });
  });

  it('certifies a singleton with exact clocks, visibility, generation, accounting and pinned raw custody', async () => {
    const request = endpointRequest(), dir = join(base, 'certified-singleton'), { launch, launches } = countingLauncher();
    const run = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25, endpoint: request });
    expect(run.complete).toBe(true);
    expect(run.endpoint?.status).toBe('certified');
    if (run.endpoint?.status !== 'certified') throw new Error(JSON.stringify(run));
    const receipt = run.endpoint.receipt;
    expect(receipt).toMatchObject({ version: 1, request, consumer: tree, rootBytes: run.bytes?.get(tree),
      classificationComplete: true, snapshot: false, additive: false,
      context: { singleton: true, accounting: 'unique-inode-allocation', floorBytes: 0, depth: 'all',
        host: hostname(), uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!() } });
    expect(receipt.context.ancestors.map(p => p.path)).toEqual([base, tree]);
    expect(receipt.context.argv).toContain(receipt.context.du);
    expect(receipt.finishedAt).toBeGreaterThanOrEqual(receipt.startedAt);
    const state = (await readWalkState(dir))!;
    const recoveryScript = join(base, 'endpoint-recovery.mts');
    writeFileSync(recoveryScript, `import { readCensusEndpointReceipt } from ${JSON.stringify(new URL('./disk-census-detached-walk.ts', import.meta.url).href)};
const [dir, state, request, source] = JSON.parse(process.argv[2]);
console.log(JSON.stringify(await readCensusEndpointReceipt(dir, state, request, source)));`);
    // A fresh reader recovers the pinned endpoint without launching or consulting
    // mutable caller state. Its raw source remains valid after slot retirement.
    rmSync(dir, { recursive: true });
    expect(await readCensusEndpointReceipt(dir, state, request, run.endpoint.source)).toEqual(run.endpoint);
    expect(JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', recoveryScript,
      JSON.stringify([dir, state, request, run.endpoint.source])], { encoding: 'utf8' }))).toEqual(run.endpoint);
    expect(launches).toEqual([1]);
    for (const source of [receipt.stdout, receipt.stderr, run.endpoint.source]) {
      const raw = readFileSync(source.path);
      expect(raw.length).toBe(source.byteCount);
      expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256);
    }
  });

  it.each(['population', 'command', 'sudo', 'version', 'identity'])('refuses %s rather than certifying a non-singleton or substituted producer', async fault => {
    const request = endpointRequest(), dir = join(base, `endpoint-refuse-${fault}`), { launch, launches } = countingLauncher();
    const roots = fault === 'population' ? [join(tree, 'a'), join(tree, 'c')] : [tree];
    const endpoint = fault === 'version' ? { ...request, version: 2 } : fault === 'identity' ? { ...request, parentRunId: 'shortened' } : request;
    await expect(runDetachedDuUsage(roots, { dir, launch, endpoint: endpoint as CensusEndpointRequest,
      ...(fault === 'command' ? { command: slowDu(0) } : {}), ...(fault === 'sudo' ? { sudo: '/usr/bin/sudo' } : {}) })).rejects.toThrow();
    expect(launches).toEqual([]);
  });

  it.each(['host', 'device'])('keeps a mismatched %s UNKNOWN with recoverable source', async mismatch => {
    const request = endpointRequest(), { launch } = countingLauncher();
    const endpoint = mismatch === 'host' ? { ...request, host: 'another-host' } : { ...request, majorMinor: '999:999' };
    const run = await runDetachedDuUsage([tree], { dir: join(base, `endpoint-mismatch-${mismatch}`), launch, pollMs: 25, endpoint });
    expect(run.complete).toBe(false); expect(run.bytes).toBeNull();
    expect(run.endpoint?.status).toBe('unknown'); expect(run.output.status).toBe('verified');
  });

  it('rejects unknown versions, fields, generations and terminal changes while preserving the original pinned receipt', async () => {
    const request = endpointRequest(), dir = join(base, 'endpoint-strict'), { launch } = countingLauncher();
    const run = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25, endpoint: request });
    if (run.endpoint?.status !== 'certified') throw new Error(JSON.stringify(run));
    const receipt = run.endpoint.receipt;
    for (const bad of [{ ...receipt, version: 2 }, { ...receipt, unexpected: true },
      { ...receipt, exitCode: 1 }, { ...receipt, diagnosticsBytes: 1 },
      { ...receipt, context: { ...receipt.context, singleton: false } },
      { ...receipt, context: { ...receipt.context, mounts: [] } },
      { ...receipt, context: { ...receipt.context, ancestors: receipt.context.ancestors.map(p => ({ ...p, birthNs: '0' })) } }]) {
      expect(censusEndpointReceiptSchema.safeParse(bad).success).toBe(false);
    }
    const state = (await readWalkState(dir))!;
    const path = run.endpoint.source.path, terminal = JSON.parse(readFileSync(path, 'utf8'));
    terminal.endpoint.rootBytes++;
    writeFileSync(path, JSON.stringify(terminal));
    const read = await readCensusEndpointReceipt(dir, state, request, run.endpoint.source);
    expect(read.status).toBe('unknown');
    if (read.status === 'unknown') expect(read.reason).toContain('resync required');
  });

  it('independently counts cross-consumer links under both traversal orders and excludes link-only growth within a consumer', async () => {
    const left = join(base, 'endpoint-link-left'), right = join(base, 'endpoint-link-right');
    mkdirSync(left); mkdirSync(right); writeFileSync(join(left, 'original'), Buffer.alloc(128 * 1024, 9));
    linkSync(join(left, 'original'), join(right, 'shared'));
    const { launch } = countingLauncher();
    for (const roots of [[left, right], [right, left]]) {
      for (const root of roots) {
        const run = await runDetachedDuUsage([root], { dir: join(base, randomUUID()), launch, pollMs: 25, endpoint: endpointRequest() });
        expect(run.endpoint?.status).toBe('certified');
        const expected = Number(execFileSync('du', ['-sxB1', root], { encoding: 'utf8' }).split('\t')[0]);
        expect(run.bytes?.get(root)).toBe(expected);
      }
    }
    const before = await runDetachedDuUsage([left], { dir: join(base, randomUUID()), launch, pollMs: 25, endpoint: endpointRequest() });
    linkSync(join(left, 'original'), join(left, 'another-name'));
    const after = await runDetachedDuUsage([left], { dir: join(base, randomUUID()), launch, pollMs: 25, endpoint: endpointRequest() });
    expect(after.bytes?.get(left)).toBe(before.bytes?.get(left));
    const countLinks = Number(execFileSync('du', ['-slxB1', left], { encoding: 'utf8' }).split('\t')[0]);
    expect(countLinks).toBeGreaterThan(after.bytes!.get(left)!);
  });

  it.each([0, 7, TIMEOUT_EXIT_STATUS])('propagates walk exit %i to the managed scope as well as its durable receipt', async (exitCode) => {
    let scopeExit!: Promise<number | null>;
    const launch: WalkLauncher = async (cmd, args) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      scopeExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (child.pid == null) throw new Error('no pid');
      return { pid: child.pid, taskId: null, confined: true };
    };
    const dir = join(base, `scope-exit-${exitCode}`);
    const run = await runDetachedDuWalk(tree, {
      dir, launch, pollMs: 25,
      command: () => ['sh', ['-c', 'printf "1\\t%s\\0" "$1"; exit "$2"', 'walk-exit', tree, String(exitCode)]],
    });
    expect(run.exitCode).toBe(exitCode);
    expect(readFileSync(walkAttemptFiles(dir, 1).exit, 'utf8').trim()).toBe(String(exitCode));
    expect(await scopeExit).toBe(exitCode);
  });

  it('fails the managed scope when a successful walk cannot persist its exit receipt', async () => {
    let scopeExit!: Promise<number | null>;
    const launch: WalkLauncher = async (cmd, args, meta) => {
      mkdirSync(walkAttemptFiles(meta.dir, meta.attempt).exit + '.part');
      const child = spawn(cmd, args, { stdio: 'ignore' });
      scopeExit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (child.pid == null) throw new Error('no pid');
      return { pid: child.pid, taskId: null, confined: true };
    };
    const run = await runDetachedDuWalk(tree, {
      dir: join(base, 'scope-receipt-failure'), launch, pollMs: 25, maxAttempts: 1,
      command: () => ['sh', ['-c', 'exit 0']],
    });
    expect(run.exitCode).toBeNull();
    expect(run.error).toContain('without an exit status');
    expect(await scopeExit).toBe(125);
  });

  it('preserves ordered hardlink allocation, projecting totals while retaining complete source', async () => {
    const roots = [join(base, 'usage pinned'), join(base, 'usage\nevictable')];
    roots.forEach(root => mkdirSync(root));
    writeFileSync(join(roots[0]!, 'shared'), Buffer.alloc(128 * 1024, 7));
    linkSync(join(roots[0]!, 'shared'), join(roots[1]!, 'shared'));
    for (let i = 0; i < 300; i++) writeFileSync(join(roots[1]!, `f${i}`), 'x');
    const reference = execFileSync('du', ['--summarize', '--one-file-system', '--block-size=1', '--null', '--', ...roots], { encoding: 'utf8' });
    const expected = new Map(reference.split('\0').filter(Boolean).map(row => {
      const tab = row.indexOf('\t'); return [row.slice(tab + 1), Number(row.slice(0, tab))] as const;
    }));
    const dir = join(base, 'usage-totals'), { launch, launches } = countingLauncher();
    const run = await runDetachedDuUsage(roots, { dir, launch, pollMs: 25 });
    expect(run.complete).toBe(true);
    expect(run.bytes).toEqual(expected);
    expect(launches).toEqual([1]);
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    const output = readFileSync(walkAttemptFiles(dir, 1).out, 'utf8');
    expect(output.split('\0').filter(Boolean)).toHaveLength(2);
    expect(output).not.toContain('/f299');
    expect(run.output.status).toBe('verified');
    const raw = readFileSync(run.output.stdout!.path);
    expect(raw.toString()).toContain('/f299');
    expect(run.output.stdout).toMatchObject({ byteCount: raw.length, sha256: createHash('sha256').update(raw).digest('hex') });
    expect(run.output.stderr?.byteCount).toBe(0);
    const progress = JSON.parse(readFileSync(join(dir, 'usage-progress.json'), 'utf8'));
    expect(progress.metadataRecords).toBeGreaterThan(300);
    expect(progress.completedRoots).toBe(2);
    expect(progress.error).toBeNull();
    // Reversing roots changes who owns the shared allocation and cannot adopt
    // this result, nor start a parallel process in its directory.
    await expect(runDetachedDuUsage([...roots].reverse(), { dir, launch })).rejects.toThrow('request changed');
    expect(launches).toEqual([1]);
  });

  it('resumes a usage scan after its caller budget expires, without replaying the population', async () => {
    const dir = join(base, 'usage-adopt'), first = countingLauncher();
    const ctl = new AbortController();
    await expect(runDetachedDuUsage([tree], {
      dir, launch: async (...args) => {
        const result = await first.launch(...args); ctl.abort(); return result;
      }, command: slowDu(1), pollMs: 25, signal: ctl.signal,
    })).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = (await readWalkState(dir))!;
    expect(walkProcessAlive(state)).toBe(true);
    const second = countingLauncher();
    const addedRoot = join(base, 'usage-added'); mkdirSync(addedRoot);
    await expect(runDetachedDuUsage([tree, addedRoot], { dir, launch: second.launch })).rejects.toThrow('request changed');
    expect(second.launches).toEqual([]);
    const run = await runDetachedDuUsage([tree], { dir, launch: second.launch, pollMs: 25 });
    expect(run.complete).toBe(true);
    expect(run.bytes?.get(tree)).toBeGreaterThan(0);
    expect(first.launches).toEqual([1]);
    expect(second.launches).toEqual([]);
    expect((await readWalkState(dir))?.adoptions).toBe(1);
    expect(run.output.status).toBe('verified');
    expect(run.output.attemptKey).toBe(state.attemptKey);
    expect(readFileSync(run.output.stdout!.path, 'utf8')).toContain(tree);
  });

  it.each([4095, 4096, 4097, 16_385])('recovers all %i diagnostic bytes, including binary and early/late evidence, across fresh page readers', async size => {
    const diagnostic = Buffer.alloc(size, 120);
    Buffer.from('early\0\xff').copy(diagnostic);
    Buffer.from('\xf0\x9f\x8c\x8dlate', 'latin1').copy(diagnostic, size - 8);
    const dir = join(base, `raw-stderr-${size}`), { launch, launches } = countingLauncher();
    const stdout = Buffer.from(`7\t${tree}\0`);
    const run = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25,
      command: () => [process.execPath, ['-e',
        'process.stdout.write(Buffer.from(process.argv[1],"base64")); process.stderr.write(Buffer.from(process.argv[2],"base64"));',
        stdout.toString('base64'), diagnostic.toString('base64')]],
    });
    expect(run.complete).toBe(false); expect(run.bytes).toBeNull();
    expect(run.output.status).toBe('verified');
    const reference = run.output.stderr!;
    expect(reference.byteCount).toBe(size);
    const pages: Buffer[] = [];
    for (let offset = 0; offset < reference.byteCount!;) {
      // Reopen at every page, as a fresh continuation using capability:read does.
      const fd = openSync(reference.path, 'r'), page = Buffer.alloc(4096);
      try {
        const n = readSync(fd, page, 0, page.length, offset);
        expect(n).toBeGreaterThan(0); pages.push(page.subarray(0, n)); offset += n;
      } finally { closeSync(fd); }
    }
    const recovered = Buffer.concat(pages);
    expect(recovered).toEqual(diagnostic);
    expect(createHash('sha256').update(recovered).digest('hex')).toBe(reference.sha256);
    const second = await runDetachedDuUsage([tree], { dir, launch });
    expect(second.output).toEqual(run.output); expect(launches).toEqual([1]);
  });

  it.each([65535, 65536, 65537])('retains the entire %i-byte semantic record across split UTF8/NUL and the record boundary', async length => {
    const prefix = `1\t${tree}/`;
    const record = prefix + 'x'.repeat(length - Buffer.byteLength(prefix) - Buffer.byteLength('🌍')) + '🌍';
    const raw = Buffer.from(`${record}\0` + `7\t${tree}\0`);
    const dir = join(base, `raw-record-${length}`), { launch } = countingLauncher();
    // Split in the multibyte character and before the record delimiter.
    const split = Buffer.byteLength(record) - 2;
    const run = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25,
      command: () => [process.execPath, ['-e',
        'const b=Buffer.from(process.argv[1],"base64"), n=Number(process.argv[2]); process.stdout.write(b.subarray(0,n)); setTimeout(()=>process.stdout.write(b.subarray(n)),20);',
        raw.toString('base64'), String(split)]],
    });
    expect(run.complete).toBe(length <= 65536);
    expect(run.output.status).toBe('verified');
    expect(readFileSync(run.output.stdout!.path)).toEqual(raw);
    expect(run.output.stdout!.byteCount).toBe(raw.length);
    if (length <= 65536) {
      const progress = JSON.parse(readFileSync(join(dir, 'usage-progress.json'), 'utf8'));
      expect(progress.lastMetadataPath).toBe(tree);
      expect(run.bytes).toEqual(new Map([[tree, 7]]));
    } else expect(run.bytes).toBeNull();
  });

  it.each(['missing', 'same-size-edit', 'replacement', 'manifest', 'capture-failed'])('returns UNKNOWN/resync after %s source damage without launching another scan', async damage => {
    const dir = join(base, `raw-damage-${damage}`), { launch, launches } = countingLauncher();
    const run = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25 });
    expect(run.complete).toBe(true);
    const rawPath = run.output.stdout!.path;
    if (damage === 'missing') rmSync(rawPath);
    else if (damage === 'same-size-edit') {
      const raw = readFileSync(rawPath); raw[0] = raw[0] === 49 ? 50 : 49; writeFileSync(rawPath, raw);
    } else if (damage === 'replacement') {
      const raw = readFileSync(rawPath); rmSync(rawPath); writeFileSync(rawPath, raw);
    } else if (damage === 'manifest') rmSync(run.output.manifestPath!);
    else {
      const manifest = JSON.parse(readFileSync(run.output.manifestPath!, 'utf8'));
      manifest.captureComplete = false; writeFileSync(run.output.manifestPath!, JSON.stringify(manifest));
    }
    const adopted = await runDetachedDuUsage([tree], { dir, launch });
    expect(adopted.complete).toBe(false); expect(adopted.bytes).toBeNull();
    expect(adopted.output.status).toBe('unknown'); expect(adopted.output.error).toContain('resync required');
    expect(adopted.output.restart).toContain('fresh measurement'); expect(launches).toEqual([1]);
  });

  it('keeps immutable evidence recoverable when a consumed slot is removed and reused', async () => {
    const dir = join(base, 'raw-slot-lifecycle'), { launch } = countingLauncher();
    const first = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25 });
    const oldState = (await readWalkState(dir))!;
    const raw = readFileSync(first.output.stdout!.path);
    rmSync(dir, { recursive: true });
    const second = await runDetachedDuUsage([tree], { dir, launch, pollMs: 25 });
    expect(second.output.attemptKey).not.toBe(first.output.attemptKey);
    expect(readFileSync(first.output.stdout!.path)).toEqual(raw);
    expect(await readUsageOutputEvidence(dir, oldState)).toEqual(first.output);
    expect(usageAttemptFiles(dir, oldState.attemptKey!).stdout).toBe(first.output.stdout!.path);
  });

  it('refuses a capture-open failure before starting du and exposes UNKNOWN recovery', async () => {
    const dir = join(base, 'raw-open-failure'), marker = join(base, 'must-not-run-du');
    const { launch } = countingLauncher();
    const run = await runDetachedDuUsage([tree], { dir, pollMs: 25,
      launch: async (cmd, args, meta) => {
        const state = (await readWalkState(dir))!;
        const files = usageAttemptFiles(dir, state.attemptKey!);
        mkdirSync(files.stdout, { recursive: true });
        return launch(cmd, args, meta);
      },
      command: () => ['sh', ['-c', 'touch "$1"', 'capture-must-precede-command', marker]],
    });
    expect(run.complete).toBe(false); expect(run.bytes).toBeNull();
    expect(run.output.status).toBe('unknown');
    expect(run.output.error).toContain('resync required');
    expect(() => readFileSync(marker)).toThrow();
  });

  it('adopts a managed usage scan after more than 10s without metadata and keeps its heartbeat', async () => {
    const dir = join(base, 'usage-quiet-adopt'), first = countingLauncher();
    const ctl = new AbortController();
    const release = join(base, 'release-quiet-usage');
    const command = () => ['sh', ['-c', 'while [ ! -f "$2" ]; do sleep 0.1; done; printf "7\\t%s\\0" "$1"',
      'quiet-du', tree, release]] as [string, string[]];
    await expect(runDetachedDuUsage([tree], {
      dir, launch: async (...args) => {
        const result = await first.launch(...args); ctl.abort(); return result;
      }, command, pollMs: 25, timeoutMs: 30_000, signal: ctl.signal,
    })).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = (await readWalkState(dir))!;
    expect(walkProcessAlive(state)).toBe(true);

    const second = countingLauncher();
    const adopted = runDetachedDuUsage([tree], { dir, launch: second.launch, command, pollMs: 25, timeoutMs: 30_000 });
    try {
      // A fixed sleep can read a periodic heartbeat from before the threshold;
      // keep metadata gated until the required heartbeat actually exists.
      await vi.waitFor(() => {
        const progress = JSON.parse(readFileSync(join(dir, 'usage-progress.json'), 'utf8'));
        expect(progress.heartbeatAt - progress.startedAt).toBeGreaterThanOrEqual(10_000);
      }, { timeout: 15_000, interval: 100 });
      const progress = JSON.parse(readFileSync(join(dir, 'usage-progress.json'), 'utf8'));
      expect(progress.metadataRecords).toBe(0);
      expect(progress.lastMetadataAt).toBeNull();
      expect(progress.error).toBeNull();
      expect(walkProcessAlive(state)).toBe(true);
      writeFileSync(release, '');
      const run = await adopted;
      expect(run.complete).toBe(true);
      expect(run.bytes).toEqual(new Map([[tree, 7]]));
      expect(first.launches).toEqual([1]);
      expect(second.launches).toEqual([]);
      expect((await readWalkState(dir))?.adoptions).toBe(1);
    } finally {
      writeFileSync(release, '');
      await adopted.catch(() => {});
    }
  }, 25_000);

  it('keeps cap bytes unknown after failed, partial, duplicate or malformed output', async () => {
    const cases = [
      ['partial', 'printf "1\\t%s/child\\0" "$1"'],
      ['duplicate', 'printf "1\\t%s\\0" "$1" "$1"'],
      ['malformed', 'printf "bad\\t%s\\0" "$1"'],
      ['exit-failure', 'printf "1\\t%s\\0" "$1"; exit 1'],
    ] as const;
    for (const [name, script] of cases) {
      const { launch } = countingLauncher();
      const run = await runDetachedDuUsage([tree], {
        dir: join(base, `usage-${name}`), launch, pollMs: 25,
        command: () => ['sh', ['-c', script, 'bad-du', tree]],
      });
      expect(run.complete, name).toBe(false);
      expect(run.bytes, name).toBeNull();
      expect(run.error, name).toBeTruthy();
    }
  });

  it('refuses a replaced root identity instead of reusing its finished totals', async () => {
    const root = join(base, 'usage-replace'); mkdirSync(root);
    writeFileSync(join(root, 'file'), 'before');
    const dir = join(base, 'usage-replace-state'), { launch, launches } = countingLauncher();
    expect((await runDetachedDuUsage([root], { dir, launch, pollMs: 25 })).complete).toBe(true);
    renameSync(root, root + '-old'); mkdirSync(root);
    await expect(runDetachedDuUsage([root], { dir, launch })).rejects.toThrow('request changed');
    expect(launches).toEqual([1]);
  });

  it('measures exactly what the in-process walk measures', async () => {
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const { launch, launches } = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir: join(base, 'w-plain'), floorBytes, maxDepth, launch, pollMs: 50 });
    expect(launches).toEqual([1]);
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.summary.consumers).toEqual(reference.summary.consumers);
  });

  it('keeps walking after its caller stops waiting, and the next caller adopts it instead of starting over', async () => {
    const dir = join(base, 'w-adopt');
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const first = countingLauncher();
    await expect(
      runDetachedDuWalk(tree, {
        dir,
        floorBytes,
        maxDepth,
        launch: first.launch,
        command: slowDu(2),
        pollMs: 50,
        signal: AbortSignal.timeout(400),
      }),
    ).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = await readWalkState(dir);
    expect(state?.pid).toBeTypeOf('number');
    // The caller is gone; the walk is not.
    expect(walkProcessAlive(state!)).toBe(true);

    const second = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir, floorBytes, maxDepth, launch: second.launch, command: slowDu(2), pollMs: 50 });
    expect(first.launches).toEqual([1]);
    expect(second.launches).toEqual([]);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.summary.consumers).toEqual(reference.summary.consumers);
    expect(run.walkNote).toContain('survived 1 operator restart(s)');
    expect((await readWalkState(dir))?.adoptions).toBe(1);
  });

  it('relaunches a walk killed mid-run instead of reading its partial output', async () => {
    const dir = join(base, 'w-killed');
    const reference = await runDuTree(tree, { floorBytes, maxDepth });
    const first = countingLauncher();
    await expect(
      runDetachedDuWalk(tree, {
        dir,
        floorBytes,
        maxDepth,
        launch: first.launch,
        command: slowDu(30),
        // The orphaned sleep under timeout(1) ends within 3 s of the kill below.
        timeoutMs: 3_000,
        pollMs: 50,
        signal: AbortSignal.timeout(300),
      }),
    ).rejects.toBeInstanceOf(DetachedWalkAbandoned);
    const state = (await readWalkState(dir))!;
    process.kill(state.pid!, 'SIGKILL');
    await waitUntil(() => !walkProcessAlive(state));

    const second = countingLauncher();
    const run = await runDetachedDuWalk(tree, { dir, floorBytes, maxDepth, launch: second.launch, pollMs: 50 });
    expect(second.launches).toEqual([2]);
    expect(run.exitCode).toBe(0);
    expect(run.summary.rootBytes).toBe(reference.summary.rootBytes);
    expect(run.walkNote).toContain('relaunched 1 time(s)');
  });

  it('is bounded by timeout(1) inside the walk, not by the caller', async () => {
    const { launch } = countingLauncher();
    const run = await runDetachedDuWalk(tree, {
      dir: join(base, 'w-timeout'),
      floorBytes,
      maxDepth,
      launch,
      command: slowDu(10),
      timeoutMs: 1_000,
      pollMs: 50,
    });
    expect(run.exitCode).toBe(TIMEOUT_EXIT_STATUS);
    expect(run.timedOut).toBe(true);
    expect(run.summary.rootBytes).toBeNull();
  });
});
