import { describe, expect, it } from 'vitest';
import {
  INSTALLED_BOUNDARY_CASE, REQUIRED_UNRESOLVED_CHECKS, SOURCE_IDENTITY_CASE,
  checkPrepHandback, summarizeCase, type PrepHandback, type PrepHandbackDeps,
} from './check';

const sha = (c: string) => c.repeat(40);
const PARENT = sha('a');
const CHILD = sha('b');
const BASE = sha('c');
const TESTED_PARENT = sha('d');
const TESTED_CHILD = sha('e');
const BRIDGE = 'native/gnome/bridge.js';
const TEST = 'test/native-workbench-gnome.test.mjs';
const HASH = '6'.repeat(64);

function handback(): PrepHandback {
  return {
    schemaVersion: 1, kind: 'workbench-prep-handback', plan: 'plan-x', fromItem: 'P-006', toItem: 'P-002',
    clause: { specId: 'PREP-UBUNTU', revision: 2, contentHash: HASH },
    source: {
      parentCommit: PARENT, submodulePath: 'papercusp-desktop', childCommit: CHILD,
      change: { base: BASE, head: CHILD },
      identities: [{ path: BRIDGE, blob: sha('1') }, { path: TEST, blob: sha('2') }],
    },
    regressions: [{ testRunId: 7, filePath: `papercusp-desktop/${TEST}` }],
    unresolvedChecks: REQUIRED_UNRESOLVED_CHECKS.map((c) => ({ ...c, status: 'unresolved', owner: 'P-002', detail: 'd' })),
    claims: { acceptance: false, installed: false, currentMain: false },
    sequence: ['P-001', 'P-002', 'P-003'],
    sourcePosts: [1229390],
  };
}

function deps(over: Partial<PrepHandbackDeps> = {}): PrepHandbackDeps {
  const blobs: Record<string, string> = {
    [`${CHILD}:${BRIDGE}`]: sha('1'), [`${CHILD}:${TEST}`]: sha('2'),
    [`${TESTED_CHILD}:${BRIDGE}`]: sha('1'), [`${TESTED_CHILD}:${TEST}`]: sha('2'),
  };
  const links: Record<string, string> = { [PARENT]: CHILD, [TESTED_PARENT]: TESTED_CHILD };
  return {
    gitlink: async (commit) => links[commit] ?? null,
    blob: async (_sub, commit, path) => blobs[`${commit}:${path}`] ?? null,
    changedFiles: async () => [BRIDGE, TEST],
    registeredSuites: async () => [`node bin/run.mjs ${TEST} test/other.test.mjs`],
    testRun: async (id) => (id === 7 ? { id, filePath: `papercusp-desktop/${TEST}`, status: 'pass', worktreeDirty: false, commitSha: TESTED_PARENT } : null),
    clause: async () => ({ revision: 2, contentHash: HASH, planItemId: 'P-006', requiredScenarios: [SOURCE_IDENTITY_CASE, INSTALLED_BOUNDARY_CASE] }),
    ...over,
  };
}

async function verdict(h: unknown, d = deps()) {
  const [source, boundary] = await checkPrepHandback(h, d);
  const failed = (r: typeof source) => r.checks.filter((c) => !c.passed).map((c) => c.id);
  return { source: source.passed, boundary: boundary.passed, sourceFailed: failed(source), boundaryFailed: failed(boundary) };
}

describe('checkPrepHandback — valid handback', () => {
  it('passes both exact case ids', async () => {
    const results = await checkPrepHandback(handback(), deps());
    expect(results.map((r) => [r.id, r.passed])).toEqual([[SOURCE_IDENTITY_CASE, true], [INSTALLED_BOUNDARY_CASE, true]]);
    expect(summarizeCase(results[0])).toMatch(/^\d+\/\d+ checks passed$/);
  });
});

