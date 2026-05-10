import { describe, it, expect } from 'vitest';
import { resolveDesignSpec, renderResolvedSpec } from './resolver';

const HARNESS = '/h';
const WORKSPACE = '/w';
const APP_DEFAULT = '/app/default.md';

function fakeReader(files: Record<string, string>) {
  return async (p: string) => {
    if (p in files) return files[p];
    const err = new Error(`ENOENT ${p}`) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  };
}

describe('resolveDesignSpec', () => {
  it('resolves harness when it exists', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nmodels:\n  designer: opus\n---\n# H rules\nhello',
        '/w/DESIGN_SPEC.md': '# W rules',
        '/app/default.md': '# default',
      }),
    });
    expect(r.layer).toBe('harness');
    expect(r.source).toBe('/h/DESIGN_SPEC.md');
    expect(r.body.startsWith('# H rules')).toBe(true);
    expect(r.frontmatter.models?.designer).toBe('opus');
  });

  it('falls back to workspace when harness is missing', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/w/DESIGN_SPEC.md': '# W rules',
        '/app/default.md': '# default',
      }),
    });
    expect(r.layer).toBe('workspace');
    expect(r.body.startsWith('# W rules')).toBe(true);
  });

  it('falls back to app-default when harness + workspace missing', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({ '/app/default.md': '# default' }),
    });
    expect(r.layer).toBe('app-default');
  });

  it('returns empty + warning when nothing exists', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({}),
    });
    expect(r.layer).toBe('empty');
    expect(r.warning).toBeDefined();
    expect(r.body).toBe('');
  });

  it('handles null harnessRoot (workspace-only mode)', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: null,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/w/DESIGN_SPEC.md': '# only workspace',
      }),
    });
    expect(r.layer).toBe('workspace');
  });

  it('parses scalar frontmatter values', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nname: "operator"\nversion: 0.1\n---\nbody',
      }),
    });
    expect(r.frontmatter['name']).toBe('operator');
    expect(r.frontmatter['version']).toBe('0.1');
  });

  it('handles file with no frontmatter', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({ '/h/DESIGN_SPEC.md': 'just markdown body\nno frontmatter' }),
    });
    expect(r.frontmatter).toEqual({});
    expect(r.body.startsWith('just markdown body')).toBe(true);
  });

  it('strips frontmatter cleanly from body', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nkey: value\n---\n# Real header',
      }),
    });
    expect(r.body.includes('---')).toBe(false);
    expect(r.body.startsWith('# Real header')).toBe(true);
  });
});

describe('renderResolvedSpec', () => {
  it('prepends a layer comment header', () => {
    const out = renderResolvedSpec({
      layer: 'harness',
      source: '/h/DESIGN_SPEC.md',
      body: '# H rules',
      frontmatter: {},
    });
    expect(out).toContain('layer=harness');
    expect(out).toContain('# H rules');
  });

  it('emits a warning when empty', () => {
    const out = renderResolvedSpec({
      layer: 'empty',
      source: null,
      body: '',
      frontmatter: {},
      warning: 'whoops',
    });
    expect(out).toContain('empty');
    expect(out).toContain('whoops');
  });
});
