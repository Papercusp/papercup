import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { retainDetachedVitestReport, TestRunArtifactPacket, testRunDeadline } from './run-artifacts';
import { retainNativeProofPacketAsync, verifyNativeProofPacket } from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';

/**
 * WI-6554700010048955 tripwire: when armed, the sync fs calls the packet used to make on
 * the operator host thread throw instead of running. Disarmed, every call passes through
 * unchanged, so the rest of this file sees the real module.
 */
const fsTripwire = vi.hoisted(() => ({ armed: false, calls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const trap = <K extends 'appendFileSync' | 'writeFileSync' | 'readFileSync' | 'readdirSync' | 'lstatSync'>(name: K) =>
    ((...args: unknown[]) => {
      if (fsTripwire.armed) {
        fsTripwire.calls.push(name);
        throw new Error(`sync fs call ${name} on the host thread`);
      }
      return (actual[name] as (...forwarded: unknown[]) => unknown)(...args);
    }) as (typeof actual)[K];
  return { ...actual, default: actual, appendFileSync: trap('appendFileSync'), writeFileSync: trap('writeFileSync'),
    readFileSync: trap('readFileSync'), readdirSync: trap('readdirSync'), lstatSync: trap('lstatSync') };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('maintained run deadlines and retained artifacts', () => {
  it('keeps default packets and detached receipts after the isolated runtime HOME is removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-isolated-')); roots.push(root);
    const runtime = join(root, 'runtime');
    const source = join(runtime, 'source'); mkdirSync(source, { recursive: true });
    vi.stubEnv('HOME', join(runtime, 'home'));
    vi.stubEnv('PAPERCUSP_HOME', join(runtime, 'home', '.papercusp'));
    vi.stubEnv('XDG_STATE_HOME', join(runtime, 'state'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', '  ' + join(root, 'retained') + '  ');
    writeFileSync(join(source, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('isolated-retention', source, testRunDeadline(60_000));
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'fixture' });
    for (const name of ['configuration.json', 'router.json', 'ledger.json']) packet.write(name, { fixture: true });
    packet.childState = 'closed';
    await packet.finish({ cleanup: { complete: true } });
    const report = await retainDetachedVitestReport({ runId: 'isolated-retention', root: source,
      sourcePath: join(source, 'report.json'), reportText: '{"passed":1}' });
    rmSync(runtime, { recursive: true });

    expect(dirname(packet.paths.directory)).toBe(join(root, 'retained', 'testing-run'));
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ state: 'retained',
      childState: 'closed', cleanup: { complete: true }, nativeCustody: { byteCustody: 'complete' } });
    expect(readFileSync(packet.paths.phases, 'utf8')).toContain('start');
    expect(readFileSync(report.reportPath, 'utf8')).toBe('{"passed":1}');
    expect(JSON.parse(readFileSync(report.manifestPath, 'utf8')).report.sha256).toBe(report.sha256);
  });
  it('keeps the ordinary home layout when no retained evidence base is pinned', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-home-')); roots.push(root);
    vi.stubEnv('PAPERCUSP_HOME', root);
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', '  ');
    const packet = new TestRunArtifactPacket('ordinary-home', root, testRunDeadline(1000));
    expect(dirname(packet.paths.directory)).toBe(join(root, 'test-artifacts', 'testing-run'));
  });
  it('honors an explicit packet directory while a launcher evidence base is pinned', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-explicit-')); roots.push(root);
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', join(root, 'retained'));
    const explicit = join(root, 'explicit');
    const packet = new TestRunArtifactPacket('explicit-root', root, testRunDeadline(1000), explicit);
    expect(dirname(packet.paths.directory)).toBe(explicit);
  });
  function nativePacket() {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-custody-')); roots.push(root);
    const source = join(root, 'producer'); mkdirSync(source);
    writeFileSync(join(source, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('run-custody', source, testRunDeadline(60_000), join(root, 'retained'));
    packet.bindNativeIdentity('custody-workspace', 'papercusp');
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'fixture' });
    for (const name of ['configuration.json', 'router.json', 'ledger.json']) packet.write(name, { fixture: true });
    const log = join(source, 'stdout.log'); writeFileSync(log, Buffer.from([0, 255, 10]));
    packet.captureOutputLogs([log]);
    return { root, source, packet };
  }
  it('preserves private bytes after producer removal without upgrading pending execution or cleanup', async () => {
    const { source, packet } = nativePacket();
    packet.childState = 'pending';
    await packet.finish({ cleanup: { complete: false } });
    const manifest = JSON.parse(readFileSync(packet.paths.manifest, 'utf8'));
    expect(manifest.nativeCustody).toMatchObject({ byteCustody: 'complete', writerState: 'pending',
      nativeProof: 'unqualified', acceptance: 'unmeasured' });
    const locator = manifest.nativeCustody.locator;
    const bytes = readFileSync(join(packet.paths.nativeProof, 'objects', locator.manifest.ref));
    const retained = JSON.parse(bytes.toString('utf8'));
    rmSync(source, { recursive: true });
    const read = verifyNativeProofPacket(packet.paths.nativeProof, locator, { identity: {
      workspace: 'custody-workspace', harness: 'papercusp', runId: 'run-custody',
    }, expected: [{ id: 'packet', attempt: 'primary', selected: [join(source, 'subject.test.ts')],
      runner: 'unsupported', armed: false, out: null, auxiliary: retained.expected[0].auxiliary }] });
    expect(read.status).toBe('complete');
    const log = read.manifest.groups[0].auxiliary.find(row => row.role === 'router-output/0')!.artifact!;
    expect(readFileSync(join(packet.paths.nativeProof, 'objects', log.ref))).toEqual(Buffer.from([0, 255, 10]));
  });
  it('links late-close settlement without changing a sealed pending edition', async () => {
    const { packet } = nativePacket();
    packet.childState = 'pending'; await packet.finish({ cleanup: { complete: false } });
    const first = JSON.parse(readFileSync(packet.paths.manifest, 'utf8')).nativeCustody.locator;
    const original = readFileSync(join(packet.paths.nativeProof, 'objects', first.manifest.ref));
    packet.childState = 'closed'; packet.stage('late-child-close'); await packet.finish({ cleanup: { complete: true } });
    const second = JSON.parse(readFileSync(packet.paths.manifest, 'utf8')).nativeCustody;
    expect(second.writerState).toBe('settled');
    expect(second.locator.manifest.sha256).not.toBe(first.manifest.sha256);
    expect(JSON.parse(readFileSync(join(packet.paths.nativeProof, 'objects', second.locator.manifest.ref), 'utf8')).predecessor).toEqual(first);
    expect(readFileSync(join(packet.paths.nativeProof, 'objects', first.manifest.ref))).toEqual(original);
  });
  it('retains actual cleanup outcome when custody refuses a redirected root', async () => {
    const { source, packet } = nativePacket();
    symlinkSync(source, packet.paths.nativeProof);
    packet.childState = 'closed'; await packet.finish({ cleanup: { complete: true } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ cleanup: { complete: true },
      nativeCustody: { byteCustody: 'unavailable', nativeProof: 'unqualified', acceptance: 'unmeasured' } });
  });
  it('keeps native-proof fsync waits off the request event loop', async () => {
    const { packet, root } = nativePacket();
    const probe = await openAsync(join(root, 'sync-probe'), 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    const realSync = fileHandlePrototype.sync;
    await probe.close();
    let releaseFirstSync!: () => void;
    let enteredFirstSync!: () => void;
    const firstSyncEntered = new Promise<void>(resolve => { enteredFirstSync = resolve; });
    const firstSyncGate = new Promise<void>(resolve => { releaseFirstSync = resolve; });
    let first = true;
    const sync = vi.spyOn(fileHandlePrototype, 'sync').mockImplementation(async function () {
      if (first) {
        first = false;
        enteredFirstSync();
        await firstSyncGate;
      }
      return realSync.call(this);
    });

    let finished = false;
    const finishing = packet.finish({ cleanup: { complete: true } }).then(() => { finished = true; });
    await firstSyncEntered;
    let eventLoopTurned = false;
    await new Promise<void>(resolve => setImmediate(() => { eventLoopTurned = true; resolve(); }));
    expect(eventLoopTurned).toBe(true);
    expect(finished).toBe(false);
    expect(sync).toHaveBeenCalled();
    releaseFirstSync();
    await finishing;
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({
      nativeCustody: { byteCustody: 'complete', nativeProof: 'unqualified' },
    });
  });
  it('keeps cleanup and the original result when custody exhausts the owning task deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-expired-')); roots.push(root);
    const packet = new TestRunArtifactPacket('expired-custody', root,
      testRunDeadline(1000, { now: Date.now() - 2000 }), join(root, 'retained'));
    packet.bindNativeIdentity('custody-workspace', 'papercusp');
    packet.childState = 'closed';
    await packet.finish({ result: { ok: false, error: 'timeout' }, cleanup: { complete: true } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({
      childState: 'closed', result: { ok: false, error: 'timeout' }, cleanup: { complete: true },
      nativeCustody: { byteCustody: 'unavailable', nativeProof: 'unqualified', acceptance: 'unmeasured',
        error: expect.stringContaining('native proof sync deadline') },
    });
    const locator = JSON.parse(readFileSync(join(packet.paths.nativeProof, 'pending-locator.json'), 'utf8'));
    expect(locator.identity.runId).toBe('expired-custody');
  });
  it.each([false, true])('recovers interrupted router custody while preserving parent log loss=%s', async retireParentLog => {
    const { source, packet } = nativePacket();
    await packet.flush();
    const directory = join(packet.paths.directory, 'native-router-interrupted');
    mkdirSync(directory, { mode: 0o700 });
    const identity = { workspace: 'custody-workspace', harness: 'papercusp', runId: 'run-custody' };
    const reportPath = join(source, 'report.json');
    const reportBytes = Buffer.from(JSON.stringify({ success: true, numPassedTests: 6, numFailedTests: 0 }));
    writeFileSync(reportPath, reportBytes);
    const expected = [{ id: 'router-primary', attempt: 'primary' as const,
      selected: [join(source, 'subject.test.ts')], runner: 'unsupported' as const, armed: false, out: null,
      auxiliary: [{ role: 'original-report', state: 'produced' as const, path: reportPath }] }];
    writeFileSync(join(directory, 'expected.json'), JSON.stringify({ identity, expected }), { mode: 0o600 });
    await expect(retainNativeProofPacketAsync(directory, { identity, expected,
      observations: [{ id: 'router-primary', out: null }], execution: 'router-settled',
      deadlineAtMs: Date.now() - 1 })).rejects.toMatchObject({ code: 'NATIVE_PROOF_SYNC_DEADLINE' });
    const pendingBytes = readFileSync(join(directory, 'pending-locator.json'));
    const pendingLocator = JSON.parse(pendingBytes.toString('utf8'));
    const retained = verifyNativeProofPacket(directory, pendingLocator, { identity, expected });
    const report = retained.manifest.groups[0].auxiliary.find(row => row.role === 'original-report')!.artifact!;
    // Retire the router's producers without accidentally retiring the parent's
    // independent output log. Its deliberate loss must remain a custody gap.
    rmSync(reportPath);
    rmSync(join(source, 'subject.test.ts'));
    if (retireParentLog) rmSync(join(source, 'stdout.log'));

    packet.childState = 'closed';
    const result = { ok: false, error: 'timeout', passed: 6, failed: 0 };
    await packet.finish({ result, cleanup: { complete: true } });

    const manifest = JSON.parse(readFileSync(packet.paths.manifest, 'utf8'));
    expect(manifest.result).toEqual(result);
    expect(manifest.cleanup).toEqual({ complete: true });
    expect(manifest.nativeCustody.byteCustody, JSON.stringify(manifest.nativeCustody))
      .toBe(retireParentLog ? 'partial' : 'complete');
    expect(manifest.nativeCustody).toMatchObject({ routerCustody: ['complete'], writerState: 'settled',
      nativeProof: 'unqualified', acceptance: 'unmeasured',
    });
    rmSync(source, { recursive: true });
    expect(JSON.parse(readFileSync(join(directory, 'locator.json'), 'utf8'))).toEqual(pendingLocator);
    expect(readFileSync(join(directory, 'pending-locator.json'))).toEqual(pendingBytes);
    expect(readFileSync(join(directory, 'objects', report.ref))).toEqual(reportBytes);
    expect(verifyNativeProofPacket(directory, pendingLocator, { identity, expected }).status).toBe('complete');
  });
  it('holds an explicit cleanup reserve behind one absolute child cutoff', () => {
    expect(testRunDeadline(45_000, { now: 1000, cleanupReserveMs: 10_000 })).toEqual({
      startedAtMs: 1000, taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000,
    });
    expect(testRunDeadline(45_000, { now: 20_000, taskDeadlineAtMs: 46_000, cleanupReserveMs: 10_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000 });
  });
  it('keeps private-PG setup outside the assertion budget and cleanup reserve', () => {
    expect(testRunDeadline(240_000, { now: 1000, setupTimeoutMs: 300_000, cleanupReserveMs: 30_000 })).toEqual({
      startedAtMs: 1000, taskDeadlineAtMs: 571_000, childCutoffAtMs: 541_000, cleanupReserveMs: 30_000,
      setupTimeoutMs: 300_000, effectiveSetupTimeoutMs: 300_000, setupDeadlineAtMs: 301_000,
      verificationTimeoutMs: 240_000,
    });
    expect(testRunDeadline(240_000, { now: 1000, taskDeadlineAtMs: 500_000,
      setupTimeoutMs: 300_000, cleanupReserveMs: 30_000 }))
      .toMatchObject({ taskDeadlineAtMs: 500_000, childCutoffAtMs: 470_000,
        effectiveSetupTimeoutMs: 229_000, setupDeadlineAtMs: 230_000, verificationTimeoutMs: 240_000 });
  });
  it('never refreshes an exhausted inherited deadline or accepts an invalid reserve', () => {
    expect(testRunDeadline(45_000, { now: 50_000, taskDeadlineAtMs: 46_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 46_000, cleanupReserveMs: 0 });
    expect(() => testRunDeadline(1000, { cleanupReserveMs: 1000 })).toThrow(/reserve/);
    expect(() => testRunDeadline(0)).toThrow(/budget/);
  });
  it('never borrows an explicit reserve when inherited preparation consumed the child slot', () => {
    expect(testRunDeadline(45_000, { now: 40_000, taskDeadlineAtMs: 46_000, cleanupReserveMs: 10_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000 });
  });
  it.each(['closed', 'pending'] as const)('retains reports, channels, source pins and receipts when child state is %s', async childState => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-')); roots.push(root);
    writeFileSync(join(root, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('run-1', root, testRunDeadline(1000), join(root, 'retained'));
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'abc', porcelain: '' });
    packet.childState = childState;
    writeFileSync(join(packet.paths.reports, 'report.json'), '{"complete":true}');
    writeFileSync(join(packet.paths.directory, 'stdout.log'), 'first byte\nlast byte\n');
    writeFileSync(join(packet.paths.directory, 'stderr.log'), 'separate error\n');
    packet.stage('router-result'); await packet.finish({ cleanup: { complete: childState === 'closed' } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ state: 'retained', childState });
    expect(readFileSync(join(packet.paths.reports, 'report.json'), 'utf8')).toContain('complete');
    expect(readFileSync(join(packet.paths.directory, 'stdout.log'), 'utf8')).toContain('first byte');
    expect(readFileSync(join(packet.paths.directory, 'stderr.log'), 'utf8')).toContain('separate error');
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'source.json'), 'utf8')).inputs[0])
      .toMatchObject({ path: 'subject.test.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readFileSync(packet.paths.phases, 'utf8')).toContain('router-result');
  });
});

