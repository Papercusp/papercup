/** Independently authored normative fixture, followed by maintained real-Git contracts. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunGitStdin } from '../../sync/pot-git/storage';
import { captureGitSyncCandidate, parseGitSyncCandidateCapture, type GitSyncCandidateRequest, type RunGit } from './run-git-sync';
import { prepareBgVerifierSource, verifyBgVerifierSource } from '../../../../../scripts/source-preview.mjs';
import { custodySourceCanonicalBytes, parseCustodySourceArtifactReceipt, parseCustodySourceHandoff,
  prospectiveCustodySourcePacketSha256, verifyProspectiveCustodySourceReceipt,
  withCustodySourceArtifact, type CustodySourceArtifactOptions, type CustodySourceArtifactScope } from './custody-source-artifact';

// This literal is the schema's independent byte oracle; never generate it with product serialization.
const fixtureBytes = '{"artifact":{"commit":"' + 'c'.repeat(40) + '","parent":"' + 'a'.repeat(40) +
  '","root":"/mnt/data/tmp/artifact","tree":"' + 'b'.repeat(40) +
  '"},"authority":"source-only","capture":{"candidate":{"base":"' + 'a'.repeat(40) +
  '","baseTree":"' + 'd'.repeat(40) + '","generation":1,"kind":"candidate","paths":["a.txt"],' +
  '"repository":"/mnt/data/tmp/donor/.git","requestId":"fixture","tree":"' + 'b'.repeat(40) +
  '","version":2},"ref":"refs/papercusp/source-custody/' + 'e'.repeat(64) +
  '"},"custody":{"expiresAt":"2026-11-10T12:01:00.000Z","issuedAt":"2026-11-10T12:00:00.000Z",' +
  '"leaseId":"fixture-invocation","ownerId":"fixture-owner","releaseCondition":"producer-chain-settled",' +
  '"workItemRef":"WI-6554700010047050"},"objects":{"cleanupOrder":["exporter","artifact","donor"],' +
  '"donorRepository":"/mnt/data/tmp/donor/.git","selfContained":false},"qualifications":{"activation":false,' +
  '"ancestry":"UNKNOWN","compiler":"UNKNOWN","fullOutput":false,"native":false,"publication":false,' +
  '"runtime":false,"shipment":false,"sourceCensus":"UNKNOWN","suiteStart":false,"workerRegistration":false},' +
  '"schemaVersion":"custody-source-artifact-v1"}\n';
const fixtureReceipt = () => JSON.parse(fixtureBytes);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function realFixture() {
  mkdirSync('/mnt/data/tmp', { recursive: true });
  const root = mkdtempSync('/mnt/data/tmp/custody-source-test-'); roots.push(root);
  const repo = join(root, 'donor'); mkdirSync(repo);
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ...options?.env } });
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  const runGitStdin: RunGitStdin = async (args, cwd, input, options) => {
    const result = spawnSync('git', args, { cwd, input, timeout: options?.timeoutMs ?? 30_000,
      env: { ...process.env, ...options?.env } });
    return { code: result.status ?? -1, stdout: result.stdout ?? Buffer.alloc(0), stderr: String(result.stderr ?? '') };
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw Error(String(r.stderr));
    return r.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'custody fixture');
  git('config', 'user.email', 'fixture@papercusp.local'); git('config', 'commit.gpgsign', 'false');
  git('config', 'gc.auto', '0');
  mkdirSync(join(repo, 'packages/core'), { recursive: true });
  writeFileSync(join(repo, 'packages/core/index.ts'), 'export const original = true;\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"custody-fixture","private":true}\n');
  writeFileSync(join(repo, 'a.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD'); writeFileSync(join(repo, 'a.txt'), 'captured\n');
  const inputGit = (input: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, input, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw Error(String(r.stderr)); return r.stdout.trim();
  };
  return { root, repo, git, inputGit, runGit, runGitStdin, base, destination: join(root, 'artifact') };
}
type Fixture = ReturnType<typeof realFixture>;
async function capture(f: Fixture, overrides: Partial<GitSyncCandidateRequest> = {}) {
  const result = await captureGitSyncCandidate(f.runGit, f.repo,
    { requestId: 'fixture', generation: 1, base: f.base, paths: ['a.txt'], ...overrides });
  if (!result.ok) throw Error(JSON.stringify(result));
  return { ref: result.ref, candidate: result.candidate };
}
function options(f: Fixture, expectedCapture: CustodySourceArtifactOptions['expectedCapture']): CustodySourceArtifactOptions {
  return { repository: f.repo, expectedCapture, destination: f.destination, runGit: f.runGit, runGitStdin: f.runGitStdin, ownerId: 'fixture-owner',
    workItemRef: 'WI-6554700010047050', deadline: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal };
}
const independentJson = (value: unknown): string => {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(Reflect.get(v, k))])) : v;
  return JSON.stringify(ordered(value)) + '\n';
};
function replaceManifest(f: Fixture, captured: Awaited<ReturnType<typeof capture>>, bytes: string) {
  const blob = f.inputGit(bytes, 'hash-object', '-w', '--stdin');
  const tree = f.inputGit('100644 blob ' + blob + '\tmanifest.json\n040000 tree ' + captured.candidate.tree + '\tpayload\n', 'mktree');
  f.git('update-ref', captured.ref, tree);
}
function removeObject(f: Fixture, oid: string) { rmSync(join(f.repo, '.git/objects', oid.slice(0, 2), oid.slice(2))); }
function inventory(root: string): unknown {
  return readdirSync(root).sort().map(path => {
    const full = join(root, path), s = lstatSync(full);
    return [path, s.mode, s.isSymbolicLink() ? readlinkSync(full) : s.isDirectory() ? inventory(full) : readFileSync(full).toString('base64')];
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function expectSuccess(result: Awaited<ReturnType<typeof withCustodySourceArtifact>>) {
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', cleanup: { artifactRemoved: true, exportersReleased: true, donorDeleted: false } });
}
function expectRefusal(f: Fixture, result: Awaited<ReturnType<typeof withCustodySourceArtifact>>) {
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', receipt: null, cleanup: null });
  expect(existsSync(f.destination)).toBe(false); expect(existsSync(f.repo)).toBe(true);
}
function acceptedManifest(f: Fixture) {
  // Original fixture content is the oracle, independent of the artifact/exporter output.
  const members = { 'packages/core/index.ts': f.inputGit('export const original = true;\n', 'hash-object', '--stdin') };
  const path = join(f.root, 'original-parent.json'), bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: members });
  writeFileSync(path, bytes);
  return { path, members, sha256: createHash('sha256').update(bytes).digest('hex'), schemaVersion: 1 as const,
    authorityKind: 'source-only' as const, evidenceRef: 'fixture:independently-accepted-source-only' };
}

async function prospectiveFixture(includeGitlink = false) {
  const f = realFixture(); mkdirSync(join(f.repo, 'fixtures'));
  const extra = Array.from({ length: 13 }, (_, i) => 'fixtures/source-' + i + '.txt');
  for (const [i, path] of extra.entries()) writeFileSync(join(f.repo, path), i === 12
    ? Buffer.from([0, 255, 128, 10, 0, 13]) : 'original ' + path + '\n');
  const child = includeGitlink ? (() => {
    const repo = join(f.repo, 'vendor/child'); mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) throw Error(String(result.stderr)); return result.stdout.trim();
    };
    git('init', '-b', 'main'); git('config', 'user.name', 'child fixture');
    git('config', 'user.email', 'child@papercusp.local'); git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'child.ts'), 'export const selected = "A";\n');
    git('add', '.'); git('commit', '-m', 'selected child A');
    return { repo, git, pin: git('rev-parse', 'HEAD') };
  })() : null;
  f.git('add', '.'); f.git('commit', '-m', 'independently retained original16');
  const originalBase = f.git('rev-parse', 'HEAD');
  const paths = ['a.txt', 'package.json', 'packages/core/index.ts', ...extra].sort();
  const contentSha256 = (path: string) => createHash('sha256').update(readFileSync(join(f.repo, path))).digest('hex');
  const original = Object.fromEntries(paths.map(path => [path, contentSha256(path)]));
  const changed = ['a.txt', 'package.json', 'packages/core/index.ts', extra[0]].sort();
  for (const path of changed) writeFileSync(join(f.repo, path), 'prospective ' + path + '\n');
  const c = await capture(f, { base: originalBase, paths: changed, dependencies: Array.from({ length: 6 }, (_, i) =>
    ({ requestId: 'legacy-' + i, generation: 1, paths: ['a.txt'], tree: null })) });
  const members = Object.fromEntries(paths.map(path => [path, f.git('rev-parse', c.candidate.tree + ':' + path)]));
  const contents = Object.fromEntries(paths.map(path => [path, contentSha256(path)]));
  if (child) members['vendor/child/child.ts'] = child.git('rev-parse', child.pin + ':child.ts');
  if (child) contents['vendor/child/child.ts'] = createHash('sha256').update(readFileSync(join(child.repo, 'child.ts'))).digest('hex');
  // These exact fixture members/deltas and JSON oracle are independent of the product verifier.
  const packet = { schemaVersion: 'custody-prospective-source-v1', authority: 'source-only', producerOwnerId: 'source-author',
    original: { capture: structuredClone(c), members: original },
    subject: { repository: c.candidate.repository, captureRef: c.ref, tree: c.candidate.tree,
      route: 'direct-tsx', entrypoints: ['packages/core/index.ts'], members, contentSha256: contents },
    differences: changed.map(path => ({ path, original: original[path], prospective: contents[path] })),
    closure: { source: ['packages/core/index.ts', ...(child ? ['vendor/child/child.ts'] : [])],
      config: ['package.json'], tests: ['a.txt', ...extra].sort(), unresolved: [] },
    rule: { ref: 'thread-post:1', sha256: 'a'.repeat(64) }, qualifications: fixtureReceipt().qualifications };
  const receipt = { ...packet, approvals: {
    rule: { ref: 'thread-post:2', reviewerOwnerId: 'rule-reviewer', subjectSha256: packet.rule.sha256 },
    packet: { ref: 'thread-post:3', reviewerOwnerId: 'packet-reviewer',
      subjectSha256: createHash('sha256').update(independentJson(packet)).digest('hex') } } };
  return { f, c, packet, receipt, expected: structuredClone(receipt), child };
}

describe('prospective source-only admission (WI7050/P001)', () => {
  it('PROSPECTIVE-EXACT preserves original16/four deltas/six NULLs and joins owned cleanup', async () => {
    const { f, c, packet, receipt, expected } = await prospectiveFixture();
    expect(prospectiveCustodySourcePacketSha256(packet)).toBe(receipt.approvals.packet.subjectSha256);
    const verified = verifyProspectiveCustodySourceReceipt(receipt, expected);
    expect(Object.keys(verified.original.members)).toHaveLength(16); expect(verified.differences).toHaveLength(4);
    expect(Object.values(verified.original.members).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(Object.values(verified.subject.members).every(value => /^[a-f0-9]{40}$/.test(value))).toBe(true);
    expect(verified.subject.contentSha256['fixtures/source-12.txt']).toBe(
      createHash('sha256').update(Buffer.from([0, 255, 128, 10, 0, 13])).digest('hex'));
    expect(Object.entries(verified.original.members).filter(([path, hash]) => hash !== verified.subject.contentSha256[path]))
      .toHaveLength(4);
    expect(verified.original.capture.candidate.dependencies?.map(d => d.tree)).toEqual(Array(6).fill(null));
    expect(verified.qualifications).toEqual(fixtureReceipt().qualifications);
    expect(Object.isFrozen(verified.original.capture.candidate.dependencies)).toBe(true);
    const sameReviewer = structuredClone(receipt);
    sameReviewer.approvals.packet.reviewerOwnerId = sameReviewer.approvals.rule.reviewerOwnerId;
    sameReviewer.approvals.packet.ref = sameReviewer.approvals.rule.ref;
    // One independent review may contain two separately bound subject decisions.
    expect(verifyProspectiveCustodySourceReceipt(sameReviewer, structuredClone(sameReviewer)).approvals)
      .toEqual(sameReviewer.approvals);
    expectSuccess(await withCustodySourceArtifact({ ...options(f, c), prospectiveSource: { receipt, expected } }, async scope => {
      expect(scope.receipt.capture).toEqual(c);
      expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
    }));
  });

  it('PROSPECTIVE-SEPARATE-SUBJECT preserves original capture/hash history across a distinct immutable subject', async () => {
    // Private fixture discovery only: this does not authorize a real producer
    // capture, amend D002, or accept any actual source packet.
    const { f, c, receipt } = await prospectiveFixture();
    const original = independentJson(receipt.original);
    const originalCapture = f.git('rev-parse', c.ref);
    writeFileSync(join(f.repo, 'packages/core/index.ts'), 'export const selected = "separate subject";\n');
    const next = await capture(f, { requestId: 'distinct-prospective-subject', generation: 2,
      base: c.candidate.base, paths: [...c.candidate.paths] });
    const revised = structuredClone(receipt);
    revised.subject.captureRef = next.ref; revised.subject.tree = next.candidate.tree;
    revised.subject.members['packages/core/index.ts'] = f.git('rev-parse', next.candidate.tree + ':packages/core/index.ts');
    const content = createHash('sha256').update(readFileSync(join(f.repo, 'packages/core/index.ts'))).digest('hex');
    revised.subject.contentSha256['packages/core/index.ts'] = content;
    revised.differences.find(row => row.path === 'packages/core/index.ts')!.prospective = content;
    const { approvals, ...packet } = revised;
    approvals.packet.subjectSha256 = createHash('sha256').update(independentJson(packet)).digest('hex');
    expect(next.ref).not.toBe(c.ref); expect(next.candidate.tree).not.toBe(c.candidate.tree);
    expect(independentJson(revised.original)).toBe(original);
    expect(revised.original.capture.candidate.dependencies?.map(row => row.tree)).toEqual(Array(6).fill(null));
    expectSuccess(await withCustodySourceArtifact({ ...options(f, next),
      prospectiveSource: { receipt: revised, expected: structuredClone(revised) } }, async scope => {
      expect(scope.receipt.capture).toEqual(next);
      expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
    }));
    expect(independentJson(revised.original)).toBe(original);
    expect(f.git('rev-parse', c.ref)).toBe(originalCapture);
    // A new subject cannot silently stand in for the original expected capture.
    let calls = 0;
    const refused = await withCustodySourceArtifact({ ...options(f, c),
      prospectiveSource: { receipt: revised, expected: structuredClone(revised) },
      runGit: async (...args) => { calls++; return f.runGit(...args); } }, async () => { throw Error('consumer must not run'); });
    expectRefusal(f, refused); expect(calls).toBe(0);
    expect(refused.status === 'failed' && refused.error.message).toContain('custody-prospective-subject');
  });

  it('PROSPECTIVE-REFUSE rejects changed history/map/config/closure or either missing approval before any Git/allocation', async () => {
    const { f, c, receipt, expected } = await prospectiveFixture();
    const mutations: Array<(v: any) => void> = [
      v => { delete v.approvals.rule; }, v => { delete v.approvals.packet; },
      v => { v.approvals.packet.reviewerOwnerId = v.producerOwnerId; },
      v => { v.original.capture.candidate.generation++; }, v => { v.original.capture.candidate.dependencies[0].tree = 'b'.repeat(40); },
      v => { v.subject.members['package.json'] = 'b'.repeat(40); }, v => { v.subject.tree = 'b'.repeat(40); },
      v => { v.original.members['package.json'] = 'b'.repeat(40); },
      v => { delete v.subject.contentSha256['package.json']; },
      v => { v.subject.contentSha256['package.json'] = 'b'.repeat(64); },
      v => { v.subject.captureRef = v.original.capture.ref.slice(0, -1) + (v.original.capture.ref.endsWith('0') ? '1' : '0'); },
      v => { v.closure.config = []; }, v => { v.closure.tests.push('package.json'); },
      v => { v.closure.unresolved.push('computed import'); }, v => { v.differences.pop(); },
      v => { v.qualifications.runtime = true; }, v => { v.subject.unknown = true; },
    ];
    for (const mutate of mutations) {
      const supplied = structuredClone(receipt); mutate(supplied);
      let calls = 0;
      const result = await withCustodySourceArtifact({ ...options(f, c), prospectiveSource: { receipt: supplied, expected },
        runGit: async (...args) => { calls++; return f.runGit(...args); } }, async () => { throw Error('consumer must not run'); });
      expectRefusal(f, result); expect(calls).toBe(0);
    }
  });

  it('PROSPECTIVE-OBJECT compares the accepted literal member to the actual immutable tree before allocation', async () => {
    const { f, c, receipt } = await prospectiveFixture();
    // All objects exist, but this accepted assertion assigns the wrong path's blob.
    receipt.subject.members['packages/core/index.ts'] = receipt.subject.members['package.json'];
    const { approvals, ...packet } = receipt;
    approvals.packet.subjectSha256 = createHash('sha256').update(independentJson(packet)).digest('hex');
    const result = await withCustodySourceArtifact({ ...options(f, c),
      prospectiveSource: { receipt, expected: structuredClone(receipt) } }, async () => { throw Error('consumer must not run'); });
    expectRefusal(f, result); expect(result.status === 'failed' && result.error.message).toContain('custody-prospective-source-member');
  });

  it('PROSPECTIVE-CONTENT refuses self-consistent false content digests and requires the guarded binary reader', async () => {
    const { f, c, receipt, expected } = await prospectiveFixture();
    const missingReader = await withCustodySourceArtifact({ ...options(f, c), runGitStdin: undefined,
      prospectiveSource: { receipt, expected } }, async () => { throw Error('consumer must not run'); });
    expectRefusal(f, missingReader);
    expect(missingReader.status === 'failed' && missingReader.error.message).toContain('custody-prospective-binary-reader');
    // The approved object ID is correct. Even a separately self-consistent
    // packet must not misstate that immutable blob's content hash.
    receipt.subject.contentSha256['packages/core/index.ts'] = 'f'.repeat(64);
    receipt.differences.find(d => d.path === 'packages/core/index.ts')!.prospective = 'f'.repeat(64);
    const { approvals, ...packet } = receipt;
    approvals.packet.subjectSha256 = createHash('sha256').update(independentJson(packet)).digest('hex');
    let reads = 0;
    const result = await withCustodySourceArtifact({ ...options(f, c), prospectiveSource: { receipt, expected: structuredClone(receipt) },
      runGitStdin: async (args, cwd, input, profile) => {
        reads++;
        expect(args.slice(0, 4)).toEqual(['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null']);
        expect(args.slice(4, 6)).toEqual(['cat-file', 'blob']); expect(input).toBe('');
        expect(profile?.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
        expect(profile?.signal).toBeInstanceOf(AbortSignal);
        return f.runGitStdin(args, cwd, input, profile);
      } }, async () => { throw Error('consumer must not run'); });
    expect(reads).toBeGreaterThan(0); expectRefusal(f, result);
    expect(result.status === 'failed' && result.error.message).toContain('custody-prospective-content-digest');
  });

  it('PROSPECTIVE-GITLINK reads selected child A after working HEAD B and refuses an unavailable pinned owner', async () => {
    const { f, c, receipt, expected, child } = await prospectiveFixture(true);
    if (!child) throw Error('child fixture absent');
    writeFileSync(join(child.repo, 'child.ts'), 'export const selected = "B";\n');
    child.git('add', '.'); child.git('commit', '-m', 'later working child B');
    const before = inventory(f.repo);
    expectSuccess(await withCustodySourceArtifact({ ...options(f, c), prospectiveSource: { receipt, expected } }, async scope => {
      await scope.verify();
      expect(existsSync(join(f.destination, 'vendor/child/child.ts'))).toBe(false);
      expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
    }));
    expect(inventory(f.repo)).toEqual(before);
    rmSync(child.repo, { recursive: true, force: true });
    const refused = await withCustodySourceArtifact({ ...options(f, c), prospectiveSource: { receipt, expected } }, async () => {});
    expectRefusal(f, refused);
    expect(refused.status === 'failed' && refused.error.message).toContain('custody-prospective-gitlink');
  });

  it('PROSPECTIVE-GITLINK-UNLISTED refuses a missing unlisted target before allocation and preserves generic UNKNOWN', async () => {
    const { f, c, receipt, child } = await prospectiveFixture(true);
    if (!child) throw Error('child fixture absent');
    delete receipt.subject.members['vendor/child/child.ts'];
    delete receipt.subject.contentSha256['vendor/child/child.ts'];
    receipt.closure.source = ['packages/core/index.ts'];
    const { approvals, ...packet } = receipt;
    approvals.packet.subjectSha256 = createHash('sha256').update(independentJson(packet)).digest('hex');
    rmSync(child.repo, { recursive: true, force: true });
    const refused = await withCustodySourceArtifact({ ...options(f, c),
      prospectiveSource: { receipt, expected: structuredClone(receipt) } }, async () => {});
    expectRefusal(f, refused);
    expect(refused.status === 'failed' && refused.error.message).toContain('custody-prospective-gitlink');
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      expect(scope.receipt.qualifications.ancestry).toBe('UNKNOWN');
    }));
  });
});

describe('custody source artifact real-Git contracts', () => {
  it('RECEIPT-CLOSED-SCHEMA fixes independent bytes, flags, nested fields and JSON domain', () => {
    const receipt = parseCustodySourceArtifactReceipt(fixtureReceipt());
    expect(custodySourceCanonicalBytes(receipt)).toBe(fixtureBytes);
    expect(createHash('sha256').update(custodySourceCanonicalBytes(receipt)).digest('hex'))
      .toBe(createHash('sha256').update(fixtureBytes).digest('hex'));
    expect(Object.isFrozen(receipt.capture.candidate.paths)).toBe(true);
    for (const key of ['publication', 'fullOutput', 'runtime', 'native', 'activation', 'workerRegistration', 'suiteStart', 'shipment']) {
      const value = fixtureReceipt(); value.qualifications[key] = true;
      expect(() => parseCustodySourceArtifactReceipt(value)).toThrow();
    }
    for (const value of [undefined, NaN, Infinity, 1n, Symbol('bad'), () => {}, new Date(), [, 1]]) {
      expect(() => custodySourceCanonicalBytes({ bad: value })).toThrow();
    }
    let accessed = false;
    const accessor = [1]; Object.defineProperty(accessor, '0', { enumerable: true, get: () => { accessed = true; return 1; } });
    expect(() => custodySourceCanonicalBytes(accessor)).toThrow(); expect(accessed).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => custodySourceCanonicalBytes(cycle)).toThrow();
    expect(() => custodySourceCanonicalBytes({ [Symbol('unknown')]: false })).toThrow();
    for (const key of ['ancestry', 'sourceCensus', 'compiler']) {
      const value = fixtureReceipt(); value.qualifications[key] = 'accepted';
      expect(() => parseCustodySourceArtifactReceipt(value)).toThrow();
    }
    for (const key of ['artifact', 'capture', 'objects', 'custody', 'qualifications']) {
      const value = fixtureReceipt(); value[key].extra = false;
      expect(() => parseCustodySourceArtifactReceipt(value)).toThrow();
    }
    const value = fixtureReceipt(); value.capture.candidate.extra = 'forbidden';
    expect(() => parseCustodySourceArtifactReceipt(value)).toThrow();
  });

  it('HANDOFF-SOURCE-LIMITS refuses changed separately retained authority and obligation vectors', () => {
    const expected = { recipients: [
      { role: 'source', authorityRef: 'WI-6554700010046610', ownerId: 'source-holder' },
      { role: 'metadata', authorityRef: 'plan:parent-pinned-workspace-metadata-coherence-2026-11-08', ownerId: 'metadata-holder' },
      { role: 'p001', authorityRef: 'WI-6554700010028547', ownerId: 'p001-holder' },
    ], remainingObligations: ['WI-6554700010047050', 'WI-10006055'] };
    const envelope = { schemaVersion: 'custody-source-handoff-v1', authority: 'source-only', receipt: fixtureReceipt(),
      receiptSha256: createHash('sha256').update(fixtureBytes).digest('hex'), ...structuredClone(expected) };
    expect(parseCustodySourceHandoff(envelope, expected).recipients).toEqual(expected.recipients);
    for (const mutate of [
      (v: typeof envelope) => { v.recipients[0].ownerId = 'replacement'; },
      (v: typeof envelope) => { v.recipients.reverse(); },
      (v: typeof envelope) => { v.remainingObligations.pop(); },
      (v: typeof envelope) => { v.remainingObligations.push(v.remainingObligations[0]); },
    ]) { const v = structuredClone(envelope); mutate(v); expect(() => parseCustodySourceHandoff(v, expected)).toThrow(); }
  });

  it('CAPTURE-REPLAY replays A after working B and removes only the owned view', async () => {
    const f = realFixture();
    const captured = await captureGitSyncCandidate(f.runGit, f.repo,
      { requestId: 'replay', generation: 1, base: f.base, paths: ['a.txt'] });
    if (!captured.ok) throw Error(captured.error);
    writeFileSync(join(f.repo, 'a.txt'), 'later B\n');
    const result = await withCustodySourceArtifact({ repository: f.repo, expectedCapture: { ref: captured.ref, candidate: captured.candidate },
      destination: f.destination, runGit: f.runGit, ownerId: 'fixture-owner', workItemRef: 'WI-6554700010047050',
      deadline: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal }, async scope => {
      await scope.verify(); expect(readFileSync(join(f.destination, 'a.txt'), 'utf8')).toBe('captured\n');
      return 'used';
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success' });
    expect(result.cleanup).toMatchObject({ exportersReleased: true, artifactRemoved: true, donorDeleted: false });
    expect(existsSync(f.destination)).toBe(false); expect(existsSync(f.repo)).toBe(true);
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe('later B\n');
  });

  it('CAPTURE-MISSING refuses absent custody without recapturing current working content', async () => {
    const f = realFixture(), c = await capture(f); f.git('update-ref', '-d', c.ref);
    const before = inventory(f.repo);
    const result = await withCustodySourceArtifact(options(f, c), async () => { throw Error('must not run'); });
    expectRefusal(f, result);
    expect(result.status === 'failed' && result.error.message).toContain('candidate-not-captured');
    expect(inventory(f.repo)).toEqual(before);
  });

  it('CAPTURE-TAMPERED refuses a changed retained manifest and preserves the original expectation', async () => {
    const f = realFixture(), c = await capture(f), original = independentJson(c);
    replaceManifest(f, c, independentJson({ ...c.candidate, generation: 2 }));
    expectRefusal(f, await withCustodySourceArtifact(options(f, c), async () => {}));
    expect(independentJson(c)).toBe(original);
  });

  it('CAPTURE-NONCANONICAL refuses whitespace, unknown fields, version changes and a response-shaped expectation', async () => {
    for (const defect of ['whitespace', 'unknown', 'version', 'response']) {
      const f = realFixture(), c = await capture(f), input = options(f, c);
      if (defect === 'whitespace') replaceManifest(f, c, JSON.stringify(c.candidate, null, 2) + '\n');
      if (defect === 'unknown') Reflect.set(input.expectedCapture, 'extra', false);
      if (defect === 'version') Reflect.set(input.expectedCapture.candidate, 'version', 3);
      if (defect === 'response') Reflect.set(input.expectedCapture, 'ok', true);
      const result = await withCustodySourceArtifact(input, async () => {}); expectRefusal(f, result);
      if (defect === 'whitespace') expect(result).toMatchObject({ error: { message: 'custody-manifest-noncanonical' } });
      if (defect === 'response') expect(result).toMatchObject({ error: { name: 'ZodError', message: expect.stringContaining('ok') } });
    }
  });

  it('CAPTURE-SUBSTITUTION refuses separately retained ref, tree and path substitutions', async () => {
    for (const defect of ['ref', 'tree', 'paths']) {
      const f = realFixture(), c = await capture(f);
      if (defect === 'ref') c.ref = 'refs/papercusp/source-custody/' + '0'.repeat(64);
      if (defect === 'tree') c.candidate.tree = c.candidate.baseTree;
      if (defect === 'paths') c.candidate.paths = ['package.json'];
      expectRefusal(f, await withCustodySourceArtifact(options(f, c), async () => {}));
    }
  });

  it('CAPTURE-REPOSITORY refuses another donor and symlink repository spelling', async () => {
    const f = realFixture(), other = realFixture(), c = await capture(f);
    expectRefusal(f, await withCustodySourceArtifact({ ...options(f, c), repository: other.repo }, async () => {}));
    const alias = join(f.root, 'alias'); symlinkSync(f.repo, alias);
    expectRefusal(f, await withCustodySourceArtifact({ ...options(f, c), repository: alias }, async () => {}));
  });

  it('CAPTURE-BASE requires a present commit parent with the exact retained base tree', async () => {
    for (const defect of ['null', 'missing', 'tree-mismatch']) {
      const f = realFixture();
      if (defect === 'null') f.git('update-ref', '-d', 'refs/heads/main');
      const c = await capture(f, defect === 'null' ? { base: null } : {});
      if (defect === 'missing') removeObject(f, f.base);
      if (defect === 'tree-mismatch') c.candidate.baseTree = c.candidate.tree;
      expectRefusal(f, await withCustodySourceArtifact(options(f, c), async () => {}));
    }
  });

  it('CAPTURE-OBJECT checks payload trees, descendant blobs and well-formed unavailable dependency trees before allocation', async () => {
    for (const defect of ['payload-tree', 'descendant-blob', 'dependency-tree', 'dependency-type']) {
      const f = realFixture(), dep = { requestId: 'prior', generation: 1, paths: ['a.txt'], tree: 'f'.repeat(40) };
      if (defect === 'dependency-type') dep.tree = f.git('rev-parse', f.base + ':a.txt');
      const c = await capture(f, defect.startsWith('dependency') ? { dependencies: [dep] } : {});
      if (defect === 'payload-tree') removeObject(f, c.candidate.tree);
      if (defect === 'descendant-blob') removeObject(f, f.git('rev-parse', c.candidate.tree + ':packages/core/index.ts'));
      expectRefusal(f, await withCustodySourceArtifact(options(f, c), async () => {}));
    }
  });

  it('EXPECTATION-FROZEN snapshots nested capture, runner, attribution and deadline before the first await', async () => {
    const f = realFixture(), c = await capture(f), original = structuredClone(c), input = options(f, c);
    const pending = withCustodySourceArtifact(input, async scope => {
      expect(scope.receipt.capture).toEqual(original);
      expect(scope.receipt.custody.ownerId).toBe('fixture-owner');
      expect(Object.isFrozen(scope.receipt.capture.candidate.paths)).toBe(true);
    });
    c.candidate.paths.push('package.json'); c.candidate.tree = c.candidate.baseTree;
    input.deadline = '1970-01-01T00:00:00.000Z'; input.ownerId = 'substitute';
    input.runGit = async () => { throw Error('substituted runner'); };
    expectSuccess(await pending);
  });

  it('DEPENDENCY-UNKNOWN-PRESERVED retains null-tree evidence byte for byte through the artifact receipt', async () => {
    const f = realFixture(), dep = { requestId: 'legacy', generation: 1, paths: ['a.txt'], tree: null };
    const c = await capture(f, { dependencies: [dep] });
    const result = await withCustodySourceArtifact(options(f, c), async scope => {
      expect(scope.receipt.capture.candidate.dependencies).toEqual([dep]);
      expect(Object.isFrozen(scope.receipt.capture.candidate.dependencies?.[0])).toBe(true);
    }); expectSuccess(result);
  });

  it('DEPENDENCY-UNKNOWN-NOT-QUALIFIED leaves ancestry, source census, compiler and downstream authority unqualified', async () => {
    const f = realFixture(), c = await capture(f, { dependencies: [{ requestId: 'legacy', generation: 1, paths: ['a.txt'], tree: null }] });
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
      const historic = parseCustodySourceArtifactReceipt(scope.receipt);
      expect(historic.objects.selfContained).toBe(false);
    }));
  });

  it('DEPENDENCY-MALFORMED rejects nested unknown keys, duplicate ids, unsafe paths, bad generations and version confusion', async () => {
    const f = realFixture(), c = await capture(f, { dependencies: [{ requestId: 'legacy', generation: 1, paths: ['a.txt'], tree: null }] });
    const changes = [
      (v: typeof c.candidate) => { Reflect.set(v.dependencies![0], 'extra', false); },
      (v: typeof c.candidate) => { v.dependencies!.push({ ...v.dependencies![0], generation: 2 }); },
      (v: typeof c.candidate) => { v.dependencies![0].paths = ['../a.txt']; },
      (v: typeof c.candidate) => { v.dependencies![0].paths = ['other.txt']; },
      (v: typeof c.candidate) => { v.dependencies![0].generation = 0; },
      (v: typeof c.candidate) => { v.version = 4; },
      (v: typeof c.candidate) => { Reflect.set(v, 'contentSource', { kind: 'generated-lock', extra: false }); },
    ];
    for (const change of changes) {
      const value = structuredClone(c.candidate); change(value);
      expect(() => parseGitSyncCandidateCapture(value)).toThrow();
      expectRefusal(f, await withCustodySourceArtifact(options(f, { ref: c.ref, candidate: value }), async () => {}));
    }
  });

  it('DEPENDENCY-CHANGED refuses historical dependency substitution even when the new tree exists', async () => {
    const f = realFixture(), c = await capture(f, { dependencies: [{ requestId: 'legacy', generation: 1, paths: ['a.txt'], tree: null }] });
    c.candidate.dependencies![0].tree = c.candidate.baseTree;
    expectRefusal(f, await withCustodySourceArtifact(options(f, c), async () => {}));
  });

  it('ARTIFACT-COMMIT-TREE is a genuine detached Git commit with exactly the captured tree and original parent', async () => {
    const f = realFixture(), c = await capture(f);
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      const r = spawnSync('git', ['show', '-s', '--format=%T %P', scope.receipt.artifact.commit], { cwd: f.destination, encoding: 'utf8' });
      expect(r.status).toBe(0); expect(r.stdout.trim()).toBe(c.candidate.tree + ' ' + f.base);
      expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: f.destination }).status).toBe(1);
      expect(spawnSync('git', ['remote'], { cwd: f.destination, encoding: 'utf8' }).stdout).toBe('');
    }));
  });

  it('SOURCE-ISOLATION preserves every donor file, index byte, object, ref, config and dirty working byte', async () => {
    const f = realFixture(), c = await capture(f);
    writeFileSync(join(f.repo, 'untracked.txt'), 'untracked B'); writeFileSync(join(f.repo, 'a.txt'), 'working B');
    const before = inventory(f.repo);
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => { await scope.verify(); }));
    expect(inventory(f.repo)).toEqual(before);
  });

  it('OWNED-FAILURE-CLEANUP joins rejection, abort, deadline and delayed children and reports removal/release failure truthfully', async () => {
    for (const mode of ['reject', 'abort', 'deadline', 'unjoined', 'remove-failure', 'release-failure', 'identity-drift']) {
      const f = realFixture(), c = await capture(f), input = options(f, c), controller = new AbortController();
      input.signal = controller.signal;
      let clock = Date.now(); input.now = () => clock; input.deadline = new Date(clock + 60_000).toISOString();
      if (mode === 'remove-failure') input.removeArtifact = async () => { throw Error('remove refused'); };
      let escaped: CustodySourceArtifactScope | undefined;
      const started = deferred(), cancelled = deferred(), finish = deferred(), released: string[] = [];
      const work = withCustodySourceArtifact(input, async scope => {
        escaped = scope;
        if (mode === 'identity-drift') {
          renameSync(f.destination, f.destination + '-retained'); mkdirSync(f.destination);
          writeFileSync(join(f.destination, 'peer'), 'must survive'); throw Error('replacement');
        }
        if (mode === 'remove-failure') return;
        const child = scope.use({ run: async ({ signal }) => {
          signal.addEventListener('abort', cancelled.resolve, { once: true });
          started.resolve(); await finish.promise;
          expect(existsSync(f.destination)).toBe(true); expect(existsSync(f.repo)).toBe(true);
          if (mode === 'abort' || mode === 'deadline' || mode === 'unjoined') expect(signal.aborted).toBe(true);
          if (mode === 'reject') throw Error('consumer rejected');
        }, release: async () => {
          expect(existsSync(f.destination)).toBe(true); released.push('exporter');
          if (mode === 'release-failure') throw Error('exporter release failed');
        } });
        // Attach a rejection observer immediately; joining is still the producer's obligation.
        void child.catch(() => {});
        if (mode === 'unjoined') await started.promise;
        else await child;
      });
      if (!['remove-failure', 'identity-drift'].includes(mode)) {
        await Promise.race([started.promise, work.then(result => { throw Error('consumer never started: ' + JSON.stringify(result)); })]);
        if (mode === 'abort') controller.abort();
        if (mode === 'deadline') { clock += 60_000; await expect(escaped!.verify()).rejects.toThrow(); }
        if (mode === 'unjoined') await cancelled.promise;
        expect(existsSync(f.destination)).toBe(true); finish.resolve();
      }
      const result = await work;
      expect(result, JSON.stringify(result)).toMatchObject({ status: mode === 'abort' || mode === 'deadline' ? 'aborted' : 'failed', cleanup: { donorDeleted: false } });
      expect(existsSync(f.repo)).toBe(true);
      await expect(escaped!.verify()).rejects.toThrow();
      expect(() => escaped!.use({ run: async () => {}, release: async () => {} })).toThrow();
      if (mode === 'remove-failure' || mode === 'release-failure' || mode === 'identity-drift') {
        expect(result.cleanup?.artifactRemoved).toBe(false); expect(existsSync(f.destination)).toBe(true);
      } else { expect(result.cleanup?.artifactRemoved).toBe(true); expect(released).toEqual(['exporter']); }
      if (mode === 'release-failure') expect(result.cleanup?.exportersReleased).toBe(false);
      if (mode === 'identity-drift') expect(readFileSync(join(f.destination, 'peer'), 'utf8')).toBe('must survive');
    }
  });

  it('DESTINATION-EXISTS preserves an existing peer directory unchanged', async () => {
    const f = realFixture(), c = await capture(f); mkdirSync(f.destination); writeFileSync(join(f.destination, 'peer'), 'retained');
    const before = inventory(f.destination);
    const result = await withCustodySourceArtifact(options(f, c), async () => {});
    expect(result).toMatchObject({ status: 'failed', cleanup: null }); expect(inventory(f.destination)).toEqual(before);
  });

  it('DESTINATION-UNSAFE refuses symlinks, symlink parents and a contained donor path without deleting another identity', async () => {
    for (const defect of ['symlink', 'parent', 'contained']) {
      const f = realFixture(), c = await capture(f), input = options(f, c), target = join(f.root, 'peer');
      mkdirSync(target); writeFileSync(join(target, 'retained'), 'peer bytes');
      if (defect === 'symlink') symlinkSync(target, f.destination);
      if (defect === 'parent') { const alias = join(f.root, 'parent'); symlinkSync(target, alias); input.destination = join(alias, 'child'); }
      if (defect === 'contained') input.destination = join(f.repo, 'child');
      const donorBefore = inventory(f.repo), peerBefore = inventory(target);
      const result = await withCustodySourceArtifact(input, async () => {});
      expect(result).toMatchObject({ status: 'failed', cleanup: null });
      expect(inventory(f.repo)).toEqual(donorBefore); expect(inventory(target)).toEqual(peerBefore);
    }
  });

  it('NO-EGRESS refuses a missing promisor descendant before allocation and never invokes hostile transport or hooks', async () => {
    {
      const f = realFixture(), c = await capture(f), trap = join(f.root, 'transport'), log = join(f.root, 'egress');
      writeFileSync(trap, '#!/bin/sh\nprintf transport >> "' + log + '"\nexit 1\n'); chmodSync(trap, 0o700);
      f.git('config', 'remote.origin.url', 'ext::' + trap); f.git('config', 'remote.origin.promisor', 'true');
      f.git('config', 'extensions.partialClone', 'origin'); f.git('config', 'protocol.ext.allow', 'always');
      f.git('config', 'core.fsmonitor', trap);
      const missing = f.git('rev-parse', c.candidate.tree + ':a.txt'); removeObject(f, missing);
      const result = await withCustodySourceArtifact(options(f, c), async () => {});
      expectRefusal(f, result); expect(existsSync(log)).toBe(false);
    }
    const profileKeys = ['GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
      'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_PARAMETERS', 'GIT_NO_REPLACE_OBJECTS', 'GIT_CONFIG_COUNT',
      ...Array.from({ length: 4 }, (_, i) => ['GIT_CONFIG_KEY_' + i, 'GIT_CONFIG_VALUE_' + i]).flat()];
    const profile = (env: NodeJS.ProcessEnv) => Object.fromEntries(profileKeys.map(key => [key, env[key]]));
    type GitObservation = { args: string[]; env: NodeJS.ProcessEnv };
    const exporterProgram = [
      "import childProcess from 'node:child_process';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const input = JSON.parse(process.argv[2]);',
      'const profile = env => Object.fromEntries(input.profileKeys.map(key => [key, env[key]]));',
      'const trace = { calls: [], env: profile(process.env), error: null };',
      'const original = childProcess.spawnSync;',
      'childProcess.spawnSync = (command, args, options) => {',
      "  if (command === 'git') trace.calls.push({ args, env: profile(options?.env ?? process.env) });",
      '  return original(command, args, options);',
      '};',
      'syncBuiltinESMExports();',
      'try {',
      '  const { prepareBgVerifierSource, verifyBgVerifierSource } = await import(process.argv[1]);',
      '  const prepared = await prepareBgVerifierSource(input.options);',
      "  verifyBgVerifierSource(prepared, 'before-build');",
      "  verifyBgVerifierSource(prepared, 'before-publication');",
      "  trace.source = readFileSync(input.options.dest + '/packages/core/index.ts', 'utf8');",
      "  if (input.fail) throw Error('fixture-exporter-failure');",
      '} catch (error) { trace.error = String(error); process.exitCode = 1; }',
      'finally { writeFileSync(process.argv[3], JSON.stringify(trace)); }',
    ].join('\n');
    // Keep complete-object controls: an early refusal cannot exercise these phases.
    for (const fault of [null, 'clone', 'commit-tree', 'checkout', 'exporter']) {
      const f = realFixture(), c = await capture(f), accepted = acceptedManifest(f);
      const trap = join(f.root, 'hostile'), log = join(f.root, 'egress'), hooks = join(f.root, 'hooks');
      const trapBytes = '#!/bin/sh\nprintf hostile >> "' + log + '"\nexit 1\n';
      writeFileSync(trap, trapBytes); chmodSync(trap, 0o700); mkdirSync(hooks);
      for (const hook of ['post-checkout', 'post-commit', 'pre-auto-gc']) {
        writeFileSync(join(hooks, hook), trapBytes); chmodSync(join(hooks, hook), 0o700);
      }
      f.git('config', 'remote.origin.url', 'ext::' + trap); f.git('config', 'remote.origin.promisor', 'true');
      f.git('config', 'extensions.partialClone', 'origin'); f.git('config', 'protocol.ext.allow', 'always');
      f.git('config', 'core.hooksPath', hooks); f.git('config', 'core.fsmonitor', trap);
      const globalConfig = join(f.root, 'global.gitconfig');
      writeFileSync(globalConfig, '[core]\nfsmonitor = ' + trap + '\nhooksPath = ' + hooks + '\n');
      const hostileEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_PARAMETERS: "'core.fsmonitor=" + trap + "'",
        GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'always',
        GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: hooks,
        GIT_CONFIG_KEY_2: 'submodule.recurse', GIT_CONFIG_VALUE_2: 'true',
        GIT_CONFIG_KEY_3: 'core.fsmonitor', GIT_CONFIG_VALUE_3: trap, GIT_SSH_COMMAND: trap };
      const calls: GitObservation[] = [], phases = ['show', 'cat-file', 'ls-tree', 'clone', 'commit-tree', 'checkout'];
      const input = options(f, c), exported = join(f.root, 'exported'), tracePath = join(f.root, 'exporter-trace.json');
      let injected = false, released = 0, exporterTrace: { calls: GitObservation[]; env: NodeJS.ProcessEnv; error: string | null; source?: string } | undefined;
      input.runGit = async (args, cwd, callOptions) => {
        const env = { ...hostileEnv, ...callOptions?.env };
        calls.push({ args: [...args], env: profile(env) });
        if (fault !== null && fault !== 'exporter' && args.includes(fault)) {
          injected = true; return { code: 1, stdout: '', stderr: 'fixture-' + fault + '-failure' };
        }
        return f.runGit(args, cwd, { ...callOptions, env });
      };
      const donorBefore = inventory(f.repo);
      const result = await withCustodySourceArtifact(input, async scope => {
        await scope.use({ run: async ({ receipt, env, signal }) => {
          const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', exporterProgram,
            new URL('../../../../../scripts/source-preview.mjs', import.meta.url).href,
            JSON.stringify({ profileKeys, fail: fault === 'exporter', options: { repo: f.destination,
              ref: receipt.artifact.commit, dest: exported, inputs: Object.keys(accepted.members), acceptedManifest: accepted } }), tracePath],
          { cwd: fileURLToPath(new URL('../../../../../', import.meta.url)), env: { ...hostileEnv, ...env },
            encoding: 'utf8', timeout: 30_000, signal });
          if (existsSync(tracePath)) exporterTrace = JSON.parse(readFileSync(tracePath, 'utf8'));
          if (fault === 'exporter' && exporterTrace?.error === 'Error: fixture-exporter-failure') injected = true;
          if (child.status !== 0) throw Error(child.error?.message ?? exporterTrace?.error ?? child.stderr);
        }, release: async () => { released++; rmSync(exported, { recursive: true, force: true }); } });
      });
      for (const call of [...calls, ...(exporterTrace?.calls ?? [])]) {
        expect(call.env).toMatchObject({ GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_PARAMETERS: '', GIT_NO_REPLACE_OBJECTS: '1' });
        const config = Object.fromEntries(Array.from({ length: Number(call.env.GIT_CONFIG_COUNT) }, (_, i) =>
          [call.env['GIT_CONFIG_KEY_' + i], call.env['GIT_CONFIG_VALUE_' + i]]));
        expect(config).toMatchObject({ 'protocol.allow': 'never', 'core.hooksPath': '/dev/null',
          'submodule.recurse': 'false', 'core.fsmonitor': 'false' });
        expect(call.args).not.toContain('protocol.allow=always');
      }
      for (const call of calls) expect(call.args.slice(0, 4)).toEqual(['-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null']);
      if (fault === null || fault === 'exporter') {
        expect(phases.every(phase => calls.some(call => call.args.includes(phase)))).toBe(true);
        expect(exporterTrace, JSON.stringify(result)).toBeDefined();
        expect(exporterTrace!.calls.length).toBeGreaterThan(0);
        expect(exporterTrace!.source).toBe('export const original = true;\n');
        expect(released).toBe(1);
      } else expect(released).toBe(0);
      if (fault === null) expectSuccess(result);
      else {
        expect(injected, JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({ status: 'failed', cleanup: { artifactRemoved: true, exportersReleased: true, donorDeleted: false } });
      }
      expect(inventory(f.repo)).toEqual(donorBefore); expect(existsSync(f.destination)).toBe(false);
      expect(existsSync(exported)).toBe(false); expect(existsSync(log)).toBe(false);
    }
  });

  it('BORROWED-OBJECT-LIFETIME retains donor/artifact through consumer and release, then refuses escaped or old-receipt authority', async () => {
    const f = realFixture(), c = await capture(f), started = deferred(), finish = deferred();
    let escaped: CustodySourceArtifactScope | undefined;
    const work = withCustodySourceArtifact(options(f, c), async scope => {
      escaped = scope;
      await scope.use({ run: async ({ receipt }) => {
        const alternates = readFileSync(join(f.destination, '.git/objects/info/alternates'), 'utf8').trim();
        expect(alternates).toBe(join(f.repo, '.git/objects'));
        expect(receipt.objects.selfContained).toBe(false); started.resolve(); await finish.promise;
        await scope.verify();
      }, release: async () => { expect(existsSync(f.destination)).toBe(true); expect(existsSync(f.repo)).toBe(true); } });
    });
    await Promise.race([started.promise, work.then(result => { throw Error('consumer never started: ' + JSON.stringify(result)); })]);
    expect(existsSync(f.destination)).toBe(true); finish.resolve();
    const result = await work; expectSuccess(result); expect(existsSync(f.repo)).toBe(true);
    if (!result.receipt) throw Error('missing receipt');
    expect(parseCustodySourceArtifactReceipt(result.receipt)).toEqual(result.receipt);
    await expect(escaped!.verify()).rejects.toThrow();

    const lost = realFixture(), retained = await capture(lost), hiddenDonor = join(lost.root, 'retained-donor');
    const donorBefore = inventory(lost.repo), releases: string[] = [];
    let refusedChildRan = false;
    const donorLost = await withCustodySourceArtifact(options(lost, retained), async scope => {
      await scope.use({ run: async () => {
        // Lose the borrowed objects while a registered consumer is actually live.
        renameSync(lost.repo, hiddenDonor);
        await expect(scope.verify()).rejects.toThrow();
        await expect(scope.use({ run: async () => { refusedChildRan = true; },
          release: async () => { releases.push('refused-child'); } })).rejects.toThrow();
      }, release: async () => {
        releases.push('live-child');
        expect(existsSync(lost.destination)).toBe(true); expect(existsSync(hiddenDonor)).toBe(true);
      } });
    });
    expect(donorLost).toMatchObject({ status: 'failed', cleanup: { exportersReleased: true, artifactRemoved: true, donorDeleted: false } });
    expect(refusedChildRan).toBe(false); expect(releases).toEqual(['refused-child', 'live-child']);
    expect(existsSync(lost.destination)).toBe(false); expect(existsSync(lost.repo)).toBe(false);
    expect(inventory(hiddenDonor)).toEqual(donorBefore);
  });

  it('EXPORT-INDEPENDENT-ACCEPTANCE uses unchanged source-only exporter with an independently retained literal source-blob map', async () => {
    const f = realFixture(), c = await capture(f), accepted = acceptedManifest(f), original = readFileSync(accepted.path);
    const dest = join(f.root, 'exported');
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      await scope.use({ run: async () => {
        const prepared = await prepareBgVerifierSource({ repo: f.destination, ref: scope.receipt.artifact.commit,
          dest, inputs: Object.keys(accepted.members), acceptedManifest: accepted });
        expect(verifyBgVerifierSource(prepared, 'before-build')).toBe(prepared);
        expect(verifyBgVerifierSource(prepared, 'before-publication')).toBe(prepared);
        expect(readFileSync(join(dest, 'packages/core/index.ts'), 'utf8')).toBe('export const original = true;\n');
        expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
      }, release: async () => { rmSync(dest, { recursive: true, force: true }); } });
      expect(readFileSync(accepted.path)).toEqual(original);
    })); expect(existsSync(dest)).toBe(false);
  });

  it('EXPORT-AUTHORITY-REFUSAL cannot replace absent, UNKNOWN, changed digest, schema, members or blobs with an adapter receipt', async () => {
    const f = realFixture(), c = await capture(f), accepted = acceptedManifest(f);
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      for (const defect of ['absent', 'unknown', 'digest', 'schema', 'member', 'blob', 'receipt']) {
        const expected = structuredClone(accepted), dest = join(f.root, 'refused-' + defect);
        if (defect === 'unknown') expected.evidenceRef = 'UNKNOWN';
        if (defect === 'digest') expected.sha256 = '0'.repeat(64);
        if (defect === 'schema') Reflect.set(expected, 'schemaVersion', 2);
        if (defect === 'member') Reflect.deleteProperty(expected.members, 'packages/core/index.ts');
        if (defect === 'blob') {
          expected.members['packages/core/index.ts'] = 'f'.repeat(40);
          const bytes = JSON.stringify({ schemaVersion: 1, sourceBlobs: expected.members });
          expected.path = join(f.root, 'wrong-blob.json'); writeFileSync(expected.path, bytes);
          expected.sha256 = createHash('sha256').update(bytes).digest('hex');
        }
        await expect(prepareBgVerifierSource({ repo: f.destination, ref: scope.receipt.artifact.commit,
          dest, inputs: Object.keys(accepted.members),
          // @ts-expect-error Deliberately malformed authority must fail before allocation.
          acceptedManifest: defect === 'absent' ? undefined : defect === 'receipt' ? scope.receipt : expected }))
          .rejects.toThrow(/BG/);
        expect(existsSync(dest)).toBe(false);
      }
    }));
  });

  it('GITLINK-UNKNOWN-NOT-MATERIALIZED keeps a real 160000 entry with a missing target unqualified and adds no hidden donor', async () => {
    const f = realFixture(), missing = 'f'.repeat(40);
    f.git('update-index', '--add', '--cacheinfo', '160000,' + missing + ',vendor');
    f.git('commit', '-m', 'missing gitlink target'); f.base = f.git('rev-parse', 'HEAD');
    const c = await capture(f);
    expectSuccess(await withCustodySourceArtifact(options(f, c), async scope => {
      const entry = spawnSync('git', ['ls-tree', scope.receipt.artifact.commit, 'vendor'], { cwd: f.destination, encoding: 'utf8' });
      expect(entry.status).toBe(0); expect(entry.stdout).toBe('160000 commit ' + missing + '\tvendor\n');
      expect(spawnSync('git', ['cat-file', '-e', missing], { cwd: f.destination }).status).not.toBe(0);
      expect(existsSync(join(f.destination, '.git/modules'))).toBe(false);
      expect(!existsSync(join(f.destination, 'vendor')) || readdirSync(join(f.destination, 'vendor')).length === 0).toBe(true);
      expect(scope.receipt.objects.donorRepository).toBe(join(f.repo, '.git'));
      expect(scope.receipt.qualifications).toEqual(fixtureReceipt().qualifications);
    }));
  });
});
