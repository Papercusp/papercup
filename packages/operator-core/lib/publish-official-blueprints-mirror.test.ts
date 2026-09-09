import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import { projectOperatorPromptsIntoBase } from '../../../scripts/publish-official-blueprints.mts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OPERATOR_PROMPTS = join(REPO_ROOT, 'apps/operator/prompts');
const BASE_BLUEPRINT = join(REPO_ROOT, 'libs/papercusp/packages/harness/blueprints/base');

const scratch: string[] = [];

async function makeScratch(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'official-blueprints-mirror-'));
  scratch.push(root);
  return root;
}

async function regularFiles(root: string, relativeDir = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(join(root, relativeDir), { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('official blueprint prompt projection', () => {
  it('projects every operator prompt byte-for-byte into base/prompts, including nested content', async () => {
    const mirror = await makeScratch();
    await fs.cp(BASE_BLUEPRINT, join(mirror, 'base'), { recursive: true });

    const projected = projectOperatorPromptsIntoBase(mirror, OPERATOR_PROMPTS);
    const canonical = await regularFiles(OPERATOR_PROMPTS);

    expect(projected).toEqual(canonical);
    expect(projected).toContain(join('tutorial', 'ch6', '05-p2p-git.md'));
    for (const relativePath of canonical) {
      expect(await fs.readFile(join(mirror, 'base', 'prompts', relativePath))).toEqual(
        await fs.readFile(join(OPERATOR_PROMPTS, relativePath)),
      );
    }
  });

  it('preflights all collisions and leaves the mirror untouched when one destination exists', async () => {
    const root = await makeScratch();
    const source = join(root, 'operator-prompts');
    const mirror = join(root, 'mirror');
    await fs.mkdir(join(source, 'nested'), { recursive: true });
    await fs.mkdir(join(mirror, 'base', 'prompts'), { recursive: true });
    await fs.writeFile(join(source, 'a-safe.md'), 'safe source\n');
    await fs.writeFile(join(source, 'nested', 'collision.md'), 'new bytes\n');
    await fs.mkdir(join(mirror, 'base', 'prompts', 'nested'), { recursive: true });
    const collision = join(mirror, 'base', 'prompts', 'nested', 'collision.md');
    await fs.writeFile(collision, 'preserve these bytes\n');

    expect(() => projectOperatorPromptsIntoBase(mirror, source)).toThrow(
      /operator prompt mirror collision under base\/prompts: nested\/collision\.md/u,
    );
    expect(await fs.readFile(collision, 'utf8')).toBe('preserve these bytes\n');
    await expect(fs.stat(join(mirror, 'base', 'prompts', 'a-safe.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