describe('packet writes stay off the operator host thread (WI-6554700010048955)', () => {
  it('stage/write/captureSelectedSources make no sync fs call, and land in call order on flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-async-')); roots.push(root);
    writeFileSync(join(root, 'subject.test.ts'), 'export const pinned = 1;\n');
    const packet = new TestRunArtifactPacket('async-writes', root, testRunDeadline(60_000), join(root, 'retained'));
    const config = { attempt: 1 };
    fsTripwire.armed = true;
    try {
      // Positive control: the armed tripwire really intercepts a named `node:fs` sync call in
      // this module graph, so the pre-fix appendFileSync/writeFileSync/readFileSync would trip it.
      expect(() => writeFileSync(join(root, 'probe.txt'), 'x')).toThrow(/sync fs call writeFileSync/);
      expect(fsTripwire.calls).toEqual(['writeFileSync']);
      fsTripwire.calls.length = 0;
      packet.captureSelectedSources(['subject.test.ts'], { commit: 'fixture' });
      packet.stage('a');
      packet.write('configuration.json', config);
      config.attempt = 2; // serialized at call time: a later mutation must not leak into the queued bytes
      packet.stage('b');
      packet.write('router.json', { n: 1 });
      packet.write('router.json', { n: 2 });
      await packet.flush();
    } finally {
      fsTripwire.armed = false;
    }
    expect(fsTripwire.calls).toEqual([]);
    const phases = readFileSync(packet.paths.phases, 'utf8').trim().split('\n').map(line => JSON.parse(line).stage);
    expect(phases).toEqual(['start', 'a', 'b']);
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'configuration.json'), 'utf8'))).toEqual({ attempt: 1 });
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'router.json'), 'utf8'))).toEqual({ n: 2 });
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'source.json'), 'utf8'))).toMatchObject({
      worktree: { commit: 'fixture' },
      inputs: expect.arrayContaining([
        expect.objectContaining({ path: 'subject.test.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ]),
    });
  });

  it('surfaces a failed queued write once at flush and keeps later writes flowing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-async-fail-')); roots.push(root);
    const packet = new TestRunArtifactPacket('async-failure', root, testRunDeadline(60_000), join(root, 'retained'));
    packet.write(join('no-such-dir', 'lost.json'), { lost: true });
    packet.write('kept.json', { kept: true });
    await expect(packet.flush()).rejects.toThrow(/ENOENT/);
    await expect(packet.flush()).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'kept.json'), 'utf8'))).toEqual({ kept: true });
  });
});
