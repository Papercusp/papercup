import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import createTool from '../../identities/create';
import getTool from '../../identities/get';
import listTool from '../../identities/list';
import validateTool from '../../identities/validate';
import { _resetPapercuspRootForTests } from '../../../papercusp-root';

const CTX = { log() {}, workspaceId: 'ws', role: 'operator' } as never;
const run = async (tool: { handler: (a: never, c: never) => Promise<unknown> }, args: Record<string, unknown>) =>
  JSON.parse(((await tool.handler(args as never, CTX)) as { content: { text: string }[] }).content[0].text);

describe('identity authoring through blueprint views', () => {
  let root: string;
  let priorHome: string | undefined;
  let repoDir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'identity-tools-'));
    repoDir = join(root, 'repo');
    priorHome = process.env.PAPERCUSP_HOME;
    process.env.PAPERCUSP_HOME = join(root, 'installed');
    _resetPapercuspRootForTests();
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = priorHome;
    _resetPapercuspRootForTests();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(id: string, source: Record<string, unknown>, tier: 'local' | 'installed' = 'local') {
    const dir = tier === 'local' ? join(repoDir, '.papercusp', 'blueprints', id) : join(root, 'installed', 'blueprints', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'blueprint.yaml'), stringify(source));
  }
  const source = { id: 'zz-identity', slots: [{ slot: 'practice' }], description: 'Source only' };

  it('creates canonical source YAML without default-filling or persisting a runnable blueprint', async () => {
    const result = await run(createTool, { identity: source, repoDir });
    expect(result.ok).toBe(true);
    expect(result.runnable).toBe(false);
    expect(parse(result.yaml)).toEqual(source);
    expect(result.contentHash).toBe(layerContentHash(source));
    expect(result.contentHashScope).toBe('source-document');
    expect(await fs.readdir(root)).toEqual([]);
    const roundTrip = await run(validateTool, { source: result.yaml, repoDir });
    expect(roundTrip.ok).toBe(true);
  });

  it('does not turn inherited slots into authored identity metadata', async () => {
    await write(source.id, source);
    const pot = { id: 'zz-pot', extends: source.id, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };
    await write(pot.id, pot);
    expect(await run(getTool, { id: pot.id, repoDir })).toMatchObject({ ok: false, error: 'not-an-identity' });
    expect(await run(createTool, { identity: pot, repoDir })).toMatchObject({ ok: false, error: 'not-an-identity' });
    const listed = await run(listTool, { repoDir, after: 'zy', limit: 100 });
    expect(listed.identities.map((entry: { id: string }) => entry.id)).toEqual([source.id]);
  });

  it('gets a local source through the existing resolver, keeping parent fields out of the author document', async () => {
    await write('zz-parent', { id: 'zz-parent', slots: [{ slot: 'practice' }], description: 'parent' });
    const child = { id: source.id, extends: 'zz-parent', slots: [] };
    await write(source.id, child);
    const result = await run(getTool, { id: source.id, repoDir });
    expect(result.ok).toBe(true);
    expect(result.identity).toEqual(child);
    expect(result.identity).not.toHaveProperty('description');
    expect(result.layers.map((layer: { id: string }) => layer.id)).toEqual(['zz-parent', source.id]);
  });

  it('discovers the named SU composition and GOAL/GRADE/TEST built-ins through the existing catalog', async () => {
    const su = await run(getTool, { id: 'su' });
    expect(su).toMatchObject({ ok: true, sourceKind: 'identity', runnable: false });
    expect(su.layers.map((layer: { id: string }) => layer.id)).toEqual(expect.arrayContaining([
      'papercusp-engineer', 'su-collaborator', 'su.practice', 'su',
    ]));
    for (const id of ['su.mode-goal', 'su.mode-grade', 'su.mode-test']) {
      const result = await run(getTool, { id });
      expect(result).toMatchObject({ ok: true, sourceKind: 'identity', runnable: false });
      expect(result.identity.mode.policyRef).toBe(id.slice('su.mode-'.length));
    }
    const page = await run(listTool, { after: 'su.mode-drain', limit: 15 });
    for (const id of ['su.mode-goal', 'su.mode-grade', 'su.mode-test']) {
      expect(page.identities.map((entry: { id: string }) => entry.id)).toContain(id);
    }
  });

  it('honors local shadowing and never reveals an installed identity behind a plain local source', async () => {
    await write(source.id, { ...source, attestation: { contentHash: layerContentHash(source), signedBy: 'publisher' } }, 'installed');
    expect((await run(getTool, { id: source.id })).ok).toBe(true);
    await write(source.id, { id: source.id, description: 'ordinary blueprint' });
    expect((await run(getTool, { id: source.id, repoDir })).error).toBe('not-an-identity');
    expect((await run(listTool, { repoDir, after: 'zy', limit: 100 })).identities).toEqual([]);
  });

  it('preserves installed attestation checks with a configured blueprint root', async () => {
    await write(source.id, source, 'installed');
    const result = await run(getTool, { id: source.id });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('attestation-missing');
  });

  it('rejects forbidden slot authority and invalid cardinality on abstract modules', async () => {
    for (const [extra, code] of [
      [{ slots: [{ slot: 'domain', cardinality: 'additive' }] }, 'slot-cardinality-mismatch'],
      [{ slots: [{ slot: 'autonomy' }], knobs: { maxCostUsd: 25 } }, 'authority-on-mode-axis'],
    ] as const) {
      const result = await run(createTool, { identity: { ...source, ...extra }, repoDir });
      expect(result.ok).toBe(false);
      expect(result.errors.map((error: { code: string }) => error.code)).toContain(code);
      expect(result).not.toHaveProperty('yaml');
    }
  });

  it('validates runnable identities through the normal blueprint semantics', async () => {
    const runnable = { ...source, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } };
    expect(await run(createTool, { identity: runnable })).toMatchObject({ ok: true, runnable: true });
    const retry = { to: 'role', role: 'worker' };
    const broken = { ...runnable, spine: { edges: { RETRY: retry }, default: retry } };
    const result = await run(createTool, { identity: broken });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain('no-terminal');
  });

  it('pages by source candidates and exposes unreadable shadowed documents', async () => {
    await write('zz-a', { id: 'zz-a' });
    await write('zz-b', { ...source, id: 'zz-b' });
    await write('zz-c', { ...source, id: 'zz-c' });
    await fs.writeFile(join(repoDir, '.papercusp', 'blueprints', 'zz-c', 'blueprint.yaml'), 'slots: [');
    const first = await run(listTool, { repoDir, after: 'zy', limit: 1 });
    expect(first).toMatchObject({ count: 0, scanned: 1, nextAfter: 'zz-a' });
    const second = await run(listTool, { repoDir, after: first.nextAfter, limit: 10 });
    expect(second.identities.map((entry: { id: string }) => entry.id)).toEqual(['zz-b']);
    expect(second.unreadable.map((entry: { id: string }) => entry.id)).toEqual(['zz-c']);
    expect(second.nextAfter).toBeNull();
  });

  it('reports absent and malformed sources and requires exactly one validation selector', async () => {
    expect((await run(getTool, { id: 'zz-no-such-identity', repoDir })).error).toBe('identity-not-found');
    expect((await run(validateTool, { source: '- not a mapping', repoDir })).ok).toBe(false);
    expect(validateTool.args.safeParse({ id: 'one', source: '{}' }).success).toBe(false);
    expect(validateTool.args.safeParse({}).success).toBe(false);
    expect(getTool.args.safeParse({ id: '../../elsewhere' }).success).toBe(false);
  });
});
