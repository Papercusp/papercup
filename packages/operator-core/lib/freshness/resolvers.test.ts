import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  loadHarnessRegistry: vi.fn(),
}));

vi.mock('../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-registry')>();
  return { ...actual, loadHarnessRegistry: h.loadHarnessRegistry };
});

const { resolveCurrentTokens } = await import('./resolvers');

let tempRoot: string | undefined;

afterEach(async () => {
  h.loadHarnessRegistry.mockReset();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('file dependency resolution', () => {
  it('resolves repo-relative refs against the declaring harness registry path', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-harness-root-'));
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await writeFile(join(tempRoot, 'src', 'owner.ts'), 'export const owner = true;');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const tokens = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(tokens.get(dep)).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(h.loadHarnessRegistry).toHaveBeenCalledWith('papercusp-workspace');
  });
});
