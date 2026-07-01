/**
 * Tests for the MDX→markdown render pipeline (render-mdx.ts) which drives the
 * JSX-conversion plugin (remark-mdx-to-markdown.ts): Callout→blockquote,
 * Tabs/Steps/Card unwrap, unknown-JSX unwrap, self-closing drop, + the preamble.
 * Run with: npx vitest run packages/docs-engine/src/render-mdx.test.ts
 */
import { describe, expect, it } from 'vitest';
import { renderMdxToMarkdown, withPreamble } from './render-mdx';

const render = (mdx: string) => renderMdxToMarkdown(mdx, '/docs/test.mdx');

describe('renderMdxToMarkdown — Callout → blockquote', () => {
  it('maps a typed Callout to a titled blockquote', async () => {
    const out = await render('<Callout type="warning">\nBe careful here.\n</Callout>\n');
    expect(out).toContain('**Warning:');
    expect(out).toContain('Be careful here.');
    expect(out).toMatch(/^>/m); // blockquote marker
    expect(out).not.toContain('<Callout');
  });

  it('maps each known type to its title word', async () => {
    expect(await render('<Callout type="error">x</Callout>\n')).toContain('**Error:');
    expect(await render('<Callout type="danger">x</Callout>\n')).toContain('**Error:');
    expect(await render('<Callout type="info">x</Callout>\n')).toContain('**Note:');
    expect(await render('<Callout type="success">x</Callout>\n')).toContain('**Tip:');
  });

  it('prefers an explicit title attribute', async () => {
    expect(await render('<Callout title="Heads up">x</Callout>\n')).toContain('**Heads up:');
  });

  it('defaults to Note when no type/title is given', async () => {
    expect(await render('<Callout>x</Callout>\n')).toContain('**Note:');
  });

  it('reads a JSX-expression attribute value (strips quotes)', async () => {
    // type={"warning"} → mdxJsxAttributeValueExpression → getAttr strips the quotes.
    expect(await render('<Callout type={"warning"}>x</Callout>\n')).toContain('**Warning:');
  });
});

describe('renderMdxToMarkdown — unwrapping', () => {
  it('unwraps layout components (Tabs/Steps/Card), keeping their children', async () => {
    const out = await render('<Tabs>\n\nInner tab content.\n\n</Tabs>\n');
    expect(out).toContain('Inner tab content.');
    expect(out).not.toContain('<Tabs');
    expect(out).not.toContain('Tabs>');
  });

  it('unwraps an unknown JSX element rather than emitting a literal tag', async () => {
    const out = await render('<Mystery>\n\nkept body\n\n</Mystery>\n');
    expect(out).toContain('kept body');
    expect(out).not.toContain('<Mystery');
  });

  it('drops a self-closing unknown JSX element entirely', async () => {
    const out = await render('Before.\n\n<Widget />\n\nAfter.\n');
    expect(out).toContain('Before.');
    expect(out).toContain('After.');
    expect(out).not.toContain('Widget');
  });

  it('leaves ordinary markdown + GFM untouched', async () => {
    const out = await render('# Heading\n\n- a\n- b\n');
    expect(out).toContain('# Heading');
    expect(out).toContain('* a'); // remark-stringify normalizes list bullets
  });
});

describe('renderMdxToMarkdown — EI-5860 resilience (a malformed doc must not throw / blind the corpus)', () => {
  it('does not throw on a raw <lowercase> placeholder (unclosed JSX tag); keeps prose searchable', async () => {
    // The real EI-5860 repro: a `<owner>` placeholder in prose parses as an
    // unclosed JSX tag → "Expected a closing tag for `<owner>`". Must degrade, not throw.
    const mdx = 'Resume via ~/.papercusp/session-claude/<owner>/projects keyed by the owner id.\n';
    const out = await render(mdx);
    expect(out).toContain('session-claude');
    expect(out).toContain('projects');
  });

  it('does not throw on an unparseable {expression} (acorn); keeps prose searchable', async () => {
    // `{not valid js}` → "Could not parse expression with acorn". Must degrade, not throw.
    const out = await render('Set the value {not valid js here} and continue inline.\n');
    expect(out).toContain('continue inline');
  });

  it('fallback strips a leading frontmatter block + ESM import/export lines, keeping prose', async () => {
    const mdx =
      ['---', 'title: Broken doc', '---', "import Foo from './foo';", '', 'The <owner> placeholder fails to parse but the prose survives.'].join(
        '\n',
      ) + '\n';
    const out = await render(mdx);
    expect(out).not.toContain('title: Broken doc'); // frontmatter stripped
    expect(out).not.toMatch(/^import /m); // import wiring stripped
    expect(out).toContain('prose survives'); // prose kept → keyword-searchable
  });
});

describe('withPreamble', () => {
  it('prepends the title / URL / description block', () => {
    expect(withPreamble('BODY', { title: 'T', url: 'https://x/y', description: 'D' })).toBe(
      '# T\nURL: https://x/y\n\nD\n\nBODY',
    );
  });

  it('renders an empty description line when none is supplied', () => {
    expect(withPreamble('BODY', { title: 'T', url: 'U' })).toBe('# T\nURL: U\n\n\n\nBODY');
  });
});
