/**
 * WI-6554700010049338: discovery `source:` evidence was fingerprinted over the WHOLE file,
 * so on a busy hub file every committed change anywhere in it re-staled a finding and
 * plans:start could not converge. `source:<path>#<Symbol>` (or `#<Class.member>`) now
 * fingerprints only the cited declaration, measured at committed HEAD like whole-file refs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessDiscovery } from '../../plan-audits';
import { declarationFingerprint, parseSourceEvidenceRef, resolveDiscoveryAuditContext } from './plan-declaration-resolvers';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const discoveryCiting = (ref: string) => `## Discovery\n\n\`\`\`discovery\n${JSON.stringify({ questions: [],
  findings: [{ id: 'F-1', questions: [], conclusion: 'Retain the measured source observation.',
    evidenceRefs: [ref], dispositions: [{ target: 'section:Discovery', decision: 'unchanged',
      reason: 'Retain the observed source.' }] }], notApplicable: 'Bounded source review.' })}\n\`\`\`\n`;
const options = { sql: {} as never, workspaceId: 'workspace-a', harnessSlug: 'papercusp', ownerId: 'reader',
  planSlug: 'subject' };

const alpha = 'export function alpha(): number { return 1; }';
const hub = (alphaBody: string, betaBody: string) => [
  '// a hub file many agents commit to',
  alphaBody,
  `export function beta(): number { return ${betaBody}; }`,
  'export class Store {',
  '  read(): string { return "r"; }',
  '  write(): void {}',
  '}',
  '',
].join('\n');

describe('parseSourceEvidenceRef', () => {
  it('keeps a whole-file ref, splits a symbol or member anchor, and reports a malformed one', () => {
    expect(parseSourceEvidenceRef('source:lib/a.ts')).toEqual({ path: 'lib/a.ts', anchor: null });
    expect(parseSourceEvidenceRef('source:lib/a.ts#alpha')).toEqual({ path: 'lib/a.ts', anchor: 'alpha' });
    expect(parseSourceEvidenceRef('source:lib/a.ts#Store.read')).toEqual({ path: 'lib/a.ts', anchor: 'Store.read' });
    const bad = parseSourceEvidenceRef('source:lib/a.ts#L12-L40');
    expect(bad).toMatchObject({ path: 'lib/a.ts', anchor: null });
    expect(bad.anchorError).toContain("'#L12-L40'");
  });
});

describe('declarationFingerprint', () => {
  const fingerprint = (text: string, anchor: string) => declarationFingerprint('hub.ts', text, anchor);

  it('is the sha256 of the cited declaration text only', () => {
    expect(fingerprint(hub(alpha, '2'), 'alpha')).toEqual({ fingerprint: sha256(alpha) });
  });

  it('ignores changes outside the declaration and follows changes inside it', () => {
    const before = fingerprint(hub(alpha, '2'), 'alpha');
    expect(fingerprint(hub(alpha, '3'), 'alpha')).toEqual(before);
    expect(fingerprint(hub('export function alpha(): number { return 9; }', '2'), 'alpha')).not.toEqual(before);
  });

  it('measures one class member without the rest of the class', () => {
    const before = fingerprint(hub(alpha, '2'), 'Store.read');
    const otherMemberChanged = hub(alpha, '2').replace('write(): void {}', 'write(): void { return; }');
    expect(fingerprint(otherMemberChanged, 'Store.read')).toEqual(before);
    expect(fingerprint(hub(alpha, '2').replace('return "r"', 'return "R"'), 'Store.read')).not.toEqual(before);
  });

  it('includes every overload of the cited name', () => {
    const overloads = 'export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: unknown) { return a; }\n';
    const before = fingerprint(overloads, 'f');
    expect(fingerprint(overloads.replace('a: number): number', 'a: boolean): boolean'), 'f')).not.toEqual(before);
  });

  it('reports a missing symbol, a missing member and an unparseable language instead of a fingerprint', () => {
    expect(fingerprint(hub(alpha, '2'), 'gamma')).toMatchObject({ reason: expect.stringContaining('#gamma') });
    expect(fingerprint(hub(alpha, '2'), 'Store.remove')).toMatchObject({ reason: expect.stringContaining('#Store.remove') });
    expect(declarationFingerprint('notes.md', '# alpha', 'alpha')).toMatchObject({
      reason: expect.stringContaining('TypeScript/JavaScript') });
  });
});

describe('symbol-anchored discovery evidence at committed HEAD', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const ref = 'source:hub.ts#alpha';
  const measure = async (citing = ref) =>
    (await resolveDiscoveryAuditContext(discoveryCiting(citing), null, { ...options, repoRoot })).evidence;
  const commit = (text: string, message: string) => {
    writeFileSync(join(repoRoot, 'hub.ts'), text);
    git(repoRoot, 'commit', '-q', '-am', message);
  };
  let repoRoot = '';

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'discovery-source-anchor-'));
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'test@example.invalid');
    git(repoRoot, 'config', 'user.name', 'test');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repoRoot, 'hub.ts'), hub(alpha, '2'));
    git(repoRoot, 'add', 'hub.ts');
    git(repoRoot, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('stays fresh across a committed change to an uncited declaration in the same file', async () => {
    const [before] = await measure();
    expect(before).toEqual({ ref, state: 'current', usable: true, fingerprint: sha256(alpha) });
    commit(hub(alpha, '3'), 'peer changes beta');
    expect(await measure()).toEqual([before]);
    // The whole-file ref of the same file does move, which is exactly what used to re-stale.
    const [wholeBefore] = await measure('source:hub.ts');
    commit(hub(alpha, '4'), 'peer changes beta again');
    expect((await measure('source:hub.ts'))[0]?.fingerprint).not.toBe(wholeBefore?.fingerprint);
  });

  it('stales on a committed change to the cited declaration, and ignores an uncommitted one', async () => {
    const changedAlpha = 'export function alpha(): number { return 7; }';
    writeFileSync(join(repoRoot, 'hub.ts'), hub(changedAlpha, '2'));
    expect((await measure())[0]?.fingerprint).toBe(sha256(alpha));
    git(repoRoot, 'commit', '-q', '-am', 'change alpha');
    expect((await measure())[0]?.fingerprint).toBe(sha256(changedAlpha));
  });

  it('marks a missing or malformed anchor unknown and unusable, never as a whole-file pass', async () => {
    for (const citing of ['source:hub.ts#gamma', 'source:hub.ts#L1-L3']) {
      expect(await measure(citing)).toEqual([{ ref: citing, state: 'unknown', usable: false, fingerprint: null,
        reason: expect.stringMatching(/#(gamma|L1-L3)/) }]);
    }
  });

  it('measures an untracked anchored file from the working tree', async () => {
    writeFileSync(join(repoRoot, 'fresh.ts'), `${alpha}\n`);
    expect(await measure('source:fresh.ts#alpha')).toEqual([{ ref: 'source:fresh.ts#alpha', state: 'current',
      usable: true, fingerprint: sha256(alpha) }]);
  });
});

describe('discovery stale blocker hint', () => {
  const restale = (ref: string) => {
    const content = discoveryCiting(ref);
    const evidenceAt = (fingerprint: string) => ({ targets: [], evidence: [{ ref, state: 'current' as const, usable: true, fingerprint }] });
    const previous = assessDiscovery(content, evidenceAt('a'.repeat(64)));
    return assessDiscovery(content, evidenceAt('b'.repeat(64)), previous).readiness.blockers
      .find(blocker => blocker.path === 'findings.F-1');
  };

  it('tells a whole-file citer how to anchor the finding to a declaration', () => {
    const blocker = restale('source:hub.ts');
    expect(blocker?.code).toBe('discovery_evidence_unusable');
    expect(blocker?.detail).toContain('source:hub.ts is cited as a whole file');
    expect(blocker?.detail).toContain('source:<path>#<Symbol>');
  });

  it('does not repeat the hint for an already-anchored ref', () => {
    const blocker = restale('source:hub.ts#alpha');
    expect(blocker?.code).toBe('discovery_evidence_unusable');
    expect(blocker?.detail).not.toContain('cited as a whole file');
  });
});
