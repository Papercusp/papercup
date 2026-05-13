import { describe, it, expect } from 'vitest';
import { remark } from 'remark';
import remarkMdx from 'remark-mdx';
import remarkMdxToMarkdown from './remark-mdx-to-markdown';

const processor = remark().use(remarkMdx).use(remarkMdxToMarkdown);

async function transform(mdx: string): Promise<string> {
  const out = await processor.process(mdx);
  return String(out);
}

describe('remark-mdx-to-markdown', () => {
  it('converts Callout with type to a blockquote with bold title prefix', async () => {
    const out = await transform('<Callout type="warning">Be careful.</Callout>\n');
    expect(out).toContain('> ');
    expect(out).toContain('**Warning:');
    expect(out).toContain('Be careful');
  });

  it('uses explicit title attribute when present', async () => {
    const out = await transform('<Callout type="info" title="Heads up">Body text.</Callout>\n');
    expect(out).toContain('**Heads up:');
    expect(out).toContain('Body text');
  });

  it('maps unknown callout type to Note', async () => {
    const out = await transform('<Callout type="something-else">Body.</Callout>\n');
    expect(out).toContain('**Note:');
  });

  it('unwraps Tabs/TabsContent — keeps children visible', async () => {
    const out = await transform(
      '<Tabs>\n<TabsContent value="a">\n\nFirst panel.\n\n</TabsContent>\n<TabsContent value="b">\n\nSecond panel.\n\n</TabsContent>\n</Tabs>\n',
    );
    expect(out).toContain('First panel');
    expect(out).toContain('Second panel');
    expect(out).not.toMatch(/<Tabs|<TabsContent/);
  });

  it('unwraps Steps/Step', async () => {
    const out = await transform(
      '<Steps>\n<Step>\n\nFirst step.\n\n</Step>\n<Step>\n\nSecond step.\n\n</Step>\n</Steps>\n',
    );
    expect(out).toContain('First step');
    expect(out).toContain('Second step');
    expect(out).not.toMatch(/<Steps|<Step\b/);
  });

  it('unwraps Card/Cards', async () => {
    const out = await transform(
      '<Cards>\n<Card>Inner.</Card>\n</Cards>\n',
    );
    expect(out).toContain('Inner');
    expect(out).not.toMatch(/<Cards|<Card/);
  });

  it('unwraps unknown JSX components rather than emitting literal tags', async () => {
    const out = await transform('<SomeRandomComponent>Body content.</SomeRandomComponent>\n');
    expect(out).toContain('Body content');
    expect(out).not.toContain('<SomeRandomComponent');
  });

  it('preserves code-fenced JSX unchanged', async () => {
    const out = await transform(
      'Before.\n\n```tsx\n<Callout type="warning">in code</Callout>\n```\n\nAfter.\n',
    );
    // Inside the code fence the literal text is preserved.
    expect(out).toContain('<Callout type="warning">in code</Callout>');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('drops self-closing unknown JSX', async () => {
    const out = await transform('Before.\n\n<MystComponent />\n\nAfter.\n');
    expect(out).not.toContain('<MystComponent');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('handles nested JSX (Callout inside Tabs)', async () => {
    const out = await transform(
      '<Tabs>\n<TabsContent value="a">\n\n<Callout type="info">Nested note.</Callout>\n\n</TabsContent>\n</Tabs>\n',
    );
    expect(out).toContain('Nested note');
    expect(out).toContain('**Note:');
    expect(out).not.toMatch(/<Tabs|<TabsContent|<Callout/);
  });
});
