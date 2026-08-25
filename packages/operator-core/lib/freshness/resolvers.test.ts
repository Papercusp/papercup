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
let canonicalRoot: string | undefined;
const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;

afterEach(async () => {
  h.loadHarnessRegistry.mockReset();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  if (canonicalRoot) await rm(canonicalRoot, { recursive: true, force: true });
  tempRoot = undefined;
  canonicalRoot = undefined;
  if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
});

async function makeCanonicalRoot(): Promise<string> {
  canonicalRoot = await mkdtemp(join(tmpdir(), 'freshness-canonical-root-'));
  await mkdir(join(canonicalRoot, 'apps', 'operator'), { recursive: true });
  await mkdir(join(canonicalRoot, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(canonicalRoot, 'apps', 'operator', 'package.json'), '{}');
  await writeFile(join(canonicalRoot, 'libs', 'papercusp', 'package.json'), '{}');
  process.env.PAPERCUSP_INTEGRATION_ROOT = canonicalRoot;
  return canonicalRoot;
}

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

  it('falls back to the canonical repo when the registry root is phantom and the canonical repo resolves every ref', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-phantom-root-'));
    const canonical = await makeCanonicalRoot();
    await mkdir(join(canonical, 'src'), { recursive: true });
    await writeFile(join(canonical, 'src', 'owner.ts'), 'export const owner = true;');
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const expected = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
      repoRoot: canonical,
    });
    const actual = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(actual.get(dep)).toBe(expected.get(dep));
    expect(actual.get(dep)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('keeps a resolving registry root authoritative when the canonical repo also contains the ref', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'freshness-preferred-root-'));
    const canonical = await makeCanonicalRoot();
    for (const [root, body] of [[tempRoot, 'preferred'], [canonical, 'canonical']] as const) {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'owner.ts'), body);
    }
    h.loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'sidestage', path: tempRoot, harness_kind: 'coding' }],
    });

    const dep = 'file:src/owner.ts';
    const expected = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
      repoRoot: tempRoot,
    });
    const actual = await resolveCurrentTokens([dep], {
      workspaceId: 'papercusp-workspace',
      harness: 'sidestage',
    });

    expect(actual.get(dep)).toBe(expected.get(dep));
  });
});
