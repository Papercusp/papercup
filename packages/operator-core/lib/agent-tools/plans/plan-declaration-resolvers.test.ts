import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDiscoveryAuditContext } from './plan-declaration-resolvers';


const ref = 'source:observed.ts';
const content = `## Discovery\n\n\`\`\`discovery\n${JSON.stringify({ questions: [],
  findings: [{ id: 'F-1', questions: [], conclusion: 'Retain the measured source observation.',
    evidenceRefs: [ref], dispositions: [{ target: 'section:Discovery', decision: 'unchanged',
      reason: 'Retain the observed source.' }] }], notApplicable: 'Bounded source review.' })}\n\`\`\`\n`;
const options = { repoRoot: null, sql: {} as never, workspaceId: 'workspace-a',
  harnessSlug: 'papercusp', ownerId: 'reader', planSlug: 'subject' };

describe('discovery source-path evidence', () => {
  it('measures an admitted source file even when no research trail was captured', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'discovery-source-no-trail-'));
    const sourcePath = 'observed.ts';
    const sourceText = 'export const observed = true;\n';
    const sourceRef = `source:${sourcePath}`;
    writeFileSync(join(repoRoot, sourcePath), sourceText);

    try {
      const context = await resolveDiscoveryAuditContext(content.replace(ref, sourceRef), null, {
        ...options,
        repoRoot,
      });

      expect(context.evidence).toEqual([{
        ref: sourceRef,
        state: 'current',
        usable: true,
        fingerprint: createHash('sha256').update(sourceText).digest('hex'),
      }]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// EI-28781813683751020: discovery evidence follows the committed blob, as the ship gate's
// CitationMeasurement does — an uncommitted peer edit on the shared tree must not stale a
// finding, a committed change must, and a clean file keeps its pre-change fingerprint.
describe('discovery source-path evidence at committed HEAD', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const committedText = 'export const observed = 1;\n';
  const measure = async (repoRoot: string) => (await resolveDiscoveryAuditContext(content, null,
    { ...options, repoRoot })).evidence;
  let repoRoot = '';

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'discovery-source-committed-'));
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 'test@example.invalid');
    git(repoRoot, 'config', 'user.name', 'test');
    git(repoRoot, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repoRoot, 'observed.ts'), committedText);
    git(repoRoot, 'add', 'observed.ts');
    git(repoRoot, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('keeps the existing fingerprint for a clean committed file', async () => {
    expect(await measure(repoRoot)).toEqual([{ ref, state: 'current', usable: true, fingerprint: sha256(committedText) }]);
  });

  it('ignores an uncommitted edit to the cited file', async () => {
    writeFileSync(join(repoRoot, 'observed.ts'), 'export const observed = 2; // peer edit in flight\n');
    expect((await measure(repoRoot))[0]?.fingerprint).toBe(sha256(committedText));
  });

  it('stales on a committed change to the cited file', async () => {
    const changed = 'export const observed = 3;\n';
    writeFileSync(join(repoRoot, 'observed.ts'), changed);
    git(repoRoot, 'commit', '-q', '-am', 'change');
    const [row] = await measure(repoRoot);
    expect(row?.fingerprint).toBe(sha256(changed));
    expect(row?.fingerprint).not.toBe(sha256(committedText));
  });

  it('measures an untracked cited file from the working tree', async () => {
    const untracked = 'export const fresh = true;\n';
    writeFileSync(join(repoRoot, 'fresh.ts'), untracked);
    const evidence = (await resolveDiscoveryAuditContext(content.replace(ref, 'source:fresh.ts'), null,
      { ...options, repoRoot })).evidence;
    expect(evidence).toEqual([{ ref: 'source:fresh.ts', state: 'current', usable: true, fingerprint: sha256(untracked) }]);
  });
});
