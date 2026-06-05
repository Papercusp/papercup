import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { harnessFsAdapter } from '../src/adapters/harness-fs';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-fs-test-'));
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'docs', 'features'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '.papercusp'), { recursive: true });

  await fs.writeFile(
    path.join(tmpDir, 'SPEC.md'),
    '# Spec\n\nThe spec for this harness.\n\n## Goal\n\nProject goal.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'AGENTS.md'),
    '# Agents\n\nAgent conventions.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, '.papercusp', 'knowledge.md'),
    '# Knowledge\n\nCurated notes.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'architecture.md'),
    '# Architecture\n\nThe system layout.\n\n## Components\n\nList of components.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'features', 'auth.md'),
    '# Auth\n\nAuthentication feature.\n',
    'utf-8',
  );
  // Should be ignored — dotfile dir
  await fs.mkdir(path.join(tmpDir, 'docs', '.hidden'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'docs', '.hidden', 'secret.md'), '# Secret\n', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('harnessFsAdapter', () => {
  it('lists docs/ pages + state files', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toContain('harness-state/SPEC');
    expect(slugs).toContain('harness-state/AGENTS');
    expect(slugs).toContain('harness-state/knowledge');
    expect(slugs).toContain('docs/architecture');
    expect(slugs).toContain('docs/features/auth');
  });

  it('ignores dotfile directories under docs/', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const pages = await adapter.listPages();
    expect(pages.find((p) => p.slug.includes('hidden'))).toBeUndefined();
  });

  it('extracts h1 title and toc', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const page = await adapter.getPage('docs/architecture');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Architecture');
    expect(page!.toc.map((h) => h.text)).toEqual(['Architecture', 'Components']);
  });

  it('getContent returns file body', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    const page = await adapter.getPage('harness-state/SPEC');
    expect(page).not.toBeNull();
    const content = await adapter.getContent(page!);
    expect(content).toContain('The spec for this harness.');
  });

  it('returns null for missing slug', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    expect(await adapter.getPage('nope/missing')).toBeNull();
  });

  it('section meta provides labels for synthetic sections', async () => {
    const adapter = harnessFsAdapter(tmpDir);
    expect(await adapter.getSectionMeta!('harness-state')).toMatchObject({ title: 'Harness state' });
    expect(await adapter.getSectionMeta!('docs')).toMatchObject({ title: 'Project docs' });
  });

  it('integrates with buildOutline', async () => {
    const { buildOutline } = await import('../src/outline');
    const adapter = harnessFsAdapter(tmpDir);
    const out = await buildOutline(adapter);
    expect(out.sectionCount).toBeGreaterThanOrEqual(2);
    const sec = out.sections.find((s) => s.slug === 'harness-state');
    expect(sec?.title).toBe('Harness state');
  });
});