describe('source-identity-handoff — invalid fixtures', () => {
  it('fails on a wrong blob', async () => {
    const h = handback(); h.source.identities[0].blob = sha('9');
    const v = await verdict(h);
    expect(v.source).toBe(false);
    expect(v.sourceFailed).toContain(`blob.${BRIDGE}`);
    expect(v.boundary).toBe(true);
  });
  it('fails on a missing identity', async () => {
    const h = handback(); h.source.identities.pop();
    expect((await verdict(h)).sourceFailed).toContain('identities.equal-changed-population');
  });
  it('fails on an extra identity', async () => {
    const h = handback(); h.source.identities.push({ path: 'native/gnome/other.js', blob: sha('3') });
    const v = await verdict(h);
    expect(v.sourceFailed).toEqual(expect.arrayContaining(['identities.equal-changed-population', 'blob.native/gnome/other.js']));
  });
  it('fails on a duplicate identity', async () => {
    const h = handback(); h.source.identities.push({ ...h.source.identities[0] });
    expect((await verdict(h)).sourceFailed).toContain('identities.unique');
  });
  it('fails when the parent does not pin the child', async () => {
    const v = await verdict(handback(), deps({ gitlink: async (c) => (c === PARENT ? sha('f') : TESTED_CHILD) }));
    expect(v.sourceFailed).toContain('gitlink.parent-pins-child');
  });
  it('fails when the change head is not the pinned child', async () => {
    const h = handback(); h.source.change.head = BASE;
    expect((await verdict(h)).sourceFailed).toContain('change.head-is-pinned-child');
  });
  it('fails when the clause hash or scenarios do not match', async () => {
    const h = handback(); h.clause.contentHash = '7'.repeat(64);
    expect((await verdict(h)).sourceFailed).toContain('clause.pinned');
    const v = await verdict(handback(), deps({ clause: async () => ({ revision: 2, contentHash: HASH, planItemId: 'P-006', requiredScenarios: [SOURCE_IDENTITY_CASE] }) }));
    expect(v.sourceFailed).toContain('clause.requires-scenarios');
  });
  it('fails with no regression refs', async () => {
    const h = handback(); h.regressions = [];
    expect((await verdict(h)).sourceFailed).toContain('regressions.present');
  });
  it.each([
    ['a failing row', { status: 'fail' }],
    ['a dirty row', { worktreeDirty: true }],
    ['an unregistered suite', { filePath: 'papercusp-desktop/test/unregistered.test.mjs' }],
    ['a row that tested other bytes', { commitSha: sha('0') }],
  ])('fails on %s', async (_label, patch) => {
    const d = deps();
    const base = await d.testRun(7);
    const v = await verdict(handback(), deps({ testRun: async () => ({ ...base!, ...patch }) }));
    expect(v.sourceFailed).toContain('regression.7');
  });
  it('fails on an unknown test run id', async () => {
    const h = handback(); h.regressions[0].testRunId = 8;
    expect((await verdict(h)).sourceFailed).toContain('regression.8');
  });
});

describe('unverified-installed-boundary — invalid fixtures', () => {
  it.each(REQUIRED_UNRESOLVED_CHECKS.map((c) => c.id))('fails when %s is absent', async (id) => {
    const h = handback(); h.unresolvedChecks = h.unresolvedChecks.filter((c) => c.id !== id);
    const v = await verdict(h);
    expect(v.boundary).toBe(false);
    expect(v.boundaryFailed).toContain(`required.${id}`);
    expect(v.source).toBe(true);
  });
  it('fails when a required check is marked accepted', async () => {
    const h = handback(); h.unresolvedChecks[3].status = 'accepted';
    expect((await verdict(h)).boundaryFailed).toEqual(expect.arrayContaining([`required.${h.unresolvedChecks[3].id}`, 'unresolved.none-marked-resolved']));
  });
  it('fails when an extra check is marked passed', async () => {
    const h = handback(); h.unresolvedChecks.push({ id: 'installed.extra', scope: 'installed-candidate', status: 'passed', owner: 'P-002', detail: 'd' });
    expect((await verdict(h)).boundaryFailed).toEqual(['unresolved.none-marked-resolved']);
  });
  it('fails on a wrong scope or a missing owner', async () => {
    const h = handback(); h.unresolvedChecks[0].scope = 'installed-candidate'; h.unresolvedChecks[1].owner = '';
    expect((await verdict(h)).boundaryFailed).toEqual(expect.arrayContaining([`required.${h.unresolvedChecks[0].id}`, `required.${h.unresolvedChecks[1].id}`]));
  });
  it('fails on a duplicate check', async () => {
    const h = handback(); h.unresolvedChecks.push({ ...h.unresolvedChecks[0] });
    expect((await verdict(h)).boundaryFailed).toContain('unresolved.unique');
  });
  it.each(['acceptance', 'installed', 'currentMain'] as const)('fails when claims.%s is not false', async (key) => {
    const h = handback(); (h.claims as Record<string, unknown>)[key] = true;
    expect((await verdict(h)).boundaryFailed).toEqual([`claims.${key}`]);
  });
  it('fails on a reordered sequence', async () => {
    const h = handback(); h.sequence = ['P-002', 'P-001', 'P-003'];
    expect((await verdict(h)).boundaryFailed).toEqual(['sequence.p001-p002-p003']);
  });
});

describe('malformed handback', () => {
  it.each([
    ['null', null],
    ['wrong kind', { ...handback(), kind: 'other' }],
    ['short sha', { ...handback(), source: { ...handback().source, childCommit: 'abc' } }],
    ['no identities', { ...handback(), source: { ...handback().source, identities: [] } }],
  ])('fails both cases on %s', async (_label, value) => {
    const v = await verdict(value);
    expect([v.source, v.boundary]).toEqual([false, false]);
    expect(v.sourceFailed).toEqual(['shape']);
  });
});
