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
