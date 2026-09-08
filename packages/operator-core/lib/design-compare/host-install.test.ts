import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filesystemReferenceMaterializer } from './host-install';
import { createInMemoryReferenceStore } from './reference-store';
import { compareRenderVerb, ratifyReferenceVerb, type VerbDeps } from './verbs';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const image = (locator: string) => ({
  locator, mediaType: 'image/png' as const, byteLength: 8, width: 1, height: 1,
});

describe('approved reference byte measurement', () => {
  it('re-measures changed bytes behind an unchanged file locator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-approval-test-'));
    cleanup.push(dir);
    const path = join(dir, 'reference.png');
    await writeFile(path, 'approved');
    const first = await filesystemReferenceMaterializer(image(path));
    expect(first).toMatchObject({ path, contentSha256: createHash('sha256').update('approved').digest('hex') });
    await writeFile(path, 'replaced');
    const second = await filesystemReferenceMaterializer(image(`file://${path}`));
    expect(second).toMatchObject({ path, contentSha256: createHash('sha256').update('replaced').digest('hex') });
    expect(first).not.toEqual(second);
  });

  it('hashes decoded data bytes and releases only its temporary materialization', async () => {
    const result = await filesystemReferenceMaterializer(image(`data:image/png;base64,${Buffer.from('approved').toString('base64')}`));
    if ('error' in result) throw new Error(result.error);
    cleanup.push(result.path);
    expect(result.contentSha256).toBe(createHash('sha256').update('approved').digest('hex'));
    await expect(access(result.path)).resolves.toBeUndefined();
    expect(result.release).toBeTypeOf('function');
    await result.release!();
    await expect(access(result.path)).rejects.toThrow();
  });

  it('does not manufacture a measured hash for an unreadable locator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'design-approval-test-'));
    cleanup.push(dir);
    expect(await filesystemReferenceMaterializer(image(join(dir, 'absent.png')))).toHaveProperty('error');
  });

  it('comparison evidence retains its stored reference after the temporary decode is released', async () => {
    const locator = `data:image/png;base64,${Buffer.from('approved').toString('base64')}`;
    const env = { viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, browser: 'chromium', theme: 'light', fontSet: 'fixture', state: 'disconnected' };
    const caller = { actorId: 'test-reviewer', role: 'reviewer' };
    const deps: VerbDeps = {
      // This test isolates materialization; rollout admission has its own real-reader suite.
      rolloutAdmission: async () => ({ satisfied: true, reason: 'controlled-admission' }),
      harnessSlug: 'test', store: createInMemoryReferenceStore(), now: () => 1000,
      clock: () => '2026-09-08T00:00:00.000Z', materializeReferenceImage: filesystemReferenceMaterializer,
      comparison: {
        provider: { engine: { engine: 'fixture', engineVersion: '1' }, compare: async () => ({ pixelDifference: 0, diffArtifactWritten: true }) },
        probe: () => ({ exists: true, dimensions: { width: 1, height: 1 } }),
      },
    };
    expect(await ratifyReferenceVerb({
      featureId: 'design-plan', referenceId: 'desktop', revision: 1, referenceClass: 'artifact-capture',
      contentSha256: createHash('sha256').update('approved').digest('hex'), image: image(locator),
      referenceEnvironment: env,
      requiredCases: [{ caseId: 'disconnected', environment: env, target: { targetKind: 'page-route', targetId: '/desktops' }, rationale: 'truthful empty state' }],
      provenance: { source: 'artifact-capture', sourceRef: 'fixture-original' },
      approval: { schemaVersion: 1, approvalRef: 'fixture-approval', planSlug: 'design-plan', planItemIds: ['P-001'], targetRoute: '/desktops' },
    }, caller, deps)).toMatchObject({ ok: true });
    const compared = await compareRenderVerb({
      featureId: 'design-plan', referenceId: 'desktop',
      target: { targetKind: 'page-route', targetId: '/desktops', implementationRevision: 'fixture-1' }, environment: env,
      policy: { policyVersion: 'fixture-1', referenceClass: 'artifact-capture', eligibility: 'gateable', maxDiffRatio: 0, derivedFrom: 'fixture' },
      actualImagePath: '/tmp/fixture-actual.png', diffImagePath: '/tmp/fixture-diff.png',
    }, caller, deps);
    if (!compared.ok) throw new Error(compared.detail);
    expect(compared.result.artifacts?.referenceImage).toBe(locator);
  });
});
