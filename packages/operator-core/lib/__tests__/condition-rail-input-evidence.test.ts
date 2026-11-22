import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNativeArtifactPersister, readConditionRailInputEvidence, writeBudgetedTaskNativeExecutionReceipt } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const command = 'tsx scripts/condition-rail-inventory.mjs --lint';
const source = 'packages/sample/check ☃.ts';
const baseline = 'scripts/condition-rail-baseline.json';
const seed = 'docs/evidence/condition-rail-inventory-seed-2026-10-11.json';
const sourceBytes = Buffer.concat([Buffer.from('// '), Buffer.from([0xff]), Buffer.from('\r\nexport const ok = true;\n')]);
const digest = (bytes: Buffer) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });
const temp = mkdtempSync(join(tmpdir(), 'condition-rail-evidence-'));
const root = join(temp, 'project');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);

function observe() {
  const directory = mkdtempSync(join(temp, 'observation-')), out = join(directory, 'out.json');
  const startedAtMs = Date.now();
  const child = spawnSync('npm', ['run', 'lint:condition-rail'], { cwd: root, timeout: 60_000,
    env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0' }) });
  if (child.error) throw child.error;
  const input = { task: 'post:lint:condition-rail:lint:condition-rail', attempt: directory, cwd: root,
    command: ['npm', 'run', 'lint:condition-rail'], originalCommand: command, startedAtMs, finishedAtMs: Date.now(),
    exitCode: child.status, signal: child.signal, error: null, captureComplete: true,
    stdout: child.stdout, stderr: child.stderr, processTrace: { out, rootPid: child.pid } };
  const saved = writeBudgetedTaskNativeExecutionReceipt(join(directory, 'retained'), input);
  return { saved, input, directory };
}

// Change only the diagnostic publisher in this disposable project. npm, the scanner,
// native process events, metadata store and receipt reader run normally.
function observeWithPublisher(body: string) {
  const path = 'scripts/lib/budgeted-task-scheduler.mjs', bridge = join(root, path), previous = readFileSync(bridge);
  writeFileSync(bridge, `import { publishConditionRailInputManifest as publish } from ${JSON.stringify(pathToFileURL(join(repo, path)).href)};
    export function publishConditionRailInputManifest(out, manifest) { ${body} }`);
  try { return observe(); } finally { writeFileSync(bridge, previous); }
}

describe('condition-rail input evidence from the original npm lint', () => {
  let initial: ReturnType<typeof observe>;
  beforeAll(() => {
    for (const path of ['scripts/lib', 'docs/evidence', 'packages/sample']) mkdirSync(join(root, path), { recursive: true });
    git('init', '-q');
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
    for (const path of ['scripts/condition-rail-inventory.mjs', 'scripts/lib/condition-rail-inventory.mjs']) {
      copyFileSync(join(repo, path), join(root, path));
    }
    for (const name of ['tracked-files', 'strip-comments-and-strings', 'governed-test-process', 'process-identity', 'budgeted-task-scheduler']) {
      const path = `scripts/lib/${name}.mjs`;
      writeFileSync(join(root, path), `export * from ${JSON.stringify(pathToFileURL(join(repo, path)).href)};\n`);
    }
    writeFileSync(join(root, 'scripts/lib/condition-rail-dispositions.mjs'), 'export const DISPOSITIONS = {};\n');
    writeFileSync(join(root, '.gitignore'), '/node_modules\n/scripts/lib\n/scripts/condition-rail-inventory.mjs\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { 'lint:condition-rail': command } }));
    writeFileSync(join(root, source), sourceBytes);
    writeFileSync(join(root, seed), '{"rows":[],"amendments":[]}\r\n');
    // Two different valid editions in a disposable repository exercise real newest-first Git pipes.
    for (const ending of ['\n', '\r\n']) {
      writeFileSync(join(root, baseline), '{"rowIds":[]}' + ending);
      git('add', '--', baseline);
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
        'commit', '-qm', 'baseline edition');
    }
    initial = observe();
  }, 90_000);
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('reads back exact consumed bytes and ordered history after the producer output disappears', () => {
    const { saved, input } = initial;
    expect(input.exitCode, input.stderr.toString()).toBe(0);
    expect(saved.observation).toMatchObject({ runtimeClosure: 'unmeasured', operationalAcceptance: false });
    const observation = saved.observation.processTrace.conditionRailInputs;
    expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'recorded', gaps: [] });
    rmSync(`${input.processTrace.out}.condition-rail-inputs`, { recursive: true });
    const read = readConditionRailInputEvidence(saved.root, saved.receipt);
    expect(read.status, read.gaps.join('\n')).toBe('recorded');
    const log = git('log', '--format=%H', 'HEAD', '--', baseline);
    const revisions = log.toString().trim().split('\n');
    expect(revisions).toHaveLength(2);
    expect(read.manifest).toMatchObject({ sources: [{ path: source, ...digest(sourceBytes) }],
      seed: { path: seed, ...digest(readFileSync(join(root, seed))) }, baseline: { path: baseline, ...digest(readFileSync(join(root, baseline))) },
      history: { log: { stdout: log.toString(), ...digest(log) }, shows: revisions.map(revision => ({ revision, ...digest(git('show', `${revision}:${baseline}`)) })) } });
    expect(read.manifest!.pid).toEqual(observation!.pid);
  });

  it('rotates the source digest for different bytes and retains the original failing lint exit', () => {
    const bytes = Buffer.from('function check() { notifyAttention(event); }\n');
    writeFileSync(join(root, source), bytes);
    try {
      const { saved, input } = observe();
      expect(input.exitCode, input.stderr.toString()).toBe(1);
      expect(input.stderr.toString()).toContain('new rail bypass');
      const read = readConditionRailInputEvidence(saved.root, saved.receipt);
      expect(read.status, read.gaps.join('\n')).toBe('recorded');
      expect(read.manifest!.sources).toEqual([{ path: source, ...digest(bytes) }]);
      expect(readConditionRailInputEvidence(initial.saved.root, initial.saved.receipt).manifest!.sources[0]).toEqual({ path: source, ...digest(sourceBytes) });
      expect(saved.observation).toMatchObject({ execution: { exitCode: 1 }, orderedChainQualified: false, runtimeClosure: 'unmeasured' });
    } finally { writeFileSync(join(root, source), sourceBytes); }
  }, 90_000);

  it('keeps missing source and parser inputs visible on an interrupted lint', () => {
    const bytes = readFileSync(join(root, seed)), missing = 'packages/sample/missing.ts';
    rmSync(join(root, seed));
    symlinkSync(join(root, 'absent-source'), join(root, missing));
    try {
      const { saved, input } = observe();
      expect(input.exitCode).toBe(1);
      const read = readConditionRailInputEvidence(saved.root, saved.receipt);
      expect(read.status, read.gaps.join('\n')).toBe('partial');
      expect(read.gaps).toEqual(expect.arrayContaining(['unreadable-source', 'seed-unmeasured', 'git-log-unmeasured', 'lint-input-consumption-interrupted']));
      expect(read.manifest).toMatchObject({ seed: null, inventory: { unreadableFiles: [missing] }, sources: [{ path: source, ...digest(sourceBytes) }] });
      expect(saved.observation.operationalAcceptance).toBe(false);
    } finally { rmSync(join(root, missing)); writeFileSync(join(root, seed), bytes); }
  }, 90_000);

  it.each(['missing', 'different', 'truncated', 'redirected'])('leaves a %s archived manifest unknown', fault => {
    const { saved } = initial, pin = saved.observation.processTrace.conditionRailInputs!.artifact!;
    const path = join(saved.root, pin.ref), bytes = readFileSync(path);
    rmSync(path);
    try {
      if (fault === 'different') writeFileSync(path, Buffer.alloc(bytes.length, 97));
      if (fault === 'truncated') writeFileSync(path, bytes.subarray(0, bytes.length - 1));
      if (fault === 'redirected') symlinkSync(join(root, seed), path);
      expect(readConditionRailInputEvidence(saved.root, saved.receipt)).toMatchObject({ status: 'unknown', manifest: null });
    } finally { rmSync(path, { force: true }); writeFileSync(path, bytes, { mode: 0o600 }); }
  });

  it('requires the original scanner trace even when aggregate stdout contains its locator', () => {
    const { input, directory } = initial;
    expect(input.stdout.toString()).toContain('PAPERCUSP_CONDITION_RAIL_INPUTS_V1 ');
    const saved = writeBudgetedTaskNativeExecutionReceipt(join(directory, 'without-trace'), { ...input, processTrace: null });
    expect(readConditionRailInputEvidence(saved.root, saved.receipt)).toMatchObject({ status: 'unknown', manifest: null });
    expect(saved.observation).toMatchObject({ execution: { exitCode: 0 }, orderedChainQualified: false, operationalAcceptance: false });
  });

  it.each(['duplicate', 'late'])('leaves a %s diagnostic unknown while preserving the command outcome', fault => {
    const changed = fault === 'late' ? 'manifest.finishedAtMs += 3600000;' : '';
    const repeat = fault === 'duplicate' ? 'console.log(marker);' : '';
    const { saved, input } = observeWithPublisher(`${changed} const marker = publish(out, manifest); ${repeat} return marker;`);
    expect(input.exitCode, input.stderr.toString()).toBe(0);
    const read = readConditionRailInputEvidence(saved.root, saved.receipt);
    expect(read).toMatchObject({ status: 'unknown', manifest: null });
    expect(read.gaps.join()).toMatch(fault === 'late' ? /outside scanner process/ : /locator missing or ambiguous/);
    expect(saved.observation.runtimeClosure).toBe('unmeasured');
  }, 90_000);

  // Native custody stores up to 16 MiB inline and uses 8 MiB parts above that.
  const objectBytes = 16 * 1024 * 1024;
  it.each([objectBytes - 1, objectBytes, objectBytes + 1, 3 * objectBytes / 2 + 1])(
    'recovers a %i-byte input manifest through the archived locator', size => {
      const { input, saved } = observeWithPublisher(`
        manifest.transportProbe = { padding: '', tail: 'last field' };
        manifest.transportProbe.padding = 'x'.repeat(${size} - Buffer.byteLength(JSON.stringify(manifest)));
        return publish(out, manifest);`);
      expect(input.exitCode, input.stderr.toString()).toBe(0);
      rmSync(`${input.processTrace.out}.condition-rail-inputs`, { recursive: true });
      const read = readConditionRailInputEvidence(saved.root, saved.receipt);
      expect(read.status, read.gaps.join('\n')).toBe('recorded');
      expect(Buffer.byteLength(JSON.stringify(read.manifest))).toBe(size);
      expect(read.manifest).toHaveProperty('transportProbe.tail', 'last field');
      const parts = read.parts!;
      expect(parts).toHaveLength(size <= objectBytes ? 0 : Math.ceil(size / (objectBytes / 2)));
      if (parts.length) {
        rmSync(join(saved.root, parts.at(-1)!.artifact.ref));
        expect(readConditionRailInputEvidence(saved.root, saved.receipt)).toMatchObject({ status: 'unknown', manifest: null });
      }
    }, 90_000);

  it('requires the archived lifecycle launch event and handles receipts from before input capture', () => {
    const { saved } = initial, trace = saved.observation.processTrace;
    const path = join(saved.root, trace.npmLifecycle.spans[0]!.spawn.ref), bytes = readFileSync(path);
    rmSync(path);
    try { expect(readConditionRailInputEvidence(saved.root, saved.receipt)).toMatchObject({ status: 'unknown', manifest: null }); }
    finally { writeFileSync(path, bytes, { mode: 0o600 }); }
    const legacy = structuredClone(saved.observation);
    delete legacy.processTrace.conditionRailInputs;
    const pin = createNativeArtifactPersister(saved.root).persist(Buffer.from(JSON.stringify(legacy)), 'receipt.json');
    expect(readConditionRailInputEvidence(saved.root, pin)).toMatchObject({ status: 'unknown', manifest: null });
  });
});
