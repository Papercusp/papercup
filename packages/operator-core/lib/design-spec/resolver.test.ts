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

  // --- G12: a `#` inside a quoted value must NOT be stripped as a comment.
  //     Pre-fix this truncated `"#ff0066"` → `""` (silent data loss). ------------
  it('keeps a `#` inside a double-quoted value (hex color) — no comment-strip', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({ '/h/DESIGN_SPEC.md': '---\nbrand: "#ff0066"\n---\nbody' }),
    });
    expect(r.frontmatter['brand']).toBe('#ff0066');
  });

  it('keeps a `#` inside a single-quoted value', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({ '/h/DESIGN_SPEC.md': "---\naccent: '#00ddff'\n---\nbody" }),
    });
    expect(r.frontmatter['accent']).toBe('#00ddff');
  });

  it('keeps a URL fragment `#frag` inside a quoted value', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\ndocs: "https://x.example/p#section-2"\n---\nbody',
      }),
    });
    expect(r.frontmatter['docs']).toBe('https://x.example/p#section-2');
  });

  it('still strips a genuine trailing `# comment` after a value', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nname: operator # the trailing comment\n---\nbody',
      }),
    });
    expect(r.frontmatter['name']).toBe('operator');
  });

  it('still strips a trailing comment AFTER a quoted value (closing quote, then #)', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nbrand: "#ff0066" # primary brand\n---\nbody',
      }),
    });
    expect(r.frontmatter['brand']).toBe('#ff0066');
  });

  it('drops a whole-line comment in frontmatter', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\n# a leading note\nname: operator\n---\nbody',
      }),
    });
    expect(r.frontmatter['name']).toBe('operator');
    // The comment-only line produced no key.
    expect(Object.keys(r.frontmatter)).toEqual(['name']);
  });

  // --- G13: nesting / state-reset across the frontmatter line walk. -------------
  it('resets nested-object state when a scalar key follows a nested block', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nmodels:\n  designer: opus\nname: top\nother:\n  k: v\n---\nb',
      }),
    });
    // nested block parsed
    expect(r.frontmatter.models?.designer).toBe('opus');
    // scalar after a nested block resets state → lands at top level, not under models
    expect(r.frontmatter['name']).toBe('top');
    expect((r.frontmatter.models as Record<string, unknown>)['name']).toBeUndefined();
    // a second nested block after a scalar reopens cleanly
    expect((r.frontmatter['other'] as Record<string, unknown>)?.['k']).toBe('v');
  });

  it('documents 2-deep nesting behavior: only the first level is captured (deeper indent ignored)', async () => {
    const r = await resolveDesignSpec({
      harnessRoot: HARNESS,
      workspaceRoot: WORKSPACE,
      appDefaultPath: APP_DEFAULT,
      readFile: fakeReader({
        '/h/DESIGN_SPEC.md': '---\nmodels:\n  designer: opus\n    nested: deep\nname: top\n---\nb',
      }),
    });
    // The parser is single-level by design (doc comment): the 2-deep line is read as
    // another key under `models` (the regex tolerates leading whitespace), NOT a true
    // tree. Pin the documented graceful behavior — it does not throw or corrupt siblings.
    expect(r.frontmatter.models?.designer).toBe('opus');
    expect((r.frontmatter.models as Record<string, unknown>)['nested']).toBe('deep');
    expect(r.frontmatter['name']).toBe('top');
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
