/**
 * generate-blueprint-for-clone.test.ts — the standalone-from-URL blueprint step
 * (P-010). Real detection over a temp fixture repo — no network, no PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { generateBlueprintForClone } from './generate-blueprint-for-clone';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gen-bp-clone-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('generateBlueprintForClone (P-010)', () => {
  it('detects a node repo and writes .papercusp/blueprint.yaml (no test-verify by default)', async () => {
    const repo = join(workDir, 'node-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
    );
    const res = await generateBlueprintForClone('node-repo', repo);
    expect(res).toMatchObject({ generated: true });
    if (!('blueprintFile' in res)) throw new Error('expected blueprintFile');
    expect(existsSync(res.blueprintFile)).toBe(true);
    const bp = parseYaml(readFileSync(res.blueprintFile, 'utf8')) as Record<string, unknown>;
    expect(bp.id).toBe('node-repo');
    expect(bp.extends).toBe('coding-factory');
  });

  it('skips a repo that already carries a blueprint', async () => {
    const repo = join(workDir, 'has-bp');
    await mkdir(join(repo, '.papercusp'), { recursive: true });
    await writeFile(join(repo, '.papercusp', 'blueprint.yaml'), 'id: has-bp\nextends: coding-factory\n');
    const res = await generateBlueprintForClone('has-bp', repo);
    expect(res).toEqual({ generated: false, reason: 'already_has_blueprint' });
  });

  it('reports (never throws) on an unusable path', async () => {
    const res = await generateBlueprintForClone('nope', join(workDir, 'does-not-exist'));
    // detection over a missing dir either degrades to a bare blueprint or errors —
    // both are acceptable; the contract is no-throw + a structured result.
    expect(typeof res.generated).toBe('boolean');
  });
});
